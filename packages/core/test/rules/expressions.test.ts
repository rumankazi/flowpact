import { describe, expect, it } from 'vitest';
import { at, byCode, codes, lint, WF, yaml } from '../helpers';

describe('FP501 undefined-env-ref', () => {
  it('resolves env through step, job and workflow scope and earlier $GITHUB_ENV writes', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
        on: push
        env:
          W: 1
        jobs:
          j:
            runs-on: x
            env:
              J: 2
            steps:
              - run: echo "E=3" >> $GITHUB_ENV
              - env:
                  S: 4
                run: echo \${{ env.W }} \${{ env.J }} \${{ env.S }} \${{ env.E }} \${{ env.NOPE }}
      `,
    });
    expect(byCode(r, 'FP501').map((f) => f.message)).toEqual(['env.NOPE is not defined in this scope']);
  });

  it('points runner variables to the matching context', () => {
    const r = lint({
      [`${WF}/w.yml`]:
        'on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: echo ${{ env.GITHUB_SHA }}\n',
    });
    const [f] = byCode(r, 'FP501');
    expect(f?.message).toContain('use github.sha');
    expect(f?.fix).toBe('Replace `env.GITHUB_SHA` with `github.sha`.');
  });

  it('gives up after steps that may export variables invisibly', () => {
    const r = lint({
      [`${WF}/w.yml`]:
        'on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - uses: some/action@v1\n      - run: echo ${{ env.FROM_ACTION }}\n',
    });
    expect(byCode(r, 'FP501')).toEqual([]);
  });
});

describe('FP502 expression-parse-error', () => {
  it('reports syntax errors at the offending token', () => {
    const r = lint({
      [`${WF}/w.yml`]:
        "on: push\njobs:\n  j:\n    if: ${{ github.ref = 'main' }}\n    runs-on: x\n    steps: [{ run: x }]\n",
    });
    const [f] = byCode(r, 'FP502');
    expect(f?.message).toBe("Invalid expression \"github.ref = 'main'\": Unexpected symbol: '='");
    expect(at(f!)).toBe(`${WF}/w.yml:4:24`);
  });
});

describe('FP503 schema-violation / FP504 yaml-syntax-error', () => {
  it('validates against GitHub’s schema when enabled', () => {
    const r = lint(
      { [`${WF}/w.yml`]: 'on: push\njobs:\n  j:\n    runs-on: x\n    stepz: []\n' },
      { schema: true },
    );
    expect(byCode(r, 'FP503')[0]?.message).toBe("Unexpected value 'stepz'");
    expect(at(byCode(r, 'FP503')[0]!)).toBe(`${WF}/w.yml:5:5`);
  });

  it('validates action files', () => {
    const r = lint({ '.github/actions/a/action.yml': 'name: a\nrunz: {}\n' }, { schema: true });
    expect(byCode(r, 'FP503').map((f) => `${f.severity} ${at(f)} ${f.message}`)).toEqual([
      'error .github/actions/a/action.yml:1:1 Required property is missing: runs',
      'warning .github/actions/a/action.yml:2:1 GitHub ignores this key: action metadata has no `runz` (did you mean `runs`?), so it has no effect',
    ]);
    expect(byCode(r, 'FP503')[1]?.fix).toBe('Rename it to `runs`.');
  });

  it('reports YAML errors once (no schema duplicate)', () => {
    const r = lint({ [`${WF}/w.yml`]: 'on: push\njobs: [a\n' }, { schema: true });
    expect(codes(r)).toContain('FP504');
    expect(codes(r)).not.toContain('FP503');
  });
});

describe('FP503 keys GitHub added after the parser’s schema', () => {
  const schema503 = (files: Record<string, string>) =>
    byCode(lint(files, { schema: true }), 'FP503').map((f) => `${f.severity} ${at(f)} ${f.message}`);

  it('accepts background, wait, wait-all, cancel and parallel steps', () => {
    expect(
      schema503({
        [`${WF}/w.yml`]: yaml`
          on: push
          jobs:
            j:
              runs-on: x
              steps:
                - id: server
                  background: true
                  run: npm start
                - id: build
                  background: true
                  uses: some/action@v1
                - wait: server
                - wait: [server, build]
                - cancel: server
                - wait-all:
                  continue-on-error: true
                - parallel:
                    - run: a
                    - uses: some/action@v1
        `,
      }),
    ).toEqual([]);
  });

  it('still rejects background steps inside a composite action', () => {
    expect(
      schema503({
        '.github/actions/a/action.yml': yaml`
          runs:
            using: composite
            steps:
              - run: npm start
                shell: bash
                background: true
        `,
      }),
    ).toEqual(["error .github/actions/a/action.yml:6:7 Unexpected value 'background'"]);
  });

  it('accepts cache-mode on the workflow, a job and a reusable-workflow call, and checks its value', () => {
    expect(
      schema503({
        [`${WF}/w.yml`]: yaml`
          on: push
          cache-mode: read
          jobs:
            a:
              runs-on: x
              cache-mode: write-only
              steps: [{ run: x }]
            b:
              uses: ./.github/workflows/r.yml
              cache-mode: none
            c:
              runs-on: x
              cache-mode: readonly
              steps: [{ run: x }]
        `,
        [`${WF}/r.yml`]:
          'on: workflow_call\njobs:\n  r:\n    runs-on: x\n    cache-mode: write\n    steps: [{ run: x }]\n',
      }),
    ).toEqual([`error ${WF}/w.yml:13:17 Unexpected value 'readonly'`]);
  });
});

describe('FP503 keys GitHub ignores', () => {
  it('warns about a composite action’s top-level env with what it costs', () => {
    const r = lint(
      {
        '.github/actions/a/action.yml': yaml`
          name: a
          description: d
          env:
            PINNED: 1.2.3
          runs:
            using: composite
            steps:
              - run: echo "\${{ env.PINNED }}"
                shell: bash
        `,
      },
      { schema: true },
    );
    const [f, ...rest] = byCode(r, 'FP503');
    expect(rest).toEqual([]);
    expect(f?.severity).toBe('warning');
    expect(at(f!)).toBe('.github/actions/a/action.yml:3:1');
    expect(f?.message).toBe(
      "GitHub ignores this key: actions have no top-level `env`, so the action's steps never see these values",
    );
    expect(f?.fix).toBe(
      'Set the variables in `env:` on the steps that read them, or declare them as inputs.',
    );
  });

  it('warns about event filters the event does not support, and suggests close names', () => {
    const r = lint(
      {
        [`${WF}/w.yml`]: yaml`
          on:
            release:
              types: [published]
              branches: [main]
            push:
              branch: main
            workflow_dispatch:
              input:
                x: { type: string }
          jobs:
            j:
              runs-on: x
              steps: [{ run: x }]
        `,
      },
      { schema: true },
    );
    expect(byCode(r, 'FP503').map((f) => `${f.severity} ${at(f)} ${f.message} | ${f.fix}`)).toEqual([
      `warning ${WF}/w.yml:4:5 GitHub ignores this key: the \`release\` event does not support \`branches\`, so the workflow runs regardless of it | Remove it, or check the condition in a job's \`if:\` instead.`,
      `warning ${WF}/w.yml:6:5 GitHub ignores this key: the \`push\` event does not support \`branch\` (did you mean \`branches\`?), so the workflow runs regardless of it | Rename it to \`branches\`.`,
      `warning ${WF}/w.yml:8:5 GitHub ignores this key: the \`workflow_dispatch\` event does not support \`input\` (did you mean \`inputs\`?), so it has no effect | Rename it to \`inputs\`.`,
    ]);
  });

  it('keeps errors for what GitHub rejects: unknown events, activity types, workflow_call keys, job keys', () => {
    const r = lint(
      {
        [`${WF}/w.yml`]: yaml`
          on:
            pull-request:
            issues:
              types: [opend]
            workflow_call:
              input: {}
          jobs:
            j:
              runs-on: x
              stepz: []
        `,
      },
      { schema: true },
    );
    expect(byCode(r, 'FP503').map((f) => `${f.severity} ${at(f)} ${f.message}`)).toEqual([
      `error ${WF}/w.yml:2:3 Unexpected value 'pull-request'`,
      `error ${WF}/w.yml:4:13 Unexpected value 'opend'`,
      `error ${WF}/w.yml:6:5 Unexpected value 'input'`,
      `error ${WF}/w.yml:10:5 Unexpected value 'stepz'`,
    ]);
  });

  it('caps the warning at the configured severity and never raises it', () => {
    const files = {
      '.github/actions/a/action.yml': 'env: {}\nrunz: {}\n',
    };
    const sev = (rules: Record<string, string>) =>
      byCode(lint(files, { schema: true, config: { rules } }), 'FP503').map((f) => f.severity);
    expect(sev({})).toEqual(['error', 'warning', 'warning']);
    expect(sev({ FP503: 'error' })).toEqual(['error', 'warning', 'warning']);
    expect(sev({ FP503: 'warning' })).toEqual(['warning', 'warning', 'warning']);
    expect(sev({ FP503: 'info' })).toEqual(['info', 'info', 'info']);
    expect(sev({ FP503: 'off' })).toEqual([]);
  });
});

describe('FP503 steps and jobs that mix two shapes', () => {
  const schema503 = (files: Record<string, string>) =>
    byCode(lint(files, { schema: true }), 'FP503').map((f) => `${f.severity} ${at(f)} ${f.message}`);

  it('reports one wrong key on a uses step once, at that key', () => {
    expect(
      schema503({
        '.github/actions/a/action.yml': yaml`
          runs:
            using: composite
            steps:
              - name: Install
                working-directory: \${{ inputs.dir }}
                uses: taiki-e/install-action@v2
                with:
                  tool: nextest
        `,
      }),
    ).toEqual([
      "error .github/actions/a/action.yml:5:7 Unexpected value 'working-directory' (not allowed together with `uses`)",
    ]);
  });

  it('reports a job that both runs steps and calls a workflow once', () => {
    expect(
      schema503({
        [`${WF}/w.yml`]: yaml`
          on: push
          jobs:
            j:
              runs-on: x
              uses: ./.github/workflows/r.yml
              with:
                a: 1
        `,
        [`${WF}/r.yml`]:
          'on:\n  workflow_call:\n    inputs:\n      a: { type: number }\njobs:\n  r:\n    runs-on: x\n    steps: [{ run: x }]\n',
      }),
    ).toEqual([`error ${WF}/w.yml:4:5 Unexpected value 'runs-on' (not allowed together with \`uses\`)`]);
  });

  it('lists every misplaced key and missing property of the closest shape', () => {
    expect(
      schema503({
        '.github/actions/a/action.yml': yaml`
          runs:
            using: composite
            steps:
              - working-directory: x
                shell: bash
                with:
                  a: 1
        `,
      }),
    ).toEqual([
      "error .github/actions/a/action.yml:6:7 Unexpected value 'with' (not allowed together with `shell`); Required property is missing: run",
    ]);
  });

  it('keeps the parser’s errors when no shape fits better than another', () => {
    expect(
      schema503({
        [`${WF}/w.yml`]: yaml`
          on: push
          jobs:
            j:
              runs-on: x
              steps:
                - name: nothing to run
                  bogus: 1
        `,
      }),
    ).toHaveLength(2);
  });
});
