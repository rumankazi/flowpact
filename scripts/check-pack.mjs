#!/usr/bin/env node
// Fails unless `npm pack` for the CLI contains exactly the files users need. Run from packages/cli.
import { execSync } from 'node:child_process';

const files = JSON.parse(execSync('npm pack --dry-run --json', { encoding: 'utf8' }))[0]
  .files.map((f) => f.path)
  .sort();
const expected = ['LICENSE', 'README.md', 'dist/index.js', 'package.json'];
if (JSON.stringify(files) !== JSON.stringify(expected)) {
  console.error(
    `::error::unexpected tarball contents: ${files.join(', ')} (expected ${expected.join(', ')})`,
  );
  process.exit(1);
}
console.log(`tarball contents ok: ${files.join(', ')}`);
