import { clipKey } from '../../runtime/audio/clip-registry.ts';
import type { AudioEngine, EntityAudioHandle, EntityAudioSpec } from '../../runtime/audio/types.ts';
import type { MusicPort } from './types.ts';

export interface AudioMusicPort extends MusicPort {
  /** Presentation milliseconds, frozen while paused; call from driver.addFrameListener(frame => port.frame(frame.now)). */
  frame(nowMs: number): void;
  dispose(): void;
}

interface Voice {
  layer: string;
  spec: EntityAudioSpec;
  handle: EntityAudioHandle;
  gain: number;
  from: number;
  to: number;
  start: number;
  end: number;
}

const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const level = (value: unknown, fallback = 1): number => finite(value) ? Math.max(0, Math.min(1, value)) : fallback;
const milliseconds = (value: unknown, fallback = 0): number => (finite(value) ? Math.max(0, value) : fallback) * 1000;
const layerOf = (value: unknown): string => typeof value === 'string' ? value : '';

/** Opt-in engine adapter; audio.init must precede play. Shares the engine's streaming, unlock, mute and pause handling. */
export function createAudioMusicPort(audio: Pick<AudioEngine, 'createEntityAudio'>): AudioMusicPort {
  const layers = new Map<string, Voice>();
  const retiring = new Set<Voice>();
  let now = 0;
  let serial = 0;
  let disposed = false;
  let duckLevel = 1;
  let duckUntil = 0;

  const release = (voice: Voice): void => {
    if (layers.get(voice.layer) === voice) layers.delete(voice.layer);
    retiring.delete(voice);
    try { voice.handle.stop(); } catch { /* Music calls stay fire-and-forget even if the host has shut down. */ }
  };

  const write = (voice: Voice): void => {
    const gain = voice.gain * (voice.layer === '' && now < duckUntil ? duckLevel : 1);
    if (voice.spec.gain === gain) return;
    voice.spec = { ...voice.spec, gain };
    try { voice.handle.update(voice.spec, null); } catch { release(voice); }
  };

  const fade = (voice: Voice, target: number, duration: number): void => {
    voice.from = voice.gain;
    voice.to = target;
    voice.start = now;
    voice.end = now + duration;
    if (duration === 0) voice.gain = target;
    write(voice);
  };

  const retire = (voice: Voice, duration: number): void => {
    // One outgoing voice per layer bounds rapid changes even when no frame has run yet.
    for (const previous of retiring) if (previous.layer === voice.layer) release(previous);
    layers.delete(voice.layer);
    if (duration === 0) release(voice);
    else {
      retiring.add(voice);
      fade(voice, 0, duration);
    }
  };

  return {
    play(clip, options): void {
      if (disposed || typeof clip !== 'string' || clip.length === 0) return;
      const key = clipKey(clip);
      const layer = layerOf(options?.layer);
      const loop = typeof options?.loop === 'boolean' ? options.loop : layer === '';
      const volume = level(options?.volume);
      const duration = milliseconds(options?.fade);
      const previous = layers.get(layer);
      if (previous && !previous.handle.ended && previous.spec.clip === key && previous.spec.loop === loop) {
        if (previous.to !== volume) fade(previous, volume, duration);
        return;
      }
      const gain = duration > 0 ? 0 : volume;
      const spec: EntityAudioSpec = { clip: key, bus: 'music', spatial: false, loop, gain: gain * (layer === '' && now < duckUntil ? duckLevel : 1) };
      let handle: EntityAudioHandle;
      try { handle = audio.createEntityAudio(`music:${++serial}`, spec); } catch { return; }
      if (previous) retire(previous, duration);
      const voice: Voice = { layer, spec, handle, gain, from: gain, to: volume, start: now, end: now + duration };
      layers.set(layer, voice);
    },
    stop(options): void {
      if (disposed) return;
      const layer = layerOf(options?.layer);
      const voice = layers.get(layer);
      if (voice) retire(voice, milliseconds(options?.fade));
      else if (milliseconds(options?.fade) === 0) {
        for (const outgoing of retiring) if (outgoing.layer === layer) release(outgoing);
      }
    },
    duck(value, options): void {
      if (disposed) return;
      duckLevel = level(value);
      duckUntil = now + milliseconds(options?.duration, 1);
      const base = layers.get('');
      if (base) write(base);
      for (const voice of retiring) if (voice.layer === '') write(voice);
    },
    frame(nowMs): void {
      if (disposed || !finite(nowMs)) return;
      now = Math.max(now, nowMs);
      for (const voice of [...layers.values(), ...retiring]) {
        if (voice.handle.ended) { release(voice); continue; }
        const fraction = voice.end <= now ? 1 : (now - voice.start) / (voice.end - voice.start);
        voice.gain = voice.from + (voice.to - voice.from) * fraction;
        if (retiring.has(voice) && fraction === 1) release(voice);
        else write(voice);
      }
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const voice of [...layers.values(), ...retiring]) release(voice);
    },
  };
}
