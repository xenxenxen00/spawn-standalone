// WP R7 (render §11.5; X-20, X-40): the CorpseSystem join of the real CorpseBaker and CorpseBatcher, driven the way the
// bridge drives it: a corpse row's own ModelInstance is tracked, its bones hold still, the bake lands in the batcher and
// `frozenBone` resolves the anchors of THAT row. Node + three's scene graph, no renderer.
import { Matrix4, Scene, Vector3 } from 'three/webgpu';
import { beforeAll, describe, expect, it } from 'vitest';
import { createRenderBudget } from '../../../../src/render/perf/budget.ts';
import { CorpseSystem } from '../../../../src/render/models/corpse-system.ts';
import { ModelInstance } from '../../../../src/render/models/model-instance.ts';
import { buildModelTemplate, modelSourceFromGltf, type ModelTemplate } from '../../../../src/render/models/model-template.ts';
import type { RowSnapshot } from '../../../../src/compat/core/ports.ts';
import { FIXTURE_FACTS, fixtureGlb, parseGlb, testEnv, type TestEnv } from './model-fixtures.ts';

let env: TestEnv;
let template: ModelTemplate;
beforeAll(async () => {
  env = testEnv();
  template = buildModelTemplate(modelSourceFromGltf('value.00f1c5.glb', await parseGlb(await fixtureGlb()), FIXTURE_FACTS), env);
});

const corpseRow = (id: string): RowSnapshot => ({ id, tags: ['corpse', 'gore'] }) as unknown as RowSnapshot;

function makeSystem(scene: Scene, opts: { stillFrames?: number; profileCap?: number; sliceMs?: number; now?: () => number } = {}): CorpseSystem {
  return new CorpseSystem({
      isCorpseRow: (row) => row.tags.includes('corpse'),
    baker: { sliceMs: opts.sliceMs ?? 60_000, log: () => {}, ...(opts.now ? { now: opts.now } : {}) },
    batcher: {
      scene,
      table: env.look,
      budget: createRenderBudget('high', { high: { gibs: 220, corpses: 64 }, medium: { gibs: 160, corpses: 48 }, low: { gibs: 80, corpses: 24 }, minimum: { gibs: 40, corpses: 12 } }),
      profileCap: opts.profileCap ?? 4,
      maxVerticesPerCorpse: 600,
      maxIndicesPerCorpse: 1200,
      multiDraw: true,
    },
    stillFrames: opts.stillFrames ?? 3,
    log: () => {},
  });
}

/** a corpse instance in a death pose at `x` along the world x axis */
function posedCorpse(x: number): ModelInstance {
  const inst = new ModelInstance(template, env.look, { bonePath: 'hierarchy', log: () => {} });
  inst.bones.get('Head')!.rotation.set(0, 0, Math.PI / 6);
  inst.root.position.set(x, 0, -3);
  inst.root.updateMatrixWorld(true);
  return inst;
}

const headAt = (inst: ModelInstance): Vector3 => new Vector3().setFromMatrixPosition(inst.bones.get('Head')!.matrixWorld);

describe('CorpseSystem: the corpse lifecycle (render §11.5)', () => {
  it('bakes after stillFrames of still bones and exposes the frozen anchors at the bone', () => {
    const scene = new Scene();
    const system = makeSystem(scene);
    const row = corpseRow('corpse-1');
    const model = posedCorpse(5);
    const head = headAt(model);

    expect(system.isCorpse(row)).toBe(true);
    expect(system.isCorpse({ id: 'x', tags: ['gib'] } as unknown as RowSnapshot)).toBe(false);
    expect(system.track('corpse-1', row, model)).toBe(true);
    expect(system.size).toBe(1);

    system.update(); // baseline
    system.update(); // still 1
    expect(system.baked('corpse-1')).toBe(false);
    system.update(); // still 2
    expect(system.frozenBone('corpse-1', 'Head')).toBe(null);
    system.update(); // still 3 → enqueued and (60 s slice) baked
    expect(system.baked('corpse-1')).toBe(true);
    expect(model.disposed).toBe(true); // the baker took the instance
    expect(system.batcher.size).toBe(1);

    const anchor = system.frozenBone('corpse-1', 'Head')!;
    expect(anchor).not.toBe(null);
    scene.updateMatrixWorld(true);
    expect(new Vector3().setFromMatrixPosition(anchor.matrixWorld).distanceTo(head)).toBeLessThan(1e-4);
    expect(system.frozenBone('corpse-1', 'NoSuchBone')).toBe(null);
    expect(system.frozenBone('unknown-row', 'Head')).toBe(null);

    // the fade sink moves the anchors (and the batch instances) with the row
    const sink = new Matrix4().makeTranslation(0, -1, 0).multiply(new Matrix4().makeTranslation(5, 0, -3));
    expect(system.setPose('corpse-1', sink)).toBe(true);
    scene.updateMatrixWorld(true);
    expect(new Vector3().setFromMatrixPosition(anchor.matrixWorld).y).toBeCloseTo(head.y - 1, 4);

    system.dispose();
    expect(system.disposed).toBe(true);
  });

  it('matches each bake to its own row, whatever order the rows went still in', () => {
    const scene = new Scene();
    const system = makeSystem(scene);
    const a = posedCorpse(-10);
    const b = posedCorpse(10);
    const headA = headAt(a);
    const headB = headAt(b);
    system.track('a', corpseRow('a'), a); // tracked first
    system.track('b', corpseRow('b'), b);
    system.update(); // baselines
    // a keeps moving for two more frames, so b goes still (and bakes) first
    for (let i = 0; i < 2; i++) {
      a.bones.get('Head')!.rotation.x += 0.1;
      a.root.updateMatrixWorld(true);
      system.update();
    }
    system.update();
    expect(system.baked('b')).toBe(true);
    expect(system.baked('a')).toBe(false);
    for (let i = 0; i < 3; i++) system.update();
    expect(system.baked('a')).toBe(true);
    const headAfterA = headAt(a); // a's final pose (it moved after the baseline)
    scene.updateMatrixWorld(true);
    const anchorA = new Vector3().setFromMatrixPosition(system.frozenBone('a', 'Head')!.matrixWorld);
    const anchorB = new Vector3().setFromMatrixPosition(system.frozenBone('b', 'Head')!.matrixWorld);
    expect(anchorB.distanceTo(headB)).toBeLessThan(1e-4);
    expect(anchorA.distanceTo(headAfterA)).toBeLessThan(1e-4);
    expect(headAfterA.distanceTo(headA)).toBeLessThan(1e-4); // turning the head bone does not move its origin
    expect(anchorA.distanceTo(headB)).toBeGreaterThan(1); // a's anchor is not b's: the bodies lie 20 m apart
    system.dispose();
  });

  it('resets stillness when bones move', () => {
    const scene = new Scene();
    const system = makeSystem(scene);
    const model = posedCorpse(0);
    system.track('corpse-2', corpseRow('corpse-2'), model);
    system.update(); // baseline
    system.update(); // still 1
    model.bones.get('Head')!.rotation.x += 0.1;
    model.root.updateMatrixWorld(true);
    system.update(); // moved: 0
    system.update(); // still 1
    system.update(); // still 2
    expect(system.frozenBone('corpse-2', 'Head')).toBe(null);
    system.update(); // still 3 → bakes
    expect(system.frozenBone('corpse-2', 'Head')).not.toBe(null);
    system.dispose();
  });

  it('untrack mid-bake cancels the bake and hands the model back with its look row', () => {
    let t = 0;
    const scene = new Scene();
    const system = makeSystem(scene, { stillFrames: 1, sliceMs: 0.3, now: () => t++ });
    const model = posedCorpse(0);
    const row = model.lookRow;
    system.track('corpse-3', corpseRow('corpse-3'), model);
    system.update(); // baseline
    system.update(); // still 1 → enqueued; one chunk of a 0.3 ms slice on a 1 ms-per-read clock
    expect(system.pendingBakes).toBe(1);
    expect(system.baked('corpse-3')).toBe(true);
    expect(model.lookRow).toBe(row); // still drawing with its own row while it bakes
    system.untrack('corpse-3');
    expect(system.pendingBakes).toBe(0);
    expect(env.look.kindOf(row)).toBe('instance'); // still the model's
    expect(model.disposed).toBe(false);
    model.dispose(); // the bridge's again
    expect(env.look.kindOf(row)).toBe(undefined);
    for (let i = 0; i < 4; i++) system.update(); // nothing left to finish, nothing throws
    expect(system.batcher.size).toBe(0);
    system.dispose();
  });

  it('untrack after the bake removes the baked corpse', () => {
    const scene = new Scene();
    const system = makeSystem(scene, { stillFrames: 1 });
    system.track('corpse-4', corpseRow('corpse-4'), posedCorpse(0));
    system.update();
    system.update();
    expect(system.batcher.size).toBe(1);
    system.untrack('corpse-4');
    expect(system.size).toBe(0);
    expect(system.batcher.size).toBe(0);
    expect(system.frozenBone('corpse-4', 'Head')).toBe(null);
    system.dispose();
  });

  it('a corpse dropped at the live cap stays baked and is never baked again', () => {
    const scene = new Scene();
    const system = makeSystem(scene, { stillFrames: 1, profileCap: 1 });
    system.track('old', corpseRow('old'), posedCorpse(0));
    system.update();
    system.update();
    expect(system.frozenBone('old', 'Head')).not.toBe(null);
    system.track('new', corpseRow('new'), posedCorpse(3));
    system.update();
    system.update(); // 'new' bakes: the cap of 1 evicts 'old'
    expect(system.batcher.size).toBe(1);
    expect(system.frozenBone('new', 'Head')).not.toBe(null);
    expect(system.frozenBone('old', 'Head')).toBe(null);
    expect(system.baked('old')).toBe(true); // its model is gone: the bridge must not draw it
    expect(system.setPose('old', new Matrix4())).toBe(false);
    for (let i = 0; i < 3; i++) expect(() => system.update()).not.toThrow();
    expect(system.batcher.size).toBe(1);
    system.dispose();
  });

  it('ignores non-corpse rows', () => {
    const scene = new Scene();
    const system = makeSystem(scene);
    const model = posedCorpse(0);
    expect(system.track('enemy-1', { id: 'enemy-1', tags: ['enemy'] } as unknown as RowSnapshot, model)).toBe(false);
    expect(system.size).toBe(0);
    system.dispose();
    model.dispose();
  });
});
