// The engine cook rule for authored clips (docs/design/motion-physics-nav.md §3.3.1, D-MPN-04), on synthetic clips.
import { describe, expect, it } from 'vitest';
import {
  SS_COMPILED,
  authoredIdentity,
  compiledOf,
  cookAuthoredClip,
  cookAuthoredFile,
  cookTracks,
  isAuthoredClipObject,
  toTracks,
  type AuthoredClipObject,
} from '../../../src/compat/motion/cook-authored.ts';
import { SUBDIVIDE_ANGLE_DEG } from '../../../src/compat/motion/constants.ts';
import { qAngle, qFromEulerXYZDeg } from '../../../src/compat/motion/quat.ts';

const q = (p: number, y: number, r: number): number[] => qFromEulerXYZDeg([0, 0, 0, 0], 0, p, y, r);
const closeArr = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-9): void => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(Math.abs(a[i]! - b[i]!), `[${i}]`).toBeLessThanOrEqual(eps);
};

describe('cookTracks: key times', () => {
  it('spreads bare lists over duration and treats one value as a constant at t 0', () => {
    const r = cookTracks({ duration: 0.6, tracks: { Hips: { y: [0, 0.3, 0.6, 0.9], x: [0.25] } } });
    expect(r.tracks).toHaveLength(1);
    const t = r.tracks[0]!;
    expect(t.prop).toBe('position');
    closeArr(t.times, [0, 0.2, 0.4, 0.6]);
    closeArr(t.values, [0.25, 0, 0, 0.25, 0.3, 0, 0.25, 0.6, 0, 0.25, 0.9, 0]);
  });

  it('takes the union of the group key times, dedupes exact equals only, and holds flat outside a component', () => {
    const r = cookTracks({
      duration: 1,
      tracks: { Arm: { pitch: [[0, 0], [0.5, 10], [1, 20]], yaw: [[0.5, 4], [0.5004, 8]] } },
    });
    const t = r.tracks[0]!;
    closeArr(t.times, [0, 0.5, 0.5004, 1]);
    // yaw is held at 4 before 0.5 and at 8 after 0.5004; pitch is linear between its keys; roll is 0
    const want = [q(0, 4, 0), q(10, 4, 0), q(10.008, 8, 0), q(20, 8, 0)].flat();
    closeArr(t.values, want, 1e-12);
  });

  it('orders tracks by bone (authored order) with rotation before position', () => {
    const r = cookTracks({ duration: 1, tracks: { Spine: { z: [0, 1] }, Hips: { roll: [0, 5], y: [0, 1] } } });
    expect(r.tracks.map((t) => `${t.bone}.${t.prop}`)).toEqual(['Spine.position', 'Hips.rotation', 'Hips.position']);
  });

  it('defaults fps to 30 and derives a missing duration from the keys', () => {
    expect(cookTracks({ tracks: { A: { pitch: [[0, 0], [0.4, 9]] } } })).toMatchObject({ duration: 0.4, fps: 30 });
    expect(cookTracks({ fps: 10, tracks: { A: { pitch: [0, 1, 2] } } })).toMatchObject({ duration: 0.2, fps: 10 });
  });
});

describe('cookTracks: rotation values and subdivision', () => {
  it('composes qX(pitch)·qY(yaw)·qZ(roll) in degrees', () => {
    const r = cookTracks({ duration: 1, tracks: { B: { pitch: [30], yaw: [-50], roll: [70] } } });
    closeArr(r.tracks[0]!.values, q(30, -50, 70), 1e-12);
  });

  it(`inserts the Euler midpoint where a multi-axis segment turns more than ${SUBDIVIDE_ANGLE_DEG}°`, () => {
    // hollow.yml#swipe_l LeftArm 0.458 → 0.509 (62.15°): the engine cache has a key at 0.4835
    const r = cookTracks({
      duration: 1,
      tracks: { LeftArm: { pitch: [[0.458, -5.57], [0.509, -52.51]], yaw: [[0.458, -2.45], [0.509, -18.88]], roll: [[0.458, 3.12], [0.509, 33.63]] } },
    });
    const t = r.tracks[0]!;
    closeArr(t.times, [0.458, 0.4835, 0.509]);
    closeArr(t.values.slice(4, 8), q((-5.57 - 52.51) / 2, (-2.45 - 18.88) / 2, (3.12 + 33.63) / 2), 1e-12);
  });

  it('subdivides recursively until every multi-axis segment is within the limit', () => {
    const r = cookTracks({ duration: 1, tracks: { A: { pitch: [[0, 0], [1, 170]], yaw: [[0, 0], [1, 60]] } } });
    const { times, values } = r.tracks[0]!;
    expect(times.length).toBeGreaterThan(3);
    for (let i = 0; i + 1 < times.length; i++) {
      expect(qAngle(values, i * 4, values, i * 4 + 4) * (180 / Math.PI)).toBeLessThanOrEqual(SUBDIVIDE_ANGLE_DEG);
    }
  });

  it('never subdivides a single-axis segment (slerp already follows it)', () => {
    // skitter.yml#lunge LeftForeArm 0.344 → 0.394 turns 76.8° about X and keeps two keys in the engine cache
    const r = cookTracks({ duration: 1, tracks: { LeftForeArm: { pitch: [[0.344, 0], [0.394, 76.8]] } } });
    closeArr(r.tracks[0]!.times, [0.344, 0.394]);
  });

  it('keeps segments at or under the limit as they are', () => {
    const r = cookTracks({ duration: 1, tracks: { A: { pitch: [[0, 0], [1, 40]], yaw: [[0, 0], [1, 20]] } } });
    closeArr(r.tracks[0]!.times, [0, 1]);
  });
});

describe('cookAuthoredClip / cookAuthoredFile', () => {
  const file = {
    walk: { duration: 0.5, tracks: { Hips: { roll: [0, 3, 0], y: [-0.1, -0.05, -0.1] } } },
    note: 'not a clip',
    idle: { duration: 2, tracks: { Head: { pitch: [5] } } },
  };

  it('builds delta clips with the engine identity anim/<file>.yml#<clip>', () => {
    expect(authoredIdentity('anim/hollow.yml', 'walk')).toBe('anim/hollow.yml#walk');
    const c = cookAuthoredClip('anim/hollow.yml#walk', file.walk);
    expect(c).toMatchObject({ id: 'anim/hollow.yml#walk', kind: 'delta', duration: 0.5, fps: 30 });
    expect(c.tracks.map((t) => `${t.bone}.${t.prop}.${t.interp}`)).toEqual(['Hips.rotation.linear', 'Hips.position.linear']);
    expect(c.tracks[0]!.times).toBeInstanceOf(Float32Array);
  });

  it('cooks every clip of a parsed file in authored order and skips non-clip entries', () => {
    const clips = cookAuthoredFile('anim/hollow.yml', file);
    expect(clips.map((c) => c.id)).toEqual(['anim/hollow.yml#walk', 'anim/hollow.yml#idle']);
    expect(() => cookAuthoredFile('anim/x.yml', [1, 2])).toThrow(/anim\/x\.yml/);
  });

  it('recognises authored clip objects', () => {
    expect(isAuthoredClipObject(file.walk)).toBe(true);
    expect(isAuthoredClipObject({ duration: 1 })).toBe(false);
    expect(isAuthoredClipObject(null)).toBe(false);
  });

  it('serves the compiled clip attached to an object, else cooks once per object', () => {
    const obj: AuthoredClipObject = { name: 'swing', duration: 1, tracks: { A: { pitch: [0, 10] } } };
    const a = compiledOf(obj);
    expect(a.id).toBe('inline#swing');
    expect(compiledOf(obj)).toBe(a);
    const pre = cookAuthoredClip('anim/rake.yml#swing', obj);
    const tagged = Object.defineProperty({ ...obj }, SS_COMPILED, { value: pre, enumerable: false });
    expect(compiledOf(tagged)).toBe(pre);
  });

  it('toTracks gives the engine shape with plain arrays (api:1414)', () => {
    const t = toTracks({ name: 'walk', duration: 0.5, tracks: { Hips: { y: [0, 1] } } });
    expect(t).toEqual({ name: 'walk', duration: 0.5, fps: 30, tracks: [{ bone: 'Hips', prop: 'position', times: [0, 0.5], values: [0, 0, 0, 0, 1, 0] }] });
  });
});
