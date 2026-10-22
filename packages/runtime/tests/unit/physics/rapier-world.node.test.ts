// PhysicsWorld + colliders.ts (motion §4.3, §5.1): the pack becomes cuboid / ball / trimesh colliders with owner records,
// a ray hits right after the build (zero-length refresh step), a collider added mid-tick is hit after the step, mutable rows
// toggle, kinematic rows hang on bodies, and `free()` releases the wasm world.
import { describe, expect, it } from 'vitest';
import { CUBOID_MAX_HALF_EXTENT, DEFAULT_GRAVITY, MAX_TRIANGLE_EDGE, PACKED_CHARACTER_GROUPS } from '../../../src/compat/physics/defaults.ts';
import { TagInterner, boxFaceSoup, decomposeMat34, subdivideSoup, weldSoup } from '../../../src/compat/physics/rapier/colliders.ts';
import { rapier } from '../../../src/compat/physics/rapier/loader.ts';
import { PhysicsWorld } from '../../../src/compat/physics/rapier/world.ts';
import { centred, FLOOR, mat34, packOf, player, quadSoup, settle, worldOf } from './rapier-fixtures.ts';

const DOWN = { x: 0, y: -1, z: 0 };
const TAGS: Record<string, string[]> = { crate: ['prop', 'cover'], ball: ['prop'], door: ['door'] };

function fixture(): PhysicsWorld {
  const world = new PhysicsWorld('yard');
  world.build(packOf('yard', [
    FLOOR,
    { row: 'crate', box: [0.5, 0.5, 0.5], at: [3, 0.5, 0], axis: [0, 1, 0], deg: 30 },
    { row: 'ball', sphere: 0.5, at: [-3, 0.5, 0], scale: [2, 2, 2] },
    { row: 'roof', tris: quadSoup(1), at: [0, 3, 5] },
    { row: 'terminal', box: [0.4, 1, 0.4], at: [6, 1, 6], mutable: true },
    { row: 'door', box: [0.5, 1, 0.05], at: [-6, 1, 6], kinematic: true, mutable: true },
    { row: 'fence', box: [1, 1, 0.1], at: [0, 1, -8], noDecal: true },
  ], quadSoup(4, 0.25, 30, 0)), (row) => TAGS[row] ?? []);
  return world;
}

describe('rapier world: build and queries', () => {
  it('gravity defaults to the live places and the world steps at 1/60', () => {
    const world = new PhysicsWorld('g');
    expect(world.raw.gravity).toMatchObject(DEFAULT_GRAVITY);
    expect(world.raw.timestep).toBeCloseTo(1 / 60, 7);
    world.free();
    const moon = new PhysicsWorld('moon', { gravity: { x: 0, y: -1.6, z: 0 } });
    expect(moon.raw.gravity.y).toBeCloseTo(-1.6, 6);
    moon.free();
  });

  it('a ray right after build hits (zero-length refresh step) and the timestep is restored', () => {
    const world = fixture();
    const hit = world.castRay({ x: 0, y: 5, z: 0 }, DOWN, 30);
    expect(hit?.toi).toBeCloseTo(5, 4);
    expect(hit?.normal.y).toBeCloseTo(1, 5);
    expect(hit?.owner?.rowId).toBe('floor');
    expect(world.raw.timestep).toBeCloseTo(1 / 60, 7);
    world.free();
  });

  it('without the refresh step Rapier finds nothing (why build ends with one)', () => {
    const R = rapier();
    const raw = new R.World({ x: 0, y: -24, z: 0 });
    raw.createCollider(R.ColliderDesc.cuboid(5, 0.5, 5).setTranslation(0, -0.5, 0));
    const ray = new R.Ray({ x: 0, y: 5, z: 0 }, DOWN);
    expect(raw.castRay(ray, 30, true)).toBeNull();
    raw.timestep = 0;
    raw.step();
    expect(raw.castRay(ray, 30, true)?.timeOfImpact).toBeCloseTo(5, 4);
    raw.free();
  });

  it('every instance is one collider of the analytic kind, with its owner record', () => {
    const world = fixture();
    const R = world.R;
    const kind = (row: string): number => world.colliders.ownersOf(row)[0]!.collider.shape.type;
    // the 24 m floor slab is beyond the cuboid limit (defaults.CUBOID_MAX_HALF_EXTENT)
    expect(kind('floor')).toBe(R.ShapeType.TriMesh);
    expect(kind('crate')).toBe(R.ShapeType.Cuboid);
    expect(kind('ball')).toBe(R.ShapeType.Ball);
    expect(kind('roof')).toBe(R.ShapeType.TriMesh);
    expect(kind('terrain/yard')).toBe(R.ShapeType.TriMesh);
    // 7 instances + terrain
    expect(world.colliders.size).toBe(8);
    const crate = world.colliders.ownersOf('crate')[0]!;
    expect(crate).toMatchObject({ rowId: 'crate', kind: 'static', tags: ['prop', 'cover'], noDecal: false, mutable: false, body: null });
    expect(world.colliders.owner(crate.handle)).toBe(crate);
    expect(world.colliders.ownersOf('fence')[0]!.noDecal).toBe(true);
    expect(world.colliders.ownersOf('terminal')[0]!.mutable).toBe(true);
    // scale is folded into the shape: the 0.5 ball scaled ×2 is a 1 m ball
    expect(world.colliders.ownersOf('ball')[0]!.collider.radius()).toBeCloseTo(1, 6);
    world.free();
  });

  it('hits map to row ids, tags and terrain/<place>', () => {
    const world = fixture();
    const down = (x: number, z: number): ReturnType<PhysicsWorld['castRay']> => world.castRay({ x, y: 10, z }, DOWN, 30);
    expect(down(3, 0)?.owner?.rowId).toBe('crate');
    expect(down(3, 0)?.toi).toBeCloseTo(9, 4);
    expect(down(-3, 0)?.owner?.rowId).toBe('ball');
    expect(down(-3, 0)?.toi).toBeCloseTo(10 - 1.5, 4);
    expect(down(0, 5)?.owner?.rowId).toBe('roof');
    const terrain = down(30, 0);
    expect(terrain?.owner?.rowId).toBe('terrain/yard');
    expect(terrain?.owner?.kind).toBe('static');
    expect(terrain?.toi).toBeCloseTo(9.75, 4);
    // tags: the interned mask and the array agree
    const crate = down(3, 0)!.owner!;
    const prop = world.colliders.tags.bit('prop'), cover = world.colliders.tags.bit('cover'), door = world.colliders.tags.bit('door');
    expect(crate.tagMask & (1 << prop)).not.toBe(0);
    expect(crate.tagMask & (1 << cover)).not.toBe(0);
    expect(crate.tagMask & (1 << door)).toBe(0);
    expect(world.colliders.ownersOf('ball')[0]!.tagMask).toBe(1 << prop);
    expect(world.colliders.tags.filterMask(['prop', 'cover'])).toBe(crate.tagMask);
    world.free();
  });

  it('the rotated crate is hit where its rotated corner is, and a trimesh is two-sided for rays', () => {
    const world = fixture();
    // 30° yaw: along the x axis through its centre the box reaches 0.5 / cos30 = 0.577
    expect(world.castRay({ x: 3 + 0.56, y: 10, z: 0 }, DOWN, 30)?.owner?.rowId).toBe('crate');
    expect(world.castRay({ x: 3 + 0.6, y: 10, z: 0 }, DOWN, 30)?.owner?.rowId).toBe('floor');
    // the roof quad from below: hit, normal facing the origin
    const up = world.castRay({ x: 0, y: 1, z: 5 }, { x: 0, y: 1, z: 0 }, 30);
    expect(up?.owner?.rowId).toBe('roof');
    expect(up?.toi).toBeCloseTo(2, 4);
    expect(up?.normal.y).toBeCloseTo(-1, 5);
    // solid: a ray that starts inside a cuboid answers distance 0 on it
    expect(world.castRay({ x: 3, y: 0.5, z: 0 }, DOWN, 30)).toMatchObject({ toi: 0, owner: { rowId: 'crate' } });
    world.free();
  });

  it('a refresh after something was removed, a tick passed and something was added keeps every query alive', () => {
    // Stock Rapier 0.21: in that state a step of timestep EXACTLY 0 (the refresh motion §4.3 prescribes) leaves the query
    // structure empty until the next real step: every ray misses, the floor included, and a controller pass in between
    // would see no world (measured: 108 of 168 remove / step / add histories). A step of defaults.REFRESH_DT does not.
    // If this first half starts failing after a Rapier bump, the exact zero is safe again.
    const R = rapier();
    const raw = new R.World({ x: 0, y: -24, z: 0 });
    raw.createCollider(R.ColliderDesc.cuboid(5, 0.5, 5).setTranslation(0, -0.5, 0));
    const crate = raw.createCollider(R.ColliderDesc.cuboid(0.5, 0.5, 0.5).setTranslation(3, 0.5, 3));
    raw.timestep = 0; raw.step(); raw.timestep = 1 / 60;
    const ray = new R.Ray({ x: 0, y: 5, z: 0 }, DOWN);
    expect(raw.castRay(ray, 30, true)?.timeOfImpact).toBeCloseTo(5, 4);
    raw.removeCollider(crate, true);
    raw.step();
    raw.createCollider(R.ColliderDesc.cuboid(0.5, 0.5, 0.5).setTranslation(-3, 0.5, -3));
    raw.timestep = 0; raw.step(); raw.timestep = 1 / 60;
    expect(raw.castRay(ray, 30, true)).toBeNull();
    raw.step();
    expect(raw.castRay(ray, 30, true)?.timeOfImpact).toBeCloseTo(5, 4);
    raw.free();

    // the port, the plainest case: one row goes, a tick passes, one comes
    const plain = worldOf([FLOOR]);
    plain.colliders.addInstance({ rowId: 'crate', ...centred('c', [0.5, 0.5, 0.5], [5, 0.5, 5]) });
    plain.refresh();
    plain.colliders.removeRow('crate');
    plain.step();
    plain.colliders.addInstance({ rowId: 'crate-2', ...centred('c', [0.5, 0.5, 0.5], [7, 0.5, 7]) });
    plain.refresh();
    expect(plain.castRay({ x: -5, y: 10, z: -5 }, DOWN, 30)?.owner?.rowId).toBe('floor');
    expect(plain.castRay({ x: 7, y: 10, z: 7 }, DOWN, 30)?.owner?.rowId).toBe('crate-2');
    expect(plain.castRay({ x: 5, y: 10, z: 5 }, DOWN, 30)?.owner?.rowId).toBe('floor');
    plain.free();

    // and over histories (whether the stock step fails depends on how many steps the world has taken): a wave of rows
    // goes, some ticks pass, one comes; fixed and kinematic rows, a body standing by
    for (const kind of ['static', 'kinematic'] as const) {
      for (const crates of [1, 5, 20, 60]) {
        for (const ticksBefore of [0, 1, 2, 3, 10]) {
          for (const ticksBetween of [1, 2, 3]) {
            const world = worldOf([FLOOR]);
            const c = player(world, { x: 0, y: 0.05, z: 0 });
            for (let i = 0; i < crates; i++) world.colliders.addInstance({ rowId: `crate-${i}`, ...centred('c', [0.4, 0.4, 0.4], [-10 + (i % 10) * 2, 0.4, 4 + Math.floor(i / 10) * 2]), kind });
            world.refresh();
            settle(world, c, ticksBefore);
            for (let i = 0; i < crates; i++) world.colliders.removeRow(`crate-${i}`);
            settle(world, c, ticksBetween);
            world.colliders.addInstance({ rowId: 'new', ...centred('n', [0.4, 0.4, 0.4], [8, 0.4, -8]), kind });
            world.refresh();
            const label = `${crates} ${kind} crates, ${ticksBefore} ticks before, ${ticksBetween} between`;
            expect(world.castRay({ x: -3, y: 10, z: -3 }, DOWN, 30)?.owner?.rowId, label).toBe('floor');
            expect(world.castRay({ x: 8, y: 10, z: -8 }, DOWN, 30)?.owner?.rowId, label).toBe('new');
            // the refresh advanced nothing, and the timestep is back
            expect(world.raw.timestep, label).toBeCloseTo(1 / 60, 7);
            // the body standing there still has its floor in the very next controller pass
            settle(world, c, 30);
            for (let i = 0; i < 3; i++) {
              settle(world, c, 1);
              expect(c.grounded, label).toBe(true);
              expect(c.feet.y, label).toBeGreaterThan(0.009);
              expect(c.feet.y, label).toBeLessThan(0.011);
            }
            world.free();
          }
        }
      }
    }
  });

  it('a refresh delivers the collision events it finds instead of dropping them', () => {
    const world = worldOf([FLOOR]);
    const R = world.R;
    const events: Array<[number, number, boolean]> = [];
    world.onCollisionEvent = (a, b, started) => { events.push([a, b, started]); };
    const zone = world.colliders.addInstance({ rowId: 'zone', ...centred('z', [1, 1, 1], [6, 1, 6]), sensor: true })!;
    zone.collider.setActiveEvents(R.ActiveEvents.COLLISION_EVENTS);
    zone.collider.setActiveCollisionTypes(R.ActiveCollisionTypes.ALL);
    const c = player(world, { x: 0, y: 0.05, z: 0 });
    world.refresh();
    settle(world, c, 5);
    expect(events).toEqual([]);
    // a `feetPosition` write into the zone, then a refresh (what a crouch in the same tick runs before the controller pass)
    world.teleportCharacter(c, { x: 6, y: 0.05, z: 6 });
    world.refresh();
    expect(events).toHaveLength(1);
    expect(events[0]![2]).toBe(true);
    expect(new Set([events[0]![0], events[0]![1]])).toEqual(new Set([zone.handle, c.collider.handle]));
    // and the step after it does not report the same entry again
    settle(world, c, 3);
    expect(events).toHaveLength(1);
    world.free();
  });

  it('a collider added mid-tick is hit after the step, not before', () => {
    const world = fixture();
    const before = world.castRay({ x: 8, y: 10, z: -3 }, DOWN, 30);
    expect(before?.owner?.rowId).toBe('floor');
    world.colliders.addInstance({ rowId: 'shard-1', ...centred('shard', [0.3, 0.3, 0.3], [8, 0.3, -3]), tags: ['debris'] });
    expect(world.castRay({ x: 8, y: 10, z: -3 }, DOWN, 30)?.owner?.rowId).toBe('floor');
    world.step();
    const after = world.castRay({ x: 8, y: 10, z: -3 }, DOWN, 30);
    expect(after?.owner?.rowId).toBe('shard-1');
    expect(after?.owner?.tags).toEqual(['debris']);
    world.free();
  });

  it('mutable rows toggle with setEnabled and rebuild by remove + add', () => {
    const world = fixture();
    const at = { x: 6, y: 10, z: 6 };
    expect(world.castRay(at, DOWN, 30)?.owner?.rowId).toBe('terminal');
    world.colliders.setRowEnabled('terminal', false);
    world.step();
    expect(world.castRay(at, DOWN, 30)?.owner?.rowId).toBe('floor');
    world.colliders.setRowEnabled('terminal', true);
    world.step();
    expect(world.castRay(at, DOWN, 30)?.toi).toBeCloseTo(8, 4);
    // a `primitive` write: taller box
    world.colliders.removeRow('terminal');
    world.colliders.addInstance({ rowId: 'terminal', ...centred('t2', [0.4, 2, 0.4], [6, 2, 6]), mutable: true });
    world.step();
    expect(world.castRay(at, DOWN, 30)?.toi).toBeCloseTo(6, 4);
    expect(world.colliders.ownersOf('terminal')).toHaveLength(1);
    world.free();
  });

  it('kinematic rows hang on one kinematicPositionBased body per row and follow its targets', () => {
    const world = fixture();
    const door = world.colliders.ownersOf('door')[0]!;
    expect(door.kind).toBe('kinematic');
    expect(door.body).not.toBeNull();
    expect(door.body!.isKinematic()).toBe(true);
    const kb = world.kinematicOf('door')!;
    expect(kb.body).toBe(door.body);
    expect(world.kinematicByHandle(door.body!.handle)).toBe(kb);
    expect(world.castRay({ x: -6, y: 10, z: 6 }, DOWN, 30)?.owner?.rowId).toBe('door');
    // slide it 2 m along x in one tick
    world.setKinematicTarget(kb, { x: -4, y: 0, z: 6 }, null);
    world.step();
    expect(door.body!.translation().x).toBeCloseTo(-4, 5);
    expect(kb.pos.x).toBe(-4);
    expect(world.castRay({ x: -6, y: 10, z: 6 }, DOWN, 30)?.owner?.rowId).toBe('floor');
    expect(world.castRay({ x: -4, y: 10, z: 6 }, DOWN, 30)?.owner?.rowId).toBe('door');
    // the tick's velocity is what Rapier derives for pushing dynamic bodies: 2 m in 1/30 s
    expect(door.body!.linvel().x).toBeCloseTo(60, 3);
    world.free();
  });

  it('a kinematic collider is seated by its matrix relative to the row\'s body, wherever that body is', () => {
    const world = fixture();
    const kb = world.kinematicOf('door')!;
    const door = (x: number, z: number): ReturnType<PhysicsWorld['castRay']> => world.castRay({ x, y: 10, z }, DOWN, 30);
    // a second part of the same row (its body exists, at the first part's pose): 2 m along x, higher, yawed 90°
    world.colliders.addInstance({ rowId: 'door', ...centred('lintel', [0.5, 0.1, 0.05], [-4, 2.5, 6], [0, 1, 0], 90), kind: 'kinematic', mutable: true });
    world.refresh();
    const parts = world.colliders.ownersOf('door');
    expect(parts).toHaveLength(2);
    expect(parts[1]!.body).toBe(kb.body);
    expect(world.kinematics.filter((k) => k.rowId === 'door')).toHaveLength(1);
    expect(door(-4, 6)).toMatchObject({ owner: { rowId: 'door' } });
    expect(door(-4, 6)?.toi).toBeCloseTo(10 - 2.6, 4);
    // yawed: its 0.5 m half extent lies along z
    expect(door(-4, 6.4)?.owner?.rowId).toBe('door');
    expect(door(-3.6, 6)?.owner?.rowId).toBe('floor');
    // the body moves and turns: both parts go with it as one rigid piece (a quarter turn about the door's own origin)
    world.setKinematicTarget(kb, { x: -6, y: 0, z: 8 }, { x: 0, y: Math.SQRT1_2, z: 0, w: Math.SQRT1_2 });
    world.step();
    expect(door(-4, 6)?.owner?.rowId).toBe('floor');
    // the lintel sat at (+2, +2.4, 0) from the body (the foot of the door leaf): a +90° yaw takes +x to -z
    expect(door(-6, 6)?.owner?.rowId).toBe('door');
    expect(door(-6, 6)?.toi).toBeCloseTo(10 - 2.6, 4);
    // a body made first at the ROW's pose (PH3's kinematic.ts, a door hinge): the collider still lands where its matrix says
    world.createKinematicBody('gate', { x: 10, y: 0, z: 10 }, { x: 0, y: 0, z: 0, w: 1 });
    world.colliders.addInstance({ rowId: 'gate', ...centred('leaf', [0.5, 1, 0.05], [10.5, 1, 10]), kind: 'kinematic' });
    world.refresh();
    expect(door(10.9, 10)?.owner?.rowId).toBe('gate');
    expect(door(10.9, 10)?.toi).toBeCloseTo(8, 4);
    expect(door(9.9, 10)?.owner?.rowId).toBe('floor');
    // a collider swapped while the body is away from where it was built (X-43: the door wrecks) follows the same rule
    world.colliders.removeRow('gate');
    world.setKinematicTarget(world.kinematicOf('gate')!, { x: 10, y: 0, z: 6 }, null);
    world.step();
    world.colliders.addInstance({ rowId: 'gate', ...centred('wreck', [0.3, 0.2, 0.3], [10.5, 0.2, 6]), kind: 'kinematic' });
    world.refresh();
    expect(door(10.5, 6)?.owner?.rowId).toBe('gate');
    expect(door(10.5, 6)?.toi).toBeCloseTo(10 - 0.4, 4);
    world.free();
  });

  it('characters get an owner record and leave it when removed', () => {
    const world = fixture();
    const c = world.addCharacter({ rowId: 'player-1', feet: { x: 0, y: 0.02, z: 3 }, height: 1.9, radius: 0.35, tags: ['player'] });
    const rec = world.colliders.owner(c.collider.handle)!;
    expect(rec).toMatchObject({ rowId: 'player-1', kind: 'character', tags: ['player'] });
    expect(world.characterOfCollider(c.collider.handle)).toBe(c);
    // capsule(h/2 - r, r) centred h/2 above the feet
    expect(c.collider.halfHeight()).toBeCloseTo(0.6, 6);
    expect(c.collider.translation().y).toBeCloseTo(0.02 + 0.95, 5);
    world.step();
    expect(world.castRay({ x: 0, y: 10, z: 3 }, DOWN, 30)?.owner?.rowId).toBe('player-1');
    world.removeCharacter(c);
    world.step();
    expect(world.castRay({ x: 0, y: 10, z: 3 }, DOWN, 30)?.owner?.rowId).toBe('floor');
    expect(world.colliders.ownersOf('player-1')).toHaveLength(0);
    world.free();
  });

  it('crouch swaps the capsule on the same collider with the feet planted; spectating leaves every query', () => {
    const world = worldOf([FLOOR]);
    const c = player(world, { x: 0, y: 0.5, z: 0 });
    settle(world, c);
    const feetY = c.feet.y;
    const handle = c.collider.handle;
    world.setCapsule(c, 1.2, 0.35);
    world.step();
    expect(c.collider.handle).toBe(handle);
    expect(c.collider.halfHeight()).toBeCloseTo(0.25, 6);
    expect(c.collider.radius()).toBeCloseTo(0.35, 6);
    expect(c.collider.translation().y - c.feet.y).toBeCloseTo(0.6, 5);
    settle(world, c, 5);
    expect(c.feet.y).toBeCloseTo(feetY, 3);
    expect(c.grounded).toBe(true);
    // the top of the crouched capsule is 1.2 above the feet
    expect(world.castRay({ x: 0, y: 5, z: 0 }, DOWN, 30)?.toi).toBeCloseTo(5 - (c.feet.y + 1.2), 3);
    world.setCharacterEnabled(c, false);
    world.step();
    expect(world.castRay({ x: 0, y: 5, z: 0 }, DOWN, 30)?.owner?.rowId).toBe('floor');
    world.setCharacterEnabled(c, true);
    world.step();
    expect(world.castRay({ x: 0, y: 5, z: 0 }, DOWN, 30)?.owner?.rowId).toBe('player-1');
    world.free();
  });

  it('teleport: no sweep, ground contact cleared, visible to the next step', () => {
    const world = worldOf([FLOOR, { row: 'wall', box: [0.2, 2, 4], at: [2, 2, 0] }]);
    const c = player(world, { x: 0, y: 0.5, z: 0 });
    settle(world, c);
    expect(c.grounded).toBe(true);
    world.teleportCharacter(c, { x: 5, y: 3, z: 0 });
    expect(c.grounded).toBe(false);
    expect(c.feet).toEqual({ x: 5, y: 3, z: 0 });
    settle(world, c, 1);
    expect(c.feet.x).toBeCloseTo(5, 5);
    expect(c.feet.y).toBeCloseTo(3 - 24 / 900, 3);
    settle(world, c, 40);
    expect(c.grounded).toBe(true);
    expect(c.feet.x).toBeCloseTo(5, 3);
    world.free();
  });

  it('free() releases the world once; it is unbuilt afterwards', () => {
    const world = fixture();
    const raw = world.raw;
    world.free();
    expect(world.freed).toBe(true);
    expect(world.built).toBe(false);
    expect(world.castRay({ x: 0, y: 5, z: 0 }, DOWN, 30)).toBeNull();
    expect(world.colliders.size).toBe(0);
    // the wasm object is gone: any call on it now fails
    expect(() => raw.step()).toThrow();
    expect(() => world.free()).not.toThrow();
  });

  it('many worlds can be built and freed (one per resident place)', () => {
    for (let i = 0; i < 30; i++) {
      const world = fixture();
      player(world, { x: 0, y: 1, z: 0 });
      world.step();
      world.free();
    }
  });
});

describe('collider helpers', () => {
  it('weldSoup shares exact-equal vertices', () => {
    const w = weldSoup(quadSoup(1));
    expect(w.vertices.length).toBe(4 * 3);
    expect(Array.from(w.indices)).toEqual([0, 1, 2, 0, 3, 1]);
    const tris = quadSoup(1);
    for (let i = 0; i < 6; i++) for (let k = 0; k < 3; k++) expect(w.vertices[w.indices[i]! * 3 + k]).toBe(tris[i * 3 + k]);
  });

  it('decomposeMat34 returns translation, rotation and scale; shear and mirrors are flagged', () => {
    const p = decomposeMat34(mat34([1, 2, 3], [0, 1, 0], 90, [2, 3, 4]));
    expect(p.t).toEqual({ x: 1, y: 2, z: 3 });
    expect(p.s.x).toBeCloseTo(2, 5); expect(p.s.y).toBeCloseTo(3, 5); expect(p.s.z).toBeCloseTo(4, 5);
    expect(p.q.y).toBeCloseTo(Math.SQRT1_2, 5); expect(p.q.w).toBeCloseTo(Math.SQRT1_2, 5);
    expect(p.rigid).toBe(true);
    expect(decomposeMat34([1, 0, 0, 0.5, 1, 0, 0, 0, 1, 0, 0, 0]).rigid).toBe(false);
    const mirrored = decomposeMat34([-1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
    expect(mirrored.s.x).toBe(-1);
    expect(Math.abs(mirrored.q.x) + Math.abs(mirrored.q.y) + Math.abs(mirrored.q.z)).toBe(0);
    expect(mirrored.q.w).toBe(1);
  });

  it('a sheared trimesh instance is baked with its whole matrix', () => {
    const world = new PhysicsWorld('shear');
    // x' = x + 0.5·y: the quad at local y = 2 lands 1 m further along x
    world.build(packOf('shear', []));
    world.colliders.addInstance({ rowId: 'lean', shape: { id: 'q', tris: quadSoup(1, 2) }, m: [1, 0, 0, 0.5, 1, 0, 0, 0, 1, 0, 0, 0] });
    world.refresh();
    expect(world.castRay({ x: 1.9, y: 10, z: 0 }, DOWN, 30)?.owner?.rowId).toBe('lean');
    expect(world.castRay({ x: -0.1, y: 10, z: 0 }, DOWN, 30)).toBeNull();
    world.free();
  });

  it('subdivideSoup cuts long edges without cracks and keeps the surface', () => {
    const area = (s: Float32Array): number => {
      let a = 0;
      for (let i = 0; i < s.length; i += 9) {
        const ux = s[i + 3]! - s[i]!, uy = s[i + 4]! - s[i + 1]!, uz = s[i + 5]! - s[i + 2]!;
        const vx = s[i + 6]! - s[i]!, vy = s[i + 7]! - s[i + 1]!, vz = s[i + 8]! - s[i + 2]!;
        a += Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2;
      }
      return a;
    };
    const box = boxFaceSoup(20, 0.5, 7);
    expect(box.length).toBe(12 * 9);
    expect(subdivideSoup(box, 100)).toBe(box);
    const cut = subdivideSoup(box, MAX_TRIANGLE_EDGE);
    expect(cut.length).toBeGreaterThan(box.length);
    expect(area(cut)).toBeCloseTo(area(box), 3);
    let longest = 0;
    for (let i = 0; i < cut.length; i += 9) {
      for (let e = 0; e < 3; e++) {
        const a = i + e * 3, b = i + ((e + 1) % 3) * 3;
        longest = Math.max(longest, Math.hypot(cut[b]! - cut[a]!, cut[b + 1]! - cut[a + 1]!, cut[b + 2]! - cut[a + 2]!));
      }
    }
    expect(longest).toBeLessThanOrEqual(MAX_TRIANGLE_EDGE);
    // a closed surface stays closed: after welding every edge has exactly one opposite twin (no T-junction)
    const w = weldSoup(cut);
    const edges = new Map<string, number>();
    for (let i = 0; i < w.indices.length; i += 3) {
      for (let e = 0; e < 3; e++) {
        const a = w.indices[i + e]!, b = w.indices[i + ((e + 1) % 3)]!;
        edges.set(`${a}>${b}`, (edges.get(`${a}>${b}`) ?? 0) + 1);
      }
    }
    for (const [key, n] of edges) {
      const [a, b] = key.split('>');
      expect(n).toBe(1);
      expect(edges.get(`${b}>${a}`)).toBe(1);
    }
  });

  it('a box beyond the cuboid limit becomes a trimesh of its faces, a small one stays a cuboid', () => {
    const big = CUBOID_MAX_HALF_EXTENT + 8;
    const world = worldOf([{ row: 'ground', box: [big, 0.5, 6], at: [0, -0.5, 0] }, { row: 'crate', box: [CUBOID_MAX_HALF_EXTENT, 0.5, 1], at: [0, 0.5, 20] }]);
    expect(world.colliders.ownersOf('ground')[0]!.collider.shape.type).toBe(world.R.ShapeType.TriMesh);
    expect(world.colliders.ownersOf('ground')[0]!.triangles).toBeGreaterThan(12);
    expect(world.colliders.ownersOf('crate')[0]!.collider.shape.type).toBe(world.R.ShapeType.Cuboid);
    const hit = world.castRay({ x: big - 1, y: 5, z: 3 }, DOWN, 30);
    expect(hit?.owner?.rowId).toBe('ground');
    expect(hit?.toi).toBeCloseTo(5, 4);
    expect(hit?.normal.y).toBeCloseTo(1, 5);
    // the faces point outwards: from the side the hit normal faces the ray
    const side = world.castRay({ x: 0, y: -0.5, z: 10 }, { x: 0, y: 0, z: -1 }, 30);
    expect(side?.toi).toBeCloseTo(4, 4);
    expect(side?.normal.z).toBeCloseTo(1, 5);
    world.free();
  });

  it('why: the stock controller sinks into a large cuboid floor, and on the port\'s floor of the same box the feet rest at the offset', () => {
    // The price of this is on the bench (tools/physics/bench.ts: a trimesh wall costs a pressing character more than a
    // cuboid wall). If the first half of this test starts failing after a Rapier bump, cuboid floors are safe again and
    // defaults.CUBOID_MAX_HALF_EXTENT can go.
    const R = rapier();
    const groups = PACKED_CHARACTER_GROUPS;
    /** lowest feet height of the player capsule standing 200 ticks at (x, z) on a 24 × 1 × 24 m cuboid, stock Rapier */
    const stock = (x: number, z: number, y0: number): number => {
      const w = new R.World({ x: 0, y: -24, z: 0 });
      w.createCollider(R.ColliderDesc.cuboid(12, 0.5, 12).setTranslation(0, -0.5, 0));
      w.timestep = 0; w.step(); w.timestep = 1 / 60;
      const kcc = w.createCharacterController(0.01);
      kcc.setUp({ x: 0, y: 1, z: 0 });
      kcc.enableAutostep(0.4, 0.2, false);
      kcc.setMaxSlopeClimbAngle((52 * Math.PI) / 180); kcc.setMinSlopeSlideAngle((62 * Math.PI) / 180);
      kcc.enableSnapToGround(0.3);
      const body = w.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(x, y0, z));
      const col = w.createCollider(R.ColliderDesc.capsule(0.6, 0.35).setTranslation(0, 0.95, 0).setCollisionGroups(groups), body);
      let vy = 0, low = Infinity;
      for (let i = 0; i < 200; i++) {
        vy += -24 / 30;
        kcc.computeColliderMovement(col, { x: 0, y: vy / 30, z: 0 }, R.QueryFilterFlags.EXCLUDE_SENSORS | R.QueryFilterFlags.EXCLUDE_DYNAMIC, groups);
        const m = kcc.computedMovement();
        const t = body.translation();
        body.setNextKinematicTranslation({ x: t.x, y: t.y + m.y / 2, z: t.z }); w.step();
        body.setNextKinematicTranslation({ x: t.x, y: t.y + m.y, z: t.z }); w.step();
        vy = kcc.computedGrounded() && m.y > 0 ? 0 : m.y * 30;
        if (i > 40) low = Math.min(low, body.translation().y);
      }
      w.free();
      return low;
    };
    const spots: Array<[number, number]> = [[0, 0], [3.72, 3.72]];
    const drops = [0.3, 0.5, 1, 2];
    let stockLowest = Infinity;
    for (const [x, z] of spots) for (const y0 of drops) stockLowest = Math.min(stockLowest, stock(x, z, y0));
    // measured 0.21.0: -0.96 m on the centre line, -58 m (through the slab) on the diagonal
    expect(stockLowest).toBeLessThan(-0.3);
    // the same box through colliders.ts, the same spots and drops
    for (const [x, z] of spots) {
      for (const y0 of drops) {
        const world = worldOf([FLOOR]);
        expect(world.colliders.ownersOf('floor')[0]!.collider.shape.type).toBe(world.R.ShapeType.TriMesh);
        const c = player(world, { x, y: y0, z });
        settle(world, c, 40);
        for (let i = 0; i < 160; i++) {
          settle(world, c, 1);
          expect(c.feet.y).toBeGreaterThan(0.009);
          expect(c.feet.y).toBeLessThan(0.011);
          expect(c.grounded).toBe(true);
        }
        world.free();
      }
    }
  });

  it('a scaled trimesh instance is cut at its world size', () => {
    const world = new PhysicsWorld('scaled');
    world.build(packOf('scaled', [{ row: 'pad', tris: quadSoup(1), scale: [10, 1, 10] }, { row: 'tile', tris: quadSoup(0.5), at: [40, 0, 0] }]));
    expect(world.colliders.ownersOf('tile')[0]!.triangles).toBe(2);
    expect(world.colliders.ownersOf('pad')[0]!.triangles).toBeGreaterThan(100);
    expect(world.castRay({ x: 9.5, y: 3, z: -9.5 }, DOWN, 30)?.owner?.rowId).toBe('pad');
    world.free();
  });

  it('TagInterner: 32 bits, then the tag arrays', () => {
    const t = new TagInterner();
    expect(t.unknown('a')).toBe(true);
    for (let i = 0; i < 32; i++) expect(t.bit(`t${i}`)).toBe(i);
    expect(t.bit('t5')).toBe(5);
    expect(t.bit('overflow')).toBe(-1);
    expect(t.mask(['t0', 't31', 'overflow'])).toBe((1 | (1 << 31)) >>> 0);
    expect(t.filterMask(['t1'])).toBe(2);
    expect(t.filterMask(['overflow'])).toBeNull();
    expect(t.unknown('overflow')).toBe(false);
  });
});
