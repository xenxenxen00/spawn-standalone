import { describe, expect, it } from 'vitest';
import type { ColliderPack } from '../../../../src/compat/core/ports.ts';
import { buildColliderIndex } from '../../../../src/render/decals/collider-index.ts';

const identity = (): Float32Array => new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
const tri = (a: number[], b: number[], c: number[]): number[] => [...a, ...b, ...c];
const floor = (y: number, x0 = -2, z0 = -2, x1 = 2, z1 = 2): Float32Array => new Float32Array([
  ...tri([x0, y, z0], [x0, y, z1], [x1, y, z1]),
  ...tri([x0, y, z0], [x1, y, z1], [x1, y, z0]),
]);
const pack = (instances: ColliderPack['instances'], keys: ColliderPack['keys']): ColliderPack => ({ place: 'fixture', instances, keys, runtimeKeys: [] });

describe('decal collider index', () => {
  it('indexes only immutable, visible static colliders and finds the nearest stamped face', () => {
    const index = buildColliderIndex(pack([
      { rowId: 'floor', key: 0, m: identity(), mutable: false, kinematic: false, noDecal: false },
      { rowId: 'invisible', key: 0, m: identity(), mutable: false, kinematic: false, noDecal: true },
      { rowId: 'mutable', key: 0, m: identity(), mutable: true, kinematic: false, noDecal: false },
      { rowId: 'kinematic', key: 0, m: identity(), mutable: false, kinematic: true, noDecal: false },
    ], [{ id: 'floor', tris: floor(0) }]));

    expect(index.triangleCount).toBe(2);
    expect(index.raycast([0, 0.12, 0], [0, -1, 0], 0.35)).toMatchObject({ instanceId: 'floor', point: [0, 0, 0] });
    expect(index.raycast([0, 0.12, 0], [0, -1, 0], 0.1)).toBeNull();
  });

  it('tessellates box collider keys using the render primitive geometry convention', () => {
    const index = buildColliderIndex(pack([
      { rowId: 'box', key: 0, m: identity(), mutable: false, kinematic: false, noDecal: false },
    ], [{ id: 'box', box: [4, 2, 6] }]));

    expect(index.triangleCount).toBe(12);
    expect(index.raycast([0, 2.12, 0], [0, -1, 0], 0.35)?.point[1]).toBeCloseTo(2);
  });
});
