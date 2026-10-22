import { afterEach, describe, expect, it, vi } from 'vitest';
import { bootKernel, type BootEnv, type BootWorld } from '../../src/compat/core/boot/boot.ts';
import { objectIdOf, rowIdOfObjectId } from '../../src/compat/core/ids.ts';
import { createRegistry } from '../../src/compat/core/modules/registry.ts';
import { createMemorySaveStore, createNullPlatform } from '../../src/compat/core/null-ports.ts';
import { DurableState, type DurableOptions } from '../../src/compat/core/save/durable.ts';
import { jsonSaveCodec } from '../../src/compat/core/save/codec.ts';
import type { CompiledPlace, PlaceBundle } from '../../src/compat/core/types.ts';
import { bindService, service, flags, installPortFlags, resetPortFlags } from '../../src/compat/builtin/port.ts';
import { buildRigDef } from '../../src/compat/motion/rig.ts';
import { GaitFacts, GAIT_LIBRARY_CLIPS } from '../../src/compat/motion/gait.ts';
import { compiledPlace } from '../../tests/unit/core/fakes/lifecycle-world.ts';
import { PauseController } from '../../src/platform/pause-controller.ts';
import type { Platform, PlatformEvents } from '../../src/platform/platform.ts';
import { testWorld } from './world.ts';

const quiet = { warn() {}, error() {}, log() {} };
afterEach(() => { vi.useRealTimers(); resetPortFlags(); bindService('ledger', null); });
const playerModules = { 'templates/player.js': { player: { state: {} } }, 'scripts/noop.js': {} };

function bootEnv(extra: Partial<BootEnv> = {}): BootEnv {
  const modules: Record<string, Record<string, unknown>> = {
    ...playerModules,
    'sim.js': { cadence: '100ms', tick(ctx: { world: { state: Record<string, unknown> } }) { ctx.world.state['readyAt'] = 'second'; } },
  };
  const index: Record<string, CompiledPlace> = Object.fromEntries(['first', 'second'].map(id => [id, compiledPlace(id)]));
  const world: BootWorld = {
    registry: createRegistry({ modules: Object.fromEntries(Object.entries(modules).map(([p, ns]) => [p, async () => ns])), sets: { startup: Object.keys(modules), 'place:first': [], 'place:second': [] }, anim: {} }),
    worldConfig: { defaultPlace: 'first', player: 'templates/player.js#player', camera: {}, inputs: {} },
    places: { placeIndex: index, places: Object.fromEntries(Object.entries(index).map(([id, config]) => [id, async () => ({ id, config, rows: [] }) as unknown as PlaceBundle])) },
  };
  return { world, platform: createNullPlatform(), canvas: null, headless: true, preloadSets: ['startup'], log: quiet, kernelLog: { sink: quiet }, ...extra };
}

async function bound(options: DurableOptions = {}) {
  const store = createMemorySaveStore();
  const w = await testWorld({ modules: playerModules });
  const durable = new DurableState(store, { log: quiet, ...options });
  await durable.load();
  const id = w.k.spawnHuman({ place: 'p1', userId: 'local', displayName: 'Guest', durableState: durable.initialBodyState() });
  durable.bindBody(w.k.store.get(id)!, w.k.store);
  return { store, durable, state: w.k.store.handle(w.k.store.get(id)!, 'client').state };
}

describe('neutral core startup', () => {
  it('uses only named preload sets, mounts an optional root sim and starts at defaultPlace without pre-roll', async () => {
    const result = await bootKernel(bootEnv());
    expect(result.home).toBe('first');
    expect(result.prerollRounds).toBe(0);
    expect(result.kernel.time.rootSim).not.toBeNull();
    expect(result.kernel.createUiCtx().world.id).toBeNull();
    result.dispose(); result.durable.dispose();
  });

  it('honours injected readiness, home and identity policies without reserved game-state keys', async () => {
    const result = await bootKernel(bootEnv({
      worldId: 'custom-world', ids: { humanBody: 'avatar/me', cameraRig: 'view/main' },
      readHome: k => typeof k.worldState['readyAt'] === 'string' ? k.worldState['readyAt'] : null,
      preroll: { ticks: 3, maxRounds: 4, until: k => k.worldState['readyAt'] === 'second' },
    }));
    const k = result.kernel;
    expect(result.home).toBe('second'); expect(result.prerollRounds).toBe(1); expect(result.rolled).toBe(true);
    expect(k.store.get('player/local')).toBeUndefined(); expect(k.store.get('camera/local')).toBeUndefined();
    expect(k.createUiCtx().self?.id).toBe('avatar/me');
    expect(k.createUiCtx().world.players.map(p => p.id)).toEqual(['avatar/me']);
    expect(k.createUiCtx().world.id).toBe('custom-world');
    expect(k.store.handle(k.store.get('avatar/me')!, 'client').objectId).toBe('world:custom-world#avatar/me');
    expect(k.store.get('view/main')?.rig?.targetId).toBe('avatar/me');
    result.dispose(); result.durable.dispose();
  });

  it('checks a custom home against the roster and uses the explicit fallback', async () => {
    const result = await bootKernel(bootEnv({ homePlace: () => 'missing', fallbackPlace: 'second' }));
    expect(result.home).toBe('second'); result.dispose(); result.durable.dispose();
  });

  it('refuses invalid or colliding identity ids and invalid pre-roll counts', async () => {
    await expect(bootKernel(bootEnv({ ids: { humanBody: 'bad#id' } }))).rejects.toThrow('valid row ids');
    await expect(bootKernel(bootEnv({ ids: { humanBody: 'same', cameraRig: 'same' } }))).rejects.toThrow('distinct');
    await expect(bootKernel(bootEnv({ preroll: { ticks: -1, maxRounds: 2 } }))).rejects.toThrow('preroll');
  });

  it('scopes object ids to the exact world, including delimiter characters', () => {
    const id = objectIdOf('row/child', 'one#two');
    expect(rowIdOfObjectId(id, 'one#two')).toBe('row/child');
    expect(rowIdOfObjectId(id, 'one')).toBeNull();
    expect(rowIdOfObjectId(id)).toBeNull();
    expect(rowIdOfObjectId('world:one#bad~id', 'one')).toBeNull();
  });
});

describe('neutral durable state', () => {
  it('saves all JSON-valued body keys under ps and keeps host settings separate', async () => {
    const t = await bound();
    Object.assign(t.state, { coins: 7, prefs: { xhair: 'dot' }, settings: { volume: 0.5 }, unlocked: ['a'] });
    t.durable.settings.set('quality', { desktop: 'custom' });
    await t.durable.flush('checkpoint');
    expect(t.store.get('pp_save_v1')).toBeNull();
    const doc = JSON.parse(t.store.get('ss_save_v1')!);
    expect(doc.ps).toEqual({ coins: 7, prefs: { xhair: 'dot' }, settings: { volume: 0.5 }, unlocked: ['a'] });
    expect(doc.settings).toEqual({ quality: { desktop: 'custom' } });
    const reloaded = new DurableState(t.store); await reloaded.load();
    expect(reloaded.initialBodyState()).toEqual(doc.ps);
    delete t.state['coins']; await t.durable.flush('checkpoint');
    expect(JSON.parse(t.store.get('ss_save_v1')!).ps.coins).toBeUndefined();
    t.durable.dispose(); reloaded.dispose();
  });

  it('debounces ordinary writes and flushes only explicitly configured write keys early', async () => {
    vi.useFakeTimers();
    const t = await bound({ debounceMs: 100, flushOnWrite: ['checkpoint'] });
    t.state['prog'] = { xp: 1 }; await Promise.resolve();
    expect(t.store.get('ss_save_v1')).toBeNull();
    await vi.advanceTimersByTimeAsync(100);
    expect(JSON.parse(t.store.get('ss_save_v1')!).ps.prog).toEqual({ xp: 1 });
    t.state['checkpoint'] = 2; await Promise.resolve();
    expect(JSON.parse(t.store.get('ss_save_v1')!).ps.checkpoint).toBe(2);
    t.durable.dispose();
  });

  it('uses a custom codec explicitly and keeps the document intact when that codec fails', async () => {
    const store = createMemorySaveStore(); store.set('custom', 'opaque data');
    const read = vi.fn(() => ({ save: { v: 1 as const, settings: {}, ps: { coins: 42 } }, status: 'ok' as const, issues: [] }));
    const serialize = vi.fn(() => 'encoded');
    const d = new DurableState(store, { key: 'custom', codec: { read, serialize }, log: quiet });
    await d.load(); expect(read).toHaveBeenCalledWith('opaque data'); expect(d.initialBodyState()).toEqual({ coins: 42 });
    d.settings.set('deviceId', 'local'); await d.flush('manual'); expect(store.get('custom')).toBe('encoded'); expect(serialize).toHaveBeenCalledTimes(1); d.dispose();
    const failed = new DurableState(store, { key: 'custom', codec: { read() { throw Error('codec failed'); }, serialize }, log: quiet });
    await failed.load(); failed.settings.set('deviceId', 'new'); await failed.flush('manual');
    expect(failed.loadStatus).toBe('failed'); expect(store.get('custom')).toBe('encoded'); failed.dispose();
  });

  it('backs up corrupt text under the configured key and never replaces another world save', async () => {
    const store = createMemorySaveStore(); store.set('world-save', '{broken'); store.set('other-save', 'keep');
    const d = new DurableState(store, { key: 'world-save', log: quiet });
    await d.load();
    expect(d.loadStatus).toBe('corrupt'); expect(store.get('world-save_bad')).toBe('{broken');
    d.settings.set('deviceId', 'local'); await d.flush('manual');
    expect(store.get('other-save')).toBe('keep'); expect(JSON.parse(store.get('world-save')!).v).toBe(1); d.dispose();
  });

  it('keeps a failed store read read-only and retries a failed write without losing dirt', async () => {
    const store = createMemorySaveStore(); const set = vi.fn(store.set.bind(store));
    const d = new DurableState({ ...store, get() { throw Error('unavailable'); }, set }, { log: quiet });
    await d.load(); d.settings.set('deviceId', 'local'); await d.flush('manual');
    expect(d.loadStatus).toBe('failed'); expect(set).not.toHaveBeenCalled(); d.dispose();
    let failing = true;
    const retry = new DurableState({ ...store, set(k, v) { if (failing) throw Error('quota'); store.set(k, v); } }, { log: quiet });
    await retry.load(); retry.settings.set('deviceId', 'local'); await retry.flush('manual'); expect(retry.dirty).toBe(true);
    failing = false; await retry.flush('manual'); expect(retry.dirty).toBe(false);
    expect(JSON.parse(store.get('ss_save_v1')!).settings.deviceId).toBe('local'); retry.dispose();
  });

  it('validates document containers, rejects versions and serializes equal content identically', () => {
    expect(jsonSaveCodec.read('{"v":2}').status).toBe('corrupt');
    expect(jsonSaveCodec.read('{"v":1,"ps":7,"settings":[]}')).toMatchObject({ status: 'repaired', save: { v: 1, settings: {} } });
    const parsed = jsonSaveCodec.read('{"v":1,"settings":{"__proto__":{"polluted":true}},"ps":{"__proto__":{"polluted":true},"x":3}}');
    expect(parsed.save.settings).not.toHaveProperty('__proto__');
    expect(Object.hasOwn(parsed.save['ps'] as object, '__proto__')).toBe(false);
    expect(jsonSaveCodec.serialize({ v: 1, settings: { b: 2, a: 1 } })).toBe(jsonSaveCodec.serialize({ settings: { a: 1, b: 2 }, v: 1 }));
  });

  it('allows game-owned parts without a default trophy schema and reserves the body container', async () => {
    const t = await bound(); const part = t.durable.registerPart('ledger', { read: () => ({ score: 8 }), write: () => ({ score: 8 }) });
    await part.flush(); expect(JSON.parse(t.store.get('ss_save_v1')!).ledger).toEqual({ score: 8 });
    expect(() => t.durable.registerPart('ps', { read() {}, write() {} })).toThrow('reserved'); t.durable.dispose();
  });
});

describe('host-supplied services and motion tables', () => {
  it('has no default flags or trophy book and binds arbitrary service implementations explicitly', () => {
    expect(flags).toEqual({}); expect(service('ledger')).toBeNull();
    const ledger = { score: () => 7 }; bindService('ledger', ledger); expect(service('ledger')).toBe(ledger);
    bindService('ledger', null); expect(service('ledger')).toBeNull();
    installPortFlags({ 'quality.custom': 3 }); expect(flags).toEqual({ 'quality.custom': 3 });
  });

  it('uses rig prefix rules only when supplied and assumes no library asset names', () => {
    const nodes = [{ name: 'wpn_root', parent: -1 }];
    expect(buildRigDef('custom', nodes).family).toBe('unknown');
    expect(buildRigDef('custom', nodes, { familyRules: [{ family: 'viewmodel', bonePrefixes: ['wpn_'] }] }).family).toBe('viewmodel');
    expect(GAIT_LIBRARY_CLIPS).toEqual([]);
    const bind = vi.fn(() => null); const gait = new GaitFacts({ base: { get: () => undefined }, rigOf: () => buildRigDef('custom', nodes), bind });
    expect(gait.get('custom')).toBeUndefined(); expect(bind).not.toHaveBeenCalled();
  });
});


describe('host pause policies and residency', () => {
  it('accepts custom pause reasons and uses exactly the host audio and overlay policy', async () => {
    const w = await testWorld(); const setPaused = vi.fn();
    const pause = new PauseController(w.k.clock, { setPaused, setPlatformAudio() {} }, { audioSuspend: ['cutscene'], escalating: ['controller-away'] });
    pause.setGameplayActive(true); pause.add('cutscene');
    expect(pause.audioSuspended).toBe(true); expect(pause.reasons.has('overlay')).toBe(false);
    pause.remove('cutscene'); expect(pause.audioSuspended).toBe(false);
    pause.add('controller-away'); expect(pause.reasons.has('overlay')).toBe(true);
    expect(pause.audioSuspended).toBe(false);
    expect(() => pause.add('boot')).toThrow('host pause reason');
    expect(() => pause.add('')).toThrow('host pause reason');
    expect(setPaused.mock.calls).toEqual([[true], [false]]); pause.dispose();
  });

  it('distinguishes custom reason sets even when their names contain separators', async () => {
    const w = await testWorld(); const pause = new PauseController(w.k.clock, { setPaused() {}, setPlatformAudio() {} }); const changed = vi.fn(); pause.onChange(changed);
    w.k.clock.pause('a,b'); pause.refresh(); w.k.clock.resume('a,b'); w.k.clock.pause('a'); w.k.clock.pause('b'); pause.refresh();
    expect(changed).toHaveBeenCalledTimes(2); pause.dispose();
  });

  it('combines independent host and ad holds into a platform pause until both release', async () => {
    const w = await testWorld(); const listeners = new Map<string, (...args: unknown[]) => void>();
    const platform = { platformPaused: false, platformMuted: false, on(event: string, fn: (...args: unknown[]) => void) { listeners.set(event, fn); return () => listeners.delete(event); } } as unknown as Platform;
    const pause = new PauseController(w.k.clock, { setPaused() {}, setPlatformAudio() {} }); pause.bindPlatform(platform);
    const fire = (name: keyof PlatformEvents, ...args: unknown[]): void => { listeners.get(name)?.(...args); };
    fire('adPause'); fire('platformPause', true); expect([...pause.reasons]).toEqual(['platform']);
    fire('adResume'); expect(pause.paused).toBe(true);
    fire('platformPause', false); expect(pause.paused).toBe(false);
    fire('adPause'); fire('platformPause', true); fire('platformPause', false); expect(pause.paused).toBe(true);
    fire('adResume'); expect(pause.paused).toBe(false); pause.dispose();
  });

  it('retains only the places named by the host hook after the human crosses', async () => {
    for (const keep of [false, true]) {
      const result = await bootKernel(bootEnv({ residentPlaces: state => keep && state['stay'] === 'first' ? ['first'] : [] }));
      const k = result.kernel; k.worldState['stay'] = 'first';
      const { spawnRow } = await import('../../src/compat/core/lifecycle.ts');
      spawnRow(k, { kind: 'scene', place: 'first' }, 'anchored', { place: 'first' });
      await k.places.load('second');
      expect(k.places.cross({ kind: 'kernel' }, k.ids.humanBody, '+second')).toEqual({ crossed: true, placeId: 'second' });
      expect(k.store.has('anchored')).toBe(keep);
      expect(k.places.residency('first')).toBe(keep ? 'dormant' : 'absent');
      result.dispose(); result.durable.dispose();
    }
  });
});
