// Spatial model (io §2.6): Web Audio `PannerNode`s with the linear distance model, the payload's ref/max distances, the tier's
// panning model, and the listener at the presented camera eye.
//
// Why linear rather than three.js' inverse default (io §2.6, three static arguments): far sirens at 30 m with max 400 must be
// audible, corpse-fly loops with max 7 must be silent beyond it, and the carried gunshot close/mid/far crossfade only stays
// within ±3.5 dB under linear (tests/unit/audio/tier-curve.node.test.ts recomputes the curve for every weight).
import { DEFAULT_MAX_DISTANCE, DEFAULT_REF_DISTANCE, MIN_DISTANCE_SPAN, PANNING_MODEL } from './limits.ts';
import type { AudioCtxLike, AudioListenerLike, AudioParamLike, AudioTier, ListenerPose, PannerNodeLike, Vec3 } from './types.ts';

const positive = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x) && x >= 0;

export interface DistanceOptions { refDistance?: number | undefined; maxDistance?: number | undefined }

/** Valid payload values win over host defaults, then calibration; max stays above ref. */
export function distanceParams(p: DistanceOptions, defaults: DistanceOptions = {}): { ref: number; max: number } {
  const ref = positive(p.refDistance) ? p.refDistance : positive(defaults.refDistance) ? defaults.refDistance : DEFAULT_REF_DISTANCE;
  const max = positive(p.maxDistance) ? p.maxDistance : positive(defaults.maxDistance) ? defaults.maxDistance : DEFAULT_MAX_DISTANCE;
  return { ref, max: Math.max(max, ref + MIN_DISTANCE_SPAN) };
}

/**
 * The gain a linear-model panner applies at distance `d` (rolloff 1, Web Audio spec):
 * `g(d) = 1 - (clamp(d, ref, max) - ref) / (max - ref)`; 1 inside `ref`, 0 at and beyond `max`. `max` gets the same
 * `ref + 0.01` floor as the panner set-up.
 */
export function linearGain(d: number, ref: number, max: number): number {
  const m = Math.max(max, ref + MIN_DISTANCE_SPAN);
  const c = Math.min(Math.max(d, ref), m);
  return 1 - (c - ref) / (m - ref);
}

export function panningModelFor(tier: AudioTier): 'HRTF' | 'equalpower' {
  return PANNING_MODEL[tier];
}

/** a linear, omnidirectional panner for one voice (position set by the caller) */
export function makePanner(ctx: AudioCtxLike, ref: number, max: number, tier: AudioTier): PannerNodeLike {
  const p = ctx.createPanner();
  p.panningModel = panningModelFor(tier);
  p.distanceModel = 'linear';
  p.rolloffFactor = 1;
  p.refDistance = ref;
  p.maxDistance = Math.max(max, ref + MIN_DISTANCE_SPAN);
  p.coneInnerAngle = 360;
  p.coneOuterAngle = 360;
  return p;
}

const set = (param: AudioParamLike, v: number, t: number): void => {
  param.setValueAtTime(v, t);
};

export function setPannerPosition(p: PannerNodeLike, pos: Vec3, t: number): void {
  set(p.positionX, pos.x, t);
  set(p.positionY, pos.y, t);
  set(p.positionZ, pos.z, t);
}

/** listener = the presented camera eye, forward and up (io §2.6), applied at audio time `t` */
export function applyListener(l: AudioListenerLike, pose: ListenerPose, t: number): void {
  set(l.positionX, pose.eye.x, t);
  set(l.positionY, pose.eye.y, t);
  set(l.positionZ, pose.eye.z, t);
  set(l.forwardX, pose.forward.x, t);
  set(l.forwardY, pose.forward.y, t);
  set(l.forwardZ, pose.forward.z, t);
  set(l.upX, pose.up.x, t);
  set(l.upY, pose.up.y, t);
  set(l.upZ, pose.up.z, t);
}

/** a finite {x, y, z}: what the engine accepts as a payload `position` */
export function isVec3(v: unknown): v is Vec3 {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return [o['x'], o['y'], o['z']].every((c) => typeof c === 'number' && Number.isFinite(c));
}
