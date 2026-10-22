// Collision groups (D-MPN-09, motion §5.13): `(membership << 16) | filter`, characters members of 0x0004 only, gibs
// `{0x0008, 0xfffb}` "so gibs never touch a character" (scripts/gore/gore.js:499). The truth table is checked on the packing
// helper and on a Rapier world: solver contacts, the controller's `filterGroups` and query `filterGroups`. Also here: what
// the controller ignores (defaults.KCC_QUERY_FLAGS) and the `QueryFilterFlags` values the port relies on.
import { describe, expect, it } from 'vitest';
import {
  CHARACTER_GROUPS, DEFAULT_GROUPS, GROUP_CHARACTER, KCC_DEFAULTS, KCC_QUERY_FLAGS, PACKED_CHARACTER_GROUPS, PACKED_DEFAULT_GROUPS,
  groupsInteract, kccKey, kccParams, packCollisionGroups, packGroups, queryFlags, unpackGroups,
} from '../../../src/compat/physics/defaults.ts';
import { rapier } from '../../../src/compat/physics/rapier/loader.ts';
import type { PhysicsWorld } from '../../../src/compat/physics/rapier/world.ts';
import { centred, FLOOR, GRAVITY, PLAYER_KCC, TICK, mat34, player, settle, stepWith, worldOf } from './rapier-fixtures.ts';

const GIB = packGroups(0x0008, 0xfffb);

describe('groups: the packing helper', () => {
  it('packs membership high, filter low, both 16-bit, unsigned', () => {
    expect(packGroups(0x0004, 0xffff)).toBe(0x0004ffff);
    expect(packGroups(0xffff, 0xffff)).toBe(0xffffffff);
    expect(packGroups(0x8000, 0x0001)).toBe(0x80000001);
    expect(packGroups(0x1ffff, 0x2fffb)).toBe(0xfffffffb);
    expect(GIB).toBe(0x0008fffb);
    expect(unpackGroups(GIB)).toEqual({ membership: 0x0008, filter: 0xfffb });
    expect(packCollisionGroups(DEFAULT_GROUPS)).toBe(PACKED_DEFAULT_GROUPS);
    expect(packCollisionGroups(CHARACTER_GROUPS)).toBe(PACKED_CHARACTER_GROUPS);
    expect(PACKED_CHARACTER_GROUPS).toBe(0x0004ffff);
    expect(GROUP_CHARACTER).toBe(0x0004);
  });

  it('truth table: two colliders interact when each membership meets the other filter', () => {
    const world = PACKED_DEFAULT_GROUPS, character = PACKED_CHARACTER_GROUPS, gib = GIB;
    const table: Array<[string, number, number, boolean]> = [
      ['world × world', world, world, true],
      ['world × character', world, character, true],
      ['character × character', character, character, true],
      ['world × gib', world, gib, true],
      ['gib × gib', gib, gib, true],
      ['gib × character', gib, character, false],
      ['character × gib', character, gib, false],
      ['member of nothing', packGroups(0, 0xffff), world, false],
      ['meets nothing', packGroups(0xffff, 0), world, false],
      ['disjoint bits', packGroups(0x0001, 0x0002), packGroups(0x0001, 0x0002), false],
      ['one-way filter', packGroups(0x0001, 0x0002), packGroups(0x0002, 0x0004), false],
      ['matching pair', packGroups(0x0001, 0x0002), packGroups(0x0002, 0x0001), true],
    ];
    for (const [name, a, b, want] of table) {
      expect(groupsInteract(a, b), name).toBe(want);
      expect(groupsInteract(b, a), `${name} (swapped)`).toBe(want);
    }
  });

  it('Rapier agrees with the helper on every row (solver contact test of two overlapping balls)', () => {
    const R = rapier();
    const rows = [PACKED_DEFAULT_GROUPS, PACKED_CHARACTER_GROUPS, GIB, packGroups(0x0001, 0x0002), packGroups(0x0002, 0x0001), packGroups(0, 0xffff)];
    for (const a of rows) {
      for (const b of rows) {
        const raw = new R.World({ x: 0, y: 0, z: 0 });
        const ba = raw.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(0, 0, 0));
        const bb = raw.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(0.5, 0, 0));
        raw.createCollider(R.ColliderDesc.ball(0.5).setCollisionGroups(a), ba);
        raw.createCollider(R.ColliderDesc.ball(0.5).setCollisionGroups(b), bb);
        for (let i = 0; i < 10; i++) raw.step();
        // overlapping balls are pushed apart only when their groups interact
        const apart = bb.translation().x - ba.translation().x > 0.6;
        expect(apart, `${a.toString(16)} × ${b.toString(16)}`).toBe(groupsInteract(a, b));
        raw.free();
      }
    }
  });
});

/** a floor, a character standing on it, and helpers to add raw dynamic bodies */
function arena(): { world: PhysicsWorld; drop: (x: number, y: number, groups: number, r?: number) => { y: () => number; x: () => number } } {
  const world = worldOf([FLOOR]);
  const R = world.R;
  return {
    world,
    drop: (x, y, groups, r = 0.15) => {
      const body = world.raw.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(x, y, 0).setCcdEnabled(true));
      world.raw.createCollider(R.ColliderDesc.ball(r).setCollisionGroups(groups), body);
      return { y: () => body.translation().y, x: () => body.translation().x };
    },
  };
}

describe('groups: on a Rapier world', () => {
  it('contacts: a gib {0x0008, 0xfffb} falls through a character capsule to the floor, a default ball lands on its head', () => {
    const { world, drop } = arena();
    const a = player(world, { x: 0, y: 0.05, z: 0 }, 'a');
    const b = player(world, { x: 3, y: 0.05, z: 0 }, 'b');
    settle(world, a);
    const gib = drop(0, 3, GIB);
    const ball = drop(3, 3, PACKED_DEFAULT_GROUPS);
    for (let i = 0; i < 90; i++) {
      for (const c of [a, b]) { c.desiredVelocity.x = 0; c.desiredVelocity.y = c.velocity.y + GRAVITY * TICK; c.desiredVelocity.z = 0; }
      world.step(TICK);
    }
    // the gib rests on the floor, inside the capsule's footprint: it never touched the character
    expect(gib.y()).toBeCloseTo(0.15, 1);
    expect(Math.abs(gib.x())).toBeLessThan(0.05);
    // the default ball met the capsule: it is not on the floor under the character
    expect(Math.abs(ball.x() - 3) > 0.3 || ball.y() > 1.5).toBe(true);
    // and neither moved the character (kinematic)
    expect(a.feet.x).toBeCloseTo(0, 3);
    expect(b.feet.x).toBeCloseTo(3, 3);
    world.free();
  });

  it('controller filterGroups: a character walks through a collider it does not interact with and is stopped by one it does', () => {
    const world = worldOf([FLOOR]);
    world.colliders.addInstance({ rowId: 'ghost-wall', ...centred('w', [0.2, 1.5, 1.5], [2, 1.5, 0]), groups: GIB });
    world.colliders.addInstance({ rowId: 'wall', ...centred('w', [0.2, 1.5, 1.5], [5, 1.5, 0]) });
    world.refresh();
    const c = player(world, { x: 0, y: 0.05, z: 0 });
    settle(world, c);
    for (let i = 0; i < 45; i++) stepWith(world, c, { x: 5, y: c.velocity.y + GRAVITY * TICK, z: 0 });
    // through the gib-group wall at x = 2, stopped one offset before the default one at x = 4.8
    expect(c.feet.x).toBeGreaterThan(4.8 - 0.35 - 0.03);
    expect(c.feet.x).toBeLessThan(4.8 - 0.35);
    // a body with its own groups uses THEM as the controller filter: member of 0x0008 with the gib filter is stopped too
    const odd = world.addCharacter({ rowId: 'odd', feet: { x: 0, y: 0.05, z: 1 }, height: 1.9, radius: 0.35, params: PLAYER_KCC, groups: packGroups(0x0010, 0xffff) });
    settle(world, odd);
    for (let i = 0; i < 30; i++) stepWith(world, odd, { x: 5, y: odd.velocity.y + GRAVITY * TICK, z: 0 });
    expect(odd.feet.x).toBeLessThan(1.8 - 0.35);
    world.free();
  });

  it('query filterGroups: a ray with the character groups does not see a gib-group collider, a gib ray does not see a character', () => {
    const world = worldOf([FLOOR]);
    world.colliders.addInstance({ rowId: 'gib-box', ...centred('g', [0.5, 0.5, 0.5], [0, 0.5, 4]), groups: GIB });
    const c = player(world, { x: 0, y: 0.05, z: -4 }, 'player-1');
    world.step(TICK);
    const down = { x: 0, y: -1, z: 0 };
    const over = (z: number, groups?: number): string | null | undefined => world.castRay({ x: 0, y: 10, z }, down, 30, undefined, groups)?.owner?.rowId;
    // no filter: everything is seen
    expect(over(4)).toBe('gib-box');
    expect(over(-4)).toBe('player-1');
    // as a character (0x0004 / 0xffff): the gib box (filter 0xfffb) is not there
    expect(over(4, PACKED_CHARACTER_GROUPS)).toBe('floor');
    expect(over(-4, PACKED_CHARACTER_GROUPS)).toBe('player-1');
    // as a gib: the character is not there, the gib box and the world are
    expect(over(-4, GIB)).toBe('floor');
    expect(over(4, GIB)).toBe('gib-box');
    // membership-only probes
    expect(over(-4, packGroups(0xffff, GROUP_CHARACTER))).toBe('player-1');
    expect(over(-4, packGroups(0xffff, 0xffff & ~GROUP_CHARACTER))).toBe('floor');
    void c;
    world.free();
  });
});

describe('groups: what the controller ignores', () => {
  it('QueryFilterFlags values the port relies on (the 0.21 doc comments on KINEMATIC / DYNAMIC are swapped)', () => {
    const F = rapier().QueryFilterFlags;
    expect(F.EXCLUDE_FIXED).toBe(1);
    expect(F.EXCLUDE_KINEMATIC).toBe(2);
    expect(F.EXCLUDE_DYNAMIC).toBe(4);
    expect(F.EXCLUDE_SENSORS).toBe(8);
    expect(F.EXCLUDE_SOLIDS).toBe(16);
    expect(F.ONLY_DYNAMIC).toBe(3);
    expect(F.ONLY_KINEMATIC).toBe(5);
    expect(F.ONLY_FIXED).toBe(6);
    expect(KCC_QUERY_FLAGS).toEqual(['EXCLUDE_SENSORS', 'EXCLUDE_DYNAMIC']);
    expect(queryFlags(F, KCC_QUERY_FLAGS)).toBe(12);
  });

  it('the flag VALUES mean what their names say: rays against a fixed, a kinematic and a dynamic collider', () => {
    const world = worldOf([FLOOR, { row: 'door', box: [0.5, 0.5, 0.5], at: [3, 0.5, 0], kinematic: true }]);
    const R = world.R;
    const body = world.raw.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(-3, 0.5, 0).setGravityScale(0));
    const dyn = world.raw.createCollider(R.ColliderDesc.cuboid(0.5, 0.5, 0.5), body);
    world.colliders.adopt(dyn, body, { rowId: 'gib', kind: 'dynamic' });
    world.refresh();
    const F = R.QueryFilterFlags;
    const see = (x: number, flags: number): string | null | undefined => world.castRay({ x, y: 10, z: 0 }, { x: 0, y: -1, z: 0 }, 30, flags)?.owner?.rowId;
    expect(see(3, 0)).toBe('door');
    expect(see(-3, 0)).toBe('gib');
    expect(see(3, F.EXCLUDE_KINEMATIC)).toBe('floor');
    expect(see(-3, F.EXCLUDE_KINEMATIC)).toBe('gib');
    expect(see(-3, F.EXCLUDE_DYNAMIC)).toBe('floor');
    expect(see(3, F.EXCLUDE_DYNAMIC)).toBe('door');
    expect(see(-3, F.ONLY_DYNAMIC)).toBe('gib');
    expect(see(3, F.ONLY_DYNAMIC)).toBeUndefined();
    expect(see(0, F.ONLY_DYNAMIC)).toBeUndefined();
    expect(see(3, F.ONLY_FIXED)).toBe('floor');
    expect(see(-3, F.ONLY_FIXED)).toBe('floor');
    expect(see(0, F.EXCLUDE_FIXED)).toBeUndefined();
    world.free();
  });

  it('a dynamic body in the path does not stop a character (EXCLUDE_DYNAMIC), a kinematic one does', () => {
    const world = worldOf([FLOOR, { row: 'door', box: [0.2, 1, 1], at: [6, 1, 0], kinematic: true }]);
    const R = world.R;
    // a heavy crate resting in the lane
    const crate = world.raw.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(2.5, 0.4, 0));
    world.raw.createCollider(R.ColliderDesc.cuboid(0.4, 0.4, 0.4).setDensity(50), crate);
    const c = player(world, { x: 0, y: 0.05, z: 0 });
    settle(world, c);
    let slowest = Infinity;
    for (let i = 0; i < 20; i++) {
      const v = stepWith(world, c, { x: 5, y: c.velocity.y + GRAVITY * TICK, z: 0 });
      slowest = Math.min(slowest, v.x);
    }
    // walked straight through where the crate stood, at pace (the solver shoves the crate, the controller ignores it)
    expect(slowest).toBeGreaterThan(4.8);
    expect(c.feet.x).toBeGreaterThan(3.2);
    for (let i = 0; i < 30; i++) stepWith(world, c, { x: 5, y: c.velocity.y + GRAVITY * TICK, z: 0 });
    // the kinematic door at x = 5.8 stops it
    expect(c.feet.x).toBeLessThan(5.8 - 0.35);
    expect(c.feet.x).toBeGreaterThan(5.8 - 0.35 - 0.03);
    world.free();
  });

  it('a sensor collider does not stop a character (EXCLUDE_SENSORS)', () => {
    const world = worldOf([FLOOR]);
    world.colliders.addInstance({ rowId: 'portal', ...centred('p', [0.3, 1.5, 1.5], [2, 1.5, 0]), sensor: true });
    world.refresh();
    expect(world.colliders.ownersOf('portal')[0]!.sensor).toBe(true);
    const c = player(world, { x: 0, y: 0.05, z: 0 });
    settle(world, c);
    for (let i = 0; i < 30; i++) {
      const v = stepWith(world, c, { x: 5, y: c.velocity.y + GRAVITY * TICK, z: 0 });
      expect(v.x).toBeGreaterThan(4.8);
    }
    expect(c.feet.x).toBeGreaterThan(4.5);
    world.free();
  });
});

describe('controller parameter sets', () => {
  it('D-MPN-08 defaults, not Rapier\'s (autostep and snap are off there)', () => {
    expect(KCC_DEFAULTS).toEqual({
      offset: 0.01, autostep: { maxHeight: 0.4, minWidth: 0.2, includeDynamic: false }, maxSlopeClimb: Math.PI / 4, minSlopeSlide: Math.PI / 4,
      slide: true, snapToGround: 0.3, normalNudge: 1e-4,
    });
    const R = rapier();
    const raw = new R.World({ x: 0, y: -24, z: 0 });
    const stock = raw.createCharacterController(0.01);
    expect(stock.autostepEnabled()).toBe(false);
    expect(stock.snapToGroundEnabled()).toBe(false);
    expect(stock.normalNudgeFactor()).toBeCloseTo(1e-4, 8);
    raw.free();
  });

  it('one Rapier controller per distinct parameter set, configured from it', () => {
    const world = worldOf([FLOOR]);
    const p1 = player(world, { x: 0, y: 0.05, z: 0 }, 'p1');
    const p2 = player(world, { x: 2, y: 0.05, z: 0 }, 'p2');
    const e1 = world.addCharacter({ rowId: 'e1', feet: { x: 4, y: 0.05, z: 0 }, height: 1.8, radius: 0.34 });
    const boss = world.addCharacter({ rowId: 'boss', feet: { x: 6, y: 0.05, z: 0 }, height: 3, radius: 0.6, params: kccParams({ autostep: null, snapToGround: null, slide: false }) });
    expect(p1.controller).toBe(p2.controller);
    expect(e1.controller).not.toBe(p1.controller);
    expect(world.controllerCount).toBe(3);
    expect(kccKey(p1.params)).toBe(kccKey(PLAYER_KCC));
    expect(p1.controller.offset()).toBeCloseTo(0.01, 6);
    expect(p1.controller.autostepMaxHeight()).toBeCloseTo(0.4, 6);
    expect(p1.controller.autostepMinWidth()).toBeCloseTo(0.2, 6);
    expect(p1.controller.autostepIncludesDynamicBodies()).toBe(false);
    expect(p1.controller.maxSlopeClimbAngle()).toBeCloseTo((52 * Math.PI) / 180, 6);
    expect(p1.controller.minSlopeSlideAngle()).toBeCloseTo((62 * Math.PI) / 180, 6);
    expect(p1.controller.snapToGroundDistance()).toBeCloseTo(0.3, 6);
    expect(p1.controller.slideEnabled()).toBe(true);
    expect(p1.controller.up()).toMatchObject({ x: 0, y: 1, z: 0 });
    expect(p1.controller.applyImpulsesToDynamicBodies()).toBe(false);
    expect(p1.controller.characterMass()).toBeNull();
    expect(e1.controller.maxSlopeClimbAngle()).toBeCloseTo(Math.PI / 4, 6);
    expect(e1.controller.snapToGroundDistance()).toBeCloseTo(0.3, 6);
    expect(boss.controller.autostepEnabled()).toBe(false);
    expect(boss.controller.snapToGroundEnabled()).toBe(false);
    expect(boss.controller.slideEnabled()).toBe(false);
    // characters are members of 0x0004 only
    expect(p1.collider.collisionGroups()).toBe(0x0004ffff);
    expect(e1.groups).toBe(PACKED_CHARACTER_GROUPS);
    world.free();
  });
});
