import { bannerText, neutralizeWorkflowCommands, VERSION } from '@flowpact/core';
import { defineCommand, runCommand, runMain } from 'citty';
import pc from 'picocolors';
import { checkCommand } from './commands/check';
import { explainCommand } from './commands/explain';
import { generateCommand } from './commands/generate';
import { graphCommand } from './commands/graph';
import { impactCommand } from './commands/impact';
import { lintCommand } from './commands/lint';
import { lspCommand } from './commands/lsp';
import { rulesCommand } from './commands/rules';
import { traceCommand } from './commands/trace';
import { colorEnabled } from './shared';

// Output embeds names from the analyzed YAML; no line of it may become a GitHub workflow command in a CI log. The
// language server's stdout carries the protocol and must stay byte-exact.
const lsp = process.argv.slice(2).find((a) => !a.startsWith('-')) === 'lsp';
const streams = lsp ? [] : [process.stdout, process.stderr];
for (const stream of streams) {
  const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
  stream.write = ((chunk: unknown, ...rest: unknown[]) =>
    write(
      typeof chunk === 'string' ? neutralizeWorkflowCommands(chunk) : chunk,
      ...rest,
    )) as typeof stream.write;
}

if (process.argv.includes('--version') || process.argv.includes('-V')) {
  process.stdout.write(`${bannerText()}\n`);
  process.exit(0);
}

const main = defineCommand({
  meta: {
    name: 'flowpact',
    version: VERSION,
    description: 'Lint, trace and lock the data flow between your GitHub Actions workflows',
  },
  subCommands: {
    lint: lintCommand,
    check: checkCommand,
    generate: generateCommand,
    impact: impactCommand,
    trace: traceCommand,
    graph: graphCommand,
    explain: explainCommand,
    rules: rulesCommand,
    lsp: lspCommand,
  },
});

/** citty's argument errors (unknown command, bad enum value, missing positional). */
const ARG_ERRORS = new Set(['EARG', 'E_UNKNOWN_COMMAND', 'E_NO_COMMAND']);

async function run(): Promise<void> {
  const rawArgs = process.argv.slice(2);
  // Help (and no arguments at all) is rendered by citty, including per-command usage.
  if (rawArgs.length === 0 || rawArgs.some((a) => a === '--help' || a === '-h')) {
    await runMain(main, { rawArgs: rawArgs.length ? rawArgs : ['--help'] });
    return;
  }
  try {
    await runCommand(main, { rawArgs });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (!code || !ARG_ERRORS.has(code)) throw err;
    // Usage errors exit 2, so CI can tell them apart from findings (1).
    const c = pc.createColors(colorEnabled(!rawArgs.includes('--no-color')));
    const message = (err as Error).message.replace(/\u001B\[[\d;]*m/g, '');
    const sub = rawArgs.find((a) => !a.startsWith('-'));
    process.stderr.write(
      `${c.red(c.bold('Error'))}: ${message}\n${c.dim(`Run \`flowpact ${sub && code !== 'E_UNKNOWN_COMMAND' ? `${sub} ` : ''}--help\` for usage.`)}\n`,
    );
    process.exitCode = 2;
  }
}

void run();
