// A minimal kernel for the extension tests: null ports, an in-memory module map, no places. Unlike the snapshot's
// tests/unit/core/fakes/ctx-world.ts it takes the `ext` option bag.
import { createSimCtx } from '../../src/compat/core/ctx/sim.ts';
import type { KernelExtensions } from '../../src/compat/core/ext.ts';
import { createKernel, type CoreKernel, type KernelOptions } from '../../src/compat/core/kernel.ts';
import { spawnRow } from '../../src/compat/core/lifecycle.ts';
import { createRegistry } from '../../src/compat/core/modules/registry.ts';
import type { KernelPorts } from '../../src/compat/core/ports.ts';
import { compiledPlace } from '../../tests/unit/core/fakes/lifecycle-world.ts';
import type {
  BehaviorCtx,
  CompiledPlaceIndex,
  ObjectSpec,
  RegistryInputs,
  RowId,
  SimCtx,
  SimInstance,
  SimModule,
  WorldConfig,
} from '../../src/compat/core/types.ts';

export type Module = Record<string, unknown>;

export interface TestWorld {
  k: CoreKernel;
  logged: Array<{ level: string; text: string }>;
  spawn(a: string | ObjectSpec, b?: ObjectSpec): RowId;
  ctx(id: RowId): BehaviorCtx;
  /** the root sim (module installed on the scheduler) */
  rootSim(module: Record<string, unknown>): SimInstance;
  ticks(n: number): void;
}

export async function testWorld(o: { modules?: Record<string, Module>; ext?: KernelExtensions; ports?: Partial<KernelPorts>; worldId?: string | null; ids?: KernelOptions['ids'] } = {}): Promise<TestWorld> {
  const modules = o.modules ?? {};
  const inputs: RegistryInputs = {
    modules: Object.fromEntries(Object.entries(modules).map(([p, ns]) => [p, async () => ns])),
    sets: { boot: Object.keys(modules), director: [], actors: [] },
    anim: {},
  };
  const registry = createRegistry(inputs, { log: { warn: () => {} } });
  const placeIndex: CompiledPlaceIndex = { placeIndex: { p1: compiledPlace('p1') }, places: {} };
  const worldConfig: WorldConfig = { defaultPlace: 'p1', player: 'templates/player.js#player', camera: 'templates/camera.js#camera', inputs: {} };
  const logged: Array<{ level: string; text: string }> = [];
  const sink = (level: string) => (text: string) => void logged.push({ level, text });
  const k = createKernel({
    seed: 1,
    worldId: o.worldId,
    ids: o.ids,
    ports: o.ports ?? {},
    worldConfig,
    places: placeIndex,
    registry,
    ext: o.ext,
    log: { sink: { log: sink('log'), warn: sink('warn'), error: sink('error') } },
  });
  await registry.ensure('boot');
  k.clock.resume('boot');
  return {
    k,
    logged,
    spawn: (a, b) => spawnRow(k, { kind: 'kernel' }, a, b),
    ctx(id) {
      const inst = k.store.get(id)?.behaviors[0];
      if (!inst || inst.ctx === null) throw new Error(`no ctx for ${id}`);
      return inst.ctx as BehaviorCtx;
    },
    rootSim(module) {
      const s: SimInstance = { id: 'sim', place: null, path: 'sim.js', module: { tick: () => {}, ...module } as unknown as SimModule, ctx: null, health: new Map() };
      s.ctx = createSimCtx(k, s) as SimCtx;
      k.time.setRootSim(s);
      return s;
    },
    ticks: (n) => k.runTicks(n, { force: true }),
  };
}
