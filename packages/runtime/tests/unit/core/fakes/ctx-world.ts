// A kernel with its own ctx factories (WP C5) for the ctx tests: the real kernel over null ports (or the ports a test passes),
// a module registry built from an in-memory module map (every module loaded up front), a compiled roster, the carried file
// list and a captured ctx log. Unlike fakes/lifecycle-world.ts nothing replaces the kernel's ctx factory: `inst.ctx` is the
// real behavior / rig ctx and `sim()` builds real sim ctxs.
//
// Places: by default `kernel.places` reads as not wired (KernelNotWiredError), which is what the ctx factories must work
// with; a test of the wired path passes its own `placeManager`.
import { createKernel, KernelNotWiredError, type CoreKernel } from '../../../../src/compat/core/kernel.ts';
import { createRegistry } from '../../../../src/compat/core/modules/registry.ts';
import { spawnRow, type SpawnExtras } from '../../../../src/compat/core/lifecycle.ts';
import { createSimCtx } from '../../../../src/compat/core/ctx/sim.ts';
import { CAMERA_RIG_ID, HUMAN_BODY_ID } from '../../../../src/compat/core/ids.ts';
import { LayeredValueImpl } from '../../../../src/compat/core/store/layers.ts';
import type { KernelPorts } from '../../../../src/compat/core/ports.ts';
import type { EngineRules } from '../../../../src/compat/core/rules.ts';
import type {
  BehaviorCtx,
  CompiledPlace,
  CompiledPlaceIndex,
  ObjectSpec,
  PlaceManager,
  RegistryInputs,
  RigCtx,
  RowId,
  RowRec,
  SimCtx,
  SimInstance,
  SimModule,
  WorldConfig,
} from '../../../../src/compat/core/types.ts';
import { compiledPlace } from './lifecycle-world.ts';

export type Module = Record<string, unknown>;

export interface CtxWorldOptions {
  /** tree path → module namespace (behaviors and templates) */
  modules?: Record<string, Module>;
  /** roster ids, or id → config overrides */
  places?: readonly string[] | Record<string, Partial<CompiledPlace>>;
  defaultPlace?: string;
  ports?: Partial<KernelPorts>;
  /** the carried file list (`ctx.world.files`) */
  files?: readonly string[];
  worldConfig?: Partial<WorldConfig>;
  rules?: Partial<EngineRules>;
  dev?: boolean;
  seed?: number;
  /** a place manager to wire as `kernel.places`, or 'kernel' for the kernel's own (WP C4); default: not wired */
  placeManager?: PlaceManager | 'kernel';
}

export interface LoggedLine {
  level: 'log' | 'warn' | 'error';
  text: string;
  data: unknown;
}

export interface CtxWorld {
  readonly k: CoreKernel;
  /** what `ctx.log / warn / error` printed */
  readonly logged: LoggedLine[];
  /** lifecycle and dev warnings */
  readonly warnings: string[];
  /** a spawn by the kernel (boot) */
  spawn(a: string | ObjectSpec, b?: ObjectSpec, extras?: SpawnExtras): RowId;
  /** the human body in `place` (the world config's player template must be a loaded module) */
  human(place?: string, state?: object): RowId;
  /** the camera rig row following the human, with the behavior at `path` */
  rig(path: string, state?: Record<string, unknown>): RowId;
  row(id: RowId): RowRec;
  /** the real ctx of a row's behavior instance */
  ctx(id: RowId, path?: string): BehaviorCtx;
  rigCtx(): RigCtx;
  /** the root sim (null) or a place sim, with its real ctx */
  sim(place: string | null, module?: Record<string, unknown>): SimInstance;
  simCtx(place: string | null): SimCtx;
  /** n ticks, forced through any pause */
  ticks(n: number): void;
  /** a phase boundary outside a tick */
  boundary(): void;
}

export function makeCtxWorld(o: CtxWorldOptions = {}): CtxWorld {
  const modules = o.modules ?? {};
  const inputs: RegistryInputs = {
    modules: Object.fromEntries(Object.entries(modules).map(([p, ns]) => [p, async () => ns])),
    sets: { boot: Object.keys(modules), director: [], actors: [] },
    anim: {},
  };
  const registry = createRegistry(inputs, { log: { warn: () => {} } });
  const placeSpec = o.places ?? ['p1', 'p2'];
  const roster: Record<string, CompiledPlace> = Array.isArray(placeSpec)
    ? Object.fromEntries((placeSpec as readonly string[]).map((p) => [p, compiledPlace(p)]))
    : Object.fromEntries(Object.entries(placeSpec as Record<string, Partial<CompiledPlace>>).map(([p, extra]) => [p, compiledPlace(p, extra)]));
  const placeIndex: CompiledPlaceIndex = { placeIndex: roster, places: {} };
  const worldConfig: WorldConfig = {
    defaultPlace: o.defaultPlace ?? Object.keys(roster)[0] ?? 'p1',
    player: 'templates/player.js#player',
    camera: 'templates/camera.js#camera',
    inputs: {},
    ...(o.worldConfig ?? {}),
  };
  const logged: LoggedLine[] = [];
  const sink = (level: LoggedLine['level']) => (text: string, data?: unknown) => {
    logged.push({ level, text, data });
  };
  const k = createKernel({
    seed: o.seed ?? 1,
    ports: o.ports ?? {},
    worldConfig,
    places: placeIndex,
    registry,
    rules: o.rules,
    dev: o.dev,
    files: o.files,
    log: { sink: { log: sink('log'), warn: sink('warn'), error: sink('error') } },
  });
  const pm = o.placeManager;
  if (pm !== 'kernel') {
    Object.defineProperty(k, 'places', {
      configurable: true,
      get: () => {
        if (pm) return pm;
        throw new KernelNotWiredError('places', 'places/manager.ts', 'C4');
      },
    });
  }
  const warnings: string[] = [];
  k.lifecycle.setWarnSink((m) => warnings.push(m));
  void registry.ensure('boot');
  k.clock.resume('boot');
  const sims = new Map<string, SimInstance>();
  const row = (id: RowId): RowRec => {
    const r = k.store.get(id);
    if (!r) throw new Error(`no row ${id}`);
    return r;
  };
  const world: CtxWorld = {
    k,
    logged,
    warnings,
    spawn: (a, b, extras) => spawnRow(k, { kind: 'kernel' }, a, b, extras),
    human: (place, state) =>
      k.spawnHuman({ place: place ?? worldConfig.defaultPlace, at: { x: 0, y: 0, z: 0 }, userId: 'u-1', displayName: 'Op', durableState: state ?? {} }),
    rig: (path, state) =>
      spawnRow(
        k,
        { kind: 'kernel' },
        CAMERA_RIG_ID,
        { behavior: path, place: k.store.get(HUMAN_BODY_ID)?.place ?? worldConfig.defaultPlace, state: state ?? { yaw: 0, pitch: 0 } },
        { vm: 'client', rig: { targetId: HUMAN_BODY_ID, layer: new LayeredValueImpl(() => ({ pointerLock: true, sensitivity: 3 })) } },
      ),
    row,
    ctx(id, path) {
      const r = row(id);
      const inst = path ? r.behaviors.find((b) => b.path === path) : r.behaviors[0];
      if (!inst || inst.ctx === null) throw new Error(`no ctx for ${id}`);
      return inst.ctx as BehaviorCtx;
    },
    rigCtx: () => world.ctx(CAMERA_RIG_ID) as unknown as RigCtx,
    sim(place, module) {
      const key = place ?? '';
      let s = sims.get(key);
      if (!s) {
        s = { id: place ? `sim:${place}` : 'sim', place, path: place ? `places/${place}/sim.js` : 'sim.js', module: null, ctx: null, health: new Map() };
        s.ctx = createSimCtx(k, s);
        sims.set(key, s);
      }
      if (module) s.module = { tick: () => {}, ...module } as unknown as SimModule;
      return s;
    },
    simCtx: (place) => world.sim(place).ctx!,
    ticks: (n) => k.runTicks(n, { force: true }),
    boundary: () => k.time.scheduler.boundary(),
  };
  return world;
}

/** a world whose modules have finished evaluating */
export async function ctxWorld(o: CtxWorldOptions = {}): Promise<CtxWorld> {
  const w = makeCtxWorld(o);
  await w.k.registry.ensure('boot');
  return w;
}

/** the player template and body behavior most tests spawn the human from */
export const PLAYER_MODULES: Record<string, Module> = {
  'scripts/player.js': {},
  'templates/player.js': { player: { behavior: ['scripts/player.js'], tags: ['player', 'teammate'] } },
};
