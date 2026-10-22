// Authored clips (`anim/<arch>.yml`, `builtin/anim`) → CompiledClip{kind:'delta'} with the live engine's cook rule
// (docs/design/motion-physics-nav.md §3.3.1, D-MPN-04). Isomorphic: the build cook (`tools/motion/cook-anim.ts`) and the
// runtime fallback for clip objects built in game code both call it.
//
// Format: `<clip>: {duration, fps?, tracks: {<Bone>: {pitch|yaw|roll: keys, x|y|z: keys}}}`, keys = values spread over the
// duration or [seconds, value] pairs. Rotation tracks are deltas in the bone's own frame, `local = bindLocal·qX(pitch)·qY(yaw)·
// qZ(roll)` (degrees, intrinsic); x/y/z are metre offsets added to the bind local position.
//
// Cook rule, per bone and property group (rotation = pitch/yaw/roll, position = x/y/z):
//  1. key times = the union of the group's key times, deduped by exact equality (the engine keeps 0.5 and 0.5004 apart);
//     a bare list of n ≥ 2 values sits at t_i = i·duration/(n−1); a single value is a constant at t 0;
//  2. every component is linearly interpolated at every union time, held flat before its first and after its last key;
//     a component the bone does not list is 0;
//  3. value = qX(pitch)·qY(yaw)·qZ(roll) (rotation) or (x, y, z) (position);
//  4. rotation only: a segment whose keys are more than SUBDIVIDE_ANGLE_DEG apart and whose Euler path leaves the slerp arc gets
//     the Euler value at its time midpoint as an extra key, recursively (measured on the live cache, constants.ts).
// The engine cache of the live tree (120 files of live archetypes, 2,084 tracks) is matched to ≤ 1e-5
// (tests/unit/motion/cook-cache.node.test.ts).
import { type AuthoredClipObject, type CompiledClip, type TrackKeys, makeTrack } from './clip.ts';
import { AUTHORED_DEFAULT_FPS, SUBDIVIDE_ANGLE_DEG, SUBDIVIDE_MAX_DEPTH, SUBDIVIDE_PATH_EPS_RAD } from './constants.ts';
import { qAngle, qFromEulerXYZDeg, qSlerp } from './quat.ts';

export type { AuthoredClipObject, AuthoredTrackSpec, TrackKeys } from './clip.ts';

/** Hidden key on the clip objects `builtin/anim.clips()` hands out: their build-cooked CompiledClip (motion §3.6). */
export const SS_COMPILED = Symbol.for('ss.compiled');

/** One cooked track in plain double-precision arrays (the engine's `toTracks` shape, api:1414). */
export interface CookedTrack {
  bone: string;
  prop: 'rotation' | 'position';
  times: number[];
  values: number[];
}

export interface CookedTracks {
  duration: number;
  fps: number;
  tracks: CookedTrack[];
}

const ROT = ['pitch', 'yaw', 'roll'] as const;
const POS = ['x', 'y', 'z'] as const;
const SUBDIVIDE_RAD = (SUBDIVIDE_ANGLE_DEG * Math.PI) / 180;

type Key = readonly [number, number];

const isPair = (v: unknown): v is readonly [number, number] =>
  Array.isArray(v) && v.length >= 2 && typeof v[0] === 'number' && typeof v[1] === 'number';

/** Normalises one component's keys to sorted-as-given [t, v] pairs, or null when the component is absent or empty. */
function keysOf(spec: TrackKeys | undefined, duration: number): Key[] | null {
  if (spec === undefined || spec === null) return null;
  if (typeof spec === 'number') return Number.isFinite(spec) ? [[0, spec]] : null;
  if (!Array.isArray(spec) || spec.length === 0) return null;
  if (isPair(spec[0])) {
    const out: Key[] = [];
    for (const p of spec as readonly unknown[]) if (isPair(p)) out.push([p[0], p[1]]);
    return out.length > 0 ? out : null;
  }
  const vals = (spec as readonly unknown[]).filter((v): v is number => typeof v === 'number');
  if (vals.length === 0) return null;
  if (vals.length === 1) return [[0, vals[0]!]];
  const n = vals.length - 1;
  return vals.map((v, i): Key => [(i * duration) / n, v]);
}

/** Linear interpolation of a key list at t, held flat outside it. */
function sampleKeys(k: readonly Key[], t: number): number {
  const first = k[0]!;
  if (t <= first[0]) return first[1];
  const last = k[k.length - 1]!;
  if (t >= last[0]) return last[1];
  for (let i = 1; i < k.length; i++) {
    const b = k[i]!;
    if (t <= b[0]) {
      const a = k[i - 1]!;
      return b[0] === a[0] ? b[1] : a[1] + ((b[1] - a[1]) * (t - a[0])) / (b[0] - a[0]);
    }
  }
  return last[1];
}

/** Duration of a clip object: its own when positive, else the last pair key time, else (n−1)/fps of the longest bare list. */
function durationOf(clip: AuthoredClipObject, fps: number): number {
  if (typeof clip.duration === 'number' && clip.duration > 0) return clip.duration;
  let pairMax = 0;
  let listMax = 0;
  for (const spec of Object.values(clip.tracks ?? {})) {
    if (spec === null || typeof spec !== 'object') continue;
    for (const c of [...ROT, ...POS]) {
      const k = spec[c];
      if (!Array.isArray(k) || k.length === 0) continue;
      if (isPair(k[0])) for (const p of k as readonly unknown[]) pairMax = isPair(p) ? Math.max(pairMax, p[0]) : pairMax;
      else listMax = Math.max(listMax, (k.length - 1) / fps);
    }
  }
  return pairMax > 0 ? pairMax : listMax;
}

function cookGroup(comps: ReadonlyArray<Key[] | null>, rotation: boolean): { times: number[]; values: number[] } | null {
  if (comps.every((k) => k === null)) return null;
  const set = new Set<number>();
  for (const k of comps) if (k) for (const [t] of k) set.add(t);
  const union = [...set].sort((a, b) => a - b);
  const at = (t: number): [number, number, number] => [
    comps[0] ? sampleKeys(comps[0], t) : 0,
    comps[1] ? sampleKeys(comps[1], t) : 0,
    comps[2] ? sampleKeys(comps[2], t) : 0,
  ];
  if (!rotation) {
    const values: number[] = [];
    for (const t of union) values.push(...at(t));
    return { times: union, values };
  }
  const times: number[] = [];
  const values: number[] = [];
  const q = (e: readonly number[]): number[] => qFromEulerXYZDeg([0, 0, 0, 0], 0, e[0]!, e[1]!, e[2]!);
  const slerpMid = [0, 0, 0, 0];
  // emits the open segment (t0, t1]: midpoints first (in time order), then t1
  const segment = (t0: number, e0: readonly number[], q0: number[], t1: number, e1: readonly number[], q1: number[], depth: number): void => {
    if (depth < SUBDIVIDE_MAX_DEPTH && qAngle(q0, 0, q1, 0) > SUBDIVIDE_RAD) {
      const tm = (t0 + t1) / 2;
      // the components are linear inside a union segment, so the Euler midpoint is their mean
      const em = [(e0[0]! + e1[0]!) / 2, (e0[1]! + e1[1]!) / 2, (e0[2]! + e1[2]!) / 2];
      const qm = q(em);
      qSlerp(slerpMid, 0, q0, 0, q1, 0, 0.5);
      if (qAngle(slerpMid, 0, qm, 0) > SUBDIVIDE_PATH_EPS_RAD) {
        segment(t0, e0, q0, tm, em, qm, depth + 1);
        segment(tm, em, qm, t1, e1, q1, depth + 1);
        return;
      }
    }
    times.push(t1);
    values.push(...q1);
  };
  let e0 = at(union[0]!);
  let q0 = q(e0);
  times.push(union[0]!);
  values.push(...q0);
  for (let i = 1; i < union.length; i++) {
    const t1 = union[i]!;
    const e1 = at(t1);
    const q1 = q(e1);
    segment(union[i - 1]!, e0, q0, t1, e1, q1, 0);
    e0 = e1;
    q0 = q1;
  }
  return { times, values };
}

/** The cook rule in double precision: tracks per bone (authored order), rotation before position. */
export function cookTracks(clip: AuthoredClipObject): CookedTracks {
  const fps = typeof clip.fps === 'number' && clip.fps > 0 ? clip.fps : AUTHORED_DEFAULT_FPS;
  const duration = durationOf(clip, fps);
  const tracks: CookedTrack[] = [];
  for (const [bone, spec] of Object.entries(clip.tracks ?? {})) {
    if (spec === null || typeof spec !== 'object') continue;
    const rot = cookGroup(ROT.map((c) => keysOf(spec[c], duration)), true);
    if (rot) tracks.push({ bone, prop: 'rotation', ...rot });
    const pos = cookGroup(POS.map((c) => keysOf(spec[c], duration)), false);
    if (pos) tracks.push({ bone, prop: 'position', ...pos });
  }
  return { duration, fps, tracks };
}

/** The engine identity of an authored clip: `anim/<file>.yml#<clip>` (engine cache `identity`, motion §3.5.5). */
export function authoredIdentity(path: string, clipName: string): string {
  return `${path}#${clipName}`;
}

/** An authored clip object → CompiledClip{kind:'delta'} under the given identity. */
export function cookAuthoredClip(id: string, clip: AuthoredClipObject): CompiledClip {
  const c = cookTracks(clip);
  return {
    id,
    kind: 'delta',
    duration: c.duration,
    fps: c.fps,
    tracks: c.tracks.map((t) => makeTrack(t.bone, t.prop, 'linear', t.times, t.values)),
  };
}

export function isAuthoredClipObject(v: unknown): v is AuthoredClipObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && typeof (v as { tracks?: unknown }).tracks === 'object' &&
    (v as { tracks?: unknown }).tracks !== null && !Array.isArray((v as { tracks?: unknown }).tracks);
}

/** Every clip of a parsed `anim/<file>.yml`, in authored order; entries that are not clip objects are skipped. */
export function cookAuthoredFile(path: string, parsed: unknown): CompiledClip[] {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${path}: an anim file must be a mapping of clip name → clip`);
  }
  const out: CompiledClip[] = [];
  for (const [name, clip] of Object.entries(parsed)) {
    if (!isAuthoredClipObject(clip)) continue;
    try {
      out.push(cookAuthoredClip(authoredIdentity(path, name), clip));
    } catch (e) {
      throw new Error(`${path}#${name}: ${(e as Error).message}`);
    }
  }
  return out;
}

const inlineCache = new WeakMap<object, CompiledClip>();

/**
 * The CompiledClip of an authored clip object: the build-cooked one attached under SS_COMPILED (objects from
 * `builtin/anim.clips()`), else cooked once per object identity (clip objects built in game code), id `inline#<name>`.
 */
export function compiledOf(clip: AuthoredClipObject): CompiledClip {
  const tagged = (clip as { [SS_COMPILED]?: unknown })[SS_COMPILED];
  if (tagged !== undefined) return tagged as CompiledClip;
  let c = inlineCache.get(clip);
  if (!c) {
    c = cookAuthoredClip(`inline#${clip.name ?? 'clip'}`, clip);
    inlineCache.set(clip, c);
  }
  return c;
}

/** `builtin/anim.toTracks` (api:1414): the engine's cooked shape, rotation tracks as quaternions. */
export function toTracks(clip: AuthoredClipObject): { name: string; duration: number; fps?: number; tracks: CookedTrack[] } {
  const c = cookTracks(clip);
  return { name: clip.name ?? '', duration: c.duration, fps: c.fps, tracks: c.tracks };
}
