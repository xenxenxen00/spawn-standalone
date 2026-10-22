// MA4: the tick and frame hooks (docs/design/motion-physics-nav.md §3.11, §3.5.7; docs/architecture.md §4.1 step H, §4.2
// step 4, X-11): the MotionPort, the wiring on a kernel, and the presentation pass (evaluate → IK → skin write) with its hold,
// LOD and corpse-settle rules. No three: the skin adapter of the tests records what it is given.
import { describe, expect, it } from 'vitest';
import type { Kernel, RowRec } from '../../../src/compat/core/types.ts';
import type { CompiledClip } from '../../../src/compat/motion/clip.ts';
import { ClipRegistry } from '../../../src/compat/motion/clip-registry.ts';
import { MIXER_LOD } from '../../../src/compat/motion/constants.ts';
import { Pose } from '../../../src/compat/motion/pose.ts';
import { qNlerp } from '../../../src/compat/motion/quat.ts';
import { SETTLED_FRAMES, createMotion, type PresentFrame } from '../../../src/compat/motion/scheduler-hooks.ts';
import { storeFixture } from '../core/store-fixture.ts';
import { DT, fakeInstance, fakeSkin, fkJoints, motionWorld, placedMatrix, qmul, type MotionWorld } from './fakes/motion-world.ts';
import { clipOf, humanoidRig, makeRig, quat } from './fakes/rig.ts';

const frame = (frameIndex: number, alpha = 0, extra: Partial<PresentFrame> = {}): PresentFrame => ({ alpha, dt: 1 / 60, frameIndex, paused: false, ...extra });
const addClip = (w: MotionWorld, clip: CompiledClip): void => w.registry.addFunctionClip(clip.id, clip);
const swing = clipOf('test#swing', 'delta', 1, [{ bone: 'Spine', prop: 'rotation', times: [0, 1], values: [...quat(0, 0, 0), ...quat(0, 0, 60)] }]);
const hold = clipOf('test#hold', 'delta', 0.2, [{ bone: 'Spine', prop: 'rotation', times: [0, 0.2], values: [...quat(0, 0, 0), ...quat(0, 0, 30)] }]);

describe('MotionPort.advanceTick (tick step H)', () => {
  it('advances every mixer and IK ramp of a simulated place and ends the lazy sim poses', () => {
    const w = motionWorld({ isSimulated: (p) => p === 'gallow-farm' });
    const rig = humanoidRig();
    addClip(w, swing);
    const a = w.spawn('a');
    const b = w.spawn('b', {}, { place: 'training' });
    for (const r of [a, b]) {
      w.motion.anim.setRig(r.row, rig);
      r.h.anim.act = { clip: 'test#swing', loop: 'loop' };
      r.h.ik.leftArm = { target: { x: 0.3, y: 1.2, z: -0.3 }, blendIn: 0.12 };
    }
    const head = w.attached('a', 'bp-Head', 'Head');
    head.h.worldFeetPosition;
    expect(w.motion.attach.evaluations).toBe(1);
    w.motion.port.advanceTick(DT);
    expect(w.motion.anim.get('a')!.clipTime('act')).toBeCloseTo(DT, 9);
    expect(w.motion.anim.get('b')!.clipTime('act')).toBe(0);
    expect(w.motion.ik.weight('a', 'leftArm')).toBeCloseTo(DT / 0.12, 9);
    expect(w.motion.ik.weight('b', 'leftArm')).toBe(0);
    // the sim pose of the simulated body was carried one tick (attach.ts: unnamed bones must not depend on probe reads)
    expect(w.motion.attach.carried).toBe(1);
    // the same clock tick, after step H: the pose is evaluated again
    head.h.worldFeetPosition;
    expect(w.motion.attach.evaluations).toBe(2);
  });

  it('install(kernel): the three channels, the clock, spawn-time specs and disposal', () => {
    const f = storeFixture();
    const listeners: Record<string, Array<(row: RowRec) => void>> = {};
    const clock = { tick: 7 };
    const kernel = {
      store: f.store,
      clock,
      on: (e: string, fn: (row: RowRec) => void) => {
        (listeners[e] ??= []).push(fn);
        return () => listeners[e]!.splice(listeners[e]!.indexOf(fn), 1);
      },
    } as unknown as Pick<Kernel, 'store' | 'clock' | 'on'>;
    const registry = new ClipRegistry();
    registry.addFunctionClip(swing.id, swing);
    const motion = createMotion({ registry });
    f.ports.attach = motion.attach;
    const off = motion.install(kernel);
    for (const field of ['anim', 'mixer', 'ik']) expect(f.store.channels.hasEveryWrite(field), field).toBe(true);
    const rig = humanoidRig();
    const row = f.add({ id: 'en-1' });
    const h = f.store.handle(row, 'platform') as Record<string, any>;
    h.anim.act = { clip: 'test#swing', loop: 'loop' };
    expect(h.anim.act.startTick).toBe(7); // the kernel's clock
    motion.anim.setRig(row, rig);
    const probe = f.add({ id: 'en-1/bp-Head', parentId: 'en-1', props: { attachment: { bone: 'Head' } } });
    const head = fkJoints(rig)[rig.index('Head')]!.p;
    const p = (f.store.handle(probe, 'platform') as Record<string, any>).worldFeetPosition;
    expect(Math.hypot(p.x - head[0], p.y - head[1], p.z - head[2])).toBeLessThan(1e-5);
    h.ik.leftArm = { target: { x: 0.3, y: 1.2, z: -0.3 } };
    expect(motion.ik.active('en-1')).toBe(true);
    // a row spawned with channels gets them; a destroyed row loses everything
    const corpse = f.add({ id: 'corpse-1', props: { mixer: { act: { clip: 'test#swing', loop: 'once', startTick: 3 } }, ik: { rightArm: { target: { x: 0, y: 1, z: 0 } } } } });
    for (const fn of listeners['rowSpawned']!) fn(corpse);
    expect(motion.anim.get('corpse-1')!.clipTime('act')).toBeCloseTo(4 * DT, 9);
    expect(motion.ik.active('corpse-1')).toBe(true);
    for (const fn of listeners['rowDestroyed']!) fn(row);
    expect(motion.anim.get('en-1')).toBe(undefined);
    expect(motion.ik.active('en-1')).toBe(false);
    expect(motion.attach.worldPose(probe)).toBe(null);
    off();
    expect(f.store.channels.hasEveryWrite('ik')).toBe(false);
    expect(listeners['rowDestroyed']).toHaveLength(0);
  });
});

describe('MotionPresenter.bind', () => {
  it('gives the row a mixer on the model’s rig and presents the bind pose until a clip plays', () => {
    const w = motionWorld();
    const rig = humanoidRig();
    w.spawn('en-1', { at: { x: 4, y: 0, z: 1 } });
    const presenter = w.motion.presenter({ skin: fakeSkin });
    const inst = fakeInstance('en-1', rig, { at: { x: 4, y: 0, z: 1 } });
    expect(w.motion.anim.get('en-1')).toBe(undefined);
    expect(presenter.bind(inst, { rowId: 'en-1' })).toBe(true);
    expect(w.motion.anim.get('en-1')!.rig).toBe(rig);
    expect(presenter.size).toBe(1);
    presenter.update(frame(0));
    expect(inst.writes).toEqual([rig.bones.length]);
    const bindPose = new Pose(rig);
    bindPose.updateModel();
    expect(inst.applied).toEqual(bindPose.model);
    // the body walks before anything animates it: every bone is written again whenever the root moved, and only then
    presenter.update(frame(1));
    inst.body = placedMatrix({ at: { x: 4.1, y: 0, z: 1 } });
    presenter.update(frame(2));
    presenter.update(frame(3));
    expect(inst.writes).toEqual([rig.bones.length, 0, rig.bones.length, 0]);
  });

  it('refuses a model without bones and an unknown row; finds the row through rowOf or root.userData.ssRowId', () => {
    const w = motionWorld();
    const rig = humanoidRig();
    w.spawn('en-1');
    const presenter = w.motion.presenter({ skin: fakeSkin });
    expect(presenter.bind({}, { rowId: 'en-1' })).toBe(false);
    expect(presenter.bind(fakeInstance('ghost', rig), { rowId: 'ghost' })).toBe(false);
    expect(presenter.bind(fakeInstance('en-1', rig))).toBe(false); // no row id anywhere
    expect(presenter.bind({ ...fakeInstance('en-1', rig), root: { userData: { ssRowId: 'en-1' } } })).toBe(true);
    const byRowOf = w.motion.presenter({ skin: fakeSkin, rowOf: (i) => (i as { rowId: string }).rowId });
    expect(byRowOf.bind(fakeInstance('en-1', rig))).toBe(true);
  });

  it('a model swap rebinds the row: the clock is kept, the new rig is posed', () => {
    const w = motionWorld();
    const a = humanoidRig('a');
    const b = makeRig('b', [{ name: 'Hips', parent: null, t: [0, 2, 0] }, { name: 'Spine', parent: 'Hips', t: [0, 1, 0] }]);
    addClip(w, swing);
    const { h } = w.spawn('en-1');
    const presenter = w.motion.presenter({ skin: fakeSkin });
    const first = fakeInstance('en-1', a);
    presenter.bind(first, { rowId: 'en-1' });
    h.anim.act = { clip: 'test#swing', loop: 'loop' };
    w.tick(6);
    presenter.update(frame(0));
    const second = fakeInstance('en-1', b);
    presenter.bind(second, { rowId: 'en-1' });
    expect(presenter.size).toBe(1);
    expect(w.motion.anim.get('en-1')!.rig).toBe(b);
    expect(w.motion.anim.get('en-1')!.clipTime('act')).toBeCloseTo(0.2, 9);
    presenter.update(frame(1));
    expect(first.writes).toHaveLength(1);
    expect(second.writes).toEqual([2]);
    // Spine of the new rig is 12° into the swing
    const q = qNlerp([0, 0, 0, 1], 0, quat(0, 0, 0), 0, quat(0, 0, 60), 0, 0.2);
    const want = new Pose(b);
    want.setRotation(1, q[0]!, q[1]!, q[2]!, q[3]!);
    want.updateModel();
    expect(second.applied).toEqual(want.model);
    presenter.unbind(second);
    expect(presenter.size).toBe(0);
    expect(w.motion.anim.get('en-1')!.clipTime('act')).toBeCloseTo(0.2, 9);
  });

  it('drops the model of a destroyed row, and of a row whose id was reused', () => {
    const w = motionWorld();
    const rig = humanoidRig();
    const { row } = w.spawn('en-1');
    const presenter = w.motion.presenter({ skin: fakeSkin });
    const inst = fakeInstance('en-1', rig);
    presenter.bind(inst, { rowId: 'en-1' });
    presenter.update(frame(0));
    w.f.store.detach(row.id);
    w.motion.anim.rowDestroyed(row);
    w.spawn('en-1');
    presenter.update(frame(1));
    expect(presenter.size).toBe(0);
    expect(inst.writes).toHaveLength(1);
  });
});

describe('MotionPresenter.update: evaluate → IK → skin write', () => {
  it('presents the clip at the frame’s alpha between two ticks', () => {
    const w = motionWorld();
    const rig = humanoidRig();
    addClip(w, swing);
    const { h } = w.spawn('en-1');
    const presenter = w.motion.presenter({ skin: fakeSkin });
    const inst = fakeInstance('en-1', rig);
    presenter.bind(inst, { rowId: 'en-1' });
    h.anim.act = { clip: 'test#swing', loop: 'loop' };
    w.tick(6);
    const spine = rig.index('Spine');
    const head = rig.index('Head');
    for (const alpha of [0, 0.25, 0.5, 1]) {
      presenter.update(frame(alpha * 100, alpha));
      const q = qNlerp([0, 0, 0, 1], 0, quat(0, 0, 0), 0, quat(0, 0, 60), 0, 0.2 + alpha * DT);
      const joints = fkJoints(rig, (b) => (b === spine ? qmul(Array.from(rig.bindR.subarray(b * 4, b * 4 + 4)), q) : undefined));
      const m = inst.applied!;
      expect(Math.hypot(m[head * 16 + 12]! - joints[head]!.p[0], m[head * 16 + 13]! - joints[head]!.p[1], m[head * 16 + 14]! - joints[head]!.p[2]), `alpha ${alpha}`).toBeLessThan(1e-5);
    }
    expect(presenter.stats).toMatchObject({ rows: 1, evaluated: 1, ik: 0 });
  });

  it('writes only what changed: a held last frame writes nothing, and counts towards the settle', () => {
    const w = motionWorld();
    const rig = humanoidRig();
    addClip(w, hold);
    addClip(w, swing);
    const { h } = w.spawn('corpse-1');
    const presenter = w.motion.presenter({ skin: fakeSkin });
    const inst = fakeInstance('corpse-1', rig);
    presenter.bind(inst, { rowId: 'corpse-1' });
    h.anim.act = { clip: 'test#hold', loop: 'once' };
    let n = 0;
    for (let t = 0; t < 6; t++) {
      presenter.update(frame(n++, 0));
      presenter.update(frame(n++, 0.5));
      w.tick();
    }
    // the first frame writes the whole body; while the Spine turns, it and the 13 bones below it; nothing once the clip holds
    const spineSubtree = rig.bones.filter((_, b) => {
      for (let a = b; a >= 0; a = rig.parent[a]!) if (rig.bones[a] === 'Spine') return true;
      return false;
    }).length;
    expect(inst.writes[0]).toBe(rig.bones.length);
    expect(inst.writes.slice(1, 12)).toEqual(new Array(11).fill(spineSubtree));
    expect(presenter.settledFrames('corpse-1')).toBe(0);
    expect(presenter.isSettled('corpse-1')).toBe(false);
    for (let k = 0; k < SETTLED_FRAMES + 1; k++) {
      presenter.update(frame(n++, 0.5));
      if (k % 2 === 1) w.tick();
    }
    expect(inst.writes.slice(-SETTLED_FRAMES)).toEqual(new Array(SETTLED_FRAMES).fill(0));
    expect(presenter.isSettled('corpse-1')).toBe(true);
    expect(SETTLED_FRAMES).toBe(10);
    // a new clip unsettles it
    h.anim.act = { clip: 'test#swing', loop: 'loop' };
    w.tick(3);
    presenter.update(frame(n++, 0));
    expect(presenter.settledFrames('corpse-1')).toBe(0);
  });

  it('solves IK after the mixer, against this frame’s root, and re-solves from the clip pose every frame', () => {
    const w = motionWorld();
    const rig = makeRig('test.arm', [
      { name: 'Hips', parent: null, t: [0, 1, 0] },
      { name: 'Spine', parent: 'Hips', t: [0, 0.4, 0] },
      { name: 'LeftArm', parent: 'Spine', t: [0.2, 0, 0], rDeg: [0, 0, 10] },
      { name: 'LeftForeArm', parent: 'LeftArm', t: [0.3, 0, 0], rDeg: [0, -20, 0] },
      { name: 'LeftHand', parent: 'LeftForeArm', t: [0.25, 0, 0] },
    ]);
    addClip(w, swing);
    const at = { x: 5, y: 0, z: 5 };
    const { h } = w.spawn('bot-1', { at, yaw: 0 });
    const presenter = w.motion.presenter({ skin: fakeSkin });
    const inst = fakeInstance('bot-1', rig, { at });
    presenter.bind(inst, { rowId: 'bot-1' });
    h.anim.act = { clip: 'test#swing', loop: 'loop' };
    h.ik.leftArm = { target: { x: 5.3, y: 1.2, z: 4.7 }, weight: 1 };
    const hand = rig.index('LeftHand');
    const handWorld = (): [number, number, number] => {
      const m = inst.applied!;
      const b = inst.body;
      const p = [m[hand * 16 + 12]!, m[hand * 16 + 13]!, m[hand * 16 + 14]!];
      return [b[0]! * p[0]! + b[4]! * p[1]! + b[8]! * p[2]! + b[12]!, b[1]! * p[0]! + b[5]! * p[1]! + b[9]! * p[2]! + b[13]!, b[2]! * p[0]! + b[6]! * p[1]! + b[10]! * p[2]! + b[14]!];
    };
    for (let f = 0; f < 12; f++) {
      // the bridge draws the body somewhere else every frame; the grip is a body-local point (0.3, 1.2, −0.3)
      const drawn = { x: 5 + 0.05 * f, y: 0, z: 5 - 0.02 * f };
      inst.body = placedMatrix({ at: drawn, yaw: 3 * f });
      presenter.update(frame(f, (f % 2) * 0.5));
      if (f % 2 === 1) w.tick();
      const r = (3 * f * Math.PI) / 180;
      const want = [drawn.x + Math.cos(r) * 0.3 + Math.sin(r) * -0.3, 1.2, drawn.z - Math.sin(r) * 0.3 + Math.cos(r) * -0.3];
      const got = handWorld();
      expect(Math.hypot(got[0] - want[0]!, got[1] - want[1]!, got[2] - want[2]!), `frame ${f}`).toBeLessThan(1e-3);
      expect(presenter.stats.ik).toBe(1);
    }
    // the fade-out ends on the clip pose
    h.ik.leftArm = null;
    w.tick(5);
    presenter.update(frame(20));
    expect(presenter.stats.ik).toBe(0);
    const clipOnly = new Pose(rig);
    w.motion.anim.get('bot-1')!.evaluate(clipOnly, 0);
    clipOnly.updateModel();
    expect(inst.applied).toEqual(clipOnly.model);
  });
});

describe('held frames (X-11)', () => {
  it('a paused frame and a hitstop frame (dt 0) present the pose of the frame before, whatever the sim did; a moved root is still followed', () => {
    const w = motionWorld();
    const rig = humanoidRig();
    addClip(w, swing);
    const { h } = w.spawn('en-1');
    const presenter = w.motion.presenter({ skin: fakeSkin });
    const inst = fakeInstance('en-1', rig);
    presenter.bind(inst, { rowId: 'en-1' });
    h.anim.act = { clip: 'test#swing', loop: 'loop' };
    w.tick(3);
    presenter.update(frame(0, 0.5));
    const shown = Float32Array.from(inst.applied!);
    // hitstop: the presentation clock stands still while ticks run
    for (let f = 1; f <= 4; f++) {
      w.tick();
      presenter.update(frame(f, 0.5, { dt: 0 }));
      expect(presenter.stats.evaluated).toBe(0);
    }
    presenter.update(frame(5, 0.5, { paused: true }));
    expect(inst.applied).toEqual(shown);
    expect(inst.writes.slice(1)).toEqual([0, 0, 0, 0, 0]);
    inst.body = placedMatrix({ at: { x: 1, y: 0, z: 0 } });
    presenter.update(frame(6, 0.5, { dt: 0 }));
    expect(inst.writes.at(-1)).toBe(rig.bones.length);
    expect(inst.applied).toEqual(shown);
    // time moves again: the pose catches up with the sim
    presenter.update(frame(7, 0.5));
    expect(presenter.stats.evaluated).toBe(1);
    expect(inst.applied).not.toEqual(shown);
  });

  it('a first frame is presented even when it is a held one', () => {
    const w = motionWorld();
    const rig = humanoidRig();
    addClip(w, swing);
    const { h } = w.spawn('en-1');
    const presenter = w.motion.presenter({ skin: fakeSkin });
    const inst = fakeInstance('en-1', rig);
    h.anim.act = { clip: 'test#swing', loop: 'loop' };
    w.tick(10);
    presenter.bind(inst, { rowId: 'en-1' });
    presenter.update(frame(0, 0, { dt: 0 }));
    expect(presenter.stats.evaluated).toBe(1);
    const bind = new Pose(rig);
    bind.updateModel();
    expect(inst.applied).not.toEqual(bind.model);
  });
});

describe('presentation LOD (motion §3.5.7)', () => {
  function crowd(opts: { lowTier?: boolean } = {}) {
    const w = motionWorld();
    const rig = humanoidRig();
    addClip(w, swing);
    const eye = { x: 0, y: 1.6, z: 0 };
    const hidden = new Set<unknown>();
    const presenter = w.motion.presenter({ skin: fakeSkin, eye: () => eye, visible: (i) => !hidden.has(i), ...opts });
    const at = (id: string, dist: number) => {
      const placed = { at: { x: dist, y: 1.6, z: 0 } };
      const { h } = w.spawn(id, placed);
      const inst = fakeInstance(id, rig, placed);
      presenter.bind(inst, { rowId: id });
      h.anim.act = { clip: 'test#swing', loop: 'loop' };
      return inst;
    };
    /** frames (of 16, after the first) in which the row's pose was written */
    const run = (insts: ReturnType<typeof fakeInstance>[]): number[] => {
      presenter.update(frame(0));
      for (const i of insts) i.writes.length = 0;
      for (let f = 1; f <= 16; f++) {
        w.tick();
        presenter.update(frame(f, 0.5));
      }
      return insts.map((i) => i.writes.filter((n) => n > 0).length);
    };
    return { w, presenter, at, run, hidden, eye };
  }

  it('near rows every frame, beyond 35 m every 2nd, beyond 60 m every 4th, off-screen every 4th', () => {
    const c = crowd();
    const near = c.at('a', 10);
    const edge = c.at('b', MIXER_LOD.near - 0.5);
    const mid = c.at('c', MIXER_LOD.near + 0.5);
    const far = c.at('d', MIXER_LOD.far + 0.5);
    const off = c.at('e', 5);
    c.hidden.add(off);
    expect(c.run([near, edge, mid, far, off])).toEqual([16, 16, 8, 4, 4]);
  });

  it('the low tier halves the distances and the governor scales them by 0.7', () => {
    const low = crowd({ lowTier: true });
    expect(low.run([low.at('a', 17), low.at('b', 18), low.at('c', 29), low.at('d', 31)])).toEqual([16, 8, 8, 4]);
    const gov = crowd();
    gov.presenter.setGovernorLod(true);
    expect(gov.run([gov.at('a', 24), gov.at('b', 25), gov.at('c', 41), gov.at('d', 43)])).toEqual([16, 8, 8, 4]);
    gov.presenter.setGovernorLod(false);
    gov.presenter.setLowTier(true);
    expect(gov.run([gov.at('e', 17), gov.at('f', 18)]).slice(0, 2)).toEqual([16, 8]);
  });

  it('skipped frames of different rows do not coincide, and a skipped row still follows its root', () => {
    const c = crowd();
    const rows = [0, 1, 2, 3].map((k) => c.at(`far-${k}`, 70 + k));
    c.presenter.update(frame(0));
    const perFrame: number[] = [];
    for (let f = 1; f <= 8; f++) {
      c.w.tick();
      c.presenter.update(frame(f, 0.5));
      perFrame.push(c.presenter.stats.evaluated);
    }
    expect(perFrame).toEqual([1, 1, 1, 1, 1, 1, 1, 1]);
    // one far row walks: on the frames its mixer is skipped, its bones are still written under the new root
    const walker = rows[0]!;
    walker.writes.length = 0;
    for (let f = 9; f <= 12; f++) {
      walker.body = placedMatrix({ at: { x: 70 + f * 0.1, y: 1.6, z: 0 } });
      c.presenter.update(frame(f, 0.5));
    }
    expect(walker.writes).toEqual(new Array(4).fill(walker.rig.bones.length));
  });

  it('without a camera or a visibility test every row is presented every frame; the sim pose never depends on any of it', () => {
    const w = motionWorld();
    const rig = humanoidRig();
    addClip(w, swing);
    const presenter = w.motion.presenter({ skin: fakeSkin });
    const placed = { at: { x: 500, y: 0, z: 0 } };
    const { h } = w.spawn('en-1', placed);
    const inst = fakeInstance('en-1', rig, placed);
    presenter.bind(inst, { rowId: 'en-1' });
    h.anim.act = { clip: 'test#swing', loop: 'loop' };
    const head = w.attached('en-1', 'bp-Head', 'Head');
    const reads: number[] = [];
    for (let f = 0; f < 8; f++) {
      presenter.update(frame(f, 0.5));
      reads.push(head.h.worldFeetPosition.y);
      w.tick();
    }
    expect(inst.writes.filter((n) => n > 0)).toHaveLength(8);
    // the same reads without any presenter
    const w2 = motionWorld();
    addClip(w2, swing);
    const b = w2.spawn('en-1', placed);
    w2.motion.anim.setRig(b.row, rig);
    b.h.anim.act = { clip: 'test#swing', loop: 'loop' };
    const head2 = w2.attached('en-1', 'bp-Head', 'Head');
    for (let f = 0; f < 8; f++) {
      expect(Object.is(head2.h.worldFeetPosition.y, reads[f])).toBe(true);
      w2.tick();
    }
  });
});
