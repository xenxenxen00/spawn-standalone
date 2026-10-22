import { describe, expect, it } from 'vitest';
import type { ColliderPack } from '../../../../src/compat/core/ports.ts';
import { buildColliderIndex } from '../../../../src/render/decals/collider-index.ts';
import { clipDecal } from '../../../../src/render/decals/clipper.ts';

const identity = (): Float32Array => new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
const tri = (a: number[], b: number[], c: number[]): number[] => [...a, ...b, ...c];
const quad = (at: number, y: number, extent: number): Float32Array => new Float32Array([
  ...tri([-extent, y, -extent], [-extent, y, extent], [extent, y, extent]),
  ...tri([-extent, y, -extent], [extent, y, extent], [extent, y, -extent]),
]);
const wall = (z: number, x0: number, x1: number): Float32Array => new Float32Array([
  ...tri([x0, 0, z], [x1, 0, z], [x1, 3, z]),
  ...tri([x0, 0, z], [x1, 3, z], [x0, 3, z]),
]);
const pack = (instances: ColliderPack['instances'], keys: ColliderPack['keys']): ColliderPack => ({ place: 'fixture', keys, instances, runtimeKeys: [] });
const instance = (rowId: string, key: number, noDecal = false): ColliderPack['instances'][number] => ({ rowId, key, m: identity(), mutable: false, kinematic: false, noDecal });
const surface = (y: number, extent: number) => ({ id: `surface:${y}`, tris: quad(0, y, extent) });
const area = (positions: Float32Array): number => {
  let result = 0;
  for (let i = 0; i < positions.length; i += 9) {
    const ax = positions[i]!, ay = positions[i + 1]!, az = positions[i + 2]!;
    const bx = positions[i + 3]!, by = positions[i + 4]!, bz = positions[i + 5]!;
    const cx = positions[i + 6]!, cy = positions[i + 7]!, cz = positions[i + 8]!;
    result += Math.hypot((by - ay) * (cz - az) - (bz - az) * (cy - ay), (bz - az) * (cx - ax) - (bx - ax) * (cz - az), (bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
  }
  return result;
};
const tilePositions = (result: NonNullable<ReturnType<typeof clipDecal>>): Float32Array[] => result.tiles.map((tile) => tile.positions);

describe('decal projection clipping', () => {
  it('stays on the seeded floor instead of stamping nearby storeys and a table', () => {
    const index = buildColliderIndex(pack([
      { ...instance('upper-floor', 0), m: identity() },
      { ...instance('lower-floor', 1), m: identity() },
      { ...instance('slab-above', 2), m: identity() },
      { ...instance('table-top', 3), m: identity() },
    ], [surface(3, 10), surface(2.9, 10), surface(3.6, 10), surface(3.2, 0.6)]));
    const result = clipDecal(index, { position: [0, 3.12, 0], normal: [0, 1, 0], texture: 'gore.png', size: 3 });

    expect(result).not.toBeNull();
    expect([...new Set(tilePositions(result!).flatMap((p) => Array.from({ length: p.length / 3 }, (_, i) => Math.round(p[i * 3 + 1]! * 1000) / 1000)))])
      .toEqual([3.002]);
  });

  it('does not bleed onto a nearby same-facing wall on another plane', () => {
    const index = buildColliderIndex(pack([instance('seed-wall', 0), instance('next-room-wall', 1)], [
      { id: 'seed', tris: wall(0.1, -5, 5) }, { id: 'next', tris: wall(0, -5, 5) },
    ]));
    const result = clipDecal(index, { position: [0, 1.5, 0.22], normal: [0, 0, 1], texture: 'gore.png', size: 4 });

    expect(result).not.toBeNull();
    expect([...new Set(tilePositions(result!).flatMap((p) => Array.from({ length: p.length / 3 }, (_, i) => Math.round(p[i * 3 + 2]! * 1000) / 1000)))])
      .toEqual([0.102]);
  });

  it('tiles a 6.9 m terrain splat without losing its UV coverage', () => {
    const index = buildColliderIndex(pack([], []));
    index.addWorldTriangles('mire-island-terrain', quad(0, 0, 10));
    const result = clipDecal(index, { position: [0, 0.12, 0], normal: [0, 1, 0], texture: 'gore.png', size: 6.9 });

    expect(result?.tiles.length).toBeGreaterThan(1);
    expect(result?.tiles.flatMap((tile) => Array.from(tile.uvs))).toEqual(expect.arrayContaining([0, 1]));
    expect(result?.tiles.reduce((sum, tile) => sum + area(tile.positions), 0)).toBeCloseTo(6.9 ** 2, 2);
  });

  it('clips a wide staircase surface completely and keeps a 24 m pool on its own storey', () => {
    const stairs: number[] = [];
    for (let step = 0; step < 14; step++) {
      const y = step * 0.02;
      const z0 = step * 0.5 - 3.5, z1 = z0 + 0.5;
      stairs.push(...tri([-4, y, z0], [-4, y, z1], [4, y, z1]), ...tri([-4, y, z0], [4, y, z1], [4, y, z0]));
    }
    const index = buildColliderIndex(pack([], []));
    index.addWorldTriangles('stairs', new Float32Array(stairs));
    const stair = clipDecal(index, { position: [0, 0.12, 0], normal: [0, 1, 0], texture: 'gore.png', size: 6.9 });
    expect(stair?.tiles.reduce((sum, tile) => sum + area(tile.positions), 0)).toBeGreaterThan(47.5);

    const floors = buildColliderIndex(pack([], []));
    floors.addWorldTriangles('upper-storey', quad(0, 0, 20));
    floors.addWorldTriangles('lower-storey', quad(0, -3, 20));
    const pool = clipDecal(floors, { position: [0, 0.12, 0], normal: [0, 1, 0], texture: 'pool.png', size: 24 });
    const ys = [...new Set(tilePositions(pool!).flatMap((p) => Array.from({ length: p.length / 3 }, (_, i) => Math.round(p[i * 3 + 1]! * 1000) / 1000)))];
    expect(pool?.tiles.reduce((sum, tile) => sum + area(tile.positions), 0)).toBeCloseTo(24 ** 2, 1);
    expect(ys[0]).toBeCloseTo(0.002, 5);
  });

  it('drops a cast that only hits a noDecal blocker', () => {
    const index = buildColliderIndex(pack([instance('bounds', 0, true)], [surface(0, 10)]));
    expect(clipDecal(index, { position: [0, 0.12, 0], normal: [0, 1, 0], texture: 'gore.png', size: 2 })).toBeNull();
  });
});
