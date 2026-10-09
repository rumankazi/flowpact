/**
 * Renders documentation screenshots from real `flowpact` runs against the fixture repositories, so the docs always show
 * the current output. Requires a built CLI (`pnpm build`).
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ansiToSvg } from './ansi-svg';

const ROOT = join(import.meta.dirname, '..');
const BIN = join(ROOT, 'packages/cli/dist/index.js');
const OUT = join(ROOT, 'apps/docs/public/screenshots');

/** Git without the user's or the system's settings (signing, hooks, line endings), so commits are reproducible. */
const GIT_CONFIG = { GIT_CONFIG_GLOBAL: devNull, GIT_CONFIG_NOSYSTEM: '1' };

type Edit = (file: string, from: string, to: string) => void;

interface Shot {
  name: string;
  fixture: string;
  args: string[];
  title: string;
  /** Keep only the first N lines (long outputs). */
  head?: number;
  /**
   * Run in a temporary git repository instead of the fixture, for impact mode: the fixture is committed as
   * `origin/main`, then these edits are committed on a branch.
   */
  change?: (edit: Edit) => void;
}

const shots: Shot[] = [
  {
    name: 'lint-incident',
    fixture: 'incident-matrix',
    args: ['lint'],
    title: 'flowpact lint — the missing matrix variant',
  },
  {
    name: 'lint-deep-nesting',
    fixture: 'deep-nesting',
    args: ['lint', '--hide-info'],
    title: 'flowpact lint — nested reusable workflows',
    head: 70,
  },
  { name: 'lint-summary', fixture: 'deep-nesting', args: ['lint', '-q'], title: 'Summary card', head: -22 },
  { name: 'lint-clean', fixture: 'clean', args: ['lint'], title: 'A clean run' },
  {
    name: 'trace-down',
    fixture: 'deep-nesting',
    args: ['trace', 'pipeline.yml:environment'],
    title: 'flowpact trace — where does a value go?',
  },
  {
    name: 'trace-up',
    fixture: 'incident-matrix',
    args: ['trace', 'run-suite.yml:config', '--up'],
    title: 'flowpact trace --up — where does a value come from?',
  },
  {
    name: 'generate-dry-run',
    fixture: 'deep-nesting',
    args: ['generate', '--dry-run'],
    title: 'flowpact generate --dry-run — preview the contracts',
    head: 40,
  },
  {
    name: 'check-drift',
    fixture: 'contracts-drift',
    args: ['check', '--hide-info'],
    title: 'flowpact check — drift, breaking changes and overrides',
  },
  {
    name: 'impact',
    fixture: 'clean',
    // test.yml is a published reusable workflow. Naming its job changes the check consumers require from
    // "… / unit" to "… / Unit tests", and its output goes away: both are major, and the title declares a patch.
    change: (edit) => {
      edit('.github/workflows/test.yml', '  unit:\n', '  unit:\n    name: Unit tests\n');
      edit(
        '.github/workflows/test.yml',
        '    outputs:\n      report:\n        description: Path of the test report\n        value: ${{ jobs.unit.outputs.report }}\n',
        '',
      );
    },
    args: ['impact', '--base', 'origin/main', '--title', 'fix: tidy the test job'],
    title: 'flowpact impact — a renamed check declared as a patch',
  },
  { name: 'graph-tree', fixture: 'deep-nesting', args: ['graph'], title: 'flowpact graph — who calls whom' },
  { name: 'explain', fixture: 'clean', args: ['explain', 'FP401'], title: 'flowpact explain FP401' },
  { name: 'rules', fixture: 'clean', args: ['rules'], title: 'flowpact rules', head: 24 },
  {
    name: 'debug',
    fixture: 'incident-matrix',
    args: ['lint', '--debug', '--only', 'FP401'],
    title: 'flowpact lint --debug',
    head: 30,
  },
];

/**
 * A temporary git repository holding the fixture's tracked files (an untracked .DS_Store would change the hashes),
 * committed on main and as `origin/main`, then `change` committed on a branch. Fixed identities and dates keep the
 * baseline commit the same on every run.
 */
function changedRepository(fixture: string, change: (edit: Edit) => void): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'flowpact-shot-')));
  const env = {
    ...process.env,
    ...GIT_CONFIG,
    GIT_AUTHOR_NAME: 'Docs',
    GIT_AUTHOR_EMAIL: 'docs@example.com',
    GIT_AUTHOR_DATE: '2026-01-01T12:00:00Z',
    GIT_COMMITTER_NAME: 'Docs',
    GIT_COMMITTER_EMAIL: 'docs@example.com',
    GIT_COMMITTER_DATE: '2026-01-01T12:00:00Z',
  };
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env, stdio: 'pipe' });
  try {
    const prefix = `fixtures/${fixture}/`;
    const files = execFileSync('git', ['ls-files', '-z', '--', prefix], { cwd: ROOT, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
    for (const file of files) {
      const to = join(dir, file.slice(prefix.length));
      mkdirSync(dirname(to), { recursive: true });
      writeFileSync(to, readFileSync(join(ROOT, file)));
    }
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-q', '-m', 'Initial commit');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    git('checkout', '-q', '-b', 'change');
    change((file, from, to) => {
      const path = join(dir, file);
      const text = readFileSync(path, 'utf8');
      if (!text.includes(from))
        throw new Error(`fixtures/${fixture}/${file} does not contain ${JSON.stringify(from)}`);
      writeFileSync(path, text.replace(from, to));
    });
    git('commit', '-q', '-a', '-m', 'Change');
    return dir;
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
}

mkdirSync(OUT, { recursive: true });
for (const shot of shots) {
  const cwd = shot.change
    ? changedRepository(shot.fixture, shot.change)
    : join(ROOT, 'fixtures', shot.fixture);
  const res = spawnSync('node', [BIN, ...shot.args], {
    cwd,
    env: {
      ...process.env,
      FORCE_COLOR: '1',
      NO_COLOR: undefined,
      COLUMNS: '104',
      FLOWPACT_DEBUG: undefined,
      GITHUB_REPOSITORY: 'acme/app',
      // In GitHub Actions, impact mode reads the run's event: here the docs workflow's, not a pull request's.
      ...(shot.change ? { ...GIT_CONFIG, GITHUB_ACTIONS: undefined } : {}),
    },
    encoding: 'utf8',
  });
  if (shot.change) rmSync(cwd, { recursive: true, force: true });
  // Banner and logs go to stderr, the report to stdout; show them in reading order. Debug logs print absolute paths:
  // show a runner's checkout, not the machine that generated the screenshots.
  let text = `${res.stderr}${res.stdout}`
    .split(cwd)
    .join('/home/runner/work/app/app')
    .split(ROOT)
    .join('/home/runner/work/flowpact/flowpact')
    // Timings vary from run to run: show fixed ones, and keep what follows in its column (the summary card's border)
    // when the real one is wider or narrower.
    .replace(
      /(\d+(\.\d+)? ?ms\b)((?:\u001B\[[\d;]*m)*)( *)/g,
      (_, time: string, decimals: string | undefined, codes: string, pad: string) => {
        const fixed = decimals ? '0.42 ms' : '12 ms';
        return `${fixed}${codes}${pad && ' '.repeat(Math.max(1, pad.length + time.length - fixed.length))}`;
      },
    )
    // Debug log timings: the analysis total like the summary's, every stage the same small value.
    .replace(/^.*"ms":.*$/gm, (line) =>
      line.replace(/("ms":)\d+(?:\.\d+)?/g, `$1${line.includes('analysis finished') ? '12' : '0.42'}`),
    );
  const lines = text.split('\n');
  if (shot.head && shot.head > 0 && lines.length > shot.head)
    text = [...lines.slice(0, shot.head), '\u001B[2m  …\u001B[0m'].join('\n');
  if (shot.head && shot.head < 0) text = lines.slice(shot.head).join('\n');
  const prompt = `flowpact ${shot.args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`;
  writeFileSync(join(OUT, `${shot.name}.svg`), ansiToSvg(text, { title: shot.title, prompt }));
  console.log(`${shot.name}.svg (exit ${res.status})`);
}
