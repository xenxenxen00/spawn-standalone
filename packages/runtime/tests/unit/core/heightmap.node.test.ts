// WP MP0: the isomorphic heightmap sampler (core §7.6): runs a place's terrain generator (`heightAt`, `materialAt`) over a
// grid with `builtin/noise` → heights + 6-way material weights. The Mire Island acceptance is heightmap-mire.node.test.ts.
import { describe, expect, it } from 'vitest';
import { fbm2, seedOffset } from '../../../src/compat/builtin/noise.ts';
import {
  HeightmapSamplerImpl,
  TERRAIN_WEIGHT_STRIDE,
  surfaceAt,
  type HeightAtCtx,
  type HeightmapGrid,
  type MaterialAtCtx,
  type TerrainGenerator,
} from '../../../src/compat/core/ctx/heightmap.ts';

const grid = (over: Partial<HeightmapGrid> = {}): HeightmapGrid => ({ originX: -2, originZ: 10, cell: 0.5, nx: 9, nz: 5, seed: 7, ...over });

describe('HeightmapSamplerImpl.sample', () => {
  it('fills heights row-major (x fastest) at originX + ix·cell, originZ + iz·cell', () => {
    const g = grid();
    const { heights, weights } = new HeightmapSamplerImpl().sample({ heightAt: ({ x, z }) => x + 100 * z }, g);
    expect(heights).toBeInstanceOf(Float32Array);
    expect(heights.length).toBe(g.nx * g.nz);
    expect(weights).toBeInstanceOf(Uint8Array);
    expect(weights.length).toBe(TERRAIN_WEIGHT_STRIDE * g.nx * g.nz);
    for (let iz = 0; iz < g.nz; iz++) {
      for (let ix = 0; ix < g.nx; ix++) {
        const x = g.originX + ix * g.cell;
        const z = g.originZ + iz * g.cell;
        expect(heights[iz * g.nx + ix]).toBe(Math.fround(x + 100 * z));
      }
    }
  });

  it('hands heightAt the live ctx: x, z, noise.fbm2 (builtin/noise) and seedOffset bound to the grid seed', () => {
    const seen: HeightAtCtx[] = [];
    new HeightmapSamplerImpl().sample({ heightAt: (ctx) => (seen.push(ctx), 0) }, grid({ seed: 'mire' }));
    const ctx = seen[0]!;
    expect(ctx.seedOffset(0)).toBe(seedOffset('mire', 0));
    expect(ctx.seedOffset(5)).toBe(seedOffset('mire', 5));
    const o = { x: 1.5, z: 2.5, frequency: 1 / 18, octaves: 2, seed: ctx.seedOffset(0) };
    expect(ctx.noise.fbm2(o)).toBe(fbm2(o));
    expect(seen.length).toBe(9 * 5);
  });

  it('gives materialAt worldHeight, slope (1 − normal.y), height01 and the normal of the sampled surface', () => {
    const seen: MaterialAtCtx[] = [];
    const gen: TerrainGenerator = {
      heightAt: ({ x }) => 0.5 * x,
      materialAt: (ctx) => (seen.push(ctx), { rock: 1 }),
    };
    new HeightmapSamplerImpl().sample(gen, grid({ materials: ['rock'], verticalRange: { min: -10, max: 30 } }));
    const mid = seen.find((c) => c.x === 0 && c.z === 11)!;
    expect(mid.worldHeight).toBe(0);
    expect(mid.slope).toBeCloseTo(1 - 1 / Math.sqrt(1.25), 6);
    expect(mid.normal.x).toBeCloseTo(-0.5 / Math.sqrt(1.25), 6);
    expect(mid.normal.y).toBeCloseTo(1 / Math.sqrt(1.25), 6);
    expect(mid.normal.z).toBeCloseTo(0, 9);
    expect(mid.height01).toBeCloseTo(0.25, 9);
    expect(mid.seedOffset(5)).toBe(seedOffset(7, 5));
    // edges use one-sided differences: same plane, same slope
    const edge = seen.find((c) => c.x === -2 && c.z === 10)!;
    expect(edge.slope).toBeCloseTo(mid.slope, 6);
  });

  it('writes six weights per vertex in the material order, summing to 255; unknown ids paint nothing', () => {
    const materials = ['sand', 'wetsand', 'rock', 'soil', 'moss', 'ash'];
    const gen: TerrainGenerator = {
      heightAt: ({ x }) => x,
      materialAt: ({ x }) => (x < 0 ? { rock: 0.25, moss: 0.75, lava: 5 } : x === 0 ? 'ash' : { sand: 1, wetsand: 1, soil: 1 }),
    };
    const g = grid({ materials });
    const { weights } = new HeightmapSamplerImpl().sample(gen, g);
    for (let v = 0; v < g.nx * g.nz; v++) {
      const w = [...weights.subarray(v * 6, v * 6 + 6)];
      expect(w.reduce((a, b) => a + b, 0)).toBe(255);
      const x = g.originX + (v % g.nx) * g.cell;
      if (x < 0) expect(w).toEqual([0, 0, 64, 0, 191, 0]);
      else if (x === 0) expect(w).toEqual([0, 0, 0, 0, 0, 255]);
      else expect(w).toEqual([85, 85, 0, 85, 0, 0]);
    }
  });

  it('leaves weights at zero without materialAt, and rejects more than six materials or a bad grid', () => {
    const s = new HeightmapSamplerImpl();
    expect(s.sample({ heightAt: () => 1 }, grid()).weights.every((w) => w === 0)).toBe(true);
    expect(() => s.sample({ heightAt: () => 1, materialAt: () => ({ a: 1 }) }, grid({ materials: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] }))).toThrow(/six/);
    expect(() => s.sample({ heightAt: () => 1 }, grid({ nx: 1 }))).toThrow(RangeError);
    expect(() => s.sample({ heightAt: () => 1 }, grid({ cell: 0 }))).toThrow(RangeError);
    expect(() => s.sample({ heightAt: () => Number.NaN }, grid())).toThrow(/heightAt/);
  });

  it('is deterministic: two runs give identical bytes', () => {
    const gen: TerrainGenerator = {
      heightAt: ({ x, z, noise, seedOffset: so }) => 10 * noise.fbm2({ x, z, frequency: 1 / 18, octaves: 2, seed: so(0) }),
      materialAt: ({ x, z, noise, seedOffset: so, slope }) => {
        const n = noise.fbm2({ x, z, frequency: 1 / 9, octaves: 2, seed: so(5) });
        return { a: 0.5 + 0.5 * n, b: slope };
      },
    };
    const g = grid({ nx: 33, nz: 17, materials: ['a', 'b'] });
    const a = new HeightmapSamplerImpl().sample(gen, g);
    const b = new HeightmapSamplerImpl().sample(gen, g);
    expect(Buffer.from(a.heights.buffer).equals(Buffer.from(b.heights.buffer))).toBe(true);
    expect(Buffer.from(a.weights).equals(Buffer.from(b.weights))).toBe(true);
  });
});

describe('HeightmapSamplerImpl.heightAt and surfaceAt', () => {
  it('heightAt evaluates the generator at one point through the same ctx', () => {
    const gen: TerrainGenerator = { heightAt: ({ x, z, noise, seedOffset: so }) => x + noise.fbm2({ x, z, frequency: 0.1, octaves: 2, seed: so(0) }) };
    const s = new HeightmapSamplerImpl();
    expect(s.heightAt(gen, 7, 3.25, -1.5)).toBe(3.25 + fbm2({ x: 3.25, z: -1.5, frequency: 0.1, octaves: 2, seed: seedOffset(7, 0) }));
  });

  it('surfaceAt reproduces the vertices and interpolates planes exactly inside the grid', () => {
    const g = grid();
    const sample = new HeightmapSamplerImpl().sample({ heightAt: ({ x, z }) => 2 * x - 3 * z + 1 }, g);
    expect(surfaceAt(sample, g, g.originX + 2 * g.cell, g.originZ + 3 * g.cell)).toBeCloseTo(2 * (g.originX + 1) - 3 * (g.originZ + 1.5) + 1, 4);
    for (const [x, z] of [[-1.7, 10.2], [0.13, 11.9], [1.99, 10.01]] as const) {
      expect(surfaceAt(sample, g, x, z)).toBeCloseTo(2 * x - 3 * z + 1, 4);
    }
    expect(() => surfaceAt(sample, g, -3, 10)).toThrow(RangeError);
  });
});
