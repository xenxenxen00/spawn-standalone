// Entity audio components (docs/design/audio-ui-input.md §2.9; spawn-engine-contract.md §9.7) are independent of the
// one-shot voice pool. Their loop lifetime follows the entity row, while the component can update gain and world position.
import type { ClipRegistry } from './clip-registry.ts';
import { clipKey } from './clip-registry.ts';
import { LEVEL_TC_S, STOP_FADE_S } from './limits.ts';
import { distanceParams, isVec3, makePanner, setPannerPosition, type DistanceOptions } from './spatial.ts';
import { createStreamLoop, type StreamLoopHandle, type StreamLoopOptions } from './stream-loop.ts';
import type {
  AudioBufferLike,
  AudioCtxLike,
  AudioTier,
  BusId,
  EntityAudioHandle,
  EntityAudioSpec,
  GainNodeLike,
  PannerNodeLike,
  Vec3,
} from './types.ts';

const ENTITY_REF_DISTANCE = 1;
const DEFAULT_ENTITY_MAX_DISTANCE = 45;
const BUS_SET: ReadonlySet<string> = new Set(['music', 'sfx', 'ui', 'ambience']);

function busFor(name: unknown): BusId {
  if (typeof name !== 'string') return 'sfx';
  const normalized = name.toLowerCase();
  return BUS_SET.has(normalized) ? (normalized as BusId) : 'sfx';
}

export interface EntityAudioDeps {
  distanceDefaults?: DistanceOptions;
  context(): AudioCtxLike | null;
  registry(): ClipRegistry | null;
  bus(id: BusId): GainNodeLike | null;
  tier(): AudioTier | null;
  paused(): boolean;
  lazyZeroStreams?: boolean;
  log?: (message: string) => void;
  streamOptions?: StreamLoopOptions;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
  onStop?: (handle: EntityAudioController) => void;
}

export interface EntityAudioController extends EntityAudioHandle {
  /** called when the context is created or once per frame so spatial rows follow their entity */
  frame(): void;
  /** true while this row retains a decoded buffer that the registry must not evict */
  protectsClip(key: string): boolean;
  /** pause media elements immediately; AudioContext suspension handles buffer sources */
  setPaused(paused: boolean): void;
  /** immediate teardown for engine disposal */
  dispose(): void;
}

interface ActiveAudio {
  readonly signature: string;
  readonly key: string;
  readonly info: NonNullable<ReturnType<ClipRegistry['info']>>;
  readonly loop: boolean;
  readonly gain: GainNodeLike;
  readonly panner: PannerNodeLike | null;
  readonly context: AudioCtxLike;
  readonly bus: GainNodeLike;
  source: ReturnType<AudioCtxLike['createBufferSource']> | null;
  stream: StreamLoopHandle | null;
  buffer: AudioBufferLike | null;
  started: boolean;
  loading: boolean;
  ended: boolean;
  cleaned: boolean;
  lastGain: number;
  stopTimer: unknown;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const gainOf = (spec: EntityAudioSpec): number => (finite(spec.gain) ? Math.max(0, Math.min(2, spec.gain)) : 1);

/** One row's audio voice; `update` accepts the row's current audio spec and world position. */
export function createEntityAudio(entityId: string, initialSpec: EntityAudioSpec, deps: EntityAudioDeps): EntityAudioController {
  const defaults = distanceParams(deps.distanceDefaults ?? {}, { refDistance: ENTITY_REF_DISTANCE, maxDistance: DEFAULT_ENTITY_MAX_DISTANCE });
  const distances = (value: EntityAudioSpec) => distanceParams(value, { refDistance: defaults.ref, maxDistance: defaults.max });
  let spec: EntityAudioSpec = { ...initialSpec };
  let worldPos: Vec3 | null = null;
  let paused = deps.paused();
  let dead = false;
  let active: ActiveAudio | null = null;
  const retiring = new Set<ActiveAudio>();
  const log = deps.log ?? ((message: string) => console.warn(`[audio:${entityId}] ${message}`));
  const setTimer = deps.setTimer ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));

  const cleanup = (voice: ActiveAudio, immediate = true): void => {
    if (voice.cleaned) return;
    voice.cleaned = true;
    if (voice.stopTimer !== null) clearTimer(voice.stopTimer);
    voice.stopTimer = null;
    if (immediate) {
      voice.stream?.stop();
      if (voice.source) {
        try {
          voice.source.stop(voice.context.currentTime);
        } catch {
          // A source that finished or never started is already quiet.
        }
      }
    }
    voice.source?.disconnect();
    voice.gain.disconnect();
    voice.panner?.disconnect();
    voice.buffer = null;
    retiring.delete(voice);
  };

  const retire = (voice: ActiveAudio, fade: boolean, onRetired?: () => void): void => {
    if (voice.cleaned) {
      onRetired?.();
      return;
    }
    if (!fade || !voice.started) {
      cleanup(voice);
      onRetired?.();
      return;
    }
    retiring.add(voice);
    const now = voice.context.currentTime;
    const param = voice.gain.gain;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(0, now + STOP_FADE_S);
    if (voice.source) {
      try {
        voice.source.stop(now + STOP_FADE_S);
      } catch {
        // It may have ended between the entity update and the stop write.
      }
    }
    voice.stopTimer = setTimer(() => {
      voice.stream?.stop();
      cleanup(voice, false);
      onRetired?.();
    }, STOP_FADE_S * 1000 + 1);
  };

  const signatureFor = (key: string, mode: string, next: EntityAudioSpec): string =>
    `${key}|${mode}|${next.loop === true ? 1 : 0}|${next.spatial === true ? 1 : 0}|${distances(next).max}|${busFor(next.bus)}`;

  const updateGainAndPosition = (voice: ActiveAudio): void => {
    const desired = gainOf(spec);
    if (desired !== voice.lastGain) {
      voice.gain.gain.setTargetAtTime(desired, voice.context.currentTime, LEVEL_TC_S);
      voice.lastGain = desired;
    }
    if (voice.panner && isVec3(worldPos)) setPannerPosition(voice.panner, worldPos, voice.context.currentTime);
  };

  const onEnded = (voice: ActiveAudio): void => {
    if (voice.cleaned) return;
    voice.ended = true;
    cleanup(voice, false);
  };

  const startBuffer = (voice: ActiveAudio): void => {
    if (voice.started || voice.ended || paused || !voice.buffer || active !== voice) return;
    const source = voice.context.createBufferSource();
    source.buffer = voice.buffer;
    source.loop = voice.loop;
    if (voice.loop) {
      if (voice.info.loopStart !== undefined) source.loopStart = voice.info.loopStart;
      if (voice.info.loopEnd !== undefined) source.loopEnd = voice.info.loopEnd;
    }
    source.connect(voice.gain);
    source.onended = () => onEnded(voice);
    source.start(voice.context.currentTime);
    voice.source = source;
    voice.started = true;
  };

  const makeActive = (ctx: AudioCtxLike, registry: ClipRegistry, key: string, info: NonNullable<ReturnType<ClipRegistry['info']>>, signature: string): ActiveAudio | null => {
    const bus = deps.bus(busFor(spec.bus));
    const tier = deps.tier();
    if (!bus || !tier) return null;
    const gain = ctx.createGain();
    const initialGain = gainOf(spec);
    gain.gain.value = initialGain;
    const dist = distances(spec);
    const panner = spec.spatial === true
      ? makePanner(ctx, dist.ref, dist.max, tier)
      : null;
    if (panner) {
      if (isVec3(worldPos)) setPannerPosition(panner, worldPos, ctx.currentTime);
      gain.connect(panner);
      panner.connect(bus);
    } else gain.connect(bus);
    return {
      signature,
      key,
      info,
      loop: spec.loop === true,
      gain,
      panner,
      context: ctx,
      bus,
      source: null,
      stream: null,
      buffer: null,
      started: false,
      loading: false,
      ended: false,
      cleaned: false,
      lastGain: initialGain,
      stopTimer: null,
    };
  };

  const sync = (): void => {
    if (dead || typeof spec?.clip !== 'string') {
      if (active) {
        const previous = active;
        active = null;
        retire(previous, true);
      }
      return;
    }
    const ctx = deps.context();
    const registry = deps.registry();
    if (!ctx || !registry) return;
    const key = clipKey(spec.clip);
    const info = registry.info(key);
    if (!info || info.url === null) {
      registry.reportSilent(key);
      if (active) {
        const previous = active;
        active = null;
        retire(previous, true);
      }
      return;
    }
    const signature = signatureFor(key, info.mode, spec);
    if (active && active.signature !== signature) {
      const previous = active;
      active = null;
      retire(previous, true);
    }
    if (!active) active = makeActive(ctx, registry, key, info, signature);
    const voice = active;
    if (!voice || voice.ended || voice.cleaned || voice.context !== ctx) return;
    updateGainAndPosition(voice);
    if (info.mode === 'stream') {
      if (!voice.stream) {
        if (deps.lazyZeroStreams === true && gainOf(spec) === 0) return;
        voice.stream = createStreamLoop(ctx, info, voice.gain, {
          ...deps.streamOptions,
          loop: voice.loop,
          log,
        });
        voice.stream.setPaused(paused);
        voice.stream.start();
        voice.started = true;
      }
      return;
    }
    if (!voice.buffer && !voice.loading) {
      voice.loading = true;
      void registry.load(key).then((buffer) => {
        voice.loading = false;
        if (active !== voice || dead || voice.cleaned) return;
        if (!buffer) {
          voice.ended = true;
          cleanup(voice, false);
          return;
        }
        voice.buffer = buffer;
        startBuffer(voice);
      });
    } else startBuffer(voice);
  };

  const controller: EntityAudioController = {
    get ended(): boolean {
      return dead || active?.ended === true || active?.stream?.ended === true;
    },
    update(next, pos): void {
      if (dead) return;
      spec = { ...next };
      worldPos = isVec3(pos) ? pos : null;
      sync();
    },
    stop(): void {
      if (dead) return;
      dead = true;
      const previous = active;
      active = null;
      if (previous) retire(previous, true, () => deps.onStop?.(controller));
      else deps.onStop?.(controller);
    },
    frame(): void {
      sync();
    },
    protectsClip(key): boolean {
      return active?.key === clipKey(key) && active.buffer !== null && !active.cleaned;
    },
    setPaused(value): void {
      if (dead || value === paused) return;
      paused = value;
      active?.stream?.setPaused(value);
      if (!paused) sync();
    },
    dispose(): void {
      dead = true;
      if (active) cleanup(active);
      active = null;
      for (const voice of retiring) cleanup(voice);
      deps.onStop?.(controller);
    },
  };

  sync();
  return controller;
}
