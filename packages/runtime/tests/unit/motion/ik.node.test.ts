// MA4: IK (docs/design/motion-physics-nav.md §3.7, §10.1 `ik.test`: reach, clamp, weight ramps; docs/architecture.md X-13).
// The solver on hand-built rigs, and the `ik` handle property through the real row store: every assignment arrives inside the
// writer's stack, a world target becomes a body-local point at the write, and a frame re-projects it with the transform the
// body is drawn at.
import { describe, expect, it } from 'vitest';
import { eulerYXZToQuat } from '../../../src/compat/core/store/transform.ts';
import { IK_DEFAULTS } from '../../../src/compat/motion/constants.ts';
import { IK_CHAINS, createIkChannels, ikBonesOf, solveTwoBone, type IkFrame } from '../../../src/compat/motion/ik.ts';
import { Pose, type PoseRig } from '../../../src/compat/motion/pose.ts';
import { m4ComposeTRS, m4Mul, qFromEulerXYZDeg } from '../../../src/compat/motion/quat.ts';
import { storeFixture } from '../core/store-fixture.ts';
import { makeRig } from './fakes/rig.ts';

const DT = 1 / 30;

/** two arms and two legs on a spine; upper arm 0.30 m, forearm 0.25 m, thigh 0.45 m, shin 0.42 m; arms along ±x at bind */
function bodyRig(id = 'test.ik', hips: { rDeg?: readonly [number, number, number]; s?: readonly [number, number, number] } = {}): PoseRig {
  return makeRig(id, [
    { name: 'Hips', parent: null, t: [0, 0.95, 0], ...hips },
    { name: 'Spine', parent: 'Hips', t: [0, 0.45, 0] },
    { name: 'LeftArm', parent: 'Spine', t: [0.2, 0, 0], rDeg: [0, 0, 10] },
    { name: 'LeftForeArm', parent: 'LeftArm', t: [0.3, 0, 0], rDeg: [12, -20, 0] },
    { name: 'LeftHand', parent: 'LeftForeArm', t: [0.25, 0, 0], rDeg: [5, 6, 7] },
    { name: 'RightArm', parent: 'Spine', t: [-0.2, 0, 0], rDeg: [0, 0, -10] },
    { name: 'RightForeArm', parent: 'RightArm', t: [-0.3, 0, 0], rDeg: [12, 20, 0] },
    { name: 'RightHand', parent: 'RightForeArm', t: [-0.25, 0, 0] },
    { name: 'LeftUpLeg', parent: 'Hips', t: [0.1, -0.05, 0], rDeg: [-8, 0, 0] },
    { name: 'LeftLeg', parent: 'LeftUpLeg', t: [0, -0.45, 0], rDeg: [16, 0, 0] },
    { name: 'LeftFoot', parent: 'LeftLeg', t: [0, -0.42, 0] },
    { name: 'RightUpLeg', parent: 'Hips', t: [-0.1, -0.05, 0], rDeg: [-8, 0, 0] },
    { name: 'RightLeg', parent: 'RightUpLeg', t: [0, -0.45, 0], rDeg: [16, 0, 0] },
    { name: 'RightFoot', parent: 'RightLeg', t: [0, -0.42, 0] },
  ]);
}

const A = 0.3;
const B = 0.25;

function posOf(pose: Pose, bone: string): [number, number, number] {
  pose.updateModel();
  const b = pose.rig.index(bone);
  return [pose.model[b * 16 + 12]!, pose.model[b * 16 + 13]!, pose.model[b * 16 + 14]!];
}
const dist = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
const sub = (a: readonly number[], b: readonly number[]): [number, number, number] => [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
const dot = (a: readonly number[], b: readonly number[]): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
const perpTo = (v: readonly number[], d: readonly number[]): [number, number, number] => {
  const l = Math.hypot(d[0]!, d[1]!, d[2]!);
  const u = [d[0]! / l, d[1]! / l, d[2]! / l];
  const k = dot(v, u);
  return [v[0]! - u[0]! * k, v[1]! - u[1]! * k, v[2]! - u[2]! * k];
};

function solveLeft(pose: Pose, target: readonly number[], weight = 1): void {
  const rig = pose.rig;
  solveTwoBone(pose, rig, rig.index('LeftArm'), rig.index('LeftForeArm'), rig.index('LeftHand'), target, weight);
}

describe('solveTwoBone: reach', () => {
  it('puts the hand on a reachable target within 1 mm and keeps both segment lengths', () => {
    const rig = bodyRig();
    for (const target of [
      [0.45, 1.3, 0.25],
      [0.3, 1.1, -0.3],
      [0.5, 1.7, 0.1],
      [0.25, 1.45, 0.4],
    ]) {
      const pose = new Pose(rig);
      const handRot = Array.from(pose.r.subarray(rig.index('LeftHand') * 4, rig.index('LeftHand') * 4 + 4));
      solveLeft(pose, target);
      expect(dist(posOf(pose, 'LeftHand'), target), `target ${target.join(',')}`).toBeLessThan(1e-3);
      expect(dist(posOf(pose, 'LeftArm'), posOf(pose, 'LeftForeArm'))).toBeCloseTo(A, 5);
      expect(dist(posOf(pose, 'LeftForeArm'), posOf(pose, 'LeftHand'))).toBeCloseTo(B, 5);
      // the hand keeps its animated local rotation; the shoulder does not move
      expect(Array.from(pose.r.subarray(rig.index('LeftHand') * 4, rig.index('LeftHand') * 4 + 4))).toEqual(handRot);
      expect(dist(posOf(pose, 'LeftArm'), posOf(new Pose(rig), 'LeftArm'))).toBeLessThan(1e-6);
    }
  });

  it('solves under a turned and scaled ancestor (lengths come from the current pose)', () => {
    const rig = bodyRig('test.ik.scaled', { rDeg: [10, 35, -15], s: [1.4, 1.4, 1.4] });
    const pose = new Pose(rig);
    const a = dist(posOf(pose, 'LeftArm'), posOf(pose, 'LeftForeArm'));
    const b = dist(posOf(pose, 'LeftForeArm'), posOf(pose, 'LeftHand'));
    expect(a).toBeCloseTo(A * 1.4, 4);
    const shoulder = posOf(pose, 'LeftArm');
    const target = [shoulder[0] + 0.3, shoulder[1] - 0.25, shoulder[2] + 0.3];
    solveLeft(pose, target);
    expect(dist(posOf(pose, 'LeftHand'), target)).toBeLessThan(1e-3);
    expect(dist(posOf(pose, 'LeftArm'), posOf(pose, 'LeftForeArm'))).toBeCloseTo(a, 4);
    expect(dist(posOf(pose, 'LeftForeArm'), posOf(pose, 'LeftHand'))).toBeCloseTo(b, 4);
  });

  it('the right chain mirrors the left one', () => {
    const rig = bodyRig();
    const pose = new Pose(rig);
    const target = [-0.4, 1.25, 0.3];
    solveTwoBone(pose, rig, rig.index('RightArm'), rig.index('RightForeArm'), rig.index('RightHand'), target, 1);
    expect(dist(posOf(pose, 'RightHand'), target)).toBeLessThan(1e-3);
  });
});

describe('solveTwoBone: clamp', () => {
  it('a target beyond reach stretches the arm to a + b − 1 mm, on the line to the target', () => {
    const rig = bodyRig();
    const pose = new Pose(rig);
    const shoulder = posOf(pose, 'LeftArm');
    const target = [shoulder[0] + 2, shoulder[1] + 1, shoulder[2] - 1.5];
    solveLeft(pose, target);
    const hand = posOf(pose, 'LeftHand');
    expect(dist(hand, shoulder)).toBeCloseTo(A + B - IK_DEFAULTS.reachClamp, 5);
    const dir = sub(target, shoulder);
    expect(Math.hypot(...perpTo(sub(hand, shoulder), dir))).toBeLessThan(1e-4);
    expect(dot(sub(hand, shoulder), dir)).toBeGreaterThan(0);
  });

  it('a target closer than |a − b| folds the arm to |a − b| + 1 mm', () => {
    const rig = bodyRig();
    const pose = new Pose(rig);
    const shoulder = posOf(pose, 'LeftArm');
    const target = [shoulder[0] + 0.004, shoulder[1] - 0.003, shoulder[2] + 0.002];
    solveLeft(pose, target);
    const hand = posOf(pose, 'LeftHand');
    expect(dist(hand, shoulder)).toBeCloseTo(Math.abs(A - B) + IK_DEFAULTS.reachClamp, 5);
    expect(Math.hypot(...perpTo(sub(hand, shoulder), sub(target, shoulder)))).toBeLessThan(1e-4);
  });
});

describe('solveTwoBone: weight', () => {
  it('weight 0 leaves the clip pose bit-identical and marks nothing', () => {
    const rig = bodyRig();
    const pose = new Pose(rig);
    pose.updateModel();
    pose.clearDirty();
    const before = { t: Float32Array.from(pose.t), r: Float32Array.from(pose.r), s: Float32Array.from(pose.s), model: Float32Array.from(pose.model) };
    solveLeft(pose, [0.4, 1.2, 0.3], 0);
    solveLeft(pose, [0.4, 1.2, 0.3], -1);
    solveLeft(pose, [0.4, 1.2, 0.3], Number.NaN);
    pose.updateModel();
    expect(pose.t).toEqual(before.t);
    expect(pose.r).toEqual(before.r);
    expect(pose.s).toEqual(before.s);
    expect(pose.model).toEqual(before.model);
    expect(Array.from(pose.dirty).every((d) => d === 0)).toBe(true);
  });

  it('a partial weight moves the hand part of the way, monotonically', () => {
    const rig = bodyRig();
    const target = [0.35, 1.15, 0.3];
    const start = posOf(new Pose(rig), 'LeftHand');
    let last = dist(start, target);
    for (const w of [0.25, 0.5, 0.75, 1]) {
      const pose = new Pose(rig);
      solveLeft(pose, target, w);
      const d = dist(posOf(pose, 'LeftHand'), target);
      expect(d, `weight ${w}`).toBeLessThan(last);
      last = d;
      // only the two chain bones changed
      const touched = Array.from(pose.dirty).flatMap((v, i) => (v ? [rig.bones[i]] : []));
      expect(touched.sort()).toEqual(['LeftArm', 'LeftForeArm']);
    }
    expect(last).toBeLessThan(1e-3);
  });
});

describe('solveTwoBone: the pole is the animated elbow', () => {
  it('keeps the elbow on the side the clip puts it, for targets all around', () => {
    const rig = bodyRig();
    for (let i = 0; i < 24; i++) {
      const pose = new Pose(rig);
      const shoulder = posOf(pose, 'LeftArm');
      const elbow = posOf(pose, 'LeftForeArm');
      const a = (i / 24) * Math.PI * 2;
      const target = [shoulder[0] + 0.25 + 0.15 * Math.cos(a), shoulder[1] + 0.2 * Math.sin(a), shoulder[2] + 0.2 * Math.cos(a * 2)];
      const dir = sub(target, shoulder);
      const animatedSide = perpTo(sub(elbow, shoulder), dir);
      solveLeft(pose, target);
      const solvedSide = perpTo(sub(posOf(pose, 'LeftForeArm'), shoulder), dir);
      expect(dist(posOf(pose, 'LeftHand'), target)).toBeLessThan(1e-3);
      if (Math.hypot(...animatedSide) > 1e-3 && Math.hypot(...solvedSide) > 1e-3) {
        const cos = dot(animatedSide, solvedSide) / (Math.hypot(...animatedSide) * Math.hypot(...solvedSide));
        expect(cos, `target ${i}`).toBeGreaterThan(0.999);
      }
    }
  });

  it('a small move of the target moves the elbow a little (no flip)', () => {
    const rig = bodyRig();
    let prev: number[] | null = null;
    for (let i = 0; i <= 40; i++) {
      const pose = new Pose(rig);
      const target = [0.3 + 0.004 * i, 1.2 + 0.003 * i, 0.3 - 0.01 * i];
      solveLeft(pose, target);
      const elbow = posOf(pose, 'LeftForeArm');
      if (prev) expect(dist(elbow, prev), `step ${i}`).toBeLessThan(0.03);
      prev = elbow;
    }
  });
});

describe('solveTwoBone: degenerate input', () => {
  const finiteAll = (pose: Pose): boolean => {
    pose.updateModel();
    return [pose.t, pose.r, pose.s, pose.model].every((a) => a.every((v) => Number.isFinite(v)));
  };

  it('never produces NaN: target at the shoulder, at the elbow, at the hand, on the chain line', () => {
    const rig = bodyRig();
    const base = new Pose(rig);
    const shoulder = posOf(base, 'LeftArm');
    const elbow = posOf(base, 'LeftForeArm');
    const hand = posOf(base, 'LeftHand');
    const along = sub(elbow, shoulder);
    for (const target of [shoulder, elbow, hand, [shoulder[0] + along[0] * 1.5, shoulder[1] + along[1] * 1.5, shoulder[2] + along[2] * 1.5], [shoulder[0] - along[0], shoulder[1] - along[1], shoulder[2] - along[2]]]) {
      const pose = new Pose(rig);
      solveLeft(pose, target);
      expect(finiteAll(pose), `target ${target.join(',')}`).toBe(true);
      expect(dist(posOf(pose, 'LeftArm'), posOf(pose, 'LeftForeArm'))).toBeCloseTo(A, 5);
      // unit rotations
      for (const bone of ['LeftArm', 'LeftForeArm']) {
        const b = rig.index(bone) * 4;
        expect(Math.hypot(pose.r[b]!, pose.r[b + 1]!, pose.r[b + 2]!, pose.r[b + 3]!)).toBeCloseTo(1, 5);
      }
    }
  });

  it('a perfectly straight chain aimed along its own line still solves', () => {
    const rig = makeRig('test.straight', [
      { name: 'LeftArm', parent: null, t: [0, 1, 0] },
      { name: 'LeftForeArm', parent: 'LeftArm', t: [0.3, 0, 0] },
      { name: 'LeftHand', parent: 'LeftForeArm', t: [0.25, 0, 0] },
    ]);
    const pose = new Pose(rig);
    solveTwoBone(pose, rig, 0, 1, 2, [0.4, 1, 0], 1);
    expect(finiteAll(pose)).toBe(true);
    expect(dist(posOf(pose, 'LeftHand'), [0.4, 1, 0])).toBeLessThan(1e-3);
    // and with the target at the shoulder
    const p2 = new Pose(rig);
    solveTwoBone(p2, rig, 0, 1, 2, [0, 1, 0], 1);
    expect(finiteAll(p2)).toBe(true);
    expect(dist(posOf(p2, 'LeftHand'), [0, 1, 0])).toBeCloseTo(0.05 + IK_DEFAULTS.reachClamp, 5);
  });

  it('ignores a non-finite target, a missing bone and a pose of another rig', () => {
    const rig = bodyRig();
    const pose = new Pose(rig);
    const r = Float32Array.from(pose.r);
    solveLeft(pose, [Number.NaN, 1, 0]);
    solveLeft(pose, [0, Number.POSITIVE_INFINITY, 0]);
    solveTwoBone(pose, rig, -1, 3, 4, [0.3, 1.2, 0.2], 1);
    solveTwoBone(pose, bodyRig('other'), 2, 3, 4, [0.3, 1.2, 0.2], 1);
    expect(pose.r).toEqual(r);
  });
});

// ── the `ik` handle property ─────────────────────────────────────────────────────────────────────────────────────────────

function setup(opts: { isSimulated?: (place: string | null) => boolean } = {}) {
  const f = storeFixture();
  const ik = createIkChannels({ rows: f.store, ...opts });
  const off = ik.register(f.store.channels);
  const tick = (n = 1): void => {
    for (let i = 0; i < n; i++) ik.advanceTick(DT);
  };
  const body = (id: string, at: { x: number; y: number; z: number }, yaw: number, extra: Record<string, unknown> = {}) => {
    const row = f.add({ id, transform: { pos: at, rot: eulerYXZToQuat(yaw, 0, 0) }, ...extra });
    return { row, h: f.store.handle(row, 'platform') as Record<string, any> };
  };
  return { f, ik, off, tick, body };
}

/** scripts/bots/runtime.js:464-471 */
function localToWorld(feet: { x: number; y: number; z: number }, yaw: number, p: { x: number; y: number; z: number }) {
  const r = (yaw * Math.PI) / 180;
  const s = Math.sin(r);
  const c = Math.cos(r);
  const fwd = -p.z;
  return { x: feet.x + c * p.x + -s * fwd, y: feet.y + p.y, z: feet.z + -s * p.x + -c * fwd };
}

/** the world matrix of a body at `feet` facing `yaw` degrees */
function bodyMatrix(feet: { x: number; y: number; z: number }, yaw: number, scale = 1): Float64Array {
  const q = eulerYXZToQuat(yaw, 0, 0);
  return m4ComposeTRS(new Float64Array(16), 0, [feet.x, feet.y, feet.z], 0, [q.x, q.y, q.z, q.w], 0, [scale, scale, scale], 0);
}

const frameOf = (body: Float64Array, alpha = 0, normalisation?: Float64Array): IkFrame => ({
  bodyWorld: body,
  modelToWorld: normalisation ? m4Mul(new Float64Array(16), 0, body, 0, normalisation, 0) : body,
  alpha,
});

function worldOf(pose: Pose, bone: string, modelToWorld: ArrayLike<number>): [number, number, number] {
  const p = posOf(pose, bone);
  const m = modelToWorld;
  return [m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!, m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!, m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!];
}

describe('the ik channel (X-13)', () => {
  it('is an everyWrite + sync channel on `ik` that leaves the reads to the store', () => {
    const s = setup();
    expect(s.ik.channel).toMatchObject({ field: 'ik', everyWrite: true, sync: true });
    expect(s.ik.channel.read).toBe(undefined);
    expect(s.f.store.channels.hasEveryWrite('ik')).toBe(true);
    s.off();
    expect(s.f.store.channels.hasEveryWrite('ik')).toBe(false);
  });

  it('a write arrives inside the writer’s stack, equal or not, and reads back as a snapshot', () => {
    const s = setup();
    const { h } = s.body('bot-1', { x: 3, y: 0, z: -2 }, 40);
    expect(s.ik.active('bot-1')).toBe(false);
    const grip = localToWorld({ x: 3, y: 0, z: -2 }, 40, { x: 0.15, y: 1.25, z: -0.35 });
    h.ik.rightArm = { target: grip, weight: 1, blendIn: 0.12 };
    expect(s.ik.active('bot-1')).toBe(true);
    expect(h.ik.rightArm).toEqual({ target: grip, weight: 1, blendIn: 0.12 });
    const read = h.ik.rightArm;
    read.weight = 0.2; // a snapshot: mutating it writes nothing
    expect(h.ik.rightArm.weight).toBe(1);
    // the same statement again still reaches the channel (it re-bases the target on the body as it stands now)
    s.tick(4);
    expect(s.ik.weight('bot-1', 'rightArm')).toBe(1);
    h.feetPosition = { x: 4, y: 0, z: -2 };
    h.ik.rightArm = { target: grip, weight: 1, blendIn: 0.12 };
    const local = s.ik.localTarget('bot-1', 'rightArm')!;
    expect(Math.hypot(local[0] - 0.15, local[1] - 1.25, local[2] + 0.35)).toBeGreaterThan(0.5);
  });

  it('converts a world target into the body-local frame of the write (the inverse of the script’s localToWorld)', () => {
    const s = setup();
    const feet = { x: -12.5, y: 2.25, z: 30 };
    const { h } = s.body('bot-1', feet, 137);
    const rh = { x: 0.16, y: 1.22, z: -0.31 };
    const lh = { x: -0.07, y: 1.27, z: -0.52 };
    h.ik.rightArm = { target: localToWorld(feet, 137, rh), weight: 1, blendIn: 0.12 };
    h.ik.leftArm = { target: localToWorld(feet, 137, lh), weight: 1, blendIn: 0.12 };
    const r = s.ik.localTarget('bot-1', 'rightArm')!;
    const l = s.ik.localTarget('bot-1', 'leftArm')!;
    expect(Math.hypot(r[0] - rh.x, r[1] - rh.y, r[2] - rh.z)).toBeLessThan(1e-9);
    expect(Math.hypot(l[0] - lh.x, l[1] - lh.y, l[2] - lh.z)).toBeLessThan(1e-9);
  });

  it('ramps in over blendIn on sim time, presented at the frame’s alpha', () => {
    const s = setup();
    const { h } = s.body('bot-1', { x: 0, y: 0, z: 0 }, 0);
    h.ik.rightArm = { target: { x: 0.2, y: 1.2, z: -0.3 }, weight: 1, blendIn: 0.12 };
    expect(s.ik.weight('bot-1', 'rightArm')).toBe(0);
    expect(s.ik.weight('bot-1', 'rightArm', 0.5)).toBeCloseTo(0.5 * DT / 0.12, 9);
    s.tick();
    expect(s.ik.weight('bot-1', 'rightArm')).toBeCloseTo(DT / 0.12, 9);
    s.tick(2);
    expect(s.ik.weight('bot-1', 'rightArm')).toBeCloseTo((3 * DT) / 0.12, 9);
    expect(s.ik.weight('bot-1', 'rightArm', 1)).toBe(1);
    s.tick();
    expect(s.ik.weight('bot-1', 'rightArm')).toBe(1);
    // weight below 1 and no blendIn: at once
    h.ik.leftArm = { target: { x: -0.2, y: 1.2, z: -0.3 }, weight: 0.4 };
    expect(s.ik.weight('bot-1', 'leftArm')).toBe(0.4);
  });

  it('a rewrite while ramping to the same weight moves the target and keeps the ramp (bots rewrite at 30 Hz)', () => {
    const s = setup();
    const { h } = s.body('bot-1', { x: 0, y: 0, z: 0 }, 0);
    for (let t = 0; t < 4; t++) {
      h.ik.rightArm = { target: { x: 0.2 + 0.02 * t, y: 1.2, z: -0.3 }, weight: 1, blendIn: 0.12 };
      expect(s.ik.weight('bot-1', 'rightArm')).toBeCloseTo(Math.min(1, (t * DT) / 0.12), 9);
      s.tick();
    }
    expect(s.ik.weight('bot-1', 'rightArm')).toBe(1);
    expect(s.ik.localTarget('bot-1', 'rightArm')![0]).toBeCloseTo(0.26, 9);
  });

  it('null fades out over 0.12 s (the default blendOut) and then the chain is gone', () => {
    const s = setup();
    const { h } = s.body('bot-1', { x: 0, y: 0, z: 0 }, 0);
    h.ik.rightArm = { target: { x: 0.2, y: 1.2, z: -0.3 }, weight: 1 };
    expect(s.ik.weight('bot-1', 'rightArm')).toBe(1);
    h.ik.rightArm = null;
    expect(IK_DEFAULTS.blendOut).toBe(0.12);
    expect(s.ik.weight('bot-1', 'rightArm')).toBe(1);
    s.tick();
    expect(s.ik.weight('bot-1', 'rightArm')).toBeCloseTo(1 - DT / 0.12, 9);
    expect(s.ik.weight('bot-1', 'rightArm', 0.5)).toBeCloseTo(1 - (1.5 * DT) / 0.12, 9);
    s.tick(2);
    expect(s.ik.weight('bot-1', 'rightArm')).toBeCloseTo(1 - (3 * DT) / 0.12, 9);
    expect(s.ik.active('bot-1')).toBe(true);
    s.tick();
    expect(s.ik.weight('bot-1', 'rightArm')).toBe(0);
    s.tick();
    expect(s.ik.active('bot-1')).toBe(false);
    // a second null, and a null on a body that never had IK (dropHeld, scripts/bots/runtime.js:452-453), do nothing
    h.ik.rightArm = null;
    h.ik.leftArm = null;
    expect(s.ik.active('bot-1')).toBe(false);
    // an explicit blendOut of the write is used
    h.ik.rightArm = { target: { x: 0.2, y: 1.2, z: -0.3 }, blendOut: 0.3 };
    h.ik.rightArm = null;
    s.tick(3);
    expect(s.ik.weight('bot-1', 'rightArm')).toBeCloseTo(1 - (3 * DT) / 0.3, 9);
  });

  it('a write during the fade-out ramps back up from where the fade stands', () => {
    const s = setup();
    const { h } = s.body('bot-1', { x: 0, y: 0, z: 0 }, 0);
    h.ik.rightArm = { target: { x: 0.2, y: 1.2, z: -0.3 }, weight: 1 };
    h.ik.rightArm = null;
    s.tick(2);
    const w = s.ik.weight('bot-1', 'rightArm');
    expect(w).toBeCloseTo(1 - (2 * DT) / 0.12, 9);
    h.ik.rightArm = { target: { x: 0.2, y: 1.2, z: -0.3 }, weight: 1, blendIn: 0.12 };
    expect(s.ik.weight('bot-1', 'rightArm')).toBeCloseTo(w, 9);
    s.tick();
    expect(s.ik.weight('bot-1', 'rightArm')).toBeCloseTo(w + ((1 - w) * DT) / 0.12, 9);
  });

  it('a whole-bag write clears the chains it leaves out and does not re-base the ones it repeats', () => {
    const s = setup();
    const { h } = s.body('p', { x: 0, y: 0, z: 0 }, 0);
    h.ik.rightArm = { target: { x: 0.2, y: 1.2, z: -0.3 }, weight: 1 };
    h.ik.leftArm = { target: { x: -0.2, y: 1.2, z: -0.3 }, weight: 1 };
    h.feetPosition = { x: 5, y: 0, z: 0 };
    h.ik = { rightArm: { target: { x: 0.2, y: 1.2, z: -0.3 }, weight: 1 }, feet: true }; // humanoid-locomotion.js:172
    expect(s.ik.localTarget('p', 'rightArm')![0]).toBeCloseTo(0.2, 9);
    expect(s.ik.weight('p', 'leftArm')).toBe(1); // fading from here
    s.tick(4);
    expect(s.ik.weight('p', 'leftArm')).toBe(0);
    expect(s.ik.weight('p', 'rightArm')).toBe(1);
  });

  it('ignores garbage, accepts `head` and row targets, and forgets a destroyed row', () => {
    const s = setup();
    const { row, h } = s.body('p', { x: 0, y: 0, z: 0 }, 0);
    h.ik.rightArm = { weight: 1 };
    h.ik.rightArm = { target: { x: Number.NaN, y: 0, z: 0 } };
    h.ik.tail = { target: { x: 0, y: 0, z: 0 } };
    expect(s.ik.active('p')).toBe(false);
    h.ik.head = { target: 'enemy-1' };
    h.ik.leftLeg = { target: 'enemy-1', weight: 2 };
    expect(s.ik.weight('p', 'head')).toBe(1);
    expect(s.ik.weight('p', 'leftLeg')).toBe(1);
    expect(s.ik.localTarget('p', 'leftLeg')).toBe(null);
    s.ik.rowDestroyed(row);
    expect(s.ik.active('p')).toBe(false);
  });

  it('ticks only the rows of a simulated place', () => {
    const s = setup({ isSimulated: (p) => p === 'gallow-farm' });
    const a = s.body('a', { x: 0, y: 0, z: 0 }, 0);
    const b = s.body('b', { x: 0, y: 0, z: 0 }, 0, { place: 'training' });
    a.h.ik.rightArm = { target: { x: 0.2, y: 1.2, z: -0.3 }, blendIn: 0.12 };
    b.h.ik.rightArm = { target: { x: 0.2, y: 1.2, z: -0.3 }, blendIn: 0.12 };
    s.tick(2);
    expect(s.ik.weight('a', 'rightArm')).toBeGreaterThan(0.5);
    expect(s.ik.weight('b', 'rightArm')).toBe(0);
  });
});

describe('the presented frame', () => {
  it('re-projects a body-local target with the transform the body is drawn at: the hand stays on the same body-local point', () => {
    const s = setup();
    const rig = bodyRig();
    const feet = { x: 10, y: 0.5, z: -4 };
    const { h } = s.body('bot-1', feet, 30);
    const grip = { x: 0.3, y: 1.25, z: -0.3 };
    h.ik.leftArm = { target: localToWorld(feet, 30, grip), weight: 1 };
    // the same tick, drawn at three other places and facings (interpolated, moved, turned)
    for (const [at, yaw] of [
      [feet, 30],
      [{ x: 10.2, y: 0.5, z: -4.1 }, 36],
      [{ x: -3, y: 2, z: 8 }, 200],
    ] as const) {
      const pose = new Pose(rig);
      const body = bodyMatrix(at, yaw);
      expect(s.ik.solve('bot-1', pose, frameOf(body))).toBe(true);
      const hand = worldOf(pose, 'LeftHand', body);
      const want = localToWorld(at, yaw, grip);
      expect(Math.hypot(hand[0] - want.x, hand[1] - want.y, hand[2] - want.z), `yaw ${yaw}`).toBeLessThan(1e-3);
    }
  });

  it('a world-space target would trail a moving body; the body-local one does not', () => {
    const s = setup();
    const rig = bodyRig();
    const feet = { x: 0, y: 0, z: 0 };
    const { h } = s.body('bot-1', feet, 0);
    const grip = { x: 0.3, y: 1.25, z: -0.3 };
    const world = localToWorld(feet, 0, grip);
    h.ik.leftArm = { target: world, weight: 1 };
    // 6 m/s for one tick: 0.2 m
    const pose = new Pose(rig);
    const body = bodyMatrix({ x: 0, y: 0, z: -0.2 }, 0);
    s.ik.solve('bot-1', pose, frameOf(body));
    const hand = worldOf(pose, 'LeftHand', body);
    expect(Math.hypot(hand[0] - world.x, hand[1] - world.y, hand[2] - world.z)).toBeCloseTo(0.2, 3);
  });

  it('solves in rig model space under a model normalisation (scale and rebase)', () => {
    const s = setup();
    const rig = bodyRig();
    const feet = { x: 2, y: 0, z: 2 };
    const { h } = s.body('bot-1', feet, -70);
    const grip = { x: 0.25, y: 1.1, z: -0.25 };
    h.ik.leftArm = { target: localToWorld(feet, -70, grip), weight: 1 };
    const normalisation = m4ComposeTRS(new Float64Array(16), 0, [0.01, -0.02, 0.03], 0, qFromEulerXYZDeg([0, 0, 0, 1], 0, 0, 25, 0), 0, [0.9, 0.9, 0.9], 0);
    const body = bodyMatrix(feet, -70);
    const frame = frameOf(body, 0, normalisation);
    const pose = new Pose(rig);
    s.ik.solve('bot-1', pose, frame);
    const hand = worldOf(pose, 'LeftHand', frame.modelToWorld);
    const want = localToWorld(feet, -70, grip);
    expect(Math.hypot(hand[0] - want.x, hand[1] - want.y, hand[2] - want.z)).toBeLessThan(1e-3);
  });

  it('blends by weight × ramp, and restore() puts the clip pose back before the next evaluation', () => {
    const s = setup();
    const rig = bodyRig();
    const { h } = s.body('bot-1', { x: 0, y: 0, z: 0 }, 0);
    const body = bodyMatrix({ x: 0, y: 0, z: 0 }, 0);
    const pose = new Pose(rig);
    const clip = Float32Array.from(pose.r);
    h.ik.leftArm = { target: { x: 0.35, y: 1.2, z: -0.3 }, weight: 1, blendIn: 0.12 };
    // weight 0 at the write tick: nothing to solve
    expect(s.ik.solve('bot-1', pose, frameOf(body, 0))).toBe(false);
    expect(pose.r).toEqual(clip);
    let last = Infinity;
    for (let t = 1; t <= 4; t++) {
      s.tick();
      s.ik.restore('bot-1', pose);
      expect(pose.r, `restored before frame ${t}`).toEqual(clip);
      expect(s.ik.solve('bot-1', pose, frameOf(body, 0))).toBe(true);
      const d = dist(posOf(pose, 'LeftHand'), [0.35, 1.2, -0.3]);
      expect(d).toBeLessThan(last);
      last = d;
    }
    expect(last).toBeLessThan(1e-3);
    // fading out: the hand goes back to the clip pose and ends exactly on it
    h.ik.leftArm = null;
    s.tick(4);
    s.ik.restore('bot-1', pose);
    expect(s.ik.solve('bot-1', pose, frameOf(body, 0))).toBe(false);
    expect(pose.r).toEqual(clip);
  });

  it('a row target follows that row’s feet; without a lookup it does nothing', () => {
    const s = setup();
    const rig = bodyRig();
    const { h } = s.body('bot-1', { x: 0, y: 0, z: 0 }, 0);
    h.ik.leftArm = { target: 'crate-1', weight: 1 };
    const body = bodyMatrix({ x: 0, y: 0, z: 0 }, 0);
    const pose = new Pose(rig);
    expect(s.ik.solve('bot-1', pose, frameOf(body))).toBe(false);
    const feet = { x: 0.4, y: 1.3, z: 0.2 };
    expect(s.ik.solve('bot-1', pose, { ...frameOf(body), rowFeet: (id) => (id === 'crate-1' ? feet : null) })).toBe(true);
    expect(dist(posOf(pose, 'LeftHand'), [0.4, 1.3, 0.2])).toBeLessThan(1e-3);
  });

  it('`head` is accepted and changes nothing', () => {
    const s = setup();
    const rig = bodyRig();
    const { h } = s.body('bot-1', { x: 0, y: 0, z: 0 }, 0);
    h.ik.head = { target: { x: 0, y: 2, z: -3 }, weight: 1 };
    const pose = new Pose(rig);
    const r = Float32Array.from(pose.r);
    expect(s.ik.solve('bot-1', pose, frameOf(bodyMatrix({ x: 0, y: 0, z: 0 }, 0)))).toBe(false);
    expect(pose.r).toEqual(r);
    expect(IK_CHAINS).toContain('head');
    expect(ikBonesOf(rig).chains.slice(12)).toEqual(new Int16Array(0));
  });
});

describe('feet IK (off unless `feet === true` is written)', () => {
  const ground = (heightAt: (x: number, z: number) => number | null) => (x: number, y: number, z: number, maxDist: number) => {
    const g = heightAt(x, z);
    return g !== null && g <= y && y - g <= maxDist ? g : null;
  };

  it('does nothing without the flag, and nothing on flat ground with it', () => {
    const s = setup();
    const rig = bodyRig();
    const { h } = s.body('p', { x: 0, y: 0, z: 0 }, 0);
    const body = bodyMatrix({ x: 0, y: 0, z: 0 }, 0);
    const pose = new Pose(rig);
    const r = Float32Array.from(pose.r);
    const castDown = ground(() => -0.2);
    h.ik.rightArm = { target: { x: -0.4, y: 1.2, z: -0.2 }, weight: 0 };
    expect(s.ik.solve('p', pose, { ...frameOf(body), castDown })).toBe(false);
    expect(pose.r).toEqual(r);
    h.ik.feet = true;
    expect(s.ik.solve('p', pose, { ...frameOf(body), castDown: ground(() => 0) })).toBe(false);
    expect(pose.r).toEqual(r);
  });

  it('lowers the pelvis by what the lower foot needs, at most 0.25 m, and plants each foot on its ground', () => {
    const s = setup();
    const rig = bodyRig();
    const { h } = s.body('p', { x: 0, y: 0, z: 0 }, 0);
    h.ik.feet = true;
    const body = bodyMatrix({ x: 0, y: 0, z: 0 }, 0);
    const base = new Pose(rig);
    const hips0 = posOf(base, 'Hips');
    const left0 = posOf(base, 'LeftFoot');
    const right0 = posOf(base, 'RightFoot');
    // a step down under the left foot (x > 0): 0.10 m lower
    const pose = new Pose(rig);
    expect(s.ik.solve('p', pose, { ...frameOf(body), castDown: ground((x) => (x > 0 ? -0.1 : 0)) })).toBe(true);
    expect(posOf(pose, 'Hips')[1]).toBeCloseTo(hips0[1] - 0.1, 4);
    expect(posOf(pose, 'LeftFoot')[1]).toBeCloseTo(left0[1] - 0.1, 3);
    expect(posOf(pose, 'RightFoot')[1]).toBeCloseTo(right0[1], 3);
    expect(posOf(pose, 'LeftFoot')[0]).toBeCloseTo(left0[0], 3);
    // restore undoes the pelvis and the legs
    s.ik.restore('p', pose);
    expect(pose.r).toEqual(base.r);
    expect(pose.t).toEqual(base.t);
    // a 0.6 m drop: the pelvis stops at 0.25 m
    const deep = new Pose(rig);
    s.ik.solve('p', deep, { ...frameOf(body), castDown: ground((x) => (x > 0 ? -0.6 : 0)) });
    expect(posOf(deep, 'Hips')[1]).toBeGreaterThanOrEqual(hips0[1] - IK_DEFAULTS.pelvisDropMax - 1e-5);
    // feet off again
    h.ik.feet = false;
    const off = new Pose(rig);
    expect(s.ik.solve('p', off, { ...frameOf(body), castDown: ground(() => -0.1) })).toBe(false);
  });
});
