// The only value import of `@dimforge/rapier3d-simd-compat` (D-MPN-10, X-01): a dynamic `import()` (the lazy `physics-rapier`
// chunk in the browser, a plain module load in Node and vitest) followed by `init()`, which decodes and instantiates the wasm
// embedded in the package. No wasm plugin, no `locateFile`, no vendor copy. Memoised: every caller shares one promise.
//
// Everything else in the port takes Rapier as a type (`import type`) and reads its classes and enums from the namespace this
// module hands out. Until `loadRapier()` has resolved there is no namespace: `rapierIfLoaded()` is null, `rapier()` throws,
// and a place's physics stays unbuilt (X-32).

export type Rapier = typeof import('@dimforge/rapier3d-simd-compat');

export interface RapierLoader {
  /** starts the load on the first call; later and concurrent calls get the same promise */
  load(): Promise<Rapier>;
  /** the initialised namespace, or null while it is not there yet */
  current(): Rapier | null;
}

/** a loader over any importer (the tests count calls through it); a failed load is forgotten so the next call retries */
export function createRapierLoader(importer: () => Promise<Rapier>): RapierLoader {
  let ready: Rapier | null = null;
  let pending: Promise<Rapier> | null = null;
  return {
    load(): Promise<Rapier> {
      pending ??= (async (): Promise<Rapier> => {
        try {
          const mod = await importer();
          await mod.init();
          ready = mod;
          return mod;
        } catch (err) {
          pending = null;
          throw err;
        }
      })();
      return pending;
    },
    current: () => ready,
  };
}

const shared = createRapierLoader(() => import('@dimforge/rapier3d-simd-compat'));

/** import + `init()` once per realm */
export const loadRapier = (): Promise<Rapier> => shared.load();

export const rapierIfLoaded = (): Rapier | null => shared.current();

/** the namespace for code that runs only after the load (world builds, the step); throws before it */
export function rapier(): Rapier {
  const r = shared.current();
  if (!r) throw new Error('physics: Rapier is not loaded yet (await loadRapier() / ensurePhysics() first)');
  return r;
}
