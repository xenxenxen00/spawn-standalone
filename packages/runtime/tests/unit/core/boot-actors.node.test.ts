// BootEnv.actors: the boot loads the `actors` preload set (anim/*.yml) when asked; PP boots only `boot` and `director`.
import { describe, expect, it } from 'vitest';
import { bootKernel, type BootEnv, type BootWorld } from '../../../src/compat/core/boot/boot.ts';
import { createRegistry } from '../../../src/compat/core/modules/registry.ts';
import { createNullPlatform } from '../../../src/compat/core/null-ports.ts';
import type { CompiledPlace, CompiledPlaceIndex, PlaceBundle, RegistryInputs } from '../../../src/compat/core/types.ts';
import { compiledPlace } from './fakes/lifecycle-world.ts';

function world(anim: boolean): BootWorld {
  const modules: Record<string, Record<string, unknown>> = {
    'sim.js': { cadence: '100ms', tick() {} },
    'templates/player.js': { player: { state: {} } },
    'templates/camera.js': { camera: { kind: 'custom', state: {} } },
  };
  const config = compiledPlace('main', { rows: 0, cells: [] });
  const index: Record<string, CompiledPlace> = { main: config };
  const places: CompiledPlaceIndex = { placeIndex: index, places: { main: async () => ({ default: { id: 'main', config, rows: [] } }) as unknown as PlaceBundle } };
  const inputs: RegistryInputs = {
    modules: Object.fromEntries(Object.entries(modules).map(([p, ns]) => [p, async () => ns])),
    sets: { boot: ['templates/player.js', 'templates/camera.js'], director: ['sim.js'], actors: anim ? ['anim/bean.yml'] : [], 'place:main': [] } as unknown as RegistryInputs['sets'],
    anim: anim ? { 'anim/bean.yml': async () => ({ authored: { clips: { idle: {} } }, compiled: [] }) } : {},
  };
  return { registry: createRegistry(inputs, { log: { warn() {} } }), worldConfig: { defaultPlace: 'main', player: 'templates/player.js#player', camera: 'templates/camera.js#camera', inputs: {} }, places, files: ['sim.js'] } as BootWorld;
}

const boot = (anim: boolean, env: Partial<BootEnv>) =>
  bootKernel({ platform: createNullPlatform(), canvas: null, headless: true, preloadSets: ['boot', 'director'], seed: 1, start: 'defaultPlace', world: world(anim), kernelLog: { sink: { log() {}, warn() {}, error() {} } }, ...env });

describe('BootEnv.actors', () => {
  it('is off by default: anim entries are not loaded ', async () => {
    const r = await boot(true, {});
    expect((r.kernel.registry as unknown as { anim(p: string): unknown }).anim('anim/bean.yml')).toBeUndefined();
  });
  it('true loads the actors set so anim/bean.yml is readable', async () => {
    const r = await boot(true, { actors: true });
    expect((r.kernel.registry as unknown as { anim(p: string): unknown }).anim('anim/bean.yml')).toBeDefined();
  });
  it("'auto' loads it only when the game has anim entries", async () => {
    const withAnim = await boot(true, { actors: 'auto' });
    expect((withAnim.kernel.registry as unknown as { anim(p: string): unknown }).anim('anim/bean.yml')).toBeDefined();
    const none = await boot(false, { actors: 'auto' });
    expect(none.kernel.registry.get('anim/bean.yml')).toBeUndefined();
  });
});
