// The rigged-bean map harness of the batcher and end-to-end rig tests: the geometry service over the in-process worker
// (`rigs` on), a paint table, the packed surface materials, and a MapBatcher over the given rows.
import type { SkinnedMesh, Object3D } from 'three/webgpu';
import { keyOf, type ScriptedSpec } from '../../src/render/geometry/generator-types.ts';
import { GeometryServiceImpl } from '../../src/render/geometry/geometry-service.ts';
import { createInProcessExecutor, type ModuleLoader } from '../../src/render/geometry/geometry-worker.ts';
import { MapBatcher, type BatcherRow, type MapBatcherOptions } from '../../src/render/geometry/map-batcher.ts';
import { TIER_TABLE } from '../../src/render/perf/budget.ts';
import { MapPaint, registerPackedSurface } from '../../src/render/surface/paint-table.ts';
import type { LightingScript } from '../../src/render/surface/script-types.ts';
import { SurfaceMaterials } from '../../src/render/surface/surface-material.ts';
import { BEAN } from './bean.ts';

export const BEAN_SPEC: ScriptedSpec = { kind: 'scripted', script: 'scripts/gen/bean.js', params: { hue: 190 } };
const load: ModuleLoader = async (script) => {
  if (script === BEAN_SPEC.script) return BEAN;
  throw new Error(`unknown ${script}`);
};
export const at = (x: number, z: number): Float32Array => new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, z, 1]);
export const bean = (id: string, x: number, extra: Partial<BatcherRow> = {}): BatcherRow => ({ id, key: keyOf(BEAN_SPEC), spec: BEAN_SPEC, m: at(x, 0), dynamic: false, ...extra });
const script: LightingScript = { lighting: (_s, l) => l.ambient };

export async function buildBatcher(rows: BatcherRow[], extra: Partial<MapBatcherOptions> = {}): Promise<{ batcher: MapBatcher; materials: SurfaceMaterials }> {
  const svc = new GeometryServiceImpl({ executor: createInProcessExecutor(load, { strict: true, rigs: true }) });
  const paint = new MapPaint({ paints: 256, entries: 4096 });
  const materials = new SurfaceMaterials({ script });
  registerPackedSurface(materials, paint);
  const batcher = await MapBatcher.build(rows, {
    place: 'test',
    geometry: { request: (s, lods) => svc.request(s, lods), buildChunks: (job) => svc.buildChunks(job) },
    materials,
    paint,
    tier: TIER_TABLE.high,
    log: () => undefined,
    ...extra,
  });
  return { batcher, materials };
}

export const skinnedUnder = (root: Object3D): SkinnedMesh[] => {
  const out: SkinnedMesh[] = [];
  root.traverse((o) => {
    if ((o as SkinnedMesh).isSkinnedMesh === true) out.push(o as SkinnedMesh);
  });
  return out;
};
