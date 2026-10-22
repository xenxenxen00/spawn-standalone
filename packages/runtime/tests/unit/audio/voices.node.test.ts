// voices (io §2.7): the per-clip cap refuses the 17th overlapping instance; a full pool steals the lowest-priority, oldest
// voice that is strictly lower than the new one, else refuses; `restart` is scoped by clip + source; delayed voices count.
import { describe, expect, it } from 'vitest';
import { DEFAULT_PRIORITY, PER_CLIP_CAP, VOICE_POOL } from '../../../src/runtime/audio/limits.ts';
import { VoicePool, type VoiceRecord } from '../../../src/runtime/audio/voices.ts';
import { FakeGain, FakeSource } from './fake-context.ts';
import { META, readyEngine } from './helpers.ts';

const v = (id: string, clip: string, priority = 50, source: string | null = 'a'): VoiceRecord => ({ id, clip, source, priority });

describe('limits', () => {
  it('match io §2.7', () => {
    expect(PER_CLIP_CAP).toBe(16);
    expect(VOICE_POOL).toEqual({ high: 64, medium: 64, low: 40 });
    expect(DEFAULT_PRIORITY).toBe(50);
  });
});

describe('VoicePool', () => {
  it('refuses the 17th overlapping instance of one clip key (not stolen), other clips still play', () => {
    const pool = new VoicePool<VoiceRecord>({ size: 64, perClipCap: 16 });
    for (let i = 0; i < 16; i++) expect(pool.start(v(`s${i}`, 'gun.mp3'), 'overlap')).toEqual({ ok: true, stolen: null });
    expect(pool.start(v('s16', 'gun.mp3', 99), 'overlap')).toEqual({ ok: false, reason: 'clip-cap' });
    expect(pool.start(v('o', 'other.mp3'), 'overlap').ok).toBe(true);
    expect(pool.stats()).toMatchObject({ voices: 17, refusedPerClip: 1, refusedPool: 0, stolen: 0 });
    pool.stop('s3');
    expect(pool.start(v('s17', 'gun.mp3'), 'overlap').ok).toBe(true);
  });

  it('the cap applies to overlap mode only (restart cuts its own tail first)', () => {
    const pool = new VoicePool<VoiceRecord>({ size: 64, perClipCap: 2 });
    pool.start(v('a', 'gun.mp3', 50, 'x'), 'overlap');
    pool.start(v('b', 'gun.mp3', 50, 'y'), 'overlap');
    expect(pool.start(v('c', 'gun.mp3', 50, 'z'), 'restart').ok).toBe(true);
  });

  it('a full pool steals the lowest priority, oldest first, strictly lower than the new voice', () => {
    const pool = new VoicePool<VoiceRecord>({ size: 4, perClipCap: 16 });
    pool.start(v('p60', 'a', 60), 'overlap');
    pool.start(v('p25-old', 'b', 25), 'overlap');
    pool.start(v('p45', 'c', 45), 'overlap');
    pool.start(v('p25-new', 'd', 25), 'overlap');
    const r = pool.start(v('p95', 'e', 95), 'overlap');
    expect(r).toEqual({ ok: true, stolen: expect.objectContaining({ id: 'p25-old' }) });
    expect(pool.get('p25-old')).toBeUndefined();
    expect(pool.start(v('p30', 'f', 30), 'overlap')).toEqual({ ok: true, stolen: expect.objectContaining({ id: 'p25-new' }) });
    expect(pool.stats()).toMatchObject({ voices: 4, stolen: 2 });
  });

  it('refuses when nothing in a full pool is strictly lower', () => {
    const pool = new VoicePool<VoiceRecord>({ size: 2, perClipCap: 16 });
    pool.start(v('a', 'a', 50), 'overlap');
    pool.start(v('b', 'b', 60), 'overlap');
    expect(pool.start(v('c', 'c', 50), 'overlap')).toEqual({ ok: false, reason: 'pool' });
    expect(pool.start(v('d', 'd', 10), 'overlap')).toEqual({ ok: false, reason: 'pool' });
    expect(pool.stats()).toMatchObject({ voices: 2, refusedPool: 2, stolen: 0 });
  });

  it('restartScope returns the voices of the same clip and source only', () => {
    const pool = new VoicePool<VoiceRecord>({ size: 8, perClipCap: 16 });
    pool.start(v('mine1', 'gun', 95, 'player/local'), 'restart');
    pool.start(v('bot', 'gun', 60, 'bot/1'), 'restart');
    pool.start(v('mine-other-clip', 'gun-mid', 45, 'player/local'), 'restart');
    expect(pool.restartScope('gun', 'player/local').map((x) => x.id)).toEqual(['mine1']);
  });
});

describe('engine voices', () => {
  it('restart stops (5 ms fade) the previous voices of that clip from that source, never another shooter', async () => {
    const { engine, ctx } = await readyEngine();
    ctx.currentTime = 1;
    engine.playSound('snd-1', { clip: 'cdn/sfx-a.mp3', mode: 'restart', priority: 95 }, META);
    engine.playSound('snd-2', { clip: 'cdn/sfx-a.mp3', mode: 'restart', priority: 60 }, { sourceId: 'bot/1', sourcePlace: 'cradle' });
    const [mine, bot] = ctx.voiceSources() as [FakeSource, FakeSource];
    engine.playSound('snd-3', { clip: 'cdn/sfx-a.mp3', mode: 'restart', priority: 95 }, META);
    expect(mine.stopped).toBe(1.005);
    expect((mine.outputs[0] as FakeGain).gain.last()).toEqual({ type: 'ramp', value: 0, time: 1.005 });
    expect(bot.stopped).toBeNull();
    expect(engine.stats().voices).toBe(2);
  });

  it('the 17th overlapping play of one clip is refused; a stolen voice fades out', async () => {
    const { engine, ctx } = await readyEngine({ tier: 'low' });
    for (let i = 0; i < 17; i++) engine.playSound(`snd-${i}`, { clip: 'cdn/sfx-a.mp3' }, META);
    expect(ctx.voiceSources()).toHaveLength(16);
    expect(engine.stats()).toMatchObject({ voices: 16, refusedPerClip: 1 });

    // fill the low-tier pool (40) with priority-10 voices of other clips, then a priority-95 play steals the oldest of them
    for (let i = 0; i < 16; i++) engine.playSound(`snd-b${i}`, { clip: 'cdn/sfx-b.mp3', priority: 10 }, META);
    for (let i = 0; i < 8; i++) engine.playSound(`snd-l${i}`, { clip: 'cdn/loop.mp3', priority: 10 }, META);
    expect(engine.stats().voices).toBe(40);
    const oldestLow = ctx.voiceSources()[16]!;
    engine.playSound('snd-hi', { clip: 'cdn/value.feed.mp3', priority: 95, position: { x: 0, y: 0, z: 0 } }, META);
    expect(oldestLow.stopped).not.toBeNull();
    expect(engine.stats()).toMatchObject({ voices: 40, stolen: 1 });
    engine.playSound('snd-eq', { clip: 'cdn/value.feed.mp3', priority: 10 }, META);
    expect(engine.stats()).toMatchObject({ voices: 40, refusedPool: 1 });
  });

  it('a delayed voice holds its slot from emit time', async () => {
    const { engine } = await readyEngine();
    engine.playSound('snd-1', { clip: 'cdn/sfx-a.mp3', delay: 5 }, META);
    expect(engine.stats()).toMatchObject({ voices: 1, pending: 1 });
    engine.frame();
    expect(engine.stats().voices).toBe(1);
  });
});
