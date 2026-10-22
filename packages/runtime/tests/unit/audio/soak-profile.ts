// Soak profile for AU3 voice-pool / limiter calibration (io §12; WP AU3).
//
// Pure, deterministic logic shared by the node unit test
// (tests/unit/audio/soak-profile.node.test.ts) and the real-browser soak harness
// (tests/e2e/audio-soak.page.ts, driven by tests/e2e/audio-soak.spec.ts): a seeded
// play schedule, a voice-count histogram, peak statistics, and a tiny 16-bit stereo
// WAV encoder for the in-page fetch stub. No DOM, no Node APIs, no engine imports —
// the browser page maps SoakPlay onto playSound payloads.
//
// The load below is an ASSUMED p99-wave-shaped profile. The true p99 wave is not in
// the supplied sources; the constants are chosen so the crest exceeds the high-tier
// pool (64) and brushes the per-clip cap (16), so the histogram shows the tail and
// the steal/refusal counters move. Calibration decisions stay with the reviewer:
// limits.ts constants are frozen by the AU3 acceptance terms.

/** mulberry32: deterministic across engines, so the node test and the page agree */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const SOAK_SEED = 0xa03;

export interface SoakPlay {
  readonly id: string;
  readonly clip: string;
  /** ms after soak start at which the harness calls playSound */
  readonly atMs: number;
  /** linear, unclamped (io §2.4): 0.5..1.3 */
  readonly volume: number;
  readonly pitch: number;
  readonly loop: boolean;
  readonly priority: number;
  readonly mode: 'overlap' | 'restart';
  readonly sourceId: string | null;
}

export interface SoakProfile {
  readonly seed: number;
  readonly durationMs: number;
  readonly sampleEveryMs: number;
  readonly clips: readonly string[];
  readonly plays: readonly SoakPlay[];
}

/**
 * 6 s soak: a burst "wave" every 1500 ms (90 plays inside 120 ms — at 0.5 s clip
 * length the crest holds ~90 concurrent voices, over the 64 pool so steals happen)
 * plus a 12 plays/s background. ~15 plays per clip per wave, just under the
 * per-clip cap of 16. 1 in 6 plays is restart-mode scoped to 8 emitters; loops only
 * on the loop clip; priorities uniform 1..100.
 */
export function buildSoakProfile(seed: number = SOAK_SEED): SoakProfile {
  const rand = mulberry32(seed);
  const clips = ['sfx-a.mp3', 'sfx-b.mp3', 'sfx-c.mp3', 'sfx-d.mp3', 'loop.mp3', 'ui.mp3'];
  const durationMs = 6000;
  const sampleEveryMs = 50;
  const plays: SoakPlay[] = [];
  let n = 0;
  const one = (atMs: number): void => {
    const clip = clips[Math.floor(rand() * clips.length)]!;
    const mode = rand() < 1 / 6 ? 'restart' : 'overlap';
    plays.push({
      id: `snd-${++n}`,
      clip,
      atMs,
      volume: 0.5 + rand() * 0.8,
      pitch: 0.8 + rand() * 0.4,
      loop: clip === 'loop.mp3' && rand() < 0.5,
      priority: 1 + Math.floor(rand() * 100),
      mode,
      sourceId: mode === 'restart' ? `emitter-${Math.floor(rand() * 8)}` : null,
    });
  };
  for (let w = 0; w < 4; w++) {
    const base = w * 1500;
    for (let i = 0; i < 90; i++) one(base + Math.floor(rand() * 120));
  }
  const bg = Math.floor((durationMs / 1000) * 12);
  for (let i = 0; i < bg; i++) one(Math.floor(rand() * durationMs));
  plays.sort((a, b) => a.atMs - b.atMs);
  return { seed, durationMs, sampleEveryMs, clips, plays };
}

export interface VoiceHistogram {
  readonly binSize: number;
  readonly bins: readonly number[];
  readonly total: number;
  readonly max: number;
}

/** bins[i] counts samples with i*binSize <= voices < (i+1)*binSize */
export function voiceHistogram(samples: readonly number[], binSize = 8): VoiceHistogram {
  const max = samples.length ? Math.max(...samples) : 0;
  const bins = new Array<number>(Math.floor(max / binSize) + 1).fill(0);
  for (const s of samples) bins[Math.floor(s / binSize)]!++;
  return { binSize, bins, total: samples.length, max };
}

export interface PeakStats {
  readonly n: number;
  readonly max: number;
  readonly p50: number;
  readonly p99: number;
}

export function peakStats(peaks: readonly number[]): PeakStats {
  if (!peaks.length) return { n: 0, max: 0, p50: 0, p99: 0 };
  const s = [...peaks].sort((a, b) => a - b);
  const q = (p: number): number => s[Math.min(s.length - 1, Math.floor(p * s.length))]!;
  return { n: s.length, max: s[s.length - 1]!, p50: q(0.5), p99: q(0.99) };
}

/** deterministic clip content: 0.5 s stereo, sine + low noise, peak ≈ 0.9 */
export function makeSoakClipSamples(
  seed: number,
  seconds: number,
  sampleRate: number,
  freq: number,
): { left: Float32Array; right: Float32Array } {
  const rand = mulberry32(seed);
  const n = Math.floor(seconds * sampleRate);
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = 0.7 * Math.sin((2 * Math.PI * freq * i) / sampleRate) + 0.2 * (rand() * 2 - 1);
    left[i] = s;
    right[i] = 0.8 * s;
  }
  return { left, right };
}

/** 16-bit PCM stereo WAV (RIFF), for the in-page fetch stub */
export function encodeWavStereo(left: Float32Array, right: Float32Array, sampleRate: number): ArrayBuffer {
  const n = Math.min(left.length, right.length);
  const buf = new ArrayBuffer(44 + n * 4);
  const v = new DataView(buf);
  const str = (o: number, s: string): void => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  str(0, 'RIFF');
  v.setUint32(4, 36 + n * 4, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 2, true); // stereo
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 4, true); // byte rate
  v.setUint16(32, 4, true); // block align
  v.setUint16(34, 16, true); // bits per sample
  str(36, 'data');
  v.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    const q = (x: number): number => Math.max(-32768, Math.min(32767, Math.round(x * 32767)));
    v.setInt16(44 + i * 4, q(left[i]!), true);
    v.setInt16(44 + i * 4 + 2, q(right[i]!), true);
  }
  return buf;
}
