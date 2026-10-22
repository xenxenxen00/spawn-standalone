// Host profile overrides; defaults preserve the account id and use Player.
import { describe, expect, it } from 'vitest';
import { bootKernel, type BootWorld } from '../../src/compat/core/boot/boot.ts';
import { resolveProfile } from '../../src/compat/core/boot/profile.ts';
import { createRegistry } from '../../src/compat/core/modules/registry.ts';
import { createNullPlatform } from '../../src/compat/core/null-ports.ts';
import type { CompiledPlace, PlaceBundle, RegistryInputs } from '../../src/compat/core/types.ts';
import { compiledPlace } from '../../tests/unit/core/fakes/lifecycle-world.ts';

const settings = () => {
  const m = new Map<string, unknown>();
  return { get: <T>(k: string) => m.get(k) as T, set: (k: string, v: unknown) => void m.set(k, v) } as never;
};
const user = (o: { id?: string; name?: string; loggedIn?: boolean }) => ({ getUser: async () => ({ loggedIn: true, ...o }) as never });

describe('resolveProfile idPrefix / defaultName', () => {
  it('neutral defaults: account id and Player', async () => {
    const p = await resolveProfile(user({ id: '7' }), settings());
    expect(p).toEqual({ userId: '7', displayName: 'Player', authorised: true });
  });
  it('options replace both; an empty prefix is honoured; a name from the platform wins', async () => {
    expect(await resolveProfile(user({ id: '7' }), settings(), { idPrefix: '', defaultName: 'Guest' })).toEqual({ userId: '7', displayName: 'Guest', authorised: true });
    expect((await resolveProfile(user({ id: '7', name: ' Ann ' }), settings(), { idPrefix: 'cc-', defaultName: 'Guest' })).displayName).toBe('Ann');
  });
  it('a device id is never prefixed; defaultName still names the guest', async () => {
    const p = await resolveProfile({ getUser: async () => null }, settings(), { idPrefix: 'cc-', defaultName: 'Guest', uuid: () => 'u-1' });
    expect(p).toEqual({ userId: 'u-1', displayName: 'Guest', authorised: false });
  });
});

function world(): BootWorld {
  const modules: Record<string, Record<string, unknown>> = {
    'templates/player.js': { player: { tags: ['player'], state: {} } },
    'templates/camera.js': { camera: { kind: 'custom', state: { pitch: 0, yaw: 0 } } },
  };
  const index: Record<string, CompiledPlace> = { start: compiledPlace('start', { rows: 0, cells: [] }) };
  const inputs: RegistryInputs = {
    modules: Object.fromEntries(Object.entries(modules).map(([p, ns]) => [p, async () => ns])),
    sets: { boot: ['templates/player.js', 'templates/camera.js'], director: [], actors: [], 'place:start': [] } as unknown as RegistryInputs['sets'],
    anim: {},
  };
  return {
    registry: createRegistry(inputs, { log: { warn: () => {} } }),
    worldConfig: { defaultPlace: 'start', player: 'templates/player.js#player', camera: 'templates/camera.js#camera' },
    places: { placeIndex: index, places: { start: async () => ({ default: { id: 'start', config: index['start'], rows: [] } }) as unknown as PlaceBundle } },
    files: [],
  };
}
const boot = (profile?: { idPrefix?: string; defaultName?: string }) =>
  bootKernel({
    platform: { ...createNullPlatform(), ...user({ id: '42' }) },
    canvas: null,
    headless: true,
    seed: 1,
    world: world(),
    preloadSets: ['boot'],
    start: 'defaultPlace',
    log: { log() {}, warn() {}, error() {} },
    kernelLog: { sink: { log() {}, warn() {}, error() {} } },
    ...(profile ? { profile } : {}),
  } as never);

describe('BootEnv.profile', () => {
  it('omitted: the body uses the unprefixed account id', async () => {
    const r = await boot();
    expect(r.profile.userId).toBe('42');
  });
  it('given: the body spawns with the option id, so nothing needs rewriting', async () => {
    const r = await boot({ idPrefix: 'cc-', defaultName: 'Guest' });
    expect(r.profile).toEqual({ userId: 'cc-42', displayName: 'Guest', authorised: true });
  });
});
