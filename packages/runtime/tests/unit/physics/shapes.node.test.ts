// Kernels of motion §4.4 (math.ts, shapes.ts) against independent oracles: dense sampling of the closest-distance function for
// times of impact, point sampling for closest points, transformed triangles for instanced meshes.
import { describe, expect, it } from 'vitest';
import { StaticBvh } from '../../../src/compat/physics/bvh.ts';
import {
  closestPtPointTriangle, closestPtSegmentSegment, closestPtSegmentTriangle, m34Invert, m34Point, rayCapsule, raySphere, rayTriangle,
  sweepCapsuleTriangle, v3,
} from '../../../src/compat/physics/math.ts';
import {
  ContactList, ShapeHit, boxTriangles, capsuleFromFeet, capsuleShape, contactSphereTriangle, contactsBoxTriangle,
  icosphereTriangles, meshShape, obbShape, overlapCapsuleCapsule, overlapCapsuleTriangle, rayShape, shapeAabb, sphereShape,
  sweepCapsuleShape, type Contact,
} from '../../../src/compat/physics/shapes.ts';

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = (r: () => number, s: number): Float64Array => v3((r() - 0.5) * s, (r() - 0.5) * s, (r() - 0.5) * s);
const unit = (r: () => number): Float64Array => {
  for (;;) {
    const d = rnd(r, 2);
    const l = Math.hypot(d[0]!, d[1]!, d[2]!);
    if (l > 0.1 && l <= 1) return v3(d[0]! / l, d[1]! / l, d[2]! / l);
  }
};
const dist = (a: ArrayLike<number>, b: ArrayLike<number>): number => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

/** sampled closest distance between segment [a,b] and triangle tri (oracle, ~1e-3 accurate) */
function sampledSegTri(a: Float64Array, b: Float64Array, tri: Float64Array): number {
  let best = Infinity;
  const p = v3(), q = v3();
  for (let i = 0; i <= 200; i++) {
    const s = i / 200;
    p.set([a[0]! + (b[0]! - a[0]!) * s, a[1]! + (b[1]! - a[1]!) * s, a[2]! + (b[2]! - a[2]!) * s]);
    best = Math.min(best, Math.sqrt(closestPtPointTriangle(p, tri, 0, q)));
  }
  return best;
}

/** first time the swept segment comes within r of the triangle: dense march then bisection on the exact distance */
function marchToi(a: Float64Array, b: Float64Array, r: number, d: Float64Array, tMax: number, tri: Float64Array): number {
  const at = (t: number): number => {
    const a2 = v3(a[0]! + d[0]! * t, a[1]! + d[1]! * t, a[2]! + d[2]! * t);
    const b2 = v3(b[0]! + d[0]! * t, b[1]! + d[1]! * t, b[2]! + d[2]! * t);
    return Math.sqrt(closestPtSegmentTriangle(a2, b2, tri, 0, v3(), v3())) - r;
  };
  if (at(0) <= 0) return 0;
  const steps = 4000;
  let prev = 0;
  for (let i = 1; i <= steps; i++) {
    const t = (tMax * i) / steps;
    if (at(t) <= 0) {
      let lo = prev, hi = t;
      for (let k = 0; k < 60; k++) { const m = (lo + hi) / 2; if (at(m) <= 0) hi = m; else lo = m; }
      return hi;
    }
    prev = t;
  }
  return -1;
}

describe('closest-point kernels', () => {
  it('point–triangle and segment–triangle match sampling', () => {
    const r = rng(1);
    const out = v3(), c1 = v3(), c2 = v3();
    for (let k = 0; k < 300; k++) {
      const tri = new Float64Array([...rnd(r, 4), ...rnd(r, 4), ...rnd(r, 4)]);
      const p = rnd(r, 6);
      const d2 = closestPtPointTriangle(p, tri, 0, out);
      expect(Math.sqrt(d2)).toBeCloseTo(dist(p, out), 9);
      // no sampled point of the triangle is closer
      for (let i = 0; i < 50; i++) {
        let u = r(), v = r();
        if (u + v > 1) { u = 1 - u; v = 1 - v; }
        const s = [0, 1, 2].map((ax) => tri[ax]! + (tri[3 + ax]! - tri[ax]!) * u + (tri[6 + ax]! - tri[ax]!) * v);
        expect(dist(p, s)).toBeGreaterThanOrEqual(Math.sqrt(d2) - 1e-9);
      }
      const a = rnd(r, 6), b = rnd(r, 6);
      const ds = Math.sqrt(closestPtSegmentTriangle(a, b, tri, 0, c1, c2));
      expect(ds).toBeCloseTo(dist(c1, c2), 9);
      expect(ds).toBeLessThanOrEqual(sampledSegTri(a, b, tri) + 1e-9);
      expect(ds).toBeGreaterThan(sampledSegTri(a, b, tri) - 0.05);
    }
  });

  it('segment–segment handles parallel and degenerate segments', () => {
    const c1 = v3(), c2 = v3();
    expect(closestPtSegmentSegment(v3(0, 0, 0), v3(2, 0, 0), v3(1, 1, 0), v3(3, 1, 0), c1, c2)).toBeCloseTo(1, 12);
    expect(closestPtSegmentSegment(v3(0, 0, 0), v3(0, 0, 0), v3(-1, 2, 0), v3(1, 2, 0), c1, c2)).toBeCloseTo(4, 12);
    expect(Array.from(c2)).toEqual([0, 2, 0]);
    expect(closestPtSegmentSegment(v3(0, 0, 0), v3(1, 0, 0), v3(0, 0, 0), v3(0, 0, 0), c1, c2)).toBe(0);
  });
});

describe('ray kernels', () => {
  it('ray–triangle is two-sided and respects tMax', () => {
    const tri = new Float64Array([-1, -1, 0, 1, -1, 0, 0, 1, 0]);
    expect(rayTriangle(v3(0, 0, 5), v3(0, 0, -1), tri, 0, 10)).toBeCloseTo(5, 12);
    expect(rayTriangle(v3(0, 0, -5), v3(0, 0, 1), tri, 0, 10)).toBeCloseTo(5, 12);
    expect(rayTriangle(v3(0, 0, 5), v3(0, 0, -1), tri, 0, 4)).toBe(-1);
    expect(rayTriangle(v3(0, 0, 5), v3(0, 0, 1), tri, 0, 10)).toBe(-1);
    expect(rayTriangle(v3(3, 0, 5), v3(0, 0, -1), tri, 0, 10)).toBe(-1);
  });

  it('ray–sphere and ray–capsule entry match marching; from inside they return the exit', () => {
    const r = rng(2);
    for (let k = 0; k < 300; k++) {
      const p = rnd(r, 4), q = k % 5 === 0 ? p : rnd(r, 4), rad = 0.1 + r();
      const o = rnd(r, 12), d = unit(r);
      const inside = (t: number): boolean => {
        const x = v3(o[0]! + d[0]! * t, o[1]! + d[1]! * t, o[2]! + d[2]! * t);
        return Math.sqrt(closestPtSegmentSegment(x, x, p, q, v3(), v3())) <= rad;
      };
      let want = -1;
      if (inside(0)) {
        let t = 0;
        while (inside(t + 1e-3)) t += 1e-3;
        want = t;
      } else {
        for (let i = 1; i <= 30000; i++) if (inside(i * 1e-3)) { want = i * 1e-3; break; }
      }
      const got = rayCapsule(o, d, p, q, rad, 30);
      if (want < 0) expect(got).toBe(-1);
      else expect(Math.abs(got - want)).toBeLessThan(2e-3);
      if (p === q) {
        const s = raySphere(o, d, p, rad, 30);
        expect(Math.abs(s - got)).toBeLessThan(1e-9);
      }
    }
  });
});

describe('sweepCapsuleTriangle (time of impact)', () => {
  it('matches dense marching of the exact distance for spheres and capsules', () => {
    const r = rng(3);
    let hits = 0;
    for (let k = 0; k < 400; k++) {
      const tri = new Float64Array([...rnd(r, 5), ...rnd(r, 5), ...rnd(r, 5)]);
      const a = rnd(r, 12);
      const b = k % 3 === 0 ? a : v3(a[0]! + (r() - 0.5) * 2, a[1]! + r() * 2, a[2]! + (r() - 0.5) * 2);
      const rad = 0.05 + r() * 0.6;
      // aim roughly at the triangle so that most sweeps hit
      const aim = v3(tri[0]! + (r() - 0.5) * 3 - a[0]!, tri[1]! + (r() - 0.5) * 3 - a[1]!, tri[2]! + (r() - 0.5) * 3 - a[2]!);
      const l = Math.hypot(aim[0]!, aim[1]!, aim[2]!);
      const d = v3(aim[0]! / l, aim[1]! / l, aim[2]! / l);
      const want = marchToi(a, b, rad, d, 20, tri);
      const got = sweepCapsuleTriangle(a, b, rad, d, 20, tri, 0, false);
      if (want < 0) expect(got).toBe(-1);
      else {
        hits++;
        expect(Math.abs(got - want)).toBeLessThan(1e-4);
      }
    }
    expect(hits).toBeGreaterThan(100);
  });

  it('initial overlap: TOI 0 when approaching, ignored when separating (ignoreSeparating)', () => {
    const floor = new Float64Array([-5, 0, -5, 5, 0, -5, 0, 0, 5]);
    const a = v3(0, 0.2, 0), b = v3(0, 1.5, 0);
    expect(sweepCapsuleTriangle(a, b, 0.35, v3(0, -1, 0), 1, floor, 0, true)).toBe(0);
    expect(sweepCapsuleTriangle(a, b, 0.35, v3(0, 1, 0), 1, floor, 0, true)).toBe(-1);
    expect(sweepCapsuleTriangle(a, b, 0.35, v3(0, 1, 0), 1, floor, 0, false)).toBe(0);
    // resting exactly on the floor and walking along it: not a hit
    expect(sweepCapsuleTriangle(v3(0, 0.35, 0), v3(0, 1.55, 0), 0.35, v3(1, 0, 0), 1, floor, 0, true)).toBe(-1);
  });

  it('sliding across a coplanar seam is a graze, not a contact (ignoreSeparating); strictly it touches at the seam', () => {
    const next = new Float64Array([1, 0, -5, 1, 0, 5, 6, 0, 0]); // the neighbour triangle starts at x = 1
    const a = v3(0, 0.35, 0), b = v3(0, 1.55, 0), d = v3(1, 0, 0);
    expect(sweepCapsuleTriangle(a, b, 0.35, d, 2, next, 0, true)).toBe(-1);
    expect(sweepCapsuleTriangle(a, b, 0.35, d, 2, next, 0, false)).toBeCloseTo(1, 6);
    // but stepping down onto it from above is a contact
    expect(sweepCapsuleTriangle(v3(2, 0.5, 0), v3(2, 1.7, 0), 0.35, v3(0, -1, 0), 1, next, 0, true)).toBeCloseTo(0.15, 9);
  });
});

describe('shapes', () => {
  it('capsuleFromFeet: total height feet→top, half segment h/2 − r clamped ≥ 0', () => {
    const c = capsuleFromFeet({ x: 1, y: 2, z: 3 }, 1.9, 0.35);
    expect(Array.from(c.a)).toEqual([1, 2.35, 3]);
    expect(c.b[1]).toBeCloseTo(2 + 1.55, 12);
    expect(c.r).toBe(0.35);
    const squat = capsuleFromFeet({ x: 0, y: 0, z: 0 }, 0.5, 0.4);
    expect(squat.a[1]).toBeCloseTo(0.25, 12);
    expect(squat.b[1]).toBeCloseTo(0.25, 12);
  });

  it('box and icosphere soups: 12 and 80 triangles on the surface', () => {
    const box = boxTriangles(v3(0.5, 1, 2), null);
    expect(box.length).toBe(12 * 9);
    for (let i = 0; i < box.length; i += 3) {
      expect(Math.abs(box[i]!)).toBe(0.5);
      expect(Math.abs(box[i + 1]!)).toBe(1);
      expect(Math.abs(box[i + 2]!)).toBe(2);
    }
    const ico = icosphereTriangles(0.7, v3(1, 2, 3));
    expect(ico.length).toBe(80 * 9);
    for (let i = 0; i < ico.length; i += 3) expect(dist([ico[i]!, ico[i + 1]!, ico[i + 2]!], [1, 2, 3])).toBeCloseTo(0.7, 5);
  });

  it('rayShape: sphere, capsule, OBB, instanced mesh (scaled + rotated) with normals facing the ray origin', () => {
    const hit = new ShapeHit();
    expect(rayShape(sphereShape(v3(0, 0, -5), 1), v3(0, 0, 0), v3(0, 0, -1), 10, hit)).toBe(true);
    expect(hit.t).toBeCloseTo(4, 12);
    expect(Array.from(hit.normal)).toEqual([0, 0, 1]);
    // from inside: the far wall, normal still facing the origin
    expect(rayShape(sphereShape(v3(0, 0, 0), 1), v3(0, 0, 0), v3(1, 0, 0), 10, hit)).toBe(true);
    expect(hit.t).toBeCloseTo(1, 12);
    expect(hit.normal[0]).toBeCloseTo(-1, 12);
    expect(rayShape(capsuleShape(v3(0, 0, -3), v3(0, 2, -3), 0.5), v3(0, 1, 0), v3(0, 0, -1), 10, hit)).toBe(true);
    expect(hit.t).toBeCloseTo(2.5, 12);
    // OBB rotated 45° about Y: corner first
    const s = Math.SQRT1_2;
    const obb = obbShape(v3(0, 0, -5), v3(1, 1, 1), new Float64Array([s, 0, -s, 0, 1, 0, s, 0, s]));
    expect(rayShape(obb, v3(0, 0, 0), v3(0, 0, -1), 10, hit)).toBe(true);
    expect(hit.t).toBeCloseTo(5 - Math.SQRT2, 9);
    expect(rayShape(obb, v3(0, 0, -5), v3(0, 0, -1), 10, hit)).toBe(true);
    expect(hit.t).toBeCloseTo(Math.SQRT2, 9);

    // instanced mesh: unit box local soup, transform = rotate 90° about Y, scale (2,1,1), translate (0,0,-10)
    const local = StaticBvh.build(boxTriangles(v3(0.5, 0.5, 0.5), null));
    const m = new Float64Array([0, 0, -2, 0, 1, 0, 1, 0, 0, 0, 0, -10]); // columns: X→(0,0,-2), Y→(0,1,0), Z→(1,0,0), t
    const mesh = meshShape(local, m);
    expect(rayShape(mesh, v3(0, 0, 0), v3(0, 0, -1), 20, hit)).toBe(true);
    expect(hit.t).toBeCloseTo(9, 9); // world extent along z is 2 (scaled X axis)
    expect(hit.normal[2]).toBeCloseTo(1, 9);
    expect(rayShape(mesh, v3(3, 0, -10), v3(-1, 0, 0), 20, hit)).toBe(true);
    expect(hit.t).toBeCloseTo(2.5, 9);
    expect(hit.normal[0]).toBeCloseTo(1, 9);
    const mn = v3(), mx = v3();
    shapeAabb(mesh, mn, mx);
    expect(Array.from(mn).map((v) => +v.toFixed(9))).toEqual([-0.5, -0.5, -11]);
    expect(Array.from(mx).map((v) => +v.toFixed(9))).toEqual([0.5, 0.5, -9]);
  });

  it('sweepCapsuleShape against every shape kind matches the triangle reference', () => {
    const hit = new ShapeHit();
    const a = v3(0, 0.35, 5), b = v3(0, 1.55, 5), d = v3(0, 0, -1);
    // sphere at z = 0, r 0.5, centre height 1: capsule r .35 touches at 5 - 0.85
    expect(sweepCapsuleShape(sphereShape(v3(0, 1, 0), 0.5), a, b, 0.35, d, 10, hit)).toBe(true);
    expect(hit.t).toBeCloseTo(5 - 0.85, 9);
    expect(hit.normal[2]).toBeCloseTo(1, 9);
    // capsule–capsule
    expect(sweepCapsuleShape(capsuleShape(v3(0, 0.35, 0), v3(0, 1.55, 0), 0.35), a, b, 0.35, d, 10, hit)).toBe(true);
    expect(hit.t).toBeCloseTo(5 - 0.7, 9);
    // OBB face
    expect(sweepCapsuleShape(obbShape(v3(0, 1, 0), v3(1, 1, 1), null), a, b, 0.35, d, 10, hit)).toBe(true);
    expect(hit.t).toBeCloseTo(5 - 1.35, 9);
    // instanced mesh (translated box)
    const local = StaticBvh.build(boxTriangles(v3(1, 1, 1), null));
    const mesh = meshShape(local, new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 0]));
    expect(sweepCapsuleShape(mesh, a, b, 0.35, d, 10, hit)).toBe(true);
    expect(hit.t).toBeCloseTo(5 - 1.35, 9);
    expect(hit.normal[2]).toBeCloseTo(1, 9);
    expect(dist(hit.point, [0, hit.point[1]!, 1])).toBeLessThan(1e-9);
    // miss
    expect(sweepCapsuleShape(mesh, v3(5, 0.35, 5), v3(5, 1.55, 5), 0.35, d, 10, hit)).toBe(false);
  });

  it('m34Invert inverts an affine 3×4 matrix', () => {
    const m = new Float64Array([0, 0, -2, 0, 1, 0, 1, 0, 0, 0, 0, -10]);
    const inv = new Float64Array(12);
    expect(m34Invert(m, inv)).toBe(true);
    const r = rng(9);
    const w = v3(), back = v3();
    for (let k = 0; k < 50; k++) {
      const p = rnd(r, 10);
      m34Point(m, p, w);
      m34Point(inv, w, back);
      expect(dist(back, p)).toBeLessThan(1e-12);
    }
    m34Point(inv, v3(0, 0, -10), back);
    expect(dist(back, [0, 0, 0])).toBeLessThan(1e-12);
    expect(m34Invert(new Float64Array(12), inv)).toBe(false);
  });
});

describe('overlap and contact routines', () => {
  it('capsule–triangle: depth r − d and normal from the triangle to the capsule; a piercing segment pushes out along the face', () => {
    const floor = new Float64Array([-5, 0, -5, 5, 0, -5, 0, 0, 5]);
    const c: Contact = { depth: 0, normal: v3(), point: v3() };
    expect(overlapCapsuleTriangle(v3(0, 0.3, 0), v3(0, 1.5, 0), 0.35, floor, 0, c)).toBe(true);
    expect(c.depth).toBeCloseTo(0.05, 12);
    expect(Array.from(c.normal)).toEqual([0, 1, 0]);
    expect(overlapCapsuleTriangle(v3(0, 0.4, 0), v3(0, 1.5, 0), 0.35, floor, 0, c)).toBe(false);
    expect(overlapCapsuleTriangle(v3(0, -0.2, 0), v3(0, 1.5, 0), 0.35, floor, 0, c)).toBe(true);
    expect(c.normal[1]).toBeCloseTo(1, 12);
    expect(c.depth).toBeCloseTo(0.55, 12);
  });

  it('capsule–capsule overlap', () => {
    const c: Contact = { depth: 0, normal: v3(), point: v3() };
    expect(overlapCapsuleCapsule(v3(0, 0.35, 0), v3(0, 1.55, 0), 0.35, v3(0.5, 0.35, 0), v3(0.5, 1.55, 0), 0.35, c)).toBe(true);
    expect(c.depth).toBeCloseTo(0.2, 12);
    expect(c.normal[0]).toBeCloseTo(-1, 12); // pushes the first capsule away from the second
    expect(overlapCapsuleCapsule(v3(0, 0.35, 0), v3(0, 1.55, 0), 0.35, v3(0.8, 0.35, 0), v3(0.8, 1.55, 0), 0.35, c)).toBe(false);
  });

  it('sphere–triangle and box–triangle contacts for dynamics', () => {
    const floor = new Float64Array([-5, 0, -5, 5, 0, -5, 0, 0, 5]);
    const c: Contact = { depth: 0, normal: v3(), point: v3() };
    expect(contactSphereTriangle(v3(0, 0.15, 0), 0.2, floor, 0, c)).toBe(true);
    expect(c.depth).toBeCloseTo(0.05, 12);
    expect(c.normal[1]).toBeCloseTo(1, 12);
    expect(Array.from(c.point)).toEqual([0, 0, 0]);
    expect(contactSphereTriangle(v3(0, 0.25, 0), 0.2, floor, 0, c)).toBe(false);

    const list = new ContactList(16);
    // box resting 2 cm into the floor: four bottom corners
    const n = contactsBoxTriangle(obbShape(v3(0, 0.48, 0), v3(0.5, 0.5, 0.5), null), floor, 0, list);
    expect(n).toBe(4);
    for (let i = 0; i < n; i++) {
      expect(list.depth[i]).toBeCloseTo(0.02, 9);
      expect(list.normal[i * 3 + 1]).toBeCloseTo(1, 12);
    }
    list.clear();
    expect(contactsBoxTriangle(obbShape(v3(0, 0.51, 0), v3(0.5, 0.5, 0.5), null), floor, 0, list)).toBe(0);
    // a small triangle poking up into a box from below: its apex vertex inside the box
    list.clear();
    const spike = new Float64Array([-0.1, -1, 0, 0.1, -1, 0, 0, 0.1, 0]);
    const m = contactsBoxTriangle(obbShape(v3(0, 0.5, 0), v3(0.5, 0.5, 0.5), null), spike, 0, list);
    expect(m).toBeGreaterThanOrEqual(1);
    expect(Math.max(...Array.from(list.depth.subarray(0, m)))).toBeCloseTo(0.1, 9);
  });
});
