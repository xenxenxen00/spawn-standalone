// The physics port (motion §5.1, docs/architecture.md §3.0, X-01, X-32): `PhysicsPortImpl implements PhysicsPort` over one
// Rapier world per resident place.
//
//   buildPlace      keeps its synchronous signature. With Rapier loaded the world is built at once (colliders from the pack,
//                   the refresh step, then the bodies of the rows recorded for the place, in spawn-serial order). Before
//                   that (the home place's sim-side load at boot) the bake is STORED and the X-32 rules hold: rays answer
//                   null, `groundY` null, characters are held still (no movement, `grounded` false, velocity 0). The stored
//                   builds run when the loader has resolved: in `ensure()` / `ensurePhysics()`, or at the next step or
//                   query if somebody else finished the load. A pack row that spawns meanwhile has its pose noted at
//                   once (`noteBakedPose`): its instances stand at the pose it spawned with, and scripts may move it
//                   before the world exists.
//   ensurePhysics   "Rapier loaded + stored builds done": the LOADING gate awaits it; headless tools await it before boot
//   disposePlace    `world.free()` (wasm memory is not garbage-collected) and the place's bodies and recorded rows forgotten
//
// What the place manager does beyond the verbs' obvious use (core places/manager.ts header), and what happens here:
//   - a row changed place: `setPosition(row, pos)` arrives with `row.place` already new → the body is re-homed (removed from
//     the world it was in, made in the new place's world; recorded for it when that place is not built);
//   - a demoted place is built again: `buildPlace(p, sameBake)`, then `rowSpawned(row)` again for the rows that stayed → the
//     rows get new bodies; a row that moved since the bake is seated where it stands (the bake remembers its baked pose);
//   - an unload inside a tick: `disposePlace` first, `rowDestroyed` of its rows later → the late calls find nothing and return.
//
// The port needs the row store (the writeback is `store.engineWriteTransform`, tags and parents come from `store.get`); it
// takes it through `attach` / `attachKernel` and never imports the kernel. It installs the bindings of `builtin/physics`
// (`raycast`, `getInputRay`) and of `aimTargets` when it is made; the port made last holds them.
//
// Not in the frozen interface, for the packages that need them: `ensure`, `staticRaycaster` (render's fx floor),
// `aimTargets` (touch aim), `bodyRecords` (nav overlay: footprints without the wasm), `liquidOf`, `setDynamics` (PH4) and
// `holdBody` (the out-of-bounds sleep of motion §5.8, for which the interface has no verb).
import { bindPhysicsQueries, type InputRayCamera } from '../builtin/physics.ts';
import type { AssetFactsPort, PhysicsPort, PlaceBake, VisualProxySoup } from '../core/ports.ts';
import type { PlaceId, Quat, RowId, RowRec, Vec3, VmId } from '../core/types.ts';
import { liquidVolumes, type LiquidState } from './liquid.ts';
import { bodyKindOf } from './spec.ts';
import {
  BodySync, noteBakedPose, type BodyRecord, type DynamicsFactory, type RowWorldPose, type ScriptedCollider, type ScriptedColliders, type SyncHost,
} from './rapier/body-sync.ts';
import { loadRapier, rapierIfLoaded, type Rapier, type RapierLoader } from './rapier/loader.ts';
import { RapierQueryWorld, bindQueryWorlds, type AimTarget } from './rapier/query.ts';
import { PhysicsWorld } from './rapier/world.ts';
import { VisualProxyLayer } from './visual-proxy.ts';

/** what the port reads of the row store */
export interface PhysicsRowStore {
  get(id: RowId): RowRec | undefined;
  engineWriteTransform(row: RowRec, pos: Vec3, vel: Vec3, grounded: boolean, rot?: Quat, angVel?: Vec3): void;
}

export interface PhysicsHost {
  store: PhysicsRowStore;
  /** world pose of a row; default: the parent chain composed from `store.get` (translation · rotation · scale per level) */
  worldPose?(row: RowRec): RowWorldPose;
  /** the compiled place config: `gravity` for the world, `terrain.marks` for the sea (liquid.ts) */
  placeConfig?(place: PlaceId): { gravity?: Vec3; terrain?: unknown } | undefined;
  assets?: AssetFactsPort | null;
  /** the camera port, for `getInputRay` */
  camera?: InputRayCamera | null;
  /** render's GeometryService: colliders of runtime-spawned scripted rows (X-43) */
  geometry?: (ScriptedColliders & { registerColliders?(list: Iterable<{ key: string; collider: ScriptedCollider }>): void }) | null;
  warn?(message: string): void;
}

/** the kernel members `attachKernel` reads (structural: physics never imports the kernel) */
export interface KernelLike {
  store: PhysicsRowStore;
  placeIndex?: { placeIndex: Readonly<Record<PlaceId, { gravity?: Vec3; terrain?: unknown } | undefined>> } | null;
  ports?: { assets?: AssetFactsPort; camera?: InputRayCamera };
}

export interface PhysicsPortOptions {
  /** tags whose runtime colliders do not receive decals; default none */
  ignoredTags?: readonly string[];
  /** default: the shared loader of physics/rapier/loader.ts (tests pass their own to hold the load back) */
  loader?: RapierLoader;
  host?: PhysicsHost;
  /** PH4's dynamic bodies */
  dynamics?: DynamicsFactory;
  /** opt-in (R-5): sweep every character's move against the other characters of its place (rapier/kcc-ccd.ts). Default false. */
  characterCcd?: boolean;
}

interface PlaceState {
  readonly id: PlaceId;
  readonly bake: PlaceBake;
  /** row ids the pack holds instances of */
  readonly packIds: Set<string>;
  world: PhysicsWorld | null;
  query: RapierQueryWorld | null;
  sync: BodySync | null;
  proxies: VisualProxyLayer | null;
  /** the build threw: not tried again */
  failed: boolean;
}

interface Tracked { row: RowRec; place: PlaceId }

const live = new Set<PhysicsPortImpl>();
const NO_TAGS: readonly string[] = [];
const SHARED_LOADER: RapierLoader = { load: loadRapier, current: rapierIfLoaded };

/**
 * Rapier loaded and every stored build of every live port run (motion §5.1). The LOADING gate awaits it, so no match starts
 * without physics; headless tools await it before `boot({ headless: true })`, so the home place builds during the boot.
 */
export function ensurePhysics(): Promise<void> {
  if (live.size === 0) return loadRapier().then(() => undefined);
  return Promise.all([...live].map((p) => p.ensure())).then(() => undefined);
}

export class PhysicsPortImpl implements PhysicsPort {
  /** both VMs step in the same worlds in v1 (motion §5.1): one handle, `world(place)` answers a place's PhysicsWorld */
  readonly vmWorlds: Record<VmId, unknown>;
  private readonly loader: RapierLoader;
  private host: PhysicsHost | null;
  private dynamicsFactory: DynamicsFactory | null;
  private readonly places = new Map<PlaceId, PlaceState>();
  /** rows with a body (or with colliders in their place's pack), by id */
  private readonly tracked = new Map<RowId, Tracked>();
  /** places whose build waits for Rapier */
  private stored = 0;
  private lastStepped: PlaceId | null = null;
  private readonly warned = new Set<string>();
  /** gravity written at runtime per place (R-3); wins over the place config and survives a rebuild of the place's world */
  private readonly gravityOverride = new Map<PlaceId, Vec3>();
  /** opt-in world default for characters (R-5), see rapier/kcc-ccd.ts */
  private readonly characterCcd: boolean;
  private readonly syncHost: SyncHost;
  private disposed = false;

  constructor(opts: PhysicsPortOptions = {}) {
    this.loader = opts.loader ?? SHARED_LOADER;
    this.host = opts.host ?? null;
    this.dynamicsFactory = opts.dynamics ?? null;
    this.characterCcd = opts.characterCcd === true;
    const handle = Object.freeze({ kind: 'rapier-physics' as const, world: (place: PlaceId): PhysicsWorld | null => this.world(place) });
    this.vmWorlds = Object.freeze({ platform: handle, client: handle });
    const port = (): PhysicsPortImpl => this;
    // one object for every place's sync; it reads the host at call time, so the host may be attached after the first build
    this.syncHost = {
      ignoredTags: opts.ignoredTags ?? [],
      get facts(): AssetFactsPort | null { return port().host?.assets ?? null; },
      get scripted(): ScriptedColliders | null { return port().host?.geometry ?? null; },
      worldPose: (row) => this.worldPose(row),
      write: (row, pos, vel, grounded, rot, angVel) => this.host?.store.engineWriteTransform(row, pos, vel, grounded, rot, angVel),
      warn: (m) => this.warn(m),
    };
    live.add(this);
    this.bindQueries();
  }

  // ── wiring ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** the row store and the optional services; before it the port records rows and builds worlds but writes nothing back */
  attach(host: PhysicsHost): void {
    this.host = host;
  }

  /** `attach` from a kernel: its store, its roster's place configs, its asset and camera ports */
  attachKernel(k: KernelLike, extra: Partial<PhysicsHost> = {}): void {
    const index = k.placeIndex?.placeIndex;
    const host: PhysicsHost = { store: k.store };
    if (index) host.placeConfig = (p) => index[p];
    if (k.ports?.assets) host.assets = k.ports.assets;
    if (k.ports?.camera) host.camera = k.ports.camera;
    this.attach({ ...host, ...extra });
  }

  /**
   * R-3: `ctx.place.gravity = v` changes the physics world of `place` (the kernel's place-handle setter calls this). Returns
   * false for a non-finite vector. A place whose world is not built yet takes it at its build, and a rebuilt world keeps it.
   */
  setGravity(place: PlaceId, g: Vec3): boolean {
    if (this.disposed || !Number.isFinite(g.x) || !Number.isFinite(g.y) || !Number.isFinite(g.z)) return false;
    this.gravityOverride.set(place, { x: g.x, y: g.y, z: g.z });
    this.places.get(place)?.world?.setGravity(g);
    return true;
  }

  /** the gravity written by `setGravity` for `place`, else the place config's, else null (the caller's default) */
  gravityOf(place: PlaceId): Vec3 | null {
    const o = this.gravityOverride.get(place);
    if (o) return { ...o };
    const g = this.host?.placeConfig?.(place)?.gravity;
    return g ? { x: g.x, y: g.y, z: g.z } : null;
  }

  /** PH4: the dynamic-body backend; places built before it get one now */
  setDynamics(factory: DynamicsFactory | null): void {
    this.dynamicsFactory = factory;
    if (!factory) return;
    for (const st of this.places.values()) if (st.sync && st.world && !st.sync.dynamics) st.sync.dynamics = factory(st.world, this.syncHost);
  }

  private bindQueries(): void {
    bindPhysicsQueries({
      world: (place) => this.queryWorld(place),
      warn: (m) => this.warn(m),
      camera: () => this.host?.camera ?? null,
    });
    bindQueryWorlds((place) => this.queryWorld(place));
    bound = this;
  }

  private warn(message: string): void {
    if (this.host?.warn) this.host.warn(message);
    else console.warn(`[physics] ${message}`);
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.warn(message);
  }

  private worldPose(row: RowRec): RowWorldPose {
    const own = this.host?.worldPose;
    if (own) return own(row);
    const tf = row.tf;
    if (row.parentId === null) return tf;
    const store = this.host?.store;
    let pos = tf.pos, rot = tf.rot, scale = tf.scale;
    let parentId: RowId | null = row.parentId;
    for (let depth = 0; parentId !== null && store && depth < 64; depth++) {
      const p = store.get(parentId);
      if (!p) break;
      const pt = p.tf;
      const r = rotate(pt.rot, pos.x * pt.scale.x, pos.y * pt.scale.y, pos.z * pt.scale.z);
      pos = { x: pt.pos.x + r.x, y: pt.pos.y + r.y, z: pt.pos.z + r.z };
      rot = mulQuat(pt.rot, rot);
      scale = { x: pt.scale.x * scale.x, y: pt.scale.y * scale.y, z: pt.scale.z * scale.z };
      parentId = p.parentId;
    }
    return { pos, rot, scale };
  }

  private tagsOf(rowId: string): readonly string[] {
    return this.tracked.get(rowId)?.row.tags ?? this.host?.store.get(rowId)?.tags ?? NO_TAGS;
  }

  // ── the load ───────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** this port's part of `ensurePhysics()`: the loader resolved and every stored build run (a failed build rejects) */
  ensure(): Promise<void> {
    return this.loader.load().then(() => {
      this.flushStored(true);
    });
  }

  /** places stored for a later build */
  get storedBuilds(): number { return this.stored; }

  /** builds the stored places once Rapier is there; `strict` lets a build error out (ensure), else it is logged once */
  private flushStored(strict = false): void {
    if (this.stored === 0 || this.disposed) return;
    const R = this.loader.current();
    if (!R) return;
    for (const st of this.places.values()) {
      if (st.world || st.failed) continue;
      try {
        this.buildNow(st, R);
        this.stored--;
      } catch (err) {
        st.failed = true;
        this.stored--;
        if (strict) throw err;
        this.warnOnce(`build:${st.id}`, `physics ${st.id}: the stored build failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  private buildNow(st: PlaceState, R: Rapier): void {
    const cfg = this.host?.placeConfig?.(st.id);
    const g = this.gravityOverride.get(st.id) ?? cfg?.gravity;
    const world = new PhysicsWorld(st.id, g && Number.isFinite(g.x) && Number.isFinite(g.y) && Number.isFinite(g.z) ? { gravity: g } : {}, R);
    if (this.characterCcd) world.characterCcd = true;
    try {
      world.build(st.bake.colliders, (rowId) => this.tagsOf(rowId));
    } catch (err) {
      world.free();
      throw err;
    }
    const query = new RapierQueryWorld(world, () => st.proxies);
    const sync = new BodySync(world, query, st.bake, this.syncHost);
    sync.liquids = liquidVolumes(cfg?.terrain);
    if (this.dynamicsFactory) sync.dynamics = this.dynamicsFactory(world, this.syncHost);
    st.world = world;
    st.query = query;
    st.sync = sync;
    // X-43: the pack's runtime keys (door wrecks) answer `colliderForSync` from now on
    const geometry = this.host?.geometry;
    if (geometry?.registerColliders && st.bake.colliders.runtimeKeys.length > 0) {
      const list: Array<{ key: string; collider: ScriptedCollider }> = [];
      for (const rk of st.bake.colliders.runtimeKeys) {
        const k = st.bake.colliders.keys[rk.key];
        if (!k) continue;
        list.push({ key: rk.spec, collider: k.box ? { box: k.box } : k.sphere !== undefined ? { sphere: k.sphere } : k.tris ? { tris: k.tris } : null });
      }
      geometry.registerColliders(list);
    }
    // the bodies of the rows recorded for the place meanwhile, in spawn-serial order (determinism, motion §5.3)
    const rows: RowRec[] = [];
    for (const t of this.tracked.values()) if (t.place === st.id) rows.push(t.row);
    if (rows.length === 0) return;
    rows.sort((a, b) => a.serial - b.serial);
    for (const row of rows) sync.spawn(row);
    world.refresh();
  }

  // ── PhysicsPort: places ────────────────────────────────────────────────────────────────────────────────────────────────

  buildPlace(place: PlaceId, bake: PlaceBake): void {
    if (this.disposed) return;
    const old = this.places.get(place);
    if (old) {
      // built again without a dispose in between: the recorded rows stay, their bodies are made again
      this.freeState(old);
      this.places.delete(place);
    }
    const packIds = new Set<string>();
    for (const inst of bake.colliders.instances) packIds.add(inst.rowId);
    const st: PlaceState = { id: place, bake, packIds, world: null, query: null, sync: null, proxies: old?.proxies ?? null, failed: false };
    this.places.set(place, st);
    const R = this.loader.current();
    if (!R) {
      this.stored++;
      // rows of the place that were reported before it: their pose of now is the earliest one known
      for (const t of this.tracked.values()) if (t.place === place && packIds.has(t.row.id)) noteBakedPose(bake, t.row.id, this.worldPose(t.row));
      return;
    }
    try {
      this.buildNow(st, R);
    } catch (err) {
      st.failed = true;
      throw err;
    }
  }

  private freeState(st: PlaceState): void {
    if (!st.world && !st.failed) this.stored--;
    st.sync?.clear();
    st.world?.free();
    st.world = null;
    st.query = null;
    st.sync = null;
  }

  disposePlace(place: PlaceId): void {
    const st = this.places.get(place);
    if (!st) return;
    this.freeState(st);
    this.places.delete(place);
    for (const [id, t] of this.tracked) if (t.place === place) this.tracked.delete(id);
    if (this.lastStepped === place) this.lastStepped = null;
  }

  // ── PhysicsPort: rows ──────────────────────────────────────────────────────────────────────────────────────────────────

  rowSpawned(row: RowRec): void {
    const place = row.place;
    if (place === null || this.disposed) return;
    const st = this.places.get(place);
    if (bodyKindOf(row.props['physics']) === null && !st?.packIds.has(row.id)) return;
    this.tracked.set(row.id, { row, place });
    if (st?.sync) st.sync.spawn(row);
    // the build is stored: the row's body waits for it, but the pose it spawned with (its pack instances' pose) is taken now
    else if (st?.packIds.has(row.id)) noteBakedPose(st.bake, row.id, this.worldPose(row));
  }

  rowDestroyed(row: RowRec): void {
    const t = this.tracked.get(row.id);
    if (!t || t.row !== row) return;
    this.tracked.delete(row.id);
    this.places.get(t.place)?.sync?.destroy(row);
  }

  /** the row's place state, re-homing its body when the row stands in another place than its body (a cross) */
  private home(row: RowRec): BodySync | null {
    const t = this.tracked.get(row.id);
    if (!t || t.row !== row) return null;
    if (row.place !== null && row.place !== t.place) {
      this.places.get(t.place)?.sync?.destroy(row);
      t.place = row.place;
      this.places.get(t.place)?.sync?.spawn(row);
      return null;
    }
    return this.places.get(t.place)?.sync ?? null;
  }

  onPhysicsWrite(row: RowRec, value: unknown): void {
    if (row.place === null || this.disposed) return;
    const t = this.tracked.get(row.id);
    if (!t || t.row !== row) {
      if (bodyKindOf(value) === null) return;
      this.tracked.set(row.id, { row, place: row.place });
    }
    this.home(row)?.physicsWrite(row, value);
  }

  setPosition(row: RowRec, p: Vec3): void { this.home(row)?.setPosition(row, p); }
  setRotation(row: RowRec, q: Quat): void { this.home(row)?.setRotation(row, q); }
  setVelocity(row: RowRec, v: Vec3): void { this.home(row)?.setVelocity(row, v); }
  setAngularVelocity(row: RowRec, w: Vec3): void { this.home(row)?.setAngularVelocity(row, w); }
  setForce(row: RowRec, key: string, f: unknown | null): void { this.home(row)?.setForce(row, key, f); }
  setSpectating(row: RowRec, _on: boolean): void { this.home(row)?.setSpectating(row); }

  applyImpulse(target: RowId, impulse?: Vec3, angularImpulse?: Vec3, position?: Vec3): void {
    const t = this.tracked.get(target);
    // a body that does not exist yet gets nothing (as live, authored module)
    if (t) this.places.get(t.place)?.sync?.dynamics?.applyImpulse(target, impulse, angularImpulse, position);
  }

  /** motion §5.8: hold a dynamic body at `y` (no gravity, asleep) until a write or an impulse wakes it; needs PH4 */
  holdBody(row: RowRec, y: number): void {
    this.home(row)?.dynamics?.hold?.(row, y);
  }

  // ── PhysicsPort: the step ──────────────────────────────────────────────────────────────────────────────────────────────

  step(place: PlaceId, dtS: number): void {
    if (this.stored > 0) this.flushStored();
    const st = this.places.get(place);
    if (!st) return;
    this.lastStepped = place;
    if (st.sync) { st.sync.step(dtS); return; }
    // X-32: no world yet. Characters hold still: no movement, not grounded, realised velocity 0
    const store = this.host?.store;
    if (!store) return;
    for (const t of this.tracked.values()) {
      if (t.place !== place || t.row.parentId !== null || bodyKindOf(t.row.props['physics']) !== 'character') continue;
      const tf = t.row.tf;
      if (tf.vel.x === 0 && tf.vel.y === 0 && tf.vel.z === 0 && !tf.grounded) continue;
      store.engineWriteTransform(t.row, tf.pos, { x: 0, y: 0, z: 0 }, false);
    }
  }

  drainTriggerEnters(): Array<{ trigger: RowId; other: RowId }> {
    let out: Array<{ trigger: RowId; other: RowId }> | null = null;
    const serialOf = (id: string): number => this.tracked.get(id)?.row.serial ?? Number.MAX_SAFE_INTEGER;
    let from = 0;
    for (const st of this.places.values()) {
      if (!st.sync || st.sync.triggers.pending === 0) continue;
      const part = st.sync.triggers.drain(serialOf);
      if (out) for (const e of part) out.push(e); else out = part;
      from++;
    }
    if (out && from > 1) out.sort((x, y) => serialOf(x.trigger) - serialOf(y.trigger) || serialOf(x.other) - serialOf(y.other));
    return out ?? [];
  }

  // ── PhysicsPort: queries ───────────────────────────────────────────────────────────────────────────────────────────────

  groundY(place: PlaceId, x: number, z: number): number | null {
    return this.queryWorld(place)?.groundY(x, z) ?? null;
  }

  setVisualProxies(place: PlaceId, proxies: VisualProxySoup): void {
    const st = this.places.get(place);
    // a place that is not resident has nothing to query; replacing the soup drops the old trees
    if (st) st.proxies = new VisualProxyLayer(proxies, (rowId) => this.tagsOf(rowId));
  }

  // ── beyond the interface ───────────────────────────────────────────────────────────────────────────────────────────────

  /** the place's world; null while the place is not resident or its build is stored */
  world(place: PlaceId): PhysicsWorld | null {
    return this.places.get(place)?.world ?? null;
  }

  /** the query backend of a place (`builtin/physics.raycast`); null → every query answers null (X-32) */
  queryWorld(place: PlaceId): RapierQueryWorld | null {
    if (this.stored > 0) this.flushStored();
    return this.places.get(place)?.query ?? null;
  }

  /** true when the place has a built world */
  isBuilt(place: PlaceId): boolean {
    return this.places.get(place)?.world?.built === true;
  }

  /**
   * Render's `StaticRaycaster` (fx floor height): the nearest fixed collider under a point of the given place, by default the
   * place stepped last (the active one). null until that place's physics is built.
   */
  staticRaycaster(place?: () => PlaceId | null): { castDown(origin: Vec3, maxDist: number): { y: number; normal: Vec3 } | null } {
    return {
      castDown: (origin, maxDist) => {
        const p = place ? place() : this.lastStepped;
        return p === null ? null : (this.queryWorld(p)?.castDown(origin, maxDist) ?? null);
      },
    };
  }

  /** touch aim friction (io §4.8.4); see rapier/query.ts `aimTargets` */
  aimTargets(place: PlaceId, eye: Vec3, dir: Vec3, maxDist: number, radius: number, options: { tags?: readonly string[] } = {}): AimTarget[] {
    return this.queryWorld(place)?.aimTargets(eye, dir, maxDist, radius, options) ?? [];
  }

  /** every body of a place as plain data (nav overlay, debug); [] while the place has no world */
  bodyRecords(place: PlaceId): BodyRecord[] {
    return this.places.get(place)?.sync?.records() ?? [];
  }

  /** `ctx.self.liquid` of a character (motion §5.9); null for a row without one or a place without water */
  liquidOf(row: RowRec): LiquidState | null {
    const t = this.tracked.get(row.id);
    return t ? (this.places.get(t.place)?.sync?.liquidOf(row.id) ?? null) : null;
  }

  /** resident places (built or stored) */
  residentPlaces(): PlaceId[] {
    return [...this.places.keys()];
  }

  /** frees every world and gives the builtin bindings back; the port is dead afterwards */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const st of this.places.values()) this.freeState(st);
    this.places.clear();
    this.tracked.clear();
    this.stored = 0;
    live.delete(this);
    if (bound === this) {
      bindPhysicsQueries(null);
      bindQueryWorlds(null);
      bound = null;
    }
  }
}

/** the port whose worlds answer `builtin/physics` and `aimTargets` now */
let bound: PhysicsPortImpl | null = null;

export function createPhysicsPort(opts: PhysicsPortOptions = {}): PhysicsPortImpl {
  return new PhysicsPortImpl(opts);
}

function rotate(q: Readonly<Quat>, x: number, y: number, z: number): Vec3 {
  const tx = 2 * (q.y * z - q.z * y), ty = 2 * (q.z * x - q.x * z), tz = 2 * (q.x * y - q.y * x);
  return { x: x + q.w * tx + (q.y * tz - q.z * ty), y: y + q.w * ty + (q.z * tx - q.x * tz), z: z + q.w * tz + (q.x * ty - q.y * tx) };
}

function mulQuat(a: Readonly<Quat>, b: Readonly<Quat>): Quat {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y, y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w, w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  const l = Math.hypot(x, y, z, w) || 1;
  return { x: x / l, y: y / l, z: z / l, w: w / l };
}
