// oob.test (motion §5.8, §5.13; core §11.7; WP PH3): the kernel owns the out-of-bounds rule, the physics port supplies the
// positions (bodies really fall off the fixture floor here) and executes the outcomes:
//   - a row with `onOutOfBounds` (an enemy) hears it at the fall point and is otherwise left alone;
//   - a character without a hook is teleported to the place's spawn point with zero velocity, its Rapier body with it;
//   - a dynamic body without a hook (a gib) is held at the bottom plane: the port routes the hold to the dynamics backend.
import { afterEach, describe, expect, it } from 'vitest';
import type { ObjectView, OutOfBoundsEvent, RowRec } from '../../../src/compat/core/types.ts';
import type { DynamicBodies } from '../../../src/compat/physics/rapier/body-sync.ts';
import { kernelWorld, LIVE_PLAYER_PHYSICS, type KernelWorld, type MiniCtx } from './kernel-fixture.ts';
import { GRAVITY, type Part } from './rapier-fixtures.ts';

const FALL = 'scripts/test/fall.js';
const ENEMY = 'scripts/enemies/enemy.js';
const BOTTOM = -10;
/** a 6 × 6 m deck with its top at y = 0; everything beside it is a drop */
const DECK: Part = { row: 'deck', box: [3, 0.5, 3], at: [0, -0.5, 0] };
type V = { x: number; y: number; z: number };

let w: KernelWorld;
afterEach(() => w?.dispose());

const gravity = { update: (ctx: MiniCtx, dt: number): void => {
  const self = ctx.self as ObjectView & { velocity: V };
  self.velocity = { x: 0, y: self.velocity.y + GRAVITY * dt, z: 0 };
} };

async function field(extra: Record<string, Record<string, unknown>> = {}, dynamics?: () => DynamicBodies): Promise<KernelWorld> {
  w = await kernelWorld({
    places: { home: { parts: [DECK], config: { worldBounds: { bottom: BOTTOM }, defaultSpawnPoint: { x: 0, y: 0.5, z: 0 } } } },
    modules: { [FALL]: gravity, ...extra },
    player: { tags: ['player'], physics: LIVE_PLAYER_PHYSICS, behavior: FALL },
    ...(dynamics ? { port: { dynamics } } : {}),
  });
  await w.enter('home');
  return w;
}

describe('out of bounds on the Rapier port', () => {
  it('an enemy with onOutOfBounds hears it once at the fall point, below the bottom plane, and nothing else happens to it', async () => {
    const heard: Array<{ ev: OutOfBoundsEvent; at: V }> = [];
    await field({ [ENEMY]: { ...gravity, onOutOfBounds: (ctx: MiniCtx, ev: OutOfBoundsEvent) => void heard.push({ ev, at: { ...(ctx.self as ObjectView & { feetPosition: V }).feetPosition } }) } });
    // spawned beside the deck: nothing under it
    w.spawn('enemy-1', { place: 'home', behavior: ENEMY, physics: { body: 'character', capsule: { height: 1.8, radius: 0.34 } }, feetPosition: { x: 8, y: 1, z: 2 }, tags: ['enemy'] });
    w.ticks(20);
    expect(heard).toEqual([]);
    expect(w.row('enemy-1')!.tf.pos.y).toBeLessThan(0);
    w.ticks(20);
    expect(heard).toHaveLength(1);
    const { ev, at } = heard[0]!;
    expect(ev.bottom).toBe(BOTTOM);
    expect(ev.placeId).toBe('home');
    expect(ev.respawnPoint).toEqual({ x: 0, y: 0.5, z: 0 });
    // at the fall point: where the body fell, just under the plane, not the spawn point
    expect(ev.position.x).toBeCloseTo(8, 4);
    expect(ev.position.z).toBeCloseTo(2, 4);
    expect(ev.position.y).toBeLessThan(BOTTOM);
    expect(ev.position.y).toBeGreaterThan(BOTTOM - 2);
    expect(at).toEqual(ev.position);
    // the hook did nothing: the body keeps falling and is not asked again
    w.ticks(10);
    expect(heard).toHaveLength(1);
    expect(w.row('enemy-1')!.tf.pos.y).toBeLessThan(ev.position.y);
    expect(w.port.world('home')!.characters[0]!.feet.x).toBeCloseTo(8, 4);
  });

  it('a character without a hook is teleported to the spawn point, velocity 0, and lands there', async () => {
    await field();
    const body = w.human('home', { x: 8, y: 1, z: 2 });
    let fell = false;
    for (let i = 0; i < 60 && !fell; i++) {
      const before = body.tf.pos.y;
      w.ticks(1);
      fell = body.tf.pos.y > before + 5;
    }
    expect(fell).toBe(true);
    expect(body.tf.pos).toEqual({ x: 0, y: 0.5, z: 0 });
    expect(body.tf.vel).toEqual({ x: 0, y: 0, z: 0 });
    // the Rapier body went with the row: no sweep back down the drop
    const c = w.port.world('home')!.characters[0]!;
    expect(c.feet).toEqual({ x: 0, y: 0.5, z: 0 });
    w.ticks(20);
    expect(body.tf.grounded).toBe(true);
    expect(body.tf.pos.y).toBeLessThan(0.03);
    expect(body.tf.pos.y).toBeGreaterThan(0);
    expect(Math.hypot(body.tf.pos.x, body.tf.pos.z)).toBeLessThan(1e-3);
  });

  it('a gib is held at the bottom plane: the hold reaches the dynamics backend, the row stays there', async () => {
    // a stand-in for PH4's backend: bodies fall under gravity, a hold stops them (dynamics.ts will sleep the Rapier body)
    const bodies = new Map<string, { row: RowRec; y: number; vy: number; held: boolean }>();
    const log: string[] = [];
    const backend: DynamicBodies = {
      add: (row, _body, pose) => { bodies.set(row.id, { row, y: pose.pos.y, vy: 0, held: false }); return true; },
      remove: (row) => void bodies.delete(row.id),
      update: () => undefined,
      setEnabled: () => undefined,
      setPosition: (row, p) => { const b = bodies.get(row.id)!; b.y = p.y; log.push(`pos ${row.id} ${p.y}`); },
      setRotation: () => undefined,
      setVelocity: (row, v) => { const b = bodies.get(row.id)!; b.vy = v.y; if (v.x === 0 && v.y === 0 && v.z === 0) b.held = true; log.push(`vel ${row.id} ${v.y}`); },
      setAngularVelocity: (row, v) => void log.push(`ang ${row.id} ${v.y}`),
      setForce: () => undefined,
      applyImpulse: () => undefined,
      hold: (row, y) => void log.push(`hold ${row.id} ${y}`),
      afterStep: (dt, write) => {
        for (const b of bodies.values()) {
          if (b.held) continue;
          b.vy += GRAVITY * dt;
          b.y += b.vy * dt;
          write(b.row, { x: b.row.tf.pos.x, y: b.y, z: b.row.tf.pos.z }, { x: 0, y: b.vy, z: 0 }, false, b.row.tf.rot, { x: 0, y: 0, z: 0 });
        }
      },
    };
    await field({}, () => backend);
    w.spawn('gib-1', { place: 'home', physics: { body: 'dynamic', collider: 'sphere', mass: 0.5 }, feetPosition: { x: 8, y: 1, z: 2 }, tags: ['gib'] });
    const gib = w.row('gib-1')!;
    w.ticks(60);
    expect(gib.tf.pos).toEqual({ x: 8, y: BOTTOM, z: 2 });
    expect(gib.tf.vel).toEqual({ x: 0, y: 0, z: 0 });
    // the kernel's hold as the port's verbs, forwarded to the backend: position at the plane, both velocities zero
    expect(log.slice(0, 4)).toEqual([`pos gib-1 ${BOTTOM}`, 'vel gib-1 0', 'ang gib-1 0', `hold gib-1 ${BOTTOM}`]);
    // held once: it does not sink again, so the kernel has nothing to repeat
    expect(log).toHaveLength(4);
    // the verb the frozen interface lacks (sleep + gravity scale 0) is on the port for whoever may call it
    w.port.holdBody(gib, BOTTOM);
    expect(log.at(-1)).toBe(`hold gib-1 ${BOTTOM}`);
    expect(log).toHaveLength(5);
  });
});
