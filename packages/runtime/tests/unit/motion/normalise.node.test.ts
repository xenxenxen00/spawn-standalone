// MA3 acceptance: per-bone normalisation and composition (docs/design/motion-physics-nav.md §3.5.4; AGENTS.md:137).
// For each bone: the contributors are the playing clips that NAME it with an effective weight > 0; their weights are
// normalised among themselves whatever they sum to; a bone nobody names is not written.
import { describe, expect, it } from 'vitest';
import { type CompiledClip, clipTime, sampleTrack } from '../../../src/compat/motion/clip.ts';
import { ClipRegistry } from '../../../src/compat/motion/clip-registry.ts';
import { cookAuthoredFile } from '../../../src/compat/motion/cook-authored.ts';
import { Mixer } from '../../../src/compat/motion/mixer.ts';
import { Pose, type PoseRig } from '../../../src/compat/motion/pose.ts';
import { qMul } from '../../../src/compat/motion/quat.ts';
import { clipOf, quat, smallRig, tiltedRig, type TrackDef } from './fakes/rig.ts';

const DT = 1 / 30;
const FILE = 'anim/n.yml';
const id = (name: string): string => `${FILE}#${name}`;

/** authored (delta) clips with constant keys */
const AUTHORED = {
  loco: { duration: 1, tracks: { Hips: { y: 0.1 }, Spine: { roll: 40 }, LeftLeg: { pitch: 25 } } },
  act: { duration: 1, tracks: { Hips: { y: -0.3 }, Spine: { pitch: 60 } } },
  nod: { duration: 1, tracks: { Head: { pitch: 30 } } },
  sway: { duration: 1, tracks: { Spine: { roll: 15 } } },
  all: { duration: 1, tracks: { Hips: { y: 0.2 }, Spine: { roll: 10 }, Head: { yaw: 20 }, LeftLeg: { pitch: 30 } } },
};

function setup(rig: PoseRig = smallRig(), extra: readonly CompiledClip[] = []) {
  const registry = new ClipRegistry();
  registry.addAuthored(FILE, cookAuthoredFile(FILE, AUTHORED));
  // absolute clips of the rig itself resolve like a model's own clips
  registry.setModelClips({ clips: (modelId) => (modelId === rig.id ? extra : undefined) });
  const mixer = new Mixer('row', rig, { registry });
  return { registry, rig, mixer, pose: new Pose(rig) };
}

const run = (m: Mixer, n: number): void => {
  for (let i = 0; i < n; i++) m.advanceTick(DT);
};
const rot = (pose: Pose, bone: string): number[] => Array.from(pose.r.subarray(pose.rig.index(bone) * 4, pose.rig.index(bone) * 4 + 4));
const pos = (pose: Pose, bone: string): number[] => Array.from(pose.t.subarray(pose.rig.index(bone) * 3, pose.rig.index(bone) * 3 + 3));
const scl = (pose: Pose, bone: string): number[] => Array.from(pose.s.subarray(pose.rig.index(bone) * 3, pose.rig.index(bone) * 3 + 3));

function expectVec(got: readonly number[], want: readonly number[], eps = 1e-6): void {
  expect(got.length).toBe(want.length);
  for (let i = 0; i < want.length; i++) expect(Math.abs(got[i]! - want[i]!), `[${got.join(', ')}] vs [${want.join(', ')}]`).toBeLessThan(eps);
}

/** the normalised weighted sum of unit quaternions, each flipped into the hemisphere of the first (the heaviest) */
function blend(parts: ReadonlyArray<readonly [number, readonly number[]]>): number[] {
  const ref = parts[0]![1];
  const acc = [0, 0, 0, 0];
  for (const [w, q] of parts) {
    const s = q[0]! * ref[0]! + q[1]! * ref[1]! + q[2]! * ref[2]! + q[3]! * ref[3]! < 0 ? -w : w;
    for (let k = 0; k < 4; k++) acc[k]! += s * q[k]!;
  }
  const l = Math.hypot(acc[0]!, acc[1]!, acc[2]!, acc[3]!);
  return acc.map((v) => v / l);
}

const angleDeg = (a: readonly number[], b: readonly number[]): number => {
  const d = Math.min(1, Math.abs(a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]! + a[3]! * b[3]!));
  return (2 * Math.acos(d) * 180) / Math.PI;
};

const constant = (cid: string, tracks: readonly TrackDef[], extra: Partial<CompiledClip> = {}): CompiledClip => clipOf(cid, 'absolute', 1, tracks, extra);
const headAt = (name: string, y: number): CompiledClip => constant(`test.small#${name}`, [{ bone: 'Head', prop: 'position', times: [0], values: [0, y, 0] }]);

describe('weights are normalised among the contributors of each bone', () => {
  it('an act at weight 1 over loco at 0.001 owns the bones it names (99.9 %); loco owns the bones only it names', () => {
    const { mixer: m, pose } = setup();
    m.write('loco', { clip: id('loco'), weight: 0.001 }, 0);
    m.write('act', { clip: id('act'), weight: 1 }, 0);
    m.evaluate(pose, 0);
    const act = quat(60, 0, 0);
    const loco = quat(0, 0, 40);
    expectVec(rot(pose, 'Spine'), blend([[1, act], [0.001, loco]]));
    // the two poses are 70° apart; a 0.1 % share moves the bone 0.07° off the act
    expect(angleDeg(act, loco)).toBeGreaterThan(60);
    expect(angleDeg(rot(pose, 'Spine'), act)).toBeLessThan(0.1);
    // Hips: bind y 1 + (1·(−0.3) + 0.001·0.1) / 1.001
    expectVec(pos(pose, 'Hips'), [0, 1 + (-0.3 + 0.0001) / 1.001, 0]);
    // only loco names LeftLeg: it has it whole, at any weight
    expectVec(rot(pose, 'LeftLeg'), quat(25, 0, 0));
  });

  it('loco alone at 0.001 owns every bone it names', () => {
    const { mixer: m, pose } = setup();
    m.write('loco', { clip: id('loco'), weight: 0.001 }, 0);
    m.evaluate(pose, 0);
    expectVec(rot(pose, 'Spine'), quat(0, 0, 40));
    expectVec(pos(pose, 'Hips'), [0, 1.1, 0]);
    expectVec(rot(pose, 'LeftLeg'), quat(25, 0, 0));
  });

  it('normalises whatever the weights sum to: 0.3 and 0.1 blend like 3 and 1', () => {
    for (const [wa, wb] of [[0.3, 0.1], [3, 1], [0.003, 0.001]] as const) {
      const { mixer: m, pose } = setup(smallRig(), [headAt('low', 1), headAt('high', 2)]);
      m.write('a', { clip: 'low', weight: wa }, 0);
      m.write('b', { clip: 'high', weight: wb }, 0);
      m.evaluate(pose, 0);
      expectVec(pos(pose, 'Head'), [0, 1.25, 0]);
    }
  });

  it('does not depend on the order the channels were written in', () => {
    const one = setup();
    one.mixer.write('loco', { clip: id('loco'), weight: 0.4 }, 0);
    one.mixer.write('act', { clip: id('act'), weight: 0.7 }, 0);
    one.mixer.evaluate(one.pose, 0);
    const two = setup();
    two.mixer.write('act', { clip: id('act'), weight: 0.7 }, 0);
    two.mixer.write('loco', { clip: id('loco'), weight: 0.4 }, 0);
    two.mixer.evaluate(two.pose, 0);
    expectVec(rot(two.pose, 'Spine'), rot(one.pose, 'Spine'), 1e-7);
    expectVec(pos(two.pose, 'Hips'), pos(one.pose, 'Hips'), 1e-7);
    expectVec(rot(one.pose, 'Spine'), blend([[0.7, quat(60, 0, 0)], [0.4, quat(0, 0, 40)]]));
  });

  it('a channel at weight 0 contributes nothing', () => {
    const { mixer: m, pose } = setup();
    m.write('nod', { clip: id('nod'), weight: 0 }, 0);
    m.evaluate(pose, 0);
    expectVec(rot(pose, 'Head'), [0, 0, 0, 1]);
    expect(Array.from(pose.dirty)).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('a bone no playing clip names is not written', () => {
  it('keeps its last pose after its channel is removed: it is not reset to bind', () => {
    const { mixer: m, pose } = setup();
    m.write('nod', { clip: id('nod'), blendOut: 0 }, 0);
    m.evaluate(pose, 0);
    expectVec(rot(pose, 'Head'), quat(30, 0, 0));
    m.write('nod', null, 0);
    expect(m.fading()).toEqual([]);
    pose.clearDirty();
    m.evaluate(pose, 0);
    expectVec(rot(pose, 'Head'), quat(30, 0, 0));
    // another clip takes the spine: the head still holds what the nod left
    m.write('sway', { clip: id('sway') }, 0);
    run(m, 30);
    m.evaluate(pose, 0.5);
    expectVec(rot(pose, 'Head'), quat(30, 0, 0));
    expectVec(rot(pose, 'Spine'), quat(0, 0, 15));
    expect(pose.dirty[pose.rig.index('Head')]).toBe(0);
    expect(pose.dirty[pose.rig.index('Spine')]).toBe(1);
  });

  it('holds the last blended value when a channel finishes its fade-out', () => {
    const { mixer: m, pose } = setup();
    m.write('nod', { clip: id('nod') }, 0);
    m.evaluate(pose, 0);
    m.write('nod', null, 0); // fades over 0.1 s; while it fades it alone names Head, so it still owns it
    run(m, 1);
    m.evaluate(pose, 0);
    expectVec(rot(pose, 'Head'), quat(30, 0, 0));
    run(m, 5);
    expect(m.fading()).toEqual([]);
    m.evaluate(pose, 0);
    expectVec(rot(pose, 'Head'), quat(30, 0, 0));
  });

  it('skips a track whose bone the rig lacks', () => {
    const tail = constant('test.small#tail', [
      { bone: 'Tail', prop: 'position', times: [0], values: [9, 9, 9] },
      { bone: 'Head', prop: 'position', times: [0], values: [0, 0.7, 0] },
    ]);
    const { mixer: m, pose } = setup(smallRig(), [tail]);
    m.write('a', { clip: 'tail' }, 0);
    m.evaluate(pose, 0);
    expectVec(pos(pose, 'Head'), [0, 0.7, 0]);
    expect(Array.from(pose.dirty)).toEqual([0, 0, 1, 0, 0]);
  });
});

describe('rotation: hemisphere alignment to the heaviest contributor', () => {
  const q1 = quat(10, 50, 0);
  const q2 = quat(40, 20, 15);
  const neg = (q: readonly number[]): number[] => q.map((v) => -v);
  const abs = (name: string, q: readonly number[]): CompiledClip => constant(`test.small#${name}`, [{ bone: 'Head', prop: 'rotation', times: [0], values: [...q] }]);

  it('q and −q are the same rotation: the blend does not cancel', () => {
    const { mixer: m, pose } = setup(smallRig(), [abs('a', q1), abs('b', neg(q1))]);
    m.write('a', { clip: 'a', weight: 0.5 }, 0);
    m.write('b', { clip: 'b', weight: 0.5 }, 0);
    m.evaluate(pose, 0);
    expectVec(rot(pose, 'Head'), q1);
  });

  it('gives the same pose whichever sign a contributor’s quaternion carries', () => {
    const plain = setup(smallRig(), [abs('a', q1), abs('b', q2)]);
    const flipped = setup(smallRig(), [abs('a', q1), abs('b', neg(q2))]);
    for (const s of [plain, flipped]) {
      s.mixer.write('a', { clip: 'a', weight: 1 }, 0);
      s.mixer.write('b', { clip: 'b', weight: 0.6 }, 0);
      s.mixer.evaluate(s.pose, 0);
    }
    expectVec(rot(flipped.pose, 'Head'), rot(plain.pose, 'Head'), 1e-7);
    expectVec(rot(plain.pose, 'Head'), blend([[1, q1], [0.6, q2]]));
    // and the result sits in the heaviest contributor's hemisphere
    const d = rot(flipped.pose, 'Head').reduce((a, v, i) => a + v * q1[i]!, 0);
    expect(d).toBeGreaterThan(0);
  });
});

describe('composition of delta and absolute clips', () => {
  it('delta: R = bindR·q, T = bindT + offset, S = bindS; a property without a track stays at bind', () => {
    const rig = tiltedRig();
    const q = quat(10, 20, 30);
    const delta = clipOf('fn#lean', 'delta', 1, [
      { bone: 'Spine', prop: 'rotation', times: [0], values: q },
      { bone: 'Spine', prop: 'position', times: [0], values: [0.1, 0.2, 0.3] },
      { bone: 'Head', prop: 'position', times: [0], values: [0, 0, 0.5] },
    ]);
    const { mixer: m, pose, registry } = setup(rig);
    registry.addFunctionClip('fn#lean', delta);
    m.write('a', { clip: 'fn#lean' }, 0);
    m.evaluate(pose, 0);
    const spine = rig.index('Spine');
    expectVec(rot(pose, 'Spine'), qMul([0, 0, 0, 0], 0, rig.bindR, spine * 4, q, 0));
    expectVec(pos(pose, 'Spine'), [0.1, 0.7, 0.3]); // bind (0, 0.5, 0) + offset
    expectVec(scl(pose, 'Spine'), [1, 2, 1]);
    // Head has a position track only: its rotation is the bind rotation
    expectVec(rot(pose, 'Head'), Array.from(rig.bindR.subarray(rig.index('Head') * 4, rig.index('Head') * 4 + 4)));
    expectVec(pos(pose, 'Head'), [0.2, 0, 0.5]);
  });

  it('absolute: the sampled TRS as it is; a property without a track stays at bind', () => {
    const rig = tiltedRig();
    const q = quat(10, 20, 30);
    const absolute = clipOf('test.tilted#pose', 'absolute', 1, [
      { bone: 'Spine', prop: 'rotation', times: [0], values: q },
      { bone: 'Spine', prop: 'scale', times: [0], values: [3, 3, 3] },
    ]);
    const { mixer: m, pose } = setup(rig, [absolute]);
    m.write('a', { clip: 'pose' }, 0);
    m.evaluate(pose, 0);
    expectVec(rot(pose, 'Spine'), q);
    expectVec(pos(pose, 'Spine'), [0, 0.5, 0]);
    expectVec(scl(pose, 'Spine'), [3, 3, 3]);
  });

  it('a delta and an absolute clip on one bone blend as two absolute local transforms', () => {
    const rig = tiltedRig();
    const qa = quat(0, 45, 0);
    const absolute = clipOf('test.tilted#abs', 'absolute', 1, [
      { bone: 'Spine', prop: 'rotation', times: [0], values: qa },
      { bone: 'Spine', prop: 'position', times: [0], values: [1, 1, 1] },
    ]);
    const { mixer: m, pose } = setup(rig, [absolute]);
    m.write('lib', { clip: 'abs', weight: 1 }, 0);
    m.write('auth', { clip: id('sway'), weight: 0.5 }, 0);
    m.evaluate(pose, 0);
    const spine = rig.index('Spine');
    const viaDelta = qMul([0, 0, 0, 0], 0, rig.bindR, spine * 4, quat(0, 0, 15), 0);
    expectVec(rot(pose, 'Spine'), blend([[1, qa], [0.5, viaDelta]]));
    // T: (1·(1,1,1) + 0.5·bind (0,0.5,0)) / 1.5
    expectVec(pos(pose, 'Spine'), [1 / 1.5, 1.25 / 1.5, 1 / 1.5]);
  });

  it('`units: hips` scales position offsets by the rig’s hips rest height', () => {
    const rig = tiltedRig();
    expect(rig.hipsRestHeight).toBeCloseTo(0.8, 6);
    const sit = (units?: 'hips'): CompiledClip =>
      clipOf(`fn#sit${units ?? ''}`, 'delta', 0.1, [{ bone: 'Hips', prop: 'position', times: [0], values: [0, -0.5, 0] }], units ? { units } : {});
    const { mixer: m, pose, registry } = setup(rig);
    registry.addFunctionClip('fn#sithips', sit('hips'));
    registry.addFunctionClip('fn#sit', sit());
    m.write('sit', { clip: 'fn#sithips' }, 0);
    m.evaluate(pose, 0);
    expectVec(pos(pose, 'Hips'), [0, 0.8 - 0.5 * 0.8, 0]);
    m.write('sit', { clip: 'fn#sit' }, 0);
    m.evaluate(pose, 0);
    expectVec(pos(pose, 'Hips'), [0, 0.3, 0]);
  });

  it('honours STEP tracks (viewmodel clips) and interpolates LINEAR ones', () => {
    const stepped = clipOf('test.small#step', 'absolute', 1, [
      { bone: 'Head', prop: 'position', times: [0, 0.5, 1], values: [0, 1, 0, 0, 2, 0, 0, 3, 0], interp: 'step' },
      { bone: 'Spine', prop: 'position', times: [0, 0.5, 1], values: [0, 1, 0, 0, 2, 0, 0, 3, 0] },
    ]);
    const { mixer: m, pose } = setup(smallRig(), [stepped]);
    m.write('action', { clip: 'step', loop: 'once' }, 0);
    run(m, 12); // 0.4 s
    m.evaluate(pose, 0);
    expectVec(pos(pose, 'Head'), [0, 1, 0]);
    expectVec(pos(pose, 'Spine'), [0, 1.8, 0], 1e-5);
  });
});

describe('sampling: the mixer’s own track sampler and time mapping are clip.ts’s', () => {
  // mixer.ts writes `sampleTrack` and `clipTime` out inside its bone loop (no float crosses a call there): this holds the
  // copies to the originals over irregular keys, both interpolations, every loop mode, negative speeds and any alpha
  it('gives sampleTrack(track, clipTime(t, duration, loop)) for every property', () => {
    let seed = 0x2f6e2b1;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 4294967296;
    };
    const keyTimes = (n: number, duration: number): number[] => {
      const t = Array.from({ length: n }, () => rnd() * duration).sort((a, b) => a - b);
      if (rnd() < 0.5) t[0] = 0;
      if (n > 2 && rnd() < 0.3) t[2] = t[1]!; // two keys at one time
      return t;
    };
    const rig = smallRig();
    let checked = 0;
    for (let round = 0; round < 60; round++) {
      const duration = 0.3 + rnd() * 2;
      const tracks: TrackDef[] = [];
      for (const [bone, prop] of [['Head', 'rotation'], ['Spine', 'rotation'], ['Head', 'position'], ['Spine', 'position'], ['LeftLeg', 'scale']] as const) {
        const n = 1 + Math.floor(rnd() * 6);
        const times = keyTimes(n, duration);
        const values = times.flatMap(() => (prop === 'rotation' ? quat(rnd() * 360 - 180, rnd() * 360 - 180, rnd() * 360 - 180).map((v) => (rnd() < 0.3 ? -v : v)) : [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 + 0.5]));
        tracks.push({ bone, prop, times, values, interp: rnd() < 0.3 ? 'step' : 'linear' });
      }
      const clip = clipOf(`${rig.id}#rand${round}`, 'absolute', duration, tracks);
      const { mixer: m, pose } = setup(rig, [clip]);
      for (const loop of ['once', 'loop', 'pingpong'] as const) {
        const speed = (rnd() < 0.25 ? -1 : 1) * (0.2 + rnd() * 3);
        m.write('b', { clip: `rand${round}`, loop, speed, time: rnd() * duration, blendOut: 0 }, 0);
        run(m, Math.floor(rnd() * 90));
        const alpha = rnd();
        m.evaluate(pose, alpha);
        const at = clipTime(m.clipTime('b')! + alpha * DT * speed, duration, loop);
        for (const tr of clip.tracks) {
          const want = tr.prop === 'rotation' ? [0, 0, 0, 0] : [0, 0, 0];
          sampleTrack(tr, at, want, 0);
          const got = tr.prop === 'rotation' ? rot(pose, tr.bone) : tr.prop === 'position' ? pos(pose, tr.bone) : scl(pose, tr.bone);
          // one contributor: the bone is the sampled value (a rotation up to its sign)
          if (tr.prop === 'rotation' && got.reduce((acc, v, i) => acc + v * want[i]!, 0) < 0) want.forEach((v, i) => (want[i] = -v));
          expectVec(got, want, 2e-6);
          checked++;
        }
        m.write('b', null, 0);
      }
    }
    expect(checked).toBe(60 * 3 * 5);
  });
});

describe('fading-out clips contribute while they ramp', () => {
  it('a restart cross-fades the outgoing clip with the incoming one over blendIn', () => {
    const { mixer: m, pose } = setup(smallRig(), [headAt('low', 1), headAt('high', 2)]);
    m.write('act', { clip: 'low' }, 0);
    m.evaluate(pose, 0);
    expectVec(pos(pose, 'Head'), [0, 1, 0]);
    m.write('act', { clip: 'high', blendIn: 0.2 }, 0);
    m.evaluate(pose, 0); // the new clip is at weight 0: the old one still owns the bone
    expectVec(pos(pose, 'Head'), [0, 1, 0]);
    run(m, 1); // 1/6 of the way
    m.evaluate(pose, 0);
    expectVec(pos(pose, 'Head'), [0, 1 + 1 / 6, 0]);
    run(m, 2);
    m.evaluate(pose, 0);
    expectVec(pos(pose, 'Head'), [0, 1.5, 0]);
    m.evaluate(pose, 0.5); // presentation between two ticks moves the ramp too
    expectVec(pos(pose, 'Head'), [0, 1.5 + 1 / 12, 0]);
    run(m, 3);
    m.evaluate(pose, 0);
    expectVec(pos(pose, 'Head'), [0, 2, 0]);
    expect(m.fading()).toEqual([]);
  });

  it('a cleared channel keeps contributing until its blendOut ends', () => {
    const { mixer: m, pose } = setup(smallRig(), [headAt('low', 1), headAt('high', 2)]);
    m.write('a', { clip: 'low', blendOut: 0.2 }, 0);
    m.write('b', { clip: 'high' }, 0);
    m.write('a', null, 0);
    run(m, 3); // a is at 0.5, b at 1
    m.evaluate(pose, 0);
    expectVec(pos(pose, 'Head'), [0, (0.5 * 1 + 1 * 2) / 1.5, 0]);
    run(m, 3);
    m.evaluate(pose, 0);
    expectVec(pos(pose, 'Head'), [0, 2, 0]);
  });
});

describe('mask: {from: bone}', () => {
  it('restricts a channel to that bone and its descendants', () => {
    const { mixer: m, pose, rig } = setup();
    m.write('flinchA', { clip: id('all'), mask: { from: 'Spine' } }, 0);
    m.evaluate(pose, 0);
    expectVec(rot(pose, 'Spine'), quat(0, 0, 10));
    expectVec(rot(pose, 'Head'), quat(0, 20, 0));
    expectVec(pos(pose, 'Hips'), [0, 1, 0]);
    expectVec(rot(pose, 'LeftLeg'), [0, 0, 0, 1]);
    expect(Array.from(pose.dirty)).toEqual([0, 1, 1, 0, 0]);
    expect(m.view('flinchA')!.mask).toEqual({ from: 'Spine' });
    // without the mask the same clip takes all four bones
    const all = new Pose(rig);
    m.write('flinchA', { clip: id('all') }, 0);
    m.evaluate(all, 0);
    expect(Array.from(all.dirty)).toEqual([1, 1, 1, 1, 0]);
    expect(m.view('flinchA')!.mask).toBe(undefined);
  });

  it('a mask that names a bone the rig lacks plays nothing', () => {
    const { mixer: m, pose } = setup();
    m.write('flinchA', { clip: id('all'), mask: { from: 'Tail' } }, 0);
    m.evaluate(pose, 0);
    expect(Array.from(pose.dirty)).toEqual([0, 0, 0, 0, 0]);
  });
});
