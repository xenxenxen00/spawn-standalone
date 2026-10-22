// Deterministic noise contracts and synthetic optional field conditioning.
import { describe, expect, it } from 'vitest';
import {
  NOISE_CALIBRATION,
  SIMPLEX_SUP,
  createNoise,
  fbm2,
  seedKey,
  seedOffset,
  simplex2,
  type NoiseCalibration,
} from '../../../src/compat/builtin/noise.ts';

/** A fixed pseudo-random walk over the plane (no Math.random: the test is deterministic). */
function points(n: number, span: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let s = 0x2545f491;
  const next = (): number => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
  for (let i = 0; i < n; i++) out.push([(next() - 0.5) * span, (next() - 0.5) * span]);
  return out;
}

describe('seedKey / seedOffset', () => {
  it('maps every seed to a uint32, integers to themselves and strings by hash', () => {
    expect(seedKey(7)).toBe(7);
    expect(seedKey(0)).toBe(0);
    expect(seedKey(undefined)).toBe(0);
    expect(seedKey(-1)).toBe(0xffffffff);
    expect(seedKey('mire-island')).toBe(seedKey('mire-island'));
    expect(seedKey('mire-island')).not.toBe(seedKey('mire-islane'));
    expect(seedKey(7.5)).toBe(seedKey('7.5'));
    for (const s of [7, 'x', 2.25, -3, 1e12]) {
      const k = seedKey(s);
      expect(Number.isInteger(k) && k >= 0 && k <= 0xffffffff, String(s)).toBe(true);
    }
  });

  it('is deterministic, a uint32, and differs per index and per base seed', () => {
    expect(seedOffset(7, 0)).toBe(seedOffset(7, 0));
    expect(seedOffset('7', 0)).toBe(seedOffset('7', 0));
    const seen = new Set<number>();
    for (const base of [0, 1, 7, 'mire-island']) {
      for (let i = 0; i < 8; i++) {
        const v = seedOffset(base, i);
        expect(Number.isInteger(v) && v >= 0 && v <= 0xffffffff).toBe(true);
        seen.add(v);
      }
    }
    expect(seen.size).toBe(32);
  });
});

describe('simplex2', () => {
  it('stays in [-1, 1], reaches close to both ends, and is continuous', () => {
    let lo = 0;
    let hi = 0;
    for (const [x, z] of points(40_000, 400)) {
      const v = simplex2({ x, z, seed: 3 });
      expect(v).toBeGreaterThanOrEqual(-1);
      expect(v).toBeLessThanOrEqual(1);
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
      const d = Math.abs(simplex2({ x: x + 1e-4, z, seed: 3 }) - v);
      expect(d).toBeLessThan(1e-2);
    }
    expect(hi).toBeGreaterThan(0.85);
    expect(lo).toBeLessThan(-0.85);
  });

  it('scales by its measured supremum so the peak is 1', () => {
    expect(SIMPLEX_SUP).toBeGreaterThan(0.99);
    expect(SIMPLEX_SUP).toBeLessThan(1);
  });

  it('honours frequency and amplitude, and answers 0 for non-finite input', () => {
    const a = simplex2({ x: 3.3, z: -7.1, frequency: 1 / 10, seed: 9 });
    expect(simplex2({ x: 0.33, z: -0.71, seed: 9 })).toBeCloseTo(a, 12);
    expect(simplex2({ x: 3.3, z: -7.1, frequency: 1 / 10, amplitude: 4, seed: 9 })).toBeCloseTo(4 * a, 12);
    expect(simplex2({ x: Number.NaN, z: 1 })).toBe(0);
    expect(simplex2({ x: 1, z: Number.POSITIVE_INFINITY })).toBe(0);
  });
});

describe('fbm2', () => {
  it('is deterministic per seed: same inputs, same value, also from a fresh instance', () => {
    const fresh = createNoise(NOISE_CALIBRATION);
    for (const [x, z] of points(500, 300)) {
      for (const seed of [7, seedOffset(7, 0), 'mire-island']) {
        const o = { x, z, frequency: 1 / 18, octaves: 2, seed };
        const v = fbm2(o);
        expect(fbm2(o)).toBe(v);
        expect(fresh.fbm2(o)).toBe(v);
      }
    }
  });

  it('gives different fields for different seeds', () => {
    let same = 0;
    for (const [x, z] of points(400, 300)) {
      if (Math.abs(fbm2({ x, z, frequency: 1 / 18, octaves: 2, seed: 1 }) - fbm2({ x, z, frequency: 1 / 18, octaves: 2, seed: 2 })) < 1e-9) same++;
    }
    expect(same).toBeLessThan(5);
  });

  it('stays in [-1, 1] for every octave count, frequency and seed', () => {
    for (const octaves of [1, 2, 3, 5, 8]) {
      for (const seed of [0, 7, 'a', seedOffset(7, 5)]) {
        for (const [x, z] of points(4_000, 600)) {
          const v = fbm2({ x, z, frequency: 1 / 9, octaves, seed });
          expect(v).toBeGreaterThanOrEqual(-1);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it('defaults frequency 1, octaves 4, gain 0.5, lacunarity 2, amplitude 1', () => {
    const o = { x: 12.25, z: -3.5, seed: 11 };
    expect(fbm2(o)).toBe(fbm2({ ...o, frequency: 1, octaves: 4, gain: 0.5, lacunarity: 2, amplitude: 1 }));
    expect(fbm2({ ...o, amplitude: 3 })).toBeCloseTo(3 * fbm2(o), 12);
    expect(fbm2({ x: Number.NaN, z: 0 })).toBe(0);
  });

  it('is coherent: a small step moves the value a little', () => {
    for (const [x, z] of points(2_000, 300)) {
      const a = fbm2({ x, z, frequency: 1 / 18, octaves: 2, seed: 4 });
      const b = fbm2({ x: x + 0.01, z, frequency: 1 / 18, octaves: 2, seed: 4 });
      expect(Math.abs(a - b)).toBeLessThan(0.01);
    }
  });

  it('has no default authored field conditioning', () => {
    expect(NOISE_CALIBRATION.conditioning).toEqual([]);
  });

  it('custom synthetic anchors constrain only their exact call and compact support', () => {
    const c = {
      seed: 17, frequency: 0.25, octaves: 2, radius: 2,
      anchors: [{ x: 0, z: 0, n: 0.25, row: 'test-a' }, { x: 4, z: 0, n: -0.25, row: 'test-b' }],
    };
    const calibration: NoiseCalibration = { ...NOISE_CALIBRATION, conditioning: [c] };
    const conditioned = createNoise(calibration);
    const plain = createNoise(NOISE_CALIBRATION);
    for (const anchor of c.anchors) {
      const input = { x: anchor.x, z: anchor.z, frequency: c.frequency, octaves: c.octaves, seed: c.seed };
      expect(conditioned.fbm2(input), anchor.row).toBeCloseTo(anchor.n, 9);
      for (const other of [{ ...input, octaves: 3 }, { ...input, seed: 18 }, { ...input, frequency: 0.5 }]) {
        expect(conditioned.fbm2(other)).toBe(plain.fbm2(other));
      }
    }
    const atAnchor = { x: 0, z: 0, frequency: c.frequency, octaves: c.octaves, seed: c.seed };
    expect(conditioned.fbm2(atAnchor)).not.toBe(plain.fbm2(atAnchor));
    const far = { x: 20, z: 20, frequency: c.frequency, octaves: c.octaves, seed: c.seed };
    expect(conditioned.fbm2(far)).toBe(plain.fbm2(far));
  });
});
