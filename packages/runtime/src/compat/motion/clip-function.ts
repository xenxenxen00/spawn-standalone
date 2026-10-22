// Clip functions (docs/design/motion-physics-nav.md §3.3.3; contract §16.1): `(t) => ({Bone: {position?, rotation?: [pitch, yaw,
// roll] deg, scale?}})` with `.duration` (seconds), `.fps` (default 30) and `.units` ('hips' = positions are fractions of the
// rig's hips rest height). "A constant function of time: the mixer bakes it once" (scripts/humanoid-locomotion.js:93-115): the
// function is sampled once per frame into a CompiledClip{kind:'delta'}, cached by function identity.
//
// Values are deltas on the bind pose, like authored clips: rotation = qX(pitch)·qY(yaw)·qZ(roll) applied in the bone's own
// frame (`R = bindR·q`), position an offset (`T = bindT + offset`), scale a factor on the bind scale [INF: no live function
// returns one]. A bone or property that only some samples return takes the neutral value in the others.
//
// Sampling: keys at i/fps for every frame up to the duration, plus one at the duration when it is not a whole number of
// frames. A function without a positive `.duration` has no extent to sample, so it is the constant pose it returns at t = 0:
// one key, one frame (1/fps) long [INF: §3.3.3 only speaks of "a constant function of time"].
//
// Identity: the engine names a clip function `<tree path>#<export>` (`scripts/humanoid-locomotion.js#sit`); `registerClipFunctions`
// gives a loaded module's functions that id and registers them, so a string copy of a channel (a corpse's `mixer` spec) resolves.
// A function nobody registered is `function#<name>`. Live use: `sit` only, unreachable (no seats) [P2].
import { type ClipFunction, type CompiledClip, type Track, type TrackProp, makeTrack } from './clip.ts';
import type { ClipRegistry } from './clip-registry.ts';
import { AUTHORED_DEFAULT_FPS } from './constants.ts';
import { qFromEulerXYZDeg } from './quat.ts';

const BAKED = new WeakMap<ClipFunction, CompiledClip>();
const IDENTITY = new WeakMap<ClipFunction, string>();

const EPS = 1e-9;
const PROPS: readonly TrackProp[] = ['rotation', 'position', 'scale'];
const NEUTRAL: Readonly<Record<TrackProp, readonly number[]>> = { rotation: [0, 0, 0, 1], position: [0, 0, 0], scale: [1, 1, 1] };

const isVec3 = (v: unknown): v is readonly [number, number, number] =>
  Array.isArray(v) && v.length >= 3 && typeof v[0] === 'number' && typeof v[1] === 'number' && typeof v[2] === 'number' &&
  Number.isFinite(v[0]) && Number.isFinite(v[1]) && Number.isFinite(v[2]);

/** A function with a numeric `.duration`: what a module exports as a clip (`sit.duration = 0.1`). */
export function isClipFunction(v: unknown): v is ClipFunction {
  return typeof v === 'function' && typeof (v as { duration?: unknown }).duration === 'number';
}

/** `<tree path>#<export>`: the engine's identity of a clip function (`scripts/humanoid-locomotion.js#sit`). */
export function clipFunctionIdentity(path: string, exportName: string): string {
  return `${path}#${exportName}`;
}

/** The tree identity a module registration gave this function, if any. */
export function identityOfClipFunction(fn: ClipFunction): string | undefined {
  return IDENTITY.get(fn);
}

function sampleTimes(duration: number, fps: number): number[] {
  if (!(duration > 0)) return [0];
  const times: number[] = [];
  const frames = Math.floor(duration * fps + EPS);
  for (let i = 0; i <= frames; i++) times.push(Math.min(duration, i / fps));
  if (duration - times[times.length - 1]! > EPS) times.push(duration);
  else times[times.length - 1] = duration;
  return times;
}

function bake(fn: ClipFunction, id: string): CompiledClip {
  const fps = typeof fn.fps === 'number' && fn.fps > 0 ? fn.fps : AUTHORED_DEFAULT_FPS;
  const given = typeof fn.duration === 'number' && fn.duration > 0 ? fn.duration : 0;
  const times = sampleTimes(given, fps);
  // per `bone prop`, in first-seen order: the value of every sample (the neutral value where a sample leaves it out)
  const series = new Map<string, { bone: string; prop: TrackProp; values: number[] }>();
  const q = [0, 0, 0, 1];
  times.forEach((t, i) => {
    const sample: unknown = fn(t);
    if (typeof sample !== 'object' || sample === null) return;
    for (const [bone, tr] of Object.entries(sample as Record<string, unknown>)) {
      if (typeof tr !== 'object' || tr === null) continue;
      for (const prop of PROPS) {
        const v = (tr as Record<string, unknown>)[prop];
        if (!isVec3(v)) continue;
        const key = `${bone}\u0000${prop}`;
        let s = series.get(key);
        if (!s) {
          s = { bone, prop, values: [] };
          for (let k = 0; k < times.length; k++) s.values.push(...NEUTRAL[prop]);
          series.set(key, s);
        }
        if (prop === 'rotation') {
          qFromEulerXYZDeg(q, 0, v[0], v[1], v[2]);
          for (let k = 0; k < 4; k++) s.values[i * 4 + k] = q[k]!;
        } else {
          for (let k = 0; k < 3; k++) s.values[i * 3 + k] = v[k]!;
        }
      }
    }
  });
  const tracks: Track[] = [...series.values()].map((s) => makeTrack(s.bone, s.prop, 'linear', times, s.values));
  const clip: { -readonly [K in keyof CompiledClip]: CompiledClip[K] } = { id, kind: 'delta', duration: given > 0 ? given : 1 / fps, fps, tracks };
  if (fn.units === 'hips' || fn.units === 'm') clip.units = fn.units;
  return clip;
}

/**
 * The CompiledClip of a clip function, baked on the first call and the same object ever after (`ClipRegistry.setFunctionBaker`
 * takes this function). `id` names it on the first bake; by default its tree identity when a module registered it, else
 * `function#<name>`.
 */
export function bakeClipFunction(fn: ClipFunction, id?: string): CompiledClip {
  let c = BAKED.get(fn);
  if (!c) {
    c = bake(fn, id ?? IDENTITY.get(fn) ?? `function#${fn.name || 'clip'}`);
    BAKED.set(fn, c);
  }
  return c;
}

/**
 * Registers the clip functions a loaded module exports under `<path>#<export>` (the module registry calls this for the
 * modules it evaluates). Returns the identities it registered.
 */
export function registerClipFunctions(registry: ClipRegistry, path: string, module: Readonly<Record<string, unknown>>): string[] {
  const out: string[] = [];
  for (const [name, value] of Object.entries(module)) {
    if (!isClipFunction(value)) continue;
    const identity = clipFunctionIdentity(path, name);
    const known = BAKED.get(value);
    // already baked under another name: the same tracks under the tree identity
    const clip = known === undefined ? bake(value, identity) : known.id === identity ? known : { ...known, id: identity };
    BAKED.set(value, clip);
    IDENTITY.set(value, identity);
    registry.addFunctionClip(identity, clip);
    out.push(identity);
  }
  return out;
}
