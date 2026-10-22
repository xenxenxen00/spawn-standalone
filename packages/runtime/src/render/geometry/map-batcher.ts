// The map batcher (docs/design/rendering.md §6.5; WP R3): the scripted rows of a place as three objects.
//
//   merged chunks    one opaque and one transparent `Mesh` per (chunk part, LOD), over the `PackedChunk`s a geometry worker
//                    returned (`GeometryService.buildChunks`: one job per 32 m cell; the worker cuts the cell into parts,
//                    `map-plan.ts` `partitionChunk`). Nothing is merged or requantised here: this file imports
//                    `chunk-merge.ts` and the worker as types only. The three meshes of a level (opaque, transparent, LOD-5
//                    shadow proxy) are three `BufferGeometry` objects over the same two `BufferAttribute`s, each with its own
//                    draw range, so the level is uploaded once
//   far meshes       one opaque and one transparent `Mesh` per 128 m far group (`farIdOf`) with two or more parts: the
//                    parts' coarsest level joined in a worker (`GeometryService.buildFar`). While every part of the group
//                    shows its coarsest level, the far mesh draws instead of them: the same triangles in one or two draws.
//                    The parts' own meshes of that level are ranges of the far mesh's buffers, so the level is on the GPU once
//   instanced keys   with `multiDraw` (the backend has `WEBGL_multi_draw`): one `BatchedMesh` per pass holding every
//                    (key, LOD) geometry, one instance per row, the LOD chosen by `setGeometryIdAt`, culled per instance:
//                    one multi-draw call per pass. Without it: one `InstancedMesh` per (key, LOD, pass), all sharing the
//                    key's geometry. The batcher picks each instance's LOD and writes its matrix into the mesh of that
//                    level, then sets `count`, the written range and the mesh's own `boundingSphere` (three computes that
//                    sphere once, from the instances below `count` at that moment, and would cull a mesh first seen empty
//                    for ever)
//   single rows      dynamic rows and rows with a look of their own: one `Mesh` per LOD and pass over the key's geometry.
//                    K3 (`rigs` option): a single row of a rigged key (its packed key carries `skeleton`) draws one
//                    `SkinnedMesh` per LOD and pass instead, all sharing the row's one Skeleton (`render/rig/three-rig.ts`);
//                    rigged rows are never merged or instanced (`PlanRow.rigged`)
//   shadow proxies   layer 2 (`LAYER_SHADOW_PROXY`), `castShadow`, LOD 5, opaque triangles of rows that cast: one per chunk,
//                    one `InstancedMesh` per instanced key and one `Mesh` per single row that casts (it moves with the row
//                    and stays visible at every level the world camera shows). Every visible map mesh has `castShadow = false`
//
// Smooth faces: a level whose key (or chunk) has smooth faces carries a `normal` attribute (4 more bytes per vertex) and draws
// with the NORMALS variants; the others stay on the flat variants. So the map has at most four packed materials: opaque and
// transparent, flat and with normals.
//
// Bounds are explicit (§6.5 "Culling"): a packed geometry's positions are int16 normalised over its bbox and the mesh (or
// instance) matrix dequantises them, so its `boundingBox` is the ±1 cube and its `boundingSphere` sits on the origin, assigned
// once and never computed from the arrays. A key geometry's sphere has radius √3 (the cube's): three scales a sphere by the
// matrix's largest axis scale, and under a row with a non-uniform scale nothing smaller is safe. A chunk or far mesh is drawn
// by exactly one matrix (its own dequantisation), so its sphere is the bbox's circumscribed one: radius |h| / max(h) in
// quantised space, which three turns into |h| (DR-35 lever 1). On a 32 × 8 × 32 m chunk that is 23 m instead of 28 m.
//
// LOD selection is the batcher's own (`map-plan.ts`: distance to the chunk AABB or the instance sphere, 10 % hysteresis),
// applied by `visible` on chunk and single meshes and by the instance partition. three's `LOD` object is not used.
//
// Uploads go through `upload()`: batches of `renderer.compileAsync(group, camera, scene)` under the warm-up rule (every LOD
// level and proxy of the batch visible, `frustumCulled = false`, the camera's layers 0, 1 and 2 enabled; all restored
// afterwards), time-sliced by a frame yield. `compileAsync` compiles for the render target that is current when it runs, so
// the caller sets the scene pass's target first. The shadow pass's depth programs are not covered by `compileAsync` at all;
// `shadowProxies()` lists the proxies for the one real shadow render of the §7.2 warm-up (R6 / R14).
import { BatchedMesh, BufferAttribute, BufferGeometry, Box3, DynamicDrawUsage, Group, InstancedMesh, Matrix4, Mesh, Sphere, Vector3 } from 'three/webgpu';
import type { Camera, Material, Object3D, Scene } from 'three/webgpu';
import { LAYER_SHADOW_PROXY, LAYER_THIRD_PERSON_ONLY, LAYER_WORLD } from '../scene/scene-root.ts';
import { setPaintBase, MAX_PAINTS, PACKED_ATTRIBUTE, PACKED_NORMAL_ATTRIBUTE, PACKED_COLOR_ATTRIBUTE, type MapPaint } from '../surface/paint-table.ts';
import { SurfaceVariant, type SurfaceMaterials } from '../surface/surface-material.ts';
import type { ChunkJob, FarJob, PackedChunk } from './chunk-merge.ts';
import type { LodLevel, ScriptedSpec, Vec3Tuple } from './generator-types.ts';
import {
  chunkSplitFor, classifyRows, distanceToAabb, farIdOf, groupByChunk, instanceSphere, keyCullRadius, keysNeedingLod1Tris, lodBands, meshNormals, MIN_HALF_EXTENT, removeRowFromIndex, selectLodIndex, unionSphere,
  type LodBands, type LodPolicy, type PlanRow,
} from './map-plan.ts';
import { PAINT_FLOATS, PAINT_ID_BIAS, type PackedKey, type PackedLod } from './pack.ts';
import type { RigDef } from '../../compat/motion/rig.ts';
import { packedSkinAttributes } from '../rig/rigid-skin.ts';
import type { ScriptRigs } from '../rig/script-rigs.ts';
import { addRigidMesh, createRigidRowRig, type RigidRowRig } from '../rig/three-rig.ts';

/** a scripted row for the batcher */
export interface BatcherRow extends PlanRow {
  /** false: the row's meshes exist but are hidden (`visible: false` / `render: false`) */
  visible?: boolean;
}

/** the part of `GeometryServiceImpl` the batcher uses */
export interface BatcherGeometry {
  request(spec: ScriptedSpec, lods: LodLevel[]): Promise<PackedKey>;
  buildChunks(job: ChunkJob): Promise<PackedChunk[]>;
  /** the far mesh of a far group (`GeometryServiceImpl.buildFar`); a service without it builds no far meshes */
  buildFar?(job: FarJob): Promise<PackedChunk>;
}

export interface BatcherTier {
  lods: readonly LodLevel[];
  lodPolicy: LodPolicy;
  lodDistances: readonly number[];
  /** 0: no shadowCaster shadow on this tier, so no shadow proxies are built (unless `sunShadow`) */
  shadowCasterMapSize: number;
  /**
   * K14, opt-in: the scene has a sun shadow (`atmosphere.sunShadow`), so the shadow proxies are built
   * on every tier, a tier without a shadowCaster shadow too: the batched rows cast only through them. Absent: the legacy host's rule.
   */
  sunShadow?: boolean;
  /** the frame's triangle budget (render §15.1): it sizes the chunk parts (`chunkSplitFor`). Absent: one part per cell */
  triangleBudget?: number;
}

/** shadow proxies are built: the tier has a shadowCaster shadow, or the scene a sun shadow (K14) */
export function castsProxies(tier: Pick<BatcherTier, 'shadowCasterMapSize' | 'sunShadow'>): boolean {
  return tier.shadowCasterMapSize > 0 || tier.sunShadow === true;
}

export type MapPass = 'opaque' | 'transparent';

export interface MapBatcherOptions {
  place: string;
  geometry: BatcherGeometry;
  /** the variant cache, with the packed stage registered (`registerPackedSurface`) */
  materials: SurfaceMaterials;
  /** the place's paint tables; the batcher appends one block per chunk and per key LOD */
  paint: MapPaint;
  tier: BatcherTier;
  /** LOD 1 triangles of a key from build-time data (`gen-cost.json`); a miss costs one `request` of the key */
  lod1Tris?: (key: string) => number | undefined;
  /**
   * the backend draws a `BatchedMesh` with one multi-draw call (`supportsMultiDraw(renderer)`: the WebGL2 backend with
   * `WEBGL_multi_draw`): the instanced keys become one `BatchedMesh` per pass (DR-35 lever 3). Default false: one
   * `InstancedMesh` per (key, LOD, pass), which is also what a `BatchedMesh` would cost per instance without the extension
   */
  multiDraw?: boolean;
  /** false: no far meshes (DR-35 lever 4); default true when the geometry service has `buildFar` */
  far?: boolean;
  /** the material of a row with a look of its own (`ownLook`); null or absent: the generator's paints */
  rowMaterial?: (row: BatcherRow, pass: MapPass) => Material | null;
  /**
   * K3: the main thread's rig per script. When set, a single row whose key carries a `skeleton` (`PackedKey.skeleton`,
   * geometry workers with `rigs`) draws skinned (`rowRig(rowId)` gives what the presentation pass binds). Absent: the legacy host's
   * static meshes for every key
   */
  rigs?: ScriptRigs;
  log?: (message: string) => void;
  onProgress?: (done: number, total: number) => void;
}

const UNIT_SPHERE_RADIUS = Math.sqrt(3);
/** K3: a rigged row's culling sphere is its rest box's grown by this (its parts swing about pivots inside the box) */
const RIG_SPHERE_GROWTH = 1.5;
const REPARTITION_DISTANCE = 1;
const REPARTITION_FRAMES = 4;


/** the matrix that dequantises a packed geometry: translate(bbox centre) · scale(bbox half extents) */
export function dequantMatrix(bboxMin: ArrayLike<number>, bboxMax: ArrayLike<number>, target: Matrix4 = new Matrix4()): Matrix4 {
  const hx = (bboxMax[0]! - bboxMin[0]!) / 2 || MIN_HALF_EXTENT, hy = (bboxMax[1]! - bboxMin[1]!) / 2 || MIN_HALF_EXTENT, hz = (bboxMax[2]! - bboxMin[2]!) / 2 || MIN_HALF_EXTENT;
  return target.set(hx, 0, 0, (bboxMin[0]! + bboxMax[0]!) / 2, 0, hy, 0, (bboxMin[1]! + bboxMax[1]!) / 2, 0, 0, hz, (bboxMin[2]! + bboxMax[2]!) / 2, 0, 0, 0, 1);
}

/** the shared attributes of one packed level */
export interface PackedAttributes {
  position: BufferAttribute;
  index: BufferAttribute;
  uv: BufferAttribute | null;
  /** the mesh normals (`writeMeshNormal`); null on a level with no smooth face */
  normal: BufferAttribute | null;
  /** K10b: per-vertex RGBA (linear rgb, alpha) of a level whose generator returned `{ colors }`; null otherwise */
  color?: BufferAttribute | null;
}

export function packedAttributes(vtx: ArrayBuffer, idx: Uint16Array | Uint32Array, uvs?: Float32Array, normals?: Int8Array, colors?: Float32Array): PackedAttributes {
  // one Int16Array, itemSize 4, normalised (D5): three reads `position` as its xyz; the paint stage reads the same buffer as a vec4
  return {
    position: new BufferAttribute(new Int16Array(vtx), 4, true),
    index: new BufferAttribute(idx, 1),
    uv: uvs ? new BufferAttribute(uvs, 2) : null,
    normal: normals ? new BufferAttribute(normals, 4, true) : null,
    ...(colors ? { color: new BufferAttribute(colors, 4) } : {}),
  };
}

/**
 * The culling sphere of a mesh that is drawn only by its own dequantisation (a chunk, a far mesh), in quantised space: the
 * bbox's circumscribed sphere is |h| in the world, and three scales a local radius by the matrix's largest axis scale, max(h).
 */
export function boxSphereRadius(bboxMin: ArrayLike<number>, bboxMax: ArrayLike<number>): number {
  const hx = (bboxMax[0]! - bboxMin[0]!) / 2 || MIN_HALF_EXTENT, hy = (bboxMax[1]! - bboxMin[1]!) / 2 || MIN_HALF_EXTENT, hz = (bboxMax[2]! - bboxMin[2]!) / 2 || MIN_HALF_EXTENT;
  return Math.hypot(hx, hy, hz) / Math.max(hx, hy, hz);
}

/** Whether the renderer draws a `BatchedMesh` in one call: the WebGL2 backend with `WEBGL_multi_draw` (the `multiDraw` option). */
export function supportsMultiDraw(renderer: { backend?: unknown }): boolean {
  const backend = renderer.backend as { isWebGLBackend?: boolean; extensions?: { has?(name: string): boolean } } | undefined;
  return backend?.isWebGLBackend === true && backend.extensions?.has?.('WEBGL_multi_draw') === true;
}

/**
 * A geometry over shared packed attributes that draws `[start, start + count)` of the index. Its bounds are assigned here and
 * never computed: the ±1 cube and a sphere on the origin of `radius` (default √3, the cube's: safe under any matrix).
 */
export function packedRangeGeometry(attrs: PackedAttributes, start: number, count: number, radius: number = UNIT_SPHERE_RADIUS): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', attrs.position);
  g.setAttribute(PACKED_ATTRIBUTE, attrs.position);
  if (attrs.uv) g.setAttribute('uv', attrs.uv);
  if (attrs.normal) {
    g.setAttribute('normal', attrs.normal);
    g.setAttribute(PACKED_NORMAL_ATTRIBUTE, attrs.normal);
  }
  if (attrs.color) g.setAttribute(PACKED_COLOR_ATTRIBUTE, attrs.color);
  g.setIndex(attrs.index);
  g.setDrawRange(start, count);
  g.boundingSphere = new Sphere(new Vector3(0, 0, 0), radius);
  g.boundingBox = new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
  return g;
}

interface LevelGeometry {
  lod: LodLevel;
  attrs: PackedAttributes;
  opaque: BufferGeometry | null;
  transparent: BufferGeometry | null;
  dequant: Matrix4;
  /**
   * the block of the level's paints in the map paint table; −1 until a mesh draws with the level's own ids (`#paintBase`).
   * A key that was only asked for its triangle count and then merged, and the levels of a key that draws from a
   * `BatchedMesh` (which has a block of its own), never get one
   */
  paintBase: number;
  /** the level's paint list (PAINT_FLOATS per local id), as the worker packed it */
  paints: Float32Array;
  bboxMin: Vec3Tuple;
  bboxMax: Vec3Tuple;
  tris: number;
  /** K3: the level's geometries carry `skinIndex` / `skinWeight` */
  skinned?: boolean;
}

interface ChunkLevel {
  lod: LodLevel;
  /** the level as the worker packed it; once the level draws from a far mesh its vertex and index buffers are dropped */
  packed: PackedChunk;
  attrs: PackedAttributes;
  opaque: Mesh | null;
  transparent: Mesh | null;
  /**
   * the level draws ranges of its far mesh's buffers (`FarEntry.attrs`), not buffers of its own: the coarsest level of a far
   * group's parts exists once on the GPU. Its rows are removed through the far mesh's `rowRanges`
   */
  shared: boolean;
}

export interface ChunkEntry {
  /** the 32 m cell (`chunkIdOf`) */
  chunk: number;
  /** the part of the cell (`partitionChunk`): '' the whole cell, a quadrant path, 'L' the large rows */
  part: string;
  group: Group;
  /** world AABB over the part's levels */
  min: Vec3Tuple;
  max: Vec3Tuple;
  levels: ChunkLevel[];
  proxy: Mesh | null;
  /** the part's rows, in the order of its `rowRanges` */
  rows: BatcherRow[];
  /** index into `levels` of the level selected; −1 before the first selection */
  current: number;
  /** index into `levels` of the level whose meshes are visible; −1: none (nothing selected yet, or the far mesh draws) */
  shown: number;
  /** the far mesh this part is in, and where its rows start in the far mesh's `rowRanges` */
  far: FarEntry | null;
  farRow0: number;
}

/** the coarsest level of the parts of one far group as one mesh per pass (DR-35 lever 4) */
export interface FarEntry {
  /** `farIdOf` */
  far: number;
  lod: LodLevel;
  group: Group;
  members: ChunkEntry[];
  packed: PackedChunk;
  attrs: PackedAttributes;
  opaque: Mesh | null;
  transparent: Mesh | null;
  /** true while every member selects its coarsest level: the far mesh draws and the members do not */
  shown: boolean;
}

interface InstancedLevel {
  lod: LodLevel;
  /** null in a `BatchedMesh` build */
  opaque: InstancedMesh | null;
  transparent: InstancedMesh | null;
  /** row matrix · dequantisation, 16 floats per row */
  matrices: Float32Array;
  /** triangles of the level's passes (for `visibleCounts`) */
  opaqueTris: number;
  transparentTris: number;
}

/** where a key's rows live in the `BatchedMesh` of one pass */
interface BatchSlots {
  /** geometry id per level; −1: the level has nothing in this pass */
  geometryIds: number[];
  /** instance id per row */
  instanceIds: Int32Array;
}

export interface InstancedEntry {
  key: string;
  group: Group;
  rows: BatcherRow[];
  /** `[x, y, z, r]` per row */
  spheres: Float64Array;
  /** level index per row; −1: not placed yet; −2: removed (promoted or hidden) */
  assigned: Int8Array;
  levels: InstancedLevel[];
  proxy: InstancedMesh | null;
  /** the key's level geometries (shared by every mesh of the key) */
  geometry: KeyGeometry;
  /** a `BatchedMesh` build: the key's slots per pass, and the level each row was last written at */
  batch: { opaque: BatchSlots | null; transparent: BatchSlots | null; written: Int8Array } | null;
}

/** the instanced keys of a place as one `BatchedMesh` per pass (DR-35 lever 3) */
export interface BatchedEntry {
  group: Group;
  opaque: BatchedMesh | null;
  transparent: BatchedMesh | null;
  /** the block of the batch's paints (deduplicated over the keys' levels) */
  paintBase: number;
  paints: number;
  vertices: number;
  indices: number;
}

export interface SingleEntry {
  row: BatcherRow;
  group: Group;
  sphere: Float64Array;
  levels: Array<{ lod: LodLevel; opaque: Mesh | null; transparent: Mesh | null; dequant: Matrix4 }>;
  /**
   * the row's own LOD-5 shadow proxy (layer 2), when the row casts and the tier has a shadowCaster shadow. It is always visible
   * with the row, whatever level the world camera shows: a hidden level mesh casts nothing, so a row near the lamp would
   * otherwise have no shadow
   */
  proxy: Mesh | null;
  /** the dequantisation of the proxy's level */
  proxyDequant: Matrix4 | null;
  key: KeyGeometry;
  current: number;
  /** K3: the row's skeleton and skinned meshes (the root carries the row matrix); absent for a static row */
  rig?: RigidRowRig;
}

interface KeyGeometry {
  key: string;
  levels: LevelGeometry[];
  /** K3: the rig of the key's script, when the batcher has `rigs` and the key a skeleton (every level then carries skin attributes) */
  rig?: RigDef;
}

export interface UploadOptions {
  /** frame budget for uploads in ms (render §6.5: 2) */
  sliceMs?: number;
  /** resolves at the next frame; default `requestAnimationFrame`, else a zero timeout */
  yieldFrame?: () => Promise<void>;
  now?: () => number;
}

export interface UploadStats {
  batches: number;
  /** frames yielded to */
  slices: number;
  ms: number;
  /** the longest single batch (one `compileAsync`) */
  maxBatchMs: number;
  objects: number;
}

export interface MapBatcherStats {
  /** chunk parts (a 32 m cell is one or more) */
  chunks: number;
  /** 32 m cells with merged rows: one chunk job each */
  cells: number;
  chunkMeshes: number;
  /** far groups with a far mesh, and their meshes (one per pass) */
  farGroups: number;
  farMeshes: number;
  /** `BatchedMesh`es of the instanced keys (0 in an `InstancedMesh` build) */
  batchedMeshes: number;
  instancedKeys: number;
  instancedRows: number;
  instancedMeshes: number;
  singles: number;
  shadowProxies: number;
  /** triangles held in GPU buffers, every level */
  triangles: number;
  /** bytes of vertex and index data (CPU copies; the GPU copies are the same size) */
  bytes: number;
  paints: number;
  paintEntries: number;
  skippedKeys: string[];
}

/** the part of the renderer `upload` needs */
export interface BatchCompiler {
  compileAsync(object: Object3D, camera: Camera, scene: Scene): Promise<unknown>;
}

const pow2 = (n: number): number => {
  let c = 4;
  while (c < n) c *= 2;
  return c;
};

const defaultYield = (): Promise<void> =>
  new Promise((resolve) => {
    const raf = (globalThis as { requestAnimationFrame?: (cb: () => void) => number }).requestAnimationFrame;
    if (raf) raf(() => resolve());
    else setTimeout(resolve, 0);
  });

export class MapBatcher {
  /** parent of every map object; add it to `SceneRoot.world` */
  readonly root = new Group();
  readonly chunks: ChunkEntry[] = [];
  readonly fars: FarEntry[] = [];
  /** the instanced keys' `BatchedMesh`es; null in an `InstancedMesh` build or with no instanced key */
  batched: BatchedEntry | null = null;
  readonly instanced: InstancedEntry[] = [];
  readonly singles: SingleEntry[] = [];
  readonly bands: LodBands;
  readonly #opts: MapBatcherOptions;
  readonly #keys = new Map<string, Promise<KeyGeometry | null>>();
  readonly #rows = new Map<string, { kind: 'chunk'; entry: ChunkEntry; index: number } | { kind: 'instanced'; entry: InstancedEntry; index: number } | { kind: 'single'; entry: SingleEntry }>();
  readonly #skipped: string[] = [];
  /** [flat, with normals] */
  readonly #opaque: [Material, Material];
  readonly #transparent: [Material, Material];
  readonly #last = new Vector3(Number.NaN, Number.NaN, Number.NaN);
  #cells = 0;
  #frame = 0;
  #disposed = false;

  private constructor(opts: MapBatcherOptions) {
    this.#opts = opts;
    this.root.name = `ss:map:${opts.place}`;
    this.bands = lodBands(opts.tier);
    const V = SurfaceVariant;
    // scripted meshes draw with back-face culling off (render §6.2)
    const opaque = (extra: number): Material => opts.materials.get({ variant: V.SRC_PACKED | V.SIDE_DOUBLE | extra });
    // a merged transparent range is sorted per mesh, not per triangle (render §20 risk 18): it writes no depth, so a pane
    // never hides another pane or an fx sprite behind it; one pass, not three's back-then-front pair (render §15.5)
    const transparent = (extra: number): Material => {
      const m = opts.materials.get({ variant: V.SRC_PACKED | V.SIDE_DOUBLE | V.TRANSPARENT | extra, state: { depthWrite: false } });
      m.forceSinglePass = true;
      return m;
    };
    this.#opaque = [opaque(0), opaque(V.NORMALS)];
    this.#transparent = [transparent(0), transparent(V.NORMALS)];
  }

  /**
   * Builds the map: classifies the rows (render §6.5), asks the geometry service for the merged chunks (built in its workers)
   * and for the keys of instanced and single rows, and creates the meshes. Nothing reaches the GPU here: call `upload()`.
   */
  static async build(rows: readonly BatcherRow[], opts: MapBatcherOptions): Promise<MapBatcher> {
    const b = new MapBatcher(opts);
    await b.#build(rows);
    return b;
  }

  #log(message: string): void {
    (this.#opts.log ?? ((m: string) => console.warn(m)))(`[map-batcher ${this.#opts.place}] ${message}`);
  }

  async #build(rows: readonly BatcherRow[]): Promise<void> {
    const { tier, geometry } = this.#opts;
    const lods = [...tier.lods];
    const specOf = new Map<string, ScriptedSpec>();
    for (const r of rows) if (!specOf.has(r.key)) specOf.set(r.key, r.spec);

    // the keys whose class depends on their LOD 1 triangle count (2 or 3 static rows on a hybrid tier)
    const tris1 = new Map<string, number>();
    await Promise.all(
      keysNeedingLod1Tris(rows, tier.lodPolicy).map(async (key) => {
        const known = this.#opts.lod1Tris?.(key);
        if (known !== undefined) {
          tris1.set(key, known);
          return;
        }
        const g = await this.#keyGeometry(key, specOf.get(key)!).catch(() => null);
        tris1.set(key, g?.levels.find((l) => l.lod === 1)?.tris ?? 0);
      }),
    );
    const split = classifyRows(rows, tier.lodPolicy, (key) => tris1.get(key) ?? 0);
    const byChunk = groupByChunk(split.merged);
    const total = byChunk.size + split.instanced.size + split.dynamic.length + split.standalone.length;
    let done = 0;
    const step = (): void => {
      done++;
      this.#opts.onProgress?.(done, total);
    };
    this.#opts.onProgress?.(0, total);

    const jobs: Array<Promise<void>> = [];
    const chunkJobs: Array<Promise<void>> = [];
    const chunkSplit = tier.triangleBudget === undefined ? undefined : chunkSplitFor(tier.triangleBudget);
    this.#cells = byChunk.size;
    for (const [chunk, list] of byChunk) {
      const job: ChunkJob = { place: this.#opts.place, chunk, rows: list.map((r) => ({ spec: r.spec, m: r.m, castShadow: r.castShadow !== false })), lods };
      if (chunkSplit) job.split = chunkSplit;
      chunkJobs.push(
        geometry.buildChunks(job).then(
          (packed) => {
            if (!this.#disposed) this.#addChunk(chunk, list, packed);
            step();
          },
          (e: unknown) => {
            this.#log(`chunk ${chunk} failed: ${e instanceof Error ? e.message : String(e)}`);
            step();
          },
        ),
      );
    }
    // the far meshes need every part of their group: they are asked for once the chunk jobs are back
    jobs.push(Promise.all(chunkJobs).then(() => this.#buildFars()));
    const batched = this.#opts.multiDraw === true;
    const keyed: Array<Promise<void>> = [];
    for (const [key, list] of split.instanced) {
      keyed.push(
        this.#keyGeometry(key, list[0]!.spec).then((g) => {
          if (g && !this.#disposed) this.#addInstanced(g, list, batched);
          step();
        }),
      );
    }
    // one BatchedMesh per pass over every instanced key, once all of them are here (in the order of the split, not of arrival)
    jobs.push(
      Promise.all(keyed).then(() => {
        if (!batched || this.#disposed || this.instanced.length === 0) return;
        const order = new Map([...split.instanced.keys()].map((key, i) => [key, i]));
        this.instanced.sort((a, b) => order.get(a.key)! - order.get(b.key)!);
        this.#addBatched();
      }),
    );
    for (const row of [...split.dynamic, ...split.standalone]) {
      jobs.push(
        this.#keyGeometry(row.key, row.spec).then((g) => {
          if (g && !this.#disposed) this.#addSingle(g, row);
          step();
        }),
      );
    }
    await Promise.all(jobs);
    // render §4.1: static objects take one world update; three's per-frame traversal then skips them. The root sits under
    // `SceneRoot.world`, whose matrix is the identity. Single rows keep the default: the bridge moves them
    this.root.updateMatrixWorld(true);
    for (const g of [...this.chunks.map((c) => c.group), ...this.fars.map((x) => x.group), ...this.instanced.map((k) => k.group), ...(this.batched ? [this.batched.group] : [])]) {
      g.traverse((o) => {
        o.matrixAutoUpdate = false;
        o.matrixWorldAutoUpdate = false;
      });
    }
  }

  /** The geometries of a key at the tier's LODs, shared by every mesh of the key; null when the key is empty or failed. */
  #keyGeometry(key: string, spec: ScriptedSpec): Promise<KeyGeometry | null> {
    let p = this.#keys.get(key);
    if (!p) {
      p = this.#opts.geometry.request(spec, [...this.#opts.tier.lods]).then(
        (packed) => {
          const levels: LevelGeometry[] = [];
          const rig = this.#opts.rigs && packed.lods.every((l) => l.skinIndex !== undefined) ? this.#opts.rigs.rigOf(packed) : null;
          for (const l of packed.lods) {
            if (l.tris === 0) continue;
            levels.push(this.#levelGeometry(l, rig !== null));
          }
          if (levels.length !== packed.lods.length) {
            // render §6.2: an empty recorded mesh is accepted by the recorder and skipped here
            this.#skipped.push(key);
            this.#log(`key ${key} is empty at ${packed.lods.length - levels.length} of ${packed.lods.length} LODs: skipped`);
            return null;
          }
          return rig !== null ? { key, levels, rig } : { key, levels };
        },
        (e: unknown) => {
          this.#skipped.push(key);
          this.#log(`key ${key} failed: ${e instanceof Error ? e.message : String(e)}`);
          return null;
        },
      );
      this.#keys.set(key, p);
    }
    return p;
  }

  #levelGeometry(l: PackedLod, skinned = false): LevelGeometry {
    const attrs = packedAttributes(l.vtx, l.idx, l.uvs, l.normals ? meshNormals(l.normals, l.bboxMin, l.bboxMax) : undefined, l.colors);
    const transparentCount = l.idx.length - l.opaqueIndexCount;
    const level: LevelGeometry = {
      lod: l.lod,
      attrs,
      opaque: l.opaqueIndexCount > 0 ? packedRangeGeometry(attrs, 0, l.opaqueIndexCount) : null,
      transparent: transparentCount > 0 ? packedRangeGeometry(attrs, l.opaqueIndexCount, transparentCount) : null,
      dequant: dequantMatrix(l.bboxMin, l.bboxMax),
      paintBase: -1,
      paints: l.paints,
      bboxMin: [...l.bboxMin],
      bboxMax: [...l.bboxMax],
      tris: l.tris,
    };
    if (skinned && l.skinIndex) {
      // K3: rigid skinning, joint 0 = the vertex's bone at weight 1 (pack.ts), shared by the level's two range geometries
      const { skinIndex, skinWeight } = packedSkinAttributes(l.skinIndex);
      const index = new BufferAttribute(skinIndex, 4);
      const weight = new BufferAttribute(skinWeight, 4);
      for (const g of [level.opaque, level.transparent]) {
        if (!g) continue;
        g.setAttribute('skinIndex', index);
        g.setAttribute('skinWeight', weight);
      }
      level.skinned = true;
    }
    return level;
  }

  /** the block of a key level's paints, appended on first use */
  #paintBase(l: LevelGeometry): number {
    if (l.paintBase < 0) l.paintBase = this.#opts.paint.addBlock(l.paints);
    return l.paintBase;
  }

  #staticMesh(geometry: BufferGeometry, material: Material, matrix: Matrix4, paintBase: number, name: string): Mesh {
    const mesh = new Mesh(geometry, material);
    mesh.name = name;
    mesh.matrixAutoUpdate = false;
    mesh.matrix.copy(matrix);
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    setPaintBase(mesh, paintBase);
    return mesh;
  }

  /** The meshes of one chunk job: one entry per part of the cell (`partitionChunk`), each with its LOD levels. */
  #addChunk(chunk: number, jobRows: BatcherRow[], packed: PackedChunk[]): void {
    const shared = packed.find((p) => p.tris > 0);
    if (!shared) return;
    // the parts and LODs of a chunk job share one paint list (`mergeChunkParts`): one block, one base
    const paintBase = this.#opts.paint.addBlock(shared.paints);
    const parts = new Map<string, PackedChunk[]>();
    for (const p of packed) {
      const list = parts.get(p.part);
      if (list) list.push(p);
      else parts.set(p.part, [p]);
    }
    const m = new Matrix4();
    for (const [part, all] of parts) {
      const live = all.filter((p) => p.tris > 0);
      if (live.length === 0) continue;
      const group = new Group();
      group.name = part === '' ? `chunk:${chunk}` : `chunk:${chunk}/${part}`;
      const min: Vec3Tuple = [Infinity, Infinity, Infinity];
      const max: Vec3Tuple = [-Infinity, -Infinity, -Infinity];
      const levels: ChunkLevel[] = [];
      let proxy: Mesh | null = null;
      for (const p of live) {
        if (p.paints !== shared.paints) throw new Error(`map-batcher: chunk ${chunk} came back with more than one paint list; buildChunks must share it`);
        for (let a = 0; a < 3; a++) {
          min[a] = Math.min(min[a]!, p.bboxMin[a]!);
          max[a] = Math.max(max[a]!, p.bboxMax[a]!);
        }
        const attrs = packedAttributes(p.vtx, p.idx, undefined, p.normals);
        const s = attrs.normal ? 1 : 0;
        dequantMatrix(p.bboxMin, p.bboxMax, m);
        // DR-35 lever 1: the mesh is drawn by this one matrix, so its sphere is the bbox's own
        const radius = boxSphereRadius(p.bboxMin, p.bboxMax);
        const transparentCount = p.idx.length - p.opaqueIndexCount;
        const level: ChunkLevel = {
          shared: false,
          lod: p.lod,
          packed: p,
          attrs,
          opaque: p.opaqueIndexCount > 0 ? this.#staticMesh(packedRangeGeometry(attrs, 0, p.opaqueIndexCount, radius), this.#opaque[s]!, m, paintBase, `${group.name}:lod${p.lod}`) : null,
          transparent: transparentCount > 0 ? this.#staticMesh(packedRangeGeometry(attrs, p.opaqueIndexCount, transparentCount, radius), this.#transparent[s]!, m, paintBase, `${group.name}:lod${p.lod}:t`) : null,
        };
        for (const mesh of [level.opaque, level.transparent]) {
          if (!mesh) continue;
          mesh.visible = false;
          group.add(mesh);
        }
        levels.push(level);
        // render §6.5: the shadow pass reads LOD 5; the proxy draws only opaque triangles of rows that cast
        if (p.lod === 5 && p.shadowIndexCount > 0 && castsProxies(this.#opts.tier)) {
          proxy = this.#staticMesh(packedRangeGeometry(attrs, 0, p.shadowIndexCount, radius), this.#opaque[s]!, m, paintBase, `${group.name}:shadow`);
          proxy.layers.set(LAYER_SHADOW_PROXY);
          proxy.castShadow = true;
          proxy.receiveShadow = false;
          group.add(proxy);
        }
      }
      const rows = Array.from(live[0]!.rows, (jobRow) => jobRows[jobRow]!);
      const entry: ChunkEntry = { chunk, part, group, min, max, levels, proxy, rows, current: -1, shown: -1, far: null, farRow0: 0 };
      rows.forEach((r, index) => this.#rows.set(r.id, { kind: 'chunk', entry, index }));
      this.chunks.push(entry);
      this.root.add(group);
      // a row that is hidden from the start is taken out of the index before the first upload
      rows.forEach((r, index) => {
        if (r.visible === false) for (const l of levels) removeRowFromIndex(l.packed.idx, l.packed.rowRanges, index);
      });
    }
  }

  /**
   * DR-35 lever 4: asks the geometry service for the far mesh of every far group that has two or more parts with the tier's
   * coarsest level. The merge runs in a worker over copies of those levels; nothing is generated again.
   */
  async #buildFars(): Promise<void> {
    const buildFar = this.#opts.geometry.buildFar;
    if (this.#opts.far === false || this.#disposed) return;
    const coarsest = this.#opts.tier.lods[this.#opts.tier.lods.length - 1]!;
    const groups = new Map<number, ChunkEntry[]>();
    for (const c of this.chunks) {
      if (c.levels[c.levels.length - 1]!.lod !== coarsest) continue;
      const id = farIdOf(c.chunk);
      const list = groups.get(id);
      if (list) list.push(c);
      else groups.set(id, [c]);
    }
    const wanted = [...groups].filter(([, members]) => members.length > 1);
    if (wanted.length === 0) return;
    if (buildFar === undefined) {
      this.#log(`the geometry service has no buildFar: ${wanted.length} far groups draw part by part`);
      return;
    }
    await Promise.all(
      wanted.map(([far, members]) => {
        // the chunk jobs came back in any order: a far mesh's content must not depend on it
        members.sort((a, b) => a.chunk - b.chunk || (a.part < b.part ? -1 : a.part > b.part ? 1 : 0));
        const job: FarJob = { place: this.#opts.place, far, members: members.map((c) => c.levels[c.levels.length - 1]!.packed) };
        return buildFar.call(this.#opts.geometry, job).then(
          (packed) => {
            if (!this.#disposed) this.#addFar(far, members, packed);
          },
          (e: unknown) => this.#log(`far group ${far} failed: ${e instanceof Error ? e.message : String(e)}`),
        );
      }),
    );
  }

  #addFar(far: number, members: ChunkEntry[], packed: PackedChunk): void {
    if (packed.tris === 0) return;
    const group = new Group();
    group.name = `far:${far}`;
    const paintBase = this.#opts.paint.addBlock(packed.paints);
    const attrs = packedAttributes(packed.vtx, packed.idx, undefined, packed.normals);
    const s = attrs.normal ? 1 : 0;
    const m = dequantMatrix(packed.bboxMin, packed.bboxMax);
    const radius = boxSphereRadius(packed.bboxMin, packed.bboxMax);
    const transparentCount = packed.idx.length - packed.opaqueIndexCount;
    const entry: FarEntry = {
      far,
      lod: packed.lod,
      group,
      members,
      packed,
      attrs,
      opaque: packed.opaqueIndexCount > 0 ? this.#staticMesh(packedRangeGeometry(attrs, 0, packed.opaqueIndexCount, radius), this.#opaque[s]!, m, paintBase, `${group.name}:lod${packed.lod}`) : null,
      transparent: transparentCount > 0 ? this.#staticMesh(packedRangeGeometry(attrs, packed.opaqueIndexCount, transparentCount, radius), this.#transparent[s]!, m, paintBase, `${group.name}:lod${packed.lod}:t`) : null,
      shown: false,
    };
    for (const mesh of [entry.opaque, entry.transparent]) {
      if (!mesh) continue;
      mesh.visible = false;
      group.add(mesh);
    }
    // The far mesh holds every member's coarsest level, member after member. So that level is not kept twice: the member's
    // own meshes of it (and its shadow proxy) become ranges of the far buffers, drawn by the far mesh's matrix and paint block
    // with the member's own box as their culling sphere, and the member's copy is dropped. Nothing was uploaded yet.
    const hx = (packed.bboxMax[0] - packed.bboxMin[0]) / 2 || MIN_HALF_EXTENT, hy = (packed.bboxMax[1] - packed.bboxMin[1]) / 2 || MIN_HALF_EXTENT, hz = (packed.bboxMax[2] - packed.bboxMin[2]) / 2 || MIN_HALF_EXTENT;
    const cx = (packed.bboxMin[0] + packed.bboxMax[0]) / 2, cy = (packed.bboxMin[1] + packed.bboxMax[1]) / 2, cz = (packed.bboxMin[2] + packed.bboxMax[2]) / 2;
    const largest = Math.max(hx, hy, hz);
    let opaqueAt = 0;
    let transparentAt = packed.opaqueIndexCount;
    let row0 = 0;
    for (const c of members) {
      c.far = entry;
      c.farRow0 = row0;
      row0 += c.rows.length;
      const level = c.levels[c.levels.length - 1]!;
      const own = level.packed;
      const ownTransparent = own.idx.length - own.opaqueIndexCount;
      // the member's box in the far mesh's quantised space; three turns the radius into |h(member)| (see `boxSphereRadius`)
      const lo = new Vector3((own.bboxMin[0] - cx) / hx, (own.bboxMin[1] - cy) / hy, (own.bboxMin[2] - cz) / hz);
      const hi = new Vector3((own.bboxMax[0] - cx) / hx, (own.bboxMax[1] - cy) / hy, (own.bboxMax[2] - cz) / hz);
      const ownRadius = Math.hypot(own.bboxMax[0] - own.bboxMin[0], own.bboxMax[1] - own.bboxMin[1], own.bboxMax[2] - own.bboxMin[2]) / 2 / largest;
      const view = (mesh: Mesh | null, start: number, count: number, material: Material): void => {
        if (!mesh) return;
        const g = packedRangeGeometry(attrs, start, count, ownRadius);
        g.boundingSphere!.center.addVectors(lo, hi).multiplyScalar(0.5);
        g.boundingBox!.set(lo.clone(), hi.clone());
        mesh.geometry.dispose();
        mesh.geometry = g;
        mesh.material = material;
        mesh.matrix.copy(m);
        setPaintBase(mesh, paintBase);
      };
      view(level.opaque, opaqueAt, own.opaqueIndexCount, this.#opaque[s]!);
      view(level.transparent, transparentAt, ownTransparent, this.#transparent[s]!);
      if (level.lod === 5) view(c.proxy, opaqueAt, own.shadowIndexCount, this.#opaque[s]!);
      opaqueAt += own.opaqueIndexCount;
      transparentAt += ownTransparent;
      level.attrs = attrs;
      level.shared = true;
      const { normals: _normals, ...slim } = own;
      level.packed = { ...slim, vtx: new ArrayBuffer(0), idx: new Uint16Array(0) };
    }
    this.fars.push(entry);
    this.root.add(group);
  }

  #instancedMesh(geometry: BufferGeometry, material: Material, capacity: number, paintBase: number, name: string): InstancedMesh {
    const mesh = new InstancedMesh(geometry, material, capacity);
    mesh.name = name;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.count = 0;
    mesh.visible = false;
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    // explicit, in world space (the mesh matrix is the identity); refreshed by every partition
    mesh.boundingSphere = new Sphere(new Vector3(), 0);
    setPaintBase(mesh, paintBase);
    return mesh;
  }

  /**
   * An instanced key: its rows' spheres and per-level matrices, its shadow proxy and, unless the key goes into the place's
   * `BatchedMesh`es (`batched`), one `InstancedMesh` per (level, pass).
   */
  #addInstanced(g: KeyGeometry, rows: BatcherRow[], batched = false): void {
    const group = new Group();
    group.name = `key:${g.key.split('|')[0]}`;
    const n = rows.length;
    // one capacity class per power of two: three sizes the instance-matrix uniform block by the attribute's count, so
    // meshes of one class share their programs
    const capacity = pow2(n);
    const spheres = new Float64Array(n * 4);
    const finest = g.levels[0]!;
    rows.forEach((r, i) => instanceSphere(finest.bboxMin, finest.bboxMax, r.m, spheres, i * 4));
    const row = new Matrix4();
    const out = new Matrix4();
    const levels: InstancedLevel[] = g.levels.map((l) => {
      const matrices = new Float32Array(n * 16);
      rows.forEach((r, i) => {
        out.multiplyMatrices(row.fromArray(r.m), l.dequant).toArray(matrices, i * 16);
      });
      const level: InstancedLevel = {
        lod: l.lod,
        opaque: l.opaque && !batched ? this.#instancedMesh(l.opaque, this.#opaque[l.attrs.normal ? 1 : 0]!, capacity, this.#paintBase(l), `${group.name}:lod${l.lod}`) : null,
        transparent: l.transparent && !batched ? this.#instancedMesh(l.transparent, this.#transparent[l.attrs.normal ? 1 : 0]!, capacity, this.#paintBase(l), `${group.name}:lod${l.lod}:t`) : null,
        matrices,
        opaqueTris: (l.opaque?.drawRange.count ?? 0) / 3,
        transparentTris: (l.transparent?.drawRange.count ?? 0) / 3,
      };
      if (level.opaque) group.add(level.opaque);
      if (level.transparent) group.add(level.transparent);
      return level;
    });
    let proxy: InstancedMesh | null = null;
    const coarse = g.levels.find((l) => l.lod === 5);
    if (coarse?.opaque && castsProxies(this.#opts.tier)) {
      const casters = rows.map((r, i) => (r.castShadow !== false && r.visible !== false ? i : -1)).filter((i) => i >= 0);
      if (casters.length > 0) {
        proxy = this.#instancedMesh(coarse.opaque, this.#opaque[coarse.attrs.normal ? 1 : 0]!, capacity, this.#paintBase(coarse), `${group.name}:shadow`);
        const src = levels[g.levels.indexOf(coarse)]!.matrices;
        const acc = [0, 0, 0, -1];
        casters.forEach((i, at) => {
          proxy!.instanceMatrix.array.set(src.subarray(i * 16, i * 16 + 16), at * 16);
          unionSphere(acc, spheres, i * 4);
        });
        proxy.count = casters.length;
        proxy.visible = true;
        proxy.boundingSphere!.center.set(acc[0]!, acc[1]!, acc[2]!);
        proxy.boundingSphere!.radius = acc[3]!;
        proxy.layers.set(LAYER_SHADOW_PROXY);
        proxy.castShadow = true;
        proxy.receiveShadow = false;
        group.add(proxy);
      }
    }
    const assigned = new Int8Array(n).fill(-1);
    rows.forEach((r, i) => {
      if (r.visible === false) assigned[i] = -2;
    });
    const entry: InstancedEntry = { key: g.key, group, rows, spheres, assigned, levels, proxy, geometry: g, batch: null };
    rows.forEach((r, index) => this.#rows.set(r.id, { kind: 'instanced', entry, index }));
    this.instanced.push(entry);
    this.root.add(group);
  }

  /**
   * DR-35 lever 3: every instanced key of the place in one `BatchedMesh` per pass. Each (key, level) range of a pass is a
   * geometry of the batch, each row an instance; the partition picks a row's level with `setGeometryIdAt` and writes that
   * level's matrix (the dequantisation differs per level). three culls per instance and issues one multi-draw call per pass.
   *
   * The batch reads one paint block: the keys' paint lists deduplicated by their float bits, with the copied vertices' paint
   * lane rewritten to the block's ids (the copy is `BatchedMesh`'s own: the key geometries, which the shadow proxies and
   * promoted rows draw, are not touched). A batch needs a `normal` attribute on every geometry [F `three/src/nodes/accessors/
   * Batch.js`: it transforms `normalLocal` whatever the material], so it draws with the NORMALS variants and a level without
   * smooth faces gets the flat mark on every vertex. If the block would pass 65,535 paints the keys stay `InstancedMesh`es.
   */
  #addBatched(): void {
    const keys = this.instanced;
    // 1. the batch's paint list and each level's remap
    const ids = new Map<string, number>();
    const list: Float32Array[] = [];
    const remaps = new Map<LevelGeometry, Int32Array>();
    for (const k of keys) {
      for (const l of k.geometry.levels) {
        const n = l.paints.length / PAINT_FLOATS;
        const bits = new Uint32Array(l.paints.buffer, l.paints.byteOffset, l.paints.length);
        const remap = new Int32Array(n);
        for (let p = 0; p < n; p++) {
          const id = bits.subarray(p * PAINT_FLOATS, (p + 1) * PAINT_FLOATS).join(',');
          let at = ids.get(id);
          if (at === undefined) {
            at = list.length;
            ids.set(id, at);
            list.push(l.paints.subarray(p * PAINT_FLOATS, (p + 1) * PAINT_FLOATS));
          }
          remap[p] = at;
        }
        remaps.set(l, remap);
      }
    }
    if (list.length > MAX_PAINTS) {
      this.#log(`the instanced keys hold ${list.length} distinct paints, more than one block: they draw as instanced meshes`);
      for (const k of keys) this.#instancedLevels(k);
      return;
    }
    const paints = new Float32Array(list.length * PAINT_FLOATS);
    list.forEach((p, i) => paints.set(p, i * PAINT_FLOATS));
    const paintBase = this.#opts.paint.addBlock(paints);

    // 2. sizes per pass
    const passes: MapPass[] = ['opaque', 'transparent'];
    const size = { opaque: { instances: 0, vertices: 0, indices: 0 }, transparent: { instances: 0, vertices: 0, indices: 0 } };
    for (const k of keys) {
      for (const pass of passes) {
        const levels = k.geometry.levels.filter((l) => l[pass] !== null);
        if (levels.length === 0) continue;
        size[pass].instances += k.rows.length;
        for (const l of levels) {
          size[pass].vertices += l.attrs.position.count;
          size[pass].indices += l[pass]!.drawRange.count;
        }
      }
    }
    const group = new Group();
    group.name = 'batched';
    const meshes: Record<MapPass, BatchedMesh | null> = { opaque: null, transparent: null };
    for (const pass of passes) {
      if (size[pass].instances === 0) continue;
      const mesh = new BatchedMesh(size[pass].instances, size[pass].vertices, size[pass].indices, (pass === 'opaque' ? this.#opaque : this.#transparent)[1]!);
      mesh.name = `batched:${pass}`;
      // three tests each instance's sphere; the object's own sphere would be computed once from whatever is visible then
      mesh.frustumCulled = false;
      mesh.perObjectFrustumCulled = true;
      // back to front inside the transparent batch; the opaque one needs no order
      mesh.sortObjects = pass === 'transparent';
      mesh.matrixAutoUpdate = false;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      setPaintBase(mesh, paintBase);
      meshes[pass] = mesh;
      group.add(mesh);
    }

    // 3. geometries and instances
    const flat = (count: number): Int8Array => {
      const out = new Int8Array(count * 4);
      for (let o = 0; o < out.length; o += 4) out[o + 1] = 127;
      return out;
    };
    for (const k of keys) {
      const slots: Record<MapPass, BatchSlots | null> = { opaque: null, transparent: null };
      for (const pass of passes) {
        if (k.geometry.levels.some((l) => l[pass] !== null)) slots[pass] = { geometryIds: k.geometry.levels.map(() => -1), instanceIds: new Int32Array(k.rows.length).fill(-1) };
      }
      const matrices = k.rows.map((r) => r.m);
      k.geometry.levels.forEach((l, li) => {
        if (!slots.opaque && !slots.transparent) return;
        // the level's vertices with the batch's paint ids, and a normal on every vertex
        const src = l.attrs.position.array as Int16Array;
        const remap = remaps.get(l)!;
        const vtx = new Int16Array(src);
        for (let o = 3; o < vtx.length; o += 4) vtx[o] = remap[vtx[o]! + PAINT_ID_BIAS]! - PAINT_ID_BIAS;
        const position = new BufferAttribute(vtx, 4, true);
        const normal = l.attrs.normal ?? new BufferAttribute(flat(l.attrs.position.count), 4, true);
        const index = l.attrs.index.array as Uint16Array | Uint32Array;
        for (const pass of passes) {
          const range = l[pass]?.drawRange;
          const mesh = meshes[pass];
          if (!range || !mesh || !slots[pass]) continue;
          const g = new BufferGeometry();
          g.setAttribute('position', position);
          g.setAttribute(PACKED_ATTRIBUTE, position);
          g.setAttribute('normal', normal);
          g.setAttribute(PACKED_NORMAL_ATTRIBUTE, normal);
          g.setIndex(new BufferAttribute(index.subarray(range.start, range.start + range.count), 1));
          // explicit, like every packed geometry. three culls an instance by this sphere under the instance matrix (row ·
          // dequantisation): the smallest radius that holds every row's box (`keyCullRadius`; the bbox's own sphere when
          // the rows scale uniformly, as for a chunk)
          g.boundingSphere = new Sphere(new Vector3(0, 0, 0), keyCullRadius(l.bboxMin, l.bboxMax, matrices));
          g.boundingBox = new Box3(new Vector3(-1, -1, -1), new Vector3(1, 1, 1));
          const first = mesh.geometry.getAttribute('position') === undefined;
          slots[pass]!.geometryIds[li] = mesh.addGeometry(g);
          if (first) {
            // the batch allocated one array per attribute name: the two aliases read the same data, so they share the buffer
            mesh.geometry.setAttribute(PACKED_ATTRIBUTE, mesh.geometry.getAttribute('position'));
            mesh.geometry.setAttribute(PACKED_NORMAL_ATTRIBUTE, mesh.geometry.getAttribute('normal'));
          }
        }
      });
      for (const pass of passes) {
        const slot = slots[pass];
        const mesh = meshes[pass];
        if (!slot || !mesh) continue;
        const any = slot.geometryIds.find((id) => id >= 0)!;
        for (let i = 0; i < k.rows.length; i++) {
          const id = mesh.addInstance(any);
          // nothing draws before the first partition
          mesh.setVisibleAt(id, false);
          slot.instanceIds[i] = id;
        }
      }
      k.batch = { opaque: slots.opaque, transparent: slots.transparent, written: new Int8Array(k.rows.length).fill(-1) };
    }
    this.batched = { group, opaque: meshes.opaque, transparent: meshes.transparent, paintBase, paints: list.length, vertices: size.opaque.vertices + size.transparent.vertices, indices: size.opaque.indices + size.transparent.indices };
    this.root.add(group);
  }

  /** the `InstancedMesh`es of a key that was built for a batch and could not join it */
  #instancedLevels(k: InstancedEntry): void {
    const capacity = pow2(k.rows.length);
    k.geometry.levels.forEach((l, li) => {
      const level = k.levels[li]!;
      level.opaque = l.opaque ? this.#instancedMesh(l.opaque, this.#opaque[l.attrs.normal ? 1 : 0]!, capacity, this.#paintBase(l), `${k.group.name}:lod${l.lod}`) : null;
      level.transparent = l.transparent ? this.#instancedMesh(l.transparent, this.#transparent[l.attrs.normal ? 1 : 0]!, capacity, this.#paintBase(l), `${k.group.name}:lod${l.lod}:t`) : null;
      if (level.opaque) k.group.add(level.opaque);
      if (level.transparent) k.group.add(level.transparent);
    });
  }

  #addSingle(g: KeyGeometry, row: BatcherRow): SingleEntry {
    if (g.rig !== undefined) return this.#addRiggedSingle(g, g.rig, row);
    const group = new Group();
    group.name = `row:${row.id}`;
    group.visible = row.visible !== false;
    const rowM = new Matrix4().fromArray(row.m);
    const sphere = new Float64Array(4);
    instanceSphere(g.levels[0]!.bboxMin, g.levels[0]!.bboxMax, row.m, sphere);
    const own = row.ownLook === true ? this.#opts.rowMaterial : undefined;
    const levels = g.levels.map((l) => {
      const m = new Matrix4().multiplyMatrices(rowM, l.dequant);
      const mesh = (geo: BufferGeometry | null, pass: MapPass): Mesh | null => {
        if (!geo) return null;
        const material = own?.(row, pass) ?? (pass === 'opaque' ? this.#opaque : this.#transparent)[l.attrs.normal ? 1 : 0]!;
        const out = this.#staticMesh(geo, material, m, this.#paintBase(l), `${group.name}:lod${l.lod}${pass === 'opaque' ? '' : ':t'}`);
        out.visible = false;
        group.add(out);
        return out;
      };
      return { lod: l.lod, opaque: mesh(l.opaque, 'opaque'), transparent: mesh(l.transparent, 'transparent'), dequant: l.dequant };
    });
    // render §6.5, §8.4: the shadow pass reads LOD 5 through layer-2 proxies, and the visible meshes cast nothing. A single
    // row's level meshes are hidden unless the world camera shows them (LOD 5 only beyond the lamp's 25 m), so the row gets
    // a proxy of its own that stays visible with the row
    let proxy: Mesh | null = null;
    let proxyDequant: Matrix4 | null = null;
    const coarse = g.levels.find((l) => l.lod === 5);
    if (coarse?.opaque && row.castShadow !== false && castsProxies(this.#opts.tier)) {
      proxyDequant = coarse.dequant;
      proxy = this.#staticMesh(coarse.opaque, this.#opaque[coarse.attrs.normal ? 1 : 0]!, new Matrix4().multiplyMatrices(rowM, coarse.dequant), this.#paintBase(coarse), `${group.name}:shadow`);
      proxy.layers.set(LAYER_SHADOW_PROXY);
      proxy.castShadow = true;
      proxy.receiveShadow = false;
      group.add(proxy);
    }
    const entry: SingleEntry = { row, group, sphere, levels, proxy, proxyDequant, key: g, current: -1 };
    this.#rows.set(row.id, { kind: 'single', entry });
    this.singles.push(entry);
    this.root.add(group);
    return entry;
  }

  /**
   * K3 (INTEGRATION.md H5): a single row of a rigged key. One SkinnedMesh per level and pass (and the shadow proxy), all under
   * the row's rig root and sharing its Skeleton; the root carries the row matrix, each mesh's bind matrix is its level's
   * dequantisation. Culling uses the level box's sphere grown by half (the parts swing about pivots inside the box).
   */
  #addRiggedSingle(g: KeyGeometry, rigDef: RigDef, row: BatcherRow): SingleEntry {
    const group = new Group();
    group.name = `row:${row.id}`;
    group.visible = row.visible !== false;
    const rig = createRigidRowRig(rigDef, `${group.name}:rig`);
    rig.root.matrix.fromArray(row.m);
    group.add(rig.root);
    const sphere = new Float64Array(4);
    instanceSphere(g.levels[0]!.bboxMin, g.levels[0]!.bboxMax, row.m, sphere);
    sphere[3] = sphere[3]! * RIG_SPHERE_GROWTH;
    const localSphere = (l: LevelGeometry): Sphere => {
      const c = new Vector3((l.bboxMin[0] + l.bboxMax[0]) / 2, (l.bboxMin[1] + l.bboxMax[1]) / 2, (l.bboxMin[2] + l.bboxMax[2]) / 2);
      const r = Math.hypot(l.bboxMax[0] - l.bboxMin[0], l.bboxMax[1] - l.bboxMin[1], l.bboxMax[2] - l.bboxMin[2]) / 2;
      return new Sphere(c, Math.max(r * RIG_SPHERE_GROWTH, MIN_HALF_EXTENT));
    };
    const skinned = (geo: BufferGeometry, material: Material, l: LevelGeometry, name: string): Mesh => {
      const mesh = addRigidMesh(rig, geo, material, l.dequant, localSphere(l));
      mesh.name = name;
      mesh.castShadow = false;
      mesh.receiveShadow = true;
      setPaintBase(mesh, this.#paintBase(l));
      return mesh;
    };
    const levels = g.levels.map((l) => {
      const mesh = (geo: BufferGeometry | null, pass: MapPass): Mesh | null => {
        if (!geo) return null;
        const material = (pass === 'opaque' ? this.#opaque : this.#transparent)[l.attrs.normal ? 1 : 0]!;
        const out = skinned(geo, material, l, `${group.name}:lod${l.lod}${pass === 'opaque' ? '' : ':t'}`);
        out.visible = false;
        return out;
      };
      return { lod: l.lod, opaque: mesh(l.opaque, 'opaque'), transparent: mesh(l.transparent, 'transparent'), dequant: l.dequant };
    });
    let proxy: Mesh | null = null;
    const coarse = g.levels.find((l) => l.lod === 5);
    if (coarse?.opaque && row.castShadow !== false && castsProxies(this.#opts.tier)) {
      proxy = skinned(coarse.opaque, this.#opaque[coarse.attrs.normal ? 1 : 0]!, coarse, `${group.name}:shadow`);
      proxy.layers.set(LAYER_SHADOW_PROXY);
      proxy.castShadow = true;
      proxy.receiveShadow = false;
    }
    const entry: SingleEntry = { row, group, sphere, levels, proxy, proxyDequant: null, key: g, current: -1, rig };
    this.#rows.set(row.id, { kind: 'single', entry });
    this.singles.push(entry);
    this.root.add(group);
    return entry;
  }

  /**
   * K3: the skeleton of a rigged single row, for the presentation pass:
   * `presenter.bind(rig.source, { rowId, rig: rig.rig, mode: 'direct' })`. Null for a static row or an unknown one.
   */
  rowRig(rowId: string): RigidRowRig | null {
    const at = this.#rows.get(rowId);
    return at?.kind === 'single' ? (at.entry.rig ?? null) : null;
  }

  // ── LOD selection ─────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Chooses the LOD of every chunk, instance and single row for a camera position. Call it once per frame: it does the work
   * when the camera moved more than 1 m since the last time, or on every 4th call (render §6.5); `force` does it now.
   * `cut` (a camera cut: spawn, respawn, a spectator switch) does it now and by the plain thresholds: the hysteresis holds a
   * level against small moves of one view, it has nothing to say about a view that was somewhere else.
   */
  update(camera: { x: number; y: number; z: number }, force = false, cut = false): boolean {
    this.#frame++;
    const moved = !(this.#last.distanceToSquared(camera as Vector3) <= REPARTITION_DISTANCE * REPARTITION_DISTANCE);
    if (!force && !cut && !moved && this.#frame % REPARTITION_FRAMES !== 0) return false;
    this.#last.set(camera.x, camera.y, camera.z);
    const { distances } = this.bands;
    const { x, y, z } = camera;
    if (cut) {
      for (const c of this.chunks) c.current = -1;
      for (const k of this.instanced) for (let i = 0; i < k.assigned.length; i++) if (k.assigned[i]! >= 0) k.assigned[i] = -1;
      for (const s of this.singles) s.current = -1;
    }
    for (const c of this.chunks) c.current = Math.min(c.levels.length - 1, selectLodIndex(c.current, distanceToAabb(x, y, z, c.min, c.max), distances));
    // DR-35 lever 4: a far group whose parts all select their coarsest level draws as its one far mesh. The far mesh holds
    // exactly those levels' triangles, so the switch changes the draw count and nothing on screen
    for (const far of this.fars) {
      const shown = far.members.every((c) => c.current === c.levels.length - 1);
      if (shown === far.shown) continue;
      far.shown = shown;
      if (far.opaque) far.opaque.visible = shown;
      if (far.transparent) far.transparent.visible = shown;
    }
    for (const c of this.chunks) {
      const show = c.far?.shown === true ? -1 : c.current;
      if (show === c.shown) continue;
      c.shown = show;
      c.levels.forEach((l, i) => {
        if (l.opaque) l.opaque.visible = i === show;
        if (l.transparent) l.transparent.visible = i === show;
      });
    }
    for (const k of this.instanced) this.#partition(k, x, y, z);
    for (const s of this.singles) {
      const d = Math.max(0, Math.hypot(s.sphere[0]! - x, s.sphere[1]! - y, s.sphere[2]! - z) - s.sphere[3]!);
      const next = Math.min(s.levels.length - 1, selectLodIndex(s.current, d, distances));
      if (next === s.current) continue;
      s.current = next;
      s.levels.forEach((l, i) => {
        if (l.opaque) l.opaque.visible = i === next;
        if (l.transparent) l.transparent.visible = i === next;
      });
    }
    return true;
  }

  /** render §6.5: each instance into the mesh of its level; `count`, the written range and the explicit bounding sphere. */
  #partition(k: InstancedEntry, x: number, y: number, z: number): void {
    const { distances } = this.bands;
    const n = k.rows.length;
    let changed = false;
    for (let i = 0; i < n; i++) {
      const cur = k.assigned[i]!;
      if (cur === -2) continue;
      const o = i * 4;
      const d = Math.max(0, Math.hypot(k.spheres[o]! - x, k.spheres[o + 1]! - y, k.spheres[o + 2]! - z) - k.spheres[o + 3]!);
      const next = Math.min(k.levels.length - 1, selectLodIndex(cur, d, distances));
      if (next !== cur) {
        k.assigned[i] = next;
        changed = true;
      }
    }
    if (!changed) return;
    this.#writeInstances(k);
  }

  /** a `BatchedMesh` build: each row whose level changed gets that level's geometry and matrix; removed rows are hidden */
  #writeBatched(k: InstancedEntry): void {
    const batch = k.batch!;
    const m = new Matrix4();
    for (let i = 0; i < k.rows.length; i++) {
      const level = k.assigned[i]!;
      if (level === batch.written[i]) continue;
      batch.written[i] = level;
      for (const pass of ['opaque', 'transparent'] as const) {
        const slot = batch[pass];
        const mesh = this.batched?.[pass];
        if (!slot || !mesh) continue;
        const id = slot.instanceIds[i]!;
        const geometryId = level >= 0 ? slot.geometryIds[level]! : -1;
        if (geometryId < 0) {
          mesh.setVisibleAt(id, false);
          continue;
        }
        mesh.setGeometryIdAt(id, geometryId);
        mesh.setMatrixAt(id, m.fromArray(k.levels[level]!.matrices, i * 16));
        mesh.setVisibleAt(id, true);
      }
    }
  }

  #writeInstances(k: InstancedEntry): void {
    if (k.batch) {
      this.#writeBatched(k);
      return;
    }
    const n = k.rows.length;
    const acc = [0, 0, 0, -1];
    k.levels.forEach((level, li) => {
      acc[3] = -1;
      let count = 0;
      for (const mesh of [level.opaque, level.transparent]) {
        if (!mesh) continue;
        const out = mesh.instanceMatrix.array as Float32Array;
        count = 0;
        for (let i = 0; i < n; i++) {
          if (k.assigned[i] !== li) continue;
          out.set(level.matrices.subarray(i * 16, i * 16 + 16), count * 16);
          count++;
        }
        mesh.count = count;
        mesh.visible = count > 0;
        if (count > 0) {
          mesh.instanceMatrix.clearUpdateRanges();
          mesh.instanceMatrix.addUpdateRange(0, count * 16);
          mesh.instanceMatrix.needsUpdate = true;
        }
      }
      if (count === 0) return;
      for (let i = 0; i < n; i++) if (k.assigned[i] === li) unionSphere(acc, k.spheres, i * 4);
      for (const mesh of [level.opaque, level.transparent]) {
        if (!mesh) continue;
        mesh.boundingSphere!.center.set(acc[0]!, acc[1]!, acc[2]!);
        mesh.boundingSphere!.radius = acc[3]!;
      }
    });
  }

  // ── uploads ───────────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * every group that is one upload batch: a chunk part (its LOD levels and proxy), a far mesh, the `BatchedMesh`es of the
   * instanced keys, an instanced key (its meshes, or only its shadow proxy in a `BatchedMesh` build), a single row
   */
  batches(): Group[] {
    return [
      ...this.chunks.map((c) => c.group),
      ...this.fars.map((f) => f.group),
      ...(this.batched ? [this.batched.group] : []),
      ...this.instanced.map((k) => k.group).filter((g) => g.children.length > 0),
      ...this.singles.map((s) => s.group),
    ];
  }

  /** rows of the instanced keys per LOD level (index = level number, 0..5), as the partition last placed them */
  instanceLevelCounts(): number[] {
    const out = [0, 0, 0, 0, 0, 0];
    for (const k of this.instanced) for (let i = 0; i < k.rows.length; i++) if (k.assigned[i]! >= 0) out[k.levels[k.assigned[i]!]!.lod]!++;
    return out;
  }

  /** the layer-2 shadow proxies (chunk meshes, instanced meshes and single rows), for the real shadow render of the warm-up (render §7.2) */
  shadowProxies(): Array<Mesh | InstancedMesh> {
    const out: Array<Mesh | InstancedMesh> = [];
    for (const c of this.chunks) if (c.proxy) out.push(c.proxy);
    for (const k of this.instanced) if (k.proxy) out.push(k.proxy);
    for (const s of this.singles) if (s.proxy) out.push(s.proxy);
    return out;
  }

  /**
   * Runs `fn` under the warm-up rule (render §6.5) for the objects below `roots`: every mesh visible with
   * `frustumCulled = false`, empty instanced meshes given one instance, the camera's layers 0, 1 and 2 enabled. Everything is
   * put back afterwards, also when `fn` throws.
   */
  static async warm<T>(roots: readonly Object3D[], camera: Camera, fn: () => Promise<T>): Promise<T> {
    const saved: Array<{ o: Object3D; visible: boolean; culled: boolean; count: number | undefined }> = [];
    for (const root of roots) {
      root.traverse((o) => {
        const im = o as InstancedMesh;
        saved.push({ o, visible: o.visible, culled: o.frustumCulled, count: im.isInstancedMesh === true ? im.count : undefined });
        o.visible = true;
        o.frustumCulled = false;
        if (im.isInstancedMesh === true && im.count === 0) im.count = 1;
      });
    }
    const mask = camera.layers.mask;
    camera.layers.enable(LAYER_WORLD);
    camera.layers.enable(LAYER_THIRD_PERSON_ONLY);
    camera.layers.enable(LAYER_SHADOW_PROXY);
    try {
      return await fn();
    } finally {
      camera.layers.mask = mask;
      for (const s of saved) {
        s.o.visible = s.visible;
        s.o.frustumCulled = s.culled;
        if (s.count !== undefined) (s.o as InstancedMesh).count = s.count;
      }
    }
  }

  /**
   * Sends the map to the GPU without drawing it: one `compileAsync` per batch under the warm-up rule, yielding to the next
   * frame whenever the slice is used up. Flush the paint tables first (`MapPaint.flush`), and set the render target the scene
   * pass draws into before calling this: `compileAsync` keys what it creates on the current target.
   */
  async upload(renderer: BatchCompiler, camera: Camera, scene: Scene, opts: UploadOptions = {}): Promise<UploadStats> {
    const now = opts.now ?? ((): number => performance.now());
    const yieldFrame = opts.yieldFrame ?? defaultYield;
    const sliceMs = opts.sliceMs ?? 2;
    const stats: UploadStats = { batches: 0, slices: 0, ms: 0, maxBatchMs: 0, objects: 0 };
    const t0 = now();
    let sliceStart = t0;
    for (const group of this.batches()) {
      if (this.#disposed) break;
      const b0 = now();
      await MapBatcher.warm([group], camera, () => renderer.compileAsync(group, camera, scene));
      const b1 = now();
      stats.batches++;
      stats.objects += group.children.length;
      stats.maxBatchMs = Math.max(stats.maxBatchMs, b1 - b0);
      if (b1 - sliceStart >= sliceMs) {
        stats.slices++;
        await yieldFrame();
        sliceStart = now();
      }
    }
    stats.ms = now() - t0;
    return stats;
  }

  // ── promote on write, row writes ──────────────────────────────────────────────────────────────────────────────────────

  /** what draws a row now */
  classOf(rowId: string): 'chunk' | 'instanced' | 'single' | null {
    return this.#rows.get(rowId)?.kind ?? null;
  }

  /**
   * Promote on write (render §6.5): the first write to a batched row detaches it. Its key's geometry is requested (the batched
   * copy keeps drawing until it arrives), then in one step its index ranges are overwritten with degenerate triangles in every
   * level of its chunk part and in the part's far mesh (or it leaves its key's instance partition, or is hidden in the
   * `BatchedMesh`es) and it becomes a single row, which `setRowMatrix` and `setRowVisible` then move and hide. The row's
   * key may bring paint blocks of its own (a merged row's always does, an instanced row's in a `BatchedMesh` build): flush
   * the tables (`MapPaint.flush(renderer)`) and compile the returned group before the next draw. Resolves to null when the
   * key is empty.
   */
  async promote(rowId: string): Promise<SingleEntry | null> {
    const at = this.#rows.get(rowId);
    if (!at) throw new Error(`map-batcher: unknown row ${rowId}`);
    if (at.kind === 'single') return at.entry;
    const row = at.entry.rows[at.index]!;
    const g = await this.#keyGeometry(row.key, row.spec);
    const again = this.#rows.get(rowId);
    if (again && again.kind === 'single') return again.entry;
    this.#detach(rowId);
    if (!g || this.#disposed) return null;
    const single = this.#addSingle(g, { ...row, dynamic: true });
    single.group.updateMatrixWorld(true);
    this.#selectSingle(single);
    return single;
  }

  #selectSingle(s: SingleEntry): void {
    const d = Number.isNaN(this.#last.x) ? 0 : Math.max(0, Math.hypot(s.sphere[0]! - this.#last.x, s.sphere[1]! - this.#last.y, s.sphere[2]! - this.#last.z) - s.sphere[3]!);
    s.current = Math.min(s.levels.length - 1, selectLodIndex(-1, d, this.bands.distances));
    s.levels.forEach((l, i) => {
      if (l.opaque) l.opaque.visible = i === s.current;
      if (l.transparent) l.transparent.visible = i === s.current;
    });
  }

  /** takes a batched row out of its chunk or its instance partition */
  #detach(rowId: string): void {
    const at = this.#rows.get(rowId);
    if (!at || at.kind === 'single') return;
    if (at.kind === 'chunk') {
      for (const level of at.entry.levels) {
        // a level that draws from its far mesh loses the row with the far mesh, below
        if (level.shared) continue;
        const ranges = removeRowFromIndex(level.packed.idx, level.packed.rowRanges, at.index);
        for (const r of ranges) level.attrs.index.addUpdateRange(r.start, r.count);
        if (ranges.length > 0) level.attrs.index.needsUpdate = true;
      }
      // the row is in its far mesh too
      const far = at.entry.far;
      if (far) {
        const ranges = removeRowFromIndex(far.packed.idx, far.packed.rowRanges, at.entry.farRow0 + at.index);
        for (const r of ranges) far.attrs.index.addUpdateRange(r.start, r.count);
        if (ranges.length > 0) far.attrs.index.needsUpdate = true;
      }
    } else {
      at.entry.assigned[at.index] = -2;
      this.#writeInstances(at.entry);
      // the shadow proxy holds every caster: rebuild its list without the row
      const proxy = at.entry.proxy;
      if (proxy) {
        const k = at.entry;
        const src = k.levels[k.levels.length - 1]!.matrices;
        const acc = [0, 0, 0, -1];
        let count = 0;
        k.rows.forEach((r, i) => {
          if (k.assigned[i] === -2 || r.castShadow === false) return;
          proxy.instanceMatrix.array.set(src.subarray(i * 16, i * 16 + 16), count * 16);
          unionSphere(acc, k.spheres, i * 4);
          count++;
        });
        proxy.count = count;
        proxy.visible = count > 0;
        if (count > 0) {
          proxy.boundingSphere!.center.set(acc[0]!, acc[1]!, acc[2]!);
          proxy.boundingSphere!.radius = acc[3]!;
          proxy.instanceMatrix.needsUpdate = true;
        }
      }
    }
    this.#rows.delete(rowId);
  }

  /**
   * A row spawned during play (door shards and stumps, X-43): a single row of its key. The key is generated on demand
   * (runtime priority in the service) and its paints append to the place's tables: flush them (`MapPaint.flush(renderer)`,
   * a partial upload) and compile the returned group before it is first drawn. Resolves to null when the key is empty.
   */
  async addRow(row: BatcherRow): Promise<SingleEntry | null> {
    if (this.#rows.has(row.id)) throw new Error(`map-batcher: row ${row.id} exists`);
    const g = await this.#keyGeometry(row.key, row.spec);
    if (!g || this.#disposed) return null;
    const single = this.#addSingle(g, row);
    single.group.updateMatrixWorld(true);
    this.#selectSingle(single);
    return single;
  }

  /** Removes a row for good (despawn): a single row's meshes go, a batched row leaves its chunk or partition. */
  removeRow(rowId: string): void {
    const at = this.#rows.get(rowId);
    if (!at) return;
    if (at.kind !== 'single') {
      this.#detach(rowId);
      return;
    }
    // the key's geometries stay cached for the next row of the key
    at.entry.group.removeFromParent();
    at.entry.rig?.skeleton.dispose();
    const i = this.singles.indexOf(at.entry);
    if (i >= 0) this.singles.splice(i, 1);
    this.#rows.delete(rowId);
  }

  /**
   * Runtime regeneration (render §6.9): a `primitive.params` write gives the row a new key. The new key is requested first,
   * and the row's old mesh (or its batched copy) keeps drawing until it has arrived; then the row becomes a single row of
   * the new key at its current matrix. Resolves to null when the new key is empty (the row then draws nothing).
   */
  async regenerate(rowId: string, key: string, spec: ScriptedSpec): Promise<SingleEntry | null> {
    const at = this.#rows.get(rowId);
    if (!at) throw new Error(`map-batcher: unknown row ${rowId}`);
    const row = at.kind === 'single' ? at.entry.row : at.entry.rows[at.index]!;
    const g = await this.#keyGeometry(key, spec);
    if (this.#disposed) return null;
    this.removeRow(rowId);
    if (!g) return null;
    const single = this.#addSingle(g, { ...row, key, spec, dynamic: true });
    single.group.updateMatrixWorld(true);
    this.#selectSingle(single);
    return single;
  }

  /** Moves a single row (a dynamic row, or one that was promoted). `m` is its world matrix, column-major. */
  setRowMatrix(rowId: string, m: ArrayLike<number>): void {
    const at = this.#rows.get(rowId);
    if (!at || at.kind !== 'single') throw new Error(`map-batcher: row ${rowId} is not a single row (promote it first)`);
    const s = at.entry;
    const rowM = new Matrix4().fromArray(m);
    (s.row.m as Float32Array).set(m as ArrayLike<number>);
    instanceSphere(s.key.levels[0]!.bboxMin, s.key.levels[0]!.bboxMax, m, s.sphere);
    if (s.rig) {
      // K3: the meshes sit under the rig root with the identity matrix; the bones are written from the root's world matrix,
      // which must be current before the presentation pass (three-skin.ts precondition)
      s.sphere[3] = s.sphere[3]! * RIG_SPHERE_GROWTH;
      s.rig.root.matrix.copy(rowM);
      s.rig.root.updateWorldMatrix(true, true, true);
      return;
    }
    for (const l of s.levels) {
      for (const mesh of [l.opaque, l.transparent]) {
        if (!mesh) continue;
        mesh.matrix.multiplyMatrices(rowM, l.dequant);
        mesh.matrixWorldNeedsUpdate = true;
      }
    }
    if (s.proxy && s.proxyDequant) {
      s.proxy.matrix.multiplyMatrices(rowM, s.proxyDequant);
      s.proxy.matrixWorldNeedsUpdate = true;
    }
  }

  setRowVisible(rowId: string, visible: boolean): void {
    const at = this.#rows.get(rowId);
    if (!at || at.kind !== 'single') throw new Error(`map-batcher: row ${rowId} is not a single row (promote it first)`);
    at.entry.group.visible = visible;
  }

  // ── bookkeeping ───────────────────────────────────────────────────────────────────────────────────────────────────────

  stats(): MapBatcherStats {
    const s: MapBatcherStats = {
      chunks: this.chunks.length, cells: this.#cells, chunkMeshes: 0, farGroups: this.fars.length, farMeshes: 0,
      batchedMeshes: (this.batched?.opaque ? 1 : 0) + (this.batched?.transparent ? 1 : 0),
      instancedKeys: this.instanced.length, instancedRows: 0, instancedMeshes: 0, singles: this.singles.length,
      shadowProxies: this.shadowProxies().length, triangles: 0, bytes: 0, paints: this.#opts.paint.records.count, paintEntries: this.#opts.paint.index.count, skippedKeys: [...this.#skipped],
    };
    for (const c of this.chunks) {
      for (const l of c.levels) {
        s.chunkMeshes += (l.opaque ? 1 : 0) + (l.transparent ? 1 : 0);
        // a level that draws from its far mesh is counted with the far mesh
        if (l.shared) continue;
        s.triangles += l.packed.tris;
        s.bytes += l.packed.vtx.byteLength + l.packed.idx.byteLength + (l.packed.normals?.byteLength ?? 0);
      }
    }
    for (const f of this.fars) {
      s.farMeshes += (f.opaque ? 1 : 0) + (f.transparent ? 1 : 0);
      s.triangles += f.packed.tris;
      s.bytes += f.packed.vtx.byteLength + f.packed.idx.byteLength + (f.packed.normals?.byteLength ?? 0);
    }
    for (const k of this.instanced) {
      s.instancedRows += k.rows.length;
      for (const l of k.levels) s.instancedMeshes += (l.opaque ? 1 : 0) + (l.transparent ? 1 : 0);
    }
    return s;
  }

  /** what the world camera would draw now: meshes that are visible with something to draw, and their triangles (no culling) */
  visibleCounts(): { draws: number; triangles: number } {
    let draws = 0;
    let triangles = 0;
    const add = (mesh: Mesh | InstancedMesh | null, instances: number): void => {
      if (!mesh || !mesh.visible || instances === 0) return;
      draws++;
      triangles += (mesh.geometry.drawRange.count / 3) * instances;
    };
    for (const c of this.chunks) {
      for (const l of c.levels) {
        add(l.opaque, 1);
        add(l.transparent, 1);
      }
    }
    for (const f of this.fars) {
      add(f.opaque, 1);
      add(f.transparent, 1);
    }
    // a BatchedMesh is one draw per pass with anything in it; its triangles are those of every placed row (three culls per instance)
    const batchHas = { opaque: false, transparent: false };
    for (const k of this.instanced) {
      if (k.batch) {
        for (let i = 0; i < k.rows.length; i++) {
          const level = k.levels[k.assigned[i]!];
          if (!level) continue;
          triangles += level.opaqueTris + level.transparentTris;
          if (level.opaqueTris > 0 && k.batch.opaque) batchHas.opaque = true;
          if (level.transparentTris > 0 && k.batch.transparent) batchHas.transparent = true;
        }
        continue;
      }
      for (const l of k.levels) {
        add(l.opaque, l.opaque?.count ?? 0);
        add(l.transparent, l.transparent?.count ?? 0);
      }
    }
    draws += (batchHas.opaque ? 1 : 0) + (batchHas.transparent ? 1 : 0);
    for (const s of this.singles) {
      if (!s.group.visible) continue;
      for (const l of s.levels) {
        add(l.opaque, 1);
        add(l.transparent, 1);
      }
    }
    return { draws, triangles };
  }

  /** frees every geometry (their GPU buffers go with them); materials belong to the variant cache, the tables to the caller */
  dispose(): void {
    this.#disposed = true;
    this.root.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh === true) mesh.geometry.dispose();
    });
    for (const s of this.singles) s.rig?.skeleton.dispose();
    // a BatchedMesh owns three data textures besides its geometry
    this.batched?.opaque?.dispose();
    this.batched?.transparent?.dispose();
    this.batched = null;
    this.root.removeFromParent();
    this.root.clear();
    this.chunks.length = 0;
    this.fars.length = 0;
    this.instanced.length = 0;
    this.singles.length = 0;
    this.#rows.clear();
    this.#keys.clear();
  }
}
