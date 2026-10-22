// Kinematic rows (motion §5.5): doors (179 rows) and the teacups. One `kinematicPositionBased` body per row (world.ts makes
// it, with the row's pack colliders attached); this module binds the row to it and hands world.ts the pose target of every
// tick, which it gives to Rapier per substep (midpoint, then target), so the velocity Rapier derives is the tick's velocity
// (it pushes dynamic bodies) and the rider carry (world.ts `carryOf`, kcc.ts) is the exact rigid motion of the body.
// Loads and forces do nothing on these bodies.
//
// Row pose ⇄ body pose. The body is made at the pose of the row's first pack instance, and for a box key that pose is the
// box's own frame (the bake folds the generator-space frame of a box soup into the instance matrix), not the row's origin:
// a door leaf's body stands at the leaf, the row at the hinge. So the binding keeps the body's pose in the ROW's frame,
// taken where the row stood when it was baked, and every target is `row pose ∘ that offset`. The row's scale is in the
// collider shapes and is not animated (no live code scales a physics row).
//
// A velocity written to a kinematic row integrates its pose each step [INF]; an angular velocity is not integrated (no live
// row has one: the teacups tween `rotation.yaw`, `authored module`).
import type { RowRec } from '../../core/types.ts';
import type { Quat, Vec3 } from './kcc.ts';
import type { KinematicBody, PhysicsWorld } from './world.ts';

export interface RowPose { pos: Vec3; rot: Quat }

export interface KinematicRow {
  readonly row: RowRec;
  readonly kb: KinematicBody;
  /** the body's pose in the row's frame */
  readonly relPos: Vec3;
  readonly relRot: Quat;
  /** the row transform objects the last target was made from (a write replaces them) */
  lastPos: Vec3 | null;
  lastRot: Quat | null;
}

/** q · v */
export function rotateVec(q: Readonly<Quat>, x: number, y: number, z: number, o: Vec3): Vec3 {
  const tx = 2 * (q.y * z - q.z * y), ty = 2 * (q.z * x - q.x * z), tz = 2 * (q.x * y - q.y * x);
  o.x = x + q.w * tx + (q.y * tz - q.z * ty);
  o.y = y + q.w * ty + (q.z * tx - q.x * tz);
  o.z = z + q.w * tz + (q.x * ty - q.y * tx);
  return o;
}

/** a · b, normalised */
export function mulQuat(a: Readonly<Quat>, b: Readonly<Quat>, o: Quat): Quat {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y, y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w, w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  const l = Math.hypot(x, y, z, w) || 1;
  o.x = x / l; o.y = y / l; o.z = z / l; o.w = w / l;
  return o;
}

const P: Vec3 = { x: 0, y: 0, z: 0 };
const Q: Quat = { x: 0, y: 0, z: 0, w: 1 };
const INV: Quat = { x: 0, y: 0, z: 0, w: 1 };

export class KinematicRows {
  private readonly world: PhysicsWorld;
  private readonly worldPose: (row: RowRec) => RowPose;
  private readonly rows = new Map<string, KinematicRow>();

  constructor(world: PhysicsWorld, worldPose: (row: RowRec) => RowPose) {
    this.world = world;
    this.worldPose = worldPose;
  }

  get size(): number { return this.rows.size; }
  get(rowId: string): KinematicRow | undefined { return this.rows.get(rowId); }

  /**
   * Bind a row to its body. `baked` is the row's pose at the time the body was made at its pack instance (the row's pose
   * of its first spawn); the body's offset in the row's frame is taken against it. The row may stand elsewhere by now (a
   * place built again with its doors open): the first `pushTargets` moves the body there.
   */
  bind(row: RowRec, kb: KinematicBody, baked: Readonly<RowPose>): KinematicRow {
    INV.x = -baked.rot.x; INV.y = -baked.rot.y; INV.z = -baked.rot.z; INV.w = baked.rot.w;
    const relPos = rotateVec(INV, kb.pos.x - baked.pos.x, kb.pos.y - baked.pos.y, kb.pos.z - baked.pos.z, { x: 0, y: 0, z: 0 });
    const relRot = mulQuat(INV, kb.rot, { x: 0, y: 0, z: 0, w: 1 });
    const k: KinematicRow = { row, kb, relPos, relRot, lastPos: null, lastRot: null };
    this.rows.set(row.id, k);
    return k;
  }

  unbind(rowId: string): KinematicRow | undefined {
    const k = this.rows.get(rowId);
    this.rows.delete(rowId);
    return k;
  }

  /** the body pose that belongs to a row pose → P, Q */
  private bodyPose(k: KinematicRow, pose: Readonly<RowPose>): void {
    rotateVec(pose.rot, k.relPos.x, k.relPos.y, k.relPos.z, P);
    P.x += pose.pos.x; P.y += pose.pos.y; P.z += pose.pos.z;
    mulQuat(pose.rot, k.relRot, Q);
  }

  /**
   * Step E, 1: every kinematic row whose pose was written since its last target (door `rotation`, the teacups' yaw tween,
   * a `feetPosition` write) gets this tick's target. `integrate` is called for a row that carries a velocity, before its
   * pose is read: the port moves the row by `velocity · dt` through the engine writeback.
   */
  pushTargets(integrate?: (row: RowRec) => void): number {
    let n = 0;
    for (const k of this.rows.values()) {
      const row = k.row;
      const tf = row.tf;
      if (integrate && (tf.vel.x !== 0 || tf.vel.y !== 0 || tf.vel.z !== 0)) integrate(row);
      // a write replaces the transform objects; a child's world pose also moves with its parent, so it is read every tick
      if (row.parentId === null && k.lastPos === row.tf.pos && k.lastRot === row.tf.rot) continue;
      const pose = row.parentId === null ? row.tf : this.worldPose(row);
      this.bodyPose(k, pose);
      k.lastPos = row.tf.pos;
      k.lastRot = row.tf.rot;
      const kb = k.kb;
      const moved = Math.abs(P.x - kb.pos.x) > 1e-7 || Math.abs(P.y - kb.pos.y) > 1e-7 || Math.abs(P.z - kb.pos.z) > 1e-7;
      const dot = Q.x * kb.rot.x + Q.y * kb.rot.y + Q.z * kb.rot.z + Q.w * kb.rot.w;
      const turned = Math.abs(dot) < 1 - 1e-12;
      if (!moved && !turned) continue;
      this.world.setKinematicTarget(kb, P, Q);
      n++;
    }
    return n;
  }

  clear(): void { this.rows.clear(); }
}
