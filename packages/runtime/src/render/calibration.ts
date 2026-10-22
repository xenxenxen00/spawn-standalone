// Calibration constants (docs/design/rendering.md §17; docs/architecture.md §3.5, X-27; WP R1a).
//
// Every [CAL] constant of the render design, with the default chosen from static evidence. **The defaults are what ships**:
// nothing in this project runs the Spawn client or a GPU to fit them (project decision 5, X-27). The "fitted by" note on each
// constant is the recipe for one optional human step: creator screenshots of the live game (the T-numbered views of
// `system-rendering-look.md` §10.4.3) fed to `tools/render/calibrate.ts`, which prints a patch for this file.
//
// `CALIBRATION_DEFAULTS` is frozen. `calibration` is the mutable runtime copy every render module reads; the dev-only
// `?calibrate=1` panel (R15) writes it, and `resetCalibration()` restores the defaults. A change of a structural constant
// (`roughnessAA`, `envScale` 0 ↔ non-zero, `wetModifier`, `additiveFog`, `tonemapOrder`, `bloomKernel`, `fxaa`) alters shader
// graphs: materials and the pipeline built before the change keep the old value until they are rebuilt.
//
// Fixed by three.js and therefore not here (X-46, render §0.1): the light-intensity, ambient and hemisphere scales (three's
// light units, which `scripts/lighting.js` was written for), the spot-cone mode (three's formula on the raw angles) and the
// fog distance metric (`FogExp2`, view depth). The ACES fit is three's own tone mapper, not a constant.
//
// Engine-free: no import, so boot code and Node tools may read it (X-26).

/** how `ctx.emissive(r, g, b)` display values become linear (render §5) */
export type EmissiveDecode = 'srgb-eotf' | 'hdr-linear';
/** where the tone map sits relative to the look script (render §10.1) */
export type TonemapOrder = 'aces-look' | 'look-aces';
/** bloom blur kernel: r186 radii 6..22 with σ = r/3, or the pre-r186 UnrealBloom 3..11 with σ = r (render §10.3) */
export type BloomKernel = 'r186' | 'unreal-legacy';
/** scene fog on additive materials: three's own mix toward the fog colour, or fade to nothing (render §13.5) */
export type AdditiveFog = 'three' | 'fade';
export type FxaaMode = 'off' | 'on';
/** whether `getRoughness` (the ≥ 0.0525 clamp and geometric specular AA) runs before the lighting script (render §7.1) */
export type RoughnessAA = 'three' | 'raw';
export type ViewmodelInterp = 'alpha' | 'step';
export type WetModifier = 'off' | 'surface';
export type GrainMode = 'additive';
export type Rgb = [number, number, number];

export interface Calibration {
  /**
   * `"srgb-eotf"`: three's `SRGBToLinear` on the raw number, `x ≤ 0.04045 ? x/12.92 : ((x+0.055)/1.055)^2.4`, growing as
   * x^2.4 above 1 (a display 1.8 decodes to 3.87). `"hdr-linear"`: `linear(x/hdr)·hdr`.
   * Evidence: authored content "display values … above 1 = HDR"; three `Color.setRGB(…, SRGBColorSpace)`.
   * Fitted by: a creator screenshot of a bright kit2 `glow()` lamp next to its known `hdr` value (card patch E is ruled out).
   */
  emissiveDecode: EmissiveDecode;
  /**
   * `"aces-look"`: ACES + sRGB, then the look on the display frame. Evidence: `kf2-mix.js:4` "blacks lifted just off zero",
   * grain ±3 levels, `look-default.js:1-2`, `api-reference.md:1671`. Fitted by: T2 (black and grain patches), T3-T5.
   */
  tonemapOrder: TonemapOrder;
  /** Evidence: the pinned three; Spawn's revision is unknown (threejs §1.2). Fitted by: T6 (halo profile around a known lamp). */
  bloomKernel: BloomKernel;
  /**
   * `"three"`: `material.fog = true` on every additive material. Evidence: authored content leaves the three default.
   * Fitted by: the skyline fires at 90-110 m.
   */
  additiveFog: AdditiveFog;
  /** Evidence: the engine's AA is unknown (`system-rendering-look.md` §10.1). Fitted by: creator choice (a GRAPHICS option). */
  fxaa: FxaaMode;
  /**
   * Scale of the analytic environment term handed to the lighting script as `lights.environment`; 0 compiles a constant
   * `vec3(0)`. Evidence: no `scene.environment` for a background-only sky; near-black night skies (render §7.1).
   * Fitted by: the T10/T11 residual.
   */
  envScale: number;
  /**
   * Evidence: Spawn's surfaces are presumably `MeshStandardNodeMaterial`s (its `builtin/three` list).
   * Fitted by: T10-T12 highlight width.
   */
  roughnessAA: RoughnessAA;
  /** flag `port.viewmodelInterp`. Evidence: contract §9.1, every 30 Hz row transform interpolated (X-36). Fitted by: A/B by eye. */
  viewmodelInterp: ViewmodelInterp;
  /**
   * `noise.fbm2`: simplex fbm, lacunarity 2, gain 0.5, normalised to [−1, 1].
   * Evidence: `terrain/config.yaml:50` peak 28.0000004 ⇒ n_max ≈ 1.0. Fitted by: MP0/MP1 against authored row heights.
   */
  noise: { kind: 'simplex-fbm'; lacunarity: number; gain: number; normalised: boolean };
  /** flag `fidelity.DR-18`: the live decal ring, 256 decals for 600 s. Evidence: `gore.yml:4-5, 106-108, 114`. Fitted by: creator choice (X-37). */
  decalWindow: { mode: 'live'; max: number; lifeS: number };
  /** `implicitRadius(I) = sqrt(I / k)`, the cut-off of a light with no `distance`. Evidence: `sk/2d-mode:35`. Fitted by: accept. */
  implicitRadiusK: number;
  /** sky gradient exponent: `mix(horizon, zenith, pow(max(dir.y, 0), skyK))`. Evidence: `system-rendering-look.md` §5. Fitted by: T7 (row 28). */
  skyK: number;
  /** the night scene has no fog colour in its config: the night sky's horizon colour, or an explicit linear RGB. Fitted by: row 19 or accept. */
  defaultFogColor: 'night-sky-horizon' | Rgb;
  /**
   * `grade` operator forms (render §10.5, Appendix B.4), in order: exposure (linear multiplier) → white balance (RGB gains
   * `(1 + T, 1 − tint/2, 1 − T)`) → lift/gamma/gain (`c = max(c·gain + lift·(1 − c), 0); c = c^(1/gamma)`) → contrast around
   * `contrastPivot` → saturation around Rec.709 luma → haze (`mix(c, hazeColor, haze · (1 − exp(−(fogDensity · viewZ)²)))`,
   * `hazeColor` = the fog colour when the look gives none).
   * Evidence: `system-rendering-look.md` §4.6. Fitted by: T2-T4, T9 (row 26). The operator bodies are R5b's (`postfx-tsl.ts`).
   */
  grade: {
    exposureLaw: 'linear';
    whiteBalance: 'rgb-gain';
    liftGammaGain: 'asc-cdl';
    contrastPivot: number;
    saturationLuma: 'rec709';
    hazeMode: 'fog-colour';
    hazeCurve: 'exp2';
  };
  /**
   * vignette profile (render §10.5): `p = |uv − 0.5|·2; d = (pₓ^r + p_y^r)^(1/r) · scale; mix(c, colour, intensity ·
   * smoothstep(1 − feather, 1, d))`, with these defaults for `roundness` and `feather`. Evidence: §4.6. Fitted by: T5.
   */
  vignette: { roundness: number; feather: number; scale: number };
  /** additive, luminance-independent: `c += (hash − 0.5) · intensity`. Evidence: §4.6. Fitted by: T2 patch variance. */
  grainMode: GrainMode;
  /**
   * `'off'`: `atmosphere.wet` changes no surface. Evidence: `wet`/`rain` are lighting-script inputs
   * (`api-reference.md:1640-1648`) and the live `lighting.js` reads neither (render §7.5). `'surface'` is an addition.
   * Fitted by: T10-T12, the up-facing vs vertical panel pair.
   */
  wetModifier: WetModifier;
  /** the `'surface'` wet law: `w = wet · smoothstep(normalYLow, normalYHigh, N.y)`, roughness × mix(1, roughnessScale, w), albedo × mix(1, albedoScale, w) */
  wet: { roughnessScale: number; albedoScale: number; normalYLow: number; normalYHigh: number };
  /** decal projection half-depth in metres, absolute. Evidence: `gore.js:637-638` lift 0.12; storeys 2.7-3.5 m apart. Fitted by: T15 (row 23). */
  decalDepth: number;
  /** Fitted by: T15 (row 23). */
  decalRoughness: number;
  /** LOD switch distances in metres: 1 → 3 and 3 → 5. Evidence: `system-maps.md` §12 suggests 25/60. Fitted by: row 12 or accept. */
  lod: { d13: number; d35: number };
  /** world camera planes. Evidence: three `PerspectiveCamera` defaults; `clips.js:31`. Fitted by: row 2. */
  nearFar: { near: number; far: number };
  /** fx `grav()`: the place's gravity (−24 on every live place) or an explicit m/s². Evidence: `system-rendering-look.md` §8.1 open. Fitted by: visual. */
  fxGravity: 'place' | number;
  /**
   * fx waveforms (render §13.3); the bodies belong to the fx package, the shapes and numbers are held here.
   *   flick(hz, amt) = 1 − amt · (bias + gain · n1(t·hz + seed)), n1 = 1D value noise
   *   fire()         = base + slowAmp · sin(2π · slowHz · t + φ) + fastAmp · n1(fastHz · t + φ)
   *   curl(f) * s    = curl of 3D simplex noise at frequency f, scaled s
   *   x~             = exponential smoothing with time constant tauS
   * Evidence: `system-rendering-look.md` §8.1. Fitted by: the docs door (row 10) or visual.
   */
  waveforms: {
    flick: { noise: 'value-1d'; bias: number; gain: number };
    fire: { base: number; slowAmp: number; slowHz: number; fastAmp: number; fastHz: number };
    curl: { noise: 'simplex-3d' };
    smooth: { tauS: number };
  };
  /** roughness of fx mesh sinks (blood drops, gore shards). Evidence: none. Fitted by: visual. */
  fxMeshRoughness: number;
}

type DeepReadonly<T> = T extends readonly unknown[] ? Readonly<T> : T extends object ? { readonly [K in keyof T]: DeepReadonly<T[K]> } : T;

function deepFreeze<T>(o: T): DeepReadonly<T> {
  if (o !== null && typeof o === 'object') {
    for (const v of Object.values(o)) deepFreeze(v);
    Object.freeze(o);
  }
  return o as DeepReadonly<T>;
}

function build(): Calibration {
  return {
    emissiveDecode: 'srgb-eotf',
    tonemapOrder: 'aces-look',
    bloomKernel: 'r186',
    additiveFog: 'three',
    fxaa: 'off',
    envScale: 0,
    roughnessAA: 'three',
    viewmodelInterp: 'alpha',
    noise: { kind: 'simplex-fbm', lacunarity: 2, gain: 0.5, normalised: true },
    decalWindow: { mode: 'live', max: 1024, lifeS: 600 },
    implicitRadiusK: 0.01,
    skyK: 0.5,
    defaultFogColor: 'night-sky-horizon',
    grade: {
      exposureLaw: 'linear',
      whiteBalance: 'rgb-gain',
      liftGammaGain: 'asc-cdl',
      contrastPivot: 0.18,
      saturationLuma: 'rec709',
      hazeMode: 'fog-colour',
      hazeCurve: 'exp2',
    },
    vignette: { roundness: 2, feather: 0.45, scale: 0.7071 },
    grainMode: 'additive',
    wetModifier: 'off',
    wet: { roughnessScale: 0.45, albedoScale: 0.78, normalYLow: 0.55, normalYHigh: 0.85 },
    decalDepth: 0.35,
    decalRoughness: 0.55,
    lod: { d13: 30, d35: 80 },
    nearFar: { near: 0.1, far: 2000 },
    fxGravity: 'place',
    waveforms: {
      flick: { noise: 'value-1d', bias: 0.5, gain: 0.5 },
      fire: { base: 0.78, slowAmp: 0.12, slowHz: 1.2, fastAmp: 0.1, fastHz: 2 },
      curl: { noise: 'simplex-3d' },
      smooth: { tauS: 0.25 },
    },
    fxMeshRoughness: 0.45,
  };
}

/** the shipped values; frozen at every level */
export const CALIBRATION_DEFAULTS: DeepReadonly<Calibration> = deepFreeze(build());

/** the runtime copy every render module reads; written only by the dev `?calibrate=1` panel and by tests */
export const calibration: Calibration = build();

/** restores every constant of the runtime copy to its default (the object identity of `calibration` is kept) */
export function resetCalibration(): void {
  Object.assign(calibration, build());
}

/** cut-off radius of a light record with no `distance` (render §8.1): `sqrt(I / k)`, 0 for a dark light */
export function implicitRadius(intensity: number): number {
  return intensity > 0 ? Math.sqrt(intensity / calibration.implicitRadiusK) : 0;
}
