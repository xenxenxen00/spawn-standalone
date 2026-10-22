// StaticBvh (motion §4.3): a triangle BVH over flat typed arrays, built with binned SAH (≤ 4 triangles per leaf), with
// nearest-hit and all-hit rays, AABB queries, exact sphere and capsule sweeps, a per-triangle owner index (owner → row id
// lives with the caller) and an owner bitset that disables an owner's triangles in O(1). Serialisable to one byte buffer.
//
// Layout: triangles are reordered so every leaf is a contiguous run; `order[i]` is the input index of stored triangle i.
// Node i: bounds at nodeBounds[6i..6i+5] (min xyz, max xyz); nodeData[2i] = first triangle (leaf) or right child (inner; the
// left child is i + 1, depth-first order); nodeData[2i+1] = triangle count | LEAF (leaf) or split axis (inner).
// All triangles are two-sided; ray normals face the ray origin, sweep normals face the moving shape (motion §4.3).
import {
  closestPtSegmentTriangle, rayTri, sweepCapsuleTriangle, triNormalFacing, v3, type Num3, type V3,
} from './math.ts';

const LEAF = 0x80000000;
const COUNT_MASK = 0x7fffffff;
const MAGIC = 0x56425050; // 'SSBV'
const VERSION = 1;
const HEADER_WORDS = 8;
/** ray-slab stand-in for 1/0, keeps the slab test free of NaN (0 · ∞) */
const BIG = 1e30;

/** keep an owner when the filter returns true */
export type OwnerFilter = ((owner: number) => boolean) | null;

export class RayHit {
  t = Infinity;
  /** stored triangle index (bvh.order[tri] is the input index), -1 = none */
  tri = -1;
  owner = -1;
  /** unit, facing the ray origin */
  readonly normal: V3 = v3();
  reset(): void { this.t = Infinity; this.tri = -1; this.owner = -1; }
}

export class SweepHit {
  /** distance travelled by the shape until contact (0 = already touching and moving deeper) */
  t = Infinity;
  tri = -1;
  owner = -1;
  /** unit, from the surface towards the moving shape */
  readonly normal: V3 = v3();
  /** contact point on the surface */
  readonly point: V3 = v3();
  reset(): void { this.t = Infinity; this.tri = -1; this.owner = -1; }
}

export interface BvhBuildOptions { leafSize?: number; bins?: number }
export interface BvhStats { nodeCount: number; leafCount: number; maxLeafSize: number; maxDepth: number }

const S_A = v3(), S_B = v3(), S_SEG = v3(), S_TRI = v3();

export class StaticBvh {
  readonly triCount: number;
  readonly nodeCount: number;
  /** reordered triangles, 9 floats each */
  readonly tris: Float32Array;
  /** owner per stored triangle */
  readonly owners: Uint32Array;
  /** input index per stored triangle */
  readonly order: Uint32Array;
  readonly nodeBounds: Float32Array;
  readonly nodeData: Uint32Array;
  readonly maxDepth: number;
  /** stored triangles the last sweep ran its exact kernel on (bench instrumentation) */
  lastCandidates = 0;
  /** nodes the last sweep visited (bench instrumentation) */
  lastNodes = 0;
  private disabled: Uint32Array = new Uint32Array(0);
  private readonly stack: Int32Array;
  private readonly stackT: Float64Array;

  private constructor(tris: Float32Array, owners: Uint32Array, order: Uint32Array, nodeBounds: Float32Array, nodeData: Uint32Array, maxDepth: number) {
    this.tris = tris;
    this.owners = owners;
    this.order = order;
    this.nodeBounds = nodeBounds;
    this.nodeData = nodeData;
    this.triCount = owners.length;
    this.nodeCount = nodeData.length / 2;
    this.maxDepth = maxDepth;
    this.stack = new Int32Array(maxDepth * 2 + 4);
    this.stackT = new Float64Array(maxDepth * 2 + 4);
  }

  /** build from a world-space soup (9 floats per triangle); owners default to 0 */
  static build(soup: Float32Array, owners?: Uint32Array | null, opts?: BvhBuildOptions): StaticBvh {
    if (soup.length % 9 !== 0) throw new Error(`StaticBvh: soup length ${soup.length} is not a multiple of 9`);
    const n = soup.length / 9;
    if (owners && owners.length !== n) throw new Error(`StaticBvh: ${owners.length} owners for ${n} triangles`);
    const leafSize = Math.max(1, opts?.leafSize ?? 4);
    const bins = Math.max(2, opts?.bins ?? 16);
    return buildBvh(soup, owners ?? new Uint32Array(n), n, leafSize, bins);
  }

  get byteLength(): number {
    return this.tris.byteLength + this.owners.byteLength + this.order.byteLength + this.nodeBounds.byteLength + this.nodeData.byteLength;
  }

  /** world bounds (empty BVH: min > max) */
  bounds(min: V3, max: V3): void {
    if (this.triCount === 0) { min.fill(Infinity); max.fill(-Infinity); return; }
    const b = this.nodeBounds;
    min[0] = b[0]!; min[1] = b[1]!; min[2] = b[2]!; max[0] = b[3]!; max[1] = b[4]!; max[2] = b[5]!;
  }

  stats(): BvhStats {
    let leaves = 0, maxLeaf = 0;
    for (let i = 0; i < this.nodeCount; i++) {
      const c = this.nodeData[i * 2 + 1]!;
      if (c & LEAF) { leaves++; maxLeaf = Math.max(maxLeaf, c & COUNT_MASK); }
    }
    return { nodeCount: this.nodeCount, leafCount: leaves, maxLeafSize: maxLeaf, maxDepth: this.maxDepth };
  }

  setOwnerEnabled(owner: number, enabled: boolean): void {
    const w = owner >>> 5;
    if (w >= this.disabled.length) {
      if (enabled) return;
      const grown = new Uint32Array(Math.max(w + 1, this.disabled.length * 2));
      grown.set(this.disabled);
      this.disabled = grown;
    }
    if (enabled) this.disabled[w]! &= ~(1 << (owner & 31));
    else this.disabled[w]! |= 1 << (owner & 31);
  }

  ownerEnabled(owner: number): boolean {
    const w = owner >>> 5;
    return w >= this.disabled.length || (this.disabled[w]! & (1 << (owner & 31))) === 0;
  }

  /** nearest hit within tMax; d need not be unit (t in units of d) */
  raycast(o: Num3, d: Num3, tMax: number, filter: OwnerFilter, out: RayHit): boolean {
    out.reset();
    if (this.triCount === 0) return false;
    const ox = o[0]!, oy = o[1]!, oz = o[2]!, dx = d[0]!, dy = d[1]!, dz = d[2]!;
    const ix = dx !== 0 ? 1 / dx : BIG, iy = dy !== 0 ? 1 / dy : BIG, iz = dz !== 0 ? 1 / dz : BIG;
    const nb = this.nodeBounds, nd = this.nodeData, tris = this.tris, owners = this.owners;
    const stack = this.stack, stackT = this.stackT;
    const dis = this.disabled, disLen = dis.length;
    let best = tMax, bestTri = -1;
    const t0 = slab(nb, 0, ox, oy, oz, ix, iy, iz, 0, 0, 0, best);
    if (t0 === Infinity) return false;
    let sp = 0;
    stack[sp] = 0; stackT[sp++] = t0;
    while (sp > 0) {
      const node = stack[--sp]!;
      if (stackT[sp]! > best) continue;
      const info = nd[node * 2 + 1]!;
      if (info & LEAF) {
        const start = nd[node * 2]!, end = start + (info & COUNT_MASK);
        for (let i = start; i < end; i++) {
          const ow = owners[i]!;
          if ((ow >>> 5) < disLen && (dis[ow >>> 5]! & (1 << (ow & 31))) !== 0) continue;
          const t = rayTri(ox, oy, oz, dx, dy, dz, tris, i * 9, best);
          if (t >= 0 && (t < best || (bestTri < 0 && t <= best)) && (filter === null || filter(ow))) { best = t; bestTri = i; }
        }
      } else {
        const l = node + 1, r = nd[node * 2]!;
        const tl = slab(nb, l, ox, oy, oz, ix, iy, iz, 0, 0, 0, best);
        const tr = slab(nb, r, ox, oy, oz, ix, iy, iz, 0, 0, 0, best);
        if (tl <= tr) {
          if (tr !== Infinity) { stack[sp] = r; stackT[sp++] = tr; }
          if (tl !== Infinity) { stack[sp] = l; stackT[sp++] = tl; }
        } else {
          if (tl !== Infinity) { stack[sp] = l; stackT[sp++] = tl; }
          stack[sp] = r; stackT[sp++] = tr;
        }
      }
    }
    if (bestTri < 0) return false;
    out.t = best; out.tri = bestTri; out.owner = owners[bestTri]!;
    triNormalFacing(tris, bestTri * 9, dx, dy, dz, out.normal);
    return true;
  }

  /** every hit within tMax (any order); disabled owners skipped */
  raycastEach(o: Num3, d: Num3, tMax: number, visit: (tri: number, t: number, owner: number) => void): void {
    if (this.triCount === 0) return;
    const ox = o[0]!, oy = o[1]!, oz = o[2]!, dx = d[0]!, dy = d[1]!, dz = d[2]!;
    const ix = dx !== 0 ? 1 / dx : BIG, iy = dy !== 0 ? 1 / dy : BIG, iz = dz !== 0 ? 1 / dz : BIG;
    const nb = this.nodeBounds, nd = this.nodeData, tris = this.tris, owners = this.owners, stack = this.stack;
    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const node = stack[--sp]!;
      if (slab(nb, node, ox, oy, oz, ix, iy, iz, 0, 0, 0, tMax) === Infinity) continue;
      const info = nd[node * 2 + 1]!;
      if (info & LEAF) {
        const start = nd[node * 2]!, end = start + (info & COUNT_MASK);
        for (let i = start; i < end; i++) {
          const ow = owners[i]!;
          if (!this.ownerEnabled(ow)) continue;
          const t = rayTri(ox, oy, oz, dx, dy, dz, tris, i * 9, tMax);
          if (t >= 0) visit(i, t, ow);
        }
      } else {
        stack[sp++] = nd[node * 2]!;
        stack[sp++] = node + 1;
      }
    }
  }

  /** stored triangles whose bounds overlap [min, max] (inclusive) → out (cleared first); returns the count */
  queryAabb(min: Num3, max: Num3, out: number[]): number {
    out.length = 0;
    if (this.triCount === 0) return 0;
    const x0 = min[0]!, y0 = min[1]!, z0 = min[2]!, x1 = max[0]!, y1 = max[1]!, z1 = max[2]!;
    const nb = this.nodeBounds, nd = this.nodeData, tris = this.tris, owners = this.owners, stack = this.stack;
    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const node = stack[--sp]!;
      const b = node * 6;
      if (nb[b]! > x1 || nb[b + 1]! > y1 || nb[b + 2]! > z1 || nb[b + 3]! < x0 || nb[b + 4]! < y0 || nb[b + 5]! < z0) continue;
      const info = nd[node * 2 + 1]!;
      if (info & LEAF) {
        const start = nd[node * 2]!, end = start + (info & COUNT_MASK);
        for (let i = start; i < end; i++) {
          if (!this.ownerEnabled(owners[i]!)) continue;
          const o = i * 9;
          const ax = tris[o]!, ay = tris[o + 1]!, az = tris[o + 2]!, bx = tris[o + 3]!, by = tris[o + 4]!, bz = tris[o + 5]!;
          const cx = tris[o + 6]!, cy = tris[o + 7]!, cz = tris[o + 8]!;
          if (Math.min(ax, bx, cx) > x1 || Math.max(ax, bx, cx) < x0) continue;
          if (Math.min(ay, by, cy) > y1 || Math.max(ay, by, cy) < y0) continue;
          if (Math.min(az, bz, cz) > z1 || Math.max(az, bz, cz) < z0) continue;
          out.push(i);
        }
      } else {
        stack[sp++] = nd[node * 2]!;
        stack[sp++] = node + 1;
      }
    }
    return out.length;
  }

  /** sphere of radius r at c swept along unit d up to tMax: first contact */
  sweepSphere(c: Num3, r: number, d: Num3, tMax: number, filter: OwnerFilter, out: SweepHit, ignoreSeparating = true): boolean {
    return this.sweepCapsule(c, c, r, d, tMax, filter, out, ignoreSeparating);
  }

  /**
   * capsule [a,b] ⊕ r swept along unit d up to tMax: first contact (exact TOI). Already overlapping and moving deeper: t = 0;
   * overlapping and separating: ignored when `ignoreSeparating` (default; Rapier's stop_at_penetration: false).
   */
  sweepCapsule(a: Num3, b: Num3, r: number, d: Num3, tMax: number, filter: OwnerFilter, out: SweepHit, ignoreSeparating = true): boolean {
    out.reset();
    this.lastCandidates = 0;
    if (this.triCount === 0) return false;
    const ax = a[0]!, ay = a[1]!, az = a[2]!, bx = b[0]!, by = b[1]!, bz = b[2]!;
    const dx = d[0]!, dy = d[1]!, dz = d[2]!;
    const cx = (ax + bx) / 2, cy = (ay + by) / 2, cz = (az + bz) / 2;
    const hx = Math.abs(bx - ax) / 2 + r, hy = Math.abs(by - ay) / 2 + r, hz = Math.abs(bz - az) / 2 + r;
    const ix = dx !== 0 ? 1 / dx : BIG, iy = dy !== 0 ? 1 / dy : BIG, iz = dz !== 0 ? 1 / dz : BIG;
    const nb = this.nodeBounds, nd = this.nodeData, tris = this.tris, owners = this.owners;
    const stack = this.stack, stackT = this.stackT;
    const dis = this.disabled, disLen = dis.length;
    if (tMax <= 2 * Math.max(hx, hy, hz)) return this.sweepShort(a, b, r, d, tMax, filter, out, ignoreSeparating, cx, cy, cz, hx, hy, hz);
    let best = tMax, bestTri = -1, candidates = 0, nodes = 0;
    const t0 = slab(nb, 0, cx, cy, cz, ix, iy, iz, hx, hy, hz, best);
    if (t0 === Infinity) return false;
    let sp = 0;
    stack[sp] = 0; stackT[sp++] = t0;
    while (sp > 0) {
      const node = stack[--sp]!;
      if (stackT[sp]! > best) continue;
      nodes++;
      const info = nd[node * 2 + 1]!;
      if (info & LEAF) {
        const start = nd[node * 2]!, end = start + (info & COUNT_MASK);
        for (let i = start; i < end; i++) {
          const ow = owners[i]!;
          if ((ow >>> 5) < disLen && (dis[ow >>> 5]! & (1 << (ow & 31))) !== 0) continue;
          if (triSlab(tris, i * 9, cx, cy, cz, ix, iy, iz, hx, hy, hz, best) === Infinity) continue;
          candidates++;
          const t = sweepCapsuleTriangle(a, b, r, d, best, tris, i * 9, ignoreSeparating);
          if (t >= 0 && (t < best || (bestTri < 0 && t <= best)) && (filter === null || filter(ow))) { best = t; bestTri = i; }
        }
        if (bestTri >= 0 && best === 0) break;
      } else {
        const l = node + 1, rr = nd[node * 2]!;
        const tl = slab(nb, l, cx, cy, cz, ix, iy, iz, hx, hy, hz, best);
        const tr = slab(nb, rr, cx, cy, cz, ix, iy, iz, hx, hy, hz, best);
        if (tl <= tr) {
          if (tr !== Infinity) { stack[sp] = rr; stackT[sp++] = tr; }
          if (tl !== Infinity) { stack[sp] = l; stackT[sp++] = tl; }
        } else {
          if (tl !== Infinity) { stack[sp] = l; stackT[sp++] = tl; }
          stack[sp] = rr; stackT[sp++] = tr;
        }
      }
    }
    this.lastCandidates = candidates;
    this.lastNodes = nodes;
    if (bestTri < 0) return false;
    out.t = best; out.tri = bestTri; out.owner = owners[bestTri]!;
    sweepContact(a, b, d, best, tris, bestTri * 9, out.normal, out.point);
    return true;
  }

  /**
   * Short sweeps (motion no longer than the shape, e.g. a character's per-tick move): plain overlap traversal against the
   * swept bounds; cheaper than ordered ray-slab traversal when the motion barely leaves the start box.
   */
  private sweepShort(
    a: Num3, b: Num3, r: number, d: Num3, tMax: number, filter: OwnerFilter, out: SweepHit, ignoreSeparating: boolean,
    cx: number, cy: number, cz: number, hx: number, hy: number, hz: number,
  ): boolean {
    const mx = d[0]! * tMax, my = d[1]! * tMax, mz = d[2]! * tMax;
    const x0 = cx - hx + (mx < 0 ? mx : 0), x1 = cx + hx + (mx > 0 ? mx : 0);
    const y0 = cy - hy + (my < 0 ? my : 0), y1 = cy + hy + (my > 0 ? my : 0);
    const z0 = cz - hz + (mz < 0 ? mz : 0), z1 = cz + hz + (mz > 0 ? mz : 0);
    const nb = this.nodeBounds, nd = this.nodeData, tris = this.tris, owners = this.owners, stack = this.stack;
    const dis = this.disabled, disLen = dis.length;
    let best = tMax, bestTri = -1, candidates = 0, nodes = 0;
    let sp = 0;
    stack[sp++] = 0;
    while (sp > 0) {
      const node = stack[--sp]!;
      const o = node * 6;
      if (nb[o]! > x1 || nb[o + 1]! > y1 || nb[o + 2]! > z1 || nb[o + 3]! < x0 || nb[o + 4]! < y0 || nb[o + 5]! < z0) continue;
      nodes++;
      const info = nd[node * 2 + 1]!;
      if (info & LEAF) {
        const start = nd[node * 2]!, end = start + (info & COUNT_MASK);
        for (let i = start; i < end; i++) {
          const ow = owners[i]!;
          if ((ow >>> 5) < disLen && (dis[ow >>> 5]! & (1 << (ow & 31))) !== 0) continue;
          const k = i * 9;
          const t0 = tris[k]!, t3 = tris[k + 3]!, t6 = tris[k + 6]!;
          if ((t0 > x1 && t3 > x1 && t6 > x1) || (t0 < x0 && t3 < x0 && t6 < x0)) continue;
          const t1 = tris[k + 1]!, t4 = tris[k + 4]!, t7 = tris[k + 7]!;
          if ((t1 > y1 && t4 > y1 && t7 > y1) || (t1 < y0 && t4 < y0 && t7 < y0)) continue;
          const t2 = tris[k + 2]!, t5 = tris[k + 5]!, t8 = tris[k + 8]!;
          if ((t2 > z1 && t5 > z1 && t8 > z1) || (t2 < z0 && t5 < z0 && t8 < z0)) continue;
          candidates++;
          const t = sweepCapsuleTriangle(a, b, r, d, best, tris, k, ignoreSeparating);
          if (t >= 0 && (t < best || (bestTri < 0 && t <= best)) && (filter === null || filter(ow))) { best = t; bestTri = i; }
        }
        if (bestTri >= 0 && best === 0) break;
      } else {
        stack[sp++] = nd[node * 2]!;
        stack[sp++] = node + 1;
      }
    }
    this.lastCandidates = candidates;
    this.lastNodes = nodes;
    if (bestTri < 0) return false;
    out.t = best; out.tri = bestTri; out.owner = owners[bestTri]!;
    sweepContact(a, b, d, best, tris, bestTri * 9, out.normal, out.point);
    return true;
  }

  serialize(): Uint8Array {
    const n = this.triCount, m = this.nodeCount;
    const words = HEADER_WORDS + 9 * n + n + n + 6 * m + 2 * m;
    const buf = new ArrayBuffer(words * 4);
    const u = new Uint32Array(buf);
    u[0] = MAGIC; u[1] = VERSION; u[2] = n; u[3] = m; u[4] = this.maxDepth;
    let w = HEADER_WORDS;
    new Float32Array(buf, w * 4, 9 * n).set(this.tris); w += 9 * n;
    u.set(this.owners, w); w += n;
    u.set(this.order, w); w += n;
    new Float32Array(buf, w * 4, 6 * m).set(this.nodeBounds); w += 6 * m;
    u.set(this.nodeData, w);
    return new Uint8Array(buf);
  }

  static deserialize(bytes: Uint8Array): StaticBvh {
    const own = bytes.slice();
    if (own.byteLength < HEADER_WORDS * 4 || own.byteLength % 4 !== 0) throw new Error('StaticBvh: buffer too short');
    const buf = own.buffer;
    const u = new Uint32Array(buf);
    if (u[0] !== MAGIC) throw new Error('StaticBvh: not a StaticBvh buffer');
    if (u[1] !== VERSION) throw new Error(`StaticBvh: version ${u[1]} (expected ${VERSION})`);
    const n = u[2]!, m = u[3]!, depth = u[4]!;
    const words = HEADER_WORDS + 11 * n + 8 * m;
    if (u.length !== words) throw new Error(`StaticBvh: ${u.length} words, expected ${words}`);
    let w = HEADER_WORDS;
    const tris = new Float32Array(buf, w * 4, 9 * n); w += 9 * n;
    const owners = u.subarray(w, w + n); w += n;
    const order = u.subarray(w, w + n); w += n;
    const nodeBounds = new Float32Array(buf, w * 4, 6 * m); w += 6 * m;
    const nodeData = u.subarray(w, w + 2 * m);
    return new StaticBvh(tris, owners, order, nodeBounds, nodeData, depth);
  }

  /** internal: used by buildBvh */
  static fromParts(tris: Float32Array, owners: Uint32Array, order: Uint32Array, nodeBounds: Float32Array, nodeData: Uint32Array, maxDepth: number): StaticBvh {
    return new StaticBvh(tris, owners, order, nodeBounds, nodeData, maxDepth);
  }
}

/** contact normal (surface → shape) and point of a capsule sweep that stopped at t against triangle tris@off */
export function sweepContact(a: Num3, b: Num3, d: Num3, t: number, tris: Num3, off: number, normal: V3, point: V3): void {
  const dx = d[0]!, dy = d[1]!, dz = d[2]!;
  S_A[0] = a[0]! + dx * t; S_A[1] = a[1]! + dy * t; S_A[2] = a[2]! + dz * t;
  S_B[0] = b[0]! + dx * t; S_B[1] = b[1]! + dy * t; S_B[2] = b[2]! + dz * t;
  const d2 = closestPtSegmentTriangle(S_A, S_B, tris, off, S_SEG, S_TRI);
  point.set(S_TRI);
  if (d2 > 1e-18) {
    const l = Math.sqrt(d2);
    normal[0] = (S_SEG[0]! - S_TRI[0]!) / l; normal[1] = (S_SEG[1]! - S_TRI[1]!) / l; normal[2] = (S_SEG[2]! - S_TRI[2]!) / l;
  } else {
    triNormalFacing(tris, off, dx, dy, dz, normal);
  }
}

/**
 * entry distance of the ray (o, 1/d) into node `node`'s box inflated by (hx, hy, hz), or Infinity when it misses or enters
 * beyond tMax. A ray starting inside answers 0.
 */
function slab(nb: Float32Array, node: number, ox: number, oy: number, oz: number, ix: number, iy: number, iz: number, hx: number, hy: number, hz: number, tMax: number): number {
  const b = node * 6;
  let t0 = (nb[b]! - hx - ox) * ix, t1 = (nb[b + 3]! + hx - ox) * ix;
  let tn = t0 < t1 ? t0 : t1, tf = t0 < t1 ? t1 : t0;
  t0 = (nb[b + 1]! - hy - oy) * iy; t1 = (nb[b + 4]! + hy - oy) * iy;
  let a = t0 < t1 ? t0 : t1, c = t0 < t1 ? t1 : t0;
  if (a > tn) tn = a;
  if (c < tf) tf = c;
  t0 = (nb[b + 2]! - hz - oz) * iz; t1 = (nb[b + 5]! + hz - oz) * iz;
  a = t0 < t1 ? t0 : t1; c = t0 < t1 ? t1 : t0;
  if (a > tn) tn = a;
  if (c < tf) tf = c;
  if (tn > tf || tf < 0 || tn > tMax) return Infinity;
  return tn > 0 ? tn : 0;
}

/** the same test against one triangle's bounds (computed on the fly) */
function triSlab(t: Float32Array, o: number, ox: number, oy: number, oz: number, ix: number, iy: number, iz: number, hx: number, hy: number, hz: number, tMax: number): number {
  const ax = t[o]!, bx = t[o + 3]!, cx = t[o + 6]!;
  let t0 = ((ax < bx ? (ax < cx ? ax : cx) : bx < cx ? bx : cx) - hx - ox) * ix;
  let t1 = ((ax > bx ? (ax > cx ? ax : cx) : bx > cx ? bx : cx) + hx - ox) * ix;
  let tn = t0 < t1 ? t0 : t1, tf = t0 < t1 ? t1 : t0;
  const ay = t[o + 1]!, by = t[o + 4]!, cy = t[o + 7]!;
  t0 = ((ay < by ? (ay < cy ? ay : cy) : by < cy ? by : cy) - hy - oy) * iy;
  t1 = ((ay > by ? (ay > cy ? ay : cy) : by > cy ? by : cy) + hy - oy) * iy;
  let a = t0 < t1 ? t0 : t1, c = t0 < t1 ? t1 : t0;
  if (a > tn) tn = a;
  if (c < tf) tf = c;
  const az = t[o + 2]!, bz = t[o + 5]!, cz = t[o + 8]!;
  t0 = ((az < bz ? (az < cz ? az : cz) : bz < cz ? bz : cz) - hz - oz) * iz;
  t1 = ((az > bz ? (az > cz ? az : cz) : bz > cz ? bz : cz) + hz - oz) * iz;
  a = t0 < t1 ? t0 : t1; c = t0 < t1 ? t1 : t0;
  if (a > tn) tn = a;
  if (c < tf) tf = c;
  if (tn > tf || tf < 0 || tn > tMax) return Infinity;
  return tn > 0 ? tn : 0;
}

// ── build: binned SAH ─────────────────────────────────────────────────────────────────────────────────────────────────────

function buildBvh(soup: Float32Array, ownersIn: Uint32Array, n: number, leafSize: number, bins: number): StaticBvh {
  const maxNodes = Math.max(1, 2 * n);
  const nodeBounds = new Float32Array(maxNodes * 6);
  const nodeData = new Uint32Array(maxNodes * 2);
  const idx = new Uint32Array(n);
  const tb = new Float32Array(n * 6); // per-triangle bounds
  const cen = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    idx[i] = i;
    const o = i * 9;
    for (let a = 0; a < 3; a++) {
      const p = soup[o + a]!, q = soup[o + 3 + a]!, s = soup[o + 6 + a]!;
      const lo = p < q ? (p < s ? p : s) : q < s ? q : s, hi = p > q ? (p > s ? p : s) : q > s ? q : s;
      tb[i * 6 + a] = lo; tb[i * 6 + 3 + a] = hi;
      cen[i * 3 + a] = (lo + hi) * 0.5;
    }
  }
  let nodeCount = 0;
  let maxDepth = 1;
  if (n === 0) {
    nodeBounds.fill(0, 0, 6);
    nodeData[0] = 0; nodeData[1] = LEAF;
    nodeCount = 1;
  } else {
    // task stack: start, end, parent-to-patch (−1 = none), depth
    const tStart: number[] = [0], tEnd: number[] = [n], tParent: number[] = [-1], tDepth: number[] = [1];
    const binCount = new Uint32Array(bins);
    const binB = new Float64Array(bins * 6);
    const rightArea = new Float64Array(bins);
    const rightCount = new Uint32Array(bins);
    while (tStart.length > 0) {
      const start = tStart.pop()!, end = tEnd.pop()!, parent = tParent.pop()!, depth = tDepth.pop()!;
      const node = nodeCount++;
      if (parent >= 0) nodeData[parent * 2] = node;
      if (depth > maxDepth) maxDepth = depth;
      // node bounds and centroid bounds
      let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
      let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity;
      for (let k = start; k < end; k++) {
        const i = idx[k]!, b = i * 6, c = i * 3;
        if (tb[b]! < x0) x0 = tb[b]!;
        if (tb[b + 1]! < y0) y0 = tb[b + 1]!;
        if (tb[b + 2]! < z0) z0 = tb[b + 2]!;
        if (tb[b + 3]! > x1) x1 = tb[b + 3]!;
        if (tb[b + 4]! > y1) y1 = tb[b + 4]!;
        if (tb[b + 5]! > z1) z1 = tb[b + 5]!;
        const px = cen[c]!, py = cen[c + 1]!, pz = cen[c + 2]!;
        if (px < cx0) cx0 = px;
        if (py < cy0) cy0 = py;
        if (pz < cz0) cz0 = pz;
        if (px > cx1) cx1 = px;
        if (py > cy1) cy1 = py;
        if (pz > cz1) cz1 = pz;
      }
      const nbo = node * 6;
      nodeBounds[nbo] = x0; nodeBounds[nbo + 1] = y0; nodeBounds[nbo + 2] = z0;
      nodeBounds[nbo + 3] = x1; nodeBounds[nbo + 4] = y1; nodeBounds[nbo + 5] = z1;
      const count = end - start;
      if (count <= leafSize) {
        nodeData[node * 2] = start; nodeData[node * 2 + 1] = count | LEAF;
        continue;
      }
      // binned SAH over the three axes
      const cmin = [cx0, cy0, cz0], cext = [cx1 - cx0, cy1 - cy0, cz1 - cz0];
      let bestCost = Infinity, bestAxis = -1, bestSplit = -1;
      for (let axis = 0; axis < 3; axis++) {
        const ext = cext[axis]!;
        if (!(ext > 0)) continue;
        const scale = (bins / ext) * (1 - 1e-6), lo = cmin[axis]!;
        binCount.fill(0);
        for (let k = 0; k < bins; k++) { binB.fill(Infinity, k * 6, k * 6 + 3); binB.fill(-Infinity, k * 6 + 3, k * 6 + 6); }
        for (let k = start; k < end; k++) {
          const i = idx[k]!;
          let bi = Math.floor((cen[i * 3 + axis]! - lo) * scale);
          if (bi >= bins) bi = bins - 1;
          binCount[bi]!++;
          const bb = bi * 6, b = i * 6;
          for (let a = 0; a < 3; a++) {
            if (tb[b + a]! < binB[bb + a]!) binB[bb + a] = tb[b + a]!;
            if (tb[b + 3 + a]! > binB[bb + 3 + a]!) binB[bb + 3 + a] = tb[b + 3 + a]!;
          }
        }
        // suffix sweep: right side of split s = bins s+1 .. bins-1
        let rx0 = Infinity, ry0 = Infinity, rz0 = Infinity, rx1 = -Infinity, ry1 = -Infinity, rz1 = -Infinity, rc = 0;
        for (let s = bins - 1; s > 0; s--) {
          const bb = s * 6;
          rc += binCount[s]!;
          if (binB[bb]! < rx0) rx0 = binB[bb]!;
          if (binB[bb + 1]! < ry0) ry0 = binB[bb + 1]!;
          if (binB[bb + 2]! < rz0) rz0 = binB[bb + 2]!;
          if (binB[bb + 3]! > rx1) rx1 = binB[bb + 3]!;
          if (binB[bb + 4]! > ry1) ry1 = binB[bb + 4]!;
          if (binB[bb + 5]! > rz1) rz1 = binB[bb + 5]!;
          rightCount[s - 1] = rc;
          rightArea[s - 1] = rc > 0 ? area(rx0, ry0, rz0, rx1, ry1, rz1) : 0;
        }
        let lx0 = Infinity, ly0 = Infinity, lz0 = Infinity, lx1 = -Infinity, ly1 = -Infinity, lz1 = -Infinity, lc = 0;
        for (let s = 0; s < bins - 1; s++) {
          const bb = s * 6;
          lc += binCount[s]!;
          if (binB[bb]! < lx0) lx0 = binB[bb]!;
          if (binB[bb + 1]! < ly0) ly0 = binB[bb + 1]!;
          if (binB[bb + 2]! < lz0) lz0 = binB[bb + 2]!;
          if (binB[bb + 3]! > lx1) lx1 = binB[bb + 3]!;
          if (binB[bb + 4]! > ly1) ly1 = binB[bb + 4]!;
          if (binB[bb + 5]! > lz1) lz1 = binB[bb + 5]!;
          const rcs = rightCount[s]!;
          if (lc === 0 || rcs === 0) continue;
          const cost = area(lx0, ly0, lz0, lx1, ly1, lz1) * lc + rightArea[s]! * rcs;
          if (cost < bestCost) { bestCost = cost; bestAxis = axis; bestSplit = s; }
        }
      }
      let mid: number;
      if (bestAxis < 0) {
        // every centroid identical: split the run in half to keep leaves small
        mid = start + (count >> 1);
      } else {
        const ext = cext[bestAxis]!, scale = (bins / ext) * (1 - 1e-6), lo = cmin[bestAxis]!;
        let i = start, j = end - 1;
        while (i <= j) {
          let bi = Math.floor((cen[idx[i]! * 3 + bestAxis]! - lo) * scale);
          if (bi >= bins) bi = bins - 1;
          if (bi <= bestSplit) i++;
          else { const tmp = idx[i]!; idx[i] = idx[j]!; idx[j] = tmp; j--; }
        }
        mid = i;
        if (mid === start || mid === end) mid = start + (count >> 1);
      }
      nodeData[node * 2 + 1] = bestAxis < 0 ? 0 : bestAxis;
      // right first on the stack so the left child is built next and lands at node + 1
      tStart.push(mid); tEnd.push(end); tParent.push(node); tDepth.push(depth + 1);
      tStart.push(start); tEnd.push(mid); tParent.push(-1); tDepth.push(depth + 1);
    }
  }
  const tris = new Float32Array(n * 9);
  const owners = new Uint32Array(n);
  for (let k = 0; k < n; k++) {
    const i = idx[k]!;
    tris.set(soup.subarray(i * 9, i * 9 + 9), k * 9);
    owners[k] = ownersIn[i]!;
  }
  return StaticBvh.fromParts(tris, owners, idx, nodeBounds.slice(0, nodeCount * 6), nodeData.slice(0, nodeCount * 2), maxDepth);
}

function area(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  return dx * dy + dy * dz + dz * dx;
}
