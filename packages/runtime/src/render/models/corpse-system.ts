// The corpse lifecycle (docs/design/rendering.md §11.5; X-20, X-40; WP R7): the join of `CorpseBaker` and
// `CorpseBatcher` the render bridge drives.
//
// The bridge hands over the corpse row's OWN `ModelInstance` (X-20: the game spawns the row, no game edit) with
// `track`. Once no bone has changed for `stillFrames` frames (the death clip holds its end), `update` enqueues the bake;
// the baker's result, matched to its row by the enqueue tag, goes to the batcher. From then on:
//
//   - the instance is disposed by the baker: the bridge must not draw or pose it again (`baked(rowId)` says so);
//   - the row's transform (the fade sink, corpse.js:88-91) reaches the batch through `setPose`;
//   - bone-attached children resolve to the frozen anchors through `frozenBone`, the bridge's `bones` seam, which is
//     looked up before the parent's model (render-bridge.ts `parentMatrix`);
//   - a corpse the batcher drops (the live cap, a full look table) stays `baked` but draws nothing: the cap is
//     `min(gore corpseMax, tier.corpseCap)` and the row's model is gone (render §15.3).
//
// `untrack` must run before the bridge disposes a still-tracked model: it cancels a bake in flight (which holds the
// instance) and removes the baked corpse. Game-agnostic: corpse rows are recognised by the injected `isCorpseRow`
// predicate (default: the `corpse` tag, scripts/gore/corpse.js).
import type { Matrix4, Object3D } from 'three/webgpu';
import type { RowSnapshot } from '../../compat/core/ports.ts';
import { CorpseBaker, CorpseBatcher, type CorpseBakeResult, type CorpseBakerOptions, type CorpseBatcherOptions } from './corpse-baker.ts';
import type { ModelInstance } from './model-instance.ts';

export interface CorpseSystemOptions {
  /** baker options; the system supplies `onReady` */
  baker: Omit<CorpseBakerOptions, 'onReady'>;
  /** batcher options; the system supplies `onRemove` */
  batcher: Omit<CorpseBatcherOptions, 'onRemove'>;
  /** identifies corpse rows; default: `row.tags` includes `'corpse'` */
  isCorpseRow: (row: RowSnapshot) => boolean;
  /** frames of still bones before the bake; default 10 (render §11.5) */
  stillFrames?: number;
  /** the largest bone-matrix element change (m, or rotation-matrix units) that still counts as still; default `CORPSE_STILL_EPSILON` */
  stillEpsilon?: number;
  /** bones that keep a frozen anchor, per row; default: every bone of the instance (any bone may get a wound) */
  attachBones?: (row: RowSnapshot, model: ModelInstance) => readonly string[];
  log?: (message: string) => void;
}

type CorpsePhase = 'watching' | 'baking' | 'baked' | 'dropped';

interface TrackedCorpse {
  rowId: string;
  row: RowSnapshot;
  model: ModelInstance;
  phase: CorpsePhase;
  /** last seen bone world matrices and a scratch buffer, swapped per frame (stillness detection) */
  last: Float32Array | null;
  next: Float32Array | null;
  /** consecutive frames with no bone change */
  stillCount: number;
  /** the largest bone-matrix element change of the last stillness check (diagnostics) */
  lastDelta: number;
  /** the batcher's corpse id once baked */
  batchId: number | null;
  /** frozen anchors by bone name once baked */
  anchors: ReadonlyMap<string, Object3D> | null;
}


/** frames of stillness before the bake; the death clip holds its end pose (render §11.5) */
export const CORPSE_STILL_FRAMES = 10;

/**
 * The bones of a live corpse never hold bit-exact: the enemy keeps its locomotion channel at weight 0.001 under the death clip
 * (authored content), and the corpse row continues the enemy's mixer (authored content `corpseSpec`),
 * so its idle loop moves every bone by about a thousandth of its motion [M, M1 slice: 24 corpses, none still bit-exact]. A bone
 * matrix element moving less than this (1 mm, ≈ 0.06°) from the still run's anchor counts as still.
 */
export const CORPSE_STILL_EPSILON = 1e-3;

export class CorpseSystem {
  readonly #baker: CorpseBaker;
  readonly #batcher: CorpseBatcher;
  readonly #isCorpseRow: (row: RowSnapshot) => boolean;
  readonly #stillFrames: number;
  readonly #stillEpsilon: number;
  readonly #attachBones: (row: RowSnapshot, model: ModelInstance) => readonly string[];
  readonly #log: (message: string) => void;
  readonly #tracked = new Map<string, TrackedCorpse>();
  readonly #byBatchId = new Map<number, TrackedCorpse>();
  #disposed = false;

  constructor(opts: CorpseSystemOptions) {
    this.#isCorpseRow = opts.isCorpseRow;
    this.#stillFrames = opts.stillFrames ?? CORPSE_STILL_FRAMES;
    if (!Number.isInteger(this.#stillFrames) || this.#stillFrames < 1) {
      throw new RangeError(`CorpseSystem: stillFrames must be a positive integer, got ${String(this.#stillFrames)}`);
    }
    this.#stillEpsilon = opts.stillEpsilon ?? CORPSE_STILL_EPSILON;
    if (!(this.#stillEpsilon >= 0)) throw new RangeError(`CorpseSystem: stillEpsilon must be >= 0, got ${String(this.#stillEpsilon)}`);
    this.#attachBones = opts.attachBones ?? ((_row, model) => [...model.bones.keys()]);
    this.#log = opts.log ?? ((m) => console.warn(m));
    this.#baker = new CorpseBaker({ ...opts.baker, onReady: (r) => this.#onBakeReady(r) });
    this.#batcher = new CorpseBatcher({ ...opts.batcher, onRemove: (id) => this.#onBatchRemove(id) });
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /** the batcher (draw-budget probes, tests) */
  get batcher(): CorpseBatcher {
    return this.#batcher;
  }

  /** whether the row is a corpse the system should track */
  isCorpse(row: RowSnapshot): boolean {
    return this.#isCorpseRow(row);
  }

  /** tracked corpse rows (watching, baking, baked or dropped) */
  get size(): number {
    return this.#tracked.size;
  }

  /** bakes waiting or in progress */
  get pendingBakes(): number {
    return this.#baker.pending;
  }

  /**
   * A corpse row's model is ready. Starts stillness tracking; the bake is enqueued after `stillFrames` frames of
   * unchanged bones. The model must be the row's OWN `ModelInstance` (X-20). False for a row that is no corpse.
   */
  track(rowId: string, row: RowSnapshot, model: ModelInstance): boolean {
    if (this.#disposed || !this.#isCorpseRow(row)) return false;
    if (model.disposed) throw new Error(`CorpseSystem: the model of ${rowId} is already disposed`);
    if (this.#tracked.has(rowId)) this.untrack(rowId);
    this.#tracked.set(rowId, { rowId, row, model, phase: 'watching', last: null, next: null, stillCount: 0, lastDelta: 0, batchId: null, anchors: null });
    return true;
  }

  /** whether the row's model was handed to the baker: the bridge must neither pose nor dispose it any more */
  baked(rowId: string): boolean {
    const phase = this.#tracked.get(rowId)?.phase;
    return phase === 'baking' || phase === 'baked' || phase === 'dropped';
  }

  /**
   * whether the bake finished (or the corpse was dropped): the row's instance is disposed and its corpse draws through the
   * batcher. Until then (`baked` but baking) the instance still draws, so the bridge keeps it until this turns true.
   */
  handedOver(rowId: string): boolean {
    const phase = this.#tracked.get(rowId)?.phase;
    return phase === 'baked' || phase === 'dropped';
  }

  /** The row is gone: cancels its bake in flight (the model is then the caller's again) and removes its baked corpse. */
  untrack(rowId: string): void {
    const t = this.#tracked.get(rowId);
    if (t === undefined) return;
    this.#tracked.delete(rowId);
    if (t.phase === 'baking') this.#baker.cancel(t.model);
    if (t.batchId !== null) {
      this.#byBatchId.delete(t.batchId);
      this.#batcher.remove(t.batchId);
    }
  }

  /** the row's transform after the bake (the fade sink): moves the batch instances and the anchors */
  setPose(rowId: string, matrix: Matrix4): boolean {
    const t = this.#tracked.get(rowId);
    if (t === undefined || t.batchId === null) return false;
    return this.#batcher.setRootMatrix(t.batchId, matrix);
  }

  /**
   * Per frame: updates stillness for watched corpses, enqueues ready bakes, steps the baker, syncs the budget. Call from
   * the loop's `'corpses'` stage, after the bridge and mixer have written the bones.
   */
  update(): void {
    if (this.#disposed) return;
    for (const t of this.#tracked.values()) {
      if (t.phase !== 'watching') continue;
      if (t.model.disposed) {
        this.#log(`CorpseSystem: the model of ${t.rowId} was disposed while tracked (untrack first); it is dropped`);
        t.phase = 'dropped';
        continue;
      }
      if (!this.#bonesStill(t)) {
        t.stillCount = 0;
        continue;
      }
      if (++t.stillCount < this.#stillFrames) continue;
      t.phase = 'baking';
      t.last = t.next = null;
      // the bones are current (the stillness check just read them); the root's world matrix is the bake's frame
      t.model.root.updateWorldMatrix(true, false);
      this.#baker.enqueue(t.model, this.#batcher.table, this.#attachBones(t.row, t.model), t.rowId);
    }
    if (this.#baker.pending > 0) this.#baker.step();
    this.#batcher.syncBudget();
  }

  /** tracked corpses by phase, and the smallest bone change among the watched ones (diagnostics, `GameWorldInfo.gore`) */
  phases(): { watching: number; baking: number; baked: number; dropped: number; minWatchedDelta: number | null } {
    const out = { watching: 0, baking: 0, baked: 0, dropped: 0, minWatchedDelta: null as number | null };
    for (const t of this.#tracked.values()) {
      out[t.phase]++;
      if (t.phase === 'watching') out.minWatchedDelta = out.minWatchedDelta === null ? t.lastDelta : Math.min(out.minWatchedDelta, t.lastDelta);
    }
    return out;
  }

  /** The bridge's `bones` seam: a baked corpse's frozen anchor for a bone, or null (render-bridge.ts `parentMatrix`). */
  frozenBone(rowId: string, bone: string): Object3D | null {
    const t = this.#tracked.get(rowId);
    if (t === undefined || t.phase !== 'baked' || t.anchors === null) return null;
    return t.anchors.get(bone) ?? null;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#tracked.clear();
    this.#byBatchId.clear();
    this.#baker.dispose();
    this.#batcher.dispose();
  }

  /** the baker's `onReady`: the result is the row's that enqueued it (its tag) */
  #onBakeReady(result: CorpseBakeResult): void {
    const t = typeof result.tag === 'string' ? this.#tracked.get(result.tag) : undefined;
    if (t === undefined || t.phase !== 'baking') {
      // untrack cancels the bake, so this is a row re-tracked with another model mid-bake
      result.dispose();
      this.#log(`CorpseSystem: a bake finished for ${String(result.tag)}, which no longer waits for it; dropped`);
      return;
    }
    const id = this.#batcher.add(result);
    t.phase = 'baked';
    t.batchId = id;
    t.anchors = result.anchors;
    this.#byBatchId.set(id, t);
  }

  /** the batcher dropped a corpse (cap, look-table eviction): its row stays tracked, baked, with nothing to draw */
  #onBatchRemove(id: number): void {
    const t = this.#byBatchId.get(id);
    if (t === undefined) return;
    this.#byBatchId.delete(id);
    t.batchId = null;
    t.anchors = null;
    t.phase = 'dropped';
  }

  /**
   * true when no bone world matrix moved more than `stillEpsilon` from the still run's anchor (the first frame only takes
   * the baseline). The anchor stays while the bones stay within it, so a slow drift cannot add up past the tolerance.
   */
  #bonesStill(t: TrackedCorpse): boolean {
    const bones = t.model.boneList;
    if (bones.length === 0) return true;
    const count = bones.length * 16;
    if (t.next === null || t.next.length !== count) t.next = new Float32Array(count);
    const cur = t.next;
    let o = 0;
    for (const bone of bones) {
      const e = bone.matrixWorld.elements;
      for (let i = 0; i < 16; i++) cur[o++] = e[i]!;
    }
    const anchor = t.last;
    if (anchor === null || anchor.length !== count) {
      t.next = anchor;
      t.last = cur;
      return false;
    }
    let delta = 0;
    for (let i = 0; i < count; i++) {
      const d = Math.abs(cur[i]! - anchor[i]!);
      if (d > delta) delta = d;
    }
    t.lastDelta = delta;
    if (delta <= this.#stillEpsilon) return true;
    // moved: this frame is the new anchor
    t.next = anchor;
    t.last = cur;
    return false;
  }
}
