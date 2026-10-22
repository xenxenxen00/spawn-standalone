// K3 on the render bridge and the kernel seam: with `rigs`, an animating scripted row of a rigged key is a single skinned row
// of the map host and is bound to the motion presenter on its skeleton (the presenter sets the script's one rig on the row's
// RigMixer); without `rigs` the same rows stay on PP's path. H3's motion-side call (`installBoneChannels`) on a fake kernel.
import { Group, Matrix4, PerspectiveCamera, Scene, WebGLCoordinateSystem } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import type { PropChannel, RowRec } from '../../src/compat/core/types.ts';
import { ClipRegistry } from '../../src/compat/motion/clip-registry.ts';
import { createMotion } from '../../src/compat/motion/scheduler-hooks.ts';
import { threeSkin } from '../../src/compat/motion/three-skin.ts';
import { createMapHost } from '../../src/render/bridge/attach.ts';
import { createRenderBridge } from '../../src/render/bridge/render-bridge.ts';
import { GeometryServiceImpl } from '../../src/render/geometry/geometry-service.ts';
import { createInProcessExecutor, type ModuleLoader } from '../../src/render/geometry/geometry-worker.ts';
import { createLightTable } from '../../src/render/lighting/light-table.ts';
import { TIER_TABLE } from '../../src/render/perf/budget.ts';
import { createCameraPresenter } from '../../src/render/scene/camera-presenter.ts';
import { MapPaint, registerPackedSurface } from '../../src/render/surface/paint-table.ts';
import type { LightingScript } from '../../src/render/surface/script-types.ts';
import { SurfaceMaterials } from '../../src/render/surface/surface-material.ts';
import { createRigMixer, installBoneChannels, RigMixer, ScriptRigs } from '../../src/render/rig/index.ts';
import { frameAt, TestFeed, TestRow } from '../../tests/unit/render/bridge-fakes.ts';
import { BEAN } from './bean.ts';
import { RUN } from './fixtures.ts';

const load: ModuleLoader = async (s) => {
  if (s === 'scripts/gen/bean.js') return BEAN;
  throw new Error(`unknown ${s}`);
};
const script: LightingScript = { lighting: (_s, l) => l.ambient };

function world(rigs: boolean) {
  const root = new Group();
  const scene = new Scene();
  scene.add(root);
  const camera = createCameraPresenter({ coordinateSystem: () => WebGLCoordinateSystem });
  camera.apply({ eye: { x: 0, y: 1.6, z: 6 }, yaw: 0, pitch: 0, roll: 0, vfovDeg: 58.72 });
  const materials = new SurfaceMaterials({ script });
  const packed = registerPackedSurface(materials, new MapPaint({ paints: 16, entries: 16 }));
  const rows = new Map<string, RowRec>();
  const motion = createMotion({ registry: new ClipRegistry(), createMixer: createRigMixer, rows });
  const presenter = motion.presenter({ skin: threeSkin });
  const scriptRigs = new ScriptRigs();
  const host = createMapHost({
    renderer: () => ({ compileAsync: async () => undefined, copyTextureToTexture: () => undefined, backend: {} }),
    geometry: new GeometryServiceImpl({ executor: createInProcessExecutor(load, { strict: true, rigs: true }) }),
    materials,
    packed,
    tier: () => TIER_TABLE.high,
    camera: new PerspectiveCamera(),
    scene,
    paint: { paints: 4096, entries: 65536 },
    yieldFrame: async () => undefined,
    far: false,
    log: () => undefined,
    ...(rigs ? { rigs: scriptRigs, rigMixer: { bind: (i: unknown, o?: { rowId?: string }) => presenter.bind(i, o) } } : {}),
  });
  const feed = new TestFeed();
  const bridge = createRenderBridge({ world: root, camera, lights: createLightTable(), map: host, ...(rigs ? { rigs: true } : {}), log: () => undefined });
  bridge.attach(feed);
  return { bridge, feed, host, motion, presenter, rows, scriptRigs };
}

const beanRow = (id: string, x: number): TestRow =>
  new TestRow(id, { place: 'board', pos: [x, 0, 0], props: { primitive: { kind: 'scripted', script: 'scripts/gen/bean.js', params: { hue: x } }, mixer: { gait: { clip: 'run', loop: 'loop' } } } });

describe('K3 on the render bridge', () => {
  it.each([true, false])('bone attachments follow scripted row rigs only with rigs enabled (%s)', async (rigs) => {
    const w = world(rigs);
    const parent = beanRow('parent', 2).write({ pos: [2, 10, -4], scale: 1.35 });
    const hat = new TestRow('hat', { place: 'board', parent: parent.id, pos: [0, 0.98, 0], scale: 1.6, props: { attachment: { bone: 'body' } } });
    const missing = new TestRow('missing', { place: 'board', parent: parent.id, pos: [0, 0.98, 0], props: { attachment: { bone: 'unknown' } } });
    w.rows.set(parent.id, { id: parent.id, serial: 1, parentId: null, phase: 'alive', place: 'board', props: {} } as unknown as RowRec);
    await w.bridge.loadStaticPlace([parent], () => undefined);
    const rowBone = vi.spyOn(w.bridge.mapOf('board')!, 'rowBone');
    w.feed.add(parent, hat, missing);
    w.bridge.update(frameAt(0));
    const rig = w.host.batcher('board')!.rowRig(parent.id);
    if (rigs) w.motion.anim.get(parent.id)!.write('gait', { clip: RUN, loop: 'loop', blendIn: 0 }, 0);
    const positions: number[] = [];
    for (let i = 0; i < 2; i++) {
      w.motion.advanceTick(0.085);
      w.bridge.update(frameAt(0));
      w.presenter.update({ alpha: 0, dt: 0.085, frameIndex: i, paused: false });
      w.bridge.afterPose(frameAt(0));
      const parentWorld = new Matrix4().fromArray(w.bridge.node(parent.id)!.world);
      const bone = rig?.bones[rig.rig.index('body')];
      const expected = (bone?.matrixWorld ?? parentWorld).clone().multiply(new Matrix4().makeTranslation(0, 0.98, 0)).multiply(new Matrix4().makeScale(1.6, 1.6, 1.6));
      const actual = w.bridge.node(hat.id)!.world;
      Array.from(actual).forEach((n, j) => expect(n, `frame ${i}, matrix component ${j}`).toBeCloseTo(expected.elements[j]!, 5));
      positions.push(actual[13]!);
      const fallback = parentWorld.clone().multiply(new Matrix4().makeTranslation(0, 0.98, 0));
      Array.from(w.bridge.node(missing.id)!.world).forEach((n, j) => expect(n).toBeCloseTo(fallback.elements[j]!, 5));
    }
    if (rigs) {
      expect(Math.abs(positions[1]! - positions[0]!)).toBeGreaterThan(0.01);
      expect(rowBone).toHaveBeenCalled();
    } else {
      expect(positions[1]).toBe(positions[0]);
      expect(rowBone).not.toHaveBeenCalled();
    }
  });

  it('with rigs: six animating beans are skinned single rows bound to the presenter, one rig for the script', async () => {
    const w = world(true);
    const rows = [0, 1, 2, 3, 4, 5].map((i) => beanRow(`p${i}`, i * 2));
    for (const r of rows) w.rows.set(r.id, { id: r.id, serial: 1, parentId: null, phase: 'alive', place: 'board', props: {} } as unknown as RowRec);
    await w.bridge.loadStaticPlace(rows, () => undefined);
    w.feed.add(...rows);
    w.bridge.update(frameAt(1));
    const map = w.host.batcher('board')!;
    for (const r of rows) {
      expect(map.classOf(r.id)).toBe('single');
      expect(map.rowRig(r.id)).not.toBeNull();
      const mixer = w.motion.anim.get(r.id)!;
      expect(mixer).toBeInstanceOf(RigMixer);
      expect(mixer.rig).toBe(w.scriptRigs.get('scripts/gen/bean.js'));
    }
    expect(w.presenter.size).toBe(6);
    expect(w.scriptRigs.size).toBe(1);
    // a clip poses them through the presenter
    w.motion.anim.get('p0')!.write('gait', { clip: RUN, loop: 'loop', blendIn: 0 }, 0);
    w.motion.advanceTick(0.17);
    w.presenter.update({ alpha: 0, dt: 1 / 60, frameIndex: 0, paused: false });
    expect(w.presenter.stats.bonesWritten).toBeGreaterThan(0);
  });

  it('without rigs (PP): the same rows are batched static meshes and nothing is bound', async () => {
    const w = world(false);
    const rows = [0, 1, 2, 3, 4, 5].map((i) => beanRow(`p${i}`, i * 2));
    await w.bridge.loadStaticPlace(rows, () => undefined);
    w.feed.add(...rows);
    w.bridge.update(frameAt(1));
    const map = w.host.batcher('board')!;
    for (const r of rows) {
      expect(map.classOf(r.id)).not.toBe('single');
      expect(map.rowRig(r.id)).toBeNull();
    }
    expect(w.presenter.size).toBe(0);
  });
});

describe('H3: installBoneChannels', () => {
  it('registers the bones channel and adopts spawn-time bones specs', () => {
    const registered: PropChannel[] = [];
    const spawned: Array<(row: RowRec) => void> = [];
    const kernel = {
      store: { channels: { register: (ch: PropChannel) => (registered.push(ch), () => registered.splice(registered.indexOf(ch), 1)) } },
      on: (_e: string, fn: (row: RowRec) => void) => (spawned.push(fn), () => spawned.splice(spawned.indexOf(fn), 1)),
    };
    const mixers = new Map<string, RigMixer>();
    const host = { ensure: (row: RowRec) => mixers.get(row.id) ?? (mixers.set(row.id, new RigMixer(row.id, null)), mixers.get(row.id)!) };
    const off = installBoneChannels(host, kernel as never);
    expect(registered.map((c) => c.field)).toEqual(['bones']);
    const row = { id: 'b', phase: 'alive', props: { bones: { armR: { pitch: 30 } } } } as unknown as RowRec;
    spawned[0]!(row);
    expect(mixers.get('b')!.boneChannels().get('armR')).toEqual({ pitch: 30, yaw: 0, roll: 0, y: 0 });
    row.props['bones'] = { legL: { y: 0.1 } };
    registered[0]!.onWrite!(row, row.props['bones'], undefined, []);
    expect([...mixers.get('b')!.boneChannels().keys()]).toEqual(['legL']);
    off();
    expect(registered).toHaveLength(0);
    expect(spawned).toHaveLength(0);
  });
});
