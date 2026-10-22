// The lifecycle world (lifecycle-world.ts) on the real place manager (WP C4): a compiled roster with one scene bundle per
// place, preload sets `place:<p>` over the injected module map, and spy ports that record what the manager asks of them: the
// bake fetch, the physics build and teleports, the render build (resolved at once, or by hand with `manualScene`).
import { createNullPhysicsPort, createNullScenePort, emptyPlaceBake } from '../../../../src/compat/core/null-ports.ts';
import type { PhysicsPort, PlaceBake, SceneSyncPort } from '../../../../src/compat/core/ports.ts';
import type { EngineRules } from '../../../../src/compat/core/rules.ts';
import type { PlaceManagerImpl } from '../../../../src/compat/core/places/manager.ts';
import type { CompiledPlace, CompiledPlaceIndex, PlaceBundle, Quat, RowId, RowRec, Vec3 } from '../../../../src/compat/core/types.ts';
import { compiledPlace, makeWorld, type Module, type World } from './lifecycle-world.ts';

export interface PlaceFixture {
  config?: Partial<CompiledPlace>;
  rows?: Array<{ id: string; cell?: string; spec: Record<string, unknown> }>;
  /** the module of places/<p>/sim.js */
  sim?: Module;
  rawCells?: Record<string, string>;
  /** the chunk loader answers a module namespace `{ default: bundle }` (asPlaceBundle still accepts it) */
  asModule?: boolean;
  /** the chunk loader answers `{ default: () => bundle }`, the factory tools/places/compile.ts emits (each call logs `factory <p>`) */
  asFactory?: boolean;
  /** extra members of the preload set `place:<p>` (the behaviours the rows name and the sim are added) */
  set?: string[];
}

export interface PlacesWorldOptions {
  places: Record<string, PlaceFixture>;
  /** behaviours and templates by tree path */
  modules?: Record<string, Module>;
  rules?: Partial<EngineRules>;
  defaultPlace?: string;
  /** the render build of a place resolves only when the test settles it (`scene.builds`) */
  manualScene?: boolean;
  /** the bake fetch of a place resolves only when the test settles it (`bakes.pending`) */
  manualBake?: boolean;
  /** PhysicsPort.groundY */
  ground?: (place: string, x: number, z: number) => number | null;
}

export interface SceneBuild {
  place: string;
  rows: RowId[];
  bake: PlaceBake;
  onProgress: (f: number) => void;
  resolve(): void;
  reject(e: unknown): void;
}

export interface PlacesWorld extends World {
  readonly pm: PlaceManagerImpl;
  /** port and loader calls in order: `chunk home`, `bake home`, `physics.buildPlace home`, `scene.buildPlace home`, … */
  readonly calls: string[];
  /** what the manager logged (`setLog`) */
  readonly logs: { warn: string[]; error: string[] };
  readonly scene: { builds: SceneBuild[] };
  readonly bakes: { made: Map<string, PlaceBake>; pending: Array<{ place: string; resolve(): void; reject(e: unknown): void }> };
  readonly physics: {
    builds: Array<{ place: string; bake: PlaceBake }>;
    positions: Array<{ id: RowId; p: Vec3; place: string | null }>;
    velocities: Array<{ id: RowId; v: Vec3 }>;
    angular: Array<{ id: RowId; w: Vec3 }>;
    holds: Array<{ id: RowId; y: number }>;
    rotations: Array<{ id: RowId; q: Quat }>;
  };
  /** `player/local` in `place` (the client-VM body with its player record) */
  human(place: string, at?: Vec3): RowRec;
  /** KernelEvents heard: `placeLoading home 0.3`, `placeActive next home`, `placeBuilt home` */
  readonly events: string[];
}

export const PLAYER_TEMPLATE = { tags: ['player', 'teammate'], physics: { body: 'character' } };

const behaviorsOf = (spec: Record<string, unknown>): string[] => {
  const b = spec['behavior'];
  return typeof b === 'string' ? [b] : Array.isArray(b) ? b.filter((x): x is string => typeof x === 'string') : [];
};

export function makePlacesWorld(o: PlacesWorldOptions): PlacesWorld {
  const calls: string[] = [];
  const modules: Record<string, Module> = { 'templates/player.js': { player: PLAYER_TEMPLATE }, ...(o.modules ?? {}) };
  const index: Record<string, CompiledPlace> = {};
  const loaders: Record<string, () => Promise<PlaceBundle>> = {};
  const sets: Record<string, string[]> = {};
  const lazy = new Set<string>();
  for (const [id, fx] of Object.entries(o.places)) {
    const rows = (fx.rows ?? []).map((r) => ({ id: r.id, cell: r.cell ?? 'x0z0', spec: r.spec }));
    const simPath = `places/${id}/sim.js`;
    if (fx.sim) modules[simPath] = fx.sim;
    const config = compiledPlace(id, { rows: rows.length, cells: [...new Set(rows.map((r) => r.cell))], sim: fx.sim ? simPath : null, ...(fx.config ?? {}) });
    index[id] = config;
    const set = [...new Set([...rows.flatMap((r) => behaviorsOf(r.spec)), ...(fx.sim ? [simPath] : []), ...(fx.set ?? [])])];
    sets[`place:${id}`] = set;
    for (const p of set) lazy.add(p);
    const sim = fx.sim;
    const bundle: PlaceBundle = {
      id,
      config,
      rows,
      ...(sim ? { sim: async () => sim as Partial<{ tick(ctx: never): void; cadence: string }> } : {}),
      ...(fx.rawCells ? { rawCells: fx.rawCells } : {}),
    };
    loaders[id] = async () => {
      calls.push(`chunk ${id}`);
      if (fx.asFactory) {
        return {
          default: () => {
            calls.push(`factory ${id}`);
            return bundle;
          },
        } as unknown as PlaceBundle;
      }
      return (fx.asModule ? { default: bundle } : bundle) as PlaceBundle;
    };
  }
  const placeIndex: CompiledPlaceIndex = { placeIndex: index, places: loaders };

  const physicsLog: PlacesWorld['physics'] = { builds: [], positions: [], velocities: [], angular: [], holds: [], rotations: [] };
  const physics: PhysicsPort & { holdBody(row: RowRec, y: number): void } = {
    ...createNullPhysicsPort(),
    buildPlace: (place, bake) => {
      calls.push(`physics.buildPlace ${place}`);
      physicsLog.builds.push({ place, bake });
    },
    disposePlace: (place) => void calls.push(`physics.disposePlace ${place}`),
    rowSpawned: (row) => void calls.push(`physics.rowSpawned ${row.id}`),
    rowDestroyed: (row) => void calls.push(`physics.rowDestroyed ${row.id}`),
    setPosition: (row, p) => void physicsLog.positions.push({ id: row.id, p: { ...p }, place: row.place }),
    setVelocity: (row, v) => void physicsLog.velocities.push({ id: row.id, v: { ...v } }),
    setAngularVelocity: (row, w) => void physicsLog.angular.push({ id: row.id, w: { ...w } }),
    holdBody: (row, y) => void physicsLog.holds.push({ id: row.id, y }),
    setRotation: (row, q) => void physicsLog.rotations.push({ id: row.id, q: { ...q } }),
    step: (place) => void calls.push(`physics.step ${place}`),
    groundY: (place, x, z) => (o.ground ? o.ground(place, x, z) : null),
  };
  const builds: SceneBuild[] = [];
  const scene: SceneSyncPort = {
    ...createNullScenePort(),
    buildPlace: (place, rows, bake, onProgress) => {
      calls.push(`scene.buildPlace ${place}`);
      const ids = [...rows].map((r) => r.id);
      if (!o.manualScene) {
        onProgress(1);
        builds.push({ place, rows: ids, bake, onProgress, resolve() {}, reject() {} });
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        builds.push({ place, rows: ids, bake, onProgress, resolve, reject });
      });
    },
    disposePlace: (place) => void calls.push(`scene.disposePlace ${place}`),
    activate: (place) => void calls.push(`scene.activate ${place}`),
  };
  const bakes: PlacesWorld['bakes'] = { made: new Map(), pending: [] };
  const assets = {
    get: () => undefined,
    placeBake: (place: string): Promise<PlaceBake> => {
      calls.push(`bake ${place}`);
      const bake = emptyPlaceBake(place);
      if (!o.manualBake) {
        bakes.made.set(place, bake);
        return Promise.resolve(bake);
      }
      return new Promise<PlaceBake>((resolve, reject) => {
        bakes.pending.push({
          place,
          resolve: () => {
            bakes.made.set(place, bake);
            resolve(bake);
          },
          reject,
        });
      });
    },
  };

  const w = makeWorld({
    modules,
    lazy: [...lazy],
    placeIndex,
    sets,
    placeManager: true,
    ports: { physics, scene, assets },
    ...(o.rules ? { rules: o.rules } : {}),
    ...(o.defaultPlace ? { defaultPlace: o.defaultPlace } : {}),
  });
  const pm = w.k.places;
  const logs = { warn: [] as string[], error: [] as string[] };
  pm.setLog({ warn: (m) => logs.warn.push(m), error: (m) => logs.error.push(m) });
  const events: string[] = [];
  w.k.on('placeLoading', (p, f) => events.push(`placeLoading ${p} ${f}`));
  w.k.on('placeActive', (p, prev) => events.push(`placeActive ${p} ${String(prev)}`));
  w.k.on('placeBuilt', (p) => events.push(`placeBuilt ${p}`));
  w.k.on('rowSpawned', (r) => calls.push(`rowSpawned ${r.id}`));
  return {
    ...w,
    pm,
    calls,
    logs,
    scene: { builds },
    bakes,
    physics: physicsLog,
    events,
    human(place, at) {
      const id = w.k.spawnHuman({ place, ...(at ? { at } : {}), userId: 'u1', displayName: 'Operator', durableState: {} });
      return w.k.store.get(id)!;
    },
  };
}

/** a places world whose `boot` preload set has finished evaluating */
export async function placesWorld(o: PlacesWorldOptions): Promise<PlacesWorld> {
  const w = makePlacesWorld(o);
  await w.k.registry.ensure('boot');
  return w;
}

/** lets promise continuations (a load's completion, an arrival) run */
export async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
