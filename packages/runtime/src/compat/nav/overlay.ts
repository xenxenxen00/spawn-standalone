// The per-query dynamic overlay of `findPath` (motion §7.4 item 9; WP NV2): the bodies the baked grid does not hold. The bake
// takes immutable static rows only (nav/bake.ts); doors, teacups, supply terminals and every other mutable or kinematic row
// are blocked here, per query, from where they stand NOW.
//
//   bodies 'static'   stamps static rows that are solid now and are not in the grid (a supply terminal while it stands, a
//                     static row spawned at run time)
//   bodies 'all'      stamps kinematic rows too (closed doors, the teacups)
//   never stamped     characters, dynamic bodies, sensors, bodies switched off (`physics: "none"`, spectating), rows named in
//                     `ignore` and their `/` children (the id rule of physics/query.ts), rows the grid already holds
//
// The source is plain data: `OverlayBody` is what the physics port's `bodyRecords(place)` answers (physics/rapier/body-sync.ts
// `BodyRecord`, structurally), so nothing here touches Rapier and `findPath` and the nav audit run without the wasm. A body's
// parts are key shapes with their instance matrix at the baked pose; a row that moved since (a door that swung, a terminal
// that was repositioned) is carried by the rigid motion `row now ∘ (row baked)⁻¹`, the rule body-sync.ts seats colliders by.
//
// A footprint is the part's local bounding box under that matrix: an oriented rectangle in xz while the part stands upright
// (every door and terminal: a door at 45° blocks its leaf, not the square around it), else the world AABB of its corners.
// A span is blocked when its cell centre lies inside the footprint grown by the agent's radius (the clearance `wall ≥ radius`
// gives baked geometry) and the body overlaps the agent's height above the span's floor (a body no higher than the agent's
// step, or wholly above its head, blocks nothing).
import type { Quat, Vec3 } from '../core/types.ts';
import { NAV_CELL, Y_UNIT, type AgentParams, type NavGridData } from './navgrid.ts';

export type OverlayBodyKind = 'static' | 'kinematic' | 'dynamic' | 'character';

/** a collider key as the pack holds it: `box` full size standing on the origin, `sphere` centred at (0, r, 0), `tris` local */
export interface OverlayShape {
  readonly tris?: ArrayLike<number> | undefined;
  readonly box?: readonly [number, number, number] | undefined;
  readonly sphere?: number | undefined;
}

/** one body of a place as plain data (the physics port's `BodyRecord`) */
export interface OverlayBody {
  readonly rowId: string;
  readonly kind: OverlayBodyKind;
  /** colliding now (not spectating, not switched to "none") */
  readonly enabled: boolean;
  readonly sensor: boolean;
  /** the row's world origin and rotation now */
  readonly pos: Readonly<Vec3>;
  readonly rot: Readonly<Quat>;
  /** key shapes with their 3×4 column-major instance matrices at the baked pose */
  readonly parts?: ReadonlyArray<{ readonly shape: OverlayShape; readonly m: ArrayLike<number> }> | undefined;
  /** the pose the parts' matrices were taken at; absent = the matrices are current */
  readonly baked?: { readonly pos: Readonly<Vec3>; readonly rot: Readonly<Quat> } | undefined;
}

export interface OverlayOptions {
  bodies: 'all' | 'static';
  ignore: readonly string[];
  /** true for a row the baked grid already holds (an immutable static row of the pack): never stamped twice */
  inGrid?: ((rowId: string) => boolean) | undefined;
}

/** xz footprint of one part with its vertical extent (world metres) */
export interface Footprint {
  rowId: string;
  /** centre */
  cx: number; cz: number;
  /** unit axes of the rectangle in xz and its half extents along them */
  ux: number; uz: number; vx: number; vz: number;
  hu: number; hv: number;
  yMin: number; yMax: number;
  /** a circle of radius `hu` instead of a rectangle (an upright sphere key) */
  round: boolean;
}

/** the id rule of physics/query.ts: an ignore id names the row and its `/` children */
export function ignoredId(id: string, ignore: readonly string[]): boolean {
  for (const ig of ignore) {
    if (id === ig) return true;
    if (id.length > ig.length && id.charCodeAt(ig.length) === 47 /* '/' */ && id.startsWith(ig)) return true;
  }
  return false;
}

/** rows of a pack the baked grid holds: the instances neither mutable nor kinematic (nav/bake.ts `soupParts`) */
export function gridRowIds(pack: { instances: ReadonlyArray<{ rowId: string; mutable: boolean; kinematic: boolean }> }): Set<string> {
  const out = new Set<string>();
  for (const i of pack.instances) if (!i.mutable && !i.kinematic) out.add(i.rowId);
  return out;
}

/** local bounds [minX, minY, minZ, maxX, maxY, maxZ] of a key shape; triangle soups are measured once per array */
const TRI_BOUNDS = new WeakMap<object, Float64Array>();
function localBounds(shape: OverlayShape): Float64Array | null {
  if (shape.box) {
    const [w, h, d] = shape.box;
    return new Float64Array([-w / 2, 0, -d / 2, w / 2, h, d / 2]);
  }
  if (typeof shape.sphere === 'number') {
    const r = shape.sphere;
    return new Float64Array([-r, 0, -r, r, 2 * r, r]);
  }
  const t = shape.tris;
  if (!t || t.length < 9) return null;
  let b = TRI_BOUNDS.get(t as object);
  if (b) return b;
  b = new Float64Array([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
  for (let i = 0; i + 2 < t.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = t[i + a]!;
      if (v < b[a]!) b[a] = v;
      if (v > b[a + 3]!) b[a + 3] = v;
    }
  }
  TRI_BOUNDS.set(t as object, b);
  return b;
}

function rotate(q: Readonly<Quat>, x: number, y: number, z: number, o: Float64Array, at: number): void {
  const tx = 2 * (q.y * z - q.z * y), ty = 2 * (q.z * x - q.x * z), tz = 2 * (q.x * y - q.y * x);
  o[at] = x + q.w * tx + (q.y * tz - q.z * ty);
  o[at + 1] = y + q.w * ty + (q.z * tx - q.x * tz);
  o[at + 2] = z + q.w * tz + (q.x * ty - q.y * tx);
}

const same4 = (a: Readonly<Quat>, b: Readonly<Quat>): boolean => a.x === b.x && a.y === b.y && a.z === b.z && a.w === b.w;
const same3 = (a: Readonly<Vec3>, b: Readonly<Vec3>): boolean => a.x === b.x && a.y === b.y && a.z === b.z;

/** the part's instance matrix now: `row now ∘ (row baked)⁻¹ ∘ m` (rigid; the row's scale is in `m` and is not animated) */
function currentMatrix(body: OverlayBody, m: ArrayLike<number>, out: Float64Array): Float64Array {
  const bk = body.baked;
  if (!bk || (same3(bk.pos, body.pos) && same4(bk.rot, body.rot))) {
    for (let i = 0; i < 12; i++) out[i] = m[i]!;
    return out;
  }
  const inv: Quat = { x: -bk.rot.x, y: -bk.rot.y, z: -bk.rot.z, w: bk.rot.w };
  for (let c = 0; c < 4; c++) {
    let x = m[c * 3]!, y = m[c * 3 + 1]!, z = m[c * 3 + 2]!;
    if (c === 3) { x -= bk.pos.x; y -= bk.pos.y; z -= bk.pos.z; }
    rotate(inv, x, y, z, out, c * 3);
    rotate(body.rot, out[c * 3]!, out[c * 3 + 1]!, out[c * 3 + 2]!, out, c * 3);
    if (c === 3) { out[9] = out[9]! + body.pos.x; out[10] = out[10]! + body.pos.y; out[11] = out[11]! + body.pos.z; }
  }
  return out;
}

/** a part stands upright when its local Y axis leans less than about 6° (sin 0.1) */
const UPRIGHT_SIN = 0.1;
const M = new Float64Array(12);

function footprintOf(rowId: string, shape: OverlayShape, m: ArrayLike<number>): Footprint | null {
  const b = localBounds(shape);
  if (!b) return null;
  for (let i = 0; i < 12; i++) if (!Number.isFinite(m[i]!)) return null;
  const lx = (b[0]! + b[3]!) / 2, lz = (b[2]! + b[5]!) / 2, hx = (b[3]! - b[0]!) / 2, hz = (b[5]! - b[2]!) / 2;
  const yl = Math.hypot(m[3]!, m[4]!, m[5]!);
  const upright = yl > 0 && Math.hypot(m[3]!, m[5]!) <= UPRIGHT_SIN * yl && Math.abs(m[1]!) <= UPRIGHT_SIN * Math.hypot(m[0]!, m[1]!, m[2]!)
    && Math.abs(m[7]!) <= UPRIGHT_SIN * Math.hypot(m[6]!, m[7]!, m[8]!);
  // world y range over the 8 corners
  let yMin = Infinity, yMax = -Infinity, x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (let c = 0; c < 8; c++) {
    const x = c & 1 ? b[3]! : b[0]!, y = c & 2 ? b[4]! : b[1]!, z = c & 4 ? b[5]! : b[2]!;
    const wx = m[0]! * x + m[3]! * y + m[6]! * z + m[9]!, wy = m[1]! * x + m[4]! * y + m[7]! * z + m[10]!, wz = m[2]! * x + m[5]! * y + m[8]! * z + m[11]!;
    if (wy < yMin) yMin = wy;
    if (wy > yMax) yMax = wy;
    if (wx < x0) x0 = wx;
    if (wx > x1) x1 = wx;
    if (wz < z0) z0 = wz;
    if (wz > z1) z1 = wz;
  }
  if (upright) {
    const ul = Math.hypot(m[0]!, m[2]!), vl = Math.hypot(m[6]!, m[8]!);
    if (ul > 0 && vl > 0) {
      const yc = (b[1]! + b[4]!) / 2;
      return {
        rowId,
        cx: m[0]! * lx + m[3]! * yc + m[6]! * lz + m[9]!, cz: m[2]! * lx + m[5]! * yc + m[8]! * lz + m[11]!,
        ux: m[0]! / ul, uz: m[2]! / ul, vx: m[6]! / vl, vz: m[8]! / vl, hu: hx * ul, hv: hz * vl,
        yMin, yMax, round: typeof shape.sphere === 'number' && !shape.box,
      };
    }
  }
  return { rowId, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2, ux: 1, uz: 0, vx: 0, vz: 1, hu: (x1 - x0) / 2, hv: (z1 - z0) / 2, yMin, yMax, round: false };
}

/** the footprints a query stamps, in the order of `bodies` (the port's creation order: deterministic) */
export function overlayFootprints(bodies: readonly OverlayBody[], o: OverlayOptions): Footprint[] {
  const out: Footprint[] = [];
  for (const body of bodies) {
    if (!body.enabled || body.sensor) continue;
    if (body.kind !== 'static' && !(body.kind === 'kinematic' && o.bodies === 'all')) continue;
    if (!body.parts || body.parts.length === 0) continue;
    if (ignoredId(body.rowId, o.ignore)) continue;
    if (body.kind === 'static' && o.inGrid?.(body.rowId)) continue;
    for (const part of body.parts) {
      const f = footprintOf(body.rowId, part.shape, currentMatrix(body, part.m, M));
      if (f) out.push(f);
    }
  }
  return out;
}

/**
 * The blocked spans of one query on one grid: a byte per span, set by `stamp` and cleared span by span when the next query
 * begins (so a query costs what it stamps, not the grid).
 */
export class OverlayStamps {
  private readonly grid: NavGridData;
  private readonly mark: Uint8Array;
  private touched: Int32Array = new Int32Array(256);
  private n = 0;

  constructor(grid: NavGridData) {
    this.grid = grid;
    this.mark = new Uint8Array(grid.h.spanCount);
  }

  /** spans stamped by the query in progress */
  get count(): number { return this.n; }

  /** a new query: nothing is blocked */
  begin(): void {
    const t = this.touched, mark = this.mark;
    for (let i = 0; i < this.n; i++) mark[t[i]!] = 0;
    this.n = 0;
  }

  blocked(s: number): boolean { return this.mark[s] === 1; }

  /** blocks the spans under the footprints for an agent of the given radius, height and step */
  stamp(prints: readonly Footprint[], agent: Readonly<Pick<AgentParams, 'radius' | 'height' | 'step'>>): void {
    const g = this.grid, r = Math.max(0, agent.radius);
    for (const f of prints) {
      const hu = f.hu + r, hv = f.round ? hu : f.hv + r;
      // the rectangle's world bounds in cells
      const ex = Math.abs(f.ux) * hu + Math.abs(f.vx) * hv, ez = Math.abs(f.uz) * hu + Math.abs(f.vz) * hv;
      const ix0 = Math.max(0, g.cellIndexX(f.cx - ex)), ix1 = Math.min(g.h.nx - 1, g.cellIndexX(f.cx + ex));
      const iz0 = Math.max(0, g.cellIndexZ(f.cz - ez)), iz1 = Math.min(g.h.nz - 1, g.cellIndexZ(f.cz + ez));
      const lo = (f.yMin - agent.height) / Y_UNIT, hi = (f.yMax - agent.step) / Y_UNIT;
      for (let iz = iz0; iz <= iz1; iz++) {
        const dz = g.h.originZ + (iz + 0.5) * NAV_CELL - f.cz;
        for (let ix = ix0; ix <= ix1; ix++) {
          const dx = g.h.originX + (ix + 0.5) * NAV_CELL - f.cx;
          if (f.round) { if (dx * dx + dz * dz > hu * hu) continue; }
          else if (Math.abs(dx * f.ux + dz * f.uz) > hu || Math.abs(dx * f.vx + dz * f.vz) > hv) continue;
          const c = iz * g.h.nx + ix;
          for (let s = g.colStart[c]!, e = g.colStart[c + 1]!; s < e; s++) {
            const y = g.y[s]!;
            // the body reaches above what the agent steps over and starts below its head
            if (y >= hi || y <= lo || this.mark[s] === 1) continue;
            this.mark[s] = 1;
            if (this.n === this.touched.length) { const t = new Int32Array(this.n * 2); t.set(this.touched); this.touched = t; }
            this.touched[this.n++] = s;
          }
        }
      }
    }
  }
}
