// BootEnv.placeBake: the kernel's assets port builds colliders from the place's rows when the supplied bake has none.
import { describe, expect, it } from 'vitest';
import { bootKernel, type BootEnv, type BootWorld } from '../../../src/compat/core/boot/boot.ts';
import { createRegistry } from '../../../src/compat/core/modules/registry.ts';
import { createNullPlatform } from '../../../src/compat/core/null-ports.ts';
import type { CompiledPlace, CompiledPlaceIndex, PlaceBundle, RegistryInputs } from '../../../src/compat/core/types.ts';
import { compiledPlace } from './fakes/lifecycle-world.ts';

const row = { id: 'arena', cell: 'x0z0', spec: { feetPosition: { x: 1, y: 0, z: 2 }, physics: { body: 'static', collider: 'mesh' }, primitive: { kind: 'scripted', script: 'scripts/gen/floor.js' } } };

function world(): BootWorld {
  const modules: Record<string, Record<string, unknown>> = {
    'sim.js': { cadence: '100ms', tick() {} },
    'templates/player.js': { player: { state: {} } },
    'templates/camera.js': { camera: { kind: 'custom', state: {} } },
    'scripts/gen/floor.js': { collider: () => ({ kind: 'box', width: 4, height: 1, depth: 4 }) },
  };
  const config = compiledPlace('main', { rows: 1, cells: ['x0z0'] });
  const index: Record<string, CompiledPlace> = { main: config };
  const places: CompiledPlaceIndex = { placeIndex: index, places: { main: async () => ({ id: 'main', config, rows: [row] }) as unknown as PlaceBundle } };
  const inputs: RegistryInputs = {
    modules: Object.fromEntries(Object.entries(modules).map(([p, ns]) => [p, async () => ns])),
    sets: { boot: ['templates/player.js', 'templates/camera.js'], director: ['sim.js'], actors: [], 'place:main': [] } as unknown as RegistryInputs['sets'],
    anim: {},
  };
  return { registry: createRegistry(inputs, { log: { warn() {} } }), worldConfig: { defaultPlace: 'main', player: 'templates/player.js#player', camera: 'templates/camera.js#camera', inputs: {} }, places, files: ['sim.js'] } as BootWorld;
}

const boot = (env: Partial<BootEnv>) =>
  bootKernel({ platform: createNullPlatform(), canvas: null, headless: true, preloadSets: ['boot', 'director'], seed: 1, start: 'defaultPlace', world: world(), kernelLog: { sink: { log() {}, warn() {}, error() {} } }, ...env });

describe('BootEnv.placeBake', () => {
  it('is off by default: the null assets port answers an empty bake ', async () => {
    const r = await boot({});
    expect((await r.kernel.ports.assets.placeBake('main')).colliders.instances).toEqual([]);
  });
  it('true builds the pack from the place rows through the registry', async () => {
    const r = await boot({ placeBake: true });
    const pack = (await r.kernel.ports.assets.placeBake('main')).colliders;
    expect(pack.keys.map((k) => k.box)).toEqual([[4, 1, 4]]);
    expect(pack.instances.map((i) => [i.rowId, Array.from(i.m.subarray(9))])).toEqual([['arena', [1, 0, 2]]]);
  });
});
