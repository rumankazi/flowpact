#!/usr/bin/env node
// Keeps the repository's rulesets and merge settings in sync with the files in .github/:
//   .github/rulesets/<name>.json   one ruleset each, in the format of GitHub's ruleset export
//   .github/repository.json        repository settings (merge methods, branch cleanup, …)
//   .github/environments.json      deployment environments and the branches allowed to deploy to them
//
//   node scripts/sync-repo-settings.mjs --check   show what differs from the live settings (read access is enough)
//   node scripts/sync-repo-settings.mjs --apply   create or update them (needs a token with Administration: write)
//
// Uses GITHUB_TOKEN and GITHUB_REPOSITORY. Rulesets that exist on GitHub but have no file are reported, not deleted.
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const apply = process.argv.includes('--apply');
const repo = process.env.GITHUB_REPOSITORY;
const token = process.env.GITHUB_TOKEN;
if (!repo || !token) {
  console.error('GITHUB_REPOSITORY and GITHUB_TOKEN are required');
  process.exit(2);
}

async function api(method, path, body) {
  const res = await fetch(`https://api.github.com/repos/${repo}${path}`, {
    method,
    headers: {
      accept: 'application/vnd.github+json',
      authorization: `Bearer ${token}`,
      'x-github-api-version': '2022-11-28',
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : undefined;
}

/** Differences where `live` does not match `want`; keys GitHub adds with defaults are ignored. */
function diff(want, live, path = '') {
  if (Array.isArray(want)) {
    if (!Array.isArray(live) || live.length !== want.length)
      return [`${path}: ${show(live)} → ${show(want)}`];
    const order = (xs) => [...xs].sort((a, b) => key(a).localeCompare(key(b)));
    const [w, l] = [order(want), order(live)];
    return w.flatMap((x, i) => diff(x, l[i], `${path}[${key(x)}]`));
  }
  if (want && typeof want === 'object') {
    if (!live || typeof live !== 'object') return [`${path}: ${show(live)} → ${show(want)}`];
    return Object.keys(want).flatMap((k) => diff(want[k], live[k], path ? `${path}.${k}` : k));
  }
  return want === live ? [] : [`${path}: ${show(live)} → ${show(want)}`];
}
const key = (x) =>
  x && typeof x === 'object' ? (x.type ?? x.context ?? `${x.actor_type}:${x.actor_id}`) : String(x);
const show = (v) => (v === undefined ? '(unset)' : JSON.stringify(v));

const report = [];
const log = (line) => {
  console.log(line);
  report.push(line);
};

let failed = false;
const dir = join(ROOT, '.github/rulesets');
const wanted = readdirSync(dir)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((f) => ({ file: `.github/rulesets/${f}`, ruleset: JSON.parse(readFileSync(join(dir, f), 'utf8')) }));
const existing = await api('GET', '/rulesets?includes_parents=false&per_page=100');

log(`## Repository settings (${apply ? 'apply' : 'check'})`, '');
for (const { file, ruleset } of wanted) {
  const match = existing.find((r) => r.name === ruleset.name);
  if (!match) {
    log(`- ruleset **${ruleset.name}** (${file}): missing${apply ? ' — creating' : ''}`);
    if (apply) await api('POST', '/rulesets', ruleset);
    continue;
  }
  const live = await api('GET', `/rulesets/${match.id}`);
  const changes = diff(ruleset, live);
  if (!changes.length) {
    log(`- ruleset **${ruleset.name}**: up to date`);
    continue;
  }
  log(
    `- ruleset **${ruleset.name}** (${file}): ${changes.length} difference(s)${apply ? ' — updating' : ''}`,
  );
  for (const c of changes) log(`  - \`${c}\``);
  if (apply) await api('PUT', `/rulesets/${match.id}`, ruleset);
}
for (const r of existing) {
  if (!wanted.some((w) => w.ruleset.name === r.name))
    log(`- ruleset **${r.name}**: not managed here (no file)`);
}

const settings = JSON.parse(readFileSync(join(ROOT, '.github/repository.json'), 'utf8'));
const live = await api('GET', '');
const unreadable = Object.keys(settings).filter((k) => !(k in live));
const changes = diff(Object.fromEntries(Object.entries(settings).filter(([k]) => k in live)), live);
if (unreadable.length && !apply) {
  log(`- repository settings: ${unreadable.join(', ')} need admin access to read`);
}
if (changes.length || (apply && unreadable.length)) {
  log(`- repository settings: ${changes.length} difference(s)${apply ? ' — updating' : ''}`);
  for (const c of changes) log(`  - \`${c}\``);
  if (apply) {
    try {
      await api('PATCH', '', settings);
    } catch (err) {
      failed = true;
      log(`  - failed: ${err.message}`);
    }
  }
} else {
  log('- repository settings: up to date');
}

const environments = JSON.parse(readFileSync(join(ROOT, '.github/environments.json'), 'utf8'));
for (const [name, want] of Object.entries(environments)) {
  const path = `/environments/${encodeURIComponent(name)}`;
  let current;
  try {
    const env = await api('GET', path);
    const policies = env.deployment_branch_policy?.custom_branch_policies
      ? (await api('GET', `${path}/deployment-branch-policies?per_page=100`)).branch_policies
      : undefined;
    current = { policies };
  } catch (err) {
    if (!String(err.message).includes(' 404 ')) {
      log(
        `- environment **${name}**: cannot read (${err.message.split(':')[1]?.trim().split(' ')[0] ?? 'error'})`,
      );
      if (!apply) continue;
    }
  }
  const live = current?.policies?.map((p) => p.name).sort() ?? [];
  const wanted = [...want.branches].sort();
  if (current?.policies && JSON.stringify(live) === JSON.stringify(wanted)) {
    log(`- environment **${name}**: up to date`);
    continue;
  }
  log(
    `- environment **${name}**: deploys from ${current?.policies ? live.join(', ') || 'no branch' : current ? 'any branch' : '(missing)'} → ${wanted.join(', ')}${apply ? ' — updating' : ''}`,
  );
  if (!apply) continue;
  try {
    await api('PUT', path, {
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    });
    const existingPolicies = (await api('GET', `${path}/deployment-branch-policies?per_page=100`))
      .branch_policies;
    for (const branch of wanted)
      if (!existingPolicies.some((p) => p.name === branch))
        await api('POST', `${path}/deployment-branch-policies`, { name: branch, type: 'branch' });
    for (const p of existingPolicies)
      if (!wanted.includes(p.name)) await api('DELETE', `${path}/deployment-branch-policies/${p.id}`);
  } catch (err) {
    failed = true;
    log(`  - failed: ${err.message}`);
  }
}

if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report.join('\n')}\n`);
process.exit(failed ? 1 : 0);
