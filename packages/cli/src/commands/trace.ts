import { resolveSymbols, type TraceDirection, trace } from '@flowpact/core';
import { renderTrace } from '@flowpact/reporters';
import { defineCommand } from 'citty';
import pc from 'picocolors';
import { runAnalysis } from '../analysis';
import { commonArgs, createContext, EXIT, guard, printBanner, UsageError } from '../shared';

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
    up: { type: 'boolean', description: 'Trace upstream: who provides the value' },
    depth: { type: 'string', default: '12', description: 'Maximum depth', valueHint: 'n' },
    format: { type: 'enum', options: ['pretty', 'json'], default: 'pretty', description: 'Output format' },
  },
  run: ({ args, rawArgs }) =>
    guard(async () => {
      const ctx = createContext(args, rawArgs);
      printBanner(ctx);
      const depth = Number(args.depth);
      if (!Number.isInteger(depth) || depth < 1)
        throw new UsageError(`--depth must be a positive integer (got ${args.depth})`);
      const result = await runAnalysis(ctx, { validateSchema: false, only: [] });
      const matches = resolveSymbols(result.index, args.symbol);
      if (matches.length === 0) {
        const unit = result.index
          .units()
          .find((u) => u.path === args.symbol || u.path.endsWith(`/${args.symbol}`));
        const direction: TraceDirection = args.up ? 'up' : 'down';
        if (unit) {
          if (args.format === 'json')
            ctx.stdout(JSON.stringify({ query: args.symbol, direction, traces: [] }, null, 2));
          else ctx.stdout(`${unit.path} declares no inputs, secrets or outputs — nothing to trace.`);
          return EXIT.ok;
        }
        const c = pc.createColors(ctx.render.color);
        const traceable = new Set(
          [...result.index.nodes.values()]
            .filter((n) => ['input', 'secret', 'output'].includes(n.kind))
            .map((n) => n.unit),
        );
        const files = [...result.project.workflows.keys(), ...result.project.actions.keys()].filter((f) =>
          traceable.has(f),
        );
        throw new UsageError(
          files.length
            ? `No symbol matches "${args.symbol}".\n${c.dim('Try a workflow file (to list its interface) such as:')}\n${files
                .slice(0, 8)
                .map((f) => `  flowpact trace ${f}`)
                .join('\n')}`
            : `No symbol matches "${args.symbol}", and no workflow or action here declares inputs, secrets or outputs.`,
        );
      }
      const direction: TraceDirection = args.up ? 'up' : 'down';
      const trees = matches.map((m) => trace(result.index, m.id, { direction, maxDepth: depth }));
      if (args.format === 'json') {
        // Always the same shape, however many symbols matched.
        ctx.stdout(JSON.stringify({ query: args.symbol, direction, traces: trees }, null, 2));
      } else {
        ctx.stdout(trees.map((t) => renderTrace(t, direction, ctx.render)).join('\n\n'));
      }
      return EXIT.ok;
    }),
});
