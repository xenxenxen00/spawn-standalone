// Layered values (docs/design/core-runtime.md §5.5; contract §4.3; AGENTS.md:53-54): reads compose like a prototype chain, writes
// land in the own layer, `delete` reveals the layer below; a root assignment replaces, a leaf assignment merges ("root =
// replaces, .leaf = merges"). Live uses: `ctx.place.atmosphere` (leaf writes `ambient.light.intensity`, `hemisphere.intensity`
// from authored module; a whole `fog` from scripts/gen/fallout-acre/nuke.js:20-22), the camera rig's own layer over
// the camera def (core §7.4). The atmosphere domain subscribes to `onChange` (core §15.3).
//
// The own layer is a tree: a `merge` node keeps the layer below and overrides some keys, a `replace` node is a value that hides
// everything below it. Assigning a path sets a replace node there (creating merge nodes above it), so `fog = HAZE` drops the
// base fog's other keys while `ambient.light.intensity = v` keeps `ambient.light.color`. Deleting a path drops the own-layer
// node there, revealing the base; a key only the base has stays (as `delete` on a prototype-chain object). Writing or deleting
// below an own replaced value edits that value (copy on write: a composed snapshot never changes after it was handed out).
//
// The composed snapshot is memoised until the next write or until the base hands out a different object (a lower
// LayeredValue's read() changes identity on every write of its own, so layers chain). It shares unchanged base subtrees and
// own values: treat it as read-only.
import type { LayeredValue, PathSegment } from '../types.ts';
import { cloneWire, getPath, isPlainObject, setPath } from '../wire.ts';

type Node = { readonly kind: 'replace'; readonly value: unknown } | { readonly kind: 'merge'; readonly kids: Map<string, Node> };
type Subscriber = (composed: Record<string, unknown>, path: readonly string[]) => void;

const UNCHANGED: unique symbol = Symbol('unchanged');
const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const isObjectLike = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** `o[k] = v` as an own data property, also for a `__proto__` key */
function defineData(o: object, k: string, v: unknown): void {
  if (k === '__proto__') Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true });
  else (o as Record<string, unknown>)[k] = v;
}

function deleteAt(root: unknown, path: readonly string[]): void {
  const parent = getPath(root, path.slice(0, -1));
  const k = path[path.length - 1]!;
  if (isObjectLike(parent) && hasOwn(parent, k)) delete parent[k];
}

function compose(base: unknown, node: Node | null): unknown {
  if (node === null) return base;
  if (node.kind === 'replace') return node.value;
  let out: Record<string, unknown>;
  if (Array.isArray(base)) out = base.slice() as unknown as Record<string, unknown>;
  else if (isPlainObject(base)) {
    out = {};
    for (const k of Object.keys(base)) defineData(out, k, base[k]);
  } else out = {};
  for (const [k, kid] of node.kids) {
    const v = compose(getPath(base, [k]), kid);
    if (v === undefined) delete out[k];
    else defineData(out, k, v);
  }
  return out;
}

function setNode(node: Node | null, segs: readonly string[], i: number, v: unknown): Node {
  if (i === segs.length) return { kind: 'replace', value: v };
  if (node !== null && node.kind === 'replace') {
    // below an own replaced value: edit a copy of it
    const value = isObjectLike(node.value) ? (cloneWire(node.value) as Record<string, unknown>) : {};
    if (v === undefined) deleteAt(value, segs.slice(i));
    else setPath(value, segs.slice(i), v);
    return { kind: 'replace', value };
  }
  const kids = node !== null ? node.kids : new Map<string, Node>();
  const k = segs[i]!;
  kids.set(k, setNode(kids.get(k) ?? null, segs, i + 1, v));
  return node ?? { kind: 'merge', kids };
}

function deleteNode(node: Node | null, segs: readonly string[], i: number): Node | null | typeof UNCHANGED {
  if (node === null) return UNCHANGED;
  if (node.kind === 'replace') {
    const rest = segs.slice(i);
    const parent = getPath(node.value, rest.slice(0, -1));
    if (!isObjectLike(parent) || !hasOwn(parent, rest[rest.length - 1]!)) return UNCHANGED;
    const value = cloneWire(node.value);
    deleteAt(value, rest);
    return { kind: 'replace', value };
  }
  const k = segs[i]!;
  const kid = node.kids.get(k);
  if (kid === undefined) return UNCHANGED;
  if (i === segs.length - 1) node.kids.delete(k);
  else {
    const next = deleteNode(kid, segs, i + 1);
    if (next === UNCHANGED) return UNCHANGED;
    if (next === null) node.kids.delete(k);
    else node.kids.set(k, next);
  }
  return node.kids.size === 0 ? null : node;
}

export class LayeredValueImpl implements LayeredValue {
  readonly #base: () => unknown;
  #own: Node | null = null;
  #memo: { readonly base: unknown; readonly value: Record<string, unknown> } | null = null;
  #subs: ReadonlyArray<{ readonly fn: Subscriber }> = [];
  readonly #views = new Map<string, object>();

  /** `base` returns the layer below (e.g. the place config's atmosphere, immutable compiled JSON, or a lower layer's read()) */
  constructor(base: () => unknown = () => ({})) {
    this.#base = base;
  }

  /** the composed snapshot (memoised; read-only) */
  read(): Record<string, unknown> {
    const base = this.#base();
    const memo = this.#memo;
    if (memo !== null && memo.base === base) return memo.value;
    const composed = compose(base, this.#own);
    const value = isObjectLike(composed) ? composed : {};
    this.#memo = { base, value };
    return value;
  }

  /** assign `path` (a copy of `value`, JSON semantics); [] replaces the whole value; undefined hides what is below */
  set(path: readonly PathSegment[], value: unknown): void {
    const segs = path.map(String);
    const v = cloneWire(value);
    this.#own = segs.length === 0 ? { kind: 'replace', value: v } : setNode(this.#own, segs, 0, v);
    this.#changed(segs);
  }

  /** drop the own-layer value at `path`, revealing the layer below ([] drops the whole own layer) */
  delete(path: readonly PathSegment[]): void {
    const segs = path.map(String);
    if (segs.length === 0) {
      if (this.#own === null) return;
      this.#own = null;
    } else {
      const next = deleteNode(this.#own, segs, 0);
      if (next === UNCHANGED) return;
      this.#own = next;
    }
    this.#changed(segs);
  }

  /** subscribers run after every effective set/delete with the new composed value; a throwing one is reported and skipped */
  onChange(fn: Subscriber): () => void {
    const sub = { fn };
    this.#subs = [...this.#subs, sub];
    return () => {
      this.#subs = this.#subs.filter((s) => s !== sub);
    };
  }

  /** the nested write-through view (`ctx.place.atmosphere`): reads compose, writes and deletes go to the own layer; one view per
   *  path. A read-only view ignores writes. */
  proxy(opts?: { readonly?: boolean }): Record<string, unknown> {
    return this.viewAt([], opts?.readonly === true) as Record<string, unknown>;
  }

  /** @internal the view of one path (arrays get an array-shaped view so Array.isArray and JSON see an array) */
  viewAt(path: readonly string[], readonly: boolean): object {
    const isArray = Array.isArray(getPath(this.read(), path));
    const key = `${readonly ? 'r' : 'w'}${isArray ? 'a' : 'o'}${JSON.stringify(path)}`;
    let view = this.#views.get(key);
    if (!view) {
      view = new Proxy(isArray ? [] : {}, new LayerViewHandler(this, path, readonly));
      this.#views.set(key, view);
    }
    return view;
  }

  #changed(path: readonly string[]): void {
    this.#memo = null;
    const subs = this.#subs;
    if (subs.length === 0) return;
    const composed = this.read();
    for (const s of subs) {
      try {
        s.fn(composed, path);
      } catch (err) {
        console.error('[layers] an onChange subscriber threw', err);
      }
    }
  }
}

class LayerViewHandler implements ProxyHandler<object> {
  readonly #lv: LayeredValueImpl;
  readonly #path: readonly string[];
  readonly #readonly: boolean;

  constructor(lv: LayeredValueImpl, path: readonly string[], readonly: boolean) {
    this.#lv = lv;
    this.#path = path;
    this.#readonly = readonly;
  }

  #current(): unknown {
    return getPath(this.#lv.read(), this.#path);
  }

  get(target: object, key: string | symbol): unknown {
    if (typeof key === 'symbol') return Reflect.get(target, key);
    const cur = this.#current();
    if (isObjectLike(cur) && hasOwn(cur, key)) {
      const v = cur[key];
      return isObjectLike(v) ? this.#lv.viewAt([...this.#path, key], this.#readonly) : v;
    }
    // inherited members: Array.prototype methods on an array view, Object.prototype ones on an object view
    return Reflect.get(target, key);
  }

  set(_target: object, key: string | symbol, value: unknown): boolean {
    if (typeof key === 'symbol' || this.#readonly) return true;
    this.#lv.set([...this.#path, key], value);
    return true;
  }

  deleteProperty(_target: object, key: string | symbol): boolean {
    if (typeof key === 'symbol' || this.#readonly) return true;
    this.#lv.delete([...this.#path, key]);
    return true;
  }

  defineProperty(target: object, key: string | symbol, desc: PropertyDescriptor): boolean {
    return 'value' in desc ? this.set(target, key, desc.value) : false;
  }

  has(_target: object, key: string | symbol): boolean {
    const cur = this.#current();
    return isObjectLike(cur) && key in cur;
  }

  ownKeys(target: object): ArrayLike<string | symbol> {
    const cur = this.#current();
    const keys = isObjectLike(cur) ? Reflect.ownKeys(cur).filter((k): k is string => typeof k === 'string') : [];
    // an array-shaped view must list the target's own non-configurable `length`
    if (Array.isArray(target) && !keys.includes('length')) keys.push('length');
    return keys;
  }

  getOwnPropertyDescriptor(target: object, key: string | symbol): PropertyDescriptor | undefined {
    if (typeof key === 'symbol') return undefined;
    const cur = this.#current();
    if (key === 'length' && Array.isArray(target)) {
      return { value: Array.isArray(cur) ? cur.length : 0, writable: true, enumerable: false, configurable: false };
    }
    if (!isObjectLike(cur) || !hasOwn(cur, key)) return undefined;
    return { value: this.get(target, key), writable: true, enumerable: true, configurable: true };
  }
}
