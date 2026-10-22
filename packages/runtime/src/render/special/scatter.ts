// Seeded scatter over a polygon with authored counts, template weights, distance limits and slope filters.
// Samples group into spatial clusters, with one instanced mesh per template, cluster and pass. Bounds are assigned
// after instance matrices are written so culling covers the complete cluster. Geometry and paints reuse the map pipeline.
import { Group, InstancedMesh, Matrix4, Sphere, Vector3 } from 'three/webgpu';
import type { Material, Mesh } from 'three/webgpu';
import { dequantMatrix, packedAttributes, packedRangeGeometry } from '../geometry/map-batcher.ts';
import { meshNormals, unionSphere } from '../geometry/map-plan.ts';
import { generatorRandom } from '../geometry/rng.ts';
import type { LodLevel, ScriptedSpec, Vec3Tuple } from '../geometry/generator-types.ts';
import { SurfaceVariant } from '../surface/surface-material.ts';
import { setPaintBase } from '../surface/paint-table.ts';

/** the `scatter` row's plant count (render §14.6) */
export const SCATTER_COUNT = 0;
/** clusters hide beyond this distance (render §14.6) */
export const SCATTER_MAX_DISTANCE = Infinity;
/** spatial clusters (render §14.6) */
export const SCATTER_CLUSTERS = 1;
/** `filter.maxSlope` (render §14.6): rise over run */
export const SCATTER_MAX_SLOPE = Infinity;
/** metres between the height taps of the slope filter */
export const SCATTER_SLOPE_EPS = 0.5;

export interface ScatterTemplate {
  spec: ScriptedSpec;
  /** sampling weight (authored content kinds) */
  weight: number;
  /** uniform instance scale range; default [1, 1] */
  scale?: [number, number];
  /** metres the instance sits into the ground; default 0 */
  sink?: number;
}

export interface ScatterConfig {
  seed: unknown;
  /** default `SCATTER_COUNT` */
  count?: number;
  /** default `SCATTER_MAX_DISTANCE` */
  maxDistance?: number;
  /** default `SCATTER_CLUSTERS` (a √n × √n grid) */
  clusters?: number;
  /** default `SCATTER_MAX_SLOPE` */
  maxSlope?: number;
  /** the scatter polygon, [x, z] vertices (closed implicitly) */
  polygon: ReadonlyArray<readonly [number, number]>;
  templates: readonly ScatterTemplate[];
  /** LODs to request; the first is drawn. Default [3] */
  lods?: LodLevel[];
  /** the baked terrain height (MP1 grid through MP0's sampler); null = no ground here */
  heightAt: (x: number, z: number) => number | null;
}

/** an index range of one pass, in indices */
export interface ScatterIndexRange {
  start: number;
  count: number;
}

/** the fields scatter reads of a packed LOD (a structural view of `geometry/pack.ts`'s `PackedLod`) */
export interface ScatterLod {
  vtx: ArrayBuffer;
  idx: Uint16Array | Uint32Array;
  uvs?: Float32Array;
  /** int8 xyz mesh normals, 0 on flat vertices (`map-plan.ts` `meshNormals`) */
  normals?: Int8Array;
  /** `PAINT_FLOATS` per local paint id */
  paints: Float32Array;
  bboxMin: Vec3Tuple;
  bboxMax: Vec3Tuple;
  /** the opaque pass's index range; null when the LOD has no opaque triangles */
  opaque: ScatterIndexRange | null;
  /** the transparent pass's index range; null when the LOD has none */
  transparent: ScatterIndexRange | null;
}

/** the part of the geometry service scatter uses (`GeometryServiceImpl` satisfies it through the adapter) */
export interface ScatterGeometrySource {
  request(spec: ScriptedSpec, lods: LodLevel[]): Promise<{ lods: ScatterLod[] }>;
}

export interface ScatterSample {
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
  template: number;
}

/** ray casting on the [x, z] polygon; points on an edge count as inside */
export function pointInPolygon(x: number, z: number, polygon: ReadonlyArray<readonly [number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i]![0], zi = polygon[i]![1];
    const xj = polygon[j]![0], zj = polygon[j]![1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

/** the slope |∇h| at (x, z) by central differences; null when the ground is missing under a tap */
export function slopeAt(heightAt: (x: number, z: number) => number | null, x: number, z: number, eps: number = SCATTER_SLOPE_EPS): number | null {
  const hx1 = heightAt(x + eps, z), hx0 = heightAt(x - eps, z);
  const hz1 = heightAt(x, z + eps), hz0 = heightAt(x, z - eps);
  if (hx1 === null || hx0 === null || hz1 === null || hz0 === null) return null;
  if (!Number.isFinite(hx1 + hx0 + hz1 + hz0)) return null;
  const dx = (hx1 - hx0) / (2 * eps);
  const dz = (hz1 - hz0) / (2 * eps);
  return Math.hypot(dx, dz);
}

/** weighted template pick: `rng()` in [0, 1) against the cumulative weights */
export function pickTemplate(rng: () => number, cumulative: readonly number[]): number {
  const total = cumulative[cumulative.length - 1]!;
  const r = rng() * total;
  for (let i = 0; i < cumulative.length; i++) if (r < cumulative[i]!) return i;
  return cumulative.length - 1;
}

function cumulativeWeights(templates: readonly ScatterTemplate[]): number[] {
  const out: number[] = [];
  let acc = 0;
  for (const t of templates) {
    if (!(t.weight > 0)) throw new RangeError(`scatter: template weight ${t.weight}`);
    acc += t.weight;
    out.push(acc);
  }
  return out;
}

function polygonBounds(polygon: ReadonlyArray<readonly [number, number]>): { minX: number; maxX: number; minZ: number; maxZ: number } {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const [x, z] of polygon) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minZ, maxZ };
}

/**
 * Re-samples the scatter points: rejection sampling in the polygon's bbox with the seeded RNG (the same mulberry32
 * family as the live generators, `geometry/rng.ts`), keeping a sample when it is inside the polygon, on known ground,
 * and no steeper than `maxSlope`. The RNG call order per accepted sample is x, z, template, yaw, scale — deterministic
 * per seed. Returns at most `count` samples (fewer when the polygon cannot hold them).
 */
export function sampleScatterPoints(config: ScatterConfig): ScatterSample[] {
  const count = config.count ?? SCATTER_COUNT;
  const maxSlope = config.maxSlope ?? SCATTER_MAX_SLOPE;
  if (config.polygon.length < 3) throw new RangeError('scatter: the polygon needs at least 3 vertices');
  if (config.templates.length === 0) throw new RangeError('scatter: no templates');
  const cumulative = cumulativeWeights(config.templates);
  const { minX, maxX, minZ, maxZ } = polygonBounds(config.polygon);
  const rng = generatorRandom(config.seed);
  const out: ScatterSample[] = [];
  let attempts = 0;
  const maxAttempts = Math.max(64, count * 40);
  while (out.length < count && attempts < maxAttempts) {
    attempts++;
    const x = minX + rng() * (maxX - minX);
    const z = minZ + rng() * (maxZ - minZ);
    if (!pointInPolygon(x, z, config.polygon)) continue;
    const h = config.heightAt(x, z);
    if (h === null || !Number.isFinite(h)) continue;
    const slope = slopeAt(config.heightAt, x, z);
    if (slope === null || slope > maxSlope) continue;
    const template = pickTemplate(rng, cumulative);
    const t = config.templates[template]!;
    const [s0, s1] = t.scale ?? [1, 1];
    out.push({ x, y: h - (t.sink ?? 0), z, yaw: rng() * Math.PI * 2, scale: s0 + rng() * (s1 - s0), template });
  }
  return out;
}

/**
 * Groups samples into a √clusters × √clusters grid over their bbox (16 → 4 × 4). Deterministic; empty cells stay empty
 * and get no mesh. Returns one array per cell, row-major.
 */
export function clusterSamples(samples: readonly ScatterSample[], clusters: number = SCATTER_CLUSTERS): ScatterSample[][] {
  const g = Math.max(1, Math.ceil(Math.sqrt(clusters)));
  const out: ScatterSample[][] = Array.from({ length: g * g }, () => []);
  if (samples.length === 0) return out;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const s of samples) {
    if (s.x < minX) minX = s.x;
    if (s.x > maxX) maxX = s.x;
    if (s.z < minZ) minZ = s.z;
    if (s.z > maxZ) maxZ = s.z;
  }
  const w = maxX - minX || 1;
  const d = maxZ - minZ || 1;
  for (const s of samples) {
    const cx = Math.min(g - 1, Math.floor(((s.x - minX) / w) * g));
    const cz = Math.min(g - 1, Math.floor(((s.z - minZ) / d) * g));
    out[cz * g + cx]!.push(s);
  }
  return out;
}

/** the material-cache surface scatter needs (a structural view of `SurfaceMaterials`) */
export interface ScatterMaterialCache {
  get(key: { variant: number; state?: { depthWrite?: boolean } }): Material;
}

/** the paint-table surface scatter needs (a structural view of `MapPaint`) */
export interface ScatterPaintTable {
  addBlock(paints: Float32Array): number;
}

export interface ScatterDeps {
  materials: ScatterMaterialCache;
  paint: ScatterPaintTable;
  log?: (message: string) => void;
}

export interface ScatterCluster {
  /** world centre of the cluster's instance spheres */
  center: Vec3Tuple;
  radius: number;
  meshes: InstancedMesh[];
}

export interface ScatterField {
  /** parent of every scatter mesh; add it to the world */
  readonly group: Group;
  readonly clusters: ScatterCluster[];
  /** hides the clusters beyond `maxDistance`; call once per frame (or on the map batcher's cadence) */
  update(camera: { x: number; y: number; z: number }): void;
  /** `instances` counts unique successfully rendered plants, even when each is drawn in multiple passes. */
  stats(): { samples: number; meshes: number; clusters: number; instances: number };
  dispose(): void;
}

interface TemplateBuild {
  attrs: ReturnType<typeof packedAttributes>;
  dequant: Matrix4;
  /** world-space bbox centre and half-diagonal of the template */
  centre: Vec3Tuple;
  halfDiag: number;
  opaque: Material;
  transparent: Material;
  paintBase: number;
  ranges: { opaque: ScatterIndexRange | null; transparent: ScatterIndexRange | null };
}

/**
 * Builds the scatter field: samples the points, clusters them, requests each template's LOD through the geometry
 * service, and creates one `InstancedMesh` per (template, cluster, pass). A template that fails to generate is skipped
 * (logged); its samples are dropped.
 */
export async function buildScatterField(config: ScatterConfig, source: ScatterGeometrySource, deps: ScatterDeps): Promise<ScatterField> {
  const maxDistance = config.maxDistance ?? SCATTER_MAX_DISTANCE;
  const lods = config.lods ?? [3];
  const log = deps.log ?? ((m: string) => console.warn(`[scatter] ${m}`));
  const samples = sampleScatterPoints(config);
  const clusters = clusterSamples(samples, config.clusters ?? SCATTER_CLUSTERS);
  const group = new Group();
  group.name = 'ss:scatter';
  const built: ScatterCluster[] = [];
  const materialCache = new Map<number, Material>();
  const materialFor = (variant: number, transparent: boolean): Material => {
    let m = materialCache.get(variant);
    if (!m) {
      m = deps.materials.get(transparent ? { variant, state: { depthWrite: false } } : { variant });
      materialCache.set(variant, m);
    }
    return m;
  };

  const byTemplate = new Map<number, ScatterSample[]>();
  for (const s of samples) {
    const list = byTemplate.get(s.template);
    if (list) list.push(s);
    else byTemplate.set(s.template, [s]);
  }

  let instances = 0;
  for (const [ti, list] of byTemplate) {
    const spec = config.templates[ti]!.spec;
    let lodsBack: ScatterLod[];
    try {
      lodsBack = (await source.request(spec, lods)).lods;
    } catch (e) {
      log(`template ${ti} failed: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const lod = lodsBack[0];
    if (!lod) {
      log(`template ${ti}: no LOD`);
      continue;
    }
    const normals = lod.normals ? meshNormals(lod.normals, lod.bboxMin, lod.bboxMax) : undefined;
    const attrs = packedAttributes(lod.vtx, lod.idx, lod.uvs, normals);
    const dequant = dequantMatrix(lod.bboxMin, lod.bboxMax);
    const paintBase = deps.paint.addBlock(lod.paints);
    const V = SurfaceVariant;
    const extra = normals ? V.NORMALS : 0;
    const built1: TemplateBuild = {
      attrs,
      dequant,
      centre: [(lod.bboxMin[0] + lod.bboxMax[0]) / 2, (lod.bboxMin[1] + lod.bboxMax[1]) / 2, (lod.bboxMin[2] + lod.bboxMax[2]) / 2] as Vec3Tuple,
      halfDiag: Math.hypot(lod.bboxMax[0] - lod.bboxMin[0], lod.bboxMax[1] - lod.bboxMin[1], lod.bboxMax[2] - lod.bboxMin[2]) / 2,
      opaque: materialFor(V.SRC_PACKED | V.SIDE_DOUBLE | extra, false),
      transparent: materialFor(V.SRC_PACKED | V.SIDE_DOUBLE | V.TRANSPARENT | extra, true),
      paintBase,
      ranges: { opaque: lod.opaque, transparent: lod.transparent },
    };
    // the template's samples per cluster cell
    const cells = clusterSamples(list, config.clusters ?? SCATTER_CLUSTERS);
    cells.forEach((cell, ci) => {
      if (cell.length === 0) return;
      const meshes: InstancedMesh[] = [];
      const passes: Array<{ range: ScatterIndexRange | null; material: Material }> = [
        { range: built1.ranges.opaque, material: built1.opaque },
        { range: built1.ranges.transparent, material: built1.transparent },
      ];
      for (const pass of passes) {
        if (!pass.range || pass.range.count === 0) continue;
        const geometry = packedRangeGeometry(built1.attrs, pass.range.start, pass.range.count);
        const mesh = new InstancedMesh(geometry, pass.material, cell.length);
        mesh.name = `ss:scatter:t${ti}:c${ci}`;
        const m = new Matrix4();
        const v = new Vector3();
        const acc = [0, 0, 0, -1];
        cell.forEach((s, i) => {
          m.makeRotationY(s.yaw);
          m.scale(v.set(s.scale, s.scale, s.scale));
          m.setPosition(s.x, s.y, s.z);
          m.multiply(built1.dequant);
          mesh.setMatrixAt(i, m);
          // the instance's world sphere: bbox centre through the instance transform, radius scaled
          const cos = Math.cos(s.yaw), sin = Math.sin(s.yaw);
          const lx = built1.centre[0] * s.scale, lz = built1.centre[2] * s.scale;
          const sphere = [s.x + lx * cos + lz * sin, s.y + built1.centre[1] * s.scale, s.z - lx * sin + lz * cos, built1.halfDiag * s.scale];
          unionSphere(acc, sphere, 0);
        });
        mesh.count = cell.length;
        mesh.instanceMatrix.needsUpdate = true;
        // static object-level bounds, assigned once after the instances are written (§6.5, §14.6)
        mesh.boundingSphere = new Sphere(new Vector3(acc[0]!, acc[1]!, acc[2]!), acc[3]!);
        setPaintBase(mesh, built1.paintBase);
        mesh.castShadow = false;
        mesh.receiveShadow = false;
        group.add(mesh);
        meshes.push(mesh);
      }
      if (meshes.length === 0) return;
      // Count unique plants once even when their template is submitted in opaque and transparent passes.
      instances += cell.length;
      const c0 = (meshes[0]!.boundingSphere as Sphere).center;
      built.push({ center: [c0.x, c0.y, c0.z], radius: (meshes[0]!.boundingSphere as Sphere).radius, meshes });
    });
  }

  const field: ScatterField = {
    group,
    clusters: built,
    update(camera: { x: number; y: number; z: number }): void {
      for (const c of built) {
        const d = Math.hypot(c.center[0] - camera.x, c.center[1] - camera.y, c.center[2] - camera.z) - c.radius;
        const visible = d <= maxDistance;
        for (const m of c.meshes) m.visible = visible;
      }
    },
    stats(): { samples: number; meshes: number; clusters: number; instances: number } {
      return { samples: samples.length, meshes: built.reduce((n, c) => n + c.meshes.length, 0), clusters: built.length, instances };
    },
    dispose(): void {
      group.traverse((o) => {
        if ((o as Mesh).isMesh === true) (o as Mesh).geometry.dispose();
      });
      group.clear();
      built.length = 0;
    },
  };
  // the first update puts every cluster in its distance state; the caller repeats it per frame
  field.update({ x: 0, y: 0, z: 0 });
  return field;
}
