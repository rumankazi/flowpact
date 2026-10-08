/**
 * Everything impact mode needs before `analyze()`: the declared impact (flags or the GitHub event), the baseline
 * (the pull request's base, or the last release for a release pull request) analysed from git, and the policy from
 * the baseline's config.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type AnalyzeOptions, analyze } from './analyze';
import {
  CONFIG_DIR,
  CONFIG_FILES,
  LEGACY_CONFIG_DIR,
  LEGACY_CONFIG_FILES,
  parseConfigText,
  type WfcConfig,
} from './config';
import { type GitError, gitFileSystem, resolveCommit } from './git';
import type { DeclaredInput, ImpactLevel, ImpactPolicy } from './impact';
import type { Logger } from './logger';
import type { FileSystem } from './project';

export class ImpactSetupError extends Error {}

export interface ImpactRequest {
  /** Explicit baseline ref; default: the pull request's base, or the remote's default branch. */
  base?: string;
  expect?: ImpactLevel;
  title?: string;
  labels?: string[];
  /** The GitHub event (`GITHUB_EVENT_NAME` and the parsed `GITHUB_EVENT_PATH`), when running in Actions. */
  event?: { name?: string; payload?: GitHubEventPayload };
  repository?: string;
}

export interface GitHubEventPayload {
  pull_request?: { title?: string; labels?: { name?: string }[]; base?: { sha?: string; ref?: string } };
}

export type PreparedImpact =
  | { skip: string }
  | { options: NonNullable<AnalyzeOptions['impact']>; notes: string[] };

/** Reads `GITHUB_EVENT_NAME` / `GITHUB_EVENT_PATH` (a missing or unreadable payload is treated as none). */
export function githubEvent(env: NodeJS.ProcessEnv = process.env): ImpactRequest['event'] {
  if (!env.GITHUB_EVENT_NAME) return undefined;
  let payload: GitHubEventPayload | undefined;
  try {
    if (env.GITHUB_EVENT_PATH) payload = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, 'utf8'));
  } catch {
    payload = undefined;
  }
  return { name: env.GITHUB_EVENT_NAME, ...(payload ? { payload } : {}) };
}

const RELEASE_TITLE = /^chore(\([^)]*\))?: release\b/i;

function readJson(fs: FileSystem, path: string): Record<string, unknown> | undefined {
  const text = fs.read(path);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** The project's version: release-please's manifest (root component), else the root package.json. */
function versionOf(fs: FileSystem): string | undefined {
  const manifest = readJson(fs, '.release-please-manifest.json');
  const v = manifest?.['.'];
  if (typeof v === 'string') return v;
  const pkg = readJson(fs, 'package.json');
  return typeof pkg?.version === 'string' ? pkg.version : undefined;
}

function configOf(fs: FileSystem): WfcConfig | undefined {
  for (const [dir, names] of [
    [CONFIG_DIR, CONFIG_FILES],
    [LEGACY_CONFIG_DIR, LEGACY_CONFIG_FILES],
  ] as const) {
    for (const name of names) {
      const text = fs.read(`${dir}/${name}`);
      if (text !== undefined) return parseConfigText(text, `${dir}/${name}`).config;
    }
  }
  return undefined;
}

const workingTree = (root: string): FileSystem => ({
  read: (p) => {
    try {
      return readFileSync(join(root, p), 'utf8');
    } catch {
      return undefined;
    }
  },
  list: () => [],
  walk: () => [],
  isDir: () => false,
});

function defaultBase(root: string): string {
  for (const ref of ['origin/HEAD', 'origin/main', 'origin/master']) {
    try {
      resolveCommit(root, ref);
      return ref;
    } catch {
      // try the next one
    }
  }
  throw new ImpactSetupError('No baseline: pass --base <ref> (for example --base origin/main).');
}

/** Resolves the baseline and the declaration, and analyses the baseline. */
export function prepareImpact(
  root: string,
  headConfig: WfcConfig,
  req: ImpactRequest,
  logger?: Logger,
): PreparedImpact {
  const eventName = req.event?.name;
  if (eventName === 'merge_group') return { skip: 'merge_group: impact was checked on the pull request' };
  if (eventName === 'pull_request_target' && !req.base) {
    throw new ImpactSetupError(
      'pull_request_target runs on the default branch, so it would compare the default branch with itself. Run impact mode on pull_request (or pass --base and check out the pull request head).',
    );
  }
  const pr = req.event?.payload?.pull_request;
  const title = req.title ?? pr?.title;
  const labels = req.labels ?? (pr?.labels ?? []).map((l) => l.name ?? '').filter(Boolean);
  const notes: string[] = [];

  let baseRef = req.base ?? pr?.base?.sha ?? defaultBase(root);
  let kind: 'ref' | 'release' = 'ref';
  let release: DeclaredInput['release'];

  const isRelease =
    (title !== undefined && RELEASE_TITLE.test(title)) || labels.includes('autorelease: pending');
  if (isRelease) {
    // A release pull request changes only versions and the changelog; what matters is everything since the last
    // release, against the version it proposes.
    const prBase = gitFileSystem(root, resolveCommit(root, baseRef));
    const previous = versionOf(prBase);
    const next = versionOf(workingTree(root));
    if (previous && next && previous !== next) {
      const tag = [`v${previous}`, previous].find((t) => {
        try {
          resolveCommit(root, t);
          return true;
        } catch {
          return false;
        }
      });
      if (!tag)
        throw new ImpactSetupError(
          `The release tag v${previous} is not available; fetch tags first (git fetch --tags).`,
        );
      const rpConfig = readJson(workingTree(root), 'release-please-config.json');
      release = { previous, version: next, bumpMinorPreMajor: rpConfig?.['bump-minor-pre-major'] === true };
      baseRef = tag;
      kind = 'release';
      notes.push(`release pull request: ${previous} → ${next}, compared with ${tag}`);
    }
  }

  let commit: string;
  try {
    commit = resolveCommit(root, baseRef);
  } catch (err) {
    throw new ImpactSetupError((err as GitError).message);
  }
  const fs = gitFileSystem(root, commit);
  const baseConfig = configOf(fs);
  // Policy comes from the baseline, so a pull request cannot relax its own check.
  const policy: ImpactPolicy = { ...(baseConfig ?? headConfig).impact };
  if (baseConfig && JSON.stringify(baseConfig.impact) !== JSON.stringify(headConfig.impact)) {
    notes.push('this pull request changes impact settings; they apply after it is merged');
  }
  logger?.debug('impact baseline', { ref: baseRef, commit, kind });
  const base = analyze({
    root,
    fs,
    config: baseConfig ?? headConfig,
    validateSchema: false,
    only: [],
    ...(req.repository ? { repository: req.repository } : {}),
  });
  return {
    options: {
      base: base.index,
      baseline: { kind, ref: baseRef, commit },
      declared: {
        ...(req.expect ? { explicit: req.expect } : {}),
        ...(title !== undefined && !release ? { title } : {}),
        ...(labels.length ? { labels } : {}),
        ...(release ? { release } : {}),
      },
      policy,
    },
    notes,
  };
}
