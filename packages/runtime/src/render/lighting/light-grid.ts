// The static world light grid (docs/design/rendering.md §8.2; D3; WP R1b): for every 8 m cell of a place, the list of static
// lights that can reach it, ranked, capped by the tier and packed into two float textures the grid light loop reads.
//
// Built once per place after its rows are in, and again only when the tier changes its caps or a light joins the static
// block. Lamps that flicker, die or black out change texels of the light texture (light-table.ts); the lists stay.
//
//   bounds      the AABB of all rows + 10 m (`GRID_MARGIN`), handed in by the bridge; without it, the AABB of the static
//               lights' positions + 10 m. Cells are 8 m cubes (`GRID_CELL`). A point outside is shaded with the nearest
//               border cell's list (the loop clamps the coordinate).
//   candidates  a light is a candidate of every cell its sphere (radius = cut-off) reaches.
//   score       the light's maximum radiance over the cell: `intensity × window(d) / max(d^decay, 1)` at the cell's nearest
//               point, `d` its distance (render §8.2 writes d²: every live row has decay 2). The intensity is the light's
//               peak, so a dimmed lamp keeps its place. A spot scores 0 when the whole cell lies in the dark part of its
//               cone **as rendered** (FX-25): outside the cone for a normal one, inside it for the inverted live cones.
//               The test is conservative (the cell's bounding sphere against the cone), so it never removes a cell the
//               light reaches. A spot marked `sweep` turns at run time and is scored without its cone.
//   cap         the top `lightsPerCell` (24 / 16 / 8 / 6 per tier) stay, best first; equal scores go to the light created
//               first. The result does not depend on the order of the input.
//   fx lights   of the fire lights only the brightest `fxLights` of the place (all / all / 8 / 4 per tier) take part.
//
// Storage (render §8.2 [D]):
//   cellHeadTex   RG32F, one texel per cell: (offset into the index texture, count)
//   cellIdxTex    R32F, 4,096 wide: the packed lists; a value is a slot of the light texture's static block
// Both are read with `textureLoad` at `ivec2(i % 4096, i / 4096)`; the values are exact integers in float channels (below
// 2²⁴). A cell's linear index is `x + nx · (y + ny · z)`.
import { DataTexture, FloatType, NearestFilter, RGFormat, RedFormat } from 'three/webgpu';
import type { Vec3 } from '../../compat/core/types.ts';
import type { GridLight } from './light-table.ts';

/** cell edge, metres */
export const GRID_CELL = 8;
/** added around the bounds, metres */
export const GRID_MARGIN = 10;
/** row length of the cell textures: a linear index `i` is the texel `(i % 4096, i / 4096)` */
export const CELL_TEXTURE_WIDTH = 4096;
/** the worst live map has about 32,500 cells; a grid above this is a mistake in the bounds */
export const MAX_GRID_CELLS = 262_144;

export interface GridBounds {
  min: Vec3;
  max: Vec3;
}

export interface GridBuildOptions {
  /** the AABB of all rows of the place (the margin is added here); default: the static lights' positions */
  bounds?: GridBounds | null;
  /** `TierConfig.lightsPerCell` */
  lightsPerCell: number;
  /** `TierConfig.fxLights`: the brightest n fire lights of the place; `Infinity` = all */
  fxLights: number;
}

export interface LightGridData {
  /** world position of the grid's minimum corner */
  origin: [number, number, number];
  /** cells along x, y, z */
  dims: [number, number, number];
  cellCount: number;
  /** per cell: offset into `indices`, count */
  head: Float32Array;
  /** the packed lists: static block slots, best first within a cell */
  indices: Float32Array;
  /** entries of `indices` in use */
  listed: number;
  /** the longest list */
  maxPerCell: number;
  /** the most candidates any cell had before the cap */
  maxCandidates: number;
  /** cells whose list the cap shortened */
  cappedCells: number;
}

/** radius of the sphere around an 8 m cell */
const CELL_BOUND = (GRID_CELL * Math.sqrt(3)) / 2;

/** the linear cell index of a world point: floor((p − origin) / 8), clamped to the grid */
export function cellIndexAt(grid: Pick<LightGridData, 'origin' | 'dims'>, x: number, y: number, z: number): number {
  const { origin, dims } = grid;
  const cx = Math.min(dims[0] - 1, Math.max(0, Math.floor((x - origin[0]) / GRID_CELL)));
  const cy = Math.min(dims[1] - 1, Math.max(0, Math.floor((y - origin[1]) / GRID_CELL)));
  const cz = Math.min(dims[2] - 1, Math.max(0, Math.floor((z - origin[2]) / GRID_CELL)));
  return cx + dims[0] * (cy + dims[1] * cz);
}

/** the list of a cell: static block slots, best first (allocates: for tools and tests) */
export function cellLights(grid: Pick<LightGridData, 'head' | 'indices'>, cell: number): number[] {
  const offset = grid.head[cell * 2]!;
  const count = grid.head[cell * 2 + 1]!;
  return Array.from(grid.indices.subarray(offset, offset + count));
}

/**
 * The score of a light for the cell whose minimum corner is (minX, minY, minZ) (render §8.2): its largest radiance over
 * the cell, 0 when the cell is out of reach or wholly in the dark part of a spot's as-rendered cone.
 */
export function cellScore(light: GridLight, minX: number, minY: number, minZ: number): number {
  const ax = light.x < minX ? minX - light.x : light.x > minX + GRID_CELL ? light.x - minX - GRID_CELL : 0;
  const ay = light.y < minY ? minY - light.y : light.y > minY + GRID_CELL ? light.y - minY - GRID_CELL : 0;
  const az = light.z < minZ ? minZ - light.z : light.z > minZ + GRID_CELL ? light.z - minZ - GRID_CELL : 0;
  const d = Math.sqrt(ax * ax + ay * ay + az * az);
  const cutoff = light.cutoff;
  if (!(d < cutoff)) return 0;
  const q = d / cutoff;
  const w = 1 - q * q * q * q;
  const score = (light.intensity * w * w) / Math.max(d ** light.decay, 1);
  if (!(score > 0)) return 0;
  if (light.kind === 'spot' && !light.sweep && cellInDarkPartOfCone(light, minX, minY, minZ)) return 0;
  return score;
}

/**
 * True when no point of the cell's bounding sphere can be lit by the spot. The loop's term is
 * `ssSmoothstep(coneCos, penumbraCos, cos θ)`, θ the angle at the light between the lit direction (towards the target) and
 * the surface point: positive where `cos θ > coneCos` for ordinary edges, where `cos θ < coneCos` for inverted ones
 * (coneCos > penumbraCos), and where `cos θ ≥ coneCos` when they are equal.
 */
function cellInDarkPartOfCone(light: GridLight, minX: number, minY: number, minZ: number): boolean {
  const half = GRID_CELL / 2;
  const vx = minX + half - light.x;
  const vy = minY + half - light.y;
  const vz = minZ + half - light.z;
  const dist = Math.sqrt(vx * vx + vy * vy + vz * vz);
  if (dist <= CELL_BOUND) return false; // the light is inside the sphere: every angle occurs
  // the lit direction is −(light − target)
  const cosCentre = Math.min(1, Math.max(-1, -(vx * light.dx + vy * light.dy + vz * light.dz) / dist));
  const centre = Math.acos(cosCentre);
  const spread = Math.asin(CELL_BOUND / dist);
  const cosNearest = Math.cos(Math.max(0, centre - spread)); // the largest cos θ in the sphere
  const cosFarthest = Math.cos(Math.min(Math.PI, centre + spread)); // the smallest
  const e0 = light.coneCos;
  const e1 = light.penumbraCos;
  if (e0 < e1) return !(cosNearest > e0);
  if (e0 > e1) return !(cosFarthest < e0);
  return !(cosNearest >= e0);
}

function checkBounds(b: GridBounds): void {
  for (const v of [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z]) {
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new RangeError('light grid: the bounds are not finite numbers');
  }
  if (b.max.x < b.min.x || b.max.y < b.min.y || b.max.z < b.min.z) throw new RangeError('light grid: the bounds are inverted');
}

/** the lights that take part: every lamp, and the brightest `fxLights` fire lights */
function eligible(lights: readonly GridLight[], fxLights: number): GridLight[] {
  const byId = [...lights].sort((a, b) => a.id - b.id);
  if (!(fxLights < byId.length)) return byId;
  const fires = byId.filter((l) => l.fx);
  if (fires.length <= fxLights) return byId;
  const keep = new Set(
    fires
      .sort((a, b) => b.intensity - a.intensity || a.id - b.id)
      .slice(0, Math.max(0, Math.floor(fxLights)))
      .map((l) => l.id),
  );
  return byId.filter((l) => !l.fx || keep.has(l.id));
}

/** Builds the cell lists (pure: no texture). */
export function buildLightGridData(lights: readonly GridLight[], opts: GridBuildOptions): LightGridData {
  const cap = Math.floor(opts.lightsPerCell);
  if (!(cap >= 0)) throw new RangeError(`light grid: lightsPerCell must be a count ≥ 0, got ${String(opts.lightsPerCell)}`);
  const used = eligible(lights, opts.fxLights);

  let bounds = opts.bounds ?? null;
  if (bounds === null && lights.length > 0) {
    const min = { x: Infinity, y: Infinity, z: Infinity };
    const max = { x: -Infinity, y: -Infinity, z: -Infinity };
    for (const l of lights) {
      min.x = Math.min(min.x, l.x);
      min.y = Math.min(min.y, l.y);
      min.z = Math.min(min.z, l.z);
      max.x = Math.max(max.x, l.x);
      max.y = Math.max(max.y, l.y);
      max.z = Math.max(max.z, l.z);
    }
    bounds = { min, max };
  }
  if (bounds === null) {
    return { origin: [0, 0, 0], dims: [1, 1, 1], cellCount: 1, head: new Float32Array(2), indices: new Float32Array(0), listed: 0, maxPerCell: 0, maxCandidates: 0, cappedCells: 0 };
  }
  checkBounds(bounds);
  const origin: [number, number, number] = [bounds.min.x - GRID_MARGIN, bounds.min.y - GRID_MARGIN, bounds.min.z - GRID_MARGIN];
  const dims: [number, number, number] = [
    Math.max(1, Math.ceil((bounds.max.x + GRID_MARGIN - origin[0]) / GRID_CELL)),
    Math.max(1, Math.ceil((bounds.max.y + GRID_MARGIN - origin[1]) / GRID_CELL)),
    Math.max(1, Math.ceil((bounds.max.z + GRID_MARGIN - origin[2]) / GRID_CELL)),
  ];
  const cellCount = dims[0] * dims[1] * dims[2];
  if (!(cellCount <= MAX_GRID_CELLS)) throw new RangeError(`light grid: ${dims.join(' × ')} cells is more than ${MAX_GRID_CELLS}; check the bounds`);

  // every (cell, light, score) with a score above 0
  let size = 4096;
  let cells = new Int32Array(size);
  let which = new Int32Array(size);
  let scores = new Float64Array(size);
  let n = 0;
  const counts = new Int32Array(cellCount);
  for (let li = 0; li < used.length; li++) {
    const l = used[li]!;
    const r = l.cutoff;
    if (!(r > 0)) continue;
    const x0 = Math.max(0, Math.floor((l.x - r - origin[0]) / GRID_CELL));
    const y0 = Math.max(0, Math.floor((l.y - r - origin[1]) / GRID_CELL));
    const z0 = Math.max(0, Math.floor((l.z - r - origin[2]) / GRID_CELL));
    const x1 = Math.min(dims[0] - 1, Math.floor((l.x + r - origin[0]) / GRID_CELL));
    const y1 = Math.min(dims[1] - 1, Math.floor((l.y + r - origin[1]) / GRID_CELL));
    const z1 = Math.min(dims[2] - 1, Math.floor((l.z + r - origin[2]) / GRID_CELL));
    for (let cz = z0; cz <= z1; cz++) {
      for (let cy = y0; cy <= y1; cy++) {
        for (let cx = x0; cx <= x1; cx++) {
          const score = cellScore(l, origin[0] + cx * GRID_CELL, origin[1] + cy * GRID_CELL, origin[2] + cz * GRID_CELL);
          if (!(score > 0)) continue;
          if (n === size) {
            size *= 2;
            const c2 = new Int32Array(size);
            c2.set(cells);
            cells = c2;
            const w2 = new Int32Array(size);
            w2.set(which);
            which = w2;
            const s2 = new Float64Array(size);
            s2.set(scores);
            scores = s2;
          }
          const cell = cx + dims[0] * (cy + dims[1] * cz);
          cells[n] = cell;
          which[n] = li;
          scores[n] = score;
          counts[cell] = counts[cell]! + 1;
          n++;
        }
      }
    }
  }

  // bucket by cell
  const starts = new Int32Array(cellCount + 1);
  for (let c = 0; c < cellCount; c++) starts[c + 1] = starts[c]! + counts[c]!;
  const fill = starts.slice(0, cellCount);
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    const cell = cells[i]!;
    order[fill[cell]!] = i;
    fill[cell] = fill[cell]! + 1;
  }

  // rank each cell: higher score first, then the light created first (`used` is in creation order, so a lower `which`)
  const head = new Float32Array(cellCount * 2);
  const indices = new Float32Array(Math.min(n, cellCount * cap));
  let listed = 0;
  let maxPerCell = 0;
  let maxCandidates = 0;
  let cappedCells = 0;
  for (let c = 0; c < cellCount; c++) {
    const from = starts[c]!;
    const to = starts[c + 1]!;
    const candidates = to - from;
    if (candidates > maxCandidates) maxCandidates = candidates;
    for (let i = from + 1; i < to; i++) {
      const e = order[i]!;
      const s = scores[e]!;
      const w = which[e]!;
      let j = i - 1;
      while (j >= from) {
        const o = order[j]!;
        if (scores[o]! > s || (scores[o]! === s && which[o]! < w)) break;
        order[j + 1] = o;
        j--;
      }
      order[j + 1] = e;
    }
    const count = Math.min(candidates, cap);
    if (candidates > cap) cappedCells++;
    head[c * 2] = listed;
    head[c * 2 + 1] = count;
    for (let i = 0; i < count; i++) indices[listed++] = used[which[order[from + i]!]!]!.index;
    if (count > maxPerCell) maxPerCell = count;
  }
  return { origin, dims, cellCount, head, indices, listed, maxPerCell, maxCandidates, cappedCells };
}

function floatTexture(name: string, format: typeof RGFormat | typeof RedFormat, channels: number, count: number): DataTexture {
  const width = Math.max(1, Math.min(count, CELL_TEXTURE_WIDTH));
  const height = Math.max(1, Math.ceil(count / CELL_TEXTURE_WIDTH));
  const texture = new DataTexture(new Float32Array(width * height * channels), width, height, format, FloatType);
  texture.name = name;
  texture.magFilter = NearestFilter;
  texture.minFilter = NearestFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.needsUpdate = true;
  return texture;
}

const EMPTY_GRID: LightGridData = buildLightGridData([], { lightsPerCell: 0, fxLights: 0 });

/** The grid of the current place with its two textures. */
export class LightGrid {
  #data: LightGridData = EMPTY_GRID;
  #head: DataTexture = floatTexture('ss:cellHeadTex', RGFormat, 2, 1);
  #index: DataTexture = floatTexture('ss:cellIdxTex', RedFormat, 1, CELL_TEXTURE_WIDTH);
  /** bumps on every rebuild */
  revision = 0;

  get data(): LightGridData {
    return this.#data;
  }

  /** RG32F, one texel per cell: (offset, count). Replaced when the cell count changes: read it after every rebuild. */
  get headTexture(): DataTexture {
    return this.#head;
  }

  /** R32F, 4,096 wide: the packed lists. Replaced when it needs more or fewer rows. */
  get indexTexture(): DataTexture {
    return this.#index;
  }

  /** Rebuilds the lists (a place load, a tier switch, a new static light). Data only: no shader depends on any of it. */
  rebuild(lights: readonly GridLight[], opts: GridBuildOptions): LightGridData {
    const data = buildLightGridData(lights, opts);
    const headWidth = Math.max(1, Math.min(data.cellCount, CELL_TEXTURE_WIDTH));
    const headHeight = Math.max(1, Math.ceil(data.cellCount / CELL_TEXTURE_WIDTH));
    if (this.#head.image.width !== headWidth || this.#head.image.height !== headHeight) {
      this.#head.dispose();
      this.#head = floatTexture('ss:cellHeadTex', RGFormat, 2, data.cellCount);
    }
    const head = this.#head.image.data as Float32Array;
    head.fill(0);
    head.set(data.head);
    this.#head.needsUpdate = true;

    // always whole rows of 4,096, so most rebuilds of a place keep the texture
    const rows = Math.max(1, Math.ceil(data.listed / CELL_TEXTURE_WIDTH));
    if (this.#index.image.height !== rows) {
      this.#index.dispose();
      this.#index = floatTexture('ss:cellIdxTex', RedFormat, 1, rows * CELL_TEXTURE_WIDTH);
    }
    const index = this.#index.image.data as Float32Array;
    index.fill(0);
    index.set(data.indices.subarray(0, data.listed));
    this.#index.needsUpdate = true;

    this.#data = data;
    this.revision++;
    return data;
  }

  dispose(): void {
    this.#head.dispose();
    this.#index.dispose();
  }
}
