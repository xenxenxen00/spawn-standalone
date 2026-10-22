// Riders on kinematic bodies (motion §5.13, §5.4 step 0): "the engine carries riders and releases them with momentum"
// (sk/interactive-objects:13). The teacups turn once in 40 s (`scripts/map/spin.js`). The carry is the port's: the rigid
// displacement of the feet under the ground body's move of the tick, translation only.
import { describe, expect, it } from 'vitest';
import type { CharacterBody } from '../../../src/compat/physics/rapier/kcc.ts';
import type { KinematicBody, PhysicsWorld } from '../../../src/compat/physics/rapier/world.ts';
import { FLOOR, GRAVITY, PlayerLoop, TICK, player, worldOf } from './rapier-fixtures.ts';

const yawQuat = (a: number): { x: number; y: number; z: number; w: number } => ({ x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) });

/** a disc-like platform (6 × 6 m slab, top at y = 0.5) on a kinematic body, well above the static floor */
function teacup(): { world: PhysicsWorld; disc: KinematicBody } {
  const world = worldOf([{ ...FLOOR, at: [0, -3, 0] }, { row: 'teacup', box: [3, 0.25, 3], at: [0, 0.25, 0], kinematic: true, mutable: true }]);
  return { world, disc: world.kinematicOf('teacup')! };
}

/** the rider's feet in the disc's frame */
function local(c: CharacterBody, yaw: number): { x: number; z: number } {
  return { x: Math.cos(yaw) * c.feet.x - Math.sin(yaw) * c.feet.z, z: Math.sin(yaw) * c.feet.x + Math.cos(yaw) * c.feet.z };
}

describe('kcc-platform', () => {
  it.each([
    ['teacup pace, 40 s per turn', 40],
    ['four times as fast', 10],
  ])('a standing body is carried by a turning disc (%s): one full turn without drifting on it', (_name, period) => {
    const { world, disc } = teacup();
    const c = player(world, { x: 2, y: 0.6, z: 0 });
    const loop = new PlayerLoop(world, c);
    loop.run(20);
    expect(c.grounded).toBe(true);
    expect(c.groundBody).toBe(disc.body.handle);
    const omega = (2 * Math.PI) / period;
    let yaw = 0;
    const ticks = Math.round(period / TICK);
    let worst = 0;
    for (let i = 0; i < ticks; i++) {
      yaw = omega * (i + 1) * TICK;
      world.setKinematicTarget(disc, null, yawQuat(yaw));
      loop.tick();
      const p = local(c, yaw);
      worst = Math.max(worst, Math.hypot(p.x - 2, p.z));
      expect(c.grounded).toBe(true);
      if (i > 2) {
        // the body reads the point velocity of the disc under its feet: ω·r, tangential
        expect(Math.hypot(c.velocity.x, c.velocity.z)).toBeCloseTo(omega * 2, 1);
      }
    }
    // back where it started, in the world and on the disc
    expect(worst).toBeLessThan(0.02);
    expect(c.feet.x).toBeCloseTo(2, 1);
    expect(c.feet.z).toBeCloseTo(0, 1);
    expect(c.feet.y).toBeCloseTo(0.51, 2);
    expect(loop.landings).toHaveLength(1);
    world.free();
  });

  it('walking on the disc is walking relative to it', () => {
    const { world, disc } = teacup();
    const c = player(world, { x: 0, y: 0.6, z: 0 });
    const loop = new PlayerLoop(world, c);
    loop.run(20);
    const omega = (2 * Math.PI) / 40;
    let yaw = 0;
    // walk outwards along the disc's (turning) x axis for 0.4 s
    for (let i = 0; i < 12; i++) {
      yaw += omega * TICK;
      world.setKinematicTarget(disc, null, yawQuat(yaw));
      loop.wish(Math.cos(yaw), -Math.sin(yaw));
      loop.tick();
    }
    const p = local(c, yaw);
    // 12 ticks at up to 5 m/s after 0.119 s of acceleration ≈ 1.7 m out, and no sideways slip on the disc
    expect(p.x).toBeGreaterThan(1.5);
    expect(p.x).toBeLessThan(2);
    expect(Math.abs(p.z)).toBeLessThan(0.08);
    expect(c.groundBody).toBe(disc.body.handle);
    world.free();
  });

  it('a sliding platform carries its rider, who keeps the momentum when jumping off', () => {
    const { world, disc } = teacup();
    const c = player(world, { x: 0, y: 0.6, z: 0 });
    const loop = new PlayerLoop(world, c);
    loop.run(20);
    // below 56 m/s² × 1/30 s = 1.87 m/s: faster than that, player.js cannot brake the carry it reads back within a tick
    const speed = 1.5;
    let x = 0;
    for (let i = 0; i < 20; i++) {
      x += speed * TICK;
      world.setKinematicTarget(disc, { x, y: 0, z: 0 }, null);
      loop.tick();
      expect(c.grounded).toBe(true);
    }
    expect(c.feet.x).toBeCloseTo(x, 2);
    expect(c.velocity.x).toBeCloseTo(speed, 1);
    // jump-off: the game writes the velocity it read (the platform's) plus the launch; the platform stops dead
    let vy = 6.75;
    const xs: number[] = [];
    for (let i = 0; i < 8; i++) {
      c.desiredVelocity.x = c.velocity.x; c.desiredVelocity.y = vy; c.desiredVelocity.z = c.velocity.z;
      world.step(TICK);
      vy = c.velocity.y + GRAVITY * TICK;
      xs.push(c.feet.x);
      if (i > 0) expect(c.grounded).toBe(false);
    }
    // airborne: no carry any more, but the horizontal speed it left with
    expect(c.groundBody).toBe(-1);
    expect(c.velocity.x).toBeCloseTo(speed, 1);
    expect(xs[7]! - xs[1]!).toBeCloseTo(speed * 6 * TICK, 2);
    world.free();
  });

  it('momentum off a turning disc is the tangential point velocity at take-off', () => {
    const { world, disc } = teacup();
    const c = player(world, { x: 2.5, y: 0.6, z: 0 });
    const loop = new PlayerLoop(world, c);
    loop.run(20);
    const omega = (2 * Math.PI) / 10;
    let yaw = 0;
    for (let i = 0; i < 15; i++) {
      yaw += omega * TICK;
      world.setKinematicTarget(disc, null, yawQuat(yaw));
      loop.tick();
    }
    const r = Math.hypot(c.feet.x, c.feet.z);
    expect(r).toBeCloseTo(2.5, 2);
    const vx = c.velocity.x, vz = c.velocity.z;
    expect(Math.hypot(vx, vz)).toBeCloseTo(omega * r, 1);
    // tangential: perpendicular to the radius
    expect(Math.abs(vx * c.feet.x + vz * c.feet.z) / (Math.hypot(vx, vz) * r)).toBeLessThan(0.05);
    let vy = 6.75;
    for (let i = 0; i < 6; i++) {
      yaw += omega * TICK;
      world.setKinematicTarget(disc, null, yawQuat(yaw));
      // the take-off tick still stands on the disc: player.js has braked the carry it read to 0 and the carry of this tick
      // is added by the port; from then on the game writes back what it read
      c.desiredVelocity.x = i === 0 ? 0 : c.velocity.x; c.desiredVelocity.y = vy; c.desiredVelocity.z = i === 0 ? 0 : c.velocity.z;
      world.step(TICK);
      vy = c.velocity.y + GRAVITY * TICK;
    }
    // it flies straight on with the speed it had, while the disc turns on underneath
    expect(c.grounded).toBe(false);
    expect(Math.hypot(c.velocity.x, c.velocity.z)).toBeCloseTo(Math.hypot(vx, vz), 1);
    expect(Math.hypot(c.velocity.x - vx, c.velocity.z - vz)).toBeLessThan(0.12);
    expect(c.groundBody).toBe(-1);
    world.free();
  });

  it('two riders in contact are carried together, and one can walk on the platform while it slides toward the other', () => {
    const { world, disc } = teacup();
    const a = player(world, { x: -0.355, y: 0.6, z: 0 }, 'a');
    const b = player(world, { x: 0.355, y: 0.6, z: 0 }, 'b');
    const stand = (c: CharacterBody): void => { c.desiredVelocity.x = 0; c.desiredVelocity.y = c.velocity.y + GRAVITY * TICK; c.desiredVelocity.z = 0; };
    for (let i = 0; i < 20; i++) { stand(a); stand(b); world.step(TICK); }
    expect(a.groundBody).toBe(disc.body.handle);
    expect(b.groundBody).toBe(disc.body.handle);
    // the platform slides along +x: for a, the carry points at b's place of the tick before
    let x = 0;
    for (let i = 0; i < 20; i++) {
      x += 1.5 * TICK;
      world.setKinematicTarget(disc, { x, y: 0, z: 0 }, null);
      stand(a); stand(b);
      world.step(TICK);
    }
    expect(a.feet.x).toBeCloseTo(-0.355 + x, 2);
    expect(b.feet.x).toBeCloseTo(0.355 + x, 2);
    expect(b.feet.x - a.feet.x).toBeCloseTo(0.71, 2);
    // a walks across the platform (along the contact) while it keeps sliding: its own walk is not held back by the carry
    const z0 = a.feet.z;
    for (let i = 0; i < 15; i++) {
      x += 1.5 * TICK;
      world.setKinematicTarget(disc, { x, y: 0, z: 0 }, null);
      a.desiredVelocity.x = 0; a.desiredVelocity.y = a.velocity.y + GRAVITY * TICK; a.desiredVelocity.z = -3;
      stand(b);
      world.step(TICK);
    }
    expect(z0 - a.feet.z).toBeGreaterThan(15 * 3 * TICK * 0.95);
    expect(a.feet.x).toBeCloseTo(-0.355 + x, 1);
    expect(b.feet.x).toBeCloseTo(0.355 + x, 2);
    world.free();
  });

  it('only kinematic bodies carry: a character standing on another one is not carried by its walk', () => {
    const world = worldOf([FLOOR]);
    const below = player(world, { x: 0, y: 0.05, z: 0 }, 'below');
    const above = player(world, { x: 0, y: 2.0, z: 0 }, 'above');
    for (let i = 0; i < 30; i++) {
      for (const c of [below, above]) { c.desiredVelocity.x = 0; c.desiredVelocity.y = c.velocity.y + GRAVITY * TICK; c.desiredVelocity.z = 0; }
      world.step(TICK);
    }
    expect(above.grounded).toBe(true);
    expect(above.feet.y).toBeGreaterThan(1.9);
    expect(above.groundBody).toBe(-1);
    world.free();
  });

  it('a platform that does not move carries nothing and costs no drift', () => {
    const { world, disc } = teacup();
    const c = player(world, { x: 1, y: 0.6, z: 1 });
    const loop = new PlayerLoop(world, c);
    loop.run(120);
    expect(c.groundBody).toBe(disc.body.handle);
    expect(Math.hypot(c.feet.x - 1, c.feet.z - 1)).toBeLessThan(0.002);
    expect(Math.hypot(c.velocity.x, c.velocity.z)).toBeLessThan(0.01);
    world.free();
  });
});
