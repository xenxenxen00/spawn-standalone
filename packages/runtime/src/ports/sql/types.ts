// SqlPort: the host-side database behind the game-facing `ctx.sql` verb.
//
// Documented ctx.sql behaviour this port implements (engine 6.0.0 platform-systems.md; the older
// build documents the same call without size/backup/restore):
//   ctx.sql`SELECT ... ${v}`  -> Promise<{ rows, changes, lastInsertRowid }>   (always async)
//   ${v} binds string | number | boolean | null (booleans store as 1/0); `@caller` is the calling player's id
//   semicolons = ordered statements in one transaction; rows [] = none, changes 0 = a guarded write refused
//   errors reject the promise (the game catches them or they land in its log)
//   budgets: <= 64 statements per call, <= 100 parameters per statement, <= 5 SELECTs joined by a compound operator
//   ctx.sql.size() / .backup(label) / .restore(target) (6.0.0 only)
//   scripts/db.js `export async function migrate(sql)` runs before the first statement, <= 1000 calls
//
// ABSENT (no host equivalent in a local standalone): `statement_not_published` (the platform's
// check that a hook's statements were published with the save), the dev/live database split, and
// platform point-in-time restore (only explicit backups can be restored).

export type SqlValue = string | number | boolean | null;
export type SqlRow = Record<string, unknown>;

export interface SqlResult {
  rows: SqlRow[];
  /** Rows changed by the last statement of the call (0 for a statement that only reads). */
  changes: number;
  /** Row id of the last INSERT/REPLACE of the call's last statement (0 when none). */
  lastInsertRowid: number;
}

export type SqlErrorCode =
  | 'statement_not_player_invocable'
  | 'too_many_statements'
  | 'too_many_params'
  | 'too_many_compound_selects'
  | 'bad_param'
  | 'sql_error'
  | 'restore_target_not_found'
  | 'migrate_budget_exceeded'
  | 'port_closed';

export class SqlError extends Error {
  readonly code: SqlErrorCode;
  constructor(code: SqlErrorCode, message: string) {
    super(message);
    this.name = 'SqlError';
    this.code = code;
  }
}

export interface SqlRequest {
  worldId: string;
  /** SQL text; `@name` / `:name` / `$name` named parameters and bare `?` positional ones. */
  sql: string;
  /** Positional (`?`, in order) or named (keys with or without their `@`/`:`/`$` prefix). */
  params?: readonly SqlValue[] | Readonly<Record<string, SqlValue>>;
  /** The player id `@caller` binds to; null/undefined means a caller-less context (db.js, cron). */
  caller?: string | null;
}

export interface BackupInfo {
  label: string;
  bookmark: string;
  ts: number;
}

export type RestoreTarget = string | number | { label?: string; ts?: number };

export interface SqlPort {
  run(request: SqlRequest): Promise<SqlResult>;
  /** Size of the world's database in bytes. */
  size(worldId: string): Promise<number>;
  backup(worldId: string, label: string): Promise<BackupInfo>;
  restore(worldId: string, target: RestoreTarget): Promise<{ restoredTo: string }>;
  /** Writes any debounced save now. Resolves when the store has the bytes. */
  flush(worldId?: string): Promise<void>;
  /** Flushes, then frees every database. The port rejects every later call. */
  close(): Promise<void>;
}

/** Durable bytes for ONE world's database. */
export interface SqlStore {
  load(): Promise<Uint8Array | null>;
  save(bytes: Uint8Array): Promise<void>;
  /** Optional backup snapshots; a store without them keeps backups in memory only. */
  backups?: SqlBackupStore;
}

export interface SqlBackupStore {
  put(info: BackupInfo, bytes: Uint8Array): Promise<void>;
  get(bookmark: string): Promise<Uint8Array | null>;
  list(): Promise<BackupInfo[]>;
}

/** The `sql` tag handed to db.js `migrate`: like ctx.sql but with no `@caller`. */
export type SqlTag = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<SqlResult>;
export type MigrateFn = (sql: SqlTag) => Promise<void> | void;

export const SQL_LIMITS = {
  statementsPerCall: 64,
  paramsPerStatement: 100,
  compoundSelects: 5,
  migrateCalls: 1000,
} as const;
