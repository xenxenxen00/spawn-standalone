// The `screenFlash` act (K8; engine api-reference.md:668): `screenFlash { color?, duration = 0.15, intensity = 0.35 }`. A colour
// laid over the whole picture that fades from `intensity` (an opacity) to nothing over `duration`. This is the state machine
// only (it draws nothing): the UI chrome that owns the act reads `rgba()` every frame and paints it, or `onChange` pushes it.
// Presentation time: a paused frame does not advance it. A second flash replaces the first. The colour defaults to white [I].
import { highlightColorOf } from './highlight.ts';

export const SCREEN_FLASH_DEFAULTS = Object.freeze({ duration: 0.15, intensity: 0.35, color: [1, 1, 1] as readonly number[] });

export interface ScreenFlashAct {
  /** linear rgb */
  color: readonly [number, number, number];
  duration: number;
  intensity: number;
}

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** a payload with no colour (or an unreadable one) flashes white; `intensity` is clamped to 0..1 */
export function screenFlashOf(payload: unknown): ScreenFlashAct {
  const p = typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
  const c = highlightColorOf(p['color']);
  return {
    color: c === null ? [1, 1, 1] : [c.r, c.g, c.b],
    duration: fin(p['duration']) && p['duration'] > 0 ? p['duration'] : SCREEN_FLASH_DEFAULTS.duration,
    intensity: fin(p['intensity']) ? Math.min(1, Math.max(0, p['intensity'])) : SCREEN_FLASH_DEFAULTS.intensity,
  };
}

/** the overlay opacity `t` seconds in: `intensity` at the start, 0 from the end on (linear) */
export function screenFlashAlpha(act: ScreenFlashAct, t: number): number {
  const u = t / act.duration;
  return u >= 1 ? 0 : act.intensity * (1 - Math.max(0, u));
}

export class ScreenFlash {
  #act: ScreenFlashAct | null = null;
  #t = 0;
  readonly #out: [number, number, number, number] = [0, 0, 0, 0];
  readonly #onChange: ((rgba: Readonly<[number, number, number, number]> | null) => void) | undefined;

  /** `onChange` gets the linear colour with its opacity each frame of a flash, and null when it ends */
  constructor(onChange?: (rgba: Readonly<[number, number, number, number]> | null) => void) {
    this.#onChange = onChange;
  }

  flash(payload: unknown): void {
    this.#act = screenFlashOf(payload);
    this.#t = 0;
    this.#push();
  }

  update(dtS: number): void {
    if (this.#act === null) return;
    this.#t += Math.max(0, dtS);
    if (this.#t >= this.#act.duration) {
      this.#act = null;
      this.#onChange?.(null);
      return;
    }
    this.#push();
  }

  /** the current overlay (linear rgb, opacity); null when none runs. The array is reused. */
  rgba(): Readonly<[number, number, number, number]> | null {
    const a = this.#act;
    if (a === null) return null;
    this.#out[0] = a.color[0];
    this.#out[1] = a.color[1];
    this.#out[2] = a.color[2];
    this.#out[3] = screenFlashAlpha(a, this.#t);
    return this.#out;
  }

  get active(): boolean {
    return this.#act !== null;
  }

  #push(): void {
    const v = this.rgba();
    if (v !== null) this.#onChange?.(v);
  }
}
