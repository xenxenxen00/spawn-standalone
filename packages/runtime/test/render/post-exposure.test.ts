// Opt-in scene gain before the output transform (`atmosphere.exposure`): what reaches the post chain, and PP's default.
import { describe, expect, it, vi } from 'vitest';

vi.mock('virtual:ss/vendor', () => ({ vendor: {} }));
import { worldPostOption } from '../../src/render/world/install.ts';
import { postExposure } from '../../src/render/post/render-pipeline.ts';
import { acesFilmic, srgbOETF } from '../../src/render/post/post-ref.ts';

describe('postExposure', () => {
  it('keeps a finite positive gain', () => {
    expect(postExposure(0.47)).toBe(0.47);
    expect(postExposure(2)).toBe(2);
  });
  it('negative: absent, 1, zero, negative or non-finite add no node (PP)', () => {
    for (const e of [undefined, 1, 0, -0.5, Number.NaN, Number.POSITIVE_INFINITY]) expect(postExposure(e)).toBeUndefined();
  });
});

describe('worldPostOption', () => {
  it('hands the gain to the post chain, whatever the atmosphere model', () => {
    expect(worldPostOption({ atmosphereOptions: { exposure: 0.47 } })).toEqual({ post: { exposure: 0.47 } });
  });
  it('negative: no options, or a neutral gain, give nothing', () => {
    expect(worldPostOption({})).toEqual({});
    expect(worldPostOption({ atmosphereOptions: {} })).toEqual({});
    expect(worldPostOption({ atmosphereOptions: { exposure: 1 } })).toEqual({});
  });
  it('the gain darkens a scene colour through the ACES output transform as three\'s toneMappingExposure does', () => {
    // Pip's sky plane colour (scripts/mat-skybloom-sky.js, bottom of the gradient): 0.47 brings it near the original's frame
    const sky = [0.2, 0.07, 0.27] as const;
    const at = (e: number) => srgbOETF(acesFilmic(sky.map((v) => v * e) as unknown as [number, number, number])).map((v) => Math.round(v * 255));
    expect(at(1)).toEqual(srgbOETF(acesFilmic(sky, 1)).map((v) => Math.round(v * 255)));
    expect(at(0.47)).toEqual(srgbOETF(acesFilmic(sky, 0.47)).map((v) => Math.round(v * 255)));
    expect(at(0.47)[0]!).toBeLessThan(at(1)[0]! * 0.75);
  });
});
