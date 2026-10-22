// Model-template merging over synthetic geometry parsed in Node, without a renderer.
import { Box3, Matrix4, Sphere, Vector3 } from 'three/webgpu';
import type { SkinnedMesh } from 'three/webgpu';
import { beforeAll, describe, expect, it } from 'vitest';
import { ModelInstance } from '../../../../src/render/models/model-instance.ts';
import {
  BOUNDS_TOLERANCE_M,
  ModelTemplate,
  PAD_BONE_NAME,
  boneClassOf,
  buildModelTemplate,
  mergeModel,
  modelSourceFromGltf,
  type MergedModel,
} from '../../../../src/render/models/model-template.ts';
import { PART_NEVER_HIDDEN } from '../../../../src/render/surface/look-table.ts';
import { SurfaceVariant as V } from '../../../../src/render/surface/surface-material.ts';
import {
  FIXTURE_ARM,
  FIXTURE_BONES,
  FIXTURE_BOXES,
  FIXTURE_FACTS,
  FIXTURE_HEIGHT,
  FIXTURE_MATERIALS,
  FIXTURE_RIGID,
  fixtureGlb,
  parseGlb,
  testEnv,
  type FixtureOptions,
} from './model-fixtures.ts';

async function fixture(opts: FixtureOptions = {}, facts = FIXTURE_FACTS): Promise<MergedModel> {
  return mergeModel(modelSourceFromGltf('fixture.glb', await parseGlb(await fixtureGlb(opts)), facts));
}

/** vertex ranges of the merged geometry per (node, material), in primitive order */
function runs(m: MergedModel): Array<{ part: number; slot: number; paint: number; count: number }> {
  const out: Array<{ part: number; slot: number; paint: number; count: number }> = [];
  const ss = m.arrays.partPaint;
  for (let i = 0; i < m.arrays.vertexCount; i++) {
    const part = ss[i * 4]!;
    const slot = ss[i * 4 + 1]!;
    const paint = ss[i * 4 + 2]! + (ss[i * 4 + 3]! << 8);
    const last = out[out.length - 1];
    if (last && last.part === part && last.slot === slot && last.paint === paint) last.count++;
    else out.push({ part, slot, paint, count: 1 });
  }
  return out;
}

/** CPU skin of every vertex with the bones' current world matrices: the positions the GPU would draw (root space when the root is at the origin) */
function skinned(arrays: MergedModel['arrays'], boneWorld: (i: number) => Matrix4, inverses: readonly Matrix4[]): Float32Array {
  const out = new Float32Array(arrays.vertexCount * 3);
  const mats = new Map<number, Matrix4>();
  const v = new Vector3();
  const acc = new Vector3();
  for (let i = 0; i < arrays.vertexCount; i++) {
    acc.set(0, 0, 0);
    for (let k = 0; k < 4; k++) {
      const w = arrays.skinWeight![i * 4 + k]!;
      if (w === 0) continue;
      const b = arrays.skinIndex![i * 4 + k]!;
      let m = mats.get(b);
      if (!m) mats.set(b, (m = new Matrix4().multiplyMatrices(boneWorld(b), inverses[b]!)));
      v.fromArray(arrays.position, i * 3).applyMatrix4(m);
      acc.addScaledVector(v, w);
    }
    acc.toArray(out, i * 3);
  }
  return out;
}

describe('bone-count classes (render §7.2)', () => {
  it('pads to the smallest of 32, 64, 128 and rejects more', () => {
    expect([1, 24, 32, 33, 52, 64, 65, 128].map(boneClassOf)).toEqual([32, 32, 32, 64, 64, 64, 128, 128]);
    expect(() => boneClassOf(129)).toThrow(/129 bones is above the largest bone-count class/);
  });

  it.each([
    [24, 32],
    [32, 32],
    [33, 64],
    [52, 64],
    [65, 128],
  ])('a %i-bone rig gets a %i-entry skeleton whose tail is one unweighted identity bone', async (bones, cls) => {
    const m = await fixture({ bones });
    expect(m.boneCount).toBe(bones);
    expect(m.boneClass).toBe(cls);
    const sk = m.skeleton!;
    expect(sk.bones).toHaveLength(cls);
    expect(sk.boneInverses).toHaveLength(cls);
    expect(sk.boneMatrices).toHaveLength(cls * 16);
    const identity = new Matrix4();
    for (let i = bones; i < cls; i++) {
      expect(sk.bones[i]!.name).toBe(PAD_BONE_NAME);
      expect(sk.bones[i]).toBe(sk.bones[bones] ?? sk.bones[i]);
      expect(sk.boneInverses[i]!.equals(identity)).toBe(true);
    }
    // the inverse bind matrices of the real bones are the file's, untouched
    for (let i = 0; i < bones; i++) expect(sk.boneInverses[i]!.elements[15]).toBe(1);
    expect(sk.boneInverses[0]!.elements.slice(12, 15)).toEqual([-0, -(0.9 + 0.25), -0].map(Math.fround));
    // no vertex weight names a padded entry
    let maxIndex = 0;
    for (let i = 0; i < m.arrays.vertexCount * 4; i++) if (m.arrays.skinWeight![i]! > 0) maxIndex = Math.max(maxIndex, m.arrays.skinIndex![i]!);
    expect(maxIndex).toBeLessThan(bones);
    // the padding bone is not a bone of the model
    expect(m.boneNodes.size).toBe(bones);
    expect(m.boneNames).toHaveLength(bones);
    expect(m.boneNodes.has(PAD_BONE_NAME)).toBe(false);
  });

  it('fails loudly on a rig above the largest class', async () => {
    await expect(fixture({ bones: 129 })).rejects.toThrow(/129 bones is above the largest bone-count class/);
  });
});

describe('the merge (render §11.3)', () => {
  let m: MergedModel;
  beforeAll(async () => {
    m = await fixture();
  });

  it('numbers parts with `part_*` / `cap_*` nodes first, then the other named mesh nodes, in file order', () => {
    const partNodes = [...new Set(FIXTURE_BOXES.map((b) => b.node))];
    expect([...m.partBits.keys()]).toEqual([...partNodes, FIXTURE_RIGID.node]);
    expect([...m.partBits.values()]).toEqual(partNodes.map((_, i) => i).concat(partNodes.length));
    expect(m.unmaskable).toEqual([]);
  });

  it('keys slots by the glTF material name, dots included', () => {
    expect(m.slotNames).toEqual(['skin.001', 'k_eye', 'organ.001', 'glass', 'wound_flesh', 'k_iron']);
    expect(m.slotIds.get('skin.001')).toBe(0);
    expect(m.slotIds.get('organ.001')).toBe(2);
    expect(m.materials.map((x) => x.name)).toEqual(m.slotNames);
  });

  it('writes ss = (part, slot, paint) on every vertex of every primitive', () => {
    const all = [...FIXTURE_BOXES, FIXTURE_RIGID];
    const got = runs(m);
    // consecutive boxes of one node and material merge into one run
    const want: typeof got = [];
    for (const b of all) {
      const part = m.partBits.get(b.node)!;
      const slot = m.slotIds.get(b.material)!;
      const last = want[want.length - 1];
      if (last && last.part === part && last.slot === slot) last.count += 24;
      else want.push({ part, slot, paint: slot, count: 24 });
    }
    expect(got).toEqual(want);
    expect(m.arrays.vertexCount).toBe(all.length * 24);
    expect(m.arrays.index).toHaveLength(all.length * 36);
    expect(m.arrays.index).toBeInstanceOf(Uint16Array);
    expect(Math.max(...m.arrays.index)).toBe(m.arrays.vertexCount - 1);
    // the two primitives of part_torso share the part and differ in slot
    const torso = m.partBits.get('part_torso')!;
    expect(got.filter((r) => r.part === torso).map((r) => r.slot)).toEqual([m.slotIds.get('skin.001'), m.slotIds.get('k_eye')]);
    expect(got.every((r) => r.part !== PART_NEVER_HIDDEN)).toBe(true);
  });

  it('reads each material into a paint: linear factors, emissive × strength, alpha only when it blends', () => {
    const byName = new Map(m.materials.map((x) => [x.name, x]));
    for (const [name, spec] of Object.entries(FIXTURE_MATERIALS)) {
      const p = byName.get(name)!.paint;
      expect(p.albedo.map((x) => +x.toFixed(5))).toEqual(spec.color.slice(0, 3));
      expect(p.alpha).toBeCloseTo(spec.blend ? spec.color[3] : 1, 6);
      const k = spec.strength ?? 1;
      expect(p.emissive.map((x) => +x.toFixed(5))).toEqual((spec.emissive ?? [0, 0, 0]).map((x) => x * k));
      expect(p.roughness).toBeCloseTo(spec.roughness, 6);
      expect(p.metalness).toBeCloseTo(spec.metallic, 6);
      expect(p.texSet).toBe(0);
      expect(byName.get(name)!.doubleSided).toBe(true);
    }
    expect(m.textureSets).toEqual([]);
    expect(m.arrays.uv).toBeNull();
    expect(m.warnings).toEqual([]);
  });

  it('turns the rigid mesh under a bone into vertices with weight 1 on that bone', () => {
    const hand = m.boneNames.indexOf('RightHand');
    expect(hand).toBe(7);
    const part = m.partBits.get(FIXTURE_RIGID.node)!;
    const { partPaint: ss, skinIndex, skinWeight, position, vertexCount } = m.arrays;
    const box = new Box3();
    let n = 0;
    for (let i = 0; i < vertexCount; i++) {
      if (ss[i * 4] !== part) continue;
      n++;
      expect([...skinIndex!.subarray(i * 4, i * 4 + 4)]).toEqual([hand, 0, 0, 0]);
      expect([...skinWeight!.subarray(i * 4, i * 4 + 4)]).toEqual([1, 0, 0, 0]);
      box.expandByPoint(new Vector3().fromArray(position, i * 3));
    }
    expect(n).toBe(24);
    // in bind space (the file's space, feet at the lift) the blade is where the file put it under the hand bone
    expect(box.min.toArray().map((x) => +x.toFixed(5))).toEqual([FIXTURE_RIGID.min[0], FIXTURE_RIGID.min[1] + 0.25, FIXTURE_RIGID.min[2]]);
    expect(box.max.toArray().map((x) => +x.toFixed(5))).toEqual([FIXTURE_RIGID.max[0], FIXTURE_RIGID.max[1] + 0.25, FIXTURE_RIGID.max[2]]);
  });

  it('keeps bones and sockets by their glTF names and drops the emptied mesh nodes from the rig', () => {
    expect(m.boneNames.slice(0, FIXTURE_BONES.length)).toEqual(FIXTURE_BONES.map((b) => b[0]));
    expect(m.boneNodes.get('Spine.001')!.isBone).toBe(true);
    // three sanitises object names: the dotted name only survives through the file's JSON
    expect(m.boneNodes.get('Spine.001')!.name).toBe('Spine001');
    expect([...m.socketNodes.keys()].sort()).toEqual(['sock2_muzzle', 'sock_grip']);
    expect(m.socketNodes.get('sock_grip')).toBe(m.boneNodes.get('sock_grip'));
    expect(m.socketNodes.get('sock2_muzzle')!.parent).toBe(m.boneNodes.get('RightHand'));
    const names: string[] = [];
    m.rig!.traverse((o) => names.push(o.name));
    expect(names.some((n) => n.startsWith('part_') || n.startsWith('cap_') || n.startsWith('gear_'))).toBe(false);
    // rig, Scene, Armature, 24 bones, the socket node, the padding bone
    expect(names).toHaveLength(3 + 24 + 1 + 1);
  });

  it('normalises to the facts: the feet on y = 0, x and z as authored, the bind-pose box within 0.2 mm', () => {
    const got = [...m.restBox.min.toArray(), ...m.restBox.max.toArray()];
    for (let i = 0; i < 6; i++) expect(Math.abs(got[i]! - FIXTURE_FACTS[i]!)).toBeLessThan(BOUNDS_TOLERANCE_M);
    expect(m.scale).toBe(1);
    expect(m.rig!.position.toArray().map((x) => +x.toFixed(6))).toEqual([0, -0.25, 0]);
    expect(m.rigMatrix.elements[13]).toBeCloseTo(-0.25, 6);
    expect(m.height).toBeCloseTo(FIXTURE_HEIGHT, 5);
    expect(m.reach).toBeCloseTo(Math.hypot(FIXTURE_ARM, 0.12), 5);
  });

  it('scales uniformly when the facts give another height, and stands on y = 0 without facts', async () => {
    const tall: typeof FIXTURE_FACTS = [-1.6, 0, -0.24, 1.56, 3.6, 0.2];
    const big = await fixture({}, tall);
    expect(big.scale).toBeCloseTo(2, 6);
    const got = [...big.restBox.min.toArray(), ...big.restBox.max.toArray()];
    for (let i = 0; i < 6; i++) expect(Math.abs(got[i]! - tall[i]!)).toBeLessThan(BOUNDS_TOLERANCE_M);
    expect(big.rig!.scale.toArray()).toEqual([big.scale, big.scale, big.scale]);

    const bare = mergeModel(modelSourceFromGltf('fixture.glb', await parseGlb(await fixtureGlb({ lift: 0.4 }))));
    expect(bare.scale).toBe(1);
    expect(bare.restBox.min.y).toBeCloseTo(0, 6);
    expect(bare.restBox.min.x).toBeCloseTo(-FIXTURE_ARM, 6);
    expect(bare.height).toBeCloseTo(FIXTURE_HEIGHT, 5);
  });

  it('bakes the normalisation into the vertices of a static model', async () => {
    const s = await fixture({ rigid: true });
    expect(s.skeleton).toBeNull();
    expect(s.boneClass).toBeNull();
    expect(s.arrays.skinIndex).toBeNull();
    const box = new Box3();
    for (let i = 0; i < s.arrays.vertexCount; i++) box.expandByPoint(new Vector3().fromArray(s.arrays.position, i * 3));
    const got = [...box.min.toArray(), ...box.max.toArray()];
    for (let i = 0; i < 6; i++) expect(Math.abs(got[i]! - FIXTURE_FACTS[i]!)).toBeLessThan(BOUNDS_TOLERANCE_M);
  });

  it('fails loudly on a model that lost a node or a material name', async () => {
    await expect(fixture({ unnameNode: 'part_head' })).rejects.toThrow(/model fixture\.glb: a mesh node has no name; the asset pipeline must keep node names/);
    await expect(fixture({ unnameMaterial: 'wound_flesh' })).rejects.toThrow(/model fixture\.glb: the material of node "cap_head_stump" has no name/);
  });
});

describe('ModelTemplate and its instances (render §11.3-§11.4)', () => {
  const env = testEnv();
  let template: ModelTemplate;
  beforeAll(async () => {
    template = buildModelTemplate(modelSourceFromGltf('fixture.glb', await parseGlb(await fixtureGlb()), FIXTURE_FACTS), env);
  });

  it('is one geometry drawn by an opaque and a transparent skinned mesh', () => {
    const { opaqueMesh, transparentMesh, geometry } = template;
    expect(opaqueMesh.geometry).toBe(geometry);
    expect(transparentMesh.geometry).toBe(geometry);
    expect((opaqueMesh as SkinnedMesh).isSkinnedMesh).toBe(true);
    expect((opaqueMesh as SkinnedMesh).skeleton).toBe(template.skeleton);
    expect((transparentMesh as SkinnedMesh).skeleton).toBe(template.skeleton);
    expect(Object.keys(geometry.attributes).sort()).toEqual(['normal', 'partPaint', 'position', 'skinIndex', 'skinWeight']);
    const ss = geometry.getAttribute('partPaint');
    expect(ss.array).toBeInstanceOf(Uint8Array);
    expect(ss.itemSize).toBe(4);
    expect(ss.normalized).toBe(true);
    // the variant: a glTF source with look-table reads, double-sided as the file's materials; the blend pass adds TRANSPARENT
    expect(template.variant).toBe(V.SRC_GLTF | V.SLOTS | V.PARTMASK | V.SIDE_DOUBLE);
    const opaque = opaqueMesh.material as unknown as { variant: number; transparent: boolean; forceSinglePass: boolean };
    const blend = transparentMesh.material as unknown as { variant: number; transparent: boolean; forceSinglePass: boolean };
    expect(opaque.variant).toBe(template.variant);
    expect(opaque.transparent).toBe(false);
    expect(blend.variant).toBe(template.variant | V.TRANSPARENT);
    expect(blend.transparent).toBe(true);
    expect(blend.forceSinglePass).toBe(true); // three would draw a transparent double-sided material twice
    // the fixture has a BLEND material: its transparent mesh draws from the start
    expect(template.hasBlendPaints).toBe(true);
    expect(transparentMesh.visible).toBe(true);
    expect(opaqueMesh.castShadow).toBe(true);
    expect(transparentMesh.castShadow).toBe(false);
  });

  it('writes its paints into one block of the shared paint table and the table ids into ss', () => {
    expect(template.paintCount).toBe(6);
    expect(template.paintStart).toBe(1);
    const eye = env.paint.read(template.paintStart + 1);
    expect(eye.albedo.map((x) => +x.toFixed(5))).toEqual([0.8, 0.7, 0.2]);
    expect(eye.emissive.map((x) => +x.toFixed(5))).toEqual([2, 1, 0.5]);
    expect(env.paint.read(template.paintStart + 3).alpha).toBeCloseTo(0.4, 6);
    const ss = template.arrays.partPaint;
    const ids = new Set<number>();
    for (let i = 0; i < template.arrays.vertexCount; i++) ids.add(ss[i * 4 + 2]! + (ss[i * 4 + 3]! << 8));
    expect([...ids].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('carries object-level bounds: a sphere at the feet of radius 1.25 H + reach, and the cube around it', () => {
    const r = 1.25 * template.height + template.reach;
    expect(template.boundingSphere.center.toArray()).toEqual([0, 0, 0]);
    expect(template.boundingSphere.radius).toBeCloseTo(1.25 * FIXTURE_HEIGHT + Math.hypot(FIXTURE_ARM, 0.12), 4);
    for (const mesh of [template.opaqueMesh, template.transparentMesh] as SkinnedMesh[]) {
      expect(mesh.boundingSphere).toBeInstanceOf(Sphere);
      expect(mesh.boundingSphere!.equals(template.boundingSphere)).toBe(true);
      expect(mesh.boundingBox!.min.toArray()).toEqual([-r, -r, -r]);
      expect(mesh.boundingBox!.max.toArray()).toEqual([r, r, r]);
    }
  });

  it('instances share geometry and materials, own their bones, and keep the bounds and the padded tail', () => {
    const a = new ModelInstance(template, env.look);
    const b = new ModelInstance(template, env.look);
    expect(a.opaqueMesh.geometry).toBe(template.geometry);
    expect(a.opaqueMesh.material).toBe(template.opaqueMesh.material);
    expect(a.transparentMesh.material).toBe(template.transparentMesh.material);
    expect(a.skeleton).not.toBe(template.skeleton);
    expect(a.skeleton).not.toBe(b.skeleton);
    // one skeleton for both passes of an instance
    expect((a.transparentMesh as SkinnedMesh).skeleton).toBe(a.skeleton);
    expect(a.skeleton!.bones).toHaveLength(32);
    expect(a.skeleton!.boneInverses).toHaveLength(32);
    const identity = new Matrix4();
    template.skeleton!.bones.forEach((bone, i) => {
      const mine = a.skeleton!.bones[i]!;
      expect(mine).not.toBe(bone);
      expect(mine.name).toBe(bone.name);
      expect(b.skeleton!.bones[i]).not.toBe(mine);
      // the inverse bind matrices are the template's own objects: nothing recomputed them for the clone
      expect(a.skeleton!.boneInverses[i]).toBe(template.skeleton!.boneInverses[i]);
      if (i >= 24) {
        expect(mine.name).toBe(PAD_BONE_NAME);
        expect(a.skeleton!.boneInverses[i]!.equals(identity)).toBe(true);
      }
    });
    // the name map: 24 real bones by glTF name, in skeleton order, never the padding bone
    expect([...a.bones.keys()]).toEqual(template.boneNames);
    expect(a.boneList).toHaveLength(24);
    expect(a.boneList[1]).toBe(a.bones.get('Spine.001'));
    expect(a.boneList[1]).toBe(a.skeleton!.bones[1]);
    expect([...a.bones.values()].some((x) => x.name === PAD_BONE_NAME)).toBe(false);
    // the object-level bounds came along, as copies
    for (const mesh of [a.opaqueMesh, a.transparentMesh] as SkinnedMesh[]) {
      expect(mesh.boundingSphere!.equals(template.boundingSphere)).toBe(true);
      expect(mesh.boundingSphere).not.toBe((template.opaqueMesh as SkinnedMesh).boundingSphere);
      expect(mesh.boundingBox!.equals(template.boundingBox)).toBe(true);
    }
    // each has its own look row, which both of its meshes read
    expect(a.lookRow).not.toBe(b.lookRow);
    expect(a.opaqueMesh.userData['ssLookRow']).toBe(a.lookRow);
    expect(a.transparentMesh.userData['ssLookRow']).toBe(a.lookRow);
    a.dispose();
    b.dispose();
    expect(env.look.used).toBe(0);
  });

  it('frees its paint block and its geometry on dispose', async () => {
    const other = buildModelTemplate(modelSourceFromGltf('other.glb', await parseGlb(await fixtureGlb({ bones: 40 })), FIXTURE_FACTS), env);
    expect(other.paintStart).toBe(template.paintStart + template.paintCount);
    const free = env.paint.freePaints;
    let disposed = 0;
    other.geometry.addEventListener('dispose', () => disposed++);
    other.dispose();
    other.dispose();
    expect(disposed).toBe(1);
    expect(env.paint.freePaints).toBe(free + other.paintCount);
    expect(() => new ModelInstance(other, env.look)).toThrow(/disposed template/);
  });
});
