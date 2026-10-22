// MA3: `pose.ts` (docs/design/motion-physics-nav.md §2, §3.8.2, §3.10): local TRS per bone, FK to model-space matrices, dirty
// masks. The goldens are worked out by hand in the comments; the rig-inspect goldens of the live rigs belong to MA2 / MA4.
import { describe, expect, it } from 'vitest';
import { Pose, boneOrder, freezePose, frozenBoneMatrix } from '../../../src/compat/motion/pose.ts';
import { m4ComposeTRS, m4Mul } from '../../../src/compat/motion/quat.ts';
import { makeRig, quat, smallRig, tiltedRig } from './fakes/rig.ts';

/** Hips (0,1,0) turned 90° about Z; Spine 0.5 up its parent's Y; Arm 0.2 along Spine's X, turned 90° about Y, scale 2 */
const chain = () =>
  makeRig('test.chain', [
    { name: 'Hips', parent: null, t: [0, 1, 0], rDeg: [0, 0, 90] },
    { name: 'Spine', parent: 'Hips', t: [0, 0.5, 0] },
    { name: 'Arm', parent: 'Spine', t: [0.2, 0, 0], rDeg: [0, 90, 0], s: [2, 2, 2] },
  ]);

const mat = (pose: Pose, bone: string): number[] => {
  const b = pose.rig.index(bone);
  return Array.from(pose.model.subarray(b * 16, b * 16 + 16));
};

function expectMat(got: ArrayLike<number>, want: readonly number[], eps = 1e-5): void {
  expect(got.length).toBe(want.length);
  for (let i = 0; i < want.length; i++) expect(Math.abs(got[i]! - want[i]!), `element ${i}: ${got[i]} vs ${want[i]}`).toBeLessThan(eps);
}

describe('Pose: FK to model-space matrices', () => {
  it('starts at the bind pose and its FK equals hand-computed matrices (column-major)', () => {
    const pose = new Pose(chain());
    pose.updateModel();
    // Rz(90): x → +y, y → −x
    expectMat(mat(pose, 'Hips'), [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, 0, 1, 0, 1]);
    // same rotation; origin = Rz90·(0, 0.5, 0) + (0, 1, 0) = (−0.5, 1, 0)
    expectMat(mat(pose, 'Spine'), [0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1, 0, -0.5, 1, 0, 1]);
    // local axes 2·Ry(90) = (0,0,−2), (0,2,0), (2,0,0), each turned by Rz90; origin = Rz90·(0.2,0,0) + (−0.5,1,0) = (−0.5, 1.2, 0)
    expectMat(mat(pose, 'Arm'), [0, 0, -2, 0, -2, 0, 0, 0, 0, 2, 0, 0, -0.5, 1.2, 0, 1]);
  });

  it('follows local writes: a parent rotation carries its children', () => {
    const pose = new Pose(chain());
    const [x, y, z, w] = quat(90, 0, 0);
    pose.setRotation(pose.rig.index('Spine'), x!, y!, z!, w!);
    pose.updateModel();
    // Rz90·Rx90 maps (x, y, z) → (z, x, y)
    expectMat(mat(pose, 'Spine'), [0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, -0.5, 1, 0, 1]);
    expectMat(mat(pose, 'Arm'), [-2, 0, 0, 0, 0, 0, 2, 0, 0, 2, 0, 0, -0.5, 1.2, 0, 1]);
    pose.setTranslation(pose.rig.index('Hips'), 1, 1, 0);
    pose.updateModel();
    expectMat(mat(pose, 'Arm'), [-2, 0, 0, 0, 0, 0, 2, 0, 0, 2, 0, 0, 0.5, 1.2, 0, 1]);
  });

  it('equals the rig’s own bind matrices at bind, and a plain matrix product for a posed rig', () => {
    for (const rig of [smallRig(), tiltedRig(), chain()]) {
      const pose = new Pose(rig);
      pose.updateModel();
      expectMat(pose.model, Array.from(rig.bindModel), 1e-6);
    }
    const rig = tiltedRig();
    const pose = new Pose(rig);
    const head = rig.index('Head');
    const spine = rig.index('Spine');
    const q = quat(15, -40, 70);
    pose.setLocal(spine, 0.3, 0.1, -0.2, q[0]!, q[1]!, q[2]!, q[3]!, 1, 1.5, 0.5);
    pose.updateModel();
    const m = new Float64Array(16);
    const local = new Float64Array(16);
    const hipsLocal = new Float64Array(16);
    m4ComposeTRS(hipsLocal, 0, rig.bindT, 0, rig.bindR, 0, rig.bindS, 0);
    m4ComposeTRS(local, 0, pose.t, spine * 3, pose.r, spine * 4, pose.s, spine * 3);
    m4Mul(m, 0, hipsLocal, 0, local, 0);
    m4ComposeTRS(local, 0, rig.bindT, head * 3, rig.bindR, head * 4, rig.bindS, head * 3);
    m4Mul(m, 0, m, 0, local, 0);
    expectMat(mat(pose, 'Head'), Array.from(m));
  });

  it('does not need parents before children in the bone order', () => {
    // a skin may list a child joint first (the joint order of a glTF skin is not topological)
    const rig = makeRig('test.reversed', [
      { name: 'Arm', parent: 'Spine', t: [0.2, 0, 0], rDeg: [0, 90, 0], s: [2, 2, 2] },
      { name: 'Spine', parent: 'Hips', t: [0, 0.5, 0] },
      { name: 'Hips', parent: null, t: [0, 1, 0], rDeg: [0, 0, 90] },
    ]);
    expect(Array.from(boneOrder(rig))).toEqual([2, 1, 0]);
    const pose = new Pose(rig);
    pose.updateModel();
    expectMat(mat(pose, 'Arm'), [0, 0, -2, 0, -2, 0, 0, 0, 0, 2, 0, 0, -0.5, 1.2, 0, 1]);
    pose.setTranslation(rig.index('Hips'), 1, 1, 0);
    pose.updateModel();
    expectMat(mat(pose, 'Arm'), [0, 0, -2, 0, -2, 0, 0, 0, 0, 2, 0, 0, 0.5, 1.2, 0, 1]);
  });

  it('keeps the matrix above a root bone (an armature node) in model space', () => {
    // the node above Hips lifts the whole skeleton by 2 m: bindModel carries it, the local bind TRS does not
    const above = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 2, 0, 1];
    const rig = makeRig(
      'test.armature',
      [
        { name: 'Hips', parent: null, t: [0, 1, 0] },
        { name: 'Spine', parent: 'Hips', t: [0, 0.5, 0] },
      ],
      { above: { Hips: above } },
    );
    const pose = new Pose(rig);
    pose.updateModel();
    expectMat(mat(pose, 'Hips'), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 3, 0, 1]);
    pose.setTranslation(0, 0.5, 1, 0);
    pose.updateModel();
    expectMat(mat(pose, 'Spine'), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5, 3.5, 0, 1]);
  });
});

describe('Pose: dirty masks', () => {
  it('marks only the bones whose local transform changed; model matrices also change below them', () => {
    const rig = smallRig();
    const pose = new Pose(rig);
    pose.updateModel();
    pose.clearDirty();
    expect(Array.from(pose.dirty)).toEqual([0, 0, 0, 0, 0]);
    expect(Array.from(pose.modelDirty)).toEqual([0, 0, 0, 0, 0]);

    const spine = rig.index('Spine');
    const [x, y, z, w] = quat(0, 0, 30);
    expect(pose.setRotation(spine, x!, y!, z!, w!)).toBe(true);
    expect(Array.from(pose.dirty)).toEqual([0, 1, 0, 0, 0]);
    expect(pose.updateModel()).toBe(2); // Spine and its child Head
    expect(Array.from(pose.modelDirty)).toEqual([0, 1, 1, 0, 0]);
    // the legs hang off Hips: untouched
    expect(Array.from(pose.model.subarray(rig.index('LeftLeg') * 16, rig.index('LeftLeg') * 16 + 16))).toEqual(
      Array.from(rig.bindModel.subarray(rig.index('LeftLeg') * 16, rig.index('LeftLeg') * 16 + 16)),
    );
  });

  it('a write of the value a bone already has marks nothing (a clip held on its last frame changes no bone)', () => {
    const rig = smallRig();
    const pose = new Pose(rig);
    pose.updateModel();
    pose.clearDirty();
    const head = rig.index('Head');
    expect(pose.setTranslation(head, 0, 0.4, 0)).toBe(false);
    expect(pose.setRotation(head, 0, 0, 0, 1)).toBe(false);
    expect(pose.setScale(head, 1, 1, 1)).toBe(false);
    expect(pose.setLocal(head, 0, 0.4, 0, 0, 0, 0, 1, 1, 1, 1)).toBe(false);
    expect(Array.from(pose.dirty)).toEqual([0, 0, 0, 0, 0]);
    expect(pose.updateModel()).toBe(0);
    expect(pose.setLocal(head, 0, 0.4, 0, 0, 0, 0, 1, 1, 1, 1.5)).toBe(true);
    expect(Array.from(pose.dirty)).toEqual([0, 0, 1, 0, 0]);
  });

  it('touch() marks a bone written straight into the arrays (IK), reset() returns to bind', () => {
    const rig = smallRig();
    const pose = new Pose(rig);
    pose.updateModel();
    pose.clearDirty();
    const leg = rig.index('LeftLeg');
    pose.t[leg * 3 + 1] = -0.7;
    pose.touch(leg);
    expect(pose.dirty[leg]).toBe(1);
    pose.updateModel();
    expect(pose.model[leg * 16 + 13]).toBeCloseTo(0.3, 6);
    pose.clearDirty();
    pose.reset();
    expect(pose.dirty[leg]).toBe(1);
    expect(pose.dirty[rig.index('Head')]).toBe(0); // it never left bind
    pose.updateModel();
    expectMat(pose.model, Array.from(rig.bindModel), 1e-6);
  });

  it('clearDirty leaves the pending FK alone: a write before clearDirty still reaches the matrices', () => {
    const pose = new Pose(smallRig());
    pose.setTranslation(0, 0, 2, 0);
    pose.clearDirty();
    pose.updateModel();
    expect(pose.model[13]).toBe(2);
    expect(pose.modelDirty[0]).toBe(1);
  });
});

describe('FrozenPose (X-40)', () => {
  it('is a copy of the model-space matrices; a bone read answers its matrix, an unknown bone null', () => {
    const rig = chain();
    const pose = new Pose(rig);
    pose.setTranslation(0, 1, 1, 0);
    const frozen = freezePose(pose);
    expect(frozen.rigId).toBe('test.chain');
    expect(frozen.boneModel.length).toBe(16 * 3);
    expectMat(frozenBoneMatrix(frozen, 'Arm')!, [0, 0, -2, 0, -2, 0, 0, 0, 0, 2, 0, 0, 0.5, 1.2, 0, 1]);
    expect(frozenBoneMatrix(frozen, 'Tail')).toBeNull();
    // the pose moves on, the frozen copy does not
    pose.setTranslation(0, 5, 5, 5);
    pose.updateModel();
    expectMat(frozenBoneMatrix(frozen, 'Arm')!, [0, 0, -2, 0, -2, 0, 0, 0, 0, 2, 0, 0, 0.5, 1.2, 0, 1]);
  });
});
