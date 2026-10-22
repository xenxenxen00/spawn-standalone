// NavGrid baker (motion §7.3, X-06, X-31; WP NV1). Isomorphic: `tools/maps/bake-place.ts` runs it at build time (through
// `tools/nav/bake-navgrid.ts`) and a place in `nav.bakeAtLoad` runs it in a Worker at load; no Node or DOM API.
//
// Input: the place's ColliderPack, immutable instances only (doors, teacups, terminals and every other mutable or kinematic
// row are handled at query time by the overlay, motion §7.4 item 9) plus the terrain soup. Steps:
//  1. Rasterise every triangle into the 0.25 m columns it covers (Recast-style polygon clipping, closed cells): a triangle
//     with a horizontal extent counts where its clipped area is positive; a vertical face counts where its clipped segment
//     has length, and a face lying exactly on a column boundary goes to the column on its solid side (its normal points out
//     of that column: generator faces are CCW from outside, recorder.ts). Vertices within 0.1 mm of a lattice line snap to it.
//  2. Each clipped piece adds its y-interval to the column; intervals closer than MERGE_GAP (0.25 m: no agent fits) merge.
//     A closed collider (every directed edge matched by its reverse: boxes, spheres, watertight generator soups) is solid:
//     its pieces in a column become solid intervals by winding number (SolidCollector), so a crate on the floor or a ramp
//     wedge leaves no hollow "floor" inside it. Open soups and the terrain are surfaces only. Floors = interval tops; `clear` = distance to the next interval above; `slope` = the steepest triangle whose top
//     reaches the floor (within 1 cm), vertical faces (≥ 85°) only when nothing flatter does (so the side faces of a slab
//     do not make its edge cells steep).
//  3. Edges (bakeStep 0.45) per span and 8 neighbours: solid in (y + 0.45, y + 1.0) of the neighbour column, or a missing
//     column, or no floor below at all = wall; a neighbour span with |Δy| ≤ 0.45 = connected; a lower floor = drop.
//  4. `wall` = multi-source Dijkstra (chamfer 0.25 / 0.354 m) over connected edges from the spans with a wall edge
//     (source distance 0.125 m, half a cell); floored to 2 cm units.
//  5. `comp` = union-find over PERMISSIVE-passable spans (navgrid.ts header) + directed drop links between components.
//  6. Header with an input hash (`bakeHash`: FNV-1a over the soup and the bake constants) and a bake report.
import type { ColliderPack, NavGridHeader } from '../core/ports.ts';
import type { Vec3 } from '../core/types.ts';
import { boxTriangles, icosphereTriangles } from '../physics/shapes.ts';
import {
  BAKE_STEP,
  CLEAR_UNIT,
  COMP_NONE,
  COMP_OVERFLOW,
  NAV_CELL,
  NAV_DX,
  NAV_DZ,
  NavGridData,
  PERMISSIVE,
  UNIT_MAX,
  WALL_UNIT,
  Y_UNIT,
  agentUnits,
} from './navgrid.ts';

/** intervals closer than this merge (no agent fits a gap this low) */
export const MERGE_GAP = 0.25;
/** a vertex this close to a lattice line snaps onto it (Float32 transforms land 1e-7 off the line) */
const SNAP = 1e-4;
/** clipped pieces of non-vertical triangles with less area are boundary slivers */
const AREA_EPS = 1e-9;
/** a winding sum (in shares of a column) below this is zero: the slivers AREA_EPS drops are 1.6e-8 of a cell each */
const WIND_EPS = 1e-6;
/** clipped pieces of vertical faces shorter than this (in xz) are points */
const LEN_EPS = 1e-6;
/** |n.y| / |n| at or below this = a vertical face */
const VERTICAL_REL = 1e-6;
/** tops within this of each other define the floor together (m) */
const TOP_EPS = 0.01;
/** slopes at or above this only define a floor when nothing flatter reaches it */
const STEEP = 85;
/** cm thresholds of the edge classification (motion §7.3 item 3) */
const STEP_CM = Math.round(BAKE_STEP / Y_UNIT);
const KNEE_CM = 100;
/** grids above this many columns are refused (≈ 1 km × 1 km) */
const MAX_COLUMNS = 16_000_000;
const DIAG = NAV_CELL * Math.SQRT2;

export interface NavBakeProbe { id: string; p: Vec3 }
export interface NavBakeOptions {
  /** spawn entries and other points the report checks (located with up 0.6 m / down 2 m, motion §7.4 item 2) */
  probes?: readonly NavBakeProbe[];
}
export interface NavBakeReport {
  place: string;
  /** input triangles (immutable instances + terrain) */
  triangles: number;
  /** non-finite or degenerate triangles skipped */
  skipped: number;
  columns: number;
  spans: number;
  components: number;
  /** directed drop links between components */
  links: number;
  maxSpansPerColumn: number;
  bakeMs: number;
  probes: Array<{ id: string; span: number; comp: number }>;
  /** probes on no span or on a span outside every permissive component */
  unreachable: string[];
}

// ── input ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

function pointM34(m: ArrayLike<number>, x: number, y: number, z: number, out: Float32Array, o: number): void {
  out[o] = m[0]! * x + m[3]! * y + m[6]! * z + m[9]!;
  out[o + 1] = m[1]! * x + m[4]! * y + m[7]! * z + m[10]!;
  out[o + 2] = m[2]! * x + m[5]! * y + m[8]! * z + m[11]!;
}

function transformInto(local: ArrayLike<number>, m: ArrayLike<number>, out: Float32Array, at: number): number {
  for (let i = 0; i + 2 < local.length; i += 3) pointM34(m, local[i]!, local[i + 1]!, local[i + 2]!, out, at + i);
  return at + local.length - (local.length % 9);
}

/** one instance's (or the terrain's) run of triangles in the soup */
export interface SoupPart { first: number; count: number; closed: boolean }

/**
 * A soup is closed when every directed edge has a matching reverse edge (watertight and consistently oriented; vertices
 * compared exactly, as generators and boxTriangles emit shared corners with identical numbers).
 */
export function isClosedSoup(tris: ArrayLike<number>): boolean {
  const n = Math.floor(tris.length / 9);
  if (n === 0) return false;
  const open = new Map<string, number>();
  const vk = (t: number, v: number): string => `${tris[t * 9 + v * 3]},${tris[t * 9 + v * 3 + 1]},${tris[t * 9 + v * 3 + 2]}`;
  for (let t = 0; t < n; t++) {
    const a = vk(t, 0), b = vk(t, 1), c = vk(t, 2);
    for (const [p, q] of [[a, b], [b, c], [c, a]] as const) {
      const rev = `${q}|${p}`, r = open.get(rev);
      if (r !== undefined) { if (r === 1) open.delete(rev); else open.set(rev, r - 1); }
      else { const fwd = `${p}|${q}`; open.set(fwd, (open.get(fwd) ?? 0) + 1); }
    }
  }
  return open.size === 0;
}

/**
 * World-space triangle soup of a pack's immutable colliders (instances neither mutable nor kinematic) followed by the terrain,
 * with one part per instance telling whether its collider is a closed solid. Key conventions (render pack.ts
 * `PackedCollider`): `tris` local triangles; `box` = full size [w, h, d] standing on the origin; `sphere` = radius, centred at
 * (0, r, 0) (80-triangle icosphere); instance `m` = 3×4 column-major.
 */
export function soupParts(pack: ColliderPack): { soup: Float32Array; parts: SoupPart[] } {
  const live = pack.instances.filter((i) => !i.mutable && !i.kinematic);
  const local = new Map<number, { tris: ArrayLike<number>; closed: boolean }>();
  const localOf = (k: number): { tris: ArrayLike<number>; closed: boolean } => {
    let l = local.get(k);
    if (l) return l;
    const key = pack.keys[k]!;
    let tris: ArrayLike<number> = new Float32Array(0);
    if (key.tris) tris = key.tris.subarray(0, Math.floor(key.tris.length / 9) * 9);
    else if (key.box) {
      const [bw, bh, bd] = key.box;
      tris = boxTriangles(new Float64Array([bw / 2, bh / 2, bd / 2]), new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, bh / 2, 0]));
    } else if (key.sphere !== undefined) tris = icosphereTriangles(key.sphere, new Float64Array([0, key.sphere, 0]));
    l = { tris, closed: isClosedSoup(tris) };
    local.set(k, l);
    return l;
  };
  let n = 0;
  for (const inst of live) {
    if (!pack.keys[inst.key]) throw new Error(`nav bake ${pack.place}: instance ${inst.rowId} names missing key ${inst.key}`);
    if (inst.m.length !== 12) throw new Error(`nav bake ${pack.place}: instance ${inst.rowId} transform has ${inst.m.length} numbers, expected 12`);
    n += localOf(inst.key).tris.length;
  }
  const terrainLen = pack.terrain ? Math.floor(pack.terrain.tris.length / 9) * 9 : 0;
  const soup = new Float32Array(n + terrainLen);
  const parts: SoupPart[] = [];
  let w = 0;
  for (const inst of live) {
    const l = localOf(inst.key);
    if (l.tris.length === 0) continue;
    parts.push({ first: w / 9, count: l.tris.length / 9, closed: l.closed });
    w = transformInto(l.tris, inst.m, soup, w);
  }
  if (pack.terrain && terrainLen > 0) {
    soup.set(pack.terrain.tris.subarray(0, terrainLen), w);
    parts.push({ first: w / 9, count: terrainLen / 9, closed: false });
  }
  return { soup, parts };
}

/** the world-space soup of `soupParts` */
export function immutableSoup(pack: ColliderPack): Float32Array {
  return soupParts(pack).soup;
}

// ── hashing (isomorphic, deterministic) ─────────────────────────────────────────────────────────────────────────────────

function fnv1a(bytes: Uint8Array, seed: number): number {
  let h = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) { h ^= bytes[i]!; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}

/** 64-bit (two FNV-1a lanes) hex hash of the soup, its parts and every constant that shapes the bake */
export function navBakeHash(soup: Float32Array, parts: readonly SoupPart[]): string {
  const consts = new TextEncoder().encode(`navgrid/1 cell=${NAV_CELL} step=${BAKE_STEP} knee=${KNEE_CM} gap=${MERGE_GAP} perm=${JSON.stringify(PERMISSIVE)}`);
  const meta = new Uint32Array(parts.length * 3);
  parts.forEach((p, i) => { meta[i * 3] = p.first; meta[i * 3 + 1] = p.count; meta[i * 3 + 2] = p.closed ? 1 : 0; });
  const bytes = new Uint8Array(soup.buffer, soup.byteOffset, soup.byteLength), mb = new Uint8Array(meta.buffer);
  const a = fnv1a(mb, fnv1a(bytes, fnv1a(consts, 0x811c9dc5))), b = fnv1a(mb, fnv1a(bytes, fnv1a(consts, 0x9e3779b9)));
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

// ── step 1-2: rasterisation into merged column intervals ────────────────────────────────────────────────────────────────

/**
 * where rasterised pieces go: straight into the columns (open surfaces) or through the solid collector (closed meshes).
 * `facing` = the piece's signed share of the column: + up-facing, − down-facing, its xz area over the cell's; 0 for a vertical face
 */
interface PieceSink { add(c: number, lo: number, hi: number, slope: number, facing: number): void }

/** per-column sorted interval lists in a growable pool (merge on insert) */
class ColumnIntervals implements PieceSink {
  readonly head: Int32Array;
  lo = new Float64Array(0);
  hi = new Float64Array(0);
  slope = new Uint8Array(0);
  next = new Int32Array(0);
  private used = 0;
  private free = -1;
  constructor(columns: number) {
    this.head = new Int32Array(columns).fill(-1);
    this.grow(Math.max(1024, columns + (columns >> 1)));
  }
  private grow(cap: number): void {
    const lo = new Float64Array(cap), hi = new Float64Array(cap), sl = new Uint8Array(cap), nx = new Int32Array(cap);
    lo.set(this.lo); hi.set(this.hi); sl.set(this.slope); nx.set(this.next);
    this.lo = lo; this.hi = hi; this.slope = sl; this.next = nx;
  }
  private alloc(): number {
    if (this.free >= 0) { const r = this.free; this.free = this.next[r]!; return r; }
    if (this.used === this.lo.length) this.grow(this.lo.length * 2);
    return this.used++;
  }

  add(c: number, lo: number, hi: number, slope: number): void { this.insert(c, lo, hi, slope); }

  /** add [a, b] (top slope sl) to column c, merging every interval closer than MERGE_GAP */
  insert(c: number, a: number, b: number, sl: number): void {
    let prev = -1, cur = this.head[c]!;
    let lo = a, hi = b, s = sl;
    while (cur !== -1) {
      const cl = this.lo[cur]!, ch = this.hi[cur]!;
      if (cl - hi >= MERGE_GAP) break; // wholly above
      const nxt = this.next[cur]!;
      if (lo - ch >= MERGE_GAP) { prev = cur; cur = nxt; continue; } // wholly below
      // merge cur into the new interval
      if (ch > hi + TOP_EPS) s = this.slope[cur]!;
      else if (ch >= hi - TOP_EPS) s = combineSlope(s, this.slope[cur]!);
      if (ch > hi) hi = ch;
      if (cl < lo) lo = cl;
      if (prev === -1) this.head[c] = nxt; else this.next[prev] = nxt;
      this.next[cur] = this.free; this.free = cur;
      cur = nxt;
    }
    const r = this.alloc();
    this.lo[r] = lo; this.hi[r] = hi; this.slope[r] = s; this.next[r] = cur;
    if (prev === -1) this.head[c] = r; else this.next[prev] = r;
  }
}

/**
 * The pieces of one closed mesh (a box, a wedge, a generator's watertight soup), turned into solid intervals per column: sorted
 * by height, the winding number (+ crossing a downward face, − an upward one) is non-zero between the pieces inside the
 * solid, so a box standing on the floor fills from its bottom to its top and an arch keeps its opening. Each piece counts by
 * the share of the column it covers, not as one crossing: a column crossed by a face's diagonal holds two pieces of that face,
 * and a column on a solid's rim holds a part of its top and the same part of its bottom, so the sum returns to zero exactly
 * where the solid ends (counted whole, the two halves of a floor's top left the room above it "solid" up to the roof).
 */
class SolidCollector implements PieceSink {
  private n = 0;
  private col = new Int32Array(1024);
  private lo = new Float64Array(1024);
  private hi = new Float64Array(1024);
  private sl = new Uint8Array(1024);
  private f = new Float64Array(1024);

  add(c: number, lo: number, hi: number, slope: number, facing: number): void {
    if (this.n === this.col.length) {
      const cap = this.n * 2;
      const col = new Int32Array(cap), l = new Float64Array(cap), h = new Float64Array(cap), sl = new Uint8Array(cap), f = new Float64Array(cap);
      col.set(this.col); l.set(this.lo); h.set(this.hi); sl.set(this.sl); f.set(this.f);
      this.col = col; this.lo = l; this.hi = h; this.sl = sl; this.f = f;
    }
    const i = this.n++;
    this.col[i] = c; this.lo[i] = lo; this.hi[i] = hi; this.sl[i] = slope; this.f[i] = facing;
  }

  flush(cols: ColumnIntervals): void {
    const n = this.n, col = this.col, lo = this.lo, hi = this.hi, sl = this.sl, f = this.f;
    const idx = new Int32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    idx.sort((a, b) => col[a]! - col[b]! || lo[a]! + hi[a]! - (lo[b]! + hi[b]!) || lo[a]! - lo[b]! || a - b);
    let i = 0;
    while (i < n) {
      const c = col[idx[i]!]!;
      let w = 0, has = false, sLo = 0, sHi = 0, sSl = 0;
      for (; i < n && col[idx[i]!] === c; i++) {
        const p = idx[i]!, pl = lo[p]!, ph = hi[p]!;
        if (has && Math.abs(w) < WIND_EPS && pl > sHi) { cols.insert(c, sLo, sHi, sSl); has = false; }
        if (!has) { sLo = pl; sHi = ph; sSl = sl[p]!; has = true; }
        else {
          if (ph > sHi + TOP_EPS) sSl = sl[p]!;
          else if (ph >= sHi - TOP_EPS) sSl = combineSlope(sSl, sl[p]!);
          if (ph > sHi) sHi = ph;
          if (pl < sLo) sLo = pl;
        }
        w -= f[p]!;
      }
      if (has) cols.insert(c, sLo, sHi, sSl);
    }
    this.n = 0;
  }
}

/** the floor slope when two triangles reach the same top: the steeper, but a vertical face only when nothing flatter does */
function combineSlope(a: number, b: number): number {
  const av = a >= STEEP, bv = b >= STEEP;
  if (av !== bv) return av ? b : a;
  return a > b ? a : b;
}

// polygon scratch (≤ 3 + 4 clip vertices; on-line points are duplicated into both halves, so allow headroom)
const PV = 16 * 3;
const P_IN = new Float64Array(PV), P_ROW = new Float64Array(PV), P_REST = new Float64Array(PV), P_CELL = new Float64Array(PV), P_TMP = new Float64Array(PV);
const DIST = new Float64Array(16);

/** Recast `dividePoly`: split `inp` (n verts) at coordinate `x` on `axis` into out1 (≤ x) and out2 (≥ x); returns n1 | n2 << 8 */
function divide(inp: Float64Array, n: number, out1: Float64Array, out2: Float64Array, x: number, axis: number): number {
  for (let i = 0; i < n; i++) DIST[i] = x - inp[i * 3 + axis]!;
  let m = 0, k = 0;
  for (let i = 0, j = n - 1; i < n; j = i, i++) {
    const dj = DIST[j]!, di = DIST[i]!;
    const ina = dj >= 0, inb = di >= 0;
    if (ina !== inb) {
      const s = dj / (dj - di);
      for (let q = 0; q < 3; q++) {
        const v = inp[j * 3 + q]! + (inp[i * 3 + q]! - inp[j * 3 + q]!) * s;
        out1[m * 3 + q] = v; out2[k * 3 + q] = v;
      }
      m++; k++;
      if (di > 0) { out1[m * 3] = inp[i * 3]!; out1[m * 3 + 1] = inp[i * 3 + 1]!; out1[m * 3 + 2] = inp[i * 3 + 2]!; m++; }
      else if (di < 0) { out2[k * 3] = inp[i * 3]!; out2[k * 3 + 1] = inp[i * 3 + 1]!; out2[k * 3 + 2] = inp[i * 3 + 2]!; k++; }
    } else {
      if (di >= 0) {
        out1[m * 3] = inp[i * 3]!; out1[m * 3 + 1] = inp[i * 3 + 1]!; out1[m * 3 + 2] = inp[i * 3 + 2]!; m++;
        if (di !== 0) continue;
      }
      out2[k * 3] = inp[i * 3]!; out2[k * 3 + 1] = inp[i * 3 + 1]!; out2[k * 3 + 2] = inp[i * 3 + 2]!; k++;
    }
    if (m > 15 || k > 15) throw new Error('nav bake: clip buffer overflow');
  }
  return m | (k << 8);
}

interface Lattice { ox: number; oz: number; nx: number; nz: number }

function snap(v: number, o: number): number {
  const t = (v - o) / NAV_CELL, r = Math.round(t);
  return Math.abs(t - r) * NAV_CELL <= SNAP ? o + r * NAV_CELL : v;
}

/** rasterise one triangle (9 floats at off) into the column intervals; false when it was skipped (degenerate / non-finite) */
function rasterise(soup: Float32Array, off: number, L: Lattice, cols: PieceSink): boolean {
  for (let v = 0; v < 3; v++) {
    const x = soup[off + v * 3]!, y = soup[off + v * 3 + 1]!, z = soup[off + v * 3 + 2]!;
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return false;
    P_IN[v * 3] = snap(x, L.ox); P_IN[v * 3 + 1] = y; P_IN[v * 3 + 2] = snap(z, L.oz);
  }
  const e1x = P_IN[3]! - P_IN[0]!, e1y = P_IN[4]! - P_IN[1]!, e1z = P_IN[5]! - P_IN[2]!;
  const e2x = P_IN[6]! - P_IN[0]!, e2y = P_IN[7]! - P_IN[1]!, e2z = P_IN[8]! - P_IN[2]!;
  const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  const nl = Math.sqrt(nx * nx + ny * ny + nz * nz);
  if (!(nl > 1e-12)) return false;
  const vertical = Math.abs(ny) <= VERTICAL_REL * nl;
  const slope = vertical ? 90 : Math.round((Math.acos(Math.min(1, Math.abs(ny) / nl)) * 180) / Math.PI);
  const facing = vertical ? 0 : ny > 0 ? 1 : -1;

  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
  for (let v = 0; v < 3; v++) {
    const x = P_IN[v * 3]!, z = P_IN[v * 3 + 2]!;
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (z < minz) minz = z; if (z > maxz) maxz = z;
  }
  // a face exactly on a lattice line also visits the column on its low side (it may belong there, see rasteriseRow)
  const ix0 = Math.max(0, Math.ceil((minx - L.ox) / NAV_CELL) - 1), ix1 = Math.min(L.nx - 1, Math.floor((maxx - L.ox) / NAV_CELL));
  const iz0 = Math.max(0, Math.ceil((minz - L.oz) / NAV_CELL) - 1), iz1 = Math.min(L.nz - 1, Math.floor((maxz - L.oz) / NAV_CELL));
  if (ix0 > ix1 || iz0 > iz1) return true;

  // rows along z: REST holds what is left above the current row
  P_REST.set(P_IN.subarray(0, 9));
  let nRest = 3;
  const cz0First = L.oz + iz0 * NAV_CELL;
  if (minz < cz0First) {
    nRest = divide(P_REST, nRest, P_ROW, P_TMP, cz0First, 2) >> 8;
    P_REST.set(P_TMP.subarray(0, nRest * 3));
  }
  for (let iz = iz0; iz <= iz1 && nRest > 0; iz++) {
    const cz0 = L.oz + iz * NAV_CELL, cz1 = cz0 + NAV_CELL;
    const r = divide(P_REST, nRest, P_ROW, P_TMP, cz1, 2);
    const nRow = r & 0xff;
    nRest = r >> 8;
    P_REST.set(P_TMP.subarray(0, nRest * 3));
    if (nRow > 0) rasteriseRow(nRow, iz, cz0, cz1, ix0, ix1, L, cols, vertical, nx, nz, slope, facing);
  }
  return true;
}

const P_ROWREST = new Float64Array(PV), P_ROWTMP = new Float64Array(PV);

/** clip the row polygon in P_ROW into columns ix0..ix1 and add each kept piece's y-interval */
function rasteriseRow(nRow: number, iz: number, cz0: number, cz1: number, ix0: number, ix1: number, L: Lattice,
  cols: PieceSink, vertical: boolean, fnx: number, fnz: number, slope: number, facing: number): void {
  P_ROWREST.set(P_ROW.subarray(0, nRow * 3));
  let nRest = nRow;
  const cx0First = L.ox + ix0 * NAV_CELL;
  let minx = Infinity;
  for (let i = 0; i < nRest; i++) minx = Math.min(minx, P_ROWREST[i * 3]!);
  if (minx < cx0First) {
    nRest = divide(P_ROWREST, nRest, P_CELL, P_ROWTMP, cx0First, 0) >> 8;
    P_ROWREST.set(P_ROWTMP.subarray(0, nRest * 3));
  }
  for (let ix = ix0; ix <= ix1 && nRest > 0; ix++) {
    const cx0 = L.ox + ix * NAV_CELL, cx1 = cx0 + NAV_CELL;
    const r = divide(P_ROWREST, nRest, P_CELL, P_ROWTMP, cx1, 0);
    const n = r & 0xff;
    nRest = r >> 8;
    P_ROWREST.set(P_ROWTMP.subarray(0, nRest * 3));
    if (n === 0) continue;
    let ymin = Infinity, ymax = -Infinity, pminx = Infinity, pmaxx = -Infinity, pminz = Infinity, pmaxz = -Infinity, area2 = 0;
    for (let i = 0, j = n - 1; i < n; j = i, i++) {
      const x = P_CELL[i * 3]!, y = P_CELL[i * 3 + 1]!, z = P_CELL[i * 3 + 2]!;
      if (y < ymin) ymin = y; if (y > ymax) ymax = y;
      if (x < pminx) pminx = x; if (x > pmaxx) pmaxx = x;
      if (z < pminz) pminz = z; if (z > pmaxz) pmaxz = z;
      area2 += P_CELL[j * 3]! * z - x * P_CELL[j * 3 + 2]!;
    }
    if (!vertical) {
      if (Math.abs(area2) * 0.5 <= AREA_EPS) continue;
    } else {
      const wx = pmaxx - pminx, wz = pmaxz - pminz;
      if (wx <= LEN_EPS && wz <= LEN_EPS) continue;
      // a face lying on a column boundary belongs to the column on its solid side (the normal points out of it)
      if (wx <= LEN_EPS) {
        if (Math.abs(pminx - cx1) <= LEN_EPS && !(fnx > 0)) continue;
        if (Math.abs(pminx - cx0) <= LEN_EPS && !(fnx < 0)) continue;
      }
      if (wz <= LEN_EPS) {
        if (Math.abs(pminz - cz1) <= LEN_EPS && !(fnz > 0)) continue;
        if (Math.abs(pminz - cz0) <= LEN_EPS && !(fnz < 0)) continue;
      }
    }
    cols.add(iz * L.nx + ix, ymin, ymax, slope, vertical ? 0 : facing * Math.abs(area2) * (0.5 / (NAV_CELL * NAV_CELL)));
  }
}

// ── steps 3-5 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** binary min-heap of (key, span) with a span-index tie-break (deterministic) */
class Heap {
  private k = new Float64Array(1024);
  private v = new Int32Array(1024);
  size = 0;
  push(key: number, val: number): void {
    if (this.size === this.k.length) {
      const k = new Float64Array(this.size * 2), v = new Int32Array(this.size * 2);
      k.set(this.k); v.set(this.v); this.k = k; this.v = v;
    }
    let i = this.size++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.k[p]! < key || (this.k[p] === key && this.v[p]! <= val)) break;
      this.k[i] = this.k[p]!; this.v[i] = this.v[p]!; i = p;
    }
    this.k[i] = key; this.v[i] = val;
  }
  /** pops the minimum; returns its span, the key in `lastKey` */
  lastKey = 0;
  pop(): number {
    const top = this.v[0]!;
    this.lastKey = this.k[0]!;
    const key = this.k[--this.size]!, val = this.v[this.size]!;
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && (this.k[c + 1]! < this.k[c]! || (this.k[c + 1] === this.k[c] && this.v[c + 1]! < this.v[c]!))) c++;
      if (key < this.k[c]! || (key === this.k[c] && val <= this.v[c]!)) break;
      this.k[i] = this.k[c]!; this.v[i] = this.v[c]!; i = c;
    }
    this.k[i] = key; this.v[i] = val;
    return top;
  }
}

function find(parent: Int32Array, a: number): number {
  let r = a;
  while (parent[r]! !== r) r = parent[r]!;
  while (parent[a]! !== r) { const n = parent[a]!; parent[a] = r; a = n; }
  return r;
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** bake a pack's NavGrid (immutable colliders + terrain) */
export function bakeNavGrid(pack: ColliderPack, opts: NavBakeOptions = {}): { grid: NavGridData; report: NavBakeReport } {
  const { soup, parts } = soupParts(pack);
  return bakeNavGridFromParts(pack.place, soup, parts, opts);
}

/** bake from a world-space triangle soup (9 floats per triangle) cut into parts (`soupParts`) */
export function bakeNavGridFromParts(place: string, soup: Float32Array, parts: readonly SoupPart[], opts: NavBakeOptions = {}): { grid: NavGridData; report: NavBakeReport } {
  const t0 = now();
  const triCount = Math.floor(soup.length / 9);

  // AABB of the finite triangles, on the cell lattice
  let minx = Infinity, maxx = -Infinity, minz = Infinity, maxz = -Infinity;
  for (let t = 0; t < triCount; t++) {
    const o = t * 9;
    let ok = true;
    for (let i = 0; i < 9; i++) if (!Number.isFinite(soup[o + i]!)) { ok = false; break; }
    if (!ok) continue;
    for (let v = 0; v < 3; v++) {
      const x = soup[o + v * 3]!, z = soup[o + v * 3 + 2]!;
      if (x < minx) minx = x; if (x > maxx) maxx = x;
      if (z < minz) minz = z; if (z > maxz) maxz = z;
    }
  }
  const empty = !(minx <= maxx);
  const ox = empty ? 0 : Math.floor((minx + SNAP) / NAV_CELL) * NAV_CELL;
  const oz = empty ? 0 : Math.floor((minz + SNAP) / NAV_CELL) * NAV_CELL;
  const nx = empty ? 0 : Math.max(1, Math.ceil((maxx - ox - SNAP) / NAV_CELL));
  const nz = empty ? 0 : Math.max(1, Math.ceil((maxz - oz - SNAP) / NAV_CELL));
  const ncols = nx * nz;
  if (ncols > MAX_COLUMNS) throw new Error(`nav bake ${place}: ${nx} × ${nz} columns exceed the ${MAX_COLUMNS} limit`);
  const L: Lattice = { ox, oz, nx, nz };

  // 1-2: rasterise and merge
  const cols = new ColumnIntervals(ncols), solid = new SolidCollector();
  let skipped = 0;
  for (const part of parts) {
    const sink: PieceSink = part.closed ? solid : cols;
    for (let t = part.first, e = part.first + part.count; t < e; t++) if (!rasterise(soup, t * 9, L, sink)) skipped++;
    if (part.closed) solid.flush(cols);
  }

  // CSR of merged intervals: span s = interval s (floor = its top)
  const colStart = new Uint32Array(ncols + 1);
  let S = 0, maxPer = 0;
  for (let c = 0; c < ncols; c++) {
    let k = 0;
    for (let r = cols.head[c]!; r !== -1; r = cols.next[r]!) k++;
    if (k > 255) throw new Error(`nav bake ${place}: column ${c} has ${k} floors (max 255)`);
    if (k > maxPer) maxPer = k;
    S += k;
    colStart[c + 1] = S;
  }
  const lo = new Int32Array(S), y = new Int16Array(S), slope = new Uint8Array(S), clear = new Uint8Array(S);
  for (let c = 0, s = 0; c < ncols; c++) {
    for (let r = cols.head[c]!; r !== -1; r = cols.next[r]!, s++) {
      const hiCm = Math.round(cols.hi[r]! / Y_UNIT);
      if (hiCm < -32768 || hiCm > 32767) throw new Error(`nav bake ${place}: floor at ${cols.hi[r]} m is outside the ±327 m range`);
      lo[s] = Math.round(cols.lo[r]! / Y_UNIT);
      y[s] = hiCm;
      slope[s] = cols.slope[r]!;
    }
    for (let s = colStart[c]!; s < colStart[c + 1]!; s++) {
      clear[s] = s + 1 < colStart[c + 1]! ? Math.min(UNIT_MAX, Math.floor((lo[s + 1]! - y[s]!) / (CLEAR_UNIT / Y_UNIT))) : UNIT_MAX;
    }
  }
  const colOf = new Uint32Array(S);
  for (let c = 0; c < ncols; c++) colOf.fill(c, colStart[c]!, colStart[c + 1]!);

  // 3: edge classification against a neighbour column (cm)
  const neighbour = (s: number, d: number): number => {
    const c = colOf[s]!, ix = (c % nx) + NAV_DX[d]!, iz = Math.floor(c / nx) + NAV_DZ[d]!;
    return ix < 0 || iz < 0 || ix >= nx || iz >= nz ? -1 : iz * nx + ix;
  };
  const isWall = (ys: number, c: number): boolean => {
    if (c < 0) return true;
    const a = colStart[c]!, b = colStart[c + 1]!;
    let lower = false, conn = false;
    for (let t = a; t < b; t++) {
      if (lo[t]! < ys + KNEE_CM && y[t]! > ys + STEP_CM) return true;
      const dy = y[t]! - ys;
      if (dy >= -STEP_CM && dy <= STEP_CM) conn = true;
      else if (dy < -STEP_CM) lower = true;
    }
    return !conn && !lower; // no floor at all below: a hole is a wall
  };

  // 4: wall distance
  const dist = new Float64Array(S).fill(Infinity);
  const heap = new Heap();
  for (let s = 0; s < S; s++) {
    for (let d = 0; d < 8; d++) {
      if (isWall(y[s]!, neighbour(s, d))) { dist[s] = NAV_CELL / 2; heap.push(dist[s]!, s); break; }
    }
  }
  while (heap.size > 0) {
    const s = heap.pop(), ds = heap.lastKey;
    if (ds > dist[s]!) continue;
    const ys = y[s]!;
    for (let d = 0; d < 8; d++) {
      const c = neighbour(s, d);
      if (c < 0 || isWall(ys, c)) continue;
      const nd = ds + (d < 4 ? NAV_CELL : DIAG);
      for (let t = colStart[c]!; t < colStart[c + 1]!; t++) {
        const dy = y[t]! - ys;
        if (dy < -STEP_CM || dy > STEP_CM || nd >= dist[t]!) continue;
        dist[t] = nd;
        heap.push(nd, t);
      }
    }
  }
  const wall = new Uint8Array(S);
  for (let s = 0; s < S; s++) wall[s] = dist[s] === Infinity ? UNIT_MAX : Math.min(UNIT_MAX, Math.floor(dist[s]! / WALL_UNIT + 1e-9));

  // 5: permissive components + drop links
  const P = agentUnits(PERMISSIVE);
  const bakeHash = navBakeHash(soup, parts);
  const header = (componentCount: number): NavGridHeader => ({
    version: 1, place, cell: NAV_CELL, originX: ox, originZ: oz, nx, nz, spanCount: S, componentCount, bakeStep: BAKE_STEP, bakeHash,
  });
  const comp = new Uint16Array(S);
  const pre = new NavGridData(header(0), { colStart, y, clear, slope, wall, comp });
  const parent = new Int32Array(S);
  for (let s = 0; s < S; s++) parent[s] = s;
  for (let s = 0; s < S; s++) {
    if (!pre.passable(s, P)) continue;
    for (let d = 0; d < 8; d++) {
      const c = neighbour(s, d);
      if (c < 0) continue;
      for (let t = colStart[c]!; t < colStart[c + 1]!; t++) {
        const dy = y[t]! - y[s]!;
        if (dy < -P.stepCm || dy > P.stepCm || !pre.passable(t, P)) continue;
        const a = find(parent, s), b = find(parent, t);
        if (a !== b) { if (a < b) parent[b] = a; else parent[a] = b; }
      }
    }
  }
  const label = new Uint32Array(S);
  let count = 0;
  for (let s = 0; s < S; s++) {
    if (!pre.passable(s, P)) { comp[s] = COMP_NONE; continue; }
    const r = find(parent, s);
    if (label[r] === 0) label[r] = count < COMP_OVERFLOW - 1 ? ++count : (count = COMP_OVERFLOW, COMP_OVERFLOW);
    comp[s] = label[r]!;
  }
  const componentCount = count;
  const linkSet = new Set<number>();
  for (let s = 0; s < S; s++) {
    if (comp[s] === COMP_NONE) continue;
    for (let d = 0; d < 8; d++) {
      const t = pre.moveTarget(s, d, P);
      if (t < 0 || comp[t] === COMP_NONE || comp[t] === comp[s] || y[t]! >= y[s]! - P.stepCm) continue;
      linkSet.add(comp[s]! * 0x10000 + comp[t]!);
    }
  }
  const pairs = Array.from(linkSet).sort((a, b) => a - b);
  const linkStart = new Uint32Array(componentCount + 2), linkTo = new Uint16Array(pairs.length);
  pairs.forEach((p, i) => { linkTo[i] = p & 0xffff; const a = p >>> 16; linkStart[a + 1] = linkStart[a + 1]! + 1; });
  for (let a = 0; a <= componentCount; a++) linkStart[a + 1] = linkStart[a + 1]! + linkStart[a]!;

  const grid = new NavGridData(header(componentCount), { colStart, y, clear, slope, wall, comp, linkStart, linkTo });

  const probes = (opts.probes ?? []).map(({ id, p }) => {
    const span = grid.locate(p, 0.6, 2.0);
    return { id, span, comp: span >= 0 ? grid.comp[span]! : COMP_NONE };
  });
  const report: NavBakeReport = {
    place, triangles: triCount, skipped, columns: ncols, spans: S, components: componentCount, links: pairs.length,
    maxSpansPerColumn: maxPer, bakeMs: now() - t0, probes,
    unreachable: probes.filter((p) => p.comp === COMP_NONE).map((p) => p.id),
  };
  return { grid, report };
}
