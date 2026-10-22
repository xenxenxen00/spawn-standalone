// The per-place spatial index (docs/design/core-runtime.md §5.1, §6): a uniform grid of 16 m cells over feet xz for radius
// queries. RowStoreImpl keeps one per place and buckets each row by its world feet along the plain parent chain (a bone- or
// camera-attached row by its parent's frame, core §5.1); camera-attached rows are in no grid. `near` returns a superset (every
// row of every cell the disc touches) in spawn serial order; the query applies the exact 3D distance test (core §6).
import { ENGINE } from '../rules.ts';
import type { RowRec, SpatialGrid, Vec3 } from '../types.ts';

/** cell coordinates are packed into one number: ±32,768 cells (±524 km at 16 m) */
const OFFSET = 32768;
const SPAN = 65536;
const clampCell = (c: number): number => Math.min(OFFSET - 1, Math.max(-OFFSET, c));
const pack = (cx: number, cz: number): number => (cx + OFFSET) * SPAN + (cz + OFFSET);
const bySerial = (a: RowRec, b: RowRec): number => a.serial - b.serial;

export class SpatialGridImpl implements SpatialGrid {
  readonly cellSize: number;
  readonly #cells = new Map<number, Set<RowRec>>();
  readonly #cellOf = new Map<RowRec, number>();

  constructor(cellSize: number = ENGINE.SPATIAL_CELL_M) {
    if (!(cellSize > 0) || !Number.isFinite(cellSize)) throw new RangeError(`SpatialGrid: cell size must be a positive number, got ${cellSize}`);
    this.cellSize = cellSize;
  }

  /** rows in the grid */
  get size(): number {
    return this.#cellOf.size;
  }

  has(row: RowRec): boolean {
    return this.#cellOf.has(row);
  }

  /** puts the row in the cell of (x, z), moving it out of its previous cell; a non-finite position takes it out of the grid */
  set(row: RowRec, x: number, z: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(z)) {
      this.remove(row);
      return;
    }
    const key = pack(clampCell(Math.floor(x / this.cellSize)), clampCell(Math.floor(z / this.cellSize)));
    const old = this.#cellOf.get(row);
    if (old === key) return;
    if (old !== undefined) this.#leave(old, row);
    let cell = this.#cells.get(key);
    if (!cell) {
      cell = new Set();
      this.#cells.set(key, cell);
    }
    cell.add(row);
    this.#cellOf.set(row, key);
  }

  remove(row: RowRec): void {
    const old = this.#cellOf.get(row);
    if (old === undefined) return;
    this.#leave(old, row);
    this.#cellOf.delete(row);
  }

  /** every row of every cell that the xz disc (center, radius) touches, in spawn serial order; [] for a negative or NaN input */
  near(center: Vec3, radius: number): RowRec[] {
    if (!(radius >= 0) || !Number.isFinite(center.x) || !Number.isFinite(center.z)) return [];
    const out: RowRec[] = [];
    if (radius === Number.POSITIVE_INFINITY) {
      for (const cell of this.#cells.values()) for (const r of cell) out.push(r);
      return out.sort(bySerial);
    }
    const cs = this.cellSize;
    const x0 = clampCell(Math.floor((center.x - radius) / cs));
    const x1 = clampCell(Math.floor((center.x + radius) / cs));
    const z0 = clampCell(Math.floor((center.z - radius) / cs));
    const z1 = clampCell(Math.floor((center.z + radius) / cs));
    const r2 = radius * radius;
    const touches = (cx: number, cz: number): boolean => {
      const dx = Math.max(cx * cs - center.x, 0, center.x - (cx + 1) * cs);
      const dz = Math.max(cz * cs - center.z, 0, center.z - (cz + 1) * cs);
      return dx * dx + dz * dz <= r2;
    };
    if ((x1 - x0 + 1) * (z1 - z0 + 1) <= this.#cells.size) {
      for (let cx = x0; cx <= x1; cx++) {
        for (let cz = z0; cz <= z1; cz++) {
          const cell = this.#cells.get(pack(cx, cz));
          if (cell && touches(cx, cz)) for (const r of cell) out.push(r);
        }
      }
    } else {
      // a wide disc over a sparse grid: walk the occupied cells instead of the square
      for (const [key, cell] of this.#cells) {
        const cx = Math.floor(key / SPAN) - OFFSET;
        const cz = (key % SPAN) - OFFSET;
        if (cx >= x0 && cx <= x1 && cz >= z0 && cz <= z1 && touches(cx, cz)) for (const r of cell) out.push(r);
      }
    }
    return out.sort(bySerial);
  }

  #leave(key: number, row: RowRec): void {
    const cell = this.#cells.get(key);
    if (!cell) return;
    cell.delete(row);
    if (cell.size === 0) this.#cells.delete(key);
  }
}
