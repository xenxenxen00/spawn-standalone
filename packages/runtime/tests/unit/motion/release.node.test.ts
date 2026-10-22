// MA3 acceptance: after `release()` a bone read returns the final pose (docs/architecture.md X-40; docs/design/
// motion-physics-nav.md §3.8.2, §3.10), and `detach` / `setRig` keep the channel clocks across a model swap (§3.5.6).
import { describe, expect, it } from 'vitest';
import { ClipRegistry } from '../../../src/compat/motion/clip-registry.ts';
import { cookAuthoredFile } from '../../../src/compat/motion/cook-authored.ts';
import { Mixer } from '../../../src/compat/motion/mixer.ts';
import { Pose, frozenBoneMatrix } from '../../../src/compat/motion/pose.ts';
import { makeRig, quat, smallRig, tiltedRig } from './fakes/rig.ts';

const DT = 1 / 30;
const FILE = 'anim/hollow.yml';
const DIE = `${FILE}#die`;
const WALK = `${FILE}#walk`;

function registryOf(): ClipRegistry {
  const r = new ClipRegistry();
  r.addAuthored(
    FILE,
    cookAuthoredFile(FILE, {
      die: { duration: 1, tracks: { Hips: { y: [0, -0.6], pitch: [0, 85] }, Spine: { roll: [0, 25] }, Head: { yaw: [0, -40] } } },
      walk: { duration: 1, tracks: { Spine: { roll: [0, 30, 0] }, LeftLeg: { pitch: [0, 40, 0] } } },
    }),
  );
  return r;
}

const run = (m: Mixer, n: number): void => {
  for (let i = 0; i < n; i++) m.advanceTick(DT);
};

/** a corpse: the death clip resumed mid-way from a spawn-time `startTick`, presented until it rests */
function corpse() {
  const rig = tiltedRig('model.hollow');
  const m = new Mixer('corpse-1', rig, { registry: registryOf() });
  const pose = new Pose(rig);
  m.write('act', { clip: DIE, loop: 'once', startTick: 100 }, 112);
  for (let frame = 0; frame < 40; frame++) {
    run(m, 1);
    m.evaluate(pose, 0.5);
    pose.updateModel();
  }
  return { rig, m, pose };
}

describe('Mixer.release({ keepFinalPose: true }) (X-40)', () => {
  it('leaves a FrozenPose equal, bit for bit, to the last presented pose', () => {
    const { rig, m, pose } = corpse();
    expect(m.view('act')!.finished).toBe(true);
    const last = Float32Array.from(pose.model);
    const frozen = m.release({ keepFinalPose: true });
    expect(frozen).not.toBeNull();
    expect(frozen!.rigId).toBe('model.hollow');
    expect(frozen!.boneModel).toEqual(last);
    expect(frozen!.boneModel.length).toBe(16 * rig.bones.length);
    expect(m.frozen()).toBe(frozen);
    expect(m.released).toBe(true);
    // the corpse did move off its bind pose
    expect(Array.from(last)).not.toEqual(Array.from(rig.bindModel));
  });

  it('a bone read answers that bone’s final model-space matrix; an unknown bone answers null', () => {
    const { rig, m, pose } = corpse();
    const head = rig.index('Head');
    const want = Float32Array.from(pose.model.subarray(head * 16, head * 16 + 16));
    m.release({ keepFinalPose: true });
    expect(frozenBoneMatrix(m.frozen()!, 'Head')).toEqual(want);
    expect(frozenBoneMatrix(m.frozen()!, 'bp-Tail')).toBeNull();
  });

  it('includes a pose written after evaluate and not yet run through FK (the release does the FK itself)', () => {
    const rig = smallRig();
    const m = new Mixer('corpse-2', rig, { registry: registryOf() });
    const pose = new Pose(rig);
    m.write('act', { clip: DIE, loop: 'once', startTick: 0 }, 60);
    m.evaluate(pose, 0); // no updateModel() by the caller
    const frozen = m.release({ keepFinalPose: true })!;
    const check = new Pose(rig);
    check.setLocal(0, 0, 1 - 0.6, 0, ...(quat(85, 0, 0) as [number, number, number, number]), 1, 1, 1);
    check.setRotation(rig.index('Spine'), ...(quat(0, 0, 25) as [number, number, number, number]));
    check.setRotation(rig.index('Head'), ...(quat(0, -40, 0) as [number, number, number, number]));
    check.updateModel();
    for (let i = 0; i < check.model.length; i++) expect(Math.abs(frozen.boneModel[i]! - check.model[i]!)).toBeLessThan(1e-6);
  });

  it('frees the channels: later writes, ticks and evaluations change nothing, the table is empty', () => {
    const { m, pose } = corpse();
    const frozen = m.release({ keepFinalPose: true })!;
    const kept = Float32Array.from(frozen.boneModel);
    const local = { t: Float32Array.from(pose.t), r: Float32Array.from(pose.r), s: Float32Array.from(pose.s) };
    expect(m.table()).toEqual({});
    expect(m.view('act')).toBeNull();
    m.write('act', { clip: WALK }, 200);
    m.write('loco', { clip: WALK }, 200);
    run(m, 30);
    pose.clearDirty();
    m.evaluate(pose, 0.5);
    pose.updateModel();
    expect(m.table()).toEqual({});
    expect(m.fading()).toEqual([]);
    expect(Array.from(pose.dirty).every((d) => d === 0)).toBe(true);
    expect(pose.t).toEqual(local.t);
    expect(pose.r).toEqual(local.r);
    expect(pose.s).toEqual(local.s);
    expect(frozen.boneModel).toEqual(kept);
    // the frozen pose is its own copy: the pose object may be reused or dropped
    pose.setTranslation(0, 9, 9, 9);
    pose.updateModel();
    expect(m.frozen()!.boneModel).toEqual(kept);
  });

  it('keeps the pose the caller names when it evaluates more than one (a sim pose beside the presented one)', () => {
    const rig = smallRig();
    const m = new Mixer('corpse-3', rig, { registry: registryOf() });
    const presented = new Pose(rig);
    const sim = new Pose(rig);
    m.write('act', { clip: DIE, loop: 'once' }, 0);
    run(m, 12);
    m.evaluate(presented, 0.9);
    m.evaluate(sim, 0); // the last one evaluated is the sim pose
    presented.updateModel();
    sim.updateModel();
    expect(Array.from(presented.model)).not.toEqual(Array.from(sim.model));
    const frozen = m.release({ keepFinalPose: true, pose: presented })!;
    expect(frozen.boneModel).toEqual(presented.model);
    // a pose of another rig is never kept
    const other = new Mixer('corpse-4', rig, { registry: registryOf() });
    other.write('act', { clip: DIE, loop: 'once' }, 0);
    expect(other.release({ keepFinalPose: true, pose: new Pose(smallRig()) })).toBeNull();
  });

  it('a second release keeps the pose it kept; a plain release() afterwards drops it', () => {
    const { m } = corpse();
    const frozen = m.release({ keepFinalPose: true });
    expect(m.release({ keepFinalPose: true })).toBe(frozen);
    expect(m.release()).toBeNull();
    expect(m.frozen()).toBeNull();
  });
});

describe('Mixer.release() without keepFinalPose', () => {
  it('drops the pose too', () => {
    const { m } = corpse();
    expect(m.release()).toBeNull();
    expect(m.frozen()).toBeNull();
    expect(m.released).toBe(true);
    expect(m.table()).toEqual({});
  });
});

describe('nothing to keep', () => {
  it('a mixer without a rig has no final pose', () => {
    const m = new Mixer('ghost', null, { registry: registryOf() });
    m.write('act', { clip: DIE }, 0);
    run(m, 3);
    expect(m.frozen()).toBeNull();
    expect(m.release({ keepFinalPose: true })).toBeNull();
  });

  it('a mixer that was never evaluated has no final pose', () => {
    const m = new Mixer('unseen', smallRig(), { registry: registryOf() });
    m.write('act', { clip: DIE }, 0);
    run(m, 3);
    expect(m.release({ keepFinalPose: true })).toBeNull();
    expect(m.frozen()).toBeNull();
  });

  it('a pose of another rig is not this mixer’s final pose', () => {
    const m = new Mixer('swap', smallRig('model.a'), { registry: registryOf() });
    const pose = new Pose(smallRig('model.a')); // an equal rig, but not the mixer's
    m.write('act', { clip: DIE }, 0);
    m.evaluate(pose, 0);
    expect(Array.from(pose.dirty).every((d) => d === 0)).toBe(true);
    expect(m.release({ keepFinalPose: true })).toBeNull();
  });
});

describe('detach / setRig: a model swap keeps the channel clocks and rebinds (§3.5.6)', () => {
  it('rebinds every channel to the new rig by bone name, clocks untouched', () => {
    const a = smallRig('model.operator-a');
    // the new body lists its bones in another order and lacks a leg
    const b = makeRig('model.operator-b', [
      { name: 'Head', parent: 'Spine', t: [0, 0.5, 0] },
      { name: 'Spine', parent: 'Hips', t: [0, 0.4, 0] },
      { name: 'Hips', parent: null, t: [0, 1.2, 0] },
    ]);
    const m = new Mixer('player/local', a, { registry: registryOf() });
    const poseA = new Pose(a);
    m.write('walk', { clip: WALK, loop: 'loop', speed: 1.5, weight: 1, blendIn: 0.15 }, 0);
    run(m, 10); // clip time 0.5: Spine roll 30
    m.evaluate(poseA, 0);
    const q = quat(0, 0, 30);
    for (let k = 0; k < 4; k++) expect(poseA.r[a.index('Spine') * 4 + k]).toBeCloseTo(q[k]!, 6);

    m.detach();
    expect(m.rig).toBeNull();
    // still in the table, still ticking, nothing to pose
    run(m, 5);
    expect(m.view('walk')).toMatchObject({ clip: WALK, startTick: 0, duration: 1 });
    expect(m.clipTime('walk')).toBeCloseTo(0.75, 9);
    const before = Float32Array.from(poseA.r);
    m.evaluate(poseA, 0);
    expect(poseA.r).toEqual(before);

    m.setRig(b);
    expect(m.rig).toBe(b);
    expect(m.clipTime('walk')).toBeCloseTo(0.75, 9);
    expect(m.view('walk')!.startTick).toBe(0);
    const poseB = new Pose(b);
    m.evaluate(poseB, 0);
    const q2 = quat(0, 0, 15); // 0.75 s: half way back down
    for (let k = 0; k < 4; k++) expect(poseB.r[b.index('Spine') * 4 + k]).toBeCloseTo(q2[k]!, 6);
    expect(Array.from(poseB.dirty)).toEqual([0, 1, 0]);
  });

  it('setRig straight over another rig swaps without a detach', () => {
    const m = new Mixer('player/local', smallRig('model.a'), { registry: registryOf() });
    m.write('walk', { clip: WALK }, 0);
    run(m, 15);
    const b = tiltedRig('model.b');
    m.setRig(b);
    const pose = new Pose(b);
    m.evaluate(pose, 0);
    expect(pose.dirty[b.index('Spine')]).toBe(1);
    expect(m.clipTime('walk')).toBeCloseTo(0.5, 9);
  });
});
