// Slope limits (motion §5.13): the player template climbs up to 52° and slides from 62° (templates/player.js:24-25), enemy
// defaults are 45° / 45° (D-MPN-08). Walkable slopes are walked at the pace asked (kcc.ts ground follow).
import { describe, expect, it } from 'vitest';
import { DEG } from '../../../src/compat/physics/defaults.ts';
import type { CharacterBody } from '../../../src/compat/physics/rapier/kcc.ts';
import type { PhysicsWorld } from '../../../src/compat/physics/rapier/world.ts';
import { FLOOR, MOVE, PlayerLoop, TICK, enemy, player, worldOf, type Part } from './rapier-fixtures.ts';

const LENGTH = 6;
/** a slab whose top face starts on the floor at x = 2 and rises toward +x at `deg` */
function ramp(deg: number): Part {
  const a = deg * DEG;
  return { row: 'ramp', box: [LENGTH, 0.25, 2], at: [2 + Math.cos(a) * LENGTH + Math.sin(a) * 0.25, Math.sin(a) * LENGTH - Math.cos(a) * 0.25, 0], axis: [0, 0, 1], deg };
}
type Make = (w: PhysicsWorld, feet: { x: number; y: number; z: number }) => CharacterBody;
const asPlayer: Make = (w, feet) => player(w, feet);
const asEnemy: Make = (w, feet) => enemy(w, feet);

/** walk at the ramp from the floor for 1.5 s */
function walkUp(deg: number, make: Make): { world: PhysicsWorld; loop: PlayerLoop } {
  const world = worldOf([FLOOR, ramp(deg)]);
  const loop = new PlayerLoop(world, make(world, { x: 0, y: 0.05, z: 0 }));
  loop.run(10);
  loop.wish(1, 0).run(45);
  return { world, loop };
}

/** put the body on the slope 3 m up and let it stand for `ticks`; returns how far it went down the slope */
function standOn(deg: number, make: Make, ticks = 45): { slid: number; grounded: boolean } {
  const a = deg * DEG;
  const world = worldOf([FLOOR, ramp(deg)]);
  // the lower sphere of the capsule touches a slope beside the feet: lift them so it rests on the surface
  const lift = 0.35 / Math.cos(a) - 0.35 + 0.05;
  const c = make(world, { x: 2 + 3 * Math.cos(a), y: 3 * Math.sin(a) + lift, z: 0 });
  const loop = new PlayerLoop(world, c);
  loop.run(15);
  const x0 = c.feet.x, y0 = c.feet.y;
  loop.run(ticks);
  const slid = Math.hypot(c.feet.x - x0, c.feet.y - y0) * (c.feet.y < y0 ? 1 : -1);
  const grounded = c.grounded;
  world.free();
  return { slid, grounded };
}

describe('kcc-slopes: the player template (climb 52°, slide 62°)', () => {
  it.each([20, 32.7, 40, 50])('climbs a %s° ramp at walking pace, on the ground all the way', (deg) => {
    const world = worldOf([FLOOR, ramp(deg)]);
    const c = player(world, { x: 0, y: 0.05, z: 0 });
    const loop = new PlayerLoop(world, c);
    loop.run(10);
    loop.wish(1, 0);
    for (let i = 0; i < 45; i++) {
      loop.tick();
      expect(c.grounded).toBe(true);
      // one tick meets the foot of the ramp; from then on the pace asked for
      if (c.feet.x > 2.3) expect(loop.speed).toBeGreaterThan(MOVE.walk * 0.97);
      // the game reads no upward speed from ground it merely follows
      expect(c.velocity.y).toBeLessThanOrEqual(0);
    }
    // 45 ticks at 5 m/s less the acceleration: horizontal distance as on the flat
    expect(c.feet.x).toBeGreaterThan(45 * MOVE.walk * TICK - 0.5);
    expect(c.feet.y).toBeCloseTo(Math.tan(deg * DEG) * (c.feet.x - 2) + 0.35 / Math.cos(deg * DEG) - 0.35 + 0.01, 1);
    expect(loop.landings).toHaveLength(1);
    world.free();
  });

  it('walks down a 40° ramp at the same pace without leaving it', () => {
    const a = 40 * DEG;
    const world = worldOf([FLOOR, ramp(40)]);
    const c = player(world, { x: 2 + 4 * Math.cos(a), y: 4 * Math.sin(a) + 0.2, z: 0 });
    const loop = new PlayerLoop(world, c);
    loop.run(15);
    loop.wish(-1, 0).run(5);
    for (let i = 0; i < 12; i++) {
      loop.tick();
      expect(c.grounded).toBe(true);
      expect(loop.speed).toBeGreaterThan(MOVE.walk * 0.97);
    }
    loop.run(20);
    expect(c.feet.y).toBeLessThan(0.03);
    expect(loop.landings).toHaveLength(1);
    world.free();
  });

  it('refuses a 55° ramp: no climb, ~0 velocity against it', () => {
    const { world, loop } = walkUp(55, asPlayer);
    expect(loop.body.feet.y).toBeLessThan(0.05);
    expect(loop.body.feet.x).toBeLessThan(2);
    expect(loop.speed).toBeLessThan(0.05);
    world.free();
  });

  it('holds on 55° and 60° without sliding (below minSlopeSlide)', () => {
    for (const deg of [55, 60]) {
      const r = standOn(deg, asPlayer);
      expect(Math.abs(r.slid), `${deg}°`).toBeLessThan(0.02);
      expect(r.grounded).toBe(true);
    }
  });

  it('slides down 65°', () => {
    const r = standOn(65, asPlayer);
    expect(r.slid).toBeGreaterThan(1);
  });

  it('stands still on a walkable slope', () => {
    for (const deg of [20, 40, 50]) expect(Math.abs(standOn(deg, asPlayer).slid), `${deg}°`).toBeLessThan(0.005);
  });
});

describe('kcc-slopes: enemy defaults (D-MPN-08: climb 45°, slide 45°)', () => {
  it('climb 44° at the pace asked', () => {
    const { world, loop } = walkUp(44, asEnemy);
    expect(loop.body.feet.x).toBeGreaterThan(45 * MOVE.walk * TICK - 0.5);
    expect(loop.body.feet.y).toBeGreaterThan(4);
    expect(loop.body.grounded).toBe(true);
    world.free();
  });

  it('refuse 46°, and slide off it', () => {
    const { world, loop } = walkUp(46, asEnemy);
    expect(loop.body.feet.y).toBeLessThan(0.05);
    expect(loop.body.feet.x).toBeLessThan(2);
    world.free();
    expect(standOn(46, asEnemy, 90).slid).toBeGreaterThan(0.3);
    expect(Math.abs(standOn(44, asEnemy).slid)).toBeLessThan(0.005);
  });

  it('the player template still climbs the 46° an enemy refuses', () => {
    const { world, loop } = walkUp(46, asPlayer);
    expect(loop.body.feet.y).toBeGreaterThan(4);
    world.free();
  });
});
