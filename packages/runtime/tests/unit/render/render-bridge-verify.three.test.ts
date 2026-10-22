// render-bridge.ts, the verifier's cases (WP R13): rows the engine moves with no feed event among many resting rows, `pivot`
// on a model row, and the visibility chain of what hangs on a hidden row. Node + three, no renderer; the table, the buckets
// and the model instances are the real ones.
import { Group, Vector3, WebGLCoordinateSystem } from 'three/webgpu';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RowSnapshot } from '../../../src/compat/core/ports.ts';
import type { BridgeModel, BridgeModels } from '../../../src/render/bridge/bridge-types.ts';
import { createRenderBridge } from '../../../src/render/bridge/render-bridge.ts';
import { ModelInstance } from '../../../src/render/models/model-instance.ts';
import { buildModelTemplate, modelSourceFromGltf, type ModelTemplate } from '../../../src/render/models/model-template.ts';
import { createCameraPresenter } from '../../../src/render/scene/camera-presenter.ts';
import { ctxWorld } from '../core/fakes/ctx-world.ts';
import { rig, TestRow } from './bridge-fakes.ts';
import { FIXTURE_FACTS, fixtureGlb, parseGlb, testEnv, type TestEnv } from './models/model-fixtures.ts';

const box = (over: Record<string, unknown> = {}): Record<string, unknown> => ({ primitive: { kind: 'box', size: 1 }, ...over });
const worldOf = (r: ReturnType<typeof rig>, id: string): ArrayLike<number> => r.bridge.node(id)!.world;

describe('render bridge: bodies the physics step moves (motion §5.3: the writeback sends no feed event)', () => {
  /** 400 rows at rest beside the row under test: lamps, props, markers */
  const crowd = (): TestRow[] => Array.from({ length: 400 }, (_, i) => new TestRow(`prop${i}`, { pos: [i, 0, 10], props: box() }));

  it('a character body (the player, a bot, an enemy: `physics: {body: "character"}`) is interpolated from the first tick it moves', () => {
    const r = rig();
    // `templates/player.js:22-29`
    const body = new TestRow('op', { pos: [0, 0, 0], props: { physics: { body: 'character', capsule: { height: 1.9, radius: 0.35 } }, ...box() } });
    r.spawn(...crowd(), body);
    // it stands for a while: every row is at rest
    for (let i = 0; i < 40; i++) r.frame(i % 2 === 0 ? 0.5 : 1);
    // the controller moves it in this tick; the store's `engineWriteTransform` records no change
    body.tick({ pos: [0.2, 0, 0] });
    r.frame(0.5);
    expect(worldOf(r, 'op')[12]).toBeCloseTo(0.1, 12);
    r.frame(1);
    expect(worldOf(r, 'op')[12]).toBeCloseTo(0.2, 12);
    body.tick({ pos: [0.4, 0, 0] });
    r.frame(0.25);
    expect(worldOf(r, 'op')[12]).toBeCloseTo(0.25, 12);
  });

  it('a torch on a character body follows the first tick the body turns in', () => {
    const r = rig();
    const body = new TestRow('op', { pos: [0, 0, 0], yaw: 0, props: { physics: { body: 'character' } } });
    const lamp = new TestRow('op-lamp', { parent: 'op', pos: [0, 1.35, -0.35], props: { light: { kind: 'spot', color: '#ffffff', intensity: 5, distance: 13, angle: 0.6, aim: 'forward' } } });
    r.spawn(...crowd(), body, lamp);
    for (let i = 0; i < 40; i++) r.frame(1);
    body.tick({ pos: [1, 0, 0] });
    r.frame(0.5);
    expect(worldOf(r, 'op-lamp')[12]).toBeCloseTo(0.5, 12);
  });
});

describe('render bridge: the real store\'s physics writeback', () => {
  it('`engineWriteTransform` on a character row reaches no sink, and the bridge still presents the step by alpha', async () => {
    const cw = await ctxWorld({ modules: {}, places: ['arena'] });
    const k = cw.k;
    const world = new Group();
    const camera = createCameraPresenter({ coordinateSystem: () => WebGLCoordinateSystem });
    camera.apply({ eye: { x: 0, y: 1.6, z: 6 }, yaw: 0, pitch: 0, roll: 0, vfovDeg: 58.72 });
    const bridge = createRenderBridge({ world, camera, log: () => undefined });
    bridge.attach(k.feed);
    let frameIndex = 0;
    const frame = (alpha: number): void => bridge.update({ now: frameIndex * 16, dt: 1 / 60, realDt: 1 / 60, alpha, frameIndex: frameIndex++, paused: false });
    // resting rows beside it, so the body is not found by the resting rows' slice in the frame it moves
    for (let i = 0; i < 300; i++) cw.spawn(`prop${i}`, { place: 'arena', feetPosition: { x: i, y: 0, z: 9 } });
    cw.spawn('op', { place: 'arena', feetPosition: { x: 0, y: 0, z: 0 }, physics: { body: 'character', capsule: { height: 1.9, radius: 0.35 } } });
    cw.ticks(2);
    for (let i = 0; i < 40; i++) frame(1);
    expect(bridge.node('op')!.world[12]).toBe(0);
    // one tick: the roll at its start, then the controller's writeback (body-sync.ts → store.engineWriteTransform)
    cw.ticks(1);
    k.store.engineWriteTransform(cw.row('op'), { x: 0.3, y: 0, z: 0 }, { x: 9, y: 0, z: 0 }, true);
    expect(k.feed.pending).toBe(0);
    frame(0.5);
    expect(bridge.node('op')!.world[12]).toBeCloseTo(0.15, 12);
    frame(1);
    expect(bridge.node('op')!.world[12]).toBeCloseTo(0.3, 12);
  });
});

describe('render bridge: `pivot` on a model row (render §16.1; contract §9.1)', () => {
  let env: TestEnv;
  let template: ModelTemplate;
  beforeAll(async () => {
    env = testEnv();
    template = buildModelTemplate(modelSourceFromGltf('value.00f1c5.glb', await parseGlb(await fixtureGlb()), FIXTURE_FACTS), env);
  });
  const modelRows = (made: ModelInstance[]): BridgeModels => ({
    create(row: RowSnapshot) {
      if (row.props['model'] === undefined) return null;
      const i = new ModelInstance(template, env.look, { log: () => undefined });
      made.push(i);
      return i;
    },
    size: (m: BridgeModel) => (m as ModelInstance).template.restBox.getSize(new Vector3()),
    box: (m: BridgeModel) => (m as ModelInstance).template.restBox,
  });
  /** where the middle of the model's rest box is drawn */
  const middle = (i: ModelInstance): Vector3 => {
    i.root.updateWorldMatrix(true, false);
    return i.template.restBox.getCenter(new Vector3()).applyMatrix4(i.root.matrixWorld);
  };

  it('a dropped gun (`scripts/director/wave.js:577`: a model with `pivot: "center"`, rolled 90°) lies about its middle: the box\'s centre is the row', () => {
    const made: ModelInstance[] = [];
    const r = rig({ models: modelRows(made) });
    // the fixture's box is not centred on its origin (x −arm … 0.78, z −0.12 … 0.1), as a gun's is not on its grip
    const c = template.restBox.getCenter(new Vector3());
    expect(Math.abs(c.x) + Math.abs(c.z)).toBeGreaterThan(0.005);
    const gun = new TestRow('pk', { pos: [3, 0.2, -4], yaw: 137, roll: 90, props: { model: { id: 'value.00f1c5.glb' }, pivot: 'center', castShadow: true } });
    const plain = new TestRow('plain', { pos: [3, 0.2, -4], yaw: 137, roll: 90, props: { model: { id: 'value.00f1c5.glb' } } });
    r.spawn(gun, plain);
    const [pk, feet] = made as [ModelInstance, ModelInstance];
    expect(middle(pk).distanceTo(new Vector3(3, 0.2, -4))).toBeLessThan(1e-6);
    // without a pivot the same row turns about its feet: its middle is half a body away
    expect(middle(feet).distanceTo(new Vector3(3, 0.2, -4))).toBeGreaterThan(0.5);
    expect(feet.root.position.length()).toBe(0);
    // the row's world box is around the row
    const b = r.bridge.bounds('pk')!;
    expect(b.min.y).toBeLessThan(0.2);
    expect(b.max.y).toBeGreaterThan(0.2);
    expect((b.min.x + b.max.x) / 2).toBeCloseTo(3, 5);
    expect((b.min.z + b.max.z) / 2).toBeCloseTo(-4, 5);
    expect(r.logs.filter((l) => l.includes('pivot'))).toEqual([]);
  });

  it('applies after `layout` and under the row\'s `scale`; a `pivot` write moves the model; `"feet"` and a dynamic body leave it standing', () => {
    const made: ModelInstance[] = [];
    const r = rig({ models: modelRows(made) });
    const fitted = new TestRow('fit', { pos: [1, 2, 3], yaw: 40, scale: 2, props: { model: { id: 'value.00f1c5.glb' }, layout: { maxExtents: { y: 0.9 } }, pivot: 'top' } });
    const feet = new TestRow('feet', { pos: [0, 0, 0], props: { model: { id: 'value.00f1c5.glb' }, pivot: 'feet' } });
    const gib = new TestRow('gib', { pos: [0, 5, 0], props: { model: { id: 'value.00f1c5.glb' }, pivot: 'center', physics: { body: 'dynamic' } } });
    r.spawn(fitted, feet, gib);
    const [a, b, c] = made as [ModelInstance, ModelInstance, ModelInstance];
    a.root.updateWorldMatrix(true, false);
    const box = template.restBox;
    const top = new Vector3((box.min.x + box.max.x) / 2, box.max.y, (box.min.z + box.max.z) / 2).applyMatrix4(a.root.matrixWorld);
    expect(top.distanceTo(new Vector3(1, 2, 3))).toBeLessThan(1e-6);
    // the model is 0.9 m tall by its layout, twice that by the row's scale: its bottom is 1.8 m below the row
    const bottom = new Vector3((box.min.x + box.max.x) / 2, box.min.y, (box.min.z + box.max.z) / 2).applyMatrix4(a.root.matrixWorld);
    expect(bottom.distanceTo(new Vector3(1, 0.2, 3))).toBeLessThan(1e-6);
    expect(b.root.position.length()).toBe(0);
    expect(c.root.position.length()).toBe(0);
    r.feed.change(feet.set('pivot', 'center'), 'pivot');
    r.frame();
    expect(middle(b).length()).toBeLessThan(1e-6);
    r.feed.change(feet.set('pivot', undefined), 'pivot');
    r.frame();
    expect(b.root.position.length()).toBe(0);
  });
});

describe('render bridge: the visibility chain', () => {
  it('a hidden body takes its torch and the torch\'s cones with it, and brings them back', () => {
    const r = rig();
    const body = new TestRow('op', { props: box() });
    const lamp = new TestRow('op-lamp', { parent: 'op', pos: [0, 1.35, -0.35], props: { light: { kind: 'spot', color: '#ffffff', intensity: 5, distance: 13, angle: 0.6, aim: 'forward' } } });
    const cone = new TestRow('op-cone', { parent: 'op-lamp', pitch: -90, props: { primitive: { kind: 'cylinder', radiusTop: 1, radiusBottom: 0.04, height: 7, openEnded: true } } });
    r.spawn(body, lamp, cone);
    expect(r.instances()).toBe(2);
    r.lights.upload(r.camera.world);
    const [h] = r.lights.dynamicHandles();
    expect(r.lights.intensity(h!)).toBe(5);
    r.feed.change(body.set('visible', false), 'visible');
    r.frame();
    expect(r.instances()).toBe(0);
    expect(r.lights.size).toBe(1); // dark, never removed
    expect(r.lights.intensity(h!)).toBe(0);
    r.feed.change(body.set('visible', true), 'visible');
    r.frame();
    expect(r.instances()).toBe(2);
    expect(r.lights.intensity(h!)).toBe(5);
  });
});
