// SQL stores that follow the host platform: a game builds its port with `createSqlJsPort({ store: stores.factory })`, hands the
// same `stores` to composeGame (`ports.sqlStores`), and composeGame binds them once the platform exists. A Playgama build then
// saves through the platform's save API; a web build gets the browser store, imported only when it is needed, so the Playgama
// bundle carries no localStorage / indexedDB reference (the `__SS_PLATFORM__` define makes that import dead code there).
import { createPlatformSqlStore, platformSqlKeys, type PlatformSqlSave, type PlatformSqlStoreOptions } from './platform-store.ts';
import type { SqlStore } from './types.ts';

export interface HostSqlStoresOptions extends PlatformSqlStoreOptions {
  /** the browser store's own namespace, when it must differ; default the same `namespace` */
  browserNamespace?: string;
}

export interface HostSqlStores {
  /** `createSqlJsPort({ store })`: one store per world, usable before `bind` (its calls wait for it) */
  factory(worldId: string): SqlStore;
  /** the platform save keys the world needs read at platform init */
  keysFor(worldId: string): string[];
  /** called by composeGame once the platform exists: a platform save, or null for the browser store */
  bind(save: PlatformSqlSave | null): void;
  /** writes every pending platform save now */
  flush(): Promise<void>;
}

declare const __SS_PLATFORM__: 'playgama' | 'web' | undefined;
const PLAYGAMA_BUILD = typeof __SS_PLATFORM__ !== 'undefined' && __SS_PLATFORM__ === 'playgama';

type Opened = SqlStore & { flush?(): Promise<void> };

export function createHostSqlStores(options: HostSqlStoresOptions = {}): HostSqlStores {
  let bindNow!: (s: PlatformSqlSave | null) => void;
  const bound = new Promise<PlatformSqlSave | null>((r) => (bindNow = r));
  const made = new Map<string, Promise<Opened>>();

  const open = (worldId: string): Promise<Opened> => {
    let p = made.get(worldId);
    if (!p) {
      p = (async (): Promise<Opened> => {
        const save = await bound;
        if (save) return createPlatformSqlStore(save, worldId, options);
        if (PLAYGAMA_BUILD) throw new Error('no platform save to keep the SQL database in');
        const { createBrowserSqlStoreFactory } = await import('./stores-browser.ts');
        return createBrowserSqlStoreFactory(globalThis as never, options.browserNamespace ?? options.namespace)(worldId);
      })();
      made.set(worldId, p);
    }
    return p;
  };

  return {
    factory: (worldId) => ({
      load: async () => (await open(worldId)).load(),
      save: async (bytes) => (await open(worldId)).save(bytes),
      backups: {
        put: async (info, bytes) => (await open(worldId)).backups?.put(info, bytes),
        get: async (bookmark) => (await open(worldId)).backups?.get(bookmark) ?? null,
        list: async () => (await open(worldId)).backups?.list() ?? [],
      },
    }),
    keysFor: (worldId) => platformSqlKeys(worldId, options.namespace),
    bind: (save) => bindNow(save),
    async flush() {
      for (const p of made.values()) await (await p).flush?.();
    },
  };
}
