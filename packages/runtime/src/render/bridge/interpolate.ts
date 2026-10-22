// Row interpolation (docs/design/rendering.md §16.2; `spawn-engine-contract.md` §9.1; WP R13): what the render bridge draws
// of a row between two 30 Hz ticks. Plain numbers, no three.js.
//
// A row's transform is written once per tick; the store keeps the previous and the current tick value (`RowSnapshot.prev` /
// `.cur`, both LOCAL: a child is interpolated in its parent's frame and the bridge composes the parents, which is what makes
// a child follow its parent's interpolated pose). A frame presents
//
//   position   lerp(prev, cur, alpha)
//   rotation   slerp(prev, cur, alpha) by the short way, normalised
//   scale      cur (the store keeps no previous scale)
//
// and presents `cur` as it is when the row does not interpolate: a step longer than the row's `interpolation.teleportThreshold`
// (default 2 m: "past ~2 m/tick a body warps instead of interpolating"), `interpolation: null`, or a row at rest. `alpha` is
// clamped to [0, 1]; 0 gives `prev` and 1 gives `cur`, both exactly. Camera-attached rows are not presented here: their
// 0.25 m / 30° rule and their fov are `models/viewmodel-renderer.ts`'s (`ViewmodelTrack`, X-36).
import type { Quat, Vec3 } from '../../compat/core/types.ts';

/** render §16.2: the default `interpolation.teleportThreshold`, metres per tick */
export const TELEPORT_THRESHOLD_M = 2;

/** `alpha` in [0, 1]; a value that is not a number presents the newest tick */
export function clampAlpha(alpha: number): number {
  return alpha > 0 ? (alpha < 1 ? alpha : 1) : alpha === alpha ? 0 : 1;
}

/**
 * The teleport threshold of a row from its `interpolation` property: `null` = the row does not interpolate (it presents
 * `cur`), `{teleportThreshold: n}` = n metres, anything else = `fallback`.
 */
export function teleportThresholdOf(interpolation: unknown, fallback: number = TELEPORT_THRESHOLD_M): number | null {
  if (interpolation === null) return null;
  if (typeof interpolation === 'object') {
    const t = (interpolation as { teleportThreshold?: unknown }).teleportThreshold;
    if (typeof t === 'number' && t >= 0) return t;
  }
  return fallback;
}

/** Whether the step from `prev` to `cur` is a teleport: longer than `threshold` metres (a step of exactly the threshold is not). */
export function stepTeleports(prev: Readonly<Vec3>, cur: Readonly<Vec3>, threshold: number): boolean {
  const dx = cur.x - prev.x;
  const dy = cur.y - prev.y;
  const dz = cur.z - prev.z;
  return dx * dx + dy * dy + dz * dz > threshold * threshold;
}

/** `out = a + (b − a) · t` */
export function lerpVec3(a: Readonly<Vec3>, b: Readonly<Vec3>, t: number, out: Vec3): Vec3 {
  out.x = a.x + (b.x - a.x) * t;
  out.y = a.y + (b.y - a.y) * t;
  out.z = a.z + (b.z - a.z) * t;
  return out;
}

/** `slerp(a, b, t)` by the short way, unit length. `a` and `b` are unit quaternions (the store normalises what it keeps). */
export function slerpQuat(a: Readonly<Quat>, b: Readonly<Quat>, t: number, out: Quat): Quat {
  let bx = b.x;
  let by = b.y;
  let bz = b.z;
  let bw = b.w;
  let dot = a.x * bx + a.y * by + a.z * bz + a.w * bw;
  // q and −q are one orientation: take the one on a's side, or the turn goes the long way round
  if (dot < 0) {
    dot = -dot;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  let wa: number;
  let wb: number;
  if (dot > 0.9995) {
    // nearly the same orientation: sin(θ) is too small to divide by, and the chord is the arc
    wa = 1 - t;
    wb = t;
  } else {
    const theta = Math.acos(dot);
    const s = Math.sin(theta);
    wa = Math.sin((1 - t) * theta) / s;
    wb = Math.sin(t * theta) / s;
  }
  const x = a.x * wa + bx * wb;
  const y = a.y * wa + by * wb;
  const z = a.z * wa + bz * wb;
  const w = a.w * wa + bw * wb;
  const len = Math.hypot(x, y, z, w) || 1;
  out.x = x / len;
  out.y = y / len;
  out.z = z / len;
  out.w = w / len;
  return out;
}

/** which value `presentRowPose` wrote */
export type Presented = 'cur' | 'prev' | 'mix';

/**
 * The local pose to draw between two ticks. `threshold` is the row's teleport threshold in metres, null when the row does
 * not interpolate. Writes `outPos` / `outRot` and allocates nothing.
 */
export function presentRowPose(
  prevPos: Readonly<Vec3>,
  prevRot: Readonly<Quat>,
  curPos: Readonly<Vec3>,
  curRot: Readonly<Quat>,
  alpha: number,
  threshold: number | null,
  outPos: Vec3,
  outRot: Quat,
): Presented {
  const a = clampAlpha(alpha);
  if (a >= 1 || threshold === null || (prevPos === curPos && prevRot === curRot) || stepTeleports(prevPos, curPos, threshold)) {
    copy(curPos, curRot, outPos, outRot);
    return 'cur';
  }
  if (a <= 0) {
    copy(prevPos, prevRot, outPos, outRot);
    return 'prev';
  }
  lerpVec3(prevPos, curPos, a, outPos);
  slerpQuat(prevRot, curRot, a, outRot);
  return 'mix';
}

function copy(pos: Readonly<Vec3>, rot: Readonly<Quat>, outPos: Vec3, outRot: Quat): void {
  outPos.x = pos.x;
  outPos.y = pos.y;
  outPos.z = pos.z;
  outRot.x = rot.x;
  outRot.y = rot.y;
  outRot.z = rot.z;
  outRot.w = rot.w;
}
