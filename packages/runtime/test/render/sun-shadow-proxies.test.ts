// K14 sun shadow: the batched map rows cast only through their layer-2 shadow proxies, so the sun's shadow camera must see
// layer 2, and the proxies must exist on a tier without a shadowCaster shadow. PP (no sun shadow) is unchanged.
import { describe, expect, it } from 'vitest';
import { castsProxies } from '../../src/render/geometry/map-batcher.ts';
import { LAYER_SHADOW_PROXY, LAYER_THIRD_PERSON_ONLY, LAYER_WORLD, createSceneRoot } from '../../src/render/scene/scene-root.ts';

describe('sun shadow camera layers', () => {
  it('the sun slot (0 or 1) sees the world, the third-person rows and the shadow proxies', () => {
    for (const slot of [0, 1] as const) {
      const cam = createSceneRoot({ sunShadow: { slot } }).lights.directionals[slot].shadow.camera;
      expect(cam.layers.isEnabled(LAYER_WORLD)).toBe(true);
      expect(cam.layers.isEnabled(LAYER_THIRD_PERSON_ONLY)).toBe(true);
      expect(cam.layers.isEnabled(LAYER_SHADOW_PROXY)).toBe(true);
    }
  });
  it('negative: without a sun shadow (PP) both moons keep the default mask and cast nothing', () => {
    const root = createSceneRoot();
    for (const moon of root.lights.directionals) {
      expect(moon.castShadow).toBe(false);
      expect(moon.shadow.camera.layers.mask).toBe(1);
    }
    // the other slot of a sun-shadow root is untouched too
    expect(createSceneRoot({ sunShadow: true }).lights.directionals[1].shadow.camera.layers.mask).toBe(1);
  });
});

describe('castsProxies', () => {
  it('a sun shadow builds proxies on a tier without a shadowCaster shadow', () => {
    expect(castsProxies({ shadowCasterMapSize: 0, sunShadow: true })).toBe(true);
    expect(castsProxies({ shadowCasterMapSize: 512, sunShadow: true })).toBe(true);
  });
  it("negative: PP's rule without a sun shadow", () => {
    expect(castsProxies({ shadowCasterMapSize: 0 })).toBe(false);
    expect(castsProxies({ shadowCasterMapSize: 0, sunShadow: false })).toBe(false);
    expect(castsProxies({ shadowCasterMapSize: 1024 })).toBe(true);
  });
});
