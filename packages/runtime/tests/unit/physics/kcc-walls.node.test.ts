// Walls (motion §5.13): a body pressed into a wall reads ~0 velocity (the humanoid-locomotion contract, player §3.2 #1), a
// glancing move keeps its tangential part, and an upward ask slides up a vertical wall (the crawler climb of
// `scripts/enemies/runtime.js:1430-1466`: Rapier's climbing-intent rule).
import { describe, expect, it } from 'vitest';
import { DEG, KCC_MAX_RESUMES } from '../../../src/compat/physics/defaults.ts';
import { FLOOR, GRAVITY, MOVE, PlayerLoop, TICK, enemy, player, settle, stepWith, worldOf, type Part } from './rapier-fixtures.ts';

/** a 4 m high wall whose near face is the plane through (3, 0, 0), turned `deg` about Y */
function wall(deg = 0): Part {
  const a = deg * DEG;
  return { row: 'wall', box: [0.25, 2, 5], at: [3 + 0.25 * Math.cos(a), 2, -0.25 * Math.sin(a)], axis: [0, 1, 0], deg };
}

describe('kcc-walls', () => {
  it('walking into a wall: stops one offset before it and reads ~0 velocity while the keys still ask', () => {
    const world = worldOf([FLOOR, wall()]);
    const c = player(world, { x: 0, y: 0.05, z: 0 });
    const loop = new PlayerLoop(world, c);
    loop.run(10);
    loop.wish(1, 0).run(30);
    // capsule surface at 3 - offset
    expect(c.feet.x).toBeGreaterThan(3 - 0.35 - 0.02);
    expect(c.feet.x).toBeLessThan(3 - 0.35);
    for (let i = 0; i < 30; i++) {
      loop.tick();
      expect(loop.speed).toBeLessThan(0.1);
      expect(c.grounded).toBe(true);
      // what player.js then writes: acceleration from the ~0 it read, 42 m/s² per tick
      expect(Math.hypot(c.desiredVelocity.x, c.desiredVelocity.z)).toBeLessThan(MOVE.accel * TICK + 0.05);
    }
    // released: free at once
    loop.wish(-1, 0).run(6);
    expect(loop.speed).toBeCloseTo(5, 1);
    world.free();
  });

  it('a 30° glancing move slides along the wall with the tangential part of the velocity', () => {
    // the wall plane is turned so that +x meets it at 30°
    const world = worldOf([FLOOR, wall(60)]);
    const c = player(world, { x: 0, y: 0.05, z: 0 });
    settle(world, c);
    const speeds: number[] = [];
    for (let i = 0; i < 40; i++) {
      const v = stepWith(world, c, { x: 5, y: c.velocity.y + GRAVITY * TICK, z: 0 });
      if (i >= 25) speeds.push(Math.hypot(v.x, v.z));
    }
    // sliding: the direction is the wall's, the speed 5·cos 30° = 4.33 (single ticks lose some of it at a floor/wall seam)
    const want = 5 * Math.cos(30 * DEG);
    for (const s of speeds) { expect(s).toBeGreaterThan(want * 0.7); expect(s).toBeLessThan(want * 1.02); }
    expect(speeds.reduce((a, b) => a + b, 0) / speeds.length).toBeGreaterThan(want * 0.95);
    expect([...speeds].sort((a, b) => a - b)[speeds.length >> 1]).toBeCloseTo(want, 1);
    const dir = Math.abs(Math.atan2(c.velocity.z, c.velocity.x)) / DEG;
    expect(dir).toBeGreaterThan(28);
    expect(dir).toBeLessThan(32);
    expect(c.grounded).toBe(true);
    world.free();
  });

  it('climb intent: {0.7, 3.4, 0} m/s into a vertical wall rises 3.4 m/s (1.133 m in 10 ticks)', () => {
    const world = worldOf([FLOOR, wall()]);
    // an enemy with the D-MPN-08 defaults, already at the wall
    const c = enemy(world, { x: 3 - 0.34 - 0.012, y: 0.05, z: 0 });
    settle(world, c);
    const y0 = c.feet.y, x0 = c.feet.x;
    for (let i = 0; i < 10; i++) {
      const v = stepWith(world, c, { x: 0.7, y: 3.4, z: 0 });
      expect(v.y).toBeCloseTo(3.4, 1);
    }
    expect(c.feet.y - y0).toBeCloseTo((3.4 * 10) / 30, 2);
    // it did not go through the wall
    expect(c.feet.x).toBeLessThan(3 - 0.34);
    expect(c.feet.x - x0).toBeLessThan(0.02);
    expect(c.grounded).toBe(false);
    // the game's own climb loop (velocity read back, no gravity while climbing) keeps rising
    for (let i = 0; i < 10; i++) stepWith(world, c, { x: 0.7, y: 3.4, z: 0 });
    expect(c.feet.y - y0).toBeCloseTo((3.4 * 20) / 30, 2);
    world.free();
  });

  it('without an upward ask a wall is not climbed, and a ceiling stops a rise', () => {
    const world = worldOf([FLOOR, wall(), { row: 'ceiling', box: [1.5, 0.1, 1.5], at: [0, 2.6, 0] }]);
    const a = player(world, { x: 3 - 0.35 - 0.012, y: 0.05, z: 3 }, 'a');
    const b = player(world, { x: 0, y: 0.05, z: 0 }, 'b');
    settle(world, a);
    for (let i = 0; i < 20; i++) stepWith(world, a, { x: 5, y: a.velocity.y + GRAVITY * TICK, z: 0 });
    expect(a.feet.y).toBeLessThan(0.03);
    // a jump under a 2.5 m ceiling: head (1.9 m capsule) stops one offset below it and the read-back velocity is ~0
    settle(world, b, 5);
    stepWith(world, b, { x: 0, y: 12, z: 0 });
    stepWith(world, b, { x: 0, y: 12, z: 0 });
    const v = stepWith(world, b, { x: 0, y: 12, z: 0 });
    expect(b.feet.y + 1.9).toBeLessThan(2.5);
    expect(b.feet.y + 1.9).toBeGreaterThan(2.5 - 0.03);
    expect(v.y).toBeLessThan(0.05);
    world.free();
  });

  it('a wall on ground that falls toward it: the move the controller spins out on is continued along the crease, once', () => {
    // Stock Rapier 0.21: walking uphill along a wall where the ground also falls toward the wall, the slide along the ground
    // leans into the wall, the wall's "no climb without intent" rule takes the rise away again, and the loop repeats the
    // pair until its 20 iterations are used up with the body where it was (measured raw: 64-75 of 77 ticks at the wall
    // stalled, 0.2-0.6 m/s instead of 3.54). kcc.ts asks once more along the line the two surfaces share (its header, 6).
    const N = 24, soup: number[] = [];
    const h = (x: number, z: number): number => 0.12 * x - 0.02 * z;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const x0 = i - N / 2, z0 = j - N / 2, x1 = x0 + 1, z1 = z0 + 1;
        soup.push(x0, h(x0, z0), z0, x1, h(x1, z1), z1, x1, h(x1, z0), z0, x0, h(x0, z0), z0, x0, h(x0, z1), z1, x1, h(x1, z1), z1);
      }
    }
    const world = worldOf([{ row: 'hill', tris: soup }, { row: 'wall', box: [12, 6, 0.25], at: [0, 0, 2.25] }]);
    const c = player(world, { x: -4, y: 0.2, z: 0 });
    settle(world, c);
    const ctl = c.controller;
    const stock = ctl.computeColliderMovement.bind(ctl);
    let callsThisTick = 0, exhaustedThisTick = 0, exhaustedTicks = 0, worstCalls = 0, worstExhausted = 0;
    ctl.computeColliderMovement = (...args: Parameters<typeof stock>): void => {
      stock(...args);
      callsThisTick++;
      if (ctl.numComputedCollisions() >= 20) exhaustedThisTick++;
    };
    const atWall: number[] = [];
    for (let i = 0; i < 60; i++) {
      callsThisTick = 0; exhaustedThisTick = 0;
      const v = stepWith(world, c, { x: 5 * Math.SQRT1_2, y: c.velocity.y + GRAVITY * TICK, z: 5 * Math.SQRT1_2 });
      if (exhaustedThisTick > 0) exhaustedTicks++;
      worstCalls = Math.max(worstCalls, callsThisTick);
      worstExhausted = Math.max(worstExhausted, exhaustedThisTick);
      // wherever it is, it stands on the hill and in front of the wall
      expect(c.feet.y).toBeGreaterThan(h(c.feet.x, c.feet.z) - 0.005);
      expect(c.feet.z).toBeLessThan(2 - 0.35);
      if (c.feet.z > 2 - 0.35 - 0.03) atWall.push(Math.hypot(v.x, v.z));
    }
    // the stock pathology is there (this is what the test is about: without it the recovery below is dead code) ...
    expect(exhaustedTicks).toBeGreaterThan(0);
    // ... no tick at the wall is lost to it, and the slide keeps the pace of a plain wall (5·cos 45° = 3.54 m/s) ...
    expect(atWall.length).toBeGreaterThan(40);
    for (const s of atWall) expect(s).toBeGreaterThan(1);
    expect(atWall.reduce((a, b) => a + b, 0) / atWall.length).toBeGreaterThan(0.95 * 5 * Math.SQRT1_2);
    expect(atWall.reduce((a, b) => a + b, 0) / atWall.length).toBeLessThan(1.02 * 5 * Math.SQRT1_2);
    // ... for the exhausted call and ONE more along the crease, which may spin out too; an exhausted call is the dear one
    // (about 0.5 ms on a trimesh wall), so it is never asked a third time
    expect(worstExhausted).toBeLessThanOrEqual(2);
    expect(worstCalls).toBeLessThanOrEqual(KCC_MAX_RESUMES + 2);
    // turning away frees the body at once
    for (let i = 0; i < 10; i++) stepWith(world, c, { x: -5, y: c.velocity.y + GRAVITY * TICK, z: 0 });
    expect(Math.hypot(c.velocity.x, c.velocity.z)).toBeGreaterThan(4.5);
    world.free();
  });

  it('a wall corner does not trap: sliding into an inside corner ends at rest, and leaving it works', () => {
    const world = worldOf([FLOOR, wall(), { row: 'side', box: [5, 2, 0.25], at: [0, 2, 3.25] }]);
    const c = player(world, { x: 0, y: 0.05, z: 0 });
    const loop = new PlayerLoop(world, c);
    loop.run(10);
    loop.wish(Math.SQRT1_2, Math.SQRT1_2).run(45);
    expect(c.feet.x).toBeGreaterThan(3 - 0.35 - 0.03);
    expect(c.feet.z).toBeGreaterThan(3 - 0.35 - 0.03);
    expect(c.feet.x).toBeLessThan(3 - 0.35 + 0.001);
    expect(c.feet.z).toBeLessThan(3 - 0.35 + 0.001);
    expect(loop.speed).toBeLessThan(0.05);
    loop.wish(-1, 0).run(10);
    expect(c.feet.x).toBeLessThan(2);
    world.free();
  });
});
