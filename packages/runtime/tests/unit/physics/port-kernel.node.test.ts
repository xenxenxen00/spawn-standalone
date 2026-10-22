// The Rapier-backed physics port in the real kernel (WP PH3 acceptance; motion §5.2-§5.3, §12 WP-P3): a human body with the
// live player `physics` walks a fixture place, driven by behaviours through the handles, stepped by the scheduler's step E.
// Rapier is loaded by the setup file; a headless run awaits `ensurePhysics()` before the boot, as these tests do.
import { afterEach, describe, expect, it } from 'vitest';
import { raycast, type RaycastHit } from '../../../src/compat/builtin/physics.ts';
import type { ObjectView } from '../../../src/compat/core/types.ts';
import { ensurePhysics } from '../../../src/compat/physics/port.ts';
import { kernelWorld, LIVE_PLAYER_PHYSICS, type KernelWorld, type MiniCtx } from './kernel-fixture.ts';
import { FLOOR, GRAVITY, MOVE } from './rapier-fixtures.ts';

const SENSE = 'scripts/test/sense.js';
const WALK = 'scripts/test/walk.js';
const YARD = { parts: [FLOOR, { row: 'wall', box: [0.2, 2, 4] as [number, number, number], at: [3, 2, 0] as [number, number, number] }] };

type V = { x: number; y: number; z: number };
let w: KernelWorld;
afterEach(() => w?.dispose());

/**
 * Two behaviours in the order of the live template: the first only READS the velocity (scripts/humanoid-locomotion.js runs
 * before scripts/player.js and must see what the body did), the second is player.js's loop in miniature: accelerate from
 * the velocity read towards the wish, add gravity, write.
 */
function behaviours(wish: V, seen: V[]): Record<string, Record<string, unknown>> {
  return {
    [SENSE]: { update: (ctx: MiniCtx) => void seen.push({ ...(ctx.self as ObjectView & { velocity: V }).velocity }) },
    [WALK]: {
      update: (ctx: MiniCtx, dt: number) => {
        const self = ctx.self as ObjectView & { velocity: V; grounded: boolean | undefined };
        const v = self.velocity;
        const rate = MOVE.accel * dt;
        const dx = wish.x - v.x, dz = wish.z - v.z, gap = Math.hypot(dx, dz);
        const k = gap > rate ? rate / gap : 1;
        self.velocity = { x: v.x + dx * k, y: v.y + GRAVITY * dt, z: v.z + dz * k };
      },
    },
  };
}

describe('kernel walk (PH3 acceptance): the player walks a fixture place', () => {
  it('falls onto the floor, walks at the pace asked, is stopped by the wall and then reads a velocity of ~0', async () => {
    await ensurePhysics();
    const wish = { x: 0, y: 0, z: 0 };
    const seen: V[] = [];
    w = await kernelWorld({
      places: { yard: YARD },
      modules: behaviours(wish, seen),
      player: { tags: ['player', 'teammate'], physics: LIVE_PLAYER_PHYSICS, behavior: [SENSE, WALK] },
    });
    await w.enter('yard');
    expect(w.port.isBuilt('yard')).toBe(true);
    const body = w.human('yard', { x: 0, y: 0.5, z: 0 });
    const self = w.k.store.handle(body, body.vm) as ObjectView & { velocity: V; grounded: boolean | undefined; feetPosition: V };
    // the body is a Rapier character in the place's world
    expect(w.port.world('yard')!.characters.map((c) => c.rowId)).toEqual(['player/local']);
    expect(self.grounded).toBe(false);

    w.ticks(30);
    expect(self.grounded).toBe(true);
    expect(self.feetPosition.y).toBeGreaterThan(0);
    expect(self.feetPosition.y).toBeLessThan(0.03);
    expect(self.feetPosition.x).toBeCloseTo(0, 4);

    wish.x = MOVE.walk;
    w.ticks(15);
    expect(self.velocity.x).toBeCloseTo(MOVE.walk, 1);
    expect(self.grounded).toBe(true);
    const mid = self.feetPosition.x;
    expect(mid).toBeGreaterThan(1.5);
    // what the first behaviour read is what the body did in the step before: on open ground, the pace
    expect(seen.at(-1)!.x).toBeCloseTo(MOVE.walk, 1);

    w.ticks(60);
    // the wall's face is at x = 2.8; the capsule (r 0.35) stops one controller offset short of it
    expect(self.feetPosition.x).toBeGreaterThan(2.8 - 0.35 - 0.03);
    expect(self.feetPosition.x).toBeLessThan(2.8 - 0.35);
    expect(self.grounded).toBe(true);
    // pressed into the wall: the read is the realised velocity, ~0, although the script writes 1.4 m/s into it every tick
    expect(Math.abs(seen.at(-1)!.x)).toBeLessThan(0.05);
    expect(Math.abs(self.velocity.x)).toBeLessThan(0.05);
    // the row is where the Rapier body is
    const c = w.port.world('yard')!.characters[0]!;
    expect(body.tf.pos).toEqual(c.feet);
    expect(body.tf.grounded).toBe(c.grounded);

    // and away from the wall again, along z
    wish.x = 0; wish.z = -MOVE.walk;
    w.ticks(20);
    expect(self.velocity.z).toBeCloseTo(-MOVE.walk, 1);
    expect(self.feetPosition.z).toBeLessThan(-1.5);
  });

  it('a read after a write in the same tick returns the written value; raycast sees the place and ignores the caller', async () => {
    let read: V | null = null;
    let hit: RaycastHit | null = null;
    w = await kernelWorld({
      places: { yard: YARD },
      modules: {
        [WALK]: {
          update: (ctx: MiniCtx) => {
            const self = ctx.self as ObjectView & { velocity: V; feetPosition: V };
            self.velocity = { x: 1.25, y: -0.5, z: 0 };
            read = { ...self.velocity };
            const f = self.feetPosition;
            hit = raycast({ place: { id: 'yard' }, self: { id: ctx.row.id } }, { x: f.x, y: f.y + 1, z: f.z }, { x: 1, y: 0, z: 0 }) as RaycastHit | null;
          },
        },
      },
      player: { tags: ['player'], physics: LIVE_PLAYER_PHYSICS, behavior: WALK },
    });
    await w.enter('yard');
    w.human('yard', { x: 0, y: 0.02, z: 0 });
    w.ticks(3);
    expect(read).toEqual({ x: 1.25, y: -0.5, z: 0 });
    expect(hit!.id).toBe('wall');
    expect(hit!.body).toBe('static');
    expect(hit!.distance).toBeGreaterThan(2.6);
  });

  it('`ctx.cross` to a loaded place: the body stands in the new place\'s world and the world of the place it left is freed', async () => {
    w = await kernelWorld({ places: { yard: YARD, cellar: { parts: [FLOOR] } } });
    await w.enter('yard');
    await w.k.places.load('cellar');
    const body = w.human('yard', { x: 0, y: 0.05, z: 0 });
    w.ticks(5);
    const yard = w.port.world('yard')!;
    expect(yard.characters).toHaveLength(1);
    const res = w.k.places.cross({ kind: 'kernel' }, body.id, '+cellar');
    expect(res).toMatchObject({ crossed: true });
    expect(body.place).toBe('cellar');
    // the place the human left is unloaded: its world is freed (wasm memory is not garbage-collected)
    expect(yard.freed).toBe(true);
    expect(w.port.world('yard')).toBeNull();
    const there = w.port.world('cellar')!.characters;
    expect(there.map((c) => c.rowId)).toEqual(['player/local']);
    // it stands at the cellar's spawn point (the compiled default: the origin)
    expect(there[0]!.feet.x).toBeCloseTo(body.tf.pos.x, 5);
    expect(there[0]!.feet.y).toBeCloseTo(body.tf.pos.y, 5);
    w.ticks(3);
    expect(body.tf.pos.x).toBeCloseTo(0, 3);
  });

  it('a PositionSpec without y stands on the ground the port answers (groundY)', async () => {
    w = await kernelWorld({ places: { yard: { parts: [FLOOR, { row: 'deck', box: [1, 0.5, 1], at: [-6, 0.5, -6] }] } } });
    await w.enter('yard');
    w.spawn('lamp', { place: 'yard', feetPosition: { x: -6, z: -6 } });
    w.spawn('post', { place: 'yard', feetPosition: { x: 2, z: 2 } });
    expect(w.row('lamp')!.tf.pos.y).toBeCloseTo(1, 4);
    expect(w.row('post')!.tf.pos.y).toBeCloseTo(0, 4);
  });
});
