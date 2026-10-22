import { describe, expect, it } from 'vitest';
import { createAudioEngine } from '../../../src/runtime/audio/audio-engine.ts';
import type { AudioEngineOptions } from '../../../src/runtime/audio/types.ts';
import { distanceParams } from '../../../src/runtime/audio/spatial.ts';
import { MANIFEST, META, readyEngine } from './helpers.ts';
import { settle } from './fake-context.ts';

describe('host audio capacity', () => {
  it('honours per-clip and pool limits independently, with the existing refusal and stealing rules', async () => {
    const { engine, ctx } = await readyEngine({ voicePoolSize: 4, perClipCap: 2 });
    for (let i = 0; i < 3; i++) engine.playSound(`a-${i}`, { clip: 'sfx-a.mp3', priority: 10 }, META);
    expect(engine.stats()).toMatchObject({ voices: 2, refusedPerClip: 1, refusedPool: 0 });
    for (let i = 0; i < 2; i++) engine.playSound(`b-${i}`, { clip: 'sfx-b.mp3', priority: 10 }, META);
    const oldest = ctx.voiceSources()[0]!;
    engine.playSound('refused', { clip: 'loop.mp3', priority: 10 }, META);
    expect(engine.stats()).toMatchObject({ voices: 4, refusedPerClip: 1, refusedPool: 1, stolen: 0 });
    engine.playSound('priority', { clip: 'loop.mp3', priority: 95 }, META);
    expect(engine.stats()).toMatchObject({ voices: 4, stolen: 1 }); expect(oldest.stopped).not.toBeNull();
    engine.dispose();
  });

  it('keeps calibrated limits when omitted and applies each override alone', async () => {
    for (const [options, voices, refusedPerClip, refusedPool] of [
      [{}, 3, 0, 0],
      [{ perClipCap: 2 }, 2, 1, 0],
      [{ voicePoolSize: 2 }, 2, 0, 1],
    ] as const) {
      const { engine } = await readyEngine(options);
      for (let i = 0; i < 3; i++) engine.playSound(`sound-${i}`, { clip: 'sfx-a.mp3' }, META);
      expect(engine.stats()).toMatchObject({ voices, refusedPerClip, refusedPool }); engine.dispose();
    }
  });

  it('rejects invalid caps before initialization changes state and allows a corrected retry', () => {
    for (const key of ['voicePoolSize', 'perClipCap'] as const) {
      for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, null, '2', true]) {
        const engine = createAudioEngine();
        expect(() => engine.init({ manifest: MANIFEST, tier: 'high', [key]: value } as never)).toThrow(key);
        expect(engine.registry).toBeNull(); expect(engine.tier).toBeNull(); expect(engine.context()).toBeNull();
        expect(() => engine.init({ manifest: MANIFEST, tier: 'high', [key]: 2 })).not.toThrow();
        expect(engine.registry).not.toBeNull(); engine.dispose();
      }
    }
  });
});

describe('host audio spatial defaults', () => {
  it('uses valid payload values before host values, then calibrated values and the minimum span', () => {
    expect(distanceParams({}, { refDistance: 7, maxDistance: 90 })).toEqual({ ref: 7, max: 90 });
    expect(distanceParams({ refDistance: 2, maxDistance: 8 }, { refDistance: 7, maxDistance: 90 })).toEqual({ ref: 2, max: 8 });
    expect(distanceParams({ refDistance: NaN, maxDistance: -1 }, { refDistance: 7, maxDistance: 90 })).toEqual({ ref: 7, max: 90 });
    expect(distanceParams({}, { refDistance: Infinity, maxDistance: -1 })).toEqual({ ref: 3, max: 45 });
    expect(distanceParams({ refDistance: 0, maxDistance: 0 }, { refDistance: 7, maxDistance: 90 })).toEqual({ ref: 0, max: 0.01 });
    expect(distanceParams({ refDistance: 100 }, { maxDistance: 5 })).toEqual({ ref: 100, max: 100.01 });
  });

  it('forwards one-shot defaults to panners while explicit payload distances win', async () => {
    const { engine, ctx } = await readyEngine({ defaultRefDistance: 7, defaultMaxDistance: 90 });
    const position = { x: 1, y: 2, z: 3 };
    engine.playSound('default', { clip: 'sfx-a.mp3', position }, META);
    engine.playSound('explicit', { clip: 'sfx-a.mp3', position, refDistance: 2, maxDistance: 8 }, META);
    engine.playSound('invalid', { clip: 'sfx-a.mp3', position, refDistance: NaN, maxDistance: -1 }, META);
    expect(ctx.panners().map(p => [p.refDistance, p.maxDistance])).toEqual([[7, 90], [2, 8], [7, 90]]); engine.dispose();
  });

  it('forwards separate entity defaults and uses the entity maxDistance when supplied', async () => {
    const { engine, ctx } = await readyEngine({ defaultRefDistance: 7, defaultMaxDistance: 90, defaultEntityRefDistance: 4, defaultEntityMaxDistance: 70 });
    const a = engine.createEntityAudio('default', { clip: 'loop.mp3', loop: true, spatial: true });
    const b = engine.createEntityAudio('explicit', { clip: 'loop.mp3', loop: true, spatial: true, maxDistance: 9 });
    await settle();
    expect(ctx.panners().map(p => [p.refDistance, p.maxDistance])).toEqual([[4, 70], [4, 9]]);
    b.update({ clip: 'loop.mp3', loop: true, spatial: true, maxDistance: -1 }, null);
    expect([ctx.panners().at(-1)!.refDistance, ctx.panners().at(-1)!.maxDistance]).toEqual([4, 70]);
    a.stop(); b.stop(); engine.dispose();
  });

  it('retains entity calibration independently and falls back on invalid host entity distances', async () => {
    for (const options of [{ defaultRefDistance: 9, defaultMaxDistance: 100 }, { defaultEntityRefDistance: NaN, defaultEntityMaxDistance: -1 }] satisfies Partial<AudioEngineOptions>[]) {
      const { engine, ctx } = await readyEngine(options);
      engine.createEntityAudio('default', { clip: 'loop.mp3', loop: true, spatial: true });
      expect(ctx.panners().map(p => [p.refDistance, p.maxDistance])).toEqual([[1, 45]]); engine.dispose();
    }
  });
});
