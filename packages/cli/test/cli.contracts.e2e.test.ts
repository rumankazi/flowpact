import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { reportSchema } from '@wfc/core';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BIN = join(ROOT, 'packages/cli/dist/index.js');
const CD = '.github/workflow-contracts';
const CONTRACT_RULES = 'WFC801,WFC802,WFC803,WFC804,WFC805';
const CONTRACTS = ['build', 'package', 'pipeline', 'publish'].map((n) => `${CD}/workflows/${n}.contract.yml`);

const SCRUB = [
  'NO_COLOR',
  'FORCE_COLOR',
  'WFC_DEBUG',
  'WFC_NOW',
  'RUNNER_DEBUG',
  'ACTIONS_STEP_DEBUG',
  'CI',
  'GITHUB_ACTIONS',
];

/** Runs the built CLI with a controlled environment (no inherited color/debug settings). */
const wfc = (args: string[], env: Record<string, string> = {}) => {
  const base = Object.fromEntries(Object.entries(process.env).filter(([k]) => !SCRUB.includes(k)));
  return execa('node', [BIN, ...args], {
    reject: false,
    cwd: ROOT,
    extendEnv: false,
    env: { ...base, GITHUB_REPOSITORY: 'acme/fixtures', NO_COLOR: '1', ...env },
  });
};

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' });

/** A scratch git repository holding a copy of fixtures/deep-nesting. */
const repo = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'wfc-contracts-e2e-'));
  cpSync(join(ROOT, 'fixtures/deep-nesting'), root, { recursive: true });
  git(root, 'init', '-q');
  return root;
};

/** Output with line wrapping undone, for matching messages. */
const flat = (s: string) => s.replace(/\s+/g, ' ');
const read = (root: string, file: string) => readFileSync(join(root, file), 'utf8');
const contractsIn = (dir: string) =>
  existsSync(join(dir, CD, 'workflows')) ? readdirSync(join(dir, CD, 'workflows')).sort() : [];

/** Makes the optional `notes` input of publish.yml required — a breaking change for package.yml. */
const requireNotes = (root: string) => {
  const file = join(root, '.github/workflows/publish.yml');
  const src = readFileSync(file, 'utf8');
  const next = src.replace(/(notes:\n\s+type: string\n\s+required: )false/, '$1true');
  expect(next).not.toBe(src);
  writeFileSync(file, next);
};

describe('wfc generate / wfc check', () => {
  it('check reports missing contracts, generate writes them, then check is clean', async () => {
    const root = repo();
    const missing = await wfc(['check', '--root', root, '--only', CONTRACT_RULES]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout.match(/WFC801 contract-missing/g)).toHaveLength(4);
    expect(flat(missing.stdout)).toContain(`(expected ${CD}/workflows/build.contract.yml)`);

    const gen = await wfc(['generate', '--root', root]);
    expect(gen.exitCode).toBe(0);
    expect(contractsIn(root)).toEqual([
      'build.contract.yml',
      'package.contract.yml',
      'pipeline.contract.yml',
      'publish.contract.yml',
    ]);
    expect(read(root, CONTRACTS[3]!)).toContain('path: .github/workflows/publish.yml');

    const clean = await wfc(['check', '--root', root, '--only', CONTRACT_RULES]);
    expect(clean.exitCode).toBe(0);
    expect(clean.stdout).toContain('No problems found');

    // Without --only the other findings in the fixture still decide the exit code, but none are WFC8xx.
    const full = await wfc(['check', '--root', root, '--format', 'json']);
    const json = JSON.parse(full.stdout);
    expect(reportSchema.safeParse(json).success).toBe(true);
    expect(json.findings.filter((f: { code: string }) => f.code.startsWith('WFC8'))).toEqual([]);
    expect(json.contracts).toMatchObject({ drift: false, breaking: 0, counts: { unchanged: 4 } });
    expect(full.exitCode).toBe(1);

    const snapshot = CONTRACTS.map((f) => read(root, f));
    const again = await wfc(['generate', '--root', root]);
    expect(again.exitCode).toBe(0);
    expect(CONTRACTS.map((f) => read(root, f))).toEqual(snapshot);
  });

  it('flags a breaking change, writes a patch that git applies, and is clean afterwards', async () => {
    const root = repo();
    await wfc(['generate', '--root', root]);
    git(root, 'add', '-A');
    git(root, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-qm', 'init');
    requireNotes(root);
    const before = read(root, CONTRACTS[3]!);

    const patchFile = join(root, 'wfc-contracts.patch');
    const r = await wfc(['check', '--root', root, '--only', CONTRACT_RULES, '--patch', patchFile]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain('WFC803 breaking-interface-change');
    expect(flat(r.stdout)).toContain('input "notes" must now be passed by every caller');
    expect(r.stdout).toContain('consumer: .github/workflows/package.yml › jobs.publish');
    expect(r.stdout).not.toContain('WFC802');
    expect(read(root, CONTRACTS[3]!)).toBe(before);

    const patch = readFileSync(patchFile, 'utf8');
    expect(patch).toContain(`diff --git a/${CONTRACTS[3]} b/${CONTRACTS[3]}`);
    expect(patch).toMatch(/^-\s+required: false$/m);
    expect(patch).toMatch(/^\+\s+required: true$/m);
    git(root, 'apply', 'wfc-contracts.patch');
    expect(git(root, 'status', '--porcelain', CD).trim()).toBe(`M ${CONTRACTS[3]}`);

    const after = await wfc(['check', '--root', root, '--only', CONTRACT_RULES]);
    expect(after.exitCode).toBe(0);
  });

  it('does not write a patch when nothing drifted', async () => {
    const root = repo();
    await wfc(['generate', '--root', root]);
    const patchFile = join(root, 'p.patch');
    const r = await wfc(['check', '--root', root, '--only', CONTRACT_RULES, '--patch', patchFile]);
    expect(r.exitCode).toBe(0);
    expect(existsSync(patchFile)).toBe(false);
  });

  it('generate --dry-run prints the diff and writes nothing', async () => {
    const root = repo();
    await wfc(['generate', '--root', root]);
    requireNotes(root);
    const before = read(root, CONTRACTS[3]!);
    const r = await wfc(['generate', '--root', root, '--dry-run']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain(CONTRACTS[3]);
    expect(r.stdout).toMatch(/^-\s+required: false$/m);
    expect(r.stdout).toMatch(/^\+\s+required: true$/m);
    expect(read(root, CONTRACTS[3]!)).toBe(before);

    const fresh = repo();
    expect((await wfc(['generate', '--root', fresh, '--dry-run'])).exitCode).toBe(0);
    expect(contractsIn(fresh)).toEqual([]);
  });

  it('generate --patch writes a patch instead of the contracts', async () => {
    const root = repo();
    const patchFile = join(root, 'new.patch');
    const r = await wfc(['generate', '--root', root, '--patch', patchFile]);
    expect(r.exitCode).toBe(0);
    expect(contractsIn(root)).toEqual([]);
    git(root, 'apply', 'new.patch');
    expect(contractsIn(root)).toHaveLength(4);
    expect((await wfc(['check', '--root', root, '--only', CONTRACT_RULES])).exitCode).toBe(0);
  });

  it('generate --out writes every contract to another directory and leaves the repository alone', async () => {
    const root = repo();
    await wfc(['generate', '--root', root]);
    requireNotes(root);
    const before = read(root, CONTRACTS[3]!);
    const out = mkdtempSync(join(tmpdir(), 'wfc-contracts-out-'));
    const r = await wfc(['generate', '--root', root, '--out', out]);
    expect(r.exitCode).toBe(0);
    expect(contractsIn(out)).toHaveLength(4);
    expect(read(out, CONTRACTS[3]!)).toMatch(/notes:\n\s+type: string\n\s+required: true/);
    expect(read(root, CONTRACTS[3]!)).toBe(before);
  });
});

describe('overrides from the config file', () => {
  const configure = (root: string) => {
    mkdirSync(join(root, CD), { recursive: true });
    writeFileSync(
      join(root, CD, 'wfc.config.yml'),
      [
        'overrides:',
        '  - rule: missing-required-input',
        '    target: .github/workflows/package.yml#inputs.channel',
        '    reason: channel is added by the release rewrite (JIRA-42)',
        '    expires: 2026-01-31',
        "    owner: '@release'",
        '',
      ].join('\n'),
    );
  };

  it('suppresses until the expiry date and reports WFC901 afterwards (clock pinned with WFC_NOW)', async () => {
    const root = repo();
    configure(root);
    const json = async (now: string) => {
      const r = await wfc(['lint', '--root', root, '--format', 'json'], { WFC_NOW: now });
      const parsed = JSON.parse(r.stdout);
      expect(reportSchema.safeParse(parsed).success).toBe(true);
      return parsed as {
        findings: { code: string; symbol?: string; loc: { file: string; line: number } }[];
        suppressed: { code: string; override: { owner?: string } }[];
        summary: { suppressed: number };
      };
    };

    const active = await json('2026-01-10T09:00:00Z');
    expect(active.summary.suppressed).toBe(1);
    expect(active.suppressed.map((f) => [f.code, f.override.owner])).toEqual([['WFC101', '@release']]);
    expect(active.findings.map((f) => f.code)).not.toContain('WFC101');
    expect(active.findings.filter((f) => f.code.startsWith('WFC9'))).toEqual([]);

    const soon = await json('2026-01-25T09:00:00Z');
    expect(soon.findings.filter((f) => f.code.startsWith('WFC9')).map((f) => f.code)).toEqual(['WFC903']);

    const expired = await json('2026-02-01T09:00:00Z');
    expect(expired.summary.suppressed).toBe(0);
    expect(expired.findings.map((f) => f.code)).toContain('WFC101');
    const wfc901 = expired.findings.filter((f) => f.code === 'WFC901');
    expect(wfc901.map((f) => [f.loc.file, f.loc.line])).toEqual([[`${CD}/wfc.config.yml`, 2]]);

    const pretty = await wfc(['lint', '--root', root], { WFC_NOW: '2026-02-01' });
    expect(pretty.exitCode).toBe(1);
    expect(pretty.stdout).toContain('WFC901 override-expired');
    expect(flat(pretty.stdout)).toContain(
      'expired on 2026-01-31 (owner @release); 1 finding is reported again',
    );
  });
});
