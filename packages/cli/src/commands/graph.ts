import { analyze } from '@flowpact/core';
import { buildCallGraph, renderDot, renderGraphTree, renderMermaid } from '@flowpact/reporters';
import { type ArgsDef, defineCommand } from 'citty';
import {
  commonArgs,
  createContext,
  displayPath,
  EXIT,
  guard,
  jsonSafe,
  printBanner,
  UsageError,
} from '../shared';

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
    guard(() => {
      const ctx = createContext(args, rawArgs, cmd.args as ArgsDef);
      printBanner(ctx, `root ${displayPath(ctx.root)}`);
      const result = analyze({
        root: ctx.root,
        config: ctx.loaded.config,
        logger: ctx.logger,
        validateSchema: false,
        only: [],
      });
      if (result.summary.workflows === 0 && result.summary.actions === 0) {
        throw new UsageError(
          `No workflows found under ${displayPath(ctx.root)}/.github/workflows. Use --root to point at a repository.`,
        );
      }
      const graph = buildCallGraph(result.index);
      ctx.logger.debug('call graph', { nodes: graph.nodes.length, edges: graph.edges.length });
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
