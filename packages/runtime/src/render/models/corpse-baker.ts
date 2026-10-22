// Corpse baking and batching (docs/design/rendering.md §11.5; X-20, X-40; WP R7).
//
// A dead enemy's corpse row gets its own `ModelInstance` (X-20: the game spawns the row, no game edit). Once its death
// clip holds its end pose, the row is baked here into a static `BufferGeometry` and the skeleton is disposed:
//
//   `CorpseBaker`   queues bakes and runs them as a time slice of the bridge step: ≤ `CORPSE_BAKE_SLICE_MS` per `step()`
//                   (0.3 ms at high/1×, render §11.5), one bake at a time, the remainder carried to the next frame.
//   `CorpseBatcher` draws the baked corpses: one `BatchedMesh` per surface material and pass (opaque, transparent). The
//                   material is the baked instance's own (a template's texture sets are part of its material, so two
//                   archetypes never share a batch); paint ids are table-wide, so every corpse of one material shares
//                   its batch. Without `WEBGL_multi_draw` it falls back to one `Mesh` per corpse (render §15.5).
//
// The bake is our own flat loop, not `SkinnedMesh.applyBoneTransform` (render §11.5 [F]): `skeleton.update()` once fills
// `skeleton.boneMatrices`, then positions (w = 1) and normals (w = 0, renormalised) are skinned from the template's typed
// arrays with those matrices — premultiplied once by the corpse root's inverse world matrix, so the result is
// root-relative — in one `Float32Array` loop writing into preallocated outputs. (The template binds its skinned meshes
// with an identity bind matrix, model-template.ts, so `boneMatrices` alone takes a bind-space vertex to the world.) A
// static template's vertices are taken through the mesh's own matrix relative to the root. Hidden-part triangles (the
// look row's part mask) are removed from the index; slot overrides stay in the look row, which the baked corpse keeps:
// the baker detaches the instance's row (`ModelInstance.detachLookRow`) and the batcher's `add()` retags it as a
// `'corpse'` row (`LookTable.retag`), so a full table evicts the oldest baked corpse's row first (render §7.6).
//
// Bone-attached children survive the bake (X-40): for every bone name the bake is given, the finished result carries one
// frozen, non-skeletal `Object3D` parented under the corpse root, holding the bone's final world pose relative to the
// root. The bridge re-parents the wound/probe children to these anchors (and any later bone-attached child resolves to
// them). Sim-side bone reads keep working through the `FrozenPose` motion's `Mixer.release({ keepFinalPose: true })`
// leaves on the mixer (`src/compat/motion/attach.ts`); the baker does not need the pose itself.
//
// Per-corpse look rows in the batch path (render §11.5): three's TSL batch path exposes the instance id as the
// `batchIndirectIndex` varying (`three/src/nodes/accessors/Batch.js`). The look table owns one small texture of batch
// rows (`LookTable.batchRows`): each corpse batch takes one texel row of it (`allocateBatch`), written at its instance
// ids, and carries that row number in `userData[CORPSE_BATCH_KEY]`. The model surface stage reads it with
// `batchIndirectIndex` when the object being compiled is such a batch (look-table.ts `modelInputs`); every other object
// keeps the per-object `ssLookRow` uniform, so the no-extension fallback (one `Mesh` per corpse, `setLookRow`) needs no
// shader change.
//
// Render budget (render §15.3, §15.5): the live corpse cap is `budget.cap('corpses', profileCap)` —
// `min(gore corpseMax, tier.corpseCap)` — asked on every `add()`, so a mid-session tier drop takes effect at once
// (`syncBudget()` evicts down to the new cap immediately). Geometry slots are reserved at
// `maxVerticesPerCorpse × maxIndicesPerCorpse` and reused in place (`setGeometryAt` over a free stack):
// `BatchedMesh.deleteGeometry` frees the geometry id but its ranges stay bump-allocated, so per-eviction delete would
// exhaust the preallocated buffers under lifetime churn; at most `bucketCapacity` `addGeometry` calls happen per batch,
// ever. A bake larger than one slot, or a material past the batch-row texture, draws through the `Mesh` fallback.
import { BatchedMesh, BufferAttribute, BufferGeometry, Matrix4, Mesh, Object3D } from 'three/webgpu';
import type { RenderBudget } from '../perf/budget.ts';
import { supportsMultiDraw } from '../geometry/map-batcher.ts';
import { CORPSE_BATCH_KEY, CORPSE_BATCH_MAX_INSTANCES, PART_NEVER_HIDDEN, setLookRow, type LookTable } from '../surface/look-table.ts';
import type { AnySurfaceMaterial } from '../surface/surface-material.ts';
import type { ModelInstance } from './model-instance.ts';

export { CORPSE_BATCH_KEY };

/** render §11.5: the per-frame time slice one bake may take (high, 1×) */
export const CORPSE_BAKE_SLICE_MS = 0.3;

/** instances (and geometry slots) a new corpse batch reserves before it grows (`CorpseBatcherOptions.bucketInitial`) */
export const CORPSE_BUCKET_INITIAL = 8;

/** vertices skinned between two clock reads inside one `step()` */
const BAKE_CHUNK_VERTICES = 64;

// ── the baker ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CorpseBakerOptions {
  /** per-frame slice in ms; default `CORPSE_BAKE_SLICE_MS` */
  sliceMs?: number;
  /** clock the slice is measured with; default `performance.now` */
  now?: () => number;
  /** one line per skipped anchor or other bake anomaly; default `console.warn` */
  log?: (message: string) => void;
  /** called once per finished bake, in queue order */
  onReady: (result: CorpseBakeResult) => void;
}

/**
 * A finished bake. The batcher's `add()` takes ownership of the geometry and the look row (retags it as a `'corpse'`
 * row); after `add()` do not call `dispose()`. Without `add()`, `dispose()` abandons the result: it releases the look
 * row, disposes the geometry and removes the root.
 */
export interface CorpseBakeResult {
  /** baked static geometry: `{position, normal, uv, ss}` + index, root-relative, exact bounds; `uv` is zeros when the template has no texture set */
  readonly geometry: BufferGeometry;
  /** the detached look row (0 = the neutral row); the batcher retags and owns it after `add()` */
  readonly lookRow: number;
  /** the instance root's world matrix at bake time */
  readonly rootMatrix: Matrix4;
  /** the corpse root: holds the frozen anchors; the batcher adds it to the scene and drives the fade sink through it */
  readonly root: Object3D;
  /** frozen, non-skeletal anchors by bone name, parented under `root` (X-40) */
  readonly anchors: ReadonlyMap<string, Object3D>;
  /** the instance's opaque-pass material (the template's: its texture sets are part of it) */
  readonly opaqueMaterial: AnySurfaceMaterial;
  /** the instance's transparent-pass material when that pass was visible, else null */
  readonly transparentMaterial: AnySurfaceMaterial | null;
  /** the instance's transparent pass was visible: the batcher adds the geometry to the transparent batch too */
  readonly hasTransparent: boolean;
  /** the template's part bits, so FX-15 can keep writing the look row's part mask */
  readonly partBits: ReadonlyMap<string, number>;
  /** the instance cast the shadowCaster's shadow (the row's `castShadow`): the corpse keeps casting */
  readonly castShadow: boolean;
  /** the caller's tag given to `enqueue` (the corpse system's row id) */
  readonly tag: unknown;
  dispose(): void;
}

interface BakeJob {
  instance: ModelInstance;
  table: LookTable;
  attachBones: readonly string[];
  tag: unknown;
  started: boolean;
  /** the detached look row (0 = neutral) */
  rowId: number;
  skinned: boolean;
  vertexCount: number;
  /** `rootInverse × boneMatrices`, 16 per bone; one entry (root inverse × mesh world) on a static model */
  skinMats: Float32Array | null;
  skinIndex: Uint8Array | null;
  skinWeight: Float32Array | null;
  bindPos: Float32Array;
  bindNrm: Float32Array;
  outPos: Float32Array;
  outNrm: Float32Array;
  uv: Float32Array;
  partPaint: Uint8Array;
  index: Uint16Array | Uint32Array;
  cursor: number;
  rootMatrix: Matrix4;
  rootInverse: Matrix4;
}

/** results the batcher's `add()` took: their `dispose()` is then a no-op */
const consumed = new WeakSet<CorpseBakeResult>();

/** Resumable corpse-pose baking (render §11.5). */
export class CorpseBaker {
  readonly #sliceMs: number;
  readonly #now: () => number;
  readonly #log: (message: string) => void;
  readonly #onReady: (result: CorpseBakeResult) => void;
  readonly #queue: BakeJob[] = [];
  #disposed = false;

  constructor(opts: CorpseBakerOptions) {
    if (opts.sliceMs !== undefined && (!Number.isFinite(opts.sliceMs) || opts.sliceMs <= 0)) {
      throw new RangeError(`CorpseBaker: sliceMs must be a positive number of ms, got ${String(opts.sliceMs)}`);
    }
    this.#sliceMs = opts.sliceMs ?? CORPSE_BAKE_SLICE_MS;
    this.#now = opts.now ?? (() => performance.now());
    this.#log = opts.log ?? ((m) => console.warn(m));
    this.#onReady = opts.onReady;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /** bakes waiting or in progress */
  get pending(): number {
    return this.#queue.length;
  }

  /**
   * Queues the bake of a corpse row's instance, which must be in its final pose with current world matrices (the
   * bridge calls `root.updateWorldMatrix(true, false)` before the bone write, model-instance.ts §16.3).
   * `attachBones` names the bones that keep a frozen anchor (wounds, `bp-<Bone>` probes); unknown names are skipped
   * with a log line. `tag` comes back on the result. The baker disposes the instance when the bake finishes; until then
   * the instance must not be disposed without `cancel` first.
   */
  enqueue(instance: ModelInstance, table: LookTable, attachBones: readonly string[] = [], tag: unknown = undefined): void {
    if (this.#disposed) throw new Error('CorpseBaker: enqueue on a disposed baker');
    if (instance.disposed) throw new Error(`CorpseBaker: instance of ${instance.template.name} is already disposed`);
    if (this.#queue.some((j) => j.instance === instance)) throw new Error(`CorpseBaker: instance of ${instance.template.name} is already queued`);
    const t = instance.template;
    this.#queue.push({
      instance,
      table,
      attachBones,
      tag,
      started: false,
      rowId: 0,
      skinned: t.skinned,
      vertexCount: t.arrays.vertexCount,
      skinMats: null,
      skinIndex: t.arrays.skinIndex,
      skinWeight: t.arrays.skinWeight,
      bindPos: t.arrays.position,
      bindNrm: t.arrays.normal,
      outPos: new Float32Array(t.arrays.vertexCount * 3),
      outNrm: new Float32Array(t.arrays.vertexCount * 3),
      uv: new Float32Array(0),
      partPaint: new Uint8Array(0),
      index: new Uint16Array(0),
      cursor: 0,
      rootMatrix: new Matrix4(),
      rootInverse: new Matrix4(),
    });
  }

  /**
   * Drops a queued or in-flight bake (its row went away). The instance keeps its look row until a bake finishes, so it
   * stays the caller's to dispose (its `dispose` releases the row). False when the instance is not queued.
   */
  cancel(instance: ModelInstance): boolean {
    const i = this.#queue.findIndex((j) => j.instance === instance);
    if (i < 0) return false;
    this.#queue.splice(i, 1);
    return true;
  }

  /**
   * Runs the head bake for at most the slice (its setup included); a bake that completes ends the step, so at most one
   * bake finishes per frame (render §11.5: one at a time; a grenade killing eight enemies bakes over ≥ eight frames, and
   * the finish, the geometry and the batch insertion, never stacks on a second body's slice). Returns true while bakes are
   * pending afterwards.
   */
  step(): boolean {
    if (this.#disposed) throw new Error('CorpseBaker: step on a disposed baker');
    const job = this.#queue[0];
    if (job === undefined) return false;
    // one deadline per step: the slice is the frame's, not each bake's
    const deadline = this.#now() + this.#sliceMs;
    if (!job.started) this.#begin(job);
    while (job.cursor < job.vertexCount) {
      this.#skinChunk(job);
      if (this.#now() >= deadline) return true;
    }
    this.#queue.shift();
    this.#finish(job);
    return this.#queue.length > 0;
  }

  /** drops the queue; in-flight bakes never finish (their instances, look rows included, are the caller's to dispose) */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#queue.length = 0;
  }

  /**
   * one-off setup: read the look row's part mask, snapshot the skinning matrices, build the outputs and the filtered index.
   * The row stays on the instance, which keeps drawing until the bake finishes (the bridge hands it over then): detached
   * here, the body would draw with the neutral row for the bake's frames (severed parts back, its dress gone).
   */
  #begin(job: BakeJob): void {
    job.started = true;
    const { instance, table } = job;
    const t = instance.template;
    if (instance.disposed) throw new Error(`CorpseBaker: instance of ${t.name} was disposed while queued (cancel it first)`);

    job.rowId = instance.lookRow;
    const hidden = new Set<number>();
    if (job.rowId !== 0) {
      for (const bit of t.partBits.values()) if (table.partIsHidden(job.rowId, bit)) hidden.add(bit);
    }

    job.rootMatrix.copy(instance.root.matrixWorld);
    job.rootInverse.copy(job.rootMatrix).invert();

    if (job.skinned) {
      const skeleton = instance.skeleton;
      if (skeleton === null) throw new Error(`CorpseBaker: template ${t.name} is skinned but the instance has no skeleton`);
      skeleton.update();
      const boneMats = skeleton.boneMatrices;
      if (boneMats === null) throw new Error(`CorpseBaker: template ${t.name} skeleton has no bone matrices after update()`);
      const count = skeleton.bones.length;
      const skinMats = new Float32Array(count * 16);
      const m = new Matrix4();
      for (let b = 0; b < count; b++) {
        m.fromArray(boneMats, b * 16);
        m.premultiply(job.rootInverse);
        m.toArray(skinMats, b * 16);
      }
      job.skinMats = skinMats;
    } else {
      // a static model's vertices are in the mesh's space: take them through the mesh's world matrix, root-relative
      instance.opaqueMesh.updateWorldMatrix(true, false);
      const skinMats = new Float32Array(16);
      new Matrix4().multiplyMatrices(job.rootInverse, instance.opaqueMesh.matrixWorld).toArray(skinMats, 0);
      job.skinMats = skinMats;
    }

    // uv: verbatim, or zeros when the template has no texture set (one attribute set per BatchedMesh)
    const n = job.vertexCount;
    job.uv = t.arrays.uv !== null ? new Float32Array(t.arrays.uv) : new Float32Array(n * 2);
    job.partPaint = new Uint8Array(t.arrays.partPaint);

    // index: drop the triangles of hidden parts (one part per primitive run, so one vertex decides)
    const srcIndex = t.arrays.index;
    const kept: number[] = [];
    const ss = t.arrays.partPaint;
    for (let tri = 0, triCount = srcIndex.length / 3; tri < triCount; tri++) {
      const v0 = srcIndex[tri * 3]!;
      const part = ss[v0 * 4]!;
      if (part !== PART_NEVER_HIDDEN && hidden.has(part)) continue;
      kept.push(srcIndex[tri * 3]!, srcIndex[tri * 3 + 1]!, srcIndex[tri * 3 + 2]!);
    }
    job.index = n <= 65535 ? new Uint16Array(kept) : new Uint32Array(kept);
  }

  /** skins the next chunk of vertices: positions with w = 1, normals with w = 0 and renormalised (render §11.5) */
  #skinChunk(job: BakeJob): void {
    const { bindPos, bindNrm, skinIndex, skinWeight, skinMats, outPos, outNrm, skinned } = job;
    const end = Math.min(job.cursor + BAKE_CHUNK_VERTICES, job.vertexCount);
    const sm = skinMats!;
    if (skinned && skinIndex !== null && skinWeight !== null) {
      for (let v = job.cursor; v < end; v++) {
        const bx = bindPos[v * 3]!, by = bindPos[v * 3 + 1]!, bz = bindPos[v * 3 + 2]!;
        const nx0 = bindNrm[v * 3]!, ny0 = bindNrm[v * 3 + 1]!, nz0 = bindNrm[v * 3 + 2]!;
        let px = 0, py = 0, pz = 0, nx = 0, ny = 0, nz = 0;
        for (let k = 0; k < 4; k++) {
          const w = skinWeight[v * 4 + k]!;
          if (w === 0) continue;
          const o = skinIndex[v * 4 + k]! * 16;
          px += w * (sm[o]! * bx + sm[o + 4]! * by + sm[o + 8]! * bz + sm[o + 12]!);
          py += w * (sm[o + 1]! * bx + sm[o + 5]! * by + sm[o + 9]! * bz + sm[o + 13]!);
          pz += w * (sm[o + 2]! * bx + sm[o + 6]! * by + sm[o + 10]! * bz + sm[o + 14]!);
          nx += w * (sm[o]! * nx0 + sm[o + 4]! * ny0 + sm[o + 8]! * nz0);
          ny += w * (sm[o + 1]! * nx0 + sm[o + 5]! * ny0 + sm[o + 9]! * nz0);
          nz += w * (sm[o + 2]! * nx0 + sm[o + 6]! * ny0 + sm[o + 10]! * nz0);
        }
        const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        outPos[v * 3] = px; outPos[v * 3 + 1] = py; outPos[v * 3 + 2] = pz;
        outNrm[v * 3] = nx / l; outNrm[v * 3 + 1] = ny / l; outNrm[v * 3 + 2] = nz / l;
      }
    } else {
      // static: the one "bone" is the mesh's matrix relative to the root
      for (let v = job.cursor; v < end; v++) {
        const bx = bindPos[v * 3]!, by = bindPos[v * 3 + 1]!, bz = bindPos[v * 3 + 2]!;
        outPos[v * 3] = sm[0]! * bx + sm[4]! * by + sm[8]! * bz + sm[12]!;
        outPos[v * 3 + 1] = sm[1]! * bx + sm[5]! * by + sm[9]! * bz + sm[13]!;
        outPos[v * 3 + 2] = sm[2]! * bx + sm[6]! * by + sm[10]! * bz + sm[14]!;
        const nx0 = bindNrm[v * 3]!, ny0 = bindNrm[v * 3 + 1]!, nz0 = bindNrm[v * 3 + 2]!;
        const nx = sm[0]! * nx0 + sm[4]! * ny0 + sm[8]! * nz0;
        const ny = sm[1]! * nx0 + sm[5]! * ny0 + sm[9]! * nz0;
        const nz = sm[2]! * nx0 + sm[6]! * ny0 + sm[10]! * nz0;
        const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        outNrm[v * 3] = nx / l; outNrm[v * 3 + 1] = ny / l; outNrm[v * 3 + 2] = nz / l;
      }
    }
    job.cursor = end;
  }

  /** assembles the result: the geometry, the frozen anchors, then the instance is disposed (its row stays detached) */
  #finish(job: BakeJob): void {
    const { instance, table } = job;
    const t = instance.template;

    const geometry = new BufferGeometry();
    geometry.name = `ss:corpse:${t.name}`;
    geometry.setAttribute('position', new BufferAttribute(job.outPos, 3));
    geometry.setAttribute('normal', new BufferAttribute(job.outNrm, 3));
    geometry.setAttribute('uv', new BufferAttribute(job.uv, 2));
    geometry.setAttribute('partPaint', new BufferAttribute(job.partPaint, 4, true));
    geometry.setIndex(new BufferAttribute(job.index, 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const root = new Object3D();
    root.name = `ss:corpse:${t.name}`;
    root.matrix.copy(job.rootMatrix);
    root.matrixAutoUpdate = false;
    const anchors = new Map<string, Object3D>();
    for (const name of job.attachBones) {
      const bone = instance.bones.get(name);
      if (bone === undefined) {
        this.#log(`CorpseBaker: template ${t.name} has no bone "${name}"; no frozen anchor`);
        continue;
      }
      const anchor = new Object3D();
      anchor.name = `ss:corpse-anchor:${name}`;
      anchor.matrix.copy(job.rootInverse).multiply(bone.matrixWorld);
      anchor.matrixAutoUpdate = false;
      anchor.matrixWorldNeedsUpdate = true;
      root.add(anchor);
      anchors.set(name, anchor);
    }

    const hasTransparent = instance.transparentMesh.visible;
    const opaqueMaterial = instance.opaqueMesh.material as AnySurfaceMaterial;
    const transparentMaterial = hasTransparent ? (instance.transparentMesh.material as AnySurfaceMaterial) : null;
    const partBits = t.partBits;
    const castShadow = instance.opaqueMesh.castShadow;
    const rowId = job.rowId;
    const rootMatrix = job.rootMatrix.clone();

    // the skeleton is gone with the instance; the row is detached first, so it survives for the batcher's add()
    instance.detachLookRow();
    instance.dispose();

    let abandoned = false;
    const result: CorpseBakeResult = {
      geometry,
      lookRow: rowId,
      rootMatrix,
      root,
      anchors,
      opaqueMaterial,
      transparentMaterial,
      hasTransparent,
      partBits,
      castShadow,
      tag: job.tag,
      dispose: () => {
        if (abandoned || consumed.has(result)) return;
        abandoned = true;
        if (rowId !== 0) table.release(rowId);
        geometry.dispose();
        root.removeFromParent();
      },
    };
    this.#onReady(result);
  }
}

// ── the batcher ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CorpseBatcherOptions {
  /** the batches and the corpse roots are added here */
  scene: Object3D;
  /** the look table the corpse rows are retagged on; it also holds the batch-row texture the shader samples */
  table: LookTable;
  budget: RenderBudget;
  /** gore `corpseMax` (the profile cap); the live cap is `min(profile, tier)`; at most `CORPSE_BATCH_MAX_INSTANCES` */
  profileCap: number;
  /** the largest baked body: every geometry slot reserves exactly this */
  maxVerticesPerCorpse: number;
  maxIndicesPerCorpse: number;
  /**
   * instances (and geometry slots) one material's batch may grow to; default `profileCap`. Each material present among
   * the corpses gets its own batch per pass, so this bounds the reserved memory per material; a full batch evicts its
   * oldest corpse.
   */
  bucketCapacity?: number;
  /**
   * instances (and geometry slots) a new batch reserves before it grows (doubling, `setInstanceCount` +
   * `setGeometrySize`, up to `bucketCapacity`); default `CORPSE_BUCKET_INITIAL`. Memory follows the corpses there are, not
   * the cap: a slot is `maxVerticesPerCorpse` vertices (≈ 0.6 MB at 12 k), so a batch reserved at 64 for every material
   * would hold ≈ 38 MB per material and pass.
   */
  bucketInitial?: number;
  /** default: `supportsMultiDraw(renderer)` when a renderer is given, else false */
  multiDraw?: boolean;
  renderer?: { backend?: unknown };
  /** called after a corpse leaves (evicted at the cap, by its look row, or removed); not on `dispose` */
  onRemove?: (id: number) => void;
  /** one line per anomaly; default `console.warn` */
  log?: (message: string) => void;
}

interface BatchBucket {
  material: AnySurfaceMaterial;
  batch: BatchedMesh;
  /** instances and geometry slots reserved now (grows to `bucketCapacity`) */
  capacity: number;
  /** the bucket's texel row in `LookTable.batchRows` */
  slot: number;
  /** geometry ids whose reserved slot is free for `setGeometryAt` reuse (never `deleteGeometry`) */
  free: number[];
  /** `addGeometry` calls so far (each reserves one slot) */
  slots: number;
  /** live instances */
  live: number;
}

interface CorpseRecord {
  id: number;
  row: number;
  root: Object3D;
  /** one entry per pass the corpse draws in */
  parts: Array<{ bucket: BatchBucket; geometryId: number; instanceId: number }>;
  /** the fallback's meshes (no multi-draw, or no batch slot): they carry the baked geometry and the per-object look row */
  fallback: Mesh[];
}

/**
 * Draws baked corpses: one `BatchedMesh` per material and pass with `WEBGL_multi_draw`, else one `Mesh` per corpse
 * (render §15.5). Corpses are evicted oldest-first at the live cap; `syncBudget()` applies a tier drop immediately.
 */
export class CorpseBatcher {
  readonly #scene: Object3D;
  readonly #table: LookTable;
  readonly #budget: RenderBudget;
  readonly #profileCap: number;
  readonly #maxVerticesPerCorpse: number;
  readonly #maxIndicesPerCorpse: number;
  readonly #bucketCapacity: number;
  readonly #bucketInitial: number;
  readonly #log: (message: string) => void;
  readonly #onRemove: ((id: number) => void) | undefined;
  readonly #multiDraw: boolean;
  readonly #buckets = new Map<AnySurfaceMaterial, BatchBucket>();
  readonly #corpses = new Map<number, CorpseRecord>();
  #nextId = 1;
  #disposed = false;
  #warnedBatchRows = false;

  constructor(opts: CorpseBatcherOptions) {
    if (!Number.isInteger(opts.profileCap) || opts.profileCap <= 0) {
      throw new RangeError(`CorpseBatcher: profileCap must be a positive integer, got ${String(opts.profileCap)}`);
    }
    for (const [k, v] of [['maxVerticesPerCorpse', opts.maxVerticesPerCorpse], ['maxIndicesPerCorpse', opts.maxIndicesPerCorpse]] as const) {
      if (!Number.isInteger(v) || v <= 0) throw new RangeError(`CorpseBatcher: ${k} must be a positive integer, got ${String(v)}`);
    }
    const bucketCapacity = opts.bucketCapacity ?? opts.profileCap;
    if (!Number.isInteger(bucketCapacity) || bucketCapacity <= 0 || bucketCapacity > CORPSE_BATCH_MAX_INSTANCES) {
      throw new RangeError(`CorpseBatcher: bucketCapacity must be an integer in 1..${CORPSE_BATCH_MAX_INSTANCES} (the batch-row texture's width), got ${String(bucketCapacity)}`);
    }
    this.#scene = opts.scene;
    this.#table = opts.table;
    this.#budget = opts.budget;
    this.#profileCap = opts.profileCap;
    this.#maxVerticesPerCorpse = opts.maxVerticesPerCorpse;
    this.#maxIndicesPerCorpse = opts.maxIndicesPerCorpse;
    this.#bucketCapacity = bucketCapacity;
    const bucketInitial = opts.bucketInitial ?? CORPSE_BUCKET_INITIAL;
    if (!Number.isInteger(bucketInitial) || bucketInitial <= 0) throw new RangeError(`CorpseBatcher: bucketInitial must be a positive integer, got ${String(bucketInitial)}`);
    this.#bucketInitial = Math.min(bucketInitial, bucketCapacity);
    this.#log = opts.log ?? ((m) => console.warn(m));
    this.#onRemove = opts.onRemove;
    this.#multiDraw = opts.multiDraw ?? (opts.renderer !== undefined ? supportsMultiDraw(opts.renderer) : false);
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /** the look table the corpse rows live on (the corpse system bakes against it) */
  get table(): LookTable {
    return this.#table;
  }

  /** live corpses */
  get size(): number {
    return this.#corpses.size;
  }

  /** the live cap: `min(gore corpseMax, tier.corpseCap)` */
  cap(): number {
    return this.#budget.cap('corpses', this.#profileCap);
  }

  /** whether the batch path is in use */
  get batched(): boolean {
    return this.#multiDraw;
  }

  /** the batches built so far (one per material and pass) */
  get batchCount(): number {
    return this.#buckets.size;
  }

  /**
   * Adds a finished bake, evicting the oldest corpses past the live cap first. Takes ownership of the result's
   * geometry and look row (retagged as a `'corpse'` row whose eviction drops the corpse); after `add()` do not call
   * `result.dispose()`. Returns the corpse id for `setRootMatrix` / `remove`.
   */
  add(result: CorpseBakeResult): number {
    if (this.#disposed) throw new Error('CorpseBatcher: add on a disposed batcher');
    if (consumed.has(result)) throw new Error('CorpseBatcher: result already added');
    consumed.add(result);

    while (this.#corpses.size > 0 && this.#corpses.size >= this.cap()) this.#evictOldest();

    const id = this.#nextId++;
    const record: CorpseRecord = { id, row: result.lookRow, root: result.root, parts: [], fallback: [] };
    this.#scene.add(result.root);
    // the anchors are read by bone-attached rows before the next render (render-bridge.ts `parentMatrix`)
    result.root.updateMatrixWorld(true);

    const passes: AnySurfaceMaterial[] = [result.opaqueMaterial];
    if (result.hasTransparent && result.transparentMaterial !== null) passes.push(result.transparentMaterial);

    const vertices = result.geometry.getAttribute('position').count;
    const indices = result.geometry.getIndex()?.count ?? 0;
    const fits = vertices <= this.#maxVerticesPerCorpse && indices <= this.#maxIndicesPerCorpse;
    if (this.#multiDraw && !fits) {
      this.#log(`CorpseBatcher: a baked corpse of ${vertices} vertices / ${indices} indices exceeds the ${this.#maxVerticesPerCorpse} / ${this.#maxIndicesPerCorpse} slot; it draws as its own mesh`);
    }
    const buckets = this.#multiDraw && fits ? this.#bucketsFor(passes, id) : null;

    if (buckets !== null) {
      for (const bucket of buckets) {
        let geometryId: number;
        const reused = bucket.free.pop();
        if (reused !== undefined) {
          geometryId = reused;
          bucket.batch.setGeometryAt(geometryId, result.geometry);
        } else {
          geometryId = bucket.batch.addGeometry(result.geometry, this.#maxVerticesPerCorpse, this.#maxIndicesPerCorpse);
          bucket.slots++;
        }
        const instanceId = bucket.batch.addInstance(geometryId);
        // one caster among its corpses makes the batch cast (one depth draw for all of them, render §15.5)
        if (result.castShadow) bucket.batch.castShadow = true;
        bucket.batch.setMatrixAt(instanceId, result.rootMatrix);
        bucket.live++;
        this.#table.setBatchRow(bucket.slot, instanceId, result.lookRow);
        record.parts.push({ bucket, geometryId, instanceId });
      }
      // the batches hold their own copy now
      result.geometry.dispose();
    } else {
      for (const material of passes) {
        const mesh = this.#makeFallbackMesh(result, material);
        record.fallback.push(mesh);
        // under the corpse root (identity local matrix): the fade sink moves it with the anchors
        result.root.add(mesh);
      }
    }

    if (result.lookRow !== 0) this.#table.retag(result.lookRow, 'corpse', () => this.remove(id));
    this.#corpses.set(id, record);
    return id;
  }

  /** the fade sink: moves the corpse's batch instances and its root (anchors, fallback meshes) (render §11.5, corpse.js:88-91) */
  setRootMatrix(id: number, matrix: Matrix4): boolean {
    const record = this.#corpses.get(id);
    if (record === undefined || this.#disposed) return false;
    record.root.matrix.copy(matrix);
    record.root.matrixWorldNeedsUpdate = true;
    // the anchors (X-40): bone-attached rows compose under them in this frame's bridge pass, before three's own update
    record.root.updateMatrixWorld(true);
    for (const part of record.parts) part.bucket.batch.setMatrixAt(part.instanceId, matrix);
    return true;
  }

  /** drops one corpse: its batch instances (their geometry slots are reused, never deleted), its meshes and its look row */
  remove(id: number): boolean {
    if (!this.#drop(id)) return false;
    this.#onRemove?.(id);
    return true;
  }

  /** re-reads the live cap and evicts oldest-first down to it (a mid-session tier drop takes effect at once) */
  syncBudget(): void {
    if (this.#disposed) return;
    while (this.#corpses.size > this.cap()) this.#evictOldest();
  }

  /** removes every corpse and the batches; the materials are the templates' */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const id of [...this.#corpses.keys()]) this.#drop(id);
    for (const bucket of this.#buckets.values()) {
      bucket.batch.removeFromParent();
      bucket.batch.dispose();
      this.#table.releaseBatch(bucket.slot);
    }
    this.#buckets.clear();
  }

  #drop(id: number): boolean {
    const record = this.#corpses.get(id);
    if (record === undefined) return false;
    this.#corpses.delete(id);
    if (record.row !== 0) this.#table.release(record.row);
    for (const part of record.parts) {
      part.bucket.batch.deleteInstance(part.instanceId);
      part.bucket.live--;
      this.#table.setBatchRow(part.bucket.slot, part.instanceId, 0);
      part.bucket.free.push(part.geometryId);
    }
    let geometry: BufferGeometry | null = null;
    for (const mesh of record.fallback) {
      mesh.removeFromParent();
      geometry = mesh.geometry;
    }
    geometry?.dispose();
    record.root.removeFromParent();
    return true;
  }

  /** the batch of each pass material, built on first use; null when a batch cannot be had (the caller falls back) */
  #bucketsFor(materials: readonly AnySurfaceMaterial[], adding: number): BatchBucket[] | null {
    const out: BatchBucket[] = [];
    for (const material of materials) {
      let bucket = this.#buckets.get(material);
      if (bucket === undefined) {
        const slot = this.#table.allocateBatch();
        if (slot < 0) {
          if (!this.#warnedBatchRows) {
            this.#warnedBatchRows = true;
            this.#log('CorpseBatcher: the look table has no free batch row; corpses of further materials draw as their own meshes');
          }
          return null;
        }
        const capacity = this.#bucketInitial;
        const batch = new BatchedMesh(capacity, capacity * this.#maxVerticesPerCorpse, capacity * this.#maxIndicesPerCorpse, material);
        batch.name = `ss:corpses:${material.name || material.uuid}`;
        // the batch spans the map: no object-level bounds; per-instance culling uses the baked bounds
        batch.frustumCulled = false;
        batch.userData[CORPSE_BATCH_KEY] = slot;
        // a world model receives on every tier (model-template.ts); `receiveShadow` is in three's cache key, and the warm-up's
        // batched proxy receives (models/shader-variants.ts)
        batch.receiveShadow = true;
        this.#scene.add(batch);
        bucket = { material, batch, capacity, slot, free: [], slots: 0, live: 0 };
        this.#buckets.set(material, bucket);
      }
      if (bucket.live >= bucket.capacity && bucket.capacity < this.#bucketCapacity) this.#grow(bucket);
      // a full batch gives up its oldest corpse (only when bucketCapacity is below the live cap)
      while (bucket.live >= this.#bucketCapacity) {
        const victim = this.#oldestIn(bucket, adding);
        if (victim === null) return null;
        this.remove(victim);
      }
      out.push(bucket);
    }
    return out;
  }

  /** doubles a full batch's reservation, up to `bucketCapacity` (instance ids and geometry ranges are kept) */
  #grow(bucket: BatchBucket): void {
    const next = Math.min(this.#bucketCapacity, bucket.capacity * 2);
    bucket.batch.setInstanceCount(next);
    bucket.batch.setGeometrySize(next * this.#maxVerticesPerCorpse, next * this.#maxIndicesPerCorpse);
    bucket.capacity = next;
  }

  #oldestIn(bucket: BatchBucket, except: number): number | null {
    for (const record of this.#corpses.values()) {
      if (record.id !== except && record.parts.some((p) => p.bucket === bucket)) return record.id;
    }
    return null;
  }

  #evictOldest(): void {
    const oldest = this.#corpses.keys().next();
    if (!oldest.done) this.remove(oldest.value);
  }

  #makeFallbackMesh(result: CorpseBakeResult, material: AnySurfaceMaterial): Mesh {
    const mesh = new Mesh(result.geometry, material);
    mesh.name = `ss:corpse-mesh:${result.root.name}`;
    setLookRow(mesh, result.lookRow);
    mesh.receiveShadow = true;
    mesh.castShadow = result.castShadow;
    // the geometry is root-relative and the mesh rides the corpse root: its own matrix stays the identity
    mesh.matrixAutoUpdate = false;
    return mesh;
  }
}
