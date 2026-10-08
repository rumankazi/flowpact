/** `flowpact impact` and `--impact` on real git repositories (base commit, pull request head, release tags). */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BIN = join(ROOT, 'packages/cli/dist/index.js');

const flowpact = (cwd: string, args: string[], env: Record<string, string> = {}) =>
  execa('node', [BIN, ...args, '-q'], {
    cwd,
    reject: false,
    timeout: 45_000,
    extendEnv: false,
    env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', NO_COLOR: '1', ...env },
  });

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

function write(root: string, files: Record<string, string>) {
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, f)), { recursive: true });
    writeFileSync(join(root, f), text);
  }
}

const reusable = (name: string) =>
  `on:\n  workflow_call:\n    inputs:\n      node: { type: string, default: '22' }\njobs:\n  test:\n    name: ${name}\n    runs-on: ubuntu-latest\n    steps: [{ run: 'true' }]\n`;

/** A repository with `base` committed on main and `head` committed on a branch. */
function repo(base: Record<string, string>, head: Record<string, string>, sub = ''): string {
  const top = mkdtempSync(join(tmpdir(), 'flowpact-impact-'));
  git(top, 'init', '-q', '-b', 'main');
  git(top, 'config', 'user.email', 't@example.com');
  git(top, 'config', 'user.name', 't');
  git(top, 'config', 'commit.gpgsign', 'false');
  git(top, 'config', 'tag.gpgsign', 'false');
  const root = join(top, sub);
  write(root, base);
  git(top, 'add', '-A');
  git(top, 'commit', '-q', '-m', 'base');
  git(top, 'checkout', '-q', '-b', 'change');
  write(root, head);
  git(top, 'add', '-A');
  git(top, 'commit', '-q', '-m', 'change');
  return root;
}

const WF = '.github/workflows/ci-reusable.yml';
const renamed = () => repo({ [WF]: reusable('Test') }, { [WF]: reusable('Unit tests') });

describe('flowpact impact', () => {
  it('fails an under-declared rename and passes a breaking title', async () => {
    const root = renamed();
    const fix = await flowpact(root, ['impact', '--base', 'main', '--title', 'fix: tidy the test job']);
    expect(fix.exitCode).toBe(1);
    expect(fix.stdout).toContain('FP810');
    expect(fix.stdout).toContain('check "… / Test" is now "… / Unit tests"');
    const bang = await flowpact(root, ['impact', '--base', 'main', '--title', 'fix!: rename the test check']);
    expect(bang.exitCode).toBe(0);
    expect((await flowpact(root, ['impact', '--base', 'main', '--expect', 'major'])).exitCode).toBe(0);
  });

  it('reports a conflicting label and writes the verdict as JSON', async () => {
    const root = renamed();
    const r = await flowpact(root, [
      'impact',
      '--base',
      'main',
      '--title',
      'fix: x',
      '--labels',
      'semver:major',
      '--format',
      'json',
    ]);
    expect(r.exitCode).toBe(1);
    const report = JSON.parse(r.stdout);
    expect(report.findings.map((f: { code: string }) => f.code).sort()).toEqual(['FP810', 'FP811']);
    expect(report.impact).toMatchObject({
      required: 'major',
      ok: false,
      declared: { kind: 'title', level: 'patch' },
    });
  });

  it('is a usage error for an unknown base and on pull_request_target', async () => {
    const root = renamed();
    expect((await flowpact(root, ['impact', '--base', 'no-such-ref'])).exitCode).toBe(2);
    const event = join(root, 'event.json');
    writeFileSync(event, JSON.stringify({ pull_request: { title: 'fix: x', base: { sha: 'main' } } }));
    const r = await flowpact(root, ['impact'], {
      GITHUB_ACTIONS: 'true',
      GITHUB_EVENT_NAME: 'pull_request_target',
      GITHUB_EVENT_PATH: event,
    });
    expect(r.exitCode).toBe(2);
    expect(r.stderr).toContain('pull_request_target');
  });

  it('reads the title and labels from the pull request event', async () => {
    const root = renamed();
    const event = join(root, 'event.json');
    writeFileSync(
      event,
      JSON.stringify({ pull_request: { title: 'feat!: unit tests', labels: [], base: { sha: 'main' } } }),
    );
    const env = { GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'pull_request', GITHUB_EVENT_PATH: event };
    expect((await flowpact(root, ['impact'], env)).exitCode).toBe(0);
  });

  it('checks a release pull request against the last release tag', async () => {
    const base = {
      [WF]: reusable('Test'),
      '.release-please-manifest.json': '{ ".": "0.1.0" }\n',
      'release-please-config.json': '{ "bump-minor-pre-major": true }\n',
    };
    const root = repo(base, { [WF]: reusable('Unit tests') });
    git(root, 'checkout', '-q', 'main');
    git(root, 'tag', 'v0.1.0');
    git(root, 'checkout', '-q', 'change');
    // The release branch: only the version changes on top of what was merged since v0.1.0.
    git(root, 'checkout', '-q', '-b', 'release');
    const bump = (v: string) => {
      write(root, { '.release-please-manifest.json': `{ ".": "${v}" }\n` });
      git(root, 'commit', '-q', '-am', `release ${v}`);
    };
    bump('0.1.1');
    const patch = await flowpact(root, [
      'impact',
      '--base',
      'change',
      '--title',
      'chore(main): release 0.1.1',
    ]);
    expect(patch.exitCode).toBe(1);
    expect(patch.stdout).toContain('FP810');
    bump('0.2.0');
    const minor = await flowpact(root, [
      'impact',
      '--base',
      'change',
      '--title',
      'chore(main): release 0.2.0',
      '--format',
      'json',
    ]);
    expect(minor.exitCode).toBe(0);
    expect(JSON.parse(minor.stdout).impact).toMatchObject({
      baseline: { kind: 'release', ref: 'v0.1.0' },
      declared: { kind: 'version', level: 'major' },
      required: 'major',
      ok: true,
    });
  });

  it('works for a project in a subdirectory of the git repository', async () => {
    const root = repo({ [WF]: reusable('Test') }, { [WF]: reusable('Unit tests') }, 'services/api');
    const r = await flowpact(root, ['impact', '--base', 'main', '--title', 'fix: x']);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('FP810');
  });

  it('runs with lint via --impact', async () => {
    const root = renamed();
    const r = await flowpact(root, ['lint', '--impact', '--base', 'main', '--title', 'fix: x']);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('FP810');
  });
});
