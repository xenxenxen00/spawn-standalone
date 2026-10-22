// Built-in primitives (docs/design/rendering.md §6.7; `spawn-engine-contract.md` §9.2, §9.4; X-47; WP R3).
//
// Every primitive row is an **instance in an `InstancedMesh` bucket** per (unit geometry, material variant and state, pass):
// the bridge writes world matrices and paint values straight into typed arrays, so no `Object3D`, world matrix, bounding
// volume or frustum test exists per primitive. All live primitives of one bucket are one draw call.
//
//   shape     `primitiveShape(spec)`: the unit geometry's key and the per-instance scale that turns it into the row's size.
//             What scale cannot express is part of the key: segment counts, a capsule's height-to-radius ratio, a torus's
//             tube-to-radius ratio and arc, and for a cylinder the ratio of its two radii and `openEnded` (the X-47 haze cones:
//             `radiusTop` 0.45 or 1.0 over `radiusBottom` 0.04, no caps). Origin (contract §9.2): bottom centre; the flat
//             kinds (`plane`, `circle`, `ring`, `torus`) stand by their centre with `anchor: "center"` (every live one) and
//             by their lowest point otherwise. Geometry and parameter defaults are three's own (the engine under Spawn)
//   look      the row's `material` through `material-spec.ts`. Structure and state pick the bucket (a texture, `transparent`,
//             `side`, `unlit`, `depthWrite`, `depthTest`, polygon offset, `renderOrder`); colour, opacity, emissive, roughness,
//             metalness and the uv repeat are per instance (`InstancedBufferAttribute`s `ssAlbedo`, `ssEmissive`, `ssExtra`)
//   texture   an albedo texture multiplies the colour by its rgb and the opacity by its alpha. Names resolve through the
//             injected `resolveTexture(name)`; a miss (a script path such as `scripts/tex-beam.js` before RH1's
//             `surface/texture-script.ts` lands, or a file still loading) draws one shared plain white texture until
//             `setTexture(name, texture)` supplies the real one. UV convention for RH1: on a cylinder `uv.x` runs around the
//             axis and `uv.y` along it, 0 at the bottom (the origin end: the lamp end of a haze cone) and 1 at the top
//   bounds    per bucket, explicit: `flush()` assigns the mesh's own `boundingSphere` (the union of the live instances) on
//             every count change and every 4th call; three would compute it once and keep it. A bucket that spans the map
//             takes `frustumCulled = false` instead
//
// A transparent double-sided bucket sets `forceSinglePass` (render §15.5). Buckets grow by doubling. A bucket's instance
// matrices are read as instanced attributes (engine/stable-programs.ts), so its program depends on its variant bits only:
// every bucket of one variant, whatever its capacity, shares the program the warm-up linked (`bucketProgramVariants`).
//
// Not built (no live primitive uses them, contract §9.2 lists them from the reference only): `arch` / `archway`.
import { attribute, texture as textureNode, uv } from 'three/tsl';
import {
  BoxGeometry, BufferGeometry, CapsuleGeometry, CircleGeometry, ConeGeometry, CylinderGeometry, DataTexture, DoubleSide, DynamicDrawUsage, InstancedBufferAttribute,
  InstancedMesh, Matrix4, PlaneGeometry, RingGeometry, Sphere, SphereGeometry, TorusGeometry, Vector3,
} from 'three/webgpu';
import type { Node, Object3D, Texture } from 'three/webgpu';
import { unionSphere } from './map-plan.ts';
import { surfaceParamsFromSpec, type StandardMaterialSpec, type SurfaceParams } from '../surface/material-spec.ts';
import type { LightingScript } from '../surface/script-types.ts';
import { SurfaceMaterial, SurfaceVariant, UnlitSurfaceMaterial, describeVariant, type AnySurfaceMaterial, type SurfacePaint } from '../surface/surface-material.ts';

/** `spawn-engine-contract.md` §9.2 */
export interface PrimitiveSpec {
  kind: string;
  width?: number;
  height?: number;
  depth?: number;
  size?: number;
  radius?: number;
  radiusTop?: number;
  radiusBottom?: number;
  innerRadius?: number;
  outerRadius?: number;
  halfHeight?: number;
  tube?: number;
  arc?: number;
  radialSegments?: number;
  tubularSegments?: number;
  widthSegments?: number;
  heightSegments?: number;
  segments?: number;
  /** cylinder: no cap discs (X-47; read from the live game's use, undocumented in the reference) */
  openEnded?: boolean;
  /** R-4 (opt-in, `setPrimitiveAngleSupport`): partial `sphere` (`phiStart`/`phiLength` around, `thetaStart`/`thetaLength` from the pole) and open `ring` arcs (`thetaStart`/`thetaLength`/`thetaSegments`), radians */
  phiStart?: number;
  phiLength?: number;
  thetaStart?: number;
  thetaLength?: number;
  thetaSegments?: number;
  anchor?: string;
}

export const PRIMITIVE_KINDS = Object.freeze(['box', 'sphere', 'cylinder', 'cone', 'capsule', 'plane', 'circle', 'ring', 'torus'] as const);
export type PrimitiveKind = (typeof PRIMITIVE_KINDS)[number];

export interface PrimitiveShape {
  kind: PrimitiveKind;
  /** identifies the unit geometry */
  geometryKey: string;
  /** instance scale that gives the unit geometry the row's size */
  scale: [number, number, number];
  /** builds the unit geometry (origin per contract §9.2) */
  create(): BufferGeometry;
}

/**
 * R-4: whether the partial angles of `sphere` and `ring` are honoured. Off by default (the legacy host: a sphere is whole, a ring takes only
 * `segments`); `installGame`'s `primitiveAngles` dependency turns it on once.
 */
let angleSupport = false;
export function setPrimitiveAngleSupport(on: boolean): void {
  angleSupport = on;
}
export const primitiveAnglesSupported = (): boolean => angleSupport;
/**
 * Opt-in (`GameDeps.flatPrimitivesCentred`): a flat kind (`plane`, `circle`, `ring`, `torus`) with no `anchor` stands by its
 * centre, as Spawn draws it (Pip Skybloom's sky plane: the reference frames show the middle of its gradient at the row's
 * height). Default false: the legacy host, by its lowest point (an explicit `anchor` other than `center` keeps that either way)
 */
let flatCentred = false;
export function setFlatPrimitivesCentred(on: boolean): void {
  flatCentred = on;
}

const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const seg = (v: unknown, d: number, min: number): number => Math.max(min, Math.round(num(v, d)));
/** ratios are part of a geometry key: four decimals keep 0.45 / 0.04 and 1.0 / 0.04 apart and equal specs together */
const ratio = (v: number): number => Math.round(v * 1e4) / 1e4;

/** The unit geometry and instance scale of a primitive spec; throws on a kind that is not a built-in primitive. */
export function primitiveShape(spec: PrimitiveSpec): PrimitiveShape {
  const centre = spec.anchor === 'center' || (flatCentred && spec.anchor === undefined);
  switch (spec.kind) {
    case 'box': {
      const s = num(spec.size, 1);
      return { kind: 'box', geometryKey: 'box', scale: [num(spec.width, s), num(spec.height, s), num(spec.depth, s)], create: () => new BoxGeometry(1, 1, 1).translate(0, 0.5, 0) };
    }
    case 'sphere': {
      const r = num(spec.radius, 1);
      const ws = seg(spec.widthSegments, 32, 3), hs = seg(spec.heightSegments, 16, 2);
      if (angleSupport && (spec.phiStart !== undefined || spec.phiLength !== undefined || spec.thetaStart !== undefined || spec.thetaLength !== undefined)) {
        const ps = ratio(num(spec.phiStart, 0)), pl = ratio(num(spec.phiLength, Math.PI * 2)), ts = ratio(num(spec.thetaStart, 0)), tl = ratio(num(spec.thetaLength, Math.PI));
        return { kind: 'sphere', geometryKey: `sphere:${ws}:${hs}:${ps}:${pl}:${ts}:${tl}`, scale: [r, r, r], create: () => new SphereGeometry(1, ws, hs, ps, pl, ts, tl).translate(0, 1, 0) };
      }
      return { kind: 'sphere', geometryKey: `sphere:${ws}:${hs}`, scale: [r, r, r], create: () => new SphereGeometry(1, ws, hs).translate(0, 1, 0) };
    }
    case 'cylinder': {
      const top = Math.max(0, num(spec.radiusTop, num(spec.radius, 1)));
      const bottom = Math.max(0, num(spec.radiusBottom, num(spec.radius, 1)));
      const big = Math.max(top, bottom) || 1;
      const rt = ratio(top / big), rb = ratio(bottom / big);
      const rs = seg(spec.radialSegments, 32, 3);
      const open = spec.openEnded === true;
      return {
        kind: 'cylinder',
        geometryKey: `cylinder:${rt}:${rb}:${rs}${open ? ':open' : ''}`,
        scale: [big, num(spec.height, 1), big],
        create: () => new CylinderGeometry(rt, rb, 1, rs, 1, open).translate(0, 0.5, 0),
      };
    }
    case 'cone': {
      const r = num(spec.radius, 1);
      const rs = seg(spec.radialSegments, 32, 3);
      return { kind: 'cone', geometryKey: `cone:${rs}`, scale: [r, num(spec.height, 1), r], create: () => new ConeGeometry(1, 1, rs).translate(0, 0.5, 0) };
    }
    case 'capsule': {
      // radius and the half height of the cylindrical part; the caps add one radius at each end
      const r = num(spec.radius, 0.5) || 0.5;
      const k = ratio(Math.max(0, num(spec.halfHeight, 0.5)) / r);
      const rs = seg(spec.radialSegments, 16, 3);
      return { kind: 'capsule', geometryKey: `capsule:${k}:${rs}`, scale: [r, r, r], create: () => new CapsuleGeometry(1, 2 * k, 8, rs).translate(0, k + 1, 0) };
    }
    case 'plane': {
      const w = num(spec.width, 1), h = num(spec.height, 1);
      return { kind: 'plane', geometryKey: centre ? 'plane' : 'plane:low', scale: [w, h, 1], create: () => (centre ? new PlaneGeometry(1, 1) : new PlaneGeometry(1, 1).translate(0, 0.5, 0)) };
    }
    case 'circle': {
      const r = num(spec.radius, 1);
      const s = seg(spec.segments, 32, 3);
      return { kind: 'circle', geometryKey: `circle:${s}${centre ? '' : ':low'}`, scale: [r, r, 1], create: () => (centre ? new CircleGeometry(1, s) : new CircleGeometry(1, s).translate(0, 1, 0)) };
    }
    case 'ring': {
      const outer = num(spec.outerRadius, num(spec.radius, 1)) || 1;
      const k = ratio(Math.max(0, num(spec.innerRadius, outer * 0.5)) / outer);
      if (angleSupport && (spec.thetaStart !== undefined || spec.thetaLength !== undefined || spec.thetaSegments !== undefined)) {
        const s = seg(spec.thetaSegments, num(spec.segments, 32), 1);
        const t0 = ratio(num(spec.thetaStart, 0)), tl = ratio(num(spec.thetaLength, Math.PI * 2));
        return {
          kind: 'ring',
          geometryKey: `ring:${k}:${s}:${t0}:${tl}${centre ? '' : ':low'}`,
          scale: [outer, outer, 1],
          create: () => (centre ? new RingGeometry(k, 1, s, 1, t0, tl) : new RingGeometry(k, 1, s, 1, t0, tl).translate(0, 1, 0)),
        };
      }
      const s = seg(spec.segments, 32, 3);
      return { kind: 'ring', geometryKey: `ring:${k}:${s}${centre ? '' : ':low'}`, scale: [outer, outer, 1], create: () => (centre ? new RingGeometry(k, 1, s) : new RingGeometry(k, 1, s).translate(0, 1, 0)) };
    }
    case 'torus': {
      const r = num(spec.radius, 1) || 1;
      const k = ratio(Math.max(0, num(spec.tube, 0.4)) / r);
      const rs = seg(spec.radialSegments, 12, 3), ts = seg(spec.tubularSegments, 48, 3);
      const arc = ratio(num(spec.arc, Math.PI * 2));
      return {
        kind: 'torus',
        geometryKey: `torus:${k}:${rs}:${ts}:${arc}${centre ? '' : ':low'}`,
        scale: [r, r, r],
        create: () => (centre ? new TorusGeometry(1, k, rs, ts, arc) : new TorusGeometry(1, k, rs, ts, arc).translate(0, 1 + k, 0)),
      };
    }
    default:
      throw new RangeError(`primitive kind ${JSON.stringify(spec.kind)} is not a built-in primitive (${PRIMITIVE_KINDS.join(', ')})`);
  }
}

// ── looks ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const PRIMITIVE_ALBEDO = 'ssAlbedo';
export const PRIMITIVE_EMISSIVE = 'ssEmissive';
export const PRIMITIVE_EXTRA = 'ssExtra';

/** variant bits a primitive bucket builds; the others of a spec are reported once and dropped */
export const BUCKET_BITS: number =
  SurfaceVariant.SRC_PRIM | SurfaceVariant.TEX_ALBEDO | SurfaceVariant.UV_TILE | SurfaceVariant.TRANSPARENT | SurfaceVariant.UNLIT | SurfaceVariant.SIDE_BACK | SurfaceVariant.SIDE_DOUBLE;

let white: DataTexture | null = null;
/** the one plain white texture every unresolved texture name draws with */
export function whiteTexture(): DataTexture {
  if (white === null) {
    white = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
    white.name = 'ss:white';
    white.needsUpdate = true;
  }
  return white;
}

export interface BucketLook {
  /** bucket identity besides the geometry: structure, state, texture name, render order */
  key: string;
  variant: number;
  params: SurfaceParams;
}

/** The bucket a row material belongs to, and its per-instance paint. Never throws on content. */
export function primitiveLook(material: StandardMaterialSpec | null | undefined): BucketLook {
  const params = surfaceParamsFromSpec(material, { source: 'prim' });
  const variant = params.variant & BUCKET_BITS;
  const s = params.state;
  const key = `${variant.toString(36)}|${s.depthWrite ? 1 : 0}${s.depthTest ? 1 : 0}${s.polygonOffset ? `p${s.polygonOffsetFactor}/${s.polygonOffsetUnits}` : ''}|${params.textures.albedo ?? ''}|${params.textures.wrap}|${params.renderOrder}`;
  return { key, variant, params };
}

/** `AGENTS.md:131`: a material whose only look key is `color` did not draw in the live GPU harness. The port draws it. */
export function isColorOnlyMaterial(material: StandardMaterialSpec | null | undefined): boolean {
  if (material === null || material === undefined || typeof material.color !== 'string') return false;
  const m = material as Record<string, unknown>;
  return !['roughness', 'metalness', 'emissive', 'emissiveIntensity', 'texture', 'transparent', 'opacity', 'unlit', 'pbr', 'normalMap', 'roughnessMap', 'metalnessMap'].some((k) => m[k] !== undefined);
}

interface TextureSlot {
  value: Texture;
}

/** Builds the material of a bucket: the surface material with its inputs read from the instanced paint attributes. */
export function buildBucketMaterial(look: BucketLook, script: LightingScript | null, albedo: Texture | null): { material: AnySurfaceMaterial; textureNode: TextureSlot | null } {
  const V = SurfaceVariant;
  const variant = script === null ? look.variant | V.UNLIT : look.variant;
  const a = attribute<'vec4'>(PRIMITIVE_ALBEDO, 'vec4');
  const e = attribute<'vec4'>(PRIMITIVE_EMISSIVE, 'vec4');
  const x = attribute<'vec4'>(PRIMITIVE_EXTRA, 'vec4');
  let color: Node<'vec3'> = a.rgb;
  let opacity: Node<'float'> = a.a;
  let slot: TextureSlot | null = null;
  if ((variant & V.TEX_ALBEDO) !== 0) {
    const coords = (variant & V.UV_TILE) !== 0 ? uv().mul(x.yz) : uv();
    const texel = textureNode(albedo ?? whiteTexture(), coords);
    slot = texel as unknown as TextureSlot;
    // three's `map` rule: rgb tints, alpha scales the opacity (the haze cone's falloff lives in its texture's alpha)
    color = color.mul(texel.rgb);
    opacity = opacity.mul(texel.a);
  }
  let material: AnySurfaceMaterial;
  if ((variant & V.UNLIT) !== 0 || script === null) {
    const m = new UnlitSurfaceMaterial(variant);
    m.colorNode = color.add(e.rgb);
    material = m;
  } else {
    const m = new SurfaceMaterial({ variant, script });
    m.colorNode = color;
    m.emissiveNode = e.rgb;
    m.roughnessNode = e.a;
    m.metalnessNode = x.x;
    material = m;
  }
  material.name = `ss:primitive:${describeVariant(variant)}`;
  if ((variant & V.TRANSPARENT) !== 0) material.opacityNode = opacity;
  const s = look.params.state;
  material.depthWrite = s.depthWrite;
  material.depthTest = s.depthTest;
  material.polygonOffset = s.polygonOffset;
  material.polygonOffsetFactor = s.polygonOffsetFactor;
  material.polygonOffsetUnits = s.polygonOffsetUnits;
  // one pass for a transparent double-sided surface: three would draw back faces, then front faces (render §15.5)
  if (material.transparent && material.side === DoubleSide) material.forceSinglePass = true;
  return { material, textureNode: slot };
}

// ── buckets ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const BOUNDS_FRAMES = 4;
const _m = new Matrix4();
const _s = new Matrix4();

export class PrimitiveBucket {
  readonly key: string;
  readonly shape: PrimitiveShape;
  readonly look: BucketLook;
  readonly material: AnySurfaceMaterial;
  /** the albedo texture name of the bucket; null when it has none */
  readonly textureName: string | null;
  mesh: InstancedMesh;
  /** instance matrices, 16 floats each: write them directly, then `touch(from, to)` */
  matrices!: Float32Array;
  /** linear rgb + opacity */
  albedo!: Float32Array;
  /** linear rgb (× intensity) + roughness */
  emissive!: Float32Array;
  /** metalness, uv repeat x, uv repeat y, 0 */
  extra!: Float32Array;
  capacity = 0;
  count = 0;
  /** true: never frustum-culled (a bucket whose instances span the map) */
  spansMap = false;
  readonly #unit: BufferGeometry;
  readonly #unitSphere: Sphere;
  readonly #textureNode: TextureSlot | null;
  readonly #parent: Object3D;
  /** instance id per slot, and slot per id */
  #ids: number[] = [];
  readonly #slots = new Map<number, number>();
  #dirtyFrom = Infinity;
  #dirtyTo = -Infinity;
  #countChanged = true;
  #flushes = 0;

  constructor(key: string, shape: PrimitiveShape, look: BucketLook, unit: BufferGeometry, built: { material: AnySurfaceMaterial; textureNode: TextureSlot | null }, capacity: number, parent: Object3D) {
    this.key = key;
    this.shape = shape;
    this.look = look;
    this.material = built.material;
    this.textureName = look.params.textures.albedo;
    this.#textureNode = built.textureNode;
    this.#unit = unit;
    if (unit.boundingSphere === null) unit.computeBoundingSphere();
    this.#unitSphere = unit.boundingSphere!;
    this.#parent = parent;
    this.mesh = this.#allocate(capacity);
    parent.add(this.mesh);
  }

  #allocate(capacity: number): InstancedMesh {
    // the bucket's own geometry: the unit geometry's attributes (shared, uploaded once) plus its instanced paint attributes
    const g = new BufferGeometry();
    for (const [name, attr] of Object.entries(this.#unit.attributes)) g.setAttribute(name, attr);
    g.setIndex(this.#unit.index);
    g.boundingSphere = this.#unitSphere.clone();
    const make = (name: string): Float32Array => {
      const a = new InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
      a.setUsage(DynamicDrawUsage);
      g.setAttribute(name, a);
      return a.array as Float32Array;
    };
    const albedo = make(PRIMITIVE_ALBEDO), emissive = make(PRIMITIVE_EMISSIVE), extra = make(PRIMITIVE_EXTRA);
    const mesh = new InstancedMesh(g, this.material, capacity);
    mesh.name = `ss:primitives:${this.key}`;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    mesh.count = this.count;
    mesh.visible = this.count > 0;
    mesh.matrixAutoUpdate = false;
    mesh.renderOrder = this.look.params.renderOrder;
    mesh.frustumCulled = !this.spansMap;
    mesh.boundingSphere = new Sphere(new Vector3(), 0);
    const matrices = mesh.instanceMatrix.array as Float32Array;
    if (this.capacity > 0) {
      matrices.set(this.matrices.subarray(0, this.count * 16));
      albedo.set(this.albedo.subarray(0, this.count * 4));
      emissive.set(this.emissive.subarray(0, this.count * 4));
      extra.set(this.extra.subarray(0, this.count * 4));
    }
    this.matrices = matrices;
    this.albedo = albedo;
    this.emissive = emissive;
    this.extra = extra;
    this.capacity = capacity;
    return mesh;
  }

  /** replaces the mesh by one of at least `min` instances (doubling): a new buffer set, uploaded on the next draw */
  grow(min: number): void {
    let capacity = this.capacity;
    while (capacity < min) capacity *= 2;
    if (capacity === this.capacity) return;
    const old = this.mesh;
    this.mesh = this.#allocate(capacity);
    this.#parent.add(this.mesh);
    old.removeFromParent();
    old.geometry.dispose();
    this.#dirtyFrom = 0;
    this.#dirtyTo = this.count;
    this.#countChanged = true;
  }

  /** marks slots `[from, to)` as written */
  touch(from: number, to: number): void {
    if (from < this.#dirtyFrom) this.#dirtyFrom = from;
    if (to > this.#dirtyTo) this.#dirtyTo = to;
  }

  /** the bulk path: the caller filled slots `[0, n)` of the typed arrays itself */
  setCount(n: number): void {
    if (n > this.capacity) throw new RangeError(`primitive bucket ${this.key}: ${n} instances in a capacity of ${this.capacity} (grow() first)`);
    if (n !== this.count) this.#countChanged = true;
    this.count = n;
    this.#ids.length = 0;
    this.#slots.clear();
    this.touch(0, n);
  }

  /** claims a slot for instance `id` and writes it; `world` is the instance matrix (the row's world matrix × its shape scale) */
  add(id: number, world: ArrayLike<number>, paint: Readonly<SurfacePaint>): void {
    if (this.#slots.has(id)) throw new Error(`primitive bucket ${this.key}: instance ${id} is already in it`);
    if (this.count === this.capacity) this.grow(this.capacity * 2);
    const slot = this.count++;
    this.#ids[slot] = id;
    this.#slots.set(id, slot);
    this.#countChanged = true;
    this.#writeMatrix(slot, world);
    this.#writePaint(slot, paint);
    this.touch(slot, slot + 1);
  }

  has(id: number): boolean {
    return this.#slots.has(id);
  }

  setMatrix(id: number, world: ArrayLike<number>): void {
    const slot = this.#slot(id);
    this.#writeMatrix(slot, world);
    this.touch(slot, slot + 1);
  }

  setPaint(id: number, paint: Readonly<SurfacePaint>): void {
    const slot = this.#slot(id);
    this.#writePaint(slot, paint);
    this.touch(slot, slot + 1);
  }

  /** frees the instance's slot: the last instance moves into it */
  remove(id: number): void {
    const slot = this.#slot(id);
    const last = this.count - 1;
    if (slot !== last) {
      this.matrices.copyWithin(slot * 16, last * 16, last * 16 + 16);
      for (const a of [this.albedo, this.emissive, this.extra]) a.copyWithin(slot * 4, last * 4, last * 4 + 4);
      const moved = this.#ids[last]!;
      this.#ids[slot] = moved;
      this.#slots.set(moved, slot);
      this.touch(slot, slot + 1);
    }
    this.#ids.length = last;
    this.#slots.delete(id);
    this.count = last;
    this.#countChanged = true;
  }

  #slot(id: number): number {
    const slot = this.#slots.get(id);
    if (slot === undefined) throw new Error(`primitive bucket ${this.key}: no instance ${id}`);
    return slot;
  }

  #writeMatrix(slot: number, instance: ArrayLike<number>): void {
    const o = slot * 16;
    for (let i = 0; i < 16; i++) this.matrices[o + i] = instance[i]!;
  }

  #writePaint(slot: number, p: Readonly<SurfacePaint>): void {
    const o = slot * 4;
    this.albedo[o] = p.color[0];
    this.albedo[o + 1] = p.color[1];
    this.albedo[o + 2] = p.color[2];
    this.albedo[o + 3] = p.opacity;
    this.emissive[o] = p.emissive[0];
    this.emissive[o + 1] = p.emissive[1];
    this.emissive[o + 2] = p.emissive[2];
    this.emissive[o + 3] = p.roughness;
    this.extra[o] = p.metalness;
    this.extra[o + 1] = p.uvScale[0];
    this.extra[o + 2] = p.uvScale[1];
    this.extra[o + 3] = 0;
  }

  /** rebinds the bucket's albedo texture (the real texture of a name that drew white so far) */
  setTexture(texture: Texture): void {
    if (this.#textureNode) this.#textureNode.value = texture;
  }

  /** the texture the bucket samples now; null when it has none */
  get texture(): Texture | null {
    return this.#textureNode?.value ?? null;
  }

  /** the union of the live instances' spheres, written to the mesh's own `boundingSphere` */
  refreshBounds(): void {
    const acc = [0, 0, 0, -1];
    const c = this.#unitSphere.center;
    const r = this.#unitSphere.radius;
    const m = this.matrices;
    const s = [0, 0, 0, 0];
    for (let i = 0; i < this.count; i++) {
      const o = i * 16;
      s[0] = m[o]! * c.x + m[o + 4]! * c.y + m[o + 8]! * c.z + m[o + 12]!;
      s[1] = m[o + 1]! * c.x + m[o + 5]! * c.y + m[o + 9]! * c.z + m[o + 13]!;
      s[2] = m[o + 2]! * c.x + m[o + 6]! * c.y + m[o + 10]! * c.z + m[o + 14]!;
      const sx = m[o]! * m[o]! + m[o + 1]! * m[o + 1]! + m[o + 2]! * m[o + 2]!;
      const sy = m[o + 4]! * m[o + 4]! + m[o + 5]! * m[o + 5]! + m[o + 6]! * m[o + 6]!;
      const sz = m[o + 8]! * m[o + 8]! + m[o + 9]! * m[o + 9]! + m[o + 10]! * m[o + 10]!;
      s[3] = r * Math.sqrt(Math.max(sx, sy, sz));
      unionSphere(acc, s);
    }
    const sphere = this.mesh.boundingSphere!;
    sphere.center.set(acc[0]!, acc[1]!, acc[2]!);
    sphere.radius = Math.max(0, acc[3]!);
  }

  /** applies what was written since the last call: `count`, the written ranges, visibility, the bounds. Once per frame. */
  flush(): void {
    const mesh = this.mesh;
    this.#flushes++;
    if (this.#dirtyTo > this.#dirtyFrom) {
      const from = this.#dirtyFrom, to = Math.min(this.#dirtyTo, this.count);
      if (to > from) {
        const im = mesh.instanceMatrix;
        im.clearUpdateRanges();
        im.addUpdateRange(from * 16, (to - from) * 16);
        im.needsUpdate = true;
        for (const name of [PRIMITIVE_ALBEDO, PRIMITIVE_EMISSIVE, PRIMITIVE_EXTRA]) {
          const a = mesh.geometry.getAttribute(name) as InstancedBufferAttribute;
          a.clearUpdateRanges();
          a.addUpdateRange(from * 4, (to - from) * 4);
          a.needsUpdate = true;
        }
      }
    }
    const moved = this.#dirtyTo > this.#dirtyFrom;
    this.#dirtyFrom = Infinity;
    this.#dirtyTo = -Infinity;
    mesh.count = this.count;
    mesh.visible = this.count > 0;
    mesh.frustumCulled = !this.spansMap;
    if (!this.spansMap && this.count > 0 && (this.#countChanged || (moved && this.#flushes % BOUNDS_FRAMES === 0) || this.#flushes % BOUNDS_FRAMES === 0)) this.refreshBounds();
    this.#countChanged = false;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    this.material.dispose();
  }
}

export interface PrimitiveBucketsOptions {
  /** the lighting module; null (it failed to load in production): every bucket is unlit */
  script: LightingScript | null;
  /** where bucket meshes are added (`SceneRoot.world`) */
  parent: Object3D;
  /** first capacity of a bucket (a power of two; default 16) */
  capacity?: number;
  /** a texture by the name a row material gives; undefined: not there (yet) */
  resolveTexture?: (name: string) => Texture | undefined;
  log?: (message: string) => void;
}

export interface PrimitiveHandle {
  readonly id: number;
  readonly bucket: PrimitiveBucket;
}

/** The primitive buckets of a scene (render §6.7): claim, write and release instances; `flush()` once per frame. */
export class PrimitiveBuckets {
  readonly #opts: PrimitiveBucketsOptions;
  readonly #buckets = new Map<string, PrimitiveBucket>();
  readonly #units = new Map<string, BufferGeometry>();
  readonly #warned = new Set<string>();
  #nextId = 1;

  constructor(opts: PrimitiveBucketsOptions) {
    this.#opts = opts;
  }

  #log(message: string): void {
    if (this.#warned.has(message)) return;
    this.#warned.add(message);
    (this.#opts.log ?? ((m: string) => console.warn(m)))(`[primitives] ${message}`);
  }

  /** the bucket of a (primitive, material) pair, created on first use */
  bucketFor(spec: PrimitiveSpec, material?: StandardMaterialSpec | null): { bucket: PrimitiveBucket; look: BucketLook } {
    const shape = primitiveShape(spec);
    const look = primitiveLook(material);
    const key = `${shape.geometryKey}|${look.key}`;
    let bucket = this.#buckets.get(key);
    if (!bucket) {
      let unit = this.#units.get(shape.geometryKey);
      if (!unit) {
        unit = shape.create();
        this.#units.set(shape.geometryKey, unit);
      }
      const dropped = look.params.variant & ~look.variant;
      if (dropped !== 0) this.#log(`a primitive material asks for ${describeVariant(dropped)}, which primitive buckets do not build: drawn without`);
      if (look.params.unsupported.length > 0) this.#log(`a primitive material uses ${look.params.unsupported.join(', ')}: not implemented, drawn without`);
      const name = look.params.textures.albedo;
      const resolved = name === null ? null : (this.#opts.resolveTexture?.(name) ?? null);
      let capacity = 4;
      while (capacity < (this.#opts.capacity ?? 16)) capacity *= 2;
      bucket = new PrimitiveBucket(key, shape, look, unit, buildBucketMaterial(look, this.#opts.script, resolved), capacity, this.#opts.parent);
      this.#buckets.set(key, bucket);
    }
    return { bucket, look };
  }

  /** Adds a primitive row: `world` is its world matrix (column-major), feet at the origin. */
  add(spec: PrimitiveSpec, material: StandardMaterialSpec | null | undefined, world: ArrayLike<number>): PrimitiveHandle {
    const { bucket, look } = this.bucketFor(spec, material);
    // the live engine did not draw a material with only `{color}`; the game never relies on it and the port draws it
    if (isColorOnlyMaterial(material)) this.#log('a primitive material has only `color`: the live engine did not draw it, the port does');
    // the instance matrix is the row's world matrix times the scale that sizes the unit geometry for this row
    const id = this.#nextId++;
    const [sx, sy, sz] = primitiveShape(spec).scale;
    bucket.add(id, _m.fromArray(world).multiply(_s.makeScale(sx, sy, sz)).elements, look.params.paint);
    return { id, bucket };
  }

  setMatrix(handle: PrimitiveHandle, spec: PrimitiveSpec, world: ArrayLike<number>): void {
    const [sx, sy, sz] = primitiveShape(spec).scale;
    handle.bucket.setMatrix(handle.id, _m.fromArray(world).multiply(_s.makeScale(sx, sy, sz)).elements);
  }

  /** writes the per-instance part of a row material (the row must stay in its bucket: structure changes are remove + add) */
  setMaterial(handle: PrimitiveHandle, material: StandardMaterialSpec | null | undefined): void {
    const look = primitiveLook(material);
    if (look.key !== handle.bucket.look.key) throw new Error('primitive: the new material belongs to another bucket (remove the instance and add it again)');
    handle.bucket.setPaint(handle.id, look.params.paint);
  }

  remove(handle: PrimitiveHandle): void {
    handle.bucket.remove(handle.id);
  }

  /** supplies the texture of a name (RH1's script textures, a loaded file): every bucket that drew white for it switches */
  setTexture(name: string, texture: Texture): void {
    for (const b of this.#buckets.values()) if (b.textureName === name) b.setTexture(texture);
  }

  /** once per frame, after the writes */
  flush(): void {
    for (const b of this.#buckets.values()) b.flush();
  }

  buckets(): PrimitiveBucket[] {
    return [...this.#buckets.values()];
  }

  /** buckets with at least one instance: the draw calls of the primitive line (render §15.5) */
  get draws(): number {
    let n = 0;
    for (const b of this.#buckets.values()) if (b.count > 0) n++;
    return n;
  }

  dispose(): void {
    for (const b of this.#buckets.values()) b.dispose();
    this.#buckets.clear();
    for (const g of this.#units.values()) g.dispose();
    this.#units.clear();
  }
}
