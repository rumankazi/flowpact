/**
 * Impact mode: grade what changed between a baseline (the base of a pull request, or the last release) and the working
 * tree for **published** units — reusable workflows and actions other repositories use — and compare it with the
 * release impact the pull request declares.
 */
import { type CheckName, workflowChecks } from './checks';
import { buildContract, diffContracts } from './contracts';
import { matchesPattern } from './glob';
import type { ProjectIndex } from './graph';
import type { ActionDecl, JobDecl, PermissionsDecl, UnitDecl, WorkflowDecl } from './ir';
import type { Loc } from './source';

export const IMPACT_LEVELS = ['none', 'patch', 'minor', 'major'] as const;
export type ImpactLevel = (typeof IMPACT_LEVELS)[number];
export const levelRank = (l: ImpactLevel) => IMPACT_LEVELS.indexOf(l);
export const maxLevel = (levels: ImpactLevel[]): ImpactLevel =>
  levels.reduce<ImpactLevel>((a, b) => (levelRank(b) > levelRank(a) ? b : a), 'none');

export interface ImpactChange {
  /** The published unit (workflow path or action directory). */
  unit: string;
  kind: 'check-name' | 'interface' | 'unit' | 'permissions' | 'runtime' | 'uses';
  level: ImpactLevel;
  /** False when the change involves something flowpact cannot evaluate (event data, dynamic matrices, …). */
  certain: boolean;
  message: string;
  /** Where to report it: the head location, or the unit's file. */
  loc: Loc;
}

export interface ImpactPolicy {
  /** Globs of published units; default: every `workflow_call` workflow and every action outside `.github/`. */
  publish?: string[];
  /** Which declared source decides; the others are advisory. Default: `explicit` when given, else `title`. */
  declaredBy?: 'explicit' | 'title' | 'labels';
  labels: Record<ImpactLevel, string>;
  /** Conventional Commits type → level; types not listed declare `none`. */
  types: Record<string, ImpactLevel>;
  /** Count changes flowpact cannot fully resolve towards the required impact (`fail`) or only warn (`warn`). */
  uncertain: 'warn' | 'fail';
}

export const DEFAULT_IMPACT_POLICY: ImpactPolicy = {
  labels: { major: 'semver:major', minor: 'semver:minor', patch: 'semver:patch', none: 'semver:none' },
  types: { feat: 'minor', fix: 'patch', perf: 'patch' },
  uncertain: 'warn',
};

/** Whether other repositories may use the unit. */
export function isPublished(unit: UnitDecl, policy: Pick<ImpactPolicy, 'publish'>): boolean {
  if (policy.publish)
    return policy.publish.some((p) => matchesPattern(unit.file, p) || matchesPattern(unit.path, p));
  if (unit.kind === 'workflow') return unit.triggers.includes('workflow_call');
  return unit.path === '.' || !unit.path.startsWith('.github/');
}

const fileStart = (file: string): Loc => ({ file, line: 1, column: 1, endLine: 1, endColumn: 1 });

// ---------------------------------------------------------------------------
// Changes
// ---------------------------------------------------------------------------

/** The check names a published reusable workflow adds after the consumer's own caller job (`<caller> / …`). */
function publishedChecks(index: ProjectIndex, wf: WorkflowDecl): CheckName[] {
  return workflowChecks(index, wf);
}

function checkNameChanges(
  base: ProjectIndex,
  head: ProjectIndex,
  b: WorkflowDecl,
  h: WorkflowDecl,
): ImpactChange[] {
  const before = publishedChecks(base, b);
  const after = publishedChecks(head, h);
  const count = (xs: CheckName[]) => {
    const m = new Map<string, { n: number; certain: boolean; jobs: string[] }>();
    for (const c of xs) {
      const cur = m.get(c.name);
      m.set(c.name, { n: (cur?.n ?? 0) + 1, certain: (cur?.certain ?? true) && c.certain, jobs: c.jobs });
    }
    return m;
  };
  const bm = count(before);
  const am = count(after);
  const jobLoc = (jobs: string[]) => {
    const [path, id] = (jobs.at(-1) ?? '').split('#') as [string, string | undefined];
    const unit = head.project.workflows.get(path);
    const job: JobDecl | undefined = id ? unit?.jobs[id] : undefined;
    return job?.nameLoc ?? job?.loc ?? fileStart(h.file);
  };
  const out: ImpactChange[] = [];
  const jobKey = (jobs: string[]) => jobs.join(' > ');
  const removed = [...bm].filter(([name]) => !am.has(name));
  const added = [...am].filter(([name]) => !bm.has(name));
  // A job whose checks disappeared and that now reports other ones was renamed (name, matrix or callee).
  const addedByJob = new Map<string, string[]>();
  for (const [name, info] of added)
    addedByJob.set(jobKey(info.jobs), [...(addedByJob.get(jobKey(info.jobs)) ?? []), name]);
  const paired = new Set<string>();
  for (const [name, info] of removed) {
    const now = addedByJob.get(jobKey(info.jobs));
    const certain = info.certain && (now ? now.every((n) => am.get(n)!.certain) : true);
    if (now?.length) for (const n of now) paired.add(n);
    out.push({
      unit: h.path,
      kind: 'check-name',
      level: 'major',
      certain,
      message: now?.length
        ? `check "… / ${name}" is now ${now.map((n) => `"… / ${n}"`).join(', ')}; consumers that require the old name wait forever`
        : `check "… / ${name}" is no longer reported; consumers that require it wait forever`,
      loc: jobLoc(info.jobs),
    });
  }
  for (const [name, info] of added) {
    if (paired.has(name)) continue;
    out.push({
      unit: h.path,
      kind: 'check-name',
      level: 'minor',
      certain: info.certain,
      message: `new check "… / ${name}"`,
      loc: jobLoc(info.jobs),
    });
  }
  return out;
}

function contractLevel(path: string, breaking: boolean, message: string): ImpactLevel {
  const root = path.split('.')[0]!;
  if (!['inputs', 'dispatchInputs', 'secrets', 'outputs'].includes(root)) return 'none';
  if (breaking) return 'major';
  if (/was added|now optional/.test(message)) return 'minor';
  if (/default/.test(message)) return 'minor';
  if (/description changed/.test(message)) return 'none';
  return 'patch';
}

function interfaceChanges(base: ProjectIndex, head: ProjectIndex, b: UnitDecl, h: UnitDecl): ImpactChange[] {
  const out: ImpactChange[] = [];
  for (const c of diffContracts(buildContract(base, b), buildContract(head, h))) {
    const level = contractLevel(c.path, c.breaking, c.message);
    if (level === 'none') continue;
    out.push({
      unit: h.path,
      kind: 'interface',
      level,
      certain: true,
      message: c.message,
      loc: fileStart(h.file),
    });
  }
  return out;
}

type Scopes = Record<string, number> | 'inherit';
const RANK: Record<string, number> = { none: 0, read: 1, write: 2 };
const SCOPES = [
  'actions',
  'attestations',
  'checks',
  'contents',
  'deployments',
  'discussions',
  'id-token',
  'issues',
  'models',
  'packages',
  'pages',
  'pull-requests',
  'security-events',
  'statuses',
];

function scopesOf(p: PermissionsDecl | undefined): Scopes {
  if (p === undefined) return 'inherit';
  if (p === 'read-all' || p === 'write-all') {
    const level = p === 'read-all' ? 1 : 2;
    return Object.fromEntries(SCOPES.map((s) => [s, s === 'id-token' && level === 1 ? 0 : level]));
  }
  return Object.fromEntries(Object.entries(p).map(([k, v]) => [k, RANK[v] ?? 0]));
}

/** The highest level each scope is requested at by any job (`inherit` when a job does not set permissions). */
function requested(wf: WorkflowDecl): Scopes {
  let out: Record<string, number> = {};
  for (const job of Object.values(wf.jobs)) {
    if (job.uses) continue;
    const s = scopesOf(job.permissions ?? wf.permissions);
    if (s === 'inherit') return 'inherit';
    for (const [k, v] of Object.entries(s)) out = { ...out, [k]: Math.max(out[k] ?? 0, v) };
  }
  return out;
}

function permissionChanges(b: WorkflowDecl, h: WorkflowDecl): ImpactChange[] {
  const before = requested(b);
  const after = requested(h);
  if (after === 'inherit') return [];
  const names = ['none', 'read', 'write'];
  const widened = Object.entries(after).filter(
    ([k, v]) => v > 0 && (before === 'inherit' ? v >= 2 || k === 'id-token' : v > (before[k] ?? 0)),
  );
  if (widened.length === 0) return [];
  const list = widened.map(([k, v]) => `${k}: ${names[v]}`).join(', ');
  return [
    {
      unit: h.path,
      kind: 'permissions',
      level: 'major',
      certain: before !== 'inherit',
      message: `jobs now request ${list}; callers that grant less fail when the run starts`,
      loc: fileStart(h.file),
    },
  ];
}

function remoteUses(unit: UnitDecl): Set<string> {
  const out = new Set<string>();
  const steps = unit.kind === 'workflow' ? Object.values(unit.jobs).flatMap((j) => j.steps) : unit.steps;
  for (const s of steps) if (s.uses?.kind === 'remote-action') out.add(s.uses.raw.split('@')[0]!);
  if (unit.kind === 'workflow')
    for (const j of Object.values(unit.jobs))
      if (j.uses?.kind === 'remote-workflow') out.add(j.uses.raw.split('@')[0]!);
  return out;
}

function usesChanges(b: UnitDecl, h: UnitDecl): ImpactChange[] {
  const before = remoteUses(b);
  return [...remoteUses(h)]
    .filter((u) => !before.has(u))
    .sort()
    .map((u) => ({
      unit: h.path,
      kind: 'uses' as const,
      level: 'minor' as const,
      certain: true,
      message: `now uses ${u}; consumers whose organization only allows listed actions (or requires SHA pinning) must allow it`,
      loc: fileStart(h.file),
    }));
}

function runtimeChanges(b: ActionDecl, h: ActionDecl): ImpactChange[] {
  if ((b.using ?? '') === (h.using ?? '')) return [];
  return [
    {
      unit: h.path,
      kind: 'runtime',
      level: 'major',
      certain: true,
      message: `runs.using changed from ${b.using ?? '(none)'} to ${h.using ?? '(none)'}; runners or GHES versions without it cannot run the action`,
      loc: fileStart(h.file),
    },
  ];
}

/** Every graded change to a published unit between `base` and `head`. */
export function impactChanges(
  base: ProjectIndex,
  head: ProjectIndex,
  policy: Pick<ImpactPolicy, 'publish'>,
): ImpactChange[] {
  const out: ImpactChange[] = [];
  const baseUnits = new Map(base.units().map((u) => [u.path, u]));
  const headUnits = new Map(head.units().map((u) => [u.path, u]));
  for (const [path, b] of baseUnits) {
    if (!isPublished(b, policy)) continue;
    const h = headUnits.get(path);
    if (!h || h.kind !== b.kind) {
      out.push({
        unit: path,
        kind: 'unit',
        level: 'major',
        certain: true,
        message: `${b.kind === 'workflow' ? 'reusable workflow' : 'action'} ${path} was removed or moved; consumers that reference it fail`,
        loc: fileStart(b.file),
      });
      continue;
    }
    if (!isPublished(h, policy)) {
      out.push({
        unit: path,
        kind: 'unit',
        level: 'major',
        certain: true,
        message:
          h.kind === 'workflow'
            ? `${path} can no longer be called (no workflow_call)`
            : `${path} is no longer published`,
        loc: fileStart(h.file),
      });
      continue;
    }
    if (b.parseErrors.length || h.parseErrors.length) continue;
    out.push(...interfaceChanges(base, head, b, h), ...usesChanges(b, h));
    if (b.kind === 'workflow' && h.kind === 'workflow')
      out.push(...checkNameChanges(base, head, b, h), ...permissionChanges(b, h));
    if (b.kind === 'action' && h.kind === 'action') out.push(...runtimeChanges(b, h));
  }
  for (const [path, h] of headUnits) {
    if (!isPublished(h, policy)) continue;
    const b = baseUnits.get(path);
    if (b && isPublished(b, policy)) continue;
    out.push({
      unit: path,
      kind: 'unit',
      level: 'minor',
      certain: true,
      message: `new ${h.kind === 'workflow' ? 'reusable workflow' : 'action'} ${path}`,
      loc: fileStart(h.file),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Declared impact and verdict
// ---------------------------------------------------------------------------

export interface DeclaredSource {
  kind: 'explicit' | 'title' | 'labels' | 'version';
  /** What was read, e.g. the title or the label. */
  value: string;
  level: ImpactLevel;
}

/** `feat!: …` → major, `feat: …` → minor, `fix: …` → patch, other types → none; not Conventional → undefined. */
export function levelFromTitle(title: string, types: Record<string, ImpactLevel>): ImpactLevel | undefined {
  const m = /^([a-z]+)(\([^)]*\))?(!)?: \S/i.exec(title.trim());
  if (!m) return undefined;
  if (m[3]) return 'major';
  return types[m[1]!.toLowerCase()] ?? 'none';
}

export function levelFromLabels(labels: string[], map: Record<ImpactLevel, string>): ImpactLevel | undefined {
  const found = IMPACT_LEVELS.filter((l) => labels.some((x) => x.toLowerCase() === map[l].toLowerCase()));
  return found.length ? maxLevel([...found]) : undefined;
}

export interface DeclaredInput {
  explicit?: ImpactLevel;
  title?: string;
  labels?: string[];
  /** A release pull request: the proposed version and the version of the baseline release. */
  release?: { version: string; previous: string; bumpMinorPreMajor: boolean };
}

/** The level a version bump declares (`0.1.4` → `0.2.0` is breaking under `bump-minor-pre-major`). */
export function levelFromVersions(previous: string, next: string, bumpMinorPreMajor: boolean): ImpactLevel {
  const parse = (v: string) =>
    v.replace(/^v/, '').split(/[.-]/).slice(0, 3).map(Number) as [number, number, number];
  const [pa, pb, pc] = parse(previous);
  const [na, nb, nc] = parse(next);
  if (na > pa) return 'major';
  if (nb > pb) return na === 0 && bumpMinorPreMajor ? 'major' : 'minor';
  if (nc > pc) return na === 0 && bumpMinorPreMajor ? 'minor' : 'patch';
  return 'none';
}

export interface ImpactVerdict {
  required: ImpactLevel;
  declared?: DeclaredSource;
  /** Sources that are not authoritative; one declaring more than the authoritative source is a conflict. */
  advisory: DeclaredSource[];
  conflict?: DeclaredSource;
  /** Required impact is covered by the declared one (or nothing is declared). */
  ok: boolean;
}

export function impactVerdict(
  changes: ImpactChange[],
  input: DeclaredInput,
  policy: ImpactPolicy,
): ImpactVerdict {
  const counted = changes.filter((c) => c.certain || policy.uncertain === 'fail');
  const required = maxLevel(counted.map((c) => c.level));
  const sources: DeclaredSource[] = [];
  if (input.explicit) sources.push({ kind: 'explicit', value: input.explicit, level: input.explicit });
  if (input.release) {
    const level = levelFromVersions(
      input.release.previous,
      input.release.version,
      input.release.bumpMinorPreMajor,
    );
    sources.push({ kind: 'version', value: `${input.release.previous} → ${input.release.version}`, level });
  } else if (input.title !== undefined) {
    const level = levelFromTitle(input.title, policy.types);
    if (level) sources.push({ kind: 'title', value: input.title, level });
  }
  if (input.labels?.length) {
    const level = levelFromLabels(input.labels, policy.labels);
    if (level) sources.push({ kind: 'labels', value: input.labels.join(', '), level });
  }
  const order: DeclaredSource['kind'][] = input.release
    ? ['explicit', 'version']
    : [policy.declaredBy ?? 'explicit', 'explicit', 'title', 'labels'];
  const declared = order.map((k) => sources.find((s) => s.kind === k)).find(Boolean);
  const advisory = sources.filter((s) => s !== declared);
  const conflict = declared
    ? advisory.find((s) => levelRank(s.level) > levelRank(declared.level))
    : undefined;
  // `patch` against `none` is not worth failing for: the change reaches users with the next release either way.
  const under =
    declared && levelRank(required) > levelRank(declared.level) && levelRank(required) >= levelRank('minor');
  return {
    required,
    ...(declared ? { declared } : {}),
    advisory,
    ...(conflict ? { conflict } : {}),
    ok: !under && !conflict,
  };
}

/** Impact mode's result: where the baseline came from, every graded change and the verdict. */
export interface ImpactResult {
  baseline: { kind: 'ref' | 'release'; ref: string; commit: string };
  changes: ImpactChange[];
  verdict: ImpactVerdict;
}

/** Grades the changes and judges the declaration in one step. */
export function computeImpact(
  base: ProjectIndex,
  head: ProjectIndex,
  baseline: ImpactResult['baseline'],
  declared: DeclaredInput,
  policy: ImpactPolicy,
): ImpactResult {
  const changes = impactChanges(base, head, policy);
  return { baseline, changes, verdict: impactVerdict(changes, declared, policy) };
}
