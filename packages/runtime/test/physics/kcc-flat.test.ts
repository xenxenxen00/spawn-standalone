// Portable flat-ground controller regressions. All geometry and movement inputs are synthetic.
import { beforeAll, describe, expect, it } from 'vitest';
import { loadRapier } from '../../src/compat/physics/rapier/loader.ts';
import { PhysicsWorld } from '../../src/compat/physics/rapier/world.ts';

beforeAll(async () => { await loadRapier(); });

import { FLOOR, GRAVITY, MOVE, PlayerLoop, TICK, gridSoup, packOf, player, settle, worldOf } from '../../tests/unit/physics/rapier-fixtures.ts';

const JUMP_SPEED = Math.sqrt(2 * Math.abs(GRAVITY) * MOVE.jumpHeight);

function standing(): { world: PhysicsWorld; loop: PlayerLoop } {
  const world = worldOf([FLOOR]);
  const c = player(world, { x: 0, y: 0.3, z: 0 });
  const loop = new PlayerLoop(world, c);
  loop.run(30);
  return { world, loop };
}

describe('kcc-flat: synthetic controller on level ground', () => {
  it('falls from the spawn height, lands and rests at the controller offset without sinking or drifting', () => {
    const world = worldOf([FLOOR]);
    const c = player(world, { x: 0, y: 2, z: 0 });
    const loop = new PlayerLoop(world, c);
    loop.run(10);
    expect(c.grounded).toBe(false);
    // free fall is exactly the host integrator’s sum: 10 ticks of v = -0.8·i
    expect(c.feet.y).toBeCloseTo(2 - (0.8 * 55) / 30, 4);
    loop.run(50);
    expect(c.grounded).toBe(true);
    expect(loop.landings).toHaveLength(1);
    for (let i = 0; i < 300; i++) {
      loop.tick();
      expect(c.grounded).toBe(true);
      expect(c.feet.y).toBeGreaterThan(0.0095);
      expect(c.feet.y).toBeLessThan(0.0105);
      expect(Math.abs(c.velocity.y)).toBeLessThan(0.01);
    }
    // a fraction of a millimetre from the landing, none from standing
    expect(Math.hypot(c.feet.x, c.feet.z)).toBeLessThan(0.001);
    world.free();
  });

  it('0 → walk at 42 m/s² (0.119 s): 1.4 m/s per tick, at 5.0 m/s on the fourth tick', () => {
    const { world, loop } = standing();
    loop.wish(1, 0);
    const speeds: number[] = [];
    for (let i = 0; i < 6; i++) { loop.tick(); speeds.push(loop.speed); }
    const want = [1.4, 2.8, 4.2, 5, 5, 5];
    speeds.forEach((s, i) => expect(s, `tick ${i + 1}`).toBeCloseTo(want[i]!, 1));
    // the continuous 0.119 s (5 / 42) falls inside the fourth tick
    expect(Math.ceil((MOVE.walk / MOVE.accel) / TICK)).toBe(4);
    expect(speeds.findIndex((s) => s > MOVE.walk - 0.05) + 1).toBe(4);
    world.free();
  });

  it('walk → 0 at 56 m/s² (0.089 s): at rest on the third tick', () => {
    const { world, loop } = standing();
    loop.wish(0, -1).run(15);
    expect(loop.speed).toBeCloseTo(5, 1);
    loop.wish(0, 0);
    const speeds: number[] = [];
    for (let i = 0; i < 4; i++) { loop.tick(); speeds.push(loop.speed); }
    const want = [5 - 56 / 30, 5 - 112 / 30, 0, 0];
    speeds.forEach((s, i) => expect(s, `tick ${i + 1}`).toBeCloseTo(want[i]!, 1));
    expect(Math.ceil((MOVE.walk / MOVE.decel) / TICK)).toBe(3);
    world.free();
  });

  it.each([
    ['walk', false, MOVE.walk],
    ['sprint', true, MOVE.sprint],
  ])('%s holds its speed for 20 s on a diagonal: no stalled tick, never airborne, feet level', (_name, sprint, speed) => {
    const world = new PhysicsWorld('flat');
    world.build(packOf('flat', [{ row: 'ground', tris: gridSoup(80) }]));
    const c = player(world, { x: -60, y: 0.3, z: -40 });
    const loop = new PlayerLoop(world, c);
    loop.run(30);
    loop.sprint = sprint;
    loop.wish(Math.cos(0.61), Math.sin(0.61)).run(6);
    const x0 = c.feet.x, z0 = c.feet.z;
    let slowest = Infinity, lowest = Infinity, highest = -Infinity;
    const ticks = 600;
    for (let i = 0; i < ticks; i++) {
      loop.tick();
      slowest = Math.min(slowest, loop.speed);
      lowest = Math.min(lowest, c.feet.y);
      highest = Math.max(highest, c.feet.y);
      expect(c.grounded).toBe(true);
    }
    expect(slowest).toBeGreaterThan(speed * 0.97);
    expect(Math.hypot(c.feet.x - x0, c.feet.z - z0)).toBeCloseTo(speed * ticks * TICK, 0);
    expect(Math.hypot(c.feet.x - x0, c.feet.z - z0)).toBeGreaterThan(speed * ticks * TICK * 0.995);
    expect(lowest).toBeGreaterThan(0.008);
    expect(highest).toBeLessThan(0.05);
    expect(loop.landings).toHaveLength(1);
    world.free();
  });

  it('jump: launches at 6.753 m/s and follows the discrete arc', () => {
    const { world, loop } = standing();
    const c = loop.body;
    const y0 = c.feet.y;
    loop.jump = true;
    const heights: number[] = [];
    let air = 0;
    for (let i = 0; i < 30; i++) {
      loop.tick();
      if (i === 0) expect(c.velocity.y).toBeCloseTo(JUMP_SPEED, 3);
      if (!c.grounded) air++;
      heights.push(c.feet.y - y0);
    }
    // explicit 30 Hz integration: after n ticks the feet are at Σ (v0 - 0.8·i)/30
    for (let n = 1; n <= 16; n++) {
      const want = (n * JUMP_SPEED - 0.4 * n * (n - 1)) / 30;
      expect(heights[n - 1], `tick ${n}`).toBeCloseTo(want, 3);
    }
    const apex = Math.max(...heights);
    // the tick grid adds v0·dt/2 to the continuous 0.95 m (= v0²/2g): 1.066 m after 9 ticks
    expect(apex).toBeCloseTo((9 * JUMP_SPEED - 0.4 * 72) / 30, 3);
    expect(apex).toBeCloseTo(MOVE.jumpHeight + (JUMP_SPEED * TICK) / 2, 1);
    expect(heights.indexOf(apex)).toBe(8);
    // air time 0.563 s ± 1 tick
    expect(Math.abs(air * TICK - 0.563)).toBeLessThanOrEqual(TICK);
    expect(c.grounded).toBe(true);
    expect(c.feet.y).toBeCloseTo(y0, 2);
    expect(loop.landings).toHaveLength(2);
    world.free();
  });

  it('a jump at walking pace keeps horizontal velocity and a fresh press can launch after landing', () => {
    const { world, loop } = standing();
    loop.wish(1, 0).run(10);
    loop.jump = true;
    loop.tick();
    for (let i = 0; i < 14; i++) {
      loop.tick();
      expect(loop.body.grounded).toBe(false);
      expect(loop.speed).toBeCloseTo(5, 1);
    }
    loop.run(6);
    expect(loop.body.grounded).toBe(true);
    // A fresh host request launches immediately once the controller reports grounded.
    loop.jump = true;
    loop.tick();
    expect(loop.body.grounded).toBe(false);
    expect(loop.body.velocity.y).toBeCloseTo(JUMP_SPEED, 3);
    world.free();
  });


  it('the realised velocity is the movement of the step, and a write does not move the body before the step', () => {
    const world = worldOf([FLOOR]);
    const c = player(world, { x: 0, y: 0.3, z: 0 });
    settle(world, c);
    const before = { ...c.feet };
    c.desiredVelocity.x = 3; c.desiredVelocity.y = c.velocity.y + GRAVITY * TICK; c.desiredVelocity.z = -4;
    expect(c.feet).toEqual(before);
    world.step(TICK);
    expect((c.feet.x - before.x) / TICK).toBeCloseTo(c.velocity.x, 3);
    expect((c.feet.z - before.z) / TICK).toBeCloseTo(c.velocity.z, 3);
    expect(c.velocity.x).toBeCloseTo(3, 2);
    expect(c.velocity.z).toBeCloseTo(-4, 2);
    // the Rapier body is where the port says it is
    const t = c.body.translation();
    expect(t.x).toBe(c.feet.x); expect(t.y).toBe(c.feet.y); expect(t.z).toBe(c.feet.z);
    world.free();
  });
});
