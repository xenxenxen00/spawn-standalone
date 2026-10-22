// `slowMo` (K8, kernel side; opt-in `ext.slowMo`). api-reference.md ActPayloads:
//   slowMo: { scale: number; duration: number; easing?: boolean | string }
// The docs give the shape and nothing else, so the semantics below are this port's decision:
//   - `scale` multiplies how fast the sim clock runs: 0.25 is a quarter of normal speed. It is clamped to [0.05, 4]; a
//     non-finite or non-positive scale, or a scale of 1, ends the effect.
//   - `duration` is seconds of REAL (host frame) time, so a 1 s slow-mo at scale 0.25 lasts one real second and runs 7.5
//     sim ticks. A duration that is not a positive finite number is ignored. While the clock is paused no frame time reaches
//     the scheduler, so the effect holds with it and resumes where it stopped.
//   - `easing`: absent or false holds `scale` for the whole duration, then snaps back to 1. `true` or a string eases the scale
//     back toward 1 over the duration: `"easeIn"` (the recovery starts slowly) and `"easeOut"` (it starts fast) use a
//     quadratic curve, anything else (`true`, `"linear"`, ...) is linear.
//   - a new slowMo replaces the running one.
// It acts through the scheduler's frame accumulator only (sched/scheduler.ts `advance`): ticks are still 1/30 s of sim time
// (D-CORE-16), they just come less often, so `ctx.now()`, timers, updates, tweens, physics and motion all slow together and the
// interpolation alpha stays smooth. The presentation layer reads `scale` to slow what is not tick-driven (fx and audio clocks).
import { ENGINE } from '../rules.ts';

export const SLOWMO_MIN = 0.05;
export const SLOWMO_MAX = 4;

type Curve = 'hold' | 'linear' | 'in' | 'out';

export class SlowMoClock {
  #from = 1;
  #durationMs = 0;
  #elapsedMs = 0;
  #curve: Curve = 'hold';
  #active = false;

  /** the scale in force now (1 when no effect runs) */
  get scale(): number {
    return this.#active ? this.#valueAt(this.#elapsedMs) : 1;
  }

  get active(): boolean {
    return this.#active;
  }

  /** applies a `slowMo` act payload; a malformed one is ignored, scale 1 ends the effect. Returns whether it changed anything */
  apply(payload: unknown): boolean {
    const p = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
    const scale = p['scale'];
    const duration = p['duration'];
    if (typeof scale !== 'number' || !Number.isFinite(scale) || typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) return false;
    if (scale <= 0 || scale === 1) {
      const was = this.#active;
      this.#active = false;
      return was;
    }
    const e = p['easing'];
    this.#curve = e === undefined || e === false || e === null ? 'hold' : e === 'easeIn' ? 'in' : e === 'easeOut' ? 'out' : 'linear';
    this.#from = Math.min(SLOWMO_MAX, Math.max(SLOWMO_MIN, scale));
    this.#durationMs = duration * 1000;
    this.#elapsedMs = 0;
    this.#active = true;
    return true;
  }

  /** the scale for a frame of `realDtMs`; the effect's clock moves on by that frame */
  step(realDtMs: number): number {
    if (!this.#active) return 1;
    const s = this.#valueAt(this.#elapsedMs);
    if (Number.isFinite(realDtMs) && realDtMs > 0) this.#elapsedMs += Math.min(realDtMs, ENGINE.MAX_FRAME_DT_MS);
    if (this.#elapsedMs >= this.#durationMs) this.#active = false;
    return s;
  }

  /** drops the effect (a test or a place change) */
  clear(): void {
    this.#active = false;
  }

  #valueAt(elapsedMs: number): number {
    if (this.#curve === 'hold') return this.#from;
    const t = Math.min(1, Math.max(0, elapsedMs / this.#durationMs));
    const k = this.#curve === 'in' ? t * t : this.#curve === 'out' ? 1 - (1 - t) * (1 - t) : t;
    return this.#from + (1 - this.#from) * k;
  }
}
