// The kernel's time-and-events wiring (WP C2: sched/runtime.ts, kernel.ts): clock, bus, feed, acts, advance, runTicks and the
// test-only setTicksPerFrame are wired; `kernel.time.use` installs the host hooks later packages own; and with the row store
// of WP C1a the defaults already drive the tick: the store's writer is the running hook, every effective write wakes the
// row's other sleepers and reaches the row feed, the change list is drained at step H, the human and the update rows come
// from the store.
import { describe, expect, it, vi } from 'vitest';
import { createKernel } from '../../../src/compat/core/kernel.ts';
import { createRowRec } from '../../../src/compat/core/store/rows.ts';
import { bindBehavior } from '../../../src/compat/core/behaviors/bind.ts';
import { sleepFor } from '../../../src/compat/core/sched/sleep.ts';
import { createNullPorts } from '../../../src/compat/core/null-ports.ts';
import type { RowSnapshot } from '../../../src/compat/core/ports.ts';
import type { BehaviorInstance, BehaviorModule, Invoker, ObjectView, RowRec, SimInstance } from '../../../src/compat/core/types.ts';
import { kernelOptions, type TestModule } from './fakes/tick-world.ts';

describe('kernel wiring (WP C2)', () => {
  it('serves the clock, bus, feed and acts of kernel.time; the clock starts paused with boot', () => {
    const k = createKernel(kernelOptions());
    expect(k.clock).toBe(k.time.clock);
    expect(k.bus).toBe(k.time.bus);
    expect(k.feed).toBe(k.time.feed);
    expect(k.acts).toBe(k.time.acts);
    expect([...k.clock.reasons]).toEqual(['boot']);
    expect(k.clock.tick).toBe(0);
    expect(k.advance(100)).toEqual({ ticks: 0, alpha: 0 });
    k.runTicks(2, { force: true });
    expect(k.clock.tick).toBe(2);
  });

  it('offers setTicksPerFrame in test builds (vitest runs with the test hooks on)', () => {
    const k = createKernel(kernelOptions());
    expect(typeof k.setTicksPerFrame).toBe('function');
  });

  it('runs a tick with no store rows, no places and null ports', () => {
    const k = createKernel(kernelOptions());
    k.clock.resume('boot');
    const ends: number[] = [];
    k.on('tickEnd', (t) => ends.push(t));
    for (let i = 0; i < 60; i++) k.advance(1000 / 60);
    expect(ends).toEqual(Array.from({ length: 30 }, (_, i) => i + 1));
  });
});

describe('kernel.time.use (the seam of C1b, C4, C5, C6)', () => {
  it('installs hooks; the latest install runs; an undo removes only its own install, in any order', () => {
    const k = createKernel(kernelOptions());
    k.clock.resume('boot');
    const seen: string[] = [];
    const undoA = k.time.use({ tickStart: () => seen.push('a') });
    k.runTicks(1);
    const undoB = k.time.use({ tickStart: () => seen.push('b') });
    k.runTicks(1);
    undoA(); // not the running one: b stays
    k.runTicks(1);
    undoB(); // back to the default, not to a
    k.runTicks(1);
    undoB(); // idempotent
    expect(seen).toEqual(['a', 'b', 'b']);
    const undoC = k.time.use({ tickStart: () => seen.push('c') });
    const undoD = k.time.use({ tickStart: () => seen.push('d') });
    undoD(); // the one under it runs again
    k.runTicks(1);
    undoC();
    k.runTicks(1);
    expect(seen).toEqual(['a', 'b', 'b', 'c']);
  });

  it('refuses a hook it does not know and a non-function', () => {
    const k = createKernel(kernelOptions());
    expect(() => k.time.use({ nope: () => {} } as never)).toThrow(TypeError);
    expect(() => k.time.use({ tickStart: 3 as never })).toThrow(TypeError);
    expect(() => k.time.use({ tickStart: undefined })).not.toThrow();
  });

  it('ticks the root sim set by boot at tick % 3 === 2', () => {
    const k = createKernel(kernelOptions());
    const ran: number[] = [];
    const sim: SimInstance = { id: 'sim', place: null, path: 'sim.js', module: { tick: () => ran.push(k.clock.tick) }, ctx: null, health: new Map() };
    k.time.setRootSim(sim);
    expect(k.time.rootSim).toBe(sim);
    k.runTicks(6, { force: true }); // the Director pre-roll runs under `boot`
    expect(ran).toEqual([2, 5]);
  });
});

/** a row in C1a's real store with bound behaviors whose ctx is the store's handle (what C1b + C5 will do) */
function storeRow(k: ReturnType<typeof createKernel>, id: string, behaviors: Array<[string, TestModule]>, o: Partial<Parameters<typeof createRowRec>[0]> = {}) {
  const rec: RowRec = createRowRec({ id, serial: k.store.allocSerial(), vm: 'platform', place: 'p1', ...o });
  const ctxs = new Map<BehaviorInstance, { self: ObjectView; sleep(s?: number): void }>();
  for (const [path, mod] of behaviors) {
    rec.behaviors.push(
      bindBehavior(rec, path, mod, {
        listeners: k.time.listeners,
        ctxFor: (r, inst) => {
          const ctx = { self: k.store.handle(r, r.vm), sleep: (s?: number) => sleepFor(inst, k.clock.tick, s) };
          ctxs.set(inst, ctx);
          return ctx as never;
        },
      }),
    );
  }
  k.store.insert(rec);
  rec.pendingSpawnHooks = false; // C1b runs onSpawn; these rows have none
  k.notify('rowSpawned', rec);
  return rec;
}

describe('the defaults over the row store of WP C1a', () => {
  it('the store\'s writer is the running hook ("engine" outside one)', () => {
    const k = createKernel(kernelOptions());
    k.clock.resume('boot');
    const writers: Invoker[] = [];
    storeRow(k, 'lamp-1', [['scripts/map/flicker.js', { update: () => writers.push(k.store.invoker) }]]);
    k.runTicks(1);
    expect(writers).toEqual([{ row: 'lamp-1', behavior: 'scripts/map/flicker.js' }]);
    expect(k.store.invoker).toBe('engine');
  });

  it('updates the store\'s rows in serial order and a handle write wakes the row\'s other sleepers, never the writer', () => {
    const k = createKernel(kernelOptions());
    k.clock.resume('boot');
    const runs: string[] = [];
    const writer: TestModule = {
      update: (ctx: { self: ObjectView }) => {
        runs.push(`w${k.clock.tick}`);
        if (k.clock.tick % 2 === 0) (ctx.self.state as Record<string, unknown>)['lit'] = k.clock.tick;
      },
    };
    const sleeper: TestModule = {
      update: (ctx: { sleep(): void }) => {
        runs.push(`s${k.clock.tick}`);
        ctx.sleep();
      },
    };
    const self: TestModule = {
      update: (ctx: { self: ObjectView; sleep(): void }) => {
        runs.push(`x${k.clock.tick}`);
        (ctx.self.state as Record<string, unknown>)['own'] = k.clock.tick; // its own write does not wake it
        ctx.sleep();
      },
    };
    storeRow(k, 'a', [['scripts/writer.js', writer], ['scripts/sleeper.js', sleeper]]);
    storeRow(k, 'b', [['scripts/self.js', self]]);
    k.runTicks(4);
    expect(runs).toEqual(['w1', 's1', 'x1', 'w2', 's2', 'w3', 'w4', 's4']);
  });

  it('the update list holds the rows with behaviors in serial order across both VMs and follows every insert and detach', () => {
    const k = createKernel(kernelOptions());
    k.clock.resume('boot');
    const runs: string[] = [];
    const mod = (tag: string): TestModule => ({ update: () => runs.push(`${tag}${k.clock.tick}`) });
    storeRow(k, 'a', [['scripts/a.js', mod('a')]]);
    storeRow(k, 'bare-1', []);
    storeRow(k, 'c', [['scripts/c.js', mod('c')]], { vm: 'client' });
    k.runTicks(1);
    const before = k.store.membership;
    // an unchanged membership keeps the list (one tick more, the same two rows)
    k.runTicks(1);
    storeRow(k, 'b', [['scripts/b.js', mod('b')]]);
    storeRow(k, 'bare-2', []);
    expect(k.store.membership).toBe(before + 2);
    k.runTicks(1);
    const gone = k.store.detach('a')!;
    k.notify('rowDestroyed', gone);
    expect(k.store.membership).toBe(before + 3);
    k.runTicks(1);
    expect(runs).toEqual(['a1', 'c1', 'a2', 'c2', 'a3', 'c3', 'b3', 'c4', 'b4']);
  });

  it('an engine writeback wakes nobody and is not a feed change', () => {
    const k = createKernel(kernelOptions());
    k.clock.resume('boot');
    const runs: number[] = [];
    const rec = storeRow(k, 'gib-1', [['scripts/gib.js', { update: (ctx: { sleep(): void }) => (runs.push(k.clock.tick), ctx.sleep()) }]]);
    k.runTicks(1);
    k.feed.drain({ added: () => {}, changed: () => {}, removed: () => {} });
    k.store.engineWriteTransform(rec, { x: 1, y: 2, z: 3 }, { x: 0, y: 0, z: 0 }, true);
    const changed = vi.fn();
    k.runTicks(2);
    k.feed.drain({ added: () => {}, changed, removed: () => {} });
    expect(runs).toEqual([1]);
    expect(changed).not.toHaveBeenCalled();
  });

  it('feeds the row feed: added at spawn, the written top-level fields, removed at disposal', () => {
    const k = createKernel(kernelOptions());
    k.clock.resume('boot');
    const rec = storeRow(k, 'door-1', [
      [
        'scripts/map/door.js',
        {
          update: (ctx: { self: ObjectView }) => {
            if (k.clock.tick === 1) {
              ctx.self.visible = false;
              (ctx.self.state as Record<string, unknown>)['open'] = true;
              ctx.self.visible = true;
            }
          },
        },
      ],
    ]);
    const log: string[] = [];
    const sink = {
      added: (r: RowSnapshot) => log.push(`+${r.id}`),
      changed: (r: RowSnapshot, f: readonly string[]) => log.push(`~${r.id}:${f.join(',')}`),
      removed: (id: string) => log.push(`-${id}`),
    };
    k.feed.drain(sink);
    k.runTicks(1);
    k.feed.drain(sink);
    k.store.detach(rec.id);
    k.notify('rowDestroyed', rec);
    k.feed.drain(sink);
    expect(log).toEqual(['+door-1', '~door-1:visible,state', '-door-1']);
  });

  it('drains the store\'s change list at step H and marks the UI dirty when it held a write', () => {
    const ports = createNullPorts();
    const dirty = vi.spyOn(ports.ui, 'markDirty');
    const k = createKernel(kernelOptions({ ports: { ui: ports.ui } }));
    k.clock.resume('boot');
    storeRow(k, 'r', [['scripts/r.js', { update: (ctx: { self: ObjectView }) => k.clock.tick === 2 && ((ctx.self.state as Record<string, unknown>)['n'] = 2) }]]);
    k.runTicks(3);
    expect(dirty).toHaveBeenCalledTimes(1);
    expect(k.store.takeChanges()).toEqual([]);
  });

  it('delivers onInput to the store\'s human body and presents acts against it', () => {
    const ports = createNullPorts();
    const sample = { axes: { moveX: 1 }, held: {}, pressed: { fire: true }, released: {}, actions: {} };
    vi.spyOn(ports.input, 'sampleTick').mockReturnValue(sample);
    const k = createKernel(kernelOptions({ ports: { input: ports.input } }));
    k.clock.resume('boot');
    const got: unknown[] = [];
    const body = storeRow(k, 'player/local', [['scripts/player.js', { onInput: (_c: unknown, input: unknown) => got.push(input) }]], {
      vm: 'client',
      player: { userId: 'pg-7', displayName: 'Operator', bodyId: 'player/local', look: [] },
    });
    const there = storeRow(k, 'far', [['scripts/far.js', {}]], { place: 'p2' });
    k.runTicks(2);
    expect(got).toEqual([sample, sample]);
    const heard: Array<string | null> = [];
    k.acts.register('playSound', (a) => heard.push(a.id));
    const here = k.bus.emit({ kind: 'row', row: body, behavior: body.behaviors[0]! }, 'playSound', { clip: 'a' });
    const elsewhere = k.bus.emit({ kind: 'row', row: there, behavior: there.behaviors[0]! }, 'playSound', { clip: 'b' });
    const toMe = k.bus.emit({ kind: 'row', row: body, behavior: body.behaviors[0]! }, 'playSound', { clip: 'c' }, { audience: { player: 'pg-7' } });
    expect(heard).toEqual([here, toMe]);
    expect(elsewhere).toBe('snd-2');
  });

  it('measures nearby audiences on world feet through the store: a child row stands at its parent plus its own offset', () => {
    const k = createKernel(kernelOptions());
    k.clock.resume('boot');
    const heard: string[] = [];
    storeRow(k, 'cart-1', [], { transform: { pos: { x: 50, y: 0, z: 0 } } });
    storeRow(k, 'cart-1/seat', [['scripts/seat.js', { ears: { horn: () => heard.push('seat') } }]], { parentId: 'cart-1', transform: { pos: { x: 1, y: 0, z: 0 } } });
    storeRow(k, 'post', [['scripts/post.js', { ears: { horn: () => heard.push('post') } }]], { transform: { pos: { x: 1, y: 0, z: 0 } } });
    const src = storeRow(k, 'src', [['scripts/src.js', {}]]);
    k.bus.emit({ kind: 'row', row: src, behavior: src.behaviors[0]! }, 'horn', null, { audience: { nearby: { x: 51, y: 0, z: 0 }, radius: 2 } });
    k.bus.drain();
    expect(heard).toEqual(['seat']); // its local feet (1, 0, 0) are 50 m from the horn; the post really stands there
  });

  it('cleans a disposed row: its listeners, timers and tweens go', () => {
    const k = createKernel(kernelOptions());
    k.clock.resume('boot');
    const mod: TestModule = { ears: { a: () => {} }, later: () => {} };
    const rec = storeRow(k, 'r', [['scripts/r.js', mod]]);
    const owner = { kind: 'row' as const, row: rec, inst: rec.behaviors[0]! };
    k.time.listeners.on(owner, 'b', () => {});
    k.time.timers.after(owner, mod, k.clock.tick, 5, 'later');
    const handle = k.store.handle(rec, 'platform');
    const target = { handle };
    k.time.tweens.add(k.clock.now(), handle, { 'state.n': 5 }, { duration: 1 });
    expect([k.time.listeners.ofRow('r').length, k.time.timers.size, k.time.tweens.size, target.handle]).toEqual([2, 1, 1, handle]);
    k.store.detach(rec.id);
    k.notify('rowDestroyed', rec);
    expect([k.time.listeners.ofRow('r').length, k.time.timers.size, k.time.tweens.size]).toEqual([0, 0, 0]);
  });
});
