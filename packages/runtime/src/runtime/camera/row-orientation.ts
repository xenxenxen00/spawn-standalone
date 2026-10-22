// Rig orientation from the rig row's own rotation (port-spec R-1; engine api:482, skills/cameras.md:36).
//
// A rig may write `ctx.self.rotation = { lookAt: pivot, include: ["yaw","pitch"] }` instead of `state.yaw / state.pitch`. The
// kernel resolves that write into the row's quaternion (YXZ, world feet as the origin of the lookAt). This module reads it back
// as the presenter's yaw / pitch in radians (yaw 0 faces -Z, +yaw turns left, +pitch looks up), the same convention as the
// look the rig host presents. Opt-in through `RigHostDeps.orientationFromRow`; the default host never calls it.
import { DEG_TO_RAD, quatToEulerYXZ } from '../../compat/core/store/transform.ts';
import type { RowRec } from '../../compat/core/types.ts';

export interface RowLook {
  yaw: number;
  pitch: number;
}

/** the yaw / pitch (radians) of the row's local rotation; a top-level rig row's local rotation is its world rotation */
export function rowLook(row: Pick<RowRec, 'tf'>): RowLook {
  const e = quatToEulerYXZ(row.tf.rot);
  return { yaw: e.yaw * DEG_TO_RAD, pitch: e.pitch * DEG_TO_RAD };
}
