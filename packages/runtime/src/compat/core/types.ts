// Public types of the compat kernel (docs/architecture.md §3.0 canonical interfaces; docs/design/core-runtime.md §3).
//
// Type-only module: import it with `import type`. Besides the value, row, handle and ctx types, it declares the interfaces
// of the kernel's subsystems (SimClock, RowStore, EventBus, PlaceManager, ModuleRegistry, VirtualMachine, LayeredValue) so
// every package codes against them before the implementing module lands. Implementations are named `<Interface>Impl`
// (motion's `PhysicsPortImpl` convention). The shapes of docs/architecture.md §3.0 are frozen: changing one needs an
// interface-change PR (docs/architecture.md §9.1, §10 rule 3). Everything else here may be refined by the package that
// implements it.
import type { ActRouter, KernelPorts, RowFeed } from './ports.ts';

// ── value types (core §3.1; contract §1) ─────────────────────────────────────────────────────────────────────────────

/** metres; +Y up, −Z forward (contract §1.1) */
export type Vec3 = { x: number; y: number; z: number };
export type Quat = { x: number; y: number; z: number; w: number };
/** `[A-Za-z0-9][A-Za-z0-9_.-]*` per `/` segment (ids.ts, contract §1.4) */
export type RowId = string;
export type PlaceId = string;
export type VmId = 'platform' | 'client';
/** tree-rooted, no leading slash: `authored module` */
export type TreePath = string;
/** `templates/<file>.js#<identifier>` (core §4.3) */
export type TemplateRef = string;
/** one step of a nested path: an object key or an array index (wire.ts, core §5.3) */
export type PathSegment = string | number;

/** contract §1.2 */
export type PositionSpec =
  | { x: number; y: number; z: number }
  | { x: number; z: number; y?: number | { terrain: number } | 'surface' }
  | { attach: 'camera'; x?: number; y?: number; depth?: number; fov?: number }; // viewmodels, contract §9.13

/** contract §1.3: degrees, yaw/pitch/roll about +Y/+X/+Z (YXZ) */
export type RotationSpec =
  | number
  | { yaw?: number; pitch?: number; roll?: number }
  | Quat
  | { lookAt: PositionSpec; include?: Array<'yaw' | 'pitch' | 'roll'> };

/** contract §3.1; every other field is an ObjectPropertiesSpec field, stored in `props` and routed to its channel (core §5.6) */
export interface ObjectSpec {
  id?: string;
  tags?: string[];
  state?: Record<string, unknown>;
  behavior?: TreePath | TreePath[];
  template?: TemplateRef;
  /** scene form; dotted keys set nested paths (D-CORE-04) */
  overrides?: Record<string, unknown>;
  parent?: RowId;
  children?: ObjectSpec[];
  place?: PlaceId;
  audience?: 'near' | 'all' | 'local';
  visibility?: 'owner' | 'platform';
  scope?: 'session' | 'world';
  simulatedBy?: 'platform';
  /** seconds */
  lifetime?: number;
  /** accepted, unused live */
  tick?: { phase?: 'pre' | 'post'; order?: number };
  yaw?: number;
  feetPosition?: PositionSpec;
  rotation?: RotationSpec;
  scale?: number | Vec3;
  name?: string;
  [property: string]: unknown;
}

/** contract §8.1, §12.2 (produced by the input port) */
export interface InputState {
  axes: Record<string, number>;
  held: Record<string, boolean>;
  pressed: Record<string, boolean>;
  released: Record<string, boolean>;
  actions: Record<string, boolean>;
  actionData?: Record<string, unknown>;
  pointer?: { x: number; y: number; ndcX: number; ndcY: number };
}

/** world.config.yaml `inputs` (contract §12.1) */
export interface InputsDef {
  axes?: Record<string, InputAxisDef>;
  actions?: Record<string, InputActionDef>;
  touch?: { enabled?: boolean; surfaces?: unknown; active?: unknown; style?: unknown };
}
export interface InputAxisDef {
  /** a key pair `"a/d"` reads −1/+1 */
  keys?: string;
  mouse?: 'deltaX' | 'deltaY' | 'wheelY';
  gamepad?: string;
}
export interface InputActionDef {
  keys?: string[];
  mouse?: 'left' | 'right' | 'middle' | 'mouse4' | 'mouse5' | 'wheelUp' | 'wheelDown';
  gamepad?: string;
  modifiers?: unknown;
  activeOn?: 'keydown' | 'hold' | 'keyup';
  touch?: { button?: unknown; label?: string; slot?: unknown; gesture?: unknown };
}

/**
 * `ctx.world.assets[ref]`: the engine-measured facts of a model or clip, in the shape the live game reads (contract §30,
 * `world.facts.yaml`): `authored module` reads `bounds.size[1]`, `:491` and `authored module`
 * read `gait[clip]`.
 */
export interface AssetFacts {
  readonly bounds?: {
    readonly center: readonly [number, number, number];
    readonly min: readonly [number, number, number];
    readonly max: readonly [number, number, number];
    readonly size: readonly [number, number, number];
  };
  readonly clips?: readonly string[];
  readonly gait?: Readonly<Record<string, number>>;
  readonly skinned?: boolean;
  readonly triangles?: number;
  /** audio seconds */
  readonly duration?: number;
  readonly [fact: string]: unknown;
}

// ── pause reasons and the clock (X-07, core §9.1) ────────────────────────────────────────────────────────────────────

/**
 * X-07: the one pause-reason union, shared by the kernel, the PauseController (build §6.4) and the UI chrome (io §3.9-3.10).
 * The kernel sets `boot` and `loading`, the LOADING gate `preparing`, the PauseController the rest. Runtime tables of who sets
 * which reason and which reasons suspend audio: rules.ts.
 */
export type PauseReason = string;

/** docs/architecture.md §3.0, core §9.1 (implemented by sched/clock.ts, WP C2) */
export interface SimClock {
  /** ticks run since boot */
  readonly tick: number;
  /** ENGINE.NOW_EPOCH_MS + tick·1000/30 ms, constant within a tick */
  now(): number;
  /** reasons.size === 0 */
  readonly running: boolean;
  readonly reasons: ReadonlySet<PauseReason>;
  /** idempotent per reason */
  pause(r: PauseReason): void;
  resume(r: PauseReason): void;
}

// ── engine acts and audiences (core §8.6, contract §6.4) ─────────────────────────────────────────────────────────────

/** the engine acts (rules.ts ACT_NAMES holds the same list at run time) */
export type ActName =
  | 'playSound'
  | 'stopSound'
  | 'fx'
  | 'decal'
  | 'screenShake'
  | 'cameraPunch'
  | 'screenFlash'
  | 'hitstop'
  | 'shake'
  | 'impulse'
  | 'shockwave'
  | 'damageNumber'
  | 'uiEvent'
  | 'slowMo'
  | 'milestone'
  | 'highlightSet'
  | 'highlightClear'
  | ExtraActName;

/** K-acts: engine acts beyond the base runtime's list, routed as acts only under `ext.extraActs` (rules.ts EXTRA_ACT_NAMES) */
export type ExtraActName = 'squash' | 'flash' | 'slash';

/** every audience spelling the live game uses (contract §6.2: `{kind:…}` forms and the `{player}`, `{nearby}`, `{place}` forms) */
export type Audience =
  | { kind: 'all' }
  | 'all'
  | { kind: 'player'; id: RowId }
  | { player: RowId }
  | { kind: 'nearby'; position: Vec3; radius?: number }
  | { nearby: Vec3; radius?: number }
  | { kind: 'place'; placeId?: PlaceId }
  | { place: PlaceId };

/** an Audience in its `{kind}` form (the act envelope and the routing matrix see only this one, core §8.4, §8.6) */
export type NormalisedAudience =
  | { kind: 'all' }
  | { kind: 'player'; id: RowId }
  | { kind: 'nearby'; position: Vec3; radius: number | null }
  | { kind: 'place'; placeId: PlaceId | null };

// ── ctx (core §3.4) ──────────────────────────────────────────────────────────────────────────────────────────────────

export type CtxKind = 'behavior' | 'sim' | 'rig' | 'ui' | 'geometry' | 'look' | 'material' | 'heightmap';

/** contract §5.2, core §6 */
export interface QueryOptions {
  radius?: number;
  center?: Vec3;
  tags?: string[];
  anyTags?: string[];
  excludeTags?: string[];
  /** default true */
  ignoreSelf?: boolean;
  place?: PlaceId;
  select?: 'objects' | 'ids';
  /** matches `world:ss#<id>` */
  objectId?: string;
}

export interface EmitOptions {
  to?: RowId;
  place?: PlaceId;
  audience?: Audience;
  /** cross-world portals: ignored with a dev warning (contract §6.2) */
  via?: string;
}

export interface EventMeta {
  name: string;
  /** the emitting row; null for sims and the kernel (core §8.4) */
  sourceId: RowId | null;
  placeId: PlaceId | null;
  to?: RowId | undefined;
}

/** a declared ear or a `ctx.on` handler; `ctx` is the ctx of the listener's owner (a behavior, rig or sim ctx) */
export type EarHandler = (ctx: any, payload: unknown, meta: EventMeta) => void;

export type CrossResult =
  | { crossed: true; placeId: PlaceId }
  | { crossed: 'departing'; link: string }
  | { crossed: false; verdict: string };

/** core §9.6 */
export interface TimerInfo {
  id: string;
  ownerId: RowId | 'sim';
  dueInTicks: number;
  dueInSeconds: number;
  engineOwned: false;
  hook: string;
}

export interface CoreCtx {
  readonly kind: CtxKind;
  /** ms on the sim clock, constant within a tick (contract §7.1) */
  now(): number;
  /** the room's stream (contract §5.12) */
  random(): number;
  log(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

/** Spawn verbs the build does not offer: present on the ctx, they throw `<verb> is not available in this build` (core §3.4) */
export interface UnavailableVerbs {
  sql(...args: unknown[]): never;
  job(...args: unknown[]): never;
  awaitJob(...args: unknown[]): never;
  commit(...args: unknown[]): never;
  enterPlace(...args: unknown[]): never;
  attach(...args: unknown[]): never;
  changed(...args: unknown[]): never;
  transfer(...args: unknown[]): never;
  trade(...args: unknown[]): never;
  proposePurchase(...args: unknown[]): never;
  notifyDm(...args: unknown[]): never;
  getVibeAudio(...args: unknown[]): never;
  worldToScreen(...args: unknown[]): never;
  resolveControls(...args: unknown[]): never;
}

/** behavior, sim and rig realms. `ctx.wallNow` is deliberately absent (`authored module` probes for it). */
export interface GameCtx extends CoreCtx, UnavailableVerbs {
  readonly world: WorldHandle;
  readonly session: Record<string, any>;
  readonly place: PlaceHandle;
  readonly files: { read(path: TreePath): string | null; write(...args: unknown[]): never; delete(...args: unknown[]): never };
  readonly view: { camera: { eye: Vec3; aim: Vec3; fov: number } | null };
  getObject(id: RowId): ObjectView | null;
  query(opts: QueryOptions & { select: 'ids' }): RowId[];
  query(opts?: QueryOptions): ObjectView[];
  spawn(spec: ObjectSpec): RowId;
  spawn(id: string, spec: ObjectSpec): RowId;
  destroy(id?: RowId | RowId[], opts?: { force?: boolean }): void;
  /** returns the act id for `playSound` (`snd-<n>`) and `fx` (`fx-<n>`), undefined otherwise (core §8.1, X-12) */
  emit(name: string, payload?: unknown, opts?: EmitOptions): string | undefined;
  /** returns a working unsubscribe (core §8.1) */
  on(name: string, handler: EarHandler, opts?: { place?: PlaceId; once?: boolean }): () => void;
  after(seconds: number, hookExport: string, payload?: unknown): string;
  cancel(timerId: string): void;
  getTimers(ownerId?: RowId): TimerInfo[];
  cross(entity: RowId | ObjectView, link: string, opts?: { createIfMissing?: boolean }): CrossResult;
  getObjectSocket(id: RowId, name: string): { position: Vec3; direction: Vec3; confidence: number } | null;
}

export interface BehaviorCtx extends GameCtx {
  readonly kind: 'behavior';
  readonly self: ObjectView;
  /** alias of self.state; assigning replaces it */
  state: Record<string, unknown>;
  /** the human's PlayerView on client-VM rows, null on platform-VM rows (core §7.2, §10.3) */
  readonly player: PlayerView | null;
  sleep(seconds?: number): void;
}

export interface SimCtx extends GameCtx {
  readonly kind: 'sim';
  readonly gapMs?: number;
}

export interface RigCtx extends Omit<BehaviorCtx, 'kind' | 'self'> {
  readonly kind: 'rig';
  readonly self: RigView;
}

export interface UiCtx extends CoreCtx {
  readonly kind: 'ui';
  /** the viewer's body (or player.controlling, always null here); the UI realm's handles ignore writes (core §3.3) */
  readonly self: Readonly<ObjectView> | null;
  /** read-only view */
  readonly world: WorldHandle;
  /** copy-on-write overlay of the client VM session (core §7.5, X-25) */
  readonly session: Record<string, any>;
  readonly view: { camera: { eye: Vec3; aim: Vec3; fov: number } | null };
  /** read-only handles of any resident row */
  getObject(id: RowId): Readonly<ObjectView> | null;
  /** PortUiState attached by the UI host before each render (X-25, io §3.3) */
  port?: unknown;
  /** ext.uiPlace: the viewer's place, read-only (writes to `state` are ignored); undefined without the extension */
  readonly place?: PlaceHandle;
}

// ── handles (core §3.3, §3.5; api ObjectView) ────────────────────────────────────────────────────────────────────────

/** `BehaviorHookHealth` of the engine reference (`api:691-703`) */
export interface BehaviorHookHealth {
  hook: string;
  script: string;
  error: string;
  line?: string | undefined;
  tick: number;
  running: 'inert' | 'running';
  count?: number | undefined;
}

export interface Rotation {
  yaw: number;
  pitch: number;
  roll: number;
}

/**
 * The live handle game code gets from `ctx.self`, `getObject`, `query` and `world.players` (core §3.3). Transform reads are
 * fresh snapshots (D-CORE-03); assigning a field is the write. Every ObjectProperties field (`anim`, `mixer`, `ik`, `model`,
 * `material`, `light`, `primitive`, `physics`, `fx`, `audio`, …) reads and writes through the index signature. Fields a row
 * may lack are typed `T | undefined` rather than optional, so a class with prototype accessors (core §3.3) can implement them
 * under exactOptionalPropertyTypes.
 */
export interface ObjectView {
  readonly id: RowId;
  readonly tags: readonly string[];
  readonly template: TemplateRef | undefined;
  readonly name: string | null;
  readonly audience: 'near' | 'all' | 'local';
  readonly scope: 'session' | 'world';
  readonly visibility: 'owner' | 'platform' | null;
  readonly retention: 'current';
  /** `world:ss#<id>` */
  readonly objectId: string;
  readonly simulatedBy: 'platform' | null;
  readonly lifetime: number | undefined;
  readonly place: PlaceId | null;
  /** write-through proxy; assigning replaces (a clone), `= {}` wipes */
  state: Record<string, unknown>;
  /** local feet position (world for unparented rows); assigning teleports */
  get feetPosition(): Vec3;
  set feetPosition(p: PositionSpec);
  readonly worldFeetPosition: Vec3;
  /** degrees, YXZ */
  get rotation(): Rotation;
  set rotation(r: RotationSpec);
  yaw: number;
  scale: number | Vec3;
  /** undefined on a `simulatedBy: "platform"` row (LIVE `authored module`) */
  readonly effectiveScale: Vec3 | undefined;
  /** world AABB from the render port, undefined until the model is measured */
  readonly bounds: { min: Vec3; max: Vec3 } | undefined;
  velocity: Vec3;
  angularVelocity: Vec3;
  readonly grounded: boolean;
  readonly sleeping: boolean | null;
  readonly awake: boolean | null;
  /** live map: `o.forces.surge = {force} | null` */
  readonly forces: Record<string, unknown>;
  visible: boolean;
  get parent(): ObjectView | null;
  /** re-parents and keeps the world pose (no live writer) */
  set parent(p: RowId | ObjectView | null);
  /** direct children in serial order, incl. local child rows */
  readonly children: ObjectView[];
  readonly behavior: string[];
  /** undefined while no hook of the row is broken */
  readonly behaviorHealth: { broken: BehaviorHookHealth[] } | undefined;
  spectating: boolean;
  readonly controller: string | null;
  readonly controlling: ObjectView | null;
  /** player rows only */
  readonly userId: string | null | undefined;
  [field: string]: unknown;
}

export interface PlayerLookEntry {
  look: string;
  intensity?: number;
  priority?: number;
}

/** core §3.5 */
export interface PlayerView extends ObjectView {
  readonly userId: string;
  readonly displayName: string;
  /** true only when read from the client VM (core §10.3) */
  readonly isLocal: boolean;
  spectating: boolean;
  readonly controlling: null;
  readonly portraitUrl: null;
  readonly isEditor: false;
  readonly isGodMode: false;
  readonly party: null;
  readonly guild: null;
  readonly latencyMs: 0;
  readonly inputHeld: false;
  /** player look stack (contract §19) */
  look: PlayerLookEntry[];
}

/** the camera rig's `ctx.self` (core §7.4, contract §11.2) */
export interface RigView extends ObjectView {
  /** the body the rig follows + its effectiveScale */
  readonly target: (ObjectView & { readonly effectiveScale: Vec3 | undefined }) | null;
  /** `{yaw, pitch}` radians presented by the camera port; undefined before frame 1 */
  readonly view: { yaw: number; pitch: number } | undefined;
  /** vertical degrees (rig layer over the camera def) */
  fov: number | undefined;
  /** per tick */
  hideLocalPlayer: boolean;
  clip: { near?: number; far?: number } | null | undefined;
  orientation: { source: 'look' | 'script'; authoredAxes?: unknown } | undefined;
  pointerLock: boolean | 'drag' | undefined;
  sensitivity: number | undefined;
  pixelSnap: unknown;
}

/** core §3.5 */
export interface WorldHandle {
  /** proxy over kernel.worldState (room life) */
  readonly state: Record<string, any>;
  /** the human only; present at all times, including during place loads */
  readonly players: PlayerView[];
  /** every roster place, resident or not */
  readonly places: PlacesCollection;
  /** world.config.yaml defaultPlace */
  readonly defaultPlace: PlaceId;
  /** the carried tree list (core §12.5) */
  readonly files: readonly TreePath[];
  readonly assets: Record<string, AssetFacts | undefined>;
  /** camera port values; read-only (aspect undefined before frame 1) */
  readonly camera: { aspect?: number | undefined; fov?: number | undefined } & Record<string, unknown>;
  /** world-config inputs after the import edits */
  readonly inputs: InputsDef;
  /** `{ ui: { referenceHeight: 1080, theme: { font: 'Geist' } }, … }` */
  readonly engine: Record<string, unknown>;
  readonly ui: Record<string, unknown>;
  readonly routing: null;
  readonly player: Record<string, unknown>;
  readonly mode: 'live';
  readonly id: string | null;
  readonly address: null;
  /** true while boot or a place load is in progress */
  readonly settling: boolean;
  readonly godMode: Record<string, never>;
  readonly creatorTabs: readonly never[];
}

/** `Object.keys` lists the roster */
export interface PlacesCollection {
  readonly [placeId: string]: PlaceHandle | undefined;
}

export interface PlaceHandle {
  readonly id: PlaceId;
  readonly name: PlaceId;
  readonly mode: '3d';
  /** players whose body is in this place */
  readonly players: PlayerView[];
  /** resident rows of this place, by id (lazy proxy) */
  readonly objects: Record<RowId, ObjectView>;
  /** per place, room life */
  readonly state: Record<string, any>;
  /** LayeredValue over the config (core §5.5) */
  readonly atmosphere: Record<string, any>;
  /** config, default {0,-9.81,0}; every live place {0,-24,0} */
  readonly gravity: Vec3;
  readonly terrain: Record<string, unknown>;
  readonly defaultSpawnPoint: Vec3;
  readonly worldBounds: { bottom: number };
}

// ── game modules (core §12.2, §9.4) ──────────────────────────────────────────────────────────────────────────────────

/** `export const updateSchedule` (contract §7.2) */
export interface ScheduleSpec {
  every?: number | { seconds: number };
  near?: { radius: number; tag?: string } | Array<{ radius: number; tag?: string }>;
}

/** core §9.4: runs at ticks where (tick + phase) % everyTicks === 0, with dt = dtS */
export interface CompiledSchedule {
  everyTicks: number;
  phase: number;
  dtS: number;
}

export interface OutOfBoundsEvent {
  bottom: number;
  position: Vec3;
  placeId: PlaceId;
  respawnPoint: Vec3;
}

/** a carried behavior module as the kernel sees it (core §12.2; validated by a type guard at bind) */
export interface BehaviorModule {
  onSpawn?(ctx: BehaviorCtx): void;
  update?(ctx: BehaviorCtx, dt: number): void;
  onInput?(ctx: BehaviorCtx, input: InputState): void;
  onDestroy?(ctx: BehaviorCtx): void;
  onTriggerEnter?(ctx: BehaviorCtx, other: ObjectView): void;
  onOutOfBounds?(ctx: BehaviorCtx, ev: OutOfBoundsEvent): void;
  ears?: Record<string, EarHandler>;
  updateSchedule?: ScheduleSpec;
  /** ctx.after targets */
  [named: string]: unknown;
}

/** `sim.js` and `places/<p>/sim.js`; `cadence` must be "100ms" (core §12.2) */
export interface SimModule {
  tick(ctx: SimCtx): void;
  cadence?: string;
}

/** core §12.2: the registry takes its inputs by injection (tests: a map built from live-files.json; build: `virtual:ss/*`) */
export interface RegistryInputs {
  /** virtual:ss/modules */
  modules: Readonly<Record<TreePath, () => Promise<Record<string, unknown>>>>;
  /** virtual:ss/preload-sets */
  sets: Readonly<Record<string, readonly TreePath[]>>;
  /** virtual:ss/anim */
  anim: Readonly<Record<string, () => Promise<{ authored: unknown; compiled: unknown }>>>;
}

/** core §12.2 (implemented by modules/registry.ts, WP C3) */
export interface ModuleRegistry {
  /** tree paths the registry can load */
  knows(path: TreePath): boolean;
  /** synchronous: the module namespace if loaded, else undefined */
  get(path: TreePath): Record<string, unknown> | undefined;
  /** synchronous template lookup: throws SpawnRefused (an Error named 'SpawnRefused') when unknown, unloaded or missing */
  template(ref: TemplateRef): Readonly<ObjectSpec>;
  /** load a set (`boot`, `director`, `actors`, `place:<p>`) or explicit paths; resolves when every module is evaluated */
  ensure(setOrPaths: string | TreePath[], onProgress?: (f: number) => void): Promise<void>;
  /** async single load used by late binding */
  load(path: TreePath): Promise<Record<string, unknown>>;
  readonly lateBinds: number;
}

/** core §12.5 (implemented by modules/tree.ts, WP C3) */
export interface TreeStore {
  /** ctx.world.files: every file of game/, sorted */
  readonly files: readonly TreePath[];
  /** ctx.files.read */
  readText(path: TreePath): string | null;
  /** sync; anim/*.yml and other preloaded YAML */
  readParsed(path: TreePath): unknown;
  /** the place chunk's rawCells at place load */
  addTexts(texts: Readonly<Record<TreePath, string>>): void;
}

// ── rows (core §3.2, §5) ─────────────────────────────────────────────────────────────────────────────────────────────

/** dead = detached, onDestroy pending */
export type RowPhase = 'alive' | 'dead' | 'disposed';

/** core §5.4 */
export interface TransformRec {
  /** local feet position (world for unparented rows) */
  pos: Vec3;
  /** local, from YXZ Euler */
  rot: Quat;
  scale: Vec3;
  vel: Vec3;
  angVel: Vec3;
  grounded: boolean;
  /** previous tick, for render interpolation */
  prevPos: Vec3;
  prevRot: Quat;
  /** world pose memoised per tick */
  worldCacheTick: number;
}

/** one behavior of a row: module + ctx + ears + schedule + health (core §2 behaviors/bind.ts, WP C2) */
export interface BehaviorInstance {
  readonly path: TreePath;
  /** null while the module binds late (core §12.4) */
  module: BehaviorModule | null;
  pendingModule: boolean;
  /** created once per owner and reused for every hook call (core §7) */
  ctx: BehaviorCtx | RigCtx | null;
  /** the module's `ears`, read once at bind (core §8.1) */
  ears: Readonly<Record<string, EarHandler>> | null;
  schedule: CompiledSchedule;
  /** null = awake; `untilTick: null` = until an external write or onInput (core §9.5) */
  sleeping: { untilTick: number | null } | null;
  /** per hook name (D-CORE-15); `behaviorHealth.broken` lists them */
  readonly health: Map<string, BehaviorHookHealth>;
}

/** hangs off the human body (core §5.8) */
export interface PlayerRec {
  readonly userId: string;
  displayName: string;
  readonly bodyId: RowId;
  look: PlayerLookEntry[];
}

/** the camera rig's record (core §7.4) */
export interface RigRec {
  /** the body the rig follows (`ctx.self.target`) */
  targetId: RowId | null;
  /** rig fields (fov, clip, orientation, pointerLock, sensitivity, pixelSnap, hideLocalPlayer) over the camera def (contract §11.4) */
  readonly layer: LayeredValue;
}

/** core §3.2: one entity in the store */
export interface RowRec {
  readonly id: RowId;
  /** monotonically increasing spawn order: deterministic iteration */
  readonly serial: number;
  readonly vm: VmId;
  /** null only for place-less engine rows */
  place: PlaceId | null;
  /** the spec named `place` (decides whether the row follows a crossing body, core §11.6) */
  readonly explicitPlace: boolean;
  parentId: RowId | null;
  /** creator-ownership edge (contract §3.6.1) */
  readonly spawnerId: RowId | null;
  /** spec.name, else the local id segment of a child, else null */
  readonly name: string | null;
  /** frozen; no live code writes tags */
  readonly tags: readonly string[];
  readonly template: TemplateRef | null;
  /** merged, normalised spec as spawned (deep-frozen in dev builds) */
  readonly spec: Readonly<ObjectSpec>;
  /** canonical, wire-clean */
  state: Record<string, unknown>;
  /** current ObjectProperties values (light, material, model, primitive, …) */
  props: Record<string, unknown>;
  tf: TransformRec;
  /** array order = spec order */
  behaviors: BehaviorInstance[];
  readonly audience: 'near' | 'all' | 'local';
  readonly scope: 'session' | 'world';
  readonly visibility: 'owner' | 'platform' | null;
  readonly simulatedBy: 'platform' | null;
  lifetimeS: number | null;
  expiresAtTick: number | null;
  phase: RowPhase;
  /** onSpawn not run yet */
  pendingSpawnHooks: boolean;
  /** set only on the human body */
  player: PlayerRec | null;
  spectating: boolean;
  /** set only on the camera rig row */
  rig: RigRec | null;
  fromScene: { place: PlaceId; cell: string } | null;
  /** bumped on any state write (UI dirty, save, sleep wake) */
  stateVer: number;
  propVer: number;
  handles: { platform?: ObjectView; client?: ObjectView; ui?: ObjectView };
}

/** who made a write (core §5.3): decides sleep wakes (core §9.5) */
export type Invoker = { row: RowId; behavior: TreePath } | { sim: string } | 'engine' | 'ui';

/** one effective write in the tick's change list (core §5.3): consumed by the channels, the UI dirty flag, the durable save and
 *  the sleep waker */
export interface ChangeRecord {
  readonly row: RowRec;
  /** top-level field (`state` for state writes) */
  readonly field: string;
  /** path below the field; [] for a whole assignment */
  readonly path: readonly PathSegment[];
  readonly invoker: Invoker;
}

/** core §5.5 (implemented by store/layers.ts, WP C1a): reads compose like a prototype chain, writes land in the own layer,
 *  delete reveals the layer below; root assignment replaces, a leaf assignment merges */
export interface LayeredValue {
  /** composed snapshot (memoised until the next write) */
  read(): Record<string, unknown>;
  /** nested write-through view */
  proxy(): Record<string, unknown>;
  set(path: readonly string[], value: unknown): void;
  delete(path: readonly string[]): void;
  onChange(fn: (composed: Record<string, unknown>, path: readonly string[]) => void): () => void;
}

/** core §5.6 (registered with store/channels.ts, WP C1a) */
export interface PropChannel {
  readonly field: string;
  /** X-13: deliver every assignment (no equal-write dedupe): anim, mixer, ik only */
  readonly everyWrite?: boolean;
  /** X-13: call onWrite synchronously inside the writer's stack (the channel must not call game code): anim, mixer, ik only */
  readonly sync?: boolean;
  /** after the store changed (deduplicated per tick and field, in write order, unless everyWrite/sync); path [] = whole */
  onWrite?(row: RowRec, value: unknown, prev: unknown, path: readonly PathSegment[]): void;
  /** derived read; undefined = read props[field]. A channel with `read` returns fresh snapshots */
  read?(row: RowRec, vm: VmId | 'ui'): unknown;
}

/** per-place uniform grid over feet xz (core §5.1, 16 m cells; implemented by store/spatial.ts, WP C1a) */
export interface SpatialGrid {
  readonly cellSize: number;
  /** rows whose cell overlaps the xz disc; the caller applies the exact distance test */
  near(center: Vec3, radius: number): Iterable<RowRec>;
}

/** core §5.1 (implemented by store/rows.ts, WP C1a) */
export interface RowStore {
  /** alive rows only */
  get(id: RowId): RowRec | undefined;
  has(id: RowId): boolean;
  /** insertion (serial) order */
  byPlace(place: PlaceId): ReadonlySet<RowRec>;
  byTag(place: PlaceId, tag: string): ReadonlySet<RowRec>;
  /** serial order */
  childrenOf(id: RowId): readonly RowRec[];
  ownedBy(spawnerId: RowId): ReadonlySet<RowId>;
  inVm(vm: VmId): Iterable<RowRec>;
  spatial(place: PlaceId): SpatialGrid;
  readonly count: number;
  // mutation (lifecycle.ts only)
  insert(rec: RowRec): void;
  /** removes from every index, phase = 'dead' */
  detach(id: RowId): RowRec | undefined;
  movePlace(rec: RowRec, place: PlaceId): void;
  /** feet changed: update the spatial cell */
  moved(rec: RowRec): void;
  /** physics writeback (core §5.4): invoker 'engine', no wake, no change-list entry beyond the spatial index; `rot` / `angVel`
   *  for dynamic bodies */
  engineWriteTransform(row: RowRec, pos: Vec3, vel: Vec3, grounded: boolean, rot?: Quat, angVel?: Vec3): void;
  // kernel-internal (WP C1a, store/rows.ts): tick bookkeeping, writers, handles, channels
  /** tick step A: prev ← cur for the rows that moved since the last call (render interpolation, X-14) */
  beginTick(): void;
  /** the effective script writes since the last call, in write order (drained at tick step H) */
  takeChanges(): ChangeRecord[];
  /** hears every effective write synchronously (sleep wakes, the row feed); returns an unsubscribe */
  observe(fn: (c: ChangeRecord) => void): () => void;
  /** the writer of a write (core §5.3): a runAs override, else the invoker source, else 'engine' */
  readonly invoker: Invoker;
  setInvokerSource(source: (() => Invoker) | null): void;
  runAs<T>(invoker: Invoker, fn: () => T): T;
  /** the cached handle of a row for a VM or the UI realm (core §3.3) */
  handle(row: RowRec, realm: VmId | 'ui'): ObjectView;
  /** the record behind a handle of this store, else null */
  rowOf(handle: unknown): RowRec | null;
  /** the next spawn serial (monotonic) */
  allocSerial(): number;
  /** property channels (core §5.6, X-13) */
  readonly channels: PropChannelRegistry;
}

/** core §5.6 (implemented by store/channels.ts ChannelRegistry) */
export interface PropChannelRegistry {
  /** at most one channel per field serves reads; returns an idempotent unregister */
  register(ch: PropChannel): () => void;
  /** delivers the deferred notifications of `fields` (all when omitted); returns how many */
  flush(fields?: Iterable<string>): number;
  readonly pending: number;
}

// ── events (core §5.2, §8) ───────────────────────────────────────────────────────────────────────────────────────────

/** the root sim or a place sim (core §11.4) */
export interface SimInstance {
  /** `sim` for the root sim, `sim:<place>` for a place sim */
  readonly id: string;
  /** null for the root sim */
  readonly place: PlaceId | null;
  readonly path: TreePath;
  module: SimModule | null;
  ctx: SimCtx | null;
  /** ticks between runs (a multiple of 3); set only under `ext.simCadence: "any"`, else every 3rd tick */
  everyTicks?: number;
  readonly health: Map<string, BehaviorHookHealth>;
}

/** who called a kernel verb (core §5.2) */
export type CallerRef =
  | { kind: 'row'; row: RowRec; behavior: BehaviorInstance }
  | { kind: 'sim'; sim: SimInstance }
  | { kind: 'scene'; place: PlaceId }
  | { kind: 'kernel' };

/** core §8.3 (implemented by events/bus.ts, WP C2) */
export interface EventBus {
  /** queues a custom event (deep-copied payload); engine acts are minted and routed at once and return their id */
  emit(caller: CallerRef, name: string, payload: unknown, opts?: EmitOptions): string | undefined;
  /** delivers until empty or DRAIN_CAP; returns the number delivered */
  drain(): number;
  readonly pending: number;
}

// ── virtual machines (core §10) ──────────────────────────────────────────────────────────────────────────────────────

/** opaque handle of the physics world a VM steps in (both VMs share one world in v1, motion §5.1) */
export type PhysicsWorldHandle = unknown;

/** core §10.1 (implemented by vm/machine.ts, WP C5) */
export interface VirtualMachine {
  readonly id: VmId;
  /** ctx.session for every ctx of this VM (page life) */
  readonly session: Record<string, any>;
  physicsWorld: PhysicsWorldHandle | null;
  readonly counters: { crossVmWrites: number; crossVmReads: number };
}

// ── places (core §11) ────────────────────────────────────────────────────────────────────────────────────────────────

/** core §11.1: one compiled `places/<p>/config.yaml` (`virtual:ss/places` placeIndex); immutable compiled JSON */
export interface CompiledPlace {
  readonly id: PlaceId;
  readonly mode: '3d';
  /** default {0,-9.81,0}; live {0,-24,0} */
  readonly gravity: Vec3;
  readonly defaultSpawnPoint: PositionSpec;
  /** unused live */
  readonly defaultSpawnRotation: RotationSpec | null;
  /** null → spawn point y − 64 */
  readonly worldBounds: { readonly bottom: number | null };
  /** base layer of the atmosphere LayeredValue */
  readonly atmosphere: Readonly<Record<string, unknown>>;
  /** { kind: 'off' } or heightmap (mire-island) */
  readonly terrain: Readonly<Record<string, unknown>>;
  /** recorded, no effect */
  readonly persistence: 'session';
  /** places/<p>/sim.js when present */
  readonly sim: TreePath | null;
  /** cell keys present, incl. 'objects' and non-standard names ('dress') */
  readonly cells: readonly string[];
  /** top-level rows after filtering */
  readonly rows: number;
  /** preload set id `place:<p>` */
  readonly modules: string;
}

/** build §3.3.1: one place chunk (`virtual:ss/place/<id>`) */
export interface PlaceBundle {
  readonly id: PlaceId;
  readonly config: CompiledPlace;
  /** filtered, validated, parent-sorted; spec as authored (template merge happens at run time) */
  readonly rows: ReadonlyArray<{ readonly id: RowId; readonly cell: string; readonly spec: Readonly<Record<string, unknown>> }>;
  /** places/<id>/sim.js */
  readonly sim?: () => Promise<Partial<SimModule>>;
  /** only for the 11 power-grid places (ctx.files.read) */
  readonly rawCells?: Readonly<Record<TreePath, string>>;
}

/** `virtual:ss/places`: the compiled roster plus one loader per place (build §3.3.1) */
export interface CompiledPlaceIndex {
  readonly placeIndex: Readonly<Record<PlaceId, CompiledPlace>>;
  readonly places: Readonly<Record<PlaceId, () => Promise<PlaceBundle>>>;
}

export type Residency = 'absent' | 'loading' | 'active' | 'dormant';

/** per place, survives unload (core §11.3) */
export interface PlaceRuntime {
  readonly id: PlaceId;
  /** ctx.place.state */
  readonly state: Record<string, unknown>;
  readonly atmosphere: LayeredValue;
  readonly sim: SimInstance | null;
}

/** core §11.3 (implemented by places/manager.ts, WP C4) */
export interface PlaceManager {
  readonly active: PlaceId | null;
  residency(p: PlaceId): Residency;
  /** active (holds the human) */
  isSimulated(p: PlaceId): boolean;
  /** sim-side: chunk + PlaceBake + physics + scene rows (X-05) */
  load(p: PlaceId, onProgress?: (f: number) => void): Promise<void>;
  /** resolves when ports.scene.buildPlace(p) finished (render build) */
  built(p: PlaceId): Promise<void>;
  isBuilt(p: PlaceId): boolean;
  /** ports switch render/physics/atmosphere/look to p */
  activate(p: PlaceId): void;
  /** destroy its rows (onDestroy runs), dispose port resources */
  unload(p: PlaceId): void;
  cross(caller: CallerRef, entity: RowId | ObjectView, link: string): CrossResult;
  /** defaultSpawnPoint with y resolved */
  spawnPoint(p: PlaceId): Vec3;
  /** worldBounds.bottom or spawn y − 64 */
  bottom(p: PlaceId): number;
  readonly runtime: (p: PlaceId) => PlaceRuntime;
}

// ── world config (virtual:ss/world-config: world.config.yaml after import edits E04/E08/E-IN-01) ─────────────────────

export interface WorldConfig {
  readonly name?: string;
  readonly description?: string;
  /** "gallow-farm" */
  readonly defaultPlace: PlaceId;
  /** `templates/player.js#player` */
  readonly player: TemplateRef;
  /** `templates/camera.js#camera` */
  readonly camera: TemplateRef | Readonly<Record<string, unknown>>;
  /** `scripts/lighting.js` */
  readonly lighting?: TreePath;
  readonly inputs: InputsDef;
  /** `{ render: 'scripts/ui.js' }` */
  readonly ui?: { readonly render?: TreePath } & Readonly<Record<string, unknown>>;
  readonly engine?: Readonly<Record<string, unknown>>;
  readonly [key: string]: unknown;
}

// ── the kernel (docs/architecture.md §3.0, core §3.7) ────────────────────────────────────────────────────────────────

/** diagnostic counters and timings (core §2 dev/metrics.ts); subsystems increment them */
export interface KernelMetrics {
  /** backlog dropped by advance() beyond two ticks (core §9.7) */
  droppedTicks: number;
  /** custom events delivered by the bus (core §8.3) */
  eventsDelivered: number;
  /** events addressed to a row that was dead at delivery (core §8.3) */
  eventsUndelivered: number;
  /** drains that stopped at DRAIN_CAP (core §8.3) */
  drainCapHits: number;
  /** acts dropped by the visibility filter; the game still got its id (core §8.6, io §2.5) */
  actsFiltered: number;
  /** acts with no registered handler (core §15.6) */
  actsUnhandled: number;
  /** a second handler registered for one act (docs/architecture.md §11) */
  actsDoubleRegistered: number;
  /** `slowMo` acts, ignored (DR-17, core §8.6) */
  slowMoIgnored: number;
  /** carried hook calls that threw (D-CORE-15) */
  hookErrors: number;
  /** ctx.spawn refusals (core §4.5) */
  spawnRefused: number;
  /** duplicate-id spawns answered with the existing id (D-CORE-06) */
  duplicateSpawns: number;
  /** KernelEvents subscribers that threw */
  listenerErrors: number;
  /** wall time of one tick: exponentially weighted mean and p95, ms */
  tickMsEwma: number;
  tickMsP95: number;
}

/** core §3.7 */
export interface KernelEvents {
  /** after the record exists (before onSpawn) */
  rowSpawned(row: RowRec): void;
  /** at disposal (after onDestroy) */
  rowDestroyed(row: RowRec): void;
  /** sim-side load progress */
  placeLoading(place: PlaceId, progress: number): void;
  placeActive(place: PlaceId, prev: PlaceId | null): void;
  /** render build finished (X-05) */
  placeBuilt(place: PlaceId): void;
  paused(paused: boolean, reasons: ReadonlySet<PauseReason>): void;
  tickEnd(tick: number): void;
}

/** docs/architecture.md §3.0, core §3.7: what boot and the other domains use */
export interface Kernel {
  readonly worldId: string | null;
  readonly ids: Readonly<{ humanBody: RowId; cameraRig: RowId }>;
  readonly clock: SimClock;
  readonly store: RowStore;
  readonly bus: EventBus;
  readonly places: PlaceManager;
  readonly registry: ModuleRegistry;
  readonly vms: Readonly<Record<VmId, VirtualMachine>>;
  readonly ports: KernelPorts;
  readonly worldState: Record<string, unknown>;
  readonly metrics: KernelMetrics;
  /** X-14: per-frame change feed for the render domain */
  readonly feed: RowFeed;
  /** X-12: act routing table; domains register handlers at boot */
  readonly acts: ActRouter;
  /** per rendered frame: run 0..2 ticks (checks clock.running before every tick); returns the interpolation alpha */
  advance(realDtMs: number): { ticks: number; alpha: number };
  /** headless: run n ticks back to back; respects pause unless force */
  runTicks(n: number, opts?: { force?: boolean }): void;
  /** create the human body and register the local player (boot, core §14) */
  spawnHuman(a: { place: PlaceId; at?: Vec3; yaw?: number; userId: string; displayName: string; durableState: object }): RowId;
  /** X-09: the rig's onInput + update once per rendered frame; returns the top-level rig `state` keys written / deleted */
  stepRig(dtS: number, input: InputState): { wrote: ReadonlySet<string>; deleted: ReadonlySet<string> };
  /** X-15: forwarded to the input port, which owns queueing and the declared-action filter */
  sendAction(name: string, payload?: unknown, opts?: { down?: boolean; relockPointer?: boolean }): void;
  /** the UI realm ctx for one render call (core §7.5) */
  createUiCtx(): UiCtx;
  /** test builds only: up to n ticks per frame instead of 2 (D-CORE-16) */
  setTicksPerFrame?(n: 2 | 4 | 8): void;
  on<K extends keyof KernelEvents>(e: K, fn: KernelEvents[K]): () => void;
}
