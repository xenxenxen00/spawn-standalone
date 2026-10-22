// DR-53 S3: the fx world's three-free maths (src/render/fx/world/fx-math.ts) against the three r186 calls they replace, bit
// for bit (`Object.is` on every float: -0 and NaN count), over 10⁶ random inputs and the edge cases: a zero determinant, a
// singular matrix, the opposite and the near-opposite of +Y, zero and denormal velocities, signed zeros.
import { describe, expect, it } from 'vitest';
import { Euler, Matrix4, Object3D, Quaternion, Vector3 } from 'three/webgpu';
import { applyPointInto, applyPointZ, composeInto, invertInto, multiplyInto, point, rotation, rotationFromY, rotationIdentity } from '../../../../src/render/fx/world/fx-math.ts';

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rnd = mulberry32(53);
/** a number of a varied magnitude and sign, now and then a signed zero, an integer or a denormal */
function num(): number {
  const k = rnd();
  if (k < 0.02) return rnd() < 0.5 ? 0 : -0;
  if (k < 0.04) return Math.round((rnd() - 0.5) * 20);
  if (k < 0.05) return (rnd() - 0.5) * 1e-310;
  if (k < 0.15) return (rnd() - 0.5) * 2000;
  if (k < 0.25) return (rnd() - 0.5) * 1e-4;
  return (rnd() - 0.5) * 4;
}
/** a camera-like world matrix (rotation, translation, unit scale) or 16 arbitrary numbers */
function matrix(): number[] {
  if (rnd() < 0.5) {
    const m = new Matrix4().compose(new Vector3(num(), num(), num()), new Quaternion().setFromEuler(new Euler(rnd() * 6.3, rnd() * 6.3, rnd() * 6.3, 'YXZ')), new Vector3(1, 1, 1));
    return m.elements.slice();
  }
  return Array.from({ length: 16 }, num);
}

const same = (a: ArrayLike<number>, b: ArrayLike<number>, n: number): boolean => {
  for (let i = 0; i < n; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
};

describe('fx-math: three r186 written out on numbers', () => {
  it('invert, applyMatrix4, worldToLocal, compose, setFromUnitVectors and multiply agree bit for bit over 10⁶ inputs', () => {
    const N = 1_000_000;
    const inv = new Float64Array(16);
    const prod = new Float64Array(16);
    const out32 = new Float32Array(32);
    const ref32 = new Float32Array(32);
    const m = new Matrix4(), m2 = new Matrix4(), r = new Matrix4();
    const v = new Vector3(), q = new Quaternion(), up = new Vector3(0, 1, 0), s = new Vector3();
    const bad = { invert: 0, apply: 0, applyZ: 0, rotation: 0, compose: 0, multiply: 0 };
    for (let i = 0; i < N; i++) {
      const src = matrix();
      m.fromArray(src);
      invertInto(src, inv);
      r.copy(m).invert();
      if (!same(inv, r.elements, 16)) bad.invert++;
      const x = num(), y = num(), z = num();
      applyPointInto(inv, x, y, z);
      v.set(x, y, z).applyMatrix4(r);
      if (!Object.is(point[0], v.x) || !Object.is(point[1], v.y) || !Object.is(point[2], v.z)) bad.apply++;
      if (!Object.is(applyPointZ(inv, x, y, z), v.z)) bad.applyZ++;
      // a velocity, normalised as the fills do (`Vector3.normalize`: times 1 / (length || 1))
      const vx = num(), vy = num(), vz = num();
      const k = 1 / (Math.sqrt(vx * vx + vy * vy + vz * vz) || 1);
      rotationFromY(vx * k, vy * k, vz * k);
      q.setFromUnitVectors(up, v.set(vx, vy, vz).normalize());
      if (!Object.is(rotation[0], q.x) || !Object.is(rotation[1], q.y) || !Object.is(rotation[2], q.z) || !Object.is(rotation[3], q.w)) bad.rotation++;
      const at = (i & 1) * 16;
      const px = num(), py = num(), pz = num(), sx = num(), sy = num(), sz = num();
      composeInto(out32, at, px, py, pz, sx, sy, sz);
      m2.compose(v.set(px, py, pz), q, s.set(sx, sy, sz)).toArray(ref32, at);
      if (!same(out32.subarray(at, at + 16), ref32.subarray(at, at + 16), 16)) bad.compose++;
      const b = matrix();
      multiplyInto(src, b, prod);
      m2.multiplyMatrices(m, r.fromArray(b));
      if (!same(prod, m2.elements, 16)) bad.multiply++;
    }
    expect(bad).toEqual({ invert: 0, apply: 0, applyZ: 0, rotation: 0, compose: 0, multiply: 0 });
  }, 120_000);

  it('a zero determinant inverts to the zero matrix, as three', () => {
    const inv = new Float64Array(16).fill(7);
    for (const src of [new Array<number>(16).fill(0), [1, 2, 3, 4, 2, 4, 6, 8, 0, 0, 1, 0, 0, 0, 0, 1], [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 5, 6, 7, 1]]) {
      invertInto(src, inv);
      const r = new Matrix4().fromArray(src).invert();
      expect(same(inv, r.elements, 16), JSON.stringify(src)).toBe(true);
      expect([...inv].every((e) => Object.is(e, 0))).toBe(true);
    }
  });

  it('the opposite of +Y takes three\'s antiparallel branch (y = -from.z, a signed zero), the near-opposite too', () => {
    const q = new Quaternion();
    const up = new Vector3(0, 1, 0);
    for (const t of [[0, -1, 0], [-0, -1, -0], [1e-9, -1, 0], [0, -1, 1e-5], [0, -0.99999999999, 1e-6], [0, 1, 0], [1, 0, 0], [0, 0, -1]] as const) {
      const v = new Vector3(...t).normalize();
      q.setFromUnitVectors(up, v);
      rotationFromY(v.x, v.y, v.z);
      expect([Object.is(rotation[0], q.x), Object.is(rotation[1], q.y), Object.is(rotation[2], q.z), Object.is(rotation[3], q.w)], JSON.stringify(t)).toEqual([true, true, true, true]);
    }
    rotationIdentity();
    expect([...rotation]).toEqual([0, 0, 0, 1]);
    const id = new Quaternion().identity();
    expect([id.x, id.y, id.z, id.w]).toEqual([...rotation]);
  });

  it('a zero or denormal velocity normalises as `Vector3.normalize` does (length || 1)', () => {
    for (const t of [[0, 0, 0], [-0, 0, -0], [1e-320, 0, 0], [0, -5e-324, 0]] as const) {
      const v = new Vector3(...t).normalize();
      const k = 1 / (Math.sqrt(t[0] * t[0] + t[1] * t[1] + t[2] * t[2]) || 1);
      expect([Object.is(t[0] * k, v.x), Object.is(t[1] * k, v.y), Object.is(t[2] * k, v.z)], JSON.stringify(t)).toEqual([true, true, true]);
    }
  });

  it('worldToLocal of an object is applyMatrix4 of the inverse of its world matrix, with the same floats', () => {
    const parent = new Object3D();
    const o = new Object3D();
    parent.add(o);
    parent.position.set(3.25, -1.5, 7);
    parent.rotation.set(0.3, 1.1, -0.2);
    o.position.set(-2, 0.75, 0.125);
    o.rotation.set(-0.4, 2.2, 0.05, 'YXZ');
    o.updateWorldMatrix(true, false);
    const inv = invertInto(o.matrixWorld.elements, new Float64Array(16));
    for (let i = 0; i < 10_000; i++) {
      const x = num(), y = num(), z = num();
      const v = o.worldToLocal(new Vector3(x, y, z));
      applyPointInto(inv, x, y, z);
      expect(Object.is(point[0], v.x) && Object.is(point[1], v.y) && Object.is(point[2], v.z)).toBe(true);
    }
  });
});
