import { describe, expect, it } from 'vitest';
import { SlowMoClock } from '../../src/compat/core/sched/slowmo.ts';
import { testWorld, type Module } from './world.ts';

const FRAME = 1000 / 30;
const MODULES: Record<string, Module> = { 'templates/player.js': { player: { tags: ['player'] } } };

async function world(slowMo: boolean) {
  const w = await testWorld({ modules: MODULES, ext: { slowMo } });
  w.k.spawnHuman({ place: 'p1', at: { x: 0, y: 0, z: 0 }, userId: 'u', displayName: 'U', durableState: {} });
  const sim = w.rootSim({}).ctx as any;
  /** ticks run over `n` host frames of `dt` ms */
  const run = (n: number, dt = FRAME) => {
    let ticks = 0;
    for (let i = 0; i < n; i++) ticks += w.k.advance(dt).ticks;
    return ticks;
  };
  return { w, sim, run };
}

describe('K8: slowMo act (ext.slowMo)', () => {
  it('opt-in: scale 0.5 for 1 s halves the tick rate for that second, then normal speed returns', async () => {
    const { w, sim, run } = await world(true);
    expect(run(30)).toBe(30);
    const t0 = w.k.clock.now();
    expect(sim.emit('slowMo', { scale: 0.5, duration: 1 })).toBeUndefined();
    expect(w.k.time.slowMo!.scale).toBe(0.5);
    expect(run(30)).toBe(15); // one real second
    expect(w.k.clock.now() - t0).toBeCloseTo(15 * FRAME, 6); // ctx.now() slowed with it
    expect(w.k.time.slowMo!.active).toBe(false);
    expect(run(30)).toBe(30);
    expect(w.k.metrics.slowMoIgnored).toBe(0);
  });

  it('opt-in: emit passes slowMo through even when no human is presented the act (no human, other place)', async () => {
    const w = await testWorld({ modules: MODULES, ext: { slowMo: true } }); // no human spawned
    const sim = w.rootSim({}).ctx as any;
    const seen: unknown[] = [];
    w.k.acts.register('slowMo', (a) => void seen.push(a.payload));
    sim.emit('slowMo', { scale: 0.5, duration: 1 });
    expect(w.k.time.slowMo!.scale).toBe(0.5);
    expect(seen).toEqual([]); // the sink still follows the visibility filter
    expect(w.k.metrics.actsFiltered).toBe(1);
    expect(w.k.metrics.slowMoIgnored).toBe(0);
  });

  it('opt-in: a new slowMo replaces the running one, scale 1 cancels it', async () => {
    const { w, sim, run } = await world(true);
    sim.emit('slowMo', { scale: 0.25, duration: 10 });
    expect(run(60)).toBe(15); // 2 s of host frames at a quarter speed
    sim.emit('slowMo', { scale: 1, duration: 1 });
    expect(w.k.time.slowMo!.scale).toBe(1);
    expect(run(30)).toBe(30);
  });

  it('opt-in: malformed payloads change nothing', async () => {
    const { w, sim, run } = await world(true);
    for (const bad of [{}, { scale: 'x', duration: 1 }, { scale: 0.5 }, { scale: 0.5, duration: -1 }, { scale: NaN, duration: 1 }, null]) sim.emit('slowMo', bad);
    expect(w.k.time.slowMo!.active).toBe(false);
    expect(run(30)).toBe(30);
  });

  it('the effect does not elapse while the clock is paused', async () => {
    const { w, sim, run } = await world(true);
    sim.emit('slowMo', { scale: 0.5, duration: 1 });
    run(15); // half the effect
    expect(w.k.time.slowMo!.scale).toBe(0.5);
    w.k.clock.pause('platform');
    expect(run(300)).toBe(0);
    w.k.clock.resume('platform');
    expect(w.k.time.slowMo!.active).toBe(true);
    expect(run(15)).toBe(7); // the remaining half second still runs slowed (7 or 8 ticks by accumulator rounding)
  });

  it('negative control (option off): the act is ignored and counted, speed is unchanged', async () => {
    const { w, sim, run } = await world(false);
    sim.emit('slowMo', { scale: 0.25, duration: 5 });
    expect(w.k.time.slowMo).toBeNull();
    expect(w.k.metrics.slowMoIgnored).toBe(1);
    expect(run(30)).toBe(30);
  });
});

describe('SlowMoClock easing', () => {
  it('true / linear eases back to 1 across the duration; a hold stays at the scale', () => {
    const lin = new SlowMoClock();
    lin.apply({ scale: 0.2, duration: 1, easing: true });
    expect(lin.step(0)).toBeCloseTo(0.2, 9);
    lin.step(250), lin.step(250);
    expect(lin.scale).toBeCloseTo(0.6, 9);
    const hold = new SlowMoClock();
    hold.apply({ scale: 0.2, duration: 1 });
    hold.step(250), hold.step(250);
    expect(hold.scale).toBe(0.2);
    const out = new SlowMoClock();
    out.apply({ scale: 0.2, duration: 1, easing: 'easeOut' });
    out.step(250), out.step(250);
    expect(out.scale).toBeGreaterThan(0.6);
    const into = new SlowMoClock();
    into.apply({ scale: 0.2, duration: 1, easing: 'easeIn' });
    into.step(250), into.step(250);
    expect(into.scale).toBeLessThan(0.6);
  });

  it('clamps the scale to [0.05, 4]', () => {
    const c = new SlowMoClock();
    c.apply({ scale: 0.001, duration: 1 });
    expect(c.scale).toBe(0.05);
    c.apply({ scale: 100, duration: 1 });
    expect(c.scale).toBe(4);
  });
});
