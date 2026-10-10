import { jsonSafe } from '@flowpact/core';
import { renderTrace } from '@flowpact/reporters';
import { type ArgsDef, defineCommand } from 'citty';
import pc from 'picocolors';
import { FlowpactError } from '../lib/errors';
import { traceSymbol } from '../lib/inspect';
import { commonArgs, createContext, EXIT, guard, pluginArgs, printBanner, UsageError } from '../shared';

export const traceCommand = defineCommand({
  meta: {
    name: 'trace',
    description: 'Show where an input, secret or output flows to (or, with --up, where its value comes from)',
  },
  args: {
    symbol: {
      type: 'positional',
      required: true,
      description:
        'e.g. pipeline.yml#inputs.config, pipeline.yml:config, or pipeline.yml for its whole interface',
    },
    ...commonArgs,
    ...pluginArgs,
    up: { type: 'boolean', description: 'Trace upstream: who provides the value' },
    depth: { type: 'string', default: '12', description: 'Maximum depth', valueHint: 'n' },
    format: { type: 'enum', options: ['pretty', 'json'], default: 'pretty', description: 'Output format' },
  },
  run: ({ args, rawArgs, cmd }) =>
    guard(async () => {
      const ctx = createContext(args, rawArgs, cmd.args as ArgsDef);
      printBanner(ctx);
      const depth = Number(args.depth);
      if (!Number.isInteger(depth) || depth < 1)
        throw new UsageError(`--depth must be a positive integer (got ${args.depth})`);
      let traced: Awaited<ReturnType<typeof traceSymbol>>;
      try {
        traced = await traceSymbol(ctx.session, { symbol: args.symbol, up: Boolean(args.up), depth });
      } catch (err) {
        // No match: the API lists the files that have an interface to trace; suggest commands for them.
        if (!(err instanceof FlowpactError && err.kind === 'usage' && err.issues.length)) throw err;
        const c = pc.createColors(ctx.render.color);
        throw new UsageError(
          `No symbol matches "${args.symbol}".\n${c.dim('Try a workflow file (to list its interface) such as:')}\n${err.issues
            .slice(0, 8)
            .map((f) => `  flowpact trace ${f}`)
            .join('\n')}`,
        );
      }
      const { result, unit } = traced;
      if (args.format === 'json') {
        // Always the same shape, however many symbols matched.
        ctx.stdout(jsonSafe(JSON.stringify(result, null, 2)));
      } else if (unit) {
        ctx.stdout(`${unit} declares no inputs, secrets or outputs — nothing to trace.`);
      } else {
        ctx.stdout(result.traces.map((t) => renderTrace(t, result.direction, ctx.render)).join('\n\n'));
      }
      return EXIT.ok;
    }),
});
