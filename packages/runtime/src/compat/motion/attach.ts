// Bone attachments and probe rows (docs/design/motion-physics-nav.md §3.8, D-MPN-06; docs/architecture.md X-40; core §15.4;
// WP MA4): the world pose of a row that rides a bone of its parent (`attachment: { bone }`). Engine-free.
//
//   worldPose(child) = parentSimWorld ∘ modelNormalisation ∘ boneModel(bone) ∘ childLocal
//
//   parentSimWorld      the parent row's simulated transform of the current tick (never the interpolated one a frame shows)
//   modelNormalisation  rig model space → the parent row's local frame: render's ModelTemplate matrix (`rigMatrix`: rebase to
//                       the feet, scale to the facts' height) and whatever the bridge puts between the row and the model root
//                       (`model.offset`, `forward`, `layout.maxExtents`). It is given by the caller (`normalisation`); without
//                       one the rig's model space is the row's local frame, which is exact for every live body whose file
//                       stands on y = 0 at its facts' height.
//   boneModel           the bone's model-space matrix in a LAZY SIM POSE: the parent's mixer evaluated at alpha 0, no IK, the
//                       first time any attached child is read in a tick, then kept for that tick (`endTick()` / `invalidate()`
//                       at step H and a new `clock.tick` both end it). Bone reads are therefore a pure function of the sim
//                       state: the render skeleton (interpolated, IK'd, LOD-skipped) is never read.
//                       The sim pose is also CARRIED once per tick (`endTick()`, step H, no FK): the mixer leaves a bone that
//                       no playing clip names where it is (motion §3.5.4), so such a bone holds whatever the last evaluation
//                       gave it. Evaluated only on reads, a walk that faded into an idle which names six bones would leave
//                       the legs where they were the last time somebody shot at the body [M: a rammer's toe probe 38 cm
//                       apart between "read every tick" and "read once at the end", 32 cm off the drawn bone]. Carried every
//                       tick, the pose is the same whether or not anybody read it, and stays with the drawn one.
//   childLocal          the child's own local position and rotation (a boss template probe sits off its bone:
//                       nonstandard rig Head / head_end (−0.55, −0.01, 0.13), authored module PROBE_OFFSET)
//
// Probe rows (`bp-<Bone>`, tags ['probe'], invisible) are virtual: render gives them no mesh and physics no body, so this
// resolver is the only thing that places them. `jointsOf` (authored module) reads their `worldFeetPosition`; correct
// reads make its calibration offset 0 (motion §3.8.4).
//
// Null (core then falls back to the parent's pose): no parent, no bone name, a parent without a rig (its model is not loaded:
// `jointsOf` counts fewer than 8 probes and the game aims at the coarse body, as live), a bone the rig lacks.
//
// Baked corpses (X-40). `Mixer.release({ keepFinalPose: true })` leaves a FrozenPose on the released mixer; the resolver reads
// that instead of a sim pose, for the corpse's whole life, while `parentSimWorld` stays live (the corpse sinks on fade). The
// mixer is the table: MA3 keeps the FrozenPose until the row is disposed (`Mixer.frozen()`), so nothing is registered here.
import type { AttachmentResolver } from '../core/ports.ts';
import type { Quat, RowRec, Vec3 } from '../core/types.ts';
import type { Mixer } from './mixer.ts';
import { Pose, type PoseRig } from './pose.ts';
import { m4ComposeTRS, m4Mul, qMul, qRotateVec3, type Num } from './quat.ts';

/** the rows a resolver reads (core's RowStore satisfies it) */
export interface RowLookup {
  get(id: string): RowRec | undefined;
}

/** a row's simulated world transform */
export interface SimWorld {
  /** 3 */
  readonly pos: Float64Array;
  /** 4 (x, y, z, w) */
  readonly rot: Float64Array;
  /** 3 */
  readonly scale: Float64Array;
}

export const newSimWorld = (): SimWorld => ({ pos: new Float64Array(3), rot: new Float64Array([0, 0, 0, 1]), scale: new Float64Array([1, 1, 1]) });

/** parent chains deeper than this are cut (core's own limit) */
const MAX_DEPTH = 64;

/** Rotation of the upper 3×3 of a column-major matrix, its columns normalised (uniform or per-axis positive scale). */
export function m4Rotation<T extends Num>(out: T, oo: number, m: Num, mo: number): T {
  const sx = Math.hypot(m[mo]!, m[mo + 1]!, m[mo + 2]!) || 1;
  const sy = Math.hypot(m[mo + 4]!, m[mo + 5]!, m[mo + 6]!) || 1;
  const sz = Math.hypot(m[mo + 8]!, m[mo + 9]!, m[mo + 10]!) || 1;
  const m11 = m[mo]! / sx, m21 = m[mo + 1]! / sx, m31 = m[mo + 2]! / sx;
  const m12 = m[mo + 4]! / sy, m22 = m[mo + 5]! / sy, m32 = m[mo + 6]! / sy;
  const m13 = m[mo + 8]! / sz, m23 = m[mo + 9]! / sz, m33 = m[mo + 10]! / sz;
  const trace = m11 + m22 + m33;
  let x: number, y: number, z: number, w: number;
  if (trace > 0) {
    const s = 0.5 / Math.sqrt(trace + 1);
    w = 0.25 / s;
    x = (m32 - m23) * s;
    y = (m13 - m31) * s;
    z = (m21 - m12) * s;
  } else if (m11 > m22 && m11 > m33) {
    const s = 2 * Math.sqrt(1 + m11 - m22 - m33);
    w = (m32 - m23) / s;
    x = 0.25 * s;
    y = (m12 + m21) / s;
    z = (m13 + m31) / s;
  } else if (m22 > m33) {
    const s = 2 * Math.sqrt(1 + m22 - m11 - m33);
    w = (m13 - m31) / s;
    x = (m12 + m21) / s;
    y = 0.25 * s;
    z = (m23 + m32) / s;
  } else {
    const s = 2 * Math.sqrt(1 + m33 - m11 - m22);
    w = (m21 - m12) / s;
    x = (m13 + m31) / s;
    y = (m23 + m32) / s;
    z = 0.25 * s;
  }
  const l = Math.hypot(x, y, z, w) || 1;
  out[oo] = x / l;
  out[oo + 1] = y / l;
  out[oo + 2] = z / l;
  out[oo + 3] = w / l;
  return out;
}

const cPos = new Float64Array(3);
const cRot = new Float64Array(4);

/**
 * The simulated world transform of a row by its plain parent chain (parent ∘ local: the local position is scaled and turned
 * by the parent, rotations compose, scales multiply per axis: core §5.4 `composePose`). A bone-attached row or ancestor is
 * resolved through `attach` when one is given (the plain chain when it answers null). Writes `out` and returns it.
 */
export function simWorldOf(rows: RowLookup, row: RowRec, out: SimWorld, attach?: AttachmentResolver): SimWorld {
  // the chain from the row up to its top-level ancestor, composed from the top down
  const chain: RowRec[] = [];
  let cur: RowRec | undefined = row;
  let based = false;
  for (let d = 0; cur !== undefined && d < MAX_DEPTH; d++) {
    chain.push(cur);
    if (cur.parentId === null) break;
    const att = cur.props['attachment'];
    if (attach !== undefined && att !== undefined && att !== null) {
      const r = attach.worldPose(cur);
      if (r !== null) {
        // this ancestor's world pose is known: start from it (its scale is its chain's)
        out.pos[0] = r.pos.x;
        out.pos[1] = r.pos.y;
        out.pos[2] = r.pos.z;
        out.rot[0] = r.rot.x;
        out.rot[1] = r.rot.y;
        out.rot[2] = r.rot.z;
        out.rot[3] = r.rot.w;
        const s = chainScale(rows, cur);
        out.scale[0] = s[0]!;
        out.scale[1] = s[1]!;
        out.scale[2] = s[2]!;
        chain.pop();
        based = true;
        break;
      }
    }
    cur = rows.get(cur.parentId);
  }
  if (!based) {
    out.pos.fill(0);
    out.rot[0] = out.rot[1] = out.rot[2] = 0;
    out.rot[3] = 1;
    out.scale.fill(1);
  }
  for (let i = chain.length - 1; i >= 0; i--) {
    const tf = chain[i]!.tf;
    // pos' = pos + rot · (scale ⊙ local.pos)
    cPos[0] = out.scale[0]! * tf.pos.x;
    cPos[1] = out.scale[1]! * tf.pos.y;
    cPos[2] = out.scale[2]! * tf.pos.z;
    qRotateVec3(cPos, 0, out.rot, 0, cPos, 0);
    out.pos[0] = out.pos[0]! + cPos[0]!;
    out.pos[1] = out.pos[1]! + cPos[1]!;
    out.pos[2] = out.pos[2]! + cPos[2]!;
    cRot[0] = tf.rot.x;
    cRot[1] = tf.rot.y;
    cRot[2] = tf.rot.z;
    cRot[3] = tf.rot.w;
    qMul(out.rot, 0, out.rot, 0, cRot, 0);
    out.scale[0] = out.scale[0]! * tf.scale.x;
    out.scale[1] = out.scale[1]! * tf.scale.y;
    out.scale[2] = out.scale[2]! * tf.scale.z;
  }
  return out;
}

const scaleScratch = new Float64Array(3);
function chainScale(rows: RowLookup, row: RowRec): Float64Array {
  scaleScratch.fill(1);
  let cur: RowRec | undefined = row;
  for (let d = 0; cur !== undefined && d < MAX_DEPTH; d++) {
    scaleScratch[0] = scaleScratch[0]! * cur.tf.scale.x;
    scaleScratch[1] = scaleScratch[1]! * cur.tf.scale.y;
    scaleScratch[2] = scaleScratch[2]! * cur.tf.scale.z;
    cur = cur.parentId === null ? undefined : rows.get(cur.parentId);
  }
  return scaleScratch;
}

export interface BoneAttachmentOptions {
  rows: RowLookup;
  /** the mixers by row (`AnimChannels`); `forEach` is what `endTick` carries the sim poses over */
  mixers: { get(rowId: string): Mixer | undefined; forEach?(fn: (mixer: Mixer, row: RowRec) => void): void };
  /** the sim clock: a new tick ends the lazy sim poses of the last one */
  clock: { readonly tick: number };
  /** whether the rows of a place tick at step H (their clocks stand still otherwise, so there is nothing to carry); default: every place */
  isSimulated?: (place: string | null) => boolean;
  /**
   * Rig model space → the parent row's local frame, 16 numbers column-major (see the header); null or absent = identity.
   * Called once per bone read: return a cached array.
   */
  normalisation?: (parent: RowRec) => ArrayLike<number> | null;
  /** the rig of a row that has no mixer (a body nothing animates yet): its bones read at the bind pose */
  rigOf?: (parent: RowRec) => PoseRig | null;
  /** the parent's simulated world transform; default: the plain parent chain (`simWorldOf`) */
  worldOf?: (parent: RowRec, out: SimWorld) => SimWorld;
}

interface SimEntry {
  rig: PoseRig;
  pose: Pose;
  tick: number;
  epoch: number;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** the bone a row's `attachment` names, or null (sockets of a rig are bones too: `{ socket }` resolves the same way) */
export function attachmentBone(row: RowRec): string | null {
  const att = row.props['attachment'];
  if (!isObj(att)) return null;
  const bone = att['bone'] ?? att['socket'];
  return typeof bone === 'string' && bone !== '' ? bone : null;
}

export class BoneAttachmentResolver implements AttachmentResolver {
  readonly #rows: RowLookup;
  readonly #mixers: BoneAttachmentOptions['mixers'];
  readonly #isSimulated: ((place: string | null) => boolean) | undefined;
  readonly #clock: { readonly tick: number };
  readonly #normalisation: ((parent: RowRec) => ArrayLike<number> | null) | undefined;
  readonly #rigOf: ((parent: RowRec) => PoseRig | null) | undefined;
  readonly #worldOf: (parent: RowRec, out: SimWorld) => SimWorld;
  readonly #sim = new Map<string, SimEntry>();
  #epoch = 0;
  /** lazy sim poses evaluated so far on a bone read, FK included (tests, the cost line of motion §3.8.3) */
  evaluations = 0;
  /** sim poses carried at step H so far (one mixer evaluation each, no FK) */
  carried = 0;
  readonly #carry = (mixer: Mixer, row: RowRec): void => {
    const rig = mixer.rig;
    if (mixer.released || rig === null) return;
    if (this.#isSimulated !== undefined && !this.#isSimulated(row.place)) return;
    mixer.evaluate(this.#entry(row.id, rig).pose, 0);
    this.carried++;
  };
  // scratch of one read
  readonly #world = newSimWorld();
  readonly #m = new Float64Array(16);
  readonly #q = new Float64Array(4);
  readonly #p = new Float64Array(3);

  constructor(opts: BoneAttachmentOptions) {
    this.#rows = opts.rows;
    this.#mixers = opts.mixers;
    this.#isSimulated = opts.isSimulated;
    this.#clock = opts.clock;
    this.#normalisation = opts.normalisation;
    this.#rigOf = opts.rigOf;
    this.#worldOf = opts.worldOf ?? ((parent, out) => simWorldOf(this.#rows, parent, out, this));
  }

  /** Any moment the sim state changed under a pose: the next bone read evaluates again. */
  invalidate(): void {
    this.#epoch++;
  }

  /**
   * Tick step H, after the mixers advanced: every rigged mixer of a simulated place is evaluated into its sim pose (local
   * transforms only; the FK waits for a read), so the bones no playing clip names hold what tick-by-tick evaluation leaves
   * them, read or not (see the header). Then the lazy poses are ended: the first bone read of the next tick evaluates again and
   * sees the writes of that tick.
   */
  endTick(): void {
    this.#mixers.forEach?.(this.#carry);
    this.#epoch++;
  }

  /** A row is gone: its sim pose is dropped (a FrozenPose goes with its mixer). */
  forget(rowId: string): void {
    this.#sim.delete(rowId);
  }

  /**
   * The model-space matrix of a bone of `parent` (16 numbers, a view that is valid until the next read): the frozen pose of a
   * baked corpse, else the lazy sim pose of this tick, else the bind pose of a body without a mixer. Null for an unknown bone
   * and for a parent without a rig.
   */
  boneModel(parent: RowRec, bone: string): Float32Array | null {
    const mixer = this.#mixers.get(parent.id);
    if (mixer !== undefined && mixer.released) {
      const frozen = mixer.frozen();
      if (frozen === null) return null;
      const b = frozen.rig.index(bone);
      return b < 0 ? null : frozen.boneModel.subarray(b * 16, b * 16 + 16);
    }
    const rig = mixer?.rig ?? this.#rigOf?.(parent) ?? null;
    if (rig === null) return null;
    const b = rig.index(bone);
    if (b < 0) return null;
    if (mixer === undefined) return rig.bindModel.subarray(b * 16, b * 16 + 16);
    const pose = this.#simPose(parent.id, mixer, rig);
    return pose.model.subarray(b * 16, b * 16 + 16);
  }

  /** The un-IK'd pose of the current tick of a row's mixer (alpha 0), evaluated at most once per tick; null without a rig. */
  simPose(parent: RowRec): Pose | null {
    const mixer = this.#mixers.get(parent.id);
    if (mixer === undefined || mixer.released || mixer.rig === null) return null;
    return this.#simPose(parent.id, mixer, mixer.rig);
  }

  #entry(rowId: string, rig: PoseRig): SimEntry {
    let e = this.#sim.get(rowId);
    if (e === undefined || e.rig !== rig) {
      // a first evaluation, or the body was swapped for another model: a pose of the new rig
      e = { rig, pose: new Pose(rig), tick: -1, epoch: -1 };
      this.#sim.set(rowId, e);
    }
    return e;
  }

  #simPose(rowId: string, mixer: Mixer, rig: PoseRig): Pose {
    const e = this.#entry(rowId, rig);
    const tick = this.#clock.tick;
    if (e.tick !== tick || e.epoch !== this.#epoch) {
      mixer.evaluate(e.pose, 0);
      e.pose.updateModel();
      e.pose.clearDirty();
      e.tick = tick;
      e.epoch = this.#epoch;
      this.evaluations++;
    }
    return e.pose;
  }

  /**
   * The world matrix of a bone of `parent` (parentSimWorld ∘ normalisation ∘ boneModel) into `out` (16); false when the bone
   * cannot be read.
   */
  boneWorld(parent: RowRec, bone: string, out: Num, oo = 0): boolean {
    const model = this.boneModel(parent, bone);
    if (model === null) return false;
    const w = this.#worldOf(parent, this.#world);
    m4ComposeTRS(out, oo, w.pos, 0, w.rot, 0, w.scale, 0);
    const n = this.#normalisation?.(parent) ?? null;
    if (n !== null) m4Mul(out, oo, out, oo, n as Num, 0);
    m4Mul(out, oo, out, oo, model, 0);
    return true;
  }

  worldPose(row: RowRec): { pos: Vec3; rot: Quat } | null {
    const bone = attachmentBone(row);
    if (bone === null || row.parentId === null) return null;
    const parent = this.#rows.get(row.parentId);
    if (parent === undefined) return null;
    const m = this.#m;
    if (!this.boneWorld(parent, bone, m)) return null;
    const { pos, rot } = row.tf;
    const x = m[0]! * pos.x + m[4]! * pos.y + m[8]! * pos.z + m[12]!;
    const y = m[1]! * pos.x + m[5]! * pos.y + m[9]! * pos.z + m[13]!;
    const z = m[2]! * pos.x + m[6]! * pos.y + m[10]! * pos.z + m[14]!;
    const q = m4Rotation(this.#q, 0, m, 0);
    const p = this.#p;
    p[0] = rot.x;
    p[1] = rot.y;
    p[2] = rot.z;
    const w = rot.w;
    // q · row.rot
    const qx = q[0]!, qy = q[1]!, qz = q[2]!, qw = q[3]!;
    return {
      pos: { x, y, z },
      rot: {
        x: qw * p[0]! + qx * w + qy * p[2]! - qz * p[1]!,
        y: qw * p[1]! - qx * p[2]! + qy * w + qz * p[0]!,
        z: qw * p[2]! + qx * p[1]! - qy * p[0]! + qz * w,
        w: qw * w - qx * p[0]! - qy * p[1]! - qz * p[2]!,
      },
    };
  }
}
