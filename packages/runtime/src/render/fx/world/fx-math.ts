// three r186's maths as the fx bucket fills use it (DR-53 S3), written out on plain numbers so the three-free fx world (the
// fx Worker, and the in-process runtime) stores exactly the floats the three calls stored: the same floating-point operations
// in the same order, without a Vector3 / Quaternion / Matrix4 per particle in between. Sources: node_modules/three/src/math/
// {Matrix4,Vector3,Quaternion}.js and core/Object3D.js (`worldToLocal`). tests/unit/render/fx/fx-math.three.test.ts holds
// every function here to the three call it replaces, bit for bit.

/** the rotation of the last `rotationFromY` / `rotationIdentity`: x, y, z, w */
export const rotation = new Float64Array(4);

/**
 * `new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), t)` for the unit vector `t`, into `rotation` (three r186
 * `Quaternion.setFromUnitVectors` then `normalize`, transcribed with `vFrom` = (0, 1, 0)).
 */
export function rotationFromY(tx: number, ty: number, tz: number): void {
  const fromX = 0, fromY = 1, fromZ = 0;
  let r = fromX * tx + fromY * ty + fromZ * tz + 1;
  let x: number, y: number, z: number, w: number;
  if (r < 1e-8) {
    r = 0;
    if (Math.abs(fromX) > Math.abs(fromZ)) {
      x = -fromY; y = fromX; z = 0; w = r;
    } else {
      x = 0; y = -fromZ; z = fromY; w = r;
    }
  } else {
    x = fromY * tz - fromZ * ty;
    y = fromZ * tx - fromX * tz;
    z = fromX * ty - fromY * tx;
    w = r;
  }
  let l = Math.sqrt(x * x + y * y + z * z + w * w);
  if (l === 0) {
    x = 0; y = 0; z = 0; w = 1;
  } else {
    l = 1 / l;
    x = x * l; y = y * l; z = z * l; w = w * l;
  }
  rotation[0] = x; rotation[1] = y; rotation[2] = z; rotation[3] = w;
}

/** the identity rotation into `rotation` (`Quaternion.identity()`) */
export function rotationIdentity(): void {
  rotation[0] = 0; rotation[1] = 0; rotation[2] = 0; rotation[3] = 1;
}

/**
 * three's `Matrix4.compose(position, quaternion, scale)` then `toArray(out, at)`, written straight into `out` at `at` with the
 * quaternion of `rotation` (the same products, so the same floats).
 */
export function composeInto(out: Float32Array, at: number, px: number, py: number, pz: number, sx: number, sy: number, sz: number): void {
  const x = rotation[0]!, y = rotation[1]!, z = rotation[2]!, w = rotation[3]!;
  const x2 = x + x, y2 = y + y, z2 = z + z;
  const xx = x * x2, xy = x * y2, xz = x * z2;
  const yy = y * y2, yz = y * z2, zz = z * z2;
  const wx = w * x2, wy = w * y2, wz = w * z2;
  out[at] = (1 - (yy + zz)) * sx;
  out[at + 1] = (xy + wz) * sx;
  out[at + 2] = (xz - wy) * sx;
  out[at + 3] = 0;
  out[at + 4] = (xy - wz) * sy;
  out[at + 5] = (1 - (xx + zz)) * sy;
  out[at + 6] = (yz + wx) * sy;
  out[at + 7] = 0;
  out[at + 8] = (xz + wy) * sz;
  out[at + 9] = (yz - wx) * sz;
  out[at + 10] = (1 - (xx + yy)) * sz;
  out[at + 11] = 0;
  out[at + 12] = px;
  out[at + 13] = py;
  out[at + 14] = pz;
  out[at + 15] = 1;
}

/**
 * `Matrix4.invert` of the column-major `src` (16 numbers) into `out` (three r186, after gl-matrix): a zero determinant gives
 * the zero matrix, as three's `set(0, …, 0)`. `src` and `out` may not be the same array.
 */
export function invertInto(src: ArrayLike<number>, out: Float64Array): Float64Array {
  const n11 = src[0]!, n21 = src[1]!, n31 = src[2]!, n41 = src[3]!;
  const n12 = src[4]!, n22 = src[5]!, n32 = src[6]!, n42 = src[7]!;
  const n13 = src[8]!, n23 = src[9]!, n33 = src[10]!, n43 = src[11]!;
  const n14 = src[12]!, n24 = src[13]!, n34 = src[14]!, n44 = src[15]!;
  const t1 = n11 * n22 - n21 * n12,
    t2 = n11 * n32 - n31 * n12,
    t3 = n11 * n42 - n41 * n12,
    t4 = n21 * n32 - n31 * n22,
    t5 = n21 * n42 - n41 * n22,
    t6 = n31 * n42 - n41 * n32,
    t7 = n13 * n24 - n23 * n14,
    t8 = n13 * n34 - n33 * n14,
    t9 = n13 * n44 - n43 * n14,
    t10 = n23 * n34 - n33 * n24,
    t11 = n23 * n44 - n43 * n24,
    t12 = n33 * n44 - n43 * n34;
  const det = t1 * t12 - t2 * t11 + t3 * t10 + t4 * t9 - t5 * t8 + t6 * t7;
  if (det === 0) {
    out.fill(0);
    return out;
  }
  const detInv = 1 / det;
  out[0] = (n22 * t12 - n32 * t11 + n42 * t10) * detInv;
  out[1] = (n31 * t11 - n21 * t12 - n41 * t10) * detInv;
  out[2] = (n24 * t6 - n34 * t5 + n44 * t4) * detInv;
  out[3] = (n33 * t5 - n23 * t6 - n43 * t4) * detInv;
  out[4] = (n32 * t9 - n12 * t12 - n42 * t8) * detInv;
  out[5] = (n11 * t12 - n31 * t9 + n41 * t8) * detInv;
  out[6] = (n34 * t3 - n14 * t6 - n44 * t2) * detInv;
  out[7] = (n13 * t6 - n33 * t3 + n43 * t2) * detInv;
  out[8] = (n12 * t11 - n22 * t9 + n42 * t7) * detInv;
  out[9] = (n21 * t9 - n11 * t11 - n41 * t7) * detInv;
  out[10] = (n14 * t5 - n24 * t3 + n44 * t1) * detInv;
  out[11] = (n23 * t3 - n13 * t5 - n43 * t1) * detInv;
  out[12] = (n22 * t8 - n12 * t10 - n32 * t7) * detInv;
  out[13] = (n11 * t10 - n21 * t8 + n31 * t7) * detInv;
  out[14] = (n24 * t2 - n14 * t4 - n34 * t1) * detInv;
  out[15] = (n13 * t4 - n23 * t2 + n33 * t1) * detInv;
  return out;
}

/** the result of the last `applyPointInto` */
export const point = new Float64Array(3);

/**
 * `Vector3.applyMatrix4(m)` of (x, y, z) with the elements `e` of `m`, perspective divide included, into `point`. With the
 * inverse of an object's world matrix (`invertInto`) it is that object's `worldToLocal` (which inverts the same matrix with the
 * same operations on every call).
 */
export function applyPointInto(e: ArrayLike<number>, x: number, y: number, z: number): void {
  const w = 1 / (e[3]! * x + e[7]! * y + e[11]! * z + e[15]!);
  point[0] = (e[0]! * x + e[4]! * y + e[8]! * z + e[12]!) * w;
  point[1] = (e[1]! * x + e[5]! * y + e[9]! * z + e[13]!) * w;
  point[2] = (e[2]! * x + e[6]! * y + e[10]! * z + e[14]!) * w;
}

/** `Vector3.applyMatrix4(m).z` alone (the alpha depth of a world-space sprite: the same products, sums and divide) */
export function applyPointZ(e: ArrayLike<number>, x: number, y: number, z: number): number {
  const w = 1 / (e[3]! * x + e[7]! * y + e[11]! * z + e[15]!);
  return (e[2]! * x + e[6]! * y + e[10]! * z + e[14]!) * w;
}

/** `a · b` of two column-major 4×4 matrices into `out` (three r186 `Matrix4.multiplyMatrices`); `out` may not alias them */
export function multiplyInto(a: ArrayLike<number>, b: ArrayLike<number>, out: Float64Array): Float64Array {
  const a11 = a[0]!, a12 = a[4]!, a13 = a[8]!, a14 = a[12]!;
  const a21 = a[1]!, a22 = a[5]!, a23 = a[9]!, a24 = a[13]!;
  const a31 = a[2]!, a32 = a[6]!, a33 = a[10]!, a34 = a[14]!;
  const a41 = a[3]!, a42 = a[7]!, a43 = a[11]!, a44 = a[15]!;
  const b11 = b[0]!, b12 = b[4]!, b13 = b[8]!, b14 = b[12]!;
  const b21 = b[1]!, b22 = b[5]!, b23 = b[9]!, b24 = b[13]!;
  const b31 = b[2]!, b32 = b[6]!, b33 = b[10]!, b34 = b[14]!;
  const b41 = b[3]!, b42 = b[7]!, b43 = b[11]!, b44 = b[15]!;
  out[0] = a11 * b11 + a12 * b21 + a13 * b31 + a14 * b41;
  out[4] = a11 * b12 + a12 * b22 + a13 * b32 + a14 * b42;
  out[8] = a11 * b13 + a12 * b23 + a13 * b33 + a14 * b43;
  out[12] = a11 * b14 + a12 * b24 + a13 * b34 + a14 * b44;
  out[1] = a21 * b11 + a22 * b21 + a23 * b31 + a24 * b41;
  out[5] = a21 * b12 + a22 * b22 + a23 * b32 + a24 * b42;
  out[9] = a21 * b13 + a22 * b23 + a23 * b33 + a24 * b43;
  out[13] = a21 * b14 + a22 * b24 + a23 * b34 + a24 * b44;
  out[2] = a31 * b11 + a32 * b21 + a33 * b31 + a34 * b41;
  out[6] = a31 * b12 + a32 * b22 + a33 * b32 + a34 * b42;
  out[10] = a31 * b13 + a32 * b23 + a33 * b33 + a34 * b43;
  out[14] = a31 * b14 + a32 * b24 + a33 * b34 + a34 * b44;
  out[3] = a41 * b11 + a42 * b21 + a43 * b31 + a44 * b41;
  out[7] = a41 * b12 + a42 * b22 + a43 * b32 + a44 * b42;
  out[11] = a41 * b13 + a42 * b23 + a43 * b33 + a44 * b43;
  out[15] = a41 * b14 + a42 * b24 + a43 * b34 + a44 * b44;
  return out;
}
