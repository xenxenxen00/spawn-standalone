// The sprite bucket fill (render §13.4; DR-53): the particles of every unaligned sprite sink, per (space, blend), into a slot's
// arrays, and the back-to-front order of an alpha bucket. Three-free: the in-process runtime runs it on three's own attribute
// arrays (render/buckets.ts, whose buckets are slots), the fx Worker on its own slots, whose live prefixes it then copies into
// the transfer buffer. One code path, so both write the same floats. This is `FxSpriteBuckets.update` and the sort of its
// `#flush` as they stood before the move (tests/unit/render/fx/legacy/buckets.legacy.ts), operation for operation; the camera
// conversion is `worldToLocal`'s (`applyPointInto` with the camera's inverse, computed once per frame: the same floats).
import type { FxSimulation } from '../sim/simulator.ts';
import type { FxSpace, FxSpriteBlend } from '../fx-protocol.ts';
import { applyPointInto, applyPointZ, point } from './fx-math.ts';

/** the atlas cells, in the order of tools/render/fx-atlas.ts */
export const TEXTURE_NAMES = ['soft-disc', 'smoke-puff', 'ember', 'mote', 'flame-wisp', 'leaf', 'droplet', 'snowflake', 'petal', 'stalk', 'chip', 'grain', 'splinter', 'shard'] as const;
/** an alpha bucket of fewer particles is sorted back to front each frame */
export const SORT_LIMIT = 4096;
/** the components per particle of positions, scales, rotations, rgba, cells */
export const FIELD_SIZES = [3, 2, 1, 4, 1] as const;

const warnedUnsupported = new Set<string>();

/** one (space, blend) bucket's arrays: three's attributes in the in-process runtime, the worker's own arrays in the worker */
export interface SpriteSlot {
  readonly blend: FxSpriteBlend;
  readonly space: FxSpace;
  positions: Float32Array;
  scales: Float32Array;
  rotations: Float32Array;
  rgba: Float32Array;
  cells: Float32Array;
  depths: Float32Array;
  /** the bits of `depths` (the same buffer) */
  depthBits: Uint32Array;
  /** the alpha sort's keys, one per particle below the sort limit */
  keys: Float64Array;
  order: number[];
  scratch: [Float32Array, Float32Array, Float32Array, Float32Array, Float32Array];
  count: number;
}

/** where the slots live: `make` creates the slot of a (space, blend) the first time a sink needs it */
export interface SpriteSlots {
  get(key: string): SpriteSlot | undefined;
  make(key: string, blend: FxSpriteBlend, space: FxSpace): SpriteSlot;
  /** every slot, in the order they were made */
  values(): Iterable<SpriteSlot>;
  /** called before the fill writes `count` particles into a slot (the worker's slots grow; three's are capacity-sized) */
  ensure?(slot: SpriteSlot, count: number): void;
}

/** what a fill needs of the frame */
export interface FillFrame {
  readonly hasCamera: boolean;
  /** the inverse of the camera's world matrix; null without a camera */
  readonly inverse: Float64Array | null;
  readonly capacity: number;
  readonly distortEnabled: boolean;
  readonly alignedCards?: boolean;
  /** Camera world matrix for axis-card facing; null without a camera. */
  readonly camera?: ArrayLike<number> | null;
}

const spaceOf = (sim: FxSimulation, hasCamera: boolean): FxSpace => (sim.program.header.follow === 'camera' && hasCamera ? 'camera' : 'world');

/** a sink this fill takes: an unaligned sprite of a supported blend (and distort only on a tier with the distort pass) */
function takes(blend: string, distortEnabled: boolean): blend is FxSpriteBlend {
  if (blend !== 'alpha' && blend !== 'add' && blend !== 'distort') {
    if (!warnedUnsupported.has(blend)) {
      warnedUnsupported.add(blend);
      console.warn(`[fx] sprite blend '${blend}' is not used by live effects; skipped`);
    }
    return false;
  }
  return !(blend === 'distort' && distortEnabled === false);
}

const cellOf = (tex: string): number => Math.max(0, TEXTURE_NAMES.indexOf(tex as (typeof TEXTURE_NAMES)[number]));

/** the particles a slot will hold this frame, per slot (made in first-use order), bounded by the capacity */
const needs = new Map<SpriteSlot, number>();

/**
 * Fills the slots from `sims` (the live effects, in their order): every slot's count to 0, then per population of an unaligned
 * sprite sink its particles, up to the capacity, then the alpha sort of each slot. The caller then hands the slots on (three:
 * counts, ranges, visibility; the worker: the copy into the transfer buffers).
 */
export function fillSprites(sims: readonly FxSimulation[], frame: FillFrame, slots: SpriteSlots): void {
  for (const slot of slots.values()) slot.count = 0;
  const { hasCamera, capacity, distortEnabled } = frame;
  const e = frame.inverse;
  if (slots.ensure !== undefined) {
    needs.clear();
    for (const sim of sims) {
      const space = spaceOf(sim, hasCamera);
      for (const pop of sim.populations) {
        const sink = pop.program.sink;
        if (sink?.kind !== 'sprite' || sink.align !== undefined) continue;
        if (!takes(sink.blend, distortEnabled)) continue;
        const key = `${space}:${sink.blend}`;
        const slot = slots.get(key) ?? slots.make(key, sink.blend, space);
        needs.set(slot, Math.min(capacity, (needs.get(slot) ?? 0) + pop.count));
      }
    }
    for (const [slot, n] of needs) slots.ensure(slot, n);
    needs.clear();
  }
  for (const sim of sims) {
    const space = spaceOf(sim, hasCamera);
    for (const pop of sim.populations) {
      const sink = pop.program.sink;
      if (sink?.kind !== 'sprite' || sink.align !== undefined) continue;
      if (!takes(sink.blend, distortEnabled)) continue;
      const key = `${space}:${sink.blend}`;
      const slot = slots.get(key) ?? slots.make(key, sink.blend, space);
      // per population, hoisted out of the particle loop (cpu-budget CPU1 1.2): the sink's choices and the arrays. This loop
      // only takes sinks without `align` (the stretched fill takes the others), so width = height = size and the rotation is
      // the particle's own.
      const alpha = sink.blend === 'alpha';
      const cell = cellOf(sink.tex);
      const toCamera = space === 'camera' && e !== null;
      const positions = sim.positions, sizes = sim.sizes, rotations = sim.rotations, rgba = sim.rgba;
      const bp = slot.positions, bs = slot.scales, br = slot.rotations, bc = slot.rgba, bt = slot.cells, bd = slot.depths;
      const indices = pop.indices, n = pop.count;
      for (let k = 0; k < n && slot.count < capacity; k++) {
        const i = indices[k]!;
        const at = slot.count++;
        const v = i * 3;
        const c = i * 4;
        if (toCamera) {
          // Object3D.worldToLocal: applyMatrix4 by the inverse of the camera's world matrix
          applyPointInto(e, positions[v]!, positions[v + 1]!, positions[v + 2]!);
          bp[at * 3] = point[0]!;
          bp[at * 3 + 1] = point[1]!;
          bp[at * 3 + 2] = point[2]!;
        } else {
          bp[at * 3] = positions[v]!;
          bp[at * 3 + 1] = positions[v + 1]!;
          bp[at * 3 + 2] = positions[v + 2]!;
        }
        const size = sizes[i]!;
        bs[at * 2] = size;
        bs[at * 2 + 1] = size;
        br[at] = rotations[i]! + 0;
        const r = rgba[c]!, g = rgba[c + 1]!, b = rgba[c + 2]!;
        bc[at * 4] = alpha ? Math.min(1, r) : r;
        bc[at * 4 + 1] = alpha ? Math.min(1, g) : g;
        bc[at * 4 + 2] = alpha ? Math.min(1, b) : b;
        bc[at * 4 + 3] = Math.max(0, Math.min(1, rgba[c + 3]!));
        bt[at] = cell;
        if (space === 'camera') bd[at] = -point[2]!;
        else if (e !== null) {
          // Vector3.applyMatrix4 of the stored (float32) position, z only: the same products, sums and perspective divide
          bd[at] = -applyPointZ(e, bp[at * 3]!, bp[at * 3 + 1]!, bp[at * 3 + 2]!);
        } else bd[at] = -bp[at * 3 + 2]!;
      }
    }
  }
  for (const slot of slots.values()) sortSprites(slot, capacity);
}

/**
 * The back-to-front order of an alpha bucket into `order`, as `order.sort((a, b) => depths[b] - depths[a])` over 0..count-1
 * gives it (cpu-budget CPU1 1.2): that sort is stable, and for depths without NaN its comparator orders by value (two different
 * floats never subtract to 0; +0 and -0 compare equal, and so do two equal infinities, whose difference is NaN, read as 0), so
 * the result is "depth descending, then index ascending". Each particle gets one key that orders exactly so (the float32 depth
 * bits made monotonic, -0 as +0, inverted, times 4096, plus the index), and a native numeric sort of the keys replaces the
 * comparator calls. False (`order` untouched) when a depth is NaN or `count` is past the sort limit: the caller then sorts as
 * before. Writes `order[0..count)`; the caller sets its length.
 */
export function backToFront(depths: Float32Array, bits: Uint32Array, keys: Float64Array, order: number[], count: number): boolean {
  if (count > SORT_LIMIT || keys.length < count) return false;
  for (let i = 0; i < count; i++) {
    const d = depths[i]!;
    if (d !== d) return false;
    const b = d === 0 ? 0 : bits[i]!;
    // ascending by value: negative floats have their bits flipped, positive ones the sign bit set
    const ascending = b & 0x80000000 ? ~b >>> 0 : (b | 0x80000000) >>> 0;
    keys[i] = (0xffffffff - ascending) * SORT_LIMIT + i;
  }
  const sorted = keys.subarray(0, count).sort();
  for (let i = 0; i < count; i++) order[i] = sorted[i]! % SORT_LIMIT;
  return true;
}

/** the sort of the legacy `#flush`: an alpha slot below the sort limit is permuted back to front, field by field */
export function sortSprites(slot: SpriteSlot, capacity: number): void {
  const count = slot.count;
  if (slot.blend === 'alpha' && count < SORT_LIMIT) {
    const order = slot.order;
    if (!backToFront(slot.depths, slot.depthBits, slot.keys, order, count)) {
      for (let i = 0; i < count; i++) order[i] = i;
      order.length = count;
      order.sort((a, b) => slot.depths[b]! - slot.depths[a]!);
    }
    order.length = count;
    const fields = [slot.positions, slot.scales, slot.rotations, slot.rgba, slot.cells];
    for (let field = 0; field < fields.length; field++) {
      const data = fields[field]!;
      const size = FIELD_SIZES[field]!;
      const scratch = slot.scratch[field]!;
      scratch.set(data.subarray(0, count * size), 0);
      // element copies: a `subarray` view per particle per field was the flush's garbage (cpu-budget X-38)
      for (let to = 0; to < count; to++) {
        const from = order[to]! * size;
        const at = to * size;
        for (let k = 0; k < size; k++) data[at + k] = scratch[from + k]!;
      }
    }
  } else slot.order.length = slot.order.length < capacity ? capacity : slot.order.length;
}

/** a slot of `size` particles (the worker's; three's buckets are their own slots) */
export function makeSpriteSlot(blend: FxSpriteBlend, space: FxSpace, size: number): SpriteSlot {
  const depths = new Float32Array(size);
  return {
    blend, space,
    positions: new Float32Array(size * 3),
    scales: new Float32Array(size * 2),
    rotations: new Float32Array(size),
    rgba: new Float32Array(size * 4),
    cells: new Float32Array(size),
    depths,
    depthBits: new Uint32Array(depths.buffer),
    keys: new Float64Array(blend === 'alpha' ? Math.min(size, SORT_LIMIT) : 0),
    order: [],
    scratch: [new Float32Array(size * 3), new Float32Array(size * 2), new Float32Array(size), new Float32Array(size * 4), new Float32Array(size)],
    count: 0,
  };
}

/** grows a worker slot to hold `n` particles (×2, up to `capacity`); the fill rewrites [0, n) every frame, so nothing is kept */
export function growSpriteSlot(slot: SpriteSlot, n: number, capacity: number): void {
  if (slot.cells.length >= n) return;
  const size = Math.min(capacity, Math.max(n, slot.cells.length * 2, 64));
  const fresh = makeSpriteSlot(slot.blend, slot.space, size);
  slot.positions = fresh.positions;
  slot.scales = fresh.scales;
  slot.rotations = fresh.rotations;
  slot.rgba = fresh.rgba;
  slot.cells = fresh.cells;
  slot.depths = fresh.depths;
  slot.depthBits = fresh.depthBits;
  slot.keys = fresh.keys;
  slot.scratch = fresh.scratch;
}

/** a slot's live prefixes back to back into `out` (SPRITE_FLOATS × count): [positions | scales | rotations | rgba | cells] */
export function packSprites(slot: SpriteSlot, out: Float32Array): void {
  const n = slot.count;
  out.set(slot.positions.subarray(0, n * 3), 0);
  out.set(slot.scales.subarray(0, n * 2), n * 3);
  out.set(slot.rotations.subarray(0, n), n * 5);
  out.set(slot.rgba.subarray(0, n * 4), n * 6);
  out.set(slot.cells.subarray(0, n), n * 10);
}
