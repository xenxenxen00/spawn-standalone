// The Web Audio engine (io §2.2-§2.8, §2.12; X-12, X-33, X-44).
//
// Created at boot without a context (X-33); `unlock()` (called by unlock.ts inside the first user gesture) creates the
// `AudioContext` and the graph:
//
//   voice: AudioBufferSourceNode(playbackRate = pitch) → Gain(volume, fade) → [Panner if position] → bus
//   bus music / sfx / ui / ambience → Gain(level²) → master Gain(effectiveMaster) → DynamicsCompressor(limiter) → destination
//
// `playSound(id, payload, meta)` is the `kernel.acts` handler body (X-12): the kernel minted `id`, returned it to the game and ran
// the one visibility filter, so the engine only maps the id to a voice, or to nothing when the clip is silent, the pool
// refuses, or no gesture has created the context yet. Entity `audio` components (`createEntityAudio`) are WP AU2.
import type { FetchLike } from '../../assets/loader.ts';
import { ClipRegistry, clipKey } from './clip-registry.ts';
import { createEntityAudio, type EntityAudioController } from './entity-audio.ts';
import {
  DECODE_BUDGET_BYTES,
  DEFAULT_PRIORITY,
  LATE_START_S,
  LEVEL_TC_S,
  LIMITER,
  MONO_POSITIONAL_DEFAULT,
  MUTE_TC_S,
  PAUSE_SUSPEND_DELAY_MS,
  PER_CLIP_CAP,
  STOP_FADE_S,
  VOICE_GC_GRACE_S,
  VOICE_POOL,
} from './limits.ts';
import { applyListener, distanceParams, isVec3, makePanner, setPannerPosition } from './spatial.ts';
import type {
  AudioBufferLike,
  AudioCtxFactory,
  AudioCtxLike,
  AudioEngine,
  AudioEngineOptions,
  AudioStats,
  AudioTier,
  BufferSourceNodeLike,
  BusId,
  EmitMeta,
  EntityAudioHandle,
  EntityAudioSpec,
  GainNodeLike,
  ListenerPose,
  PannerNodeLike,
  PlaySoundPayload,
  StopSoundPayload,
} from './types.ts';
import { VoicePool, type VoiceRecord } from './voices.ts';

/** a member another work package provides; thrown instead of a silent stand-in */
export class AudioNotWiredError extends Error {
  constructor(member: string, pkg: string) {
    super(`audio engine: ${member} is not wired yet (WP ${pkg})`);
    this.name = 'AudioNotWiredError';
  }
}

const BUSES: readonly BusId[] = ['music', 'sfx', 'ui', 'ambience'];
const BUS_SET: ReadonlySet<string> = new Set(BUSES);

/** io §2.2: bus names match case-insensitively; an unknown or absent bus is `sfx` */
export function busFor(name: unknown): BusId {
  if (typeof name !== 'string') return 'sfx';
  const n = name.toLowerCase();
  return BUS_SET.has(n) ? (n as BusId) : 'sfx';
}

const finite = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

export interface AudioEngineDeps {
  /** opt-in: entity streams at zero gain wait for their first positive gain before creating media elements */
  lazyZeroStreams?: boolean;
  /** default: `new AudioContext({ latencyHint: 'interactive' })` */
  createContext?: AudioCtxFactory;
  /** clip bytes; default globalThis.fetch */
  fetch?: FetchLike;
  /** timers for the suspend that follows the pause fade; default globalThis.setTimeout / clearTimeout */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  /** `prefetch(…, 'idle')`; default requestIdleCallback, else a 0 ms timer */
  requestIdle?: (fn: () => void) => void;
}

/** what the app shell and the entity audio (WP AU2) see beyond the io §2.3 interface */
export interface AudioEngineCore extends AudioEngine {
  /** the context once a gesture created it */
  context(): AudioCtxLike | null;
  /** a bus input node, once the graph exists */
  bus(id: BusId): GainNodeLike | null;
  readonly registry: ClipRegistry | null;
  readonly tier: AudioTier | null;
}

interface Voice extends VoiceRecord {
  readonly loop: boolean;
  readonly pitch: number;
  /** audio time the voice may start (emit + delay) */
  readonly startAt: number;
  readonly gain: GainNodeLike;
  readonly panner: PannerNodeLike | null;
  node: BufferSourceNodeLike | null;
  /** audio time a started one-shot ends; Infinity for loops and unstarted voices */
  endAt: number;
  done: boolean;
}

const defaultContext: AudioCtxFactory = () => {
  if (typeof AudioContext !== 'function') throw new Error('Web Audio is not available');
  return new AudioContext({ latencyHint: 'interactive' }); // a real AudioContext satisfies AudioCtxLike structurally
};

export function createAudioEngine(deps: AudioEngineDeps = {}): AudioEngineCore {
  return new WebAudioEngine(deps);
}

class WebAudioEngine implements AudioEngineCore {
  readonly #lazyZeroStreams: boolean;
  readonly #createContext: AudioCtxFactory;
  readonly #fetch: FetchLike | undefined;
  readonly #setTimer: (fn: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  readonly #requestIdle: (fn: () => void) => void;

  #opts: AudioEngineOptions | null = null;
  #log: (msg: string) => void = (m) => console.warn(`[audio] ${m}`);
  #pool: VoicePool<Voice> | null = null;
  #registry: ClipRegistry | null = null;
  readonly #entities = new Set<EntityAudioController>();

  #ctx: AudioCtxLike | null = null;
  #master: GainNodeLike | null = null;
  readonly #buses = new Map<BusId, GainNodeLike>();
  #primed = false;
  #disposed = false;
  #onState = (): void => {};

  #levels = { master: 1, music: 1, sfx: 1, ambience: 1 };
  #userMuted = false;
  #platformAudio = true;
  #paused = false;
  #suspendTimer: unknown = null;
  #listener: ListenerPose | null = null;

  #late = 0;
  #locked = 0;
  #warnedUninit = false;

  constructor(deps: AudioEngineDeps) {
    this.#lazyZeroStreams = deps.lazyZeroStreams === true;
    this.#createContext = deps.createContext ?? defaultContext;
    this.#fetch = deps.fetch;
    this.#setTimer = deps.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
    this.#clearTimer = deps.clearTimer ?? ((h) => globalThis.clearTimeout(h as ReturnType<typeof setTimeout>));
    const ric = (globalThis as { requestIdleCallback?: (fn: () => void) => unknown }).requestIdleCallback;
    this.#requestIdle = deps.requestIdle ?? (ric ? (fn) => void ric(fn) : (fn) => void globalThis.setTimeout(fn, 0));
  }

  get ready(): boolean {
    return this.#ctx !== null && this.#ctx.state === 'running';
  }
  get registry(): ClipRegistry | null {
    return this.#registry;
  }
  get tier(): AudioTier | null {
    return this.#opts?.tier ?? null;
  }
  context(): AudioCtxLike | null {
    return this.#ctx;
  }
  bus(id: BusId): GainNodeLike | null {
    return this.#buses.get(id) ?? null;
  }

  init(opts: AudioEngineOptions): void {
    if (this.#opts) throw new Error('audio engine: init() called twice');
    const size = opts.voicePoolSize === undefined ? VOICE_POOL[opts.tier] : opts.voicePoolSize;
    const perClipCap = opts.perClipCap === undefined ? PER_CLIP_CAP : opts.perClipCap;
    for (const [name, value] of [['voicePoolSize', size], ['perClipCap', perClipCap]] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`audio engine: ${name} must be a positive safe integer`);
    }
    const pool = new VoicePool<Voice>({ size, perClipCap });
    this.#opts = opts;
    if (opts.log) this.#log = opts.log;
    this.#pool = pool;
    this.#registry = new ClipRegistry({
      manifest: opts.manifest,
      ...(this.#fetch ? { fetch: this.#fetch } : {}),
      budgetBytes: DECODE_BUDGET_BYTES[opts.tier],
      monoPositional: opts.monoPositional ?? MONO_POSITIONAL_DEFAULT,
      isPlaying: (key) => pool.countOf(key) > 0 || [...this.#entities].some((entity) => entity.protectsClip(key)),
      log: this.#log,
    });
  }

  // ── lifecycle (io §2.12) ───────────────────────────────────────────────────────────────────────────────────────────

  needsUnlock(): boolean {
    if (this.#disposed || !this.#opts) return false;
    const ctx = this.#ctx;
    if (!ctx) return true;
    return !this.#paused && ctx.state !== 'running' && ctx.state !== 'closed';
  }

  unlock(): void {
    if (this.#disposed) return;
    if (!this.#opts) {
      if (!this.#warnedUninit) this.#log('unlock() before init(): ignored');
      this.#warnedUninit = true;
      return;
    }
    let ctx = this.#ctx;
    if (!ctx) {
      try {
        ctx = this.#createContext();
      } catch (err) {
        this.#log(`no audio context: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
      this.#ctx = ctx;
      this.#buildGraph(ctx);
      this.#onState = () => {
        // a browser-side suspend (iOS call, Safari backgrounding) shows through needsUnlock(); a resume by someone else
        // while we hold a pause is undone
        if (this.#paused && ctx!.state === 'running' && this.#suspendTimer === null) this.#suspendNow();
      };
      ctx.addEventListener('statechange', this.#onState);
      this.#registry!.attach(ctx);
      if (this.#listener) applyListener(ctx.listener, this.#listener, ctx.currentTime);
      for (const entity of this.#entities) entity.frame();
    }
    if (!this.#primed) {
      // a 1-sample silent buffer started inside the gesture (io §2.12)
      this.#primed = true;
      const src = ctx.createBufferSource();
      src.buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      src.connect(ctx.destination);
      src.start(0);
    }
    if (this.#paused) {
      if (ctx.state === 'running') this.#suspendNow();
      return;
    }
    if (ctx.state !== 'running' && ctx.state !== 'closed') this.#resume(ctx);
  }

  setPaused(paused: boolean): void {
    if (this.#disposed) return;
    if (paused === this.#paused) return;
    this.#paused = paused;
    for (const entity of this.#entities) entity.setPaused(paused);
    this.#applyMaster(MUTE_TC_S);
    const ctx = this.#ctx;
    if (!ctx) return;
    if (paused) {
      // master ramps to 0, then the context is suspended (silent well within 100 ms)
      this.#suspendTimer = this.#setTimer(() => {
        this.#suspendTimer = null;
        if (this.#paused) this.#suspendNow();
      }, PAUSE_SUSPEND_DELAY_MS);
    } else {
      if (this.#suspendTimer !== null) this.#clearTimer(this.#suspendTimer);
      this.#suspendTimer = null;
      if (ctx.state !== 'running' && ctx.state !== 'closed') this.#resume(ctx);
    }
  }

  setUserMuted(muted: boolean): void {
    this.#userMuted = muted;
    this.#applyMaster(MUTE_TC_S);
  }

  setPlatformAudio(enabled: boolean): void {
    this.#platformAudio = enabled;
    this.#applyMaster(MUTE_TC_S);
  }

  setLevels(levels: { master: number; music: number; sfx: number; ambience: number }): void {
    const prev = this.#levels;
    const clamp = (x: number, old: number): number => (finite(x) ? Math.min(1, Math.max(0, x)) : old);
    this.#levels = {
      master: clamp(levels.master, prev.master),
      music: clamp(levels.music, prev.music),
      sfx: clamp(levels.sfx, prev.sfx),
      ambience: clamp(levels.ambience, prev.ambience),
    };
    const ctx = this.#ctx;
    if (!ctx) return;
    for (const id of BUSES) this.#buses.get(id)!.gain.setTargetAtTime(this.#busLevel(id), ctx.currentTime, LEVEL_TC_S);
    this.#applyMaster(LEVEL_TC_S);
  }

  setListener(pose: ListenerPose): void {
    this.#listener = pose;
    const ctx = this.#ctx;
    if (ctx) applyListener(ctx.listener, pose, ctx.currentTime);
  }

  // ── acts (X-12) ────────────────────────────────────────────────────────────────────────────────────────────────────

  playSound(id: string, p: PlaySoundPayload, meta: EmitMeta): void {
    const reg = this.#registry;
    const pool = this.#pool;
    const tier = this.#opts?.tier;
    if (!reg || !pool || !tier || this.#disposed) return;
    if (!p || typeof p.clip !== 'string') return;
    const ctx = this.#ctx;
    if (!ctx) {
      this.#locked++;
      return;
    }
    const key = clipKey(p.clip);
    const info = reg.info(key);
    if (!info || info.url === null) {
      reg.reportSilent(key);
      return;
    }
    if (reg.status(key) === 'failed') return;

    const now = ctx.currentTime;
    const mode = p.mode === 'restart' ? 'restart' : 'overlap';
    const source = meta?.sourceId ?? null;
    if (mode === 'restart') for (const v of pool.restartScope(key, source)) this.#stopVoice(v, now);
    const existing = pool.get(id);
    if (existing) this.#stopVoice(existing, now);

    const position = isVec3(p.position) ? p.position : null;
    const gain = ctx.createGain();
    const dist = position ? distanceParams(p, { refDistance: this.#opts?.defaultRefDistance, maxDistance: this.#opts?.defaultMaxDistance }) : null;
    const panner = dist ? makePanner(ctx, dist.ref, dist.max, tier) : null;
    const voice: Voice = {
      id,
      clip: key,
      source,
      priority: finite(p.priority) ? p.priority : DEFAULT_PRIORITY,
      loop: p.loop === true,
      pitch: finite(p.pitch) && p.pitch > 0 ? p.pitch : 1,
      startAt: now + (finite(p.delay) && p.delay > 0 ? p.delay : 0),
      gain,
      panner,
      node: null,
      endAt: Infinity,
      done: false,
    };
    const admitted = pool.start(voice, mode);
    if (!admitted.ok) return;
    if (admitted.stolen) this.#stopVoice(admitted.stolen, now);

    gain.gain.value = finite(p.volume) ? p.volume : 1; // linear, not clamped (io §2.4)
    const bus = this.#buses.get(busFor(p.bus))!;
    if (panner && position) {
      setPannerPosition(panner, position, now);
      gain.connect(panner);
      panner.connect(bus);
    } else gain.connect(bus);

    const buf = reg.get(key);
    if (buf) this.#startVoice(ctx, voice, buf);
    else
      void reg.load(key).then((b) => {
        if (voice.done || this.#ctx !== ctx) return;
        if (!b) this.#release(voice);
        else this.#startVoice(ctx, voice, b);
      });
  }

  stopSound(p: StopSoundPayload): void {
    const id = p?.soundId;
    if (typeof id !== 'string' || !this.#pool || !this.#ctx) return;
    const v = this.#pool.get(id);
    if (v) this.#stopVoice(v, this.#ctx.currentTime);
  }

  createEntityAudio(entityId: string, spec: EntityAudioSpec): EntityAudioHandle {
    if (this.#disposed) throw new Error('audio engine: createEntityAudio() after dispose()');
    if (!this.#opts || !this.#registry) throw new Error('audio engine: createEntityAudio() before init()');
    const controller = createEntityAudio(entityId, spec, {
      context: () => this.#ctx,
      registry: () => this.#registry,
      bus: (id) => this.#buses.get(id) ?? null,
      tier: () => this.#opts?.tier ?? null,
      paused: () => this.#paused,
      distanceDefaults: { refDistance: this.#opts.defaultEntityRefDistance, maxDistance: this.#opts.defaultEntityMaxDistance },
      lazyZeroStreams: this.#lazyZeroStreams,
      log: this.#log,
      setTimer: this.#setTimer,
      clearTimer: this.#clearTimer,
      onStop: (handle) => this.#entities.delete(handle),
    });
    this.#entities.add(controller);
    return controller;
  }

  prefetch(clips: readonly string[], when: 'now' | 'idle'): Promise<void> {
    const reg = this.#registry;
    if (!reg) return Promise.resolve();
    if (when === 'now') return reg.prefetch(clips);
    return new Promise<void>((resolve) => this.#requestIdle(() => void reg.prefetch(clips).then(resolve)));
  }

  frame(): void {
    for (const entity of this.#entities) entity.frame();
    const ctx = this.#ctx;
    const pool = this.#pool;
    if (!ctx || !pool) return;
    const t = ctx.currentTime;
    for (const v of pool.values()) if (v.endAt + VOICE_GC_GRACE_S < t) this.#release(v);
  }

  stats(): AudioStats {
    const pool = this.#pool?.stats() ?? { voices: 0, refusedPerClip: 0, refusedPool: 0, stolen: 0 };
    const reg = this.#registry?.stats() ?? { decodedBytes: 0, missing: 0 };
    const t = this.#ctx?.currentTime ?? 0;
    let pending = 0;
    if (this.#pool) for (const v of this.#pool.values()) if (!v.node || v.startAt > t) pending++;
    return { ...pool, pending, late: this.#late, locked: this.#locked, missing: reg.missing, decodedBytes: reg.decodedBytes };
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const entity of this.#entities) entity.dispose();
    this.#entities.clear();
    if (this.#suspendTimer !== null) this.#clearTimer(this.#suspendTimer);
    this.#suspendTimer = null;
    const ctx = this.#ctx;
    if (this.#pool && ctx) {
      for (const v of this.#pool.values()) {
        if (v.node) v.node.stop(ctx.currentTime);
        this.#release(v);
      }
    }
    if (ctx) {
      ctx.removeEventListener('statechange', this.#onState);
      void ctx.close().catch(() => {});
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────────────────────────────

  #buildGraph(ctx: AudioCtxLike): void {
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = LIMITER.threshold;
    lim.knee.value = LIMITER.knee;
    lim.ratio.value = LIMITER.ratio;
    lim.attack.value = LIMITER.attack;
    lim.release.value = LIMITER.release;
    lim.connect(ctx.destination);
    const master = ctx.createGain();
    master.gain.value = this.#effectiveMaster();
    master.connect(lim);
    this.#master = master;
    for (const id of BUSES) {
      const g = ctx.createGain();
      g.gain.value = this.#busLevel(id);
      g.connect(master);
      this.#buses.set(id, g);
    }
  }

  /** io §2.2: `(muted || !platformAudio || paused) ? 0 : volMaster²` */
  #effectiveMaster(): number {
    return this.#userMuted || !this.#platformAudio || this.#paused ? 0 : this.#levels.master ** 2;
  }

  #busLevel(id: BusId): number {
    const l = this.#levels;
    return (id === 'music' ? l.music : id === 'ambience' ? l.ambience : l.sfx) ** 2;
  }

  #applyMaster(tc: number): void {
    const ctx = this.#ctx;
    if (!ctx || !this.#master) return;
    this.#master.gain.setTargetAtTime(this.#effectiveMaster(), ctx.currentTime, tc);
  }

  #resume(ctx: AudioCtxLike): void {
    void ctx.resume().catch((err: unknown) => this.#log(`resume failed: ${err instanceof Error ? err.message : String(err)}`));
  }

  #suspendNow(): void {
    const ctx = this.#ctx;
    if (!ctx || ctx.state === 'closed') return;
    void ctx.suspend().catch(() => {});
  }

  #startVoice(ctx: AudioCtxLike, v: Voice, buf: AudioBufferLike): void {
    const now = ctx.currentTime;
    const lateness = now - v.startAt;
    let offset = 0;
    if (lateness > 0) {
      if (lateness > LATE_START_S) {
        if (!v.loop) {
          this.#late++;
          this.#release(v);
          return;
        }
      } else offset = lateness * v.pitch;
    }
    if (!v.loop && offset >= buf.duration) {
      this.#release(v);
      return;
    }
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = v.pitch;
    if (v.loop) {
      src.loop = true;
      const info = this.#registry?.info(v.clip);
      if (info?.loopStart !== undefined) src.loopStart = info.loopStart;
      if (info?.loopEnd !== undefined) src.loopEnd = info.loopEnd;
    }
    src.connect(v.gain);
    src.onended = () => this.#release(v);
    const when = Math.max(v.startAt, now);
    src.start(when, offset);
    v.node = src;
    v.endAt = v.loop ? Infinity : when + (buf.duration - offset) / v.pitch;
  }

  /** 5 ms fade then stop (io §2.7); a voice still waiting for its buffer or its delay never sounds */
  #stopVoice(v: Voice, t: number): void {
    this.#pool?.stop(v.id);
    if (v.done) return;
    const g = v.gain.gain;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0, t + STOP_FADE_S);
    if (v.node) {
      v.node.stop(t + STOP_FADE_S);
      v.endAt = t + STOP_FADE_S;
    } else this.#release(v);
  }

  #release(v: Voice): void {
    if (this.#pool?.get(v.id) === v) this.#pool.stop(v.id);
    if (v.done) return;
    v.done = true;
    v.node?.disconnect();
    v.gain.disconnect();
    v.panner?.disconnect();
  }
}
