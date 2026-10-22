// R-5: a character dash (21 m/s for 170 ms) must not pass through walls or other characters at 20, 30 or 60 fps. Opt-in:
// `CharacterSpec.continuous` per body, `PhysicsWorld.characterCcd` / `PhysicsPortOptions.characterCcd` per world (kcc-ccd.ts).
import { describe, expect, it } from 'vitest';
import { normalizeBody } from '../../../src/compat/physics/spec.ts';
import { FLOOR, GRAVITY, PLAYER_CAPSULE, PLAYER_KCC, enemy, player, settle, worldOf, type Part } from './rapier-fixtures.ts';
import type { PhysicsWorld } from '../../../src/compat/physics/rapier/world.ts';
import type { CharacterBody } from '../../../src/compat/physics/rapier/kcc.ts';

const DASH = 21;
const RATES = [20, 30, 60];
const thinWall: Part = { row: 'wall', box: [0.02, 2, 5], at: [3, 2, 0] };
// a mesh wall with no thickness at all
const meshWall: Part = { row: 'mesh', tris: new Float32Array([3, 0, -5, 3, 4, -5, 3, 4, 5, 3, 0, -5, 3, 4, 5, 3, 0, 5]) };

function drive(world: PhysicsWorld, c: CharacterBody, vx: number, ticks: number, dt: number, others: Array<[CharacterBody, number]> = []): void {
  for (let i = 0; i < ticks; i++) {
    c.desiredVelocity.x = vx; c.desiredVelocity.y = c.velocity.y + GRAVITY * dt; c.desiredVelocity.z = 0;
    for (const [o, ovx] of others) { o.desiredVelocity.x = ovx; o.desiredVelocity.y = o.velocity.y + GRAVITY * dt; o.desiredVelocity.z = 0; }
    world.step(dt);
  }
}
/** a dash then the key still held: 170 ms of 21 m/s, then 1.5 s of walking on */
function dashAndPress(world: PhysicsWorld, c: CharacterBody, dt: number, others: Array<[CharacterBody, number]> = []): void {
  drive(world, c, DASH, Math.ceil(0.17 / dt), dt, others);
  drive(world, c, 5, Math.ceil(1.5 / dt), dt, others);
}

describe('R-5 walls: the controller sweeps, so a dash does not tunnel (positive, old path)', () => {
  for (const [name, wall, face] of [['thin box', thinWall, 2.98], ['zero-thickness mesh', meshWall, 3]] as const) {
    for (const hz of RATES) {
      it(`${name} at ${hz} fps`, () => {
        const world = worldOf([FLOOR, wall]);
        const c = player(world, { x: 0, y: 0.05, z: 0 });
        settle(world, c);
        dashAndPress(world, c, 1 / hz);
        expect(c.feet.x + PLAYER_CAPSULE.radius).toBeLessThanOrEqual(face + 1e-6);
        world.free();
      });
    }
  }
});

describe('R-5 characters: a dash into a contestant', () => {
  const setup = (opts: { body?: boolean; world?: boolean }) => {
    const world = worldOf([FLOOR]);
    if (opts.world) world.characterCcd = true;
    const c = world.addCharacter({ rowId: 'p', feet: { x: 0, y: 0.05, z: 0 }, ...PLAYER_CAPSULE, params: PLAYER_KCC, ...(opts.body ? { continuous: true } : {}) });
    const bot = enemy(world, { x: 3, y: 0.05, z: 0 }, 'bot');
    settle(world, c);
    return { world, c, bot };
  };
  const reach = PLAYER_CAPSULE.radius + 0.34;

  for (const hz of RATES) {
    it(`negative control, default path at ${hz} fps: the pair interpenetrates and the dasher ends behind the bot`, () => {
      const { world, c, bot } = setup({});
      dashAndPress(world, c, 1 / hz);
      expect(c.feet.x).toBeGreaterThan(bot.feet.x);
      world.free();
    });
    for (const how of ['body', 'world'] as const) {
      it(`continuous (${how}) at ${hz} fps: stops at the capsule distance, then only slides around it`, () => {
        const { world, c, bot } = setup({ [how]: true });
        const dt = 1 / hz;
        const dist = (): number => Math.hypot(bot.feet.x - c.feet.x, bot.feet.z - c.feet.z);
        drive(world, c, DASH, Math.ceil(0.17 / dt), dt);
        expect(dist()).toBeGreaterThanOrEqual(reach - 1e-6);
        expect(dist()).toBeLessThan(reach + 0.05);
        expect(c.feet.x).toBeLessThan(bot.feet.x);
        for (let i = 0; i < Math.ceil(1.5 / dt); i++) {
          drive(world, c, 5, 1, dt);
          expect(dist()).toBeGreaterThanOrEqual(reach - 1e-6);
        }
        world.free();
      });
    }
    it(`continuous, head-on (bot walks toward the dasher) at ${hz} fps: never closer than the capsule distance`, () => {
      const { world, c, bot } = setup({ body: true });
      bot.continuous = true;
      const dt = 1 / hz;
      let min = Infinity;
      for (let i = 0; i < Math.ceil(2 / dt); i++) {
        drive(world, c, i * dt < 0.17 ? DASH : 5, 1, dt, [[bot, -5]]);
        min = Math.min(min, Math.hypot(bot.feet.x - c.feet.x, bot.feet.z - c.feet.z));
      }
      expect(min).toBeGreaterThanOrEqual(reach - 1e-6);
      world.free();
    });
  }

  it('slides along the contestant when the dash is off-centre instead of stopping dead', () => {
    const world = worldOf([FLOOR]);
    world.characterCcd = true;
    const c = player(world, { x: 0, y: 0.05, z: 0.3 });
    const bot = enemy(world, { x: 3, y: 0.05, z: 0 }, 'bot');
    settle(world, c);
    drive(world, c, DASH, 5, 1 / 30);
    expect(Math.hypot(bot.feet.x - c.feet.x, bot.feet.z - c.feet.z)).toBeGreaterThanOrEqual(reach - 1e-6);
    expect(c.feet.z).toBeGreaterThan(0.3 + 0.05); // pushed off to the +z side along the disc
    world.free();
  });

  it('a character already inside another may separate but not close further', () => {
    const world = worldOf([FLOOR]);
    world.characterCcd = true;
    const c = player(world, { x: 2.6, y: 0.05, z: 0 });
    const bot = enemy(world, { x: 3, y: 0.05, z: 0 }, 'bot');
    settle(world, c);
    const d0 = bot.feet.x - c.feet.x;
    drive(world, c, 5, 10, 1 / 30);
    expect(bot.feet.x - c.feet.x).toBeGreaterThanOrEqual(Math.min(d0, reach) - 1e-6);
    world.free();
  });
});

describe('R-5 spec: `continuous` is read from the physics value', () => {
  const row = { id: 'x', props: {} } as never;
  it('opt-in only', () => {
    expect(normalizeBody({ body: 'character', continuous: true }, row, null).continuous).toBe(true);
    expect(normalizeBody({ body: 'character' }, row, null).continuous).toBeUndefined();
    expect(normalizeBody({ body: 'dynamic', continuous: true }, row, null).continuous).toBeUndefined();
  });
});
