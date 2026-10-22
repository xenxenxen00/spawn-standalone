// Wire-clean values (docs/design/core-runtime.md §5.3, D-CORE-02, D-CORE-04).
//
// Spawn rows hold plain data that "rides the wire" (`authored module`), so a write stores a copy with JSON
// semantics. The two definitions this module implements without building strings:
//   cloneWire(v)        ≡ JSON.parse(JSON.stringify(v))  (undefined where JSON.stringify gives undefined)
//   deepEqualWire(a, b) ≡ JSON.stringify(a) === JSON.stringify(b)  for every pair JSON.stringify accepts; on a BigInt or a
//                         cycle it throws only when it reaches one before finding a difference (an unequal write then goes
//                         on to cloneWire, which throws on it)
// Both follow the ECMAScript SerializeJSONProperty steps: toJSON(key), Number/String/Boolean/BigInt unwrapping, functions,
// symbols and undefined dropped from objects and nulled in arrays, NaN/±Infinity → null, -0 → 0, own enumerable string keys
// in Object.keys order, a TypeError on BigInt and on cycles. Shared acyclic references are copied, not aliased.
import type { PathSegment } from './types.ts';

export type WireValue = null | boolean | number | string | WireValue[] | WireObject;
export interface WireObject {
  [key: string]: WireValue;
}

const objectToString = Object.prototype.toString;
const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

/**
 * A plain object: an object literal, `Object.create(null)`, a JSON object or a proxy of one, from any realm. Arrays, class
 * instances and built-ins (Date, Map, Math, wrapper objects…) are not. Template merging deep-merges only plain objects
 * (core §4.3).
 */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  // another realm's Object.prototype is also a prototype whose own prototype is null
  if (proto !== null && proto !== Object.prototype && Object.getPrototypeOf(proto) !== null) return false;
  return objectToString.call(v) === '[object Object]';
}

// ── SerializeJSONProperty steps 2-4 ──────────────────────────────────────────────────────────────────────────────────

/** what JSON.stringify writes for a value once toJSON ran and wrappers are unwrapped: a primitive, an object, or nothing */
type Normalized = null | boolean | number | string | object | undefined;

/** step 4: the primitive held by a Number/String/Boolean/BigInt object, or the object itself */
function unwrap(value: object): unknown {
  // fast path: an object whose prototype is Object.prototype, Array.prototype or null is taken to hold no primitive slot
  // (true of every literal, JSON value and array; only a wrapper object re-prototyped by hand would differ from JSON)
  const proto: unknown = Object.getPrototypeOf(value);
  if (proto === Object.prototype || proto === Array.prototype || proto === null) return value;
  switch (objectToString.call(value)) {
    case '[object Number]':
      return slotValue(value, Number.prototype.valueOf);
    case '[object String]':
      return slotValue(value, String.prototype.valueOf);
    case '[object Boolean]':
      return slotValue(value, Boolean.prototype.valueOf);
    case '[object BigInt]':
      return slotValue(value, BigInt.prototype.valueOf);
    default:
      return value;
  }
}

/** the internal slot behind a matching toStringTag (valueOf throws when the tag is spoofed and the slot is absent) */
function slotValue(value: object, valueOf: (this: never) => unknown): unknown {
  try {
    return valueOf.call(value as never);
  } catch {
    return value;
  }
}

function normalize(value: unknown, key: string | number): Normalized {
  // step 2: toJSON on objects and bigints
  if ((typeof value === 'object' && value !== null) || typeof value === 'bigint') {
    const toJSON: unknown = (value as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') value = toJSON.call(value, typeof key === 'number' ? String(key) : key);
  }
  if (typeof value === 'object' && value !== null) value = unwrap(value);
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return value;
    case 'number':
      // NaN and ±Infinity serialise as null; -0 as 0
      return Number.isFinite(value) ? value + 0 : null;
    case 'bigint':
      throw new TypeError('wire: a BigInt is not wire data');
    case 'object':
      return value; // null or an object
    default:
      return undefined; // undefined, functions, symbols
  }
}

const cycleError = (): TypeError => new TypeError('wire: cyclic structure is not wire data');

// ── cloneWire ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A wire-clean copy of `value`: JSON.parse(JSON.stringify(value)) without the string. Returns undefined where JSON.stringify
 * gives undefined (undefined, a function, a symbol, an object whose toJSON gives one of those). The copy shares nothing with
 * the source; objects get Object.prototype and a `__proto__` key stays an own data property.
 */
export function cloneWire(value: unknown): WireValue | undefined {
  return cloneAt(value, '', []);
}

function cloneAt(value: unknown, key: string | number, stack: object[]): WireValue | undefined {
  const v = normalize(value, key);
  if (typeof v !== 'object' || v === null) return v as WireValue | undefined;
  if (stack.includes(v)) throw cycleError();
  stack.push(v);
  let out: WireValue;
  if (Array.isArray(v)) {
    const len = v.length;
    const arr: WireValue[] = [];
    for (let i = 0; i < len; i++) {
      const e = cloneAt((v as unknown[])[i], i, stack);
      arr.push(e === undefined ? null : e);
    }
    out = arr;
  } else {
    const obj: WireObject = {};
    const src = v as Record<string, unknown>;
    for (const k of Object.keys(src)) {
      const e = cloneAt(src[k], k, stack);
      if (e !== undefined) defineData(obj, k, e);
    }
    out = obj;
  }
  stack.pop();
  return out;
}

/** `o[k] = v`, except that a `__proto__` key becomes an own data property (as JSON.parse makes it) */
function defineData(o: object, k: string, v: unknown): void {
  if (k === '__proto__') Object.defineProperty(o, k, { value: v, writable: true, enumerable: true, configurable: true });
  else (o as Record<string, unknown>)[k] = v;
}

// ── deepEqualWire ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * True when `a` and `b` write the same JSON text: members that do not ride the wire are ignored, NaN equals null, -0 equals 0,
 * and key order counts (a store keeps the copy of the last assignment, so a reorder is a write). Throws a TypeError when it
 * meets a BigInt or a cycle before finding a difference.
 */
export function deepEqualWire(a: unknown, b: unknown): boolean {
  return equalNormalized(normalize(a, ''), normalize(b, ''), [], []);
}

function equalNormalized(a: Normalized, b: Normalized, stackA: object[], stackB: object[]): boolean {
  if (typeof a !== 'object' || a === null || typeof b !== 'object' || b === null) return a === b;
  const arrayA = Array.isArray(a);
  if (arrayA !== Array.isArray(b)) return false;
  if (stackA.includes(a) || stackB.includes(b)) throw cycleError();
  stackA.push(a);
  stackB.push(b);
  const same = arrayA
    ? equalArrays(a as unknown[], b as unknown[], stackA, stackB)
    : equalObjects(a as Record<string, unknown>, b as Record<string, unknown>, stackA, stackB);
  stackA.pop();
  stackB.pop();
  return same;
}

function equalArrays(a: unknown[], b: unknown[], stackA: object[], stackB: object[]): boolean {
  const len = a.length;
  if (len !== b.length) return false;
  for (let i = 0; i < len; i++) {
    const x = normalize(a[i], i);
    const y = normalize(b[i], i);
    if (!equalNormalized(x === undefined ? null : x, y === undefined ? null : y, stackA, stackB)) return false;
  }
  return true;
}

function equalObjects(a: Record<string, unknown>, b: Record<string, unknown>, stackA: object[], stackB: object[]): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  let i = 0;
  let j = 0;
  for (;;) {
    // the next member of each side that is written at all
    let x: Normalized = undefined;
    while (i < keysA.length && (x = normalize(a[keysA[i]!], keysA[i]!)) === undefined) i++;
    let y: Normalized = undefined;
    while (j < keysB.length && (y = normalize(b[keysB[j]!], keysB[j]!)) === undefined) j++;
    const doneA = i >= keysA.length;
    const doneB = j >= keysB.length;
    if (doneA || doneB) return doneA && doneB;
    if (keysA[i] !== keysB[j] || !equalNormalized(x, y, stackA, stackB)) return false;
    i++;
    j++;
  }
}

// ── dotted paths (D-CORE-04 override keys; core §5.3 nested writes) ─────────────────────────────────────────────────

/** a dotted string splits on every `.` (no escaping: `a..b` is ['a', '', 'b']); a segment array is copied */
export function parsePath(path: string | readonly PathSegment[]): PathSegment[] {
  return typeof path === 'string' ? path.split('.') : [...path];
}

/**
 * The value at `path` below `root`, reading own properties only (an inherited `toString` or `constructor` is not data);
 * undefined when any step is missing or not an object. An empty path answers `root`.
 */
export function getPath(root: unknown, path: string | readonly PathSegment[]): unknown {
  let cur = root;
  for (const seg of typeof path === 'string' ? path.split('.') : path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    const k = String(seg);
    if (!hasOwn(cur, k)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/**
 * Sets `path` below `root` in place (an override key `state.id` sets `spec.state.id`). An existing object or array on the way
 * is descended into (a numeric segment indexes an array, in either spelling); a missing or non-object intermediate is replaced
 * by a new plain object, whatever the next segment looks like, so `'a.0'` and `['a', 0]` always build the same value. (No live
 * override key indexes an array: the dotted keys at HEAD are `state.id` and `state.name`.) Every step reads and writes own
 * properties only, so `__proto__` and `constructor` segments land as own data and no prototype is ever written. The value is
 * stored as given (callers clone).
 */
export function setPath(root: object, path: string | readonly PathSegment[], value: unknown): void {
  const segs = typeof path === 'string' ? path.split('.') : path;
  if (segs.length === 0) throw new RangeError('setPath: empty path');
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const k = String(segs[i]);
    const next: unknown = hasOwn(cur, k) ? (cur as Record<string, unknown>)[k] : undefined;
    if (typeof next === 'object' && next !== null) {
      cur = next;
      continue;
    }
    const fresh = {};
    defineData(cur, k, fresh);
    cur = fresh;
  }
  defineData(cur, String(segs[segs.length - 1]), value);
}
