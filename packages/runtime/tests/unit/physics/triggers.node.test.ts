// triggers.test (motion §5.7, §5.13; WP PH3): a `{body: 'static', trigger: true}` row is a sensor made from the ROW (it is not
// in the collider pack); a character walking into it yields exactly one enter within one tick of the overlap, dispatched by
// the kernel as `onTriggerEnter(ctx, other)`; sensors are invisible to rays and to the controller.
import { afterEach, describe, expect, it } from 'vitest';
import { raycast, type RaycastHit } from '../../../src/compat/builtin/physics.ts';
import type { ObjectView } from '../../../src/compat/core/types.ts';
import { PhysicsPortImpl } from '../../../src/compat/physics/port.ts';
import { kernelWorld, LIVE_PLAYER_PHYSICS, type KernelWorld, type MiniCtx } from './kernel-fixture.ts';
import { bakeOf, fakeRow, fakeStore, setPos, setVel } from './port-fixtures.ts';
import { FLOOR, GRAVITY, TICK, packOf } from './rapier-fixtures.ts';

const PORTAL = 'scripts/map/portal.js';
const WALK = 'scripts/test/walk.js';
/** the live row (game/places/training/cells/x0z0.scene `tr-portal-bunker`), moved onto the fixture's x axis */
const PORTAL_ROW = {
  id: 'tr-portal', spec: {
    behavior: PORTAL, feetPosition: { x: 4, y: 0, z: 0 }, physics: { body: 'static', trigger: true },
    primitive: { depth: 3, height: 2.6, kind: 'box', width: 1.6 }, tags: ['portal'], visible: false,
  },
};

type V = { x: number; y: number; z: number };
let w: KernelWorld | null = null;
let port: PhysicsPortImpl | null = null;
afterEach(() => { w?.dispose(); w = null; port?.dispose(); port = null; });

describe('triggers in the kernel', () => {
  it('a character walking into the portal sensor: exactly one onTriggerEnter, within one tick of the overlap; it walks on unhindered', async () => {
    const entered: Array<{ trigger: string; other: string; tick: number }> = [];
    const wish = { x: 0 };
    w = await kernelWorld({
      places: { range: { parts: [FLOOR, { row: 'backstop', box: [0.2, 2, 4], at: [9, 2, 0] }], rows: [PORTAL_ROW] } },
      modules: {
        [PORTAL]: { onTriggerEnter: (ctx: MiniCtx, other: { id: string }) => void entered.push({ trigger: ctx.row.id, other: other.id, tick: w!.k.clock.tick }) },
        [WALK]: {
          update: (ctx: MiniCtx, dt: number) => {
            const self = ctx.self as ObjectView & { velocity: V };
            self.velocity = { x: wish.x, y: self.velocity.y + GRAVITY * dt, z: 0 };
          },
        },
      },
      player: { tags: ['player'], physics: LIVE_PLAYER_PHYSICS, behavior: WALK },
    });
    await w.enter('range');
    const body = w.human('range', { x: 0, y: 0.05, z: 0 });
    w.ticks(10);
    expect(entered).toEqual([]);
    // the sensor: a 1.6 m wide box from x = 3.2 to 4.8; the capsule (r 0.35) first overlaps it with its feet at x > 2.85
    wish.x = 5;
    let overlapTick = -1;
    const speeds: number[] = [];
    for (let i = 0; i < 60; i++) {
      w.ticks(1);
      speeds.push(body.tf.vel.x);
      if (overlapTick < 0 && body.tf.pos.x > 3.2 - 0.35) overlapTick = w.k.clock.tick;
    }
    expect(overlapTick).toBeGreaterThan(0);
    expect(entered).toHaveLength(1);
    expect(entered[0]).toMatchObject({ trigger: 'tr-portal', other: 'player/local' });
    // the enter is dispatched in the tick the overlap was made or the next one (a kinematic move is reported one substep late)
    expect(entered[0]!.tick - overlapTick).toBeGreaterThanOrEqual(-1);
    expect(entered[0]!.tick - overlapTick).toBeLessThanOrEqual(1);
    // invisible to the controller: full pace through the volume, stopped only by the wall behind it
    expect(Math.min(...speeds.slice(2, 20))).toBeGreaterThan(4.8);
    expect(body.tf.pos.x).toBeGreaterThan(8.8 - 0.35 - 0.03);
    // invisible to rays: the wall behind answers
    const hit = raycast({ place: { id: 'range' } }, { x: 0, y: 1, z: 0.8 }, { x: 1, y: 0, z: 0 }) as RaycastHit;
    expect(hit.id).toBe('backstop');
    expect(raycast({ place: { id: 'range' } }, { x: 0, y: 1, z: 0.8 }, { x: 1, y: 0, z: 0 }, { tags: ['portal'] })).toBeNull();
    // standing inside or beyond it: no second enter
    w.ticks(30);
    expect(entered).toHaveLength(1);
    // out and in again is a new enter
    wish.x = -5;
    w.ticks(60);
    expect(body.tf.pos.x).toBeLessThan(2);
    expect(entered).toHaveLength(2);
    wish.x = 5;
    w.ticks(30);
    expect(entered).toHaveLength(3);
    expect(w.port.world('range')!.colliders.ownersOf('tr-portal')).toHaveLength(1);
    expect(w.port.world('range')!.colliders.ownersOf('tr-portal')[0]!.sensor).toBe(true);
  });
});

describe('triggers at the port', () => {
  function setup(): { store: ReturnType<typeof fakeStore>; port: PhysicsPortImpl } {
    const store = fakeStore();
    port = new PhysicsPortImpl({ host: { store } });
    port.buildPlace('home', bakeOf(packOf('home', [FLOOR])));
    return { store, port };
  }
  const zone = (id: string, x: number): ReturnType<typeof fakeRow> => fakeRow(id, { physics: { body: 'static', trigger: true }, primitive: { kind: 'box', width: 2, height: 2, depth: 2 }, pos: { x, y: 0, z: 0 }, tags: ['zone'] });

  it('enters are drained once, sorted by (trigger serial, other serial); a teleport into a zone enters; a spectating body does not', () => {
    const { store, port: p } = setup();
    const z1 = store.add(zone('zone-1', 10)), z2 = store.add(zone('zone-2', 10));
    const a = store.add(fakeRow('a', { physics: 'character', pos: { x: 0, y: 0.05, z: 0 } }));
    const b = store.add(fakeRow('b', { physics: 'character', pos: { x: 0, y: 0.05, z: 3 } }));
    const ghost = store.add(fakeRow('ghost', { physics: 'character', pos: { x: 0, y: 0.05, z: -3 }, spectating: true }));
    // reported out of order: the bodies are made as they come, the enters are sorted by spawn serial all the same
    for (const row of [b, z2, ghost, a, z1]) p.rowSpawned(row);
    p.step('home', TICK);
    expect(p.drainTriggerEnters()).toEqual([]);
    for (const row of [b, a, ghost]) p.setPosition(row, setPos(row, { x: 10, y: 0.05, z: row === a ? 0.4 : -0.4 }));
    p.step('home', TICK);
    p.step('home', TICK);
    expect(p.drainTriggerEnters()).toEqual([
      { trigger: 'zone-1', other: 'a' }, { trigger: 'zone-1', other: 'b' }, { trigger: 'zone-2', other: 'a' }, { trigger: 'zone-2', other: 'b' },
    ]);
    expect(p.drainTriggerEnters()).toEqual([]);
    for (let i = 0; i < 5; i++) p.step('home', TICK);
    expect(p.drainTriggerEnters()).toEqual([]);
    // the spectator mounts inside the zones: that is an enter, once
    ghost.spectating = false;
    p.setSpectating(ghost, false);
    for (let i = 0; i < 3; i++) p.step('home', TICK);
    expect(p.drainTriggerEnters()).toEqual([{ trigger: 'zone-1', other: 'ghost' }, { trigger: 'zone-2', other: 'ghost' }]);
    // a body that spectates stops overlapping; coming back is a new enter
    a.spectating = true;
    p.setSpectating(a, true);
    for (let i = 0; i < 3; i++) p.step('home', TICK);
    a.spectating = false;
    p.setSpectating(a, false);
    for (let i = 0; i < 3; i++) p.step('home', TICK);
    expect(p.drainTriggerEnters()).toEqual([{ trigger: 'zone-1', other: 'a' }, { trigger: 'zone-2', other: 'a' }]);
    // a destroyed trigger reports nothing more
    p.rowDestroyed(z1);
    p.rowDestroyed(z2);
    for (const row of [a, b]) p.setPosition(row, setPos(row, { x: 0, y: 0.05, z: 0 }));
    for (let i = 0; i < 3; i++) p.step('home', TICK);
    expect(p.drainTriggerEnters()).toEqual([]);
    void setVel;
  });

  it('a static body, a kinematic door and another sensor are no enters (characters and dynamic bodies only)', () => {
    const store = fakeStore();
    port = new PhysicsPortImpl({ host: { store } });
    port.buildPlace('home', bakeOf(packOf('home', [FLOOR, { row: 'door', box: [0.5, 1, 0.05], at: [10, 1, 0], kinematic: true, mutable: true }, { row: 'crate', box: [0.5, 0.5, 0.5], at: [10, 0.5, 0.5] }])));
    for (const row of [zone('zone-1', 10), zone('zone-2', 10.5), fakeRow('door', { physics: 'kinematic', pos: { x: 10, y: 0, z: 0 } })]) port.rowSpawned(store.add(row));
    for (let i = 0; i < 4; i++) port.step('home', TICK);
    expect(port.drainTriggerEnters()).toEqual([]);
  });
});
