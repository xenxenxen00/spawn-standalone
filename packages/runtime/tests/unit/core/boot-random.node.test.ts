// ctx.random (api-reference "Random") is the kernel's room RNG, seeded by BootEnv.seed: a headless run with the same seed
// draws the same sequence from the UI ctx and a sim ctx, a different seed another one. No Math.random reaches a game ctx.
import { describe, expect, it } from 'vitest';
import { bootKernel, type BootWorld } from '../../../src/compat/core/boot/boot.ts';
import { createRegistry } from '../../../src/compat/core/modules/registry.ts';
import { createNullPlatform } from '../../../src/compat/core/null-ports.ts';
import type { CompiledPlaceIndex, RegistryInputs } from '../../../src/compat/core/types.ts';
import { compiledPlace } from './fakes/lifecycle-world.ts';

function world(simDraws: number[]): BootWorld {
  const modules: Record<string, Record<string, unknown>> = {
    'sim.js': { cadence: '100ms', tick: (ctx: { random(): number }) => void simDraws.push(ctx.random()) },
    'templates/player.js': { player: { state: {} } },
    'templates/camera.js': { camera: { kind: 'custom', state: {} } },
  };
  const config = compiledPlace('main', { rows: 0, cells: [] });
  const places: CompiledPlaceIndex = { placeIndex: { main: config }, places: { main: async () => ({ id: 'main', config, rows: [] }) as never } };
  const inputs: RegistryInputs = {
    modules: Object.fromEntries(Object.entries(modules).map(([p, ns]) => [p, async () => ns])),
    sets: { boot: ['templates/player.js', 'templates/camera.js'], director: ['sim.js'], actors: [], 'place:main': [] } as unknown as RegistryInputs['sets'],
    anim: {},
  };
  return { registry: createRegistry(inputs, { log: { warn() {} } }), worldConfig: { defaultPlace: 'main', player: 'templates/player.js#player', camera: 'templates/camera.js#camera', inputs: {} }, places, files: ['sim.js'] } as BootWorld;
}

async function draws(seed: number): Promise<{ ui: number[]; sim: number[] }> {
  const simDraws: number[] = [];
  const r = await bootKernel({ platform: createNullPlatform(), canvas: null, headless: true, preloadSets: ['boot', 'director'], seed, start: 'defaultPlace', world: world(simDraws), kernelLog: { sink: { log() {}, warn() {}, error() {} } } });
  const ui = r.kernel.createUiCtx();
  r.kernel.runTicks(9, { force: true });
  const out = { ui: [ui.random(), ui.random(), ui.random()], sim: simDraws.slice(0, 3) };
  r.dispose();
  return out;
}

describe('seeded ctx.random', () => {
  it('repeats for one seed (UI ctx and sim ctx), differs for another, and stays in [0, 1)', async () => {
    const a = await draws(7);
    expect(await draws(7)).toEqual(a);
    expect(await draws(8)).not.toEqual(a);
    expect(a.sim.length).toBe(3);
    for (const v of [...a.ui, ...a.sim]) expect(v >= 0 && v < 1).toBe(true);
  });
});
