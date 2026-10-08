import { fileURLToPath } from 'node:url';
import {
  type AnalysisResult,
  analyze,
  createRegistry,
  defineRule,
  memoryFileSystem,
  parseConfig,
  VERSION,
} from '@wfc/core';
import { renderSarif } from '@wfc/reporters';
import { describe, expect, it } from 'vitest';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
const fixture = (name: string) => analyze({ root: `${FIXTURES}${name}`, repository: 'acme/fixtures' });

// biome-ignore lint/suspicious/noExplicitAny: SARIF is checked structurally
type Sarif = any;
const parse = (r: AnalysisResult): Sarif => JSON.parse(renderSarif(r));

describe('renderSarif', () => {
  it('emits SARIF 2.1.0 with tool metadata', () => {
    const out = renderSarif(fixture('incident-matrix'));
    expect(out.endsWith('}\n')).toBe(true);
    const sarif = JSON.parse(out);
    expect(sarif.$schema).toBe('https://json.schemastore.org/sarif-2.1.0.json');
    expect(sarif.version).toBe('2.1.0');
    expect(sarif.runs).toHaveLength(1);
    expect(sarif.runs[0].tool.driver).toMatchObject({
      name: 'wfc',
      version: VERSION,
      semanticVersion: VERSION,
      informationUri: 'https://rumankazi.github.io/wfc',
    });
  });

  it('lists every enabled rule with docs, help and default level', () => {
    const r = fixture('deep-nesting');
    const rules = parse(r).runs[0].tool.driver.rules;
    const enabled = r.rules.filter((x) => x.severity !== 'off');
    expect(rules.map((x: Sarif) => x.id)).toEqual(enabled.map((x) => x.code).sort());
    const wfc101 = rules.find((x: Sarif) => x.id === 'WFC101');
    const def = createRegistry().get('WFC101')!;
    expect(wfc101).toMatchObject({
      name: 'missing-required-input',
      shortDescription: { text: def.docs.summary },
      helpUri: 'https://rumankazi.github.io/wfc/docs/rules/wfc101',
      defaultConfiguration: { level: 'error' },
      properties: { tags: ['inputs'] },
    });
    expect(wfc101.help.text).toContain(def.docs.why);
    expect(wfc101.help.markdown).toContain(`**Fix:** ${def.docs.fix}`);
    for (const rule of rules) expect(['error', 'warning', 'note']).toContain(rule.defaultConfiguration.level);
  });

  it('maps results to rules, levels, locations and fingerprints', () => {
    const r = fixture('deep-nesting');
    const run = parse(r).runs[0];
    const ids = run.tool.driver.rules.map((x: Sarif) => x.id);
    expect(run.results).toHaveLength(r.findings.length);
    const level = { error: 'error', warning: 'warning', info: 'note' } as const;
    run.results.forEach((res: Sarif, i: number) => {
      const f = r.findings[i]!;
      expect(ids).toContain(res.ruleId);
      expect(ids[res.ruleIndex]).toBe(res.ruleId);
      expect(res.level).toBe(level[f.severity]);
      expect(res.message.text).toBe(f.message);
      expect(res.partialFingerprints['wfc/v1']).toBe(f.fingerprint);
      expect(res.locations[0].physicalLocation).toEqual({
        artifactLocation: { uri: f.loc.file, uriBaseId: '%SRCROOT%' },
        region: {
          startLine: f.loc.line,
          startColumn: f.loc.column,
          endLine: f.loc.endLine,
          endColumn: f.loc.endColumn,
        },
      });
      expect(res.suppressions).toBeUndefined();
    });
    expect(run.results.map((x: Sarif) => x.level)).toEqual(
      expect.arrayContaining(['error', 'warning', 'note']),
    );
    const withRelated = run.results.find((x: Sarif) => x.relatedLocations);
    expect(withRelated.relatedLocations[0]).toMatchObject({ id: 0, message: { text: expect.any(String) } });
  });

  it('carries matrix combinations and symbols as properties', () => {
    const res = parse(fixture('incident-matrix')).runs[0].results[0];
    expect(res.properties.combos).toEqual(['{ name: windows }']);
    expect(res.properties.symbol).toEqual(expect.any(String));
  });

  it('includes suppressed findings with an external suppression', () => {
    const r = analyze({
      root: '/virtual/repo',
      fs: memoryFileSystem({
        '.github/workflows/ci.yml':
          'on:\n  workflow_dispatch:\n    inputs:\n      legacy:\n        type: string\njobs:\n  a:\n    runs-on: ubuntu-latest\n    steps:\n      - run: echo hi\n',
      }),
      validateSchema: false,
      config: parseConfig({
        overrides: [
          { rule: 'WFC104', file: '.github/workflows/ci.yml', reason: 'Still read by an external script' },
        ],
      }),
    });
    expect(r.suppressed).toHaveLength(1);
    const run = parse(r).runs[0];
    const suppressed = run.results.filter((x: Sarif) => x.suppressions);
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]).toMatchObject({
      ruleId: 'WFC104',
      suppressions: [{ kind: 'external', justification: 'Still read by an external script' }],
    });
    expect(run.tool.driver.rules.map((x: Sarif) => x.id)).toContain('WFC104');
  });

  it('falls back to finding docs for plugin rules', () => {
    const registry = createRegistry().register(
      defineRule({
        code: 'ACME601',
        name: 'acme-check',
        category: 'structure',
        defaultSeverity: 'warning',
        docsUrl: 'https://example.com/acme601',
        docs: { summary: 'Acme check', why: 'Because acme.', fix: 'Do the acme thing.' },
        check(ctx) {
          const wf = ctx.index.project.workflows.get('.github/workflows/ci.yml')!;
          ctx.report({
            message: 'acme',
            loc: { file: wf.path, line: 1, column: 1, endLine: 1, endColumn: 2 },
          });
        },
      }),
    );
    const r = analyze({
      root: '/virtual/repo',
      fs: memoryFileSystem({
        '.github/workflows/ci.yml': 'on: push\njobs:\n  a:\n    runs-on: x\n    steps:\n      - run: echo\n',
      }),
      validateSchema: false,
      registry,
    });
    const run = parse(r).runs[0];
    const rule = run.tool.driver.rules.find((x: Sarif) => x.id === 'ACME601');
    expect(rule).toMatchObject({
      name: 'acme-check',
      helpUri: 'https://example.com/acme601',
      defaultConfiguration: { level: 'warning' },
    });
    expect(rule.help.text).toContain('Do the acme thing.');
    expect(run.results.find((x: Sarif) => x.ruleId === 'ACME601').level).toBe('warning');
  });
});
