import { type ArgsDef, parseArgs } from 'citty';
import { describe, expect, it } from 'vitest';
import { checkCommand } from '../src/commands/check';
import { explainCommand } from '../src/commands/explain';
import { generateCommand } from '../src/commands/generate';
import { impactCommand } from '../src/commands/impact';
import { lintCommand } from '../src/commands/lint';
import { rulesCommand } from '../src/commands/rules';
import { traceCommand } from '../src/commands/trace';
import { normalizeArgv, repeatedFlag } from '../src/shared';

const COMMANDS = {
  lint: lintCommand,
  check: checkCommand,
  impact: impactCommand,
  rules: rulesCommand,
  explain: explainCommand,
  generate: generateCommand,
  trace: traceCommand,
};

/** Tokens that make parsing hard: flags whose value looks like a flag, `--no-*`, `--`, short clusters. */
const TOKENS = [
  '--title',
  '--labels',
  '--patch',
  '--base',
  '--base-config',
  '--fail-on',
  '--failOn',
  '--format',
  'json',
  '--plugin',
  '--plugin=a.mjs',
  'b.mjs',
  '-o',
  '--o',
  '--help',
  '-o=c.json',
  '-oc.md',
  '--output',
  '--output=d.sarif',
  '--no-plugins',
  '--no-color',
  '--',
  '-q',
  '-qo',
  '-vv',
  '--unknown',
  'x.yml',
];

/** Deterministic pseudo-random argument lists. */
function* argLists(count: number): Generator<string[]> {
  let seed = 42;
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed;
  };
  for (let i = 0; i < count; i++) {
    const length = 1 + (next() % 6);
    yield Array.from({ length }, () => TOKENS[next() % TOKENS.length]!);
  }
}

describe('normalizeArgv', () => {
  it('attaches every value of a string flag to its flag', () => {
    expect(
      normalizeArgv(
        [
          'impact',
          '--title',
          '--',
          '--no-plugins',
          '--labels',
          '--help',
          '-qo',
          'x.md',
          '-o',
          '',
          '--base',
          'main',
        ],
        COMMANDS,
      ),
    ).toEqual([
      'impact',
      '--title=--',
      '--no-plugins',
      '--labels=--help',
      '-qox.md',
      '--output=',
      '--base=main',
    ]);
    // Booleans, attached values, positionals and everything after `--` stay as they are.
    expect(normalizeArgv(['lint', '-q', '--title=x', 'a.yml', '--', '--title', 'y'], COMMANDS)).toEqual([
      'lint',
      '-q',
      '--title=x',
      'a.yml',
      '--',
      '--title',
      'y',
    ]);
  });

  it('refuses options before the command, which citty would drop, but not help or the version', () => {
    expect(() => normalizeArgv(['--no-plugins', 'lint'], COMMANDS)).toThrow('Options go after the command');
    for (const argv of [
      ['--version'],
      ['-h', 'lint'],
      ['--no-color', '--help'],
      [],
      ['lsp', '--socket', '1234'],
    ])
      expect(normalizeArgv(argv, COMMANDS)).toEqual(argv);
  });

  it('keeps a pull request title from turning off --no-plugins or ending the run', () => {
    for (const title of ['--', '--help', '-h', '--version', '-V', '--no-plugins', '--plugin=x']) {
      const argv = normalizeArgv(['impact', '--title', title, '--no-plugins'], COMMANDS);
      const parsed = parseArgs(argv.slice(1), impactCommand.args as ArgsDef) as Record<string, unknown>;
      expect({ title, parsed: [parsed.title, parsed.plugins, parsed.plugin] }).toEqual({
        title,
        parsed: [title, false, undefined],
      });
      expect(argv.filter((a) => ['--', '--help', '-h', '--version', '-V'].includes(a))).toEqual([]);
    }
  });
});

describe('repeatedFlag', () => {
  it('collects every value in order', () => {
    const def = lintCommand.args as ArgsDef;
    expect(
      repeatedFlag(['-o', 'a.json', '--output', 'b.md', '--output=c.sarif', '-od.txt'], def, 'output'),
    ).toEqual(['a.json', 'b.md', 'c.sarif', 'd.txt']);
    expect(repeatedFlag(['--plugin', 'a.mjs', '--no-plugins', '--plugin=b.mjs'], def, 'plugin')).toEqual([
      'a.mjs',
      'b.mjs',
    ]);
  });

  it('never takes the value of another flag, such as a pull request title, for a plugin or an output', () => {
    const def = impactCommand.args as ArgsDef;
    for (const title of ['--plugin=evil.mjs', '--plugin', '-o=x', '-o', '--output=x', '-qo']) {
      const args = ['--base', 'main', '--title', title, 'evil.mjs', '--no-plugins'];
      expect({
        title,
        plugins: repeatedFlag(args, def, 'plugin'),
        outputs: repeatedFlag(args, def, 'output'),
      }).toEqual({ title, plugins: [], outputs: [] });
    }
    // `--no-*` is dropped before parsing, as citty does, so the title is the token after it.
    expect(repeatedFlag(['--title', '--no-plugins', '--plugin=x'], def, 'plugin')).toEqual([]);
    expect(repeatedFlag(['--patch', '--plugin=x'], checkCommand.args as ArgsDef, 'plugin')).toEqual([]);
    expect(repeatedFlag(['--', '--plugin=x'], def, 'plugin')).toEqual([]);
  });

  it('agrees with citty, for every command', () => {
    let compared = 0;
    for (const [name, command] of Object.entries(COMMANDS)) {
      const def = command.args as ArgsDef;
      for (const args of argLists(3000)) {
        let parsed: Record<string, unknown>;
        try {
          parsed = parseArgs(args, def) as Record<string, unknown>;
        } catch {
          continue; // citty rejects it (e.g. an invalid --format), so the command never runs.
        }
        const normalized = normalizeArgv([name, ...args], COMMANDS).slice(1);
        let afterNormalizing: Record<string, unknown>;
        try {
          afterNormalizing = parseArgs(normalized, def) as Record<string, unknown>;
        } catch {
          continue;
        }
        for (const flag of ['plugin', 'output'] as const) {
          if (!(flag in def)) continue;
          const citty = parsed[flag] === '' ? undefined : parsed[flag];
          const raw = repeatedFlag(args, def, flag);
          // Attaching values changes nothing citty reads, apart from what a value can no longer steer: `--`,
          // `--help` and `--no-*` are read as values when they follow a string flag.
          if (!args.some((a) => a === '--' || a === '--help' || a.startsWith('--no-'))) {
            const later = afterNormalizing[flag] === '' ? undefined : afterNormalizing[flag];
            expect({ command: name, args, flag, value: later }).toEqual({
              command: name,
              args,
              flag,
              value: citty,
            });
          }
          // citty keeps one value (the last, unless spellings mix); we keep them all, so its value must be one of ours,
          // and we find none where it finds none, unless the last occurrence had no value.
          const values = raw.filter(Boolean);
          const ok =
            citty !== undefined ? values.includes(citty as string) : values.length === 0 || raw.at(-1) === '';
          expect({ command: name, args, flag, citty, values, ok }).toMatchObject({ ok: true });
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(5000);
  });
});
