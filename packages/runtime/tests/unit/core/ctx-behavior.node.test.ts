// The behavior ctx (docs/design/core-runtime.md §7, §7.1, §7.2, §8.1, §9.5, §9.6; D-CORE-06/07/08): one stable object per
// behavior instance, its members, and how each verb is wired to the kernel with the owner as the caller.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CtxLog } from '../../../src/compat/core/ctx/common.ts';
import { HUMAN_BODY_ID } from '../../../src/compat/core/ids.ts';
import { KernelNotWiredError } from '../../../src/compat/core/kernel.ts';
import type { BehaviorCtx, EventMeta, PlayerView } from '../../../src/compat/core/types.ts';
import { ctxWorld, PLAYER_MODULES } from './fakes/ctx-world.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

const DOOR = 'scripts/map/door.js';
const BOT = 'scripts/bots/bot.js';

describe('behavior ctx: one object per instance', () => {
  it('every hook, ear, ctx.on handler and ctx.after callback of an instance gets the same ctx (inst.ctx)', async () => {
    const seen: Array<[string, unknown]> = [];
    const w = await ctxWorld({
      modules: {
        [DOOR]: {
          onSpawn: (ctx: BehaviorCtx) => {
            seen.push(['onSpawn', ctx]);
            ctx.on('ss:hand', (c: unknown) => void seen.push(['on', c]));
            ctx.after(0, 'kickShard', { n: 1 });
          },
          update: (ctx: BehaviorCtx) => void seen.push(['update', ctx]),
          onDestroy: (ctx: BehaviorCtx) => void seen.push(['onDestroy', ctx]),
          ears: { 'ss:ear': (ctx: BehaviorCtx) => void seen.push(['ear', ctx]) },
          kickShard: (ctx: BehaviorCtx) => void seen.push(['after', ctx]),
        },
        'scripts/other.js': {},
      },
    });
    const id = w.spawn('door-1', { behavior: [DOOR, 'scripts/other.js'], place: 'p1' });
    const inst = w.row(id).behaviors[0]!;
    const ctx = w.ctx(id);
    expect(ctx).toBe(inst.ctx);
    expect(w.ctx(id, 'scripts/other.js')).not.toBe(ctx);
    w.ticks(1);
    w.simCtx(null).emit('ss:ear', {}, { to: id });
    w.simCtx(null).emit('ss:hand', {}, { to: id });
    w.ticks(2);
    w.spawn('other-row', { behavior: DOOR, place: 'p1' });
    ctx.destroy();
    w.ticks(1);
    const mine = seen.filter(([, c]) => c === ctx).map(([hook]) => hook);
    for (const hook of ['onSpawn', 'update', 'ear', 'on', 'after', 'onDestroy']) expect(mine, hook).toContain(hook);
    // the other row's hooks got that row's ctx, never this one
    expect(seen.some(([hook, c]) => hook === 'onSpawn' && c !== ctx)).toBe(true);
    expect(ctx.kind).toBe('behavior');
  });

  it('a ctx.on handler gets the registering behavior\'s ctx; its unsubscribe really removes it; once runs once', async () => {
    const heard: string[] = [];
    const w = await ctxWorld({ modules: { [DOOR]: {}, [BOT]: {} } });
    const a = w.ctx(w.spawn('a', { behavior: DOOR, place: 'p1' }));
    const b = w.ctx(w.spawn('b', { behavior: BOT, place: 'p1' }));
    const off = a.on('ss:x', (ctx: BehaviorCtx, payload: unknown, meta: EventMeta) => {
      heard.push(`a:${ctx === a}:${JSON.stringify(payload)}:${String(meta.sourceId)}`);
    });
    b.on('ss:x', (ctx: BehaviorCtx) => void heard.push(`b:${ctx === b}`), { once: true });
    expect(b.emit('ss:x', { n: 1 })).toBeUndefined();
    expect(heard).toEqual([]); // queued: delivered at the next phase boundary (D-CORE-08)
    w.boundary();
    expect(heard).toEqual(['a:true:{"n":1}:b', 'b:true']);
    off();
    off(); // idempotent
    b.emit('ss:x', { n: 2 });
    w.boundary();
    expect(heard).toEqual(['a:true:{"n":1}:b', 'b:true']);
    expect(w.k.time.listeners.size).toBe(0);
  });
});

describe('behavior ctx: members', () => {
  it('self is the row\'s handle on its VM; state aliases self.state and assigning replaces it', async () => {
    const w = await ctxWorld({ modules: { [DOOR]: {} } });
    const id = w.spawn('door-1', { behavior: DOOR, place: 'p1', state: { open: false, hp: { n: 3 } } });
    const ctx = w.ctx(id);
    expect(ctx.self).toBe(w.k.store.handle(w.row(id), 'platform'));
    expect(ctx.self.id).toBe('door-1');
    expect(ctx.state).toBe(ctx.self.state);
    ctx.state['open'] = true;
    expect(w.row(id).state['open']).toBe(true);
    const next = { fresh: 1 };
    ctx.state = next;
    expect(w.row(id).state).toEqual({ fresh: 1 });
    expect(w.row(id).state).not.toBe(next); // a copy (D-CORE-02)
    ctx.state = {};
    expect(w.row(id).state).toEqual({});
  });

  it('a stray assignment to a ctx member is ignored instead of throwing in strict-mode game code; the ctx is extensible', async () => {
    const w = await ctxWorld({ modules: { [DOOR]: {} } });
    const ctx = w.ctx(w.spawn('door-1', { behavior: DOOR, place: 'p1' }));
    const loose = ctx as unknown as Record<string, unknown>;
    expect(() => {
      for (const member of ['session', 'world', 'place', 'self', 'kind', 'view', 'files', 'player']) loose[member] = null;
      loose['__scratch'] = { n: 1 };
    }).not.toThrow();
    expect(ctx.session).toBe(w.k.vms.platform.session);
    expect(ctx.world.id).toBeNull();
    expect(ctx.self.id).toBe('door-1');
    expect(ctx.kind).toBe('behavior');
    expect(loose['__scratch']).toEqual({ n: 1 });
    const ui = w.k.createUiCtx() as unknown as Record<string, unknown>;
    expect(() => {
      for (const member of ['session', 'world', 'self', 'kind', 'view']) ui[member] = null;
    }).not.toThrow();
    expect((ui['world'] as { id: string }).id).toBeNull();
  });

  it('place is the row\'s current place, resolved on each read', async () => {
    const w = await ctxWorld({ modules: { [DOOR]: {} } });
    const id = w.spawn('door-1', { behavior: DOOR, place: 'p1' });
    const ctx = w.ctx(id);
    const p1 = ctx.place;
    expect(p1.id).toBe('p1');
    expect(ctx.place).toBe(p1);
    expect(p1).toBe(ctx.world.places['p1']);
    w.k.store.movePlace(w.row(id), 'p2');
    expect(ctx.place.id).toBe('p2');
    expect(ctx.place).toBe(ctx.world.places['p2']);
  });

  it('player is the human on client-VM rows and null on platform rows; isLocal follows the VM', async () => {
    const w = await ctxWorld({ modules: { ...PLAYER_MODULES, [BOT]: {}, 'scripts/gore.js': {} } });
    const bot = w.ctx(w.spawn('bot-1', { behavior: BOT, simulatedBy: 'platform', place: 'p1' }));
    expect(bot.player).toBeNull();
    expect(bot.world.players).toEqual([]);
    w.human('p1');
    const body = w.ctx(HUMAN_BODY_ID);
    const local = w.ctx(body.spawn({ behavior: 'scripts/gore.js' }));
    expect(body.player).toBe(body.self);
    expect((body.player as PlayerView).isLocal).toBe(true);
    expect(local.player).toBe(body.self);
    expect(bot.player).toBeNull();
    // scripts/audio/sfx.js:27 `listenerOf`: a platform row sees no local listener
    const fromPlatform = bot.world.players as PlayerView[];
    expect(fromPlatform).toHaveLength(1);
    expect(fromPlatform[0]!.isLocal).toBe(false);
    expect(fromPlatform.find((p) => p.isLocal)).toBeUndefined();
    expect((body.world.players as PlayerView[]).find((p) => p.isLocal)!.id).toBe(HUMAN_BODY_ID);
  });

  it('now is the tick clock, constant within a tick; random is the room stream; view.camera is null before the first frame', async () => {
    const times: number[] = [];
    const w = await ctxWorld({ seed: 99, modules: { [DOOR]: { update: (ctx: BehaviorCtx) => void times.push(ctx.now(), ctx.now()) } } });
    const twin = await ctxWorld({ seed: 99, modules: { [DOOR]: {} } });
    const ctx = w.ctx(w.spawn('door-1', { behavior: DOOR, place: 'p1' }));
    const other = twin.ctx(twin.spawn('door-1', { behavior: DOOR, place: 'p1' }));
    w.ticks(3);
    expect(times).toHaveLength(6);
    expect(times[0]).toBe(times[1]);
    expect(times[2]! - times[0]!).toBeCloseTo(1000 / 30, 9);
    expect(ctx.now()).toBe(1_000_000 + w.k.clock.tick * (1000 / 30));
    expect([ctx.random(), ctx.random(), ctx.random()]).toEqual([other.random(), other.random(), other.random()]);
    expect(ctx.view.camera).toBeNull();
    expect(ctx.getObjectSocket('door-1', 'muzzle')).toBeNull();
  });

  it('log, warn and error print with the script path and fold identical lines', async () => {
    const w = await ctxWorld({ modules: { [DOOR]: {}, [BOT]: {} } });
    const door = w.ctx(w.spawn('door-1', { behavior: DOOR, place: 'p1' }));
    const bot = w.ctx(w.spawn('bot-1', { behavior: BOT, place: 'p1' }));
    door.log('opened', { by: 'bot-1' });
    for (let i = 0; i < 5; i++) door.warn('stuck');
    bot.warn('stuck');
    bot.error('boom');
    expect(w.logged.map((l) => `${l.level} ${l.text}`)).toEqual([`log [${DOOR}] opened`, `warn [${DOOR}] stuck`, `warn [${BOT}] stuck`, `error [${BOT}] boom`]);
    expect(w.logged[0]!.data).toEqual({ by: 'bot-1' });
    expect(w.k.log.suppressed).toBe(4);
    const lines = w.k.log.lines;
    expect(lines.map((l) => [l.script, l.message, l.count])).toEqual([[DOOR, 'opened', 1], [DOOR, 'stuck', 5], [BOT, 'stuck', 1], [BOT, 'boom', 1]]);
  });
});

describe('ctx log: the ring buffer and the rate limit', () => {
  it('keeps the last N lines and prints an identical line again after 5 s, with the count of the folded ones', () => {
    let wall = 0;
    const out: string[] = [];
    const sink = { log: (t: string) => void out.push(t), warn: (t: string) => void out.push(t), error: (t: string) => void out.push(t) };
    const log = new CtxLog({ ring: 3, wallClock: () => wall, sink, tick: () => 7 });
    log.write('warn', 'a.js', 'x');
    log.write('warn', 'a.js', 'x');
    log.write('warn', 'a.js', 'x');
    wall = 4999;
    log.write('warn', 'a.js', 'x');
    expect(out).toEqual(['[a.js] x']);
    wall = 5000;
    log.write('warn', 'a.js', 'x');
    expect(out).toEqual(['[a.js] x', '[a.js] x (3 more since the last report)']);
    // different data is a different line
    log.write('log', 'a.js', 'y', { n: 1 });
    log.write('log', 'a.js', 'y', { n: 2 });
    log.write('log', 'a.js', 'y', { n: 2 });
    expect(out).toHaveLength(4);
    log.write('error', 'b.js', 'z');
    expect(log.lines.map((l) => `${l.script} ${l.message} ${l.tick}`)).toEqual(['a.js y 7', 'a.js y 7', 'b.js z 7']);
    expect(log.lines).toHaveLength(3);
    // a non-string message is printed as data
    log.write('log', 'c.js', { a: 1 });
    expect(out[out.length - 1]).toBe('[c.js] {"a":1}');
  });
});

describe('behavior ctx: verbs', () => {
  it('spawn lands on the spawner\'s VM, owned by the row; simulatedBy:"platform" overrides; a refusal throws SpawnRefused', async () => {
    const w = await ctxWorld({ modules: { ...PLAYER_MODULES, [BOT]: {} } });
    w.human('p1');
    const body = w.ctx(HUMAN_BODY_ID);
    const bot = w.ctx(w.spawn('bot-1', { behavior: BOT, simulatedBy: 'platform', place: 'p1' }));
    const corpse = body.spawn({ tags: ['corpse'] });
    const hazard = body.spawn('hazard-1', { tags: ['hazard'], simulatedBy: 'platform' });
    const held = bot.spawn({ parent: 'bot-1', tags: ['held'] });
    expect(w.row(corpse)).toMatchObject({ vm: 'client', spawnerId: HUMAN_BODY_ID, place: 'p1' });
    expect(w.row(hazard)).toMatchObject({ vm: 'platform', spawnerId: HUMAN_BODY_ID });
    expect(w.row(held)).toMatchObject({ vm: 'platform', spawnerId: 'bot-1', parentId: 'bot-1' });
    expect(body.spawn('hazard-1', { tags: ['again'] })).toBe('hazard-1'); // duplicate id: a no-op (D-CORE-06)
    let caught: unknown;
    try {
      body.spawn({ template: 'templates/none.js#nothing' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).name).toBe('SpawnRefused');
    expect((caught as Error).message).toMatch(/^spawn refused: /);
    expect(w.k.metrics.spawnRefused).toBe(1);
    // destroy with no argument is the row itself; the cascade takes what it spawned
    bot.destroy();
    expect(w.k.store.has('bot-1')).toBe(false);
    expect(w.k.store.has(held)).toBe(false);
  });

  it('emit: a custom event carries the row as meta.sourceId; playSound and fx return their act ids at once', async () => {
    const heard: EventMeta[] = [];
    const w = await ctxWorld({ modules: { [DOOR]: {}, [BOT]: { ears: { 'ss:hit': (_c: unknown, _p: unknown, meta: EventMeta) => void heard.push(meta) } } } });
    const door = w.ctx(w.spawn('door-1', { behavior: DOOR, place: 'p1' }));
    w.spawn('bot-1', { behavior: BOT, place: 'p1' });
    door.emit('ss:hit', { dmg: 1 }, { to: 'bot-1' });
    w.boundary();
    expect(heard).toEqual([{ name: 'ss:hit', sourceId: 'door-1', placeId: 'p1', to: 'bot-1' }]);
    const snd = door.emit('playSound', { clip: '/cdn/a.mp3' });
    const fx = door.emit('fx', { script: 'fx\npop a' });
    expect(snd).toMatch(/^snd-\d+$/);
    expect(fx).toMatch(/^fx-\d+$/);
    expect(door.emit('screenShake', { amount: 1 })).toBeUndefined();
    expect(() => door.destroy(fx)).not.toThrow(); // an act id ends the act, it is not a row
  });

  it('after: due at tick + max(1, ceil(seconds·30)), called with the owner\'s ctx and a copy of the payload; getTimers and cancel', async () => {
    const fired: Array<{ ctx: unknown; payload: unknown; tick: number }> = [];
    const w = await ctxWorld({
      modules: { [DOOR]: { kickShard: (ctx: BehaviorCtx, payload: unknown) => void fired.push({ ctx, payload, tick: w.k.clock.tick }) } },
    });
    const ctx = w.ctx(w.spawn('door-1', { behavior: DOOR, place: 'p1' }));
    w.ticks(1);
    const t0 = w.k.clock.tick;
    const payload = { id: 'shard-1', impulse: { x: 1, y: 2, z: 3 } };
    const a = ctx.after(0.5, 'kickShard', payload);
    const b = ctx.after(0, 'kickShard', 'soon');
    const c = ctx.after(2, 'kickShard');
    payload.impulse.x = 99; // the timer keeps the copy taken at `after`
    expect(ctx.getTimers().map((t) => [t.id, t.ownerId, t.dueInTicks, t.hook])).toEqual([
      [b, 'door-1', 1, 'kickShard'],
      [a, 'door-1', 15, 'kickShard'],
      [c, 'door-1', 60, 'kickShard'],
    ]);
    expect(ctx.getTimers('door-1')).toHaveLength(3);
    expect(ctx.getTimers('someone-else')).toEqual([]);
    ctx.cancel(c);
    w.ticks(15);
    expect(fired.map((f) => [f.tick - t0, f.payload])).toEqual([
      [1, 'soon'],
      [15, { id: 'shard-1', impulse: { x: 1, y: 2, z: 3 } }],
    ]);
    expect(fired.every((f) => f.ctx === ctx)).toBe(true);
    w.ticks(60);
    expect(fired).toHaveLength(2);
    expect(ctx.getTimers()).toEqual([]);
  });

  it('after: a missing export is reported at `after` time and never scheduled; the id is still returned', async () => {
    const report = vi.spyOn(console, 'error').mockImplementation(() => {});
    const w = await ctxWorld({ modules: { [DOOR]: {} } });
    const ctx = w.ctx(w.spawn('door-1', { behavior: DOOR, place: 'p1' }));
    const id = ctx.after(1, 'nothingHere', {});
    expect(id).toMatch(/^timer-\d+$/);
    expect(report).toHaveBeenCalledTimes(1);
    expect(String(report.mock.calls[0]![0])).toContain(`[${DOOR}] ctx.after(1, "nothingHere")`);
    expect(ctx.getTimers()).toEqual([]);
    expect(() => w.ticks(40)).not.toThrow();
  });

  it('a hook that throws is logged and counted, and the ctx keeps working (D-CORE-15)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let n = 0;
    const w = await ctxWorld({
      modules: {
        [DOOR]: {
          update: (ctx: BehaviorCtx) => {
            n++;
            ctx.self.state['n'] = n;
            if (n === 1) throw new Error('first tick');
          },
        },
      },
    });
    const id = w.spawn('door-1', { behavior: DOOR, place: 'p1' });
    w.ticks(3);
    expect(n).toBe(3);
    expect(w.row(id).state['n']).toBe(3);
    expect(w.k.metrics.hookErrors).toBe(1);
    expect(w.ctx(id).self.behaviorHealth?.broken[0]).toMatchObject({ hook: 'update', script: DOOR, error: 'first tick' });
  });
});

describe('the factories need no place manager', () => {
  it('a kernel whose `places` is not wired builds every ctx and every handle', async () => {
    const w = await ctxWorld({ modules: { ...PLAYER_MODULES, [BOT]: {}, 'scripts/camera.js': {} } });
    expect(() => w.k.places).toThrow(KernelNotWiredError);
    w.human('p1');
    w.spawn('bot-1', { behavior: BOT, simulatedBy: 'platform', place: 'p2' });
    w.rig('scripts/camera.js');
    const ctxs = [w.ctx(HUMAN_BODY_ID), w.ctx('bot-1'), w.rigCtx(), w.simCtx(null), w.simCtx('p2')];
    for (const ctx of ctxs) {
      expect(() => {
        const world = ctx.world;
        const place = ctx.place;
        void [world.state, world.players, world.places['p1'], world.defaultPlace, world.files, world.assets['x'], world.camera, world.inputs, world.engine, world.settling];
        void [place.id, place.players, place.objects, place.state, place.atmosphere, place.gravity, place.terrain, place.defaultSpawnPoint, place.worldBounds];
        void [ctx.session, ctx.view.camera, ctx.files.read('x')];
        ctx.query({ tags: ['x'] });
        ctx.getObject('bot-1');
        ctx.cross('bot-1', '+p2');
      }).not.toThrow();
    }
    expect(() => w.k.createUiCtx().world.places['p2']!.state).not.toThrow();
    expect(() => w.k.stepRig(1 / 60, { axes: {}, held: {}, pressed: {}, released: {}, actions: {} })).not.toThrow();
    expect(w.k.settling).toBe(false);
  });
});
