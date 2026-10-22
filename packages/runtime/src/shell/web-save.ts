// Copied from purge-protocol-web ebab692 (src/app or src/platform, same file name; web-platform.ts is platform/web.ts).
// The web adapter's SaveStore (build §6.6, platform-crazygames.md §9.5): browser storage under the `ss:` prefix.
//
// THE ONLY FILE UNDER src/ ALLOWED TO TOUCH localStorage (tools/check/source-rules.ts rule `local-storage`; docs/architecture.md
// §10 rule 6). Playgama builds save through `bridge.storage` (playgama.ts, WP B5b); this store serves `npm run dev`, self-hosting
// and headless runs.
//
// Behaviour, matching the SaveStore contract of build §6.1:
//   - one initial read: every `ss:` key is read into memory at construction, `ready` resolves at once; `get` answers from memory
//   - `set` writes through (X-16: core DurableState is the only debounce); `set(key, '')` throws, as the Bridge deletes on ''
//   - a write or remove that throws (quota, SecurityError, private mode) keeps the value in memory, marks the key dirty and
//     warns once; `flush()` retries the dirty keys once per call, never in a loop
//   - no usable storage at all (blocked, opaque origin, Node): a working in-memory store with `persistent === false`
import type { SaveStore } from '../platform/platform.ts';

export const WEB_SAVE_PREFIX = 'ss:';

/** the part of the DOM `Storage` this store uses */
export interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** the page's localStorage, or null where reading the property throws or it does not exist */
export function defaultWebStorage(): StorageLike | null {
  try {
    const s = (globalThis as { localStorage?: StorageLike }).localStorage;
    return s ?? null;
  } catch {
    return null;
  }
}

export interface WebSaveOptions {
  /** default: the page's localStorage (`defaultWebStorage()`); null = memory only */
  storage?: StorageLike | null;
  /** default `ss:` */
  prefix?: string;
}

export class WebSaveStore implements SaveStore {
  readonly ready: Promise<void>;
  readonly #storage: StorageLike | null;
  readonly #prefix: string;
  readonly #cache = new Map<string, string>();
  /** key → the pending write (a string) or removal (null) that last failed */
  readonly #dirty = new Map<string, string | null>();
  #warned = false;

  constructor(opts: WebSaveOptions = {}) {
    this.#prefix = opts.prefix ?? WEB_SAVE_PREFIX;
    this.#storage = this.#readAll(opts.storage === undefined ? defaultWebStorage() : opts.storage);
    this.ready = Promise.resolve();
  }

  /** false when the store lives only in memory (nothing survives a reload) */
  get persistent(): boolean {
    return this.#storage !== null;
  }

  /** keys whose last write or removal has not reached the storage yet */
  get dirtyCount(): number {
    return this.#dirty.size;
  }

  get(key: string): string | null {
    return this.#cache.get(key) ?? null;
  }

  set(key: string, value: string): void {
    if (key === '') throw new TypeError('SaveStore.set: the key must be a non-empty string');
    if (value === '') throw new TypeError(`SaveStore.set("${key}", ''): an empty value is never written (the Bridge deletes on '')`);
    this.#cache.set(key, value);
    this.#write(key, value);
  }

  remove(key: string): void {
    this.#cache.delete(key);
    this.#write(key, null);
  }

  flush(): Promise<void> {
    for (const [key, value] of [...this.#dirty]) this.#write(key, value);
    return Promise.resolve();
  }

  /** the initial read; a storage that throws on read counts as none */
  #readAll(storage: StorageLike | null): StorageLike | null {
    if (!storage) return null;
    try {
      for (let i = 0; i < storage.length; i++) {
        const k = storage.key(i);
        if (k === null || !k.startsWith(this.#prefix)) continue;
        const v = storage.getItem(k);
        if (v !== null) this.#cache.set(k.slice(this.#prefix.length), v);
      }
      return storage;
    } catch (err) {
      this.#cache.clear();
      this.#warn('storage is not readable; saves stay in memory for this session', err);
      return null;
    }
  }

  #write(key: string, value: string | null): void {
    const s = this.#storage;
    if (!s) return;
    try {
      if (value === null) s.removeItem(this.#prefix + key);
      else s.setItem(this.#prefix + key, value);
      this.#dirty.delete(key);
    } catch (err) {
      this.#dirty.set(key, value);
      this.#warn(`could not ${value === null ? 'remove' : 'write'} "${key}"; kept in memory, retried at the next flush`, err);
    }
  }

  #warn(msg: string, err: unknown): void {
    if (this.#warned) return;
    this.#warned = true;
    console.warn(`[web-save] ${msg}`, err);
  }
}
