import { renderExplain } from '@flowpact/reporters';
import { type ArgsDef, defineCommand } from 'citty';
import { FlowpactError } from '../lib/errors';
import { explainRule } from '../lib/inspect';
import { commonArgs, createContext, EXIT, guard, pluginArgs, UsageError } from '../shared';

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
    ...pluginArgs,
  },
  run: ({ args, rawArgs, cmd }) =>
    guard(async () => {
      const ctx = createContext(args, rawArgs, cmd.args as ArgsDef);
      let rule: Awaited<ReturnType<typeof explainRule>>;
      try {
        rule = await explainRule(ctx.session, args.code);
      } catch (err) {
        // An unknown rule: point at the list.
        if (err instanceof FlowpactError && err.kind === 'usage')
          throw new UsageError(`${err.message} Run \`flowpact rules\` for the list.`);
        throw err;
      }
      const { summary, why, fix, scope, examples } = rule;
      ctx.stdout(
        renderExplain(
          {
            code: rule.code,
            name: rule.name,
            category: rule.category,
            defaultSeverity: rule.defaultSeverity,
            generatedFiles: rule.generatedFiles,
            docs: {
              summary,
              why,
              fix,
              ...(scope !== undefined ? { scope } : {}),
              ...(examples ? { examples } : {}),
            },
          },
          rule.docsUrl,
          rule.severity,
          ctx.render,
        ),
      );
      return EXIT.ok;
    }),
});
