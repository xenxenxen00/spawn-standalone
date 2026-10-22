// Clip registry (io §2.8, X-44): clip keys, the audio manifest over the asset index, the fetch → decode queue, the post-decode
// mono down-mix of positional-only clips, the decoded-PCM budget, and "not in the manifest = silent".
//
//   - key: the live name with `^/?cdn/` stripped, nothing else changed (io §2.4);
//   - a key that is not in the manifest, or that the index marks silent (the 44 boss clips answering 401 in live), resolves to
//     no buffer and is logged once; so is a clip whose fetch or decode fails;
//   - at most `DECODE_CONCURRENCY` jobs run at once; bytes may be fetched before the first gesture, decoding waits for the
//     context (`attach`);
//   - a positional-only clip (`pos`) that decodes to more than one channel is replaced by a 1-channel buffer `(L + R) / 2` and
//     the stereo buffer is dropped (flag `audio.monoPositional`, default on): the served bytes stay byte-identical, the decoded
//     memory halves (io §2.8 sizes: 897 positional one-shots ≈ 561 MB stereo, ≈ 281 MB mono);
//   - beyond the tier's budget the least-recently-played buffers that are not playing are evicted and decoded again on next use.
import type { AssetResolver } from '../../assets/resolver.ts';
import type { FetchLike } from '../../assets/loader.ts';
import { DECODE_CONCURRENCY, MONO_POSITIONAL_DEFAULT } from './limits.ts';
import type { AudioBufferLike, AudioCtxLike, AudioManifest, ClipInfo } from './types.ts';

const CDN_PREFIX = /^\/?cdn\//;

/** io §2.4: `/cdn/x`, `cdn/x` and `x` are one key `x` */
export function clipKey(clip: string): string {
  return clip.replace(CDN_PREFIX, '');
}

/** The audio entries of the installed asset index as an `AudioManifest` (absolute URLs; silent entries keep `url: null`). */
export function manifestFromIndex(resolver: AssetResolver): AudioManifest {
  const out: Record<string, ClipInfo> = {};
  for (const [key, e] of Object.entries(resolver.index.entries)) {
    if (e.k !== 'audio') continue;
    const info: { -readonly [K in keyof ClipInfo]: ClipInfo[K] } = {
      url: e.s === 1 ? null : resolver.resolve(key),
      bytes: e.b,
      dur: e.dur ?? 0,
      ch: e.ch ?? 2,
      mode: e.mode ?? 'buffer',
    };
    if (e.ls !== undefined) info.loopStart = e.ls;
    if (e.le !== undefined) info.loopEnd = e.le;
    if (e.pos === 1) info.positionalOnly = true;
    out[key] = Object.freeze(info);
  }
  return Object.freeze(out);
}

/** a 1-channel buffer holding the mean of every channel of `buf` (io §2.8: `(L + R) / 2`) */
export function downmixToMono(ctx: AudioCtxLike, buf: AudioBufferLike): AudioBufferLike {
  const n = buf.numberOfChannels;
  const mono = ctx.createBuffer(1, buf.length, buf.sampleRate);
  const out = mono.getChannelData(0);
  for (let c = 0; c < n; c++) {
    const src = buf.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i]! += src[i]!;
  }
  if (n > 1) for (let i = 0; i < out.length; i++) out[i]! /= n;
  return mono;
}

/** decoded PCM bytes of a buffer (float32 per sample per channel) */
export const pcmBytes = (b: AudioBufferLike): number => b.length * b.numberOfChannels * 4;

export type ClipStatus = 'missing' | 'silent' | 'idle' | 'loading' | 'ready' | 'failed';

export interface ClipRegistryOptions {
  manifest: AudioManifest;
  /** default: globalThis.fetch */
  fetch?: FetchLike;
  /** decoded PCM budget, bytes (limits.ts `DECODE_BUDGET_BYTES[tier]`) */
  budgetBytes: number;
  /** io §2.8 flag `audio.monoPositional` */
  monoPositional?: boolean;
  /** true while a voice of this key plays (never evicted then) */
  isPlaying: (key: string) => boolean;
  concurrency?: number;
  log?: (msg: string) => void;
}

export interface ClipRegistryStats {
  decodedBytes: number;
  /** distinct keys reported missing, silent or failed */
  missing: number;
  /** jobs running (fetching, waiting for the context, or decoding) */
  decoding: number;
  /** buffers held */
  held: number;
}

interface Slot {
  buffer: AudioBufferLike | null;
  bytes: number;
  lastUse: number;
  job: Promise<AudioBufferLike | null> | null;
  failed: boolean;
}

export class ClipRegistry {
  readonly #manifest: AudioManifest;
  readonly #fetch: FetchLike;
  readonly #budget: number;
  readonly #mono: boolean;
  readonly #isPlaying: (key: string) => boolean;
  readonly #limit: number;
  readonly #log: (msg: string) => void;
  readonly #slots = new Map<string, Slot>();
  readonly #reported = new Set<string>();
  readonly #queue: Array<() => void> = [];
  #running = 0;
  #decodedBytes = 0;
  #seq = 0;
  #ctx: AudioCtxLike | null = null;
  readonly #ctxReady: Promise<AudioCtxLike>;
  #resolveCtx!: (ctx: AudioCtxLike) => void;

  constructor(o: ClipRegistryOptions) {
    this.#manifest = o.manifest;
    this.#fetch = o.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.#budget = o.budgetBytes;
    this.#mono = o.monoPositional ?? MONO_POSITIONAL_DEFAULT;
    this.#isPlaying = o.isPlaying;
    this.#limit = Math.max(1, o.concurrency ?? DECODE_CONCURRENCY);
    this.#log = o.log ?? (() => {});
    this.#ctxReady = new Promise((r) => (this.#resolveCtx = r));
  }

  /** the context exists (first gesture): queued decodes proceed */
  attach(ctx: AudioCtxLike): void {
    if (this.#ctx) return;
    this.#ctx = ctx;
    this.#resolveCtx(ctx);
  }

  key(clip: string): string {
    return clipKey(clip);
  }

  info(key: string): ClipInfo | undefined {
    return Object.prototype.hasOwnProperty.call(this.#manifest, key) ? this.#manifest[key] : undefined;
  }

  status(key: string): ClipStatus {
    const info = this.info(key);
    if (!info) return 'missing';
    if (info.url === null) return 'silent';
    const s = this.#slots.get(key);
    if (!s) return 'idle';
    if (s.failed) return 'failed';
    if (s.buffer) return 'ready';
    return s.job ? 'loading' : 'idle';
  }

  /** the decoded buffer, marking it played now (LRU); null when not decoded */
  get(key: string): AudioBufferLike | null {
    const s = this.#slots.get(key);
    if (!s?.buffer) return null;
    s.lastUse = ++this.#seq;
    return s.buffer;
  }

  /**
   * Logs a key that will stay silent, once per key (io §2.4 "one dev log per key"). Returns false so callers can
   * `return reg.reportSilent(k)`.
   */
  reportSilent(key: string, why?: string): false {
    if (!this.#reported.has(key)) {
      this.#reported.add(key);
      const info = this.info(key);
      this.#log(`audio: ${key} is silent (${why ?? (!info ? 'not in the manifest' : 'silent in live')})`);
    }
    return false;
  }

  /** the decoded buffer of a clip (any spelling), fetching and decoding it when needed; null = silent */
  load(clip: string): Promise<AudioBufferLike | null> {
    const key = clipKey(clip);
    const info = this.info(key);
    if (!info || info.url === null) {
      this.reportSilent(key);
      return Promise.resolve(null);
    }
    let s = this.#slots.get(key);
    if (!s) {
      s = { buffer: null, bytes: 0, lastUse: 0, job: null, failed: false };
      this.#slots.set(key, s);
    }
    if (s.failed) return Promise.resolve(null);
    if (s.buffer) {
      s.lastUse = ++this.#seq;
      return Promise.resolve(s.buffer);
    }
    if (!s.job) s.job = this.#schedule(() => this.#fetchDecode(key, info, s));
    return s.job;
  }

  /** decodes every `buffer` clip of the list (streams are never decoded, io §2.8) */
  async prefetch(clips: readonly string[]): Promise<void> {
    const jobs: Array<Promise<unknown>> = [];
    for (const c of clips) {
      const info = this.info(clipKey(c));
      if (info && info.url !== null && info.mode === 'buffer') jobs.push(this.load(c));
    }
    await Promise.all(jobs);
  }

  /** drops a decoded buffer (decoded again on next use); false when none was held */
  evict(key: string): boolean {
    const s = this.#slots.get(key);
    if (!s?.buffer) return false;
    this.#decodedBytes -= s.bytes;
    s.buffer = null;
    s.bytes = 0;
    return true;
  }

  stats(): ClipRegistryStats {
    let held = 0;
    for (const s of this.#slots.values()) if (s.buffer) held++;
    return { decodedBytes: this.#decodedBytes, missing: this.#reported.size, decoding: this.#running, held };
  }

  #schedule<T>(job: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const run = (): void => {
        this.#running++;
        job()
          .then(resolve, reject)
          .finally(() => {
            this.#running--;
            this.#queue.shift()?.();
          });
      };
      if (this.#running < this.#limit) run();
      else this.#queue.push(run);
    });
  }

  async #fetchDecode(key: string, info: ClipInfo, s: Slot): Promise<AudioBufferLike | null> {
    try {
      const res = await this.#fetch(info.url!);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const bytes = await res.arrayBuffer();
      const ctx = await this.#ctxReady;
      let buf = await ctx.decodeAudioData(bytes);
      if (this.#mono && info.positionalOnly && buf.numberOfChannels > 1) buf = downmixToMono(ctx, buf);
      s.buffer = buf;
      s.bytes = pcmBytes(buf);
      s.lastUse = ++this.#seq;
      this.#decodedBytes += s.bytes;
      this.#enforceBudget(key);
      return buf;
    } catch (err) {
      s.failed = true;
      this.reportSilent(key, `failed to load: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    } finally {
      s.job = null;
    }
  }

  #enforceBudget(keep: string): void {
    while (this.#decodedBytes > this.#budget) {
      let victim: string | null = null;
      let oldest = Infinity;
      for (const [k, s] of this.#slots) {
        if (!s.buffer || k === keep || this.#isPlaying(k)) continue;
        if (s.lastUse < oldest) {
          oldest = s.lastUse;
          victim = k;
        }
      }
      if (victim === null) return;
      this.evict(victim);
    }
  }
}
