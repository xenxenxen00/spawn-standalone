// The heightmap sampler (core §7.6, render §14.3, WP MP0): runs a place's `terrain.generator` (`heightAt`, `materialAt`) over
// a regular grid with `builtin/noise` and returns the heights plus six material weights per vertex (the `SPLAT6` layout of
// `TerrainBake`, ports.ts). Isomorphic and engine-free: the place bake (tools/maps/bake-place.ts, MP1) and tests run it in
// Node; generators never run on the browser main thread.
//
// The ctx follows the live contract (`engine/skills/heightmap-terrain.md:12`, contract §24): `heightAt` gets
// `{ x, z, noise, seedOffset(i) }`; `materialAt` adds `worldHeight`, `slope` (1 − normal.y; 0.29 = 45°), `height01` and
// `normal`, all of the sampled surface. `noise` is the `builtin/noise` module; `seedOffset(i)` is bound to the place's terrain
// seed. Marks (sea, clear-scatter) move no ground (`heightmap-terrain.md:30`), so heights are the generator's alone.
//
// Layout: vertex (ix, iz) sits at (originX + ix·cell, originZ + iz·cell) and is stored at iz·nx + ix (x fastest). Weights are
// `TERRAIN_WEIGHT_STRIDE` bytes per vertex in `grid.materials` order, summing to 255 (largest remainder), 0 when the generator
// has no `materialAt` or names no known material. The surface between vertices is two triangles per cell split along the
// (ix, iz)–(ix + 1, iz + 1) diagonal (`surfaceAt`); the bake's terrain triangles use the same split.
import { fbm2, seedOffset, simplex2, type Fbm2Options, type NoiseSeed, type Simplex2Options } from '../../builtin/noise.ts';

/** The `builtin/noise` surface a heightmap ctx exposes. */
export interface HeightmapNoise {
  fbm2(o: Fbm2Options): number;
  simplex2(o: Simplex2Options): number;
}

export interface HeightAtCtx {
  readonly x: number;
  readonly z: number;
  readonly noise: HeightmapNoise;
  /** the seed of the place's i-th noise layer */
  seedOffset(i: number): number;
}

export interface MaterialAtCtx extends HeightAtCtx {
  readonly worldHeight: number;
  /** 1 − normal.y (0.29 = 45°) */
  readonly slope: number;
  /** worldHeight over the vertical range (the sampled range when the place sets none), clamped to [0, 1] */
  readonly height01: number;
  readonly normal: Readonly<{ x: number; y: number; z: number }>;
}

/** `{ materialId: weight }` (any non-negative scale) or one material id. */
export type MaterialResult = Readonly<Record<string, number>> | string | null | undefined;

/** A place's `terrain.generator` module (`scripts/gen/mire-island/terrain.js`). */
export interface TerrainGenerator {
  heightAt(ctx: HeightAtCtx): number;
  materialAt?(ctx: MaterialAtCtx): MaterialResult;
}

export interface HeightmapGridGeometry {
  originX: number;
  originZ: number;
  /** metres between vertices */
  cell: number;
  nx: number;
  nz: number;
}

export interface HeightmapGrid extends HeightmapGridGeometry {
  /** the place's `terrain.seed` */
  seed: NoiseSeed;
  /** `terrain.materials[].id` in order (at most six); weights follow this order */
  materials?: readonly string[];
  /** `terrain.verticalRange`, for `height01` */
  verticalRange?: { min: number; max: number };
}

export interface HeightmapSample {
  heights: Float32Array;
  /** TERRAIN_WEIGHT_STRIDE per vertex, from materialAt */
  weights: Uint8Array;
}

/** core §7.6 */
export interface HeightmapSampler {
  sample(generator: TerrainGenerator, grid: HeightmapGrid): HeightmapSample;
}

export const TERRAIN_WEIGHT_STRIDE = 6;

/**
 * The the terrain calibration fixture grid the noise calibration was fitted on (builtin/noise NOISE_CALIBRATION.gain): 0.5 m over ±96 m, which
 * covers every row of the place (the rim fires stand at |x|, |z| ≈ 85) and the full rim blend (|x| >= 69, z <= -59).
 */
export const MIRE_ISLAND_GRID: Readonly<HeightmapGridGeometry> = Object.freeze({ originX: -96, originZ: -96, cell: 0.5, nx: 385, nz: 385 });

const BUILTIN_NOISE: HeightmapNoise = Object.freeze({ fbm2, simplex2 });

function checkGrid(g: HeightmapGridGeometry): void {
  const int2 = (n: number): boolean => Number.isInteger(n) && n >= 2;
  if (!int2(g.nx) || !int2(g.nz)) throw new RangeError(`heightmap grid: nx and nz must be integers >= 2 (got ${g.nx} × ${g.nz})`);
  if (!(Number.isFinite(g.cell) && g.cell > 0)) throw new RangeError(`heightmap grid: cell must be a positive number (got ${g.cell})`);
  if (!Number.isFinite(g.originX) || !Number.isFinite(g.originZ)) throw new RangeError('heightmap grid: non-finite origin');
}

/** Quantise weights to integers summing to 255 (largest remainder; ties go to the earlier material). */
function quantise(w: number[], out: Uint8Array, at: number): void {
  let total = 0;
  for (const v of w) total += v;
  if (!(total > 0) || !Number.isFinite(total)) return;
  const exact = w.map((v) => (v * 255) / total);
  const base = exact.map(Math.floor);
  let left = 255 - base.reduce((a, b) => a + b, 0);
  const order = exact.map((v, i) => ({ i, r: v - Math.floor(v) })).sort((a, b) => b.r - a.r || a.i - b.i);
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) base[order[k]!.i]!++;
  for (let i = 0; i < w.length; i++) out[at + i] = base[i]!;
}

export interface HeightmapSamplerOptions {
  /** the noise module the ctx exposes (default: builtin/noise) */
  noise?: HeightmapNoise;
  /** `seedOffset(seed, i)` (default: builtin/noise) */
  seedOffset?: (seed: NoiseSeed, i: number) => number;
}

export class HeightmapSamplerImpl implements HeightmapSampler {
  private readonly noise: HeightmapNoise;
  private readonly offset: (seed: NoiseSeed, i: number) => number;

  constructor(opts: HeightmapSamplerOptions = {}) {
    this.noise = opts.noise ?? BUILTIN_NOISE;
    this.offset = opts.seedOffset ?? seedOffset;
  }

  /** The generator's height at one point, through the same ctx the grid pass builds. */
  heightAt(generator: TerrainGenerator, seed: NoiseSeed, x: number, z: number): number {
    const so = (i: number): number => this.offset(seed, i);
    return generator.heightAt({ x, z, noise: this.noise, seedOffset: so });
  }

  sample(generator: TerrainGenerator, grid: HeightmapGrid): HeightmapSample {
    checkGrid(grid);
    const { originX, originZ, cell, nx, nz, seed } = grid;
    const materials = grid.materials ?? [];
    if (materials.length > TERRAIN_WEIGHT_STRIDE) {
      throw new Error(`heightmap: ${materials.length} terrain materials, but the splat holds six (${materials.join(', ')})`);
    }
    const noise = this.noise;
    const so = (i: number): number => this.offset(seed, i);
    const count = nx * nz;
    const h = new Float64Array(count);
    for (let iz = 0; iz < nz; iz++) {
      const z = originZ + iz * cell;
      for (let ix = 0; ix < nx; ix++) {
        const x = originX + ix * cell;
        const v = generator.heightAt({ x, z, noise, seedOffset: so });
        if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`heightmap: heightAt returned ${String(v)} at (${x}, ${z})`);
        h[iz * nx + ix] = v;
      }
    }
    const heights = Float32Array.from(h);
    const weights = new Uint8Array(count * TERRAIN_WEIGHT_STRIDE);
    const materialAt = generator.materialAt;
    if (!materialAt) return { heights, weights };

    let lo = grid.verticalRange?.min;
    let hi = grid.verticalRange?.max;
    if (lo === undefined || hi === undefined) {
      lo = Infinity;
      hi = -Infinity;
      for (const v of h) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    const span = hi - lo;
    const index = new Map(materials.map((id, i) => [id, i]));
    const w = new Array<number>(materials.length).fill(0);
    for (let iz = 0; iz < nz; iz++) {
      const z = originZ + iz * cell;
      const z0 = Math.max(0, iz - 1);
      const z1 = Math.min(nz - 1, iz + 1);
      for (let ix = 0; ix < nx; ix++) {
        const x = originX + ix * cell;
        const x0 = Math.max(0, ix - 1);
        const x1 = Math.min(nx - 1, ix + 1);
        const v = h[iz * nx + ix]!;
        const dx = (h[iz * nx + x1]! - h[iz * nx + x0]!) / ((x1 - x0) * cell);
        const dz = (h[z1 * nx + ix]! - h[z0 * nx + ix]!) / ((z1 - z0) * cell);
        const len = Math.sqrt(dx * dx + 1 + dz * dz);
        const normal = { x: -dx / len, y: 1 / len, z: -dz / len };
        const height01 = span > 0 ? Math.min(1, Math.max(0, (v - lo) / span)) : 0;
        const r = materialAt.call(generator, { x, z, noise, seedOffset: so, worldHeight: v, slope: 1 - normal.y, height01, normal });
        w.fill(0);
        if (typeof r === 'string') {
          const i = index.get(r);
          if (i !== undefined) w[i] = 1;
        } else if (r && typeof r === 'object') {
          for (const [id, val] of Object.entries(r)) {
            const i = index.get(id);
            if (i !== undefined && typeof val === 'number' && Number.isFinite(val) && val > 0) w[i] = val;
          }
        }
        quantise(w, weights, (iz * nx + ix) * TERRAIN_WEIGHT_STRIDE);
      }
    }
    return { heights, weights };
  }
}

/** Height of the sampled surface at (x, z): the cell's two triangles (split along its (0,0)–(1,1) diagonal). */
export function surfaceAt(sample: Pick<HeightmapSample, 'heights'>, grid: HeightmapGridGeometry, x: number, z: number): number {
  const { originX, originZ, cell, nx, nz } = grid;
  const u = (x - originX) / cell;
  const v = (z - originZ) / cell;
  const eps = 1e-9;
  if (!(u >= -eps && v >= -eps && u <= nx - 1 + eps && v <= nz - 1 + eps)) {
    throw new RangeError(`surfaceAt: (${x}, ${z}) lies outside the grid`);
  }
  const ix = Math.min(nx - 2, Math.max(0, Math.floor(u)));
  const iz = Math.min(nz - 2, Math.max(0, Math.floor(v)));
  const fx = Math.min(1, Math.max(0, u - ix));
  const fz = Math.min(1, Math.max(0, v - iz));
  const H = sample.heights;
  const h00 = H[iz * nx + ix]!;
  const h10 = H[iz * nx + ix + 1]!;
  const h01 = H[(iz + 1) * nx + ix]!;
  const h11 = H[(iz + 1) * nx + ix + 1]!;
  return fx >= fz ? h00 + fx * (h10 - h00) + fz * (h11 - h10) : h00 + fz * (h01 - h00) + fx * (h11 - h01);
}
