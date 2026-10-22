// Row ⇄ Rapier body binding of ONE place (motion §5.2-§5.5, core §5.8): what a row's `physics` value becomes in the world,
// what its transform and velocity writes do to the body, and what the step writes back to the row.
//
//   kind        made of                                             velocity write        feetPosition write      writeback
//   character   world.ts `addCharacter` (capsule on a kinematic     desired velocity of   teleport, no sweep,     pos, the realised
//               body whose origin is the feet), moved by kcc.ts     the next step         ground contact cleared  velocity, grounded
//   kinematic   the row's pack body (kinematic.ts)                  integrates the pose   target of the tick      none (the row leads)
//   static      the row's pack colliders, or a fixed collider       ignored               rebuilds the colliders  none
//               from the row itself (runtime rows, sensors)
//   dynamic     PH4's `DynamicBodies` (dynamics.ts), through the narrow interface below; without one a dynamic row has no body
//   none        no body: core integrates a written velocity itself (core §5.4)
//
// The desired velocity of a character is whatever the row's `velocity` holds when the step runs: the value a script wrote
// this tick, or else the velocity the body realised in the last step (the writeback put it there). A script that reads
// `velocity` before writing it therefore sees what the body DID (`scripts/humanoid-locomotion.js` runs before
// `authored module` and depends on it), and a read after a write in the same tick returns the written value.
//
// `physics` writes (`onPhysicsWrite`):
//   same kind             a character keeps its body: capsule (`setHalfHeight` / `setRadius` on the existing collider, the feet
//                         stay planted: the crouch of `authored module`), controller parameters and groups are updated
//   "none" / false        the body stays and its colliders are disabled (a wrecked door, a closed supply terminal, a buried
//                         enemy); writing the kind back enables them again where the row stands now
//   another kind          the body is removed and made again as the new kind
// Spectating (`setSpectating`) disables the colliders the same way; the two switches are independent.
//
// Bodies and colliders are created in spawn-serial order when a place is built after its rows (the port sorts the rows it
// recorded), characters move in the order world.ts keeps (creation order), so a run is deterministic.
import type { AssetFactsPort, ColliderPack, PlaceBake } from '../../core/ports.ts';
import type { RowRec } from '../../core/types.ts';
import { PACKED_DEFAULT_GROUPS, kccKey } from '../defaults.ts';
import { liquidState, surfaceAt, swimVelocity, type LiquidState, type LiquidVolume } from '../liquid.ts';
import { m34Invert } from '../math.ts';
import { bodyKindOf, normalizeBody, packedGroups, worldCapsule, type BodyKind, type NormalizedBody } from '../spec.ts';
import type { ColliderKey } from './colliders.ts';
import type { CharacterBody, Quat, Vec3 } from './kcc.ts';
import { KinematicRows, type KinematicRow } from './kinematic.ts';
import type { RapierQueryWorld } from './query.ts';
import { TriggerTracker } from './triggers.ts';
import type { PhysicsWorld } from './world.ts';

export interface RowWorldPose { pos: Vec3; rot: Quat; scale: Vec3 }

/** a scripted primitive as the geometry service keys it (render/geometry/generator-types.ts `ScriptedSpec`) */
export interface ScriptedColliderSpec { script: string; params?: unknown; seed?: unknown }
export type ScriptedCollider = { tris: Float32Array } | { box: [number, number, number] } | { sphere: number } | null;
/** the slice of render's `GeometryService` the port uses (X-43): colliders of runtime-spawned scripted rows */
export interface ScriptedColliders {
  colliderForSync(spec: ScriptedColliderSpec): ScriptedCollider | undefined;
  colliderFor(spec: ScriptedColliderSpec): Promise<ScriptedCollider>;
}

/** what the port gives a place's sync */
export interface SyncHost {
  ignoredTags?: readonly string[];
  facts: AssetFactsPort | null;
  scripted: ScriptedColliders | null;
  /** world pose of a row (the parent chain applied) */
  worldPose(row: RowRec): RowWorldPose;
  /** `store.engineWriteTransform` */
  write(row: RowRec, pos: Vec3, vel: Vec3, grounded: boolean, rot?: Quat, angVel?: Vec3): void;
  warn(message: string): void;
}

/**
 * PH4's side (`physics/rapier/dynamics.ts`): dynamic bodies of one world. body-sync routes every dynamic row here and adds
 * no solver logic of its own. The backend creates its bodies and colliders on `world.raw`, registers them with
 * `world.colliders.adopt(collider, body, { rowId, kind: 'dynamic', tags })` so that queries and triggers know them, and
 * writes poses back in `afterStep`.
 */
export interface DynamicBodies {
  /** false when no body could be made (no shape yet): the row then has none and an impulse lands on nothing */
  add(row: RowRec, body: NormalizedBody, pose: RowWorldPose): boolean;
  remove(row: RowRec): void;
  /** `physics` rewritten with the kind still dynamic */
  update(row: RowRec, body: NormalizedBody): void;
  /** colliders off / on (spectating, `physics: "none"` on a kept body) */
  setEnabled(row: RowRec, on: boolean): void;
  setPosition(row: RowRec, p: Vec3): void;
  setRotation(row: RowRec, q: Quat): void;
  setVelocity(row: RowRec, v: Vec3): void;
  setAngularVelocity(row: RowRec, w: Vec3): void;
  setForce(row: RowRec, key: string, force: unknown | null): void;
  applyImpulse(rowId: string, impulse?: Vec3, angularImpulse?: Vec3, position?: Vec3): void;
  /** the out-of-bounds hold of motion §5.8 (`setGravityScale(0)` + `sleep()` at `y`); a later write or impulse wakes the body */
  hold?(row: RowRec, y: number): void;
  beforeStep?(dt: number): void;
  /** after the substeps: write back every body that moved */
  afterStep(dt: number, write: SyncHost['write']): void;
  free?(): void;
}
export type DynamicsFactory = (world: PhysicsWorld, host: SyncHost) => DynamicBodies;

/** a fixed or kinematic collider the binding made itself or took over from the pack, with what is needed to make it again */
interface Part {
  shape: ColliderKey;
  /** the instance matrix (3×4, key space → world) at the row's baked pose */
  m: ArrayLike<number>;
  noDecal: boolean;
  mutable: boolean;
}

export interface Binding {
  readonly row: RowRec;
  /** the kind the body was made as */
  readonly kind: BodyKind;
  /** the normalised `physics` value in force (kind null while switched to "none") */
  body: NormalizedBody;
  /** switched off by `physics: "none"`: the body is kept, its colliders are disabled */
  off: boolean;
  character: CharacterBody | null;
  kinematic: KinematicRow | null;
  /** static and kinematic rows: their colliders' sources */
  parts: Part[];
  sensor: boolean;
  dynamic: boolean;
  /** static: the row transform objects seen when the colliders were last seated (a write replaces them) */
  seatPos: Vec3 | null;
  seatRot: Quat | null;
  /** static: the world pose the colliders stand at */
  seat: { pos: Vec3; rot: Quat } | null;
  liquid: LiquidState | null;
  /** `records()`: the record last made of this body, handed out again while every value in it still holds */
  record: BodyRecord | null;
  /** `records()`: the baked / made pose object `record.baked` was copied from */
  recordFrom: object | null;
  /**
   * `records()`: the size of the baked-pose map when `recordFrom` was looked up. That map only ever gains entries and a
   * row's made pose lives exactly as long as its binding, so while the size holds the lookup would answer the same
   */
  recordBakedSize: number;
}

/** what nav's overlay and the debug views read of a body, without touching the wasm (motion §14, NV2) */
export interface BodyRecord {
  rowId: string;
  kind: BodyKind;
  /** colliding now (not spectating, not switched to "none") */
  enabled: boolean;
  sensor: boolean;
  /** world feet / origin of the row */
  pos: Vec3;
  rot: Quat;
  /** characters: world capsule */
  capsule?: { height: number; radius: number };
  /** static and kinematic rows: key shapes and their instance matrices at the baked pose, with the pose they were baked at */
  parts?: ReadonlyArray<{ shape: ColliderKey; m: ArrayLike<number> }>;
  baked?: { pos: Vec3; rot: Quat };
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const same3 = (a: Readonly<Vec3>, b: Readonly<Vec3>): boolean => a.x === b.x && a.y === b.y && a.z === b.z;

/** translation · rotation · scale as a 3×4 column-major matrix */
export function poseM34(pos: Readonly<Vec3>, rot: Readonly<Quat>, scale: Readonly<Vec3>): Float64Array {
  const l = Math.hypot(rot.x, rot.y, rot.z, rot.w) || 1;
  const x = rot.x / l, y = rot.y / l, z = rot.z / l, w = rot.w / l;
  const xx = x * x, yy = y * y, zz = z * z, xy = x * y, xz = x * z, yz = y * z, wx = w * x, wy = w * y, wz = w * z;
  return new Float64Array([
    (1 - 2 * (yy + zz)) * scale.x, 2 * (xy + wz) * scale.x, 2 * (xz - wy) * scale.x,
    2 * (xy - wz) * scale.y, (1 - 2 * (xx + zz)) * scale.y, 2 * (yz + wx) * scale.y,
    2 * (xz + wy) * scale.z, 2 * (yz - wx) * scale.z, (1 - 2 * (xx + yy)) * scale.z,
    pos.x, pos.y, pos.z,
  ]);
}

/** a · b: `b` first, then `a` */
export function mulM34(a: ArrayLike<number>, b: ArrayLike<number>): Float64Array {
  const out = new Float64Array(12);
  for (let c = 0; c < 4; c++) {
    const x = b[c * 3]!, y = b[c * 3 + 1]!, z = b[c * 3 + 2]!;
    out[c * 3] = a[0]! * x + a[3]! * y + a[6]! * z + (c === 3 ? a[9]! : 0);
    out[c * 3 + 1] = a[1]! * x + a[4]! * y + a[7]! * z + (c === 3 ? a[10]! : 0);
    out[c * 3 + 2] = a[2]! * x + a[5]! * y + a[8]! * z + (c === 3 ? a[11]! : 0);
  }
  return out;
}

/**
 * The collider of a row that is not in the pack (a runtime row, a sensor), by the bake's own rules (tools/maps/pack-build.ts
 * header; motion §4.2 `collider: 'auto'`):
 *   primitive `scripted`  the generator's collider, from the geometry service's memory (X-43); `pending` when it is not there
 *   primitive `box`       `width` / `height` / `depth` or `size`, standing on the row's origin
 *   primitive `sphere`    `radius`, centred one radius above the origin
 *   model                 the box of the model's bounds (asset facts), seated where the bounds are
 *   `collider.dims`       an explicit box [w, h, d] or sphere [r]
 * `frame` is the key space → row space transform when it is not the identity. null: the row gives no shape (warned once).
 */
export function rowShape(row: RowRec, body: Readonly<NormalizedBody>, host: Pick<SyncHost, 'facts' | 'scripted'>): { shape: ColliderKey; frame: Float64Array | null } | 'pending' | null {
  const want = body.collider.kind;
  const dims = body.collider.dims;
  if (dims && want === 'box' && dims.length >= 3 && dims[0]! > 0 && dims[1]! > 0 && dims[2]! > 0) return { shape: { id: `row:${row.id}`, box: [dims[0]!, dims[1]!, dims[2]!] }, frame: null };
  if (dims && want === 'sphere' && dims.length >= 1 && dims[0]! > 0) return { shape: { id: `row:${row.id}`, sphere: dims[0]! }, frame: null };
  const prim = row.props['primitive'];
  if (isObj(prim)) {
    const kind = prim['kind'];
    if (kind === 'scripted' && typeof prim['script'] === 'string') {
      if (!host.scripted) return null;
      const spec: ScriptedColliderSpec = { script: prim['script'] };
      if (prim['params'] !== undefined) spec.params = prim['params'];
      if (prim['seed'] !== undefined) spec.seed = prim['seed'];
      const c = host.scripted.colliderForSync(spec);
      if (c === undefined) return 'pending';
      if (c === null) return null;
      const id = `row:${row.id}`;
      if ('box' in c) return { shape: { id, box: [c.box[0], c.box[1], c.box[2]] }, frame: null };
      if ('sphere' in c) return { shape: { id, sphere: c.sphere }, frame: null };
      return { shape: { id, tris: c.tris }, frame: null };
    }
    if (kind === 'box' && (want === 'auto' || want === 'box')) {
      const size = num(prim['size'], 1);
      const w = num(prim['width'], size), h = num(prim['height'], size), d = num(prim['depth'], size);
      return w > 0 && h > 0 && d > 0 ? { shape: { id: `box:${w}x${h}x${d}`, box: [w, h, d] }, frame: null } : null;
    }
    if (kind === 'sphere' && (want === 'auto' || want === 'sphere')) {
      const r = num(prim['radius'], 0.5);
      return r > 0 ? { shape: { id: `sphere:${r}`, sphere: r }, frame: null } : null;
    }
    return null;
  }
  const model = row.props['model'];
  const ref = typeof model === 'string' ? model : isObj(model) ? (model['id'] ?? model['src']) : null;
  if (typeof ref === 'string' && host.facts) {
    const b = host.facts.get(ref)?.bounds;
    if (b && b.size[0] > 0 && b.size[1] > 0 && b.size[2] > 0) {
      if (want === 'sphere') {
        const r = (b.size[0] + b.size[1] + b.size[2]) / 6;
        return { shape: { id: `sphere:${r}`, sphere: r }, frame: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1, b.center[0], b.center[1] - r, b.center[2]]) };
      }
      return {
        shape: { id: `box:${b.size[0]}x${b.size[1]}x${b.size[2]}`, box: [b.size[0], b.size[1], b.size[2]] },
        frame: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1, (b.min[0] + b.max[0]) / 2, b.min[1], (b.min[2] + b.max[2]) / 2]),
      };
    }
  }
  return null;
}

/** the size of the stand-in collider of a scripted row whose generator has not answered yet (X-43: swapped when it does) */
const PROVISIONAL_BOX: [number, number, number] = [0.5, 0.5, 0.5];

/** per bake: the pose every static / kinematic row had when it was first bound (the pose its pack instances were baked at) */
const BAKED = new WeakMap<PlaceBake, Map<string, { pos: Vec3; rot: Quat; scale: Vec3 }>>();

/**
 * The pose a pack row SPAWNED with, noted by the port while the place's build is still stored (X-32). The pack's instances
 * stand at that pose; the row may move before the world exists (the teacups' yaw tween runs while the Rapier chunk loads,
 * a door swings), and a baked pose taken only at the build would leave its collider off by that move for good. The first
 * note per bake and row stays, as the first binding does.
 */
export function noteBakedPose(bake: PlaceBake, rowId: string, pose: Readonly<RowWorldPose>): void {
  let baked = BAKED.get(bake);
  if (!baked) BAKED.set(bake, baked = new Map());
  if (!baked.has(rowId)) baked.set(rowId, { pos: { ...pose.pos }, rot: { ...pose.rot }, scale: { ...pose.scale } });
}

/** the same number, -0 told from 0 (a NaN never holds: its record is made again) */
const sameN = (a: number, b: number): boolean => a === b && (a !== 0 || 1 / a === 1 / b);
const sameV = (a: Readonly<Vec3>, b: Readonly<Vec3>): boolean => sameN(a.x, b.x) && sameN(a.y, b.y) && sameN(a.z, b.z);
const sameQ = (a: Readonly<Quat>, b: Readonly<Quat>): boolean => sameN(a.x, b.x) && sameN(a.y, b.y) && sameN(a.z, b.z) && sameN(a.w, b.w);

/** `records()`: would a record made of this body now equal `rec` in every value (and in the shape objects it shares)? */
function recordHolds(
  rec: BodyRecord, b: Binding, pose: { readonly pos: Readonly<Vec3>; readonly rot: Readonly<Quat> },
  baked: { pos: Vec3; rot: Quat } | undefined,
): boolean {
  if (rec.kind !== b.kind || rec.enabled !== (!b.off && !b.row.spectating) || rec.sensor !== b.sensor) return false;
  if (!sameV(rec.pos, pose.pos) || !sameQ(rec.rot, pose.rot)) return false;
  if (b.character) {
    const c = rec.capsule;
    return !!c && rec.parts === undefined && sameN(c.height, b.character.height) && sameN(c.radius, b.character.radius);
  }
  if (rec.capsule !== undefined) return false;
  const parts = rec.parts;
  if (b.parts.length === 0) return parts === undefined && rec.baked === undefined;
  if (!parts || parts.length !== b.parts.length) return false;
  for (let i = 0; i < parts.length; i++) {
    const p = b.parts[i]!, q = parts[i]!;
    if (q.shape !== p.shape || q.m !== p.m) return false;
  }
  const rb = rec.baked;
  if (!baked) return rb === undefined;
  return !!rb && sameV(rb.pos, baked.pos) && sameQ(rb.rot, baked.rot);
}

export class BodySync {
  readonly world: PhysicsWorld;
  readonly query: RapierQueryWorld;
  readonly triggers: TriggerTracker;
  readonly kinematics: KinematicRows;
  readonly bindings = new Map<string, Binding>();
  dynamics: DynamicBodies | null = null;
  liquids: readonly LiquidVolume[] = [];
  private readonly host: SyncHost;
  private readonly bake: PlaceBake;
  /** pack instances by row */
  private readonly packRows = new Map<string, ColliderPack['instances']>();
  /** pack rows: kept with the bake, so a place built again knows where its rows were baked */
  private readonly baked: Map<string, { pos: Vec3; rot: Quat; scale: Vec3 }>;
  /** runtime rows: the pose their colliders were made at, for as long as the row lives */
  private readonly made = new Map<string, { pos: Vec3; rot: Quat; scale: Vec3 }>();
  /** static bindings (their rows may be moved: checked every step) */
  private readonly statics: Binding[] = [];
  private readonly warned = new Set<string>();
  /** character bindings in creation order (the order world.ts moves them in) */
  private readonly characters: Binding[] = [];
  private readonly integrate: (row: RowRec) => void;
  private stepDt = 1 / 30;

  constructor(world: PhysicsWorld, query: RapierQueryWorld, bake: PlaceBake, host: SyncHost) {
    this.world = world;
    this.query = query;
    this.bake = bake;
    this.host = host;
    this.triggers = new TriggerTracker(world);
    this.kinematics = new KinematicRows(world, (row) => host.worldPose(row));
    let baked = BAKED.get(bake);
    if (!baked) BAKED.set(bake, baked = new Map());
    this.baked = baked;
    for (const inst of bake.colliders.instances) {
      const list = this.packRows.get(inst.rowId);
      if (list) list.push(inst); else this.packRows.set(inst.rowId, [inst]);
      query.children.add(inst.rowId);
    }
    this.integrate = (row) => {
      const p = row.tf.pos, v = row.tf.vel, dt = this.stepDt;
      host.write(row, { x: p.x + v.x * dt, y: p.y + v.y * dt, z: p.z + v.z * dt }, v, false);
    };
  }

  private warnOnce(key: string, message: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.host.warn(message);
  }

  // ── spawn / destroy ────────────────────────────────────────────────────────────────────────────────────────────────────

  /** the body of a row from its `physics` value; a row that has one already keeps it */
  spawn(row: RowRec): Binding | null {
    const known = this.bindings.get(row.id);
    if (known?.row === row) return known;
    if (known) {
      // the id lives on in another record: the old body goes first
      this.bindings.delete(row.id);
      this.remove(known);
    }
    const body = normalizeBody(row.props['physics'], row, this.host.facts);
    const packed = this.packRows.get(row.id);
    // a pack row whose `physics` reads "none" now (a wrecked door in a place that was built again): its colliders stay, off
    const kind: BodyKind | null = body.kind ?? (packed && packed.length > 0 ? (packed[0]!.kinematic ? 'kinematic' : 'static') : null);
    if (kind === null) return null;
    // A scene row that was authored static or kinematic and has no instance in the pack: the bake ran its generator and
    // found no collider (a scripted prop whose `collider(ctx)` answers null: 1 live row in scorched-quarter alone). The
    // bake is the authority for scene rows; only a trigger is left out of it on purpose (motion §5.7) and made here.
    if ((kind === 'static' || kind === 'kinematic') && !(packed && packed.length > 0) && !body.sensor && row.fromScene !== null) {
      const authored = bodyKindOf(row.spec['physics']);
      if (authored === 'static' || authored === 'kinematic') return null;
    }
    const b = this.make(row, kind, body);
    if (!b) return null;
    this.bindings.set(row.id, b);
    if (body.kind === null) this.switchOff(b, true);
    else if (row.spectating) this.enable(b);
    return b;
  }

  private make(row: RowRec, kind: BodyKind, body: NormalizedBody): Binding | null {
    const b: Binding = {
      row, kind, body, off: false, character: null, kinematic: null, parts: [], sensor: body.sensor && kind === 'static', dynamic: false,
      seatPos: null, seatRot: null, seat: null, liquid: null, record: null, recordFrom: null, recordBakedSize: -1,
    };
    const pose = this.host.worldPose(row);
    if (kind === 'character') {
      const cap = worldCapsule(body.capsule ?? { height: 1.9, radius: 0.35 }, pose.scale);
      b.character = this.world.addCharacter({
        rowId: row.id, feet: pose.pos, height: cap.height, radius: cap.radius, groups: packedGroups(body), tags: row.tags,
        ...(body.kcc ? { params: body.kcc } : {}),
        ...(body.continuous ? { continuous: true } : {}),
      });
      this.characters.push(b);
      this.query.children.add(row.id);
      return b;
    }
    if (kind === 'dynamic') {
      if (!this.dynamics) {
        this.warnOnce('dynamics', `physics ${this.world.place}: dynamic bodies are not available in this build (PH4); ${row.id} and the like get no body`);
        return null;
      }
      if (!this.dynamics.add(row, body, pose)) return null;
      b.dynamic = true;
      this.query.children.add(row.id);
      return b;
    }
    // static / kinematic
    const packed = this.packRows.get(row.id);
    const set = this.world.colliders;
    const poses = packed && packed.length > 0 ? this.baked : this.made;
    let baked = poses.get(row.id);
    if (!baked) poses.set(row.id, baked = { pos: { ...pose.pos }, rot: { ...pose.rot }, scale: { ...pose.scale } });
    if (packed && packed.length > 0 && !b.sensor) {
      for (const inst of packed) {
        const shape = this.bake.colliders.keys[inst.key];
        if (shape) b.parts.push({ shape, m: inst.m, noDecal: inst.noDecal, mutable: inst.mutable });
      }
      if (set.ownersOf(row.id).length > 0) {
        // the pack built them (the build runs before the scene batch): take them over, with the row's tags
        set.setRowTags(row.id, row.tags);
      } else {
        // a pack row whose body was removed by a kind swap and is static / kinematic again: its pack shapes, made again
        for (const part of b.parts) this.addPart(b, part, part.m);
        this.query.children.add(row.id);
      }
    } else {
      if (packed && packed.length > 0) for (const rec of [...set.ownersOf(row.id)]) set.remove(rec);
      const got = rowShape(row, body, this.host);
      let shape: ColliderKey | null = null;
      let frame: Float64Array | null = null;
      if (got === 'pending') {
        shape = { id: `provisional:${row.id}`, box: PROVISIONAL_BOX };
        this.swapWhenReady(row);
      } else if (got) { shape = got.shape; frame = got.frame; }
      if (!shape) {
        this.made.delete(row.id);
        this.warnOnce(`shape:${row.id}`, `physics ${this.world.place}: no collider could be derived for the ${kind} body of ${row.id} (primitive, model bounds, geometry service); it gets none`);
        return null;
      }
      const world = poseM34(baked.pos, baked.rot, baked.scale);
      const part: Part = { shape, m: frame ? mulM34(world, frame) : world, noDecal: row.tags.some(tag => this.host.ignoredTags?.includes(tag)) || row.props['visible'] === false || row.props['render'] === false, mutable: true };
      b.parts.push(part);
      this.addPart(b, part, part.m);
      this.query.children.add(row.id);
    }
    if (kind === 'kinematic') {
      const kb = this.world.kinematicOf(row.id);
      if (!kb) return null;
      b.kinematic = this.kinematics.bind(row, kb, baked);
    } else {
      // the colliders stand at the baked pose; a row that stands elsewhere by now is seated in the next step
      b.seat = { pos: { ...baked.pos }, rot: { ...baked.rot } };
      this.statics.push(b);
    }
    return b;
  }

  private addPart(b: Binding, part: Part, m: ArrayLike<number>): void {
    const rec = this.world.colliders.addInstance({
      rowId: b.row.id, shape: part.shape, m: m as Float64Array, kind: b.kind === 'kinematic' ? 'kinematic' : 'static', mutable: part.mutable,
      noDecal: part.noDecal, tags: b.row.tags, sensor: b.sensor,
      groups: b.body.kind !== null ? packedGroups(b.body) : PACKED_DEFAULT_GROUPS,
    });
    if (rec && b.sensor) this.triggers.arm(rec);
    if (rec && (b.off || b.row.spectating)) rec.collider.setEnabled(false);
  }

  /** X-43: the generator's collider arrives later; the stand-in box is replaced when it does */
  private swapWhenReady(row: RowRec): void {
    const prim = row.props['primitive'];
    const scripted = this.host.scripted;
    if (!scripted || !isObj(prim) || typeof prim['script'] !== 'string') return;
    const spec: ScriptedColliderSpec = { script: prim['script'] };
    if (prim['params'] !== undefined) spec.params = prim['params'];
    if (prim['seed'] !== undefined) spec.seed = prim['seed'];
    scripted.colliderFor(spec).then(() => {
      const b = this.bindings.get(row.id);
      if (!b || b.row !== row || this.world.freed || b.character || b.dynamic) return;
      const got = rowShape(row, b.body, this.host);
      if (!got || got === 'pending') return;
      const part = b.parts[0];
      if (!part) return;
      part.shape = got.shape;
      this.reseat(b, true);
    }, () => undefined);
  }

  destroy(row: RowRec): void {
    const b = this.bindings.get(row.id);
    if (!b || b.row !== row) return;
    this.bindings.delete(row.id);
    this.remove(b);
  }

  private remove(b: Binding): void {
    const id = b.row.id;
    this.triggers.forget(id);
    this.query.children.remove(id);
    if (b.character) {
      this.world.removeCharacter(b.character);
      const i = this.characters.indexOf(b);
      if (i >= 0) this.characters.splice(i, 1);
    } else if (b.dynamic) this.dynamics?.remove(b.row);
    else if (b.kinematic) {
      this.kinematics.unbind(id);
      this.world.removeKinematicBody(b.kinematic.kb);
    } else {
      this.world.colliders.removeRow(id);
      const i = this.statics.indexOf(b);
      if (i >= 0) this.statics.splice(i, 1);
    }
    this.made.delete(id);
  }

  // ── switches ───────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** colliders on only while the body is neither switched to "none" nor spectating */
  private enable(b: Binding): void {
    const on = !b.off && !b.row.spectating;
    if (b.character) {
      if (b.character.enabled !== on) {
        this.world.setCharacterEnabled(b.character, on);
        if (on) this.world.teleportCharacter(b.character, this.host.worldPose(b.row).pos);
      }
    } else if (b.dynamic) this.dynamics?.setEnabled(b.row, on);
    else this.world.colliders.setRowEnabled(b.row.id, on);
    if (!on) this.triggers.forget(b.row.id);
  }

  private switchOff(b: Binding, off: boolean): void {
    b.off = off;
    this.enable(b);
  }

  setSpectating(row: RowRec): void {
    const b = this.bindings.get(row.id);
    if (b) this.enable(b);
  }

  /** the `physics` channel */
  physicsWrite(row: RowRec, value: unknown): void {
    const b = this.bindings.get(row.id);
    if (!b) { this.spawn(row); return; }
    const body = normalizeBody(value, row, this.host.facts);
    if (body.kind === null) {
      b.body = body;
      if (!b.off) this.switchOff(b, true);
      return;
    }
    if (body.kind !== b.kind || (body.sensor && b.kind === 'static') !== b.sensor) {
      // another kind of body: out and in again (it joins the end of the creation order)
      this.bindings.delete(row.id);
      this.remove(b);
      this.spawn(row);
      return;
    }
    const before = b.body;
    b.body = body;
    if (b.character) this.updateCharacter(b, before);
    else if (b.dynamic) this.dynamics?.update(row, body);
    if (b.off) this.switchOff(b, false);
  }

  private updateCharacter(b: Binding, before: Readonly<NormalizedBody>): void {
    const c = b.character!;
    const body = b.body;
    const cap = worldCapsule(body.capsule ?? { height: 1.9, radius: 0.35 }, this.host.worldPose(b.row).scale);
    if (cap.height !== c.height || cap.radius !== c.radius) this.world.setCapsule(c, cap.height, cap.radius);
    if (body.kcc && (!before.kcc || kccKey(body.kcc) !== kccKey(c.params))) this.world.setCharacterParams(c, body.kcc);
    const groups = packedGroups(body);
    if (groups !== c.groups) {
      c.groups = groups;
      c.collider.setCollisionGroups(groups);
    }
  }

  // ── transform writes ───────────────────────────────────────────────────────────────────────────────────────────────────

  setPosition(row: RowRec, p: Vec3): void {
    const b = this.bindings.get(row.id);
    if (!b) return;
    if (b.character) this.world.teleportCharacter(b.character, row.parentId === null ? p : this.host.worldPose(row).pos);
    else if (b.dynamic) this.dynamics?.setPosition(row, row.parentId === null ? p : this.host.worldPose(row).pos);
    // kinematic rows: the next `pushTargets` reads the row; static rows: `reseat` in the next step
  }

  setRotation(row: RowRec, q: Quat): void {
    const b = this.bindings.get(row.id);
    // a character's capsule stands upright whatever its row's yaw
    if (b?.dynamic) this.dynamics?.setRotation(row, row.parentId === null ? q : this.host.worldPose(row).rot);
  }

  setVelocity(row: RowRec, v: Vec3): void {
    const b = this.bindings.get(row.id);
    if (b?.dynamic) this.dynamics?.setVelocity(row, v);
    // characters: the step reads `row.tf.vel` (header); kinematic rows integrate it; static rows ignore it
  }

  setAngularVelocity(row: RowRec, w: Vec3): void {
    const b = this.bindings.get(row.id);
    if (b?.dynamic) this.dynamics?.setAngularVelocity(row, w);
  }

  setForce(row: RowRec, key: string, force: unknown | null): void {
    const b = this.bindings.get(row.id);
    if (b?.dynamic) this.dynamics?.setForce(row, key, force);
  }

  /** a static row was moved or turned (or its collider arrived): its colliders are made again where it stands */
  private reseat(b: Binding, force = false): void {
    const row = b.row;
    const baked = this.baked.get(row.id) ?? this.made.get(row.id);
    if (!baked) return;
    const pose = row.parentId === null ? { pos: row.tf.pos, rot: row.tf.rot, scale: baked.scale } : this.host.worldPose(row);
    b.seatPos = row.tf.pos;
    b.seatRot = row.tf.rot;
    const seat = b.seat;
    if (!force && seat && same3(seat.pos, pose.pos) && seat.rot.x === pose.rot.x && seat.rot.y === pose.rot.y && seat.rot.z === pose.rot.z && seat.rot.w === pose.rot.w) return;
    if (seat) {
      seat.pos.x = pose.pos.x; seat.pos.y = pose.pos.y; seat.pos.z = pose.pos.z;
      seat.rot.x = pose.rot.x; seat.rot.y = pose.rot.y; seat.rot.z = pose.rot.z; seat.rot.w = pose.rot.w;
    }
    const inv = new Float64Array(12);
    if (!m34Invert(poseM34(baked.pos, baked.rot, baked.scale), inv)) return;
    // instance matrix now = row world now · (row world baked)⁻¹ · instance matrix baked
    const delta = mulM34(poseM34(pose.pos, pose.rot, baked.scale), inv);
    if (b.kinematic) {
      for (const rec of [...this.world.colliders.ownersOf(row.id)]) this.world.colliders.remove(rec);
    } else this.world.colliders.removeRow(row.id);
    this.triggers.forget(row.id);
    for (const part of b.parts) this.addPart(b, part, mulM34(delta, part.m));
  }

  // ── step E ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

  step(dt: number): void {
    const world = this.world;
    const host = this.host;
    this.stepDt = dt;
    // statics that were moved since the last step (rare: a transform write on a mutable static row)
    for (let i = 0; i < this.statics.length; i++) {
      const b = this.statics[i]!;
      if (b.seatPos !== b.row.tf.pos || b.seatRot !== b.row.tf.rot || b.row.parentId !== null) this.reseat(b);
    }
    // 1. kinematic rows take their pose from their rows
    this.kinematics.pushTargets(this.integrate);
    // 2. what every character wants
    const level = surfaceAt(this.liquids);
    for (let i = 0; i < this.characters.length; i++) {
      const b = this.characters[i]!;
      const c = b.character!;
      const row = b.row;
      const d = c.desiredVelocity;
      if (!c.enabled || row.parentId !== null) {
        // seated or out of the world: the row leads (a parent carries it, or its script moves it), the body follows
        d.x = 0; d.y = 0; d.z = 0;
        if (row.parentId !== null && c.enabled) world.teleportCharacter(c, host.worldPose(row).pos);
        continue;
      }
      const v = row.tf.vel;
      // a velocity that is not a number never reaches the wasm (it would poison the body's position for good)
      if (!Number.isFinite(v.x + v.y + v.z)) { d.x = 0; d.y = 0; d.z = 0; continue; }
      d.x = v.x; d.z = v.z;
      d.y = level === null ? v.y : swimVelocity(c.feet.y, v.y, dt, level, c.height);
    }
    this.dynamics?.beforeStep?.(dt);
    // 3-4. controller pass, commit, two substeps (world.ts); collision events go to the trigger tracker
    world.step(dt);
    // writeback: the target of a character is exact, so position, realised velocity and grounded are final
    for (let i = 0; i < this.characters.length; i++) {
      const b = this.characters[i]!;
      const c = b.character!;
      const row = b.row;
      if (!c.enabled || row.parentId !== null) continue;
      const vel = c.velocity;
      if (level !== null) {
        b.liquid = liquidState(c.feet.y, c.height, level);
        // a floating body reads no vertical speed (motion §5.9): its script's gravity must not pile up
        if (b.liquid.swimming) vel.y = 0;
      }
      const tf = row.tf;
      if (same3(tf.pos, c.feet) && same3(tf.vel, vel) && tf.grounded === c.grounded) continue;
      host.write(row, c.feet, vel, c.grounded);
    }
    this.dynamics?.afterStep(dt, host.write);
  }

  // ── records ────────────────────────────────────────────────────────────────────────────────────────────────────────────

  liquidOf(rowId: string): LiquidState | null {
    return this.bindings.get(rowId)?.liquid ?? null;
  }

  /**
   * every body of the place as plain data, in creation order (no wasm read). Read every sim tick by nav's overlay: a body
   * whose record would come out value for value the same as last time gets that record object again (records are read,
   * never written, by their consumers), so a still place costs comparisons instead of copies.
   */
  records(): BodyRecord[] {
    const out: BodyRecord[] = [];
    for (const b of this.bindings.values()) {
      const pose = b.row.parentId === null ? b.row.tf : this.host.worldPose(b.row);
      const last = b.record;
      const baked = b.character || b.parts.length === 0 ? undefined
        : last && last.parts !== undefined && b.recordBakedSize === this.baked.size ? (b.recordFrom as { pos: Vec3; rot: Quat } | null) ?? undefined
        : this.baked.get(b.row.id) ?? this.made.get(b.row.id);
      if (last && b.recordFrom === (baked ?? null) && recordHolds(last, b, pose, baked)) { out.push(last); continue; }
      const rec: BodyRecord = {
        rowId: b.row.id, kind: b.kind, enabled: !b.off && !b.row.spectating, sensor: b.sensor,
        pos: { x: pose.pos.x, y: pose.pos.y, z: pose.pos.z }, rot: { x: pose.rot.x, y: pose.rot.y, z: pose.rot.z, w: pose.rot.w },
      };
      if (b.character) rec.capsule = { height: b.character.height, radius: b.character.radius };
      else if (b.parts.length > 0) {
        rec.parts = b.parts.map((p) => ({ shape: p.shape, m: p.m }));
        if (baked) rec.baked = { pos: { ...baked.pos }, rot: { ...baked.rot } };
      }
      b.record = rec;
      b.recordFrom = baked ?? null;
      b.recordBakedSize = this.baked.size;
      out.push(rec);
    }
    return out;
  }

  clear(): void {
    this.dynamics?.free?.();
    this.bindings.clear();
    this.characters.length = 0;
    this.statics.length = 0;
    this.made.clear();
    this.kinematics.clear();
    this.triggers.clear();
    this.query.children.clear();
  }
}
