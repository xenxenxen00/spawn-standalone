import { afterEach, describe, expect, it } from 'vitest';
import { Matrix4, type WebGPURenderer } from 'three/webgpu';
import type { ColliderPack } from '../../../src/compat/core/ports.ts';
import { createAtmosphere } from '../../../src/render/atmosphere/atmosphere.ts';
import { NIGHT_SKY, starField } from '../../../src/render/atmosphere/sky.ts';
import { calibration, resetCalibration } from '../../../src/render/calibration.ts';
import { buildColliderIndex } from '../../../src/render/decals/collider-index.ts';
import { DecalWindow } from '../../../src/render/decals/window.ts';
import { clampAspect } from '../../../src/render/engine/canvas-host.ts';
import { isDynamicRow } from '../../../src/render/geometry/map-plan.ts';
import { enumerateVariants, variantContentFromIndex, type VariantContentInput } from '../../../src/render/models/shader-variants.ts';
import { createModelLoaders } from '../../../src/render/models/loaders.ts';
import { createGorePlugin } from '../../../src/render/plugins/gore.ts';
import { createRenderBudget } from '../../../src/render/perf/budget.ts';
import { createSceneRoot } from '../../../src/render/scene/scene-root.ts';
import { buildVisualProxies } from '../../../src/render/world/visual-proxies.ts';
import { DEFAULT_TEXT_STYLE, layoutPanel, parsePanelMarkup, resolveStyle } from '../../../src/render/special/world-panels.ts';
import { sampleScatterPoints } from '../../../src/render/special/scatter.ts';
afterEach(resetCalibration);
describe('generic release render behavior', () => {
  it('fills wide canvases unless an aspect range is supplied', () => {
    expect(clampAspect(3000, 1000)).toEqual({ x: 0, y: 0, width: 3000, height: 1000 });
    expect(clampAspect(3000, 1000, [0.5, 2])).toEqual({ x: 500, y: 0, width: 2000, height: 1000 });
  });
  it('does not infer model behavior from group names; explicit families choose variants', () => {
    const index = { entries: { body: { k: 'model', d: [] } }, groups: { 'enemy:arbitrary': { n: ['body'] } }, facts: { body: { skinned: true } } } as unknown as VariantContentInput['index'];
    const content = variantContentFromIndex({ index, shadows: false, multiDraw: true });
    const variants = enumerateVariants(content);
    expect(enumerateVariants({ families: [], shadows: false, multiDraw: true, extra: [] })).toEqual([]);
    expect(content.families[0]?.looks).toEqual([]);
    expect(variants.every((v) => v.kind === 'skinned' && v.layer === 0)).toBe(true);
    expect(new Set(variants.map((v) => v.boneClass))).toEqual(new Set([32, 64, 128]));
    const requested = enumerateVariants(variantContentFromIndex({ index, families: [{ id: 'custom', models: ['body'], boneClass: 64, baked: true, viewmodel: true, stage: 'map' }], shadows: true, multiDraw: true }));
    expect(requested.some((v) => v.kind === 'batched')).toBe(true);
    expect(requested.some((v) => v.layer === 1)).toBe(true);
    expect(requested.every((v) => v.stage === 'map')).toBe(true);
  });
  it('honors dynamic tags and collider exclusions only when injected', async () => {
    expect(isDynamicRow({ tags: ['door', 'ss-vm'] })).toBe(false);
    expect(isDynamicRow({ tags: ['hinged'] }, ['hinged'])).toBe(true);
    const m = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]);
    const pack: ColliderPack = { place: 'test', runtimeKeys: [], keys: [{ id: 'box', box: [1, 1, 1] }], instances: [{ rowId: 'test', key: 0, m, mutable: false, kinematic: false, noDecal: false }] };
    expect(buildColliderIndex(pack, () => ['bounds']).triangleCount).toBe(12);
    expect(buildColliderIndex(pack, () => ['private'], ['private']).triangleCount).toBe(0);
    const rows = [{ id: 'box', tags: ['bounds'], props: { primitive: { kind: 'box' } } }];
    const deps = { request: async () => { throw new Error('no generator'); }, world: () => new Matrix4().elements };
    expect((await buildVisualProxies(rows, deps)).instances).toHaveLength(1);
    expect((await buildVisualProxies(rows, { ...deps, ignoredTags: ['bounds'] })).instances).toHaveLength(0);
  });
  it('accepts a night palette and star count while its default has no game color', () => {
    expect(NIGHT_SKY).toEqual({ horizon: [0, 0, 0], zenith: [0, 0, 0] });
    const root = createSceneRoot();
    expect(root.lights.all.every((light) => light.intensity === 0)).toBe(true);
    expect(root.lights.shadowCaster).toBe(root.lights.shadowCaster);
    const atmosphere = createAtmosphere({ root, nightSky: { horizon: [0.1, 0.2, 0.3], zenith: [0.4, 0.5, 0.6], starCount: 0 } });
    atmosphere.load({ sky: { kind: 'realistic' }, stars: { enabled: true } });
    expect(atmosphere.state.sky.horizon).toEqual([0.1, 0.2, 0.3]);
    expect(atmosphere.state.sky.zenith).toEqual([0.4, 0.5, 0.6]);
    expect(starField(0)).toEqual([]);
    expect(starField(2000).length).toBeGreaterThan(1900);
    atmosphere.dispose(); root.dispose();
  });
  it('inherits injected panel faces and scatters no instances without a count', () => {
    const el = parsePanelMarkup('<div style="font-family:display"><span>hello</span></div>')!;
    expect(DEFAULT_TEXT_STYLE.fontFamily).toBe('sans-serif');
    expect(resolveStyle(el, DEFAULT_TEXT_STYLE).text.fontFamily).toBe('display');
    const layout = layoutPanel(el, { width: 1, height: 1, depth: 1 }, (text) => text.length * 8, { families: { display: 'serif' } });
    expect(layout?.runs[0]?.style.fontFamily).toBe('serif');
    const block = parsePanelMarkup('<div style="width:100px"><div style="font-family:display">hello</div></div>')!;
    expect(layoutPanel(block, { width: 1, height: 1, depth: 1 }, (text) => text.length * 8, { families: { display: 'serif' } })?.runs[0]?.style.fontFamily).toBe('serif');
    expect(sampleScatterPoints({ seed: 1, polygon: [[0, 0], [1, 0], [0, 1]], templates: [{ spec: { script: 'custom.js' }, weight: 1 }], heightAt: () => 0 })).toEqual([]);
  });
  it('reads live decal calibration and preserves the 600 second engine clamp', () => {
    calibration.decalWindow.max = 2; calibration.decalWindow.lifeS = 5;
    const ring = new DecalWindow<number>({ tier: 'high', mode: 'live', now: () => 0 });
    ring.add(1, 20); ring.add(2, 20); ring.add(3, 20);
    expect(ring.entries.map((entry) => entry.value)).toEqual([2, 3]);
    expect(ring.entries.every((entry) => entry.expires === 5)).toBe(true);
    calibration.decalWindow.max = 1; expect(ring.live).toBe(1);
    calibration.decalWindow.lifeS = 900;
    expect(ring.expiry(ring.add(4, 900))).toBe(600);
  });
  it('creates ordinary glTF loaders without fetching decoders', async () => {
    const loaders = await createModelLoaders({} as WebGPURenderer, {});
    expect(loaders.urls).toBeNull(); loaders.dispose();
  });
  it('requires explicit plugin limits; core tiers apply no gore profile', () => {
    const data = { corpses: 4, maxCorpses: 8, gibs: 10, slotVertices: 64, slotIndices: 192, corpseTag: 'remnant', gibTag: 'debris' };
    expect(typeof createGorePlugin(data)).toBe('function');
    expect(() => createGorePlugin({ ...data, slotVertices: 0 })).toThrow(RangeError);
    expect(() => createGorePlugin({ ...data, corpseTag: 'debris' })).toThrow(RangeError);
    expect(createRenderBudget('minimum').cap('gibs', 25)).toBe(25);
    expect(createRenderBudget('minimum', { minimum: { gibs: 7 } }).cap('gibs', 25)).toBe(7);
  });
});
