import { resolve } from 'node:path';
import {
  contractPatch,
  contractsInScope,
  nodeFileSystem,
  planContracts,
  scopePlan,
  writeContracts,
} from '@flowpact/core';
import { renderContractPlan, renderPatch } from '@flowpact/reporters';
import { defineCommand } from 'citty';
import { runAnalysis } from '../analysis';
import {
  checkTargets,
  commonArgs,
  createContext,
  displayPath,
  EXIT,
  guard,
  pathArgs,
  printBanner,
  UsageError,
  writeOutput,
} from '../shared';

export const generateCommand = defineCommand({
  meta: {
    name: 'generate',
    description:
      'Write (or preview) the contracts of every workflow and local action, or of the given ones, into .github/flowpact/',
  },
  args: {
    paths: {
      type: 'positional',
      description:
        'Workflow/action files or directories whose contracts to write (default: all); contracts that list them as a consumer are updated too',
      required: false,
    },
    ...commonArgs,
    'dry-run': {
      type: 'boolean',
      description: 'Show what would change (with a diff) without writing anything',
    },
    patch: {
      type: 'string',
      description: 'Write the changes as a `git apply`-able patch instead of applying them',
      valueHint: 'file',
    },
    out: {
      type: 'string',
      description: 'Write all contracts under this directory instead of the repository',
      valueHint: 'dir',
    },
  },
  run: ({ args, rawArgs }) =>
    guard(async () => {
      const ctx = createContext(args, rawArgs);
      printBanner(ctx, `root ${displayPath(ctx.root)}`);
      const paths = pathArgs(args._, 'generate', ctx.root);
      const result = await runAnalysis(ctx, { paths, only: [], validateSchema: false });
      checkTargets(result.project, paths, ctx.root);
      if (result.summary.workflows === 0 && result.summary.actions === 0) {
        throw new UsageError(
          `No workflows found under ${displayPath(ctx.root)}/.github/workflows. Use --root to point at a repository.`,
        );
      }
      let plan = ctx.logger.time('plan contracts', () =>
        planContracts(result.index, nodeFileSystem(ctx.root)),
      );
      // With paths: their contracts, and the contracts that list them as a consumer (what `check` with the same
      // paths compares); other contracts, orphans included, are left alone.
      if (result.project.targets.size > 0) plan = scopePlan(plan, contractsInScope(result.index));
      const dryRun = Boolean(args['dry-run']);
      const out = args.out ? resolve(process.cwd(), args.out) : undefined;
      // Write first, so the summary never claims files that were refused.
      const written = dryRun || args.patch ? [] : writeContracts(ctx.root, plan, out);
      ctx.stdout(renderContractPlan(plan, ctx.render, { applied: !dryRun && !args.patch }));
      if (dryRun) {
        if (plan.drift) ctx.stdout(renderPatch(contractPatch(plan), ctx.render));
        return EXIT.ok;
      }
      if (args.patch) {
        writeOutput(args.patch, contractPatch(plan), ctx);
        return EXIT.ok;
      }
      ctx.logger.info(`wrote ${written.length} contract file(s)`, { files: written });
      if (plan.skipped.length) {
        // Their locked contracts were kept; regenerating from a broken file would erase the interface.
        ctx.stderr(
          `Not regenerated (YAML syntax errors — run \`flowpact lint\`): ${plan.skipped.join(', ')}`,
        );
        return EXIT.findings;
      }
      return EXIT.ok;
    }),
});
