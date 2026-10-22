// K8 `screenFlash` (engine api-reference.md:668): defaults and the fade, as a state a UI chrome reads.
import { describe, expect, it } from 'vitest';
import { SCREEN_FLASH_DEFAULTS, ScreenFlash, screenFlashAlpha, screenFlashOf } from '../../../../src/render/special/screen-flash.ts';

describe('screenFlash payload', () => {
  it('takes the docs defaults: duration 0.15, intensity 0.35, white', () => {
    expect(screenFlashOf({})).toEqual({ color: [1, 1, 1], duration: 0.15, intensity: 0.35 });
    expect(screenFlashOf(undefined)).toEqual({ color: [1, 1, 1], duration: 0.15, intensity: 0.35 });
    expect(SCREEN_FLASH_DEFAULTS).toMatchObject({ duration: 0.15, intensity: 0.35 });
  });
  it('reads a colour (linear), a duration and an intensity clamped to 0..1', () => {
    const a = screenFlashOf({ color: '#ff0000', duration: 0.4, intensity: 3 });
    expect(a.intensity).toBe(1);
    expect(a.duration).toBe(0.4);
    expect(a.color[0]).toBeCloseTo(1, 6);
    expect(a.color[1]).toBeCloseTo(0, 6);
    expect(screenFlashOf({ color: 'nonsense' }).color).toEqual([1, 1, 1]);
  });
  it('fades linearly from intensity to nothing', () => {
    const a = screenFlashOf({ duration: 1, intensity: 0.5 });
    expect(screenFlashAlpha(a, 0)).toBe(0.5);
    expect(screenFlashAlpha(a, 0.5)).toBeCloseTo(0.25, 12);
    expect(screenFlashAlpha(a, 1)).toBe(0);
  });
});

describe('ScreenFlash', () => {
  it('runs for its duration of presentation time and then reports null; dt 0 holds it', () => {
    const seen: Array<number | null> = [];
    const f = new ScreenFlash((v) => seen.push(v === null ? null : v[3]));
    expect(f.rgba()).toBeNull();
    f.flash({ duration: 0.2, intensity: 0.4 });
    expect(f.active).toBe(true);
    f.update(0);
    expect(f.rgba()![3]).toBeCloseTo(0.4, 12);
    f.update(0.1);
    expect(f.rgba()![3]).toBeCloseTo(0.2, 12);
    f.update(0.1);
    expect(f.rgba()).toBeNull();
    expect(f.active).toBe(false);
    expect(seen.at(-1)).toBeNull();
  });
  it('a second flash replaces the first', () => {
    const f = new ScreenFlash();
    f.flash({ duration: 1, intensity: 0.2 });
    f.update(0.5);
    f.flash({ duration: 1, intensity: 0.9 });
    expect(f.rgba()![3]).toBeCloseTo(0.9, 12);
  });
});
