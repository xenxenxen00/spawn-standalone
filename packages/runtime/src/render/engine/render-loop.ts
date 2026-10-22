// Render loop (docs/design/rendering.md §3.4; docs/architecture.md X-08, X-11, X-46, §4.2; WP R0).
//
// One frame driver (src/app/frame.ts) owns the frame step and its order; the renderer exposes entry points and the loop source.
//
//   update(frame)      §4.2 step 4: the presentation stages in their fixed order (feed drain, render bridge, mixer presentation,
//                      corpse-bake slice, fx, decals, lights, the shader `time`, texture uploads). Each stage belongs to a later
//                      work package and registers itself with `setStage`; the shader time is this module's:
//                      `setShaderTime(frame.now)` sets `builtin/tsl`'s `time` to `(now / 1000) % 3600`. `frame.now` is the
//                      PresentationClock's (no paused time, frozen by hitstop), and the driver skips `update` while paused, so
//                      every TSL graph that reads `time` pauses with the game.
//   render()           §4.2 step 6: `pipeline.render()`. Callable at any time. The first call that really drew fires
//                      `onFirstFrame` (it removes the canvas veil; it is not `game_ready`, X-04).
//   setAnimationLoop   the hand-over of X-08. `renderer.init()` starts three's own animation loop, which calls
//                      `requestAnimationFrame` for the renderer's whole life, resets `renderer.info`, advances the node frame and
//                      then calls the callback given to `setAnimationLoop`; the public API cannot stop it (X-46). So when the
//                      engine attaches, the driver cancels its own chain and hands its step over here. The step then runs once
//                      per animation frame: through three's loop while a renderer is attached, through this module's own
//                      `requestAnimationFrame` while there is none (a device-loss rebuild, render §3.1). The page has exactly
//                      one rAF chain. A lost device alone does not move the step: three's loop keeps calling it and `render()`
//                      draws nothing.
//   resize             the canvas host's pending resize is flushed here, once per animation frame before the step, so the
//                      host needs no rAF of its own and render targets resize in the same frame. A resize that the step does
//                      not answer with a `render()` (paused, or the menu covers the scene) gets one from here, because a resized
//                      canvas is blank until it is drawn again.
import { setShaderTime, shaderTimeSeconds } from '../shader-time.ts';

/** docs/architecture.md §3.0 (declared with the frame driver in src/app; the same shape) */
export interface FrameInfo {
  /** presentation ms (PresentationClock: excludes paused time; X-11) */
  now: number;
  /** presentation seconds this frame, 0 during hitstop, clamped to 1/20 */
  dt: number;
  /** wall seconds since the previous frame (governor) */
  realDt: number;
  /** interpolation fraction between the last two 30 Hz ticks, from kernel.advance */
  alpha: number;
  frameIndex: number;
  paused: boolean;
}

/** render §3.4 */
export interface RenderLoop {
  /** RowFeed drain, interpolation, mixer presentation, fx, decals, lights */
  update(frame: FrameInfo): void;
  /** pipeline.render(): scene pass + post */
  render(): void;
  /** the frame driver's step (X-08 hand-over) */
  setAnimationLoop(step: ((timeMs: number) => void) | null): void;
  /** first presented frame: removes the canvas veil (not game_ready, X-04) */
  onFirstFrame(cb: () => void): () => void;
}

/** the presentation stages of docs/architecture.md §4.2 step 4, in order */
export const UPDATE_STAGES = Object.freeze(['feed', 'bridge', 'mixer', 'corpses', 'fx', 'decals', 'lights', 'shaderTime', 'uploads'] as const);
export type UpdateStage = (typeof UPDATE_STAGES)[number];
/** the stages other work packages fill; `shaderTime` is built in */
export type OpenUpdateStage = Exclude<UpdateStage, 'shaderTime'>;

/** `realDt` samples kept for the governor (render §15.2: a 2 s median window at up to 120 fps) */
export const FRAME_TIME_SAMPLES = 240;

/** where the loop's own chain gets its frames (default: the window) */
export interface LoopClock {
  requestAnimationFrame(cb: FrameRequestCallback): number;
  cancelAnimationFrame(id: number): void;
}

/** three's renderer as far as the loop needs it */
export interface LoopRenderer {
  setAnimationLoop(callback: ((timeMs: number) => void) | null): unknown;
}

export interface RenderLoopDeps {
  /** `pipeline.render()`. Returns false when nothing was drawn (no pipeline yet, device lost). */
  draw(): boolean;
  /** Applies the canvas host's pending resize; true when the drawing buffer changed. */
  flushResize?(): boolean;
  clock?: LoopClock;
}

/** the loop as the render lane drives it */
export interface RenderLoopControl extends RenderLoop {
  /** `'three'`: three's animation loop; `'own'`: this module's rAF chain; `'idle'`: no renderer and no step, no chain */
  readonly source: 'three' | 'own' | 'idle';
  readonly firstFramePresented: boolean;
  /** the frame of the last `update` */
  readonly lastFrame: FrameInfo | null;
  /** A renderer exists (after `init()`): its loop carries the step from now on. */
  attachRenderer(renderer: LoopRenderer): void;
  /** The renderer is going away (rebuild, X3): the step moves to the own chain until the next `attachRenderer`. */
  detachRenderer(): void;
  /** Installs, replaces (or with null removes) one presentation stage. */
  setStage(stage: OpenUpdateStage, run: ((frame: FrameInfo) => void) | null): void;
  /**
   * The drawing buffer was resized outside the per-frame flush (a tier change applies its caps at once) and is blank until it
   * is drawn: the next animation frame gets one `render()` unless the step draws it anyway.
   */
  requestPresent(): void;
  /** the last `realDt` samples in seconds, oldest first (a copy) */
  frameTimes(): Float32Array;
  dispose(): void;
}

const windowClock = (): LoopClock => ({
  requestAnimationFrame: (cb) => window.requestAnimationFrame(cb),
  cancelAnimationFrame: (id) => window.cancelAnimationFrame(id),
});

export function createRenderLoop(deps: RenderLoopDeps): RenderLoopControl {
  const clock = deps.clock ?? windowClock();
  const stages = new Map<OpenUpdateStage, (frame: FrameInfo) => void>();
  const firstFrameListeners = new Set<() => void>();
  const ring = new Float32Array(FRAME_TIME_SAMPLES);
  let ringCount = 0;
  let ringNext = 0;

  let step: ((timeMs: number) => void) | null = null;
  let renderer: LoopRenderer | null = null;
  let ownId: number | null = null;
  let lastFrame: FrameInfo | null = null;
  let firstFramePresented = false;
  /** the canvas was resized and has not been drawn since */
  let presentPending = false;
  let disposed = false;

  const render = (): void => {
    if (!deps.draw()) return;
    presentPending = false;
    if (firstFramePresented) return;
    firstFramePresented = true;
    for (const cb of [...firstFrameListeners]) {
      try {
        cb();
      } catch (e) {
        console.error('render loop: an onFirstFrame listener threw', e);
      }
    }
    firstFrameListeners.clear();
  };

  /** one animation frame, whichever chain delivers it */
  const tick = (timeMs: number): void => {
    if (deps.flushResize?.() === true) presentPending = true;
    step?.(timeMs);
    if (presentPending && firstFramePresented) render();
  };

  const ownFrame = (timeMs: number): void => {
    ownId = clock.requestAnimationFrame(ownFrame); // first, as three does: a throwing step does not end the chain
    tick(timeMs);
  };
  const startOwn = (): void => {
    if (ownId === null && !disposed) ownId = clock.requestAnimationFrame(ownFrame);
  };
  const stopOwn = (): void => {
    if (ownId !== null) clock.cancelAnimationFrame(ownId);
    ownId = null;
  };

  const setOnRenderer = (r: LoopRenderer, cb: ((timeMs: number) => void) | null): void => {
    try {
      // async in r186 (it awaits init() when the renderer is not initialised yet); the callback is set before it returns otherwise
      void Promise.resolve(r.setAnimationLoop(cb)).catch((e: unknown) => console.error('render loop: setAnimationLoop failed', e));
    } catch (e) {
      console.error('render loop: setAnimationLoop failed', e);
    }
  };

  return {
    get source(): 'three' | 'own' | 'idle' {
      return renderer !== null ? 'three' : ownId !== null ? 'own' : 'idle';
    },
    get firstFramePresented(): boolean {
      return firstFramePresented;
    },
    get lastFrame(): FrameInfo | null {
      return lastFrame;
    },

    update(frame: FrameInfo): void {
      shaderTimeSeconds(frame.now); // throws on a non-finite or negative `now`, before any stage has run
      lastFrame = frame;
      ring[ringNext] = frame.realDt;
      ringNext = (ringNext + 1) % FRAME_TIME_SAMPLES;
      if (ringCount < FRAME_TIME_SAMPLES) ringCount++;
      for (const name of UPDATE_STAGES) {
        if (name === 'shaderTime') setShaderTime(frame.now);
        else stages.get(name)?.(frame);
      }
    },

    render,

    setAnimationLoop(next: ((timeMs: number) => void) | null): void {
      step = next;
      if (renderer !== null) return; // three's loop already calls tick()
      if (step === null) stopOwn();
      else startOwn();
    },

    attachRenderer(next: LoopRenderer): void {
      if (disposed) return;
      if (renderer !== null && renderer !== next) setOnRenderer(renderer, null);
      renderer = next;
      stopOwn();
      setOnRenderer(next, tick);
    },

    detachRenderer(): void {
      if (renderer === null) return;
      setOnRenderer(renderer, null);
      renderer = null;
      if (step !== null) startOwn();
    },

    setStage(stage: OpenUpdateStage, run: ((frame: FrameInfo) => void) | null): void {
      if ((stage as UpdateStage) === 'shaderTime') throw new RangeError('render loop: the shaderTime stage is built in');
      if (!(UPDATE_STAGES as readonly string[]).includes(stage)) throw new RangeError(`render loop: unknown update stage ${JSON.stringify(stage)}`);
      if (run === null) stages.delete(stage);
      else stages.set(stage, run);
    },

    requestPresent(): void {
      if (!disposed) presentPending = true;
    },

    onFirstFrame(cb: () => void): () => void {
      if (!firstFramePresented) {
        firstFrameListeners.add(cb);
        return () => void firstFrameListeners.delete(cb);
      }
      // late: once, on a microtask, never synchronously inside this call
      let live = true;
      queueMicrotask(() => {
        if (live) cb();
      });
      return () => {
        live = false;
      };
    },

    frameTimes(): Float32Array {
      const out = new Float32Array(ringCount);
      const start = ringCount < FRAME_TIME_SAMPLES ? 0 : ringNext;
      for (let i = 0; i < ringCount; i++) out[i] = ring[(start + i) % FRAME_TIME_SAMPLES]!;
      return out;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      stopOwn();
      if (renderer !== null) setOnRenderer(renderer, null);
      renderer = null;
      step = null;
      stages.clear();
      firstFrameListeners.clear();
    },
  };
}
