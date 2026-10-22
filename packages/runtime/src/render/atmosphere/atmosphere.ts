// The atmosphere controller (docs/design/rendering.md §9.1, §4.1, §8.5; spawn-engine-contract.md §22; WP R4): a place's
// `atmosphere` block, and the live writes the game makes to it, become values on objects that already exist.
//
//   fog         the scene's one `FogExp2`: `fog.color.setRGB(…)` (linear) and `fog.density`, on the same object for the
//               renderer's whole life (three reads both through `reference()` uniforms and keys programs on the fog's type)
//   ambient     the permanent `AmbientLight`: colour linear, intensity raw (three's units, X-46)
//   hemisphere  the permanent `HemisphereLight`: `skyColor` → `color`, `groundColor` → `groundColor`; a place without one
//               (training) sets the intensity 0 and the light stays in the scene
//   sky         atmosphere/sky.ts: uniforms, and the `backgroundNode` when the kind changes
//   wet         a uniform and the state ([CAL `wetModifier`] `'off'`: no surface reads it by default); absent → 0
//   wind        the state only (the fx wind field reads it): direction in degrees, speed in m/s
//   look        the state only; `onLookChange` announces it and the post pipeline applies it (render §10)
//
// No three `Light` is ever added, removed or hidden here, `scene.fog` is never reassigned and `scene.environment` is never
// set: the light set and the fog type are in three's program cache key (render §4.1). Moon rows are light rows and drive the
// two permanent `DirectionalLight`s through the light bridge; `sun.light` (intensity 0 on every live place), `timeOfDay`,
// `cycle`, `clouds`, `rain` and `ground` are read by nothing.
//
// Live writes [F contract §22]: `scripts/map/power.js` writes `ambient.light.intensity` and `hemisphere.intensity`
// (`floor + (1 − floor) · k` of the map's fill), `scripts/gen/a scene fixture/nuke.js` replaces the whole `fog`.
//   - `onWrite(path, value)` records the write; `update(frame)` applies the recorded writes in arrival order, so a change
//     shows on the next frame, with no interpolation, and two writes of one tick are never combined: the last one stands
//   - a root assignment replaces (a `fog` without a colour gets the default colour, not the previous one), a leaf assignment
//     merges, and `value === undefined` is a delete, which reveals the value `load()` was given
//   - `path` is the dotted path of what was written (`'ambient.light.intensity'`, `'fog'`, `''` for the whole block) or the
//     `LayeredValue` segments (`['ambient', 'light', 'intensity']`, core-runtime §5.5)
//   - a write of the value its path already holds is dropped on arrival and allocates nothing
//   - a fog whose `kind` is not `exp2` is refused with one warning and the fog on screen stays (no live place has one)
//
// `load(def, config?)` is a place switch: every field is replaced at once (the place build runs behind the hold, and the fog,
// the lights and the sky must be in place before the variant compile, render §7.2), pending writes of the place before are
// dropped and the two FlashGuard channels are made anew. `def` is the composed place atmosphere, config plus the room's own
// layer (a scene fixture keeps its DUSK fog after the first strike); `config`, when given, is the place's config.yaml block.
//
// FlashGuard (render §8.5; X-23): the ambient and the hemisphere intensity pass through the channels `'ambient'` and
// `'hemisphere'` once per frame in `update`, which the frame's `lights` stage runs after the row writes and before the light
// texture upload. `state.*.intensity` is the writer's value; the light gets the channel's output. The channel's base is the
// authored intensity: `config`'s when `load` was given one, else `def`'s, raised to the largest value written since (a place
// loaded in the middle of a blackout would otherwise be held at its dimmed fill).
//
// Additive members beside render §9.1's three (`load`, `onWrite`, `state`), for the packages that consume them:
//   update(frame)        R13 / the lights stage (atmosphere/install.ts wires it)
//   fog                  the one `FogExp2`: R10 / R12a hand it to every additive material that fades ([CAL `additiveFog`]
//                        `'fade'` without the fog object switches fog off without fading)
//   sky                  the `SkyControl`: uniforms for `envTerm` (R1a), both background nodes for the warm-up (R6)
//   wet                  the wet uniform, `surfaceWet` of surface/surface-material.ts (R1a's `'surface'` modifier)
//   onFogChange          R5b: `PostPipelineHandle.setFog` (the haze)
//   onLookChange         R5b: `PostPipelineHandle.build`
//   pendingWrites        tests and the dev overlay
//   createMoonLights     R13: the sink of a place's directional rows (the two permanent `DirectionalLight`s)
import type { AmbientLight, DirectionalLight, Fog, FogExp2, HemisphereLight, UniformNode } from 'three/webgpu';
import { calibration } from '../calibration.ts';
import { cssToLinear, type Linear3 } from '../color/color.ts';
import { LINEAR_FOG_OFF } from '../scene/scene-root.ts';
import { surfaceWet } from '../surface/surface-material.ts';
import { DERIVED_AMBIENT_MAX, DERIVED_HEMISPHERE_MAX, MIN_CYCLE_PERIOD_MS, SUN_PEAK_INTENSITY, daylightFor, type DaylightConfig, type DaylightModel, type DaylightOverrides, type DaylightState } from './daylight.ts';
import { NIGHT_SKY, createSky, type SkyControl, type SkyState, type SkyTarget, type NightSkyOptions } from './sky.ts';

// ── render §9.1 ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface AtmosphereState {
  sky: SkyState;
  /** exp2 only (all live places) */
  /** `near` / `far` are set only when the world's fog model is linear (K14) */
  fog: { color: Linear3; density: number; near?: number; far?: number };
  ambient: { color: Linear3; intensity: number };
  hemisphere: { sky: Linear3; ground: Linear3; intensity: number } | null;
  wet: number;
  wind: { dirDeg: number; speed: number };
  look: { script: string; params: Record<string, number | number[]>; toneMapping: 'aces' | 'neutral' };
}

export interface AtmosphereController {
  /** place config.yaml */
  load(def: AtmosphereDef): void;
  /** live writes from the compat runtime */
  onWrite(path: string, value: unknown): void;
  /** read by the light uniforms, envTerm, haze and the fx wind field */
  readonly state: Readonly<AtmosphereState>;
}

/**
 * A place's `atmosphere` block as config.yaml and the place runtime's `LayeredValue` hold it (spawn-engine-contract.md §22).
 * Colours are `oklch(L C H)` or `#rrggbb` strings. Fields nothing reads are typed loosely.
 */
export interface AtmosphereDef {
  /** `top` / `bottom` (zenith / horizon, as a gradient world writes them) are read by the daylight model only (K14) */
  sky?: { kind?: 'gradient' | 'realistic' | (string & {}); horizon?: string; zenith?: string; model?: string; top?: string; bottom?: string };
  /** the night scene: false */
  ground?: boolean;
  stars?: { enabled?: boolean };
  moon?: { enabled?: boolean; intensity?: number };
  /** `color` / `intensity` / `rotation` / `orbit` are read by the daylight model only (K14); in the night model `sun` is read by nothing */
  sun?: { light?: { intensity?: number; color?: string }; color?: string; intensity?: number; rotation?: { pitch?: number; yaw?: number }; orbit?: { noonYaw?: number; maxElevation?: number } };
  fog?: { kind?: 'exp2' | 'linear' | (string & {}); color?: string; density?: number; near?: number; far?: number; height?: number };
  ambient?: { light?: { color?: string; intensity?: number } };
  hemisphere?: { skyColor?: string; groundColor?: string; intensity?: number } | null;
  wet?: number;
  rain?: number;
  wind?: { direction?: number; speed?: number };
  /** read by the daylight model only (K14) */
  timeOfDay?: number;
  /** daylight only: `{ frozen: hour }` pins the hour; `{ periodMs, epoch }` runs the day (24 h per period) from `timeOfDay` */
  cycle?: unknown;
  /** daylight only: `enabled`, `density`, `opacity`, `altitude`, `speed`, `color` (see daylight.ts) */
  clouds?: unknown;
  look?: { script?: string; toneMapping?: 'aces' | 'neutral'; params?: Record<string, number | number[]> };
}

/** render §21: the compat runtime's side of the atmosphere (the place runtimes' `LayeredValue`s) */
export interface AtmosphereSource {
  def(place: string): AtmosphereDef;
  onWrite(cb: (path: string, value: unknown) => void): void;
}

// ── what the controller needs ───────────────────────────────────────────────────────────────────────────────────────────

/** `FlashGuard` of lighting/flash-guard.ts; `release` (`FlashGuardControl`) is used when it is there */
export interface AtmosphereFlashGuard {
  channel(key: string, base: number): { apply(target: number, nowMs: number, dt: number): number };
  release?(key: string): void;
}

/** the scene root as far as the atmosphere writes it (`SceneRoot` fits) */
export interface AtmosphereRoot extends SkyTarget {
  readonly fog: FogExp2;
  /** K14: set when the world's fog is linear; then `kind: 'linear'` is applied to it and `exp2` is refused */
  readonly linearFog?: Fog | null;
  readonly lights: { readonly ambient: AmbientLight; readonly hemisphere: HemisphereLight; readonly directionals?: readonly [DirectionalLight, DirectionalLight] };
}

export interface AtmosphereOptions {
  nightSky?: NightSkyOptions;
  root: AtmosphereRoot;
  /** render §8.5; without one the lights get the writers' values as they are */
  flashGuard?: AtmosphereFlashGuard | null;
  /** default: a sky made on `root` */
  sky?: SkyControl;
  /** default `console.warn` */
  warn?: (message: string) => void;
  /**
   * K14: 'night' (default) is the legacy host's atmosphere, unchanged; 'daylight' also reads `timeOfDay`, `cycle`, `sun`, `sky.top/bottom`
   * and `clouds`, drives one of the root's two permanent `DirectionalLight`s as the sun, and derives the hemisphere and
   * ambient fill when the config authors none.
   */
  model?: DaylightModel;
  /** daylight: which permanent directional light is the sun (default 0); a bridge that writes that slot's rows would overwrite it */
  sunSlot?: 0 | 1;
  /** daylight: how far from the focus the sun light sits, so its shadow camera spans the scene (default 120) */
  sunDistance?: number;
  /** daylight, opt-in: sky tint / saturation and a pinned sun (`DaylightOverrides`); default none */
  daylight?: DaylightOverrides;
}

/** the part of `FrameInfo` the atmosphere reads */
export interface AtmosphereFrame {
  /** presentation ms */
  now: number;
  /** presentation seconds of this frame */
  dt: number;
}

export interface AtmosphereControl extends AtmosphereController {
  /** `config`: the place's config.yaml block, the authored FlashGuard bases; default `def` */
  load(def: AtmosphereDef, config?: AtmosphereDef): void;
  /** `path` may also be the `LayeredValue` segments; `undefined` is a delete */
  onWrite(path: string | readonly string[], value: unknown): void;
  /** once per rendered frame, in the `lights` stage: applies the recorded writes, then the FlashGuard */
  update(frame: AtmosphereFrame): void;
  /** the scene's one `FogExp2` */
  readonly fog: FogExp2;
  readonly sky: SkyControl;
  readonly model: DaylightModel;
  /** daylight: the numbers last applied (hour, sun, fill, clouds); null in the night model */
  readonly daylight: Readonly<DaylightState> | null;
  /** daylight: moves the sun light's target (and the light with it) so its shadow follows the player; no effect in the night model */
  setSunFocus(x: number, y: number, z: number): void;
  readonly wet: UniformNode<'float', number>;
  /** writes recorded and not yet applied */
  readonly pendingWrites: number;
  /** after a load or an applied write changed the fog; returns unsubscribe */
  onFogChange(cb: (fog: Readonly<AtmosphereState['fog']>) => void): () => void;
  /** after a load or an applied write under `look`; returns unsubscribe */
  onLookChange(cb: (look: Readonly<AtmosphereState['look']>) => void): () => void;
  dispose(): void;
}

// ── plain data helpers ──────────────────────────────────────────────────────────────────────────────────────────────────

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

function clone<T>(v: T): T {
  if (Array.isArray(v)) return v.map((x) => clone(x as unknown)) as T;
  if (isObj(v)) {
    const out: Obj = {};
    for (const k of Object.keys(v)) out[k] = clone(v[k]);
    return out as T;
  }
  return v;
}

function getAt(root: unknown, segs: readonly string[]): unknown {
  let cur = root;
  for (const s of segs) {
    if (!isObj(cur) || !Object.prototype.hasOwnProperty.call(cur, s)) return undefined;
    cur = cur[s];
  }
  return cur;
}

/** `root[path] = value` with objects made on the way; `undefined` removes the key */
function setAt(root: Obj, segs: readonly string[], value: unknown): void {
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    const s = segs[i]!;
    if (s === '__proto__') return;
    if (!isObj(cur[s])) {
      if (value === undefined) return;
      cur[s] = {};
    }
    cur = cur[s] as Obj;
  }
  const last = segs[segs.length - 1]!;
  if (last === '__proto__') return;
  if (value === undefined) delete cur[last];
  else cur[last] = value;
}

const DIRTY = { sky: 1, fog: 2, ambient: 4, hemisphere: 8, wet: 16, wind: 32, look: 64, all: 127 } as const;

/** which parts of the state a write under a top-level key touches */
function dirtyOf(head: string | undefined, daylight: boolean): number {
  if (daylight) {
    switch (head) {
      case 'timeOfDay':
      case 'cycle':
      case 'clouds':
      case 'sun':
      case 'sky':
      case 'stars':
      case 'moon':
        // the sun drives the sky and the fill, and through the horizon a fog that names no colour
        return DIRTY.sky | DIRTY.fog | DIRTY.ambient | DIRTY.hemisphere;
    }
  }
  switch (head) {
    case undefined:
      return DIRTY.all;
    case 'sky':
    case 'stars':
    case 'moon':
      // the default fog colour is the sky's horizon
      return DIRTY.sky | DIRTY.fog;
    case 'fog':
      return DIRTY.fog;
    case 'ambient':
      return DIRTY.ambient;
    case 'hemisphere':
      return DIRTY.hemisphere;
    case 'wet':
      return DIRTY.wet;
    case 'wind':
      return DIRTY.wind;
    case 'look':
      return DIRTY.look;
    default:
      return 0;
  }
}

// ── the moon rows ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** a directional light row as the bridge resolves it (the shape of its `DirectionalSink`) */
export interface MoonLight {
  /** linear */
  color: Readonly<Linear3>;
  intensity: number;
  /** light − target, world; any length */
  direction: { readonly x: number; readonly y: number; readonly z: number };
}

export interface MoonLights {
  /** `slot` 0 or 1; null switches the slot off (intensity 0: the light stays in the scene) */
  set(slot: number, light: MoonLight | null): void;
}

/**
 * The two permanent `DirectionalLight`s of the scene root as the sink of a place's moon rows (render §4.1, §8.1): values
 * only, on lights that are never added, removed or hidden. A directional light shines from its position toward its target,
 * which stays at the origin; without a shadow only the direction matters.
 */
export function createMoonLights(moons: readonly [DirectionalLight, DirectionalLight]): MoonLights {
  return {
    set(slot: number, light: MoonLight | null): void {
      const moon = moons[slot];
      if (moon === undefined) throw new RangeError(`moon lights: slot ${String(slot)} does not exist (a place has at most two directional rows)`);
      if (light === null) {
        moon.intensity = 0;
        return;
      }
      const { x, y, z } = light.direction;
      const len = Math.hypot(x, y, z);
      if (len > 0 && Number.isFinite(len)) moon.position.set(x / len, y / len, z / len);
      moon.target.position.set(0, 0, 0);
      moon.color.setRGB(light.color[0], light.color[1], light.color[2]);
      moon.intensity = light.intensity > 0 && Number.isFinite(light.intensity) ? light.intensity : 0;
    },
  };
}

const isPrimitive = (v: unknown): boolean => v === null || (typeof v !== 'object' && typeof v !== 'function' && v !== undefined);

export function createAtmosphere(opts: AtmosphereOptions): AtmosphereControl {
  const { root } = opts;
  const { fog } = root;
  const { ambient, hemisphere } = root.lights;
  const guard = opts.flashGuard ?? null;
  const warn = opts.warn ?? ((m: string): void => console.warn(m));
  const model: DaylightModel = opts.model === 'daylight' ? 'daylight' : 'night';
  const daylightOn = model === 'daylight';
  const sunLight = daylightOn ? (root.lights.directionals?.[opts.sunSlot === 1 ? 1 : 0] ?? null) : null;
  const sunDistance = opts.sunDistance !== undefined && opts.sunDistance > 0 && Number.isFinite(opts.sunDistance) ? opts.sunDistance : 120;
  const sunFocus = { x: 0, y: 0, z: 0 };
  /** the daylight numbers last applied; null in the night model */
  let day: DaylightState | null = null;
  /** the hour the sky was last computed for */
  let appliedHour = Number.NaN;
  let lastNow = 0;
  const ownSky = opts.sky === undefined;
  const sky = opts.sky ?? createSky(root, opts.nightSky);
  // the uniform the surface material's wet stage reads (render §7.5)
  const wet = surfaceWet;

  /** what `load` was given: the layer a delete reveals */
  let base: AtmosphereDef = {};
  /** `base` with the applied writes */
  let current: AtmosphereDef = {};

  // the state: one object for the controller's life, mutated in place
  const hemi: NonNullable<AtmosphereState['hemisphere']> = { sky: [1, 1, 1], ground: [0, 0, 0], intensity: 0 };
  const state: AtmosphereState = {
    sky: { kind: 'gradient', horizon: [0, 0, 0], zenith: [0, 0, 0] },
    fog: { color: [0, 0, 0], density: 0 },
    ambient: { color: [1, 1, 1], intensity: 0 },
    hemisphere: null,
    wet: 0,
    wind: { dirDeg: 0, speed: 0 },
    look: { script: '', params: {}, toneMapping: 'aces' },
  };

  // FlashGuard channels and their bases
  let ambientChannel: ReturnType<AtmosphereFlashGuard['channel']> | null = null;
  let hemisphereChannel: ReturnType<AtmosphereFlashGuard['channel']> | null = null;
  let ambientBase = 0;
  let hemisphereBase = 0;
  /** the bases come from the place config: a larger write does not raise them */
  let basesAuthored = false;
  /** the sun's channel; its base is the authored peak, fixed at load (a write never raises it) */
  let sunChannel: ReturnType<AtmosphereFlashGuard['channel']> | null = null;
  let sunBase = 0;

  // pending writes, in arrival order; the arrays are reused
  const pendingSegs: Array<readonly string[]> = [];
  const pendingValues: unknown[] = [];
  let pending = 0;
  /** the last primitive written per path string since the last structural write */
  const lastWritten = new Map<string, unknown>();
  const segCache = new Map<string, readonly string[]>();
  const EMPTY: readonly string[] = Object.freeze([]);

  const warned = new Set<string>();
  const warnOnce = (key: string, message: string): void => {
    if (warned.has(key)) return;
    warned.add(key);
    warn(message);
  };

  const fogListeners = new Set<(fog: Readonly<AtmosphereState['fog']>) => void>();
  const lookListeners = new Set<(look: Readonly<AtmosphereState['look']>) => void>();
  const tell = <T>(listeners: Set<(v: T) => void>, v: T): void => {
    for (const cb of [...listeners]) {
      try {
        cb(v);
      } catch (e) {
        console.error('atmosphere: a listener threw', e);
      }
    }
  };

  /** a colour string into `out`; an unreadable one keeps `out` and warns once per value */
  function colorInto(out: Linear3, value: unknown, what: string, fallback: Readonly<Linear3> | null): void {
    if (value === undefined || value === null) {
      if (fallback !== null) {
        out[0] = fallback[0];
        out[1] = fallback[1];
        out[2] = fallback[2];
      }
      return;
    }
    const c = typeof value === 'string' ? cssToLinear(value) : null;
    if (c === null) {
      warnOnce(`color:${what}:${String(value)}`, `atmosphere: unreadable ${what} colour ${JSON.stringify(value)}; the colour on screen stays`);
      return;
    }
    out[0] = c[0];
    out[1] = c[1];
    out[2] = c[2];
  }

  /** the hour of the day: `cycle.frozen`, or `timeOfDay` advanced by a running `cycle`, or `timeOfDay` (default 12) */
  function hourNow(): number {
    const base = num(current.timeOfDay, 12);
    const c = isObj(current.cycle) ? current.cycle : null;
    if (c === null) return base;
    if (typeof c.frozen === 'number' && Number.isFinite(c.frozen)) return c.frozen;
    if (typeof c.periodMs === 'number' && c.periodMs > 0 && Number.isFinite(c.periodMs)) return base + ((lastNow - num(c.epoch, 0)) / Math.max(MIN_CYCLE_PERIOD_MS, c.periodMs)) * 24;
    return base;
  }

  /** the sun light: a permanent directional light, values only (never added, removed or hidden) */
  function applySun(d: DaylightState): void {
    if (sunLight === null) return;
    sunLight.position.set(sunFocus.x + d.sunDirection[0] * sunDistance, sunFocus.y + d.sunDirection[1] * sunDistance, sunFocus.z + d.sunDirection[2] * sunDistance);
    sunLight.target.position.set(sunFocus.x, sunFocus.y, sunFocus.z);
    sunLight.color.setRGB(d.sunColor[0], d.sunColor[1], d.sunColor[2]);
    // the intensity is not set here: `update` passes it through the FlashGuard's 'sun' channel (load shows it at once)
    // the shadow camera spans the focus +- the distance, whatever its extent
    sunLight.shadow.camera.far = sunDistance * 2 + 50;
    sunLight.shadow.camera.updateProjectionMatrix();
  }

  function applySky(): void {
    const d = current.sky;
    const kind = isObj(d) ? d.kind : undefined;
    const explicit = isObj(d) && (typeof d.top === 'string' || typeof d.bottom === 'string' || typeof d.zenith === 'string' || typeof d.horizon === 'string');
    if (daylightOn && !(kind === 'gradient' && explicit)) {
      // K14: realistic / rayleigh / hosek, or no sky at all, are drawn as the daylight sky (a gradient that names its colours stays one)
      day = daylightFor(current as DaylightConfig, hourNow(), opts.daylight);
      appliedHour = day.hour;
      state.sky = { kind: 'daylight', horizon: day.horizon, zenith: day.zenith, day };
      applySun(day);
    } else if (kind === 'realistic') {
      const stars = current.stars?.enabled === true;
      const moon = current.moon?.enabled === true ? Math.max(0, num(current.moon.intensity, 1)) : 0;
      state.sky = { kind: 'night', stars, moon, horizon: [...(opts.nightSky?.horizon ?? NIGHT_SKY.horizon)], zenith: [...(opts.nightSky?.zenith ?? NIGHT_SKY.zenith)] };
    } else {
      if (kind !== 'gradient') warnOnce(`sky:${String(kind)}`, `atmosphere: sky kind ${JSON.stringify(kind)} is not drawn; a gradient is`);
      const prev = state.sky;
      const next: SkyState = { kind: 'gradient', horizon: prev.kind === 'gradient' ? prev.horizon : [0, 0, 0], zenith: prev.kind === 'gradient' ? prev.zenith : [0, 0, 0] };
      colorInto(next.horizon, daylightOn ? (d?.bottom ?? d?.horizon) : d?.horizon, 'sky horizon', [0, 0, 0]);
      colorInto(next.zenith, daylightOn ? (d?.top ?? d?.zenith) : d?.zenith, 'sky zenith', [0, 0, 0]);
      if (daylightOn) {
        // a gradient world: the sun still lights it, from the hour
        const lit = daylightFor(current as DaylightConfig, hourNow(), opts.daylight);
        appliedHour = lit.hour;
        day = { ...lit, horizon: next.horizon, zenith: next.zenith };
        applySun(day);
      }
      state.sky = next;
    }
    sky.apply(state.sky);
  }

  /** the colour of a fog that names none: [CAL `defaultFogColor`], by default the sky's horizon */
  function defaultFogColor(): Readonly<Linear3> {
    const c = calibration.defaultFogColor;
    return c === 'night-sky-horizon' ? state.sky.horizon : c;
  }

  /** the fog def last accepted: what a refused write falls back to */
  let acceptedFog: AtmosphereDef['fog'];

  function applyFog(): void {
    const d = current.fog;
    const linear = root.linearFog ?? null;
    const want = isObj(d) ? d.kind : undefined;
    // K14: the fog type is fixed per world; a def of the other type is refused like an unknown one
    const refused = linear === null ? want !== undefined && want !== 'exp2' : want !== undefined && want !== 'linear';
    if (isObj(d) && refused) {
      const only = linear === null ? 'exp2 only' : 'linear only: the world was made with fogModel linear';
      warnOnce(`fog:${String(want)}`, `atmosphere: fog kind ${JSON.stringify(want)} is not supported (${only}); the fog on screen stays`);
      if (acceptedFog === undefined) delete current.fog;
      else current.fog = clone(acceptedFog);
      return;
    }
    acceptedFog = d === undefined ? undefined : clone(d);
    if (linear !== null) {
      applyLinearFog(linear, d);
      return;
    }
    state.fog.density = Math.max(0, num(d?.density, 0));
    if (d?.color === undefined) colorInto(state.fog.color, undefined, 'fog', defaultFogColor());
    else colorInto(state.fog.color, d.color, 'fog', null);
    // the same object, mutated: never a new fog (render §9.1)
    fog.color.setRGB(state.fog.color[0], state.fog.color[1], state.fog.color[2]);
    fog.density = state.fog.density;
    tell(fogListeners, state.fog);
  }

  /** K14: `near` / `far` and the colour into the one `Fog`; a def without them fogs nothing */
  function applyLinearFog(linear: Fog, d: AtmosphereDef['fog']): void {
    const near = Math.max(0, num(d?.near, LINEAR_FOG_OFF.near));
    let far = num(d?.far, LINEAR_FOG_OFF.far);
    if (far <= near) far = near + 1e-3;
    state.fog.density = 0;
    state.fog.near = near;
    state.fog.far = far;
    if (d?.color === undefined) colorInto(state.fog.color, undefined, 'fog', defaultFogColor());
    else colorInto(state.fog.color, d.color, 'fog', null);
    linear.color.setRGB(state.fog.color[0], state.fog.color[1], state.fog.color[2]);
    linear.near = near;
    linear.far = far;
    tell(fogListeners, state.fog);
  }

  function applyAmbient(): void {
    const l = current.ambient?.light;
    colorInto(state.ambient.color, l?.color, 'ambient', l?.color === undefined ? (day !== null && l?.intensity === undefined ? day.ambient.color : [1, 1, 1]) : null);
    state.ambient.intensity = Math.max(0, num(l?.intensity, day !== null ? day.ambient.intensity : 0));
    ambient.color.setRGB(state.ambient.color[0], state.ambient.color[1], state.ambient.color[2]);
  }

  function applyHemisphere(): void {
    // K14: a daylight world that authors no hemisphere (and does not say null) gets the sky's
    if (day !== null && current.hemisphere === undefined) {
      const f = day.hemisphere;
      hemi.sky[0] = f.sky[0];
      hemi.sky[1] = f.sky[1];
      hemi.sky[2] = f.sky[2];
      hemi.ground[0] = f.ground[0];
      hemi.ground[1] = f.ground[1];
      hemi.ground[2] = f.ground[2];
      hemi.intensity = f.intensity;
      state.hemisphere = hemi;
      hemisphere.color.setRGB(hemi.sky[0], hemi.sky[1], hemi.sky[2]);
      hemisphere.groundColor.setRGB(hemi.ground[0], hemi.ground[1], hemi.ground[2]);
      return;
    }
    const d = current.hemisphere;
    if (!isObj(d)) {
      state.hemisphere = null;
      return;
    }
    colorInto(hemi.sky, d.skyColor, 'hemisphere sky', d.skyColor === undefined ? [1, 1, 1] : null);
    colorInto(hemi.ground, d.groundColor, 'hemisphere ground', d.groundColor === undefined ? [0, 0, 0] : null);
    hemi.intensity = Math.max(0, num(d.intensity, 0));
    state.hemisphere = hemi;
    hemisphere.color.setRGB(hemi.sky[0], hemi.sky[1], hemi.sky[2]);
    hemisphere.groundColor.setRGB(hemi.ground[0], hemi.ground[1], hemi.ground[2]);
  }

  function applyLook(): void {
    const d = current.look;
    state.look = {
      script: typeof d?.script === 'string' ? d.script : '',
      params: isObj(d?.params) ? (clone(d.params) as Record<string, number | number[]>) : {},
      toneMapping: d?.toneMapping === 'neutral' ? 'neutral' : 'aces',
    };
    tell(lookListeners, state.look);
  }

  function applyDirty(dirty: number): void {
    if (dirty & DIRTY.sky) applySky();
    if (dirty & DIRTY.fog) applyFog();
    if (dirty & DIRTY.ambient) applyAmbient();
    if (dirty & DIRTY.hemisphere) applyHemisphere();
    if (dirty & DIRTY.wet) {
      state.wet = Math.min(1, Math.max(0, num(current.wet, 0)));
      wet.value = state.wet;
    }
    if (dirty & DIRTY.wind) {
      state.wind.dirDeg = num(current.wind?.direction, 0);
      state.wind.speed = num(current.wind?.speed, 0);
    }
    if (dirty & DIRTY.look) applyLook();
  }

  /** the channels of the place: the old ones are given back, so the first value of the new place shows at once */
  function resetChannels(config: AtmosphereDef): void {
    ambientBase = Math.max(0, num(config.ambient?.light?.intensity, 0));
    hemisphereBase = isObj(config.hemisphere) ? Math.max(0, num(config.hemisphere.intensity, 0)) : 0;
    if (day !== null) {
      // derived fills move with the hour: the guard's base is the largest they take
      ambientBase = Math.max(ambientBase, state.ambient.intensity);
      hemisphereBase = Math.max(hemisphereBase, state.hemisphere?.intensity ?? 0);
    }
    if (daylightOn) {
      const src = isObj(config.sun) ? (config.sun as NonNullable<DaylightConfig['sun']>) : {};
      sunBase = Math.max(0, num(src.intensity, num(src.light?.intensity, SUN_PEAK_INTENSITY)));
    }
    if (guard === null) return;
    guard.release?.('sun');
    sunChannel = daylightOn && sunLight !== null ? guard.channel('sun', sunBase) : null;
    guard.release?.('ambient');
    guard.release?.('hemisphere');
    ambientChannel = guard.channel('ambient', ambientBase);
    hemisphereChannel = guard.channel('hemisphere', hemisphereBase);
  }

  function segsOf(path: string | readonly string[]): readonly string[] {
    if (typeof path !== 'string') return path.length === 0 ? EMPTY : path.map(String);
    if (path === '') return EMPTY;
    let segs = segCache.get(path);
    if (segs === undefined) {
      segs = Object.freeze(path.split('.').filter((s) => s !== ''));
      if (segCache.size >= 64) segCache.clear();
      segCache.set(path, segs);
    }
    return segs;
  }

  const control: AtmosphereControl = {
    state,
    fog,
    sky,
    model,
    get daylight(): Readonly<DaylightState> | null {
      return day;
    },
    setSunFocus(x: number, y: number, z: number): void {
      if (!daylightOn) return;
      sunFocus.x = x;
      sunFocus.y = y;
      sunFocus.z = z;
      if (day !== null) applySun(day);
    },
    wet,
    get pendingWrites(): number {
      return pending;
    },

    load(def: AtmosphereDef, config?: AtmosphereDef): void {
      base = clone(isObj(def) ? def : {});
      current = clone(base);
      pending = 0;
      pendingSegs.length = 0;
      pendingValues.length = 0;
      lastWritten.clear();
      acceptedFog = undefined;
      basesAuthored = config !== undefined;
      day = null;
      applyDirty(DIRTY.all);
      resetChannels(config ?? base);
      // the lights show the place at once (the warm-up compiles and draws before the first `update`)
      ambient.intensity = state.ambient.intensity;
      const lit = day as DaylightState | null;
      if (sunLight !== null && lit !== null) sunLight.intensity = lit.sunIntensity;
      hemisphere.intensity = state.hemisphere === null ? 0 : state.hemisphere.intensity;
    },

    onWrite(path: string | readonly string[], value: unknown): void {
      const segs = segsOf(path);
      if (typeof path === 'string' && isPrimitive(value)) {
        // a write of the value the path already holds is free
        if (lastWritten.has(path)) {
          if (Object.is(lastWritten.get(path), value)) return;
        } else {
          // the first write of this path: what is known about the paths above and below it no longer holds
          for (const known of lastWritten.keys()) if (known.startsWith(`${path}.`) || path.startsWith(`${known}.`)) lastWritten.delete(known);
          if (pending === 0 && Object.is(getAt(current, segs), value)) {
            lastWritten.set(path, value);
            return;
          }
        }
        lastWritten.set(path, value);
      } else {
        // a subtree was replaced or revealed: what the leaf paths hold is no longer known
        lastWritten.clear();
      }
      pendingSegs[pending] = segs;
      pendingValues[pending] = value;
      pending++;
    },

    update(frame: AtmosphereFrame): void {
      lastNow = frame.now;
      let cycled = 0;
      if (daylightOn) {
        sky.advanceClouds(frame.dt);
        // a running cycle moves the hour: the sky, the sun and the fill follow once it has moved by about a minute of the day
        const moved = ((((hourNow() - appliedHour + 12) % 24) + 24) % 24) - 12;
        if (day !== null && Math.abs(moved) > 0.02) cycled = DIRTY.sky | DIRTY.ambient | DIRTY.hemisphere | (current.fog?.color === undefined ? DIRTY.fog : 0);
      }
      if (pending > 0 || cycled !== 0) {
        let dirty = 0;
        for (let i = 0; i < pending; i++) {
          const segs = pendingSegs[i]!;
          const value = pendingValues[i];
          pendingValues[i] = undefined;
          if (segs.length === 0) {
            // the whole block: replaced, or the own layer dropped
            current = clone(value === undefined ? base : isObj(value) ? (value as AtmosphereDef) : {});
          } else if (value === undefined) {
            // a delete reveals the loaded value
            setAt(current as Obj, segs, clone(getAt(base, segs)));
          } else {
            setAt(current as Obj, segs, clone(value));
          }
          dirty |= dirtyOf(segs[0], daylightOn);
        }
        pending = 0;
        applyDirty(dirty | cycled);
      }

      // the sun, through its own channel (K14): a snapped hour or a fast cycle is limited like any other light
      if (sunLight !== null && day !== null) sunLight.intensity = sunChannel !== null ? sunChannel.apply(day.sunIntensity, frame.now, frame.dt) : day.sunIntensity;

      // the fill intensities, through the guard, every frame (a fade needs frames)
      const a = state.ambient.intensity;
      if (ambientChannel !== null && guard !== null) {
        const raise = daylightOn ? (day !== null && current.ambient?.light?.intensity === undefined ? Math.min(a, DERIVED_AMBIENT_MAX) : 0) : basesAuthored ? 0 : a;
        if (raise > ambientBase) ambientChannel = guard.channel('ambient', (ambientBase = raise));
        ambient.intensity = ambientChannel.apply(a, frame.now, frame.dt);
      } else {
        ambient.intensity = a;
      }
      if (state.hemisphere === null) {
        hemisphere.intensity = 0;
      } else {
        const h = state.hemisphere.intensity;
        if (hemisphereChannel !== null && guard !== null) {
          const raise = daylightOn ? (day !== null && current.hemisphere === undefined ? Math.min(h, DERIVED_HEMISPHERE_MAX) : 0) : basesAuthored ? 0 : h;
          if (raise > hemisphereBase) hemisphereChannel = guard.channel('hemisphere', (hemisphereBase = raise));
          hemisphere.intensity = hemisphereChannel.apply(h, frame.now, frame.dt);
        } else {
          hemisphere.intensity = h;
        }
      }
    },

    onFogChange(cb) {
      fogListeners.add(cb);
      return () => void fogListeners.delete(cb);
    },
    onLookChange(cb) {
      lookListeners.add(cb);
      return () => void lookListeners.delete(cb);
    },

    dispose(): void {
      fogListeners.clear();
      lookListeners.clear();
      pending = 0;
      guard?.release?.('sun');
      guard?.release?.('ambient');
      guard?.release?.('hemisphere');
      sunChannel = null;
      ambientChannel = null;
      hemisphereChannel = null;
      if (ownSky) sky.dispose();
    },
  };
  return control;
}
