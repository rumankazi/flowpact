import { analyze, memoryFileSystem, parseConfig, SymbolLocator } from '@flowpact/core';
import { describe, expect, it } from 'vitest';
import { hoverMarkdown } from '../src/hover';

const ROOT = '.github/workflows/root.yml';
const MID = '.github/workflows/mid.yml';
const BUILD = '.github/actions/build/action.yml';

const files: Record<string, string> = {
  [ROOT]: `on:
  workflow_dispatch:
    inputs:
      level:
        type: choice
        options: [low, high]
        default: low
        description: Use *care* [here]
jobs:
  mid:
    uses: ./.github/workflows/mid.yml
    with:
      cfg: x
    secrets:
      TOKEN: \${{ secrets.DEPLOY_TOKEN }}
  after:
    needs: [mid]
    name: After \${{ inputs.level }}
    runs-on: ubuntu-latest
    strategy:
      matrix:
        n: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]
    env:
      MODE: fast
    steps:
      - id: co
        uses: actions/checkout@v4
      - id: build
        uses: ./.github/actions/build
      - id: sh
        run: echo "v=1" >> "$GITHUB_OUTPUT"
      - run: echo \${{ needs.mid.outputs.result }} \${{ steps.sh.outputs.v }} \${{ steps.co.outputs.ref }} \${{ env.MODE }} \${{ vars.REGION }} \${{ matrix.n }} \${{ steps.build.outputs.artifact }}
  dyn:
    runs-on: x
    strategy:
      matrix: \${{ fromJSON('{"k":[1]}') }}
    steps:
      - run: echo \${{ needs.mid.result }}
  remote:
    uses: acme/shared/.github/workflows/deploy.yml@v1
`,
  [MID]: `on:
  workflow_call:
    inputs:
      cfg: { type: string, required: true }
    secrets:
      TOKEN: { required: true, description: Deploys }
    outputs:
      result:
        description: The result
        value: \${{ jobs.leaf.outputs.r }}
jobs:
  leaf:
    runs-on: x
    outputs:
      r: \${{ steps.s.outputs.r }}
    steps:
      - id: s
        run: echo "r=\${{ inputs.cfg }}\${{ secrets.TOKEN }}" >> $GITHUB_OUTPUT
`,
  [BUILD]: `name: build
outputs:
  artifact:
    value: x
runs:
  using: composite
  steps: []
`,
};

const locator = new SymbolLocator(
  analyze({
    root: '/virtual/repo',
    fs: memoryFileSystem(files),
    config: parseConfig({}),
    validateSchema: false,
    repository: 'acme/repo',
  }).index,
);

/** Hover text at the first occurrence of `needle` (moved right by `offset`). */
function hover(file: string, needle: string, offset = 0): string {
  const text = files[file]!;
  const i = text.indexOf(needle);
  if (i < 0) throw new Error(`${needle} not found`);
  const before = text.slice(0, i + offset).split('\n');
  const at = locator.at(file, before.length, before.at(-1)!.length + 1);
  if (!at) throw new Error(`no symbol at ${needle}`);
  return hoverMarkdown(locator, at);
}

describe('hoverMarkdown', () => {
  it('describes inputs, escaping their descriptions', () => {
    const text = hover(ROOT, 'inputs.level', 7);
    expect(text).toContain('type `choice` · optional · default `low` · one of `low`, `high`');
    expect(text).toContain('Use \\*care\\* \\[here\\]');
    expect(text).toMatch(/\*\*Flows to\*\*\n\n- job name in `jobs.after › name`/);
  });

  it('describes secrets and outputs declared by the callee', () => {
    expect(hover(ROOT, 'TOKEN:')).toContain('required\n\nDeploys');
    const output = hover(ROOT, 'needs.mid.outputs.result', 20);
    expect(output).toContain('`jobs.mid.outputs.result` — job output in `.github/workflows/root.yml`');
    expect(output).toContain('The result\nvalue `${{ jobs.leaf.outputs.r }}`');
    expect(output).toContain('Declared in `.github/workflows/mid.yml`.');
    expect(output).toMatch(/\*\*Comes from\*\*\n\n- `mid.yml#outputs.result`/);
  });

  it('describes step outputs that nothing declares', () => {
    expect(hover(ROOT, 'steps.sh.outputs.v')).toContain('Outputs written by the step’s script.');
    expect(hover(ROOT, 'steps.co.outputs.ref')).toContain(
      'Outputs of `actions/checkout@v4`; not declared, so not verified.',
    );
    expect(hover(ROOT, 'steps.build.outputs.artifact')).toContain('value `x`');
  });

  it('describes jobs, env, matrix keys and units', () => {
    expect(hover(ROOT, 'needs.mid.result')).toContain('calls `./.github/workflows/mid.yml`');
    expect(hover(ROOT, '[mid]', 1)).toContain('`jobs.mid` — job');
    expect(hover(ROOT, 'env.MODE')).toContain('value `fast`');
    expect(hover(ROOT, 'matrix.n')).toContain('values `1`, `2`, `3`');
    expect(hover(ROOT, '  after:', 2)).toContain('needs `mid` · 14 matrix combinations');
    expect(hover(ROOT, '  dyn:', 2)).toContain('matrix computed at runtime');
    expect(hover(ROOT, './.github/workflows/mid.yml')).toContain('on `workflow_call` · called by 1 job');
    expect(hover(ROOT, './.github/actions/build')).toContain('name `build` · used by 1 step');
  });

  it('caps long traces', () => {
    expect(hover(ROOT, 'matrix.n')).toMatch(/- … 2 more \(see `flowpact trace`\)/);
  });

  it('explains values declared outside the analyzed files', () => {
    expect(hover(ROOT, 'vars.REGION')).toContain(
      'Set in the repository, environment or organization settings',
    );
    expect(hover(ROOT, 'acme/shared')).toContain('In another repository; its interface is not verified.');
    expect(hover(ROOT, 'secrets.DEPLOY_TOKEN')).toContain('Not declared in any file flowpact analyzes.');
  });
});
