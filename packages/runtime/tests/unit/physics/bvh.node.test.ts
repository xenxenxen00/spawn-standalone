// bvh.test (motion §5.13): StaticBvh ray / AABB / sweep queries against brute force over the same triangle soup; owner disable;
// serialise round trip. The kernels themselves are checked against independent oracles in shapes.node.test.ts.
import { describe, expect, it } from 'vitest';
import { StaticBvh, RayHit, SweepHit } from '../../../src/compat/physics/bvh.ts';
import { rayTriangle, sweepCapsuleTriangle, v3 } from '../../../src/compat/physics/math.ts';

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

/** n random triangles in a 60 m cube, edge lengths up to ~4 m, plus a few slivers and duplicates. */
function randomSoup(n: number, seed: number): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(n * 9);
  for (let i = 0; i < n; i++) {
    const cx = (r() - 0.5) * 60, cy = (r() - 0.5) * 60, cz = (r() - 0.5) * 60;
    for (let k = 0; k < 3; k++) {
      out[i * 9 + k * 3] = cx + (r() - 0.5) * 4;
      out[i * 9 + k * 3 + 1] = cy + (r() - 0.5) * 4;
      out[i * 9 + k * 3 + 2] = cz + (r() - 0.5) * 4;
    }
  }
  // a few exact duplicates (shared centroid) and a degenerate sliver
  for (let i = 0; i < 9; i++) out[9 + i] = out[i]!;
  out[18 + 3] = out[18]!; out[18 + 4] = out[19]!; out[18 + 5] = out[20]!;
  return out;
}

const N = 5000;
const soup = randomSoup(N, 7);
const owners = new Uint32Array(N);
for (let i = 0; i < N; i++) owners[i] = i % 97;
const bvh = StaticBvh.build(soup, owners);

function randomDir(r: () => number): Float64Array {
  for (;;) {
    const d = v3(r() * 2 - 1, r() * 2 - 1, r() * 2 - 1);
    const l = Math.hypot(d[0]!, d[1]!, d[2]!);
    if (l > 0.1 && l <= 1) return v3(d[0]! / l, d[1]! / l, d[2]! / l);
  }
}

function bruteRay(o: Float64Array, d: Float64Array, tMax: number, skip: (owner: number) => boolean): { t: number; tri: number } {
  let best = Infinity, tri = -1;
  for (let i = 0; i < N; i++) {
    if (skip(owners[i]!)) continue;
    const t = rayTriangle(o, d, soup, i * 9, tMax);
    if (t >= 0 && t < best) { best = t; tri = i; }
  }
  return { t: best, tri };
}

function triBoxOverlap(i: number, mn: Float64Array, mx: Float64Array): boolean {
  for (let a = 0; a < 3; a++) {
    const p = soup[i * 9 + a]!, q = soup[i * 9 + 3 + a]!, s = soup[i * 9 + 6 + a]!;
    if (Math.max(p, q, s) < mn[a]! || Math.min(p, q, s) > mx[a]!) return false;
  }
  return true;
}

describe('StaticBvh build', () => {
  it('keeps every triangle exactly once with its owner, leaves of at most 4 triangles', () => {
    expect(bvh.triCount).toBe(N);
    const seen = new Uint8Array(N);
    for (let i = 0; i < N; i++) {
      const o = bvh.order[i]!;
      seen[o] = seen[o]! + 1;
      expect(bvh.owners[i]).toBe(owners[o]);
      for (let k = 0; k < 9; k++) expect(bvh.tris[i * 9 + k]).toBe(soup[o * 9 + k]);
    }
    expect(seen.every((c) => c === 1)).toBe(true);
    const s = bvh.stats();
    expect(s.maxLeafSize).toBeLessThanOrEqual(4);
    expect(s.maxDepth).toBeLessThan(40);
    expect(bvh.byteLength).toBeGreaterThan(N * 36);
  });

  it('builds empty and single-triangle soups', () => {
    const empty = StaticBvh.build(new Float32Array(0));
    const hit = new RayHit();
    expect(empty.raycast(v3(0, 0, 0), v3(0, 0, -1), 100, null, hit)).toBe(false);
    expect(empty.queryAabb(v3(-1, -1, -1), v3(1, 1, 1), [])).toBe(0);
    const one = StaticBvh.build(new Float32Array([-1, -1, -5, 1, -1, -5, 0, 1, -5]));
    expect(one.raycast(v3(0, 0, 0), v3(0, 0, -1), 100, null, hit)).toBe(true);
    expect(hit.t).toBeCloseTo(5, 6);
  });

  it('splits soups whose triangles share one centroid', () => {
    const same = new Float32Array(40 * 9);
    for (let i = 0; i < 40; i++) same.set([-1, 0, -i * 0.01, 1, 0, -i * 0.01, 0, 1, -i * 0.01].map((v, k) => (k % 3 === 2 ? 0 : v)), i * 9);
    const b = StaticBvh.build(same);
    expect(b.triCount).toBe(40);
    const hit = new RayHit();
    expect(b.raycast(v3(0, 0.2, 1), v3(0, 0, -1), 10, null, hit)).toBe(true);
    expect(hit.t).toBeCloseTo(1, 6);
  });
});

describe('StaticBvh ray queries vs brute force', () => {
  it('nearest hit equals brute force on 3,000 random rays (25 % straight down)', () => {
    const r = rng(11);
    const hit = new RayHit();
    let hits = 0;
    for (let k = 0; k < 3000; k++) {
      const o = v3((r() - 0.5) * 70, (r() - 0.5) * 70, (r() - 0.5) * 70);
      const d = k % 4 === 0 ? v3(0, -1, 0) : randomDir(r);
      const tMax = 5 + r() * 60;
      const want = bruteRay(o, d, tMax, () => false);
      const got = bvh.raycast(o, d, tMax, null, hit);
      expect(got).toBe(want.tri >= 0);
      if (got) {
        hits++;
        expect(hit.t).toBe(want.t);
        expect(rayTriangle(o, d, soup, bvh.order[hit.tri]! * 9, tMax)).toBe(want.t);
        expect(hit.owner).toBe(owners[bvh.order[hit.tri]!]);
        // two-sided: the normal faces the ray origin
        expect(hit.normal[0]! * d[0]! + hit.normal[1]! * d[1]! + hit.normal[2]! * d[2]!).toBeLessThanOrEqual(0);
        expect(Math.hypot(hit.normal[0]!, hit.normal[1]!, hit.normal[2]!)).toBeCloseTo(1, 9);
      }
    }
    expect(hits).toBeGreaterThan(300);
  });

  it('owner filter and owner disable skip triangles inside the traversal (nearest qualifying hit)', () => {
    const r = rng(12);
    const hit = new RayHit();
    const filter = (o: number): boolean => o % 3 !== 0;
    for (let o = 0; o < 97; o += 5) bvh.setOwnerEnabled(o, false);
    expect(bvh.ownerEnabled(5)).toBe(false);
    expect(bvh.ownerEnabled(6)).toBe(true);
    try {
      for (let k = 0; k < 1500; k++) {
        const o = v3((r() - 0.5) * 70, (r() - 0.5) * 70, (r() - 0.5) * 70);
        const d = randomDir(r);
        const want = bruteRay(o, d, 80, (ow) => ow % 5 === 0 || ow % 3 === 0);
        expect(bvh.raycast(o, d, 80, filter, hit)).toBe(want.tri >= 0);
        if (want.tri >= 0) expect(hit.t).toBe(want.t);
      }
    } finally {
      for (let o = 0; o < 97; o += 5) bvh.setOwnerEnabled(o, true);
    }
    expect(bvh.ownerEnabled(5)).toBe(true);
  });

  it('raycastEach visits every hit triangle once', () => {
    const r = rng(13);
    for (let k = 0; k < 300; k++) {
      const o = v3((r() - 0.5) * 70, (r() - 0.5) * 70, (r() - 0.5) * 70);
      const d = randomDir(r);
      const want: number[] = [];
      for (let i = 0; i < N; i++) if (rayTriangle(o, d, soup, i * 9, 90) >= 0) want.push(i);
      const got: number[] = [];
      bvh.raycastEach(o, d, 90, (tri, t) => {
        expect(t).toBe(rayTriangle(o, d, soup, bvh.order[tri]! * 9, 90));
        got.push(bvh.order[tri]!);
      });
      expect(got.sort((a, b) => a - b)).toEqual(want);
    }
  });
});

describe('StaticBvh AABB queries vs brute force', () => {
  it('returns exactly the triangles whose bounds overlap the box', () => {
    const r = rng(21);
    const out: number[] = [];
    for (let k = 0; k < 400; k++) {
      const c = v3((r() - 0.5) * 60, (r() - 0.5) * 60, (r() - 0.5) * 60);
      const h = v3(r() * 6, r() * 6, r() * 6);
      const mn = v3(c[0]! - h[0]!, c[1]! - h[1]!, c[2]! - h[2]!);
      const mx = v3(c[0]! + h[0]!, c[1]! + h[1]!, c[2]! + h[2]!);
      const want: number[] = [];
      for (let i = 0; i < N; i++) if (triBoxOverlap(i, mn, mx)) want.push(i);
      const n = bvh.queryAabb(mn, mx, out);
      expect(n).toBe(out.length);
      expect(out.map((t) => bvh.order[t]!).sort((a, b) => a - b)).toEqual(want);
    }
  });

  it('skips disabled owners', () => {
    const mn = v3(-40, -40, -40), mx = v3(40, 40, 40);
    const out: number[] = [];
    bvh.setOwnerEnabled(3, false);
    try {
      bvh.queryAabb(mn, mx, out);
      expect(out.length).toBe(N - owners.filter((o) => o === 3).length);
      expect(out.some((t) => bvh.owners[t] === 3)).toBe(false);
    } finally {
      bvh.setOwnerEnabled(3, true);
    }
  });
});

describe('StaticBvh sweeps vs brute force', () => {
  function bruteSweep(a: Float64Array, b: Float64Array, rad: number, d: Float64Array, tMax: number): number {
    let best = Infinity;
    for (let i = 0; i < N; i++) {
      const t = sweepCapsuleTriangle(a, b, rad, d, tMax, soup, i * 9, true);
      if (t >= 0 && t < best) best = t;
    }
    return best;
  }

  it('sphere sweeps equal brute force', () => {
    const r = rng(31);
    const hit = new SweepHit();
    for (let k = 0; k < 600; k++) {
      const c = v3((r() - 0.5) * 70, (r() - 0.5) * 70, (r() - 0.5) * 70);
      const d = randomDir(r);
      const rad = 0.05 + r() * 0.6;
      const want = bruteSweep(c, c, rad, d, 30);
      expect(bvh.sweepSphere(c, rad, d, 30, null, hit)).toBe(want < Infinity);
      if (want < Infinity) {
        expect(hit.t).toBe(want);
        // the reported contact lies on the surface at distance ≈ radius from the swept centre
        const cx = c[0]! + d[0]! * hit.t, cy = c[1]! + d[1]! * hit.t, cz = c[2]! + d[2]! * hit.t;
        if (hit.t > 0) expect(Math.hypot(cx - hit.point[0]!, cy - hit.point[1]!, cz - hit.point[2]!)).toBeCloseTo(rad, 4);
      }
    }
  });

  it('capsule sweeps (1.9 × 0.35 character) equal brute force', () => {
    const r = rng(32);
    const hit = new SweepHit();
    for (let k = 0; k < 600; k++) {
      const f = v3((r() - 0.5) * 70, (r() - 0.5) * 70, (r() - 0.5) * 70);
      const a = v3(f[0]!, f[1]! + 0.35, f[2]!);
      const b = v3(f[0]!, f[1]! + 1.55, f[2]!);
      const d = randomDir(r);
      const want = bruteSweep(a, b, 0.35, d, 20);
      expect(bvh.sweepCapsule(a, b, 0.35, d, 20, null, hit)).toBe(want < Infinity);
      if (want < Infinity) expect(hit.t).toBe(want);
    }
  });

  it('short sweeps (one character tick, overlap traversal) equal brute force next to geometry', () => {
    const r = rng(33);
    const hit = new SweepHit();
    let hits = 0, zero = 0;
    for (let k = 0; k < 1500; k++) {
      // start beside a random triangle so that contacts and initial overlaps are common
      const i = Math.floor(r() * N) * 9;
      const f = v3(soup[i]! + (r() - 0.5) * 2, soup[i + 1]! - 1.2 + r() * 1.5, soup[i + 2]! + (r() - 0.5) * 2);
      const a = v3(f[0]!, f[1]! + 0.35, f[2]!);
      const b = k % 4 === 0 ? a : v3(f[0]!, f[1]! + 1.55, f[2]!);
      const d = randomDir(r);
      const tMax = k % 2 === 0 ? 0.22 : 1.5;
      for (const sep of [true, false]) {
        let want = Infinity;
        for (let t = 0; t < N; t++) {
          const x = sweepCapsuleTriangle(a, b, 0.35, d, tMax, soup, t * 9, sep);
          if (x >= 0 && x < want) want = x;
        }
        expect(bvh.sweepCapsule(a, b, 0.35, d, tMax, null, hit, sep)).toBe(want < Infinity);
        if (want < Infinity) {
          expect(hit.t).toBe(want);
          hits++;
          if (want === 0) zero++;
        }
      }
    }
    expect(hits).toBeGreaterThan(300);
    expect(zero).toBeGreaterThan(50);
  });
});

describe('StaticBvh serialisation', () => {
  it('round-trips to identical query results', () => {
    const bytes = bvh.serialize();
    const back = StaticBvh.deserialize(bytes);
    expect(back.triCount).toBe(bvh.triCount);
    expect(back.nodeCount).toBe(bvh.nodeCount);
    expect(Array.from(back.order)).toEqual(Array.from(bvh.order));
    const r = rng(41);
    const h1 = new RayHit(), h2 = new RayHit();
    for (let k = 0; k < 500; k++) {
      const o = v3((r() - 0.5) * 70, (r() - 0.5) * 70, (r() - 0.5) * 70);
      const d = randomDir(r);
      expect(back.raycast(o, d, 90, null, h2)).toBe(bvh.raycast(o, d, 90, null, h1));
      if (h1.tri >= 0) { expect(h2.t).toBe(h1.t); expect(h2.tri).toBe(h1.tri); }
      h1.reset(); h2.reset();
    }
    // the copy owns its buffers
    const copy = new Uint8Array(bytes);
    bytes.fill(0);
    expect(StaticBvh.deserialize(copy).triCount).toBe(N);
  });

  it('rejects a foreign buffer', () => {
    expect(() => StaticBvh.deserialize(new Uint8Array(64))).toThrow(/StaticBvh/);
  });
});
