import { type ArgsDef, parseArgs } from 'citty';
import { describe, expect, it } from 'vitest';
import { checkCommand } from '../src/commands/check';
import { explainCommand } from '../src/commands/explain';
import { generateCommand } from '../src/commands/generate';
import { impactCommand } from '../src/commands/impact';
import { lintCommand } from '../src/commands/lint';
import { rulesCommand } from '../src/commands/rules';
import { traceCommand } from '../src/commands/trace';
import { repeatedFlag } from '../src/shared';

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

  it('agrees with citty on the last value, for every command', () => {
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
        for (const flag of ['plugin', 'output'] as const) {
          if (!(flag in def)) continue;
          const citty = parsed[flag] === '' ? undefined : parsed[flag];
          const last = repeatedFlag(args, def, flag).at(-1);
          const ours = last === '' ? undefined : last;
          expect({ command: name, args, flag, value: ours }).toEqual({
            command: name,
            args,
            flag,
            value: citty,
          });
          compared++;
        }
      }
    }
    expect(compared).toBeGreaterThan(5000);
  });
});
