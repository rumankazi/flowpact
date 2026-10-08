import { resolve } from 'node:path';
import { contractPatch, nodeFileSystem, planContracts, writeContracts } from '@wfc/core';
import { renderContractPlan, renderPatch } from '@wfc/reporters';
import { defineCommand } from 'citty';
import { runAnalysis } from '../analysis';
import {
  commonArgs,
  createContext,
  displayPath,
  EXIT,
  guard,
  printBanner,
  UsageError,
  writeOutput,
} from '../shared';

export const generateCommand = defineCommand({
  meta: {
    name: 'generate',
    description:
      'Write (or preview) the contracts for every workflow and local action into .github/workflow-contracts/',
  },
  args: {
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
      const result = await runAnalysis(ctx, { only: [], validateSchema: false });
      if (result.summary.workflows === 0 && result.summary.actions === 0) {
        throw new UsageError(
          `No workflows found under ${displayPath(ctx.root)}/.github/workflows. Use --root to point at a repository.`,
        );
      }
      const plan = ctx.logger.time('plan contracts', () =>
        planContracts(result.index, nodeFileSystem(ctx.root)),
      );
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
        ctx.stderr(`Not regenerated (YAML syntax errors — run \`wfc lint\`): ${plan.skipped.join(', ')}`);
        return EXIT.findings;
      }
      return EXIT.ok;
    }),
});
