import { SAVE_KEY, jsonSaveCodec, type SaveDocument, type SaveCodec, type SaveParseStatus } from './codec.ts';
import type { SaveStore } from '../ports.ts';
import type { ChangeRecord, Kernel, PauseReason, RowRec } from '../types.ts';
import { cloneWire, deepEqualWire } from '../wire.ts';


/** The document key holding saved player state. */
export const PLAYER_STATE_KEY = 'ps';

/** D-CORE-13 */
export const DEBOUNCE_MS = 1500;
/** core §13.4: one warning above this many UTF-8 bytes */
export const DURABLE_WARN_BYTES = 64 * 1024;

export type FlushReason = string;

/** `unread` until load() finished; `failed` when the store could not be read (the session writes nothing) */
export type DurableLoadStatus = SaveParseStatus | 'unread' | 'failed';

export interface DurableLog {
  warn(message: string, detail?: unknown): void;
  error(message: string, detail?: unknown): void;
}

export interface DurableOptions {
  /** storage key; default ss_save_v1 */
  key?: string;
  /** corrupt text backup; default <key>_bad */
  backupKey?: string;
  /** saved body keys; default all keys, under the ps container */
  durableKeys?: readonly string[] | 'all';
  /** root is for explicitly selected keys in an existing save format */
  bodyStorage?: 'nested' | 'root';
  codec?: SaveCodec;
  flushOnWrite?: readonly string[];
  /** keys whose first edit takes over a debounce started before body binding */
  debounceKeys?: readonly string[];
  /** default 1500 */
  debounceMs?: number;
  /** default: the console, prefixed `[save]` */
  log?: DurableLog;
  /** where `bindBody(row)` hears the body's writes when the call names no source (the kernel's row store) */
  changes?: ChangeSource;
}

/** where the body row's writes are heard: the kernel's row store (`kernel.store.observe`, store/rows.ts) */
export interface ChangeSource {
  observe(fn: (c: ChangeRecord) => void): () => void;
}

/** the port-owned settings sidecar (io's ProfileStore.update = `set`); values are copied in and out */
export interface DurableSettings {
  get<T>(k: string): T | undefined;
  /** `undefined` removes the key; an equal value changes nothing; schedules the debounced write */
  set(k: string, v: unknown): void;
}

export interface DurablePartSpec<T> {
  /** the owner's live value from the stored one (`undefined`: the document has none); must be free of side effects */
  read(loaded: unknown): T;
  /** the JSON-ready value to store; called only while the part is dirty; `undefined` removes the key */
  write(): unknown;
}

export interface DurablePart<T> {
  /** what `read` answered */
  get(): T;
  markDirty(): void;
  /** markDirty() and flush now */
  flush(): Promise<void>;
}

interface PartRec {
  readonly key: string;
  readonly spec: DurablePartSpec<unknown>;
  value: unknown;
  dirty: boolean;
  /** its write() threw and the failure has been reported */
  failed: boolean;
}

const RESERVED: ReadonlySet<string> = new Set(['v', 'settings', 'ps', '__proto__', '']);
const LOADED: ReadonlySet<DurableLoadStatus> = new Set<DurableLoadStatus>(['empty', 'ok', 'migrated', 'repaired', 'corrupt']);

const consoleLog: DurableLog = {
  warn: (m, d) => (d === undefined ? console.warn(`[save] ${m}`) : console.warn(`[save] ${m}`, d)),
  error: (m, d) => (d === undefined ? console.error(`[save] ${m}`) : console.error(`[save] ${m}`, d)),
};

const describeError = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** an own data property, also for a `__proto__` key (never the prototype) */
function setOwn(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function utf8Bytes(text: string): number {
  // at most 3 bytes per UTF-16 unit: short texts need no encoding pass
  return text.length * 3 <= DURABLE_WARN_BYTES ? text.length : new TextEncoder().encode(text).length;
}

export class DurableState {
  /** core §13.3 */
  readonly settings: DurableSettings;

  readonly #store: SaveStore;
  readonly #key: string;
  readonly #backupKey: string;
  /** null selects all body keys; nested storage keeps them under ps. */
  readonly #keys: readonly string[] | null;
  readonly #codec: SaveCodec;
  readonly #flushOnWrite: ReadonlySet<string>;
  readonly #debounceKeys: ReadonlySet<string>;
  readonly #nested: boolean;
  readonly #debounceMs: number;
  readonly #log: DurableLog;
  readonly #changes: ChangeSource | null;

  #loading: Promise<void> | null = null;
  #status: DurableLoadStatus = 'unread';
  /** the durable body keys: as loaded, then as last read from the bound row (own copies) */
  #body: Record<string, unknown> = {};
  #settings: Record<string, unknown> = {};
  /** every other top-level key: the stored values of the registered parts and the keys nobody registered */
  #extra: Record<string, unknown> = {};
  readonly #parts = new Map<string, PartRec>();

  #row: RowRec | null = null;
  #unobserve: (() => void) | null = null;

  /** the body keys or the sidecar changed, or a part handed over a value, since the last write that succeeded */
  #dirty = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  /** the pending window was opened by bindBody() for pre-bind dirt: the first configured edit after the bind restarts it */
  #bindArmed = false;
  /** a configured write waits for its microtask flush */
  #soon = false;
  /** the last text written, or the text loaded */
  #lastJson: string | null = null;
  #setFailing = false;
  #sizeWarned = false;
  #refusalWarned = false;
  #disposed = false;

  constructor(store: SaveStore, opts: DurableOptions = {}) {
    this.#store = store;
    this.#key = opts.key ?? SAVE_KEY;
    this.#backupKey = opts.backupKey ?? this.#key + '_bad';
    this.#nested = opts.bodyStorage !== 'root';
    this.#codec = opts.codec ?? jsonSaveCodec;
    this.#flushOnWrite = new Set(opts.flushOnWrite ?? []);
    this.#debounceKeys = new Set(opts.debounceKeys ?? []);
    this.#keys = opts.durableKeys === undefined || opts.durableKeys === 'all' ? null : [...new Set(opts.durableKeys)].filter((k) => typeof k === 'string' && k !== '' && k !== '__proto__');
    if (!this.#nested && this.#keys === null) throw new TypeError('DurableState: root body storage requires an explicit key list');
    if (!this.#nested && this.#keys?.some(k => RESERVED.has(k))) throw new TypeError('DurableState: a body key conflicts with document metadata');
    this.#debounceMs = opts.debounceMs ?? DEBOUNCE_MS;
    this.#log = opts.log ?? consoleLog;
    this.#changes = opts.changes ?? null;
    this.settings = Object.freeze({
      get: <T>(k: string): T | undefined => (Object.hasOwn(this.#settings, k) ? (cloneWire(this.#settings[k]) as T | undefined) : undefined),
      set: (k: string, v: unknown): void => this.#setSetting(k, v),
    });
  }

  // ── load ───────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** awaits `store.ready`, reads the key once, parses, validates and migrates; never rejects. Answers a copy of the document. */
  load(): Promise<SaveDocument> {
    this.#loading ??= this.#read();
    return this.#loading.then(() => this.snapshot());
  }

  /** load() has finished (whatever it found) */
  get loaded(): boolean {
    return this.#status !== 'unread';
  }

  get loadStatus(): DurableLoadStatus {
    return this.#status;
  }

  async #read(): Promise<void> {
    let raw: string | null = null;
    let failed = false;
    try {
      await this.#store.ready;
      raw = this.#store.get(this.#key);
    } catch (err) {
      failed = true;
      this.#log.error(`${this.#key} could not be read (${describeError(err)}); this session starts from the defaults and writes nothing`, err);
    }
    let parsed;
    try { parsed = this.#codec.read(failed ? null : raw); }
    catch (err) {
      this.#log.error('the save codec could not read the document; this session writes nothing', err);
      parsed = jsonSaveCodec.read(null);
      failed = true;
    }
    if (parsed.status === 'corrupt' && raw !== null) this.#backup(raw, parsed.issues);
    else if (parsed.issues.length > 0) this.#log.warn(`${this.#key} was repaired: ${parsed.issues.join('; ')}`);

    const save = parsed.save;
    this.#body = {};
    this.#extra = {};
    for (const k of Object.keys(save)) {
      if (k === 'v' || k === 'settings' || k === '__proto__') continue;
      const v = save[k];
      if (v === undefined) continue;
      if (this.#nested) {
        if (k === PLAYER_STATE_KEY) {
          if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
            for (const [bk, bv] of Object.entries(v)) if ((this.#keys === null || this.#keys.includes(bk)) && bk !== '__proto__' && bv !== undefined) setOwn(this.#body, bk, bv);
          }
        } else setOwn(this.#extra, k, v);
      } else if (this.#keys?.includes(k)) this.#body[k] = v;
      else setOwn(this.#extra, k, v);
    }
    this.#settings = save.settings;
    this.#lastJson = !failed && parsed.status !== 'corrupt' ? raw : null;
    this.#dirty = false;
    this.#status = failed ? 'failed' : parsed.status;
    // parts registered before the document was in: they read the stored value now
    for (const rec of this.#parts.values()) {
      rec.dirty = false;
      this.#readPart(rec);
    }
  }

  /** core §13.4: the raw text of a corrupt document is kept once */
  #backup(raw: string, issues: readonly string[]): void {
    try {
      if (this.#store.get(this.#backupKey) !== raw) this.#store.set(this.#backupKey, raw);
      this.#log.warn(`${this.#key} is corrupt (${issues.join('; ')}); its text is kept under ${this.#backupKey} and the save starts over`);
    } catch (err) {
      this.#log.error(`${this.#key} is corrupt (${issues.join('; ')}) and its text could not be kept under ${this.#backupKey}: ${describeError(err)}`, err);
    }
  }

  /** the store was read: writes are allowed */
  get #writable(): boolean {
    return LOADED.has(this.#status);
  }

  // ── the body ───────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * The saved state to merge over the player template, as a fresh copy. Before
   * a body is bound these are the loaded values; afterwards what that body holds now (what a respawn should get).
   */
  initialBodyState(): Record<string, unknown> {
    return cloneWire(this.#readBody()) as Record<string, unknown>;
  }

  /**
   * Starts observing the body row. From here on the row's state is the truth for the selected durable keys. A second call
   * rebinds. The row's writes are heard on `changes` (the kernel's row store; boot passes it), else on the source given at
   * construction; a row record does not lead to its store, so with neither the call throws and binds nothing.
   */
  bindBody(row: RowRec, changes?: ChangeSource): void {
    const source = changes ?? this.#changes;
    if (source === null) {
      throw new Error('DurableState.bindBody: no change source (pass the kernel\'s row store here, or as `changes` at construction)');
    }
    this.unbindBody();
    this.#row = row;
    this.#unobserve = source.observe((c) => {
      if (c.row !== row || c.field !== 'state') return;
      const key = c.path.length === 0 ? null : String(c.path[0]);
      if (key !== null && (key === '__proto__' || (this.#keys !== null && !this.#keys.includes(key)))) return;
      this.#mark(key !== null && this.#debounceKeys.has(key) ? 'takeover' : 'other');
      if (key === null ? this.#flushOnWrite.size > 0 : this.#flushOnWrite.has(key)) this.#flushSoon();
    });
    // The first configured edit may take over a debounce that began before the body bound.
    if (this.dirty && this.#timer === null) {
      this.#bindArmed = true;
      this.#arm();
    }
  }

  /** stops observing; the document keeps what the body held */
  unbindBody(): void {
    if (this.#row !== null) this.#readBody();
    this.#unobserve?.();
    this.#unobserve = null;
    this.#row = null;
  }

  /** the durable keys of the bound body as they are now (own copies), else the last known ones */
  #readBody(): Record<string, unknown> {
    const row = this.#row;
    if (row !== null && row.phase === 'alive') {
      const body: Record<string, unknown> = {};
      for (const k of this.#keys ?? Object.keys(row.state)) {
        if (k === '__proto__') continue;
        const v = cloneWire(row.state[k]);
        if (v !== undefined) setOwn(body, k, v);
      }
      this.#body = body;
    }
    return this.#body;
  }

  // ── the settings sidecar ───────────────────────────────────────────────────────────────────────────────────────────

  #setSetting(k: string, v: unknown): void {
    if (typeof k !== 'string' || k === '' || k === '__proto__') return;
    if (this.#status === 'unread') {
      this.#refuse(`settings.set("${k}") before load(): refused (the stored sidecar is not read yet)`);
      return;
    }
    const had = Object.hasOwn(this.#settings, k);
    let value: unknown;
    try {
      value = v === undefined ? undefined : cloneWire(v);
    } catch (err) {
      this.#log.error(`settings.set("${k}"): the value cannot be saved (${describeError(err)})`, err);
      return;
    }
    if (value === undefined) {
      if (!had) return;
      delete this.#settings[k];
    } else {
      if (had && deepEqualWire(this.#settings[k], value)) return;
      setOwn(this.#settings, k, value);
    }
    this.#mark('other');
  }

  // ── port-owned parts ───────────────────────────────────────────────────────────────────────────────────────────────

  /** see the header: a further top-level key of the document, owned by port code */
  registerPart<T>(key: string, spec: DurablePartSpec<T>): DurablePart<T> {
    if (typeof key !== 'string' || (RESERVED.has(key) || (!this.#nested && this.#keys?.includes(key)))) {
      throw new Error(`DurableState.registerPart: ${JSON.stringify(key)} cannot be a part key (reserved metadata or durable body key)`);
    }
    if (this.#parts.has(key)) throw new Error(`DurableState.registerPart: the part "${key}" is already registered`);
    const rec: PartRec = { key, spec: spec as DurablePartSpec<unknown>, value: undefined, dirty: false, failed: false };
    this.#parts.set(key, rec);
    this.#readPart(rec);
    return {
      get: () => rec.value as T,
      markDirty: () => {
        rec.dirty = true;
        this.#mark('other');
      },
      flush: () => {
        rec.dirty = true;
        return this.flush('manual');
      },
    };
  }

  #readPart(rec: PartRec): void {
    const stored = Object.hasOwn(this.#extra, rec.key) ? cloneWire(this.#extra[rec.key]) : undefined;
    try {
      rec.value = rec.spec.read(stored);
    } catch (err) {
      this.#log.error(`the part "${rec.key}" could not read its stored value (${describeError(err)}); it starts empty`, err);
      try {
        rec.value = rec.spec.read(undefined);
      } catch {
        rec.value = undefined;
      }
    }
  }

  /** the dirty parts hand over their values; a part that throws keeps its last stored one */
  #collectParts(): void {
    for (const rec of this.#parts.values()) {
      if (!rec.dirty) continue;
      try {
        const value = cloneWire(rec.spec.write());
        if (value === undefined) delete this.#extra[rec.key];
        else setOwn(this.#extra, rec.key, value);
        rec.dirty = false;
        rec.failed = false;
      } catch (err) {
        if (rec.failed) continue;
        rec.failed = true;
        this.#log.error(`the part "${rec.key}" could not be written (${describeError(err)}); its last stored value is kept`, err);
      }
    }
  }

  // ── dirty, debounce, write ─────────────────────────────────────────────────────────────────────────────────────────

  /** something waits to be written */
  get dirty(): boolean {
    if (this.#dirty) return true;
    for (const rec of this.#parts.values()) if (rec.dirty) return true;
    return false;
  }

  #mark(kind: 'takeover' | 'other'): void {
    this.#dirty = true;
    // A configured edit takes over a provisional window once; subsequent edits coalesce.
    if (kind === 'takeover' && this.#bindArmed) this.#cancelTimer();
    this.#arm();
  }

  /** the debounce runs from the first mark of a window */
  #arm(): void {
    if (this.#timer !== null || this.#disposed) return;
    if (this.#row === null) return;
    if (!this.#writable) {
      if (this.#status === 'failed') this.#refuse(`${this.#key} was not read at load: nothing is written this session`);
      return;
    }
    const timer = setTimeout(() => {
      this.#timer = null;
      this.#write();
    }, this.#debounceMs);
    (timer as { unref?: () => void }).unref?.();
    this.#timer = timer;
  }

  #cancelTimer(): void {
    this.#bindArmed = false;
    if (this.#timer === null) return;
    clearTimeout(this.#timer);
    this.#timer = null;
  }

  /** a configured write is a flush point: one flush for every such write of this tick (and of the frame's other ticks) */
  #flushSoon(): void {
    if (this.#soon || this.#disposed) return;
    this.#soon = true;
    void Promise.resolve().then(() => {
      if (!this.#soon) return;
      this.#soon = false;
      void this.flush('write');
    });
  }

  #refuse(message: string): void {
    if (this.#refusalWarned) return;
    this.#refusalWarned = true;
    this.#log.warn(message);
  }

  /** the document as it would be written now (a copy) */
  snapshot(): SaveDocument {
    return cloneWire(this.#document()) as unknown as SaveDocument;
  }

  #document(): SaveDocument {
    const doc: SaveDocument = { v: 1, settings: this.#settings };
    const body = this.#readBody();
    if (this.#nested) {
      if (Object.keys(body).length > 0) setOwn(doc, PLAYER_STATE_KEY, body);
    } else for (const k of this.#keys ?? []) if (body[k] !== undefined) (doc as Record<string, unknown>)[k] = body[k];
    for (const k of Object.keys(this.#extra)) setOwn(doc, k, this.#extra[k]);
    return doc;
  }

  /** writes the document if it is dirty and differs from the stored text */
  #write(): void {
    if (!this.#writable || !this.dirty) return;
    // the dirty parts hand their values over first; from here the document is unwritten until `set` succeeds, also when
    // only a part was dirty (its own flag is cleared by the hand-over)
    this.#collectParts();
    this.#dirty = true;
    let json: string;
    try {
      json = this.#codec.serialize(this.#document());
    } catch (err) {
      this.#log.error(`${this.#key} could not be serialised (${describeError(err)})`, err);
      return;
    }
    if (json !== this.#lastJson) {
      try {
        this.#store.set(this.#key, json);
      } catch (err) {
        // stays dirty: the next write (a flush point, or the next debounce window) tries again
        if (!this.#setFailing) this.#log.error(`${this.#key} could not be written (${describeError(err)}); it is tried again at the next write`, err);
        this.#setFailing = true;
        return;
      }
      this.#setFailing = false;
      this.#lastJson = json;
      if (!this.#sizeWarned) {
        const bytes = utf8Bytes(json);
        if (bytes > DURABLE_WARN_BYTES) {
          this.#sizeWarned = true;
          this.#log.warn(`${this.#key} is ${bytes} bytes, above ${DURABLE_WARN_BYTES / 1024} KB (expected 1-10 KB)`);
        }
      }
    }
    this.#dirty = false;
  }

  /** serialise now and ask the platform store to flush; safe to call often; never rejects */
  flush(_reason: FlushReason): Promise<void> {
    this.#cancelTimer();
    this.#soon = false;
    this.#write();
    let done: Promise<void>;
    try {
      done = Promise.resolve(this.#store.flush());
    } catch (err) {
      done = Promise.reject(err);
    }
    return done.then(undefined, (err: unknown) => {
      this.#log.error(`the save store could not flush (${describeError(err)})`, err);
    });
  }

  /** stops observing and drops the pending write (tests, a kernel torn down) */
  dispose(): void {
    this.#disposed = true;
    this.unbindBody();
    this.#cancelTimer();
    this.#soon = false;
  }
}

// ── flush sources the class cannot see itself ────────────────────────────────────────────────────────────────────────

/** the part of `document` the page hook uses */
export interface PageDocumentLike {
  readonly visibilityState?: string;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

/** the part of `window` the page hook uses */
export interface PageWindowLike {
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface FlushHookOptions {
  /** `paused` with a reason that was not set before → flush('pause') */
  kernel?: Pick<Kernel, 'on' | 'clock'> | null;
  /** `visibilitychange` with `visibilityState === 'hidden'` → flush('hidden'); default: the page's document, when there is one */
  document?: PageDocumentLike | null;
  /** `pagehide` → flush('hidden'); default: the page's window, when there is one */
  window?: PageWindowLike | null;
}

/**
 * core §13.4 "flush points" that arrive from outside the body: any pause reason added, the page being hidden and `pagehide`.
 * RESULTS (X-34) and SETTINGS / CONTROLS closing call `durable.flush` themselves. Returns the undo.
 */
export function installFlushHooks(durable: Pick<DurableState, 'flush'>, opts: FlushHookOptions = {}): () => void {
  const undo: Array<() => void> = [];
  const kernel = opts.kernel ?? null;
  if (kernel !== null) {
    let before: ReadonlySet<PauseReason> = new Set(kernel.clock.reasons);
    undo.push(
      kernel.on('paused', (_paused, reasons) => {
        let added = false;
        for (const r of reasons) if (!before.has(r)) added = true;
        before = new Set(reasons);
        if (added) void durable.flush('pause');
      }),
    );
  }
  const page = globalThis as { document?: PageDocumentLike; window?: PageWindowLike };
  const doc = opts.document === undefined ? (page.document ?? null) : opts.document;
  const win = opts.window === undefined ? (page.document !== undefined ? (page.window ?? null) : null) : opts.window;
  if (doc !== null) {
    const onVisibility = (): void => {
      if (doc.visibilityState === 'hidden') void durable.flush('hidden');
    };
    doc.addEventListener('visibilitychange', onVisibility);
    undo.push(() => doc.removeEventListener('visibilitychange', onVisibility));
  }
  if (win !== null) {
    const onPageHide = (): void => void durable.flush('hidden');
    win.addEventListener('pagehide', onPageHide);
    undo.push(() => win.removeEventListener('pagehide', onPageHide));
  }
  return () => {
    for (const off of undo.splice(0)) off();
  };
}
