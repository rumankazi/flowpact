import { didYouMean, resolveSeverities } from '@flowpact/core';
import { renderExplain } from '@flowpact/reporters';
import { defineCommand } from 'citty';
import { loadRegistry } from '../analysis';
import { commonArgs, createContext, EXIT, guard, UsageError } from '../shared';

export const explainCommand = defineCommand({
  meta: {
    name: 'explain',
    description: 'Explain a rule: why it matters, how to fix it, examples and docs link',
  },
  args: {
    code: {
      type: 'positional',
      required: true,
      description: 'Rule code or name, e.g. FP401 or empty-binding-for-matrix-combo',
    },
    ...commonArgs,
  },
  run: ({ args, rawArgs }) =>
    guard(async () => {
      const ctx = createContext(args, rawArgs);
      const registry = await loadRegistry(ctx);
      const rule = registry.get(args.code);
      if (!rule) {
        const guess = didYouMean(
          args.code,
          registry.all().flatMap((r) => [r.code, r.name]),
        );
        throw new UsageError(
          `Unknown rule "${args.code}".${guess ? ` Did you mean ${guess}?` : ''} Run \`flowpact rules\` for the list.`,
        );
      }
      const severity = resolveSeverities(registry, ctx.loaded.config).get(rule.code) ?? rule.defaultSeverity;
      ctx.stdout(renderExplain(rule, registry.docsUrl(rule), severity, ctx.render));
      return EXIT.ok;
    }),
});
