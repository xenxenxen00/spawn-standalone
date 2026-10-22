// render-bridge.ts, camera-attached rows (docs/design/rendering.md §4.3, §16.2; docs/architecture.md X-36, §9.3 row R13): rows
// with `feetPosition: {attach: 'camera', x, y, depth, fov}` go to R8's viewmodel layer and are presented there every frame:
// prev / cur of the camera-space offset and the rotation by `alpha`, under this frame's camera. Node + three, no renderer; the
// viewmodel renderer, the camera presenter and the model instances are the real ones.
import { Euler, Group, Matrix4, Mesh, BoxGeometry, Scene, Vector3, WebGLCoordinateSystem } from 'three/webgpu';
import type { Object3D } from 'three/webgpu';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RowSnapshot } from '../../../src/compat/core/ports.ts';
import { eulerYXZToQuat } from '../../../src/compat/core/store/transform.ts';
import type { ObjectSpec, Quat, Vec3 } from '../../../src/compat/core/types.ts';
import type { BridgeModels, BridgeViewmodelContent } from '../../../src/render/bridge/bridge-types.ts';
import { createRenderBridge, type RenderBridgeControl } from '../../../src/render/bridge/render-bridge.ts';
import { ModelInstance } from '../../../src/render/models/model-instance.ts';
import { buildModelTemplate, modelSourceFromGltf, type ModelTemplate } from '../../../src/render/models/model-template.ts';
import { createViewmodelProjection, createViewmodelRenderer, registerViewmodelStage, type ViewmodelInterpMode, type ViewmodelRenderer } from '../../../src/render/models/viewmodel-renderer.ts';
import { createCameraPresenter, type CameraPresenterControl } from '../../../src/render/scene/camera-presenter.ts';
import { SurfaceVariant as V } from '../../../src/render/surface/surface-material.ts';
import { frameAt, matrixDiff, TestFeed } from './bridge-fakes.ts';
import { FIXTURE_FACTS, fixtureGlb, parseGlb, testEnv, type TestEnv } from './models/model-fixtures.ts';

const DEG = Math.PI / 180;

interface Pose {
  x: number;
  y: number;
  depth: number;
  fov?: number;
  yaw?: number;
  pitch?: number;
  roll?: number;
}

/** a camera-attached row as the store keeps it: the spec in `props.feetPosition`, the point (x, y, −depth) as its transform */
class CameraRow implements RowSnapshot {
  readonly id: string;
  readonly place = 'p1';
  parentId: string | null = null;
  readonly tags: readonly string[] = ['ss-vm'];
  readonly behavior: readonly string[] = [];
  readonly spec: Readonly<ObjectSpec> = {};
  props: Record<string, unknown>;
  prev: { pos: Vec3; rot: Quat };
  cur: { pos: Vec3; rot: Quat; scale: Vec3 };

  constructor(id: string, p: Pose, props: Record<string, unknown> = {}) {
    this.id = id;
    const pos = { x: p.x, y: p.y, z: -p.depth };
    const rot = eulerYXZToQuat(p.yaw ?? 0, p.pitch ?? 0, p.roll ?? 0);
    this.prev = { pos, rot };
    this.cur = { pos, rot, scale: { x: 1, y: 1, z: 1 } };
    this.props = { ...props, feetPosition: { attach: 'camera', x: p.x, y: p.y, depth: p.depth, ...(p.fov === undefined ? {} : { fov: p.fov }) } };
  }

  /** one tick: prev ← cur, then `viewmodel.js:564-567` writes the pose */
  tick(p: Pose): this {
    this.prev = { pos: this.cur.pos, rot: this.cur.rot };
    this.cur = { pos: { x: p.x, y: p.y, z: -p.depth }, rot: eulerYXZToQuat(p.yaw ?? 0, p.pitch ?? 0, p.roll ?? 0), scale: this.cur.scale };
    this.props = { ...this.props, feetPosition: { attach: 'camera', x: p.x, y: p.y, depth: p.depth, ...(p.fov === undefined ? {} : { fov: p.fov }) } };
    return this;
  }
}

interface Rig {
  env: TestEnv;
  scene: Scene;
  camera: CameraPresenterControl;
  vm: ViewmodelRenderer;
  bridge: RenderBridgeControl;
  feed: TestFeed;
  mode: { value: ViewmodelInterpMode };
  made: ModelInstance[];
  boxes: Mesh[];
  logs: string[];
  frame(alpha: number, paused?: boolean): void;
  look(yawDeg: number, eye?: Vec3): void;
}

let glb: Uint8Array;
beforeAll(async () => {
  glb = await fixtureGlb();
});

async function rig(opts: { mixerDrives?: boolean; loadDelay?: boolean } = {}): Promise<Rig> {
  const env = testEnv();
  const camera = createCameraPresenter({ coordinateSystem: () => WebGLCoordinateSystem });
  camera.setViewport(1280, 720);
  const mode = { value: 'alpha' as ViewmodelInterpMode };
  const projection = createViewmodelProjection();
  registerViewmodelStage(env.materials, projection);
  // `interp` is what `port.viewmodelInterp` says, read every frame
  const vm = createViewmodelRenderer({ camera, projection, coordinateSystem: () => WebGLCoordinateSystem, interp: () => mode.value, materials: env.materials });
  const template: ModelTemplate = buildModelTemplate(modelSourceFromGltf('value.00f1c5.glb', await parseGlb(glb), FIXTURE_FACTS), { ...env, variant: V.VIEWMODEL });
  const scene = new Scene();
  const world = new Group();
  scene.add(world, vm.anchor);
  const made: ModelInstance[] = [];
  const boxes: Mesh[] = [];
  const logs: string[] = [];
  let release: (() => void) | null = null;
  const models: BridgeModels = {
    create(row, o) {
      if (!o.viewmodel) throw new Error('a camera-attached row asked for a world model');
      const make = (): ModelInstance => {
        const i = new ModelInstance(template, env.look, { log: () => undefined });
        made.push(i);
        return i;
      };
      void row;
      if (opts.loadDelay !== true) return make();
      return new Promise((resolve) => {
        release = () => resolve(make());
      });
    },
  };
  const viewmodelContent: BridgeViewmodelContent = {
    create(row) {
      const p = row.props['primitive'] as { width: number; height: number; depth: number };
      const mesh = new Mesh(new BoxGeometry(p.width, p.height, p.depth), env.materials.get({ variant: V.SRC_PRIM | V.VIEWMODEL }));
      boxes.push(mesh);
      return mesh;
    },
  };
  const feed = new TestFeed();
  const bridge = createRenderBridge({
    world,
    camera,
    viewmodel: vm,
    viewmodelContent,
    models,
    mixer: { bind: () => opts.mixerDrives === true },
    log: (m) => logs.push(m),
  });
  bridge.attach(feed);
  const r: Rig = {
    env,
    scene,
    camera,
    vm,
    bridge,
    feed,
    mode,
    made,
    boxes,
    logs,
    frame: (alpha, paused = false) => bridge.update(frameAt(alpha, { paused, dt: paused ? 0 : 1 / 60 })),
    look: (yawDeg, eye = { x: 0, y: 1.6, z: 0 }) => camera.apply({ eye, yaw: yawDeg * DEG, pitch: 0, roll: 0, vfovDeg: 58.72 }),
  };
  (r as Rig & { release(): void }).release = () => release?.();
  r.look(0);
  return r;
}

const HIP: Pose = { x: 0.1, y: -0.2, depth: 0.5, fov: 55 };

describe('render bridge: camera-attached rows (X-36)', () => {
  it('presents the midpoint of the offset, the fov and the rotation at alpha 0.5, under the camera', async () => {
    const r = await rig();
    const gun = new CameraRow('gun', HIP, { primitive: { kind: 'box', width: 0.1, height: 0.1, depth: 0.4 } });
    r.feed.add(gun);
    r.frame(1);
    expect(r.vm.has('gun')).toBe(true);
    gun.tick({ x: 0.2, y: -0.1, depth: 0.6, fov: 50, yaw: 20 });
    r.frame(0.5);
    const o = r.vm.presented('gun')!;
    expect(o.x).toBeCloseTo(0.15, 12);
    expect(o.y).toBeCloseTo(-0.15, 12);
    expect(o.depth).toBeCloseTo(0.55, 12);
    expect(o.fov).toBeCloseTo(52.5, 12);
    // the rotation is halfway: 10° of yaw
    const half = eulerYXZToQuat(10, 0, 0);
    expect(Math.abs(o.rot.x * half.x + o.rot.y * half.y + o.rot.z * half.z + o.rot.w * half.w)).toBeCloseTo(1, 12);
    // and the drawn mesh carries the fov its projection is built for
    expect(r.boxes[0]!.userData['ssVmFov']).toBeCloseTo(52.5, 12);
    r.frame(0);
    expect(r.vm.presented('gun')!.x).toBeCloseTo(0.1, 12);
    r.frame(1);
    expect(r.vm.presented('gun')!.x).toBeCloseTo(0.2, 12);
    // it is no row of the world: the bridge composes nothing for it
    expect(r.bridge.stats().scanned).toBe(0);
  });

  it('follows this frame\'s camera: a turn between two updates at the same alpha moves the gun with it, with no frame of trail', async () => {
    const r = await rig();
    const gun = new CameraRow('gun', HIP, { primitive: { kind: 'box', width: 0.1, height: 0.1, depth: 0.4 } });
    r.feed.add(gun);
    r.frame(1);
    const root = r.vm.root('gun')!;
    const local = (): Matrix4 => new Matrix4().compose(root.position, root.quaternion, root.scale);
    for (const yaw of [0, 35, 90, -120]) {
      r.look(yaw, { x: 3, y: 1.6, z: -2 });
      r.frame(0.5);
      // before any render: the content's world matrix is the camera's of THIS frame × the row's camera-space matrix
      const want = r.camera.world.matrixWorld.clone().multiply(local());
      expect(matrixDiff(r.boxes[0]!.matrixWorld.elements, want.elements)).toBeLessThan(1e-12);
      const before = r.boxes[0]!.matrixWorld.clone();
      r.scene.updateMatrixWorld(true);
      expect(matrixDiff(r.boxes[0]!.matrixWorld.elements, before.elements)).toBeLessThan(1e-6);
    }
    // the gun stays 0.5 m in front of the eye whatever way the camera looks
    const at = new Vector3().setFromMatrixPosition(r.boxes[0]!.matrixWorld);
    expect(at.distanceTo(new Vector3(3, 1.6, -2))).toBeCloseTo(Math.hypot(0.1, 0.2, 0.5), 9);
  });

  it('snaps a jump above 0.25 m or 30°, and a new weapon row', async () => {
    const r = await rig();
    const gun = new CameraRow('gun', HIP, { primitive: { kind: 'box', width: 0.1, height: 0.1, depth: 0.4 } });
    r.feed.add(gun);
    r.frame(1);
    gun.tick({ ...HIP, x: 0.1 + 0.26 });
    r.frame(0.5);
    expect(r.vm.presented('gun')!.x).toBeCloseTo(0.36, 12);
    gun.tick({ ...HIP, x: 0.36, yaw: 31 });
    r.frame(0.5);
    expect(r.vm.presented('gun')!.rot).toEqual(eulerYXZToQuat(31, 0, 0));
    // under the limits it interpolates
    gun.tick({ ...HIP, x: 0.36 - 0.2, yaw: 31 - 29 });
    r.frame(0.5);
    expect(r.vm.presented('gun')!.x).toBeCloseTo(0.26, 12);
    // a change of weapon is a new row: it starts at its current value, whatever its prev holds
    const next = new CameraRow('gun2', HIP, { primitive: { kind: 'box', width: 0.1, height: 0.1, depth: 0.4 } });
    next.prev = { pos: { x: 5, y: 5, z: -5 }, rot: eulerYXZToQuat(170, 0, 0) };
    r.feed.remove('gun').add(next);
    r.frame(0.5);
    expect(r.vm.has('gun')).toBe(false);
    expect(r.vm.presented('gun2')!.x).toBeCloseTo(HIP.x, 12);
  });

  it('`port.viewmodelInterp = "step"` presents cur only; the default is "alpha"; the switch works at run time', async () => {
    const r = await rig();
    const gun = new CameraRow('gun', HIP, { primitive: { kind: 'box', width: 0.1, height: 0.1, depth: 0.4 } });
    r.feed.add(gun);
    r.frame(1);
    gun.tick({ ...HIP, x: 0.2 });
    r.frame(0.5);
    expect(r.vm.presented('gun')!.x).toBeCloseTo(0.15, 12);
    r.mode.value = 'step';
    r.frame(0.5);
    expect(r.vm.presented('gun')!.x).toBeCloseTo(0.2, 12);
    r.mode.value = 'alpha';
    r.frame(0.25);
    expect(r.vm.presented('gun')!.x).toBeCloseTo(0.125, 12);
  });

  it('a weapon model joins the layer when it has loaded; a body nothing animates is skinned under this frame\'s camera', async () => {
    const r = await rig({ loadDelay: true });
    const gun = new CameraRow('gun', HIP, { model: { id: 'value.00f1c5.glb' } });
    r.feed.add(gun);
    r.frame(1);
    expect(r.vm.has('gun')).toBe(false); // still loading: nothing to draw, nothing thrown
    (r as Rig & { release(): void }).release();
    await Promise.resolve();
    await Promise.resolve();
    expect(r.vm.has('gun')).toBe(true);
    const i = r.made[0]!;
    r.look(60, { x: 1, y: 1.6, z: 1 });
    r.frame(1);
    // the rest pose under the root's world matrix of this frame (R8 `pose: 'rest'`)
    const bone = i.boneList[0]!;
    const want = new Matrix4().fromArray(i.template.restBoneMatrices, 0).premultiply(i.root.matrixWorld);
    expect(matrixDiff(bone.matrixWorld.elements, want.elements)).toBeLessThan(1e-12);
    expect(new Vector3().setFromMatrixPosition(i.root.matrixWorld).distanceTo(new Vector3(1, 1.6, 1))).toBeLessThan(1.5);
    // a model write swaps the body; the removal of the row takes it out of the layer
    r.feed.remove('gun');
    r.frame(1);
    expect(r.vm.has('gun')).toBe(false);
    expect(i.disposed).toBe(true);
  });

  it('a weapon the mixer drives is added with `pose: "external"`: the bridge leaves its bones to the skin write that follows', async () => {
    const r = await rig({ mixerDrives: true });
    const gun = new CameraRow('gun', HIP, { model: { id: 'value.00f1c5.glb' } });
    r.feed.add(gun);
    r.frame(1);
    const i = r.made[0]!;
    const bone = i.boneList[0]!;
    bone.matrixWorld.makeTranslation(100, 100, 100); // what the mixer wrote
    r.look(45);
    r.frame(1);
    expect(bone.matrixWorld.elements[12]).toBe(100);
    // but the root it will multiply by is this frame's
    const root = r.vm.root('gun')!;
    expect(matrixDiff(root.matrixWorld.elements, r.camera.world.matrixWorld.clone().multiply(new Matrix4().compose(root.position, root.quaternion, root.scale)).elements)).toBeLessThan(1e-12);
  });

  it('a row parented to the gun (gun blood) hangs in the gun\'s frame with its own local transform, and hides with `visible`', async () => {
    const r = await rig();
    const gun = new CameraRow('gun', HIP, { primitive: { kind: 'box', width: 0.1, height: 0.1, depth: 0.4 } });
    const blood = new CameraRow('blood', { x: 0, y: 0, depth: 0 }, { primitive: { kind: 'box', width: 0.02, height: 0.02, depth: 0.001 } });
    // a child is an ordinary row in its parent's frame: local feet position and rotation
    blood.parentId = 'gun';
    blood.props = { primitive: blood.props['primitive'] };
    blood.cur = { pos: { x: 0.01, y: 0.05, z: -0.1 }, rot: eulerYXZToQuat(0, 90, 0), scale: { x: 1, y: 1, z: 1 } };
    blood.prev = { pos: blood.cur.pos, rot: blood.cur.rot };
    r.feed.add(blood, gun); // the child first: it waits for the gun
    r.frame(1);
    expect(r.vm.has('blood')).toBe(true);
    const holder = r.bridge.node('blood')!.object as Object3D;
    expect(holder.parent).toBe(r.vm.root('gun'));
    expect(holder.position.toArray()).toEqual([0.01, 0.05, -0.1]);
    expect(new Euler().setFromQuaternion(holder.quaternion, 'YXZ').x).toBeCloseTo(90 * DEG, 9);
    // it draws through the gun's projection
    r.frame(1);
    expect(r.boxes.find((b) => b.parent === holder)!.userData['ssVmFov']).toBe(55);
    blood.props = { ...blood.props, visible: false };
    r.feed.change(blood, 'visible');
    r.frame(1);
    expect(holder.visible).toBe(false);
    r.feed.remove('blood');
    r.frame(1);
    expect(r.vm.has('blood')).toBe(false);
    expect(holder.parent).toBeNull();
  });

  it('a row that leaves the camera frame becomes a world row, and back', async () => {
    const r = await rig();
    const gun = new CameraRow('gun', HIP, { primitive: { kind: 'box', width: 0.1, height: 0.1, depth: 0.4 } });
    r.feed.add(gun);
    r.frame(1);
    gun.props = { ...gun.props, feetPosition: { x: 4, y: 0, z: 2 } };
    gun.cur = { pos: { x: 4, y: 0, z: 2 }, rot: gun.cur.rot, scale: gun.cur.scale };
    gun.prev = { pos: gun.cur.pos, rot: gun.cur.rot };
    r.feed.change(gun, 'feetPosition');
    r.frame(1);
    expect(r.vm.has('gun')).toBe(false);
    expect(Array.from(r.bridge.node('gun')!.world).slice(12, 15)).toEqual([4, 0, 2]);
    gun.tick(HIP);
    r.feed.change(gun, 'feetPosition');
    r.frame(1);
    expect(r.vm.has('gun')).toBe(true);
  });

  it('with no viewmodel renderer a camera-attached row is reported once and nothing throws', () => {
    const logs: string[] = [];
    const camera = createCameraPresenter({ coordinateSystem: () => WebGLCoordinateSystem });
    const bridge = createRenderBridge({ world: new Group(), camera, log: (m) => logs.push(m) });
    const feed = new TestFeed();
    bridge.attach(feed);
    feed.add(new CameraRow('a', HIP), new CameraRow('b', HIP));
    expect(() => bridge.update(frameAt(1))).not.toThrow();
    expect(logs.filter((l) => l.includes('viewmodel'))).toHaveLength(1);
  });
});
