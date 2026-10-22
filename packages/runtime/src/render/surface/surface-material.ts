// SurfaceMaterial (docs/design/rendering.md §7; D2; WP R1a): the one lit material of the port. It is a
// `MeshStandardNodeMaterial`, so skinning, instancing, batching, the shadowCaster shadow, emissive, fog, alpha and `side` stay
// three's; only the lighting model is ours: `ScriptLightingModel`, which runs the live `scripts/lighting.js` as the BRDF.
//
// Fragment order (§7.3):
//   inputs   colour, opacity, emissive, roughness, metalness (+ normal, position, vertex) from the variant's input stages
//   three    diffuseColor = colorNode; roughness = getRoughness(roughnessNode) [CAL roughnessAA]; metalness = metalnessNode
//   lights   ScriptLightingModel: directDiffuse := lighting(surface, lights)
//   out      directDiffuse + emissive (three adds emissive after lighting), then three's fog; no tone map (linear HDR target)
//
// Variants (§7.2). A material is built per `SurfaceVariant` bitset and cached by it (`SurfaceMaterials`). Anything structural
// (a texture present or not, `transparent`, `side`, `flatShading`, a new node) is a bit and so a new program; uniform values and
// which texture object is bound are not. Two things three keys programs on are deliberately not bits: the object kind (mesh,
// skinned, instanced, batched: three's own vertex paths) and `receiveShadow` (per object). The light-tier caps are not a
// variant either (the light loops are data-bounded, §8.2). The bone-count class is R6's dimension (`shader-variants.ts`).
//
// Inputs come from stages. R1a builds the ones it can exercise:
//   SRC_PRIM      per-object uniform paint: `setSurfacePaint(object, …)` writes `object.userData.ssPaint`; the material's
//                 uniforms read it before each draw (`onObjectUpdate`), so every object of a variant shares one material.
//                 Packed geometry whose row material is the look (a texture set, or a flat preset: ROW_PAINT) starts from
//                 the same paint (`variantPaintSource`, §7.4)
//   TEX_ALBEDO    colour × albedo texture (the linear tint multiplies the texel, `geometry.md`)
//   TEX_ORM       roughness × G, metalness × B (glTF packing; the kit ORM carries no AO)
//   TEX_NORMAL    `normalNode` from a tangent-space map, OpenGL convention; three derives the frame from screen derivatives
//                 when the geometry has no tangents
//   UV_TILE       uv × the object's `uvScale`
//   TRANSPARENT, UNLIT, SIDE_BACK, SIDE_DOUBLE, NORMALS, ROW_PAINT
// The other bits belong to later packages, which register a stage for them (`SurfaceMaterials.registerStage`): SRC_PACKED
// (R3: packed position + paint table), SRC_GLTF and SLOTS / PARTMASK / TEX_SLOTS_n (R6: `ss` attribute, look table), VIEWMODEL
// (R8), DECAL (R10), SPLAT6 / WATER / TRIPLANAR (R12b), ALPHA_TEST (reserved, none live). Asking for a bit with no stage throws.
import {
  diffuseColor,
  diffuseContribution,
  dot,
  float,
  fract,
  materialMetalness,
  materialRoughness,
  metalness,
  mix,
  normalMap,
  normalWorld,
  positionLocal,
  roughness,
  sin,
  smoothstep,
  texture,
  uniform,
  uv,
  vec3,
} from 'three/tsl';
import { BackSide, DoubleSide, FrontSide, MeshBasicNodeMaterial, MeshStandardNodeMaterial, Vector2, Vector3 } from 'three/webgpu';
import type { Node, NodeBuilder, Object3D, PhysicalLightingModel, Side, Texture } from 'three/webgpu';
import { calibration, type RoughnessAA, type WetModifier } from '../calibration.ts';
import type { Linear3 } from '../color/color.ts';
import { envTermSnapshot, skySamplerEpoch } from './env-term.ts';
import { ScriptLightingModel } from './script-lighting-model.ts';
import type { LightingScript } from './script-types.ts';

// ── the variant bitset ──────────────────────────────────────────────────────────────────────────────────────────────────

/** render §7.2. The numbering is the contract of `shader-variants.ts` (R6): later packages add stages, never renumber. */
export const SurfaceVariant = {
  /** the D5 packed position and paint id (scripted geometry); flat shaded unless NORMALS */
  SRC_PACKED: 1 << 0,
  /** float position/normal (+uv) from a glTF primitive; the `ss` attribute into the per-model paint table */
  SRC_GLTF: 1 << 1,
  /** unit primitive geometry with per-object (or instanced) paint */
  SRC_PRIM: 1 << 2,
  /** interpolated vertex normals on packed geometry (smooth scripted pieces): no flat shading */
  NORMALS: 1 << 3,
  TEX_ALBEDO: 1 << 4,
  TEX_NORMAL: 1 << 5,
  TEX_ORM: 1 << 6,
  TRIPLANAR: 1 << 7,
  UV_TILE: 1 << 8,
  /** slot textures of a model template: a 2-bit count, 1 to 3 (`texSlotCount`) */
  TEX_SLOTS_1: 1 << 9,
  TEX_SLOTS_2: 2 << 9,
  TEX_SLOTS_3: 3 << 9,
  /** look-table slot overrides (§7.6) */
  SLOTS: 1 << 11,
  /** look-table part mask (§7.6) */
  PARTMASK: 1 << 12,
  /** blend pass: alpha < 1 paints, `opacity`, `transparent` */
  TRANSPARENT: 1 << 13,
  /** cutout (none live; reserved) */
  ALPHA_TEST: 1 << 14,
  /** the §4.3 `vertexNode` projection and depth remap */
  VIEWMODEL: 1 << 15,
  /** §12 ring batches */
  DECAL: 1 << 16,
  /** the terrain scene terrain (§14.3) */
  SPLAT6: 1 << 17,
  /** water (§14.2) */
  WATER: 1 << 18,
  /** `unlit: true`: a `MeshBasicNodeMaterial` with the same inputs (albedo + emissive, fogged) */
  UNLIT: 1 << 19,
  /** `side: "back"` */
  SIDE_BACK: 1 << 20,
  /** `side: "double"` */
  SIDE_DOUBLE: 1 << 21,
  /**
   * packed geometry whose row carries a flat (textureless) material: the per-object paint is the look, not the paint table.
   * The live case is the kit's flat presets (`scripts/lib/mat/index.js` `flat`/`emit`/glass): in kit mode the generator
   * paints nothing and "the row's MaterialSpec paints the zone" (authored content `paint`)
   */
  ROW_PAINT: 1 << 22,
} as const;

export type SurfaceVariantName = keyof typeof SurfaceVariant;

const V = SurfaceVariant;
export const SURFACE_SRC_MASK: number = V.SRC_PACKED | V.SRC_GLTF | V.SRC_PRIM;
export const SURFACE_TEX_SLOTS_MASK: number = V.TEX_SLOTS_3;
/** every bit that has a meaning */
export const SURFACE_VARIANT_MASK: number = Object.values(V).reduce((m, b) => m | b, 0);

/** number of slot textures a variant carries (0 to 3) */
export function texSlotCount(variant: number): number {
  return (variant & SURFACE_TEX_SLOTS_MASK) >>> 9;
}

/** `SRC_PRIM|TRANSPARENT|…`, for messages and the variant enumeration */
export function describeVariant(variant: number): string {
  const names: string[] = [];
  for (const [name, bit] of Object.entries(V)) {
    if (name.startsWith('TEX_SLOTS_')) continue;
    if ((variant & bit) !== 0) names.push(name);
  }
  const slots = texSlotCount(variant);
  if (slots > 0) names.push(`TEX_SLOTS_${slots}`);
  return names.join('|') || '0';
}

/** packed geometry without vertex normals is flat shaded: three takes the normal from `positionView` derivatives */
export function variantIsFlatShaded(variant: number): boolean {
  return (variant & V.SRC_PACKED) !== 0 && (variant & V.NORMALS) === 0;
}

export function variantSide(variant: number): Side {
  return (variant & V.SIDE_DOUBLE) !== 0 ? DoubleSide : (variant & V.SIDE_BACK) !== 0 ? BackSide : FrontSide;
}

/**
 * Where a variant's albedo, emissive, roughness and metalness start from (render §7.4):
 *   'object'  the per-object paint (`setSurfacePaint`): primitive rows, and packed geometry whose row material is the look
 *             (the range kit): a texture set (TEX_ALBEDO) or a flat preset (ROW_PAINT) replaces the generator's paints
 *   'source'  the geometry's own data, read by its source stage: the paint table of packed geometry (R3), the per-model
 *             table of a glTF (R6)
 */
export function variantPaintSource(variant: number): 'object' | 'source' {
  if ((variant & V.SRC_PRIM) !== 0) return 'object';
  return (variant & V.SRC_PACKED) !== 0 && (variant & (V.TEX_ALBEDO | V.ROW_PAINT)) !== 0 ? 'object' : 'source';
}

function assertVariant(variant: number): void {
  if (!Number.isInteger(variant) || variant < 0 || (variant & ~SURFACE_VARIANT_MASK) !== 0) {
    throw new RangeError(`surface variant ${variant}: unknown bits`);
  }
  const src = variant & SURFACE_SRC_MASK;
  if (src === 0 || (src & (src - 1)) !== 0) throw new RangeError(`surface variant ${describeVariant(variant)}: exactly one SRC_* bit is required`);
  if ((variant & V.SIDE_BACK) !== 0 && (variant & V.SIDE_DOUBLE) !== 0) throw new RangeError(`surface variant ${describeVariant(variant)}: SIDE_BACK and SIDE_DOUBLE exclude each other`);
  if ((variant & V.NORMALS) !== 0 && (variant & V.SRC_PACKED) === 0) throw new RangeError(`surface variant ${describeVariant(variant)}: NORMALS qualifies SRC_PACKED (glTF and primitive geometry always carry normals)`);
  if ((variant & V.ROW_PAINT) !== 0 && (variant & V.SRC_PACKED) === 0) throw new RangeError(`surface variant ${describeVariant(variant)}: ROW_PAINT qualifies SRC_PACKED (a primitive always reads the object paint; a glTF's paint is its model's)`);
}

// ── per-object paint ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The values a `SRC_PRIM` surface reads per object. All colours are linear; nothing here is clamped. */
export interface SurfacePaint {
  color: Linear3;
  /** used by TRANSPARENT variants only */
  opacity: number;
  /** linear, already × `emissiveIntensity`; HDR allowed */
  emissive: Linear3;
  roughness: number;
  metalness: number;
  /** UV_TILE: uv multiplier */
  uvScale: [number, number];
  /** TEX_ORM: whether G scales the roughness and B the metalness (a preset may map only one of them) */
  ormRoughness: boolean;
  ormMetalness: boolean;
  /** K13: DISSOLVE variants only; 0 (absent) solid to 1 gone */
  dissolve?: number;
}

/** three's `MeshStandardMaterial` defaults: white, opaque, no emissive, roughness 1, metalness 0 */
export function defaultSurfacePaint(): SurfacePaint {
  return { color: [1, 1, 1], opacity: 1, emissive: [0, 0, 0], roughness: 1, metalness: 0, uvScale: [1, 1], ormRoughness: true, ormMetalness: true };
}

const PAINT_KEY = 'ssPaint';
const NO_PAINT: Readonly<SurfacePaint> = Object.freeze(defaultSurfacePaint());

/** The paint of an object, or the defaults when it has none. */
export function surfacePaintOf(object: Object3D | null | undefined): Readonly<SurfacePaint> {
  const p = object?.userData[PAINT_KEY] as SurfacePaint | undefined;
  return p ?? NO_PAINT;
}

/**
 * Writes (merges) the paint of an object. Values are uniforms: changing them never creates a material or a program, and the
 * next draw of the object picks them up.
 */
export function setSurfacePaint(object: Object3D, paint: Partial<SurfacePaint>): SurfacePaint {
  const current = (object.userData[PAINT_KEY] as SurfacePaint | undefined) ?? defaultSurfacePaint();
  const next: SurfacePaint = { ...current, ...paint };
  object.userData[PAINT_KEY] = next;
  return next;
}

/** `atmosphere.wet` (0 to 1) for the `'surface'` wet modifier; the atmosphere package writes `.value` (render §7.5) */
export const surfaceWet = uniform(0).setName('ssWet');

// ── input stages ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What a variant feeds three's material slots. A stage returns a new object with the nodes it changed. */
export interface SurfaceInputs {
  /** linear albedo → `colorNode` */
  color: Node<'vec3'>;
  /** → `opacityNode` (TRANSPARENT variants) */
  opacity: Node<'float'>;
  /** → `emissiveNode` */
  emissive: Node<'vec3'>;
  /** → `roughnessNode` */
  roughness: Node<'float'>;
  /** → `metalnessNode` */
  metalness: Node<'float'>;
  /** texture coordinates the texture stages sample with */
  uv: Node<'vec2'>;
  /** → `normalNode`; null = three's normal (`normalView`, or `normalFlat` when flat shaded) */
  normal: Node | null;
  /** → `positionNode` (local space, applied after skinning); null = the geometry's */
  position: Node | null;
  /** → `vertexNode` (clip space); null = three's projection */
  vertex: Node | null;
  /**
   * → the material's own projection (`setupModelViewProjection`): the clip-space position in place of three's
   * `cameraProjectionMatrix · positionView`; absent or null = three's projection. Unlike `vertex` it leaves
   * `material.vertexNode` null, which matters to anything lit or fogged: once a material has a `vertexNode`, three r186
   * no longer interpolates the view position but rebuilds it in the fragment stage from the clip position with the
   * camera's inverse projection (`three/src/nodes/accessors/Position.js` `positionView`), so a projection that is not the
   * camera's (the viewmodel's, WP R8) would be lit and fogged at a position it is not at.
   */
  clip?: Node | null;
}

/** textures a variant binds; which object is bound is not part of the program */
export interface SurfaceTextures {
  /** TEX_ALBEDO: sRGB (`colorSpace = SRGBColorSpace`, set by the texture cache) */
  albedo?: Texture;
  /** TEX_NORMAL: tangent space, OpenGL convention, linear */
  normal?: Texture;
  /** TEX_ORM: G = roughness, B = metalness, linear */
  orm?: Texture;
  /** TEX_SLOTS_n: the model template's texture sets, n entries in slot-set order (R6, `surface/look-table.ts`) */
  slots?: readonly SurfaceSlotTextures[];
}

/** one texture set of a model template (R6): the maps a glTF material samples together */
export interface SurfaceSlotTextures {
  /** sRGB */
  albedo: Texture;
  /** tangent space, OpenGL convention, linear */
  normal?: Texture;
  /** G = roughness, B = metalness, linear */
  orm?: Texture;
}

export interface SurfaceStageContext {
  readonly variant: number;
  readonly textures: SurfaceTextures;
  /**
   * `variantPaintSource(variant)`. Under `'object'` the inputs a source stage receives are the object's paint uniforms and
   * the stage keeps colour, emissive, roughness and metalness (it still supplies position, uv and normal); under `'source'`
   * they are neutral constants for the stage to replace with its own reads.
   */
  readonly paint: 'object' | 'source';
}

export type SurfaceInputStage = (inputs: SurfaceInputs, ctx: SurfaceStageContext) => SurfaceInputs;

/** bits whose inputs R1a builds itself; every other bit needs a registered stage */
const BUILT_IN: number = V.SRC_PRIM | V.NORMALS | V.TEX_ALBEDO | V.TEX_NORMAL | V.TEX_ORM | V.UV_TILE | V.TRANSPARENT | V.UNLIT | V.SIDE_BACK | V.SIDE_DOUBLE | V.ROW_PAINT;

/** stage slots in the order they run: the source first, then textures and look-table reads, then the special surfaces */
const STAGE_ORDER: readonly number[] = [
  V.SRC_PACKED,
  V.SRC_GLTF,
  V.TRIPLANAR,
  SURFACE_TEX_SLOTS_MASK,
  V.SLOTS,
  V.PARTMASK,
  V.ALPHA_TEST,
  V.DECAL,
  V.SPLAT6,
  V.WATER,
  V.VIEWMODEL,
];

/** K13: the fragment stays where the noise reaches the object's dissolve value; 0 keeps everything (noise ≥ 0), 1 nothing (noise < 1) */
function dissolveKeep(): Node<'bool'> {
  const amount = uniform(0).onObjectUpdate(({ object }) => surfacePaintOf(object).dissolve ?? 0);
  const noise = fract(sin(dot(positionLocal.mul(24), vec3(12.9898, 78.233, 37.719))).mul(43758.5453));
  return noise.greaterThanEqual(amount);
}

/** the per-object uniform paint of SRC_PRIM */
function uniformPaintInputs(): SurfaceInputs {
  const vec = (pick: (p: Readonly<SurfacePaint>) => Linear3) =>
    uniform(new Vector3()).onObjectUpdate(({ object }, self) => {
      const c = pick(surfacePaintOf(object));
      self.value.set(c[0], c[1], c[2]);
    });
  const num = (pick: (p: Readonly<SurfacePaint>) => number) => uniform(0).onObjectUpdate(({ object }) => pick(surfacePaintOf(object)));
  return {
    color: vec((p) => p.color),
    opacity: num((p) => p.opacity),
    emissive: vec((p) => p.emissive),
    roughness: num((p) => p.roughness),
    metalness: num((p) => p.metalness),
    uv: uv(),
    normal: null,
    position: null,
    vertex: null,
  };
}

/** inputs before the source stage of a packed or glTF variant has replaced them: neutral constants */
function neutralInputs(): SurfaceInputs {
  const d = NO_PAINT;
  return {
    color: uniform(new Vector3(d.color[0], d.color[1], d.color[2])),
    opacity: uniform(d.opacity),
    emissive: uniform(new Vector3(0, 0, 0)),
    roughness: uniform(d.roughness),
    metalness: uniform(d.metalness),
    uv: uv(),
    normal: null,
    position: null,
    vertex: null,
  };
}

function requireTexture(textures: SurfaceTextures, slot: 'albedo' | 'normal' | 'orm', variant: number): Texture {
  const t = textures[slot];
  if (t === undefined) throw new Error(`surface variant ${describeVariant(variant)}: no \`${slot}\` texture was given`);
  return t;
}

function textureStages(inputs: SurfaceInputs, ctx: SurfaceStageContext): SurfaceInputs {
  const { variant, textures } = ctx;
  let out = inputs;
  if ((variant & V.UV_TILE) !== 0) {
    const scale = uniform(new Vector2(1, 1)).onObjectUpdate(({ object }, self) => {
      const s = surfacePaintOf(object).uvScale;
      self.value.set(s[0], s[1]);
    });
    out = { ...out, uv: out.uv.mul(scale) };
  }
  if ((variant & V.TEX_ALBEDO) !== 0) {
    // three decodes an sRGB texture to linear when it samples: texel × the linear tint
    out = { ...out, color: out.color.mul(texture(requireTexture(textures, 'albedo', variant), out.uv).rgb) };
  }
  if ((variant & V.TEX_ORM) !== 0) {
    const orm = texture(requireTexture(textures, 'orm', variant), out.uv);
    const use = uniform(new Vector2(1, 1)).onObjectUpdate(({ object }, self) => {
      const p = surfacePaintOf(object);
      self.value.set(p.ormRoughness ? 1 : 0, p.ormMetalness ? 1 : 0);
    });
    out = { ...out, roughness: out.roughness.mul(mix(float(1), orm.g, use.x)), metalness: out.metalness.mul(mix(float(1), orm.b, use.y)) };
  }
  if ((variant & V.TEX_NORMAL) !== 0) {
    out = { ...out, normal: normalMap(texture(requireTexture(textures, 'normal', variant), out.uv)) };
  }
  return out;
}

/**
 * The `'surface'` wet modifier (render §7.5, an addition; off by default): `w = wet · smoothstep(lo, hi, N.y)` with N in world
 * space, `roughness = mix(rough, rough · 0.45, w)`, `albedo *= mix(1, 0.78, w)`; emissive paints are exempt.
 */
function wetStage(inputs: SurfaceInputs): SurfaceInputs {
  const k = calibration.wet;
  // The exemption is arithmetic, not a `select`: three emits what a conditional branch is the first to use inside that
  // branch, so the world normal first computed in the "not emissive" branch was unset on emissive fragments and they lost
  // their direct light [M: the variant read-back of tests/e2e/render-r1a.spec.ts].
  const emits = inputs.emissive.x.max(inputs.emissive.y).max(inputs.emissive.z).max(0).sign();
  const w = surfaceWet.mul(smoothstep(k.normalYLow, k.normalYHigh, normalWorld.y)).mul(emits.oneMinus());
  return {
    ...inputs,
    roughness: mix(inputs.roughness, inputs.roughness.mul(k.roughnessScale), w),
    color: inputs.color.mul(mix(float(1), float(k.albedoScale), w)),
  };
}

// ── the materials ───────────────────────────────────────────────────────────────────────────────────────────────────────

const objectIds = new WeakMap<object, number>();
let nextObjectId = 1;
/** a small stable number per object: the lighting script and an injected env builder in `variantKey` */
function objectId(o: object): number {
  let id = objectIds.get(o);
  if (id === undefined) {
    id = nextObjectId++;
    objectIds.set(o, id);
  }
  return id;
}

export interface SurfaceMaterialInit {
  variant: number;
  script: LightingScript;
  /** builds `lights.environment`; default: `envTermSnapshot()`, the [CAL `envScale`] and the sky at construction */
  env?: () => Node;
  /** [CAL `roughnessAA`] for this material; default: the runtime calibration at construction */
  roughnessAA?: RoughnessAA;
}

/** the lit surface: a `MeshStandardNodeMaterial` whose BRDF is the live lighting script */
export class SurfaceMaterial extends MeshStandardNodeMaterial {
  readonly isSurfaceMaterial = true;
  /**
   * Part of three's material cache key (`RenderObject.getMaterialCacheKey` reads every own string property): two surface
   * materials that differ only in what this class overrides (the roughness mode, the lighting script, the environment
   * term) must not share a compiled node graph.
   */
  readonly variantKey: string;
  /** `SurfaceInputs.clip`: the clip-space position this material projects with; null = three's projection */
  clipNode: Node | null = null;
  readonly #variant: number;
  readonly #roughnessAA: RoughnessAA;
  readonly #script: LightingScript;
  readonly #env: () => Node;

  constructor(init: SurfaceMaterialInit) {
    super();
    assertVariant(init.variant);
    if ((init.variant & V.UNLIT) !== 0) throw new RangeError('SurfaceMaterial is the lit material; UNLIT variants are UnlitSurfaceMaterial');
    this.#variant = init.variant;
    this.#roughnessAA = init.roughnessAA ?? calibration.roughnessAA;
    this.#script = init.script;
    // three builds the lighting model at the first compile, not here: the default holds this moment's calibration and sky
    this.#env = init.env ?? envTermSnapshot();
    const env = init.env !== undefined ? `f${objectId(init.env)}` : calibration.envScale === 0 ? '0' : `${calibration.envScale}/${skySamplerEpoch()}`;
    this.variantKey = `surface:${init.variant.toString(36)}:${this.#roughnessAA}:s${objectId(init.script)}:e${env}`;
    this.name = `ss:surface:${describeVariant(init.variant)}`;
    this.flatShading = variantIsFlatShaded(init.variant);
    this.side = variantSide(init.variant);
    this.transparent = (init.variant & V.TRANSPARENT) !== 0;
  }

  /** the `SurfaceVariant` bits this material was built for */
  get variant(): number {
    return this.#variant;
  }

  get roughnessAA(): RoughnessAA {
    return this.#roughnessAA;
  }

  /** three's projection hook (the one its sprite materials use): `clipNode` when the variant has one */
  override setupModelViewProjection(): Node {
    return this.clipNode ?? super.setupModelViewProjection();
  }

  /**
   * A new model per build: it holds that build's graph. @types/three narrows the return type of the standard material to its
   * own `PhysicalLightingModel`; three itself only calls the `LightingModel` interface on it.
   */
  override setupLightingModel(): PhysicalLightingModel {
    return new ScriptLightingModel(this.#script, this.#env) as unknown as PhysicalLightingModel;
  }

  /**
   * [CAL `roughnessAA`]. `'three'`: three's own, which passes the roughness through `getRoughness` (clamped to ≥ 0.0525, plus
   * geometric specular anti-aliasing from the normal's screen derivatives) before the script sees it. `'raw'`: the same
   * assignments with the roughness as given.
   */
  override setupVariants(builder: NodeBuilder): void {
    if (this.#roughnessAA === 'three') {
      super.setupVariants(builder);
      return;
    }
    const metalnessNode = this.metalnessNode !== null ? float(this.metalnessNode as Node<'float'>) : materialMetalness;
    metalness.assign(metalnessNode);
    const roughnessNode = this.roughnessNode !== null ? float(this.roughnessNode as Node<'float'>) : materialRoughness;
    roughness.assign(roughnessNode);
    // as three's setupVariants: its own nodes (environment, transmission) read these two
    this.setupSpecular();
    diffuseContribution.assign(diffuseColor.rgb.mul(metalnessNode.oneMinus()));
  }
}

/** `unlit: true`: albedo + emissive, no lights, still fogged */
export class UnlitSurfaceMaterial extends MeshBasicNodeMaterial {
  readonly isSurfaceMaterial = true;
  readonly variantKey: string;
  /** `SurfaceInputs.clip`: the clip-space position this material projects with; null = three's projection */
  clipNode: Node | null = null;
  readonly #variant: number;

  constructor(variant: number) {
    super();
    assertVariant(variant);
    this.#variant = variant;
    this.variantKey = `unlit:${variant.toString(36)}`;
    this.name = `ss:surface:${describeVariant(variant)}`;
    this.lights = false;
    this.side = variantSide(variant);
    this.transparent = (variant & V.TRANSPARENT) !== 0;
  }

  get variant(): number {
    return this.#variant;
  }

  override setupModelViewProjection(): Node {
    return this.clipNode ?? super.setupModelViewProjection();
  }
}

export type AnySurfaceMaterial = SurfaceMaterial | UnlitSurfaceMaterial;

/** material state that is not part of the program: one material instance per distinct combination */
export interface SurfaceState {
  /** default true */
  depthWrite?: boolean;
  /** default true */
  depthTest?: boolean;
  /** default false */
  polygonOffset?: boolean;
  polygonOffsetFactor?: number;
  polygonOffsetUnits?: number;
  /**
   * K13 `material.dissolve`: the fragment is cut where a fixed noise of the local position is below the object's `dissolve` paint
   * (0 solid, 1 nothing), in the colour pass and the shadow pass alike. The amount is a per-object uniform, so the value costs no
   * clone and no program; the switch is state (not a variant bit: the bit numbering is fixed) and default false.
   */
  dissolve?: boolean;
}

export interface SurfaceKey {
  variant: number;
  textures?: SurfaceTextures;
  state?: SurfaceState;
}

export interface SurfaceMaterialsOptions {
  /**
   * The lighting module (`scripts/lighting.js` through the registry). Null when it failed to load in a production build
   * (logged by the loader): every variant is then built unlit.
   */
  script: LightingScript | null;
  /** builds `lights.environment`; default: `envTermSnapshot()` per material, the [CAL `envScale`] and the sky when it is created */
  env?: () => Node;
}

function stateKey(s: SurfaceState | undefined): string {
  const dw = s?.depthWrite ?? true;
  const dt = s?.depthTest ?? true;
  const po = s?.polygonOffset ?? false;
  return `${dw ? 1 : 0}${dt ? 1 : 0}${po ? `p${s?.polygonOffsetFactor ?? 0}/${s?.polygonOffsetUnits ?? 0}` : ''}${s?.dissolve === true ? 'd' : ''}`;
}

/**
 * The variant cache (render §7.2): one material per (variant bitset, bound textures, non-program state) under the calibration
 * that was current when it was built. Per-object values go through `setSurfacePaint` and never reach this cache.
 */
export class SurfaceMaterials {
  readonly #script: LightingScript | null;
  /** null = each material takes `envTermSnapshot()` when it is created */
  readonly #env: (() => Node) | null;
  readonly #cache = new Map<string, AnySurfaceMaterial>();
  readonly #stages = new Map<number, SurfaceInputStage>();

  constructor(opts: SurfaceMaterialsOptions) {
    this.#script = opts.script;
    this.#env = opts.env ?? null;
  }

  /** materials built so far */
  get size(): number {
    return this.#cache.size;
  }

  /**
   * Registers the input stage of a bit R1a does not build (see the header). `bit` is one `SurfaceVariant` value, or
   * `SURFACE_TEX_SLOTS_MASK` for the slot-texture count. Must happen before the first `get` of a variant with that bit.
   */
  registerStage(bit: number, stage: SurfaceInputStage): void {
    if (!STAGE_ORDER.includes(bit)) throw new RangeError(`surface stage: ${describeVariant(bit)} is not a stage slot`);
    if (this.#stages.has(bit)) throw new Error(`surface stage: ${describeVariant(bit)} is already registered`);
    this.#stages.set(bit, stage);
  }

  /** The material for a key, created on first use. The same key always returns the same instance. */
  get(key: SurfaceKey): AnySurfaceMaterial {
    assertVariant(key.variant);
    // with no lighting script every surface is unlit (the production fallback)
    const variant = this.#script === null ? key.variant | V.UNLIT : key.variant;
    const tex = key.textures ?? {};
    const lit = (variant & V.UNLIT) === 0;
    // the scale is a constant of the env graph, so its value is part of the key, not only whether it is on
    const w = calibration.wet;
    const wet = calibration.wetModifier === 'surface' ? `wet${w.roughnessScale}/${w.albedoScale}/${w.normalYLow}/${w.normalYHigh}` : 'dry';
    // an injected env builder is the caller's; the default one samples the installed sky while the term is on
    const env = !lit || this.#env !== null || calibration.envScale === 0 ? '-' : `env${calibration.envScale}/${skySamplerEpoch()}`;
    const cal = `${lit ? calibration.roughnessAA : '-'}:${wet}:${env}`;
    const slots = (tex.slots ?? []).map((s) => `${s.albedo.uuid}/${s.normal?.uuid ?? ''}/${s.orm?.uuid ?? ''}`).join(',');
    const id = `${variant}|${stateKey(key.state)}|${tex.albedo?.uuid ?? ''}|${tex.normal?.uuid ?? ''}|${tex.orm?.uuid ?? ''}|${slots}|${cal}`;
    let material = this.#cache.get(id);
    if (material === undefined) {
      material = this.#build(variant, tex, key.state, calibration.wetModifier);
      this.#cache.set(id, material);
    }
    return material;
  }

  #inputs(variant: number, textures: SurfaceTextures, wet: WetModifier): SurfaceInputs {
    const paint = variantPaintSource(variant);
    const ctx: SurfaceStageContext = { variant, textures, paint };
    let inputs = paint === 'object' ? uniformPaintInputs() : neutralInputs();
    const run = (bit: number): void => {
      if ((variant & bit) === 0) return;
      const stage = this.#stages.get(bit);
      if (stage === undefined) {
        const name = bit === SURFACE_TEX_SLOTS_MASK ? 'TEX_SLOTS_n' : describeVariant(bit);
        throw new Error(`surface variant ${describeVariant(variant)}: no input stage is registered for ${name} (its work package registers it with SurfaceMaterials.registerStage)`);
      }
      inputs = stage(inputs, ctx);
    };
    // the source stage, then the built-in texture inputs, then the look-table and special stages
    run(V.SRC_PACKED);
    run(V.SRC_GLTF);
    inputs = textureStages(inputs, ctx);
    for (const bit of STAGE_ORDER) if (bit !== V.SRC_PACKED && bit !== V.SRC_GLTF) run(bit);
    if (wet === 'surface') inputs = wetStage(inputs);
    return inputs;
  }

  #build(variant: number, textures: SurfaceTextures, state: SurfaceState | undefined, wet: WetModifier): AnySurfaceMaterial {
    const unknown = variant & ~BUILT_IN & ~STAGE_ORDER.reduce((m, b) => m | b, 0);
    if (unknown !== 0) throw new Error(`surface variant ${describeVariant(variant)}: ${describeVariant(unknown)} has no builder`);
    const inputs = this.#inputs(variant, textures, wet);
    let material: AnySurfaceMaterial;
    if ((variant & V.UNLIT) !== 0 || this.#script === null) {
      const m = new UnlitSurfaceMaterial(variant);
      m.colorNode = inputs.color.add(inputs.emissive);
      material = m;
    } else {
      const m = new SurfaceMaterial(this.#env === null ? { variant, script: this.#script } : { variant, script: this.#script, env: this.#env });
      m.colorNode = inputs.color;
      m.emissiveNode = inputs.emissive;
      m.roughnessNode = inputs.roughness;
      m.metalnessNode = inputs.metalness;
      material = m;
    }
    if ((variant & V.TRANSPARENT) !== 0) material.opacityNode = inputs.opacity;
    if (state?.dissolve === true) {
      // three's NodeMaterial discards where `maskNode` is false, and the shadow depth pass reads the same node
      material.maskNode = dissolveKeep();
    }
    if (inputs.normal !== null) material.normalNode = inputs.normal;
    if (inputs.position !== null) material.positionNode = inputs.position;
    if (inputs.vertex !== null) material.vertexNode = inputs.vertex;
    if (inputs.clip !== undefined && inputs.clip !== null) material.clipNode = inputs.clip;
    material.depthWrite = state?.depthWrite ?? true;
    material.depthTest = state?.depthTest ?? true;
    material.polygonOffset = state?.polygonOffset ?? false;
    material.polygonOffsetFactor = state?.polygonOffsetFactor ?? 0;
    material.polygonOffsetUnits = state?.polygonOffsetUnits ?? 0;
    return material;
  }

  /** disposes every material (their programs go with them); the textures are the texture cache's */
  dispose(): void {
    for (const m of this.#cache.values()) m.dispose();
    this.#cache.clear();
  }
}
