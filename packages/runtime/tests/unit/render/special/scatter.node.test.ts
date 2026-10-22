import { describe, expect, it } from 'vitest';
import type { Material } from 'three/webgpu';
import {
  buildScatterField,
  pointInPolygon,
  sampleScatterPoints,
  type ScatterGeometrySource,
  type ScatterLod,
} from '../../../../src/render/special/scatter.ts';

function dualPassLod(): ScatterLod {
  return {
    vtx: new Int16Array([0, 0, 0, 0, 32767, 0, 0, 0, 0, 32767, 0, 0]).buffer,
    idx: new Uint16Array([0, 1, 2]),
    paints: new Float32Array(12),
    bboxMin: [-1, 0, -1],
    bboxMax: [1, 2, 1],
    opaque: { start: 0, count: 3 },
    transparent: { start: 0, count: 3 },
  };
}

describe('R12b scatter pass accounting', () => {
  it('repeats a synthetic weighted sample inside a concave polygon for the same seed', () => {
    const config = {
      seed: 13,
      count: 1024, maxDistance: 20, clusters: 4, maxSlope: 0.75,
      polygon: [[0, 0], [8, 0], [8, 4], [4, 4], [4, 8], [0, 8]] as const,
      templates: [
        { spec: { script: 'scripts/test-shape.js', params: { shape: 'cube' } }, weight: 2, scale: [0.5, 1.5] as [number, number] },
        { spec: { script: 'scripts/test-shape.js', params: { shape: 'column' } }, weight: 3, scale: [0.5, 1.5] as [number, number] },
        { spec: { script: 'scripts/test-shape.js', params: { shape: 'wedge' } }, weight: 1, scale: [0.5, 1.5] as [number, number] },
      ],
      heightAt: (x: number, z: number) => (x + z) * 0.02,
    };

    const first = sampleScatterPoints(config);
    const second = sampleScatterPoints(config);
    expect(first).toHaveLength(1024);
    expect(second).toEqual(first);
    expect(first.every((sample) => pointInPolygon(sample.x, sample.z, config.polygon))).toBe(true);
    expect(new Set(first.map((sample) => sample.template)).size).toBe(3);
  });

  it('counts each sampled object once when its geometry has opaque and transparent passes', async () => {
    const lod = dualPassLod();
    const source: ScatterGeometrySource = { async request() { return { lods: [lod] }; } };
    const field = await buildScatterField({
      seed: 41,
      count: 24,
      clusters: 4,
      polygon: [[0, 0], [10, 0], [10, 10], [0, 10]],
      templates: [{ spec: { script: 'scripts/test-shape.js', params: { shape: 'cube' } }, weight: 1 }],
      heightAt: () => 0,
    }, source, {
      materials: { get: () => ({ name: 'scatter-material' } as unknown as Material) },
      paint: { addBlock: () => 0 },
    });

    const stats = field.stats();
    expect(stats.samples).toBe(24);
    expect(stats.instances).toBe(24);
    expect(stats.meshes).toBeGreaterThan(0);
    expect(stats.meshes).toBeLessThanOrEqual(2 * 4);
    expect(field.clusters.flatMap((cluster) => cluster.meshes).reduce((sum, mesh) => sum + mesh.count, 0)).toBe(48);
    field.dispose();
  });
});
