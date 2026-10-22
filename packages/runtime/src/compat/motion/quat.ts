// Allocation-free vec3 / quaternion / mat4 helpers (docs/design/motion-physics-nav.md §2; shared with physics/math.ts).
//
// Conventions: quaternions are (x, y, z, w); products are Hamilton products (`a·b` applies b first, then a); matrices are 4×4
// column-major (glTF convention: element (row r, col c) at index c·4 + r; translation at 12..14); points are column vectors.
// Every function writes into `out` at offset `oo` and reads its inputs at their offsets, so callers can keep whole poses in one
// Float32Array. Inputs may alias `out` unless noted. Nothing here allocates.

/** Any indexable numeric store: Float32Array, Float64Array or a plain number[]. */
export type Num = Float32Array | Float64Array | number[];

const DEG = Math.PI / 180;

// ── quaternions ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export function qIdentity<T extends Num>(out: T, oo: number): T {
  out[oo] = 0;
  out[oo + 1] = 0;
  out[oo + 2] = 0;
  out[oo + 3] = 1;
  return out;
}

export function qSet<T extends Num>(out: T, oo: number, x: number, y: number, z: number, w: number): T {
  out[oo] = x;
  out[oo + 1] = y;
  out[oo + 2] = z;
  out[oo + 3] = w;
  return out;
}

export function qCopy<T extends Num>(out: T, oo: number, a: Num, ao: number): T {
  return qSet(out, oo, a[ao]!, a[ao + 1]!, a[ao + 2]!, a[ao + 3]!);
}

/** Rotation of `rad` radians about the unit axis (ax, ay, az). */
export function qFromAxisAngle<T extends Num>(out: T, oo: number, ax: number, ay: number, az: number, rad: number): T {
  const h = rad / 2;
  const s = Math.sin(h);
  return qSet(out, oo, ax * s, ay * s, az * s, Math.cos(h));
}

/** out = a·b (Hamilton). */
export function qMul<T extends Num>(out: T, oo: number, a: Num, ao: number, b: Num, bo: number): T {
  const ax = a[ao]!, ay = a[ao + 1]!, az = a[ao + 2]!, aw = a[ao + 3]!;
  const bx = b[bo]!, by = b[bo + 1]!, bz = b[bo + 2]!, bw = b[bo + 3]!;
  return qSet(
    out,
    oo,
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  );
}

/**
 * The authored-clip rotation of the live engine: `qX(pitch)·qY(yaw)·qZ(roll)`, degrees, intrinsic X then Y then Z
 * (motion §3.3.1; `.spawn/tools/motion-lib.mjs` Rxyz, measured to 0.000 m on live probes).
 */
export function qFromEulerXYZDeg<T extends Num>(out: T, oo: number, pitch: number, yaw: number, roll: number): T {
  const hx = pitch * DEG * 0.5, hy = yaw * DEG * 0.5, hz = roll * DEG * 0.5;
  const sx = Math.sin(hx), cx = Math.cos(hx);
  const sy = Math.sin(hy), cy = Math.cos(hy);
  const sz = Math.sin(hz), cz = Math.cos(hz);
  return qSet(
    out,
    oo,
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  );
}

export function qDot(a: Num, ao: number, b: Num, bo: number): number {
  return a[ao]! * b[bo]! + a[ao + 1]! * b[bo + 1]! + a[ao + 2]! * b[bo + 2]! + a[ao + 3]! * b[bo + 3]!;
}

/** Normalises; a zero quaternion becomes the identity. */
export function qNormalize<T extends Num>(out: T, oo: number, a: Num, ao: number): T {
  const x = a[ao]!, y = a[ao + 1]!, z = a[ao + 2]!, w = a[ao + 3]!;
  const l = Math.hypot(x, y, z, w);
  if (l < 1e-20) return qIdentity(out, oo);
  return qSet(out, oo, x / l, y / l, z / l, w / l);
}

/** Inverse of a unit quaternion. */
export function qConjugate<T extends Num>(out: T, oo: number, a: Num, ao: number): T {
  return qSet(out, oo, -a[ao]!, -a[ao + 1]!, -a[ao + 2]!, a[ao + 3]!);
}

/** Angle in radians between two unit rotations, in [0, π] (q and −q are the same rotation). */
export function qAngle(a: Num, ao: number, b: Num, bo: number): number {
  const d = Math.min(1, Math.abs(qDot(a, ao, b, bo)));
  return 2 * Math.acos(d);
}

/** Normalised linear interpolation along the short arc (b is flipped into a's hemisphere). */
export function qNlerp<T extends Num>(out: T, oo: number, a: Num, ao: number, b: Num, bo: number, t: number): T {
  const s = qDot(a, ao, b, bo) < 0 ? -t : t;
  const u = 1 - t;
  const x = u * a[ao]! + s * b[bo]!;
  const y = u * a[ao + 1]! + s * b[bo + 1]!;
  const z = u * a[ao + 2]! + s * b[bo + 2]!;
  const w = u * a[ao + 3]! + s * b[bo + 3]!;
  const l = Math.hypot(x, y, z, w);
  if (l < 1e-20) return qCopy(out, oo, a, ao);
  return qSet(out, oo, x / l, y / l, z / l, w / l);
}

/** Spherical interpolation along the short arc (falls back to nlerp for nearly equal rotations). */
export function qSlerp<T extends Num>(out: T, oo: number, a: Num, ao: number, b: Num, bo: number, t: number): T {
  let d = qDot(a, ao, b, bo);
  const sign = d < 0 ? -1 : 1;
  d *= sign;
  if (d > 0.9995) return qNlerp(out, oo, a, ao, b, bo, t);
  const th = Math.acos(d);
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = (sign * Math.sin(t * th)) / s;
  return qSet(
    out,
    oo,
    wa * a[ao]! + wb * b[bo]!,
    wa * a[ao + 1]! + wb * b[bo + 1]!,
    wa * a[ao + 2]! + wb * b[bo + 2]!,
    wa * a[ao + 3]! + wb * b[bo + 3]!,
  );
}

/** out = q · v · q⁻¹ for a unit quaternion q. `out` may alias `v`. */
export function qRotateVec3<T extends Num>(out: T, oo: number, q: Num, qo: number, v: Num, vo: number): T {
  const qx = q[qo]!, qy = q[qo + 1]!, qz = q[qo + 2]!, qw = q[qo + 3]!;
  const vx = v[vo]!, vy = v[vo + 1]!, vz = v[vo + 2]!;
  // t = 2·(q.xyz × v); v' = v + w·t + q.xyz × t
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return v3Set(out, oo, vx + qw * tx + (qy * tz - qz * ty), vy + qw * ty + (qz * tx - qx * tz), vz + qw * tz + (qx * ty - qy * tx));
}

// ── vec3 ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export function v3Set<T extends Num>(out: T, oo: number, x: number, y: number, z: number): T {
  out[oo] = x;
  out[oo + 1] = y;
  out[oo + 2] = z;
  return out;
}

export function v3Copy<T extends Num>(out: T, oo: number, a: Num, ao: number): T {
  return v3Set(out, oo, a[ao]!, a[ao + 1]!, a[ao + 2]!);
}

export function v3Add<T extends Num>(out: T, oo: number, a: Num, ao: number, b: Num, bo: number): T {
  return v3Set(out, oo, a[ao]! + b[bo]!, a[ao + 1]! + b[bo + 1]!, a[ao + 2]! + b[bo + 2]!);
}

export function v3Sub<T extends Num>(out: T, oo: number, a: Num, ao: number, b: Num, bo: number): T {
  return v3Set(out, oo, a[ao]! - b[bo]!, a[ao + 1]! - b[bo + 1]!, a[ao + 2]! - b[bo + 2]!);
}

export function v3Scale<T extends Num>(out: T, oo: number, a: Num, ao: number, s: number): T {
  return v3Set(out, oo, a[ao]! * s, a[ao + 1]! * s, a[ao + 2]! * s);
}

export function v3Lerp<T extends Num>(out: T, oo: number, a: Num, ao: number, b: Num, bo: number, t: number): T {
  return v3Set(
    out,
    oo,
    a[ao]! + (b[bo]! - a[ao]!) * t,
    a[ao + 1]! + (b[bo + 1]! - a[ao + 1]!) * t,
    a[ao + 2]! + (b[bo + 2]! - a[ao + 2]!) * t,
  );
}

export function v3Dot(a: Num, ao: number, b: Num, bo: number): number {
  return a[ao]! * b[bo]! + a[ao + 1]! * b[bo + 1]! + a[ao + 2]! * b[bo + 2]!;
}

export function v3Length(a: Num, ao: number): number {
  return Math.hypot(a[ao]!, a[ao + 1]!, a[ao + 2]!);
}

// ── mat4 (column-major) ──────────────────────────────────────────────────────────────────────────────────────────────────

export function m4Identity<T extends Num>(out: T, oo: number): T {
  for (let i = 0; i < 16; i++) out[oo + i] = i % 5 === 0 ? 1 : 0;
  return out;
}

/** out = T · R · S (translation t, unit rotation r, scale s). */
export function m4ComposeTRS<T extends Num>(out: T, oo: number, t: Num, to: number, r: Num, ro: number, s: Num, so: number): T {
  const x = r[ro]!, y = r[ro + 1]!, z = r[ro + 2]!, w = r[ro + 3]!;
  const sx = s[so]!, sy = s[so + 1]!, sz = s[so + 2]!;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  out[oo] = (1 - (yy + zz)) * sx;
  out[oo + 1] = (xy + wz) * sx;
  out[oo + 2] = (xz - wy) * sx;
  out[oo + 3] = 0;
  out[oo + 4] = (xy - wz) * sy;
  out[oo + 5] = (1 - (xx + zz)) * sy;
  out[oo + 6] = (yz + wx) * sy;
  out[oo + 7] = 0;
  out[oo + 8] = (xz + wy) * sz;
  out[oo + 9] = (yz - wx) * sz;
  out[oo + 10] = (1 - (xx + yy)) * sz;
  out[oo + 11] = 0;
  out[oo + 12] = t[to]!;
  out[oo + 13] = t[to + 1]!;
  out[oo + 14] = t[to + 2]!;
  out[oo + 15] = 1;
  return out;
}

/** out = a · b (apply b first). `out` may alias `a` or `b`. */
export function m4Mul<T extends Num>(out: T, oo: number, a: Num, ao: number, b: Num, bo: number): T {
  const a00 = a[ao]!, a10 = a[ao + 1]!, a20 = a[ao + 2]!, a30 = a[ao + 3]!;
  const a01 = a[ao + 4]!, a11 = a[ao + 5]!, a21 = a[ao + 6]!, a31 = a[ao + 7]!;
  const a02 = a[ao + 8]!, a12 = a[ao + 9]!, a22 = a[ao + 10]!, a32 = a[ao + 11]!;
  const a03 = a[ao + 12]!, a13 = a[ao + 13]!, a23 = a[ao + 14]!, a33 = a[ao + 15]!;
  for (let c = 0; c < 4; c++) {
    const b0 = b[bo + c * 4]!, b1 = b[bo + c * 4 + 1]!, b2 = b[bo + c * 4 + 2]!, b3 = b[bo + c * 4 + 3]!;
    out[oo + c * 4] = a00 * b0 + a01 * b1 + a02 * b2 + a03 * b3;
    out[oo + c * 4 + 1] = a10 * b0 + a11 * b1 + a12 * b2 + a13 * b3;
    out[oo + c * 4 + 2] = a20 * b0 + a21 * b1 + a22 * b2 + a23 * b3;
    out[oo + c * 4 + 3] = a30 * b0 + a31 * b1 + a32 * b2 + a33 * b3;
  }
  return out;
}

/** Inverse of an affine matrix (last row 0 0 0 1). A singular linear part yields the identity. `out` may alias `a`. */
export function m4InvertAffine<T extends Num>(out: T, oo: number, a: Num, ao: number): T {
  const m00 = a[ao]!, m10 = a[ao + 1]!, m20 = a[ao + 2]!;
  const m01 = a[ao + 4]!, m11 = a[ao + 5]!, m21 = a[ao + 6]!;
  const m02 = a[ao + 8]!, m12 = a[ao + 9]!, m22 = a[ao + 10]!;
  const tx = a[ao + 12]!, ty = a[ao + 13]!, tz = a[ao + 14]!;
  const c00 = m11 * m22 - m12 * m21;
  const c01 = m12 * m20 - m10 * m22;
  const c02 = m10 * m21 - m11 * m20;
  const det = m00 * c00 + m01 * c01 + m02 * c02;
  if (Math.abs(det) < 1e-30) return m4Identity(out, oo);
  const id = 1 / det;
  // inverse of the 3×3 linear part (row r, col c) = cofactor(c, r) / det
  const i00 = c00 * id, i01 = (m02 * m21 - m01 * m22) * id, i02 = (m01 * m12 - m02 * m11) * id;
  const i10 = c01 * id, i11 = (m00 * m22 - m02 * m20) * id, i12 = (m02 * m10 - m00 * m12) * id;
  const i20 = c02 * id, i21 = (m01 * m20 - m00 * m21) * id, i22 = (m00 * m11 - m01 * m10) * id;
  out[oo] = i00;
  out[oo + 1] = i10;
  out[oo + 2] = i20;
  out[oo + 3] = 0;
  out[oo + 4] = i01;
  out[oo + 5] = i11;
  out[oo + 6] = i21;
  out[oo + 7] = 0;
  out[oo + 8] = i02;
  out[oo + 9] = i12;
  out[oo + 10] = i22;
  out[oo + 11] = 0;
  out[oo + 12] = -(i00 * tx + i01 * ty + i02 * tz);
  out[oo + 13] = -(i10 * tx + i11 * ty + i12 * tz);
  out[oo + 14] = -(i20 * tx + i21 * ty + i22 * tz);
  out[oo + 15] = 1;
  return out;
}

/** out = m · (p, 1), dropping w (affine m). `out` may alias `p`. */
export function m4TransformPoint<T extends Num>(out: T, oo: number, m: Num, mo: number, p: Num, po: number): T {
  const x = p[po]!, y = p[po + 1]!, z = p[po + 2]!;
  return v3Set(
    out,
    oo,
    m[mo]! * x + m[mo + 4]! * y + m[mo + 8]! * z + m[mo + 12]!,
    m[mo + 1]! * x + m[mo + 5]! * y + m[mo + 9]! * z + m[mo + 13]!,
    m[mo + 2]! * x + m[mo + 6]! * y + m[mo + 10]! * z + m[mo + 14]!,
  );
}
