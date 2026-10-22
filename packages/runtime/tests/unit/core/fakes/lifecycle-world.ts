// A kernel with the real lifecycle, spec interpreter and query (WP C1b) for the spec, lifecycle, query and vm-visibility tests:
// the real kernel over null ports, a module registry built from an in-memory module map (C3's ModuleRegistryImpl, every module
// loaded up front unless `lazy` names it), a two-place roster and a "mini ctx" per behavior instance (C5 builds the real ctx
// factories) with the verbs these tests use: spawn, destroy, getObject, query, now, self, cross, emit.
//
// Places: by default the kernel's `places` reads as not wired, as it did before the place manager (WP C4) landed: every roster
// place stands and is simulated, which is what the lifecycle, spec, query and vm-visibility tests are written against. The place
// tests pass `placeManager: true` (and their own compiled index and preload sets) to run on the real manager.
import { vi } from 'vitest';
import { createKernel, KernelNotWiredError, type CoreKernel } from '../../../../src/compat/core/kernel.ts';
import { createRegistry } from '../../../../src/compat/core/modules/registry.ts';
import { destroyRows, spawnRow } from '../../../../src/compat/core/lifecycle.ts';
import { getObject, query } from '../../../../src/compat/core/query.ts';
import type { KernelPorts } from '../../../../src/compat/core/ports.ts';
import type { EngineRules } from '../../../../src/compat/core/rules.ts';
import type {
  BehaviorInstance,
  CallerRef,
  CompiledPlace,
  CompiledPlaceIndex,
  CrossResult,
  EmitOptions,
  ObjectSpec,
  ObjectView,
  QueryOptions,
  RegistryInputs,
  RowId,
  RowRec,
  SimInstance,
  WorldConfig,
} from '../../../../src/compat/core/types.ts';

export type Module = Record<string, unknown>;

export function compiledPlace(id: string, extra: Partial<CompiledPlace> = {}): CompiledPlace {
  return {
    id,
    mode: '3d',
    gravity: { x: 0, y: -24, z: 0 },
    defaultSpawnPoint: { x: 0, y: 0, z: 0 },
    defaultSpawnRotation: null,
    worldBounds: { bottom: null },
    atmosphere: {},
    terrain: { kind: 'off' },
    persistence: 'session',
    sim: null,
    cells: [],
    rows: 0,
    modules: `place:${id}`,
    ...extra,
  };
}

export interface WorldOptions {
  /** tree path → module namespace (behaviours and templates) */
  modules?: Record<string, Module>;
  /** paths known to the registry but not loaded until a late bind asks for them */
  lazy?: readonly string[];
  places?: readonly string[];
  rules?: Partial<EngineRules>;
  ports?: Partial<KernelPorts>;
  defaultPlace?: string;
  dev?: boolean;
  /** the compiled roster and its chunk loaders (default: `places` compiled with no rows and no loaders) */
  placeIndex?: CompiledPlaceIndex;
  /** preload sets besides `boot` (`place:<p>`) */
  sets?: Record<string, readonly string[]>;
  /** true: the real place manager (WP C4); default: `kernel.places` reads as not wired (see the header) */
  placeManager?: boolean;
}

/** what a behaviour hook gets in these tests (the C5 ctx in miniature) */
export interface MiniCtx {
  readonly kind: 'behavior';
  readonly self: ObjectView;
  readonly row: RowRec;
  readonly inst: BehaviorInstance;
  now(): number;
  spawn(a: string | ObjectSpec, b?: ObjectSpec): RowId;
  destroy(id?: RowId | RowId[]): void;
  getObject(id: RowId): ObjectView | null;
  query(opts?: QueryOptions): unknown[];
  cross(entity: RowId | ObjectView, link: string): CrossResult;
  emit(name: string, payload?: unknown, opts?: EmitOptions): string | undefined;
}

export interface World {
  readonly k: CoreKernel;
  readonly warnings: string[];
  /** every hook call, in order: `<hook> <row id>` */
  readonly trace: string[];
  /** a spawn by the kernel (boot) */
  spawn(a: string | ObjectSpec, b?: ObjectSpec): RowId;
  /** a spawn by a scene of `place` */
  sceneSpawn(place: string, id: string, spec: ObjectSpec): RowId;
  destroy(ids?: RowId | RowId[]): void;
  row(id: RowId): RowRec | undefined;
  ctxOf(id: RowId, path?: string): MiniCtx;
  sim(place: string | null): SimInstance;
  /** n ticks, forced through any pause */
  ticks(n: number): void;
  /** a phase boundary outside a tick */
  boundary(): void;
}

/** a behaviour module that records its hooks in the world's trace (and runs `extra` hooks after recording) */
export function tracer(trace: string[], extra: Record<string, (ctx: MiniCtx, ...a: unknown[]) => void> = {}): Module {
  const rec = (hook: string) => (ctx: MiniCtx, ...a: unknown[]) => {
    trace.push(`${hook} ${ctx.row.id}`);
    extra[hook]?.(ctx, ...a);
  };
  const out: Module = { onSpawn: rec('onSpawn'), onDestroy: rec('onDestroy') };
  for (const [hook, fn] of Object.entries(extra)) if (!(hook in out)) out[hook] = fn;
  return out;
}

export function makeWorld(o: WorldOptions = {}): World {
  const modules = o.modules ?? {};
  const lazy = new Set(o.lazy ?? []);
  const inputs: RegistryInputs = {
    modules: Object.fromEntries(Object.entries(modules).map(([p, ns]) => [p, async () => ns])),
    sets: { boot: Object.keys(modules).filter((p) => !lazy.has(p)), director: [], actors: [], ...(o.sets ?? {}) },
    anim: {},
  };
  const registry = createRegistry(inputs, { log: { warn: () => {} } });
  const places = o.places ?? (o.placeIndex ? Object.keys(o.placeIndex.placeIndex) : ['p1', 'p2']);
  const placeIndex: CompiledPlaceIndex = o.placeIndex ?? {
    placeIndex: Object.fromEntries(places.map((p) => [p, compiledPlace(p)])),
    places: {},
  };
  const worldConfig: WorldConfig = {
    defaultPlace: o.defaultPlace ?? places[0]!,
    player: 'templates/player.js#player',
    camera: 'templates/camera.js#camera',
    inputs: {},
  };
  const k = createKernel({ seed: 1, ports: o.ports ?? {}, worldConfig, places: placeIndex, registry, rules: o.rules, dev: o.dev });
  if (o.placeManager !== true) {
    // on a prototype of this one kernel, not as an own property: query.ts `placesOf` then remembers that the getter throws
    // (no thrown Error per query), and a test may still shadow it with a stand-in manager of its own
    const unwired = Object.create(Object.getPrototypeOf(k) as object, {
      places: {
        configurable: true,
        get: () => {
          throw new KernelNotWiredError('places', 'places/manager.ts', 'C4');
        },
      },
    }) as object;
    Object.setPrototypeOf(k, unwired);
  }
  const warnings: string[] = [];
  k.lifecycle.setWarnSink((m) => warnings.push(m));
  const trace: string[] = [];
  const ctxs = new Map<BehaviorInstance, MiniCtx>();
  k.lifecycle.setCtxFactory((row, inst) => {
    const caller: CallerRef = { kind: 'row', row, behavior: inst };
    const ctx: MiniCtx = {
      kind: 'behavior',
      self: k.store.handle(row, row.vm),
      row,
      inst,
      now: () => k.clock.now(),
      spawn: (a, b) => spawnRow(k, caller, a, b),
      destroy: (id) => destroyRows(k, caller, id),
      getObject: (id) => getObject(k, caller, id),
      query: (opts) => query(k, caller, opts),
      cross: (entity, link) => k.places.cross(caller, entity, link),
      emit: (name, payload, opts) => k.bus.emit(caller, name, payload, opts),
    };
    ctxs.set(inst, ctx);
    return ctx as never;
  });
  // the registry evaluates the preload set asynchronously; the tests await world() below
  void registry.ensure('boot');
  k.clock.resume('boot');
  const sims = new Map<string, SimInstance>();
  return {
    k,
    warnings,
    trace,
    spawn: (a, b) => spawnRow(k, { kind: 'kernel' }, a, b),
    sceneSpawn: (place, id, spec) => spawnRow(k, { kind: 'scene', place }, id, spec),
    destroy: (ids) => destroyRows(k, { kind: 'kernel' }, ids),
    row: (id) => k.store.get(id),
    ctxOf(id, path) {
      const row = k.store.get(id);
      if (!row) throw new Error(`no row ${id}`);
      const inst = path ? row.behaviors.find((b) => b.path === path) : row.behaviors[0];
      const ctx = inst ? ctxs.get(inst) : undefined;
      if (!ctx) throw new Error(`no ctx for ${id}`);
      return ctx;
    },
    sim(place) {
      const key = place ?? '';
      let s = sims.get(key);
      if (!s) {
        s = { id: place ? `sim:${place}` : 'sim', place, path: place ? `places/${place}/sim.js` : 'sim.js', module: null, ctx: null, health: new Map() };
        sims.set(key, s);
      }
      return s;
    },
    ticks: (n) => k.runTicks(n, { force: true }),
    boundary: () => k.time.scheduler.boundary(),
  };
}

/** a world whose preload set has finished evaluating */
export async function world(o: WorldOptions = {}): Promise<World> {
  const w = makeWorld(o);
  await w.k.registry.ensure('boot');
  return w;
}

export const quietConsole = (): void => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
};
