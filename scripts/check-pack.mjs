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
// THIRD_PARTY_LICENSES.txt and sbom.cdx.json say what the bundle contains (scripts/bundle-licenses.ts).
const expected = [
  'LICENSE',
  'README.md',
  'dist/THIRD_PARTY_LICENSES.txt',
  'dist/index.js',
  'dist/sbom.cdx.json',
  'package.json',
];
if (JSON.stringify(files) !== JSON.stringify(expected))
  fail(`unexpected tarball contents: ${files.join(', ')} (expected ${expected.join(', ')})`);

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies']) {
  if (pkg[field] && Object.keys(pkg[field]).length)
    fail(`package.json declares ${field} (${Object.keys(pkg[field]).join(', ')}); bundle them instead`);
}
console.log(`tarball contents ok: ${files.join(', ')}; no runtime dependencies`);
