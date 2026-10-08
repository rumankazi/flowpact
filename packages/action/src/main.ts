import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { DefaultArtifactClient } from '@actions/artifact';
import * as core from '@actions/core';
import {
  type AnalysisResult,
  analyze,
  bannerText,
  ConfigError,
  type ContractPlan,
  contractPatch,
  createLogger,
  createRegistry,
  exitCodeFor,
  type Finding,
  type LoadedConfig,
  type LogLevel,
  type LogRecord,
  type LogSink,
  loadConfig,
  loadPlugins,
  neutralizeWorkflowCommands,
  resolveLogLevel,
  writeContracts,
} from '@wfc/core';
import { type MarkdownOptions, renderJson, renderMarkdown, renderSarif } from '@wfc/reporters';

/** Input defaults; `action.yml` declares the same values (a test keeps them in sync). */
export const DEFAULTS = {
  mode: 'lint',
  paths: '',
  'working-directory': '.',
  config: '',
  'fail-on': 'error',
  annotations: 'true',
  summary: 'true',
  'summary-graph': 'false',
  'max-findings': '50',
  'report-json': '',
  'report-sarif': '',
  'report-markdown': '',
  'upload-contracts': 'true',
  'artifact-name': 'wfc-contracts',
  'retention-days': '7',
  plugins: 'auto',
  debug: 'false',
} as const;

/** Events where the checkout may contain untrusted code while secrets or a write token are available. */
const UNTRUSTED_EVENTS = new Set(['pull_request_target', 'workflow_run']);

/** Largest job summary GitHub accepts per step is 1 MiB; stay below it. */
export const SUMMARY_LIMIT = 1_000_000;

type InputName = keyof typeof DEFAULTS;
type FailOn = 'error' | 'warning' | 'never';

/** Name of the patch inside the drift artifact; applied with `git apply` from the repository root. */
export const PATCH_FILE = 'wfc-contracts.patch';
/**
 * Regenerated contract files and the README go under this folder of the artifact, so downloading the artifact
 * into the repository root (as the job summary suggests) never overwrites tracked files.
 */
export const ARTIFACT_DIR = 'wfc-contracts';

class InputError extends Error {}

interface Inputs {
  mode: 'lint' | 'check';
  paths: string[];
  workingDirectory: string;
  config: string;
  failOn: FailOn;
  annotations: boolean;
  summary: boolean;
  summaryGraph: boolean;
  maxFindings: number;
  reportJson: string;
  reportSarif: string;
  reportMarkdown: string;
  uploadContracts: boolean;
  artifactName: string;
  retentionDays: number;
  /** Whether `plugins:` from the checked-out config may run. */
  plugins: boolean;
  debug: boolean;
}

function input(name: InputName): string {
  return core.getInput(name).trim() || DEFAULTS[name];
}

function oneOf<T extends string>(name: InputName, options: readonly T[]): T {
  const value = input(name);
  if (!(options as readonly string[]).includes(value))
    throw new InputError(`Input ${name} must be one of ${options.join(', ')} (got "${value}")`);
  return value as T;
}

function bool(name: InputName): boolean {
  const value = input(name).toLowerCase();
  if (['true', 'yes', 'on', '1'].includes(value)) return true;
  if (['false', 'no', 'off', '0'].includes(value)) return false;
  throw new InputError(`Input ${name} must be true or false (got "${value}")`);
}

function int(name: InputName): number {
  const value = input(name);
  if (!/^\d+$/.test(value))
    throw new InputError(`Input ${name} must be a non-negative integer (got "${value}")`);
  return Number(value);
}

function readInputs(): Inputs {
  return {
    mode: oneOf('mode', ['lint', 'check']),
    paths: input('paths').split(/\s+/).filter(Boolean),
    workingDirectory: input('working-directory'),
    config: input('config'),
    failOn: oneOf('fail-on', ['error', 'warning', 'never']),
    annotations: bool('annotations'),
    summary: bool('summary'),
    summaryGraph: bool('summary-graph'),
    maxFindings: int('max-findings'),
    reportJson: input('report-json'),
    reportSarif: input('report-sarif'),
    reportMarkdown: input('report-markdown'),
    uploadContracts: bool('upload-contracts'),
    artifactName: input('artifact-name'),
    retentionDays: int('retention-days'),
    plugins: pluginsAllowed(oneOf('plugins', ['auto', 'true', 'false'])),
    debug: bool('debug'),
  };
}

function pluginsAllowed(value: 'auto' | 'true' | 'false'): boolean {
  if (value !== 'auto') return value === 'true';
  return !UNTRUSTED_EVENTS.has(process.env.GITHUB_EVENT_NAME ?? '');
}

const slug = (s: string) =>
  s
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'root';

/** Every output starts out defined, so steps that read them after an early failure see sane values. */
function initOutputs(): void {
  for (const k of ['errors', 'warnings', 'infos', 'suppressed', 'findings', 'breaking']) core.setOutput(k, 0);
  core.setOutput('drift', 'false');
  core.setOutput('exit-code', 2);
  for (const k of ['report-json', 'report-sarif', 'patch', 'artifact-id']) core.setOutput(k, '');
}

function formatRecord(r: LogRecord, withScope: boolean): string {
  const data = r.data && Object.keys(r.data).length ? ` ${JSON.stringify(r.data)}` : '';
  return `${withScope ? `[${r.scope}] ` : ''}${r.message}${data}`;
}

/**
 * Log lines go to the step log, never to annotations (findings are reported separately). Debug records use
 * `core.debug` when the runner shows them (step debug logging); when only the `debug` input asked for them they
 * would be hidden there, so they are printed as ordinary lines instead.
 */
function actionsSink(runnerDebug: boolean, groups: { depth: number }): LogSink {
  return {
    write(r) {
      switch (r.level) {
        case 'debug':
        case 'trace':
          if (runnerDebug) core.debug(formatRecord(r, true));
          else core.info(neutralizeWorkflowCommands(`${r.level}: ${formatRecord(r, true)}`));
          return;
        case 'info':
          core.info(neutralizeWorkflowCommands(formatRecord(r, false)));
          return;
        case 'warn':
          core.info(neutralizeWorkflowCommands(`warning: ${formatRecord(r, false)}`));
          return;
        case 'error':
          core.info(neutralizeWorkflowCommands(`error: ${formatRecord(r, false)}`));
          return;
      }
    },
    // The log viewer cannot nest groups; inside one, a nested group is just a heading line.
    group(title) {
      if (groups.depth++ === 0) core.startGroup(title);
      else core.info(title);
    },
    groupEnd() {
      if (--groups.depth === 0) core.endGroup();
    },
  };
}

const toPosix = (p: string) => p.split(sep).join('/');
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Path of a root-relative file relative to the workspace, where annotations and code scanning resolve it. */
function inWorkspace(prefix: string, file: string): string {
  return prefix ? posix.join(prefix, file) : file;
}

function annotate(f: Finding, prefix: string): void {
  const loc = f.loc;
  const props: core.AnnotationProperties = {
    title: `${f.code} ${f.name}`,
    file: inWorkspace(prefix, loc.file),
    startLine: loc.line,
    endLine: loc.endLine,
    // GitHub only honours columns on single-line annotations.
    ...(loc.line === loc.endLine ? { startColumn: loc.column, endColumn: loc.endColumn } : {}),
  };
  const message = `${f.message}\n${f.fix}\n${f.docsUrl}`;
  if (f.severity === 'error') core.error(message, props);
  else if (f.severity === 'warning') core.warning(message, props);
  else core.notice(message, props);
}

/** Rewrites SARIF artifact URIs so they are relative to the workspace (the repository) instead of the wfc root. */
function sarifInWorkspace(sarif: string, prefix: string): string {
  if (!prefix) return sarif;
  const doc = JSON.parse(sarif) as unknown;
  const visit = (v: unknown): void => {
    if (Array.isArray(v)) {
      for (const item of v) visit(item);
      return;
    }
    if (!v || typeof v !== 'object') return;
    const o = v as Record<string, unknown>;
    if (typeof o.uri === 'string' && o.uriBaseId === '%SRCROOT%') o.uri = posix.join(prefix, o.uri);
    for (const value of Object.values(o)) visit(value);
  };
  visit(doc);
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function writeReport(workspace: string, file: string, content: string): string {
  const abs = resolve(workspace, file);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  const shown = toPosix(relative(workspace, abs));
  core.info(`wrote ${shown.startsWith('..') ? abs : shown}`);
  return abs;
}

function artifactReadme(plan: ContractPlan, artifactName: string, runId: string | undefined): string {
  const download = runId
    ? `gh run download ${runId} -n ${artifactName}`
    : `# download the "${artifactName}" artifact from the workflow run and unzip it here`;
  return [
    '# Regenerated workflow contracts',
    '',
    `wfc check found that the locked contracts no longer match the workflows (${plan.counts.create} new, ${plan.counts.update} changed, ${plan.counts.delete} removed, ${plural(plan.breaking, 'breaking change')}).`,
    '',
    `This artifact holds \`${PATCH_FILE}\`, a patch that brings the contracts up to date, and, in this`,
    `folder, the regenerated contract files themselves (removed contracts are only in the patch).`,
    '',
    'To apply it, from the root of your repository:',
    '',
    '```sh',
    download,
    `git apply --index ${PATCH_FILE}`,
    `rm -r ${PATCH_FILE} ${ARTIFACT_DIR}`,
    '```',
    '',
    'Review the changes (breaking ones are listed in the job summary), then commit them.',
    'If you can run wfc locally, `wfc generate` produces the same files.',
    '',
  ].join('\n');
}

interface DriftArtifact {
  dir: string;
  patch: string;
  uploaded?: { id?: number };
}

/** Writes the regenerated contracts and a patch to a temp folder and uploads them as an artifact. */
async function driftArtifact(
  plan: ContractPlan,
  prefix: string,
  inputs: Inputs,
  runId: string | undefined,
): Promise<DriftArtifact> {
  // One folder per step (and project), so several wfc steps in a job never overwrite each other's patch.
  const dir = join(
    process.env.RUNNER_TEMP || tmpdir(),
    `wfc-contracts-artifact-${slug(process.env.GITHUB_ACTION ?? 'wfc')}-${slug(prefix)}`,
  );
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  // Paths in the patch and the artifact are relative to the repository, not to working-directory.
  const repoPlan: ContractPlan = {
    ...plan,
    entries: plan.entries.map((e) => ({ ...e, file: inWorkspace(prefix, e.file) })),
  };
  const patch = join(dir, PATCH_FILE);
  writeFileSync(patch, contractPatch(repoPlan));
  const contracts = writeContracts(dir, repoPlan, join(dir, ARTIFACT_DIR));
  writeFileSync(join(dir, ARTIFACT_DIR, 'README.md'), artifactReadme(plan, inputs.artifactName, runId));
  const files = [
    patch,
    join(dir, ARTIFACT_DIR, 'README.md'),
    ...contracts.map((f) => join(dir, ARTIFACT_DIR, f)),
  ];
  core.info(`wrote ${PATCH_FILE} and ${plural(contracts.length, 'contract file')} to ${dir}`);
  const out: DriftArtifact = { dir, patch };
  if (!inputs.uploadContracts) return out;
  try {
    const res = await new DefaultArtifactClient().uploadArtifact(inputs.artifactName, files, dir, {
      ...(inputs.retentionDays > 0 ? { retentionDays: inputs.retentionDays } : {}),
    });
    core.info(`uploaded artifact ${inputs.artifactName}${res.id !== undefined ? ` (id ${res.id})` : ''}`);
    out.uploaded = { ...(res.id !== undefined ? { id: res.id } : {}) };
  } catch (err) {
    const message = (err as Error).message;
    const conflict = /409|conflict|already exists/i.test(message)
      ? ' Another step or matrix job in this run already uploaded an artifact with this name: set a unique `artifact-name`.'
      : '';
    core.warning(`Could not upload the ${inputs.artifactName} artifact: ${message}.${conflict}`);
  }
  return out;
}

function failureMessage(result: AnalysisResult, inputs: Inputs, drift: DriftArtifact | undefined): string {
  const s = result.summary;
  const counted =
    inputs.failOn === 'warning'
      ? `${plural(s.errors, 'error')} and ${plural(s.warnings, 'warning')}`
      : plural(s.errors, 'error');
  let message = `wfc found ${counted}`;
  const plan = result.contracts;
  if (plan?.drift) {
    message += `; the workflow contracts drifted (${plural(plan.breaking, 'breaking change')})`;
    message += drift?.uploaded
      ? ` — apply ${PATCH_FILE} from the ${inputs.artifactName} artifact (see the job summary) or run wfc generate`
      : ' — run wfc generate and commit the result';
  }
  return `${message}.`;
}

/** The job summary, shortened step by step until it fits GitHub's per-step limit. */
export function summaryWithinLimit(result: AnalysisResult, opts: MarkdownOptions): string {
  const attempts: MarkdownOptions[] = [
    opts,
    { ...opts, includeGraph: false },
    { ...opts, includeGraph: false, maxFindings: Math.min(opts.maxFindings ?? 50, 20) },
    { ...opts, includeGraph: false, maxFindings: 5 },
  ];
  for (const attempt of attempts) {
    const md = renderMarkdown(result, attempt);
    if (Buffer.byteLength(md) <= SUMMARY_LIMIT) {
      if (attempt !== opts)
        core.warning('The job summary was shortened to stay within GitHub’s 1 MiB limit.');
      return md;
    }
  }
  core.warning('The job summary is too large even when shortened; see the report files instead.');
  return `## wfc ${opts.title ?? ''}\n\nThe report is too large for a job summary. Use the \`report-json\` or \`report-sarif\` inputs.\n`;
}

export async function run(): Promise<void> {
  let debug = false;
  initOutputs();
  try {
    const inputs = readInputs();
    const envLevel = resolveLogLevel({}, process.env);
    debug = inputs.debug || core.isDebug() || envLevel !== 'info';
    const level: LogLevel = debug ? (envLevel === 'trace' ? 'trace' : 'debug') : 'info';
    const groups = { depth: 0 };
    const logger = createLogger({ level, sink: actionsSink(core.isDebug(), groups) });
    const group = async <T>(title: string, fn: () => Promise<T> | T): Promise<T> => {
      groups.depth++;
      try {
        return await core.group(title, async () => fn());
      } finally {
        groups.depth--;
      }
    };

    core.info(bannerText());
    const workspace = resolve(process.env.GITHUB_WORKSPACE || process.cwd());
    const root = resolve(workspace, inputs.workingDirectory);
    const rel = toPosix(relative(workspace, root));
    const prefix = rel === '' || rel === '.' ? '' : rel;

    const loaded: LoadedConfig = loadConfig(root, inputs.config ? resolve(root, inputs.config) : undefined);
    core.info(`mode ${inputs.mode} · root ${prefix || '.'} · config ${loaded.file ?? '(defaults)'}`);
    // With several projects (working-directory), give each its own artifact unless a name was set explicitly.
    if (!core.getInput('artifact-name').trim() && prefix)
      inputs.artifactName = `wfc-contracts-${slug(prefix)}`;
    if (loaded.config.plugins.length && !inputs.plugins) {
      const why =
        core.getInput('plugins').trim().toLowerCase() === 'false'
          ? 'the plugins input is false'
          : `plugins run code from the checkout and are disabled on ${process.env.GITHUB_EVENT_NAME} events; set the plugins input to true to allow them`;
      core.warning(`Not loading ${loaded.config.plugins.length} plugin(s) from the config: ${why}.`);
    }

    const result = await group(`wfc ${inputs.mode}: analyze`, async () => {
      const registry = createRegistry();
      if (inputs.plugins) await loadPlugins(root, loaded.config, registry, logger);
      return analyze({
        root,
        config: loaded.config,
        ...(inputs.paths.length ? { paths: inputs.paths } : {}),
        ...(loaded.file ? { configFile: loaded.file } : {}),
        ...(loaded.text !== undefined ? { configText: loaded.text } : {}),
        ...(loaded.overrideLocs ? { overrideLocs: loaded.overrideLocs } : {}),
        logger,
        registry,
        checkContracts: inputs.mode === 'check',
        pluginsSkipped: loaded.config.plugins.length > 0 && !inputs.plugins,
      });
    });
    if (result.unloadedRules?.length) {
      core.warning(
        `Ignoring config entries for rules that are not loaded (plugins skipped): ${result.unloadedRules.join('; ')}`,
      );
    }
    const s = result.summary;
    const missing = result.project.missingTargets ?? [];
    if (missing.length) {
      core.setFailed(`paths not found under ${prefix || '.'}: ${missing.join(', ')}`);
      return;
    }
    if (inputs.paths.length && result.project.targets.size === 0 && !result.project.wholeRepository) {
      core.setFailed(
        `None of the paths is a workflow (.github/workflows/*.yml) or an action (action.yml): ${inputs.paths.join(', ')}`,
      );
      return;
    }
    if (s.workflows === 0 && s.actions === 0) {
      core.setFailed(
        `No workflows found under ${prefix || '.'}/.github/workflows. Set working-directory to the repository that holds them.`,
      );
      return;
    }

    if (inputs.annotations) for (const f of result.findings) annotate(f, prefix);

    const runId = process.env.GITHUB_RUN_ID || undefined;
    const plan = result.contracts;
    const drift = plan?.drift
      ? await group('wfc: contract drift artifact', () => driftArtifact(plan, prefix, inputs, runId))
      : undefined;

    const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_SHA } = process.env;
    const markdownOptions: MarkdownOptions = {
      title: `wfc ${inputs.mode}`,
      maxFindings: inputs.maxFindings,
      includeGraph: inputs.summaryGraph,
      ...(GITHUB_SERVER_URL && GITHUB_REPOSITORY && GITHUB_SHA
        ? // Links are `<repo>/blob/<sha>/<file>`; files are relative to working-directory, so it joins the sha.
          {
            repoUrl: `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}`,
            sha: prefix ? `${GITHUB_SHA}/${prefix}` : GITHUB_SHA,
          }
        : {}),
      ...(drift?.uploaded
        ? { artifact: { name: inputs.artifactName, ...(runId ? { runId } : {}), patchFile: PATCH_FILE } }
        : {}),
    };
    const markdown = () => renderMarkdown(result, markdownOptions);

    if (inputs.summary) {
      try {
        await core.summary.addRaw(summaryWithinLimit(result, markdownOptions)).write();
      } catch (err) {
        core.warning(`Could not write the job summary: ${(err as Error).message}`);
      }
    }

    const reports: { json?: string; sarif?: string } = {};
    if (inputs.reportJson || inputs.reportSarif || inputs.reportMarkdown) {
      await group('wfc: reports', () => {
        if (inputs.reportJson) reports.json = writeReport(workspace, inputs.reportJson, renderJson(result));
        if (inputs.reportSarif)
          reports.sarif = writeReport(
            workspace,
            inputs.reportSarif,
            sarifInWorkspace(renderSarif(result), prefix),
          );
        if (inputs.reportMarkdown) writeReport(workspace, inputs.reportMarkdown, markdown());
      });
    }

    const exitCode = exitCodeFor(s, inputs.failOn);
    core.setOutput('errors', s.errors);
    core.setOutput('warnings', s.warnings);
    core.setOutput('infos', s.infos);
    core.setOutput('suppressed', s.suppressed);
    core.setOutput('findings', s.total);
    core.setOutput('drift', plan?.drift ? 'true' : 'false');
    core.setOutput('breaking', plan?.breaking ?? 0);
    core.setOutput('exit-code', exitCode);
    core.setOutput('report-json', reports.json ?? '');
    core.setOutput('report-sarif', reports.sarif ?? '');
    core.setOutput('patch', drift?.patch ?? '');
    core.setOutput('artifact-id', drift?.uploaded?.id ?? '');

    core.info(
      `wfc ${inputs.mode}: ${plural(s.errors, 'error')}, ${plural(s.warnings, 'warning')}, ${s.infos} info, ${s.suppressed} suppressed · ${plural(s.workflows, 'workflow')} · ${result.durationMs} ms`,
    );
    if (exitCode !== 0) core.setFailed(failureMessage(result, inputs, drift));
  } catch (err) {
    if (err instanceof ConfigError) {
      const where = err.file ? ` (${err.file})` : '';
      core.setFailed([`${err.message}${where}`, ...err.issues.map((i) => `  - ${i}`)].join('\n'));
    } else if (err instanceof InputError) {
      core.setFailed(err.message);
    } else {
      const e = err instanceof Error ? err : new Error(String(err));
      core.setFailed(debug && e.stack ? e.stack : `${e.message} (set the debug input for a stack trace)`);
    }
  }
}
