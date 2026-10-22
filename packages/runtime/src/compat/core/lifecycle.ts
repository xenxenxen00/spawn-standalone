// Spawn, destroy, cascade, lifetimes and the deferred hooks (docs/design/core-runtime.md §4.1, §4.5, §5.2, §5.4, §10.2, §14;
// D-CORE-05/06/07; contract §3.6, §3.6.1 (M21), §26; docs/architecture.md X-24).
//
// spawn (`ctx.spawn(idOrSpec, spec?)`, scene rows, boot): template merge + normalisation (spec/*), id assignment, place, VM and
// spawner, then the WHOLE batch (the row and its flattened children) is validated before any record is inserted; a refusal throws
// SpawnRefused ("spawn refused: <why>", metrics.spawnRefused) and leaves nothing behind. A duplicate top-level id is a no-op that
// returns the existing id (warned once, metrics.duplicateSpawns). Then: records inserted parent first → behaviours bound (ears,
// schedule, ctx) → ports.physics.rowSpawned + KernelEvents.rowSpawned per row → onSpawn queued for the next phase boundary. The id
// is returned synchronously and getObject / query / children see the row at once.
//
// VM (core §10.2): `simulatedBy: 'platform'` → platform; spawned by a sim, a scene or the kernel → platform (the kernel's human
// and rig pass `vm: 'client'`); spawned by a row's behaviour → that row's VM (a probe the body parents to an enemy stays a client
// row, which is what X-24 hides from the platform); `children` → their parent's VM (and its `audience: 'local'` unless they
// name one). Spawner (contract §3.6.1): the calling row while it is alive; null for sims, scenes, the kernel, spawns made inside
// the spawner's own onDestroy, and specs with the port-only flag `__portUnowned: true` (PORT_FIX D2).
//
// destroy (`ctx.destroy(id | ids)`, lifetimes, place unloads): detaches the row and every dependant at once (children always,
// spawner-owned rows when ENGINE_RULES.spawnerOwnership is 'cascade'; transitive, post-order: dependants first); the ids are free
// at once. At the next phase boundary onDestroy runs for each detached row in that order with the row's last values, then
// ports.physics.rowDestroyed, phase 'disposed' and KernelEvents.rowDestroyed (the runtime drops the row's listeners, timers,
// tweens and attached fx there). A row destroyed before its onSpawn ran gets neither hook. A missing id warns once and never
// throws; an act id (`fx-12`, `snd-3`) ends that act through kernel.acts.
//
// The tick hooks installed on kernel.time (sched/runtime.ts): flushDeferred (◆: the onSpawn queue, then the onDestroy queue),
// expireLifetimes (step G: rows whose expiresAtTick ≤ tick, in (tick, serial) order, destroyed like ctx.destroy) and afterPhysics
// (step E: body-less velocity integration, core §5.4; then onTriggerEnter dispatch). A later package that also needs afterPhysics
// (C4: out of bounds) calls `kernel.lifecycle.afterPhysics(tick)` from its own hook, which replaces this one.
import type { CoreKernel } from './kernel.ts';
import { asBehaviorModule, SpawnRefused } from './modules/registry.ts';
import { actIdPrefixOf, childId, mintId, parentScopedId, validateId } from './ids.ts';
import { bindBehavior, completeBind, type BindEnv } from './behaviors/bind.ts';
import { createRowRec } from './store/rows.ts';
import { composePose, isCameraAttached, transformFromSpec, worldPose, type Pose, type SpecTransform } from './store/transform.ts';
import { flattenChildren } from './spec/children.ts';
import { normalizeSpec, type NormalizedSpec } from './spec/normalize.ts';
import { expandSpec, isPlain } from './spec/template.ts';
import { placesOf, visibleTo } from './query.ts';
import type {
  BehaviorCtx,
  BehaviorInstance,
  BehaviorModule,
  CallerRef,
  ObjectSpec,
  PlaceId,
  PlayerRec,
  RigCtx,
  RigRec,
  RowId,
  RowRec,
  Vec3,
  VmId,
} from './types.ts';
import { ENGINE } from './rules.ts';
import { vmForSpawn } from './vm/machine.ts';

/** the kernel members the lifecycle uses (`places` may still be unwired: KernelNotWiredError) */
export type LifecycleKernel = Pick<
  CoreKernel,
  'ids' | 'store' | 'registry' | 'time' | 'clock' | 'rules' | 'metrics' | 'ports' | 'placeIndex' | 'worldConfig' | 'notify' | 'acts' | 'places' | 'dev'
>;

/** the ctx of a behaviour instance, created once per instance (C5: ctx/behavior.ts, ctx/rig.ts) */
export type CtxFactory = (row: RowRec, inst: BehaviorInstance) => BehaviorCtx | RigCtx;

/** what only the kernel's own spawns set (boot: the human body, the camera rig; places: scene rows) */
export interface SpawnExtras {
  vm?: VmId;
  player?: PlayerRec;
  rig?: RigRec;
  fromScene?: { place: PlaceId; cell: string };
}

type Obj = Record<string, unknown>;
type DestroyTarget = RowId | { readonly id: RowId } | null | undefined;

/** one row of a validated spawn batch */
interface Planned {
  id: RowId;
  serial: number;
  parentId: RowId | null;
  merged: ObjectSpec;
  spec: NormalizedSpec;
  vm: VmId;
  place: PlaceId | null;
  audience: 'near' | 'all' | 'local';
  modules: Array<{ path: string; module: BehaviorModule | null }>;
  tf: SpecTransform;
  vel: Vec3 | null;
  angVel: Vec3 | null;
  /** world pose at spawn, for the lookAt of its children */
  world: Pose;
}

const refuse = (why: string): never => {
  throw new SpawnRefused(`spawn refused: ${why}`);
};

const IDENTITY: Pose = { pos: { x: 0, y: 0, z: 0 }, rot: { x: 0, y: 0, z: 0, w: 1 }, scale: { x: 1, y: 1, z: 1 } };
/** float slack so lifetime 0.1 s is 3 ticks, not 4 (0.1 × 30 = 3.0000000000000004) */
const LIFETIME_EPS = 1e-9;
const WARNED_MAX = 4096;
/** removals remembered for the "destroy: no such object" diagnostic (a ring: the oldest is forgotten first) */
export const GONE_MAX = 1024;

/**
 * How a row left, as the "destroy: no such object" warning names it: `lifetime` (its spec lifetime ran out, step G),
 * `cascade from <id>` (a dependant of a row being destroyed: its child, or with spawner ownership a row it spawned),
 * `onOutOfBounds` (a ctx.destroy made inside an onOutOfBounds hook), `destroyed by <script>` (any other ctx.destroy: the
 * calling behaviour's or sim's script, `scene <place>`, `kernel`), `place unload`.
 */
export type RemovalCause = string;

/** who issues a destroy (the trailing `by <who>` of the warning) and the cause recorded for the row it removes */
export interface DestroyHow {
  readonly cause: RemovalCause;
  readonly by: string;
}

/**
 * The last GONE_MAX removals (id, tick, cause), oldest overwritten first, with an id index; an id removed again (re-spawned
 * meanwhile) keeps only its latest removal. Bounded memory, and deterministic: it depends on the order of removals only.
 */
export class GoneRing {
  readonly #ids: Array<RowId | null>;
  readonly #ticks: Int32Array;
  readonly #causes: Array<RemovalCause | null>;
  readonly #at = new Map<RowId, number>();
  #next = 0;
  readonly capacity: number;

  constructor(capacity: number = GONE_MAX) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.#ids = new Array<RowId | null>(this.capacity).fill(null);
    this.#ticks = new Int32Array(this.capacity);
    this.#causes = new Array<RemovalCause | null>(this.capacity).fill(null);
  }

  /** ids remembered now (≤ capacity) */
  get size(): number {
    return this.#at.size;
  }

  note(id: RowId, tick: number, cause: RemovalCause): void {
    const i = this.#next;
    const old = this.#ids[i];
    if (old !== null && old !== undefined && this.#at.get(old) === i) this.#at.delete(old);
    this.#ids[i] = id;
    this.#ticks[i] = tick;
    this.#causes[i] = cause;
    this.#at.set(id, i);
    this.#next = (i + 1) % this.capacity;
  }

  get(id: RowId): { tick: number; cause: RemovalCause } | null {
    const i = this.#at.get(id);
    return i === undefined ? null : { tick: this.#ticks[i]!, cause: this.#causes[i]! };
  }
}

const LIFETIME_HOW: DestroyHow = Object.freeze({ cause: 'lifetime', by: 'lifetime' });
const ENGINE_HOW: DestroyHow = Object.freeze({ cause: 'destroyed by kernel', by: 'kernel' });

function vectorOf(v: unknown): Vec3 | null {
  if (!isPlain(v)) return null;
  const c = (x: unknown): number => (x === undefined ? 0 : typeof x === 'number' && Number.isFinite(x) ? x : Number.NaN);
  const out = { x: c(v['x']), y: c(v['y']), z: c(v['z']) };
  return Number.isNaN(out.x) || Number.isNaN(out.y) || Number.isNaN(out.z) ? null : out;
}

const isZero = (v: Vec3): boolean => v.x === 0 && v.y === 0 && v.z === 0;

/** a row whose physics port body integrates it (core §5.4): a `physics` prop naming a body other than "none" */
export function hasBody(row: RowRec): boolean {
  const p = row.props['physics'];
  if (typeof p === 'string') return p !== 'none';
  if (isPlain(p)) return p['body'] !== 'none' && p['body'] !== undefined && p['body'] !== null && p['body'] !== false;
  return false;
}

/** the stale-entry count above which the lifetime heap may rebuild itself (with stale·2 > size) */
const LIFETIME_STALE_MIN = 256;

/**
 * a min-heap of (expiresAtTick, serial) entries; stale entries (row gone or re-timed) are skipped when popped. A row disposed
 * before its tick leaves a stale entry that would keep the row (and all it references) reachable until that tick, so
 * `noteDisposed` counts them and the heap is rebuilt from its alive entries once stale > LIFETIME_STALE_MIN and stale·2 > size.
 * (tick, serial) is a total order, so the rebuild leaves the pop order unchanged.
 */
class LifetimeHeap {
  #a: Array<{ tick: number; row: RowRec }> = [];
  /** rows with an entry in #a (one at most: expiresAtTick is set once, at spawn) */
  readonly #in = new WeakSet<RowRec>();
  #stale = 0;

  get size(): number {
    return this.#a.length;
  }

  /** entries whose row was disposed while still queued */
  get stale(): number {
    return this.#stale;
  }

  /** the row was disposed: its queued entry (if any) is stale; rebuilds once stale entries dominate */
  noteDisposed(row: RowRec): void {
    if (!this.#in.has(row)) return;
    this.#stale++;
    if (this.#stale > LIFETIME_STALE_MIN && this.#stale * 2 > this.#a.length) this.#rebuild();
  }

  #rebuild(): void {
    const keep: Array<{ tick: number; row: RowRec }> = [];
    for (const e of this.#a) {
      if (e.row.phase === 'alive') keep.push(e);
      else this.#in.delete(e.row);
    }
    // a sorted array is a valid min-heap
    keep.sort((x, y) => x.tick - y.tick || x.row.serial - y.row.serial);
    this.#a = keep;
    this.#stale = 0;
  }

  #less(i: number, j: number): boolean {
    const x = this.#a[i]!;
    const y = this.#a[j]!;
    return x.tick < y.tick || (x.tick === y.tick && x.row.serial < y.row.serial);
  }

  #swap(i: number, j: number): void {
    const t = this.#a[i]!;
    this.#a[i] = this.#a[j]!;
    this.#a[j] = t;
  }

  push(tick: number, row: RowRec): void {
    this.#a.push({ tick, row });
    this.#in.add(row);
    let i = this.#a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.#less(i, p)) break;
      this.#swap(i, p);
      i = p;
    }
  }

  peek(): { tick: number; row: RowRec } | undefined {
    return this.#a[0];
  }

  pop(): { tick: number; row: RowRec } | undefined {
    const top = this.#a[0];
    if (top) {
      this.#in.delete(top.row);
      if (top.row.phase === 'disposed') this.#stale--;
    }
    const last = this.#a.pop();
    if (this.#a.length > 0 && last) {
      this.#a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.#a.length && this.#less(l, m)) m = l;
        if (r < this.#a.length && this.#less(r, m)) m = r;
        if (m === i) break;
        this.#swap(i, m);
        i = m;
      }
    }
    return top;
  }
}

export class Lifecycle {
  readonly #k: LifecycleKernel;
  #ctxFactory: CtxFactory | null = null;
  #warnSink: (message: string) => void = (m) => console.warn(`[lifecycle] ${m}`);
  readonly #warned = new Set<string>();
  /** rows whose onSpawn runs at the next boundary, creation order */
  #spawnQueue: RowRec[] = [];
  readonly #queued = new WeakSet<RowRec>();
  /** detached rows waiting for disposal, post-order; `hooks` false: their onSpawn never ran, so neither hook runs */
  #destroyQueue: Array<{ readonly row: RowRec; readonly hooks: boolean }> = [];
  readonly #lifetimes = new LifetimeHeap();
  /** body-less rows with a velocity written to them (core §5.4) */
  readonly #moving = new Set<RowRec>();
  /** the recent removals the "destroy: no such object" warning explains itself with */
  readonly gone = new GoneRing();
  /** warnings issued (each distinct message once) */
  warnings = 0;

  constructor(k: LifecycleKernel) {
    this.#k = k;
    k.time.use({
      flushDeferred: () => this.flushDeferred(),
      expireLifetimes: (tick) => this.expireLifetimes(tick),
      afterPhysics: (tick) => this.afterPhysics(tick),
    });
    k.store.observe((c) => {
      if (c.field === 'velocity' || c.field === 'physics') this.#moving.add(c.row);
    });
  }

  /** C5 installs the ctx factories; until then behaviour instances get a null ctx */
  setCtxFactory(f: CtxFactory | null): void {
    this.#ctxFactory = f;
  }

  /** where warnings go (default console.warn) */
  setWarnSink(sink: (message: string) => void): void {
    this.#warnSink = sink;
  }

  /** onSpawn hooks waiting for a boundary */
  get pendingSpawns(): number {
    return this.#spawnQueue.length;
  }

  /** detached rows waiting for disposal */
  get pendingDestroys(): number {
    return this.#destroyQueue.length;
  }

  /** lifetime heap entries (alive and stale) and the stale ones among them (diagnostics, tests) */
  get lifetimeHeap(): { size: number; stale: number } {
    return { size: this.#lifetimes.size, stale: this.#lifetimes.stale };
  }

  warnOnce(message: string): void {
    if (this.#warned.has(message)) return;
    if (this.#warned.size >= WARNED_MAX) this.#warned.clear();
    this.#warned.add(message);
    this.warnings++;
    this.#warnSink(message);
  }

  // ── spawn ──────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** `ctx.spawn(spec)` / `ctx.spawn(id, spec)` for `caller` (core §4.1); throws SpawnRefused */
  spawn(caller: CallerRef, a: unknown, b?: unknown, extras: SpawnExtras = {}): RowId {
    try {
      return this.#spawn(caller, a, b, extras);
    } catch (err) {
      if (err instanceof Error && err.name === 'SpawnRefused') this.#k.metrics.spawnRefused++;
      throw err;
    }
  }

  /** a roster place (an empty roster, as in a kernel built without places, knows no roster and accepts any place) */
  #roster(place: PlaceId): boolean {
    const roster = this.#k.placeIndex.placeIndex;
    return Object.hasOwn(roster, place) || Object.keys(roster).length === 0;
  }

  #callerPlace(caller: CallerRef): PlaceId | null {
    switch (caller.kind) {
      case 'row':
        return caller.row.place;
      case 'sim':
        return caller.sim.place ?? this.#k.worldConfig.defaultPlace;
      case 'scene':
        return caller.place;
      case 'kernel':
        return this.#k.worldConfig.defaultPlace;
    }
  }

  #modulesOf(spec: NormalizedSpec): Planned['modules'] {
    const reg = this.#k.registry;
    return spec.behavior.map((path) => {
      if (!reg.knows(path)) refuse(`unknown behavior ${path}`);
      const ns = reg.get(path);
      if (ns === undefined) return { path, module: null };
      try {
        return { path, module: asBehaviorModule(ns, path) };
      } catch (err) {
        return refuse(`behavior module ${path} is malformed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  #transformOf(spec: NormalizedSpec, place: PlaceId | null, parentWorld: Pose | null): Pick<Planned, 'tf' | 'vel' | 'angVel' | 'world'> {
    const physics = this.#k.ports.physics;
    const ground = place !== null ? (x: number, z: number) => physics.groundY(place, x, z) : undefined;
    const tf = transformFromSpec(spec.transform, { ...(ground ? { ground } : {}), parentPose: parentWorld });
    const t = spec.transform;
    const vel = t.velocity !== undefined ? vectorOf(t.velocity) : null;
    const angVel = t.angularVelocity !== undefined ? vectorOf(t.angularVelocity) : null;
    if (t.velocity !== undefined && vel === null) tf.invalid.push('velocity');
    if (t.angularVelocity !== undefined && angVel === null) tf.invalid.push('angularVelocity');
    const local: Pose = { pos: tf.init.pos ?? IDENTITY.pos, rot: tf.init.rot ?? IDENTITY.rot, scale: tf.init.scale ?? IDENTITY.scale };
    const world = tf.camera !== null ? local : parentWorld ? composePose(parentWorld, local) : local;
    return { tf, vel, angVel, world };
  }

  #spawn(caller: CallerRef, a: unknown, b: unknown, extras: SpawnExtras): RowId {
    const k = this.#k;
    const store = k.store;
    let explicitId: string | null = null;
    let input: unknown;
    if (typeof a === 'string') {
      explicitId = a;
      input = b ?? {};
    } else input = a;
    if (!isPlain(input)) refuse('the spec is not an object');
    const raw = input as Obj;
    const merged = expandSpec(raw, k.registry);
    const spec = normalizeSpec(merged);

    // parent and place
    let parent: RowRec | null = null;
    if (spec.parent !== null) {
      parent = store.get(spec.parent) ?? null;
      if (parent === null) refuse(`parent ${spec.parent} does not exist`);
    }
    let place: PlaceId | null;
    if (parent !== null) place = parent.place;
    else if (spec.place !== null) place = spec.place;
    else place = this.#callerPlace(caller);
    if (parent === null && place !== null && !this.#roster(place)) refuse(`unknown place ${place}`);

    // VM and spawner (core §10.2, contract §3.6.1)
    const callerRow = caller.kind === 'row' ? caller.row : null;
    const vm: VmId = vmForSpawn({ forced: extras.vm, simulatedBy: spec.simulatedBy, spawnerVm: callerRow?.vm ?? null });
    const spawnerId = callerRow !== null && callerRow.phase === 'alive' && !spec.unowned ? callerRow.id : null;

    // id (core §4.4)
    const idRaw = explicitId ?? (typeof raw['id'] === 'string' ? raw['id'] : null) ?? spec.id;
    let serial = store.allocSerial();
    let id: RowId;
    if (parent !== null) id = idRaw !== null ? parentScopedId(parent.id, idRaw) : this.#unnamedChild(parent.id);
    else if (idRaw !== null) id = idRaw;
    else {
      id = mintId(serial);
      while (store.has(id)) {
        serial = store.allocSerial();
        id = mintId(serial);
      }
    }
    if (!validateId(id)) refuse(`invalid id "${id}"`);
    if (store.has(id)) {
      k.metrics.duplicateSpawns++;
      this.warnOnce(`spawn: duplicate id ${id}`);
      return id;
    }

    // the batch: the row, then its children depth-first
    const root: Planned = {
      id,
      serial,
      parentId: parent?.id ?? null,
      merged,
      spec,
      vm,
      place,
      audience: spec.audience,
      modules: this.#modulesOf(spec),
      ...this.#transformOf(spec, place, parent !== null ? worldPose(store, parent) : null),
    };
    const batch: Planned[] = [root];
    const byId = new Map<RowId, Planned>([[id, root]]);
    for (const c of flattenChildren(id, spec.children, k.registry)) {
      if (!validateId(c.id)) refuse(`invalid id "${c.id}"`);
      if (byId.has(c.id) || store.has(c.id)) refuse(`duplicate id ${c.id} in the spawn of ${id}`);
      const up = byId.get(c.parentId)!;
      const p: Planned = {
        id: c.id,
        serial: 0,
        parentId: c.parentId,
        merged: c.merged,
        spec: c.spec,
        vm: vmForSpawn({ simulatedBy: c.spec.simulatedBy, spawnerVm: up.vm }),
        place,
        audience: c.spec.audienceGiven ? c.spec.audience : up.audience === 'local' ? 'local' : c.spec.audience,
        modules: this.#modulesOf(c.spec),
        ...this.#transformOf(c.spec, place, up.world),
      };
      batch.push(p);
      byId.set(c.id, p);
    }

    // commit: nothing below refuses
    for (const p of batch) if (p !== root) p.serial = store.allocSerial();
    const tick = k.clock.tick;
    const recs: RowRec[] = [];
    for (const p of batch) {
      const issues = [...p.spec.issues, ...p.tf.invalid];
      if (issues.length > 0) this.warnOnce(`spawn ${p.id}: invalid ${issues.join(', ')} ignored`);
      const life = p.spec.lifetime;
      const props = p.spec.props;
      if (p.tf.camera !== null) props['feetPosition'] = { ...p.tf.camera };
      const storedSpec = p.merged as Obj;
      delete storedSpec['__portUnowned'];
      const isRoot = p === root;
      const rec = createRowRec({
        id: p.id,
        serial: p.serial,
        vm: p.vm,
        place: p.place,
        explicitPlace: isRoot && p.spec.place !== null,
        parentId: p.parentId,
        spawnerId: isRoot ? spawnerId : null,
        ...(p.spec.name !== null ? { name: p.spec.name } : {}),
        tags: p.spec.tags,
        template: p.spec.template,
        spec: k.dev ? deepFreeze(storedSpec) : storedSpec,
        state: p.spec.state,
        props,
        transform: { ...p.tf.init, ...(p.vel ? { vel: p.vel } : {}), ...(p.angVel ? { angVel: p.angVel } : {}) },
        audience: p.audience,
        scope: p.spec.scope,
        visibility: p.spec.visibility,
        simulatedBy: p.spec.simulatedBy,
        lifetimeS: life,
        expiresAtTick: life !== null ? tick + Math.ceil(life * ENGINE.TICK_HZ - LIFETIME_EPS) : null,
        ...(isRoot && extras.player ? { player: extras.player } : {}),
        ...(isRoot && extras.rig ? { rig: extras.rig } : {}),
        ...(isRoot && extras.fromScene ? { fromScene: extras.fromScene } : {}),
      });
      store.insert(rec);
      recs.push(rec);
    }
    const env = this.#bindEnv();
    batch.forEach((p, i) => {
      const rec = recs[i]!;
      rec.behaviors = p.modules.map((m) => bindBehavior(rec, m.path, m.module, env));
    });
    for (const rec of recs) {
      if (rec.expiresAtTick !== null) this.#lifetimes.push(rec.expiresAtTick, rec);
      if (!isZero(rec.tf.vel)) this.#moving.add(rec);
      k.ports.physics.rowSpawned(rec);
      k.notify('rowSpawned', rec);
    }
    for (const rec of recs) {
      if (rec.phase !== 'alive') continue; // a rowSpawned subscriber destroyed it
      if (rec.behaviors.every((inst) => !inst.pendingModule)) this.#queueSpawn(rec);
      else this.#bindLate(rec);
    }
    return id;
  }

  /** `<parent>/<n>`: n = the parent's child count, bumped past ids already taken */
  #unnamedChild(parentId: RowId): RowId {
    const store = this.#k.store;
    let n = store.childrenOf(parentId).length;
    let id = childId(parentId, n);
    while (store.has(id)) id = childId(parentId, ++n);
    return id;
  }

  #bindEnv(): BindEnv {
    const f = this.#ctxFactory;
    return {
      listeners: this.#k.time.listeners,
      ...(f ? { ctxFor: f } : {}),
      ...(this.#k.dev ? { report: (m: string) => this.warnOnce(m) } : {}),
    };
  }

  #queueSpawn(rec: RowRec): void {
    if (this.#queued.has(rec)) return;
    this.#queued.add(rec);
    this.#spawnQueue.push(rec);
  }

  /** core §12.4: an instance whose module is not loaded binds when it arrives; onSpawn waits for every instance of the row */
  #bindLate(rec: RowRec): void {
    const reg = this.#k.registry;
    for (const inst of rec.behaviors) {
      if (!inst.pendingModule) continue;
      const settle = (ns: Record<string, unknown> | null, err: unknown): void => {
        if (rec.phase !== 'alive' || !inst.pendingModule) return;
        if (ns !== null) {
          try {
            completeBind(rec, inst, asBehaviorModule(ns, inst.path), this.#bindEnv());
          } catch (e) {
            err = e;
          }
        }
        if (inst.pendingModule) {
          // the module failed to load: the instance stays without a module (no hooks), the row goes on
          inst.pendingModule = false;
          this.warnOnce(`late bind of ${inst.path} for ${rec.id} failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (rec.pendingSpawnHooks && rec.behaviors.every((b) => !b.pendingModule)) this.#queueSpawn(rec);
      };
      reg.load(inst.path).then(
        (ns) => settle(ns, null),
        (e: unknown) => settle(null, e),
      );
    }
  }

  // ── destroy ────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** `ctx.destroy(id?, {force?})` for `caller`: no id = the caller's own row; `force` is accepted and ignored */
  destroy(caller: CallerRef, ids?: DestroyTarget | readonly DestroyTarget[], _opts?: { force?: boolean }): void {
    if (ids === undefined || ids === null) {
      if (caller.kind === 'row') this.destroyOne(caller.row.id, this.#howOf(caller));
      else this.warnOnce(`destroy: no target (a ${caller.kind} ctx has no self)`);
      return;
    }
    const list = Array.isArray(ids) ? (ids as readonly DestroyTarget[]) : [ids as DestroyTarget];
    let how: DestroyHow | null = null;
    for (const t of list) {
      const id = typeof t === 'string' ? t : t !== null && typeof t === 'object' && typeof t.id === 'string' ? t.id : null;
      if (id === null) this.warnOnce(`destroy: not an id: ${String(t)}`);
      else this.destroyOne(id, (how ??= this.#howOf(caller)));
    }
  }

  /** the issuer of a ctx.destroy and the cause it records: inside an onOutOfBounds hook the fall is the cause */
  #howOf(caller: CallerRef): DestroyHow {
    const by = caller.kind === 'row' ? caller.behavior.path : caller.kind === 'sim' ? caller.sim.path : caller.kind === 'scene' ? `scene ${caller.place}` : 'kernel';
    const hook = this.#k.time.invoker.currentHook;
    return { cause: hook === 'onOutOfBounds' ? 'onOutOfBounds' : `destroyed by ${by}`, by };
  }

  /**
   * Detaches `id` and its dependants (children, owned rows) at once, post-order; onDestroy at the next boundary. Each detached
   * row is noted in `gone` with `how.cause` (the row itself) or `cascade from <the row it hung on>` (a dependant). A missing id
   * warns once, never throws, and, when it left recently, says how: `destroy: no such object <id> (gone N ticks: <cause>) by
   * <how.by>`.
   */
  destroyOne(id: RowId, how: DestroyHow = ENGINE_HOW): void {
    const k = this.#k;
    if (actIdPrefixOf(id) !== null) {
      k.acts.end(id);
      return;
    }
    const rec = k.store.get(id);
    if (!rec) {
      const g = this.gone.get(id);
      this.warnOnce(g ? `destroy: no such object ${id} (gone ${k.clock.tick - g.tick} ticks: ${g.cause}) by ${how.by}` : `destroy: no such object ${id}`);
      return;
    }
    const cascade = k.rules.spawnerOwnership === 'cascade';
    const order: Array<{ row: RowRec; from: RowRec | null }> = [];
    const seen = new Set<RowRec>();
    const visit = (r: RowRec, from: RowRec | null): void => {
      if (seen.has(r)) return;
      seen.add(r);
      for (const c of [...k.store.childrenOf(r.id)]) visit(c, r);
      if (cascade) {
        for (const oid of [...k.store.ownedBy(r.id)]) {
          const o = k.store.get(oid);
          if (o) visit(o, r);
        }
      }
      order.push({ row: r, from });
    };
    visit(rec, null);
    const tick = k.clock.tick;
    for (const { row: r, from } of order) {
      k.store.detach(r.id);
      this.#moving.delete(r);
      this.#destroyQueue.push({ row: r, hooks: !r.pendingSpawnHooks });
      this.gone.note(r.id, tick, from === null ? how.cause : `cascade from ${from.id}`);
    }
  }

  // ── tick hooks ─────────────────────────────────────────────────────────────────────────────────────────────────────

  /** ◆ (core §9.3): the onSpawn queue in creation order, then the onDestroy queue; returns how many rows were handled */
  flushDeferred(): number {
    const inv = this.#k.time.invoker;
    let n = 0;
    while (this.#spawnQueue.length > 0) {
      const batch = this.#spawnQueue;
      this.#spawnQueue = [];
      for (const row of batch) {
        n++;
        this.#queued.delete(row);
        if (row.phase !== 'alive' || !row.pendingSpawnHooks) continue;
        row.pendingSpawnHooks = false;
        for (const inst of row.behaviors) {
          if (row.phase !== 'alive') break;
          const f = inst.module?.onSpawn;
          if (typeof f === 'function') inv.call({ kind: 'row', row, inst }, 'onSpawn', f, [inst.ctx], inst.module);
        }
      }
    }
    while (this.#destroyQueue.length > 0) {
      const batch = this.#destroyQueue;
      this.#destroyQueue = [];
      for (const item of batch) {
        n++;
        this.#dispose(item.row, item.hooks);
      }
    }
    return n;
  }

  #dispose(row: RowRec, hooks: boolean): void {
    const k = this.#k;
    if (row.phase === 'disposed') return;
    if (hooks) {
      const inv = k.time.invoker;
      for (const inst of row.behaviors) {
        const f = inst.module?.onDestroy;
        if (typeof f === 'function') inv.call({ kind: 'row', row, inst }, 'onDestroy', f, [inst.ctx], inst.module);
      }
    }
    try {
      k.ports.physics.rowDestroyed(row);
    } catch (err) {
      console.error(`[lifecycle] physics.rowDestroyed threw for ${row.id}`, err);
    }
    row.phase = 'disposed';
    if (row.expiresAtTick !== null) this.#lifetimes.noteDisposed(row);
    k.notify('rowDestroyed', row);
  }

  /** tick step G: rows whose lifetime ended, destroyed like ctx.destroy (cascade included, onDestroy runs) */
  expireLifetimes(tick: number): void {
    const heap = this.#lifetimes;
    for (let top = heap.peek(); top !== undefined && top.tick <= tick; top = heap.peek()) {
      heap.pop();
      const row = top.row;
      if (row.phase === 'alive' && row.expiresAtTick === top.tick) this.destroyOne(row.id, LIFETIME_HOW);
    }
  }

  /** tick step E, after the physics steps: body-less velocity integration (core §5.4), then onTriggerEnter */
  afterPhysics(_tick: number): void {
    this.integrateBodyless(1 / ENGINE.TICK_HZ);
    this.dispatchTriggers();
  }

  /** rows with no physics body keep integrating a written velocity: pos += vel·dt, no gravity [engine reference] */
  integrateBodyless(dtS: number): void {
    const k = this.#k;
    for (const row of [...this.#moving]) {
      if (row.phase !== 'alive' || isZero(row.tf.vel)) {
        this.#moving.delete(row);
        continue;
      }
      if (hasBody(row) || isCameraAttached(row)) continue;
      if (row.place !== null && !this.#simulated(row.place)) continue;
      const p = row.tf.pos;
      const v = row.tf.vel;
      k.store.engineWriteTransform(row, { x: p.x + v.x * dtS, y: p.y + v.y * dtS, z: p.z + v.z * dtS }, v, row.tf.grounded);
    }
  }

  /** the physics port's trigger enters since the last step → onTriggerEnter(ctx, other) on the trigger row's behaviours */
  dispatchTriggers(): void {
    const k = this.#k;
    const enters = k.ports.physics.drainTriggerEnters();
    if (enters.length === 0) return;
    const inv = k.time.invoker;
    for (const e of enters) {
      const trigger = k.store.get(e.trigger);
      const other = k.store.get(e.other);
      if (!trigger || !other || !visibleTo(trigger.vm, other)) continue;
      const view = k.store.handle(other, trigger.vm);
      for (const inst of trigger.behaviors) {
        if (trigger.phase !== 'alive') break;
        const f = inst.module?.onTriggerEnter;
        if (typeof f === 'function' && !trigger.pendingSpawnHooks) inv.call({ kind: 'row', row: trigger, inst }, 'onTriggerEnter', f, [inst.ctx, view], inst.module);
      }
    }
  }

  #simulated(place: PlaceId): boolean {
    return placesOf(this.#k)?.isSimulated(place) ?? true;
  }

  // ── the human (core §14 step 10) ───────────────────────────────────────────────────────────────────────────────────

  /** `player/local` from the world config's player template, on the client VM, with its player record; `durableState` merges
   *  over the template's state (plain objects deep, the rest replaces) */
  spawnHuman(a: { place: PlaceId; at?: Vec3; yaw?: number; userId: string; displayName: string; durableState: object }): RowId {
    const k = this.#k;
    let at: Vec3 | undefined = a.at;
    if (at === undefined) at = placesOf(k)?.spawnPoint(a.place);
    const spec: Obj = { template: k.worldConfig.player, place: a.place };
    if (at !== undefined) spec['feetPosition'] = { x: at.x, y: at.y, z: at.z };
    if (a.yaw !== undefined) spec['yaw'] = a.yaw;
    if (isPlain(a.durableState) && Object.keys(a.durableState).length > 0) spec['state'] = a.durableState;
    return this.spawn({ kind: 'kernel' }, this.#k.ids.humanBody, spec, {
      vm: 'client',
      player: { userId: a.userId, displayName: a.displayName, bodyId: this.#k.ids.humanBody, look: [] },
    });
  }
}

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const x of Object.values(v as Obj)) deepFreeze(x);
  }
  return v;
}

// ── the core §5.2 function forms (ctx factories call these) ─────────────────────────────────────────────────────────

type HasLifecycle = { readonly lifecycle: Lifecycle };

export function createLifecycle(k: LifecycleKernel): Lifecycle {
  return new Lifecycle(k);
}

/** `ctx.spawn(idOrSpec, spec?)`; throws SpawnRefused (core §4.5) */
export function spawnRow(k: HasLifecycle, caller: CallerRef, a: string | ObjectSpec, b?: ObjectSpec, extras?: SpawnExtras): RowId {
  return k.lifecycle.spawn(caller, a, b, extras);
}

/** `ctx.destroy(id?, opts?)` (contract §3.6) */
export function destroyRows(k: HasLifecycle, caller: CallerRef, ids: DestroyTarget | readonly DestroyTarget[], opts?: { force?: boolean }): void {
  k.lifecycle.destroy(caller, ids, opts);
}

/** tick step G */
export function expireLifetimes(k: HasLifecycle & { readonly clock: { readonly tick: number } }): void {
  k.lifecycle.expireLifetimes(k.clock.tick);
}

/** a phase boundary's deferred hooks */
export function flushDeferred(k: HasLifecycle): number {
  return k.lifecycle.flushDeferred();
}
