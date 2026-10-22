// PhysicsWorld: one `RAPIER.World` per resident place (motion §4.3, §5.1, §5.3). It owns the static colliders of the place's
// ColliderPack (colliders.ts), the kinematic bodies (doors, teacups) and the characters, runs the physics part of core step E
// and frees the wasm memory on dispose (it is not garbage-collected).
//
//   build(pack)   colliders + owner records, then the refresh step (a nanosecond, defaults.REFRESH_DT): Rapier's queries
//                 and the controller read the broad phase of the LAST `world.step()`, so without it a ray right after
//                 the build would find nothing
//   step(dt)      1 kinematic targets were set by the caller (rows → `setKinematicTarget`)
//                 2 characters in spawn-serial order, `moveCharacter` each (everyone sees the others where the last step
//                   left them: frozen snapshot, order-independent)
//                 3 commit the moves as targets
//                 4 two substeps: kinematic bodies and characters at the midpoint, then at the target, so the velocity
//                   Rapier derives for pushing dynamic bodies is the tick's velocity; collision events drained per substep
//   free()        controllers, event queue and the world
//
// Until `build` ran the world is "unbuilt" (X-32): rays answer null and characters hold still (no movement, not grounded,
// realised velocity 0). PH3 binds rows to this (body-sync, kinematic targets from rows, sensors, the query backend) and PH4
// adds dynamic bodies; both work on `raw`, `colliders`, `eventQueue` and the registries below.
import type { EventQueue, Ray, RigidBody, World } from '@dimforge/rapier3d-simd-compat';
import type { ColliderPack } from '../../core/ports.ts';
import {
  DEFAULT_GRAVITY, KCC_NEAR_RANGE, KCC_QUERY_FLAGS, KCC_REPORT_GROUND_RISE, KCC_TOUCH_GAP, PACKED_CHARACTER_GROUPS, REFRESH_DT, SUBSTEPS, capsuleHalfSegment,
  groupsInteract, kccParams, queryFlags, type KccParams,
} from '../defaults.ts';
import { ColliderSet, type OwnerRecord, type PackStats } from './colliders.ts';
import { containCharacter } from './kcc-ccd.ts';
import { ControllerCache, kccResult, moveCharacter, type CharacterBody, type KccInput, type Quat, type Vec3 } from './kcc.ts';
import { perfNow } from '../../core/perf-now.ts';
import { rapier, rapierIfLoaded, type Rapier } from './loader.ts';

export interface PhysicsWorldOptions {
  /** `place.gravity`; default {0, -24, 0}. It acts on dynamic bodies only: the game integrates a character's gravity. */
  gravity?: Vec3;
}

export interface CharacterSpec {
  rowId: string | null;
  feet: Vec3;
  /** total capsule height feet → top, world units */
  height: number;
  radius: number;
  /** default: the D-MPN-08 set */
  params?: KccParams;
  /** packed groups; default: member of 0x0004 only, meets everything (D-MPN-09) */
  groups?: number;
  tags?: readonly string[];
  /** opt-in per body: sweep its move against the other characters (kcc-ccd.ts) */
  continuous?: boolean;
}

/** a `kinematicPositionBased` body driven by per-tick pose targets (doors, teacups) */
export interface KinematicBody {
  readonly serial: number;
  readonly rowId: string | null;
  readonly body: RigidBody;
  /** pose after the last step */
  readonly pos: Vec3;
  readonly rot: Quat;
  /** pose target of the running tick */
  readonly nextPos: Vec3;
  readonly nextRot: Quat;
  /** a target was set since the last step */
  moving: boolean;
}

export interface WorldRayHit { toi: number; normal: Vec3; handle: number; owner: OwnerRecord | undefined }

const DOWN: Vec3 = { x: 0, y: -1, z: 0 };
const P: Vec3 = { x: 0, y: 0, z: 0 };
const Q: Quat = { x: 0, y: 0, z: 0, w: 1 };
const V: Vec3 = { x: 0, y: 0, z: 0 };

/**
 * One substep: `World.step(q)` without its `mapNewSoftBodies()` (DR-51 (1)). In rapier.js 0.21 `World.step(q, hooks)` is
 * exactly `physicsPipeline.step(gravity, integrationParameters, islands, broadPhase, narrowPhase, bodies, colliders,
 * softBodies, impulseJoints, multibodyJoints, ccdSolver, q, hooks)` followed by `mapNewSoftBodies()`, which walks every body,
 * collider and joint handle to wrap what the engine made or removed on its own (the pieces of a soft-body tear). The port has
 * no soft bodies, passes no hooks and adds and removes bodies and colliders only through the JS sets (which map and unmap at
 * once), so the walk never changes a map; it was 56 % of the substep time. The refresh step keeps `World.step`.
 * Identity: tests/unit/physics/world-step-direct.node.test.ts.
 */
export function stepPipeline(raw: World, q: EventQueue): void {
  raw.physicsPipeline.step(raw.gravity, raw.integrationParameters, raw.islands, raw.broadPhase, raw.narrowPhase,
    raw.bodies, raw.colliders, raw.softBodies, raw.impulseJoints, raw.multibodyJoints, raw.ccdSolver, q);
}

/** q · v */
function rotate(q: Readonly<Quat>, x: number, y: number, z: number, o: Vec3): void {
  const tx = 2 * (q.y * z - q.z * y), ty = 2 * (q.z * x - q.x * z), tz = 2 * (q.x * y - q.y * x);
  o.x = x + q.w * tx + (q.y * tz - q.z * ty);
  o.y = y + q.w * ty + (q.z * tx - q.x * tz);
  o.z = z + q.w * tz + (q.x * ty - q.y * tx);
}

/** normalised lerp along the short arc (substep poses of a per-tick rotation: at most a few degrees apart) */
function nlerp(a: Readonly<Quat>, b: Readonly<Quat>, f: number, o: Quat): void {
  const s = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w < 0 ? -1 : 1;
  const x = a.x + (b.x * s - a.x) * f, y = a.y + (b.y * s - a.y) * f, z = a.z + (b.z * s - a.z) * f, w = a.w + (b.w * s - a.w) * f;
  const l = Math.hypot(x, y, z, w) || 1;
  o.x = x / l; o.y = y / l; o.z = z / l; o.w = w / l;
}

export class PhysicsWorld {
  readonly place: string;
  readonly R: Rapier;
  readonly raw: World;
  readonly colliders: ColliderSet;
  /** collision events of the substeps (sensors, PH3); drained into `onCollisionEvent` when one is set */
  readonly eventQueue: EventQueue;
  onCollisionEvent: ((handle1: number, handle2: number, started: boolean) => void) | null = null;
  /** set to an object to have `step` add the milliseconds of its two halves to it (bench, perf overlay); null = no timing */
  profile: { controllerMs: number; substepsMs: number } | null = null;
  /** `QueryFilterFlags` of the controller (defaults.KCC_QUERY_FLAGS) */
  readonly kccFlags: number;
  /** spawn-serial order */
  readonly characters: CharacterBody[] = [];
  readonly kinematics: KinematicBody[] = [];
  /** opt-in for every character of the world (PhysicsPortOptions.characterCcd): see kcc-ccd.ts. Default false = the base runtime. */
  characterCcd = false;

  private readonly controllers: ControllerCache;
  private readonly kinematicByBody = new Map<number, KinematicBody>();
  private readonly kinematicByRow = new Map<string, KinematicBody>();
  private readonly characterByCollider = new Map<number, CharacterBody>();
  private readonly ray: Ray;
  private readonly kccInput: KccInput;
  private readonly kccOut = kccResult();
  private serial = 0;
  private isBuilt = false;
  private isFreed = false;
  /** a body was teleported or shifted since the last step: its collider pose must be propagated before the next query */
  private stale = false;
  /** a collider was reshaped or re-seated on its body since the last step (crouch): needs a refresh step before queries */
  private reshaped = false;

  constructor(place: string, opts: PhysicsWorldOptions = {}, R: Rapier = rapier()) {
    this.place = place;
    this.R = R;
    const g = opts.gravity ?? DEFAULT_GRAVITY;
    this.raw = new R.World({ x: g.x, y: g.y, z: g.z });
    this.eventQueue = new R.EventQueue(true);
    this.controllers = new ControllerCache(this.raw);
    this.colliders = new ColliderSet(R, this.raw, (rowId, t, q) => this.createKinematicBody(rowId, t, q).body);
    this.kccFlags = queryFlags(R.QueryFilterFlags, KCC_QUERY_FLAGS);
    this.ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    this.kccInput = { body: null as unknown as CharacterBody, desired: { x: 0, y: 0, z: 0 }, dt: 1 / 30 };
  }

  /** false until `build` ran: queries answer null and characters hold still (X-32) */
  get built(): boolean { return this.isBuilt; }
  get freed(): boolean { return this.isFreed; }
  get kinematicCount(): number { return this.kinematics.length; }
  get controllerCount(): number { return this.controllers.size; }

  // ── build ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** the place's ColliderPack → colliders with owner records, visible to queries at once */
  build(pack: ColliderPack, tagsOf?: (rowId: string) => readonly string[]): PackStats {
    const stats = this.colliders.addPack(pack, tagsOf);
    this.refresh();
    this.isBuilt = true;
    return stats;
  }

  /**
   * The refresh step of motion §4.3: publishes new and moved colliders to the broad phase without advancing anything.
   * Its length is defaults.REFRESH_DT, not exactly 0 (a zero step can empty Rapier's query structure). The collision
   * events it finds (a body teleported into a trigger, a trigger made around a body) go to `onCollisionEvent` like those
   * of a substep: the next step would not report them again.
   */
  refresh(): void {
    const dt = this.raw.timestep;
    this.raw.timestep = REFRESH_DT;
    this.raw.step(this.eventQueue);
    this.raw.timestep = dt;
    this.drainEvents();
    this.stale = false;
  }

  private drainEvents(): void {
    const listener = this.onCollisionEvent;
    if (listener) this.eventQueue.drainCollisionEvents(listener); else this.eventQueue.clear();
  }

  // ── kinematic bodies ───────────────────────────────────────────────────────────────────────────────────────────────────

  /** the row's kinematic body (created on first use); colliders.ts attaches the pack's kinematic instances to it */
  createKinematicBody(rowId: string | null, pos: Readonly<Vec3>, rot: Readonly<Quat>): KinematicBody {
    const known = rowId !== null ? this.kinematicByRow.get(rowId) : undefined;
    if (known) return known;
    const R = this.R;
    const body = this.raw.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(pos.x, pos.y, pos.z).setRotation(rot));
    const kb: KinematicBody = {
      serial: this.serial++, rowId, body, pos: { ...pos }, rot: { ...rot }, nextPos: { ...pos }, nextRot: { ...rot }, moving: false,
    };
    this.kinematics.push(kb);
    this.kinematicByBody.set(body.handle, kb);
    if (rowId !== null) this.kinematicByRow.set(rowId, kb);
    return kb;
  }

  kinematicByHandle(bodyHandle: number): KinematicBody | undefined { return this.kinematicByBody.get(bodyHandle); }
  kinematicOf(rowId: string): KinematicBody | undefined { return this.kinematicByRow.get(rowId); }

  /** the pose the body shall have after this tick's step (door `rotation`, teacup yaw tween); null keeps that part */
  setKinematicTarget(kb: KinematicBody, pos: Readonly<Vec3> | null, rot: Readonly<Quat> | null): void {
    if (pos) { kb.nextPos.x = pos.x; kb.nextPos.y = pos.y; kb.nextPos.z = pos.z; }
    if (rot) { kb.nextRot.x = rot.x; kb.nextRot.y = rot.y; kb.nextRot.z = rot.z; kb.nextRot.w = rot.w; }
    kb.moving = true;
  }

  removeKinematicBody(kb: KinematicBody): void {
    const i = this.kinematics.indexOf(kb);
    if (i < 0) return;
    this.kinematics.splice(i, 1);
    this.kinematicByBody.delete(kb.body.handle);
    if (kb.rowId !== null) {
      this.kinematicByRow.delete(kb.rowId);
      for (const rec of [...this.colliders.ownersOf(kb.rowId)]) if (rec.body === kb.body) this.colliders.remove(rec, false);
    }
    this.raw.removeRigidBody(kb.body);
  }

  /**
   * How far the point `p` is carried by the body's move of this tick (pose → target, as a rigid motion) → `out`.
   * False when the body has no target this tick. Exact for rotations: a rider does not drift off a turning disc.
   */
  carryOf(kb: KinematicBody, p: Readonly<Vec3>, out: Vec3): boolean {
    if (!kb.moving) return false;
    // local = rot⁻¹ (p - pos); carried = nextPos + nextRot · local
    Q.x = -kb.rot.x; Q.y = -kb.rot.y; Q.z = -kb.rot.z; Q.w = kb.rot.w;
    rotate(Q, p.x - kb.pos.x, p.y - kb.pos.y, p.z - kb.pos.z, V);
    rotate(kb.nextRot, V.x, V.y, V.z, V);
    out.x = kb.nextPos.x + V.x - p.x;
    out.y = kb.nextPos.y + V.y - p.y;
    out.z = kb.nextPos.z + V.z - p.z;
    return true;
  }

  /** the gravity vector of the world (a copy) */
  get gravity(): Vec3 { const g = this.raw.gravity; return { x: g.x, y: g.y, z: g.z }; }

  /**
   * Changes the world's gravity at runtime (R-3: `ctx.place.gravity = v`). It acts on dynamic bodies from the next step on,
   * and sleeping ones are woken so that a moon / heavy-planet switch takes hold at once. Characters integrate their own gravity
   * in the game's script, so they are untouched (the `PhysicsWorldOptions.gravity` note above). Non-finite input is ignored.
   */
  setGravity(g: Readonly<Vec3>): boolean {
    if (this.isFreed || !Number.isFinite(g.x) || !Number.isFinite(g.y) || !Number.isFinite(g.z)) return false;
    const cur = this.raw.gravity;
    if (cur.x === g.x && cur.y === g.y && cur.z === g.z) return true;
    this.raw.gravity = { x: g.x, y: g.y, z: g.z };
    this.raw.forEachRigidBody((b) => { if (b.isDynamic()) b.wakeUp(); });
    return true;
  }

  // ── characters ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** `kinematicPositionBased` body at the feet + capsule `(h/2 - r, r)` centred h/2 above them (motion §4.2) */
  addCharacter(spec: CharacterSpec): CharacterBody {
    const R = this.R;
    const params = spec.params ?? kccParams();
    const groups = spec.groups ?? PACKED_CHARACTER_GROUPS;
    const fx = Math.fround(spec.feet.x), fy = Math.fround(spec.feet.y), fz = Math.fround(spec.feet.z);
    const body = this.raw.createRigidBody(R.RigidBodyDesc.kinematicPositionBased().setTranslation(fx, fy, fz));
    const desc = R.ColliderDesc.capsule(capsuleHalfSegment(spec.height, spec.radius), spec.radius)
      .setTranslation(0, spec.height / 2, 0)
      .setCollisionGroups(groups);
    const collider = this.raw.createCollider(desc, body);
    const c: CharacterBody = {
      serial: this.serial++, rowId: spec.rowId, body, collider, params, controller: this.controllers.for(params), groups,
      height: spec.height, radius: spec.radius, enabled: true,
      feet: { x: fx, y: fy, z: fz }, desiredVelocity: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
      grounded: false, groundBody: -1, groundNormal: { x: 0, y: 1, z: 0 }, hits: 0, touching: [], near: [], target: { x: fx, y: fy, z: fz },
      ...(spec.continuous ? { continuous: true } : {}),
    };
    this.characters.push(c);
    this.characterByCollider.set(collider.handle, c);
    this.colliders.adopt(collider, body, { rowId: spec.rowId, kind: 'character', ...(spec.tags ? { tags: spec.tags } : {}) });
    return c;
  }

  characterOfCollider(handle: number): CharacterBody | undefined { return this.characterByCollider.get(handle); }

  removeCharacter(c: CharacterBody): void {
    const i = this.characters.indexOf(c);
    if (i < 0) return;
    this.characters.splice(i, 1);
    this.characterByCollider.delete(c.collider.handle);
    const rec = this.colliders.owner(c.collider.handle);
    if (rec) this.colliders.remove(rec, false);
    this.raw.removeRigidBody(c.body);
  }

  /** a new parameter set for a living character (a `physics` write that keeps the body) */
  setCharacterParams(c: CharacterBody, params: KccParams): void {
    c.params = params;
    c.controller = this.controllers.for(params);
  }

  /** crouch swap on the existing collider; the body origin is the feet, so they stay planted (motion §5.4) */
  setCapsule(c: CharacterBody, height: number, radius: number): void {
    c.height = height;
    c.radius = radius;
    c.collider.setHalfHeight(capsuleHalfSegment(height, radius));
    c.collider.setRadius(radius);
    c.collider.setTranslationWrtParent({ x: 0, y: height / 2, z: 0 });
    // Rapier moves the collider to its new place under the body only in a step: without one the next controller call
    // would still see the old centre (and a crouching body would drop through the gap under it)
    this.reshaped = true;
  }

  /** spectating: out of every collision and query, and not moved (core §5.8) */
  setCharacterEnabled(c: CharacterBody, on: boolean): void {
    c.enabled = on;
    c.collider.setEnabled(on);
    if (!on) { c.grounded = false; c.groundBody = -1; c.groundNormal.x = 0; c.groundNormal.y = 1; c.groundNormal.z = 0; }
  }

  /** `feetPosition` write: no sweep, ground contact cleared, the realised velocity untouched (motion §5.2) */
  teleportCharacter(c: CharacterBody, feet: Readonly<Vec3>): void {
    c.feet.x = Math.fround(feet.x); c.feet.y = Math.fround(feet.y); c.feet.z = Math.fround(feet.z);
    c.target.x = c.feet.x; c.target.y = c.feet.y; c.target.z = c.feet.z;
    c.body.setTranslation(c.feet, false);
    c.grounded = false;
    c.groundBody = -1;
    c.groundNormal.x = 0; c.groundNormal.y = 1; c.groundNormal.z = 0;
    this.stale = true;
  }

  /**
   * kcc.ts, resuming a dropped move: put the character's collider at feet + `offset` for the next controller call
   * (null: back at the feet). Nothing else sees it: the broad phase keeps the pose of the last step.
   */
  shiftCharacterCollider(c: CharacterBody, offset: Readonly<Vec3> | null): void {
    if (offset) { P.x = c.feet.x + offset.x; P.y = c.feet.y + offset.y; P.z = c.feet.z + offset.z; }
    c.body.setTranslation(offset ? P : c.feet, false);
    this.raw.propagateModifiedBodyPositionsToColliders();
  }

  /** kcc.ts: the kinematic body right under a grounded character whose move reported no ground hit, or -1 */
  probeGround(c: CharacterBody): number {
    const lift = c.radius;
    const hit = this.castRay({ x: c.feet.x, y: c.feet.y + lift, z: c.feet.z }, DOWN, lift + (c.params.snapToGround ?? 0) + 2 * c.params.offset + 0.02, this.kccFlags, c.groups, c.body);
    if (!hit) return -1;
    const parent = this.raw.getCollider(hit.handle)?.parent();
    return parent && this.kinematicByBody.has(parent.handle) ? parent.handle : -1;
  }

  // ── step ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** the physics of one tick (motion §5.3 steps 2-4); kinematic targets and desired velocities were written before */
  step(dt = 1 / 30): void {
    const raw = this.raw;
    const chars = this.characters;
    if (!this.isBuilt) {
      // X-32: no ground to stand on yet
      for (const c of chars) { c.velocity.x = 0; c.velocity.y = 0; c.velocity.z = 0; c.grounded = false; c.groundBody = -1; c.hits = 0; }
      return;
    }
    if (this.reshaped) {
      this.refresh();
      this.reshaped = false;
    } else if (this.stale) {
      raw.propagateModifiedBodyPositionsToColliders();
      this.stale = false;
    }
    const profile = this.profile;
    const t0 = profile ? perfNow() : 0;
    // 2. characters. `timestep = 0` for the pass: the controller's own kinematic friction is velocity × timestep (kcc.ts)
    raw.timestep = 0;
    this.findNeighbours();
    const inp = this.kccInput, out = this.kccOut;
    inp.dt = dt;
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i]!;
      if (!c.enabled) { c.velocity.x = 0; c.velocity.y = 0; c.velocity.z = 0; c.hits = 0; continue; }
      inp.body = c;
      inp.desired.x = c.desiredVelocity.x * dt; inp.desired.y = c.desiredVelocity.y * dt; inp.desired.z = c.desiredVelocity.z * dt;
      moveCharacter(this, inp, out);
      if (this.characterCcd || c.continuous === true) containCharacter(chars, i, out);
      // 3. the target is exact, so position, velocity and grounded are final before the substeps
      const t = out.translation;
      c.target.x = Math.fround(c.feet.x + t.x); c.target.y = Math.fround(c.feet.y + t.y); c.target.z = Math.fround(c.feet.z + t.z);
      c.velocity.x = t.x / dt; c.velocity.z = t.z / dt;
      // realised velocity = movement / dt; the upward part of a body that ends on the ground: defaults.KCC_REPORT_GROUND_RISE
      const vy = t.y / dt;
      c.velocity.y = !KCC_REPORT_GROUND_RISE && out.grounded && vy > 0 ? Math.min(vy, Math.max(0, c.desiredVelocity.y)) : vy;
      c.grounded = out.grounded;
      c.groundNormal.x = out.groundNormal.x; c.groundNormal.y = out.groundNormal.y; c.groundNormal.z = out.groundNormal.z;
      c.groundBody = out.groundBody;
      c.hits = out.hits;
    }
    const t1 = profile ? perfNow() : 0;
    // 4. substeps: midpoint, then target
    raw.timestep = dt / SUBSTEPS;
    for (let s = 1; s <= SUBSTEPS; s++) {
      const f = s / SUBSTEPS;
      for (let i = 0; i < this.kinematics.length; i++) {
        const kb = this.kinematics[i]!;
        if (!kb.moving) continue;
        P.x = kb.pos.x + (kb.nextPos.x - kb.pos.x) * f; P.y = kb.pos.y + (kb.nextPos.y - kb.pos.y) * f; P.z = kb.pos.z + (kb.nextPos.z - kb.pos.z) * f;
        kb.body.setNextKinematicTranslation(P);
        nlerp(kb.rot, kb.nextRot, f, Q);
        kb.body.setNextKinematicRotation(Q);
      }
      for (let i = 0; i < chars.length; i++) {
        const c = chars[i]!;
        if (!c.enabled) continue;
        if (s === SUBSTEPS) c.body.setNextKinematicTranslation(c.target);
        else {
          P.x = c.feet.x + (c.target.x - c.feet.x) * f; P.y = c.feet.y + (c.target.y - c.feet.y) * f; P.z = c.feet.z + (c.target.z - c.feet.z) * f;
          c.body.setNextKinematicTranslation(P);
        }
      }
      stepPipeline(raw, this.eventQueue);
      this.drainEvents();
    }
    for (let i = 0; i < this.kinematics.length; i++) {
      const kb = this.kinematics[i]!;
      if (!kb.moving) continue;
      kb.pos.x = kb.nextPos.x; kb.pos.y = kb.nextPos.y; kb.pos.z = kb.nextPos.z;
      kb.rot.x = kb.nextRot.x; kb.rot.y = kb.nextRot.y; kb.rot.z = kb.nextRot.z; kb.rot.w = kb.nextRot.w;
      kb.moving = false;
    }
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i]!;
      if (c.enabled) { c.feet.x = c.target.x; c.feet.y = c.target.y; c.feet.z = c.target.z; }
    }
    if (profile) {
      profile.controllerMs += t1 - t0;
      profile.substepsMs += perfNow() - t1;
    }
  }

  /**
   * Which characters are in contact, side by side (`touching` of both: closer than defaults.KCC_TOUCH_GAP, standing inside
   * each other included) and which are just beside each other (`near` of both), kcc.ts header 5. Only pairs whose groups
   * let them collide at all.
   */
  private findNeighbours(): void {
    const chars = this.characters;
    for (let i = 0; i < chars.length; i++) {
      const c = chars[i]!;
      if (c.touching.length > 0) c.touching.length = 0;
      if (c.near.length > 0) c.near.length = 0;
    }
    for (let i = 0; i < chars.length; i++) {
      const a = chars[i]!;
      if (!a.enabled) continue;
      for (let j = i + 1; j < chars.length; j++) {
        const b = chars[j]!;
        if (!b.enabled) continue;
        const beside = a.radius + b.radius + KCC_NEAR_RANGE;
        const dx = b.feet.x - a.feet.x, dz = b.feet.z - a.feet.z;
        const d2 = dx * dx + dz * dz;
        if (d2 >= beside * beside) continue;
        // side by side only: the straight parts of the two capsules share a height. A body that came down on another one's
        // head or shoulder touches a round cap while their footprints overlap; that is not a contact from the side, and
        // the controller's cast handles it (it rests there or slides off). Counted as one, it fell through the body below.
        const aLo = a.feet.y + Math.min(a.radius, a.height / 2), aHi = a.feet.y + Math.max(a.height - a.radius, a.height / 2);
        const bLo = b.feet.y + Math.min(b.radius, b.height / 2), bHi = b.feet.y + Math.max(b.height - b.radius, b.height / 2);
        if (aLo > bHi || bLo > aHi) continue;
        if (!groupsInteract(a.groups, b.groups)) continue;
        const reach = a.radius + b.radius + KCC_TOUCH_GAP;
        const list = d2 < reach * reach ? 'touching' : 'near';
        a[list].push(b);
        b[list].push(a);
      }
    }
  }

  // ── a plain ray (tests, the ground probe; the `builtin/physics` backend is PH3's rapier/query.ts) ───────────────────────

  /** nearest hit with its normal within `maxToi`, `solid: true`; null on a miss and on an unbuilt world (X-32) */
  castRay(origin: Readonly<Vec3>, dir: Readonly<Vec3>, maxToi: number, flags?: number, groups?: number, excludeBody?: RigidBody): WorldRayHit | null {
    if (!this.isBuilt) return null;
    const ray = this.ray;
    ray.origin.x = origin.x; ray.origin.y = origin.y; ray.origin.z = origin.z;
    ray.dir.x = dir.x; ray.dir.y = dir.y; ray.dir.z = dir.z;
    // the world's BroadPhase itself, without the empty predicate closure `World.castRayAndGetNormal` makes (rapier/query.ts)
    const w = this.raw;
    const hit = w.broadPhase.castRayAndGetNormal(w.narrowPhase, w.bodies, w.colliders, ray, maxToi, true, flags, groups, undefined, excludeBody?.handle);
    if (!hit) return null;
    const handle = hit.collider.handle;
    return { toi: hit.timeOfImpact, normal: hit.normal, handle, owner: this.colliders.owner(handle) };
  }

  // ── dispose ────────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** wasm memory is not garbage-collected: controllers, the event queue and the world are freed here, once */
  free(): void {
    if (this.isFreed) return;
    this.isFreed = true;
    this.isBuilt = false;
    this.controllers.free();
    this.eventQueue.free();
    this.raw.free();
    this.characters.length = 0;
    this.kinematics.length = 0;
    this.kinematicByBody.clear();
    this.kinematicByRow.clear();
    this.characterByCollider.clear();
    this.colliders.clear();
  }
}

/** a world for a place, or null while Rapier is not loaded (the caller keeps the bake and builds on `loadRapier()`, X-32) */
export function createPhysicsWorld(place: string, opts: PhysicsWorldOptions = {}, R: Rapier | null = rapierIfLoaded()): PhysicsWorld | null {
  return R ? new PhysicsWorld(place, opts, R) : null;
}
