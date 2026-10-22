import { describe, expect, it, vi } from 'vitest';
import { createNullPhysicsPort } from '../../src/compat/core/null-ports.ts';
import { testWorld } from './world.ts';

const mk = async (gravitySetter: boolean) => {
  const physics = Object.assign(createNullPhysicsPort(), { setGravity: vi.fn() });
  const w = await testWorld({ ext: { gravitySetter }, ports: { physics } });
  return { w, physics, sim: w.rootSim({}).ctx as any };
};

describe('R-3: ctx.place.gravity setter', () => {
  it('default: a write is ignored with a warning and the physics port is not told', async () => {
    const { physics, sim } = await mk(false);
    const before = sim.place.gravity;
    sim.place.gravity = { x: 0, y: -3, z: 0 };
    expect(sim.place.gravity).toEqual(before);
    expect(physics.setGravity).not.toHaveBeenCalled();
  });

  it('opt-in: the value reads back (a copy), the port is told, and a restore works', async () => {
    const { physics, sim } = await mk(true);
    expect(sim.place.gravity).toEqual({ x: 0, y: -24, z: 0 });
    sim.place.gravity = { x: 0, y: -4, z: 0 };
    expect(sim.place.gravity).toEqual({ x: 0, y: -4, z: 0 });
    expect(sim.place.gravity).not.toBe(sim.place.gravity);
    expect(physics.setGravity).toHaveBeenCalledWith('p1', { x: 0, y: -4, z: 0 });
    sim.place.gravity = { x: 0, y: -1.5, z: 0 };
    expect(sim.place.gravity.y).toBe(-1.5);
  });

  it('opt-in: a malformed value is ignored', async () => {
    const { physics, sim } = await mk(true);
    sim.place.gravity = { x: 0, y: NaN, z: 0 };
    sim.place.gravity = null;
    sim.place.gravity = 5;
    expect(sim.place.gravity.y).toBe(-24);
    expect(physics.setGravity).not.toHaveBeenCalled();
  });

  it('opt-in: the getter falls back to physics.gravityOf, a written value wins; off, gravityOf is not consulted', async () => {
    const gravityOf = vi.fn(() => ({ x: 0, y: -7, z: 0 }));
    const physics = Object.assign(createNullPhysicsPort(), { setGravity: vi.fn(), gravityOf });
    const on = (await testWorld({ ext: { gravitySetter: true }, ports: { physics } })).rootSim({}).ctx as any;
    expect(on.place.gravity).toEqual({ x: 0, y: -7, z: 0 });
    on.place.gravity = { x: 0, y: -2, z: 0 };
    expect(on.place.gravity.y).toBe(-2);
    const off = (await testWorld({ ports: { physics: Object.assign(createNullPhysicsPort(), { gravityOf }) } })).rootSim({}).ctx as any;
    gravityOf.mockClear();
    expect(off.place.gravity.y).toBe(-24);
    expect(gravityOf).not.toHaveBeenCalled();
  });
});
