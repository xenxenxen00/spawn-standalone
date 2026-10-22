// Lifecycle (docs/design/core-runtime.md §5.2, D-CORE-06/07, §16.1 `lifecycle.test.ts`; contract §3.6, §3.6.1 M21): onSpawn at the
// phase boundary, first update in the next UPDATE phase, destroy cascade over children and spawner ownership (transitive,
// post-order), the M21 scenario of contract §32 (A spawns B spawns C; destroy A after 1 s → B, C gone; also by lifetime), lifetime
// cascade, spawn-then-destroy, spawns from onDestroy unowned, the duplicate-id no-op, the missing-destroy warning, act ids, late
// binding, ports, KernelEvents, spawnHuman and body-less velocity integration (core §5.4).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNullPhysicsPort } from '../../../src/compat/core/null-ports.ts';
import { HUMAN_BODY_ID } from '../../../src/compat/core/ids.ts';
import { spawnRow } from '../../../src/compat/core/lifecycle.ts';
import type { RowRec } from '../../../src/compat/core/types.ts';
import { makeWorld, quietConsole, tracer, world, type MiniCtx, type Module } from './fakes/lifecycle-world.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

const A = 'scripts/a.js';
const B = 'scripts/b.js';
const C = 'scripts/c.js';

describe('spawn timing (D-CORE-07)', () => {
  it('the record is visible at once; onSpawn runs at the next phase boundary in creation order; update from the next UPDATE', async () => {
    const trace: string[] = [];
    const mod: Module = {
      ...tracer(trace),
      update(ctx: MiniCtx) {
        trace.push(`update ${ctx.row.id}`);
      },
    };
    const w = await world({ modules: { [A]: mod } });
    const a = w.spawn('a', { behavior: A });
    const b = w.spawn('b', { behavior: A });
    expect(w.k.store.get(a)).toBeDefined();
    expect(w.row(a)!.pendingSpawnHooks).toBe(true);
    expect(trace).toEqual([]);
    w.boundary();
    expect(trace).toEqual(['onSpawn a', 'onSpawn b']);
    expect(w.row(a)!.pendingSpawnHooks).toBe(false);
    trace.length = 0;
    w.ticks(1);
    expect(trace).toEqual(['update a', 'update b']);
  });

  it('a row spawned during UPDATE gets onSpawn at that boundary and its first update next tick', async () => {
    const trace: string[] = [];
    let spawned = false;
    const parent: Module = {
      update(ctx: MiniCtx) {
        trace.push(`update ${ctx.row.id}`);
        if (!spawned) {
          spawned = true;
          ctx.spawn('kid', { behavior: B });
          trace.push(`visible ${ctx.getObject('kid') !== null}`);
        }
      },
    };
    const kid: Module = {
      onSpawn(ctx: MiniCtx) {
        trace.push(`onSpawn ${ctx.row.id}`);
      },
      update(ctx: MiniCtx) {
        trace.push(`update ${ctx.row.id}`);
      },
    };
    const w = await world({ modules: { [A]: parent, [B]: kid } });
    w.spawn('p', { behavior: A });
    w.ticks(1);
    expect(trace).toEqual(['update p', 'visible true', 'onSpawn kid']);
    trace.length = 0;
    w.ticks(1);
    expect(trace).toEqual(['update p', 'update kid']);
  });

  it('spawn emits KernelEvents.rowSpawned (record exists) and tells the physics port; behaviours and ears bind', async () => {
    const physics = { ...createNullPhysicsPort(), rowSpawned: vi.fn(), rowDestroyed: vi.fn() };
    const ear = vi.fn();
    const w = await world({ modules: { [A]: { ears: { ping: ear } } }, ports: { physics } });
    const seen: string[] = [];
    w.k.on('rowSpawned', (r) => seen.push(`${r.id} ${w.k.store.has(r.id)}`));
    w.spawn('e', { behavior: A, children: [{ id: 'k' }] });
    expect(seen).toEqual(['e true', 'e/k true']);
    expect(physics.rowSpawned.mock.calls.map((c) => (c[0] as RowRec).id)).toEqual(['e', 'e/k']);
    expect(w.row('e')!.behaviors[0]!.ears).not.toBeNull();
    w.k.bus.emit({ kind: 'kernel' }, 'ping', { n: 1 }, { to: 'e' });
    w.boundary();
    expect(ear).toHaveBeenCalledTimes(1);
  });
});

describe('destroy (contract §3.6, §3.6.1)', () => {
  it('detaches at once (id free, invisible), onDestroy at the next boundary with the last values, then ports and rowDestroyed', async () => {
    const physics = { ...createNullPhysicsPort(), rowDestroyed: vi.fn() };
    const trace: string[] = [];
    const mod = tracer(trace, {
      onDestroy(ctx) {
        trace.push(`hp ${String(ctx.self.state['hp'])} phase ${ctx.row.phase}`);
      },
    });
    const w = await world({ modules: { [A]: mod }, ports: { physics } });
    const gone: string[] = [];
    w.k.on('rowDestroyed', (r) => gone.push(`${r.id} ${r.phase}`));
    w.spawn('x', { behavior: A, state: { hp: 7 } });
    w.boundary();
    trace.length = 0;
    w.destroy('x');
    expect(w.k.store.has('x')).toBe(false);
    expect(w.row('x')).toBeUndefined();
    expect(trace).toEqual([]);
    // the id is free at once
    w.spawn('x', {});
    expect(w.k.store.has('x')).toBe(true);
    w.boundary();
    expect(trace).toEqual(['onDestroy x', 'hp 7 phase dead']);
    expect(gone).toEqual(['x disposed']);
    expect(physics.rowDestroyed).toHaveBeenCalledTimes(1);
  });

  it('cascades depth-first over children and spawner ownership, transitively, post-order (dependants first)', async () => {
    const trace: string[] = [];
    const w = await world({ modules: { [A]: tracer(trace) } });
    w.spawn('root', { behavior: A, children: [{ id: 'c1', behavior: A, children: [{ id: 'g', behavior: A }] }, { id: 'c2', behavior: A }] });
    w.boundary();
    const root = w.ctxOf('root');
    const owned = root.spawn('owned', { behavior: A });
    w.boundary();
    w.ctxOf(owned).spawn('owned2', { behavior: A });
    w.boundary();
    expect(w.row('owned')!.spawnerId).toBe('root');
    expect(w.row('owned')!.parentId).toBeNull();
    expect(w.row('owned2')!.spawnerId).toBe('owned');
    trace.length = 0;
    w.destroy('root');
    for (const id of ['root', 'root/c1', 'root/c1/g', 'root/c2', 'owned', 'owned2']) expect(w.k.store.has(id), id).toBe(false);
    w.boundary();
    expect(trace).toEqual(['onDestroy root/c1/g', 'onDestroy root/c1', 'onDestroy root/c2', 'onDestroy owned2', 'onDestroy owned', 'onDestroy root']);
  });

  it("spawnerOwnership 'off' cascades over children only", async () => {
    const w = await world({ modules: { [A]: {} }, rules: { spawnerOwnership: 'off' } });
    w.spawn('root', { behavior: A, children: [{ id: 'c' }] });
    w.ctxOf('root').spawn('owned', {});
    w.destroy('root');
    expect(w.k.store.has('root/c')).toBe(false);
    expect(w.k.store.has('owned')).toBe(true);
  });

  it('M21 (contract §32): A spawns B (no parent) whose onSpawn spawns C; destroying A after 1 s takes B and C', async () => {
    const mk = (next: string | null, path: string): Module => ({
      onSpawn(ctx: MiniCtx) {
        if (next) ctx.spawn({ tags: ['t'], behavior: path });
      },
    });
    const w = await world({ modules: { [A]: mk('B', B), [B]: mk('C', C), [C]: {} } });
    const a = w.spawn('A', { simulatedBy: 'platform', behavior: A, tags: ['t'] });
    const count = (): number => w.k.store.byTag('p1', 't').size;
    w.ticks(1);
    expect(count()).toBe(3);
    w.ticks(29);
    w.destroy(a);
    expect(count()).toBe(0);
  });

  it('M21 by lifetime: A ends by lifetime 1 s and takes B and C with it (phase G), onDestroy runs for all', async () => {
    const trace: string[] = [];
    const mk = (spawnNext: boolean, path: string): Module =>
      tracer(trace, {
        onSpawn(ctx) {
          if (spawnNext) ctx.spawn({ tags: ['t'], behavior: path });
        },
      });
    const w = await world({ modules: { [A]: mk(true, B), [B]: mk(true, C), [C]: mk(false, C) } });
    w.spawn('A', { behavior: A, tags: ['t'], lifetime: 1 });
    const count = (): number => w.k.store.byTag('p1', 't').size;
    w.ticks(29);
    expect(count()).toBe(3);
    trace.length = 0;
    w.ticks(1);
    expect(count()).toBe(0);
    expect(trace.filter((t) => t.startsWith('onDestroy'))).toHaveLength(3);
    expect(trace[trace.length - 1]).toBe('onDestroy A');
  });

  it('lifetime expiry destroys at tick ≥ expiresAtTick in (tick, serial) order and cascades over children', async () => {
    const w = await world();
    const gone: string[] = [];
    w.k.on('rowDestroyed', (r) => gone.push(r.id));
    w.spawn('late', { lifetime: 0.2 });
    w.spawn('early', { lifetime: 0.1, children: [{ id: 'k' }] });
    w.spawn('also-early', { lifetime: 0.1 });
    w.ticks(2);
    expect(gone).toEqual([]);
    w.ticks(1);
    expect(gone).toEqual(['early/k', 'early', 'also-early']);
    w.ticks(3);
    expect(gone).toEqual(['early/k', 'early', 'also-early', 'late']);
  });

  it('destroying most long-lived rows rebuilds the lifetime heap (no stale entries keep them); survivors expire in (tick, serial) order', async () => {
    const w = await world();
    const gone: string[] = [];
    w.k.on('rowDestroyed', (r) => gone.push(r.id));
    const longIds: string[] = [];
    for (let i = 0; i < 1000; i++) longIds.push(w.spawn(`g${i}`, { lifetime: 10 }));
    w.spawn('s-a', { lifetime: 0.3 });
    w.spawn('s-b', { lifetime: 0.3 });
    w.spawn('s-c', { lifetime: 0.2 });
    w.spawn('s-d', { lifetime: 0.5 });
    w.spawn('s-e', { lifetime: 0.2 });
    expect(w.k.lifecycle.lifetimeHeap).toEqual({ size: 1005, stale: 0 });
    w.destroy(longIds.slice(0, 990));
    w.boundary();
    expect(gone).toHaveLength(990);
    // 990 of 1005 entries went stale: the heap rebuilt itself from the 15 alive rows
    expect(w.k.lifecycle.lifetimeHeap).toEqual({ size: 15, stale: 0 });
    gone.length = 0;
    w.ticks(16);
    expect(gone).toEqual(['s-c', 's-e', 's-a', 's-b', 's-d']);
    w.ticks(300);
    expect(gone.slice(5)).toEqual(longIds.slice(990));
    expect(w.k.lifecycle.lifetimeHeap).toEqual({ size: 0, stale: 0 });
  });

  it('a few stale lifetime entries stay counted until popped (no rebuild below the threshold)', async () => {
    const w = await world();
    const ids: string[] = [];
    for (let i = 0; i < 400; i++) ids.push(w.spawn(`r${i}`, { lifetime: 1 }));
    w.destroy(ids.slice(0, 150));
    w.boundary();
    expect(w.k.lifecycle.lifetimeHeap).toEqual({ size: 400, stale: 150 });
    const gone: string[] = [];
    w.k.on('rowDestroyed', (r) => gone.push(r.id));
    w.ticks(31);
    expect(gone).toEqual(ids.slice(150));
    expect(w.k.lifecycle.lifetimeHeap).toEqual({ size: 0, stale: 0 });
  });

  it('spawn-then-destroy before onSpawn ran: neither hook runs, the row is still disposed', async () => {
    const trace: string[] = [];
    const w = await world({ modules: { [A]: tracer(trace) } });
    const gone: string[] = [];
    w.k.on('rowDestroyed', (r) => gone.push(r.id));
    w.spawn('flash', { behavior: A });
    w.destroy('flash');
    w.boundary();
    expect(trace).toEqual([]);
    expect(gone).toEqual(['flash']);
  });

  it('a row spawned inside its spawner onDestroy has no spawner edge and survives', async () => {
    const w = await world({
      modules: {
        [A]: {
          onDestroy(ctx: MiniCtx) {
            ctx.spawn('remains', {});
          },
        },
      },
    });
    w.spawn('body', { behavior: A });
    w.boundary();
    w.destroy('body');
    w.boundary();
    expect(w.row('remains')).toBeDefined();
    expect(w.row('remains')!.spawnerId).toBeNull();
  });

  it('__portUnowned (PORT_FIX D2) spawns with no spawner edge and is stripped', async () => {
    const w = await world({ modules: { [A]: {} } });
    w.spawn('enemy', { behavior: A });
    const ctx = w.ctxOf('enemy');
    ctx.spawn('pool', { __portUnowned: true });
    ctx.spawn('owned-pool', { __portUnowned: false });
    expect(w.row('pool')!.spawnerId).toBeNull();
    expect(w.row('pool')!.props).not.toHaveProperty('__portUnowned');
    expect(w.row('owned-pool')!.spawnerId).toBe('enemy');
    w.destroy('enemy');
    expect(w.row('pool')).toBeDefined();
    expect(w.row('owned-pool')).toBeUndefined();
  });

  it('sims, scenes and the kernel own nothing', async () => {
    const w = await world();
    w.spawn('k', {});
    w.sceneSpawn('p1', 'door', {});
    spawnRow(w.k, { kind: 'sim', sim: w.sim(null) }, 'enemy', {});
    for (const id of ['k', 'door', 'enemy']) expect(w.row(id)!.spawnerId).toBeNull();
  });

  it('a missing id warns once and never throws; an array destroys each; no argument destroys self; a sim without one warns', async () => {
    const w = await world({ modules: { [A]: {} } });
    w.destroy('ghost');
    w.destroy('ghost');
    expect(w.warnings.filter((m) => m === 'destroy: no such object ghost')).toHaveLength(1);
    w.spawn('a', {});
    w.spawn('b', {});
    w.destroy(['a', 'b', 'ghost2']);
    expect(w.k.store.count).toBe(0);
    w.spawn('self', { behavior: A });
    w.ctxOf('self').destroy();
    expect(w.row('self')).toBeUndefined();
    const { destroyRows } = await import('../../../src/compat/core/lifecycle.ts');
    destroyRows(w.k, { kind: 'sim', sim: w.sim(null) }, undefined);
    expect(w.warnings.some((m) => /sim/.test(m))).toBe(true);
  });

  it('an act id ends that effect through the act router, never a row', async () => {
    const w = await world();
    const ended: string[] = [];
    w.k.acts.registerEnd('fx-', (id) => ended.push(id));
    const id = w.k.acts.emit({ kind: 'kernel' }, 'fx', { program: 'x' }, {});
    expect(id).toMatch(/^fx-/);
    w.destroy(id!);
    expect(ended).toEqual([id]);
    expect(w.warnings).toEqual([]);
  });

  it('an id reused in the same step: the old row\'s disposal ends only its own attached fx, never the new row\'s', async () => {
    const w = await world({ modules: { 'templates/player.js': { player: { behavior: [A] } }, [A]: {} } });
    w.k.spawnHuman({ place: 'p1', userId: 'u1', displayName: 'Op', durableState: {} }); // acts are presented to the human only
    const ended: string[] = [];
    w.k.acts.register('fx', () => {});
    w.k.acts.registerEnd('fx-', (id) => ended.push(id));
    w.spawn('x', { behavior: A });
    w.boundary();
    const oldFx = w.k.acts.emit({ kind: 'kernel' }, 'fx', { attachTo: 'x' }, {})!;
    w.destroy('x');
    w.spawn('x', { behavior: A }); // same step: the old record is detached, not yet disposed
    const newFx = w.k.acts.emit({ kind: 'kernel' }, 'fx', { attachTo: 'x' }, {})!;
    w.boundary(); // the old x is disposed here
    expect(ended).toEqual([oldFx]);
    w.destroy('x');
    w.boundary();
    expect(ended).toEqual([oldFx, newFx]);
  });

  it('a hook that throws is reported and the lifecycle goes on', async () => {
    quietConsole();
    const trace: string[] = [];
    const w = await world({
      modules: {
        [A]: {
          onSpawn() {
            throw new Error('boom');
          },
        },
        [B]: tracer(trace),
      },
    });
    w.spawn('bad', { behavior: [A, B] });
    w.boundary();
    expect(trace).toEqual(['onSpawn bad']);
    expect(w.k.metrics.hookErrors).toBe(1);
  });
});

describe('dev: the "state write lost" detector runs at tick end (core §5.3, tick step H)', () => {
  const mutating = (keep: { bag: { n: number } | null }): Module => ({
    update(ctx: MiniCtx) {
      const bag = { n: ctx.now() }; // a new value each tick, so every assignment is an effective write
      (ctx.self as unknown as { state: Record<string, unknown> }).state['bag'] = bag;
      bag.n = 2; // after the assignment: the store kept the copy
      keep.bag = bag;
    },
  });

  it('a dev kernel warns once per lost write each tick and empties the watch', async () => {
    quietConsole();
    const keep = { bag: null as { n: number } | null };
    const w = await world({ dev: true, modules: { [A]: mutating(keep) } });
    w.spawn('m', { behavior: A });
    w.boundary();
    w.ticks(1);
    expect(w.k.store.counters.lostWrites).toBe(1);
    w.ticks(2);
    expect(w.k.store.counters.lostWrites).toBe(3);
    expect(w.k.store.checkLostWrites()).toBe(0); // judged and cleared by the tick itself
  });

  it('a production kernel never runs it', async () => {
    const keep = { bag: null as { n: number } | null };
    const w = await world({ modules: { [A]: mutating(keep) } });
    w.spawn('m', { behavior: A });
    w.boundary();
    w.ticks(3);
    expect(keep.bag).not.toBeNull();
    expect(w.k.store.counters.lostWrites).toBe(0);
  });
});

describe('late binding (core §12.4)', () => {
  it('a known but unloaded behaviour binds late: onSpawn waits for every module, then runs at a boundary', async () => {
    quietConsole();
    const trace: string[] = [];
    const w = makeWorld({ modules: { [A]: tracer(trace), [B]: tracer(trace) }, lazy: [B] });
    await w.k.registry.ensure('boot');
    w.spawn('r', { behavior: [A, B] });
    const r = w.row('r')!;
    expect(r.behaviors[1]!.pendingModule).toBe(true);
    w.boundary();
    expect(trace).toEqual([]);
    await w.k.registry.ensure([B]);
    await new Promise((res) => setTimeout(res, 0));
    expect(r.behaviors[1]!.pendingModule).toBe(false);
    w.boundary();
    expect(trace).toEqual(['onSpawn r', 'onSpawn r']);
    expect(w.k.registry.lateBinds).toBe(1);
  });
});

describe('spawnHuman (core §3.7, §5.8, §14 step 10)', () => {
  it('spawns player/local from the world config template on the client VM with the player record and durable state', async () => {
    const tpl = { behavior: [A], tags: ['player', 'teammate'], physics: { body: 'character' }, feetPosition: { x: 0, y: 2, z: 0 }, state: { prog: { xp: 0, lvl: 1 }, hp: 100 } };
    const w = await world({ modules: { 'templates/player.js': { player: tpl }, [A]: {} } });
    const id = w.k.spawnHuman({ place: 'p2', at: { x: 3, y: 1, z: 4 }, yaw: 90, userId: 'u1', displayName: 'Op', durableState: { prog: { xp: 50 }, prefs: { fov: 90 } } });
    expect(id).toBe(HUMAN_BODY_ID);
    const r = w.row(id)!;
    expect(r.vm).toBe('client');
    expect(r.place).toBe('p2');
    expect(r.tags).toEqual(['player', 'teammate']);
    expect(r.player).toEqual({ userId: 'u1', displayName: 'Op', bodyId: id, look: [] });
    expect(r.tf.pos).toEqual({ x: 3, y: 1, z: 4 });
    expect(w.k.store.handle(r, 'client').rotation.yaw).toBe(90);
    expect(r.state).toEqual({ prog: { xp: 50, lvl: 1 }, hp: 100, prefs: { fov: 90 } });
    expect(r.spawnerId).toBeNull();
    expect(w.k.store.handle(r, 'client').isLocal).toBe(true);
  });
});

describe('body-less velocity integration (core §5.4, tick step E)', () => {
  it('a row with no body keeps integrating a written velocity (no gravity); a body row is left to the physics port', async () => {
    const w = await world();
    const free = w.row(w.spawn('free', { feetPosition: { x: 0, y: 10, z: 0 } }))!;
    const body = w.row(w.spawn('body', { physics: 'dynamic', feetPosition: { x: 0, y: 10, z: 0 } }))!;
    const h = w.k.store.handle(free, 'platform');
    h.velocity = { x: 3, y: 0, z: -6 };
    w.k.store.handle(body, 'platform').velocity = { x: 3, y: 0, z: 0 };
    w.ticks(30);
    expect(free.tf.pos.x).toBeCloseTo(3, 9);
    expect(free.tf.pos.y).toBeCloseTo(10, 9);
    expect(free.tf.pos.z).toBeCloseTo(-6, 9);
    expect(body.tf.pos).toEqual({ x: 0, y: 10, z: 0 });
    h.velocity = { x: 0, y: 0, z: 0 };
    w.ticks(5);
    expect(free.tf.pos.x).toBeCloseTo(3, 9);
  });

  it('onTriggerEnter: the physics port reports enters after the step; the trigger row behaviours get the other row', async () => {
    const enters: Array<{ trigger: string; other: string }> = [];
    const physics = { ...createNullPhysicsPort(), drainTriggerEnters: () => enters.splice(0) };
    const got: string[] = [];
    const w = await world({
      ports: { physics },
      modules: {
        [A]: {
          onTriggerEnter(ctx: MiniCtx, other: { id: string }) {
            got.push(`${ctx.row.id} ← ${other.id}`);
          },
        },
      },
    });
    w.spawn('zone', { behavior: A });
    w.spawn('walker', {});
    w.ticks(1);
    enters.push({ trigger: 'zone', other: 'walker' }, { trigger: 'zone', other: 'ghost' });
    w.ticks(1);
    expect(got).toEqual(['zone ← walker']);
  });
});
