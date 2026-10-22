// Look integration (io §4.4; contract §11.3): the engine-owned yaw/pitch the rig host presents when the rig does not write an
// axis, and the behaviour look axes `lookX` / `lookY`.
//
// Conventions (contract §11.3, §12.2): radians; yaw 0 faces -Z and + turns left, so mouse right (+dx) lowers the yaw; pitch +
// is up, so mouse down (+dy) lowers the pitch unless invert Y is on. The engine look is `0.0006 rad/px` (the engine base,
// engine/skills/cameras.md:15) × 3 (the camera def's `sensitivity`, templates/camera.js:8) × the player's `prefs.sens`; at
// sens 1 that is the measured live **100 px = 0.180 rad** (scripts/camera.js:9-11). The behaviour axes carry the base scale ×
// `prefs.sens` only (`lookY` with the invert sign): a script-owned rig applies its own SENS = 3 (scripts/camera.js:395,437,451).
// Pitch is clamped at ±1.4 rad. No ADS or scope scaling (live has none, system-ui.md §3.7a.4).
//
// The rig host calls `integrate(owned)` once per frame with the axes the rig wrote on the previous frame: an owned axis drops
// this frame's engine integration, and the host then `adopt`s the rig's value as the new engine value (io §5.1-5.2).

export const LOOK_BASE = 0.0006;
export const DEF_SENS = 3;
export const PITCH_LIMIT = 1.4;
/** pointer-lock entry spikes (system-ui.md §3.7a.4): a mouse event above this on either axis is dropped */
export const SPIKE_PX = 400;
/** the range the body's pref validator accepts (E-IN-02: `sens` 0.1..4); the SETTINGS slider spans 0.20..3.00 */
export const SENS_MIN = 0.1;
export const SENS_MAX = 4;

export interface LookOptions {
  sensitivity?: number;
  sensitivityRange?: readonly [number, number];
  pitchLimit?: number;
}

export interface LookPrefs {
  sens?: number;
  invertY?: boolean;
}

export interface LookPush {
  /** `mouse` deltas are spike-filtered; `touch` drags are not */
  source?: 'mouse' | 'touch';
  /** rad per px before sensitivity; default LOOK_BASE (the touch look pad uses its own base, io §4.8.3) */
  base?: number;
}

export interface LookView {
  yaw: number;
  pitch: number;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export function sanitizeSens(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? clamp(v, SENS_MIN, SENS_MAX) : 1;
}

export class Look {
  #yaw = 0;
  #pitch = 0;
  #pendingYaw = 0;
  #pendingPitch = 0;
  #sens = 1;
  #invertY = false;
  readonly #options: Required<LookOptions>;

  constructor(prefs: LookPrefs = {}, options: LookOptions = {}) {
    this.#options = { sensitivity: options.sensitivity ?? DEF_SENS, sensitivityRange: options.sensitivityRange ?? [SENS_MIN, SENS_MAX], pitchLimit: options.pitchLimit ?? PITCH_LIMIT };
    const [lo,hi] = this.#options.sensitivityRange;
    if (!Number.isFinite(lo)||!Number.isFinite(hi)||lo<0||hi<lo) throw new TypeError('Look.sensitivityRange must be finite and ordered');
    if (!Number.isFinite(this.#options.sensitivity)||this.#options.sensitivity<0) throw new TypeError('Look.sensitivity must be finite and nonnegative');
    if (!Number.isFinite(this.#options.pitchLimit)||this.#options.pitchLimit<=0) throw new TypeError('Look.pitchLimit must be finite and positive');
    this.#sens = clamp(1, ...this.#options.sensitivityRange);
    this.setPrefs(prefs);
  }

  get sens(): number {
    return this.#sens;
  }

  get invertY(): boolean {
    return this.#invertY;
  }

  /** the settings bridge pushes `prefs.sens` / `prefs.invertY` here (io §3.12) */
  setPrefs(prefs: LookPrefs): void {
    if ('sens' in prefs) this.#sens = clamp(typeof prefs.sens === 'number' && Number.isFinite(prefs.sens) ? prefs.sens : 1, ...this.#options.sensitivityRange);
    if ('invertY' in prefs) this.#invertY = prefs.invertY === true;
  }

  /** true when a mouse delta is a lock-entry spike */
  static isSpike(dx: number, dy: number): boolean {
    return Math.abs(dx) > SPIKE_PX || Math.abs(dy) > SPIKE_PX;
  }

  /** the behaviour axes for a delta: base × sens (lookY × the invert sign) */
  deltasFor(dx: number, dy: number, base: number = LOOK_BASE): { lookX: number; lookY: number } {
    const s = base * this.#sens;
    return { lookX: dx * s, lookY: dy * s * (this.#invertY ? -1 : 1) };
  }

  /**
   * One device delta for the engine integration. Returns false (and changes nothing) for a dropped spike or a non-finite
   * delta; the input log then also leaves it out of the behaviour axes.
   */
  push(dx: number, dy: number, opts: LookPush = {}): boolean {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return false;
    if ((opts.source ?? 'mouse') === 'mouse' && Look.isSpike(dx, dy)) return false;
    const s = (opts.base ?? LOOK_BASE) * this.#options.sensitivity * this.#sens;
    this.#pendingYaw -= dx * s;
    this.#pendingPitch -= dy * s * (this.#invertY ? -1 : 1);
    return true;
  }

  /** applies the pending deltas to every axis the rig did not own, clears them, and returns the engine view */
  integrate(owned: { yaw?: boolean; pitch?: boolean } = {}): LookView {
    if (!owned.yaw && this.#pendingYaw !== 0) this.#yaw += this.#pendingYaw;
    if (!owned.pitch && this.#pendingPitch !== 0) this.#pitch = clamp(this.#pitch + this.#pendingPitch, -this.#options.pitchLimit, this.#options.pitchLimit);
    this.#pendingYaw = 0;
    this.#pendingPitch = 0;
    return this.view();
  }

  /** the rig owned this axis: its value becomes the engine value, exactly (the rig clamps its own pitch) */
  adopt(axis: 'yaw' | 'pitch', value: number): void {
    if (!Number.isFinite(value)) return;
    if (axis === 'yaw') this.#yaw = value;
    else this.#pitch = value;
  }

  /** drops deltas that arrived while the presentation was frozen (pause) */
  discardPending(): void {
    this.#pendingYaw = 0;
    this.#pendingPitch = 0;
  }

  view(): LookView {
    return { yaw: this.#yaw, pitch: this.#pitch };
  }
}
