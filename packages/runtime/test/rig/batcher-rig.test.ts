// H5 (INTEGRATION.md): rigged rows take the single-mesh path of the map batcher. A row flagged `rigged` is never merged or
// instanced; with the batcher's `rigs` option its key draws one SkinnedMesh per level and pass over the shared packed
// geometry, sharing the row's one Skeleton, bound with the level's dequantisation as the bind matrix. Without `rigs` it is
// PP's static mesh. Also the open risk R2: the packed surface material, built for a SkinnedMesh, keeps three's skinning node.
import { GLSLNodeBuilder, Matrix4, Mesh, PerspectiveCamera, Scene } from 'three/webgpu';
import type { Material } from 'three/webgpu';
import { describe, expect, it, vi } from 'vitest';
import { keyOf } from '../../src/render/geometry/generator-types.ts';
import { dequantMatrix } from '../../src/render/geometry/map-batcher.ts';
import { classifyRows, keysNeedingLod1Tris } from '../../src/render/geometry/map-plan.ts';
import { TIER_TABLE } from '../../src/render/perf/budget.ts';
import { LAYER_SHADOW_PROXY } from '../../src/render/scene/scene-root.ts';
import { SurfaceVariant as V } from '../../src/render/surface/surface-material.ts';
import { ScriptRigs } from '../../src/render/rig/index.ts';
import { at, bean, BEAN_SPEC, buildBatcher, skinnedUnder } from './harness.ts';

describe('H5 plan: rigged rows are never merged or instanced', () => {
  it('six static rigged rows of one key go standalone; unflagged ones are instanced (PP)', () => {
    const rows = [0, 1, 2, 3, 4, 5].map((i) => bean(`b${i}`, i * 3, { rigged: true }));
    const split = classifyRows(rows, 'hybrid', () => 0);
    expect(split.standalone.map((r) => r.id)).toEqual(['b0', 'b1', 'b2', 'b3', 'b4', 'b5']);
    expect(split.instanced.size).toBe(0);
    expect(split.merged).toHaveLength(0);
    expect(keysNeedingLod1Tris(rows.slice(0, 2), 'hybrid')).toEqual([]);
    const ss = classifyRows(rows.map((r) => ({ ...r, rigged: false })), 'hybrid', () => 0);
    expect(ss.instanced.get(keyOf(BEAN_SPEC))).toHaveLength(6);
  });
});

describe('H5 batcher: the single-mesh path skins rigged keys', () => {
  it('with rigs: SkinnedMeshes over the shared geometry, one Skeleton per row, dequant as the bind matrix', async () => {
    const rigs = new ScriptRigs();
    const { batcher } = await buildBatcher([bean('p1', 2, { dynamic: true }), bean('p2', 6, { rigged: true }), bean('p3', -4, { rigged: true })], { rigs });
    expect(rigs.size).toBe(1);
    const r1 = batcher.rowRig('p1')!;
    const r2 = batcher.rowRig('p2')!;
    expect(r1.rig).toBe(rigs.get(BEAN_SPEC.script));
    expect(r2.rig).toBe(r1.rig); // one RigDef for the script
    expect(r2.skeleton).not.toBe(r1.skeleton); // a Skeleton per row
    expect(r1.root.matrix.elements[12]).toBe(2);
    const meshes = skinnedUnder(r1.root);
    // the high tier's LODs, opaque only (the bean has no glass), plus the LOD 5 shadow proxy
    expect(meshes.length).toBe(TIER_TABLE.high.lods.length + (TIER_TABLE.high.lods.includes(5) && TIER_TABLE.high.shadowCasterMapSize > 0 ? 1 : 0));
    for (const m of meshes) {
      expect(m.skeleton).toBe(r1.skeleton);
      expect(m.matrix.equals(new Matrix4())).toBe(true); // dequant is NOT in the mesh matrix
      expect(m.bindMatrix.equals(new Matrix4())).toBe(false);
      expect(m.geometry.getAttribute('skinIndex').itemSize).toBe(4);
      expect(m.geometry.getAttribute('skinWeight').getX(0)).toBe(1);
      expect(m.boundingSphere).not.toBeNull();
    }
    // the geometry is shared per key: row p2's level 0 mesh draws the same BufferGeometry
    expect(skinnedUnder(r2.root)[0]!.geometry).toBe(meshes[0]!.geometry);
    // the first level's bind matrix is that level's dequantisation
    const lod1 = meshes[0]!;
    const pos = lod1.geometry.getAttribute('position');
    expect(pos.normalized).toBe(true);
    const box = lod1.geometry.boundingBox;
    expect(box).not.toBeNull();
    expect(lod1.bindMatrix.elements[5]).toBeGreaterThan(0.5); // half height of a 1.1 m bean
    // a shadow proxy, if built, is skinned too and on layer 2
    const proxy = meshes.find((m) => m.name.endsWith(':shadow'));
    if (proxy) expect(proxy.layers.mask).toBe(1 << LAYER_SHADOW_PROXY);
    // moving the row moves the rig root only
    batcher.setRowMatrix('p1', at(10, 3));
    expect(r1.root.matrix.elements[12]).toBe(10);
    expect(r1.root.matrixWorld.elements[14]).toBe(3);
    expect(meshes[0]!.matrix.equals(new Matrix4())).toBe(true);
    // removing a rigged row frees its skeleton
    const dispose = vi.spyOn(r2.skeleton, 'dispose');
    batcher.removeRow('p2');
    expect(dispose).toHaveBeenCalledOnce();
    batcher.dispose();
  });

  it('without rigs (PP): the same rows draw static meshes with dequant in the mesh matrix', async () => {
    const { batcher } = await buildBatcher([bean('p1', 2, { dynamic: true })]);
    expect(batcher.rowRig('p1')).toBeNull();
    const group = batcher.singles[0]!.group;
    expect(skinnedUnder(group)).toHaveLength(0);
    const lod = batcher.singles[0]!.levels[0]!;
    const lvl = batcher.singles[0]!.key.levels[0]!;
    expect(lod.opaque!.matrix.equals(new Matrix4().multiplyMatrices(new Matrix4().fromArray(at(2, 0)), dequantMatrix(lvl.bboxMin, lvl.bboxMax)))).toBe(true);
    batcher.dispose();
  });
});

// ── R2: the packed surface material on a SkinnedMesh, built to GLSL with three's own node builder (no GPU) ─────────────

const renderer = {
  debug: { diagnostics: { keywords: false } },
  backend: { capabilities: { getUniformBufferLimit: () => 65_536 } },
  coordinateSystem: 2000,
  getRenderTarget: () => null,
  getMRT: () => null,
  toneMapping: 0,
  outputColorSpace: 'srgb',
  library: { fromMaterial: (m: unknown) => m },
  contextNode: { isContextNode: true, getFlowContextData: () => ({}) },
  shadowMap: { enabled: false },
  lighting: { enabled: false },
};

function vertexShaderOf(mesh: Mesh, material: Material): string {
  const scene = new Scene();
  scene.add(mesh);
  const b = new GLSLNodeBuilder(mesh as never, renderer as never) as unknown as { scene: unknown; camera: unknown; material: unknown; build(): void; vertexShader: string };
  b.scene = scene;
  b.camera = new PerspectiveCamera();
  b.material = material;
  b.build();
  return b.vertexShader;
}

describe('R2: the packed surface material keeps three\'s skinning node', () => {
  it('a skinned packed mesh skins positionLocal; the same material on a plain Mesh does not (negative control)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { batcher, materials } = await buildBatcher([bean('p1', 0, { dynamic: true })], { rigs: new ScriptRigs() });
    const skinned = skinnedUnder(batcher.rowRig('p1')!.root)[0]!;
    const material = skinned.material as Material;
    expect(material).toBe(materials.get({ variant: V.SRC_PACKED | V.SIDE_DOUBLE | V.NORMALS }));
    expect((material as unknown as { positionNode: unknown }).positionNode).toBeNull();
    const vs = vertexShaderOf(skinned, material);
    // three's SkinningNode: positionLocal is re-assigned from the weighted bone matrices, and the view position reads it
    expect(vs).toMatch(/in vec4 skinIndex;/);
    expect(vs).toMatch(/in vec4 skinWeight;/);
    expect(vs).toContain('skinWeight.x * ');
    expect(vs).toMatch(/positionLocal = \( \w+ \* \(.*skinWeight\.x \* \w+\[ uvec4\( skinIndex \)\.x \]/);
    expect(vs).toMatch(/normalLocal = .*skinWeight/);
    expect(vs.lastIndexOf('positionLocal = ')).toBeLessThan(vs.indexOf('v_positionView = ( modelViewMatrix * vec4( positionLocal'));
    // the packed stage still reads its paint attribute
    expect(vs).toMatch(/ssPacked/);
    const plain = new Mesh(skinned.geometry, material);
    const vp = vertexShaderOf(plain, material);
    expect(vp).not.toMatch(/skinWeight/);
    expect(vp).toContain('positionLocal = position.xyz;');
    warn.mockRestore();
    batcher.dispose();
  });
});
