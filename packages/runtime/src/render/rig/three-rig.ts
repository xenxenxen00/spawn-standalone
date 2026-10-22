// The three.js side of a procedural rig (plan item K3; DESIGN.md §3, §7): one SkinnedMesh per rigged row, its Bones built
// from the RigDef in rig order, posed by the existing skin adapter (`compat/motion/three-skin.ts` `applyPose`, direct path:
// bone.matrixWorld = root.matrixWorld × pose.model[b]). The geometry is shared per (generator, params, LOD); only the
// Skeleton is per row. No renderer is needed to build or pose it (node tests read `applyBoneTransform`).
import { Bone, BufferAttribute, BufferGeometry, type Material, Matrix4, Object3D, Skeleton, SkinnedMesh, Sphere } from 'three/webgpu';
import type { RigDef } from '../../compat/motion/rig.ts';
import type { SkinSource, SkinTarget } from '../../compat/motion/three-skin.ts';
import { rigidSkinAttributes } from './rigid-skin.ts';

/** A rig's bones in rig order, parented as the rig is, at the bind pose. Direct path: no automatic matrix updates. */
export function createRigBones(rig: RigDef): Bone[] {
  const bones = rig.bones.map((name, b) => {
    const bone = new Bone();
    bone.name = name;
    bone.position.set(rig.bindT[b * 3]!, rig.bindT[b * 3 + 1]!, rig.bindT[b * 3 + 2]!);
    bone.matrixAutoUpdate = false;
    bone.matrixWorldAutoUpdate = false;
    return bone;
  });
  rig.parent.forEach((p, b) => {
    if (p >= 0) bones[p]!.add(bones[b]!);
  });
  return bones;
}

/** A shared geometry for a rigid rig: positions of a non-indexed triangle list (9 per triangle) and the bone per triangle. */
export function createRigidGeometry(positions: ArrayLike<number>, triBone: ArrayLike<number>): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(Float32Array.from(positions), 3));
  const { skinIndex, skinWeight } = rigidSkinAttributes(triBone);
  g.setAttribute('skinIndex', new BufferAttribute(skinIndex, 4));
  g.setAttribute('skinWeight', new BufferAttribute(skinWeight, 4));
  return g;
}

export interface RigidRigInstance {
  readonly mesh: SkinnedMesh;
  /** what `applyPose` writes */
  readonly target: SkinTarget;
}

/**
 * One drawn rig: a SkinnedMesh over the shared geometry, its own Skeleton (inverse bind matrices from `rig.bindModel`), bound
 * with the identity bind matrix (the geometry is in the rig's model frame). Bind mode stays "attached": the bones are written in
 * world space, and three cancels the mesh's own world matrix with its inverse (bindMatrixInverse) before drawing it again.
 * `dequant` is the packed LOD's dequantisation matrix (int16 positions → rig model frame): as the bind matrix it is applied
 * before the bone matrices, where the batcher applies it as the mesh matrix for static rows.
 */
export function createRigidRigInstance(rig: RigDef, geometry: BufferGeometry, material?: Material, dequant?: Matrix4): RigidRigInstance {
  const mesh = new SkinnedMesh(geometry, material);
  const bones = createRigBones(rig);
  const inverses = rig.bones.map((_, b) => new Matrix4().fromArray(rig.bindModel, b * 16).invert());
  const skeleton = new Skeleton(bones, inverses);
  for (const b of bones) if (b.parent === null) mesh.add(b);
  mesh.bind(skeleton, dequant ?? new Matrix4());
  return { mesh, target: { rig, root: mesh, bones, rigMatrix: null, mode: 'direct' } };
}

/**
 * One drawn row of a rigged key in the map batcher (INTEGRATION.md H5): a root that carries the row's world matrix, one
 * Skeleton for the row, and any number of SkinnedMeshes (the LOD levels, both passes, the shadow proxy) under the root that
 * share that skeleton. `source` is what the presentation pass binds (`presenter.bind(source, { rowId, rig, mode: 'direct' })`
 * through `three-skin.ts` `threeSkin`), `target` what `applyPose` writes directly.
 */
export interface RigidRowRig {
  readonly rig: RigDef;
  /** carries the row's world matrix (`matrixAutoUpdate` off); the meshes under it have the identity matrix */
  readonly root: Object3D;
  readonly bones: readonly Bone[];
  readonly skeleton: Skeleton;
  readonly target: SkinTarget;
  readonly source: SkinSource;
  readonly meshes: SkinnedMesh[];
}

export function createRigidRowRig(rig: RigDef, name = 'rig'): RigidRowRig {
  const root = new Object3D();
  root.name = name;
  root.matrixAutoUpdate = false;
  const bones = createRigBones(rig);
  for (const b of bones) if (b.parent === null) root.add(b);
  const inverses = rig.bones.map((_, b) => new Matrix4().fromArray(rig.bindModel, b * 16).invert());
  const skeleton = new Skeleton(bones, inverses);
  const target: SkinTarget = { rig, root, bones, rigMatrix: null, mode: 'direct' };
  const source: SkinSource = { root, bones: new Map(bones.map((b) => [b.name, b] as const)), boneList: bones, bonePath: 'direct' };
  return { rig, root, bones, skeleton, target, source, meshes: [] };
}

/**
 * A SkinnedMesh of one level over a packed geometry (int16 positions, `skinIndex` / `skinWeight` set), sharing the row's
 * skeleton. Bound "attached" with the level's dequantisation as the bind matrix: three applies it before the bone matrices, so
 * it is NOT multiplied into the mesh matrix. `sphere` is the mesh-local culling sphere (three would otherwise compute one from
 * the skinned vertices once, at whatever pose the bones had then).
 */
export function addRigidMesh(row: RigidRowRig, geometry: BufferGeometry, material: Material, dequant: Matrix4, sphere?: Sphere): SkinnedMesh {
  const mesh = new SkinnedMesh(geometry, material);
  mesh.matrixAutoUpdate = false;
  mesh.bind(row.skeleton, dequant);
  if (sphere) mesh.boundingSphere = sphere.clone();
  row.root.add(mesh);
  row.meshes.push(mesh);
  return mesh;
}
