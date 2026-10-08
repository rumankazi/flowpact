import { describe, expect, it } from 'vitest';
import { byCode, codes, lint, WF, yaml } from '../helpers';

const call = (target: string) =>
  `on: workflow_call\njobs:\n  next:\n    uses: ./.github/workflows/${target}\n`;

describe('FP601 call-cycle', () => {
  it('reports each cycle once', () => {
    const r = lint({
      [`${WF}/a.yml`]: call('b.yml').replace('workflow_call', 'push'),
      [`${WF}/b.yml`]: call('c.yml'),
      [`${WF}/c.yml`]: call('b.yml'),
    });
    expect(byCode(r, 'FP601').map((f) => f.message)).toEqual([
      'Call cycle: .github/workflows/b.yml → .github/workflows/c.yml → .github/workflows/b.yml',
    ]);
  });
});

describe('FP602 nesting-depth', () => {
  const chain = (n: number) => {
    const files: Record<string, string> = {
      [`${WF}/w1.yml`]: call('w2.yml').replace('workflow_call', 'push'),
    };
    for (let i = 2; i < n; i++) files[`${WF}/w${i}.yml`] = call(`w${i + 1}.yml`);
    files[`${WF}/w${n}.yml`] = 'on: workflow_call\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n';
    return files;
  };
  it('respects limits.nestingDepth', () => {
    expect(byCode(lint(chain(4), { config: { limits: { nestingDepth: 4 } } }), 'FP602')).toEqual([]);
    const [f] = byCode(lint(chain(5), { config: { limits: { nestingDepth: 4 } } }), 'FP602');
    expect(f?.message).toMatch(/^Call chain is 5 workflows deep \(limit 4\)/);
    expect(f?.related).toHaveLength(4);
  });
  it('defaults to 10', () => {
    expect(byCode(lint(chain(10)), 'FP602')).toEqual([]);
    expect(byCode(lint(chain(11)), 'FP602')).toHaveLength(1);
  });
});

describe('FP603 / FP606 / FP608', () => {
  const r = lint({
    [`${WF}/w.yml`]: [
      'on: push',
      'jobs:',
      '  remote:',
      '    uses: other/repo/.github/workflows/x.yml@v1',
      '  same-repo:',
      '    uses: acme/repo/.github/workflows/lib.yml@main',
      '  gone:',
      '    uses: ./.github/workflows/gone.yml',
      '  j:',
      '    needs: [remote, ghost]',
      '    runs-on: x',
      '    steps:',
      '      - uses: ./.github/actions/missing',
      '',
    ].join('\n'),
    [`${WF}/lib.yml`]: 'on: workflow_call\njobs:\n  j:\n    runs-on: x\n    steps: [{ run: x }]\n',
  });
  it('reports remote calls as unverified, but resolves same-repo references', () => {
    expect(byCode(r, 'FP603').map((f) => f.symbol)).toEqual(['remote:other/repo/.github/workflows/x.yml@v1']);
    expect(r.index.callSites.map((c) => c.callee.path)).toEqual([`${WF}/lib.yml`]);
  });
  it('reports missing local workflows and actions', () => {
    expect(byCode(r, 'FP606').map((f) => f.message)).toEqual([
      'Workflow ".github/workflows/gone.yml" does not exist',
      'Action ".github/actions/missing" does not exist',
    ]);
  });
  it('reports needs on unknown jobs', () => {
    expect(byCode(r, 'FP608')[0]?.message).toBe(
      'jobs.j needs "ghost", which is not a job in .github/workflows/w.yml (jobs: remote, same-repo, gone, j)',
    );
  });
});

describe('FP604 needs-without-data (opt-in)', () => {
  const files = {
    [`${WF}/w.yml`]:
      'on: push\njobs:\n  a:\n    runs-on: x\n    steps: [{ run: x }]\n  b:\n    needs: a\n    runs-on: x\n    steps: [{ run: x }]\n',
  };
  it('is off by default', () => expect(codes(lint(files))).not.toContain('FP604'));
  it('reports ordering-only dependencies when enabled', () => {
    expect(
      byCode(lint(files, { config: { rules: { 'needs-without-data': 'info' } } }), 'FP604'),
    ).toHaveLength(1);
  });
});

describe('FP605 large-interface / FP607 unreferenced-reusable-workflow', () => {
  const inputs = Array.from({ length: 4 }, (_, i) => `      i${i}: { type: string, default: x }`).join('\n');
  const reads = Array.from({ length: 4 }, (_, i) => `\${{ inputs.i${i} }}`).join(' ');
  const r = lint(
    {
      [`${WF}/big.yml`]: `on:\n  workflow_call:\n    inputs:\n${inputs}\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo ${reads}\n`,
    },
    { config: { limits: { maxInputs: 3 } } },
  );
  it('flags interfaces above limits.maxInputs', () => {
    expect(byCode(r, 'FP605')[0]?.message).toBe(
      '.github/workflows/big.yml declares 4 workflow_call inputs (limit 3)',
    );
  });
  it('flags call-only workflows without callers', () => {
    expect(byCode(r, 'FP607')).toHaveLength(1);
  });
});

/** A composite action with one required input and one output. */
const ACTION = yaml`
  name: a
  description: d
  inputs:
    req: { required: true, description: r }
  outputs:
    out: { description: o, value: x }
  runs:
    using: composite
    steps:
      - run: echo \${{ inputs.req }}
        shell: bash
`;
const A = '.github/actions/a/action.yml';
const messages = (r: ReturnType<typeof lint>, code: string) => byCode(r, code).map((f) => f.message);

describe('FP606 / FP610: a step’s ./ path is relative to the workspace', () => {
  it('maps ./path through a checkout of this repository at `path:`', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
        on: push
        jobs:
          j:
            runs-on: x
            steps:
              - uses: actions/checkout@v5
                with:
                  path: src/app
              - uses: ./src/app/.github/actions/a
                with:
                  req: 1
                  nope: 2
              - uses: ./src/app/.github/actions/gone
      `,
      [A]: ACTION,
    });
    expect(messages(r, 'FP102')).toEqual(['.github/actions/a has no input "nope"']);
    expect(messages(r, 'FP606')).toEqual([
      'Action ".github/actions/gone" does not exist (./src/app/.github/actions/gone is in the checkout of this repository at "src/app")',
    ]);
    expect(byCode(r, 'FP606')[0]!.related.map((x) => [x.loc.line, x.message])).toEqual([
      [6, 'checks this repository out at "src/app"'],
    ]);
    expect(codes(r)).not.toContain('FP610');
  });

  it('still reports actions missing from this repository (root checkout, or `repository:` naming it)', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
        on: push
        jobs:
          j:
            runs-on: x
            steps:
              - uses: actions/checkout@v5
              - uses: ./.github/actions/gone
              - uses: actions/checkout@v5
                with:
                  repository: Acme/Repo
                  path: ./copy/
              - uses: ./copy/.github/actions/gone-too
      `,
    });
    expect(messages(r, 'FP606')).toEqual([
      'Action ".github/actions/gone" does not exist',
      'Action ".github/actions/gone-too" does not exist (./copy/.github/actions/gone-too is in the checkout of this repository at "copy")',
    ]);
  });

  it('does not verify actions in another repository’s checkout (FP610)', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
        on: push
        jobs:
          j:
            runs-on: x
            steps:
              - uses: actions/checkout@v5
                with:
                  repository: acme/shared-actions
                  path: shared
              - uses: ./shared/setup
                with:
                  anything: 1
              - uses: actions/checkout@v5
                with:
                  repository: other/tools
              - uses: ./.github/actions/a
      `,
      [A]: ACTION,
    });
    expect(messages(r, 'FP610')).toEqual([
      '"./shared/setup" is in the checkout of acme/shared-actions at "shared"; its interface is not verified',
      '"./.github/actions/a" is in the checkout of other/tools at "."; its interface is not verified',
    ]);
    expect(byCode(r, 'FP610').map((f) => f.severity)).toEqual(['info', 'info']);
    expect(byCode(r, 'FP610')[0]!.related.map((x) => x.message)).toEqual([
      'checks out acme/shared-actions at "shared"',
    ]);
    expect(codes(r).filter((c) => /^FP(10[12]|606)$/.test(c))).toEqual([]);
    expect(r.project.workflows.get(`${WF}/w.yml`)!.jobs.j!.steps[1]!.uses?.kind).toBe('workspace-action');
  });

  it('treats a pull request’s fork as this repository', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
        on: pull_request_target
        jobs:
          j:
            runs-on: x
            steps:
              - uses: actions/checkout@v5
                with:
                  repository: \${{ github.event.pull_request.head.repo.full_name || github.repository }}
              - uses: ./.github/actions/a
      `,
      [A]: ACTION,
    });
    expect(messages(r, 'FP101')).toHaveLength(1);
    expect(codes(r)).not.toContain('FP610');
  });

  it('never reads paths outside the workspace', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
        on: push
        jobs:
          j:
            runs-on: x
            steps:
              - run: cp -r .github/actions/a ../trusted/
              - uses: ./../trusted/a
      `,
      [A]: ACTION,
    });
    expect(messages(r, 'FP610')).toEqual([
      '"./../trusted/a" points outside the workspace, so it only exists at runtime; it is not verified',
    ]);
    expect(codes(r)).not.toContain('FP606');
    expect([...r.project.actions.keys()]).toEqual(['.github/actions/a']);
  });

  it('does not report paths no checkout of this repository covers, or that an earlier step creates', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
        on: push
        jobs:
          j:
            runs-on: x
            steps:
              - uses: actions/checkout@v5
                with:
                  path: src/app
              - uses: ./tools/lint
              - uses: ./.github/actions/a
          k:
            runs-on: x
            steps:
              - uses: actions/checkout@v5
              - run: |
                  mkdir -p dist
                  cp -r tools/action ./dist/action
              - uses: ./dist/action
      `,
      [A]: ACTION,
    });
    expect(messages(r, 'FP610')).toEqual([
      '"./tools/lint" is not in this repository, and no checkout of this repository covers it; it is not verified',
      '"./dist/action" is not in this repository; an earlier step creates it, so it is not verified',
    ]);
    expect(byCode(r, 'FP610')[1]!.related.map((x) => [x.loc.line, x.message])).toEqual([
      [15, 'this step writes "dist/action"'],
    ]);
    // A path that is in this repository is still verified, as the best guess.
    expect(messages(r, 'FP101')).toHaveLength(1);
    expect(codes(r)).not.toContain('FP606');
  });

  it('does not report paths a checkout to a runtime-computed path may hold, but keeps typos in this repository’s directories', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
        on: push
        jobs:
          j:
            runs-on: x
            strategy:
              matrix:
                plugin: [a, b]
            steps:
              - uses: actions/checkout@v5
              - uses: actions/checkout@v5
                with:
                  repository: acme/\${{ matrix.plugin }}
                  path: \${{ matrix.plugin }}
              - uses: ./a/setup
              - uses: ./.github/actions/typo
      `,
      [A]: ACTION,
    });
    expect(messages(r, 'FP610')).toEqual([
      '"./a/setup" is not in this repository and may be in the checkout at "${{ matrix.plugin }}", a path computed at runtime; it is not verified',
    ]);
    expect(messages(r, 'FP606')).toEqual(['Action ".github/actions/typo" does not exist']);
  });

  it('resolves a composite action’s ./ paths in its callers’ workspaces', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
        on: push
        jobs:
          j:
            runs-on: x
            steps:
              - uses: actions/checkout@v5
                with:
                  path: src/app
              - uses: ./src/app/.github/actions/outer
              - uses: ./src/app/.github/actions/checkout-tools
              - uses: ./tools/.github/actions/a
                with:
                  req: 1
      `,
      '.github/actions/outer/action.yml': yaml`
        name: outer
        description: d
        runs:
          using: composite
          steps:
            - uses: ./src/app/.github/actions/a
              with:
                nope: 1
      `,
      // Its checkout changes the caller's workspace for the steps after it.
      '.github/actions/checkout-tools/action.yml': yaml`
        name: checkout-tools
        description: d
        runs:
          using: composite
          steps:
            - uses: actions/checkout@v5
              with:
                path: tools
      `,
      // No workflow here uses it: assume this repository at the root, so a missing action is still reported.
      '.github/actions/lonely/action.yml': yaml`
        name: lonely
        description: d
        runs:
          using: composite
          steps:
            - uses: ./.github/actions/gone
      `,
      [A]: ACTION,
    });
    expect(messages(r, 'FP102')).toEqual(['.github/actions/a has no input "nope"']);
    expect(byCode(r, 'FP102')[0]!.loc.file).toBe('.github/actions/outer/action.yml');
    expect(messages(r, 'FP606')).toEqual(['Action ".github/actions/gone" does not exist']);
    expect(codes(r)).not.toContain('FP610');
  });
});

describe('$/ self-repository references', () => {
  const r = lint({
    [`${WF}/w.yml`]: yaml`
      on: push
      jobs:
        a:
          runs-on: x
          steps:
            - uses: actions/checkout@v5
              with:
                repository: other/tools
            - id: s
              uses: $/.github/actions/a
              with:
                nope: 1
            - run: echo \${{ steps.s.outputs.missing }}
            - uses: $/.github/actions/gone
            - uses: $/.github/actions/a@v1
        b:
          uses: $/.github/workflows/lib.yml
          with:
            need: x
            bogus: 1
        c:
          needs: b
          runs-on: x
          steps:
            - run: echo \${{ needs.b.outputs.result }}
        d:
          uses: $/.github/workflows/lib.yml@main
    `,
    [`${WF}/lib.yml`]: yaml`
      on:
        workflow_call:
          inputs:
            need: { type: string, required: true }
            unread: { type: string }
          outputs:
            result: { value: x }
            ignored: { value: y }
      jobs:
        j:
          runs-on: x
          steps:
            - run: echo \${{ inputs.need }}
    `,
    [A]: ACTION,
  });

  it('verifies $/ steps and calls like local ones, whatever the workspace holds', () => {
    expect(messages(r, 'FP101')).toEqual([
      'Step s uses .github/actions/a without required input "req" — GitHub will run it with an empty value',
    ]);
    expect(messages(r, 'FP102')).toEqual([
      '.github/actions/a has no input "nope"',
      '.github/workflows/lib.yml has no input "bogus"',
    ]);
    expect(messages(r, 'FP301')).toEqual(['.github/actions/a has no output "missing"']);
    expect(codes(r)).not.toContain('FP603');
    expect(codes(r)).not.toContain('FP610');
  });

  it('reports missing targets and the @ref GitHub rejects', () => {
    expect(messages(r, 'FP606')).toEqual([
      'Action ".github/actions/gone" does not exist',
      '"$/.github/actions/a@v1" has an @ref, which GitHub rejects: `$/` always runs this repository at the running commit',
      '"$/.github/workflows/lib.yml@main" has an @ref, which GitHub rejects: `$/` always runs this repository at the running commit',
    ]);
    expect(byCode(r, 'FP606')[1]!.fix).toBe(
      'Write `$/.github/actions/a` without @v1, or reference another commit as owner/repo/path@ref.',
    );
  });

  it('counts $/ callers and users wherever callers count', () => {
    expect(codes(r)).not.toContain('FP607');
    expect(messages(r, 'FP104')).toEqual(['Input "unread" of .github/workflows/lib.yml is never read']);
    expect(messages(r, 'FP303')).toEqual([
      'Output "out" of .github/actions/a is not read by any of its 1 user',
      'Workflow output "ignored" of .github/workflows/lib.yml is not read by any of its 1 caller',
    ]);
    expect(r.index.callersOf(`${WF}/lib.yml`).map((c) => c.job.id)).toEqual(['b']);
    expect(r.index.usersOf('.github/actions/a').map((u) => u.step.id)).toEqual(['s']);
  });
});
