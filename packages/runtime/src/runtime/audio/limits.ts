// Audio constants (io §2.2, §2.6-§2.8, §2.12). Every value the engine tunes lives here so calibration (io §12; WP AU3: the
// limiter and the pool size from the soak voice histogram) edits one file. [I] = port inference, [C] = calibration still owed.
import type { AudioTier } from './types.ts';

/** io §2.7: a 17th overlapping instance of one clip key is refused, not stolen (`player/audio.js:218-220` "15+ copies") [I] */
export const PER_CLIP_CAP = 16;

/** io §2.7: global voice pool per audio tier [I][C: soak voice histogram, steal on < 1 % of plays at the p99 wave] */
export const VOICE_POOL: Readonly<Record<AudioTier, number>> = Object.freeze({ high: 64, medium: 64, low: 40 });

/** io §2.4: voice-pool rank when the payload has none [I] */
export const DEFAULT_PRIORITY = 50;

/** io §2.6: the catalogue's own root defaults (`audio.yml:38`) */
export const DEFAULT_REF_DISTANCE = 3;
export const DEFAULT_MAX_DISTANCE = 45;
/** io §2.6: `maxDistance = max(p.maxDistance ?? 45, refDistance + 0.01)` */
export const MIN_DISTANCE_SPAN = 0.01;

/** io §2.6, X-22: HRTF on every desktop tier, equalpower on the mobile tier [I] */
export const PANNING_MODEL: Readonly<Record<AudioTier, 'HRTF' | 'equalpower'>> = Object.freeze({
  high: 'HRTF',
  medium: 'HRTF',
  low: 'equalpower',
});

/** io §2.7: stop = 5 ms linear fade, then `source.stop()` */
export const STOP_FADE_S = 0.005;

/** io §2.2: level changes ramp with this time constant; mute and pause with `MUTE_TC_S` */
export const LEVEL_TC_S = 0.03;
export const MUTE_TC_S = 0.01;
/** io §2.12: after the master ramp to 0 the context is suspended (silent within 100 ms of any pause reason) */
export const PAUSE_SUSPEND_DELAY_MS = 40;

/** io §2.2: brick-wall safety limiter on the master [I][C: peak meter over a soak, WP AU3] */
export const LIMITER = Object.freeze({ threshold: -3, knee: 0, ratio: 20, attack: 0.003, release: 0.25 });

/** io §2.8: fetch → decode jobs in flight */
export const DECODE_CONCURRENCY = 4;

/** io §2.8: a voice whose buffer lands later than this after the emit is dropped (one-shots) or started late (loops) [I] */
export const LATE_START_S = 0.25;

/** io §2.8: decoded PCM budget (float32), least-recently-played idle buffers evicted beyond it */
export const DECODE_BUDGET_BYTES: Readonly<Record<AudioTier, number>> = Object.freeze({
  high: 192 * 2 ** 20,
  medium: 128 * 2 ** 20,
  low: 64 * 2 ** 20,
});

/** io §2.8 flag `audio.monoPositional`: down-mix positional-only clips to one channel after decode (X-44) */
export const MONO_POSITIONAL_DEFAULT = true;

/** a voice whose end passed this long ago without an `ended` event is collected by `frame()` */
export const VOICE_GC_GRACE_S = 0.1;

/** render tier → audio tier (X-22: "audio tier derived"; `low` and `minimum` are the mobile render tiers) */
export function audioTierFor(renderTier: 'high' | 'medium' | 'low' | 'minimum'): AudioTier {
  return renderTier === 'minimum' ? 'low' : renderTier;
}
