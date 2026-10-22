// Physics maths kernels (motion §4.4): vectors on Float64Array scratch, 3×4 affine matrices, closest-point routines
// (point/segment/triangle, Ericson "Real-Time Collision Detection" ch. 5), ray kernels and the exact capsule/sphere sweep
// against a triangle or a segment. Allocation-free: every routine writes into caller-owned arrays or module scratch.
//
// Conventions: right-handed, +Y up, metres (motion §4.1). A triangle is 9 consecutive numbers (v0, v1, v2) at an offset of a
// Float32Array or Float64Array. Ray and sweep directions are UNIT vectors unless a routine says otherwise; times of impact are
// distances along them. A 3×4 matrix is 12 numbers, column-major: [X axis, Y axis, Z axis, translation] (the first three
// columns of a glTF 4×4 without its last row). MA1's motion/quat.ts is planned to share the vector helpers (motion §2);
// until it lands this file is self-contained.

export interface Vec3 { x: number; y: number; z: number }
export type V3 = Float64Array;
export type Num3 = Float32Array | Float64Array;

export const v3 = (x = 0, y = 0, z = 0): V3 => {
  const o = new Float64Array(3);
  o[0] = x; o[1] = y; o[2] = z;
  return o;
};
export function v3set(o: V3, x: number, y: number, z: number): V3 { o[0] = x; o[1] = y; o[2] = z; return o; }
export function v3copy(o: V3, a: Num3, ao = 0): V3 { o[0] = a[ao]!; o[1] = a[ao + 1]!; o[2] = a[ao + 2]!; return o; }
export function v3fromVec(o: V3, p: Vec3): V3 { o[0] = p.x; o[1] = p.y; o[2] = p.z; return o; }
export const toVec3 = (a: Num3, ao = 0): Vec3 => ({ x: a[ao]!, y: a[ao + 1]!, z: a[ao + 2]! });
export const v3dot = (a: Num3, b: Num3): number => a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
export const v3len = (a: Num3): number => Math.sqrt(a[0]! * a[0]! + a[1]! * a[1]! + a[2]! * a[2]!);
/** normalises in place; returns the old length (0 leaves the vector untouched) */
export function v3normalize(a: V3): number {
  const l = v3len(a);
  if (l > 0) { a[0]! /= l; a[1]! /= l; a[2]! /= l; }
  return l;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
/** squared lengths below this are treated as zero (a 1 µm segment is a point) */
const EPS_SQ = 1e-12;

// ── 3×4 affine matrices ───────────────────────────────────────────────────────────────────────────────────────────────────

export function m34Identity(o: Float64Array): Float64Array {
  o.fill(0); o[0] = 1; o[4] = 1; o[8] = 1;
  return o;
}
export function m34Point(m: Num3, p: Num3, o: V3): V3 {
  const x = p[0]!, y = p[1]!, z = p[2]!;
  o[0] = m[0]! * x + m[3]! * y + m[6]! * z + m[9]!;
  o[1] = m[1]! * x + m[4]! * y + m[7]! * z + m[10]!;
  o[2] = m[2]! * x + m[5]! * y + m[8]! * z + m[11]!;
  return o;
}
export function m34Dir(m: Num3, d: Num3, o: V3): V3 {
  const x = d[0]!, y = d[1]!, z = d[2]!;
  o[0] = m[0]! * x + m[3]! * y + m[6]! * z;
  o[1] = m[1]! * x + m[4]! * y + m[7]! * z;
  o[2] = m[2]! * x + m[5]! * y + m[8]! * z;
  return o;
}
/** normal transform with the INVERSE matrix: (A⁻¹)ᵀ n (not normalised) */
export function m34NormalFromInverse(inv: Num3, n: Num3, o: V3): V3 {
  const x = n[0]!, y = n[1]!, z = n[2]!;
  const ox = inv[0]! * x + inv[1]! * y + inv[2]! * z;
  const oy = inv[3]! * x + inv[4]! * y + inv[5]! * z;
  const oz = inv[6]! * x + inv[7]! * y + inv[8]! * z;
  o[0] = ox; o[1] = oy; o[2] = oz;
  return o;
}
/** inverse of an affine 3×4; false (out untouched) when singular */
export function m34Invert(m: Num3, o: Float64Array): boolean {
  const a = m[0]!, b = m[1]!, c = m[2]!, d = m[3]!, e = m[4]!, f = m[5]!, g = m[6]!, h = m[7]!, i = m[8]!;
  // columns X=(a,b,c) Y=(d,e,f) Z=(g,h,i); A = [[a,d,g],[b,e,h],[c,f,i]]
  const c00 = e * i - h * f, c01 = -(d * i - g * f), c02 = d * h - g * e;
  const det = a * c00 + b * c01 + c * c02;
  if (!(Math.abs(det) > 1e-18)) return false;
  const k = 1 / det;
  // inverse rows r0 = (c00, c01, c02)/det … stored column-major
  const i00 = c00 * k, i01 = c01 * k, i02 = c02 * k;
  const i10 = -(b * i - h * c) * k, i11 = (a * i - g * c) * k, i12 = -(a * h - g * b) * k;
  const i20 = (b * f - e * c) * k, i21 = -(a * f - d * c) * k, i22 = (a * e - d * b) * k;
  const tx = m[9]!, ty = m[10]!, tz = m[11]!;
  o[0] = i00; o[1] = i10; o[2] = i20;
  o[3] = i01; o[4] = i11; o[5] = i21;
  o[6] = i02; o[7] = i12; o[8] = i22;
  o[9] = -(i00 * tx + i01 * ty + i02 * tz);
  o[10] = -(i10 * tx + i11 * ty + i12 * tz);
  o[11] = -(i20 * tx + i21 * ty + i22 * tz);
  return true;
}
/** rotation matrix (3×3 column-major, the first 9 entries of a 3×4) from a unit quaternion */
export function rotFromQuat(q: { x: number; y: number; z: number; w: number }, o: Float64Array): Float64Array {
  const { x, y, z, w } = q;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  o[0] = 1 - (yy + zz); o[1] = xy + wz; o[2] = xz - wy;
  o[3] = xy - wz; o[4] = 1 - (xx + zz); o[5] = yz + wx;
  o[6] = xz + wy; o[7] = yz - wx; o[8] = 1 - (xx + yy);
  return o;
}

// ── closest points ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** closest point of triangle t@off to p (Ericson 5.1.5); returns the squared distance */
export function closestPtPointTriangle(p: Num3, t: Num3, off: number, o: V3): number {
  return closestPointTri(p[0]!, p[1]!, p[2]!, t, off, o);
}

function closestPointTri(px: number, py: number, pz: number, t: Num3, off: number, o: V3): number {
  const ax = t[off]!, ay = t[off + 1]!, az = t[off + 2]!;
  const bx = t[off + 3]!, by = t[off + 4]!, bz = t[off + 5]!;
  const cx = t[off + 6]!, cy = t[off + 7]!, cz = t[off + 8]!;
  const abx = bx - ax, aby = by - ay, abz = bz - az;
  const acx = cx - ax, acy = cy - ay, acz = cz - az;
  const apx = px - ax, apy = py - ay, apz = pz - az;
  const d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
  let rx: number, ry: number, rz: number;
  if (d1 <= 0 && d2 <= 0) { rx = ax; ry = ay; rz = az; } else {
    const bpx = px - bx, bpy = py - by, bpz = pz - bz;
    const d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
    if (d3 >= 0 && d4 <= d3) { rx = bx; ry = by; rz = bz; } else {
      const vc = d1 * d4 - d3 * d2;
      if (vc <= 0 && d1 >= 0 && d3 <= 0) {
        const v = d1 / (d1 - d3);
        rx = ax + v * abx; ry = ay + v * aby; rz = az + v * abz;
      } else {
        const cpx = px - cx, cpy = py - cy, cpz = pz - cz;
        const d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
        if (d6 >= 0 && d5 <= d6) { rx = cx; ry = cy; rz = cz; } else {
          const vb = d5 * d2 - d1 * d6;
          if (vb <= 0 && d2 >= 0 && d6 <= 0) {
            const w = d2 / (d2 - d6);
            rx = ax + w * acx; ry = ay + w * acy; rz = az + w * acz;
          } else {
            const va = d3 * d6 - d5 * d4;
            if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
              const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
              rx = bx + w * (cx - bx); ry = by + w * (cy - by); rz = bz + w * (cz - bz);
            } else {
              const sum = va + vb + vc;
              if (sum > 0) {
                const v = vb / sum, w = vc / sum;
                rx = ax + abx * v + acx * w; ry = ay + aby * v + acy * w; rz = az + abz * v + acz * w;
              } else {
                // degenerate (zero-area) triangle: nearest of its three edges
                return closestOnDegenerateTri(px, py, pz, t, off, o);
              }
            }
          }
        }
      }
    }
  }
  o[0] = rx; o[1] = ry; o[2] = rz;
  const dx = px - rx, dy = py - ry, dz = pz - rz;
  return dx * dx + dy * dy + dz * dz;
}

const S_P = v3(), S_Q = v3(), S_C1 = v3(), S_C2 = v3(), S_E0 = v3(), S_E1 = v3();

function closestOnDegenerateTri(px: number, py: number, pz: number, t: Num3, off: number, o: V3): number {
  v3set(S_P, px, py, pz);
  let best = Infinity;
  for (let e = 0; e < 3; e++) {
    v3copy(S_E0, t, off + e * 3);
    v3copy(S_E1, t, off + ((e + 1) % 3) * 3);
    const d = closestPtSegmentSegment(S_P, S_P, S_E0, S_E1, S_C1, S_C2);
    if (d < best) { best = d; o[0] = S_C2[0]!; o[1] = S_C2[1]!; o[2] = S_C2[2]!; }
  }
  return best;
}

/** closest points c1 ∈ [p1,q1], c2 ∈ [p2,q2] (Ericson 5.1.9); returns the squared distance */
export function closestPtSegmentSegment(p1: Num3, q1: Num3, p2: Num3, q2: Num3, c1: V3, c2: V3): number {
  const d1x = q1[0]! - p1[0]!, d1y = q1[1]! - p1[1]!, d1z = q1[2]! - p1[2]!;
  const d2x = q2[0]! - p2[0]!, d2y = q2[1]! - p2[1]!, d2z = q2[2]! - p2[2]!;
  const rx = p1[0]! - p2[0]!, ry = p1[1]! - p2[1]!, rz = p1[2]! - p2[2]!;
  const a = d1x * d1x + d1y * d1y + d1z * d1z, e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  let s: number, t: number;
  if (a <= EPS_SQ && e <= EPS_SQ) { s = 0; t = 0; } else if (a <= EPS_SQ) { s = 0; t = clamp01(f / e); } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPS_SQ) { t = 0; s = clamp01(-c / a); } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denom = a * e - b * b;
      s = denom > EPS_SQ * a * e ? clamp01((b * f - c * e) / denom) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = clamp01(-c / a); } else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
    }
  }
  c1[0] = p1[0]! + d1x * s; c1[1] = p1[1]! + d1y * s; c1[2] = p1[2]! + d1z * s;
  c2[0] = p2[0]! + d2x * t; c2[1] = p2[1]! + d2y * t; c2[2] = p2[2]! + d2z * t;
  const dx = c1[0]! - c2[0]!, dy = c1[1]! - c2[1]!, dz = c1[2]! - c2[2]!;
  return dx * dx + dy * dy + dz * dz;
}

/** closest points between segment [p,q] and triangle t@off; returns the squared distance (0 when the segment pierces it) */
export function closestPtSegmentTriangle(p: Num3, q: Num3, t: Num3, off: number, cSeg: V3, cTri: V3): number {
  if (segmentPiercesTri(p[0]!, p[1]!, p[2]!, q[0]!, q[1]!, q[2]!, t, off, cSeg)) {
    cTri[0] = cSeg[0]!; cTri[1] = cSeg[1]!; cTri[2] = cSeg[2]!;
    return 0;
  }
  let best = closestPtPointTriangle(p, t, off, cTri);
  cSeg[0] = p[0]!; cSeg[1] = p[1]!; cSeg[2] = p[2]!;
  const dq = closestPtPointTriangle(q, t, off, S_C2);
  if (dq < best) { best = dq; cSeg[0] = q[0]!; cSeg[1] = q[1]!; cSeg[2] = q[2]!; cTri.set(S_C2); }
  for (let e = 0; e < 3; e++) {
    v3copy(S_E0, t, off + e * 3);
    v3copy(S_E1, t, off + ((e + 1) % 3) * 3);
    const d = closestPtSegmentSegment(p, q, S_E0, S_E1, S_C1, S_C2);
    if (d < best) { best = d; cSeg.set(S_C1); cTri.set(S_C2); }
  }
  return best;
}

/** does segment [p,q] cross the plane of the triangle inside it (exactly coplanar segments: no)? point → o */
function segmentPiercesTri(px: number, py: number, pz: number, qx: number, qy: number, qz: number, t: Num3, off: number, o: V3): boolean {
  const ax = t[off]!, ay = t[off + 1]!, az = t[off + 2]!;
  const e1x = t[off + 3]! - ax, e1y = t[off + 4]! - ay, e1z = t[off + 5]! - az;
  const e2x = t[off + 6]! - ax, e2y = t[off + 7]! - ay, e2z = t[off + 8]! - az;
  const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  const sp = (px - ax) * nx + (py - ay) * ny + (pz - az) * nz;
  const sq = (qx - ax) * nx + (qy - ay) * ny + (qz - az) * nz;
  if ((sp > 0 && sq > 0) || (sp < 0 && sq < 0) || sp === sq) return false;
  const k = sp / (sp - sq);
  const x = px + (qx - px) * k, y = py + (qy - py) * k, z = pz + (qz - pz) * k;
  if (!insideTri(x - ax, y - ay, z - az, e1x, e1y, e1z, e2x, e2y, e2z)) return false;
  o[0] = x; o[1] = y; o[2] = z;
  return true;
}

/** does p project (along the triangle normal) inside triangle t@off? */
export function projectsInsideTri(px: number, py: number, pz: number, t: Num3, off: number): boolean {
  const ax = t[off]!, ay = t[off + 1]!, az = t[off + 2]!;
  return insideTri(px - ax, py - ay, pz - az, t[off + 3]! - ax, t[off + 4]! - ay, t[off + 5]! - az, t[off + 6]! - ax, t[off + 7]! - ay, t[off + 8]! - az);
}

/** is the in-plane offset (wx,wy,wz) from v0 inside the triangle spanned by e1, e2 (barycentric, inclusive)? */
function insideTri(wx: number, wy: number, wz: number, e1x: number, e1y: number, e1z: number, e2x: number, e2y: number, e2z: number): boolean {
  const d11 = e1x * e1x + e1y * e1y + e1z * e1z, d12 = e1x * e2x + e1y * e2y + e1z * e2z, d22 = e2x * e2x + e2y * e2y + e2z * e2z;
  const dw1 = wx * e1x + wy * e1y + wz * e1z, dw2 = wx * e2x + wy * e2y + wz * e2z;
  const den = d11 * d22 - d12 * d12;
  if (!(den > 0)) return false;
  const u = (d22 * dw1 - d12 * dw2) / den, v = (d11 * dw2 - d12 * dw1) / den;
  return u >= 0 && v >= 0 && u + v <= 1;
}

// ── rays ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Möller–Trumbore, two-sided. d need not be unit (t is in units of d). Returns t ∈ [0, tMax] or -1. */
export function rayTriangle(o: Num3, d: Num3, t: Num3, off: number, tMax: number): number {
  return rayTri(o[0]!, o[1]!, o[2]!, d[0]!, d[1]!, d[2]!, t, off, tMax);
}

export function rayTri(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, t: Num3, off: number, tMax: number): number {
  const ax = t[off]!, ay = t[off + 1]!, az = t[off + 2]!;
  const e1x = t[off + 3]! - ax, e1y = t[off + 4]! - ay, e1z = t[off + 5]! - az;
  const e2x = t[off + 6]! - ax, e2y = t[off + 7]! - ay, e2z = t[off + 8]! - az;
  const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (det > -1e-14 && det < 1e-14) return -1;
  const inv = 1 / det;
  const sx = ox - ax, sy = oy - ay, sz = oz - az;
  const u = (sx * px + sy * py + sz * pz) * inv;
  if (u < 0 || u > 1) return -1;
  const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inv;
  if (v < 0 || u + v > 1) return -1;
  const tt = (e2x * qx + e2y * qy + e2z * qz) * inv;
  return tt < 0 || tt > tMax ? -1 : tt;
}

/** unit normal of triangle t@off, flipped to face against d (towards a ray origin) */
export function triNormalFacing(t: Num3, off: number, dx: number, dy: number, dz: number, o: V3): V3 {
  const ax = t[off]!, ay = t[off + 1]!, az = t[off + 2]!;
  const e1x = t[off + 3]! - ax, e1y = t[off + 4]! - ay, e1z = t[off + 5]! - az;
  const e2x = t[off + 6]! - ax, e2y = t[off + 7]! - ay, e2z = t[off + 8]! - az;
  let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (l > 0) { nx /= l; ny /= l; nz /= l; } else { nx = -dx; ny = -dy; nz = -dz; }
  if (nx * dx + ny * dy + nz * dz > 0) { nx = -nx; ny = -ny; nz = -nz; }
  o[0] = nx; o[1] = ny; o[2] = nz;
  return o;
}

/** interval [IV_IN, IV_OUT] of a line with a solid sphere / capsule; module scratch to stay allocation-free */
let IV_IN = 0;
let IV_OUT = 0;

function sphereInterval(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, cx: number, cy: number, cz: number, r: number): boolean {
  const mx = ox - cx, my = oy - cy, mz = oz - cz;
  const b = mx * dx + my * dy + mz * dz;
  const c = mx * mx + my * my + mz * mz - r * r;
  const disc = b * b - c;
  if (disc < 0) return false;
  const s = Math.sqrt(disc);
  IV_IN = -b - s; IV_OUT = -b + s;
  return true;
}

/** union interval of the line o + t·d (d unit) with the solid capsule [p,q] ⊕ r */
function capsuleInterval(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  px: number, py: number, pz: number, qx: number, qy: number, qz: number, r: number,
): boolean {
  let tin = Infinity, tout = -Infinity;
  if (sphereInterval(ox, oy, oz, dx, dy, dz, px, py, pz, r)) { tin = IV_IN; tout = IV_OUT; }
  if (qx !== px || qy !== py || qz !== pz) {
    if (sphereInterval(ox, oy, oz, dx, dy, dz, qx, qy, qz, r)) {
      if (IV_IN < tin) tin = IV_IN;
      if (IV_OUT > tout) tout = IV_OUT;
    }
    if (cylinderInterval(ox, oy, oz, dx, dy, dz, px, py, pz, qx, qy, qz, r)) {
      if (IV_IN < tin) tin = IV_IN;
      if (IV_OUT > tout) tout = IV_OUT;
    }
  }
  if (tin > tout) return false;
  IV_IN = tin; IV_OUT = tout;
  return true;
}

/** interval of the line o + t·d (d unit) with the solid finite cylinder around [p,q] (no caps), radius r */
function cylinderInterval(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  px: number, py: number, pz: number, qx: number, qy: number, qz: number, r: number,
): boolean {
  const bax = qx - px, bay = qy - py, baz = qz - pz;
  const baba = bax * bax + bay * bay + baz * baz;
  if (!(baba > EPS_SQ)) return false;
  const oax = ox - px, oay = oy - py, oaz = oz - pz;
  const bad = bax * dx + bay * dy + baz * dz, baoa = bax * oax + bay * oay + baz * oaz;
  // axial slab first (cheap)
  let a0: number, a1: number;
  if (bad > -1e-15 && bad < 1e-15) {
    if (baoa < 0 || baoa > baba) return false;
    a0 = -Infinity; a1 = Infinity;
  } else {
    a0 = -baoa / bad; a1 = (baba - baoa) / bad;
    if (a0 > a1) { const tmp = a0; a0 = a1; a1 = tmp; }
  }
  const kb = bad / baba, mb = baoa / baba;
  const kx = dx - kb * bax, ky = dy - kb * bay, kz = dz - kb * baz;
  const mx = oax - mb * bax, my = oay - mb * bay, mz = oaz - mb * baz;
  const A = kx * kx + ky * ky + kz * kz, B = mx * kx + my * ky + mz * kz, C = mx * mx + my * my + mz * mz - r * r;
  let c0: number, c1: number;
  if (A < 1e-18) {
    if (C > 0) return false;
    c0 = -Infinity; c1 = Infinity;
  } else {
    const disc = B * B - A * C;
    if (disc < 0) return false;
    const sq = Math.sqrt(disc);
    c0 = (-B - sq) / A; c1 = (-B + sq) / A;
  }
  const lo = c0 > a0 ? c0 : a0, hi = c1 < a1 ? c1 : a1;
  if (lo > hi) return false;
  IV_IN = lo; IV_OUT = hi;
  return true;
}

/** ray vs sphere surface (two-sided: from inside, the exit). d unit. Returns t ∈ [0, tMax] or -1. */
export function raySphere(o: Num3, d: Num3, c: Num3, r: number, tMax: number): number {
  if (!sphereInterval(o[0]!, o[1]!, o[2]!, d[0]!, d[1]!, d[2]!, c[0]!, c[1]!, c[2]!, r)) return -1;
  return pickSurface(tMax);
}

/** ray vs capsule surface [p,q] ⊕ r (two-sided: from inside, the exit). d unit. Returns t ∈ [0, tMax] or -1. */
export function rayCapsule(o: Num3, d: Num3, p: Num3, q: Num3, r: number, tMax: number): number {
  if (!capsuleInterval(o[0]!, o[1]!, o[2]!, d[0]!, d[1]!, d[2]!, p[0]!, p[1]!, p[2]!, q[0]!, q[1]!, q[2]!, r)) return -1;
  return pickSurface(tMax);
}

function pickSurface(tMax: number): number {
  const t = IV_IN >= 0 ? IV_IN : IV_OUT;
  return t < 0 || t > tMax ? -1 : t;
}

// ── sweeps (exact, by pieces of the Minkowski sum) ────────────────────────────────────────────────────────────────────────
//
// A capsule [a,b] ⊕ r translating along unit d first touches a convex feature F at the first t where dist(S + t·d, F) ≤ r,
// i.e. where the ray t·d enters (F ⊖ S) ⊕ r. For a triangle F that region is the union of convex pieces:
//   - the triangle prisms (tri − a), (tri − b) thickened by ±r   (rays from a / b vs the prism of the triangle),
//   - per vertex v: the balls (v − a), (v − b) and the cylinder (v − S)   (rays from a / b vs the ball at v; the ray from v
//     along −d vs the cylinder around S),
//   - per edge E: the cylinders (E − a), (E − b) and the slab of the parallelogram E ⊖ S thickened by ±r.
// The union's entry time is the minimum of the pieces' entry times, and the origin lies inside the union exactly when the
// shapes already overlap (dist ≤ r, or the segment pierces the triangle). This is exact, needs no iteration and has no grazing
// failure mode (motion §4.4 names conservative advancement; the analytic union gives the same TOI without its iteration cap).
// Vertices and edges whose bounds miss the r-inflated swept bounds are skipped.

/** sentinel of the piece routines: the ray origin is already inside the piece */
const INSIDE = -2;

/** ray (o, unit d) vs the slab of triangle t@off thickened by ±r: entry time, -1, or INSIDE */
function prismEntry(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number, t: Num3, off: number, r: number, tMax: number): number {
  const ax = t[off]!, ay = t[off + 1]!, az = t[off + 2]!;
  const e1x = t[off + 3]! - ax, e1y = t[off + 4]! - ay, e1z = t[off + 5]! - az;
  const e2x = t[off + 6]! - ax, e2y = t[off + 7]! - ay, e2z = t[off + 8]! - az;
  let nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (!(nl > 0)) return -1; // degenerate triangle: its edges' pieces cover it
  nx /= nl; ny /= nl; nz /= nl;
  const s0 = (ox - ax) * nx + (oy - ay) * ny + (oz - az) * nz;
  if (s0 <= r && s0 >= -r) {
    // between the planes: inside the prism iff the projection is inside the triangle (else only side pieces can be entered)
    return insideTri(ox - ax - s0 * nx, oy - ay - s0 * ny, oz - az - s0 * nz, e1x, e1y, e1z, e2x, e2y, e2z) ? INSIDE : -1;
  }
  const dn = dx * nx + dy * ny + dz * nz;
  const sg = s0 > 0 ? 1 : -1;
  if (dn * sg >= 0) return -1;
  const tt = (sg * r - s0) / dn;
  if (tt > tMax) return -1;
  const wx = ox + dx * tt - ax - sg * r * nx, wy = oy + dy * tt - ay - sg * r * ny, wz = oz + dz * tt - az - sg * r * nz;
  return insideTri(wx, wy, wz, e1x, e1y, e1z, e2x, e2y, e2z) ? tt : -1;
}

/** classify the interval just left in IV_IN / IV_OUT: entry time, -1, or INSIDE */
function entryOf(found: boolean, tMax: number): number {
  if (!found || IV_OUT < 0) return -1;
  if (IV_IN <= 0) return INSIDE;
  return IV_IN > tMax ? -1 : IV_IN;
}

/** ray (o, unit d) vs solid capsule: entry time, -1, or INSIDE */
function capsuleEntry(
  ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
  px: number, py: number, pz: number, qx: number, qy: number, qz: number, r: number, tMax: number,
): number {
  return entryOf(capsuleInterval(ox, oy, oz, dx, dy, dz, px, py, pz, qx, qy, qz, r), tMax);
}

/**
 * The slab piece of segment [a,b] moving along unit d vs the static segment [p,q], combined radius r: the parallelogram
 * P = { (p − a) + α(q − p) + β(a − b) } thickened by ±r, entered by the ray t·d from the origin. Entry time, -1, or INSIDE.
 */
function paraSlabEntry(
  ax: number, ay: number, az: number, bx: number, by: number, bz: number, dx: number, dy: number, dz: number,
  px: number, py: number, pz: number, qx: number, qy: number, qz: number, r: number, tMax: number,
): number {
  const ux = qx - px, uy = qy - py, uz = qz - pz, wx = ax - bx, wy = ay - by, wz = az - bz;
  let nx = uy * wz - uz * wy, ny = uz * wx - ux * wz, nz = ux * wy - uy * wx;
  const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
  const uu = ux * ux + uy * uy + uz * uz, ww = wx * wx + wy * wy + wz * wz;
  if (!(nl > 1e-9 * Math.sqrt(uu * ww)) || !(nl > 0)) return -1; // parallel or degenerate: the cylinders and balls cover it
  nx /= nl; ny /= nl; nz /= nl;
  const cx = px - ax, cy = py - ay, cz = pz - az; // corner of P
  const s0 = -(cx * nx + cy * ny + cz * nz); // signed distance of the origin from P's plane
  const uw = ux * wx + uy * wy + uz * wz;
  const den = uu * ww - uw * uw;
  if (s0 <= r && s0 >= -r) {
    return inPara(-s0 * nx - cx, -s0 * ny - cy, -s0 * nz - cz, ux, uy, uz, wx, wy, wz, uu, ww, uw, den) ? INSIDE : -1;
  }
  const dn = dx * nx + dy * ny + dz * nz;
  const sg = s0 > 0 ? 1 : -1;
  if (dn * sg >= 0) return -1;
  const tt = (sg * r - s0) / dn;
  if (tt > tMax) return -1;
  return inPara(dx * tt - sg * r * nx - cx, dy * tt - sg * r * ny - cy, dz * tt - sg * r * nz - cz, ux, uy, uz, wx, wy, wz, uu, ww, uw, den) ? tt : -1;
}

/** is y = α·u + β·w with α, β ∈ [0, 1]? (u, w span the parallelogram; Gram terms precomputed) */
function inPara(
  yx: number, yy: number, yz: number, ux: number, uy: number, uz: number, wx: number, wy: number, wz: number,
  uu: number, ww: number, uw: number, den: number,
): boolean {
  const yu = yx * ux + yy * uy + yz * uz, yw = yx * wx + yy * wy + yz * wz;
  const al = (ww * yu - uw * yw) / den, be = (uu * yw - uw * yu) / den;
  return al >= 0 && al <= 1 && be >= 0 && be <= 1;
}

/** every piece of the moving segment [a,b] (unit d) vs the static segment [p,q], radius r: min entry ≤ tMax, -1, or INSIDE */
function segSegPieces(
  ax: number, ay: number, az: number, bx: number, by: number, bz: number, dx: number, dy: number, dz: number,
  px: number, py: number, pz: number, qx: number, qy: number, qz: number, r: number, tMax: number,
): number {
  let best = -1;
  let e = capsuleEntry(ax, ay, az, dx, dy, dz, px, py, pz, qx, qy, qz, r, tMax);
  if (e === INSIDE) return INSIDE;
  if (e >= 0) { best = e; tMax = e; }
  e = capsuleEntry(bx, by, bz, dx, dy, dz, px, py, pz, qx, qy, qz, r, tMax);
  if (e === INSIDE) return INSIDE;
  if (e >= 0) { best = e; tMax = e; }
  e = capsuleEntry(px, py, pz, -dx, -dy, -dz, ax, ay, az, bx, by, bz, r, tMax);
  if (e === INSIDE) return INSIDE;
  if (e >= 0) { best = e; tMax = e; }
  e = capsuleEntry(qx, qy, qz, -dx, -dy, -dz, ax, ay, az, bx, by, bz, r, tMax);
  if (e === INSIDE) return INSIDE;
  if (e >= 0) { best = e; tMax = e; }
  e = paraSlabEntry(ax, ay, az, bx, by, bz, dx, dy, dz, px, py, pz, qx, qy, qz, r, tMax);
  if (e === INSIDE) return INSIDE;
  return e >= 0 ? e : best;
}

const W_SEG = v3(), W_TRI = v3(), W_A = v3(), W_B = v3();

/**
 * Time of impact of the capsule [a,b] ⊕ r (a and b equal: a sphere) translating along unit d against triangle t@off, within
 * [0, tMax]; -1 for no contact. Already overlapping at t = 0: returns 0, or -1 when `ignoreSeparating` and the motion does
 * not go deeper (d · n ≥ 0 with n from the triangle to the shape; Rapier's `stop_at_penetration: false`).
 */
export function sweepCapsuleTriangle(a: Num3, b: Num3, r: number, d: Num3, tMax: number, t: Num3, off: number, ignoreSeparating: boolean): number {
  const ax = a[0]!, ay = a[1]!, az = a[2]!, bx = b[0]!, by = b[1]!, bz = b[2]!, dx = d[0]!, dy = d[1]!, dz = d[2]!;
  const v0x = t[off]!, v0y = t[off + 1]!, v0z = t[off + 2]!;
  // plane distances of both ends; cheap reject when they stay farther than r on one side for the whole motion
  let fnx = 0, fny = 0, fnz = 0, sa = 0, sb = 0;
  {
    const e1x = t[off + 3]! - v0x, e1y = t[off + 4]! - v0y, e1z = t[off + 5]! - v0z;
    const e2x = t[off + 6]! - v0x, e2y = t[off + 7]! - v0y, e2z = t[off + 8]! - v0z;
    fnx = e1y * e2z - e1z * e2y; fny = e1z * e2x - e1x * e2z; fnz = e1x * e2y - e1y * e2x;
    const nl = Math.sqrt(fnx * fnx + fny * fny + fnz * fnz);
    if (nl > 0) {
      fnx /= nl; fny /= nl; fnz /= nl;
      sa = (ax - v0x) * fnx + (ay - v0y) * fny + (az - v0z) * fnz;
      sb = (bx - v0x) * fnx + (by - v0y) * fny + (bz - v0z) * fnz;
      const dn = (dx * fnx + dy * fny + dz * fnz) * tMax;
      const lo = Math.min(sa, sb, sa + dn, sb + dn), hi = Math.max(sa, sb, sa + dn, sb + dn);
      if (lo > r || hi < -r) return -1;
      // Never closer to the plane than r and not approaching it: any contact is a graze at exactly r along the face normal,
      // which the motion does not deepen (a capsule sliding along the floor across coplanar triangles).
      if (ignoreSeparating && ((lo >= r && dn >= 0) || (hi <= -r && dn <= 0))) return -1;
    }
  }
  // swept bounds of the shape, inflated by r
  const mx = dx * tMax, my = dy * tMax, mz = dz * tMax;
  const x0 = Math.min(ax, bx, ax + mx, bx + mx) - r, x1 = Math.max(ax, bx, ax + mx, bx + mx) + r;
  const y0 = Math.min(ay, by, ay + my, by + my) - r, y1 = Math.max(ay, by, ay + my, by + my) + r;
  const z0 = Math.min(az, bz, az + mz, bz + mz) - r, z1 = Math.max(az, bz, az + mz, bz + mz) + r;
  const sphere = ax === bx && ay === by && az === bz;
  let best = -1;
  let lim = tMax;
  let e = prismEntry(ax, ay, az, dx, dy, dz, t, off, r, lim);
  if (e >= 0) { best = e; lim = e; }
  if (e !== INSIDE && !sphere) {
    e = prismEntry(bx, by, bz, dx, dy, dz, t, off, r, lim);
    if (e >= 0) { best = e; lim = e; }
    if (e !== INSIDE && segmentPiercesTri(ax, ay, az, bx, by, bz, t, off, W_SEG)) e = INSIDE;
  }
  // vertices: the balls seen from a and b, and the cylinder around S seen from the vertex
  for (let k = 0; k < 3 && e !== INSIDE; k++) {
    const vx = t[off + k * 3]!, vy = t[off + k * 3 + 1]!, vz = t[off + k * 3 + 2]!;
    if (vx < x0 || vx > x1 || vy < y0 || vy > y1 || vz < z0 || vz > z1) continue;
    e = entryOf(sphereInterval(ax, ay, az, dx, dy, dz, vx, vy, vz, r), lim);
    if (e >= 0) { best = e; lim = e; }
    if (sphere || e === INSIDE) continue;
    e = entryOf(sphereInterval(bx, by, bz, dx, dy, dz, vx, vy, vz, r), lim);
    if (e >= 0) { best = e; lim = e; }
    if (e === INSIDE) continue;
    e = entryOf(cylinderInterval(vx, vy, vz, -dx, -dy, -dz, ax, ay, az, bx, by, bz, r), lim);
    if (e >= 0) { best = e; lim = e; }
  }
  // edges: the cylinders seen from a and b, and the parallelogram slab
  for (let k = 0; k < 3 && e !== INSIDE; k++) {
    const p = off + k * 3, q = off + ((k + 1) % 3) * 3;
    const px = t[p]!, py = t[p + 1]!, pz = t[p + 2]!, qx = t[q]!, qy = t[q + 1]!, qz = t[q + 2]!;
    if ((px < x0 && qx < x0) || (px > x1 && qx > x1) || (py < y0 && qy < y0) || (py > y1 && qy > y1) || (pz < z0 && qz < z0) || (pz > z1 && qz > z1)) continue;
    e = entryOf(cylinderInterval(ax, ay, az, dx, dy, dz, px, py, pz, qx, qy, qz, r), lim);
    if (e >= 0) { best = e; lim = e; }
    if (sphere || e === INSIDE) continue;
    e = entryOf(cylinderInterval(bx, by, bz, dx, dy, dz, px, py, pz, qx, qy, qz, r), lim);
    if (e >= 0) { best = e; lim = e; }
    if (e === INSIDE) continue;
    e = paraSlabEntry(ax, ay, az, bx, by, bz, dx, dy, dz, px, py, pz, qx, qy, qz, r, lim);
    if (e >= 0) { best = e; lim = e; }
  }
  if (e !== INSIDE) return best;
  if (!ignoreSeparating) return 0;
  // Overlapping: keep it only when the motion goes deeper. Both ends on one side with the nearer end projecting inside the
  // triangle: the closest pair is that end and its projection, so n = the face normal towards the segment (no search).
  let nx: number, ny: number, nz: number;
  const nearA = Math.abs(sa) <= Math.abs(sb);
  if (sa * sb > 0 && projectsInsideTri(nearA ? ax : bx, nearA ? ay : by, nearA ? az : bz, t, off)) {
    const sg = sa > 0 ? 1 : -1;
    nx = fnx * sg; ny = fny * sg; nz = fnz * sg;
  } else {
    const dist2 = closestPtSegmentTriangle(a, b, t, off, W_SEG, W_TRI);
    if (dist2 > 1e-18) {
      nx = W_SEG[0]! - W_TRI[0]!; ny = W_SEG[1]! - W_TRI[1]!; nz = W_SEG[2]! - W_TRI[2]!;
    } else {
      // pierced or touching the face: the face normal on the side of the segment's midpoint
      const sg = sa + sb >= 0 ? 1 : -1;
      nx = fnx * sg; ny = fny * sg; nz = fnz * sg;
    }
  }
  return dx * nx + dy * ny + dz * nz < 0 ? 0 : -1;
}

/**
 * Time of impact of capsule [a,b] translating along unit d against the static capsule [p,q], combined radius r (= r1 + r2);
 * -1 for none; overlap at t = 0 as in sweepCapsuleTriangle.
 */
export function sweepCapsuleCapsule(a: Num3, b: Num3, d: Num3, p: Num3, q: Num3, r: number, tMax: number, ignoreSeparating: boolean): number {
  const e = segSegPieces(a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!, d[0]!, d[1]!, d[2]!, p[0]!, p[1]!, p[2]!, q[0]!, q[1]!, q[2]!, r, tMax);
  if (e !== INSIDE) return e;
  if (!ignoreSeparating) return 0;
  const d2 = closestPtSegmentSegment(a, b, p, q, W_A, W_B);
  if (d2 <= 1e-18) return 0;
  const nx = W_A[0]! - W_B[0]!, ny = W_A[1]! - W_B[1]!, nz = W_A[2]! - W_B[2]!;
  return d[0]! * nx + d[1]! * ny + d[2]! * nz < 0 ? 0 : -1;
}
