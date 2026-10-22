// The render bridge (docs/design/rendering.md §16, §8.1, §4.3, §6.5, §6.7; docs/architecture.md X-14, X-36, X-47, §4.2 step 4,
// §9.3 row R13): rows of the kernel's feed → what the renderer draws of them, every frame.
//
//   rows       one `RowNode` per row the feed (or a place build) names. A node is a few numbers; it gets an `Object3D` only
//              when something has to hang on it (a model, an fx effect, an extension). Rows drawn as bucket instances or
//              light records have none (render §16.3: no object, world matrix, bounds or frustum test per primitive).
//   poses      every row is interpolated in its OWN local frame (`interpolate.ts`: lerp / slerp of the store's prev and cur by
//              `alpha`, snapping past the teleport threshold) and the bridge composes the parents: `world = parent.world ×
//              local`, parents first. That is what makes a torch follow its body's interpolated facing and a haze cone
//              follow the torch. A row's `Object3D`, where it has one, is a direct child of its place's group and carries the
//              composed world matrix as its own `matrix` (`matrixAutoUpdate` off: one regime per node), so three's graph has
//              no row hierarchy to walk.
//   order      (1) present the local pose of the rows that can have moved, (2) compose the world matrices of those rows and
//              their descendants, (3) `root.updateWorldMatrix(true, false)` on each model root that moved, and the rest pose
//              on a body nothing animates, (4) everything read from a world matrix: light poses and `aim`, bucket matrices,
//              single map rows, (5) the viewmodel layer under this frame's camera. After that the mixer writes the skin
//              (`MixerHost.update`), and `afterPose` places what rides a bone, tests `visibleRange`, selects the map's LODs
//              and flushes the buckets. Nothing in (4) may run before (3): three recomputes world matrices only inside
//              `render()` (render §16.3), and a light or a cone would trail a turning body by a frame.
//   which rows a frame touches   rows with a dynamic, kinematic or character body, or a velocity (the engine moves them with no feed
//              event), and rows a transform write named, until they rest (prev = cur by identity: the store never mutates a
//              transform value). Everything else costs nothing. A slice of the resting rows is looked at every frame, so a
//              row moved by a writer this file does not know still starts moving within a few frames.
//   lights     a `light` row is a record of R1b's table with a stable handle: writes are `setIntensity` / `setColor` /
//              `setPose`, never add + remove. `aim` (render §8.1): a point is a target in the row's PARENT space, `'forward'`
//              the row's own −Z after its rotation and its parents'; the record's direction is light − target.
//   the map    scripted rows belong to the place's `MapBatcher`. `loadStaticPlace` hands it the place's scripted rows with
//              their world matrices; a write to a batched row promotes it (render §6.5), a dynamic row is a single row the
//              bridge moves, a row spawned during play is added, a `primitive` write regenerates.
//   places     rows of a place that is not the active one do not draw: their group is hidden, their bucket instances are
//              released and their lights are dark, with all state kept.
//
// Seams left for later packages (typed, null by default, never a throw): `FxSystem` (R10), the shadow spot and the
// directional sinks (R4), `ui` / `spline` / `scatter` / scripted-material extensions (R12a, R12b), `setRowOffset` (the `shake`
// act's jitter, R12a), `node()` (RH1's highlights), `bones` (R7's frozen corpse bones), `handoff` (R7's corpse and gib
// renderers: rows whose drawing leaves the model path, `BridgeHandoff`).
import { Group, Matrix4, Quaternion, Vector3 } from 'three/webgpu';
import type { Mesh, Object3D } from 'three/webgpu';
import type { RowFeed, RowSnapshot } from '../../compat/core/ports.ts';
import type { Quat, Vec3 } from '../../compat/core/types.ts';
import type { FrameInfo } from '../engine/render-loop.ts';
import { keyOf, type ScriptedSpec } from '../geometry/generator-types.ts';
import type { BatcherRow } from '../geometry/map-batcher.ts';
import { isDynamicRow } from '../geometry/map-plan.ts';
import { primitiveShape, type PrimitiveSpec } from '../geometry/primitives.ts';
import type { LightHandle, LightMobility, LightRecord } from '../lighting/light-table.ts';
import { LAYER_THIRD_PERSON_ONLY, LAYER_WORLD } from '../scene/scene-root.ts';
import { isScriptedMaterialSpec, surfaceParamsFromSpec, type StandardMaterialSpec } from '../surface/material-spec.ts';
import type {
  BridgeBatcherRow, BridgeHandoff, BridgeLights, BridgeMap, BridgeMapHost, BridgeMixer, BridgeModel, BridgeModels, BridgePrimitives, BridgeViewmodel, BridgeViewmodelContent, DirectionalSink, FxBinding,
  FxSystem, RenderBridge, RowExtension, RowExtensionBinding, RowExtensionField, RowNodeView, ShadowSpotSink,
} from './bridge-types.ts';
import { clampAlpha, presentRowPose, teleportThresholdOf, TELEPORT_THRESHOLD_M } from './interpolate.ts';
import {
  attachmentBoneOf, BRIDGE_FIELDS, FOREIGN_FIELDS, isCameraAttached, isEditorOnly, layoutScale, lightShapeDiffers, physicsBodyOf, pivotOf, pivotShift, primitiveSpecOf,
  rowLightOf, sameColor, scriptedSpecOf, standardMaterialOf, visibleRangeOf, type RowLight,
} from './row-spec.ts';

export type { RenderBridge } from './bridge-types.ts';

export interface RenderBridgeDeps {
  /** Additional host tags that keep rows out of static batches. */
  dynamicTags?: readonly string[];
  /** parent of everything the bridge adds (`SceneRoot.world`); never transformed */
  world: Object3D;
  /** the camera presenter: its pose is this frame's when `update` runs (docs/architecture.md §4.2 step 2) */
  camera: { readonly world: Object3D; readonly hiddenBody?: string | null };
  lights?: BridgeLights | null;
  primitives?: BridgePrimitives | null;
  map?: BridgeMapHost | null;
  /**
   * K3: a scripted row that animates (`mixer`, `anim` or `bones` in its props) is marked `rigged` for the batcher, so it is
   * never merged or instanced and its rigged key can be skinned. Default false
   */
  rigs?: boolean;
  /**
   * `pivot` on a scripted (map) row: the named point of its geometry box (fractions per local axis, contract §9.1) is the row's
   * origin, as on primitives and models; such a row is drawn single (never merged). Default false (the legacy host: not applied, one log line)
   */
  scriptedPivot?: boolean;
  models?: BridgeModels | null;
  mixer?: BridgeMixer | null;
  viewmodel?: BridgeViewmodel | null;
  viewmodelContent?: BridgeViewmodelContent | null;
  fx?: FxSystem | null;
  shadowSpot?: ShadowSpotSink | null;
  directional?: DirectionalSink | null;
  /** a frozen bone of a baked corpse (X-40; R7), looked up before the parent's model */
  bones?: ((parentRowId: string, bone: string) => Object3D | null) | null;
  /** R7: rows a corpse or gib renderer draws instead of the model path (render §11.5, §11.6) */
  handoff?: BridgeHandoff | null;
  extensions?: Partial<Record<RowExtensionField, RowExtension>>;
  /** the AABB of a place's unparented rows, once per `loadStaticPlace` (the light grid's extent, render §8.2) */
  onPlaceBounds?: (place: string, bounds: { min: Vec3; max: Vec3 } | null) => void;
  /** default 2 m (render §16.2) */
  teleportThreshold?: number;
  /** true: the host calls `afterPose` itself, after the skin write (`bridge/attach.ts`); default: `update` ends with it */
  hostAfterPose?: boolean;
  /** one line per thing the bridge does not draw; each message once. Default: `console.warn` in dev builds, nothing otherwise */
  log?: (message: string) => void;
}

export interface RenderBridgeStats {
  rows: number;
  /** rows with an `Object3D` */
  objects: number;
  /** rows looked at every frame (a body, a velocity, or still moving) */
  scanned: number;
  /** rows whose world matrix the last `update` + `afterPose` recomputed */
  moved: number;
  lights: number;
  primitives: number;
  models: number;
}

/** the bridge as the render lane drives it */
export interface RenderBridgeControl extends RenderBridge {
  /** the feed's pending rows, now. `update` drains by itself when nobody did since the last one. */
  drain(): void;
  /** after the skin write: rows riding a bone, `visibleRange`, the map's LODs, the bucket flush */
  afterPose(frame: Pick<FrameInfo, 'alpha' | 'paused'>): void;
  /** `SceneSyncPort.activate`: rows of every other place stop drawing */
  activate(place: string): void;
  /** `SceneSyncPort.disposePlace`: every node, handle, instance and binding of the place goes */
  disposePlace(place: string): void;
  /** `ObjectView.bounds`: the world box of a row's model; undefined until it is measured */
  bounds(rowId: string): { min: Vec3; max: Vec3 } | undefined;
  socket(rowId: string, name: string): { position: Vec3; direction: Vec3; confidence: number } | null;
  /** a camera cut (spawn, respawn, a spectator switch): the next map LOD selection ignores the hysteresis */
  cameraCut(): void;
  /** the fx system, when it lands after the bridge (R10); rows with an `fx` are bound at once */
  setFxSystem(fx: FxSystem | null): void;
  /** the `shake` act's jitter (R12a): a local offset added to the row's presented position; null ends it */
  setRowOffset(rowId: string, offset: Readonly<Vec3> | null): void;
  /** the `squash` act (K8): a per-axis factor on the row's presented scale; null ends it. The simulated scale is untouched. */
  setRowScale(rowId: string, factor: Readonly<Vec3> | null): void;
  /** RH1 and tools */
  node(rowId: string): RowNodeView | undefined;
  has(rowId: string): boolean;
  /** the built map of a place */
  mapOf(place: string): BridgeMap | null;
  /**
   * A scripted (map) row's own meshes (`BridgeMap.rowMeshes`), for the outline highlight. A batched row is promoted (it gets
   * meshes of its own on a later frame) and null returned meanwhile; null too for a row that is not a map row
   */
  rowMeshes(rowId: string): Mesh[] | null;
  stats(): RenderBridgeStats;
  dispose(): void;
}

// ── nodes ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

const pivotMatrix = new Matrix4();
const pivotTranslate = new Matrix4();

interface LightBinding {
  spec: RowLight;
  handle: LightHandle | null;
  /** the row drives the shadow spot (R4) or a directional slot instead of a table record */
  sink: 'table' | 'shadow' | 'directional';
  slot: number;
  /** the intensity last written (0 while the row is hidden) */
  shown: number;
}

interface PrimBinding {
  spec: PrimitiveSpec;
  material: StandardMaterialSpec | null;
  handle: unknown;
  has: boolean;
  /** the pivot's shift in the row's frame; null: none */
  shift: [number, number, number] | null;
}

interface MapBinding {
  place: string;
  spec: ScriptedSpec;
  key: string;
  /** `pending`: no built map knows the row yet; `built`: the batcher has it; `busy`: a promote / add / regenerate is on its way */
  state: 'pending' | 'built' | 'busy';
  single: boolean;
  /** written while it could not be applied (during a build or a promote) */
  stale: boolean;
  /** `primitive` was written while busy */
  respec: boolean;
  visible: boolean;
}

class RowNode implements RowNodeView {
  readonly id: string;
  snap: RowSnapshot;
  place: string | null;
  parent: RowNode | null = null;
  /** the parent's id while the parent is not known (a child added first, or left behind by its parent's removal) */
  waiting: string | null = null;
  readonly children: RowNode[] = [];
  obj: Group | null = null;
  /** the world matrix as presented; `obj.matrix` once the node has an object */
  matrix = new Matrix4();
  // the presented local pose
  px = 0;
  py = 0;
  pz = 0;
  qx = 0;
  qy = 0;
  qz = 0;
  qw = 1;
  sx = 1;
  sy = 1;
  sz = 1;
  posed = false;
  // the store's values the pose was taken from (identity: the store never mutates a transform value)
  posRef: Vec3 | null = null;
  rotRef: Quat | null = null;
  scaleRef: Vec3 | null = null;
  /** `cur` at the time the row was added: until a tick replaces it the row presents `cur` */
  addPos: Vec3 | null = null;
  addRot: Quat | null = null;
  atRest = false;
  threshold: number | null = TELEPORT_THRESHOLD_M;
  /** looked at every frame: a body the engine moves */
  watched = false;
  scanAt = -1;
  idleAt = -1;
  offset: Vec3 | null = null;
  /** the `squash` act's factor on the presented scale (K8) */
  scaleMul: Vec3 | null = null;
  // frames
  /** camera-attached (the viewmodel layer), or a child of such a row: placed by R8's renderer, not composed here */
  cam = false;
  vm = false;
  vmObject: Object3D | null = null;
  vmContent: Object3D | null = null;
  vmAdded = false;
  bone: string | null = null;
  /** rides a bone, or an ancestor does: composed after the skin write */
  late = false;
  // visibility
  ownVisible = true;
  renderSelf = true;
  tpoOwn = false;
  range: { min: number; max: number } | null = null;
  rangeOk = true;
  orphaned = false;
  /** the row and its ancestors are visible */
  chain = true;
  /** `chain` and the row's place draws */
  eff = true;
  /** third-person only: the hidden local body's subtree, or `visibleInFirstPerson: false` */
  tpo = false;
  layerMask = -1;
  dirtyStamp = 0;
  worldStamp = 0;
  // content
  light: LightBinding | null = null;
  prim: PrimBinding | null = null;
  map: MapBinding | null = null;
  model: BridgeModel | null = null;
  /** R7: the handoff draws the row (a batched gib): it has no model */
  claimed = false;
  /** R7: the handoff owns the row's former model (a baked corpse); `rootLocal` is that model root's matrix under the row */
  handed = false;
  rootLocal: Matrix4 | null = null;
  /** bumps whenever the row's model is asked for again: a load that resolves late is dropped */
  modelGen = 0;
  modelScale = 1;
  driven = false;
  fx: FxBinding | null = null;
  ext: Partial<Record<RowExtensionField, RowExtensionBinding>> | null = null;

  constructor(snap: RowSnapshot) {
    this.id = snap.id;
    this.snap = snap;
    this.place = snap.place;
  }

  get object(): Object3D | null {
    return this.obj ?? this.vmObject;
  }
  get world(): ArrayLike<number> {
    return this.matrix.elements;
  }
  get visible(): boolean {
    return this.eff;
  }
}

interface PlaceState {
  id: string;
  group: Group;
  map: BridgeMap | null;
  /** bumps on dispose: a build that resolves afterwards is thrown away */
  generation: number;
  building: boolean;
}

const NO_PLACE = '';
const UP: Readonly<Vec3> = Object.freeze({ x: 0, y: 1, z: 0 });
const TRANSFORM_FIELDS: ReadonlySet<string> = new Set(['feetPosition', 'rotation', 'yaw', 'scale']);
/** render §6.5: writes that detach a batched row */
const PROMOTE_FIELDS: ReadonlySet<string> = new Set(['feetPosition', 'rotation', 'yaw', 'scale', 'visible', 'render', 'material']);
/** resting rows looked at per frame, at least; and the share of all of them */
const IDLE_SLICE_MIN = 8;
const IDLE_SLICE_SHARE = 16;

const sameAim = (a: RowLight['aim'], b: RowLight['aim']): boolean =>
  a === b || (a !== null && b !== null && typeof a === 'object' && typeof b === 'object' && a.x === b.x && a.y === b.y && a.z === b.z);

const DEV_BUILD: boolean = (import.meta as { env?: { DEV?: boolean } }).env?.DEV === true;

/** the rig fields of a camera row (core `RIG_FIELDS`): the camera presenter reads them (`hideLocalPlayer` as `camera.hiddenBody`), the bridge has nothing to draw for a write of them, so it is not a warning */
const CAMERA_RIG_FIELDS: ReadonlySet<string> = new Set(['fov', 'hideLocalPlayer', 'clip', 'orientation', 'pointerLock', 'sensitivity', 'pixelSnap']);

export function createRenderBridge(deps: RenderBridgeDeps): RenderBridgeControl {
  const lights = deps.lights ?? null;
  const primitives = deps.primitives ?? null;
  const mapHost = deps.map ?? null;
  const models = deps.models ?? null;
  const mixer = deps.mixer ?? null;
  const viewmodel = deps.viewmodel ?? null;
  const vmContent = deps.viewmodelContent ?? null;
  const shadowSpot = deps.shadowSpot ?? null;
  const directional = deps.directional ?? null;
  const handoff = deps.handoff ?? null;
  /** rows whose model the handoff tracks and may own: checked once per frame (a few dozen corpses at most) */
  const handoffWatch = new Set<RowNode>();
  const mPose = new Matrix4();
  const defaultThreshold = deps.teleportThreshold ?? TELEPORT_THRESHOLD_M;
  const logSink = deps.log ?? (DEV_BUILD ? (m: string): void => console.warn(m) : null);

  let fxSystem: FxSystem | null = deps.fx ?? null;
  let feed: RowFeed | null = null;
  let drained = false;
  let disposed = false;
  let stamp = 0;
  let lastAlpha = 1;
  let activePlace: string | null = null;
  let hiddenBody: string | null = null;
  let cut = false;
  let movedLast = 0;

  const nodes = new Map<string, RowNode>();
  /** `visibleTo: 'editors'` rows: known, never created */
  const skipped = new Set<string>();
  /** parent id → children that arrived before it */
  const orphans = new Map<string, RowNode[]>();
  const places = new Map<string, PlaceState>();
  /** rows looked at every frame */
  const scan: RowNode[] = [];
  /** rows that may move and are not in `scan` now */
  const idle: RowNode[] = [];
  let idleCursor = 0;
  const riders = new Set<RowNode>();
  const ranged = new Set<RowNode>();
  const tpoRoots = new Set<RowNode>();
  const dirty: RowNode[] = [];
  const stack: RowNode[] = [];
  const logged = new Set<string>();
  const directionalSlots: Array<RowNode | null> = [null, null];
  let shadowOwner: RowNode | null = null;
  /** unit box per primitive geometry key: [minX, minY, minZ, maxX, maxY, maxZ] */
  const unitBoxes = new Map<string, Float32Array>();
  let lightCount = 0;
  let primCount = 0;
  let modelCount = 0;
  let objectCount = 0;

  // scratch: nothing below allocates per frame
  const sPos: Vec3 = { x: 0, y: 0, z: 0 };
  const sRot: Quat = { x: 0, y: 0, z: 0, w: 1 };
  const vPos = new Vector3();
  const vScale = new Vector3();
  const qRot = new Quaternion();
  const mLocal = new Matrix4();
  const mPrim = new Matrix4();
  const mShift = new Matrix4();
  const lightPos: Vec3 = { x: 0, y: 0, z: 0 };
  const lightDir: Vec3 = { x: 0, y: 0, z: 0 };
  const lightTarget: Vec3 = { x: 0, y: 0, z: 0 };
  const camPos: Vec3 = { x: 0, y: 0, z: 0 };
  const shiftOut: [number, number, number] = [0, 0, 0];
  const boxOut = new Float32Array(6);

  const log = (message: string): void => {
    if (logSink === null || logged.has(message)) return;
    logged.add(message);
    logSink(`[bridge] ${message}`);
  };

  // ── places ────────────────────────────────────────────────────────────────────────────────────────────────────────────

  function placeOf(id: string | null): PlaceState {
    const key = id ?? NO_PLACE;
    let p = places.get(key);
    if (p === undefined) {
      const group = new Group();
      group.name = key === NO_PLACE ? 'ss:rows' : `ss:place:${key}`;
      // the group never moves: its rows carry world matrices
      group.matrixAutoUpdate = false;
      group.visible = placeDraws(key);
      deps.world.add(group);
      p = { id: key, group, map: null, generation: 0, building: false };
      places.set(key, p);
    }
    return p;
  }

  /** rows without a place always draw; before the first `activate` every place does */
  function placeDraws(key: string): boolean {
    return key === NO_PLACE || activePlace === null || activePlace === key;
  }

  // ── node bookkeeping ──────────────────────────────────────────────────────────────────────────────────────────────────

  function intoScan(n: RowNode): void {
    if (n.scanAt >= 0 || n.vm) return;
    if (n.idleAt >= 0) {
      const last = idle.pop()!;
      if (last !== n) {
        idle[n.idleAt] = last;
        last.idleAt = n.idleAt;
      }
      n.idleAt = -1;
    }
    n.scanAt = scan.length;
    scan.push(n);
  }

  function outOfScan(n: RowNode, toIdle: boolean): void {
    if (n.scanAt >= 0) {
      const last = scan.pop()!;
      if (last !== n) {
        scan[n.scanAt] = last;
        last.scanAt = n.scanAt;
      }
      n.scanAt = -1;
    }
    if (toIdle && n.idleAt < 0 && !n.vm && !isBatched(n)) {
      n.idleAt = idle.length;
      idle.push(n);
    }
  }

  function outOfIdle(n: RowNode): void {
    if (n.idleAt < 0) return;
    const last = idle.pop()!;
    if (last !== n) {
      idle[n.idleAt] = last;
      last.idleAt = n.idleAt;
    }
    n.idleAt = -1;
  }

  /** a scripted row the batcher draws inside a chunk or an instance partition: it moves only after a write promoted it */
  const isBatched = (n: RowNode): boolean => n.map !== null && !n.map.single;

  function ensureObject(n: RowNode): Group {
    if (n.obj !== null) return n.obj;
    const obj = new Group();
    obj.name = `row:${n.id}`;
    obj.matrixAutoUpdate = false;
    obj.matrix.copy(n.matrix);
    n.matrix = obj.matrix;
    obj.matrixWorldNeedsUpdate = true;
    obj.visible = n.eff;
    obj.userData['ssRowId'] = n.id;
    placeOf(n.place).group.add(obj);
    n.obj = obj;
    objectCount++;
    return obj;
  }

  /** marks a node and its descendants for a world recompute this frame; rows riding a bone wait for `afterPose` */
  function markDirty(root: RowNode, late: boolean): void {
    stack.length = 0;
    stack.push(root);
    while (stack.length > 0) {
      const n = stack.pop()!;
      // a subtree that rides a bone hangs below its rider: none of it is composed in the main pass
      if (n.dirtyStamp === stamp || n.vm || (!late && n.late)) continue;
      n.dirtyStamp = stamp;
      dirty.push(n);
      for (let i = 0; i < n.children.length; i++) stack.push(n.children[i]!);
    }
  }

  function setLate(root: RowNode): void {
    stack.length = 0;
    stack.push(root);
    while (stack.length > 0) {
      const n = stack.pop()!;
      const late = n.bone !== null || (n.parent !== null && n.parent.late);
      n.late = late;
      if (n.bone !== null && !n.vm) riders.add(n);
      else riders.delete(n);
      for (let i = 0; i < n.children.length; i++) stack.push(n.children[i]!);
    }
  }

  // ── the local pose ────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Presents the row's local pose for `alpha`. True when it changed (or was never presented). */
  function present(n: RowNode, alpha: number): boolean {
    const cur = n.snap.cur;
    const pos = cur.pos;
    const rot = cur.rot;
    const scale = cur.scale;
    const offset = n.offset;
    const sm = n.scaleMul;
    if (n.posed && n.atRest && offset === null && sm === null && pos === n.posRef && rot === n.rotRef && scale === n.scaleRef) return false;
    let moving = false;
    if (pos === n.addPos && rot === n.addRot) {
      // a new row has nothing to interpolate from
      sPos.x = pos.x;
      sPos.y = pos.y;
      sPos.z = pos.z;
      sRot.x = rot.x;
      sRot.y = rot.y;
      sRot.z = rot.z;
      sRot.w = rot.w;
    } else {
      n.addPos = null;
      n.addRot = null;
      const prev = n.snap.prev;
      moving = prev.pos !== pos || prev.rot !== rot;
      presentRowPose(prev.pos, prev.rot, pos, rot, alpha, n.threshold, sPos, sRot);
    }
    if (offset !== null) {
      sPos.x += offset.x;
      sPos.y += offset.y;
      sPos.z += offset.z;
    }
    const ex = sm === null ? scale.x : scale.x * sm.x;
    const ey = sm === null ? scale.y : scale.y * sm.y;
    const ez = sm === null ? scale.z : scale.z * sm.z;
    const changed =
      !n.posed || n.px !== sPos.x || n.py !== sPos.y || n.pz !== sPos.z || n.qx !== sRot.x || n.qy !== sRot.y || n.qz !== sRot.z || n.qw !== sRot.w ||
      n.sx !== ex || n.sy !== ey || n.sz !== ez;
    n.px = sPos.x;
    n.py = sPos.y;
    n.pz = sPos.z;
    n.qx = sRot.x;
    n.qy = sRot.y;
    n.qz = sRot.z;
    n.qw = sRot.w;
    n.sx = ex;
    n.sy = ey;
    n.sz = ez;
    n.posRef = pos;
    n.rotRef = rot;
    n.scaleRef = scale;
    n.atRest = !moving;
    n.posed = true;
    return changed;
  }

  /** the matrix a row's local pose is applied under: its bone, its parent's world, or nothing (the world itself) */
  function parentMatrix(n: RowNode): Matrix4 | null {
    const p = n.parent;
    if (n.bone !== null && p !== null) {
      const bone = deps.bones?.(p.id, n.bone) ?? p.model?.bones.get(n.bone)
        ?? (deps.rigs === true && p.map !== null ? places.get(p.map.place)?.map?.rowBone?.(p.id, n.bone) : null) ?? null;
      if (bone !== null) return bone.matrixWorld;
    }
    return p !== null ? p.matrix : null;
  }

  function resolve(n: RowNode): void {
    if (n.worldStamp === stamp) return;
    n.worldStamp = stamp;
    const p = n.parent;
    if (p !== null && p.dirtyStamp === stamp) resolve(p);
    mLocal.compose(vPos.set(n.px, n.py, n.pz), qRot.set(n.qx, n.qy, n.qz, n.qw), vScale.set(n.sx, n.sy, n.sz));
    const pm = parentMatrix(n);
    if (pm !== null) n.matrix.multiplyMatrices(pm, mLocal);
    else n.matrix.copy(mLocal);
  }

  /** everything that reads the row's world matrix (render §16.3: after the world matrices of this frame, never before) */
  function applyWorld(n: RowNode): void {
    if (n.claimed) handoff!.pose(n.id, n.matrix);
    else if (n.handed) handoff!.pose(n.id, mPose.multiplyMatrices(n.matrix, n.rootLocal!));
    const obj = n.obj;
    if (obj !== null) {
      // three recomputes the object's children (the model's meshes) from this matrix inside render()
      obj.matrixWorldNeedsUpdate = true;
      const model = n.model;
      if (model !== null) {
        // parents included, children not: the skin write that follows multiplies by this frame's root
        model.root.updateWorldMatrix(true, false);
        if (!n.driven && model.bonePath === 'direct') model.writeRestPose?.();
      } else obj.updateWorldMatrix(true, false);
    }
    if (n.light !== null) syncLight(n, true);
    if (n.prim !== null) syncPrimitive(n, true);
    const m = n.map;
    if (m !== null) {
      if (m.state === 'built' && m.single) {
        const map = places.get(m.place)?.map;
        map?.setRowMatrix(n.id, mapMatrix(n, map));
      }
      else if (m.state !== 'pending') m.stale = true;
    }
  }

  function flushDirty(): void {
    for (let i = 0; i < dirty.length; i++) resolve(dirty[i]!);
    for (let i = 0; i < dirty.length; i++) applyWorld(dirty[i]!);
    movedLast += dirty.length;
    dirty.length = 0;
  }

  /** the world matrices of every row that is waiting for one, at `alpha` */
  function poseRows(alpha: number): void {
    stamp++;
    dirty.length = 0;
    for (let i = scan.length - 1; i >= 0; i--) {
      const n = scan[i]!;
      // a row on a bone is presented here and composed in `afterPose`, when the bone has this frame's matrix
      if (present(n, alpha) && !n.late) markDirty(n, false);
      // a row at rest leaves the per-frame set unless the engine may move it without telling
      if (n.atRest && !n.watched && n.offset === null && n.scaleMul === null) outOfScan(n, true);
    }
    // a slice of the resting rows: a row moved by a writer that sends no feed event (the kernel's own velocity step, a
    // world-bounds teleport) joins the per-frame set within a few frames
    const count = idle.length;
    if (count > 0) {
      const slice = Math.min(count, Math.max(IDLE_SLICE_MIN, Math.ceil(count / IDLE_SLICE_SHARE)));
      for (let k = 0; k < slice; k++) {
        if (idleCursor >= idle.length) idleCursor = 0;
        const n = idle[idleCursor]!;
        const cur = n.snap.cur;
        if (cur.pos !== n.posRef || cur.rot !== n.rotRef || cur.scale !== n.scaleRef) {
          intoScan(n);
          if (present(n, alpha) && !n.late) markDirty(n, false);
        } else idleCursor++;
      }
    }
    flushDirty();
  }

  // ── lights (render §8.1) ──────────────────────────────────────────────────────────────────────────────────────────────

  /** the row's world position and the record's direction (light − target, unit) into `lightPos` / `lightDir` / `lightTarget` */
  function lightPose(n: RowNode, spec: RowLight): void {
    const e = n.matrix.elements;
    lightPos.x = e[12]!;
    lightPos.y = e[13]!;
    lightPos.z = e[14]!;
    const aim = spec.aim;
    let dx = 0;
    let dy = 1;
    let dz = 0;
    if (aim === 'forward') {
      // the row's own −Z after its rotation and its parents': light − target is +Z
      dx = e[8]!;
      dy = e[9]!;
      dz = e[10]!;
    } else if (aim !== null) {
      // a target point in the row's parent space (world for an unparented row)
      const pm = parentMatrix(n);
      let tx = aim.x;
      let ty = aim.y;
      let tz = aim.z;
      if (pm !== null) {
        const q = pm.elements;
        tx = q[0]! * aim.x + q[4]! * aim.y + q[8]! * aim.z + q[12]!;
        ty = q[1]! * aim.x + q[5]! * aim.y + q[9]! * aim.z + q[13]!;
        tz = q[2]! * aim.x + q[6]! * aim.y + q[10]! * aim.z + q[14]!;
      }
      dx = lightPos.x - tx;
      dy = lightPos.y - ty;
      dz = lightPos.z - tz;
    }
    const len = Math.hypot(dx, dy, dz);
    if (len > 0) {
      lightDir.x = dx / len;
      lightDir.y = dy / len;
      lightDir.z = dz / len;
    } else {
      lightDir.x = UP.x;
      lightDir.y = UP.y;
      lightDir.z = UP.z;
    }
    lightTarget.x = lightPos.x - lightDir.x;
    lightTarget.y = lightPos.y - lightDir.y;
    lightTarget.z = lightPos.z - lightDir.z;
  }

  function lightMobility(n: RowNode): LightMobility {
    const lifetime = n.snap.spec['lifetime'];
    if (typeof lifetime === 'number' && lifetime > 0) return 'transient';
    const body = physicsBodyOf(n.snap.props['physics']);
    // a lamp with a flicker behaviour stays in the grid; a light that hangs on something, or has a body, is in the dynamic
    // list from the start (and `setPose` moves any static light there the first time it moves)
    return n.snap.parentId !== null || n.bone !== null || body === 'dynamic' || body === 'kinematic' || body === 'character' ? 'moving' : 'static';
  }

  function lightRecord(n: RowNode, spec: RowLight, intensity: number): LightRecord {
    const authored = rowLightOf(n.snap.spec['light']);
    const mobility = lightMobility(n);
    const rec: LightRecord = {
      kind: spec.kind,
      color: spec.color,
      intensity,
      distance: spec.distance,
      decay: spec.decay,
      position: { x: lightPos.x, y: lightPos.y, z: lightPos.z },
      mobility,
      shadow: spec.shadow,
      source: 'row',
      // a lamp that is dark when it is added (a blackout, a hidden row) keeps its place in the grid and its FlashGuard base
      peakIntensity: Math.max(spec.intensity, authored?.intensity ?? 0),
    };
    if (spec.kind === 'spot') {
      rec.angle = spec.angle;
      rec.penumbra = spec.penumbra;
      rec.direction = { x: lightDir.x, y: lightDir.y, z: lightDir.z };
    }
    // a light row that expires by itself is one pop of something that repeats (a boss beam): its pops share a guard channel
    if (mobility === 'transient') rec.flashKey = `row:${String(n.snap.spec['template'] ?? [...n.snap.tags].sort().join('+'))}:${spec.kind}`;
    return rec;
  }

  /** the row's light in its sink: created on the first call, then written; `moved`: the world matrix changed */
  function syncLight(n: RowNode, moved: boolean): void {
    const l = n.light;
    if (l === null || !n.posed) return;
    const spec = l.spec;
    const want = n.eff ? spec.intensity : 0;
    if (l.sink === 'directional') {
      if (directional === null) return;
      lightPose(n, spec);
      directional.set(l.slot, { color: spec.color, intensity: want, direction: lightDir });
      l.shown = want;
      return;
    }
    if (l.sink === 'shadow') {
      if (shadowSpot === null) return;
      lightPose(n, spec);
      if (l.handle === null) {
        shadowSpot.set(lightRecord(n, spec, want));
        l.handle = 0 as LightHandle;
        l.shown = want;
        shadowSpot.setPose(lightPos, lightTarget);
        return;
      }
      if (moved) shadowSpot.setPose(lightPos, lightTarget);
      if (l.shown !== want) {
        shadowSpot.setIntensity(want);
        l.shown = want;
      }
      return;
    }
    if (lights === null) return;
    if (l.handle === null) {
      lightPose(n, spec);
      try {
        l.handle = lights.add(lightRecord(n, spec, want));
      } catch (e) {
        // a full table (496 static lights) or a record it refuses: the row stays, unlit
        n.light = null;
        log(`light of a row was not added: ${e instanceof Error ? e.message : String(e)}`);
        return;
      }
      l.shown = want;
      lightCount++;
      return;
    }
    if (moved) {
      lightPose(n, spec);
      if (spec.kind === 'spot') lights.setPose(l.handle, lightPos, lightDir);
      else lights.setPose(l.handle, lightPos);
    }
    if (l.shown !== want) {
      lights.setIntensity(l.handle, want);
      l.shown = want;
    }
  }

  function dropLight(n: RowNode): void {
    const l = n.light;
    if (l === null) return;
    n.light = null;
    if (l.sink === 'directional') {
      if (directionalSlots[l.slot] === n) {
        directionalSlots[l.slot] = null;
        directional?.set(l.slot, null);
      }
    } else if (l.sink === 'shadow') {
      if (shadowOwner === n) {
        shadowOwner = null;
        shadowSpot?.off();
      }
    } else if (l.handle !== null && lights !== null) {
      lights.remove(l.handle);
      lightCount--;
    }
  }

  /** reads the row's `light` (on add and on every write): data writes where the table has a setter, a new record otherwise */
  function readLight(n: RowNode): void {
    const spec = rowLightOf(n.snap.props['light']);
    const old = n.light;
    if (spec === null) {
      dropLight(n);
      return;
    }
    if (n.vm) {
      log('a light on a camera-attached row is not drawn (no live row has one)');
      return;
    }
    if (old !== null && !lightShapeDiffers(old.spec, spec) && old.sink !== 'directional') {
      const before = old.spec;
      old.spec = spec;
      if (old.handle !== null) {
        if (!sameColor(before.color, spec.color)) {
          if (old.sink === 'shadow') shadowSpot?.setColor(spec.color);
          else lights?.setColor(old.handle, spec.color);
        }
        // `aim` has no setter of its own: it is part of the pose
        syncLight(n, !sameAim(before.aim, spec.aim));
      }
      return;
    }
    dropLight(n);
    let sink: LightBinding['sink'] = 'table';
    let slot = 0;
    if (spec.kind === 'directional') {
      // the two permanent DirectionalLights (render §4.1): a third moon row has no light to drive
      slot = directionalSlots[0] === null ? 0 : directionalSlots[1] === null ? 1 : -1;
      if (directional === null || slot < 0) {
        log(directional === null ? 'directional light rows need the atmosphere package (R4): not lit' : 'a place has more than two directional light rows: the third is not lit');
        return;
      }
      sink = 'directional';
      directionalSlots[slot] = n;
    } else if (spec.shadow && spec.kind === 'spot' && shadowSpot !== null && shadowOwner === null) {
      sink = 'shadow';
      shadowOwner = n;
    }
    n.light = { spec, handle: null, sink, slot, shown: 0 };
    syncLight(n, true);
  }

  // ── primitives (render §6.7) ──────────────────────────────────────────────────────────────────────────────────────────

  function unitBox(spec: PrimitiveSpec): Float32Array {
    const shape = primitiveShape(spec);
    let box = unitBoxes.get(shape.geometryKey);
    if (box === undefined) {
      const g = shape.create();
      g.computeBoundingBox();
      const b = g.boundingBox!;
      box = new Float32Array([b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z]);
      g.dispose();
      unitBoxes.set(shape.geometryKey, box);
    }
    return box;
  }

  function readPrimitive(n: RowNode): void {
    dropPrimitive(n);
    const props = n.snap.props;
    const spec = primitiveSpecOf(props);
    if (spec === null || n.vm) {
      if (n.ext?.['scriptedMaterial'] !== undefined) {
        n.ext['scriptedMaterial'].dispose();
        delete n.ext['scriptedMaterial'];
      }
      return;
    }
    let shift: [number, number, number] | null = null;
    const pivot = pivotOf(props['pivot']);
    try {
      // pivot is ignored on dynamic bodies (contract §9.1)
      if (pivot !== null && physicsBodyOf(props['physics']) !== 'dynamic') {
        const shape = primitiveShape(spec);
        const unit = unitBox(spec);
        for (let i = 0; i < 6; i++) boxOut[i] = unit[i]! * shape.scale[i % 3]!;
        pivotShift(pivot, boxOut, shiftOut);
        if (shiftOut[0] !== 0 || shiftOut[1] !== 0 || shiftOut[2] !== 0) shift = [shiftOut[0], shiftOut[1], shiftOut[2]];
      } else primitiveShape(spec);
    } catch (e) {
      log(`primitive kind ${JSON.stringify(spec.kind)} is not built: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (props['material'] !== undefined && props['material'] !== null && standardMaterialOf(props) === null) {
      extension(n, 'scriptedMaterial');
      // an opt-in extension that took the row draws it itself: no bucket instance with the default material
      if (n.ext?.['scriptedMaterial'] !== undefined) return;
    } else if (n.ext?.['scriptedMaterial'] !== undefined) {
      n.ext['scriptedMaterial'].dispose();
      delete n.ext['scriptedMaterial'];
    }
    n.prim = { spec, material: standardMaterialOf(props), handle: null, has: false, shift };
    syncPrimitive(n, true);
  }

  function primitiveWorld(n: RowNode, p: PrimBinding): ArrayLike<number> {
    if (p.shift === null) return n.matrix.elements;
    return mPrim.multiplyMatrices(n.matrix, mShift.makeTranslation(p.shift[0], p.shift[1], p.shift[2])).elements;
  }

  /** the row's bucket instance: claimed while the row draws, released while it does not, moved when `moved` */
  function syncPrimitive(n: RowNode, moved: boolean): void {
    const p = n.prim;
    if (p === null || primitives === null || !n.posed) return;
    // a bucket instance has no layer of its own: a third-person-only row is released while the local view is first person
    const want = n.eff && n.renderSelf && !(n.tpo && hiddenBody !== null);
    if (want && !p.has) {
      p.handle = primitives.add(p.spec, p.material, primitiveWorld(n, p));
      p.has = true;
      primCount++;
    } else if (!want && p.has) {
      primitives.remove(p.handle);
      p.handle = null;
      p.has = false;
      primCount--;
    } else if (want && moved) primitives.setMatrix(p.handle, p.spec, primitiveWorld(n, p));
  }

  function dropPrimitive(n: RowNode): void {
    const p = n.prim;
    if (p === null) return;
    n.prim = null;
    if (p.has && primitives !== null) {
      primitives.remove(p.handle);
      primCount--;
    }
  }

  // ── the map (render §6.5) ─────────────────────────────────────────────────────────────────────────────────────────────

  /** `scriptedPivot`: the row's pivot fractions, or null (none, `feet`, or a dynamic body, which ignores it) */
  function scriptedPivotOf(n: RowNode): [number, number, number] | null {
    const raw = n.snap.props['pivot'];
    if (raw === 'feet' || raw === undefined) return null;
    const pivot = pivotOf(raw);
    return pivot === null || physicsBodyOf(n.snap.props['physics']) === 'dynamic' ? null : pivot;
  }

  /** the matrix a single map row is drawn with: the row's, shifted by its pivot when `scriptedPivot` applies */
  function mapMatrix(n: RowNode, map: BridgeMap | null | undefined): ArrayLike<number> {
    if (deps.scriptedPivot !== true || map === null || map === undefined) return n.matrix.elements;
    const pivot = scriptedPivotOf(n);
    const box = pivot === null ? null : (map.rowBox?.(n.id) ?? null);
    if (pivot === null || box === null) return n.matrix.elements;
    pivotShift(pivot, box, shiftOut);
    return pivotMatrix.copy(n.matrix).multiply(pivotTranslate.makeTranslation(shiftOut[0], shiftOut[1], shiftOut[2])).elements;
  }

  function chainDynamic(n: RowNode): boolean {
    for (let p: RowNode | null = n; p !== null; p = p.parent) {
      const s = p.snap;
      if (isDynamicRow({ behavior: s.behavior, physics: s.props['physics'], parent: s.parentId ?? undefined, tags: s.tags }, deps.dynamicTags)) return true;
    }
    return n.waiting !== null;
  }

  function batcherRow(n: RowNode, m: MapBinding, forceDynamic: boolean): BridgeBatcherRow {
    const props = n.snap.props;
    const material = standardMaterialOf(props);
    const row: BridgeBatcherRow = {
      id: n.id,
      key: m.key,
      spec: m.spec,
      m: Float32Array.from(n.matrix.elements),
      dynamic: forceDynamic || chainDynamic(n),
      castShadow: props['castShadow'] !== false,
      visible: m.visible,
    };
    if (deps.scriptedPivot === true && scriptedPivotOf(n) !== null) row.dynamic = true;
    if (deps.rigs === true && (props['mixer'] !== undefined || props['anim'] !== undefined || props['bones'] !== undefined)) row.rigged = true;
    // a texture set or a flat preset of the row replaces the generator's paints: never merged, never instanced
    const look = surfaceParamsFromSpec(material, { source: 'packed', scripted: true });
    if (look.paintSource === 'row' || look.dissolve === true) {
      row.ownLook = true;
      row.material = material;
    } else if (isScriptedMaterialSpec(props['material'])) {
      // R12a (render §14.1): a scripted material draws the row's own meshes (the map's `scriptedMaterial` source)
      row.ownLook = true;
      row.scriptedMaterial = props['material'];
    }
    return row;
  }

  function readMapRow(n: RowNode): void {
    const spec = scriptedSpecOf(n.snap.props);
    if (spec === null) return;
    if (n.vm) {
      log('a scripted primitive on a camera-attached row is not drawn');
      return;
    }
    const place = n.place ?? NO_PLACE;
    n.map = { place, spec, key: keyOf(spec), state: 'pending', single: false, stale: false, respec: false, visible: n.chain && n.renderSelf };
    if (deps.scriptedPivot !== true && pivotOf(n.snap.props['pivot']) !== null && n.snap.props['pivot'] !== 'feet') log('`pivot` on a scripted primitive is not applied (no live row has one)');
    const p = places.get(place);
    // a row spawned during play: the place's map exists, the row joins it as a single row
    if (p !== undefined && p.map !== null && !p.building) addMapRow(n, p);
  }

  /**
   * The row has meshes of its own: the host flushes the paint tables and compiles them. The warm-up rule shows every mesh
   * while it compiles and puts back what it found, so the row's visibility is written again when it is over.
   */
  function settleMap(p: PlaceState, map: BridgeMap, result: unknown, row: BridgeBatcherRow | null, n: RowNode, m: MapBinding): void {
    if (mapHost?.settle === undefined || result === null || result === undefined) return;
    const again = (): void => {
      if (nodes.get(n.id) === n && n.map === m && p.map === map && m.state === 'built' && m.single) map.setRowVisible(n.id, m.visible);
    };
    try {
      void Promise.resolve(mapHost.settle(map, result, row)).then(again, (e: unknown) => log(`map ${p.id}: the upload of a row's own meshes failed: ${e instanceof Error ? e.message : String(e)}`));
    } catch (e) {
      log(`map ${p.id}: the upload of a row's own meshes failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** after an asynchronous map step for a row: is it still this row, this map? */
  const mapStillOf = (n: RowNode, m: MapBinding, p: PlaceState, map: BridgeMap, generation: number): boolean =>
    nodes.get(n.id) === n && n.map === m && p.map === map && p.generation === generation;

  function finishMapStep(n: RowNode, m: MapBinding, map: BridgeMap): void {
    m.state = 'built';
    m.single = map.classOf(n.id) === 'single';
    if (!m.single) return;
    intoScan(n);
    map.setRowMatrix(n.id, mapMatrix(n, map));
    map.setRowVisible(n.id, m.visible);
    m.stale = false;
    if (m.respec) {
      m.respec = false;
      regenerateMapRow(n);
    }
  }

  function addMapRow(n: RowNode, p: PlaceState): void {
    const m = n.map;
    const map = p.map;
    if (m === null || map === null) return;
    m.state = 'busy';
    const generation = p.generation;
    const row = batcherRow(n, m, true);
    map.addRow(row).then(
      (result) => {
        if (!mapStillOf(n, m, p, map, generation)) {
          if (p.map === map) map.removeRow(row.id);
          return;
        }
        finishMapStep(n, m, map);
        settleMap(p, map, result, row, n, m);
      },
      (e: unknown) => log(`map ${p.id}: row ${n.id} was not added: ${e instanceof Error ? e.message : String(e)}`),
    );
  }

  /** promote on write (render §6.5): the batched copy keeps drawing until the row's own meshes exist */
  function promoteMapRow(n: RowNode): void {
    const m = n.map;
    if (m === null || m.single || m.state !== 'built') return;
    const p = places.get(m.place);
    const map = p?.map ?? null;
    if (p === undefined || map === null) return;
    m.state = 'busy';
    const generation = p.generation;
    map.promote(n.id).then(
      (result) => {
        if (!mapStillOf(n, m, p, map, generation)) return;
        finishMapStep(n, m, map);
        settleMap(p, map, result, null, n, m);
      },
      (e: unknown) => {
        m.state = 'built';
        log(`map ${p.id}: row ${n.id} was not promoted: ${e instanceof Error ? e.message : String(e)}`);
      },
    );
  }

  function regenerateMapRow(n: RowNode): void {
    const m = n.map;
    if (m === null) return;
    const spec = scriptedSpecOf(n.snap.props);
    if (spec === null) return;
    if (m.state === 'busy') {
      m.respec = true;
      return;
    }
    m.spec = spec;
    m.key = keyOf(spec);
    if (m.state !== 'built') return;
    const p = places.get(m.place);
    const map = p?.map ?? null;
    if (p === undefined || map === null) return;
    m.state = 'busy';
    const generation = p.generation;
    map.regenerate(n.id, m.key, m.spec).then(
      (result) => {
        if (!mapStillOf(n, m, p, map, generation)) return;
        finishMapStep(n, m, map);
        settleMap(p, map, result, null, n, m);
      },
      (e: unknown) => {
        m.state = 'built';
        log(`map ${p.id}: row ${n.id} was not regenerated: ${e instanceof Error ? e.message : String(e)}`);
      },
    );
  }

  function syncMapVisibility(n: RowNode): void {
    const m = n.map;
    if (m === null) return;
    // the place's own visibility is its group's: only the row's own chain hides a map row
    const want = n.chain && n.renderSelf;
    if (want === m.visible) return;
    m.visible = want;
    if (m.state !== 'built') {
      m.stale = true;
      return;
    }
    if (m.single) places.get(m.place)?.map?.setRowVisible(n.id, want);
    else promoteMapRow(n);
  }

  function dropMapRow(n: RowNode): void {
    const m = n.map;
    if (m === null) return;
    n.map = null;
    if (m.state !== 'pending') places.get(m.place)?.map?.removeRow(n.id);
  }

  // ── models (render §11.4) ─────────────────────────────────────────────────────────────────────────────────────────────

  function dropModel(n: RowNode): void {
    n.modelGen++;
    if (n.claimed || n.handed || handoffWatch.has(n)) {
      // before the model goes: a bake in flight holds it (render §11.5)
      handoffWatch.delete(n);
      n.claimed = false;
      n.handed = false;
      n.rootLocal = null;
      try {
        handoff?.release(n.id);
      } catch (e) {
        log(`handoff release of ${n.id} failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const model = n.model;
    if (model === null) return;
    n.model = null;
    n.driven = false;
    modelCount--;
    try {
      mixer?.unbind?.(model);
    } catch (e) {
      log(`mixer.unbind failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    model.dispose();
  }

  /**
   * The handoff owns the row's model now (a corpse whose bake finished, render §11.5): its mixer keeps the presented pose
   * (X-40) and lets go, the model is forgotten without a dispose (the baker disposed it), and the row's pose goes to the
   * handoff from here on (`applyWorld`), the model root's local matrix included.
   */
  function handOver(n: RowNode): void {
    handoffWatch.delete(n);
    const model = n.model;
    if (model === null) return;
    n.rootLocal = model.root.matrix.clone();
    n.model = null;
    n.driven = false;
    n.handed = true;
    modelCount--;
    try {
      mixer?.release?.(n.id);
      mixer?.unbind?.(model);
    } catch (e) {
      log(`mixer release failed for ${n.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
    handoff!.pose(n.id, mPose.multiplyMatrices(n.matrix, n.rootLocal));
  }

  function fitModel(n: RowNode, model: BridgeModel): void {
    const k = layoutScale(n.snap.props['layout'], models?.size?.(model) ?? null);
    n.modelScale = k;
    model.root.scale.setScalar(k);
    // `pivot` (contract §9.1): the named point of the model's box is the row's origin, so the row turns about it (a dropped
    // gun lies on its side about its middle, `scripts/director/wave.js:577`). `'feet'` is where a model stands anyway; a
    // dynamic body ignores it. The shift is in the row's frame: after the layout's scale, before the row's own.
    let sx = 0;
    let sy = 0;
    let sz = 0;
    const raw = n.snap.props['pivot'];
    const pivot = raw === 'feet' ? null : pivotOf(raw);
    if (pivot !== null && physicsBodyOf(n.snap.props['physics']) !== 'dynamic') {
      const box = models?.box?.(model) ?? null;
      if (box === null) log('`pivot` on a model needs the model\'s rest box: not applied');
      else {
        boxOut[0] = box.min.x * k;
        boxOut[1] = box.min.y * k;
        boxOut[2] = box.min.z * k;
        boxOut[3] = box.max.x * k;
        boxOut[4] = box.max.y * k;
        boxOut[5] = box.max.z * k;
        pivotShift(pivot, boxOut, shiftOut);
        sx = shiftOut[0];
        sy = shiftOut[1];
        sz = shiftOut[2];
      }
    }
    model.root.position.set(sx, sy, sz);
    // `model.forward: '+z'` (contract §9.8; the operators, authored content): the file faces +Z and a row
    // faces −Z, so the root stands half a turn under the row's object. The object stays the row's frame (`ssBody`): motion's
    // IK re-projects with it, and the skin adapter gets the turn through the root's own matrix (X1b, the seam MA4 names).
    const spec = n.snap.props['model'];
    model.root.rotation.y = typeof spec === 'object' && spec !== null && (spec as { forward?: unknown }).forward === '+z' ? Math.PI : 0;
    model.root.updateMatrix();
  }

  function placeModel(n: RowNode, model: BridgeModel): void {
    n.model = model;
    modelCount++;
    model.root.userData['ssRowId'] = n.id;
    if (n.cam) {
      // the viewmodel layer (render §4.3): R8's renderer places the row under this frame's camera
      let driven = false;
      try {
        driven = mixer?.bind(model, { rowId: n.id }) === true;
      } catch (e) {
        log(`mixer.bind failed for ${n.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
      n.driven = driven;
      addViewmodelRoot(n, model, driven);
      return;
    }
    const obj = ensureObject(n);
    // motion's skin adapter reads the row's interpolated transform from here (three-skin.ts SKIN_BODY_KEY)
    model.root.userData['ssBody'] = obj;
    fitModel(n, model);
    obj.add(model.root);
    try {
      n.driven = mixer?.bind(model, { rowId: n.id, body: obj }) === true;
    } catch (e) {
      n.driven = false;
      log(`mixer.bind failed for ${n.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
    models?.setShadow?.(model, n.snap.props['castShadow'] as boolean | undefined, n.snap.props['receiveShadow'] as boolean | undefined);
    n.layerMask = -1;
    applyVisibility(n);
    // the root's world matrix and the bones under it, now: a body is never skinned at the origin for a frame
    if (n.posed) applyWorld(n);
    if (handoff !== null) {
      try {
        if (handoff.placed(n.snap, model)) handoffWatch.add(n);
      } catch (e) {
        log(`handoff of ${n.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
  }

  function readModel(n: RowNode): void {
    dropModel(n);
    const spec = n.snap.props['model'];
    if (spec === undefined || spec === null || models === null) return;
    if (handoff !== null && !n.cam) {
      let claimed = false;
      try {
        claimed = handoff.claim(n.snap, n.matrix);
      } catch (e) {
        log(`handoff claim of ${n.id}: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (claimed) {
        n.claimed = true;
        return;
      }
    }
    const gen = n.modelGen;
    let made: BridgeModel | null | Promise<BridgeModel | null>;
    try {
      made = models.create(n.snap, { viewmodel: n.cam });
    } catch (e) {
      log(`model of ${n.id}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    if (made === null) return;
    if (typeof (made as Promise<BridgeModel | null>).then !== 'function') {
      placeModel(n, made as BridgeModel);
      return;
    }
    (made as Promise<BridgeModel | null>).then(
      (model) => {
        if (model === null) return;
        // the row went, or its model was written again, while the file loaded
        if (nodes.get(n.id) !== n || n.modelGen !== gen || disposed) model.dispose();
        else placeModel(n, model);
      },
      (e: unknown) => log(`model of ${n.id}: ${e instanceof Error ? e.message : String(e)}`),
    );
  }

  // ── the viewmodel layer (render §4.3, X-36) ───────────────────────────────────────────────────────────────────────────

  function addViewmodelRoot(n: RowNode, content: unknown, driven: boolean): void {
    if (viewmodel === null) {
      log('camera-attached rows need the viewmodel renderer (R8): not drawn');
      return;
    }
    if (viewmodel.has(n.id)) viewmodel.remove(n.id);
    try {
      n.vmObject = viewmodel.add(n.snap, content, { pose: driven ? 'external' : 'rest' });
      n.vmAdded = true;
    } catch (e) {
      log(`viewmodel row ${n.id}: ${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    for (const c of n.children) readViewmodelChild(c);
  }

  /** a camera-attached row: its model (`placeModel` adds it to the layer when it has loaded), else what its primitive draws */
  function readCameraRow(n: RowNode): void {
    dropViewmodel(n);
    const model = n.snap.props['model'];
    if (model !== undefined && model !== null && models !== null) {
      readModel(n);
      return;
    }
    dropModel(n);
    let content: Object3D | null = null;
    if (primitiveSpecOf(n.snap.props) !== null) {
      if (vmContent === null) log('a camera-attached primitive needs a viewmodel content factory: not drawn');
      else content = vmContent.create(n.snap);
    }
    n.vmContent = content;
    addViewmodelRoot(n, content ?? new Group(), false);
  }

  /** a row parented to a viewmodel row (camera-attached decal): its object joins the gun's frame with the row's local transform */
  function readViewmodelChild(n: RowNode): void {
    dropViewmodel(n);
    const top = n.parent;
    if (top === null || viewmodel === null || vmContent === null) return;
    if (!top.cam) {
      log('a row two levels below a camera-attached row is not drawn');
      return;
    }
    if (!top.vmAdded) return; // the gun's model is still loading: `addViewmodelRoot` comes back here
    const content = vmContent.create(n.snap);
    if (content === null) return;
    const holder = new Group();
    holder.name = `row:${n.id}`;
    holder.add(content);
    n.vmContent = content;
    n.vmObject = holder;
    writeViewmodelChild(n);
    try {
      n.vmAdded = viewmodel.addChild(n.id, top.id, holder);
    } catch (e) {
      log(`viewmodel row ${n.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function writeViewmodelChild(n: RowNode): void {
    const holder = n.vmObject;
    if (holder === null || n.cam) return;
    const cur = n.snap.cur;
    holder.position.set(cur.pos.x, cur.pos.y, cur.pos.z);
    holder.quaternion.set(cur.rot.x, cur.rot.y, cur.rot.z, cur.rot.w);
    holder.scale.set(cur.scale.x, cur.scale.y, cur.scale.z);
    holder.visible = n.chain && n.renderSelf;
  }

  function dropViewmodel(n: RowNode): void {
    if (n.vmAdded && viewmodel !== null) viewmodel.remove(n.id);
    n.vmAdded = false;
    if (n.vmContent !== null) vmContent?.dispose?.(n.vmContent);
    n.vmContent = null;
    n.vmObject = null;
  }

  // ── fx and the later packages' fields ─────────────────────────────────────────────────────────────────────────────────

  function readFx(n: RowNode, written: boolean): void {
    const spec = n.snap.props['fx'];
    if (spec === undefined || spec === null) {
      n.fx?.end();
      n.fx = null;
      return;
    }
    if (fxSystem === null) return; // the row keeps its transform and draws no effect (R10)
    if (n.fx !== null) {
      if (written) n.fx.restart(spec);
      return;
    }
    if (n.vm) {
      log('an fx on a camera-attached row is not bound');
      return;
    }
    const obj = ensureObject(n);
    try {
      n.fx = fxSystem.bind(n.id, spec, obj);
    } catch (e) {
      log(`fx of ${n.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function extension(n: RowNode, field: RowExtensionField): void {
    const make = deps.extensions?.[field];
    if (make === undefined) {
      log(`\`${field === 'scriptedMaterial' ? 'material: {kind: scripted}' : field}\` rows are a later package's (R12): not drawn`);
      return;
    }
    const had = n.ext?.[field];
    if (had !== undefined) {
      if (had.update !== undefined) {
        had.update(n.snap);
        return;
      }
      had.dispose();
    }
    if (n.vm) return;
    try {
      const binding = make(n.snap, ensureObject(n));
      if (binding !== null) (n.ext ??= {})[field] = binding;
      else if (n.ext !== null) delete n.ext[field];
    } catch (e) {
      log(`${field} of ${n.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function readExtensions(n: RowNode): void {
    const props = n.snap.props;
    for (const field of ['ui', 'spline', 'scatter'] as const) {
      if (props[field] !== undefined && props[field] !== null) extension(n, field);
    }
  }

  // ── visibility, layers (render §16.1, §4.4) ───────────────────────────────────────────────────────────────────────────

  function readFlags(n: RowNode): void {
    const props = n.snap.props;
    n.ownVisible = props['visible'] !== false;
    n.renderSelf = props['render'] !== false;
    const tpo = props['visibleInFirstPerson'] === false;
    if (tpo !== n.tpoOwn) {
      n.tpoOwn = tpo;
      if (tpo) tpoRoots.add(n);
      else tpoRoots.delete(n);
    }
    const range = visibleRangeOf(props['visibleRange']);
    n.range = range;
    if (range === null) {
      n.rangeOk = true;
      ranged.delete(n);
    } else ranged.add(n);
  }

  function applyVisibility(n: RowNode): void {
    if (n.obj !== null) n.obj.visible = n.eff;
    const model = n.model;
    if (model !== null && !n.cam) {
      model.setVisible(n.renderSelf);
      const mask = 1 << (n.tpo ? LAYER_THIRD_PERSON_ONLY : LAYER_WORLD);
      if (mask !== n.layerMask) {
        n.layerMask = mask;
        model.setLayers(mask);
      }
    }
    if (n.prim !== null) syncPrimitive(n, false);
    if (n.light !== null) syncLight(n, false);
    if (n.map !== null) syncMapVisibility(n);
    if (n.vm && !n.cam) writeViewmodelChild(n);
  }

  /** the effective visibility and layer of a row and everything below it */
  function refreshVisibility(root: RowNode): void {
    const todo: RowNode[] = [root];
    while (todo.length > 0) {
      const n = todo.pop()!;
      const p = n.parent;
      n.chain = n.ownVisible && n.rangeOk && !n.orphaned && (p === null || p.chain);
      n.eff = n.chain && (p !== null ? p.eff : placeDraws(n.place ?? NO_PLACE));
      n.tpo = n.tpoOwn || n.id === hiddenBody || (p !== null && p.tpo);
      applyVisibility(n);
      for (let i = 0; i < n.children.length; i++) todo.push(n.children[i]!);
    }
  }

  function setHiddenBody(next: string | null): void {
    if (next === hiddenBody) return;
    const before = hiddenBody;
    hiddenBody = next;
    const a = before === null ? undefined : nodes.get(before);
    const b = next === null ? undefined : nodes.get(next);
    if (a !== undefined) refreshVisibility(a);
    if (b !== undefined) refreshVisibility(b);
    // whether a third-person-only bucket instance draws depends on there being a first-person view at all
    for (const n of tpoRoots) refreshVisibility(n);
  }

  // ── rows in and out ───────────────────────────────────────────────────────────────────────────────────────────────────

  function link(n: RowNode): void {
    const parentId = n.snap.parentId;
    if (parentId === null) {
      n.parent = null;
      n.waiting = null;
      n.orphaned = false;
      return;
    }
    const parent = nodes.get(parentId);
    if (parent === undefined) {
      n.parent = null;
      n.waiting = parentId;
      // until its parent is known a child has no frame to stand in: it draws nothing
      n.orphaned = true;
      let list = orphans.get(parentId);
      if (list === undefined) orphans.set(parentId, (list = []));
      list.push(n);
      return;
    }
    n.parent = parent;
    n.waiting = null;
    n.orphaned = false;
    parent.children.push(n);
  }

  function unlink(n: RowNode): void {
    const parent = n.parent;
    if (parent !== null) {
      const at = parent.children.indexOf(n);
      if (at >= 0) parent.children.splice(at, 1);
      n.parent = null;
    }
    if (n.waiting !== null) {
      const list = orphans.get(n.waiting);
      if (list !== undefined) {
        const at = list.indexOf(n);
        if (at >= 0) list.splice(at, 1);
        if (list.length === 0) orphans.delete(n.waiting);
      }
      n.waiting = null;
    }
  }

  /** which frame the row stands in: the world's, the camera's (the viewmodel layer), or a viewmodel row's */
  function readFrame(n: RowNode): void {
    n.cam = isCameraAttached(n.snap.props);
    n.vm = n.cam || (n.parent !== null && n.parent.vm);
    n.bone = n.vm ? null : attachmentBoneOf(n.snap.props);
  }

  function readWatch(n: RowNode): void {
    const body = physicsBodyOf(n.snap.props['physics']);
    const spec = n.snap.spec;
    // a character body (the player, bots, enemies, bosses) is moved by the controller pass: the writeback is
    // `store.engineWriteTransform`, which records no change, exactly as for a dynamic body
    n.watched = body === 'dynamic' || body === 'kinematic' || body === 'character' || spec['velocity'] !== undefined || spec['angularVelocity'] !== undefined || n.watched;
  }

  /** everything the row draws, from its current values */
  function readContent(n: RowNode): void {
    readFlags(n);
    n.threshold = teleportThresholdOf(n.snap.props['interpolation'], defaultThreshold);
    if (n.cam) {
      readCameraRow(n);
    } else if (n.vm) {
      readViewmodelChild(n);
    } else {
      readMapRow(n);
      readPrimitive(n);
      readModel(n);
    }
    readLight(n);
    readFx(n, false);
    readExtensions(n);
  }

  function dropContent(n: RowNode): void {
    dropLight(n);
    dropPrimitive(n);
    dropMapRow(n);
    // the layer lets go of the row before its model is disposed
    dropViewmodel(n);
    dropModel(n);
    n.fx?.end();
    n.fx = null;
    if (n.ext !== null) {
      for (const b of Object.values(n.ext)) b?.dispose();
      n.ext = null;
    }
  }

  function addRow(r: RowSnapshot): RowNode | null {
    const existing = nodes.get(r.id);
    if (existing !== undefined) {
      // the feed hands out one snapshot per record: the same object is the same row (a place build named it first)
      if (existing.snap === r) return existing;
      // a new record under the id whose removal has not arrived: remove by id, then add
      removeRow(r.id);
    }
    if (isEditorOnly(r)) {
      skipped.add(r.id);
      return null;
    }
    skipped.delete(r.id);
    const n = new RowNode(r);
    nodes.set(r.id, n);
    link(n);
    readFrame(n);
    setLate(n);
    readWatch(n);
    const cur = r.cur;
    n.addPos = cur.pos;
    n.addRot = cur.rot;
    // the visibility a row's content is created under: its own flags and its ancestors'
    readFlags(n);
    const p = n.parent;
    n.chain = n.ownVisible && !n.orphaned && (p === null || p.chain);
    n.eff = n.chain && (p !== null ? p.eff : placeDraws(n.place ?? NO_PLACE));
    n.tpo = n.tpoOwn || n.id === hiddenBody || (p !== null && p.tpo);
    readContent(n);
    intoScan(n);
    // children that arrived first take their place under it
    const waiting = orphans.get(r.id);
    if (waiting !== undefined) {
      orphans.delete(r.id);
      for (const c of waiting) adopt(c, n);
    }
    return n;
  }

  /** a child whose parent has (re)appeared */
  function adopt(c: RowNode, parent: RowNode): void {
    c.waiting = null;
    c.orphaned = false;
    c.parent = parent;
    parent.children.push(c);
    const wasVm = c.vm;
    readFrame(c);
    setLate(c);
    if (c.vm !== wasVm) {
      dropContent(c);
      readContent(c);
    }
    c.posed = false;
    intoScan(c);
    refreshVisibility(c);
  }

  function removeRow(id: string): void {
    skipped.delete(id);
    const n = nodes.get(id);
    if (n === undefined) return;
    // its children are removed by their own events (in any order): until then they have no frame and draw nothing
    const children = n.children.splice(0);
    for (const c of children) {
      c.parent = null;
      c.waiting = id;
      c.orphaned = true;
      let list = orphans.get(id);
      if (list === undefined) orphans.set(id, (list = []));
      list.push(c);
      refreshVisibility(c);
    }
    unlink(n);
    dropContent(n);
    if (n.obj !== null) {
      n.obj.removeFromParent();
      n.obj = null;
      objectCount--;
    }
    outOfScan(n, false);
    outOfIdle(n);
    riders.delete(n);
    ranged.delete(n);
    tpoRoots.delete(n);
    nodes.delete(id);
  }

  function reparent(n: RowNode): void {
    unlink(n);
    link(n);
    const wasVm = n.vm;
    readFrame(n);
    setLate(n);
    if (n.vm !== wasVm) {
      dropContent(n);
      readContent(n);
    }
    n.posed = false;
    intoScan(n);
    refreshVisibility(n);
    // a light's mobility follows what it hangs on; its record says so only at creation, and `setPose` moves a static one
  }

  function changeRow(r: RowSnapshot, fields: readonly string[]): void {
    const n = nodes.get(r.id);
    if (n === undefined) {
      // an editor row that became visible to everyone; any other unknown row is one the feed never added
      if (skipped.has(r.id) && !isEditorOnly(r)) addRow(r);
      return;
    }
    n.snap = r;
    let transform = false;
    let flags = false;
    let promote = false;
    for (const field of fields) {
      if (TRANSFORM_FIELDS.has(field)) transform = true;
      if (PROMOTE_FIELDS.has(field)) promote = true;
      switch (field) {
        case 'feetPosition':
          if (isCameraAttached(r.props) !== n.cam) {
            // the row moved between the world and the camera's frame: everything it and its children draw is built for
            // the other one. Its children are adopted again by the new node.
            removeRow(r.id);
            addRow(r);
            return;
          }
          break;
        case 'rotation':
        case 'yaw':
        case 'scale':
          break;
        case 'velocity':
        case 'angularVelocity':
          n.watched = true;
          transform = true;
          break;
        case 'physics':
          readWatch(n);
          transform = true;
          break;
        case 'interpolation':
          n.threshold = teleportThresholdOf(r.props['interpolation'], defaultThreshold);
          break;
        case 'parent':
          reparent(n);
          break;
        case 'place': {
          n.place = r.place;
          if (n.obj !== null) placeOf(n.place).group.add(n.obj);
          flags = true;
          break;
        }
        case 'attachment':
          readFrame(n);
          setLate(n);
          n.posed = false;
          transform = true;
          break;
        case 'visible':
        case 'render':
        case 'visibleInFirstPerson':
        case 'visibleRange':
          flags = true;
          break;
        case 'visibleTo':
          if (isEditorOnly(r)) {
            removeRow(r.id);
            skipped.add(r.id);
            return;
          }
          break;
        case 'castShadow':
        case 'receiveShadow':
          if (n.model !== null) models?.setShadow?.(n.model, r.props['castShadow'] as boolean | undefined, r.props['receiveShadow'] as boolean | undefined);
          break;
        case 'pivot':
        case 'anchor':
          if (n.prim !== null || primitiveSpecOf(r.props) !== null) readPrimitive(n);
          // a model's pivot is part of its fit
          if (field === 'pivot' && n.model !== null && !n.cam) {
            fitModel(n, n.model);
            n.posed = false;
            transform = true;
          }
          break;
        case 'layout':
          if (n.model !== null && !n.cam) {
            fitModel(n, n.model);
            n.posed = false;
            transform = true;
          }
          break;
        case 'primitive':
          if (n.vm) {
            if (n.cam) readCameraRow(n);
            else readViewmodelChild(n);
          } else if (n.map !== null && scriptedSpecOf(r.props) !== null) regenerateMapRow(n);
          else {
            dropMapRow(n);
            readMapRow(n);
            readPrimitive(n);
          }
          break;
        case 'material':
          if (n.vm) {
            if (n.vmContent !== null && vmContent?.setMaterial !== undefined) vmContent.setMaterial(n.vmContent, r);
          } else if (n.ext?.['scriptedMaterial'] !== undefined || (deps.extensions?.scriptedMaterial !== undefined && isScriptedMaterialSpec(r.props['material']) && primitiveSpecOf(r.props) !== null)) readPrimitive(n);
          else if (n.prim !== null) writePrimitiveMaterial(n, n.prim);
          else if (n.map !== null && n.map.single && n.map.state === 'built') places.get(n.map.place)?.map?.setRowMaterial?.(n.id, standardMaterialOf(r.props));
          break;
        case 'model':
          if (n.model !== null && models?.update?.(n.model, r) === true) break;
          if (n.cam) readCameraRow(n);
          else readModel(n);
          break;
        case 'light':
          readLight(n);
          break;
        case 'fx':
          readFx(n, true);
          break;
        case 'ui':
        case 'spline':
        case 'scatter':
          if (r.props[field] === undefined || r.props[field] === null) {
            n.ext?.[field]?.dispose();
            if (n.ext !== null) delete n.ext[field];
          } else extension(n, field);
          break;
        default:
          // K3: with rigs on, `bones` is read by the batcher row (`rigged`) and the mixer: no warning
          if (field === 'bones' && deps.rigs === true) break;
          if (!BRIDGE_FIELDS.has(field) && !FOREIGN_FIELDS.has(field) && !CAMERA_RIG_FIELDS.has(field)) log(`a write of \`${field}\` reached the render bridge: the field has no renderer`);
      }
    }
    if (flags) {
      readFlags(n);
      refreshVisibility(n);
    }
    if (promote && n.map !== null && !n.map.single) promoteMapRow(n);
    if (transform) {
      if (n.vm) {
        if (!n.cam) writeViewmodelChild(n);
      } else intoScan(n);
    }
  }

  function writePrimitiveMaterial(n: RowNode, p: PrimBinding): void {
    const material = standardMaterialOf(n.snap.props);
    p.material = material;
    if (!p.has || primitives === null) return;
    try {
      primitives.setMaterial(p.handle, material);
    } catch {
      // the material belongs to another bucket (a texture, `transparent`, `side`, …): release and claim
      primitives.remove(p.handle);
      p.has = false;
      primCount--;
      syncPrimitive(n, true);
    }
  }

  const sink = {
    added(r: RowSnapshot): void {
      addRow(r);
    },
    changed(r: RowSnapshot, fields: readonly string[]): void {
      changeRow(r, fields);
    },
    removed(id: string): void {
      removeRow(id);
    },
  };

  function drain(): void {
    drained = true;
    if (feed === null || disposed) return;
    feed.drain(sink);
  }

  // ── the frame ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  function afterPose(frame: Pick<FrameInfo, 'alpha' | 'paused'>): void {
    if (disposed) return;
    void frame;
    // rows on bones: the skin write gave the bones this frame's world matrices
    if (riders.size > 0) {
      stamp++;
      dirty.length = 0;
      for (const r of riders) {
        // a rider's own local pose rarely changes; its bone does every frame
        present(r, lastAlpha);
        markDirty(r, true);
      }
      flushDirty();
    }
    // visibleRange: metres from the camera to the row
    if (ranged.size > 0) {
      for (const n of ranged) {
        const range = n.range!;
        const e = n.matrix.elements;
        const d = Math.hypot(e[12]! - camPos.x, e[13]! - camPos.y, e[14]! - camPos.z);
        const ok = d >= range.min && d <= range.max;
        if (ok !== n.rangeOk) {
          n.rangeOk = ok;
          refreshVisibility(n);
        }
      }
    }
    for (const p of places.values()) {
      if (p.map !== null && p.group.visible) p.map.update(camPos, false, cut);
    }
    cut = false;
    primitives?.flush();
  }

  function update(frame: FrameInfo): void {
    if (disposed) return;
    if (!drained) drain();
    drained = false;
    movedLast = 0;
    // a paused frame presents what the last running one did: the tick clock stands, so does alpha
    const alpha = frame.paused ? lastAlpha : clampAlpha(frame.alpha);
    lastAlpha = alpha;
    const cam = deps.camera.world;
    cam.updateWorldMatrix(true, false);
    const ce = cam.matrixWorld.elements;
    camPos.x = ce[12]!;
    camPos.y = ce[13]!;
    camPos.z = ce[14]!;
    setHiddenBody(deps.camera.hiddenBody ?? null);
    // R7: corpses whose bake finished in the last frame's `corpses` stage leave the model path before this frame poses
    if (handoffWatch.size > 0) for (const n of handoffWatch) if (handoff!.owns(n.id)) handOver(n);
    poseRows(alpha);
    // the viewmodel layer: after the camera's pose, before the skin write (render §16.3)
    viewmodel?.update(frame);
    if (deps.hostAfterPose !== true) afterPose(frame);
  }

  // ── places ────────────────────────────────────────────────────────────────────────────────────────────────────────────

  async function loadStaticPlace(rows: readonly RowSnapshot[], progress: (f: number) => void, place?: string): Promise<void> {
    if (disposed) return;
    if (rows.length === 0 && place === undefined) {
      progress(1);
      return;
    }
    const placeId = place ?? rows[0]!.place ?? NO_PLACE;
    const p = placeOf(placeId);
    for (const r of rows) addRow(r);
    // every row of the place at its current pose: lights are in the table and scripted rows have their world matrices
    poseRows(1);
    let bounds: { min: Vec3; max: Vec3 } | null = null;
    for (const r of rows) {
      const n = nodes.get(r.id);
      if (n === undefined || n.parent !== null || n.vm || n.waiting !== null) continue;
      const e = n.matrix.elements;
      if (bounds === null) bounds = { min: { x: e[12]!, y: e[13]!, z: e[14]! }, max: { x: e[12]!, y: e[13]!, z: e[14]! } };
      else {
        bounds.min.x = Math.min(bounds.min.x, e[12]!);
        bounds.min.y = Math.min(bounds.min.y, e[13]!);
        bounds.min.z = Math.min(bounds.min.z, e[14]!);
        bounds.max.x = Math.max(bounds.max.x, e[12]!);
        bounds.max.y = Math.max(bounds.max.y, e[13]!);
        bounds.max.z = Math.max(bounds.max.z, e[14]!);
      }
    }
    deps.onPlaceBounds?.(placeId, bounds);
    if (mapHost === null) {
      progress(1);
      return;
    }
    if (p.map !== null || p.building) {
      log(`place ${placeId} was built twice without a dispose between: the second build is ignored`);
      progress(1);
      return;
    }
    const built: Array<[RowNode, MapBinding]> = [];
    const batch: BridgeBatcherRow[] = [];
    for (const n of nodes.values()) {
      const m = n.map;
      if (m === null || m.place !== placeId || m.state !== 'pending') continue;
      m.state = 'busy';
      m.stale = false;
      built.push([n, m]);
      batch.push(batcherRow(n, m, false));
    }
    const generation = p.generation;
    p.building = true;
    let map: BridgeMap;
    try {
      map = await mapHost.build(placeId, batch, progress);
    } catch (e) {
      if (p.generation === generation) {
        p.building = false;
        for (const [, m] of built) m.state = 'pending';
      }
      throw e;
    }
    if (p.generation !== generation || disposed) {
      // the place was disposed while it built
      map.dispose();
      return;
    }
    p.building = false;
    p.map = map;
    p.group.add(map.root);
    for (let i = 0; i < built.length; i++) {
      const [n, m] = built[i]!;
      if (nodes.get(n.id) !== n || n.map !== m) {
        // the row went (or changed its primitive) while the place built
        map.removeRow(batch[i]!.id);
        continue;
      }
      m.state = 'built';
      m.single = map.classOf(n.id) === 'single';
      if (m.single) {
        intoScan(n);
        if (m.stale) {
          map.setRowMatrix(n.id, mapMatrix(n, map));
          map.setRowVisible(n.id, m.visible);
        } else if (deps.scriptedPivot === true && scriptedPivotOf(n) !== null) map.setRowMatrix(n.id, mapMatrix(n, map));
      } else if (m.stale || m.visible !== (batch[i]!.visible !== false)) promoteMapRow(n);
      m.stale = false;
      if (m.respec) {
        m.respec = false;
        regenerateMapRow(n);
      }
    }
    // scripted rows of the place that were spawned while it built
    for (const n of nodes.values()) {
      if (n.map !== null && n.map.place === placeId && n.map.state === 'pending') addMapRow(n, p);
    }
    cut = true;
    progress(1);
  }

  function activate(place: string): void {
    if (activePlace === place) return;
    activePlace = place;
    for (const p of places.values()) p.group.visible = placeDraws(p.id);
    for (const n of nodes.values()) if (n.parent === null) refreshVisibility(n);
    cut = true;
  }

  function disposePlace(place: string): void {
    const p = places.get(place);
    const gone: string[] = [];
    const left: RowNode[] = [];
    for (const n of nodes.values()) {
      if ((n.place ?? NO_PLACE) !== place) continue;
      // A row that left the place before it was unloaded stays: the place manager moves the travellers (the player's body,
      // the camera rig, what they made, and their subtrees: core places/manager.ts `#move`) into the target place first and
      // unloads the old one after, while the feed reports the move as a change of `place` only at the next drain. Removing
      // such a row here would lose it for good (the feed has given it to the sink already): the local body had no bridge node,
      // and its torch (team-glow.js), its shadowCaster and everything else parented to it were orphans that drew nothing.
      if ((n.snap.place ?? NO_PLACE) !== place) left.push(n);
      else gone.push(n.id);
    }
    for (const n of left) changeRow(n.snap, ['place']);
    for (const id of gone) removeRow(id);
    if (p === undefined) return;
    p.generation++;
    p.building = false;
    if (p.map !== null) {
      p.map.root.removeFromParent();
      p.map.dispose();
      p.map = null;
    }
    p.group.removeFromParent();
    places.delete(place);
    if (activePlace === place) activePlace = null;
  }

  return {
    attach(next: RowFeed): void {
      feed = next;
    },
    loadStaticPlace,
    update,
    drain,
    afterPose,
    activate,
    disposePlace,

    bounds(rowId) {
      const n = nodes.get(rowId);
      if (n === undefined || n.model === null || n.cam) return undefined;
      const size = models?.size?.(n.model) ?? null;
      if (size === null) return undefined;
      const k = n.modelScale;
      // the model's box in its root frame: the rest box where the seam gives it, else its size stood on the origin
      const box = models?.box?.(n.model) ?? null;
      const x0 = box !== null ? box.min.x * k : (-size.x * k) / 2;
      const x1 = box !== null ? box.max.x * k : (size.x * k) / 2;
      const y0 = box !== null ? box.min.y * k : 0;
      const y1 = box !== null ? box.max.y * k : size.y * k;
      const z0 = box !== null ? box.min.z * k : (-size.z * k) / 2;
      const z1 = box !== null ? box.max.z * k : (size.z * k) / 2;
      // where the model's root stands in the row's frame: the pivot's shift (zero without one)
      const o = n.model.root.position;
      const min = { x: Infinity, y: Infinity, z: Infinity };
      const max = { x: -Infinity, y: -Infinity, z: -Infinity };
      for (let i = 0; i < 8; i++) {
        vPos.set(o.x + (i & 1 ? x1 : x0), o.y + (i & 2 ? y1 : y0), o.z + (i & 4 ? z1 : z0)).applyMatrix4(n.matrix);
        min.x = Math.min(min.x, vPos.x);
        min.y = Math.min(min.y, vPos.y);
        min.z = Math.min(min.z, vPos.z);
        max.x = Math.max(max.x, vPos.x);
        max.y = Math.max(max.y, vPos.y);
        max.z = Math.max(max.z, vPos.z);
      }
      return { min, max };
    },

    socket(rowId, name) {
      const n = nodes.get(rowId);
      const position = { x: 0, y: 0, z: 0 };
      if (n === undefined || n.model === null || n.model.socketWorld?.(name, position) !== true) return null;
      // the socket's own axes are not kept by the model template: the row's facing is the best direction there is
      const e = n.matrix.elements;
      const len = Math.hypot(e[8]!, e[9]!, e[10]!) || 1;
      return { position, direction: { x: -e[8]! / len + 0, y: -e[9]! / len + 0, z: -e[10]! / len + 0 }, confidence: 0.5 };
    },

    cameraCut(): void {
      cut = true;
    },

    setFxSystem(next: FxSystem | null): void {
      if (next === fxSystem) return;
      for (const n of nodes.values()) {
        n.fx?.end();
        n.fx = null;
      }
      fxSystem = next;
      if (next !== null) for (const n of nodes.values()) readFx(n, false);
    },

    setRowOffset(rowId, offset): void {
      const n = nodes.get(rowId);
      if (n === undefined || n.vm) return;
      if (offset === null) {
        if (n.offset === null) return;
        n.offset = null;
        // one more look, to put the row back where it stands
        n.atRest = false;
      } else {
        const o = (n.offset ??= { x: 0, y: 0, z: 0 });
        o.x = offset.x;
        o.y = offset.y;
        o.z = offset.z;
      }
      intoScan(n);
    },

    setRowScale(rowId, factor): void {
      const n = nodes.get(rowId);
      if (n === undefined || n.vm) return;
      if (factor === null) {
        if (n.scaleMul === null) return;
        n.scaleMul = null;
        n.atRest = false;
      } else {
        const f = (n.scaleMul ??= { x: 1, y: 1, z: 1 });
        f.x = factor.x;
        f.y = factor.y;
        f.z = factor.z;
      }
      intoScan(n);
    },

    node: (rowId) => nodes.get(rowId),
    rowMeshes(rowId) {
      const n = nodes.get(rowId);
      const m = n?.map ?? null;
      if (n === undefined || m === null || m.state !== 'built') return null;
      const map = places.get(m.place)?.map ?? null;
      if (map === null) return null;
      if (!m.single) {
        promoteMapRow(n);
        return null;
      }
      return map.rowMeshes?.(rowId) ?? null;
    },
    has: (rowId) => nodes.has(rowId),
    mapOf: (place) => places.get(place)?.map ?? null,

    stats(): RenderBridgeStats {
      return { rows: nodes.size, objects: objectCount, scanned: scan.length, moved: movedLast, lights: lightCount, primitives: primCount, models: modelCount };
    },

    dispose(): void {
      if (disposed) return;
      for (const id of [...nodes.keys()]) removeRow(id);
      for (const p of places.values()) {
        p.generation++;
        if (p.map !== null) {
          p.map.root.removeFromParent();
          p.map.dispose();
        }
        p.group.removeFromParent();
      }
      places.clear();
      orphans.clear();
      skipped.clear();
      feed = null;
      disposed = true;
    },
  };
}
