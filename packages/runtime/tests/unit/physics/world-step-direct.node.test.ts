// DR-51 (1): PhysicsWorld's substeps call the physics pipeline directly (world.ts `stepPipeline`) instead of `World.step`,
// which in rapier.js 0.21 is the same pipeline call followed by `mapNewSoftBodies()` (a walk over every handle that only
// matters for soft-body tears). The arena place (characters walking into walls, the crate and each other, one spectating, a
// swinging kinematic door, falling and pushed dynamic balls, bodies added and removed mid-run, a sensor the characters
// cross, a teleport) is built twice; the twin's every substep is routed through the public `World.step` itself. Over 240
// ticks every body pose and velocity, every character read-back and every collision event must be the same floats
// (Object.is), and the JS handle maps the same. Negative controls: the comparison catches a pipeline call with one argument
// dropped (the event queue; the gravity). The direct ray of `castRay` / `probeGround` is held against the public
// `World.castRayAndGetNormal` the same way.
import { afterEach, describe, expect, it } from 'vitest';
import type { EventQueue, RigidBody, World } from '@dimforge/rapier3d-simd-compat';
import type { PhysicsWorld } from '../../../src/compat/physics/rapier/world.ts';
import { arenaRapier } from './arena-fixture.ts';

type StepArgs = Parameters<World['physicsPipeline']['step']>;

/** every substep of this world goes through `World.step(q)` (the refresh step already does) */
function throughWorldStep(world: PhysicsWorld): { worldSteps: number } {
  const raw = world.raw, pipeline = raw.physicsPipeline, stepOf = raw.step;
  const count = { worldSteps: 0 };
  let depth = 0;
  raw.step = function (q?: EventQueue, hooks?: Parameters<World['step']>[1]): void {
    depth++; count.worldSteps++;
    try { stepOf.call(raw, q, hooks); } finally { depth--; }
  };
  const routed = Object.create(pipeline) as typeof pipeline;
  routed.step = (...a: StepArgs): void => {
    if (depth > 0) pipeline.step(...a);
    else raw.step(a[11]);
  };
  raw.physicsPipeline = routed;
  return count;
}

/** a negative control: the direct world's pipeline gets the call with one argument changed */
function tamper(world: PhysicsWorld, edit: (a: StepArgs) => void): void {
  const pipeline = world.raw.physicsPipeline;
  const bad = Object.create(pipeline) as typeof pipeline;
  bad.step = (...a: StepArgs): void => { edit(a); pipeline.step(...a); };
  world.raw.physicsPipeline = bad;
}

const ex = (n: number): string => (Object.is(n, -0) ? '-0' : String(n));

/** everything observable after a tick: bodies (handle, pose, velocities, sleeping), characters, maps, events */
function snapshot(world: PhysicsWorld, events: string[]): string[] {
  const raw = world.raw, out: string[] = [];
  raw.bodies.forEach((b: RigidBody) => {
    const t = b.translation(), r = b.rotation(), v = b.linvel(), w = b.angvel();
    out.push(`b${b.handle}|${[t.x, t.y, t.z, r.x, r.y, r.z, r.w, v.x, v.y, v.z, w.x, w.y, w.z].map(ex).join(',')}|${b.isSleeping()}`);
  });
  for (const c of world.characters) {
    out.push(`c${c.serial}|${[c.feet.x, c.feet.y, c.feet.z, c.velocity.x, c.velocity.y, c.velocity.z, c.groundNormal.x, c.groundNormal.y, c.groundNormal.z].map(ex).join(',')}|${c.grounded}|${c.groundBody}|${c.hits}`);
  }
  const keys = (s: { map: { getAll(): { handle: number }[] } }): string => s.map.getAll().map((o) => o.handle).join(',');
  const sets = raw as unknown as Record<'bodies' | 'colliders' | 'softBodies' | 'impulseJoints' | 'multibodyJoints', { map: { getAll(): { handle: number }[] } }>;
  out.push(`maps|${keys(sets.bodies)}|${keys(sets.colliders)}|${keys(sets.softBodies)}|${keys(sets.impulseJoints)}|${keys(sets.multibodyJoints)}`);
  out.push(`events|${events.join(';')}`);
  events.length = 0;
  return out;
}

const TICKS = 240;

/** the scripted run: the same inputs every tick for both worlds; returns one snapshot per tick */
function run(world: PhysicsWorld): string[][] {
  const R = world.R, raw = world.raw;
  const events: string[] = [];
  world.onCollisionEvent = (h1, h2, started) => { events.push(`${h1}-${h2}-${started}`); };
  // every collider reports its collision events, kinematic against fixed included (the sensor, the characters, the door)
  const reporting = (c: { setActiveEvents(e: number): void; setActiveCollisionTypes(t: number): void }): void => {
    c.setActiveEvents(R.ActiveEvents.COLLISION_EVENTS); c.setActiveCollisionTypes(R.ActiveCollisionTypes.ALL);
  };
  raw.colliders.forEach(reporting);
  // the arena's balls: awake, with gravity
  raw.bodies.forEach((b: RigidBody) => {
    if (!b.isDynamic()) return;
    b.setGravityScale(1, true); b.wakeUp();
  });
  const door = world.kinematicOf('door-1')!;
  const [player, bot, enemy] = world.characters;
  const extra: RigidBody[] = [];
  const ticks: string[][] = [];
  for (let t = 0; t < TICKS; t++) {
    // characters: the player walks north into the wall and the crate and back, the enemy circles through the portal
    player!.desiredVelocity.x = 3 * Math.sin(t / 17); player!.desiredVelocity.z = t < 120 ? -4 : 4; player!.desiredVelocity.y = t % 50 === 0 ? 8 : -9;
    enemy!.desiredVelocity.x = 4 * Math.cos(t / 9); enemy!.desiredVelocity.z = 4 * Math.sin(t / 9) + (t < 100 ? 1.5 : -1.5); enemy!.desiredVelocity.y = -9;
    if (t === 60) world.setCharacterEnabled(bot!, true);
    if (t > 60) { bot!.desiredVelocity.x = -2; bot!.desiredVelocity.z = -3; bot!.desiredVelocity.y = -9; }
    if (t === 150) world.teleportCharacter(enemy!, { x: 1, y: 0.5, z: -2.5 });
    // the door swings about its hinge
    const a = 0.8 * Math.sin(t / 11);
    world.setKinematicTarget(door, { x: Math.sin(a), y: 1.25, z: -8 + 0.3 * (1 - Math.cos(a)) }, { x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) });
    // dynamic balls dropped on the player's path, one removed later
    if (t % 20 === 5 && extra.length < 8) {
      const rb = raw.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation(0.3 * (t % 7) - 1, 3 + (t % 3), -2 - (t % 5)).setLinvel(0.5, 0, -1));
      reporting(raw.createCollider(R.ColliderDesc.ball(0.15 + 0.01 * (t % 4)).setRestitution(0.3), rb));
      extra.push(rb);
    }
    if (t === 130) raw.removeRigidBody(extra.shift()!);
    if (t === 90) extra[0]!.applyImpulse({ x: 1.5, y: 2, z: -0.5 }, true);
    world.step(1 / 30);
    ticks.push(snapshot(world, events));
  }
  return ticks;
}

function firstDiff(a: string[][], b: string[][]): { tick: number; a: string | undefined; b: string | undefined } | null {
  for (let t = 0; t < Math.max(a.length, b.length); t++) {
    const x = a[t] ?? [], y = b[t] ?? [];
    for (let i = 0; i < Math.max(x.length, y.length); i++) if (x[i] !== y[i]) return { tick: t, a: x[i], b: y[i] };
  }
  return null;
}

const worlds: PhysicsWorld[] = [];
const arena = (): PhysicsWorld => { const w = arenaRapier().world; worlds.push(w); return w; };
afterEach(() => { for (const w of worlds.splice(0)) w.free(); });

describe('PhysicsWorld substeps call the pipeline directly (DR-51 (1))', () => {
  it('gives the same floats, events and handle maps as World.step on a twin world, tick by tick', () => {
    const direct = arena(), twin = arena();
    const count = throughWorldStep(twin);
    const a = run(direct), b = run(twin);
    expect(count.worldSteps).toBeGreaterThanOrEqual(2 * TICKS);
    expect(a.length).toBe(TICKS);
    // the run is not trivial: things moved, collided and crossed the sensor
    expect(a.flat().filter((l) => l.startsWith('events|') && l.length > 7).length).toBeGreaterThan(5);
    expect(a[0]).not.toEqual(a[TICKS - 1]);
    expect(firstDiff(a, b)).toBeNull();
  });

  it('negative control: the comparison catches a pipeline call without the event queue', () => {
    const direct = arena(), twin = arena();
    throughWorldStep(twin);
    tamper(direct, (a) => { a[11] = undefined; });
    const d = firstDiff(run(direct), run(twin));
    expect(d).not.toBeNull();
    expect(d!.a).toMatch(/^events\|/);
  });

  it('negative control: the comparison catches a pipeline call with the gravity dropped', () => {
    const direct = arena(), twin = arena();
    throughWorldStep(twin);
    tamper(direct, (a) => { a[0] = { x: 0, y: 0, z: 0 }; });
    const d = firstDiff(run(direct), run(twin));
    expect(d).not.toBeNull();
    expect(d!.a).toMatch(/^b\d/);
  });
});

describe('castRay asks the broad phase directly', () => {
  it('answers what World.castRayAndGetNormal answers, for every filter and excluded body', () => {
    const world = arena();
    const raw = world.raw, R = world.R;
    let s = 7;
    const r = (): number => { s = (Math.imul(s, 1103515245) + 12345) >>> 0; return s / 4294967296; };
    const bodies: (RigidBody | undefined)[] = [undefined];
    raw.bodies.forEach((b: RigidBody) => bodies.push(b));
    const flagSets = [undefined, world.kccFlags, R.QueryFilterFlags.ONLY_FIXED, R.QueryFilterFlags.EXCLUDE_SENSORS, R.QueryFilterFlags.ONLY_DYNAMIC];
    const groupSets = [undefined, 0xffffffff, 0x0004ffff, 0x00010002];
    const ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    let hits = 0;
    for (let i = 0; i < 3000; i++) {
      const o = { x: -12 + 24 * r(), y: 0.1 + 3.5 * r(), z: -12 + 24 * r() };
      const az = 2 * Math.PI * r(), down = -0.95 + 1.3 * r(), h = Math.sqrt(1 - down * down);
      const d = { x: Math.cos(az) * h, y: down, z: Math.sin(az) * h };
      const toi = 1 + 59 * r();
      const flags = flagSets[Math.floor(r() * flagSets.length)], groups = groupSets[Math.floor(r() * groupSets.length)];
      const ex = bodies[Math.floor(r() * bodies.length)];
      const got = world.castRay(o, d, toi, flags, groups, ex);
      ray.origin = o; ray.dir = d;
      const want = raw.castRayAndGetNormal(ray, toi, true, flags, groups, undefined, ex);
      if (!want) { expect(got).toBeNull(); continue; }
      hits++;
      expect(got).not.toBeNull();
      expect(got!.handle).toBe(want.collider.handle);
      expect(Object.is(got!.toi, want.timeOfImpact)).toBe(true);
      expect([got!.normal.x, got!.normal.y, got!.normal.z].every((v, k) => Object.is(v, [want.normal.x, want.normal.y, want.normal.z][k]))).toBe(true);
    }
    expect(hits).toBeGreaterThan(1000);
  });
});
