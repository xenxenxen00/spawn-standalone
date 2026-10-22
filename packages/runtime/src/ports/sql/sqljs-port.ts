import type { Database, SqlJsConfig, SqlJsStatic, SqlValue as RawSqlValue } from 'sql.js';
import { countCompoundOperators, countParams, rewritePositional, scanSql, usesCaller } from './scan.ts';
import { createMemorySqlStore } from './stores.ts';
import {
  SQL_LIMITS,
  SqlError,
  type BackupInfo,
  type MigrateFn,
  type RestoreTarget,
  type SqlPort,
  type SqlRequest,
  type SqlResult,
  type SqlRow,
  type SqlStore,
  type SqlTag,
} from './types.ts';
import { buildTagged } from './verb.ts';

export type SqlJsLoader = () => Promise<SqlJsStatic>;

/**
 * Loads sql.js lazily and once. `locateFile` is the injectable wasm locator (a browser host points
 * it at the served .wasm; under node sql.js finds its own file).
 */
export function createSqlJsLoader(options: { locateFile?: (file: string) => string } = {}): SqlJsLoader {
  let loading: Promise<SqlJsStatic> | undefined;
  return () =>
    (loading ??= (async () => {
      const mod = (await import('sql.js')) as unknown as {
        default?: (c?: SqlJsConfig) => Promise<SqlJsStatic>;
      } & ((c?: SqlJsConfig) => Promise<SqlJsStatic>);
      const init = typeof mod.default === 'function' ? mod.default : mod;
      const config: SqlJsConfig = options.locateFile ? { locateFile: options.locateFile } : {};
      return init(config);
    })());
}

let sharedLoader: SqlJsLoader | undefined;
const defaultLoader: SqlJsLoader = () => (sharedLoader ??= createSqlJsLoader())();

export interface SqlJsPortOptions {
  /** One store per world id. Default: a fresh in-memory store per world. */
  store?: (worldId: string) => SqlStore;
  loadSqlJs?: SqlJsLoader;
  /** The game's scripts/db.js `migrate` export. */
  migrate?: MigrateFn;
  /** Migration runs once per distinct value per database; unset means on every open (it is idempotent). */
  specVersion?: string;
  /** Delay after a write before the store is saved. Default 250 ms. */
  saveDebounceMs?: number;
  now?: () => number;
  onMigrateError?: (worldId: string, error: unknown) => void;
  onSaveError?: (worldId: string, error: unknown) => void;
}

interface World {
  id: string;
  db: Database;
  store: SqlStore;
  dirty: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  saving: Promise<void>;
  queue: Promise<unknown>;
  memBackups: Map<string, { info: BackupInfo; bytes: Uint8Array }>;
}

const DDL = /\b(?:CREATE|DROP|ALTER|VACUUM|REINDEX)\b/i;
const META = '_spawn_migrations';

function toBindable(value: unknown): RawSqlValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new SqlError('bad_param', `cannot bind non-finite number ${value}`);
    return value;
  }
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'bigint') return Number.isSafeInteger(Number(value)) ? Number(value) : value.toString();
  if (value instanceof Uint8Array) return value;
  throw new SqlError('bad_param', `cannot bind a ${typeof value}; JSON.stringify a structure first`);
}

function wrap(error: unknown): SqlError {
  if (error instanceof SqlError) return error;
  return new SqlError('sql_error', error instanceof Error ? error.message : String(error));
}

export function createSqlJsPort(options: SqlJsPortOptions = {}): SqlPort {
  const load = options.loadSqlJs ?? defaultLoader;
  const storeFor = options.store ?? (() => createMemorySqlStore());
  const debounce = options.saveDebounceMs ?? 250;
  const now = options.now ?? Date.now;
  const worlds = new Map<string, Promise<World>>();
  let closed = false;
  let backupSeq = 0;

  const checkOpen = (): void => {
    if (closed) throw new SqlError('port_closed', 'the SQL port is closed');
  };

  // ---- executing statements ------------------------------------------------------------

  function totalChanges(db: Database): number {
    return Number(db.exec('SELECT total_changes()')[0]?.values[0]?.[0] ?? 0);
  }

  function execStatements(world: World, req: SqlRequest, transaction: boolean): SqlResult {
    const db = world.db;
    let text = req.sql;
    const binds: Record<string, RawSqlValue> = {};
    if (Array.isArray(req.params)) {
      const rewritten = rewritePositional(text);
      text = rewritten.sql;
      const list = req.params as readonly unknown[];
      if (list.length !== rewritten.count) {
        throw new SqlError('bad_param', `${rewritten.count} placeholders but ${list.length} values`);
      }
      list.forEach((v, i) => {
        binds[`@__p${i}`] = toBindable(v);
      });
    } else if (req.params) {
      for (const [key, v] of Object.entries(req.params as Record<string, unknown>)) {
        const bare = key.replace(/^[@:$]/, '');
        const value = toBindable(v);
        for (const prefix of ['@', ':', '$']) binds[prefix + bare] = value;
      }
    }
    if (usesCaller(text)) {
      if (req.caller === null || req.caller === undefined) {
        throw new SqlError(
          'statement_not_player_invocable',
          '@caller has no player here (db.js, a cron or a tool call): bind the player id as a value instead',
        );
      }
      binds['@caller'] = req.caller;
    }

    const before = totalChanges(db);
    const wrapTx = transaction && !/^\s*PRAGMA\b/i.test(text);
    if (wrapTx) db.run('BEGIN');
    let result: SqlResult = { rows: [], changes: 0, lastInsertRowid: 0 };
    try {
      let count = 0;
      for (const stmt of db.iterateStatements(text)) {
        count += 1;
        if (count > SQL_LIMITS.statementsPerCall) {
          throw new SqlError('too_many_statements', `more than ${SQL_LIMITS.statementsPerCall} statements in one call`);
        }
        const source = stmt.getSQL();
        if (countParams(source) > SQL_LIMITS.paramsPerStatement) {
          throw new SqlError('too_many_params', `more than ${SQL_LIMITS.paramsPerStatement} parameters in one statement`);
        }
        if (countCompoundOperators(source) >= SQL_LIMITS.compoundSelects) {
          throw new SqlError(
            'too_many_compound_selects',
            `more than ${SQL_LIMITS.compoundSelects} SELECTs joined in one statement`,
          );
        }
        const rows: SqlRow[] = [];
        const changesBefore = totalChanges(db);
        stmt.bind(binds);
        while (stmt.step()) rows.push(stmt.getAsObject() as SqlRow);
        const changes = totalChanges(db) - changesBefore;
        let lastInsertRowid = 0;
        if (changes > 0 && /^\s*(?:WITH|INSERT|REPLACE)\b/i.test(source)) {
          lastInsertRowid = Number(db.exec('SELECT last_insert_rowid()')[0]?.values[0]?.[0] ?? 0);
        }
        result = { rows, changes, lastInsertRowid };
      }
      if (wrapTx) db.run('COMMIT');
    } catch (error) {
      if (wrapTx) {
        try {
          db.run('ROLLBACK');
        } catch {
          // the engine already rolled back
        }
      }
      throw wrap(error);
    }
    if (totalChanges(db) !== before || scanSql(text).some((s) => s.code && DDL.test(s.text))) {
      markDirty(world);
    }
    return result;
  }

  // ---- persistence ---------------------------------------------------------------------

  function markDirty(world: World): void {
    world.dirty = true;
    if (world.timer !== undefined) return;
    world.timer = setTimeout(() => {
      world.timer = undefined;
      void persist(world).catch((e: unknown) => options.onSaveError?.(world.id, e));
    }, debounce);
    (world.timer as { unref?: () => void }).unref?.();
  }

  function persist(world: World): Promise<void> {
    if (world.timer !== undefined) {
      clearTimeout(world.timer);
      world.timer = undefined;
    }
    const attempt = world.saving.then(async () => {
      if (!world.dirty) return;
      world.dirty = false;
      try {
        await world.store.save(world.db.export());
      } catch (error) {
        world.dirty = true;
        throw error;
      }
    });
    world.saving = attempt.catch(() => undefined);
    return attempt;
  }

  // ---- opening a world, migrating --------------------------------------------------------

  function migrateTag(world: World, counter: { calls: number }): SqlTag {
    return (strings, ...values) => {
      counter.calls += 1;
      if (counter.calls > SQL_LIMITS.migrateCalls) {
        return Promise.reject(new SqlError('migrate_budget_exceeded', `migrate() made more than ${SQL_LIMITS.migrateCalls} calls`));
      }
      try {
        const q = buildTagged(strings, values);
        return Promise.resolve(execStatements(world, { worldId: world.id, sql: q.sql, params: q.params, caller: null }, false));
      } catch (error) {
        return Promise.reject(wrap(error));
      }
    };
  }

  async function runMigration(world: World): Promise<void> {
    const migrate = options.migrate;
    if (!migrate) return;
    const spec = options.specVersion;
    if (spec !== undefined) {
      world.db.run(`CREATE TABLE IF NOT EXISTS ${META} (spec_version TEXT PRIMARY KEY)`);
      const seen = world.db.exec(`SELECT 1 FROM ${META} WHERE spec_version = ?`, [spec]);
      if (seen.length > 0) return;
    }
    world.db.run('BEGIN');
    try {
      await migrate(migrateTag(world, { calls: 0 }));
      if (spec !== undefined) world.db.run(`INSERT OR IGNORE INTO ${META} VALUES (?)`, [spec]);
      world.db.run('COMMIT');
      markDirty(world);
    } catch (error) {
      try {
        world.db.run('ROLLBACK');
      } catch {
        // already rolled back
      }
      // a throw never blocks play: the prior schema serves
      options.onMigrateError?.(world.id, error);
    }
  }

  function openWorld(id: string): Promise<World> {
    let opened = worlds.get(id);
    if (!opened) {
      opened = (async () => {
        const sqljs = await load();
        const store = storeFor(id);
        const bytes = await store.load();
        const world: World = {
          id,
          db: new sqljs.Database(bytes ?? undefined),
          store,
          dirty: false,
          timer: undefined,
          saving: Promise.resolve(),
          queue: Promise.resolve(),
          memBackups: new Map(),
        };
        await runMigration(world);
        return world;
      })();
      worlds.set(id, opened);
      opened.catch(() => worlds.delete(id));
    }
    return opened;
  }

  /** Serialises every operation on one world so statements, restores and exports never interleave. */
  async function exclusive<T>(worldId: string, fn: (world: World, sqljs: SqlJsStatic) => Promise<T> | T): Promise<T> {
    checkOpen();
    const world = await openWorld(worldId);
    const sqljs = await load();
    const next = world.queue.then(() => {
      checkOpen();
      return fn(world, sqljs);
    });
    world.queue = next.catch(() => undefined);
    return next;
  }

  // ---- backups ---------------------------------------------------------------------------

  async function listBackups(world: World): Promise<BackupInfo[]> {
    const all = new Map<string, BackupInfo>();
    for (const b of await (world.store.backups?.list() ?? Promise.resolve([]))) all.set(b.bookmark, b);
    for (const { info } of world.memBackups.values()) all.set(info.bookmark, info);
    return [...all.values()];
  }

  function pickBackup(list: BackupInfo[], target: RestoreTarget): BackupInfo | undefined {
    const byNewest = [...list].sort((a, b) => b.ts - a.ts || b.bookmark.localeCompare(a.bookmark));
    if (typeof target === 'string') {
      return list.find((b) => b.bookmark === target) ?? byNewest.find((b) => b.label === target);
    }
    if (typeof target === 'number') return byNewest.find((b) => b.ts <= target);
    return byNewest.find(
      (b) => (target.label === undefined || b.label === target.label) && (target.ts === undefined || b.ts <= target.ts),
    );
  }

  return {
    run: (req) => exclusive(req.worldId, (world) => execStatements(world, req, true)),

    size: (worldId) => exclusive(worldId, (world) => world.db.export().length),

    backup: (worldId, label) =>
      exclusive(worldId, async (world) => {
        const ts = now();
        backupSeq += 1;
        const info: BackupInfo = { label, bookmark: `bk-${ts.toString(36)}-${backupSeq}`, ts };
        const bytes = world.db.export();
        if (world.store.backups) await world.store.backups.put(info, bytes);
        else world.memBackups.set(info.bookmark, { info, bytes });
        return info;
      }),

    restore: (worldId, target) =>
      exclusive(worldId, async (world, sqljs) => {
        const info = pickBackup(await listBackups(world), target);
        if (!info) {
          throw new SqlError('restore_target_not_found', `no backup matches ${JSON.stringify(target)}`);
        }
        const bytes = world.memBackups.get(info.bookmark)?.bytes ?? (await world.store.backups?.get(info.bookmark));
        if (!bytes) throw new SqlError('restore_target_not_found', `backup ${info.bookmark} has no bytes`);
        world.db.close();
        world.db = new sqljs.Database(bytes);
        markDirty(world);
        await runMigration(world);
        return { restoredTo: info.bookmark };
      }),

    async flush(worldId) {
      const ids = worldId === undefined ? [...worlds.keys()] : [worldId];
      for (const id of ids) {
        const opened = worlds.get(id);
        if (!opened) continue;
        const world = await opened;
        await world.queue;
        await persist(world);
      }
    },

    async close() {
      if (closed) return;
      const all = [...worlds.values()];
      const errors: unknown[] = [];
      for (const opened of all) {
        try {
          const world = await opened;
          await world.queue;
          await persist(world);
          world.db.close();
        } catch (e) {
          errors.push(e);
        }
      }
      closed = true;
      worlds.clear();
      if (errors.length > 0) throw errors[0];
    },
  };
}
