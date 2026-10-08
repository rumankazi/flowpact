import { describe, expect, it } from 'vitest';
import { at, byCode, lint, WF, yaml } from '../helpers';

const pipeline = (consumer: string) => yaml`
  on: push
  jobs:
    build:
      runs-on: x
      outputs:
        version: \${{ steps.meta.outputs.version }}
        unused: x
      steps:
        - id: meta
          run: echo "version=1" >> $GITHUB_OUTPUT
    call:
      uses: ./.github/workflows/lib.yml
    consume:
      needs: [build, call]
      runs-on: x
      steps:
        - run: ${consumer}
`;

const lib = yaml`
  on:
    workflow_call:
      outputs:
        url:
          value: \${{ jobs.j.outputs.url }}
        dead:
          value: \${{ jobs.j.outputs.url }}
  jobs:
    j:
      runs-on: x
      outputs:
        url: \${{ steps.s.outputs.url }}
      steps:
        - id: s
          run: echo "url=x" >> $GITHUB_OUTPUT
`;

describe('FP301 undefined-output-ref', () => {
  it('flags unknown job outputs and reusable workflow outputs', () => {
    const r = lint({
      [`${WF}/p.yml`]: pipeline(
        'echo ${{ needs.build.outputs.versoin }} ${{ needs.call.outputs.uri }} ${{ needs.call.outputs.url }}',
      ),
      [`${WF}/lib.yml`]: lib,
    });
    expect(byCode(r, 'FP301').map((f) => f.message)).toEqual([
      'jobs.build has no output "versoin" — did you mean "version"?',
      'jobs.call has no output "uri" — did you mean "url"?',
    ]);
  });

  it('flags workflow outputs that point at missing jobs or outputs', () => {
    const broken = lint({
      [`${WF}/lib.yml`]: lib
        .replace(
          'url:\n        value: ${{ jobs.j.outputs.url }}',
          'url:\n        value: ${{ jobs.k.outputs.url }}',
        )
        .replace(
          'dead:\n        value: ${{ jobs.j.outputs.url }}',
          'dead:\n        value: ${{ jobs.j.outputs.nope }}',
        ),
    });
    const r = broken;
    expect(byCode(r, 'FP301').map((f) => f.message)).toEqual([
      '.github/workflows/lib.yml has no job "k"',
      'jobs.j has no output "nope"',
    ]);
  });

  it('flags missing step ids and steps that run later', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
        on: push
        jobs:
          j:
            runs-on: x
            outputs:
              a: \${{ steps.nope.outputs.a }}
            steps:
              - run: echo \${{ steps.later.outputs.x }}
              - id: later
                run: echo "x=1" >> $GITHUB_OUTPUT
              - run: echo \${{ steps.later.outputs.x }}
      `,
    });
    expect(byCode(r, 'FP301').map((f) => f.message)).toEqual([
      'No step with id "nope" in jobs.j',
      'Step "later" runs after this step, so its outputs are not available yet',
    ]);
  });

  it('checks outputs of local actions', () => {
    const r = lint({
      [`${WF}/w.yml`]:
        'on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - id: a\n        uses: ./.github/actions/a\n      - run: echo ${{ steps.a.outputs.missing }}\n',
      '.github/actions/a/action.yml':
        'outputs:\n  present:\n    value: x\nruns:\n  using: composite\n  steps: []\n',
    });
    expect(byCode(r, 'FP301')[0]?.message).toBe('.github/actions/a has no output "missing"');
  });

  it('does not judge remote reusable workflows', () => {
    const r = lint({
      [`${WF}/w.yml`]:
        'on: push\njobs:\n  r:\n    uses: o/r/.github/workflows/x.yml@v1\n  c:\n    needs: r\n    runs-on: x\n    steps:\n      - run: echo ${{ needs.r.outputs.any }}\n',
    });
    expect(byCode(r, 'FP301')).toEqual([]);
  });
});

describe('FP302 output-ref-without-needs', () => {
  it('flags needs.<job> reads without a needs edge, and unknown jobs', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
        on: push
        jobs:
          a:
            runs-on: x
            outputs: { v: x }
            steps: [{ run: x }]
          b:
            runs-on: x
            steps:
              - run: echo \${{ needs.a.outputs.v }} \${{ needs.ghost.result }}
      `,
    });
    const fs = byCode(r, 'FP302');
    expect(fs.map((f) => f.message)).toEqual([
      'jobs.b reads needs.a but does not list "a" under needs',
      'jobs.b reads needs.ghost, but .github/workflows/w.yml has no job "ghost"',
    ]);
    expect(fs[0]!.fix).toBe('Add "a" to jobs.b.needs.');
  });
});

describe('FP303 unused-output', () => {
  // `_`-prefixed reusable workflows are internal by convention; lib.yml is published.
  const internal = (consumer: string) => ({
    [`${WF}/p.yml`]: pipeline(consumer).replace('workflows/lib.yml', 'workflows/_lib.yml'),
    [`${WF}/_lib.yml`]: lib,
  });

  it('flags unread job outputs and outputs of an internal workflow no caller reads', () => {
    const r = lint(internal('echo ${{ needs.build.outputs.version }} ${{ needs.call.outputs.url }}'));
    expect(byCode(r, 'FP303').map((f) => f.message)).toEqual([
      'Workflow output "dead" of .github/workflows/_lib.yml is not read by any of its 1 caller',
      'Output "unused" of jobs.build is never read',
    ]);
  });

  it('does not judge outputs of a published reusable workflow, whose callers live elsewhere (#40)', () => {
    const r = lint({
      [`${WF}/p.yml`]: pipeline('echo ${{ needs.build.outputs.version }} ${{ needs.call.outputs.url }}'),
      [`${WF}/lib.yml`]: lib,
    });
    expect(byCode(r, 'FP303').map((f) => f.message)).toEqual(['Output "unused" of jobs.build is never read']);
  });

  it('follows impact.publish when it lists the published units', () => {
    const files = {
      [`${WF}/p.yml`]: pipeline('echo ${{ needs.build.outputs.version }} ${{ needs.call.outputs.url }}'),
      [`${WF}/lib.yml`]: lib,
    };
    const listed = lint(files, { config: { impact: { publish: ['.github/workflows/lib.yml'] } } });
    expect(byCode(listed, 'FP303').map((f) => f.symbol)).toEqual([`${WF}/p.yml#jobs.build.outputs.unused`]);
    const other = lint(files, { config: { impact: { publish: ['action.yml'] } } });
    expect(byCode(other, 'FP303').map((f) => f.symbol)).toEqual([
      `${WF}/lib.yml#outputs.dead`,
      `${WF}/p.yml#jobs.build.outputs.unused`,
    ]);
  });

  it('does not judge workflow outputs without local callers', () => {
    const r = lint({ [`${WF}/_lib.yml`]: lib });
    expect(byCode(r, 'FP303')).toEqual([]);
  });

  const actionUser = (read: string) =>
    `on: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - id: a\n        uses: ./.github/actions/a\n      - run: echo ${read}\n`;
  const action =
    'outputs:\n  used:\n    value: x\n  dead:\n    value: y\nruns:\n  using: composite\n  steps: []\n';

  it('flags outputs of an internal action that no user reads', () => {
    const r = lint({
      [`${WF}/w.yml`]: actionUser('${{ steps.a.outputs.used }}'),
      '.github/actions/a/action.yml': action,
    });
    expect(byCode(r, 'FP303').map((f) => f.symbol)).toEqual(['.github/actions/a#outputs.dead']);
  });

  it('does not judge outputs of a published action', () => {
    const root = lint({
      [`${WF}/w.yml`]: actionUser('${{ steps.a.outputs.used }}').replace('./.github/actions/a', './'),
      'action.yml': action,
    });
    expect(byCode(root, 'FP303')).toEqual([]);
    const unlisted = lint(
      {
        [`${WF}/w.yml`]: actionUser('${{ steps.a.outputs.used }}').replace('./.github/actions/a', './'),
        'action.yml': action,
      },
      { config: { impact: { publish: ['.github/workflows/*.yml'] } } },
    );
    expect(byCode(unlisted, 'FP303').map((f) => f.symbol)).toEqual(['.#outputs.dead']);
    const listed = lint(
      { [`${WF}/w.yml`]: actionUser('${{ steps.a.outputs.used }}'), '.github/actions/a/action.yml': action },
      { config: { impact: { publish: ['.github/actions/a'] } } },
    );
    expect(byCode(listed, 'FP303')).toEqual([]);
  });

  it('counts a whole outputs object as reading every output', () => {
    for (const consumer of [
      'echo ${{ toJSON(needs.build.outputs) }} ${{ toJSON(needs.call.outputs) }}',
      "echo ${{ format('{0}', needs.build.outputs) }} ${{ fromJSON(toJSON(needs.call)).outputs.url }}",
      'echo ${{ needs.build.outputs[matrix.key] }} ${{ needs.call.outputs[inputs.which] }}',
      'echo ${{ needs.build.outputs.* }} ${{ toJSON(needs.*.outputs) }}',
    ]) {
      expect({ consumer, findings: byCode(lint(internal(consumer)), 'FP303') }).toEqual({
        consumer,
        findings: [],
      });
    }
  });

  it('still judges the other jobs when one job is read through a computed key', () => {
    const r = lint(internal('echo ${{ needs.call.outputs[matrix.key] }}'));
    expect(byCode(r, 'FP303').map((f) => f.message)).toEqual([
      'Output "version" of jobs.build is never read',
      'Output "unused" of jobs.build is never read',
    ]);
  });

  it('does not count needs.<job>.result as reading outputs', () => {
    const r = lint(internal('echo ${{ needs.build.result }} ${{ needs.call.outputs.url }}'));
    expect(byCode(r, 'FP303').map((f) => f.symbol)).toEqual([
      `${WF}/_lib.yml#outputs.dead`,
      `${WF}/p.yml#jobs.build.outputs.version`,
      `${WF}/p.yml#jobs.build.outputs.unused`,
    ]);
  });

  it('counts toJSON(needs.x.outputs) in the audit reproduction (synth/dyn3)', () => {
    const r = lint({
      [`${WF}/main.yml`]: yaml`
        on: push
        jobs:
          dlart:
            runs-on: ubuntu-latest
            outputs:
              one: \${{ steps.s.outputs.one }}
            steps:
              - id: s
                run: echo "one=1" >> "$GITHUB_OUTPUT"
          use:
            needs: dlart
            runs-on: ubuntu-latest
            steps:
              - run: echo '\${{ toJSON(needs.dlart.outputs) }}'
      `,
    });
    expect(byCode(r, 'FP303')).toEqual([]);
  });

  it('counts whole step and workflow-output objects', () => {
    const steps = lint({
      [`${WF}/w.yml`]: actionUser('${{ toJSON(steps.a.outputs) }}'),
      '.github/actions/a/action.yml': action,
    });
    expect(byCode(steps, 'FP303')).toEqual([]);
    for (const value of ['${{ toJSON(jobs.j.outputs) }}', '${{ jobs.j.outputs[inputs.which] }}']) {
      const wf = lint({
        ...internal(
          'echo ${{ needs.build.outputs.version }} ${{ needs.call.outputs.url }} ${{ needs.call.outputs.dead }}',
        ),
        [`${WF}/_lib.yml`]: lib
          .replace('url:\n        value: ${{ jobs.j.outputs.url }}', `url:\n        value: ${value}`)
          .replace('url: ${{ steps.s.outputs.url }}', 'url: ${{ steps.s.outputs.url }}\n      extra: x'),
      });
      expect({ value, symbols: byCode(wf, 'FP303').map((f) => f.symbol) }).toEqual({
        value,
        symbols: [`${WF}/p.yml#jobs.build.outputs.unused`],
      });
    }
  });
});

describe('FP304 step-output-never-written', () => {
  it('flags outputs the inline script never writes', () => {
    const r = lint({
      [`${WF}/w.yml`]: pipeline('x').replace('steps.meta.outputs.version', 'steps.meta.outputs.ver'),
    });
    const [f] = byCode(r, 'FP304');
    expect(f?.message).toBe(
      'Step "meta" never writes output "ver" (it writes version) — did you mean "version"?',
    );
    expect(at(f!)).toBe(`${WF}/w.yml:6:20`);
  });

  it('stays quiet for dynamic writes and scripts that do not mention GITHUB_OUTPUT', () => {
    const r = lint({
      [`${WF}/w.yml`]: yaml`
        on: push
        jobs:
          j:
            runs-on: x
            outputs:
              a: \${{ steps.dyn.outputs.a }}
              b: \${{ steps.ext.outputs.b }}
            steps:
              - id: dyn
                run: cat out.env >> "$GITHUB_OUTPUT"
              - id: ext
                run: ./script.sh
      `,
    });
    expect(byCode(r, 'FP304')).toEqual([]);
  });

  /** A job whose github-script step `s` runs `script`, and a later step that reads `steps.s.outputs.wanted`. */
  const scripted = (script: string, uses = 'actions/github-script@v8') => ({
    [`${WF}/w.yml`]: `on: push
jobs:
  j:
    runs-on: x
    steps:
      - id: s
        uses: ${uses}
        with:
          script: |
${script
  .split('\n')
  .map((l) => `            ${l}`)
  .join('\n')}
      - run: echo \${{ steps.s.outputs.wanted }}
`,
  });

  it('flags github-script steps whose script sets other outputs by name', () => {
    for (const script of [
      "core.setOutput('other', 1);",
      // `core` in strings and comments is not handed to anything.
      "core.setOutput('other', 1); // core is not passed on\ncore.info('pass core along');\ncore?.notice(\"core\");",
    ]) {
      const [f] = byCode(lint(scripted(script)), 'FP304');
      expect(f?.message).toBe('Step "s" never writes output "wanted" (it writes other, result)');
    }
    expect(byCode(lint(scripted('return 1;')), 'FP304')[0]?.message).toBe(
      'Step "s" never writes output "wanted" (it writes result)',
    );
  });

  it('does not judge github-script steps whose writes it cannot see', () => {
    for (const script of [
      // grafana detect-breaking-changes-levitate.yml
      "const script = require('./.github/workflows/scripts/levitate/json-file-to-job-output.js');\nawait script({ core, filePath: 'result.json' });",
      // getsentry sentry-pull-request-bot.yml
      'const { waitForMergeCommit } = await import(`${process.env.GITHUB_WORKSPACE}/scripts/wait.js`);\nawait waitForMergeCommit({ github, context, core });',
      // gh-aw lock files
      "const { setupGlobals } = require(path.join(dir, 'setup_globals.cjs'));\nsetupGlobals(core, github, context);",
      "core.setOutput('other', 1);\nawait helper(core);",
      "core.setOutput('other', 1);\nconst c = core;\nc['setOutput']('wanted', 2);",
      "core.setOutput('other', 1);\nconst { setOutput } = core;",
      'for (const [k, v] of Object.entries(values)) core.setOutput(k, v);',
      'core.setOutput(`out-${kind}`, 1);',
      "core.setOutput('other', 1);\neval(code);",
    ]) {
      expect({ script, findings: byCode(lint(scripted(script)), 'FP304') }).toEqual({ script, findings: [] });
    }
  });

  it('does not judge other actions that take a script, since they may set outputs of their own', () => {
    expect(byCode(lint(scripted("core.setOutput('other', 1);", 'acme/run-js@v1')), 'FP304')).toEqual([]);
  });
});
