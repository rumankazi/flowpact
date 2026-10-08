#!/usr/bin/env node
// Smoke test for an installed wfc: runs the `wfc` command the way users do (npm's shim on PATH) against the fixtures
// and checks exit codes and output shapes. No dependencies, so it runs against a tarball install or the npm registry.
//
//   node scripts/smoke.mjs [--bin wfc] [--version 0.1.0]
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BIN = arg('bin', 'wfc');
const VERSION = arg(
  'version',
  JSON.parse(readFileSync(join(ROOT, 'packages/cli/package.json'), 'utf8')).version,
);
const fixture = (name) => join(ROOT, 'fixtures', name);

function wfc(args, env = {}) {
  const r = spawnSync(BIN, args, {
    encoding: 'utf8',
    // npm installs a .cmd shim on Windows, which needs a shell.
    shell: process.platform === 'win32',
    env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '', CI: '', GITHUB_ACTIONS: '', ...env },
    timeout: 60_000,
  });
  if (r.error) throw r.error;
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const failures = [];
function check(name, fn) {
  try {
    fn();
    console.log(`ok    ${name}`);
  } catch (err) {
    failures.push(name);
    console.log(`FAIL  ${name}\n      ${String(err.message).split('\n').join('\n      ')}`);
  }
}
function expect(cond, message, r) {
  if (cond) return;
  const tail = r
    ? `\n--- exit ${r.code}\n--- stdout\n${r.stdout.slice(-1500)}\n--- stderr\n${r.stderr.slice(-1500)}`
    : '';
  throw new Error(`${message}${tail}`);
}
const json = (r) => {
  try {
    return JSON.parse(r.stdout);
  } catch {
    expect(false, 'stdout is not JSON', r);
  }
};

check('--version prints the banner with the expected version', () => {
  const r = wfc(['--version']);
  expect(r.code === 0, 'exit code 0', r);
  expect(r.stdout.startsWith(`wfc v${VERSION} `), `starts with "wfc v${VERSION} "`, r);
});

check('rules lists the built-in rules', () => {
  const r = wfc(['rules']);
  expect(r.code === 0 && r.stdout.includes('WFC401'), 'exit 0 and lists WFC401', r);
});

check('explain shows a rule', () => {
  const r = wfc(['explain', 'WFC401']);
  expect(r.code === 0 && r.stdout.includes('empty-binding-for-matrix-combo'), 'exit 0 and names the rule', r);
});

check('lint passes a clean repository', () => {
  const r = wfc(['lint', '--root', fixture('clean')]);
  expect(r.code === 0, 'exit code 0', r);
  expect(!/\u001b\[/.test(r.stdout), 'no ANSI escapes with NO_COLOR', r);
});

check('lint finds the matrix incident (JSON)', () => {
  const r = wfc(['lint', '--root', fixture('incident-matrix'), '--format', 'json']);
  expect(r.code === 1, 'exit code 1', r);
  const report = json(r);
  expect(report.meta?.version === VERSION, `meta.version is ${VERSION}`, r);
  expect(
    report.findings.some((f) => f.code === 'WFC401' && f.loc.file === '.github/workflows/tests.yml'),
    'WFC401 in .github/workflows/tests.yml (POSIX path)',
    r,
  );
});

check('lint writes SARIF', () => {
  const r = wfc(['lint', '--root', fixture('incident-matrix'), '--format', 'sarif']);
  expect(r.code === 1 && json(r).version === '2.1.0', 'exit 1 and SARIF 2.1.0', r);
});

check('check reports contract drift', () => {
  const r = wfc(['check', '--root', fixture('contracts-drift'), '--format', 'json']);
  expect(r.code === 1, 'exit code 1', r);
  expect(
    json(r).findings.some((f) => f.code.startsWith('WFC80')),
    'a WFC80x finding',
    r,
  );
});

check('generate, then check, round-trips and is deterministic', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wfc-smoke-'));
  cpSync(fixture('clean'), dir, { recursive: true });
  const gen = wfc(['generate', '--root', dir]);
  expect(gen.code === 0, 'generate exits 0', gen);
  const chk = wfc(['check', '--root', dir]);
  expect(chk.code === 0, 'check exits 0 right after generate', chk);
  const again = wfc(['generate', '--root', dir, '--dry-run']);
  expect(
    again.code === 0 && again.stdout.includes('Contracts are up to date'),
    'a second generate changes nothing',
    again,
  );
});

check('trace follows an input upstream (JSON)', () => {
  const r = wfc([
    'trace',
    'run-suite.yml:config',
    '--up',
    '--root',
    fixture('incident-matrix'),
    '--format',
    'json',
  ]);
  expect(r.code === 0, 'exit code 0', r);
  expect(json(r).direction === 'up' && json(r).traces.length > 0, 'an upstream trace', r);
});

check('graph renders Mermaid', () => {
  const r = wfc(['graph', '--root', fixture('deep-nesting'), '--format', 'mermaid']);
  expect(r.code === 0 && r.stdout.startsWith('flowchart'), 'exit 0 and a flowchart', r);
});

check('usage errors exit 2', () => {
  const r = wfc(['lint', '--format', 'xml']);
  expect(r.code === 2, 'exit code 2', r);
});

if (failures.length) {
  console.log(`\n${failures.length} smoke check(s) failed: ${failures.join(', ')}`);
  process.exit(1);
}
console.log(`\nall smoke checks passed (wfc ${VERSION}, ${process.platform}, node ${process.version})`);
