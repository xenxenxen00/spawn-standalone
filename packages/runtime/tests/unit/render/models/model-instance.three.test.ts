// WP R6 (render §11.4, §7.6, §16.3): a model instance's look row (slot overrides, the part mask, part looks), the transparent
// mesh switch, the bone and socket reads and the two bone-matrix paths. Node + three's scene graph, no renderer.
import { Matrix4, Object3D, Quaternion, Scene, Vector3 } from 'three/webgpu';
import type { SkinnedMesh } from 'three/webgpu';
import { beforeAll, describe, expect, it } from 'vitest';
import { BONE_MATRIX_PATH, ModelInstance } from '../../../../src/render/models/model-instance.ts';
import { buildModelTemplate, modelSourceFromGltf, type ModelTemplate } from '../../../../src/render/models/model-template.ts';
import { LOOK_MASK_TEXEL, LOOK_PART_DIR_TEXEL, lookPartLookTexel, lookSlotTexel, slotOverrideFromSpec } from '../../../../src/render/surface/look-table.ts';
import { FIXTURE_BONES, FIXTURE_FACTS, fixtureGlb, parseGlb, testEnv, type TestEnv } from './model-fixtures.ts';

let env: TestEnv;
let template: ModelTemplate;
beforeAll(async () => {
  env = testEnv();
  template = buildModelTemplate(modelSourceFromGltf('value.00f1c5.glb', await parseGlb(await fixtureGlb()), FIXTURE_FACTS), env);
});

const texel = (row: Float32Array, t: number): number[] => [...row.subarray(t * 4, t * 4 + 4)];

describe('slot looks and part visibility (render §7.6, §11.4)', () => {
  it('setParts writes the part mask bits of `partBits`, and the map is the whole state', () => {
    const logs: string[] = [];
    const i = new ModelInstance(template, env.look, { log: (m) => logs.push(m) });
    const row = env.look.rowData(i.lookRow);
    // the spawn-time state of a segmented body: every cap and the opened torso hidden
    i.setParts({ cap_head_stump: { visible: false }, part_torso_open: { visible: false } });
    const bit = (n: string): number => template.partBits.get(n)!;
    const mask = (): number => texel(row, LOOK_MASK_TEXEL)[0]!;
    expect(mask()).toBe((1 << bit('cap_head_stump')) | (1 << bit('part_torso_open')));
    expect(i.partHidden('cap_head_stump')).toBe(true);
    expect(i.partHidden('part_head')).toBe(false);
    // a head sever: the head goes, its stump cap shows; `open` swaps the torso for the opened one
    i.setParts({ part_head: { visible: false }, part_torso: { visible: false }, cap_head_stump: { visible: true } });
    expect(mask()).toBe((1 << bit('part_head')) | (1 << bit('part_torso')));
    expect(i.partHidden('part_torso_open')).toBe(false);
    // an empty map shows everything again
    i.setParts({});
    expect(mask()).toBe(0);
    // a node the model lacks is reported once (the live engine's `model-part-material-unknown`), not thrown
    i.setParts({ cap_foot_l_end: { visible: false } });
    i.setParts({ cap_foot_l_end: { visible: false } });
    expect(mask()).toBe(0);
    expect(logs).toEqual(['model value.00f1c5.glb: part "cap_foot_l_end" is not a mesh node of the model (model-part-material-unknown)']);
    i.dispose();
  });

  it('setParts dresses a shown part through a part look, four at once', () => {
    const logs: string[] = [];
    const i = new ModelInstance(template, env.look, { log: (m) => logs.push(m) });
    const row = env.look.rowData(i.lookRow);
    const bit = (n: string): number => template.partBits.get(n)!;
    // the surgeon-regent's chest light: `setPart(node, { color, emissive, emissiveIntensity })`
    const glow = slotOverrideFromSpec({ color: 'oklch(0.8 0.2 140)', emissive: 'oklch(0.8 0.2 140)', emissiveIntensity: 2.5 })!;
    i.setParts({ part_torso: { visible: true, ...glow }, part_head: { visible: false } });
    expect(texel(row, LOOK_PART_DIR_TEXEL)).toEqual([bit('part_torso') + 1, 0, 0, 0]);
    expect(texel(row, lookPartLookTexel(0)).slice(0, 3)).toEqual(glow.albedo!.map(Math.fround));
    expect(texel(row, lookPartLookTexel(0))[3]).toBe(1);
    expect(texel(row, lookPartLookTexel(0) + 2)).toEqual([-1, -1, 1, 0]);
    expect(texel(row, LOOK_MASK_TEXEL)[0]).toBe(1 << bit('part_head'));
    // the kilnback furnace glow: `{ emissiveIntensity }` alone scales the model's own emissive
    i.setParts({ part_torso: { visible: true, emissiveScale: 0.9 } });
    expect(texel(row, lookPartLookTexel(0) + 1)).toEqual([-2, Math.fround(0.9), 0, -1]);
    // a part no longer listed loses its look
    i.setParts({});
    expect(texel(row, LOOK_PART_DIR_TEXEL)).toEqual([0, 0, 0, 0]);
    expect([...row].every((x) => x === 0)).toBe(true);
    // a fifth dressed part is reported once and keeps its slot's look
    const five = Object.fromEntries(['part_pelvis', 'part_torso', 'part_head', 'part_thigh_l', 'part_thigh_r'].map((n) => [n, { roughness: 0.2 }]));
    i.setParts(five);
    i.setParts(five);
    expect(texel(row, LOOK_PART_DIR_TEXEL).every((x) => x > 0)).toBe(true);
    expect(logs).toEqual(['model value.00f1c5.glb: more than 4 dressed parts at once; the rest keep their slot\'s look']);
    i.dispose();
  });

  it('setSlot writes the slot entry by material name and reports unknown names once', () => {
    const logs: string[] = [];
    const i = new ModelInstance(template, env.look, { log: (m) => logs.push(m) });
    const row = env.look.rowData(i.lookRow);
    const frozen = slotOverrideFromSpec({ color: 'oklch(0.9 0.05 230)', emissive: 'oklch(0.78 0.1 235)', emissiveIntensity: 0.6, roughness: 0.25 })!;
    expect(i.setSlot('skin.001', frozen)).toBe(true);
    const at = lookSlotTexel(template.slotIds.get('skin.001')!);
    expect(texel(row, at).slice(0, 3)).toEqual(frozen.albedo!.map(Math.fround));
    expect(texel(row, at + 2)).toEqual([0.25, -1, 1, 0]);
    expect(i.setSlot('wound_flesh', frozen)).toBe(true);
    expect(texel(row, lookSlotTexel(template.slotIds.get('wound_flesh')!) + 2)[2]).toBe(1);
    // the slot the game used to name wrong ('skin' matched nothing live): reported, nothing written
    expect(i.setSlot('skin', frozen)).toBe(false);
    expect(i.setSlot('skin', frozen)).toBe(false);
    expect(logs).toEqual(['model value.00f1c5.glb: no material slot "skin" (model-part-material-unknown)']);
    expect(i.setSlot('skin.001', null)).toBe(true);
    expect(texel(row, at + 2)).toEqual([0, 0, 0, 0]);
    i.dispose();
  });

  it('shows the transparent mesh only while a look blends (or the model has blend paints)', async () => {
    // a model with no alpha < 1 material of its own: the hollow shape, built from the fixture without its glass
    const opaqueEnv = testEnv();
    const gltf = await parseGlb(await fixtureGlb());
    gltf.scene.traverse((o) => {
      const m = (o as { material?: { name: string; transparent: boolean; opacity: number } }).material;
      if (m && m.name === 'glass') {
        m.transparent = false;
        m.opacity = 1;
      }
    });
    const solid = buildModelTemplate(modelSourceFromGltf('solid.glb', gltf, FIXTURE_FACTS), opaqueEnv);
    expect(solid.hasBlendPaints).toBe(false);
    const i = new ModelInstance(solid, opaqueEnv.look);
    expect(i.opaqueMesh.visible).toBe(true);
    expect(i.transparentMesh.visible).toBe(false);
    // the veilskin cloak: `setMaterial(slot, { transparent: true, opacity: q })` on every body slot
    const cloak = slotOverrideFromSpec({ transparent: true, opacity: 0.12 })!;
    i.setSlot('skin.001', cloak);
    expect(i.transparentMesh.visible).toBe(true);
    i.setSlot('wound_flesh', cloak);
    // revealed: opaque again, slot by slot
    const revealed = slotOverrideFromSpec({ emissive: 'oklch(0.55 0.22 28)', emissiveIntensity: 0.5, transparent: false, opacity: 1 })!;
    i.setSlot('skin.001', revealed);
    expect(i.transparentMesh.visible).toBe(true);
    i.setSlot('wound_flesh', revealed);
    expect(i.transparentMesh.visible).toBe(false);
    // a part look can blend too
    i.setParts({ part_head: { alpha: 0.5 } });
    expect(i.transparentMesh.visible).toBe(true);
    i.setParts({});
    expect(i.transparentMesh.visible).toBe(false);
    // the same material objects all along: a mesh shown or hidden, never a new program
    expect(i.transparentMesh.material).toBe(solid.transparentMesh.material);
    i.dispose();
    // the fixture itself has a BLEND material
    const j = new ModelInstance(template, env.look);
    expect(j.transparentMesh.visible).toBe(true);
    j.dispose();
  });

  it('hands its look row to a baked corpse and releases it otherwise', () => {
    const i = new ModelInstance(template, env.look);
    const used = env.look.used;
    i.setSlot('skin.001', { mode: 'replace', roughness: 0.3 });
    const row = i.detachLookRow();
    expect(row).toBeGreaterThan(0);
    expect(i.lookRow).toBe(0);
    expect(i.opaqueMesh.userData['ssLookRow']).toBe(0);
    env.look.retag(row, 'corpse');
    i.dispose();
    // the row survived the instance, with its overrides
    expect(env.look.used).toBe(used);
    expect(env.look.kindOf(row)).toBe('corpse');
    expect(env.look.slotIsActive(row, template.slotIds.get('skin.001')!)).toBe(true);
    env.look.release(row);
    const k = new ModelInstance(template, env.look);
    k.dispose();
    k.dispose();
    expect(env.look.used).toBe(used - 1);
  });
});

describe('object state', () => {
  it('sets layers on the root and both meshes, visibility on the root, and leaves the scene on dispose', () => {
    const scene = new Scene();
    const i = new ModelInstance(template, env.look);
    scene.add(i.root);
    i.setLayers(0b100);
    expect([i.root.layers.mask, i.opaqueMesh.layers.mask, i.transparentMesh.layers.mask]).toEqual([4, 4, 4]);
    i.setVisible(false);
    expect(i.root.visible).toBe(false);
    i.dispose();
    expect(i.root.parent).toBeNull();
    expect(i.disposed).toBe(true);
  });
});

describe('bones and sockets (render §11.4, §16.3)', () => {
  it('starts on the path the bench chose and switches between both', () => {
    const i = new ModelInstance(template, env.look);
    expect(i.bonePath).toBe(BONE_MATRIX_PATH);
    i.setBonePath('direct');
    for (const b of i.boneList) expect([b.matrixAutoUpdate, b.matrixWorldAutoUpdate]).toEqual([false, false]);
    i.setBonePath('hierarchy');
    for (const b of i.boneList) expect([b.matrixAutoUpdate, b.matrixWorldAutoUpdate]).toEqual([true, true]);
    i.dispose();
  });

  it('reads bone positions by glTF name, and sockets only when forced on an uploaded model', () => {
    const i = new ModelInstance(template, env.look, { bonePath: 'hierarchy' });
    i.root.position.set(10, 0, -5);
    i.root.updateMatrixWorld(true);
    const out = { x: 0, y: 0, z: 0 };
    expect(i.boneWorld('Spine.001', out)).toBe(true);
    // Spine.001 is at height 1.0 above the feet in the file; the normalisation took the file's lift out
    expect([out.x, out.y, out.z].map((x) => +x.toFixed(5))).toEqual([10, 1, -5]);
    expect(i.boneWorld('Spine001', out)).toBe(false);
    expect(i.boneWorld('nope', out)).toBe(false);
    // `value.<sha>.glb` is an upload: the live engine resolves no socket on it
    expect(template.uploaded).toBe(true);
    expect(i.socketWorld('sock_grip', out)).toBe(false);
    expect(i.socketWorld('sock_grip', out, true)).toBe(true);
    expect([out.x, out.y, out.z].map((x) => +x.toFixed(5))).toEqual([10.75, 1.4, -5]);
    // a socket that is a plain node under a bone
    expect(i.socketWorld('sock2_muzzle', out, true)).toBe(true);
    expect([out.x, out.y, out.z].map((x) => +x.toFixed(5))).toEqual([10.8, 1.4, -5]);
    // the same reads on the direct path, where only skeleton bones carry a current world matrix
    i.setBonePath('direct');
    expect(i.socketWorld('sock2_muzzle', out, true)).toBe(true);
    expect([out.x, out.y, out.z].map((x) => +x.toFixed(5))).toEqual([10.8, 1.4, -5]);
    expect(i.socketWorld('sock_missing', out, true)).toBe(false);
    i.dispose();
  });

  it('direct path: with the root moved in the same frame, the bone matrices equal three\'s hierarchy update to 1e-5', () => {
    const scene = new Scene();
    const holder = new Object3D();
    holder.position.set(3, 0.5, -2);
    holder.rotation.y = 0.7;
    scene.add(holder);
    const direct = new ModelInstance(template, env.look, { bonePath: 'direct' });
    const tree = new ModelInstance(template, env.look, { bonePath: 'hierarchy' });
    holder.add(direct.root, tree.root);
    scene.updateMatrixWorld(true);

    // a pose: local rotations on a few bones, written as TRS on the hierarchy instance
    const pose = new Map<string, Quaternion>([
      ['Hips', new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 1.2)],
      ['Spine.001', new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), -0.4)],
      ['RightArm', new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.9)],
      ['Head', new Quaternion().setFromAxisAngle(new Vector3(1, 1, 0).normalize(), 0.5)],
    ]);
    // the mixer's side: FK in glTF model space from the file's bind translations and these rotations
    const model = new Float32Array(template.boneCount * 16);
    const local = new Matrix4();
    const world = new Map<string, Matrix4>();
    const lift = 0.25;
    const worldPos = (name: string): Vector3 => {
      const b = FIXTURE_BONES.find((x) => x[0] === name);
      return b ? new Vector3(b[3], b[2] + lift, 0) : new Vector3(0.01 * Number(name.slice(2)), 0.9 + lift, 0);
    };
    template.boneNames.forEach((name, i) => {
      const parent = FIXTURE_BONES.find((x) => x[0] === name)?.[1] ?? (name === 'Hips' ? null : 'Hips');
      const t = parent === null ? worldPos(name) : worldPos(name).sub(worldPos(parent));
      local.compose(t, pose.get(name) ?? new Quaternion(), new Vector3(1, 1, 1));
      const m = parent === null ? local.clone() : new Matrix4().multiplyMatrices(world.get(parent)!, local);
      world.set(name, m);
      m.toArray(model, i * 16);
    });

    // this frame: both roots move and turn, then the bridge makes the root's world matrix current and the skin adapter writes
    for (const inst of [direct, tree]) {
      inst.root.position.set(-1.5, 0, 4);
      inst.root.rotation.y = -1.1;
      inst.root.scale.setScalar(1.25);
    }
    direct.root.updateWorldMatrix(true, false);
    direct.writeBonesFromModel(model);
    for (const [name, q] of pose) tree.bones.get(name)!.quaternion.copy(q);
    scene.updateMatrixWorld();

    direct.skeleton!.update();
    tree.skeleton!.update();
    let worst = 0;
    for (let k = 0; k < template.boneCount * 16; k++) worst = Math.max(worst, Math.abs(direct.skeleton!.boneMatrices![k]! - tree.skeleton!.boneMatrices![k]!));
    expect(worst).toBeLessThan(1e-5);
    // and the bones themselves
    direct.boneList.forEach((b, i) => {
      const e = b.matrixWorld.elements;
      const f = tree.boneList[i]!.matrixWorld.elements;
      for (let k = 0; k < 16; k++) expect(Math.abs(e[k]! - f[k]!)).toBeLessThan(1e-5);
    });
    // three's scene update did not touch the directly written bones (it stops at the rig container)
    const before = direct.boneList[0]!.matrixWorld.clone();
    scene.updateMatrixWorld(true);
    expect(direct.boneList[0]!.matrixWorld.equals(before)).toBe(true);
    // a stale root shows why the bridge's call matters: without it the write lands on last frame's root
    direct.root.position.x += 2;
    direct.writeBonesFromModel(model);
    expect(direct.boneList[0]!.matrixWorld.equals(before)).toBe(true);
    direct.root.updateWorldMatrix(true, false);
    direct.writeBonesFromModel(model);
    expect(direct.boneList[0]!.matrixWorld.equals(before)).toBe(false);
    direct.dispose();
    tree.dispose();
  });

  it('direct path: an instance stands in its rest pose under its root until the first write', () => {
    const i = new ModelInstance(template, env.look, { bonePath: 'direct' });
    i.root.position.set(7, 0, 0);
    i.root.updateWorldMatrix(true, false);
    i.writeRestPose();
    const out = { x: 0, y: 0, z: 0 };
    i.boneWorld('Head', out);
    expect([out.x, out.y, out.z].map((x) => +x.toFixed(5))).toEqual([7, 1.5, 0]);
    i.skeleton!.update();
    // at rest every real bone's skin matrix is the root's translation × the normalisation: the bind pose, moved
    const m = new Matrix4().fromArray(i.skeleton!.boneMatrices!, 16);
    expect(m.elements.slice(12, 15).map((x) => +x.toFixed(5))).toEqual([7, -0.25, 0]);
    expect((i.opaqueMesh as SkinnedMesh).skeleton).toBe(i.skeleton);
    i.dispose();
  });
});
