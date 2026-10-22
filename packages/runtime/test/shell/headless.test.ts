// composeGame({ headless: true }) with the runtime's own parts: no window, no document, no canvas, no performance and no
// requestAnimationFrame chain. The caller steps `app.driver.step(timeMs)`, which advances the kernel by the time since the last step.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BootWorld } from '../../src/compat/core/boot/boot.ts';
import { createRegistry } from '../../src/compat/core/modules/registry.ts';
import type { CompiledPlace, PlaceBundle, RegistryInputs } from '../../src/compat/core/types.ts';
import { createPlaygamaPlatform } from '../../src/platform-playgama/index.ts';
import { createHostSqlStores } from '../../src/ports/sql/index.ts';
import { composeGame } from '../../src/shell/compose-game.ts';
import { createFakeBridge } from '../platform-playgama/fake-bridge.ts';
import { compiledPlace } from '../../tests/unit/core/fakes/lifecycle-world.ts';

function world(ticks: { n: number }): BootWorld {
  const modules: Record<string, Record<string, unknown>> = {
    'templates/player.js': { player: { tags: ['player'], state: {} } },
    'templates/camera.js': { camera: { kind: 'custom', state: { pitch: 0, yaw: 0 } } },
    'sim.js': { cadence: '100ms', tick: () => void ticks.n++ },
  };
  const index: Record<string, CompiledPlace> = { start: compiledPlace('start', { rows: 0, cells: [] }) };
  const inputs: RegistryInputs = {
    modules: Object.fromEntries(Object.entries(modules).map(([p, ns]) => [p, async () => ns])),
    sets: { boot: ['templates/player.js', 'templates/camera.js'], director: ['sim.js'], actors: [], 'place:start': [] } as unknown as RegistryInputs['sets'],
    anim: {},
  };
  return {
    registry: createRegistry(inputs, { log: { warn: () => {} } }),
    worldConfig: { defaultPlace: 'start', player: 'templates/player.js#player', camera: 'templates/camera.js#camera' },
    places: { placeIndex: index, places: { start: async () => ({ default: { id: 'start', config: index['start'], rows: [] } }) as unknown as PlaceBundle } },
    files: [],
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('headless composition', () => {
  it('needs no window or performance, and runs only when stepped', async () => {
    expect(typeof window).toBe('undefined');
    // a first composition loads the lazily imported modules (the test runner itself reads performance while importing)
    (await composeGame({ boot: {preloadSets:['boot','director']}, slug: 'warm', canvas: null, headless: true, world: world({ n: 0 }) })).dispose();
    const raf = vi.fn();
    vi.stubGlobal('requestAnimationFrame', raf);
    vi.stubGlobal('performance', undefined);
    const ticks = { n: 0 };
    const app = await composeGame({ boot: {preloadSets:['boot','director']}, slug: 'headless', canvas: null, headless: true, world: world(ticks), onProgress: () => {} });
    try {
      expect(app.steps).not.toContain('renderer');
      expect(raf).not.toHaveBeenCalled();
      const before = ticks.n;
      for (let t = 0; t <= 1000; t += 50) app.driver.step(t);
      expect(raf).not.toHaveBeenCalled();
      expect(app.driver.frames).toBeGreaterThan(0);
      expect(ticks.n).toBeGreaterThan(before);
    } finally {
      app.dispose();
    }
  });

  it('binds ports.sqlStores to a Playgama platform save', async () => {
    const stores = createHostSqlStores({ debounceMs: 1 });
    const keys = stores.keysFor('w');
    const fake = createFakeBridge({ storage: { [keys[0]!]: 'AQID' } });
    const platform = createPlaygamaPlatform({ bridge: () => fake.bridge as never, document: null, initialInterstitialDelayS: 0, saveKeys: ['ss_save_v1', 'ss_save_v1_bad', ...keys] });
    await platform.init();
    const app = await composeGame({ boot: {preloadSets:['boot','director']}, slug: 'sqlbind', canvas: null, headless: true, world: world({ n: 0 }), platform, ports: { sqlStores: stores, sqlWorldId: 'w' } });
    try {
      expect([...(await stores.factory('w').load())!]).toEqual([1, 2, 3]);
    } finally {
      app.dispose();
    }
  });
});
