import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reportSchema, VERSION } from '@wfc/core';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BIN = join(ROOT, 'packages/cli/dist/index.js');
const fixture = (name: string) => join(ROOT, 'fixtures', name);

const SCRUB = [
  'NO_COLOR',
  'FORCE_COLOR',
  'WFC_DEBUG',
  'RUNNER_DEBUG',
  'ACTIONS_STEP_DEBUG',
  'CI',
  'GITHUB_ACTIONS',
  'GITHUB_SERVER_URL',
  'GITHUB_SHA',
];

/** Runs the built CLI with a controlled environment (no inherited color/debug/Actions settings). */
const wfc = (args: string[], env: Record<string, string> = { NO_COLOR: '1' }) => {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SCRUB.includes(k)));
  return execa('node', [BIN, ...args], {
    reject: false,
    cwd: ROOT,
    extendEnv: false,
    env: { ...base, GITHUB_REPOSITORY: 'acme/fixtures', ...env },
  });
};

describe('wfc graph', () => {
  it('prints a tree by default with cycles, remote and missing targets', async () => {
    const r = await wfc(['graph', '--root', fixture('cycles')]);
    expect(r.exitCode).toBe(0);
    expect(r.stderr).toContain(`v${VERSION}`);
    expect(r.stdout).toContain('Main (.github/workflows/main.yml)');
    expect(r.stdout).toContain('jobs.back → B (.github/workflows/b.yml) ↻ cycle');
    expect(r.stdout).toContain('.github/workflows/does-not-exist.yml (missing)');
    expect(r.stdout).toContain('octo-org/shared/.github/workflows/lint.yml@v2 (remote)');
    expect(r.stdout).not.toMatch(/\u001B\[/);
  });

  it('prints Mermaid, DOT and JSON', async () => {
    const mermaid = await wfc(['graph', '--root', fixture('composite-actions'), '--format', 'mermaid', '-q']);
    expect(mermaid.stdout).toMatch(/^flowchart LR\n/);
    expect(mermaid.stdout).toContain('act_install_tools{{');
    const dot = await wfc(['graph', '--root', fixture('deep-nesting'), '--format', 'dot', '-q']);
    expect(dot.stdout).toMatch(/^digraph wfc \{/);
    expect(dot.stdout).toContain('label="jobs.build (inherit)"');
    const json = await wfc(['graph', '--root', fixture('cycles'), '--format', 'json', '-q']);
    const graph = JSON.parse(json.stdout);
    expect(graph.nodes.map((n: { kind: string }) => n.kind)).toEqual([
      'workflow',
      'workflow',
      'workflow',
      'remote',
      'missing',
    ]);
    expect(graph.edges).toContainEqual({
      from: '.github/workflows/main.yml',
      to: '.github/workflows/b.yml',
      via: 'jobs.stage-b',
      kind: 'calls',
    });
  });

  it('rejects unknown formats and empty repositories', async () => {
    expect((await wfc(['graph', '--root', fixture('cycles'), '--format', 'svg'])).exitCode).not.toBe(0);
    const empty = await wfc(['graph', '--root', mkdtempSync(join(tmpdir(), 'wfc-empty-'))]);
    expect(empty.exitCode).toBe(2);
    expect(empty.stderr).toContain('No workflows found');
  });
});

describe('wfc lint output formats', () => {
  it('prints SARIF with --format sarif', async () => {
    const r = await wfc(['lint', '--root', fixture('incident-matrix'), '--format', 'sarif']);
    expect(r.exitCode).toBe(1);
    const sarif = JSON.parse(r.stdout);
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs[0].tool.driver.version).toBe(VERSION);
    expect(sarif.runs[0].results[0]).toMatchObject({ ruleId: 'WFC401', level: 'error' });
  });

  it('prints Markdown with --format markdown, with the call graph on request', async () => {
    const r = await wfc([
      'lint',
      '--root',
      fixture('deep-nesting'),
      '--format',
      'markdown',
      '--include-graph',
    ]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/^## wfc report\n/);
    expect(r.stdout).toContain('❌ **4 errors**');
    expect(r.stdout).toContain('```mermaid\nflowchart LR');
    expect(r.stdout).not.toContain('/blob/');
  });

  it('links Markdown locations to the commit inside GitHub Actions', async () => {
    const r = await wfc(['lint', '--root', fixture('incident-matrix'), '--format', 'markdown', '-q'], {
      NO_COLOR: '1',
      GITHUB_ACTIONS: 'true',
      GITHUB_SERVER_URL: 'https://github.com',
      GITHUB_SHA: 'abc123',
    });
    expect(r.stdout).toContain(
      '(https://github.com/acme/fixtures/blob/abc123/.github/workflows/tests.yml#L23)',
    );
  });

  it('picks the -o format by extension', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wfc-fmt-'));
    const root = fixture('incident-matrix');
    for (const file of ['r.sarif', 'r.sarif.json', 'r.json', 'r.md', 'r.txt']) {
      const r = await wfc(['lint', '--root', root, '-o', join(dir, file)]);
      expect(r.stderr).toContain('report written to');
    }
    const read = (f: string) => readFileSync(join(dir, f), 'utf8');
    expect(JSON.parse(read('r.sarif')).version).toBe('2.1.0');
    expect(JSON.parse(read('r.sarif.json')).version).toBe('2.1.0');
    expect(reportSchema.safeParse(JSON.parse(read('r.json'))).success).toBe(true);
    expect(read('r.md')).toMatch(/^## wfc report\n/);
    expect(read('r.txt')).toContain('WFC401 empty-binding-for-matrix-combo');
  });

  it('supports the same formats in wfc check', async () => {
    const r = await wfc(['check', '--root', fixture('clean'), '--format', 'markdown', '-q']);
    expect(r.stdout).toContain('### Contracts');
  });
});
