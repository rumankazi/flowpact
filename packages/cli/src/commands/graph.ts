import { jsonSafe } from '@flowpact/core';
import { renderDot, renderGraphTree, renderMermaid } from '@flowpact/reporters';
import { type ArgsDef, defineCommand } from 'citty';
import { callGraph } from '../lib/inspect';
import { commonArgs, createContext, displayPath, EXIT, guard, printBanner } from '../shared';

export const graphCommand = defineCommand({
  meta: {
    name: 'graph',
    description: 'Show which workflows call which reusable workflows and local actions',
  },
  args: {
    ...commonArgs,
    format: {
      type: 'enum',
      options: ['tree', 'mermaid', 'dot', 'json'],
      default: 'tree',
      description: 'tree (terminal), mermaid (Markdown diagrams), dot (Graphviz) or json',
    },
  },
  run: ({ args, rawArgs, cmd }) =>
    guard(async () => {
      const ctx = createContext(args, rawArgs, cmd.args as ArgsDef);
      printBanner(ctx, `root ${displayPath(ctx.root)}`);
      const graph = await callGraph(ctx.session);
      switch (args.format) {
        case 'mermaid':
          ctx.stdout(renderMermaid(graph));
          break;
        case 'dot':
          ctx.stdout(renderDot(graph));
          break;
        case 'json':
          ctx.stdout(jsonSafe(JSON.stringify(graph, null, 2)));
          break;
        default:
          ctx.stdout(renderGraphTree(graph, ctx.render));
      }
      return EXIT.ok;
    }),
});
