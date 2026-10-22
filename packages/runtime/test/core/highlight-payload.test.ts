import { describe, expect, it } from 'vitest';
import type { ActEnvelope } from '../../src/compat/core/ports.ts';
import { testWorld, type Module } from './world.ts';

const MODULES: Record<string, Module> = { 'templates/player.js': { player: { tags: ['player'] } } };

describe('highlightSet payload', () => {
  it('the act record the sink receives carries target, color, style, width, duration and intensity', async () => {
    const w = await testWorld({ modules: MODULES });
    w.k.spawnHuman({ place: 'p1', at: { x: 0, y: 0, z: 0 }, userId: 'u', displayName: 'U', durableState: {} });
    const sim = w.rootSim({}).ctx as any;
    const seen: ActEnvelope[] = [];
    w.k.acts.register('highlightSet', (a) => void seen.push(a));
    const payload = { target: 'enemy/1', color: '#ff0000', style: 'outline', width: 3, duration: 1.5, intensity: 0.75 };
    sim.emit('highlightSet', payload);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.name).toBe('highlightSet');
    expect(seen[0]!.payload).toEqual(payload);
    expect(seen[0]!.payload).not.toBe(payload); // a wire copy
  });
});
