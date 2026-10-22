// Compiled clips: the one clip shape every source compiles to (authored YAML, library GLBs, clip functions, model-embedded
// clips), its sampling, loop-time mapping and its JSON form (docs/design/motion-physics-nav.md §3.2, §3.3, §3.5.3).
// Engine-free, allocation-free on the sampling path.
import { qNlerp, type Num } from './quat.ts';

export type TrackProp = 'rotation' | 'position' | 'scale';
export type TrackInterp = 'linear' | 'step';
export type ClipKind = 'absolute' | 'delta';
export type LoopMode = 'once' | 'loop' | 'pingpong';

export interface Track {
  readonly bone: string;
  readonly prop: TrackProp;
  readonly interp: TrackInterp;
  /** seconds, ascending, first ≥ 0 */
  readonly times: Float32Array;
  /** 4 per key (rotation x, y, z, w) or 3 per key (position, scale) */
  readonly values: Float32Array;
}

export interface CompiledClip {
  /** 'cdn/clip-walk-loop.glb' | 'anim/hollow.yml#walk' | '<modelId>#fire' | 'scripts/humanoid-locomotion.js#sit' */
  readonly id: string;
  /** delta = authored tracks on the bind pose (AGENTS.md:137): local R = bindR·q, T = bindT + offset */
  readonly kind: ClipKind;
  /** seconds at speed 1 */
  readonly duration: number;
  readonly fps?: number;
  /** 'hips' = position values are fractions of the rig's hips rest height */
  readonly units?: 'm' | 'hips';
  readonly tracks: readonly Track[];
  /** library clips: the rig the absolute tracks are expressed on */
  readonly sourceRig?: string;
}

/** A clip resolved against one rig (bone indices, retarget applied): produced by MA2/MA3 (`retarget.ts`, `mixer.ts`). */
export interface BoundClip {
  readonly clip: CompiledClip;
  readonly rigId: string;
  /** per track: the rig bone index, −1 when the rig lacks the bone */
  readonly boneIdx: Int16Array;
  /** per rig bone: 1 when the clip names it (ownership for per-bone normalisation, motion §3.5.4) */
  readonly names: Uint8Array;
  readonly kind: ClipKind;
}

/** A clip function `(t) => ({Bone: {position?, rotation?: [pitch, yaw, roll] deg, scale?}})` (motion §3.3.3). */
export interface ClipFunction {
  (t: number): Record<string, { position?: readonly number[]; rotation?: readonly number[]; scale?: readonly number[] }>;
  duration?: number;
  fps?: number;
  units?: 'm' | 'hips';
}

/** Keys of one authored component: values spread over the duration, or [seconds, value] pairs (api builtin/anim). */
export type TrackKeys = number | readonly number[] | ReadonlyArray<readonly [number, number]>;

export interface AuthoredTrackSpec {
  pitch?: TrackKeys;
  yaw?: TrackKeys;
  roll?: TrackKeys;
  x?: TrackKeys;
  y?: TrackKeys;
  z?: TrackKeys;
}

/** An authored clip as `builtin/anim.clips()` returns it and `play()` takes it (motion §3.6). */
export interface AuthoredClipObject {
  name?: string;
  duration?: number;
  fps?: number;
  tracks: Record<string, AuthoredTrackSpec>;
}

/** What a channel write's `clip` may be (motion §3.2). */
export type ClipRef = string | ClipFunction | AuthoredClipObject;

export const strideOf = (prop: TrackProp): 3 | 4 => (prop === 'rotation' ? 4 : 3);

export function trackKeyCount(t: Track): number {
  return t.times.length;
}

/** Builds a track, checking the value count and that times ascend (equal neighbours allowed). */
export function makeTrack(bone: string, prop: TrackProp, interp: TrackInterp, times: ArrayLike<number>, values: ArrayLike<number>): Track {
  const n = times.length;
  if (n === 0) throw new Error(`track ${bone}.${prop}: no keys`);
  if (values.length !== n * strideOf(prop)) {
    throw new Error(`track ${bone}.${prop}: ${values.length} values for ${n} keys (stride ${strideOf(prop)})`);
  }
  for (let i = 1; i < n; i++) {
    if (!(times[i]! >= times[i - 1]!)) throw new Error(`track ${bone}.${prop}: key times must be ascending (${times[i - 1]} then ${times[i]})`);
  }
  return { bone, prop, interp, times: Float32Array.from(times), values: Float32Array.from(values) };
}

/** Index of the last key with time ≤ t, clamped to [0, n−1] (binary search). */
export function findKey(times: Float32Array, t: number): number {
  const n = times.length;
  if (n === 0 || t <= times[0]!) return 0;
  if (t >= times[n - 1]!) return n - 1;
  let lo = 0;
  let hi = n - 1; // invariant: times[lo] ≤ t < times[hi]
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= t) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Samples a track at clip time t into out[o..]: held flat before the first and after the last key; LINEAR rotations nlerp with
 * hemisphere alignment (keys ≤ 0.1 s apart: below 0.05° from slerp, motion §3.3.1), LINEAR vectors lerp, STEP holds the earlier key.
 */
export function sampleTrack(track: Track, t: number, out: Num, o: number): void {
  const { times, values } = track;
  const s = strideOf(track.prop);
  const i = findKey(times, t);
  const n = times.length;
  const t0 = times[i]!;
  if (track.interp === 'step' || i === n - 1 || t <= t0) {
    for (let k = 0; k < s; k++) out[o + k] = values[i * s + k]!;
    return;
  }
  const t1 = times[i + 1]!;
  const u = t1 > t0 ? (t - t0) / (t1 - t0) : 1;
  if (s === 4) {
    qNlerp(out, o, values, i * 4, values, i * 4 + 4, u);
    return;
  }
  const a = i * 3;
  for (let k = 0; k < 3; k++) out[o + k] = values[a + k]! + (values[a + 3 + k]! - values[a + k]!) * u;
}

/** Maps a channel's running clip time to a time inside the clip (motion §3.5.3). */
export function clipTime(t: number, duration: number, loop: LoopMode): number {
  if (!(duration > 0)) return 0;
  switch (loop) {
    case 'once':
      return t <= 0 ? 0 : t >= duration ? duration : t;
    case 'loop': {
      const m = t % duration;
      return m < 0 ? m + duration : m;
    }
    case 'pingpong': {
      const p = 2 * duration;
      let m = t % p;
      if (m < 0) m += p;
      return m <= duration ? m : p - m;
    }
  }
}

// ── JSON form (cooked files, virtual:ss/anim) ───────────────────────────────────────────────────────────────────────────────

export interface TrackJson {
  bone: string;
  prop: TrackProp;
  interp: TrackInterp;
  times: number[];
  values: number[];
}

export interface CompiledClipJson {
  id: string;
  kind: ClipKind;
  duration: number;
  fps?: number;
  units?: 'm' | 'hips';
  sourceRig?: string;
  tracks: TrackJson[];
}

/** Rounds to `digits` decimals (6 by default: below Float32 resolution at unit scale) and normalises −0. */
export function roundTo(v: number, digits = 6): number {
  const f = 10 ** digits;
  const r = Math.round(v * f) / f;
  return r === 0 ? 0 : r;
}

export function trackToJson(t: { bone: string; prop: TrackProp; interp: TrackInterp; times: ArrayLike<number>; values: ArrayLike<number> }, digits = 6): TrackJson {
  return {
    bone: t.bone,
    prop: t.prop,
    interp: t.interp,
    times: Array.from(t.times, (v) => roundTo(v, digits)),
    values: Array.from(t.values, (v) => roundTo(v, digits)),
  };
}

export function clipToJson(c: CompiledClip, digits = 6): CompiledClipJson {
  const j: CompiledClipJson = { id: c.id, kind: c.kind, duration: c.duration, tracks: [] };
  if (c.fps !== undefined) j.fps = c.fps;
  if (c.units !== undefined) j.units = c.units;
  if (c.sourceRig !== undefined) j.sourceRig = c.sourceRig;
  j.tracks = c.tracks.map((t) => trackToJson(t, digits));
  return j;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNumArray = (v: unknown): v is number[] => Array.isArray(v) && v.every((x) => typeof x === 'number');
const PROPS: readonly string[] = ['rotation', 'position', 'scale'];

/** Validates and converts the JSON form (typed arrays); throws with the clip id on malformed input. */
export function clipFromJson(v: unknown): CompiledClip {
  if (!isObj(v) || typeof v['id'] !== 'string') throw new Error('clip json: expected an object with an id');
  const id = v['id'];
  const kind = v['kind'];
  const duration = v['duration'];
  if (kind !== 'absolute' && kind !== 'delta') throw new Error(`clip json ${id}: bad kind ${String(kind)}`);
  if (typeof duration !== 'number' || !(duration >= 0)) throw new Error(`clip json ${id}: bad duration`);
  const rawTracks = v['tracks'];
  if (!Array.isArray(rawTracks)) throw new Error(`clip json ${id}: tracks must be an array`);
  const tracks = rawTracks.map((t: unknown, i) => {
    if (!isObj(t) || typeof t['bone'] !== 'string' || typeof t['prop'] !== 'string' || !PROPS.includes(t['prop'])) {
      throw new Error(`clip json ${id}: track ${i} malformed`);
    }
    const interp = t['interp'] ?? 'linear';
    if (interp !== 'linear' && interp !== 'step') throw new Error(`clip json ${id}: track ${i} bad interp`);
    if (!isNumArray(t['times']) || !isNumArray(t['values'])) throw new Error(`clip json ${id}: track ${i} times/values must be numbers`);
    try {
      return makeTrack(t['bone'], t['prop'] as TrackProp, interp, t['times'], t['values']);
    } catch (e) {
      throw new Error(`clip json ${id}: ${(e as Error).message}`);
    }
  });
  const clip: { -readonly [K in keyof CompiledClip]: CompiledClip[K] } = { id, kind, duration, tracks };
  if (typeof v['fps'] === 'number') clip.fps = v['fps'];
  if (v['units'] === 'm' || v['units'] === 'hips') clip.units = v['units'];
  if (typeof v['sourceRig'] === 'string') clip.sourceRig = v['sourceRig'];
  return clip;
}
