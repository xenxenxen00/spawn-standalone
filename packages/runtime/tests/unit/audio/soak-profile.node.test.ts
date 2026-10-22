// soak-profile unit tests (WP AU3 r3): the calibration harness's pure logic is
// deterministic and byte-exact, so the numbers the real-browser spec reports for
// the same seed are reproducible. No audio device, no engine, no DOM.
import { describe, expect, it } from 'vitest';
import {
  buildSoakProfile,
  encodeWavStereo,
  makeSoakClipSamples,
  mulberry32,
  peakStats,
  SOAK_SEED,
  voiceHistogram,
} from './soak-profile.ts';

describe('soak profile', () => {
  it('is deterministic: one seed builds the identical schedule every time', () => {
    const a = buildSoakProfile(SOAK_SEED);
    const b = buildSoakProfile(SOAK_SEED);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // …and a different seed builds a different schedule (the seed is load-bearing)
    expect(JSON.stringify(buildSoakProfile(SOAK_SEED + 1))).not.toBe(JSON.stringify(a));
  });

  it('schedule invariants: unique ids, times inside the window, known clips, sane payloads', () => {
    const p = buildSoakProfile();
    expect(p.plays.length).toBe(4 * 90 + 72); // 4 waves of 90 + 12/s background over 6 s
    const ids = new Set(p.plays.map((x) => x.id));
    expect(ids.size).toBe(p.plays.length);
    for (const pl of p.plays) {
      expect(pl.atMs).toBeGreaterThanOrEqual(0);
      expect(pl.atMs).toBeLessThan(p.durationMs);
      expect(p.clips).toContain(pl.clip);
      expect(pl.volume).toBeGreaterThanOrEqual(0.5);
      expect(pl.volume).toBeLessThanOrEqual(1.3); // io §2.4: linear, unclamped
      expect(pl.pitch).toBeGreaterThan(0);
      expect(pl.priority).toBeGreaterThanOrEqual(1);
      expect(pl.priority).toBeLessThanOrEqual(100);
      if (pl.loop) expect(pl.clip).toBe('loop.mp3');
      if (pl.mode === 'restart') expect(pl.sourceId).not.toBeNull();
      else expect(pl.sourceId).toBeNull();
    }
    for (let i = 1; i < p.plays.length; i++) {
      expect(p.plays[i]!.atMs).toBeGreaterThanOrEqual(p.plays[i - 1]!.atMs); // time-ordered
    }
  });

  it('the crest exceeds the high-tier pool: the profile actually stresses the pool', () => {
    const p = buildSoakProfile();
    // 90 plays inside 120 ms at 0.5 s clip length ≈ 90 concurrent voices > VOICE_POOL.high (64)
    let crest = 0;
    for (const w of [0, 1, 2, 3]) {
      const inWave = p.plays.filter((pl) => pl.atMs >= w * 1500 && pl.atMs < w * 1500 + 120).length;
      crest = Math.max(crest, inWave);
    }
    expect(crest).toBeGreaterThan(64);
  });

  it('voiceHistogram: bins sum to the sample count, max is exact', () => {
    const h = voiceHistogram([0, 1, 7, 8, 15, 16, 64], 8);
    expect(h.bins).toEqual([3, 2, 1, 0, 0, 0, 0, 0, 1]);
    expect(h.bins.reduce((a, b) => a + b, 0)).toBe(7);
    expect(h.total).toBe(7);
    expect(h.max).toBe(64);
    expect(h.binSize).toBe(8);
    const empty = voiceHistogram([], 8);
    expect(empty).toEqual({ binSize: 8, bins: [0], total: 0, max: 0 });
  });

  it('peakStats: max and quantiles on known data; zeros on empty', () => {
    const s = peakStats([0.1, 0.5, 0.9, 0.3]);
    expect(s).toEqual({ n: 4, max: 0.9, p50: 0.5, p99: 0.9 });
    expect(peakStats([])).toEqual({ n: 0, max: 0, p50: 0, p99: 0 });
  });

  it('encodeWavStereo: valid 16-bit stereo RIFF, byte-exact size, sample round-trip', () => {
    const sr = 48000;
    const { left, right } = makeSoakClipSamples(7, 0.01, sr, 440);
    const buf = encodeWavStereo(left, right, sr);
    const v = new DataView(buf);
    const str = (o: number, n: number): string =>
      String.fromCharCode(...Array.from(new Uint8Array(buf, o, n)));
    expect(str(0, 4)).toBe('RIFF');
    expect(str(8, 4)).toBe('WAVE');
    expect(str(12, 4)).toBe('fmt ');
    expect(v.getUint16(20, true)).toBe(1); // PCM
    expect(v.getUint16(22, true)).toBe(2); // stereo
    expect(v.getUint32(24, true)).toBe(sr);
    expect(v.getUint16(34, true)).toBe(16);
    expect(str(36, 4)).toBe('data');
    expect(v.getUint32(40, true)).toBe(left.length * 4);
    expect(v.getUint32(4, true)).toBe(36 + left.length * 4);
    expect(buf.byteLength).toBe(44 + left.length * 4);
    expect(v.getInt16(44, true) / 32767).toBeCloseTo(left[0]!, 3);
    expect(v.getInt16(46, true) / 32767).toBeCloseTo(right[0]!, 3);
    // a tampered magic is detectable (the negative control for the header asserts)
    const bad = new Uint8Array(buf.slice(0));
    bad[1] = 'X'.charCodeAt(0); // 'RIFF' -> 'RXFF'
    expect(String.fromCharCode(...Array.from(bad.slice(0, 4)))).not.toBe('RIFF');
  });

  it('mulberry32 is stable: the same seed replays the same stream', () => {
    const r1 = mulberry32(1234);
    const seq = [r1(), r1(), r1()];
    const r2 = mulberry32(1234);
    expect([r2(), r2(), r2()]).toEqual(seq);
    expect(seq.every((x) => x >= 0 && x < 1)).toBe(true);
  });
});
