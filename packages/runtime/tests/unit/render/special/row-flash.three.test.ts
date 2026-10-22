// K8 `flash` (engine api-reference.md:674) on a real R6 model instance (the fixture GLB of the model tests) and a fake bridge
// node view: payload defaults, the mix curve, the overlay's place in the scene graph, its end, and the negative control (a row
// that is not flashed gets no overlay).
import { CustomBlending, LessEqualDepth, Mesh, Object3D, SkinnedMesh } from 'three/webgpu';
import { beforeAll, describe, expect, it } from 'vitest';
import type { RowNodeView } from '../../../../src/render/bridge/bridge-types.ts';
import { ModelInstance } from '../../../../src/render/models/model-instance.ts';
import { buildModelTemplate, modelSourceFromGltf, type ModelTemplate } from '../../../../src/render/models/model-template.ts';
import { FLASH_DEFAULTS, FLASH_KEY, RowFlasher, flashActOf, flashMix } from '../../../../src/render/special/row-flash.ts';
import { FIXTURE_FACTS, fixtureGlb, parseGlb, testEnv, type TestEnv } from '../models/model-fixtures.ts';

let env: TestEnv;
let template: ModelTemplate;

beforeAll(async () => {
  env = testEnv();
  template = buildModelTemplate(modelSourceFromGltf('value.00f1c5.glb', await parseGlb(await fixtureGlb()), FIXTURE_FACTS), env);
});

function scene() {
  const rows = new Map<string, { object: Object3D; model: ModelInstance | null }>();
  const view = (id: string): RowNodeView | undefined => {
    const r = rows.get(id);
    return r === undefined ? undefined : { id, object: r.object, model: r.model, world: r.object.matrixWorld.elements, visible: true };
  };
  const flasher = new RowFlasher({ node: view, look: env.look });
  const add = (id: string): ModelInstance => {
    const object = new Object3D();
    const model = new ModelInstance(template, env.look);
    object.add(model.root);
    rows.set(id, { object, model });
    return model;
  };
  return { flasher, add, rows };
}

describe('flash payload', () => {
  it('takes the docs defaults: duration 0.1, intensity 0.9, white', () => {
    const a = flashActOf({ target: 'p1' })!;
    expect(a.duration).toBe(0.1);
    expect(a.intensity).toBe(0.9);
    expect([a.color.r, a.color.g, a.color.b]).toEqual([1, 1, 1]);
    expect(FLASH_DEFAULTS).toMatchObject({ duration: 0.1, intensity: 0.9 });
  });
  it('reads colour, duration and intensity, and refuses a payload without a target', () => {
    const a = flashActOf({ target: 'p1', color: '#ff0000', duration: 0.5, intensity: 0.3 })!;
    expect(a.duration).toBe(0.5);
    expect(a.intensity).toBe(0.3);
    expect(a.color.r).toBeCloseTo(1, 6);
    expect(a.color.g).toBeCloseTo(0, 6);
    expect(flashActOf({ color: '#fff' })).toBeNull();
    expect(flashActOf('x')).toBeNull();
  });
  it('fades the mix linearly from intensity to nothing', () => {
    const a = flashActOf({ target: 'p', duration: 1, intensity: 0.8 })!;
    expect(flashMix(a, 0)).toBe(0.8);
    expect(flashMix(a, 0.5)).toBeCloseTo(0.4, 12);
    expect(flashMix(a, 1)).toBe(0);
  });
});

describe('RowFlasher', () => {
  it('lays an overlay of the same geometry beside the body, mixes it, and takes it off at the end', () => {
    const s = scene();
    const model = s.add('a');
    s.add('b');
    const source = model.opaqueMesh as Mesh | SkinnedMesh;
    expect(s.flasher.flash({ target: 'a', color: '#ff2020', duration: 0.2, intensity: 0.8 })).toBe(true);
    s.flasher.update(0);
    const o = s.flasher.overlayOf('a')!;
    expect(o).not.toBeNull();
    expect(o.parent).toBe(source.parent);
    expect(o.geometry).toBe(source.geometry);
    expect((o as SkinnedMesh).isSkinnedMesh === true).toBe((source as SkinnedMesh).isSkinnedMesh === true);
    expect(o.userData[FLASH_KEY].mix).toBeCloseTo(0.8, 12);
    const m = o.material as Mesh['material'] & { depthFunc: number; blending: number; depthWrite: boolean };
    expect(m.depthFunc).toBe(LessEqualDepth);
    expect(m.blending).toBe(CustomBlending);
    expect(m.depthWrite).toBe(false);
    s.flasher.update(0.1);
    expect(o.userData[FLASH_KEY].mix).toBeCloseTo(0.4, 12);
    // negative control: the other row has no overlay
    expect(s.flasher.overlayOf('b')).toBeNull();
    s.flasher.update(0.2);
    expect(o.parent).toBeNull();
    expect(s.flasher.active).toBe(0);
  });

  it('a second flash restarts the running one on the same overlay', () => {
    const s = scene();
    s.add('a');
    s.flasher.flash({ target: 'a', duration: 0.2, intensity: 0.5 });
    s.flasher.update(0.1);
    const o = s.flasher.overlayOf('a');
    s.flasher.flash({ target: 'a', duration: 0.2, intensity: 0.9 });
    s.flasher.update(0);
    expect(s.flasher.overlayOf('a')).toBe(o);
    expect(o!.userData[FLASH_KEY].mix).toBeCloseTo(0.9, 12);
  });

  it('waits for a row with no model and runs out unseen', () => {
    const s = scene();
    s.flasher.flash({ target: 'nobody', duration: 0.1 });
    s.flasher.update(0.05);
    expect(s.flasher.overlayOf('nobody')).toBeNull();
    expect(s.flasher.active).toBe(1);
    s.flasher.update(0.1);
    expect(s.flasher.active).toBe(0);
  });

  it('has stand-ins for the warm-up and disposes cleanly', () => {
    const s = scene();
    const w = s.flasher.warmObjects();
    expect(w.length).toBeGreaterThan(2);
    expect(w.every((o) => (o as Mesh).material === s.flasher.material)).toBe(true);
    s.flasher.dispose();
    expect(s.flasher.warmObjects()).toEqual([]);
    expect(s.flasher.flash({ target: 'a' })).toBe(false);
  });
});
