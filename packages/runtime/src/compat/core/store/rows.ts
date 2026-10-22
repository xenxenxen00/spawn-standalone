// The row store (docs/design/core-runtime.md §3.2, §5.1, §5.3, §5.4): the records of every alive row and their indexes (id,
// place, tag per place, VM, children, spawner edges), the per-place spatial grids, the tick's change list, the write observers,
// the invoker of the running hook, the property channels, the handle cache and the physics writeback.
//
// - Iteration is in spawn serial order everywhere (deterministic; Spawn's own order is unspecified and callers sort themselves).
//   `byPlace` / `byTag` / `inVm` return live sets: snapshot them before spawning or moving rows while iterating.
// - Mutation of the indexes is lifecycle.ts's (WP C1b: `insert`, `detach`) and places' (WP C4: `movePlace`); everything else
//   writes through the handles (handles.ts) or the physics writeback (`engineWriteTransform`).
// - `detach` frees the id at once (core §5.2); the caller detaches a row's dependants first (post-order cascade), so no alive row
//   ever points at a reused parent id.
// - The change list (`takeChanges`) holds every effective script write since the last take; the scheduler drains it at tick step
//   H (WP C2). Engine writebacks are not in it (core §5.4). `observe` subscribers hear each write as it happens (the sleep waker).
// - `beginTick` (tick step A) rolls `prevPos`/`prevRot` of the rows that moved during the previous tick: render interpolates
//   `prev → cur` (RowSnapshot, X-14); a row that did not move has prev = cur.
import type { KernelPorts } from '../ports.ts';
import { createNullPorts } from '../null-ports.ts';
import type {
  BehaviorInstance,
  ChangeRecord,
  Invoker,
  ObjectSpec,
  ObjectView,
  PathSegment,
  PlaceId,
  PlayerRec,
  Quat,
  RigRec,
  RowId,
  RowRec,
  RowStore,
  TemplateRef,
  Vec3,
  VmId,
} from '../types.ts';
import { localSegment } from '../ids.ts';
import { ChannelRegistry } from './channels.ts';
import { handleFor, rowOf } from './handles.ts';
import { fieldRoot, RIG_FIELDS, type Realm, type StoreCore, type StoreCounters } from './proxies.ts';
import { SpatialGridImpl } from './spatial.ts';
import {
  chainPose,
  composePose,
  copyVec3,
  createTransformRec,
  isCameraAttached,
  localPose,
  quatNormalize,
  rotationOf,
  scaleValue,
  setRotation,
  type Pose,
  type TransformInit,
} from './transform.ts';

// ── records ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** what lifecycle.ts knows when it creates a record (core §4.1); everything else takes the defaults of a fresh alive row */
export interface RowInit {
  id: RowId;
  serial: number;
  vm: VmId;
  place: PlaceId | null;
  explicitPlace?: boolean;
  parentId?: RowId | null;
  spawnerId?: RowId | null;
  /** default: the local id segment of a child, else null */
  name?: string | null;
  tags?: readonly string[];
  template?: TemplateRef | null;
  spec?: Readonly<ObjectSpec>;
  /** taken as given: a wire copy (cloneWire) the store may edit in place, never a frozen or shared object (the handle proxies
   *  edit it, and a Proxy over a frozen nested object throws on read) */
  state?: Record<string, unknown>;
  /** taken as given, like `state`. ObjectProperties fields only: `feetPosition`, `rotation`, `yaw`, `scale` go to `transform`
   *  (transformFromSpec), except the camera form, which is `props.feetPosition` (SpecTransform.camera) */
  props?: Record<string, unknown>;
  transform?: TransformInit;
  behaviors?: BehaviorInstance[];
  /** default 'near' (contract §26) */
  audience?: 'near' | 'all' | 'local';
  /** default 'world' [INF: no live code reads it] */
  scope?: 'session' | 'world';
  visibility?: 'owner' | 'platform' | null;
  simulatedBy?: 'platform' | null;
  lifetimeS?: number | null;
  expiresAtTick?: number | null;
  /** the human body: `{ userId, displayName, bodyId, look: [] }`. Set it here: a handle created before decides its class
   *  (PlayerView) once */
  player?: PlayerRec | null;
  /** the camera rig: `{ targetId, layer: new LayeredValueImpl(() => cameraDef) }`; like `player`, set at creation */
  rig?: RigRec | null;
  fromScene?: { place: PlaceId; cell: string } | null;
}

const EMPTY_SPEC: Readonly<ObjectSpec> = Object.freeze({});

export function createRowRec(init: RowInit): RowRec {
  const parentId = init.parentId ?? null;
  return {
    id: init.id,
    serial: init.serial,
    vm: init.vm,
    place: init.place,
    explicitPlace: init.explicitPlace ?? false,
    parentId,
    spawnerId: init.spawnerId ?? null,
    name: init.name !== undefined ? init.name : parentId !== null ? localSegment(init.id) : null,
    tags: Object.freeze([...(init.tags ?? [])]),
    template: init.template ?? null,
    spec: init.spec ?? EMPTY_SPEC,
    state: init.state ?? {},
    props: init.props ?? {},
    tf: createTransformRec(init.transform),
    behaviors: init.behaviors ?? [],
    audience: init.audience ?? 'near',
    scope: init.scope ?? 'world',
    visibility: init.visibility ?? null,
    simulatedBy: init.simulatedBy ?? null,
    lifetimeS: init.lifetimeS ?? null,
    expiresAtTick: init.expiresAtTick ?? null,
    phase: 'alive',
    pendingSpawnHooks: true,
    player: init.player ?? null,
    spectating: false,
    rig: init.rig ?? null,
    fromScene: init.fromScene ?? null,
    stateVer: 0,
    propVer: 0,
    handles: {},
  };
}

/** a field's current value as channels see it at a flush (a copy for transform fields) */
export function readField(row: RowRec, field: string): unknown {
  switch (field) {
    case 'state':
      return row.state;
    case 'feetPosition':
      return isCameraAttached(row) ? row.props.feetPosition : copyVec3(row.tf.pos);
    case 'rotation':
      return rotationOf(row.tf);
    case 'scale':
      return scaleValue(row.tf.scale);
    case 'velocity':
      return copyVec3(row.tf.vel);
    case 'angularVelocity':
      return copyVec3(row.tf.angVel);
    case 'spectating':
      return row.spectating;
    case 'parent':
      return row.parentId;
    default:
      if (row.rig !== null && RIG_FIELDS.includes(field)) return row.rig.layer.read()[field];
      return fieldRoot(row, field);
  }
}

// ── serial-ordered sets ──────────────────────────────────────────────────────────────────────────────────────────────

const bySerial = (a: RowRec, b: RowRec): number => a.serial - b.serial;
const NO_ROWS: ReadonlySet<RowRec> = new Set();
const NO_IDS: ReadonlySet<RowId> = new Set();
const NO_CHILDREN: readonly RowRec[] = Object.freeze([]);

/**
 * A Set kept in serial order: appends are cheap; an out-of-order add (a row moved in from another place) re-sorts lazily into a
 * NEW Set, so an iteration already walking the old one is not disturbed (clearing and refilling a Set mid-iteration makes the
 * iterator visit rows twice). A caller must not keep a returned set across mutations.
 */
class SerialSet {
  #items = new Set<RowRec>();
  #last = Number.NEGATIVE_INFINITY;
  #dirty = false;

  add(r: RowRec): void {
    if (this.#items.has(r)) return;
    if (r.serial < this.#last) this.#dirty = true;
    else this.#last = r.serial;
    this.#items.add(r);
  }

  delete(r: RowRec): void {
    this.#items.delete(r);
  }

  view(): ReadonlySet<RowRec> {
    if (this.#dirty) {
      const sorted = [...this.#items].sort(bySerial);
      this.#items = new Set(sorted);
      this.#dirty = false;
      this.#last = sorted.length > 0 ? sorted[sorted.length - 1]!.serial : Number.NEGATIVE_INFINITY;
    }
    return this.#items;
  }
}

// ── the store ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface RowStoreOptions {
  worldId?: string | null | undefined;
  /** the kernel's port table, read at call time (the app swaps the scene port when the renderer attaches); default null ports */
  ports?: KernelPorts | undefined;
  /** dev builds: logging handle proxies, warnings, the "state write lost" detector (core §5.3) */
  dev?: boolean | undefined;
  /** ext.rowSession: every row handle carries a `session` scratch bag (default off, the base runtime) */
  rowSession?: boolean | undefined;
  /** where dev warnings go (default console.warn); each distinct message once */
  warn?: ((message: string) => void) | undefined;
  /** a write through a handle of another VM than the row's (core §10.4: counted per VM by vm/machine.ts, WP C5) */
  onCrossVmWrite?: ((writer: VmId, row: RowRec, field: string) => void) | undefined;
}

export type { StoreCounters } from './proxies.ts';

/** dev bookkeeping bounds: distinct warnings remembered, assignments watched per tick */
const WARNED_MAX = 4096;
const WATCH_MAX = 10_000;

const scriptOf = (inv: Invoker): string => (typeof inv === 'string' ? inv : 'row' in inv ? inv.behavior : inv.sim);

export class RowStoreImpl implements RowStore, StoreCore {
  readonly worldId: string | null;
  readonly ports: KernelPorts;
  readonly dev: boolean;
  readonly rowSession: boolean;
  readonly channels: ChannelRegistry;
  readonly counters: StoreCounters = {
    writes: 0,
    equalWrites: 0,
    deadWrites: 0,
    readonlyWrites: 0,
    ignoredWrites: 0,
    unknownFieldWrites: 0,
    crossVmWrites: 0,
    invalidWrites: 0,
    detachedWrites: 0,
    observerErrors: 0,
    lostWrites: 0,
  };

  readonly #warnSink: (message: string) => void;
  readonly #warned = new Set<string>();
  #onCrossVmWrite: ((writer: VmId, row: RowRec, field: string) => void) | undefined;

  readonly #byId = new Map<RowId, RowRec>();
  readonly #byPlace = new Map<PlaceId, SerialSet>();
  readonly #byTag = new Map<PlaceId, Map<string, SerialSet>>();
  readonly #byVm: Record<VmId, SerialSet> = { platform: new SerialSet(), client: new SerialSet() };
  readonly #children = new Map<RowId, readonly RowRec[]>();
  readonly #owned = new Map<RowId, Set<RowId>>();
  readonly #grids = new Map<PlaceId, SpatialGridImpl>();
  readonly #gridOf = new Map<RowRec, SpatialGridImpl>();
  readonly #moved = new Set<RowRec>();
  /** rows with no presented previous pose yet (spawned, or switched between world and camera space, since the last beginTick):
   *  their transform writes move prev with cur */
  readonly #fresh = new Set<RowRec>();
  #serial = 0;
  /** bumped by every insert and detach: the only places the `inVm` sets change (a row's vm is fixed at its spawn) */
  #membership = 0;
  #changes: ChangeRecord[] = [];
  #observers: ReadonlyArray<{ readonly fn: (c: ChangeRecord) => void }> = [];
  /** set by runAs; wins over the source */
  #override: Invoker | null = null;
  #invokerSource: (() => Invoker) | null = null;
  readonly #watch = new Map<string, { row: RowRec; field: string; path: readonly PathSegment[]; source: object; json: string }>();

  constructor(opts: RowStoreOptions = {}) {
    this.worldId = opts.worldId ?? null;
    this.ports = opts.ports ?? createNullPorts();
    this.dev = opts.dev === true;
    this.rowSession = opts.rowSession === true;
    this.#warnSink = opts.warn ?? ((m) => console.warn(`[store] ${m}`));
    this.#onCrossVmWrite = opts.onCrossVmWrite;
    this.channels = new ChannelRegistry(readField);
  }

  // ── reads ──────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** alive rows only */
  get(id: RowId): RowRec | undefined {
    return this.#byId.get(id);
  }

  has(id: RowId): boolean {
    return this.#byId.has(id);
  }

  get count(): number {
    return this.#byId.size;
  }

  /** every alive row, in insertion order */
  rows(): IterableIterator<RowRec> {
    return this.#byId.values();
  }

  byPlace(place: PlaceId): ReadonlySet<RowRec> {
    return this.#byPlace.get(place)?.view() ?? NO_ROWS;
  }

  byTag(place: PlaceId, tag: string): ReadonlySet<RowRec> {
    return this.#byTag.get(place)?.get(tag)?.view() ?? NO_ROWS;
  }

  childrenOf(id: RowId): readonly RowRec[] {
    return this.#children.get(id) ?? NO_CHILDREN;
  }

  ownedBy(spawnerId: RowId): ReadonlySet<RowId> {
    return this.#owned.get(spawnerId) ?? NO_IDS;
  }

  inVm(vm: VmId): Iterable<RowRec> {
    return this.#byVm[vm].view();
  }

  /** a generation of the row set: it changes whenever a row is inserted or detached, so `inVm` is unchanged while it is */
  get membership(): number {
    return this.#membership;
  }

  spatial(place: PlaceId): SpatialGridImpl {
    let g = this.#grids.get(place);
    if (!g) {
      g = new SpatialGridImpl();
      this.#grids.set(place, g);
    }
    return g;
  }

  /** the rows whose own transform changed since the last beginTick */
  movedRows(): ReadonlySet<RowRec> {
    return this.#moved;
  }

  // ── handles ────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** the cached handle of a row for a VM or the UI realm (core §3.3) */
  handle(row: RowRec, realm: Realm): ObjectView {
    return handleFor(this, row, realm);
  }

  /** the record behind a handle of this store (alive or not), else null (`ctx.cross(view)`, `query` results) */
  rowOf(handle: unknown): RowRec | null {
    return rowOf(handle, this);
  }

  // ── mutation (lifecycle.ts, places) ────────────────────────────────────────────────────────────────────────────────

  /** the next spawn serial (monotonic); minted ids are `o<serial>` (ids.ts) */
  allocSerial(): number {
    return ++this.#serial;
  }

  insert(rec: RowRec): void {
    if (this.#byId.has(rec.id)) throw new Error(`RowStore.insert: duplicate id ${rec.id}`);
    rec.phase = 'alive';
    this.#byId.set(rec.id, rec);
    this.#membership++;
    this.#byVm[rec.vm].add(rec);
    if (rec.place !== null) this.#indexPlace(rec, rec.place);
    if (rec.parentId !== null) this.#addChild(rec.parentId, rec);
    if (rec.spawnerId !== null) {
      let set = this.#owned.get(rec.spawnerId);
      if (!set) {
        set = new Set();
        this.#owned.set(rec.spawnerId, set);
      }
      set.add(rec.id);
    }
    this.#fresh.add(rec);
    this.#rebucketTree(rec);
  }

  /** removes the row from every index and marks it dead; its id is free at once. Returns the record, or undefined. */
  detach(id: RowId): RowRec | undefined {
    const rec = this.#byId.get(id);
    if (!rec) return undefined;
    this.#byId.delete(id);
    this.#membership++;
    this.#byVm[rec.vm].delete(rec);
    if (rec.place !== null) this.#unindexPlace(rec, rec.place);
    if (rec.parentId !== null) this.#removeChild(rec.parentId, rec);
    if (rec.spawnerId !== null) {
      const set = this.#owned.get(rec.spawnerId);
      if (set) {
        set.delete(id);
        if (set.size === 0) this.#owned.delete(rec.spawnerId);
      }
    }
    // the id may be reused: a new row with it starts with no children and owns nothing
    this.#children.delete(id);
    this.#owned.delete(id);
    this.#unbucket(rec);
    this.#moved.delete(rec);
    this.#fresh.delete(rec);
    this.channels.discard(rec);
    rec.phase = 'dead';
    return rec;
  }

  /** moves a row and its subtree (children always share their parent's place, core §4.6) to another place */
  movePlace(rec: RowRec, place: PlaceId): void {
    if (this.#byId.get(rec.id) !== rec) return;
    const visit = (r: RowRec): void => {
      if (r.place !== place) {
        if (r.place !== null) this.#unindexPlace(r, r.place);
        r.place = place;
        this.#indexPlace(r, place);
      }
      for (const k of this.#children.get(r.id) ?? NO_CHILDREN) visit(k);
    };
    visit(rec);
    this.#rebucketTree(rec);
  }

  /** the row's transform changed: re-bucket it and its subtree, and roll its prev transform at the next beginTick (at once
   *  for a row that has no presented pose yet) */
  moved(rec: RowRec): void {
    if (this.#byId.get(rec.id) !== rec) return;
    this.#moved.add(rec);
    if (this.#fresh.has(rec)) {
      rec.tf.prevPos = rec.tf.pos;
      rec.tf.prevRot = rec.tf.rot;
    }
    this.#rebucketTree(rec);
  }

  /** prev ← cur now and for every transform write until the next beginTick: nothing to interpolate from (a switch between
   *  world and camera space) */
  restartInterpolation(rec: RowRec): void {
    if (this.#byId.get(rec.id) !== rec) return;
    rec.tf.prevPos = rec.tf.pos;
    rec.tf.prevRot = rec.tf.rot;
    this.#fresh.add(rec);
  }

  /** re-parents a record in the indexes (transform.ts `reparent` keeps the world pose); the row follows its parent's place */
  setParent(rec: RowRec, parentId: RowId | null): void {
    if (rec.parentId !== null) this.#removeChild(rec.parentId, rec);
    rec.parentId = parentId;
    if (parentId !== null) {
      this.#addChild(parentId, rec);
      const p = this.#byId.get(parentId);
      if (p && p.place !== null && p.place !== rec.place) this.movePlace(rec, p.place);
    }
    this.#rebucketTree(rec);
  }

  /**
   * The physics writeback (core §5.4, motion §5.3): pos, vel, grounded (and rot / angVel for dynamic bodies) of a body after a
   * step. Invoker 'engine': no wake, no change record, no version bump; the spatial grid and the moved set follow.
   */
  engineWriteTransform(row: RowRec, pos: Vec3, vel: Vec3, grounded: boolean, rot?: Quat, angVel?: Vec3): void {
    if (row.phase !== 'alive') return;
    const tf = row.tf;
    tf.pos = copyVec3(pos);
    tf.vel = copyVec3(vel);
    tf.grounded = grounded;
    if (rot !== undefined) setRotation(tf, quatNormalize(rot), null);
    if (angVel !== undefined) tf.angVel = copyVec3(angVel);
    this.moved(row);
  }

  /** tick step A: prev ← cur for the rows that moved since the last call */
  beginTick(): void {
    for (const r of this.#moved) {
      r.tf.prevPos = r.tf.pos;
      r.tf.prevRot = r.tf.rot;
    }
    this.#moved.clear();
    this.#fresh.clear();
  }

  // ── writes: invoker, change list, observers ────────────────────────────────────────────────────────────────────────

  /** who is writing (core §5.3; decides sleep wakes): a runAs override, else the invoker source (the kernel points it at
   *  WP C2's HookInvoker.current), else 'engine' */
  get invoker(): Invoker {
    return this.#override ?? (this.#invokerSource !== null ? this.#invokerSource() : 'engine');
  }

  /** where the store reads the writer of a write outside runAs (null: always 'engine') */
  setInvokerSource(source: (() => Invoker) | null): void {
    this.#invokerSource = source;
  }

  /** runs `fn` with `invoker` as the writer of every write it makes (nests; restored after a throw) */
  runAs<T>(invoker: Invoker, fn: () => T): T {
    const prev = this.#override;
    this.#override = invoker;
    try {
      return fn();
    } finally {
      this.#override = prev;
    }
  }

  /** the effective writes since the last call, in write order */
  takeChanges(): ChangeRecord[] {
    const out = this.#changes;
    this.#changes = [];
    return out;
  }

  /** hears every effective write synchronously, after the store changed; returns an unsubscribe */
  observe(fn: (c: ChangeRecord) => void): () => void {
    const sub = { fn };
    this.#observers = [...this.#observers, sub];
    return () => {
      this.#observers = this.#observers.filter((s) => s !== sub);
    };
  }

  /** @internal proxies.ts / transform.ts: one effective write */
  recordChange(row: RowRec, field: string, path: readonly PathSegment[]): void {
    const c: ChangeRecord = Object.freeze({ row, field, path: Object.freeze(path.slice()), invoker: this.invoker });
    this.#changes.push(c);
    for (const s of this.#observers) {
      try {
        s.fn(c);
      } catch (err) {
        this.counters.observerErrors++;
        console.error('[store] a write observer threw', err);
      }
    }
  }

  // ── dev reports and counted refusals ───────────────────────────────────────────────────────────────────────────────

  /** a dev warning, each distinct message once (no-op outside dev builds) */
  warn(message: string): void {
    if (!this.dev || this.#warned.has(message)) return;
    if (this.#warned.size >= WARNED_MAX) this.#warned.clear();
    this.#warned.add(message);
    this.#warnSink(message);
  }

  /** @internal */
  deadWrite(row: RowRec, field: string): false {
    this.counters.deadWrites++;
    this.warn(`write to dead row ${row.id}.${field}`);
    return false;
  }

  /** @internal */
  readonlyWrite(row: RowRec, field: string): void {
    this.counters.readonlyWrites++;
    this.warn(`write through a read-only UI handle ${row.id}.${field} ignored`);
  }

  /** @internal */
  ignoredWrite(row: RowRec, field: string): void {
    this.counters.ignoredWrites++;
    this.warn(field === 'place' ? `write to ${row.id}.place ignored (use ctx.cross)` : `write to read-only field ${row.id}.${field} ignored`);
  }

  /** @internal */
  detachedWrite(row: RowRec, field: string): void {
    this.counters.detachedWrites++;
    this.warn(`write through a stale reference into ${row.id}.${field} (the value was replaced) ignored`);
  }

  /** @internal */
  crossVmWrite(writer: VmId, row: RowRec, field: string): void {
    this.counters.crossVmWrites++;
    this.#onCrossVmWrite?.(writer, row, field);
  }

  /** where a write through another VM's handle is reported (vm/machine.ts counts them per VM, WP C5); replaces the option */
  setCrossVmWriteHook(hook: ((writer: VmId, row: RowRec, field: string) => void) | undefined): void {
    this.#onCrossVmWrite = hook;
  }

  /** @internal dev builds: a write of a field no handle has; reported once per (script, field) */
  unknownFieldWrite(row: RowRec, field: string): void {
    this.counters.unknownFieldWrites++;
    const script = scriptOf(this.invoker);
    const key = `${script}\u0000${field}`;
    if (this.#warned.has(key)) return;
    this.#warned.add(key);
    this.warn(`unknown handle field write ${row.id}.${field} (${script})`);
  }

  /** @internal dev builds: remember an assigned object and its JSON until checkLostWrites (the last assignment per path wins:
   *  an earlier one was overwritten in the store anyway) */
  watchAssignment(row: RowRec, field: string, path: readonly PathSegment[], source: object): void {
    if (!this.dev) return;
    const key = `${row.serial}\u0000${field}\u0000${path.join('\u0001')}`;
    if (!this.#watch.has(key) && this.#watch.size >= WATCH_MAX) return;
    let json: string | undefined;
    try {
      json = JSON.stringify(source);
    } catch {
      return;
    }
    // re-insert so iteration stays in last-write order
    this.#watch.delete(key);
    if (json !== undefined) this.#watch.set(key, { row, field, path: path.slice(), source, json });
  }

  /**
   * Dev builds, at tick end (core §5.3): warns `state write lost: <row>.<key> was mutated after assignment` for each path whose
   * last assigned object (since the last call) changed afterwards: the store kept the copy, the game kept mutating the original.
   * Rows that died meanwhile are not judged. Returns how many were lost.
   */
  checkLostWrites(): number {
    let lost = 0;
    for (const w of this.#watch.values()) {
      if (w.row.phase !== 'alive') continue;
      let now: string | undefined;
      try {
        now = JSON.stringify(w.source);
      } catch {
        now = undefined;
      }
      if (now === w.json) continue;
      lost++;
      this.counters.lostWrites++;
      const segs = w.field === 'state' ? w.path : [w.field, ...w.path];
      this.warn(`state write lost: ${w.row.id}.${segs.length > 0 ? segs.join('.') : 'state'} was mutated after assignment`);
    }
    this.#watch.clear();
    return lost;
  }

  // ── index internals ────────────────────────────────────────────────────────────────────────────────────────────────

  #indexPlace(rec: RowRec, place: PlaceId): void {
    let set = this.#byPlace.get(place);
    if (!set) {
      set = new SerialSet();
      this.#byPlace.set(place, set);
    }
    set.add(rec);
    if (rec.tags.length === 0) return;
    let tags = this.#byTag.get(place);
    if (!tags) {
      tags = new Map();
      this.#byTag.set(place, tags);
    }
    for (const t of rec.tags) {
      let ts = tags.get(t);
      if (!ts) {
        ts = new SerialSet();
        tags.set(t, ts);
      }
      ts.add(rec);
    }
  }

  #unindexPlace(rec: RowRec, place: PlaceId): void {
    this.#byPlace.get(place)?.delete(rec);
    const tags = this.#byTag.get(place);
    if (tags) for (const t of rec.tags) tags.get(t)?.delete(rec);
  }

  // children lists are copy-on-write: a cascade may detach children while it walks childrenOf(parent)
  #addChild(parentId: RowId, rec: RowRec): void {
    const list = this.#children.get(parentId) ?? NO_CHILDREN;
    // serial order: an append unless a row is re-parented under a newer parent
    let i = list.length;
    while (i > 0 && list[i - 1]!.serial > rec.serial) i--;
    this.#children.set(parentId, [...list.slice(0, i), rec, ...list.slice(i)]);
  }

  #removeChild(parentId: RowId, rec: RowRec): void {
    const list = this.#children.get(parentId);
    if (!list) return;
    const next = list.filter((r) => r !== rec);
    if (next.length === 0) this.#children.delete(parentId);
    else this.#children.set(parentId, next);
  }

  #unbucket(rec: RowRec): void {
    const g = this.#gridOf.get(rec);
    if (!g) return;
    g.remove(rec);
    this.#gridOf.delete(rec);
  }

  /** buckets a row and its subtree by world feet along the plain parent chain; camera-attached subtrees leave the grids */
  #rebucketTree(rec: RowRec): void {
    let underCamera = false;
    for (let p = rec.parentId !== null ? this.#byId.get(rec.parentId) : undefined, d = 0; p && d < 64; d++) {
      if (isCameraAttached(p)) {
        underCamera = true;
        break;
      }
      p = p.parentId !== null ? this.#byId.get(p.parentId) : undefined;
    }
    const parent = rec.parentId !== null ? this.#byId.get(rec.parentId) : undefined;
    const parentPose = parent && !underCamera ? chainPose((id) => this.#byId.get(id), parent) : null;
    this.#bucketWalk(rec, parentPose, underCamera, 0);
  }

  #bucketWalk(rec: RowRec, parentPose: Pose | null, underCamera: boolean, depth: number): void {
    const camera = underCamera || isCameraAttached(rec);
    if (camera) {
      this.#unbucket(rec);
      if (depth >= 64) return;
      for (const k of this.#children.get(rec.id) ?? NO_CHILDREN) this.#bucketWalk(k, null, true, depth + 1);
      return;
    }
    // the composed pose is only needed to place children: a childless top-level row buckets by its own feet, with no
    // intermediate pose object (this is the per-physics-writeback hot path)
    const kids = depth < 64 ? this.#children.get(rec.id) : undefined;
    let pose: Pose | null = null;
    if (parentPose !== null) pose = composePose(parentPose, localPose(rec));
    else if (kids !== undefined && kids.length > 0) pose = localPose(rec);
    const feet = pose !== null ? pose.pos : rec.tf.pos;
    if (rec.place === null) this.#unbucket(rec);
    else {
      const g = this.spatial(rec.place);
      const old = this.#gridOf.get(rec);
      if (old && old !== g) old.remove(rec);
      g.set(rec, feet.x, feet.z);
      if (g.has(rec)) this.#gridOf.set(rec, g);
      else this.#gridOf.delete(rec);
    }
    if (kids !== undefined) for (const k of kids) this.#bucketWalk(k, pose, camera, depth + 1);
  }
}
