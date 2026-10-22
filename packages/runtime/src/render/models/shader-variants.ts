// Enumerates material programs before content becomes visible. Program identity includes surface bits, object kind,
// skinning capacity, texture bindings, layer, shadow state and depth pass. Hosts supply generic family descriptors and
// runtime looks; asset group names carry no behavior. Unknown skeleton sizes warm every supported bone-count class.
// Warm-ups use real texture bindings and the same render target as the visible draw, then retain the linked programs.
import { BatchedMesh, BufferAttribute, BufferGeometry, Bone, DynamicDrawUsage, Group, InstancedBufferAttribute, InstancedMesh, Matrix4, Mesh, Skeleton, SkinnedMesh, Sphere, Vector3 } from 'three/webgpu';
import type { Camera, Material, Object3D, Scene, WebGPURenderer } from 'three/webgpu';
import type { AssetIndex } from '../../assets/index-types.ts';
import { BUCKET_BITS, PRIMITIVE_ALBEDO, PRIMITIVE_EMISSIVE, PRIMITIVE_EXTRA, buildBucketMaterial, whiteTexture } from '../geometry/primitives.ts';
import { CORPSE_BATCH_KEY, flatNormal, overrideIsTransparent, slotOverrideFromSpec, whitePixel, type LookTable, type ModelPaintTable } from '../surface/look-table.ts';
import { surfaceParamsFromSpec, type StandardMaterialSpec, type SurfaceSource } from '../surface/material-spec.ts';
import type { LightingScript } from '../surface/script-types.ts';
import { SurfaceVariant, describeVariant, texSlotCount, type SurfaceMaterials, type SurfaceSlotTextures } from '../surface/surface-material.ts';
import { BONE_CLASSES, boneClassOf, modelBlendMaterial, type BoneClass } from './model-template.ts';

const V = SurfaceVariant;

export type ObjectKind = 'mesh' | 'skinned' | 'instanced' | 'batched';

/** One program the content can ask for. */
export interface ProgramVariant {
  /** unique: bits, kind, bone class, receive-shadow, depth */
  key: string;
  /** `SurfaceVariant` bits */
  variant: number;
  kind: ObjectKind;
  /** skinned objects only */
  boneClass: BoneClass | null;
  receiveShadow: boolean;
  /** the shadow pass's depth program for a caster of this shape (the surface's position inputs, no lighting) */
  depth: boolean;
  /** 0 world, 1 viewmodel, 2 local body (render §4.1) */
  layer: 0 | 1 | 2;
  /** compiled at engine load (map- and roster-independent) or during a map's render build */
  stage: 'engine' | 'map';
  /** the work package that draws it */
  owner: string;
  /** the content that needs it */
  why: string[];
}

export interface ProgramVariantInit {
  variant: number;
  kind: ObjectKind;
  boneClass?: BoneClass | null;
  receiveShadow?: boolean;
  depth?: boolean;
  layer?: 0 | 1 | 2;
  stage?: 'engine' | 'map';
  owner: string;
  why: string;
}

export function programVariant(init: ProgramVariantInit): ProgramVariant {
  const boneClass = init.kind === 'skinned' ? (init.boneClass ?? null) : null;
  if (init.kind === 'skinned' && boneClass === null) throw new RangeError('a skinned program variant needs its bone-count class');
  const receiveShadow = init.receiveShadow ?? true;
  const depth = init.depth ?? false;
  const key = `${depth ? 'depth:' : ''}${describeVariant(init.variant)}/${init.kind}${boneClass ?? ''}${receiveShadow && !depth ? '/rs' : ''}`;
  return { key, variant: init.variant, kind: init.kind, boneClass, receiveShadow: depth ? false : receiveShadow, depth, layer: init.layer ?? 0, stage: init.stage ?? 'engine', owner: init.owner, why: [init.why] };
}

// ── the content ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface FamilyModel {
  name: string;
  skinned: boolean;
  /** slot texture sets (0 to 3) */
  textureSets: number;
  /** real bones, when known; else the family rule */
  boneCount?: number;
  /** the file has materials with alpha < 1 */
  blendPaints?: boolean;
}

export interface FamilyLook {
  name: string;
  spec: StandardMaterialSpec;
}

export interface ModelFamily {
  /** the asset group: an arbitrary host-defined identifier */
  id: string;
  /** Includes camera-attached variants. */
  viewmodel?: boolean;
  /** Includes baked and debris variants, for an installed batching plugin. */
  baked?: boolean;
  boneClass?: BoneClass;
  stage?: ProgramVariant['stage'];
  models: readonly FamilyModel[];
  /** slot looks the game can put on this family's instances */
  looks: readonly FamilyLook[];
}

/** One map row's material as the enumeration reads it (`variantOfRow`): the map part of the set. */
export interface RowContent {
  /** the row's `material` */
  spec: StandardMaterialSpec | null | undefined;
  /** `'packed'` for a scripted row, `'prim'` for a built-in primitive */
  source: SurfaceSource;
  /** how the map batcher draws it: a chunk or standalone mesh, or an instanced bucket */
  kind: ObjectKind;
  /** the row's geometry is scripted (the generator's paints stay unless the row material is a texture set or a flat preset) */
  scripted?: boolean;
  smooth?: boolean;
  receiveShadow?: boolean;
  owner: string;
  why: string;
}

export interface VariantContent {
  families: readonly ModelFamily[];
  /** the material of a camera-attached decal plane (authored content); null = none */
  viewmodelDecal?: StandardMaterialSpec | null;
  /**
   * The shadowCaster casts shadows on this tier: the depth programs of the casters. It does not change the colour forms: a
   * world model's meshes have `receiveShadow` on every tier (model-template.ts), and `receiveShadow` is in three's
   * render-object cache key whether or not a light casts, so a proxy that differed in it would not warm a skinned body
   * [M, tests/e2e/render-models.spec.ts "without the shadowCaster shadow"].
   */
  shadows: boolean;
  /**
   * Map rows (the place's scene rows, as the map batcher splits them): each becomes its `variantOfRow`. A scripted row
   * whose material is a flat preset is `SRC_PACKED | ROW_PAINT` (four rows of `places/training`).
   */
  rows?: readonly RowContent[];
  /** `WEBGL_multi_draw`: corpses and gibs are `BatchedMesh`es; without it one mesh per corpse and `InstancedMesh` gibs */
  multiDraw: boolean;
  /** variants of the other render packages (decals per atlas page, fx mesh sinks, terrain, water, map rows) */
  extra: readonly ProgramVariant[];
}

export interface VariantFamilyInput extends Omit<ModelFamily, 'models' | 'looks'> {
  /** Asset names; omitted: names of the index group with this exact id. */
  models?: readonly string[];
  looks?: readonly FamilyLook[];
}

export interface VariantContentInput {
  index: Pick<AssetIndex, 'entries' | 'groups' | 'facts'>;
  /** Ordered descriptors; the first descriptor claims a model occurring in several groups. */
  families?: readonly VariantFamilyInput[];
  boneCounts?: Readonly<Record<string, number>>;
  blendModels?: ReadonlySet<string>;
  viewmodelDecal?: StandardMaterialSpec | null;
  shadows: boolean;
  multiDraw: boolean;
  rows?: readonly RowContent[];
  extra?: readonly ProgramVariant[];
}

/** Builds model facts without interpreting asset group names or game data. */
export function variantContentFromIndex(input: VariantContentInput): VariantContent {
  const { index } = input;
  const descriptors: readonly VariantFamilyInput[] = input.families ?? Object.keys(index.groups).sort().map((id) => ({ id }));
  const claimed = new Set<string>();
  const families: ModelFamily[] = [];
  for (const descriptor of descriptors) {
    const { models: names, looks, ...family } = descriptor;
    const models: FamilyModel[] = [];
    for (const name of names ?? index.groups[descriptor.id]?.n ?? []) {
      const entry = index.entries[name];
      if (entry === undefined || entry.k !== 'model' || claimed.has(name)) continue;
      claimed.add(name);
      const model: FamilyModel = { name, skinned: index.facts[name]?.skinned === true, textureSets: Math.ceil((entry.d?.length ?? 0) / 3) };
      const bones = input.boneCounts?.[name];
      if (bones !== undefined) model.boneCount = bones;
      if (input.blendModels?.has(name) === true) model.blendPaints = true;
      models.push(model);
    }
    if (models.length > 0) families.push({ ...family, models, looks: looks ?? [] });
  }
  return { families, viewmodelDecal: input.viewmodelDecal ?? null, shadows: input.shadows, multiDraw: input.multiDraw, ...(input.rows === undefined ? {} : { rows: input.rows }), extra: input.extra ?? [] };
}

// ── the enumeration ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** `SurfaceVariant` bits of a model template with `sets` texture sets (model-template.ts builds the same) */
export function modelVariantBits(sets: number, extra = 0): number {
  if (!Number.isInteger(sets) || sets < 0 || sets > 3) throw new RangeError(`model variant: ${sets} texture sets (0 to 3)`);
  return V.SRC_GLTF | V.SLOTS | V.PARTMASK | V.SIDE_DOUBLE | (sets << 9) | extra;
}

/** The program a map row's material needs (the map part of the warm-up). */
export function variantOfRow(spec: StandardMaterialSpec | null | undefined, opts: Omit<RowContent, 'spec'>): ProgramVariant {
  const params = surfaceParamsFromSpec(spec, { source: opts.source, ...(opts.scripted === undefined ? {} : { scripted: opts.scripted }), ...(opts.smooth === undefined ? {} : { smooth: opts.smooth }) });
  return programVariant({ variant: params.variant, kind: opts.kind, receiveShadow: opts.receiveShadow ?? true, stage: 'map', owner: opts.owner, why: opts.why });
}

/** Every program of the content, each once, in a stable order (the engine-load set, then the map set). */
export function enumerateVariants(content: VariantContent): ProgramVariant[] {
  const out = new Map<string, ProgramVariant>();
  const add = (init: ProgramVariantInit): void => {
    const v = programVariant(init);
    const have = out.get(v.key);
    if (have === undefined) out.set(v.key, v);
    else if (!have.why.includes(init.why)) have.why.push(init.why);
  };
  // the depth programs exist only while the shadowCaster casts
  const casts = content.shadows;
  // a world model's meshes receive on every tier (`ModelTemplate` sets it): the proxy must agree, see `VariantContent.shadows`
  const rs = true;

  for (const family of content.families) {
    const stage = family.stage ?? 'engine';
    const blendLooks = family.looks.filter((l) => overrideIsTransparent(slotOverrideFromSpec(l.spec)));
    for (const model of family.models) {
      // an instance can take an alpha < 1 look on any slot at any time (`ModelInstance.setSlot`), so every instance form has
      // its blend pass in the set; the content known to use it is named
      const blendWhy = model.blendPaints === true ? `${family.id}: alpha < 1 materials` : blendLooks.length > 0 ? `${family.id}: ${blendLooks.map((l) => l.name).join(', ')}` : 'a slot override with alpha < 1';
      const passes = (bits: number, kind: ObjectKind, init: Omit<ProgramVariantInit, 'variant' | 'kind' | 'why'>, why: string, blend = true): void => {
        add({ ...init, variant: bits, kind, why });
        if (blend) add({ ...init, variant: bits | V.TRANSPARENT, kind, why: blendWhy });
      };
      const bits = modelVariantBits(model.textureSets);
      if (model.skinned) {
        const classes = model.boneCount !== undefined ? [boneClassOf(model.boneCount)] : family.boneClass === undefined ? BONE_CLASSES : [family.boneClass];
        for (const boneClass of classes) {
          if (family.viewmodel === true) {
            // Camera-attached variants use layer 1 and do not receive the world shadow.
            passes(modelVariantBits(model.textureSets, V.VIEWMODEL), 'skinned', { boneClass, receiveShadow: false, layer: 1, stage, owner: 'R8' }, `${family.id}: viewmodel`);
          }
          // The ordinary world instance, including the third-person form of camera-attached content.
          passes(bits, 'skinned', { boneClass, receiveShadow: rs, stage, owner: 'R6' }, `${family.id}: body`);
          if (casts) add({ variant: bits, kind: 'skinned', boneClass, depth: true, stage, owner: 'R6', why: `${family.id}: shadow caster` });
          if (family.baked === true) {
            // the baked corpse (render §11.5) keeps the body's look row: one BatchedMesh per pass, or one mesh per corpse without multi-draw
            const kind: ObjectKind = content.multiDraw ? 'batched' : 'mesh';
            passes(bits, kind, { receiveShadow: rs, stage, owner: 'R7' }, `${family.id}: baked corpse`);
            if (casts) add({ variant: bits, kind, depth: true, stage, owner: 'R7', why: `${family.id}: corpse shadow caster` });
          }
          }
        continue;
      }
      if (family.baked === true) {
        // gibs (render §11.6): batched per texture set with the model paint path and no look row; instanced without multi-draw
        const gib = V.SRC_GLTF | V.SIDE_DOUBLE | (model.textureSets << 9);
        passes(gib, content.multiDraw ? 'batched' : 'instanced', { receiveShadow: rs, stage, owner: 'R7' }, `${family.id}: gibs`, model.blendPaints === true);
        // A debris template can also be spawned as an ordinary static model.
        passes(bits, 'mesh', { receiveShadow: rs, stage, owner: 'R6' }, `${family.id}: model row`);
        continue;
      }
      passes(bits, 'mesh', { receiveShadow: rs, stage, owner: 'R6' }, `${family.id}: static model`);
      if (casts) add({ variant: bits, kind: 'mesh', depth: true, stage, owner: 'R6', why: `${family.id}: shadow caster` });
    }
  }

  for (const row of content.rows ?? []) {
    const v = variantOfRow(row.spec, row);
    const have = out.get(v.key);
    if (have === undefined) out.set(v.key, v);
    else if (!have.why.includes(row.why)) have.why.push(row.why);
  }

  if (content.viewmodelDecal !== null && content.viewmodelDecal !== undefined) {
    const params = surfaceParamsFromSpec(content.viewmodelDecal, { source: 'prim' });
    add({ variant: params.variant | V.VIEWMODEL, kind: 'mesh', receiveShadow: false, layer: 1, owner: 'R8', why: 'camera-attached decals' });
  }

  for (const v of content.extra) {
    const have = out.get(v.key);
    if (have === undefined) out.set(v.key, { ...v, why: [...v.why] });
    else for (const w of v.why) if (!have.why.includes(w)) have.why.push(w);
  }
  return [...out.values()].sort((a, b) => (a.stage === b.stage ? 0 : a.stage === 'engine' ? -1 : 1));
}

// ── the warm-up ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface WarmUpEnv {
  materials: SurfaceMaterials;
  look: LookTable;
  paint: ModelPaintTable;
  /**
   * The texture-set bindings in use: the `textureSets` of the loaded templates (`templateTextureBindings`). A skinned
   * variant with texture sets gets one proxy per binding of its size (the variant cache hands out one material per
   * binding, and each is built once before its bodies draw). With no binding given such a variant is warmed with stand-in
   * textures and listed in `WarmUpResult.placeholders`: with stable program text (see the header) that compile links the
   * program every binding of the variant draws with.
   */
  textureSets?: ReadonlyArray<readonly SurfaceSlotTextures[]>;
}

/**
 * The identity of one texture-set binding: the same texture objects are the same binding, the same material from the
 * variant cache, and — for a skinned variant — the same program.
 */
export function textureBindingKey(binding: readonly SurfaceSlotTextures[]): string {
  return binding.map((s) => `${s.albedo.uuid}/${s.normal?.uuid ?? ''}/${s.orm?.uuid ?? ''}`).join(',');
}

/** The distinct texture-set bindings of some templates (same texture objects = same binding = same material). */
export function templateTextureBindings(templates: Iterable<{ textureSets: readonly SurfaceSlotTextures[] }>): SurfaceSlotTextures[][] {
  const out = new Map<string, SurfaceSlotTextures[]>();
  for (const t of templates) {
    if (t.textureSets.length === 0) continue;
    const key = textureBindingKey(t.textureSets);
    if (!out.has(key)) out.set(key, [...t.textureSets]);
  }
  return [...out.values()];
}

/**
 * Builds the proxy of a variant (one object, or a group of them), or returns null when the variant is not this factory's.
 * A proxy must be what the real object is to three's render-object cache key: the same material instance, the same
 * geometry attribute set, the same skeleton size.
 */
export type ProxyFactory = (variant: ProgramVariant, env: WarmUpEnv) => Object3D | null;

export interface WarmUpOptions {
  /** proxies of the other packages' variants (packed chunks, batched corpses, decals, fx sinks): tried before the built-in ones */
  proxies?: readonly ProxyFactory[];
  /** the frame that compiles the depth programs; default `renderer.render(scene, camera)`. The game passes its pipeline's render. */
  render?: () => void | Promise<void>;
  /**
   * Skip the closing render. Only when nothing casts on this tier AND the render target the frame draws the scene into was
   * current for this call: otherwise the closing render is what compiles the programs of the frame's own render context
   * (see the header).
   */
  skipRender?: boolean;
  /** program creations so far (`Info#createProgram` wrapped); default: `renderer.info.memory.programs` */
  programs?: () => number;
  now?: () => number;
}

export interface WarmUpResult {
  /** variants a proxy was built for */
  compiled: string[];
  /** variants nobody could build a proxy for, with the reason */
  skipped: Array<{ key: string; reason: string }>;
  /** skinned variants with texture sets that had no real binding to warm with (see `WarmUpEnv.textureSets`) */
  placeholders: string[];
  /** program stages created by `compileAsync`, and by the closing render (the depth programs) */
  programsCompiled: number;
  programsRendered: number;
  compileMs: number;
  renderMs: number;
}

const PROXY_DISTANCE_M = 2;

/**
 * a triangle with every attribute a model surface reads; `ss` = part 255 (never hidden), slot 0, paint 0 (neutral). Also
 * the geometry of RH1's highlight proxies (special/highlight.ts `HighlightRenderer.warmObjects`): a silhouette is drawn
 * with the model's own geometry, so its proxies carry a model's attribute sets
 */
export function proxyGeometry(skinned: boolean, withUv: boolean): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([-0.01, -0.01, 0, 0.01, -0.01, 0, 0, 0.01, 0]), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  // the attribute set is part of three's cache key: a model template has `uv` only when it has a texture set
  if (withUv) g.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0.5, 1]), 2));
  g.setAttribute('partPaint', new BufferAttribute(new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 0, 0, 0]), 4, true));
  if (skinned) {
    g.setAttribute('skinIndex', new BufferAttribute(new Uint8Array(12), 4));
    g.setAttribute('skinWeight', new BufferAttribute(new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]), 4));
  }
  g.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2]), 1));
  g.boundingSphere = new Sphere(new Vector3(), 0.05);
  return g;
}

function slotPlaceholders(sets: number): SurfaceSlotTextures[] {
  return Array.from({ length: sets }, () => ({ albedo: whitePixel(), normal: flatNormal(), orm: whitePixel() }));
}

/** The built-in proxies: model surfaces on a mesh, a skinned mesh, an instanced mesh or a batched mesh, and built-in primitive surfaces on a mesh. */
export const modelProxy: ProxyFactory = (variant, env) => {
  if (variant.kind !== 'mesh' && variant.kind !== 'skinned' && variant.kind !== 'instanced' && variant.kind !== 'batched') return null;
  const isModel = (variant.variant & V.SRC_GLTF) !== 0;
  if (!isModel && (variant.variant & V.SRC_PRIM) === 0) return null;
  const sets = texSlotCount(variant.variant);
  const skinned = variant.kind === 'skinned';
  const build = (textures: Parameters<SurfaceMaterials['get']>[0]['textures'], withUv: boolean): Object3D => {
    const material = modelBlendMaterial(env.materials.get({ variant: variant.variant, ...(textures === undefined ? {} : { textures }) }));
    const geometry = proxyGeometry(skinned, withUv);
    if (variant.kind === 'instanced') {
      const mesh = new InstancedMesh(geometry, material, 1);
      mesh.setMatrixAt(0, new Matrix4());
      mesh.instanceMatrix.needsUpdate = true;
      return mesh;
    }
    if (variant.kind === 'batched') {
      const mesh = new BatchedMesh(1, 64, 64, material);
      mesh.setMatrixAt(mesh.addInstance(mesh.addGeometry(geometry)), new Matrix4());
      // a batched model surface with look rows (SLOTS) is a baked-corpse batch (render §11.5): it reads its rows per instance
      // through `LookTable.batchRows` (look-table.ts `lookRowNode`), so the proxy is one too. Gib batches have no look row.
      if (isModel && (variant.variant & V.SLOTS) !== 0) mesh.userData[CORPSE_BATCH_KEY] = 0;
      return mesh;
    }
    if (!skinned) return new Mesh(geometry, material);
    const mesh = new SkinnedMesh(geometry, material);
    const bone = new Bone();
    mesh.add(bone);
    const count = variant.boneClass!;
    mesh.bind(new Skeleton(Array.from({ length: count }, () => bone), Array.from({ length: count }, () => new Matrix4())), new Matrix4());
    mesh.boundingSphere = geometry.boundingSphere!.clone();
    return mesh;
  };
  if (!isModel) return build({ albedo: whitePixel(), normal: flatNormal(), orm: whitePixel() }, true);
  if (sets === 0) return build(undefined, false);
  // the shader text does not depend on the material instance (see the header), so any binding or the stand-ins warm the
  // program; a skinned stand-in is reported, and its variant is warmed again per real binding once one is loaded
  const bindings = (env.textureSets ?? []).filter((b) => b.length === sets);
  if (bindings.length === 0) {
    const proxy = build({ slots: slotPlaceholders(sets) }, true);
    proxy.userData['ssPlaceholder'] = skinned;
    return proxy;
  }
  if (!skinned || bindings.length === 1) return build({ slots: bindings[0]! }, true);
  const group = new Group();
  for (const b of bindings) group.add(build({ slots: b }, true));
  return group;
};

// ── primitive buckets ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Every program a primitive bucket (render §6.7, src/render/geometry/primitives.ts) can be drawn with: one per combination
 * of the bits a bucket builds (`BUCKET_BITS`: texture, uv repeat, blend pass, unlit, side). A bucket is made by the first
 * row of its look, which a script can spawn at any time (the team-glow haze cones appear at PREP, gore and ordnance in the
 * wave), so the set is the bucket path's, not a place's: it is compiled once, behind the menu. Buckets never receive or
 * cast (their meshes keep three's defaults), so there are no `receiveShadow` or depth forms.
 */
export function bucketProgramVariants(): ProgramVariant[] {
  const out: ProgramVariant[] = [];
  for (const tex of [0, V.TEX_ALBEDO, V.TEX_ALBEDO | V.UV_TILE])
    for (const blend of [0, V.TRANSPARENT])
      for (const unlit of [0, V.UNLIT])
        for (const side of [0, V.SIDE_BACK, V.SIDE_DOUBLE]) {
          const bits = (V.SRC_PRIM | tex | blend | unlit | side) & BUCKET_BITS;
          out.push(programVariant({ variant: bits, kind: 'instanced', receiveShadow: false, owner: 'R3', why: 'a primitive bucket (any row look, spawned at any time)' }));
        }
  return out;
}

/**
 * Every program a camera-attached primitive can be drawn with (`createViewmodelContent`, src/render/bridge/attach.ts: one
 * mesh per row, the VIEWMODEL projection, the bits `VM_PRIM_BITS` keeps): camera-attached decal planes are made when a hit lands, so,
 * as for buckets, the set is the path's. Layer 1, never receiving a shadow, as the viewmodel.
 */
export function viewmodelPrimitiveVariants(): ProgramVariant[] {
  const out: ProgramVariant[] = [];
  for (const tex of [0, V.TEX_ALBEDO])
    for (const blend of [0, V.TRANSPARENT])
      for (const unlit of [0, V.UNLIT])
        for (const side of [0, V.SIDE_BACK, V.SIDE_DOUBLE])
          out.push(programVariant({ variant: V.SRC_PRIM | V.VIEWMODEL | tex | blend | unlit | side, kind: 'mesh', receiveShadow: false, layer: 1, owner: 'R8', why: 'a camera-attached primitive with a row look' }));
  return out;
}

/** a triangle with a bucket's attribute set: the unit geometry's position, normal and uv, and the instanced paint attributes */
function bucketProxyGeometry(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([-0.01, -0.01, 0, 0.01, -0.01, 0, 0, 0.01, 0]), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]), 3));
  g.setAttribute('uv', new BufferAttribute(new Float32Array([0, 0, 1, 0, 0.5, 1]), 2));
  for (const name of [PRIMITIVE_ALBEDO, PRIMITIVE_EMISSIVE, PRIMITIVE_EXTRA]) g.setAttribute(name, new InstancedBufferAttribute(new Float32Array([1, 1, 1, 1]), 4).setUsage(DynamicDrawUsage));
  g.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2]), 1));
  g.boundingSphere = new Sphere(new Vector3(), 0.05);
  return g;
}

/**
 * The proxy of a primitive bucket variant: an InstancedMesh of one instance with the material a bucket of those bits builds
 * (`buildBucketMaterial` over the world's lighting script) and a bucket's attribute set. The shader text of an instanced
 * object depends on neither its capacity nor its id (src/render/engine/stable-programs.ts), so one proxy stands for every
 * bucket of its bits. The materials are kept for the session: disposing one would release its programs in three (a
 * program is freed with its last user), and the next bucket of those bits would link them again.
 */
export function bucketProxyFactory(script: LightingScript | null): ProxyFactory {
  const materials = new Map<number, Material>();
  return (variant) => {
    if (variant.kind !== 'instanced' || (variant.variant & V.SRC_PRIM) === 0 || (variant.variant & ~BUCKET_BITS) !== 0) return null;
    const bits = variant.variant;
    let material = materials.get(bits);
    if (material === undefined) {
      const look = { key: `ss:warm-up:${bits.toString(36)}`, variant: bits, params: surfaceParamsFromSpec(null, { source: 'prim' }) };
      material = buildBucketMaterial(look, script, (bits & V.TEX_ALBEDO) !== 0 ? whiteTexture() : null).material;
      materials.set(bits, material);
    }
    const mesh = new InstancedMesh(bucketProxyGeometry(), material, 1);
    mesh.setMatrixAt(0, new Matrix4());
    return mesh;
  };
}

/**
 * Compiles the variants against `scene` (see the header). The proxies are in the scene only for the duration of the call.
 * Variants no factory can build are reported in `skipped`, never thrown: a package that has not landed leaves its programs
 * to the first draw.
 */
export async function warmUp(renderer: WebGPURenderer, scene: Scene, camera: Camera, variants: readonly ProgramVariant[], env: WarmUpEnv, opts: WarmUpOptions = {}): Promise<WarmUpResult> {
  const now = opts.now ?? (() => performance.now());
  const programs = opts.programs ?? (() => (renderer.info.memory as unknown as { programs: number }).programs);
  const factories = [...(opts.proxies ?? []), modelProxy];
  const group = new Group();
  group.name = 'ss:warm-up';
  const result: WarmUpResult = { compiled: [], skipped: [], placeholders: [], programsCompiled: 0, programsRendered: 0, compileMs: 0, renderMs: 0 };

  camera.updateMatrixWorld(true);
  const forward = new Vector3(0, 0, -1).transformDirection(camera.matrixWorld);
  const at = new Vector3().setFromMatrixPosition(camera.matrixWorld).addScaledVector(forward, PROXY_DISTANCE_M);
  const geometries = new Set<BufferGeometry>();
  // A caster is drawn by the shadow pass with its own `receiveShadow` in three's cache key, so a depth program is warmed by
  // the colour proxy of the same shape casting, not by a second object: a depth variant only gets a proxy of its own when
  // the list has no colour variant of its shape.
  const depthKeys = new Set(variants.filter((v) => v.depth).map((v) => v.key));
  const casting = new Set<string>();
  for (const v of variants) {
    if (v.depth) continue;
    const key = programVariant({ variant: v.variant, kind: v.kind, boneClass: v.boneClass, depth: true, owner: v.owner, why: '' }).key;
    if (depthKeys.has(key)) casting.add(key);
  }
  const casters = new Set<string>();
  for (const variant of variants) {
    if (variant.depth && casting.has(variant.key)) continue;
    let proxy: Object3D | null = null;
    let reason = 'no proxy factory builds this variant';
    for (const factory of factories) {
      try {
        proxy = factory(variant, env);
      } catch (e) {
        reason = (e as Error).message;
        proxy = null;
        break;
      }
      if (proxy !== null) break;
    }
    if (proxy === null) {
      result.skipped.push({ key: variant.key, reason });
      continue;
    }
    // the colour proxy that also stands for its shape's depth variant: the first one that receives as the real casters do
    const depthKey = variant.depth ? variant.key : programVariant({ variant: variant.variant, kind: variant.kind, boneClass: variant.boneClass, depth: true, owner: variant.owner, why: '' }).key;
    const casts = variant.depth || (casting.has(depthKey) && !casters.has(depthKey));
    if (casts && !variant.depth) casters.add(depthKey);
    proxy.name = `ss:warm-up:${variant.key}`;
    proxy.position.copy(at);
    proxy.traverse((o) => {
      const mesh = o as Mesh;
      if (mesh.isMesh !== true) return;
      mesh.frustumCulled = false;
      mesh.layers.set(variant.layer);
      mesh.castShadow = casts;
      mesh.receiveShadow = variant.receiveShadow;
      geometries.add(mesh.geometry);
    });
    if (proxy.userData['ssPlaceholder'] === true) result.placeholders.push(variant.key);
    group.add(proxy);
    result.compiled.push(variant.key);
  }
  for (const key of casting) {
    if (casters.has(key)) result.compiled.push(key);
    else result.skipped.push({ key, reason: 'the colour proxy of its shape could not be built' });
  }

  const layers = camera.layers.mask;
  camera.layers.enable(0);
  camera.layers.enable(1);
  camera.layers.enable(2);
  scene.add(group);
  try {
    group.updateMatrixWorld(true);
    env.look.flush(renderer);
    env.paint.flush(renderer);
    let before = programs();
    let t = now();
    await renderer.compileAsync(group, camera, scene);
    result.compileMs = now() - t;
    result.programsCompiled = programs() - before;
    if (opts.skipRender !== true) {
      before = programs();
      t = now();
      await (opts.render ?? (() => renderer.render(scene, camera)))();
      result.renderMs = now() - t;
      result.programsRendered = programs() - before;
    }
  } finally {
    scene.remove(group);
    camera.layers.mask = layers;
    for (const g of geometries) g.dispose();
  }
  return result;
}
