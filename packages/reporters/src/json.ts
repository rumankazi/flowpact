import { type AnalysisResult, toJsonReport } from '@flowpact/core';

export function renderJson(result: AnalysisResult, opts: { includeGraph?: boolean } = {}): string {
  return `${JSON.stringify(toJsonReport(result, opts), null, 2)}\n`;
}
