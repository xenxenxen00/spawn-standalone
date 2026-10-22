// Transforms (docs/design/core-runtime.md §5.4, D-CORE-03; contract §1.1-1.3, §9.13): YXZ Euler ↔ quaternion, poses and parent
// chains, the PositionSpec / RotationSpec / scale forms rows are written with, and the transform writes behind the handle's
// setters (feetPosition, rotation, yaw, scale, velocity, angularVelocity, parent). No engine: plain numbers.
//
// Conventions (contract §1.1): metres, +Y up, −Z forward; yaw about +Y (positive turns left: yaw 90 faces −X), pitch about +X
// (positive tips the nose up), roll about +Z; Euler order YXZ (three.js 'YXZ' = Ry·Rx·Rz); degrees
// on rows. A TransformRec never mutates its Vec3 / Quat values: every write stores new objects, so `prevPos = pos` can share one
// and a holder of a reference sees a stable value.
//
// Port decisions [INF]:
// - A rotation read returns the Euler angles as last written (yaw 270 reads 270, three.js keeps its Euler beside the
//   quaternion); a quaternion write, a lookAt or a physics writeback reads back from the quaternion (YXZ, cleaned to 1e-9°).
// - A feetPosition write does not reset interpolation: prev/cur roll once per tick (RowStoreImpl.beginTick) and the render bridge
//   snaps past `interpolation.teleportThreshold` (contract §9.1, render §16.2), so a row a script moves every tick stays smooth.
// - A camera-attached row (`feetPosition: {attach: 'camera', x, y, depth, fov}`, contract §9.13, X-36) keeps the spec as written
//   in `props.feetPosition` for the viewmodel layer and the camera-space point (x, y, −depth) in `tf.pos`, so the tick-to-tick
//   prev/cur pair interpolates in camera space; it has no body and is in no spatial grid.
import type { AttachmentResolver, CameraPort } from '../ports.ts';
import type { Quat, RowId, RowRec, Rotation, TransformRec, Vec3 } from '../types.ts';
import { cloneWire, deepEqualWire } from '../wire.ts';
import { commitWrite, equalWrite, invalidWrite, type StoreCore, type WriteRealm } from './proxies.ts';

export const DEG_TO_RAD = Math.PI / 180;
export const RAD_TO_DEG = 180 / Math.PI;
/** parent chains deeper than this are cut (a cycle can only come from a corrupted record) */
const MAX_DEPTH = 64;

export interface Pose {
  readonly pos: Vec3;
  readonly rot: Quat;
  readonly scale: Vec3;
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export const copyVec3 = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });
export const copyQuat = (q: Quat): Quat => ({ x: q.x, y: q.y, z: q.z, w: q.w });
const sameVec3 = (a: Vec3, b: Vec3): boolean => a.x === b.x && a.y === b.y && a.z === b.z;
const sameQuat = (a: Quat, b: Quat): boolean => a.x === b.x && a.y === b.y && a.z === b.z && a.w === b.w;
const mulVec3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x * b.x, y: a.y * b.y, z: a.z * b.z });
const divOr0 = (a: number, b: number): number => (b === 0 ? 0 : a / b);

/** degrees from radians, cleaned to 1e-9° with no −0, so whole-degree writes read back whole */
function cleanDeg(rad: number): number {
  return Math.round(rad * RAD_TO_DEG * 1e9) / 1e9 + 0;
}

// ── quaternions ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** YXZ Euler degrees → unit quaternion (three.js Quaternion.setFromEuler, order 'YXZ') */
export function eulerYXZToQuat(yawDeg: number, pitchDeg: number, rollDeg: number): Quat {
  const hp = (pitchDeg * DEG_TO_RAD) / 2;
  const hy = (yawDeg * DEG_TO_RAD) / 2;
  const hr = (rollDeg * DEG_TO_RAD) / 2;
  const c1 = Math.cos(hp);
  const s1 = Math.sin(hp);
  const c2 = Math.cos(hy);
  const s2 = Math.sin(hy);
  const c3 = Math.cos(hr);
  const s3 = Math.sin(hr);
  return {
    x: s1 * c2 * c3 + c1 * s2 * s3,
    y: c1 * s2 * c3 - s1 * c2 * s3,
    z: c1 * c2 * s3 - s1 * s2 * c3,
    w: c1 * c2 * c3 + s1 * s2 * s3,
  };
}

/** a quaternion → YXZ Euler degrees (three.js Euler.setFromRotationMatrix, order 'YXZ'); pitch in [−90, 90] */
export function quatToEulerYXZ(q: Quat): Rotation {
  const { x, y, z, w } = quatNormalize(q);
  const m11 = 1 - 2 * (y * y + z * z);
  const m13 = 2 * (x * z + w * y);
  const m21 = 2 * (x * y + w * z);
  const m22 = 1 - 2 * (x * x + z * z);
  const m23 = 2 * (y * z - w * x);
  const m31 = 2 * (x * z - w * y);
  const m33 = 1 - 2 * (x * x + y * y);
  // the third column is (cos p·sin y, −sin p, cos p·cos y): atan2 stays exact near ±90° where three.js's asin(−m23) loses ~1e-6°
  const pitch = Math.atan2(-m23, Math.hypot(m13, m33));
  let yaw: number;
  let roll: number;
  if (Math.abs(m23) < 0.9999999) {
    yaw = Math.atan2(m13, m33);
    roll = Math.atan2(m21, m22);
  } else {
    yaw = Math.atan2(-m31, m11);
    roll = 0;
  }
  return { yaw: cleanDeg(yaw), pitch: cleanDeg(pitch), roll: cleanDeg(roll) };
}

export function quatNormalize(q: Quat): Quat {
  const n = Math.hypot(q.x, q.y, q.z, q.w);
  if (!(n > 0) || !Number.isFinite(n)) return { x: 0, y: 0, z: 0, w: 1 };
  return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
}

/** a·b: the rotation b, then a */
export function quatMul(a: Quat, b: Quat): Quat {
  return {
    x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
    y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
    z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
    w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  };
}

/** the inverse of a unit quaternion */
export function quatConj(q: Quat): Quat {
  return { x: -q.x, y: -q.y, z: -q.z, w: q.w };
}

/** q·v·q* (three.js Vector3.applyQuaternion) */
export function rotateVec3(q: Quat, v: Vec3): Vec3 {
  const ix = q.w * v.x + q.y * v.z - q.z * v.y;
  const iy = q.w * v.y + q.z * v.x - q.x * v.z;
  const iz = q.w * v.z + q.x * v.y - q.y * v.x;
  const iw = -q.x * v.x - q.y * v.y - q.z * v.z;
  return {
    x: ix * q.w + iw * -q.x + iy * -q.z - iz * -q.y,
    y: iy * q.w + iw * -q.y + iz * -q.x - ix * -q.z,
    z: iz * q.w + iw * -q.z + ix * -q.y - iy * -q.x,
  };
}

/** the −Z forward axis turned by q */
export function forwardOf(q: Quat): Vec3 {
  return rotateVec3(q, { x: 0, y: 0, z: -1 });
}

/** the rotation whose local axes are the given world axes (columns right, up, back; three.js setFromRotationMatrix) */
function quatFromBasis(r: Vec3, u: Vec3, b: Vec3): Quat {
  const m11 = r.x, m12 = u.x, m13 = b.x;
  const m21 = r.y, m22 = u.y, m23 = b.y;
  const m31 = r.z, m32 = u.z, m33 = b.z;
  const trace = m11 + m22 + m33;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    return { w: 0.25 / s, x: (m32 - m23) * s, y: (m13 - m31) * s, z: (m21 - m12) * s };
  }
  if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    return { w: (m32 - m23) / s, x: 0.25 * s, y: (m12 + m21) / s, z: (m13 + m31) / s };
  }
  if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    return { w: (m13 - m31) / s, x: (m12 + m21) / s, y: 0.25 * s, z: (m23 + m32) / s };
  }
  const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
  return { w: (m21 - m12) / s, x: (m13 + m31) / s, y: (m23 + m32) / s, z: 0.25 * s };
}

// ── poses ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** parent ∘ local: the local position is scaled and turned by the parent, rotations compose, scales multiply per axis (exact for
 *  uniform scales; a non-uniform parent scale under a rotated child would shear, which no live hierarchy does) */
export function composePose(parent: Pose, local: Pose): Pose {
  const off = rotateVec3(parent.rot, mulVec3(parent.scale, local.pos));
  return {
    pos: { x: parent.pos.x + off.x, y: parent.pos.y + off.y, z: parent.pos.z + off.z },
    rot: quatMul(parent.rot, local.rot),
    scale: mulVec3(parent.scale, local.scale),
  };
}

/** the local pose that puts a row at `world` under `parent` (re-parenting keeps the world pose, core §4.6) */
export function localPoseIn(parent: Pose, world: Pose): Pose {
  const inv = quatConj(quatNormalize(parent.rot));
  const d = rotateVec3(inv, { x: world.pos.x - parent.pos.x, y: world.pos.y - parent.pos.y, z: world.pos.z - parent.pos.z });
  return {
    pos: { x: divOr0(d.x, parent.scale.x), y: divOr0(d.y, parent.scale.y), z: divOr0(d.z, parent.scale.z) },
    rot: quatNormalize(quatMul(inv, world.rot)),
    scale: { x: divOr0(world.scale.x, parent.scale.x), y: divOr0(world.scale.y, parent.scale.y), z: divOr0(world.scale.z, parent.scale.z) },
  };
}

/** the row's own transform as a pose (shares the TransformRec values: copy before handing them out) */
export function localPose(row: RowRec): Pose {
  return { pos: row.tf.pos, rot: row.tf.rot, scale: row.tf.scale };
}

/** what worldPose reads besides the row: the store's rows and, optionally, the attachment resolver and the camera port */
export interface PoseEnv {
  get(id: RowId): RowRec | undefined;
  readonly ports?: { readonly attach?: AttachmentResolver; readonly camera?: CameraPort } | undefined;
}

/**
 * A row's world pose (core §5.4): a top-level row's own transform; a child's is its parent's world pose ∘ its local transform;
 * a row with an `attachment` prop asks the attachment resolver (motion §3.8) and falls back to the chain on null; a
 * camera-attached row sits in the presented camera's frame. The result may share TransformRec values: copy before exposing.
 */
export function worldPose(env: PoseEnv, row: RowRec, depth = 0): Pose {
  if (isCameraAttached(row)) return cameraPose(env, row);
  const parent = row.parentId !== null && depth < MAX_DEPTH ? env.get(row.parentId) : undefined;
  if (!parent) return localPose(row);
  const att = row.props.attachment;
  if (att !== undefined && att !== null) {
    const r = env.ports?.attach?.worldPose(row);
    if (r) return { pos: copyVec3(r.pos), rot: copyQuat(r.rot), scale: mulVec3(worldPose(env, parent, depth + 1).scale, row.tf.scale) };
  }
  return composePose(worldPose(env, parent, depth + 1), localPose(row));
}

/** the plain TRS chain (no attachment resolver, no camera): the spatial grid buckets attached rows by their parent's frame */
export function chainPose(get: (id: RowId) => RowRec | undefined, row: RowRec): Pose {
  let pose = localPose(row);
  let cur = row;
  for (let d = 0; d < MAX_DEPTH && cur.parentId !== null; d++) {
    const p = get(cur.parentId);
    if (!p) break;
    pose = composePose(localPose(p), pose);
    cur = p;
  }
  return pose;
}

/** a camera-attached row in world space: eye + right·x + up·y + forward·depth, turned with the camera; its own local values
 *  until the camera presents a first frame */
function cameraPose(env: PoseEnv, row: RowRec): Pose {
  const cam = env.ports?.camera?.presentedCamera() ?? null;
  if (!cam) return localPose(row);
  let f = cam.aim;
  const fl = Math.hypot(f.x, f.y, f.z);
  f = fl > 1e-12 ? { x: f.x / fl, y: f.y / fl, z: f.z / fl } : { x: 0, y: 0, z: -1 };
  // right = f × up(0,1,0)
  let r = { x: -f.z, y: 0, z: f.x };
  const rl = Math.hypot(r.x, r.z);
  r = rl > 1e-12 ? { x: r.x / rl, y: 0, z: r.z / rl } : { x: 1, y: 0, z: 0 };
  // up = right × f
  const u = { x: r.y * f.z - r.z * f.y, y: r.z * f.x - r.x * f.z, z: r.x * f.y - r.y * f.x };
  const o = row.tf.pos;
  const pos = {
    x: cam.eye.x + r.x * o.x + u.x * o.y - f.x * o.z,
    y: cam.eye.y + r.y * o.x + u.y * o.y - f.y * o.z,
    z: cam.eye.z + r.z * o.x + u.z * o.y - f.z * o.z,
  };
  const basis = quatFromBasis(r, u, { x: -f.x, y: -f.y, z: -f.z });
  return { pos, rot: quatMul(basis, row.tf.rot), scale: row.tf.scale };
}

// ── spec forms (contract §1.2-1.3) ───────────────────────────────────────────────────────────────────────────────────

export interface CameraPositionSpec {
  attach: 'camera';
  x?: number;
  y?: number;
  depth?: number;
  fov?: number;
}

export function isCameraPositionSpec(p: unknown): p is CameraPositionSpec {
  return isObj(p) && p.attach === 'camera';
}

/** the row was last placed with a camera-attached feetPosition (contract §9.13) */
export function isCameraAttached(row: RowRec): boolean {
  const f = row.props.feetPosition;
  return isObj(f) && f.attach === 'camera';
}

/**
 * A world (or parent-local) position from a PositionSpec: `{x,y,z}` as given; `{x,z}`, `{x,z,y:'surface'}` stand on the ground
 * `ground(x, z)` reports (fallback 0, core §4.2); `{x,z,y:{terrain:n}}` stands n above it. Null for anything else, including the
 * camera form (handled by the feetPosition write) and non-finite numbers.
 */
export function resolvePositionSpec(spec: unknown, ground?: (x: number, z: number) => number | null): Vec3 | null {
  if (!isObj(spec) || 'attach' in spec) return null;
  const { x, y, z } = spec;
  if (!isNum(x) || !isNum(z)) return null;
  if (isNum(y)) return { x, y, z };
  const g = (): number => {
    const v = ground?.(x, z);
    return isNum(v) ? v : 0;
  };
  if (y === undefined || y === 'surface') return { x, y: g(), z };
  if (isObj(y) && isNum(y.terrain)) return { x, y: g() + y.terrain, z };
  return null;
}

export interface RotationEnv {
  /** the row's world feet: the origin of a lookAt */
  from?: () => Vec3;
  /** the parent's world rotation (null for a top-level row): a lookAt is turned into the parent's frame */
  parentRot?: () => Quat | null;
  ground?: (x: number, z: number) => number | null;
}

/**
 * A local rotation from a RotationSpec: a number is yaw; `{yaw?, pitch?, roll?}` defaults a missing axis to 0; `{x,y,z,w}` is a
 * quaternion (normalised); `{lookAt, include?}` faces the target from the row's world feet, yaw only unless `include` names more
 * (contract §1.3). `euler` is the Euler triple to read back (null: read it from the quaternion). Null when the spec is invalid.
 */
export function resolveRotationSpec(spec: unknown, env: RotationEnv = {}): { rot: Quat; euler: Rotation | null } | null {
  if (typeof spec === 'number') return isNum(spec) ? fromEuler({ yaw: spec, pitch: 0, roll: 0 }) : null;
  if (!isObj(spec)) return null;
  if ('lookAt' in spec) return lookAtRotation(spec, env);
  if ('w' in spec) {
    const { x, y, z, w } = spec;
    if (!isNum(x) || !isNum(y) || !isNum(z) || !isNum(w)) return null;
    if (!(Math.hypot(x, y, z, w) > 0)) return null;
    return { rot: quatNormalize({ x, y, z, w }), euler: null };
  }
  const axis = (k: 'yaw' | 'pitch' | 'roll'): number | null => {
    const v = spec[k];
    return v === undefined ? 0 : isNum(v) ? v : null;
  };
  const yaw = axis('yaw');
  const pitch = axis('pitch');
  const roll = axis('roll');
  if (yaw === null || pitch === null || roll === null) return null;
  // `{x, y, z}` without w and without an Euler key is not a rotation
  if (!('yaw' in spec || 'pitch' in spec || 'roll' in spec) && ('x' in spec || 'y' in spec || 'z' in spec)) return null;
  return fromEuler({ yaw, pitch, roll });
}

function fromEuler(e: Rotation): { rot: Quat; euler: Rotation } {
  return { rot: eulerYXZToQuat(e.yaw, e.pitch, e.roll), euler: { yaw: e.yaw + 0, pitch: e.pitch + 0, roll: e.roll + 0 } };
}

function lookAtRotation(spec: Record<string, unknown>, env: RotationEnv): { rot: Quat; euler: Rotation | null } | null {
  const target = resolvePositionSpec(spec.lookAt, env.ground);
  if (!target) return null;
  const include = Array.isArray(spec.include) ? spec.include : ['yaw'];
  const from = env.from?.() ?? { x: 0, y: 0, z: 0 };
  const dx = target.x - from.x;
  const dy = target.y - from.y;
  const dz = target.z - from.z;
  const yaw = include.includes('yaw') && (dx !== 0 || dz !== 0) ? cleanDeg(Math.atan2(-dx, -dz)) : 0;
  const pitch = include.includes('pitch') ? cleanDeg(Math.atan2(dy, Math.hypot(dx, dz))) : 0;
  const world = fromEuler({ yaw, pitch, roll: 0 });
  const parent = env.parentRot?.() ?? null;
  if (!parent) return world;
  return { rot: quatNormalize(quatMul(quatConj(quatNormalize(parent)), world.rot)), euler: null };
}

/** a number is a uniform scale; a Vec3 scales per axis (a missing axis is 1) */
export function resolveScaleSpec(spec: unknown): Vec3 | null {
  if (typeof spec === 'number') return isNum(spec) ? { x: spec, y: spec, z: spec } : null;
  if (!isObj(spec)) return null;
  const c = (v: unknown): number => (v === undefined ? 1 : isNum(v) ? v : Number.NaN);
  const s = { x: c(spec.x), y: c(spec.y), z: c(spec.z) };
  return Number.isNaN(s.x) || Number.isNaN(s.y) || Number.isNaN(s.z) ? null : s;
}

/** a velocity-like Vec3 write: a missing axis is 0, a non-finite one makes the write invalid */
function resolveVector(spec: unknown): Vec3 | null {
  if (!isObj(spec)) return null;
  const c = (v: unknown): number => (v === undefined ? 0 : isNum(v) ? v : Number.NaN);
  const v = { x: c(spec.x), y: c(spec.y), z: c(spec.z) };
  return Number.isNaN(v.x) || Number.isNaN(v.y) || Number.isNaN(v.z) ? null : v;
}

/** the read form of a scale: a number when uniform, else a Vec3 (core §3.3) */
export function scaleValue(s: Vec3): number | Vec3 {
  return s.x === s.y && s.y === s.z ? s.x : copyVec3(s);
}

// ── TransformRec ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface TransformInit {
  pos?: Vec3;
  rot?: Quat;
  /** the Euler triple `rot` was written as (read back exactly while the quaternion is unchanged) */
  euler?: Rotation | null;
  scale?: Vec3;
  vel?: Vec3;
  angVel?: Vec3;
  grounded?: boolean;
}

/** the Euler a quaternion was written as, per TransformRec (valid while `rot` is that same object) */
const EULER = new WeakMap<TransformRec, { readonly rot: Quat; readonly euler: Rotation }>();

export function createTransformRec(init: TransformInit = {}): TransformRec {
  const pos = init.pos ? copyVec3(init.pos) : { x: 0, y: 0, z: 0 };
  const rot = init.rot ? quatNormalize(init.rot) : { x: 0, y: 0, z: 0, w: 1 };
  const tf: TransformRec = {
    pos,
    rot,
    scale: init.scale ? copyVec3(init.scale) : { x: 1, y: 1, z: 1 },
    vel: init.vel ? copyVec3(init.vel) : { x: 0, y: 0, z: 0 },
    angVel: init.angVel ? copyVec3(init.angVel) : { x: 0, y: 0, z: 0 },
    grounded: init.grounded ?? false,
    prevPos: pos,
    prevRot: rot,
    // unused: world poses are computed on demand (a chain is a few multiplies); kept for the TransformRec shape of core §5.4
    worldCacheTick: -1,
  };
  if (init.euler) EULER.set(tf, { rot, euler: { ...init.euler } });
  return tf;
}

/** `{yaw, pitch, roll}` degrees: as written while the quaternion is unchanged, else read from it (a fresh object) */
export function rotationOf(tf: TransformRec): Rotation {
  const c = EULER.get(tf);
  if (c && c.rot === tf.rot) return { ...c.euler };
  const euler = quatToEulerYXZ(tf.rot);
  EULER.set(tf, { rot: tf.rot, euler });
  return { ...euler };
}

/** stores a new rotation and the Euler it was written as (null: read it from the quaternion) */
export function setRotation(tf: TransformRec, rot: Quat, euler: Rotation | null): void {
  tf.rot = rot;
  if (euler) EULER.set(tf, { rot, euler: { ...euler } });
  else EULER.delete(tf);
}

// ── transform writes (the handle setters, core §3.3) ─────────────────────────────────────────────────────────────────
// Each validates, skips an equal write (everyWrite channels still hear it), stores new values, keeps the spatial grid and the
// tick's moved set current, calls the physics port, and records the write (change list, version, channels). The caller has
// already refused writes from a read-only realm and to a dead row.

const groundAt = (store: StoreCore, row: RowRec, x: number, z: number): number | null =>
  row.place !== null ? store.ports.physics.groundY(row.place, x, z) : null;

/** the value a feetPosition channel sees: the camera spec as written, else the local position */
function feetValue(row: RowRec): unknown {
  return isCameraAttached(row) ? cloneWire(row.props.feetPosition) : copyVec3(row.tf.pos);
}

function cameraSpec(spec: CameraPositionSpec): CameraPositionSpec | null {
  const out: CameraPositionSpec = { attach: 'camera' };
  for (const k of ['x', 'y', 'depth', 'fov'] as const) {
    const v: unknown = spec[k];
    if (v === undefined) continue;
    if (!isNum(v)) return null;
    out[k] = v;
  }
  return out;
}

export function writeFeetPosition(store: StoreCore, row: RowRec, spec: unknown, realm: WriteRealm): boolean {
  const wasCamera = isCameraAttached(row);
  if (isCameraPositionSpec(spec)) {
    const cam = cameraSpec(spec);
    if (!cam) return invalidWrite(store, row, 'feetPosition');
    const pos = { x: cam.x ?? 0, y: cam.y ?? 0, z: -(cam.depth ?? 0) + 0 };
    if (wasCamera && sameVec3(row.tf.pos, pos) && deepEqualWire(row.props.feetPosition, cam)) {
      return equalWrite(store, row, 'feetPosition', [], cloneWire(cam), feetValue(row));
    }
    store.channels.willWrite(row, 'feetPosition');
    const prev = feetValue(row);
    row.props.feetPosition = cam;
    row.tf.pos = pos;
    store.moved(row);
    // camera space and world space do not interpolate into each other
    if (!wasCamera) store.restartInterpolation(row);
    commitWrite(store, row, 'feetPosition', [], cloneWire(cam), prev, realm);
    return true;
  }
  const p = resolvePositionSpec(spec, (x, z) => groundAt(store, row, x, z));
  if (!p) return invalidWrite(store, row, 'feetPosition');
  if (!wasCamera && sameVec3(row.tf.pos, p)) return equalWrite(store, row, 'feetPosition', [], copyVec3(p), copyVec3(p));
  store.channels.willWrite(row, 'feetPosition');
  const prev = feetValue(row);
  if (wasCamera) delete row.props.feetPosition;
  row.tf.pos = p;
  store.moved(row);
  if (wasCamera) store.restartInterpolation(row);
  store.ports.physics.setPosition(row, p);
  commitWrite(store, row, 'feetPosition', [], copyVec3(p), prev, realm);
  return true;
}

/** the spawn-time transform of a spec (core §4.2), for lifecycle.ts */
export interface SpecTransform {
  /** only the fields the spec gave (valid ones) */
  init: TransformInit;
  /** the camera form as written (`props.feetPosition` of a camera-attached row), else null */
  camera: CameraPositionSpec | null;
  /** spec fields whose value is no valid form (left at their defaults) */
  invalid: string[];
}

/**
 * `feetPosition` (a missing y stands on `ground`, the camera form keeps the spec), `rotation` and `yaw` (a rotation object wins for
 * the axes it names, `yaw` fills a yaw it leaves out; a lookAt faces the target from the row's world feet once, in the parent's
 * frame), `scale`. `parentPose` is the parent's world pose for a child.
 */
export function transformFromSpec(
  spec: { readonly feetPosition?: unknown; readonly rotation?: unknown; readonly yaw?: unknown; readonly scale?: unknown },
  env: { ground?: (x: number, z: number) => number | null; parentPose?: Pose | null } = {},
): SpecTransform {
  const init: TransformInit = {};
  const invalid: string[] = [];
  let camera: CameraPositionSpec | null = null;
  if (spec.feetPosition !== undefined) {
    if (isCameraPositionSpec(spec.feetPosition)) {
      camera = cameraSpec(spec.feetPosition);
      if (camera) init.pos = { x: camera.x ?? 0, y: camera.y ?? 0, z: -(camera.depth ?? 0) + 0 };
      else invalid.push('feetPosition');
    } else {
      const p = resolvePositionSpec(spec.feetPosition, env.ground);
      if (p) init.pos = p;
      else invalid.push('feetPosition');
    }
  }
  let rotation = spec.rotation;
  if (spec.yaw !== undefined && !isNum(spec.yaw)) invalid.push('yaw');
  else if (spec.yaw !== undefined) {
    if (rotation === undefined) rotation = spec.yaw;
    else if (isObj(rotation) && !('lookAt' in rotation) && !('w' in rotation) && !('yaw' in rotation)) rotation = { ...rotation, yaw: spec.yaw };
  }
  if (rotation !== undefined) {
    const local = init.pos ?? { x: 0, y: 0, z: 0 };
    const parent = camera === null ? (env.parentPose ?? null) : null;
    const r = resolveRotationSpec(rotation, {
      from: () => (parent ? composePose(parent, { pos: local, rot: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } }).pos : local),
      parentRot: () => (parent ? parent.rot : null),
      ...(env.ground ? { ground: env.ground } : {}),
    });
    if (r) {
      init.rot = r.rot;
      init.euler = r.euler;
    } else invalid.push('rotation');
  }
  if (spec.scale !== undefined) {
    const s = resolveScaleSpec(spec.scale);
    if (s) init.scale = s;
    else invalid.push('scale');
  }
  return { init, camera, invalid };
}

function applyRotation(store: StoreCore, row: RowRec, rot: Quat, euler: Rotation | null, realm: WriteRealm): boolean {
  const cur = rotationOf(row.tf);
  if (sameQuat(rot, row.tf.rot) && (euler === null || (euler.yaw === cur.yaw && euler.pitch === cur.pitch && euler.roll === cur.roll))) {
    return equalWrite(store, row, 'rotation', [], cur, cur);
  }
  store.channels.willWrite(row, 'rotation');
  setRotation(row.tf, rot, euler);
  store.moved(row);
  store.ports.physics.setRotation(row, rot);
  commitWrite(store, row, 'rotation', [], rotationOf(row.tf), cur, realm);
  return true;
}

export function writeRotation(store: StoreCore, row: RowRec, spec: unknown, realm: WriteRealm): boolean {
  const r = resolveRotationSpec(spec, {
    from: () => worldPose(store, row).pos,
    parentRot: () => {
      const p = row.parentId !== null ? store.get(row.parentId) : undefined;
      return p ? worldPose(store, p).rot : null;
    },
    ground: (x, z) => groundAt(store, row, x, z),
  });
  if (!r) return invalidWrite(store, row, 'rotation');
  return applyRotation(store, row, r.rot, r.euler, realm);
}

/** `yaw = d`: sets yaw, keeps pitch and roll (core §3.3) */
export function writeYaw(store: StoreCore, row: RowRec, yaw: unknown, realm: WriteRealm): boolean {
  if (!isNum(yaw)) return invalidWrite(store, row, 'rotation');
  const cur = rotationOf(row.tf);
  const euler = { yaw: yaw + 0, pitch: cur.pitch, roll: cur.roll };
  return applyRotation(store, row, eulerYXZToQuat(euler.yaw, euler.pitch, euler.roll), euler, realm);
}

export function writeScale(store: StoreCore, row: RowRec, spec: unknown, realm: WriteRealm): boolean {
  const s = resolveScaleSpec(spec);
  if (!s) return invalidWrite(store, row, 'scale');
  if (sameVec3(row.tf.scale, s)) return equalWrite(store, row, 'scale', [], scaleValue(s), scaleValue(s));
  store.channels.willWrite(row, 'scale');
  const prev = scaleValue(row.tf.scale);
  row.tf.scale = s;
  store.moved(row);
  commitWrite(store, row, 'scale', [], scaleValue(s), prev, realm);
  return true;
}

function writeVector(store: StoreCore, row: RowRec, field: 'velocity' | 'angularVelocity', spec: unknown, realm: WriteRealm): boolean {
  const v = resolveVector(spec);
  if (!v) return invalidWrite(store, row, field);
  const key = field === 'velocity' ? 'vel' : 'angVel';
  if (sameVec3(row.tf[key], v)) return equalWrite(store, row, field, [], copyVec3(v), copyVec3(v));
  store.channels.willWrite(row, field);
  const prev = copyVec3(row.tf[key]);
  row.tf[key] = v;
  if (field === 'velocity') store.ports.physics.setVelocity(row, v);
  else store.ports.physics.setAngularVelocity(row, v);
  commitWrite(store, row, field, [], copyVec3(v), prev, realm);
  return true;
}

/** `velocity = v`: the physics port integrates bodies; a body-less row keeps integrating it (core §5.4) */
export function writeVelocity(store: StoreCore, row: RowRec, spec: unknown, realm: WriteRealm): boolean {
  return writeVector(store, row, 'velocity', spec, realm);
}

export function writeAngularVelocity(store: StoreCore, row: RowRec, spec: unknown, realm: WriteRealm): boolean {
  return writeVector(store, row, 'angularVelocity', spec, realm);
}

/**
 * `parent = id | handle | null` (core §4.6, contract §3.3): keeps the world pose and recomputes the local transform; a missing
 * parent or a cycle is refused. No live code writes it; the change wakes sleepers (core §9.5, field `parent`).
 */
export function reparent(store: StoreCore, row: RowRec, target: unknown, realm: WriteRealm): boolean {
  let id: RowId | null;
  if (target === null || target === undefined) id = null;
  else if (typeof target === 'string') id = target;
  else if (typeof target === 'object' && typeof (target as { id?: unknown }).id === 'string') id = (target as { id: string }).id;
  else return invalidWrite(store, row, 'parent');
  if (id === row.parentId) return equalWrite(store, row, 'parent', [], id, id);
  const parent = id === null ? null : (store.get(id) ?? null);
  if (id !== null && !parent) return invalidWrite(store, row, 'parent');
  for (let p = parent, d = 0; p && d < MAX_DEPTH; d++) {
    if (p === row) return invalidWrite(store, row, 'parent');
    p = p.parentId !== null ? (store.get(p.parentId) ?? null) : null;
  }
  store.channels.willWrite(row, 'parent');
  const prev = row.parentId;
  // a camera-attached row stays in camera space: only its parent edge changes
  if (!isCameraAttached(row)) {
    const world = worldPose(store, row);
    const local = parent ? localPoseIn(worldPose(store, parent), world) : world;
    row.tf.pos = copyVec3(local.pos);
    setRotation(row.tf, copyQuat(local.rot), null);
    row.tf.scale = copyVec3(local.scale);
  }
  store.setParent(row, id);
  store.moved(row);
  // the local transform is now in another frame (the world pose did not move): nothing to interpolate from
  store.restartInterpolation(row);
  commitWrite(store, row, 'parent', [], id, prev, realm);
  return true;
}
