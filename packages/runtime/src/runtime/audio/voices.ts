// Voice pool (io §2.7): the runtime rules the Spawn engine applied on top of the game's own planner, which is carried as-is.
//
//   - per-clip cap: at most `perClipCap` voices of one clip key; an overlapping play beyond it is refused, never stolen
//     (`player/audio.js:218-220`: auto fire "stacked 15+ copies of one clip and new shots were refused until old ones ended");
//   - global pool: when full, the candidate is the voice with the lowest priority, oldest first, and it is stolen only when
//     strictly lower than the new play; otherwise the new play is refused;
//   - `restart` scope: the voices of the same clip key from the same source (the shooter, io §2.11), which the engine stops
//     before starting the new one;
//   - delayed and still-decoding voices hold their slot from emit time; entity audio (beds, loops) is outside the pool.
//
// Pure bookkeeping: the engine owns the audio nodes and stops a stolen voice itself.

export interface VoiceRecord {
  readonly id: string;
  /** clip key (io §2.8) */
  readonly clip: string;
  /** the emitting row, `null` for sims and the kernel */
  readonly source: string | null;
  readonly priority: number;
}

export type StartResult<V extends VoiceRecord> = { ok: true; stolen: V | null } | { ok: false; reason: 'clip-cap' | 'pool' };

export interface VoicePoolStats {
  voices: number;
  refusedPerClip: number;
  refusedPool: number;
  stolen: number;
}

export class VoicePool<V extends VoiceRecord> {
  readonly #size: number;
  readonly #perClipCap: number;
  /** insertion order = age (oldest first) */
  readonly #voices = new Map<string, V>();
  readonly #perClip = new Map<string, number>();
  #refusedPerClip = 0;
  #refusedPool = 0;
  #stolen = 0;

  constructor(opts: { size: number; perClipCap: number }) {
    this.#size = Math.max(1, Math.floor(opts.size));
    this.#perClipCap = Math.max(1, Math.floor(opts.perClipCap));
  }

  get size(): number {
    return this.#size;
  }

  /** admits `v` or refuses it; a stolen voice is already removed from the pool when returned */
  start(v: V, mode: 'overlap' | 'restart'): StartResult<V> {
    if (mode === 'overlap' && (this.#perClip.get(v.clip) ?? 0) >= this.#perClipCap) {
      this.#refusedPerClip++;
      return { ok: false, reason: 'clip-cap' };
    }
    let stolen: V | null = null;
    if (this.#voices.size >= this.#size) {
      const victim = this.stealFor(v.priority);
      if (!victim) {
        this.#refusedPool++;
        return { ok: false, reason: 'pool' };
      }
      this.stop(victim.id);
      this.#stolen++;
      stolen = victim;
    }
    this.#voices.set(v.id, v);
    this.#perClip.set(v.clip, (this.#perClip.get(v.clip) ?? 0) + 1);
    return { ok: true, stolen };
  }

  /** the voice a play of `priority` would steal: lowest priority, oldest first, strictly lower; null when none */
  stealFor(priority: number): V | null {
    let best: V | null = null;
    for (const v of this.#voices.values()) {
      if (v.priority < priority && (best === null || v.priority < best.priority)) best = v;
    }
    return best;
  }

  /** removes a voice; unknown ids return undefined */
  stop(id: string): V | undefined {
    const v = this.#voices.get(id);
    if (!v) return undefined;
    this.#voices.delete(id);
    const n = (this.#perClip.get(v.clip) ?? 1) - 1;
    if (n > 0) this.#perClip.set(v.clip, n);
    else this.#perClip.delete(v.clip);
    return v;
  }

  get(id: string): V | undefined {
    return this.#voices.get(id);
  }

  /** the voices a `restart` play of `clip` from `source` cuts */
  restartScope(clip: string, source: string | null): V[] {
    const out: V[] = [];
    for (const v of this.#voices.values()) if (v.clip === clip && v.source === source) out.push(v);
    return out;
  }

  /** voices of a clip key currently holding a slot */
  countOf(clip: string): number {
    return this.#perClip.get(clip) ?? 0;
  }

  values(): IterableIterator<V> {
    return this.#voices.values();
  }

  stats(): VoicePoolStats {
    return { voices: this.#voices.size, refusedPerClip: this.#refusedPerClip, refusedPool: this.#refusedPool, stolen: this.#stolen };
  }
}
