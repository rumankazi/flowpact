#!/usr/bin/env node
// Fails unless `npm pack` for the CLI contains exactly the files users need and declares no runtime dependencies
// (everything is bundled, so installing flowpact downloads nothing else). Run from packages/cli.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const fail = (message) => {
  console.error(`::error::${message}`);
  process.exit(1);
};

const files = JSON.parse(execSync('npm pack --dry-run --json', { encoding: 'utf8' }))[0]
  .files.map((f) => f.path)
  .sort();
// dist/index.js is the command and dist/api.js the API (with its hand-written api.d.ts); the engine they share is one
// chunk, named by its content's hash. THIRD_PARTY_LICENSES.txt and sbom.cdx.json say what the bundle contains
// (scripts/bundle-licenses.ts).
const CHUNK = /^dist\/chunk-[A-Z0-9]+\.js$/;
const expected = [
  'LICENSE',
  'README.md',
  'dist/THIRD_PARTY_LICENSES.txt',
  'dist/api.d.ts',
  'dist/api.js',
  'dist/index.js',
  'dist/sbom.cdx.json',
  'package.json',
];
const chunks = files.filter((f) => CHUNK.test(f));
const rest = files.filter((f) => !CHUNK.test(f));
if (JSON.stringify(rest) !== JSON.stringify(expected) || chunks.length !== 1)
  fail(
    `unexpected tarball contents: ${files.join(', ')} (expected ${expected.join(', ')} and one dist/chunk-<hash>.js)`,
  );

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies']) {
  if (pkg[field] && Object.keys(pkg[field]).length)
    fail(`package.json declares ${field} (${Object.keys(pkg[field]).join(', ')}); bundle them instead`);
}
// The command and the API are the package's two entry points; both must exist in the tarball.
const exported = pkg.exports?.['.'];
if (
  pkg.bin?.flowpact !== 'dist/index.js' ||
  exported?.default !== './dist/api.js' ||
  exported?.types !== './dist/api.d.ts'
)
  fail('package.json must keep "bin" (dist/index.js) and export dist/api.js with its types (dist/api.d.ts)');
console.log(`tarball contents ok: ${files.join(', ')}; no runtime dependencies`);
