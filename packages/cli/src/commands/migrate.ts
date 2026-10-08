import { applyMigration, planMigration } from '@flowpact/core';
import { defineCommand } from 'citty';
import pc from 'picocolors';
import { commonArgs, createContext, displayPath, EXIT, guard, printBanner, UsageError } from '../shared';

export const migrateCommand = defineCommand({
  meta: {
    name: 'migrate',
    description:
      'Move files from wfc (before 0.2.0) to flowpact: .github/workflow-contracts/ → .github/flowpact/, WFC rule codes → FP',
  },
  args: {
    ...commonArgs,
    'dry-run': {
      type: 'boolean',
      description: 'Show what would move without changing anything',
    },
  },
  run: ({ args, rawArgs }) =>
    guard(async () => {
      const ctx = createContext(args, rawArgs);
      printBanner(ctx, `root ${displayPath(ctx.root)}`);
      let plan: ReturnType<typeof planMigration>;
      try {
        plan = planMigration(ctx.root);
      } catch (err) {
        throw new UsageError((err as Error).message);
      }
      const c = pc.createColors(ctx.render.color);
      if (plan.moves.length === 0 && plan.leftovers.length === 0) {
        ctx.stdout('Nothing to migrate: no .github/workflow-contracts/ config or contracts found.');
        return EXIT.ok;
      }
      for (const m of plan.moves) {
        const changes = m.changes.length ? c.dim(` (${m.changes.join(', ')})`) : '';
        ctx.stdout(`  ${m.from} ${c.dim('→')} ${m.to}${changes}`);
      }
      for (const l of plan.leftovers) ctx.stdout(c.yellow(`  ${l.file} ${l.reason}`));
      if (plan.conflicts.length) {
        throw new UsageError(
          `Not migrating: ${plan.conflicts.join(', ')} already exist. Remove or merge them, then run flowpact migrate again.`,
        );
      }
      if (args['dry-run']) {
        ctx.stdout(c.dim(`\n${plan.moves.length} file(s) would move. Run without --dry-run to migrate.`));
        return EXIT.ok;
      }
      applyMigration(ctx.root, plan);
      const left = plan.leftovers.length
        ? c.yellow(` ${plan.leftovers.length} file(s) left in place (see above).`)
        : '';
      ctx.stdout(
        `\n${c.green('✔')} Moved ${plan.moves.length} file(s).${left} Run ${c.bold('flowpact check')} to confirm the contracts, then commit.`,
      );
      return EXIT.ok;
    }),
});
