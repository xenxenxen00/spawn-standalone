// `builtin/tween` for the carried game code (engine api:1398-1404; contract §20; docs/architecture.md §3.4; WP C2). Engine-free.
//
//   animate(ctx, target, keyframes, opts?): { stop() }
//     target     a handle (ctx.self) or a row id (resolved once with ctx.getObject; the docs say a string, the game passes handles)
//     keyframes  { 'dot.path': value }: a number, an oklch() colour, a relative '+=5' / '-=5', waypoints [a, b, …] (equal
//                segments) or segments [{ value, duration?, easing? }, …] (duration in seconds)
//     opts       { duration = 1 s, easing = 'linear', delay = 0 s, direction 'normal' | 'reverse' | 'alternate', loop: true
//                (forever) | n (n passes) }   (defaults [INF]: every live call names duration and easing)
//
// Engine-side and on the sim clock: Spawn replicated a tween with no per-tick game writes; here the kernel's TweenRunner
// writes the values through the target handle once per tick, at the end of the UPDATE step (sched/scheduler.ts), from
// ctx.now(). So a tween pauses with the clock (no tick, no write, `now` frozen) and completes on the first tick whose now
// reaches its start + duration, where it writes the exact end value and ends. A tween starts from the value the path has
// when animate is called; a later tween of the same (target, path) replaces the earlier one; a tween ends with its target
// row. The writes run outside any hook, so they are the engine's: they never wake a sleeping behavior.
//
// The runner is per kernel; animate finds it on the ctx under TWEEN_RUNNER (the ctx factories call attachTweenRunner, C5).
import { cloneWire, isPlainObject, setPath } from '../core/wire.ts';
import { lerp as lerpValue, type OklchString } from './math.ts';

/** where a ctx carries its kernel's tween runner (Symbol.for: the same key from every copy of this module) */
export const TWEEN_RUNNER: unique symbol = Symbol.for('ss.compat.tweenRunner') as never;

export type EasingFn = (t: number) => number;

const PI = Math.PI;
const bounceOut: EasingFn = (t) => {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
  if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
  return n1 * (t -= 2.625 / d1) * t + 0.984375;
};

/** the `builtin/easing` curves by name (api:1465-1469), each 0 → 1 over t in [0, 1] */
export const EASINGS: Readonly<Record<string, EasingFn>> = Object.freeze({
  linear: (t: number) => t,
  easeOutBounce: bounceOut,
  easeInQuad: (t: number) => t * t,
  easeOutQuad: (t: number) => 1 - (1 - t) * (1 - t),
  easeInOutQuad: (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2),
  easeInCubic: (t: number) => t ** 3,
  easeOutCubic: (t: number) => 1 - (1 - t) ** 3,
  easeInOutCubic: (t: number) => (t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2),
  easeInQuart: (t: number) => t ** 4,
  easeOutQuart: (t: number) => 1 - (1 - t) ** 4,
  easeInOutQuart: (t: number) => (t < 0.5 ? 8 * t ** 4 : 1 - (-2 * t + 2) ** 4 / 2),
  easeInQuint: (t: number) => t ** 5,
  easeOutQuint: (t: number) => 1 - (1 - t) ** 5,
  easeInOutQuint: (t: number) => (t < 0.5 ? 16 * t ** 5 : 1 - (-2 * t + 2) ** 5 / 2),
  easeInSine: (t: number) => 1 - Math.cos((t * PI) / 2),
  easeOutSine: (t: number) => Math.sin((t * PI) / 2),
  easeInOutSine: (t: number) => -(Math.cos(PI * t) - 1) / 2,
  easeInExpo: (t: number) => (t === 0 ? 0 : 2 ** (10 * t - 10)),
  easeOutExpo: (t: number) => (t === 1 ? 1 : 1 - 2 ** (-10 * t)),
  easeInOutExpo: (t: number) => (t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2),
  easeInCirc: (t: number) => 1 - Math.sqrt(1 - t * t),
  easeOutCirc: (t: number) => Math.sqrt(1 - (t - 1) * (t - 1)),
  easeInOutCirc: (t: number) => (t < 0.5 ? (1 - Math.sqrt(1 - (2 * t) ** 2)) / 2 : (Math.sqrt(1 - (-2 * t + 2) ** 2) + 1) / 2),
});

/** the slice of a ctx animate reads */
export interface TweenCtx {
  now(): number;
  getObject?(id: string): unknown;
}

export interface AnimateOptions {
  /** seconds (default 1) */
  duration?: number;
  /** a builtin/easing name (default 'linear') */
  easing?: string;
  /** seconds before the tween starts */
  delay?: number;
  direction?: 'normal' | 'reverse' | 'alternate';
  /** true: forever; a number: that many passes */
  loop?: boolean | number;
}

export interface TweenHandle {
  stop(): void;
}

/** reads of these handle fields are snapshots (core D-CORE-03): a nested key is written by assigning the whole field */
const SNAPSHOT_FIELDS = new Set(['feetPosition', 'worldFeetPosition', 'rotation', 'velocity', 'angularVelocity', 'scale', 'effectiveScale', 'bounds']);

/** float slack for times derived from ctx.now() (ms) */
const EPS_MS = 1e-6;

type Value = number | OklchString;

interface Segment {
  readonly from: Value;
  readonly to: Value;
  /** ms from the start of the pass */
  readonly start: number;
  readonly dur: number;
  readonly ease: EasingFn;
}

interface Track {
  readonly key: string;
  readonly path: readonly string[];
  readonly segments: readonly Segment[];
  /** ms */
  readonly total: number;
  readonly first: Value;
  readonly last: Value;
  written: Value | undefined;
}

interface Tween {
  readonly target: object;
  readonly targetId: string | null;
  tracks: Track[];
  readonly startMs: number;
  /** ms of one pass */
  readonly passMs: number;
  /** Infinity for loop: true */
  readonly passes: number;
  readonly direction: 'normal' | 'reverse' | 'alternate';
  done: boolean;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isOklch = (v: unknown): v is OklchString => typeof v === 'string' && /^\s*oklch\(/i.test(v);

function readPath(target: object, path: readonly string[]): unknown {
  let cur: unknown = target;
  for (const k of path) {
    if (typeof cur !== 'object' || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

function writePath(target: object, path: readonly string[], value: unknown): void {
  const root = path[0]!;
  const t = target as Record<string, unknown>;
  if (path.length === 1) {
    t[root] = value;
    return;
  }
  if (SNAPSHOT_FIELDS.has(root)) {
    const base = cloneWire(t[root]);
    const copy = typeof base === 'object' && base !== null && !Array.isArray(base) ? base : {};
    setPath(copy, path.slice(1), value);
    t[root] = copy;
    return;
  }
  // through the live object: state and ObjectProperties reads are write-through proxies (core §5.3)
  let cur = t;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i]!;
    let next = cur[k];
    if (typeof next !== 'object' || next === null) {
      cur[k] = {};
      next = cur[k];
    }
    cur = next as Record<string, unknown>;
  }
  cur[path[path.length - 1]!] = value;
}

function interpolate(a: Value, b: Value, t: number): Value {
  if (typeof a === 'number' && typeof b === 'number') return a + (b - a) * t;
  if (isOklch(a) && isOklch(b)) return lerpValue(a, b, t);
  return t >= 1 ? b : a;
}

export class TweenRunner {
  #tweens: Tween[] = [];
  readonly #warn: (message: string) => void;
  readonly #warned = new Set<string>();

  constructor(opts: { warn?: (message: string) => void } = {}) {
    this.#warn = opts.warn ?? ((m) => console.warn(m));
  }

  /** running tweens */
  get size(): number {
    return this.#tweens.length;
  }

  /** a tween on `target` from `nowMs` (animate) */
  add(nowMs: number, target: object, keyframes: Readonly<Record<string, unknown>>, opts: AnimateOptions = {}): TweenHandle {
    const durMs = Math.max(0, isNum(opts.duration) ? opts.duration * 1000 : 1000);
    const ease = this.#easing(opts.easing);
    const tracks: Track[] = [];
    for (const key of Object.keys(keyframes)) {
      const track = this.#track(target, key, keyframes[key], durMs, ease);
      if (track) tracks.push(track);
    }
    const passMs = tracks.reduce((m, t) => Math.max(m, t.total), 0);
    const loop = opts.loop;
    const passes = loop === true ? Number.POSITIVE_INFINITY : isNum(loop) ? Math.max(1, Math.floor(loop)) : 1;
    const direction = opts.direction === 'reverse' || opts.direction === 'alternate' ? opts.direction : 'normal';
    const idOf = (target as { id?: unknown }).id;
    const tween: Tween = {
      target,
      targetId: typeof idOf === 'string' ? idOf : null,
      tracks,
      startMs: nowMs + Math.max(0, isNum(opts.delay) ? opts.delay * 1000 : 0),
      passMs,
      passes,
      direction,
      done: tracks.length === 0,
    };
    if (tween.done) return { stop: () => {} };
    // a later tween of the same (target, path) replaces the earlier one
    const keys = new Set(tracks.map((t) => t.key));
    for (const other of this.#tweens) {
      if (other.target !== target) continue;
      other.tracks = other.tracks.filter((t) => !keys.has(t.key));
      if (other.tracks.length === 0) other.done = true;
    }
    this.#tweens = [...this.#tweens.filter((t) => !t.done), tween];
    return {
      stop: () => {
        if (tween.done) return;
        tween.done = true;
        this.#tweens = this.#tweens.filter((t) => t !== tween);
      },
    };
  }

  /** once per tick, at the end of UPDATE: writes every running tween's values for `nowMs` */
  step(nowMs: number): void {
    if (this.#tweens.length === 0) return;
    let ended = false;
    for (const tw of [...this.#tweens]) {
      if (tw.done) {
        ended = true;
        continue;
      }
      const elapsed = nowMs - tw.startMs;
      if (elapsed < -EPS_MS) continue; // the delay runs
      let q: number;
      let final = false;
      if (tw.passMs <= 0 || elapsed >= tw.passMs * tw.passes - EPS_MS) {
        final = true;
        const lastPass = Number.isFinite(tw.passes) ? tw.passes - 1 : 0;
        q = this.#forward(tw, lastPass) ? 1 : 0;
      } else {
        const k = Math.floor((Math.max(0, elapsed) + EPS_MS) / tw.passMs);
        const u = Math.min(1, Math.max(0, (elapsed - k * tw.passMs) / tw.passMs));
        q = this.#forward(tw, k) ? u : 1 - u;
      }
      try {
        for (const track of tw.tracks) {
          const v = final ? (q >= 1 ? track.last : track.first) : this.#valueAt(track, q * tw.passMs);
          if (v === track.written) continue;
          writePath(tw.target, track.path, v);
          track.written = v;
        }
      } catch (err) {
        this.#warn(`[builtin/tween] a write to ${tw.targetId ?? 'its target'} failed (${err instanceof Error ? err.message : String(err)}); the tween stops`);
        final = true;
      }
      if (final) {
        tw.done = true;
        ended = true;
      }
    }
    if (ended) this.#tweens = this.#tweens.filter((t) => !t.done);
  }

  /** ends every tween of a row id; returns how many */
  stopTarget(id: string): number {
    return this.#stopWhere((t) => t.targetId === id);
  }

  /** ends every tween writing through one of these handles (a destroyed row's handles); returns how many */
  stopHandles(handles: Iterable<unknown>): number {
    const set = new Set(handles);
    return set.size === 0 ? 0 : this.#stopWhere((t) => set.has(t.target));
  }

  clear(): void {
    for (const t of this.#tweens) t.done = true;
    this.#tweens = [];
  }

  #stopWhere(pred: (t: Tween) => boolean): number {
    let n = 0;
    for (const t of this.#tweens) {
      if (!t.done && pred(t)) {
        t.done = true;
        n++;
      }
    }
    if (n > 0) this.#tweens = this.#tweens.filter((t) => !t.done);
    return n;
  }

  #forward(tw: Tween, pass: number): boolean {
    if (tw.direction === 'normal') return true;
    if (tw.direction === 'reverse') return false;
    return pass % 2 === 0;
  }

  #valueAt(track: Track, ms: number): Value {
    if (ms >= track.total) return track.last;
    for (const s of track.segments) {
      if (ms < s.start + s.dur || s === track.segments[track.segments.length - 1]) {
        const p = s.dur > 0 ? Math.min(1, Math.max(0, (ms - s.start) / s.dur)) : 1;
        return interpolate(s.from, s.to, s.ease(p));
      }
    }
    return track.last;
  }

  #easing(name: unknown): EasingFn {
    if (name === undefined || name === null) return EASINGS['linear']!;
    const fn = typeof name === 'string' ? EASINGS[name] : undefined;
    if (fn) return fn;
    const key = `easing:${String(name)}`;
    if (!this.#warned.has(key)) {
      this.#warned.add(key);
      this.#warn(`[builtin/tween] unknown easing ${JSON.stringify(name)}; linear instead`);
    }
    return EASINGS['linear']!;
  }

  /** one key of the keyframes as a track of segments from the path's current value; null when it cannot animate */
  #track(target: object, key: string, spec: unknown, durMs: number, ease: EasingFn): Track | null {
    const path = key.split('.');
    if (path.some((k) => k.length === 0)) {
      this.#warn(`[builtin/tween] ${JSON.stringify(key)} is not a dot path; ignored`);
      return null;
    }
    const current = readPath(target, path);
    // the steps: [value, duration ms | null, easing | null]
    const steps: Array<[unknown, number | null, EasingFn | null]> = [];
    const add = (v: unknown, d: unknown, e: unknown): void => {
      steps.push([v, isNum(d) ? Math.max(0, d * 1000) : null, e === undefined ? null : this.#easing(e)]);
    };
    if (Array.isArray(spec)) {
      for (const item of spec) {
        if (isPlainObject(item) && 'value' in item) add(item['value'], item['duration'], item['easing']);
        else add(item, undefined, undefined);
      }
    } else if (isPlainObject(spec) && 'value' in spec) add(spec['value'], spec['duration'], spec['easing']);
    else add(spec, undefined, undefined);
    if (steps.length === 0) return null;
    const share = durMs / steps.length;
    const segments: Segment[] = [];
    let from: Value | null = isNum(current) || isOklch(current) ? current : null;
    let t = 0;
    for (const [raw, dur, segEase] of steps) {
      const to = this.#target(raw, from, key);
      if (to === null) return null;
      const d = dur ?? share;
      segments.push({ from: from ?? to, to, start: t, dur: d, ease: segEase ?? ease });
      t += d;
      from = to;
    }
    return { key, path, segments, total: t, first: segments[0]!.from, last: segments[segments.length - 1]!.to, written: undefined };
  }

  /** a keyframe value: a number, an oklch() colour or a relative '+=n' / '-=n' from the previous value */
  #target(raw: unknown, from: Value | null, key: string): Value | null {
    if (isNum(raw) || isOklch(raw)) return raw;
    if (typeof raw === 'string') {
      const m = /^\s*([+-])=\s*(-?\d*\.?\d+(?:e[+-]?\d+)?)\s*$/i.exec(raw);
      if (m && typeof from === 'number') return from + (m[1] === '-' ? -1 : 1) * Number(m[2]);
    }
    this.#warn(`[builtin/tween] ${key}: ${JSON.stringify(raw)} is not a value this tween can reach; the key is ignored`);
    return null;
  }
}

/** called by the ctx factories: the ctx's kernel runner, for animate */
export function attachTweenRunner(ctx: object, runner: TweenRunner): void {
  Object.defineProperty(ctx, TWEEN_RUNNER, { value: runner, enumerable: true, configurable: true, writable: false });
}

/** builtin/tween animate (see the header) */
export function animate(ctx: TweenCtx, target: unknown, keyframes: Readonly<Record<string, unknown>>, opts?: AnimateOptions): TweenHandle {
  const runner = (ctx as { [TWEEN_RUNNER]?: unknown } | null | undefined)?.[TWEEN_RUNNER];
  if (!(runner instanceof TweenRunner)) throw new Error('builtin/tween: this ctx has no tween runner (the kernel attaches one to every ctx it creates)');
  let t: unknown = target;
  if (typeof target === 'string') {
    t = ctx.getObject?.(target) ?? null;
    if (t === null) throw new Error(`builtin/tween: no object ${JSON.stringify(target)} to animate`);
  }
  if (typeof t !== 'object' || t === null) throw new TypeError('builtin/tween: the target must be a handle or a row id');
  if (!isPlainObject(keyframes)) throw new TypeError('builtin/tween: keyframes must be an object of dot paths');
  return runner.add(ctx.now(), t, keyframes, opts ?? {});
}
