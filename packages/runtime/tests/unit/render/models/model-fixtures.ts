// Synthetic model geometry and material environments for Node tests, without a renderer.
import { Document, NodeIO, type Node as GNode } from '@gltf-transform/core';
import { KHRMaterialsEmissiveStrength } from '@gltf-transform/extensions';
import { CompressedTexture, RGBA_ASTC_4x4_Format } from 'three/webgpu';
import { GLTFLoader, type GLTF, type GLTFParser } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type { FactBounds } from '../../../../src/assets/index-types.ts';
import { CachedKTX2Loader } from '../../../../src/render/models/loaders.ts';
import { TextureCache } from '../../../../src/render/models/texture-cache.ts';
import type { ModelTemplateEnv } from '../../../../src/render/models/model-template.ts';
import { LookTable, ModelPaintTable, registerModelStages } from '../../../../src/render/surface/look-table.ts';
import type { LightingScript } from '../../../../src/render/surface/script-types.ts';
import { SurfaceMaterials } from '../../../../src/render/surface/surface-material.ts';

// ── the model environment ───────────────────────────────────────────────────────────────────────────────────────────────

const script: LightingScript = { lighting: (_s, l) => l.ambient };

export interface TestEnv extends ModelTemplateEnv {
  look: LookTable;
  logs: string[];
}

export function testEnv(): TestEnv {
  const logs: string[] = [];
  const materials = new SurfaceMaterials({ script });
  const look = new LookTable({ log: (m) => logs.push(m) });
  const paint = new ModelPaintTable();
  registerModelStages(materials, { look, paint });
  return { materials, paint, look, textures: new TextureCache({ log: (m) => logs.push(m) }), logs };
}

// ── the fixture ─────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface FixtureOptions {
  /** joints of the skin (at least 9); default 24 */
  bones?: number;
  /** y of the feet in the file: the normalisation must take it out; default 0.25 */
  lift?: number;
  /** drop the name of this mesh node / material (the build must fail) */
  unnameNode?: string;
  unnameMaterial?: string;
  /** no skin: the same boxes as a static model */
  rigid?: boolean;
}

/** the fixture's body height and its largest |x| */
export const FIXTURE_HEIGHT = 1.8;
export const FIXTURE_ARM = 0.8;

interface Box {
  node: string;
  material: string;
  min: [number, number, number];
  max: [number, number, number];
  bone: string;
}

/** the named joints, in skin order; anything past them is a leaf `x_<i>` under Hips */
export const FIXTURE_BONES: ReadonlyArray<readonly [name: string, parent: string | null, y: number, x: number]> = [
  ['Hips', null, 0.9, 0],
  ['Spine.001', 'Hips', 1.0, 0],
  ['Head', 'Spine.001', 1.5, 0],
  ['LeftUpLeg', 'Hips', 0.8, -0.12],
  ['RightUpLeg', 'Hips', 0.8, 0.12],
  ['LeftArm', 'Spine.001', 1.4, -0.2],
  ['RightArm', 'Spine.001', 1.4, 0.2],
  ['RightHand', 'RightArm', 1.4, 0.7],
  ['sock_grip', 'RightHand', 1.4, 0.75],
];

/** the fixture's primitives: node, material, box (feet at y = 0), the bone it is skinned to */
export const FIXTURE_BOXES: readonly Box[] = [
  { node: 'part_pelvis', material: 'skin.001', min: [-0.2, 0.8, -0.1], max: [0.2, 1.0, 0.1], bone: 'Hips' },
  { node: 'part_torso', material: 'skin.001', min: [-0.2, 1.0, -0.1], max: [0.2, 1.5, 0.1], bone: 'Spine.001' },
  { node: 'part_torso', material: 'k_eye', min: [-0.05, 1.2, -0.12], max: [0.05, 1.3, -0.1], bone: 'Spine.001' },
  { node: 'part_torso_open', material: 'organ.001', min: [-0.18, 1.0, -0.09], max: [0.18, 1.5, 0.09], bone: 'Spine.001' },
  { node: 'part_head', material: 'skin.001', min: [-0.1, 1.5, -0.1], max: [0.1, 1.8, 0.1], bone: 'Head' },
  { node: 'part_visor', material: 'glass', min: [-0.1, 1.6, -0.12], max: [0.1, 1.7, -0.1], bone: 'Head' },
  { node: 'cap_head_stump', material: 'wound_flesh', min: [-0.1, 1.49, -0.1], max: [0.1, 1.5, 0.1], bone: 'Spine.001' },
  { node: 'part_thigh_l', material: 'skin.001', min: [-0.2, 0, -0.1], max: [-0.04, 0.8, 0.1], bone: 'LeftUpLeg' },
  { node: 'part_thigh_r', material: 'skin.001', min: [0.04, 0, -0.1], max: [0.2, 0.8, 0.1], bone: 'RightUpLeg' },
  { node: 'part_upperarm_l', material: 'skin.001', min: [-FIXTURE_ARM, 1.35, -0.05], max: [-0.2, 1.45, 0.05], bone: 'LeftArm' },
  { node: 'part_upperarm_r', material: 'skin.001', min: [0.2, 1.35, -0.05], max: [0.7, 1.45, 0.05], bone: 'RightArm' },
];
/** a rigid (unskinned) mesh node parented to the RightHand bone */
export const FIXTURE_RIGID: Box = { node: 'gear_blade', material: 'k_iron', min: [0.7, 1.3, -0.02], max: [0.78, 1.5, 0.02], bone: 'RightHand' };

export const FIXTURE_MATERIALS: Readonly<Record<string, { color: [number, number, number, number]; emissive?: [number, number, number]; strength?: number; roughness: number; metallic: number; blend?: boolean }>> = {
  'skin.001': { color: [0.5, 0.4, 0.3, 1], roughness: 0.7, metallic: 0 },
  k_eye: { color: [0.8, 0.7, 0.2, 1], emissive: [1, 0.5, 0.25], strength: 2, roughness: 0.3, metallic: 0 },
  'organ.001': { color: [0.6, 0.1, 0.1, 1], roughness: 0.35, metallic: 0 },
  glass: { color: [0.2, 0.6, 0.9, 0.4], roughness: 0.1, metallic: 0, blend: true },
  wound_flesh: { color: [0.5, 0.05, 0.05, 1], roughness: 0.45, metallic: 0 },
  k_iron: { color: [0.25, 0.25, 0.26, 1], roughness: 0.45, metallic: 0.8 },
};

/** 24 vertices, 36 indices: a box with per-face normals */
function boxGeometry(b: Box, lift: number): { position: Float32Array<ArrayBuffer>; normal: Float32Array<ArrayBuffer>; index: Uint16Array<ArrayBuffer> } {
  const [x0, y0, z0] = b.min;
  const [x1, y1, z1] = b.max;
  const faces: Array<[number[], number[][]]> = [
    [[1, 0, 0], [[x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]]],
    [[-1, 0, 0], [[x0, y0, z1], [x0, y1, z1], [x0, y1, z0], [x0, y0, z0]]],
    [[0, 1, 0], [[x0, y1, z0], [x0, y1, z1], [x1, y1, z1], [x1, y1, z0]]],
    [[0, -1, 0], [[x0, y0, z1], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1]]],
    [[0, 0, 1], [[x1, y0, z1], [x1, y1, z1], [x0, y1, z1], [x0, y0, z1]]],
    [[0, 0, -1], [[x0, y0, z0], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0]]],
  ];
  const position: number[] = [];
  const normal: number[] = [];
  const index: number[] = [];
  faces.forEach(([n, quad], f) => {
    for (const p of quad) {
      position.push(p[0]!, p[1]! + lift, p[2]!);
      normal.push(...n);
    }
    index.push(f * 4, f * 4 + 1, f * 4 + 2, f * 4, f * 4 + 2, f * 4 + 3);
  });
  return { position: new Float32Array(position), normal: new Float32Array(normal), index: new Uint16Array(index) };
}

/** Writes the fixture as a GLB. */
export async function fixtureGlb(opts: FixtureOptions = {}): Promise<Uint8Array> {
  const boneCount = opts.bones ?? 24;
  const lift = opts.lift ?? 0.25;
  if (boneCount < FIXTURE_BONES.length) throw new Error(`fixture: at least ${FIXTURE_BONES.length} bones`);
  const doc = new Document();
  const buffer = doc.createBuffer();
  const scene = doc.createScene('Scene');
  const armature = doc.createNode('Armature');
  scene.addChild(armature);

  const materials = new Map<string, ReturnType<Document['createMaterial']>>();
  const emissiveExt = doc.createExtension(KHRMaterialsEmissiveStrength);
  for (const [name, m] of Object.entries(FIXTURE_MATERIALS)) {
    const mat = doc
      .createMaterial(name === opts.unnameMaterial ? '' : name)
      .setBaseColorFactor(m.color)
      .setRoughnessFactor(m.roughness)
      .setMetallicFactor(m.metallic)
      .setDoubleSided(true);
    if (m.emissive) mat.setEmissiveFactor(m.emissive);
    if (m.strength !== undefined) mat.setExtension('KHR_materials_emissive_strength', emissiveExt.createEmissiveStrength().setEmissiveStrength(m.strength));
    if (m.blend) mat.setAlphaMode('BLEND');
    materials.set(name, mat);
  }

  // joints: world positions; local translation = world − parent world
  const world = new Map<string, [number, number, number]>();
  const joints: GNode[] = [];
  const jointIndex = new Map<string, number>();
  const nodes = new Map<string, GNode>();
  const addJoint = (name: string, parent: string | null, y: number, x: number): void => {
    const w: [number, number, number] = [x, y + lift, 0];
    const p = parent === null ? [0, 0, 0] : world.get(parent)!;
    const node = doc.createNode(name).setTranslation([w[0] - p[0]!, w[1] - p[1]!, w[2] - p[2]!]);
    (parent === null ? armature : nodes.get(parent)!).addChild(node);
    world.set(name, w);
    nodes.set(name, node);
    jointIndex.set(name, joints.length);
    joints.push(node);
  };
  for (const [name, parent, y, x] of FIXTURE_BONES) addJoint(name, parent, y, x);
  for (let i = FIXTURE_BONES.length; i < boneCount; i++) addJoint(`x_${i}`, 'Hips', 0.9, 0.01 * i);

  let skin: ReturnType<Document['createSkin']> | null = null;
  if (opts.rigid !== true) {
    const inverse = new Float32Array(joints.length * 16);
    joints.forEach((j, i) => {
      const w = world.get(j.getName())!;
      inverse.set([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -w[0], -w[1], -w[2], 1], i * 16);
    });
    skin = doc.createSkin('skin').setInverseBindMatrices(doc.createAccessor('ibm', buffer).setType('MAT4').setArray(inverse));
    for (const j of joints) skin.addJoint(j);
  }

  const byNode = new Map<string, Box[]>();
  for (const b of FIXTURE_BOXES) byNode.set(b.node, [...(byNode.get(b.node) ?? []), b]);
  for (const [nodeName, boxes] of byNode) {
    const mesh = doc.createMesh(nodeName);
    for (const b of boxes) {
      const g = boxGeometry(b, lift);
      const prim = doc
        .createPrimitive()
        .setAttribute('POSITION', doc.createAccessor(`${nodeName}:p`, buffer).setType('VEC3').setArray(g.position))
        .setAttribute('NORMAL', doc.createAccessor(`${nodeName}:n`, buffer).setType('VEC3').setArray(g.normal))
        .setIndices(doc.createAccessor(`${nodeName}:i`, buffer).setType('SCALAR').setArray(g.index))
        .setMaterial(materials.get(b.material)!);
      if (skin !== null) {
        const count = g.position.length / 3;
        const ji = new Uint8Array(count * 4);
        const jw = new Uint8Array(count * 4);
        for (let i = 0; i < count; i++) {
          ji[i * 4] = jointIndex.get(b.bone)!;
          jw[i * 4] = 255;
        }
        prim.setAttribute('JOINTS_0', doc.createAccessor(`${nodeName}:j`, buffer).setType('VEC4').setArray(ji));
        prim.setAttribute('WEIGHTS_0', doc.createAccessor(`${nodeName}:w`, buffer).setType('VEC4').setArray(jw).setNormalized(true));
      }
      mesh.addPrimitive(prim);
    }
    const node = doc.createNode(nodeName === opts.unnameNode ? '' : nodeName).setMesh(mesh);
    if (skin !== null) node.setSkin(skin);
    armature.addChild(node);
  }

  // the rigid mesh: its vertices are local to the RightHand bone
  {
    const b = FIXTURE_RIGID;
    const g = boxGeometry(b, lift);
    const w = world.get(b.bone)!;
    for (let i = 0; i < g.position.length; i += 3) {
      g.position[i] = g.position[i]! - w[0];
      g.position[i + 1] = g.position[i + 1]! - w[1];
      g.position[i + 2] = g.position[i + 2]! - w[2];
    }
    const mesh = doc.createMesh(b.node).addPrimitive(
      doc
        .createPrimitive()
        .setAttribute('POSITION', doc.createAccessor('gear:p', buffer).setType('VEC3').setArray(g.position))
        .setAttribute('NORMAL', doc.createAccessor('gear:n', buffer).setType('VEC3').setArray(g.normal))
        .setIndices(doc.createAccessor('gear:i', buffer).setType('SCALAR').setArray(g.index))
        .setMaterial(materials.get(b.material)!),
    );
    nodes.get(b.bone)!.addChild(doc.createNode(b.node).setMesh(mesh));
  }
  // a socket that is a plain node under a bone, not a joint
  nodes.get('RightHand')!.addChild(doc.createNode('sock2_muzzle').setTranslation([0.1, 0, 0]));

  const io = new NodeIO().registerExtensions([KHRMaterialsEmissiveStrength]);
  return io.writeBinary(doc);
}

/** the fixture's bind-pose box as asset facts: `[minX, 0, minZ, maxX, height, maxZ]` */
export const FIXTURE_FACTS: FactBounds = [-FIXTURE_ARM, 0, -0.12, 0.78, FIXTURE_HEIGHT, 0.1];

// ── parsing ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

let prepared: Promise<void> | undefined;
function prepare(): Promise<void> {
  return (prepared ??= (async () => {
    // GLTFLoader.loadImageSource reads `self.URL` (a worker/window global Node does not define)
    if (!('self' in globalThis)) (globalThis as { self?: unknown }).self = globalThis;
    await MeshoptDecoder.ready;
  })());
}

/** A KTX2 "loader" for Node: answers each URL with a header-only texture (no transcoder, no GPU), through the session cache. */
export class HeaderKtx2Loader extends CachedKTX2Loader {
  protected override loadUncached(_url: string, onLoad: (t: CompressedTexture) => void): void {
    queueMicrotask(() => onLoad(new CompressedTexture([], 1024, 1024, RGBA_ASTC_4x4_Format)));
  }
}

export interface ParseOptions {
  /** base of relative URIs */
  path?: string;
  /** resolves KTX2 textures; without it every texture is skipped (the materials load untextured) */
  ktx2?: CachedKTX2Loader;
}

/** `GLTFLoader.parseAsync` in Node with the meshopt decoder. */
export async function parseGlb(bytes: Uint8Array, opts: ParseOptions = {}): Promise<GLTF> {
  await prepare();
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  if (opts.ktx2 !== undefined) loader.setKTX2Loader(opts.ktx2 as unknown as Parameters<GLTFLoader['setKTX2Loader']>[0]);
  else {
    loader.register((parser: GLTFParser) => {
      const get = parser.getDependency.bind(parser);
      parser.getDependency = (type: string, index: number) => (type === 'texture' ? Promise.resolve(null) : get(type, index));
      return { name: 'ss_skip_textures' };
    });
  }
  const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  return loader.parseAsync(data, opts.path ?? '');
}
