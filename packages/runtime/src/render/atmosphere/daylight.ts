// The daylight model (K14, opt-in: `atmosphere.model: 'daylight'`; the legacy host's night sky and exp2 fog stay the default).
//
// Pure maths, no three objects: a config (`timeOfDay`, `sun`, `sky.top/bottom`, `clouds`) in, the numbers the sky node, the sun
// light, the hemisphere and the ambient fill are driven with out. atmosphere.ts applies them to objects that already exist.
//
//   sun         a point on a half-sine arc: up at 06:00, highest at 12:00 (`sun.orbit.maxElevation`, default 60 degrees), down at
//               18:00, mirrored below the horizon at night. `sun.rotation { pitch, yaw }` pins the direction instead (the colours
//               still follow its elevation). `yaw` is degrees from +Z toward +X; the sun passes +Z at noon (`orbit.noonYaw`).
//   colours     the elevation `sin(el)` picks a point on a four-stop ramp: night, dusk, golden hour, day. Sky zenith and horizon,
//               sun colour and the fill colours are all read off that one ramp, so a dusk differs from a noon in every number.
//   overrides   `sky.top` / `sky.bottom` (zenith / horizon, how a gradient world writes them), `sun.color` / `sun.intensity`
//               (also under `sun.light`, the engine's own shape). An override replaces the derived value; the elevation still
//               scales the sun's intensity, so a night stays dark.
//   fill        hemisphere and ambient intensities fall with the sun and keep a small floor; both are used only when the config
//               authors none.
//   clouds      one noise layer on a plane at `altitude`: density is the coverage, opacity the alpha, speed the drift in m/s.
//
// Colours are linear. The ramp stops are [I]: the engine's numbers are not in the docs.
import { cssToLinear, type Linear3 } from '../color/color.ts';

export type DaylightModel = 'night' | 'daylight';

/** what the config may say; every field is optional and a bad one is ignored */
export interface DaylightConfig {
  sky?: { kind?: string; top?: string; bottom?: string; zenith?: string; horizon?: string };
  sun?: {
    color?: string;
    intensity?: number;
    rotation?: { pitch?: number; yaw?: number };
    orbit?: { noonYaw?: number; maxElevation?: number };
    light?: { color?: string; intensity?: number };
  };
  clouds?: { enabled?: boolean; density?: number; opacity?: number; altitude?: number; thickness?: number; speed?: number; color?: string };
  timeOfDay?: number;
  hemisphere?: unknown;
  ambient?: { light?: { intensity?: number } };
}

/** the peak sun intensity (three units, raw) when the config names none */
export const SUN_PEAK_INTENSITY = 3;
/** the largest derived hemisphere fill (noon, `0.05 + 0.6 * dayAmt`): the cap on the FlashGuard base of a derived fill */
export const DERIVED_HEMISPHERE_MAX = 0.65;
/** the largest derived ambient fill (noon, `0.03 + 0.12 * dayAmt`) */
export const DERIVED_AMBIENT_MAX = 0.15;
/** a running `cycle` may not be faster than this (24 h per period): a tiny `periodMs` would strobe the sun and the fill */
export const MIN_CYCLE_PERIOD_MS = 60_000;
/** the sun disc's emission in the sky (HDR, so the bloom picks it up) */
export const SUN_DISC_EMISSION = 24;
/** the sun disc's angular radius in radians (about 1.1 degrees; the real one is 0.27) */
export const SUN_DISC_RADIUS = 0.019;

export interface CloudParams {
  /** coverage, 0..1 */
  density: number;
  opacity: number;
  /** noise cells per unit of `dir.xz / dir.y` */
  scale: number;
  /** drift in noise cells per second */
  speed: number;
  /** linear, already lit by the sun */
  color: Linear3;
}

export interface DaylightState {
  /** hours, 0..24 */
  hour: number;
  /** unit, world: toward the sun */
  sunDirection: Linear3;
  /** sin(elevation) */
  elevation: number;
  sunColor: Linear3;
  /** the directional light's intensity: 0 below the horizon */
  sunIntensity: number;
  /** 0..1: how much of the sun's glow and disc shows */
  sunVisibility: number;
  zenith: Linear3;
  horizon: Linear3;
  hemisphere: { sky: Linear3; ground: Linear3; intensity: number };
  ambient: { color: Linear3; intensity: number };
  /** null: no cloud layer */
  clouds: CloudParams | null;
}

const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const smooth = (a: number, b: number, x: number): number => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
const mix3 = (a: Readonly<Linear3>, b: Readonly<Linear3>, t: number): Linear3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const scale3 = (a: Readonly<Linear3>, k: number): Linear3 => [a[0] * k, a[1] * k, a[2] * k];

/** a colour string, or null when it is absent or unreadable */
const colorOf = (v: unknown): Linear3 | null => (typeof v === 'string' ? cssToLinear(v) : null);

interface Stop {
  /** sin(elevation) */
  at: number;
  zenith: Linear3;
  horizon: Linear3;
  sun: Linear3;
}

const NIGHT_ZENITH: Linear3 = [0.0012, 0.002, 0.0055];
const NIGHT_HORIZON: Linear3 = [0.006, 0.009, 0.016];

const RAMP: readonly Stop[] = [
  { at: -0.2, zenith: NIGHT_ZENITH, horizon: NIGHT_HORIZON, sun: [1, 0.3, 0.1] },
  { at: 0, zenith: [0.035, 0.05, 0.2], horizon: [0.75, 0.26, 0.15], sun: [1, 0.33, 0.12] },
  { at: 0.17, zenith: [0.05, 0.13, 0.42], horizon: [0.8, 0.52, 0.38], sun: [1, 0.62, 0.34] },
  { at: 0.55, zenith: [0.06, 0.22, 0.7], horizon: [0.5, 0.68, 0.9], sun: [1, 0.93, 0.82] },
];

function ramp(s: number): { zenith: Linear3; horizon: Linear3; sun: Linear3 } {
  const first = RAMP[0]!;
  const last = RAMP[RAMP.length - 1]!;
  if (s <= first.at) return { zenith: first.zenith, horizon: first.horizon, sun: first.sun };
  if (s >= last.at) return { zenith: last.zenith, horizon: last.horizon, sun: last.sun };
  let i = 0;
  while (RAMP[i + 1]!.at < s) i++;
  const a = RAMP[i]!;
  const b = RAMP[i + 1]!;
  const t = (s - a.at) / (b.at - a.at);
  return { zenith: mix3(a.zenith, b.zenith, t), horizon: mix3(a.horizon, b.horizon, t), sun: mix3(a.sun, b.sun, t) };
}

/** the sun's unit direction for an hour of the day */
export function sunDirectionAt(hour: number, noonYawDeg = 0, maxElevationDeg = 60): Linear3 {
  const el = (maxElevationDeg * Math.PI) / 180 * Math.sin(((hour - 6) / 12) * Math.PI);
  const az = (noonYawDeg * Math.PI) / 180 + ((hour - 12) / 12) * Math.PI;
  return [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
}

/**
 * Opt-in renderer overrides (`createRenderer({ atmosphere })`), all absent by default (the config decides, as before):
 *   skyTint        linear rgb multiplier on the derived zenith and horizon (and so on the derived fill); a sky the config
 *                  names (`sky.top/bottom`) is not tinted
 *   skySaturation  1 = unchanged; scales the derived zenith and horizon away from (> 1) or toward (< 1) their luminance
 *   sunAzimuth     degrees from +Z toward +X (as `sun.rotation.yaw`); with `sunElevation` (degrees above the horizon) it
 *                  pins the sun, over the hour and the config. One of the two alone keeps the other from the hour
 */
export interface DaylightOverrides {
  skyTint?: readonly [number, number, number];
  skySaturation?: number;
  sunAzimuth?: number;
  sunElevation?: number;
}

function saturate3(c: Readonly<Linear3>, k: number): Linear3 {
  const y = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return [Math.max(0, y + (c[0] - y) * k), Math.max(0, y + (c[1] - y) * k), Math.max(0, y + (c[2] - y) * k)];
}

/** Evaluates the daylight model for a config and an hour (`hour` replaces the config's `timeOfDay`; default 12). */
export function daylightFor(cfg: DaylightConfig, hour?: number, overrides: DaylightOverrides = {}): DaylightState {
  const h = (((hour ?? num(cfg.timeOfDay, 12)) % 24) + 24) % 24;
  const sun = cfg.sun ?? {};
  const rot = sun.rotation;
  let dir: Linear3;
  if (rot !== undefined && (typeof rot.pitch === 'number' || typeof rot.yaw === 'number')) {
    const pitch = (num(rot.pitch, 45) * Math.PI) / 180;
    const yaw = (num(rot.yaw, 0) * Math.PI) / 180;
    dir = [Math.cos(pitch) * Math.sin(yaw), Math.sin(pitch), Math.cos(pitch) * Math.cos(yaw)];
  } else {
    dir = sunDirectionAt(h, num(sun.orbit?.noonYaw, 0), num(sun.orbit?.maxElevation, 60));
  }
  const oAz = overrides.sunAzimuth, oEl = overrides.sunElevation;
  if ((typeof oAz === 'number' && Number.isFinite(oAz)) || (typeof oEl === 'number' && Number.isFinite(oEl))) {
    const el = typeof oEl === 'number' && Number.isFinite(oEl) ? (oEl * Math.PI) / 180 : Math.asin(Math.max(-1, Math.min(1, dir[1])));
    const az = typeof oAz === 'number' && Number.isFinite(oAz) ? (oAz * Math.PI) / 180 : Math.atan2(dir[0], dir[2]);
    dir = [Math.cos(el) * Math.sin(az), Math.sin(el), Math.cos(el) * Math.cos(az)];
  }
  const s = dir[1];
  const r = ramp(s);

  // top / bottom (a gradient world) and zenith / horizon name the same two colours
  const sky = cfg.sky ?? {};
  const tint = overrides.skyTint;
  const satK = overrides.skySaturation;
  const derived = (c: Linear3): Linear3 => {
    let out = c;
    if (tint !== undefined && tint.every((v) => Number.isFinite(v) && v >= 0)) out = [out[0] * tint[0], out[1] * tint[1], out[2] * tint[2]];
    if (typeof satK === 'number' && Number.isFinite(satK) && satK >= 0 && satK !== 1) out = saturate3(out, satK);
    return out;
  };
  const zenith = colorOf(sky.top) ?? colorOf(sky.zenith) ?? derived(r.zenith);
  const horizon = colorOf(sky.bottom) ?? colorOf(sky.horizon) ?? derived(r.horizon);

  const dayAmt = smooth(-0.2, 0.4, s);
  const peak = Math.max(0, num(sun.intensity, num(sun.light?.intensity, SUN_PEAK_INTENSITY)));
  const sunColor = colorOf(sun.color) ?? colorOf(sun.light?.color) ?? r.sun;
  const sunIntensity = peak * smooth(-0.04, 0.3, s);
  const sunVisibility = smooth(-0.12, 0.02, s);

  const hemiSky = mix3(zenith, horizon, 0.45);
  const ground = scale3(mix3([0.2, 0.17, 0.13], horizon, 0.25), 1);
  const fillK = 0.05 + 0.6 * dayAmt;
  const ambientK = 0.03 + 0.12 * dayAmt;

  const c = cfg.clouds;
  let clouds: CloudParams | null = null;
  if (c !== undefined && c.enabled === true) {
    const altitude = Math.max(50, num(c.altitude, 400));
    const lit = 0.12 + 0.88 * dayAmt;
    clouds = {
      density: clamp01(num(c.density, 0.5)),
      opacity: clamp01(num(c.opacity, 0.9)),
      scale: (altitude / 250) * 1.5,
      speed: num(c.speed, 2) / 250,
      color: scale3(colorOf(c.color) ?? mix3([0.95, 0.96, 0.98], r.sun, 0.35), lit),
    };
  }

  return {
    hour: h,
    sunDirection: dir,
    elevation: s,
    sunColor,
    sunIntensity,
    sunVisibility,
    zenith,
    horizon,
    hemisphere: { sky: hemiSky, ground, intensity: fillK },
    ambient: { color: hemiSky, intensity: ambientK },
    clouds,
  };
}
