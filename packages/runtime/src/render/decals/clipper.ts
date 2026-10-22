import { calibration } from '../calibration.ts';
import type { ColliderIndex } from './collider-index.ts';

export interface DecalSpec {
  position: readonly [number, number, number];
  normal: readonly [number, number, number];
  texture: string;
  size: number | readonly [number, number];
  rotation?: number;
  lifetime?: number;
  fade?: number;
  color?: string;
  opacity?: number;
  attachTo?: string;
}
export interface DecalTile {
  positions: Float32Array;
  uvs: Float32Array;
}
export interface ClippedDecal {
  tiles: DecalTile[];
  /** tiles dropped after reaching the minimum 0.5 m clip size */
  droppedTiles: number;
}
type V3 = readonly [number, number, number];
type Projector = { origin: V3; normal: V3; x: V3; y: V3; width: number; height: number; depth: number };
type P = { point: V3 };
type Region = { x0: number; x1: number; y0: number; y1: number };

const dot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const normalize = (a: V3): V3 | null => { const l = Math.hypot(...a); return l > 1e-8 ? [a[0] / l, a[1] / l, a[2] / l] : null; };

function projectorOf(spec: DecalSpec): Projector | null {
  const normal = normalize(spec.normal);
  const width = typeof spec.size === 'number' ? spec.size : spec.size[0];
  const height = typeof spec.size === 'number' ? spec.size : spec.size[1];
  if (!normal || !spec.position.every(Number.isFinite) || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const reference: V3 = Math.abs(normal[1]) < 0.95 ? [0, 1, 0] : [0, 0, 1];
  const x0 = normalize(cross(reference, normal));
  if (!x0) return null;
  const y0 = cross(normal, x0);
  const angle = ((Number.isFinite(spec.rotation) ? spec.rotation! : 0) * Math.PI) / 180;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const x = add(mul(x0, cos), mul(y0, sin));
  const y = add(mul(y0, cos), mul(x0, -sin));
  return { origin: spec.position, normal, x, y, width, height, depth: calibration.decalDepth };
}

function coords(projector: Projector, p: V3): readonly [number, number, number] {
  const d = sub(p, projector.origin);
  return [dot(d, projector.x), dot(d, projector.y), dot(d, projector.normal)];
}

function triangleNormal(a: V3, b: V3, c: V3): V3 | null { return normalize(cross(sub(b, a), sub(c, a))); }

function aabb(projector: Projector, region: Region): { min: V3; max: V3 } {
  const points: V3[] = [];
  for (const x of [region.x0, region.x1]) for (const y of [region.y0, region.y1]) for (const z of [-projector.depth, projector.depth]) {
    points.push(add(projector.origin, add(mul(projector.x, x), add(mul(projector.y, y), mul(projector.normal, z)))));
  }
  return {
    min: [Math.min(...points.map((p) => p[0])), Math.min(...points.map((p) => p[1])), Math.min(...points.map((p) => p[2]))],
    max: [Math.max(...points.map((p) => p[0])), Math.max(...points.map((p) => p[1])), Math.max(...points.map((p) => p[2]))],
  };
}

function coplanar(tri: { a: V3; b: V3; c: V3; normal: V3 }, seed: { point: V3; normal: V3 }): boolean {
  const cosine = dot(tri.normal, seed.normal);
  if (cosine < Math.cos((25 * Math.PI) / 180)) return false;
  return [tri.a, tri.b, tri.c].every((p) => Math.abs(dot(sub(p, seed.point), seed.normal)) <= 0.05 + 1e-7);
}

function clipPlane(poly: P[], distance: (p: V3) => number): P[] {
  if (poly.length === 0) return poly;
  const out: P[] = [];
  let prev = poly[poly.length - 1]!;
  let dp = distance(prev.point);
  for (const curr of poly) {
    const dc = distance(curr.point);
    const pin = dp >= -1e-7, cin = dc >= -1e-7;
    if (pin !== cin) {
      const t = dp / (dp - dc);
      out.push({ point: add(prev.point, mul(sub(curr.point, prev.point), t)) });
    }
    if (cin) out.push(curr);
    prev = curr;
    dp = dc;
  }
  return out;
}

function clipRegion(index: ColliderIndex, projector: Projector, seed: { instanceId: string; point: V3; normal: V3 }, region: Region): { tile: DecalTile | null; split: Region[] } {
  const box = aabb(projector, region);
  const candidates = index.trianglesIn(box.min, box.max);
  const positions: number[] = [], uvs: number[] = [];
  for (const tri of candidates) {
    if (tri.max[0] < box.min[0] || tri.min[0] > box.max[0] || tri.max[1] < box.min[1] || tri.min[1] > box.max[1] || tri.max[2] < box.min[2] || tri.min[2] > box.max[2]) continue;
    if (dot(tri.normal, projector.normal) <= 0 || (tri.instanceId !== seed.instanceId && !coplanar(tri, seed))) continue;
    let poly: P[] = [{ point: tri.a }, { point: tri.b }, { point: tri.c }];
    poly = clipPlane(poly, (p) => coords(projector, p)[0] - region.x0);
    poly = clipPlane(poly, (p) => region.x1 - coords(projector, p)[0]);
    poly = clipPlane(poly, (p) => coords(projector, p)[1] - region.y0);
    poly = clipPlane(poly, (p) => region.y1 - coords(projector, p)[1]);
    poly = clipPlane(poly, (p) => coords(projector, p)[2] + projector.depth);
    poly = clipPlane(poly, (p) => projector.depth - coords(projector, p)[2]);
    if (poly.length < 3) continue;
    const normal = triangleNormal(tri.a, tri.b, tri.c)!;
    for (let i = 1; i + 1 < poly.length; i++) {
      for (const vertex of [poly[0]!, poly[i]!, poly[i + 1]!]) {
        const p = add(vertex.point, mul(normal, 0.002));
        const [x, y] = coords(projector, vertex.point);
        positions.push(...p);
        uvs.push(Math.max(0, Math.min(1, x / projector.width + 0.5)), Math.max(0, Math.min(1, y / projector.height + 0.5)));
      }
    }
    if (positions.length > 256 * 3) break;
  }
  if (positions.length === 0) return { tile: null, split: [] };
  if (positions.length / 3 <= 256) return { tile: { positions: new Float32Array(positions), uvs: new Float32Array(uvs) }, split: [] };
  const xm = (region.x0 + region.x1) / 2, ym = (region.y0 + region.y1) / 2;
  const split: Region[] = [];
  if (region.x1 - region.x0 > 0.5 + 1e-8 && region.y1 - region.y0 > 0.5 + 1e-8) {
    split.push({ x0: region.x0, x1: xm, y0: region.y0, y1: ym }, { x0: xm, x1: region.x1, y0: region.y0, y1: ym }, { x0: region.x0, x1: xm, y0: ym, y1: region.y1 }, { x0: xm, x1: region.x1, y0: ym, y1: region.y1 });
  } else if (region.x1 - region.x0 > 0.5 + 1e-8) {
    split.push({ ...region, x1: xm }, { ...region, x0: xm });
  } else if (region.y1 - region.y0 > 0.5 + 1e-8) {
    split.push({ ...region, y1: ym }, { ...region, y0: ym });
  }
  return { tile: null, split };
}

export function clipDecal(index: ColliderIndex, spec: DecalSpec): ClippedDecal | null {
  const projector = projectorOf(spec);
  if (!projector) return null;
  const seedHit = index.raycast(projector.origin, mul(projector.normal, -1), projector.depth);
  if (!seedHit) return null;
  const seed = { instanceId: seedHit.instanceId, point: seedHit.point, normal: seedHit.normal };
  const cols = Math.ceil(projector.width / 4), rows = Math.ceil(projector.height / 4);
  const tiles: DecalTile[] = [];
  let droppedTiles = 0;
  for (let col = 0; col < cols; col++) for (let row = 0; row < rows; row++) {
    const x0 = -projector.width / 2 + projector.width * col / cols;
    const x1 = -projector.width / 2 + projector.width * (col + 1) / cols;
    const y0 = -projector.height / 2 + projector.height * row / rows;
    const y1 = -projector.height / 2 + projector.height * (row + 1) / rows;
    const pending: Region[] = [{ x0, x1, y0, y1 }];
    while (pending.length) {
      const region = pending.pop()!;
      const out = clipRegion(index, projector, seed, region);
      if (out.tile) tiles.push(out.tile);
      else if (out.split.length) pending.push(...out.split);
      else droppedTiles++;
    }
  }
  return tiles.length ? { tiles, droppedTiles } : null;
}
