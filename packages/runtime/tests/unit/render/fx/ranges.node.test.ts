// FXRANGE: an `a..b` range inside an fx expression is a value uniform in [a, b), fixed per particle (`sk/fx`: `size=.08..0.16`,
// `spin=-9..9`, "up(.08..0.12) rolls per particle", `cone(15)*(.2..0.5)`, `tint=<…>..<…>`). It was evaluated as the raw
// birth roll r in [0, 1); it is now lo + r·(hi − lo), with the roll drawn at birth exactly as before.
import { describe, expect, it } from 'vitest';
import { compileProgram, type CompiledPop, type Expr } from '../../../../src/render/fx/dsl/compile.ts';
import { acceleration, evaluate, type FxEvalContext, type FxValue } from '../../../../src/render/fx/sim/expression.ts';
import { createFxSimulation } from '../../../../src/render/fx/sim/simulator.ts';

const TIER = { low: false, mobile: false };
const pop = (body: string): CompiledPop => compileProgram(`fx\npop p ${body}`, {}, TIER, { strict: true }).pops[0]!;

/** a particle context whose roll of slot k is `rolls[k]`; everything else neutral */
function ctx(rolls: readonly number[], over: Partial<FxEvalContext> = {}): FxEvalContext {
  return {
    age: 0, life: 1, size: 1, rand: 0, velocity: [0, 0, 0], position: [0, 0, 0], origin: [0, 0, 0], time: 0, dt: 0,
    random: () => { throw new Error('a range bound drew random'); },
    gravity: [0, -24, 0], wind: [0, 0, 0], floorHeight: () => null, count: () => 0, attr: () => 0,
    roll: (slot) => rolls[slot] ?? 0,
    smooth: (_e, v) => v,
    ...over,
  };
}
const num = (v: FxValue): number => (typeof v === 'number' ? v : Number.NaN);
const vec = (v: FxValue): number[] => (typeof v === 'number' ? [v, v, v] : [...v]);
/** every roll node of an expression, outermost first */
function rolls(e: Expr): Extract<Expr, { k: 'roll' }>[] {
  const out: Extract<Expr, { k: 'roll' }>[] = [];
  const walk = (x: Expr): void => {
    if (x.k === 'roll') out.push(x);
    const kids: Expr[] =
      x.k === 'vec' ? [x.x, x.y, x.z] : x.k === 'roll' ? [x.lo, x.hi] : x.k === 'bin' ? [x.a, x.b] : x.k === 'neg' || x.k === 'smooth' ? [x.a]
        : x.k === 'call' ? [...x.args] : x.k === 'method' ? [x.target, ...x.args] : x.k === 'keys' ? x.frames.map((f) => f.v) : [];
    kids.forEach(walk);
  };
  walk(e);
  return out;
}

describe('fx ranges evaluate to lo + r·(hi − lo)', () => {
  it('maps a number range by its slot roll (negative control: never the raw roll)', () => {
    const p = pop('burst=1 sz=2..6 r=sprite(ember,add)');
    expect(p.sz.k).toBe('roll');
    const slot = (p.sz as Extract<Expr, { k: 'roll' }>).slot;
    const at = (r: number): number => { const rs: number[] = []; rs[slot] = r; return num(evaluate(p.sz, ctx(rs))); };
    expect(at(0)).toBe(2);
    expect(at(0.25)).toBe(3);
    expect(at(0.5)).toBe(4);
    expect(at(0.999)).toBeCloseTo(5.996, 12);
    // the pre-fix value was the roll itself
    expect(at(0.25)).not.toBe(0.25);
  });

  it('a `0..1` range is the roll itself, and an empty range folds to its bound with no slot', () => {
    const unit = pop('burst=1 sz=0..1 r=sprite(ember,add)');
    expect(num(evaluate(unit.sz, ctx([0.375])))).toBe(0.375);
    const folded = pop('burst=1 sz=3..3 r=sprite(ember,add)');
    expect(folded.sz).toEqual({ k: 'num', v: 3 });
    expect(folded.rolls).toBe(0);
    expect(pop('burst=1 sz=$size*2 r=sprite(ember,add)').rolls).toBe(0);
  });

  it('birth: a velocity range scales the direction (`<0,1,0>*(5..6)`, `up(.08..0.12)`, `cone(15)*(.2..0.5)`)', () => {
    const scaled = pop('burst=1 v=<0,1,0>*(5..6) r=sprite(ember,add)');
    expect(vec(evaluate(scaled.v!, ctx([0.5])))).toEqual([0, 5.5, 0]);
    const up = pop('burst=1 v=up(.08..0.12) r=sprite(ember,add)');
    expect(vec(evaluate(up.v!, ctx([0.5])))[1]).toBeCloseTo(0.1, 15);
    const cone = pop('burst=1 v=cone(15)*(.2..0.5) r=sprite(ember,add)');
    let draws = 0;
    const r = [0.25, 0.75];
    const c = ctx([0.5], { random: () => r[draws++ % 2]! });
    const v = vec(evaluate(cone.v!, c));
    expect(draws).toBe(2);
    expect(Math.hypot(v[0]!, v[1]!, v[2]!)).toBeCloseTo(0.35, 12);
  });

  it('field: a range in a field argument and in a term scale', () => {
    const drag = pop('burst=1 acc=drag(1..3) r=sprite(ember,add)');
    expect(drag.acc).toHaveLength(1);
    const dragRolls = drag.acc[0]!.args.flatMap(rolls);
    expect(dragRolls).toHaveLength(1);
    const rs: number[] = []; rs[dragRolls[0]!.slot] = 0.5;
    expect(acceleration(drag.acc[0]!, ctx(rs, { velocity: [1, 0, 0] }))).toEqual([-2, -0, -0]);
    const grav = pop('burst=1 acc=grav()*(.2..0.4) r=sprite(ember,add)');
    expect(grav.acc[0]!.field).toBe('grav');
    expect(acceleration(grav.acc[0]!, ctx([0.5]))[1]).toBeCloseTo(-24 * 0.3, 12);
  });

  it('appearance: size, colour (one roll for every component), alpha and rotation', () => {
    const p = pop('burst=1 sz=1..3 col=<1,0,0>..<0,0,1> a=.5..1 rot=-3..-2 r=sprite(ember,add)');
    const slotOf = (e: Expr): number => (e as Extract<Expr, { k: 'roll' }>).slot;
    const rs: number[] = [];
    rs[slotOf(p.sz)] = 0.5; rs[slotOf(p.col)] = 0.25; rs[slotOf(p.a)] = 0.5; rs[slotOf(p.rot!)] = 0.5;
    const c = ctx(rs);
    expect(num(evaluate(p.sz, c))).toBe(2);
    expect(vec(evaluate(p.col, c))).toEqual([0.75, 0, 0.25]);
    expect(num(evaluate(p.a, c))).toBe(0.75);
    expect(num(evaluate(p.rot!, c))).toBe(-2.5);
  });

  it('nested: a range whose bounds are ranges uses three slots, inner bounds first', () => {
    const p = pop('burst=1 sz=(1..2)..(5..6) r=sprite(ember,add)');
    const [outer, lo, hi] = rolls(p.sz);
    expect(outer && lo && hi).toBeTruthy();
    expect(new Set([outer!.slot, lo!.slot, hi!.slot]).size).toBe(3);
    expect(p.rolls).toBe(3);
    const rs: number[] = [];
    rs[lo!.slot] = 0.5; rs[hi!.slot] = 0.25; rs[outer!.slot] = 0.5;
    // lo = 1.5, hi = 5.25, outer = 1.5 + 0.5·3.75
    expect(num(evaluate(p.sz, ctx(rs)))).toBe(3.375);
    // a range inside a keyframe and inside a method
    const k = pop('burst=1 sz=(2..4)>0 r=sprite(ember,add)');
    expect(num(evaluate(k.sz, ctx([0.5], { age: 0, life: 1 })))).toBe(3);
    const m = pop('burst=1 sz=(2..4).max(0) r=sprite(ember,add)');
    expect(num(evaluate(m.sz, ctx([0.5])))).toBe(3);
  });
});

describe('fx ranges in the simulator', () => {
  const N = 48;
  const run = (body: string, seed = 11) => {
    const sim = createFxSimulation(compileProgram(`fx\npop p burst=${N} life=5 ${body} r=sprite(ember,add)`, {}, TIER, { strict: true }), { seed, capacity: 64 });
    const p = sim.population('p')!;
    return { sim, idx: Array.from(p.indices.slice(0, p.count)) };
  };

  it('birth velocity, appearance and custom attributes stay inside their ranges (negative control: outside [0, 1))', () => {
    const { sim, idx } = run('v=<0,1,0>*(5..6) sz=2..3 a=.25..0.5 col=<1,0,0>..<0,0,1> spin=-9..9 rot=$spin');
    expect(idx).toHaveLength(N);
    const vy = idx.map((i) => sim.velocities[i * 3 + 1]!);
    const sz = idx.map((i) => sim.sizes[i]!);
    const a = idx.map((i) => sim.rgba[i * 4 + 3]!);
    const rot = idx.map((i) => sim.rotations[i]!);
    for (const v of vy) expect(v >= 5 && v <= 6).toBe(true);
    for (const v of sz) expect(v >= 2 && v <= 3).toBe(true);
    for (const v of a) expect(v >= 0.25 && v <= 0.5).toBe(true);
    for (const v of rot) expect(v >= -9 && v <= 9).toBe(true);
    for (const i of idx) {
      expect(sim.rgba[i * 4 + 1]).toBe(0);
      expect(sim.rgba[i * 4]! + sim.rgba[i * 4 + 2]!).toBeCloseTo(1, 6);
    }
    // the raw roll lies in [0, 1): none of these could
    expect(Math.min(...vy)).toBeGreaterThan(1);
    expect(Math.min(...sz)).toBeGreaterThan(1);
    expect(rot.some((v) => v < 0)).toBe(true);
    sim.dispose();
  });

  it('a field range scales the acceleration of every step', () => {
    const { sim, idx } = run('acc=grav()*(.25..0.5)');
    sim.step(1 / 20, 1 / 20);
    for (const i of idx) {
      const g = -sim.velocities[i * 3 + 1]! / (24 / 20);
      expect(g >= 0.25 - 1e-6 && g <= 0.5 + 1e-6).toBe(true);
    }
    sim.dispose();
  });

  it('keeps the draw order: other bounds change only the mapped value, never a draw', () => {
    const unit = run('v=<0,1,0>*(0..1) size=.5..1');
    const wide = run('v=<0,1,0>*(5..7) size=.5..1');
    expect(wide.idx).toEqual(unit.idx);
    for (const i of unit.idx) {
      expect(wide.sim.lives[i]).toBe(unit.sim.lives[i]);
      expect(wide.sim.baseSizes[i]).toBe(unit.sim.baseSizes[i]);
      expect(wide.sim.positions[i * 3]).toBe(unit.sim.positions[i * 3]);
      // the `0..1` run exposes the raw roll r; the other maps the same r
      expect(wide.sim.velocities[i * 3 + 1]).toBeCloseTo(5 + 2 * unit.sim.velocities[i * 3 + 1]!, 5);
    }
    unit.sim.dispose();
    wide.sim.dispose();
  });
});
