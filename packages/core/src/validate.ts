import { FeatureFlags } from '@actions/expressions/features';
import { NoOperationTraceWriter, parseWorkflow } from '@actions/workflow-parser';
import { parseAction } from '@actions/workflow-parser/actions/action-parser';
import type { TemplateSchema } from '@actions/workflow-parser/templates/schema/template-schema';
import {
  TemplateContext,
  TemplateValidationErrors,
} from '@actions/workflow-parser/templates/template-context';
import { isMap, isScalar, isSeq, LineCounter, parseDocument } from 'yaml';
import { CONTEXT_FUNCTIONS, KNOWN_CONTEXTS } from './expressions';
import type { Diagnostic, UnitDecl } from './ir';
import type { Logger } from './logger';
import { didYouMean } from './rules/util';
import { mappingsAt, SCHEMA_ROOT, schemaFor, workflowSchema } from './schema';
import type { Loc } from './source';

/** Syntax problems are reported by FP502 with better positions; drop the parser's duplicates. */
const SYNTAX_NOISE = [/Unexpected symbol/i, /Unexpected end of expression/i, /Unclosed expression/i];

/** Action metadata that GitHub's schema requires but the runner does not need for local actions. */
const LOCAL_ACTION_NOISE = /Required property is missing: (name|description)\b/i;

const CONTEXT_NAMES = new Set<string>(KNOWN_CONTEXTS);
const FUNCTION_NAMES = new Set(CONTEXT_FUNCTIONS.map((f) => f.name.toLowerCase()));

/**
 * GitHub runs background steps (`background`, `wait`, `wait-all`, `cancel`); @actions/workflow-parser 0.3.61 rejects
 * them unless the caller turns on this experimental flag.
 */
const WORKFLOW_FEATURES = new FeatureFlags({ allowBackgroundSteps: true });

/** Event filters: keys GitHub uses to decide whether an event triggers the workflow. */
const EVENT_FILTERS = [
  'branches',
  'branches-ignore',
  'tags',
  'tags-ignore',
  'paths',
  'paths-ignore',
  'types',
  'workflows',
];

/**
 * "Unrecognized named-value: 'env'" for a context flowpact knows means the context is not available in that field
 * (GitHub's context-availability rules); for an unknown name it is a typo already reported by FP502.
 */
function classify(message: string): 'drop' | 'context' | 'schema' {
  if (SYNTAX_NOISE.some((re) => re.test(message))) return 'drop';
  const named = /Unrecognized named-value: '([^']+)'/i.exec(message);
  if (named) return CONTEXT_NAMES.has(named[1]!.toLowerCase()) ? 'context' : 'drop';
  const fn = /Unrecognized function: '([^']+)'/i.exec(message);
  if (fn) return FUNCTION_NAMES.has(fn[1]!.toLowerCase()) ? 'context' : 'drop';
  return 'schema';
}

interface ParserError {
  message: string;
  range?: { start: { line: number; column: number }; end: { line: number; column: number } };
}

function workflowContext(): TemplateContext {
  const context = new TemplateContext(
    new TemplateValidationErrors(),
    workflowSchema(),
    new NoOperationTraceWriter(),
  );
  context.state.featureFlags = WORKFLOW_FEATURES;
  return context;
}

/**
 * Validates a workflow or action against GitHub's schema using @actions/workflow-parser
 * (the parser behind GitHub's Actions language service). Never throws: if the parser itself fails,
 * validation is skipped for that file and the reason is logged.
 */
export function validateSchema(unit: UnitDecl, logger: Logger): Diagnostic[] {
  try {
    const file = { name: unit.file, content: unit.source.text };
    const result =
      unit.kind === 'workflow'
        ? parseWorkflow(file, workflowContext())
        : parseAction(file, new NoOperationTraceWriter());
    const errors = result.context.errors.getErrors() as ParserError[];
    const diagnostics = errors
      .filter((e) => classify(e.message) !== 'drop')
      .filter((e) => !(unit.kind === 'action' && LOCAL_ACTION_NOISE.test(e.message)))
      .map((e): Diagnostic => {
        const r = e.range;
        const at = /\(Line: (\d+), Col: (\d+)\)/.exec(e.message);
        const message = e.message
          .replace(/^[^:]*\.ya?ml(?: \(Line: \d+, Col: \d+\))?:\s*/, '')
          .replace(/\.\s*Located at position \d+ within expression:.*$/s, '');
        return {
          message,
          ...(classify(e.message) === 'context' ? { kind: 'context' as const } : {}),
          ...(at ? { at: { line: Number(at[1]), column: Number(at[2]) } } : {}),
          loc: r
            ? {
                file: unit.file,
                line: r.start.line,
                column: r.start.column,
                endLine: r.end.line,
                endColumn: r.end.column,
              }
            : { file: unit.file, line: 1, column: 1, endLine: 1, endColumn: 1 },
        };
      });
    return explain(unit, diagnostics);
  } catch (err) {
    logger.debug(`schema validation skipped for ${unit.file}`, { reason: (err as Error).message });
    return [];
  }
}

type Path = (string | number)[];

interface MapNode {
  path: Path;
  keys: KeyNode[];
}

interface KeyNode {
  name: string;
  map: MapNode;
  loc: Loc;
}

/** Every mapping and key of the file, by the `line:column` where the parser reports problems with them. */
interface Shape {
  maps: Map<string, MapNode>;
  keys: Map<string, KeyNode>;
}

const posKey = (line: number, column: number) => `${line}:${column}`;

function shapeOf(unit: UnitDecl): Shape | undefined {
  const lineCounter = new LineCounter();
  const doc = parseDocument(unit.source.text, { lineCounter, prettyErrors: false, strict: false });
  if (doc.errors.length > 0) return undefined;
  const shape: Shape = { maps: new Map(), keys: new Map() };
  const walk = (node: unknown, path: Path): void => {
    if (isSeq(node)) {
      for (const [i, item] of node.items.entries()) walk(item, [...path, i]);
      return;
    }
    // Aliases are not followed: the parser reports problems in aliased content at the anchored node.
    if (!isMap(node)) return;
    const map: MapNode = { path, keys: [] };
    if (node.range) {
      const p = lineCounter.linePos(node.range[0]);
      shape.maps.set(posKey(p.line, p.col), map);
    }
    for (const pair of node.items) {
      if (!isScalar(pair.key) || !pair.key.range) continue;
      const name = String(pair.key.value);
      const a = lineCounter.linePos(pair.key.range[0]);
      const b = lineCounter.linePos(pair.key.range[1]);
      const loc = { file: unit.file, line: a.line, column: a.col, endLine: b.line, endColumn: b.col };
      const key: KeyNode = { name, map, loc };
      map.keys.push(key);
      shape.keys.set(posKey(a.line, a.col), key);
      walk(pair.value, [...path, name]);
    }
  };
  walk(doc.contents, []);
  return shape;
}

/**
 * Turns parser errors into what GitHub actually does: one finding per step (or job) whose keys mix two shapes, and
 * keys GitHub silently ignores marked as such instead of as errors that stop the run.
 */
function explain(unit: UnitDecl, diagnostics: Diagnostic[]): Diagnostic[] {
  if (!diagnostics.some((d) => !d.kind)) return diagnostics;
  const shape = shapeOf(unit);
  if (!shape) return diagnostics;
  const schema = schemaFor(unit.kind);
  const root = SCHEMA_ROOT[unit.kind];

  const keyOf = new Map<Diagnostic, KeyNode>();
  const groups = new Map<MapNode, Diagnostic[]>();
  for (const d of diagnostics) {
    if (d.kind) continue;
    const pos = posKey(d.loc.line, d.loc.column);
    const unexpected = /^Unexpected value '(.*)'$/s.exec(d.message);
    const key = unexpected ? shape.keys.get(pos) : undefined;
    let map: MapNode | undefined;
    if (key && key.name === unexpected![1]) {
      keyOf.set(d, key);
      map = key.map;
    } else if (d.message.startsWith('Required property is missing: ')) {
      map = shape.maps.get(pos);
    }
    if (map) groups.set(map, [...(groups.get(map) ?? []), d]);
  }

  // `undefined`: drop the diagnostic, it is covered by the merged one.
  const replaced = new Map<Diagnostic, Diagnostic | undefined>();
  for (const [map, group] of groups) {
    if (group.length < 2) continue;
    const merged = mergeAlternatives(map, group, schema, root);
    if (!merged) continue;
    for (const [i, d] of group.entries()) replaced.set(d, i === 0 ? merged : undefined);
  }

  const out: Diagnostic[] = [];
  for (const d of diagnostics) {
    if (replaced.has(d)) {
      const merged = replaced.get(d);
      if (merged) out.push(merged);
      continue;
    }
    const key = keyOf.get(d);
    const ignored = key ? ignoredKey(unit.kind, key, schema, root) : undefined;
    out.push(ignored ? { ...d, kind: 'ignored', ...ignored } : d);
  }
  return out;
}

/**
 * The parser picks between alternative shapes (a `run` or a `uses` step, a job that runs steps or calls a workflow)
 * by the first key that only some of them allow, then reports every other key against that choice. One wrong key can
 * produce four errors that blame the right ones. Report the shape the mapping fits best instead, once.
 */
function mergeAlternatives(
  map: MapNode,
  group: Diagnostic[],
  schema: TemplateSchema,
  root: string,
): Diagnostic | undefined {
  const shapes = mappingsAt(schema, root, map.path);
  if (shapes.length < 2) return undefined;
  const names = new Set(map.keys.map((k) => k.name));
  const scored = shapes
    .map((def) => {
      const unexpected = def.looseKeyType ? [] : map.keys.filter((k) => !def.properties[k.name]);
      const missing = Object.entries(def.properties)
        .filter(([name, p]) => p.required && !names.has(name))
        .map(([name]) => name);
      return { def, unexpected, missing, score: unexpected.length + missing.length };
    })
    .sort((a, b) => a.score - b.score);
  const [best, runnerUp] = scored;
  // No clear winner: the parser's own errors are as good an explanation as any.
  if (!best || !runnerUp || best.score === 0 || best.score === runnerUp.score) return undefined;

  const others = shapes.filter((s) => s !== best.def);
  const own = map.keys.filter(
    (k) => best.def.properties[k.name] && !others.some((o) => o.properties[k.name]),
  );
  const anchor = own.find((k) => best.def.properties[k.name]!.required) ?? own[0];
  const parts: string[] = [];
  if (best.unexpected.length > 0) {
    const list = best.unexpected.map((k) => `'${k.name}'`).join(', ');
    const s = best.unexpected.length > 1 ? 's' : '';
    parts.push(
      `Unexpected value${s} ${list}${anchor ? ` (not allowed together with \`${anchor.name}\`)` : ''}`,
    );
  }
  if (best.missing.length > 0) {
    parts.push(
      best.missing.length > 1
        ? `Required properties are missing: ${best.missing.join(', ')}`
        : `Required property is missing: ${best.missing[0]}`,
    );
  }
  const mapLoc =
    group.find((d) => d.message.startsWith('Required property is missing: '))?.loc ?? group[0]!.loc;
  return { message: parts.join('; '), loc: best.unexpected[0]?.loc ?? mapLoc };
}

/**
 * Keys GitHub accepts and ignores, unlike the strict schema the parser (and GitHub's editor tooling) validates with:
 * - unknown top-level keys of action metadata: the runner reads action.yml with a schema that allows any extra key;
 * - unknown keys under an event in `on:`: GitHub reads only the filters each event supports (`workflow_call`, which
 *   declares an interface, is validated in full).
 */
function ignoredKey(
  kind: UnitDecl['kind'],
  key: KeyNode,
  schema: TemplateSchema,
  root: string,
): { message: string; fix: string } | undefined {
  const { path } = key.map;
  const shapes = mappingsAt(schema, root, path);
  const known = [...new Set(shapes.flatMap((s) => Object.keys(s.properties)))];
  // The error is about another occurrence of this key (YAML aliases report at the anchored node).
  if (known.includes(key.name)) return undefined;
  const guess = didYouMean(key.name, known);
  const hint = guess ? ` (did you mean \`${guess}\`?)` : '';
  const rename = guess ? `Rename it to \`${guess}\`.` : undefined;

  if (kind === 'action' && path.length === 0) {
    if (key.name === 'env') {
      return {
        message:
          "GitHub ignores this key: actions have no top-level `env`, so the action's steps never see these values",
        fix: 'Set the variables in `env:` on the steps that read them, or declare them as inputs.',
      };
    }
    return {
      message: `GitHub ignores this key: action metadata has no \`${key.name}\`${hint}, so it has no effect`,
      fix: rename ?? 'Remove it.',
    };
  }

  const event = path[1];
  if (
    kind === 'workflow' &&
    path.length === 2 &&
    path[0] === 'on' &&
    typeof event === 'string' &&
    event !== 'workflow_call' &&
    shapes.length > 0
  ) {
    const filter = didYouMean(key.name, EVENT_FILTERS) !== undefined;
    return {
      message: `GitHub ignores this key: the \`${event}\` event does not support \`${key.name}\`${hint}, ${filter ? 'so the workflow runs regardless of it' : 'so it has no effect'}`,
      fix: rename ?? (filter ? "Remove it, or check the condition in a job's `if:` instead." : 'Remove it.'),
    };
  }
  return undefined;
}
