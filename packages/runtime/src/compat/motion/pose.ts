// A pose: the local TRS of every bone of one rig, the model-space matrices they give by forward kinematics, and what changed
// (docs/design/motion-physics-nav.md §2, §3.5.4, §3.8.2, §3.10; docs/architecture.md X-40). Engine-free and allocation-free
// after construction: the mixer writes locals each frame, IK edits them, `updateModel()` runs the FK once, the three adapter
// (`three-skin.ts`) and the bone attachments (`attach.ts`) read the matrices.
//
// Dirty masks. A write marks a bone only when its value changes, so a clip held on its last frame marks nothing (the corpse
// baker waits for "no bone changed for 10 frames", motion §3.10):
//   dirty       local TRS changed since clearDirty()
//   modelDirty  model matrix recomputed since clearDirty(): the changed bones and everything below them
// The consumer of a frame clears both; the FK keeps its own pending set, so clearing never loses a matrix update.
//
// Model space is the rig's (`bindModel`). A root bone may sit under non-bone nodes (an armature node): `bindModel(root)` is then
// not its local bind matrix, and the matrix above it, `bindModel(root)·local(root)⁻¹`, is kept and applied to the animated root.
import { m4ComposeTRS, m4InvertAffine, m4Mul } from './quat.ts';

/**
 * What a pose and the mixer need of a rig: the `RigDef` of `rig.ts` satisfies it as it is (motion §3.2). Bone order is the
 * skin's joint order and need not list parents first.
 */
export interface PoseRig {
  /** model id (one rig per model file) */
  readonly id: string;
  /** canonical bone names */
  readonly bones: readonly string[];
  /** −1 = root */
  readonly parent: Int16Array;
  /** 3 per bone, local */
  readonly bindT: Float32Array;
  /** 4 per bone (x, y, z, w), local */
  readonly bindR: Float32Array;
  /** 3 per bone */
  readonly bindS: Float32Array;
  /** 16 per bone, model-space bind matrices */
  readonly bindModel: Float32Array;
  /** model-space y of Hips at bind ('hips' units) */
  readonly hipsRestHeight: number;
  /** bone name → index, −1 when absent */
  index(name: string): number;
}

/** The final model-space pose a released mixer leaves behind (X-40): what `BoneAttachmentResolver` reads for a baked corpse. */
export interface FrozenPose {
  readonly rigId: string;
  /** the rig the matrices are indexed by (`rig.index(bone)`) */
  readonly rig: PoseRig;
  /** 16 per bone, model space, column-major */
  readonly boneModel: Float32Array;
}

interface RigLayout {
  /** bone indices, parents before children */
  readonly order: Int16Array;
  /** per bone: the matrix above a root bone when it is not the identity, else null */
  readonly above: ReadonlyArray<Float64Array | null>;
}

const LAYOUTS = new WeakMap<PoseRig, RigLayout>();
const ABOVE_EPS = 1e-6;

function layoutOf(rig: PoseRig): RigLayout {
  let l = LAYOUTS.get(rig);
  if (l) return l;
  const n = rig.bones.length;
  const order = new Int16Array(n);
  const state = new Uint8Array(n); // 0 = todo, 1 = on the stack, 2 = placed
  let k = 0;
  const place = (i: number): void => {
    if (state[i] === 2) return;
    if (state[i] === 1) throw new Error(`pose: bone ${rig.bones[i]} of rig ${rig.id} is its own ancestor`);
    state[i] = 1;
    const p = rig.parent[i]!;
    if (p >= 0) place(p);
    order[k++] = i;
    state[i] = 2;
  };
  for (let i = 0; i < n; i++) place(i);
  const above: Array<Float64Array | null> = new Array<Float64Array | null>(n).fill(null);
  const local = new Float64Array(16);
  for (let i = 0; i < n; i++) {
    if (rig.parent[i]! >= 0) continue;
    m4ComposeTRS(local, 0, rig.bindT, i * 3, rig.bindR, i * 4, rig.bindS, i * 3);
    m4InvertAffine(local, 0, local, 0);
    const m = m4Mul(new Float64Array(16), 0, rig.bindModel, i * 16, local, 0);
    let identity = true;
    for (let e = 0; e < 16 && identity; e++) identity = Math.abs(m[e]! - (e % 5 === 0 ? 1 : 0)) <= ABOVE_EPS;
    if (!identity) above[i] = m;
  }
  l = { order, above };
  LAYOUTS.set(rig, l);
  return l;
}

/** The bones of a rig, parents before children (computed once per rig). */
export function boneOrder(rig: PoseRig): Int16Array {
  return layoutOf(rig).order;
}

const f = Math.fround;

export class Pose {
  readonly rig: PoseRig;
  /** number of bones */
  readonly count: number;
  /** local translation, 3 per bone */
  readonly t: Float32Array;
  /** local rotation (x, y, z, w), 4 per bone */
  readonly r: Float32Array;
  /** local scale, 3 per bone */
  readonly s: Float32Array;
  /** model-space matrices, 16 per bone, column-major: valid after updateModel() */
  readonly model: Float32Array;
  /** per bone: local TRS changed since clearDirty() */
  readonly dirty: Uint8Array;
  /** per bone: model matrix recomputed since clearDirty() */
  readonly modelDirty: Uint8Array;
  /** per bone: the FK has not seen this bone's latest local TRS */
  readonly #stale: Uint8Array;
  readonly #moved: Uint8Array;
  readonly #layout: RigLayout;
  readonly #local = new Float64Array(16);
  #pending: boolean;

  /** A pose at the rig's bind pose. */
  constructor(rig: PoseRig) {
    const n = rig.bones.length;
    this.rig = rig;
    this.count = n;
    this.t = Float32Array.from(rig.bindT);
    this.r = Float32Array.from(rig.bindR);
    this.s = Float32Array.from(rig.bindS);
    this.model = new Float32Array(n * 16);
    this.dirty = new Uint8Array(n);
    this.modelDirty = new Uint8Array(n);
    this.#stale = new Uint8Array(n).fill(1);
    this.#moved = new Uint8Array(n);
    this.#layout = layoutOf(rig);
    this.#pending = n > 0;
  }

  /** Back to the bind pose (marks the bones that were off it). */
  reset(): void {
    const { bindT: bt, bindR: br, bindS: bs } = this.rig;
    for (let b = 0; b < this.count; b++) {
      const b3 = b * 3;
      const b4 = b * 4;
      this.setLocal(b, bt[b3]!, bt[b3 + 1]!, bt[b3 + 2]!, br[b4]!, br[b4 + 1]!, br[b4 + 2]!, br[b4 + 3]!, bs[b3]!, bs[b3 + 1]!, bs[b3 + 2]!);
    }
  }

  /** Marks a bone whose local TRS was written straight into the arrays (IK). */
  touch(bone: number): void {
    this.dirty[bone] = 1;
    this.#stale[bone] = 1;
    this.#pending = true;
  }

  /** Writes a bone's whole local transform; returns whether anything changed. */
  setLocal(bone: number, tx: number, ty: number, tz: number, rx: number, ry: number, rz: number, rw: number, sx: number, sy: number, sz: number): boolean {
    const t = this.t;
    const r = this.r;
    const s = this.s;
    const b3 = bone * 3;
    const b4 = bone * 4;
    if (
      t[b3] === f(tx) && t[b3 + 1] === f(ty) && t[b3 + 2] === f(tz) &&
      r[b4] === f(rx) && r[b4 + 1] === f(ry) && r[b4 + 2] === f(rz) && r[b4 + 3] === f(rw) &&
      s[b3] === f(sx) && s[b3 + 1] === f(sy) && s[b3 + 2] === f(sz)
    ) {
      return false;
    }
    t[b3] = tx;
    t[b3 + 1] = ty;
    t[b3 + 2] = tz;
    r[b4] = rx;
    r[b4 + 1] = ry;
    r[b4 + 2] = rz;
    r[b4 + 3] = rw;
    s[b3] = sx;
    s[b3 + 1] = sy;
    s[b3 + 2] = sz;
    this.touch(bone);
    return true;
  }

  setTranslation(bone: number, x: number, y: number, z: number): boolean {
    const t = this.t;
    const o = bone * 3;
    if (t[o] === f(x) && t[o + 1] === f(y) && t[o + 2] === f(z)) return false;
    t[o] = x;
    t[o + 1] = y;
    t[o + 2] = z;
    this.touch(bone);
    return true;
  }

  setRotation(bone: number, x: number, y: number, z: number, w: number): boolean {
    const r = this.r;
    const o = bone * 4;
    if (r[o] === f(x) && r[o + 1] === f(y) && r[o + 2] === f(z) && r[o + 3] === f(w)) return false;
    r[o] = x;
    r[o + 1] = y;
    r[o + 2] = z;
    r[o + 3] = w;
    this.touch(bone);
    return true;
  }

  setScale(bone: number, x: number, y: number, z: number): boolean {
    const s = this.s;
    const o = bone * 3;
    if (s[o] === f(x) && s[o + 1] === f(y) && s[o + 2] === f(z)) return false;
    s[o] = x;
    s[o + 1] = y;
    s[o + 2] = z;
    this.touch(bone);
    return true;
  }

  /** The consumer of a frame has seen the changes (the pending FK is kept). */
  clearDirty(): void {
    this.dirty.fill(0);
    this.modelDirty.fill(0);
  }

  /**
   * Forward kinematics: recomputes the model-space matrix of every bone whose local TRS changed since the last call and of
   * everything below it. Returns how many matrices it recomputed.
   */
  updateModel(): number {
    if (!this.#pending) return 0;
    const { order, above } = this.#layout;
    const parent = this.rig.parent;
    const stale = this.#stale;
    const moved = this.#moved;
    const model = this.model;
    const local = this.#local;
    let n = 0;
    for (let k = 0; k < order.length; k++) {
      const b = order[k]!;
      const p = parent[b]!;
      if (stale[b] === 0 && (p < 0 || moved[p] === 0)) {
        moved[b] = 0;
        continue;
      }
      m4ComposeTRS(local, 0, this.t, b * 3, this.r, b * 4, this.s, b * 3);
      if (p >= 0) m4Mul(model, b * 16, model, p * 16, local, 0);
      else {
        const up = above[b];
        if (up) m4Mul(model, b * 16, up, 0, local, 0);
        else for (let e = 0; e < 16; e++) model[b * 16 + e] = local[e]!;
      }
      stale[b] = 0;
      moved[b] = 1;
      this.modelDirty[b] = 1;
      n++;
    }
    this.#pending = false;
    return n;
  }
}

/** A copy of the pose's model-space matrices (the FK is run first). */
export function freezePose(pose: Pose): FrozenPose {
  pose.updateModel();
  return { rigId: pose.rig.id, rig: pose.rig, boneModel: Float32Array.from(pose.model) };
}

/** A bone's model-space matrix in a frozen pose (a 16-element view), or null for a bone the rig lacks. */
export function frozenBoneMatrix(frozen: FrozenPose, bone: string): Float32Array | null {
  const b = frozen.rig.index(bone);
  return b < 0 ? null : frozen.boneModel.subarray(b * 16, b * 16 + 16);
}
