// rng.ts and noise.ts (render §6.2: ctx.random is mulberry32 seeded with `seed ^ 0x9E3779B9`, restarted for every run;
// noise2d/noise3d are seedless gradient noise in [−1, 1]).
import { describe, expect, it } from 'vitest';
import { generatorRandom, mulberry32, RNG_SEED_MIX, seedOf } from '../../../../src/render/geometry/rng.ts';
import { noise2d, noise3d, PERLIN_PERMUTATION } from '../../../../src/render/geometry/noise.ts';

/** The published mulberry32 (Tommy Ettinger, the bryc/code PRNG collection), transcribed independently as the reference. */
function referenceMulberry32(a: number): () => number {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('rng', () => {
  it('mulberry32 matches the reference algorithm', () => {
    for (const seed of [0, 1, 7, 42, -5, 0x7fffffff, 0x9e3779b9 | 0, 123456789]) {
      const a = mulberry32(seed);
      const b = referenceMulberry32(seed);
      for (let i = 0; i < 64; i++) expect(a()).toBe(b());
    }
  });

  it('generator random is mulberry32 over seed ^ 0x9E3779B9 and restarts per call', () => {
    expect(RNG_SEED_MIX).toBe(0x9e3779b9);
    for (const seed of [0, 1, 3, 41, 1000]) {
      const r1 = generatorRandom(seed);
      const r2 = generatorRandom(seed);
      const ref = referenceMulberry32(seed ^ 0x9e3779b9);
      for (let i = 0; i < 32; i++) {
        const v = r1();
        expect(v).toBe(ref());
        expect(r2()).toBe(v);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThan(1);
      }
    }
  });

  it('coerces seeds like the integer xor does', () => {
    expect(seedOf(undefined)).toBe(0);
    expect(seedOf(null)).toBe(0);
    expect(seedOf(3.9)).toBe(3);
    expect(seedOf('12')).toBe(12);
    expect(seedOf('x')).toBe(0);
    expect(seedOf(2 ** 32 + 5)).toBe(5);
    expect(generatorRandom(3.9)()).toBe(generatorRandom(3)());
  });
});

describe('noise', () => {
  it('uses a permutation of 0..255', () => {
    expect(PERLIN_PERMUTATION).toHaveLength(256);
    expect(new Set(PERLIN_PERMUTATION).size).toBe(256);
    expect(Math.min(...PERLIN_PERMUTATION)).toBe(0);
    expect(Math.max(...PERLIN_PERMUTATION)).toBe(255);
  });

  it('is deterministic, bounded in [-1, 1] and not constant', () => {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < 4000; i++) {
      const x = (i * 0.731) % 97.3;
      const y = (i * 0.377) % 13.1;
      const z = (i * 1.913) % 51.7;
      const a = noise3d(x, y, z);
      expect(noise3d(x, y, z)).toBe(a);
      const b = noise2d(x, z);
      expect(noise2d(x, z)).toBe(b);
      for (const v of [a, b]) {
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
        min = Math.min(min, v);
        max = Math.max(max, v);
      }
    }
    expect(max - min).toBeGreaterThan(1);
  });

  it('is zero on the integer lattice and continuous between', () => {
    expect(noise3d(3, -2, 7)).toBeCloseTo(0, 12);
    expect(noise2d(-4, 11)).toBeCloseTo(0, 12);
    for (let i = 0; i < 200; i++) {
      const x = i * 0.137;
      const z = i * 0.291;
      expect(Math.abs(noise3d(x, 0.5, z) - noise3d(x + 1e-4, 0.5, z))).toBeLessThan(1e-2);
      expect(Math.abs(noise2d(x, z) - noise2d(x, z + 1e-4))).toBeLessThan(1e-2);
    }
  });
});
