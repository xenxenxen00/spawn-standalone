// DR-54 1 (F1): when the fx mesh-sink bucket grows inside a frame's fill, no instance of that frame is lost. Before the fix the
// grow copied `count` (0 after `setCount(0)`) instances into the new arrays: every instance written before it drew as an
// unpainted 1 m box at the world origin for that frame. The bucket starts at the construction tier's particle cap (CPU1 1.4), so
// a grow happens when a later tier raises the cap: built at `low` (8 000), drawn at `high` (30 000).
import { describe, expect, it } from 'vitest';
import { InstancedMesh, Object3D, Scene } from 'three/webgpu';
import { createFxSystem } from '../../../../src/render/fx/fx-system.ts';
import { tierConfig, type RenderBudget, type TierId } from '../../../../src/render/perf/budget.ts';
import { ATLAS } from './oracle.ts';

function liveBudget(tier: { now: TierId }): RenderBudget {
  return {
    get tier() {
      return tier.now;
    },
    cap: (kind, fallback) => {
      const v = (tierConfig(tier.now) as unknown as Record<string, unknown>)[kind];
      return typeof v === 'number' && Number.isFinite(v) ? Math.min(fallback, v) : fallback;
    },
  };
}

const DROPS = (n: number): string => `fx\npop drops burst=${n} life=1 size=.05 col=<.5,0,0> r=mesh(box,1,1,1)`;

describe('F1: the fx mesh bucket grows without losing the frame', () => {
  it('a grow to 9 000 + 3 000 instances keeps every one painted and placed', () => {
    const tier = { now: 'low' as TierId };
    const world = new Scene();
    const fx = createFxSystem({ world, camera: new Object3D(), atlas: ATLAS, budget: liveBudget(tier) });
    // a small frame first: the bucket exists at the low tier's capacity
    fx.emit({ script: DROPS(10) }, [0, 1, 0]);
    fx.update({ dt: 0, now: 0 });
    const before = world.children.find((o) => o.name.startsWith('ss:primitives:')) as InstancedMesh;
    expect(before.instanceMatrix.count).toBeLessThan(12_010);
    tier.now = 'high';
    fx.emit({ script: DROPS(9000) }, [2, 1, 0]);
    fx.emit({ script: DROPS(3000) }, [-2, 1, 0]);
    fx.update({ dt: 0, now: 16 });
    const mesh = world.children.find((o) => o.name.startsWith('ss:primitives:')) as InstancedMesh;
    expect(mesh).not.toBe(before);
    expect(mesh.count).toBe(12_010);
    const albedo = mesh.geometry.getAttribute('ssAlbedo').array as Float32Array;
    const m = mesh.instanceMatrix.array as Float32Array;
    let unpainted = 0, unit = 0;
    for (let i = 0; i < mesh.count; i++) {
      if (albedo[i * 4 + 3] !== 1 || albedo[i * 4] === 0) unpainted++;
      // every drop is 5 cm: a unit diagonal is three's identity instance (a slot nothing wrote)
      if (m[i * 16] === 1 && m[i * 16 + 5] === 1 && m[i * 16 + 10] === 1) unit++;
    }
    expect({ unpainted, unit }).toEqual({ unpainted: 0, unit: 0 });
    fx.dispose();
  });
});
