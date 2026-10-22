// World camera (docs/design/rendering.md §4.2-4.4; docs/architecture.md X-10; WP R0).
//
// The camera domain (io §5.3) computes the pose once per frame (first person, downed orbit, juice offsets) and pushes it here;
// this module owns the three `PerspectiveCamera`, its clip planes, the layer mask of the hidden local body, `project()` for the
// HUD, and the viewmodel projection. No controls are ever attached.
//
//   orientation   `camera.rotation.set(pitch, yaw, roll, 'YXZ')` gives forward = (−sin yaw · cos pitch, sin pitch,
//                 −cos yaw · cos pitch), the live `lookDir` (aim.js:8-11): yaw 0 faces −Z, +yaw turns left, +pitch looks up.
//                 YXZ is also core's transform order. Shake, punch and roll arrive inside the pose.
//   vfov          supplied by the rig in degrees (58.72° at 16:9 for hfov 90°); three's `PerspectiveCamera.fov` is the vertical
//                 angle in degrees.
//   near / far    0.1 / 2000 [CAL row 2] unless the pose says otherwise; far is not clipped to the fog (skyline backdrops).
//   aspect        the active field's aspect after the platform clamp (canvas-host.ts); the rig reads it from here.
//   viewmodel     same scene, same pass, no second camera (D7): the viewmodel material replaces the clip-space output with
//                 `vmRemap(vmProjection · modelViewMatrix · position)`. This module supplies the matrix and the remap.
import { vec4 } from 'three/tsl';
import { Matrix4, PerspectiveCamera, Vector3, WebGPUCoordinateSystem } from 'three/webgpu';
import type { CoordinateSystem, Node, Vector4 } from 'three/webgpu';
import type { Vec3 } from '../../compat/core/types.ts';
import { createProjectionSwitch, type ProjectionMode } from './ortho-projection.ts';
import { LAYER_THIRD_PERSON_ONLY, LAYER_WORLD } from './scene-root.ts';

/** render §4.2 */
export interface CameraPose {
  eye: Vec3;
  /** radians; 0 faces −Z, + turns left */
  yaw: number;
  /** radians; + looks up */
  pitch: number;
  /** radians about the view axis */
  roll: number;
  /** vertical field of view, degrees */
  vfovDeg: number;
  near?: number;
  far?: number;
  /** K16: absent = perspective. `orthographic` needs `orthoSize`; `vfovDeg` is then ignored by the projection */
  projection?: ProjectionMode;
  /** K16: half-height of the orthographic view in metres (half-width = orthoSize x aspect) */
  orthoSize?: number;
}

export interface Projected {
  /** css px from the left edge of the active field */
  x: number;
  /** css px from the top edge of the active field */
  y: number;
  /** normalised device z of the point: −1 (WebGL) or 0 (WebGPU) at the near plane, 1 at the far plane */
  depth: number;
  /** inside the frustum: in front of the camera, between the clip planes, within the field */
  onScreen: boolean;
}

/** render §4.2 */
export interface CameraPresenter {
  /** pushed once per frame by the camera domain */
  apply(pose: CameraPose): void;
  /** `hideLocalPlayer` target for the world camera's layers (render §4.4) */
  setHiddenBody(bodyId: string | null): void;
  /** no controls attached */
  readonly world: PerspectiveCamera;
  readonly aspect: number;
  /** css px of the active field, for HUD nametags and arrows */
  project(p: Vec3): Projected;
  /** render §4.3, built for `renderer.coordinateSystem`; fills `target` when given */
  viewmodelProjection(vfovDeg?: number, target?: Matrix4): Matrix4;
}

/** the presenter as the render lane drives it */
export interface CameraPresenterControl extends CameraPresenter {
  /** the row id of the local body hidden in first person; null in the downed spectator view (and before the rig's first frame) */
  readonly hiddenBody: string | null;
  /** K16: the projection mode the last pose asked for */
  readonly projection?: ProjectionMode;
  /** the active field in css px (canvas host `onResize`): sets the aspect and the `project()` scale */
  setViewport(cssW: number, cssH: number): void;
}

/** [CAL row 2] three's `PerspectiveCamera` defaults; the one value for the port (X-10) */
export const CAMERA_NEAR = 0.1;
export const CAMERA_FAR = 2000;
/** the rig's vertical fov at 16:9 for hfov 90° (`scripts/camera.js:356-367`); used until the first pose arrives */
export const DEFAULT_VFOV_DEG = 58.72;

/** render §4.3: every live gun draws with a 55° vertical fov */
export const VIEWMODEL_FOV_DEG = 55;
export const VIEWMODEL_NEAR = 0.1;
export const VIEWMODEL_FAR = 10;
/** the viewmodel's depth is squeezed into window depth [0, 0.25] [D] */
export const VIEWMODEL_DEPTH_RANGE = 0.25;

const DEG = Math.PI / 180;

/** The live `lookDir`: forward of a yaw/pitch pair. */
export function lookDirection(yaw: number, pitch: number): Vec3 {
  return { x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) };
}

const scratch = new Vector3();

/**
 * `Vector3.project(camera)` → NDC → css px of a `cssW × cssH` field. The camera's world matrix must be current
 * (`updateMatrixWorld()`); `CameraPresenter.apply` leaves it so.
 */
export function projectToField(camera: PerspectiveCamera, p: Vec3, cssW: number, cssH: number): Projected {
  const v = scratch.set(p.x, p.y, p.z).project(camera);
  const zNear = camera.coordinateSystem === WebGPUCoordinateSystem ? 0 : -1;
  return {
    x: (v.x * 0.5 + 0.5) * cssW,
    y: (-v.y * 0.5 + 0.5) * cssH,
    depth: v.z,
    onScreen: Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1 && v.z >= zNear && v.z <= 1,
  };
}

/** The viewmodel projection: `Matrix4.makePerspective` at near 0.1, far 10 for the given coordinate system. */
export function viewmodelProjectionMatrix(vfovDeg: number, aspect: number, coordinateSystem: CoordinateSystem, target: Matrix4 = new Matrix4()): Matrix4 {
  const top = VIEWMODEL_NEAR * Math.tan((vfovDeg * DEG) / 2);
  const right = top * aspect;
  return target.makePerspective(-right, right, top, -top, VIEWMODEL_NEAR, VIEWMODEL_FAR, coordinateSystem);
}

/**
 * `vmRemap` on the clip-space z (render §4.3): on the WebGL coordinate system (z/w ∈ [−1, 1], window depth (z/w + 1)/2)
 * `z′ = 0.25·z − 0.75·w`; on the WebGPU coordinate system (z/w ∈ [0, 1]) `z′ = 0.25·z`. Either way the window depth lands in
 * [0, 0.25]. The viewmodel material (R8) applies the same two lines as a TSL node; this is their CPU reference.
 */
export function vmRemapZ(z: number, w: number, coordinateSystem: CoordinateSystem): number {
  return coordinateSystem === WebGPUCoordinateSystem ? VIEWMODEL_DEPTH_RANGE * z : VIEWMODEL_DEPTH_RANGE * z - (1 - VIEWMODEL_DEPTH_RANGE) * w;
}

/** `vmRemap` on a clip-space position, in place: only z changes, so the gun keeps its place on screen. */
export function vmRemap(clip: Vector4, coordinateSystem: CoordinateSystem): Vector4 {
  clip.z = vmRemapZ(clip.z, clip.w, coordinateSystem);
  return clip;
}

/**
 * `vmRemap` as a TSL node, for the viewmodel material's `vertexNode` (render §4.3):
 * `vertexNode = vmRemapNode(vmProjection.mul(modelViewMatrix).mul(vec4(positionLocal, 1)), renderer.coordinateSystem)`.
 * three's `vertexNode` replaces only the clip-space output, so skinning and the view-space position that lighting and fog use
 * are unchanged. The coordinate system is fixed when the graph is built: a renderer rebuilt on the other backend needs the
 * material rebuilt.
 */
export function vmRemapNode(clip: Node<'vec4'>, coordinateSystem: CoordinateSystem): Node<'vec4'> {
  const z =
    coordinateSystem === WebGPUCoordinateSystem
      ? clip.z.mul(VIEWMODEL_DEPTH_RANGE)
      : clip.z.mul(VIEWMODEL_DEPTH_RANGE).sub(clip.w.mul(1 - VIEWMODEL_DEPTH_RANGE));
  return vec4(clip.xy, z, clip.w);
}

/** window depth (0 near … 1 far) of a clip-space z/w */
export function windowDepth(z: number, w: number, coordinateSystem: CoordinateSystem): number {
  return coordinateSystem === WebGPUCoordinateSystem ? z / w : (z / w + 1) / 2;
}

const finite = (n: number): boolean => typeof n === 'number' && Number.isFinite(n);

export interface CameraPresenterOptions {
  /** `renderer.coordinateSystem`, read when a matrix is built (a rebuilt renderer may sit on the other backend) */
  coordinateSystem: () => CoordinateSystem;
}

export function createCameraPresenter(opts: CameraPresenterOptions): CameraPresenterControl {
  const world = new PerspectiveCamera(DEFAULT_VFOV_DEG, 16 / 9, CAMERA_NEAR, CAMERA_FAR);
  world.name = 'ss:camera';
  world.rotation.order = 'YXZ';
  let cssW = 16;
  let cssH = 9;
  let hiddenBody: string | null = null;
  const projectionSwitch = createProjectionSwitch(world, opts.coordinateSystem);

  /** three sets this at the first render as well; doing it here keeps `project()` right before any frame was drawn */
  const syncCoordinateSystem = (): boolean => {
    const cs = opts.coordinateSystem();
    if (world.coordinateSystem === cs) return false;
    world.coordinateSystem = cs;
    return true;
  };

  const applyLayers = (): void => {
    world.layers.set(LAYER_WORLD);
    // no hidden body = the downed spectator view: the local body and the third-person-only rows are drawn
    if (hiddenBody === null) world.layers.enable(LAYER_THIRD_PERSON_ONLY);
  };

  syncCoordinateSystem();
  world.updateProjectionMatrix();
  world.updateMatrixWorld();
  applyLayers();

  return {
    world,
    get aspect(): number {
      return world.aspect;
    },
    get hiddenBody(): string | null {
      return hiddenBody;
    },
    get projection(): ProjectionMode {
      return projectionSwitch.mode;
    },
    apply(pose: CameraPose): void {
      const { eye } = pose;
      if (!finite(eye.x) || !finite(eye.y) || !finite(eye.z) || !finite(pose.yaw) || !finite(pose.pitch) || !finite(pose.roll)) {
        throw new RangeError('camera presenter: the pose must be finite');
      }
      if (!finite(pose.vfovDeg) || pose.vfovDeg <= 0 || pose.vfovDeg >= 180) {
        throw new RangeError(`camera presenter: vfovDeg must be in (0, 180), got ${String(pose.vfovDeg)}`);
      }
      const near = pose.near ?? CAMERA_NEAR;
      const far = pose.far ?? CAMERA_FAR;
      if (!finite(near) || !finite(far) || near <= 0 || far <= near) {
        throw new RangeError(`camera presenter: clip planes must satisfy 0 < near < far, got ${String(near)} / ${String(far)}`);
      }
      world.position.set(eye.x, eye.y, eye.z);
      world.rotation.set(pose.pitch, pose.yaw, pose.roll, 'YXZ');
      const csChanged = syncCoordinateSystem();
      const projChanged = projectionSwitch.set(pose.projection, pose.orthoSize);
      if (csChanged || projChanged || world.fov !== pose.vfovDeg || world.near !== near || world.far !== far) {
        world.fov = pose.vfovDeg;
        world.near = near;
        world.far = far;
        world.updateProjectionMatrix();
      }
      // current for project() and for everything that reads the camera before render() (three updates it again there)
      world.updateMatrixWorld();
    },
    setHiddenBody(bodyId: string | null): void {
      hiddenBody = bodyId;
      applyLayers();
    },
    setViewport(w: number, h: number): void {
      cssW = Math.max(1, w);
      cssH = Math.max(1, h);
      syncCoordinateSystem();
      world.aspect = cssW / cssH;
      world.updateProjectionMatrix();
    },
    project(p: Vec3): Projected {
      return projectToField(world, p, cssW, cssH);
    },
    viewmodelProjection(vfovDeg: number = VIEWMODEL_FOV_DEG, target?: Matrix4): Matrix4 {
      return viewmodelProjectionMatrix(vfovDeg, world.aspect, opts.coordinateSystem(), target);
    },
  };
}
