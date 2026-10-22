// play-sound (io §2.2, §2.4, §2.8; X-12): every payload field, the kernel-minted id, missing clips silent, the default bus, the
// graph (voice → gain → [panner] → bus → master → limiter → destination), late decodes and the context gate.
import { describe, expect, it } from 'vitest';
import { busFor } from '../../../src/runtime/audio/audio-engine.ts';
import { LIMITER } from '../../../src/runtime/audio/limits.ts';
import { FakeGain, FakePanner, FakeSource, settle, type FakeNode } from './fake-context.ts';
import { META, makeEngine, readyEngine } from './helpers.ts';

const lastSource = (nodes: FakeNode[]): FakeSource => {
  const s = nodes.filter((n): n is FakeSource => n instanceof FakeSource);
  return s[s.length - 1]!;
};

describe('graph', () => {
  it('builds buses → master → brick-wall limiter → destination when the context is created', async () => {
    const { engine, ctx } = await readyEngine();
    const [lim] = ctx.compressors();
    expect(lim).toBeDefined();
    expect(lim!.outputs).toEqual([ctx.destination]);
    expect(lim!.threshold.value).toBe(LIMITER.threshold);
    expect(lim!.knee.value).toBe(0);
    expect(lim!.ratio.value).toBe(20);
    expect(lim!.attack.value).toBe(0.003);
    expect(lim!.release.value).toBe(0.25);
    expect(LIMITER.threshold).toBe(-3);
    for (const id of ['music', 'sfx', 'ui', 'ambience'] as const) {
      const bus = engine.bus(id) as FakeGain;
      expect(bus.path().map((n) => n.kind)).toEqual(['gain', 'gain', 'compressor', 'destination']);
    }
  });

  it('maps bus names case-insensitively; unknown or absent → sfx (io §2.2)', () => {
    expect(busFor('SFX')).toBe('sfx');
    expect(busFor('UI')).toBe('ui');
    expect(busFor('Ambience')).toBe('ambience');
    expect(busFor('Music')).toBe('music');
    expect(busFor('weird')).toBe('sfx');
    expect(busFor(undefined)).toBe('sfx');
    expect(busFor(7 as unknown as string)).toBe('sfx');
  });
});

describe('levels', () => {
  it('bus gains are slider², master = (muted || !platform || paused) ? 0 : master², with the io §2.2 ramps', async () => {
    const { engine, ctx } = await readyEngine();
    ctx.currentTime = 5;
    engine.setLevels({ master: 0.5, music: 0.2, sfx: 0.4, ambience: 0.6 });
    const master = (engine.bus('sfx') as FakeGain).outputs[0] as FakeGain;
    expect(master.gain.last()).toEqual({ type: 'target', value: 0.25, time: 5, tc: 0.03 });
    expect((engine.bus('music') as FakeGain).gain.value).toBeCloseTo(0.04, 12);
    expect((engine.bus('sfx') as FakeGain).gain.value).toBeCloseTo(0.16, 12);
    expect((engine.bus('ui') as FakeGain).gain.value).toBeCloseTo(0.16, 12);
    expect((engine.bus('ambience') as FakeGain).gain.value).toBeCloseTo(0.36, 12);
    engine.setUserMuted(true);
    expect(master.gain.last()).toEqual({ type: 'target', value: 0, time: 5, tc: 0.01 });
    engine.setUserMuted(false);
    engine.setPlatformAudio(false);
    expect(master.gain.value).toBe(0);
    engine.setPlatformAudio(true);
    expect(master.gain.value).toBe(0.25);
    engine.setPaused(true);
    expect(master.gain.value).toBe(0);
    engine.setPaused(false);
    expect(master.gain.value).toBe(0.25);
    engine.setLevels({ master: Number.NaN, music: 0.2, sfx: 2, ambience: -1 });
    expect(master.gain.value).toBe(0.25);
    expect((engine.bus('sfx') as FakeGain).gain.value).toBe(1);
    expect((engine.bus('ambience') as FakeGain).gain.value).toBe(0);
  });

  it('levels and mute set before the first gesture apply when the graph is built', () => {
    const { engine, ctx } = makeEngine({ unlock: false });
    engine.setLevels({ master: 0.5, music: 1, sfx: 1, ambience: 1 });
    engine.setUserMuted(true);
    engine.unlock();
    const master = (engine.bus('sfx') as FakeGain).outputs[0] as FakeGain;
    expect(master.gain.value).toBe(0);
    engine.setUserMuted(false);
    expect(master.gain.value).toBe(0.25);
    expect(ctx.state).toBe('running');
  });
});

describe('playSound', () => {
  it('a 2D play: source → gain(volume) → the payload bus, no panner; started now', async () => {
    const { engine, ctx } = await readyEngine();
    ctx.currentTime = 2;
    engine.playSound('snd-1', { clip: 'cdn/sfx-a.mp3', bus: 'UI' }, META);
    const src = lastSource(ctx.nodes);
    expect(src.started).toEqual({ when: 2, offset: 0 });
    const chain = src.path();
    expect(chain.map((n) => n.kind)).toEqual(['source', 'gain', 'gain', 'gain', 'compressor', 'destination']);
    expect(chain[2]).toBe(engine.bus('ui'));
    expect((chain[1] as FakeGain).gain.value).toBe(1);
    expect(src.playbackRate.value).toBe(1);
    expect(src.loop).toBe(false);
    expect(ctx.panners()).toHaveLength(0);
    expect(engine.stats().voices).toBe(1);
  });

  it('accepts /cdn/, cdn/ and bare spellings of one clip key', async () => {
    const { engine, ctx } = await readyEngine();
    engine.playSound('snd-1', { clip: '/cdn/sfx-a.mp3' }, META);
    engine.playSound('snd-2', { clip: 'cdn/sfx-a.mp3' }, META);
    engine.playSound('snd-3', { clip: 'sfx-a.mp3' }, META);
    expect(ctx.voiceSources().filter((s) => s.started)).toHaveLength(3);
    const bufs = new Set(ctx.voiceSources().map((s) => s.buffer));
    expect(bufs.size).toBe(1);
  });

  it('volume is linear and not clamped (1.3 passes), pitch is the playback rate, the default bus is sfx', async () => {
    const { engine, ctx } = await readyEngine();
    engine.playSound('snd-1', { clip: 'cdn/sfx-a.mp3', volume: 1.3, pitch: 0.5 }, META);
    const src = lastSource(ctx.nodes);
    expect((src.outputs[0] as FakeGain).gain.value).toBe(1.3);
    expect(src.playbackRate.value).toBe(0.5);
    expect(src.outputs[0]!.outputs[0]).toBe(engine.bus('sfx'));
  });

  it('a position adds a linear panner at that point with the payload distances (defaults ref 3, max 45)', async () => {
    const { engine, ctx } = await readyEngine();
    engine.playSound('snd-1', { clip: 'cdn/sfx-a.mp3', position: { x: 1, y: 2, z: 3 } }, META);
    engine.playSound('snd-2', { clip: 'cdn/sfx-a.mp3', position: { x: 0, y: 0, z: 0 }, refDistance: 6, maxDistance: 48.4 }, META);
    engine.playSound('snd-3', { clip: 'cdn/sfx-a.mp3', position: { x: 0, y: 0, z: 0 }, refDistance: 10, maxDistance: 4 }, META);
    const [a, b, c] = ctx.panners() as [FakePanner, FakePanner, FakePanner];
    expect([a.distanceModel, a.rolloffFactor, a.refDistance, a.maxDistance]).toEqual(['linear', 1, 3, 45]);
    expect([a.positionX.value, a.positionY.value, a.positionZ.value]).toEqual([1, 2, 3]);
    expect([a.coneInnerAngle, a.coneOuterAngle]).toEqual([360, 360]);
    expect([b.refDistance, b.maxDistance]).toEqual([6, 48.4]);
    expect([c.refDistance, c.maxDistance]).toEqual([10, 10.01]);
    const src = ctx.voiceSources().find((s) => s.started)!;
    expect(src.path().map((n) => n.kind)).toEqual(['source', 'gain', 'panner', 'gain', 'gain', 'compressor', 'destination']);
  });

  it('HRTF on the high and medium tiers, equalpower on low (io §2.6, X-22)', async () => {
    for (const [tier, model] of [
      ['high', 'HRTF'],
      ['medium', 'HRTF'],
      ['low', 'equalpower'],
    ] as const) {
      const { engine, ctx } = await readyEngine({ tier });
      engine.playSound('snd-1', { clip: 'cdn/sfx-a.mp3', position: { x: 0, y: 0, z: 0 } }, META);
      expect(ctx.panners()[0]!.panningModel).toBe(model);
    }
  });

  it('loop is honoured with the manifest loop points; delay starts on the audio clock', async () => {
    const { engine, ctx } = await readyEngine();
    ctx.currentTime = 1;
    engine.playSound('snd-1', { clip: 'cdn/loop.mp3', loop: true }, META);
    const loop = lastSource(ctx.nodes);
    expect([loop.loop, loop.loopStart, loop.loopEnd]).toEqual([true, 0.01, 0.49]);
    engine.playSound('snd-2', { clip: 'cdn/sfx-a.mp3', delay: 0.25 }, META);
    expect(lastSource(ctx.nodes).started).toEqual({ when: 1.25, offset: 0 });
    expect(engine.stats().voices).toBe(2);
  });

  it('a clip not in the manifest, or silent in live, is silent: no voice, no fetch, one log per key', async () => {
    const { engine, ctx, logs, urls } = await readyEngine();
    const before = urls.length;
    engine.playSound('snd-1', { clip: 'cdn/nope.mp3' }, META);
    engine.playSound('snd-2', { clip: '/cdn/nope.mp3' }, META);
    engine.playSound('snd-3', { clip: 'cdn/boss-401.mp3' }, META);
    engine.playSound('snd-4', { clip: 42 } as unknown as { clip: string }, META);
    expect(ctx.voiceSources()).toHaveLength(0);
    expect(urls.length).toBe(before);
    expect(engine.stats().missing).toBe(2);
    expect(logs.filter((l) => l.includes('nope.mp3'))).toHaveLength(1);
    expect(logs.filter((l) => l.includes('boss-401.mp3'))).toHaveLength(1);
    engine.stopSound({ soundId: 'snd-1' });
  });

  it('stopSound fades for 5 ms then stops; unknown, repeated and voiceless ids are no-ops', async () => {
    const { engine, ctx } = await readyEngine();
    ctx.currentTime = 3;
    engine.playSound('snd-1', { clip: 'cdn/sfx-a.mp3', volume: 0.8 }, META);
    const src = lastSource(ctx.nodes);
    const gain = src.outputs[0] as FakeGain;
    engine.stopSound({ soundId: 'snd-1' });
    expect(gain.gain.last()).toEqual({ type: 'ramp', value: 0, time: 3.005 });
    expect(src.stopped).toBe(3.005);
    expect(engine.stats().voices).toBe(0);
    engine.stopSound({ soundId: 'snd-1' });
    engine.stopSound({ soundId: 'snd-99' });
    engine.stopSound({} as { soundId: string });
    expect(src.stopped).toBe(3.005);
  });

  it('a voice that ends frees its slot and disconnects its nodes', async () => {
    const { engine, ctx } = await readyEngine();
    engine.playSound('snd-1', { clip: 'cdn/sfx-a.mp3', position: { x: 0, y: 0, z: 0 } }, META);
    const src = lastSource(ctx.nodes);
    src.end();
    expect(engine.stats().voices).toBe(0);
    expect(src.disconnected).toBe(true);
    expect(ctx.panners()[0]!.disconnected).toBe(true);
  });

  it('voice GC in frame() releases a voice whose end passed without an ended event', async () => {
    const { engine, ctx } = await readyEngine();
    engine.playSound('snd-1', { clip: 'cdn/sfx-a.mp3', pitch: 2 }, META);
    ctx.currentTime = 0.2; // 0.5 s clip at rate 2 ends at 0.25
    engine.frame();
    expect(engine.stats().voices).toBe(1);
    ctx.currentTime = 1;
    engine.frame();
    expect(engine.stats().voices).toBe(0);
  });

  it('before the first gesture there is no context: plays are dropped and counted', () => {
    const { engine, ctx, contexts } = makeEngine({ unlock: false });
    engine.playSound('snd-1', { clip: 'cdn/sfx-a.mp3' }, META);
    expect(contexts()).toBe(0);
    expect(ctx.voiceSources()).toHaveLength(0);
    expect(engine.stats().locked).toBe(1);
    expect(engine.ready).toBe(false);
  });

  it('a buffer landing within 250 ms starts in sync; later one-shots drop, loops start', async () => {
    const { engine, ctx } = makeEngine();
    ctx.autoDecode = false;
    ctx.currentTime = 10;
    engine.playSound('snd-1', { clip: 'cdn/sfx-a.mp3', pitch: 2 }, META);
    expect(engine.stats()).toMatchObject({ voices: 1, pending: 1 });
    await settle();
    ctx.currentTime = 10.1;
    ctx.flushDecodes();
    await settle();
    const a = lastSource(ctx.nodes);
    expect(a.started!.when).toBe(10.1);
    expect(a.started!.offset).toBeCloseTo(0.2, 9);

    engine.playSound('snd-2', { clip: 'cdn/sfx-b.mp3' }, META);
    engine.playSound('snd-3', { clip: 'cdn/loop.mp3', loop: true }, META);
    await settle();
    ctx.currentTime = 10.5;
    ctx.flushDecodes();
    await settle();
    const started = ctx.voiceSources().filter((s) => s.started);
    expect(started).toHaveLength(2);
    expect(started[1]!.loop).toBe(true);
    expect(engine.stats()).toMatchObject({ late: 1, voices: 2, pending: 0 });
  });

  it('stopSound on a voice still waiting for its buffer cancels it', async () => {
    const { engine, ctx } = makeEngine();
    ctx.autoDecode = false;
    engine.playSound('snd-1', { clip: 'cdn/sfx-a.mp3' }, META);
    engine.stopSound({ soundId: 'snd-1' });
    expect(engine.stats().voices).toBe(0);
    await settle();
    ctx.flushDecodes();
    await settle();
    expect(ctx.voiceSources().filter((s) => s.started)).toHaveLength(0);
  });

  it('a positional-only clip plays from a 1-channel buffer; a 2D clip keeps its channels (X-44)', async () => {
    const { engine, ctx } = await readyEngine();
    engine.playSound('snd-1', { clip: 'cdn/value.feed.mp3', position: { x: 1, y: 0, z: 0 } }, META);
    expect(lastSource(ctx.nodes).buffer!.numberOfChannels).toBe(1);
    engine.playSound('snd-2', { clip: 'cdn/sfx-a.mp3' }, META);
    expect(lastSource(ctx.nodes).buffer!.numberOfChannels).toBe(2);
  });

  it('createEntityAudio returns a handle that updates and stops a row loop', async () => {
    const { engine, ctx } = await readyEngine();
    const handle = engine.createEntityAudio('row/x', { clip: 'cdn/loop.mp3', loop: true, spatial: true, gain: 0.4 });
    await settle();

    const source = lastSource(ctx.nodes);
    const panner = ctx.panners()[0]!;
    expect(source.loop).toBe(true);
    expect(source.started).toEqual({ when: 0, offset: 0 });

    handle.update({ clip: 'cdn/loop.mp3', loop: true, spatial: true, gain: 0.7 }, { x: 4, y: 5, z: 6 });
    expect([panner.positionX.value, panner.positionY.value, panner.positionZ.value]).toEqual([4, 5, 6]);
    expect((source.outputs[0] as FakeGain).gain.last()).toEqual({ type: 'target', value: 0.7, time: 0, tc: 0.03 });

    handle.stop();
    expect(source.stopped).toBe(0.005);
    engine.dispose();
  });

  it('dispose stops every voice and closes the context', async () => {
    const { engine, ctx } = await readyEngine();
    engine.playSound('snd-1', { clip: 'cdn/sfx-a.mp3' }, META);
    engine.dispose();
    expect(lastSource(ctx.nodes).stopped).not.toBeNull();
    expect(ctx.state).toBe('closed');
    expect(engine.stats().voices).toBe(0);
  });
});
