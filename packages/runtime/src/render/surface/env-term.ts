// envTerm (docs/design/rendering.md §7.1 "lights.environment"; [CAL `envScale`]; WP R1a): the node the lighting script
// receives as `lights.environment`, "the environment reflection the engine folded for this surface" (`lighting.js:38`).
//
// Default `envScale` 0: the port draws the sky as `scene.backgroundNode`, not as `scene.environment`, and a background-only sky
// gives three an environment of 0; nothing in the live tree says Spawn folded one from it. At 0 this is the constant
// `vec3(0)`: no sky sampling is compiled and no light is added that the live frame is not known to have had.
//
// Non-zero `envScale` (1 to enable) turns on the analytic term kept from the Babylon plan:
//   Karis' mobile `envBRDF(f0, roughness, N·V)` × the sky sampled in the reflection direction, blended toward the sky's mean
//   colour by roughness, × `envScale`
// The sky gradient is the atmosphere package's (R4): it installs a `SkySampler`. Without one there is no environment to
// reflect and the term stays 0.
import { cameraWorldMatrix, diffuseColor, float, metalness, mix, normalView, positionViewDirection, roughness, vec2, vec3, vec4 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import { calibration } from '../calibration.ts';

/** The sky as the surface shader may sample it (installed by `atmosphere/sky.ts`, R4). */
export interface SkySampler {
  /** linear sky radiance in a world-space unit direction, vec3 */
  sample(directionWorld: Node<'vec3'>): Node<'vec3'>;
  /** the sky's mean colour (what a fully rough surface reflects), vec3 */
  readonly mean: Node<'vec3'>;
}

export interface EnvTermOptions {
  /** [CAL `envScale`]; 0 = no environment */
  envScale: number;
  sky: SkySampler | null;
}

let installedSky: SkySampler | null = null;
let skyEpoch = 0;

/** R4 hands over the place's sky; null removes it. Materials built before the call keep what they compiled. */
export function installSkySampler(sky: SkySampler | null): void {
  if (sky !== installedSky) skyEpoch++;
  installedSky = sky;
}

export function skySampler(): SkySampler | null {
  return installedSky;
}

/** counts the changes of the installed sky: part of the surface material cache key while the environment term is on */
export function skySamplerEpoch(): number {
  return skyEpoch;
}

/**
 * Karis, "Physically Based Shading on Mobile" (2014), `EnvBRDFApprox`: the split-sum scale and bias as a fit of roughness and
 * N·V, applied to f0.
 */
export function envBrdfApprox(f0: Node<'vec3'>, rough: Node<'float'>, nDotV: Node<'float'>): Node<'vec3'> {
  const r = vec4(-1, -0.0275, -0.572, 0.022).mul(rough).add(vec4(1, 0.0425, 1.04, -0.04));
  const a004 = r.x.mul(r.x).min(nDotV.mul(-9.28).exp2()).mul(r.x).add(r.y);
  const ab = vec2(-1.04, 1.04).mul(a004).add(r.zw);
  return f0.mul(ab.x).add(ab.y);
}

/** The environment node for the given options: the constant `vec3(0)` unless both a scale and a sky exist. */
export function envTermNode(opts: EnvTermOptions): Node<'vec3'> {
  if (opts.envScale === 0 || !Number.isFinite(opts.envScale) || opts.sky === null) return vec3(0);
  const nDotV = normalView.dot(positionViewDirection).clamp(0, 1);
  const f0 = mix(vec3(0.04), diffuseColor.rgb, metalness);
  // view → world: the camera's world matrix rotates a view-space direction into world space
  const reflected = positionViewDirection.negate().reflect(normalView).transformDirection(cameraWorldMatrix);
  const sky = mix(opts.sky.sample(reflected), opts.sky.mean, roughness);
  return envBrdfApprox(f0, roughness, nDotV).mul(sky).mul(float(opts.envScale));
}

/** `lights.environment` for a material built now: the runtime [CAL `envScale`] and the installed sky. */
export function envTerm(): Node<'vec3'> {
  return envTermNode({ envScale: calibration.envScale, sky: installedSky });
}

/**
 * The environment builder of a material created now. three builds a material's lighting model when it first compiles the
 * material, which is later than its creation: the builder holds the [CAL `envScale`] and the sky of this moment, so the
 * material compiles what its cache key says whatever the calibration is by then.
 */
export function envTermSnapshot(): () => Node<'vec3'> {
  const opts: EnvTermOptions = { envScale: calibration.envScale, sky: installedSky };
  return () => envTermNode(opts);
}
