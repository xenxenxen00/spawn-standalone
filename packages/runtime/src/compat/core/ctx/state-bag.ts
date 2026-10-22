// State stores that belong to no row: `ctx.world.state` (kernel.worldState) and `ctx.place.state` (PlaceRuntime.state)
// (docs/design/core-runtime.md §5.3, §5.7, D-CORE-02; contract §4.2).
//
// The write semantics of the row proxies (store/proxies.ts), without a row behind them:
//   - a write stores a wire copy (cloneWire: JSON semantics); assigning undefined clears the key (an array slot becomes null);
//   - an equal write is free (no version bump);
//   - reads of nested objects return proxies over the store's own data, one per object, so `s.ss === s.ss`;
//   - `delete` clears; an index written past the end of an array leaves null in between;
//   - the read-only view (the UI realm, core §7.5) ignores every write and delete, with one dev warning per store.
// The data object is the kernel's (or the place runtime's) own plain object: other domains read it directly. `version` counts
// the effective writes; the kernel marks the UI dirty from it at tick end. A reference kept across a replacement of its parent
// (`const m = s.ss; s.ss = {…}; m.x = 1`) edits the orphaned object and nothing in the store.
// Dev builds: a store over STATE_WARN_BYTES (32 KiB) of JSON is warned, at most once a minute (engine reference).
import { ENGINE } from '../rules.ts';
import { cloneWire, deepEqualWire, isPlainObject } from '../wire.ts';

export interface StateBagOptions {
  /** what a warning calls the store: `world.state`, `place.state of <p>` */
  readonly name: string;
  /** called after every effective write */
  readonly onWrite?: (() => void) | undefined;
  /** dev warnings (read-only writes, the size watchdog); default: none */
  readonly warn?: ((message: string) => void) | undefined;
}

const hasOwn = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const INDEX = /^(?:0|[1-9]\d*)$/;
/** the size watchdog measures at most this often (ms) and warns at most once per SIZE_WARN_EVERY_MS */
const SIZE_CHECK_EVERY_MS = 1000;
const SIZE_WARN_EVERY_MS = 60_000;

export class StateBag {
  /** the store's own object (never replaced) */
  readonly data: Record<string, unknown>;
  readonly name: string;
  /** effective writes so far */
  version = 0;
  /** writes ignored because they came through the read-only view */
  readonlyWrites = 0;
  readonly #onWrite: (() => void) | undefined;
  readonly #warn: ((message: string) => void) | undefined;
  readonly #rw = new WeakMap<object, object>();
  readonly #ro = new WeakMap<object, object>();
  readonly #rwHandler: ProxyHandler<object>;
  readonly #roHandler: ProxyHandler<object>;
  #warnedReadonly = false;
  #sizeAt = Number.NEGATIVE_INFINITY;
  #sizeVersion = -1;
  #sizeWarnAt = Number.NEGATIVE_INFINITY;

  constructor(data: Record<string, unknown>, opts: StateBagOptions) {
    this.data = data;
    this.name = opts.name;
    this.#onWrite = opts.onWrite;
    this.#warn = opts.warn;
    this.#rwHandler = {
      get: (t, k, r) => this.#get(t, k, r, false),
      set: (t, k, v) => this.#set(t, k, v),
      deleteProperty: (t, k) => this.#delete(t, k),
      defineProperty: (t, k, d) => ('value' in d ? this.#set(t, k, d.value) : false),
    };
    this.#roHandler = {
      get: (t, k, r) => this.#get(t, k, r, true),
      set: () => this.#refused(),
      deleteProperty: () => this.#refused(),
      defineProperty: () => this.#refused(),
    };
  }

  /** the write-through view, or the read-only one (the UI realm); one proxy per object and mode */
  view(readonly = false): Record<string, any> {
    return this.#proxy(this.data, readonly) as Record<string, any>;
  }

  /** `store = {…}`: the contents are replaced by a copy (the data object itself stays, other domains hold it) */
  replace(value: unknown): void {
    const next = cloneWire(value);
    const src = isPlainObject(next) ? next : {};
    if (deepEqualWire(this.data, src)) return;
    for (const k of Object.keys(this.data)) delete this.data[k];
    for (const k of Object.keys(src)) this.data[k] = src[k];
    this.#wrote();
  }

  /** dev size watchdog: the JSON size when it was measured now (the store changed and a second passed), else null */
  checkSize(wallMs: number): number | null {
    if (this.version === this.#sizeVersion || wallMs - this.#sizeAt < SIZE_CHECK_EVERY_MS) return null;
    this.#sizeAt = wallMs;
    this.#sizeVersion = this.version;
    let bytes: number;
    try {
      bytes = JSON.stringify(this.data).length;
    } catch {
      return null;
    }
    if (bytes > ENGINE.STATE_WARN_BYTES && wallMs - this.#sizeWarnAt >= SIZE_WARN_EVERY_MS) {
      this.#sizeWarnAt = wallMs;
      this.#warn?.(`${this.name} holds ${bytes} bytes of JSON (over ${ENGINE.STATE_WARN_BYTES}: a state row this size is warned live)`);
    }
    return bytes;
  }

  #proxy(target: object, readonly: boolean): object {
    const cache = readonly ? this.#ro : this.#rw;
    let p = cache.get(target);
    if (p === undefined) {
      p = new Proxy(target, readonly ? this.#roHandler : this.#rwHandler);
      cache.set(target, p);
    }
    return p;
  }

  #get(target: object, key: string | symbol, receiver: unknown, readonly: boolean): unknown {
    if (typeof key === 'symbol' || !hasOwn(target, key)) return Reflect.get(target, key, receiver);
    const v = (target as Record<string, unknown>)[key];
    return isObj(v) ? this.#proxy(v, readonly) : v;
  }

  #set(target: object, key: string | symbol, value: unknown): boolean {
    if (typeof key === 'symbol') return true;
    const t = target as Record<string, unknown>;
    if (Array.isArray(target) && key === 'length') {
      const n = Number(value);
      if (Number.isInteger(n) && n >= 0 && n !== target.length) {
        const old = target.length;
        target.length = n;
        for (let i = old; i < n; i++) target[i] = null;
        this.#wrote();
      }
      return true;
    }
    let v: unknown = cloneWire(value);
    if (v === undefined && Array.isArray(target)) v = null;
    const had = hasOwn(target, key);
    if (v === undefined) {
      if (!had) return true;
      delete t[key];
      this.#wrote();
      return true;
    }
    if (had && deepEqualWire(t[key], v)) return true;
    const oldLength = Array.isArray(target) ? target.length : -1;
    if (key === '__proto__') Object.defineProperty(t, key, { value: v, writable: true, enumerable: true, configurable: true });
    else t[key] = v;
    // an index written past the end leaves null in between (JSON has no holes)
    if (oldLength >= 0 && INDEX.test(key)) for (let i = oldLength; i < Number(key); i++) if (!(i in target)) (target as unknown[])[i] = null;
    this.#wrote();
    return true;
  }

  #delete(target: object, key: string | symbol): boolean {
    if (typeof key === 'symbol') return Reflect.deleteProperty(target, key);
    if (!hasOwn(target, key)) return true;
    const t = target as Record<string, unknown>;
    if (Array.isArray(target) && INDEX.test(key)) {
      // a deleted array element is null on the wire: the array stays dense
      if (t[key] === null) return true;
      t[key] = null;
    } else delete t[key];
    this.#wrote();
    return true;
  }

  #refused(): boolean {
    this.readonlyWrites++;
    if (!this.#warnedReadonly) {
      this.#warnedReadonly = true;
      this.#warn?.(`write to ${this.name} through the read-only UI view ignored`);
    }
    return true;
  }

  #wrote(): void {
    this.version++;
    this.#onWrite?.();
  }
}
