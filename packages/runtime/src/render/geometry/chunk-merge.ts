// Merged static chunks (docs/design/rendering.md §6.4, §6.5; WP R3): every static row that is not instanced is baked into its
// 32 m chunk for each LOD level. This module runs **inside the geometry workers** (`geometry-worker.ts` `chunk` jobs) and in
// Node tools; the main thread imports only its types (X-26: the batcher uploads, it never merges). Engine-free: no `three`.
//
// One `PackedChunk` per (chunk, LOD):
//   vtx        D5 (as `pack.ts`): Int16Array, itemSize 4, normalised: x, y, z over the **chunk's world bbox** (the chunk mesh's
//              matrix dequantises them, so its geometry bounds are the quantised-space cube), w = chunk-local paint id − 32767
//   idx        Uint16Array up to 65,536 vertices, else Uint32Array. Order: opaque triangles of rows that cast a shadow, then
//              opaque triangles of the other rows, then transparent triangles; inside each group the job's row order and each
//              row's own triangle order. So `[0, shadowIndexCount)` is the LOD-5 shadow proxy's range, `[0, opaqueIndexCount)`
//              the opaque mesh's and the rest the transparent mesh's
//   paints     12 floats per chunk-local paint, deduplicated inside the chunk by their float bits, in first-use order. A chunk
//              job's LODs share one list (`mergeChunkLods`: every returned chunk carries the same array). The main thread
//              appends it to the map paint table as one block and gives the chunk's meshes the block start (`paintBase`)
//   rowRanges  4 uints per row of the job: opaque first, opaque count, transparent first, transparent count (index positions).
//              Promote-on-write removes a row by overwriting these ranges with degenerate triangles (`map-plan.ts`
//              `removeRowFromIndex`, on the main thread: two fills)
//
//   normals    only when a row's key has smooth faces: int8 x, y, z, w per vertex, ready to be the chunk mesh's `normal`
//              attribute (`map-plan.ts` `writeMeshNormal`): the key's normal turned by the row matrix's inverse transpose,
//              expressed in the chunk's quantised space, w = 127 on smooth vertices and 0 on flat ones
//
// Vertices are not shared between rows (a row's ranges must stay its own). UVs of the keys are dropped: a merged chunk reads
// its look from the paint table.
//
// Parts (DR-35 lever 2): a job with a `split` cuts its cell into parts (`map-plan.ts` `partitionChunk`: large rows apart, a
// triangle cap) and returns one `PackedChunk` per (part, LOD), all sharing the job's one paint list. `rows` names the job rows
// a part holds; `rowRanges` is indexed by the part's own row order.
//
// Far meshes (DR-35 lever 4): `mergePackedChunks` joins the coarsest level of the parts of a 128 m far group into one
// `PackedChunk` (a `FarJob`, also run in a worker): requantised to the union bbox, with a paint list of its own holding only
// the paints those vertices use. Nothing is generated again.
import type { LodLevel, ScriptedSpec, Vec3Tuple } from './generator-types.ts';
import { MIN_HALF_EXTENT, ROW_RANGE_STRIDE, writeMeshNormal, type ChunkSplit } from './map-plan.ts';
import { MAX_LOCAL_PAINTS, PAINT_FLOATS, PAINT_ID_BIAS, VERTEX_STRIDE, type PackedLod } from './pack.ts';

const QMAX = 32767;
const NO_PAINTS = new Float32Array(0);

/** One static row of a chunk job. */
export interface ChunkRow {
  spec: ScriptedSpec;
  /** the row's world matrix, column-major 4 × 4 (three's `Matrix4.elements`) */
  m: Float32Array;
  /** default true; false keeps the row out of the shadow proxy's range */
  castShadow?: boolean;
}

/** render §6.4 */
export interface ChunkJob {
  place: string;
  chunk: number;
  rows: ChunkRow[];
  lods: LodLevel[];
  /** how the cell is cut into parts (`map-plan.ts` `chunkSplitFor`); absent: one part with every row */
  split?: ChunkSplit;
}

/** The coarsest level of the parts of one far group, to be merged into one mesh (`mergePackedChunks`). */
export interface FarJob {
  place: string;
  /** `map-plan.ts` `farIdOf` */
  far: number;
  members: PackedChunk[];
}

export interface PackedChunk {
  /** the cell (`chunkIdOf`), or the far group (`farIdOf`) of a far merge */
  chunk: number;
  /** the part of the cell: '' the whole cell, a quadrant path, 'L' the large rows (`partitionChunk`); 'F' a far merge */
  part: string;
  /**
   * the job rows this chunk holds, in the chunk's row order (`rowRanges` is indexed by position in this list). A far merge
   * holds the rows of its members one member after the other: 0, 1, 2, …
   */
  rows: Uint32Array;
  lod: LodLevel;
  /** stride 8 (D5), quantised over `bboxMin..bboxMax` (world) */
  vtx: ArrayBuffer;
  idx: Uint16Array | Uint32Array;
  opaqueIndexCount: number;
  /** `[0, shadowIndexCount)`: opaque triangles of rows whose `castShadow` is not false */
  shadowIndexCount: number;
  /** PAINT_FLOATS per chunk-local paint */
  paints: Float32Array;
  /** per row of the job: opaque first, opaque count, transparent first, transparent count */
  rowRanges: Uint32Array;
  /** the mesh `normal` attribute (int8 × 4, see the header); absent when no row has a smooth face */
  normals?: Int8Array;
  bboxMin: Vec3Tuple;
  bboxMax: Vec3Tuple;
  tris: number;
  vertices: number;
}

/** a row of a merge: its key's packed LOD, its world matrix and whether it casts a shadow */
export interface MergeRow {
  lod: PackedLod;
  m: ArrayLike<number>;
  castShadow: boolean;
}

function emptyChunk(chunk: number, lod: LodLevel, rows: number): PackedChunk {
  return {
    chunk,
    part: '',
    rows: Uint32Array.from({ length: rows }, (_v, i) => i),
    lod,
    vtx: new ArrayBuffer(0),
    idx: new Uint16Array(0),
    opaqueIndexCount: 0,
    shadowIndexCount: 0,
    paints: new Float32Array(0),
    rowRanges: new Uint32Array(rows * ROW_RANGE_STRIDE),
    bboxMin: [0, 0, 0],
    bboxMax: [0, 0, 0],
    tris: 0,
    vertices: 0,
  };
}

/** the paint list of a merge: one per chunk LOD, or shared by the LODs of a chunk (`mergeChunkLods`) */
interface PaintPool {
  ids: Map<string, number>;
  list: Float32Array[];
}

function poolRecords(pool: PaintPool): Float32Array {
  const paints = new Float32Array(pool.list.length * PAINT_FLOATS);
  for (let i = 0; i < pool.list.length; i++) paints.set(pool.list[i]!, i * PAINT_FLOATS);
  return paints;
}

/**
 * Merges the rows of one chunk at one LOD (see the header for the layout). Deterministic: the same rows in the same order give
 * the same bytes. Throws when the chunk holds more than 65,535 distinct paints (render §20 risk 16: split the chunk).
 */
export function mergeChunk(chunk: number, lod: LodLevel, rows: readonly MergeRow[]): PackedChunk {
  const pool: PaintPool = { ids: new Map(), list: [] };
  const out = mergeInto(chunk, lod, rows, pool);
  out.paints = poolRecords(pool);
  return out;
}

/**
 * Merges a chunk at several LODs with **one paint list for all of them**: every returned chunk carries the same `paints`
 * array (the same object), in first-use order over the levels as given. A key's LODs mostly repeat the same paints, so the
 * map paint table holds a chunk's colours once instead of once per level, and the chunk's meshes share one `paintBase`.
 */
export function mergeChunkLods(chunk: number, levels: ReadonlyArray<{ lod: LodLevel; rows: readonly MergeRow[] }>): PackedChunk[] {
  const pool: PaintPool = { ids: new Map(), list: [] };
  const out = levels.map((l) => mergeInto(chunk, l.lod, l.rows, pool));
  const paints = poolRecords(pool);
  for (const c of out) c.paints = paints;
  return out;
}

/**
 * Merges the parts of a cell (`map-plan.ts` `partitionChunk`), each at several LODs, with **one paint list for the whole
 * job**: every returned chunk carries the same `paints` array. Returns the parts in the order given, each with its levels in
 * the order given; `rows` of a chunk are the job rows of its part.
 */
export function mergeChunkParts(chunk: number, parts: ReadonlyArray<{ label: string; rows: readonly number[]; levels: ReadonlyArray<{ lod: LodLevel; rows: readonly MergeRow[] }> }>): PackedChunk[] {
  const pool: PaintPool = { ids: new Map(), list: [] };
  const out: PackedChunk[] = [];
  for (const part of parts) {
    for (const level of part.levels) {
      if (level.rows.length !== part.rows.length) throw new RangeError(`mergeChunkParts: part '${part.label}' of chunk ${chunk} names ${part.rows.length} rows and gives ${level.rows.length} at lod ${level.lod}`);
      const c = mergeInto(chunk, level.lod, level.rows, pool);
      c.part = part.label;
      c.rows = Uint32Array.from(part.rows);
      out.push(c);
    }
  }
  const paints = poolRecords(pool);
  for (const c of out) c.paints = paints;
  return out;
}

function mergeInto(chunk: number, lod: LodLevel, rows: readonly MergeRow[], pool: PaintPool): PackedChunk {
  let vertices = 0;
  let indices = 0;
  for (const r of rows) {
    vertices += r.lod.vertices;
    indices += r.lod.idx.length;
  }
  if (vertices === 0 || indices === 0) return emptyChunk(chunk, lod, rows.length);

  // 1. dequantise every row's vertices, move them to world space, take the chunk bbox
  const world = new Float64Array(vertices * 3);
  let min0 = Infinity, min1 = Infinity, min2 = Infinity;
  let max0 = -Infinity, max1 = -Infinity, max2 = -Infinity;
  let v0 = 0;
  for (const r of rows) {
    const l = r.lod;
    const q = new Int16Array(l.vtx);
    const m = r.m;
    const cx = (l.bboxMin[0] + l.bboxMax[0]) / 2, cy = (l.bboxMin[1] + l.bboxMax[1]) / 2, cz = (l.bboxMin[2] + l.bboxMax[2]) / 2;
    const hx = (l.bboxMax[0] - l.bboxMin[0]) / 2 / QMAX, hy = (l.bboxMax[1] - l.bboxMin[1]) / 2 / QMAX, hz = (l.bboxMax[2] - l.bboxMin[2]) / 2 / QMAX;
    const m0 = m[0]!, m1 = m[1]!, m2 = m[2]!, m4 = m[4]!, m5 = m[5]!, m6 = m[6]!, m8 = m[8]!, m9 = m[9]!, m10 = m[10]!, m12 = m[12]!, m13 = m[13]!, m14 = m[14]!;
    for (let i = 0; i < l.vertices; i++) {
      const x = cx + q[i * 4]! * hx, y = cy + q[i * 4 + 1]! * hy, z = cz + q[i * 4 + 2]! * hz;
      const wx = m0 * x + m4 * y + m8 * z + m12;
      const wy = m1 * x + m5 * y + m9 * z + m13;
      const wz = m2 * x + m6 * y + m10 * z + m14;
      const o = (v0 + i) * 3;
      world[o] = wx;
      world[o + 1] = wy;
      world[o + 2] = wz;
      if (wx < min0) min0 = wx;
      if (wx > max0) max0 = wx;
      if (wy < min1) min1 = wy;
      if (wy > max1) max1 = wy;
      if (wz < min2) min2 = wz;
      if (wz > max2) max2 = wz;
    }
    v0 += l.vertices;
  }
  if (!Number.isFinite(min0 + min1 + min2 + max0 + max1 + max2)) throw new RangeError(`mergeChunk: chunk ${chunk} has a non-finite row transform`);

  // 2. chunk-local paints (deduplicated by their float bits) and the requantised vertices
  const paintIds = pool.ids;
  const paintList = pool.list;
  const vtx = new ArrayBuffer(vertices * VERTEX_STRIDE);
  const out = new Int16Array(vtx);
  const c0 = (min0 + max0) / 2, c1 = (min1 + max1) / 2, c2 = (min2 + max2) / 2;
  const h0 = (max0 - min0) / 2, h1 = (max1 - min1) / 2, h2 = (max2 - min2) / 2;
  const s0 = h0 > 0 ? QMAX / h0 : 0, s1 = h1 > 0 ? QMAX / h1 : 0, s2 = h2 > 0 ? QMAX / h2 : 0;
  const quant = (v: number, c: number, s: number): number => {
    const q = Math.round((v - c) * s);
    return q > QMAX ? QMAX : q < -QMAX ? -QMAX : q;
  };
  const normals = rows.some((r) => r.lod.normals !== undefined) ? new Int8Array(vertices * 4) : undefined;
  v0 = 0;
  for (const r of rows) {
    const l = r.lod;
    const q = new Int16Array(l.vtx);
    if (normals) {
      const src = l.normals;
      // the inverse transpose of the row's 3 × 3, up to scale: its cofactor matrix, with the sign of the determinant
      const m = r.m;
      const a = m[0]!, b = m[4]!, c = m[8]!, d = m[1]!, e = m[5]!, f = m[9]!, g = m[2]!, h = m[6]!, i = m[10]!;
      const c00 = e * i - f * h, c01 = f * g - d * i, c02 = d * h - e * g;
      const c10 = c * h - b * i, c11 = a * i - c * g, c12 = b * g - a * h;
      const c20 = b * f - c * e, c21 = c * d - a * f, c22 = a * e - b * d;
      const sign = a * c00 + b * c01 + c * c02 < 0 ? -1 : 1;
      for (let k = 0; k < l.vertices; k++) {
        const nx = src ? src[k * 4]! : 0, ny = src ? src[k * 4 + 1]! : 0, nz = src ? src[k * 4 + 2]! : 0;
        writeMeshNormal(normals, (v0 + k) * 4, sign * (c00 * nx + c01 * ny + c02 * nz), sign * (c10 * nx + c11 * ny + c12 * nz), sign * (c20 * nx + c21 * ny + c22 * nz), h0, h1, h2);
      }
    }
    const local = l.paints.length / PAINT_FLOATS;
    const remap = new Int32Array(local).fill(-1);
    const bits = new Uint32Array(l.paints.buffer, l.paints.byteOffset, l.paints.length);
    for (let i = 0; i < l.vertices; i++) {
      const p = q[i * 4 + 3]! + PAINT_ID_BIAS;
      let id = remap[p]!;
      if (id < 0) {
        const key = bits.subarray(p * PAINT_FLOATS, (p + 1) * PAINT_FLOATS).join(',');
        const known = paintIds.get(key);
        if (known === undefined) {
          id = paintList.length;
          if (id >= MAX_LOCAL_PAINTS) throw new RangeError(`mergeChunk: chunk ${chunk} holds more than 65,535 distinct paints`);
          paintIds.set(key, id);
          paintList.push(l.paints.subarray(p * PAINT_FLOATS, (p + 1) * PAINT_FLOATS));
        } else id = known;
        remap[p] = id;
      }
      const o = (v0 + i) * 3;
      const w = (v0 + i) * 4;
      out[w] = quant(world[o]!, c0, s0);
      out[w + 1] = quant(world[o + 1]!, c1, s1);
      out[w + 2] = quant(world[o + 2]!, c2, s2);
      out[w + 3] = id - PAINT_ID_BIAS;
    }
    v0 += l.vertices;
  }

  // 3. indices: casting opaque, other opaque, transparent
  const idx = vertices <= 65536 ? new Uint16Array(indices) : new Uint32Array(indices);
  const rowRanges = new Uint32Array(rows.length * ROW_RANGE_STRIDE);
  const base = new Uint32Array(rows.length);
  v0 = 0;
  for (let r = 0; r < rows.length; r++) {
    base[r] = v0;
    v0 += rows[r]!.lod.vertices;
  }
  let at = 0;
  const copy = (r: number, first: number, count: number): void => {
    const src = rows[r]!.lod.idx;
    const b = base[r]!;
    for (let i = 0; i < count; i++) idx[at + i] = src[first + i]! + b;
    at += count;
  };
  let shadowIndexCount = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r]!;
      if (row.castShadow !== (pass === 0)) continue;
      rowRanges[r * ROW_RANGE_STRIDE] = at;
      rowRanges[r * ROW_RANGE_STRIDE + 1] = row.lod.opaqueIndexCount;
      copy(r, 0, row.lod.opaqueIndexCount);
    }
    if (pass === 0) shadowIndexCount = at;
  }
  const opaqueIndexCount = at;
  for (let r = 0; r < rows.length; r++) {
    const l = rows[r]!.lod;
    const count = l.idx.length - l.opaqueIndexCount;
    rowRanges[r * ROW_RANGE_STRIDE + 2] = at;
    rowRanges[r * ROW_RANGE_STRIDE + 3] = count;
    copy(r, l.opaqueIndexCount, count);
  }

  const merged: PackedChunk = {
    chunk,
    part: '',
    rows: Uint32Array.from({ length: rows.length }, (_v, i) => i),
    lod,
    vtx,
    idx,
    opaqueIndexCount,
    shadowIndexCount,
    paints: NO_PAINTS, // set by the caller once its pool is complete
    rowRanges,
    bboxMin: [min0, min1, min2],
    bboxMax: [max0, max1, max2],
    tris: indices / 3,
    vertices,
  };
  if (normals) merged.normals = normals;
  return merged;
}

/**
 * Joins packed chunks of one LOD into one (a far mesh, DR-35 lever 4): the members' vertices moved to the union bbox's
 * quantised space, their indices one after the other (every opaque range first, then every transparent range, members in
 * the order given), their normals re-expressed in the new quantised space, and a paint list of its own with only the paints
 * the vertices use, deduplicated across the members by their float bits. `rowRanges` lists the rows of the members one
 * member after the other, so row `r` of member `m` is row `(rows of the members before m) + r` here. No shadow range
 * (`shadowIndexCount` 0): the shadow proxies stay with the parts. Deterministic. Members with no triangles are skipped but
 * keep their rows.
 */
export function mergePackedChunks(far: number, members: readonly PackedChunk[]): PackedChunk {
  const rowCount = members.reduce((n, c) => n + c.rowRanges.length / ROW_RANGE_STRIDE, 0);
  const live = members.filter((c) => c.tris > 0);
  const lod = (members[0]?.lod ?? 5) as LodLevel;
  if (live.length === 0) {
    const empty = emptyChunk(far, lod, rowCount);
    empty.part = 'F';
    return empty;
  }
  for (const c of live) if (c.lod !== lod) throw new RangeError(`mergePackedChunks: far group ${far} mixes lod ${lod} and lod ${c.lod}`);
  let vertices = 0;
  let indices = 0;
  let min0 = Infinity, min1 = Infinity, min2 = Infinity;
  let max0 = -Infinity, max1 = -Infinity, max2 = -Infinity;
  for (const c of live) {
    vertices += c.vertices;
    indices += c.idx.length;
    if (c.bboxMin[0] < min0) min0 = c.bboxMin[0];
    if (c.bboxMin[1] < min1) min1 = c.bboxMin[1];
    if (c.bboxMin[2] < min2) min2 = c.bboxMin[2];
    if (c.bboxMax[0] > max0) max0 = c.bboxMax[0];
    if (c.bboxMax[1] > max1) max1 = c.bboxMax[1];
    if (c.bboxMax[2] > max2) max2 = c.bboxMax[2];
  }
  const centre = [(min0 + max0) / 2, (min1 + max1) / 2, (min2 + max2) / 2];
  const half = [(max0 - min0) / 2, (max1 - min1) / 2, (max2 - min2) / 2];
  const scale = half.map((h) => (h > 0 ? QMAX / h : 0));
  const vtx = new ArrayBuffer(vertices * VERTEX_STRIDE);
  const out = new Int16Array(vtx);
  const normals = live.some((c) => c.normals !== undefined) ? new Int8Array(vertices * 4) : undefined;
  const pool: PaintPool = { ids: new Map(), list: [] };
  let v0 = 0;
  for (const c of live) {
    const q = new Int16Array(c.vtx);
    const local = c.paints.length / PAINT_FLOATS;
    const remap = new Int32Array(local).fill(-1);
    const bits = new Uint32Array(c.paints.buffer, c.paints.byteOffset, c.paints.length);
    for (let a = 0; a < 3; a++) {
      const cc = (c.bboxMin[a]! + c.bboxMax[a]!) / 2;
      const ch = (c.bboxMax[a]! - c.bboxMin[a]!) / 2 / QMAX;
      const fc = centre[a]!;
      const fs = scale[a]!;
      for (let i = 0; i < c.vertices; i++) {
        const w = Math.round((cc + q[i * 4 + a]! * ch - fc) * fs);
        out[(v0 + i) * 4 + a] = w > QMAX ? QMAX : w < -QMAX ? -QMAX : w;
      }
    }
    for (let i = 0; i < c.vertices; i++) {
      const p = q[i * 4 + 3]! + PAINT_ID_BIAS;
      let id = remap[p]!;
      if (id < 0) {
        const key = bits.subarray(p * PAINT_FLOATS, (p + 1) * PAINT_FLOATS).join(',');
        const known = pool.ids.get(key);
        if (known === undefined) {
          id = pool.list.length;
          if (id >= MAX_LOCAL_PAINTS) throw new RangeError(`mergePackedChunks: far group ${far} holds more than 65,535 distinct paints`);
          pool.ids.set(key, id);
          pool.list.push(c.paints.subarray(p * PAINT_FLOATS, (p + 1) * PAINT_FLOATS));
        } else id = known;
        remap[p] = id;
      }
      out[(v0 + i) * 4 + 3] = id - PAINT_ID_BIAS;
    }
    if (normals) {
      const src = c.normals;
      // a member's normal is n ⊙ h(member), renormalised; in the far mesh's space it is n ⊙ h(far): scale each axis by
      // h(far) / h(member), an axis with no extent counting as `writeMeshNormal` and the dequantisation count it
      const k0 = (half[0]! || MIN_HALF_EXTENT) / ((c.bboxMax[0] - c.bboxMin[0]) / 2 || MIN_HALF_EXTENT);
      const k1 = (half[1]! || MIN_HALF_EXTENT) / ((c.bboxMax[1] - c.bboxMin[1]) / 2 || MIN_HALF_EXTENT);
      const k2 = (half[2]! || MIN_HALF_EXTENT) / ((c.bboxMax[2] - c.bboxMin[2]) / 2 || MIN_HALF_EXTENT);
      for (let i = 0; i < c.vertices; i++) {
        const o = (v0 + i) * 4;
        if (!src || src[i * 4 + 3] === 0) {
          normals[o] = 0;
          normals[o + 1] = 127;
          normals[o + 2] = 0;
          normals[o + 3] = 0;
          continue;
        }
        const x = src[i * 4]! * k0, y = src[i * 4 + 1]! * k1, z = src[i * 4 + 2]! * k2;
        const l = Math.hypot(x, y, z) || 1;
        normals[o] = Math.round((x / l) * 127);
        normals[o + 1] = Math.round((y / l) * 127);
        normals[o + 2] = Math.round((z / l) * 127);
        normals[o + 3] = src[i * 4 + 3]!;
      }
    }
    v0 += c.vertices;
  }
  const idx = vertices <= 65536 ? new Uint16Array(indices) : new Uint32Array(indices);
  const rowRanges = new Uint32Array(rowCount * ROW_RANGE_STRIDE);
  // where each member's opaque and transparent ranges start in the far index
  const opaqueAt = new Uint32Array(members.length);
  const transparentAt = new Uint32Array(members.length);
  let at = 0;
  members.forEach((c, m) => {
    opaqueAt[m] = at;
    if (c.tris > 0) at += c.opaqueIndexCount;
  });
  const opaqueIndexCount = at;
  members.forEach((c, m) => {
    transparentAt[m] = at;
    if (c.tris > 0) at += c.idx.length - c.opaqueIndexCount;
  });
  v0 = 0;
  let row0 = 0;
  members.forEach((c, m) => {
    const n = c.rowRanges.length / ROW_RANGE_STRIDE;
    if (c.tris > 0) {
      const o = opaqueAt[m]!;
      const t = transparentAt[m]!;
      for (let i = 0; i < c.opaqueIndexCount; i++) idx[o + i] = c.idx[i]! + v0;
      for (let i = c.opaqueIndexCount; i < c.idx.length; i++) idx[t + i - c.opaqueIndexCount] = c.idx[i]! + v0;
      for (let r = 0; r < n; r++) {
        const src = r * ROW_RANGE_STRIDE;
        const dst = (row0 + r) * ROW_RANGE_STRIDE;
        rowRanges[dst] = o + c.rowRanges[src]!;
        rowRanges[dst + 1] = c.rowRanges[src + 1]!;
        rowRanges[dst + 2] = t + c.rowRanges[src + 2]! - c.opaqueIndexCount;
        rowRanges[dst + 3] = c.rowRanges[src + 3]!;
      }
      v0 += c.vertices;
    }
    row0 += n;
  });
  const merged: PackedChunk = {
    chunk: far,
    part: 'F',
    rows: Uint32Array.from({ length: rowCount }, (_v, i) => i),
    lod,
    vtx,
    idx,
    opaqueIndexCount,
    shadowIndexCount: 0,
    paints: poolRecords(pool),
    rowRanges,
    bboxMin: [min0, min1, min2],
    bboxMax: [max0, max1, max2],
    tris: indices / 3,
    vertices,
  };
  if (normals) merged.normals = normals;
  return merged;
}

/** Every buffer of a chunk reply, once each: the transfer list (zero copy). */
export function packedChunkTransfers(chunks: readonly PackedChunk[]): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  const add = (b: ArrayBufferLike): void => {
    if (b instanceof ArrayBuffer && b.byteLength > 0) out.add(b);
  };
  for (const c of chunks) {
    add(c.vtx);
    add(c.idx.buffer);
    add(c.paints.buffer);
    add(c.rowRanges.buffer);
    add(c.rows.buffer);
    if (c.normals) add(c.normals.buffer);
  }
  return [...out];
}

/** Bytes a packed chunk holds (vertex + index + paint + range buffers). */
export function packedChunkBytes(c: PackedChunk): number {
  return c.vtx.byteLength + c.idx.byteLength + c.paints.byteLength + c.rowRanges.byteLength + (c.normals?.byteLength ?? 0);
}

/** Dequantised world positions of a chunk's vertices, 3 per vertex (tests, tools). */
export function chunkVertexPositions(c: PackedChunk): Float64Array {
  const v = new Int16Array(c.vtx);
  const out = new Float64Array(c.vertices * 3);
  for (let a = 0; a < 3; a++) {
    const centre = (c.bboxMin[a]! + c.bboxMax[a]!) / 2;
    const half = (c.bboxMax[a]! - c.bboxMin[a]!) / 2;
    for (let i = 0; i < c.vertices; i++) out[i * 3 + a] = centre + (v[i * 4 + a]! / QMAX) * half;
  }
  return out;
}
