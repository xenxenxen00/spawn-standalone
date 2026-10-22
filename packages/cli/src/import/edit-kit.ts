// Copied from purge-protocol-web ebab692 tools/import-live/edit-kit.ts. Added: `addFile` (an edit may add a file; it asserts
// the path is free), string edit ids, a game-neutral EditContext (flags + readGameFile).
// The edit kit (build §4.3): every operation asserts its anchor count, or throws (fail loudly, never fuzzy).
//
// JS files get a `// PORT-EDIT <id>: <note>` comment line before each changed block (X-17), with the indentation of the
// first changed line. The kit refuses an edit whose marker would land inside a string or template literal.
// YAML edits are surgical text edits located with the `yaml` CST ranges (comments and layout kept), checked by parsing the
// file before and after with js-yaml (the parser the build uses) and comparing everything except the edited key.
import { load } from 'js-yaml';
import { isCollection, isMap, isScalar, isSeq, parseDocument, visit, type Document, type Node as YamlNode, type Pair } from 'yaml';
import { scanJs } from '@spawn-standalone/vite/analysis';

export type EditId = string;

export interface EditableTree {
  read(path: string): string;
  /** exists in the staged tree */
  has(path: string): boolean;
  replaceExact(path: string, from: string, to: string, expectCount?: number, note?: string): void;
  /** inclusive block from the line holding `startAnchor` to the line holding `endAnchor`; each anchor unique in the file */
  replaceLines(path: string, startAnchor: string, endAnchor: string, replacement: string, note?: string): void;
  deleteFile(path: string): void;
  /** adds a new file; the path must not exist in the staged tree */
  addFile(path: string, text: string): void;
  /** surgical text edit of one scalar, comments kept; `expectOld` (when given) must equal the parsed old value */
  yamlSet(path: string, keyPath: (string | number)[], value: unknown, expectOld?: unknown): void;
  /** removes one key (block or flow mapping) or sequence item; leading comment lines attached to a block key go with it */
  yamlDelete(path: string, keyPath: (string | number)[]): void;
}

export interface Edit {
  id: EditId;
  title: string;
  rationale: string;
  /** e.g. ['spawn-engine-contract.md §39.5', 'DR-07'] */
  cites: string[];
  /** files it touches */
  files: string[];
  apply(tree: EditableTree, ctx: EditContext): void;
}

export interface EditContext {
  /** the game's port flags (standalone config `flags`) */
  flags: Readonly<Record<string, unknown>>;
  /** reads a file of the game workspace (relative to its directory) */
  readGameFile(name: string): string;
}

export interface OpRecord {
  op: 'replaceExact' | 'replaceLines' | 'deleteFile' | 'addFile' | 'yamlSet' | 'yamlDelete';
  path: string;
  /** a short form of the anchor or key path */
  anchor: string;
  expected: number;
  found: number;
}

export class AnchorError extends Error {
  readonly editId: string;
  readonly path: string;
  constructor(editId: string, path: string, message: string) {
    super(`${editId} ${path}: ${message}`);
    this.name = 'AnchorError';
    this.editId = editId;
    this.path = path;
  }
}

const short = (s: string, n = 80): string => {
  const one = s.replace(/\r?\n/g, '⏎');
  return one.length > n ? `${one.slice(0, n - 1)}…` : one;
};

const count = (hay: string, needle: string): number => {
  if (!needle) return 0;
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
};

/** js-yaml parses by exact text, never mutated: each YAML op's "after" is the next op's "before" (bounded) */
const LOAD_CACHE = new Map<string, unknown>();
const loadShared = (text: string): unknown => {
  if (LOAD_CACHE.has(text)) return LOAD_CACHE.get(text);
  const v = load(text) as unknown;
  if (LOAD_CACHE.size >= 64) LOAD_CACHE.delete(LOAD_CACHE.keys().next().value!);
  LOAD_CACHE.set(text, v);
  return v;
};

const isJs = (p: string): boolean => p.endsWith('.js');
const isYaml = (p: string): boolean => /\.(ya?ml|scene)$/.test(p);

/** A mutable staged tree (path → text) that one edit at a time works on through the kit. */
export class StagedTree {
  readonly files: Map<string, Buffer>;
  /** path → the yaml Document of the exact text it was parsed from (see yamlSet: a scalar swap shifts it in place) */
  readonly yamlDocs = new Map<string, { text: string; doc: Document.Parsed }>();
  constructor(files: Map<string, Buffer>) {
    this.files = files;
  }
  /** a kit bound to one edit id (markers, error messages, op records) */
  kit(edit: Pick<Edit, 'id' | 'title'>, ops: OpRecord[]): EditableTree {
    return new Kit(this, edit, ops);
  }
}

class Kit implements EditableTree {
  private readonly st: StagedTree;
  private readonly id: string;
  private readonly title: string;
  private readonly ops: OpRecord[];

  constructor(st: StagedTree, edit: Pick<Edit, 'id' | 'title'>, ops: OpRecord[]) {
    this.st = st;
    this.id = edit.id;
    this.title = edit.title;
    this.ops = ops;
  }

  private fail(path: string, msg: string): never {
    throw new AnchorError(this.id, path, msg);
  }

  has(path: string): boolean {
    return this.st.files.has(path);
  }

  read(path: string): string {
    const b = this.st.files.get(path);
    if (!b) this.fail(path, 'file is not in the staged tree');
    return b.toString('utf8');
  }

  private write(path: string, text: string): void {
    this.st.files.set(path, Buffer.from(text, 'utf8'));
  }

  private marker(note: string | undefined, indent: string): string {
    return `${indent}// PORT-EDIT ${this.id}: ${note ?? this.title}`;
  }

  /** a marker inside a string or template literal would change the program: refuse */
  private checkJs(path: string, text: string): void {
    for (const s of scanJs(text).strings) {
      if (s.value.includes('PORT-EDIT')) this.fail(path, `a PORT-EDIT marker landed inside a string literal (line ${s.line})`);
    }
  }

  replaceExact(path: string, from: string, to: string, expectCount = 1, note?: string): void {
    const text = this.read(path);
    const found = count(text, from);
    this.ops.push({ op: 'replaceExact', path, anchor: short(from), expected: expectCount, found });
    if (found !== expectCount) this.fail(path, `anchor ${JSON.stringify(short(from))} found ${found}×, expected ${expectCount}×`);
    if (!isJs(path)) {
      this.write(path, text.split(from).join(to));
      return;
    }
    // JS: walk the occurrences forward; each gets a marker line before the line it starts on (one per line)
    const hits: number[] = [];
    for (let i = text.indexOf(from); i >= 0; i = text.indexOf(from, i + from.length)) hits.push(i);
    let out = '';
    let at = 0;
    let lastMarkedLine = -1;
    for (const idx of hits) {
      const lineStart = text.lastIndexOf('\n', idx - 1) + 1;
      const wholeLines = to === '' && idx === lineStart && from.endsWith('\n');
      if (lineStart >= at && lineStart !== lastMarkedLine) {
        // whole lines removed: the marker takes their place, indented like the first removed line
        const indent = /^[ \t]*/.exec(wholeLines ? from : text.slice(lineStart))![0];
        out += `${text.slice(at, lineStart)}${this.marker(note, indent)}\n${text.slice(lineStart, idx)}`;
        lastMarkedLine = lineStart;
      } else out += text.slice(at, idx);
      out += to;
      at = idx + from.length;
    }
    out += text.slice(at);
    this.checkJs(path, out);
    this.write(path, out);
  }

  replaceLines(path: string, startAnchor: string, endAnchor: string, replacement: string, note?: string): void {
    const text = this.read(path);
    const ns = count(text, startAnchor);
    const ne = count(text, endAnchor);
    this.ops.push({ op: 'replaceLines', path, anchor: `${short(startAnchor, 40)} … ${short(endAnchor, 40)}`, expected: 1, found: Math.max(ns, ne) === 1 && Math.min(ns, ne) === 1 ? 1 : ns === 1 ? ne : ns });
    if (ns !== 1) this.fail(path, `start anchor ${JSON.stringify(short(startAnchor))} found ${ns}×, expected 1×`);
    if (ne !== 1) this.fail(path, `end anchor ${JSON.stringify(short(endAnchor))} found ${ne}×, expected 1×`);
    const s = text.indexOf(startAnchor);
    const e = text.indexOf(endAnchor);
    if (e < s) this.fail(path, 'end anchor precedes the start anchor');
    const lineStart = text.lastIndexOf('\n', s - 1) + 1;
    const nl = text.indexOf('\n', e + endAnchor.length - 1);
    const lineEnd = nl < 0 ? text.length : nl + 1;
    const body = replacement === '' || replacement.endsWith('\n') ? replacement : `${replacement}\n`;
    let out: string;
    if (isJs(path)) {
      const indent = /^[ \t]*/.exec(text.slice(lineStart))![0];
      out = `${text.slice(0, lineStart)}${this.marker(note, indent)}\n${body}${text.slice(lineEnd)}`;
      this.checkJs(path, out);
    } else out = `${text.slice(0, lineStart)}${body}${text.slice(lineEnd)}`;
    this.write(path, out);
  }

  deleteFile(path: string): void {
    const found = this.st.files.has(path) ? 1 : 0;
    this.ops.push({ op: 'deleteFile', path, anchor: path, expected: 1, found });
    if (!found) this.fail(path, 'deleteFile: file is not in the staged tree');
    this.st.files.delete(path);
  }

  addFile(path: string, text: string): void {
    const found = this.st.files.has(path) ? 1 : 0;
    this.ops.push({ op: 'addFile', path, anchor: path, expected: 0, found });
    if (found) this.fail(path, 'addFile: the file exists already in the staged tree');
    if (!/^[\w.-]+(?:\/[\w.-]+)*$/.test(path) || path.split('/').includes('..')) this.fail(path, 'addFile: not a tree path');
    this.st.files.set(path, Buffer.from(text, 'utf8'));
  }

  // ---------------------------------------------------------------- YAML

  /** the yaml Document of : the one kept for this exact text, else a fresh parse */
  private yamlDoc(path: string, text: string): Document.Parsed {
    const kept = YAML_REUSE === '0' ? undefined : this.st.yamlDocs.get(path);
    if (kept && kept.text === text) {
      if (YAML_REUSE === 'verify') {
        const a = docShape(kept.doc);
        const b = docShape(parseYaml(text));
        if (a !== b) this.fail(path, 'internal: the shifted yaml document differs from a fresh parse');
      }
      return kept.doc;
    }
    this.st.yamlDocs.delete(path);
    const doc = parseYaml(text);
    this.st.yamlDocs.set(path, { text, doc });
    return doc;
  }

  private locate(path: string, text: string, keyPath: (string | number)[]): { doc: Document.Parsed; node: YamlNode; pair: Pair | null; parent: YamlNode | null } {
    if (!isYaml(path)) this.fail(path, 'yaml operation on a non-YAML file');
    const doc = this.yamlDoc(path, text);
    if (doc.errors.length) this.fail(path, `cannot parse: ${doc.errors[0]!.message}`);
    let node: unknown = doc.contents;
    let pair: Pair | null = null;
    let parent: YamlNode | null = null;
    for (const k of keyPath) {
      if (isMap(node)) {
        const hits = node.items.filter((it) => isScalar(it.key) && String(it.key.value) === String(k));
        if (hits.length !== 1) this.fail(path, `key path ${JSON.stringify(keyPath)}: ${JSON.stringify(k)} found ${hits.length}×, expected 1×`);
        parent = node;
        pair = hits[0]!;
        node = pair.value;
      } else if (isSeq(node) && typeof k === 'number') {
        if (k < 0 || k >= node.items.length) this.fail(path, `key path ${JSON.stringify(keyPath)}: index ${k} out of range`);
        parent = node;
        pair = null;
        node = node.items[k];
      } else this.fail(path, `key path ${JSON.stringify(keyPath)}: cannot descend at ${JSON.stringify(k)}`);
    }
    if (!node || typeof node !== 'object' || !('range' in node) || !(node as YamlNode).range) {
      this.fail(path, `key path ${JSON.stringify(keyPath)}: no value node`);
    }
    return { doc, node: node as YamlNode, pair, parent };
  }

  /** the parsed file (js-yaml) must equal `before` with exactly this change */
  private verifyYaml(path: string, beforeText: string, afterText: string, keyPath: (string | number)[], change: { set: unknown } | { delete: true }): void {
    const before = structuredClone(loadShared(beforeText)) as unknown;
    const after = loadShared(afterText);
    let cur = before as Record<string | number, unknown>;
    for (const k of keyPath.slice(0, -1)) cur = cur[k] as Record<string | number, unknown>;
    const last = keyPath[keyPath.length - 1]!;
    if ('set' in change) cur[last] = change.set;
    else if (Array.isArray(cur) && typeof last === 'number') cur.splice(last, 1);
    else delete cur[last];
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      this.fail(path, `yaml edit of ${JSON.stringify(keyPath)} changed more than the target (or parsed differently)`);
    }
  }

  yamlSet(path: string, keyPath: (string | number)[], value: unknown, expectOld?: unknown): void {
    const text = this.read(path);
    const { doc, node } = this.locate(path, text, keyPath);
    this.ops.push({ op: 'yamlSet', path, anchor: keyPath.join('.'), expected: 1, found: 1 });
    if (!isScalar(node)) this.fail(path, `yamlSet ${JSON.stringify(keyPath)}: target is not a scalar`);
    if (expectOld !== undefined && node.value !== expectOld) {
      this.fail(path, `yamlSet ${JSON.stringify(keyPath)}: old value ${JSON.stringify(node.value)}, expected ${JSON.stringify(expectOld)}`);
    }
    const [start, end] = node.range!;
    const inFlow = /[{[][^}\]]*$/.test(text.slice(text.lastIndexOf('\n', start - 1) + 1, start));
    const rendered = renderScalar(value, node.type, inFlow);
    const out = text.slice(0, start) + rendered + text.slice(end);
    this.verifyYaml(path, text, out, keyPath, { set: value });
    this.write(path, out);
    // keep the parsed document for the next op on this file when the swap is one single-line scalar token for
    // another: every offset at or after the old token's end moves by the length change, nothing else changes
    this.st.yamlDocs.delete(path);
    const kind = scalarSwap(text.slice(start, end), node.type, rendered, value);
    if (kind && YAML_REUSE !== '0') {
      const delta = rendered.length - (end - start);
      const seen = new Set<number[]>();
      const shift = (r: number[] | undefined | null): void => {
        if (!r || seen.has(r)) return;
        seen.add(r);
        for (let i = 0; i < r.length; i++) if (r[i]! >= end) r[i] = r[i]! + delta;
      };
      shift(doc.range as number[]);
      visit(doc, (_k, n) => {
        if (n && typeof n === 'object' && 'range' in n) shift((n as { range?: number[] }).range);
      });
      node.value = value;
      node.type = kind;
      this.st.yamlDocs.set(path, { text: out, doc });
    }
  }

  yamlDelete(path: string, keyPath: (string | number)[]): void {
    const text = this.read(path);
    const { node, pair, parent } = this.locate(path, text, keyPath);
    this.ops.push({ op: 'yamlDelete', path, anchor: keyPath.join('.'), expected: 1, found: 1 });
    let s: number;
    let e: number;
    const flow = (parent && (isMap(parent) || isSeq(parent)) && parent.flow) === true;
    if (flow) {
      const items = (parent as { items: unknown[] }).items;
      const i = items.indexOf(pair ?? node);
      s = pair ? pair.key && (pair.key as YamlNode).range ? (pair.key as YamlNode).range![0] : node.range![0] : node.range![0];
      e = node.range![1];
      if (i > 0) {
        // take the comma before (and the spaces around it)
        const prevEnd = text.lastIndexOf(',', s);
        s = prevEnd;
      } else if (items.length > 1) {
        const comma = text.indexOf(',', e);
        e = comma + 1;
        while (text[e] === ' ') e++;
      }
    } else {
      const keyStart = pair && pair.key && (pair.key as YamlNode).range ? (pair.key as YamlNode).range![0] : node.range![0];
      s = text.lastIndexOf('\n', keyStart - 1) + 1;
      // sequence item: back up to its dash
      e = node.range![2];
      if (e > 0 && text[e - 1] !== '\n') {
        const nl = text.indexOf('\n', e);
        e = nl < 0 ? text.length : nl + 1;
      }
      // leading comment lines that sit directly on the key (same indentation, no blank line) go with it
      const indent = /^[ \t]*/.exec(text.slice(s))![0];
      for (;;) {
        const prevStart = text.lastIndexOf('\n', s - 2) + 1;
        if (s === 0) break;
        const prevLine = text.slice(prevStart, s - 1);
        if (new RegExp(`^${indent}#`).test(prevLine)) s = prevStart;
        else break;
      }
    }
    const out = text.slice(0, s) + text.slice(e);
    this.verifyYaml(path, text, out, keyPath, { delete: true });
    this.write(path, out);
  }
}

const YAML_REUSE = process.env.IMPORT_LIVE_YAML_REUSE ?? '1';

const parseYaml = (text: string): Document.Parsed => parseDocument(text, { keepSourceTokens: true, uniqueKeys: false });

/**
 * The scalar type a swap of `old` (source text of a node of type `oldType`) for `rendered` (renderScalar of `value`) leaves,
 * when the parsed value is exactly `value` and both tokens are one non-empty line; null when the document must be parsed
 * again. Set IMPORT_LIVE_YAML_REUSE=0 to always parse, =verify to compare every kept document with a fresh parse.
 */
function scalarSwap(old: string, oldType: string | undefined, rendered: string, value: unknown): 'PLAIN' | 'QUOTE_SINGLE' | 'QUOTE_DOUBLE' | null {
  if (old.length === 0 || /[\r\n]/.test(old) || /[\r\n]/.test(rendered)) return null;
  if (oldType !== 'PLAIN' && oldType !== 'QUOTE_SINGLE' && oldType !== 'QUOTE_DOUBLE') return null;
  if (typeof value === 'string') {
    if (rendered === JSON.stringify(value)) return 'QUOTE_DOUBLE';
    if (rendered === `'${value}'`) return 'QUOTE_SINGLE';
    if (rendered === value) return 'PLAIN';
    return null;
  }
  if (typeof value === 'number' && Number.isFinite(value) && Number(rendered) === value && /^-?\d/.test(rendered)) return 'PLAIN';
  if ((value === true || value === false || value === null) && rendered === String(value)) return 'PLAIN';
  return null;
}

/** every node's class, range and scalar type/value, in document order (the verify mode of the kept documents) */
function docShape(doc: Document.Parsed): string {
  const out: unknown[] = [doc.range, doc.errors.length];
  visit(doc, (k, n) => {
    if (isScalar(n)) out.push(['S', k, n.range, n.type, n.value]);
    else if (isCollection(n)) out.push([isMap(n) ? 'M' : 'Q', k, n.range, n.flow === true, n.items.length]);
    else if (n && typeof n === 'object' && 'range' in n) out.push(['A', k, (n as { range?: unknown }).range]);
    else out.push(['P', k]);
  });
  return JSON.stringify(out);
}

const PLAIN_SAFE = /^[A-Za-z][A-Za-z0-9 .'()&\-/!?]*$/;
const RESERVED = /^(?:true|false|null|yes|no|on|off|~)$/i;

/** renders a scalar in the style of the old one where that is safe, else double-quoted (JSON) */
export function renderScalar(value: unknown, oldType: string | undefined, inFlow: boolean): string {
  if (typeof value !== 'string') return JSON.stringify(value);
  if (oldType === 'QUOTE_SINGLE' && !value.includes("'")) return `'${value}'`;
  if (oldType === 'PLAIN' && PLAIN_SAFE.test(value) && !RESERVED.test(value) && !/\s$/.test(value) && !(inFlow && /[,[\]{}]/.test(value))) {
    return value;
  }
  return JSON.stringify(value);
}
