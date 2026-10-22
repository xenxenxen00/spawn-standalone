// A SqlStore over the host platform's save API (Platform.save: a synchronous string store with an async flush). On Playgama that
// is bridge.storage, the only save route the platform allows, so this module names no browser storage. One world is two keys:
// `<ns>:<world>:db` holds the database bytes (base64) and `<ns>:<world>:bk` one JSON document holding the newest backups. The
// platform's store reads its keys once at init, so the host asks `platformSqlKeys` for the names before the platform is made.
import { base64ToBytes, bytesToBase64 } from './stores.ts';
import type { BackupInfo, SqlStore } from './types.ts';

/** the part of the platform's SaveStore this store uses */
export interface PlatformSqlSave {
  readonly ready?: Promise<void>;
  get(key: string): string | null;
  set(key: string, value: string): void;
  flush?(): Promise<void>;
}

export interface PlatformSqlStoreOptions {
  /** key prefix; default `spawn-sql` */
  namespace?: string;
  /** a burst of saves becomes one platform write this long after the last one; default 2000 ms */
  debounceMs?: number;
  /** warn (again each time it doubles) when the encoded database passes this many characters; default 262144 */
  warnChars?: number;
  /** refuse a save whose encoded database passes this many characters (the save rejects, the old bytes stay); default none */
  maxChars?: number;
  /** backups kept; the oldest go first; default 3 */
  maxBackups?: number;
  /** encoded characters all kept backups may hold together (the newest is always kept); default 1048576 */
  backupBudgetChars?: number;
  warn?: (message: string) => void;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export interface PlatformSqlStore extends SqlStore {
  backups: NonNullable<SqlStore['backups']>;
  /** writes the pending save to the platform now and waits for its flush */
  flush(): Promise<void>;
}

const DEFAULT_NS = 'spawn-sql';

/** the platform save keys one world uses (hand them to the platform as keys to read at init) */
export function platformSqlKeys(worldId: string, namespace = DEFAULT_NS): string[] {
  return [`${namespace}:${worldId}:db`, `${namespace}:${worldId}:bk`];
}

interface BackupDoc {
  v: 1;
  items: Array<{ info: BackupInfo; b64: string }>;
}

export function createPlatformSqlStore(save: PlatformSqlSave, worldId: string, options: PlatformSqlStoreOptions = {}): PlatformSqlStore {
  const [dbKey, bkKey] = platformSqlKeys(worldId, options.namespace) as [string, string];
  const debounceMs = options.debounceMs ?? 2000;
  const warnChars = options.warnChars ?? 262_144;
  const maxBackups = options.maxBackups ?? 3;
  const budget = options.backupBudgetChars ?? 1_048_576;
  const warn = options.warn ?? ((m: string): void => console.warn(m));
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
  let pending: Uint8Array | null = null;
  let timer: unknown;
  let warnAt = warnChars;

  const ready = async (): Promise<void> => void (await save.ready);

  const writePending = (): void => {
    if (timer !== undefined) clearTimer(timer);
    timer = undefined;
    if (pending === null) return;
    const bytes = pending;
    pending = null;
    const text = bytesToBase64(bytes);
    if (text.length > warnAt) {
      while (text.length > warnAt) warnAt *= 2;
      warn(`[sql] the saved database is ${text.length} characters encoded; platform storage is small, keep it lean`);
    }
    save.set(dbKey, text);
  };

  const readDoc = (): BackupDoc => {
    const raw = save.get(bkKey);
    if (raw === null || raw === '') return { v: 1, items: [] };
    try {
      const doc = JSON.parse(raw) as Partial<BackupDoc>;
      return doc.v === 1 && Array.isArray(doc.items) ? (doc as BackupDoc) : { v: 1, items: [] };
    } catch {
      warn('[sql] the stored backups are unreadable and were dropped');
      return { v: 1, items: [] };
    }
  };

  return {
    async load() {
      await ready();
      const raw = save.get(dbKey);
      if (raw === null || raw === '') return null;
      try {
        return base64ToBytes(raw);
      } catch {
        warn('[sql] the stored database is not valid base64; starting empty');
        return null;
      }
    },
    async save(bytes) {
      await ready();
      if (options.maxChars !== undefined) {
        const chars = Math.ceil(bytes.length / 3) * 4;
        if (chars > options.maxChars) throw new Error(`the database is ${chars} characters encoded, over the ${options.maxChars} limit`);
      }
      pending = bytes.slice();
      if (timer !== undefined) clearTimer(timer);
      timer = setTimer(writePending, debounceMs);
    },
    async flush() {
      await ready();
      writePending();
      await save.flush?.();
    },
    backups: {
      async put(info, bytes) {
        await ready();
        const items = readDoc().items.filter((i) => i.info.bookmark !== info.bookmark);
        items.push({ info, b64: bytesToBase64(bytes) });
        while (items.length > Math.max(1, maxBackups)) items.shift();
        while (items.length > 1 && items.reduce((n, i) => n + i.b64.length, 0) > budget) items.shift();
        save.set(bkKey, JSON.stringify({ v: 1, items } satisfies BackupDoc));
      },
      async get(bookmark) {
        await ready();
        const hit = readDoc().items.find((i) => i.info.bookmark === bookmark);
        return hit ? base64ToBytes(hit.b64) : null;
      },
      async list() {
        await ready();
        return readDoc().items.map((i) => i.info);
      },
    },
  };
}
