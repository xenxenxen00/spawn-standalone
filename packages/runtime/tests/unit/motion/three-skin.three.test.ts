// MA4 acceptance (docs/architecture.md §9.3; motion §3.10; render §16.3): "`three-skin` bone matrices match a three hierarchy
// update of the same pose to 1e-5, also for a root moved this frame (the bridge's `root.updateWorldMatrix(true, false)` runs
// first): the skinned vertices and a bone-attached child follow the current root, not the previous frame's".
//
// Node + three's scene graph, no renderer. Each rig is built twice as a `SkeletonUtils.clone` of one skinned source: one copy
// is written on the direct path (`applyPose` writes `bone.matrixWorld`), the other carries the same local TRS on its bones and
// lets three update the hierarchy. The same checks then run on render's real `ModelInstance` (R6), whose root sits under a
// normalisation (`rigMatrix`).
import { Bone, BufferGeometry, Float32BufferAttribute, Group, Matrix4, MeshBasicMaterial, Object3D, Quaternion, Scene, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3 } from 'three/webgpu';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { parseGlb as parseGlbJson } from '../../../src/compat/motion/model-clips.ts';
import { Pose } from '../../../src/compat/motion/pose.ts';
import { m4ComposeTRS, qFromEulerXYZDeg } from '../../../src/compat/motion/quat.ts';
import { buildRigDef, rigFromGltf, type RigDef, type RigNode } from '../../../src/compat/motion/rig.ts';
import { applyPose, bindThreeSkin, createSkinTarget, invalidateSkin, rigOfSkin, rigWorldOf, threeSkin, type SkinTarget } from '../../../src/compat/motion/three-skin.ts';
import { ModelInstance } from '../../../src/render/models/model-instance.ts';
import { buildModelTemplate, modelSourceFromGltf, type ModelTemplate } from '../../../src/render/models/model-template.ts';
import { FIXTURE_FACTS, fixtureGlb, parseGlb, testEnv, type TestEnv } from '../render/models/model-fixtures.ts';
import { motionWorld } from './fakes/motion-world.ts';
import { HUMANOID_BONES, clipOf, quat } from './fakes/rig.ts';

const TOL = 1e-5;

// ── rigs ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** deterministic pseudo-random numbers in [0, 1) */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

/** the platform's 24 bone names on a rig with rotated, non-trivial bind transforms */
function platformNodes(): RigNode[] {
  const index = new Map(HUMANOID_BONES.map(([name], i) => [name, i] as const));
  return HUMANOID_BONES.map(([name, parent], i) => ({
    name,
    parent: parent === null ? -1 : index.get(parent)!,
    t: parent === null ? [0, 0.97, 0] : [((i % 3) - 1) * 0.08, i % 2 === 0 ? 0.12 : -0.2, 0.01 * i],
    r: qFromEulerXYZDeg([0, 0, 0, 1], 0, i * 3, -i * 2, i),
  }));
}

/** a Mixamo-style export: `mixamorig:` names, centimetre bones under an armature node that turns and scales them */
const ARMATURE_T = [0, 0.02, 0] as const;
const ARMATURE_R = qFromEulerXYZDeg([0, 0, 0, 1], 0, -90, 0, 0);
const ARMATURE_S = [0.01, 0.01, 0.01] as const;
function mixamoNodes(): RigNode[] {
  const above = m4ComposeTRS(new Float64Array(16), 0, [...ARMATURE_T], 0, ARMATURE_R, 0, [...ARMATURE_S], 0);
  const names = ['Hips', 'Spine', 'Spine1', 'Spine2', 'Neck', 'Head', 'LeftShoulder', 'LeftArm', 'LeftForeArm', 'LeftHand', 'RightShoulder', 'RightArm', 'RightForeArm', 'RightHand', 'LeftUpLeg', 'LeftLeg', 'LeftFoot', 'LeftToeBase', 'RightUpLeg', 'RightLeg', 'RightFoot', 'RightToeBase', 'LeftHandIndex1', 'LeftHandIndex2', 'RightHandIndex1', 'RightHandIndex2'];
  const parents: Record<string, string | null> = {
    Hips: null, Spine: 'Hips', Spine1: 'Spine', Spine2: 'Spine1', Neck: 'Spine2', Head: 'Neck',
    LeftShoulder: 'Spine2', LeftArm: 'LeftShoulder', LeftForeArm: 'LeftArm', LeftHand: 'LeftForeArm',
    RightShoulder: 'Spine2', RightArm: 'RightShoulder', RightForeArm: 'RightArm', RightHand: 'RightForeArm',
    LeftUpLeg: 'Hips', LeftLeg: 'LeftUpLeg', LeftFoot: 'LeftLeg', LeftToeBase: 'LeftFoot',
    RightUpLeg: 'Hips', RightLeg: 'RightUpLeg', RightFoot: 'RightLeg', RightToeBase: 'RightFoot',
    LeftHandIndex1: 'LeftHand', LeftHandIndex2: 'LeftHandIndex1', RightHandIndex1: 'RightHand', RightHandIndex2: 'RightHandIndex1',
  };
  return names.map((name, i) => {
    const parent = parents[name]!;
    const node = {
      name: `mixamorig:${name}`,
      t: parent === null ? [0, 3, -98] : [((i % 5) - 2) * 6, 10 + (i % 4) * 5, (i % 3) * 2],
      r: qFromEulerXYZDeg([0, 0, 0, 1], 0, i * 5 - 20, i * 2, -i * 3),
    };
    return parent === null ? { ...node, parent: -1, above } : { ...node, parent: names.indexOf(parent) };
  });
}

interface Skinned {
  root: Group;
  mesh: SkinnedMesh;
  bones: Bone[];
  /** an object hanging on a bone (gear, a wound): reads the bone's world matrix */
  child: Object3D;
}

const CHILD_BONE = 5;

/** A skinned three model of a rig: bones at their bind TRS, two vertices per bone weighted to it and to its parent. */
function buildSource(rig: RigDef, armature: { t: readonly number[]; r: readonly number[]; s: readonly number[] } | null): Group {
  const root = new Group();
  const container = new Object3D();
  container.name = 'Armature';
  if (armature) {
    container.position.fromArray(armature.t);
    container.quaternion.fromArray(armature.r);
    container.scale.fromArray(armature.s);
  }
  const bones = rig.sourceNames.map((name, i) => {
    const b = new Bone();
    b.name = name;
    b.position.fromArray(rig.bindT, i * 3);
    b.quaternion.fromArray(rig.bindR, i * 4);
    b.scale.fromArray(rig.bindS, i * 3);
    return b;
  });
  bones.forEach((b, i) => (rig.parent[i]! < 0 ? container : bones[rig.parent[i]!]!).add(b));
  const child = new Object3D();
  child.name = 'gear';
  child.position.set(0.05, -0.02, 0.11);
  child.quaternion.setFromAxisAngle(new Vector3(0, 0, 1), 0.4);
  bones[CHILD_BONE]!.add(child);

  const position: number[] = [];
  const skinIndex: number[] = [];
  const skinWeight: number[] = [];
  for (let i = 0; i < bones.length; i++) {
    const m = rig.bindModel;
    const p = rig.parent[i]! < 0 ? i : rig.parent[i]!;
    for (let k = 0; k < 2; k++) {
      position.push(m[i * 16 + 12]! + 0.03 * (k + 1), m[i * 16 + 13]! - 0.02 * k, m[i * 16 + 14]! + 0.01);
      skinIndex.push(i, p, 0, 0);
      skinWeight.push(k === 0 ? 1 : 0.6, k === 0 ? 0 : 0.4, 0, 0);
    }
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(position, 3));
  geometry.setAttribute('skinIndex', new Uint16BufferAttribute(skinIndex, 4));
  geometry.setAttribute('skinWeight', new Float32BufferAttribute(skinWeight, 4));
  const mesh = new SkinnedMesh(geometry, new MeshBasicMaterial());
  mesh.name = 'body';
  root.add(mesh);
  root.add(container);
  root.updateMatrixWorld(true);
  mesh.bind(new Skeleton(bones));
  return root;
}

function instanceOf(source: Group): Skinned {
  const root = cloneSkinned(source) as Group;
  const mesh = root.children[0] as SkinnedMesh;
  const bones = mesh.skeleton.bones;
  let child: Object3D | undefined;
  root.traverse((o) => {
    if (o.name === 'gear') child = o;
  });
  return { root, mesh, bones, child: child! };
}

function direct(i: Skinned): Skinned {
  for (const b of i.bones) {
    b.matrixAutoUpdate = false;
    b.matrixWorldAutoUpdate = false;
  }
  return i;
}

function targetOf(i: Skinned, rig: RigDef, mode: 'direct' | 'hierarchy' = 'direct'): SkinTarget {
  return { rig, root: i.root, bones: i.bones, mode };
}

/** a pose away from bind on every bone: rotations, a moved root bone, a few stretched bones */
function randomPose(rig: RigDef, seed: number, pose = new Pose(rig)): Pose {
  const r = rng(seed);
  const q = [0, 0, 0, 1];
  for (let b = 0; b < pose.count; b++) {
    qFromEulerXYZDeg(q, 0, (r() - 0.5) * 140, (r() - 0.5) * 140, (r() - 0.5) * 140);
    pose.setRotation(b, q[0]!, q[1]!, q[2]!, q[3]!);
    if (rig.parent[b]! < 0) pose.setTranslation(b, rig.bindT[b * 3]! + (r() - 0.5) * 0.4, rig.bindT[b * 3 + 1]! * (0.6 + r() * 0.5), rig.bindT[b * 3 + 2]! + (r() - 0.5) * 0.4);
    if (b % 7 === 3) {
      const s = 0.8 + r() * 0.5;
      pose.setScale(b, s, s, s);
    }
  }
  return pose;
}

/** the reference: the same local TRS on the bones, three's own hierarchy update */
function poseReference(i: Skinned, pose: Pose): void {
  i.bones.forEach((bone, b) => {
    bone.position.fromArray(pose.t, b * 3);
    bone.quaternion.fromArray(pose.r, b * 4);
    bone.scale.fromArray(pose.s, b * 3);
  });
  i.root.updateMatrixWorld(true);
}

function placeRoot(root: Object3D, at: readonly [number, number, number], yaw: number, scale = 1): void {
  root.position.set(at[0], at[1], at[2]);
  root.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), yaw);
  root.scale.setScalar(scale);
}

function maxDiff(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let d = 0;
  for (let k = 0; k < a.length; k++) d = Math.max(d, Math.abs(a[k]! - b[k]!));
  return d;
}

function boneDiff(a: readonly Bone[], b: readonly Bone[]): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) d = Math.max(d, maxDiff(a[i]!.matrixWorld.elements, b[i]!.matrixWorld.elements));
  return d;
}

/** CPU skinning as the vertex shader does it: Σ w · boneMatrix · (bindMatrix · v), in world space */
function skinnedVertices(mesh: SkinnedMesh): Float64Array {
  mesh.skeleton.update();
  const mats = mesh.skeleton.boneMatrices!;
  const pos = mesh.geometry.getAttribute('position');
  const idx = mesh.geometry.getAttribute('skinIndex');
  const wgt = mesh.geometry.getAttribute('skinWeight');
  const out = new Float64Array(pos.count * 3);
  const v = new Vector3();
  const base = new Vector3();
  const m = new Matrix4();
  for (let i = 0; i < pos.count; i++) {
    base.fromBufferAttribute(pos, i).applyMatrix4(mesh.bindMatrix);
    let x = 0, y = 0, z = 0;
    for (let k = 0; k < 4; k++) {
      const w = wgt.getComponent(i, k);
      if (w === 0) continue;
      m.fromArray(mats, idx.getComponent(i, k) * 16);
      v.copy(base).applyMatrix4(m);
      x += v.x * w;
      y += v.y * w;
      z += v.z * w;
    }
    out.set([x, y, z], i * 3);
  }
  return out;
}

const RIGS: ReadonlyArray<readonly [string, () => { rig: RigDef; source: Group }]> = [
  ['platform-v3-like, 24 bones', () => {
    const rig = buildRigDef('test.platform', platformNodes());
    return { rig, source: buildSource(rig, null) };
  }],
  ['mixamo-like, prefixed names under a scaled armature', () => {
    const rig = buildRigDef('test.mixamo', mixamoNodes());
    return { rig, source: buildSource(rig, { t: ARMATURE_T, r: ARMATURE_R, s: ARMATURE_S }) };
  }],
];

describe.each(RIGS)('direct path against three’s hierarchy update: %s', (_name, make) => {
  const { rig, source } = make();

  it('the rig fixture is what it claims', () => {
    expect(rig.bones.length).toBeGreaterThanOrEqual(24);
    expect(rig.bones).toContain('Hips');
    expect(rig.bones.every((b) => !b.includes(':'))).toBe(true);
    // the three source at rest is the rig's bind pose
    const i = instanceOf(source);
    i.root.updateMatrixWorld(true);
    i.bones.forEach((bone, b) => expect(maxDiff(bone.matrixWorld.elements, rig.bindModel.subarray(b * 16, b * 16 + 16)), rig.bones[b]).toBeLessThan(TOL));
  });

  it('static root: bone world matrices, boneMatrices and skinned vertices equal the reference to 1e-5, for 25 poses', () => {
    const a = direct(instanceOf(source));
    const ref = instanceOf(source);
    placeRoot(a.root, [12, 0.4, -7], 0.65, 1.1);
    placeRoot(ref.root, [12, 0.4, -7], 0.65, 1.1);
    a.root.updateWorldMatrix(true, false);
    a.mesh.updateMatrixWorld(true);
    const target = targetOf(a, rig);
    const pose = new Pose(rig);
    let worst = 0;
    for (let seed = 1; seed <= 25; seed++) {
      randomPose(rig, seed, pose);
      pose.updateModel();
      applyPose(target, pose, pose.modelDirty);
      pose.clearDirty();
      poseReference(ref, pose);
      const d = boneDiff(a.bones, ref.bones);
      worst = Math.max(worst, d);
      expect(d, `pose ${seed}: bone.matrixWorld`).toBeLessThan(TOL);
      const va = skinnedVertices(a.mesh);
      const vr = skinnedVertices(ref.mesh);
      expect(maxDiff(a.mesh.skeleton.boneMatrices!, ref.mesh.skeleton.boneMatrices!), `pose ${seed}: boneMatrices`).toBeLessThan(TOL);
      expect(maxDiff(va, vr), `pose ${seed}: skinned vertices`).toBeLessThan(TOL);
    }
    console.log(`${rig.id}: worst bone matrix difference over 25 poses ${worst.toExponential(2)}`);
  });

  it('root moved this frame: after the bridge’s root.updateWorldMatrix(true, false) the skin and a bone-attached child follow the current root', () => {
    const scene = new Scene();
    const a = direct(instanceOf(source));
    const ref = instanceOf(source);
    scene.add(a.root);
    const target = targetOf(a, rig);
    const pose = randomPose(rig, 77);
    const frames: ReadonlyArray<readonly [readonly [number, number, number], number]> = [
      [[3, 0, 2], 0.2],
      [[3.2, 0, 1.7], 0.5],
      [[-8, 1.5, 40], -2.1],
    ];
    let previous: Float64Array | null = null;
    frames.forEach(([at, yaw], f) => {
      // frame step 4: the bridge writes the interpolated transform and makes the root's world matrix current
      placeRoot(a.root, at, yaw);
      a.root.updateWorldMatrix(true, false);
      // then the mixer presentation; from the second frame on the pose holds still (nothing dirty)
      if (f === 1) pose.clearDirty();
      pose.updateModel();
      const written = applyPose(target, pose, pose.modelDirty);
      expect(written, `frame ${f}: every bone is written again under a moved root`).toBe(rig.bones.length);
      // frame step 6: three updates the scene graph inside render()
      scene.updateMatrixWorld();

      placeRoot(ref.root, at, yaw);
      poseReference(ref, pose);
      expect(boneDiff(a.bones, ref.bones), `frame ${f}: bones`).toBeLessThan(TOL);
      const va = skinnedVertices(a.mesh);
      expect(maxDiff(va, skinnedVertices(ref.mesh)), `frame ${f}: skinned vertices`).toBeLessThan(TOL);
      expect(maxDiff(a.child.matrixWorld.elements, ref.child.matrixWorld.elements), `frame ${f}: bone-attached child`).toBeLessThan(TOL);
      // and it is not where the previous frame had it
      if (previous) expect(maxDiff(va, previous), `frame ${f}: moved with the root`).toBeGreaterThan(0.1);
      previous = va;
    });
  });

  it('negative control: without the bridge call the skin is one frame behind (the precondition is real)', () => {
    const scene = new Scene();
    const a = direct(instanceOf(source));
    const ref = instanceOf(source);
    scene.add(a.root);
    const target = targetOf(a, rig);
    const pose = randomPose(rig, 5);
    placeRoot(a.root, [0, 0, 0], 0);
    a.root.updateWorldMatrix(true, false);
    pose.updateModel();
    applyPose(target, pose, pose.modelDirty);
    scene.updateMatrixWorld();
    const first = skinnedVertices(a.mesh);
    const firstChild = Float64Array.from(a.child.matrixWorld.elements);

    // the next frame moves the root 0.5 m and turns it, but nobody updates its world matrix before the skin write
    placeRoot(a.root, [0.5, 0, 0], 0.3);
    randomPose(rig, 6, pose);
    pose.updateModel();
    applyPose(target, pose, pose.modelDirty);
    scene.updateMatrixWorld(); // render(): the root's world matrix is right only now
    placeRoot(ref.root, [0.5, 0, 0], 0.3);
    poseReference(ref, pose);
    const stale = skinnedVertices(a.mesh);
    expect(maxDiff(stale, skinnedVertices(ref.mesh))).toBeGreaterThan(0.1);
    expect(maxDiff(a.child.matrixWorld.elements, ref.child.matrixWorld.elements)).toBeGreaterThan(0.1);
    // what it drew is the new pose under the OLD root
    placeRoot(ref.root, [0, 0, 0], 0);
    poseReference(ref, pose);
    expect(maxDiff(stale, skinnedVertices(ref.mesh))).toBeLessThan(TOL);
    expect(maxDiff(first, stale)).toBeGreaterThan(0); // (the pose did change)
    expect(maxDiff(firstChild, a.child.matrixWorld.elements)).toBeGreaterThan(0);

    // with the bridge call the same frame is right
    a.root.updateWorldMatrix(true, false);
    applyPose(target, pose, pose.modelDirty);
    scene.updateMatrixWorld();
    placeRoot(ref.root, [0.5, 0, 0], 0.3);
    poseReference(ref, pose);
    expect(maxDiff(skinnedVertices(a.mesh), skinnedVertices(ref.mesh))).toBeLessThan(TOL);
  });

  it('a body that has never been animated follows a moving root at its bind pose (before the mixer binds a clip)', () => {
    const a = direct(instanceOf(source));
    const ref = instanceOf(source);
    const target = targetOf(a, rig);
    const pose = new Pose(rig);
    pose.updateModel();
    pose.clearDirty(); // nothing is dirty, ever
    for (const [at, yaw] of [[[1, 0, 1], 0], [[4, 0, -2], 1.2], [[4, 0, -2], 1.2], [[9, 2, -2], 3]] as const) {
      placeRoot(a.root, at, yaw);
      a.root.updateWorldMatrix(true, false);
      applyPose(target, pose, pose.modelDirty);
      placeRoot(ref.root, at, yaw);
      ref.root.updateMatrixWorld(true);
      expect(boneDiff(a.bones, ref.bones)).toBeLessThan(TOL);
      expect(maxDiff(skinnedVertices(a.mesh), skinnedVertices(ref.mesh))).toBeLessThan(TOL);
    }
  });

  it('writes only dirty bones under an unmoved root, nothing when nothing is dirty, and skips null bones', () => {
    const a = direct(instanceOf(source));
    placeRoot(a.root, [2, 0, 2], 0.3);
    a.root.updateWorldMatrix(true, false);
    const target = targetOf(a, rig);
    const pose = new Pose(rig);
    pose.updateModel();
    expect(applyPose(target, pose, pose.modelDirty)).toBe(rig.bones.length); // the first write is whole
    pose.clearDirty();
    expect(applyPose(target, pose, pose.modelDirty)).toBe(0);
    const before = a.bones.map((b) => Float64Array.from(b.matrixWorld.elements));
    expect(applyPose(target, pose, pose.modelDirty)).toBe(0);
    a.bones.forEach((b, i) => expect(Float64Array.from(b.matrixWorld.elements)).toEqual(before[i]));

    // one leaf bone turns: it alone is written
    const leaf = rig.bones.findIndex((_, i) => !Array.from(rig.parent).includes(i));
    pose.setRotation(leaf, 0, Math.SQRT1_2, 0, Math.SQRT1_2);
    pose.updateModel();
    expect(applyPose(target, pose, pose.modelDirty)).toBe(1);
    a.bones.forEach((b, i) => {
      if (i === leaf) expect(Float64Array.from(b.matrixWorld.elements)).not.toEqual(before[i]);
      else expect(Float64Array.from(b.matrixWorld.elements)).toEqual(before[i]);
    });
    pose.clearDirty();

    // a bone with children turns: it and everything below it, nothing else
    const inner = rig.index('Hips');
    pose.setRotation(inner, 0, 0, Math.SQRT1_2, Math.SQRT1_2);
    pose.updateModel();
    expect(applyPose(target, pose, pose.modelDirty)).toBe(rig.bones.length);
    pose.clearDirty();

    // null entries are skipped, and a pose of another rig writes nothing
    const holes: SkinTarget = { rig, root: a.root, bones: a.bones.map((b, i) => (i % 2 === 0 ? b : null)) };
    randomPose(rig, 3, pose);
    pose.updateModel();
    expect(applyPose(holes, pose, pose.modelDirty)).toBe(Math.ceil(rig.bones.length / 2));
    expect(applyPose(target, new Pose(buildRigDef('other', platformNodes())), new Uint8Array(64).fill(1))).toBe(0);
    // after invalidateSkin the next write is whole again
    pose.clearDirty();
    invalidateSkin(target);
    expect(applyPose(target, pose, pose.modelDirty)).toBe(rig.bones.length);
  });

  it('hierarchy path: writes local TRS of the dirty bones and three composes the same matrices', () => {
    const a = instanceOf(source);
    const ref = instanceOf(source);
    placeRoot(a.root, [5, 1, 5], -0.7, 0.9);
    placeRoot(ref.root, [5, 1, 5], -0.7, 0.9);
    const target = targetOf(a, rig, 'hierarchy');
    const pose = randomPose(rig, 9);
    expect(applyPose(target, pose, pose.modelDirty)).toBe(rig.bones.length);
    pose.clearDirty();
    a.root.updateMatrixWorld(true);
    poseReference(ref, pose);
    expect(boneDiff(a.bones, ref.bones)).toBe(0);
    expect(applyPose(target, pose, pose.modelDirty)).toBe(0);
    // and the direct path gives the same picture
    const d = direct(instanceOf(source));
    placeRoot(d.root, [5, 1, 5], -0.7, 0.9);
    d.root.updateWorldMatrix(true, false);
    d.mesh.updateMatrixWorld(true);
    applyPose(targetOf(d, rig), pose, new Uint8Array(rig.bones.length).fill(1));
    expect(boneDiff(d.bones, a.bones)).toBeLessThan(TOL);
  });

  it('rigOfSkin rebuilds the rig from the drawn bones: names, parents and bind matrices', () => {
    const i = instanceOf(source);
    const built = rigOfSkin({ root: i.root, bones: new Map(i.bones.map((b) => [b.name, b])), boneList: i.bones }, rig.id)!;
    expect(built.sourceNames).toEqual(rig.sourceNames);
    expect(built.bones).toEqual(rig.bones);
    expect(Array.from(built.parent)).toEqual(Array.from(rig.parent));
    expect(maxDiff(built.bindModel, rig.bindModel)).toBeLessThan(1e-6);
    expect(built.hipsRestHeight).toBeCloseTo(rig.hipsRestHeight, 6);
    expect(built.family).toBe(rig.family);
  });
});

// ── the presentation pass over the adapter: cost ───────────────────────────────────────────────────────────────────────────

describe('presentation pass cost (evaluate → FK → skin write), 35 bodies', () => {
  it('stays well inside the 1.5 ms the frame gives bridge + mixer + skeletons (docs/architecture.md §4.2)', () => {
    const rig = buildRigDef('test.platform.perf', platformNodes());
    const source = buildSource(rig, null);
    const w = motionWorld();
    const tracks = rig.bones.map((bone, i) => ({ bone, prop: 'rotation' as const, times: [0, 0.5, 1], values: [...quat(0, 0, 0), ...quat(10 + i, -8, 5), ...quat(0, 0, 0)] }));
    const clip = clipOf('test#all', 'delta', 1, tracks);
    w.registry.addFunctionClip(clip.id, clip);
    const presenter = w.motion.presenter({ skin: threeSkin });
    const bodies: Skinned[] = [];
    for (let k = 0; k < 35; k++) {
      const body = direct(instanceOf(source));
      placeRoot(body.root, [k * 2, 0, -k], 0.1 * k);
      body.root.updateWorldMatrix(true, false);
      const id = `en-${k}`;
      const { h } = w.spawn(id, { at: { x: k * 2, y: 0, z: -k } });
      expect(presenter.bind({ root: body.root, bones: new Map(body.bones.map((b) => [b.name, b])), boneList: body.bones }, { rowId: id, rig })).toBe(true);
      h.anim.loco = { clip: 'test#all', loop: 'loop', speed: 0.8 + 0.01 * k };
      bodies.push(body);
    }
    const times: number[] = [];
    for (let f = 0; f < 400; f++) {
      if (f % 2 === 0) w.tick();
      // the bridge: every body moves every frame
      for (let k = 0; k < bodies.length; k++) {
        bodies[k]!.root.position.x += 0.01;
        bodies[k]!.root.updateWorldMatrix(true, false);
      }
      const t0 = performance.now();
      presenter.update({ alpha: (f % 2) * 0.5, dt: 1 / 60, frameIndex: f, paused: false });
      times.push(performance.now() - t0);
    }
    expect(presenter.stats).toMatchObject({ rows: 35, evaluated: 35, bonesWritten: 35 * rig.bones.length });
    const sorted = times.slice(100).sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1]!;
    const best = sorted[0]!;
    const p95 = sorted[Math.floor(sorted.length * 0.95)]!;
    console.log(`presentation pass, 35 bodies × ${rig.bones.length} bones, one full-body clip each: best ${best.toFixed(3)} ms, median ${median.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms`);
    // gated on the best frame (the machine is shared with other test runs); SS_PERF_SLACK scales it
    expect(best).toBeLessThan(1.0 * Number(process.env['SS_PERF_SLACK'] ?? 1));
  });
});

// ── render's ModelInstance (R6) ────────────────────────────────────────────────────────────────────────────────────────────

describe('on render’s ModelInstance (rigMatrix normalisation, the rig container)', () => {
  let env: TestEnv;
  let template: ModelTemplate;
  let scaled: ModelTemplate;
  let gltfRig: RigDef;
  beforeAll(async () => {
    env = testEnv();
    const bytes = await fixtureGlb();
    template = buildModelTemplate(modelSourceFromGltf('fixture-a.glb', await parseGlb(bytes), FIXTURE_FACTS), env);
    // the facts say the body is 1.5× the file's height: the normalisation scales as well as rebases
    const tall = FIXTURE_FACTS.map((v) => v * 1.5) as unknown as typeof FIXTURE_FACTS;
    scaled = buildModelTemplate(modelSourceFromGltf('fixture-b.glb', await parseGlb(bytes), tall), env);
    gltfRig = rigFromGltf('fixture-a.glb', parseGlbJson(bytes).json);
  });

  it('the fixture’s normalisation is not the identity (else this block proves nothing)', () => {
    expect(template.rigMatrix.elements[13]).toBeCloseTo(-0.25, 6);
    expect(scaled.rigMatrix.elements[0]).toBeCloseTo(1.5, 5);
  });

  it('rigOfSkin on an instance equals the rig of the model file (bone space = mesh space)', () => {
    const i = new ModelInstance(template, env.look);
    const rig = rigOfSkin(i)!;
    expect(rig.id).toBe('fixture-a.glb');
    expect(rig.sourceNames).toEqual(template.boneNames);
    expect(rig.sourceNames).toEqual(gltfRig.sourceNames.slice(0, template.boneCount));
    expect(Array.from(rig.parent)).toEqual(Array.from(gltfRig.parent.subarray(0, template.boneCount)));
    expect(maxDiff(rig.bindModel, gltfRig.bindModel.subarray(0, template.boneCount * 16))).toBeLessThan(1e-6);
    // one rig per model: a second instance gets the same object
    const j = new ModelInstance(template, env.look);
    expect(rigOfSkin(j)).toBe(rig);
    i.dispose();
    j.dispose();
  });

  it.each([['rebased', () => template], ['rebased and scaled', () => scaled]])('bind pose through applyPose equals the template’s rest pose (%s)', (_n, pick) => {
    const tpl = pick();
    const a = new ModelInstance(tpl, env.look, { bonePath: 'direct' });
    const rest = new ModelInstance(tpl, env.look, { bonePath: 'direct' });
    for (const inst of [a, rest]) {
      placeRoot(inst.root, [7, 0.3, -3], 1.1, 1.2);
      inst.root.updateWorldMatrix(true, false);
    }
    rest.writeRestPose();
    const handle = bindThreeSkin(a)!;
    expect(handle.target.mode).toBe('direct');
    expect(handle.target.bones).toHaveLength(tpl.boneCount);
    const pose = new Pose(handle.rig);
    pose.updateModel();
    expect(handle.apply(pose, pose.modelDirty)).toBe(tpl.boneCount);
    expect(boneDiff(a.boneList, rest.boneList)).toBeLessThan(TOL);
    // the handle's rig world is the instance's
    expect(maxDiff(handle.rigWorld(new Float64Array(16)), a.rigWorld(new Matrix4()).elements)).toBeLessThan(1e-12);
    expect(maxDiff(rigWorldOf(handle.target, new Float64Array(16)), a.rigWorld(new Matrix4()).elements)).toBeLessThan(1e-12);
    a.dispose();
    rest.dispose();
  });

  it.each([['rebased', () => template], ['rebased and scaled', () => scaled]])('a pose on the direct path equals the hierarchy path updated by three, root moved this frame (%s)', (_n, pick) => {
    const tpl = pick();
    const scene = new Scene();
    const a = new ModelInstance(tpl, env.look, { bonePath: 'direct' });
    const tree = new ModelInstance(tpl, env.look, { bonePath: 'hierarchy' });
    scene.add(a.root);
    const rig = rigOfSkin(a)!;
    const ta = createSkinTarget(a, rig);
    const tt = createSkinTarget(tree, rig);
    expect(ta.mode).toBe('direct');
    expect(tt.mode).toBe('hierarchy');
    const pose = new Pose(rig);
    const q = new Quaternion();
    const positions = new Float32Array(tpl.arrays.position);
    for (let f = 0; f < 6; f++) {
      const at: [number, number, number] = [f * 1.5, 0.1 * f, -2 * f];
      placeRoot(a.root, at, 0.4 * f, 1 + 0.05 * f);
      a.root.updateWorldMatrix(true, false); // the bridge
      if (f % 2 === 0) randomPose(rig, 100 + f, pose); // every other frame the pose holds still
      pose.updateModel();
      applyPose(ta, pose, pose.modelDirty);
      scene.updateMatrixWorld();

      placeRoot(tree.root, at, 0.4 * f, 1 + 0.05 * f);
      applyPose(tt, pose, pose.modelDirty);
      pose.clearDirty();
      tree.root.updateMatrixWorld(true);
      expect(boneDiff(a.boneList, tree.boneList), `frame ${f}`).toBeLessThan(TOL);
      a.skeleton!.update();
      tree.skeleton!.update();
      expect(maxDiff(a.skeleton!.boneMatrices!.subarray(0, tpl.boneCount * 16), tree.skeleton!.boneMatrices!.subarray(0, tpl.boneCount * 16)), `frame ${f}: boneMatrices`).toBeLessThan(TOL);
      // the skinned vertices of the real mesh
      const { skinIndex, skinWeight, vertexCount } = tpl.arrays;
      const ma = a.skeleton!.boneMatrices!;
      const mt = tree.skeleton!.boneMatrices!;
      let worst = 0;
      for (let v = 0; v < vertexCount; v += 7) {
        const px = positions[v * 3]!, py = positions[v * 3 + 1]!, pz = positions[v * 3 + 2]!;
        for (let c = 0; c < 3; c++) {
          let da = 0, dt = 0;
          for (let k = 0; k < 4; k++) {
            const w = skinWeight![v * 4 + k]!;
            if (w === 0) continue;
            const o = skinIndex![v * 4 + k]! * 16;
            da += w * (ma[o + c]! * px + ma[o + 4 + c]! * py + ma[o + 8 + c]! * pz + ma[o + 12 + c]!);
            dt += w * (mt[o + c]! * px + mt[o + 4 + c]! * py + mt[o + 8 + c]! * pz + mt[o + 12 + c]!);
          }
          worst = Math.max(worst, Math.abs(da - dt));
        }
      }
      expect(worst, `frame ${f}: skinned vertices`).toBeLessThan(TOL);
      // a bone-attached read (render's boneWorld) follows the current root
      const pa = { x: 0, y: 0, z: 0 };
      const pt = { x: 0, y: 0, z: 0 };
      expect(a.boneWorld('RightHand', pa) && tree.boneWorld('RightHand', pt)).toBe(true);
      expect(Math.hypot(pa.x - pt.x, pa.y - pt.y, pa.z - pt.z), `frame ${f}: boneWorld`).toBeLessThan(TOL);
      void q;
    }
    a.dispose();
    tree.dispose();
  });

  it('bindThreeSkin: null for a model without bones; the body object comes from the options or root.userData.ssBody', async () => {
    const rigid = buildModelTemplate(modelSourceFromGltf('fixture-rigid.glb', await parseGlb(await fixtureGlb({ rigid: true })), FIXTURE_FACTS), env);
    const r = new ModelInstance(rigid, env.look);
    expect(bindThreeSkin(r)).toBe(null);
    expect(bindThreeSkin(null)).toBe(null);
    expect(bindThreeSkin({})).toBe(null);
    r.dispose();

    const i = new ModelInstance(template, env.look);
    const body = new Object3D();
    body.position.set(4, 5, 6);
    body.add(i.root);
    i.root.position.set(0, 0.5, 0);
    body.updateMatrixWorld(true);
    const own = bindThreeSkin(i)!;
    expect(Array.from(own.bodyWorld(new Float64Array(16)).subarray(12, 15))).toEqual([4, 5.5, 6]);
    const given = bindThreeSkin(i, { body })!;
    expect(Array.from(given.bodyWorld(new Float64Array(16)).subarray(12, 15))).toEqual([4, 5, 6]);
    i.root.userData['ssBody'] = body;
    expect(Array.from(bindThreeSkin(i)!.bodyWorld(new Float64Array(16)).subarray(12, 15))).toEqual([4, 5, 6]);
    i.dispose();
  });
});
