// Adapters from the ports to the kernel extensions (compat/core/ext.ts): `ctx.sql`, `ctx.job` / `ctx.awaitJob`.
// compat/core takes structural extension objects and imports no port; these functions build them.
import type { JobExtension, SqlExtension } from '../../compat/core/ext.ts';
import { bindJobVerb } from '../jobs/verb.ts';
import { bindSqlVerb, type SqlVerb } from '../sql/verb.ts';
import type { JobPort, JobResult } from '../jobs/types.ts';
import type { SqlPort, SqlResult, SqlTag } from '../sql/types.ts';

/** the part of the module registry the migration needs */
export interface MigrationRegistry {
  get(path: string): Record<string, unknown> | undefined;
  knows(path: string): boolean;
  load(path: string): Promise<Record<string, unknown>>;
}

export interface SqlExtensionOptions {
  port: SqlPort;
  /** the database id inside the port (one per game); default "local" */
  worldId?: string;
  /** `@caller` for a player body's behavior when the row has no player record; default none */
  localUserId?: () => string | null;
  /** the tree path of the game's migration module; default `scripts/db.js` */
  migratePath?: string;
}

/** `migrate(sql)` runs once per boot before the first statement, at most 1000 calls (platform-systems.md) */
const MIGRATE_CALL_BUDGET = 1000;

export function createSqlExtension(o: SqlExtensionOptions): SqlExtension {
  const worldId = o.worldId ?? 'local';
  const verbs = new Map<string | null, SqlVerb>();
  const ext: SqlExtension = {
    verb(caller) {
      let v = verbs.get(caller);
      if (!v) {
        v = bindSqlVerb({ port: o.port, worldId, caller });
        verbs.set(caller, v);
      }
      return v;
    },
    async prepare(registry: MigrationRegistry | object) {
      const reg = registry as MigrationRegistry;
      const path = o.migratePath ?? 'scripts/db.js';
      let ns = reg.get(path);
      if (ns === undefined && reg.knows(path)) ns = await reg.load(path);
      const migrate = ns?.['migrate'];
      if (typeof migrate !== 'function') return;
      // no `@caller` here: a caller-less statement, like the platform's db.js context
      const tag: SqlTag = (() => {
        let calls = 0;
        return (strings, ...values) => {
          if (++calls > MIGRATE_CALL_BUDGET) return Promise.reject(new Error(`migrate() made more than ${MIGRATE_CALL_BUDGET} calls`));
          return bindSqlVerb({ port: o.port, worldId, caller: null })(strings, ...values) as Promise<SqlResult>;
        };
      })();
      try {
        await (migrate as (sql: SqlTag) => unknown)(tag);
      } catch (err) {
        // a throw never blocks play: the prior schema serves
        console.error('[sql] scripts/db.js migrate failed', err);
      }
    },
  };
  if (o.localUserId) ext.localUserId = o.localUserId;
  return ext;
}

export function createJobExtension(o: { port: JobPort }): JobExtension {
  const port = o.port;
  return {
    ...(typeof port.init === 'function' ? { init: () => port.init!() } : {}),
    bind(dispatchHook) {
      return bindJobVerb({ port: o.port, dispatchHook: (hook: string, result: JobResult, payload: unknown) => dispatchHook(hook, result, payload) });
    },
  };
}
