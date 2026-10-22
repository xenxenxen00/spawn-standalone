// The place roster and what the kernel keeps per place (docs/design/core-runtime.md §11.1, §11.3, §5.5, §5.7; WP C4).
//
// The roster is the compiled index (`virtual:ss/places` placeIndex): the 19 ready maps and `training`. A kernel built without a
// roster (unit tests of other packages) manages no places: it knows every place id, as lifecycle.ts accepts any place there.
//
// Per place two records exist:
// - PlaceRuntime (`ctx.place.state`, the atmosphere LayeredValue over the config, the place sim): created on first use, kept
//   for the life of the page, so `power.k` and an atmosphere write survive an unload and a reload of the place (core §5.7).
// - PlaceEntry: the load state of the scene (none / loading / loaded), the bake the place was built from, whether the ports hold
//   its physics and render resources, and the render build. It is reset by an unload.
//
// `spawnPoint(p)` is the config's `defaultSpawnPoint` with y resolved: a point without y stands on the ground the physics port
// reports and at 0 while nothing is built under it (X-32: queries on an unbuilt place answer null). `bottom(p)` is the config's
// `worldBounds.bottom`, else 64 m under the spawn point (contract §10.3).
import type { PlaceBake } from '../ports.ts';
import { ENGINE } from '../rules.ts';
import { LayeredValueImpl } from '../store/layers.ts';
import { resolvePositionSpec } from '../store/transform.ts';
import type { CompiledPlace, CompiledPlaceIndex, PlaceId, PlaceRuntime, RowId, SimInstance, Vec3 } from '../types.ts';

const NO_ATMOSPHERE: Readonly<Record<string, unknown>> = Object.freeze({});

/** core §11.3: survives unload */
export class PlaceRuntimeImpl implements PlaceRuntime {
  readonly id: PlaceId;
  /** ctx.place.state: room life */
  readonly state: Record<string, unknown> = {};
  /** the place's own layer over the config's atmosphere (core §5.5) */
  readonly atmosphere: LayeredValueImpl;
  /** `sim:<place>`, bound at the place's first load and kept (its listeners and timers are its own) */
  sim: SimInstance | null = null;

  constructor(id: PlaceId, config: CompiledPlace | null) {
    this.id = id;
    this.atmosphere = new LayeredValueImpl(() => config?.atmosphere ?? NO_ATMOSPHERE);
  }
}

/** one sim-side load in flight */
export interface PlaceLoad {
  promise: Promise<void>;
  /** the last progress reported, 0..1 (−1 before the first report) */
  progress: number;
  readonly listeners: Array<(f: number) => void>;
  /** the place was unloaded while it loaded: the load ends as a failure */
  cancelled: boolean;
}

export interface PlaceEntry {
  readonly id: PlaceId;
  readonly config: CompiledPlace;
  /** the scene rows: not spawned, being loaded, spawned */
  scene: 'none' | 'loading' | 'loaded';
  load: PlaceLoad | null;
  /** the bake the place was built from, kept while its scene stands (a dormant place is rebuilt from it) */
  bake: PlaceBake | null;
  /** the ports hold the place's physics and render resources (false again while the place is dormant) */
  portsBuilt: boolean;
  /** the render build finished (X-05) */
  built: boolean;
  /** the render build in flight or done; rejects with the scene port's error */
  build: Promise<void> | null;
  buildFailed: boolean;
  /** bumped whenever a build is started or dropped, so a superseded build's settlement is ignored */
  buildGen: number;
  buildProgress: number;
  /** scene rows of the last load the kernel refused to spawn */
  refused: Array<{ id: RowId; error: string }>;
}

export class PlaceRegistry {
  readonly #index: CompiledPlaceIndex;
  readonly #ground: (place: PlaceId, x: number, z: number) => number | null;
  readonly #entries = new Map<PlaceId, PlaceEntry>();
  readonly #runtimes = new Map<PlaceId, PlaceRuntimeImpl>();
  /** the roster, in index order */
  readonly roster: readonly PlaceId[];
  /** false for a kernel built without a roster: no place is managed, every place id is accepted */
  readonly managed: boolean;

  constructor(index: CompiledPlaceIndex, ground: (place: PlaceId, x: number, z: number) => number | null) {
    this.#index = index;
    this.#ground = ground;
    this.roster = Object.freeze(Object.keys(index.placeIndex));
    this.managed = this.roster.length > 0;
  }

  /** a roster place (any place when there is no roster) */
  has(p: PlaceId): boolean {
    return !this.managed || Object.hasOwn(this.#index.placeIndex, p);
  }

  config(p: PlaceId): CompiledPlace | null {
    return Object.hasOwn(this.#index.placeIndex, p) ? this.#index.placeIndex[p]! : null;
  }

  /** the chunk loader of a roster place */
  loader(p: PlaceId): (() => Promise<unknown>) | null {
    const f = Object.hasOwn(this.#index.places, p) ? this.#index.places[p] : undefined;
    return typeof f === 'function' ? f : null;
  }

  /** the entry of a place, if it was ever touched */
  peek(p: PlaceId): PlaceEntry | undefined {
    return this.#entries.get(p);
  }

  /** the entry of a roster place (created on first use); null for a place outside the roster */
  entry(p: PlaceId): PlaceEntry | null {
    const hit = this.#entries.get(p);
    if (hit) return hit;
    const config = this.config(p);
    if (!config) return null;
    const e: PlaceEntry = {
      id: p,
      config,
      scene: 'none',
      load: null,
      bake: null,
      portsBuilt: false,
      built: false,
      build: null,
      buildFailed: false,
      buildGen: 0,
      buildProgress: 0,
      refused: [],
    };
    this.#entries.set(p, e);
    return e;
  }

  /** core §11.3: created lazily, never dropped */
  runtime(p: PlaceId): PlaceRuntimeImpl {
    let rt = this.#runtimes.get(p);
    if (!rt) {
      rt = new PlaceRuntimeImpl(p, this.config(p));
      this.#runtimes.set(p, rt);
    }
    return rt;
  }

  /** every runtime created so far */
  runtimes(): IterableIterator<PlaceRuntimeImpl> {
    return this.#runtimes.values();
  }

  /** `defaultSpawnPoint` with y resolved; a fresh object ({0,0,0} for a place without a config) */
  spawnPoint(p: PlaceId): Vec3 {
    const config = this.config(p);
    if (!config) return { x: 0, y: 0, z: 0 };
    return resolvePositionSpec(config.defaultSpawnPoint, (x, z) => this.#ground(p, x, z)) ?? { x: 0, y: 0, z: 0 };
  }

  /** `worldBounds.bottom`, else 64 m under the spawn point */
  bottom(p: PlaceId): number {
    const own = this.config(p)?.worldBounds.bottom;
    return typeof own === 'number' ? own : this.spawnPoint(p).y - ENGINE.OOB_DEFAULT_DEPTH_M;
  }
}
