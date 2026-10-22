// Viewmodel renderer (docs/design/rendering.md §4.3, §11.7, §16.2-16.3; D7; docs/architecture.md X-10, X-36; WP R8).
//
// The first-person weapon is drawn in the world's scene and pass, by the world camera, with no second camera and no depth
// clear. What makes it a viewmodel is its material variant and where its root sits:
//
//   projection   Spawn draws a camera-attached row `feetPosition: {attach: 'camera', x, y, depth, fov}` with its own
//                projection (55° vertical for every live gun). The VIEWMODEL variant replaces the clip-space position:
//                `clip = vmRemap(vmProjection · positionView)`, `vmProjection` = `makePerspective(fov, canvas aspect, 0.1, 10)`
//                for the renderer's coordinate system, `vmRemap` = the window-depth squeeze into [0, 0.25] of
//                `scene/camera-presenter.ts`. `vmRemap` is linear in clip z and w, so it is folded into the matrix the
//                shader multiplies by (`clipMatrixFor`): the graph has no branch on the coordinate system and a renderer
//                rebuilt on the other backend needs no new material. World geometry cannot be nearer than the capsule's
//                0.35 m, where the world's window depth is 0.714, so the gun always wins the depth test; drawn first among
//                opaques (`renderOrder` −100), its depth lets early-z reject the world behind it.
//   not vertexNode   The replacement goes through the material's projection hook (`SurfaceInputs.clip` →
//                `setupModelViewProjection`), not `material.vertexNode`. [M, three r186 `nodes/accessors/Position.js`]: a
//                material with a `vertexNode` gets its fragment-stage `positionView` rebuilt from the clip position with
//                the camera's inverse projection. For this projection that is a point 10 to 13 cm from the eye: a surface
//                0.59 m away read back 21.7 times too bright under the shadowCaster and with a fog factor of 0.035 instead
//                of 0.543 [M, tests/e2e/render-r8.spec.ts, the `vertexNode` control]. Through the hook the view position
//                stays the interpolated `modelViewMatrix · positionLocal`: skinning, the lights and the fog are three's
//                own, at the gun's true distance (the same read-back equals a world surface at that place to 5e-7).
//                render §4.3 states that `vertexNode` leaves the view position alone; on r186 it does not.
//   per object   `vmProjection` is one uniform read per drawn object (`userData.ssVmFov`), so rows with different `fov`s
//                share a material and a program. A matrix is built only when a fov, the aspect or the coordinate system
//                changes.
//   placement    The rows hang under `anchor`, an object that takes the world camera's matrix every frame. A row's local
//                frame, as the game's own maths has it (authored content, `viewmodels.yml:4-6`): the grip
//                (the model's glTF origin, `lift` above the bottom of its box, which is where the engine stands a model)
//                at (x, y + lift, −depth), turned about the grip by yaw > 0 = muzzle left and pitch < 0 = muzzle UP.
//                That pitch sign is the opposite of a world row's (`spawn-engine-contract.md` §1.1: + tips the nose up); it
//                is the row rotation conjugated by a half turn about Y, `Ry(yaw) · Rx(−pitch) · Rz(−roll)`
//                (`cameraAttachedQuaternion`; the roll sign follows from the conjugation and has no live measurement).
//                The muzzle and ejection points stay game-computed from that maths, so drawing by it is what keeps the
//                flash on the barrel.
//   interpolation (X-36)   The game writes the pose once per 30 Hz tick. The store keeps the camera-space point
//                (x, y, −depth) and the rotation as the row's prev / cur transform, so each frame presents
//                `lerp / slerp(prev, cur, alpha)` under this frame's camera; `fov` is interpolated with them. A row that is
//                new or shown again, or a jump above 0.25 m / 30°, snaps. `viewmodelInterp = 'step'` presents `cur` only.
//   no trail (§16.3)   `update()` runs after the camera presenter has this frame's pose: it copies the camera's world matrix,
//                places each visible row and calls `updateWorldMatrix(true, false)` on the model root, so the bone write
//                that follows (the mixer adapter, or the rest pose here) multiplies by this frame's root, not last frame's.
//   camera-attached decal    authored content parents small textured planes to the viewmodel row. `createPlane` builds one
//                (`SRC_PRIM | TEX_ALBEDO | TRANSPARENT | VIEWMODEL`, the row's depth and polygon-offset state) and
//                `addChild` hangs it in the gun's root frame. One mesh per plane (≤ 14 per gun, only the shown gun draws):
//                the instanced bucket path is the map batcher's and replaces this behind the same two calls.
//
// Not here: which row is shown, hip / ADS blending, sway, bob, kick, the scoped-gun hide and the muzzle points are game
// code; the bones are written by the animation domain.
import { positionView, uniform, vec4 } from 'three/tsl';
import { BufferAttribute, BufferGeometry, Group, Matrix4, Mesh, Quaternion, Vector3, WebGLCoordinateSystem } from 'three/webgpu';
import type { CoordinateSystem, Material, Node, Object3D, Texture } from 'three/webgpu';
import type { Quat, Vec3 } from '../../compat/core/types.ts';
import { calibration, type ViewmodelInterp } from '../calibration.ts';
import type { FrameInfo } from '../engine/render-loop.ts';
import { VIEWMODEL_FOV_DEG, viewmodelProjectionMatrix, vmRemapZ, type CameraPresenter } from '../scene/camera-presenter.ts';
import { LAYER_WORLD, VIEWMODEL_RENDER_ORDER } from '../scene/scene-root.ts';
import { surfaceParamsFromSpec, type StandardMaterialSpec } from '../surface/material-spec.ts';
import { SurfaceVariant, describeVariant, setSurfacePaint, type SurfaceInputStage, type SurfaceMaterials } from '../surface/surface-material.ts';
import { ModelInstance } from './model-instance.ts';
import { modelBlendMaterial } from './model-template.ts';

export type ViewmodelInterpMode = ViewmodelInterp;

// ── the camera-space offset and its interpolation (X-36) ────────────────────────────────────────────────────────────────

/** render §4.3: "a jump larger than 0.25 m / 30° snaps" */
export const VIEWMODEL_SNAP_DISTANCE_M = 0.25;
export const VIEWMODEL_SNAP_ANGLE_DEG = 30;

/**
 * One tick's value of a camera-attached row: `feetPosition {attach: 'camera', x, y, depth, fov}` and its `rotation` as the
 * store holds it (the YXZ quaternion of `{yaw, pitch, roll}`; `cameraAttachedQuaternion` turns it into the drawn one).
 */
export interface ViewmodelOffset {
  /** metres right of the view axis */
  x: number;
  /** metres up; the bottom of the model's box (the engine value: grip height − lift) */
  y: number;
  /** metres forward */
  depth: number;
  /** vertical field of view of the row's projection, degrees */
  fov: number;
  rot: Quat;
}

const COS_HALF_SNAP = Math.cos((VIEWMODEL_SNAP_ANGLE_DEG * Math.PI) / 360);

function copyOffset(from: Readonly<ViewmodelOffset>, to: ViewmodelOffset): ViewmodelOffset {
  to.x = from.x;
  to.y = from.y;
  to.depth = from.depth;
  to.fov = from.fov;
  to.rot.x = from.rot.x;
  to.rot.y = from.rot.y;
  to.rot.z = from.rot.z;
  to.rot.w = from.rot.w;
  return to;
}

const newOffset = (): ViewmodelOffset => ({ x: 0, y: 0, depth: 0, fov: VIEWMODEL_FOV_DEG, rot: { x: 0, y: 0, z: 0, w: 1 } });

/** Whether the step from `prev` to `cur` is a jump to present at once: more than 0.25 m of (x, y, depth) or more than 30°. */
export function viewmodelOffsetSnaps(prev: Readonly<ViewmodelOffset>, cur: Readonly<ViewmodelOffset>): boolean {
  const dx = cur.x - prev.x;
  const dy = cur.y - prev.y;
  const dz = cur.depth - prev.depth;
  if (dx * dx + dy * dy + dz * dz > VIEWMODEL_SNAP_DISTANCE_M * VIEWMODEL_SNAP_DISTANCE_M) return true;
  const a = prev.rot;
  const b = cur.rot;
  // the angle between two orientations is 2·acos|a·b|
  return Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w) < COS_HALF_SNAP;
}

/**
 * The offset to draw between two ticks: `lerp(prev, cur, alpha)` of x, y, depth and fov, `slerp` of the rotation by the short
 * way. `alpha` 0 is `prev`, 1 is `cur`, both exactly; outside [0, 1] it is clamped. `'step'` and a jump (`viewmodelOffsetSnaps`)
 * give `cur`. Writes `out` (a new offset when none is given) and allocates nothing else.
 */
export function presentViewmodelOffset(prev: Readonly<ViewmodelOffset>, cur: Readonly<ViewmodelOffset>, alpha: number, mode: ViewmodelInterpMode, out: ViewmodelOffset = newOffset()): ViewmodelOffset {
  // a non-finite alpha presents the newest value
  if (mode === 'step' || !(alpha < 1) || viewmodelOffsetSnaps(prev, cur)) return copyOffset(cur, out);
  if (alpha <= 0) return copyOffset(prev, out);
  out.x = prev.x + (cur.x - prev.x) * alpha;
  out.y = prev.y + (cur.y - prev.y) * alpha;
  out.depth = prev.depth + (cur.depth - prev.depth) * alpha;
  out.fov = prev.fov + (cur.fov - prev.fov) * alpha;
  const a = prev.rot;
  const b = cur.rot;
  let dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  // q and −q are one orientation: take the short way
  const sign = dot < 0 ? -1 : 1;
  dot *= sign;
  let wa = 1 - alpha;
  let wb = alpha;
  if (dot < 0.9995) {
    const theta = Math.acos(dot);
    const s = Math.sin(theta);
    wa = Math.sin((1 - alpha) * theta) / s;
    wb = Math.sin(alpha * theta) / s;
  }
  wb *= sign;
  const x = a.x * wa + b.x * wb;
  const y = a.y * wa + b.y * wb;
  const z = a.z * wa + b.z * wb;
  const w = a.w * wa + b.w * wb;
  const n = 1 / Math.hypot(x, y, z, w);
  out.rot.x = x * n;
  out.rot.y = y * n;
  out.rot.z = z * n;
  out.rot.w = w * n;
  return out;
}

/**
 * What the renderer reads of a camera-attached row each frame. The feed's `RowSnapshot` is one: `prev` / `cur` are the row's
 * last two tick transforms, and the store keeps a camera-attached row's point (x, y, −depth) there
 * (`compat/core/store/transform.ts`), with the spec as written in `props.feetPosition`.
 */
export interface ViewmodelRowSource {
  readonly id: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly prev: { readonly pos: Vec3; readonly rot: Quat };
  readonly cur: { readonly pos: Vec3; readonly rot: Quat; readonly scale: Vec3 };
}

/** the `fov` of a row's camera spec; a row that leaves it out draws with the live 55° */
function fovOfRow(row: ViewmodelRowSource): number {
  const spec = row.props['feetPosition'] as { fov?: unknown } | null | undefined;
  const fov = spec === null || spec === undefined ? undefined : spec.fov;
  return typeof fov === 'number' && fov > 0 && fov < 180 ? fov : VIEWMODEL_FOV_DEG;
}

function setOffset(o: ViewmodelOffset, pos: Vec3, rot: Quat, fov: number): void {
  o.x = pos.x;
  o.y = pos.y;
  o.depth = -pos.z;
  o.fov = fov;
  o.rot.x = rot.x;
  o.rot.y = rot.y;
  o.rot.z = rot.z;
  o.rot.w = rot.w;
}

/**
 * The previous and current tick value of one camera-attached row (the interpolation state of X-36; the render bridge keeps
 * one per row through this class). Fed either with one sample per tick (`push`) or from the row itself every frame
 * (`readRow`).
 */
export class ViewmodelTrack {
  readonly prev: ViewmodelOffset = newOffset();
  readonly cur: ViewmodelOffset = newOffset();
  readonly #out: ViewmodelOffset = newOffset();
  #fresh = true;
  #visible = false;
  #posRef: Vec3 | null = null;
  #rotRef: Quat | null = null;

  /** One tick's value. The first one is both ends: a new row has nothing to interpolate from. */
  push(sample: Readonly<ViewmodelOffset>): void {
    if (this.#fresh) copyOffset(sample, this.prev);
    else copyOffset(this.cur, this.prev);
    copyOffset(sample, this.cur);
    this.#fresh = false;
  }

  /** Restarts the interpolation at the current value (a change of weapon). */
  snap(): void {
    copyOffset(this.cur, this.prev);
  }

  /**
   * Takes the row's two tick values as the store holds them. The store never mutates a transform value (every write stores
   * a new object, and its tick start shares `prev = cur`), so "a tick wrote this row" is a change of identity of `cur.pos` or
   * `cur.rot`: then the store's `prev` is the value of the tick before. A row seen for the first time, or shown after being
   * hidden (the game parks every carried weapon and writes only the one in hand), starts at its current value.
   */
  readRow(row: ViewmodelRowSource): void {
    const fov = fovOfRow(row);
    const { pos, rot } = row.cur;
    const visible = row.props['visible'] !== false;
    if (this.#fresh || (visible && !this.#visible)) {
      setOffset(this.cur, pos, rot, fov);
      copyOffset(this.cur, this.prev);
      this.#fresh = false;
    } else if (pos !== this.#posRef || rot !== this.#rotRef || fov !== this.cur.fov) {
      const before = this.cur.fov;
      setOffset(this.prev, row.prev.pos, row.prev.rot, before);
      setOffset(this.cur, pos, rot, fov);
    } else if (row.prev.pos === pos && row.prev.rot === rot) {
      // a tick passed without a write: the row rests at its current value
      copyOffset(this.cur, this.prev);
    }
    this.#posRef = pos;
    this.#rotRef = rot;
    this.#visible = visible;
  }

  /** The offset to draw (`presentViewmodelOffset`). Without `out` the result is this track's scratch, valid until the next call. */
  present(alpha: number, mode: ViewmodelInterpMode, out: ViewmodelOffset = this.#out): ViewmodelOffset {
    return presentViewmodelOffset(this.prev, this.cur, alpha, mode, out);
  }
}

// ── the row's frame under the camera ────────────────────────────────────────────────────────────────────────────────────

/**
 * The drawn orientation of a camera-attached row from the rotation the store holds: `Ry(yaw) · Rx(−pitch) · Rz(−roll)`, the
 * row's YXZ rotation conjugated by a half turn about Y. Yaw keeps its sense (+ turns the muzzle left); pitch is the opposite
 * of a world row's (− lifts the muzzle), as measured on the live game (`viewmodels.yml:6`, `vmrows.js:43-50`).
 */
export function cameraAttachedQuaternion(rot: Readonly<Quat>, out: Quaternion): Quaternion {
  return out.set(-rot.x, rot.y, -rot.z, rot.w);
}

const sq = new Quaternion();
const sv = new Vector3();
const sp = new Vector3();
const ss = new Vector3();
const ONE: Readonly<Vec3> = Object.freeze({ x: 1, y: 1, z: 1 });

/** position and orientation of a row root in the camera frame; `lift` = height of the pivot (the grip) above the root's origin */
function placeAttached(o: Readonly<ViewmodelOffset>, scaleY: number, lift: number, position: Vector3, quaternion: Quaternion): void {
  cameraAttachedQuaternion(o.rot, quaternion);
  const l = lift * scaleY;
  // T(x, y + l, −depth) · R · T(0, −l, 0): the grip stays at (x, y + l, −depth) whatever the turn
  sv.set(0, -l, 0).applyQuaternion(quaternion);
  position.set(o.x + sv.x, o.y + l + sv.y, -o.depth + sv.z);
}

/**
 * The matrix of a camera-attached row in the camera frame (x right, y up, −z forward): `T(x, y + lift, −depth) · R · T(0,
 * −lift, 0) · S`, R = `cameraAttachedQuaternion`. `lift` is how far the model's glTF origin (the grip) is above the bottom of
 * its box, which is where the row's `y` is measured to: `ModelTemplate.rigMatrix`'s y translation. With `lift` 0 the row
 * turns about its own origin.
 */
export function cameraAttachedMatrix(o: Readonly<ViewmodelOffset>, scale: Readonly<Vec3> | undefined, out: Matrix4, lift = 0): Matrix4 {
  const s = scale ?? ONE;
  placeAttached(o, s.y, lift, sp, sq);
  return out.compose(sp, sq, ss.set(s.x, s.y, s.z));
}

// ── the projection ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** `object.userData` key of the vertical fov (degrees) an object's viewmodel projection uses */
export const VIEWMODEL_FOV_KEY = 'ssVmFov';

/** States the fov a camera-attached object draws with (the viewmodel renderer does it for its rows; fx sinks for theirs). */
export function setViewmodelFov(object: Object3D, fovDeg: number): void {
  object.userData[VIEWMODEL_FOV_KEY] = fovDeg;
}

/** matrices kept before the cache is emptied: one per distinct fov in use, plus the values an interpolated fov passes through */
const PROJECTION_CACHE = 16;

/** The viewmodel projection, shared by every VIEWMODEL material (weapons, camera-attached decal, camera-attached fx). */
export interface ViewmodelProjection {
  /** fov of an object that states none */
  readonly defaultFovDeg: number;
  /** what the matrices are built for (`sync`) */
  readonly aspect: number;
  readonly coordinateSystem: CoordinateSystem;
  /** matrices built since creation, and those held now (diagnostics) */
  readonly builds: number;
  readonly cached: number;
  /** Follows the canvas aspect and the renderer's coordinate system. True when either changed (the matrices are rebuilt on use). */
  sync(aspect: number, coordinateSystem: CoordinateSystem): boolean;
  /** `makePerspective(fov, aspect, 0.1, 10)` for the synced aspect and coordinate system; the same object until one changes */
  matrixFor(fovDeg: number): Matrix4;
  /** `vmRemap` ∘ `matrixFor(fov)`: view space → clip space with the window depth in [0, 0.25]. What the shader multiplies by. */
  clipMatrixFor(fovDeg: number): Matrix4;
  /**
   * The clip-space position of a camera-attached object: `clipMatrix · vec4(positionView, 1)`, for a material's projection
   * (`SurfaceInputs.clip`, or `setupModelViewProjection` of a material of another package). The matrix is a uniform read
   * per drawn object (`setViewmodelFov`).
   */
  clip(): Node<'vec4'>;
  /** the VIEWMODEL input stage (`registerViewmodelStage`) */
  readonly stage: SurfaceInputStage;
}

export function createViewmodelProjection(opts: { fovDeg?: number } = {}): ViewmodelProjection {
  const defaultFovDeg = opts.fovDeg ?? VIEWMODEL_FOV_DEG;
  const cache = new Map<number, { plain: Matrix4; clip: Matrix4 }>();
  let aspect = 16 / 9;
  // the port's backend (WebGPURenderer on WebGL2) until `sync` says otherwise
  let coordinateSystem: CoordinateSystem = WebGLCoordinateSystem;
  let builds = 0;

  const validFov = (fovDeg: unknown): number => (typeof fovDeg === 'number' && fovDeg > 0 && fovDeg < 180 ? fovDeg : defaultFovDeg);

  const entryFor = (fovDeg: number): { plain: Matrix4; clip: Matrix4 } => {
    const fov = validFov(fovDeg);
    let m = cache.get(fov);
    if (m === undefined) {
      if (cache.size >= PROJECTION_CACHE) cache.clear();
      const plain = viewmodelProjectionMatrix(fov, aspect, coordinateSystem);
      const clip = plain.clone();
      // z′ = vmRemap(z, w), per column: the third row of the matrix
      const e = clip.elements;
      for (let c = 0; c < 4; c++) e[c * 4 + 2] = vmRemapZ(e[c * 4 + 2]!, e[c * 4 + 3]!, coordinateSystem);
      m = { plain, clip };
      cache.set(fov, m);
      builds++;
    }
    return m;
  };
  const matrixFor = (fovDeg: number): Matrix4 => entryFor(fovDeg).plain;
  const clipMatrixFor = (fovDeg: number): Matrix4 => entryFor(fovDeg).clip;

  // one uniform, read per drawn object: the object's fov picks the matrix
  const matrix = uniform(new Matrix4())
    .setName('ssVmProjection')
    .onObjectUpdate(({ object }, self) => {
      self.value.copy(clipMatrixFor(object?.userData[VIEWMODEL_FOV_KEY] as number));
      return undefined;
    });

  const projection: ViewmodelProjection = {
    defaultFovDeg,
    get aspect(): number {
      return aspect;
    },
    get coordinateSystem(): CoordinateSystem {
      return coordinateSystem;
    },
    get builds(): number {
      return builds;
    },
    get cached(): number {
      return cache.size;
    },
    sync(nextAspect: number, nextSystem: CoordinateSystem): boolean {
      const a = Number.isFinite(nextAspect) && nextAspect > 0 ? nextAspect : aspect;
      if (a === aspect && nextSystem === coordinateSystem) return false;
      aspect = a;
      coordinateSystem = nextSystem;
      cache.clear();
      return true;
    },
    matrixFor,
    clipMatrixFor,
    clip(): Node<'vec4'> {
      return matrix.mul(vec4(positionView, 1)) as unknown as Node<'vec4'>;
    },
    stage: (inputs) => ({ ...inputs, clip: projection.clip() }),
  };
  return projection;
}

/**
 * Registers the VIEWMODEL stage on a variant cache: every `SurfaceVariant.VIEWMODEL` material projects with `projection`.
 * Once per cache, before the first VIEWMODEL material is asked for.
 */
export function registerViewmodelStage(materials: SurfaceMaterials, projection: ViewmodelProjection): void {
  materials.registerStage(SurfaceVariant.VIEWMODEL, projection.stage);
}

// ── the renderer ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** `renderOrder` of the viewmodel's blend-pass meshes and camera-attached decal: after the world's transparents (the gun is the nearest thing) */
export const VIEWMODEL_TRANSPARENT_RENDER_ORDER = 100;

export interface ViewmodelRendererDeps {
  /** the world camera: its matrix is final for the frame when `update` runs (io §5.3) */
  camera: Pick<CameraPresenter, 'world' | 'aspect'>;
  projection: ViewmodelProjection;
  /** `renderer.coordinateSystem` */
  coordinateSystem: () => CoordinateSystem;
  /** `port.viewmodelInterp`, read every frame; default: the calibration table's value */
  interp?: () => ViewmodelInterpMode;
  /** the variant cache, for `createPlane` */
  materials?: SurfaceMaterials;
}

/** who writes a model's bones after its root is placed */
export type ViewmodelPose =
  /** this renderer writes the template's rest pose (no animation domain attached) */
  | 'rest'
  /** the animation domain's adapter writes them after `update()`; the root's world matrix is final by then */
  | 'external'
  /** called once per frame for a visible row, right after its root's world matrix is final */
  | ((instance: ModelInstance) => void);

export interface ViewmodelRowOptions {
  /** default `'rest'` */
  pose?: ViewmodelPose;
  /** height of the pivot above the content's origin; default: a model's normalisation lift (`rigMatrix`), else 0 */
  lift?: number;
}

export interface ViewmodelPlaneInit {
  /** metres, the row's `primitive: {kind: 'plane', width, height}` */
  width: number;
  height: number;
  /** the row's `material` */
  material: StandardMaterialSpec;
  /** the resolved `material.texture` */
  albedo: Texture;
}

export interface ViewmodelRenderer {
  /** follows the world camera; add it to the scene once. Camera-attached rows are its children. */
  readonly anchor: Object3D;
  readonly projection: ViewmodelProjection;
  /**
   * A camera-attached row and what it draws: a model instance (whose template was built with `SurfaceVariant.VIEWMODEL`) or
   * any object whose meshes use VIEWMODEL materials. Returns the row's root. The content stays its owner's to dispose.
   */
  add(row: ViewmodelRowSource, content: ModelInstance | Object3D, opts?: ViewmodelRowOptions): Object3D;
  /**
   * A row parented to a viewmodel row (camera-attached decal): `object` joins the parent's root frame with the local transform it has.
   * False when the parent is not a viewmodel row.
   */
  addChild(id: string, parentId: string, object: Object3D): boolean;
  /** Takes a row, or a child, out of the scene (a row takes its children with it). */
  remove(id: string): void;
  has(id: string): boolean;
  /** the root of a viewmodel row */
  root(id: string): Object3D | undefined;
  /** the offset a row was last drawn at (diagnostics) */
  presented(id: string): Readonly<ViewmodelOffset> | undefined;
  /** A textured plane for a viewmodel child row. Needs `deps.materials`. */
  createPlane(init: ViewmodelPlaneInit): Mesh;
  /** A `material` write on a plane (camera-attached decal drying): colour, opacity, roughness and metalness, as uniform values. */
  setPlaneMaterial(plane: Mesh, material: StandardMaterialSpec): void;
  /**
   * Frame step 4, after the camera presenter's pose and before the bone write: follows the camera, presents every visible
   * row at `frame.alpha` and makes its world matrix final.
   */
  update(frame: Pick<FrameInfo, 'alpha' | 'paused'>): void;
  dispose(): void;
}

interface Entry {
  row: ViewmodelRowSource;
  root: Group;
  content: Object3D;
  instance: ModelInstance | null;
  pose: ViewmodelPose;
  lift: number;
  track: ViewmodelTrack;
  out: ViewmodelOffset;
  /** every mesh under the root that draws through the viewmodel projection */
  meshes: Mesh[];
  children: Map<string, Object3D>;
  /** the fov the meshes carry; NaN = not yet stated */
  fov: number;
  /** the track has read the row at least once */
  read: boolean;
  drawn: boolean;
}

const meshesOf = (object: Object3D, into: Mesh[] = []): Mesh[] => {
  object.traverse((o) => {
    if ((o as Mesh).isMesh === true) into.push(o as Mesh);
  });
  return into;
};

function isViewmodelMaterial(material: Material | Material[]): boolean {
  if (Array.isArray(material)) return material.every(isViewmodelMaterial);
  const variant = (material as { variant?: unknown }).variant;
  return typeof variant !== 'number' || (variant & SurfaceVariant.VIEWMODEL) !== 0;
}

/** render §4.3: never culled (the projection is not the camera's), no shadows either way, layer 0, the gun's draw order */
function markMesh(mesh: Mesh, id: string): void {
  const material = mesh.material;
  if (!isViewmodelMaterial(material)) {
    const variant = (Array.isArray(material) ? material[0] : material) as { variant?: number } | undefined;
    throw new Error(`viewmodel row ${id}: mesh "${mesh.name}" uses surface variant ${describeVariant(variant?.variant ?? 0)}, which has no VIEWMODEL bit: it would be drawn with the world projection`);
  }
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  // also part of three's render-object key: the warm-up's proxies of the VIEWMODEL variants do not receive either
  mesh.receiveShadow = false;
  mesh.layers.set(LAYER_WORLD);
  const transparent = Array.isArray(material) ? material.some((m) => m.transparent) : material.transparent;
  mesh.renderOrder = transparent ? VIEWMODEL_TRANSPARENT_RENDER_ORDER : VIEWMODEL_RENDER_ORDER;
}

const clamp01 = (v: number): number => (v > 0 ? (v < 1 ? v : 1) : v === v ? 0 : 1);

export function createViewmodelRenderer(deps: ViewmodelRendererDeps): ViewmodelRenderer {
  const { camera, projection } = deps;
  const interp = deps.interp ?? ((): ViewmodelInterpMode => calibration.viewmodelInterp);
  const anchor = new Group();
  anchor.name = 'ss:viewmodel';
  // the anchor's world matrix is the camera's, written here: three must not recompute it from a parent
  anchor.matrixAutoUpdate = false;
  anchor.matrixWorldAutoUpdate = false;
  const rows = new Map<string, Entry>();
  /** child id → the viewmodel row it hangs on */
  const parents = new Map<string, string>();
  let plane: BufferGeometry | null = null;
  let lastAlpha = 1;

  const planeGeometry = (): BufferGeometry => {
    if (plane !== null) return plane;
    // a unit quad in XY facing +Z (`pivot: 'center'`), scaled by the row's width and height
    const g = new BufferGeometry();
    g.name = 'ss:viewmodel:plane';
    g.setAttribute('position', new BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
    g.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    g.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3]), 1));
    g.computeBoundingSphere();
    plane = g;
    return g;
  };

  const stateFov = (e: Entry, fov: number): void => {
    e.fov = fov;
    for (const m of e.meshes) m.userData[VIEWMODEL_FOV_KEY] = fov;
  };

  const dropChild = (e: Entry, id: string): void => {
    const object = e.children.get(id);
    if (object === undefined) return;
    e.children.delete(id);
    parents.delete(id);
    object.removeFromParent();
    const gone = new Set(meshesOf(object));
    e.meshes = e.meshes.filter((m) => !gone.has(m));
  };

  return {
    anchor,
    projection,

    add(row, content, opts = {}) {
      if (rows.has(row.id) || parents.has(row.id)) throw new Error(`viewmodel row ${row.id}: already added`);
      const instance = content instanceof ModelInstance ? content : null;
      const object = instance !== null ? instance.root : (content as Object3D);
      const meshes = meshesOf(object);
      for (const m of meshes) markMesh(m, row.id);
      const root = new Group();
      root.name = `ss:viewmodel:${row.id}`;
      root.add(object);
      anchor.add(root);
      const e: Entry = {
        row,
        root,
        content: object,
        instance,
        pose: opts.pose ?? 'rest',
        lift: opts.lift ?? (instance !== null ? instance.template.rigMatrix.elements[13]! : 0),
        track: new ViewmodelTrack(),
        out: newOffset(),
        meshes,
        children: new Map(),
        fov: Number.NaN,
        read: false,
        drawn: false,
      };
      root.visible = false; // until the first update places it
      rows.set(row.id, e);
      return root;
    },

    addChild(id, parentId, object) {
      const e = rows.get(parentId);
      if (e === undefined) return false;
      if (rows.has(id) || parents.has(id)) throw new Error(`viewmodel row ${id}: already added`);
      const meshes = meshesOf(object);
      for (const m of meshes) {
        markMesh(m, id);
        if (!Number.isNaN(e.fov)) m.userData[VIEWMODEL_FOV_KEY] = e.fov;
      }
      e.root.add(object);
      e.children.set(id, object);
      e.meshes.push(...meshes);
      parents.set(id, parentId);
      return true;
    },

    remove(id) {
      const parent = parents.get(id);
      if (parent !== undefined) {
        const e = rows.get(parent);
        if (e !== undefined) dropChild(e, id);
        return;
      }
      const e = rows.get(id);
      if (e === undefined) return;
      for (const child of [...e.children.keys()]) dropChild(e, child);
      e.content.removeFromParent();
      e.root.removeFromParent();
      rows.delete(id);
    },

    has(id) {
      return rows.has(id) || parents.has(id);
    },

    root(id) {
      return rows.get(id)?.root;
    },

    presented(id) {
      const e = rows.get(id);
      return e !== undefined && e.drawn ? e.out : undefined;
    },

    createPlane(init) {
      if (deps.materials === undefined) throw new Error('viewmodel renderer: createPlane needs the variant cache (deps.materials)');
      const params = surfaceParamsFromSpec(init.material, { source: 'prim' });
      const variant = (params.variant | SurfaceVariant.VIEWMODEL | SurfaceVariant.TEX_ALBEDO) & ~(SurfaceVariant.TEX_NORMAL | SurfaceVariant.TEX_ORM | SurfaceVariant.UV_TILE);
      // `side: 'double'` on a blend material: one draw, not three's back-then-front pair (a flat card has no far side to sort)
      const mesh = new Mesh(planeGeometry(), modelBlendMaterial(deps.materials.get({ variant, textures: { albedo: init.albedo }, state: params.state })));
      mesh.name = 'ss:viewmodel:plane';
      mesh.scale.set(init.width, init.height, 1);
      setSurfacePaint(mesh, params.paint);
      markMesh(mesh, 'plane');
      return mesh;
    },

    setPlaneMaterial(mesh, material) {
      const { paint } = surfaceParamsFromSpec(material, { source: 'prim' });
      setSurfacePaint(mesh, { color: paint.color, opacity: paint.opacity, emissive: paint.emissive, roughness: paint.roughness, metalness: paint.metalness });
    },

    update(frame) {
      // the camera's own world matrix first: the presenter leaves it current, a caller that only wrote position / rotation does not
      const world = camera.world;
      world.updateWorldMatrix(true, false);
      anchor.matrixWorld.copy(world.matrixWorld);
      anchor.matrix.copy(world.matrixWorld);
      // the projection of this frame: a resize or a new fov is never a frame late
      projection.sync(camera.aspect, deps.coordinateSystem());
      if (rows.size === 0) return;
      const mode = interp();
      // a paused frame presents what the last running one did: the tick clock stands, so must alpha
      const alpha = frame.paused ? lastAlpha : clamp01(frame.alpha);
      lastAlpha = alpha;
      for (const e of rows.values()) {
        const { row, root } = e;
        const visible = row.props['visible'] !== false;
        // a row that arrives while paused is still read once, so it has a value to present
        if (!frame.paused || !e.read) e.track.readRow(row);
        e.read = true;
        root.visible = visible;
        if (!visible) continue;
        const o = e.track.present(alpha, mode, e.out);
        e.drawn = true;
        const scale = row.cur.scale;
        root.scale.set(scale.x, scale.y, scale.z);
        placeAttached(o, scale.y, e.lift, root.position, root.quaternion);
        // parents included (the anchor holds the camera's matrix), children not: final before any bone is written
        e.content.updateWorldMatrix(true, false);
        if (o.fov !== e.fov) stateFov(e, o.fov);
        const instance = e.instance;
        if (instance === null || e.pose === 'external') continue;
        if (typeof e.pose === 'function') e.pose(instance);
        else if (instance.bonePath === 'direct') instance.writeRestPose();
      }
    },

    dispose() {
      for (const id of [...rows.keys()]) this.remove(id);
      anchor.removeFromParent();
      plane?.dispose();
      plane = null;
    },
  };
}
