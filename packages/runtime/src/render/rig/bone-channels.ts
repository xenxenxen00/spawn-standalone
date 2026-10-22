// `bones.<bone>.{pitch, yaw, roll, y}` on a procedural rig (plan item K3; DESIGN.md §4, §5): the row prop `bones` as
// `builtin/tween` writes it (`animate(ctx, id, { "bones.armR.pitch": 90 })` stores `props.bones = { armR: { pitch: 90 } }`),
// applied on top of what the mixer's clips leave in a pose.
//
// ROTATION CONVENTION (load-bearing): R = Ry(yaw) · Rx(pitch) · Rz(roll), degrees, right-handed: a point is turned about +Z
// (roll) first, then +X (pitch), then +Y (yaw). That is the sims' own forward kinematics (a ported generator's contact
// solver, `rot()`), which must agree with the renderer to about 2 cm, and the same YXZ order as a row's own rotation. It is
// NOT the authored-clip order (`qX(pitch)·qY(yaw)·qZ(roll)`, `quat.ts qFromEulerXYZDeg`): authored clips keep theirs, cooked
// by the existing pipeline.
//
// COMPOSITION, per bone with channels: local T = clipT + (0, y, 0) (in the parent's frame, after the rotation), local
// R = clipR · q(channels), S = clipS. "clip" is what the mixer wrote (or the bind pose where no clip names the bone).
import { qFromAxisAngle, qMul, type Num } from '../../compat/motion/quat.ts';

/** The channels of one bone. Missing channels are 0. */
export interface BoneChannelValue {
  readonly pitch: number;
  readonly yaw: number;
  readonly roll: number;
  readonly y: number;
}

const DEG = Math.PI / 180;
const qa = new Float64Array(4);
const qb = new Float64Array(4);

/** q = qY(yaw) · qX(pitch) · qZ(roll), degrees (see the header). */
export function qFromBoneChannelsDeg<T extends Num>(out: T, oo: number, pitch: number, yaw: number, roll: number): T {
  qFromAxisAngle(qa, 0, 0, 1, 0, yaw * DEG);
  qFromAxisAngle(qb, 0, 1, 0, 0, pitch * DEG);
  qMul(qa, 0, qa, 0, qb, 0);
  qFromAxisAngle(qb, 0, 0, 0, 1, roll * DEG);
  return qMul(out, oo, qa, 0, qb, 0);
}

/** A rotation convention as the bone channels use it (tests swap it for a wrong one as a negative control). */
export type BoneRotationConvention = (out: Float64Array, pitch: number, yaw: number, roll: number) => void;

export const BONE_CHANNEL_ROTATION: BoneRotationConvention = (out, pitch, yaw, roll) => {
  qFromBoneChannelsDeg(out, 0, pitch, yaw, roll);
};

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Reads the `bones` row prop: the bones that carry at least one of pitch / yaw / roll / y. Other members of a bone entry
 * (`rotate`, `offset`, `reach`, `aim`, … of model rigs) are not this layer's and are ignored. Non-numbers read as 0.
 */
export function readBoneChannels(prop: unknown): Map<string, BoneChannelValue> {
  const out = new Map<string, BoneChannelValue>();
  if (!isObj(prop)) return out;
  for (const [bone, v] of Object.entries(prop)) {
    if (!isObj(v)) continue;
    if (!('pitch' in v || 'yaw' in v || 'roll' in v || 'y' in v)) continue;
    out.set(bone, { pitch: num(v['pitch']), yaw: num(v['yaw']), roll: num(v['roll']), y: num(v['y']) });
  }
  return out;
}
