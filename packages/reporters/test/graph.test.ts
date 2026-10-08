import { fileURLToPath } from 'node:url';
import { analyze } from '@wfc/core';
import {
  buildCallGraph,
  edgeLabel,
  type RenderOptions,
  renderDot,
  renderGraphTree,
  renderMermaid,
} from '@wfc/reporters';
import { describe, expect, it } from 'vitest';

const FIXTURES = fileURLToPath(new URL('../../../fixtures/', import.meta.url));
const plain: RenderOptions = { color: false, width: 100, hyperlinks: false };
const graphOf = (name: string) =>
  buildCallGraph(
    analyze({ root: `${FIXTURES}${name}`, repository: 'acme/fixtures', validateSchema: false }).index,
  );

describe('buildCallGraph', () => {
  it('links nested reusable workflows with job labels and secrets: inherit', () => {
    const g = graphOf('deep-nesting');
    expect(g.nodes.every((n) => n.kind === 'workflow')).toBe(true);
    expect(g.nodes.find((n) => n.id === '.github/workflows/pipeline.yml')).toMatchObject({
      label: 'Pipeline',
      triggers: ['workflow_dispatch'],
    });
    expect(g.edges).toContainEqual({
      from: '.github/workflows/pipeline.yml',
      to: '.github/workflows/build.yml',
      via: 'jobs.build',
      kind: 'calls',
      inherits: true,
    });
  });

  it('adds remote and missing targets for the cycles fixture', () => {
    const g = graphOf('cycles');
    expect(g.nodes.map((n) => [n.kind, n.id])).toEqual([
      ['workflow', '.github/workflows/b.yml'],
      ['workflow', '.github/workflows/c.yml'],
      ['workflow', '.github/workflows/main.yml'],
      ['remote', 'remote:octo-org/shared/.github/workflows/lint.yml@v2'],
      ['missing', '.github/workflows/does-not-exist.yml'],
    ]);
    expect(g.edges.map((e) => `${e.from} -[${e.via}]-> ${e.to}`)).toContain(
      '.github/workflows/c.yml -[jobs.back]-> .github/workflows/b.yml',
    );
  });

  it('records composite action uses from steps', () => {
    const g = graphOf('composite-actions');
    expect(g.nodes.find((n) => n.kind === 'action')?.id).toBe('.github/actions/install-tools');
    expect(g.edges).toContainEqual({
      from: '.github/workflows/build.yml',
      to: '.github/actions/install-tools',
      via: 'jobs.build › steps[2]',
      kind: 'uses',
    });
  });

  it('counts static matrix combinations on the edge', () => {
    const g = graphOf('incident-matrix');
    const e = g.edges.find((x) => x.from === '.github/workflows/tests.yml' && x.via === 'jobs.run');
    expect(e?.matrix).toBe(3);
  });

  it('is deterministic', () => {
    expect(JSON.stringify(graphOf('deep-nesting'))).toBe(JSON.stringify(graphOf('deep-nesting')));
  });
});

describe('renderGraphTree', () => {
  it('draws the tree from entry points and marks cycles and missing targets', () => {
    const out = renderGraphTree(graphOf('cycles'), plain);
    expect(out).toMatchSnapshot();
    expect(out).toContain('↻ cycle');
    expect(out).toContain('.github/workflows/does-not-exist.yml (missing)');
    expect(out.split('\n')[0]).toContain('Main');
  });

  it('renders nested workflows', () => {
    expect(renderGraphTree(graphOf('deep-nesting'), plain)).toMatchSnapshot();
  });

  it('supports ASCII-only output and color', () => {
    const ascii = renderGraphTree(graphOf('cycles'), { ...plain, ascii: true });
    expect(ascii).toMatch(/^[\x20-\x7E\n]*$/);
    expect(renderGraphTree(graphOf('cycles'), { ...plain, color: true })).toMatch(/\u001B\[/);
  });
});

describe('renderMermaid and renderDot', () => {
  it('renders a Mermaid flowchart with safe ids and classes', () => {
    const out = renderMermaid(graphOf('cycles'));
    expect(out).toMatchSnapshot();
    expect(out.startsWith('flowchart LR\n')).toBe(true);
    expect(out).not.toContain('```');
    for (const line of out.split('\n').filter((l) => /^ {2}\w+[([{]/.test(l))) {
      expect(line).toMatch(/^ {2}[A-Za-z0-9_]+[([{]/);
    }
    expect(out).toContain(':::missing');
    expect(out).toContain('classDef remote');
    expect(renderMermaid(graphOf('cycles'), { direction: 'TD' })).toMatch(/^flowchart TD/);
  });

  it('labels matrix fan-out, inherited secrets and action uses', () => {
    expect(renderMermaid(graphOf('incident-matrix'))).toContain('×3');
    expect(renderMermaid(graphOf('deep-nesting'))).toContain('jobs.build (inherit)');
    expect(renderMermaid(graphOf('composite-actions'))).toMatch(
      /-\.->\|"jobs\.build › steps\[2\]"\| act_install_tools/,
    );
  });

  it('renders a Graphviz digraph', () => {
    const out = renderDot(graphOf('cycles'));
    expect(out).toMatchSnapshot();
    expect(out).toMatch(/^digraph wfc \{\n/);
    expect(out.trimEnd().endsWith('}')).toBe(true);
  });
});

describe('calls to workflows that are not reusable (review #23)', () => {
  it('keeps the edge and marks it', async () => {
    const { analyze, memoryFileSystem } = await import('@wfc/core');
    const r = analyze({
      root: '/v',
      fs: memoryFileSystem({
        '.github/workflows/a.yml': 'on: push\njobs:\n  x:\n    uses: ./.github/workflows/b.yml\n',
        '.github/workflows/b.yml':
          'on: workflow_dispatch\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n',
      }),
      validateSchema: false,
      repository: 'a/b',
    });
    const g = buildCallGraph(r.index);
    expect(g.edges).toMatchObject([
      { from: '.github/workflows/a.yml', to: '.github/workflows/b.yml', notReusable: true },
    ]);
    expect(edgeLabel(g.edges[0]!)).toBe('jobs.x (not reusable)');
  });
});
