// spatial (io §2.6): the Web Audio linear law, payload distances and their defaults, panner set-up per tier, listener sync.
import { describe, expect, it } from 'vitest';
import { DEFAULT_MAX_DISTANCE, DEFAULT_REF_DISTANCE } from '../../../src/runtime/audio/limits.ts';
import { applyListener, distanceParams, linearGain, makePanner, panningModelFor } from '../../../src/runtime/audio/spatial.ts';
import { FakeAudioContext } from './fake-context.ts';

describe('linearGain', () => {
  it('is 1 inside refDistance, falls linearly, is 0 at and beyond maxDistance', () => {
    expect(linearGain(0, 3, 45)).toBe(1);
    expect(linearGain(3, 3, 45)).toBe(1);
    expect(linearGain(24, 3, 45)).toBeCloseTo(0.5, 12);
    expect(linearGain(45, 3, 45)).toBe(0);
    expect(linearGain(400, 3, 45)).toBe(0);
    // g(d) = 1 - (clamp(d, ref, max) - ref) / (max - ref)
    for (const [d, ref, max] of [
      [10, 6, 48.4],
      [50, 48, 160],
      [80, 224, 416],
    ] as const) {
      const c = Math.min(Math.max(d, ref), max);
      expect(linearGain(d, ref, max)).toBeCloseTo(1 - (c - ref) / (max - ref), 12);
    }
  });

  it('applies the max ≥ ref + 0.01 floor', () => {
    expect(linearGain(10, 10, 4)).toBe(1);
    expect(linearGain(10.005, 10, 4)).toBeCloseTo(0.5, 9);
    expect(linearGain(10.01, 10, 4)).toBe(0);
  });
});

describe('distanceParams', () => {
  it('defaults ref 3 / max 45 (audio.yml:38 root defaults), payload values pass, bad values fall back', () => {
    expect([DEFAULT_REF_DISTANCE, DEFAULT_MAX_DISTANCE]).toEqual([3, 45]);
    expect(distanceParams({})).toEqual({ ref: 3, max: 45 });
    expect(distanceParams({ maxDistance: 400 })).toEqual({ ref: 3, max: 400 });
    expect(distanceParams({ refDistance: 6, maxDistance: 48.4 })).toEqual({ ref: 6, max: 48.4 });
    expect(distanceParams({ refDistance: 10, maxDistance: 4 })).toEqual({ ref: 10, max: 10.01 });
    expect(distanceParams({ refDistance: Number.NaN, maxDistance: -1 })).toEqual({ ref: 3, max: 45 });
  });
});

describe('panner', () => {
  it('is linear, rolloff 1, omnidirectional, with the tier panning model', () => {
    const ctx = new FakeAudioContext();
    const p = makePanner(ctx, 6, 48.4, 'high');
    expect(p.distanceModel).toBe('linear');
    expect(p.rolloffFactor).toBe(1);
    expect([p.refDistance, p.maxDistance]).toEqual([6, 48.4]);
    expect([p.coneInnerAngle, p.coneOuterAngle]).toEqual([360, 360]);
    expect(p.panningModel).toBe('HRTF');
    expect(panningModelFor('medium')).toBe('HRTF');
    expect(panningModelFor('low')).toBe('equalpower');
  });

  it('the listener follows the presented eye, forward and up', () => {
    const ctx = new FakeAudioContext();
    ctx.currentTime = 4;
    applyListener(ctx.listener, { eye: { x: 1, y: 1.6, z: -2 }, forward: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } }, 4);
    const l = ctx.listener;
    expect([l.positionX.value, l.positionY.value, l.positionZ.value]).toEqual([1, 1.6, -2]);
    expect([l.forwardX.value, l.forwardY.value, l.forwardZ.value]).toEqual([0, 0, 1]);
    expect([l.upX.value, l.upY.value, l.upZ.value]).toEqual([0, 1, 0]);
    expect(l.positionX.last()).toEqual({ type: 'set', value: 1, time: 4 });
  });
});
