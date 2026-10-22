// Rigid skinning of a procedural rig (plan item K3; DESIGN.md §3): every vertex has one joint at weight 1, the bone of the
// triangle it belongs to. The skin matrix of a bone is `pose.model[b] · bindModel[b]⁻¹`; for a skeleton rig the bind model
// matrix is a translation to the pivot, so a rest-frame point p of bone b lands at `model[b] · (p − pivot_b)`. Engine-free:
// the three adapter (`three-rig.ts`) feeds the same numbers to a SkinnedMesh, and the tests use `skinPoint` as the CPU
// reference of what the GPU draws.
import type { Pose, PoseRig } from '../../compat/motion/pose.ts';
import { m4InvertAffine, m4Mul, m4TransformPoint, type Num } from '../../compat/motion/quat.ts';

/** Per-vertex skin attributes of a non-indexed triangle list (3 vertices per triangle). */
export interface RigidSkinAttributes {
  /** 4 per vertex: the bone, then three unused joints (0) */
  readonly skinIndex: Uint16Array;
  /** 4 per vertex: 1, 0, 0, 0 */
  readonly skinWeight: Float32Array;
}

export function rigidSkinAttributes(triBone: ArrayLike<number>): RigidSkinAttributes {
  const verts = triBone.length * 3;
  const skinIndex = new Uint16Array(verts * 4);
  const skinWeight = new Float32Array(verts * 4);
  for (let t = 0; t < triBone.length; t++) {
    for (let k = 0; k < 3; k++) {
      const v = (t * 3 + k) * 4;
      skinIndex[v] = triBone[t]!;
      skinWeight[v] = 1;
    }
  }
  return { skinIndex, skinWeight };
}

/**
 * The skin attributes of an indexed packed LOD (`PackedLod.skinIndex`, INTEGRATION.md H2/H5): the bone per vertex as joint 0
 * at weight 1.0, the three other joints 0 at weight 0 (what three's `skinIndex` / `skinWeight` vec4 attributes read).
 */
export function packedSkinAttributes(boneOfVertex: ArrayLike<number>): RigidSkinAttributes {
  const n = boneOfVertex.length;
  const skinIndex = new Uint16Array(n * 4);
  const skinWeight = new Float32Array(n * 4);
  for (let v = 0; v < n; v++) {
    skinIndex[v * 4] = boneOfVertex[v]!;
    skinWeight[v * 4] = 1;
  }
  return { skinIndex, skinWeight };
}

const inv = new Float64Array(16);
const skin = new Float64Array(16);

/** The skin matrix of bone b in a pose (FK run first): `model[b] · bindModel[b]⁻¹`, into out (16). */
export function skinMatrix<T extends Num>(pose: Pose, b: number, out: T, oo = 0): T {
  pose.updateModel();
  m4InvertAffine(inv, 0, pose.rig.bindModel, b * 16);
  return m4Mul(out, oo, pose.model, b * 16, inv, 0);
}

/** Where a rest-frame point of bone `bone` is in the posed model frame. Null for a bone the rig lacks. */
export function skinPoint(pose: Pose, bone: string, p: readonly [number, number, number]): [number, number, number] | null {
  const b = pose.rig.index(bone);
  if (b < 0) return null;
  skinMatrix(pose, b, skin, 0);
  const out = m4TransformPoint(new Float64Array(3), 0, skin, 0, p as unknown as Num, 0);
  return [out[0]!, out[1]!, out[2]!];
}

/** The bones of a rig that some triangle uses (a bone without geometry, like a bare root, is still posed). */
export function bonesUsed(rig: PoseRig, triBone: ArrayLike<number>): string[] {
  const seen = new Uint8Array(rig.bones.length);
  for (let i = 0; i < triBone.length; i++) seen[triBone[i]!] = 1;
  return rig.bones.filter((_, b) => seen[b] === 1);
}
