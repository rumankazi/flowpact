import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  ConfigError,
  createLogger,
  type LoadedConfig,
  type Logger,
  type LogLevel,
  type LogRecord,
  loadConfig,
  neutralizeWorkflowCommands,
  type Project,
  RuleRegistryError,
  resolveLogLevel,
  toolMeta,
  UnsafePathError,
} from '@flowpact/core';
import { type RenderOptions, renderBanner } from '@flowpact/reporters';
import type { ArgsDef } from 'citty';
import pc from 'picocolors';

export const EXIT = { ok: 0, findings: 1, usage: 2, internal: 3 } as const;

/** Flags shared by every analysis command. */
export const commonArgs = {
  root: { type: 'string', description: 'Repository root (default: current directory)', valueHint: 'dir' },
  config: {
    type: 'string',
    description: 'Config file (default: .github/flowpact/flowpact.config.yml)',
    valueHint: 'file',
  },
  'base-config': {
    type: 'string',
    description:
      "Defaults under the repository's config, e.g. an organization's (relative to the working directory)",
    valueHint: 'file',
  },
  debug: { type: 'boolean', description: 'Debug logging (also FLOWPACT_DEBUG=1)', alias: 'd' },
  verbose: { type: 'boolean', description: 'Verbose logging; repeat for trace (-vv)', alias: 'v' },
  quiet: { type: 'boolean', description: 'Only print errors and the report', alias: 'q' },
  color: { type: 'boolean', description: 'Colorized output (use --no-color to disable)', default: true },
  ascii: { type: 'boolean', description: 'ASCII-only symbols for limited terminals' },
} satisfies ArgsDef;

/** Flags of the commands that load rules: which plugins run. */
export const pluginArgs = {
  plugins: {
    type: 'boolean',
    default: true,
    description: 'Load the plugins the config lists (--no-plugins on code you do not trust)',
  },
  plugin: {
    type: 'string',
    description:
      'Also load this plugin, relative to the working directory (repeatable; not affected by --no-plugins)',
    valueHint: 'file',
  },
} satisfies ArgsDef;

export interface CommonFlags {
  root?: string | undefined;
  config?: string | undefined;
  'base-config'?: string | undefined;
  debug?: boolean | undefined;
  verbose?: boolean | undefined;
  quiet?: boolean | undefined;
  color?: boolean | undefined;
  ascii?: boolean | undefined;
  plugins?: boolean | undefined;
}

export interface CliContext {
  root: string;
  logger: Logger;
  level: LogLevel;
  render: RenderOptions;
  /** Render options for files: never colored, no hyperlinks. */
  plain: RenderOptions;
  loaded: LoadedConfig;
  /** Whether the plugins the config lists are loaded, and the plugins given with `--plugin` (absolute paths). */
  plugins: { config: boolean; extra: string[] };
  stdout: (s: string) => void;
  stderr: (s: string) => void;
}

/**
 * Every value of a flag that may be repeated, in order: `--name v`, `--name=v` and `-x v`. citty keeps only the last
 * one.
 */
export function repeatedFlag(rawArgs: string[], name: string, alias?: string): string[] {
  const values: string[] = [];
  for (let i = 0; i < rawArgs.length; i++) {
    const a = rawArgs[i]!;
    if (a === '--') break;
    if (a === `--${name}` || (alias && a === `-${alias}`)) {
      const v = rawArgs[i + 1];
      if (v !== undefined) values.push(v);
      i++;
    } else if (a.startsWith(`--${name}=`)) values.push(a.slice(name.length + 3));
    else if (alias && a.startsWith(`-${alias}=`)) values.push(a.slice(alias.length + 2));
  }
  return values;
}

function countVerbose(rawArgs: string[]): number {
  let n = 0;
  for (const a of rawArgs) {
    if (a === '--verbose') n++;
    else if (/^-v+$/.test(a)) n += a.length - 1;
  }
  return n;
}

export function stderrSink(color: boolean) {
  const c = pc.createColors(color);
  const tag: Record<LogRecord['level'], string> = {
    error: c.red('error'),
    warn: c.yellow(' warn'),
    info: c.cyan(' info'),
    debug: c.magenta('debug'),
    trace: c.dim('trace'),
  };
  let depth = 0;
  return {
    write(r: LogRecord) {
      const data = r.data && Object.keys(r.data).length ? ` ${c.dim(JSON.stringify(r.data))}` : '';
      process.stderr.write(
        `${'  '.repeat(depth)}${tag[r.level]} ${c.dim(r.scope.padEnd(14))} ${r.message}${data}\n`,
      );
    },
    group(title: string) {
      process.stderr.write(`${c.bold(title)}\n`);
      depth++;
    },
    groupEnd() {
      depth = Math.max(0, depth - 1);
    },
  };
}

/** One color decision for all CLI output: --no-color, NO_COLOR, FORCE_COLOR (0/false = off), then TTY detection. */
export function colorEnabled(
  flagColor: boolean | undefined = true,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const noColor = env.NO_COLOR !== undefined && env.NO_COLOR !== '';
  const forceOff = env.FORCE_COLOR === '0' || env.FORCE_COLOR === 'false';
  const forceOn = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== '' && !forceOff;
  return flagColor !== false && !noColor && !forceOff && (forceOn || pc.isColorSupported);
}

export function createContext(flags: CommonFlags, rawArgs: string[]): CliContext {
  const env = process.env;
  const color = colorEnabled(flags.color, env);
  const isTTY = Boolean(process.stdout.isTTY);
  const columns = process.stdout.columns ?? Number(env.COLUMNS ?? 100);
  const render: RenderOptions = {
    color,
    width: Math.max(40, Math.min(140, columns || 100)),
    hyperlinks: color && isTTY && env.FLOWPACT_NO_HYPERLINKS === undefined,
    ascii: Boolean(flags.ascii),
  };
  const resolved = resolveLogLevel({
    debug: Boolean(flags.debug),
    verbose: countVerbose(rawArgs),
    quiet: Boolean(flags.quiet),
  });
  // The CLI keeps info-level progress quiet unless asked for; the report itself is the output.
  const level: LogLevel = resolved === 'info' ? 'warn' : resolved;
  const logger = createLogger({ level, sink: stderrSink(color) });
  const root = resolve(flags.root ?? process.cwd());
  const loaded = loadConfig(root, flags.config, {
    ...(flags['base-config'] !== undefined ? { base: flags['base-config'] } : {}),
  });
  logger.debug('cli context', {
    root,
    level,
    color,
    width: render.width,
    config: loaded.file ?? '(defaults)',
    ...(loaded.base ? { base: loaded.base.file } : {}),
  });
  return {
    root,
    logger,
    level,
    render,
    plain: { ...render, color: false, hyperlinks: false },
    loaded,
    plugins: {
      config: flags.plugins !== false,
      extra: repeatedFlag(rawArgs, 'plugin').map((p) => resolve(process.cwd(), p)),
    },
    stdout: (s) => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`),
    stderr: (s) => process.stderr.write(s.endsWith('\n') ? s : `${s}\n`),
  };
}

/** Shows paths relative to the working directory when they are inside it. */
export function displayPath(abs: string): string {
  const rel = relative(process.cwd(), abs);
  if (rel === '') return '.';
  return rel.startsWith('..') || isAbsolute(rel) ? abs : rel;
}

export function printBanner(ctx: CliContext, extra?: string) {
  if (ctx.level === 'error') return;
  ctx.stderr(renderBanner(toolMeta(), ctx.render, extra));
}

/**
 * Prints GitHub workflow commands (`--format github`). index.ts keeps every string written to stdout from being read
 * as a workflow command; a Buffer passes, which is only right for commands flowpact builds with every value escaped.
 */
export function writeWorkflowCommands(text: string) {
  process.stdout.write(Buffer.from(text));
}

/**
 * In GitHub Actions, the root relative to the workspace (the repository) when it is a subdirectory of it, or ''.
 * Annotations, code scanning and links to files resolve paths against the repository.
 */
export function workspacePrefix(root: string, env: NodeJS.ProcessEnv = process.env): string {
  if (env.GITHUB_ACTIONS !== 'true' || !env.GITHUB_WORKSPACE) return '';
  const rel = relative(resolve(env.GITHUB_WORKSPACE), root);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : '';
}

export function writeOutput(file: string, content: string, ctx: CliContext) {
  const abs = resolve(process.cwd(), file);
  try {
    mkdirSync(dirname(abs), { recursive: true });
    // A report file may be printed by a later CI step; keep it free of workflow commands too.
    writeFileSync(abs, neutralizeWorkflowCommands(content));
  } catch (err) {
    throw new UsageError(`Cannot write ${file}: ${(err as Error).message}`);
  }
  ctx.logger.info(`report written to ${file}`, { bytes: Buffer.byteLength(content) });
  if (ctx.level !== 'error') ctx.stderr(pc.createColors(ctx.render.color).dim(`report written to ${file}`));
}

/** Turns expected failures into friendly messages and exit codes; unexpected ones into a bug-report hint. */
export async function guard(fn: () => Promise<number> | number): Promise<void> {
  try {
    process.exitCode = await fn();
  } catch (err) {
    const c = pc.createColors(colorEnabled(!process.argv.includes('--no-color')));
    if (err instanceof ConfigError) {
      process.stderr.write(
        `${c.red(c.bold('Config error'))}${err.file ? c.dim(` (${err.file})`) : ''}: ${err.message}\n`,
      );
      for (const i of err.issues) process.stderr.write(`  ${c.red('•')} ${i}\n`);
      process.stderr.write(c.dim('  docs: https://rumankazi.github.io/flowpact/docs/configuration\n'));
      process.exitCode = EXIT.usage;
      return;
    }
    if (err instanceof UsageError || err instanceof RuleRegistryError || err instanceof UnsafePathError) {
      process.stderr.write(`${c.red(c.bold('Error'))}: ${err.message}\n`);
      process.exitCode = EXIT.usage;
      return;
    }
    process.stderr.write(`${c.red(c.bold('flowpact crashed'))}: ${(err as Error).stack ?? String(err)}\n`);
    process.stderr.write(
      c.dim('Please report this at https://github.com/rumankazi/flowpact/issues with the --debug output.\n'),
    );
    process.exitCode = EXIT.internal;
  }
}

export class UsageError extends Error {}

/**
 * Positional paths of `lint`, `check` and `generate`. They are relative to --root; a path that only exists relative to
 * the working directory is taken from there.
 */
export function pathArgs(positionals: string[], command: string, root: string): string[] {
  return positionals
    .filter((p) => p !== command)
    .map((p) =>
      isAbsolute(p) || existsSync(resolve(root, p)) || !existsSync(resolve(process.cwd(), p))
        ? p
        : resolve(process.cwd(), p),
    );
}

/** Refuses paths that do not exist, or that name no workflow or action. */
export function checkTargets(project: Project, paths: string[], root: string): void {
  const missing = project.missingTargets ?? [];
  if (missing.length) {
    throw new UsageError(
      `Path${missing.length > 1 ? 's' : ''} not found under ${displayPath(root)}: ${missing.join(', ')}`,
    );
  }
  if (paths.length && project.targets.size === 0 && !project.wholeRepository) {
    throw new UsageError(
      `None of the paths is a workflow (.github/workflows/*.yml) or an action (action.yml): ${(project.ignoredTargets ?? paths).join(', ')}`,
    );
  }
}
