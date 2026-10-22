// ModelTemplate (docs/design/rendering.md §11.2 normalisation, §11.3, §7.2 bone classes; D10; WP R6): one loaded model, merged
// into one geometry drawn by one opaque and one transparent mesh, with the name maps the runtime addresses it by.
//
// Built once per model id from the glTF scene `GLTFLoader` returns:
//   1. every mesh primitive becomes a run of vertices in one merged geometry (our own merge: the primitives of a model do not
//      share an attribute set) with float `position` and `normal`, `uv` when the model has a texture set, `skinIndex` /
//      `skinWeight` when it has a skeleton, and `ss`: four normalized bytes (part id, slot id, paint id low, paint id high;
//      the shader reads `round(ss · 255)`).
//        part id   bit index of the primitive's node in the look row's part mask: `part_*` and `cap_*` nodes first, then every
//                  other named mesh node, in file order; 255 = never hidden (more named nodes than the mask has bits)
//        slot id   index of the primitive's material name in the model's slot table (`model.materials[<name>]`)
//        paint id  index of the material's factors in the shared model paint table (surface/look-table.ts), table-wide, so
//                  geometries of several models can share one material and one batch
//   2. a rigid mesh under a bone becomes skinned vertices with weight 1 on that bone
//   3. both meshes use the merged geometry; each pass draws its own triangles (the surface collapses what the other pass owns
//      and what the part mask hides), so a character is one draw, plus one while a slot blends
//   4. normalisation (`spawn-engine-contract.md` §9.8, the asset index's stage-4 facts): the bind-pose box, skin-aware, is moved
//      so `min.y = 0`; x and z stay as authored (which is what the facts record); the model is scaled only when its height is
//      off the facts' by more than the 0.2 mm tolerance. A skinned model takes it on its rig container, a static one in its
//      vertices. glTF, three and Spawn are right-handed, +Y up, −Z forward: no root flip.
//   5. bounds are object-level and pose-independent on a skinned mesh: `SkinnedMesh.computeBoundingSphere()` would CPU-skin
//      every vertex at whatever pose the mesh has and keep that sphere forever. The sphere sits at the root origin (the feet)
//      with radius 1.25 · H + the model's largest horizontal reach, which holds the standing pose and a body lying in any
//      direction from its feet; the box is the cube around it. Nothing here or in model-instance.ts calls
//      `computeBoundingSphere` / `computeBoundingBox` on a skinned mesh. A static model keeps its geometry's exact bounds.
//   6. the skeleton is padded to a bone-count class (32, 64 or 128): three puts `skeleton.bones.length` into the skinning
//      shader, so rigs of 24 and 31 bones would otherwise be two programs. The tail entries are one extra identity `Bone` with
//      identity inverses that no vertex weight names; it is not in `boneNodes`.
//
// The loader's `MeshStandardMaterial`s are read for their factors and maps and dropped: the meshes carry `SurfaceMaterial`s
// (variant SRC_GLTF | SLOTS | PARTMASK, + TEX_SLOTS_n, + SIDE_DOUBLE, + TRANSPARENT on the blend mesh).
//
// A model whose mesh nodes or materials have no name fails the build: the game addresses parts and slots by name
// (`part_<region>`, `cap_*`, `skin.001`), and the asset pipeline must keep them (`asset-inventory.md` §12.5 step 3).
import { Bone, Box3, BufferAttribute, BufferGeometry, DoubleSide, Matrix3, Matrix4, Mesh, Object3D, Skeleton, SkinnedMesh, Sphere, Vector3 } from 'three/webgpu';
import type { Material, Texture } from 'three/webgpu';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { FactBounds } from '../../assets/index-types.ts';
import { ALPHA_OPAQUE, LOOK_MAX_PARTS, LOOK_MAX_SLOTS, PART_NEVER_HIDDEN, type ModelPaint, type ModelPaintTable } from '../surface/look-table.ts';
import { SurfaceVariant, type AnySurfaceMaterial, type SurfaceMaterials, type SurfaceSlotTextures } from '../surface/surface-material.ts';
import type { TextureCache } from './texture-cache.ts';

// ── bone-count classes ──────────────────────────────────────────────────────────────────────────────────────────────────

export const BONE_CLASSES = [32, 64, 128] as const;
export type BoneClass = (typeof BONE_CLASSES)[number];

/** The smallest class that holds `count` bones (render §7.2); throws above 128. */
export function boneClassOf(count: number): BoneClass {
  for (const c of BONE_CLASSES) if (count <= c) return c;
  throw new RangeError(`a skeleton of ${count} bones is above the largest bone-count class (${BONE_CLASSES[BONE_CLASSES.length - 1]})`);
}

/**
 * The parent of a model's bone hierarchy. On the direct bone-matrix path (model-instance.ts) it ends three's
 * `updateMatrixWorld` walk: the bones under it are written by the skin adapter, and walking them would only cost calls.
 */
export class RigContainer extends Object3D {
  readonly isRigContainer = true;
  /** true on the direct path */
  skipChildren = false;

  override updateMatrixWorld(force?: boolean): void {
    if (!this.skipChildren) {
      super.updateMatrixWorld(force);
      return;
    }
    if (this.matrixAutoUpdate) this.updateMatrix();
    if (this.matrixWorldNeedsUpdate || force === true) {
      if (this.matrixWorldAutoUpdate) {
        if (this.parent === null) this.matrixWorld.copy(this.matrix);
        else this.matrixWorld.multiplyMatrices(this.parent.matrixWorld, this.matrix);
      }
      this.matrixWorldNeedsUpdate = false;
    }
  }
}

/** name of the padding bone of a class skeleton */
export const PAD_BONE_NAME = 'ss_pad';

/** bounds tolerance of the asset pipeline (`asset-inventory.md` §12.5): a height inside it is not rescaled */
export const BOUNDS_TOLERANCE_M = 0.0002;

/** radius of a skinned model's sphere = this × height + horizontal reach (render §11.3 step 4) */
export const SKINNED_BOUNDS_HEIGHT_FACTOR = 1.25;

// ── the source ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ModelSource {
  /** the model's id (CDN name), for messages */
  name: string;
  /** the loaded scene; the build takes it over (bones and sockets move into the template) */
  scene: Object3D;
  /**
   * The file's node behind an object (a primitive's node, a bone, a socket): its glTF name (three sanitises `Object3D.name`:
   * `Spine.001` loses its dot; '' = the file has none) and its index in the file. Undefined = not a file node, the object's
   * own name and the scene order are used.
   */
  nodeOf?: (object: Object3D) => { name: string; index: number } | undefined;
  /** index of a material in the file: slots are numbered in that order; undefined = in order of first use */
  materialIndexOf?: (material: Material) => number | undefined;
  /** the asset index's facts (`[minX, 0, minZ, maxX, height, maxZ]`); none = stand the model on y = 0 as it is */
  bounds?: FactBounds | null;
}

/** A `GLTFLoader` result as a source: node names and the file order come from the file's JSON through the parser's associations. */
export function modelSourceFromGltf(name: string, gltf: GLTF, bounds?: FactBounds | null): ModelSource {
  const nodes = (gltf.parser.json as { nodes?: Array<{ name?: string }> }).nodes ?? [];
  const associations = gltf.parser.associations;
  const nodeOf = (object: Object3D): { name: string; index: number } | undefined => {
    // a primitive of a multi-primitive mesh is a child of its node's group
    for (let o: Object3D | null = object, hops = 0; o !== null && hops < 2; o = o.parent, hops++) {
      const index = associations.get(o)?.nodes;
      if (index !== undefined) return { name: nodes[index]?.name ?? '', index };
    }
    return undefined;
  };
  const materialIndexOf = (material: Material): number | undefined => associations.get(material)?.materials;
  return { name, scene: gltf.scene, nodeOf, materialIndexOf, ...(bounds === undefined ? {} : { bounds }) };
}

// ── the merge ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** the factors and maps the build reads off a loader material */
interface LoaderMaterial extends Material {
  color?: { r: number; g: number; b: number };
  emissive?: { r: number; g: number; b: number };
  emissiveIntensity?: number;
  roughness?: number;
  metalness?: number;
  map?: Texture | null;
  normalMap?: Texture | null;
  roughnessMap?: Texture | null;
  metalnessMap?: Texture | null;
  emissiveMap?: Texture | null;
}

/** the merged geometry as typed arrays (the corpse baker skins from these, render §11.5) */
export interface ModelArrays {
  vertexCount: number;
  /** 3 per vertex: bind space on a skinned model, normalised model space on a static one */
  position: Float32Array;
  normal: Float32Array;
  /** 2 per vertex; null when the model has no texture set */
  uv: Float32Array | null;
  /** 4 per vertex, indices into the class skeleton; null on a static model */
  skinIndex: Uint8Array | null;
  /** 4 per vertex, summing to 1 */
  skinWeight: Float32Array | null;
  /** 4 per vertex: part id, slot id, paint id low, paint id high */
  partPaint: Uint8Array;
  index: Uint16Array | Uint32Array;
}

export interface ModelMaterialInfo {
  /** glTF material name */
  name: string;
  slot: number;
  /** factors; `texSet` indexes `MergedModel.textureSets` (+1), 0 = none */
  paint: ModelPaint;
  doubleSided: boolean;
}

/** What `mergeModel` returns: the template's data, before it takes paint ids and materials. */
export interface MergedModel {
  name: string;
  arrays: ModelArrays;
  /** the `ss` paint bytes hold indices into this list until the template adds its block start */
  materials: ModelMaterialInfo[];
  /** per texture set, the loader's textures (albedo, normal, ORM) */
  textureSets: Array<{ albedo: Texture; normal: Texture | null; orm: Texture | null }>;
  partBits: Map<string, number>;
  /** named mesh nodes past the mask's 128 bits: they cannot be hidden */
  unmaskable: string[];
  slotIds: Map<string, number>;
  slotNames: string[];
  /** null on a static model */
  skeleton: Skeleton | null;
  /** real bones (before padding) */
  boneCount: number;
  boneClass: BoneClass | null;
  /** real bones by glTF node name */
  boneNodes: Map<string, Bone>;
  /** glTF node names of the real bones, in skeleton order */
  boneNames: string[];
  socketNodes: Map<string, Object3D>;
  /** the bone hierarchy under its normalisation container; null on a static model without sockets */
  rig: RigContainer | null;
  /** glTF scene space → template root space (the normalisation) */
  rigMatrix: Matrix4;
  /** the bind-pose box after normalisation: what the asset facts record */
  restBox: Box3;
  height: number;
  /** largest horizontal distance of the bind-pose box from the root's vertical axis */
  reach: number;
  scale: number;
  /** content the build read but does not carry (one line each) */
  warnings: string[];
}

interface Prim {
  mesh: Mesh;
  node: string;
  material: LoaderMaterial;
  /** file index of the node, of the material */
  order: number;
  materialOrder: number;
}

const SOCKET_NAME = /^sock\d*_/;
const PART_NAME = /^(part|cap)_/;

function fail(model: string, what: string): never {
  throw new Error(`model ${model}: ${what}`);
}

/** Merges a loaded scene into template data (steps 1, 2, 4 and 6 of the header). Takes the scene apart. */
export function mergeModel(source: ModelSource): MergedModel {
  const { name, scene } = source;
  // a bone or socket the file leaves unnamed keeps three's name for it; a mesh node must be named (below)
  const nodeNameOf = (o: Object3D): string => source.nodeOf?.(o)?.name || o.name;
  const warnings: string[] = [];
  scene.updateMatrixWorld(true);

  // the primitives and the skeleton
  const prims: Prim[] = [];
  const skeletons = new Set<Skeleton>();
  scene.traverse((o) => {
    const mesh = o as Mesh;
    if (mesh.isMesh !== true) return;
    if (Array.isArray(mesh.material)) fail(name, `mesh "${o.name}" has a material array (one material per primitive is expected)`);
    const fileNode = source.nodeOf?.(o);
    const node = fileNode !== undefined ? fileNode.name : o.name;
    if (node === '') fail(name, 'a mesh node has no name; the asset pipeline must keep node names (asset-inventory.md §12.5)');
    const material = mesh.material as LoaderMaterial;
    if (material.name === '') fail(name, `the material of node "${node}" has no name; the asset pipeline must keep material names (asset-inventory.md §12.5)`);
    prims.push({ mesh, node, material, order: fileNode?.index ?? Number.MAX_SAFE_INTEGER, materialOrder: source.materialIndexOf?.(material) ?? Number.MAX_SAFE_INTEGER });
    const skinned = o as SkinnedMesh;
    if (skinned.isSkinnedMesh === true) skeletons.add(skinned.skeleton);
  });
  if (prims.length === 0) fail(name, 'no mesh');
  // file order: nodes by index (a stable sort keeps a node's primitives in their own order)
  prims.sort((a, b) => a.order - b.order);
  if (skeletons.size > 1) fail(name, `${skeletons.size} skeletons (one per model is expected)`);
  const sourceSkeleton = skeletons.size === 1 ? [...skeletons][0]! : null;
  const boneCount = sourceSkeleton?.bones.length ?? 0;
  const boneClass = sourceSkeleton === null ? null : boneClassOf(boneCount);
  const boneIndex = new Map<Object3D, number>();
  sourceSkeleton?.bones.forEach((b, i) => boneIndex.set(b, i));

  // parts: `part_*` and `cap_*` first, then the other named mesh nodes, each group in file order
  const partBits = new Map<string, number>();
  const unmaskable: string[] = [];
  const nodeNames = [...new Set(prims.map((p) => p.node))];
  for (const n of [...nodeNames.filter((x) => PART_NAME.test(x)), ...nodeNames.filter((x) => !PART_NAME.test(x))]) {
    if (partBits.size < LOOK_MAX_PARTS) partBits.set(n, partBits.size);
    else unmaskable.push(n);
  }
  if (unmaskable.length > 0) warnings.push(`${unmaskable.length} mesh node(s) past the ${LOOK_MAX_PARTS}-bit part mask cannot be hidden: ${unmaskable.slice(0, 4).join(', ')}${unmaskable.length > 4 ? ', …' : ''}`);

  // slots (material names) and paints (materials)
  const slotIds = new Map<string, number>();
  const slotNames: string[] = [];
  const materials: ModelMaterialInfo[] = [];
  const materialIndex = new Map<Material, number>();
  const textureSets: MergedModel['textureSets'] = [];
  const setIndex = new Map<string, number>();
  for (const p of [...prims].sort((a, b) => a.materialOrder - b.materialOrder)) {
    const m = p.material;
    if (materialIndex.has(m)) continue;
    let slot = slotIds.get(m.name);
    if (slot === undefined) {
      slot = slotNames.length;
      slotIds.set(m.name, slot);
      slotNames.push(m.name);
    }
    let texSet = 0;
    const orm = m.roughnessMap ?? m.metalnessMap ?? null;
    if (m.map !== null && m.map !== undefined) {
      const key = `${m.map.source.uuid}|${m.normalMap?.source.uuid ?? ''}|${orm?.source.uuid ?? ''}`;
      let at = setIndex.get(key);
      if (at === undefined) {
        at = textureSets.length;
        setIndex.set(key, at);
        textureSets.push({ albedo: m.map, normal: m.normalMap ?? null, orm });
      }
      texSet = at + 1;
    } else if ((m.normalMap ?? null) !== null || orm !== null) warnings.push(`material "${m.name}": normal / ORM maps without a base colour texture are not carried`);
    if ((m.emissiveMap ?? null) !== null) warnings.push(`material "${m.name}": the emissive texture is not carried (its factor is)`);
    if (m.alphaTest > 0) warnings.push(`material "${m.name}": alphaMode MASK is drawn opaque (no cutout is live)`);
    const k = m.emissiveIntensity ?? 1;
    const e = m.emissive ?? { r: 0, g: 0, b: 0 };
    const c = m.color ?? { r: 1, g: 1, b: 1 };
    materialIndex.set(m, materials.length);
    materials.push({
      name: m.name,
      slot,
      doubleSided: m.side === DoubleSide,
      paint: { albedo: [c.r, c.g, c.b], alpha: m.transparent ? m.opacity : 1, emissive: [e.r * k, e.g * k, e.b * k], roughness: m.roughness ?? 1, metalness: m.metalness ?? 0, texSet },
    });
  }
  if (textureSets.length > 3) fail(name, `${textureSets.length} texture sets (a template binds at most 3, TEX_SLOTS_n)`);
  if (slotNames.length > LOOK_MAX_SLOTS) warnings.push(`${slotNames.length - LOOK_MAX_SLOTS} material slot(s) past the look row's ${LOOK_MAX_SLOTS} cannot be overridden: ${slotNames.slice(LOOK_MAX_SLOTS).join(', ')}`);
  if (slotNames.length > 255 || materials.length > 65535) fail(name, 'too many materials');

  // sizes
  let vertexCount = 0;
  let indexCount = 0;
  for (const p of prims) {
    const g = p.mesh.geometry;
    const pos = g.getAttribute('position');
    if (pos === undefined) fail(name, `node "${p.node}" has a primitive without POSITION`);
    vertexCount += pos.count;
    indexCount += g.index !== null ? g.index.count : pos.count;
  }
  const withUv = textureSets.length > 0;
  const arrays: ModelArrays = {
    vertexCount,
    position: new Float32Array(vertexCount * 3),
    normal: new Float32Array(vertexCount * 3),
    uv: withUv ? new Float32Array(vertexCount * 2) : null,
    skinIndex: sourceSkeleton !== null ? new Uint8Array(vertexCount * 4) : null,
    skinWeight: sourceSkeleton !== null ? new Float32Array(vertexCount * 4) : null,
    partPaint: new Uint8Array(vertexCount * 4),
    index: vertexCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount),
  };

  // the bind-pose matrices of the bones (rest pose × inverse bind), for the rigid conversion and the rest box
  let restMatrices: Float32Array | null = null;
  if (sourceSkeleton !== null) {
    sourceSkeleton.update();
    restMatrices = Float32Array.from(sourceSkeleton.boneMatrices as ArrayLike<number>).subarray(0, boneCount * 16);
  }

  const v = new Vector3();
  const m4 = new Matrix4();
  const inv = new Matrix4();
  const n3 = new Matrix3();
  const restBox = new Box3();
  const identity = new Matrix4();
  let vAt = 0;
  let iAt = 0;
  for (const p of prims) {
    const g = p.mesh.geometry;
    const pos = g.getAttribute('position');
    let normals = g.getAttribute('normal');
    if (normals === undefined) {
      const withNormals = g.clone();
      withNormals.computeVertexNormals();
      normals = withNormals.getAttribute('normal');
    }
    const uvs = g.getAttribute('uv');
    const count = pos.count;
    const skinned = p.mesh as SkinnedMesh;
    const isSkinned = skinned.isSkinnedMesh === true;
    const part = partBits.get(p.node) ?? PART_NEVER_HIDDEN;
    const paintLocal = materialIndex.get(p.material)!;
    const slot = materials[paintLocal]!.slot;

    // the matrix that takes the primitive's vertices into the merged geometry's space
    let rigidBone = -1;
    if (sourceSkeleton === null) m4.copy(p.mesh.matrixWorld);
    else if (isSkinned) m4.copy(skinned.bindMatrix);
    else {
      for (let o: Object3D | null = p.mesh.parent; o !== null; o = o.parent) {
        const b = boneIndex.get(o);
        if (b !== undefined) {
          rigidBone = b;
          break;
        }
      }
      if (rigidBone < 0) fail(name, `node "${p.node}" is a rigid mesh outside the skeleton of a skinned model`);
      // bind-space position q with boneRest × invBind × q = meshWorld × v
      inv.fromArray(restMatrices!, rigidBone * 16).invert();
      m4.multiplyMatrices(inv, p.mesh.matrixWorld);
    }
    const plain = m4.equals(identity);
    n3.getNormalMatrix(m4);

    const si = isSkinned ? g.getAttribute('skinIndex') : undefined;
    const sw = isSkinned ? g.getAttribute('skinWeight') : undefined;
    if (isSkinned && (si === undefined || sw === undefined)) fail(name, `node "${p.node}" is skinned but has no JOINTS_0 / WEIGHTS_0`);

    for (let i = 0; i < count; i++) {
      const o3 = (vAt + i) * 3;
      v.fromBufferAttribute(pos, i);
      if (!plain) v.applyMatrix4(m4);
      arrays.position[o3] = v.x;
      arrays.position[o3 + 1] = v.y;
      arrays.position[o3 + 2] = v.z;
      v.fromBufferAttribute(normals, i);
      if (!plain) v.applyMatrix3(n3);
      v.normalize();
      arrays.normal[o3] = v.x;
      arrays.normal[o3 + 1] = v.y;
      arrays.normal[o3 + 2] = v.z;
      if (arrays.uv !== null && uvs !== undefined) {
        arrays.uv[(vAt + i) * 2] = uvs.getX(i);
        arrays.uv[(vAt + i) * 2 + 1] = uvs.getY(i);
      }
      const o4 = (vAt + i) * 4;
      arrays.partPaint[o4] = part;
      arrays.partPaint[o4 + 1] = slot;
      arrays.partPaint[o4 + 2] = paintLocal & 255;
      arrays.partPaint[o4 + 3] = paintLocal >> 8;
      if (arrays.skinIndex !== null && arrays.skinWeight !== null) {
        if (si !== undefined && sw !== undefined) {
          let sum = 0;
          for (let k = 0; k < 4; k++) {
            const w = sw.getComponent(i, k);
            arrays.skinIndex[o4 + k] = w > 0 ? si.getComponent(i, k) : 0;
            arrays.skinWeight[o4 + k] = w;
            sum += w;
          }
          if (sum > 0) for (let k = 0; k < 4; k++) arrays.skinWeight[o4 + k] = arrays.skinWeight[o4 + k]! / sum;
          else arrays.skinWeight[o4] = 1;
        } else {
          arrays.skinIndex[o4] = rigidBone;
          arrays.skinWeight[o4] = 1;
        }
      }
    }
    if (g.index !== null) for (let i = 0; i < g.index.count; i++) arrays.index[iAt + i] = g.index.getX(i) + vAt;
    else for (let i = 0; i < count; i++) arrays.index[iAt + i] = vAt + i;
    iAt += g.index !== null ? g.index.count : count;
    vAt += count;
  }

  // the rest box in glTF scene space: skinned vertices at the rest pose, static ones as written
  const { position, skinIndex, skinWeight } = arrays;
  for (let i = 0; i < vertexCount; i++) {
    const x = position[i * 3]!;
    const y = position[i * 3 + 1]!;
    const z = position[i * 3 + 2]!;
    if (restMatrices === null || skinIndex === null || skinWeight === null) {
      restBox.expandByPoint(v.set(x, y, z));
      continue;
    }
    let sx = 0;
    let sy = 0;
    let sz = 0;
    for (let k = 0; k < 4; k++) {
      const w = skinWeight[i * 4 + k]!;
      if (w === 0) continue;
      const o = skinIndex[i * 4 + k]! * 16;
      sx += w * (restMatrices[o]! * x + restMatrices[o + 4]! * y + restMatrices[o + 8]! * z + restMatrices[o + 12]!);
      sy += w * (restMatrices[o + 1]! * x + restMatrices[o + 5]! * y + restMatrices[o + 9]! * z + restMatrices[o + 13]!);
      sz += w * (restMatrices[o + 2]! * x + restMatrices[o + 6]! * y + restMatrices[o + 10]! * z + restMatrices[o + 14]!);
    }
    restBox.expandByPoint(v.set(sx, sy, sz));
  }

  // normalisation
  const measured = restBox.max.y - restBox.min.y;
  const facts = source.bounds ?? null;
  let scale = 1;
  if (facts !== null && measured > 0) {
    const wanted = facts[4] - facts[1];
    if (wanted > 0 && Math.abs(wanted - measured) > BOUNDS_TOLERANCE_M) scale = wanted / measured;
  }
  const tx = facts !== null && scale !== 1 ? facts[0] - restBox.min.x * scale : 0;
  const tz = facts !== null && scale !== 1 ? facts[2] - restBox.min.z * scale : 0;
  const ty = -restBox.min.y * scale;
  const rigMatrix = new Matrix4().makeScale(scale, scale, scale).setPosition(tx, ty, tz);
  restBox.applyMatrix4(rigMatrix);
  if (sourceSkeleton === null) {
    for (let i = 0; i < vertexCount; i++) {
      position[i * 3] = position[i * 3]! * scale + tx;
      position[i * 3 + 1] = position[i * 3 + 1]! * scale + ty;
      position[i * 3 + 2] = position[i * 3 + 2]! * scale + tz;
    }
  }
  const height = restBox.max.y - restBox.min.y;
  const reach = Math.hypot(Math.max(Math.abs(restBox.min.x), Math.abs(restBox.max.x)), Math.max(Math.abs(restBox.min.z), Math.abs(restBox.max.z)));

  // name maps of the bones and sockets, by glTF name
  const boneNodes = new Map<string, Bone>();
  const boneNames: string[] = [];
  sourceSkeleton?.bones.forEach((b) => {
    const n = nodeNameOf(b);
    boneNames.push(n);
    // a repeated name keeps its first bone, as a lookup by name would find it
    if (!boneNodes.has(n)) boneNodes.set(n, b);
  });
  const socketNodes = new Map<string, Object3D>();
  scene.traverse((o) => {
    const n = nodeNameOf(o);
    if (SOCKET_NAME.test(n)) socketNodes.set(n, o);
  });

  // the rig: the scene without its meshes, under the normalisation
  let rig: RigContainer | null = null;
  let skeleton: Skeleton | null = null;
  if (sourceSkeleton !== null || socketNodes.size > 0) {
    for (const p of prims) {
      const o = p.mesh;
      if (o.children.length > 0) {
        // a mesh node with children (bones or sockets under it) stays as a plain node
        const stand = new Object3D();
        stand.name = o.name;
        stand.position.copy(o.position);
        stand.quaternion.copy(o.quaternion);
        stand.scale.copy(o.scale);
        for (const c of [...o.children]) stand.add(c);
        o.parent?.add(stand);
      }
      o.removeFromParent();
    }
    pruneEmpty(scene, new Set<Object3D>([...boneNodes.values(), ...socketNodes.values()]));
    rig = new RigContainer();
    rig.name = 'rig';
    rig.position.set(tx, ty, tz);
    rig.scale.setScalar(scale);
    rig.add(scene);
    if (sourceSkeleton !== null && boneClass !== null) {
      const bones = sourceSkeleton.bones.slice();
      const inverses = sourceSkeleton.boneInverses.slice();
      if (bones.length < boneClass) {
        const pad = new Bone();
        pad.name = PAD_BONE_NAME;
        rig.add(pad);
        while (bones.length < boneClass) {
          bones.push(pad);
          inverses.push(new Matrix4());
        }
      }
      skeleton = new Skeleton(bones, inverses);
    }
  }

  return {
    name,
    arrays,
    materials,
    textureSets,
    partBits,
    unmaskable,
    slotIds,
    slotNames,
    skeleton,
    boneCount,
    boneClass,
    boneNodes,
    boneNames,
    socketNodes,
    rig,
    rigMatrix,
    restBox,
    height,
    reach,
    scale,
    warnings,
  };
}

/** Removes childless nodes that are neither kept nor ancestors of a kept node (the emptied `part_*` groups). */
function pruneEmpty(root: Object3D, keep: ReadonlySet<Object3D>): void {
  const visit = (o: Object3D): boolean => {
    let needed = keep.has(o);
    for (const c of [...o.children]) {
      if (visit(c)) needed = true;
      else o.remove(c);
    }
    return needed;
  };
  visit(root);
}

// ── the template ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ModelTemplateEnv {
  materials: SurfaceMaterials;
  paint: ModelPaintTable;
  textures: TextureCache;
  /** extra variant bits of both materials (the viewmodel pass adds VIEWMODEL) */
  variant?: number;
}

export class ModelTemplate {
  readonly name: string;
  /** what instances clone: the opaque mesh, the transparent mesh and the rig */
  readonly root: Object3D;
  readonly geometry: BufferGeometry;
  readonly arrays: ModelArrays;
  readonly skinned: boolean;
  /** real bones; 0 on a static model */
  readonly boneCount: number;
  readonly boneClass: BoneClass | null;
  readonly skeleton: Skeleton | null;
  /** part bit by glTF node name (the look row's part mask) */
  readonly partBits: ReadonlyMap<string, number>;
  readonly unmaskable: readonly string[];
  /** slot id by glTF material name */
  readonly slotIds: ReadonlyMap<string, number>;
  readonly slotNames: readonly string[];
  /** real bones by glTF node name (the padding bone is not one) */
  readonly boneNodes: ReadonlyMap<string, Bone>;
  /** glTF node names of the real bones in skeleton order (the index a vertex's `skinIndex` names) */
  readonly boneNames: readonly string[];
  /** the real bones' rest matrices in root space, 16 per bone in skeleton order (the bind pose under the normalisation) */
  readonly restBoneMatrices: Float32Array;
  /** a `value.<sha>.glb` upload: the live engine resolves no sockets on these */
  readonly uploaded: boolean;
  /** `sock_*` nodes by glTF name */
  readonly socketNodes: ReadonlyMap<string, Object3D>;
  /** glTF scene space → root space: a bone's root-space matrix is `rigMatrix × its glTF model-space matrix` */
  readonly rigMatrix: Matrix4;
  /** the bind-pose box in root space (the asset facts' bounds) */
  readonly restBox: Box3;
  /** normalised height H */
  readonly height: number;
  readonly reach: number;
  readonly scale: number;
  /** the object-level bounds of the meshes, root space */
  readonly boundingSphere: Sphere;
  readonly boundingBox: Box3;
  readonly opaqueMesh: Mesh | SkinnedMesh;
  readonly transparentMesh: Mesh | SkinnedMesh;
  /** the model has paints with alpha < 1: the transparent mesh draws from the start */
  readonly hasBlendPaints: boolean;
  /** SurfaceVariant bits of the opaque material; the transparent one adds TRANSPARENT */
  readonly variant: number;
  readonly textureSets: readonly SurfaceSlotTextures[];
  /** first paint id of the model's block in the model paint table */
  readonly paintStart: number;
  readonly paintCount: number;
  readonly warnings: readonly string[];
  readonly #env: ModelTemplateEnv;
  #disposed = false;

  constructor(merged: MergedModel, env: ModelTemplateEnv) {
    this.#env = env;
    this.name = merged.name;
    this.arrays = merged.arrays;
    this.skinned = merged.skeleton !== null;
    this.boneCount = merged.boneCount;
    this.boneClass = merged.boneClass;
    this.skeleton = merged.skeleton;
    this.partBits = merged.partBits;
    this.unmaskable = merged.unmaskable;
    this.slotIds = merged.slotIds;
    this.slotNames = merged.slotNames;
    this.boneNodes = merged.boneNodes;
    this.boneNames = merged.boneNames;
    this.uploaded = /^value\.[0-9a-f]+\.glb$/.test(merged.name);
    this.socketNodes = merged.socketNodes;
    this.rigMatrix = merged.rigMatrix;
    this.restBox = merged.restBox;
    this.height = merged.height;
    this.reach = merged.reach;
    this.scale = merged.scale;
    this.warnings = merged.warnings;

    // paints: one block of the shared table; the `ss` bytes become table ids
    const { arrays } = merged;
    this.paintCount = merged.materials.length;
    this.paintStart = env.paint.allocate(this.paintCount);
    merged.materials.forEach((m, i) => env.paint.write(this.paintStart + i, m.paint));
    for (let i = 0; i < arrays.vertexCount; i++) {
      const id = this.paintStart + arrays.partPaint[i * 4 + 2]! + (arrays.partPaint[i * 4 + 3]! << 8);
      arrays.partPaint[i * 4 + 2] = id & 255;
      arrays.partPaint[i * 4 + 3] = id >> 8;
    }
    this.hasBlendPaints = merged.materials.some((m) => m.paint.alpha < ALPHA_OPAQUE);

    // textures: the canonical texture of each map's URL
    this.textureSets = merged.textureSets.map((s) => {
      const set: SurfaceSlotTextures = { albedo: env.textures.acquire(s.albedo, 'albedo', this) };
      if (s.normal !== null) set.normal = env.textures.acquire(s.normal, 'normal', this);
      if (s.orm !== null) set.orm = env.textures.acquire(s.orm, 'orm', this);
      return set;
    });

    // geometry
    const geometry = new BufferGeometry();
    geometry.name = merged.name;
    geometry.setAttribute('position', new BufferAttribute(arrays.position, 3));
    geometry.setAttribute('normal', new BufferAttribute(arrays.normal, 3));
    if (arrays.uv !== null) geometry.setAttribute('uv', new BufferAttribute(arrays.uv, 2));
    if (arrays.skinIndex !== null && arrays.skinWeight !== null) {
      geometry.setAttribute('skinIndex', new BufferAttribute(arrays.skinIndex, 4));
      geometry.setAttribute('skinWeight', new BufferAttribute(arrays.skinWeight, 4));
    }
    geometry.setAttribute('partPaint', new BufferAttribute(arrays.partPaint, 4, true));
    geometry.setIndex(new BufferAttribute(arrays.index, 1));
    this.geometry = geometry;

    // bounds
    if (this.skinned) {
      const radius = SKINNED_BOUNDS_HEIGHT_FACTOR * merged.height + merged.reach;
      this.boundingSphere = new Sphere(new Vector3(0, 0, 0), radius);
      this.boundingBox = new Box3(new Vector3(-radius, -radius, -radius), new Vector3(radius, radius, radius));
      // the geometry's own bounds are never the answer for a skinned mesh, but three's helpers read them: same values
      geometry.boundingSphere = this.boundingSphere.clone();
      geometry.boundingBox = this.boundingBox.clone();
    } else {
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      // hidden and other-pass vertices collapse to the origin, which may lie outside the model: keep it inside the bounds
      geometry.boundingBox!.expandByPoint(new Vector3(0, 0, 0));
      geometry.boundingBox!.getBoundingSphere(geometry.boundingSphere!);
      this.boundingSphere = geometry.boundingSphere!.clone();
      this.boundingBox = geometry.boundingBox!.clone();
    }

    // materials
    const V = SurfaceVariant;
    let variant = V.SRC_GLTF | V.SLOTS | V.PARTMASK | (env.variant ?? 0);
    if (this.textureSets.length > 0) variant |= this.textureSets.length << 9;
    if (merged.materials.some((m) => m.doubleSided)) variant |= V.SIDE_DOUBLE;
    this.variant = variant;
    const textures = this.textureSets.length > 0 ? { slots: this.textureSets } : {};
    const opaque = env.materials.get({ variant, textures });
    const transparent = modelBlendMaterial(env.materials.get({ variant: variant | V.TRANSPARENT, textures }));

    // meshes
    const make = (material: AnySurfaceMaterial, pass: string): Mesh | SkinnedMesh => {
      let mesh: Mesh | SkinnedMesh;
      if (merged.skeleton !== null) {
        const skinned = new SkinnedMesh(geometry, material);
        skinned.bind(merged.skeleton, new Matrix4());
        skinned.boundingSphere = this.boundingSphere.clone();
        skinned.boundingBox = this.boundingBox.clone();
        mesh = skinned;
      } else mesh = new Mesh(geometry, material);
      mesh.name = pass;
      mesh.receiveShadow = true;
      return mesh;
    };
    this.opaqueMesh = make(opaque, 'opaque');
    this.opaqueMesh.castShadow = true;
    this.transparentMesh = make(transparent, 'transparent');
    this.transparentMesh.visible = this.hasBlendPaints;

    const root = new Object3D();
    root.name = merged.name;
    root.add(this.opaqueMesh, this.transparentMesh);
    if (merged.rig !== null) root.add(merged.rig);
    root.updateMatrixWorld(true);
    this.root = root;
    this.restBoneMatrices = new Float32Array(this.boneCount * 16);
    merged.skeleton?.bones.slice(0, this.boneCount).forEach((b, i) => b.matrixWorld.toArray(this.restBoneMatrices, i * 16));
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  /** Frees the geometry, the paint block and the texture references (textures nobody else holds are disposed). */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.geometry.dispose();
    this.skeleton?.dispose();
    this.#env.paint.free(this.paintStart, this.paintCount);
    this.#env.textures.release(this);
  }
}

/** three draws a transparent double-sided material twice (back, then front) unless told otherwise (render §15.5) */
export function modelBlendMaterial<M extends AnySurfaceMaterial>(material: M): M {
  if (material.side === DoubleSide) material.forceSinglePass = true;
  return material;
}

/** Merges and builds in one call. */
export function buildModelTemplate(source: ModelSource, env: ModelTemplateEnv): ModelTemplate {
  return new ModelTemplate(mergeModel(source), env);
}
