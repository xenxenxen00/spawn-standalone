// WP R0: the world camera (render §4.2-4.4; X-10). `presenter.convention`: `rotation.set(pitch, yaw, roll, 'YXZ')` gives
// forward = (−sin yaw · cos pitch, sin pitch, −cos yaw · cos pitch), the live `lookDir` (aim.js:8-11): yaw 0 faces −Z, +yaw turns
// left, +pitch looks up. Also the vertical fov, the clip planes, `project()` (css px of the active field), the layer masks of the
// hidden local body, and the viewmodel projection with its depth remap on both coordinate systems. Node + three's scene graph;
// no renderer.
import { Matrix4, PerspectiveCamera, Vector3, Vector4, WebGLCoordinateSystem, WebGPUCoordinateSystem, type CoordinateSystem } from 'three';
import { vec4 as tslVec4 } from 'three/tsl';
import { describe, expect, it } from 'vitest';
import {
  CAMERA_FAR,
  CAMERA_NEAR,
  DEFAULT_VFOV_DEG,
  VIEWMODEL_DEPTH_RANGE,
  VIEWMODEL_FAR,
  VIEWMODEL_FOV_DEG,
  VIEWMODEL_NEAR,
  createCameraPresenter,
  lookDirection,
  projectToField,
  viewmodelProjectionMatrix,
  vmRemap,
  vmRemapNode,
  vmRemapZ,
  windowDepth,
  type CameraPose,
} from '../../../src/render/scene/camera-presenter.ts';
import { LAYER_SHADOW_PROXY, LAYER_THIRD_PERSON_ONLY, LAYER_WORLD } from '../../../src/render/scene/scene-root.ts';

const DEG = Math.PI / 180;
const pose = (over: Partial<CameraPose> = {}): CameraPose => ({ eye: { x: 0, y: 1.6, z: 0 }, yaw: 0, pitch: 0, roll: 0, vfovDeg: 58.72, ...over });

function presenter(opts: { width?: number; height?: number; coordinateSystem?: CoordinateSystem } = {}) {
  const field = { width: opts.width ?? 1280, height: opts.height ?? 720 };
  let cs = opts.coordinateSystem ?? WebGLCoordinateSystem;
  const p = createCameraPresenter({ coordinateSystem: () => cs });
  p.setViewport(field.width, field.height);
  return { p, setCoordinateSystem: (next: CoordinateSystem) => void (cs = next) };
}

const forward = (cam: PerspectiveCamera): Vector3 => cam.getWorldDirection(new Vector3());

describe('presenter.convention (render §4.2)', () => {
  it('yaw 0 faces −Z', () => {
    const { p } = presenter();
    p.apply(pose());
    const f = forward(p.world);
    expect(f.x).toBeCloseTo(0, 12);
    expect(f.y).toBeCloseTo(0, 12);
    expect(f.z).toBeCloseTo(-1, 12);
  });

  it('yaw π/2 faces −X (+yaw turns left)', () => {
    const { p } = presenter();
    p.apply(pose({ yaw: Math.PI / 2 }));
    const f = forward(p.world);
    expect(f.x).toBeCloseTo(-1, 12);
    expect(f.y).toBeCloseTo(0, 12);
    expect(f.z).toBeCloseTo(0, 12);
  });

  it('pitch 30° gives forward.y = 0.5 (+pitch looks up)', () => {
    const { p } = presenter();
    p.apply(pose({ pitch: 30 * DEG }));
    const f = forward(p.world);
    expect(f.y).toBeCloseTo(0.5, 12);
    expect(f.z).toBeCloseTo(-Math.cos(30 * DEG), 12);
  });

  it('forward = (−sin yaw · cos pitch, sin pitch, −cos yaw · cos pitch) over a sweep, with roll leaving it alone', () => {
    const { p } = presenter();
    for (const yaw of [-3, -1.2, 0, 0.4, 1.9, 3.1]) {
      for (const pitch of [-1.4, -0.5, 0, 0.3, 1.2]) {
        for (const roll of [0, 0.35, -0.8]) {
          p.apply(pose({ yaw, pitch, roll }));
          const f = forward(p.world);
          const want = lookDirection(yaw, pitch);
          expect(want).toEqual({ x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) });
          expect(f.x).toBeCloseTo(want.x, 12);
          expect(f.y).toBeCloseTo(want.y, 12);
          expect(f.z).toBeCloseTo(want.z, 12);
        }
      }
    }
  });

  it('the rotation order is YXZ and roll turns the up vector about the view axis', () => {
    const { p } = presenter();
    p.apply(pose({ roll: 90 * DEG }));
    expect(p.world.rotation.order).toBe('YXZ');
    const up = new Vector3(0, 1, 0).applyQuaternion(p.world.quaternion);
    expect(up.x).toBeCloseTo(-1, 12);
    expect(up.y).toBeCloseTo(0, 12);
  });

  it('the eye is the camera position and the world matrix is current right after apply()', () => {
    const { p } = presenter();
    p.apply(pose({ eye: { x: 3, y: 1.7, z: -4 }, yaw: 1 }));
    expect(p.world.position.toArray()).toEqual([3, 1.7, -4]);
    expect(new Vector3().setFromMatrixPosition(p.world.matrixWorld).toArray()).toEqual([3, 1.7, -4]);
    const viewOfEye = new Vector3(3, 1.7, -4).applyMatrix4(p.world.matrixWorldInverse);
    expect(viewOfEye.length()).toBeCloseTo(0, 12);
  });
});

describe('vertical fov, clip planes, aspect', () => {
  it('camera.fov is the pose’s vertical fov in degrees (58.72° at 16:9 is hfov 90°)', () => {
    const { p } = presenter({ width: 1920, height: 1080 });
    p.apply(pose({ vfovDeg: 58.72 }));
    expect(p.world.fov).toBe(58.72);
    const hfov = 2 * Math.atan(Math.tan((58.72 * DEG) / 2) * (16 / 9));
    expect(hfov / DEG).toBeCloseTo(90, 1);
    // the projection matrix follows: m[5] = 1 / tan(vfov / 2)
    expect(p.world.projectionMatrix.elements[5]).toBeCloseTo(1 / Math.tan((58.72 * DEG) / 2), 12);
    p.apply(pose({ vfovDeg: 40 }));
    expect(p.world.fov).toBe(40);
    expect(p.world.projectionMatrix.elements[5]).toBeCloseTo(1 / Math.tan(20 * DEG), 12);
  });

  it('near/far default to 0.1 / 2000 and follow an explicit pose', () => {
    expect([CAMERA_NEAR, CAMERA_FAR, DEFAULT_VFOV_DEG]).toEqual([0.1, 2000, 58.72]);
    const { p } = presenter();
    expect([p.world.near, p.world.far, p.world.fov]).toEqual([0.1, 2000, 58.72]);
    p.apply(pose({ near: 0.05, far: 500 }));
    expect([p.world.near, p.world.far]).toEqual([0.05, 500]);
    p.apply(pose());
    expect([p.world.near, p.world.far]).toEqual([0.1, 2000]);
  });

  it('the aspect is the active field’s, published for the rig (ctx.world.camera.aspect)', () => {
    const { p } = presenter({ width: 1280, height: 720 });
    expect(p.aspect).toBeCloseTo(16 / 9, 12);
    expect(p.world.aspect).toBe(p.aspect);
    p.setViewport(2000, 1000);
    expect(p.aspect).toBe(2);
    expect(p.world.projectionMatrix.elements[0]).toBeCloseTo(1 / (Math.tan((DEFAULT_VFOV_DEG * DEG) / 2) * 2), 12);
  });

  it('rejects a pose that is not finite instead of poisoning the matrices', () => {
    const { p } = presenter();
    expect(() => p.apply(pose({ yaw: Number.NaN }))).toThrow(RangeError);
    expect(() => p.apply(pose({ eye: { x: 0, y: Number.POSITIVE_INFINITY, z: 0 } }))).toThrow(RangeError);
    expect(() => p.apply(pose({ vfovDeg: 0 }))).toThrow(RangeError);
    expect(() => p.apply(pose({ vfovDeg: 180 }))).toThrow(RangeError);
  });

  it('no controls and no children: the camera is ours alone', () => {
    const { p } = presenter();
    expect(p.world).toBeInstanceOf(PerspectiveCamera);
    expect(p.world.children).toEqual([]);
  });
});

describe('project(): Vector3.project(camera) → NDC → css px of the active field', () => {
  it('the centre of the view lands on the centre of the field', () => {
    const { p } = presenter({ width: 1280, height: 720 });
    p.apply(pose());
    const r = p.project({ x: 0, y: 1.6, z: -10 });
    expect(r.x).toBeCloseTo(640, 9);
    expect(r.y).toBeCloseTo(360, 9);
    expect(r.onScreen).toBe(true);
    expect(r.depth).toBeGreaterThan(-1);
    expect(r.depth).toBeLessThan(1);
  });

  it('y grows downwards and x to the right; the frustum edges are the field edges', () => {
    const { p } = presenter({ width: 1280, height: 720 });
    p.apply(pose());
    const t = Math.tan((58.72 * DEG) / 2);
    const top = p.project({ x: 0, y: 1.6 + 10 * t, z: -10 });
    expect(top.y).toBeCloseTo(0, 6);
    expect(top.x).toBeCloseTo(640, 6);
    const right = p.project({ x: 10 * t * (16 / 9), y: 1.6, z: -10 });
    expect(right.x).toBeCloseTo(1280, 6);
    const above = p.project({ x: 0, y: 1.6 + 1, z: -10 });
    expect(above.y).toBeLessThan(360);
    expect(above.onScreen).toBe(true);
  });

  it('a point behind the camera is not on screen', () => {
    const { p } = presenter();
    p.apply(pose());
    expect(p.project({ x: 0, y: 1.6, z: 10 }).onScreen).toBe(false);
    expect(p.project({ x: 0.3, y: 1.2, z: 2 }).onScreen).toBe(false);
  });

  it('outside the frustum, nearer than near or farther than far → not on screen', () => {
    const { p } = presenter();
    p.apply(pose());
    expect(p.project({ x: 100, y: 1.6, z: -10 }).onScreen).toBe(false);
    expect(p.project({ x: 0, y: 100, z: -10 }).onScreen).toBe(false);
    expect(p.project({ x: 0, y: 1.6, z: -0.05 }).onScreen).toBe(false);
    expect(p.project({ x: 0, y: 1.6, z: -2500 }).onScreen).toBe(false);
  });

  it('follows the pose of this frame', () => {
    const { p } = presenter({ width: 1000, height: 500 });
    p.apply(pose({ yaw: Math.PI / 2, eye: { x: 5, y: 2, z: 5 } }));
    const r = p.project({ x: -5, y: 2, z: 5 }); // 10 m ahead along −X
    expect(r.x).toBeCloseTo(500, 9);
    expect(r.y).toBeCloseTo(250, 9);
    expect(r.onScreen).toBe(true);
  });

  it('depth is the NDC z: −1 at the near plane, +1 at the far plane', () => {
    const { p } = presenter();
    p.apply(pose());
    expect(p.project({ x: 0, y: 1.6, z: -CAMERA_NEAR }).depth).toBeCloseTo(-1, 9);
    expect(p.project({ x: 0, y: 1.6, z: -CAMERA_FAR }).depth).toBeCloseTo(1, 9);
  });

  it('projectToField is the same maths on any camera (the UI anchors use it before a renderer exists)', () => {
    const cam = new PerspectiveCamera(58.72, 16 / 9, 0.1, 2000);
    cam.position.set(0, 1.6, 0);
    cam.updateMatrixWorld();
    const r = projectToField(cam, { x: 0, y: 1.6, z: -3 }, 1280, 720);
    expect(r).toMatchObject({ onScreen: true });
    expect(r.x).toBeCloseTo(640, 9);
    expect(r.y).toBeCloseTo(360, 9);
  });
});

describe('hidden local body: the world camera’s layers (render §4.1, §4.4)', () => {
  it('layer constants', () => {
    expect([LAYER_WORLD, LAYER_THIRD_PERSON_ONLY, LAYER_SHADOW_PROXY]).toEqual([0, 1, 2]);
  });

  it('first person (a hidden body) → layer 0 only; no hidden body (the downed view) → layers 0 and 1; never layer 2', () => {
    const { p } = presenter();
    expect(p.hiddenBody).toBeNull();
    expect(p.world.layers.mask).toBe(0b011);

    p.setHiddenBody('body-7');
    expect(p.hiddenBody).toBe('body-7');
    expect(p.world.layers.mask).toBe(0b001);
    expect(p.world.layers.isEnabled(LAYER_THIRD_PERSON_ONLY)).toBe(false);

    p.setHiddenBody(null);
    expect(p.world.layers.mask).toBe(0b011);
    expect(p.world.layers.isEnabled(LAYER_SHADOW_PROXY)).toBe(false);
  });
});

describe('viewmodel projection and depth remap (render §4.3, D7)', () => {
  const systems: ReadonlyArray<[string, CoordinateSystem]> = [
    ['WebGL (z/w ∈ [−1, 1])', WebGLCoordinateSystem],
    ['WebGPU (z/w ∈ [0, 1])', WebGPUCoordinateSystem],
  ];

  it('constants: fov 55°, near 0.1, far 10, window depth range [0, 0.25]', () => {
    expect([VIEWMODEL_FOV_DEG, VIEWMODEL_NEAR, VIEWMODEL_FAR, VIEWMODEL_DEPTH_RANGE]).toEqual([55, 0.1, 10, 0.25]);
  });

  it.each(systems)('%s: the matrix is makePerspective for that coordinate system at the canvas aspect', (_name, cs) => {
    const { p } = presenter({ width: 1280, height: 720, coordinateSystem: cs });
    const m = p.viewmodelProjection(55);
    const top = VIEWMODEL_NEAR * Math.tan((55 * DEG) / 2);
    const right = top * (1280 / 720);
    const want = new Matrix4().makePerspective(-right, right, top, -top, VIEWMODEL_NEAR, VIEWMODEL_FAR, cs);
    expect(m.elements).toEqual(want.elements);
    expect(m.elements[5]).toBeCloseTo(1 / Math.tan((55 * DEG) / 2), 12);
    expect(m.elements[0]).toBeCloseTo(1 / (Math.tan((55 * DEG) / 2) * (1280 / 720)), 12);
    expect(viewmodelProjectionMatrix(55, 1280 / 720, cs).elements).toEqual(want.elements);
  });

  it('the default fov is 55° and a target matrix is filled in place', () => {
    const { p } = presenter();
    const target = new Matrix4();
    expect(p.viewmodelProjection(undefined, target)).toBe(target);
    expect(target.elements).toEqual(p.viewmodelProjection(55).elements);
    expect(p.viewmodelProjection(40).elements[5]).toBeCloseTo(1 / Math.tan(20 * DEG), 12);
  });

  it('follows the renderer’s coordinate system (a rebuild on the other backend)', () => {
    const rig = presenter({ coordinateSystem: WebGLCoordinateSystem });
    const gl = rig.p.viewmodelProjection(55).elements[10];
    rig.setCoordinateSystem(WebGPUCoordinateSystem);
    const gpu = rig.p.viewmodelProjection(55).elements[10];
    expect(gl).not.toBe(gpu);
  });

  it.each(systems)('%s: vmRemap squeezes the whole viewmodel depth range into window depth [0, 0.25]', (_name, cs) => {
    const m = viewmodelProjectionMatrix(55, 16 / 9, cs);
    const depths: number[] = [];
    for (const d of [VIEWMODEL_NEAR, 0.12, 0.25, 0.35, 0.6, 1, 2.5, 5, VIEWMODEL_FAR]) {
      const clip = new Vector4(0.1, -0.05, -d, 1).applyMatrix4(m);
      const out = vmRemap(clip.clone(), cs);
      // only z changes: the screen position of the gun is untouched
      expect([out.x, out.y, out.w]).toEqual([clip.x, clip.y, clip.w]);
      expect(out.z).toBeCloseTo(vmRemapZ(clip.z, clip.w, cs), 15);
      depths.push(windowDepth(out.z, out.w, cs));
    }
    expect(depths[0]).toBeCloseTo(0, 9); // the viewmodel near plane
    expect(depths.at(-1)).toBeCloseTo(VIEWMODEL_DEPTH_RANGE, 9); // its far plane
    for (let i = 1; i < depths.length; i++) expect(depths[i]!).toBeGreaterThan(depths[i - 1]!); // order preserved
    for (const d of depths) {
      expect(d).toBeGreaterThanOrEqual(-1e-12);
      expect(d).toBeLessThanOrEqual(VIEWMODEL_DEPTH_RANGE + 1e-12);
    }
  });

  it.each(systems)('%s: vmRemapNode builds a vec4 TSL node for the material’s vertexNode (the SwiftShader smoke draws through it)', (_name, cs) => {
    const clip = tslVec4(0.1, 0.2, 0.3, 1);
    const node = vmRemapNode(clip, cs) as unknown as { isNode?: boolean };
    expect(node.isNode).toBe(true);
    expect(node).not.toBe(clip); // a new graph: the input node is not modified
  });

  it('the remap formulas: z′ = 0.25·z − 0.75·w on WebGL, z′ = 0.25·z on WebGPU', () => {
    expect(vmRemapZ(0.4, 2, WebGLCoordinateSystem)).toBeCloseTo(0.25 * 0.4 - 0.75 * 2, 15);
    expect(vmRemapZ(0.4, 2, WebGPUCoordinateSystem)).toBeCloseTo(0.1, 15);
  });

  it.each(systems)('%s: world geometry at 0.35 m has window depth 0.714 (near 0.1, far 2000), so the gun always wins the depth test', (_name, cs) => {
    const { p } = presenter({ coordinateSystem: cs });
    const world = new PerspectiveCamera(DEFAULT_VFOV_DEG, 16 / 9, CAMERA_NEAR, CAMERA_FAR);
    world.coordinateSystem = cs;
    world.updateProjectionMatrix();
    const clip = new Vector4(0, 0, -0.35, 1).applyMatrix4(world.projectionMatrix);
    const worldDepth = windowDepth(clip.z, clip.w, cs);
    expect(worldDepth).toBeCloseTo(0.714, 3);

    // the farthest viewmodel fragment is still in front of the nearest possible world fragment
    const vm = new Vector4(0, 0, -VIEWMODEL_FAR, 1).applyMatrix4(p.viewmodelProjection(55));
    const vmDepth = windowDepth(vmRemapZ(vm.z, vm.w, cs), vm.w, cs);
    expect(vmDepth).toBeLessThan(worldDepth);
  });
});
