// Row `material` → surface parameters (docs/design/rendering.md §7.4; `spawn-engine-contract.md` §9.4; WP R1a).
//
// A `StandardMaterialSpec` is plain data on a row. This module turns it into what the surface material needs, as plain data
// again (no three object is created here): the structural variant bits, the per-object paint (uniform values), the texture
// references to resolve, the non-program material state and the mesh's `renderOrder`.
//
//   colour      `color` → linear (`color.ts`); with a `texture` it tints the texel (multiplies by the linear value)
//   `texture`   a CDN name, or a texture script's tree path (X-47: `scripts/tex-beam.js`, `isTextureScriptPath`): the name is
//               the reference either way; the texture for a script path is made by RH1's runner (`surface/texture-script.ts`)
//               instead of a file load, so the variant bits, the bucket key and the program are those of any albedo texture
//   emissive    `emissive` × `emissiveIntensity`, linear (three's `MeshStandardMaterial` convention)
//   PBR         `roughness`, `metalness`; `roughnessMap` (G) and `metalnessMap` (B) are one ORM image, glTF packing; OpenGL
//               normal maps. Defaults are three's: roughness 1, metalness 0
//   `unlit`     the UNLIT variant: albedo + emissive, no lights, still fogged
//   `side`      "double" → `DoubleSide`, "back" → `BackSide`
//   state       `depthWrite`, `depthTest`, `polygonOffset{Factor,Units}` → three material state; `renderOrder` → the mesh
//   `drawsOver` a `renderOrder` above the world: drawn last
//   `pbr`       ignored: it asks Spawn's CDN for derived maps, a lane that is closed (`scripts/lib/mat/index.js:6`)
//   scripted    a row whose geometry is scripted keeps the generator's paints (the poly look): `{pbr: true}`, which is what
//               those rows carry, and any other row material with neither a texture nor a colour change nothing. A row
//               **texture set** (the range/bunker kit presets of `scripts/lib/mat/index.js`: albedo + normal + ORM) replaces
//               the paint albedo with the texture, sampled with the `{uvs}` the generator returned: the row then maps
//               exactly like a primitive row, on packed geometry (`paintSource: 'row'`). So does a **flat preset** of the
//               same kit (`flat`/`emit`/glass: a colour, no texture), with the ROW_PAINT bit: a kit generator run for one
//               zone paints nothing ("the row's MaterialSpec paints the zone", authored content `paint`), so
//               without the row colour its faces would be unpainted white. Live: four rows of `places/training`
//               (`kit/pit.js` part plastic-red / plastic-white, `kit/plate.js` part plastic-white)
//
// The live quirk "a material with only `{ color }` did not draw in the GPU harness" (`AGENTS.md:131`) is not reproduced: the
// port draws it.
import { cssAlpha, cssToLinear, type Linear3 } from '../color/color.ts';
import { SurfaceVariant, defaultSurfacePaint, type SurfacePaint, type SurfaceState } from './surface-material.ts';

/** `spawn-engine-contract.md` §9.4 / `engine/api-reference.md:1182-1213` */
export interface StandardMaterialSpec {
  key?: string;
  texture?: string;
  view?: { link: string; oneWay?: boolean; spill?: number; sound?: number };
  pbr?: boolean | 'fal1';
  normalMap?: string;
  roughnessMap?: string;
  metalnessMap?: string;
  alphaMap?: string;
  color?: string;
  repeat?: [number, number];
  textureScale?: number;
  wrap?: 'repeat' | 'clamp';
  metalness?: number;
  roughness?: number;
  opacity?: number;
  transparent?: boolean;
  emissive?: string;
  emissiveIntensity?: number;
  unlit?: boolean;
  dissolve?: number;
  side?: 'front' | 'back' | 'double';
  depthWrite?: boolean;
  depthTest?: boolean;
  renderOrder?: number;
  drawsOver?: string[] | { parts: string[]; strength?: number; angle?: number };
  outline?: boolean | { color?: string; width?: number; warm?: number; lightness?: number } | null;
  polygonOffset?: boolean;
  polygonOffsetFactor?: number;
  polygonOffsetUnits?: number;
  overrides?: unknown;
}

/** `engine/api-reference.md:1148-1156` */
export interface ScriptedMaterialSpec {
  kind: 'scripted';
  script: string;
  params?: Record<string, number | boolean | string>;
  underwater?: unknown;
  drawsOver?: string[] | { parts: string[]; strength?: number; angle?: number };
  outline?: boolean | { color?: string; width?: number; warm?: number; lightness?: number } | null;
  view?: { link: string; oneWay?: boolean; spill?: number; sound?: number };
}

export type MaterialSpec = StandardMaterialSpec | ScriptedMaterialSpec;

export function isScriptedMaterialSpec(spec: unknown): spec is ScriptedMaterialSpec {
  return spec !== null && typeof spec === 'object' && (spec as { kind?: unknown }).kind === 'scripted' && typeof (spec as { script?: unknown }).script === 'string';
}

/** `renderOrder` of a `drawsOver` material: after every world object (opaques sort by `renderOrder` first), so it is drawn last */
export const DRAWS_OVER_RENDER_ORDER = 1000;

export type SurfaceSource = 'prim' | 'packed' | 'gltf';

/**
 * K13: whether `material.dissolve` is honoured. Off by default (the legacy host lists it as unsupported); a game that uses it turns it on once
 * (`installGame`'s `dissolve` dependency). A row whose material carries a `dissolve` number then gets `state.dissolve` (a material
 * with the cut) and the value as per-object paint, whatever else its material says.
 */
let dissolveSupport = false;
export function setDissolveSupport(on: boolean): void {
  dissolveSupport = on;
}
export const dissolveSupported = (): boolean => dissolveSupport;

/** the three material state of a row; `dissolve` is present (true) only for a row whose `dissolve` is honoured */
export type SurfaceParamsState = Required<Omit<SurfaceState, 'dissolve'>> & { dissolve?: true };

export interface SurfaceParamsOptions {
  /** where the geometry comes from: picks the SRC_* bit. Default `'prim'` (a built-in primitive row). */
  source?: SurfaceSource;
  /** the row's geometry is scripted (`{kind: 'scripted'}`): its paints are the look unless the row material has a texture set or a colour */
  scripted?: boolean;
  /** packed geometry with interpolated normals (NORMALS) */
  smooth?: boolean;
}

export interface SurfaceTextureRefs {
  /** `texture`: the albedo image (sRGB) */
  albedo: string | null;
  /** `normalMap`: tangent space, OpenGL convention */
  normal: string | null;
  /** `roughnessMap` / `metalnessMap`: the packed ORM image (G roughness, B metalness) */
  orm: string | null;
  wrap: 'repeat' | 'clamp';
}

export interface SurfaceParams {
  /** `SurfaceVariant` bits: the cache key of the material */
  variant: number;
  /**
   * Where the surface's albedo, roughness and metalness come from: `'row'` = this row material (`paint`, set on the object
   * with `setSurfacePaint`); `'generator'` = the scripted geometry's own paints (the paint table), `paint` is the defaults.
   */
  paintSource: 'row' | 'generator';
  /** per-object uniform values (`setSurfacePaint`) */
  paint: SurfacePaint;
  /** texture references for the texture cache to resolve; a non-null entry has its TEX_* bit set */
  textures: SurfaceTextureRefs;
  /** three material state that is not part of the program */
  state: SurfaceParamsState;
  /** the mesh's `renderOrder` */
  renderOrder: number;
  /** the spec's fields the port has no implementation for, for one diagnostic line (never an error) */
  unsupported: string[];
  /** K13: the spec's `dissolve` is honoured (`state.dissolve` is set and `paint.dissolve` holds it); absent otherwise */
  dissolve?: true;
}

/**
 * A `material.texture` that names a texture script (a carried `.js` file under `scripts/`, `export function texture(ctx)`)
 * rather than a CDN image: X-47, authored content names `scripts/tex-beam.js`. A leading `/` is allowed.
 */
export function isTextureScriptPath(name: string): boolean {
  return /^\/?scripts\/[^?#]+\.js$/.test(name);
}

const SRC_BIT: Readonly<Record<SurfaceSource, number>> = { prim: SurfaceVariant.SRC_PRIM, packed: SurfaceVariant.SRC_PACKED, gltf: SurfaceVariant.SRC_GLTF };

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** A row's `material` (or none) → the surface parameters. Never throws on content: bad values fall back to the default. */
export function surfaceParamsFromSpec(spec: StandardMaterialSpec | null | undefined, opts: SurfaceParamsOptions = {}): SurfaceParams {
  let variant = SRC_BIT[opts.source ?? 'prim'];
  if (opts.smooth === true && opts.source === 'packed') variant |= SurfaceVariant.NORMALS;
  const paint = defaultSurfacePaint();
  const textures: SurfaceTextureRefs = { albedo: null, normal: null, orm: null, wrap: 'repeat' };
  const state: SurfaceParamsState = { depthWrite: true, depthTest: true, polygonOffset: false, polygonOffsetFactor: 0, polygonOffsetUnits: 0 };
  const scripted = opts.scripted === true;
  const params: SurfaceParams = { variant, paintSource: scripted ? 'generator' : 'row', paint, textures, state, renderOrder: 0, unsupported: [] };
  if (spec === null || spec === undefined) return params;
  if (dissolveSupport && finite(spec.dissolve)) {
    paint.dissolve = clamp01(spec.dissolve);
    state.dissolve = true;
    params.dissolve = true;
  }
  // a scripted row keeps the generator's look (`{pbr: true}` asks for nothing) unless the row material paints it: a texture
  // set, or a flat colour (the kit's textureless presets, whose generators paint nothing in kit mode)
  const rowTexture = typeof spec.texture === 'string' && spec.texture !== '';
  const rowColor = typeof spec.color === 'string' && cssToLinear(spec.color) !== null;
  if (scripted && !rowTexture && !rowColor) return params;
  params.paintSource = 'row';
  // with no texture to say so, the bit tells the packed stage that the object paint replaces the paint table
  if (scripted && !rowTexture && opts.source === 'packed') variant |= SurfaceVariant.ROW_PAINT;

  // colour, alpha
  let alpha: number | undefined;
  if (typeof spec.color === 'string') {
    const c = cssToLinear(spec.color);
    if (c !== null) paint.color = c;
    alpha = cssAlpha(spec.color);
  }
  if (finite(spec.opacity)) alpha = spec.opacity;
  paint.opacity = clamp01(alpha ?? 1);
  // three's rule: `opacity` only blends on a transparent material; an alpha below 1 with no `transparent` key asks for it
  const transparent = spec.transparent ?? paint.opacity < 1;
  if (transparent) variant |= SurfaceVariant.TRANSPARENT;

  // emissive × intensity, linear
  if (typeof spec.emissive === 'string') {
    const e = cssToLinear(spec.emissive);
    const k = finite(spec.emissiveIntensity) ? spec.emissiveIntensity : 1;
    if (e !== null) paint.emissive = [e[0] * k, e[1] * k, e[2] * k] as Linear3;
  }

  // roughness, metalness
  if (finite(spec.roughness)) paint.roughness = spec.roughness;
  if (finite(spec.metalness)) paint.metalness = spec.metalness;

  // textures
  if (typeof spec.texture === 'string' && spec.texture !== '') {
    textures.albedo = spec.texture;
    variant |= SurfaceVariant.TEX_ALBEDO;
  }
  if (typeof spec.normalMap === 'string' && spec.normalMap !== '') {
    textures.normal = spec.normalMap;
    variant |= SurfaceVariant.TEX_NORMAL;
  }
  const rMap = typeof spec.roughnessMap === 'string' && spec.roughnessMap !== '' ? spec.roughnessMap : null;
  const mMap = typeof spec.metalnessMap === 'string' && spec.metalnessMap !== '' ? spec.metalnessMap : null;
  if (rMap !== null || mMap !== null) {
    textures.orm = rMap ?? mMap;
    variant |= SurfaceVariant.TEX_ORM;
    paint.ormRoughness = rMap !== null;
    paint.ormMetalness = mMap !== null;
    if (rMap !== null && mMap !== null && rMap !== mMap) {
      // one packed image per material (glTF ORM): a separate metalness image has no slot
      paint.ormMetalness = false;
      params.unsupported.push('metalnessMap (a different image than roughnessMap)');
    }
  }
  if (spec.wrap === 'clamp') textures.wrap = 'clamp';
  if (Array.isArray(spec.repeat) && finite(spec.repeat[0]) && finite(spec.repeat[1]) && (spec.repeat[0] !== 1 || spec.repeat[1] !== 1)) {
    paint.uvScale = [spec.repeat[0], spec.repeat[1]];
    if ((variant & (SurfaceVariant.TEX_ALBEDO | SurfaceVariant.TEX_NORMAL | SurfaceVariant.TEX_ORM)) !== 0) variant |= SurfaceVariant.UV_TILE;
  }

  // structure and state
  if (spec.unlit === true) variant |= SurfaceVariant.UNLIT;
  if (spec.side === 'double') variant |= SurfaceVariant.SIDE_DOUBLE;
  else if (spec.side === 'back') variant |= SurfaceVariant.SIDE_BACK;
  if (typeof spec.depthWrite === 'boolean') state.depthWrite = spec.depthWrite;
  if (typeof spec.depthTest === 'boolean') state.depthTest = spec.depthTest;
  if (spec.polygonOffset === true) {
    state.polygonOffset = true;
    state.polygonOffsetFactor = finite(spec.polygonOffsetFactor) ? spec.polygonOffsetFactor : 0;
    state.polygonOffsetUnits = finite(spec.polygonOffsetUnits) ? spec.polygonOffsetUnits : 0;
  }
  if (finite(spec.renderOrder)) params.renderOrder = spec.renderOrder;
  const drawsOver = Array.isArray(spec.drawsOver) ? spec.drawsOver.length > 0 : spec.drawsOver !== undefined && spec.drawsOver !== null;
  if (drawsOver) params.renderOrder = Math.max(params.renderOrder, DRAWS_OVER_RENDER_ORDER);

  // carried by the type, without an implementation in the port
  if (spec.alphaMap !== undefined) params.unsupported.push('alphaMap');
  if (finite(spec.textureScale) && spec.textureScale !== 1) params.unsupported.push('textureScale');
  if (!dissolveSupport && finite(spec.dissolve) && spec.dissolve !== 0) params.unsupported.push('dissolve');
  if (spec.view !== undefined) params.unsupported.push('view');
  if (spec.outline !== undefined && spec.outline !== null && spec.outline !== false) params.unsupported.push('outline');
  if (spec.overrides !== undefined) params.unsupported.push('overrides');

  params.variant = variant;
  return params;
}
