// R-3, physics side: `ctx.place.gravity = v` (Moon Mode) reaches the Rapier world through `PhysicsPortImpl.setGravity(place, vec)`.
// The kernel's place-handle setter is the caller (compat/core/ctx/place-handle.ts); this file holds the port's half.
import { afterEach, describe, expect, it } from 'vitest';
import { PhysicsPortImpl } from '../../../src/compat/physics/port.ts';
import { PhysicsWorld } from '../../../src/compat/physics/rapier/world.ts';
import { bakeOf, fakeStore } from './port-fixtures.ts';
import { FLOOR, packOf } from './rapier-fixtures.ts';

let port: PhysicsPortImpl | null = null;
afterEach(() => port?.dispose());

/** a ball dropped from `y` in a world, stepped for `ticks`; returns how far it fell */
function fall(world: PhysicsWorld, y: number, ticks: number): number {
  const R = world.R;
  const body = world.raw.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(100, y, 100));
  world.raw.createCollider(R.ColliderDesc.ball(0.1), body);
  for (let i = 0; i < ticks; i++) world.step(1 / 30);
  const dy = y - body.translation().y;
  world.raw.removeRigidBody(body);
  return dy;
}

describe('R-3: runtime-writable place gravity (physics side)', () => {
  it('PhysicsWorld.setGravity changes the fall of a dynamic body from the next step', () => {
    const world = new PhysicsWorld('g');
    world.build(packOf('g', [{ ...FLOOR, at: [0, -100, 0] }]));
    expect(world.gravity).toEqual({ x: 0, y: -9.81, z: 0 });
    const normal = fall(world, 50, 10);
    expect(world.setGravity({ x: 0, y: -1.6, z: 0 })).toBe(true);
    expect(world.gravity.y).toBeCloseTo(-1.6, 6);
    const moon = fall(world, 50, 10);
    expect(moon / normal).toBeCloseTo(1.6 / 9.81, 3);
    expect(world.setGravity({ x: 0, y: -9.81, z: 0 })).toBe(true);
    expect(fall(world, 50, 10)).toBeCloseTo(normal, 3);
    world.free();
  });

  it('a sleeping dynamic body is woken by the change', () => {
    const world = new PhysicsWorld('g');
    world.build(packOf('g', [FLOOR]));
    const R = world.R;
    const body = world.raw.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(0, 0.1, 0).setCanSleep(true));
    world.raw.createCollider(R.ColliderDesc.ball(0.1), body);
    for (let i = 0; i < 120; i++) world.step(1 / 30);
    expect(body.isSleeping()).toBe(true);
    world.setGravity({ x: 0, y: 5, z: 0 }); // upward: it must lift off
    for (let i = 0; i < 10; i++) world.step(1 / 30);
    expect(body.translation().y).toBeGreaterThan(0.3);
    world.free();
  });

  it('the port: setGravity(place, v) reaches the built world, gravityOf reads it back, a rebuilt world keeps it', () => {
    const store = fakeStore();
    port = new PhysicsPortImpl({ host: { store, placeConfig: () => ({ gravity: { x: 0, y: -9.81, z: 0 } }) } });
    expect(port.gravityOf('home')).toEqual({ x: 0, y: -9.81, z: 0 }); // the place config until written
    // before the build: taken at the build
    expect(port.setGravity('home', { x: 0, y: -3, z: 0 })).toBe(true);
    port.buildPlace('home', bakeOf(packOf('home', [FLOOR])));
    expect(port.world('home')!.raw.gravity.y).toBe(-3);
    // after the build
    expect(port.setGravity('home', { x: 0, y: -1.6, z: 0 })).toBe(true);
    expect(port.world('home')!.raw.gravity.y).toBeCloseTo(-1.6, 6);
    expect(port.gravityOf('home')).toEqual({ x: 0, y: -1.6, z: 0 });
    // other places are not touched
    port.buildPlace('other', bakeOf(packOf('other', [FLOOR])));
    expect(port.world('other')!.raw.gravity.y).toBeCloseTo(-9.81, 6);
    // a rebuild of the same place
    port.buildPlace('home', bakeOf(packOf('home', [FLOOR])));
    expect(port.world('home')!.raw.gravity.y).toBeCloseTo(-1.6, 6);
  });

  it('a non-finite vector is refused and changes nothing', () => {
    port = new PhysicsPortImpl({ host: { store: fakeStore() } });
    port.buildPlace('home', bakeOf(packOf('home', [FLOOR])));
    const before = port.world('home')!.raw.gravity.y;
    expect(port.setGravity('home', { x: 0, y: Number.NaN, z: 0 })).toBe(false);
    expect(port.setGravity('home', { x: 0, y: -Infinity, z: 0 })).toBe(false);
    expect(port.world('home')!.raw.gravity.y).toBe(before);
    expect(port.gravityOf('home')).toBeNull();
  });

  it('a disposed port ignores it', () => {
    port = new PhysicsPortImpl({ host: { store: fakeStore() } });
    port.dispose();
    expect(port.setGravity('home', { x: 0, y: -1, z: 0 })).toBe(false);
  });
});
