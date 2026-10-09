import {
  type AnalysisResult,
  type AnalyzeOptions,
  analyze,
  createRegistry,
  loadPlugins,
  type RuleRegistry,
} from '@flowpact/core';
import type { CliContext } from './shared';

/** Built-in rules, the plugins listed in the config (unless `--no-plugins`) and those given with `--plugin`. */
export async function loadRegistry(ctx: CliContext): Promise<RuleRegistry> {
  const registry = createRegistry();
  if (ctx.plugins.config) await loadPlugins(ctx.root, ctx.loaded.config, registry, ctx.logger);
  else if (ctx.loaded.config.plugins.length)
    ctx.logger.warn(
      `not loading ${ctx.loaded.config.plugins.length} plugin(s) from the config (--no-plugins)`,
    );
  if (ctx.plugins.extra.length)
    await loadPlugins(ctx.root, { ...ctx.loaded.config, plugins: ctx.plugins.extra }, registry, ctx.logger);
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
    ...(process.env.FLOWPACT_NOW ? { now: new Date(process.env.FLOWPACT_NOW) } : {}),
    ...opts,
  });
}
