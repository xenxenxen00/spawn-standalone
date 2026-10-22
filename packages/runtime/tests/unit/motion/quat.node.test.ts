import { describe, expect, it } from 'vitest';
import {
  m4ComposeTRS,
  m4InvertAffine,
  m4Mul,
  m4TransformPoint,
  qAngle,
  qConjugate,
  qDot,
  qFromAxisAngle,
  qFromEulerXYZDeg,
  qMul,
  qNlerp,
  qNormalize,
  qRotateVec3,
  qSlerp,
  v3Lerp,
} from '../../../src/compat/motion/quat.ts';

const close = (a: ArrayLike<number>, b: ArrayLike<number>, eps = 1e-6): void => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) expect(Math.abs(a[i]! - b[i]!), `[${i}] ${a[i]} vs ${b[i]}`).toBeLessThanOrEqual(eps);
};
const deg = Math.PI / 180;

describe('quaternions', () => {
  it('composes Euler XYZ intrinsic as qX·qY·qZ (motion §3.3.1, motion-lib.mjs Rxyz)', () => {
    const qx = qFromAxisAngle([0, 0, 0, 1], 0, 1, 0, 0, 30 * deg);
    const qy = qFromAxisAngle([0, 0, 0, 1], 0, 0, 1, 0, -50 * deg);
    const qz = qFromAxisAngle([0, 0, 0, 1], 0, 0, 0, 1, 70 * deg);
    const xy = qMul([0, 0, 0, 0], 0, qx, 0, qy, 0);
    const want = qMul([0, 0, 0, 0], 0, xy, 0, qz, 0);
    close(qFromEulerXYZDeg([0, 0, 0, 0], 0, 30, -50, 70), want, 1e-12);
  });

  it('writes at an offset of a Float32Array without touching neighbours', () => {
    const out = new Float32Array(12).fill(9);
    qFromEulerXYZDeg(out, 4, 90, 0, 0);
    close(Array.from(out.slice(0, 4)), [9, 9, 9, 9]);
    close(Array.from(out.slice(4, 8)), [Math.SQRT1_2, 0, 0, Math.SQRT1_2]);
    close(Array.from(out.slice(8)), [9, 9, 9, 9]);
  });

  it('rotates vectors: +90° about X takes +Y to +Z', () => {
    const q = qFromEulerXYZDeg([0, 0, 0, 0], 0, 90, 0, 0);
    close(qRotateVec3([0, 0, 0], 0, q, 0, [0, 1, 0], 0), [0, 0, 1]);
  });

  it('measures angles and dot products independent of hemisphere', () => {
    const a = qFromEulerXYZDeg([0, 0, 0, 0], 0, 10, 0, 0);
    const b = qFromEulerXYZDeg([0, 0, 0, 0], 0, 70, 0, 0);
    const negB = b.map((v) => -v);
    expect(qAngle(a, 0, b, 0) / deg).toBeCloseTo(60, 9);
    expect(qAngle(a, 0, negB, 0) / deg).toBeCloseTo(60, 9);
    expect(qDot(a, 0, negB, 0)).toBeLessThan(0);
  });

  it('nlerp and slerp take the short arc and agree at the ends and the midpoint direction', () => {
    const a = qFromEulerXYZDeg([0, 0, 0, 0], 0, 0, 0, 0);
    const b = qFromEulerXYZDeg([0, 0, 0, 0], 0, 0, 80, 0).map((v) => -v); // far hemisphere
    close(qNlerp([0, 0, 0, 0], 0, a, 0, b, 0, 0), a);
    close(qNlerp([0, 0, 0, 0], 0, a, 0, b, 0, 1), b.map((v) => -v));
    const s = qSlerp([0, 0, 0, 0], 0, a, 0, b, 0, 0.5);
    close(s, qFromEulerXYZDeg([0, 0, 0, 0], 0, 0, 40, 0));
    close(qNlerp([0, 0, 0, 0], 0, a, 0, b, 0, 0.5), s);
    const q = qSlerp([0, 0, 0, 0], 0, a, 0, b, 0, 0.25);
    expect(qAngle(q, 0, a, 0) / deg).toBeCloseTo(20, 6);
  });

  it('normalises and conjugates', () => {
    close(qNormalize([0, 0, 0, 0], 0, [0, 0, 2, 0], 0), [0, 0, 1, 0]);
    close(qNormalize([0, 0, 0, 0], 0, [0, 0, 0, 0], 0), [0, 0, 0, 1]);
    const q = qFromEulerXYZDeg([0, 0, 0, 0], 0, 12, 34, 56);
    close(qMul([0, 0, 0, 0], 0, q, 0, qConjugate([0, 0, 0, 0], 0, q, 0), 0), [0, 0, 0, 1]);
  });
});

describe('vec3 and mat4 (column-major, glTF convention)', () => {
  it('lerps', () => close(v3Lerp([0, 0, 0], 0, [0, 2, 4], 0, [2, 4, 8], 0, 0.5), [1, 3, 6]));

  it('composes TRS, multiplies, inverts and transforms points', () => {
    const q = qFromEulerXYZDeg([0, 0, 0, 0], 0, 0, 90, 0);
    const m = m4ComposeTRS(new Float32Array(16), 0, [1, 2, 3], 0, q, 0, [2, 2, 2], 0);
    // +X scaled by 2, rotated 90° about Y → −Z·2, then translated
    close(m4TransformPoint([0, 0, 0], 0, m, 0, [1, 0, 0], 0), [1, 2, 1], 1e-6);
    const inv = m4InvertAffine(new Float32Array(16), 0, m, 0);
    const id = m4Mul(new Float32Array(16), 0, m, 0, inv, 0);
    close(Array.from(id), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], 1e-6);
    const parent = m4ComposeTRS(new Float32Array(16), 0, [0, 1, 0], 0, [0, 0, 0, 1], 0, [1, 1, 1], 0);
    const world = m4Mul(new Float32Array(16), 0, parent, 0, m, 0);
    close(m4TransformPoint([0, 0, 0], 0, world, 0, [1, 0, 0], 0), [1, 3, 1], 1e-6);
  });
});
