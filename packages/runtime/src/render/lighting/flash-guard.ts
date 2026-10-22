// FlashGuard (docs/design/rendering.md §8.5; docs/analysis/system-ui.md §3.7a.7; docs/architecture.md X-23; WP R1b): the
// reduce-flashing limiter every light intensity the renderer applies passes through while `prefs.reducedFlash` is on.
//
// One channel per lamp, per ambient and hemisphere fill, per fx `light()` slot and one for the UI's `screenFlash` overlay
// alpha (key `'screenFlash'`, base 0.25). The game's writers (`scripts/map/power.js`, `flicker.js`, `lights.js`) stay
// unedited: the guard runs once per rendered frame on what they last wrote, before the light texture upload.
//
// The guard of system-ui.md §3.7a.7, as written there:
//   - the target is clamped to the authored base (the live lamp death writes up to 1.2 ×);
//   - a change under 10 % of the base passes straight through;
//   - a larger one moves at most `base` per 0.25 s;
//   - and it may only turn round 334 ms after the last turn: until then the output holds. Three reversals a second at most
//     is one and a half flashes a second, half the general limit of three (WCAG 2.3.1).
//
// What the specification leaves open, decided here and covered by tests:
//   - a channel shows the first value it is given at once (clamped), with no fade from a value it never showed: a lamp that
//     is dark when its place loads is dark, an fx slot that pops for the first time pops;
//   - while the guard is off `apply` returns its argument untouched (the same bits, no clamp) and remembers it, so a guard
//     switched on mid-session continues from what was on screen, free to move either way;
//   - asking for a known key again returns the same channel and adopts the new base;
//   - a base of 0 (a light authored dark) is allowed and pins the output to 0 while the guard is on.
//
// Engine-free: no import (X-26: boot code and the UI chrome may hold a guard before the engine chunk loads).

/** a channel may turn round this long after its last reversal: ≤ 3 reversals per second */
export const MIN_REVERSAL_MS = 334;
/** full-range cross-fade: the output moves at most `base` per 0.25 s */
export const FADE_S = 0.25;
/** changes under 10 % of `base` pass straight through */
export const DEADBAND = 0.1;

export interface FlashChannel {
  /**
   * The value to show for `target` at `nowMs`, `dt` seconds after the previous frame. The identity while the guard is
   * disabled.
   */
  apply(target: number, nowMs: number, dt: number): number;
}

/** render §8.5; `Renderer.flashGuard` (docs/architecture.md §3.0) */
export interface FlashGuard {
  /** `prefs.reducedFlash` */
  setEnabled(on: boolean): void;
  /** one per lamp, ambient, hemisphere, fx-light slot, overlay; `base` is the authored value */
  channel(key: string, base: number): FlashChannel;
}

export interface FlashGuardControl extends FlashGuard {
  readonly enabled: boolean;
  /** channels held */
  readonly size: number;
  /** forgets one channel (its light is gone); the key starts afresh when asked for again */
  release(key: string): void;
  /** forgets every channel (a place change) */
  reset(): void;
}

class Channel implements FlashChannel {
  base: number;
  /** the value last returned */
  out = 0;
  /** direction of the move in progress: −1, 0 (none yet), 1 */
  dir = 0;
  /** when `dir` last changed, ms */
  revAt = Number.NEGATIVE_INFINITY;
  /** false until the first value was shown */
  primed = false;
  readonly #guard: { enabled: boolean };

  constructor(guard: { enabled: boolean }, base: number) {
    this.#guard = guard;
    this.base = base;
  }

  apply(target: number, nowMs: number, dt: number): number {
    if (!this.#guard.enabled) {
      // the identity; what was shown is remembered, and the next guarded move is free to go either way
      this.out = target;
      this.dir = 0;
      this.revAt = Number.NEGATIVE_INFINITY;
      this.primed = true;
      return target;
    }
    const base = this.base;
    target = Math.min(target, base); // no overshoot above the authored value
    if (!this.primed) {
      this.primed = true;
      return (this.out = target);
    }
    const d = target - this.out;
    if (Math.abs(d) < DEADBAND * base) return (this.out = target);
    const dir = Math.sign(d);
    if (dir !== this.dir && nowMs - this.revAt < MIN_REVERSAL_MS) return this.out; // hold: too soon to turn round
    if (dir !== this.dir) {
      this.dir = dir;
      this.revAt = nowMs;
    }
    const step = (base / FADE_S) * dt;
    return (this.out += Math.max(-step, Math.min(step, d)));
  }
}

function checkBase(key: string, base: number): void {
  if (typeof base !== 'number' || !Number.isFinite(base) || base < 0) {
    throw new RangeError(`FlashGuard.channel(${JSON.stringify(key)}): the base must be a finite number ≥ 0, got ${String(base)}`);
  }
}

export function createFlashGuard(): FlashGuardControl {
  const state = { enabled: false };
  const channels = new Map<string, Channel>();
  return {
    get enabled(): boolean {
      return state.enabled;
    },
    get size(): number {
      return channels.size;
    },
    setEnabled(on: boolean): void {
      state.enabled = on === true;
    },
    channel(key: string, base: number): FlashChannel {
      if (typeof key !== 'string' || key === '') throw new RangeError('FlashGuard.channel: the key must be a non-empty string');
      checkBase(key, base);
      let c = channels.get(key);
      if (c === undefined) {
        c = new Channel(state, base);
        channels.set(key, c);
      } else {
        c.base = base;
      }
      return c;
    },
    release(key: string): void {
      channels.delete(key);
    },
    reset(): void {
      channels.clear();
    },
  };
}
