// Current PP range evaluation is the default; explicit false preserves the pre-sync unit roll.
import { describe, expect, it } from 'vitest';
import { compileProgram } from '../../src/render/fx/dsl/compile.ts';
import { createFxSimulation } from '../../src/render/fx/sim/simulator.ts';

// the moon-shaft beam of a hall scene: five held additive axis cards, alpha .05..0.09
const BEAM = 'fx\npop beam n=5 on=box(.1,.1,1.1) size=1.1..1.9 sz=$size a=.05..0.09 col=<.45,.6,1> r=sprite(soft-disc,add,axis,7.7,axis=<0.570,-0.814,0.109>)';
const TINT = 'fx\npop t n=8 tint=<1,0,0>..<0,0,1> col=$tint a=1 r=sprite(soft-disc,add)';

function run(script: string, rangeRolls?: boolean) {
  const sim = createFxSimulation(compileProgram(script, {}, { low: false, mobile: false }), { seed: 1, capacity: 16, ...(rangeRolls === undefined ? {} : { rangeRolls }) });
  for (let i = 0; i < 4; i++) sim.step(0.016);
  const pop = sim.populations[0]!;
  const rgba = Array.from({ length: pop.count }, (_, s) => Array.from(sim.rgba.slice(pop.indices[s]! * 4, pop.indices[s]! * 4 + 4)));
  sim.dispose();
  return rgba;
}

describe('fx range rolls', () => {
  it('corrected ranges are the default, matching current PP', () => {
    expect(run(BEAM)).toEqual(run(BEAM, true));
    expect(run(TINT)).toEqual(run(TINT, true));
  });
  it('rangeRolls: a=.05..0.09 stays inside its bounds', () => {
    const rgba = run(BEAM, true);
    expect(rgba).toHaveLength(5);
    for (const [, , , a] of rgba) {
      expect(a).toBeGreaterThanOrEqual(0.05 - 1e-6);
      expect(a).toBeLessThanOrEqual(0.09 + 1e-6);
    }
  });
  it('rangeRolls: a vector range lerps between its ends with one roll', () => {
    for (const [r, g, b] of run(TINT, true)) {
      expect(g).toBe(0);
      expect(r! + b!).toBeCloseTo(1, 5);
    }
  });
  it('explicit false: the legacy unit roll is drawn, the bounds ignored', () => {
    const rgba = run(BEAM, false);
    expect(rgba.some(([, , , a]) => a! > 0.09)).toBe(true);
    // the same seed draws the same rolls: PP's alpha is the raw roll the option maps into .05..0.09
    const scaled = run(BEAM, true);
    rgba.forEach(([, , , a], i) => expect(scaled[i]![3]).toBeCloseTo(0.05 + 0.04 * a!, 5));
  });
});
