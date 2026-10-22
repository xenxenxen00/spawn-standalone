// Config key paths of world.config.yaml and places/<p>/config.yaml, with the line each key sits on.
import { load } from 'js-yaml';

export interface ConfigKey {
  /** dotted key path with user-named keys collapsed to `*` (`inputs.actions.*.keys`) */
  path: string;
  /** the scalar at the path, as text; absent for lists and empty maps */
  value?: string;
  line: number;
}

/** maps whose children are named by the game, not by the engine: [parent path, depth of the name] */
const USER_NAMED: ReadonlyArray<readonly [readonly string[], number]> = [
  [['inputs', 'actions'], 2],
  [['inputs', 'axes'], 2],
  [['achievements'], 1],
  [['leaderboards'], 1],
];

function collapse(path: readonly string[]): string[] {
  const out = [...path];
  for (const [parent, depth] of USER_NAMED) {
    if (out.length > depth && parent.every((p, i) => out[i] === p)) out[depth] = '*';
  }
  return out;
}

/** first line of each key path, by indentation; block-style YAML only (a flow mapping's keys fall back to its parent) */
export function keyLines(text: string): Map<string, number> {
  const lines = new Map<string, number>();
  const stack: Array<{ indent: number; key: string }> = [];
  const rows = text.split(/\r?\n/);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    if (/^\s*(#|$)/.test(row)) continue;
    const m = /^(\s*(?:-\s+)*)(["']?)([^:"'#]+?)\2\s*:(?:\s|$)/.exec(row);
    if (!m) continue;
    const indent = m[1]!.length;
    while (stack.length > 0 && stack[stack.length - 1]!.indent >= indent) stack.pop();
    stack.push({ indent, key: m[3]!.trim() });
    const joined = stack.map((s) => s.key).join('\u0000');
    if (!lines.has(joined)) lines.set(joined, i + 1);
  }
  return lines;
}

function lineFor(lines: Map<string, number>, raw: readonly string[]): number {
  for (let n = raw.length; n > 0; n--) {
    const hit = lines.get(raw.slice(0, n).join('\u0000'));
    if (hit !== undefined) return hit;
  }
  return 1;
}

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parses one YAML config and lists its leaf key paths. Throws the parser's error on invalid YAML. */
export function scanConfig(text: string): ConfigKey[] {
  const doc = load(text);
  if (!isMap(doc)) return [];
  const lines = keyLines(text);
  const out: ConfigKey[] = [];
  const visit = (node: unknown, raw: string[]): void => {
    if (isMap(node) && Object.keys(node).length > 0) {
      for (const [k, v] of Object.entries(node)) visit(v, [...raw, k]);
      return;
    }
    if (raw.length === 0) return;
    const key: ConfigKey = { path: collapse(raw).join('.'), line: lineFor(lines, raw) };
    if (typeof node === 'string' || typeof node === 'number' || typeof node === 'boolean') key.value = String(node);
    out.push(key);
  };
  visit(doc, []);
  return out;
}
