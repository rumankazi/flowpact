import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { contractPatch, exitCodeFor } from '@flowpact/core';
import {
  type MarkdownOptions,
  renderJson,
  renderMarkdown,
  renderPretty,
  renderSarif,
} from '@flowpact/reporters';
import { type ArgsDef, defineCommand } from 'citty';
import { runAnalysis } from '../analysis';
import {
  commonArgs,
  createContext,
  displayPath,
  guard,
  printBanner,
  UsageError,
  writeOutput,
} from '../shared';

/** Flags shared by `lint` and `check`. */
export const reportArgs = {
  paths: {
    type: 'positional',
    description: 'Workflow/action files or directories to report on (default: all)',
    required: false,
  },
  ...commonArgs,
  format: {
    type: 'enum',
    options: ['pretty', 'json', 'markdown', 'sarif'],
    default: 'pretty',
    description:
      'Output format on stdout: pretty, json, markdown (job summaries, PR comments) or sarif (code scanning)',
  },
  output: {
    type: 'string',
    alias: 'o',
    description:
      'Also write the report to a file, format by extension: .sarif/.sarif.json → SARIF, .json → JSON, .md → Markdown, otherwise plain text',
    valueHint: 'file',
  },
  'fail-on': {
    type: 'enum',
    options: ['error', 'warning', 'never'],
    default: 'error',
    description: 'Exit 1 when findings at this level exist',
  },
  'hide-info': { type: 'boolean', description: 'Do not list info-level findings (still counted)' },
  only: {
    type: 'string',
    description: 'Comma-separated rule codes or names to run',
    valueHint: 'FP401,...',
  },
  'include-graph': {
    type: 'boolean',
    description: 'Include the data-flow graph in JSON output and the call graph (Mermaid) in Markdown output',
  },
  'dump-graph': {
    type: 'string',
    description: 'Write the data-flow graph as JSON (debugging)',
    valueHint: 'file',
  },
  schema: {
    type: 'boolean',
    default: true,
    description: 'Validate against GitHub’s workflow schema (--no-schema to skip)',
  },
} satisfies ArgsDef;

type ReportFlags = {
  _: string[];
  format: string;
  output?: string | undefined;
  'fail-on': string;
  'hide-info'?: boolean | undefined;
  only?: string | undefined;
  'include-graph'?: boolean | undefined;
  'dump-graph'?: string | undefined;
  schema?: boolean | undefined;
  patch?: string | undefined;
};

export type ReportArgs = ReportFlags & Parameters<typeof createContext>[0];

type Format = 'pretty' | 'json' | 'markdown' | 'sarif';

/** The format `-o` writes, chosen by the file extension. */
export function formatForFile(file: string): Format {
  const f = file.toLowerCase();
  if (f.endsWith('.sarif') || f.endsWith('.sarif.json')) return 'sarif';
  if (f.endsWith('.json')) return 'json';
  if (f.endsWith('.md')) return 'markdown';
  return 'pretty';
}

/** In GitHub Actions, link Markdown locations to the files at the commit being checked. */
function markdownOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): MarkdownOptions {
  const { GITHUB_ACTIONS, GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_SHA } = env;
  if (GITHUB_ACTIONS !== 'true' || !GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_SHA) return {};
  return { repoUrl: `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}`, sha: GITHUB_SHA };
}

/** Shared implementation of `flowpact lint` and `flowpact check`. */
export async function runReport(
  args: ReportArgs,
  rawArgs: string[],
  command: 'lint' | 'check',
): Promise<number> {
  const ctx = createContext(args, rawArgs);
  printBanner(ctx, `root ${displayPath(ctx.root)}${ctx.loaded.file ? ` · config ${ctx.loaded.file}` : ''}`);
  // Paths are relative to --root; a path that only exists relative to the working directory is taken from there.
  const paths = args._.filter((p) => p !== command).map((p) =>
    isAbsolute(p) || existsSync(resolve(ctx.root, p)) || !existsSync(resolve(process.cwd(), p))
      ? p
      : resolve(process.cwd(), p),
  );
  const only = args.only
    ? args.only
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  const result = await runAnalysis(ctx, {
    paths,
    validateSchema: args.schema !== false,
    checkContracts: command === 'check',
    ...(only ? { only } : {}),
  });
  const missing = result.project.missingTargets ?? [];
  if (missing.length) {
    throw new UsageError(
      `Path${missing.length > 1 ? 's' : ''} not found under ${displayPath(ctx.root)}: ${missing.join(', ')}`,
    );
  }
  if (paths.length && result.project.targets.size === 0 && !result.project.wholeRepository) {
    throw new UsageError(
      `None of the paths is a workflow (.github/workflows/*.yml) or an action (action.yml): ${(result.project.ignoredTargets ?? paths).join(', ')}`,
    );
  }
  if (result.summary.workflows === 0 && result.summary.actions === 0) {
    throw new UsageError(
      `No workflows found under ${displayPath(ctx.root)}/.github/workflows. Use --root to point at a repository.`,
    );
  }
  const includeGraph = Boolean(args['include-graph']);
  const render = (format: Format, toFile: boolean): string => {
    switch (format) {
      case 'json':
        return renderJson(result, { includeGraph });
      case 'sarif':
        return renderSarif(result);
      case 'markdown':
        return renderMarkdown(result, { ...markdownOptionsFromEnv(), includeGraph });
      default:
        return toFile
          ? renderPretty(result, { ...ctx.plain, hideInfo: false })
          : renderPretty(result, { ...ctx.render, hideInfo: Boolean(args['hide-info']) });
    }
  };
  ctx.stdout(render(args.format as Format, false));
  if (args.output) writeOutput(args.output, render(formatForFile(args.output), true), ctx);
  if (args['dump-graph'])
    writeOutput(args['dump-graph'], `${JSON.stringify(result.index.toJSON(), null, 2)}\n`, ctx);
  if (args.patch && result.contracts?.drift) writeOutput(args.patch, contractPatch(result.contracts), ctx);
  return exitCodeFor(result.summary, args['fail-on'] as 'error' | 'warning' | 'never');
}

export const lintCommand = defineCommand({
  meta: {
    name: 'lint',
    description: 'Analyze workflows and local actions: inputs, secrets, outputs, matrices and call structure',
  },
  args: reportArgs,
  run: ({ args, rawArgs }) => guard(() => runReport(args as unknown as ReportArgs, rawArgs, 'lint')),
});
