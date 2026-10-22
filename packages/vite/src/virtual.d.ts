// Types of the `virtual:ss/*` modules `spawnStandalone()` serves (game.ts, jobs.ts). A game references this file with
//   /// <reference types="@spawn-standalone/vite/virtual" />
// (or lists it in its tsconfig `types`). Payloads that belong to another domain stay `unknown` here and are narrowed by their
// consumer, as in the runtime's own virtual:pp declarations.

declare module 'virtual:ss/modules' {
  /** every carried registry module by tree path ('scripts/x.js', 'templates/y.js', 'places/p/sim.js'), loaded lazily */
  export const modules: Readonly<Record<string, () => Promise<Record<string, unknown>>>>;
}

declare module 'virtual:ss/content' {
  /** carried content scripts (lighting, look scripts: files that import `builtin/tsl`) by tree path, loaded lazily */
  export const content: Readonly<Record<string, () => Promise<Record<string, unknown>>>>;
}

declare module 'virtual:ss/world-config' {
  /** world.config.yaml as data */
  export const worldConfig: Readonly<Record<string, unknown>>;
}

declare module 'virtual:ss/world-files' {
  /** every carried file of the game tree, sorted */
  export const worldFiles: readonly string[];
}

declare module 'virtual:ss/preload-sets' {
  export const sets: Readonly<Record<string, readonly string[]>>;
}

declare module 'virtual:ss/places' {
  export interface SsPlaceBundle {
    readonly id: string;
    readonly config: Readonly<Record<string, unknown>>;
    readonly rows: readonly unknown[];
    readonly rawCells?: Readonly<Record<string, unknown>>;
    readonly sim?: () => Promise<Record<string, unknown>>;
  }
  /** the compiled config of every roster place */
  export const placeIndex: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  export const places: Readonly<Record<string, () => Promise<{ default: SsPlaceBundle }>>>;
}

declare module 'virtual:ss/place/*' {
  import type { SsPlaceBundle } from 'virtual:ss/places';
  const bundle: SsPlaceBundle;
  export default bundle;
}

declare module 'virtual:ss/anim' {
  export interface SsAnimFile {
    /** the authored anim yaml as data */
    readonly authored: unknown;
    /** the build-cooked clips (clip JSON), or null */
    readonly compiled: unknown;
  }
  export const anim: Readonly<Record<string, () => Promise<SsAnimFile>>>;
}

declare module 'virtual:ss/port-flags' {
  /** flags.json, flat keys */
  export const flags: Readonly<Record<string, unknown>>;
}

declare module 'virtual:ss/asset-index' {
  /** asset index v1 (assets/resolver.ts is the reader); an empty index when the game has none */
  const index: {
    readonly v: number;
    readonly build: string;
    readonly origin: string;
    readonly entries: Readonly<Record<string, unknown>>;
    readonly groups: Readonly<Record<string, unknown>>;
    readonly facts: Readonly<Record<string, unknown>>;
  };
  export default index;
}

declare module 'virtual:ss/vendor' {
  /** page-relative URLs of the vendored decoders */
  export const vendor: {
    readonly meshoptDecoder: string;
    readonly ktx2: { readonly transcoderPath: string; readonly jsTranscoder: string; readonly wasmTranscoder: string };
  };
}

declare module 'virtual:ss/jobs' {
  export const jobIds: readonly string[];
  /** what `createJobHost` takes as `resolveModule`: the id itself, or null */
  export function resolveJobModule(id: string): string | null;
  /** a module Worker running the job-runner protocol */
  export function createJobWorker(): Worker;
}

declare module 'virtual:ss/world' {
  import type { BootWorld } from '@spawn-standalone/runtime/boot';
  export const preloadSets: readonly string[];
  export function createWorld(): BootWorld;
}

declare module 'virtual:ss/shell' {
  export * from '@spawn-standalone/runtime/shell';
}
