// Paint tables (docs/design/rendering.md §6.6, D5; WP R3): the look of packed scripted geometry lives in data textures, not
// in the vertices. A packed vertex carries only a **local** paint id (the `w` of its int16 position, `pack.ts`).
//
//   PaintRecords   RGBA32F, width 4,096, 3 texels per paint: the packer's 12-float record as it is (`PAINT_FLOATS`), so a
//                  paint list is copied in without a shuffle: albedo rgb + alpha; emissive rgb + roughness; metalness, flags,
//                  texId, pad (render §6.6 lists the same values in another texel order; the pad is its wet-mask slot). Records are deduplicated by their float bits
//                  (`intern`). The default capacity is 65,535 paints (48 rows, 3.1 MB); a table may be larger, because a
//                  record id is a float in the index, not the vertex's int16. Also the per-model and look tables of R6
//   PaintIndex     R32F, width 4,096, one entry per texel: the record id of a (block, local id). A chunk or a key LOD
//                  appends its paint list as one contiguous block and its meshes get the block start as the per-object uniform
//                  `paintBase` (`setPaintBase`), so no vertex is rewritten on the main thread
//   MapPaint       the pair of one place, plus the reserve the runtime keys of a match append to
//
// Vertex stage (the `SRC_PACKED` input stage, `packedPaintStage`):
//   local  = round(w · 32767) + 32767                         the D5 lane
//   id     = texelFetch(index, (paintBase + local) → x, y).r
//   texel k of the paint = texelFetch(records, (id · 3 + k) → x, y), k = 0..2, passed on as flat varyings
//
// Why two levels (a measured deviation from render §6.6, which appends chunk paint blocks straight into the paint table with
// no cross-chunk dedupe and assumes the table "stays far below" its 65,535 entries): the chunk blocks of a map add up to
// 26,256 (gallow-farm) to 160,259 (grimland-park) entries on `high` [M `tools/render/geometry-check.ts`], while the map has
// only 10,807 to 26,060 distinct paints. The index holds the blocks at 4 bytes per entry (≤ 0.65 MB); the records stay
// deduplicated (≤ 1.25 MB), and the main thread still only appends.
//
// Uploads. A table is uploaded whole the first time (`needsUpdate`). `Texture.addUpdateRange` is not read by any texture path
// of r186, so a later append goes through a small staging `DataTexture` and `renderer.copyTextureToTexture(staging, table,
// region, position)`: one `texSubImage2D` of the touched rows on the WebGL2 backend, a GPU copy on WebGPU. The table's own
// `image.data` always holds everything (a device-loss rebuild re-uploads it whole: `markLost`).
import { attribute, float, int, ivec2, mix, negateOnBackSide, normalFlat, normalLocal, textureLoad, transformNormalToView, uniform, varying } from 'three/tsl';
import { AttributeNode, Box2, DataTexture, FloatType, NearestFilter, RGBAFormat, RedFormat, Vector2, Vector4 } from 'three/webgpu';
import type { Node, Object3D, Texture } from 'three/webgpu';
import { PAINT_FLOATS, PAINT_ID_BIAS } from '../geometry/pack.ts';
import { SurfaceVariant, type SurfaceInputStage, type SurfaceInputs, type SurfaceMaterials } from './surface-material.ts';

export const PAINT_TABLE_WIDTH = 4096;
/** RGBA texels per paint record */
export const PAINT_TEXELS = 3;
/** local ids are int16-coded (D5): a block holds at most this many paints */
export const MAX_PAINTS = 65535;
const STAGING_ROWS = 4;

/** the part of the renderer a partial upload needs */
export interface PaintUploader {
  copyTextureToTexture(src: Texture, dst: Texture, srcRegion?: Box2 | null, dstPosition?: Vector2 | null): void;
}

export type FlushResult = 'none' | 'full' | 'rows';

/** A float data texture that grows by appends and uploads only what changed. */
class FloatTable {
  readonly texture: DataTexture;
  readonly width: number;
  readonly rows: number;
  /** floats per texel: 4 (RGBA32F) or 1 (R32F) */
  readonly channels: 1 | 4;
  readonly data: Float32Array;
  protected floats = 0;
  #uploaded = false;
  #dirtyFrom = Infinity;
  #dirtyTo = -Infinity;
  #staging: DataTexture | null = null;

  constructor(name: string, channels: 1 | 4, capacityFloats: number, width: number) {
    if (!Number.isInteger(width) || width < 1) throw new RangeError(`${name}: width ${width}`);
    this.width = width;
    this.channels = channels;
    this.rows = Math.max(1, Math.ceil(capacityFloats / (width * channels)));
    this.data = new Float32Array(this.rows * width * channels);
    const t = new DataTexture(this.data, width, this.rows, channels === 4 ? RGBAFormat : RedFormat, FloatType);
    t.name = name;
    t.minFilter = NearestFilter;
    t.magFilter = NearestFilter;
    t.generateMipmaps = false;
    t.flipY = false;
    this.texture = t;
  }

  /** floats the texture can hold */
  get capacityFloats(): number {
    return this.data.length;
  }

  protected reserve(n: number): number {
    const at = this.floats;
    if (at + n > this.data.length) throw new RangeError(`${this.texture.name}: full (${this.data.length} floats, ${at} used, ${n} more asked)`);
    this.floats = at + n;
    if (at < this.#dirtyFrom) this.#dirtyFrom = at;
    if (at + n > this.#dirtyTo) this.#dirtyTo = at + n;
    return at;
  }

  /** forgets every entry; the next flush uploads the whole table again */
  clear(): void {
    this.floats = 0;
    this.data.fill(0);
    this.#uploaded = false;
    this.#dirtyFrom = Infinity;
    this.#dirtyTo = -Infinity;
  }

  /** the GPU copy is gone (device loss): the next flush uploads the whole table */
  markLost(): void {
    this.#uploaded = false;
  }

  /** true when entries were appended since the last flush */
  get dirty(): boolean {
    return this.#dirtyTo > this.#dirtyFrom || !this.#uploaded;
  }

  /**
   * Sends what changed since the last flush: the whole image the first time (or with no uploader), else only the texel rows
   * that were appended to, through the staging texture.
   */
  flush(uploader?: PaintUploader | null): FlushResult {
    if (!this.#uploaded || uploader === undefined || uploader === null) {
      const had = this.#uploaded && this.#dirtyTo <= this.#dirtyFrom;
      this.#dirtyFrom = Infinity;
      this.#dirtyTo = -Infinity;
      if (had) return 'none';
      this.texture.needsUpdate = true;
      this.#uploaded = true;
      return 'full';
    }
    if (this.#dirtyTo <= this.#dirtyFrom) return 'none';
    const perRow = this.width * this.channels;
    const y0 = Math.floor(this.#dirtyFrom / perRow);
    const y1 = Math.floor((this.#dirtyTo - 1) / perRow);
    this.#dirtyFrom = Infinity;
    this.#dirtyTo = -Infinity;
    let staging = this.#staging;
    if (staging === null) {
      staging = new DataTexture(new Float32Array(STAGING_ROWS * perRow), this.width, STAGING_ROWS, this.channels === 4 ? RGBAFormat : RedFormat, FloatType);
      staging.name = `${this.texture.name}:staging`;
      staging.minFilter = NearestFilter;
      staging.magFilter = NearestFilter;
      staging.generateMipmaps = false;
      staging.flipY = false;
      this.#staging = staging;
    }
    const stage = staging.image.data as Float32Array;
    for (let y = y0; y <= y1; y += STAGING_ROWS) {
      const n = Math.min(STAGING_ROWS, y1 - y + 1);
      stage.set(this.data.subarray(y * perRow, (y + n) * perRow));
      staging.needsUpdate = true;
      uploader.copyTextureToTexture(staging, this.texture, new Box2(new Vector2(0, 0), new Vector2(this.width, n)), new Vector2(0, y));
    }
    return 'rows';
  }

  dispose(): void {
    this.texture.dispose();
    this.#staging?.dispose();
    this.#staging = null;
  }
}

function mix32(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return h ^ (h >>> 16);
}

export interface PaintRecordsOptions {
  /** most paints the table can hold (default 65,535) */
  capacity?: number;
  width?: number;
  name?: string;
}

/** The record table: 12 floats per paint as 3 RGBA32F texels, deduplicated by float bits. */
export class PaintRecords extends FloatTable {
  readonly capacity: number;
  readonly #bits: Uint32Array;
  #slots: Int32Array;
  #mask: number;
  readonly #scratch = new Float32Array(PAINT_FLOATS);
  readonly #scratchBits = new Uint32Array(this.#scratch.buffer);

  constructor(opts: PaintRecordsOptions = {}) {
    const capacity = Math.max(1, Math.floor(opts.capacity ?? MAX_PAINTS));
    super(opts.name ?? 'ss:paint-records', 4, capacity * PAINT_FLOATS, opts.width ?? PAINT_TABLE_WIDTH);
    this.capacity = capacity;
    this.#bits = new Uint32Array(this.data.buffer);
    let size = 1024;
    while (size < capacity * 2) size *= 2;
    this.#slots = new Int32Array(size);
    this.#mask = size - 1;
  }

  /** paints in the table */
  get count(): number {
    return this.floats / PAINT_FLOATS;
  }

  /** The id of a 12-float record (at `records[offset..]`), appended when no equal record is in the table. */
  intern(records: ArrayLike<number>, offset = 0): number {
    const f = this.#scratch;
    for (let i = 0; i < PAINT_FLOATS; i++) f[i] = records[offset + i]!;
    const b = this.#scratchBits;
    let h = 0x9e3779b9;
    for (let i = 0; i < PAINT_FLOATS; i++) h = mix32(h ^ b[i]!) + i;
    let slot = mix32(h) & this.#mask;
    const slots = this.#slots;
    const bits = this.#bits;
    for (;;) {
      const e = slots[slot]!;
      if (e === 0) break;
      const base = (e - 1) * PAINT_FLOATS;
      let same = true;
      for (let i = 0; i < PAINT_FLOATS; i++) {
        if (bits[base + i] !== b[i]) {
          same = false;
          break;
        }
      }
      if (same) return e - 1;
      slot = (slot + 1) & this.#mask;
    }
    const id = this.count;
    if (id >= this.capacity) throw new RangeError(`${this.texture.name}: more than ${this.capacity} distinct paints`);
    this.data.set(f, this.reserve(PAINT_FLOATS));
    slots[slot] = id + 1;
    return id;
  }

  /** the 12 floats of a paint (a view into the table) */
  record(id: number): Float32Array {
    if (!(id >= 0 && id < this.count)) throw new RangeError(`${this.texture.name}: no paint ${id}`);
    return this.data.subarray(id * PAINT_FLOATS, (id + 1) * PAINT_FLOATS);
  }

  override clear(): void {
    super.clear();
    this.#slots.fill(0);
  }
}

export interface PaintIndexOptions {
  /** most entries (default 262,144 = 64 rows, 1 MB) */
  capacity?: number;
  width?: number;
  name?: string;
}

/** The block table: one record id per (block, local paint id), R32F. */
export class PaintIndex extends FloatTable {
  constructor(opts: PaintIndexOptions = {}) {
    super(opts.name ?? 'ss:paint-index', 1, Math.max(1, Math.floor(opts.capacity ?? 262144)), opts.width ?? PAINT_TABLE_WIDTH);
  }

  get count(): number {
    return this.floats;
  }

  /** room left, in entries */
  get free(): number {
    return this.capacityFloats - this.floats;
  }

  /** Appends a block of `n` entries and returns its start; the caller writes the ids into `data[start..start + n)`. */
  allocate(n: number): number {
    return this.reserve(n);
  }
}

export interface MapPaintOptions {
  /** distinct paints the records can hold (default 65,535: 48 rows, 3.1 MB; size it to the place) */
  paints?: number;
  /** index entries (default 262,144) */
  entries?: number;
  width?: number;
  name?: string;
}

/**
 * The paint tables of the packed geometry of one place: deduplicated records and the block index. Size it with room for the
 * runtime keys of a match (door wrecks, damage stages): they append to the same pair, so the tables never reallocate during gameplay.
 */
export class MapPaint {
  readonly records: PaintRecords;
  readonly index: PaintIndex;

  constructor(opts: MapPaintOptions = {}) {
    const name = opts.name ?? 'ss:map-paint';
    const width = opts.width ?? PAINT_TABLE_WIDTH;
    this.records = new PaintRecords({ ...(opts.paints === undefined ? {} : { capacity: opts.paints }), width, name: `${name}:records` });
    this.index = new PaintIndex({ ...(opts.entries === undefined ? {} : { capacity: opts.entries }), width, name: `${name}:index` });
  }

  /**
   * Appends a paint list (`PAINT_FLOATS` per local paint, as `PackedLod.paints` / `PackedChunk.paints`) as one block and returns
   * the block start: the `paintBase` of every mesh that draws vertices with these local ids.
   */
  addBlock(paints: Float32Array): number {
    const n = paints.length / PAINT_FLOATS;
    if (!Number.isInteger(n)) throw new RangeError(`MapPaint.addBlock: ${paints.length} floats is not a whole number of records`);
    if (n > MAX_PAINTS) throw new RangeError(`MapPaint.addBlock: a block holds at most ${MAX_PAINTS} paints, got ${n}`);
    const base = this.index.allocate(n);
    const out = this.index.data;
    for (let i = 0; i < n; i++) out[base + i] = this.records.intern(paints, i * PAINT_FLOATS);
    return base;
  }

  /** whether a block of `paints` records certainly fits (every record counted as new) */
  fits(paints: number): boolean {
    return this.index.free >= paints && this.records.capacity - this.records.count >= paints;
  }

  /** the record a (block, local id) resolves to */
  recordOf(base: number, local: number): Float32Array {
    return this.records.record(this.index.data[base + local]!);
  }

  flush(uploader?: PaintUploader | null): { records: FlushResult; index: FlushResult } {
    return { records: this.records.flush(uploader), index: this.index.flush(uploader) };
  }

  clear(): void {
    this.records.clear();
    this.index.clear();
  }

  markLost(): void {
    this.records.markLost();
    this.index.markLost();
  }

  /** CPU bytes of the two tables (the GPU copies are the same size) */
  get bytes(): number {
    return this.records.data.byteLength + this.index.data.byteLength;
  }

  dispose(): void {
    this.records.dispose();
    this.index.dispose();
  }
}

// ── the SRC_PACKED input stage ──────────────────────────────────────────────────────────────────────────────────────────

/** the geometry attribute that aliases the packed position as a vec4 (three reads `position` as its `.xyz`) */
export const PACKED_ATTRIBUTE = 'ssPacked';
/** the geometry attribute that aliases the mesh normal as a vec4 (three reads `normal` as its `.xyz`; w marks smooth vertices) */
export const PACKED_NORMAL_ATTRIBUTE = 'ssNormal';
/** K10b: the geometry attribute holding per-vertex RGBA (linear rgb, alpha), read only by a stage built with `vertexColors` */
export const PACKED_COLOR_ATTRIBUTE = 'ssColor';
const PAINT_BASE_KEY = 'ssPaintBase';

/**
 * `ssColor` read as a multiplier: a geometry that does not carry the attribute (a level packed without `{ colors }`, a batched
 * chunk) reads white, which leaves the paint as it is, instead of three's zero constant and its "Vertex attribute not found on
 * geometry" warning on every program build. A geometry that has it is read as before.
 */
export class VertexColorNode extends AttributeNode<'vec4'> {
  override generate(builder: Parameters<AttributeNode['generate']>[0]): string | null | undefined {
    const b = builder as unknown as { hasGeometryAttribute(name: string): boolean; generateConst(type: string, value: unknown): string };
    if (b.hasGeometryAttribute(this.getAttributeName(builder))) return super.generate(builder);
    return b.generateConst(this.getNodeType(builder) ?? 'vec4', new Vector4(1, 1, 1, 1));
  }
}

/** The block start of an object's paints (`MapPaint.addBlock`): a per-object uniform, never a program or a material. */
export function setPaintBase(object: Object3D, base: number): void {
  object.userData[PAINT_BASE_KEY] = base;
}

export function paintBaseOf(object: Object3D | null | undefined): number {
  const b = object?.userData[PAINT_BASE_KEY] as number | undefined;
  return typeof b === 'number' ? b : 0;
}

/** what the stage reads; `tables` may be replaced when a new place is built (the bound textures are not part of the program) */
export interface PackedPaintSource {
  /** rebinds the stage's texture nodes to another place's tables */
  setTables(paint: MapPaint): void;
  readonly stage: SurfaceInputStage;
}

/**
 * The `SRC_PACKED` stage (render §6.6, §7.2). Under `'source'` it replaces colour, opacity, emissive, roughness and metalness
 * with the paint-table reads (vertex stage, flat varyings). Under `'object'` (a row texture set or a flat preset, §7.4) it
 * changes nothing: the look is the object's paint, the position is the packed attribute's `.xyz` and the uv the geometry's.
 */
export interface PackedPaintSourceOptions {
  /**
   * K10b: multiply the paint's colour and opacity by the vertex attribute `ssColor` (a vec4: linear rgb, alpha), so
   * `geometry()` `{ colors }` gradients and alpha feathers show. Default false: the legacy host's program is unchanged. When true every
   * packed geometry this stage draws needs the attribute (a level packed without `{ colors }` reads zeros), so the owner
   * turns `vertexColors` on in the recorder (JobRunnerOptions) and here together.
   */
  vertexColors?: boolean;
}

export function createPackedPaintSource(paint: MapPaint, opts: PackedPaintSourceOptions = {}): PackedPaintSource {
  let current = paint;
  const nodes: Array<{ records: { value: Texture }; index: { value: Texture } }> = [];
  const stage: SurfaceInputStage = (given: SurfaceInputs, ctx): SurfaceInputs => {
    let inputs = given;
    if ((ctx.variant & SurfaceVariant.NORMALS) !== 0) {
      // A packed mesh with smooth faces (`map-plan.ts` `writeMeshNormal`): its `normal` attribute holds a normal on every
      // vertex and w = 1 on the smooth ones. A triangle is smooth or flat as a whole (the normal is part of the vertex key),
      // so the mask is constant across it: the interpolated normal on smooth faces, the face normal on flat ones. Arithmetic,
      // not a branch (three emits what only a branch uses inside that branch).
      const smooth = varying(attribute<'vec4'>(PACKED_NORMAL_ATTRIBUTE, 'vec4').w, 'vPpSmooth').setInterpolation('flat') as unknown as Node<'float'>;
      const interpolated = negateOnBackSide(varying(transformNormalToView(normalLocal), 'vPpNormal').normalize());
      inputs = { ...inputs, normal: mix(normalFlat, interpolated, smooth) };
    }
    if (ctx.paint === 'object') return inputs;
    const width = current.records.width;
    if (current.index.width !== width) throw new Error('packed paint stage: the two tables must share a width');
    const W = float(width);
    const coord = (i: Node<'float'>): Node<'ivec2'> => {
      const y = i.div(W).floor();
      return ivec2(int(i.sub(y.mul(W))), int(y));
    };
    const packed = attribute<'vec4'>(PACKED_ATTRIBUTE, 'vec4');
    // round(w · 32767) + 32767, with w ≥ −1 by construction
    const local = packed.w.mul(PAINT_ID_BIAS).add(PAINT_ID_BIAS + 0.5).floor();
    const base = uniform(0).onObjectUpdate(({ object }) => paintBaseOf(object));
    const indexNode = textureLoad(current.index.texture, coord(base.add(local)));
    const first = indexNode.r.mul(PAINT_TEXELS);
    const recordNodes = [0, 1, 2].map((k) => textureLoad(current.records.texture, coord(first.add(k))));
    nodes.push({ records: recordNodes[0] as unknown as { value: Texture }, index: indexNode as unknown as { value: Texture } });
    for (const n of recordNodes.slice(1)) nodes.push({ records: n as unknown as { value: Texture }, index: indexNode as unknown as { value: Texture } });
    // every vertex of a triangle carries the same paint (vertices are deduplicated on (position, paint)): flat varyings
    const flat = (n: Node, name: string): Node<'vec4'> => varying(n, name).setInterpolation('flat') as unknown as Node<'vec4'>;
    const t0 = flat(recordNodes[0]!, 'vPpPaint0');
    const t1 = flat(recordNodes[1]!, 'vPpPaint1');
    const t2 = flat(recordNodes[2]!, 'vPpPaint2');
    // the record's order: albedo rgb, alpha | emissive rgb, roughness | metalness, flags, texId, pad
    if (opts.vertexColors) {
      const vc = varying(new VertexColorNode(PACKED_COLOR_ATTRIBUTE, 'vec4') as unknown as Node, 'vPpVertexColor') as unknown as Node<'vec4'>;
      return { ...inputs, color: t0.rgb.mul(vc.rgb), opacity: t0.a.mul(vc.a), emissive: t1.rgb, roughness: t1.a, metalness: t2.r };
    }
    return { ...inputs, color: t0.rgb, opacity: t0.a, emissive: t1.rgb, roughness: t1.a, metalness: t2.r };
  };
  return {
    stage,
    setTables(next: MapPaint): void {
      current = next;
      for (const n of nodes) {
        n.records.value = next.records.texture;
        n.index.value = next.index.texture;
      }
    },
  };
}

/** Registers the packed stage on a variant cache and returns the source (to rebind tables per place). */
export function registerPackedSurface(materials: SurfaceMaterials, paint: MapPaint, opts: PackedPaintSourceOptions = {}): PackedPaintSource {
  const source = createPackedPaintSource(paint, opts);
  materials.registerStage(SurfaceVariant.SRC_PACKED, source.stage);
  return source;
}
