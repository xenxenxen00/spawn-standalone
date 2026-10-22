// A game's tracked edits: `<gameDir>/<edits.dir>/<id>.{ts,js,json}` in the order of `<edits.order>` (a YAML list of ids).
//
//   .ts / .js   `export default { id, title, rationale, cites, files, apply(tree, ctx) }` (edit-kit.ts `Edit`)
//   .json       a declarative edit: the same fields with `ops` instead of `apply`, each op asserting its anchor:
//                 { "op": "replaceExact", "path", "from", "to", "count"?: 1, "note"? }
//                 { "op": "replaceLines", "path", "start", "end", "to", "note"? }
//                 { "op": "yamlSet", "path", "key": ["a", 0, "b"], "value", "expectOld"? }
//                 { "op": "yamlDelete", "path", "key": [...] }
//                 { "op": "addFile", "path", "text" | "from": "<file in the game dir>" }
//                 { "op": "deleteFile", "path" }
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { load } from 'js-yaml';
import type { Edit, EditableTree, EditContext } from './edit-kit.ts';

export type EditOp =
  | { op: 'replaceExact'; path: string; from: string; to: string; count?: number; note?: string }
  | { op: 'replaceLines'; path: string; start: string; end: string; to: string; note?: string }
  | { op: 'yamlSet'; path: string; key: (string | number)[]; value: unknown; expectOld?: unknown }
  | { op: 'yamlDelete'; path: string; key: (string | number)[] }
  | { op: 'addFile'; path: string; text?: string; from?: string }
  | { op: 'deleteFile'; path: string };

export interface DeclarativeEdit extends Omit<Edit, 'apply'> {
  ops: EditOp[];
}

/** runs one op through the kit */
export function applyOp(tree: EditableTree, op: EditOp, ctx: EditContext): void {
  switch (op.op) {
    case 'replaceExact':
      return tree.replaceExact(op.path, op.from, op.to, op.count ?? 1, op.note);
    case 'replaceLines':
      return tree.replaceLines(op.path, op.start, op.end, op.to, op.note);
    case 'yamlSet':
      return tree.yamlSet(op.path, op.key, op.value, op.expectOld);
    case 'yamlDelete':
      return tree.yamlDelete(op.path, op.key);
    case 'addFile': {
      const text = op.text ?? (op.from !== undefined ? ctx.readGameFile(op.from) : undefined);
      if (text === undefined) throw new Error(`addFile ${op.path}: neither "text" nor "from"`);
      return tree.addFile(op.path, text);
    }
    case 'deleteFile':
      return tree.deleteFile(op.path);
    default:
      throw new Error(`unknown edit op ${JSON.stringify((op as { op?: unknown }).op)}`);
  }
}

export function fromDeclarative(d: DeclarativeEdit): Edit {
  if (!Array.isArray(d.ops)) throw new Error(`edit ${d.id}: "ops" is not a list`);
  const files = d.files ?? [...new Set(d.ops.map((o) => o.path))];
  return { id: d.id, title: d.title, rationale: d.rationale ?? '', cites: d.cites ?? [], files, apply: (tree, ctx) => d.ops.forEach((op) => applyOp(tree, op, ctx)) };
}

/** The edits named by the order file, in order. No order file: no edits. */
export async function loadEdits(gameDir: string, opts: { dir?: string; order?: string } = {}): Promise<Edit[]> {
  const dir = join(gameDir, opts.dir ?? 'edits');
  const orderFile = join(gameDir, opts.order ?? `${opts.dir ?? 'edits'}/order.yml`);
  if (!existsSync(orderFile)) return [];
  const ids = load(readFileSync(orderFile, 'utf8')) ?? [];
  if (!Array.isArray(ids) || ids.some((x) => typeof x !== 'string')) throw new Error(`${orderFile}: a YAML list of edit ids`);
  const seen = new Set<string>();
  const out: Edit[] = [];
  for (const id of ids as string[]) {
    if (seen.has(id)) throw new Error(`${orderFile}: ${id} is listed twice`);
    seen.add(id);
    const base = join(dir, id);
    let edit: Edit;
    if (existsSync(`${base}.json`)) edit = fromDeclarative(JSON.parse(readFileSync(`${base}.json`, 'utf8')) as DeclarativeEdit);
    else {
      const file = existsSync(`${base}.ts`) ? `${base}.ts` : existsSync(`${base}.js`) ? `${base}.js` : null;
      if (file === null) throw new Error(`edit ${id}: no ${id}.json | .ts | .js in ${dir}`);
      const mod = (await import(pathToFileURL(file).href)) as { default?: Edit | DeclarativeEdit };
      const e = mod.default;
      if (!e || typeof e !== 'object') throw new Error(`${file}: no default export`);
      edit = 'apply' in e && typeof e.apply === 'function' ? e : fromDeclarative(e as DeclarativeEdit);
    }
    if (edit.id !== id) throw new Error(`edit ${id}: the file declares id ${JSON.stringify(edit.id)}`);
    out.push(edit);
  }
  return out;
}
