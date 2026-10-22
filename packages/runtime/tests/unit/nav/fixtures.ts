// Fixture collider packs for the nav tests (motion §7.7): small hand-built places whose nav grids can be computed by hand.
// Boxes follow the ColliderPack convention of render's packer (`pack.ts` PackedCollider): a `box` key is the full size
// [w, h, d] standing on the origin, so an instance at translation (cx, y0, cz) occupies x ∈ cx ± w/2, y ∈ [y0, y0 + h].
import type { ColliderPack } from '../../../src/compat/core/ports.ts';

export type V3t = [number, number, number];

/** 3×4 column-major [X, Y, Z, translation] (physics math.ts convention) */
export function m34(t: V3t, yaw = 0): Float32Array {
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return new Float32Array([c, 0, -s, 0, 1, 0, s, 0, c, t[0], t[1], t[2]]);
}

export interface InstanceFlags { mutable?: boolean; kinematic?: boolean; noDecal?: boolean; rowId?: string }

export class PackBuilder {
  readonly pack: ColliderPack;
  private n = 0;
  constructor(place = 'fixture') {
    this.pack = { place, keys: [], instances: [], runtimeKeys: [] };
  }
  private add(key: ColliderPack['keys'][number], m: Float32Array, f: InstanceFlags): this {
    this.pack.keys.push(key);
    this.pack.instances.push({
      rowId: f.rowId ?? `row-${this.n++}`,
      key: this.pack.keys.length - 1,
      m,
      mutable: f.mutable ?? false,
      kinematic: f.kinematic ?? false,
      noDecal: f.noDecal ?? false,
    });
    return this;
  }
  /** axis-aligned box from min to max corner (world) */
  box(min: V3t, max: V3t, f: InstanceFlags = {}): this {
    const size: V3t = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
    return this.add({ id: `box-${this.pack.keys.length}`, box: size }, m34([(min[0] + max[0]) / 2, min[1], (min[2] + max[2]) / 2]), f);
  }
  /** local triangles placed with a 3×4 transform */
  tris(tris: Float32Array, m: Float32Array, f: InstanceFlags = {}): this {
    return this.add({ id: `tris-${this.pack.keys.length}`, tris }, m, f);
  }
  sphere(r: number, at: V3t, f: InstanceFlags = {}): this {
    return this.add({ id: `sphere-${this.pack.keys.length}`, sphere: r }, m34(at), f);
  }
  terrain(tris: Float32Array): this {
    this.pack.terrain = { tris, id: `terrain/${this.pack.place}` };
    return this;
  }
}

/** a floor slab 0.2 thick with its top at y = 0 over [x0, x1] × [z0, z1] */
export function floor(b: PackBuilder, x0: number, z0: number, x1: number, z1: number, top = 0): PackBuilder {
  return b.box([x0, top - 0.2, z0], [x1, top, z1]);
}

/**
 * Box room: floor top y = 0 over [0, 8]², four 0.25 m thick walls 3 m high along the edges.
 * Grid: origin (0, 0), 32 × 32 columns, one span each; interior columns 1..30 at y 0, the ring of wall columns at y 3.
 */
export function boxRoom(): ColliderPack {
  const b = new PackBuilder('box-room');
  floor(b, 0, 0, 8, 8);
  b.box([0, 0, 0], [0.25, 3, 8]);
  b.box([7.75, 0, 0], [8, 3, 8]);
  b.box([0.25, 0, 0], [7.75, 3, 0.25]);
  b.box([0.25, 0, 7.75], [7.75, 3, 8]);
  return b.pack;
}

/**
 * Two rooms over [0, 8] × [0, 8] split by a wall x ∈ [4, 4.25] with a doorway z ∈ [dz0, dz1] (no outer walls: the grid edge is
 * the boundary wall).
 */
export function doorwayRooms(dz0: number, dz1: number): ColliderPack {
  const b = new PackBuilder('doorway');
  floor(b, 0, 0, 8, 8);
  b.box([4, 0, 0], [4.25, 3, dz0]);
  b.box([4, 0, dz1], [4.25, 3, 8]);
  return b.pack;
}

/**
 * Two-level catwalk: ground floor top y = 0 over [0, 8]²; a catwalk slab y ∈ [2.8, 3.0] over x ∈ [2, 6], z ∈ [3.25, 4.75]
 * whose ends abut two towers (x ∈ [1, 2] and [6, 7], same z, 4 m high).
 */
export function catwalk(): ColliderPack {
  const b = new PackBuilder('catwalk');
  floor(b, 0, 0, 8, 8);
  b.box([2, 2.8, 3.25], [6, 3.0, 4.75]);
  b.box([1, 0, 3.25], [2, 4, 4.75]);
  b.box([6, 0, 3.25], [7, 4, 4.75]);
  return b.pack;
}

// ── NV2: fixtures of the search, smoothing, overlay and horizon tests ───────────────────────────────────────────────────

/** A straight corridor: floor top y = 0 over [0, len] × [0, width]; the grid edge is its wall. */
export function corridor(len: number, width = 2): ColliderPack {
  return floor(new PackBuilder('corridor'), 0, 0, len, width).pack;
}

/** An L-corridor 2 m wide: [0, 8] × [0, 2] and [6, 8] × [2, 8]; the inner corner is at (6, 2). */
export function lCorridor(): ColliderPack {
  const b = new PackBuilder('l-corridor');
  floor(b, 0, 0, 8, 2);
  floor(b, 6, 2, 8, 8);
  return b.pack;
}

/** A solid block with its top at `top` over x ∈ [0, 4] beside a floor at y = 0 over x ∈ [4, 8]; both 4 m deep in z. */
export function ledge(top: number): ColliderPack {
  const b = new PackBuilder('ledge');
  floor(b, 0, 0, 8, 4);
  b.box([0, 0, 0], [4, top, 4]);
  return b.pack;
}

/**
 * A ramp of the given angle: floor y = 0 over x ∈ [0, 4], a closed wedge rising 2 m from x = 4, then a block with its top at
 * y = 2 for another 4 m; 2 m deep in z. Returns the pack and the x where the top begins.
 */
export function ramp(deg: number): { pack: ColliderPack; topX: number } {
  const b = new PackBuilder('ramp');
  floor(b, 0, 0, 4, 2);
  const x0 = 4, x1 = 4 + 2 / Math.tan((deg * Math.PI) / 180);
  const t: number[] = [];
  const quad = (p: V3t, q: V3t, r: V3t, s: V3t): void => { t.push(...p, ...q, ...r, ...p, ...r, ...s); };
  const p0: V3t = [x0, 0, 0], p1: V3t = [x0, 0, 2], p2: V3t = [x1, 0, 2], p3: V3t = [x1, 0, 0], p4: V3t = [x1, 2, 0], p5: V3t = [x1, 2, 2];
  quad(p0, p1, p5, p4); // the slope
  quad(p0, p3, p2, p1); // bottom
  quad(p3, p4, p5, p2); // back
  t.push(...p0, ...p4, ...p3, ...p1, ...p2, ...p5); // sides
  b.tris(Float32Array.from(t), m34([0, 0, 0]));
  b.box([x1, 0, 0], [x1 + 4, 2, 2]);
  return { pack: b.pack, topX: x1 };
}
