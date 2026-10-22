// The gib lifecycle (docs/design/rendering.md §11.6; WP R7): the join of `GibRenderer` and the gib rows the render bridge
// drives.
//
// Gib rows (`tags: ['gib', 'gore']`, scripts/gore/gore.js) are spawned by the game with dynamic physics bodies and
// end with the row (`lifetime`, the gore pool's cap). `track` spawns the row's gib in the renderer (batched by texture
// set); the bridge writes the row's interpolated pose, its `scale` included (the game's own 0.9 s shrink, gore.js
// `poolFade`), through `setPose`; `untrack` ends it with the row. A row whose piece is unknown (a primitive plate shard,
// a model no piece was built for) keeps the bridge's normal model path.
//
// Game-agnostic: gib rows are recognised by the injected `isGibRow` predicate (default: the `gib` tag) and mapped to
// piece ids by `pieceIdOf` (default: the row's `model` asset name). The piece geometries are given up front by the
// integrator (the game-api layer owns the gore profiles).
import type { Matrix4 } from 'three/webgpu';
import type { RowSnapshot } from '../../compat/core/ports.ts';
import { GibRenderer, type GibRendererOptions } from './gib-renderer.ts';

export interface GibSystemOptions {
  /** renderer options, including the full `pieces` list and `materialFor` */
  renderer: GibRendererOptions;
  /** identifies gib rows; default: `row.tags` includes `'gib'` */
  isGibRow: (row: RowSnapshot) => boolean;
  /** maps a gib row to its piece id; default: the row's `model` (spec, then props) when it is a non-empty string */
  pieceIdOf?: (row: RowSnapshot) => string | null;
  log?: (message: string) => void;
}

interface TrackedGib {
  rowId: string;
  gibId: number;
  pieceId: string;
}


const defaultPieceIdOf = (row: RowSnapshot): string | null => {
  const model = row.spec['model'] ?? row.props['model'];
  return typeof model === 'string' && model.length > 0 ? model : null;
};

export class GibSystem {
  readonly #renderer: GibRenderer;
  readonly #isGibRow: (row: RowSnapshot) => boolean;
  readonly #pieceIdOf: (row: RowSnapshot) => string | null;
  readonly #log: (message: string) => void;
  readonly #tracked = new Map<string, TrackedGib>();
  readonly #warnedPieces = new Set<string>();
  #disposed = false;

  constructor(opts: GibSystemOptions) {
    this.#isGibRow = opts.isGibRow;
    this.#pieceIdOf = opts.pieceIdOf ?? defaultPieceIdOf;
    this.#log = opts.log ?? ((m) => console.warn(m));
    this.#renderer = new GibRenderer({ ...opts.renderer, log: opts.renderer.log ?? this.#log });
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /** the renderer (draw-budget probes, tests) */
  get renderer(): GibRenderer {
    return this.#renderer;
  }

  /** whether the row is a gib the system should take */
  isGib(row: RowSnapshot): boolean {
    return this.#isGibRow(row);
  }

  /** tracked gib rows */
  get size(): number {
    return this.#tracked.size;
  }

  /**
   * A gib row was added. Spawns its gib with the row's initial world pose. True when the gib is batched (the bridge then
   * draws no model for the row); false for a row that is no gib or whose piece is unknown (logged once per piece).
   */
  track(rowId: string, row: RowSnapshot, worldMatrix: Matrix4): boolean {
    if (this.#disposed || !this.#isGibRow(row)) return false;
    if (this.#tracked.has(rowId)) this.untrack(rowId);
    const pieceId = this.#pieceIdOf(row);
    if (pieceId === null) return false;
    if (!this.#renderer.hasPiece(pieceId)) {
      if (!this.#warnedPieces.has(pieceId)) {
        this.#warnedPieces.add(pieceId);
        this.#log(`GibSystem: no gib piece ${JSON.stringify(pieceId)} (row ${rowId}); such rows keep their model`);
      }
      return false;
    }
    // null: the piece's fallback mesh is full (logged by the renderer)
    const gibId = this.#renderer.spawn(pieceId, worldMatrix);
    if (gibId === null) return false;
    this.#tracked.set(rowId, { rowId, gibId, pieceId });
    return true;
  }

  /** whether the row's gib is drawn by the renderer */
  tracks(rowId: string): boolean {
    return this.#tracked.has(rowId);
  }

  /** the row is gone; removes its gib */
  untrack(rowId: string): void {
    const t = this.#tracked.get(rowId);
    if (t === undefined) return;
    this.#tracked.delete(rowId);
    this.#renderer.remove(t.gibId);
  }

  /** the row's interpolated world pose, its scale included; false when the gib was evicted at the cap or is unknown */
  setPose(rowId: string, worldMatrix: Matrix4): boolean {
    const t = this.#tracked.get(rowId);
    if (t === undefined) return false;
    return this.#renderer.setPose(t.gibId, worldMatrix);
  }

  /** Per frame, after the bridge wrote the poses: renderer-side fades (pieces spawned with `ttlMs`) and the budget. */
  update(now?: number): void {
    if (this.#disposed) return;
    this.#renderer.tick(now);
    this.#renderer.syncBudget();
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#tracked.clear();
    this.#renderer.dispose();
  }
}
