// Autostep with the template numbers (motion §5.13): 0.4 m max height, 0.2 m min width (templates/player.js:23), and the
// kit stair flight, whose collider is a ramp because "a capsule cannot autostep 0.28 m treads" (scripts/gen/kit/stairs.js).
import { describe, expect, it } from 'vitest';
import type { CharacterBody } from '../../../src/compat/physics/rapier/kcc.ts';
import type { PhysicsWorld } from '../../../src/compat/physics/rapier/world.ts';
import { FLOOR, MOVE, PlayerLoop, TICK, enemy, player, worldOf, type Part } from './rapier-fixtures.ts';

/** a platform whose near face is at x = 3 and whose top is `height` above the floor */
const platform = (height: number, depth = 4): Part => ({ row: 'step', box: [depth / 2, height / 2, 2], at: [3 + depth / 2, height / 2, 0] });

function walkAt(parts: Part[], ticks = 30, make: (w: PhysicsWorld) => CharacterBody = (w) => player(w, { x: 0, y: 0.05, z: 0 })): { world: PhysicsWorld; loop: PlayerLoop } {
  const world = worldOf([FLOOR, ...parts]);
  const loop = new PlayerLoop(world, make(world));
  loop.run(10);
  loop.wish(1, 0).run(ticks);
  return { world, loop };
}

describe('kcc-steps: autostep', () => {
  it('climbs a 0.39 m step at walking pace', () => {
    const { world, loop } = walkAt([platform(0.39)]);
    const c = loop.body;
    expect(c.feet.y).toBeGreaterThan(0.39);
    expect(c.feet.y).toBeLessThan(0.39 + 0.03);
    expect(c.feet.x).toBeGreaterThan(4);
    expect(c.grounded).toBe(true);
    // no stall on the riser: 30 ticks at 5 m/s less the 0.119 s of acceleration and at most one tick at the riser
    expect(c.feet.x).toBeGreaterThan(30 * 5 * TICK - 0.6);
    // it did not jump: one landing only (the initial drop)
    expect(loop.landings).toHaveLength(1);
    world.free();
  });

  // motion §5.13 names 0.41 m as blocked. The stock 0.21 controller with `enableAutostep(0.4, 0.2)` climbs every step up to
  // 0.44 m and refuses from 0.45 m (measured without any port code, on a cuboid and on a trimesh step, for 45° and 52°): it
  // adds the controller offset to the height it tries and the capsule already floats one offset above the floor. So the
  // limit a map sees is 0.44 m, and the port does not narrow it.
  it.each([0.41, 0.44])('the grey zone above maxHeight: a %s m step is still climbed, a few ticks late at most', (h) => {
    const { world, loop } = walkAt([platform(h)]);
    expect(loop.body.feet.y).toBeGreaterThan(h);
    expect(loop.body.feet.y).toBeLessThan(h + 0.03);
    expect(loop.body.grounded).toBe(true);
    // 30 ticks at 5 m/s less the acceleration and at most three ticks lost at the riser
    expect(loop.body.feet.x).toBeGreaterThan(30 * 5 * TICK - 0.6 - 3 * 5 * TICK);
    world.free();
  });

  it('is blocked by a 0.45 m step and reads ~0 velocity against it', () => {
    const { world, loop } = walkAt([platform(0.45)]);
    const c = loop.body;
    expect(c.feet.y).toBeLessThan(0.03);
    // the capsule surface stops one offset before the riser
    expect(c.feet.x).toBeGreaterThan(3 - 0.35 - 0.03);
    expect(c.feet.x).toBeLessThan(3 - 0.35);
    expect(loop.speed).toBeLessThan(0.05);
    world.free();
  });

  it.each([0.1, 0.2, 0.3])('climbs a %s m kerb', (h) => {
    const { world, loop } = walkAt([platform(h)]);
    expect(loop.body.feet.y).toBeGreaterThan(h);
    expect(loop.body.feet.x).toBeGreaterThan(30 * 5 * TICK - 0.6);
    world.free();
  });

  it('does not climb onto a ledge 0.15 m deep (< minWidth 0.2), but does when it is 0.6 m deep', () => {
    const wall = (from: number): Part => ({ row: 'wall', box: [0.5, 1.5, 2], at: [from + 0.5, 1.5, 0] });
    const narrow = walkAt([{ row: 'ledge', box: [0.075, 0.15, 2], at: [3.075, 0.15, 0] }, wall(3.15)]);
    expect(narrow.loop.body.feet.y).toBeLessThan(0.03);
    expect(narrow.loop.body.feet.x).toBeLessThan(3 - 0.35);
    narrow.world.free();
    const wide = walkAt([{ row: 'ledge', box: [0.3, 0.15, 2], at: [3.3, 0.15, 0] }, wall(3.6)]);
    expect(wide.loop.body.feet.y).toBeGreaterThan(0.3);
    expect(wide.loop.body.feet.x).toBeGreaterThan(3);
    wide.world.free();
  });

  it('enemy defaults (D-MPN-08) step the same 0.39 m and refuse 0.45 m', () => {
    const up = walkAt([platform(0.39)], 30, (w) => enemy(w, { x: 0, y: 0.05, z: 0 }));
    expect(up.loop.body.feet.y).toBeGreaterThan(0.39);
    up.world.free();
    const no = walkAt([platform(0.45)], 30, (w) => enemy(w, { x: 0, y: 0.05, z: 0 }));
    expect(no.loop.body.feet.y).toBeLessThan(0.03);
    no.world.free();
  });

  it('walks down a 0.39 m step without leaving the ground for more than the drop', () => {
    const world = worldOf([FLOOR, platform(0.39)]);
    const c = player(world, { x: 5, y: 0.45, z: 0 });
    const loop = new PlayerLoop(world, c);
    loop.run(10);
    loop.wish(-1, 0).run(40);
    expect(c.feet.y).toBeLessThan(0.03);
    expect(c.feet.x).toBeLessThan(1);
    expect(c.grounded).toBe(true);
    world.free();
  });
});

/** `scripts/gen/kit/stairs.js:37-48` collider(ctx): the smooth ramp of a flight of n steps (0.18 rise / 0.28 run) toward -Z */
function stairRamp(n = 10, w = 2.2): Float32Array {
  const rise = 0.18, run = 0.28;
  const e = 0.15, k = rise / run;
  const dz = n * run, dy = n * rise - 0.05, hw = w / 2;
  const A = [-hw, -e * k, e], B = [hw, -e * k, e], C = [hw, dy, -dz], D = [-hw, dy, -dz];
  const A0 = [-hw, -0.3, e], B0 = [hw, -0.3, e], C0 = [hw, -0.3, -dz], D0 = [-hw, -0.3, -dz];
  const out: number[] = [];
  const tri = (a: number[], b: number[], c: number[]): void => { out.push(...a, ...b, ...c); };
  const Q = (a: number[], b: number[], c: number[], d: number[]): void => { tri(a, b, c); tri(a, c, d); };
  Q(A, B, C, D);
  Q(C0, D0, D, C);
  Q(D0, C0, B0, A0);
  Q(A0, B0, B, A);
  tri(A0, D, D0); tri(A0, A, D);
  tri(B0, C0, C); tri(B0, C, B);
  return new Float32Array(out);
}

describe('kcc-steps: the kit stair flight', () => {
  const N = 10, TOP = N * 0.18 - 0.05, LENGTH = N * 0.28;
  const slope = Math.atan(0.18 / 0.28);

  it('is walked up at full pace (motion §5.13) and down again, on the ground all the way', () => {
    // landing behind the top of the flight
    const world = worldOf([FLOOR, { row: 'stairs', tris: stairRamp(N) }, { row: 'landing', box: [2, TOP / 2, 2], at: [0, TOP / 2, -LENGTH - 2] }]);
    const c = player(world, { x: 0, y: 0.05, z: 2 });
    const loop = new PlayerLoop(world, c);
    loop.run(10);
    loop.wish(0, -1);
    const onRamp: number[] = [];
    let ticks = 0;
    while (c.feet.z > -LENGTH - 1 && ticks < 200) {
      loop.tick();
      ticks++;
      if (c.feet.z < -0.3 && c.feet.z > -LENGTH + 0.3) onRamp.push(loop.speed);
      expect(c.grounded).toBe(true);
    }
    expect(c.feet.y).toBeGreaterThan(TOP);
    expect(c.feet.y).toBeLessThan(TOP + 0.04);
    // Rapier alone slides a horizontal move along the slope (cos²θ of the pace, 2.15 m/s here with player.js's loop);
    // the ground follow of kcc.ts asks for the move along the ramp, so the horizontal pace is the one asked
    expect(Math.cos(slope) ** 2).toBeCloseTo(0.708, 3);
    const slowest = Math.min(...onRamp), fastest = Math.max(...onRamp);
    // the one tick that meets the foot of the ramp still slides the raw way; every other tick is at pace
    expect(onRamp.filter((s) => s < MOVE.walk * 0.97).length).toBeLessThanOrEqual(1);
    expect(slowest).toBeGreaterThan(MOVE.walk * Math.cos(slope) ** 2);
    expect(fastest).toBeLessThan(MOVE.walk * 1.1);
    // 2 m of approach + the 2.8 m flight + 1 m of landing at 5 m/s, plus the acceleration
    expect(ticks * TICK).toBeLessThan(5.8 / MOVE.walk + 0.15);
    // and back down, snapped to the ramp all the way
    loop.wish(0, 1);
    for (let i = 0; i < 60; i++) {
      loop.tick();
      expect(c.grounded).toBe(true);
    }
    expect(c.feet.y).toBeLessThan(0.03);
    expect(c.feet.z).toBeGreaterThan(1);
    expect(loop.landings).toHaveLength(1);
    world.free();
  });
});
