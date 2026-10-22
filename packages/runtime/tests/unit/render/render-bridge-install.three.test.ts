// bridge/install.ts and bridge/attach.ts on the facade's seams (docs/architecture.md §4.2 step 4, X-14, X-36; render §16.3;
// WP R13): the order of the render-side frame steps, the scene port, and `port.viewmodelInterp` read at run time. The loop is
// R0's real one (its fixed stage order is the facade's), the scene root and the camera presenter are real, the kernel behind
// the scene port is real; three's renderer is a stand-in. Node + three, no renderer. The real facade on SwiftShader is
// tests/e2e/render-r13.spec.ts.
import { Group, Matrix4, Object3D, WebGLCoordinateSystem } from 'three/webgpu';
import { afterEach, describe, expect, it } from 'vitest';
import { resetPortFlags, setPortFlag } from '../../../src/compat/builtin/port.ts';
import type { RowFeed, SceneSyncPort } from '../../../src/compat/core/ports.ts';
import type { BridgeModel, BridgeModels } from '../../../src/render/bridge/bridge-types.ts';
import { installRenderBridge, type RenderBridgeHost } from '../../../src/render/bridge/install.ts';
import { createRenderLoop } from '../../../src/render/engine/render-loop.ts';
import { createLightTable } from '../../../src/render/lighting/light-table.ts';
import { createCameraPresenter } from '../../../src/render/scene/camera-presenter.ts';
import { createSceneRoot } from '../../../src/render/scene/scene-root.ts';
import { ctxWorld } from '../core/fakes/ctx-world.ts';
import { frameAt, matrixDiff, TestFeed, TestRow } from './bridge-fakes.ts';

afterEach(() => resetPortFlags());

/** a drawn model as far as the bridge and a skin adapter handle it: a root and one bone whose world matrix is written, not derived */
function fakeModel(): BridgeModel & { head: Object3D } {
  const root = new Group();
  const head = new Object3D();
  head.matrixAutoUpdate = false;
  head.matrixWorldAutoUpdate = false;
  root.add(head);
  return { root, head, bones: new Map([['Head', head]]), bonePath: 'direct', setLayers: () => undefined, setVisible: () => undefined, dispose: () => root.removeFromParent() };
}

function host(over: { geometry?: unknown; models?: BridgeModels } = {}) {
  const root = createSceneRoot();
  const camera = createCameraPresenter({ coordinateSystem: () => WebGLCoordinateSystem });
  camera.setViewport(640, 360);
  camera.apply({ eye: { x: 0, y: 1.6, z: 5 }, yaw: 0, pitch: 0, roll: 0, vfovDeg: 58.72 });
  const loop = createRenderLoop({ draw: () => false, clock: { requestAnimationFrame: () => 0, cancelAnimationFrame: () => undefined } });
  const order: string[] = [];
  const models: Array<BridgeModel & { head: Object3D }> = [];
  let port: SceneSyncPort | null = null;
  let feed: RowFeed | null = null;
  let onMixer: (() => void) | null = null;
  const h: RenderBridgeHost = {
    root,
    camera,
    loop,
    tier: 'high',
    engine: { renderer: { compileAsync: async () => undefined, copyTextureToTexture: () => undefined, backend: {}, coordinateSystem: WebGLCoordinateSystem } },
    deps: {
      geometry: over.geometry ?? {},
      mixer: {
        // the animation domain's presenter takes every model
        bind: () => true,
        update: () => {
          order.push('mixer');
          onMixer?.();
        },
      },
    },
    get feed() {
      return feed;
    },
    setScenePort(p) {
      port = p;
    },
  };
  const logs: string[] = [];
  const installed = installRenderBridge(h, {
    script: { lighting: (_s, l) => l.ambient },
    lights: createLightTable(),
    models:
      over.models ??
      ({
        create(row) {
          if (row.props['model'] === undefined) return null;
          const m = fakeModel();
          models.push(m);
          return m;
        },
      } satisfies BridgeModels),
    log: (m) => logs.push(m),
  });
  return {
    h,
    root,
    camera,
    loop,
    installed,
    order,
    models,
    logs,
    port: () => port,
    attachFeed: (f: RowFeed) => void (feed = f),
    onMixer: (fn: (() => void) | null) => void (onMixer = fn),
  };
}

describe('installRenderBridge: the order of the frame on the render side', () => {
  it('feed drain → bridge (roots at this frame\'s pose) → the mixer\'s skin write → afterPose (rows on bones, the bucket flush)', () => {
    const w = host();
    const feed = new TestFeed();
    w.attachFeed(feed);
    const body = new TestRow('body', { pos: [0, 0, 0], props: { model: { id: 'x.glb' } } });
    const wound = new TestRow('wound', { parent: 'body', pos: [0, 0.1, 0], props: { attachment: { bone: 'Head' }, primitive: { kind: 'sphere', radius: 0.05 }, material: { color: '#800000' } } });
    feed.add(body, wound);
    w.loop.update(frameAt(1));
    expect(feed.drains).toBe(1);
    const model = w.models[0]!;
    body.tick({ pos: [1, 0, 0] });
    feed.change(body, 'feetPosition');
    // the skin adapter: bone = this frame's root × its model-space matrix; it must find the root already moved
    let rootAtSkinWrite = Number.NaN;
    let woundAtSkinWrite = Number.NaN;
    w.onMixer(() => {
      rootAtSkinWrite = model.root.matrixWorld.elements[12]!;
      woundAtSkinWrite = w.installed.bridge.node('wound')!.world[12]!;
      model.head.matrixWorld.copy(model.root.matrixWorld).multiply(new Matrix4().makeTranslation(0, 1.7, 0));
    });
    w.order.length = 0;
    w.loop.update(frameAt(0.5));
    expect(w.order).toEqual(['mixer']);
    expect(feed.drains).toBe(2);
    // the bridge ran before the mixer: the root is at alpha 0.5 of this tick
    expect(rootAtSkinWrite).toBeCloseTo(0.5, 12);
    // the row on the bone was still where the last frame put it when the skin write ran, and is on this frame's bone after it
    expect(woundAtSkinWrite).not.toBeCloseTo(0.5, 6);
    expect(Array.from(w.installed.bridge.node('wound')!.world).slice(12, 15)).toEqual([0.5, 1.8, 0]);
    // its bucket instance was flushed in the same update: the mesh draws one instance at the bone
    const bucket = w.installed.primitives.buckets()[0]!;
    expect(bucket.mesh.count).toBe(1);
    expect(bucket.matrices[12]).toBeCloseTo(0.5, 6);
    // the viewmodel layer follows the camera in the bridge stage: its anchor is in the scene and holds this frame's camera
    expect(w.installed.viewmodel.anchor.parent).toBe(w.root.scene);
    expect(matrixDiff(w.installed.viewmodel.anchor.matrixWorld.elements, w.camera.world.matrixWorld.elements)).toBe(0);
  });

  it('reads `port.viewmodelInterp` every frame: "step" presents cur, "alpha" interpolates again', () => {
    const w = host();
    const feed = new TestFeed();
    w.attachFeed(feed);
    const gun = new TestRow('gun', { pos: [0.1, -0.2, -0.5], props: { feetPosition: { attach: 'camera', x: 0.1, y: -0.2, depth: 0.5, fov: 55 }, primitive: { kind: 'box', size: 0.1 }, material: { color: '#888888' } } });
    feed.add(gun);
    w.loop.update(frameAt(1));
    gun.tick({ pos: [0.2, -0.2, -0.5] }).set('feetPosition', { attach: 'camera', x: 0.2, y: -0.2, depth: 0.5, fov: 55 });
    feed.change(gun, 'feetPosition');
    w.loop.update(frameAt(0.5));
    expect(w.installed.viewmodel.presented('gun')!.x).toBeCloseTo(0.15, 12); // the default: 'alpha'
    setPortFlag('port.viewmodelInterp', 'step');
    w.loop.update(frameAt(0.5));
    expect(w.installed.viewmodel.presented('gun')!.x).toBeCloseTo(0.2, 12);
    setPortFlag('port.viewmodelInterp', 'alpha');
    w.loop.update(frameAt(0.25));
    expect(w.installed.viewmodel.presented('gun')!.x).toBeCloseTo(0.125, 12);
  });

  it('`scene` is the kernel\'s way in: buildPlace names the place\'s rows through their feed snapshots, activate and disposePlace follow', async () => {
    const w = host();
    const cw = await ctxWorld({ places: ['lobby', 'match'] });
    w.attachFeed(cw.k.feed);
    cw.spawn('crate', { place: 'match', feetPosition: { x: 3, y: 0, z: 0 }, primitive: { kind: 'box', size: 1 }, material: { color: '#808080' } });
    cw.spawn('lamp', { place: 'match', feetPosition: { x: 0, y: 3, z: 0 }, light: { kind: 'point', color: '#ffffff', intensity: 2, distance: 6 } });
    cw.spawn('desk', { place: 'lobby', feetPosition: { x: 0, y: 0, z: 0 }, primitive: { kind: 'box', size: 1 }, material: { color: '#808080' } });
    const port = w.port()!;
    let progress = 0;
    await port.buildPlace('match', [...cw.k.store.byPlace('match')], { colliders: { place: 'match', keys: [], instances: [], runtimeKeys: [] }, navgrid: null, terrain: null }, (f) => (progress = f));
    expect(progress).toBe(1);
    const bridge = w.installed.bridge;
    expect(bridge.stats()).toMatchObject({ rows: 2, lights: 1 });
    // the geometry service of this host builds no chunks: said once, and the place still builds
    expect(w.logs.filter((l) => l.includes('buildChunks'))).toHaveLength(1);
    // the first drain then names every live row: the two the build named are the same rows, the lobby's is new
    w.loop.update(frameAt(1));
    expect(bridge.stats()).toMatchObject({ rows: 3, lights: 1, primitives: 2 });
    port.activate('match');
    w.loop.update(frameAt(1));
    expect([bridge.node('crate')!.visible, bridge.node('desk')!.visible]).toEqual([true, false]);
    expect(bridge.stats().primitives).toBe(1);
    port.disposePlace('match');
    expect(bridge.stats()).toMatchObject({ rows: 1, lights: 0 });
    expect(port.bounds(cw.row('desk'))).toBeUndefined();
    expect(port.socket('desk', 'sock_muzzle')).toBeNull();
  });

  it('dispose takes the stages, the scene port and the layer away', () => {
    const w = host();
    const feed = new TestFeed();
    w.attachFeed(feed);
    w.loop.update(frameAt(1));
    expect(feed.drains).toBe(1);
    w.installed.dispose();
    w.loop.update(frameAt(1));
    expect(feed.drains).toBe(1);
    expect(w.order).toEqual(['mixer']);
    expect(w.port()).toBeNull();
    expect(w.installed.viewmodel.anchor.parent).toBeNull();
  });
});
