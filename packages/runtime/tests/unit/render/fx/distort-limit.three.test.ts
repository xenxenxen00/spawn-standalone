// F3: fx `distort` sprites (relay-mother's haze and scream ring, `scripts/enemies/arch/relay-mother.js`) draw as screen
// offsets in the post pipeline's distort pass, not additively in the world. F4: the effect-limit warning is logged once per
// saturation, with the refusal count when an effect starts again.
import { describe, expect, it } from 'vitest';
import { DataTexture, InstancedMesh, Object3D, RGBAFormat, Scene, Sprite, UnsignedByteType } from 'three/webgpu';
import { createRenderBudget, type TierId } from '../../../../src/render/perf/budget.ts';
import { createFxSystem, type FxSystemOptions } from '../../../../src/render/fx/fx-system.ts';

const atlas = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, RGBAFormat, UnsignedByteType);
const HAZE = 'fx\npop haze burst=4 life=1 v=up(.3) size=.5 col=<.006,.004,0> a=1 r=sprite(soft-disc,distort)';
const STREAK = 'fx\npop streak burst=3 life=1 v=up(2) size=.1 col=<.01,.004,0> a=1 r=sprite(soft-disc,distort,velocity,.02)';

function system(overrides: Partial<FxSystemOptions> = {}, tier: TierId = 'high') {
  const world = new Scene();
  const camera = new Object3D();
  camera.position.set(1, 2, 3);
  camera.updateMatrixWorld(true);
  const fx = createFxSystem({ world, camera, atlas, budget: createRenderBudget(tier), ...overrides });
  return { world, camera, fx };
}
const names = (root: Object3D): string[] => {
  const out: string[] = [];
  root.traverse((o) => { if (o !== root) out.push(o.name); });
  return out;
};

describe('F3: fx distort sprites draw in the distort pass', () => {
  it('sit in the distort scene while they hold particles, never in the world, and leave it when empty', () => {
    const distort = new Scene();
    const { world, fx } = system({ distortScene: () => distort });
    const a = fx.emit({ script: HAZE }, [0, 1, 0])!;
    const b = fx.emit({ script: STREAK }, [0, 1, 0])!;
    fx.update({ dt: 0, now: 0 });
    expect(distort.children.map((o) => o.name).sort()).toEqual(['ss:fx:stretched:world:distort', 'ss:fx:world:distort']);
    expect((distort.children.find((o) => o.name === 'ss:fx:world:distort') as Sprite).count).toBe(4);
    expect((distort.children.find((o) => o.name === 'ss:fx:stretched:world:distort') as InstancedMesh).count).toBe(3);
    expect(names(world).filter((n) => n.includes('distort'))).toEqual([]);
    fx.end(a);
    fx.end(b);
    fx.update({ dt: 0, now: 0 });
    // an empty distort scene lets the pass skip its draw (render-pipeline `armDistortSkip`)
    expect(distort.children).toHaveLength(0);
    fx.dispose();
  });

  it('draw nowhere while the pipeline has no distort scene, and follow the scene when it changes', () => {
    let current: Scene | null = null;
    const { world, camera, fx } = system({ distortScene: () => current });
    fx.emit({ script: HAZE }, [0, 1, 0]);
    fx.update({ dt: 0, now: 0 });
    expect(names(world).filter((n) => n.includes('distort'))).toEqual([]);
    expect(names(camera).filter((n) => n.includes('distort'))).toEqual([]);
    const first = new Scene();
    current = first;
    fx.update({ dt: 0, now: 0 });
    expect(first.children.map((o) => o.name)).toEqual(['ss:fx:world:distort']);
    const second = new Scene();
    current = second;
    fx.update({ dt: 0, now: 0 });
    expect(first.children).toHaveLength(0);
    expect(second.children.map((o) => o.name)).toEqual(['ss:fx:world:distort']);
    fx.dispose();
    expect(second.children).toHaveLength(0);
  });

  it('a camera-following distort effect takes the camera matrix in the distort scene', () => {
    const distort = new Scene();
    const { camera, fx } = system({ distortScene: () => distort });
    fx.emit({ script: HAZE.replace(/^fx/, 'fx follow=camera') });
    fx.update({ dt: 0, now: 0 });
    const sprite = distort.children.find((o) => o.name === 'ss:fx:camera:distort')!;
    expect(sprite).toBeDefined();
    expect(sprite.matrixAutoUpdate).toBe(false);
    expect(sprite.matrix.equals(camera.matrixWorld)).toBe(true);
    fx.dispose();
  });

  it('on a tier without the distort pass nothing is drawn and the warm-up does not arm', () => {
    const distort = new Scene();
    const { world, fx } = system({ distortScene: () => distort }, 'low');
    fx.emit({ script: HAZE }, [0, 1, 0]);
    fx.update({ dt: 0, now: 0 });
    expect(distort.children).toHaveLength(0);
    expect(names(world).filter((n) => n.includes('distort'))).toEqual([]);
    expect(fx.armDistortWarm().armed).toBe(false);
    expect(distort.children).toHaveLength(0);
    fx.dispose();
  });

  it('arms one zero-offset stand-in per space and kind in the distort scene for the warm-up, and takes them out', () => {
    const distort = new Scene();
    const { fx } = system({ distortScene: () => distort });
    const arm = fx.armDistortWarm();
    expect(arm.armed).toBe(true);
    const armed = [...distort.children];
    expect(armed.map((o) => o.name).sort()).toEqual([
      'ss:warm-up:distort:ss:fx:camera:distort',
      'ss:warm-up:distort:ss:fx:stretched:camera:distort',
      'ss:warm-up:distort:ss:fx:stretched:world:distort',
      'ss:warm-up:distort:ss:fx:world:distort',
    ]);
    for (const o of armed) {
      expect(o.visible).toBe(true);
      expect((o as Sprite | InstancedMesh).count).toBe(1);
    }
    // nothing it draws covers the frame: the quad stand-ins have zero instance matrices
    const quad = armed.find((o) => o instanceof InstancedMesh) as InstancedMesh;
    expect(Array.from(quad.instanceMatrix.array as Float32Array).every((v) => v === 0)).toBe(true);
    arm.done();
    expect(distort.children).toHaveLength(0);
    // made once: a second warm-up arms the same stand-ins (their programs stay linked)
    const again = fx.armDistortWarm();
    expect([...distort.children].sort((x, y) => x.name.localeCompare(y.name))).toEqual(armed.sort((x, y) => x.name.localeCompare(y.name)));
    again.done();
    expect(system({}).fx.armDistortWarm().armed).toBe(false);
    fx.dispose();
  });
});

describe('F4: the fx effect-limit warning', () => {
  it('is logged once per saturation, with the refusal count when an effect starts again', () => {
    const logs: string[] = [];
    const { fx } = system({ maxEffects: 2, log: (m) => logs.push(m) });
    const held = { script: 'fx\npop glow n=1 r=sprite(soft-disc,add)' };
    const first = fx.emit(held)!;
    expect(fx.emit(held)).not.toBeNull();
    for (let i = 0; i < 5; i++) expect(fx.emit(held)).toBeNull();
    const limit = (): string[] => logs.filter((m) => m.includes('effect limit'));
    expect(limit()).toEqual(['[fx] fx effect limit (2) reached; further refusals are counted until an effect starts again']);
    fx.end(first);
    expect(fx.emit(held)).not.toBeNull();
    expect(limit()).toHaveLength(2);
    expect(limit()[1]).toBe('[fx] fx effect limit (2): 5 effects refused while full');
    // a new saturation warns again
    expect(fx.emit(held)).toBeNull();
    expect(limit()).toHaveLength(3);
    expect(limit()[2]).toContain('reached');
    fx.dispose();
  });
});
