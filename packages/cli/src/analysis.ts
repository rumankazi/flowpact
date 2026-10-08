import {
  type AnalysisResult,
  type AnalyzeOptions,
  analyze,
  createRegistry,
  loadPlugins,
  type RuleRegistry,
} from '@wfc/core';
import type { CliContext } from './shared';

/** Built-in rules plus the plugins listed in the config. */
export async function loadRegistry(ctx: CliContext): Promise<RuleRegistry> {
  const registry = createRegistry();
  await loadPlugins(ctx.root, ctx.loaded.config, registry, ctx.logger);
  return registry;
}

/** Runs the analysis with everything the config asks for: plugins, overrides and their locations. */
export async function runAnalysis(
  ctx: CliContext,
  opts: Partial<AnalyzeOptions> = {},
): Promise<AnalysisResult> {
  const registry = await loadRegistry(ctx);
  return analyze({
    root: ctx.root,
    config: ctx.loaded.config,
    ...(ctx.loaded.file ? { configFile: ctx.loaded.file } : {}),
    ...(ctx.loaded.text !== undefined ? { configText: ctx.loaded.text } : {}),
    ...(ctx.loaded.overrideLocs ? { overrideLocs: ctx.loaded.overrideLocs } : {}),
    logger: ctx.logger,
    registry,
    ...(process.env.WFC_NOW ? { now: new Date(process.env.WFC_NOW) } : {}),
    ...opts,
  });
}
