import { describe, expect, it } from 'vitest';
import {
  clipFromJson,
  clipTime,
  clipToJson,
  findKey,
  makeTrack,
  sampleTrack,
  trackKeyCount,
  type CompiledClip,
} from '../../../src/compat/motion/clip.ts';
import { qAngle, qFromEulerXYZDeg } from '../../../src/compat/motion/quat.ts';

describe('findKey (binary search)', () => {
  const times = new Float32Array([0, 0.125, 0.25, 0.5]); // exact in Float32
  it('returns the key at or before t, clamped to [0, n-1]', () => {
    expect(findKey(times, -1)).toBe(0);
    expect(findKey(times, 0)).toBe(0);
    expect(findKey(times, 0.15)).toBe(1);
    expect(findKey(times, 0.25)).toBe(2);
    expect(findKey(times, 0.49)).toBe(2);
    expect(findKey(times, 0.5)).toBe(3);
    expect(findKey(times, 9)).toBe(3);
  });
});

describe('sampleTrack', () => {
  it('lerps positions and holds flat outside the keys', () => {
    const t = makeTrack('Hips', 'position', 'linear', [0.1, 0.3], [0, 0, 0, 2, 4, 6]);
    expect(trackKeyCount(t)).toBe(2);
    const out = [0, 0, 0];
    sampleTrack(t, 0.2, out, 0);
    expect(out[0]).toBeCloseTo(1, 6);
    expect(out[1]).toBeCloseTo(2, 6);
    expect(out[2]).toBeCloseTo(3, 6);
    sampleTrack(t, 0, out, 0);
    expect(out).toEqual([0, 0, 0]);
    sampleTrack(t, 5, out, 0);
    expect(out).toEqual([2, 4, 6]);
  });

  it('nlerps rotations with hemisphere alignment (motion §3.3.1 runtime interpolation)', () => {
    const a = qFromEulerXYZDeg([0, 0, 0, 0], 0, 0, 0, 0);
    const b = qFromEulerXYZDeg([0, 0, 0, 0], 0, 0, 0, 40).map((v) => -v);
    const t = makeTrack('Head', 'rotation', 'linear', [0, 1], [...a, ...b]);
    const out = [0, 0, 0, 0];
    sampleTrack(t, 0.5, out, 0);
    const want = qFromEulerXYZDeg([0, 0, 0, 0], 0, 0, 0, 20);
    expect(qAngle(out, 0, want, 0)).toBeLessThan(1e-6);
    expect(Math.hypot(...out)).toBeCloseTo(1, 6);
  });

  it('holds the earlier key for STEP tracks (viewmodel clips, motion §3.3.4)', () => {
    const t = makeTrack('gun', 'scale', 'step', [0, 0.5], [1, 1, 1, 0, 0, 0]);
    const out = [9, 9, 9];
    sampleTrack(t, 0.49, out, 0);
    expect(out).toEqual([1, 1, 1]);
    sampleTrack(t, 0.5, out, 0);
    expect(out).toEqual([0, 0, 0]);
  });
});

describe('clipTime (motion §3.5.3 time mapping)', () => {
  it('loops with t mod d', () => {
    expect(clipTime(2.5, 1, 'loop')).toBeCloseTo(0.5, 12);
    expect(clipTime(-0.25, 1, 'loop')).toBeCloseTo(0.75, 12);
  });
  it('ping-pongs with a triangle wave of period 2d', () => {
    expect(clipTime(0.25, 1, 'pingpong')).toBeCloseTo(0.25, 12);
    expect(clipTime(1.25, 1, 'pingpong')).toBeCloseTo(0.75, 12);
    expect(clipTime(2.25, 1, 'pingpong')).toBeCloseTo(0.25, 12);
  });
  it('holds the last frame for once', () => {
    expect(clipTime(3, 1.2, 'once')).toBe(1.2);
    expect(clipTime(-1, 1.2, 'once')).toBe(0);
  });
  it('answers 0 for an empty clip', () => {
    expect(clipTime(3, 0, 'loop')).toBe(0);
  });
});

describe('JSON form (virtual:ss/anim payload)', () => {
  it('round-trips a clip and drops absent optional fields', () => {
    const clip: CompiledClip = {
      id: 'anim/hollow.yml#walk',
      kind: 'delta',
      duration: 0.7,
      fps: 30,
      tracks: [makeTrack('Hips', 'rotation', 'linear', [0, 0.35], [0, 0, 0, 1, 0, 0.1, 0, 0.995])],
    };
    const json = clipToJson(clip);
    expect(json).toEqual({
      id: 'anim/hollow.yml#walk',
      kind: 'delta',
      duration: 0.7,
      fps: 30,
      tracks: [{ bone: 'Hips', prop: 'rotation', interp: 'linear', times: [0, 0.35], values: [0, 0, 0, 1, 0, 0.1, 0, 0.995] }],
    });
    expect('units' in json).toBe(false);
    const back = clipFromJson(JSON.parse(JSON.stringify(json)));
    expect(back.tracks[0]!.times).toBeInstanceOf(Float32Array);
    expect(clipToJson(back)).toEqual(json);
  });

  it('rejects malformed tracks', () => {
    expect(() => clipFromJson({ id: 'x', kind: 'delta', duration: 1, tracks: [{ bone: 'a', prop: 'rotation', interp: 'linear', times: [0], values: [0, 0, 0] }] })).toThrow(/values/);
    expect(() => makeTrack('a', 'position', 'linear', [0.2, 0.1], [0, 0, 0, 1, 1, 1])).toThrow(/ascending/);
  });
});
