// Behavior instances and guarded hook calls (docs/design/core-runtime.md §2 behaviors/bind.ts, invoke.ts; D-CORE-15; §8.1
// `ears` read once at bind; §12.4 late binding; engine api:691-703 BehaviorHookHealth).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HookInvoker, behaviorHealthOf, invokerOf } from '../../../src/compat/core/behaviors/invoke.ts';
import { bindBehavior, completeBind, readEars, unbindRow } from '../../../src/compat/core/behaviors/bind.ts';
import { ListenerRegistry } from '../../../src/compat/core/events/listeners.ts';
import { createKernelMetrics } from '../../../src/compat/core/kernel.ts';
import { compileSchedule, EVERY_TICK } from '../../../src/compat/core/sched/schedule.ts';
import type { BehaviorInstance, BehaviorModule, Invoker, SimInstance } from '../../../src/compat/core/types.ts';
import { makeRow } from './fakes/tick-world.ts';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('bindBehavior (core §2 behaviors/bind.ts)', () => {
  it('compiles the schedule for (row, path), reads ears once and registers them as declared listeners', () => {
    const listeners = new ListenerRegistry();
    const row = makeRow('door-7', 1);
    const press = (): void => {};
    const mod: BehaviorModule = { updateSchedule: { every: 2, near: { radius: 60 } }, ears: { press, 'ss:weld': press } };
    const inst = bindBehavior(row, 'scripts/map/door.js', mod, { listeners });
    expect(inst.path).toBe('scripts/map/door.js');
    expect(inst.module).toBe(mod);
    expect(inst.pendingModule).toBe(false);
    expect(inst.schedule).toEqual(compileSchedule({ every: 2 }, 'door-7', 'scripts/map/door.js'));
    expect(inst.sleeping).toBe(null);
    expect(inst.health.size).toBe(0);
    expect(Object.keys(inst.ears!)).toEqual(['press', 'ss:weld']);
    const ls = listeners.ofRow('door-7');
    expect(ls.map((l) => [l.name, l.declared, l.vm, l.once, l.placeFilter])).toEqual([
      ['press', true, 'platform', false, null],
      ['ss:weld', true, 'platform', false, null],
    ]);
    expect(ls[0]!.owner).toEqual({ kind: 'row', row, inst });
    mod.ears!['late'] = press; // a module's ears are read once, at bind
    expect(Object.keys(inst.ears!)).toEqual(['press', 'ss:weld']);
  });

  it('accepts computed ears (door.js builds them with Object.fromEntries) and skips non-function entries with a note', () => {
    const report = vi.fn();
    const ears = readEars({ ears: Object.fromEntries([['press', () => {}], ['ss:cut', () => {}], ['bad', 42]]) }, 'scripts/map/door.js', report);
    expect(Object.keys(ears!)).toEqual(['press', 'ss:cut']);
    expect(Object.isFrozen(ears)).toBe(true);
    expect(report).toHaveBeenCalledWith(expect.stringMatching(/scripts\/map\/door\.js.*bad/));
    expect(readEars({}, 'p')).toBe(null);
    expect(readEars({ ears: 7 } as unknown as BehaviorModule, 'p', report)).toBe(null);
  });

  it('creates the ctx once through the factory, after the instance exists', () => {
    const listeners = new ListenerRegistry();
    const row = makeRow('a', 1);
    const ctxFor = vi.fn((_r, inst: BehaviorInstance) => ({ kind: 'behavior', instPath: inst.path }) as never);
    const inst = bindBehavior(row, 'scripts/a.js', {}, { listeners, ctxFor });
    expect(ctxFor).toHaveBeenCalledTimes(1);
    expect(inst.ctx).toEqual({ kind: 'behavior', instPath: 'scripts/a.js' });
  });

  it('binds late: pending until the module arrives, then schedule and ears (core §12.4)', () => {
    const listeners = new ListenerRegistry();
    const row = makeRow('en-1-0001', 1);
    const inst = bindBehavior(row, 'scripts/enemies/enemy.js', null, { listeners });
    expect(inst.pendingModule).toBe(true);
    expect(inst.module).toBe(null);
    expect(inst.schedule).toEqual(EVERY_TICK);
    expect(listeners.ofRow(row.id)).toEqual([]);
    const mod: BehaviorModule = { updateSchedule: { every: 3 }, ears: { 'ss:hit': () => {} } };
    completeBind(row, inst, mod, { listeners });
    expect(inst.pendingModule).toBe(false);
    expect(inst.module).toBe(mod);
    expect(inst.schedule.everyTicks).toBe(3);
    expect(listeners.ofRow(row.id).map((l) => l.name)).toEqual(['ss:hit']);
  });

  it('notes, once per module, hooks the engine recognises but never calls (core §7.2)', () => {
    const listeners = new ListenerRegistry();
    const report = vi.fn();
    const mod: BehaviorModule = { onCollide: () => {}, onTriggerExit: () => {}, update: () => {} };
    bindBehavior(makeRow('a', 1), 'scripts/odd.js', mod, { listeners, report });
    bindBehavior(makeRow('b', 2), 'scripts/odd.js', mod, { listeners, report });
    expect(report).toHaveBeenCalledTimes(1);
    expect(String(report.mock.calls[0]?.[0])).toMatch(/onCollide.*onTriggerExit/);
  });

  it('unbindRow removes every listener of the row (disposal)', () => {
    const listeners = new ListenerRegistry();
    const row = makeRow('r', 1);
    const inst = bindBehavior(row, 'scripts/r.js', { ears: { a: () => {}, b: () => {} } }, { listeners });
    listeners.on({ kind: 'row', row, inst }, 'c', () => {});
    expect(listeners.ofRow('r').length).toBe(3);
    expect(unbindRow(row, { listeners })).toBe(3);
    expect(listeners.ofRow('r').length).toBe(0);
  });
});

describe('HookInvoker (D-CORE-15; api:691-703)', () => {
  const setup = () => {
    const metrics = createKernelMetrics();
    let tick = 7;
    const report = vi.fn();
    const inv = new HookInvoker({ metrics, tick: () => tick, report });
    const listeners = new ListenerRegistry();
    const row = makeRow('en-x-0001', 1);
    const a = bindBehavior(row, 'scripts/enemies/enemy.js', {}, { listeners });
    const b = bindBehavior(row, 'scripts/enemies/enemy-brain.js', {}, { listeners });
    row.behaviors.push(a, b);
    return { metrics, inv, row, a, b, report, setTick: (t: number) => (tick = t) };
  };

  it('calls the hook with its arguments and this, and reports success', () => {
    const { inv, row, a } = setup();
    const mod = { k: 2, update(this: { k: number }, ctx: { n: number }, dt: number) {
      ctx.n = this.k * dt;
    } };
    const ctx = { n: 0 };
    expect(inv.call({ kind: 'row', row, inst: a }, 'update', mod.update, [ctx, 3], mod)).toBe(true);
    expect(ctx.n).toBe(6);
  });

  it('keeps the hook alive after a throw: counted, recorded in behaviorHealth with count and tick, other behaviors untouched', () => {
    const { metrics, inv, row, a, b, setTick } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = (): void => {
      throw new Error('cannot read properties of undefined');
    };
    expect(behaviorHealthOf(row)).toBe(undefined);
    expect(inv.call({ kind: 'row', row, inst: a }, 'update', boom, [])).toBe(false);
    setTick(9);
    expect(inv.call({ kind: 'row', row, inst: a }, 'update', boom, [])).toBe(false);
    expect(inv.call({ kind: 'row', row, inst: b }, 'update', () => {}, [])).toBe(true);
    expect(metrics.hookErrors).toBe(2);
    const h = behaviorHealthOf(row)!;
    expect(h.broken).toHaveLength(1);
    expect(h.broken[0]).toMatchObject({
      hook: 'update',
      script: 'scripts/enemies/enemy.js',
      error: 'cannot read properties of undefined',
      tick: 9,
      running: 'running',
      count: 2,
    });
    expect(b.health.size).toBe(0);
  });

  it('records a throw of a non-Error value', () => {
    const { inv, row, a } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    inv.call({ kind: 'row', row, inst: a }, 'onSpawn', () => {
      throw 'plain string';
    }, []);
    expect(behaviorHealthOf(row)!.broken[0]!.error).toBe('plain string');
  });

  it('rate-limits the report: one line per (script, hook, message) per 5 s, with the count of the rest', () => {
    const metrics = createKernelMetrics();
    let wall = 0;
    const report = vi.fn();
    const inv = new HookInvoker({ metrics, tick: () => 1, report, wallClock: () => wall });
    const row = makeRow('r', 1);
    const inst = bindBehavior(row, 'scripts/r.js', {}, { listeners: new ListenerRegistry() });
    const boom = (): void => {
      throw new Error('same');
    };
    for (let i = 0; i < 10; i++) inv.call({ kind: 'row', row, inst }, 'update', boom, []);
    expect(report).toHaveBeenCalledTimes(1);
    expect(String(report.mock.calls[0]?.[0])).toMatch(/\[scripts\/r\.js\] update threw: same/);
    wall = 5001;
    inv.call({ kind: 'row', row, inst }, 'update', boom, []);
    expect(report).toHaveBeenCalledTimes(2);
    expect(String(report.mock.calls[1]?.[0])).toMatch(/9 more/);
    inv.call({ kind: 'row', row, inst }, 'onSpawn', boom, []); // another hook: its own line
    expect(report).toHaveBeenCalledTimes(3);
    expect(metrics.hookErrors).toBe(12);
  });

  it('knows the current invoker: the behavior in a row hook, the sim in a sim hook, the engine outside', () => {
    const { inv, row, a } = setup();
    const sim: SimInstance = { id: 'sim', place: null, path: 'sim.js', module: null, ctx: null, health: new Map() };
    const seen: Invoker[] = [];
    expect(inv.current).toBe('engine');
    inv.call({ kind: 'row', row, inst: a }, 'update', () => {
      seen.push(inv.current);
      inv.call({ kind: 'sim', sim }, 'tick', () => seen.push(inv.current), []);
      seen.push(inv.current);
    }, []);
    expect(inv.current).toBe('engine');
    inv.as('ui', () => seen.push(inv.current));
    expect(seen).toEqual([
      { row: 'en-x-0001', behavior: 'scripts/enemies/enemy.js' },
      { sim: 'sim' },
      { row: 'en-x-0001', behavior: 'scripts/enemies/enemy.js' },
      'ui',
    ]);
    expect(invokerOf({ kind: 'sim', sim })).toEqual({ sim: 'sim' });
  });

  it('restores the invoker when a hook throws', () => {
    const { inv, row, a } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    inv.call({ kind: 'row', row, inst: a }, 'update', () => {
      throw new Error('x');
    }, []);
    expect(inv.current).toBe('engine');
    expect(() =>
      inv.as('ui', () => {
        throw new Error('port bug');
      }),
    ).toThrow('port bug');
    expect(inv.current).toBe('engine');
  });

  it('records sim hook errors on the sim', () => {
    const { inv } = setup();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const sim: SimInstance = { id: 'sim:p1', place: 'p1', path: 'places/p1/sim.js', module: null, ctx: null, health: new Map() };
    inv.call({ kind: 'sim', sim }, 'tick', () => {
      throw new Error('power');
    }, []);
    expect(sim.health.get('tick')).toMatchObject({ hook: 'tick', script: 'places/p1/sim.js', error: 'power', running: 'running', count: 1 });
  });
});
