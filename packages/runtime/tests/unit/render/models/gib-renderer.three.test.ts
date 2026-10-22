// WP R7 (render §11.6, §15.3, §15.5): batched gib rendering, the 0.9 s fade/expiry, cap eviction and the
// no-multi-draw fallback. Node + three's scene graph, no renderer: poses and fades are read back from the real
// r186 BatchedMesh / InstancedMesh objects.
import { BufferAttribute, BufferGeometry, Matrix4, Scene, Vector3 } from 'three/webgpu';
import type { BatchedMesh, InstancedMesh } from 'three/webgpu';
import { beforeAll, describe, expect, it } from 'vitest';
import { createRenderBudget, type TierId } from '../../../../src/render/perf/budget.ts';
import { GIB_TTL_MS, GibRenderer, type GibPass, type GibPieceSpec } from '../../../../src/render/models/gib-renderer.ts';
import { buildModelTemplate, modelSourceFromGltf, type ModelTemplate } from '../../../../src/render/models/model-template.ts';
import type { AnySurfaceMaterial } from '../../../../src/render/surface/surface-material.ts';
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

/** a small chunk: 8 verts, 12 tris, with ss paint ids */
function chunkGeometry(): BufferGeometry {
  const s = 0.1;
  const position = new Float32Array([
    -s, -s, -s, s, -s, -s, s, s, -s, -s, s, -s,
    -s, -s, s, s, -s, s, s, s, s, -s, s, s,
  ]);
  const normal = new Float32Array(8 * 3).fill(0);
  for (let i = 0; i < 8; i++) {
    const l = Math.hypot(position[i * 3]!, position[i * 3 + 1]!, position[i * 3 + 2]!) || 1;
    normal[i * 3] = position[i * 3]! / l; normal[i * 3 + 1] = position[i * 3 + 1]! / l; normal[i * 3 + 2] = position[i * 3 + 2]! / l;
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(position, 3));
  g.setAttribute('normal', new BufferAttribute(normal, 3));
  g.setAttribute('partPaint', new BufferAttribute(new Uint8Array(8 * 4), 4, true));
  g.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6, 0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2, 2, 6, 7, 2, 7, 3, 4, 0, 3, 4, 3, 7]), 1));
  return g;
}

function pieces(): GibPieceSpec[] {
  return [
    { id: 'flesh-a', set: '', geometry: chunkGeometry() },
    { id: 'flesh-b', set: '', geometry: chunkGeometry() },
    { id: 'skull-a', set: 'skin-arachnid', geometry: chunkGeometry() },
  ];
}

const matFor = (set: string, pass: GibPass): AnySurfaceMaterial | null => {
  void set;
  return pass === 'opaque' ? opaqueMat : transparentMat;
};

function batchesOf(scene: Scene): BatchedMesh[] {
  return scene.children.filter((c): c is BatchedMesh => (c as BatchedMesh).isBatchedMesh === true);
}

function instancedOf(scene: Scene): InstancedMesh[] {
  return scene.children.filter((c): c is InstancedMesh => (c as InstancedMesh).isInstancedMesh === true);
}

describe('GibRenderer: the batch path (render §11.6)', () => {
  it('batches pieces by texture set and pass, one geometry entry per piece type', () => {
    const scene = new Scene();
    const r = new GibRenderer({ scene, budget: createRenderBudget('high', { high: { gibs: 220, corpses: 64 }, medium: { gibs: 160, corpses: 48 }, low: { gibs: 80, corpses: 24 }, minimum: { gibs: 40, corpses: 12 } }), profileCap: 8, pieces: pieces(), materialFor: matFor, multiDraw: true });
    expect(r.batched).toBe(true);
    const batches = batchesOf(scene);
    // flat set (opaque + transparent) + skull set (opaque + transparent)
    expect(batches.length).toBe(4);
    for (const b of batches) {
      expect(b.frustumCulled).toBe(false);
      expect(b.perObjectFrustumCulled).toBe(false);
    }
    r.dispose();
    expect(batchesOf(scene).length).toBe(0);
  });

  it('a gib lives until removed: setPose writes the row pose (with its own fade scale) at once, tick() never expires it', () => {
    let t = 0;
    const scene = new Scene();
    const r = new GibRenderer({ scene, budget: createRenderBudget('high', { high: { gibs: 220, corpses: 64 }, medium: { gibs: 160, corpses: 48 }, low: { gibs: 80, corpses: 24 }, minimum: { gibs: 40, corpses: 12 } }), profileCap: 8, pieces: pieces(), materialFor: matFor, multiDraw: true, now: () => t });
    const id = r.spawn('flesh-a', new Matrix4().makeTranslation(1, 2, 3))!;
    const batch = batchesOf(scene).find((b) => b.name === 'ss:gibs:flat:opaque')!;
    // the game fades a gib by writing its row's scale (gore.js poolFade): it arrives inside the pose
    r.setPose(id, new Matrix4().makeTranslation(4, 5, 6).scale(new Vector3(0.55, 0.55, 0.55)));
    const m = new Matrix4();
    batch.getMatrixAt(0, m);
    expect(m.elements[12]).toBeCloseTo(4, 6);
    expect(m.elements[0]).toBeCloseTo(0.55, 6);
    // a live gib outlasts the 0.9 s fade span by far (gibLife is 12-40 s): the renderer does not end it
    t = GIB_TTL_MS * 100;
    r.tick();
    expect(r.live).toBe(1);
    batch.getMatrixAt(0, m);
    expect(m.elements[0]).toBeCloseTo(0.55, 6);
    expect(r.remove(id)).toBe(true);
    expect(r.live).toBe(0);
    r.dispose();
  });

  it('spawn/setPose/tick with ttlMs: poses are written and the renderer-side fade shrinks the gib over 0.9 s', () => {
    let t = 0;
    const scene = new Scene();
    const r = new GibRenderer({ scene, budget: createRenderBudget('high', { high: { gibs: 220, corpses: 64 }, medium: { gibs: 160, corpses: 48 }, low: { gibs: 80, corpses: 24 }, minimum: { gibs: 40, corpses: 12 } }), profileCap: 8, pieces: pieces(), materialFor: matFor, multiDraw: true, now: () => t });
    const id = r.spawn('flesh-a', new Matrix4().makeTranslation(1, 2, 3), { scale: 2, ttlMs: GIB_TTL_MS })!;
    expect(r.live).toBe(1);
    // the flat opaque batch holds the first gib at instance 0
    const batch = batchesOf(scene).find((b) => b.name === 'ss:gibs:flat:opaque')!;
    const m0 = new Matrix4();
    batch.getMatrixAt(0, m0);
    expect(m0.elements[12]).toBeCloseTo(1, 6);
    expect(m0.elements[0]).toBeCloseTo(2, 6); // scale 2, no fade yet
    // the bridge moves the gib per physics tick
    r.setPose(id, new Matrix4().makeTranslation(4, 5, 6));
    t = GIB_TTL_MS / 2;
    r.tick();
    const m1 = new Matrix4();
    batch.getMatrixAt(0, m1);
    expect(m1.elements[12]).toBeCloseTo(4, 6);
    expect(m1.elements[0]).toBeCloseTo(2 * (1 - 0.9 * 0.5), 6); // scale × (1 − 0.9·fade)
    // expiry at the end of life
    t = GIB_TTL_MS;
    r.tick();
    expect(r.live).toBe(0);
    r.dispose();
  });

  it('evicts the oldest gib past the live cap', () => {
    const scene = new Scene();
    const r = new GibRenderer({ scene, budget: createRenderBudget('high', { high: { gibs: 220, corpses: 64 }, medium: { gibs: 160, corpses: 48 }, low: { gibs: 80, corpses: 24 }, minimum: { gibs: 40, corpses: 12 } }), profileCap: 4, pieces: pieces(), materialFor: matFor, multiDraw: true });
    const ids: number[] = [];
    for (let i = 0; i < 4; i++) ids.push(r.spawn('flesh-a', new Matrix4())!);
    expect(r.live).toBe(4);
    const id5 = r.spawn('skull-a', new Matrix4())!;
    expect(r.live).toBe(4);
    expect(r.setPose(ids[0]!, new Matrix4())).toBe(false); // evicted
    expect(r.setPose(id5, new Matrix4())).toBe(true);
    r.dispose();
  });

  it('syncBudget evicts down to a dropped tier at once', () => {
    let tier: TierId = 'high';
    const scene = new Scene();
    const r = new GibRenderer({ scene, budget: createRenderBudget(() => tier, { high: { gibs: 220, corpses: 64 }, medium: { gibs: 160, corpses: 48 }, low: { gibs: 80, corpses: 24 }, minimum: { gibs: 40, corpses: 12 } }), profileCap: 220, pieces: pieces(), materialFor: matFor, multiDraw: true });
    for (let i = 0; i < 30; i++) r.spawn('flesh-a', new Matrix4());
    expect(r.live).toBe(30);
    tier = 'low'; // gibs: 80 — still above 30
    r.syncBudget();
    expect(r.live).toBe(30);
    tier = 'minimum'; // gibs: 40 — still above 30
    r.syncBudget();
    expect(r.live).toBe(30);
    for (let i = 0; i < 30; i++) r.spawn('flesh-b', new Matrix4());
    expect(r.live).toBe(40); // capped at the minimum tier
    r.dispose();
  });

  it('an empty piece list builds nothing and spawns nothing', () => {
    const logs: string[] = [];
    const scene = new Scene();
    const r = new GibRenderer({ scene, budget: createRenderBudget('high', { high: { gibs: 220, corpses: 64 }, medium: { gibs: 160, corpses: 48 }, low: { gibs: 80, corpses: 24 }, minimum: { gibs: 40, corpses: 12 } }), profileCap: 8, pieces: [], materialFor: matFor, multiDraw: true, log: (m) => logs.push(m) });
    expect(scene.children.length).toBe(0);
    expect(r.spawn('flesh-a', new Matrix4())).toBe(null);
    expect(logs).toEqual(['GibRenderer: unknown piece "flesh-a"; gib not spawned']);
    r.dispose();
  });

  it('an unknown piece logs and returns null; a piece without ss throws', () => {
    const logs: string[] = [];
    const scene = new Scene();
    const r = new GibRenderer({ scene, budget: createRenderBudget('high', { high: { gibs: 220, corpses: 64 }, medium: { gibs: 160, corpses: 48 }, low: { gibs: 80, corpses: 24 }, minimum: { gibs: 40, corpses: 12 } }), profileCap: 8, pieces: pieces(), materialFor: matFor, multiDraw: true, log: (m) => logs.push(m) });
    expect(r.spawn('nope', new Matrix4())).toBe(null);
    expect(logs).toEqual(['GibRenderer: unknown piece "nope"; gib not spawned']);
    const bad = chunkGeometry();
    bad.deleteAttribute('partPaint');
    expect(() => new GibRenderer({
      scene: new Scene(), budget: createRenderBudget('high', { high: { gibs: 220, corpses: 64 }, medium: { gibs: 160, corpses: 48 }, low: { gibs: 80, corpses: 24 }, minimum: { gibs: 40, corpses: 12 } }), profileCap: 8,
      pieces: [{ id: 'bad', set: '', geometry: bad }], materialFor: matFor, multiDraw: true,
    })).toThrow(/needs a normalized ubyte4 ss attribute/);
    r.dispose();
  });
});

describe('GibRenderer: the no-multi-draw fallback (render §11.6)', () => {
  it('uses one InstancedMesh per piece type; empty ones are hidden', () => {
    const scene = new Scene();
    const r = new GibRenderer({ scene, budget: createRenderBudget('high', { high: { gibs: 220, corpses: 64 }, medium: { gibs: 160, corpses: 48 }, low: { gibs: 80, corpses: 24 }, minimum: { gibs: 40, corpses: 12 } }), profileCap: 8, pieces: pieces(), materialFor: matFor, multiDraw: false });
    expect(r.batched).toBe(false);
    expect(batchesOf(scene).length).toBe(0);
    const id1 = r.spawn('flesh-a', new Matrix4())!;
    const id2 = r.spawn('flesh-a', new Matrix4().makeTranslation(1, 0, 0))!;
    const meshes = instancedOf(scene).filter((m) => m.name === 'ss:gibs:flesh-a:opaque');
    expect(meshes.length).toBe(1);
    const mesh = meshes[0]!;
    expect(mesh.visible).toBe(true);
    expect(mesh.count).toBe(2);
    expect(mesh.frustumCulled).toBe(false);
    expect(r.remove(id1)).toBe(true);
    expect(mesh.count).toBe(1);
    // the surviving gib moved into the freed slot with its matrix intact
    const m = new Matrix4();
    mesh.getMatrixAt(0, m);
    expect(m.elements[12]).toBeCloseTo(1, 6);
    expect(r.remove(id2)).toBe(true);
    expect(mesh.count).toBe(0);
    expect(mesh.visible).toBe(false);
    r.dispose();
    expect(instancedOf(scene).length).toBe(0);
  });

  it('the fallback fades and expires too', () => {
    let t = 0;
    const scene = new Scene();
    const r = new GibRenderer({ scene, budget: createRenderBudget('high', { high: { gibs: 220, corpses: 64 }, medium: { gibs: 160, corpses: 48 }, low: { gibs: 80, corpses: 24 }, minimum: { gibs: 40, corpses: 12 } }), profileCap: 8, pieces: pieces(), materialFor: () => opaqueMat, multiDraw: false, now: () => t });
    r.spawn('skull-a', new Matrix4(), { scale: 1, ttlMs: GIB_TTL_MS });
    const mesh = instancedOf(scene).find((m) => m.name === 'ss:gibs:skull-a:opaque')!;
    t = GIB_TTL_MS / 2;
    r.tick();
    const m = new Matrix4();
    mesh.getMatrixAt(0, m);
    expect(m.elements[0]).toBeCloseTo(1 - 0.9 * 0.5, 6);
    t = GIB_TTL_MS;
    r.tick();
    expect(r.live).toBe(0);
    expect(mesh.visible).toBe(false);
    r.dispose();
  });
});
