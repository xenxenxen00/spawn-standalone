import { describe, expect, it } from 'vitest';
import { asPlaceBundle } from '../../../src/compat/core/places/scene-loader.ts';

describe('place bundle module factories', () => {
  const bundle = () => ({ id: 'start', config: {}, rows: [] });

  it('accepts direct and default bundles, and calls a factory afresh on each load', () => {
    const direct = bundle();
    expect(asPlaceBundle(direct, 'start')).toBe(direct);
    expect(asPlaceBundle({ default: direct }, 'start')).toBe(direct);
    let calls = 0;
    const module = { default: () => { calls++; return bundle(); } };
    const first = asPlaceBundle(module, 'start');
    expect(asPlaceBundle(module, 'start')).not.toBe(first);
    expect(calls).toBe(2);
  });

  it('rejects malformed results and bundles for another place', () => {
    expect(() => asPlaceBundle({ default: () => null }, 'start')).toThrow('not a PlaceBundle');
    expect(() => asPlaceBundle({ default: () => ({ id: 'start', rows: [] }) }, 'start')).toThrow('not a PlaceBundle');
    expect(() => asPlaceBundle({ default: bundle }, 'other')).toThrow('holds the bundle of "start"');
  });
});
