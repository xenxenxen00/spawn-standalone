// PH4: Rapier dynamic bodies for gibs, door shards and dropped gear (motion §5.6). PhysicsWorld owns the two 1/60 s
// substeps; this adapter only creates bodies, applies writes and returns their post-step poses to BodySync.
// Integration: PhysicsPortImpl must receive createRapierDynamics as its dynamics factory. Core WorldBounds currently
// holds out-of-bounds rows with transform/velocity writes; call PhysicsPortImpl.holdBody for the gravity-disabled sleep.
// Dynamic shapes stay box/ball; the shared defaults.TRIMESH_FLAGS seam choice belongs to fixed terrain and map colliders.
import type { ColliderDesc, RigidBody } from '@dimforge/rapier3d-simd-compat';
import type { Quat, RowRec, Vec3 } from '../../core/types.ts';
import { packedGroups, type NormalizedBody } from '../spec.ts';
import { rowShape, type DynamicBodies, type RowWorldPose, type SyncHost } from './body-sync.ts';
import type { OwnerRecord } from './colliders.ts';
import type { PhysicsWorld } from './world.ts';

const MIN_EXTENT = 1e-4;
const ZERO = { x: 0, y: 0, z: 0 };

interface ShapeFit {
  readonly desc: ColliderDesc;
  readonly signature: string;
}

interface DynamicRecord {
  readonly row: RowRec;
  readonly body: RigidBody;
  readonly forces: Map<string, Vec3>;
  owner: OwnerRecord;
  gravityScale: number;
  held: boolean;
  enabled: boolean;
  signature: string;
}

function fitCollider(world: PhysicsWorld, row: RowRec, spec: Readonly<NormalizedBody>, pose: Readonly<RowWorldPose>, host: SyncHost): ShapeFit | null {
  const result = rowShape(row, spec, host);
  if (!result || result === 'pending' || 'tris' in result.shape) return null;
  const sx = pose.scale.x, sy = pose.scale.y, sz = pose.scale.z;
  let cx = result.frame ? result.frame[9]! * sx : 0;
  let cy = result.frame ? result.frame[10]! * sy : 0;
  let cz = result.frame ? result.frame[11]! * sz : 0;
  if (result.shape.box) {
    const [w, h, d] = result.shape.box;
    const hx = Math.max(MIN_EXTENT, w * Math.abs(sx) / 2);
    const hy = Math.max(MIN_EXTENT, h * Math.abs(sy) / 2);
    const hz = Math.max(MIN_EXTENT, d * Math.abs(sz) / 2);
    cy += h * sy / 2;
    const desc = world.R.ColliderDesc.cuboid(hx, hy, hz).setTranslation(cx, cy, cz);
    return { desc, signature: `box:${hx},${hy},${hz}:${cx},${cy},${cz}` };
  }
  if (result.shape.sphere !== undefined) {
    const r = result.shape.sphere;
    const radius = Math.max(MIN_EXTENT, r * Math.max(Math.abs(sx), Math.abs(sy), Math.abs(sz)));
    cy += r * sy;
    const desc = world.R.ColliderDesc.ball(radius).setTranslation(cx, cy, cz);
    return { desc, signature: `ball:${radius}:${cx},${cy},${cz}` };
  }
  return null;
}

function vector(value: unknown): Vec3 | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  const x = v['x'], y = v['y'], z = v['z'];
  return typeof x === 'number' && Number.isFinite(x) && typeof y === 'number' && Number.isFinite(y) && typeof z === 'number' && Number.isFinite(z)
    ? { x, y, z }
    : null;
}

function same3(a: Readonly<Vec3>, b: Readonly<Vec3>): boolean { return a.x === b.x && a.y === b.y && a.z === b.z; }
function same4(a: Readonly<Quat>, b: Readonly<Quat>): boolean { return a.x === b.x && a.y === b.y && a.z === b.z && a.w === b.w; }

export class RapierDynamics implements DynamicBodies {
  private readonly world: PhysicsWorld;
  private readonly host: SyncHost;
  private readonly rows = new Map<string, DynamicRecord>();

  constructor(world: PhysicsWorld, host: SyncHost) {
    this.world = world;
    this.host = host;
  }

  add(row: RowRec, spec: NormalizedBody, pose: RowWorldPose): boolean {
    if (row.parentId !== null) {
      this.host.warn(`physics ${this.world.place}: dynamic body ${row.id} must be a top-level row`);
      return false;
    }
    if (this.rows.has(row.id)) return false;
    const fit = fitCollider(this.world, row, spec, pose, this.host);
    if (!fit) {
      this.host.warn(`physics ${this.world.place}: dynamic body ${row.id} needs a box or ball collider`);
      return false;
    }
    const R = this.world.R;
    const body = this.world.raw.createRigidBody(R.RigidBodyDesc.dynamic()
      .setTranslation(pose.pos.x, pose.pos.y, pose.pos.z)
      .setRotation(pose.rot)
      .setLinearDamping(spec.linearDamping)
      .setAngularDamping(spec.angularDamping)
      .setGravityScale(spec.gravityScale)
      .setCcdEnabled(true));
    const collider = this.world.raw.createCollider(fit.desc
      .setMass(spec.mass)
      .setFriction(spec.friction)
      .setRestitution(spec.restitution)
      .setCollisionGroups(packedGroups(spec)), body);
    const owner = this.world.colliders.adopt(collider, body, { rowId: row.id, kind: 'dynamic', tags: row.tags });
    this.rows.set(row.id, { row, body, owner, gravityScale: spec.gravityScale, forces: new Map(), held: false, enabled: true, signature: fit.signature });
    return true;
  }

  remove(row: RowRec): void {
    const rec = this.rows.get(row.id);
    if (!rec || rec.row !== row) return;
    this.rows.delete(row.id);
    this.world.colliders.remove(rec.owner, false);
    this.world.raw.removeRigidBody(rec.body);
  }

  update(row: RowRec, spec: NormalizedBody): void {
    const rec = this.rows.get(row.id);
    if (!rec || rec.row !== row) return;
    const body = rec.body;
    body.setLinearDamping(spec.linearDamping);
    body.setAngularDamping(spec.angularDamping);
    rec.gravityScale = spec.gravityScale;
    if (!rec.held) body.setGravityScale(spec.gravityScale, false);
    const fit = fitCollider(this.world, row, spec, this.host.worldPose(row), this.host);
    if (fit && fit.signature !== rec.signature) {
      this.world.colliders.remove(rec.owner);
      const collider = this.world.raw.createCollider(fit.desc
        .setMass(spec.mass)
        .setFriction(spec.friction)
        .setRestitution(spec.restitution)
        .setCollisionGroups(packedGroups(spec)), body);
      rec.owner = this.world.colliders.adopt(collider, body, { rowId: row.id, kind: 'dynamic', tags: row.tags });
      rec.signature = fit.signature;
    } else {
      rec.owner.collider.setMass(spec.mass);
      rec.owner.collider.setFriction(spec.friction);
      rec.owner.collider.setRestitution(spec.restitution);
      rec.owner.collider.setCollisionGroups(packedGroups(spec));
    }
    this.wake(rec);
  }

  setEnabled(row: RowRec, on: boolean): void {
    const rec = this.rows.get(row.id);
    if (!rec || rec.row !== row || rec.enabled === on) return;
    rec.enabled = on;
    rec.owner.collider.setEnabled(on);
    if (on) this.wake(rec);
  }

  setPosition(row: RowRec, p: Vec3): void {
    const rec = this.rows.get(row.id);
    if (!rec || rec.row !== row) return;
    this.wake(rec);
    rec.body.setTranslation(p, true);
  }

  setRotation(row: RowRec, q: Quat): void {
    const rec = this.rows.get(row.id);
    if (!rec || rec.row !== row) return;
    this.wake(rec);
    rec.body.setRotation(q, true);
  }

  setVelocity(row: RowRec, v: Vec3): void {
    const rec = this.rows.get(row.id);
    if (!rec || rec.row !== row) return;
    this.wake(rec);
    rec.body.setLinvel(v, true);
  }

  setAngularVelocity(row: RowRec, w: Vec3): void {
    const rec = this.rows.get(row.id);
    if (!rec || rec.row !== row) return;
    this.wake(rec);
    rec.body.setAngvel(w, true);
  }

  setForce(row: RowRec, key: string, value: unknown | null): void {
    const rec = this.rows.get(row.id);
    if (!rec || rec.row !== row) return;
    if (value === null) rec.forces.delete(key);
    else {
      const force = typeof value === 'object' && value !== null ? vector((value as Record<string, unknown>)['force']) : null;
      if (force) rec.forces.set(key, force); else rec.forces.delete(key);
    }
    this.wake(rec);
    rec.body.resetForces(true);
    const sum = { x: 0, y: 0, z: 0 };
    for (const force of rec.forces.values()) { sum.x += force.x; sum.y += force.y; sum.z += force.z; }
    if (sum.x !== 0 || sum.y !== 0 || sum.z !== 0) rec.body.addForce(sum, true);
  }

  applyImpulse(rowId: string, impulse?: Vec3, angularImpulse?: Vec3, position?: Vec3): void {
    const rec = this.rows.get(rowId);
    if (!rec) return;
    this.wake(rec);
    if (impulse && position) rec.body.applyImpulseAtPoint(impulse, position, true);
    else if (impulse) rec.body.applyImpulse(impulse, true);
    if (angularImpulse) rec.body.applyTorqueImpulse(angularImpulse, true);
  }

  hold(row: RowRec, y: number): void {
    const rec = this.rows.get(row.id);
    if (!rec || rec.row !== row) return;
    const p = rec.body.translation();
    rec.body.setTranslation({ x: p.x, y, z: p.z }, false);
    rec.body.setLinvel(ZERO, false);
    rec.body.setAngvel(ZERO, false);
    rec.body.setGravityScale(0, false);
    rec.body.sleep();
    rec.held = true;
  }

  afterStep(_dt: number, write: SyncHost['write']): void {
    for (const rec of this.rows.values()) {
      const row = rec.row;
      if (row.parentId !== null) continue;
      const p = rec.body.translation(), q = rec.body.rotation(), v = rec.body.linvel(), w = rec.body.angvel();
      const pos = row.tf.pos, rot = row.tf.rot, vel = row.tf.vel, angVel = row.tf.angVel;
      if (same3(pos, p) && same4(rot, q) && same3(vel, v) && same3(angVel, w) && !row.tf.grounded) continue;
      write(row, { x: p.x, y: p.y, z: p.z }, { x: v.x, y: v.y, z: v.z }, false,
        { x: q.x, y: q.y, z: q.z, w: q.w }, { x: w.x, y: w.y, z: w.z });
    }
  }

  free(): void {
    for (const rec of this.rows.values()) {
      this.world.colliders.remove(rec.owner, false);
      this.world.raw.removeRigidBody(rec.body);
    }
    this.rows.clear();
  }

  private wake(rec: DynamicRecord): void {
    if (rec.held) {
      rec.body.setGravityScale(rec.gravityScale, false);
      rec.held = false;
    }
    rec.body.wakeUp();
  }
}

export const createRapierDynamics = (world: PhysicsWorld, host: SyncHost): DynamicBodies => new RapierDynamics(world, host);
