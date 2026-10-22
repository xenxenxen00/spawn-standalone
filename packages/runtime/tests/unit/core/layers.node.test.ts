// Layered values (docs/design/core-runtime.md §5.5, §16.1 `layers.test.ts`; contract §4.3, AGENTS.md:53-54): reads compose like a
// prototype chain, writes land in the own layer, `delete` reveals the layer below; a root assignment replaces, a leaf
// assignment merges. The live write patterns are scripts/map/power.js:88-92 (leaf writes under ambient / hemisphere) and
// scripts/gen/fallout-acre/nuke.js:20-22 (a whole `fog` replaced and restored).
import { describe, expect, it, vi } from 'vitest';
import { LayeredValueImpl } from '../../../src/compat/core/store/layers.ts';

// places/gallow-farm/config.yaml atmosphere (abridged)
const gallowFarm = (): Record<string, unknown> => ({
  sky: { kind: 'gradient', horizon: 'oklch(0.36 0.1 48)', zenith: 'oklch(0.06 0.01 40)' },
  fog: { kind: 'exp2', color: 'oklch(0.22 0.05 45)', density: 0.011, near: 2 },
  ambient: { light: { color: 'oklch(0.78 0.05 55)', intensity: 0.65 } },
  hemisphere: { skyColor: 'oklch(0.6 0.1 45)', groundColor: 'oklch(0.3 0.03 40)', intensity: 0.4 },
  wet: 0.3,
  wind: { direction: 70, speed: 3 },
  look: { script: 'scripts/looks/kf2-mix.js', params: { bloomStrength: 0.6, exposure: 1.08 } },
});
const HAZE = { kind: 'exp2', color: 'oklch(0.5 0.1 112)', density: 0.0125 };
const DUSK = { kind: 'exp2', color: 'oklch(0.44 0.07 92)', density: 0.0085 };

describe('LayeredValue: composition', () => {
  it('reads the base when nothing is written, without copying or mutating it', () => {
    const base = gallowFarm();
    const lv = new LayeredValueImpl(() => base);
    expect(lv.read()).toEqual(gallowFarm());
    lv.set(['wet'], 0.9);
    expect(base).toEqual(gallowFarm());
  });

  it('a leaf write merges: only that leaf changes, its siblings keep the base', () => {
    const lv = new LayeredValueImpl(gallowFarm);
    lv.set(['ambient', 'light', 'intensity'], 0.2);
    expect(lv.read().ambient).toEqual({ light: { color: 'oklch(0.78 0.05 55)', intensity: 0.2 } });
    expect(lv.read().hemisphere).toEqual(gallowFarm().hemisphere);
  });

  it('assigning a key replaces the value under it (nuke.js `fog = HAZE` drops the base `near`)', () => {
    const lv = new LayeredValueImpl(gallowFarm);
    lv.set(['fog'], HAZE);
    expect(lv.read().fog).toEqual(HAZE);
    lv.set(['fog'], DUSK);
    expect(lv.read().fog).toEqual(DUSK);
  });

  it('delete reveals the layer below', () => {
    const lv = new LayeredValueImpl(gallowFarm);
    lv.set(['fog'], HAZE);
    lv.set(['ambient', 'light', 'intensity'], 0.2);
    lv.delete(['fog']);
    expect(lv.read().fog).toEqual(gallowFarm().fog);
    lv.delete(['ambient', 'light', 'intensity']);
    expect(lv.read().ambient).toEqual(gallowFarm().ambient);
    expect(lv.read()).toEqual(gallowFarm());
  });

  it('delete removes own-layer values only (a key only the base has stays, as on a prototype chain)', () => {
    const lv = new LayeredValueImpl(gallowFarm);
    lv.delete(['fog']);
    lv.delete(['wind', 'speed']);
    expect(lv.read()).toEqual(gallowFarm());
  });

  it('delete inside an own replaced value edits that value', () => {
    const lv = new LayeredValueImpl(gallowFarm);
    lv.set(['fog'], HAZE);
    lv.delete(['fog', 'density']);
    expect(lv.read().fog).toEqual({ kind: 'exp2', color: 'oklch(0.5 0.1 112)' });
  });

  it('a write below an own replaced value edits that value (it does not reach for the base)', () => {
    const lv = new LayeredValueImpl(gallowFarm);
    lv.set(['fog'], HAZE);
    lv.set(['fog', 'near'], 5);
    expect(lv.read().fog).toEqual({ ...HAZE, near: 5 });
  });

  it('a root assignment replaces everything; deleting the root reveals the base', () => {
    const lv = new LayeredValueImpl(gallowFarm);
    lv.set(['wet'], 1);
    lv.set([], { rain: 1 });
    expect(lv.read()).toEqual({ rain: 1 });
    lv.set(['wind'], { speed: 1 });
    expect(lv.read()).toEqual({ rain: 1, wind: { speed: 1 } });
    lv.delete([]);
    expect(lv.read()).toEqual(gallowFarm());
  });

  it('stores copies: mutating the assigned object later changes nothing', () => {
    const lv = new LayeredValueImpl(gallowFarm);
    const haze = { ...HAZE };
    lv.set(['fog'], haze);
    haze.density = 1;
    expect(lv.read().fog).toEqual(HAZE);
  });

  it('memoises the composed snapshot until the next write (the base hands out one object, as compiled JSON does)', () => {
    const base = gallowFarm();
    const lv = new LayeredValueImpl(() => base);
    const a = lv.read();
    expect(lv.read()).toBe(a);
    lv.set(['wet'], 0.5);
    const b = lv.read();
    expect(b).not.toBe(a);
    expect(lv.read()).toBe(b);
  });

  it('layers chain: an upper layer composes over a lower layer and sees the lower layer change', () => {
    const def = new LayeredValueImpl(() => ({ fov: 58.7, pointerLock: true, orientation: { source: 'look' } }));
    const rig = new LayeredValueImpl(() => def.read());
    rig.set(['fov'], 70);
    expect(rig.read()).toEqual({ fov: 70, pointerLock: true, orientation: { source: 'look' } });
    def.set(['pointerLock'], false);
    expect(rig.read().pointerLock).toBe(false);
    rig.delete(['fov']);
    def.set(['fov'], 60);
    expect(rig.read().fov).toBe(60);
  });

  it('onChange reports the composed value and the written path; unsubscribe stops it', () => {
    const lv = new LayeredValueImpl(gallowFarm);
    const seen: Array<[unknown, readonly string[]]> = [];
    const off = lv.onChange((composed, path) => seen.push([(composed.fog as { density: number }).density, [...path]]));
    lv.set(['fog'], HAZE);
    lv.delete(['fog']);
    off();
    lv.set(['fog'], DUSK);
    expect(seen).toEqual([
      [0.0125, ['fog']],
      [0.011, ['fog']],
    ]);
  });

  it('a throwing subscriber is reported and the write still lands', () => {
    const lv = new LayeredValueImpl(gallowFarm);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const after = vi.fn();
    lv.onChange(() => {
      throw new Error('boom');
    });
    lv.onChange(after);
    lv.set(['wet'], 0);
    expect(lv.read().wet).toBe(0);
    expect(after).toHaveBeenCalledTimes(1);
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });
});

describe('LayeredValue: the write-through proxy (ctx.place.atmosphere)', () => {
  it('power.js: nested leaf writes through the proxy merge into the own layer', () => {
    const lv = new LayeredValueImpl(gallowFarm);
    const a = lv.proxy() as Record<string, any>;
    // scripts/map/power.js:88-92
    const f = 0.25;
    if (a.ambient && a.ambient.light) a.ambient.light.intensity = 0.65 * f;
    if (a.hemisphere) a.hemisphere.intensity = 0.4 * f;
    expect(a.ambient.light.intensity).toBeCloseTo(0.1625, 12);
    expect(lv.read().ambient).toEqual({ light: { color: 'oklch(0.78 0.05 55)', intensity: 0.1625 } });
    expect(lv.read().hemisphere).toEqual({ skyColor: 'oklch(0.6 0.1 45)', groundColor: 'oklch(0.3 0.03 40)', intensity: 0.1 });
  });

  it('nuke.js: a whole fog assigned through the proxy, then the dusk restored', () => {
    const lv = new LayeredValueImpl(gallowFarm);
    const a = lv.proxy() as Record<string, any>;
    a.fog = HAZE;
    expect(a.fog.density).toBe(0.0125);
    expect(a.fog.near).toBe(undefined);
    a.fog = DUSK;
    expect(lv.read().fog).toEqual(DUSK);
  });

  it('delete through the proxy reveals the base', () => {
    const lv = new LayeredValueImpl(gallowFarm);
    const a = lv.proxy() as Record<string, any>;
    a.fog = HAZE;
    delete a.fog;
    expect(a.fog.near).toBe(2);
  });

  it('behaves like plain data: keys, in, spread, JSON, arrays', () => {
    const lv = new LayeredValueImpl(() => ({ ...gallowFarm(), stops: [1, 2, 3] }));
    const a = lv.proxy() as Record<string, any>;
    expect(Object.keys(a)).toEqual(['sky', 'fog', 'ambient', 'hemisphere', 'wet', 'wind', 'look', 'stops']);
    expect('fog' in a).toBe(true);
    expect('rain' in a).toBe(false);
    expect({ ...a.wind }).toEqual({ direction: 70, speed: 3 });
    expect(JSON.parse(JSON.stringify(a))).toEqual({ ...gallowFarm(), stops: [1, 2, 3] });
    expect(Array.isArray(a.stops)).toBe(true);
    expect(a.stops.length).toBe(3);
    expect([...a.stops]).toEqual([1, 2, 3]);
    a.stops[1] = 20;
    expect(lv.read().stops).toEqual([1, 20, 3]);
  });

  it('gives the same nested proxy for the same path', () => {
    const lv = new LayeredValueImpl(gallowFarm);
    const a = lv.proxy() as Record<string, any>;
    expect(a.ambient).toBe(a.ambient);
    expect(lv.proxy()).toBe(a);
  });

  it('a read-only proxy ignores writes and deletes', () => {
    const lv = new LayeredValueImpl(gallowFarm);
    const ro = lv.proxy({ readonly: true }) as Record<string, any>;
    ro.fog = HAZE;
    ro.ambient.light.intensity = 0;
    delete ro.wet;
    expect(lv.read()).toEqual(gallowFarm());
  });
});
