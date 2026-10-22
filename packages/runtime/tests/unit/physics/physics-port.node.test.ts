// physics/port.ts + rapier/{body-sync,kinematic}.ts (motion §5.1-§5.5, core §5.8; WP PH3): the row ⇄ body binding seen through
// the frozen `PhysicsPort` verbs, on real Rapier worlds, with plain row records (port-fixtures.ts). The kernel-driven cases
// are in port-kernel.node.test.ts; the deferred build in rapier-loader.node.test.ts.
import { afterEach, describe, expect, it } from 'vitest';
import { raycast, type RaycastHit } from '../../../src/compat/builtin/physics.ts';
import type { RowRec } from '../../../src/compat/core/types.ts';
import { v3 } from '../../../src/compat/physics/math.ts';
import { PhysicsPortImpl } from '../../../src/compat/physics/port.ts';
import type { DynamicBodies } from '../../../src/compat/physics/rapier/body-sync.ts';
import { boxTriangles } from '../../../src/compat/physics/shapes.ts';
import { LIVE_PLAYER_PHYSICS } from './kernel-fixture.ts';
import { bakeOf, fakeRow, fakeStore, setPhysics, setPos, setRot, setVel, yawQuat, type FakeStore } from './port-fixtures.ts';
import { FLOOR, GRAVITY, TICK, packOf, type Part } from './rapier-fixtures.ts';

const DOWN = { x: 0, y: -1, z: 0 };
const ctx = { place: { id: 'home' } };
let port: PhysicsPortImpl;
let store: FakeStore;
const warnings: string[] = [];

function setup(parts: Part[] = [FLOOR], place = 'home'): void {
  store = fakeStore();
  warnings.length = 0;
  port = new PhysicsPortImpl({ host: { store, warn: (m) => warnings.push(m) } });
  port.buildPlace(place, bakeOf(packOf(place, parts)));
}
afterEach(() => port?.dispose());

const spawn = (id: string, init: Parameters<typeof fakeRow>[1] = {}): RowRec => {
  const row = store.add(fakeRow(id, init));
  port.rowSpawned(row);
  return row;
};
/** one tick of a script that applies gravity and wants (vx, vz), then step E */
function tick(row: RowRec, vx = 0, vz = 0, place = 'home'): void {
  setVel(row, { x: vx, y: row.tf.vel.y + GRAVITY * TICK, z: vz });
  port.setVelocity(row, row.tf.vel);
  port.step(place, TICK);
}
const hitDown = (x: number, z: number, opts: Record<string, unknown> = {}): RaycastHit | null =>
  raycast(ctx, { x, y: 10, z }, DOWN, { distance: 30, ...opts }) as RaycastHit | null;
/** the 12 triangles of a cube of half extent `h` about the origin (a LOD-5 hull as `GeometryService.lod5Hulls` hands it over) */
const cube = (h: number): Float32Array => boxTriangles(v3(h, h, h), null);

describe('physics port: worlds', () => {
  it('marks runtime collider decal exclusions only for explicitly configured tags', () => {
    for (const ignoredTags of [[], ['helper']]) {
      const localStore = fakeStore(); const localPort = new PhysicsPortImpl({ host: { store: localStore }, ignoredTags });
      localPort.buildPlace('home', bakeOf(packOf('home', [FLOOR])));
      for (const tag of ['bounds', 'helper']) {
        const row = localStore.add(fakeRow(tag, { physics: 'static', primitive: { kind: 'box', width: 1, height: 1, depth: 1 }, tags: [tag] })); localPort.rowSpawned(row);
        expect(localPort.world('home')!.colliders.ownersOf(tag).map(owner => owner.noDecal)).toEqual([ignoredTags.includes(tag)]);
      }
      localPort.dispose();
    }
  });
  it('both VMs get the same world handle; dispose frees every world; gravity comes from the place config', () => {
    store = fakeStore();
    port = new PhysicsPortImpl({ host: { store, placeConfig: (p) => (p === 'moon' ? { gravity: { x: 0, y: -1.6, z: 0 } } : undefined) } });
    port.buildPlace('home', bakeOf(packOf('home', [FLOOR])));
    port.buildPlace('moon', bakeOf(packOf('moon', [FLOOR])));
    expect(port.vmWorlds.platform).toBe(port.vmWorlds.client);
    const handle = port.vmWorlds.client as { world(place: string): unknown };
    expect(handle.world('home')).toBe(port.world('home'));
    expect(port.world('home')!.raw.gravity.y).toBe(-9.81);
    expect(port.world('moon')!.raw.gravity.y).toBeCloseTo(-1.6, 6);
    const home = port.world('home')!, moon = port.world('moon')!;
    port.disposePlace('moon');
    expect(moon.freed).toBe(true);
    expect(home.freed).toBe(false);
    expect(port.world('moon')).toBeNull();
    port.dispose();
    expect(home.freed).toBe(true);
    // a dead port ignores what still arrives
    port.buildPlace('home', bakeOf(packOf('home', [FLOOR])));
    expect(port.world('home')).toBeNull();
  });

  it('groundY answers the static ground from above, null beside it and for a place that is not resident; the fx raycaster likewise', () => {
    setup([FLOOR, { row: 'crate', box: [0.5, 0.5, 0.5], at: [3, 0.5, 0] }]);
    expect(port.groundY('home', 0, 0)).toBeCloseTo(0, 4);
    expect(port.groundY('home', 3, 0)).toBeCloseTo(1, 4);
    expect(port.groundY('home', 300, 0)).toBeNull();
    expect(port.groundY('nowhere', 0, 0)).toBeNull();
    expect(port.groundY('home', Number.NaN, 0)).toBeNull();
    // a character standing there is not ground (ONLY_FIXED)
    const body = spawn('npc', { physics: 'character', pos: { x: 6, y: 0.02, z: 0 } });
    port.step('home', TICK);
    expect(port.groundY('home', 6, 0)).toBeCloseTo(0, 4);
    expect(body.tf.pos.x).toBe(6);
    const fx = port.staticRaycaster();
    const floor = fx.castDown({ x: 3, y: 4, z: 0 }, 10)!;
    expect(floor.y).toBeCloseTo(1, 4);
    expect(floor.normal.y).toBeCloseTo(1, 5);
    expect(fx.castDown({ x: 3, y: 4, z: 0 }, 2)).toBeNull();
    expect(port.staticRaycaster(() => null).castDown({ x: 3, y: 4, z: 0 }, 10)).toBeNull();
  });

  it('groundY never answers the inside of a block: a probe on a triangle edge of a big box (a trimesh shell) still finds its top', () => {
    // Measured on Rapier 0.21 (the PH3 verifier, on the baked scorched-quarter block `sq-block-28`): a ray that runs exactly
    // along an edge between two triangles of a trimesh can pass between them. A box over 1.5 m half extent is such a mesh,
    // cut along the halvings of its faces, so authored coordinates (quarter metres from its centre) lie on those edges; one
    // down-ray in about 400 of this grid went through the roof and answered the block's floor, 26.2 m lower.
    const block: Part = { row: 'block', box: [7.5, 13.1, 6], at: [0, 13.1, 0], deg: 90 };
    for (const at of [[0, 0, 0], [10.3, 0, -7.1], [-58.7, 0, -62]] as const) {
      setup([FLOOR, { ...block, at: [at[0], 13.1, at[2]] }]);
      const wrong: string[] = [];
      // the block is yawed a quarter turn: 12 m along x, 15 m along z
      for (let lx = -5.875; lx < 6; lx += 0.125) {
        for (let lz = -7.375; lz < 7.5; lz += 0.125) {
          const y = port.groundY('home', at[0] + lx, at[2] + lz);
          if (y === null || Math.abs(y - 26.2) > 1e-3) wrong.push(`(${lx}, ${lz}) → ${y}`);
        }
      }
      expect(wrong, `block at ${at.join(', ')}`).toEqual([]);
      port.dispose();
    }
  });

  it("setVisualProxies gives a resident place its hits:'both' layer (X-42): a render-only crown is seen through the builtin, with its row's tags", () => {
    setup();
    store.add(fakeRow('pine-1', { tags: ['tree'], pos: { x: 5, y: 4, z: 5 } }));
    // no layer yet: colliders only, logged once
    expect(hitDown(5, 5, { hits: 'both' })!.id).toBe('floor');
    expect(warnings.filter((w) => w.includes("hits:'both'"))).toHaveLength(1);
    const crown = {
      // a 2 m cube of 12 triangles about the key origin, standing at (5, 5, 5): its top is at y = 6
      keys: [{ key: 'pine|{}|5', tris: cube(1) }],
      instances: [{ key: 'pine|{}|5', rowId: 'pine-1', m: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 5, 5, 1]) }],
    };
    port.setVisualProxies('home', crown);
    // a place that is not resident is ignored
    expect(() => port.setVisualProxies('nowhere', crown)).not.toThrow();
    expect(hitDown(5, 5)!.id).toBe('floor');
    const h = hitDown(5, 5, { hits: 'both' })!;
    expect([h.id, h.body, h.tags]).toEqual(['pine-1', 'static', ['tree']]);
    expect(h.distance).toBeCloseTo(4, 5);
    expect(hitDown(5, 5, { hits: 'both', excludeTags: ['tree'] })!.id).toBe('floor');
    expect(hitDown(5, 5, { hits: 'both', ignoreEntities: ['pine-1'] })!.id).toBe('floor');
    // the proxies are no colliders: nothing stands on them
    expect(port.groundY('home', 5, 5)).toBeCloseTo(0, 4);
    // replacing the soup drops the old layer; the layer outlives a rebuild of the place
    port.setVisualProxies('home', { keys: crown.keys, instances: [{ ...crown.instances[0]!, m: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -5, 5, 5, 1]) }] });
    expect(hitDown(5, 5, { hits: 'both' })!.id).toBe('floor');
    expect(hitDown(-5, 5, { hits: 'both' })!.id).toBe('pine-1');
    port.buildPlace('home', bakeOf(packOf('home', [FLOOR])));
    expect(hitDown(-5, 5, { hits: 'both' })!.id).toBe('pine-1');
    port.disposePlace('home');
    port.buildPlace('home', bakeOf(packOf('home', [FLOOR])));
    expect(hitDown(-5, 5, { hits: 'both' })!.id).toBe('floor');
  });
});

describe('physics port: characters', () => {
  it('the live player spec becomes capsule(0.6, 0.35) at y 0.95 on a kinematic body at the feet; it falls, lands and reads back', () => {
    setup();
    const body = spawn('player/local', { physics: LIVE_PLAYER_PHYSICS, pos: { x: 0, y: 1, z: 0 }, tags: ['player'] });
    const c = port.world('home')!.characters[0]!;
    expect(c.rowId).toBe('player/local');
    expect(c.height).toBe(1.9);
    expect(c.radius).toBe(0.35);
    expect(c.collider.halfHeight()).toBeCloseTo(0.6, 6);
    expect(c.collider.translation().y - c.body.translation().y).toBeCloseTo(0.95, 6);
    expect(c.body.isKinematic()).toBe(true);
    expect(c.params.maxSlopeClimb).toBeCloseTo((52 * Math.PI) / 180, 9);
    expect(c.groups).toBe(0x0004ffff);
    for (let i = 0; i < 30; i++) tick(body);
    expect(body.tf.grounded).toBe(true);
    expect(body.tf.pos.y).toBeGreaterThan(0);
    expect(body.tf.pos.y).toBeLessThan(0.03);
    // nobody writes a velocity: the body stands where it stood
    const at = { ...body.tf.pos };
    port.step('home', TICK);
    port.step('home', TICK);
    expect(Math.hypot(body.tf.pos.x - at.x, body.tf.pos.y - at.y, body.tf.pos.z - at.z)).toBeLessThan(1e-3);
    expect(body.tf.grounded).toBe(true);
  });

  it('velocity: a write is the desired velocity of the next step, the read-back is what the body did (pressed into a wall: ~0)', () => {
    setup([FLOOR, { row: 'wall', box: [0.2, 2, 4], at: [3, 2, 0] }]);
    const body = spawn('player/local', { physics: LIVE_PLAYER_PHYSICS, pos: { x: 0, y: 0.05, z: 0 } });
    for (let i = 0; i < 10; i++) tick(body);
    tick(body, 5);
    expect(body.tf.vel.x).toBeCloseTo(5, 2);
    for (let i = 0; i < 60; i++) tick(body, 5);
    expect(body.tf.pos.x).toBeGreaterThan(2.8 - 0.35 - 0.03);
    expect(body.tf.pos.x).toBeLessThan(2.8 - 0.35);
    expect(Math.abs(body.tf.vel.x)).toBeLessThan(0.05);
    expect(body.tf.grounded).toBe(true);
    // nobody writes: the body keeps the velocity it realised (here: none)
    const x = body.tf.pos.x;
    port.step('home', TICK);
    expect(body.tf.pos.x).toBeCloseTo(x, 4);
  });

  it('feetPosition is a teleport: no sweep through a wall, ground contact cleared, the body lands again', () => {
    setup([FLOOR, { row: 'wall', box: [0.2, 2, 4], at: [3, 2, 0] }]);
    const body = spawn('npc', { physics: 'character', pos: { x: 0, y: 0.05, z: 0 } });
    for (let i = 0; i < 10; i++) tick(body);
    expect(body.tf.grounded).toBe(true);
    port.setPosition(body, setPos(body, { x: 6, y: 1.5, z: 0 }));
    const c = port.world('home')!.characters[0]!;
    expect(c.feet.x).toBe(6);
    expect(c.grounded).toBe(false);
    tick(body);
    expect(body.tf.pos.x).toBeCloseTo(6, 5);
    expect(body.tf.grounded).toBe(false);
    for (let i = 0; i < 30; i++) tick(body);
    expect(body.tf.grounded).toBe(true);
    expect(body.tf.pos.x).toBeCloseTo(6, 3);
  });

  it('a capsule write keeps the body: setHalfHeight / setRadius on the same collider, feet planted (the crouch of player.js)', () => {
    setup([FLOOR, { row: 'beam', box: [1, 0.1, 1], at: [3, 1.6, 0] }]);
    const body = spawn('player/local', { physics: LIVE_PLAYER_PHYSICS, pos: { x: 0, y: 0.05, z: 0 } });
    for (let i = 0; i < 10; i++) tick(body);
    const world = port.world('home')!;
    const c = world.characters[0]!;
    const handle = c.collider.handle, y = body.tf.pos.y;
    // standing, the 1.5 m gap under the beam stops it
    for (let i = 0; i < 40; i++) tick(body, 5);
    expect(body.tf.pos.x).toBeLessThan(2 - 0.35);
    const crouch = { ...LIVE_PLAYER_PHYSICS, capsule: { height: 1.2, radius: 0.35 } };
    setPhysics(body, crouch);
    port.onPhysicsWrite(body, crouch);
    expect(world.characters).toHaveLength(1);
    expect(world.characters[0]).toBe(c);
    expect(c.collider.handle).toBe(handle);
    expect(c.height).toBe(1.2);
    expect(c.collider.halfHeight()).toBeCloseTo(0.25, 6);
    for (let i = 0; i < 40; i++) tick(body, 5);
    expect(body.tf.pos.x).toBeGreaterThan(4.3);
    expect(body.tf.pos.y).toBeCloseTo(y, 2);
    // and back up
    setPhysics(body, LIVE_PLAYER_PHYSICS);
    port.onPhysicsWrite(body, LIVE_PLAYER_PHYSICS);
    expect(c.height).toBe(1.9);
    expect(world.characters[0]).toBe(c);
  });

  it('other option writes on the same kind: controller parameters and groups change in place', () => {
    setup();
    const body = spawn('npc', { physics: 'character' });
    const world = port.world('home')!;
    const c = world.characters[0]!;
    expect(c.params.autostep).toEqual({ maxHeight: 0.4, minWidth: 0.2, includeDynamic: false });
    const next = { body: 'character', autostep: false, snapToGroundDistance: false, collisionGroups: { membership: 0x0010, filter: 0x00ff } };
    setPhysics(body, next);
    port.onPhysicsWrite(body, next);
    expect(world.characters[0]).toBe(c);
    expect(c.params.autostep).toBeNull();
    expect(c.params.snapToGround).toBeNull();
    expect(c.groups).toBe(0x001000ff);
    expect(c.collider.collisionGroups()).toBe(0x001000ff);
  });

  it('spectating: the collider is disabled (no collision, no query, no move) and re-mounts where the row stands', () => {
    setup();
    const a = spawn('a', { physics: 'character', pos: { x: 0, y: 0.05, z: 0 }, tags: ['enemy'] });
    const b = spawn('b', { physics: 'character', pos: { x: 2, y: 0.05, z: 0 } });
    for (let i = 0; i < 10; i++) { tick(a); tick(b); }
    const from = { x: -3, y: 1, z: 0 }, fwd = { x: 1, y: 0, z: 0 };
    expect((raycast(ctx, from, fwd) as RaycastHit).id).toBe('a');
    a.spectating = true;
    port.setSpectating(a, true);
    port.step('home', TICK);
    expect((raycast(ctx, from, fwd) as RaycastHit).id).toBe('b');
    expect(port.aimTargets('home', from, fwd, 40, 0.45, { tags: ['enemy'] })).toEqual([]);
    // b walks through where a stands; a itself is not moved and not written back
    const writes = store.writes.filter((w) => w.id === 'a').length;
    for (let i = 0; i < 40; i++) { setVel(b, { x: -5, y: b.tf.vel.y + GRAVITY * TICK, z: 0 }); port.step('home', TICK); }
    expect(b.tf.pos.x).toBeLessThan(-1);
    expect(store.writes.filter((w) => w.id === 'a').length).toBe(writes);
    expect(port.bodyRecords('home').find((r) => r.rowId === 'a')).toMatchObject({ kind: 'character', enabled: false, capsule: { height: 1.9, radius: 0.35 } });
    // the row was moved while it spectated: it mounts there
    setPos(a, { x: 5, y: 0.05, z: 5 });
    a.spectating = false;
    port.setSpectating(a, false);
    port.step('home', TICK);
    expect((raycast(ctx, { x: 5, y: 1, z: 2 }, { x: 0, y: 0, z: 1 }) as RaycastHit).id).toBe('a');
    expect(port.bodyRecords('home').find((r) => r.rowId === 'a')!.enabled).toBe(true);
  });

  it('physics false keeps the body out of the world (a buried enemy); writing the kind back mounts it where the row is', () => {
    setup();
    const e = spawn('enemy-1', { physics: { body: 'character', capsule: { height: 1.8, radius: 0.34 } }, pos: { x: 0, y: 0.05, z: 0 } });
    for (let i = 0; i < 10; i++) tick(e);
    const c = port.world('home')!.characters[0]!;
    setPhysics(e, false);
    port.onPhysicsWrite(e, false);
    expect(c.enabled).toBe(false);
    const n = store.writes.length;
    setPos(e, { x: 4, y: -1, z: 0 });
    port.setPosition(e, e.tf.pos);
    port.step('home', TICK);
    expect(store.writes.length).toBe(n);
    expect(hitDown(4, 0, { bodies: 'all' })?.id).toBe('floor');
    const back = { body: 'character', capsule: { height: 1.2, radius: 0.34 } };
    setPos(e, { x: 4, y: 0.05, z: 0 });
    setPhysics(e, back);
    port.onPhysicsWrite(e, back);
    expect(port.world('home')!.characters[0]).toBe(c);
    expect(c.enabled).toBe(true);
    expect(c.height).toBe(1.2);
    port.step('home', TICK);
    expect(hitDown(4, 0, { bodies: 'all' })?.id).toBe('enemy-1');
  });

  it('a kind swap removes the body and makes the new one; a row that gains physics gets a body', () => {
    setup();
    const row = spawn('thing', { pos: { x: 2, y: 0, z: 2 }, primitive: { kind: 'box', width: 1, height: 1, depth: 1 }, tags: ['crate'] });
    expect(port.bodyRecords('home')).toEqual([]);
    setPhysics(row, 'static');
    port.onPhysicsWrite(row, 'static');
    port.step('home', TICK);
    const h = hitDown(2, 2)!;
    expect(h.id).toBe('thing');
    expect(h.body).toBe('static');
    expect(h.tags).toEqual(['crate']);
    expect(h.distance).toBeCloseTo(9, 4);
    setPhysics(row, 'character');
    port.onPhysicsWrite(row, 'character');
    expect(port.world('home')!.characters.map((c) => c.rowId)).toEqual(['thing']);
    port.step('home', TICK);
    expect(hitDown(2, 2)?.body).toBe('character');
    port.rowDestroyed(row);
    expect(port.world('home')!.characters).toHaveLength(0);
    port.step('home', TICK);
    expect(hitDown(2, 2)?.id).toBe('floor');
  });
});

describe('physics port: static and kinematic rows', () => {
  const DOOR: Part = { row: 'door', box: [0.5, 1, 0.05], at: [4.5, 1, 0], kinematic: true, mutable: true };
  const TERMINAL: Part = { row: 'terminal', box: [0.4, 1, 0.4], at: [-4, 1, 0], mutable: true };

  it('pack rows keep their pack colliders and get their tags when the row spawns after the build', () => {
    setup([FLOOR, DOOR, TERMINAL]);
    const before = port.world('home')!.colliders.size;
    expect(hitDown(-4, 0)!.tags).toEqual([]);
    spawn('terminal', { physics: 'static', pos: { x: -4, y: 0, z: 0 }, tags: ['terminal', 'supply'] });
    spawn('door', { physics: 'kinematic', pos: { x: 4, y: 0, z: 0 }, tags: ['door'] });
    expect(port.world('home')!.colliders.size).toBe(before);
    expect(hitDown(-4, 0)!.tags).toEqual(['terminal', 'supply']);
    expect(raycast(ctx, { x: -4, y: 10, z: 0 }, DOWN, { distance: 30, tags: ['supply'] })).not.toBeNull();
    expect((raycast(ctx, { x: 0, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, { tags: ['door'] }) as RaycastHit).id).toBe('door');
    expect(port.bodyRecords('home').map((r) => [r.rowId, r.kind, r.parts?.length])).toEqual([['terminal', 'static', 1], ['door', 'kinematic', 1]]);
  });

  it('bodyRecords keeps the made pose of a moved runtime row for nav overlays', () => {
    setup([FLOOR]);
    const crate = spawn('crate', { physics: 'static', primitive: { kind: 'box', width: 1, height: 1, depth: 1 }, pos: { x: 2, y: 0, z: 2 } });
    port.step('home', TICK);
    const made = port.bodyRecords('home').find((r) => r.rowId === 'crate')!;
    expect(made.baked).toMatchObject({ pos: { x: 2, y: 0, z: 2 } });
    port.setPosition(crate, setPos(crate, { x: 6, y: 0, z: -2 }));
    port.setRotation(crate, setRot(crate, yawQuat(90)));
    port.step('home', TICK);
    const moved = port.bodyRecords('home').find((r) => r.rowId === 'crate')!;
    expect(moved.pos).toMatchObject({ x: 6, y: 0, z: -2 });
    expect(moved.parts).toHaveLength(1);
    expect(moved.baked).toMatchObject({ pos: { x: 2, y: 0, z: 2 } });
  });

  it('a supply terminal toggles static ↔ "none" (trader-gate.js): the collider stays and is switched', () => {
    setup([FLOOR, TERMINAL]);
    const t = spawn('terminal', { physics: 'static', pos: { x: -4, y: 0, z: 0 } });
    const handle = port.world('home')!.colliders.ownersOf('terminal')[0]!.handle;
    setPhysics(t, 'none');
    port.onPhysicsWrite(t, 'none');
    port.step('home', TICK);
    expect(hitDown(-4, 0)!.id).toBe('floor');
    setPhysics(t, 'static');
    port.onPhysicsWrite(t, 'static');
    port.step('home', TICK);
    expect(hitDown(-4, 0)!.id).toBe('terminal');
    expect(port.world('home')!.colliders.ownersOf('terminal')[0]!.handle).toBe(handle);
  });

  it('a door turns about its ROW origin (the hinge), though its body stands at the leaf; a wreck is "none", a rebuild "kinematic"', () => {
    // the leaf is 1 m wide and stands from x = 4 to 5; the row (the hinge) is at x = 4
    setup([FLOOR, DOOR]);
    const door = spawn('door', { physics: 'kinematic', pos: { x: 4, y: 0, z: 0 }, tags: ['door'] });
    const kb = port.world('home')!.kinematicOf('door')!;
    expect(kb.pos.x).toBeCloseTo(4.5, 6);
    port.step('home', TICK);
    expect(hitDown(4.8, 0)!.id).toBe('door');
    // open by 90° about +Y: the leaf now runs along -z from the hinge
    port.setRotation(door, setRot(door, yawQuat(90)));
    port.step('home', TICK);
    expect(hitDown(4.8, 0)!.id).toBe('floor');
    expect(hitDown(4, -0.8)!.id).toBe('door');
    expect(kb.pos.x).toBeCloseTo(4, 5);
    expect(kb.pos.z).toBeCloseTo(-0.5, 5);
    // a row that is not written is not handed to Rapier again
    expect(kb.moving).toBe(false);
    port.step('home', TICK);
    expect(kb.moving).toBe(false);
    // the door is blown off: no collider; the body stays for the rebuild
    setPhysics(door, 'none');
    port.onPhysicsWrite(door, 'none');
    port.step('home', TICK);
    expect(hitDown(4, -0.8)!.id).toBe('floor');
    expect(port.world('home')!.kinematicOf('door')).toBe(kb);
    setPhysics(door, 'kinematic');
    port.onPhysicsWrite(door, 'kinematic');
    port.setRotation(door, setRot(door, yawQuat(0)));
    port.step('home', TICK);
    expect(hitDown(4.8, 0)!.id).toBe('door');
    // a feetPosition write moves the body through a target, and a velocity integrates the pose
    port.setPosition(door, setPos(door, { x: 6, y: 0, z: 0 }));
    port.step('home', TICK);
    expect(kb.pos.x).toBeCloseTo(6.5, 5);
    setVel(door, { x: 3, y: 0, z: 0 });
    port.setVelocity(door, door.tf.vel);
    port.step('home', TICK);
    expect(door.tf.pos.x).toBeCloseTo(6.1, 6);
    expect(kb.pos.x).toBeCloseTo(6.6, 5);
  });

  it('a kinematic platform carries its rider when its ROW is moved (the teacups)', () => {
    setup([{ ...FLOOR, at: [0, -3, 0] }, { row: 'teacup', box: [3, 0.25, 3], at: [0, 0.25, 0], kinematic: true, mutable: true }]);
    const cup = spawn('teacup', { physics: 'kinematic', pos: { x: 0, y: 0, z: 0 } });
    const rider = spawn('rider', { physics: LIVE_PLAYER_PHYSICS, pos: { x: 2, y: 0.6, z: 0 } });
    for (let i = 0; i < 20; i++) tick(rider);
    expect(rider.tf.grounded).toBe(true);
    const turns = 150;
    for (let i = 1; i <= turns; i++) {
      port.setRotation(cup, setRot(cup, yawQuat((i * 360) / 1200)));
      tick(rider);
      expect(rider.tf.grounded).toBe(true);
    }
    // an eighth of a turn (45°): the rider went with the disc, +x towards -z
    const a = (turns * 2 * Math.PI) / 1200;
    expect(rider.tf.pos.x).toBeCloseTo(2 * Math.cos(a), 1);
    expect(rider.tf.pos.z).toBeCloseTo(-2 * Math.sin(a), 1);
    // the read-back includes the carry: ω·r
    expect(Math.hypot(rider.tf.vel.x, rider.tf.vel.z)).toBeCloseTo(((2 * Math.PI) / 40) * 2, 1);
  });

  it('a mutable static row that is moved gets its colliders made again where it stands', () => {
    setup([FLOOR, TERMINAL]);
    const t = spawn('terminal', { physics: 'static', pos: { x: -4, y: 0, z: 0 }, tags: ['terminal'] });
    port.step('home', TICK);
    port.setPosition(t, setPos(t, { x: -8, y: 0, z: 2 }));
    port.setRotation(t, setRot(t, yawQuat(90)));
    // visible after the step, not before (motion §4.3)
    expect(hitDown(-4, 0)!.id).toBe('terminal');
    port.step('home', TICK);
    expect(hitDown(-4, 0)!.id).toBe('floor');
    const h = hitDown(-8, 2)!;
    expect(h.id).toBe('terminal');
    expect(h.tags).toEqual(['terminal']);
    expect(h.distance).toBeCloseTo(8, 4);
  });

  it('runtime rows take their collider from the row: box and sphere primitives, model bounds; a row with nothing is warned once', () => {
    store = fakeStore();
    warnings.length = 0;
    const bounds = { center: [0, 0.4, 0], min: [-1.5, 0, -0.3], max: [1.5, 0.8, 0.3], size: [3, 0.8, 0.6] } as const;
    port = new PhysicsPortImpl({ host: { store, warn: (m) => warnings.push(m), assets: { get: (ref) => (ref === 'barrier.glb' ? { bounds } : undefined), placeBake: () => Promise.reject(new Error('unused')) } } });
    port.buildPlace('home', bakeOf(packOf('home', [FLOOR])));
    spawn('box', { physics: 'static', primitive: { kind: 'box', width: 2, height: 1, depth: 2 }, pos: { x: 5, y: 0, z: 5 }, scale: { x: 1, y: 2, z: 1 } });
    spawn('ball', { physics: { body: 'static', collider: 'sphere' }, primitive: { kind: 'sphere', radius: 0.5 }, pos: { x: -5, y: 0, z: 5 } });
    spawn('barrier', { physics: { body: 'static' }, model: 'barrier.glb', pos: { x: 0, y: 0, z: -6 }, rot: yawQuat(90) });
    spawn('ghost', { physics: 'static', pos: { x: 9, y: 0, z: 9 } });
    spawn('ghost-2', { physics: 'static', primitive: { kind: 'cylinder' }, pos: { x: 9, y: 0, z: 9 } });
    port.step('home', TICK);
    // the box stands on the row's feet, its height scaled
    expect(hitDown(5, 5)).toMatchObject({ id: 'box' });
    expect(hitDown(5, 5)!.distance).toBeCloseTo(8, 4);
    // the ball is centred one radius above the feet
    expect(hitDown(-5, 5)!.distance).toBeCloseTo(9, 4);
    // the model's bounds box, turned with the row: 3 m along z now
    expect(hitDown(0, -7.4)).toMatchObject({ id: 'barrier' });
    expect(hitDown(0, -7.4)!.distance).toBeCloseTo(9.2, 4);
    expect(hitDown(1.4, -6)!.id).toBe('floor');
    expect(hitDown(9, 9)!.id).toBe('floor');
    expect(warnings.filter((w) => w.includes('ghost'))).toHaveLength(2);
    port.step('home', TICK);
    expect(warnings.filter((w) => w.includes('ghost'))).toHaveLength(2);
  });

  it('a pack row that changes kind and comes back gets its pack shapes again; a NaN velocity never reaches a body', () => {
    setup([FLOOR, TERMINAL]);
    const t = spawn('terminal', { physics: 'static', pos: { x: -4, y: 0, z: 0 }, primitive: { kind: 'scripted', script: 'scripts/gen/kit/terminal.js' } });
    setPhysics(t, 'character');
    port.onPhysicsWrite(t, 'character');
    port.step('home', TICK);
    expect(hitDown(-4, 0)!.body).toBe('character');
    expect(port.world('home')!.colliders.ownersOf('terminal')).toHaveLength(1);
    setPhysics(t, 'static');
    port.onPhysicsWrite(t, 'static');
    port.step('home', TICK);
    const h = hitDown(-4, 0)!;
    expect([h.id, h.body]).toEqual(['terminal', 'static']);
    expect(h.distance).toBeCloseTo(8, 4);
    expect(warnings).toEqual([]);
    const npc = spawn('npc', { physics: 'character', pos: { x: 2, y: 0.05, z: 2 } });
    setVel(npc, { x: Number.NaN, y: 0, z: 0 });
    port.step('home', TICK);
    const c = port.world('home')!.characters.at(-1)!;
    expect(c.rowId).toBe('npc');
    expect([c.feet.x, c.feet.y, c.feet.z].every(Number.isFinite)).toBe(true);
    expect(c.feet.x).toBe(2);
  });

  it('a scene row authored static that the bake left out has no collider and no warning (its generator gave none); a scene trigger is made', () => {
    setup();
    // live: scorched-quarter `sq-d-131`, a scripted trash bin whose `collider(ctx)` answers null
    spawn('sq-d-131', { scene: true, physics: 'static', primitive: { kind: 'scripted', script: 'scripts/gen/kit2/interior.js', params: { kind: 'trash-bin' } }, pos: { x: 2, y: 0, z: 2 } });
    spawn('tr-portal', { scene: true, physics: { body: 'static', trigger: true }, primitive: { kind: 'box', width: 2, height: 2, depth: 2 }, pos: { x: -2, y: 0, z: 2 } });
    // a scene row that was authored without a body and gets one at run time is the port's to derive
    const late = spawn('late', { scene: true, primitive: { kind: 'box', width: 1, height: 1, depth: 1 }, pos: { x: 6, y: 0, z: 6 } });
    setPhysics(late, 'static');
    port.onPhysicsWrite(late, 'static');
    port.step('home', TICK);
    expect(warnings).toEqual([]);
    expect(port.bodyRecords('home').map((r) => [r.rowId, r.sensor])).toEqual([['tr-portal', true], ['late', false]]);
    expect(hitDown(2, 2)!.id).toBe('floor');
    expect(hitDown(6, 6)!.id).toBe('late');
  });

  it('a scripted runtime row gets a stand-in box until the geometry service answers, then the real collider (X-43)', async () => {
    store = fakeStore();
    let answer: (c: { box: [number, number, number] }) => void = () => undefined;
    const asked: string[] = [];
    let known: { box: [number, number, number] } | undefined;
    const registered: string[] = [];
    port = new PhysicsPortImpl({
      host: {
        store,
        geometry: {
          colliderForSync: (spec) => { asked.push(spec.script); return spec.script === 'scripts/gen/wreck.js' ? { box: [0.45, 0.6, 0.1] } : known; },
          colliderFor: () => new Promise((resolve) => { answer = (c) => { known = c; resolve(c); }; }),
          registerColliders: (list) => { for (const e of list) registered.push(e.key); },
        },
      },
    });
    const pack = packOf('home', [FLOOR, { row: 'shard-key', box: [0.2, 0.3, 0.05] }]);
    pack.instances.pop();
    pack.runtimeKeys.push({ spec: 'scripts/gen/doorwreck.js|{}|3', key: 1 });
    port.buildPlace('home', bakeOf(pack));
    // the pack's runtime keys are handed to the geometry service at the build
    expect(registered).toEqual(['scripts/gen/doorwreck.js|{}|3']);
    spawn('stump', { physics: 'static', primitive: { kind: 'scripted', script: 'scripts/gen/wreck.js', params: {} }, pos: { x: 3, y: 0, z: 3 } });
    spawn('late', { physics: 'static', primitive: { kind: 'scripted', script: 'scripts/gen/late.js', seed: 2 }, pos: { x: -3, y: 0, z: 3 } });
    port.step('home', TICK);
    expect(hitDown(3, 3)!.distance).toBeCloseTo(9.4, 4);
    // the stand-in: a 0.5 m box
    expect(hitDown(-3, 3)).toMatchObject({ id: 'late' });
    expect(hitDown(-3, 3)!.distance).toBeCloseTo(9.5, 4);
    answer({ box: [1, 2, 1] });
    await Promise.resolve();
    await Promise.resolve();
    port.step('home', TICK);
    expect(hitDown(-3, 3)!.distance).toBeCloseTo(8, 4);
    expect(port.world('home')!.colliders.ownersOf('late')).toHaveLength(1);
  });
});

describe('physics port: what the place manager does (core places/manager.ts header)', () => {
  it('a row that changed place is re-homed by the setPosition that follows, with row.place already new', () => {
    setup();
    port.buildPlace('cellar', bakeOf(packOf('cellar', [{ ...FLOOR, at: [0, -10.5, 0] }])));
    const body = spawn('player/local', { physics: LIVE_PLAYER_PHYSICS, pos: { x: 0, y: 0.05, z: 0 } });
    for (let i = 0; i < 10; i++) tick(body);
    expect(port.world('home')!.characters).toHaveLength(1);
    body.place = 'cellar';
    port.setPosition(body, setPos(body, { x: 1, y: -9.9, z: 1 }));
    expect(port.world('home')!.characters).toHaveLength(0);
    expect(port.world('cellar')!.characters.map((c) => c.rowId)).toEqual(['player/local']);
    expect(port.world('cellar')!.characters[0]!.feet.y).toBeCloseTo(-9.9, 5);
    for (let i = 0; i < 20; i++) tick(body, 0, 0, 'cellar');
    expect(body.tf.grounded).toBe(true);
    expect(body.tf.pos.y).toBeCloseTo(-9.99, 1);
    // into a place that is not built: recorded, and made when it is
    body.place = 'attic';
    port.setPosition(body, setPos(body, { x: 0, y: 0.05, z: 0 }));
    expect(port.world('cellar')!.characters).toHaveLength(0);
    port.buildPlace('attic', bakeOf(packOf('attic', [FLOOR])));
    expect(port.world('attic')!.characters.map((c) => c.rowId)).toEqual(['player/local']);
  });

  it('a demoted place built again from the same bake: rowSpawned is repeated, a door that was open is seated open', () => {
    const bake = bakeOf(packOf('home', [FLOOR, { row: 'door', box: [0.5, 1, 0.05], at: [4.5, 1, 0], kinematic: true, mutable: true }, { row: 'terminal', box: [0.4, 1, 0.4], at: [-4, 1, 0], mutable: true }]));
    store = fakeStore();
    port = new PhysicsPortImpl({ host: { store } });
    port.buildPlace('home', bake);
    const door = spawn('door', { physics: 'kinematic', pos: { x: 4, y: 0, z: 0 } });
    const term = spawn('terminal', { physics: 'static', pos: { x: -4, y: 0, z: 0 } });
    const npc = spawn('npc', { physics: 'character', pos: { x: 0, y: 0.05, z: 0 } });
    port.setRotation(door, setRot(door, yawQuat(90)));
    setPhysics(term, 'none');
    port.onPhysicsWrite(term, 'none');
    port.step('home', TICK);
    const first = port.world('home')!;
    // demoted: resources gone, rows stay
    port.disposePlace('home');
    expect(first.freed).toBe(true);
    expect(port.bodyRecords('home')).toEqual([]);
    port.step('home', TICK);
    expect(raycast(ctx, { x: 0, y: 5, z: 0 }, DOWN)).toBeNull();
    // active again
    port.buildPlace('home', bake);
    for (const row of [door, term, npc]) port.rowSpawned(row);
    port.step('home', TICK);
    const again = port.world('home')!;
    expect(again).not.toBe(first);
    expect(again.characters.map((c) => c.rowId)).toEqual(['npc']);
    // the door: baked closed, standing open
    expect(hitDown(4.8, 0)!.id).toBe('floor');
    expect(hitDown(4, -0.8)!.id).toBe('door');
    // the terminal was closed ("none") when the place went: its pack collider is back, switched off
    expect(hitDown(-4, 0)!.id).toBe('floor');
    setPhysics(term, 'static');
    port.onPhysicsWrite(term, 'static');
    port.step('home', TICK);
    expect(hitDown(-4, 0)!.id).toBe('terminal');
  });

  it('an unload inside a tick: disposePlace first, rowDestroyed of its rows later, and nothing is left', () => {
    setup();
    const a = spawn('a', { physics: 'character' }), b = spawn('b', { physics: 'static', primitive: { kind: 'box' } });
    port.disposePlace('home');
    expect(() => { port.rowDestroyed(a); port.rowDestroyed(b); }).not.toThrow();
    expect(() => { port.setPosition(a, a.tf.pos); port.onPhysicsWrite(b, 'none'); port.setSpectating(a, true); port.applyImpulse('a', { x: 1, y: 0, z: 0 }); }).not.toThrow();
    port.step('home', TICK);
    expect(port.drainTriggerEnters()).toEqual([]);
    // a later build does not resurrect them
    port.buildPlace('home', bakeOf(packOf('home', [FLOOR])));
    expect(port.world('home')!.characters).toHaveLength(0);
  });

  it('a build over a resident place (no dispose in between) frees the old world and keeps the recorded rows', () => {
    setup();
    spawn('npc', { physics: 'character' });
    const first = port.world('home')!;
    port.buildPlace('home', bakeOf(packOf('home', [FLOOR])));
    expect(first.freed).toBe(true);
    expect(port.world('home')!.characters.map((c) => c.rowId)).toEqual(['npc']);
  });
});

describe('physics port: dynamic rows go to the dynamics backend (PH4), and nowhere without one', () => {
  function recorder(): { log: string[]; factory: () => DynamicBodies } {
    const log: string[] = [];
    const v = (p?: { x: number; y: number; z: number }): string => (p ? `${p.x},${p.y},${p.z}` : '-');
    const backend: DynamicBodies = {
      add: (row) => { log.push(`add ${row.id}`); return true; },
      remove: (row) => void log.push(`remove ${row.id}`),
      update: (row, body) => void log.push(`update ${row.id} mass ${body.mass}`),
      setEnabled: (row, on) => void log.push(`enabled ${row.id} ${on}`),
      setPosition: (row, p) => void log.push(`pos ${row.id} ${v(p)}`),
      setRotation: (row) => void log.push(`rot ${row.id}`),
      setVelocity: (row, p) => void log.push(`vel ${row.id} ${v(p)}`),
      setAngularVelocity: (row, p) => void log.push(`ang ${row.id} ${v(p)}`),
      setForce: (row, key, f) => void log.push(`force ${row.id} ${key} ${f === null ? 'null' : 'set'}`),
      applyImpulse: (id, i, a, p) => void log.push(`impulse ${id} ${v(i)} ${v(a)} ${v(p)}`),
      hold: (row, y) => void log.push(`hold ${row.id} ${y}`),
      beforeStep: () => void log.push('before'),
      afterStep: (_dt, write) => { log.push('after'); void write; },
      free: () => void log.push('free'),
    };
    return { log, factory: () => backend };
  }

  it('without a backend a dynamic row has no body: warned once, an impulse lands on nothing', () => {
    setup();
    spawn('gib-1', { physics: { body: 'dynamic', mass: 0.5 } });
    spawn('gib-2', { physics: 'dynamic' });
    expect(port.bodyRecords('home')).toEqual([]);
    expect(warnings.filter((w) => w.includes('dynamic bodies are not available'))).toHaveLength(1);
    expect(() => port.applyImpulse('gib-1', { x: 0, y: 5, z: 0 })).not.toThrow();
    expect(() => port.applyImpulse('nobody', { x: 0, y: 5, z: 0 })).not.toThrow();
  });

  it('every verb of a dynamic row reaches the backend; the step brackets it; dispose frees it', () => {
    const { log, factory } = recorder();
    store = fakeStore();
    port = new PhysicsPortImpl({ host: { store }, dynamics: factory });
    port.buildPlace('home', bakeOf(packOf('home', [FLOOR])));
    const gib = spawn('gib-1', { physics: { body: 'dynamic', mass: 0.5 }, pos: { x: 1, y: 2, z: 3 } });
    port.setPosition(gib, setPos(gib, { x: 1, y: 5, z: 3 }));
    port.setRotation(gib, setRot(gib, yawQuat(10)));
    port.setVelocity(gib, { x: 0, y: 4, z: 0 });
    port.setAngularVelocity(gib, { x: 1, y: 0, z: 0 });
    port.setForce(gib, 'surge', { force: { x: 0, y: 1, z: 0 } });
    port.setForce(gib, 'surge', null);
    port.applyImpulse('gib-1', { x: 0, y: 5, z: 0 }, undefined, { x: 1, y: 5, z: 3 });
    port.holdBody(gib, -30);
    const heavier = { body: 'dynamic', mass: 4 };
    setPhysics(gib, heavier);
    port.onPhysicsWrite(gib, heavier);
    gib.spectating = true;
    port.setSpectating(gib, true);
    port.step('home', TICK);
    port.rowDestroyed(gib);
    port.dispose();
    expect(log).toEqual([
      'add gib-1', 'pos gib-1 1,5,3', 'rot gib-1', 'vel gib-1 0,4,0', 'ang gib-1 1,0,0', 'force gib-1 surge set', 'force gib-1 surge null',
      'impulse gib-1 0,5,0 - 1,5,3', 'hold gib-1 -30', 'update gib-1 mass 4', 'enabled gib-1 false', 'before', 'after', 'remove gib-1', 'free',
    ]);
  });

  it('a backend set after the build serves the places that exist', () => {
    setup();
    const { log, factory } = recorder();
    port.setDynamics(factory);
    spawn('gib-1', { physics: 'dynamic' });
    expect(log).toEqual(['add gib-1']);
  });
});

describe('physics port: liquid (motion §5.9)', () => {
  it('a character deeper than 0.72 × its height floats at the surface; out of the water it walks as ever', () => {
    store = fakeStore();
    port = new PhysicsPortImpl({ host: { store, placeConfig: () => ({ terrain: { kind: 'heightmap', marks: { sea: { kind: 'sea', level: 0 } } } }) } });
    // the sea bed is 5 m down
    port.buildPlace('home', bakeOf(packOf('home', [{ ...FLOOR, at: [0, -5.5, 0] }])));
    const body = spawn('swimmer', { physics: LIVE_PLAYER_PHYSICS, pos: { x: 0, y: 1, z: 0 } });
    expect(port.liquidOf(body)).toBeNull();
    for (let i = 0; i < 60; i++) tick(body, 2);
    const line = -0.72 * 1.9;
    expect(body.tf.pos.y).toBeCloseTo(line, 4);
    expect(body.tf.vel.y).toBe(0);
    expect(body.tf.grounded).toBe(false);
    // horizontal motion is untouched
    expect(body.tf.vel.x).toBeCloseTo(2, 3);
    expect(port.liquidOf(body)).toEqual({ in: true, level: 0, swimming: true });
    // lifted out
    port.setPosition(body, setPos(body, { x: 0, y: 3, z: 0 }));
    setVel(body, { x: 0, y: 0, z: 0 });
    port.step('home', TICK);
    expect(port.liquidOf(body)).toEqual({ in: false, level: 0, swimming: false });
  });
});
