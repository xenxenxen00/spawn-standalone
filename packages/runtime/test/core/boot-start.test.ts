// Boot has no implicit home or preroll rules.
import { describe, expect, it } from 'vitest';
import { bootKernel, type BootLog, type BootWorld } from '../../src/compat/core/boot/boot.ts';
import { HUMAN_BODY_ID } from '../../src/compat/core/ids.ts';
import { createRegistry } from '../../src/compat/core/modules/registry.ts';
import { createNullPlatform } from '../../src/compat/core/null-ports.ts';
import type { CompiledPlace, PlaceBundle, RegistryInputs } from '../../src/compat/core/types.ts';
import { compiledPlace } from '../../tests/unit/core/fakes/lifecycle-world.ts';

type Module = Record<string, unknown>;

function world(o: { sim?: Module | null; homeRule?: string } = {}): BootWorld & { loads: string[] } {
  const loads: string[] = [];
  const modules: Record<string, Module> = {
    'templates/player.js': { player: { tags: ['player'], state: {} } },
    'templates/camera.js': { camera: { kind: 'custom', state: { pitch: 0, yaw: 0 } } },
  };
  if (o.sim !== null) modules['sim.js'] = o.sim ?? { cadence: '100ms', tick() {} };
  if (o.homeRule) modules['scripts/director/places.js'] = { homePlace: () => o.homeRule };
  const index: Record<string, CompiledPlace> = {};
  const loaders: Record<string, () => Promise<PlaceBundle>> = {};
  for (const id of ['start', 'lobby']) {
    index[id] = compiledPlace(id, { rows: 0, cells: [] });
    loaders[id] = async () => {
      loads.push(id);
      return { default: { id, config: index[id], rows: [] } } as unknown as PlaceBundle;
    };
  }
  const director = Object.keys(modules).filter((p) => !p.startsWith('templates/'));
  const inputs: RegistryInputs = {
    modules: Object.fromEntries(Object.entries(modules).map(([p, ns]) => [p, async () => ns])),
    sets: { boot: ['templates/player.js', 'templates/camera.js'], director, actors: [], 'place:start': [], 'place:lobby': [] } as unknown as RegistryInputs['sets'],
    anim: {},
  };
  return {
    registry: createRegistry(inputs, { log: { warn: () => {} } }),
    worldConfig: { defaultPlace: 'start', player: 'templates/player.js#player', camera: 'templates/camera.js#camera' },
    places: { placeIndex: index, places: loaders },
    files: [],
    loads,
  };
}

const quiet = (): BootLog & { lines: string[] } => {
  const lines: string[] = [];
  return { lines, log: (m) => void lines.push(m), warn: (m) => void lines.push(`warn ${m}`), error: (m) => void lines.push(`error ${m}`) };
};
const env = (w: BootWorld, log: BootLog) => ({ platform: createNullPlatform(), canvas: null, headless: true, seed: 1, world: w, preloadSets: ['boot', 'director'], log, kernelLog: { sink: { log() {}, warn() {}, error() {} } } });

describe('BootEnv.start', () => {
  it('omitted: the default place is used without preroll or fallback warnings', async () => {
    const w = world();
    const log = quiet();
    const r = await bootKernel(env(w, log));
    expect(r.prerollRounds).toBe(0);
    expect(r.home).toBe('start');
    expect(log.lines.filter(l => l.startsWith('warn'))).toEqual([]);
  });

  it("'defaultPlace': no pre-roll, no home rule, the body stands in defaultPlace", async () => {
    const w = world({ homeRule: 'lobby' });
    const log = quiet();
    const r = await bootKernel({ ...env(w, log), start: 'defaultPlace' });
    expect(r.prerollRounds).toBe(0);
    expect(r.rolled).toBe(false);
    expect(r.home).toBe('start');
    expect(w.loads).toEqual(['start']);
    expect(r.kernel.places.active).toBe('start');
    expect(r.kernel.store.get(HUMAN_BODY_ID)?.place).toBe('start');
    expect(r.kernel.time.rootSim).not.toBeNull();
    expect(log.lines.filter((l) => l.startsWith('warn') || l.startsWith('error'))).toEqual([]);
  });

  it("'defaultPlace' without a sim.js: no root sim, the boot still stands", async () => {
    const w = world({ sim: null });
    const r = await bootKernel({ ...env(w, quiet()), start: 'defaultPlace' });
    expect(r.home).toBe('start');
    expect(r.kernel.time.rootSim).toBeNull();
  });
});
