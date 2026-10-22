// The runtime NavGrid (motion §7.2, D-MPN-02; WP NV1): a multi-level 2.5D heightfield of walkable spans at 0.25 m cells, CSR
// by column, plus the lookups the search (NV2, motion §7.4) and the baker share, and the binary form shipped in the PlaceBake.
//
// Units (the `NavGrid` interface of core/ports.ts): `y` floor height in cm; `clear` free height above the floor in 5 cm units
// (255 = ≥ 12.75 m, open sky); `slope` degrees of the steepest walkable-class triangle defining the floor; `wall` distance to
// the nearest wall edge in 2 cm units (255 = ≥ 5.1 m); `comp` the connected component under the permissive class (0 = the span
// fails that class; COMP_OVERFLOW = beyond 65,534 components, "unknown"). Spans are sorted by y within a column; columns are
// row-major in z (`col = iz·nx + ix`), cell (ix, iz) covers x ∈ [originX + ix·cell, … + cell), likewise z.
//
// Shared rules (one definition for the bake's components and the search, so the components early-out stays conservative):
// - `agentUnits` turns per-call agent parameters (metres, degrees) into stored units, rounding towards "not passable".
// - `passable(s, u)`: clear ≥ height, wall ≥ radius, slope ≤ slope limit.
// - `moveTarget(s, dir, u)`: the span an agent reaches by moving one cell: the neighbour span with |Δy| ≤ step (closest,
//   ties to the lower) = walk; else the highest neighbour span below y − step = drop, only when it is within maxDrop and its
//   free space reaches the source floor + agent height (nothing solid to fall through). Diagonal corner rules are the
//   search's (motion §7.4 item 4).
// - The component graph: spans passable for PERMISSIVE are unioned with every passable 8-neighbour span within the
//   permissive step (a superset of any stricter class's walk moves), and drop moves between components are kept as directed
//   links. `reachable(a, b)` is therefore never false for a query at least as strict as PERMISSIVE when a path exists.
import type { NavGrid, NavGridHeader } from '../core/ports.ts';
import type { Vec3 } from '../core/types.ts';

export const NAV_CELL = 0.25;
/** the bake-time edge classification step (≥ every live step, motion §7.3 item 3) */
export const BAKE_STEP = 0.45;
export const Y_UNIT = 0.01;
export const CLEAR_UNIT = 0.05;
export const WALL_UNIT = 0.02;
export const UNIT_MAX = 255;
export const COMP_NONE = 0;
export const COMP_OVERFLOW = 0xffff;
export const NAV_FORMAT = 1;

/** the permissive agent class of the component labels (motion §7.3 item 5) */
export const PERMISSIVE: Readonly<AgentParams> = Object.freeze({ radius: 0.35, height: 1.0, step: 0.4, slope: 50, maxDrop: 3 });

/** the 8 neighbour moves: orthogonal first (indices 0-3), then diagonal (4-7) */
export const NAV_DIRS: ReadonlyArray<readonly [dx: number, dz: number]> = Object.freeze([
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1],
] as const);
export const NAV_DX = Int8Array.from(NAV_DIRS, (d) => d[0]);
export const NAV_DZ = Int8Array.from(NAV_DIRS, (d) => d[1]);

/** per-call agent parameters in metres and degrees (findPath options after defaults, motion §7.4 item 1) */
export interface AgentParams { radius: number; height: number; step: number; slope: number; maxDrop: number }
/** the same in stored units */
export interface AgentUnits {
  /** wall ≥ wallMin (2 cm units) */
  wallMin: number;
  /** clear ≥ clearMin (5 cm units) */
  clearMin: number;
  /** slope ≤ slopeMax (degrees) */
  slopeMax: number;
  stepCm: number;
  dropCm: number;
  heightCm: number;
}

const capUnit = (v: number): number => Math.min(UNIT_MAX, Math.max(0, v));

/** metres → stored units, each rounded towards "not passable" (the radius and height up, the step, drop and slope down) */
export function agentUnits(a: AgentParams): AgentUnits {
  return {
    wallMin: capUnit(Math.ceil(a.radius / WALL_UNIT - 1e-9)),
    clearMin: capUnit(Math.ceil(a.height / CLEAR_UNIT - 1e-9)),
    slopeMax: Math.floor(a.slope + 1e-9),
    stepCm: Math.max(0, Math.floor(a.step / Y_UNIT + 1e-6)),
    dropCm: Math.max(0, Math.floor(a.maxDrop / Y_UNIT + 1e-6)),
    heightCm: Math.max(0, Math.ceil(a.height / Y_UNIT - 1e-6)),
  };
}

export class NavGridData implements NavGrid {
  readonly h: NavGridHeader;
  readonly colStart: Uint32Array;
  readonly y: Int16Array;
  readonly clear: Uint8Array;
  readonly slope: Uint8Array;
  readonly wall: Uint8Array;
  readonly comp: Uint16Array;
  /** directed component graph (drop links): CSR over component ids 0..componentCount (componentCount + 2 offsets) */
  readonly linkStart: Uint32Array;
  readonly linkTo: Uint16Array;
  /** span → column index (derived, not serialised) */
  readonly col: Uint32Array;
  private seen: Uint32Array | null = null;
  private queue: Uint32Array | null = null;
  private stamp = 0;

  constructor(h: NavGridHeader, a: {
    colStart: Uint32Array; y: Int16Array; clear: Uint8Array; slope: Uint8Array; wall: Uint8Array; comp: Uint16Array
    linkStart?: Uint32Array; linkTo?: Uint16Array
  }) {
    const cols = h.nx * h.nz, n = h.spanCount;
    if (a.colStart.length !== cols + 1 || a.colStart[cols] !== n) throw new Error(`NavGrid ${h.place}: colStart does not cover ${n} spans`);
    for (const k of ['y', 'clear', 'slope', 'wall', 'comp'] as const) {
      if (a[k].length !== n) throw new Error(`NavGrid ${h.place}: ${k} has ${a[k].length} entries, expected ${n}`);
    }
    this.h = h;
    this.colStart = a.colStart; this.y = a.y; this.clear = a.clear; this.slope = a.slope; this.wall = a.wall; this.comp = a.comp;
    this.linkStart = a.linkStart ?? new Uint32Array(h.componentCount + 2);
    this.linkTo = a.linkTo ?? new Uint16Array(0);
    if (this.linkStart.length !== h.componentCount + 2 || this.linkStart[h.componentCount + 1] !== this.linkTo.length) throw new Error(`NavGrid ${h.place}: linkStart does not match ${h.componentCount} components`);
    this.col = new Uint32Array(n);
    for (let c = 0; c < cols; c++) this.col.fill(c, a.colStart[c]!, a.colStart[c + 1]!);
  }

  /** column index of cell (ix, iz), or −1 outside the grid */
  columnIndex(ix: number, iz: number): number {
    return ix < 0 || iz < 0 || ix >= this.h.nx || iz >= this.h.nz ? -1 : iz * this.h.nx + ix;
  }

  spansAt(ix: number, iz: number): [start: number, end: number] {
    const c = this.columnIndex(ix, iz);
    return c < 0 ? [0, 0] : [this.colStart[c]!, this.colStart[c + 1]!];
  }

  cellX(s: number): number { return this.col[s]! % this.h.nx; }
  cellZ(s: number): number { return Math.floor(this.col[s]! / this.h.nx); }
  /** world x / z of a cell centre */
  centreX(ix: number): number { return this.h.originX + (ix + 0.5) * NAV_CELL; }
  centreZ(iz: number): number { return this.h.originZ + (iz + 0.5) * NAV_CELL; }
  cellIndexX(x: number): number { return Math.floor((x - this.h.originX) / NAV_CELL); }
  cellIndexZ(z: number): number { return Math.floor((z - this.h.originZ) / NAV_CELL); }

  /** floor height, metres */
  floorY(s: number): number { return this.y[s]! * Y_UNIT; }
  /** free height above the floor, metres (Infinity for open sky / ≥ 12.75 m) */
  clearM(s: number): number { const c = this.clear[s]!; return c === UNIT_MAX ? Infinity : c * CLEAR_UNIT; }
  /** distance to the nearest wall edge, metres (Infinity for ≥ 5.1 m) */
  wallM(s: number): number { const w = this.wall[s]!; return w === UNIT_MAX ? Infinity : w * WALL_UNIT; }

  passable(s: number, u: AgentUnits): boolean {
    return this.clear[s]! >= u.clearMin && this.wall[s]! >= u.wallMin && this.slope[s]! <= u.slopeMax;
  }

  /** the span reached by moving one cell in NAV_DIRS[dir] (walk, else drop), or −1; passability is the caller's test */
  moveTarget(s: number, dir: number, u: AgentUnits): number {
    const c0 = this.col[s]!, nx = this.h.nx;
    const c = this.columnIndex((c0 % nx) + NAV_DX[dir]!, Math.floor(c0 / nx) + NAV_DZ[dir]!);
    if (c < 0) return -1;
    const ys = this.y[s]!, a = this.colStart[c]!, b = this.colStart[c + 1]!;
    let best = -1, bestD = Infinity;
    for (let t = a; t < b; t++) {
      const d = Math.abs(this.y[t]! - ys);
      if (d <= u.stepCm && d < bestD) { best = t; bestD = d; }
    }
    if (best >= 0) return best;
    for (let t = b - 1; t >= a; t--) {
      const yt = this.y[t]!;
      if (yt >= ys - u.stepCm) continue;
      if (yt < ys - u.dropCm) return -1;
      const cl = this.clear[t]!;
      return cl === UNIT_MAX || yt + cl * (CLEAR_UNIT / Y_UNIT) >= ys + u.heightCm ? t : -1;
    }
    return -1;
  }

  /** the span of column (ix, iz) nearest y (metres) within [y − maxDown, y + maxUp]; ties go to the lower span; −1 if none */
  locateInColumn(ix: number, iz: number, y: number, maxUp: number, maxDown: number): number {
    const c = this.columnIndex(ix, iz);
    if (c < 0) return -1;
    const yc = y / Y_UNIT, lo = yc - maxDown / Y_UNIT, hi = yc + maxUp / Y_UNIT;
    let best = -1, bestD = Infinity;
    for (let t = this.colStart[c]!, e = this.colStart[c + 1]!; t < e; t++) {
      const yt = this.y[t]!;
      if (yt < lo || yt > hi) continue;
      const d = Math.abs(yt - yc);
      if (d < bestD) { best = t; bestD = d; }
    }
    return best;
  }

  /** the span under p (its column, else the nearest of the 8 neighbour columns by xz + y distance), or −1 */
  locate(p: Vec3, maxUp: number, maxDown: number): number {
    const ix = this.cellIndexX(p.x), iz = this.cellIndexZ(p.z);
    const own = this.locateInColumn(ix, iz, p.y, maxUp, maxDown);
    if (own >= 0) return own;
    let best = -1, bestD = Infinity;
    for (let d = 0; d < 8; d++) {
      const jx = ix + NAV_DX[d]!, jz = iz + NAV_DZ[d]!;
      const t = this.locateInColumn(jx, jz, p.y, maxUp, maxDown);
      if (t < 0) continue;
      const dx = this.centreX(jx) - p.x, dz = this.centreZ(jz) - p.z, dy = this.floorY(t) - p.y;
      const dd = dx * dx + dz * dz + dy * dy;
      if (dd < bestD) { best = t; bestD = dd; }
    }
    return best;
  }

  /** false only when the permissive component graph proves `to` unreachable from `from` (0 / overflow: unknown → true) */
  reachable(from: number, to: number): boolean {
    const n = this.h.componentCount;
    if (from === to) return true;
    if (from === COMP_NONE || to === COMP_NONE || from === COMP_OVERFLOW || to === COMP_OVERFLOW || from > n || to > n) return true;
    if (!this.seen || this.seen.length < n + 1) { this.seen = new Uint32Array(n + 1); this.queue = new Uint32Array(n + 1); this.stamp = 0; }
    const seen = this.seen, queue = this.queue!;
    if (++this.stamp === 0xffffffff) { seen.fill(0); this.stamp = 1; }
    const st = this.stamp;
    let head = 0, tail = 0;
    queue[tail++] = from; seen[from] = st;
    while (head < tail) {
      const c = queue[head++]!;
      for (let i = this.linkStart[c]!, e = this.linkStart[c + 1]!; i < e; i++) {
        const t = this.linkTo[i]!;
        if (t === to || t === COMP_OVERFLOW) return true;
        if (seen[t] !== st) { seen[t] = st; queue[tail++] = t; }
      }
    }
    return false;
  }
}

// ── binary form ─────────────────────────────────────────────────────────────────────────────────────────────────────────
//
//   'PPNV'  u32 NAV_FORMAT  u32 jsonBytes  JSON { h, links }  (padded to 4)
//   counts  u8  × nx·nz     spans per column (the CSR offsets are rebuilt on decode)
//   y       i16 × S         ┐
//   clear   u8  × S         │ each delta-coded along the span order (wrapping), so flat floors and smooth terrain deflate well
//   slope   u8  × S         │
//   wall    u8  × S         │
//   comp    u16 × S         ┘
//   links   u16 × 2·L       (from, to) pairs sorted
// Every section is padded to 4 bytes. Little-endian (asserted on the host: every engine the port targets is little-endian).

const MAGIC = [0x50, 0x50, 0x4e, 0x56]; // PPNV
const pad4 = (n: number): number => (n + 3) & ~3;
const LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;

function assertLittleEndian(): void {
  if (!LITTLE) throw new Error('NavGrid binary: big-endian hosts are not supported');
}

interface Section { bytes: Uint8Array }

function deltaEncode<T extends Int16Array | Uint8Array | Uint16Array>(a: T, out: T): T {
  let prev = 0;
  for (let i = 0; i < a.length; i++) { const v = a[i]!; out[i] = v - prev; prev = v; }
  return out;
}
function deltaDecode<T extends Int16Array | Uint8Array | Uint16Array>(a: T): T {
  for (let i = 1; i < a.length; i++) a[i] = a[i]! + a[i - 1]!;
  return a;
}
const asBytes = (a: ArrayBufferView): Uint8Array => new Uint8Array(a.buffer, a.byteOffset, a.byteLength);

export function encodeNavGrid(g: NavGridData): Uint8Array {
  assertLittleEndian();
  const cols = g.h.nx * g.h.nz, n = g.h.spanCount, links = g.linkTo.length;
  const counts = new Uint8Array(cols);
  for (let c = 0; c < cols; c++) {
    const k = g.colStart[c + 1]! - g.colStart[c]!;
    if (k > 255) throw new Error(`NavGrid ${g.h.place}: column ${c} holds ${k} spans (max 255)`);
    counts[c] = k;
  }
  const pairs = new Uint16Array(links * 2);
  for (let a = 0, w = 0; a <= g.h.componentCount; a++) {
    for (let i = g.linkStart[a]!; i < g.linkStart[a + 1]!; i++) { pairs[w++] = a; pairs[w++] = g.linkTo[i]!; }
  }
  const json = new TextEncoder().encode(JSON.stringify({ h: g.h, links }));
  const sections: Section[] = [
    { bytes: counts },
    { bytes: asBytes(deltaEncode(g.y, new Int16Array(n))) },
    { bytes: deltaEncode(g.clear, new Uint8Array(n)) },
    { bytes: deltaEncode(g.slope, new Uint8Array(n)) },
    { bytes: deltaEncode(g.wall, new Uint8Array(n)) },
    { bytes: asBytes(deltaEncode(g.comp, new Uint16Array(n))) },
    { bytes: asBytes(pairs) },
  ];
  let total = 12 + pad4(json.length);
  for (const s of sections) total += pad4(s.bytes.length);
  const out = new Uint8Array(total);
  out.set(MAGIC, 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(4, NAV_FORMAT, true);
  dv.setUint32(8, json.length, true);
  out.set(json, 12);
  let w = 12 + pad4(json.length);
  for (const s of sections) { out.set(s.bytes, w); w += pad4(s.bytes.length); }
  return out;
}

function isHeader(v: unknown): v is NavGridHeader {
  if (!v || typeof v !== 'object') return false;
  const h = v as Record<string, unknown>;
  return h['version'] === 1 && h['cell'] === NAV_CELL && h['bakeStep'] === BAKE_STEP && typeof h['place'] === 'string' && typeof h['bakeHash'] === 'string'
    && ['originX', 'originZ', 'nx', 'nz', 'spanCount', 'componentCount'].every((k) => typeof h[k] === 'number' && Number.isFinite(h[k]));
}

export function decodeNavGrid(bytes: Uint8Array): NavGridData {
  assertLittleEndian();
  if (bytes.length < 12 || MAGIC.some((m, i) => bytes[i] !== m)) throw new Error('NavGrid binary: bad magic (not a PPNV buffer)');
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const format = dv.getUint32(4, true), jsonLen = dv.getUint32(8, true);
  if (format !== NAV_FORMAT) throw new Error(`NavGrid binary: format ${format}, expected ${NAV_FORMAT}`);
  if (12 + jsonLen > bytes.length) throw new Error('NavGrid binary: truncated header');
  const meta = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + jsonLen))) as { h?: unknown; links?: unknown };
  if (!isHeader(meta.h) || typeof meta.links !== 'number') throw new Error('NavGrid binary: malformed header');
  const h = meta.h, links = meta.links, cols = h.nx * h.nz, n = h.spanCount;
  const sizes = [cols, n * 2, n, n, n, n * 2, links * 4];
  let r = 12 + pad4(jsonLen);
  const need = r + sizes.reduce((s, k) => s + pad4(k), 0);
  if (bytes.length < need) throw new Error(`NavGrid binary: truncated (${bytes.length} of ${need} bytes)`);
  const take = (k: number): ArrayBuffer => { const b = bytes.slice(r, r + k).buffer; r += pad4(k); return b; };
  const counts = new Uint8Array(take(sizes[0]!));
  const y = deltaDecode(new Int16Array(take(sizes[1]!)));
  const clear = deltaDecode(new Uint8Array(take(sizes[2]!)));
  const slope = deltaDecode(new Uint8Array(take(sizes[3]!)));
  const wall = deltaDecode(new Uint8Array(take(sizes[4]!)));
  const comp = deltaDecode(new Uint16Array(take(sizes[5]!)));
  const pairs = new Uint16Array(take(sizes[6]!));
  const colStart = new Uint32Array(cols + 1);
  for (let c = 0; c < cols; c++) colStart[c + 1] = colStart[c]! + counts[c]!;
  // pairs are sorted by `from`: count per component, then prefix-sum into the CSR
  const linkStart = new Uint32Array(h.componentCount + 2), linkTo = new Uint16Array(links);
  let prev = 0;
  for (let i = 0; i < links; i++) {
    const a = pairs[i * 2]!;
    if (a > h.componentCount || a < prev) throw new Error('NavGrid binary: malformed component links');
    prev = a;
    linkStart[a + 1] = linkStart[a + 1]! + 1;
    linkTo[i] = pairs[i * 2 + 1]!;
  }
  for (let a = 0; a <= h.componentCount; a++) linkStart[a + 1] = linkStart[a + 1]! + linkStart[a]!;
  return new NavGridData(h, { colStart, y, clear, slope, wall, comp, linkStart, linkTo });
}
