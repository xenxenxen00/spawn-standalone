// The sim ctx (docs/design/core-runtime.md §7.3, §8.4, §10; mp §11.2): the root sim (the Director) and a place sim on the
// platform VM, with no self.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HUMAN_BODY_ID } from '../../../src/compat/core/ids.ts';
import type { BehaviorCtx, EventMeta, PlayerView, SimCtx } from '../../../src/compat/core/types.ts';
import { ctxWorld, PLAYER_MODULES } from './fakes/ctx-world.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

const BOT = 'scripts/bots/bot.js';

describe('sim ctx', () => {
  it('has no self, no state, no player and no sleep; gapMs is never set; one ctx per sim', async () => {
    const w = await ctxWorld({ modules: { ...PLAYER_MODULES } });
    const root = w.simCtx(null);
    const place = w.simCtx('p2');
    expect(root.kind).toBe('sim');
    for (const absent of ['self', 'state', 'player', 'sleep', 'gapMs', 'wallNow']) {
      expect(absent in root, absent).toBe(false);
      expect(absent in place, absent).toBe(false);
    }
    expect(root.gapMs).toBeUndefined();
    expect(w.simCtx(null)).toBe(root);
    expect(place).not.toBe(root);
  });

  it('place: the root sim stands in world.defaultPlace, a place sim in its own place', async () => {
    const w = await ctxWorld({ modules: {}, places: ['lobby', 'p2'], defaultPlace: 'p2' });
    expect(w.simCtx(null).place.id).toBe('p2');
    expect(w.simCtx(null).place).toBe(w.simCtx(null).world.places[w.simCtx(null).world.defaultPlace]);
    expect(w.simCtx('lobby').place.id).toBe('lobby');
  });

  it('runs on the platform VM: the platform session, isLocal false, the body\'s local rows invisible', async () => {
    const w = await ctxWorld({ modules: { ...PLAYER_MODULES, [BOT]: {} } });
    w.human('p1');
    w.spawn('bot-1', { behavior: BOT, simulatedBy: 'platform', place: 'p1' });
    const root = w.simCtx(null);
    const place = w.simCtx('p2');
    expect(root.session).toBe(w.k.vms.platform.session);
    expect(place.session).toBe(root.session);
    expect(w.ctx('bot-1').session).toBe(root.session);
    expect(w.ctx(HUMAN_BODY_ID).session).not.toBe(root.session);
    root.session['ssBot'] = { n: 1 };
    expect(w.ctx('bot-1').session['ssBot']).toEqual({ n: 1 });
    const players = root.world.players as PlayerView[];
    expect(players.map((p) => [p.id, p.isLocal])).toEqual([[HUMAN_BODY_ID, false]]);
    const probe = w.ctx(HUMAN_BODY_ID).spawn({ parent: 'bot-1', audience: 'local', tags: ['probe'] });
    expect(root.getObject(probe)).toBeNull();
    expect(root.getObject('bot-1')!.children).toEqual([]);
  });

  it('getObject answers for a row of any place; a place-less query searches the sim\'s own place', async () => {
    const w = await ctxWorld({ modules: {} });
    w.spawn('a', { place: 'p1', tags: ['lamp'] });
    w.spawn('b', { place: 'p2', tags: ['lamp'] });
    const root = w.simCtx(null);
    const p2 = w.simCtx('p2');
    expect(root.getObject('a')!.id).toBe('a');
    expect(root.getObject('b')!.id).toBe('b');
    expect(root.query({ tags: ['lamp'] }).map((o) => o.id)).toEqual(['a']);
    expect(p2.query({ tags: ['lamp'] }).map((o) => o.id)).toEqual(['b']);
    expect(root.query({ tags: ['lamp'], place: 'p2', select: 'ids' })).toEqual(['b']);
  });

  it('spawns are unowned and on the platform VM, in the sim\'s place', async () => {
    const w = await ctxWorld({ modules: { [BOT]: {} } });
    const a = w.simCtx(null).spawn('enemy-1', { behavior: BOT, tags: ['enemy'] });
    const b = w.simCtx('p2').spawn({ tags: ['roamer'] });
    expect(w.row(a)).toMatchObject({ vm: 'platform', spawnerId: null, place: 'p1' });
    expect(w.row(b)).toMatchObject({ vm: 'platform', spawnerId: null, place: 'p2' });
    // destroy from a sim needs a target: a sim has no self
    w.simCtx(null).destroy();
    expect(w.k.store.has(a)).toBe(true);
    w.simCtx(null).destroy([a, b]);
    expect(w.k.store.count).toBe(0);
  });

  it('emit: meta.sourceId is null; a row hears it with the row\'s own ctx; a sim listener gets the sim ctx', async () => {
    const heard: Array<{ who: unknown; meta: EventMeta }> = [];
    const w = await ctxWorld({ modules: { [BOT]: { ears: { 'ss:go': (ctx: BehaviorCtx, _p: unknown, meta: EventMeta) => void heard.push({ who: ctx, meta }) } } } });
    w.spawn('bot-1', { behavior: BOT, place: 'p1' });
    const root = w.simCtx(null);
    const off = root.on('ss:req', (ctx: SimCtx, payload: unknown, meta: EventMeta) => void heard.push({ who: ctx, meta: { ...meta, name: `${meta.name}:${JSON.stringify(payload)}` } }));
    root.emit('ss:go', { wave: 1 });
    w.ctx('bot-1').emit('ss:req', { op: 'ready' });
    w.boundary();
    expect(heard).toHaveLength(2);
    expect(heard[0]!.who).toBe(w.ctx('bot-1'));
    expect(heard[0]!.meta).toEqual({ name: 'ss:go', sourceId: null, placeId: 'p1' });
    expect(heard[1]!.who).toBe(root);
    expect(heard[1]!.meta).toEqual({ name: 'ss:req:{"op":"ready"}', sourceId: 'bot-1', placeId: 'p1' });
    off();
    w.ctx('bot-1').emit('ss:req', {});
    w.boundary();
    expect(heard).toHaveLength(2);
  });

  it('after: the sim owns its timers (`getTimers("sim")`), called with the sim ctx', async () => {
    const fired: unknown[] = [];
    const w = await ctxWorld({ modules: {} });
    const sim = w.sim(null, { later: (ctx: SimCtx, payload: unknown) => void fired.push([ctx, payload]) });
    const ctx = sim.ctx!;
    const id = ctx.after(0.1, 'later', { n: 1 });
    expect(ctx.getTimers('sim').map((t) => [t.id, t.ownerId, t.dueInTicks])).toEqual([[id, 'sim', 3]]);
    expect(ctx.getTimers().map((t) => t.id)).toEqual([id]);
    w.ticks(3);
    expect(fired).toEqual([[ctx, { n: 1 }]]);
  });

  it('the scheduler ticks the root sim with its ctx every third tick', async () => {
    const ticks: Array<[number, unknown]> = [];
    const w = await ctxWorld({ modules: {} });
    const sim = w.sim(null, { tick: (ctx: SimCtx) => void ticks.push([w.k.clock.tick, ctx]) });
    w.k.time.setRootSim(sim);
    w.ticks(9);
    expect(ticks.map(([t]) => t)).toEqual([2, 5, 8]);
    expect(ticks.every(([, ctx]) => ctx === sim.ctx)).toBe(true);
  });

  it('writes from a sim to the human\'s row are cross-VM writes of the platform VM', async () => {
    const w = await ctxWorld({ modules: { ...PLAYER_MODULES } });
    w.human('p1');
    const row = w.simCtx(null).world.players[0]!;
    row.spectating = true;
    row.state['live'] = { alive: false };
    expect(w.row(HUMAN_BODY_ID).spectating).toBe(true);
    expect(w.k.vms.platform.counters.crossVmWrites).toBe(2);
    expect(w.k.vms.client.counters.crossVmWrites).toBe(0);
    expect([...w.k.vms.platform.crossVmWriteFields]).toEqual([['spectating', 1], ['state', 1]]);
  });
});
