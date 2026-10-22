// What the kernel needs from the other domains (docs/architecture.md §3.0; docs/design/core-runtime.md §15).
//
// Type-only module. Every port has a null implementation in null-ports.ts so the kernel runs headless. Ports never call back
// into game code directly; they go through the kernel APIs. Acts are not a port: domains register on `kernel.acts` (X-12).
// The port payload types owned by other domains (ColliderPack and NavGrid: motion §4.3, §7.2; TerrainBake: render §21; the
// Platform interface: build §6.1) are declared here as the shapes those documents give, so the kernel and the producers share
// one definition; the producing package imports them from here.
import type {
  ActName,
  AssetFacts,
  InputsDef,
  InputState,
  NormalisedAudience,
  ObjectSpec,
  PlaceId,
  Quat,
  RowId,
  RowRec,
  TreePath,
  Vec3,
  VmId,
} from './types.ts';

/** docs/architecture.md §3.0; missing ports get null implementations (KernelOptions.ports) */
export interface KernelPorts {
  physics: PhysicsPort;
  motion: MotionPort;
  scene: SceneSyncPort;
  attach: AttachmentResolver;
  input: InputPort;
  camera: CameraPort;
  assets: AssetFactsPort;
  ui: UiPort;
  platform: HostPlatform;
}

// ── place bakes (X-06) ───────────────────────────────────────────────────────────────────────────────────────────────

/** X-06: per-place build products, fetched from asset group `map:<p>` by AssetFactsPort.placeBake */
export interface PlaceBake {
  /** motion §4.3: static + kinematic/mutable instances */
  colliders: ColliderPack;
  /** motion §7.2; null → baked at load in a worker (X-31) */
  navgrid: NavGrid | null;
  /** mire-island heights + 6-way weights (render §14.3) */
  terrain: TerrainBake | null;
}

/** motion §4.3: the build-time collider pack of one place (`tools/maps/bake-place.ts`) */
export interface ColliderPack {
  place: PlaceId;
  /** local-space collider soups, one per (script, params, seed) key */
  keys: Array<{ id: string; tris?: Float32Array; box?: [number, number, number]; sphere?: number }>;
  instances: Array<{
    rowId: RowId;
    /** index into `keys` */
    key: number;
    /** 12 floats: 3×4 world transform */
    m: Float32Array;
    /** the row has a behavior (it may write physics, transform or primitive later) */
    mutable: boolean;
    kinematic: boolean;
    /** X-45: the row (or an ancestor) renders nothing, or is tagged `bounds` */
    noDecal: boolean;
  }>;
  /** X-43: doorwreck shard / stump colliders, answered synchronously by GeometryService.colliderForSync */
  runtimeKeys: Array<{ spec: string; key: number }>;
  /** mire-island heightmap, id `terrain/<place>` */
  terrain?: { tris: Float32Array; id: string };
}

/** motion §7.2 */
export interface NavGridHeader {
  version: 1;
  place: PlaceId;
  cell: 0.25;
  originX: number;
  originZ: number;
  nx: number;
  nz: number;
  spanCount: number;
  componentCount: number;
  bakeStep: 0.45;
  bakeHash: string;
}

/** motion §7.2: multi-level 2.5D walkable spans at 0.25 m cells (implemented by nav/navgrid.ts, WP NV1) */
export interface NavGrid {
  readonly h: NavGridHeader;
  /** nx*nz+1 CSR offsets into the span arrays (spans sorted by y within a column) */
  readonly colStart: Uint32Array;
  /** floor height, cm */
  readonly y: Int16Array;
  /** free height above the floor, 5 cm units (255 = ≥ 12.75 m) */
  readonly clear: Uint8Array;
  /** degrees of the steepest triangle under the cell's floor */
  readonly slope: Uint8Array;
  /** distance to the nearest wall edge, 2 cm units (255 = ≥ 5.1 m) */
  readonly wall: Uint8Array;
  /** connected component under the permissive class */
  readonly comp: Uint16Array;
  spansAt(ix: number, iz: number): [start: number, end: number];
  /** span index or -1 */
  locate(p: Vec3, maxUp: number, maxDown: number): number;
}

/** render §21; the material table is the render domain's (render §14.3) */
export type TerrainMaterialDef = Readonly<Record<string, unknown>>;

/** render §21: mire-island terrain baked by MP1 from MP0's HeightmapSampler */
export interface TerrainBake {
  heights: Float32Array;
  size: [number, number];
  cell: number;
  /** 6 per vertex */
  weights: Uint8Array;
  materials: TerrainMaterialDef[];
}

// ── physics (motion §5.1, core §15.1) ────────────────────────────────────────────────────────────────────────────────

/** X-42: render-only LOD-5 hulls of non-physics rows for `hits: 'both'` raycasts */
export interface VisualProxySoup {
  /** LOD-5 hull per key */
  keys: ReadonlyArray<{ key: string; tris: Float32Array }>;
  /** m: 4×4 world */
  instances: ReadonlyArray<{ key: string; rowId: RowId; m: Float32Array }>;
}

export interface PhysicsPort {
  /** sim-side load: static BVH, instanced bodies, nav (X-05, X-32) */
  buildPlace(place: PlaceId, bake: PlaceBake): void;
  disposePlace(place: PlaceId): void;
  /** create a body from row.props.physics at the next step */
  rowSpawned(row: RowRec): void;
  rowDestroyed(row: RowRec): void;
  /** `physics` channel: rebuild ("kinematic" swap, capsule swap) */
  onPhysicsWrite(row: RowRec, value: unknown): void;
  setPosition(row: RowRec, p: Vec3): void;
  setRotation(row: RowRec, q: Quat): void;
  setVelocity(row: RowRec, v: Vec3): void;
  setAngularVelocity(row: RowRec, w: Vec3): void;
  setForce(row: RowRec, key: string, f: unknown | null): void;
  setSpectating(row: RowRec, on: boolean): void;
  /** `ctx.place.gravity = v` (opt-in ext.gravitySetter): the place's world takes this gravity now and for later builds */
  setGravity?(place: PlaceId, g: Vec3): void;
  /** the gravity the port holds for `place` (a written one, else its config's), null when it has none; read by `ctx.place.gravity` under ext.gravitySetter */
  gravityOf?(place: PlaceId): Vec3 | null;
  /** the `impulse` act; a body that does not exist yet gets nothing (as live) */
  applyImpulse(target: RowId, impulse?: Vec3, angularImpulse?: Vec3, position?: Vec3): void;
  /** then writes back each moved body through store.engineWriteTransform */
  step(place: PlaceId, dtS: number): void;
  /** the kernel dispatches onTriggerEnter */
  drainTriggerEnters(): Array<{ trigger: RowId; other: RowId }>;
  /** PositionSpec without y; null = nothing under (x, z) or the place is not built */
  groundY(place: PlaceId, x: number, z: number): number | null;
  /** each VM's world handle (both point at the same world in v1, motion §5.1) */
  readonly vmWorlds: Record<VmId, unknown>;
  /** X-42 */
  setVisualProxies(place: PlaceId, proxies: VisualProxySoup): void;
}

/** motion §3.11: tick step H */
export interface MotionPort {
  advanceTick(dtS: number): void;
}

/** motion §3.8 */
export interface AttachmentResolver {
  /** world pose of a row with props.attachment (bone, socket, part); null → fall back to the parent's world pose */
  worldPose(row: RowRec): { pos: Vec3; rot: Quat } | null;
}

// ── render (X-14, core §15.2) ────────────────────────────────────────────────────────────────────────────────────────

export interface SceneSyncPort {
  buildPlace(place: PlaceId, rows: Iterable<RowRec>, bake: PlaceBake, onProgress: (f: number) => void): Promise<void>;
  disposePlace(place: PlaceId): void;
  activate(place: PlaceId): void;
  /** ObjectView.bounds */
  bounds(row: RowRec): { min: Vec3; max: Vec3 } | undefined;
  socket(rowId: RowId, name: string): { position: Vec3; direction: Vec3; confidence: number } | null;
}

/** read-only view of a RowRec (no copies) */
export interface RowSnapshot {
  readonly id: RowId;
  readonly place: PlaceId | null;
  readonly parentId: RowId | null;
  readonly tags: readonly string[];
  readonly behavior: readonly TreePath[];
  readonly spec: Readonly<ObjectSpec>;
  readonly props: Readonly<Record<string, unknown>>;
  /** last two tick transforms */
  readonly prev: { pos: Vec3; rot: Quat };
  readonly cur: { pos: Vec3; rot: Quat; scale: Vec3 };
}

/** X-14: the render domain's view of row lifecycle and writes, drained once per frame by renderer.update */
export interface RowFeed {
  drain(sink: {
    added(r: RowSnapshot): void;
    /** top-level fields written since the last drain, in write order */
    changed(r: RowSnapshot, fields: readonly string[]): void;
    removed(id: RowId): void;
  }): void;
}

// ── input, camera, UI (X-15, io; core §15.7-15.8) ────────────────────────────────────────────────────────────────────

/** implemented by io's InputLog + ActionSink (X-15) */
export interface InputPort {
  /** body delivery: edges since the previous tick sample; axes; pointer */
  sampleTick(): InputState;
  /** the rig's per-frame delivery, incl. the `axes.lookX` / `axes.lookY` deltas (contract §11.3) */
  sampleRig(): InputState;
  /** sendAction; false when the action is not declared (dropped silently, contract §12.2) */
  injectAction(name: string, payload: unknown, opts?: { down?: boolean; relockPointer?: boolean }): boolean;
  /** spectating body: devices blocked, data channels pass */
  setBlocked(consumer: 'body' | 'rig', blocked: boolean): void;
  /** after a pause */
  discardEdges(): void;
  /** world.inputs (after import edits E04/E-IN-01 and settings.binds) */
  readonly declared: InputsDef;
}

/** implemented by io's RigHost */
export interface CameraPort {
  /** ctx.view.camera; null before the first camera frame */
  presentedCamera(): { eye: Vec3; aim: Vec3; fov: number } | null;
  /** rig ctx.self.view; undefined before frame 1 */
  view(): { yaw: number; pitch: number } | undefined;
  /** ctx.world.camera */
  worldCamera(): { aspect?: number; fov?: number };
}

export interface UiPort {
  /** called at tick end when a watched store changed */
  markDirty(): void;
  /** the `uiEvent` act → window.spawn.on subscribers */
  uiEvent(name: string, payload: unknown): void;
}

// ── assets (build §5.9, X-06; core §15.9) ────────────────────────────────────────────────────────────────────────────

export interface AssetFactsPort {
  /** ctx.world.assets[ref] (bounds, gait, clips, …) */
  get(ref: string): AssetFacts | undefined;
  /** X-06: inflates the place's baked colliders / navgrid / terrain */
  placeBake(place: PlaceId): Promise<PlaceBake>;
}

// ── host platform ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface SaveStore {
  /** resolved after the one initial read */
  readonly ready: Promise<void>;
  get(key: string): string | null;
  /** write-through (X-16: core DurableState is the only debounce); never '' (Bridge deletes on '') */
  set(key: string, value: string): void;
  remove(key: string): void;
  flush(): Promise<void>;
}
/** Identity supplied by a host adapter. */
export interface PlatformUser {
  id: string | null;
  name: string;
  loggedIn: boolean;
}
export interface HostPlatformEvents { platformPause: (paused: boolean) => void }
/** The kernel needs storage, identity and loading only. Pause events are optional. */
export interface HostPlatform {
  readonly save: SaveStore;
  init(): Promise<void>;
  setLoadingProgress(pct: number): void;
  getUser(): Promise<PlatformUser | null>;
  readonly platformPaused?: boolean;
  on?<K extends keyof HostPlatformEvents>(ev: K, cb: HostPlatformEvents[K]): () => void;
}
export type { AdKind, Placement, AdFailure, AdResult, MatchEventType, MatchEvent, DeviceInfo, PlatformPolicy, PlatformEvents, Platform } from '../../platform/platform.ts';

// ── acts (X-12, core §8.6) ───────────────────────────────────────────────────────────────────────────────────────────

export interface ActEnvelope {
  name: ActName;
  /** cloneWire(payload) at emit (the game may reuse the object it emitted) */
  payload: unknown;
  /** 'snd-<n>' for playSound, 'fx-<n>' for fx, else null */
  id: string | null;
  sourceId: RowId | null;
  sourcePlace: PlaceId | null;
  /** emit options as given, the audience in its `{kind}` form */
  audience: NormalisedAudience | null;
  place: PlaceId | null;
}

/** X-12: one handler per act name, registered by the owning domain at boot (implemented by events/acts.ts, WP C2) */
export interface ActRouter {
  register(name: ActName, handler: (a: ActEnvelope) => void): () => void;
  /** ctx.destroy('fx-…'), stopSound */
  registerEnd(prefix: 'snd-' | 'fx-', handler: (actId: string) => void): () => void;
}
