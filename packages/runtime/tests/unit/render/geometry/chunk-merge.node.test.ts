// chunk-merge.ts and the chunk job of the geometry worker and service (render §6.4, §6.5; WP R3): merged 32 m chunks are
// built where the generators run. The merge is engine-free; the main-thread modules import only its types.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { chunkVertexPositions, mergeChunk, mergePackedChunks, packedChunkBytes, packedChunkTransfers, type ChunkJob, type PackedChunk } from '../../../../src/render/geometry/chunk-merge.ts';
import type { GeometryContext, ScriptedSpec } from '../../../../src/render/geometry/generator-types.ts';
import { createInProcessExecutor, createJobRunner, serveJobs, type ModuleLoader, type ToWorker } from '../../../../src/render/geometry/geometry-worker.ts';
import { costLookup, GeometryServiceImpl, WorkerPoolExecutor, type WorkerLike } from '../../../../src/render/geometry/geometry-service.ts';
import { chunkCell, chunkIdOf, CHUNK_SIZE, farIdOf, removeRowFromIndex, ROW_RANGE_STRIDE } from '../../../../src/render/geometry/map-plan.ts';
import { lodPaintIds, lodVertexPositions, PAINT_FLOATS, PAINT_ID_BIAS, type PackedLod } from '../../../../src/render/geometry/pack.ts';
import { keyOf } from '../../../../src/render/geometry/generator-types.ts';

/** a closed box with a red body, a glass pane (alpha 0.4) on top at LOD 1, standing on the origin */
const MODULES: Record<string, unknown> = {
  'scripts/gen/crate.js': {
    geometry(ctx: GeometryContext) {
      const s = Number(ctx.params['s'] ?? 1);
      ctx.color(String(ctx.params['c'] ?? 'oklch(0.5 0.1 30)'));
      ctx.quad(0, 0, 0, 0, s, 0, s, s, 0, s, 0, 0);
      ctx.quad(0, 0, s, s, 0, s, s, s, s, 0, s, s);
      if (ctx.lod === 1) {
        ctx.color('oklch(0.2 0.03 230)', 0.4);
        ctx.quad(0, s, 0, 0, s, s, s, s, s, s, s, 0);
      }
    },
  },
  // a smooth quad facing −Z (normal (0, 0, −1)) and, at LOD 1, a flat quad beside it
  'scripts/gen/panel.js': {
    geometry(ctx: GeometryContext) {
      ctx.color('oklch(0.5 0.1 30)');
      ctx.smooth();
      ctx.quad(0, 0, 0, 0, 2, 0, 1, 2, 0, 1, 0, 0);
      ctx.flat();
      if (ctx.lod === 1) ctx.quad(2, 0, 0, 2, 2, 0, 3, 2, 0, 3, 0, 0);
    },
  },
  'scripts/gen/slab.js': {
    geometry(ctx: GeometryContext) {
      ctx.color('oklch(0.5 0.1 30)');
      ctx.quad(-2, 0, -2, -2, 0, 2, 2, 0, 2, 2, 0, -2);
    },
  },
};
const load: ModuleLoader = async (script) => {
  const m = MODULES[script];
  if (!m) throw new Error(`unknown generator script ${script}`);
  return m;
};
const spec = (script: string, params: Record<string, unknown> = {}): ScriptedSpec => ({ kind: 'scripted', script, params });

/** column-major translation · yaw · uniform scale */
function matrix(x: number, y: number, z: number, yawDeg = 0, scale = 1): Float32Array {
  const a = (yawDeg * Math.PI) / 180;
  const c = Math.cos(a) * scale, s = Math.sin(a) * scale;
  return new Float32Array([c, 0, -s, 0, 0, scale, 0, 0, s, 0, c, 0, x, y, z, 1]);
}
const apply = (m: ArrayLike<number>, p: [number, number, number]): [number, number, number] => [
  m[0]! * p[0] + m[4]! * p[1] + m[8]! * p[2] + m[12]!,
  m[1]! * p[0] + m[5]! * p[1] + m[9]! * p[2] + m[13]!,
  m[2]! * p[0] + m[6]! * p[1] + m[10]! * p[2] + m[14]!,
];

function hashChunk(c: PackedChunk): string {
  const h = createHash('sha256');
  h.update(`${c.chunk}|${c.part}|${Array.from(c.rows).join(',')}|${c.lod}|${c.vertices}|${c.tris}|${c.opaqueIndexCount}|${c.shadowIndexCount}|${c.bboxMin.join(',')}|${c.bboxMax.join(',')}|i${c.idx.BYTES_PER_ELEMENT}|`);
  h.update(new Uint8Array(c.vtx));
  for (const a of [c.idx, c.paints, c.rowRanges]) h.update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength));
  return h.digest('hex').slice(0, 16);
}

const job = (): ChunkJob => ({
  place: 'test-place',
  chunk: chunkIdOf(40, -10),
  rows: [
    { spec: spec('scripts/gen/crate.js', { s: 2 }), m: matrix(34, 0, -6) },
    { spec: spec('scripts/gen/slab.js'), m: matrix(48, 0.5, -20, 30), castShadow: false },
    { spec: spec('scripts/gen/crate.js', { s: 2 }), m: matrix(60, 1, -30, 90, 1.5) },
    { spec: spec('scripts/gen/crate.js', { s: 1, c: 'oklch(0.7 0.2 140)' }), m: matrix(40, 0, -12) },
  ],
  lods: [1, 5],
});

/** An in-memory worker: structured-clones every message with its transfer list, like postMessage does. */
class FakeWorker implements WorkerLike {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  posted: ToWorker[] = [];
  private listeners: Array<(ev: { data: unknown }) => void> = [];
  constructor() {
    serveJobs(
      {
        postMessage: (msg: unknown, transfer: ArrayBuffer[]) => {
          const data = structuredClone(msg, { transfer });
          setTimeout(() => this.onmessage?.({ data }), 0);
        },
        addEventListener: (_type: 'message', fn: (ev: { data: unknown }) => void) => this.listeners.push(fn),
      },
      load,
    );
  }
  postMessage(msg: unknown, transfer: ArrayBuffer[] = []): void {
    this.posted.push(msg as ToWorker);
    const data = structuredClone(msg, { transfer });
    setTimeout(() => {
      for (const l of this.listeners) l({ data });
    }, 0);
  }
  terminate(): void {}
}

describe('chunk grid', () => {
  it('assigns world points to 32 m cells, negative coordinates included', () => {
    expect(CHUNK_SIZE).toBe(32);
    expect(chunkCell(chunkIdOf(0, 0))).toEqual([0, 0]);
    expect(chunkCell(chunkIdOf(31.99, 32))).toEqual([0, 1]);
    expect(chunkCell(chunkIdOf(-0.01, -32.01))).toEqual([-1, -2]);
    expect(chunkIdOf(5, 5)).toBe(chunkIdOf(20, 30));
    expect(chunkIdOf(5, 5)).not.toBe(chunkIdOf(-5, 5));
    expect(() => chunkIdOf(Number.NaN, 0)).toThrow(RangeError);
  });
});

describe('mergeChunk', () => {
  const pack = async (s: ScriptedSpec, lod: 1 | 5): Promise<PackedLod> => (await createJobRunner(load, { strict: true })({ id: 1, script: s.script, params: s.params, seed: s.seed, lods: [lod], collider: false })).lods[0]!;

  it('moves every row to world space, requantises to the chunk bbox and keeps positions within a quantisation step', async () => {
    const j = job();
    const lods = await Promise.all(j.rows.map((r) => pack(r.spec, 1)));
    const merged = mergeChunk(j.chunk, 1, j.rows.map((r, i) => ({ lod: lods[i]!, m: r.m, castShadow: r.castShadow !== false })));
    expect(merged.vertices).toBe(lods.reduce((n, l) => n + l.vertices, 0));
    expect(merged.tris).toBe(lods.reduce((n, l) => n + l.tris, 0));
    expect(merged.vtx.byteLength).toBe(merged.vertices * 8);
    const pos = chunkVertexPositions(merged);
    const step = Math.max(...[0, 1, 2].map((a) => (merged.bboxMax[a]! - merged.bboxMin[a]!) / 2 / 32767));
    let v = 0;
    for (let r = 0; r < j.rows.length; r++) {
      const local = lodVertexPositions(lods[r]!);
      for (let i = 0; i < lods[r]!.vertices; i++, v++) {
        const want = apply(j.rows[r]!.m, [local[i * 3]!, local[i * 3 + 1]!, local[i * 3 + 2]!]);
        for (let a = 0; a < 3; a++) {
          expect(Math.abs(pos[v * 3 + a]! - want[a]!)).toBeLessThanOrEqual(step * 0.5 + 1e-5);
          expect(want[a]!).toBeGreaterThanOrEqual(merged.bboxMin[a]! - 1e-5);
          expect(want[a]!).toBeLessThanOrEqual(merged.bboxMax[a]! + 1e-5);
        }
      }
    }
    // the bbox is the world bbox of the rows, not the nominal 32 m cell: the row at x 60 belongs to this job
    expect(merged.bboxMax[0]).toBeGreaterThan(60);
  });

  it('orders the index as casting opaque, other opaque, transparent, and records each row ranges', async () => {
    const j = job();
    const lods = await Promise.all(j.rows.map((r) => pack(r.spec, 1)));
    const merged = mergeChunk(j.chunk, 1, j.rows.map((r, i) => ({ lod: lods[i]!, m: r.m, castShadow: r.castShadow !== false })));
    // crate: 12 opaque + 6 transparent indices; slab: 6 opaque, casts no shadow
    expect(merged.shadowIndexCount).toBe(36);
    expect(merged.opaqueIndexCount).toBe(42);
    expect(merged.idx.length).toBe(42 + 18);
    expect(merged.rowRanges.length).toBe(4 * ROW_RANGE_STRIDE);
    expect(Array.from(merged.rowRanges)).toEqual([0, 12, 42, 6, 36, 6, 48, 0, 12, 12, 48, 6, 24, 12, 54, 6]);
    // every index of a row range points into that row's own vertices
    let base = 0;
    for (let r = 0; r < 4; r++) {
      const [of, oc, tf, tc] = Array.from(merged.rowRanges.subarray(r * 4, r * 4 + 4)) as [number, number, number, number];
      for (const i of [...merged.idx.subarray(of, of + oc), ...merged.idx.subarray(tf, tf + tc)]) {
        expect(i).toBeGreaterThanOrEqual(base);
        expect(i).toBeLessThan(base + lods[r]!.vertices);
      }
      base += lods[r]!.vertices;
    }
  });

  it('gives the chunk its own paint list: deduplicated across rows by the float record, ids in the D5 lane', async () => {
    const j = job();
    const lods = await Promise.all(j.rows.map((r) => pack(r.spec, 1)));
    const merged = mergeChunk(j.chunk, 1, j.rows.map((r, i) => ({ lod: lods[i]!, m: r.m, castShadow: true })));
    // red body (crates 0, 2 and the slab), glass (all three crates), green body (crate 3)
    expect(merged.paints.length / PAINT_FLOATS).toBe(3);
    expect(merged.paints[PAINT_FLOATS + 3]).toBeCloseTo(0.4, 6);
    const raw = new Int16Array(merged.vtx);
    const ids = new Set<number>();
    for (let v = 0; v < merged.vertices; v++) ids.add(raw[v * 4 + 3]! + PAINT_ID_BIAS);
    expect([...ids].sort()).toEqual([0, 1, 2]);
    // the paint of a merged vertex is the record its key had
    let v = 0;
    for (let r = 0; r < 4; r++) {
      const own = lodPaintIds(lods[r]!);
      for (let i = 0; i < lods[r]!.vertices; i++, v++) {
        const a = merged.paints.subarray((raw[v * 4 + 3]! + PAINT_ID_BIAS) * PAINT_FLOATS, (raw[v * 4 + 3]! + PAINT_ID_BIAS + 1) * PAINT_FLOATS);
        const b = lods[r]!.paints.subarray(own[i]! * PAINT_FLOATS, (own[i]! + 1) * PAINT_FLOATS);
        expect(Array.from(a)).toEqual(Array.from(b));
      }
    }
  });

  it('carries smooth normals: turned by the row, written in the chunk quantised space, flat vertices marked', async () => {
    const panel = spec('scripts/gen/panel.js');
    const lod = await pack(panel, 1);
    expect(lod.normals).toBeInstanceOf(Int8Array);
    // one row turned 90° about +Y (its −Z normal becomes −X), one mirrored in x (its normal stays −Z, the winding flips)
    const turned = matrix(100, 0, 100, 90);
    const mirrored = new Float32Array([-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 110, 0, 104, 1]);
    const merged = mergeChunk(1, 1, [
      { lod, m: turned, castShadow: true },
      { lod, m: mirrored, castShadow: true },
      { lod: await pack(spec('scripts/gen/slab.js'), 1), m: matrix(105, 0, 105), castShadow: true },
    ]);
    const n = merged.normals!;
    expect(n.length).toBe(merged.vertices * 4);
    const h = [0, 1, 2].map((a) => (merged.bboxMax[a]! - merged.bboxMin[a]!) / 2);
    const unquantise = (v: number): number[] => {
      // the inverse transpose of scale(h) and a renormalisation: what three does with the attribute
      const m = [n[v * 4]! / h[0]!, n[v * 4 + 1]! / h[1]!, n[v * 4 + 2]! / h[2]!];
      const l = Math.hypot(...m);
      return m.map((x) => x / l);
    };
    const src = lod.normals!;
    let smooth = 0;
    for (let v = 0; v < lod.vertices; v++) {
      const isSmooth = src[v * 4 + 2] !== 0;
      if (!isSmooth) {
        expect(Array.from(n.subarray(v * 4, v * 4 + 4))).toEqual([0, 127, 0, 0]);
        expect(Array.from(n.subarray((lod.vertices + v) * 4, (lod.vertices + v) * 4 + 4))).toEqual([0, 127, 0, 0]);
        continue;
      }
      smooth++;
      expect(src[v * 4 + 2]).toBe(-127);
      expect(n[v * 4 + 3]).toBe(127);
      const a = unquantise(v);
      expect(a[0]).toBeCloseTo(-1, 2);
      expect(Math.abs(a[1]!) + Math.abs(a[2]!)).toBeLessThan(0.02);
      const b = unquantise(lod.vertices + v);
      expect(b[2]).toBeCloseTo(-1, 2);
      expect(Math.abs(b[0]!) + Math.abs(b[1]!)).toBeLessThan(0.02);
    }
    expect(smooth).toBe(4);
    // the slab has no smooth face: its vertices are all marked flat
    for (let v = lod.vertices * 2; v < merged.vertices; v++) expect(n[v * 4 + 3]).toBe(0);
    // a chunk with no smooth row carries no normals at all
    const flat = mergeChunk(1, 1, [{ lod: await pack(spec('scripts/gen/slab.js'), 1), m: matrix(0, 0, 0), castShadow: true }]);
    expect(flat.normals).toBeUndefined();
    // vtx, idx, paints, rowRanges, rows, normals
    expect(packedChunkTransfers([merged])).toHaveLength(6);
  });

  it('is deterministic, lists every buffer once for the transfer and survives an empty job', async () => {
    const j = job();
    const lods = await Promise.all(j.rows.map((r) => pack(r.spec, 5)));
    const rows = j.rows.map((r, i) => ({ lod: lods[i]!, m: r.m, castShadow: true }));
    const a = mergeChunk(j.chunk, 5, rows);
    const b = mergeChunk(j.chunk, 5, rows);
    expect(hashChunk(a)).toBe(hashChunk(b));
    const buffers = packedChunkTransfers([a, b]);
    expect(buffers).toHaveLength(10);
    expect(new Set(buffers).size).toBe(10);
    // an unsplit merge is one part holding every row, in order
    expect([a.part, Array.from(a.rows)]).toEqual(['', [0, 1, 2, 3]]);
    expect(packedChunkBytes(a)).toBe(a.vtx.byteLength + a.idx.byteLength + a.paints.byteLength + a.rowRanges.byteLength);
    const empty = mergeChunk(7, 5, []);
    expect([empty.vertices, empty.tris, empty.idx.length]).toEqual([0, 0, 0]);
  });

  it('removes a promoted row by degenerating its index ranges and reports what to upload', async () => {
    const j = job();
    const lods = await Promise.all(j.rows.map((r) => pack(r.spec, 1)));
    const merged = mergeChunk(j.chunk, 1, j.rows.map((r, i) => ({ lod: lods[i]!, m: r.m, castShadow: r.castShadow !== false })));
    const before = Array.from(merged.idx);
    const ranges = removeRowFromIndex(merged.idx, merged.rowRanges, 2);
    expect(ranges).toEqual([{ start: 12, count: 12 }, { start: 48, count: 6 }]);
    for (let i = 0; i < before.length; i++) {
      const inside = (i >= 12 && i < 24) || (i >= 48 && i < 54);
      expect(merged.idx[i]).toBe(inside ? 0 : before[i]);
    }
    // a second promote of the same row writes nothing
    expect(removeRowFromIndex(merged.idx, merged.rowRanges, 2)).toEqual([]);
  });
});

describe('chunk jobs', () => {
  it('builds one chunk per LOD in a worker, by transfer, with hashes equal to the in-process (Node) path', async () => {
    const inProcess = new GeometryServiceImpl({ executor: createInProcessExecutor(load, { strict: true }) });
    const reference = await inProcess.buildChunks(job());
    expect(reference.map((c) => c.lod)).toEqual([1, 5]);
    expect(reference[0]!.tris).toBe(3 * 6 + 2);
    expect(reference[1]!.tris).toBe(3 * 4 + 2);

    const workers: FakeWorker[] = [];
    const pool = new WorkerPoolExecutor(() => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    }, 2);
    const svc = new GeometryServiceImpl({ executor: pool });
    const viaWorker = await svc.buildChunks(job());
    expect(viaWorker.map(hashChunk)).toEqual(reference.map(hashChunk));
    // the chunk's LODs share one paint list (one block of the map paint table), on both paths and across the clone
    expect(reference[1]!.paints).toBe(reference[0]!.paints);
    expect(viaWorker[1]!.paints).toBe(viaWorker[0]!.paints);
    expect(reference[0]!.paints.length / PAINT_FLOATS).toBe(3);
    // one message carried the whole chunk: no key job was posted, so generation and merge both ran behind the worker boundary
    const posted = workers.flatMap((w) => w.posted).filter((m) => m.type !== 'config');
    expect(posted.map((m) => m.type)).toEqual(['chunk']);
    // the row matrices crossed by structured clone; the reply's buffers are their own (transferred) ArrayBuffers
    expect(viaWorker[0]!.vtx).not.toBe(reference[0]!.vtx);
    expect(viaWorker[0]!.vtx.byteLength).toBe(reference[0]!.vtx.byteLength);
    svc.dispose();
    inProcess.dispose();
  });

  it('queues chunk jobs longest first by the summed cost of their keys and reports a failing generator with the chunk named', async () => {
    const order: number[] = [];
    const pool = new WorkerPoolExecutor(() => new FakeWorker(), 1);
    const svc = new GeometryServiceImpl({
      executor: pool,
      cost: costLookup({ keys: { [keyOf(spec('scripts/gen/slab.js'))]: 40 }, scripts: { 'scripts/gen/crate.js': 5 } }),
    });
    const one = (chunk: number, rows: ChunkJob['rows']): Promise<void> =>
      svc.buildChunks({ place: 'p', chunk, rows, lods: [5] }).then(() => {
        order.push(chunk);
      });
    const crate = (s: number): ChunkJob['rows'][number] => ({ spec: spec('scripts/gen/crate.js', { s }), m: matrix(0, 0, 0) });
    await Promise.all([
      one(1, [crate(1)]), // starts at once (idle pool)
      one(2, [crate(1)]), // 5
      one(3, [crate(1), crate(2), { spec: spec('scripts/gen/slab.js'), m: matrix(0, 0, 0) }]), // 5 + 5 + 40
      one(4, [crate(1), crate(2)]), // 10; the same key twice in a chunk counts once
    ]);
    expect(order).toEqual([1, 3, 4, 2]);
    await expect(svc.buildChunks({ place: 'p', chunk: 9, rows: [{ spec: spec('scripts/gen/missing.js'), m: matrix(0, 0, 0) }], lods: [5] })).rejects.toThrow(/missing\.js/);
    svc.dispose();
  });

  // DR-35 lever 2: a job with a split returns one chunk per (part, LOD). The cell is (1, −1): x 32..64, z −32..0
  const splitJob = (): ChunkJob => ({
    place: 'test-place',
    chunk: chunkIdOf(40, -10),
    rows: [
      { spec: spec('scripts/gen/crate.js', { s: 2 }), m: matrix(34, 0, -30) }, // quadrant 0 (x low, z low), then 00
      { spec: spec('scripts/gen/crate.js', { s: 2 }), m: matrix(60, 0, -30) }, // quadrant 1 (x high)
      { spec: spec('scripts/gen/crate.js', { s: 1, c: 'oklch(0.7 0.2 140)' }), m: matrix(34, 0, -4) }, // quadrant 2 (z high)
      { spec: spec('scripts/gen/slab.js'), m: matrix(48, 0, -16, 0, 5), castShadow: false }, // 20 m wide: the large part
      { spec: spec('scripts/gen/crate.js', { s: 2 }), m: matrix(36, 0, -28) }, // quadrant 0 again, then 00
    ],
    lods: [1, 5],
    // a crate is 6 triangles at LOD 1: four crates are over the cap, one is not
    split: { cap: 6, oversize: 10, minCell: 8 },
  });

  it('cuts a cell into parts in the worker: large rows apart, quadrants while over the triangle cap, one paint list for the job', async () => {
    const inProcess = new GeometryServiceImpl({ executor: createInProcessExecutor(load, { strict: true }) });
    const reference = await inProcess.buildChunks(splitJob());
    // parts in depth-first quadrant order, then the large rows; each at the job's LODs
    expect(reference.map((c) => `${c.part}@${c.lod}`)).toEqual(['00@1', '00@5', '1@1', '1@5', '2@1', '2@5', 'L@1', 'L@5']);
    const part = (label: string, lod: number): PackedChunk => reference.find((c) => c.part === label && c.lod === lod)!;
    // the two crates of quadrant 0 stay together at the 8 m floor although they are over the cap
    expect(Array.from(part('00', 1).rows)).toEqual([0, 4]);
    expect(Array.from(part('1', 1).rows)).toEqual([1]);
    expect(Array.from(part('2', 5).rows)).toEqual([2]);
    expect(Array.from(part('L', 1).rows)).toEqual([3]);
    expect(part('00', 1).tris).toBe(12);
    expect(part('00', 5).tris).toBe(8);
    // a part's ranges are indexed by its own rows
    expect(part('00', 1).rowRanges.length).toBe(2 * ROW_RANGE_STRIDE);
    expect(Array.from(part('00', 1).rowRanges)).toEqual([0, 12, 24, 6, 12, 12, 30, 6]);
    // the slab casts no shadow: its part has no shadow range
    expect(part('L', 5).shadowIndexCount).toBe(0);
    expect(part('1', 5).shadowIndexCount).toBe(12);
    // every part keeps to its own rows' bounds: the long slab no longer stretches the crates' boxes
    expect([part('00', 1).bboxMin[0], part('00', 1).bboxMax[0]]).toEqual([34, 38]);
    expect([part('1', 1).bboxMin[0], part('1', 1).bboxMax[0]]).toEqual([60, 62]);
    expect([part('L', 1).bboxMin[0], part('L', 1).bboxMax[0]]).toEqual([38, 58]);
    // one paint list for the whole job (one block of the map paint table): red, glass, green; the slab is red too
    for (const c of reference) expect(c.paints).toBe(reference[0]!.paints);
    expect(reference[0]!.paints.length / PAINT_FLOATS).toBe(3);

    // the same job through a worker: equal bytes, parts and row lists, and still one paint list after the clone
    const pool = new WorkerPoolExecutor(() => new FakeWorker(), 1);
    const svc = new GeometryServiceImpl({ executor: pool });
    const viaWorker = await svc.buildChunks(splitJob());
    expect(viaWorker.map(hashChunk)).toEqual(reference.map(hashChunk));
    for (const c of viaWorker) expect(c.paints).toBe(viaWorker[0]!.paints);
    // without a split the same rows are one part
    const { split: _split, ...plain } = splitJob();
    expect((await inProcess.buildChunks(plain)).map((c) => `${c.part}@${c.lod}:${c.rows.length}`)).toEqual(['@1:5', '@5:5']);
    svc.dispose();
    inProcess.dispose();
  });

  // DR-35 lever 4: the far mesh of a group is a merge of packed chunks, with nothing generated again
  it('joins packed chunks into a far mesh: requantised to the union box, opaque ranges first, own paint list, rows rebased', async () => {
    const inProcess = new GeometryServiceImpl({ executor: createInProcessExecutor(load, { strict: true }) });
    const chunks = await inProcess.buildChunks(splitJob());
    // LOD 1 members: they have a transparent range too
    const members = chunks.filter((c) => c.lod === 1);
    const far = mergePackedChunks(77, members);
    expect([far.chunk, far.part, far.lod]).toEqual([77, 'F', 1]);
    expect(far.vertices).toBe(members.reduce((n, c) => n + c.vertices, 0));
    expect(far.tris).toBe(members.reduce((n, c) => n + c.tris, 0));
    expect(far.opaqueIndexCount).toBe(members.reduce((n, c) => n + c.opaqueIndexCount, 0));
    expect(far.shadowIndexCount).toBe(0);
    for (let a = 0; a < 3; a++) {
      expect(far.bboxMin[a]).toBe(Math.min(...members.map((c) => c.bboxMin[a]!)));
      expect(far.bboxMax[a]).toBe(Math.max(...members.map((c) => c.bboxMax[a]!)));
    }
    // every vertex is where its member had it, within the two quantisation steps
    const pos = chunkVertexPositions(far);
    const farStep = Math.max(...[0, 1, 2].map((a) => (far.bboxMax[a]! - far.bboxMin[a]!) / 2 / 32767));
    const raw = new Int16Array(far.vtx);
    let v = 0;
    for (const c of members) {
      const own = chunkVertexPositions(c);
      const ownRaw = new Int16Array(c.vtx);
      for (let i = 0; i < c.vertices; i++, v++) {
        for (let a = 0; a < 3; a++) expect(Math.abs(pos[v * 3 + a]! - own[i * 3 + a]!)).toBeLessThanOrEqual(farStep * 0.5 + 1e-9);
        // and carries the same paint record, under the far mesh's own id
        const id = raw[v * 4 + 3]! + PAINT_ID_BIAS;
        const ownId = ownRaw[i * 4 + 3]! + PAINT_ID_BIAS;
        expect(Array.from(far.paints.subarray(id * PAINT_FLOATS, (id + 1) * PAINT_FLOATS))).toEqual(Array.from(c.paints.subarray(ownId * PAINT_FLOATS, (ownId + 1) * PAINT_FLOATS)));
      }
    }
    expect(far.paints.length / PAINT_FLOATS).toBe(3);
    // rows one member after the other; a row's ranges hold the same triangles as in its member, as far vertex ids
    expect(far.rowRanges.length / ROW_RANGE_STRIDE).toBe(5);
    expect(Array.from(far.rows)).toEqual([0, 1, 2, 3, 4]);
    let row0 = 0;
    let v0 = 0;
    for (const c of members) {
      for (let r = 0; r < c.rowRanges.length / ROW_RANGE_STRIDE; r++) {
        const [of, oc, tf, tc] = Array.from(c.rowRanges.subarray(r * 4, r * 4 + 4)) as [number, number, number, number];
        const [fof, foc, ftf, ftc] = Array.from(far.rowRanges.subarray((row0 + r) * 4, (row0 + r) * 4 + 4)) as [number, number, number, number];
        expect([foc, ftc]).toEqual([oc, tc]);
        expect(Array.from(far.idx.subarray(fof, fof + foc))).toEqual(Array.from(c.idx.subarray(of, of + oc), (i) => i + v0));
        expect(Array.from(far.idx.subarray(ftf, ftf + ftc))).toEqual(Array.from(c.idx.subarray(tf, tf + tc), (i) => i + v0));
        // opaque ranges lie before every transparent range
        if (oc > 0) expect(fof + foc).toBeLessThanOrEqual(far.opaqueIndexCount);
        if (tc > 0) expect(ftf).toBeGreaterThanOrEqual(far.opaqueIndexCount);
      }
      row0 += c.rowRanges.length / ROW_RANGE_STRIDE;
      v0 += c.vertices;
    }
    // a promoted row leaves the far mesh by the same call as its chunk
    // (job row 4 is the second row of the first member: far row 1)
    expect(removeRowFromIndex(far.idx, far.rowRanges, 1)).toEqual([{ start: 12, count: 12 }, { start: far.opaqueIndexCount + 6, count: 6 }]);
    // deterministic, and it does not touch its members
    const before = members.map(hashChunk);
    expect(hashChunk(mergePackedChunks(77, members))).not.toBe(hashChunk(far)); // the row was removed from `far` above
    expect(hashChunk(mergePackedChunks(77, members))).toBe(hashChunk(mergePackedChunks(77, members)));
    expect(members.map(hashChunk)).toEqual(before);
    // members with nothing to draw are skipped but keep their rows; an empty group is an empty chunk
    const hollow = { ...members[0]!, tris: 0, vertices: 0, vtx: new ArrayBuffer(0), idx: new Uint16Array(0) };
    const skipped = mergePackedChunks(78, [hollow, members[1]!]);
    expect(skipped.tris).toBe(members[1]!.tris);
    expect(skipped.rowRanges.length / ROW_RANGE_STRIDE).toBe(3);
    expect(Array.from(skipped.rowRanges.subarray(0, 8))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(mergePackedChunks(79, [hollow]).tris).toBe(0);
    expect(() => mergePackedChunks(80, [chunks[0]!, chunks[1]!])).toThrow(/mixes lod/);
    inProcess.dispose();
  });

  it('re-expresses smooth normals in the far mesh quantised space and marks the vertices of flat members', async () => {
    const pack = async (s: ScriptedSpec): Promise<PackedLod> => (await createJobRunner(load, { strict: true })({ id: 1, script: s.script, params: s.params, seed: s.seed, lods: [1], collider: false })).lods[0]!;
    const panel = await pack(spec('scripts/gen/panel.js'));
    // a panel turned 90° about +Y (its smooth normal is −X in the world), and a flat slab far away on another box
    const a = mergeChunk(1, 1, [{ lod: panel, m: matrix(100, 0, 100, 90), castShadow: true }]);
    const b = mergeChunk(2, 1, [{ lod: await pack(spec('scripts/gen/slab.js')), m: matrix(160, 6, 130), castShadow: true }]);
    expect(a.normals).toBeInstanceOf(Int8Array);
    expect(b.normals).toBeUndefined();
    // the panel alone is a chunk with no extent along its normal: the normal is written against the dequantisation's
    // substitute scale for that axis, not against 0 (which left only the float noise of the other components)
    expect(a.bboxMax[0] - a.bboxMin[0]).toBe(0);
    expect(Array.from(a.normals!.subarray(0, 4))).toEqual([-127, 0, 0, 127]);
    const far = mergePackedChunks(3, [a, b]);
    const n = far.normals!;
    expect(n.length).toBe(far.vertices * 4);
    const h = [0, 1, 2].map((k) => (far.bboxMax[k]! - far.bboxMin[k]!) / 2);
    let smooth = 0;
    for (let v = 0; v < a.vertices; v++) {
      expect(n[v * 4 + 3]).toBe(a.normals![v * 4 + 3]);
      if (n[v * 4 + 3] === 0) {
        expect(Array.from(n.subarray(v * 4, v * 4 + 4))).toEqual([0, 127, 0, 0]);
        continue;
      }
      smooth++;
      // what three does with the attribute: the inverse transpose of scale(h), renormalised
      const m = [n[v * 4]! / h[0]!, n[v * 4 + 1]! / h[1]!, n[v * 4 + 2]! / h[2]!];
      const l = Math.hypot(...m);
      expect(m[0]! / l).toBeCloseTo(-1, 2);
      expect(Math.abs(m[1]! / l) + Math.abs(m[2]! / l)).toBeLessThan(0.03);
    }
    expect(smooth).toBe(4);
    for (let v = a.vertices; v < far.vertices; v++) expect(Array.from(n.subarray(v * 4, v * 4 + 4))).toEqual([0, 127, 0, 0]);
    // no member with normals: none in the far mesh
    expect(mergePackedChunks(4, [b, b]).normals).toBeUndefined();
  });

  it('builds a far mesh in a worker from copies of its members, by transfer, equal to the in-process path', async () => {
    const inProcess = new GeometryServiceImpl({ executor: createInProcessExecutor(load, { strict: true }) });
    const members = (await inProcess.buildChunks(splitJob())).filter((c) => c.lod === 5);
    const reference = await inProcess.buildFar({ place: 'test-place', far: farIdOf(splitJob().chunk), members });
    expect(reference.tris).toBe(members.reduce((n, c) => n + c.tris, 0));
    const workers: FakeWorker[] = [];
    const pool = new WorkerPoolExecutor(() => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    }, 1);
    const svc = new GeometryServiceImpl({ executor: pool });
    const viaWorker = await svc.buildFar({ place: 'test-place', far: farIdOf(splitJob().chunk), members });
    expect(hashChunk(viaWorker)).toBe(hashChunk(reference));
    expect(workers.flatMap((w) => w.posted).filter((m) => m.type !== 'config').map((m) => m.type)).toEqual(['far']);
    // the members were cloned, not transferred: the caller still draws from them
    for (const c of members) expect(c.vtx.byteLength).toBe(c.vertices * 8);
    // an executor without runFar cannot serve it
    const bare = new GeometryServiceImpl({ executor: { size: 1, run: () => Promise.reject(new Error('no')), dispose() {} } });
    await expect(bare.buildFar({ place: 'p', far: 1, members })).rejects.toThrow(/cannot build far meshes/);
    svc.dispose();
    inProcess.dispose();
  });

  it('keeps the merge off the main thread: the service and the batcher import chunk-merge.ts and the worker as types only', () => {
    const src = (name: string): string => readFileSync(new URL(`../../../../src/render/geometry/${name}`, import.meta.url), 'utf8');
    for (const file of ['geometry-service.ts', 'map-batcher.ts', 'map-plan.ts']) {
      const imports = [...src(file).matchAll(/^import\s+(type\s+)?[^;]*?from\s+'\.\/(chunk-merge|geometry-worker|recorder)\.ts';/gm)];
      for (const m of imports) expect(m[1], `${file}: ${m[0]}`).toBe('type ');
    }
    // and the merge itself needs no engine
    expect(/from\s+'three/.test(src('chunk-merge.ts'))).toBe(false);
    expect(/from\s+'three/.test(src('map-plan.ts'))).toBe(false);
  });
});
