// WP R8 (docs/architecture.md §9.3 R8; render §4.3, §11.7, §16.3): the viewmodel renderer on three's scene graph, no renderer.
//   - "on a camera turn the skinned gun is drawn at this frame's camera pose (no one-frame trail)": the root, the bones and
//     the skin matrices are final after `update()`, without `scene.updateMatrixWorld()` / `render()`
//   - the VIEWMODEL stage (`vertexNode`), the per-object projection (fov, aspect, coordinate system)
//   - mesh state: first among opaques, never culled, no shadows, layer 0; hidden weapons; removal and disposal
//   - gun-blood planes: children of the viewmodel row, drawn through the VIEWMODEL variant
import { Euler, Matrix4, Mesh, Quaternion, Scene, Vector3, Vector4, WebGLCoordinateSystem, WebGPUCoordinateSystem } from 'three/webgpu';
import type { CoordinateSystem, Material, Object3D, SkinnedMesh, Texture } from 'three/webgpu';
import { beforeAll, describe, expect, it } from 'vitest';
import { eulerYXZToQuat } from '../../../../src/compat/core/store/transform.ts';
import type { Quat, Vec3 } from '../../../../src/compat/core/types.ts';
import type { FrameInfo } from '../../../../src/render/engine/render-loop.ts';
import { ModelInstance } from '../../../../src/render/models/model-instance.ts';
import { buildModelTemplate, modelSourceFromGltf, type ModelTemplate } from '../../../../src/render/models/model-template.ts';
import {
  VIEWMODEL_FOV_KEY,
  VIEWMODEL_TRANSPARENT_RENDER_ORDER,
  cameraAttachedMatrix,
  createViewmodelProjection,
  createViewmodelRenderer,
  registerViewmodelStage,
  setViewmodelFov,
  type ViewmodelInterpMode,
  type ViewmodelProjection,
  type ViewmodelRenderer,
  type ViewmodelRowSource,
} from '../../../../src/render/models/viewmodel-renderer.ts';
import {
  CAMERA_FAR,
  CAMERA_NEAR,
  VIEWMODEL_DEPTH_RANGE,
  VIEWMODEL_FAR,
  VIEWMODEL_NEAR,
  createCameraPresenter,
  viewmodelProjectionMatrix,
  vmRemapZ,
  windowDepth,
  type CameraPresenterControl,
} from '../../../../src/render/scene/camera-presenter.ts';
import { LAYER_WORLD, VIEWMODEL_RENDER_ORDER } from '../../../../src/render/scene/scene-root.ts';
import { whitePixel } from '../../../../src/render/surface/look-table.ts';
import type { StandardMaterialSpec } from '../../../../src/render/surface/material-spec.ts';
import { SurfaceVariant as V, surfacePaintOf, type AnySurfaceMaterial } from '../../../../src/render/surface/surface-material.ts';
import { FIXTURE_FACTS, fixtureGlb, parseGlb, testEnv, type TestEnv } from './model-fixtures.ts';

const DEG = Math.PI / 180;

/** a camera-attached row as the feed's snapshot shows it: the camera-space point (x, y, −depth) and the row's rotation */
class FakeRow implements ViewmodelRowSource {
  readonly id: string;
  props: Record<string, unknown>;
  prev: { pos: Vec3; rot: Quat };
  cur: { pos: Vec3; rot: Quat; scale: Vec3 };

  constructor(id: string, x: number, y: number, depth: number, yaw = 0, pitch = 0, roll = 0, fov: number | undefined = 55) {
    this.id = id;
    this.props = { feetPosition: { attach: 'camera', x, y, depth, ...(fov === undefined ? {} : { fov }) }, visible: true };
    const pos = { x, y, z: -depth };
    const rot = eulerYXZToQuat(yaw, pitch, roll);
    this.prev = { pos, rot };
    this.cur = { pos, rot, scale: { x: 1, y: 1, z: 1 } };
  }

  /** one tick: prev ← cur, then the game's write */
  tick(x: number, y: number, depth: number, yaw = 0, pitch = 0, roll = 0, fov = 55): void {
    this.prev = { pos: this.cur.pos, rot: this.cur.rot };
    this.props = { ...this.props, feetPosition: { attach: 'camera', x, y, depth, fov } };
    this.cur = { pos: { x, y, z: -depth }, rot: eulerYXZToQuat(yaw, pitch, roll), scale: this.cur.scale };
  }
}

let frameIndex = 0;
const frame = (alpha: number, paused = false): FrameInfo => ({ now: frameIndex * 16, dt: paused ? 0 : 1 / 60, realDt: 1 / 60, alpha, frameIndex: frameIndex++, paused });

interface Rig {
  env: TestEnv;
  scene: Scene;
  camera: CameraPresenterControl;
  projection: ViewmodelProjection;
  vm: ViewmodelRenderer;
  cs: { value: CoordinateSystem };
  mode: { value: ViewmodelInterpMode };
}

function rig(): Rig {
  const env = testEnv();
  const cs = { value: WebGLCoordinateSystem as CoordinateSystem };
  const mode = { value: 'alpha' as ViewmodelInterpMode };
  const camera = createCameraPresenter({ coordinateSystem: () => cs.value });
  camera.setViewport(1280, 720);
  const projection = createViewmodelProjection();
  registerViewmodelStage(env.materials, projection);
  const vm = createViewmodelRenderer({ camera, projection, coordinateSystem: () => cs.value, interp: () => mode.value, materials: env.materials });
  const scene = new Scene();
  scene.add(vm.anchor);
  return { env, scene, camera, projection, vm, cs, mode };
}

let glb: Uint8Array;
beforeAll(async () => {
  glb = await fixtureGlb();
});

async function template(env: TestEnv, name = 'value.00f1c5.glb'): Promise<ModelTemplate> {
  return buildModelTemplate(modelSourceFromGltf(name, await parseGlb(glb), FIXTURE_FACTS), { ...env, variant: V.VIEWMODEL });
}

const meshesOf = (o: Object3D): Mesh[] => {
  const out: Mesh[] = [];
  o.traverse((c) => {
    if ((c as Mesh).isMesh === true) out.push(c as Mesh);
  });
  return out;
};

/** the camera's world matrix of a pose, built without the presenter */
function cameraWorld(eye: Vec3, yaw: number, pitch: number, roll = 0): Matrix4 {
  const q = new Quaternion().setFromEuler(new Euler(pitch, yaw, roll, 'YXZ'));
  return new Matrix4().compose(new Vector3(eye.x, eye.y, eye.z), q, new Vector3(1, 1, 1));
}

/**
 * The camera-frame matrix of a camera-attached row, written out independently of the module: the grip (the model's glTF
 * origin, `lift` above the bottom of its box) at (x, y + lift, −depth), turned by Ry(yaw) · Rx(−pitch) · Rz(−roll).
 */
function attached(x: number, y: number, depth: number, yawDeg: number, pitchDeg: number, rollDeg: number, lift: number): Matrix4 {
  const r = new Matrix4().makeRotationFromEuler(new Euler(-pitchDeg * DEG, yawDeg * DEG, -rollDeg * DEG, 'YXZ'));
  return new Matrix4().makeTranslation(x, y + lift, -depth).multiply(r).multiply(new Matrix4().makeTranslation(0, -lift, 0));
}

function expectMatrix(got: Matrix4, want: Matrix4, eps = 1e-9): void {
  for (let i = 0; i < 16; i++) expect(Math.abs(got.elements[i]! - want.elements[i]!), `element ${i}: ${got.elements[i]} vs ${want.elements[i]}`).toBeLessThan(eps);
}

/** a vertex of the skinned mesh in world space, the way the GPU skins it (bone matrices of `skeleton.update()`) */
function skinnedWorld(instance: ModelInstance, vertex: number): Vector3 {
  const skeleton = instance.skeleton!;
  skeleton.update();
  const { position, skinIndex, skinWeight } = instance.template.arrays;
  const out = new Vector3();
  const m = new Matrix4();
  const p = new Vector3();
  for (let k = 0; k < 4; k++) {
    const w = skinWeight![vertex * 4 + k]!;
    if (w === 0) continue;
    out.addScaledVector(p.fromArray(position, vertex * 3).applyMatrix4(m.fromArray(skeleton.boneMatrices as ArrayLike<number>, skinIndex![vertex * 4 + k]! * 16)), w);
  }
  return out;
}

describe('the viewmodel follows this frame’s camera (render §16.3: no one-frame trail)', () => {
  it('the row root sits at (x, y, −depth) in the camera frame of the pose pushed this frame', async () => {
    const r = rig();
    const instance = new ModelInstance(await template(r.env), r.env.look);
    const row = new FakeRow('vm', 0.22, -0.3915, 0.5, 4, -8);
    r.vm.add(row, instance);
    const eyeA = { x: 3, y: 1.6, z: -2 };
    r.camera.apply({ eye: eyeA, yaw: 0.3, pitch: -0.1, roll: 0, vfovDeg: 58.72 });
    r.vm.update(frame(1));
    // the fixture's file has its feet 0.25 m above the glTF origin: the normalisation's lift is −0.25
    const lift = instance.template.rigMatrix.elements[13]!;
    expect(lift).toBeCloseTo(-0.25, 6);
    expectMatrix(instance.root.matrixWorld, cameraWorld(eyeA, 0.3, -0.1).multiply(attached(0.22, -0.3915, 0.5, 4, -8, 0, lift)));
    expectMatrix(cameraAttachedMatrix({ x: 0.22, y: -0.3915, depth: 0.5, fov: 55, rot: eulerYXZToQuat(4, -8, 0) }, undefined, new Matrix4(), lift), attached(0.22, -0.3915, 0.5, 4, -8, 0, lift), 1e-12);
    // the grip (the model's glTF origin, `lift` above the root) is at (x, y + lift, −depth) in the camera frame, whatever the turn
    const grip = new Vector3(0, lift, 0).applyMatrix4(instance.root.matrixWorld);
    expect(grip.distanceTo(new Vector3(0.22, -0.3915 + lift, -0.5).applyMatrix4(cameraWorld(eyeA, 0.3, -0.1)))).toBeLessThan(1e-12);
  });

  it('after a 30° turn and a step of the eye, root, bones and skin are at the new pose before any scene update', async () => {
    const r = rig();
    const instance = new ModelInstance(await template(r.env), r.env.look);
    expect(instance.bonePath).toBe('direct');
    const row = new FakeRow('vm', 0.22, -0.3915, 0.5, 4, -8);
    r.vm.add(row, instance);
    const vertex = 40;

    const eyeA = { x: 3, y: 1.6, z: -2 };
    r.camera.apply({ eye: eyeA, yaw: 0.3, pitch: -0.1, roll: 0, vfovDeg: 58.72 });
    r.vm.update(frame(1));
    const inCameraA = skinnedWorld(instance, vertex).applyMatrix4(cameraWorld(eyeA, 0.3, -0.1).invert());
    const boneA = instance.boneList[2]!.matrixWorld.clone();

    // the next frame: the mouse turned the view 30° and the body moved; nothing calls scene.updateMatrixWorld() or render()
    const eyeB = { x: 3.4, y: 1.55, z: -2.3 };
    const yawB = 0.3 + 30 * DEG;
    r.camera.apply({ eye: eyeB, yaw: yawB, pitch: 0.2, roll: 0.05, vfovDeg: 58.72 });
    r.vm.update(frame(1));
    const camB = cameraWorld(eyeB, yawB, 0.2, 0.05);
    expectMatrix(instance.root.matrixWorld, camB.clone().multiply(attached(0.22, -0.3915, 0.5, 4, -8, 0, instance.template.rigMatrix.elements[13]!)));
    // the bones were written under the new root: bone = root world × rest (the direct path), not last frame's
    const rest = new Matrix4().fromArray(instance.template.restBoneMatrices, 2 * 16);
    expectMatrix(instance.boneList[2]!.matrixWorld, instance.root.matrixWorld.clone().multiply(rest));
    expect(instance.boneList[2]!.matrixWorld.equals(boneA)).toBe(false);
    // and the skinned vertex has not moved in the camera frame: the gun is rigid in the view through the turn
    const inCameraB = skinnedWorld(instance, vertex).applyMatrix4(camB.clone().invert());
    // (three keeps bone matrices as float32: 1e-7 m)
    expect(inCameraB.distanceTo(inCameraA)).toBeLessThan(1e-6);
    expect(inCameraA.length()).toBeGreaterThan(0.3);

    // three's own update inside render() changes nothing
    const before = instance.root.matrixWorld.clone();
    const boneBefore = instance.boneList[2]!.matrixWorld.clone();
    r.scene.updateMatrixWorld();
    expectMatrix(instance.root.matrixWorld, before, 1e-15);
    expectMatrix(instance.boneList[2]!.matrixWorld, boneBefore, 1e-15);
  });

  it('a pose writer runs after the root is final and sees this frame’s root (the mixer adapter’s place)', async () => {
    const r = rig();
    const instance = new ModelInstance(await template(r.env), r.env.look);
    const row = new FakeRow('vm', 0.1, -0.2, 0.6);
    const seen: Matrix4[] = [];
    // glTF model-space matrices of a pose: every bone lifted 5 cm
    const t = instance.template;
    const inv = t.rigMatrix.clone().invert();
    const model = new Float32Array(t.boneCount * 16);
    const lifted = new Matrix4();
    for (let b = 0; b < t.boneCount; b++) lifted.fromArray(t.restBoneMatrices, b * 16).premultiply(inv).premultiply(new Matrix4().makeTranslation(0, 0.05, 0)).toArray(model, b * 16);
    r.vm.add(row, instance, {
      pose: (i) => {
        seen.push(i.root.matrixWorld.clone());
        i.writeBonesFromModel(model);
      },
    });
    for (const yaw of [0, 0.5, 1.2]) {
      r.camera.apply({ eye: { x: yaw, y: 1.6, z: 0 }, yaw, pitch: 0, roll: 0, vfovDeg: 58.72 });
      r.vm.update(frame(1));
      const want = cameraWorld({ x: yaw, y: 1.6, z: 0 }, yaw, 0).multiply(new Matrix4().makeTranslation(0.1, -0.2, -0.6));
      expectMatrix(seen.at(-1)!, want);
      // the bone the writer produced is under this frame's root
      const bone = new Matrix4().fromArray(model, 0).premultiply(t.rigMatrix).premultiply(want);
      expectMatrix(instance.boneList[0]!.matrixWorld, bone);
    }
    expect(seen).toHaveLength(3);
  });

  it("'external' leaves the bones to the animation domain: the root is final when update() returns", async () => {
    const r = rig();
    const instance = new ModelInstance(await template(r.env), r.env.look);
    r.vm.add(new FakeRow('vm', 0.1, -0.2, 0.6), instance, { pose: 'external' });
    r.camera.apply({ eye: { x: 0, y: 1.6, z: 0 }, yaw: 0, pitch: 0, roll: 0, vfovDeg: 58.72 });
    r.vm.update(frame(1));
    const bone = instance.boneList[0]!.matrixWorld.clone();
    r.camera.apply({ eye: { x: 5, y: 1.6, z: 0 }, yaw: 1, pitch: 0, roll: 0, vfovDeg: 58.72 });
    r.vm.update(frame(1));
    expect(instance.boneList[0]!.matrixWorld.equals(bone)).toBe(true); // not ours to write
    expectMatrix(instance.root.matrixWorld, cameraWorld({ x: 5, y: 1.6, z: 0 }, 1, 0).multiply(new Matrix4().makeTranslation(0.1, -0.2, -0.6)));
    // what three-skin.ts does next (root world × rig × model) lands on this frame's root
    instance.writeRestPose();
    expectMatrix(instance.boneList[0]!.matrixWorld, instance.root.matrixWorld.clone().multiply(new Matrix4().fromArray(instance.template.restBoneMatrices, 0)));
  });

  it('interpolates the offset by alpha under the per-frame camera, steps with the flag, and holds while paused', async () => {
    const r = rig();
    const instance = new ModelInstance(await template(r.env), r.env.look);
    const row = new FakeRow('vm', 0.2, -0.39, 0.5);
    r.vm.add(row, instance);
    r.camera.apply({ eye: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, roll: 0, vfovDeg: 58.72 });
    r.vm.update(frame(0.2));
    row.tick(0.21, -0.38, 0.48, 6, 0);
    const x = (): number => instance.root.matrixWorld.elements[12]!;
    r.vm.update(frame(0.25));
    expect(x()).toBeCloseTo(0.2025, 12);
    expect(r.vm.presented('vm')!.depth).toBeCloseTo(0.495, 12);
    // the camera moves between ticks: the offset keeps interpolating under it
    r.camera.apply({ eye: { x: 10, y: 0, z: 0 }, yaw: 0, pitch: 0, roll: 0, vfovDeg: 58.72 });
    r.vm.update(frame(0.75));
    expect(x()).toBeCloseTo(10.2075, 12);
    // a paused frame presents the same value whatever alpha the loop reports
    r.vm.update(frame(0.1, true));
    expect(x()).toBeCloseTo(10.2075, 12);
    r.vm.update(frame(0.9, true));
    expect(x()).toBeCloseTo(10.2075, 12);
    // the flag is read every frame
    r.mode.value = 'step';
    r.vm.update(frame(0.3));
    expect(x()).toBeCloseTo(10.21, 12);
    r.mode.value = 'alpha';
    r.vm.update(frame(0.5));
    expect(x()).toBeCloseTo(10.205, 12);
  });

  it('applies the row scale and follows a row whose parent group is not at the origin', async () => {
    const r = rig();
    r.scene.remove(r.vm.anchor);
    const world = new Mesh();
    world.position.set(7, 3, -4);
    world.rotation.y = 1;
    r.scene.add(world);
    world.add(r.vm.anchor);
    const instance = new ModelInstance(await template(r.env), r.env.look);
    const row = new FakeRow('vm', 0.2, -0.3, 0.6);
    row.cur.scale = { x: 0.92, y: 0.92, z: 0.92 };
    r.vm.add(row, instance);
    r.camera.apply({ eye: { x: 1, y: 2, z: 3 }, yaw: 0.4, pitch: 0, roll: 0, vfovDeg: 58.72 });
    r.vm.update(frame(1));
    const want = cameraWorld({ x: 1, y: 2, z: 3 }, 0.4, 0).multiply(new Matrix4().compose(new Vector3(0.2, -0.3, -0.6), new Quaternion(), new Vector3(0.92, 0.92, 0.92)));
    expectMatrix(instance.root.matrixWorld, want);
    r.scene.updateMatrixWorld(true);
    expectMatrix(instance.root.matrixWorld, want);
  });
});

describe('the VIEWMODEL stage and its projection (render §4.3)', () => {
  it('gives every VIEWMODEL variant its own projection and leaves the other variants on three’s', () => {
    const r = rig();
    const gun = r.env.materials.get({ variant: V.SRC_GLTF | V.SLOTS | V.PARTMASK | V.VIEWMODEL });
    expect((gun.clipNode as unknown as { isNode?: boolean } | null)?.isNode).toBe(true);
    expect(gun.setupModelViewProjection()).toBe(gun.clipNode);
    const world = r.env.materials.get({ variant: V.SRC_GLTF | V.SLOTS | V.PARTMASK });
    expect(world.clipNode).toBeNull();
    expect(world.setupModelViewProjection()).not.toBe(gun.clipNode);
    const blood = r.env.materials.get({ variant: V.SRC_PRIM | V.TEX_ALBEDO | V.TRANSPARENT | V.VIEWMODEL, textures: { albedo: whitePixel() } });
    expect(blood.clipNode).not.toBeNull();
    // Not `vertexNode`: with one, three r186 rebuilds the fragment's view position from the clip position with the camera's
    // inverse projection (nodes/accessors/Position.js), and the gun would be lit and fogged 10 to 13 cm from the eye
    expect([gun.vertexNode, blood.vertexNode]).toEqual([null, null]);
    // nor the local-space position: skinning and normals stay three's
    expect(blood.positionNode).toBeNull();
    // the unlit fallback (no lighting script) projects the same way
    const unlit = r.env.materials.get({ variant: V.SRC_PRIM | V.UNLIT | V.VIEWMODEL });
    expect(unlit.setupModelViewProjection()).toBe(unlit.clipNode);
  });

  it.each([
    ['WebGL', WebGLCoordinateSystem],
    ['WebGPU', WebGPUCoordinateSystem],
  ] as const)('%s: the matrix the shader multiplies by is vmRemap ∘ the projection: same x, y and w, window depth in [0, 0.25]', (_n, cs) => {
    const p = createViewmodelProjection();
    p.sync(21 / 9, cs);
    for (const point of [new Vector4(0.22, -0.27, -0.5, 1), new Vector4(-0.4, 0.1, -0.1, 1), new Vector4(0.9, 0.6, -10, 1), new Vector4(0, 0, -0.35, 1)]) {
      const plain = point.clone().applyMatrix4(p.matrixFor(55));
      const clip = point.clone().applyMatrix4(p.clipMatrixFor(55));
      expect(clip.x).toBeCloseTo(plain.x, 12);
      expect(clip.y).toBeCloseTo(plain.y, 12);
      expect(clip.w).toBeCloseTo(plain.w, 12);
      expect(clip.w).toBeCloseTo(-point.z, 12); // the view depth
      expect(clip.z).toBeCloseTo(vmRemapZ(plain.z, plain.w, cs), 12);
      const depth = windowDepth(clip.z, clip.w, cs);
      expect(depth).toBeGreaterThanOrEqual(-1e-12);
      expect(depth).toBeLessThanOrEqual(VIEWMODEL_DEPTH_RANGE + 1e-12);
    }
  });

  it('registers once', () => {
    const r = rig();
    expect(() => registerViewmodelStage(r.env.materials, r.projection)).toThrow(/already registered/);
  });

  it.each([
    ['WebGL', WebGLCoordinateSystem],
    ['WebGPU', WebGPUCoordinateSystem],
  ] as const)('%s: the matrix is makePerspective(fov, canvas aspect, 0.1, 10) and a viewmodel fragment is always nearer than the world', (_n, cs) => {
    const p = createViewmodelProjection();
    p.sync(16 / 9, cs);
    expect(p.matrixFor(55).elements).toEqual(viewmodelProjectionMatrix(55, 16 / 9, cs).elements);
    const depth = (d: number): number => {
      const c = new Vector4(0.1, -0.1, -d, 1).applyMatrix4(p.matrixFor(55));
      return windowDepth(vmRemapZ(c.z, c.w, cs), c.w, cs);
    };
    expect(depth(VIEWMODEL_NEAR)).toBeCloseTo(0, 9);
    expect(depth(VIEWMODEL_FAR)).toBeCloseTo(VIEWMODEL_DEPTH_RANGE, 9);
    let last = -1;
    for (const d of [0.1, 0.15, 0.3, 0.5, 1, 3, 10]) {
      expect(depth(d)).toBeGreaterThan(last);
      last = depth(d);
    }
    // the nearest world fragment the capsule allows (0.35 m, near 0.1 / far 2000) sits at window depth 0.714
    const world = new Matrix4().makePerspective(-1, 1, 1, -1, CAMERA_NEAR, CAMERA_FAR, cs);
    const w = new Vector4(0, 0, -0.35, 1).applyMatrix4(world);
    expect(windowDepth(w.z, w.w, cs)).toBeCloseTo(0.714, 3);
    expect(windowDepth(w.z, w.w, cs)).toBeGreaterThan(VIEWMODEL_DEPTH_RANGE + 0.4);
  });

  it('follows the canvas aspect and keeps the 55° vertical extent (16:9 → 21:9 → 4:3)', () => {
    const p = createViewmodelProjection();
    const vertical = 1 / Math.tan((55 * DEG) / 2);
    p.sync(1, WebGLCoordinateSystem);
    for (const aspect of [16 / 9, 21 / 9, 4 / 3]) {
      expect(p.sync(aspect, WebGLCoordinateSystem)).toBe(true);
      const e = p.matrixFor(55).elements;
      expect(e[5]).toBeCloseTo(vertical, 12);
      expect(e[0]).toBeCloseTo(vertical / aspect, 12);
      expect(p.aspect).toBe(aspect);
    }
  });

  it('builds a matrix only when the fov, the aspect or the coordinate system changes', () => {
    const p = createViewmodelProjection();
    p.sync(16 / 9, WebGLCoordinateSystem);
    const a = p.matrixFor(55);
    const builds = p.builds;
    expect(p.sync(16 / 9, WebGLCoordinateSystem)).toBe(false);
    expect(p.matrixFor(55)).toBe(a);
    expect(p.matrixFor(55)).toBe(a);
    expect(p.builds).toBe(builds);
    expect(p.matrixFor(40).elements[5]).toBeCloseTo(1 / Math.tan(20 * DEG), 12);
    expect(p.builds).toBe(builds + 1);
    expect(p.sync(16 / 9, WebGPUCoordinateSystem)).toBe(true);
    expect(p.matrixFor(55).elements).toEqual(viewmodelProjectionMatrix(55, 16 / 9, WebGPUCoordinateSystem).elements);
    // a fov that changes every frame (an interpolated one) does not grow the cache without bound
    for (let f = 30; f < 80; f += 0.37) p.matrixFor(f);
    expect(p.cached).toBeLessThanOrEqual(16);
    expect(p.matrixFor(Number.NaN).elements).toEqual(p.matrixFor(55).elements);
  });

  it('the renderer keeps the projection on the presenter’s aspect and the renderer’s coordinate system, in the same frame', async () => {
    const r = rig();
    const instance = new ModelInstance(await template(r.env), r.env.look);
    const row = new FakeRow('vm', 0.2, -0.3, 0.6);
    r.vm.add(row, instance);
    r.vm.update(frame(1));
    expect(r.projection.aspect).toBeCloseTo(16 / 9, 12);
    r.camera.setViewport(2560, 1080);
    r.vm.update(frame(1));
    expect(r.projection.aspect).toBeCloseTo(2560 / 1080, 12);
    expect(r.projection.matrixFor(55).elements).toEqual(r.camera.viewmodelProjection(55).elements);
    r.cs.value = WebGPUCoordinateSystem;
    r.vm.update(frame(1));
    expect(r.projection.coordinateSystem).toBe(WebGPUCoordinateSystem);
    expect(r.projection.matrixFor(55).elements).toEqual(r.camera.viewmodelProjection(55).elements);
  });

  it('each mesh carries the fov its row presents this frame (no frame-late fov)', async () => {
    const r = rig();
    const instance = new ModelInstance(await template(r.env), r.env.look);
    const row = new FakeRow('vm', 0.2, -0.3, 0.6, 0, 0, 0, undefined);
    r.vm.add(row, instance);
    r.vm.update(frame(1));
    for (const m of meshesOf(instance.root)) expect(m.userData[VIEWMODEL_FOV_KEY]).toBe(55); // a row without `fov`: the live 55°
    row.tick(0.2, -0.3, 0.6, 0, 0, 0, 45);
    r.vm.update(frame(0.5));
    for (const m of meshesOf(instance.root)) expect(m.userData[VIEWMODEL_FOV_KEY]).toBeCloseTo(50, 12);
    r.vm.update(frame(1));
    for (const m of meshesOf(instance.root)) expect(m.userData[VIEWMODEL_FOV_KEY]).toBe(45);
    // a camera-attached fx object of another package states its own
    const fx = new Mesh();
    setViewmodelFov(fx, 62);
    expect(fx.userData[VIEWMODEL_FOV_KEY]).toBe(62);
  });
});

describe('mesh state (render §4.1, §4.3)', () => {
  it('draws first among opaques, is never culled, casts and receives no shadow, stays on layer 0', async () => {
    const r = rig();
    const t = await template(r.env);
    // the template's meshes receive (and the opaque one casts) on every tier: the viewmodel must clear both
    expect([t.opaqueMesh.receiveShadow, t.opaqueMesh.castShadow]).toEqual([true, true]);
    const instance = new ModelInstance(t, r.env.look);
    r.vm.add(new FakeRow('vm', 0.2, -0.3, 0.6), instance);
    const meshes = meshesOf(instance.root);
    expect(meshes).toHaveLength(2);
    for (const m of meshes) {
      expect(m.frustumCulled).toBe(false);
      expect(m.castShadow).toBe(false);
      expect(m.receiveShadow).toBe(false);
      expect(m.layers.mask).toBe(1 << LAYER_WORLD);
      expect(((m.material as AnySurfaceMaterial).variant & V.VIEWMODEL) !== 0).toBe(true);
    }
    expect(instance.opaqueMesh.renderOrder).toBe(VIEWMODEL_RENDER_ORDER);
    expect(VIEWMODEL_RENDER_ORDER).toBe(-100);
    // every world mesh keeps three's default order 0, so three's opaque sort (renderOrder first) puts the gun before them
    expect(new Mesh().renderOrder).toBeGreaterThan(instance.opaqueMesh.renderOrder);
    // the blend pass of the gun draws after the world's transparents: it is the nearest thing on screen
    expect(instance.transparentMesh.renderOrder).toBe(VIEWMODEL_TRANSPARENT_RENDER_ORDER);
    expect((instance.transparentMesh.material as Material).transparent).toBe(true);
    // nothing asked three for pose-blind skinned bounds
    expect((instance.opaqueMesh as SkinnedMesh).boundingSphere!.radius).toBe(t.boundingSphere.radius);
  });

  it('refuses content whose material is not a VIEWMODEL variant (it would be drawn with the world projection)', async () => {
    const r = rig();
    const plain = buildModelTemplate(modelSourceFromGltf('value.00f1c6.glb', await parseGlb(glb), FIXTURE_FACTS), r.env);
    const instance = new ModelInstance(plain, r.env.look);
    expect(() => r.vm.add(new FakeRow('vm', 0.2, -0.3, 0.6), instance)).toThrow(/VIEWMODEL/);
  });

  it('a hidden weapon is not drawn and costs no interpolation; showing it again snaps', async () => {
    const r = rig();
    const t = await template(r.env);
    const held = new ModelInstance(t, r.env.look);
    const carried = new ModelInstance(t, r.env.look);
    const a = new FakeRow('held', 0.2, -0.3, 0.6);
    const b = new FakeRow('carried', 0.22, -0.39, 0.5);
    b.props = { ...b.props, visible: false };
    let posed = 0;
    r.vm.add(a, held);
    r.vm.add(b, carried, { pose: () => posed++ });
    r.camera.apply({ eye: { x: 1, y: 1, z: 1 }, yaw: 0, pitch: 0, roll: 0, vfovDeg: 58.72 });
    r.vm.update(frame(1));
    expect(r.vm.root('held')!.visible).toBe(true);
    expect(r.vm.root('carried')!.visible).toBe(false);
    expect(posed).toBe(0);
    // three draws nothing under an invisible object: no visible mesh is reachable
    const drawn: Object3D[] = [];
    r.scene.traverseVisible((o) => {
      if ((o as Mesh).isMesh === true) drawn.push(o);
    });
    expect(drawn).toEqual([held.opaqueMesh, held.transparentMesh]); // the fixture has a glass material: its blend pass draws
    // the swap: the other gun is shown at a new pose in the same tick
    a.props = { ...a.props, visible: false };
    b.tick(0.3, -0.39, 0.5);
    b.props = { ...b.props, visible: true };
    r.vm.update(frame(0.5));
    expect(r.vm.root('held')!.visible).toBe(false);
    expect(r.vm.root('carried')!.visible).toBe(true);
    expect(r.vm.presented('carried')!.x).toBe(0.3);
    expect(posed).toBe(1);
  });

  it('remove() takes a row and its children out; dispose() empties the anchor and frees the plane geometry', async () => {
    const r = rig();
    const instance = new ModelInstance(await template(r.env), r.env.look);
    r.vm.add(new FakeRow('vm', 0.2, -0.3, 0.6), instance);
    const plane = r.vm.createPlane({ width: 0.05, height: 0.05, material: { texture: 'x.png', transparent: true }, albedo: whitePixel() });
    expect(r.vm.addChild('blood-1', 'vm', plane)).toBe(true);
    expect(r.vm.addChild('blood-2', 'nobody', new Mesh())).toBe(false);
    expect(() => r.vm.add(new FakeRow('vm', 0, 0, 0.5), instance)).toThrow(/already/);
    expect(r.vm.has('vm')).toBe(true);
    expect(r.vm.has('blood-1')).toBe(true);
    r.vm.remove('blood-1');
    expect(plane.parent).toBeNull();
    expect(r.vm.has('blood-1')).toBe(false);
    r.vm.addChild('blood-3', 'vm', plane);
    r.vm.remove('vm');
    expect(r.vm.has('vm')).toBe(false);
    expect(r.vm.has('blood-3')).toBe(false);
    expect(instance.root.parent).toBeNull();
    expect(r.vm.anchor.children).toHaveLength(0);
    r.vm.update(frame(1)); // nothing left to present
    let disposed = 0;
    plane.geometry.addEventListener('dispose', () => disposed++);
    r.vm.dispose();
    expect(disposed).toBe(1);
    expect(r.vm.anchor.parent).toBeNull();
  });
});

describe('gun-blood planes (render §11.7; scripts/gore/gunblood.js)', () => {
  /** the material `gunblood.js:98` spawns a splat with */
  const WET: StandardMaterialSpec = { texture: 'cdn/decal-drops-mixed.png', color: 'oklch(0.420 0.190 27.0 / 0.95)', transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, roughness: 0.25, metalness: 0, side: 'double' };
  const albedo = (): Texture => whitePixel();

  it('a splat is a unit quad drawn through SRC_PRIM | TEX_ALBEDO | TRANSPARENT | VIEWMODEL with the row’s state', () => {
    const r = rig();
    const plane = r.vm.createPlane({ width: 0.06, height: 0.045, material: WET, albedo: albedo() });
    const m = plane.material as AnySurfaceMaterial;
    expect(m.variant).toBe(V.SRC_PRIM | V.TEX_ALBEDO | V.TRANSPARENT | V.VIEWMODEL | V.SIDE_DOUBLE);
    expect(m.transparent).toBe(true);
    expect(m.depthWrite).toBe(false);
    expect([m.polygonOffset, m.polygonOffsetFactor, m.polygonOffsetUnits]).toEqual([true, -2, -2]);
    expect(m.clipNode).not.toBeNull();
    expect([plane.scale.x, plane.scale.y, plane.scale.z]).toEqual([0.06, 0.045, 1]);
    // the quad lies in XY and faces +Z: `rotation {pitch: −90}` turns it face up (gunblood.js:83)
    const p = plane.geometry.getAttribute('position');
    const n = plane.geometry.getAttribute('normal');
    expect(p.count).toBe(4);
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(p.getX(i))).toBe(0.5);
      expect(Math.abs(p.getY(i))).toBe(0.5);
      expect(p.getZ(i)).toBe(0);
      expect([n.getX(i), n.getY(i), n.getZ(i)]).toEqual([0, 0, 1]);
    }
    expect(plane.geometry.getAttribute('uv').count).toBe(4);
    const paint = surfacePaintOf(plane);
    expect(paint.opacity).toBeCloseTo(0.95, 12);
    expect(paint.roughness).toBe(0.25);
  });

  it('rides the viewmodel row: its world matrix is the gun’s root × the splat’s local transform, on this frame’s camera', async () => {
    const r = rig();
    const instance = new ModelInstance(await template(r.env), r.env.look);
    r.vm.add(new FakeRow('vm', 0.22, -0.3915, 0.5, 4, -8), instance);
    const plane = r.vm.createPlane({ width: 0.05, height: 0.05, material: WET, albedo: albedo() });
    // on top of the receiver, face up (root frame: glTF axes, origin at the bottom of the box)
    plane.position.set(0.01, 0.15, -0.2);
    plane.quaternion.copy(eulerYXZToQuat(40, -90, 0) as unknown as Quaternion);
    expect(r.vm.addChild('blood', 'vm', plane)).toBe(true);
    expect(plane.parent).toBe(r.vm.root('vm'));
    expect(plane.frustumCulled).toBe(false);
    expect([plane.castShadow, plane.receiveShadow]).toEqual([false, false]);
    expect(plane.renderOrder).toBe(VIEWMODEL_TRANSPARENT_RENDER_ORDER);
    r.camera.apply({ eye: { x: 2, y: 1.6, z: 5 }, yaw: 0.7, pitch: 0.1, roll: 0, vfovDeg: 58.72 });
    r.vm.update(frame(1));
    expect(plane.userData[VIEWMODEL_FOV_KEY]).toBe(55);
    r.scene.updateMatrixWorld(); // the planes are not skinned: three's own update inside render() places them
    const local = new Matrix4().compose(plane.position, plane.quaternion, plane.scale);
    expectMatrix(plane.matrixWorld, instance.root.matrixWorld.clone().multiply(local));
    // face up in the gun's frame
    const normal = new Vector3(0, 0, 1).applyQuaternion(plane.quaternion);
    expect(normal.y).toBeCloseTo(1, 12);
  });

  it('drying is a paint write: the same material, no new program (wet red to dried brown over 70 s)', () => {
    const r = rig();
    const texture = albedo();
    const plane = r.vm.createPlane({ width: 0.05, height: 0.05, material: WET, albedo: texture });
    const material = plane.material;
    const before = r.env.materials.size;
    const wet = [...surfacePaintOf(plane).color];
    // gunblood.js:127 after 70 s: `{ ...material, color: col(1, 0.95), roughness: lerp(0.25, 0.85, 1) }`
    r.vm.setPlaneMaterial(plane, { ...WET, color: 'oklch(0.220 0.070 35.0 / 0.95)', roughness: 0.85 });
    expect(plane.material).toBe(material);
    expect(r.env.materials.size).toBe(before);
    const dry = surfacePaintOf(plane);
    expect(dry.roughness).toBe(0.85);
    expect(dry.opacity).toBeCloseTo(0.95, 12);
    expect(dry.color[0]).toBeLessThan(wet[0]!);
    expect(dry.color[0]).toBeGreaterThan(dry.color[2]); // still a red-brown
    // the last 30 s fade the alpha to nothing (gunblood.js:126)
    r.vm.setPlaneMaterial(plane, { ...WET, color: 'oklch(0.220 0.070 35.0 / 0.40)', roughness: 0.85 });
    expect(surfacePaintOf(plane).opacity).toBeCloseTo(0.4, 12);
    // every splat with the same image shares the one material, whatever its age
    const other = r.vm.createPlane({ width: 0.08, height: 0.08, material: { ...WET, color: 'oklch(0.3 0.1 30 / 0.95)', roughness: 0.6 }, albedo: texture });
    expect(other.material).toBe(material);
    expect(other.geometry).toBe(plane.geometry);
  });

  it('fourteen splats on a gun are fourteen children and nothing else', async () => {
    const r = rig();
    const instance = new ModelInstance(await template(r.env), r.env.look);
    r.vm.add(new FakeRow('vm', 0.22, -0.3915, 0.5), instance);
    const texture = albedo();
    for (let i = 0; i < 14; i++) r.vm.addChild(`blood-${i}`, 'vm', r.vm.createPlane({ width: 0.04, height: 0.04, material: WET, albedo: texture }));
    const root = r.vm.root('vm')!;
    expect(root.children).toHaveLength(15);
    // the oldest goes first when the game destroys it (gunblood.js:104-110)
    r.vm.remove('blood-0');
    expect(root.children).toHaveLength(14);
    r.vm.update(frame(1));
    expect(new Set(root.children.slice(1).map((c) => (c as Mesh).material)).size).toBe(1);
  });
});
