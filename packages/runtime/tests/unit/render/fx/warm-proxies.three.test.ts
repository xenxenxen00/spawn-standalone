// The fx buckets' stand-ins for the shader warm-up (src/render/fx/render/buckets.ts, stretched-buckets.ts `warmProxies`):
// every (space, blend) an effect can fill, built as its bucket is, so the program an effect first needs at PREP or in the
// wave is linked behind the menu (render §7.2).
import { DataTexture, InstancedMesh, Object3D, RGBAFormat, Scene, Sprite, UnsignedByteType } from 'three/webgpu';
import type { Material } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { compileProgram } from '../../../../src/render/fx/dsl/compile.ts';
import { createFxSystem } from '../../../../src/render/fx/fx-system.ts';
import { createRenderBudget, tierConfig } from '../../../../src/render/perf/budget.ts';
import { FxSpriteBuckets } from '../../../../src/render/fx/render/buckets.ts';
import { FxStretchedBuckets } from '../../../../src/render/fx/render/stretched-buckets.ts';
import { createFxSimulation } from '../../../../src/render/fx/sim/simulator.ts';

const atlas = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, RGBAFormat, UnsignedByteType);
const state = (m: Material): unknown => ({ name: m.name, blending: m.blending, transparent: m.transparent, depthWrite: m.depthWrite, fog: (m as { fog?: boolean }).fog, type: m.constructor.name });

describe('fx bucket stand-ins for the warm-up', () => {
  it('one hidden, unparented sprite per (space, blend), without making the real buckets', () => {
    const world = new Scene();
    const camera = new Object3D();
    const buckets = new FxSpriteBuckets({ world, camera, atlas, capacity: 32, additiveFog: 'three' });
    const proxies = buckets.warmProxies();
    expect(proxies.map((p) => p.name).sort()).toEqual(['world', 'camera'].flatMap((s) => ['alpha', 'add', 'distort'].map((b) => `ss:warm-up:ss:fx:${s}:${b}`)).sort());
    for (const p of proxies) {
      expect(p).toBeInstanceOf(Sprite);
      expect(p.parent).toBeNull();
      expect(p.visible).toBe(false);
    }
    expect(world.children).toHaveLength(0);
    expect(camera.children).toHaveLength(0);
    expect(buckets.get('alpha', 'world')).toBeUndefined();
    // no distort without the distortion tier, no camera space without a camera
    expect(new FxSpriteBuckets({ world, atlas, capacity: 8, additiveFog: 'three', distortEnabled: false }).warmProxies().map((p) => p.name).sort()).toEqual(['ss:warm-up:ss:fx:world:add', 'ss:warm-up:ss:fx:world:alpha']);
  });

  it('builds the stand-in material as the bucket an effect makes is built', () => {
    const world = new Scene();
    const buckets = new FxSpriteBuckets({ world, atlas, capacity: 16, additiveFog: 'fade' });
    const program = compileProgram('fx\npop a burst=1 life=1 r=sprite(smoke-puff,alpha)\npop b burst=1 life=1 r=sprite(ember,add)', {}, { low: false, mobile: false });
    const sim = createFxSimulation(program, { seed: 3, capacity: 8 });
    buckets.update([sim]);
    const byName = new Map(buckets.warmProxies().map((p) => [p.name, p] as const));
    for (const blend of ['alpha', 'add'] as const) {
      const real = buckets.get(blend, 'world')!;
      const proxy = byName.get(`ss:warm-up:ss:fx:world:${blend}`)!;
      expect(state(proxy.material), blend).toEqual(state(real.material));
      expect(Object.keys(proxy.geometry.attributes).sort()).toEqual(Object.keys(real.geometry.attributes).sort());
    }
    sim.dispose();
  });

  it('FxRuntime.warmObjects hands the warm-up both kinds of stand-ins and leaves the scene and the live buckets alone', () => {
    const world = new Scene();
    const camera = new Object3D();
    const fx = createFxSystem({ world, camera, atlas, budget: createRenderBudget('high') });
    const before = world.children.length;
    const objects = fx.warmObjects();
    // world and camera space; alpha, add and (on a tier with distortion) distort; sprites and stretched quads
    const spaces = 2;
    const blends = tierConfig('high').distort ? 3 : 2;
    expect(objects.filter((o) => o instanceof Sprite)).toHaveLength(spaces * blends);
    expect(objects.filter((o) => o instanceof InstancedMesh)).toHaveLength(spaces * blends);
    expect(objects.every((o) => o.parent === null && o.name.startsWith('ss:warm-up:'))).toBe(true);
    expect(world.children).toHaveLength(before);
    expect(fx.sprites.get('alpha', 'world')).toBeUndefined();
    expect(fx.stretched.get('add', 'world')).toBeUndefined();
    fx.dispose();
    expect(fx.warmObjects()).toEqual([]);
  });

  it('stretched buckets: one hidden, unparented instanced mesh per (space, blend)', () => {
    const world = new Scene();
    const stretched = new FxStretchedBuckets({ world, atlas, capacity: 32, additiveFog: 'three' });
    const proxies = stretched.warmProxies();
    expect(proxies.map((p) => p.name).sort()).toEqual(['add', 'alpha', 'distort'].map((b) => `ss:warm-up:ss:fx:stretched:world:${b}`));
    for (const p of proxies) {
      expect(p).toBeInstanceOf(InstancedMesh);
      expect(p.parent).toBeNull();
      expect(p.visible).toBe(false);
      expect(p.count).toBe(0);
    }
    expect(world.children).toHaveLength(0);
    expect(stretched.get('add', 'world')).toBeUndefined();
  });
});
