import type { Expr, FieldTerm, Vec3 } from '../dsl/compile.ts';
import { oklchNumbersToLinear, oklchToLinear } from '../../color/color.ts';

export type FxValue = number | Vec3;

export interface FxEvalContext {
  readonly age: number;
  readonly life: number;
  readonly size: number;
  readonly rand: number;
  readonly velocity: Vec3;
  readonly position: Vec3;
  readonly origin: Vec3;
  readonly time: number;
  readonly dt: number;
  readonly random: () => number;
  readonly gravity: Vec3;
  readonly wind: Vec3;
  readonly floorHeight: (x: number, z: number) => number | null;
  readonly count: (name: string) => number;
  readonly attr: (name: string) => FxValue;
  readonly roll: (slot: number) => number;
  /**
   * Ranges yield `lo + (hi - lo) * roll`, as current the legacy host. Explicit false preserves the legacy raw unit roll.
   */
  readonly rangeRolls?: boolean;
  readonly smooth: (expr: Expr, value: number) => number;
}

// THE EVALUATOR (cpu-budget X-38). An expression runs for every live particle every frame, so each `Expr` node is turned
// once into a closure (cached per node) instead of being re-interpreted per particle: no switch on the node kind or the
// function name at run time, no argument array, no call node built per particle for a field term, and oklch() without a
// string round trip whenever that round trip is the identity. The semantics are the interpreter's to the bit: every argument
// is still evaluated, left to right, before the function looks at any of them (an argument can draw `random`), a missing or
// non-number argument still reads as the case's default, and every case returns what it returned before (a shared `v3`
// literal, `c.gravity`, `c.wind` by reference as before, a new triple otherwise). Held equal by the golden of every live
// program (`.cache/claude-cpu/fx-golden.ts`, all state of 150 steps) and tests/unit/render/fx.

type Fn = (c: FxEvalContext) => FxValue;

const vec = (x: number, y: number, z: number): Vec3 => [x, y, z];
const isVec = (v: FxValue): v is Vec3 => Array.isArray(v);
const component = (v: FxValue, i: number): number => (isVec(v) ? v[i] ?? 0 : v);
const map2 = (a: FxValue, b: FxValue, f: (x: number, y: number) => number): FxValue =>
  typeof a === 'number' && typeof b === 'number'
    ? f(a, b)
    : vec(f(component(a, 0), component(b, 0)), f(component(a, 1), component(b, 1)), f(component(a, 2), component(b, 2)));
const fAdd = (x: number, y: number): number => x + y;
const fSub = (x: number, y: number): number => x - y;
const fMul = (x: number, y: number): number => x * y;
const fDiv = (x: number, y: number): number => (y === 0 ? 0 : x / y);
const add = (a: FxValue, b: FxValue): FxValue => (typeof a === 'number' && typeof b === 'number' ? a + b : map2(a, b, fAdd));
const sub = (a: FxValue, b: FxValue): FxValue => (typeof a === 'number' && typeof b === 'number' ? a - b : map2(a, b, fSub));
const mul = (a: FxValue, b: FxValue): FxValue => (typeof a === 'number' && typeof b === 'number' ? a * b : map2(a, b, fMul));
const div = (a: FxValue, b: FxValue): FxValue => map2(a, b, fDiv);
const length = (v: FxValue): number => (isVec(v) ? Math.hypot(v[0], v[1], v[2]) : Math.abs(v));
const normalize = (v: FxValue): FxValue => {
  const n = length(v);
  return n > 0 ? div(v, n) : typeof v === 'number' ? 0 : vec(0, 0, 0);
};
const smoothstep = (edge: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - edge) / (1 - edge)));
  return t * t * (3 - 2 * t);
};
const fract = (x: number): number => x - Math.floor(x);
const hash = (x: number): number => fract(Math.sin(x * 127.1 + 311.7) * 43758.5453123);
const noise1 = (x: number): number => {
  const i = Math.floor(x);
  const t = x - i;
  const f = t * t * (3 - 2 * t);
  return hash(i) * (1 - f) + hash(i + 1) * f;
};
/** the interpreter's `n(i, d)`: a number argument, else the default (a missing argument is undefined) */
const nn = (x: FxValue | undefined, d: number): number => (typeof x === 'number' ? x : d);

/** `sdir`: a uniform direction (two draws of `random`, in this order) */
const sdir = (c: FxEvalContext): Vec3 => {
  const y = c.random() * 2 - 1;
  const t = c.random() * Math.PI * 2;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  return vec(r * Math.cos(t), y, r * Math.sin(t));
};

/**
 * True when `String(x)` is plain decimal digits that the oklch regex (`[\d.]+`) reads back as the same double: finite, ≥ 0
 * and printed without an exponent (JS prints one from 1e21 up and below 1e-6). -0 prints as "0".
 */
const plainDecimal = (x: number): boolean => x === 0 || (x >= 1e-6 && x < 1e21);

/**
 * `oklch(L C H)` exactly as `oklchToLinear(\`oklch(${L} ${C} ${H})\`) ?? black`: when every argument prints as a plain decimal
 * the string parses back to the same three numbers, so they are converted directly (-0 as 0, as the string would); anything
 * else (negative, exponent, NaN, ±Infinity) still takes the string path and its regex decides as before.
 */
const oklch = (L: number, C: number, H: number): Vec3 =>
  plainDecimal(L) && plainDecimal(C) && plainDecimal(H)
    ? oklchNumbersToLinear(L === 0 ? 0 : L, C === 0 ? 0 : C, H === 0 ? 0 : H)
    : oklchToLinear(`oklch(${L} ${C} ${H})`) ?? vec(0, 0, 0);

/** a builtin on its first three evaluated arguments (no builtin reads a fourth) */
type CallImpl = (c: FxEvalContext, a0: FxValue | undefined, a1: FxValue | undefined, a2: FxValue | undefined) => FxValue;

const CALLS: Readonly<Record<string, CallImpl>> = {
  hdr: (_c, a0, a1, a2) => vec(nn(a0, 1), nn(a1, nn(a0, 1)), nn(a2, nn(a0, 1))),
  up: (_c, a0) => vec(0, nn(a0, 0), 0),
  sdir: (c) => sdir(c),
  cone: (c, a0) => {
    const cosMax = Math.cos((nn(a0, 0) * Math.PI) / 180);
    const y = 1 - c.random() * (1 - cosMax);
    const t = c.random() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - y * y));
    return vec(r * Math.cos(t), y, r * Math.sin(t));
  },
  blast: (c, a0) => mul(sdir(c), nn(a0, 1)),
  grav: (c) => c.gravity,
  wind: (c) => c.wind,
  buoy: (_c, a0) => vec(0, nn(a0, 0), 0),
  drag: (c, a0) => mul(c.velocity, -nn(a0, 0)),
  radial: (c, a0) => mul(normalize(sub(c.position, c.origin)), nn(a0, 1)),
  attract: (c, a0, a1) => {
    const first = a0 ?? 0;
    const target = isVec(first) ? first : c.origin;
    const strength = isVec(first) ? nn(a1, 0) : nn(a0, 0);
    return mul(normalize(sub(target, c.position)), strength);
  },
  vortex: (c, a0) => {
    const d = sub(c.position, c.origin);
    return mul(normalize(vec(component(d, 2), 0, -component(d, 0))), nn(a0, 1));
  },
  force: (_c, a0) => a0 ?? 0,
  curl: (c, a0) => {
    const s = nn(a0, 1);
    return vec(noise1(c.position[1] * s + c.time), noise1(c.position[2] * s + c.time + 17), noise1(c.position[0] * s + c.time + 43));
  },
  noise: (c, a0) => noise1(nn(a0, 0) + c.time),
  flick: (c, a0, a1) => 1 - nn(a1, 0) * (0.5 + 0.5 * noise1(c.time * nn(a0, 0) + c.rand)),
  fire: (c) => 0.78 + 0.12 * Math.sin(2 * Math.PI * 1.2 * c.time + c.rand * 6.28318530718) + 0.1 * noise1(2 * c.time + c.rand * 6.28318530718),
  spin: (c, a0) => c.age * Math.PI * 2 * nn(a0, 0),
  time: (c) => c.time,
  floorh: (c) => c.floorHeight(c.position[0], c.position[2]) ?? c.position[1],
  env: (_c, a0) => nn(a0, 1),
  oklch: (_c, a0, a1, a2) => oklch(nn(a0, 0), nn(a1, 0), nn(a2, 0)),
};
const CALL_DEFAULT: CallImpl = () => 0;

/** a method on its evaluated target and first two evaluated arguments (no method reads a third) */
type MethodImpl = (x: FxValue, a0: FxValue | undefined, a1: FxValue | undefined) => FxValue;

const METHODS: Readonly<Record<string, MethodImpl>> = {
  sin: (x) => (isVec(x) ? vec(Math.sin(x[0]), Math.sin(x[1]), Math.sin(x[2])) : Math.sin(x)),
  cos: (x) => (isVec(x) ? vec(Math.cos(x[0]), Math.cos(x[1]), Math.cos(x[2])) : Math.cos(x)),
  abs: (x) => (isVec(x) ? vec(Math.abs(x[0]), Math.abs(x[1]), Math.abs(x[2])) : Math.abs(x)),
  floor: (x) => (isVec(x) ? vec(Math.floor(x[0]), Math.floor(x[1]), Math.floor(x[2])) : Math.floor(x)),
  fract: (x) => (isVec(x) ? vec(fract(x[0]), fract(x[1]), fract(x[2])) : fract(x)),
  sqrt: (x) => (isVec(x) ? vec(Math.sqrt(Math.max(0, x[0])), Math.sqrt(Math.max(0, x[1])), Math.sqrt(Math.max(0, x[2]))) : Math.sqrt(Math.max(0, x))),
  neg: (x) => mul(x, -1),
  norm: (x) => normalize(x),
  len: (x) => length(x),
  min: (x, a0) => map2(x, a0 ?? 0, Math.min),
  max: (x, a0) => map2(x, a0 ?? 0, Math.max),
  mix: (x, a0, a1) => add(mul(x, 1 - nn(a1, 0)), mul(a0 ?? 0, nn(a1, 0))),
  cross: (x, a0) => {
    const first = a0 ?? 0;
    const y = isVec(first) ? first : vec(nn(a0, 0), nn(a0, 0), nn(a0, 0));
    const v = isVec(x) ? x : vec(x, x, x);
    return vec(v[1] * y[2] - v[2] * y[1], v[2] * y[0] - v[0] * y[2], v[0] * y[1] - v[1] * y[0]);
  },
  dot: (x, a0) => {
    const y = a0 ?? 0;
    return component(x, 0) * component(y, 0) + component(x, 1) * component(y, 1) + component(x, 2) * component(y, 2);
  },
  step: (x, a0) => map2(x, a0 ?? 0, (v, edge) => (v < edge ? 0 : 1)),
  smooth: (x, a0) => map2(x, a0 ?? 0, smoothstep),
  mod: (x, a0) => map2(x, a0 ?? 1, (v, m) => (m === 0 ? 0 : ((v % m) + m) % m)),
  pow: (x, a0) => map2(x, a0 ?? 1, Math.pow),
  atan2: (x, a0) => Math.atan2(typeof x === 'number' ? x : x[0], nn(a0, 0)),
  yaw: (x, a0) => (isVec(x) ? Math.atan2(-x[0], -x[2]) : Math.atan2(x, nn(a0, 0))),
};
// an unknown method returned undefined from the interpreter's switch; kept
const METHOD_DEFAULT: MethodImpl = () => undefined as unknown as FxValue;

const compiled = new WeakMap<Expr, Fn>();

function fnOf(expr: Expr): Fn {
  let f = compiled.get(expr);
  if (f === undefined) compiled.set(expr, (f = fold(expr)));
  return f;
}

/** builtins that read nothing but their arguments (no context, no `random`) */
const PURE_CALLS = new Set<string>(['hdr', 'up', 'buoy', 'env', 'force', 'oklch']);

/**
 * True when the node's value is the same on every evaluation: literals, and pure builtins, methods (all pure), vectors,
 * negations and operators over such nodes. Never `keys` (age), `$attr`, rolls, `#count`, `~` (state) or a builtin that
 * reads the context or draws `random`.
 */
function constant(expr: Expr): boolean {
  switch (expr.k) {
    case 'num':
    case 'v3':
      return true;
    case 'vec':
      return constant(expr.x) && constant(expr.y) && constant(expr.z);
    case 'neg':
      return constant(expr.a);
    case 'bin':
      return constant(expr.a) && constant(expr.b);
    case 'method':
      return constant(expr.target) && expr.args.every(constant);
    case 'call':
      return PURE_CALLS.has(expr.fn) && expr.args.every(constant);
    default:
      return false;
  }
}

/**
 * A constant node is evaluated once (the same operations on the same numbers, so the same doubles) and its value shared:
 * a triple result is then one array for every evaluation, as a `v3` literal always was. No reader mutates a value it gets
 * from an expression (the simulator, the buckets and the light sink copy the components out).
 */
function fold(expr: Expr): Fn {
  const f = compile(expr);
  if (expr.k === 'num' || expr.k === 'v3' || !constant(expr)) return f;
  const v = f(NO_CONTEXT);
  return () => v;
}
/** never read: a constant node reads no context */
const NO_CONTEXT = null as unknown as FxEvalContext;

/** evaluates every argument in order (each may draw `random`), keeping the first three */
function callFn(fn: string, args: readonly Expr[]): Fn {
  const impl = Object.prototype.hasOwnProperty.call(CALLS, fn) ? CALLS[fn]! : CALL_DEFAULT;
  const fs = args.map(fnOf);
  switch (fs.length) {
    case 0:
      return (c) => impl(c, undefined, undefined, undefined);
    case 1: {
      const f0 = fs[0]!;
      return (c) => impl(c, f0(c), undefined, undefined);
    }
    case 2: {
      const f0 = fs[0]!, f1 = fs[1]!;
      return (c) => {
        const a0 = f0(c);
        return impl(c, a0, f1(c), undefined);
      };
    }
    case 3: {
      const f0 = fs[0]!, f1 = fs[1]!, f2 = fs[2]!;
      return (c) => {
        const a0 = f0(c);
        const a1 = f1(c);
        return impl(c, a0, a1, f2(c));
      };
    }
    default:
      return (c) => {
        const a0 = fs[0]!(c);
        const a1 = fs[1]!(c);
        const a2 = fs[2]!(c);
        for (let i = 3; i < fs.length; i++) fs[i]!(c);
        return impl(c, a0, a1, a2);
      };
  }
}

/** the target first, then every argument in order, keeping the first two */
function methodFn(fn: string, target: Expr, args: readonly Expr[]): Fn {
  const impl = Object.prototype.hasOwnProperty.call(METHODS, fn) ? METHODS[fn]! : METHOD_DEFAULT;
  const ft = fnOf(target);
  const fs = args.map(fnOf);
  switch (fs.length) {
    case 0:
      return (c) => impl(ft(c), undefined, undefined);
    case 1: {
      const f0 = fs[0]!;
      return (c) => {
        const x = ft(c);
        return impl(x, f0(c), undefined);
      };
    }
    default:
      return (c) => {
        const x = ft(c);
        const a0 = fs[0]!(c);
        const a1 = fs[1]!(c);
        for (let i = 2; i < fs.length; i++) fs[i]!(c);
        return impl(x, a0, a1);
      };
  }
}

function compile(expr: Expr): Fn {
  switch (expr.k) {
    case 'num': {
      const v = expr.v;
      return () => v;
    }
    case 'v3': {
      const v = expr.v;
      return () => v;
    }
    case 'vec': {
      const fx = fnOf(expr.x), fy = fnOf(expr.y), fz = fnOf(expr.z);
      return (c) => {
        const x = component(fx(c), 0);
        const y = component(fy(c), 0);
        return vec(x, y, component(fz(c), 0));
      };
    }
    case 'roll': {
      // `a..b` is a value uniform in [a, b), fixed per particle (`sk/fx`: `size=.08..0.16`, `spin=-9..9`, `up(.08..0.12)
      // rolls per particle`, `cone(15)*(.2..0.5)`, colour ranges `tint=<…>..<…>`): lo + r·(hi − lo) with the particle's
      // birth roll r of this slot (the simulator draws it at birth, in slot order: the draw order is the roll's own, never
      // this evaluation's). One r for every component of a vector range, so a colour range mixes the two colours. The
      // bounds are evaluated lo first, then hi; a bound may itself be a range (its own slot) or any expression.
      const slot = expr.slot;
      const flo = fnOf(expr.lo), fhi = fnOf(expr.hi);
      return (c) => {
        if (c.rangeRolls === false) return c.roll(slot);
        const lo = flo(c);
        const hi = fhi(c);
        const r = c.roll(slot);
        if (typeof lo === 'number' && typeof hi === 'number') return lo + r * (hi - lo);
        // add(lo, mul(sub(hi, lo), r)) without its two intermediate triples: per component lo_i + (hi_i - lo_i) * r
        const l0 = component(lo, 0), l1 = component(lo, 1), l2 = component(lo, 2);
        return vec(l0 + (component(hi, 0) - l0) * r, l1 + (component(hi, 1) - l1) * r, l2 + (component(hi, 2) - l2) * r);
      };
    }
    case 'attr': {
      const name = expr.name;
      return (c) => c.attr(name);
    }
    case 'count': {
      const pop = expr.pop;
      return (c) => c.count(pop);
    }
    case 'neg': {
      const fa = fnOf(expr.a);
      return (c) => mul(fa(c), -1);
    }
    case 'call':
      return callFn(expr.fn, expr.args);
    case 'method':
      return methodFn(expr.fn, expr.target, expr.args);
    case 'smooth': {
      const fa = fnOf(expr.a);
      return (c) => c.smooth(expr, fa(c) as number);
    }
    case 'keys': {
      const frames = expr.frames;
      const fs = frames.map((k) => fnOf(k.v));
      return (c) => {
        const t = c.life > 0 ? Math.min(1, Math.max(0, c.age / c.life)) : 1;
        let i = 1;
        while (i < frames.length && t > frames[i]!.t) i++;
        const bi = Math.min(i, frames.length - 1);
        const ai = Math.max(0, i - 1);
        const b = frames[bi]!;
        const a = frames[ai]!;
        const span = b.t - a.t;
        const f = span > 0 ? (t - a.t) / span : 1;
        // add(mul(A, 1 - f), mul(B, f)) without its two intermediate triples: per component (A_i · (1 - f)) + (B_i · f),
        // a number when both ends are numbers (the same products and sum, in the same order)
        const va = fs[ai]!(c);
        const vb = fs[bi]!(c);
        const g = 1 - f;
        if (typeof va === 'number' && typeof vb === 'number') return va * g + vb * f;
        return vec(component(va, 0) * g + component(vb, 0) * f, component(va, 1) * g + component(vb, 1) * f, component(va, 2) * g + component(vb, 2) * f);
      };
    }
    case 'bin': {
      const fa = fnOf(expr.a), fb = fnOf(expr.b);
      const op = expr.op === '+' ? add : expr.op === '-' ? sub : expr.op === '*' ? mul : div;
      return (c) => {
        const a = fa(c);
        return op(a, fb(c));
      };
    }
  }
}

export function evaluate(expr: Expr, c: FxEvalContext): FxValue {
  return fnOf(expr)(c);
}

/** an expression's evaluator, for a caller that runs it per particle (`evaluate(expr, c)` is `compileExpr(expr)(c)`) */
export type FxExprFn = Fn;
export const compileExpr: (expr: Expr) => FxExprFn = fnOf;

/** a field term that adds its acceleration to `out` (exactly `out[i] += acceleration(term, c)[i]`, without the triple) */
export type FxFieldFn = (c: FxEvalContext, out: [number, number, number]) => void;
/** a field term's adder, built once per term (it reads nothing but its context): every simulation of a program shares it */
const fieldAdders = new WeakMap<FieldTerm, FxFieldFn>();
export function compileField(term: FieldTerm): FxFieldFn {
  let f = fieldAdders.get(term);
  if (f === undefined) fieldAdders.set(term, (f = buildField(term)));
  return f;
}
function buildField(term: FieldTerm): FxFieldFn {
  const value = callFn(term.field, term.args);
  const scale = fnOf(term.scale);
  return (c, out) => {
    const v = value(c);
    const sv = scale(c);
    const s = typeof sv === 'number' ? sv : 1;
    if (typeof v === 'number') {
      const k = v * s;
      out[0] += k;
      out[1] += k;
      out[2] += k;
    } else {
      out[0] += v[0] * s;
      out[1] += v[1] * s;
      out[2] += v[2] * s;
    }
  };
}

interface FieldFn {
  value: Fn;
  scale: Fn;
}
/** the compiled call and scale of a field term, built once per term */
const fieldFns = new WeakMap<FieldTerm, FieldFn>();

export function acceleration(term: FieldTerm, c: FxEvalContext): Vec3 {
  let f = fieldFns.get(term);
  if (f === undefined) fieldFns.set(term, (f = { value: callFn(term.field, term.args), scale: fnOf(term.scale) }));
  const value = f.value(c);
  const scale = f.scale(c);
  const v = isVec(value) ? value : vec(value, value, value);
  const s = typeof scale === 'number' ? scale : 1;
  return [v[0] * s, v[1] * s, v[2] * s];
}
