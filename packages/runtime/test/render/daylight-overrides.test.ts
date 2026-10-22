// Daylight overrides (opt-in, createRenderer atmosphere options): sky tint and saturation on the derived sky, and a pinned
// sun. Without them the model is unchanged; a sky the config names is never tinted.
import { describe, expect, it, vi } from 'vitest';

vi.mock('virtual:ss/vendor', () => ({ vendor: {} }));
import { daylightFor } from '../../src/render/atmosphere/daylight.ts';
import { worldAtmosphereOption } from '../../src/render/world/install.ts';

const cfg = { timeOfDay: 16.3, sky: { kind: 'realistic', model: 'hosek' } };
const deg = (v: number): number => (v * 180) / Math.PI;

describe('daylight overrides', () => {
  it('negative: no overrides (and an empty object) give the same state as before', () => {
    expect(daylightFor(cfg, undefined, {})).toEqual(daylightFor(cfg));
  });
  it('skyTint multiplies the derived zenith and horizon (and the fill made from them); a named sky is untouched', () => {
    const base = daylightFor(cfg);
    const t = daylightFor(cfg, undefined, { skyTint: [1.2, 0.8, 1.1] });
    expect(t.zenith[0]).toBeCloseTo(base.zenith[0] * 1.2, 6);
    expect(t.horizon[1]).toBeCloseTo(base.horizon[1] * 0.8, 6);
    expect(t.hemisphere.sky[2]).toBeCloseTo(base.hemisphere.sky[2] * 1.1, 6);
    const named = { ...cfg, sky: { top: 'oklch(0.5 0.1 300)', bottom: 'oklch(0.8 0.05 330)' } };
    expect(daylightFor(named, undefined, { skyTint: [2, 2, 2] }).zenith).toEqual(daylightFor(named).zenith);
  });
  it('skySaturation keeps the luminance and widens the channel spread', () => {
    const base = daylightFor(cfg).horizon;
    const s = daylightFor(cfg, undefined, { skySaturation: 1.5 }).horizon;
    const lum = (c: readonly number[]): number => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
    expect(lum(s)).toBeCloseTo(lum(base), 6);
    expect(Math.max(...s) - Math.min(...s)).toBeGreaterThan(Math.max(...base) - Math.min(...base));
  });
  it('sunAzimuth / sunElevation pin the sun; one alone keeps the other from the hour', () => {
    const d = daylightFor(cfg, undefined, { sunAzimuth: 90, sunElevation: 35 }).sunDirection;
    expect(deg(Math.asin(d[1]))).toBeCloseTo(35, 6);
    expect(deg(Math.atan2(d[0], d[2]))).toBeCloseTo(90, 6);
    const base = daylightFor(cfg).sunDirection;
    const el = daylightFor(cfg, undefined, { sunElevation: 50 }).sunDirection;
    expect(deg(Math.asin(el[1]))).toBeCloseTo(50, 6);
    expect(Math.atan2(el[0], el[2])).toBeCloseTo(Math.atan2(base[0], base[2]), 6);
  });
  it('worldAtmosphereOption hands them on as `daylight`, only when given', () => {
    expect(worldAtmosphereOption({ atmosphereOptions: { model: 'daylight', skyTint: [1, 0.9, 1], sunElevation: 30 } })).toEqual({ atmosphere: { model: 'daylight', daylight: { skyTint: [1, 0.9, 1], sunElevation: 30 } } });
    expect(worldAtmosphereOption({ atmosphereOptions: { model: 'daylight' } })).toEqual({ atmosphere: { model: 'daylight' } });
  });
});
