import { afterEach, describe, expect, it } from 'vitest';
import { calibration, resetCalibration } from '../../../../src/render/calibration.ts';
afterEach(resetCalibration);
import { createDecalWindow } from '../../../../src/render/decals/window.ts';

describe('decal window', () => {
  it('retains 2,048 decals in uncapped mode and evicts the oldest as capacity is reached', () => {
    let now = 0;
    const ring = createDecalWindow({ mode: 'uncapped', tier: 'high', now: () => now });
    for (let i = 0; i < 2_049; i++) ring.add(i, 10);

    expect(ring.live).toBe(2_048);
    expect(ring.has(0)).toBe(false);
    expect(ring.has(1)).toBe(true);
  });

  it('keeps the live 256 window, clamps expiry to 600 seconds, and expires old marks', () => {
    let now = 0;
    calibration.decalWindow.max = 256;
    const ring = createDecalWindow({ mode: 'live', tier: 'high', now: () => now });
    for (let i = 0; i < 257; i++) ring.add(i, 1_200);

    expect(ring.live).toBe(256);
    expect(ring.has(0)).toBe(false);
    expect(ring.expiry(1)).toBe(600);
    now = 600;
    expect(ring.live).toBe(0);
  });

  it('trims immediately when the active render tier drops', () => {
    let tier: 'high' | 'minimum' = 'high';
    const ring = createDecalWindow({ mode: 'uncapped', tier: () => tier, now: () => 0 });
    for (let i = 0; i < 600; i++) ring.add(i, 60);
    expect(ring.live).toBe(600);

    tier = 'minimum';
    expect(ring.capacity).toBe(512);
    expect(ring.live).toBe(512);
    expect(ring.get(0)).toBeUndefined();
    expect(ring.get(88)).toBe(88);
  });
});
