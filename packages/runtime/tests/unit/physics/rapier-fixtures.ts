// Synthetic collider packs and a small velocity driver for physics contract tests.
import type { ColliderPack } from '../../../src/compat/core/ports.ts';
import { DEG, kccParams, type KccParams } from '../../../src/compat/physics/defaults.ts';
import type { CharacterBody } from '../../../src/compat/physics/rapier/kcc.ts';
import { PhysicsWorld } from '../../../src/compat/physics/rapier/world.ts';

export interface V3 { x: number; y: number; z: number }

/** Calibrated capsule/controller inputs used by the contact regression suite. */
export const PLAYER_CAPSULE = { height: 1.9, radius: 0.35 } as const;
export const PLAYER_KCC: KccParams = kccParams({
  autostep: { maxHeight: 0.4, minWidth: 0.2, includeDynamic: false },
  maxSlopeClimb: 52 * DEG,
  minSlopeSlide: 62 * DEG,
  snapToGround: 0.3,
});
/** A second capsule size exercises interactions between different bodies. */
export const ENEMY_CAPSULE = { height: 1.8, radius: 0.34 } as const;
export const ENEMY_KCC: KccParams = kccParams();

/** Explicit driver inputs, independent of runtime defaults. */
export const MOVE = {
  walk: 5.0, sprint: 6.6, accel: 42, decel: 56, airAccel: 5.0, jumpHeight: 0.95,
} as const;
export const GRAVITY = -24;
export const TICK = 1 / 30;

// ── packs ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A part in the tests' own terms: `box` = HALF extents and `sphere` = radius of a shape CENTRED at `at`. `packOf` turns it
 * into the pack's key convention (full size standing on the key origin; a sphere centred at (0, r, 0)): colliders.ts header.
 */
export interface Part {
  row: string;
  box?: [number, number, number];
  sphere?: number;
  tris?: Float32Array | number[];
  /** centre */
  at?: [number, number, number];
  /** rotation as axis (unit) + angle in degrees */
  axis?: [number, number, number];
  deg?: number;
  scale?: [number, number, number];
  mutable?: boolean;
  kinematic?: boolean;
  noDecal?: boolean;
}

/** 3×4 (column-major rotation·scale, then translation) from translation, axis-angle and scale */
export function mat34(at: readonly number[] = [0, 0, 0], axis: readonly number[] = [0, 1, 0], deg = 0, scale: readonly number[] = [1, 1, 1]): Float32Array {
  const a = deg * DEG, s = Math.sin(a / 2), w = Math.cos(a / 2);
  const x = axis[0]! * s, y = axis[1]! * s, z = axis[2]! * s;
  const m = new Float32Array(12);
  m[0] = (1 - 2 * (y * y + z * z)) * scale[0]!; m[1] = 2 * (x * y + w * z) * scale[0]!; m[2] = 2 * (x * z - w * y) * scale[0]!;
  m[3] = 2 * (x * y - w * z) * scale[1]!; m[4] = (1 - 2 * (x * x + z * z)) * scale[1]!; m[5] = 2 * (y * z + w * x) * scale[1]!;
  m[6] = 2 * (x * z + w * y) * scale[2]!; m[7] = 2 * (y * z - w * x) * scale[2]!; m[8] = (1 - 2 * (x * x + y * y)) * scale[2]!;
  m[9] = at[0]!; m[10] = at[1]!; m[11] = at[2]!;
  return m;
}

/** a matrix whose translation is a shape's centre → the matrix of the key that stands on its origin, `up` below the centre */
function standing(m: Float32Array, up: number): Float32Array {
  m[9] = m[9]! - m[3]! * up; m[10] = m[10]! - m[4]! * up; m[11] = m[11]! - m[5]! * up;
  return m;
}

/** `addInstance` arguments for a box of HALF extents `half` centred at `at` (the pack convention worked out as in `packOf`) */
export function centred(id: string, half: readonly [number, number, number], at: readonly number[], axis?: readonly number[], deg?: number): { shape: ColliderPack['keys'][number]; m: Float32Array } {
  return { shape: { id, box: [half[0] * 2, half[1] * 2, half[2] * 2] }, m: standing(mat34(at, axis, deg), half[1]) };
}

export function packOf(place: string, parts: Part[], terrain?: Float32Array): ColliderPack {
  const pack: ColliderPack = { place, keys: [], instances: [], runtimeKeys: [] };
  parts.forEach((p, i) => {
    const key: ColliderPack['keys'][number] = { id: `k${i}` };
    if (p.box) key.box = [p.box[0] * 2, p.box[1] * 2, p.box[2] * 2];
    if (p.sphere !== undefined) key.sphere = p.sphere;
    if (p.tris) key.tris = p.tris instanceof Float32Array ? p.tris : new Float32Array(p.tris);
    pack.keys.push(key);
    pack.instances.push({
      rowId: p.row, key: i, m: standing(mat34(p.at, p.axis, p.deg, p.scale), p.box ? p.box[1] : (p.sphere ?? 0)), mutable: p.mutable === true, kinematic: p.kinematic === true,
      noDecal: p.noDecal === true,
    });
  });
  if (terrain) pack.terrain = { tris: terrain, id: `terrain/${place}` };
  return pack;
}

/** a flat square of two triangles at height y, facing up */
export function quadSoup(half: number, y = 0, cx = 0, cz = 0): Float32Array {
  const a = [cx - half, y, cz - half], b = [cx + half, y, cz - half], c = [cx + half, y, cz + half], d = [cx - half, y, cz + half];
  return new Float32Array([...a, ...c, ...b, ...a, ...d, ...c]);
}

/** a level floor of 1 m squares (2 triangles each), top at y */
export function gridSoup(half: number, y = 0, cell = 1): Float32Array {
  const n = Math.round((2 * half) / cell);
  const out = new Float32Array(n * n * 18);
  let w = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x0 = -half + i * cell, z0 = -half + j * cell, x1 = x0 + cell, z1 = z0 + cell;
      out.set([x0, y, z0, x1, y, z1, x1, y, z0, x0, y, z0, x0, y, z1, x1, y, z1], w);
      w += 18;
    }
  }
  return out;
}

/**
 * The floor every controller test stands on: a box key of 12 m half extent with its top at y = 0. colliders.ts builds a box
 * this size as a trimesh of its faces (defaults.CUBOID_MAX_HALF_EXTENT): as a Rapier cuboid the capsule sinks into it.
 */
export const FLOOR: Part = { row: 'floor', box: [12, 0.5, 12], at: [0, -0.5, 0] };

export function worldOf(parts: Part[], place = 'test', terrain?: Float32Array): PhysicsWorld {
  const world = new PhysicsWorld(place);
  world.build(packOf(place, parts, terrain));
  return world;
}

export function player(world: PhysicsWorld, feet: V3, rowId = 'player-1'): CharacterBody {
  return world.addCharacter({ rowId, feet, ...PLAYER_CAPSULE, params: PLAYER_KCC });
}

export function enemy(world: PhysicsWorld, feet: V3, rowId = 'enemy-1'): CharacterBody {
  return world.addCharacter({ rowId, feet, ...ENEMY_CAPSULE, params: ENEMY_KCC });
}

/** write a velocity and step once; returns the realised velocity object of the body */
export function stepWith(world: PhysicsWorld, c: CharacterBody, v: V3): V3 {
  c.desiredVelocity.x = v.x; c.desiredVelocity.y = v.y; c.desiredVelocity.z = v.z;
  world.step(TICK);
  return c.velocity;
}

/** let a body fall and rest: gravity integrated as every live script does (`vy = v.y + g·dt`) */
export function settle(world: PhysicsWorld, c: CharacterBody, ticks = 30): void {
  for (let i = 0; i < ticks; i++) stepWith(world, c, { x: 0, y: c.velocity.y + GRAVITY * TICK, z: 0 });
}

/** Synthetic acceleration driver: read realised velocity, apply bounded steering and gravity, then step.
 * It intentionally has no gameplay states, landing penalties, jump cooldown, or air-speed policy.
 */
export class PlayerLoop {
  wishX = 0;
  wishZ = 0;
  sprint = false;
  jump = false;
  readonly landings: number[] = [];
  private previousGrounded: boolean | undefined;
  private ticks = 0;

  readonly world: PhysicsWorld;
  readonly body: CharacterBody;
  constructor(world: PhysicsWorld, body: CharacterBody) { this.world = world; this.body = body; }

  tick(): void {
    const body = this.body;
    if (body.grounded && this.previousGrounded === false) this.landings.push(this.ticks);
    this.previousGrounded = body.grounded;
    const magnitude = Math.hypot(this.wishX, this.wishZ);
    const scale = (this.sprint ? MOVE.sprint : MOVE.walk) / Math.max(1, magnitude);
    const target = { x: this.wishX * scale, z: this.wishZ * scale };
    const delta = { x: target.x - body.velocity.x, z: target.z - body.velocity.z };
    // Ignore contact jitter when deciding whether the requested direction reverses motion.
    const reversing = Math.hypot(body.velocity.x, body.velocity.z) > 0.1 && target.x * body.velocity.x + target.z * body.velocity.z < 0;
    const braking = magnitude === 0 || reversing;
    const rate = body.grounded ? (braking ? MOVE.decel : MOVE.accel) : MOVE.airAccel;
    const fraction = Math.min(1, rate * TICK / (Math.hypot(delta.x, delta.z) || 1));
    body.desiredVelocity.x = body.velocity.x + delta.x * fraction;
    body.desiredVelocity.z = body.velocity.z + delta.z * fraction;
    body.desiredVelocity.y = this.jump && body.grounded
      ? Math.sqrt(-2 * GRAVITY * MOVE.jumpHeight)
      : body.velocity.y + GRAVITY * TICK;
    this.jump = false;
    this.world.step(TICK);
    this.ticks++;
  }

  run(ticks: number): void { for (let i = 0; i < ticks; i++) this.tick(); }
  wish(x: number, z: number): this { this.wishX = x; this.wishZ = z; return this; }
  get speed(): number { return Math.hypot(this.body.velocity.x, this.body.velocity.z); }
}
