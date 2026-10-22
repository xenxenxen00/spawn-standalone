// map-plan.ts (render §6.5, §15.1, §18.1 "batcher"): the classification table for fixture rows (dynamic tags, behaviours,
// parents), LOD selection with hysteresis, the tier bands under [CAL lod], the frustum tests and the frame estimate.
import { afterEach, describe, expect, it } from 'vitest';
import { calibration, resetCalibration } from '../../../../src/render/calibration.ts';
import { keyOf, type ScriptedSpec } from '../../../../src/render/geometry/generator-types.ts';
import {
  aabbInFrustum, CHUNK_MIN_CELL, CHUNK_OVERSIZE, CHUNK_TRIANGLE_FLOOR, CHUNK_TRIANGLE_SHARE, chunkIdOf, chunkSplitFor, classifyRows, distanceToAabb, DYNAMIC_TAGS, estimateMapFrame, FAR_CELLS, farIdOf,
  finestTris, frustumPlanes, groupByChunk, instanceSphere, isDynamicRow, keyCullRadius, keysNeedingLod1Tris,
  layoutOf, lodBands, LOD_HYSTERESIS, MAP_DRAW_BUDGET, meshNormals, partitionChunk, selectLodIndex, sphereInFrustum, transformedAabb, unionSphere, writeMeshNormal,
  type KeyShape, type PartRow, type PlanCamera, type PlanRow,
} from '../../../../src/render/geometry/map-plan.ts';
import { TIER_TABLE } from '../../../../src/render/perf/budget.ts';

afterEach(() => resetCalibration());

const at = (x: number, y: number, z: number, s = 1): Float32Array => new Float32Array([s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, x, y, z, 1]);
const spec = (name: string): ScriptedSpec => ({ kind: 'scripted', script: `scripts/gen/${name}.js`, params: {} });
let n = 0;
const row = (name: string, x: number, z: number, extra: Partial<PlanRow> = {}): PlanRow => ({ id: `r${n++}`, key: keyOf(spec(name)), spec: spec(name), m: at(x, 0, z), dynamic: false, ...extra });

describe('isDynamicRow (render §6.5)', () => {
  it('classifies the fixture rows', () => {
    const table: Array<[string, Parameters<typeof isDynamicRow>[0], boolean]> = [
      ['a plain static piece', { physics: 'static', tags: ['building', 'gf-geo'] }, false],
      ['no physics at all', {}, false],
      ['a static body object', { physics: { body: 'static', collider: 'mesh' } }, false],
      ['a physics object without a body is static', { physics: { collider: 'mesh' } }, false],
      ['a behaviour path', { behavior: 'scripts/map/spin.js' }, true],
      ['a behaviour list', { behavior: ['scripts/map/door.js'] }, true],
      ['an empty behaviour list', { behavior: [] }, false],
      ['kinematic physics', { physics: 'kinematic' }, true],
      ['a dynamic body object', { physics: { body: 'dynamic' } }, true],
      ['a parent', { parent: 'gf-windmill' }, true],
      ['a child of a moving row', { parentDynamic: true }, true],
      ['the door tag', { tags: ['door'] }, true],
      ['the kit door tag', { tags: ['prop', 'kit:door'] }, true],
      ['a viewmodel part', { tags: ['ss-vm'] }, true],
      ['an unrelated tag', { tags: ['doorframe', 'ss-vmx'] }, false],
    ];
    for (const [name, facts, want] of table) expect(isDynamicRow(facts, ['door', 'kit:door', 'ss-vm']), name).toBe(want);
    expect(DYNAMIC_TAGS).toEqual([]);
    expect(isDynamicRow({ tags: ['door'] })).toBe(false);
  });
});

describe('classifyRows (render §6.5)', () => {
  const rows = (): PlanRow[] => [
    ...[0, 1, 2, 3].map((i) => row('fence', i * 3, 0)), // 4 static rows: instanced
    ...[0, 1, 2].map((i) => row('tower', 40 + i * 20, 0)), // 3 rows, 6,200 LOD 1 triangles: instanced
    ...[0, 1, 2].map((i) => row('crate', i, 40)), // 3 rows, 120 triangles: merged
    row('barn', 26, 0), // single use: merged
    row('door', 5, 5, { dynamic: true }),
    ...[0, 1, 2, 3, 4].map((i) => row('lamp', i, -40, { dynamic: i < 2 })), // 3 static rows left: by triangles (small): merged
    row('plate', 0, 0, { ownLook: true }),
  ];
  const tris = (key: string): number => (key.includes('tower') ? 6200 : 120);

  it('splits a hybrid tier into instanced keys, merged rows, dynamic rows and rows with their own look', () => {
    const asked: string[] = [];
    const split = classifyRows(rows(), 'hybrid', (key) => {
      asked.push(key);
      return tris(key);
    });
    expect([...split.instanced.keys()].map((k) => k.split('|')[0])).toEqual(['scripts/gen/fence.js', 'scripts/gen/tower.js']);
    expect([...split.instanced.values()].map((l) => l.length)).toEqual([4, 3]);
    expect(split.merged.map((r) => r.key.split('|')[0]!.slice(12))).toEqual(['crate.js', 'crate.js', 'crate.js', 'barn.js', 'lamp.js', 'lamp.js', 'lamp.js']);
    expect(split.dynamic).toHaveLength(3);
    expect(split.standalone).toHaveLength(1);
    // the triangle count is only asked for keys with 2 or 3 static rows
    expect(asked.map((k) => k.split('|')[0]!.slice(12)).sort()).toEqual(['crate.js', 'lamp.js', 'tower.js']);
    expect(keysNeedingLod1Tris(rows(), 'hybrid').map((k) => k.split('|')[0]!.slice(12)).sort()).toEqual(['crate.js', 'lamp.js', 'tower.js']);
  });

  it('merges every static row on a mergeAll tier and never asks for triangles', () => {
    const split = classifyRows(rows(), 'mergeAll', () => {
      throw new Error('not asked');
    });
    expect(split.instanced.size).toBe(0);
    expect(split.merged).toHaveLength(4 + 3 + 3 + 1 + 3);
    expect(split.dynamic).toHaveLength(3);
    expect(keysNeedingLod1Tris(rows(), 'mergeAll')).toEqual([]);
  });

  it('groups merged rows by the 32 m cell of their origin, keeping their order', () => {
    const list = [row('a', 1, 1), row('b', 33, 1), row('c', 31, 31), row('d', -1, 1), row('e', 40, 5)];
    const groups = groupByChunk(list);
    expect([...groups.keys()]).toEqual([chunkIdOf(1, 1), chunkIdOf(33, 1), chunkIdOf(-1, 1)]);
    expect([...groups.values()].map((g) => g.map((r) => r.id))).toEqual([[list[0]!.id, list[2]!.id], [list[1]!.id, list[4]!.id], [list[3]!.id]]);
  });
});

describe('LOD selection (render §6.5, §15.1)', () => {
  it('reads the tier bands from the tier table, scaled by [CAL lod]', () => {
    expect(lodBands(TIER_TABLE.high)).toEqual({ lods: [1, 3, 5], distances: [30, 80] });
    expect(lodBands(TIER_TABLE.medium)).toEqual({ lods: [1, 3, 5], distances: [20, 60] });
    expect(lodBands(TIER_TABLE.low)).toEqual({ lods: [3, 5], distances: [50] });
    // DR-35 lever 5: 40 m before
    expect(lodBands(TIER_TABLE.minimum)).toEqual({ lods: [3, 5], distances: [25] });
    // a fitted calibration moves every tier by the same ratio: 1 → 3 by d13, the 3 → 5 switch by d35
    calibration.lod = { d13: 24, d35: 100 };
    expect(lodBands(TIER_TABLE.high).distances).toEqual([24, 100]);
    expect(lodBands(TIER_TABLE.medium).distances).toEqual([16, 75]);
    expect(lodBands(TIER_TABLE.low).distances).toEqual([62.5]);
    expect(() => lodBands({ lods: [1, 3, 5], lodDistances: [30] })).toThrow(RangeError);
  });

  it('picks the band by plain thresholds when nothing is shown yet', () => {
    const d = [30, 80];
    expect([0, 29.9, 30, 79.9, 80, 500].map((x) => selectLodIndex(-1, x, d))).toEqual([0, 0, 1, 1, 2, 2]);
    expect(selectLodIndex(-1, 10, [])).toBe(0);
  });

  it('holds a level inside the 10 % hysteresis band and switches outside it, in both directions', () => {
    const d = [30, 80];
    expect(LOD_HYSTERESIS).toBe(0.1);
    // walking away at LOD 1: still LOD 1 at 32.9 m, LOD 3 beyond 33 m
    expect(selectLodIndex(0, 32.9, d)).toBe(0);
    expect(selectLodIndex(0, 33.1, d)).toBe(1);
    // walking back at LOD 3: still LOD 3 at 27.1 m, LOD 1 under 27 m
    expect(selectLodIndex(1, 27.1, d)).toBe(1);
    expect(selectLodIndex(1, 26.9, d)).toBe(0);
    // the far switch: 88 m out, 72 m in
    expect(selectLodIndex(1, 87.9, d)).toBe(1);
    expect(selectLodIndex(1, 88.1, d)).toBe(2);
    expect(selectLodIndex(2, 72.1, d)).toBe(2);
    expect(selectLodIndex(2, 71.9, d)).toBe(1);
    // a teleport crosses both bands at once
    expect(selectLodIndex(0, 200, d)).toBe(2);
    expect(selectLodIndex(2, 1, d)).toBe(0);
    // no flicker: a camera oscillating ±2 m around a threshold changes level at most once
    let level = 0;
    let switches = 0;
    for (let i = 0; i < 200; i++) {
      const next = selectLodIndex(level, 30 + Math.sin(i) * 2, d);
      if (next !== level) switches++;
      level = next;
    }
    expect(switches).toBe(0);
  });

  it('measures to the box, not to its origin', () => {
    expect(distanceToAabb(0, 0, 0, [-1, -1, -1], [1, 1, 1])).toBe(0);
    expect(distanceToAabb(5, 0, 0, [-1, -1, -1], [1, 1, 1])).toBe(4);
    expect(distanceToAabb(4, 5, 0, [-1, -1, -1], [1, 1, 1])).toBe(5);
    // a 32 m chunk whose origin is 23 m from the camera while its near face is 1 m away
    expect(distanceToAabb(33, 0, 16, [0, 0, 0], [32, 8, 32])).toBe(1);
  });
});

describe('mesh normals of packed geometry', () => {
  it('writes a normal in quantised space: scaled by the bbox half extents, renormalised, with the smooth mark in w', () => {
    const out = new Int8Array(16);
    // a flat vertex (the packer's zero normal): a placeholder that normalises, w = 0
    writeMeshNormal(out, 0, 0, 0, 0, 2, 3, 4);
    // a smooth vertex on a 4 × 2 × 8 m bbox: n ⊙ h = (0.6 · 2, 0, 0.8 · 4) → (0.351, 0, 0.936)
    writeMeshNormal(out, 4, 0.6, 0, 0.8, 2, 1, 4);
    // the inverse transpose of scale(h) gives the metric normal back
    const back = [out[4]! / 2, out[5]! / 1, out[6]! / 4];
    const l = Math.hypot(...back);
    // along an axis without extent: the direction is kept
    writeMeshNormal(out, 8, 0, 0, -1, 1, 1, 0);
    writeMeshNormal(out, 12, 0, 127, 0, 5, 0.5, 5);
    expect(Array.from(out.subarray(0, 4))).toEqual([0, 127, 0, 0]);
    expect(out[7]).toBe(127);
    expect(back[0]! / l).toBeCloseTo(0.6, 2);
    expect(back[2]! / l).toBeCloseTo(0.8, 2);
    expect(Array.from(out.subarray(8, 12))).toEqual([0, 0, -127, 127]);
    expect(Array.from(out.subarray(12, 16))).toEqual([0, 127, 0, 127]);
    // a key LOD's normals (int8 xyz in metric space) as its mesh attribute
    const mesh = meshNormals(new Int8Array([0, 0, 0, 0, 127, 0, 0, 0, 90, 0, 90, 0]), [-1, 0, -3], [1, 2, 3]);
    expect(Array.from(mesh.subarray(0, 8))).toEqual([0, 127, 0, 0, 127, 0, 0, 127]);
    // (90, 0, 90) ⊙ (1, 1, 3) → (1, 0, 3) / √10
    expect(Array.from(mesh.subarray(8, 12))).toEqual([Math.round(127 / Math.sqrt(10)), 0, Math.round((127 * 3) / Math.sqrt(10)), 127]);
  });
});

describe('bounds and frustum', () => {
  it('moves a key bbox by a row matrix: sphere and world box', () => {
    const s = [0, 0, 0, 0];
    instanceSphere([-1, 0, -2], [1, 4, 2], at(10, 5, -3, 2), s);
    expect(s.slice(0, 3)).toEqual([10, 9, -3]);
    expect(s[3]).toBeCloseTo(Math.hypot(2, 4, 4) / 2 * 2, 12);
    expect(transformedAabb([-1, 0, -2], [1, 4, 2], at(10, 5, -3, 2))).toEqual({ min: [8, 5, -7], max: [12, 13, 1] });
  });

  it('finds the smallest culling radius of a key in a batch that is safe under every row matrix', () => {
    const min = [-1, 0, -3], max = [1, 4, 3]; // half extents 1, 2, 3
    const h = [1, 2, 3];
    const unit = Math.hypot(...h) / 3;
    // unscaled, uniformly scaled, rotated: the box's own sphere, |h| / max(h)
    const yaw = (a: number, s = 1): Float32Array => new Float32Array([Math.cos(a) * s, 0, -Math.sin(a) * s, 0, 0, s, 0, 0, Math.sin(a) * s, 0, Math.cos(a) * s, 0, 5, 0, 5, 1]);
    expect(keyCullRadius(min, max, [at(0, 0, 0)])).toBeCloseTo(unit, 12);
    expect(keyCullRadius(min, max, [at(9, 2, 1, 4), yaw(0.7, 0.5)])).toBeCloseTo(unit, 12);
    // a row stretched 3× along x: its box is 3 × 2 × 3, three scales the radius by 3: the ratio is |(3, 2, 3)| / 3
    const stretched = new Float32Array([3, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const world = new Float64Array(2);
    const ratio = keyCullRadius(min, max, [at(0, 0, 0), stretched], world);
    expect(ratio).toBeCloseTo(Math.hypot(3, 2, 3) / 3, 12);
    expect(ratio).toBeGreaterThan(unit);
    expect(ratio).toBeLessThanOrEqual(Math.sqrt(3));
    // the world radius three tests each row with: the ratio times that row's largest axis scale
    expect(world[0]).toBeCloseTo(ratio * 3, 12);
    expect(world[1]).toBeCloseTo(Math.hypot(3, 2, 3), 12);
    expect(world[0]!).toBeGreaterThanOrEqual(Math.hypot(...h));
    // a cube stretched the other way reaches the cube sphere's √3 exactly
    expect(keyCullRadius([-1, -1, -1], [1, 1, 1], [at(0, 0, 0)])).toBeCloseTo(Math.sqrt(3), 12);
    // a sheared row (a non-uniformly scaled parent above a rotated child) can need more than √3: the corners are measured
    const shear = new Float32Array([1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
    const sheared = keyCullRadius([-1, -1, -1], [1, 1, 1], [shear]);
    expect(sheared).toBeCloseTo(Math.hypot(2, 1, 1) / Math.SQRT2, 12);
    // an axis with no extent counts as the dequantisation counts it
    expect(keyCullRadius([0, 0, 0], [2, 0, 2], [at(0, 0, 0)])).toBeCloseTo(Math.SQRT2, 5);
    expect(keyCullRadius(min, max, [])).toBe(0);
  });

  it('unions spheres', () => {
    const acc = [0, 0, 0, -1];
    unionSphere(acc, [0, 0, 0, 1]);
    expect(acc).toEqual([0, 0, 0, 1]);
    unionSphere(acc, [0.2, 0, 0, 0.5]); // inside
    expect(acc).toEqual([0, 0, 0, 1]);
    unionSphere(acc, [10, 0, 0, 1]);
    expect(acc[0]).toBeCloseTo(5, 12);
    expect(acc[3]).toBeCloseTo(6, 12);
    unionSphere(acc, [5, 0, 0, 100]); // swallows
    expect(acc).toEqual([5, 0, 0, 100]);
  });

  const cam: PlanCamera = { position: [0, 1.7, 0], target: [0, 1.7, -1], vfovDeg: 58.72, aspect: 16 / 9, near: 0.1, far: 2000 };

  it('builds the six planes of a camera: 90° horizontal at 58.72° vertical and 16:9', () => {
    const p = frustumPlanes(cam);
    // straight ahead is inside, behind is not; ±44° is inside, ±46° is not
    expect(sphereInFrustum(p, 0, 1.7, -10, 0)).toBe(true);
    expect(sphereInFrustum(p, 0, 1.7, 10, 0)).toBe(false);
    const ray = (deg: number): [number, number, number] => [Math.sin((deg * Math.PI) / 180) * 10, 1.7, -Math.cos((deg * Math.PI) / 180) * 10];
    expect(sphereInFrustum(p, ...ray(44), 0)).toBe(true);
    expect(sphereInFrustum(p, ...ray(-44), 0)).toBe(true);
    expect(sphereInFrustum(p, ...ray(46), 0)).toBe(false);
    expect(sphereInFrustum(p, ...ray(-46), 0)).toBe(false);
    // a sphere that straddles a side plane is in
    expect(sphereInFrustum(p, ...ray(50), 2)).toBe(true);
    // near and far
    expect(sphereInFrustum(p, 0, 1.7, -2500, 100)).toBe(false);
    expect(sphereInFrustum(p, 0, 1.7, -0.05, 0)).toBe(false);
    // boxes
    expect(aabbInFrustum(p, [-1, 0, -20], [1, 3, -18])).toBe(true);
    expect(aabbInFrustum(p, [-1, 0, 18], [1, 3, 20])).toBe(false);
    expect(aabbInFrustum(p, [30, 0, -12], [34, 3, -8])).toBe(false);
  });

  it('estimates the map line: chunk LOD by box distance, instance LOD by sphere, a draw per non-empty pass', () => {
    const shape = (opaque: number, transparent: number): KeyShape => ({ tris: { 1: { opaque, transparent }, 3: { opaque: opaque / 2, transparent }, 5: { opaque: opaque / 10, transparent: 0 } }, bboxMin: [-1, 0, -1], bboxMax: [1, 2, 1] });
    const shapes = new Map<string, KeyShape>([
      [keyOf(spec('wall')), shape(1000, 100)],
      [keyOf(spec('post')), shape(200, 0)],
      [keyOf(spec('gate')), shape(400, 0)],
    ]);
    const rows: PlanRow[] = [
      row('wall', 0, -10), // near chunk, ahead: LOD 1, opaque + transparent
      row('wall', 0, -150), // far chunk, ahead: LOD 5, opaque only
      row('wall', 0, 150), // behind: culled
      ...[-12, -14, -50, -52, -200].map((z) => row('post', 0, z)), // 5 instances over the three bands
      row('gate', 2, -20, { dynamic: true }),
    ];
    const split = classifyRows(rows, 'hybrid', () => 0);
    const layout = layoutOf(split, (key) => shapes.get(key));
    expect(layout.chunks).toHaveLength(3);
    expect(layout.instanced).toHaveLength(1);
    expect(layout.single).toHaveLength(1);
    const e = estimateMapFrame(layout, cam, { lods: [1, 3, 5], distances: [30, 80] });
    expect(e.chunksVisible).toBe(2);
    expect(e.chunkDraws).toBe(3);
    // the instanced key draws one mesh per band in use: 2 at LOD 1, 2 at LOD 3, 1 at LOD 5
    expect(e.instancedDraws).toBe(3);
    expect(e.singleDraws).toBe(1);
    expect(e.draws).toBe(7);
    expect(e.triangles).toBe(1100 + 100 + 2 * 200 + 2 * 100 + 20 + 400);
    expect(MAP_DRAW_BUDGET).toEqual({ high: 130, medium: 120, low: 80, minimum: 70 });
    // DR-35 lever 3: as one BatchedMesh per pass the instanced key is one draw (posts have no transparent pass), and its
    // instances are culled one by one (all five are ahead here, so the triangles are the same)
    const batched = estimateMapFrame(layout, cam, { lods: [1, 3, 5], distances: [30, 80] }, { instancing: 'batched' });
    expect(batched.instancedDraws).toBe(1);
    expect(batched.draws).toBe(5);
    expect(batched.triangles).toBe(e.triangles);
  });

  it('tests a chunk by its box sphere, not by the cube sphere of its largest extent (DR-35 lever 1)', () => {
    // a 30 × 2 × 2 m chunk beside the view: its box sphere (radius 15.07) is outside the right plane, the sphere of a 30 m
    // cube (radius 25.98) is not
    const long: KeyShape = { tris: { 1: { opaque: 500, transparent: 0 } }, bboxMin: [-1, 0, -15], bboxMax: [1, 2, 15] };
    const key = keyOf(spec('long'));
    const split = classifyRows([row('long', 30, -8)], 'mergeAll', () => 0);
    const layout = layoutOf(split, (k) => (k === key ? long : undefined));
    const bands = { lods: [1 as const], distances: [] };
    expect(estimateMapFrame(layout, cam, bands, { chunkSphere: 'cube' }).chunkDraws).toBe(1);
    expect(estimateMapFrame(layout, cam, bands).chunkDraws).toBe(0);
    expect(estimateMapFrame(layout, cam, bands).triangles).toBe(0);
  });
});

describe('chunk parts and far groups (DR-35 levers 2 and 4)', () => {
  // the cell (0, 0): x and z in 0..32
  const chunk = chunkIdOf(1, 1);
  const box = (x: number, z: number, w: number, d: number, tris: number): PartRow => ({ min: [x, 0, z], max: [x + w, 3, z + d], tris });

  it('sizes the split from the frame triangle budget: 15 %, never under 90,000', () => {
    expect(chunkSplitFor(TIER_TABLE.high.triangleBudget)).toEqual({ cap: 225_000, oversize: 16, minCell: 8 });
    expect(chunkSplitFor(TIER_TABLE.medium.triangleBudget)).toEqual({ cap: 150_000, oversize: 16, minCell: 8 });
    expect(chunkSplitFor(TIER_TABLE.low.triangleBudget).cap).toBe(90_000);
    expect(chunkSplitFor(TIER_TABLE.minimum.triangleBudget).cap).toBe(90_000);
    expect([CHUNK_OVERSIZE, CHUNK_MIN_CELL, CHUNK_TRIANGLE_FLOOR, CHUNK_TRIANGLE_SHARE, FAR_CELLS]).toEqual([16, 8, 90_000, 0.15, 4]);
  });

  it('keeps a cell whole under the cap and without a split', () => {
    const rows = [box(1, 1, 2, 2, 100), box(20, 20, 2, 2, 100)];
    expect(partitionChunk(chunk, rows)).toEqual([{ label: '', rows: [0, 1] }]);
    expect(partitionChunk(chunk, rows, { cap: 200, oversize: 16, minCell: 8 })).toEqual([{ label: '', rows: [0, 1] }]);
    expect(partitionChunk(chunk, [])).toEqual([]);
    expect(partitionChunk(chunk, [], { cap: 1, oversize: 16, minCell: 8 })).toEqual([]);
  });

  it('puts rows wider than 16 m on x or z into the large part, whatever their height', () => {
    const rows = [box(1, 1, 2, 2, 10), box(0, 10, 30, 1, 10), box(5, 0, 1, 16.5, 10), box(8, 8, 16, 16, 10), { min: [3, 0, 3], max: [4, 40, 4], tris: 10 }];
    expect(partitionChunk(chunk, rows, { cap: 1000, oversize: 16, minCell: 8 })).toEqual([{ label: '', rows: [0, 3, 4] }, { label: 'L', rows: [1, 2] }]);
    // only large rows: only the large part
    expect(partitionChunk(chunk, [rows[1]!], { cap: 1000, oversize: 16, minCell: 8 })).toEqual([{ label: 'L', rows: [0] }]);
  });

  it('quarters a cell while it is over the triangle cap, by the centre of each row box, down to 8 m', () => {
    const rows = [
      box(1, 1, 2, 2, 60), // quadrant 0, then 00
      box(10, 1, 2, 2, 60), // 0, then 01 (x ≥ 8)
      box(1, 12, 2, 2, 60), // 0, then 02 (z ≥ 8)
      box(20, 1, 2, 2, 50), // 1
      box(1, 20, 2, 2, 50), // 2
      box(30, 30, 2, 2, 50), // 3
      box(2, 2, 2, 2, 60), // 00 again: at the 8 m floor two rows stay together although they are over the cap
      box(14, 30, 4, 6, 70), // centre x = 16: the high half (3); centre z = 33, past the cell's edge: clamped into the high half
    ];
    const split = { cap: 100, oversize: 16, minCell: 8 };
    expect(partitionChunk(chunk, rows, split)).toEqual([
      { label: '00', rows: [0, 6] },
      { label: '01', rows: [1] },
      { label: '02', rows: [2] },
      { label: '1', rows: [3] },
      { label: '2', rows: [4] },
      // the last quadrant holds 120 triangles in two rows: quartered again (centre x = 16 is its low half, 31 its high half)
      { label: '32', rows: [7] },
      { label: '33', rows: [5] },
    ]);
    // a single row over the cap cannot be cut
    expect(partitionChunk(chunk, [box(1, 1, 2, 2, 500)], split)).toEqual([{ label: '', rows: [0] }]);
    // with a 16 m floor the first quartering is the last
    expect(partitionChunk(chunk, rows, { ...split, minCell: 16 }).map((p) => p.label)).toEqual(['0', '1', '2', '3']);
    // deterministic, and every row lands in exactly one part
    const again = partitionChunk(chunk, rows, split);
    expect(again).toEqual(partitionChunk(chunk, rows, split));
    expect(again.flatMap((p) => p.rows).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('cuts in the cell of the chunk id, also on the negative side', () => {
    // the cell (−1, −2): x −32..0, z −64..−32
    const id = chunkIdOf(-1, -33);
    const parts = partitionChunk(id, [box(-30, -62, 2, 2, 60), box(-10, -40, 2, 2, 60)], { cap: 100, oversize: 16, minCell: 8 });
    expect(parts).toEqual([{ label: '0', rows: [0] }, { label: '3', rows: [1] }]);
  });

  it('groups cells into 128 m far groups', () => {
    expect(farIdOf(chunkIdOf(0, 0))).toBe(farIdOf(chunkIdOf(127, 127)));
    expect(farIdOf(chunkIdOf(0, 0))).not.toBe(farIdOf(chunkIdOf(128, 0)));
    expect(farIdOf(chunkIdOf(0, 0))).not.toBe(farIdOf(chunkIdOf(-1, 0)));
    expect(farIdOf(chunkIdOf(-1, -1))).toBe(farIdOf(chunkIdOf(-128, -128)));
    expect(farIdOf(chunkIdOf(-129, 0))).not.toBe(farIdOf(chunkIdOf(-128, 0)));
  });

  const cam: PlanCamera = { position: [0, 1.7, 0], target: [0, 1.7, -1], vfovDeg: 58.72, aspect: 16 / 9, near: 0.1, far: 2000 };
  const hut: KeyShape = { tris: { 3: { opaque: 1000, transparent: 100 }, 5: { opaque: 100, transparent: 10 } }, bboxMin: [-1, 0, -1], bboxMax: [1, 2, 1] };
  const fence: KeyShape = { tris: { 3: { opaque: 40, transparent: 0 }, 5: { opaque: 20, transparent: 0 } }, bboxMin: [0, 0, 0], bboxMax: [30, 2, 0.2] };
  const shapeOf = (key: string): KeyShape | undefined => (key === keyOf(spec('hut')) ? hut : key === keyOf(spec('fence')) ? fence : undefined);

  it('lays a map out in parts: the estimate cuts the cells as the workers do', () => {
    // one cell: two huts 20 m apart and a 30 m fence
    const split = classifyRows([row('hut', 2, -30), row('hut', 22, -10), row('fence', 1, -31)], 'mergeAll', () => 0);
    const whole = layoutOf(split, shapeOf);
    expect(whole.chunks.map((c) => [c.part, c.rows])).toEqual([['', 3]]);
    expect(whole.chunks[0]!.max[0]! - whole.chunks[0]!.min[0]!).toBe(30);
    // the fence leaves for the large part; a cap under two huts quarters the rest
    const parts = layoutOf(split, shapeOf, { cap: 1500, oversize: 16, minCell: 8 });
    expect(parts.chunks.map((c) => [c.part, c.rows])).toEqual([['0', 1], ['3', 1], ['L', 1]]);
    expect(parts.chunks.every((c) => c.far === farIdOf(chunkIdOf(2, -30)))).toBe(true);
    expect(parts.chunks[0]!.max[0]! - parts.chunks[0]!.min[0]!).toBe(2);
    expect(parts.chunks[0]!.tris).toEqual({ 3: { opaque: 1000, transparent: 100 }, 5: { opaque: 100, transparent: 10 } });
    expect(finestTris(hut)).toBe(1100);
    expect(finestTris({ tris: {}, bboxMin: [0, 0, 0], bboxMax: [0, 0, 0] })).toBe(0);
  });

  it('draws a far group as one mesh while every part selects the coarsest level, and part by part otherwise', () => {
    // six huts in three cells of one far group, 60 to 100 m ahead; two more in another group, 200 m ahead
    const rows = [row('hut', -40, -70), row('hut', -38, -68), row('hut', 2, -70), row('hut', 4, -100), row('hut', 40, -90), row('hut', 42, -92), row('hut', 2, -300), row('hut', 40, -300)];
    const layout = layoutOf(classifyRows(rows, 'mergeAll', () => 0), shapeOf, { cap: 100_000, oversize: 16, minCell: 8 });
    expect(layout.chunks).toHaveLength(6);
    const bands = { lods: [3 as const, 5 as const], distances: [50] };
    const near = { ...cam };
    // every part is beyond 50 m: the far group −1 holds one part and draws on its own, the two others are far meshes
    const far = estimateMapFrame(layout, near, bands);
    expect([far.chunkDraws, far.farDraws]).toEqual([2, 4]);
    expect(far.chunksVisible).toBe(6);
    expect(far.triangles).toBe(8 * 110);
    // without far meshes the same triangles are six parts, twelve draws
    const flat = estimateMapFrame(layout, near, bands, { far: false });
    expect([flat.chunkDraws, flat.farDraws, flat.triangles]).toEqual([12, 0, 8 * 110]);
    // 30 m closer one part of the first group is inside the LOD 3 band: that group draws part by part again
    const closer = estimateMapFrame(layout, { ...cam, position: [0, 1.7, -30], target: [0, 1.7, -31] }, bands);
    expect(closer.farDraws).toBe(2);
    // (the lone part of the first group, and the three parts of the second)
    expect(closer.chunkDraws).toBe(2 + 6);
    expect(closer.triangles).toBe(1100 + 7 * 110);
  });
});
