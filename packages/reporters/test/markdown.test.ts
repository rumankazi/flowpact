import { fileURLToPath } from 'node:url';
import { type AnalysisResult, analyze, memoryFileSystem, parseConfig, planContracts } from '@wfc/core';
import { renderMarkdown } from '@wfc/reporters';
import { describe, expect, it } from 'vitest';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
const normalize = (r: AnalysisResult) => {
  r.durationMs = 7; // keep snapshots deterministic
  r.meta.node = 'v24.0.0';
  return r;
};
const fixture = (name: string) =>
  normalize(analyze({ root: `${FIXTURES}${name}`, repository: 'acme/fixtures' }));

const WF = '.github/workflows';
const deployV1 = `name: Deploy
on:
  workflow_call:
    inputs:
      environment:
        type: string
        required: true
      region:
        type: string
        required: false
        default: eu-west-1
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh "\${{ inputs.environment }}" "\${{ inputs.region }}"
`;
const deployV2 = `name: Deploy
on:
  workflow_call:
    inputs:
      environment:
        type: string
        required: true
      token-scope:
        type: string
        required: true
      legacy:
        type: boolean
        default: false
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - run: ./deploy.sh "\${{ inputs.environment }}" "\${{ inputs.token-scope }}"
`;
const caller = `name: Release
on: push
jobs:
  deploy:
    uses: ./.github/workflows/deploy.yml
    with:
      environment: production
      token-scope: write
`;

/** A repository whose locked contract (from deployV1) no longer matches the workflow, plus an override. */
function driftedRepo(): AnalysisResult {
  const v1 = { [`${WF}/deploy.yml`]: deployV1, [`${WF}/release.yml`]: caller };
  const index = analyze({ root: '/virtual/repo', fs: memoryFileSystem(v1), validateSchema: false }).index;
  const locked = planContracts(index, memoryFileSystem(v1)).entries;
  const files: Record<string, string> = { [`${WF}/deploy.yml`]: deployV2, [`${WF}/release.yml`]: caller };
  for (const e of locked) files[e.file] = e.after ?? '';
  return normalize(
    analyze({
      root: '/virtual/repo',
      fs: memoryFileSystem(files),
      validateSchema: false,
      repository: 'acme/repo',
      checkContracts: true,
      now: new Date('2026-01-01T00:00:00Z'),
      config: parseConfig({
        overrides: [
          {
            rule: 'unused-input',
            target: `${WF}/deploy.yml#inputs.legacy`,
            reason: 'Kept for callers on v1 | removed in v3',
            expires: '2099-01-01',
            owner: '@platform',
          },
        ],
      }),
    }),
  );
}

describe('renderMarkdown', () => {
  it('renders the incident report', () => {
    const out = renderMarkdown(fixture('incident-matrix'));
    expect(out).toMatchSnapshot();
    expect(out.startsWith('## wfc report\n')).toBe(true);
    expect(out).toContain('config schema v1 · contract schema v1 · report schema v1');
    expect(out).toContain('❌ **1 error**');
    expect(out).toContain('[`WFC401`](https://rumankazi.github.io/wfc/docs/rules/wfc401)');
    expect(out).toContain('Matrix: `{ name: windows }`');
    expect(out).toContain('<details><summary>Why / fix</summary>');
  });

  it('renders nested workflows grouped by severity, errors first', () => {
    const out = renderMarkdown(fixture('deep-nesting'));
    expect(out).toMatchSnapshot();
    const errors = out.indexOf('### ❌ Errors');
    const warnings = out.indexOf('### ⚠️ Warnings');
    expect(errors).toBeGreaterThan(0);
    if (warnings !== -1) expect(warnings).toBeGreaterThan(errors);
  });

  it('reports a clean run', () => {
    const out = renderMarkdown(fixture('clean'), { title: 'Workflow contracts' });
    expect(out).toContain('## Workflow contracts');
    expect(out).toContain('✅ **No problems found**');
    expect(out).not.toContain('### ');
  });

  it('links locations to the commit when repoUrl and sha are set', () => {
    const out = renderMarkdown(fixture('incident-matrix'), {
      repoUrl: 'https://github.com/acme/fixtures/',
      sha: 'abc123',
    });
    expect(out).toContain(
      '[`.github/workflows/tests.yml:23:19`](https://github.com/acme/fixtures/blob/abc123/.github/workflows/tests.yml#L23)',
    );
    expect(
      renderMarkdown(fixture('incident-matrix'), { repoUrl: 'https://github.com/acme/fixtures' }),
    ).not.toContain('/blob/');
  });

  it('caps the number of findings', () => {
    const r = fixture('deep-nesting');
    const out = renderMarkdown(r, { maxFindings: 1 });
    expect(out.match(/<summary>Why \/ fix<\/summary>/g)).toHaveLength(1);
    expect(out).toContain(`… ${r.findings.length - 1} more`);
  });

  it('adds the call graph as Mermaid when asked', () => {
    const out = renderMarkdown(fixture('deep-nesting'), { includeGraph: true });
    expect(out).toContain('<details><summary>Call graph</summary>\n\n```mermaid\nflowchart LR\n');
    expect(renderMarkdown(fixture('deep-nesting'))).not.toContain('```mermaid');
  });

  it('only uses self-closing or paired block HTML and escapes angle brackets outside code', () => {
    const out = renderMarkdown(fixture('incident-matrix')).replace(/`[^`\n]*`/g, '');
    const tags = out.match(/<\/?[a-z]+[^>]*>/g) ?? [];
    for (const tag of tags) expect(tag).toMatch(/^<\/?(details|summary|sub)>$|^<br\/>$/);
    expect(renderMarkdown(fixture('incident-matrix'))).toContain("`${{ matrix.config || '<default>' }}`");
  });
});

describe('renderMarkdown contracts and suppressions', () => {
  const r = driftedRepo();

  it('summarizes contract drift with breaking changes', () => {
    expect(r.contracts?.drift).toBe(true);
    const out = renderMarkdown(r);
    expect(out).toMatchSnapshot();
    expect(out).toContain('### Contracts');
    expect(out).toContain('| File | Status | Breaking |');
    expect(out).toContain('| `.github/workflow-contracts/workflows/deploy.contract.yml` | changed |');
    expect(out).not.toContain('release.contract.yml` | unchanged');
    expect(out).toMatch(/- \*\*input "region" was removed[^*]*\*\* \(breaking\)/);
    expect(out).toContain('Run `wfc generate` and commit the result');
  });

  it('explains how to apply the regenerated contracts from the artifact', () => {
    const withRun = renderMarkdown(r, { artifact: { name: 'wfc-contracts', runId: '42' } });
    expect(withRun).toContain(
      '```sh\ngh run download 42 -n wfc-contracts\ngit apply --index wfc-contracts.patch\n```',
    );
    const noRun = renderMarkdown(r, { artifact: { name: 'contracts', patchFile: 'fix.patch' } });
    expect(noRun).toContain('download the `contracts` artifact from this run');
    expect(noRun).toContain('git apply --index fix.patch');
    expect(noRun).not.toContain('gh run download');
  });

  it('lists suppressed findings in a collapsed table with escaped cells', () => {
    expect(r.suppressed).toHaveLength(1);
    const out = renderMarkdown(r);
    expect(out).toContain('<details><summary>1 suppressed finding</summary>');
    expect(out).toContain('| Code | Location | Reason | Expires | Owner |');
    expect(out).toContain('Kept for callers on v1 \\| removed in v3 | 2099-01-01 | &#64;platform |');
  });

  it('says when contracts are up to date', () => {
    const files: Record<string, string> = { [`${WF}/release.yml`]: caller, [`${WF}/deploy.yml`]: deployV1 };
    const index = analyze({ root: '/r', fs: memoryFileSystem(files), validateSchema: false }).index;
    for (const e of planContracts(index, memoryFileSystem(files)).entries) files[e.file] = e.after ?? '';
    const clean = analyze({
      root: '/r',
      fs: memoryFileSystem(files),
      validateSchema: false,
      checkContracts: true,
    });
    expect(renderMarkdown(clean)).toContain('✅ Contracts are up to date (2 files).');
  });
});

describe('markdown escaping of untrusted names', () => {
  it('does not let unbalanced backtick runs turn HTML, links or mentions live', async () => {
    const { analyze, memoryFileSystem } = await import('@wfc/core');
    const evil = "x```<a href='https://evil.example'>Click</a>`[link](https://evil.example) @team";
    const r = analyze({
      root: '/v',
      fs: memoryFileSystem({
        '.github/workflows/c.yml': `on: push\njobs:\n  call:\n    uses: ./.github/workflows/r.yml\n    with:\n      "${evil}": 1\n`,
        '.github/workflows/r.yml':
          'on:\n  workflow_call:\n    inputs:\n      a: {}\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo ${{ inputs.a }}\n',
      }),
      validateSchema: false,
      repository: 'a/b',
    });
    const out = renderMarkdown(r);
    // Raw HTML never survives; outside code spans links and mentions are escaped (inside a code span they are inert).
    expect(out).not.toContain("<a href='https://evil.example'>");
    const message = out.split('\n').find((l) => l.startsWith('.github/workflows/r.yml has no input'))!;
    expect(message).toContain('&lt;a href=');
    expect(message).toContain('\\[link\\](https://evil.example)');
    expect(message).toContain('&#64;team');
  });
});
