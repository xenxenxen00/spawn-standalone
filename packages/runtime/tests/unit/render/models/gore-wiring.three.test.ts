// WP R7 production wiring (render §11.5, §11.6, §15.3; X-20, X-40): the corpse batches grow with the corpses there are, receive
// the shadowCaster like the bodies, keep their anchors current; gib pieces can be added after construction; and
// `createGoreRenderers` (src/render/world/gore-renderers.ts) joins both systems behind the bridge's handoff seam, only for
// programs a warm-up linked. Node + three's scene graph, no renderer.
import { BufferAttribute, BufferGeometry, Matrix4, Object3D, Scene, Vector3 } from 'three/webgpu';
import type { BatchedMesh } from 'three/webgpu';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RowSnapshot } from '../../../../src/compat/core/ports.ts';
import { createGoreRenderers, gibPieceGeometry, type GoreRenderData } from '../../../../src/render/world/gore-renderers.ts';
import { CorpseSystem } from '../../../../src/render/models/corpse-system.ts';
import { GibRenderer, type GibPass } from '../../../../src/render/models/gib-renderer.ts';
import { ModelInstance } from '../../../../src/render/models/model-instance.ts';
import { buildModelTemplate, modelSourceFromGltf, type ModelTemplate } from '../../../../src/render/models/model-template.ts';
import { createRenderBudget } from '../../../../src/render/perf/budget.ts';
import type { AnySurfaceMaterial } from '../../../../src/render/surface/surface-material.ts';
import { FIXTURE_FACTS, fixtureGlb, parseGlb, testEnv, type TestEnv } from './model-fixtures.ts';

let env: TestEnv;
let body: ModelTemplate;
let rigid: ModelTemplate;
beforeAll(async () => {
  env = testEnv();
  body = buildModelTemplate(modelSourceFromGltf('value.00f1c5.glb', await parseGlb(await fixtureGlb()), FIXTURE_FACTS), env);
  rigid = buildModelTemplate(modelSourceFromGltf('value.0a1b2c.glb', await parseGlb(await fixtureGlb({ rigid: true })), FIXTURE_FACTS), env);
});

const row = (id: string, tags: string[], model?: unknown): RowSnapshot => ({ id, tags, props: model === undefined ? {} : { model }, spec: {} }) as unknown as RowSnapshot;

function corpse(x: number): ModelInstance {
  const inst = new ModelInstance(body, env.look, { bonePath: 'hierarchy', log: () => {} });
  inst.bones.get('Head')!.rotation.set(0, 0, Math.PI / 5);
  inst.root.position.set(x, 0, -2);
  inst.root.updateMatrixWorld(true);
  return inst;
}

const batchesOf = (scene: Scene): BatchedMesh[] => scene.children.filter((c): c is BatchedMesh => (c as BatchedMesh).isBatchedMesh === true);

function settle(system: { update(): void }, frames = 4): void {
  for (let i = 0; i < frames; i++) system.update();
}

describe('CorpseBatcher in production (render §11.5)', () => {
  it('grows a batch by doubling instead of reserving the cap for every material, and every corpse stays batched', () => {
    const scene = new Scene();
    const system = new CorpseSystem({
      isCorpseRow: (row) => row.tags.includes('corpse'),
      baker: { sliceMs: 60_000, log: () => {} },
      batcher: { scene, table: env.look, budget: createRenderBudget('high', { high: { gibs: 220, corpses: 64 }, medium: { gibs: 160, corpses: 48 }, low: { gibs: 80, corpses: 24 }, minimum: { gibs: 40, corpses: 12 } }), profileCap: 8, maxVerticesPerCorpse: 600, maxIndicesPerCorpse: 1200, bucketInitial: 2, multiDraw: true, log: () => {} },
      stillFrames: 2,
      log: () => {},
    });
    for (let i = 0; i < 5; i++) system.track(`c${i}`, row(`c${i}`, ['corpse']), corpse(i));
    settle(system, 8);
    expect(system.batcher.size).toBe(5);
    const [batch] = batchesOf(scene);
    expect(batch).toBeDefined();
    // 2 → 4 → 8: the reservation follows the corpses
    expect(batch!.maxInstanceCount).toBe(8);
    expect(batch!.instanceCount).toBe(5);
    // a world model receives on every tier, and the batch casts when its corpses do
    expect(batch!.receiveShadow).toBe(true);
    expect(batch!.castShadow).toBe(body.opaqueMesh.castShadow);
    for (let i = 0; i < 5; i++) expect(system.handedOver(`c${i}`)).toBe(true);
    system.dispose();
  });

  it('a grenade killing 8 enemies bakes over at least 8 frames, one bake at a time, each frame within its slice (fake clock)', () => {
    const scene = new Scene();
    let t = 0;
    // every clock read costs 0.02 ms: one read per 64-vertex chunk, so a slice of 0.3 ms skins a few chunks per frame
    const now = (): number => (t += 0.02);
    const system = new CorpseSystem({
      isCorpseRow: (row) => row.tags.includes('corpse'),
      baker: { sliceMs: 0.3, now, log: () => {} },
      batcher: { scene, table: env.look, budget: createRenderBudget('high', { high: { gibs: 220, corpses: 64 }, medium: { gibs: 160, corpses: 48 }, low: { gibs: 80, corpses: 24 }, minimum: { gibs: 40, corpses: 12 } }), profileCap: 16, maxVerticesPerCorpse: 600, maxIndicesPerCorpse: 1200, multiDraw: true, log: () => {} },
      stillFrames: 2,
      log: () => {},
    });
    for (let i = 0; i < 8; i++) system.track(`k${i}`, row(`k${i}`, ['corpse']), corpse(i));
    const done = new Map<number, number>();
    let worst = 0;
    for (let frame = 0; frame < 400 && done.size < 8; frame++) {
      const t0 = t;
      system.update();
      worst = Math.max(worst, t - t0);
      for (let i = 0; i < 8; i++) if (system.handedOver(`k${i}`) && !done.has(i)) done.set(i, frame);
    }
    const doneAt = [...done.values()];
    expect(doneAt).toHaveLength(8);
    // one bake at a time: no two finish in the same frame, so eight take at least eight frames
    expect(new Set(doneAt).size).toBe(8);
    expect(Math.max(...doneAt) - Math.min(...doneAt)).toBeGreaterThanOrEqual(7);
    // the slice is checked between chunks: a frame overruns 0.3 ms by at most one chunk's clock read (and the setup's)
    expect(worst).toBeLessThanOrEqual(0.3 + 0.1);
    system.dispose();
  });

  it('bakes a corpse whose bones only tremble (the live 0.001-weight idle loop), never one that still moves', () => {
    const make = (): CorpseSystem =>
      new CorpseSystem({
      isCorpseRow: (row) => row.tags.includes('corpse'),
        baker: { sliceMs: 60_000, log: () => {} },
        batcher: { scene: new Scene(), table: env.look, budget: createRenderBudget('high', { high: { gibs: 220, corpses: 64 }, medium: { gibs: 160, corpses: 48 }, low: { gibs: 80, corpses: 24 }, minimum: { gibs: 40, corpses: 12 } }), profileCap: 4, maxVerticesPerCorpse: 600, maxIndicesPerCorpse: 1200, multiDraw: true, log: () => {} },
        log: () => {},
      });
    const run = (step: number): boolean => {
      const system = make();
      const inst = corpse(0);
      const head = inst.bones.get('Head')!;
      system.track('c', row('c', ['corpse']), inst);
      for (let i = 0; i < 40; i++) {
        // alternate around the pose: an idle loop's trace at a thousandth of its weight
        head.rotation.z = Math.PI / 5 + (i % 2 === 0 ? step : -step);
        inst.root.updateMatrixWorld(true);
        system.update();
      }
      const done = system.handedOver('c');
      system.dispose();
      return done;
    };
    expect(run(1e-4)).toBe(true);
    expect(run(0.05)).toBe(false);
  });

  it('keeps the frozen anchors current at once when the row sinks (no scene update in between)', () => {
    const scene = new Scene();
    const system = new CorpseSystem({
      isCorpseRow: (row) => row.tags.includes('corpse'),
      baker: { sliceMs: 60_000, log: () => {} },
      batcher: { scene, table: env.look, budget: createRenderBudget('high', { high: { gibs: 220, corpses: 64 }, medium: { gibs: 160, corpses: 48 }, low: { gibs: 80, corpses: 24 }, minimum: { gibs: 40, corpses: 12 } }), profileCap: 4, maxVerticesPerCorpse: 600, maxIndicesPerCorpse: 1200, multiDraw: true, log: () => {} },
      stillFrames: 2,
      log: () => {},
    });
    const inst = corpse(3);
    const head = new Vector3().setFromMatrixPosition(inst.bones.get('Head')!.matrixWorld);
    system.track('c', row('c', ['corpse']), inst);
    settle(system);
    const anchor = system.frozenBone('c', 'Head')!;
    expect(new Vector3().setFromMatrixPosition(anchor.matrixWorld).distanceTo(head)).toBeLessThan(1e-4);
    system.setPose('c', new Matrix4().makeTranslation(3, -0.4, -2));
    expect(new Vector3().setFromMatrixPosition(anchor.matrixWorld).y).toBeCloseTo(head.y - 0.4, 4);
    system.dispose();
  });
});

describe('GibRenderer.addPiece (render §11.6)', () => {
  const geometry = (n: number): BufferGeometry => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(n * 3).map((_, i) => i * 0.01), 3));
    g.setAttribute('normal', new BufferAttribute(new Float32Array(n * 3).fill(0.5), 3));
    g.setAttribute('partPaint', new BufferAttribute(new Uint8Array(n * 4), 4, true));
    g.setIndex(new BufferAttribute(new Uint16Array(Array.from({ length: n }, (_, i) => i)), 1));
    return g;
  };
  const mat = (): AnySurfaceMaterial => body.opaqueMesh.material as AnySurfaceMaterial;

  it('builds a set on its first piece, grows it for later ones and keeps the live gibs where they were', () => {
    const scene = new Scene();
    const r = new GibRenderer({ scene, budget: createRenderBudget('high', { high: { gibs: 220, corpses: 64 }, medium: { gibs: 160, corpses: 48 }, low: { gibs: 80, corpses: 24 }, minimum: { gibs: 40, corpses: 12 } }), profileCap: 16, pieces: [], materialFor: (_s: string, p: GibPass) => (p === 'opaque' ? mat() : null), multiDraw: true, log: () => {} });
    expect(r.addPiece({ id: 'a', set: '', geometry: geometry(6) })).toBe(true);
    expect(r.addPiece({ id: 'a', set: '', geometry: geometry(6) })).toBe(false);
    const at = new Matrix4().makeTranslation(1, 2, 3);
    const gib = r.spawn('a', at)!;
    const [batch] = batchesOf(scene);
    expect(batch!.receiveShadow).toBe(true);
    // 6 × 8 reserved; a 90-vertex piece needs more: the batch grows
    expect(r.addPiece({ id: 'b', set: '', geometry: geometry(90) })).toBe(true);
    expect(batchesOf(scene)).toHaveLength(1);
    expect(r.spawn('b', new Matrix4())).not.toBeNull();
    const m = new Matrix4();
    batch!.getMatrixAt(0, m);
    expect(m.elements[13]).toBeCloseTo(2, 6);
    expect(r.setPose(gib, new Matrix4().makeTranslation(0, 5, 0))).toBe(true);
    // a second set gets its own batch
    expect(r.addPiece({ id: 'c', set: 'skin', geometry: geometry(6) })).toBe(true);
    expect(batchesOf(scene)).toHaveLength(2);
    expect(r.live).toBe(2);
    r.dispose();
  });
});

describe('createGoreRenderers: the bridge handoff (render §11.5, §11.6)', () => {
  const data: GoreRenderData = { corpses: 64, gibs: 220, maxCorpses: 64, slotVertices: 12288, slotIndices: 36864, tierCaps: { high: { gibs: 220, corpses: 64 }, medium: { gibs: 160, corpses: 48 }, low: { gibs: 80, corpses: 24 }, minimum: { gibs: 40, corpses: 12 } }, corpseTag: 'corpse', gibTag: 'gib' };
  const make = (over: { warmed?: (key: string) => boolean; data?: GoreRenderData | null; templates?: Map<string, ModelTemplate> } = {}) => {
    const scene = new Scene();
    const logs: string[] = [];
    const gore = createGoreRenderers({
      scene,
      look: env.look,
      materials: env.materials,
      templates: over.templates ?? new Map([['cdn/gore-heart.glb', rigid]]),
      tier: () => 'high',
      data: () => (over.data === undefined ? data : over.data),
      multiDraw: () => true,
      warmed: over.warmed ?? (() => true),
      shadows: () => false,
      log: (m) => logs.push(m),
    });
    return { scene, gore, logs };
  };

  it('claims a gib row of a loaded static piece, draws it batched at the row pose and ends it on release', () => {
    const { scene, gore } = make();
    const world = new Matrix4().makeTranslation(2, 0.5, 1);
    expect(gore.handoff.claim(row('g1', ['gib', 'gore'], 'cdn/gore-heart.glb'), world)).toBe(true);
    expect(gore.gibs!.tracks('g1')).toBe(true);
    // not loaded, dressed or no gib: the model path
    expect(gore.handoff.claim(row('g2', ['gib'], 'cdn/not-loaded.glb'), world)).toBe(false);
    expect(gore.handoff.claim(row('g3', ['gib'], { id: 'cdn/gore-heart.glb', materials: { skin: { color: '#f00' } } }), world)).toBe(false);
    expect(gore.handoff.claim(row('crate', [], 'cdn/gore-heart.glb'), world)).toBe(false);
    const [batch] = batchesOf(scene);
    const m = new Matrix4();
    gore.handoff.pose('g1', new Matrix4().makeTranslation(4, 0, 0));
    batch!.getMatrixAt(0, m);
    expect(m.elements[12]).toBeCloseTo(4, 6);
    gore.handoff.release('g1');
    expect(gore.gibs!.tracks('g1')).toBe(false);
    expect(gore.stats().gibs.live).toBe(0);
    gore.dispose();
  });

  it('tracks a corpse model, bakes it in the corpses stage and owns it then; frozen bones resolve through `bones`', () => {
    const { gore } = make();
    const inst = corpse(1);
    expect(gore.handoff.placed(row('c1', ['corpse', 'gore']), inst)).toBe(true);
    expect(gore.handoff.owns('c1')).toBe(false);
    for (let i = 0; i < 14; i++) gore.update();
    expect(gore.handoff.owns('c1')).toBe(true);
    expect(inst.disposed).toBe(true);
    expect(gore.bones('c1', 'Head')).toBeInstanceOf(Object3D);
    // one batch per pass the body draws in: the fixture has alpha < 1 paints, so opaque and transparent
    expect(gore.stats().corpses).toMatchObject({ tracked: 1, batched: 1, batches: 2, batchPath: true });
    gore.handoff.release('c1');
    expect(gore.stats().corpses.batched).toBe(0);
    gore.dispose();
  });

  it('leaves rows on the model path when no warm-up linked their programs, or before the game data is known', () => {
    const cold = make({ warmed: () => false });
    expect(cold.gore.handoff.claim(row('g', ['gib'], 'cdn/gore-heart.glb'), new Matrix4())).toBe(false);
    const inst = corpse(0);
    expect(cold.gore.handoff.placed(row('c', ['corpse']), inst)).toBe(false);
    expect(cold.logs.some((m) => m.includes('no warm-up linked'))).toBe(true);
    inst.dispose();
    cold.gore.dispose();

    const early = make({ data: null });
    expect(early.gore.handoff.claim(row('g', ['gib'], 'cdn/gore-heart.glb'), new Matrix4())).toBe(false);
    expect(early.gore.corpses).toBeNull();
    early.gore.dispose();
  });

  it('a gib piece is the static template in its root frame, with its paint ids', () => {
    const g = gibPieceGeometry(rigid);
    expect(g.getAttribute('position').count).toBe(rigid.arrays.vertexCount);
    expect(Array.from(g.getAttribute('partPaint').array as Uint8Array)).toEqual(Array.from(rigid.arrays.partPaint));
    g.computeBoundingBox();
    expect(g.boundingBox!.max.y).toBeGreaterThan(0);
    g.dispose();
  });
  it('applies injected tags and profile ceilings rather than reserved row tags', () => {
    const { gore } = make({ data: { ...data, corpses: 3, maxCorpses: 5, gibs: 7, corpseTag: 'remnant', gibTag: 'debris', tierCaps: { high: { gibs: 2 } } } });
    expect(gore.handoff.claim(row('old', ['gib'], 'cdn/gore-heart.glb'), new Matrix4())).toBe(false);
    expect(gore.handoff.claim(row('custom', ['debris'], 'cdn/gore-heart.glb'), new Matrix4())).toBe(true);
    expect(gore.gibs!.renderer.cap()).toBe(2);
    expect(gore.corpses!.batcher.cap()).toBe(3);
    gore.dispose();
  });

});
