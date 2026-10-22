// kcc.ts `move`: the controller call made on the Rapier 0.21 controller's own members, without the JS closure the public
// `computeColliderMovement` wraps around every call's filter (`ColliderSet.castClosure`, called by the wasm once per candidate
// collider). It must give exactly what the public method gives: a crowd that walks into one spot (contact, push-out, walls,
// filter predicates) is stepped in two worlds, one through `move`'s direct call and one through the public method, and every
// realised number must be the same float.
import { describe, expect, it } from 'vitest';
import type { CharacterBody } from '../../../src/compat/physics/rapier/kcc.ts';
import { rapier } from '../../../src/compat/physics/rapier/loader.ts';
import type { PhysicsWorld } from '../../../src/compat/physics/rapier/world.ts';
import { FLOOR, GRAVITY, TICK, enemy, player, worldOf } from './rapier-fixtures.ts';

const SPOTS = [
  [0, 0], [0.4, 0.1], [-0.5, 0.3], [1.2, -0.8], [-1.4, -1.1], [2.2, 1.6], [-2.4, 2.1], [0.3, -2.5], [2.9, -0.2],
] as const;

function crowd(): { world: PhysicsWorld; bodies: CharacterBody[] } {
  const world = worldOf([FLOOR, { row: 'wall', box: [4, 1.5, 0.25], at: [0, 1.5, -1.2] }, { row: 'post', box: [0.3, 1.5, 0.3], at: [1.1, 1.5, 0.9] }]);
  const bodies = SPOTS.map(([x, z], i) => (i === 0 ? player(world, { x, y: 0.05, z }) : enemy(world, { x, y: 0.05, z }, `enemy-${i}`)));
  return { world, bodies };
}

/** every body walks toward the origin at 4 m/s (a crowd pressing on one spot), gravity integrated as the live scripts do */
function tick(world: PhysicsWorld, bodies: CharacterBody[], i: number): number[] {
  for (const c of bodies) {
    const dx = -c.feet.x, dz = -c.feet.z, d = Math.hypot(dx, dz);
    const s = i % 40 < 30 && d > 1e-6 ? 4 / d : 0;
    c.desiredVelocity.x = dx * s; c.desiredVelocity.y = c.velocity.y + GRAVITY * TICK; c.desiredVelocity.z = dz * s;
  }
  world.step(TICK);
  const out: number[] = [];
  for (const c of bodies) out.push(c.feet.x, c.feet.y, c.feet.z, c.velocity.x, c.velocity.y, c.velocity.z, c.grounded ? 1 : 0, c.hits, c.groundNormal.y);
  return out;
}

describe('kcc.ts move: the direct controller call', () => {
  it('gives exactly what the public computeColliderMovement gives, and asks no filter closure of the wasm', () => {
    const R = rapier();
    const direct = crowd(), stock = crowd();
    // the public method, set on the instance: `move` then takes it (as for a test that counts calls)
    let stockCalls = 0;
    for (const c of new Set(stock.bodies.map((b) => b.controller))) {
      const own = Object.getPrototypeOf(c).computeColliderMovement as typeof c.computeColliderMovement;
      c.computeColliderMovement = (...args: Parameters<typeof own>): void => { stockCalls++; own.apply(c, args); };
    }
    const cs = R.ColliderSet.prototype as unknown as { castClosure: (f?: unknown) => unknown };
    const castClosure = cs.castClosure;
    let closures = 0;
    let touched = 0;
    try {
      for (let i = 0; i < 150; i++) {
        cs.castClosure = function (this: unknown, f?: unknown) { closures++; return castClosure.call(this, f); };
        const a = tick(direct.world, direct.bodies, i);
        cs.castClosure = castClosure;
        const b = tick(stock.world, stock.bodies, i);
        for (let k = 0; k < a.length; k++) {
          if (!Object.is(a[k], b[k])) expect.fail(`tick ${i}, value ${k}: ${a[k]} through move, ${b[k]} through the public method`);
        }
        touched += direct.bodies.filter((c) => c.touching.length > 0).length;
      }
    } finally {
      cs.castClosure = castClosure;
    }
    // the scene does what it is for: bodies in contact (filter predicates, push-out) and the public path really taken
    expect(touched).toBeGreaterThan(100);
    expect(stockCalls).toBeGreaterThan(150 * SPOTS.length);
    expect(closures).toBe(0);
    direct.world.free();
    stock.world.free();
  });
});
