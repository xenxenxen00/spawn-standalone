// The browser SQL store: IndexedDB with a localStorage (base64) fallback. Kept apart from stores.ts so a build that saves through
// a platform (Playgama) can leave this module out: it is the only SQL module that names localStorage / indexedDB.
import { base64ToBytes, bytesToBase64, kvSqlStore, type ByteKv } from './stores.ts';
import type { SqlStore } from './types.ts';

export function localStorageKv(storage: Pick<Storage, 'getItem' | 'setItem' | 'key' | 'length'>): ByteKv {
  return {
    get(key) {
      const v = storage.getItem(key);
      return Promise.resolve(v === null ? null : base64ToBytes(v));
    },
    set(key, bytes) {
      storage.setItem(key, bytesToBase64(bytes));
      return Promise.resolve();
    },
    keys(prefix) {
      const out: string[] = [];
      for (let i = 0; i < storage.length; i += 1) {
        const k = storage.key(i);
        if (k !== null && k.startsWith(prefix)) out.push(k);
      }
      return Promise.resolve(out);
    },
  };
}

function idbRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('indexedDB request failed'));
  });
}

export function indexedDbKv(factory: IDBFactory, dbName = 'spawn-standalone-sql'): ByteKv {
  const STORE = 'bytes';
  let opened: Promise<IDBDatabase> | undefined;
  const open = (): Promise<IDBDatabase> =>
    (opened ??= new Promise((resolve, reject) => {
      const req = factory.open(dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('indexedDB open failed'));
    }));
  const objectStore = async (mode: IDBTransactionMode): Promise<IDBObjectStore> =>
    (await open()).transaction(STORE, mode).objectStore(STORE);
  return {
    async get(key) {
      const v: unknown = await idbRequest((await objectStore('readonly')).get(key));
      return v instanceof Uint8Array ? v : null;
    },
    async set(key, bytes) {
      await idbRequest((await objectStore('readwrite')).put(bytes, key));
    },
    async keys(prefix) {
      const all = await idbRequest((await objectStore('readonly')).getAllKeys());
      return all.filter((k): k is string => typeof k === 'string' && k.startsWith(prefix));
    },
  };
}

/**
 * The browser store: IndexedDB when the page has it, else localStorage (base64). Simple and
 * typed; not unit-tested under node (the KV wrappers it composes are).
 */
export function createBrowserSqlStoreFactory(
  env: { indexedDB?: IDBFactory; localStorage?: Storage } = globalThis as { indexedDB?: IDBFactory; localStorage?: Storage },
  namespace = 'spawn-sql',
): (worldId: string) => SqlStore {
  let kv: ByteKv | undefined;
  if (env.indexedDB) kv = indexedDbKv(env.indexedDB);
  else if (env.localStorage) kv = localStorageKv(env.localStorage);
  if (!kv) throw new Error('no IndexedDB or localStorage available for the SQL store');
  const chosen = kv;
  return (worldId) => kvSqlStore(chosen, worldId, namespace);
}
