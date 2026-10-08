import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze, writeContracts } from '@flowpact/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

interface Annotation {
  level: 'error' | 'warning' | 'notice';
  message: string;
  props?: Record<string, unknown>;
}

const state = vi.hoisted(() => ({
  inputs: {} as Record<string, string>,
  outputs: {} as Record<string, string>,
  annotations: [] as Annotation[],
  infos: [] as string[],
  debugs: [] as string[],
  groups: [] as string[],
  summary: '',
  summaryWrites: 0,
  failed: [] as string[],
  isDebug: false,
  uploads: [] as { name: string; files: string[]; root: string; options: unknown; patch: string }[],
  uploadError: undefined as Error | undefined,
}));

vi.mock('@actions/core', () => {
  const annotation =
    (level: Annotation['level']) => (message: string | Error, props?: Record<string, unknown>) =>
      void state.annotations.push({ level, message: String(message), ...(props ? { props } : {}) });
  const summary = {
    addRaw(text: string) {
      state.summary += text;
      return summary;
    },
    async write() {
      state.summaryWrites++;
      return summary;
    },
  };
  return {
    getInput: (name: string) => state.inputs[name] ?? '',
    setOutput: (name: string, value: unknown) => {
      state.outputs[name] = String(value);
    },
    setFailed: (message: string | Error) => void state.failed.push(String(message)),
    isDebug: () => state.isDebug,
    debug: (m: string) => void state.debugs.push(m),
    info: (m: string) => void state.infos.push(m),
    error: annotation('error'),
    warning: annotation('warning'),
    notice: annotation('notice'),
    startGroup: (name: string) => void state.groups.push(name),
    endGroup: () => {},
    group: async <T>(name: string, fn: () => Promise<T>) => {
      state.groups.push(name);
      return fn();
    },
    summary,
  };
});

vi.mock('@actions/artifact', () => ({
  DefaultArtifactClient: class {
    async uploadArtifact(name: string, files: string[], root: string, options: unknown) {
      if (state.uploadError) throw state.uploadError;
      const patch = files.find((f) => f.endsWith('.patch'));
      state.uploads.push({ name, files, root, options, patch: patch ? readFileSync(patch, 'utf8') : '' });
      return { id: 42, size: 1234 };
    }
  },
}));

const { DEFAULTS, run, summaryWithinLimit, SUMMARY_LIMIT } = await import('../src/main');

const REPO = fileURLToPath(new URL('../../../', import.meta.url));
const FIXTURES = join(REPO, 'fixtures');
const ENV_KEYS = [
  'GITHUB_WORKSPACE',
  'GITHUB_EVENT_NAME',
  'GITHUB_ACTION',
  'GITHUB_SERVER_URL',
  'GITHUB_REPOSITORY',
  'GITHUB_SHA',
  'GITHUB_RUN_ID',
  'GITHUB_ACTIONS',
  'RUNNER_TEMP',
  'RUNNER_DEBUG',
  'ACTIONS_STEP_DEBUG',
  'FLOWPACT_DEBUG',
];

let saved: Record<string, string | undefined>;
let temp: string;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  temp = mkdtempSync(join(tmpdir(), 'flowpact-action-'));
  process.env.RUNNER_TEMP = join(temp, 'runner-temp');
  Object.assign(state, {
    inputs: {},
    outputs: {},
    annotations: [],
    infos: [],
    debugs: [],
    groups: [],
    summary: '',
    summaryWrites: 0,
    failed: [],
    isDebug: false,
    uploads: [],
    uploadError: undefined,
  });
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(temp, { recursive: true, force: true });
});

async function action(workspace: string, inputs: Record<string, string> = {}) {
  process.env.GITHUB_WORKSPACE = workspace;
  state.inputs = inputs;
  await run();
  return state;
}

/** A copy of a fixture in a fresh git repository (optionally under a subdirectory). */
function repoFrom(fixture: string, sub = ''): { workspace: string; root: string } {
  const workspace = join(temp, 'repo');
  const root = join(workspace, sub);
  cpSync(join(FIXTURES, fixture), root, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: workspace });
  return { workspace, root };
}

/** Writes the current contracts (what `flowpact generate` does) so later edits show up as drift. */
function lockContracts(root: string): void {
  const result = analyze({ root, checkContracts: true });
  writeContracts(root, result.contracts!);
}

function addRequiredInput(root: string): void {
  const file = join(root, '.github/workflows/build.yml');
  const text = readFileSync(file, 'utf8');
  writeFileSync(
    file,
    text.replace(
      '      verbose:\n',
      '      region:\n        type: string\n        required: true\n      verbose:\n',
    ),
  );
}

describe('lint mode', () => {
  it('fails on errors and annotates them where they are', async () => {
    const s = await action(join(FIXTURES, 'incident-matrix'));
    expect(s.infos[0]).toContain('config schema v1');
    expect(s.infos[0]).toMatch(/^flowpact v\d+\.\d+\.\d+/);
    expect(s.failed).toEqual(['flowpact found 1 error.']);
    const errors = s.annotations.filter((a) => a.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.props).toEqual({
      title: 'FP401 empty-binding-for-matrix-combo',
      file: '.github/workflows/tests.yml',
      startLine: 23,
      endLine: 23,
      startColumn: 19,
      endColumn: 32,
    });
    expect(errors[0]!.message).toContain('https://rumankazi.github.io/flowpact/docs/rules/fp401');
    expect(s.outputs).toMatchObject({
      errors: '1',
      warnings: '0',
      findings: '1',
      'exit-code': '1',
      drift: 'false',
      breaking: '0',
      patch: '',
      'artifact-id': '',
    });
    expect(s.groups).toContain('flowpact lint: analyze');
    // Progress lines go to the log, not to annotations.
    expect(s.infos.some((l) => l.startsWith('discovered 3 workflow(s)'))).toBe(true);
    expect(s.debugs).toEqual([]);
  });

  it('passes on a clean repository with zero outputs', async () => {
    const s = await action(join(FIXTURES, 'clean'));
    expect(s.failed).toEqual([]);
    expect(s.annotations).toEqual([]);
    expect(s.outputs).toMatchObject({
      errors: '0',
      warnings: '0',
      infos: '0',
      findings: '0',
      'exit-code': '0',
    });
    expect(s.summary).toContain('No problems found');
  });

  it('resolves working-directory and prefixes annotation paths and links with it', async () => {
    process.env.GITHUB_SERVER_URL = 'https://github.com';
    process.env.GITHUB_REPOSITORY = 'acme/repo';
    process.env.GITHUB_SHA = 'abc123';
    const s = await action(FIXTURES, { 'working-directory': 'incident-matrix' });
    expect(s.annotations.map((a) => a.props?.file)).toEqual(['incident-matrix/.github/workflows/tests.yml']);
    expect(s.summary).toContain(
      'https://github.com/acme/repo/blob/abc123/incident-matrix/.github/workflows/tests.yml#L23',
    );
  });

  it('does not fail with fail-on: never, but still annotates', async () => {
    const s = await action(join(FIXTURES, 'incident-matrix'), { 'fail-on': 'never' });
    expect(s.failed).toEqual([]);
    expect(s.outputs['exit-code']).toBe('0');
    expect(s.annotations).toHaveLength(1);
  });

  it('counts warnings with fail-on: warning', async () => {
    const s = await action(join(FIXTURES, 'deep-nesting'), { 'fail-on': 'warning' });
    expect(s.failed).toEqual(['flowpact found 4 errors and 7 warnings.']);
  });

  it('skips annotations and the summary when disabled', async () => {
    const s = await action(join(FIXTURES, 'incident-matrix'), { annotations: 'false', summary: 'false' });
    expect(s.annotations).toEqual([]);
    expect(s.summary).toBe('');
    expect(s.summaryWrites).toBe(0);
  });

  it('writes the job summary with docs links and an optional call graph', async () => {
    const s = await action(join(FIXTURES, 'incident-matrix'), { 'summary-graph': 'true' });
    expect(s.summaryWrites).toBe(1);
    expect(s.summary).toMatch(/^## flowpact lint\n/);
    expect(s.summary).toContain('[`FP401`](https://rumankazi.github.io/flowpact/docs/rules/fp401)');
    expect(s.summary).toContain('```mermaid');
  });

  it('writes report files relative to the workspace', async () => {
    const { workspace } = repoFrom('incident-matrix');
    const s = await action(workspace, {
      'report-json': 'reports/flowpact.json',
      'report-sarif': 'reports/flowpact.sarif',
      'report-markdown': join(temp, 'abs', 'flowpact.md'),
    });
    const json = JSON.parse(readFileSync(join(workspace, 'reports/flowpact.json'), 'utf8'));
    expect(json.summary.errors).toBe(1);
    const sarif = JSON.parse(readFileSync(join(workspace, 'reports/flowpact.sarif'), 'utf8'));
    expect(sarif.version).toBe('2.1.0');
    expect(readFileSync(join(temp, 'abs', 'flowpact.md'), 'utf8')).toContain('## flowpact lint');
    expect(s.outputs['report-json']).toBe(join(workspace, 'reports/flowpact.json'));
    expect(s.outputs['report-sarif']).toBe(join(workspace, 'reports/flowpact.sarif'));
  });

  it('makes SARIF locations relative to the workspace when working-directory is set', async () => {
    const { workspace } = repoFrom('incident-matrix', 'sub');
    await action(workspace, { 'working-directory': 'sub', 'report-sarif': 'flowpact.sarif' });
    const sarif = JSON.parse(readFileSync(join(workspace, 'flowpact.sarif'), 'utf8'));
    const uris = sarif.runs[0].results.flatMap(
      (r: { locations: { physicalLocation: { artifactLocation: { uri: string } } }[] }) =>
        r.locations.map((l) => l.physicalLocation.artifactLocation.uri),
    );
    expect(uris).toEqual(['sub/.github/workflows/tests.yml']);
  });
});

describe('check mode', () => {
  it('reports drift, uploads the regenerated contracts and a patch that applies with git', async () => {
    const { workspace, root } = repoFrom('deep-nesting');
    lockContracts(root);
    addRequiredInput(root);
    process.env.GITHUB_RUN_ID = '987';

    const s = await action(workspace, { mode: 'check' });
    expect(s.outputs.drift).toBe('true');
    expect(Number(s.outputs.breaking)).toBeGreaterThan(0);
    expect(s.outputs['artifact-id']).toBe('42');
    expect(s.failed).toHaveLength(1);
    expect(s.failed[0]).toContain('contracts drifted');
    expect(s.failed[0]).toContain('flowpact-contracts.patch');

    expect(s.uploads).toHaveLength(1);
    const upload = s.uploads[0]!;
    expect(upload.name).toBe('flowpact-contracts');
    expect(upload.options).toEqual({ retentionDays: 7 });
    const inArtifact = upload.files.map((f) => f.slice(upload.root.length + 1)).sort();
    expect(inArtifact).toContain('flowpact-contracts.patch');
    expect(inArtifact).toContain('flowpact-contracts/README.md');
    expect(inArtifact).toContain(
      'flowpact-contracts/.github/flowpact/contracts/workflows/build.contract.yml',
    );
    for (const f of upload.files) expect(existsSync(f)).toBe(true);
    expect(s.outputs.patch).toBe(join(upload.root, 'flowpact-contracts.patch'));

    expect(s.summary).toContain('gh run download 987 -n flowpact-contracts');
    expect(s.summary).toContain('git apply --index flowpact-contracts.patch');
    expect(readFileSync(join(upload.root, 'flowpact-contracts/README.md'), 'utf8')).toContain(
      'git apply --index flowpact-contracts.patch',
    );

    execFileSync('git', ['apply', s.outputs.patch!], { cwd: workspace });
    const again = await action(workspace, { mode: 'check' });
    expect(again.outputs.drift).toBe('false');
    expect(again.uploads).toHaveLength(1);
  });

  it('writes repository-relative paths into the patch when working-directory is set', async () => {
    const { workspace, root } = repoFrom('deep-nesting', 'apps/ci');
    lockContracts(root);
    addRequiredInput(root);
    const s = await action(workspace, { mode: 'check', 'working-directory': 'apps/ci' });
    const patch = s.uploads[0]!.patch;
    expect(patch).toContain('diff --git a/apps/ci/.github/flowpact/contracts/workflows/build.contract.yml');
    execFileSync('git', ['apply', '--check', s.outputs.patch!], { cwd: workspace });
  });

  it('keeps going when the upload fails and points at flowpact generate instead', async () => {
    const { workspace, root } = repoFrom('deep-nesting');
    lockContracts(root);
    addRequiredInput(root);
    state.uploadError = new Error('Unable to get the ACTIONS_RUNTIME_TOKEN env variable');
    const s = await action(workspace, { mode: 'check' });
    expect(
      s.annotations.some((a) => a.level === 'warning' && a.message.includes('ACTIONS_RUNTIME_TOKEN')),
    ).toBe(true);
    expect(s.outputs.drift).toBe('true');
    expect(s.outputs['artifact-id']).toBe('');
    expect(s.outputs.patch).not.toBe('');
    expect(s.summary).not.toContain('gh run download');
    expect(s.failed[0]).toContain('run flowpact generate');
  });

  it('does not upload when upload-contracts is false', async () => {
    const { workspace, root } = repoFrom('deep-nesting');
    lockContracts(root);
    addRequiredInput(root);
    const s = await action(workspace, { mode: 'check', 'upload-contracts': 'false', 'fail-on': 'never' });
    expect(s.uploads).toEqual([]);
    expect(s.outputs.drift).toBe('true');
    expect(s.failed).toEqual([]);
  });
});

describe('logging and errors', () => {
  it('prints debug logs when the debug input is set', async () => {
    const s = await action(join(FIXTURES, 'incident-matrix'), { debug: 'true' });
    expect(s.infos.some((l) => l.startsWith('debug: [flowpact] config resolved'))).toBe(true);
    expect(s.debugs).toEqual([]);
  });

  it('sends debug logs to core.debug when step debug logging is on', async () => {
    state.isDebug = true;
    const s = await action(join(FIXTURES, 'incident-matrix'));
    expect(s.debugs.some((l) => l.startsWith('[flowpact] config resolved'))).toBe(true);
    expect(s.debugs.some((l) => l.startsWith('[flowpact:rules] FP401'))).toBe(true);
  });

  it('fails with the config problem and its issues', async () => {
    const { workspace } = repoFrom('incident-matrix');
    writeFileSync(join(workspace, 'bad.yml'), 'rules:\n  nope: error\n');
    const s = await action(workspace, { config: 'bad.yml' });
    expect(s.failed).toHaveLength(1);
    expect(s.failed[0]).toMatch(/unknown rules/);
    expect(s.failed[0]).toContain('  - rules.nope: unknown rule');
  });

  it('fails when the config file does not exist', async () => {
    const s = await action(join(FIXTURES, 'clean'), { config: 'missing.yml' });
    expect(s.failed[0]).toContain('Config file not found');
  });

  it('rejects invalid inputs', async () => {
    const s = await action(join(FIXTURES, 'clean'), { mode: 'generate' });
    expect(s.failed).toEqual(['Input mode must be one of lint, check (got "generate")']);
  });

  it('fails when there are no workflows', async () => {
    mkdirSync(join(temp, 'empty'));
    const s = await action(join(temp, 'empty'));
    expect(s.failed[0]).toContain('No workflows found');
  });
});

describe('action.yml', () => {
  const meta = parse(readFileSync(join(REPO, 'action.yml'), 'utf8')) as {
    name: string;
    description: string;
    branding: { icon: string; color: string };
    inputs: Record<string, { default: string; description: string }>;
    outputs: Record<string, { description: string }>;
    runs: { using: string; main: string };
  };

  it('declares the defaults the code uses', () => {
    expect(Object.fromEntries(Object.entries(meta.inputs).map(([k, v]) => [k, v.default]))).toEqual(DEFAULTS);
    for (const v of Object.values(meta.inputs)) expect(v.description).toBeTruthy();
  });

  it('declares every output the action sets', async () => {
    const s = await action(join(FIXTURES, 'clean'));
    expect(Object.keys(meta.outputs).sort()).toEqual(Object.keys(s.outputs).sort());
  });

  it('meets the GitHub Marketplace requirements', () => {
    // The Marketplace rejects a description of 125 characters or more and needs branding.
    expect(meta.description.length).toBeLessThan(125);
    expect(meta.name).toBeTruthy();
    expect(meta.branding.icon && meta.branding.color).toBeTruthy();
  });

  it('runs the committed bundle on node24', () => {
    expect(meta.runs).toEqual({ using: 'node24', main: 'packages/action/dist/index.js' });
  });

  it('has the same version as the engine', async () => {
    const { VERSION } = await import('@flowpact/core');
    const pkg = JSON.parse(readFileSync(join(REPO, 'packages/action/package.json'), 'utf8'));
    expect(pkg.version).toBe(VERSION);
  });
});

describe('impact mode', () => {
  /** A git repository whose reusable workflow's job is renamed on a branch. */
  function renamedRepo(): string {
    const workspace = mkdtempSync(join(temp, 'impact-'));
    const wf = join(workspace, '.github/workflows/ci-reusable.yml');
    mkdirSync(join(workspace, '.github/workflows'), { recursive: true });
    const g = (...args: string[]) => execFileSync('git', args, { cwd: workspace, stdio: 'pipe' });
    g('init', '-q', '-b', 'main');
    g('config', 'user.email', 't@example.com');
    g('config', 'user.name', 't');
    g('config', 'commit.gpgsign', 'false');
    const body = (name: string) =>
      `on: workflow_call\njobs:\n  test:\n    name: ${name}\n    runs-on: ubuntu-latest\n    steps: [{ run: 'true' }]\n`;
    writeFileSync(wf, body('Test'));
    g('add', '-A');
    g('commit', '-q', '-m', 'base');
    g('checkout', '-q', '-b', 'change');
    writeFileSync(wf, body('Unit tests'));
    g('commit', '-q', '-am', 'change');
    return workspace;
  }

  it('fails an under-declared change and sets the impact outputs', async () => {
    const s = await action(renamedRepo(), { impact: 'on', 'base-ref': 'main', 'expected-impact': 'patch' });
    expect(s.outputs['required-impact']).toBe('major');
    expect(s.outputs['declared-impact']).toBe('patch');
    expect(s.outputs['impact-ok']).toBe('false');
    expect(s.failed).toHaveLength(1);
    expect(s.annotations.some((a) => String(a.props?.title ?? '').startsWith('FP810'))).toBe(true);
    expect(s.summary).toContain('### Impact');
  });

  it('passes a declared major and stays off by default', async () => {
    const ok = await action(renamedRepo(), { impact: 'on', 'base-ref': 'main', 'expected-impact': 'major' });
    expect(ok.outputs['impact-ok']).toBe('true');
    expect(ok.failed).toEqual([]);
    const off = await action(renamedRepo(), {});
    expect(off.outputs['impact-ok']).toBe('');
  });
});

describe('review fixes', () => {
  it('fails (exit 2) on paths that do not exist, instead of reporting nothing', async () => {
    const s = await action(join(FIXTURES, 'broken'), { paths: '.github/workflow/schema.yml' });
    expect(s.failed[0]).toContain('paths not found');
    expect(s.outputs['exit-code']).toBe('2');
  });

  it('sets every output even when it stops early', async () => {
    const empty = join(temp, 'empty');
    mkdirSync(empty);
    const s = await action(empty);
    expect(s.failed).toHaveLength(1);
    expect(s.outputs).toMatchObject({
      errors: '0',
      breaking: '0',
      drift: 'false',
      'exit-code': '2',
      patch: '',
    });
  });

  it('does not run plugins on untrusted events unless allowed', async () => {
    const { workspace, root } = repoFrom('clean');
    mkdirSync(join(root, '.github/flowpact'), { recursive: true });
    writeFileSync(join(root, '.github/flowpact/flowpact.config.yml'), 'plugins: [./evil.mjs]\n');
    writeFileSync(join(root, 'evil.mjs'), 'globalThis.__wfcPluginRan = true;\nexport default [];\n');
    process.env.GITHUB_EVENT_NAME = 'pull_request_target';
    const s = await action(workspace);
    expect((globalThis as { __wfcPluginRan?: boolean }).__wfcPluginRan).toBeUndefined();
    expect(s.annotations.some((a) => a.level === 'warning' && a.message.includes('plugins'))).toBe(true);
    expect(s.failed).toEqual([]);
  });

  it('warns about config entries for skipped plugin rules and names the input that disabled them', async () => {
    const { workspace, root } = repoFrom('clean');
    mkdirSync(join(root, '.github/flowpact'), { recursive: true });
    writeFileSync(
      join(root, '.github/flowpact/flowpact.config.yml'),
      'plugins: [./p.mjs]\nrules:\n  acme-no-echo: error\n',
    );
    process.env.GITHUB_EVENT_NAME = 'pull_request';
    const s = await action(workspace, { plugins: 'false' });
    const warnings = s.annotations.filter((a) => a.level === 'warning').map((a) => a.message);
    expect(warnings.some((m) => m.includes('the plugins input is false'))).toBe(true);
    expect(warnings.some((m) => m.includes('rules.acme-no-echo'))).toBe(true);
    expect(s.failed).toEqual([]);
  });

  it('keeps each step’s drift artifact separate and names it after working-directory', async () => {
    const { workspace, root } = repoFrom('deep-nesting', 'svc');
    lockContracts(root);
    addRequiredInput(root);
    process.env.GITHUB_ACTION = 'flowpact-svc';
    const s = await action(workspace, { mode: 'check', 'working-directory': 'svc' });
    expect(s.uploads[0]!.name).toBe('flowpact-contracts-svc');
    expect(s.uploads[0]!.root).toContain('flowpact-contracts-artifact-flowpact-svc-svc');
  });

  it('writes the drift artifact to a fresh private folder outside the runner', async () => {
    const { workspace, root } = repoFrom('deep-nesting', 'svc');
    lockContracts(root);
    addRequiredInput(root);
    delete process.env.RUNNER_TEMP;
    const a = (await action(workspace, { mode: 'check', 'working-directory': 'svc' })).uploads.at(-1)!.root;
    const b = (await action(workspace, { mode: 'check', 'working-directory': 'svc' })).uploads.at(-1)!.root;
    expect(a.startsWith(join(tmpdir(), 'flowpact-contracts-artifact-'))).toBe(true);
    expect(a).not.toBe(b);
    if (process.platform !== 'win32') expect(statSync(a).mode & 0o777).toBe(0o700);
  });

  it('shortens the job summary to stay within GitHub’s limit', async () => {
    const { analyze: run2, memoryFileSystem } = await import('@flowpact/core');
    const files: Record<string, string> = {};
    for (let i = 0; i < 200; i++) {
      const inputs = Array.from({ length: 30 }, (_, j) => `      i${j}: { type: string }`).join('\n');
      files[`.github/workflows/w${i}.yml`] =
        `on:\n  workflow_call:\n    inputs:\n${inputs}\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n`;
    }
    const result = run2({
      root: '/v',
      fs: memoryFileSystem(files),
      validateSchema: false,
      repository: 'a/b',
      config: (await import('@flowpact/core')).parseConfig({
        overrides: [{ rule: 'unused-input', target: '**', reason: 'accepted while migrating (JIRA-1)' }],
      }),
    });
    expect(result.suppressed.length).toBe(6000);
    const md = summaryWithinLimit(result, { maxFindings: 50 });
    expect(Buffer.byteLength(md)).toBeLessThan(SUMMARY_LIMIT);
    expect(md).toContain('more suppressed findings');
  });
});
