import { afterEach, describe, expect, it } from 'vitest';
import { AdditiveBlending, DataTexture, InstancedMesh, NormalBlending, RGBAFormat, Scene, UnsignedByteType } from 'three/webgpu';
import { compileProgram } from '../../../../src/render/fx/dsl/compile.ts';
import { createFxSimulation } from '../../../../src/render/fx/sim/simulator.ts';
import { FxSpriteBuckets } from '../../../../src/render/fx/render/buckets.ts';
import { FxStretchedBuckets } from '../../../../src/render/fx/render/stretched-buckets.ts';

describe('FX sprite buckets', () => {
  const root = new Scene();
  const atlas = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, RGBAFormat, UnsignedByteType);
  const buckets = new FxSpriteBuckets({ world: root, atlas, capacity: 32, additiveFog: 'three' });
  const stretched = new FxStretchedBuckets({ world: root, atlas, capacity: 32, additiveFog: 'three' });
  afterEach(() => { buckets.clear(); stretched.clear(); });

  it('groups particles by blend and keeps origin-independent buckets visible in the required order', () => {
    const program = compileProgram([
      'fx',
      'pop smoke burst=2 life=1 r=sprite(smoke-puff,alpha)',
      'pop sparks burst=1 life=1 r=sprite(ember,add)',
    ].join('\n'), {}, { low: false, mobile: false });
    const sim = createFxSimulation(program, { seed: 1, capacity: 16 });
    buckets.update([sim]);
    const alpha = buckets.get('alpha', 'world')!;
    const add = buckets.get('add', 'world')!;
    expect(alpha.count).toBe(2);
    expect(add.count).toBe(1);
    expect(alpha.frustumCulled).toBe(false);
    expect(add.frustumCulled).toBe(false);
    expect(alpha.renderOrder).toBeLessThan(add.renderOrder);
    expect(alpha.material.blending).toBe(NormalBlending);
    expect(add.material.blending).toBe(AdditiveBlending);
    sim.dispose();
  });

  it('applies the selected additive fog rule only to additive materials', () => {
    const fade = new FxSpriteBuckets({ world: root, atlas, capacity: 8, additiveFog: 'fade' });
    const program = compileProgram('fx\npop p burst=1 life=1 r=sprite(ember,add)', {}, { low: false, mobile: false });
    const sim = createFxSimulation(program, { seed: 2, capacity: 8 });
    fade.update([sim]);
    expect(fade.get('add', 'world')?.material.fog).toBe(false);
    fade.dispose();
    sim.dispose();
  });

  it('renders aligned sprite sinks through an instanced quad bucket', () => {
    const program = compileProgram('fx\npop streak burst=2 life=1 v=<0,2,0> r=sprite(ember,add,velocity,.2)', {}, { low: false, mobile: false });
    const sim = createFxSimulation(program, { seed: 9, capacity: 8 });
    stretched.update([sim]);
    const mesh = stretched.get('add') as InstancedMesh;
    expect(mesh).toBeDefined();
    expect(mesh.count).toBe(2);
    expect(mesh.frustumCulled).toBe(false);
    expect(mesh.renderOrder).toBeGreaterThan(buckets.get('alpha')?.renderOrder ?? 0);
    sim.dispose();
  });
});
