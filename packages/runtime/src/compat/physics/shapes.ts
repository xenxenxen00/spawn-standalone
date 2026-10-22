// Collision shapes and their query / contact routines (motion §4.4): Sphere, Capsule, Obb and TriMeshInstance ("mesh": a
// shared local StaticBvh + a 3×4 world transform). Rays are two-sided (from inside a closed shape: the exit) with normals
// facing the ray origin; sweeps report normals from the surface towards the moving shape and the contact point on the
// surface. Contacts (overlap / dynamics) report depth and a normal pointing towards the FIRST shape named.
// All routines write into caller-owned objects or module scratch; nothing allocates per call except the shape factories.
import { RayHit, StaticBvh, sweepContact } from './bvh.ts';
import {
  closestPtPointTriangle, closestPtSegmentSegment, closestPtSegmentTriangle, m34Dir, m34Invert, m34NormalFromInverse,
  m34Point, projectsInsideTri, rayCapsule, raySphere, sweepCapsuleCapsule, sweepCapsuleTriangle, triNormalFacing, v3,
  v3copy, v3normalize, type Num3, type V3, type Vec3,
} from './math.ts';

export interface SphereShape { readonly kind: 'sphere'; readonly c: V3; r: number }
/** segment [a, b] ⊕ r, world space */
export interface CapsuleShape { readonly kind: 'capsule'; readonly a: V3; readonly b: V3; r: number }
/** centre, half extents, rotation (3×3 column-major: local X, Y, Z axes in world) */
export interface ObbShape { readonly kind: 'obb'; readonly c: V3; readonly half: V3; readonly rot: Float64Array }
/** instanced triangle mesh: shared local BVH + world transform m (3×4) and its inverse */
export interface MeshShape { readonly kind: 'mesh'; readonly bvh: StaticBvh; readonly m: Float64Array; readonly inv: Float64Array }
export type Shape = SphereShape | CapsuleShape | ObbShape | MeshShape;

export const sphereShape = (c: Num3, r: number): SphereShape => ({ kind: 'sphere', c: v3copy(v3(), c), r });
export const capsuleShape = (a: Num3, b: Num3, r: number): CapsuleShape => ({ kind: 'capsule', a: v3copy(v3(), a), b: v3copy(v3(), b), r });

/**
 * A character capsule from its feet (the body origin, motion §4.1): `height` is the TOTAL height feet → top, the half segment
 * is h/2 − r clamped ≥ 0 (motion §4.2, [CAL M1]).
 */
export function capsuleFromFeet(feet: Vec3, height: number, radius: number): CapsuleShape {
  const s: CapsuleShape = { kind: 'capsule', a: v3(), b: v3(), r: radius };
  placeCapsule(s, feet.x, feet.y, feet.z, height, radius);
  return s;
}
export function placeCapsule(s: CapsuleShape, fx: number, fy: number, fz: number, height: number, radius: number): void {
  const half = Math.max(0, height / 2 - radius);
  const cy = fy + height / 2;
  s.a[0] = fx; s.a[1] = cy - half; s.a[2] = fz;
  s.b[0] = fx; s.b[1] = cy + half; s.b[2] = fz;
  s.r = radius;
}

export function obbShape(c: Num3, half: Num3, rot: Num3 | null): ObbShape {
  const r = new Float64Array(9);
  if (rot) r.set(rot.subarray(0, 9)); else { r[0] = 1; r[4] = 1; r[8] = 1; }
  return { kind: 'obb', c: v3copy(v3(), c), half: v3copy(v3(), half), rot: r };
}

export function meshShape(bvh: StaticBvh, m: Num3): MeshShape {
  const s: MeshShape = { kind: 'mesh', bvh, m: new Float64Array(12), inv: new Float64Array(12) };
  setMeshTransform(s, m);
  return s;
}
export function setMeshTransform(s: MeshShape, m: Num3): void {
  s.m.set(m.subarray(0, 12));
  if (!m34Invert(s.m, s.inv)) throw new Error('meshShape: singular transform');
}

// ── bounds ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

const B_MIN = v3(), B_MAX = v3();

export function shapeAabb(s: Shape, min: V3, max: V3): void {
  switch (s.kind) {
    case 'sphere':
      for (let i = 0; i < 3; i++) { min[i] = s.c[i]! - s.r; max[i] = s.c[i]! + s.r; }
      return;
    case 'capsule':
      for (let i = 0; i < 3; i++) {
        min[i] = Math.min(s.a[i]!, s.b[i]!) - s.r;
        max[i] = Math.max(s.a[i]!, s.b[i]!) + s.r;
      }
      return;
    case 'obb': {
      const R = s.rot, h = s.half;
      for (let i = 0; i < 3; i++) {
        const e = Math.abs(R[i]!) * h[0]! + Math.abs(R[3 + i]!) * h[1]! + Math.abs(R[6 + i]!) * h[2]!;
        min[i] = s.c[i]! - e; max[i] = s.c[i]! + e;
      }
      return;
    }
    case 'mesh': {
      s.bvh.bounds(B_MIN, B_MAX);
      if (!(B_MIN[0]! <= B_MAX[0]!)) { min.fill(Infinity); max.fill(-Infinity); return; }
      transformAabb(s.m, B_MIN, B_MAX, min, max);
      return;
    }
  }
}

/** world AABB of the local box [lo, hi] under the affine m (centre / extent with |A|) */
function transformAabb(m: Num3, lo: Num3, hi: Num3, min: V3, max: V3): void {
  const cx = (lo[0]! + hi[0]!) / 2, cy = (lo[1]! + hi[1]!) / 2, cz = (lo[2]! + hi[2]!) / 2;
  const ex = (hi[0]! - lo[0]!) / 2, ey = (hi[1]! - lo[1]!) / 2, ez = (hi[2]! - lo[2]!) / 2;
  for (let i = 0; i < 3; i++) {
    const c = m[i]! * cx + m[3 + i]! * cy + m[6 + i]! * cz + m[9 + i]!;
    const e = Math.abs(m[i]!) * ex + Math.abs(m[3 + i]!) * ey + Math.abs(m[6 + i]!) * ez;
    min[i] = c - e; max[i] = c + e;
  }
}

// ── rays ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export class ShapeHit {
  t = Infinity;
  /** rays: facing the ray origin; sweeps: from the surface towards the moving shape */
  readonly normal: V3 = v3();
  /** rays: the hit point; sweeps: the contact point on the surface */
  readonly point: V3 = v3();
  reset(): void { this.t = Infinity; }
}

const R_O = v3(), R_D = v3(), R_N = v3(), R_C1 = v3(), R_C2 = v3();
const R_HIT = new RayHit();

/** ray (o, unit d) against the shape's surface within tMax; two-sided */
export function rayShape(s: Shape, o: Num3, d: Num3, tMax: number, out: ShapeHit): boolean {
  out.reset();
  const dx = d[0]!, dy = d[1]!, dz = d[2]!;
  let t = -1;
  switch (s.kind) {
    case 'sphere': {
      t = raySphere(o, d, s.c, s.r, tMax);
      if (t < 0) return false;
      setPoint(out, o, d, t);
      for (let i = 0; i < 3; i++) out.normal[i] = out.point[i]! - s.c[i]!;
      break;
    }
    case 'capsule': {
      t = rayCapsule(o, d, s.a, s.b, s.r, tMax);
      if (t < 0) return false;
      setPoint(out, o, d, t);
      closestPtSegmentSegment(out.point, out.point, s.a, s.b, R_C1, R_C2);
      for (let i = 0; i < 3; i++) out.normal[i] = out.point[i]! - R_C2[i]!;
      break;
    }
    case 'obb': {
      t = rayObb(s, o, d, tMax, out.normal);
      if (t < 0) return false;
      setPoint(out, o, d, t);
      break;
    }
    case 'mesh': {
      m34Point(s.inv, o, R_O);
      m34Dir(s.inv, d, R_D);
      if (!s.bvh.raycast(R_O, R_D, tMax, null, R_HIT)) return false;
      t = R_HIT.t;
      setPoint(out, o, d, t);
      m34NormalFromInverse(s.inv, R_HIT.normal, out.normal);
      break;
    }
  }
  if (v3normalize(out.normal) === 0) { out.normal[0] = -dx; out.normal[1] = -dy; out.normal[2] = -dz; }
  if (out.normal[0]! * dx + out.normal[1]! * dy + out.normal[2]! * dz > 0) {
    out.normal[0] = -out.normal[0]!; out.normal[1] = -out.normal[1]!; out.normal[2] = -out.normal[2]!;
  }
  out.t = t;
  return true;
}

function setPoint(out: ShapeHit, o: Num3, d: Num3, t: number): void {
  out.point[0] = o[0]! + d[0]! * t; out.point[1] = o[1]! + d[1]! * t; out.point[2] = o[2]! + d[2]! * t;
}

/** slab test in the box frame; writes the (unoriented) world normal of the face hit; t or -1 */
function rayObb(s: ObbShape, o: Num3, d: Num3, tMax: number, n: V3): number {
  const R = s.rot;
  const rx = o[0]! - s.c[0]!, ry = o[1]! - s.c[1]!, rz = o[2]! - s.c[2]!;
  let tn = -Infinity, tf = Infinity, an = -1, af = -1;
  for (let i = 0; i < 3; i++) {
    const ax = R[i * 3]!, ay = R[i * 3 + 1]!, az = R[i * 3 + 2]!;
    const lo = rx * ax + ry * ay + rz * az, ld = d[0]! * ax + d[1]! * ay + d[2]! * az, h = s.half[i]!;
    if (ld > -1e-15 && ld < 1e-15) {
      if (lo < -h || lo > h) return -1;
      continue;
    }
    let t0 = (-h - lo) / ld, t1 = (h - lo) / ld;
    if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp; }
    if (t0 > tn) { tn = t0; an = i; }
    if (t1 < tf) { tf = t1; af = i; }
    if (tn > tf) return -1;
  }
  let t: number, axis: number;
  if (tn >= 0) { t = tn; axis = an; } else if (tf >= 0) { t = tf; axis = af; } else return -1;
  if (t > tMax || axis < 0) return -1;
  n[0] = R[axis * 3]!; n[1] = R[axis * 3 + 1]!; n[2] = R[axis * 3 + 2]!;
  return t;
}

// ── sweeps ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

const OBB_TRIS = new Float64Array(12 * 9);
const MESH_TRI = new Float64Array(9);
const MESH_BEST = new Float64Array(9);
const Q_LIST: number[] = [];
const W_MIN = v3(), W_MAX = v3(), L_MIN = v3(), L_MAX = v3(), P_A = v3(), P_B = v3();

/**
 * Capsule [a,b] ⊕ r (a = b: a sphere) swept along unit d up to tMax against the shape: first contact. Overlapping at the
 * start: t = 0 when moving deeper, ignored when separating and `ignoreSeparating` (default).
 */
export function sweepCapsuleShape(s: Shape, a: Num3, b: Num3, r: number, d: Num3, tMax: number, out: ShapeHit, ignoreSeparating = true): boolean {
  out.reset();
  switch (s.kind) {
    case 'sphere':
    case 'capsule': {
      const p = s.kind === 'sphere' ? s.c : s.a, q = s.kind === 'sphere' ? s.c : s.b;
      const t = sweepCapsuleCapsule(a, b, d, p, q, r + s.r, tMax, ignoreSeparating);
      if (t < 0) return false;
      for (let i = 0; i < 3; i++) { P_A[i] = a[i]! + d[i]! * t; P_B[i] = b[i]! + d[i]! * t; }
      closestPtSegmentSegment(P_A, P_B, p, q, R_C1, R_C2);
      for (let i = 0; i < 3; i++) out.normal[i] = R_C1[i]! - R_C2[i]!;
      if (v3normalize(out.normal) === 0) { out.normal[0] = -d[0]!; out.normal[1] = -d[1]!; out.normal[2] = -d[2]!; }
      for (let i = 0; i < 3; i++) out.point[i] = R_C2[i]! + out.normal[i]! * s.r;
      out.t = t;
      return true;
    }
    case 'obb': {
      obbTriangles(s, OBB_TRIS);
      let best = tMax, bestTri = -1;
      for (let k = 0; k < 12; k++) {
        const t = sweepCapsuleTriangle(a, b, r, d, best, OBB_TRIS, k * 9, ignoreSeparating);
        if (t >= 0 && (t < best || bestTri < 0)) { best = t; bestTri = k; }
      }
      if (bestTri < 0) return false;
      sweepContact(a, b, d, best, OBB_TRIS, bestTri * 9, out.normal, out.point);
      out.t = best;
      return true;
    }
    case 'mesh': {
      // world AABB of the whole sweep → local box → candidate triangles, tested in world space (exact under scale)
      for (let i = 0; i < 3; i++) {
        const lo = Math.min(a[i]!, b[i]!) - r, hi = Math.max(a[i]!, b[i]!) + r, m = d[i]! * tMax;
        W_MIN[i] = Math.min(lo, lo + m); W_MAX[i] = Math.max(hi, hi + m);
      }
      transformAabb(s.inv, W_MIN, W_MAX, L_MIN, L_MAX);
      s.bvh.queryAabb(L_MIN, L_MAX, Q_LIST);
      let best = tMax, found = false;
      const lt = s.bvh.tris;
      for (const tri of Q_LIST) {
        for (let v = 0; v < 3; v++) {
          v3copy(P_A, lt, tri * 9 + v * 3);
          m34Point(s.m, P_A, P_B);
          MESH_TRI[v * 3] = P_B[0]!; MESH_TRI[v * 3 + 1] = P_B[1]!; MESH_TRI[v * 3 + 2] = P_B[2]!;
        }
        const t = sweepCapsuleTriangle(a, b, r, d, best, MESH_TRI, 0, ignoreSeparating);
        if (t >= 0 && (t < best || !found)) { best = t; found = true; MESH_BEST.set(MESH_TRI); }
      }
      if (!found) return false;
      sweepContact(a, b, d, best, MESH_BEST, 0, out.normal, out.point);
      out.t = best;
      return true;
    }
  }
}

/** the 12 world triangles of an OBB → out (108 numbers) */
export function obbTriangles(s: ObbShape, out: Float64Array): void {
  OBB_M.set(s.rot);
  OBB_M[9] = s.c[0]!; OBB_M[10] = s.c[1]!; OBB_M[11] = s.c[2]!;
  writeBox(s.half, OBB_M, out);
}
const OBB_M = new Float64Array(12);

// ── overlaps and contacts ────────────────────────────────────────────────────────────────────────────────────────────────

export interface Contact { depth: number; readonly normal: V3; readonly point: V3 }

const C_SEG = v3(), C_TRI = v3();

/** capsule vs triangle: depth r − d, normal from the triangle to the capsule, point on the triangle */
export function overlapCapsuleTriangle(a: Num3, b: Num3, r: number, t: Num3, off: number, out: Contact): boolean {
  const d2 = closestPtSegmentTriangle(a, b, t, off, C_SEG, C_TRI);
  if (d2 > r * r) return false;
  out.point.set(C_TRI);
  if (d2 > 1e-18) {
    const dl = Math.sqrt(d2);
    for (let i = 0; i < 3; i++) out.normal[i] = (C_SEG[i]! - C_TRI[i]!) / dl;
    out.depth = r - dl;
    return true;
  }
  // the segment pierces the face: push out along the face normal on the side of the segment's midpoint
  triNormalFacing(t, off, 0, 0, 0, out.normal);
  const sa = (a[0]! - t[off]!) * out.normal[0]! + (a[1]! - t[off + 1]!) * out.normal[1]! + (a[2]! - t[off + 2]!) * out.normal[2]!;
  const sb = (b[0]! - t[off]!) * out.normal[0]! + (b[1]! - t[off + 1]!) * out.normal[1]! + (b[2]! - t[off + 2]!) * out.normal[2]!;
  if (sa + sb < 0) { for (let i = 0; i < 3; i++) out.normal[i] = -out.normal[i]!; out.depth = r + Math.max(sa, sb); } else out.depth = r - Math.min(sa, sb);
  return true;
}

/** capsule 1 vs capsule 2: depth, normal from capsule 2 towards capsule 1, point on capsule 2's surface */
export function overlapCapsuleCapsule(a1: Num3, b1: Num3, r1: number, a2: Num3, b2: Num3, r2: number, out: Contact): boolean {
  const R = r1 + r2;
  const d2 = closestPtSegmentSegment(a1, b1, a2, b2, R_C1, R_C2);
  if (d2 > R * R) return false;
  const dl = Math.sqrt(d2);
  if (dl > 1e-9) {
    for (let i = 0; i < 3; i++) out.normal[i] = (R_C1[i]! - R_C2[i]!) / dl;
  } else {
    // coincident axes: any direction perpendicular to capsule 1's axis, deterministic
    const ux = b1[0]! - a1[0]!, uy = b1[1]! - a1[1]!, uz = b1[2]! - a1[2]!;
    if (Math.abs(uy) >= Math.abs(ux) && Math.abs(uy) >= Math.abs(uz)) { out.normal[0] = 1; out.normal[1] = 0; out.normal[2] = 0; } else {
      out.normal[0] = 0; out.normal[1] = 1; out.normal[2] = 0;
    }
  }
  out.depth = R - dl;
  for (let i = 0; i < 3; i++) out.point[i] = R_C2[i]! + out.normal[i]! * r2;
  return true;
}

/** sphere vs triangle: depth, normal from the triangle to the sphere, point on the triangle */
export function contactSphereTriangle(c: Num3, r: number, t: Num3, off: number, out: Contact): boolean {
  const d2 = closestPtPointTriangle(c, t, off, C_TRI);
  if (d2 > r * r) return false;
  out.point.set(C_TRI);
  const dl = Math.sqrt(d2);
  if (dl > 1e-12) for (let i = 0; i < 3; i++) out.normal[i] = (c[i]! - C_TRI[i]!) / dl;
  else {
    triNormalFacing(t, off, 0, 0, 0, out.normal);
  }
  out.depth = r - dl;
  return true;
}

/** fixed-capacity contact buffer (depth, normal, point per contact) */
export class ContactList {
  readonly capacity: number;
  count = 0;
  readonly depth: Float64Array;
  readonly normal: Float64Array;
  readonly point: Float64Array;
  constructor(capacity: number) {
    this.capacity = capacity;
    this.depth = new Float64Array(capacity);
    this.normal = new Float64Array(capacity * 3);
    this.point = new Float64Array(capacity * 3);
  }
  clear(): void { this.count = 0; }
  push(depth: number, nx: number, ny: number, nz: number, px: number, py: number, pz: number): boolean {
    if (this.count >= this.capacity) return false;
    const i = this.count++;
    this.depth[i] = depth;
    this.normal[i * 3] = nx; this.normal[i * 3 + 1] = ny; this.normal[i * 3 + 2] = nz;
    this.point[i * 3] = px; this.point[i * 3 + 1] = py; this.point[i * 3 + 2] = pz;
    return true;
  }
}

const K_N = v3();

/**
 * Box vs triangle contacts for dynamics (motion §4.4): box corners below the triangle plane that project inside it (normal =
 * the face normal towards the box, depth = distance below the plane, point = the corner), plus triangle vertices inside the
 * box (normal = the box face of least penetration, pointing to push the box away). Appends to `list`; returns the count added.
 */
export function contactsBoxTriangle(s: ObbShape, t: Num3, off: number, list: ContactList): number {
  const before = list.count;
  const R = s.rot, h = s.half, cx = s.c[0]!, cy = s.c[1]!, cz = s.c[2]!;
  triNormalFacing(t, off, 0, 0, 0, K_N);
  const ax = t[off]!, ay = t[off + 1]!, az = t[off + 2]!;
  if ((cx - ax) * K_N[0]! + (cy - ay) * K_N[1]! + (cz - az) * K_N[2]! < 0) { K_N[0] = -K_N[0]!; K_N[1] = -K_N[1]!; K_N[2] = -K_N[2]!; }
  for (let k = 0; k < 8; k++) {
    const sx = k & 1 ? h[0]! : -h[0]!, sy = k & 2 ? h[1]! : -h[1]!, sz = k & 4 ? h[2]! : -h[2]!;
    const px = cx + R[0]! * sx + R[3]! * sy + R[6]! * sz;
    const py = cy + R[1]! * sx + R[4]! * sy + R[7]! * sz;
    const pz = cz + R[2]! * sx + R[5]! * sy + R[8]! * sz;
    const dist = (px - ax) * K_N[0]! + (py - ay) * K_N[1]! + (pz - az) * K_N[2]!;
    if (dist < 0 && projectsInsideTri(px, py, pz, t, off)) {
      if (!list.push(-dist, K_N[0]!, K_N[1]!, K_N[2]!, px, py, pz)) return list.count - before;
    }
  }
  for (let v = 0; v < 3; v++) {
    const vx = t[off + v * 3]!, vy = t[off + v * 3 + 1]!, vz = t[off + v * 3 + 2]!;
    const rx = vx - cx, ry = vy - cy, rz = vz - cz;
    let bestDepth = Infinity, bestAxis = -1, bestSign = 1;
    let inside = true;
    for (let i = 0; i < 3 && inside; i++) {
      const l = rx * R[i * 3]! + ry * R[i * 3 + 1]! + rz * R[i * 3 + 2]!;
      const pen = h[i]! - Math.abs(l);
      if (pen < 0) inside = false;
      else if (pen < bestDepth) { bestDepth = pen; bestAxis = i; bestSign = l < 0 ? 1 : -1; }
    }
    if (!inside || bestAxis < 0) continue;
    const nx = R[bestAxis * 3]! * bestSign, ny = R[bestAxis * 3 + 1]! * bestSign, nz = R[bestAxis * 3 + 2]! * bestSign;
    if (!list.push(bestDepth, nx, ny, nz, vx, vy, vz)) break;
  }
  return list.count - before;
}

// ── triangle soups for primitive colliders (motion §4.3: boxes → 12 triangles, spheres → an 80-triangle icosphere) ────────

/** corner index bits: x = 1, y = 2, z = 4; faces wound outwards */
const BOX_QUADS = [0, 4, 6, 2, 1, 3, 7, 5, 0, 1, 5, 4, 2, 6, 7, 3, 0, 2, 3, 1, 4, 5, 7, 6];

/** quad corner order → two triangles (0,1,2) (0,2,3) */
const QUAD_TRIS = [0, 1, 2, 0, 2, 3];
const BX_CORNERS = new Float64Array(24), BX_P = v3(), BX_Q = v3();

function writeBox(half: Num3, m: Num3 | null, out: Float32Array | Float64Array): void {
  for (let k = 0; k < 8; k++) {
    BX_P[0] = k & 1 ? half[0]! : -half[0]!; BX_P[1] = k & 2 ? half[1]! : -half[1]!; BX_P[2] = k & 4 ? half[2]! : -half[2]!;
    if (m) m34Point(m, BX_P, BX_Q); else BX_Q.set(BX_P);
    BX_CORNERS.set(BX_Q, k * 3);
  }
  let w = 0;
  for (let f = 0; f < 6; f++) {
    for (let j = 0; j < 6; j++) {
      const c = BOX_QUADS[f * 4 + QUAD_TRIS[j]!]!;
      out[w++] = BX_CORNERS[c * 3]!; out[w++] = BX_CORNERS[c * 3 + 1]!; out[w++] = BX_CORNERS[c * 3 + 2]!;
    }
  }
}

/** 12 triangles of the box ±half, transformed by the 3×4 m when given */
export function boxTriangles(half: Num3, m: Num3 | null): Float32Array {
  const out = new Float32Array(12 * 9);
  writeBox(half, m, out);
  return out;
}

const PHI = (1 + Math.sqrt(5)) / 2;
const ICO_V = [-1, PHI, 0, 1, PHI, 0, -1, -PHI, 0, 1, -PHI, 0, 0, -1, PHI, 0, 1, PHI, 0, -1, -PHI, 0, 1, -PHI, PHI, 0, -1, PHI, 0, 1, -PHI, 0, -1, -PHI, 0, 1];
const ICO_F = [
  0, 11, 5, 0, 5, 1, 0, 1, 7, 0, 7, 10, 0, 10, 11, 1, 5, 9, 5, 11, 4, 11, 10, 2, 10, 7, 6, 7, 1, 8,
  3, 9, 4, 3, 4, 2, 3, 2, 6, 3, 6, 8, 3, 8, 9, 4, 9, 5, 2, 4, 11, 6, 2, 10, 8, 6, 7, 9, 8, 1,
];

/** 80 triangles approximating a sphere of radius r (icosahedron subdivided once), centred at c (default origin) */
export function icosphereTriangles(r: number, c: Num3 | null): Float32Array {
  const out = new Float32Array(80 * 9);
  const vert = (i: number): [number, number, number] => {
    const x = ICO_V[i * 3]!, y = ICO_V[i * 3 + 1]!, z = ICO_V[i * 3 + 2]!, l = Math.hypot(x, y, z);
    return [x / l, y / l, z / l];
  };
  const mid = (p: number[], q: number[]): [number, number, number] => {
    const x = p[0]! + q[0]!, y = p[1]! + q[1]!, z = p[2]! + q[2]!, l = Math.hypot(x, y, z);
    return [x / l, y / l, z / l];
  };
  const ox = c ? c[0]! : 0, oy = c ? c[1]! : 0, oz = c ? c[2]! : 0;
  let w = 0;
  const put = (...ps: number[][]): void => {
    for (const p of ps) { out[w++] = ox + p[0]! * r; out[w++] = oy + p[1]! * r; out[w++] = oz + p[2]! * r; }
  };
  for (let f = 0; f < 20; f++) {
    const a = vert(ICO_F[f * 3]!), b = vert(ICO_F[f * 3 + 1]!), cc = vert(ICO_F[f * 3 + 2]!);
    const ab = mid(a, b), bc = mid(b, cc), ca = mid(cc, a);
    put(a, ab, ca); put(b, bc, ab); put(cc, ca, bc); put(ab, bc, ca);
  }
  return out;
}
