// Long clips use media elements instead of decoded AudioBuffers (docs/design/audio-ui-input.md §2.8-2.9; X-44).
// When manifest loop points are available, a second element starts at `loopStart` before the current one reaches `loopEnd`;
// equal-power curves cover the seam and the sources alternate. The context does not own media playback, so pause stops both.
import type { AudioCtxLike, AudioNodeLike, ClipInfo, GainNodeLike } from './types.ts';

export const STREAM_CROSSFADE_S = 1.5;
const STREAM_TICK_MS = 50;
const CURVE_STEPS = 32;

export interface StreamMediaElement {
  src: string;
  preload: string;
  crossOrigin: string | null;
  loop: boolean;
  currentTime: number;
  duration: number;
  readyState: number;
  paused: boolean;
  play(): Promise<void>;
  pause(): void;
  load(): void;
  removeAttribute(name: string): void;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions): void;
}

export interface StreamLoopHandle {
  readonly ended: boolean;
  start(): void;
  setPaused(paused: boolean): void;
  stop(): void;
}

export interface StreamLoopOptions {
  /** default: `document.createElement('audio')`; injectable so Node tests do not need a DOM */
  createElement?: () => StreamMediaElement;
  /** default: `context.createMediaElementSource(element)` */
  createSource?: (context: AudioCtxLike, element: StreamMediaElement) => AudioNodeLike;
  /** seconds; default 1.5 */
  crossfadeSeconds?: number;
  /** default true */
  loop?: boolean;
  /** default console.warn */
  log?: (message: string) => void;
}

function defaultElement(): StreamMediaElement {
  const doc = (globalThis as { document?: Document }).document;
  if (!doc?.createElement) throw new Error('audio stream: document.createElement is unavailable');
  return doc.createElement('audio') as unknown as StreamMediaElement;
}

function defaultSource(ctx: AudioCtxLike, element: StreamMediaElement): AudioNodeLike {
  const make = (ctx as AudioCtxLike & { createMediaElementSource?: (element: HTMLMediaElement) => AudioNodeLike }).createMediaElementSource;
  if (typeof make !== 'function') throw new Error('audio stream: AudioContext.createMediaElementSource is unavailable');
  return make.call(ctx, element as unknown as HTMLMediaElement);
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function createStreamLoop(
  context: AudioCtxLike,
  info: ClipInfo,
  destination: GainNodeLike,
  options: StreamLoopOptions = {},
): StreamLoopHandle {
  if (info.url === null) throw new Error('audio stream: silent clips cannot be streamed');
  const createElement = options.createElement ?? defaultElement;
  const createSource = options.createSource ?? defaultSource;
  const log = options.log ?? ((message: string) => console.warn(`[audio] ${message}`));
  const loopStart = finite(info.loopStart) && info.loopStart >= 0 ? info.loopStart : 0;
  const loopEnd = finite(info.loopEnd) && info.loopEnd > loopStart ? info.loopEnd : info.dur;
  const hasLoopRange = finite(loopEnd) && loopEnd > loopStart;
  const looping = options.loop ?? true;
  const crossfade = Math.min(options.crossfadeSeconds ?? STREAM_CROSSFADE_S, looping && hasLoopRange ? (loopEnd - loopStart) / 2 : 0);
  const seamless = crossfade > 0 && hasLoopRange;
  const count = seamless ? 2 : 1;
  const elements: StreamMediaElement[] = [];
  const gains: GainNodeLike[] = [];
  const sources: AudioNodeLike[] = [];
  for (let i = 0; i < count; i++) {
    const element = createElement();
    element.preload = 'auto';
    element.crossOrigin = 'anonymous';
    element.loop = !seamless && looping;
    element.src = info.url;
    const gain = context.createGain();
    gain.gain.value = i === 0 ? 1 : 0;
    const source = createSource(context, element);
    source.connect(gain);
    gain.connect(destination);
    elements.push(element);
    gains.push(gain);
    sources.push(source);
    element.addEventListener('ended', () => onEnded(i));
  }

  let active = 0;
  let paused = false;
  let started = false;
  let disposed = false;
  let ended = false;
  let crossing = false;
  let tickTimer: ReturnType<typeof setInterval> | null = null;
  let swapTimer: ReturnType<typeof setTimeout> | null = null;
  let crossfadeEndsAt = 0;

  const seek = (index: number): void => {
    const element = elements[index]!;
    try {
      element.currentTime = loopStart;
    } catch {
      // Browsers reject seeking until metadata is available; do the same seek as soon as it arrives.
      const onMetadata = (): void => {
        element.removeEventListener('loadedmetadata', onMetadata);
        if (!disposed) {
          try {
            element.currentTime = loopStart;
          } catch {
            // The stream is silent if the browser still cannot seek it.
          }
        }
      };
      element.addEventListener('loadedmetadata', onMetadata, { once: true });
    }
  };

  const playElement = (index: number): void => {
    const element = elements[index]!;
    try {
      void Promise.resolve(element.play()).catch((error: unknown) => {
        log(`stream play failed: ${error instanceof Error ? error.message : String(error)}`);
      });
    } catch (error) {
      log(`stream play failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  const clearTick = (): void => {
    if (tickTimer !== null) globalThis.clearInterval(tickTimer);
    tickTimer = null;
  };

  const clearSwap = (): void => {
    if (swapTimer !== null) globalThis.clearTimeout(swapTimer);
    swapTimer = null;
  };

  const stopElement = (index: number): void => {
    const element = elements[index]!;
    element.pause();
    try {
      element.currentTime = loopStart;
    } catch {
      // A stopped stream does not need a seek if its metadata has not loaded.
    }
  };

  const finishCrossfade = (): void => {
    if (!crossing || disposed) return;
    clearSwap();
    const old = active;
    active = 1 - active;
    crossing = false;
    stopElement(old);
    const now = context.currentTime;
    const oldGain = gains[old]!.gain;
    oldGain.cancelScheduledValues(now);
    oldGain.setValueAtTime(0, now);
    const nextGain = gains[active]!.gain;
    nextGain.cancelScheduledValues(now);
    nextGain.setValueAtTime(1, now);
    if (!paused) startTicker();
  };

  function onEnded(index: number): void {
    if (!looping && started && !disposed) ended = true;
    if (disposed || !seamless || !started || paused) return;
    if (crossing && index === active) {
      finishCrossfade();
      return;
    }
    if (!crossing && index === active) {
      seek(active);
      playElement(active);
    }
  }

  const scheduleEqualPower = (from: number, to: number, at: number, seconds: number): void => {
    const a = gains[from]!.gain;
    const b = gains[to]!.gain;
    a.cancelScheduledValues(at);
    b.cancelScheduledValues(at);
    a.setValueAtTime(1, at);
    b.setValueAtTime(0, at);
    for (let i = 1; i <= CURVE_STEPS; i++) {
      const x = i / CURVE_STEPS;
      const time = at + seconds * x;
      a.linearRampToValueAtTime(Math.cos(x * Math.PI / 2), time);
      b.linearRampToValueAtTime(Math.sin(x * Math.PI / 2), time);
    }
  };

  const tick = (): void => {
    if (disposed || paused || !started || !seamless || crossing) return;
    const current = elements[active]!;
    if (!finite(current.currentTime) || current.currentTime < loopEnd - crossfade) return;
    const next = 1 - active;
    seek(next);
    const nextGain = gains[next]!.gain;
    nextGain.cancelScheduledValues(context.currentTime);
    nextGain.setValueAtTime(0, context.currentTime);
    playElement(next);
    crossing = true;
    crossfadeEndsAt = context.currentTime + crossfade;
    scheduleEqualPower(active, next, context.currentTime, crossfade);
    swapTimer = globalThis.setTimeout(finishCrossfade, crossfade * 1000);
  };

  function startTicker(): void {
    if (!seamless || paused || disposed || tickTimer !== null) return;
    tickTimer = globalThis.setInterval(tick, STREAM_TICK_MS);
  }

  return {
    get ended(): boolean { return ended; },
    start(): void {
      if (disposed || started) return;
      started = true;
      seek(active);
      if (!paused) {
        playElement(active);
        startTicker();
      }
    },
    setPaused(value): void {
      if (disposed || value === paused) return;
      paused = value;
      if (paused) {
        clearTick();
        clearSwap();
        elements.forEach((element) => element.pause());
      } else if (started) {
        playElement(active);
        if (crossing) {
          playElement(1 - active);
          const remaining = Math.max(0, crossfadeEndsAt - context.currentTime);
          swapTimer = globalThis.setTimeout(finishCrossfade, remaining * 1000);
        } else startTicker();
      }
    },
    stop(): void {
      if (disposed) return;
      disposed = true;
      clearTick();
      clearSwap();
      elements.forEach((element, i) => {
        element.pause();
        element.removeAttribute('src');
        element.load();
        sources[i]!.disconnect();
        gains[i]!.disconnect();
      });
    },
  };
}
