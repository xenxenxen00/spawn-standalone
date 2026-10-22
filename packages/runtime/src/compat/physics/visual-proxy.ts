// The visual-proxy layer of `hits:'both'` (motion §6.2, X-42): render-only static geometry (rows without `physics`: tree
// crowns, hung corpses) as a two-level BVH. Level 1 is one PH1 `StaticBvh` per key over its LOD-5 hull (local space, shared
// by every instance of the key); level 2 is an AABB tree over the instances (`shapes.ts` mesh instances). The proxies never
// enter the Rapier world, so they cost the controller and the solver nothing; a query merges their hit with Rapier's by
// distance (rapier/query.ts).
//
// Built lazily: `setVisualProxies` only keeps the soup, the trees are made by the first query that asks for candidates.
// The layer is a PH1 `QueryLayer`, so PH1's `castRay` / `castRayAll` run every option (ray, sphere cast, ignore ids, tag
// filters) over it unchanged; `proxyWorld` wraps it as the `QueryWorld` those functions take.
import type { VisualProxySoup } from '../core/ports.ts';
import { StaticBvh } from './bvh.ts';
import { v3, type V3 } from './math.ts';
import type { QueryBody, QueryLayer, QueryWorld } from './query.ts';
import { meshShape, shapeAabb } from './shapes.ts';

const NO_TAGS: readonly string[] = [];
const LEAF = 4;

/** 4×4 column-major world matrix (three.js `Matrix4.elements`) → the 3×4 the shapes use */
function m34Of(m: ArrayLike<number>): Float64Array {
  return new Float64Array([m[0]!, m[1]!, m[2]!, m[4]!, m[5]!, m[6]!, m[8]!, m[9]!, m[10]!, m[12]!, m[13]!, m[14]!]);
}

export class VisualProxyLayer implements QueryLayer {
  private soup: VisualProxySoup | null;
  private readonly tagsOf: (rowId: string) => readonly string[];
  private bodies: QueryBody[] = [];
  /** per body: min x, y, z, max x, y, z */
  private boxes = new Float64Array(0);
  /** the tree, 8 numbers per node: bounds (6), then the left child and -(right child + 2), or for a leaf -(first + 1) and the count */
  private nodes: number[] = [];
  /** body indices in tree order */
  private order = new Uint32Array(0);
  private isBuilt = false;
  private stack: number[] = [];
  /** keys of the soup that had no usable triangles, and instances naming a key the soup does not hold */
  skipped = 0;

  constructor(soup: VisualProxySoup, tagsOf: (rowId: string) => readonly string[] = () => NO_TAGS) {
    this.soup = soup;
    this.tagsOf = tagsOf;
  }

  /** false until the first query built the trees */
  get built(): boolean { return this.isBuilt; }
  /** instances in the layer (after the build: those that got a shape) */
  get size(): number { return this.isBuilt ? this.bodies.length : (this.soup?.instances.length ?? 0); }

  build(): void {
    if (this.isBuilt) return;
    this.isBuilt = true;
    const soup = this.soup;
    this.soup = null;
    if (!soup) return;
    const bvhs = new Map<string, StaticBvh | null>();
    for (const k of soup.keys) {
      const n = Math.floor(k.tris.length / 9) * 9;
      bvhs.set(k.key, n >= 9 ? StaticBvh.build(n === k.tris.length ? k.tris : k.tris.subarray(0, n)) : null);
    }
    const bodies: QueryBody[] = [];
    for (const inst of soup.instances) {
      const bvh = bvhs.get(inst.key);
      if (!bvh || inst.m.length < 16) { this.skipped++; continue; }
      const m = m34Of(inst.m);
      let finite = true;
      for (let i = 0; i < 12; i++) if (!Number.isFinite(m[i]!)) finite = false;
      if (!finite) { this.skipped++; continue; }
      bodies.push({ rowId: inst.rowId, kind: 'static', sensor: false, active: true, shape: meshShape(bvh, m), tags: this.tagsOf(inst.rowId) });
    }
    this.bodies = bodies;
    const boxes = new Float64Array(bodies.length * 6);
    const min = v3(), max = v3();
    bodies.forEach((b, i) => {
      shapeAabb(b.shape, min, max);
      boxes.set([min[0]!, min[1]!, min[2]!, max[0]!, max[1]!, max[2]!], i * 6);
    });
    this.boxes = boxes;
    this.order = new Uint32Array(bodies.length);
    for (let i = 0; i < bodies.length; i++) this.order[i] = i;
    this.nodes = [];
    if (bodies.length > 0) this.split(0, bodies.length);
  }

  /** median split on the longest axis of the centres; returns the node index */
  private split(first: number, count: number): number {
    const { boxes, order, nodes } = this;
    const at = nodes.length;
    let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    let cx0 = Infinity, cy0 = Infinity, cz0 = Infinity, cx1 = -Infinity, cy1 = -Infinity, cz1 = -Infinity;
    for (let i = first; i < first + count; i++) {
      const o = order[i]! * 6;
      x0 = Math.min(x0, boxes[o]!); y0 = Math.min(y0, boxes[o + 1]!); z0 = Math.min(z0, boxes[o + 2]!);
      x1 = Math.max(x1, boxes[o + 3]!); y1 = Math.max(y1, boxes[o + 4]!); z1 = Math.max(z1, boxes[o + 5]!);
      const cx = boxes[o]! + boxes[o + 3]!, cy = boxes[o + 1]! + boxes[o + 4]!, cz = boxes[o + 2]! + boxes[o + 5]!;
      cx0 = Math.min(cx0, cx); cy0 = Math.min(cy0, cy); cz0 = Math.min(cz0, cz);
      cx1 = Math.max(cx1, cx); cy1 = Math.max(cy1, cy); cz1 = Math.max(cz1, cz);
    }
    nodes.push(x0, y0, z0, x1, y1, z1, 0, 0);
    const ex = cx1 - cx0, ey = cy1 - cy0, ez = cz1 - cz0;
    if (count <= LEAF || !(Math.max(ex, ey, ez) > 0)) {
      nodes[at + 6] = -(first + 1);
      nodes[at + 7] = count;
      return at;
    }
    const axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2;
    const part = Array.from(order.subarray(first, first + count)).sort((a, b) => (boxes[a * 6 + axis]! + boxes[a * 6 + 3 + axis]!) - (boxes[b * 6 + axis]! + boxes[b * 6 + 3 + axis]!) || a - b);
    order.set(part, first);
    const half = count >> 1;
    nodes[at + 6] = this.split(first, half);
    nodes[at + 7] = -1;
    // the right child follows the whole left subtree: its index is known only now
    const right = this.split(first + half, count - half);
    nodes[at + 7] = -(right + 2);
    return at;
  }

  candidates(min: V3, max: V3, out: QueryBody[]): number {
    out.length = 0;
    if (!this.isBuilt) this.build();
    const { nodes, order, boxes, bodies, stack } = this;
    if (nodes.length === 0) return 0;
    stack.length = 0;
    stack.push(0);
    while (stack.length > 0) {
      const n = stack.pop()!;
      if (nodes[n]! > max[0]! || nodes[n + 1]! > max[1]! || nodes[n + 2]! > max[2]! || nodes[n + 3]! < min[0]! || nodes[n + 4]! < min[1]! || nodes[n + 5]! < min[2]!) continue;
      const a = nodes[n + 6]!, b = nodes[n + 7]!;
      if (a < 0) {
        const first = -a - 1;
        for (let i = first; i < first + b; i++) {
          const k = order[i]!, o = k * 6;
          if (boxes[o]! > max[0]! || boxes[o + 1]! > max[1]! || boxes[o + 2]! > max[2]! || boxes[o + 3]! < min[0]! || boxes[o + 4]! < min[1]! || boxes[o + 5]! < min[2]!) continue;
          out.push(bodies[k]!);
        }
      } else {
        stack.push(a, -b - 2);
      }
    }
    return out.length;
  }
}

/**
 * A `QueryWorld` that holds nothing but a proxy layer: PH1's `castRay(world, {...q, both: true})` over it answers the nearest
 * qualifying proxy hit, `castRayAll` every one (the Rapier backend merges them with its own hits by distance).
 */
export function proxyWorld(place: string, layer: QueryLayer): QueryWorld {
  return {
    place,
    built: true,
    soup: null,
    ownerId: () => null,
    ownerTags: () => NO_TAGS,
    candidates: (_min, _max, out) => { out.length = 0; return 0; },
    visualProxies: () => layer,
  };
}
