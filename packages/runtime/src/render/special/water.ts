// Water (docs/design/rendering.md §14.2; WP R12b): the `material kind: water` rows and the terrain scene's sea.
//
// A water surface is a plane with the WATER surface variant (`waterVariant()`): two scrolling normal octaves in
// `normalNode` (value noise built from TSL nodes), a Schlick fresnel toward a two-stop sky gradient in `colorNode`, lit
// specular from the light grid (the stage only supplies the perturbed normal and a low roughness; the live
// `scripts/lighting.js` BRDF does the lights), and three's fog. three's reflective water addons (extra scene passes) are
// not used. The look is [I], tuned by eye: every constant below lives in `WaterTuning` with its default in
// `DEFAULT_WATER_TUNING`.
//
// The stage is registered on the place's `SurfaceMaterials` (`registerWaterSurface`); like R3's `registerPackedSurface` it
// must run once per variant cache (a second registration of WATER throws). The scroll clock is the module's `waterTime`
// uniform (seconds); the render loop drives it with `setWaterTime(presentationNowMs)` — or rebinds it to the pausable
// shader time, see the integration note.
//
// §14.2 "(last-lift ×3)": the water draws in the transparent (last) lift, `WATER_RENDER_ORDER` steps above the world base,
// so it blends over the terrain. If the live engine's "×3" names three stacked planes rather than the render-order lift,
// pass `stacks: 3` to `buildWaterMesh`.
import {
  clamp,
  dot,
  float,
  floor,
  fract,
  mix,
  positionView,
  sin,
  pow,
  transformNormalToView,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { BufferAttribute, BufferGeometry, Group, Mesh, Sphere, Vector3 } from 'three/webgpu';
import type { Material, Node } from 'three/webgpu';
import { SurfaceVariant, type SurfaceInputStage, type SurfaceInputs } from '../surface/surface-material.ts';

/** renderOrder of the water in the transparent (last) lift: §14.2 "last-lift ×3" reads as three steps above the world base */
export const WATER_RENDER_ORDER = 3;

export interface WaterOctave {
  /** world frequency of the octave (uv is in metres) */
  scale: number;
  /** scroll direction in xz (unnormalised) */
  dir: [number, number];
  /** scroll speed, metres per second */
  speed: number;
  /** amplitude share of the octave */
  amp: number;
}

export interface WaterTuning {
  /** linear deep-water colour (multiplied by the row's paint tint) */
  deep: [number, number, number];
  /** the sky gradient the fresnel mixes toward, linear */
  skyHorizon: [number, number, number];
  skyZenith: [number, number, number];
  /** Schlick F0 (water ≈ 0.02) */
  f0: number;
  roughness: number;
  /** opacity at normal incidence (looking straight down); grazing incidence is opaque */
  alphaMin: number;
  /** exactly two scrolling octaves (§14.2) */
  octaves: [WaterOctave, WaterOctave];
  /** how strongly the noise gradient tilts the normal */
  normalStrength: number;
}

/** [I] defaults, tuned by eye against the live look (render §14.2) */
export const DEFAULT_WATER_TUNING: WaterTuning = {
  deep: [0.012, 0.061, 0.086],
  skyHorizon: [0.42, 0.52, 0.58],
  skyZenith: [0.09, 0.2, 0.36],
  f0: 0.02,
  roughness: 0.12,
  alphaMin: 0.45,
  octaves: [
    { scale: 0.35, dir: [1, 0.3], speed: 0.06, amp: 1 },
    { scale: 0.9, dir: [-0.6, 1], speed: 0.11, amp: 0.5 },
  ],
  normalStrength: 0.55,
};

/** the variant of a water surface: per-object paint (tint), the WATER inputs, blended */
export function waterVariant(): number {
  return SurfaceVariant.SRC_PRIM | SurfaceVariant.WATER | SurfaceVariant.TRANSPARENT;
}

/** Schlick's approximation: the scalar formula the stage builds as nodes (kept as a pure function for tests). */
export function schlickFresnel(cosTheta: number, f0: number): number {
  const t = 1 - Math.min(1, Math.max(0, cosTheta));
  return f0 + (1 - f0) * t * t * t * t * t;
}

/** the pausable-clock-independent scroll clock, in seconds; `setWaterTime` drives it per frame */
export const waterTime = uniform(0).setName('ssWaterTime');

/** Drives the water scroll clock. Call once per frame with the presentation time. */
export function setWaterTime(presentationNowMs: number): void {
  waterTime.value = presentationNowMs / 1000;
}

/** `fract(sin(dot(p, (127.1, 311.7))) · 43758.5453123)`: the hash of one lattice point, TSL only. */
function vhash(p: Node<'vec2'>): Node<'float'> {
  return fract(sin(dot(p, vec2(127.1, 311.7))).mul(43758.5453123));
}

/** value noise in [0, 1]: bilinear interpolation of lattice hashes with a smoothstep remap. */
function vnoise(p: Node<'vec2'>): Node<'float'> {
  const i: Node<'vec2'> = floor(p);
  const f: Node<'vec2'> = fract(p);
  const u: Node<'vec2'> = f.mul(f).mul(f.mul(-2).add(3));
  const a: Node<'float'> = vhash(i);
  const b: Node<'float'> = vhash(i.add(vec2(1, 0)));
  const c: Node<'float'> = vhash(i.add(vec2(0, 1)));
  const d: Node<'float'> = vhash(i.add(vec2(1, 1)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

/** the WATER input stage: two scrolling normal octaves, Schlick fresnel toward the sky gradient. */
export function waterStage(tuning: WaterTuning = DEFAULT_WATER_TUNING): SurfaceInputStage {
  if (tuning.octaves.length !== 2) throw new RangeError(`water stage: two octaves, got ${tuning.octaves.length}`);
  return (inputs: SurfaceInputs): SurfaceInputs => {
    const t = waterTime;
    // uv is in metres on the water geometry: scale to the octave's frequency and scroll it
    let dx: Node<'float'> = float(0);
    let dz: Node<'float'> = float(0);
    for (const o of tuning.octaves) {
      const p: Node<'vec2'> = uv().mul(o.scale).add(vec2(o.dir[0], o.dir[1]).mul(t.mul(o.speed)));
      const e: Node<'float'> = float(0.6);
      const hx: Node<'float'> = vnoise(p.add(vec2(e, 0))).sub(vnoise(p.sub(vec2(e, 0)))).div(e.mul(2));
      const hz: Node<'float'> = vnoise(p.add(vec2(0, e))).sub(vnoise(p.sub(vec2(0, e)))).div(e.mul(2));
      dx = dx.add(hx.mul(o.amp));
      dz = dz.add(hz.mul(o.amp));
    }
    // the perturbed normal in the mesh's local frame (the mesh is built axis-aligned, so local == world xz)
    const nLocal: Node<'vec3'> = vec3(dx.mul(-tuning.normalStrength), float(1), dz.mul(-tuning.normalStrength)).normalize();
    const nView: Node<'vec3'> = transformNormalToView(nLocal).normalize();
    // Schlick fresnel from the view-space normal and the view direction
    const vDir: Node<'vec3'> = positionView.mul(-1).normalize();
    const cosT: Node<'float'> = clamp(nView.dot(vDir), float(0), float(1));
    const fres: Node<'float'> = float(tuning.f0).add(float(1 - tuning.f0).mul(pow(float(1).sub(cosT), float(5))));
    // the sky gradient, sampled by the reflected ray's elevation: reflect(v, n) = v − 2·dot(n, v)·n
    const incident: Node<'vec3'> = vDir.mul(-1);
    const r: Node<'vec3'> = incident.sub(nView.mul(nView.dot(incident).mul(2))).normalize();
    const sky: Node<'vec3'> = mix(vec3(tuning.skyHorizon[0], tuning.skyHorizon[1], tuning.skyHorizon[2]), vec3(tuning.skyZenith[0], tuning.skyZenith[1], tuning.skyZenith[2]), clamp(r.y, float(0), float(1)));
    const deep: Node<'vec3'> = vec3(tuning.deep[0], tuning.deep[1], tuning.deep[2]).mul(inputs.color);
    return {
      ...inputs,
      color: mix(deep, sky, fres),
      normal: nView,
      roughness: float(tuning.roughness),
      metalness: float(0),
      opacity: mix(float(tuning.alphaMin), float(1), fres),
    };
  };
}

/** the variant-cache surface the water package needs (a structural view of `SurfaceMaterials`) */
export interface WaterSurfaceHost {
  registerStage(bit: number, stage: SurfaceInputStage): void;
}

/**
 * Registers the WATER stage on a variant cache. Once per `SurfaceMaterials`, before the first `get` of a WATER variant —
 * the same once-per-place rule as R3's `registerPackedSurface`.
 */
export function registerWaterSurface(materials: WaterSurfaceHost, tuning: WaterTuning = DEFAULT_WATER_TUNING): { variant: number; setTime: typeof setWaterTime } {
  materials.registerStage(SurfaceVariant.WATER, waterStage(tuning));
  return { variant: waterVariant(), setTime: setWaterTime };
}

export interface WaterMeshOptions {
  /** metres */
  width: number;
  /** metres */
  depth: number;
  /** world y of the plane (the terrain scene's sea: `marks.sea` level 0) */
  y?: number;
  /** the resolved WATER material (from the place's variant cache) */
  material: Material;
  /** renderOrder; default `WATER_RENDER_ORDER` */
  renderOrder?: number;
  /** stacked planes at 2 cm steps for the "×3" reading of §14.2; default 1 */
  stacks?: number;
}

export interface WaterMesh {
  group: Group;
  meshes: Mesh[];
  dispose(): void;
}

/**
 * Builds the water plane(s): an axis-aligned XZ grid (uv in metres, no normal attribute — the stage supplies the normal),
 * so the mesh's local frame is the world frame and `transformNormalToView` in the stage is exact.
 */
export function buildWaterMesh(opts: WaterMeshOptions): WaterMesh {
  const { width, depth } = opts;
  if (!(width > 0 && depth > 0)) throw new RangeError(`buildWaterMesh: width ${width}, depth ${depth}`);
  const stacks = Math.max(1, Math.floor(opts.stacks ?? 1));
  const hw = width / 2;
  const hd = depth / 2;
  const positions = new Float32Array([-hw, 0, -hd, hw, 0, -hd, -hw, 0, hd, hw, 0, hd]);
  const uvs = new Float32Array([-hw, -hd, hw, -hd, -hw, hd, hw, hd]);
  const index = new Uint16Array([0, 2, 1, 1, 2, 3]);
  const group = new Group();
  group.name = 'ss:water';
  const meshes: Mesh[] = [];
  const radius = Math.hypot(hw, hd);
  for (let s = 0; s < stacks; s++) {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(positions.slice(), 3));
    g.setAttribute('uv', new BufferAttribute(uvs.slice(), 2));
    g.setIndex(new BufferAttribute(index.slice(), 1));
    g.boundingSphere = new Sphere(new Vector3(0, 0, 0), radius);
    const mesh = new Mesh(g, opts.material);
    mesh.name = stacks === 1 ? 'ss:water:plane' : `ss:water:plane:${s}`;
    mesh.position.y = (opts.y ?? 0) + s * 0.02;
    mesh.renderOrder = opts.renderOrder ?? WATER_RENDER_ORDER;
    // the stage writes no depth for the transparent lift is the material's state (depthWrite false at `get`); the mesh
    // itself only needs to not cast: water never casts a shadowCaster shadow
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    group.add(mesh);
    meshes.push(mesh);
  }
  return {
    group,
    meshes,
    dispose(): void {
      for (const m of meshes) m.geometry.dispose();
      group.clear();
    },
  };
}
