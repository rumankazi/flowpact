import {
  type Declaration,
  expandMatrix,
  type GraphNode,
  type Json,
  lookup,
  type Occurrence,
  type SymbolLocator,
  type TraceNode,
  trace,
} from '@flowpact/core';

/** Lines of each trace direction shown before the rest are counted. */
const MAX_TRACE_LINES = 12;

const TRACED: GraphNode['kind'][] = [
  'input',
  'secret',
  'output',
  'job-output',
  'step-output',
  'env',
  'matrix',
];

/** Inline code; YAML text may hold backticks and newlines. */
const code = (s: string) => `\`${s.replace(/`/g, "'").replace(/\s+/g, ' ').trim() || ' '}\``;

/** Free text from a repository (descriptions) shown as text, not markdown. */
const text = (s: string) => s.replace(/[\\`*_{}[\]()#+\-.!|<>~]/g, (c) => `\\${c}`);

const json = (v: Json | undefined) => (typeof v === 'string' ? v : JSON.stringify(v));

/** `.github/workflows/ci.yml#inputs.x` → `ci.yml#inputs.x`; actions keep their directory. */
const short = (symbol: string) => symbol.replace(/^\.github\/workflows\//, '').replace(/^\.github\//, '');

const KIND: Partial<Record<GraphNode['kind'], string>> = {
  input: 'input',
  secret: 'secret',
  output: 'output',
  'job-output': 'job output',
  'step-output': 'step output',
  env: 'environment variable',
  matrix: 'matrix key',
  job: 'job',
  var: 'configuration variable',
  remote: 'remote reference',
  workflow: 'workflow',
  action: 'action',
};

/** Markdown for hovering a symbol: what it is, how it is declared, where its value comes from and goes. */
export function hoverMarkdown(locator: SymbolLocator, at: Occurrence): string {
  const index = locator.index;
  const node = index.nodes.get(at.symbol);
  const decls = locator.declarations(at.symbol);
  const kind = node?.kind ?? (at.symbol.startsWith('remote:') ? 'remote' : 'unresolved');
  const label = at.symbol.startsWith('remote:')
    ? at.symbol.slice('remote:'.length)
    : at.symbol.includes('#')
      ? at.symbol.slice(at.symbol.indexOf('#') + 1)
      : (node?.label ?? at.symbol);
  const unit = node?.unit && node.unit !== at.symbol ? ` in ${code(node.unit)}` : '';
  const out = [`${code(label)} — ${KIND[kind] ?? 'symbol'}${unit}`];

  const first = decls[0];
  const details = first ? describe(locator, first) : undeclared(kind);
  if (details.length) out.push('', ...details);
  // A calling job's outputs are declared by the callee, a step's by its action.
  if (first && first.kind !== 'unit' && node?.unit && first.unit !== node.unit)
    out.push('', `Declared in ${code(first.unit)}.`);
  if (decls.length > 1) out.push('', `Declared in ${decls.length} places.`);

  if (TRACED.includes(kind)) {
    for (const direction of ['up', 'down'] as const) {
      const lines = traceLines(trace(index, at.symbol, { direction, maxDepth: 8 }));
      if (lines.length) out.push('', `**${direction === 'up' ? 'Comes from' : 'Flows to'}**`, '', ...lines);
    }
  }
  return out.join('\n');
}

function describe(locator: SymbolLocator, d: Declaration): string[] {
  switch (d.kind) {
    case 'input': {
      const i = d.decl;
      const facts = [
        i.type ? `type ${code(i.type)}` : undefined,
        i.required ? 'required' : 'optional',
        i.hasDefault ? `default ${code(json(i.default))}` : undefined,
        i.options?.length ? `one of ${i.options.map(code).join(', ')}` : undefined,
      ];
      return [facts.filter(Boolean).join(' · '), ...(i.description ? ['', text(i.description)] : [])];
    }
    case 'secret':
      return [
        d.decl.required ? 'required' : 'optional',
        ...(d.decl.description ? ['', text(d.decl.description)] : []),
      ];
    case 'output':
      return [
        ...(d.decl.description ? [text(d.decl.description)] : []),
        ...(d.decl.value !== undefined ? [`value ${code(json(d.decl.value))}`] : []),
      ];
    case 'job': {
      const j = d.decl;
      const lines: string[] = [];
      if (j.name) lines.push(`name ${code(j.name)}`);
      if (j.uses) lines.push(`calls ${code(j.uses.raw)}`);
      if (j.needs.length) lines.push(`needs ${j.needs.map((n) => code(n.id)).join(', ')}`);
      if (j.matrix) {
        const n = expandMatrix(j.matrix).combos.length;
        lines.push(
          j.matrix.dynamic ? 'matrix computed at runtime' : `${n} matrix combination${n === 1 ? '' : 's'}`,
        );
      }
      return [lines.join(' · ')].filter(Boolean);
    }
    case 'env':
      return [`value ${code(json(d.decl.value))}`];
    case 'matrix': {
      const exp = expandMatrix(d.job.matrix);
      if (exp.dynamic) return ['The matrix is computed at runtime.'];
      const values = new Set<string>();
      for (const combo of exp.combos) {
        const cell = lookup(combo.values, d.key);
        values.add(cell ? (cell.known ? json(cell.value as Json) : '<expression>') : '(unset)');
      }
      return [`values ${[...values].map(code).join(', ')}`];
    }
    case 'step':
      return [
        d.decl.uses
          ? `Outputs of ${code(d.decl.uses.raw)}; not declared, so not verified.`
          : 'Outputs written by the step’s script.',
      ];
    case 'unit': {
      const u = d.decl;
      const lines = u.name ? [`name ${code(u.name)}`] : [];
      if (u.kind === 'workflow') {
        if (u.triggers.length) lines.push(`on ${u.triggers.map(code).join(', ')}`);
        const callers = locator.index.callersOf(u.path).length;
        if (u.call) lines.push(`called by ${callers} job${callers === 1 ? '' : 's'}`);
      } else {
        const users = locator.index.usersOf(u.path).length;
        lines.push(`used by ${users} step${users === 1 ? '' : 's'}`);
      }
      return [lines.join(' · ')];
    }
  }
}

function undeclared(kind: string): string[] {
  switch (kind) {
    case 'var':
      return ['Set in the repository, environment or organization settings, not in workflow files.'];
    case 'remote':
      return ['In another repository; its interface is not verified.'];
    case 'secret':
    case 'unresolved':
      return ['Not declared in any file flowpact analyzes.'];
    default:
      return ['Not declared.'];
  }
}

function traceLines(root: TraceNode): string[] {
  const lines: string[] = [];
  let more = 0;
  const walk = (n: TraceNode, depth: number) => {
    const indent = '  '.repeat(depth);
    for (const child of n.children) {
      if (lines.length >= MAX_TRACE_LINES) {
        more++;
        continue;
      }
      const via = child.via ? ` via ${code(child.via.text)}` : '';
      const stop = child.stop === 'cycle' ? ' (cycle)' : child.stop === 'depth' ? ' …' : '';
      lines.push(`${indent}- ${code(short(child.symbol))}${via}${stop}`);
      walk(child, depth + 1);
    }
    for (const leaf of n.leaves) {
      if (lines.length >= MAX_TRACE_LINES) {
        more++;
        continue;
      }
      lines.push(`${indent}- ${leaf.role} in ${code(leaf.where)}: ${code(leaf.text)}`);
    }
  };
  walk(root, 0);
  if (more) lines.push(`- … ${more} more (see \`flowpact trace\`)`);
  return lines;
}
