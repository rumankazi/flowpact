/**
 * Read-only access to another revision of the repository, so impact mode can analyse the base of a pull request (or
 * the last release) with the same rules as the working tree. Runs `git` directly (never through a shell) and only
 * reads; refs are verified before use. Symlinks and submodules in the tree are not followed.
 */
import { execFileSync } from 'node:child_process';
import type { FileSystem } from './project';

export class GitError extends Error {}

const MAX_BUFFER = 256 * 1024 * 1024;

function git(root: string, args: string[], input?: string): Buffer {
  try {
    return execFileSync('git', ['-C', root, ...args], {
      maxBuffer: MAX_BUFFER,
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(input !== undefined ? { input } : {}),
    });
  } catch (err) {
    const e = err as { code?: string; stderr?: Buffer };
    if (e.code === 'ENOENT') throw new GitError('git is not installed or not on PATH');
    const detail = e.stderr?.toString().trim().split('\n')[0] ?? (err as Error).message;
    throw new GitError(detail);
  }
}

/** The commit a ref points at, or a GitError naming the ref. Refs starting with `-` are rejected. */
export function resolveCommit(root: string, ref: string): string {
  if (!ref || ref.startsWith('-')) throw new GitError(`invalid ref: ${JSON.stringify(ref)}`);
  try {
    return git(root, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`])
      .toString()
      .trim();
  } catch {
    throw new GitError(
      `${ref} is not available in this clone. Fetch it first (for example \`git fetch origin ${ref}\`, or check out with fetch-depth: 0).`,
    );
  }
}

/** Whether `root` is inside a git work tree. */
export function isGitRepository(root: string): boolean {
  try {
    return git(root, ['rev-parse', '--is-inside-work-tree']).toString().trim() === 'true';
  } catch {
    return false;
  }
}

/** Repository-relative files at `commit` (regular files only), read lazily. */
export function gitFileSystem(root: string, commit: string): FileSystem & { commit: string } {
  // `ls-tree` paths are relative to the repository top level; flowpact paths are relative to `root`.
  const prefix = git(root, ['rev-parse', '--show-prefix']).toString().trim();
  const files = new Set<string>();
  const out = git(root, ['ls-tree', '-r', '-z', '--full-tree', commit]).toString();
  for (const entry of out.split('\0')) {
    if (!entry) continue;
    const tab = entry.indexOf('\t');
    const [mode, type] = entry.slice(0, tab).split(' ');
    const path = entry.slice(tab + 1);
    // Regular files only: no symlinks (120000) and no submodules (commit entries).
    if (type !== 'blob' || (mode !== '100644' && mode !== '100755')) continue;
    if (prefix && !path.startsWith(prefix)) continue;
    files.add(path.slice(prefix.length));
  }
  const cache = new Map<string, string | undefined>();
  const norm = (p: string) => p.replace(/^\.\//, '').replace(/\/+$/, '');
  const under = (dir: string) => {
    const d = norm(dir);
    return d === '' || d === '.' ? '' : `${d}/`;
  };
  return {
    commit,
    read(path) {
      const p = norm(path);
      if (!files.has(p)) return undefined;
      if (!cache.has(p))
        cache.set(p, git(root, ['cat-file', 'blob', `${commit}:${prefix}${p}`]).toString('utf8'));
      return cache.get(p);
    },
    list(dir) {
      const d = under(dir);
      return [...files].filter((f) => f.startsWith(d) && !f.slice(d.length).includes('/')).sort();
    },
    walk(dir) {
      const d = under(dir);
      return [...files].filter((f) => f.startsWith(d)).sort();
    },
    isDir(path) {
      const d = under(path);
      return [...files].some((f) => f.startsWith(d));
    },
  };
}
