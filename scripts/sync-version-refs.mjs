#!/usr/bin/env node
// Keeps the version references in the docs and READMEs on the current release line, from release-please's manifest:
// - `rumankazi/flowpact@v0.3`: the action's floating tag (`v0.<minor>` before 1.0, `v<major>` from 1.0);
// - `rumankazi/flowpact@v0.3.2`: an exact pin of the action;
// - `flowpact@0.3`: an npm range for the CLI (`0.<minor>` before 1.0, `<major>` from 1.0);
// - the version in output samples: the banner (`flowpact v0.3.2 · config schema v1`) and the JSON report's `meta`,
//   also in the terminal screenshots (apps/docs/public/screenshots/*.svg).
// The release workflow runs it on the release pull request; `--check` lists stale references and exits 1.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DOCS = 'apps/docs/content/docs';
const SHOTS = 'apps/docs/public/screenshots';
/** Width of a character in the terminal screenshots (scripts/ansi-svg.ts). */
const CHAR_WIDTH = 8.4;

export const FILES = [
  'README.md',
  'SECURITY.md',
  'CONTRIBUTING.md',
  'packages/cli/README.md',
  ...readdirSync(join(ROOT, DOCS))
    .filter((f) => f.endsWith('.mdx'))
    .map((f) => `${DOCS}/${f}`),
  ...readdirSync(join(ROOT, SHOTS))
    .filter((f) => f.endsWith('.svg'))
    .map((f) => `${SHOTS}/${f}`),
];

export function currentVersion() {
  return JSON.parse(readFileSync(join(ROOT, '.release-please-manifest.json'), 'utf8'))['.'];
}

/** `text` with every version reference moved to `version`'s release line. */
export function syncRefs(text, version) {
  const [major, minor] = version.split('.').map(Number);
  const line = major >= 1 ? `${major}` : `0.${minor}`;
  return (
    text
      .replace(/rumankazi\/flowpact@v\d+\.\d+\.\d+(?![\w.-])/g, `rumankazi/flowpact@v${version}`)
      .replace(/rumankazi\/flowpact@v\d+(?:\.\d+)?(?![\w.-])/g, `rumankazi/flowpact@v${line}`)
      .replace(/(?<![\w/@.-])flowpact@\d+(?:\.\d+)?(?![\w.-])/g, `flowpact@${line}`)
      .replace(/(flowpact {1,2}v)\d+\.\d+\.\d+(?= {1,2}(?:· )?config schema)/g, `$1${version}`)
      .replace(/("tool": "flowpact", "version": ")\d+\.\d+\.\d+"/g, `$1${version}"`)
      // The banner in a terminal screenshot: one <tspan> per word, sized to its text.
      .replace(
        /(>flowpact<\/tspan><tspan x="[\d.]+" textLength=")[\d.]+("[^>]*>)v\d+\.\d+\.\d+(?=<\/tspan>)/g,
        (_, before, attrs) => `${before}${((version.length + 1) * CHAR_WIDTH).toFixed(1)}${attrs}v${version}`,
      )
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes('--check');
  const version = currentVersion();
  const stale = [];
  for (const file of FILES) {
    const before = readFileSync(join(ROOT, file), 'utf8');
    const after = syncRefs(before, version);
    if (after === before) continue;
    stale.push(file);
    if (!check) writeFileSync(join(ROOT, file), after);
  }
  if (check && stale.length) {
    console.error(`Version references are not on ${version}'s release line: ${stale.join(', ')}`);
    console.error('Run `node scripts/sync-version-refs.mjs`.');
    process.exit(1);
  }
  if (!check) console.log(stale.length ? `updated: ${stale.join(', ')}` : 'up to date');
}
