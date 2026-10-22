// The map batcher's plan (docs/design/rendering.md §6.5, §15.1, §15.5; WP R3): everything about map meshes that is arithmetic,
// kept engine-free so the batcher (`map-batcher.ts`), the geometry workers (`chunk-merge.ts`), the Node tools
// (`tools/render/geometry-check.ts`) and the unit tests share one implementation:
//
//   chunk grid       32 m cells; a static row belongs to the cell of its origin (see `chunkIdOf`); a cell is cut into parts
//                    (`partitionChunk`: large rows apart, a triangle cap) and cells group into 128 m far groups (`farIdOf`)
//   classification   dynamic rows / instanced keys / merged rows (render §6.5, Appendix A.2)
//   LOD selection    by distance to an AABB or a sphere, 10 % hysteresis, thresholds from the tier table scaled by [CAL `lod`]
//   frustum          the six planes of a perspective camera, AABB and sphere tests (three's `Frustum`, written out)
//   frame estimate   draws and triangles of the map line of §15.5 for a camera, from packed counts and bounds (no GPU)
//
// No `three` import and no generator import (X-26).
import { calibration, CALIBRATION_DEFAULTS } from '../calibration.ts';
import type { LodLevel, ScriptedSpec, Vec3Tuple } from './generator-types.ts';

// ── chunk grid ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** chunk edge in metres (render §6.5) */
export const CHUNK_SIZE = 32;
const CHUNK_BIAS = 2048;
const CHUNK_SPAN = 4096;

/**
 * The id of the 32 m chunk that holds world point (x, z): `(cx + 2048) · 4096 + (cz + 2048)`. The batcher assigns a row by its
 * origin (its world matrix's translation): the key's bbox is only known once a worker has generated it, and the chunk's real
 * bounds come back from the merge, so culling and LOD selection never use the nominal cell.
 */
export function chunkIdOf(x: number, z: number): number {
  const cx = Math.floor(x / CHUNK_SIZE);
  const cz = Math.floor(z / CHUNK_SIZE);
  if (!(cx >= -CHUNK_BIAS && cx < CHUNK_BIAS && cz >= -CHUNK_BIAS && cz < CHUNK_BIAS)) throw new RangeError(`chunkIdOf: (${x}, ${z}) is outside the chunk grid`);
  return (cx + CHUNK_BIAS) * CHUNK_SPAN + (cz + CHUNK_BIAS);
}

/** The chunk's cell `[cx, cz]`; its nominal square is `[cx · 32, (cx + 1) · 32) × [cz · 32, (cz + 1) · 32)`. */
export function chunkCell(chunk: number): [number, number] {
  return [Math.floor(chunk / CHUNK_SPAN) - CHUNK_BIAS, (chunk % CHUNK_SPAN) - CHUNK_BIAS];
}

// ── chunk partition (DR-35 lever 2) and far groups (lever 4) ─────────────────────────────────────────────────────────────

/** a row wider than this on x or z (world AABB, metres) goes to its cell's large-row part instead of a quadrant */
export const CHUNK_OVERSIZE = 16;
/** a cell is quartered down to this edge at most (metres) */
export const CHUNK_MIN_CELL = 8;
/** a part holds at most this many triangles at the tier's finest level, or this share of the frame's triangle budget if that is more */
export const CHUNK_TRIANGLE_FLOOR = 90_000;
export const CHUNK_TRIANGLE_SHARE = 0.15;
/** far groups: 4 × 4 cells (128 m) */
export const FAR_CELLS = 4;

/** how a chunk job cuts its cell into parts (`partitionChunk`) */
export interface ChunkSplit {
  /** triangles at the job's finest LOD above which a cell (or quadrant) is quartered */
  cap: number;
  oversize: number;
  minCell: number;
}

/**
 * The split of a tier: the cap is 15 % of the frame's triangle budget and never under 90,000 (`high` 225,000, `medium`
 * 150,000, `low` and `minimum` 90,000). Measured over the 19 maps (`tools/render/geometry-check.ts`): any cap from 80,000 to
 * 100,000 on `low`/`minimum` keeps both the draws and the triangles of the densest map (a dense scene) inside the budgets;
 * a smaller one costs draws, a larger one triangles.
 */
export function chunkSplitFor(triangleBudget: number): ChunkSplit {
  return { cap: Math.max(CHUNK_TRIANGLE_FLOOR, Math.round(triangleBudget * CHUNK_TRIANGLE_SHARE)), oversize: CHUNK_OVERSIZE, minCell: CHUNK_MIN_CELL };
}

/** what the partition reads of a row: its world AABB (`transformedAabb` of its key's bbox) and its triangles at the finest LOD */
export interface PartRow {
  min: ArrayLike<number>;
  max: ArrayLike<number>;
  tris: number;
}

export interface ChunkPart {
  /** '' the whole cell, a quadrant path ('2', '21': x high = 1, z high = 2), or 'L' for the large-row part */
  label: string;
  /** indices into the rows given, ascending */
  rows: number[];
}

/**
 * Cuts the rows of one 32 m cell into the parts that become meshes (DR-35 lever 2). A chunk's LOD and its frustum test are
 * taken on the bounds of all its rows, so one long row (a fence, a road, a boundary wall) or one dense corner used to drag a
 * whole cell to the fine level and into every view. Two rules, both local to the cell (a chunk job needs nothing from its
 * neighbours):
 *
 *   large rows   a row wider than `oversize` on x or z leaves the quadrants and joins the cell's 'L' part, so the other
 *                parts keep bounds near their quadrant
 *   triangle cap while the rest holds more than `cap` triangles at the finest LOD, the cell is quartered (rows by the centre
 *                of their AABB, clamped to the cell), down to `minCell`
 *
 * Deterministic: parts in depth-first quadrant order, then 'L'; rows keep their order. No split: one part with every row.
 */
export function partitionChunk(chunk: number, rows: readonly PartRow[], split?: ChunkSplit): ChunkPart[] {
  const all = rows.map((_r, i) => i);
  if (!split) return all.length > 0 ? [{ label: '', rows: all }] : [];
  const out: ChunkPart[] = [];
  const small: number[] = [];
  const large: number[] = [];
  for (const i of all) {
    const r = rows[i]!;
    (Math.max(r.max[0]! - r.min[0]!, r.max[2]! - r.min[2]!) > split.oversize ? large : small).push(i);
  }
  const [cx, cz] = chunkCell(chunk);
  const cut = (label: string, list: number[], x0: number, z0: number, size: number): void => {
    if (list.length === 0) return;
    let tris = 0;
    for (const i of list) tris += rows[i]!.tris;
    const half = size / 2;
    if (tris <= split.cap || half < split.minCell || list.length < 2) {
      out.push({ label, rows: list });
      return;
    }
    const q: number[][] = [[], [], [], []];
    for (const i of list) {
      const r = rows[i]!;
      q[((r.min[0]! + r.max[0]!) / 2 >= x0 + half ? 1 : 0) + ((r.min[2]! + r.max[2]!) / 2 >= z0 + half ? 2 : 0)]!.push(i);
    }
    for (let k = 0; k < 4; k++) cut(`${label}${k}`, q[k]!, x0 + (k & 1 ? half : 0), z0 + (k & 2 ? half : 0), half);
  };
  cut('', small, cx * CHUNK_SIZE, cz * CHUNK_SIZE, CHUNK_SIZE);
  if (large.length > 0) out.push({ label: 'L', rows: large });
  return out;
}

/**
 * The far group of a chunk: the 128 m cell (4 × 4 chunks) its cell lies in, coded like a chunk id. A group whose parts all show
 * their coarsest level draws as one merged mesh of that level instead (DR-35 lever 4, `map-batcher.ts`).
 */
export function farIdOf(chunk: number): number {
  const [cx, cz] = chunkCell(chunk);
  return (Math.floor(cx / FAR_CELLS) + CHUNK_BIAS) * CHUNK_SPAN + (Math.floor(cz / FAR_CELLS) + CHUNK_BIAS);
}

/** `PackedChunk.rowRanges`: opaque first, opaque count, transparent first, transparent count */
export const ROW_RANGE_STRIDE = 4;

/**
 * Promote-on-write on the CPU copy of a chunk index (render §6.5): overwrites a row's index ranges with degenerate triangles
 * and returns the ranges written, for `index.addUpdateRange`. It is two fills (≤ 1 ms on the largest chunk).
 */
export function removeRowFromIndex(idx: Uint16Array | Uint32Array, rowRanges: Uint32Array, row: number): Array<{ start: number; count: number }> {
  const o = row * ROW_RANGE_STRIDE;
  const out: Array<{ start: number; count: number }> = [];
  for (const k of [0, 2]) {
    const start = rowRanges[o + k]!;
    const count = rowRanges[o + k + 1]!;
    if (count === 0) continue;
    idx.fill(0, start, start + count);
    out.push({ start, count });
    rowRanges[o + k + 1] = 0;
  }
  return out;
}

// ── smooth normals of packed geometry ───────────────────────────────────────────────────────────────────────────────────

/** smooth vertices carry this in the w of their mesh normal; flat vertices 0 */
export const NORMAL_SMOOTH = 127;

/**
 * a bbox axis with no extent still gets this scale in the matrix that dequantises a packed geometry (`map-batcher.ts`
 * `dequantMatrix`): the matrix stays invertible (three inverts it to turn normals). A mesh normal is written for that
 * matrix, so it uses the same substitute
 */
export const MIN_HALF_EXTENT = 1e-6;

/**
 * Writes one vertex of a packed mesh's `normal` attribute (int8 × 4, normalised) at `out[o..o + 4)`.
 *
 * A packed geometry is drawn through a matrix that scales the quantised cube by the bbox half extents `h`, and three turns a
 * normal by the inverse transpose of that matrix. So the attribute holds the normal **in quantised space**: `n ⊙ h`,
 * renormalised (the inverse transpose then gives back `n`, turned by the row). An axis with no extent counts with the
 * matrix's own substitute scale (`MIN_HALF_EXTENT`): a smooth quad that is a chunk of its own has no extent along its
 * normal, and with a plain 0 there the float noise of the other two components became the normal. A flat vertex (`n` = 0: the packer's mark)
 * gets the placeholder (0, 1, 0) with w = 0, so nothing ever normalises a zero vector; a smooth one gets w = 127. The
 * surface's packed stage shades with the interpolated normal where w is set and with the face normal elsewhere.
 */
export function writeMeshNormal(out: Int8Array, o: number, nx: number, ny: number, nz: number, h0: number, h1: number, h2: number): void {
  const x = nx * (h0 || MIN_HALF_EXTENT), y = ny * (h1 || MIN_HALF_EXTENT), z = nz * (h2 || MIN_HALF_EXTENT);
  const l = Math.hypot(x, y, z);
  if (nx === 0 && ny === 0 && nz === 0) {
    out[o] = 0;
    out[o + 1] = 127;
    out[o + 2] = 0;
    out[o + 3] = 0;
    return;
  }
  if (l === 0) {
    // (an underflow: every component vanished against its scale) keep the direction
    const m = Math.hypot(nx, ny, nz);
    out[o] = Math.round((nx / m) * 127);
    out[o + 1] = Math.round((ny / m) * 127);
    out[o + 2] = Math.round((nz / m) * 127);
  } else {
    out[o] = Math.round((x / l) * 127);
    out[o + 1] = Math.round((y / l) * 127);
    out[o + 2] = Math.round((z / l) * 127);
  }
  out[o + 3] = NORMAL_SMOOTH;
}

/** The mesh normals of a packed key LOD (`PackedLod.normals`: int8 xyz in the key's metric space, 0 on flat vertices). */
export function meshNormals(normals: Int8Array, bboxMin: ArrayLike<number>, bboxMax: ArrayLike<number>): Int8Array {
  const out = new Int8Array(normals.length);
  const h0 = (bboxMax[0]! - bboxMin[0]!) / 2, h1 = (bboxMax[1]! - bboxMin[1]!) / 2, h2 = (bboxMax[2]! - bboxMin[2]!) / 2;
  for (let o = 0; o < normals.length; o += 4) writeMeshNormal(out, o, normals[o]!, normals[o + 1]!, normals[o + 2]!, h0, h1, h2);
  return out;
}

// ── classification ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** tags that mark a row dynamic whatever else it carries (render §6.5): doors and their leaves, viewmodel parts */
export const DYNAMIC_TAGS: readonly string[] = Object.freeze([]);

/** what the classification reads of a row (its spec as spawned, templates and overrides merged) */
export interface RowFacts {
  behavior?: unknown;
  physics?: unknown;
  parent?: unknown;
  tags?: readonly unknown[] | undefined;
  /** an ancestor is dynamic (children of a moving row move with it) */
  parentDynamic?: boolean;
}

function physicsBody(p: unknown): string | null {
  if (p === undefined || p === null || p === false || p === 'none') return null;
  if (typeof p === 'string') return p;
  if (typeof p === 'object' && typeof (p as { body?: unknown }).body === 'string') return (p as { body: string }).body;
  return 'static';
}

/**
 * render §6.5: a row is dynamic when it has a `behavior` (the live state writers are all behaviours: doors, `spin.js`,
 * `sweep.js`, `nuke.js`, terminals), `physics` `kinematic` or `dynamic`, a `parent` (or a dynamic ancestor), or a tag of
 * `DYNAMIC_TAGS`. Dynamic rows are never batched.
 */
export function isDynamicRow(row: RowFacts, dynamicTags: readonly string[] = DYNAMIC_TAGS): boolean {
  if (row.parentDynamic === true) return true;
  const b = row.behavior;
  if (Array.isArray(b) ? b.length > 0 : typeof b === 'string' ? b !== '' : b !== undefined && b !== null && b !== false) return true;
  if (typeof row.parent === 'string' && row.parent !== '') return true;
  const body = physicsBody(row.physics);
  if (body === 'kinematic' || body === 'dynamic') return true;
  if (row.tags) for (const t of row.tags) if (typeof t === 'string' && dynamicTags.includes(t)) return true;
  return false;
}

/** a scripted row as the batcher sees it */
export interface PlanRow {
  id: string;
  /** `keyOf(spec)` */
  key: string;
  spec: ScriptedSpec;
  /** world matrix, column-major 4 × 4 */
  m: Float32Array;
  dynamic: boolean;
  /** default true */
  castShadow?: boolean;
  /**
   * the row's own material replaces the generator's paints (a texture set or a flat preset, render §7.4): it cannot share a
   * chunk's or an instanced mesh's material, so it is drawn as a standalone mesh of its key
   */
  ownLook?: boolean;
  /**
   * K3: the row's key is rigged (its generator exports `skeleton()`, the row is posed by clips or `bones`): it is never
   * merged or instanced, so it gets a mesh of its own to skin (`standalone` when static). Default false
   */
  rigged?: boolean;
}

export type LodPolicy = 'hybrid' | 'mergeAll';

export interface RowSplit<R extends PlanRow = PlanRow> {
  /** key → its static rows, drawn as one instanced mesh per LOD and pass */
  instanced: Map<string, R[]>;
  /** static rows baked into chunks */
  merged: R[];
  /** never batched: one mesh per row per LOD */
  dynamic: R[];
  /** static rows with a look of their own: one mesh per row per LOD, not batched */
  standalone: R[];
}

/** rows ≥ 4, or rows ≥ 2 and LOD 1 triangles ≥ 5,000 (render §6.5) */
export const INSTANCE_MIN_ROWS = 4;
export const INSTANCE_MIN_ROWS_LARGE = 2;
export const INSTANCE_LARGE_TRIS = 5000;

/**
 * render §6.5: the split of a map's scripted rows. `lod1Tris(key)` is only asked for keys with 2 or 3 static rows; under
 * `mergeAll` (tiers `low`/`minimum`) every static row merges and it is never asked.
 */
export function classifyRows<R extends PlanRow>(rows: readonly R[], policy: LodPolicy, lod1Tris: (key: string) => number): RowSplit<R> {
  const out: RowSplit<R> = { instanced: new Map(), merged: [], dynamic: [], standalone: [] };
  const byKey = new Map<string, R[]>();
  for (const r of rows) {
    if (r.dynamic) out.dynamic.push(r);
    else if (r.ownLook === true || r.rigged === true) out.standalone.push(r);
    else {
      const list = byKey.get(r.key);
      if (list) list.push(r);
      else byKey.set(r.key, [r]);
    }
  }
  for (const [key, list] of byKey) {
    const instanced = policy === 'hybrid' && (list.length >= INSTANCE_MIN_ROWS || (list.length >= INSTANCE_MIN_ROWS_LARGE && lod1Tris(key) >= INSTANCE_LARGE_TRIS));
    if (instanced) out.instanced.set(key, list);
    else out.merged.push(...list);
  }
  return out;
}

/** keys whose LOD 1 triangle count decides their class: 2 or 3 static rows under `hybrid` */
export function keysNeedingLod1Tris(rows: readonly PlanRow[], policy: LodPolicy): string[] {
  if (policy !== 'hybrid') return [];
  const counts = new Map<string, number>();
  for (const r of rows) if (!r.dynamic && r.ownLook !== true && r.rigged !== true) counts.set(r.key, (counts.get(r.key) ?? 0) + 1);
  const out: string[] = [];
  for (const [key, n] of counts) if (n >= INSTANCE_MIN_ROWS_LARGE && n < INSTANCE_MIN_ROWS) out.push(key);
  return out;
}

/** merged rows grouped by chunk, in first-seen chunk order; rows keep their order */
export function groupByChunk<R extends PlanRow>(rows: readonly R[]): Map<number, R[]> {
  const out = new Map<number, R[]>();
  for (const r of rows) {
    const id = chunkIdOf(r.m[12]!, r.m[14]!);
    const list = out.get(id);
    if (list) list.push(r);
    else out.set(id, [r]);
  }
  return out;
}

// ── LOD selection ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** render §6.5: 10 % */
export const LOD_HYSTERESIS = 0.1;

export interface LodBands {
  /** the levels built on the tier, finest first */
  lods: readonly LodLevel[];
  /** switch distances in metres between consecutive levels (`lods.length − 1` of them) */
  distances: readonly number[];
}

/**
 * The tier's LOD bands (render §15.1) under [CAL `lod`]: the tier table holds the shipped distances; a fitted `d13` / `d35`
 * scales the matching step of every tier by the same ratio (the last step of a tier is its 3 → 5 switch).
 */
export function lodBands(tier: { lods: readonly LodLevel[]; lodDistances: readonly number[] }, cal: { d13: number; d35: number } = calibration.lod): LodBands {
  const k13 = cal.d13 / CALIBRATION_DEFAULTS.lod.d13;
  const k35 = cal.d35 / CALIBRATION_DEFAULTS.lod.d35;
  const n = tier.lodDistances.length;
  if (n !== tier.lods.length - 1) throw new RangeError(`lodBands: ${tier.lods.length} levels need ${tier.lods.length - 1} distances, got ${n}`);
  return { lods: tier.lods, distances: tier.lodDistances.map((d, i) => d * (i === n - 1 ? k35 : k13)) };
}

/**
 * The band index (into `bands.lods`) for a distance. `current` is the index in use (−1: none yet): moving to a coarser level
 * needs the distance beyond the threshold by the hysteresis, moving to a finer one below it by the same share.
 */
export function selectLodIndex(current: number, distance: number, distances: readonly number[], hysteresis: number = LOD_HYSTERESIS): number {
  const n = distances.length;
  if (current < 0 || current > n) {
    let i = 0;
    while (i < n && distance >= distances[i]!) i++;
    return i;
  }
  let i = current;
  while (i < n && distance > distances[i]! * (1 + hysteresis)) i++;
  while (i > 0 && distance < distances[i - 1]! * (1 - hysteresis)) i--;
  return i;
}

/** distance from a point to an AABB (0 inside) */
export function distanceToAabb(px: number, py: number, pz: number, min: ArrayLike<number>, max: ArrayLike<number>): number {
  const dx = px < min[0]! ? min[0]! - px : px > max[0]! ? px - max[0]! : 0;
  const dy = py < min[1]! ? min[1]! - py : py > max[1]! ? py - max[1]! : 0;
  const dz = pz < min[2]! ? min[2]! - pz : pz > max[2]! ? pz - max[2]! : 0;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * The world bounding sphere of a key instance: the key bbox's centre moved by the row matrix, its half diagonal scaled by the
 * matrix's largest axis scale (three's `Sphere.applyMatrix4`). Writes `[x, y, z, r]` at `out[o..]`.
 */
export function instanceSphere(bboxMin: ArrayLike<number>, bboxMax: ArrayLike<number>, m: ArrayLike<number>, out: Float32Array | Float64Array | number[], o = 0): void {
  const cx = (bboxMin[0]! + bboxMax[0]!) / 2, cy = (bboxMin[1]! + bboxMax[1]!) / 2, cz = (bboxMin[2]! + bboxMax[2]!) / 2;
  const r = Math.hypot(bboxMax[0]! - bboxMin[0]!, bboxMax[1]! - bboxMin[1]!, bboxMax[2]! - bboxMin[2]!) / 2;
  const sx = m[0]! * m[0]! + m[1]! * m[1]! + m[2]! * m[2]!;
  const sy = m[4]! * m[4]! + m[5]! * m[5]! + m[6]! * m[6]!;
  const sz = m[8]! * m[8]! + m[9]! * m[9]! + m[10]! * m[10]!;
  out[o] = m[0]! * cx + m[4]! * cy + m[8]! * cz + m[12]!;
  out[o + 1] = m[1]! * cx + m[5]! * cy + m[9]! * cz + m[13]!;
  out[o + 2] = m[2]! * cx + m[6]! * cy + m[10]! * cz + m[14]!;
  out[o + 3] = r * Math.sqrt(Math.max(sx, sy, sz));
}

/**
 * The culling radius of a key's geometry inside a `BatchedMesh`, in the key's quantised space (the ±1 cube, centre 0). three
 * culls an instance by the geometry's sphere under the instance matrix (row · dequantisation) and scales the radius by that
 * matrix's largest axis scale [F `three/src/math/Sphere.js` `applyMatrix4`]. So the smallest radius that is safe for a row
 * is (the farthest corner of its box from the box centre) / (the largest axis scale), and for the key the largest of those
 * over its rows: |h| / max(h) when every row scales uniformly (exact, as for a chunk), up to √3 (the cube's own) under a
 * non-uniform scale, more under a shear. Writes each row's world radius (that ratio times its largest axis scale) to
 * `out[i]` when given: what three tests the instance with.
 */
export function keyCullRadius(bboxMin: ArrayLike<number>, bboxMax: ArrayLike<number>, rows: ReadonlyArray<ArrayLike<number>>, out?: Float64Array): number {
  const h0 = (bboxMax[0]! - bboxMin[0]!) / 2 || MIN_HALF_EXTENT, h1 = (bboxMax[1]! - bboxMin[1]!) / 2 || MIN_HALF_EXTENT, h2 = (bboxMax[2]! - bboxMin[2]!) / 2 || MIN_HALF_EXTENT;
  let ratio = 0;
  const scales = out ? new Float64Array(rows.length) : null;
  rows.forEach((m, i) => {
    // the box's half axes in the world: the row's columns times the half extents
    const ax = m[0]! * h0, ay = m[1]! * h0, az = m[2]! * h0;
    const bx = m[4]! * h1, by = m[5]! * h1, bz = m[6]! * h1;
    const cx = m[8]! * h2, cy = m[9]! * h2, cz = m[10]! * h2;
    const scale = Math.max(Math.hypot(ax, ay, az), Math.hypot(bx, by, bz), Math.hypot(cx, cy, cz));
    // four of the eight corners; the other four are their mirror images
    const corner = Math.max(
      Math.hypot(ax + bx + cx, ay + by + cy, az + bz + cz),
      Math.hypot(ax + bx - cx, ay + by - cy, az + bz - cz),
      Math.hypot(ax - bx + cx, ay - by + cy, az - bz + cz),
      Math.hypot(ax - bx - cx, ay - by - cy, az - bz - cz),
    );
    if (scale > 0 && corner / scale > ratio) ratio = corner / scale;
    if (scales) scales[i] = scale;
  });
  if (out && scales) for (let i = 0; i < rows.length; i++) out[i] = ratio * scales[i]!;
  return ratio;
}

/** the world AABB of a key bbox under a row matrix (its eight corners) */
export function transformedAabb(bboxMin: ArrayLike<number>, bboxMax: ArrayLike<number>, m: ArrayLike<number>): { min: Vec3Tuple; max: Vec3Tuple } {
  const min: Vec3Tuple = [Infinity, Infinity, Infinity];
  const max: Vec3Tuple = [-Infinity, -Infinity, -Infinity];
  for (let c = 0; c < 8; c++) {
    const x = c & 1 ? bboxMax[0]! : bboxMin[0]!, y = c & 2 ? bboxMax[1]! : bboxMin[1]!, z = c & 4 ? bboxMax[2]! : bboxMin[2]!;
    const w = [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!];
    for (let a = 0; a < 3; a++) {
      if (w[a]! < min[a]!) min[a] = w[a]!;
      if (w[a]! > max[a]!) max[a] = w[a]!;
    }
  }
  return { min, max };
}

/** Grows sphere `[x, y, z, r]` at `acc` to hold sphere `[x, y, z, r]` at `s[o..]`; a negative radius in `acc` means empty. */
export function unionSphere(acc: number[] | Float64Array, s: ArrayLike<number>, o = 0): void {
  const r = s[o + 3]!;
  if (acc[3]! < 0) {
    acc[0] = s[o]!;
    acc[1] = s[o + 1]!;
    acc[2] = s[o + 2]!;
    acc[3] = r;
    return;
  }
  const dx = s[o]! - acc[0]!, dy = s[o + 1]! - acc[1]!, dz = s[o + 2]! - acc[2]!;
  const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (d + r <= acc[3]!) return;
  if (d + acc[3]! <= r) {
    acc[0] = s[o]!;
    acc[1] = s[o + 1]!;
    acc[2] = s[o + 2]!;
    acc[3] = r;
    return;
  }
  const nr = (d + r + acc[3]!) / 2;
  const k = (nr - acc[3]!) / d;
  acc[0] = acc[0]! + dx * k;
  acc[1] = acc[1]! + dy * k;
  acc[2] = acc[2]! + dz * k;
  acc[3] = nr;
}

// ── frustum ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface PlanCamera {
  position: Vec3Tuple;
  target: Vec3Tuple;
  /** vertical field of view, degrees */
  vfovDeg: number;
  aspect: number;
  near: number;
  far: number;
}

/** The six inward planes `(nx, ny, nz, d)` of a perspective camera looking from `position` at `target`, +Y up. */
export function frustumPlanes(cam: PlanCamera): Float64Array {
  const [px, py, pz] = cam.position;
  let fx = cam.target[0] - px, fy = cam.target[1] - py, fz = cam.target[2] - pz;
  const fl = Math.hypot(fx, fy, fz) || 1;
  fx /= fl;
  fy /= fl;
  fz /= fl;
  // right = forward × up, up' = right × forward
  let rx = -fz, ry = 0, rz = fx;
  const rl = Math.hypot(rx, ry, rz);
  if (rl < 1e-9) {
    rx = 1;
    rz = 0;
  } else {
    rx /= rl;
    rz /= rl;
  }
  const ux = ry * fz - rz * fy, uy = rz * fx - rx * fz, uz = rx * fy - ry * fx;
  const t = Math.tan((cam.vfovDeg * Math.PI) / 360);
  const s = t * cam.aspect;
  const out = new Float64Array(24);
  const put = (i: number, nx: number, ny: number, nz: number, ox: number, oy: number, oz: number): void => {
    const l = Math.hypot(nx, ny, nz);
    out[i * 4] = nx / l;
    out[i * 4 + 1] = ny / l;
    out[i * 4 + 2] = nz / l;
    out[i * 4 + 3] = -((nx * ox + ny * oy + nz * oz) / l);
  };
  // side planes pass through the eye: n = forward · tan ± axis
  put(0, fx * s + rx, fy * s + ry, fz * s + rz, px, py, pz);
  put(1, fx * s - rx, fy * s - ry, fz * s - rz, px, py, pz);
  put(2, fx * t + ux, fy * t + uy, fz * t + uz, px, py, pz);
  put(3, fx * t - ux, fy * t - uy, fz * t - uz, px, py, pz);
  put(4, fx, fy, fz, px + fx * cam.near, py + fy * cam.near, pz + fz * cam.near);
  put(5, -fx, -fy, -fz, px + fx * cam.far, py + fy * cam.far, pz + fz * cam.far);
  return out;
}

/** three's `Frustum.intersectsBox`: false when the box is wholly outside one plane */
export function aabbInFrustum(planes: ArrayLike<number>, min: ArrayLike<number>, max: ArrayLike<number>): boolean {
  for (let i = 0; i < 6; i++) {
    const nx = planes[i * 4]!, ny = planes[i * 4 + 1]!, nz = planes[i * 4 + 2]!;
    const x = nx > 0 ? max[0]! : min[0]!, y = ny > 0 ? max[1]! : min[1]!, z = nz > 0 ? max[2]! : min[2]!;
    if (nx * x + ny * y + nz * z + planes[i * 4 + 3]! < 0) return false;
  }
  return true;
}

/** three's `Frustum.intersectsSphere` */
export function sphereInFrustum(planes: ArrayLike<number>, x: number, y: number, z: number, r: number): boolean {
  for (let i = 0; i < 6; i++) if (planes[i * 4]! * x + planes[i * 4 + 1]! * y + planes[i * 4 + 2]! * z + planes[i * 4 + 3]! < -r) return false;
  return true;
}

// ── frame estimate (the map line of render §15.5) ───────────────────────────────────────────────────────────────────────

/** triangles of one LOD: opaque and transparent (alpha < 1) */
export interface LodTris {
  opaque: number;
  transparent: number;
}

/** what the estimate needs of a key: per-LOD triangle counts and the key's local bbox (the finest built LOD's) */
export interface KeyShape {
  tris: Partial<Record<LodLevel, LodTris>>;
  bboxMin: Vec3Tuple;
  bboxMax: Vec3Tuple;
}

export interface MapLayout {
  /** merged chunk parts: world bounds and triangles per LOD; `far` is the part's far group (`farIdOf`) */
  chunks: Array<{ chunk: number; part: string; far: number; min: Vec3Tuple; max: Vec3Tuple; tris: Partial<Record<LodLevel, LodTris>>; rows: number }>;
  /**
   * instanced keys: one sphere `[x, y, z, r]` per instance (LOD selection, and the union sphere of an `InstancedMesh`), and
   * the radius three culls each instance of a `BatchedMesh` with (`keyCullRadius`: the same centre)
   */
  instanced: Array<{ key: string; shape: KeyShape; spheres: Float64Array; cull: Float64Array; rows: number }>;
  /** dynamic and standalone rows: one mesh each */
  single: Array<{ shape: KeyShape; sphere: [number, number, number, number] }>;
}

/** triangles of a key at the finest LOD its shape holds (what the triangle cap of `partitionChunk` counts) */
export function finestTris(shape: KeyShape): number {
  for (const lod of [1, 2, 3, 4, 5] as const) {
    const t = shape.tris[lod];
    if (t) return t.opaque + t.transparent;
  }
  return 0;
}

/**
 * The layout of a split map from the shapes of its keys (an estimate of what the workers return: bounds from key bboxes).
 * `chunkSplit` is the tier's (`chunkSplitFor`); without it every cell is one part, as before DR-35. A shape must carry the
 * bbox of the finest LOD the tier builds: the workers partition on that one.
 */
export function layoutOf(split: RowSplit, shapeOf: (key: string) => KeyShape | undefined, chunkSplit?: ChunkSplit): MapLayout {
  const layout: MapLayout = { chunks: [], instanced: [], single: [] };
  for (const [chunk, list] of groupByChunk(split.merged)) {
    const rows: Array<{ shape: KeyShape; box: { min: Vec3Tuple; max: Vec3Tuple } }> = [];
    for (const r of list) {
      const shape = shapeOf(r.key);
      if (shape) rows.push({ shape, box: transformedAabb(shape.bboxMin, shape.bboxMax, r.m) });
    }
    const parts = partitionChunk(chunk, rows.map((r) => ({ min: r.box.min, max: r.box.max, tris: finestTris(r.shape) })), chunkSplit);
    for (const part of parts) {
      const min: Vec3Tuple = [Infinity, Infinity, Infinity];
      const max: Vec3Tuple = [-Infinity, -Infinity, -Infinity];
      const tris: Partial<Record<LodLevel, LodTris>> = {};
      for (const i of part.rows) {
        const { shape, box } = rows[i]!;
        for (let a = 0; a < 3; a++) {
          if (box.min[a]! < min[a]!) min[a] = box.min[a]!;
          if (box.max[a]! > max[a]!) max[a] = box.max[a]!;
        }
        for (const [lod, t] of Object.entries(shape.tris) as Array<[`${LodLevel}`, LodTris]>) {
          const acc = (tris[Number(lod) as LodLevel] ??= { opaque: 0, transparent: 0 });
          acc.opaque += t.opaque;
          acc.transparent += t.transparent;
        }
      }
      layout.chunks.push({ chunk, part: part.label, far: farIdOf(chunk), min, max, tris, rows: part.rows.length });
    }
  }
  for (const [key, rows] of split.instanced) {
    const shape = shapeOf(key);
    if (!shape) continue;
    const spheres = new Float64Array(rows.length * 4);
    rows.forEach((r, i) => instanceSphere(shape.bboxMin, shape.bboxMax, r.m, spheres, i * 4));
    const cull = new Float64Array(rows.length);
    keyCullRadius(shape.bboxMin, shape.bboxMax, rows.map((r) => r.m), cull);
    layout.instanced.push({ key, shape, spheres, cull, rows: rows.length });
  }
  for (const r of [...split.dynamic, ...split.standalone]) {
    const shape = shapeOf(r.key);
    if (!shape) continue;
    const sphere: [number, number, number, number] = [0, 0, 0, 0];
    instanceSphere(shape.bboxMin, shape.bboxMax, r.m, sphere);
    layout.single.push({ shape, sphere });
  }
  return layout;
}

export interface MapFrameEstimate {
  /** world-pass draws of the map line: chunk meshes (×2 with a transparent range), far meshes, instanced keys, single rows */
  draws: number;
  triangles: number;
  /** parts drawn on their own */
  chunkDraws: number;
  /** far groups drawn as one merged mesh (×2 with a transparent range) */
  farDraws: number;
  instancedDraws: number;
  singleDraws: number;
  /** chunk parts in the frustum (alone or inside a far mesh) */
  chunksVisible: number;
}

export interface EstimateOptions {
  /**
   * how the instanced keys are drawn: `'batched'` one `BatchedMesh` per pass with per-instance culling (where
   * `WEBGL_multi_draw` exists), `'instanced'` one `InstancedMesh` per (key, LOD, pass). Default `'instanced'`
   */
  instancing?: 'batched' | 'instanced';
  /** false: no far meshes (every part draws on its own); default true */
  far?: boolean;
  /** `'cube'`: the chunk test of before DR-35 (the quantised cube's sphere, radius √3 · the largest half extent); default `'box'`, the bbox's own sphere */
  chunkSphere?: 'box' | 'cube';
}

/**
 * The map's draws and triangles for one camera, as the batcher would draw it with no LOD history: chunk LOD by distance to
 * the part's AABB, instance LOD by distance to the instance sphere, three's frustum test on the sphere of each mesh. A chunk
 * mesh's sphere is its bbox's circumscribed sphere (`map-batcher.ts` assigns exactly that); a far group whose parts all
 * select the coarsest level is one mesh over the union of their boxes; instanced keys are tested per instance in a
 * `BatchedMesh` and per (key, LOD) union sphere as `InstancedMesh`es. A mesh with no triangles in a pass is not a draw.
 */
export function estimateMapFrame(layout: MapLayout, cam: PlanCamera, bands: LodBands, opts: EstimateOptions = {}): MapFrameEstimate {
  const planes = frustumPlanes(cam);
  const [px, py, pz] = cam.position;
  const out: MapFrameEstimate = { draws: 0, triangles: 0, chunkDraws: 0, farDraws: 0, instancedDraws: 0, singleDraws: 0, chunksVisible: 0 };
  const count = (t: LodTris | undefined, instances: number): number => {
    if (!t) return 0;
    let d = 0;
    if (t.opaque > 0) d++;
    if (t.transparent > 0) d++;
    out.triangles += (t.opaque + t.transparent) * instances;
    return d;
  };
  const cube = opts.chunkSphere === 'cube';
  const seen = (min: Vec3Tuple, max: Vec3Tuple): boolean => {
    const ex = max[0] - min[0], ey = max[1] - min[1], ez = max[2] - min[2];
    const r = cube ? Math.sqrt(3) * Math.max(ex, ey, ez) * 0.5 : Math.hypot(ex, ey, ez) / 2;
    return sphereInFrustum(planes, (min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2, r);
  };
  const last = bands.lods.length - 1;
  const coarsest = bands.lods[last]!;
  type Part = MapLayout['chunks'][number];
  const levelOf = (c: Part): number => selectLodIndex(-1, distanceToAabb(px, py, pz, c.min, c.max), bands.distances);
  const groups = new Map<number, Part[]>();
  for (const c of layout.chunks) {
    const g = groups.get(c.far);
    if (g) g.push(c);
    else groups.set(c.far, [c]);
  }
  for (const g of groups.values()) {
    if (opts.far !== false && g.length > 1 && g.every((c) => levelOf(c) === last)) {
      const min: Vec3Tuple = [Infinity, Infinity, Infinity];
      const max: Vec3Tuple = [-Infinity, -Infinity, -Infinity];
      const t: LodTris = { opaque: 0, transparent: 0 };
      for (const c of g) {
        for (let a = 0; a < 3; a++) {
          if (c.min[a]! < min[a]!) min[a] = c.min[a]!;
          if (c.max[a]! > max[a]!) max[a] = c.max[a]!;
        }
        t.opaque += c.tris[coarsest]?.opaque ?? 0;
        t.transparent += c.tris[coarsest]?.transparent ?? 0;
      }
      if (!seen(min, max)) continue;
      out.chunksVisible += g.length;
      out.farDraws += count(t, 1);
      continue;
    }
    for (const c of g) {
      if (!seen(c.min, c.max)) continue;
      out.chunksVisible++;
      out.chunkDraws += count(c.tris[bands.lods[levelOf(c)]!], 1);
    }
  }
  if (opts.instancing === 'batched') {
    let opaque = false;
    let transparent = false;
    for (const k of layout.instanced) {
      for (let i = 0; i < k.rows; i++) {
        const o = i * 4;
        // three culls the instance by its geometry's sphere; the batcher picks its LOD by the instance sphere
        if (!sphereInFrustum(planes, k.spheres[o]!, k.spheres[o + 1]!, k.spheres[o + 2]!, k.cull[i]!)) continue;
        const d = Math.max(0, Math.hypot(k.spheres[o]! - px, k.spheres[o + 1]! - py, k.spheres[o + 2]! - pz) - k.spheres[o + 3]!);
        const t = k.shape.tris[bands.lods[selectLodIndex(-1, d, bands.distances)]!];
        if (!t) continue;
        out.triangles += t.opaque + t.transparent;
        if (t.opaque > 0) opaque = true;
        if (t.transparent > 0) transparent = true;
      }
    }
    out.instancedDraws = (opaque ? 1 : 0) + (transparent ? 1 : 0);
  } else {
    const acc = [0, 0, 0, -1];
    for (const k of layout.instanced) {
      for (let li = 0; li < bands.lods.length; li++) {
        acc[3] = -1;
        let n = 0;
        for (let i = 0; i < k.rows; i++) {
          const o = i * 4;
          const d = Math.max(0, Math.hypot(k.spheres[o]! - px, k.spheres[o + 1]! - py, k.spheres[o + 2]! - pz) - k.spheres[o + 3]!);
          if (selectLodIndex(-1, d, bands.distances) !== li) continue;
          n++;
          unionSphere(acc, k.spheres, o);
        }
        if (n === 0 || !sphereInFrustum(planes, acc[0]!, acc[1]!, acc[2]!, acc[3]!)) continue;
        out.instancedDraws += count(k.shape.tris[bands.lods[li]!], n);
      }
    }
  }
  for (const s of layout.single) {
    const [x, y, z, r] = s.sphere;
    if (!sphereInFrustum(planes, x, y, z, r)) continue;
    const d = Math.max(0, Math.hypot(x - px, y - py, z - pz) - r);
    out.singleDraws += count(s.shape.tris[bands.lods[selectLodIndex(-1, d, bands.distances)]!], 1);
  }
  out.draws = out.chunkDraws + out.farDraws + out.instancedDraws + out.singleDraws;
  return out;
}

/** the map line of render §15.5: world-pass draws of chunks, instanced keys and dynamic rows */
export const MAP_DRAW_BUDGET: Readonly<Record<'high' | 'medium' | 'low' | 'minimum', number>> = Object.freeze({ high: 130, medium: 120, low: 80, minimum: 70 });
