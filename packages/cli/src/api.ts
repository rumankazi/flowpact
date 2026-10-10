/**
 * The flowpact package's programmatic API (`import { lint } from 'flowpact'`): one function per CLI command, built on
 * the same code as the commands (src/lib). Its types are the hand-written ../api.d.ts, which the build copies to
 * dist/api.d.ts; each export here is typed with them, so the type check fails when the two disagree.
 */
import { VERSION as ENGINE_VERSION } from '@flowpact/core';
import type * as Api from '../api';
import { FlowpactError as FlowpactErrorClass } from './lib/errors';
import { runGenerate } from './lib/generate';
import { callGraph, explainRule, listRules, traceSymbol } from './lib/inspect';
import { type ReportCommand, runReport } from './lib/report';
import { openSession } from './lib/session';

export const VERSION: typeof Api.VERSION = ENGINE_VERSION;

export const FlowpactError: typeof Api.FlowpactError = FlowpactErrorClass;

async function report(command: ReportCommand, options: Api.LintOptions | Api.ImpactOptions = {}) {
  // Without hooks, nothing stops the run before the analysis.
  return (await runReport(openSession(options), command, options))!;
}

export const lint: typeof Api.lint = (options) => report('lint', options);

export const check: typeof Api.check = (options) => report('check', options);

export const impact: typeof Api.impact = (options) => report('impact', options);

export const generate: typeof Api.generate = async (options = {}) =>
  runGenerate(openSession(options), options);

export const graph: typeof Api.graph = async (options = {}) => callGraph(openSession(options));

export const trace: typeof Api.trace = async (options) =>
  (await traceSymbol(openSession(options), options)).result;

export const rules: typeof Api.rules = async (options = {}) => listRules(openSession(options));

export const explain: typeof Api.explain = async (codeOrName, options = {}) =>
  explainRule(openSession(options), codeOrName);

/** Returns the rule as is: it only gives a plugin rule written in TypeScript its type. */
export const defineRule: typeof Api.defineRule = (rule) => rule;
