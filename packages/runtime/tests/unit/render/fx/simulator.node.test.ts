import { describe, expect, it } from 'vitest';
import { compileProgram } from '../../../../src/render/fx/dsl/compile.ts';
import { createFxSimulation } from '../../../../src/render/fx/sim/simulator.ts';

const TIER = { low: false, mobile: false };

describe('FX simulation', () => {
  it('replays seeded births and motion deterministically while enforcing one shared particle ceiling', () => {
    const program = compileProgram(
      'fx\npop sparks burst=40 life=1 v=sdir()*(1..3) size=.5..1 col=hdr(2,1,.5) a=1 r=sprite(ember,add)',
      {},
      TIER,
    );
    const a = createFxSimulation(program, { seed: 817, capacity: 17 });
    const b = createFxSimulation(program, { seed: 817, capacity: 17 });

    expect(a.particleCount).toBe(17);
    expect(a.population('sparks')?.count).toBe(17);
    a.step(1 / 30, 1 / 30);
    b.step(1 / 30, 1 / 30);
    expect(Array.from(a.positions.slice(0, 17 * 3))).toEqual(Array.from(b.positions.slice(0, 17 * 3)));
    expect(a.particleCount).toBe(17);
    a.dispose();
    b.dispose();
  });

  it('clamps a frame step and leaves simulation time frozen when presentation dt is zero', () => {
    const program = compileProgram('fx\npop p burst=1 life=1 v=<0,2,0> r=sprite(soft-disc,add)', {}, TIER);
    const sim = createFxSimulation(program, { seed: 5, capacity: 8 });
    const pop = sim.population('p')!;
    const i = pop.indices[0]!;
    sim.step(0, 0);
    expect(sim.ages[i]).toBe(0);
    sim.step(1, 1);
    expect(sim.ages[i]).toBeCloseTo(0.05, 7);
    expect(sim.positions[i * 3 + 1]).toBeCloseTo(0.1, 6);
    sim.step(0, 1);
    expect(sim.ages[i]).toBeCloseTo(0.05, 7);
    sim.dispose();
  });

  it('keeps held emitters at full count on desktop and applies a mobile tier factor only when requested', () => {
    const program = compileProgram('fx\npop fire n=20 life=2 r=sprite(flame-wisp,add)', {}, TIER);
    const desktop = createFxSimulation(program, { seed: 3, capacity: 32, heldFactor: 1 });
    const mobile = createFxSimulation(program, { seed: 3, capacity: 32, heldFactor: 0.35 });
    desktop.step(0, 0);
    mobile.step(0, 0);
    expect(desktop.population('fire')?.count).toBe(20);
    expect(mobile.population('fire')?.count).toBe(7);
    desktop.dispose();
    mobile.dispose();
  });

  it('grows typed arrays lazily while respecting the global birth allowance', () => {
    const program = compileProgram('fx\npop drops n=15 life=1 size=1 r=mesh(box,1,1,1)', {}, TIER);
    const sim = createFxSimulation(program, { seed: 13, capacity: 20, initialCapacity: 2, birthBudget: 6 });
    expect(sim.particleCount).toBe(6);
    expect(sim.positions.length).toBeGreaterThanOrEqual(6 * 3);
    sim.step(0, 0, [0, 0, 0], 4);
    expect(sim.particleCount).toBe(10);
    expect(sim.population('drops')?.indices.length).toBeGreaterThanOrEqual(10);
    sim.dispose();
  });

  it('keeps particles emitted by a death child at age zero until the next presentation step', () => {
    const program = compileProgram([
      'fx',
      'pop root burst=1 life=.01',
      'pop child on=@root?1 life=1 r=sprite(ember,add)',
    ].join('\n'), {}, TIER);
    const sim = createFxSimulation(program, { seed: 7, capacity: 8 });
    sim.step(0.02, 0.02);
    const child = sim.population('child')!;
    expect(child.count).toBe(1);
    expect(sim.ages[child.indices[0]!]).toBe(0);
    sim.step(1 / 30, 1 / 30);
    expect(sim.ages[child.indices[0]!]).toBeCloseTo(1 / 30, 7);
    sim.dispose();
  });
});
