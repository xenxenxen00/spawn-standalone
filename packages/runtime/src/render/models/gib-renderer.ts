// Gib rendering (docs/design/rendering.md §11.6; WP R7).
//
// Sources (asset-inventory.md §12.1, system-gore.md §7): per-archetype region gibs (flat copies of body materials),
// skull fragments (textured with a per-archetype skin set + the shared wound set), brains (one organ set) and
// props/library pieces (flat). One `BatchedMesh` per texture set and pass, with the model paint path: the flat region
// gibs and prop pieces share one batch (no textures), the skull fragments one per archetype skin set present in the
// match, the brains one. Every piece type of the set is an `addGeometry` entry; each live gib is an instance.
//
// The bridge writes the interpolated body poses (render §16.2) with `setPose`, written with `setMatrixAt` from the gib's
// own records, so 220 gibs cost no scene nodes (render §16.3). A gib lives until `remove()`: its row's lifetime is the
// game's (`gibLife`, 12-40 s, the gore pool's cap), and the live fade is the game's own write of the row's `scale`
// over the last 0.9 s (`poolFade`, scripts/gore/gore.js:1063-1064), which reaches the renderer inside the pose matrix.
// `GibSpawnOptions.ttlMs` adds a renderer-side fade instead, `scale × (1 − 0.9·fade)` over that span from the spawn,
// then expiry, applied by `tick()` (for pieces no row drives). Gib batches use
// `frustumCulled = false` and `perObjectFrustumCulled = false` (they are few and move every frame). Without
// `WEBGL_multi_draw` (where `BatchedMesh` draws once per instance) the renderer falls back to one `InstancedMesh` per
// piece type, `frustumCulled = false`, empty ones `visible = false`.
//
// Render budget (render §15.3, §15.5): the live gib cap is `budget.cap('gibs', profileCap)` — `min(gore maxGibs,
// tier.gibCap)` — enforced on every `spawn()` (the oldest gib is evicted past it) and re-applied by `syncBudget()`, so
// a mid-session tier drop takes effect at once. Batched, the gibs cost 3–8 draws with `WEBGL_multi_draw` (render §15.5);
// one `InstancedMesh` per piece type (391 meshes, 50–150 draws for 220 extreme gibs) would blow the draw budget, so
// that layout exists only as the no-extension fallback.
import {
  BatchedMesh,
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  InstancedMesh,
  Matrix4,
  Object3D,
} from 'three/webgpu';
import type { RenderBudget } from '../perf/budget.ts';
import { supportsMultiDraw } from '../geometry/map-batcher.ts';
import type { AnySurfaceMaterial } from '../surface/surface-material.ts';

/** scripts/gore/gore.js:80 (`fadeS: 0.9`), 1063-1064: a fading gib shrinks over its last 0.9 s */
export const GIB_TTL_MS = 900;

/** the fade's end scale: `scale × (1 − 0.9·fade)` */
export const GIB_END_SCALE = 0.1;

/** a set created by `addPiece` reserves this many times its first piece, then doubles */
const GIB_SET_HEADROOM = 8;

/** a gib render pass */
export type GibPass = 'opaque' | 'transparent';

/** one gib piece type: a chunk geometry in a texture set's batch */
export interface GibPieceSpec {
  /** unique piece type id */
  id: string;
  /**
   * texture-set key: pieces sharing a key share one `BatchedMesh` (and one material). `''` = flat, no textures
   * (the region gibs and prop pieces); otherwise one key per archetype skin set, plus the brains' organ set.
   */
  set: string;
  /**
   * the piece geometry, `{position, normal, uv, ss}` + index, where `ss` holds table-wide paint ids into the shared
   * model paint table (the model paint path, render §7.6); `uv` may be zeros. The renderer clones and normalizes it.
   */
  geometry: BufferGeometry;
  /** max live instances of this piece (the fallback `InstancedMesh` is sized to this); default `profileCap` */
  maxInstances?: number;
}

export interface GibSpawnOptions {
  /**
   * a renderer-side lifetime in ms: the gib fades over it from the spawn and expires (`tick()`); default none, the gib
   * lives until `remove()` and its pose carries the row's own fade
   */
  ttlMs?: number | null;
  /** base scale the fade multiplies; default 1 */
  scale?: number;
}

export interface GibRendererOptions {
  /** the batches are added here */
  scene: Object3D;
  budget: RenderBudget;
  /** gore `maxGibs` (the profile cap); the live cap is `min(profile, tier)` */
  profileCap: number;
  pieces: GibPieceSpec[];
  /**
   * the integrator's shared per-set materials (paint ids are table-wide). Return null for the transparent pass of a
   * set with no transparent pieces: that set then draws opaque only.
   */
  materialFor: (set: string, pass: GibPass) => AnySurfaceMaterial | null;
  /** default: `supportsMultiDraw(renderer)` when a renderer is given, else false */
  multiDraw?: boolean;
  renderer?: { backend?: unknown };
  /** clock for the fade; default `performance.now` */
  now?: () => number;
  /** one line per anomaly; default `console.warn` */
  log?: (message: string) => void;
}

interface GibSet {
  key: string;
  pieces: GibPiece[];
  /** the opaque pass's material, then the transparent one's when the set has one */
  materials: AnySurfaceMaterial[];
  batches: Array<{ batch: BatchedMesh; geometryId: Map<GibPiece, number>; maxVertices: number; maxIndices: number; usedVertices: number; usedIndices: number }>;
}

interface GibPiece {
  spec: GibPieceSpec;
  /** the normalized geometry the renderer owns */
  geometry: BufferGeometry;
  set: GibSet;
  /** batch instances of this piece, one per pass */
  batchGeometryIds: number[];
  /** fallback meshes, one per pass; gib ids in slot order */
  fallback: InstancedMesh[];
  order: number[];
}

interface GibRecord {
  id: number;
  piece: GibPiece;
  pose: Matrix4;
  scale: number;
  /** null: no renderer-side fade, the gib lives until `remove()` */
  ttlMs: number | null;
  birth: number;
  /** batch path: one instance id per pass */
  instanceIds: number[];
  /** fallback path: the slot in `piece.order` */
  slot: number;
}

/** Batched gib rendering with lifetime fade and cap eviction (render §11.6). */
export class GibRenderer {
  readonly #scene: Object3D;
  readonly #budget: RenderBudget;
  readonly #profileCap: number;
  readonly #now: () => number;
  readonly #log: (message: string) => void;
  readonly #multiDraw: boolean;
  readonly #materialFor: GibRendererOptions['materialFor'];
  readonly #pieces = new Map<string, GibPiece>();
  readonly #sets: GibSet[] = [];
  readonly #gibs = new Map<number, GibRecord>();
  #nextId = 1;
  /** live gibs spawned with `ttlMs`: `tick` has nothing to do (and allocates nothing) while there are none */
  #faded = 0;
  #disposed = false;
  readonly #scratch = new Matrix4();

  constructor(opts: GibRendererOptions) {
    if (!Number.isInteger(opts.profileCap) || opts.profileCap <= 0) {
      throw new RangeError(`GibRenderer: profileCap must be a positive integer, got ${String(opts.profileCap)}`);
    }
    this.#scene = opts.scene;
    this.#budget = opts.budget;
    this.#profileCap = opts.profileCap;
    this.#now = opts.now ?? (() => performance.now());
    this.#log = opts.log ?? ((m) => console.warn(m));
    this.#multiDraw = opts.multiDraw ?? (opts.renderer !== undefined ? supportsMultiDraw(opts.renderer) : false);

    this.#materialFor = opts.materialFor;

    const seen = new Set<string>();
    for (const spec of opts.pieces) {
      if (seen.has(spec.id)) throw new Error(`GibRenderer: duplicate piece id "${spec.id}"`);
      seen.add(spec.id);
      this.#checkPiece(spec);
    }

    // group the pieces by texture set: each set's batches are sized to its pieces exactly
    const bySet = new Map<string, GibPieceSpec[]>();
    for (const spec of opts.pieces) {
      const list = bySet.get(spec.set);
      if (list !== undefined) list.push(spec);
      else bySet.set(spec.set, [spec]);
    }
    for (const [key, specs] of bySet) {
      const geometries = specs.map((spec) => normalizePieceGeometry(spec));
      let vertexCount = 0, indexCount = 0;
      for (const g of geometries) {
        vertexCount += g.getAttribute('position')!.count;
        indexCount += g.getIndex()!.count;
      }
      const set = this.#createSet(key, vertexCount, indexCount);
      for (let i = 0; i < specs.length; i++) this.#addToSet(set, specs[i]!, geometries[i]!);
    }
  }

  /**
   * Adds a piece type after construction (a gib model the integrator loaded late, render §11.6): a new texture set gets
   * its batches, an existing set's batches grow to hold it (`BatchedMesh.setGeometrySize`, doubling; the live gibs keep
   * their instances). False when a piece of that id exists already.
   */
  addPiece(spec: GibPieceSpec): boolean {
    if (this.#disposed) throw new Error('GibRenderer: addPiece on a disposed renderer');
    if (this.#pieces.has(spec.id)) return false;
    this.#checkPiece(spec);
    const geometry = normalizePieceGeometry(spec);
    const v = geometry.getAttribute('position')!.count;
    const i = geometry.getIndex()!.count;
    const set = this.#sets.find((x) => x.key === spec.set) ?? this.#createSet(spec.set, v * GIB_SET_HEADROOM, i * GIB_SET_HEADROOM);
    for (const b of set.batches) {
      if (b.usedVertices + v <= b.maxVertices && b.usedIndices + i <= b.maxIndices) continue;
      b.maxVertices = Math.max(b.maxVertices * 2, b.usedVertices + v);
      b.maxIndices = Math.max(b.maxIndices * 2, b.usedIndices + i);
      b.batch.setGeometrySize(b.maxVertices, b.maxIndices);
    }
    this.#addToSet(set, spec, geometry);
    return true;
  }

  #checkPiece(spec: GibPieceSpec): void {
    const maxInstances = spec.maxInstances ?? this.#profileCap;
    if (!Number.isInteger(maxInstances) || maxInstances <= 0) {
      throw new RangeError(`GibRenderer: piece "${spec.id}" maxInstances must be a positive integer, got ${String(spec.maxInstances)}`);
    }
  }

  /** a texture set's materials and, on the batch path, its batches reserved for `vertexCount` / `indexCount` */
  #createSet(key: string, vertexCount: number, indexCount: number): GibSet {
    const opaque = this.#materialFor(key, 'opaque');
    if (opaque === null) throw new Error(`GibRenderer: no opaque material for gib set "${key}"`);
    const transparent = this.#materialFor(key, 'transparent');
    const materials = transparent !== null ? [opaque, transparent] : [opaque];
    const set: GibSet = { key, pieces: [], batches: [], materials };
    if (this.#multiDraw) {
      for (let p = 0; p < materials.length; p++) {
        const maxVertices = Math.max(vertexCount, 1);
        const maxIndices = Math.max(indexCount, 1);
        const batch = new BatchedMesh(this.#profileCap, maxVertices, maxIndices, materials[p]!);
        batch.name = `ss:gibs:${key === '' ? 'flat' : key}:${p === 0 ? 'opaque' : 'transparent'}`;
        // few and moving every frame: no culling at all (render §11.6)
        batch.frustumCulled = false;
        batch.perObjectFrustumCulled = false;
        // a world model receives on every tier; the warm-up's gib proxies receive (models/shader-variants.ts)
        batch.receiveShadow = true;
        this.#scene.add(batch);
        set.batches.push({ batch, geometryId: new Map(), maxVertices, maxIndices, usedVertices: 0, usedIndices: 0 });
      }
    }
    this.#sets.push(set);
    return set;
  }

  #addToSet(set: GibSet, spec: GibPieceSpec, geometry: BufferGeometry): void {
    const piece: GibPiece = { spec, geometry, set, batchGeometryIds: [], fallback: [], order: [] };
    set.pieces.push(piece);
    this.#pieces.set(spec.id, piece);
    if (this.#multiDraw) {
      const v = geometry.getAttribute('position')!.count;
      const i = geometry.getIndex()!.count;
      for (const b of set.batches) {
        const id = b.batch.addGeometry(geometry);
        b.geometryId.set(piece, id);
        b.usedVertices += v;
        b.usedIndices += i;
        piece.batchGeometryIds.push(id);
      }
      return;
    }
    const maxInstances = spec.maxInstances ?? this.#profileCap;
    for (let p = 0; p < set.materials.length; p++) {
      const mesh = new InstancedMesh(geometry, set.materials[p]!, maxInstances);
      mesh.name = `ss:gibs:${spec.id}:${p === 0 ? 'opaque' : 'transparent'}`;
      mesh.frustumCulled = false;
      mesh.receiveShadow = true;
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      mesh.visible = false;
      mesh.count = 0;
      this.#scene.add(mesh);
      piece.fallback.push(mesh);
    }
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /** live gibs */
  get live(): number {
    return this.#gibs.size;
  }

  /** the live cap: `min(gore maxGibs, tier.gibCap)` */
  cap(): number {
    return this.#budget.cap('gibs', this.#profileCap);
  }

  /** whether a piece type of that id was built */
  hasPiece(pieceId: string): boolean {
    return this.#pieces.has(pieceId);
  }

  /** whether the batch path is in use */
  get batched(): boolean {
    return this.#multiDraw;
  }

  /**
   * Spawns a gib of a piece type at a pose. Past the live cap the oldest gib is evicted first. Returns the gib id,
   * or null for an unknown piece (logged).
   */
  spawn(pieceId: string, matrix: Matrix4, opts: GibSpawnOptions = {}): number | null {
    if (this.#disposed) throw new Error('GibRenderer: spawn on a disposed renderer');
    const piece = this.#pieces.get(pieceId);
    if (piece === undefined) {
      this.#log(`GibRenderer: unknown piece "${pieceId}"; gib not spawned`);
      return null;
    }
    const ttlMs = opts.ttlMs ?? null;
    if (ttlMs !== null && (!Number.isFinite(ttlMs) || ttlMs <= 0)) throw new RangeError(`GibRenderer: ttlMs must be positive, got ${String(opts.ttlMs)}`);
    const scale = opts.scale ?? 1;
    if (!Number.isFinite(scale) || scale <= 0) throw new RangeError(`GibRenderer: scale must be positive, got ${String(opts.scale)}`);

    while (this.#gibs.size > 0 && this.#gibs.size >= this.cap()) this.#evictOldest();

    const id = this.#nextId++;
    const gib: GibRecord = {
      id,
      piece,
      pose: matrix.clone(),
      scale,
      ttlMs,
      birth: this.#now(),
      instanceIds: [],
      slot: -1,
    };
    if (this.#multiDraw) {
      for (let p = 0; p < piece.set.batches.length; p++) {
        const b = piece.set.batches[p]!;
        const instanceId = b.batch.addInstance(piece.batchGeometryIds[p]!);
        gib.instanceIds.push(instanceId);
      }
    } else {
      const slot = piece.order.length;
      const maxInstances = piece.spec.maxInstances ?? this.#profileCap;
      if (slot >= maxInstances) {
        this.#log(`GibRenderer: piece "${pieceId}" is at its ${maxInstances} fallback instances; gib not spawned`);
        return null;
      }
      piece.order.push(id);
      gib.slot = slot;
      for (const mesh of piece.fallback) {
        mesh.visible = true;
        mesh.count = piece.order.length;
      }
    }
    this.#gibs.set(id, gib);
    if (ttlMs !== null) this.#faded++;
    this.#writeMatrix(gib, 1);
    return id;
  }

  /**
   * updates a gib's base pose (the bridge's interpolated body pose, render §16.2, with the row's scale): written at once
   * for a gib without `ttlMs`; a renderer-faded gib is written by `tick()`
   */
  setPose(id: number, matrix: Matrix4): boolean {
    const gib = this.#gibs.get(id);
    if (gib === undefined || this.#disposed) return false;
    gib.pose.copy(matrix);
    if (gib.ttlMs === null) this.#writeMatrix(gib, 1);
    return true;
  }

  /**
   * Advances the renderer-side fades: writes `pose × scale × (1 − 0.9·fade)` for every gib spawned with `ttlMs` and
   * expires the finished ones. The bridge calls this once per frame; `setPose` per physics tick.
   */
  tick(now: number = this.#now()): void {
    if (this.#disposed || this.#faded === 0) return;
    for (const id of [...this.#gibs.keys()]) {
      const gib = this.#gibs.get(id);
      if (gib === undefined || gib.ttlMs === null) continue;
      const fade = Math.min((now - gib.birth) / gib.ttlMs, 1);
      if (fade >= 1) {
        this.remove(id);
        continue;
      }
      this.#writeMatrix(gib, 1 - 0.9 * fade);
    }
  }

  /** removes one gib immediately */
  remove(id: number): boolean {
    const gib = this.#gibs.get(id);
    if (gib === undefined) return false;
    this.#gibs.delete(id);
    if (gib.ttlMs !== null) this.#faded--;
    const piece = gib.piece;
    if (this.#multiDraw) {
      for (let p = 0; p < piece.set.batches.length; p++) {
        piece.set.batches[p]!.batch.deleteInstance(gib.instanceIds[p]!);
      }
    } else {
      const lastId = piece.order.pop()!;
      if (lastId !== id) {
        const last = this.#gibs.get(lastId)!;
        piece.order[gib.slot] = lastId;
        last.slot = gib.slot;
        // the moved gib keeps its current fade: copy its written matrices into the freed slot
        for (const mesh of piece.fallback) {
          mesh.getMatrixAt(piece.order.length, this.#scratch);
          mesh.setMatrixAt(gib.slot, this.#scratch);
          mesh.instanceMatrix.needsUpdate = true;
        }
      }
      for (const mesh of piece.fallback) {
        mesh.count = piece.order.length;
        if (piece.order.length === 0) mesh.visible = false;
      }
    }
    return true;
  }

  /** re-reads the live cap and evicts oldest-first down to it (a mid-session tier drop takes effect at once) */
  syncBudget(): void {
    if (this.#disposed) return;
    while (this.#gibs.size > this.cap()) this.#evictOldest();
  }

  /** removes every gib and the batches; the materials are the integrator's */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const id of [...this.#gibs.keys()]) this.remove(id);
    for (const set of this.#sets) {
      for (const b of set.batches) {
        b.batch.removeFromParent();
        b.batch.dispose();
      }
      for (const piece of set.pieces) {
        for (const mesh of piece.fallback) {
          mesh.removeFromParent();
          mesh.dispose();
        }
        piece.geometry.dispose();
      }
    }
    this.#pieces.clear();
    this.#sets.length = 0;
  }

  #evictOldest(): void {
    const oldest = this.#gibs.keys().next();
    if (!oldest.done) this.remove(oldest.value);
  }

  /** writes `pose × scale × fadeScale` for the gib's instances */
  #writeMatrix(gib: GibRecord, fadeScale: number): void {
    const s = gib.scale * fadeScale;
    const m = this.#scratch.copy(gib.pose);
    const e = m.elements;
    e[0]! *= s; e[1]! *= s; e[2]! *= s;
    e[4]! *= s; e[5]! *= s; e[6]! *= s;
    e[8]! *= s; e[9]! *= s; e[10]! *= s;
    const piece = gib.piece;
    if (this.#multiDraw) {
      for (let p = 0; p < piece.set.batches.length; p++) {
        piece.set.batches[p]!.batch.setMatrixAt(gib.instanceIds[p]!, m);
      }
    } else {
      for (const mesh of piece.fallback) {
        mesh.setMatrixAt(gib.slot, m);
        mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }
}

/**
 * Normalizes a piece geometry to the batch attribute set `{position, normal, uv, ss}` + index. `uv` is zeros when
 * absent; `position`, `normal`, `ss` (table-wide paint ids) and the index are required — a piece without them cannot
 * draw on the model paint path.
 */
function normalizePieceGeometry(spec: GibPieceSpec): BufferGeometry {
  const src = spec.geometry;
  const position = src.getAttribute('position');
  if (position === undefined || position.itemSize !== 3) {
    throw new Error(`GibRenderer: piece "${spec.id}" needs a vec3 position attribute`);
  }
  const normal = src.getAttribute('normal');
  if (normal === undefined || normal.itemSize !== 3) {
    throw new Error(`GibRenderer: piece "${spec.id}" needs a vec3 normal attribute`);
  }
  const ss = src.getAttribute('partPaint');
  if (ss === undefined || ss.itemSize !== 4 || !(ss.array instanceof Uint8Array)) {
    throw new Error(`GibRenderer: piece "${spec.id}" needs a normalized ubyte4 ss attribute (table-wide paint ids)`);
  }
  const index = src.getIndex();
  if (index === null) throw new Error(`GibRenderer: piece "${spec.id}" needs an index`);
  const g = new BufferGeometry();
  g.name = `ss:gib:${spec.id}`;
  g.setAttribute('position', new BufferAttribute(new Float32Array(position.array as ArrayLike<number>), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(normal.array as ArrayLike<number>), 3));
  const uvAttr = src.getAttribute('uv');
  const uv = uvAttr !== undefined && uvAttr.itemSize === 2
    ? new Float32Array(uvAttr.array as ArrayLike<number>)
    : new Float32Array(position.count * 2);
  g.setAttribute('uv', new BufferAttribute(uv, 2));
  g.setAttribute('partPaint', new BufferAttribute(new Uint8Array(ss.array), 4, true));
  g.setIndex(new BufferAttribute(index.array.slice() as Uint16Array | Uint32Array, 1));
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}
