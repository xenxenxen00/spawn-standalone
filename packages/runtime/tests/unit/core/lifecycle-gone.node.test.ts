// The "destroy: no such object" diagnostic (core §4 destroy table: a missing id warns, never throws [LIVE
// scripts/enemies/probes.js:131]). The warning stays a warning; when the id left recently it also says how, from a bounded
// ring of the last GONE_MAX removals (src/compat/core/lifecycle.ts GoneRing):
//   destroy: no such object <id> (gone <N> ticks: <cause>) by <issuer of the failed destroy>
// with <cause> one of `lifetime`, `cascade from <id>`, `onOutOfBounds`, `destroyed by <script>`, `place unload`. An id the
// ring never saw (or has forgotten) keeps the plain line, the negative control throughout.
import { describe, expect, it } from 'vitest';
import { GONE_MAX, GoneRing, destroyRows } from '../../../src/compat/core/lifecycle.ts';
import { world, type MiniCtx, type Module } from './fakes/lifecycle-world.ts';

const A = 'scripts/a.js';
const B = 'scripts/b.js';
const plain = (id: string): string => `destroy: no such object ${id}`;

describe('GoneRing', () => {
  it('remembers the last `capacity` removals, oldest forgotten first; a re-removed id keeps only its latest', () => {
    const r = new GoneRing(3);
    r.note('a', 1, 'lifetime');
    r.note('b', 2, 'cascade from a');
    r.note('c', 3, 'onOutOfBounds');
    expect(r.get('a')).toEqual({ tick: 1, cause: 'lifetime' });
    r.note('d', 4, 'destroyed by scripts/x.js');
    expect(r.get('a')).toBeNull(); // overwritten
    expect(r.get('b')).toEqual({ tick: 2, cause: 'cascade from a' });
    expect(r.size).toBe(3);
    // slots go round in order: d took a's slot 0; b (again) takes slot 1, e slot 2 (c forgotten), f slot 0 (d forgotten)
    r.note('b', 5, 'lifetime');
    r.note('e', 6, 'lifetime');
    r.note('f', 7, 'lifetime');
    expect(r.get('b')).toEqual({ tick: 5, cause: 'lifetime' });
    expect(r.get('c')).toBeNull();
    expect(r.get('d')).toBeNull();
    expect(r.size).toBe(3);
    // an id noted twice whose LATER slot is overwritten is forgotten, not answered from its stale earlier slot
    const q = new GoneRing(2);
    q.note('x', 1, 'lifetime');
    q.note('x', 2, 'onOutOfBounds');
    expect(q.get('x')).toEqual({ tick: 2, cause: 'onOutOfBounds' });
    q.note('y', 3, 'lifetime'); // slot 0: x's stale slot
    expect(q.get('x')).toEqual({ tick: 2, cause: 'onOutOfBounds' });
    q.note('z', 4, 'lifetime'); // slot 1: x's live slot
    expect(q.get('x')).toBeNull();
  });

  it('never grows past its capacity', () => {
    const r = new GoneRing(16);
    for (let i = 0; i < 1000; i++) r.note(`id-${i}`, i, 'lifetime');
    expect(r.size).toBe(16);
    expect(r.get('id-983')).toBeNull();
    expect(r.get('id-984')).toEqual({ tick: 984, cause: 'lifetime' });
  });
});

describe('destroy of a missing id (core §4): a warning that says how the id left', () => {
  it('negative control: an id that never existed gives the plain line, once, and nothing throws', async () => {
    const w = await world();
    expect(() => w.destroy('ghost')).not.toThrow();
    w.destroy('ghost');
    expect(w.warnings.filter((m) => m.startsWith('destroy:'))).toEqual([plain('ghost')]);
  });

  it('lifetime: the beam box an attack destroys after its lifetime ran out (gravemason.js onAttackEnd)', async () => {
    const w = await world();
    w.spawn('beam', { lifetime: 0.1 }); // 3 ticks
    const born = w.k.clock.tick;
    w.ticks(10);
    expect(w.row('beam')).toBeUndefined();
    const gone = w.k.lifecycle.gone.get('beam')!;
    expect(gone).toEqual({ tick: born + 3, cause: 'lifetime' });
    w.destroy('beam');
    expect(w.warnings).toContain(`destroy: no such object beam (gone ${w.k.clock.tick - gone.tick} ticks: lifetime) by kernel`);
    expect(w.k.clock.tick - gone.tick).toBeGreaterThan(0);
  });

  it('cascade: an owned row removed with its spawner, then destroyed again by a sim (bosses/index.js reset)', async () => {
    const spawner: Module = {
      onSpawn(ctx: MiniCtx) {
        ctx.spawn('bolt', { behavior: B });
      },
    };
    const bolt: Module = {
      onSpawn(ctx: MiniCtx) {
        ctx.spawn('pool', {});
      },
    };
    const w = await world({ modules: { [A]: spawner, [B]: bolt } });
    w.spawn('boss', { behavior: A });
    w.boundary(); // boss onSpawn → bolt
    w.boundary(); // bolt onSpawn → pool
    expect(w.row('pool')!.spawnerId).toBe('bolt');
    w.destroy('boss');
    const sim = { kind: 'sim' as const, sim: w.sim(null) };
    destroyRows(w.k, sim, ['bolt', 'pool']);
    expect(w.warnings).toContain('destroy: no such object bolt (gone 0 ticks: cascade from boss) by sim.js');
    // the pool hung on the bolt, not on the boss: the immediate owner is named
    expect(w.warnings).toContain('destroy: no such object pool (gone 0 ticks: cascade from bolt) by sim.js');
    // the root of the destroy records its own cause
    expect(w.k.lifecycle.gone.get('boss')).toEqual({ tick: w.k.clock.tick, cause: 'destroyed by kernel' });
  });

  it('destroyed by <script>: a row a behaviour removed, then removed again by another (enemy onDestroy after the Director)', async () => {
    let target = '';
    const killer: Module = {
      update(ctx: MiniCtx) {
        if (target) {
          ctx.destroy(target);
          target = '';
        }
      },
    };
    const w = await world({ modules: { [A]: killer, [B]: {} } });
    w.spawn('k', { behavior: A });
    w.spawn('again', { behavior: B });
    w.spawn('victim', {});
    w.boundary();
    target = 'victim';
    w.ticks(1);
    expect(w.row('victim')).toBeUndefined();
    w.ticks(4);
    w.ctxOf('again').destroy('victim');
    expect(w.warnings).toContain('destroy: no such object victim (gone 4 ticks: destroyed by scripts/a.js) by scripts/b.js');
  });

  it('onOutOfBounds: a row that removed itself in its onOutOfBounds hook (enemies/oob.js), then destroyed again by a sim (endAdds)', async () => {
    const fall: Module = {
      onOutOfBounds(ctx: MiniCtx) {
        ctx.destroy();
      },
    };
    const w = await world({ modules: { [A]: fall } });
    w.spawn('add', { behavior: A });
    w.boundary();
    const row = w.row('add')!;
    const inst = row.behaviors[0]!;
    // the way places/bounds.ts calls the hook (rule 1)
    w.k.time.invoker.call({ kind: 'row', row, inst }, 'onOutOfBounds', (fall['onOutOfBounds'] as (c: MiniCtx) => void) as never, [w.ctxOf('add')]);
    expect(w.row('add')).toBeUndefined();
    w.ticks(2);
    destroyRows(w.k, { kind: 'sim', sim: w.sim(null) }, 'add');
    expect(w.warnings).toContain('destroy: no such object add (gone 2 ticks: onOutOfBounds) by sim.js');
    // control: the same self-destroy from any other hook is a plain "destroyed by"
    w.spawn('add2', { behavior: A });
    w.boundary();
    w.ctxOf('add2').destroy();
    w.destroy('add2');
    expect(w.warnings).toContain(`destroy: no such object add2 (gone 0 ticks: destroyed by ${A}) by kernel`);
  });

  it('the ring is bounded: an id removed more than GONE_MAX removals ago is forgotten and gives the plain line', async () => {
    const w = await world();
    w.spawn('first', {});
    w.destroy('first');
    for (let i = 0; i < GONE_MAX; i++) {
      w.spawn(`r${i}`, {});
      w.destroy(`r${i}`);
    }
    w.destroy('first');
    w.destroy(`r${GONE_MAX - 1}`);
    expect(w.warnings).toContain(plain('first'));
    expect(w.warnings).toContain(`destroy: no such object r${GONE_MAX - 1} (gone 0 ticks: destroyed by kernel) by kernel`);
    expect(w.k.lifecycle.gone.size).toBe(GONE_MAX);
  });

  it('is deterministic: the same run gives the same lines', async () => {
    const run = async (): Promise<string[]> => {
      const w = await world();
      for (let i = 0; i < 20; i++) w.spawn(`x${i}`, { lifetime: 0.1 * (i % 4) + 0.05 });
      w.ticks(20);
      for (let i = 0; i < 20; i++) w.destroy(`x${i}`);
      return w.warnings;
    };
    const a = await run();
    expect(a).toHaveLength(20);
    expect(await run()).toEqual(a);
  });
});
