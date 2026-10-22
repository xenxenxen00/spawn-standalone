import { describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three/webgpu';
import { createFxSystem, type FxRuntimeApi, type FxSystemOptions } from '../../../../src/render/fx/fx-system.ts';
import { createFxWorkerSystem, type FxWorkerLike, type FxWorkerRuntime } from '../../../../src/render/fx/fx-worker-runtime.ts';
import { setupFxRuntime } from '../../../../src/render/fx/fx-setup.ts';
import { placeholderAtlasTexture } from '../../../../src/render/fx/atlas-texture.ts';
import { createRenderBudget, tierConfig } from '../../../../src/render/perf/budget.ts';
import { ManualFxWorker, nodeFxWorker } from './fx-workers.ts';
import { bucketArrays, recordingLights, snapshot } from './oracle.ts';

const EFFECT = 'fx\npop card n=3 at=point() size=.2 sz=$size a=.05..0.09 r=sprite(soft-disc,add,axis,2,axis=<1,1,0>)\npop motion burst=2 life=5 size=.1 v=<3,0,0> r=sprite(ember,add,velocity,.5)\npop dot n=1 at=point() a=.05..0.09 r=sprite(ember,add)\npop box n=1 at=point() r=mesh(box,.1,.2,.3)\npop lamp n=1 at=point() r=light(<1,.5,.2>,2..3,6)';

type Options = Pick<FxSystemOptions, 'alignedCards' | 'heldFollow' | 'rangeRolls' | 'lightsOnly'>;
async function setup(make: (o: FxSystemOptions) => FxRuntimeApi, options: Options) {
  const scene = new Scene(), camera = new Object3D(), node = new Object3D(), distort = new Scene();
  scene.add(camera, node);
  const log: string[] = [];
  const built = await setupFxRuntime({
    resolveAtlas: () => null,
    loadAtlas: async () => { throw new Error('not used'); },
    ...(options.lightsOnly === true ? { lightsOnlyAtlas: placeholderAtlasTexture } : { builtinAtlas: placeholderAtlasTexture }),
    world: scene, camera, distortScene: () => distort,
    tier: () => 'high', tierConfig: () => tierConfig('high'),
    lights: recordingLights(log), lighting: null,
    ...(options.alignedCards === undefined ? {} : { alignedCards: options.alignedCards }),
    ...(options.heldFollow === undefined ? {} : { heldFollow: options.heldFollow }),
    ...(options.rangeRolls === undefined ? {} : { rangeRolls: options.rangeRolls }),
    create: (o) => make({ ...o, budget: createRenderBudget('high') }), log: () => undefined,
  });
  const fx = built.fx!;
  fx.bind('anchor', { script: EFFECT, seed: 7 }, node);
  fx.emit({ script: EFFECT.replace('fx\n', 'fx follow=camera\n'), seed: 13 }, [1, 2, -3]);
  const roots = [[scene, 'world'], [camera, 'camera'], [distort, 'distort']] as const;
  return { scene, camera, node, roots, log, fx, dispose: () => built.dispose() };
}

async function parity(options: Options, spawn: () => FxWorkerLike) {
  const a = await setup(createFxSystem, options);
  const b = await setup((o) => createFxWorkerSystem(o, { spawn }), options);
  const worker = b.fx as FxWorkerRuntime;
  try {
    let prior: ReturnType<typeof snapshot> | null = null;
    let priorLights: string[] = [];
    const retained: Float32Array[] = [];
    let lightCalls = 0;
    for (let i = 0; i < 6; i++) {
      for (const s of [a, b]) {
        s.node.position.set(4 + i, 3, -6);
        s.camera.position.set(i * .1, 8, 14);
        s.camera.rotation.set(.1, i * .02, 0);
      }
      const f = { dt: 1 / 60, now: 1000 + i * 1000 / 60 };
      a.fx.update(f);
      lightCalls += a.log.length;
      b.fx.update(f);
      if (worker.mode === 'worker') {
        if (prior !== null) {
          expect(snapshot(b.roots)).toEqual(prior);
          expect(b.log.splice(0)).toEqual(priorLights);
        }
        await worker.settled();
        prior = snapshot(a.roots);
        priorLights = a.log.splice(0);
      } else {
        expect(snapshot(b.roots)).toEqual(snapshot(a.roots));
        expect(b.log.splice(0)).toEqual(a.log.splice(0));
      }
      retained.push(...bucketArrays(b.roots));
    }
    if (worker.mode === 'worker') {
      b.fx.update({ dt: 0, now: 1100 });
      expect(snapshot(b.roots)).toEqual(prior);
      expect(b.log.splice(0)).toEqual(priorLights);
      await worker.settled();
    }
    expect(retained.every((array) => array.buffer.byteLength > 0)).toBe(true);
    expect(lightCalls).toBeGreaterThan(0);
    if (options.lightsOnly) {
      expect(snapshot(a.roots).size).toBe(0);
      expect(a.fx.warmObjects()).toEqual([]);
      expect(b.fx.warmObjects()).toEqual([]);
      expect(a.fx.armDistortWarm().armed).toBe(false);
      expect(b.fx.armDistortWarm().armed).toBe(false);
      expect(a.fx.particleCount).toBeGreaterThan(0);
      expect(worker.stats().meshParticles).toBe(0);
    } else {
      expect(a.fx.stretched.get('add')?.count).toBeGreaterThan(0);
      const matrix = a.fx.stretched.get('add')!.instanceMatrix.array;
      expect(matrix[12]).toBeCloseTo(options.heldFollow ? 9 : 0);
      expect(matrix[13]).toBeCloseTo(options.heldFollow ? 3 : 0);
      expect(matrix[14]).toBeCloseTo(options.heldFollow ? -6 : 0);
      expect(a.fx.stretched.get('add')!.material).toHaveProperty('vertexNode', options.alignedCards ? null : expect.anything());
    }
    return { mode: worker.mode, buckets: snapshot(a.roots) };
  } finally { a.dispose(); b.dispose(); }
}

describe('standalone FX options across the sync worker boundary', () => {
  it('real worker preserves setup options, moving held anchors, axis/velocity cards, camera space and corrected ranges', async () => {
    expect((await parity({ alignedCards: true, heldFollow: true }, nodeFxWorker)).mode).toBe('worker');
  });
  it('explicit false reaches simulations on a real worker and preserves legacy range rolls', async () => {
    const current = await parity({ alignedCards: true, heldFollow: true }, nodeFxWorker);
    const legacy = await parity({ alignedCards: true, heldFollow: true, rangeRolls: false }, nodeFxWorker);
    expect(legacy.mode).toBe('worker');
    expect(legacy.buckets).not.toEqual(current.buckets);
  });
  it('lights-only setup suppresses all visual sinks and warm-up in a real worker, while preserving lights', async () => {
    expect((await parity({ lightsOnly: true, heldFollow: true }, nodeFxWorker)).mode).toBe('worker');
  });
  it('constructor failure preserves all options in the shared fallback world', async () => {
    const broken = () => { throw new Error('module workers unavailable'); };
    expect((await parity({ alignedCards: true, heldFollow: true, rangeRolls: false }, broken)).mode).toBe('inline-fallback');
    expect((await parity({ lightsOnly: true, heldFollow: true }, broken)).mode).toBe('inline-fallback');
  });
  it('a running worker failure replays held effects with all standalone options', async () => {
    const manual = new ManualFxWorker();
    const s = await setup((o) => createFxWorkerSystem(o, { spawn: () => manual }), { alignedCards: true, heldFollow: true, rangeRolls: false });
    try {
      s.fx.update({ dt: 1 / 60, now: 1000 }); manual.drain();
      s.fx.update({ dt: 0, now: 1000 }); manual.drain();
      manual.fail('worker died');
      expect((s.fx as FxWorkerRuntime).mode).toBe('inline-fallback');
      s.node.position.set(8, 4, -6);
      s.fx.update({ dt: 1 / 60, now: 1017 });
      const card = s.fx.stretched.get('add')!;
      expect(card.material).toHaveProperty('vertexNode', null);
      expect(card.instanceMatrix.array[12]).toBeCloseTo(8);
      expect(card.instanceMatrix.array[13]).toBeCloseTo(4);
      expect(s.fx.effectCount).toBe(2);
      expect(s.log.some((line) => line.startsWith('pose|') && line.includes('8,4,-6'))).toBe(true);
    } finally { s.dispose(); }
  });
  it('disabled held follow and aligned cards remain effective negative controls', async () => {
    const corrected = await parity({ alignedCards: true, heldFollow: true }, nodeFxWorker);
    const old = await parity({ alignedCards: false, heldFollow: false }, nodeFxWorker);
    expect(old.buckets).not.toEqual(corrected.buckets);
  });
});
