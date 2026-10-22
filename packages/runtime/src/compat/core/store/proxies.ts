// Write semantics (docs/design/core-runtime.md §5.3, D-CORE-02; contract §3.5): the write-through proxies of `state` and of
// object-valued properties, and the one write path every handle setter and proxy trap goes through.
//
// A write (`writeProp`) stores a wire copy of the value (JSON semantics: functions and undefined dropped, NaN/Infinity → null,
// Dates → strings); assigning undefined clears the key (an array slot becomes null). An equal write (deepEqualWire, key order
// counts) is free: no version bump, no change record, no notification, except for fields whose channel asks for every write
// (X-13). An effective write bumps `stateVer` / `propVer`, appends (row, field, path, invoker) to the store's change list
// (consumed by the RowFeed, the UI dirty flag, the durable save and the sleep waker), runs the store's observers and the field's
// channels, and calls the physics port for `physics` and `forces` (core §5.6, §15.1).
//
// Reads of nested objects return proxies over the store's own data (no copies): a proxy is cached per target object, so
// `a.state.live === a.state.live`; its traps send writes and deletes back through `writeProp` with the full path. A proxy whose
// object has since been replaced (a stale reference kept across `state.live = {...}`) writes nothing to the row. Reads of a field
// whose channel serves reads are that channel's fresh snapshots, and the keys of `anim`, `mixer`, `ik` read as fresh copies even
// without one (X-13): mutating one writes nothing (AGENTS.md:139).
// The UI realm's proxies are read-only (core §3.3, §7.5): writes are ignored and counted.
//
// proxies.ts, transform.ts and handles.ts reach the store only through `StoreCore` (implemented by RowStoreImpl): none of
// them imports rows.ts, so the store modules form no import cycle.
import type { KernelPorts } from '../ports.ts';
import type { PathSegment, RowId, RowRec, VmId } from '../types.ts';
import { cloneWire, deepEqualWire, getPath, isPlainObject, setPath } from '../wire.ts';
import type { ChannelRegistry } from './channels.ts';

/** a handle's realm: a VM, or the read-only UI page */
export type Realm = VmId | 'ui';
/** the realm a write came through; undefined for the kernel's own writes (no cross-VM count) */
export type WriteRealm = Realm | undefined;

export interface StoreCounters {
  /** effective writes */
  writes: number;
  /** writes equal to the stored value (free, core §5.3) */
  equalWrites: number;
  /** writes to a detached row (ignored) */
  deadWrites: number;
  /** writes through the read-only UI realm (ignored) */
  readonlyWrites: number;
  /** writes to read-only handle fields: id, tags, place, worldFeetPosition, … (ignored) */
  ignoredWrites: number;
  /** dev builds: writes of a field no handle has (they set nothing in the engine) */
  unknownFieldWrites: number;
  crossVmWrites: number;
  /** values that are no form of the field (a NaN position, a string rotation): refused */
  invalidWrites: number;
  /** writes through a stale nested reference to a value that was replaced since */
  detachedWrites: number;
  observerErrors: number;
  /** dev builds: assigned objects mutated after the assignment (core §5.3) */
  lostWrites: number;
}

/** what the write path, the transforms and the handles use of the row store (RowStoreImpl, rows.ts) */
export interface StoreCore {
  readonly worldId?: string | null;
  readonly ports: KernelPorts;
  readonly dev: boolean;
  /** ext.rowSession: row handles carry a `session` scratch bag (absent: off) */
  readonly rowSession?: boolean;
  readonly channels: ChannelRegistry;
  readonly counters: StoreCounters;
  get(id: RowId): RowRec | undefined;
  childrenOf(id: RowId): readonly RowRec[];
  /** the row's transform changed: spatial grid and the tick's moved set */
  moved(rec: RowRec): void;
  /** prev ← cur until the next tick: nothing to interpolate from */
  restartInterpolation(rec: RowRec): void;
  setParent(rec: RowRec, parentId: RowId | null): void;
  /** one effective write: change list + observers */
  recordChange(row: RowRec, field: string, path: readonly PathSegment[]): void;
  warn(message: string): void;
  deadWrite(row: RowRec, field: string): false;
  readonlyWrite(row: RowRec, field: string): void;
  ignoredWrite(row: RowRec, field: string): void;
  detachedWrite(row: RowRec, field: string): void;
  crossVmWrite(writer: VmId, row: RowRec, field: string): void;
  unknownFieldWrite(row: RowRec, field: string): void;
  watchAssignment(row: RowRec, field: string, path: readonly PathSegment[], source: object): void;
}

/** ObjectProperties fields served by generated handle accessors (api ObjectPropertiesSpec, contract §9; plus `anim`, `look`,
 *  `anchor`). Transform fields, `visible`, `forces` and the rig fields have their own accessors. */
export const PROP_FIELDS: readonly string[] = Object.freeze([
  'visibleInFirstPerson',
  'castShadow',
  'receiveShadow',
  'primitive',
  'sprite',
  'room',
  'path',
  'layout',
  'material',
  'physics',
  'light',
  'audio',
  'interpolation',
  'pivot',
  'render',
  'visibleRange',
  'visibleTo',
  'vector',
  'jiggle',
  'morph',
  'bones',
  'wisp',
  'boxart',
  'collider2d',
  'ui',
  'press',
  'fx',
  'ik',
  'model',
  'mixer',
  'anim',
  'attachment',
  'spline',
  'scatter',
  'anchor',
  'look',
]);
/** fields that always read as a write-through map, set or not (`ctx.self.anim.walk = …`, `o.forces.surge = …`) */
export const BAG_FIELDS: ReadonlySet<string> = new Set(['anim', 'mixer', 'ik', 'forces']);
/** X-13: the bag fields whose key reads are fresh snapshots even when no channel serves the reads (headless): a nested write
 *  through one (`anim.walk.speed = 0`) writes nothing, as live ("Setting `.speed = 0` on the live channel does nothing",
 *  AGENTS.md:139); only key writes and whole assignments reach the store */
export const SNAPSHOT_FIELDS: ReadonlySet<string> = new Set(['anim', 'mixer', 'ik']);
/** the camera rig's layer fields (core §7.4, contract §11.2) */
export const RIG_FIELDS: readonly string[] = Object.freeze(['fov', 'hideLocalPlayer', 'clip', 'orientation', 'pointerLock', 'sensitivity', 'pixelSnap']);

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const INDEX = /^(?:0|[1-9]\d*)$/;
/** a property key as a path segment: array indices as numbers */
const segOf = (target: object, key: string): PathSegment => (Array.isArray(target) && INDEX.test(key) ? Number(key) : key);

// ── where a field lives ──────────────────────────────────────────────────────────────────────────────────────────────

/** the object holding a field under its own name: `state` is the record's state, a player body's `look` is its PlayerRec's look
 *  stack, every other field is in `props` */
function hostOf(row: RowRec, field: string): Record<string, unknown> {
  if (field === 'state') return row as unknown as Record<string, unknown>;
  if (field === 'look' && row.player !== null) return row.player as unknown as Record<string, unknown>;
  return row.props;
}

/** the stored value of a state / props field (no copy) */
export function fieldRoot(row: RowRec, field: string): unknown {
  return hostOf(row, field)[field];
}

// ── the write path ───────────────────────────────────────────────────────────────────────────────────────────────────

/** the bookkeeping of an effective write: version, counters, cross-VM count, change list + observers, channels */
export function commitWrite(
  store: StoreCore,
  row: RowRec,
  field: string,
  path: readonly PathSegment[],
  value: unknown,
  prev: unknown,
  realm: WriteRealm,
): void {
  if (field === 'state') row.stateVer++;
  else row.propVer++;
  store.counters.writes++;
  if (realm !== undefined && realm !== 'ui' && realm !== row.vm) store.crossVmWrite(realm, row, field);
  store.recordChange(row, field, path);
  store.channels.wrote(row, field, path, value, prev, true);
}

/** an equal write: free, except that channels asking for every write hear it (X-13); returns false (nothing changed) */
export function equalWrite(store: StoreCore, row: RowRec, field: string, path: readonly PathSegment[], value: unknown, prev: unknown): false {
  store.counters.equalWrites++;
  if (store.channels.hasEveryWrite(field)) store.channels.wrote(row, field, path, value, prev, false);
  return false;
}

/** a write whose value is not a valid form of the field (a NaN position, a string rotation): refused and counted */
export function invalidWrite(store: StoreCore, row: RowRec, field: string): false {
  store.counters.invalidWrites++;
  store.warn(`invalid ${field} write on ${row.id} ignored`);
  return false;
}

/** null in every hole of `arr` from index `from` on (the store keeps state wire-clean: JSON has no holes) */
function fillHoles(arr: unknown[], from: number): void {
  for (let i = from; i < arr.length; i++) if (!(i in arr)) arr[i] = null;
}

/** the engine keeps a pushed look's id / look / intensity / priority and drops duration / fade (scripts/fx/surge-logic.js:8-9) */
const LOOK_DROPPED = new Set(['duration', 'fade']);
function lookEntry(v: unknown): unknown {
  if (!isPlainObject(v)) return v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) if (!LOOK_DROPPED.has(k)) out[k] = v[k];
  return out;
}

/**
 * Writes `value` (copied) at `path` below `field` of `row`. [] assigns the whole field (`h.state = {}` wipes; a non-object state
 * is stored as {}); a deeper path creates missing intermediates as plain objects. Returns whether the row changed.
 */
export function writeProp(store: StoreCore, row: RowRec, field: string, path: readonly PathSegment[], value: unknown, realm: WriteRealm): boolean {
  if (row.phase !== 'alive') return store.deadWrite(row, field);
  const host = hostOf(row, field);
  const key = field;
  let v: unknown = cloneWire(value);
  if (field === 'state' && path.length === 0 && !isPlainObject(v)) {
    if (v !== undefined && v !== null) store.warn(`state of ${row.id} assigned a non-object; stored {}`);
    v = {};
  }
  if (field === 'look' && row.player !== null) {
    if (path.length === 0) v = Array.isArray(v) ? v.map(lookEntry) : [];
    else if (path.length === 1) v = lookEntry(v);
    else if (path.length === 2 && LOOK_DROPPED.has(String(path[1]))) return false;
  }
  const root = host[key];
  let parent: unknown = undefined;
  let last = '';
  if (path.length > 0) {
    parent = getPath(root, path.slice(0, -1));
    last = String(path[path.length - 1]);
    // JSON: an undefined array element is null
    if (v === undefined && Array.isArray(parent)) v = null;
  }
  const old = path.length === 0 ? root : isObj(parent) && hasOwn(parent, last) ? parent[last] : undefined;
  if (deepEqualWire(old, v)) return equalWrite(store, row, field, path, v, old);
  store.channels.willWrite(row, field);
  if (path.length === 0) {
    if (v === undefined) delete host[key];
    else host[key] = v;
  } else if (v === undefined) {
    if (isObj(parent)) delete parent[last];
  } else {
    let container: object;
    if (isObj(root)) container = root;
    else {
      container = {};
      host[key] = container;
    }
    const oldLength = Array.isArray(parent) ? parent.length : -1;
    setPath(container, path, v);
    // an index written past the end (or a longer `length`) leaves null in between, as the wire copy would (JSON)
    if (oldLength >= 0) fillHoles(parent as unknown[], oldLength);
  }
  commitWrite(store, row, field, path, v, old, realm);
  sideEffects(store, row, field, path, old);
  if (store.dev && isObj(value)) store.watchAssignment(row, field, path, value);
  return true;
}

/** `delete` of a nested key (core §5.3); a whole field is deleted with path [] (not `state`). Returns whether the row changed. */
export function deleteProp(store: StoreCore, row: RowRec, field: string, path: readonly PathSegment[], realm: WriteRealm): boolean {
  if (row.phase !== 'alive') return store.deadWrite(row, field);
  const host = hostOf(row, field);
  const key = field;
  if (path.length === 0) {
    if (field === 'state' || !hasOwn(host, key)) return false;
    const old = host[key];
    store.channels.willWrite(row, field);
    if (field === 'look' && row.player !== null) host[key] = [];
    else delete host[key];
    commitWrite(store, row, field, path, undefined, old, realm);
    sideEffects(store, row, field, path, old);
    return true;
  }
  const parent = getPath(host[key], path.slice(0, -1));
  const last = String(path[path.length - 1]);
  if (!isObj(parent) || !hasOwn(parent, last)) return false;
  const old = parent[last];
  // a deleted array element is null on the wire (JSON): keep the array dense (Array methods that delete while shifting, such
  // as splice and shift, set the length afterwards, which drops the trailing nulls)
  const element = Array.isArray(parent) && INDEX.test(last);
  if (element && old === null) return false;
  store.channels.willWrite(row, field);
  if (element) parent[last] = null;
  else delete parent[last];
  commitWrite(store, row, field, path, element ? null : undefined, old, realm);
  sideEffects(store, row, field, path, old);
  return true;
}

/** `physics` rebuilds the body; each `forces` key goes to setForce (null = removed) (core §5.6, §15.1) */
function sideEffects(store: StoreCore, row: RowRec, field: string, path: readonly PathSegment[], oldAtPath: unknown): void {
  if (field === 'physics') {
    store.ports.physics.onPhysicsWrite(row, row.props.physics);
    return;
  }
  if (field !== 'forces') return;
  const now = row.props.forces;
  const forceOf = (k: string): unknown => (isObj(now) && hasOwn(now, k) && now[k] !== undefined ? now[k] : null);
  if (path.length > 0) {
    const k = String(path[0]);
    store.ports.physics.setForce(row, k, forceOf(k));
    return;
  }
  const keys = new Set<string>();
  if (isObj(oldAtPath)) for (const k of Object.keys(oldAtPath)) keys.add(k);
  if (isObj(now)) for (const k of Object.keys(now)) keys.add(k);
  for (const k of keys) store.ports.physics.setForce(row, k, forceOf(k));
}

// ── proxies over the store's data ────────────────────────────────────────────────────────────────────────────────────

interface Cached {
  readonly proxy: object;
  readonly node: NodeHandler;
}
/** per store and realm: target object → its proxy (the realm decides cross-VM counting and read-only) */
const NODE_CACHE = new WeakMap<StoreCore, Record<Realm, WeakMap<object, Cached>>>();
const VIEW_CACHE = new WeakMap<StoreCore, Record<Realm, WeakMap<RowRec, Map<string, object>>>>();

function nodeCache(store: StoreCore, realm: Realm): WeakMap<object, Cached> {
  let per = NODE_CACHE.get(store);
  if (!per) {
    per = { platform: new WeakMap(), client: new WeakMap(), ui: new WeakMap() };
    NODE_CACHE.set(store, per);
  }
  return per[realm];
}

/** the handler of one proxied object: knows its row, field and the path from the field to it (refreshed on every read through
 *  its parent, so a moved array element writes to its current index) */
class NodeHandler implements ProxyHandler<object> {
  readonly store: StoreCore;
  readonly row: RowRec;
  readonly field: string;
  readonly realm: Realm;
  /** the (store, realm) node cache: its identity is stable for the store's lifetime, so the handler keeps it instead of
   *  looking it up through NODE_CACHE on every nested read */
  readonly map: WeakMap<object, Cached>;
  parent: NodeHandler | null;
  key: PathSegment | null;

  constructor(store: StoreCore, row: RowRec, field: string, realm: Realm, parent: NodeHandler | null, key: PathSegment | null) {
    this.store = store;
    this.row = row;
    this.field = field;
    this.realm = realm;
    this.map = nodeCache(store, realm);
    this.parent = parent;
    this.key = key;
  }

  path(): PathSegment[] {
    const out: PathSegment[] = [];
    for (let n: NodeHandler | null = this; n !== null && n.key !== null; n = n.parent) out.push(n.key);
    return out.reverse();
  }

  /** the object is still where the path says (not a stale reference to a replaced value) */
  #reachable(target: object, path: readonly PathSegment[]): boolean {
    return getPath(fieldRoot(this.row, this.field), path) === target;
  }

  get(target: object, key: string | symbol, receiver: unknown): unknown {
    // The store only ever proxies wire data (plain objects and arrays, never accessors: writeProp stores a cloneWire copy
    // and initial state is a wire copy), so an own getter whose `this` matters cannot occur below: reading first and only
    // checking own-ness for object values skips a hasOwnProperty call on the overwhelmingly common leaf read.
    if (typeof key === 'symbol') return Reflect.get(target, key, receiver);
    const v = Reflect.get(target, key, receiver);
    if (!isObj(v) || !hasOwn(target, key)) return v;
    return childProxy(this, v, segOf(target, key));
  }

  set(target: object, key: string | symbol, value: unknown): boolean {
    if (typeof key === 'symbol') return true;
    if (this.realm === 'ui') {
      this.store.readonlyWrite(this.row, this.field);
      return true;
    }
    const path = this.path();
    if (!this.#reachable(target, path)) {
      this.store.detachedWrite(this.row, this.field);
      Reflect.set(target, key, cloneWire(value));
      return true;
    }
    path.push(segOf(target, key));
    writeProp(this.store, this.row, this.field, path, value, this.realm);
    return true;
  }

  deleteProperty(target: object, key: string | symbol): boolean {
    if (typeof key === 'symbol') return Reflect.deleteProperty(target, key);
    if (this.realm === 'ui') {
      this.store.readonlyWrite(this.row, this.field);
      return true;
    }
    const path = this.path();
    if (!this.#reachable(target, path)) {
      this.store.detachedWrite(this.row, this.field);
      return Reflect.deleteProperty(target, key);
    }
    path.push(segOf(target, key));
    deleteProp(this.store, this.row, this.field, path, this.realm);
    return true;
  }

  defineProperty(target: object, key: string | symbol, desc: PropertyDescriptor): boolean {
    return 'value' in desc ? this.set(target, key, desc.value) : false;
  }
}

function childProxy(parent: NodeHandler, value: object, key: PathSegment): object {
  const hit = parent.map.get(value);
  if (hit !== undefined && hit.node.row === parent.row && hit.node.field === parent.field) {
    hit.node.parent = parent;
    hit.node.key = key;
    return hit.proxy;
  }
  const node = new NodeHandler(parent.store, parent.row, parent.field, parent.realm, parent, key);
  const proxy = new Proxy(value, node);
  parent.map.set(value, { proxy, node });
  return proxy;
}

function rootProxy(store: StoreCore, row: RowRec, field: string, realm: Realm, value: object): object {
  const cache = nodeCache(store, realm);
  const hit = cache.get(value);
  if (hit !== undefined && hit.node.row === row && hit.node.field === field && hit.node.key === null) return hit.proxy;
  const node = new NodeHandler(store, row, field, realm, null, null);
  const proxy = new Proxy(value, node);
  cache.set(value, { proxy, node });
  return proxy;
}

/** `h.state`: the write-through proxy over the record's state (one per state object and realm) */
export function stateProxy(store: StoreCore, row: RowRec, realm: Realm): Record<string, unknown> {
  return rootProxy(store, row, 'state', realm, row.state) as Record<string, unknown>;
}

/** a props field read: an object value as a write-through proxy, anything else as stored (undefined while unset) */
export function propValue(store: StoreCore, row: RowRec, field: string, realm: Realm): unknown {
  const v = fieldRoot(row, field);
  return isObj(v) ? rootProxy(store, row, field, realm, v) : v;
}

/** the view of a whole field, set or not: reads come from the field's channel (fresh snapshots) or the stored map, writes and
 *  deletes of a key go through writeProp (`ctx.self.anim.walk = …`, `ctx.self.ik.rightArm = null`, `o.forces.surge = …`) */
export function fieldView(store: StoreCore, row: RowRec, field: string, realm: Realm): Record<string, unknown> {
  let per = VIEW_CACHE.get(store);
  if (!per) {
    per = { platform: new WeakMap(), client: new WeakMap(), ui: new WeakMap() };
    VIEW_CACHE.set(store, per);
  }
  let views = per[realm].get(row);
  if (!views) {
    views = new Map();
    per[realm].set(row, views);
  }
  let view = views.get(field);
  if (!view) {
    view = new Proxy({}, new FieldHandler(store, row, field, realm));
    views.set(field, view);
  }
  return view as Record<string, unknown>;
}

class FieldHandler implements ProxyHandler<object> {
  readonly #store: StoreCore;
  readonly #row: RowRec;
  readonly #field: string;
  readonly #realm: Realm;
  /** the parent of the proxies handed out for the stored map's values (path []) */
  readonly #root: NodeHandler;

  constructor(store: StoreCore, row: RowRec, field: string, realm: Realm) {
    this.#store = store;
    this.#row = row;
    this.#field = field;
    this.#realm = realm;
    this.#root = new NodeHandler(store, row, field, realm, null, null);
  }

  #current(): { value: unknown; derived: boolean } {
    const reader = this.#store.channels.reader(this.#field);
    if (reader?.read) return { value: reader.read(this.#row, this.#realm), derived: true };
    return { value: fieldRoot(this.#row, this.#field), derived: false };
  }

  get(target: object, key: string | symbol): unknown {
    if (typeof key === 'symbol') return Reflect.get(target, key);
    const { value, derived } = this.#current();
    if (isObj(value) && hasOwn(value, key)) {
      const v = value[key];
      if (derived || !isObj(v)) return v;
      return SNAPSHOT_FIELDS.has(this.#field) ? cloneWire(v) : childProxy(this.#root, v, segOf(value, key));
    }
    return Reflect.get(target, key);
  }

  set(_target: object, key: string | symbol, value: unknown): boolean {
    if (typeof key === 'symbol') return true;
    if (this.#realm === 'ui') {
      this.#store.readonlyWrite(this.#row, this.#field);
      return true;
    }
    writeProp(this.#store, this.#row, this.#field, [key], value, this.#realm);
    return true;
  }

  deleteProperty(_target: object, key: string | symbol): boolean {
    if (typeof key === 'symbol') return true;
    if (this.#realm === 'ui') {
      this.#store.readonlyWrite(this.#row, this.#field);
      return true;
    }
    deleteProp(this.#store, this.#row, this.#field, [key], this.#realm);
    return true;
  }

  defineProperty(target: object, key: string | symbol, desc: PropertyDescriptor): boolean {
    return 'value' in desc ? this.set(target, key, desc.value) : false;
  }

  has(_target: object, key: string | symbol): boolean {
    const { value } = this.#current();
    return isObj(value) && key in value;
  }

  ownKeys(): ArrayLike<string | symbol> {
    const { value } = this.#current();
    return isObj(value) ? Reflect.ownKeys(value).filter((k): k is string => typeof k === 'string') : [];
  }

  getOwnPropertyDescriptor(target: object, key: string | symbol): PropertyDescriptor | undefined {
    if (typeof key === 'symbol') return undefined;
    const { value } = this.#current();
    if (!isObj(value) || !hasOwn(value, key)) return undefined;
    return { value: this.get(target, key), writable: true, enumerable: true, configurable: true };
  }
}
