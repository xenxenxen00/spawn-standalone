// WP R7 (render §11.5; X-20, X-40): resumable corpse-pose baking and the corpse batcher. Node + three's scene
// graph, no renderer: the bake math is checked against an independent float64 reference (three's Matrix4 path, not the
// implementation's manual loop), the batcher's three.js behaviour (BatchedMesh ids, the look-row texture, the
// no-deleteGeometry churn rule) against the real r186 objects.
import { Matrix4, Object3D, Scene, Vector3 } from 'three/webgpu';
import type { BatchedMesh, Mesh } from 'three/webgpu';
import { beforeAll, describe, expect, it } from 'vitest';
import { createRenderBudget, type TierId } from '../../../../src/render/perf/budget.ts';
import {
  CORPSE_BATCH_KEY,
  CorpseBaker,
  CorpseBatcher,
  type CorpseBakeResult,
  type CorpseBatcherOptions,
} from '../../../../src/render/models/corpse-baker.ts';
import { ModelInstance } from '../../../../src/render/models/model-instance.ts';
import { buildModelTemplate, modelSourceFromGltf, type ModelTemplate } from '../../../../src/render/models/model-template.ts';
import { SurfaceVariant, type AnySurfaceMaterial } from '../../../../src/render/surface/surface-material.ts';
import { FIXTURE_FACTS, fixtureGlb, parseGlb, testEnv, type TestEnv } from './model-fixtures.ts';

let env: TestEnv;
let template: ModelTemplate;
let opaqueMat: AnySurfaceMaterial;
let transparentMat: AnySurfaceMaterial;
beforeAll(async () => {
  env = testEnv();
  template = buildModelTemplate(modelSourceFromGltf('value.00f1c5.glb', await parseGlb(await fixtureGlb()), FIXTURE_FACTS), env);
  opaqueMat = template.opaqueMesh.material as AnySurfaceMaterial;
  transparentMat = template.transparentMesh.material as AnySurfaceMaterial;
});

/** a corpse-row instance in a non-trivial final pose: turned, scaled head bone, moved root */
function posedInstance(extra: (inst: ModelInstance) => void = (): void => {}): { inst: ModelInstance; headWorld: Matrix4; rootInverse: Matrix4 } {
  const inst = new ModelInstance(template, env.look, { bonePath: 'hierarchy', log: () => {} });
  const head = inst.bones.get('Head')!;
  head.rotation.set(0, 0, Math.PI / 4);
  head.position.x += 0.15;
  head.scale.setScalar(2);
  inst.root.position.set(10, 0, -5);
  inst.root.rotation.y = 0.3;
  inst.root.updateMatrixWorld(true);
  extra(inst);
  return { inst, headWorld: head.matrixWorld.clone(), rootInverse: inst.root.matrixWorld.clone().invert() };
}

/**
 * The independent oracle: the same skinning math (root-relative, w = 1 positions, w = 0 renormalised normals) built
 * from three's Matrix4 composition in float64 — a different code path from the implementation's premultiplied
 * Float32Array loop.
 */
function referenceBake(inst: ModelInstance): { pos: Float64Array; nrm: Float64Array } {
  const t = inst.template;
  const n = t.arrays.vertexCount;
  const outPos = new Float64Array(n * 3);
  const outNrm = new Float64Array(n * 3);
  const rootInverse = inst.root.matrixWorld.clone().invert();
  const inverses = inst.skeleton!.boneInverses;
  const skinMats = inst.boneList.map((b, i) => new Matrix4().multiplyMatrices(rootInverse, b.matrixWorld).multiply(inverses[i]!));
  const { position, normal, skinIndex, skinWeight } = t.arrays;
  for (let v = 0; v < n; v++) {
    const bx = position[v * 3]!, by = position[v * 3 + 1]!, bz = position[v * 3 + 2]!;
    const nx0 = normal[v * 3]!, ny0 = normal[v * 3 + 1]!, nz0 = normal[v * 3 + 2]!;
    let px = 0, py = 0, pz = 0, nx = 0, ny = 0, nz = 0;
    for (let k = 0; k < 4; k++) {
      const w = skinWeight![v * 4 + k]!;
      if (w === 0) continue;
      const m = skinMats[skinIndex![v * 4 + k]!]!.elements;
      px += w * (m[0]! * bx + m[4]! * by + m[8]! * bz + m[12]!);
      py += w * (m[1]! * bx + m[5]! * by + m[9]! * bz + m[13]!);
      pz += w * (m[2]! * bx + m[6]! * by + m[10]! * bz + m[14]!);
      nx += w * (m[0]! * nx0 + m[4]! * ny0 + m[8]! * nz0);
      ny += w * (m[1]! * nx0 + m[5]! * ny0 + m[9]! * nz0);
      nz += w * (m[2]! * nx0 + m[6]! * ny0 + m[10]! * nz0);
    }
    const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    outPos[v * 3] = px; outPos[v * 3 + 1] = py; outPos[v * 3 + 2] = pz;
    outNrm[v * 3] = nx / l; outNrm[v * 3 + 1] = ny / l; outNrm[v * 3 + 2] = nz / l;
  }
  return { pos: outPos, nrm: outNrm };
}

const close = (a: ArrayLike<number>, b: ArrayLike<number>, eps: number): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > eps) return false;
  return true;
};

interface Baked {
  result: CorpseBakeResult;
  headWorld: Matrix4;
  rootInverse: Matrix4;
  ref: { pos: Float64Array; nrm: Float64Array };
  logs: string[];
}

/** bakes one posed instance to completion; the reference is taken from the same instance before the bake */
function bakeOne(poseExtra: (inst: ModelInstance) => void = (): void => {}, attachBones: readonly string[] = []): Baked {
  const logs: string[] = [];
  const results: CorpseBakeResult[] = [];
  const baker = new CorpseBaker({ onReady: (r) => results.push(r), sliceMs: 60_000, log: (m) => logs.push(m) });
  const { inst, headWorld, rootInverse } = posedInstance(poseExtra);
  const ref = referenceBake(inst);
  baker.enqueue(inst, env.look, attachBones);
  while (baker.step()) { /* one step is plenty at 60 s */ }
  baker.dispose();
  return { result: results[0]!, headWorld, rootInverse, ref, logs };
}

describe('CorpseBaker: the bake (render §11.5)', () => {
  it('skins positions and normals into root-relative static geometry, matching the reference', () => {
    const { result, ref } = bakeOne();
    const pos = result.geometry.getAttribute('position')!;
    const nrm = result.geometry.getAttribute('normal')!;
    expect(close(pos.array as Float32Array, ref.pos, 2e-5)).toBe(true);
    expect(close(nrm.array as Float32Array, ref.nrm, 2e-5)).toBe(true);
    for (let v = 0; v < nrm.count; v++) {
      expect(Math.hypot(nrm.getX(v), nrm.getY(v), nrm.getZ(v))).toBeCloseTo(1, 4);
    }
    result.dispose();
  });

  it('is resumable: a fake clock forces one chunk per step and 8 corpses take ≥ 8 steps', () => {
    let t = 0;
    const results: CorpseBakeResult[] = [];
    const baker = new CorpseBaker({ onReady: (r) => results.push(r), sliceMs: 0.3, now: () => t++ });
    for (let i = 0; i < 8; i++) baker.enqueue(posedInstance().inst, env.look);
    let steps = 0;
    do {
      steps++;
    } while (baker.step());
    expect(results.length).toBe(8);
    expect(steps).toBeGreaterThanOrEqual(8);
    for (const r of results) {
      expect(r.geometry.getAttribute('position')!.count).toBe(template.arrays.vertexCount);
      r.dispose();
    }
    baker.dispose();
  });

  it('removes the triangles of hidden parts and keeps the rest', () => {
    const headBit = template.partBits.get('part_head')!;
    const { result } = bakeOne((inst) => inst.setParts({ part_head: { visible: false } }));
    const ss = result.geometry.getAttribute('partPaint')!;
    const index = result.geometry.getIndex()!;
    expect(index.count).toBeLessThan(template.arrays.index.length);
    expect(index.count % 3).toBe(0);
    for (let i = 0; i < index.count; i++) {
      expect(ss.getX(index.getX(i)) === headBit).toBe(false);
    }
    result.dispose();
  });

  it('keeps the look row on the result and detaches it from the disposed instance', () => {
    const { result } = bakeOne();
    const row = result.lookRow;
    expect(row).not.toBe(0);
    expect(env.look.kindOf(row)).toBe('instance'); // not retagged yet: the batcher does that
    result.dispose();
    expect(env.look.kindOf(row)).toBe(undefined); // abandoned: the row is released
  });

  it('freezes attach-bone anchors at the death pose (X-40)', () => {
    const { result, headWorld, rootInverse, logs } = bakeOne(undefined, ['Head', 'NoSuchBone']);
    expect(logs).toEqual(['CorpseBaker: template value.00f1c5.glb has no bone "NoSuchBone"; no frozen anchor']);
    const anchor = result.anchors.get('Head')!;
    expect(anchor).toBeDefined();
    expect(result.anchors.has('NoSuchBone')).toBe(false);
    // the anchor reproduces the bone's final world pose through the corpse root
    expect(close(anchor.matrix.elements, rootInverse.clone().multiply(headWorld).elements, 1e-5)).toBe(true);
    expect(anchor.matrixAutoUpdate).toBe(false);
    expect(anchor.parent).toBe(result.root);
    // a wound child rides the anchor to the bone's final world position
    const wound = new Object3D();
    anchor.add(wound);
    const scene = new Scene();
    scene.add(result.root);
    scene.updateMatrixWorld(true);
    const p = new Vector3();
    wound.getWorldPosition(p);
    expect(p.distanceTo(new Vector3().setFromMatrixPosition(headWorld))).toBeLessThan(1e-4);
    result.dispose();
  });

  it('carries the instance materials and the enqueue tag', () => {
    const results: CorpseBakeResult[] = [];
    const baker = new CorpseBaker({ onReady: (r) => results.push(r), sliceMs: 60_000, log: () => {} });
    const { inst } = posedInstance();
    const opaque = inst.opaqueMesh.material;
    const transparent = inst.transparentMesh.material;
    const visible = inst.transparentMesh.visible;
    baker.enqueue(inst, env.look, [], 'row-7');
    while (baker.step()) { /* one step at 60 s */ }
    const r = results[0]!;
    expect(r.tag).toBe('row-7');
    expect(r.opaqueMaterial).toBe(opaque);
    expect(r.transparentMaterial).toBe(visible ? transparent : null);
    expect(r.hasTransparent).toBe(visible);
    r.dispose();
    baker.dispose();
  });

  it("cancel drops a started bake; the instance keeps drawing with its look row meanwhile and stays the caller's", () => {
    let t = 0;
    const results: CorpseBakeResult[] = [];
    const baker = new CorpseBaker({ onReady: (r) => results.push(r), sliceMs: 0.3, now: () => t++ });
    const { inst } = posedInstance();
    const row = inst.lookRow;
    expect(row).not.toBe(0);
    baker.enqueue(inst, env.look);
    expect(baker.step()).toBe(true); // one chunk: the bake has started
    // the instance still draws until the bake finishes (the bridge hands it over then): with its own row, not the neutral one
    expect(inst.lookRow).toBe(row);
    expect(inst.opaqueMesh.userData['ssLookRow']).toBe(row);
    expect(inst.transparentMesh.userData['ssLookRow']).toBe(row);
    expect(env.look.kindOf(row)).toBe('instance');
    expect(baker.cancel(inst)).toBe(true);
    expect(env.look.kindOf(row)).toBe('instance'); // still the instance's
    expect(baker.pending).toBe(0);
    expect(baker.cancel(inst)).toBe(false);
    expect(baker.step()).toBe(false);
    expect(results.length).toBe(0);
    expect(inst.disposed).toBe(false);
    inst.dispose();
    expect(env.look.kindOf(row)).toBe(undefined); // released with the instance
    baker.dispose();
  });

  it('bounds come from the baked positions', () => {
    const { result } = bakeOne();
    const pos = result.geometry.getAttribute('position')!;
    let minY = Infinity, maxY = -Infinity;
    for (let v = 0; v < pos.count; v++) {
      minY = Math.min(minY, pos.getY(v));
      maxY = Math.max(maxY, pos.getY(v));
    }
    expect(result.geometry.boundingBox!.min.y).toBeCloseTo(minY, 6);
    expect(result.geometry.boundingBox!.max.y).toBeCloseTo(maxY, 6);
    expect(result.geometry.boundingSphere!.radius).toBeGreaterThan(0);
    result.dispose();
  });
});

describe('CorpseBatcher: the batch path (render §11.5, §15.5)', () => {
  function makeBatcher(scene: Scene, opts: Partial<CorpseBatcherOptions> = {}): CorpseBatcher {
    return new CorpseBatcher({
      scene,
      table: env.look,
      budget: createRenderBudget('high', { high: { gibs: 220, corpses: 64 }, medium: { gibs: 160, corpses: 48 }, low: { gibs: 80, corpses: 24 }, minimum: { gibs: 40, corpses: 12 } }),
      profileCap: 4,
      maxVerticesPerCorpse: 600,
      maxIndicesPerCorpse: 1200,
      multiDraw: true,
      ...opts,
    });
  }

  function batchesOf(scene: Scene): BatchedMesh[] {
    return scene.children.filter((c): c is BatchedMesh => (c as BatchedMesh).isBatchedMesh === true);
  }

  /** the look rows a batch's instances read: its texel row of the table's batch-row texture */
  function lookRowsOf(batch: BatchedMesh): number[] {
    const slot = batch.userData[CORPSE_BATCH_KEY] as number;
    expect(Number.isInteger(slot)).toBe(true);
    const rows: number[] = [];
    for (let i = 0; i < batch.maxInstanceCount; i++) rows.push(env.look.batchRowAt(slot, i));
    return rows;
  }

  const liveRows = (scene: Scene): Set<number> => {
    const rows = new Set<number>();
    for (const b of batchesOf(scene)) for (const v of lookRowsOf(b)) if (v !== 0) rows.add(v);
    return rows;
  };

  it('draws corpses from one BatchedMesh per material and pass and tracks per-instance look rows', () => {
    const scene = new Scene();
    const batcher = makeBatcher(scene);
    const r1 = bakeOne().result;
    const r2 = bakeOne().result;
    const id1 = batcher.add(r1);
    const id2 = batcher.add(r2);
    expect(batcher.size).toBe(2);
    expect(r1.hasTransparent).toBe(true); // the fixture blends
    expect(batchesOf(scene).length).toBe(2); // opaque + transparent of the one template material pair
    // the template's own pass materials (its texture sets are bound in them), one batch each
    expect(new Set(batchesOf(scene).map((b) => b.material))).toEqual(new Set([opaqueMat, transparentMat]));
    expect(liveRows(scene)).toEqual(new Set([r1.lookRow, r2.lookRow]));
    expect(env.look.kindOf(r1.lookRow)).toBe('corpse'); // retagged by add()
    expect(batcher.setRootMatrix(id1, new Matrix4().makeTranslation(0, -2, 0))).toBe(true);
    expect(batcher.setRootMatrix(999, new Matrix4())).toBe(false);
    expect(batcher.remove(id1)).toBe(true);
    expect(batcher.size).toBe(1);
    expect(liveRows(scene).has(r1.lookRow)).toBe(false);
    expect(env.look.kindOf(r1.lookRow)).toBe(undefined); // released
    // instance-id reuse writes the new corpse's row over the freed texel
    const r3 = bakeOne().result;
    batcher.add(r3);
    expect(liveRows(scene)).toEqual(new Set([r2.lookRow, r3.lookRow]));
    void id2;
    const slots = batchesOf(scene).map((b) => b.userData[CORPSE_BATCH_KEY] as number);
    batcher.dispose();
    expect(batchesOf(scene).length).toBe(0);
    // the batch rows went back to the table, cleared
    for (const slot of slots) for (let i = 0; i < 4; i++) expect(env.look.batchRowAt(slot, i)).toBe(0);
  });

  it("a corpse of another material gets its own batch (a template's texture sets are part of its material)", () => {
    const scene = new Scene();
    const batcher = makeBatcher(scene);
    const r1 = bakeOne().result;
    const base = bakeOne().result;
    // another variant-cache key (another template's material stands in: the fixture is the one template)
    const other = env.materials.get({ variant: SurfaceVariant.SRC_GLTF | SurfaceVariant.PARTMASK, state: { polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 } });
    expect(other).not.toBe(base.opaqueMaterial);
    const r2: CorpseBakeResult = { ...base, opaqueMaterial: other, transparentMaterial: null, hasTransparent: false };
    batcher.add(r1);
    batcher.add(r2);
    const batches = batchesOf(scene);
    expect(batches.length).toBe(3); // r1: opaque + transparent; r2: its own opaque
    const otherBatch = batches.find((b) => b.material === other)!;
    expect(otherBatch).toBeDefined();
    expect(lookRowsOf(otherBatch).filter((v) => v !== 0)).toEqual([r2.lookRow]);
    const slots = new Set(batches.map((b) => b.userData[CORPSE_BATCH_KEY] as number));
    expect(slots.size).toBe(3); // one texel row each
    batcher.dispose();
  });

  it('evicts oldest-first at the live cap and survives lifetime churn without deleteGeometry', () => {
    const scene = new Scene();
    const removed: number[] = [];
    const batcher = makeBatcher(scene, { onRemove: (id) => removed.push(id) });
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) ids.push(batcher.add(bakeOne().result));
    expect(batcher.size).toBe(4);
    batcher.add(bakeOne().result); // the 5th evicts the oldest
    expect(batcher.size).toBe(4);
    expect(removed).toEqual([ids[0]]);
    expect(batcher.remove(ids[0]!)).toBe(false); // already evicted
    expect(ids.slice(1).every((id) => batcher.remove(id))).toBe(true);
    batcher.add(bakeOne().result);
    expect(batcher.size).toBe(2);
    // churn: 20 more lifetime cycles over the same 4 slots must not exhaust the buffers
    for (let i = 0; i < 20; i++) batcher.add(bakeOne().result);
    expect(batcher.size).toBe(4);
    batcher.dispose();
  });

  it('syncBudget evicts down to a dropped tier at once', () => {
    let tier: TierId = 'high';
    const scene = new Scene();
    const batcher = makeBatcher(scene, { budget: createRenderBudget(() => tier, { high: { gibs: 220, corpses: 64 }, medium: { gibs: 160, corpses: 48 }, low: { gibs: 80, corpses: 24 }, minimum: { gibs: 40, corpses: 12 } }), profileCap: 64 });
    for (let i = 0; i < 20; i++) batcher.add(bakeOne().result);
    expect(batcher.size).toBe(20);
    tier = 'minimum'; // corpses: 12
    batcher.syncBudget();
    expect(batcher.size).toBe(12);
    expect(batcher.cap()).toBe(12);
    batcher.dispose();
  });

  it('a full material batch gives up its own oldest corpse when bucketCapacity is below the cap', () => {
    const scene = new Scene();
    const batcher = makeBatcher(scene, { bucketCapacity: 2 });
    const ids = [batcher.add(bakeOne().result), batcher.add(bakeOne().result)];
    const id3 = batcher.add(bakeOne().result);
    expect(batcher.size).toBe(2);
    expect(batcher.remove(ids[0]!)).toBe(false);
    expect(batcher.remove(ids[1]!)).toBe(true);
    expect(batcher.remove(id3)).toBe(true);
    batcher.dispose();
  });

  it('a bake larger than one geometry slot draws as its own mesh instead of throwing', () => {
    const logs: string[] = [];
    const scene = new Scene();
    const batcher = makeBatcher(scene, { maxVerticesPerCorpse: 8, log: (m) => logs.push(m) });
    const { result } = bakeOne();
    const id = batcher.add(result);
    expect(batchesOf(scene).length).toBe(0);
    expect(logs.length).toBe(1);
    expect(logs[0]).toMatch(/exceeds the 8 \/ 1200 slot/);
    const meshes = result.root.children.filter((c): c is Mesh => (c as Mesh).isMesh === true);
    expect(meshes.length).toBe(2);
    expect(batcher.remove(id)).toBe(true);
    batcher.dispose();
  });

  it('falls back to one Mesh per corpse without multi-draw, reading the per-object look row, placed once', () => {
    const scene = new Scene();
    const batcher = makeBatcher(scene, { multiDraw: false });
    expect(batcher.batched).toBe(false);
    const { result } = bakeOne();
    const id = batcher.add(result);
    expect(batchesOf(scene).length).toBe(0);
    const root = scene.children.find((c) => c.name.startsWith('ss:corpse:'))!;
    expect(root).toBe(result.root);
    const meshes = root.children.filter((c): c is Mesh => (c as Mesh).isMesh === true);
    expect(meshes.length).toBeGreaterThanOrEqual(1);
    for (const m of meshes) expect(m.userData['ssLookRow']).toBe(result.lookRow);
    // the root-relative geometry is placed by the root alone (not root × root)
    scene.updateMatrixWorld(true);
    for (const m of meshes) expect(m.matrixWorld.equals(result.rootMatrix)).toBe(true);
    const sink = new Matrix4().makeTranslation(1, -0.5, 0).multiply(result.rootMatrix);
    expect(batcher.setRootMatrix(id, sink)).toBe(true);
    scene.updateMatrixWorld(true);
    for (const m of meshes) expect(m.matrixWorld.equals(sink)).toBe(true);
    expect(batcher.remove(id)).toBe(true);
    expect(root.parent).toBe(null);
    batcher.dispose();
  });
});
