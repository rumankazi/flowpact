import { type AnalysisResult, jsonSafe, toJsonReport } from '@flowpact/core';

export function renderJson(result: AnalysisResult, opts: { includeGraph?: boolean } = {}): string {
  return jsonSafe(`${JSON.stringify(toJsonReport(result, opts), null, 2)}\n`);
}
