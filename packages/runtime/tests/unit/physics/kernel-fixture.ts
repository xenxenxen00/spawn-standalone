// The real kernel (lifecycle, store, scheduler, place manager) on the Rapier-backed physics port (WP PH3): the lifecycle
// world of tests/unit/core/fakes with a compiled roster whose places carry real collider packs. The port gets the kernel's
// store through `attachKernel`, exactly as the app shell wires it.
import { emptyPlaceBake } from '../../../src/compat/core/null-ports.ts';
import type { ColliderPack, PlaceBake } from '../../../src/compat/core/ports.ts';
import type { CompiledPlace, CompiledPlaceIndex, PlaceBundle, RowRec, Vec3 } from '../../../src/compat/core/types.ts';
import { PhysicsPortImpl, type PhysicsPortOptions } from '../../../src/compat/physics/port.ts';
import { compiledPlace, makeWorld, type MiniCtx, type Module, type World } from '../core/fakes/lifecycle-world.ts';
import { packOf, type Part } from './rapier-fixtures.ts';

export type { MiniCtx };

export interface KernelPlace {
  /** collider parts (rapier-fixtures `Part`: half extents, centred) */
  parts?: Part[];
  /** or a whole pack */
  pack?: ColliderPack;
  config?: Partial<CompiledPlace>;
  rows?: Array<{ id: string; spec: Record<string, unknown> }>;
}

export interface KernelWorldOptions {
  places: Record<string, KernelPlace>;
  modules?: Record<string, Module>;
  /** the human's template (default: the live body spec of game/templates/player.js, without its behaviours) */
  player?: Record<string, unknown>;
  port?: PhysicsPortOptions;
}

export interface KernelWorld extends World {
  readonly port: PhysicsPortImpl;
  readonly bakes: Map<string, PlaceBake>;
  /** `player/local` in `place` */
  human(place: string, at?: Vec3): RowRec;
  /** sim-side load + activate */
  enter(place: string): Promise<void>;
  dispose(): void;
}

/** game/templates/player.js:20-27 */
export const LIVE_PLAYER_PHYSICS = {
  body: 'character',
  capsule: { height: 1.9, radius: 0.35 },
  autostep: { maxHeight: 0.4, minWidth: 0.2 },
  maxSlopeClimbAngle: 52,
  minSlopeSlideAngle: 62,
  snapToGroundDistance: 0.3,
};

const behaviorsOf = (spec: Record<string, unknown>): string[] => {
  const b = spec['behavior'];
  return typeof b === 'string' ? [b] : Array.isArray(b) ? b.filter((x): x is string => typeof x === 'string') : [];
};

export async function kernelWorld(o: KernelWorldOptions): Promise<KernelWorld> {
  const port = new PhysicsPortImpl(o.port ?? {});
  const bakes = new Map<string, PlaceBake>();
  const index: Record<string, CompiledPlace> = {};
  const loaders: Record<string, () => Promise<PlaceBundle>> = {};
  const sets: Record<string, string[]> = {};
  const lazy = new Set<string>();
  const modules: Record<string, Module> = {
    'templates/player.js': { player: o.player ?? { tags: ['player', 'teammate'], physics: LIVE_PLAYER_PHYSICS } },
    ...(o.modules ?? {}),
  };
  for (const [id, fx] of Object.entries(o.places)) {
    const rows = (fx.rows ?? []).map((r) => ({ id: r.id, cell: 'x0z0', spec: r.spec }));
    const config = compiledPlace(id, { rows: rows.length, cells: ['x0z0'], ...(fx.config ?? {}) });
    index[id] = config;
    const set = [...new Set(rows.flatMap((r) => behaviorsOf(r.spec)))];
    sets[`place:${id}`] = set;
    for (const p of set) lazy.add(p);
    loaders[id] = async () => ({ id, config, rows });
    const bake = emptyPlaceBake(id);
    bake.colliders = fx.pack ?? packOf(id, fx.parts ?? []);
    bakes.set(id, bake);
  }
  const placeIndex: CompiledPlaceIndex = { placeIndex: index, places: loaders };
  const assets = { get: () => undefined, placeBake: (place: string): Promise<PlaceBake> => Promise.resolve(bakes.get(place) ?? emptyPlaceBake(place)) };
  const w = makeWorld({ modules, lazy: [...lazy], placeIndex, sets, placeManager: true, ports: { physics: port, assets } });
  port.attachKernel(w.k);
  w.k.places.setLog({ warn: () => undefined, error: () => undefined });
  await w.k.registry.ensure('boot');
  return {
    ...w,
    port,
    bakes,
    human(place, at) {
      const id = w.k.spawnHuman({ place, ...(at ? { at } : {}), userId: 'u1', displayName: 'Operator', durableState: {} });
      return w.k.store.get(id)!;
    },
    async enter(place) {
      await w.k.places.load(place);
      w.k.places.activate(place);
    },
    dispose: () => port.dispose(),
  };
}
