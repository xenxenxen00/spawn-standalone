// The sky (docs/design/rendering.md §9.2; WP R4): `scene.backgroundNode`. three draws a node background first, as a
// full-screen mesh with depth test and depth write off and `fog = false` (`three/src/renderers/common/Background.js`), so the
// sky is never fogged and never occludes.
//
//   gradient   20 of the 21 places: `mix(horizon, zenith, pow(max(dir.y, 0), skyK))`, the horizon colour below the horizon.
//              `skyK` is [CAL `skyK`] (0.5), read when a place is applied.
//   night      the night scene (`sky.kind: realistic`, model hosek, `stars`, `moon 2.5`, `ground: false`): the same gradient
//              over the near-black `NIGHT_SKY` colours, plus a hash-placed star field of about 2,000 points (no twinkle: no
//              `time` in the graph, so the pausable shader time is irrelevant) and a moon disc emitting the config's
//              intensity, which is HDR (2.5) in the half-float scene pass, so the bloom picks it up. three's `SkyMesh` (daylight
//              Preetham) is not used.
//
// Everything a place switch changes is a uniform: horizon, zenith, the exponent, the moon's intensity, the stars' switch.
// Only gradient ↔ night swaps the `backgroundNode`, once, during the place build behind the hold; both node objects exist
// from creation (`nodes`), so the warm-up can compile both forms.
//
// The star field: the direction's cube face is cut into `STAR_GRID`² cells; a cell holds a star when the PCG hash of its id is
// under a threshold that follows the cell's solid angle (an even spread over the sphere), at a hashed place inside the cell
// (kept off the cell's border, so a star never crosses it), with a hashed brightness and tint. A star is a disc of `STAR_RADIUS` radians, widened to 1.5 pixels on a coarse target so it
// never falls between two samples. The hash is three's own `hash()` (integer PCG): `starField()` and `starAt()` mirror it on
// the CPU bit for bit, which is what the unit test counts and the browser spec compares pixels with.
//
// What is not in the tree and was chosen here [I]: the night colours, the moon's direction and size, the stars' size and
// brightness law. The live station also draws a moon, a sun and a planet as map geometry
// (`scripts/gen/the night scene/space.js`); the sky's moon stands high in another part of the sky.
//
// `scene.environment` is never set. The sky feeds `envTerm()` (surface/env-term.ts) through a `SkySampler` over the same
// uniforms (the gradient only, no stars) when [CAL `envScale`] is non-zero.
import { dFdx, dFdy, float, hash, mix, mx_fractal_noise_float, normalWorldGeometry, renderGroup, smoothstep, uint, uniform, vec3, vec4 } from 'three/tsl';
import { Vector2, Vector3 } from 'three/webgpu';
import type { Node, UniformNode } from 'three/webgpu';
import { calibration } from '../calibration.ts';
import type { Linear3 } from '../color/color.ts';
import { installSkySampler, skySampler, type SkySampler } from '../surface/env-term.ts';
import { SUN_DISC_EMISSION, SUN_DISC_RADIUS, type DaylightState } from './daylight.ts';

/** render §9.1 `AtmosphereState.sky` */
export type SkyState =
  | { kind: 'gradient'; horizon: Linear3; zenith: Linear3 }
  | { kind: 'night'; stars: boolean; moon: number; horizon: Linear3; zenith: Linear3 }
  /** K14, opt-in (`atmosphere.model: 'daylight'`): the gradient, the sun's glow and disc, optional clouds; see daylight.ts */
  | { kind: 'daylight'; horizon: Linear3; zenith: Linear3; day: DaylightState };

/**
 * The night sky's gradient, linear [I]: near black with a little blue. the night scene's fog has no colour in its config and
 * defaults to this horizon ([CAL `defaultFogColor`] = `'night-sky-horizon'`).
 */
export interface NightSkyOptions {
  horizon?: Readonly<Linear3>;
  zenith?: Readonly<Linear3>;
  /** Desired star count across the sphere (0..STAR_CELLS). */
  starCount?: number;
}

export const NIGHT_SKY: { readonly horizon: Readonly<Linear3>; readonly zenith: Readonly<Linear3> } = Object.freeze({
  horizon: Object.freeze([0, 0, 0] as Linear3),
  zenith: Object.freeze([0, 0, 0] as Linear3),
});

/** cells along one edge of a cube face */
export const STAR_GRID = 64;
/** cells of the star field: 6 faces × `STAR_GRID`² */
export const STAR_CELLS = 6 * STAR_GRID * STAR_GRID;
/** the share of cells that hold a star: 2,000 of 24,576 */
export const STAR_DENSITY = 1024 / STAR_CELLS;
/**
 * A cell holds a star when `hash · (1 + u² + v²)^1.5 < STAR_THRESHOLD`, (u, v) its centre on the face: the chance follows the
 * cell's solid angle, so the stars are spread evenly over the sphere and not bunched at the cube's corners. π / 6 is the mean
 * of `(1 + u² + v²)^−1.5` over a face (its solid angle 4π / 6 over its area 4), which keeps the count at `STAR_DENSITY`.
 */
const STAR_THRESHOLD = STAR_DENSITY / (Math.PI / 6);
/** a star's angular radius in radians (about a pixel and a half at 1080p) */
export const STAR_RADIUS = 0.0016;
/** a star is never drawn with a radius under this many pixels of the target */
export const STAR_PIXEL_FLOOR = 1.5;
/** a star keeps this fraction of a cell away from the cell's border */
const STAR_MARGIN = 0.2;
/** brightness = `STAR_MIN + (1 − STAR_MIN) · h⁴`: most stars are faint */
const STAR_MIN = 0.06;
const STAR_COOL: Readonly<Linear3> = [0.72, 0.84, 1];
const STAR_WARM: Readonly<Linear3> = [1, 0.9, 0.74];

/** unit, world space: 58° above the horizon [I] */
export const MOON_DIRECTION: Readonly<Linear3> = (() => {
  const v: Linear3 = [0.36, 0.85, 0.384];
  const l = Math.hypot(v[0], v[1], v[2]);
  return Object.freeze([v[0] / l, v[1] / l, v[2] / l] as Linear3);
})();
/** the moon disc's angular radius in radians (1.2°) */
export const MOON_RADIUS = 0.021;
/** the disc's edge fades out over this fraction of the radius */
const MOON_EDGE = 1.08;
/** linear, × the config's `moon.intensity` */
export const MOON_COLOR: Readonly<Linear3> = Object.freeze([0.93, 0.96, 1] as Linear3);

// ── the CPU mirror ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** `mix(horizon, zenith, pow(max(y, 0), k))` for a unit direction's `y` */
export function skyGradientAt(horizon: Readonly<Linear3>, zenith: Readonly<Linear3>, y: number, k: number): Linear3 {
  const t = Math.max(y, 0) ** k;
  return [horizon[0] + (zenith[0] - horizon[0]) * t, horizon[1] + (zenith[1] - horizon[1]) * t, horizon[2] + (zenith[2] - horizon[2]) * t];
}

/** the gradient's mean over the sphere: what a fully rough surface reflects (`SkySampler.mean`) */
export function skyMean(horizon: Readonly<Linear3>, zenith: Readonly<Linear3>, k: number): Linear3 {
  // the lower half is the horizon colour; over the upper half ∫₀¹ y^k dy = 1 / (k + 1)
  const t = 0.5 / (k + 1);
  return [horizon[0] + (zenith[0] - horizon[0]) * t, horizon[1] + (zenith[1] - horizon[1]) * t, horizon[2] + (zenith[2] - horizon[2]) * t];
}

/** three's `hash()` (`three/src/nodes/math/Hash.js`, PCG) for a uint32 seed, as the float32 the shader gets */
export function pcgHash(seed: number): number {
  const state = (Math.imul(seed >>> 0, 747796405) + 2891336453) >>> 0;
  const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0;
  const result = ((word >>> 22) ^ word) >>> 0;
  return Math.fround(Math.fround(result) * Math.fround(1 / 2 ** 32));
}

export interface Star {
  /** `face · STAR_GRID² + row · STAR_GRID + column` */
  cell: number;
  /** unit, world space */
  direction: Linear3;
  /** in (0, 1] */
  brightness: number;
  /** linear */
  tint: Linear3;
}

/** a direction from a face (0..5: +x, −x, +y, −y, +z, −z) and the face coordinates (u, v) in −1..1 */
function faceDirection(face: number, u: number, v: number): Linear3 {
  const sign = face % 2 === 0 ? 1 : -1;
  const axis = face >> 1;
  const d: Linear3 = axis === 0 ? [sign, u, v] : axis === 1 ? [v, sign, u] : [u, v, sign];
  const l = Math.hypot(d[0], d[1], d[2]);
  return [d[0] / l, d[1] / l, d[2] / l];
}

/** the star of a cell, or null when the cell is empty */
function starOfCell(cell: number, threshold = STAR_THRESHOLD): Star | null {
  const face = Math.floor(cell / (STAR_GRID * STAR_GRID));
  const inFace = cell - face * STAR_GRID * STAR_GRID;
  const row = Math.floor(inFace / STAR_GRID);
  const column = inFace - row * STAR_GRID;
  // the cell's solid angle falls as (1 + u² + v²)^−1.5 toward the face's corners: the chance of a star falls with it
  const uc = ((column + 0.5) / STAR_GRID) * 2 - 1;
  const vc = ((row + 0.5) / STAR_GRID) * 2 - 1;
  const s = 1 + uc * uc + vc * vc;
  if (!(pcgHash(cell) * s * Math.sqrt(s) < threshold)) return null;
  const span = 1 - 2 * STAR_MARGIN;
  const u = ((column + STAR_MARGIN + span * pcgHash(cell + STAR_CELLS)) / STAR_GRID) * 2 - 1;
  const v = ((row + STAR_MARGIN + span * pcgHash(cell + 2 * STAR_CELLS)) / STAR_GRID) * 2 - 1;
  const b = pcgHash(cell + 3 * STAR_CELLS);
  const t = pcgHash(cell + 4 * STAR_CELLS);
  return {
    cell,
    direction: faceDirection(face, u, v),
    brightness: STAR_MIN + (1 - STAR_MIN) * b ** 4,
    tint: [STAR_COOL[0] + (STAR_WARM[0] - STAR_COOL[0]) * t, STAR_COOL[1] + (STAR_WARM[1] - STAR_COOL[1]) * t, STAR_COOL[2] + (STAR_WARM[2] - STAR_COOL[2]) * t],
  };
}

/** every star, in cell order: the same list on every call */
export function starField(count = 1024): Star[] {
  const out: Star[] = [];
  for (let cell = 0; cell < STAR_CELLS; cell++) {
    const s = starOfCell(cell, Math.min(STAR_CELLS, Math.max(0, count)) / STAR_CELLS / (Math.PI / 6));
    if (s !== null) out.push(s);
  }
  return out;
}

/** the cell a unit direction falls in */
export function starCellOf(dir: Readonly<Linear3>): number {
  const ax = Math.abs(dir[0]);
  const ay = Math.abs(dir[1]);
  const az = Math.abs(dir[2]);
  let axis: number;
  let major: number;
  let u: number;
  let v: number;
  if (ax >= ay && ax >= az) {
    axis = 0;
    major = dir[0];
    u = dir[1] / ax;
    v = dir[2] / ax;
  } else if (ay >= az) {
    axis = 1;
    major = dir[1];
    u = dir[2] / ay;
    v = dir[0] / ay;
  } else {
    axis = 2;
    major = dir[2];
    u = dir[0] / az;
    v = dir[1] / az;
  }
  const face = axis * 2 + (major < 0 ? 1 : 0);
  const cellOf = (t: number): number => Math.min(STAR_GRID - 1, Math.max(0, Math.floor((t * 0.5 + 0.5) * STAR_GRID)));
  return face * STAR_GRID * STAR_GRID + cellOf(v) * STAR_GRID + cellOf(u);
}

/**
 * The star light in a unit direction, linear: the star of the direction's cell, as a disc of `radius` radians (full inside
 * half the radius, fading to nothing at the radius).
 */
export function starAt(dir: Readonly<Linear3>, radius: number, count = 1024): Linear3 {
  const s = starOfCell(starCellOf(dir), Math.min(STAR_CELLS, Math.max(0, count)) / STAR_CELLS / (Math.PI / 6));
  if (s === null) return [0, 0, 0];
  const d = Math.hypot(dir[0] - s.direction[0], dir[1] - s.direction[1], dir[2] - s.direction[2]);
  const t = Math.min(Math.max((d - 0.5 * radius) / (0.5 * radius), 0), 1);
  const k = s.brightness * (1 - t * t * (3 - 2 * t));
  return [s.tint[0] * k, s.tint[1] * k, s.tint[2] * k];
}

/** the moon disc's coverage in a unit direction: 1 inside the disc, 0 beyond `MOON_RADIUS · MOON_EDGE` */
export function moonDisc(dir: Readonly<Linear3>): number {
  const c = dir[0] * MOON_DIRECTION[0] + dir[1] * MOON_DIRECTION[1] + dir[2] * MOON_DIRECTION[2];
  const e0 = Math.cos(MOON_RADIUS * MOON_EDGE);
  const e1 = Math.cos(MOON_RADIUS);
  const t = Math.min(Math.max((c - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
}

/** the night sky in a unit direction, linear HDR: the gradient, the stars, the moon (`starRadius` as the shader used it) */
export function nightSkyAt(dir: Readonly<Linear3>, sky: Extract<SkyState, { kind: 'night' }>, k: number, starRadius: number, starCount = 1024): Linear3 {
  const out = skyGradientAt(sky.horizon, sky.zenith, dir[1], k);
  if (sky.stars) {
    const s = starAt(dir, starRadius, starCount);
    out[0] += s[0];
    out[1] += s[1];
    out[2] += s[2];
  }
  const m = moonDisc(dir) * sky.moon;
  out[0] += MOON_COLOR[0] * m;
  out[1] += MOON_COLOR[1] * m;
  out[2] += MOON_COLOR[2] * m;
  return out;
}

// ── the nodes ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SkyUniforms {
  /** linear */
  readonly horizon: UniformNode<'vec3', Vector3>;
  readonly zenith: UniformNode<'vec3', Vector3>;
  /** the gradient's mean over the sphere (`envTerm`) */
  readonly mean: UniformNode<'vec3', Vector3>;
  /** [CAL `skyK`] */
  readonly skyK: UniformNode<'float', number>;
  /** the moon disc's emission (the config's `moon.intensity`; 0 = no moon) */
  readonly moon: UniformNode<'float', number>;
  /** 1 with stars, 0 without */
  readonly stars: UniformNode<'float', number>;
}

type V3 = Node<'vec3'>;
type F = Node<'float'>;

function gradientNode(dir: V3, u: SkyUniforms): V3 {
  return mix(u.horizon, u.zenith, dir.y.max(0).pow(u.skyK)) as V3;
}

/** 1 where `a ≥ b`, else 0 (an arithmetic mask: no `select()`, see grid-lights-node.ts) */
const ge = (a: F, b: F): F => float(a.greaterThanEqual(b)) as F;

function starsNode(dir: V3, threshold: number): V3 {
  const a = dir.abs();
  // the major axis, as three masks that sum to 1
  const mx = ge(a.x, a.y).mul(ge(a.x, a.z)).toVar();
  const my = float(1).sub(mx).mul(ge(a.y, a.z)).toVar();
  const mz = float(1).sub(mx).sub(my).toVar();
  const major = mx.mul(dir.x).add(my.mul(dir.y)).add(mz.mul(dir.z)).toVar();
  const inv = float(1).div(major.abs().max(1e-6)).toVar();
  // face coordinates: (y, z) on ±x, (z, x) on ±y, (x, y) on ±z
  const u = mx.mul(dir.y).add(my.mul(dir.z)).add(mz.mul(dir.x)).mul(inv);
  const v = mx.mul(dir.z).add(my.mul(dir.x)).add(mz.mul(dir.y)).mul(inv);
  const negative = float(major.lessThan(0));
  const face = my.mul(2).add(mz.mul(4)).add(negative);
  const column = u.mul(0.5).add(0.5).mul(STAR_GRID).floor().clamp(0, STAR_GRID - 1).toVar();
  const row = v.mul(0.5).add(0.5).mul(STAR_GRID).floor().clamp(0, STAR_GRID - 1).toVar();
  // exact integers below 2²⁴; the half guards the cast
  const cell = uint(face.mul(STAR_GRID * STAR_GRID).add(row.mul(STAR_GRID)).add(column).add(0.5)).toVar();
  const h = (k: number): F => hash(k === 0 ? cell : cell.add(uint(k * STAR_CELLS))) as unknown as F;
  // the chance of a star follows the cell's solid angle (see `STAR_THRESHOLD`)
  const uc = column.add(0.5).div(STAR_GRID).mul(2).sub(1);
  const vc = row.add(0.5).div(STAR_GRID).mul(2).sub(1);
  const s = uc.mul(uc).add(vc.mul(vc)).add(1).toVar();
  const present = float(h(0).mul(s).mul(s.sqrt()).lessThan(threshold));
  const span = 1 - 2 * STAR_MARGIN;
  const su = column.add(STAR_MARGIN).add(h(1).mul(span)).div(STAR_GRID).mul(2).sub(1).toVar();
  const sv = row.add(STAR_MARGIN).add(h(2).mul(span)).div(STAR_GRID).mul(2).sub(1).toVar();
  const sign = float(1).sub(negative.mul(2)).toVar();
  const star = vec3(sign, su, sv).mul(mx).add(vec3(sv, sign, su).mul(my)).add(vec3(su, sv, sign).mul(mz)).normalize();
  const dist = dir.sub(star).length();
  // never thinner than 1.5 pixels: the full-brightness core (half the radius) then spans 0.75 of a pixel, which always holds a
  // sample, so a star cannot fall between the samples of a coarse target or flicker as the view turns
  const pixel = dFdx(dir).length().max(dFdy(dir).length());
  const radius = pixel.mul(STAR_PIXEL_FLOOR).max(STAR_RADIUS).toVar();
  const disc = float(1).sub(smoothstep(radius.mul(0.5), radius, dist));
  const b = h(3);
  const brightness = b.mul(b).mul(b).mul(b).mul(1 - STAR_MIN).add(STAR_MIN);
  const tint = mix(vec3(...STAR_COOL), vec3(...STAR_WARM), h(4));
  return tint.mul(brightness).mul(disc).mul(present) as V3;
}

/** K14: the daylight sky's uniforms; the sky's horizon / zenith / skyK are shared with the other kinds */
export interface DaylightUniforms {
  readonly sunDirection: UniformNode<'vec3', Vector3>;
  readonly sunColor: UniformNode<'vec3', Vector3>;
  /** 0..1: the glow's strength (0 below the horizon) */
  readonly sunVisibility: UniformNode<'float', number>;
  readonly cloudColor: UniformNode<'vec3', Vector3>;
  /** x density, y opacity, z scale; opacity 0 = no clouds */
  readonly cloud: UniformNode<'vec3', Vector3>;
  /** noise-cell offset of the drift */
  readonly cloudOffset: UniformNode<'vec2', Vector2>;
  /** drift speed, cells per second (along +x) */
  readonly cloudSpeed: UniformNode<'float', number>;
}

/** the daylight sky: gradient, a glow and a disc around the sun, one cloud layer over it */
function daylightNode(dir: V3, u: SkyUniforms, d: DaylightUniforms): V3 {
  const base = gradientNode(dir, u);
  const c = dir.dot(d.sunDirection).toVar();
  const glow = c.max(0).pow(6).mul(0.25).add(c.max(0).pow(48).mul(0.7));
  const disc = smoothstep(Math.cos(SUN_DISC_RADIUS * 1.15), Math.cos(SUN_DISC_RADIUS), c);
  // clouds: a plane over the viewer, fading into the horizon; fbm of three's Perlin noise
  const p = dir.xz.div(dir.y.max(0.08)).mul(d.cloud.z).add(d.cloudOffset);
  const n = mx_fractal_noise_float(vec3(p, 0.37), 4, 2, 0.5).mul(0.5).add(0.5);
  const cover = smoothstep(float(1).sub(d.cloud.x), float(1).sub(d.cloud.x).add(0.3), n);
  const alpha = cover.mul(d.cloud.y).mul(smoothstep(0.02, 0.22, dir.y));
  const sky = base.add(d.sunColor.mul(glow).mul(d.sunVisibility));
  const withClouds = mix(sky, d.cloudColor, alpha);
  return withClouds.add(d.sunColor.mul(disc).mul(SUN_DISC_EMISSION).mul(d.sunVisibility).mul(float(1).sub(alpha))) as V3;
}

function moonNode(dir: V3): F {
  const c = dir.dot(vec3(...MOON_DIRECTION));
  // ordered edges: cos(R · 1.08) < cos(R)
  return smoothstep(Math.cos(MOON_RADIUS * MOON_EDGE), Math.cos(MOON_RADIUS), c) as F;
}

/** what `createSky` writes the background into (`SceneRoot` fits) */
export interface SkyTarget {
  setBackgroundNode(node: Node | null): void;
}

export interface SkyControl {
  /** the variant on screen; null before the first `apply` */
  readonly kind: SkyState['kind'] | null;
  readonly uniforms: SkyUniforms;
  /** both forms, for the warm-up compile; `apply` installs one of them */
  readonly nodes: { readonly gradient: Node; readonly night: Node; readonly daylight: Node };
  /** K14: the daylight sky's uniforms (sun, clouds) */
  readonly daylight: DaylightUniforms;
  /** K14: advances the cloud drift by `dt` seconds (no effect on other kinds) */
  advanceClouds(dt: number): void;
  /** the gradient for `envTerm()` (no stars, no moon) */
  readonly sampler: SkySampler;
  /** the star radius floor in pixels of the target (`STAR_PIXEL_FLOOR`): with `STAR_RADIUS`, what the CPU mirror needs to reproduce a frame */
  readonly starPixelFloor: number;
  /** Writes a place's sky. Returns true when the `backgroundNode` was swapped (gradient ↔ night, or the first place). */
  apply(sky: SkyState): boolean;
  /** removes the background node and the env sampler */
  dispose(): void;
}

export function createSky(target: SkyTarget, options: NightSkyOptions = {}): SkyControl {
  const u: SkyUniforms = {
    horizon: uniform(new Vector3()).setGroup(renderGroup).setName('ssSkyHorizon'),
    zenith: uniform(new Vector3()).setGroup(renderGroup).setName('ssSkyZenith'),
    mean: uniform(new Vector3()).setGroup(renderGroup).setName('ssSkyMean'),
    skyK: uniform(calibration.skyK).setGroup(renderGroup).setName('ssSkyK'),
    moon: uniform(0).setGroup(renderGroup).setName('ssSkyMoon'),
    stars: uniform(0).setGroup(renderGroup).setName('ssSkyStars'),
  };
  const dir = normalWorldGeometry as unknown as V3;
  const gradient = vec4(gradientNode(dir, u), 1);
  const night = vec4(gradientNode(dir, u).add(starsNode(dir, Math.min(STAR_CELLS, Math.max(0, options.starCount ?? 1024)) / STAR_CELLS / (Math.PI / 6)).mul(u.stars)).add(vec3(...MOON_COLOR).mul(moonNode(dir)).mul(u.moon)), 1);
  const d: DaylightUniforms = {
    sunDirection: uniform(new Vector3(0, 1, 0)).setGroup(renderGroup).setName('ssSkySunDir'),
    sunColor: uniform(new Vector3(1, 1, 1)).setGroup(renderGroup).setName('ssSkySunColor'),
    sunVisibility: uniform(0).setGroup(renderGroup).setName('ssSkySunVis'),
    cloudColor: uniform(new Vector3(1, 1, 1)).setGroup(renderGroup).setName('ssSkyCloudColor'),
    cloud: uniform(new Vector3(0.5, 0, 1)).setGroup(renderGroup).setName('ssSkyCloud'),
    cloudOffset: uniform(new Vector2()).setGroup(renderGroup).setName('ssSkyCloudOffset'),
    cloudSpeed: uniform(0).setGroup(renderGroup).setName('ssSkyCloudSpeed'),
  };
  const daylight = vec4(daylightNode(dir, u, d), 1);
  const sampler: SkySampler = { sample: (direction) => gradientNode(direction, u), mean: u.mean };
  installSkySampler(sampler);

  let kind: SkyState['kind'] | null = null;

  return {
    get kind(): SkyState['kind'] | null {
      return kind;
    },
    uniforms: u,
    nodes: { gradient, night, daylight },
    daylight: d,
    advanceClouds(dt: number): void {
      if (kind === 'daylight') d.cloudOffset.value.x += d.cloudSpeed.value * dt;
    },
    sampler,
    starPixelFloor: STAR_PIXEL_FLOOR,

    apply(sky: SkyState): boolean {
      const k = calibration.skyK > 0 && Number.isFinite(calibration.skyK) ? calibration.skyK : 0.5;
      u.horizon.value.set(sky.horizon[0], sky.horizon[1], sky.horizon[2]);
      u.zenith.value.set(sky.zenith[0], sky.zenith[1], sky.zenith[2]);
      u.skyK.value = k;
      const mean = skyMean(sky.horizon, sky.zenith, k);
      u.mean.value.set(mean[0], mean[1], mean[2]);
      u.moon.value = sky.kind === 'night' && sky.moon > 0 ? sky.moon : 0;
      u.stars.value = sky.kind === 'night' && sky.stars ? 1 : 0;
      if (sky.kind === 'daylight') {
        const day = sky.day;
        d.sunDirection.value.set(day.sunDirection[0], day.sunDirection[1], day.sunDirection[2]);
        d.sunColor.value.set(day.sunColor[0], day.sunColor[1], day.sunColor[2]);
        d.sunVisibility.value = day.sunVisibility;
        const cl = day.clouds;
        if (cl === null) d.cloud.value.set(0.5, 0, 1);
        else {
          d.cloud.value.set(cl.density, cl.opacity, cl.scale);
          d.cloudColor.value.set(cl.color[0], cl.color[1], cl.color[2]);
          d.cloudSpeed.value = cl.speed;
        }
      }
      if (sky.kind === kind) return false;
      kind = sky.kind;
      target.setBackgroundNode(kind === 'night' ? night : kind === 'daylight' ? daylight : gradient);
      return true;
    },

    dispose(): void {
      if (kind !== null) target.setBackgroundNode(null);
      kind = null;
      if (skySampler() === sampler) installSkySampler(null);
    },
  };
}
