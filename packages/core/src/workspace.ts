import type { Project, UnverifiedUse } from './graph';
import type { ActionDecl, Binding, JobDecl, StepDecl, UnitDecl, UsesRef, WorkflowDecl } from './ir';
import type { Logger } from './logger';
import { normalizeRelative } from './parse';
import { formatLoc, type Loc } from './source';

/**
 * The runner's workspace as far as a job's steps reveal it. A step's `uses: ./path` is resolved against the workspace
 * (GITHUB_WORKSPACE), not the repository, so what `./path` means depends on the `actions/checkout` steps before it.
 */
export interface Workspace {
  /** What is checked out where; the deepest mount containing a path decides what the path is. */
  mounts: Mount[];
  /** An `actions/checkout` step ran, so the layout no longer rests on the assumed checkout at the root. */
  managed: boolean;
  /** The last checkout to a path computed at runtime (`path: ${{ ... }}`): it may hold any path. */
  dynamic?: { path: string; repository?: string; loc: Loc };
}

export interface Mount {
  /** Normalized workspace path; `.` is the workspace root. */
  path: string;
  /** Another repository (`owner/repo`, or the expression computing it); absent for this repository. */
  repository?: string;
  /** The `actions/checkout` step; absent for the assumed checkout of this repository at the root. */
  loc?: Loc;
}

/**
 * Before any checkout, assume this repository at the workspace root: most jobs check it out there, possibly through
 * a step flowpact cannot see into, and a `./` action is unusable otherwise.
 */
export const initialWorkspace = (): Workspace => ({ mounts: [{ path: '.' }], managed: false });

const CHECKOUT = /^actions\/checkout(?:@|$)/i;
/**
 * Contexts naming the workflow's own repository, or the fork a pull request comes from (the same tree at another
 * commit, as far as local actions go).
 */
const OWN_REPOSITORY =
  /^github\.(?:repository|event\.repository\.full_name|event\.pull_request\.(?:head|base)\.repo\.full_name|event\.workflow_run\.head_repository\.full_name)$/;

/** `${{ a || b }}` where every alternative names this repository (or a pull request's fork of it). */
function ownRepositoryExpression(value: string): boolean {
  const m = /^\$\{\{(.*)\}\}$/s.exec(value);
  return !!m && m[1]!.split('||').every((alt) => OWN_REPOSITORY.test(alt.trim()));
}

export const isCheckout = (uses: UsesRef): boolean => CHECKOUT.test(uses.raw.trim());

const escapes = (path: string) => path === '..' || path.startsWith('../') || path.startsWith('/');

const text = (b: Binding | undefined): string =>
  b === undefined || b.value === null || typeof b.value === 'object' ? '' : String(b.value).trim();

/** `with.repository` of a checkout: `undefined` for this repository. */
function checkoutRepository(b: Binding | undefined, repository: string | undefined): string | undefined {
  const value = text(b);
  if (value === '' || ownRepositoryExpression(value)) return undefined;
  if (repository && value.toLowerCase() === repository.toLowerCase()) return undefined;
  return value;
}

/** `with.path` of a checkout as a workspace path; `undefined` when computed at runtime or outside the workspace. */
function checkoutPath(b: Binding | undefined): string | undefined {
  // `${{ github.workspace }}/dir` is `dir`; any other expression is only known at runtime.
  const value = text(b)
    .replace(/^\$\{\{\s*github\.workspace\s*\}\}(?:\/|$)/, '')
    .replaceAll('\\', '/');
  if (value.includes('${{') || value.startsWith('/') || /^[A-Za-z]:\//.test(value)) return undefined;
  const path = normalizeRelative(value);
  return escapes(path) ? undefined : path;
}

const within = (path: string, dir: string) => dir === '.' || path === dir || path.startsWith(`${dir}/`);

/** The workspace after an `actions/checkout` step: it replaces whatever was at its path (and below). */
export function applyCheckout(ws: Workspace, step: StepDecl, repository: string | undefined): Workspace {
  const loc = step.uses?.loc ?? step.loc;
  const other = checkoutRepository(step.with.repository, repository);
  const path = checkoutPath(step.with.path);
  if (path === undefined) {
    const dynamic = {
      path: text(step.with.path),
      ...(other !== undefined ? { repository: other } : {}),
      loc,
    };
    return { ...ws, managed: true, dynamic };
  }
  const mounts = ws.mounts.filter((m) => !within(m.path, path));
  mounts.push({ path, ...(other !== undefined ? { repository: other } : {}), loc });
  return { mounts, managed: true, ...(ws.dynamic ? { dynamic: ws.dynamic } : {}) };
}

/** The mount holding a workspace path (which must not escape the workspace), and the path inside it. */
export function locate(ws: Workspace, path: string): { mount: Mount; rel: string } {
  // A checkout replaces everything below its path, so the root mount is never removed by a deeper one.
  let best: Mount = ws.mounts.find((m) => m.path === '.') ?? { path: '.' };
  for (const m of ws.mounts)
    if (m.path !== '.' && within(path, m.path) && (best.path === '.' || m.path.length > best.path.length))
      best = m;
  const rel = best.path === '.' ? path : path === best.path ? '.' : path.slice(best.path.length + 1);
  return { mount: best, rel };
}

/** Identifies a workspace for memoizing walks through composite actions. */
export function workspaceKey(ws: Workspace): string {
  return JSON.stringify([
    ws.mounts.map((m) => [m.path, m.repository ?? null, m.loc ? formatLoc(m.loc) : null]),
    ws.managed,
    ws.dynamic ? formatLoc(ws.dynamic.loc) : null,
  ]);
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Whether a script names a workspace path as a whole (`cp -r src/act ./tmp/act`, `"$GITHUB_WORKSPACE/tmp/act"`): a
 * `./path` that is not in the repository is then most likely created by that step rather than misspelled.
 */
export function mentionsPath(script: string, path: string): boolean {
  if (path === '.') return false;
  const before = String.raw`(?:^|[\s"'=(]|\./|\$\{?GITHUB_WORKSPACE\}?/|\}\}/)`;
  return new RegExp(`${before}${escapeRegExp(path)}/?(?=$|[\\s"';)&|])`, 'm').test(script);
}

/** Where one step's `uses:` leads in one workspace. */
type Outcome =
  | { kind: 'local'; target: string; found: boolean; checkout?: { path: string; loc: Loc } }
  | { kind: 'unverified'; info: Pick<UnverifiedUse, 'reason' | 'checkout' | 'writer'> }
  /** `$/path@ref`, which GitHub rejects. */
  | { kind: 'invalid' }
  /** `owner/repo/path@ref` of this repository that is not in the working tree: it may exist at that ref. */
  | { kind: 'skip' };

interface StepRecord {
  unit: UnitDecl;
  job?: string;
  step: StepDecl;
  /** Outcomes in workspaces reached from a workflow job. */
  rooted: Map<string, Outcome>;
  /** Outcomes for actions nothing here reaches, in the assumed workspace. */
  assumed: Map<string, Outcome>;
}

export interface WorkspaceResolverOptions {
  repository?: string;
  /** Loads the action in a repository directory (`undefined` when it does not exist). */
  loadAction(dir: string): ActionDecl | undefined;
  /** Whether a directory exists in the repository. */
  isDir(dir: string): boolean;
  logger: Logger;
}

/**
 * Resolves steps' local `uses:` by walking jobs in order, through composite actions (whose steps run in the caller's
 * workspace and whose checkouts change it). An action used from several workspaces gets the outcomes of all of them:
 * found anywhere wins, then missing from this repository, then not verifiable.
 */
export function workspaceResolver(opts: WorkspaceResolverOptions) {
  const records = new Map<StepDecl, StepRecord>();
  /** Workspaces each composite action was walked in, and the workspace it left behind. */
  const walkedIn = new Map<ActionDecl, Map<string, Workspace>>();
  const active = new Set<ActionDecl>();

  const resolve = (uses: UsesRef, ws: Workspace, scripts: { text: string; loc: Loc }[]): Outcome => {
    const target = uses.target!;
    if (uses.selfRef !== undefined) return { kind: 'invalid' };
    if (uses.workspacePath === undefined) {
      // `$/path` and `owner/repo/path@ref` of this repository: the repository itself, whatever the workspace holds.
      const found = opts.loadAction(target) !== undefined;
      if (!found && uses.sameRepoRef !== undefined && !escapes(target)) return { kind: 'skip' };
      return { kind: 'local', target, found };
    }
    const path = uses.workspacePath;
    if (escapes(path)) return { kind: 'unverified', info: { reason: 'outside-workspace' } };
    const { mount, rel } = locate(ws, path);
    if (mount.repository !== undefined && mount.loc) {
      const checkout = { repository: mount.repository, path: mount.path, loc: mount.loc };
      return { kind: 'unverified', info: { reason: 'other-repository', checkout } };
    }
    const checkout =
      mount.loc && mount.path !== '.' ? { checkout: { path: mount.path, loc: mount.loc } } : {};
    if (opts.loadAction(rel)) return { kind: 'local', target: rel, found: true, ...checkout };
    const writer = scripts.find((s) => mentionsPath(s.text, path));
    if (writer) return { kind: 'unverified', info: { reason: 'created-at-runtime', writer: writer.loc } };
    // Only a checkout of this repository says what is at the root: the assumed one does not once the job checks out
    // elsewhere, and a checkout to a path computed at runtime may hold this path (unless it is in a directory of this
    // repository, such as `.github`).
    if (
      mount.path === '.' &&
      ((!mount.loc && ws.managed) || (ws.dynamic && !opts.isDir(rel.split('/')[0]!)))
    ) {
      const dynamic = ws.dynamic ? { checkout: ws.dynamic } : {};
      return { kind: 'unverified', info: { reason: 'not-checked-out', ...dynamic } };
    }
    return { kind: 'local', target: rel, found: false, ...checkout };
  };

  const record = (
    unit: UnitDecl,
    job: string | undefined,
    step: StepDecl,
    outcome: Outcome,
    rooted: boolean,
  ) => {
    let r = records.get(step);
    if (!r) {
      r = { unit, ...(job !== undefined ? { job } : {}), step, rooted: new Map(), assumed: new Map() };
      records.set(step, r);
    }
    const key = JSON.stringify(outcome);
    (rooted ? r.rooted : r.assumed).set(key, outcome);
  };

  const walk = (
    unit: UnitDecl,
    job: string | undefined,
    steps: StepDecl[],
    start: Workspace,
    rooted: boolean,
  ) => {
    let ws = start;
    const scripts: { text: string; loc: Loc }[] = [];
    for (const step of steps) {
      if (step.run !== undefined) scripts.push({ text: step.run, loc: step.runLoc ?? step.loc });
      const uses = step.uses;
      if (!uses) continue;
      if (isCheckout(uses)) {
        ws = applyCheckout(ws, step, opts.repository);
        continue;
      }
      if (uses.kind !== 'local-action' || uses.target === undefined) continue;
      const outcome = resolve(uses, ws, scripts);
      record(unit, job, step, outcome, rooted);
      const action = outcome.kind === 'local' && outcome.found ? opts.loadAction(outcome.target) : undefined;
      if (action) ws = enter(action, ws, rooted);
    }
    return ws;
  };

  /** Walks a composite action's steps in the caller's workspace; returns the workspace its checkouts leave behind. */
  const enter = (action: ActionDecl, ws: Workspace, rooted: boolean): Workspace => {
    if (active.has(action)) return ws; // an action using itself fails on GitHub; never loop
    const key = `${rooted}|${workspaceKey(ws)}`;
    const seen = walkedIn.get(action) ?? new Map<string, Workspace>();
    walkedIn.set(action, seen);
    const known = seen.get(key);
    if (known) return known;
    active.add(action);
    const after = walk(action, undefined, action.steps, ws, rooted);
    active.delete(action);
    seen.set(key, after);
    return after;
  };

  return {
    walkJob(wf: WorkflowDecl, job: JobDecl) {
      walk(wf, job.id, job.steps, initialWorkspace(), true);
    },

    /**
     * Actions no workflow here reaches (published ones, or ones used from other repositories) run in an unknown
     * workspace: assume this repository at the root. Those that others among them use go last, so they are walked in
     * their callers' workspaces instead.
     */
    walkRemainingActions(actions: Map<string, ActionDecl>) {
      for (;;) {
        const rest = [...actions.values()].filter((a) => !walkedIn.has(a));
        if (!rest.length) return;
        const used = new Set(rest.flatMap((a) => a.steps.map((s) => s.uses?.target)));
        enter(rest.find((a) => !used.has(a.path)) ?? rest[0]!, initialWorkspace(), false);
      }
    },

    /** Settles every step's `uses:` and lists what is missing, invalid or not verifiable. */
    finish(out: {
      missing: Project['missing'];
      invalid: NonNullable<Project['invalidTargets']>;
      unverified: UnverifiedUse[];
    }) {
      for (const r of records.values()) {
        const outcomes = [...(r.rooted.size ? r.rooted : r.assumed).values()];
        const outcome =
          outcomes.find((o) => o.kind === 'local' && o.found) ??
          outcomes.find((o) => o.kind === 'local') ??
          outcomes[0]!;
        const uses = r.step.uses!;
        const where = {
          uses,
          from: r.unit.path,
          ...(r.job !== undefined ? { job: r.job } : {}),
          step: r.step.index,
        };
        if (outcome.kind === 'local') {
          uses.target = outcome.target;
          if (outcome.found) continue;
          out.missing.push({ ...where, ...(outcome.checkout ? { checkout: outcome.checkout } : {}) });
          opts.logger.warn(`unresolved local reference ${uses.raw}`, { from: r.unit.path });
        } else if (outcome.kind === 'unverified') {
          uses.kind = 'workspace-action';
          delete uses.target;
          out.unverified.push({ ...where, ...outcome.info });
          opts.logger.debug(`workspace path not verified (${outcome.info.reason}): ${uses.raw}`, {
            from: r.unit.path,
          });
        } else if (outcome.kind === 'invalid') {
          out.invalid.push({ ...where, reason: 'self-ref' });
        } else {
          opts.logger.debug(`same-repository reference not in the working tree: ${uses.raw}`);
        }
      }
    },
  };
}
