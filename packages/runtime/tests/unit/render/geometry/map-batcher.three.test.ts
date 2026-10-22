// map-batcher.ts (render §6.5, §18.1; WP R3): chunk and instanced meshes over packed buffers, explicit culling bounds, the
// batcher's own LOD selection, LOD-5 shadow proxies, the warm-up rule and promote-on-write. Node + three, no renderer: the
// geometry service runs the generators in-process and a recording stand-in takes the place of `renderer.compileAsync`.
import { BatchedMesh, Box3, Frustum, InstancedMesh, Matrix4, Mesh, PerspectiveCamera, Scene, Sphere, Vector3 } from 'three/webgpu';
import type { BufferAttribute, Camera, Object3D } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { keyOf, type GeometryContext, type ScriptedSpec } from '../../../../src/render/geometry/generator-types.ts';
import { GeometryServiceImpl } from '../../../../src/render/geometry/geometry-service.ts';
import { createInProcessExecutor, type ModuleLoader } from '../../../../src/render/geometry/geometry-worker.ts';
import { boxSphereRadius, dequantMatrix, MapBatcher, supportsMultiDraw, type BatcherRow, type BatcherTier, type MapBatcherOptions } from '../../../../src/render/geometry/map-batcher.ts';
import { farIdOf, chunkIdOf, keyCullRadius } from '../../../../src/render/geometry/map-plan.ts';
import { PAINT_ID_BIAS } from '../../../../src/render/geometry/pack.ts';
import { TIER_TABLE } from '../../../../src/render/perf/budget.ts';
import { LAYER_SHADOW_PROXY, LAYER_WORLD } from '../../../../src/render/scene/scene-root.ts';
import { MapPaint, PACKED_ATTRIBUTE, PACKED_NORMAL_ATTRIBUTE, paintBaseOf, registerPackedSurface } from '../../../../src/render/surface/paint-table.ts';
import type { LightingScript } from '../../../../src/render/surface/script-types.ts';
import { SurfaceMaterials, SurfaceVariant } from '../../../../src/render/surface/surface-material.ts';

const MODULES: Record<string, unknown> = {
  // a 2 m box shell with a glass top at LOD 1; fewer faces at coarser levels
  'scripts/gen/hut.js': {
    geometry(ctx: GeometryContext) {
      ctx.color('oklch(0.5 0.1 30)');
      ctx.quad(-1, 0, -1, -1, 2, -1, 1, 2, -1, 1, 0, -1);
      ctx.quad(-1, 0, 1, 1, 0, 1, 1, 2, 1, -1, 2, 1);
      if (ctx.lod <= 3) ctx.quad(1, 0, -1, 1, 2, -1, 1, 2, 1, 1, 0, 1);
      if (ctx.lod === 1) {
        ctx.color('oklch(0.2 0.03 230)', 0.4);
        ctx.quad(-1, 2, -1, -1, 2, 1, 1, 2, 1, 1, 2, -1);
      }
    },
  },
  'scripts/gen/post.js': {
    geometry(ctx: GeometryContext) {
      ctx.color('oklch(0.7 0.05 90)');
      ctx.quad(-0.1, 0, 0, -0.1, 3, 0, 0.1, 3, 0, 0.1, 0, 0);
    },
  },
  // a smooth cap on a flat base
  'scripts/gen/dome.js': {
    geometry(ctx: GeometryContext) {
      ctx.color('oklch(0.6 0.1 150)');
      ctx.quad(-1, 0, -1, -1, 0, 1, 1, 0, 1, 1, 0, -1);
      ctx.smooth();
      ctx.tri(-1, 0, -1, 0, 1, 0, 1, 0, -1);
      ctx.tri(1, 0, -1, 0, 1, 0, 1, 0, 1);
    },
  },
  'scripts/gen/empty.js': { geometry() {} },
  // a 40 m run of fence along x
  'scripts/gen/fence.js': {
    geometry(ctx: GeometryContext) {
      ctx.color('oklch(0.4 0.02 60)');
      ctx.quad(0, 0, 0, 0, 1, 0, 40, 1, 0, 40, 0, 0);
    },
  },
  // a lamp: an opaque pole and a glass shade (alpha 0.5) at every level, a second pole face at LOD 1
  'scripts/gen/lamp.js': {
    geometry(ctx: GeometryContext) {
      ctx.color('oklch(0.3 0.02 250)');
      ctx.quad(-0.1, 0, 0, -0.1, 3, 0, 0.1, 3, 0, 0.1, 0, 0);
      if (ctx.lod === 1) ctx.quad(0, 0, -0.1, 0, 3, -0.1, 0, 3, 0.1, 0, 0, 0.1);
      ctx.color('oklch(0.9 0.1 90)', 0.5);
      ctx.quad(-0.3, 3, 0, -0.3, 3.5, 0, 0.3, 3.5, 0, 0.3, 3, 0);
    },
  },
};
// the same piece under a second key (a single use: merged)
MODULES['scripts/gen/dome2.js'] = MODULES['scripts/gen/dome.js'];
const load: ModuleLoader = async (script) => {
  const m = MODULES[script];
  if (!m) throw new Error(`unknown generator script ${script}`);
  return m;
};
const spec = (name: string): ScriptedSpec => ({ kind: 'scripted', script: `scripts/gen/${name}.js`, params: {} });
const at = (x: number, y: number, z: number): Float32Array => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1]);
const row = (id: string, name: string, x: number, z: number, extra: Partial<BatcherRow> = {}): BatcherRow => ({ id, key: keyOf(spec(name)), spec: spec(name), m: at(x, 0, z), dynamic: false, ...extra });

const script: LightingScript = { lighting: (_s, l) => l.ambient };

interface World {
  batcher: MapBatcher;
  paint: MapPaint;
  materials: SurfaceMaterials;
  logs: string[];
  requests: string[];
  chunkJobs: number;
}

async function build(rows: BatcherRow[], tier: BatcherTier = TIER_TABLE.high, extra: Partial<MapBatcherOptions> & { farMeshes?: boolean } = {}): Promise<World> {
  const { farMeshes, ...options } = extra;
  const svc = new GeometryServiceImpl({ executor: createInProcessExecutor(load, { strict: true }) });
  const paint = new MapPaint({ paints: 256, entries: 4096 });
  const materials = new SurfaceMaterials({ script });
  registerPackedSurface(materials, paint);
  const logs: string[] = [];
  const requests: string[] = [];
  let chunkJobs = 0;
  const batcher = await MapBatcher.build(rows, {
    place: 'test',
    geometry: {
      request: (s, lods) => {
        requests.push(s.script);
        return svc.request(s, lods);
      },
      buildChunks: (job) => {
        chunkJobs++;
        return svc.buildChunks(job);
      },
      // the far meshes are a service of their own: most tests here look at the parts alone
      ...(farMeshes === true ? { buildFar: (job) => svc.buildFar(job) } : {}),
    },
    materials,
    paint,
    tier,
    log: (m) => logs.push(m),
    ...options,
  });
  return { batcher, paint, materials, logs, requests, chunkJobs };
}

/** two huts in one chunk, one in another, five posts (instanced), a dynamic hut */
const fixture = (): BatcherRow[] => [
  row('hut-a', 'hut', 4, 4),
  row('hut-b', 'hut', 12, 6, { castShadow: false }),
  row('hut-far', 'hut', 200, 4),
  ...[0, 1, 2, 3, 4].map((i) => row(`post-${i}`, 'post', i * 2, -40)),
  row('gate', 'hut', 0, 20, { dynamic: true }),
];

const meshesOf = (root: Object3D): Array<Mesh | InstancedMesh> => {
  const out: Array<Mesh | InstancedMesh> = [];
  root.traverse((o) => {
    if ((o as Mesh).isMesh === true) out.push(o as Mesh);
  });
  return out;
};

describe('MapBatcher.build', () => {
  it('builds chunks in the service, instanced keys per LOD and pass, and single rows', async () => {
    const w = await build(fixture());
    const s = w.batcher.stats();
    expect(s.chunks).toBe(2);
    expect(w.chunkJobs).toBe(2);
    expect(s.instancedKeys).toBe(1);
    expect(s.instancedRows).toBe(5);
    expect(s.singles).toBe(1);
    // chunk (hut-a, hut-b): LOD 1 opaque + transparent, LOD 3 and LOD 5 opaque only; chunk (hut-far) the same
    expect(s.chunkMeshes).toBe(2 * 4);
    // posts have no transparent pass: one instanced mesh per level
    expect(s.instancedMeshes).toBe(3);
    // only the keys of instanced and single rows were requested on the main thread; merged keys never were
    expect(w.requests.sort()).toEqual(['scripts/gen/hut.js', 'scripts/gen/post.js']);
    expect(w.batcher.classOf('hut-a')).toBe('chunk');
    expect(w.batcher.classOf('post-3')).toBe('instanced');
    expect(w.batcher.classOf('gate')).toBe('single');
    expect(s.skippedKeys).toEqual([]);
  });

  it('gives packed geometry quantised-space bounds, assigned once, and a matrix that dequantises', async () => {
    const w = await build(fixture());
    for (const chunk of w.batcher.chunks) {
      for (const level of chunk.levels) {
        for (const mesh of [level.opaque, level.transparent]) {
          if (!mesh) continue;
          const g = mesh.geometry;
          expect(g.boundingSphere!.center.toArray()).toEqual([0, 0, 0]);
          // DR-35 lever 1: a chunk mesh is drawn by its one matrix, so its sphere is the bbox's own: three scales the local
          // radius by the largest half extent and gets the half diagonal
          const half = [0, 1, 2].map((a) => (level.packed.bboxMax[a]! - level.packed.bboxMin[a]!) / 2);
          expect(g.boundingSphere!.radius).toBeCloseTo(Math.hypot(...half) / Math.max(...half), 12);
          expect(g.boundingSphere!.radius).toBeLessThanOrEqual(Math.sqrt(3));
          const world = g.boundingSphere!.clone().applyMatrix4(mesh.matrix);
          expect(world.radius).toBeCloseTo(Math.hypot(...half), 5);
          for (let a = 0; a < 3; a++) expect(world.center.getComponent(a)).toBeCloseTo((level.packed.bboxMin[a]! + level.packed.bboxMax[a]!) / 2, 5);
          expect(g.boundingBox!.min.toArray()).toEqual([-1, -1, -1]);
          expect(g.boundingBox!.max.toArray()).toEqual([1, 1, 1]);
          // D5: one Int16Array, itemSize 4, normalised; the paint stage's vec4 alias is the same attribute (no second buffer)
          const position = g.getAttribute('position') as BufferAttribute;
          expect(position.array).toBeInstanceOf(Int16Array);
          expect([position.itemSize, position.normalized]).toEqual([4, true]);
          expect(g.getAttribute(PACKED_ATTRIBUTE)).toBe(position);
          // the cube's corners land on the worker's world bbox
          const lo = new Vector3(-1, -1, -1).applyMatrix4(mesh.matrix);
          const hi = new Vector3(1, 1, 1).applyMatrix4(mesh.matrix);
          for (let a = 0; a < 3; a++) {
            expect(lo.getComponent(a)).toBeCloseTo(level.packed.bboxMin[a]!, 5);
            expect(hi.getComponent(a)).toBeCloseTo(level.packed.bboxMax[a]!, 5);
          }
          expect(mesh.matrixAutoUpdate).toBe(false);
          expect(mesh.matrixWorldAutoUpdate).toBe(false);
          expect(mesh.matrixWorld.equals(mesh.matrix)).toBe(true);
        }
      }
    }
    const near = w.batcher.chunks.find((c) => c.rows.length === 2)!;
    expect(near.min[0]).toBeCloseTo(3, 4);
    expect(near.max[0]).toBeCloseTo(13, 4);
    expect(dequantMatrix([0, 0, 0], [2, 4, 6]).elements).toEqual([1, 0, 0, 0, 0, 2, 0, 0, 0, 0, 3, 0, 1, 2, 3, 1]);
  });

  it('shares one vertex and one index buffer between the opaque, transparent and shadow geometries of a level', async () => {
    const w = await build(fixture());
    const near = w.batcher.chunks.find((c) => c.rows.length === 2)!;
    const lod1 = near.levels.find((l) => l.lod === 1)!;
    expect(lod1.opaque!.geometry.getAttribute('position')).toBe(lod1.transparent!.geometry.getAttribute('position'));
    expect(lod1.opaque!.geometry.index).toBe(lod1.transparent!.geometry.index);
    // LOD 1: 3 opaque quads + a glass quad per hut
    expect(lod1.opaque!.geometry.drawRange).toEqual({ start: 0, count: 36 });
    expect(lod1.transparent!.geometry.drawRange).toEqual({ start: 36, count: 12 });
    // the transparent pass: blended, both sides in one pass, no depth write
    const glass = lod1.transparent!.material as { transparent: boolean; forceSinglePass: boolean; depthWrite: boolean };
    expect([glass.transparent, glass.forceSinglePass, glass.depthWrite]).toEqual([true, true, false]);
    expect(lod1.opaque!.material).not.toBe(lod1.transparent!.material);
    // one paint block for the chunk: every level and pass has the same base
    const bases = new Set(meshesOf(near.group).map((m) => paintBaseOf(m)));
    expect(bases.size).toBe(1);
    expect(w.paint.records.count).toBe(3); // hut body, glass, post
  });

  it('puts LOD-5 shadow proxies on layer 2 with only the casting rows, and keeps visible meshes out of the shadow pass', async () => {
    const w = await build(fixture());
    const proxies = w.batcher.shadowProxies();
    // one per chunk, one for the instanced key, one for the single row that casts
    expect(proxies).toHaveLength(4);
    for (const p of proxies) {
      expect(p.castShadow).toBe(true);
      expect(p.layers.mask).toBe(1 << LAYER_SHADOW_PROXY);
      expect(p.layers.isEnabled(LAYER_WORLD)).toBe(false);
    }
    const near = w.batcher.chunks.find((c) => c.rows.length === 2)!;
    const lod5 = near.levels.find((l) => l.lod === 5)!;
    // LOD 5 hut: 2 quads = 12 indices; hut-b casts no shadow, so the proxy draws hut-a only
    expect(near.proxy!.geometry.drawRange).toEqual({ start: 0, count: 12 });
    expect(lod5.opaque!.geometry.drawRange).toEqual({ start: 0, count: 24 });
    expect(near.proxy!.geometry.index).toBe(lod5.opaque!.geometry.index);
    const instancedProxy = proxies.find((p) => (p as InstancedMesh).isInstancedMesh === true) as InstancedMesh;
    expect(instancedProxy.count).toBe(5);
    // no mesh the world camera draws is a caster: only the proxies are
    for (const m of meshesOf(w.batcher.root)) if (!proxies.includes(m)) expect(m.castShadow, m.name).toBe(false);
    // a tier without a shadowCaster shadow builds none
    const low = await build(fixture(), TIER_TABLE.low);
    expect(low.batcher.shadowProxies()).toEqual([]);
    expect(low.batcher.singles[0]!.proxy).toBeNull();
  });

  it('gives a single row its own LOD-5 proxy that casts at every level the world camera shows, and moves with the row', async () => {
    const w = await build([...fixture(), row('gate-dark', 'hut', 30, 20, { dynamic: true, castShadow: false })]);
    const b = w.batcher;
    const gate = b.singles.find((s) => s.row.id === 'gate')!;
    const proxy = gate.proxy!;
    const lod5 = gate.levels.find((l) => l.lod === 5)!;
    expect(proxy.name).toBe('row:gate:shadow');
    expect(proxy.geometry).toBe(lod5.opaque!.geometry);
    expect([proxy.castShadow, proxy.receiveShadow, proxy.layers.mask]).toEqual([true, false, 1 << LAYER_SHADOW_PROXY]);
    expect(proxy.matrix.equals(lod5.opaque!.matrix)).toBe(true);
    // the lamp is 25 m at most from the row: the world camera shows LOD 1 there and the row's LOD 5 mesh is hidden. What the
    // shadow camera (layers 0, 1 and 2) finds visible and casting below the row is the proxy, at both distances
    const shadowCamera = new PerspectiveCamera();
    shadowCamera.layers.enable(LAYER_SHADOW_PROXY);
    const casters = (): string[] => meshesOf(gate.group).filter((m) => m.visible && m.castShadow && m.layers.test(shadowCamera.layers)).map((m) => m.name);
    b.update({ x: 0, y: 1.7, z: 14 }, true);
    expect(gate.levels.map((l) => l.opaque!.visible)).toEqual([true, false, false]);
    expect(casters()).toEqual(['row:gate:shadow']);
    b.update({ x: 0, y: 1.7, z: 400 }, true);
    expect(gate.levels.map((l) => l.opaque!.visible)).toEqual([false, false, true]);
    expect(casters()).toEqual(['row:gate:shadow']);
    // a write moves the proxy with the row
    b.setRowMatrix('gate', at(5, 1, 22));
    expect(proxy.matrix.equals(lod5.opaque!.matrix)).toBe(true);
    expect(new Vector3(0, -1, 0).applyMatrix4(proxy.matrix).toArray().map((v) => Math.round(v * 1000) / 1000)).toEqual([5, 1, 22]);
    expect(proxy.matrixWorldNeedsUpdate).toBe(true);
    // hidden with the row
    b.setRowVisible('gate', false);
    expect(gate.group.visible).toBe(false);
    // a row with castShadow: false has none
    expect(b.singles.find((s) => s.row.id === 'gate-dark')!.proxy).toBeNull();
    // a promoted row leaves its chunk's proxy range and brings its own
    const promoted = await b.promote('hut-a');
    expect(promoted!.proxy).not.toBeNull();
    expect(b.shadowProxies()).toContain(promoted!.proxy);
    expect((await b.promote('hut-b'))!.proxy).toBeNull(); // hut-b casts no shadow
  });

  it('gives a level with smooth faces a normal attribute and the NORMALS variants; flat levels keep the flat ones', async () => {
    const w = await build([
      row('dome-merged', 'dome2', 4, 4),
      row('hut-merged', 'hut', 200, 4),
      ...[0, 1, 2, 3].map((i) => row(`dome-${i}`, 'dome', i * 4, -60)),
      row('dome-moving', 'dome', 0, 30, { dynamic: true }),
    ]);
    const variantOf = (m: unknown): number => (m as { variant: number }).variant;
    const withDome = w.batcher.chunks.find((c) => c.rows[0]!.id === 'dome-merged')!;
    const withHut = w.batcher.chunks.find((c) => c.rows[0]!.id === 'hut-merged')!;
    for (const level of withDome.levels) {
      const g = level.opaque!.geometry;
      const normal = g.getAttribute('normal') as BufferAttribute;
      expect(normal.array).toBeInstanceOf(Int8Array);
      expect([normal.itemSize, normal.normalized, normal.count]).toEqual([4, true, level.packed.vertices]);
      // the stage reads the smooth mark from the same buffer, as a vec4
      expect(g.getAttribute(PACKED_NORMAL_ATTRIBUTE)).toBe(normal);
      expect(variantOf(level.opaque!.material) & SurfaceVariant.NORMALS).toBe(SurfaceVariant.NORMALS);
      expect((level.opaque!.material as unknown as { flatShading: boolean }).flatShading).toBe(false);
      // some vertices are smooth, the base's are flat
      const w4 = Array.from({ length: normal.count }, (_, v) => normal.getW(v));
      expect(w4.some((x) => x === 1)).toBe(true);
      expect(w4.some((x) => x === 0)).toBe(true);
    }
    for (const level of withHut.levels) {
      expect(level.opaque!.geometry.getAttribute('normal')).toBeUndefined();
      expect(variantOf(level.opaque!.material) & SurfaceVariant.NORMALS).toBe(0);
      expect((level.opaque!.material as unknown as { flatShading: boolean }).flatShading).toBe(true);
    }
    // instanced and single meshes of the key take the same variant; the map has two opaque packed materials, not one per key
    const instanced = w.batcher.instanced[0]!.levels[0]!.opaque!;
    const single = w.batcher.singles[0]!.levels[0]!.opaque!;
    expect(instanced.material).toBe(withDome.levels[0]!.opaque!.material);
    expect(single.material).toBe(instanced.material);
    expect(instanced.geometry.getAttribute('normal')).toBe(single.geometry.getAttribute('normal'));
    expect(instanced.material).not.toBe(withHut.levels[0]!.opaque!.material);
  });

  it('merges every static row on a mergeAll tier and builds only its two levels', async () => {
    const w = await build(fixture(), TIER_TABLE.minimum);
    const s = w.batcher.stats();
    expect(s.instancedKeys).toBe(0);
    expect(s.chunks).toBe(3);
    expect(w.batcher.chunks.every((c) => c.levels.map((l) => l.lod).join() === '3,5')).toBe(true);
    expect(w.batcher.bands).toEqual({ lods: [3, 5], distances: [25] });
    expect(w.requests).toEqual(['scripts/gen/hut.js']); // the dynamic gate only
  });

  it('skips an empty key and logs it once', async () => {
    const w = await build([...fixture(), row('nothing-1', 'empty', 0, 0, { dynamic: true }), row('nothing-2', 'empty', 5, 0, { dynamic: true })]);
    expect(w.batcher.stats().skippedKeys).toEqual([keyOf(spec('empty'))]);
    expect(w.logs.filter((l) => l.includes('empty'))).toHaveLength(1);
    expect(w.batcher.classOf('nothing-1')).toBeNull();
  });
});

describe('LOD selection and the instance partition', () => {
  const visibleLods = (w: World, rows: number): number[] =>
    w.batcher.chunks
      .find((c) => c.rows.length === rows)!
      .levels.filter((l) => l.opaque!.visible)
      .map((l) => l.lod);

  it('shows one level per chunk by distance to the chunk box, with hysteresis', async () => {
    const w = await build(fixture());
    const b = w.batcher;
    b.update({ x: 8, y: 1.7, z: 5 }, true);
    expect(visibleLods(w, 2)).toEqual([1]);
    expect(visibleLods(w, 1)).toEqual([5]);
    const near = b.chunks.find((c) => c.rows.length === 2)!;
    expect(near.levels.find((l) => l.lod === 1)!.transparent!.visible).toBe(true);
    // 31 m from the near chunk's box: inside the hysteresis band, LOD 1 stays; 34 m: LOD 3
    b.update({ x: near.min[0] - 31, y: 1, z: 5 }, true);
    expect(visibleLods(w, 2)).toEqual([1]);
    b.update({ x: near.min[0] - 34, y: 1, z: 5 }, true);
    expect(visibleLods(w, 2)).toEqual([3]);
    expect(near.levels.find((l) => l.lod === 1)!.transparent!.visible).toBe(false);
    // back to 28 m: still LOD 3 (the band is 27 m); 26 m: LOD 1
    b.update({ x: near.min[0] - 28, y: 1, z: 5 }, true);
    expect(visibleLods(w, 2)).toEqual([3]);
    b.update({ x: near.min[0] - 26, y: 1, z: 5 }, true);
    expect(visibleLods(w, 2)).toEqual([1]);
  });

  it('selects by the plain thresholds on a camera cut: no hysteresis from the view before', async () => {
    const w = await build(fixture());
    const b = w.batcher;
    const near = b.chunks.find((c) => c.rows.length === 2)!;
    const posts = b.instanced[0]!;
    const level = (lod: number): number => posts.levels.find((l) => l.lod === lod)!.opaque!.count;
    // 300 m away, then 28 m from the near chunk (below: 28.5 to 28.8 m from the posts' spheres): inside the band of the 30 m switch
    b.update({ x: near.min[0] - 300, y: 1, z: 5 }, true);
    b.update({ x: near.min[0] - 28, y: 1, z: 5 }, true);
    expect(visibleLods(w, 2)).toEqual([3]);
    // the same place after a cut: LOD 1, as a view that starts there
    expect(b.update({ x: near.min[0] - 28, y: 1, z: 5 }, false, true)).toBe(true);
    expect(visibleLods(w, 2)).toEqual([1]);
    // instances and single rows too
    b.update({ x: 4, y: 1.7, z: 400 }, true);
    b.update({ x: 4, y: 1.7, z: -40 - 30 }, true);
    expect([level(1), level(3), level(5)]).toEqual([0, 5, 0]);
    b.update({ x: 4, y: 1.7, z: -40 - 30 }, true, true);
    expect([level(1), level(3), level(5)]).toEqual([5, 0, 0]);
    const gate = b.singles[0]!;
    b.update({ x: 0, y: 1, z: 20 + 400 }, true);
    b.update({ x: 0, y: 1, z: 20 + 29 }, true);
    expect(gate.levels[gate.current]!.lod).toBe(3);
    b.update({ x: 0, y: 1, z: 20 + 29 }, true, true);
    expect(gate.levels[gate.current]!.lod).toBe(1);
    // a promoted row stays out of the partition across a cut
    await b.promote('post-0');
    b.update({ x: 4, y: 1.7, z: -40 }, true, true);
    expect(level(1)).toBe(4);
  });

  it('re-selects when the camera moved more than 1 m, or on every 4th call', async () => {
    const w = await build(fixture());
    const b = w.batcher;
    expect(b.update({ x: 0, y: 0, z: 0 })).toBe(true); // first call
    expect(b.update({ x: 0.5, y: 0, z: 0 })).toBe(false);
    expect(b.update({ x: 0.9, y: 0, z: 0 })).toBe(false);
    expect(b.update({ x: 0.9, y: 0, z: 0 })).toBe(true); // 4th call
    expect(b.update({ x: 2.5, y: 0, z: 0 })).toBe(true); // moved
  });

  it('keeps far instances of a mesh that was empty: count, written range and an explicit bounding sphere', async () => {
    const w = await build(fixture());
    const b = w.batcher;
    const posts = b.instanced[0]!;
    const level = (lod: number): InstancedMesh => posts.levels.find((l) => l.lod === lod)!.opaque!;
    // camera among the posts: all five at LOD 1; the LOD 5 mesh is empty and hidden
    b.update({ x: 4, y: 1.7, z: -40 }, true);
    expect([level(1).count, level(3).count, level(5).count]).toEqual([5, 0, 0]);
    expect([level(1).visible, level(5).visible]).toEqual([true, false]);
    // three's own lazy sphere of the empty mesh would be empty and stay so: this is the hazard the batcher removes
    const naive = new InstancedMesh(level(5).geometry, level(5).material, 8);
    naive.count = 0;
    naive.computeBoundingSphere();
    expect(naive.boundingSphere!.radius).toBeLessThan(0);

    // camera 300 m away: every post moves to the LOD 5 mesh
    const eye = new Vector3(4, 1.7, 260);
    b.update(eye, true);
    expect([level(1).count, level(3).count, level(5).count]).toEqual([0, 0, 5]);
    expect([level(1).visible, level(5).visible]).toEqual([false, true]);
    const im = level(5).instanceMatrix;
    expect(im.updateRanges).toEqual([{ start: 0, count: 80 }]);
    // the sphere is the union of the five instances (posts at x 0..8, z −40, 3 m tall)
    const sphere = level(5).boundingSphere!;
    expect(sphere.center.x).toBeCloseTo(4, 3);
    expect(sphere.center.z).toBeCloseTo(-40, 3);
    expect(sphere.radius).toBeGreaterThan(4);
    expect(sphere.radius).toBeLessThan(6);
    // three's frustum test (the renderer's own) keeps the mesh when the camera looks at the posts...
    const camera = new PerspectiveCamera(58.72, 16 / 9, 0.1, 2000);
    camera.position.copy(eye);
    camera.lookAt(4, 1.7, -40);
    camera.updateMatrixWorld(true);
    const frustum = new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    expect(frustum.intersectsObject(level(5))).toBe(true);
    // ...and culls it when the camera looks away
    camera.lookAt(4, 1.7, 600);
    camera.updateMatrixWorld(true);
    frustum.setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    expect(frustum.intersectsObject(level(5))).toBe(false);
    // the matrices written are the instances' own: row matrix · dequantisation
    const m = new Matrix4().fromArray(im.array, 16 * 2);
    const origin = new Vector3(0, -1, 0).applyMatrix4(m); // the quantised cube's bottom centre
    expect(origin.x).toBeCloseTo(4, 3);
    expect(origin.y).toBeCloseTo(0, 3);
    expect(origin.z).toBeCloseTo(-40, 3);
    // mixed bands: camera 45 m from the first post along x
    b.update({ x: -45, y: 1.7, z: -40 }, true);
    expect(level(1).count + level(3).count + level(5).count).toBe(5);
    expect(level(3).count).toBe(5);
  });

  it('counts what the world camera would draw', async () => {
    const w = await build(fixture());
    w.batcher.update({ x: 8, y: 1.7, z: 5 }, true);
    // near chunk LOD 1 (2 draws), far chunk LOD 5 (1), posts LOD 3 (1; 45 m away), gate LOD 1 (2)
    const c = w.batcher.visibleCounts();
    expect(c.draws).toBe(6);
    expect(c.triangles).toBe(16 + 4 + 5 * 2 + 8);
  });
});

describe('the warm-up rule and uploads (render §6.5)', () => {
  /** what `_projectObject` would hand on from `root` for `camera`: visible, on the camera's layers, and not culled */
  function projected(root: Object3D, camera: Camera): Object3D[] {
    const frustum = new Frustum().setFromProjectionMatrix(new Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const out: Object3D[] = [];
    const visit = (o: Object3D): void => {
      if (o.visible === false) return;
      const mesh = o as Mesh;
      if (mesh.isMesh === true && o.layers.test(camera.layers) && (o.frustumCulled === false || frustum.intersectsObject(mesh))) out.push(o);
      for (const c of o.children) visit(c);
    };
    visit(root);
    return out;
  }

  const lookingAway = (): PerspectiveCamera => {
    const camera = new PerspectiveCamera(58.72, 16 / 9, 0.1, 2000);
    camera.position.set(8, 1.7, 5);
    camera.lookAt(8, 1.7, 500); // the far chunk and the posts are behind it
    camera.updateMatrixWorld(true);
    return camera;
  };

  it('makes the projection reach every LOD level and proxy of a batch, then puts every flag back', async () => {
    const w = await build(fixture());
    const b = w.batcher;
    const camera = lookingAway();
    b.update(camera.position, true);
    const all = meshesOf(b.root);
    // without the rule the projection reaches only what is visible, on layer 0 and in the frustum
    const plain = projected(b.root, camera);
    expect(plain.length).toBeGreaterThan(0);
    expect(plain.length).toBeLessThan(all.length / 2);
    const before = all.map((m) => [m.visible, m.frustumCulled, (m as InstancedMesh).count ?? -1]);
    const mask = camera.layers.mask;

    const seen: Object3D[][] = [];
    const scene = new Scene();
    const stats = await b.upload({ compileAsync: async (group, cam) => void seen.push(projected(group, cam)) }, camera, scene, { yieldFrame: async () => {} });
    // one batch per chunk, per instanced key and per single row; together they reached every mesh, proxies included
    expect(stats.batches).toBe(2 + 1 + 1);
    expect(seen).toHaveLength(4);
    const reached = new Set(seen.flat());
    expect(reached.size).toBe(all.length);
    for (const m of all) expect(reached.has(m), m.name).toBe(true);
    for (const p of b.shadowProxies()) expect(reached.has(p), p.name).toBe(true);
    // restored
    expect(all.map((m) => [m.visible, m.frustumCulled, (m as InstancedMesh).count ?? -1])).toEqual(before);
    expect(camera.layers.mask).toBe(mask);
  });

  it('restores the flags when a compile fails, and gives an empty instanced mesh one instance while it compiles', async () => {
    const w = await build(fixture());
    const b = w.batcher;
    const camera = lookingAway();
    b.update(camera.position, true);
    const posts = b.instanced[0]!;
    const empty = posts.levels.find((l) => l.lod === 1)!.opaque!;
    expect(empty.count).toBe(0);
    let countDuring = -1;
    await expect(
      MapBatcher.warm([posts.group], camera, async () => {
        countDuring = empty.count;
        expect(empty.visible).toBe(true);
        expect(empty.frustumCulled).toBe(false);
        expect(camera.layers.isEnabled(LAYER_SHADOW_PROXY)).toBe(true);
        throw new Error('compile failed');
      }),
    ).rejects.toThrow('compile failed');
    expect(countDuring).toBe(1);
    expect([empty.count, empty.visible, empty.frustumCulled]).toEqual([0, false, true]);
    expect(camera.layers.isEnabled(LAYER_SHADOW_PROXY)).toBe(false);
  });

  it('yields to the next frame whenever the upload slice is used up', async () => {
    const w = await build(fixture());
    let clock = 0;
    let yields = 0;
    const stats = await w.batcher.upload(
      {
        compileAsync: async () => {
          clock += 1.5; // each batch costs 1.5 ms
        },
      },
      lookingAway(),
      new Scene(),
      { sliceMs: 2, now: () => clock, yieldFrame: async () => void yields++ },
    );
    // 4 batches of 1.5 ms under a 2 ms slice: a yield after every second batch
    expect(stats.batches).toBe(4);
    expect(yields).toBe(2);
    expect(stats.slices).toBe(2);
    expect(stats.maxBatchMs).toBe(1.5);
    expect(stats.ms).toBe(6);
  });
});

describe('promote on write (render §6.5)', () => {
  it('takes a merged row out of every level of its chunk and makes it a single row', async () => {
    const w = await build(fixture());
    const b = w.batcher;
    b.update({ x: 8, y: 1.7, z: 5 }, true);
    const near = b.chunks.find((c) => c.rows.length === 2)!;
    const lod1 = near.levels.find((l) => l.lod === 1)!;
    const idxBefore = Array.from(lod1.packed.idx);
    const version = lod1.attrs.index.version;
    const single = await b.promote('hut-b');
    expect(single).not.toBeNull();
    expect(b.classOf('hut-b')).toBe('single');
    // hut-b casts no shadow: its opaque range comes after hut-a's; LOD 1 ranges: opaque [18, 36), transparent [42, 48)
    const idx = Array.from(lod1.packed.idx);
    for (let i = 0; i < idx.length; i++) {
      const removed = (i >= 18 && i < 36) || (i >= 42 && i < 48);
      expect(idx[i], `index ${i}`).toBe(removed ? 0 : idxBefore[i]);
    }
    expect(lod1.attrs.index.updateRanges).toEqual([{ start: 18, count: 18 }, { start: 42, count: 6 }]);
    expect(lod1.attrs.index.version).toBe(version + 1);
    // the other levels lost the row too
    for (const l of near.levels) expect(l.packed.rowRanges[4 + 1]! + l.packed.rowRanges[4 + 3]!).toBe(0);
    // the single row draws at its place at the level the camera asks for, and moves on a write
    expect(single!.levels[single!.current]!.opaque!.visible).toBe(true);
    const mesh = single!.levels[0]!.opaque!;
    expect(new Vector3(0, -1, 0).applyMatrix4(mesh.matrix).toArray().map((v) => Math.round(v * 1000) / 1000)).toEqual([12, 0, 6]);
    b.setRowMatrix('hut-b', at(30, 2, 6));
    expect(new Vector3(0, -1, 0).applyMatrix4(mesh.matrix).toArray().map((v) => Math.round(v * 1000) / 1000)).toEqual([30, 2, 6]);
    b.setRowVisible('hut-b', false);
    expect(single!.group.visible).toBe(false);
    // promoting again is a no-op that returns the same row
    expect(await b.promote('hut-b')).toBe(single);
    expect(() => b.setRowMatrix('hut-a', at(0, 0, 0))).toThrow(/not a single row/);
  });

  it('adds, removes and regenerates rows at run time as single rows', async () => {
    const w = await build(fixture());
    const b = w.batcher;
    b.update({ x: 8, y: 1.7, z: 5 }, true);
    const paintsBefore = w.paint.index.count;
    // a spawned row of a key the place already holds: no new request, no new paint block
    const shard = await b.addRow(row('shard-1', 'hut', 3, 30, { dynamic: true }));
    expect(shard).not.toBeNull();
    expect(b.classOf('shard-1')).toBe('single');
    expect(b.singles).toHaveLength(2);
    expect(w.requests.filter((s) => s === 'scripts/gen/hut.js')).toHaveLength(1);
    expect(w.paint.index.count).toBe(paintsBefore);
    expect(shard!.levels[shard!.current]!.opaque!.visible).toBe(true);
    await expect(b.addRow(row('shard-1', 'hut', 0, 0, { dynamic: true }))).rejects.toThrow(/exists/);
    b.removeRow('shard-1');
    expect(b.classOf('shard-1')).toBeNull();
    expect(b.singles).toHaveLength(1);
    expect(shard!.group.parent).toBeNull();
    // a params write: the row keeps drawing its old key until the new key has arrived, then switches at its matrix
    const gate = b.singles[0]!;
    const pending = b.regenerate('gate', keyOf(spec('post')), spec('post'));
    expect(b.classOf('gate')).toBe('single');
    expect(gate.group.parent).toBe(b.root);
    const next = await pending;
    expect(gate.group.parent).toBeNull();
    expect(next!.row.key).toBe(keyOf(spec('post')));
    expect(new Vector3(0, -1, 0).applyMatrix4(next!.levels[0]!.opaque!.matrix).toArray().map((v) => Math.round(v * 1000) / 1000)).toEqual([0, 0, 20]);
    // a batched row can be regenerated too: it leaves its chunk when the new key is there
    await b.regenerate('hut-a', keyOf(spec('post')), spec('post'));
    expect(b.classOf('hut-a')).toBe('single');
    const near = b.chunks.find((c) => c.rows.some((r) => r.id === 'hut-a'))!;
    expect(near.levels[0]!.packed.rowRanges[1]! + near.levels[0]!.packed.rowRanges[3]!).toBe(0);
    // an empty new key leaves the row drawing nothing
    expect(await b.regenerate('hut-far', keyOf(spec('empty')), spec('empty'))).toBeNull();
    expect(b.classOf('hut-far')).toBeNull();
  });

  it('takes an instanced row out of its partition and its shadow proxy', async () => {
    const w = await build(fixture());
    const b = w.batcher;
    b.update({ x: 4, y: 1.7, z: -40 }, true);
    const posts = b.instanced[0]!;
    expect(posts.levels[0]!.opaque!.count).toBe(5);
    const single = await b.promote('post-2');
    expect(posts.levels[0]!.opaque!.count).toBe(4);
    expect(posts.proxy!.count).toBe(4);
    expect(b.classOf('post-2')).toBe('single');
    expect(single!.levels.map((l) => l.lod)).toEqual([1, 3, 5]);
    // the remaining instances are posts 0, 1, 3, 4
    const xs = [0, 1, 2, 3].map((i) => new Vector3(0, -1, 0).applyMatrix4(new Matrix4().fromArray(posts.levels[0]!.opaque!.instanceMatrix.array, i * 16)).x);
    expect(xs.map((x) => Math.round(x))).toEqual([0, 2, 6, 8]);
    // later partitions leave the promoted row out
    b.update({ x: 4, y: 1.7, z: 400 }, true);
    expect(posts.levels.map((l) => l.opaque!.count)).toEqual([0, 0, 4]);
  });
});

describe('chunk parts (DR-35 lever 2)', () => {
  it('builds one entry per part of a cell: the long fence apart from the huts, one job and one paint block for the cell', async () => {
    const rows = [row('hut-a', 'hut', 4, 4), row('hut-b', 'hut', 12, 6), row('fence', 'fence', 1, 20, { castShadow: false })];
    const w = await build(rows);
    const s = w.batcher.stats();
    expect([s.cells, s.chunks, w.chunkJobs]).toEqual([1, 2, 1]);
    const [huts, fence] = w.batcher.chunks;
    expect([huts!.part, fence!.part]).toEqual(['', 'L']);
    expect(huts!.rows.map((r) => r.id)).toEqual(['hut-a', 'hut-b']);
    expect(fence!.rows.map((r) => r.id)).toEqual(['fence']);
    expect(huts!.chunk).toBe(fence!.chunk);
    // the huts' box is theirs alone: 10 m wide, not the fence's 40 m
    expect(huts!.max[0] - huts!.min[0]).toBeCloseTo(10, 4);
    expect(fence!.max[0] - fence!.min[0]).toBeCloseTo(40, 3);
    // both parts read the cell's one paint block
    expect(new Set(meshesOf(w.batcher.root).map((m) => paintBaseOf(m))).size).toBe(1);
    // a proxy per part that has a casting row: the fence casts none
    expect(huts!.proxy).not.toBeNull();
    expect(fence!.proxy).toBeNull();
    // LOD is per part: 40 m from the huts' box but beside the fence
    w.batcher.update({ x: 52, y: 1.7, z: 20.5 }, true);
    expect([huts!.levels[huts!.current]!.lod, fence!.levels[fence!.current]!.lod]).toEqual([3, 1]);
    // promote-on-write finds a row in its part
    expect(w.batcher.classOf('fence')).toBe('chunk');
    await w.batcher.promote('fence');
    expect(fence!.levels.every((l) => l.packed.rowRanges[1] === 0)).toBe(true);
    expect(huts!.levels[0]!.packed.rowRanges[1]).toBeGreaterThan(0);
  });

  it('keeps one part per cell when the tier names no triangle budget', async () => {
    const { triangleBudget: _budget, ...tier } = TIER_TABLE.high;
    const w = await build([row('hut-a', 'hut', 4, 4), row('fence', 'fence', 1, 20)], tier);
    expect(w.batcher.chunks.map((c) => [c.part, c.rows.length])).toEqual([['', 2]]);
  });
});

describe('far meshes (DR-35 lever 4)', () => {
  // three cells of one far group (x 0..128, z 0..128) and one cell of another
  const far = (): BatcherRow[] => [
    row('a1', 'hut', 4, 4),
    row('a2', 'hut', 12, 6, { castShadow: false }),
    row('b1', 'hut', 40, 4),
    row('c1', 'lamp', 70, 70),
    row('d1', 'hut', 200, 4),
    row('gate', 'hut', 0, 20, { dynamic: true }),
  ];

  it('asks the service for one far mesh per far group with two or more parts, over their coarsest level', async () => {
    const w = await build(far(), TIER_TABLE.low, { farMeshes: true });
    const b = w.batcher;
    const s = b.stats();
    expect([s.chunks, s.farGroups]).toEqual([4, 1]);
    const f = b.fars[0]!;
    expect(f.far).toBe(farIdOf(chunkIdOf(4, 4)));
    expect(f.lod).toBe(5);
    expect(f.members.map((c) => c.rows.map((r) => r.id).join('+'))).toEqual(['a1+a2', 'b1', 'c1']);
    // the lone cell of the other group has no far mesh
    const lone = b.chunks.find((c) => c.rows[0]!.id === 'd1')!;
    expect(lone.far).toBeNull();
    expect(f.members.every((c) => c.far === f)).toBe(true);
    expect(f.members.map((c) => c.farRow0)).toEqual([0, 2, 3]);
    // the far mesh holds exactly the members' LOD 5 triangles: opaque and (the lamp shade) transparent, one mesh each
    const lod5 = f.members.map((c) => c.levels[c.levels.length - 1]!.packed);
    expect(f.packed.tris).toBe(lod5.reduce((n, p) => n + p.tris, 0));
    expect(f.opaque!.geometry.drawRange).toEqual({ start: 0, count: lod5.reduce((n, p) => n + p.opaqueIndexCount, 0) });
    expect(f.transparent!.geometry.drawRange).toEqual({ start: f.packed.opaqueIndexCount, count: 6 });
    expect(s.farMeshes).toBe(2);
    // its matrix dequantises to the union of the members' boxes, and its sphere is that box's
    const lo = new Vector3(-1, -1, -1).applyMatrix4(f.opaque!.matrix);
    const hi = new Vector3(1, 1, 1).applyMatrix4(f.opaque!.matrix);
    for (let a = 0; a < 3; a++) {
      expect(lo.getComponent(a)).toBeCloseTo(Math.min(...lod5.map((p) => p.bboxMin[a]!)), 4);
      expect(hi.getComponent(a)).toBeCloseTo(Math.max(...lod5.map((p) => p.bboxMax[a]!)), 4);
    }
    expect(f.opaque!.geometry.boundingSphere!.radius).toBeCloseTo(boxSphereRadius(f.packed.bboxMin, f.packed.bboxMax), 12);
    // a block of its own with the paints its vertices use: hut body, lamp pole, lamp shade
    expect(f.packed.paints.length / 12).toBe(3);
    expect(paintBaseOf(f.opaque!)).not.toBe(paintBaseOf(f.members[0]!.levels[0]!.opaque!));
    expect(f.opaque!.castShadow).toBe(false);
    expect([f.opaque!.matrixAutoUpdate, f.opaque!.matrixWorldAutoUpdate]).toEqual([false, false]);
    // one upload batch more
    expect(b.batches()).toContain(f.group);
  });

  it('keeps the coarsest level once: the parts of a far group draw it as ranges of the far mesh buffers', async () => {
    // on a hybrid tier: three static huts stay merged (four would be instanced), the lone cell holds another key
    const rows = far().map((r) => (r.id === 'd1' ? row('d1', 'dome2', 200, 4) : r));
    const w = await build(rows, TIER_TABLE.high, { farMeshes: true });
    const b = w.batcher;
    expect(b.stats()).toMatchObject({ chunks: 4, farGroups: 1, instancedKeys: 0 });
    const f = b.fars[0]!;
    let opaqueAt = 0;
    let transparentAt = f.packed.opaqueIndexCount;
    for (const c of f.members) {
      const level = c.levels[c.levels.length - 1]!;
      expect([level.lod, level.shared]).toEqual([5, true]);
      // the finer levels keep buffers of their own
      expect(c.levels.slice(0, -1).every((l) => !l.shared && l.packed.vtx.byteLength > 0)).toBe(true);
      // the same attributes as the far mesh, the member's own slice of the index, the far mesh's matrix and paint block
      const opaque = level.opaque!;
      expect(opaque.geometry.getAttribute('position')).toBe(f.attrs.position);
      expect(opaque.geometry.getAttribute(PACKED_ATTRIBUTE)).toBe(f.attrs.position);
      expect(opaque.geometry.index).toBe(f.attrs.index);
      expect(opaque.geometry.drawRange).toEqual({ start: opaqueAt, count: level.packed.opaqueIndexCount });
      expect(opaque.matrix.equals(f.opaque!.matrix)).toBe(true);
      expect(paintBaseOf(opaque)).toBe(paintBaseOf(f.opaque!));
      expect(opaque.material).toBe(f.opaque!.material);
      if (level.transparent) {
        expect(level.transparent.geometry.drawRange).toEqual({ start: transparentAt, count: 6 });
        expect(level.transparent.material).toBe(f.transparent!.material);
        transparentAt += 6;
      }
      // its shadow proxy is the casting part of that slice (a2 casts none: one hut's two quads in the first part)
      if (c.proxy) {
        expect(c.proxy.geometry.index).toBe(f.attrs.index);
        expect(c.proxy.geometry.drawRange).toEqual({ start: opaqueAt, count: level.packed.shadowIndexCount });
        expect(c.proxy.layers.mask).toBe(1 << LAYER_SHADOW_PROXY);
      }
      opaqueAt += level.packed.opaqueIndexCount;
      // culled by the member's own box, not by the far mesh's: three's world sphere is the box's circumscribed one
      const world = opaque.geometry.boundingSphere!.clone().applyMatrix4(opaque.matrix);
      const half = [0, 1, 2].map((a) => (level.packed.bboxMax[a]! - level.packed.bboxMin[a]!) / 2);
      expect(world.radius).toBeCloseTo(Math.hypot(...half), 4);
      for (let a = 0; a < 3; a++) expect(world.center.getComponent(a)).toBeCloseTo((level.packed.bboxMin[a]! + level.packed.bboxMax[a]!) / 2, 4);
      const lo = opaque.geometry.boundingBox!.min.clone().applyMatrix4(opaque.matrix);
      for (let a = 0; a < 3; a++) expect(lo.getComponent(a)).toBeCloseTo(level.packed.bboxMin[a]!, 4);
      // the member's own copy of the level is gone
      expect(level.packed.vtx.byteLength + level.packed.idx.byteLength).toBe(0);
      expect(level.packed.normals).toBeUndefined();
    }
    expect(opaqueAt).toBe(f.packed.opaqueIndexCount);
    expect(f.members[0]!.proxy!.geometry.drawRange.count).toBe(12);
    // counted once: the far mesh's triangles stand for the members' LOD 5
    const plain = await build(rows, TIER_TABLE.high);
    expect(b.stats().triangles).toBe(plain.batcher.stats().triangles);
    expect(b.stats().bytes).toBeLessThanOrEqual(plain.batcher.stats().bytes);
    // a part drawn on its own at LOD 5 while a neighbour is finer: the range view draws, with the member's triangles
    b.update({ x: 8, y: 1.7, z: 5 }, true);
    const lamp = f.members[2]!;
    expect(f.shown).toBe(false);
    expect(lamp.levels[lamp.shown]!.lod).toBe(5);
    expect(lamp.levels[lamp.shown]!.opaque!.visible).toBe(true);
    // a promoted row leaves the shared level through the far mesh's ranges
    await b.promote('b1');
    expect(f.packed.rowRanges[2 * 4 + 1]).toBe(0);
    const b1 = f.members[1]!;
    expect(b1.levels.slice(0, -1).every((l) => l.packed.rowRanges[1] === 0)).toBe(true);
  });

  it('draws the far mesh instead of its parts while they all show their coarsest level: fewer draws, the same triangles', async () => {
    const w = await build(far(), TIER_TABLE.low, { farMeshes: true });
    const b = w.batcher;
    const f = b.fars[0]!;
    const shownParts = (): string[] => f.members.filter((c) => c.levels.some((l) => l.opaque!.visible)).map((c) => c.rows[0]!.id);
    // 300 m away: every part selects LOD 5, the far mesh draws and the members do not
    b.update({ x: 60, y: 1.7, z: 400 }, true);
    expect(f.members.map((c) => c.levels[c.current]!.lod)).toEqual([5, 5, 5]);
    expect([f.shown, f.opaque!.visible, f.transparent!.visible]).toEqual([true, true, true]);
    expect(shownParts()).toEqual([]);
    expect(f.members.map((c) => c.shown)).toEqual([-1, -1, -1]);
    const farCounts = b.visibleCounts();
    // far opaque + far transparent, the lone cell, the gate
    expect(farCounts.draws).toBe(2 + 1 + 1);
    // the same camera without far meshes: the three parts draw on their own (the lamp's part in two passes)
    const plain = await build(far(), TIER_TABLE.low);
    plain.batcher.update({ x: 60, y: 1.7, z: 400 }, true);
    const plainCounts = plain.batcher.visibleCounts();
    expect(plainCounts.draws).toBe(4 + 1 + 1);
    expect(farCounts.triangles).toBe(plainCounts.triangles);
    // among the huts: one part is at LOD 3, so the group draws part by part and the far mesh is hidden
    b.update({ x: 8, y: 1.7, z: 5 }, true);
    expect([f.shown, f.opaque!.visible, f.transparent!.visible]).toEqual([false, false, false]);
    expect(shownParts()).toEqual(['a1', 'b1', 'c1']);
    expect(f.members.map((c) => c.levels[c.shown]!.lod)).toEqual([3, 3, 5]);
    expect(b.visibleCounts().triangles).toBe(plain.batcher.update({ x: 8, y: 1.7, z: 5 }, true) ? plain.batcher.visibleCounts().triangles : -1);
    // and back
    b.update({ x: 60, y: 1.7, z: 400 }, true);
    expect(f.shown).toBe(true);
    expect(shownParts()).toEqual([]);
  });

  it('takes a promoted row out of its far mesh too, and leaves hidden rows out from the start', async () => {
    const rows = far();
    rows[2] = { ...rows[2]!, visible: false };
    const w = await build(rows, TIER_TABLE.low, { farMeshes: true });
    const b = w.batcher;
    const f = b.fars[0]!;
    const ranges = (r: number): number[] => Array.from(f.packed.rowRanges.subarray(r * 4, r * 4 + 4));
    // b1 was hidden when the map was built: its ranges came into the far mesh already empty
    expect(ranges(2)[1]! + ranges(2)[3]!).toBe(0);
    const [first, count] = ranges(1);
    expect(count).toBe(12); // a2 at LOD 5: two quads
    const version = f.attrs.index.version;
    await b.promote('a2');
    expect(ranges(1)[1]).toBe(0);
    expect(Array.from(f.packed.idx.subarray(first!, first! + count!)).every((i) => i === 0)).toBe(true);
    expect(f.attrs.index.updateRanges).toEqual([{ start: first, count }]);
    expect(f.attrs.index.version).toBe(version + 1);
    // a1's triangles are still there
    expect(ranges(0)[1]).toBe(12);
  });

  it('builds no far mesh when they are switched off or the service cannot merge them', async () => {
    expect((await build(far(), TIER_TABLE.low, { farMeshes: true, far: false })).batcher.fars).toHaveLength(0);
    const w = await build(far(), TIER_TABLE.low);
    expect(w.batcher.fars).toHaveLength(0);
    expect(w.logs.filter((l) => /no buildFar/.test(l))).toHaveLength(1);
  });
});

describe('the instanced keys as BatchedMeshes (DR-35 lever 3)', () => {
  /** five posts and four lamps (instanced on a hybrid tier), a hut */
  const batchedRows = (): BatcherRow[] => [
    ...[0, 1, 2, 3, 4].map((i) => row(`post-${i}`, 'post', i * 2, -40, i === 4 ? { castShadow: false } : {})),
    ...[0, 1, 2, 3].map((i) => row(`lamp-${i}`, 'lamp', i * 30, 40)),
    row('hut-a', 'hut', 4, 4),
  ];
  const geometryIdOf = (mesh: BatchedMesh, id: number): number => mesh.getGeometryIdAt(id);

  it('holds every (key, LOD) range as a geometry and every row as an instance, one BatchedMesh per pass', async () => {
    const w = await build(batchedRows(), TIER_TABLE.high, { multiDraw: true });
    const b = w.batcher;
    const s = b.stats();
    expect([s.instancedKeys, s.instancedRows, s.instancedMeshes, s.batchedMeshes]).toEqual([2, 9, 0, 2]);
    const batch = b.batched!;
    expect(batch.opaque).toBeInstanceOf(BatchedMesh);
    expect(batch.transparent).toBeInstanceOf(BatchedMesh);
    // opaque: nine rows over the posts' and the lamps' three levels; transparent: the four lamps
    expect([batch.opaque!.instanceCount, batch.transparent!.instanceCount]).toEqual([9, 4]);
    expect([batch.opaque!.maxInstanceCount, batch.transparent!.maxInstanceCount]).toEqual([9, 4]);
    const [posts, lamps] = b.instanced;
    expect(posts!.batch!.opaque!.geometryIds).toEqual([0, 1, 2]);
    expect(posts!.batch!.transparent).toBeNull();
    expect(lamps!.batch!.opaque!.geometryIds).toEqual([3, 4, 5]);
    expect(lamps!.batch!.transparent!.geometryIds).toEqual([0, 1, 2]);
    // no InstancedMesh per level; the keys keep their layer-2 shadow proxies
    expect(posts!.levels.every((l) => l.opaque === null && l.transparent === null)).toBe(true);
    expect(posts!.proxy).toBeInstanceOf(InstancedMesh);
    expect(posts!.proxy!.count).toBe(4);
    // the materials are the map's NORMALS variants (a batch needs a normal attribute), the transparent one in one pass
    const V = SurfaceVariant;
    expect(batch.opaque!.material).toBe(w.materials.get({ variant: V.SRC_PACKED | V.SIDE_DOUBLE | V.NORMALS }));
    expect(batch.transparent!.material).toBe(w.materials.get({ variant: V.SRC_PACKED | V.SIDE_DOUBLE | V.TRANSPARENT | V.NORMALS, state: { depthWrite: false } }));
    const chunkTransparent = b.chunks[0]!.levels[0]!.transparent!.material;
    expect(batch.transparent!.material).not.toBe(chunkTransparent);
    expect((batch.transparent!.material as { transparent: boolean; forceSinglePass: boolean; depthWrite: boolean })).toMatchObject({ transparent: true, forceSinglePass: true, depthWrite: false });
    // per-instance culling by three, no object-level sphere; sorted back to front only in the transparent batch
    expect([batch.opaque!.frustumCulled, batch.opaque!.perObjectFrustumCulled, batch.opaque!.sortObjects, batch.transparent!.sortObjects]).toEqual([false, true, false, true]);
    expect([batch.opaque!.castShadow, batch.opaque!.matrixAutoUpdate]).toEqual([false, false]);
    // D5 in the batch too: one normalised int16 vec4 for the position and its alias, one int8 vec4 for the normal and its alias
    const g = batch.opaque!.geometry;
    const position = g.getAttribute('position') as BufferAttribute;
    expect(position.array).toBeInstanceOf(Int16Array);
    expect([position.itemSize, position.normalized]).toEqual([4, true]);
    expect(g.getAttribute(PACKED_ATTRIBUTE)).toBe(position);
    expect(g.getAttribute(PACKED_NORMAL_ATTRIBUTE)).toBe(g.getAttribute('normal'));
    expect((g.getAttribute('normal') as BufferAttribute).array).toBeInstanceOf(Int8Array);
    // posts and lamps have no smooth face: every vertex carries the flat mark
    const normal = g.getAttribute('normal') as BufferAttribute;
    for (let v = 0; v < position.count; v++) expect([normal.getX(v), normal.getY(v), normal.getW(v)]).toEqual([0, 1, 0]);
    // every geometry has explicit bounds in quantised space: a sphere on the origin with the smallest radius that holds
    // every row's box under three's instance test (the posts are not scaled: their box's own sphere, as for a chunk)
    const sphere = batch.opaque!.getBoundingSphereAt(0, new Sphere())!;
    const post = posts!.geometry.levels[0]!;
    expect(sphere.center.toArray()).toEqual([0, 0, 0]);
    expect(sphere.radius).toBeCloseTo(boxSphereRadius(post.bboxMin, post.bboxMax), 12);
    expect(sphere.radius).toBe(keyCullRadius(post.bboxMin, post.bboxMax, posts!.rows.map((r) => r.m)));
    expect(sphere.radius).toBeLessThan(Math.sqrt(3));
    const box = batch.opaque!.getBoundingBoxAt(0, new Box3())!;
    expect([box.min.toArray(), box.max.toArray()]).toEqual([[-1, -1, -1], [1, 1, 1]]);
    // one upload batch for the pair; a key's group is a batch only for its proxy
    expect(b.batches()).toContain(batch.group);
    expect(batch.group.children).toEqual([batch.opaque, batch.transparent]);
  });

  it('reads one paint block for the whole batch: the copied vertices carry the block ids of their records', async () => {
    const w = await build(batchedRows(), TIER_TABLE.high, { multiDraw: true });
    const b = w.batcher;
    const batch = b.batched!;
    // post body, lamp pole, lamp shade
    expect(batch.paints).toBe(3);
    expect(paintBaseOf(batch.opaque!)).toBe(batch.paintBase);
    expect(paintBaseOf(batch.transparent!)).toBe(batch.paintBase);
    const position = batch.opaque!.geometry.getAttribute('position') as BufferAttribute;
    const raw = position.array as Int16Array;
    // each key level's vertices, in the order they were added, resolve to the record their own block gives them
    let v = 0;
    for (const k of b.instanced) {
      for (const l of k.geometry.levels) {
        const own = l.attrs.position.array as Int16Array;
        for (let i = 0; i < l.attrs.position.count; i++, v++) {
          const a = w.paint.recordOf(batch.paintBase, raw[v * 4 + 3]! + PAINT_ID_BIAS);
          const local = own[i * 4 + 3]! + PAINT_ID_BIAS;
          expect(Array.from(a)).toEqual(Array.from(l.paints.subarray(local * 12, local * 12 + 12)));
          expect(Array.from(raw.subarray(v * 4, v * 4 + 3))).toEqual(Array.from(own.subarray(i * 4, i * 4 + 3)));
        }
      }
    }
    expect(v).toBe(batch.opaque!.geometry.getAttribute('position').count);
    // the key geometries themselves (shadow proxies, promoted rows) were not rewritten: the lamp's two paints are ids 0 and 1
    const lampIds = new Set<number>();
    const lamp = b.instanced[1]!.geometry.levels[0]!.attrs.position.array as Int16Array;
    for (let o = 3; o < lamp.length; o += 4) lampIds.add(lamp[o]! + PAINT_ID_BIAS);
    expect([...lampIds].sort()).toEqual([0, 1]);
  });

  it('picks each instance level by setGeometryIdAt and writes that level matrix; nothing draws before the first partition', async () => {
    const w = await build(batchedRows(), TIER_TABLE.high, { multiDraw: true });
    const b = w.batcher;
    const batch = b.batched!;
    const [posts, lamps] = b.instanced;
    const postIds = Array.from(posts!.batch!.opaque!.instanceIds);
    expect(postIds.map((id) => batch.opaque!.getVisibleAt(id))).toEqual([false, false, false, false, false]);
    expect(b.visibleCounts().draws).toBe(0);
    // among the posts: all five at LOD 1
    b.update({ x: 4, y: 1.7, z: -40 }, true);
    expect(postIds.map((id) => [batch.opaque!.getVisibleAt(id), geometryIdOf(batch.opaque!, id)])).toEqual([[true, 0], [true, 0], [true, 0], [true, 0], [true, 0]]);
    // (the nearest lamp is just inside the 80 m band, the other three beyond it)
    expect(b.instanceLevelCounts()).toEqual([0, 5, 0, 1, 0, 3]);
    // the matrix is the instance's own: row matrix · dequantisation of that level
    const m = new Matrix4();
    batch.opaque!.getMatrixAt(postIds[2]!, m);
    expect(new Vector3(0, -1, 0).applyMatrix4(m).toArray().map((x) => Math.round(x * 1000) / 1000)).toEqual([4, 0, -40]);
    expect(Array.from(m.elements)).toEqual(Array.from(posts!.levels[0]!.matrices.subarray(32, 48)));
    // 45 m along x: LOD 3; 300 m: LOD 5
    b.update({ x: -45, y: 1.7, z: -40 }, true);
    expect(postIds.map((id) => geometryIdOf(batch.opaque!, id))).toEqual([1, 1, 1, 1, 1]);
    b.update({ x: 4, y: 1.7, z: 400 }, true);
    expect(postIds.map((id) => geometryIdOf(batch.opaque!, id))).toEqual([2, 2, 2, 2, 2]);
    batch.opaque!.getMatrixAt(postIds[2]!, m);
    expect(Array.from(m.elements)).toEqual(Array.from(posts!.levels[2]!.matrices.subarray(32, 48)));
    // the lamps span the bands from one end of their row: both batches follow, each with its own geometry ids
    b.update({ x: -5, y: 1.7, z: 40 }, true);
    const lampLevels = Array.from(lamps!.assigned);
    // (the second lamp is 33 m away: coming from LOD 5 it stops at LOD 3, inside the hysteresis band of the 30 m switch)
    expect(lampLevels).toEqual([0, 1, 1, 2]);
    expect(Array.from(lamps!.batch!.opaque!.instanceIds, (id) => geometryIdOf(batch.opaque!, id))).toEqual([3, 4, 4, 5]);
    expect(Array.from(lamps!.batch!.transparent!.instanceIds, (id) => geometryIdOf(batch.transparent!, id))).toEqual([0, 1, 1, 2]);
    // what the world camera would draw: the two batches are two draws whatever the number of keys and levels
    const c = b.visibleCounts();
    // + the hut's chunk at LOD 3 (the camera is 36 m from its box)
    expect(c.draws).toBe(2 + 1);
    // five posts (2 triangles each at every level), lamps 6 + 4 + 4 + 4, the hut 6
    expect(c.triangles).toBe(5 * 2 + (6 + 4 + 4 + 4) + 6);
  });

  it('hides a promoted row in both batches and keeps the others', async () => {
    const w = await build(batchedRows(), TIER_TABLE.high, { multiDraw: true });
    const b = w.batcher;
    b.update({ x: -5, y: 1.7, z: 40 }, true);
    const lamps = b.instanced[1]!;
    const batch = b.batched!;
    const single = await b.promote('lamp-1');
    expect(b.classOf('lamp-1')).toBe('single');
    expect(single!.levels.map((l) => l.lod)).toEqual([1, 3, 5]);
    expect(Array.from(lamps.batch!.opaque!.instanceIds, (id) => batch.opaque!.getVisibleAt(id))).toEqual([true, false, true, true]);
    expect(Array.from(lamps.batch!.transparent!.instanceIds, (id) => batch.transparent!.getVisibleAt(id))).toEqual([true, false, true, true]);
    // later partitions leave it out
    b.update({ x: 400, y: 1.7, z: 40 }, true);
    expect(batch.opaque!.getVisibleAt(lamps.batch!.opaque!.instanceIds[1]!)).toBe(false);
    expect(b.instanceLevelCounts()).toEqual([0, 0, 0, 0, 0, 8]);
    // a row hidden from the start never shows
    const rows = batchedRows();
    rows[0] = { ...rows[0]!, visible: false };
    const hidden = await build(rows, TIER_TABLE.high, { multiDraw: true });
    hidden.batcher.update({ x: 4, y: 1.7, z: -40 }, true);
    const ids = Array.from(hidden.batcher.instanced[0]!.batch!.opaque!.instanceIds);
    expect(ids.map((id) => hidden.batcher.batched!.opaque!.getVisibleAt(id))).toEqual([false, true, true, true, true]);
  });

  it('culls a stretched row safely: the geometry sphere grows to hold the box of every row of the key', async () => {
    // one post twenty times as wide as the others (4 m by 3 m instead of 0.2 m by 3 m): a non-uniform scale
    const rows = batchedRows();
    rows[1] = { ...rows[1]!, m: new Float32Array([20, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 0, -40, 1]) };
    const w = await build(rows, TIER_TABLE.high, { multiDraw: true });
    const b = w.batcher;
    const posts = b.instanced[0]!;
    const level = posts.geometry.levels[0]!;
    const sphere = b.batched!.opaque!.getBoundingSphereAt(posts.batch!.opaque!.geometryIds[0]!, new Sphere())!;
    expect(sphere.radius).toBeGreaterThan(boxSphereRadius(level.bboxMin, level.bboxMax));
    b.update({ x: 4, y: 1.7, z: -40 }, true);
    // what three tests each instance with holds all eight corners of that row's box
    const m = new Matrix4();
    for (let i = 0; i < posts.rows.length; i++) {
      b.batched!.opaque!.getMatrixAt(posts.batch!.opaque!.instanceIds[i]!, m);
      const world = sphere.clone().applyMatrix4(m);
      for (let c = 0; c < 8; c++) {
        const corner = new Vector3(c & 1 ? 1 : -1, c & 2 ? 1 : -1, c & 4 ? 1 : -1).applyMatrix4(m);
        expect(world.center.distanceTo(corner)).toBeLessThanOrEqual(world.radius * (1 + 1e-9));
      }
    }
    // and for the stretched row it is exact: its farthest corner lies on the sphere
    b.batched!.opaque!.getMatrixAt(posts.batch!.opaque!.instanceIds[1]!, m);
    const stretched = sphere.clone().applyMatrix4(m);
    expect(stretched.center.distanceTo(new Vector3(1, 1, 1).applyMatrix4(m))).toBeCloseTo(stretched.radius, 6);
    expect(stretched.radius).toBeCloseTo(Math.hypot(2, 1.5), 4);
  });

  it('appends a key level paint block only when a mesh draws with it', async () => {
    // lamps ×3: asked for their LOD 1 triangles (2 or 3 static rows), found small, merged: no block of their own.
    // posts ×5: in the batch; only their LOD 5 level gets a block, for the shadow proxy
    const rows = [...[0, 1, 2, 3, 4].map((i) => row(`post-${i}`, 'post', i * 2, -40)), ...[0, 1, 2].map((i) => row(`lamp-${i}`, 'lamp', i * 3, 40))];
    const w = await build(rows, TIER_TABLE.high, { multiDraw: true });
    const b = w.batcher;
    expect(w.requests.sort()).toEqual(['scripts/gen/lamp.js', 'scripts/gen/post.js']);
    expect(b.stats()).toMatchObject({ chunks: 1, instancedKeys: 1, batchedMeshes: 1 });
    const posts = b.instanced[0]!;
    expect(posts.geometry.levels.map((l) => l.paintBase >= 0)).toEqual([false, false, true]);
    // the lamps' cell block (pole, shade), the batch block (post body), the proxy's block (post body)
    expect(w.paint.index.count).toBe(2 + 1 + 1);
    // a promoted row brings the blocks of the levels it draws
    await b.promote('post-2');
    expect(posts.geometry.levels.map((l) => l.paintBase >= 0)).toEqual([true, true, true]);
    expect(w.paint.index.count).toBe(2 + 1 + 3);
    // without multi-draw every level of an instanced key is a mesh: three blocks from the start
    const plain = await build(rows);
    expect(plain.paint.index.count).toBe(2 + 3);
  });

  it('builds InstancedMeshes without multi-draw, and no batch on a tier that merges everything', async () => {
    const instanced = await build(batchedRows());
    expect(instanced.batcher.batched).toBeNull();
    expect(instanced.batcher.stats()).toMatchObject({ batchedMeshes: 0, instancedMeshes: 3 + 6 });
    expect(instanced.batcher.instanced.every((k) => k.batch === null)).toBe(true);
    const merged = await build(batchedRows(), TIER_TABLE.low, { multiDraw: true });
    expect(merged.batcher.batched).toBeNull();
    expect(merged.batcher.stats().instancedKeys).toBe(0);
  });

  it('reads the multi-draw capability off the backend', () => {
    const backend = (webgl: boolean, has: boolean): { backend: unknown } => ({ backend: { isWebGLBackend: webgl, extensions: { has: (name: string) => has && name === 'WEBGL_multi_draw' } } });
    expect(supportsMultiDraw(backend(true, true))).toBe(true);
    expect(supportsMultiDraw(backend(true, false))).toBe(false);
    // the WebGPU backend draws a batch one instance at a time
    expect(supportsMultiDraw(backend(false, true))).toBe(false);
    expect(supportsMultiDraw({})).toBe(false);
  });
});
