import { resolveSeverities } from '@flowpact/core';
import { renderRuleList } from '@flowpact/reporters';
import { type ArgsDef, defineCommand } from 'citty';
import { loadRegistry } from '../analysis';
import { commonArgs, createContext, EXIT, guard, jsonSafe, pluginArgs } from '../shared';

export const rulesCommand = defineCommand({
  meta: { name: 'rules', description: 'List every rule with its code, effective severity and summary' },
  args: {
    ...commonArgs,
    ...pluginArgs,
    format: { type: 'enum', options: ['pretty', 'json'], default: 'pretty', description: 'Output format' },
  },
  run: ({ args, rawArgs, cmd }) =>
    guard(async () => {
      const ctx = createContext(args, rawArgs, cmd.args as ArgsDef);
      const registry = await loadRegistry(ctx);
      const severities = resolveSeverities(registry, ctx.loaded.config);
      if (args.format === 'json') {
        ctx.stdout(
          jsonSafe(
            JSON.stringify(
              registry.all().map((r) => ({
                code: r.code,
                name: r.name,
                category: r.category,
                defaultSeverity: r.defaultSeverity,
                severity: severities.get(r.code),
                summary: r.docs.summary,
                docsUrl: registry.docsUrl(r),
              })),
              null,
              2,
            ),
          ),
        );
      } else {
        ctx.stdout(renderRuleList(registry, severities, ctx.render));
      }
      return EXIT.ok;
    }),
});
