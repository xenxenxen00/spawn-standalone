// Audio engine types (io §2.3, §2.8; docs/architecture.md §3.0 "AudioEngine (playSound(id, payload, meta))", X-12, X-44).
//
// Two halves:
//   - the engine's public surface (payloads, manifest, options, `AudioEngine`), consumed by the app shell's act wiring (X1),
//     the PauseController (`setPaused` / `setPlatformAudio`), the settings bridge and the rig host (`setListener`);
//   - a narrow structural view of the Web Audio API (`AudioCtxLike` and its nodes): only the members this engine touches, so
//     a real `AudioContext` and the recording fake of tests/unit/audio/fake-context.ts both satisfy it.
import type { Vec3 } from '../../compat/core/types.ts';

export type { Vec3 };

/** io §2.2: the four buses; a payload's `bus` is matched case-insensitively, unknown or absent → `sfx` */
export type BusId = 'music' | 'sfx' | 'ui' | 'ambience';

/** the audio quality tier (io §2.6, X-22): `high`/`medium` on every desktop, `low` on the mobile render tiers */
export type AudioTier = 'low' | 'medium' | 'high';

/** engine/api-reference.md:605, plus the port extension `delay` (E-AUD-01) */
export interface PlaySoundPayload {
  clip: string;
  position?: Vec3;
  volume?: number;
  pitch?: number;
  loop?: boolean;
  mode?: 'overlap' | 'restart';
  bus?: string;
  priority?: number;
  maxDistance?: number;
  refDistance?: number;
  /** never set live; ignored (io §2.4) */
  follow?: boolean;
  /** PORT extension: seconds to wait on the audio clock before starting (catalogue delayed layers, FX-21) */
  delay?: number;
}

export interface StopSoundPayload {
  soundId: string;
}

/**
 * What the act wiring passes with a `playSound` (from the kernel's `ActEnvelope`). X-12: the kernel already ran the one
 * visibility filter, so the engine reads only the emitter, which scopes `mode: 'restart'` (io §2.4, §2.11: clip + shooter).
 */
export interface EmitMeta {
  sourceId: string | null;
  sourcePlace: string | null;
}

/** the presented camera, every frame (io §2.6) */
export interface ListenerPose {
  eye: Vec3;
  forward: Vec3;
  up: Vec3;
}

/** entity `audio` component (contract §9.7; driven by `entity-audio.ts`, WP AU2) */
export interface EntityAudioSpec {
  clip: string;
  loop?: boolean;
  gain?: number;
  spatial?: boolean;
  maxDistance?: number;
  bus?: string;
}
export interface EntityAudioHandle {
  /** Completion or stop, when the host supports it; false while waiting for unlock or loading. */
  readonly ended?: boolean;
  update(spec: EntityAudioSpec, worldPos: Vec3 | null): void;
  stop(): void;
}

/**
 * One clip of the audio manifest (io §2.8): a view over the asset index's audio fields (`u`, `b`, `dur`, `ch`, `mode`, `ls`,
 * `le`, `pos`, `s`). `url` is null for a clip that is silent in live and kept silent (build §5.5).
 */
export interface ClipInfo {
  readonly url: string | null;
  readonly bytes: number;
  /** seconds; 0 when the index has no duration */
  readonly dur: number;
  readonly ch: 1 | 2;
  readonly mode: 'buffer' | 'stream';
  readonly loopStart?: number;
  readonly loopEnd?: number;
  /** played only with a position: down-mixed to one channel after decode (X-44) */
  readonly positionalOnly?: true;
}

/** keyed by the clip key: the live name with `^/?cdn/` stripped (io §2.8) */
export type AudioManifest = Readonly<Record<string, ClipInfo>>;

export interface AudioEngineOptions {
  /** Override the calibrated tier voice count and overlapping instances per clip. */
  voicePoolSize?: number;
  perClipCap?: number;
  defaultRefDistance?: number;
  defaultMaxDistance?: number;
  /** Entity loops have separate calibration from one-shot plays. */
  defaultEntityRefDistance?: number;
  defaultEntityMaxDistance?: number;
  /** from the asset index (`manifestFromIndex`, clip-registry.ts) */
  manifest: AudioManifest;
  tier: AudioTier;
  /** io §2.8 flag `audio.monoPositional` (default true) */
  monoPositional?: boolean;
  log?: (msg: string) => void;
}

export interface AudioStats {
  /** voices holding a pool slot (playing, delayed or waiting for their buffer) */
  voices: number;
  /** of `voices`, waiting for a decode or a `delay` */
  pending: number;
  /** plays refused by the per-clip instance cap */
  refusedPerClip: number;
  /** plays refused because the pool was full of equal or higher priority voices */
  refusedPool: number;
  /** voices stopped to make room for a higher-priority play */
  stolen: number;
  /** plays dropped because their buffer landed more than 250 ms after the emit (one-shots only, io §2.8) */
  late: number;
  /** plays dropped before the first gesture created the context */
  locked: number;
  /** clip keys that are not in the manifest, silent in live, or failed to load */
  missing: number;
  /** decoded PCM held, bytes (float32) */
  decodedBytes: number;
}

export interface AudioEngine {
  /** the context exists and is running */
  readonly ready: boolean;
  /** stores the options; the graph is built when the first gesture creates the context (X-33) */
  init(opts: AudioEngineOptions): void;
  /** call from inside a user gesture handler (io §2.12; `unlock.ts`): creates the context if absent and resumes it */
  unlock(): void;
  /** true while a gesture would do something: no context yet, or a context suspended by the browser rather than by us */
  needsUnlock(): boolean;
  /** X-12: `id` is the kernel-minted 'snd-<n>' already returned to the game; a refused or silent play maps it to no voice */
  playSound(id: string, p: PlaySoundPayload, meta: EmitMeta): void;
  /** unknown / finished / voiceless id: no-op */
  stopSound(p: StopSoundPayload): void;
  createEntityAudio(entityId: string, spec: EntityAudioSpec): EntityAudioHandle;
  /** the rig host / camera presenter, every frame */
  setListener(pose: ListenerPose): void;
  /** 0..1 slider values (`prefs.volMaster/volMusic/volSfx/volAmb`) */
  setLevels(levels: { master: number; music: number; sfx: number; ambience: number }): void;
  setUserMuted(muted: boolean): void;
  /** Bridge AUDIO_STATE_CHANGED */
  setPlatformAudio(enabled: boolean): void;
  /** PauseController: true while any audio-suspending reason is set (X-07) */
  setPaused(paused: boolean): void;
  prefetch(clips: readonly string[], when: 'now' | 'idle'): Promise<void>;
  /** per frame (docs/architecture.md §4.2 step 5): voice GC */
  frame(): void;
  stats(): AudioStats;
  dispose(): void;
}

// ── the Web Audio surface the engine uses (structural; a real AudioContext satisfies it) ─────────────────────────────────

export interface AudioParamLike {
  value: number;
  setValueAtTime(value: number, time: number): unknown;
  setTargetAtTime(target: number, time: number, timeConstant: number): unknown;
  linearRampToValueAtTime(value: number, time: number): unknown;
  cancelScheduledValues(time: number): unknown;
}

export interface AudioNodeLike {
  connect(destination: AudioNodeLike): unknown;
  disconnect(): void;
}

export interface GainNodeLike extends AudioNodeLike {
  readonly gain: AudioParamLike;
}

export interface AudioBufferLike {
  readonly numberOfChannels: number;
  readonly length: number;
  readonly sampleRate: number;
  readonly duration: number;
  getChannelData(channel: number): Float32Array;
}

export interface BufferSourceNodeLike extends AudioNodeLike {
  buffer: AudioBufferLike | null;
  readonly playbackRate: AudioParamLike;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  onended: ((ev: Event) => void) | null;
  start(when?: number, offset?: number): void;
  stop(when?: number): void;
}

export interface PannerNodeLike extends AudioNodeLike {
  panningModel: 'HRTF' | 'equalpower';
  distanceModel: 'linear' | 'inverse' | 'exponential';
  refDistance: number;
  maxDistance: number;
  rolloffFactor: number;
  coneInnerAngle: number;
  coneOuterAngle: number;
  readonly positionX: AudioParamLike;
  readonly positionY: AudioParamLike;
  readonly positionZ: AudioParamLike;
}

export interface CompressorNodeLike extends AudioNodeLike {
  readonly threshold: AudioParamLike;
  readonly knee: AudioParamLike;
  readonly ratio: AudioParamLike;
  readonly attack: AudioParamLike;
  readonly release: AudioParamLike;
}

export interface AudioListenerLike {
  readonly positionX: AudioParamLike;
  readonly positionY: AudioParamLike;
  readonly positionZ: AudioParamLike;
  readonly forwardX: AudioParamLike;
  readonly forwardY: AudioParamLike;
  readonly forwardZ: AudioParamLike;
  readonly upX: AudioParamLike;
  readonly upY: AudioParamLike;
  readonly upZ: AudioParamLike;
}

export type AudioCtxState = 'suspended' | 'running' | 'closed' | 'interrupted';

export interface AudioCtxLike {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly state: AudioCtxState | string;
  readonly destination: AudioNodeLike;
  readonly listener: AudioListenerLike;
  createGain(): GainNodeLike;
  createBufferSource(): BufferSourceNodeLike;
  createPanner(): PannerNodeLike;
  createDynamicsCompressor(): CompressorNodeLike;
  createBuffer(channels: number, length: number, sampleRate: number): AudioBufferLike;
  decodeAudioData(data: ArrayBuffer): Promise<AudioBufferLike>;
  resume(): Promise<void>;
  suspend(): Promise<void>;
  close(): Promise<void>;
  addEventListener(type: 'statechange', listener: () => void): void;
  removeEventListener(type: 'statechange', listener: () => void): void;
}

/** creates the context inside the unlocking gesture; default: `new AudioContext({ latencyHint: 'interactive' })` */
export type AudioCtxFactory = () => AudioCtxLike;
