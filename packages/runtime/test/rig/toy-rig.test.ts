// A 7-bone rigid toy rig end to end through the existing motion code: `skeleton()` parsing, `ctx.bone` on the real geometry
// recorder, an authored clip on a `gait` channel of the existing mixer (via AnimChannels' createMixer), clip + bone-channel
// composition, and a row attached to the `body` bone by BoneAttachmentResolver.
import { describe, expect, it } from 'vitest';
import type { RowRec } from '../../src/compat/core/types.ts';
import { createAnimChannels } from '../../src/compat/motion/anim-channel.ts';
import { BoneAttachmentResolver } from '../../src/compat/motion/attach.ts';
import { ClipRegistry } from '../../src/compat/motion/clip-registry.ts';
import { Pose } from '../../src/compat/motion/pose.ts';
import { createRecording } from '../../src/render/geometry/recorder.ts';
import {
  RigMixer,
  SkeletonError,
  adoptBoneChannels,
  attachBoneCursor,
  createBonesChannel,
  createRigMixer,
  parseSkeleton,
  rigFromSkeleton,
  skinPoint,
} from '../../src/render/rig/index.ts';
import { RUN, TOY7, dist } from './fixtures.ts';

const rig = rigFromSkeleton('toy7', parseSkeleton(TOY7));

function fakeRow(id: string, props: Record<string, unknown>, parentId: string | null = null, pos = { x: 0, y: 0, z: 0 }): RowRec {
  return {
    id,
    parentId,
    phase: 'alive',
    place: 'main',
    props,
    tf: { pos, rot: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } },
  } as unknown as RowRec;
}

describe('skeleton()', () => {
  it('parses the 7 bones, parents first, pivots in the model rest frame', () => {
    expect(rig.bones).toEqual(['root', 'body', 'eyes', 'legL', 'legR', 'armL', 'armR']);
    expect([...rig.parent]).toEqual([-1, 0, 1, 0, 0, 1, 1]);
    // eyes: local = pivot − body pivot, bind model = its own pivot
    expect([...rig.bindT.subarray(6, 9)].map((v) => +v.toFixed(5))).toEqual([0, 0.58, -0.42]);
    expect([...rig.bindModel.subarray(2 * 16 + 12, 2 * 16 + 15)].map((v) => +v.toFixed(5))).toEqual([0, 0.7, -0.42]);
  });

  it('rejects unknown parents, cycles and bad pivots', () => {
    expect(() => parseSkeleton({ a: { parent: 'nope', pivot: [0, 0, 0] } })).toThrow(SkeletonError);
    expect(() => parseSkeleton({ a: { parent: 'b', pivot: [0, 0, 0] }, b: { parent: 'a', pivot: [0, 0, 0] } })).toThrow(/ancestor/);
    expect(() => parseSkeleton({ a: { pivot: [0, 'x', 0] } })).toThrow(/pivot/);
    expect(() => parseSkeleton({})).toThrow(/no bones/);
    // children declared before their parent are reordered
    expect(parseSkeleton({ c: { parent: 'r', pivot: [0, 1, 0] }, r: { pivot: [0, 0, 0] } }).bones.map((b) => b.name)).toEqual(['r', 'c']);
  });
});

describe('ctx.bone on the geometry recorder', () => {
  it('binds every triangle after a call to that bone, until the next call', () => {
    const rec = createRecording({ script: 'scripts/gen/toy.js' }, 1);
    const cursor = attachBoneCursor(rec, rig, { strict: true });
    const ctx = rec.ctx as unknown as { bone(n: string): void; tri(...v: number[]): void; quad(...v: number[]): void };
    ctx.bone('legL');
    ctx.tri(0, 0, 0, 1, 0, 0, 0, 1, 0);
    ctx.bone('body');
    ctx.quad(0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0); // 2 triangles
    ctx.bone('armR');
    ctx.tri(0, 0, 0, 1, 0, 0, 0, 1, 0);
    ctx.bone('body'); // a second run of the same bone
    ctx.tri(0, 0, 0, 1, 0, 0, 0, 1, 0);
    const mesh = rec.take({ uvs: null, uvProjection: 'triplanar' });
    expect(mesh.tris).toBe(5);
    expect([...cursor.triBone(mesh.tris)].map((b) => rig.bones[b])).toEqual(['legL', 'body', 'body', 'armR', 'body']);
    expect(cursor.unbound).toBe(0);
    expect(cursor.used).toEqual(['legL', 'body', 'armR']);
    expect(() => ctx.bone('tail')).toThrow(/names no bone/);
  });
});

describe('an authored clip on the gait channel of the existing mixer', () => {
  it('AnimChannels makes RigMixers through createMixer and the run clip poses the legs at t = 0.17 s', () => {
    const channels = createAnimChannels({ registry: new ClipRegistry(), createMixer: createRigMixer });
    const row = fakeRow('bean', { mixer: { gait: { clip: RUN, loop: 'loop', speed: 1, blendIn: 0.08 } } });
    channels.rowSpawned(row);
    const mixer = channels.get('bean')!;
    expect(mixer).toBeInstanceOf(RigMixer);
    channels.setRig(row, rig);
    channels.advanceTick(0.17);
    const pose = new Pose(rig);
    mixer.evaluate(pose, 0);
    const legL = rig.index('legL'), legR = rig.index('legR');
    expect(pose.r[legL * 4]).toBeCloseTo(0.38268, 4); // +45° pitch
    expect(pose.r[legR * 4]).toBeCloseTo(-0.38268, 4);
    // the foot turns about the hip pivot: the pivot stays, a point below it swings forward (−Z is forward, +pitch lifts it back)
    pose.updateModel();
    const hip = TOY7.legL!.pivot;
    expect(dist(skinPoint(pose, 'legL', hip)!, hip)).toBeLessThan(1e-6);
    const foot = skinPoint(pose, 'legL', [hip[0], hip[1] - 0.2, hip[2]])!;
    expect(foot[1]).toBeCloseTo(hip[1] - 0.2 * Math.SQRT1_2, 4);
    expect(Math.abs(foot[2])).toBeCloseTo(0.2 * Math.SQRT1_2, 4);
  });

  it('bone channels compose over the clip (clip R · channel R, clip T + y) and leave unnamed bones alone', () => {
    const mixer = new RigMixer('bean', rig);
    mixer.write('gait', { clip: RUN, loop: 'loop', blendIn: 0 }, 0);
    mixer.advanceTick(0.17);
    const clipOnly = new Pose(rig);
    mixer.evaluate(clipOnly, 0);
    const host = { ensure: () => mixer };
    const channel = createBonesChannel(host);
    const row = fakeRow('bean', { bones: { legL: { pitch: -45 }, body: { y: 0.1 } } });
    channel.onWrite!(row, row.props['bones'], undefined, []);
    const pose = new Pose(rig);
    mixer.evaluate(pose, 0);
    const legL = rig.index('legL'), body = rig.index('body'), armL = rig.index('armL');
    expect(pose.r[legL * 4]).toBeCloseTo(0, 5); // +45 from the clip, −45 from the channel
    expect(pose.r[legL * 4 + 3]).toBeCloseTo(1, 5);
    expect(pose.t[body * 3 + 1]).toBeCloseTo(clipOnly.t[body * 3 + 1]! + 0.1, 6);
    expect([...pose.r.subarray(armL * 4, armL * 4 + 4)]).toEqual([...clipOnly.r.subarray(armL * 4, armL * 4 + 4)]);
    // evaluating again does not accumulate
    mixer.evaluate(pose, 0);
    expect(pose.t[body * 3 + 1]).toBeCloseTo(clipOnly.t[body * 3 + 1]! + 0.1, 6);
    // a spawn-time `bones` spec is adopted
    const other = new RigMixer('b2', rig);
    adoptBoneChannels({ ensure: () => other }, fakeRow('b2', { bones: { armR: { roll: 30 } } }));
    expect(other.boneChannels().get('armR')).toEqual({ pitch: 0, yaw: 0, roll: 30, y: 0 });
  });
});

describe('a row attached to the body bone', () => {
  it('follows body through the clip (BoneAttachmentResolver over the RigMixer, bone frame at the pivot)', () => {
    const mixer = new RigMixer('bean', rig);
    mixer.write('gait', { clip: RUN, loop: 'loop', blendIn: 0 }, 0);
    const clock = { tick: 0 };
    const bean = fakeRow('bean', {}, null, { x: 2, y: 0, z: 3 });
    const hat = fakeRow('hat', { attachment: { bone: 'body' } }, 'bean', { x: 0, y: 0.62, z: 0 });
    const rows = new Map([
      ['bean', bean],
      ['hat', hat],
    ]);
    const resolver = new BoneAttachmentResolver({ rows, mixers: { get: (id) => (id === 'bean' ? mixer : undefined) }, clock });
    const at = (): number[] => {
      const w = resolver.worldPose(hat)!;
      return [w.pos.x, w.pos.y, w.pos.z];
    };
    const rest = at(); // t = 0: body.y = 0, pitch −10°, roll −5°
    expect(dist(rest, [2, 0.74, 3])).toBeLessThan(0.15);
    expect(dist(rest, [2, 0.74, 3])).toBeGreaterThan(0.01);
    // t = 0.085 s: body.y = +0.07, pitch −14°: the hat rises by the y track and leans with the body
    mixer.advanceTick(0.085);
    clock.tick++;
    const up = at();
    const pose = new Pose(rig);
    mixer.evaluate(pose, 0);
    pose.updateModel();
    const b = rig.index('body');
    const m = pose.model.subarray(b * 16, b * 16 + 16);
    const want = [2 + m[4]! * 0.62 + m[12]!, m[5]! * 0.62 + m[13]!, 3 + m[6]! * 0.62 + m[14]!];
    expect(dist(up, want)).toBeLessThan(1e-5);
    expect(m[13]! - 0.12).toBeCloseTo(0.07, 5); // the body pivot rose 0.07 m
    // a bone channel on body moves the hat too (the resolver's sim pose is the RigMixer's)
    mixer.setBoneChannels({ body: { y: 0.5 } });
    resolver.invalidate();
    expect(at()[1]! - up[1]!).toBeCloseTo(0.5, 5);
  });
});
