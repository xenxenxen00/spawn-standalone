// K13 `material.dissolve` (Crown & Clash: pieces, fans, props, the Reaper; engine api-reference.md:1604): 0 solid, 1 gone, one value per
// row without cloning materials, the shadow pass included. Off by default (PP lists it as unsupported); a game turns it on with
// `installGame`'s `dissolve` dependency, here `setDissolveSupport`. The switch is material state, not a variant bit (the bit
// numbering is pinned). Node + three, no renderer.
import { PerspectiveCamera, Scene, WebGLCoordinateSystem } from 'three/webgpu';
import type { Group as GroupType, Mesh, Object3D } from 'three/webgpu';
import { Group } from 'three/webgpu';
import { afterEach, describe, expect, it } from 'vitest';
import { createMapHost, rowLook } from '../../../src/render/bridge/attach.ts';
import { createRenderBridge } from '../../../src/render/bridge/render-bridge.ts';
import { GeometryServiceImpl } from '../../../src/render/geometry/geometry-service.ts';
import { createInProcessExecutor, type ModuleLoader } from '../../../src/render/geometry/geometry-worker.ts';
import { createLightTable } from '../../../src/render/lighting/light-table.ts';
import { TIER_TABLE } from '../../../src/render/perf/budget.ts';
import { createCameraPresenter } from '../../../src/render/scene/camera-presenter.ts';
import { dissolveSupported, setDissolveSupport, surfaceParamsFromSpec } from '../../../src/render/surface/material-spec.ts';
import { MapPaint, registerPackedSurface } from '../../../src/render/surface/paint-table.ts';
import type { LightingScript } from '../../../src/render/surface/script-types.ts';
import { SurfaceMaterials, SurfaceVariant as V, surfacePaintOf } from '../../../src/render/surface/surface-material.ts';
import { frameAt, TestFeed, TestRow } from './bridge-fakes.ts';

afterEach(() => setDissolveSupport(false));

const script: LightingScript = { lighting: (_s, l) => l.ambient };

describe('the surface parameters', () => {
  it('is off by default: dissolve is listed unsupported and sets nothing (PP path)', () => {
    expect(dissolveSupported()).toBe(false);
    const p = surfaceParamsFromSpec({ dissolve: 0.5 });
    expect(p.unsupported).toEqual(['dissolve']);
    expect(p.state.dissolve).toBeUndefined();
    expect(p.paint.dissolve).toBeUndefined();
    expect(p.dissolve).toBeUndefined();
  });

  it('on: any dissolve number sets the state and the paint (0 too, so an animation 0 -> 1 never changes program)', () => {
    setDissolveSupport(true);
    for (const d of [0, 0.25, 1]) {
      const p = surfaceParamsFromSpec({ dissolve: d });
      expect(p.state.dissolve).toBe(true);
      expect(p.paint.dissolve).toBe(d);
      expect(p.unsupported).toEqual([]);
    }
    expect(surfaceParamsFromSpec({ dissolve: 7 }).paint.dissolve).toBe(1);
    expect(surfaceParamsFromSpec({ dissolve: -2 }).paint.dissolve).toBe(0);
    // a spec with no dissolve, and no spec, stay as they were
    expect(surfaceParamsFromSpec({ color: '#fff' }).state.dissolve).toBeUndefined();
    expect(surfaceParamsFromSpec(null).state.dissolve).toBeUndefined();
  });

  it('a scripted row whose material is only a dissolve keeps the generator paints and gains the cut', () => {
    setDissolveSupport(true);
    const p = surfaceParamsFromSpec({ dissolve: 0 }, { source: 'packed', scripted: true });
    expect(p.paintSource).toBe('generator');
    expect(p.variant & V.SRC_PACKED).toBe(V.SRC_PACKED);
    expect(p.state.dissolve).toBe(true);
    expect(p.dissolve).toBe(true);
    expect(rowLook({ dissolve: 0 })).not.toBeNull();
    setDissolveSupport(false);
    expect(rowLook({ dissolve: 0 })).toBeNull();
  });
});

describe('the dissolving material', () => {
  const get = (variant: number, dissolve?: boolean): { maskNode: unknown } =>
    new SurfaceMaterials({ script }).get({ variant, textures: {}, ...(dissolve === undefined ? {} : { state: { dissolve } }) }) as unknown as { maskNode: unknown };

  it('discards through maskNode, which the shadow depth pass reads too; other materials have none', () => {
    expect(get(V.SRC_PRIM, true).maskNode).not.toBeNull();
    expect(get(V.SRC_PRIM | V.TRANSPARENT, true).maskNode).not.toBeNull();
    expect(get(V.SRC_PRIM | V.UNLIT, true).maskNode).not.toBeNull();
    // negative control
    expect(get(V.SRC_PRIM).maskNode).toBeNull();
    expect(get(V.SRC_PRIM, false).maskNode).toBeNull();
  });

  it('is its own material (hence its own program) and one material serves every dissolving row', () => {
    const materials = new SurfaceMaterials({ script });
    const a = materials.get({ variant: V.SRC_PRIM, textures: {}, state: { dissolve: true } });
    const b = materials.get({ variant: V.SRC_PRIM, textures: {}, state: { dissolve: true } });
    const plain = materials.get({ variant: V.SRC_PRIM, textures: {} });
    expect(a).toBe(b);
    expect(a).not.toBe(plain);
    expect(materials.size).toBe(2);
  });

  it('reads the amount per object: two objects on one material see their own value', () => {
    const material = get(V.SRC_PRIM, true) as { maskNode: GraphNode };
    const updaters = graph(material.maskNode).filter((n) => n.updateType === 'object' && typeof n.update === 'function' && n.isUniformNode === true);
    expect(updaters.length).toBe(1);
    const u = updaters[0]!;
    const one = { userData: { ssPaint: { dissolve: 0.25 } } } as unknown as Object3D;
    const two = { userData: { ssPaint: { dissolve: 0.75 } } } as unknown as Object3D;
    const none = { userData: {} } as unknown as Object3D;
    u.update!({ object: one });
    expect(u.value).toBe(0.25);
    u.update!({ object: two });
    expect(u.value).toBe(0.75);
    u.update!({ object: none });
    expect(u.value).toBe(0);
    expect(surfacePaintOf(one).dissolve).toBe(0.25);
  });
});

interface GraphNode {
  id: number;
  updateType?: string;
  isUniformNode?: boolean;
  value?: unknown;
  update?(frame: { object: Object3D }): void;
  getChildren(): Iterable<GraphNode>;
}
function graph(root: GraphNode): GraphNode[] {
  const seen = new Map<number, GraphNode>();
  const walk = (n: GraphNode): void => {
    if (seen.has(n.id)) return;
    seen.set(n.id, n);
    for (const c of n.getChildren()) walk(c);
  };
  walk(root);
  return [...seen.values()];
}

// ── on the render bridge ────────────────────────────────────────────────────────────────────────────────────────────────

const MODULES: Record<string, unknown> = {
  'scripts/gen/piece.js': {
    geometry(ctx: { color(c: string): void; quad(...n: number[]): void }) {
      ctx.color('oklch(0.5 0.1 30)');
      ctx.quad(-1, 0, -1, -1, 2, -1, 1, 2, -1, 1, 0, -1);
      ctx.quad(-1, 0, 1, 1, 0, 1, 1, 2, 1, -1, 2, 1);
    },
  },
};
const load: ModuleLoader = async (s) => {
  const m = MODULES[s];
  if (!m) throw new Error(`unknown generator script ${s}`);
  return m;
};

function world() {
  const root: GroupType = new Group();
  const scene = new Scene();
  scene.add(root);
  const camera = createCameraPresenter({ coordinateSystem: () => WebGLCoordinateSystem });
  camera.apply({ eye: { x: 0, y: 1.6, z: 6 }, yaw: 0, pitch: 0, roll: 0, vfovDeg: 58.72 });
  const materials = new SurfaceMaterials({ script });
  const packed = registerPackedSurface(materials, new MapPaint({ paints: 16, entries: 16 }));
  const logs: string[] = [];
  const renderer = { compileAsync: async () => undefined, copyTextureToTexture: () => undefined, backend: {} };
  const host = createMapHost({
    renderer: () => renderer,
    geometry: new GeometryServiceImpl({ executor: createInProcessExecutor(load, { strict: true }) }),
    materials,
    packed,
    tier: () => TIER_TABLE.high,
    camera: new PerspectiveCamera(),
    scene,
    paint: { paints: 4096, entries: 65536 },
    resolveTexture: () => undefined,
    yieldFrame: async () => undefined,
    far: false,
    log: (m) => logs.push(m),
  });
  const feed = new TestFeed();
  const bridge = createRenderBridge({ world: root, camera, lights: createLightTable(), map: host, log: (m) => logs.push(m) });
  bridge.attach(feed);
  return { bridge, feed, host, logs, frame: (alpha = 1) => bridge.update(frameAt(alpha)) };
}

const piece = (id: string, x: number, material?: Record<string, unknown>): TestRow =>
  new TestRow(id, { place: 'board', pos: [x, 0, 0], props: { primitive: { kind: 'scripted', script: 'scripts/gen/piece.js', params: {} }, ...(material === undefined ? {} : { material }) } });

const meshesOf = (w: ReturnType<typeof world>, id: string): Mesh[] => {
  const s = w.host.batcher('board')!.singles.find((x) => x.row.id === id)!;
  return s.levels.flatMap((l) => [l.opaque, l.transparent]).filter((m): m is Mesh => m !== null);
};

describe('a scripted row with material.dissolve on the bridge', () => {
  it('is a single row with its own dissolving mesh, takes the value as paint, and a write moves only that row', async () => {
    setDissolveSupport(true);
    const w = world();
    const rows = [piece('a', 0, { dissolve: 0 }), piece('b', 4, { dissolve: 0 }), piece('c', 8)];
    await w.bridge.loadStaticPlace(rows, () => undefined);
    w.feed.add(...rows);
    w.frame();
    const map = w.host.batcher('board')!;
    expect(map.classOf('a')).toBe('single');
    expect(map.classOf('b')).toBe('single');
    // the row without a dissolve stays what PP makes of it (merged with its kind)
    expect(map.classOf('c')).not.toBe('single');
    const [ma] = meshesOf(w, 'a');
    const [mb] = meshesOf(w, 'b');
    expect((ma!.material as unknown as { maskNode: unknown }).maskNode).not.toBeNull();
    // one material for both rows: no clone per row
    expect(ma!.material).toBe(mb!.material);
    expect(surfacePaintOf(ma!).dissolve).toBe(0);

    rows[0]!.props['material'] = { dissolve: 0.5 };
    w.feed.change(rows[0]!, 'material');
    w.frame();
    expect(surfacePaintOf(ma!).dissolve).toBe(0.5);
    expect(surfacePaintOf(mb!).dissolve).toBe(0);
    rows[0]!.props['material'] = { dissolve: 1 };
    w.feed.change(rows[0]!, 'material');
    w.frame();
    expect(surfacePaintOf(ma!).dissolve).toBe(1);
    expect(surfacePaintOf(mb!).dissolve).toBe(0);
    expect(w.logs).toEqual([]);
  });

  it('negative control: with support off the same rows are batched as PP does and nothing is dissolved', async () => {
    const w = world();
    const rows = [piece('a', 0, { dissolve: 0 }), piece('b', 4, { dissolve: 0 })];
    await w.bridge.loadStaticPlace(rows, () => undefined);
    w.feed.add(...rows);
    w.frame();
    const map = w.host.batcher('board')!;
    expect(map.classOf('a')).not.toBe('single');
    expect(map.singles.length).toBe(0);
  });
});
