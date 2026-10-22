// `scriptedPivot`: `pivot` on a scripted (map) row; `bones` writes with rigs on draw no warning; `rowMeshes` promotes a batched row.
import { Group, Matrix4, PerspectiveCamera, Scene, Vector3, WebGLCoordinateSystem } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { createMapHost } from '../../src/render/bridge/attach.ts';
import { createRenderBridge, type RenderBridgeDeps } from '../../src/render/bridge/render-bridge.ts';
import type { GeometryContext } from '../../src/render/geometry/generator-types.ts';
import { GeometryServiceImpl } from '../../src/render/geometry/geometry-service.ts';
import { createInProcessExecutor, type ModuleLoader } from '../../src/render/geometry/geometry-worker.ts';
import { TIER_TABLE } from '../../src/render/perf/budget.ts';
import { createCameraPresenter } from '../../src/render/scene/camera-presenter.ts';
import { MapPaint, registerPackedSurface } from '../../src/render/surface/paint-table.ts';
import type { LightingScript } from '../../src/render/surface/script-types.ts';
import { SurfaceMaterials } from '../../src/render/surface/surface-material.ts';
import { createLightTable } from '../../src/render/lighting/light-table.ts';
import { frameAt, TestFeed, TestRow } from '../../tests/unit/render/bridge-fakes.ts';

// a 2 m tall, 2 m wide box-ish hut: its box is x -1..1, y 0..2, z -1..1
const MODULES: Record<string, unknown> = {
  'scripts/gen/hut.js': {
    geometry(ctx: GeometryContext) {
      ctx.color('oklch(0.5 0.1 30)');
      ctx.quad(-1, 0, -1, -1, 2, -1, 1, 2, -1, 1, 0, -1);
      ctx.quad(-1, 0, 1, 1, 0, 1, 1, 2, 1, -1, 2, 1);
    },
  },
};
const load: ModuleLoader = async (s) => {
  const m = MODULES[s];
  if (!m) throw new Error(`unknown ${s}`);
  return m;
};
const script: LightingScript = { lighting: (_s, l) => l.ambient };

function world(over: Partial<RenderBridgeDeps> = {}) {
  const root = new Group();
  const scene = new Scene();
  scene.add(root);
  const camera = createCameraPresenter({ coordinateSystem: () => WebGLCoordinateSystem });
  camera.apply({ eye: { x: 0, y: 1.6, z: 6 }, yaw: 0, pitch: 0, roll: 0, vfovDeg: 58.72 });
  const materials = new SurfaceMaterials({ script });
  const packed = registerPackedSurface(materials, new MapPaint({ paints: 16, entries: 16 }));
  const renderer = { compileAsync: async () => undefined, copyTextureToTexture: () => undefined, backend: {} };
  const logs: string[] = [];
  const host = createMapHost({
    renderer: () => renderer,
    geometry: new GeometryServiceImpl({ executor: createInProcessExecutor(load, { strict: true }) }),
    materials, packed, tier: () => TIER_TABLE.high, camera: new PerspectiveCamera(), scene,
    paint: { paints: 4096, entries: 65536 }, yieldFrame: async () => undefined, far: false, log: (m) => logs.push(m),
  });
  const feed = new TestFeed();
  const bridge = createRenderBridge({ world: root, camera, lights: createLightTable(), map: host, log: (m) => logs.push(m), ...over });
  bridge.attach(feed);
  return {
    bridge, feed, logs,
    frame: () => bridge.update(frameAt(1)),
    settle: async () => { for (let i = 0; i < 12; i++) await new Promise((r) => setTimeout(r, 0)); },
  };
}

const hut = (id: string, x: number, props: Record<string, unknown> = {}, init: Partial<ConstructorParameters<typeof TestRow>[1]> = {}): TestRow =>
  new TestRow(id, { place: 'yard', pos: [x, 0, 0], ...init, props: { primitive: { kind: 'scripted', script: 'scripts/gen/hut.js', params: {} }, ...props } });

/** where the row's local point (0,0,0) of its geometry lands: the mesh matrix with the dequantisation undone */
function geometryOrigin(meshMatrix: Matrix4, dequant: Matrix4): Vector3 {
  return new Vector3().applyMatrix4(new Matrix4().multiplyMatrices(meshMatrix, dequant.clone().invert()));
}

describe('scriptedPivot', () => {
  it("pivot 'center' puts the box middle on the row origin, for a static row and a row spawned in play", async () => {
    const w = world({ scriptedPivot: true });
    await w.bridge.loadStaticPlace([hut('a', 0, { pivot: 'center' }), hut('plain', 10)], () => undefined);
    w.frame();
    await w.settle();
    w.frame();
    const map = w.bridge.mapOf('yard')!;
    expect(map.classOf('a')).toBe('single');
    expect(map.rowBox?.('a')).toEqual([-1, 0, -1, 1, 2, 1]);
    const mesh = map.rowMeshes!('a')![0]!;
    // the geometry is shifted down by its half height in the row frame: the hut's floor at y = -1
    const box = map.rowBox!('a')!;
    const dequant = new Matrix4().set((box[3]! - box[0]!) / 2, 0, 0, (box[0]! + box[3]!) / 2, 0, (box[4]! - box[1]!) / 2, 0, (box[1]! + box[4]!) / 2, 0, 0, (box[5]! - box[2]!) / 2, (box[2]! + box[5]!) / 2, 0, 0, 0, 1);
    const o = geometryOrigin(mesh.matrix, dequant);
    expect(o.y).toBeCloseTo(-1);
    expect(o.x).toBeCloseTo(0);
    // spawned during play, with an object pivot and a scale of 2
    w.feed.add(hut('b', 5, { pivot: { x: 0.5, y: 1, z: 0.5 } }, { scale: 2 }));
    w.frame();
    await w.settle();
    w.frame();
    const mb = map.rowMeshes!('b')![0]!;
    const ob = geometryOrigin(mb.matrix, dequant);
    expect(ob.y).toBeCloseTo(-4);
    expect(ob.x).toBeCloseTo(5);
    expect(w.logs.some((l) => l.includes('`pivot` on a scripted primitive'))).toBe(false);
  });
  it('negative (PP): without the option the pivot is not applied and logged once per row', async () => {
    const w = world();
    await w.bridge.loadStaticPlace([hut('a', 0, { pivot: 'center' })], () => undefined);
    w.frame();
    expect(w.logs.filter((l) => l.includes('`pivot` on a scripted primitive'))).toHaveLength(1);
  });
});

describe('bones writes and rowMeshes', () => {
  it('a bones write with rigs on is not logged; with rigs off it is (PP)', async () => {
    for (const rigs of [true, false]) {
      const w = world(rigs ? { rigs: true } : {});
      const row = hut('a', 0);
      await w.bridge.loadStaticPlace([row], () => undefined);
      w.frame();
      w.feed.change(row.set('bones', { head: { yaw: 10 } }), 'bones');
      w.frame();
      expect(w.logs.some((l) => l.includes('`bones`')), `rigs ${rigs}`).toBe(!rigs);
    }
  });
  it('rowMeshes promotes a batched row and then hands its meshes', async () => {
    const w = world();
    await w.bridge.loadStaticPlace([hut('a', 0), hut('b', 4)], () => undefined);
    w.frame();
    const map = w.bridge.mapOf('yard')!;
    expect(map.classOf('a')).not.toBe('single');
    expect(w.bridge.rowMeshes('a')).toBeNull();
    await w.settle();
    w.frame();
    expect(map.classOf('a')).toBe('single');
    expect(w.bridge.rowMeshes('a')!.length).toBeGreaterThan(0);
    expect(w.bridge.rowMeshes('nope')).toBeNull();
  });
});
