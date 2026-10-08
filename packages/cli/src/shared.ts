import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import {
  ConfigError,
  createLogger,
  type LoadedConfig,
  type Logger,
  type LogLevel,
  type LogRecord,
  loadConfig,
  neutralizeWorkflowCommands,
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
  debug: { type: 'boolean', description: 'Debug logging (also FLOWPACT_DEBUG=1)', alias: 'd' },
  verbose: { type: 'boolean', description: 'Verbose logging; repeat for trace (-vv)', alias: 'v' },
  quiet: { type: 'boolean', description: 'Only print errors and the report', alias: 'q' },
  color: { type: 'boolean', description: 'Colorized output (use --no-color to disable)', default: true },
  ascii: { type: 'boolean', description: 'ASCII-only symbols for limited terminals' },
} satisfies ArgsDef;

export interface CommonFlags {
  root?: string | undefined;
  config?: string | undefined;
  debug?: boolean | undefined;
  verbose?: boolean | undefined;
  quiet?: boolean | undefined;
  color?: boolean | undefined;
  ascii?: boolean | undefined;
}

export interface CliContext {
  root: string;
  logger: Logger;
  level: LogLevel;
  render: RenderOptions;
  /** Render options for files: never colored, no hyperlinks. */
  plain: RenderOptions;
  loaded: LoadedConfig;
  stdout: (s: string) => void;
  stderr: (s: string) => void;
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
  const loaded = loadConfig(root, flags.config);
  logger.debug('cli context', {
    root,
    level,
    color,
    width: render.width,
    config: loaded.file ?? '(defaults)',
  });
  return {
    root,
    logger,
    level,
    render,
    plain: { ...render, color: false, hyperlinks: false },
    loaded,
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
