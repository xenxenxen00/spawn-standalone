import { describe, expect, it } from 'vitest';
import { simEveryTicks } from '../../src/compat/core/ext.ts';
import { asSimModule } from '../../src/compat/core/modules/registry.ts';
import { testWorld } from './world.ts';

describe('K1: sim cadence strings', () => {
  it('default (PP): any cadence but 100ms is a boot error', () => {
    expect(() => asSimModule({ tick() {}, cadence: '1s' }, 'sim.js')).toThrow(/cadence "1s"/);
    expect(() => asSimModule({ tick() {}, cadence: '100ms' }, 'sim.js')).not.toThrow();
  });

  it('simCadence any: every documented string is accepted, even one that does not parse', () => {
    for (const cadence of ['1s', '100ms', '5m', '250ms', 'fast', '']) {
      expect(() => asSimModule({ tick() {}, cadence }, 'sim.js', { anyCadence: true }), cadence).not.toThrow();
    }
  });

  it('every-ticks is a multiple of the 100 ms step, at least one step', () => {
    expect(simEveryTicks({ cadence: '100ms' })).toBe(3);
    expect(simEveryTicks({ cadence: '1s' })).toBe(30);
    expect(simEveryTicks({ cadence: '5m' })).toBe(9000);
    expect(simEveryTicks({ cadence: '10ms' })).toBe(3);
    expect(simEveryTicks({ cadence: 'nope' })).toBe(3);
    expect(simEveryTicks({})).toBe(3);
    expect(simEveryTicks(null)).toBe(3);
  });

  it('a root sim with everyTicks 30 ticks once per second; without it, every 100 ms', async () => {
    const w = await testWorld({ ext: { simCadence: 'any' } });
    let n = 0;
    const s = w.rootSim({ cadence: '1s', tick: () => void n++ });
    s.everyTicks = simEveryTicks(s.module);
    w.ticks(90);
    expect(n).toBe(3);
    const w2 = await testWorld();
    let m = 0;
    w2.rootSim({ cadence: '100ms', tick: () => void m++ });
    w2.ticks(90);
    expect(m).toBe(30);
  });
});
