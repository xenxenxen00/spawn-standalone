import type { BackupInfo, SqlBackupStore, SqlStore } from './types.ts';

/** In-memory store (tests, and the default when a host passes no store). */
export interface MemorySqlStore extends SqlStore {
  /** Bytes currently held, or null. */
  readonly bytes: Uint8Array | null;
  /** How many times save() ran. */
  readonly saves: number;
  backups: SqlBackupStore;
}

export function createMemorySqlStore(initial: Uint8Array | null = null): MemorySqlStore {
  let held = initial ? initial.slice() : null;
  let saves = 0;
  const snapshots = new Map<string, { info: BackupInfo; bytes: Uint8Array }>();
  return {
    get bytes() {
      return held;
    },
    get saves() {
      return saves;
    },
    load: () => Promise.resolve(held ? held.slice() : null),
    save(bytes) {
      held = bytes.slice();
      saves += 1;
      return Promise.resolve();
    },
    backups: {
      put(info, bytes) {
        snapshots.set(info.bookmark, { info, bytes: bytes.slice() });
        return Promise.resolve();
      },
      get: (bookmark) => Promise.resolve(snapshots.get(bookmark)?.bytes.slice() ?? null),
      list: () => Promise.resolve([...snapshots.values()].map((s) => s.info)),
    },
  };
}

// ---- Byte KV and the per-world store over it (the browser backends are in stores-browser.ts) ----

/** A string-keyed byte map; the browser store is one of these plus key naming. */
export interface ByteKv {
  get(key: string): Promise<Uint8Array | null>;
  set(key: string, bytes: Uint8Array): Promise<void>;
  keys(prefix: string): Promise<string[]>;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

export function base64ToBytes(text: string): Uint8Array {
  const bin = atob(text);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/** Wraps a ByteKv as one world's SqlStore: `<ns>:<world>:db`, backups under `<ns>:<world>:bk:`. */
export function kvSqlStore(kv: ByteKv, worldId: string, namespace = 'spawn-sql'): SqlStore {
  const base = `${namespace}:${worldId}:`;
  const metaKey = (bookmark: string): string => `${base}bkmeta:${bookmark}`;
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  return {
    load: () => kv.get(`${base}db`),
    save: (bytes) => kv.set(`${base}db`, bytes),
    backups: {
      async put(info, bytes) {
        await kv.set(`${base}bk:${info.bookmark}`, bytes);
        await kv.set(metaKey(info.bookmark), enc.encode(JSON.stringify(info)));
      },
      get: (bookmark) => kv.get(`${base}bk:${bookmark}`),
      async list() {
        const out: BackupInfo[] = [];
        for (const key of await kv.keys(`${base}bkmeta:`)) {
          const raw = await kv.get(key);
          if (raw) out.push(JSON.parse(dec.decode(raw)) as BackupInfo);
        }
        return out;
      },
    },
  };
}
