// clip-registry (io §2.8, X-44): clip keys, the manifest view over the asset index, the fetch/decode queue (≤ 4 in flight,
// deduped, decode only once a context exists), the post-decode mono down-mix of positional-only clips, the decoded-PCM LRU
// budget and missing = silent.
import { describe, expect, it } from 'vitest';
import type { AssetIndex } from '../../../src/assets/index-types.ts';
import { createAssetResolver } from '../../../src/assets/resolver.ts';
import { ClipRegistry, clipKey, downmixToMono, manifestFromIndex } from '../../../src/runtime/audio/clip-registry.ts';
import { DECODE_BUDGET_BYTES, DECODE_CONCURRENCY } from '../../../src/runtime/audio/limits.ts';
import type { AudioManifest } from '../../../src/runtime/audio/types.ts';
import { CHANNEL_LEVEL, FakeAudioContext, FakeBuffer, fakeClipBytes, fakeFetch, settle } from './fake-context.ts';
import { FILES, MANIFEST } from './helpers.ts';

function registry(
  over: { manifest?: AudioManifest; budget?: number; mono?: boolean; playing?: (k: string) => boolean; files?: Record<string, ArrayBuffer> } = {},
) {
  const logs: string[] = [];
  const f = fakeFetch(over.files ?? FILES);
  const reg = new ClipRegistry({
    manifest: over.manifest ?? MANIFEST,
    fetch: f.fetch,
    budgetBytes: over.budget ?? 1e9,
    monoPositional: over.mono ?? true,
    isPlaying: over.playing ?? (() => false),
    log: (m) => logs.push(m),
  });
  return { reg, logs, urls: f.urls };
}

describe('clipKey', () => {
  it('strips ^/?cdn/ and nothing else', () => {
    expect(clipKey('/cdn/a/b.mp3')).toBe('a/b.mp3');
    expect(clipKey('cdn/value.ab.mp3')).toBe('value.ab.mp3');
    expect(clipKey('moodboard/Sfx.mp3')).toBe('moodboard/Sfx.mp3');
    expect(clipKey('x/cdn/y.mp3')).toBe('x/cdn/y.mp3');
  });
});

describe('manifestFromIndex', () => {
  it('maps the audio entries of the asset index (u, b, dur, ch, mode, ls, le, pos, s) to clips', () => {
    const index: AssetIndex = {
      v: 1,
      build: 'b',
      origin: 'o',
      entries: {
        'value.aa.mp3': { u: 'assets/a/aa.mp3', b: 1000, k: 'audio', x: 'mp3', g: ['match'], dur: 1.25, ch: 2, mode: 'buffer', pos: 1 },
        'bed.mp3': { u: 'assets/a/bed.mp3', b: 9000, k: 'audio', x: 'mp3', g: ['match'], dur: 60, ch: 2, mode: 'stream', ls: 0.05, le: 59.9 },
        'wav-under-mp3.mp3': { u: 'assets/a/w.wav', b: 500, k: 'audio', x: 'wav', g: ['match'], ch: 1 },
        'boss-401.mp3': { u: null, b: 0, k: 'audio', x: 'mp3', g: [], s: 1 },
        'tex.png': { u: 'assets/i/t.webp', b: 10, k: 'image', x: 'webp', g: ['boot/menu'] },
      },
      groups: {},
      facts: {},
    };
    const resolver = createAssetResolver(index, { base: 'https://ss.test/game/' });
    const m = manifestFromIndex(resolver);
    expect(Object.keys(m).sort()).toEqual(['bed.mp3', 'boss-401.mp3', 'value.aa.mp3', 'wav-under-mp3.mp3']);
    expect(m['value.aa.mp3']).toEqual({ url: 'https://ss.test/game/assets/a/aa.mp3', bytes: 1000, dur: 1.25, ch: 2, mode: 'buffer', positionalOnly: true });
    expect(m['bed.mp3']).toEqual({ url: 'https://ss.test/game/assets/a/bed.mp3', bytes: 9000, dur: 60, ch: 2, mode: 'stream', loopStart: 0.05, loopEnd: 59.9 });
    expect(m['wav-under-mp3.mp3']).toEqual({ url: 'https://ss.test/game/assets/a/w.wav', bytes: 500, dur: 0, ch: 1, mode: 'buffer' });
    expect(m['boss-401.mp3']!.url).toBeNull();
  });
});

describe('down-mix', () => {
  it('(L + R) / 2 into a 1-channel buffer', () => {
    const ctx = new FakeAudioContext();
    const st = new FakeBuffer(2, 4, 48000);
    st.channels[0]!.set([1, 0.5, 0, -1]);
    st.channels[1]!.set([0, 0.5, 1, -1]);
    const mono = downmixToMono(ctx, st);
    expect(mono.numberOfChannels).toBe(1);
    expect(mono.length).toBe(4);
    expect(mono.sampleRate).toBe(48000);
    expect(Array.from(mono.getChannelData(0))).toEqual([0.5, 0.5, 0.5, -1]);
  });
});

describe('ClipRegistry', () => {
  it('holds a pos clip as a 1-channel buffer and a 2D clip with its channels (acceptance AU1)', async () => {
    const { reg } = registry();
    const ctx = new FakeAudioContext();
    reg.attach(ctx);
    const pos = await reg.load('value.feed.mp3');
    const flat = await reg.load('sfx-a.mp3');
    const monoPos = await reg.load('mono-pos.mp3');
    expect(pos!.numberOfChannels).toBe(1);
    expect(pos!.getChannelData(0)[0]).toBeCloseTo((CHANNEL_LEVEL[0] + CHANNEL_LEVEL[1]) / 2, 7);
    expect(flat!.numberOfChannels).toBe(2);
    expect(monoPos!.numberOfChannels).toBe(1);
    expect(reg.get('value.feed.mp3')).toBe(pos);
    // the stereo decode is dropped: only mono pos + stereo 2D + mono = (1 + 2 + 1) channels × 0.5 s × 48 kHz × 4 B are held
    expect(reg.stats().decodedBytes).toBe(4 * 24000 * 4);
  });

  it('keeps stereo when audio.monoPositional is off', async () => {
    const { reg } = registry({ mono: false });
    reg.attach(new FakeAudioContext());
    expect((await reg.load('value.feed.mp3'))!.numberOfChannels).toBe(2);
  });

  it('fetches before the context exists but decodes only after attach; loads are deduped', async () => {
    const { reg, urls } = registry();
    const a = reg.load('cdn/sfx-a.mp3');
    const b = reg.load('/cdn/sfx-a.mp3');
    await settle();
    expect(urls).toEqual(['https://ss.test/assets/a/a.mp3']);
    expect(reg.get('sfx-a.mp3')).toBeNull();
    const ctx = new FakeAudioContext();
    reg.attach(ctx);
    const [ba, bb] = await Promise.all([a, b]);
    expect(ba).toBe(bb);
    expect(ctx.decodes).toHaveLength(1);
  });

  it('runs at most 4 fetch/decode jobs at once', async () => {
    const manifest: Record<string, AudioManifest[string]> = {};
    const files: Record<string, ArrayBuffer> = {};
    for (let i = 0; i < 10; i++) {
      manifest[`c${i}.mp3`] = { url: `u${i}`, bytes: 2, dur: 0.5, ch: 2, mode: 'buffer' };
      files[`u${i}`] = fakeClipBytes(2);
    }
    const { reg } = registry({ manifest, files });
    const ctx = new FakeAudioContext();
    ctx.autoDecode = false;
    reg.attach(ctx);
    const all = reg.prefetch(Object.keys(manifest));
    await settle();
    expect(DECODE_CONCURRENCY).toBe(4);
    expect(ctx.decodes).toHaveLength(4);
    expect(reg.stats().decoding).toBe(4);
    for (let i = 0; i < 3 && ctx.decodes.length < 10; i++) {
      ctx.flushDecodes();
      await settle();
    }
    ctx.flushDecodes();
    await all;
    expect(ctx.decodes).toHaveLength(10);
  });

  it('prefetch skips stream clips (beds are never decoded)', async () => {
    const manifest: AudioManifest = { ...MANIFEST, 'bed.mp3': { url: 'https://ss.test/assets/a/a.mp3', bytes: 2, dur: 60, ch: 2, mode: 'stream' } };
    const { reg, urls } = registry({ manifest });
    reg.attach(new FakeAudioContext());
    await reg.prefetch(['bed.mp3']);
    expect(urls).toEqual([]);
  });

  it('missing, silent and failed clips resolve to null and log once per key', async () => {
    const manifest: AudioManifest = { ...MANIFEST, 'gone.mp3': { url: 'https://ss.test/404.mp3', bytes: 2, dur: 1, ch: 2, mode: 'buffer' } };
    const { reg, logs } = registry({ manifest });
    reg.attach(new FakeAudioContext());
    expect(await reg.load('nope.mp3')).toBeNull();
    expect(await reg.load('nope.mp3')).toBeNull();
    expect(await reg.load('boss-401.mp3')).toBeNull();
    expect(await reg.load('gone.mp3')).toBeNull();
    expect(await reg.load('gone.mp3')).toBeNull();
    expect(reg.status('nope.mp3')).toBe('missing');
    expect(reg.status('boss-401.mp3')).toBe('silent');
    expect(reg.status('gone.mp3')).toBe('failed');
    expect(reg.stats().missing).toBe(3);
    expect(logs).toHaveLength(3);
  });

  it('evicts least-recently-played buffers that are not playing when over the budget', async () => {
    const one = 24000 * 2 * 4; // a 0.5 s stereo clip at 48 kHz
    const playing = new Set<string>();
    const { reg } = registry({ budget: 2 * one, playing: (k) => playing.has(k) });
    reg.attach(new FakeAudioContext());
    await reg.load('sfx-a.mp3');
    await reg.load('sfx-b.mp3');
    reg.get('sfx-a.mp3'); // a played more recently than b
    playing.add('sfx-b.mp3');
    await reg.load('loop.mp3'); // over budget: b is older but playing, so a goes
    expect(reg.status('sfx-a.mp3')).toBe('idle');
    expect(reg.status('sfx-b.mp3')).toBe('ready');
    expect(reg.status('loop.mp3')).toBe('ready');
    expect(reg.stats().decodedBytes).toBe(2 * one);
    // re-decoded on next use
    expect((await reg.load('sfx-a.mp3'))!.numberOfChannels).toBe(2);
  });

  it('decode budgets per tier (io §2.8)', () => {
    expect(DECODE_BUDGET_BYTES).toEqual({ high: 192 * 2 ** 20, medium: 128 * 2 ** 20, low: 64 * 2 ** 20 });
  });
});
