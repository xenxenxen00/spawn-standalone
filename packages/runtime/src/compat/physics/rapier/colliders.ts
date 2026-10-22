// ColliderPack → Rapier colliders (motion §4.3). Every pack instance becomes ONE collider with an owner record (collider
// handle → row id, body kind, interned tag mask, `noDecal`), so a hit maps to its row without a per-triangle index and tag
// filters run per collider:
//   key `box`    → `ColliderDesc.cuboid` up to defaults.CUBOID_MAX_HALF_EXTENT, beyond it a trimesh of the six faces
//   key `sphere` → `ColliderDesc.ball`
//   (the pack's key convention: render pack.ts `PackedCollider`, tools/maps/box-soup.ts, nav bake `soupParts`. `box` is the
//   FULL size [w, h, d] of a box STANDING ON the key origin (x ± w/2, y 0..h, z ± d/2), `sphere` a ball of that radius
//   centred at (0, r, 0). So the half extents are size / 2 and the collider's centre is the instance origin lifted by half
//   the height, or by the radius, along the instance's up axis.)
//   key `tris`   → `ColliderDesc.trimesh` (soup welded once per key, flags = defaults.TRIMESH_FLAGS)
//   `terrain`    → one trimesh, owner `terrain/<place>`
// Every trimesh is cut until no triangle edge exceeds defaults.MAX_TRIANGLE_EDGE. Both limits exist for the character
// controller (measured on Rapier 0.21, single precision): on a large cuboid or a large triangle its shape casts lose
// centimetres, the feet sink or hop, and a body that ends inside a solid cuboid is ignored by every later cast and falls
// through. On triangles of a few metres it stands at the offset and never sinks.
// Immutable and mutable instances are parentless (fixed) colliders at the instance transform; mutable ones are toggled with
// `Collider.setEnabled` and rebuilt by remove + add. Kinematic instances hang on the `kinematicPositionBased` body the world
// supplies (one per row), seated by their matrix relative to that body wherever it stands. Scale is folded into the shape
// (a Rapier collider has none).
//
// Colliders become visible to rays and to the character controller at the next `world.step()` (world.ts `refresh()`).
import type { Collider, ColliderDesc, RigidBody, World } from '@dimforge/rapier3d-simd-compat';
import type { ColliderPack } from '../../core/ports.ts';
import {
  CUBOID_MAX_HALF_EXTENT, MAX_STEEP_TRIANGLE_EDGE, MAX_TRIANGLE_EDGE, PACKED_DEFAULT_GROUPS, TRIMESH_FLAGS, WALKABLE_NORMAL_Y,
} from '../defaults.ts';
import type { BodyKind } from '../query.ts';
import type { Rapier } from './loader.ts';

export type ColliderKey = ColliderPack['keys'][number];
export type Mat34 = Float32Array | Float64Array | readonly number[];
export interface Vec3Like { x: number; y: number; z: number }
export interface QuatLike { x: number; y: number; z: number; w: number }

// ── tags ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** tag → bit, first come first served; the 33rd distinct tag gets none and is matched through `OwnerRecord.tags` */
export class TagInterner {
  private readonly bits = new Map<string, number>();

  /** bit index 0-31, or -1 when the mask is full */
  bit(tag: string): number {
    let b = this.bits.get(tag);
    if (b === undefined) {
      b = this.bits.size < 32 ? this.bits.size : -1;
      if (b >= 0) this.bits.set(tag, b);
    }
    return b;
  }

  /** mask of a row's tags (tags without a bit are left to the tag array) */
  mask(tags: readonly string[]): number {
    let m = 0;
    for (const t of tags) {
      const b = this.bit(t);
      if (b >= 0) m |= 1 << b;
    }
    return m >>> 0;
  }

  /** mask of a filter list, or null when one of its tags has no bit: the caller then compares tag arrays */
  filterMask(tags: readonly string[]): number | null {
    let m = 0;
    for (const t of tags) {
      const b = this.bits.get(t);
      if (b === undefined) {
        // unknown so far: no collider carries it (a full table may also hide it)
        if (this.bits.size >= 32) return null;
        continue;
      }
      m |= 1 << b;
    }
    return m >>> 0;
  }

  /** true when `tag` was never seen on any collider (and the table is not full): a `tags: [tag]` filter matches nothing */
  unknown(tag: string): boolean {
    return this.bits.size < 32 && !this.bits.has(tag);
  }
}

// ── owner records ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface OwnerRecord {
  /** Rapier collider handle (changes when the instance is rebuilt) */
  readonly handle: number;
  /** the owning row; `terrain/<place>` for the heightmap (which `getObject` answers null for: static geometry) */
  readonly rowId: string | null;
  readonly kind: BodyKind;
  readonly tags: readonly string[];
  readonly tagMask: number;
  /** X-45: the row renders nothing or is tagged `bounds` */
  readonly noDecal: boolean;
  /** the row has a behavior: it may toggle or rebuild this collider later */
  readonly mutable: boolean;
  /** triggers never stop rays or characters */
  readonly sensor: boolean;
  readonly collider: Collider;
  /** the kinematic body the collider hangs on; null for fixed colliders */
  readonly body: RigidBody | null;
  readonly triangles: number;
}

export interface InstanceSpec {
  rowId: string | null;
  shape: ColliderKey;
  /** 12 floats, 3×4 world transform (column-major rotation·scale, then translation) */
  m: Mat34;
  kind?: 'static' | 'kinematic';
  mutable?: boolean;
  noDecal?: boolean;
  tags?: readonly string[];
  /** packed `InteractionGroups`; default: member of everything, meets everything */
  groups?: number;
  sensor?: boolean;
}

export interface PackStats { colliders: number; triangles: number }

// ── geometry helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────

interface Welded { vertices: Float32Array; indices: Uint32Array }

const F32 = new Float32Array(3);
const U32 = new Uint32Array(F32.buffer);

/** unindexed triangle soup (9 floats per triangle) → shared vertices + indices (exact float match; `-0` equals `0`) */
export function weldSoup(tris: Float32Array): Welded {
  const count = Math.floor(tris.length / 3);
  let cap = 16;
  while (cap < count * 2) cap <<= 1;
  const table = new Int32Array(cap).fill(-1);
  const vertices = new Float32Array(count * 3);
  const indices = new Uint32Array(count);
  let n = 0;
  for (let i = 0; i < count; i++) {
    const x = tris[i * 3]! + 0, y = tris[i * 3 + 1]! + 0, z = tris[i * 3 + 2]! + 0;
    F32[0] = x; F32[1] = y; F32[2] = z;
    let h = (Math.imul(U32[0]!, 0x9e3779b1) ^ Math.imul(U32[1]!, 0x85ebca6b) ^ Math.imul(U32[2]!, 0xc2b2ae35)) >>> 0;
    h = (h ^ (h >>> 15)) & (cap - 1);
    for (;;) {
      const v = table[h]!;
      if (v < 0) {
        table[h] = n;
        vertices[n * 3] = x; vertices[n * 3 + 1] = y; vertices[n * 3 + 2] = z;
        indices[i] = n++;
        break;
      }
      if (vertices[v * 3] === x && vertices[v * 3 + 1] === y && vertices[v * 3 + 2] === z) { indices[i] = v; break; }
      h = (h + 1) & (cap - 1);
    }
  }
  return { vertices: vertices.slice(0, n * 3), indices };
}

/** the six faces of a box of half extents (hx, hy, hz) as 12 triangles, outward winding */
export function boxFaceSoup(hx: number, hy: number, hz: number): Float32Array {
  const h = [hx, hy, hz];
  const out = new Float32Array(108);
  const p = [0, 0, 0];
  let w = 0;
  for (let axis = 0; axis < 3; axis++) {
    const u = (axis + 1) % 3, v = (axis + 2) % 3;
    for (const side of [-1, 1]) {
      const push = (a: number, b: number): void => {
        p[axis] = side * h[axis]!; p[u] = a * h[u]!; p[v] = b * h[v]!;
        out[w++] = p[0]!; out[w++] = p[1]!; out[w++] = p[2]!;
      };
      // (axis, u, v) is right-handed, so u × v points along +axis
      if (side > 0) { push(-1, -1); push(1, -1); push(1, 1); push(-1, -1); push(1, 1); push(-1, 1); } else { push(-1, -1); push(1, 1); push(1, -1); push(-1, -1); push(-1, 1); push(1, 1); }
    }
  }
  return out;
}

/**
 * Triangles with an edge longer than `maxEdge` are bisected at the midpoint of their longest edge until none is left.
 * An edge is always cut at its midpoint and only because of its own length, so two triangles sharing it cut it alike: the
 * result has no T-junctions. Returns the input when nothing was cut.
 *
 * With `steepEdge`, only triangles a character can stand on (unit normal y above defaults.WALKABLE_NORMAL_Y) get `maxEdge`;
 * walls, overhangs and undersides get the longer `steepEdge`. Where the two meet, the finer side has vertices on the
 * coarser side's edge (no gap).
 */
export function subdivideSoup(tris: Float32Array, maxEdge: number, steepEdge = maxEdge): Float32Array {
  const fine2 = maxEdge * maxEdge, steep2 = steepEdge * steepEdge;
  let out: number[] | null = null;
  const stack: number[] = [];
  for (let i = 0; i + 9 <= tris.length; i += 9) {
    stack.length = 0;
    for (let k = 0; k < 9; k++) stack.push(tris[i + k]!);
    let max2 = fine2;
    if (steep2 !== fine2) {
      const ux = tris[i + 3]! - tris[i]!, uy = tris[i + 4]! - tris[i + 1]!, uz = tris[i + 5]! - tris[i + 2]!;
      const vx = tris[i + 6]! - tris[i]!, vy = tris[i + 7]! - tris[i + 1]!, vz = tris[i + 8]! - tris[i + 2]!;
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      // two-sided for the controller: a floor seen from below is still a floor
      if (Math.abs(ny) <= WALKABLE_NORMAL_Y * Math.hypot(nx, ny, nz)) max2 = steep2;
    }
    let cut = false;
    const done: number[] = [];
    while (stack.length > 0) {
      const cz = stack.pop()!, cy = stack.pop()!, cx = stack.pop()!, bz = stack.pop()!, by = stack.pop()!, bx = stack.pop()!;
      const az = stack.pop()!, ay = stack.pop()!, ax = stack.pop()!;
      const ab = (bx - ax) ** 2 + (by - ay) ** 2 + (bz - az) ** 2, bc = (cx - bx) ** 2 + (cy - by) ** 2 + (cz - bz) ** 2;
      const ca = (ax - cx) ** 2 + (ay - cy) ** 2 + (az - cz) ** 2;
      const longest = Math.max(ab, bc, ca);
      if (!(longest > max2)) { done.push(ax, ay, az, bx, by, bz, cx, cy, cz); continue; }
      cut = true;
      // rotate so the longest edge is a → b, split at m: (a, m, c) and (m, b, c) keep the winding
      let x0 = ax, y0 = ay, z0 = az, x1 = bx, y1 = by, z1 = bz, x2 = cx, y2 = cy, z2 = cz;
      if (longest === bc && bc > ab) { x0 = bx; y0 = by; z0 = bz; x1 = cx; y1 = cy; z1 = cz; x2 = ax; y2 = ay; z2 = az; } else if (longest === ca && ca > ab) { x0 = cx; y0 = cy; z0 = cz; x1 = ax; y1 = ay; z1 = az; x2 = bx; y2 = by; z2 = bz; }
      // the midpoint must not depend on the edge's direction (a + b is commutative, so it does not)
      const mx = (x0 + x1) / 2, my = (y0 + y1) / 2, mz = (z0 + z1) / 2;
      stack.push(x0, y0, z0, mx, my, mz, x2, y2, z2, mx, my, mz, x1, y1, z1, x2, y2, z2);
    }
    if (cut && !out) out = Array.from(tris.subarray(0, i));
    if (out) for (const v of done) out.push(v);
  }
  return out ? new Float32Array(out) : tris;
}

export interface Pose {
  t: Vec3Like;
  q: QuatLike;
  /** per-axis scale; a mirrored matrix carries its sign on x */
  s: Vec3Like;
  /** false when the axes are not orthogonal (shear): `q` and `s` are then only the nearest fit */
  rigid: boolean;
}

/** 3×4 → translation, rotation, scale */
export function decomposeMat34(m: Mat34): Pose {
  let ax = m[0]!, ay = m[1]!, az = m[2]!;
  let bx = m[3]!, by = m[4]!, bz = m[5]!;
  let cx = m[6]!, cy = m[7]!, cz = m[8]!;
  let sx = Math.hypot(ax, ay, az);
  const sy = Math.hypot(bx, by, bz), sz = Math.hypot(cx, cy, cz);
  const t = { x: m[9]!, y: m[10]!, z: m[11]! };
  if (!(sx > 1e-12 && sy > 1e-12 && sz > 1e-12)) return { t, q: { x: 0, y: 0, z: 0, w: 1 }, s: { x: sx, y: sy, z: sz }, rigid: false };
  ax /= sx; ay /= sx; az /= sx; bx /= sy; by /= sy; bz /= sy; cx /= sz; cy /= sz; cz /= sz;
  const det = ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx);
  if (det < 0) { ax = -ax; ay = -ay; az = -az; sx = -sx; }
  const rigid = Math.abs(ax * bx + ay * by + az * bz) < 1e-4 && Math.abs(ax * cx + ay * cy + az * cz) < 1e-4
    && Math.abs(bx * cx + by * cy + bz * cz) < 1e-4;
  // rotation matrix (columns a, b, c) → quaternion
  const tr = ax + by + cz;
  let x: number, y: number, z: number, w: number;
  if (tr > 0) {
    const k = Math.sqrt(tr + 1) * 2;
    w = k / 4; x = (bz - cy) / k; y = (cx - az) / k; z = (ay - bx) / k;
  } else if (ax > by && ax > cz) {
    const k = Math.sqrt(1 + ax - by - cz) * 2;
    w = (bz - cy) / k; x = k / 4; y = (bx + ay) / k; z = (cx + az) / k;
  } else if (by > cz) {
    const k = Math.sqrt(1 + by - ax - cz) * 2;
    w = (cx - az) / k; x = (bx + ay) / k; y = k / 4; z = (cy + bz) / k;
  } else {
    const k = Math.sqrt(1 + cz - ax - by) * 2;
    w = (ay - bx) / k; x = (cx + az) / k; y = (cy + bz) / k; z = k / 4;
  }
  const l = Math.hypot(x, y, z, w) || 1;
  return { t, q: { x: x / l, y: y / l, z: z / l, w: w / l }, s: { x: sx, y: sy, z: sz }, rigid };
}

const IDENTITY_Q: QuatLike = { x: 0, y: 0, z: 0, w: 1 };
const ZERO: Vec3Like = { x: 0, y: 0, z: 0 };
const MIN_EXTENT = 1e-4;

// ── the collider set of one world ────────────────────────────────────────────────────────────────────────────────────────

export class ColliderSet {
  readonly tags = new TagInterner();
  private readonly owners = new Map<number, OwnerRecord>();
  private readonly rows = new Map<string, OwnerRecord[]>();
  private readonly welded = new WeakMap<Float32Array, Welded>();
  private readonly trimeshFlags: number;
  private readonly R: Rapier;
  private readonly raw: World;
  /** supplies the kinematic body of a row (world.ts creates one per row at the instance pose) */
  private readonly kinematicBody: (rowId: string | null, t: Vec3Like, q: QuatLike) => RigidBody;

  constructor(R: Rapier, raw: World, kinematicBody: (rowId: string | null, t: Vec3Like, q: QuatLike) => RigidBody) {
    this.R = R;
    this.raw = raw;
    this.kinematicBody = kinematicBody;
    let flags = 0;
    for (const name of TRIMESH_FLAGS) flags |= R.TriMeshFlags[name];
    this.trimeshFlags = flags;
  }

  get size(): number { return this.owners.size; }

  /** every instance and the terrain of a pack, in pack order (deterministic handles); `tagsOf` gives a row's tags */
  addPack(pack: ColliderPack, tagsOf: (rowId: string) => readonly string[] = () => []): PackStats {
    const stats: PackStats = { colliders: 0, triangles: 0 };
    for (const inst of pack.instances) {
      const shape = pack.keys[inst.key];
      if (!shape) throw new Error(`physics ${pack.place}: instance of ${inst.rowId} names collider key ${inst.key}, the pack has ${pack.keys.length}`);
      const rec = this.addInstance({
        rowId: inst.rowId, shape, m: inst.m, kind: inst.kinematic ? 'kinematic' : 'static', mutable: inst.mutable,
        noDecal: inst.noDecal, tags: tagsOf(inst.rowId),
      });
      if (rec) { stats.colliders++; stats.triangles += rec.triangles; }
    }
    if (pack.terrain) {
      const rec = this.addInstance({ rowId: pack.terrain.id, shape: { id: pack.terrain.id, tris: pack.terrain.tris }, m: IDENTITY_M });
      if (rec) { stats.colliders++; stats.triangles += rec.triangles; }
    }
    return stats;
  }

  /** one collider for one instance; null when the shape is empty (a key without geometry) */
  addInstance(spec: InstanceSpec): OwnerRecord | null {
    const R = this.R;
    const pose = decomposeMat34(spec.m);
    const kinematic = spec.kind === 'kinematic';
    const { shape } = spec;
    let desc: ColliderDesc | null = null;
    let triangles = 0;
    /** vertices already carry the whole matrix: the collider sits at the origin */
    let baked = false;
    // which faces are floors is decided in the shape's own frame: right for an instance that is only yawed (and for a
    // mirrored one); a tilted instance is cut fine all over
    const upright = Math.abs(pose.q.x) < 1e-4 && Math.abs(pose.q.z) < 1e-4 && pose.s.y > 0;
    const steep = upright ? MAX_STEEP_TRIANGLE_EDGE : MAX_TRIANGLE_EDGE;
    /** the collider's centre: the instance origin, lifted along the instance's up axis (matrix column y) for a box or sphere key */
    const centre: Vec3Like = { x: pose.t.x, y: pose.t.y, z: pose.t.z };
    const lift = (h: number): void => { centre.x += spec.m[3]! * h; centre.y += spec.m[4]! * h; centre.z += spec.m[5]! * h; };
    if (shape.box) {
      // full size → half extents (the 1.5 m cuboid limit applies to the true half extent)
      const hx = Math.max(MIN_EXTENT, (shape.box[0] / 2) * Math.abs(pose.s.x)), hy = Math.max(MIN_EXTENT, (shape.box[1] / 2) * Math.abs(pose.s.y));
      const hz = Math.max(MIN_EXTENT, (shape.box[2] / 2) * Math.abs(pose.s.z));
      lift(shape.box[1] / 2);
      if (Math.max(hx, hy, hz) > CUBOID_MAX_HALF_EXTENT) {
        const w = weldSoup(subdivideSoup(boxFaceSoup(hx, hy, hz), MAX_TRIANGLE_EDGE, steep));
        desc = R.ColliderDesc.trimesh(w.vertices, w.indices, this.trimeshFlags || undefined);
        triangles = w.indices.length / 3;
      } else {
        desc = R.ColliderDesc.cuboid(hx, hy, hz);
        triangles = 12;
      }
    } else if (shape.sphere !== undefined) {
      lift(shape.sphere);
      desc = R.ColliderDesc.ball(Math.max(MIN_EXTENT, shape.sphere * Math.max(Math.abs(pose.s.x), Math.abs(pose.s.y), Math.abs(pose.s.z))));
    } else if (shape.tris && shape.tris.length >= 9) {
      const unit = Math.abs(pose.s.x - 1) < 1e-6 && Math.abs(pose.s.y - 1) < 1e-6 && Math.abs(pose.s.z - 1) < 1e-6;
      let w: Welded;
      if (!pose.rigid && !kinematic) {
        // sheared instance: only the full matrix is exact
        w = weldSoup(subdivideSoup(transformVertices(shape.tris, spec.m), MAX_TRIANGLE_EDGE, MAX_STEEP_TRIANGLE_EDGE));
        baked = true;
      } else if (!unit || !upright) {
        w = weldSoup(subdivideSoup(unit ? shape.tris : scaleVertices(shape.tris, pose.s), MAX_TRIANGLE_EDGE, steep));
      } else {
        // the common case: one welded, subdivided mesh per key, shared by its instances
        let cached = this.welded.get(shape.tris);
        if (!cached) {
          cached = weldSoup(subdivideSoup(shape.tris, MAX_TRIANGLE_EDGE, MAX_STEEP_TRIANGLE_EDGE));
          this.welded.set(shape.tris, cached);
        }
        w = cached;
      }
      desc = R.ColliderDesc.trimesh(w.vertices, w.indices, this.trimeshFlags || undefined);
      triangles = w.indices.length / 3;
    }
    if (!desc) return null;
    desc.setCollisionGroups(spec.groups ?? PACKED_DEFAULT_GROUPS);
    if (spec.sensor) desc.setSensor(true);
    let body: RigidBody | null = null;
    let collider: Collider;
    if (kinematic) {
      body = this.kinematicBody(spec.rowId, pose.t, pose.q);
      // The row's body may exist already, anywhere: a second part of the row, a body made at the row's own pose, a
      // collider swapped after the door has swung (X-43). The collider is seated by its matrix RELATIVE to the body as
      // it stands now (identity for a body just made at this pose), so it lands where the matrix says and moves with it.
      const bt = body.translation(), bq = body.rotation();
      const inv = { x: -bq.x, y: -bq.y, z: -bq.z, w: bq.w };
      const local = rotateBy(inv, centre.x - bt.x, centre.y - bt.y, centre.z - bt.z);
      desc.setTranslation(local.x, local.y, local.z);
      desc.setRotation(mulQuat(inv, pose.q));
      collider = this.raw.createCollider(desc, body);
    } else {
      desc.setTranslation(baked ? ZERO.x : centre.x, baked ? ZERO.y : centre.y, baked ? ZERO.z : centre.z);
      desc.setRotation(baked ? IDENTITY_Q : pose.q);
      collider = this.raw.createCollider(desc);
    }
    const tags = spec.tags ? [...spec.tags] : [];
    const rec: OwnerRecord = {
      handle: collider.handle, rowId: spec.rowId, kind: kinematic ? 'kinematic' : 'static', tags, tagMask: this.tags.mask(tags),
      noDecal: spec.noDecal === true, mutable: spec.mutable === true, sensor: spec.sensor === true, collider, body, triangles,
    };
    this.register(rec);
    return rec;
  }

  /** an owner record for a collider made elsewhere (character capsules, dynamic bodies, sensors: PH3 / PH4) */
  adopt(collider: Collider, body: RigidBody | null, info: { rowId: string | null; kind: BodyKind; tags?: readonly string[]; noDecal?: boolean; sensor?: boolean }): OwnerRecord {
    const tags = info.tags ? [...info.tags] : [];
    const rec: OwnerRecord = {
      handle: collider.handle, rowId: info.rowId, kind: info.kind, tags, tagMask: this.tags.mask(tags), noDecal: info.noDecal === true,
      mutable: true, sensor: info.sensor === true, collider, body, triangles: 0,
    };
    this.register(rec);
    return rec;
  }

  private register(rec: OwnerRecord): void {
    this.owners.set(rec.handle, rec);
    if (rec.rowId !== null) {
      const list = this.rows.get(rec.rowId);
      if (list) list.push(rec); else this.rows.set(rec.rowId, [rec]);
    }
  }

  /** collider handle → its record (a hit's `collider.handle`) */
  owner(handle: number): OwnerRecord | undefined { return this.owners.get(handle); }

  ownersOf(rowId: string): readonly OwnerRecord[] { return this.rows.get(rowId) ?? NO_OWNERS; }

  /**
   * The tags of a row that spawned after its colliders were built (PH3: a place's pack is built before its scene batch, so
   * `addPack` cannot know them yet). Replaces the tags and the mask of every record of the row.
   */
  setRowTags(rowId: string, tags: readonly string[]): void {
    const own = [...tags];
    const mask = this.tags.mask(own);
    for (const rec of this.ownersOf(rowId)) {
      const r = rec as { tags: readonly string[]; tagMask: number };
      r.tags = own;
      r.tagMask = mask;
    }
  }

  /** supply terminals `static` ↔ `"none"`, wrecked doors: the colliders stay, out of every query and contact while off */
  setRowEnabled(rowId: string, on: boolean): void {
    for (const rec of this.ownersOf(rowId)) rec.collider.setEnabled(on);
  }

  /** forget a record; `removeCollider` false when the caller removes the collider itself (with its body) */
  remove(rec: OwnerRecord, removeCollider = true): void {
    if (!this.owners.delete(rec.handle)) return;
    if (rec.rowId !== null) {
      const list = this.rows.get(rec.rowId);
      if (list) {
        const i = list.indexOf(rec);
        if (i >= 0) list.splice(i, 1);
        if (list.length === 0) this.rows.delete(rec.rowId);
      }
    }
    if (removeCollider) this.raw.removeCollider(rec.collider, true);
  }

  /** every fixed collider of a row (a `primitive` or transform write rebuilds: remove, then `addInstance` again) */
  removeRow(rowId: string): void {
    for (const rec of [...this.ownersOf(rowId)]) this.remove(rec);
  }

  clear(): void {
    this.owners.clear();
    this.rows.clear();
  }
}

const NO_OWNERS: readonly OwnerRecord[] = [];
const IDENTITY_M: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];

/** q · v */
function rotateBy(q: QuatLike, x: number, y: number, z: number): Vec3Like {
  const tx = 2 * (q.y * z - q.z * y), ty = 2 * (q.z * x - q.x * z), tz = 2 * (q.x * y - q.y * x);
  return { x: x + q.w * tx + (q.y * tz - q.z * ty), y: y + q.w * ty + (q.z * tx - q.x * tz), z: z + q.w * tz + (q.x * ty - q.y * tx) };
}

/** a · b, normalised */
function mulQuat(a: QuatLike, b: QuatLike): QuatLike {
  const x = a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y, y = a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x;
  const z = a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w, w = a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z;
  const l = Math.hypot(x, y, z, w) || 1;
  return { x: x / l, y: y / l, z: z / l, w: w / l };
}

function scaleVertices(v: Float32Array, s: Vec3Like): Float32Array {
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 3) { out[i] = v[i]! * s.x; out[i + 1] = v[i + 1]! * s.y; out[i + 2] = v[i + 2]! * s.z; }
  return out;
}

function transformVertices(v: Float32Array, m: Mat34): Float32Array {
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i += 3) {
    const x = v[i]!, y = v[i + 1]!, z = v[i + 2]!;
    out[i] = m[0]! * x + m[3]! * y + m[6]! * z + m[9]!;
    out[i + 1] = m[1]! * x + m[4]! * y + m[7]! * z + m[10]!;
    out[i + 2] = m[2]! * x + m[5]! * y + m[8]! * z + m[11]!;
  }
  return out;
}
