// WP R12b (render §14.6): the seeded scatter re-sample, clustering, and the instanced field.
import { describe, expect, it } from 'vitest';
import type { Material } from 'three/webgpu';
import {
  SCATTER_CLUSTERS,
  SCATTER_COUNT,
  SCATTER_MAX_DISTANCE,
  SCATTER_MAX_SLOPE,
  buildScatterField,
  clusterSamples,
  pickTemplate,
  pointInPolygon,
  sampleScatterPoints,
  slopeAt,
  type ScatterConfig,
  type ScatterGeometrySource,
  type ScatterLod,
  type ScatterMaterialCache,
} from '../../../src/render/special/scatter.ts';
import { SurfaceVariant } from '../../../src/render/surface/surface-material.ts';

const SQUARE: Array<[number, number]> = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];

const flatAt = () => 0;

function config(over: Partial<ScatterConfig> = {}): ScatterConfig {
  return {
    seed: 7, count: 3600, maxDistance: 90, clusters: 16, maxSlope: 0.4,
    polygon: SQUARE,
    templates: [
      { spec: { script: 'scripts/gen/mire-island/jungle.js', params: { kind: 'palm' } }, weight: 3 },
      { spec: { script: 'scripts/gen/mire-island/jungle.js', params: { kind: 'fern' } }, weight: 1 },
    ],
    heightAt: flatAt,
    ...over,
  };
}

/** one triangle of packed verts (int16 xyz + paint id), one opaque range */
function fakeLod(over: Partial<ScatterLod> = {}): ScatterLod {
  return {
    vtx: new Int16Array([0, 0, 0, 0, 32767, 0, 0, 0, 0, 32767, 0, 0]).buffer,
    idx: new Uint16Array([0, 1, 2]),
    paints: new Float32Array(12),
    bboxMin: [-1, 0, -1],
    bboxMax: [1, 2, 1],
    opaque: { start: 0, count: 3 },
    transparent: null,
    ...over,
  };
}

function fakeSource(lod: ScatterLod = fakeLod()): ScatterGeometrySource & { calls: number } {
  const source = {
    calls: 0,
    async request() {
      source.calls++;
      return { lods: [lod] };
    },
  };
  return source;
}

interface GetCall {
  variant: number;
  state?: { depthWrite?: boolean };
}

/** a minimal explicit fake for the injected `SurfaceMaterials` dependency */
function fakeMaterials(): ScatterMaterialCache & { gets: GetCall[] } {
  const gets: GetCall[] = [];
  return {
    gets,
    get(key: { variant: number; state?: { depthWrite?: boolean } }): Material {
      gets.push(key);
      return { name: `fake:${key.variant.toString(36)}` } as unknown as Material;
    },
  };
}

function fakeDeps() {
  const materials = fakeMaterials();
  const blocks: number[] = [];
  const paint = {
    blocks,
    addBlock(paints: Float32Array) {
      blocks.push(paints.length);
      return blocks.length - 1;
    },
  };
  return { materials, paint };
}

describe('pointInPolygon', () => {
  it('classifies inside, outside and edge points', () => {
    expect(pointInPolygon(5, 5, SQUARE)).toBe(true);
    expect(pointInPolygon(11, 5, SQUARE)).toBe(false);
    expect(pointInPolygon(-1, -1, SQUARE)).toBe(false);
    expect(pointInPolygon(0, 5, SQUARE)).toBe(true);
  });
});

describe('slopeAt', () => {
  it('is 0 on flat ground and the grade on a ramp', () => {
    expect(slopeAt(flatAt, 3, 4)).toBe(0);
    expect(slopeAt((x) => x * 2, 3, 4)).toBeCloseTo(2, 9);
  });

  it('is null where the ground is missing under a tap', () => {
    expect(slopeAt((x, z) => (x > 0 && z > 0 ? 1 : null), 0.1, 0.1)).toBeNull();
  });
});

describe('pickTemplate', () => {
  it('picks by cumulative weight', () => {
    const cum = [3, 4];
    expect(pickTemplate(() => 0, cum)).toBe(0);
    expect(pickTemplate(() => 0.749, cum)).toBe(0);
    expect(pickTemplate(() => 0.75, cum)).toBe(1);
    expect(pickTemplate(() => 0.9999, cum)).toBe(1);
  });
});

describe('sampleScatterPoints', () => {
  it('is deterministic per seed', () => {
    const a = sampleScatterPoints(config({ count: 60 }));
    const b = sampleScatterPoints(config({ count: 60 }));
    expect(a).toEqual(b);
    const c = sampleScatterPoints(config({ count: 60, seed: 8 }));
    expect(c).not.toEqual(a);
  });

  it('places every sample inside the polygon, on the ground, under the slope limit', () => {
    const samples = sampleScatterPoints(config({ count: 200 }));
    expect(samples.length).toBe(200);
    for (const s of samples) {
      expect(pointInPolygon(s.x, s.z, SQUARE)).toBe(true);
      expect(s.y).toBe(0);
      expect(s.scale).toBe(1);
      expect(s.yaw).toBeGreaterThanOrEqual(0);
      expect(s.yaw).toBeLessThan(Math.PI * 2);
      expect([0, 1]).toContain(s.template);
    }
  });

  it('rejects samples steeper than maxSlope', () => {
    // a cliff at x = 5: the 0.5 m taps straddle it within 0.5 m of the edge
    const cliff = { heightAt: (x: number) => (x < 5 ? 0 : 10) };
    const samples = sampleScatterPoints(config({ count: 400, heightAt: cliff.heightAt }));
    expect(samples.length).toBeGreaterThan(0);
    for (const s of samples) expect(Math.abs(s.x - 5)).toBeGreaterThanOrEqual(0.5);
  });

  it('honours the template weights over many draws', () => {
    const samples = sampleScatterPoints(config({ count: 2000 }));
    const palms = samples.filter((s) => s.template === 0).length;
    // 3:1 weights → ~1500 palms; a wide tolerance band keeps the test seed-robust
    expect(palms).toBeGreaterThan(1200);
    expect(palms).toBeLessThan(1800);
  });

  it('sinks instances and scales them per template', () => {
    const templates = [
      { spec: { script: 'a.js' }, weight: 1, scale: [2, 4] as [number, number], sink: 0.3 },
    ];
    const samples = sampleScatterPoints(config({ count: 50, templates, heightAt: () => 5 }));
    for (const s of samples) {
      expect(s.y).toBeCloseTo(4.7, 9);
      expect(s.scale).toBeGreaterThanOrEqual(2);
      expect(s.scale).toBeLessThan(4);
    }
  });
});

describe('clusterSamples', () => {
  it('groups into a √n × √n grid, row-major, deterministically', () => {
    const samples = [
      { x: 1, y: 0, z: 1, yaw: 0, scale: 1, template: 0 },
      { x: 9, y: 0, z: 1, yaw: 0, scale: 1, template: 0 },
      { x: 1, y: 0, z: 9, yaw: 0, scale: 1, template: 0 },
      { x: 9, y: 0, z: 9, yaw: 0, scale: 1, template: 0 },
    ];
    const cells = clusterSamples(samples, 4);
    expect(cells.length).toBe(4);
    expect(cells.map((c) => c.length)).toEqual([1, 1, 1, 1]);
    expect(cells[0]![0]!.x).toBe(1);
    expect(cells[3]![0]!.x).toBe(9);
  });

  it('leaves empty cells empty', () => {
    const cells = clusterSamples([], 16);
    expect(cells.length).toBe(16);
    expect(cells.every((c) => c.length === 0)).toBe(true);
  });
});

describe('buildScatterField', () => {
  it('creates one InstancedMesh per (template, cluster) with static bounds assigned after the write', async () => {
    const deps = fakeDeps();
    const field = await buildScatterField(config({ count: 60, clusters: 4 }), fakeSource(), deps);
    const { samples, meshes, clusters, instances } = field.stats();
    expect(samples).toBe(60);
    expect(instances).toBe(60);
    expect(clusters).toBeGreaterThan(0);
    expect(clusters).toBeLessThanOrEqual(2 * 4);
    expect(meshes).toBe(clusters);
    for (const c of field.clusters) {
      expect(c.meshes.length).toBeGreaterThan(0);
      for (const m of c.meshes) {
        expect(m.count).toBeGreaterThan(0);
        // the static object-level bounding sphere: assigned, finite, and non-degenerate
        expect(m.boundingSphere).not.toBeNull();
        expect(Number.isFinite(m.boundingSphere!.radius)).toBe(true);
        expect(m.boundingSphere!.radius).toBeGreaterThan(0);
        expect(m.frustumCulled).toBe(true);
      }
    }
    // the template paints went through the place's paint table, one block per template
    expect(deps.paint.blocks.length).toBe(2);
    field.dispose();
  });

  it('hides clusters beyond maxDistance and shows them inside it', async () => {
    const deps = fakeDeps();
    const field = await buildScatterField(config({ count: 40, clusters: 4, maxDistance: 10 }), fakeSource(), deps);
    field.update({ x: 5, y: 0, z: 5 });
    const near = field.clusters.flatMap((c) => c.meshes).filter((m) => m.visible).length;
    expect(near).toBeGreaterThan(0);
    field.update({ x: 1000, y: 0, z: 1000 });
    expect(field.clusters.flatMap((c) => c.meshes).every((m) => !m.visible)).toBe(true);
    expect(SCATTER_MAX_DISTANCE).toBe(Infinity);
    field.dispose();
  });

  it('skips a template the geometry service fails on, and keeps the other', async () => {
    const deps = fakeDeps();
    const failing: ScatterGeometrySource = {
      async request(spec) {
        const params = spec.params as { kind?: string } | undefined;
        if (params?.kind === 'palm') throw new Error('no geometry');
        return { lods: [fakeLod()] };
      },
    };
    const logged: string[] = [];
    const field = await buildScatterField(config({ count: 60, clusters: 4 }), failing, { ...deps, log: (m: string) => logged.push(m) });
    expect(logged.length).toBe(1);
    expect(field.stats().instances).toBeGreaterThan(0);
    expect(field.stats().instances).toBeLessThan(60);
    field.dispose();
  });

  it('draws the transparent pass of a template that has one', async () => {
    const deps = fakeDeps();
    const lod = fakeLod({ transparent: { start: 0, count: 3 }, opaque: null });
    const field = await buildScatterField(config({ count: 20, clusters: 4 }), fakeSource(lod), deps);
    expect(field.stats().meshes).toBeGreaterThan(0);
    // the transparent material was requested with depthWrite off
    const transparentGets = deps.materials.gets.filter((k) => (k.variant & SurfaceVariant.TRANSPARENT) !== 0);
    expect(transparentGets.length).toBeGreaterThan(0);
    expect(transparentGets.every((k) => k.state?.depthWrite === false)).toBe(true);
    field.dispose();
  });

  it('uses the SRC_PACKED paint-table materials, like the map batcher', async () => {
    const deps = fakeDeps();
    await buildScatterField(config({ count: 10, clusters: 4 }), fakeSource(), deps);
    expect(deps.materials.gets.length).toBeGreaterThan(0);
    for (const k of deps.materials.gets) {
      expect(k.variant & SurfaceVariant.SRC_PACKED).not.toBe(0);
      expect(k.variant & SurfaceVariant.SIDE_DOUBLE).not.toBe(0);
    }
  });
});

describe('constants', () => {
  it('defaults to no instances and no distance or slope cutoff', () => {
    expect(SCATTER_COUNT).toBe(0);
    expect(SCATTER_CLUSTERS).toBe(1);
    expect(SCATTER_MAX_DISTANCE).toBe(Infinity);
    expect(SCATTER_MAX_SLOPE).toBe(Infinity);
  });
});
