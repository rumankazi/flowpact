/**
 * Renders documentation screenshots from real `flowpact` runs against the fixture repositories, so the docs always show
 * the current output. Requires a built CLI (`pnpm build`).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ansiToSvg } from './ansi-svg';

const ROOT = join(import.meta.dirname, '..');
const BIN = join(ROOT, 'packages/cli/dist/index.js');
const OUT = join(ROOT, 'apps/docs/public/screenshots');

interface Shot {
  name: string;
  fixture: string;
  args: string[];
  title: string;
  /** Keep only the first N lines (long outputs). */
  head?: number;
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

mkdirSync(OUT, { recursive: true });
for (const shot of shots) {
  const res = spawnSync('node', [BIN, ...shot.args], {
    cwd: join(ROOT, 'fixtures', shot.fixture),
    env: {
      ...process.env,
      FORCE_COLOR: '1',
      NO_COLOR: undefined,
      COLUMNS: '104',
      FLOWPACT_DEBUG: undefined,
      GITHUB_REPOSITORY: 'acme/app',
    },
    encoding: 'utf8',
  });
  // Banner and logs go to stderr, the report to stdout; show them in reading order.
  let text = `${res.stderr}${res.stdout}`.replace(/\d+(\.\d+)? ?ms\b/g, (m) =>
    m.includes('.') ? '0.42 ms' : '12 ms',
  );
  const lines = text.split('\n');
  if (shot.head && shot.head > 0 && lines.length > shot.head)
    text = [...lines.slice(0, shot.head), '\u001B[2m  …\u001B[0m'].join('\n');
  if (shot.head && shot.head < 0) text = lines.slice(shot.head).join('\n');
  const prompt = `flowpact ${shot.args.join(' ')}`;
  writeFileSync(join(OUT, `${shot.name}.svg`), ansiToSvg(text, { title: shot.title, prompt }));
  console.log(`${shot.name}.svg (exit ${res.status})`);
}
