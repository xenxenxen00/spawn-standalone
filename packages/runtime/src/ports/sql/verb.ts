import { SqlError, type BackupInfo, type RestoreTarget, type SqlPort, type SqlResult, type SqlValue } from './types.ts';

/** Joins a tagged template into SQL with `@__pN` named parameters and the matching value map. */
export function buildTagged(
  strings: TemplateStringsArray | readonly string[],
  values: readonly unknown[],
): { sql: string; params: Record<string, SqlValue> } {
  let sql = strings[0] ?? '';
  const params: Record<string, SqlValue> = {};
  values.forEach((v, i) => {
    params[`__p${i}`] = v as SqlValue;
    sql += `@__p${i}${strings[i + 1] ?? ''}`;
  });
  return { sql, params };
}

/** The game-facing `ctx.sql`: a tag returning a Promise, plus size/backup/restore. */
export interface SqlVerb {
  (strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlResult>;
  size(): Promise<number>;
  backup(label: string): Promise<BackupInfo>;
  restore(target: RestoreTarget): Promise<{ restoredTo: string }>;
}

export interface BindSqlVerbOptions {
  port: SqlPort;
  worldId: string;
  /**
   * The player `@caller` binds to, read per call. Return null where the docs give none (db.js,
   * run_script, a multiplayer cron or place hook); the statement then rejects with
   * `statement_not_player_invocable`.
   */
  caller?: string | null | (() => string | null);
}

export function bindSqlVerb(options: BindSqlVerbOptions): SqlVerb {
  const { port, worldId } = options;
  const callerOf = (): string | null =>
    typeof options.caller === 'function' ? options.caller() : (options.caller ?? null);
  const verb = ((strings: TemplateStringsArray, ...values: unknown[]): Promise<SqlResult> => {
    if (!Array.isArray(strings) || !('raw' in strings)) {
      return Promise.reject(new SqlError('sql_error', 'ctx.sql is a template tag: ctx.sql`SELECT ... ${value}`'));
    }
    const q = buildTagged(strings, values);
    return port.run({ worldId, sql: q.sql, params: q.params, caller: callerOf() });
  }) as SqlVerb;
  verb.size = () => port.size(worldId);
  verb.backup = (label) => port.backup(worldId, label);
  verb.restore = (target) => port.restore(worldId, target);
  return verb;
}
