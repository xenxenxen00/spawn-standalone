// The stretched-quad bucket fill (render §13.4; DR-53): velocity- and axis-aligned sprite sinks, per (space, blend), as instance
// matrices, rgba and cells. Three-free, run on three's arrays in-process (render/stretched-buckets.ts) and on the worker's own
// slots in the fx Worker: `FxStretchedBuckets.update` as it stood before the move (tests/unit/render/fx/legacy/
// stretched-buckets.legacy.ts), operation for operation, the camera conversion through the camera's inverse (fx-math.ts).
import type { FxSimulation } from '../sim/simulator.ts';
import type { FxSpace, FxSpriteBlend } from '../fx-protocol.ts';
import { applyPointInto, composeInto, point, rotationFromY, rotationIdentity } from './fx-math.ts';
import { TEXTURE_NAMES, type FillFrame } from './fill-sprites.ts';

/** one (space, blend) bucket of stretched quads */
export interface StretchedSlot {
  readonly blend: FxSpriteBlend;
  readonly space: FxSpace;
  matrices: Float32Array;
  rgba: Float32Array;
  cells: Float32Array;
  count: number;
}

export interface StretchedSlots {
  get(key: string): StretchedSlot | undefined;
  make(key: string, blend: FxSpriteBlend, space: FxSpace): StretchedSlot;
  values(): Iterable<StretchedSlot>;
  /** called before the fill writes `count` particles into a slot (the worker's slots grow) */
  ensure?(slot: StretchedSlot, count: number): void;
}

const needs = new Map<StretchedSlot, number>();
const center = { x: 0, y: 0, z: 0 }, direction = { x: 0, y: 1, z: 0 }, eye = { x: 0, y: 0, z: 0 };
type Xyz = Readonly<{ x: number; y: number; z: number }>;

/** A camera-facing card whose local +y follows dir (unit), written column-major. */
export function composeAxisCard(out: Float32Array, offset: number, at: Xyz, dir: Xyz, viewer: Xyz, width: number, length: number): void {
  const ex = viewer.x - at.x, ey = viewer.y - at.y, ez = viewer.z - at.z;
  let rx = dir.y * ez - dir.z * ey, ry = dir.z * ex - dir.x * ez, rz = dir.x * ey - dir.y * ex;
  if (rx * rx + ry * ry + rz * rz < 1e-12) {
    // Looking down the axis: choose any perpendicular, as the previous three-based fill did.
    rx = 0; ry = -dir.z; rz = dir.y;
    if (rx * rx + ry * ry + rz * rz < 1e-12) { rx = -dir.y; ry = dir.x; rz = 0; }
  }
  const k = 1 / (Math.sqrt(rx * rx + ry * ry + rz * rz) || 1);
  rx *= k; ry *= k; rz *= k;
  out[offset] = rx * width; out[offset + 1] = ry * width; out[offset + 2] = rz * width; out[offset + 3] = 0;
  out[offset + 4] = dir.x * length; out[offset + 5] = dir.y * length; out[offset + 6] = dir.z * length; out[offset + 7] = 0;
  out[offset + 8] = ry * dir.z - rz * dir.y; out[offset + 9] = rz * dir.x - rx * dir.z; out[offset + 10] = rx * dir.y - ry * dir.x; out[offset + 11] = 0;
  out[offset + 12] = at.x; out[offset + 13] = at.y; out[offset + 14] = at.z; out[offset + 15] = 1;
}

const takes = (blend: string, distortEnabled: boolean): blend is FxSpriteBlend =>
  (blend === 'alpha' || blend === 'add' || blend === 'distort') && !(blend === 'distort' && distortEnabled === false);

/** Fills the slots from `sims` (the live effects, in their order): every count to 0, then the aligned sprite sinks. */
export function fillStretched(sims: readonly FxSimulation[], frame: FillFrame, slots: StretchedSlots): void {
  for (const slot of slots.values()) slot.count = 0;
  const { hasCamera, capacity, distortEnabled } = frame;
  const e = frame.inverse;
  if (slots.ensure !== undefined) {
    needs.clear();
    for (const sim of sims) {
      const space: FxSpace = sim.program.header.follow === 'camera' && hasCamera ? 'camera' : 'world';
      for (const pop of sim.populations) {
        const sink = pop.program.sink;
        if (sink?.kind !== 'sprite' || sink.align === undefined) continue;
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
    const space: FxSpace = sim.program.header.follow === 'camera' && hasCamera ? 'camera' : 'world';
    for (const pop of sim.populations) {
      const sink = pop.program.sink;
      if (sink?.kind !== 'sprite' || sink.align === undefined) continue;
      if (!takes(sink.blend, distortEnabled)) continue;
      const key = `${space}:${sink.blend}`;
      const slot = slots.get(key) ?? slots.make(key, sink.blend, space);
      // per population (cpu-budget CPU1 1.2): the sink's choices, the cell, and the rotation, which is the sink's alone
      // (three's `setFromUnitVectors(+Y, axis.normalize())` or the identity, fx-math.ts)
      const velocityAligned = sink.align === 'velocity';
      const travel = sink.stretch ?? 0;
      const colorLimit = sink.blend === 'alpha' ? 1 : Number.POSITIVE_INFINITY;
      const cell = Math.max(0, TEXTURE_NAMES.indexOf(sink.tex as (typeof TEXTURE_NAMES)[number]));
      const toCamera = space === 'camera' && e !== null;
      const positions = sim.positions, velocities = sim.velocities, sizes = sim.sizes, rgba = sim.rgba;
      const aligned = frame.alignedCards === true;
      const camera = frame.camera;
      eye.x = toCamera ? 0 : camera?.[12] ?? 0;
      eye.y = toCamera ? 0 : camera?.[13] ?? 0;
      eye.z = toCamera ? 0 : camera?.[14] ?? 1e6;
      const matrices = slot.matrices, out = slot.rgba, cells = slot.cells;
      if (sink.align === 'axis' && sink.axis) {
        // Vector3.normalize: divideScalar(length() || 1), each component times 1 / length
        const ax = sink.axis[0], ay = sink.axis[1], az = sink.axis[2];
        const k = 1 / (Math.sqrt(ax * ax + ay * ay + az * az) || 1);
        rotationFromY(ax * k, ay * k, az * k);
      } else rotationIdentity();
      const indices = pop.indices, n = pop.count;
      for (let s = 0; s < n && slot.count < capacity; s++) {
        const i = indices[s]!;
        const index = slot.count++;
        const p = i * 3, c = i * 4;
        let px = positions[p]!, py = positions[p + 1]!, pz = positions[p + 2]!;
        if (toCamera) {
          applyPointInto(e, px, py, pz);
          px = point[0]!; py = point[1]!; pz = point[2]!;
        }
        const size = sizes[i]!;
        const stretch = velocityAligned ? size + Math.hypot(velocities[p]!, velocities[p + 1]!, velocities[p + 2]!) * travel : aligned ? size + (sink.stretch ?? 0) : sink.stretch ?? size;
        if (aligned) {
          let dx = velocityAligned ? velocities[p]! : sink.axis?.[0] ?? 0;
          let dy = velocityAligned ? velocities[p + 1]! : sink.axis?.[1] ?? 1;
          let dz = velocityAligned ? velocities[p + 2]! : sink.axis?.[2] ?? 0;
          if (velocityAligned && dx * dx + dy * dy + dz * dz < 1e-12) { dx = 0; dy = 1; dz = 0; }
          if (toCamera) {
            const x = e[0]! * dx + e[4]! * dy + e[8]! * dz;
            const y = e[1]! * dx + e[5]! * dy + e[9]! * dz;
            dz = e[2]! * dx + e[6]! * dy + e[10]! * dz;
            dx = x; dy = y;
          }
          const k = 1 / (Math.sqrt(dx * dx + dy * dy + dz * dz) || 1);
          direction.x = dx * k; direction.y = dy * k; direction.z = dz * k;
          center.x = px; center.y = py; center.z = pz;
          composeAxisCard(matrices, index * 16, center, direction, eye, size, Math.max(0, stretch));
        } else composeInto(matrices, index * 16, px, py, pz, size, Math.max(0, stretch), size);
        out[index * 4] = Math.min(colorLimit, rgba[c]!);
        out[index * 4 + 1] = Math.min(colorLimit, rgba[c + 1]!);
        out[index * 4 + 2] = Math.min(colorLimit, rgba[c + 2]!);
        out[index * 4 + 3] = Math.max(0, Math.min(1, rgba[c + 3]!));
        cells[index] = cell;
      }
    }
  }
}

/** a worker slot of `size` quads */
export function makeStretchedSlot(blend: FxSpriteBlend, space: FxSpace, size: number): StretchedSlot {
  return { blend, space, matrices: new Float32Array(size * 16), rgba: new Float32Array(size * 4), cells: new Float32Array(size), count: 0 };
}

/** grows a worker slot to hold `n` quads (×2, up to `capacity`) */
export function growStretchedSlot(slot: StretchedSlot, n: number, capacity: number): void {
  if (slot.cells.length >= n) return;
  const size = Math.min(capacity, Math.max(n, slot.cells.length * 2, 64));
  slot.matrices = new Float32Array(size * 16);
  slot.rgba = new Float32Array(size * 4);
  slot.cells = new Float32Array(size);
}

/** a slot's live prefixes back to back into `out` (STRETCHED_FLOATS × count): [matrices | rgba | cells] */
export function packStretched(slot: StretchedSlot, out: Float32Array): void {
  const n = slot.count;
  out.set(slot.matrices.subarray(0, n * 16), 0);
  out.set(slot.rgba.subarray(0, n * 4), n * 16);
  out.set(slot.cells.subarray(0, n), n * 20);
}
