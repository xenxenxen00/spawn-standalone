// Synthetic FX programs cover offsets, emission delays, arcs, held points, local headers, and bare normalization.
import { describe, expect, it } from 'vitest';
import { clearFxCache, compileProgram, FxCompileError, type CompiledPop } from '../../../../src/render/fx/dsl/compile.ts';
import { parseProgram } from '../../../../src/render/fx/dsl/parser.ts';
import { createFxSimulation } from '../../../../src/render/fx/sim/simulator.ts';

const DESK = { low: false, mobile: false };
const MOBILE = { low: false, mobile: true };
const strict = { strict: true, cache: false } as const;
const pop = (text: string, name: string, tier = DESK, params: Record<string, unknown> = {}): CompiledPop => {
  const p = compileProgram(text, params, tier, strict);
  return p.pops.find((x) => x.name === name)!;
};

const OFFSETS = `fx
pop rise rate=2 life=1 r=sprite(mote,add)
pop twinkle n=2 pos=<1,2,3> life=1 r=sprite(mote,add)`;
const PARAMETERS = `fx
pop ring n=1 pos=<-1,1,2> size=%s|1 life=%t|1 r=sprite(mote,add)`;
const ARC_SHAPE = `fx
pop glint rate=3 on=arc(2,6.283,.2) life=1 v=up(-1)+sdir()*.2 tint=<1,0,0>..<0,1,0> col=$tint r=sprite(mote,add)`;
const SHORT_DELAY = `fx
pop ring2 burst=7 delay=.1 life=.2 v=(sdir()*<1,0,1>).norm*2 r=sprite(mote,add,velocity,.1)`;
const DELAYED_POPS = `fx
pop orbit burst=3 on=sphere(1) life=1 r=sprite(mote,add)
pop gold burst=8 delay=.25 life=1 v=sdir()*2 acc=drag(1) r=sprite(mote,add)
pop flash burst=2 delay=.25 life=.5 r=sprite(mote,add)`;
const MOBILE_ARC = `fx
pop ring n=?mobile:4|8 on=arc(1,6.283,.2) life=1 tint=hdr(1,0,0)..hdr(0,1,0) col=$tint r=sprite(mote,add)
pop spark rate=?mobile:2|4 on=arc(2,6.283,.1) life=1 v=up(1)+sdir()*.2 r=sprite(mote,add,velocity,.1)`;
const HELD_OFFSET = `fx
pop glow n=1 at=<1,2,3> r=light(<1,1,1>,2,4)`;
const LOCAL_HEADER = `fx
local
pop flow rate=?mobile:3|6 on=box(2,1,3) life=1 v=<0,0,1>*2+up(1) r=sprite(mote,add,velocity,.1)`;
const RADIAL = `fx
pop red burst=?mobile:3|6 on=arc(1,6.283,.2) life=1 v=radial(2) size=.1 col=hdr(1,0,0) r=sprite(mote,add)
pop blue burst=?mobile:2|4 on=arc(2,6.283,.1) life=1 v=radial(1) size=.2 col=hdr(0,0,1) r=sprite(mote,add)`;

const ALL: Array<[string, string, Record<string, unknown>]> = [
  ['OFFSETS', OFFSETS, {}],
  ['PARAMETERS', PARAMETERS, { s: 1.4, t: 4 }],
  ['ARC_SHAPE', ARC_SHAPE, {}],
  ['ring2', SHORT_DELAY, {}],
  ['DELAYED_POPS', DELAYED_POPS, {}],
  ['MOBILE_ARC', MOBILE_ARC, {}],
  ['HELD_OFFSET', HELD_OFFSET, {}],
  ['LOCAL_HEADER', LOCAL_HEADER, {}],
  ['RADIAL', RADIAL, {}],
];

describe('K11 synthetic programs compile in strict mode on both tiers', () => {
  it.each(ALL)('%s', (_name, text, params) => {
    for (const tier of [DESK, MOBILE]) expect(() => compileProgram(text, params, tier, strict)).not.toThrow();
  });

  it('negative control: before K11 these spellings were refused, and a misspelt key still is', () => {
    expect(() => compileProgram('fx\npop a burst=1 life=1 lfe=2 r=sprite(soft-disc,add)', {}, DESK, strict)).toThrow(FxCompileError);
    expect(() => compileProgram('fx\npop a burst=1 life=1 pox=<0,1,0> r=sprite(soft-disc,add)', {}, DESK, strict)).toThrow(FxCompileError);
    expect(() => compileProgram('fx\npop a burst=1 on=ring(1) r=sprite(soft-disc,add)', {}, DESK, strict)).toThrow(FxCompileError);
    expect(() => compileProgram('fx\nlocall\npop a burst=1 life=1 r=sprite(soft-disc,add)', {}, DESK, strict)).toThrow(FxCompileError);
    expect(() => compileProgram('fx\npop a burst=1 life=1 delay=-1 r=sprite(soft-disc,add)', {}, DESK, strict)).toThrow(FxCompileError);
  });
});

describe('K11 compiled form', () => {
  it('pos= is a constant offset of the population', () => {
    expect(pop(OFFSETS, 'twinkle').pos).toEqual([1, 2, 3]);
    expect(pop(OFFSETS, 'rise').pos).toBeUndefined();
    expect(pop(PARAMETERS, 'ring', DESK, { s: 2, t: 4 }).pos).toEqual([-1, 1, 2]);
  });

  it('delay= is seconds; absent means undefined', () => {
    expect(pop(DELAYED_POPS, 'gold').delay).toBe(0.25);
    expect(pop(DELAYED_POPS, 'flash').delay).toBe(0.25);
    expect(pop(DELAYED_POPS, 'orbit').delay).toBeUndefined();
    expect(pop(SHORT_DELAY, 'ring2').delay).toBe(0.1);
  });

  it('arc(r, sweep, thickness) is a ring shape; fewer arguments default to a full thin ring', () => {
    expect(pop(ARC_SHAPE, 'glint').birth).toEqual({ kind: 'arc', r: 2, sweep: 6.283, width: 0.2, lift: 0, mode: 'on' });
    expect(pop('fx\npop a rate=5 on=arc(2).c(1) life=1 r=sprite(soft-disc,add)', 'a').birth).toEqual({ kind: 'arc', r: 2, sweep: Math.PI * 2, width: 0, lift: 1, mode: 'on' });
    expect(() => compileProgram('fx\npop a rate=5 on=arc() life=1 r=sprite(soft-disc,add)', {}, DESK, strict)).toThrow(FxCompileError);
    expect(() => compileProgram('fx\npop a rate=5 on=arc(1,2,3,4) life=1 r=sprite(soft-disc,add)', {}, DESK, strict)).toThrow(FxCompileError);
  });

  it('at=<x,y,z> is a held point at that offset', () => {
    const glow = pop(HELD_OFFSET, 'glow');
    expect(glow.birth).toEqual({ kind: 'point', lift: 0, mode: 'at' });
    expect(glow.pos).toEqual([1, 2, 3]);
    expect(glow.emit).toEqual({ kind: 'held', n: { lo: 1, hi: 1 } });
  });

  it('a bare local line sets header.local and the program otherwise compiles as without it', () => {
    const withLocal = compileProgram(LOCAL_HEADER, {}, DESK, strict);
    const without = compileProgram(LOCAL_HEADER.replace('local\n', ''), {}, DESK, strict);
    expect(withLocal.header).toEqual({ local: true });
    expect(without.header).toEqual({});
    expect(withLocal.pops).toEqual(without.pops);
  });

  it('the parse of a program with no new spelling is unchanged (no flags key)', () => {
    const ast = parseProgram('fx\npop a burst=1 life=1 r=sprite(soft-disc,add)');
    expect('flags' in ast).toBe(false);
    clearFxCache();
  });
});

describe('K11 .norm without parentheses', () => {
  const v = (m: string) => pop(`fx
pop a burst=1 life=1 v=(sdir()*<1,1,0>).${m}*5 r=sprite(soft-disc,add)`, 'a').v;
  it('reads the same as .norm()', () => {
    expect(v('norm')).toEqual(v('norm()'));
    expect(v('norm')).not.toBeNull();
  });
  it('negative control: a method that needs arguments still needs its parentheses', () => {
    expect(() => compileProgram('fx\npop a burst=1 life=1 v=<1,0,0>.mix*5 r=sprite(soft-disc,add)', {}, DESK, strict)).toThrow(FxCompileError);
  });
});

describe('K11 simulation', () => {
  const run = (text: string, steps: number, dt = 0.05, params: Record<string, unknown> = {}, seed = 7) => {
    const sim = createFxSimulation(compileProgram(text, params, DESK, strict), { seed, capacity: 512 });
    const counts: number[] = [];
    for (let i = 0; i < steps; i++) {
      sim.step(dt, (i + 1) * dt);
      counts.push(sim.population(sim.program.pops[sim.program.pops.length - 1]!.name)!.count);
    }
    return { sim, counts };
  };

  it('delay=.25 spawns nothing before t = 0.25 s and the whole burst then; the undelayed pop is there from the start', () => {
    const sim = createFxSimulation(compileProgram(DELAYED_POPS, {}, DESK, strict), { seed: 3, capacity: 512 });
    expect(sim.population('orbit')!.count).toBe(3);
    expect(sim.population('gold')!.count).toBe(0);
    expect(sim.population('flash')!.count).toBe(0);
    expect(sim.finished).toBe(false);
    let t = 0;
    while (t < 0.2 - 1e-9) {
      t += 0.05;
      sim.step(0.05, t);
    }
    expect(sim.time).toBeCloseTo(0.2, 9);
    expect(sim.population('gold')!.count).toBe(0);
    expect(sim.population('flash')!.count).toBe(0);
    t += 0.05;
    sim.step(0.05, t);
    expect(sim.time).toBeCloseTo(0.25, 9);
    expect(sim.population('gold')!.count).toBe(8);
    expect(sim.population('flash')!.count).toBe(2);
    // negative control: the same program without delay= fires at once
    const now = createFxSimulation(compileProgram(DELAYED_POPS.replaceAll(' delay=.25', ''), {}, DESK, strict), { seed: 3, capacity: 512 });
    expect(now.population('gold')!.count).toBe(8);
    sim.dispose();
    now.dispose();
  });

  it('a delayed effect is not finished while its burst is waiting, and finishes after it dies', () => {
    const sim = createFxSimulation(compileProgram(SHORT_DELAY, {}, DESK, strict), { seed: 1, capacity: 128 });
    expect(sim.particleCount).toBe(0);
    expect(sim.finished).toBe(false);
    for (let i = 1; i <= 40; i++) sim.step(0.05, i * 0.05);
    expect(sim.finished).toBe(true);
    sim.dispose();
  });

  it('a delayed rate population starts emitting at its delay, not before', () => {
    const text = 'fx\npop d rate=100 delay=.5 life=5 size=.1 r=sprite(soft-disc,add)';
    const sim = createFxSimulation(compileProgram(text, {}, DESK, strict), { seed: 1, capacity: 512 });
    for (let i = 1; i <= 9; i++) sim.step(0.05, i * 0.05);
    expect(sim.population('d')!.count).toBe(0);
    for (let i = 10; i <= 20; i++) sim.step(0.05, i * 0.05);
    expect(sim.population('d')!.count).toBeGreaterThan(30);
  });

  it('stop() drops a pending held population but still fires a pending burst once', () => {
    const held = createFxSimulation(compileProgram('fx\npop h n=5 delay=.2 life=5 r=sprite(soft-disc,add)', {}, DESK, strict), { seed: 1, capacity: 64 });
    held.stop();
    for (let i = 1; i <= 10; i++) held.step(0.05, i * 0.05);
    expect(held.population('h')!.count).toBe(0);
    const burst = createFxSimulation(compileProgram('fx\npop b burst=5 delay=.2 life=5 r=sprite(soft-disc,add)', {}, DESK, strict), { seed: 1, capacity: 64 });
    burst.stop();
    for (let i = 1; i <= 10; i++) burst.step(0.05, i * 0.05);
    expect(burst.population('b')!.count).toBe(5);
  });

  it('pos= shifts every birth of its population and no other', () => {
    const sim = createFxSimulation(compileProgram('fx\npop a burst=20 pos=<1,2,3> life=1 r=sprite(soft-disc,add)\npop b burst=20 life=1 r=sprite(soft-disc,add)', {}, DESK, strict), { seed: 5, capacity: 64 });
    const a = sim.population('a')!;
    const b = sim.population('b')!;
    for (let k = 0; k < a.count; k++) expect(Array.from(sim.positions.subarray(a.indices[k]! * 3, a.indices[k]! * 3 + 3))).toEqual([1, 2, 3]);
    for (let k = 0; k < b.count; k++) expect(Array.from(sim.positions.subarray(b.indices[k]! * 3, b.indices[k]! * 3 + 3))).toEqual([0, 0, 0]);
    sim.dispose();
  });

  it('pos= adds to the shape and moves with the emitter origin; a child born at its parent keeps the parent position', () => {
    const sim = createFxSimulation(compileProgram('fx\npop a burst=10 on=disc(.5) pos=<0,.5,0> life=1 r=sprite(soft-disc,add)', {}, DESK, strict), { seed: 9, capacity: 64, origin: [10, 0, 0] });
    const a = sim.population('a')!;
    for (let k = 0; k < a.count; k++) {
      const o = a.indices[k]! * 3;
      expect(Math.hypot(sim.positions[o]! - 10, sim.positions[o + 2]!)).toBeLessThanOrEqual(0.5 + 1e-6);
      expect(sim.positions[o + 1]).toBeCloseTo(0.5, 6);
    }
    const kids = createFxSimulation(compileProgram('fx\npop p burst=1 pos=<5,0,0> life=.1 r=sprite(soft-disc,add)\npop c on=@p pos=<0,9,0> life=1 r=sprite(soft-disc,add)', {}, DESK, strict), { seed: 2, capacity: 16 });
    for (let i = 1; i <= 4; i++) kids.step(0.05, i * 0.05);
    const c = kids.population('c')!;
    expect(c.count).toBe(1);
    expect(kids.positions[c.indices[0]! * 3]).toBeGreaterThan(4);
    expect(kids.positions[c.indices[0]! * 3 + 1]).toBeLessThan(1);
  });

  it('arc(r, 2pi, w) births on a ring of radius r, w thick, in the XZ plane; a half sweep stays on one side', () => {
    const ring = createFxSimulation(compileProgram('fx\npop g burst=300 on=arc(.55,6.283,.06) life=1 r=sprite(soft-disc,add)', {}, DESK, strict), { seed: 11, capacity: 512 });
    const g = ring.population('g')!;
    let minR = Infinity;
    let maxR = 0;
    let maxY = 0;
    const quadrants = new Set<string>();
    for (let k = 0; k < g.count; k++) {
      const o = g.indices[k]! * 3;
      const r = Math.hypot(ring.positions[o]!, ring.positions[o + 2]!);
      minR = Math.min(minR, r);
      maxR = Math.max(maxR, r);
      maxY = Math.max(maxY, Math.abs(ring.positions[o + 1]!));
      quadrants.add(`${Math.sign(ring.positions[o]!)}${Math.sign(ring.positions[o + 2]!)}`);
    }
    expect(minR).toBeGreaterThanOrEqual(0.55 - 0.03 - 1e-6);
    expect(maxR).toBeLessThanOrEqual(0.55 + 0.03 + 1e-6);
    expect(maxY).toBe(0);
    expect(quadrants.size).toBe(4);
    const half = createFxSimulation(compileProgram(`fx\npop g burst=200 on=arc(1,${Math.PI},0) life=1 r=sprite(soft-disc,add)`, {}, DESK, strict), { seed: 11, capacity: 512 });
    const h = half.population('g')!;
    for (let k = 0; k < h.count; k++) expect(half.positions[h.indices[k]! * 3 + 2]).toBeGreaterThanOrEqual(-1e-6);
    ring.dispose();
    half.dispose();
  });

  it('every synthetic program above runs 3 simulated seconds without throwing and ends with finite positions', () => {
    for (const [, text, params] of ALL) {
      const sim = createFxSimulation(compileProgram(text, params, DESK, strict), { seed: 4, capacity: 2048 });
      for (let i = 1; i <= 60; i++) sim.step(0.05, i * 0.05);
      for (let i = 0; i < sim.particleCount * 3; i++) if (!Number.isFinite(sim.positions[i])) throw new Error('non-finite position');
      sim.dispose();
    }
  });
});
