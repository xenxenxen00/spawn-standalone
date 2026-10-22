// `builtin/math` for the carried game code (engine api:1427-1442; contract §20; docs/architecture.md §3.4; WP C2). Pure and
// engine-free. The live tree imports one export, `stepAngle` (`scripts/humanoid-locomotion.js:26,193`, smoothing 0.06 s,
// 900 °/s from `scripts/lib/data/player.yml`); the rest of the documented module is here too so a carried import of it
// resolves.
//
// stepAngle(current, target, dt, { smoothing = 0.06, maxDegPerSec }): one step of an exponential approach along the shortest
// arc, `arc·(1 − exp(−dt/smoothing))` (contract §20 [INF]; the engine's own formula was never measured), capped at
// `maxDegPerSec·dt`. The result is continuous (current + step, not re-wrapped, so a turn across ±180 never jumps) and is the
// target itself, exactly as passed, once less than a thousandth of a degree would be left: the live code sleeps an idle body
// on `gait.bodyYaw === targetYaw` (`scripts/humanoid-locomotion.js:283`), which an asymptotic approach would never meet.

export type OklchString = `oklch(${string})`;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function inverseLerp(a: number, b: number, value: number): number {
  return a === b ? 0 : (value - a) / (b - a);
}

export function remap(inMin: number, inMax: number, outMin: number, outMax: number, value: number): number {
  return lerpNumber(outMin, outMax, inverseLerp(inMin, inMax, value));
}

/** Hermite 0..1 between the edges; equal edges step at the edge */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = clamp01((x - edge0) / (edge1 - edge0));
  return t * t * (3 - 2 * t);
}

export function degToRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

export function radToDeg(rad: number): number {
  return (rad * 180) / Math.PI;
}

/** degrees into (−180, 180] */
function wrap180(deg: number): number {
  let a = deg % 360;
  if (a > 180) a -= 360;
  else if (a <= -180) a += 360;
  return a + 0; // no −0
}

/** the signed turn from one heading to another, in (−180, 180] */
export function shortestArc(fromDeg: number, toDeg: number): number {
  return wrap180(toDeg - fromDeg);
}

/** a turn closer than this to its target lands on the target itself */
const SETTLE_DEG = 1e-3;

export function stepAngle(currentDeg: number, targetDeg: number, dt: number, opts: { smoothing?: number; maxDegPerSec?: number } = {}): number {
  const arc = shortestArc(currentDeg, targetDeg);
  if (arc === 0) return targetDeg;
  if (!(dt > 0)) return currentDeg;
  const smoothing = opts.smoothing ?? 0.06;
  let step = smoothing > 0 ? arc * (1 - Math.exp(-dt / smoothing)) : arc;
  const cap = opts.maxDegPerSec;
  if (typeof cap === 'number' && Number.isFinite(cap)) {
    const max = Math.max(0, cap) * dt;
    if (Math.abs(step) > max) step = Math.sign(step) * max;
  }
  if (Math.abs(arc - step) < SETTLE_DEG) return targetDeg;
  return currentDeg + step;
}

function lerpNumber(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

// ── oklch colours ───────────────────────────────────────────────────────────────────────────────────────────────────────

interface Oklch {
  l: number;
  c: number;
  h: number;
  alpha: number | null;
}

const OKLCH = /^\s*oklch\(\s*([-+.\d]+)(%?)\s+([-+.\d]+)\s+([-+.\d]+)(?:deg)?\s*(?:\/\s*([-+.\d]+)(%?)\s*)?\)\s*$/i;

function parseOklch(s: unknown): Oklch {
  const m = typeof s === 'string' ? OKLCH.exec(s) : null;
  if (!m) throw new TypeError(`builtin/math lerp: ${JSON.stringify(s)} is neither a number nor an oklch() colour`);
  const num = (x: string | undefined, pct: string | undefined): number => {
    const v = Number(x);
    if (!Number.isFinite(v)) throw new TypeError(`builtin/math lerp: bad number in ${JSON.stringify(s)}`);
    return pct ? v / 100 : v;
  };
  return { l: num(m[1], m[2]), c: num(m[3], ''), h: num(m[4], ''), alpha: m[5] === undefined ? null : num(m[5], m[6]) };
}

const fmt = (v: number): string => {
  const s = v.toFixed(4).replace(/\.?0+$/, '');
  return s === '-0' ? '0' : s;
};

function lerpOklch(a: string, b: string, t: number): OklchString {
  const x = parseOklch(a);
  const y = parseOklch(b);
  const h = (((x.h + shortestArc(x.h, y.h) * t) % 360) + 360) % 360;
  const alpha = x.alpha === null && y.alpha === null ? null : lerpNumber(x.alpha ?? 1, y.alpha ?? 1, t);
  return `oklch(${fmt(lerpNumber(x.l, y.l, t))} ${fmt(lerpNumber(x.c, y.c, t))} ${fmt(h)}${alpha === null ? '' : ` / ${fmt(alpha)}`})`;
}

/** a + (b − a)·t (unclamped); two oklch() colours mix channel by channel, the hue along the shortest arc */
export function lerp(a: number, b: number, t: number): number;
export function lerp(a: OklchString, b: OklchString, t: number): OklchString;
export function lerp(a: number | OklchString, b: number | OklchString, t: number): number | OklchString {
  if (typeof a === 'number' && typeof b === 'number') return lerpNumber(a, b, t);
  return lerpOklch(String(a), String(b), t);
}
