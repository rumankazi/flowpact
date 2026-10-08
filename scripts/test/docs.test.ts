import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRegistry, DOCS_BASE_URL } from '@flowpact/core';
import { describe, expect, it } from 'vitest';
import { indexPage, rulePage } from '../gen-rule-docs';

const RULES_DIR = join(import.meta.dirname, '../../apps/docs/content/docs/rules');
const registry = createRegistry();

describe('rule docs', () => {
  const pages = readdirSync(RULES_DIR).filter((f) => /^fp\d{3}\.mdx$/.test(f));

  it('has a page for every registered rule and a rule for every page', () => {
    expect(pages.sort()).toEqual(
      registry
        .all()
        .map((r) => `${r.code.toLowerCase()}.mdx`)
        .sort(),
    );
  });

  it('pages are up to date with the rule definitions (run `pnpm docs:gen`)', () => {
    for (const rule of registry.all()) {
      expect(readFileSync(join(RULES_DIR, `${rule.code.toLowerCase()}.mdx`), 'utf8')).toBe(rulePage(rule));
    }
    expect(readFileSync(join(RULES_DIR, 'index.mdx'), 'utf8')).toBe(indexPage(registry.all()));
  });

  it('every docs URL printed by the tool maps to a docs page route', () => {
    for (const rule of registry.all()) {
      const url = registry.docsUrl(rule);
      expect(url.startsWith(`${DOCS_BASE_URL}/docs/rules/`)).toBe(true);
      const slug = url.slice(`${DOCS_BASE_URL}/docs/`.length);
      expect(existsSync(join(RULES_DIR, '..', `${slug}.mdx`))).toBe(true);
    }
  });

  it('published schemas match the code', async () => {
    const { configJsonSchema, contractJsonSchema, reportJsonSchema } = await import('@flowpact/core');
    const pub = (n: string) =>
      JSON.parse(
        readFileSync(join(import.meta.dirname, `../../apps/docs/public/schemas/${n}/v1.json`), 'utf8'),
      );
    expect(pub('config')).toEqual(JSON.parse(JSON.stringify(configJsonSchema())));
    expect(pub('report')).toEqual(JSON.parse(JSON.stringify(reportJsonSchema())));
    expect(pub('contract')).toEqual(JSON.parse(JSON.stringify(contractJsonSchema())));
  });
});

describe('rule counts in prose', () => {
  it('match the registry everywhere they are stated', () => {
    const n = createRegistry().all().length;
    const files = [
      'README.md',
      ...['index', 'how-it-works', 'roadmap'].map((p) => `apps/docs/content/docs/${p}.mdx`),
    ];
    for (const f of files) {
      const text = readFileSync(join(import.meta.dirname, '../..', f), 'utf8');
      for (const m of text.matchAll(/\b(\d+) rules\b/g))
        expect({ file: f, count: Number(m[1]) }).toEqual({ file: f, count: n });
    }
  });
});
