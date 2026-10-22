// CA2 camera juice: presentation-only screen shake + camera punch.
//
// Feeds `rig-host`'s optional `juice.offsets(dtS)` (once per frame) and the
// `screenShake` / `cameraPunch` acts via `register(acts)`. Juice never feeds
// back into rig look/aim; it only offsets the presented camera.
//
// Behavior: docs/design/audio-ui-input.md §5.5. All tuning numbers live in
// `src/runtime/camera/juice.yml` (carried by the composition root and injected
// as `tune`); this module holds no tuned constants.
//
// `hitstop` is NOT handled here: `src/app/act-wiring.ts` routes it to the
// PresentationClock and only calls `deps.juice.register(acts)`.
import type { JuiceOffsets } from './camera-presenter.ts';

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Tuning numbers; the shipped values live in juice.yml, not here. */
export interface JuiceTune {
  /** two noise octaves, Hz, for screenShake */
  shakeNoiseHz: [number, number];
  /** max shake rotation, degrees */
  shakeRotDeg: number;
  /** max shake position offset, metres */
  shakePosM: number;
  /** default shake duration, seconds */
  shakeDurationS: number;
  /** exponential envelope decay, 1/s */
  shakeDecay: number;
  /** punch kick: degrees of angular velocity per intensity */
  punchKickDeg: number;
  /** punch spring rate, rad/s (zeta = 1, critically damped) */
  punchOmega: number;
  /** punch spring damping ratio */
  punchZeta: number;
  /** punch eye push, metres per intensity */
  punchEyeM: number;
}

export interface ScreenShakePayload {
  intensity: number;
  duration?: number;
}

export interface CameraPunchPayload {
  /** camera frame: x right, y up, -z forward */
  direction: Vec3Like;
  intensity: number;
}

/**
 * The subscription slice of the app's ActRouter (src/app/act-wiring.ts) that
 * CA2 needs. Structural: if the real router's subscribe verb differs from
 * `on`, adapt at integration — the two handlers below are also exposed as
 * `emitScreenShake` / `emitCameraPunch` for direct wiring.
 */
export interface JuiceActRouter {
  on(act: 'screenShake', handler: (p: ScreenShakePayload) => void): void;
  on(act: 'cameraPunch', handler: (p: CameraPunchPayload) => void): void;
}

export interface JuiceOptions {
  tune: JuiceTune;
  /**
   * Accessibility scale, 0..1, multiplied into EVERY emit (so raw game shakes
   * honor accessibility too). The settings layer owns the fold:
   * `effShake = reducedMotion ? 0 : prefs.shake`.
   */
  effShake?: number;
}

export interface Juice {
  /** Wire the screenShake / cameraPunch acts; hitstop stays in act-wiring. */
  register(acts: JuiceActRouter): void;
  emitScreenShake(intensity: number, durationS?: number): void;
  emitCameraPunch(direction: Vec3Like, intensity: number): void;
  setEffShake(v: number): void;
  /** Drop active shakes and zero the punch (e.g. on place transitions). */
  clear(): void;
  /** Advance by dtS and return this frame's offsets. Call once per frame. */
  offsets(dtS: number): JuiceOffsets;
}

const DEG = Math.PI / 180;
/** below this a settled spring channel snaps exactly to zero */
const SNAP = 1e-9;

const clamp01 = (v: number): number => {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
};

const finiteOr = (v: number, fallback: number): number =>
  Number.isFinite(v) ? v : fallback;

/** deterministic 32-bit integer hash -> [0, 1) */
function hash01(seed: number, n: number): number {
  let h = (Math.imul(seed | 0, 0x9e3779b1) + Math.imul(n | 0, 0x85ebca6b)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  h ^= h >>> 15;
  return (h >>> 0) / 0xffffffff;
}

/** one octave of smooth (smoothstep-interpolated value) noise in [-1, 1] */
function noiseOctave(seed: number, freqHz: number, t: number): number {
  const x = t * freqHz;
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  const a = hash01(seed, i);
  const b = hash01(seed, i + 1);
  return (a + (b - a) * u) * 2 - 1;
}

/** two-octave smooth noise in [-1, 1]; deterministic in (seed, t) */
function shakeNoise(seed: number, f1: number, f2: number, t: number): number {
  return 0.5 * noiseOctave(seed, f1, t) + 0.5 * noiseOctave(seed ^ 0x9e3779b9, f2, t);
}

interface Shake {
  t: number;
  duration: number;
  /** intensity clamped to [0,1], already multiplied by effShake at emit */
  amp: number;
  seed: number;
}

/** one critically-damped spring channel (zeta = 1), stepped analytically */
interface Spring {
  x: number;
  v: number;
}

const stepSpring = (s: Spring, omega: number, dt: number): void => {
  const d = Math.exp(-omega * dt);
  const c = s.v + omega * s.x;
  const x = d * (s.x + c * dt);
  const v = d * (s.v - omega * c * dt);
  s.x = Math.abs(x) < SNAP && Math.abs(v) < SNAP ? 0 : x;
  s.v = s.x === 0 ? 0 : v;
};

export function createJuice(opts: JuiceOptions): Juice {
  const tune = opts.tune;
  let effShake = opts.effShake === undefined ? 1 : clamp01(opts.effShake);
  const shakes: Shake[] = [];
  let seedCounter = 0;
  const punchPitch: Spring = { x: 0, v: 0 };
  const punchYaw: Spring = { x: 0, v: 0 };
  const punchEye: Spring = { x: 0, v: 0 };

  const emitScreenShake = (intensity: number, durationS?: number): void => {
    const amp = clamp01(intensity) * effShake;
    if (amp <= 0) return;
    const duration =
      durationS !== undefined && Number.isFinite(durationS) && durationS > 0
        ? durationS
        : tune.shakeDurationS;
    seedCounter += 1;
    shakes.push({ t: 0, duration, amp, seed: seedCounter });
  };

  const emitCameraPunch = (direction: Vec3Like, intensity: number): void => {
    const k = clamp01(intensity) * effShake;
    if (k <= 0) return;
    const dx = finiteOr(direction.x, 0);
    const dy = finiteOr(direction.y, 0);
    const dz = finiteOr(direction.z, 0);
    const kick = tune.punchKickDeg * DEG * k;
    // critically damped spring, zeta = 1: kick pitch/yaw velocity, push the eye
    punchPitch.v += kick * -dy;
    punchYaw.v += kick * dx;
    punchEye.x += tune.punchEyeM * k * dz;
  };

  const offsets = (dtS: number): JuiceOffsets => {
    const dt = dtS > 0 && Number.isFinite(dtS) ? dtS : 0;
    const [f1, f2] = tune.shakeNoiseHz;
    const rotMax = tune.shakeRotDeg * DEG;
    const posMax = tune.shakePosM;

    // screen shake: concurrent shakes add; total intensity clamped to 1
    let yaw = 0;
    let pitch = 0;
    let roll = 0;
    let px = 0;
    let py = 0;
    let pz = 0;
    let total = 0;
    for (let i = shakes.length - 1; i >= 0; i--) {
      const s = shakes[i];
      // noUncheckedIndexedAccess: the index signature includes undefined; the
      // guard never fires for this dense reverse-iteration (splice only drops
      // the already-visited index i), it just satisfies the type.
      if (s === undefined) continue;
      s.t += dt;
      if (s.t >= s.duration) {
        shakes.splice(i, 1);
        continue;
      }
      // envelope: exp(-decay * t) with a linear fade to zero at duration
      const env = Math.exp(-tune.shakeDecay * s.t) * (1 - s.t / s.duration);
      const e = s.amp * env;
      total += e;
      const base = s.seed * 6;
      yaw += rotMax * e * shakeNoise(base, f1, f2, s.t);
      pitch += rotMax * e * shakeNoise(base + 1, f1, f2, s.t);
      roll += rotMax * e * shakeNoise(base + 2, f1, f2, s.t);
      px += posMax * e * shakeNoise(base + 3, f1, f2, s.t);
      py += posMax * e * shakeNoise(base + 4, f1, f2, s.t);
      pz += posMax * e * shakeNoise(base + 5, f1, f2, s.t);
    }
    if (total > 1) {
      const c = 1 / total;
      yaw *= c;
      pitch *= c;
      roll *= c;
      px *= c;
      py *= c;
      pz *= c;
    }

    // camera punch: critically damped springs (zeta = 1)
    const omega = tune.punchOmega;
    stepSpring(punchPitch, omega, dt);
    stepSpring(punchYaw, omega, dt);
    stepSpring(punchEye, omega, dt);

    return {
      pos: { x: px, y: py, z: pz + punchEye.x },
      yaw: yaw + punchYaw.x,
      pitch: pitch + punchPitch.x,
      roll,
    };
  };

  return {
    register(acts: JuiceActRouter): void {
      acts.on('screenShake', (p: ScreenShakePayload) => {
        emitScreenShake(p.intensity, p.duration);
      });
      acts.on('cameraPunch', (p: CameraPunchPayload) => {
        emitCameraPunch(p.direction, p.intensity);
      });
    },
    emitScreenShake,
    emitCameraPunch,
    setEffShake(v: number): void {
      effShake = clamp01(v);
    },
    clear(): void {
      shakes.length = 0;
      punchPitch.x = punchPitch.v = 0;
      punchYaw.x = punchYaw.v = 0;
      punchEye.x = punchEye.v = 0;
    },
    offsets,
  };
}
