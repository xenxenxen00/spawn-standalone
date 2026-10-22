import { calibration } from '../calibration.ts';
import { createRenderBudget, type TierId } from '../perf/budget.ts';

export type DecalMode = 'live' | 'uncapped';
export interface DecalWindowOptions {
  mode: DecalMode;
  /** A function lets the ring apply a render-governor tier change on its next operation. */
  tier: TierId | (() => TierId);
  now: () => number;
}
export interface DecalWindowEntry<T> { id: number; value: T; born: number; expires: number }

/** Count-based decal ring: tiled marks keep one handle and expire or evict as a unit. */
export class DecalWindow<T> {
  readonly #budget: ReturnType<typeof createRenderBudget>;
  readonly #now: () => number;
  readonly #mode: DecalMode;
  readonly #entries: DecalWindowEntry<T>[] = [];
  #nextId = 0;
  constructor(options: DecalWindowOptions) {
    this.#mode = options.mode;
    this.#now = options.now;
    this.#budget = createRenderBudget(options.tier);
  }
  /** Current count ceiling; profile/window and the active tier ceiling are applied together. */
  get capacity(): number { return this.#budget.cap('decals', this.#mode === 'live' ? calibration.decalWindow.max : Infinity); }
  get live(): number { this.#sweep(); return this.#entries.length; }
  get entries(): readonly DecalWindowEntry<T>[] { this.#sweep(); return this.#entries; }
  add(value: T, lifetimeS = calibration.decalWindow.lifeS): number {
    this.#sweep();
    const now = this.#now();
    const asked = Number.isFinite(lifetimeS) ? Math.max(0, lifetimeS) : 600;
    const lifetime = this.#mode === 'live' ? Math.min(600, calibration.decalWindow.lifeS, asked) : asked;
    const id = this.#nextId++;
    const capacity = this.capacity;
    if (capacity === 0) return id;
    while (this.#entries.length >= capacity) this.#entries.shift();
    this.#entries.push({ id, value, born: now, expires: now + lifetime });
    return id;
  }
  get(id: number): T | undefined { this.#sweep(); return this.#entries.find((entry) => entry.id === id)?.value; }
  has(id: number): boolean { this.#sweep(); return this.#entries.some((entry) => entry.id === id); }
  expiry(id: number): number | undefined { this.#sweep(); return this.#entries.find((entry) => entry.id === id)?.expires; }
  clearAll(): void { this.#entries.length = 0; }
  #sweep(): void {
    const now = this.#now();
    for (let i = this.#entries.length - 1; i >= 0; i--) if (this.#entries[i]!.expires <= now) this.#entries.splice(i, 1);
    const capacity = this.capacity;
    while (this.#entries.length > capacity) this.#entries.shift();
  }
}

export const createDecalWindow = (options: DecalWindowOptions): DecalWindow<number> => new DecalWindow(options);
