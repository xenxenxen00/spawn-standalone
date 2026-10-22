import { describe, expect, it } from 'vitest';
import type { RowRec, Vec3 } from '../../../src/compat/core/types.ts';
import type { SyncHost } from '../../../src/compat/physics/rapier/body-sync.ts';
import { RapierDynamics } from '../../../src/compat/physics/rapier/dynamics.ts';
import { rapier } from '../../../src/compat/physics/rapier/loader.ts';
import { normalizeBody } from '../../../src/compat/physics/spec.ts';
import { PhysicsWorld } from '../../../src/compat/physics/rapier/world.ts';
import { groupsInteract, packGroups } from '../../../src/compat/physics/defaults.ts';
import { packOf, player, quadSoup } from './rapier-fixtures.ts';

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };

function row(id: string, y: number, primitive: Record<string, unknown>, tags: string[] = ['gib']): RowRec {
  return {
    id, serial: 1, vm: 'platform', place: 'dynamics-test', explicitPlace: false, parentId: null, spawnerId: null, name: id,
    tags, template: null, spec: {}, state: {}, props: { primitive },
    tf: {
      pos: { x: 0, y, z: 0 }, rot: { ...IDENTITY }, scale: { x: 1, y: 1, z: 1 }, vel: { x: 0, y: 0, z: 0 },
      angVel: { x: 0, y: 0, z: 0 }, grounded: false, prevPos: { x: 0, y, z: 0 }, prevRot: { ...IDENTITY }, worldCacheTick: -1,
    },
    behaviors: [], audience: 'local', scope: 'session', visibility: null, simulatedBy: null, lifetimeS: null, expiresAtTick: null,
    phase: 'alive', pendingSpawnHooks: false, player: null, spectating: false, rig: null, fromScene: null, stateVer: 0, propVer: 0, handles: {},
  } as unknown as RowRec;
}

function boxPrimitive(w = 0.2, h = 0.2, d = 0.2): Record<string, unknown> {
  return { kind: 'box', width: w, height: h, depth: d };
}

function fixture(options: {
  y?: number;
  primitive?: Record<string, unknown>;
  physics?: Record<string, unknown>;
  character?: boolean;
  scripted?: SyncHost['scripted'];
  terrain?: Float32Array;
} = {}) {
  const world = new PhysicsWorld('dynamics-test');
  world.build(packOf('dynamics-test', options.terrain ? [] : [{ row: 'floor', box: [1.5, 0.5, 1.5], at: [0, -0.5, 0] }], options.terrain));
  const warnings: string[] = [];
  const writes: Array<{ pos: Vec3; vel: Vec3; grounded: boolean }> = [];
  const host: SyncHost = {
    facts: null, scripted: options.scripted ?? null, worldPose: (r) => r.tf,
    write: (r, pos, vel, grounded, rot, angVel) => {
      writes.push({ pos, vel, grounded });
      r.tf.pos = pos; r.tf.vel = vel; r.tf.grounded = grounded;
      if (rot) r.tf.rot = rot;
      if (angVel) r.tf.angVel = angVel;
    },
    warn: (message) => warnings.push(message),
  };
  const dynamics = new RapierDynamics(world, host);
  const bodyRow = row('piece', options.y ?? 3, options.primitive ?? boxPrimitive());
  const spec = options.physics ?? {
    body: 'dynamic', collider: 'box', mass: 2, friction: 0.9, restitution: 0.22, linearDamping: 0.08, angularDamping: 0.55,
    collisionGroups: { membership: 0x0008, filter: 0xfffb },
  };
  const normalized = normalizeBody(spec, bodyRow, null);
  const added = dynamics.add(bodyRow, normalized, bodyRow.tf);
  const character = options.character ? player(world, { x: 0, y: 0.01, z: 0 }, 'player') : null;
  return { world, host, dynamics, bodyRow, normalized, added, character, warnings, writes };
}

function bodyOf(f: ReturnType<typeof fixture>) {
  return f.world.colliders.ownersOf(f.bodyRow.id)[0]!.body!;
}

describe('Rapier dynamic bodies', () => {
  it('keeps the row origin at the feet while applying live damping, mass, material, CCD and groups', () => {
    const f = fixture({ y: 4 });
    expect(f.added).toBe(true);
    const body = bodyOf(f), owner = f.world.colliders.ownersOf('piece')[0]!;
    expect(body.translation()).toMatchObject({ x: 0, y: 4, z: 0 });
    expect(owner.collider.translation().y).toBeCloseTo(4.1, 5);
    expect(body.isCcdEnabled()).toBe(true);
    expect(body.linearDamping()).toBeCloseTo(0.08, 6);
    expect(body.angularDamping()).toBeCloseTo(0.55, 6);
    expect(owner.collider.mass()).toBeCloseTo(2, 6);
    expect(owner.collider.friction()).toBeCloseTo(0.9, 6);
    expect(owner.collider.restitution()).toBeCloseTo(0.22, 6);
    expect(owner.collider.collisionGroups()).toBe(packGroups(0x0008, 0xfffb));
    f.world.free();
  });

  it('creates a ball collider and gives a door shard its scripted box body before its delayed kick', () => {
    const ball = fixture({ primitive: { kind: 'sphere', radius: 0.2 }, physics: { body: 'dynamic', collider: 'sphere', mass: 0.5 } });
    expect(ball.added).toBe(true);
    expect(ball.world.colliders.ownersOf('piece')[0]!.collider.translation().y).toBeCloseTo(3.2, 5);
    ball.world.free();

    const shard = fixture({
      y: 1,
      primitive: { kind: 'scripted', script: 'scripts/gen/kit/doorwreck.js', params: { part: 'shard' } },
      physics: { body: 'dynamic', collider: 'auto', mass: 6, friction: 0.8 },
      scripted: {
        colliderForSync: () => ({ box: [0.3, 0.6, 0.1] }),
        colliderFor: async () => ({ box: [0.3, 0.6, 0.1] }),
      },
    });
    expect(shard.added).toBe(true);
    expect(shard.world.colliders.ownersOf('piece')).toHaveLength(1);
    const body = bodyOf(shard);
    for (let i = 0; i < 3; i++) shard.world.step(1 / 30);
    const before = body.translation();
    shard.dynamics.applyImpulse('piece', { x: 5, y: 3, z: 0 }, { x: 0, y: 0, z: 1 });
    for (let i = 0; i < 3; i++) shard.world.step(1 / 30);
    expect(body.translation().x).toBeGreaterThan(before.x);
    expect(body.rotation().z).not.toBe(0);
    shard.world.free();
  });

  it('lets a gib pass through a character, land on the floor and sleep within three seconds', () => {
    const f = fixture({ y: 3, character: true, terrain: quadSoup(4) });
    expect(f.added).toBe(true);
    const body = bodyOf(f);
    let landingTick = -1, landings = 0, sleepingTick = -1;
    for (let tick = 0; tick < 180; tick++) {
      const lastVy = body.linvel().y;
      f.world.step(1 / 30);
      const vy = body.linvel().y;
      if (tick >= 4 && lastVy < -1.4 && vy > -0.5) { landingTick = tick; landings++; }
      if (sleepingTick < 0 && body.isSleeping()) sleepingTick = tick;
    }
    expect(landings).toBe(1);
    expect(groupsInteract(f.world.colliders.ownersOf('piece')[0]!.collider.collisionGroups(), f.character!.groups)).toBe(false);
    expect(sleepingTick).toBeGreaterThanOrEqual(landingTick);
    expect(sleepingTick - landingTick).toBeLessThanOrEqual(90);
    expect(body.translation().y).toBeLessThan(0.03);
    expect(f.character!.feet.y).toBeGreaterThan(0.009);
    expect(f.character!.feet.y).toBeLessThan(0.011);
    f.world.free();
  });

  it('applies keyed forces until cleared and routes shard impulses to Rapier', () => {
    const f = fixture({ y: 5 });
    const body = bodyOf(f);
    f.dynamics.setForce(f.bodyRow, 'hold', { force: { x: 0, y: -2 * f.world.gravity.y, z: 0 } });
    for (let i = 0; i < 15; i++) f.world.step(1 / 30);
    expect(body.translation().y).toBeCloseTo(5, 3);
    f.dynamics.setForce(f.bodyRow, 'hold', null);
    f.dynamics.applyImpulse('piece', { x: 2, y: 3, z: 0 }, { x: 0, y: 1, z: 0 }, { x: 0, y: body.translation().y + 1, z: 0 });
    expect(body.angvel().z).not.toBe(0);
    const before = body.translation();
    for (let i = 0; i < 3; i++) f.world.step(1 / 30);
    expect(body.translation().x).toBeGreaterThan(before.x);
    expect(body.translation().y).toBeGreaterThan(before.y);
    f.dynamics.afterStep(1 / 30, f.host.write);
    expect(f.bodyRow.tf.pos).toMatchObject({ x: body.translation().x, y: body.translation().y, z: body.translation().z });
    expect(f.writes.length).toBeGreaterThan(0);
    f.world.free();
  });

  it('holds out-of-bounds bodies asleep without gravity, then restores gravity on the next write', () => {
    const f = fixture({ y: 10 });
    const body = bodyOf(f);
    f.dynamics.hold(f.bodyRow, -30);
    expect(body.translation().y).toBeCloseTo(-30, 5);
    expect(body.gravityScale()).toBe(0);
    expect(body.isSleeping()).toBe(true);
    f.dynamics.setVelocity(f.bodyRow, { x: 0, y: 0, z: 0 });
    expect(body.gravityScale()).toBeCloseTo(f.normalized.gravityScale, 6);
    expect(body.isSleeping()).toBe(false);
    f.world.free();
  });

  it('updates collider geometry and material settings without leaving stale owners', () => {
    const f = fixture();
    const before = f.world.colliders.ownersOf('piece')[0]!;
    f.bodyRow.props['primitive'] = boxPrimitive(0.4, 0.6, 0.8);
    const next = normalizeBody({
      body: 'dynamic', collider: 'box', mass: 3, friction: 0.4, restitution: 0.1,
      collisionGroups: { membership: 0x0008, filter: 0xffff },
    }, f.bodyRow, null);
    f.dynamics.update(f.bodyRow, next);
    const owners = f.world.colliders.ownersOf('piece');
    expect(owners).toHaveLength(1);
    expect(owners[0]!.handle).not.toBe(before.handle);
    expect(owners[0]!.collider.mass()).toBeCloseTo(3, 6);
    expect(owners[0]!.collider.friction()).toBeCloseTo(0.4, 6);
    f.dynamics.setEnabled(f.bodyRow, false);
    expect(owners[0]!.collider.isEnabled()).toBe(false);
    f.dynamics.setEnabled(f.bodyRow, true);
    expect(owners[0]!.collider.isEnabled()).toBe(true);
    f.world.free();
  });

  it('removes its collider owner and body on remove and free', () => {
    const f = fixture();
    const body = bodyOf(f);
    f.dynamics.remove(f.bodyRow);
    expect(body.isValid()).toBe(false);
    expect(f.world.colliders.ownersOf('piece')).toHaveLength(0);
    const second = row('second', 4, boxPrimitive());
    expect(f.dynamics.add(second, normalizeBody({ body: 'dynamic', collider: 'box' }, second, null), second.tf)).toBe(true);
    const secondBody = f.world.colliders.ownersOf('second')[0]!.body!;
    f.dynamics.free();
    expect(secondBody.isValid()).toBe(false);
    expect(f.world.colliders.ownersOf('second')).toHaveLength(0);
    f.world.free();
  });
});
