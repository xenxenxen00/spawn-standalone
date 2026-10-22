// WP R7 (render §11.6): the GibSystem join of gib rows and the real GibRenderer, driven the way the bridge drives it:
// gib rows are tracked by their model asset, the row's pose (its own fade scale included) reaches the batch, a gib lives
// as long as its row, unknown pieces keep the model path. Node + three's scene graph, no renderer.
import { BufferAttribute, BufferGeometry, Matrix4, Scene, Vector3 } from 'three/webgpu';
import type { BatchedMesh } from 'three/webgpu';
import { beforeAll, describe, expect, it } from 'vitest';
import { createRenderBudget } from '../../../../src/render/perf/budget.ts';
import { GibSystem } from '../../../../src/render/models/gib-system.ts';
import { GIB_TTL_MS, type GibPieceSpec } from '../../../../src/render/models/gib-renderer.ts';
import { buildModelTemplate, modelSourceFromGltf, type ModelTemplate } from '../../../../src/render/models/model-template.ts';
import type { AnySurfaceMaterial } from '../../../../src/render/surface/surface-material.ts';
import type { RowSnapshot } from '../../../../src/compat/core/ports.ts';
import { FIXTURE_FACTS, fixtureGlb, parseGlb, testEnv, type TestEnv } from './model-fixtures.ts';

let env: TestEnv;
let template: ModelTemplate;
let opaqueMat: AnySurfaceMaterial;
beforeAll(async () => {
  env = testEnv();
  template = buildModelTemplate(modelSourceFromGltf('value.00f1c5.glb', await parseGlb(await fixtureGlb()), FIXTURE_FACTS), env);
  opaqueMat = template.opaqueMesh.material as AnySurfaceMaterial;
});

function chunkGeometry(): BufferGeometry {
  const s = 0.1;
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([
    -s, -s, -s, s, -s, -s, s, s, -s, -s, s, -s,
    -s, -s, s, s, -s, s, s, s, s, -s, s, s,
  ]), 3));
  g.setAttribute('normal', new BufferAttribute(new Float32Array(8 * 3).map((_, i) => (i % 3 === 1 ? 1 : 0)), 3));
  g.setAttribute('partPaint', new BufferAttribute(new Uint8Array(8 * 4), 4, true));
  g.setIndex(new BufferAttribute(new Uint16Array([0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6]), 1));
  return g;
}

/** a gib row as gore.js spawns it: tags gib/gore, the piece's model asset, the gib's class and key in state */
const gibRow = (id: string, model: string): RowSnapshot =>
  ({ id, tags: ['gib', 'gore'], spec: { model, state: { cls: 'flesh', key: 'rake/arm' } }, props: {} }) as unknown as RowSnapshot;

function makeSystem(scene: Scene, logs: string[] = []): GibSystem {
  const pieces: GibPieceSpec[] = [
    { id: 'gib_flesh_a.glb', set: '', geometry: chunkGeometry() },
    { id: 'skull_a.glb', set: '', geometry: chunkGeometry() },
  ];
  return new GibSystem({
      isGibRow: (row) => row.tags.includes('gib'),
    renderer: { scene, budget: createRenderBudget('high', { high: { gibs: 220, corpses: 64 }, medium: { gibs: 160, corpses: 48 }, low: { gibs: 80, corpses: 24 }, minimum: { gibs: 40, corpses: 12 } }), profileCap: 8, pieces, materialFor: (_set, pass) => (pass === 'opaque' ? opaqueMat : null), multiDraw: true },
    log: (m) => logs.push(m),
  });
}

const batchOf = (scene: Scene): BatchedMesh => scene.children.find((c): c is BatchedMesh => (c as BatchedMesh).isBatchedMesh === true)!;

describe('GibSystem: the gib lifecycle (render §11.6)', () => {
  it('tracks gib rows by their model, writes the row pose with its scale, and keeps the gib while the row lives', () => {
    const scene = new Scene();
    const system = makeSystem(scene);
    expect(system.isGib(gibRow('g1', 'gib_flesh_a.glb'))).toBe(true);
    expect(system.isGib({ id: 'x', tags: ['corpse'], spec: {}, props: {} } as unknown as RowSnapshot)).toBe(false);

    expect(system.track('g1', gibRow('g1', 'gib_flesh_a.glb'), new Matrix4().makeTranslation(1, 2, 3))).toBe(true);
    expect(system.track('g2', gibRow('g2', 'skull_a.glb'), new Matrix4())).toBe(true);
    expect(system.size).toBe(2);
    expect(system.tracks('g1')).toBe(true);
    expect(system.renderer.live).toBe(2);

    // the bridge's interpolated pose, the game's fade shrink (row scale) included
    const pose = new Matrix4().makeTranslation(4, 5, 6).scale(new Vector3(0.3, 0.3, 0.3));
    expect(system.setPose('g1', pose)).toBe(true);
    expect(system.setPose('unknown', pose)).toBe(false);
    const m = new Matrix4();
    batchOf(scene).getMatrixAt(0, m);
    expect(m.elements[12]).toBeCloseTo(4, 6);
    expect(m.elements[0]).toBeCloseTo(0.3, 6);

    // well past the 0.9 s fade span: the gib lives as long as its row
    system.update(performance.now() + GIB_TTL_MS * 50);
    expect(system.renderer.live).toBe(2);
    system.untrack('g1');
    expect(system.renderer.live).toBe(1);

    system.dispose();
    expect(system.disposed).toBe(true);
  });

  it('a row whose piece is unknown keeps its model path, logged once per piece', () => {
    const scene = new Scene();
    const logs: string[] = [];
    const system = makeSystem(scene, logs);
    expect(system.track('g3', gibRow('g3', 'no-such-piece.glb'), new Matrix4())).toBe(false);
    expect(system.track('g4', gibRow('g4', 'no-such-piece.glb'), new Matrix4())).toBe(false);
    expect(system.size).toBe(0);
    expect(logs).toEqual(['GibSystem: no gib piece "no-such-piece.glb" (row g3); such rows keep their model']);
    // a primitive plate shard has no model at all
    const shard = { id: 'g5', tags: ['gib', 'gore'], spec: { primitive: { kind: 'box' } }, props: {} } as unknown as RowSnapshot;
    expect(system.track('g5', shard, new Matrix4())).toBe(false);
    system.dispose();
  });

  it('untrack removes the gib', () => {
    const scene = new Scene();
    const system = makeSystem(scene);
    system.track('g6', gibRow('g6', 'gib_flesh_a.glb'), new Matrix4());
    expect(system.size).toBe(1);
    system.untrack('g6');
    expect(system.size).toBe(0);
    expect(system.renderer.live).toBe(0);
    expect(system.setPose('g6', new Matrix4())).toBe(false);
    system.dispose();
  });

  it('an empty piece list (no gore profile pieces yet) is a working no-op', () => {
    const scene = new Scene();
    const system = new GibSystem({
      isGibRow: (row) => row.tags.includes('gib'),
      renderer: { scene, budget: createRenderBudget('high', { high: { gibs: 220, corpses: 64 }, medium: { gibs: 160, corpses: 48 }, low: { gibs: 80, corpses: 24 }, minimum: { gibs: 40, corpses: 12 } }), profileCap: 8, pieces: [], materialFor: () => opaqueMat, multiDraw: true },
      log: () => {},
    });
    expect(system.track('g7', gibRow('g7', 'gib_flesh_a.glb'), new Matrix4())).toBe(false);
    system.update();
    expect(scene.children.length).toBe(0);
    system.dispose();
  });

  it('ignores non-gib rows', () => {
    const scene = new Scene();
    const system = makeSystem(scene);
    expect(system.track('e1', { id: 'e1', tags: ['enemy'], spec: { model: 'gib_flesh_a.glb' }, props: {} } as unknown as RowSnapshot, new Matrix4())).toBe(false);
    expect(system.size).toBe(0);
    system.dispose();
  });
});
