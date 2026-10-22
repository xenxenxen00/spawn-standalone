// Wire-clean values (docs/design/core-runtime.md §5.3, D-CORE-02, D-CORE-04, §16.1 `wire.test.ts`).
// cloneWire and deepEqualWire are defined by JSON semantics: clone = JSON.parse(JSON.stringify(v)), equal = the two JSON texts
// are equal. The property tests below hold them to that definition over a seeded corpus of awkward values.
import { isDeepStrictEqual } from 'node:util';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { cloneWire, deepEqualWire, getPath, isPlainObject, parsePath, setPath } from '../../../src/compat/core/wire.ts';

const viaJson = (v: unknown): unknown => {
  const s = JSON.stringify(v);
  return s === undefined ? undefined : JSON.parse(s);
};

// ── seeded value generator ───────────────────────────────────────────────────────────────────────────────────────────
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Point {
  x = 1;
  y = 2;
  get len(): number {
    return Math.hypot(this.x, this.y);
  }
}

const KEYS = ['a', 'b', 'hp', 'live', 'x', 'y', '0', '1', '10', '01', '-1', '', '__proto__', 'toString', 'constructor', 'é', 'a.b'];

function gen(rnd: () => number, depth: number): unknown {
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const leaf = (): unknown => {
    switch (Math.floor(rnd() * 24)) {
      case 0: return null;
      case 1: return undefined;
      case 2: return rnd() < 0.5;
      case 3: return 0;
      case 4: return -0;
      case 5: return Number.NaN;
      case 6: return pick([Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]);
      case 7: return Math.floor(rnd() * 2000) - 1000;
      case 8: return (rnd() - 0.5) * 1e6;
      case 9: return pick([1e21, 1e-7, 5e-324, Number.MAX_VALUE, -Number.MIN_VALUE, 0.1 + 0.2]);
      case 10: return pick(['', 'hp', 'ünïcödé', ' ', '"q"', '\\', '\ud800', 'a\nb', '__proto__']);
      case 11: return () => 1;
      case 12: return Symbol('s');
      case 13: return new Date(Math.floor(rnd() * 2e12));
      case 14: return new Date(Number.NaN);
      case 15: return pick([new Number(3), new String('s'), new Boolean(false), Object(-0)]);
      case 16: return new Map([[1, 2]]);
      case 17: return new Set([1]);
      case 18: return new Float32Array([1.5, -2]);
      case 19: return new Point();
      case 20: return { toJSON: (k: string) => `k:${k}` };
      case 21: return { toJSON: () => undefined };
      case 22: return Object.assign(Object.create(null) as Record<string, unknown>, { n: 1 });
      default: return 'plain';
    }
  };
  if (depth <= 0 || rnd() < 0.35) return leaf();
  if (rnd() < 0.45) {
    const n = Math.floor(rnd() * 5);
    const arr: unknown[] = [];
    for (let i = 0; i < n; i++) arr.push(gen(rnd, depth - 1));
    if (rnd() < 0.15) arr.length += 2; // trailing holes
    return arr;
  }
  const obj: Record<string, unknown> = {};
  const n = Math.floor(rnd() * 5);
  for (let i = 0; i < n; i++) {
    const k = pick(KEYS);
    // an own "__proto__" data property, as JSON.parse creates it
    Object.defineProperty(obj, k, { value: gen(rnd, depth - 1), enumerable: true, writable: true, configurable: true });
  }
  if (rnd() < 0.1) Object.defineProperty(obj, 'hidden', { value: 1, enumerable: false });
  if (rnd() < 0.1) (obj as Record<symbol, unknown>)[Symbol('k')] = 1;
  return obj;
}

const corpus = (seed: number, n: number): unknown[] => {
  const rnd = mulberry32(seed);
  return Array.from({ length: n }, () => gen(rnd, 4));
};

// ── cloneWire ────────────────────────────────────────────────────────────────────────────────────────────────────────
describe('cloneWire (JSON semantics, D-CORE-02)', () => {
  it('keeps strings, booleans, null and finite numbers', () => {
    for (const v of [null, true, false, 0, 1.5, -3, 1e21, 5e-324, '', 'hp']) expect(cloneWire(v)).toBe(v);
  });

  it('turns NaN and ±Infinity into null and -0 into 0', () => {
    expect(cloneWire(Number.NaN)).toBe(null);
    expect(cloneWire(Number.POSITIVE_INFINITY)).toBe(null);
    expect(cloneWire(Number.NEGATIVE_INFINITY)).toBe(null);
    expect(Object.is(cloneWire(-0), 0)).toBe(true);
    expect(cloneWire({ v: [Number.NaN, -0] })).toStrictEqual({ v: [null, 0] });
  });

  it('returns undefined for undefined, functions and symbols at the top level', () => {
    expect(cloneWire(undefined)).toBe(undefined);
    expect(cloneWire(() => 1)).toBe(undefined);
    expect(cloneWire(Symbol('x'))).toBe(undefined);
  });

  it('drops undefined, function and symbol members of objects', () => {
    const out = cloneWire({ a: 1, u: undefined, f: () => 1, s: Symbol('x') }) as Record<string, unknown>;
    expect(out).toStrictEqual({ a: 1 });
    expect('u' in out || 'f' in out || 's' in out).toBe(false);
  });

  it('turns undefined, function, symbol elements and holes of arrays into null', () => {
    const holey: unknown[] = [1];
    holey.length = 3;
    expect(cloneWire([undefined, () => 1, Symbol('x'), 2])).toStrictEqual([null, null, null, 2]);
    expect(cloneWire(holey)).toStrictEqual([1, null, null]);
  });

  it('writes Dates as ISO strings and invalid Dates as null', () => {
    const d = new Date(Date.UTC(2026, 9, 8, 12, 0, 0));
    expect(cloneWire(d)).toBe('2026-10-08T12:00:00.000Z');
    expect(cloneWire({ at: d })).toStrictEqual({ at: '2026-10-08T12:00:00.000Z' });
    expect(cloneWire(new Date(Number.NaN))).toBe(null);
  });

  it('calls toJSON with the property key', () => {
    const tag = { toJSON: (k: string) => `key=${k}` };
    expect(cloneWire(tag)).toBe('key=');
    expect(cloneWire({ a: tag })).toStrictEqual({ a: 'key=a' });
    expect(cloneWire([tag, tag])).toStrictEqual(['key=0', 'key=1']);
  });

  it('unwraps Number, String and Boolean objects', () => {
    expect(cloneWire(new Number(4))).toBe(4);
    expect(cloneWire(new String('s'))).toBe('s');
    expect(cloneWire(new Boolean(false))).toBe(false);
    expect(cloneWire(Object(Number.NaN))).toBe(null);
  });

  it('throws a TypeError on BigInt and on cycles, as JSON does', () => {
    expect(() => cloneWire(1n)).toThrow(TypeError);
    expect(() => cloneWire({ a: [1n] })).toThrow(TypeError);
    const cyc: Record<string, unknown> = { a: 1 };
    cyc['self'] = { back: cyc };
    expect(() => cloneWire(cyc)).toThrow(TypeError);
    const arr: unknown[] = [];
    arr.push(arr);
    expect(() => cloneWire(arr)).toThrow(TypeError);
  });

  it('copies a shared (acyclic) reference twice instead of aliasing it', () => {
    const shared = { v: 1 };
    const out = cloneWire({ a: shared, b: shared }) as { a: object; b: object };
    expect(out.a).toStrictEqual({ v: 1 });
    expect(out.a).not.toBe(out.b);
    expect(out.a).not.toBe(shared);
  });

  it('makes a deep copy that is independent of the source', () => {
    const src = { live: { hp: 3, inv: ['knife', { id: 'm1911', ammo: [7, 21] }] } };
    const out = cloneWire(src) as typeof src;
    expect(out).toStrictEqual(src);
    (src.live.inv[1] as { ammo: number[] }).ammo[0] = 0;
    src.live.hp = 0;
    expect(out.live.hp).toBe(3);
    expect((out.live.inv[1] as { ammo: number[] }).ammo[0]).toBe(7);
    out.live.inv.push('grenade');
    expect(src.live.inv).toHaveLength(2);
  });

  it('keeps own enumerable string keys only, in Object.keys order', () => {
    const o: Record<string | symbol, unknown> = { b: 1, 2: 'two', a: 2, 1: 'one' };
    o[Symbol('s')] = 3;
    Object.defineProperty(o, 'hidden', { value: 4, enumerable: false });
    const out = cloneWire(o) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(['1', '2', 'b', 'a']);
    expect(cloneWire(new Point())).toStrictEqual({ x: 1, y: 2 });
    expect(cloneWire(new Map([[1, 2]]))).toStrictEqual({});
    expect(cloneWire(new Float32Array([1.5, -2]))).toStrictEqual({ 0: 1.5, 1: -2 });
  });

  it('produces plain objects and arrays with the ordinary prototypes', () => {
    const out = cloneWire({ a: Object.create(null) as object, l: [1] }) as { a: object; l: unknown[] };
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(out.a)).toBe(Object.prototype);
    expect(Array.isArray(out.l)).toBe(true);
  });

  it('keeps a "__proto__" key as an own data property and never changes a prototype', () => {
    const src = JSON.parse('{"__proto__": {"polluted": 1}, "a": 2}') as Record<string, unknown>;
    const out = cloneWire(src) as Record<string, unknown>;
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(true);
    expect(out['polluted']).toBe(undefined);
    expect(({} as Record<string, unknown>)['polluted']).toBe(undefined);
    expect(JSON.stringify(out)).toBe('{"__proto__":{"polluted":1},"a":2}');
  });

  it('reads through proxies (the handles hand out write-through proxies, core §5.3)', () => {
    const target = { hp: 3, inv: ['a'] };
    const proxy = new Proxy(target, {});
    const listProxy = new Proxy(['x', 'y'], {});
    expect(cloneWire(proxy)).toStrictEqual({ hp: 3, inv: ['a'] });
    expect(cloneWire({ l: listProxy })).toStrictEqual({ l: ['x', 'y'] });
  });

  it('equals JSON.parse(JSON.stringify(v)) over a seeded corpus', () => {
    // node:util isDeepStrictEqual (prototypes, own keys, SameValue): vitest's toStrictEqual compares `.constructor` by
    // identity, which misfires on wire objects that carry an own "constructor" key (the corpus has them)
    for (const [i, v] of corpus(0x5eed, 600).entries()) {
      const want = viaJson(v);
      const got = cloneWire(v);
      expect(JSON.stringify(got), `case ${i}`).toBe(JSON.stringify(want));
      expect(isDeepStrictEqual(got, want), `case ${i}`).toBe(true);
    }
  });
});

// ── deepEqualWire ────────────────────────────────────────────────────────────────────────────────────────────────────
const sameJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** a few edits that may or may not change the JSON text */
function variant(rnd: () => number, v: unknown): unknown {
  const c = viaJson(v);
  if (c === null || typeof c !== 'object') {
    return [c, Number.NaN, -0, 0, undefined, null, 'x', `${String(c)}`][Math.floor(rnd() * 8)];
  }
  if (Array.isArray(c)) {
    switch (Math.floor(rnd() * 4)) {
      case 0: return c;
      case 1: return [...c, null];
      case 2: return c.map((e) => (e === null ? undefined : e));
      default: return c.length > 0 ? [variant(rnd, c[0]), ...c.slice(1)] : [undefined];
    }
  }
  const o = c as Record<string, unknown>;
  const keys = Object.keys(o);
  switch (Math.floor(rnd() * 5)) {
    case 0: return o;
    case 1: return { ...o, extra: undefined };
    case 2: return Object.fromEntries([...keys].reverse().map((k) => [k, o[k]]));
    case 3: return keys.length > 0 ? { ...o, [keys[0]!]: variant(rnd, o[keys[0]!]) } : { z: 1 };
    default: return { ...o, fn: () => 1 };
  }
}

describe('deepEqualWire (equal = the same JSON text)', () => {
  it('compares primitives as their JSON', () => {
    expect(deepEqualWire(1, 1)).toBe(true);
    expect(deepEqualWire(0, -0)).toBe(true);
    expect(deepEqualWire(Number.NaN, null)).toBe(true);
    expect(deepEqualWire(Number.POSITIVE_INFINITY, Number.NaN)).toBe(true);
    expect(deepEqualWire(undefined, () => 1)).toBe(true);
    expect(deepEqualWire(undefined, null)).toBe(false);
    expect(deepEqualWire('1', 1)).toBe(false);
    expect(deepEqualWire(true, 1)).toBe(false);
    expect(deepEqualWire(new Number(2), 2)).toBe(true);
  });

  it('ignores members that do not ride the wire', () => {
    expect(deepEqualWire({ a: 1, u: undefined, f: () => 1 }, { a: 1 })).toBe(true);
    expect(deepEqualWire([undefined], [null])).toBe(true);
    expect(deepEqualWire({ a: 1 }, { a: 1, b: null })).toBe(false);
  });

  it('is sensitive to array order and to key order (the stored copy keeps the order that was assigned)', () => {
    expect(deepEqualWire([1, 2], [2, 1])).toBe(false);
    expect(deepEqualWire({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false);
    expect(deepEqualWire({ a: { x: 1, y: 2 } }, { a: { x: 1, y: 2 } })).toBe(true);
  });

  it('tells arrays, objects and null apart', () => {
    expect(deepEqualWire([], {})).toBe(false);
    expect(deepEqualWire({}, null)).toBe(false);
    expect(deepEqualWire([], null)).toBe(false);
    expect(deepEqualWire({ 0: 'a' }, ['a'])).toBe(false);
  });

  it('applies toJSON and Dates like JSON', () => {
    const d = new Date(Date.UTC(2026, 0, 1));
    expect(deepEqualWire(d, '2026-01-01T00:00:00.000Z')).toBe(true);
    expect(deepEqualWire({ t: d }, { t: d.toISOString() })).toBe(true);
    expect(deepEqualWire({ k: { toJSON: (k: string) => k } }, { k: 'k' })).toBe(true);
  });

  it('throws a TypeError on a cycle it has to walk', () => {
    const a: Record<string, unknown> = {};
    a['self'] = a;
    const b: Record<string, unknown> = {};
    b['self'] = b;
    expect(() => deepEqualWire(a, b)).toThrow(TypeError);
  });

  it('agrees with JSON.stringify(a) === JSON.stringify(b) over a seeded corpus of near pairs', () => {
    const rnd = mulberry32(0xc0ffee);
    let equalPairs = 0;
    for (const [i, a] of corpus(0xbeef, 600).entries()) {
      const b = variant(rnd, a);
      const want = sameJson(a, b);
      if (want) equalPairs++;
      expect(deepEqualWire(a, b), `case ${i}`).toBe(want);
      expect(deepEqualWire(b, a), `case ${i} (swapped)`).toBe(want);
      expect(deepEqualWire(a, a), `case ${i} (self)`).toBe(true);
    }
    // the corpus exercises both outcomes
    expect(equalPairs).toBeGreaterThan(100);
    expect(equalPairs).toBeLessThan(550);
  });
});

// ── dotted paths ─────────────────────────────────────────────────────────────────────────────────────────────────────
describe('setPath / getPath (dotted override keys, D-CORE-04; nested writes, core §5.3)', () => {
  it('sets a dotted override key and keeps the siblings (the supply terminal rows: state.id, state.name)', () => {
    const spec = { template: 'templates/props/supply-terminal.js#supplyTerminal', state: { kind: 'terminal', id: 'x' } };
    setPath(spec, 'state.id', 'gf-covered-bridge');
    setPath(spec, 'state.name', 'Basement');
    expect(spec).toStrictEqual({
      template: 'templates/props/supply-terminal.js#supplyTerminal',
      state: { kind: 'terminal', id: 'gf-covered-bridge', name: 'Basement' },
    });
  });

  it('creates missing intermediates as plain objects', () => {
    const o: Record<string, unknown> = {};
    setPath(o, 'a.b.c', 1);
    expect(o).toStrictEqual({ a: { b: { c: 1 } } });
  });

  it('replaces a non-object intermediate', () => {
    const o: Record<string, unknown> = { a: 5, n: null, s: 'str' };
    setPath(o, 'a.b', 1);
    setPath(o, 'n.x', 2);
    setPath(o, ['s', 'y'], 3);
    expect(o).toStrictEqual({ a: { b: 1 }, n: { x: 2 }, s: { y: 3 } });
  });

  it('indexes an existing array with a numeric segment, in either spelling', () => {
    const o: Record<string, unknown> = { inv: ['knife'] };
    setPath(o, ['inv', 1], 'm1911');
    setPath(o, 'inv.2', 'injector');
    expect(o).toStrictEqual({ inv: ['knife', 'm1911', 'injector'] });
  });

  it('makes a missing intermediate a plain object whatever the next segment looks like, so both spellings agree', () => {
    const viaArray: Record<string, unknown> = {};
    const viaDots: Record<string, unknown> = {};
    setPath(viaArray, ['slots', 0], 'a');
    setPath(viaDots, 'slots.0', 'a');
    expect(viaArray).toStrictEqual({ slots: { 0: 'a' } });
    expect(JSON.stringify(viaDots)).toBe(JSON.stringify(viaArray));
  });

  it('indexes into an existing array with a dotted numeric segment', () => {
    const o = { a: [1, 2, 3] };
    setPath(o, 'a.1', 9);
    expect(o).toStrictEqual({ a: [1, 9, 3] });
    expect(getPath(o, 'a.2')).toBe(3);
  });

  it('never writes a prototype ("__proto__", "constructor" segments land as own data)', () => {
    const o: Record<string, unknown> = {};
    setPath(o, '__proto__.polluted', 1);
    setPath(o, 'constructor.prototype.polluted', 2);
    expect(Object.getPrototypeOf(o)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)['polluted']).toBe(undefined);
    expect(Object.prototype.hasOwnProperty.call(o, '__proto__')).toBe(true);
    expect(getPath(o, '__proto__.polluted')).toBe(1);
    expect(getPath(o, ['constructor', 'prototype', 'polluted'])).toBe(2);
    expect(JSON.stringify(o)).toBe('{"__proto__":{"polluted":1},"constructor":{"prototype":{"polluted":2}}}');
  });

  it('reads own data only and answers undefined for anything missing', () => {
    const o = { state: { id: 'a', n: 0, z: null }, list: [{ k: 1 }] };
    expect(getPath(o, 'state.id')).toBe('a');
    expect(getPath(o, 'state.n')).toBe(0);
    expect(getPath(o, 'state.z')).toBe(null);
    expect(getPath(o, ['list', 0, 'k'])).toBe(1);
    expect(getPath(o, 'state.missing')).toBe(undefined);
    expect(getPath(o, 'state.id.length')).toBe(undefined);
    expect(getPath(o, 'toString')).toBe(undefined);
    expect(getPath(o, 'constructor')).toBe(undefined);
    expect(getPath(o, [])).toBe(o);
    expect(getPath(null, 'a')).toBe(undefined);
  });

  it('refuses an empty path', () => {
    expect(() => setPath({}, [], 1)).toThrow(RangeError);
  });

  it('splits dotted strings literally and copies path arrays', () => {
    expect(parsePath('state.id')).toEqual(['state', 'id']);
    expect(parsePath('a..b')).toEqual(['a', '', 'b']);
    expect(parsePath('')).toEqual(['']);
    const segs = ['a', 1] as const;
    const parsed = parsePath(segs);
    expect(parsed).toEqual(['a', 1]);
    expect(parsed).not.toBe(segs);
  });
});

// ── isPlainObject ────────────────────────────────────────────────────────────────────────────────────────────────────
describe('isPlainObject (template merge: plain objects merge, everything else replaces, core §4.3)', () => {
  it('accepts object literals, null-prototype objects, JSON objects, proxies and other realms', () => {
    expect(isPlainObject({})).toBe(true);
    expect(isPlainObject({ a: 1 })).toBe(true);
    expect(isPlainObject(Object.create(null))).toBe(true);
    expect(isPlainObject(JSON.parse('{"a":1}'))).toBe(true);
    expect(isPlainObject(new Proxy({ a: 1 }, {}))).toBe(true);
    expect(isPlainObject(runInNewContext('({ a: 1 })'))).toBe(true);
  });

  it('rejects arrays, null, primitives and objects with a class or built-in tag', () => {
    for (const v of [[], new Proxy([], {}), null, undefined, 1, 'x', true, () => 1, new Date(), new Map(), new Point(), Math, JSON,
      new Number(1), /re/, new Error('e'), Object.create({ inherited: 1 })]) {
      expect(isPlainObject(v), Object.prototype.toString.call(v)).toBe(false);
    }
  });
});
