// The world and place handles and the row-less state stores (docs/design/core-runtime.md §3.5, §5.3, §5.5, §5.7, §5.8;
// D-CORE-02): `ctx.world`, `ctx.world.places`, `ctx.place`, `ctx.world.state`, `ctx.place.state`.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StateBag } from '../../../src/compat/core/ctx/state-bag.ts';
import { HUMAN_BODY_ID } from '../../../src/compat/core/ids.ts';
import { createKernel } from '../../../src/compat/core/kernel.ts';
import { createNullPorts } from '../../../src/compat/core/null-ports.ts';
import { createRegistry } from '../../../src/compat/core/modules/registry.ts';
import { LayeredValueImpl } from '../../../src/compat/core/store/layers.ts';
import type { CallerRef, CrossResult, ObjectView, PlaceManager, PlaceRuntime, PlayerView } from '../../../src/compat/core/types.ts';
import { ctxWorld, PLAYER_MODULES } from './fakes/ctx-world.ts';
import { compiledPlace } from './fakes/lifecycle-world.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

const BOT = 'scripts/bots/bot.js';

describe('ctx.world', () => {
  it('the constants and the world-config members', async () => {
    const w = await ctxWorld({
      modules: {},
      places: ['gallow-farm', 'training'],
      defaultPlace: 'gallow-farm',
      files: ['templates/terminal.js', 'templates/bot.js', 'places/gallow-farm/cells/x0z0.scene', 'templates/bot.js'],
      worldConfig: { engine: { behaviors: ['scripts/arrival.js'], ui: { theme: { font: 'Geist' } } }, ui: { render: 'scripts/ui.js' } },
    });
    const world = w.simCtx(null).world;
    expect(world.id).toBeNull();
    expect(world.mode).toBe('live');
    expect(world.address).toBeNull();
    expect(world.routing).toBeNull();
    expect(world.godMode).toEqual({});
    expect(world.creatorTabs).toEqual([]);
    expect(world.player).toEqual({});
    expect(world.defaultPlace).toBe('gallow-farm');
    // sorted, without duplicates (scripts/map/power.js:54 filters it, the Director tests membership)
    expect(world.files).toEqual(['places/gallow-farm/cells/x0z0.scene', 'templates/bot.js', 'templates/terminal.js']);
    expect(world.files.indexOf('templates/bosses/none.js')).toBe(-1);
    expect(world.engine).toEqual({ behaviors: ['scripts/arrival.js'], ui: { referenceHeight: 1080, theme: { font: 'Geist' } } });
    expect(world.ui).toEqual({ render: 'scripts/ui.js' });
    expect(world.settling).toBe(false);
    expect(w.simCtx(null).world).toBe(world);
    expect(w.simCtx('training').world).toBe(world); // one handle per realm
  });

  it('engine defaults stand when the world config names none', async () => {
    const w = await ctxWorld({ modules: {} });
    expect(w.simCtx(null).world.engine).toEqual({ ui: { referenceHeight: 1080, theme: { font: 'Geist' } } });
  });

  it('assets, camera and inputs come from the ports at the moment of the read', async () => {
    const ports = createNullPorts();
    let cam: { aspect?: number; fov?: number } = {};
    const facts = { bounds: { center: [0, 1, 0] as const, min: [0, 0, 0] as const, max: [1, 2, 1] as const, size: [1, 2, 1] as const }, gait: { walk: 1.3 } };
    const declared = { axes: { moveX: { keys: 'a/d' } } };
    const w = await ctxWorld({
      modules: {},
      ports: { ...ports, camera: { ...ports.camera, worldCamera: () => cam }, assets: { ...ports.assets, get: (ref) => (ref === 'm/op.glb' ? facts : undefined) }, input: { ...ports.input, declared } },
    });
    const world = w.simCtx(null).world;
    // before the first frame: no aspect, no invented default (the rig and the viewmodel fall back to 16/9 themselves)
    expect(world.camera).toEqual({});
    expect(world.camera.aspect).toBeUndefined();
    cam = { aspect: 1.5, fov: 60 };
    expect(world.camera).toEqual({ aspect: 1.5, fov: 60 });
    world.camera.aspect = 9; // a write to the snapshot goes nowhere
    expect(world.camera.aspect).toBe(1.5);
    // scripts/enemies/runtime.js:484: ctx.world.assets && ctx.world.assets[ref] && ctx.world.assets[ref].bounds
    expect(world.assets && world.assets['m/op.glb'] && world.assets['m/op.glb'].bounds!.size[1]).toBe(2);
    expect(world.assets['m/op.glb']!.gait!['walk']).toBe(1.3);
    expect(world.assets['missing.glb']).toBeUndefined();
    expect('m/op.glb' in world.assets).toBe(true);
    expect('missing.glb' in world.assets).toBe(false);
    expect(world.inputs).toBe(declared);
  });

  it('players: [] before the human, then the body through its whole life, per realm', async () => {
    const w = await ctxWorld({ modules: { ...PLAYER_MODULES, [BOT]: {} } });
    const sim = w.simCtx(null);
    expect(sim.world.players).toEqual([]);
    w.human('p2');
    w.spawn('bot-1', { behavior: BOT, simulatedBy: 'platform', place: 'p1', tags: ['bot'] });
    const fromSim = sim.world.players as PlayerView[];
    const fromBody = w.ctx(HUMAN_BODY_ID).world.players as PlayerView[];
    expect(fromSim.map((p) => p.id)).toEqual([HUMAN_BODY_ID]); // bots are not players
    expect(fromSim[0]!.userId).toBe('u-1');
    expect(fromSim[0]!.displayName).toBe('Op');
    expect(fromSim[0]!.isLocal).toBe(false);
    expect(fromBody[0]!.isLocal).toBe(true);
    expect(fromSim[0]).not.toBe(fromBody[0]);
    expect(sim.world.players).not.toBe(sim.world.players); // a fresh array per read
    w.ctx(HUMAN_BODY_ID).destroy();
    expect(sim.world.players).toEqual([]);
  });

  it('places: keyed by the roster, resident or not; an unknown key is undefined; handles are cached', async () => {
    const w = await ctxWorld({ modules: {}, places: ['p1', 'p2', 'p3'] });
    const places = w.simCtx(null).world.places;
    expect(Object.keys(places)).toEqual(['p1', 'p2', 'p3']);
    expect(places['p2']!.id).toBe('p2');
    expect(places['p2']).toBe(places['p2']);
    expect(places['lobby']).toBeUndefined();
    expect(places['staging-bunker']).toBeUndefined();
    expect('p3' in places).toBe(true);
    expect('lobby' in places).toBe(false);
    // scripts/director/places.js:18: !!(ctx.world.places && ctx.world.places[name])
    expect(!!(places && places['lobby'])).toBe(false);
    expect(Object.entries(places).map(([id, h]) => [id, h!.name])).toEqual([['p1', 'p1'], ['p2', 'p2'], ['p3', 'p3']]);
  });

  it('game code in strict mode can assign any member without a throw; nothing changes', async () => {
    const w = await ctxWorld({ modules: {}, dev: true });
    const world = w.simCtx(null).world as unknown as Record<string, unknown>;
    expect(() => {
      world['mode'] = 'dev';
      world['players'] = [];
      world['defaultPlace'] = 'x';
      world['settling'] = true;
      (world['places'] as Record<string, unknown>)['p1'] = null;
      delete (world['places'] as Record<string, unknown>)['p1'];
    }).not.toThrow();
    expect(world['mode']).toBe('live');
    expect(world['defaultPlace']).toBe('p1');
    expect((world['places'] as Record<string, { id: string }>)['p1']!.id).toBe('p1');
    expect(w.warnings.some((m) => m.includes('world.mode'))).toBe(true);
  });
});

describe('ctx.world.state and ctx.place.state: write semantics without a row', () => {
  it('a write stores a copy; reads see it at once on every ctx; nested proxies keep their identity', async () => {
    const w = await ctxWorld({ modules: { [BOT]: {} } });
    const sim = w.simCtx(null);
    const bot = w.ctx(w.spawn('bot-1', { behavior: BOT, place: 'p1' }));
    const ss = { phase: 'LOBBY', match: { map: 'p1', wave: 0 }, slots: [{ i: 0 }] };
    sim.world.state.ss = ss;
    ss.phase = 'MUTATED AFTER THE ASSIGNMENT'; // the store kept the copy (D-CORE-02)
    expect(sim.world.state.ss.phase).toBe('LOBBY');
    expect(bot.world.state.ss.match.map).toBe('p1');
    expect(sim.world.state.ss).toBe(sim.world.state.ss);
    expect(sim.world.state.ss.match).toBe(bot.world.state.ss.match);
    const match = sim.world.state.ss.match;
    match.wave = 3;
    sim.world.state.ss.slots.push({ i: 1 });
    sim.world.state.ss.slots[1].i = 5;
    expect(w.k.worldState).toEqual({ ss: { phase: 'LOBBY', match: { map: 'p1', wave: 3 }, slots: [{ i: 0 }, { i: 5 }] } });
    // wire semantics: functions and undefined dropped, NaN → null
    sim.world.state.odd = { f: () => 1, u: undefined, n: Number.NaN, d: new Date(0) };
    expect(w.k.worldState['odd']).toEqual({ n: null, d: '1970-01-01T00:00:00.000Z' });
    // delete, `in`, keys
    delete sim.world.state.odd;
    delete sim.world.state.ss.match.wave;
    expect('odd' in sim.world.state).toBe(false);
    expect(Object.keys(sim.world.state)).toEqual(['ss']);
    expect(w.k.worldState).toEqual({ ss: { phase: 'LOBBY', match: { map: 'p1' }, slots: [{ i: 0 }, { i: 5 }] } });
    // assigning undefined clears; compound assignment and ??= work
    sim.world.state.ssFall = 0;
    sim.world.state.ssFall += 2;
    // `??=` evaluates to the assigned literal, not to the stored copy: the first mutation through it is lost, as on a row's
    // state (D-CORE-02; scripts/enemies/runtime.js:1284 does this in its debug book), the next one goes through the store
    (sim.world.state.ssFallStats ??= { n: 0 }).n++;
    expect(w.k.worldState['ssFallStats']).toEqual({ n: 0 });
    (sim.world.state.ssFallStats ??= { n: 0 }).n++;
    sim.world.state.ss.phase = undefined;
    expect(w.k.worldState).toEqual({ ss: { match: { map: 'p1' }, slots: [{ i: 0 }, { i: 5 }] }, ssFall: 2, ssFallStats: { n: 1 } });
  });

  it('the kernel\'s worldState object is the store: a direct read by another domain sees the game\'s writes', async () => {
    const w = await ctxWorld({ modules: {} });
    const data = w.k.worldState;
    w.simCtx(null).world.state.ss = { phase: 'WAVE' };
    expect(w.k.worldState).toBe(data);
    expect((data['ss'] as { phase: string }).phase).toBe('WAVE');
    (w.simCtx(null).world as unknown as { state: unknown }).state = { ssHome: 'p2' }; // root assignment replaces the contents
    expect(w.k.worldState).toBe(data);
    expect(data).toEqual({ ssHome: 'p2' });
  });

  it('an equal write is free; an effective one marks the UI dirty at the end of the tick', async () => {
    const ports = createNullPorts();
    const markDirty = vi.fn();
    const w = await ctxWorld({ modules: {}, ports: { ...ports, ui: { ...ports.ui, markDirty } } });
    const sim = w.simCtx(null);
    const bag = w.k.ctx.worldBag;
    sim.world.state.ss = { phase: 'LOBBY', n: [1, 2] };
    const v = bag.version;
    sim.world.state.ss = { phase: 'LOBBY', n: [1, 2] };
    sim.world.state.ss.phase = 'LOBBY';
    delete sim.world.state.nothing;
    expect(bag.version).toBe(v);
    expect(markDirty).not.toHaveBeenCalled();
    w.ticks(1);
    expect(markDirty).toHaveBeenCalledTimes(1);
    w.ticks(2);
    expect(markDirty).toHaveBeenCalledTimes(1);
    sim.place.state.power = { k: 0.5 };
    w.ticks(1);
    expect(markDirty).toHaveBeenCalledTimes(2);
  });

  it('place.state is per place, shared by every ctx of the place, and kept for a place nobody stands in', async () => {
    const w = await ctxWorld({ modules: { [BOT]: {} } });
    const lamp = w.ctx(w.spawn('lamp', { behavior: BOT, place: 'p1' }));
    lamp.place.state.power = { k: 0.4 };
    lamp.place.state.flick = [1, 2, 3];
    expect(w.simCtx(null).place.state.power).toEqual({ k: 0.4 });
    expect(w.simCtx('p2').place.state.power).toBeUndefined();
    expect(w.simCtx(null).world.places['p1']!.state).toBe(lamp.place.state);
    lamp.destroy();
    w.ticks(1);
    expect(w.k.store.byPlace('p1').size).toBe(0);
    expect(w.simCtx(null).world.places['p1']!.state.power.k).toBe(0.4);
  });
});

describe('StateBag: arrays, the read-only view, the size watchdog', () => {
  it('array writes stay dense and wire-clean', () => {
    const data: Record<string, unknown> = {};
    const bag = new StateBag(data, { name: 'test' });
    const s = bag.view();
    s['q'] = [1, 2, 3];
    s['q'].push(4);
    s['q'][6] = 7;
    expect(data['q']).toEqual([1, 2, 3, 4, null, null, 7]);
    s['q'].length = 2;
    expect(s['q'].shift()).toBe(1);
    expect(data['q']).toEqual([2]);
    delete s['q'][0];
    expect(data['q']).toEqual([null]);
    s['q'].splice(0, 1, { a: 1 }, { a: 2 });
    expect(s['q'].map((x: { a: number }) => x.a)).toEqual([1, 2]);
    expect(Array.isArray(s['q'])).toBe(true);
    expect(JSON.stringify(s)).toBe('{"q":[{"a":1},{"a":2}]}');
  });

  it('the read-only view ignores every write, counts them and warns once', () => {
    const warn = vi.fn();
    const data: Record<string, unknown> = { ss: { phase: 'LOBBY', slots: [1] } };
    const bag = new StateBag(data, { name: 'world.state', warn });
    const ro = bag.view(true);
    expect(ro).toBe(bag.view(true));
    expect(ro).not.toBe(bag.view());
    expect(() => {
      'use strict';
      ro['x'] = 1;
      ro['ss'].phase = 'WAVE';
      ro['ss'].slots.push(2);
      delete ro['ss'];
      Object.defineProperty(ro, 'y', { value: 1, configurable: true, writable: true, enumerable: true });
    }).not.toThrow();
    expect(data).toEqual({ ss: { phase: 'LOBBY', slots: [1] } });
    expect(bag.version).toBe(0);
    expect(bag.readonlyWrites).toBeGreaterThanOrEqual(4);
    expect(warn).toHaveBeenCalledTimes(1);
    bag.view()['ss'].phase = 'WAVE';
    expect(ro['ss'].phase).toBe('WAVE');
  });

  it('warns when the store passes 32 KiB of JSON, at most once a minute', () => {
    const warn = vi.fn();
    const bag = new StateBag({}, { name: 'world.state', warn });
    const s = bag.view();
    s['small'] = 'x'.repeat(1000);
    expect(bag.checkSize(0)).toBeLessThan(32 * 1024);
    expect(warn).not.toHaveBeenCalled();
    s['big'] = 'x'.repeat(40_000);
    expect(bag.checkSize(500)).toBeNull(); // measured at most once a second
    expect(bag.checkSize(1000)).toBeGreaterThan(32 * 1024);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toMatch(/world\.state holds \d+ bytes/);
    s['big2'] = 'y';
    bag.checkSize(30_000);
    expect(warn).toHaveBeenCalledTimes(1);
    s['big3'] = 'y';
    bag.checkSize(61_000);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(bag.checkSize(99_000)).toBeNull(); // unchanged since the last measure
  });
});

describe('ctx.place', () => {
  it('the config members, with the engine defaults for what the config leaves out', async () => {
    const ports = createNullPorts();
    const w = await ctxWorld({
      modules: {},
      places: {
        farm: { gravity: { x: 0, y: -24, z: 0 }, defaultSpawnPoint: { x: 2, y: 5, z: -3 }, worldBounds: { bottom: -40 }, terrain: { kind: 'off' } },
        isle: { gravity: undefined as never, defaultSpawnPoint: { x: 10, z: 20, y: { terrain: 1.5 } }, terrain: { kind: 'heightmap', generator: 'scripts/gen/mire-island/terrain.js' } },
        flat: { defaultSpawnPoint: { x: 1, z: 1 } },
      },
      ports: { ...ports, physics: { ...ports.physics, groundY: (place, x, z) => (place === 'isle' && x === 10 && z === 20 ? 28 : null) } },
    });
    const places = w.simCtx(null).world.places;
    const farm = places['farm']!;
    expect([farm.id, farm.name, farm.mode]).toEqual(['farm', 'farm', '3d']);
    expect(farm.gravity).toEqual({ x: 0, y: -24, z: 0 });
    expect(farm.gravity).not.toBe(farm.gravity); // a copy: the game may keep or scale it
    expect(farm.defaultSpawnPoint).toEqual({ x: 2, y: 5, z: -3 });
    expect(farm.worldBounds).toEqual({ bottom: -40 });
    expect(farm.terrain).toEqual({ kind: 'off' });
    const isle = places['isle']!;
    expect(isle.gravity).toEqual({ x: 0, y: -9.81, z: 0 });
    expect(isle.defaultSpawnPoint).toEqual({ x: 10, y: 29.5, z: 20 }); // 1.5 m over the ground
    expect(isle.worldBounds).toEqual({ bottom: 29.5 - 64 });
    expect(isle.terrain['kind']).toBe('heightmap');
    expect(places['flat']!.defaultSpawnPoint).toEqual({ x: 1, y: 0, z: 1 }); // nothing under it: 0
    expect(places['flat']!.worldBounds).toEqual({ bottom: -64 });
  });

  it('players: the human while its body stands here', async () => {
    const w = await ctxWorld({ modules: { ...PLAYER_MODULES } });
    w.human('p2');
    const places = w.simCtx(null).world.places;
    expect(places['p1']!.players).toEqual([]);
    expect(places['p2']!.players.map((p) => p.id)).toEqual([HUMAN_BODY_ID]);
    expect(w.ctx(HUMAN_BODY_ID).place.players[0]!.isLocal).toBe(true);
    w.k.store.movePlace(w.row(HUMAN_BODY_ID), 'p1');
    expect(places['p1']!.players.map((p) => p.id)).toEqual([HUMAN_BODY_ID]);
    expect(places['p2']!.players).toEqual([]);
  });

  it('objects: a lazy map over the place\'s rows; writes through a handle land (scripts/map/lights.js)', async () => {
    const w = await ctxWorld({ modules: { ...PLAYER_MODULES, 'scripts/camera.js': {} } });
    w.spawn('lamp-1', { place: 'p1', light: { kind: 'point', intensity: 4 }, tags: ['lamp'] });
    w.spawn('lamp-2', { place: 'p1', light: { kind: 'spot', intensity: 2 } });
    w.spawn('crate', { place: 'p1' });
    w.spawn('far', { place: 'p2', light: { kind: 'point', intensity: 1 } });
    w.human('p1');
    w.rig('scripts/camera.js');
    const local = w.ctx(HUMAN_BODY_ID).spawn('glow', { audience: 'local', light: { kind: 'point', intensity: 1 } });
    const place = w.simCtx(null).world.places['p1']!;
    const objs = place.objects;
    expect(objs).toBe(place.objects);
    // the rig is not an object of the place; the body's local row is invisible to the platform VM (X-24)
    expect(Object.keys(objs)).toEqual(['lamp-1', 'lamp-2', 'crate', HUMAN_BODY_ID]);
    expect(Object.keys(w.ctx(HUMAN_BODY_ID).place.objects)).toEqual(['lamp-1', 'lamp-2', 'crate', HUMAN_BODY_ID, local]);
    expect(objs['far']).toBeUndefined();
    expect(objs['missing']).toBeUndefined();
    expect('lamp-1' in objs).toBe(true);
    // lampsOf + setOn of scripts/map/lights.js
    const lamps: string[] = [];
    for (const id of Object.keys(objs)) {
      const h = objs[id] as ObjectView & { light?: { kind: string; intensity: number } };
      if (!h || !h.light) continue;
      if (h.light.kind !== 'point' && h.light.kind !== 'spot') continue;
      lamps.push(id);
    }
    expect(lamps).toEqual(['lamp-1', 'lamp-2']);
    const h = objs['lamp-1'] as ObjectView & { light: { intensity: number } };
    h.state = Object.assign({}, h.state || {}, { lamp0: h.light.intensity });
    h.light = Object.assign({}, h.light, { intensity: +(h.light.intensity * 0.5).toFixed(2) });
    expect(w.row('lamp-1').props['light']).toEqual({ kind: 'point', intensity: 2 });
    expect(w.row('lamp-1').state).toEqual({ lamp0: 4 });
    w.simCtx(null).destroy('lamp-2');
    expect(Object.keys(objs)).toEqual(['lamp-1', 'crate', HUMAN_BODY_ID]);
  });

  it('atmosphere: a leaf write merges, a root assignment replaces, delete reveals the config', async () => {
    const config = { ambient: { light: { intensity: 1, color: '#fff' }, sky: 'grey' }, hemisphere: { intensity: 0.5, ground: '#000' }, fog: { density: 0.01, color: '#888' } };
    const w = await ctxWorld({ modules: {}, places: { p1: { atmosphere: config }, p2: {} } });
    const a = w.simCtx(null).place.atmosphere;
    // scripts/map/power.js:88-92
    if (a.ambient && a.ambient.light) a.ambient.light.intensity = 0.25;
    if (a.hemisphere) a.hemisphere.intensity = 0.1;
    expect(a.ambient).toEqual({ light: { intensity: 0.25, color: '#fff' }, sky: 'grey' });
    expect(a.hemisphere).toEqual({ intensity: 0.1, ground: '#000' });
    // scripts/gen/fallout-acre/nuke.js:20-22
    a.fog = { density: 0.2 };
    expect(a.fog).toEqual({ density: 0.2 });
    delete a.fog;
    delete a.ambient.light.intensity;
    expect(a.fog).toEqual({ density: 0.01, color: '#888' });
    expect(a.ambient.light.intensity).toBe(1);
    expect(config.ambient.light.intensity).toBe(1); // the compiled config is never edited
    // the same layered value for every ctx of the place, and none for another place
    expect(w.simCtx(null).world.places['p1']!.atmosphere.hemisphere.intensity).toBe(0.1);
    expect(w.simCtx('p2').place.atmosphere.hemisphere).toBeUndefined();
  });
});

describe('with a place manager wired', () => {
  it('state, atmosphere, spawn point, bottom and cross come from the manager', async () => {
    const runtimes = new Map<string, PlaceRuntime>();
    const crossed: Array<[CallerRef['kind'], unknown, string]> = [];
    const pm = {
      active: 'p1',
      residency: () => 'active',
      isSimulated: () => true,
      spawnPoint: (p: string) => ({ x: 7, y: p === 'p1' ? 3 : 0, z: 9 }),
      bottom: () => -12,
      cross: (caller: CallerRef, entity: unknown, link: string): CrossResult => {
        crossed.push([caller.kind, typeof entity === 'string' ? entity : (entity as ObjectView).id, link]);
        return link === '+p2' ? { crossed: true, placeId: 'p2' } : { crossed: false, verdict: 'unknown-place' };
      },
      runtime: (p: string): PlaceRuntime => {
        let rt = runtimes.get(p);
        if (!rt) runtimes.set(p, (rt = { id: p, state: {}, atmosphere: new LayeredValueImpl(() => ({ fog: { density: 1 } })), sim: null }));
        return rt;
      },
    } as unknown as PlaceManager;
    const w = await ctxWorld({ modules: { [BOT]: {} }, placeManager: pm });
    const bot = w.ctx(w.spawn('bot-1', { behavior: BOT, place: 'p1' }));
    bot.place.state.power = { k: 0.2 };
    expect(runtimes.get('p1')!.state).toEqual({ power: { k: 0.2 } });
    bot.place.atmosphere.fog.density = 3;
    expect(runtimes.get('p1')!.atmosphere.read()).toEqual({ fog: { density: 3 } });
    expect(bot.place.defaultSpawnPoint).toEqual({ x: 7, y: 3, z: 9 });
    expect(bot.place.worldBounds).toEqual({ bottom: -12 });
    expect(bot.cross('bot-1', '+p2')).toEqual({ crossed: true, placeId: 'p2' });
    expect(w.simCtx(null).cross(bot.self, '+staging-bunker')).toEqual({ crossed: false, verdict: 'unknown-place' });
    expect(crossed).toEqual([['row', 'bot-1', '+p2'], ['sim', 'bot-1', '+staging-bunker']]);
    // the UI realm reads the same stores, read-only
    const ui = w.k.createUiCtx();
    ui.world.places['p1']!.state.power.k = 9;
    ui.world.places['p1']!.atmosphere.fog.density = 9;
    expect(runtimes.get('p1')!.state).toEqual({ power: { k: 0.2 } });
    expect(runtimes.get('p1')!.atmosphere.read()).toEqual({ fog: { density: 3 } });
  });

  it('the kernel\'s own place manager (C4) gives the place sims their ctx and the handles its runtime', async () => {
    const registry = createRegistry({ modules: {}, sets: { boot: [], director: [], actors: [] }, anim: {} }, { log: { warn: () => {} } });
    const k = createKernel({
      seed: 3,
      ports: {},
      worldConfig: { defaultPlace: 'p1', player: 'templates/player.js#player', camera: 'templates/camera.js#camera', inputs: {} },
      places: { placeIndex: { p1: compiledPlace('p1', { atmosphere: { fog: { density: 0.5 } } }) }, places: {} },
      registry,
    });
    const handle = k.ctx.place('p1', 'platform');
    handle.state['power'] = { k: 0.3 };
    expect(k.places.runtime('p1').state).toEqual({ power: { k: 0.3 } });
    handle.atmosphere['fog'].density = 0.9;
    expect(k.places.runtime('p1').atmosphere.read()).toEqual({ fog: { density: 0.9 } });
    expect(k.settling).toBe(false);
    k.booting = true;
    expect(k.ctx.world('platform').settling).toBe(true);
  });
});
