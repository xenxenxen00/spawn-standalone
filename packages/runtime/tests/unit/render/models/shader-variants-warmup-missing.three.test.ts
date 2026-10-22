import { BatchedMesh, InstancedMesh, MeshStandardMaterial, PerspectiveCamera, Scene, type Object3D, type WebGPURenderer } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { modelProxy, modelVariantBits, programVariant, warmUp, type ProgramVariant, type WarmUpEnv } from '../../../../src/render/models/shader-variants.ts';
import { CORPSE_BATCH_KEY, type LookTable, type ModelPaintTable } from '../../../../src/render/surface/look-table.ts';
import { SurfaceVariant } from '../../../../src/render/surface/surface-material.ts';
import type { SurfaceMaterials } from '../../../../src/render/surface/surface-material.ts';

const corpse = (): ProgramVariant => programVariant({ variant: modelVariantBits(2), kind: 'batched', owner: 'R7', why: 'test: baked corpse' });
const gib = (): ProgramVariant => programVariant({ variant: modelVariantBits(1), kind: 'instanced', owner: 'R7', why: 'test: gibs' });

const env = (): WarmUpEnv => ({
  materials: { get: () => new MeshStandardMaterial() } as unknown as SurfaceMaterials,
  look: { flush: () => undefined } as unknown as LookTable,
  paint: { flush: () => undefined } as unknown as ModelPaintTable,
});

function fakeRenderer() {
  const seen: Object3D[] = [];
  const r = {
    seen,
    info: { memory: { programs: 0 } },
    compileAsync: async (group: Object3D): Promise<void> => {
      seen.push(group);
      group.traverse((o: Object3D) => {
        if ((o as unknown as { isMesh?: boolean }).isMesh === true) r.info.memory.programs += 1;
      });
    },
  };
  return r;
}

describe('warmUp: the batched and instanced variants are warmed, not skipped', () => {
  it('the built-in factory builds a proxy for them', () => {
    const e = env();
    expect(modelProxy(corpse(), e)).toBeInstanceOf(BatchedMesh);
    expect(modelProxy(gib(), e)).toBeInstanceOf(InstancedMesh);
  });

  it('the batched corpse proxy is a corpse batch (its look rows per instance), so the warmed program is the one the batches link', () => {
    const e = env();
    expect((modelVariantBits(2) & SurfaceVariant.SLOTS) !== 0).toBe(true);
    expect(modelProxy(corpse(), e)!.userData[CORPSE_BATCH_KEY]).toBe(0);
    // a batched model surface without look rows (a gib batch) is no corpse batch
    const gibBatch = programVariant({ variant: SurfaceVariant.SRC_GLTF | SurfaceVariant.SIDE_DOUBLE | (1 << 9), kind: 'batched', owner: 'R7', why: 'test: gib batch' });
    expect(modelProxy(gibBatch, e)!.userData[CORPSE_BATCH_KEY]).toBe(undefined);
  });

  it('warmUp compiles them instead of skipping them', async () => {
    const r = fakeRenderer();
    const scene = new Scene();
    const camera = new PerspectiveCamera(60, 1, 0.1, 10);
    const variants = [corpse(), gib()];
    const result = await warmUp(r as unknown as WebGPURenderer, scene, camera, variants, env(), { skipRender: true });
    expect(result.skipped).toEqual([]);
    expect(result.compiled).toEqual(expect.arrayContaining(variants.map((v) => v.key)));
    expect(result.placeholders).toEqual([]);
    expect(result.programsCompiled).toBe(2);
    expect(r.info.memory.programs).toBe(2);
    expect(r.seen).toHaveLength(1);
  });
});
