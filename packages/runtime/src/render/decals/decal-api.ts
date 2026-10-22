import { clipDecal, type ClippedDecal, type DecalSpec } from './clipper.ts';
import type { ColliderIndex } from './collider-index.ts';
import { DecalWindow, type DecalMode, type DecalWindowEntry } from './window.ts';
import type { TierId } from '../perf/budget.ts';

export interface DecalRecord { spec: DecalSpec; clipped: ClippedDecal }
export interface DecalApiOptions { mode: DecalMode; tier: TierId | (() => TierId); now: () => number; warn?: (message: string) => void }

/** Isolated decal API; the host supplies its map index, clock, and current render tier. */
export class DecalApi {
  readonly #index: ColliderIndex;
  readonly #window: DecalWindow<DecalRecord>;
  readonly #warn: (message: string) => void;
  constructor(index: ColliderIndex, options: DecalApiOptions) {
    this.#index = index;
    this.#window = new DecalWindow(options);
    this.#warn = options.warn ?? ((message) => console.warn(message));
  }
  get live(): number { return this.#window.live; }
  get entries(): readonly DecalWindowEntry<DecalRecord>[] { return this.#window.entries; }
  add(spec: DecalSpec): number | null {
    if (spec.attachTo) this.#warn(`decal attachTo is not supported: ${spec.attachTo}`);
    const clipped = clipDecal(this.#index, spec);
    if (!clipped) return null;
    return this.#window.add({ spec, clipped }, spec.lifetime);
  }
  clearAll(): void { this.#window.clearAll(); }
}
