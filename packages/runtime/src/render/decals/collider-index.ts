import { primitiveShape, type PrimitiveSpec } from '../geometry/primitives.ts';
import type { ColliderPack } from '../../compat/core/ports.ts';

type Vec3 = readonly [number, number, number];
interface Triangle {
  id: number;
  instanceId: string;
  a: Vec3;
  b: Vec3;
  c: Vec3;
  normal: Vec3;
  min: Vec3;
  max: Vec3;
}

const CELL_SIZE = 2;
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normalize = (v: Vec3): Vec3 | null => {
  const length = Math.hypot(...v);
  return length > 1e-9 ? [v[0] / length, v[1] / length, v[2] / length] : null;
};
const cellKey = (x: number, y: number, z: number): string => `${x},${y},${z}`;
const at = (vertices: Float32Array, offset: number): Vec3 => [vertices[offset]!, vertices[offset + 1]!, vertices[offset + 2]!];
const transformed = (p: Vec3, m: ArrayLike<number>, scale: Vec3 = [1, 1, 1]): Vec3 => {
  const x = p[0] * scale[0], y = p[1] * scale[1], z = p[2] * scale[2];
  return [m[0]! * x + m[3]! * y + m[6]! * z + m[9]!, m[1]! * x + m[4]! * y + m[7]! * z + m[10]!, m[2]! * x + m[5]! * y + m[8]! * z + m[11]!];
};

export interface RayHit {
  instanceId: string;
  point: Vec3;
  normal: Vec3;
  distance: number;
}

export class ColliderIndex {
  readonly #cells = new Map<string, number[]>();
  readonly #triangles: Triangle[] = [];
  get triangleCount(): number { return this.#triangles.length; }

  addWorldTriangles(instanceId: string, positions: Float32Array): number {
    const start = this.#triangles.length;
    for (let i = 0; i + 8 < positions.length; i += 9) this.#insert(instanceId, at(positions, i), at(positions, i + 3), at(positions, i + 6));
    return this.#triangles.length - start;
  }

  queryAabb(min: Vec3, max: Vec3): Triangle[] {
    const found = new Set<number>();
    for (let x = Math.floor(min[0] / CELL_SIZE); x <= Math.floor(max[0] / CELL_SIZE); x++) {
      for (let y = Math.floor(min[1] / CELL_SIZE); y <= Math.floor(max[1] / CELL_SIZE); y++) {
        for (let z = Math.floor(min[2] / CELL_SIZE); z <= Math.floor(max[2] / CELL_SIZE); z++) {
          for (const i of this.#cells.get(cellKey(x, y, z)) ?? []) found.add(i);
        }
      }
    }
    return [...found].map((i) => this.#triangles[i]!);
  }

  raycast(origin: Vec3, direction: Vec3, maxDistance: number): RayHit | null {
    const d = normalize(direction);
    if (!d || !Number.isFinite(maxDistance) || maxDistance < 0) return null;
    const end: Vec3 = [origin[0] + d[0] * maxDistance, origin[1] + d[1] * maxDistance, origin[2] + d[2] * maxDistance];
    const min: Vec3 = [Math.min(origin[0], end[0]), Math.min(origin[1], end[1]), Math.min(origin[2], end[2])];
    const max: Vec3 = [Math.max(origin[0], end[0]), Math.max(origin[1], end[1]), Math.max(origin[2], end[2])];
    let best: RayHit | null = null;
    for (const tri of this.queryAabb(min, max)) {
      const e1: Vec3 = [tri.b[0] - tri.a[0], tri.b[1] - tri.a[1], tri.b[2] - tri.a[2]];
      const e2: Vec3 = [tri.c[0] - tri.a[0], tri.c[1] - tri.a[1], tri.c[2] - tri.a[2]];
      const p = cross(d, e2);
      const det = dot(e1, p);
      if (Math.abs(det) < 1e-9) continue;
      const inv = 1 / det;
      const tvec: Vec3 = [origin[0] - tri.a[0], origin[1] - tri.a[1], origin[2] - tri.a[2]];
      const u = dot(tvec, p) * inv;
      if (u < -1e-8 || u > 1 + 1e-8) continue;
      const q = cross(tvec, e1);
      const v = dot(d, q) * inv;
      if (v < -1e-8 || u + v > 1 + 1e-8) continue;
      const distance = dot(e2, q) * inv;
      if (distance < -1e-8 || distance > maxDistance || (best && distance >= best.distance)) continue;
      best = { instanceId: tri.instanceId, point: [origin[0] + d[0] * distance, origin[1] + d[1] * distance, origin[2] + d[2] * distance], normal: tri.normal, distance };
    }
    return best;
  }

  /** @internal */
  trianglesIn(min: Vec3, max: Vec3): readonly Triangle[] { return this.queryAabb(min, max); }

  #insert(instanceId: string, a: Vec3, b: Vec3, c: Vec3): void {
    if (![...a, ...b, ...c].every(Number.isFinite)) return;
    const normal = normalize(cross([b[0] - a[0], b[1] - a[1], b[2] - a[2]], [c[0] - a[0], c[1] - a[1], c[2] - a[2]]));
    if (!normal) return;
    const min: Vec3 = [Math.min(a[0], b[0], c[0]), Math.min(a[1], b[1], c[1]), Math.min(a[2], b[2], c[2])];
    const max: Vec3 = [Math.max(a[0], b[0], c[0]), Math.max(a[1], b[1], c[1]), Math.max(a[2], b[2], c[2])];
    const id = this.#triangles.push({ id: this.#triangles.length, instanceId, a, b, c, normal, min, max }) - 1;
    for (let x = Math.floor(min[0] / CELL_SIZE); x <= Math.floor(max[0] / CELL_SIZE); x++) {
      for (let y = Math.floor(min[1] / CELL_SIZE); y <= Math.floor(max[1] / CELL_SIZE); y++) {
        for (let z = Math.floor(min[2] / CELL_SIZE); z <= Math.floor(max[2] / CELL_SIZE); z++) {
          const key = cellKey(x, y, z);
          let cell = this.#cells.get(key);
          if (!cell) this.#cells.set(key, cell = []);
          cell.push(id);
        }
      }
    }
  }
}

export function buildColliderIndex(pack: ColliderPack, tagsOf: (rowId: string) => readonly string[] = () => [], ignoredTags: readonly string[] = []): ColliderIndex {
  const index = new ColliderIndex();
  for (const instance of pack.instances) {
    if (instance.mutable || instance.kinematic || instance.noDecal || tagsOf(instance.rowId).some((tag) => ignoredTags.includes(tag))) continue;
    const key = pack.keys[instance.key];
    if (!key) throw new Error(`decal ${pack.place}: instance ${instance.rowId} names collider key ${instance.key}, pack has ${pack.keys.length}`);
    if (key.tris) {
      const points = new Float32Array(key.tris.length);
      for (let i = 0; i + 2 < points.length; i += 3) {
        const p = transformed([key.tris[i]!, key.tris[i + 1]!, key.tris[i + 2]!], instance.m);
        points.set(p, i);
      }
      index.addWorldTriangles(instance.rowId, points);
      continue;
    }
    const primitive: PrimitiveSpec = key.box
      ? { kind: 'box', width: key.box[0], height: key.box[1], depth: key.box[2] }
      : key.sphere !== undefined ? { kind: 'sphere', radius: key.sphere } : (() => { throw new Error(`decal ${pack.place}: collider key ${key.id} has no triangles or shape`); })();
    const shape = primitiveShape(primitive);
    const geometry = shape.create();
    const position = geometry.getAttribute('position');
    const indices = geometry.getIndex();
    const count = indices?.count ?? position.count;
    const points = new Float32Array(Math.floor(count / 3) * 9);
    let at = 0;
    for (let i = 0; i + 2 < count; i += 3) {
      const ia = indices?.getX(i) ?? i, ib = indices?.getX(i + 1) ?? i + 1, ic = indices?.getX(i + 2) ?? i + 2;
      const a = transformed([position.getX(ia), position.getY(ia), position.getZ(ia)], instance.m, shape.scale);
      const b = transformed([position.getX(ib), position.getY(ib), position.getZ(ib)], instance.m, shape.scale);
      const c = transformed([position.getX(ic), position.getY(ic), position.getZ(ic)], instance.m, shape.scale);
      points.set([...a, ...b, ...c], at);
      at += 9;
    }
    index.addWorldTriangles(instance.rowId, points);
    geometry.dispose();
  }
  if (pack.terrain) index.addWorldTriangles(pack.terrain.id, pack.terrain.tris);
  return index;
}
