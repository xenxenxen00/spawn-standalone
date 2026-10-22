// The event bus and the engine acts (docs/design/core-runtime.md §8, D-CORE-08; docs/architecture.md X-12, X-24; contract §6):
// the routing matrix of §8.4 (every audience spelling × same/other place × platform/client × sims), `to` wins, FIFO across
// nested emits, a copy per receiver, `once`, unsubscribe, meta.sourceId for rows, kit ctx and sims, the drain cap, dead
// targets; act ids minted and returned for every playSound / fx (also filtered or unhandled) and the §8.6 visibility table.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ACT_NAMES,
  ActRouterImpl,
  isActName,
  normalizeAudience,
  normalizeEmitOptions,
  presentable,
  type HumanView,
} from '../../../src/compat/core/events/acts.ts';
import { ListenerRegistry } from '../../../src/compat/core/events/listeners.ts';
import { ACT_NAMES as RULES_ACT_NAMES, ENGINE } from '../../../src/compat/core/rules.ts';
import { createKernelMetrics } from '../../../src/compat/core/kernel.ts';
import type { ActEnvelope } from '../../../src/compat/core/ports.ts';
import type { EmitOptions, EventMeta, NormalisedAudience, RowRec, SimInstance } from '../../../src/compat/core/types.ts';
import { FakeWorld, type MiniCtx, type TestModule, type WorldOpts } from './fakes/tick-world.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

// ── the routing matrix (core §8.4) ───────────────────────────────────────────────────────────────────────────────────────

/**
 * The scene: default place P (the root sim's place), a second resident place Q, both VMs in each, a place-less row, the
 * root sim and a sim per place. Every one of them listens to `e`; `deliver(emit)` answers who heard it, in delivery order.
 */
function matrixWorld(opts: WorldOpts = {}) {
  const w = new FakeWorld({ defaultPlace: 'P', active: 'P', ...opts });
  const heard: string[] = [];
  const ear = (who: string) => (_c: unknown, _p: unknown, meta: EventMeta) => heard.push(`${who}<${meta.sourceId ?? 'null'}`);
  const listen = (id: string, place: string | null, vm: 'platform' | 'client', pos = { x: 0, y: 0, z: 0 }): RowRec =>
    w.spawn(id, { place, vm, pos, behaviors: [[`scripts/${id}.js`, { ears: { e: ear(id) } } as TestModule]] });
  const pP = listen('pP', 'P', 'platform', { x: 0, y: 0, z: 0 });
  listen('cP', 'P', 'client', { x: 10, y: 0, z: 0 });
  listen('farP', 'P', 'platform', { x: 100, y: 0, z: 0 });
  listen('pQ', 'Q', 'platform');
  listen('cQ', 'Q', 'client');
  listen('noPlace', null, 'platform');
  w.spawn('player/local', { place: 'P', vm: 'client', player: { userId: 'pg-42' }, pos: { x: 5, y: 0, z: 0 } });
  const root = w.addSim('sim', null, {});
  const simP = w.addSim('sim:P', 'P', {});
  const simQ = w.addSim('sim:Q', 'Q', {});
  for (const s of [root, simP, simQ]) w.time.listeners.on({ kind: 'sim', sim: s }, 'e', ear(s.id));
  w.k.runTicks(1); // onSpawn of every row
  const deliver = (fn: () => unknown): string[] => {
    heard.length = 0;
    fn();
    w.k.bus.drain();
    return [...heard];
  };
  const fromRow = (row: RowRec, opts?: EmitOptions) => () => w.k.bus.emit({ kind: 'row', row, behavior: row.behaviors[0]! }, 'e', null, opts);
  const fromSim = (sim: SimInstance, opts?: EmitOptions) => () => w.k.bus.emit({ kind: 'sim', sim }, 'e', null, opts);
  return { w, deliver, fromRow, fromSim, pP, root, simP, simQ, row: (id: string) => w.rows.get(id)! };
}

describe('routing matrix (core §8.4)', () => {
  it('default reach: the source place\'s rows (both VMs), its place sim, and the root sim when it is the default place', () => {
    const m = matrixWorld();
    expect(m.deliver(m.fromRow(m.pP))).toEqual(['pP<pP', 'cP<pP', 'farP<pP', 'sim<pP', 'sim:P<pP']);
    expect(m.deliver(m.fromRow(m.row('cQ')))).toEqual(['pQ<cQ', 'cQ<cQ', 'sim:Q<cQ']); // Q is not the default place
    expect(m.deliver(m.fromRow(m.row('noPlace')))).toEqual(['noPlace<noPlace']);
  });

  it('default reach with opts.place: that place instead of the source\'s', () => {
    const m = matrixWorld();
    expect(m.deliver(m.fromRow(m.pP, { place: 'Q' }))).toEqual(['pQ<pP', 'cQ<pP', 'sim:Q<pP']);
  });

  it('a sim\'s default emit: the root sim stands in the default place, a place sim in its place; sourceId is null', () => {
    const m = matrixWorld();
    expect(m.deliver(m.fromSim(m.root))).toEqual(['pP<null', 'cP<null', 'farP<null', 'sim<null', 'sim:P<null']);
    expect(m.deliver(m.fromSim(m.simQ))).toEqual(['pQ<null', 'cQ<null', 'sim:Q<null']);
  });

  it('ENGINE_RULES.defaultEmitReachesSims: samePlace (default), all, none', () => {
    const all = matrixWorld({ rules: { defaultEmitReachesSims: 'all' } });
    expect(all.deliver(all.fromRow(all.row('cQ')))).toEqual(['pQ<cQ', 'cQ<cQ', 'sim<cQ', 'sim:P<cQ', 'sim:Q<cQ']);
    const none = matrixWorld({ rules: { defaultEmitReachesSims: 'none' } });
    expect(none.deliver(none.fromRow(none.pP))).toEqual(['pP<pP', 'cP<pP', 'farP<pP']);
  });

  it('audience all ({kind:"all"} or "all"): every row of every resident place, both VMs, place-less rows, every sim', () => {
    const m = matrixWorld();
    const everyone = ['pP<cQ', 'cP<cQ', 'farP<cQ', 'pQ<cQ', 'cQ<cQ', 'noPlace<cQ', 'sim<cQ', 'sim:P<cQ', 'sim:Q<cQ'];
    expect(m.deliver(m.fromRow(m.row('cQ'), { audience: { kind: 'all' } }))).toEqual(everyone);
    expect(m.deliver(m.fromRow(m.row('cQ'), { audience: 'all' }))).toEqual(everyone);
  });

  it('audience place ({kind:"place", placeId?} or {place}): that place\'s rows and its place sim (default: the source place)', () => {
    const m = matrixWorld();
    const q = ['pQ<pP', 'cQ<pP', 'sim:Q<pP'];
    expect(m.deliver(m.fromRow(m.pP, { audience: { kind: 'place', placeId: 'Q' } }))).toEqual(q);
    expect(m.deliver(m.fromRow(m.pP, { audience: { place: 'Q' } }))).toEqual(q);
    expect(m.deliver(m.fromRow(m.pP, { audience: { kind: 'place' } }))).toEqual(['pP<pP', 'cP<pP', 'farP<pP', 'sim:P<pP']);
  });

  it('audience nearby ({kind:"nearby", position, radius?} or {nearby, radius}): rows of the source place within radius (3D), no sims', () => {
    const m = matrixWorld();
    const at = { x: 1, y: 0, z: 0 };
    expect(m.deliver(m.fromRow(m.pP, { audience: { kind: 'nearby', position: at, radius: 10 } }))).toEqual(['pP<pP', 'cP<pP']);
    expect(m.deliver(m.fromRow(m.pP, { audience: { nearby: at, radius: 2 } }))).toEqual(['pP<pP']);
    expect(m.deliver(m.fromRow(m.pP, { audience: { nearby: { x: 1, y: 30, z: 0 }, radius: 10 } }))).toEqual([]);
    // no radius: the whole source place
    expect(m.deliver(m.fromRow(m.pP, { audience: { kind: 'nearby', position: at } }))).toEqual(['pP<pP', 'cP<pP', 'farP<pP']);
  });

  it('audience player ({kind:"player", id} or {player: id}): the listeners of the VM that simulates the human (client), any place', () => {
    const m = matrixWorld();
    const client = ['cP<pP', 'cQ<pP'];
    for (const id of ['player/local', 'pg-42']) {
      expect(m.deliver(m.fromRow(m.pP, { audience: { kind: 'player', id } })), id).toEqual(client);
      expect(m.deliver(m.fromRow(m.pP, { audience: { player: id } })), id).toEqual(client);
    }
    expect(m.deliver(m.fromRow(m.pP, { audience: { player: 'bot-1' } }))).toEqual([]); // bots are not players
  });

  it('`to` wins over audience: only the target row\'s listeners, wherever it stands', () => {
    const m = matrixWorld();
    expect(m.deliver(m.fromRow(m.pP, { to: 'cQ' }))).toEqual(['cQ<pP']);
    expect(m.deliver(m.fromRow(m.pP, { to: 'cQ', audience: { kind: 'all' } }))).toEqual(['cQ<pP']);
    expect(m.deliver(m.fromSim(m.root, { to: 'noPlace' }))).toEqual(['noPlace<null']);
  });

  it('a malformed audience routes to nobody, with one warning per event name', () => {
    const m = matrixWorld();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(m.deliver(m.fromRow(m.pP, { audience: { kind: 'galaxy' } as never }))).toEqual([]);
    expect(m.deliver(m.fromRow(m.pP, { audience: 'everyone' as never }))).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('`via` is ignored with a warning (cross-world portals are not ported)', () => {
    const m = matrixWorld();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(m.deliver(m.fromRow(m.pP, { via: 'portal-1', to: 'pP' }))).toEqual(['pP<pP']);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('ctx.on(…, {place}): the listener also requires the event\'s place', () => {
    const m = matrixWorld();
    const heard: string[] = [];
    const sim = m.root;
    m.w.time.listeners.on({ kind: 'sim', sim }, 'e', () => heard.push('filtered-Q'), { place: 'Q' });
    m.deliver(m.fromRow(m.pP, { audience: { kind: 'all' } }));
    expect(heard).toEqual([]);
    m.deliver(m.fromRow(m.row('pQ'), { audience: { kind: 'all' } }));
    expect(heard).toEqual(['filtered-Q']);
  });

  it('listeners follow their row across places', () => {
    const m = matrixWorld();
    m.row('cQ').place = 'P';
    expect(m.deliver(m.fromRow(m.pP))).toEqual(['pP<pP', 'cP<pP', 'farP<pP', 'cQ<pP', 'sim<pP', 'sim:P<pP']);
  });

  it('listeners of rows in non-resident places never hear (residency comes from the place manager)', () => {
    const m = matrixWorld();
    m.w.time.use({ isResident: (p) => p !== 'Q' });
    expect(m.deliver(m.fromRow(m.pP, { audience: 'all' }))).toEqual(['pP<pP', 'cP<pP', 'farP<pP', 'noPlace<pP', 'sim<pP', 'sim:P<pP', 'sim:Q<pP']);
  });
});

describe('queue and delivery (core §8.3, §8.5)', () => {
  it('is FIFO at the phase boundary; events emitted by handlers join the same drain after what was queued', () => {
    const w = new FakeWorld();
    const order: string[] = [];
    const mod: TestModule = {
      ears: {
        a: (ctx: MiniCtx) => {
          order.push('a');
          ctx.emit('c');
        },
        b: () => order.push('b'),
        c: () => order.push('c'),
      },
    };
    const r = w.spawn('r', { behaviors: [['scripts/r.js', mod]] });
    w.k.runTicks(1);
    const ctx = w.ctxOf(r);
    ctx.emit('a');
    ctx.emit('b');
    expect(w.k.bus.pending).toBe(2);
    expect(order).toEqual([]); // queued: nothing runs inside emit
    expect(w.k.bus.drain()).toBe(3);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(w.k.bus.pending).toBe(0);
  });

  it('copies the payload at emit and gives every receiver its own copy (a receiver\'s mutation does not leak)', () => {
    const w = new FakeWorld();
    const got: unknown[] = [];
    const ear = (_c: unknown, p: { hp: number; tags: string[] }) => {
      got.push(JSON.parse(JSON.stringify(p)));
      p.hp = -1;
      p.tags.push('x');
    };
    for (const id of ['a', 'b', 'c']) w.spawn(id, { behaviors: [[`scripts/${id}.js`, { ears: { hit: ear } } as TestModule]] });
    w.k.runTicks(1);
    const payload = { hp: 10, tags: ['t'] };
    w.ctxOf(w.rows.get('a')!).emit('hit', payload, { audience: 'all' });
    payload.hp = 0;
    w.k.bus.drain();
    expect(got).toEqual([{ hp: 10, tags: ['t'] }, { hp: 10, tags: ['t'] }, { hp: 10, tags: ['t'] }]);
  });

  it('a once listener is removed before it runs; an unsubscribe really removes and is idempotent', () => {
    const w = new FakeWorld();
    const r = w.spawn('r', { behaviors: [['scripts/r.js', {}]] });
    w.k.runTicks(1);
    const ctx = w.ctxOf(r);
    const heard: string[] = [];
    ctx.on('x', () => {
      heard.push('once');
      ctx.emit('x');
    }, { once: true });
    const off = ctx.on('x', () => heard.push('on'));
    ctx.emit('x');
    w.k.bus.drain();
    expect(heard).toEqual(['once', 'on', 'on']);
    off();
    off();
    ctx.emit('x');
    w.k.bus.drain();
    expect(heard).toEqual(['once', 'on', 'on']);
    expect(w.time.listeners.ofRow('r')).toEqual([]);
  });

  it('an unsubscribe during delivery stops the pending call; a listener added during delivery does not hear this event', () => {
    const w = new FakeWorld();
    const r = w.spawn('r', { behaviors: [['scripts/r.js', {}]] });
    w.k.runTicks(1);
    const ctx = w.ctxOf(r);
    const heard: string[] = [];
    let offB = (): void => {};
    ctx.on('x', () => {
      heard.push('a');
      offB();
      ctx.on('x', () => heard.push('late'));
    });
    offB = ctx.on('x', () => heard.push('b'));
    ctx.emit('x');
    w.k.bus.drain();
    expect(heard).toEqual(['a']);
  });

  it('meta.sourceId is the row of the ctx used: a body behavior, an enemy kit ctx called from elsewhere, null for sims', () => {
    const w = new FakeWorld();
    const metas: EventMeta[] = [];
    const sim = w.addSim('sim', null, {});
    w.time.listeners.on({ kind: 'sim', sim }, 'ss:req', (_c: unknown, _p: unknown, m: EventMeta) => metas.push(m));
    const body = w.spawn('player/local', { vm: 'client', player: { userId: 'u' }, behaviors: [['scripts/player/intent.js', {}]] });
    const enemy = w.spawn('en-1-0001', { behaviors: [['scripts/enemies/enemy.js', {}]] });
    w.k.runTicks(1);
    const kit = { ctx: w.ctxOf(enemy) }; // scripts/enemies/kit.js keeps the enemy's ctx as k.ctx
    w.ctxOf(body).emit('ss:req', { op: 'ready' }, { audience: { kind: 'all' } });
    // a hook of another row calling through the kit: the emit is still the enemy's
    w.time.invoker.call({ kind: 'row', row: body, inst: body.behaviors[0]! }, 'update', () => kit.ctx.emit('ss:req', {}, { audience: 'all' }), []);
    (sim.ctx as unknown as MiniCtx).emit('ss:req', {}, { audience: 'all' });
    w.k.bus.drain();
    expect(metas.map((m) => [m.name, m.sourceId, m.placeId])).toEqual([
      ['ss:req', 'player/local', 'p1'],
      ['ss:req', 'en-1-0001', 'p1'],
      ['ss:req', null, 'p1'],
    ]);
    expect(metas[0]).not.toHaveProperty('to');
  });

  it('meta carries `to` for a targeted emit', () => {
    const w = new FakeWorld();
    const metas: EventMeta[] = [];
    const t = w.spawn('t', { behaviors: [['scripts/map/terminal.js', { ears: { press: (_c: unknown, _p: unknown, m: EventMeta) => metas.push(m) } } as TestModule]] });
    w.k.runTicks(1);
    w.ctxOf(t).emit('press', { by: 'bot-1' }, { to: 't' });
    w.k.bus.drain();
    expect(metas).toEqual([{ name: 'press', sourceId: 't', placeId: 'p1', to: 't' }]);
  });

  it('drops an event addressed to a row that is dead at delivery (counted)', () => {
    const w = new FakeWorld();
    const heard = vi.fn();
    const r = w.spawn('r', { behaviors: [['scripts/r.js', { ears: { x: heard } } as TestModule]] });
    w.spawn('s', { behaviors: [['scripts/s.js', {}]] });
    w.k.runTicks(1);
    w.ctxOf(w.rows.get('s')!).emit('x', null, { to: 'r' });
    w.ctxOf(w.rows.get('s')!).emit('x', null, { to: 'nobody' });
    w.destroy('r');
    w.k.bus.drain();
    expect(heard).not.toHaveBeenCalled();
    expect(w.k.metrics.eventsUndelivered).toBe(2);
    expect(r.phase).toBe('dead');
  });

  it('stops a drain at the cap; the rest waits for the next boundary (an emit loop cannot hang a frame)', () => {
    const w = new FakeWorld();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let n = 0;
    const r = w.spawn('loop', { behaviors: [['scripts/loop.js', { ears: { ping: (ctx: MiniCtx) => (n++, ctx.emit('ping')) } } as TestModule]] });
    w.k.runTicks(1);
    w.ctxOf(r).emit('ping');
    expect(w.k.bus.drain(5)).toBe(5);
    expect(n).toBe(5);
    expect(w.k.bus.pending).toBe(1);
    expect(w.k.metrics.drainCapHits).toBe(1);
    expect(warn).toHaveBeenCalled();
    n = 0;
    w.k.runTicks(1); // every boundary drains up to DRAIN_CAP
    expect(n).toBe(ENGINE.DRAIN_CAP * 6); // B, C, D, E, F, G boundaries: each stops at the cap
    expect(w.k.bus.pending).toBe(1);
  });

  it('counts delivered events', () => {
    const w = new FakeWorld();
    const r = w.spawn('r', { behaviors: [['scripts/r.js', { ears: { a: () => {} } } as TestModule]] });
    w.k.runTicks(1);
    w.ctxOf(r).emit('a');
    w.ctxOf(r).emit('nobody-listens');
    w.k.bus.drain();
    expect(w.k.metrics.eventsDelivered).toBe(2);
  });

  it('refuses a nameless emit', () => {
    const w = new FakeWorld();
    const r = w.spawn('r', { behaviors: [['scripts/r.js', {}]] });
    expect(() => w.ctxOf(r).emit('')).toThrow(TypeError);
    expect(() => w.ctxOf(r).emit(undefined as unknown as string)).toThrow(TypeError);
  });

  it('a throwing handler is recorded on its owner and delivery continues', () => {
    const w = new FakeWorld();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const heard: string[] = [];
    w.spawn('a', { behaviors: [['scripts/a.js', { ears: { x: () => { throw new Error('ear bug'); } } } as TestModule]] });
    w.spawn('b', { behaviors: [['scripts/b.js', { ears: { x: () => heard.push('b') } } as TestModule]] });
    w.k.runTicks(1);
    w.ctxOf(w.rows.get('a')!).emit('x');
    w.k.bus.drain();
    expect(heard).toEqual(['b']);
    expect(w.rows.get('a')!.behaviors[0]!.health.get('ears.x')).toMatchObject({ error: 'ear bug', count: 1 });
  });
});

// ── engine acts (core §8.6, X-12) ───────────────────────────────────────────────────────────────────────────────────────

describe('act ids (X-12): minted and returned for every playSound and fx', () => {
  it('re-exports the act table of rules.ts', () => {
    expect(ACT_NAMES).toBe(RULES_ACT_NAMES);
    expect(isActName('fx')).toBe(true);
    expect(isActName('ss:hurt')).toBe(false);
  });

  it('returns snd-<n> / fx-<n> whether handled, filtered or unhandled; other acts return undefined', () => {
    const w = new FakeWorld();
    const got: ActEnvelope[] = [];
    w.spawn('player/local', { vm: 'client', player: { userId: 'u' } });
    const r = w.spawn('r', { behaviors: [['scripts/r.js', {}]] });
    const elsewhere = w.spawn('q', { place: 'p2', behaviors: [['scripts/q.js', {}]] });
    w.k.acts.register('playSound', (a) => got.push(a));
    const ctx = w.ctxOf(r);
    const handled = ctx.emit('playSound', { clip: 'cdn/a.mp3' });
    const filtered = w.ctxOf(elsewhere).emit('playSound', { clip: 'cdn/b.mp3' });
    const unhandledFx = ctx.emit('fx', { script: 'fx …' });
    const fx2 = ctx.emit('fx', { script: 'fx …' }, { audience: { player: 'someone-else' } });
    expect([handled, filtered, unhandledFx, fx2]).toEqual(['snd-1', 'snd-2', 'fx-1', 'fx-2']);
    expect(got.map((a) => a.id)).toEqual(['snd-1']);
    expect(w.k.metrics.actsFiltered).toBe(2);
    expect(w.k.metrics.actsUnhandled).toBe(1);
    for (const name of ['decal', 'screenShake', 'cameraPunch', 'screenFlash', 'hitstop', 'shake', 'impulse', 'shockwave', 'damageNumber', 'uiEvent', 'stopSound'] as const) {
      expect(ctx.emit(name, {}), name).toBe(undefined);
    }
  });

  it('runs the handler synchronously inside emit with the envelope (payload cloned at emit), never queues an act', () => {
    const w = new FakeWorld();
    w.spawn('player/local', { vm: 'client', player: { userId: 'u' } });
    const r = w.spawn('r', { behaviors: [['scripts/r.js', {}]] });
    const seen: ActEnvelope[] = [];
    w.k.acts.register('fx', (a) => seen.push(a));
    const p = { position: { x: 1, y: 2, z: 3 }, script: 'fx pop' };
    const id = w.ctxOf(r).emit('fx', p, { audience: { kind: 'place' }, place: 'p1' });
    p.position.x = 9;
    expect(seen).toHaveLength(1);
    expect(w.k.bus.pending).toBe(0);
    expect(seen[0]).toEqual({
      name: 'fx',
      payload: { position: { x: 1, y: 2, z: 3 }, script: 'fx pop' },
      id,
      sourceId: 'r',
      sourcePlace: 'p1',
      audience: { kind: 'place', placeId: null },
      place: 'p1',
    });
  });

  it('ignores slowMo and counts it (DR-17; no live emit)', () => {
    const w = new FakeWorld();
    const r = w.spawn('r', { behaviors: [['scripts/r.js', {}]] });
    const h = vi.fn();
    w.k.acts.register('slowMo', h);
    expect(w.ctxOf(r).emit('slowMo', { scale: 0.3, duration: 1 })).toBe(undefined);
    expect(h).not.toHaveBeenCalled();
    expect(w.k.metrics.slowMoIgnored).toBe(1);
  });

  it('one handler per act: a second registration replaces the first and is counted; unregister is precise', () => {
    const w = new FakeWorld();
    w.spawn('player/local', { vm: 'client', player: { userId: 'u' } });
    const r = w.spawn('r', { behaviors: [['scripts/r.js', {}]] });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const a = vi.fn();
    const b = vi.fn();
    const offA = w.k.acts.register('decal', a);
    w.k.acts.register('decal', b);
    expect(w.k.metrics.actsDoubleRegistered).toBe(1);
    expect(warn).toHaveBeenCalled();
    offA(); // stale: b stays
    w.ctxOf(r).emit('decal', {});
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
    expect(() => w.k.acts.register('nope' as never, a)).toThrow(TypeError);
  });

  it('a throwing act handler does not break the emitting hook', () => {
    const w = new FakeWorld();
    w.spawn('player/local', { vm: 'client', player: { userId: 'u' } });
    const r = w.spawn('r', { behaviors: [['scripts/r.js', {}]] });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    w.k.acts.register('playSound', () => {
      throw new Error('voice pool');
    });
    expect(w.ctxOf(r).emit('playSound', { clip: 'x' })).toBe('snd-1');
    expect(err).toHaveBeenCalled();
  });

  it('ends an act through its prefix handler (ctx.destroy("fx-12"), core §5.2); an fx attachTo row ends with that row', () => {
    const w = new FakeWorld();
    w.spawn('player/local', { vm: 'client', player: { userId: 'u' } });
    const r = w.spawn('r', { behaviors: [['scripts/r.js', {}]] });
    const target = w.spawn('en-1', { behaviors: [['scripts/e.js', {}]] });
    w.k.runTicks(1);
    const ended: string[] = [];
    w.k.acts.register('fx', () => {});
    w.k.acts.registerEnd('fx-', (id) => ended.push(id));
    const ctx = w.ctxOf(r);
    const free = ctx.emit('fx', { script: 'a' })!;
    const attached = ctx.emit('fx', { script: 'b', attachTo: 'en-1' })!;
    expect(w.k.acts.end(free)).toBe(true);
    expect(w.k.acts.end('snd-4')).toBe(false); // no snd- end handler registered
    expect(w.k.acts.end('not-an-act')).toBe(false);
    expect(ended).toEqual([free]);
    w.destroy(target.id);
    w.k.runTicks(1); // disposal at the next boundary
    expect(ended).toEqual([free, attached]);
  });

  it('attached fx follow the row record, not its id: a new row that reuses a destroyed id keeps its own fx', () => {
    const w = new FakeWorld();
    w.spawn('player/local', { vm: 'client', player: { userId: 'u' } });
    const r = w.spawn('r', { behaviors: [['scripts/r.js', {}]] });
    w.spawn('x', { behaviors: [['scripts/e.js', {}]] });
    w.k.runTicks(1);
    const ended: string[] = [];
    w.k.acts.register('fx', () => {});
    w.k.acts.registerEnd('fx-', (id) => ended.push(id));
    const ctx = w.ctxOf(r);
    const oldFx = ctx.emit('fx', { script: 'a', attachTo: 'x' })!;
    w.destroy('x'); // the id is free at once; disposal waits for the boundary
    w.spawn('x', { behaviors: [['scripts/e.js', {}]] }); // same step, same id
    const newFx = ctx.emit('fx', { script: 'b', attachTo: 'x' })!;
    w.k.runTicks(1); // the old x is disposed
    expect(ended).toEqual([oldFx]);
    w.destroy('x');
    w.k.runTicks(1);
    expect(ended).toEqual([oldFx, newFx]);
  });

  it('an fx a dying row attaches to itself in onDestroy ends with that row, even when its id was already reused', () => {
    const w = new FakeWorld();
    w.spawn('player/local', { vm: 'client', player: { userId: 'u' } });
    const fxs: string[] = [];
    const dying: TestModule = {
      onDestroy(ctx: MiniCtx) {
        fxs.push(ctx.emit('fx', { script: 'death', attachTo: ctx.self.id })!);
      },
    };
    w.spawn('x', { behaviors: [['scripts/x.js', dying]] });
    w.k.runTicks(1);
    const ended: string[] = [];
    w.k.acts.register('fx', () => {});
    w.k.acts.registerEnd('fx-', (id) => ended.push(id));
    w.destroy('x');
    w.spawn('x', { behaviors: [['scripts/e.js', {}]] });
    w.k.runTicks(1); // the old x's onDestroy emits, then it is disposed
    expect(fxs).toHaveLength(1);
    expect(ended).toEqual(fxs);
  });
});

describe('the §8.6 visibility table: presentable(act, human)', () => {
  const human: HumanView = { playerId: 'pg-42', bodyId: 'player/local', place: 'P', feet: { x: 0, y: 0, z: 0 } };
  const act = (sourcePlace: string | null, audience: NormalisedAudience | null, place: string | null = null) => ({ sourcePlace, place, audience });
  const cases: Array<[string, ReturnType<typeof act>, boolean]> = [
    ['no audience, same place', act('P', null), true],
    ['no audience, other place', act('Q', null), false],
    ['no audience, place-less source', act(null, null), true],
    ['opts.place = the human\'s', act('Q', null, 'P'), true],
    ['opts.place elsewhere', act('P', null, 'Q'), false],
    ['all, same place', act('P', { kind: 'all' }), true],
    ['all, other place', act('Q', { kind: 'all' }), false],
    ['place = the human\'s', act('P', { kind: 'place', placeId: 'P' }), true],
    ['place elsewhere', act('P', { kind: 'place', placeId: 'Q' }), false],
    ['place without id = source place', act('P', { kind: 'place', placeId: null }), true],
    ['nearby within radius', act('P', { kind: 'nearby', position: { x: 3, y: 4, z: 0 }, radius: 5 }), true],
    ['nearby outside radius (3D)', act('P', { kind: 'nearby', position: { x: 3, y: 4, z: 0.1 }, radius: 5 }), false],
    ['nearby without radius = same place', act('P', { kind: 'nearby', position: { x: 900, y: 0, z: 0 }, radius: null }), true],
    ['nearby, other place', act('Q', { kind: 'nearby', position: { x: 0, y: 0, z: 0 }, radius: 50 }), false],
    ['player = the human\'s player id', act('P', { kind: 'player', id: 'pg-42' }), true],
    ['player = the human\'s body id (juice.js passes ctx.self.id)', act('P', { kind: 'player', id: 'player/local' }), true],
    ['player = someone else', act('P', { kind: 'player', id: 'bot-3' }), false],
  ];
  for (const [name, a, ok] of cases) {
    it(`${ok ? 'presents' : 'drops'}: ${name}`, () => {
      expect(presentable(a, human)).toBe(ok);
    });
  }
  it('drops everything when there is no human', () => {
    expect(presentable(act('P', null), null)).toBe(false);
  });
  it('drops a nearby act when the human\'s feet are unknown', () => {
    expect(presentable(act('P', { kind: 'nearby', position: { x: 0, y: 0, z: 0 }, radius: 5 }), { ...human, feet: null })).toBe(false);
  });

  it('normalises every audience spelling the live game uses (contract §6.2) and flags anything else', () => {
    const pos = { x: 1, y: 2, z: 3 };
    expect(normalizeAudience(undefined)).toBe(null);
    expect(normalizeAudience(null)).toBe(null);
    expect(normalizeAudience('all')).toEqual({ kind: 'all' });
    expect(normalizeAudience({ kind: 'all' })).toEqual({ kind: 'all' });
    expect(normalizeAudience({ kind: 'player', id: 'x' })).toEqual({ kind: 'player', id: 'x' });
    expect(normalizeAudience({ player: 'x' })).toEqual({ kind: 'player', id: 'x' });
    expect(normalizeAudience({ kind: 'nearby', position: pos, radius: 60 })).toEqual({ kind: 'nearby', position: pos, radius: 60 });
    expect(normalizeAudience({ nearby: pos, radius: 30 })).toEqual({ kind: 'nearby', position: pos, radius: 30 });
    expect(normalizeAudience({ nearby: pos })).toEqual({ kind: 'nearby', position: pos, radius: null });
    expect(normalizeAudience({ kind: 'place', placeId: 'P' })).toEqual({ kind: 'place', placeId: 'P' });
    expect(normalizeAudience({ kind: 'place' })).toEqual({ kind: 'place', placeId: null });
    expect(normalizeAudience({ place: 'P' })).toEqual({ kind: 'place', placeId: 'P' });
    for (const bad of ['everyone', 7, { kind: 'galaxy' }, { kind: 'player' }, { nearby: 'here' }, { kind: 'nearby', position: pos, radius: Number.NaN }, { place: 3 }]) {
      expect(normalizeAudience(bad), JSON.stringify(bad)).toBe('invalid');
    }
    expect(normalizeEmitOptions({ to: 'a', place: 'P', via: 'v', audience: { player: 'x' } })).toEqual({
      to: 'a',
      place: 'P',
      via: 'v',
      audience: { kind: 'player', id: 'x' },
      invalidAudience: false,
    });
    expect(normalizeEmitOptions(undefined)).toEqual({ to: null, place: null, via: null, audience: null, invalidAudience: false });
    expect(normalizeEmitOptions({ audience: 'nope' }).invalidAudience).toBe(true);
  });

  it('the kernel filters with the live human: a filtered act still gets its id and is counted, a malformed audience is dropped', () => {
    const w = new FakeWorld({ defaultPlace: 'P', active: 'P' });
    w.spawn('player/local', { place: 'P', vm: 'client', player: { userId: 'pg-42' }, pos: { x: 0, y: 0, z: 0 } });
    const r = w.spawn('r', { place: 'P', behaviors: [['scripts/r.js', {}]] });
    const got: string[] = [];
    w.k.acts.register('screenShake', (a) => got.push(JSON.stringify(a.audience)));
    const ctx = w.ctxOf(r);
    ctx.emit('screenShake', { intensity: 1 }, { audience: { kind: 'player', id: 'player/local' } });
    ctx.emit('screenShake', { intensity: 1 }, { audience: { kind: 'player', id: 'other' } });
    ctx.emit('screenShake', { intensity: 1 }, { audience: { kind: 'galaxy' } as never });
    ctx.emit('screenShake', { intensity: 1 }, { audience: { nearby: { x: 0, y: 0, z: 40 }, radius: 45 } }); // spawner.js:218
    expect(got).toEqual(['{"kind":"player","id":"player/local"}', '{"kind":"nearby","position":{"x":0,"y":0,"z":40},"radius":45}']);
    expect(w.k.metrics.actsFiltered).toBe(2);
  });
});

describe('ListenerRegistry bookkeeping', () => {
  it('validates names and handlers and counts listeners', () => {
    const reg = new ListenerRegistry();
    const sim: SimInstance = { id: 'sim', place: null, path: 'sim.js', module: null, ctx: null, health: new Map() };
    expect(() => reg.add({ kind: 'sim', sim }, '', () => {})).toThrow(TypeError);
    expect(() => reg.add({ kind: 'sim', sim }, 'x', 3 as never)).toThrow(TypeError);
    const l = reg.add({ kind: 'sim', sim }, 'x', () => {});
    expect(reg.size).toBe(1);
    expect(l.vm).toBe('platform');
    expect(reg.remove(l)).toBe(true);
    expect(reg.remove(l)).toBe(false);
    expect(reg.size).toBe(0);
    expect(reg.forName('x')).toEqual([]);
  });

  it('the acts of a router without a kernel', () => {
    const metrics = createKernelMetrics();
    const router = new ActRouterImpl({ metrics, human: () => null, defaultPlace: () => null });
    expect(router.emit({ kind: 'kernel' }, 'playSound', {}, undefined)).toBe('snd-1');
    expect(metrics.actsFiltered).toBe(1);
  });
});
