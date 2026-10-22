// The UI page ctx (docs/design/core-runtime.md §7.5, §16.1 `ui-ctx.test.ts`; docs/architecture.md X-25, X-24): the
// copy-on-write session overlay, the read-only handles, the read-only world, and the members the UI host relies on.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HUMAN_BODY_ID } from '../../../src/compat/core/ids.ts';
import { createNullPorts } from '../../../src/compat/core/null-ports.ts';
import { defaultPortUiState, makeUiCtx } from '../../../src/runtime/ui/ui-ctx.ts';
import type { ObjectView, PlayerView } from '../../../src/compat/core/types.ts';
import { ctxWorld, PLAYER_MODULES, type CtxWorld } from './fakes/ctx-world.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

async function scene(extra: Parameters<typeof ctxWorld>[0] = {}): Promise<CtxWorld> {
  const w = await ctxWorld({ modules: { ...PLAYER_MODULES }, dev: true, ...extra });
  w.human('p1', { prog: { xp: 3 } });
  return w;
}

describe('ui ctx: the session is a copy-on-write overlay of the client session', () => {
  it('reads fall through to the live client session, not the platform one', async () => {
    const w = await scene();
    w.k.vms.client.session['ui'] = { panel: 'menu', trophy: { k: 'first-blood', at: 12 } };
    w.k.vms.client.session['ssSpot'] = 3;
    w.k.vms.platform.session['ssBot'] = { n: 1 };
    const ctx = w.k.createUiCtx();
    expect(ctx.session.ui.panel).toBe('menu');
    expect(ctx.session.ui.trophy.k).toBe('first-blood');
    expect(ctx.session.ssSpot).toBe(3);
    expect(ctx.session.ssBot).toBeUndefined();
    expect('ssSpot' in ctx.session).toBe(true);
    expect('nope' in ctx.session).toBe(false);
    expect(Object.keys(ctx.session).sort()).toEqual(['ssSpot', 'ui']);
    // a later live write is seen by the same ctx (no snapshot)
    w.k.vms.client.session['ssSpot'] = 4;
    expect(ctx.session.ssSpot).toBe(4);
  });

  it('assignments, nested writes and deletes are visible through that ctx and never reach the live session', async () => {
    const w = await scene();
    const live = w.k.vms.client.session;
    live['ui'] = { panel: 'menu', tabs: ['a', 'b'], deep: { n: 1 } };
    live['ssSpot'] = 3;
    live['keep'] = 'x';
    const before = JSON.stringify(live);
    const liveUi = live['ui'];
    const ctx = w.k.createUiCtx();

    expect(() => {
      ctx.session.ui.panel = 'shop';
      ctx.session.ui.deep.n = 2;
      ctx.session.ui.tabs.push('c');
      ctx.session.fresh = { a: 1 };
      ctx.session.fresh.a = 2;
      ctx.session.ssSpot += 1;
      delete ctx.session.keep;
      delete ctx.session.ui.deep.nothing;
      ctx.session.ui.extra ??= {};
    }).not.toThrow();

    expect(ctx.session.ui.panel).toBe('shop');
    expect(ctx.session.ui.deep.n).toBe(2);
    expect([...ctx.session.ui.tabs]).toEqual(['a', 'b', 'c']);
    expect(ctx.session.ui.tabs.length).toBe(3);
    expect(ctx.session.fresh).toEqual({ a: 2 });
    expect(ctx.session.ssSpot).toBe(4);
    expect(ctx.session.keep).toBeUndefined();
    expect('keep' in ctx.session).toBe(false);
    expect(Object.keys(ctx.session).sort()).toEqual(['fresh', 'ssSpot', 'ui']);
    expect(Object.keys(ctx.session.ui).sort()).toEqual(['deep', 'extra', 'panel', 'tabs']);
    expect(JSON.parse(JSON.stringify(ctx.session))).toEqual({
      ui: { panel: 'shop', tabs: ['a', 'b', 'c'], deep: { n: 2 }, extra: {} },
      ssSpot: 4,
      fresh: { a: 2 },
    });

    // the live session is byte-identical, and still the same objects
    expect(JSON.stringify(live)).toBe(before);
    expect(live['ui']).toBe(liveUi);
    expect((live['ui'] as { tabs: string[] }).tabs).toEqual(['a', 'b']);

    // the overlay dies with the ctx
    const next = w.k.createUiCtx();
    expect(next.session.ui.panel).toBe('menu');
    expect(next.session.ssSpot).toBe(3);
    expect(next.session.keep).toBe('x');
    expect(next.session.fresh).toBeUndefined();
  });

  it('a whole top-level assignment replaces only the overlay', async () => {
    const w = await scene();
    const live = w.k.vms.client.session;
    live['ui'] = { panel: 'menu' };
    const ctx = w.k.createUiCtx();
    ctx.session.ui = { panel: 'credits', own: true };
    expect(ctx.session.ui).toEqual({ panel: 'credits', own: true });
    expect(live['ui']).toEqual({ panel: 'menu' });
  });

  it('array edits behave as on a real array (shift, splice, sort, a shorter length) and stay in the overlay', async () => {
    const w = await scene();
    const live = w.k.vms.client.session;
    live['list'] = [3, 1, 2];
    live['trophyQ'] = [{ k: 'a' }, { k: 'b' }];
    const before = JSON.stringify(live);
    const s = w.k.createUiCtx().session;
    s.list.sort();
    expect([...s.list]).toEqual([1, 2, 3]);
    s.list.splice(1, 1);
    expect(JSON.stringify(s.list)).toBe('[1,3]');
    expect(s.trophyQ.shift().k).toBe('a');
    expect(s.trophyQ.map((t: { k: string }) => t.k)).toEqual(['b']);
    // a shorter length drops the elements past it: they do not come back from the live array
    s.list.length = 0;
    expect(s.list.length).toBe(0);
    expect(s.list[0]).toBeUndefined();
    expect(0 in s.list).toBe(false);
    expect(Object.keys(s.list)).toEqual([]);
    s.list.push(9);
    expect([...s.list]).toEqual([9]);
    s.list.length = 3;
    expect(JSON.stringify(s.list)).toBe('[9,null,null]');
    expect(JSON.stringify(live)).toBe(before);
  });

  it('nothing is cloned: an unwritten nested read keeps its identity within a render, and two ctxs are independent', async () => {
    const w = await scene();
    const big = { rows: Array.from({ length: 2000 }, (_, i) => ({ i })) };
    w.k.vms.client.session['big'] = big;
    const a = w.k.createUiCtx();
    const b = w.k.createUiCtx();
    expect(a.session).toBe(a.session);
    expect(a.session.big).toBe(a.session.big);
    expect(a.session.big.rows[7]).toBe(a.session.big.rows[7]);
    expect(a.session.big.rows[7].i).toBe(7);
    expect(a.session.big.rows.length).toBe(2000);
    expect(Array.isArray(a.session.big.rows)).toBe(true);
    expect(a.session.big.rows.filter((r: { i: number }) => r.i < 3).map((r: { i: number }) => r.i)).toEqual([0, 1, 2]);
    a.session.big.rows[7].i = -1;
    expect(a.session.big.rows[7].i).toBe(-1);
    expect(b.session.big.rows[7].i).toBe(7);
    expect(big.rows[7]!.i).toBe(7);
    // creating a ctx touches nothing of the session: the overlay is built on first read
    const proto = Object.getOwnPropertyNames(w.k.vms.client.session);
    w.k.createUiCtx();
    expect(Object.getOwnPropertyNames(w.k.vms.client.session)).toEqual(proto);
  });
});

describe('ui ctx: handles are read-only', () => {
  it('self is the human body, read-only: no setter and no nested write reaches the store', async () => {
    const w = await scene();
    w.ticks(1);
    w.k.store.takeChanges();
    const ctx = w.k.createUiCtx();
    const self = ctx.self as ObjectView;
    expect(self.id).toBe(HUMAN_BODY_ID);
    expect(self.feetPosition).toEqual({ x: 0, y: 0, z: 0 });
    expect((self.state['prog'] as { xp: number }).xp).toBe(3);
    const writes = w.k.store.counters.readonlyWrites;
    expect(() => {
      self.feetPosition = { x: 9, y: 9, z: 9 };
      self.state['x'] = 1;
      (self.state['prog'] as { xp: number }).xp = 99;
      self.state = {};
      self.yaw = 90;
      self.visible = false;
      self.spectating = true;
      delete self.state['prog'];
    }).not.toThrow();
    expect(w.k.store.takeChanges()).toEqual([]);
    expect(w.k.store.counters.readonlyWrites).toBeGreaterThanOrEqual(writes + 8);
    const row = w.row(HUMAN_BODY_ID);
    expect(row.tf.pos).toEqual({ x: 0, y: 0, z: 0 });
    expect(row.state).toEqual({ prog: { xp: 3 } });
    expect(row.spectating).toBe(false);
    // reads see the current values
    w.ctx(HUMAN_BODY_ID).self.state['hp'] = 50;
    expect(self.state['hp']).toBe(50);
    expect(ctx.self).toBe(self);
  });

  it('self is null while there is no human', async () => {
    const w = await ctxWorld({ modules: { ...PLAYER_MODULES } });
    const ctx = w.k.createUiCtx();
    expect(ctx.self).toBeNull();
    expect(ctx.world.players).toEqual([]);
  });

  it('getObject finds a row in another place and a client-local row (X-24), read-only', async () => {
    const w = await scene();
    w.spawn('lamp-far', { place: 'p2', tags: ['lamp'], state: { on: true }, feetPosition: { x: 4, y: 0, z: 0 } });
    const body = w.ctx(HUMAN_BODY_ID);
    const torch = body.spawn({ parent: HUMAN_BODY_ID, audience: 'local', scope: 'session', tags: ['ss-torch'] });
    w.k.store.takeChanges();
    const ctx = w.k.createUiCtx();
    const far = ctx.getObject('lamp-far')!;
    expect(far).not.toBeNull();
    expect(far.place).toBe('p2');
    expect(far.state['on']).toBe(true);
    expect(ctx.getObject(torch)).not.toBeNull();
    expect(w.simCtx(null).getObject(torch)).toBeNull();
    expect(ctx.getObject('missing')).toBeNull();
    (far as ObjectView).state['on'] = false;
    (far as ObjectView).feetPosition = { x: 0, y: 0, z: 0 };
    expect(w.row('lamp-far').state).toEqual({ on: true });
    expect(w.row('lamp-far').tf.pos).toEqual({ x: 4, y: 0, z: 0 });
    expect(w.k.store.takeChanges()).toEqual([]);
    // the handle is the UI realm's, not the platform's
    expect(far).toBe(w.k.store.handle(w.row('lamp-far'), 'ui'));
  });
});

describe('ui ctx: the world is read-only', () => {
  it('world.state writes through the UI ctx are ignored with a dev warning; game writes show at once', async () => {
    const w = await scene();
    const sim = w.simCtx(null);
    sim.world.state.ss = { phase: 'LOBBY', slots: [1, 2] };
    const ctx = w.k.createUiCtx();
    expect(ctx.world.state.ss.phase).toBe('LOBBY');
    expect(() => {
      ctx.world.state.x = 1;
      ctx.world.state.ss.phase = 'WAVE';
      ctx.world.state.ss.slots.push(3);
      delete ctx.world.state.ss;
      (ctx.world as { state: unknown }).state = {};
    }).not.toThrow();
    expect(w.k.worldState).toEqual({ ss: { phase: 'LOBBY', slots: [1, 2] } });
    expect(w.warnings.some((m) => /world\.state.*read-only UI view/.test(m))).toBe(true);
    expect(w.k.ctx.worldBag.readonlyWrites).toBeGreaterThanOrEqual(4);
    sim.world.state.ss.phase = 'WAVE';
    expect(ctx.world.state.ss.phase).toBe('WAVE');
  });

  it('world.players holds the human with isLocal true; places, settling, inputs and the place handles read through', async () => {
    const ports = createNullPorts();
    const declared = { actions: { jump: { keys: ['space'] } } };
    const w = await scene({ ports: { ...ports, input: { ...ports.input, declared } } });
    w.simCtx(null).world.places['p2']!.state.power = { k: 0.4 };
    const ctx = w.k.createUiCtx();
    const players = ctx.world.players as PlayerView[];
    expect(players).toHaveLength(1);
    expect(players[0]!.isLocal).toBe(true);
    expect(players[0]!.id).toBe(HUMAN_BODY_ID);
    expect(players[0]).toBe(ctx.self);
    expect(Object.keys(ctx.world.places)).toEqual(['p1', 'p2']);
    expect(ctx.world.places['nope']).toBeUndefined();
    expect(ctx.world.places['p2']!.state.power.k).toBe(0.4);
    ctx.world.places['p2']!.state.power.k = 1;
    ctx.world.places['p2']!.atmosphere.fog = { density: 1 };
    expect(w.simCtx(null).world.places['p2']!.state.power.k).toBe(0.4);
    expect(w.simCtx(null).world.places['p2']!.atmosphere.fog).toBeUndefined();
    expect(ctx.world.inputs).toBe(declared);
    expect(ctx.world.settling).toBe(false);
    w.k.booting = true;
    expect(ctx.world.settling).toBe(true);
    w.k.booting = false;
    expect(ctx.world.settling).toBe(false);
    expect(ctx.world.id).toBeNull();
    expect(ctx.world.mode).toBe('live');
  });
});

describe('ui ctx: the members of the render call', () => {
  it('kind, now, random, the log verbs and view.camera', async () => {
    let camera: { eye: { x: number; y: number; z: number }; aim: { x: number; y: number; z: number }; fov: number } | null = null;
    const ports = createNullPorts();
    const w = await scene({ ports: { ...ports, camera: { ...ports.camera, presentedCamera: () => camera } } });
    const ctx = w.k.createUiCtx();
    expect(ctx.kind).toBe('ui');
    expect(ctx.now()).toBe(w.k.clock.now());
    expect(ctx.view.camera).toBeNull();
    camera = { eye: { x: 0, y: 1.7, z: 0 }, aim: { x: 0, y: 1.7, z: -1 }, fov: 70 };
    expect(ctx.view.camera).toEqual(camera);
    const r = ctx.random();
    expect(r).toBeGreaterThanOrEqual(0);
    expect(r).toBeLessThan(1);
    const { warn } = ctx;
    warn('hud: missing slot', { slot: 2 });
    ctx.log('hello');
    ctx.error('bad');
    expect(w.logged.map((l) => `${l.level}:${l.text}`)).toEqual(['warn:[ui] hud: missing slot', 'log:[ui] hello', 'error:[ui] bad']);
    expect(w.logged[0]!.data).toEqual({ slot: 2 });
    for (const absent of ['wallNow', 'spawn', 'destroy', 'emit', 'query', 'place']) expect(absent in ctx, absent).toBe(false);
  });

  it('now() does not advance while the clock is paused', async () => {
    const w = await scene();
    w.k.runTicks(3);
    const ctx = w.k.createUiCtx();
    const t = ctx.now();
    w.k.clock.pause('overlay');
    w.k.advance(500);
    w.k.runTicks(5);
    expect(w.k.createUiCtx().now()).toBe(t);
    w.k.clock.resume('overlay');
    w.k.runTicks(1);
    expect(w.k.createUiCtx().now()).toBeGreaterThan(t);
  });

  it('port is the host\'s slot: undefined from the kernel, assignable, and makeUiCtx attaches it to the real ctx', async () => {
    const w = await scene();
    const bare = w.k.createUiCtx();
    expect(bare.port).toBeUndefined();
    const port = defaultPortUiState();
    const { ctx, player } = makeUiCtx(w.k, port);
    expect(ctx.port).toBe(port);
    expect(ctx.kind).toBe('ui');
    expect(player).not.toBeNull();
    expect(player!.isLocal).toBe(true);
    expect((player as unknown as ObjectView).id).toBe(HUMAN_BODY_ID);
    // a second render gets its own ctx and its own slot
    expect(w.k.createUiCtx()).not.toBe(ctx);
    expect(w.k.createUiCtx().port).toBeUndefined();
  });
});
