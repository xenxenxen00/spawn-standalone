// Look table, model paint table and the model input stages (docs/design/rendering.md §7.6, §11.3, §6.6; WP R6).
//
// Two float tables hold everything a model's surface reads that is not in its vertices:
//
//   model paint table   RGBA32F, 768 × 16: 4,096 paints, 3 texels each. One block per loaded `ModelTemplate`, written once at
//                       the template build; a vertex's `ss` attribute carries its paint's table index (§11.3 step 1).
//                         texel 0  albedo rgb (linear), alpha
//                         texel 1  emissive rgb (linear, × strength), texture set (0 = flat, 1..3 = the bound slot set)
//                         texel 2  roughness, metalness, 0, 0
//   look table          RGBA32F, 128 × 512: one row per `ModelInstance` or baked corpse, selected by the per-object uniform
//                       `lookRow` (`object.userData.ssLookRow`). Row 0 is never handed out: it stays all zero, which reads as
//                       "no override, every part visible", so an object without a row draws its template's own look.
//                         texels 0..95    slots 0..31 × 3: (albedo rgb, mode) (emissive rgb, alpha) (roughness, metalness, active, 0)
//                         texel  96       part mask bits 0..63, four 16-bit integers stored in floats (bit set = hidden)
//                       and, past what §7.6 lays out, because the content needs it (measured on the 593 built models: up to
//                       79 named mesh nodes and 35 materials in one file; `model.parts.<node>` also dresses a node):
//                         texel  97       part mask bits 64..127
//                         texel  98       part-look directory: (part id + 1) of part looks 0..3, 0 = unused
//                         texels 99..110  part looks 0..3 × 3, laid out like a slot
//                         texels 111..125 slots 32..36 × 3
//                       An unset field of an entry is −1 (emissive −2 = "scale the model's own emissive by g"); `active` 0
//                       turns the whole entry off, so a zeroed entry is no override.
//
// Upload rule (§6.6, §7.6). r186 has no partial texture upload behind `needsUpdate` (no texture path reads `updateRanges`), so a
// write marks its row dirty and `flush(renderer)` copies each dirty row from a one-row staging `DataTexture` with
// `renderer.copyTextureToTexture(staging, table, null, (0, row))`. Above `wholeAbove` dirty rows (64 for the look table) the
// table is uploaded whole instead. `image.data` is always current, so a device-loss rebuild re-uploads it (`markAll`).
// What the WebGL2 backend does for one row [M, tests/e2e/render-models.spec.ts]: `Renderer.copyTextureToTexture` first uploads
// the staging texture (128 × 1 texels, 2 KiB, one `texSubImage2D`), then copies it on the GPU with one `copyTexSubImage2D` of
// that row; the 1 MiB table is not sent again. The copy reads the staging texture through a framebuffer, which needs a
// renderable RGBA32F (`EXT_color_buffer_float`); without it `partialUploads: false` makes every flush a whole upload.
//
// The model input stages (`registerModelStages`) are the shader side: SRC_GLTF reads the paint, TEX_SLOTS_n samples the
// model's texture sets where the paint says so, SLOTS applies the slot and part looks, PARTMASK collapses hidden parts. All of
// it is arithmetic on masks: three emits an expression inside the first conditional block that uses it (R1a's measured TSL
// hazard), so nothing here is a `select` or an `If`.
import { Fn, attribute, batchIndirectIndex, float, int, ivec2, mix, normalMap, normalView, positionLocal, step, texture, textureLoad, uniform, uv, varying, vec3, vec4 } from 'three/tsl';
import { DataTexture, FloatType, NearestFilter, RGBAFormat, Vector2 } from 'three/webgpu';
import type { Node, NodeBuilder, Object3D, Texture } from 'three/webgpu';
import type { Linear3 } from '../color/color.ts';
import { cssAlpha, cssToLinear } from '../color/color.ts';
import type { StandardMaterialSpec } from './material-spec.ts';
import { SURFACE_TEX_SLOTS_MASK, SurfaceVariant, describeVariant, texSlotCount, type SurfaceInputs, type SurfaceMaterials, type SurfaceStageContext } from './surface-material.ts';

// ── layout ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const LOOK_TABLE_WIDTH = 128;
export const LOOK_TABLE_ROWS = 512;
/** texels of one slot or part-look entry */
export const LOOK_ENTRY_TEXELS = 3;
/** slots of §7.6 (texels 0..95) */
export const LOOK_BASE_SLOTS = 32;
/** slots a row holds in all (32 + the 5 past the part looks) */
export const LOOK_MAX_SLOTS = 37;
export const LOOK_MASK_TEXEL = 96;
/** part ids a mask can hide (two texels of four 16-bit words); 255 = never hidden */
export const LOOK_MAX_PARTS = 128;
export const LOOK_PART_DIR_TEXEL = 98;
export const LOOK_PART_LOOKS = 4;
export const LOOK_PART_LOOK_TEXEL = 99;
export const LOOK_EXTRA_SLOT_TEXEL = 111;
/** a frame with more dirty look rows than this uploads the table whole (§7.6) */
export const LOOK_WHOLE_UPLOAD_ABOVE = 64;
/** the `ss` part id of a primitive no mask can hide */
export const PART_NEVER_HIDDEN = 255;
/**
 * render §11.5: the corpse batches' per-instance look rows (`LookTable.batchRows`): one texel row per corpse batch, one
 * texel per instance id. The width bounds a corpse batch's instances (the tier table's largest corpse cap is 64).
 */
export const CORPSE_BATCH_MAX_INSTANCES = 64;
/** corpse batches the batch-row texture holds (one per surface material and pass) */
export const CORPSE_BATCH_MAX_BATCHES = 32;

/** first texel of slot `slot` in a look row */
export function lookSlotTexel(slot: number): number {
  if (!Number.isInteger(slot) || slot < 0 || slot >= LOOK_MAX_SLOTS) throw new RangeError(`look table: slot ${slot} is outside 0..${LOOK_MAX_SLOTS - 1}`);
  return slot < LOOK_BASE_SLOTS ? slot * LOOK_ENTRY_TEXELS : LOOK_EXTRA_SLOT_TEXEL + (slot - LOOK_BASE_SLOTS) * LOOK_ENTRY_TEXELS;
}

/** first texel of part look `index` (0..3) in a look row */
export function lookPartLookTexel(index: number): number {
  if (!Number.isInteger(index) || index < 0 || index >= LOOK_PART_LOOKS) throw new RangeError(`look table: part look ${index} is outside 0..${LOOK_PART_LOOKS - 1}`);
  return LOOK_PART_LOOK_TEXEL + index * LOOK_ENTRY_TEXELS;
}

export const MODEL_PAINT_PER_ROW = 256;
export const MODEL_PAINT_WIDTH: number = MODEL_PAINT_PER_ROW * 3;
export const MODEL_PAINT_ROWS = 16;
export const MODEL_PAINT_CAPACITY: number = MODEL_PAINT_PER_ROW * MODEL_PAINT_ROWS;

// ── slot overrides ──────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * render §7.6. Unset fields leave the model's own value. `mode` only matters with `albedo`: `'replace'` puts the colour in
 * place of the slot's texture and factor (the frost statue), `'tint'` multiplies them.
 */
export interface SlotOverride {
  mode: 'tint' | 'replace';
  albedo?: Linear3;
  /** below 1 the slot is drawn in the blend pass (the instance's transparent mesh) */
  alpha?: number;
  /** linear, already × intensity; replaces the model's emissive */
  emissive?: Linear3;
  /** multiplies the model's own emissive: a spec with `emissiveIntensity` and no `emissive` (the kilnback furnace glow) */
  emissiveScale?: number;
  roughness?: number;
  metalness?: number;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * A `model.materials[slot]` / `model.parts[node]` material spec as a slot override, or null when it overrides nothing.
 * Live semantics (`sk/uploaded-models:32`): only the given fields change; a `color` replaces the slot's texture; a `texture` on
 * a slot is not carried (no live write names one: `enemy-look.yml` dresses nothing).
 */
export function slotOverrideFromSpec(spec: StandardMaterialSpec | null | undefined): SlotOverride | null {
  if (spec === null || spec === undefined || typeof spec !== 'object') return null;
  const out: SlotOverride = { mode: 'replace' };
  let any = false;
  let alpha: number | undefined;
  if (typeof spec.color === 'string') {
    const c = cssToLinear(spec.color);
    if (c !== null) {
      out.albedo = c;
      any = true;
      const a = cssAlpha(spec.color);
      if (a !== undefined && a < 1) alpha = a;
    }
  }
  if (finite(spec.opacity)) alpha = spec.opacity;
  // three's rule: `opacity` only blends on a transparent material
  if (spec.transparent === false) alpha = 1;
  if (alpha !== undefined) {
    out.alpha = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
    any = true;
  }
  const k = finite(spec.emissiveIntensity) ? spec.emissiveIntensity : undefined;
  const e = typeof spec.emissive === 'string' ? cssToLinear(spec.emissive) : null;
  if (e !== null) {
    const s = k ?? 1;
    out.emissive = [e[0] * s, e[1] * s, e[2] * s];
    any = true;
  } else if (k !== undefined) {
    out.emissiveScale = k;
    any = true;
  }
  if (finite(spec.roughness)) {
    out.roughness = spec.roughness;
    any = true;
  }
  if (finite(spec.metalness)) {
    out.metalness = spec.metalness;
    any = true;
  }
  return any ? out : null;
}

/** whether an override puts its slot in the blend pass */
export const overrideIsTransparent = (o: SlotOverride | null | undefined): boolean => o !== null && o !== undefined && o.alpha !== undefined && o.alpha < ALPHA_OPAQUE;

/** an alpha at or above this is drawn in the opaque pass */
export const ALPHA_OPAQUE = 0.999;

/** Writes one entry (12 floats) at `o`; null clears it. */
export function writeLookEntry(data: Float32Array, o: number, look: SlotOverride | null): void {
  if (look === null) {
    data.fill(0, o, o + LOOK_ENTRY_TEXELS * 4);
    return;
  }
  const a = look.albedo;
  data[o] = a ? a[0] : -1;
  data[o + 1] = a ? a[1] : -1;
  data[o + 2] = a ? a[2] : -1;
  data[o + 3] = look.mode === 'replace' ? 1 : 0;
  const e = look.emissive;
  if (e) {
    // a negative red would read as "unset": emissive is light, never below zero
    data[o + 4] = Math.max(0, e[0]);
    data[o + 5] = e[1];
    data[o + 6] = e[2];
  } else if (look.emissiveScale !== undefined) {
    data[o + 4] = -2;
    data[o + 5] = look.emissiveScale;
    data[o + 6] = 0;
  } else {
    data[o + 4] = -1;
    data[o + 5] = -1;
    data[o + 6] = -1;
  }
  data[o + 7] = look.alpha ?? -1;
  data[o + 8] = look.roughness ?? -1;
  data[o + 9] = look.metalness ?? -1;
  data[o + 10] = 1;
  data[o + 11] = 0;
}

// ── a float table with per-row uploads ──────────────────────────────────────────────────────────────────────────────────

/** the part of three's renderer a table flush calls */
export interface TableRenderer {
  copyTextureToTexture(src: Texture, dst: Texture, srcRegion?: null, dstPosition?: Vector2 | null): void;
}

export interface TableFlush {
  /** rows copied from staging rows */
  rows: number;
  /** the table was marked for a whole upload */
  whole: boolean;
  /** bytes this flush sends to the GPU */
  bytes: number;
}

export interface StagedRowTextureOptions {
  width: number;
  height: number;
  name: string;
  /** more dirty rows than this in one flush → one whole upload; default: the height (never) */
  wholeAbove?: number;
  /** false → every flush with a dirty row is a whole upload (no renderable RGBA32F for the row copy) */
  partialUploads?: boolean;
}

/** An RGBA32F `DataTexture` whose rows are uploaded one by one (see the header). Created once, never reallocated. */
export class StagedRowTexture {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;
  readonly texture: DataTexture;
  /** uploads since creation, for the tests and the telemetry */
  readonly stats = { rowCopies: 0, wholeUploads: 0, bytes: 0 };
  partialUploads: boolean;
  readonly #wholeAbove: number;
  readonly #dirty = new Set<number>();
  readonly #staging: DataTexture[] = [];
  readonly #at = new Vector2();
  /** the next flush sends everything: true until the first one, and after `markAll` */
  #whole = true;

  constructor(opts: StagedRowTextureOptions) {
    this.width = opts.width;
    this.height = opts.height;
    this.data = new Float32Array(opts.width * opts.height * 4);
    this.texture = floatTexture(this.data, opts.width, opts.height, opts.name);
    this.#wholeAbove = opts.wholeAbove ?? opts.height;
    this.partialUploads = opts.partialUploads ?? true;
  }

  get rowBytes(): number {
    return this.width * 16;
  }

  /** rows written since the last flush */
  get dirtyRows(): number {
    return this.#dirty.size;
  }

  /** staging rows created so far (at most `wholeAbove`) */
  get stagingRows(): number {
    return this.#staging.length;
  }

  markRow(row: number): void {
    if (!this.#whole) this.#dirty.add(row);
  }

  /** the GPU copy is gone or stale as a whole (device loss, first use) */
  markAll(): void {
    this.#whole = true;
    this.#dirty.clear();
  }

  /** Sends what changed since the last flush. Call once per frame, before the draw (docs/architecture.md §4.2 step 4). */
  flush(renderer: TableRenderer): TableFlush {
    if (this.#whole || (this.#dirty.size > 0 && (!this.partialUploads || this.#dirty.size > this.#wholeAbove))) {
      this.#whole = false;
      this.#dirty.clear();
      this.texture.needsUpdate = true;
      const bytes = this.data.byteLength;
      this.stats.wholeUploads++;
      this.stats.bytes += bytes;
      return { rows: 0, whole: true, bytes };
    }
    if (this.#dirty.size === 0) return { rows: 0, whole: false, bytes: 0 };
    const floats = this.width * 4;
    let i = 0;
    for (const row of this.#dirty) {
      let staging = this.#staging[i];
      if (staging === undefined) {
        staging = floatTexture(new Float32Array(floats), this.width, 1, `${this.texture.name}:row${i}`);
        this.#staging[i] = staging;
      }
      (staging.image.data as Float32Array).set(this.data.subarray(row * floats, (row + 1) * floats));
      staging.needsUpdate = true;
      renderer.copyTextureToTexture(staging, this.texture, null, this.#at.set(0, row));
      i++;
    }
    const rows = this.#dirty.size;
    const bytes = rows * this.rowBytes;
    this.#dirty.clear();
    this.stats.rowCopies += rows;
    this.stats.bytes += bytes;
    return { rows, whole: false, bytes };
  }

  dispose(): void {
    this.texture.dispose();
    for (const s of this.#staging) s.dispose();
    this.#staging.length = 0;
  }
}

function floatTexture(data: Float32Array, width: number, height: number, name: string): DataTexture {
  const t = new DataTexture(data, width, height, RGBAFormat, FloatType);
  t.name = name;
  t.magFilter = NearestFilter;
  t.minFilter = NearestFilter;
  t.generateMipmaps = false;
  t.flipY = false;
  t.needsUpdate = true;
  return t;
}

// ── the look table ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type LookRowKind = 'instance' | 'corpse';

export interface LookTableOptions {
  partialUploads?: boolean;
  /** one line when the table is full and nothing can be evicted; default `console.warn` */
  log?: (message: string) => void;
}

interface RowState {
  kind: LookRowKind;
  /** allocation order: the oldest corpse goes first */
  serial: number;
  onEvict: (() => void) | undefined;
  /** part id of each part look in use (−1 = free) */
  partLooks: Int16Array;
}

/** render §7.6: 128 × 512 RGBA32F, one row per model instance or baked corpse. */
export class LookTable {
  readonly rows: StagedRowTexture;
  /**
   * render §11.5: the corpse batches' look rows, `CORPSE_BATCH_MAX_INSTANCES × CORPSE_BATCH_MAX_BATCHES` RGBA32F; texel
   * `(instanceId, batch).x` is that instance's look row (0 = neutral). Read by the model stage for a corpse `BatchedMesh`.
   */
  readonly batchRows: DataTexture;
  readonly #state = new Map<number, RowState>();
  readonly #free: number[] = [];
  readonly #freeBatches: number[] = [];
  readonly #log: (message: string) => void;
  #serial = 0;
  #warnedFull = false;

  constructor(opts: LookTableOptions = {}) {
    this.rows = new StagedRowTexture({
      width: LOOK_TABLE_WIDTH,
      height: LOOK_TABLE_ROWS,
      name: 'ss:look-table',
      wholeAbove: LOOK_WHOLE_UPLOAD_ABOVE,
      ...(opts.partialUploads === undefined ? {} : { partialUploads: opts.partialUploads }),
    });
    this.#log = opts.log ?? ((m) => console.warn(m));
    // row 0 is the neutral row; hand out low rows first
    for (let r = LOOK_TABLE_ROWS - 1; r >= 1; r--) this.#free.push(r);
    this.batchRows = floatTexture(new Float32Array(CORPSE_BATCH_MAX_INSTANCES * CORPSE_BATCH_MAX_BATCHES * 4), CORPSE_BATCH_MAX_INSTANCES, CORPSE_BATCH_MAX_BATCHES, 'ss:corpse-batch-rows');
    for (let b = CORPSE_BATCH_MAX_BATCHES - 1; b >= 0; b--) this.#freeBatches.push(b);
  }

  /** A cleared texel row of `batchRows` for one corpse batch, or −1 when all are taken. */
  allocateBatch(): number {
    return this.#freeBatches.pop() ?? -1;
  }

  /** Returns a corpse batch's texel row (cleared). */
  releaseBatch(batch: number): void {
    if (!Number.isInteger(batch) || batch < 0 || batch >= CORPSE_BATCH_MAX_BATCHES || this.#freeBatches.includes(batch)) return;
    const data = this.batchRows.image.data as Float32Array;
    data.fill(0, batch * CORPSE_BATCH_MAX_INSTANCES * 4, (batch + 1) * CORPSE_BATCH_MAX_INSTANCES * 4);
    this.batchRows.needsUpdate = true;
    this.#freeBatches.push(batch);
  }

  /** The look row a corpse batch's instance reads (0 = neutral). */
  setBatchRow(batch: number, instanceId: number, row: number): void {
    if (!Number.isInteger(batch) || batch < 0 || batch >= CORPSE_BATCH_MAX_BATCHES) throw new RangeError(`look table: corpse batch ${batch} is outside 0..${CORPSE_BATCH_MAX_BATCHES - 1}`);
    if (!Number.isInteger(instanceId) || instanceId < 0 || instanceId >= CORPSE_BATCH_MAX_INSTANCES) {
      throw new RangeError(`look table: corpse batch instance ${instanceId} is outside 0..${CORPSE_BATCH_MAX_INSTANCES - 1}`);
    }
    const data = this.batchRows.image.data as Float32Array;
    const o = (batch * CORPSE_BATCH_MAX_INSTANCES + instanceId) * 4;
    if (data[o] === row) return;
    data[o] = row;
    this.batchRows.needsUpdate = true;
  }

  /** The look row stored for a corpse batch's instance. */
  batchRowAt(batch: number, instanceId: number): number {
    return (this.batchRows.image.data as Float32Array)[(batch * CORPSE_BATCH_MAX_INSTANCES + instanceId) * 4] ?? 0;
  }

  get texture(): DataTexture {
    return this.rows.texture;
  }

  /** rows in use (the neutral row 0 is not one) */
  get used(): number {
    return this.#state.size;
  }

  get capacity(): number {
    return LOOK_TABLE_ROWS - 1;
  }

  kindOf(row: number): LookRowKind | undefined {
    return this.#state.get(row)?.kind;
  }

  /**
   * A cleared row. When the table is full the oldest baked corpse's row is taken: its `onEvict` runs first (the corpse must
   * stop using the row: it is the first thing the gore pool drops anyway). With no corpse to evict the answer is row 0, the
   * shared neutral row, on which writes do nothing: the object then draws its template's own look.
   */
  allocate(kind: LookRowKind = 'instance', onEvict?: () => void): number {
    let row = this.#free.pop();
    if (row === undefined) {
      let oldest = -1;
      let serial = Infinity;
      for (const [r, s] of this.#state) {
        if (s.kind === 'corpse' && s.serial < serial) {
          oldest = r;
          serial = s.serial;
        }
      }
      if (oldest < 0) {
        if (!this.#warnedFull) {
          this.#warnedFull = true;
          this.#log(`look table: all ${this.capacity} rows are in use and none is a corpse; new instances draw without overrides`);
        }
        return 0;
      }
      const evicted = this.#state.get(oldest)!;
      this.#state.delete(oldest);
      evicted.onEvict?.();
      row = oldest;
    }
    this.#state.set(row, { kind, serial: this.#serial++, onEvict, partLooks: new Int16Array(LOOK_PART_LOOKS).fill(-1) });
    this.#clear(row);
    return row;
  }

  /**
   * Hands a live row to another owner without touching its texels: an instance row becomes its baked corpse's (render §11.5:
   * the slot overrides and the part mask stay). The row's age restarts, so the corpse is the newest.
   */
  retag(row: number, kind: LookRowKind, onEvict?: () => void): void {
    const s = this.#state.get(row);
    if (s === undefined) return;
    s.kind = kind;
    s.onEvict = onEvict;
    s.serial = this.#serial++;
  }

  /** Returns a row to the free list (cleared, so the next owner and any stale reader see a neutral row). */
  release(row: number): void {
    if (!this.#state.delete(row)) return;
    this.#clear(row);
    this.#free.push(row);
  }

  /** `model.materials[slot]`: null clears the override. False when the row is not allocated. */
  setSlot(row: number, slot: number, look: SlotOverride | null): boolean {
    if (!this.#state.has(row)) return false;
    writeLookEntry(this.rows.data, this.#offset(row, lookSlotTexel(slot)), look);
    this.rows.markRow(row);
    return true;
  }

  /** the slot's override as stored, or null */
  slotIsActive(row: number, slot: number): boolean {
    return this.rows.data[this.#offset(row, lookSlotTexel(slot)) + 10] === 1;
  }

  /** Part visibility: `part` is the template's bit index (`partBits`). */
  setPartHidden(row: number, part: number, hidden: boolean): boolean {
    if (!this.#state.has(row)) return false;
    if (!Number.isInteger(part) || part < 0 || part >= LOOK_MAX_PARTS) throw new RangeError(`look table: part ${part} is outside 0..${LOOK_MAX_PARTS - 1}`);
    const o = this.#offset(row, LOOK_MASK_TEXEL) + (part >> 4);
    const word = this.rows.data[o]!;
    const bit = 1 << (part & 15);
    const next = hidden ? word | bit : word & ~bit;
    if (next !== word) {
      this.rows.data[o] = next;
      this.rows.markRow(row);
    }
    return true;
  }

  partIsHidden(row: number, part: number): boolean {
    return (this.rows.data[this.#offset(row, LOOK_MASK_TEXEL) + (part >> 4)]! & (1 << (part & 15))) !== 0;
  }

  /**
   * `model.parts[node] = {visible: true, ...material}`: dresses one part. A row holds four part looks; false when a fifth
   * part asks for one (the caller logs it), or when the row is not allocated.
   */
  setPartLook(row: number, part: number, look: SlotOverride | null): boolean {
    const s = this.#state.get(row);
    if (s === undefined) return false;
    let index = s.partLooks.indexOf(part);
    if (look === null) {
      if (index < 0) return true;
      s.partLooks[index] = -1;
    } else {
      if (index < 0) index = s.partLooks.indexOf(-1);
      if (index < 0) return false;
      s.partLooks[index] = part;
    }
    const data = this.rows.data;
    data[this.#offset(row, LOOK_PART_DIR_TEXEL) + index] = look === null ? 0 : part + 1;
    writeLookEntry(data, this.#offset(row, lookPartLookTexel(index)), look);
    this.rows.markRow(row);
    return true;
  }

  /** the floats of a row (a view into the table's `image.data`) */
  rowData(row: number): Float32Array {
    const floats = LOOK_TABLE_WIDTH * 4;
    return this.rows.data.subarray(row * floats, (row + 1) * floats);
  }

  flush(renderer: TableRenderer): TableFlush {
    return this.rows.flush(renderer);
  }

  dispose(): void {
    this.rows.dispose();
    this.batchRows.dispose();
  }

  #offset(row: number, texel: number): number {
    return (row * LOOK_TABLE_WIDTH + texel) * 4;
  }

  #clear(row: number): void {
    const floats = LOOK_TABLE_WIDTH * 4;
    const data = this.rows.data;
    let dirty = false;
    for (let i = row * floats, end = i + floats; i < end; i++) {
      if (data[i] !== 0) {
        data[i] = 0;
        dirty = true;
      }
    }
    if (dirty) this.rows.markRow(row);
  }
}

// ── the model paint table ───────────────────────────────────────────────────────────────────────────────────────────────

/** One glTF material as the surface reads it: factors, and which of the template's texture sets it samples. */
export interface ModelPaint {
  albedo: Linear3;
  alpha: number;
  /** linear, × `KHR_materials_emissive_strength` */
  emissive: Linear3;
  roughness: number;
  metalness: number;
  /** 0 = untextured; 1..3 = the template's slot texture set (TEX_SLOTS_n) */
  texSet: number;
}

/** paint 0: what a vertex with no `ss` reads (white, rough, opaque) */
export const NEUTRAL_MODEL_PAINT: Readonly<ModelPaint> = Object.freeze<ModelPaint>({ albedo: [1, 1, 1], alpha: 1, emissive: [0, 0, 0], roughness: 1, metalness: 0, texSet: 0 });

/** The shared model paint `DataTexture` (render §11.3 step 3): one block of paints per template. */
export class ModelPaintTable {
  readonly rows: StagedRowTexture;
  /** free blocks, sorted by start: [start, count] */
  readonly #free: Array<[number, number]> = [[1, MODEL_PAINT_CAPACITY - 1]];

  constructor(opts: { partialUploads?: boolean } = {}) {
    this.rows = new StagedRowTexture({
      width: MODEL_PAINT_WIDTH,
      height: MODEL_PAINT_ROWS,
      name: 'ss:model-paint',
      ...(opts.partialUploads === undefined ? {} : { partialUploads: opts.partialUploads }),
    });
    this.write(0, NEUTRAL_MODEL_PAINT);
  }

  get texture(): DataTexture {
    return this.rows.texture;
  }

  /** paints not in any block */
  get freePaints(): number {
    return this.#free.reduce((n, b) => n + b[1], 0);
  }

  /** A block of `count` consecutive paint ids (first fit); throws when the table has no such run left. */
  allocate(count: number): number {
    if (!Number.isInteger(count) || count < 1) throw new RangeError(`model paint table: bad block size ${count}`);
    for (let i = 0; i < this.#free.length; i++) {
      const block = this.#free[i]!;
      if (block[1] < count) continue;
      const start = block[0];
      if (block[1] === count) this.#free.splice(i, 1);
      else {
        block[0] += count;
        block[1] -= count;
      }
      return start;
    }
    throw new Error(`model paint table: no run of ${count} free paints (${this.freePaints} of ${MODEL_PAINT_CAPACITY} free)`);
  }

  /** Returns a block; neighbours merge. */
  free(start: number, count: number): void {
    if (count < 1) return;
    const free = this.#free;
    let i = 0;
    while (i < free.length && free[i]![0] < start) i++;
    const block: [number, number] = [start, count];
    free.splice(i, 0, block);
    const next = free[i + 1];
    if (next !== undefined && start + count === next[0]) {
      block[1] += next[1];
      free.splice(i + 1, 1);
    }
    const prev = i > 0 ? free[i - 1] : undefined;
    if (prev !== undefined && prev[0] + prev[1] === start) {
      prev[1] += block[1];
      free.splice(i, 1);
    }
  }

  write(id: number, paint: Readonly<ModelPaint>): void {
    if (!Number.isInteger(id) || id < 0 || id >= MODEL_PAINT_CAPACITY) throw new RangeError(`model paint table: paint ${id} is outside 0..${MODEL_PAINT_CAPACITY - 1}`);
    const row = Math.floor(id / MODEL_PAINT_PER_ROW);
    const o = (row * MODEL_PAINT_WIDTH + (id % MODEL_PAINT_PER_ROW) * 3) * 4;
    const d = this.rows.data;
    d[o] = paint.albedo[0];
    d[o + 1] = paint.albedo[1];
    d[o + 2] = paint.albedo[2];
    d[o + 3] = paint.alpha;
    d[o + 4] = paint.emissive[0];
    d[o + 5] = paint.emissive[1];
    d[o + 6] = paint.emissive[2];
    d[o + 7] = paint.texSet;
    d[o + 8] = paint.roughness;
    d[o + 9] = paint.metalness;
    d[o + 10] = 0;
    d[o + 11] = 0;
    this.rows.markRow(row);
  }

  read(id: number): ModelPaint {
    const o = (Math.floor(id / MODEL_PAINT_PER_ROW) * MODEL_PAINT_WIDTH + (id % MODEL_PAINT_PER_ROW) * 3) * 4;
    const d = this.rows.data;
    return { albedo: [d[o]!, d[o + 1]!, d[o + 2]!], alpha: d[o + 3]!, emissive: [d[o + 4]!, d[o + 5]!, d[o + 6]!], texSet: d[o + 7]!, roughness: d[o + 8]!, metalness: d[o + 9]! };
  }

  flush(renderer: TableRenderer): TableFlush {
    return this.rows.flush(renderer);
  }

  dispose(): void {
    this.rows.dispose();
  }
}

// ── the shader side ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** `object.userData` key of an object's look row */
export const LOOK_ROW_KEY = 'ssLookRow';

/** Sets the look row an object's surface reads (0 = the neutral row). */
export function setLookRow(object: Object3D, row: number): void {
  object.userData[LOOK_ROW_KEY] = row;
}

/** the per-object uniform every model material shares (render §7.6): three updates it before each draw */
export const lookRow = uniform(0)
  .setName('ssLookRow')
  .onObjectUpdate(({ object }) => ((object as Object3D | null)?.userData[LOOK_ROW_KEY] as number | undefined) ?? 0);

/**
 * `object.userData` key of a corpse `BatchedMesh`: its texel row in `LookTable.batchRows` (render §11.5; set by
 * `CorpseBatcher`). Only such a batch reads its look rows per instance; every other object reads `ssLookRow`.
 */
export const CORPSE_BATCH_KEY = 'ssCorpseBatch';

/**
 * The per-object uniform of a corpse batch's texel row in `batchRows` (render §11.5). A uniform, not a constant: the batch's
 * row then stays out of the program text, so every corpse batch of a variant links the one program the warm-up compiled
 * (models/shader-variants.ts, a batched proxy with `CORPSE_BATCH_KEY` set), whichever row it holds.
 */
export const corpseBatchRow = uniform(0)
  .setName('ssCorpseBatchRow')
  .onObjectUpdate(({ object }) => ((object as Object3D | null)?.userData[CORPSE_BATCH_KEY] as number | undefined) ?? 0);

/**
 * The look row of the object being compiled: a corpse batch's instance row from `batchRows` through three's batch id, or
 * the per-object `ssLookRow` uniform. Decided per program at build time: every `BatchedMesh` compiles its own node build
 * (three keys it on the batch's matrices texture, RenderObject.getMaterialCacheKey), so no runtime branch is needed; the
 * batch's texel row is a uniform, so the text depends only on whether the object is a corpse batch.
 */
function lookRowNode(look: LookTable): Node<'float'> {
  return Fn((builder: NodeBuilder) => {
    const object = (builder as unknown as { object?: (Object3D & { isBatchedMesh?: boolean }) | null }).object;
    const batch = object?.isBatchedMesh === true ? object.userData[CORPSE_BATCH_KEY] : undefined;
    if (typeof batch !== 'number') return lookRow;
    return textureLoad(look.batchRows, ivec2(int(batchIndirectIndex), int(corpseBatchRow))).x;
  })() as unknown as Node<'float'>;
}

export interface ModelTables {
  look: LookTable;
  paint: ModelPaintTable;
}

/** 1×1 stand-ins for a texture set without a normal or an ORM map: the program does not depend on which maps a set has */
let flatNormalTexture: DataTexture | undefined;
let whiteTexture: DataTexture | undefined;
const pixel = (r: number, g: number, b: number, name: string): DataTexture => {
  const t = new DataTexture(new Uint8Array([r, g, b, 255]), 1, 1);
  t.name = name;
  t.needsUpdate = true;
  return t;
};
export const flatNormal = (): DataTexture => (flatNormalTexture ??= pixel(128, 128, 255, 'ss:flat-normal'));
export const whitePixel = (): DataTexture => (whiteTexture ??= pixel(255, 255, 255, 'ss:white'));

type F = Node<'float'>;
type V3 = Node<'vec3'>;
type V4 = Node<'vec4'>;

/** 1 where two integer-valued floats are equal, else 0 */
const same = (a: F, b: number | F): F => a.sub(b).abs().min(1).oneMinus() as F;

/**
 * A slot texture, with a sampler of its own. three shares one sampler among the texture nodes of one texture object (a
 * texture node's uniform hash is its texture's uuid), so a binding that reuses an object (two sets without a normal map
 * both read `flatNormal`; the warm-up's stand-in set reads `whitePixel` as albedo and as ORM) declared fewer samplers, and
 * wrote another program, than a binding of the same variant with maps of its own [M, tests/e2e M3 map smoke fingerprints:
 * the late warm-up's real binding linked a fragment program the stand-ins had not]. One sampler per slot role makes the
 * text a function of the variant only, so the stand-ins link the program of every binding (models/shader-variants.ts).
 */
const slotTexture = (map: Texture, at: Node) => {
  const node = texture(map, at);
  const hash = `ss:slot:${(node as unknown as { uuid: string }).uuid}`;
  (node as unknown as { getUniformHash: () => string }).getUniformHash = () => hash;
  return node;
};

interface EntryFlags {
  albedo: V3;
  tint: F;
  replace: F;
  emissive: V3;
  hasEmissive: F;
  scalesEmissive: F;
  emissiveScale: F;
  alpha: F;
  hasAlpha: F;
  roughness: F;
  hasRoughness: F;
  metalness: F;
  hasMetalness: F;
}

/** 1 where bit `part` of the look row's 128-bit part mask is set (the part is hidden), else 0; part 255 is never hidden */
function partHidden(lookTex: Texture, row: F, part: F): F {
  // bit `part` of the 128-bit mask: texel 96 + part / 64, word (part / 16) % 4, bit part % 16
  const maskable = step(part, LOOK_MAX_PARTS - 0.5) as F;
  const p = part.mul(maskable) as F;
  const texel = p.div(64).floor() as F;
  const inTexel = p.sub(texel.mul(64)) as F;
  const word = inTexel.div(16).floor() as F;
  const bit = inTexel.sub(word.mul(16)) as F;
  const mask = textureLoad(lookTex, ivec2(int(texel.add(LOOK_MASK_TEXEL)), int(row))) as unknown as V4;
  const value = mask.x.mul(same(word, 0)).add(mask.y.mul(same(word, 1))).add(mask.z.mul(same(word, 2))).add(mask.w.mul(same(word, 3))) as F;
  return int(value.add(0.5)).shiftRight(int(bit)).bitAnd(int(1)).toFloat().mul(maskable) as unknown as F;
}

/**
 * The part-mask factor of a model vertex for a surface that is not the model's own (RH1's highlight silhouettes,
 * src/render/special/highlight.ts): 0 for a vertex of a part the object's look row hides, else 1. It reads the same `ss`
 * attribute and the same per-object `ssLookRow` uniform as the model stages, so a silhouette follows `setParts` without a
 * program of its own per mask. Not for a corpse batch (its rows are per instance).
 */
export function partKeepNode(look: LookTable): Node<'float'> {
  const part = (attribute('partPaint', 'vec4') as V4).mul(255).round().x as F;
  return partHidden(look.texture, lookRow as unknown as F, part).oneMinus() as unknown as Node<'float'>;
}

/** The inputs of a glTF surface: the paint, the texture sets, the look row (see the header). Runs as the SRC_GLTF stage. */
function modelInputs(inputs: SurfaceInputs, ctx: SurfaceStageContext, tables: ModelTables): SurfaceInputs {
  const V = SurfaceVariant;
  const variant = ctx.variant;
  const load = (tex: Texture, x: F, y: F): V4 => textureLoad(tex, ivec2(int(x), int(y))) as unknown as V4;

  // vertex stage: everything below up to the varyings
  const ss = (attribute('partPaint', 'vec4') as V4).mul(255).round();
  const part = ss.x as F;
  const slot = ss.y as F;
  const paintId = ss.z.add(ss.w.mul(256)) as F;
  const paintY = paintId.div(MODEL_PAINT_PER_ROW).floor() as F;
  const paintX = paintId.sub(paintY.mul(MODEL_PAINT_PER_ROW)).mul(3) as F;
  const p0 = load(tables.paint.texture, paintX, paintY);
  const p1 = load(tables.paint.texture, paintX.add(1) as F, paintY);
  const p2 = load(tables.paint.texture, paintX.add(2) as F, paintY);

  let color = p0.rgb as V3;
  let alpha = p0.a as F;
  let emissive = p1.rgb as V3;
  const texSet = p1.a as F;
  let roughness = p2.r as F;
  let metalness = p2.g as F;
  const textured = step(0.5, texSet) as F;
  let albedoTex = textured;
  let roughnessTex = textured;
  let metalnessTex = textured;
  let keep: F = float(1) as F;

  if ((variant & (V.SLOTS | V.PARTMASK)) !== 0) {
    const row = lookRowNode(tables.look) as F;
    const lookTex = tables.look.texture;

    if ((variant & V.SLOTS) !== 0) {
      const entry = (x: F, on: F): EntryFlags => {
        const t0 = load(lookTex, x, row);
        const t1 = load(lookTex, x.add(1) as F, row);
        const t2 = load(lookTex, x.add(2) as F, row);
        const active = t2.z.mul(on) as F;
        const hasAlbedo = step(0, t0.r).mul(active) as F;
        return {
          albedo: t0.rgb as V3,
          replace: hasAlbedo.mul(t0.a) as F,
          tint: hasAlbedo.mul(t0.a.oneMinus()) as F,
          emissive: t1.rgb as V3,
          hasEmissive: step(0, t1.r).mul(active) as F,
          scalesEmissive: step(t1.r, -1.5).mul(active) as F,
          emissiveScale: t1.g as F,
          alpha: t1.a as F,
          hasAlpha: step(0, t1.a).mul(active) as F,
          roughness: t2.r as F,
          hasRoughness: step(0, t2.r).mul(active) as F,
          metalness: t2.g as F,
          hasMetalness: step(0, t2.g).mul(active) as F,
        };
      };
      const apply = (e: EntryFlags): void => {
        color = mix(color.mul(mix(vec3(1), e.albedo, e.tint)), e.albedo, e.replace) as V3;
        albedoTex = albedoTex.mul(e.replace.oneMinus()) as F;
        emissive = mix(emissive.mul(mix(float(1), e.emissiveScale, e.scalesEmissive)), e.emissive, e.hasEmissive) as V3;
        alpha = mix(alpha, e.alpha, e.hasAlpha) as F;
        roughness = mix(roughness, e.roughness, e.hasRoughness) as F;
        roughnessTex = roughnessTex.mul(e.hasRoughness.oneMinus()) as F;
        metalness = mix(metalness, e.metalness, e.hasMetalness) as F;
        metalnessTex = metalnessTex.mul(e.hasMetalness.oneMinus()) as F;
      };
      // the slot's entry: slots 0..31 at 3k, 32..36 past the part looks; a slot id beyond the row has none
      const slotX = slot.mul(LOOK_ENTRY_TEXELS).add(step(LOOK_BASE_SLOTS - 0.5, slot).mul(LOOK_EXTRA_SLOT_TEXEL - LOOK_BASE_SLOTS * LOOK_ENTRY_TEXELS)) as F;
      const slotOn = step(slot, LOOK_MAX_SLOTS - 0.5) as F;
      apply(entry(slotX.mul(slotOn) as F, slotOn));
      // the part's look, when the directory lists this part: it dresses over the slot's
      const dir = load(lookTex, float(LOOK_PART_DIR_TEXEL) as F, row);
      const id = part.add(1) as F;
      const m0 = same(dir.x as F, id);
      const m1 = same(dir.y as F, id);
      const m2 = same(dir.z as F, id);
      const m3 = same(dir.w as F, id);
      const index = m1.add(m2.mul(2)).add(m3.mul(3)) as F;
      const listed = m0.add(m1).add(m2).add(m3).min(1) as F;
      apply(entry(index.mul(LOOK_ENTRY_TEXELS).add(LOOK_PART_LOOK_TEXEL) as F, listed));
    }

    if ((variant & V.PARTMASK) !== 0) keep = keep.mul(partHidden(lookTex, row, part).oneMinus()) as F;
  }

  // each pass draws its own triangles: the opaque mesh drops what blends, the transparent mesh what does not
  const blends = step(ALPHA_OPAQUE, alpha).oneMinus() as F;
  keep = keep.mul((variant & V.TRANSPARENT) !== 0 ? blends : blends.oneMinus()) as F;

  // fragment stage
  const v0 = varying(vec4(color, alpha), 'v_ppColor') as unknown as V4;
  const v1 = varying(vec4(emissive, texSet.add(metalnessTex.mul(8))), 'v_ppEmissive') as unknown as V4;
  const v2 = varying(vec4(roughness, metalness, albedoTex, roughnessTex), 'v_ppSurface') as unknown as V4;
  const metalOn = step(7.5, v1.a) as F;
  const set = v1.a.sub(metalOn.mul(8)).round() as F;
  let outColor = v0.rgb as V3;
  let outRoughness = v2.x as F;
  let outMetalness = v2.y as F;
  let normal: Node | null = inputs.normal;

  const sets = texSlotCount(variant);
  if (sets > 0) {
    const bound = ctx.textures.slots ?? [];
    if (bound.length !== sets) throw new Error(`surface variant ${describeVariant(variant)}: ${sets} slot texture set(s) expected, ${bound.length} given`);
    const at = uv();
    let albedoSum: V3 = vec3(0) as V3;
    let ormSum: V3 = vec3(0) as V3;
    let normalSum: V3 = vec3(0) as V3;
    bound.forEach((s, i) => {
      const m = same(set, i + 1);
      albedoSum = albedoSum.add(slotTexture(s.albedo, at).rgb.mul(m)) as V3;
      ormSum = ormSum.add(slotTexture(s.orm ?? whitePixel(), at).rgb.mul(m)) as V3;
      normalSum = normalSum.add((normalMap(slotTexture(s.normal ?? flatNormal(), at)) as unknown as V3).mul(m)) as V3;
    });
    const any = step(0.5, set) as F;
    outColor = outColor.mul(mix(vec3(1), albedoSum, v2.z.round())) as V3;
    outRoughness = outRoughness.mul(mix(float(1), ormSum.y, v2.w.round())) as F;
    outMetalness = outMetalness.mul(mix(float(1), ormSum.z, metalOn)) as F;
    normal = mix(normalView, normalSum, any).normalize();
  }

  return {
    ...inputs,
    color: outColor,
    opacity: v0.a as F,
    emissive: v1.rgb as V3,
    roughness: outRoughness,
    metalness: outMetalness,
    normal,
    position: ((inputs.position as V3 | null) ?? positionLocal).mul(keep),
  };
}

/**
 * Registers the model stages on a variant cache: SRC_GLTF builds the inputs; TEX_SLOTS_n, SLOTS and PARTMASK are flags it
 * reads, so their own stages only check that they qualify a glTF source. Call once, before the first model material.
 */
export function registerModelStages(materials: SurfaceMaterials, tables: ModelTables): void {
  const V = SurfaceVariant;
  materials.registerStage(V.SRC_GLTF, (inputs, ctx) => modelInputs(inputs, ctx, tables));
  const qualifier = (name: string) => (inputs: SurfaceInputs, ctx: SurfaceStageContext): SurfaceInputs => {
    if ((ctx.variant & V.SRC_GLTF) === 0) throw new Error(`surface variant ${describeVariant(ctx.variant)}: ${name} qualifies SRC_GLTF (the model stages of surface/look-table.ts)`);
    return inputs;
  };
  materials.registerStage(SURFACE_TEX_SLOTS_MASK, qualifier('TEX_SLOTS_n'));
  materials.registerStage(V.SLOTS, qualifier('SLOTS'));
  materials.registerStage(V.PARTMASK, qualifier('PARTMASK'));
}
