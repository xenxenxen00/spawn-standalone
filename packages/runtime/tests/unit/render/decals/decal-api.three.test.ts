import { describe, expect, it } from 'vitest';
import type { ColliderPack } from '../../../../src/compat/core/ports.ts';
import { DecalApi } from '../../../../src/render/decals/decal-api.ts';
import { buildColliderIndex } from '../../../../src/render/decals/collider-index.ts';

const identity = (): Float32Array => new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
const pack: ColliderPack = {
  place: 'fixture',
  keys: [{ id: 'floor', tris: new Float32Array([-5, 0, -5, -5, 0, 5, 5, 0, 5, -5, 0, -5, 5, 0, 5, 5, 0, -5]) }],
  instances: [{ rowId: 'floor', key: 0, m: identity(), mutable: false, kinematic: false, noDecal: false }],
  runtimeKeys: [],
};

describe('DecalApi', () => {
  it('stores clipped decals as one handle and clears the match window', () => {
    let now = 0;
    const api = new DecalApi(buildColliderIndex(pack), { mode: 'live', tier: 'high', now: () => now, warn: () => {} });
    expect(api.add({ position: [0, 0.12, 0], normal: [0, 1, 0], texture: 'gore.png', size: 6.9, lifetime: 900 })).toBe(0);
    expect(api.live).toBe(1);
    expect(api.entries[0]?.value.clipped.tiles.length).toBeGreaterThan(1);
    expect(api.entries[0]?.expires).toBe(600);
    expect(api.add({ position: [0, 10, 0], normal: [0, 1, 0], texture: 'none.png', size: 1 })).toBeNull();
    now = 600;
    expect(api.live).toBe(0);
    api.add({ position: [0, 0.12, 0], normal: [0, 1, 0], texture: 'gore.png', size: 1 });
    api.clearAll();
    expect(api.live).toBe(0);
  });
});
