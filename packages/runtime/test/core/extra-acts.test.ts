import { describe, expect, it } from 'vitest';
import type { ActEnvelope } from '../../src/compat/core/ports.ts';
import { ACT_NAMES, EXTRA_ACT_NAMES, isActName } from '../../src/compat/core/rules.ts';
import { testWorld, type Module } from './world.ts';

const MODULES: Record<string, Module> = { 'templates/player.js': { player: { tags: ['player'] } } };

async function world(extraActs?: boolean | readonly ('squash' | 'flash' | 'slash')[]) {
  const w = await testWorld({ modules: MODULES, ext: extraActs === undefined ? {} : { extraActs } });
  w.k.spawnHuman({ place: 'p1', at: { x: 0, y: 0, z: 0 }, userId: 'u', displayName: 'U', durableState: {} });
  const sim = w.rootSim({}).ctx as any;
  const seen: ActEnvelope[] = [];
  for (const n of EXTRA_ACT_NAMES) {
    try {
      w.k.acts.register(n, (a) => void seen.push(a));
    } catch {
      /* the option is off: not an engine act */
    }
  }
  return { w, sim, seen };
}

describe('extra engine acts (ext.extraActs)', () => {
  it('PP list is unchanged', () => {
    for (const n of EXTRA_ACT_NAMES) expect(isActName(n)).toBe(false);
    expect(ACT_NAMES).not.toContain('squash');
  });

  it('opt-in: squash, flash and slash reach the act sink with their payloads', async () => {
    const { sim, seen } = await world(true);
    expect(sim.emit('squash', { target: 'a', amount: 0.3 })).toBeUndefined();
    sim.emit('flash', { target: 'a', color: '#fff' });
    sim.emit('slash', { from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 } });
    expect(seen.map((a) => a.name)).toEqual(['squash', 'flash', 'slash']);
    expect(seen[0]!.payload).toEqual({ target: 'a', amount: 0.3 });
    expect(seen[0]!.id).toBeNull();
  });

  it('opt-in: a list routes only the listed acts; the rest stay custom events', async () => {
    const { w, sim, seen } = await world(['flash']);
    sim.emit('flash', { n: 1 });
    sim.emit('squash', { n: 2 });
    expect(seen.map((a) => a.name)).toEqual(['flash']);
    expect(w.k.metrics.actsUnhandled).toBe(0);
  });

  it('option off (control): they are custom events, never acts, and cannot be registered', async () => {
    const { w, sim, seen } = await world();
    expect(() => w.k.acts.register('squash', () => {})).toThrow(TypeError);
    sim.emit('squash', { n: 1 });
    sim.emit('flash', { n: 1 });
    expect(seen).toEqual([]);
    expect(w.k.metrics.actsUnhandled).toBe(0);
    expect(w.k.metrics.actsFiltered).toBe(0);
    expect(w.k.time.bus.pending).toBe(2);
  });
});
