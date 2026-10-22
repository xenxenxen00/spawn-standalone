// Copied from purge-protocol-web ebab692 (src/app or src/platform, same file name; web-platform.ts is platform/web.ts).
// The frame driver (docs/architecture.md X-08, X-09, X-11, X-38, X-46, §3.1, §4.2; render §3.4; io §1; WP X1).
//
// One step per animation frame, in one fixed order (docs/architecture.md §4.2):
//
//   1 advance        `kernel.advance(realDtMs)` → { ticks, alpha }. Called every frame: while paused it runs no tick
//   2 rig            `rigHost.frame(min(realDt, 0.1))`, once per rendered frame after the ticks of that frame (X-09); not while
//                    paused
//   3 presentation   `presentation.update(realDt, paused)` and the frame's `FrameInfo` (alpha of step 1). While paused time is
//                    frozen; a hitstop act emitted by a tick of step 1 freezes from here in the same frame
//   4 update         `renderer.update(frame)` when the engine exists; not while paused
//   5 audio          `audio.frame()`; not while a pause reason that suspends audio is set (rules.ts AUDIO_SUSPEND_REASONS:
//                    behind `boot` / `loading` / `preparing` the beds keep playing, so their voices are still collected)
//   6 render         `renderer.render()` when the engine exists, unless paused (`preparing` included, §5.3) or the UI host's
//                    menu backdrop covers the scene. A resize while nothing is drawn is the render loop's own (render §3.4)
//   7 ui             `uiHost.frame(timeMs)` (the host keeps its own ≤ 60 / 30 Hz cadence), then `touch.frame()`; always
//   8 ready          on the first frame whose UI is interactive (`UiHost.onFirstInteractiveFrame`): `setLoadingProgress(100)`,
//                    `gameReady()`, once (X-04), then the boot sequence's `onReady`
//
// The pause state of a frame is read after step 1, so a pause that a tick sets applies to the rest of the same frame.
//
// One rAF chain (X-08, X-46). The step is driven by the driver's own `requestAnimationFrame` until the engine attaches. three's
// `renderer.init()` starts an animation loop that cannot be stopped, so on `attach(renderer)` the driver cancels its pending
// frame and hands the step to `renderer.setAnimationLoop(step)`; `detach()` takes it back. The step is timestamp-driven in
// both modes (the same `DOMHighResTimeStamp` base), so `realDt` is continuous across the hand-over, and it runs at most once
// per timestamp: a second call with the timestamp of the last one returns at once. That covers the animation frame in which
// the hand-over lands (the own callback and three's callback of the same frame) and the facade's own chain during a
// device-loss rebuild (X3). The own chain requests its next frame before the step runs, as three does: a throwing step does
// not end the chain, and an attach from inside a step finds the frame it has to cancel.
//
// FPS cap (`settings.fpsCap`: 'off' | 30 | 60): whole steps are skipped by accumulated timestamp time, with 3 ms of jitter
// tolerance and the debt carried over, so the average never exceeds the cap; the next step's `realDt` spans the skipped frames.
//
// Time: the first frame has `realDt` 0; a gap (a background tab, a hitch) is clamped to 0.25 s, the kernel's own frame clamp.
//
// A step that throws is reported once per distinct message and the frame goes on (docs/architecture.md §5.6).
//
// Frame listeners (render §15.2, the governor; WP R14b): `addFrameListener(cb)` hears every frame that ran, after its steps,
// with the main-thread time of the whole step (`performance.now()` around steps 1-8, two reads per frame, taken only while a
// listener is registered). It is the governor's CPU figure in every build; the per-step marks below stay test-build only.
//
// Test builds (X-38): every step that ran is one `performance.measure('ss:<step>', { start, end, detail: { frame } })` and one
// sample of the 2 s ring `__ssTest` reads (`createStepMarks`). A production build passes no `marks`: nothing is measured.
import { suspendsAudio } from '../compat/core/rules.ts';
import type { PauseReason } from '../compat/core/types.ts';
import type { PresentationClock } from './presentation-clock.ts';

/** docs/architecture.md §3.0 (frozen); render §3.4 */
export interface FrameInfo {
  /** presentation ms (PresentationClock: excludes paused time; X-11) */
  now: number;
  /** presentation seconds this frame, 0 during hitstop and while paused, clamped to 1/20 */
  dt: number;
  /** wall seconds since the previous frame that ran (governor), clamped to 0.25 */
  realDt: number;
  /** interpolation fraction between the last two 30 Hz ticks, from kernel.advance */
  alpha: number;
  frameIndex: number;
  paused: boolean;
}

/** steps 1-7 of docs/architecture.md §4.2, the names of the `ss:<step>` measures (X-38 sums exactly these) */
export const FRAME_STEPS = Object.freeze(['advance', 'rig', 'presentation', 'update', 'audio', 'render', 'ui'] as const);
export type FrameStep = (typeof FRAME_STEPS)[number];

/** the same string as src/testing/telemetry.ts SS_MEASURE_PREFIX (that module is in test builds only) */
export const STEP_MEASURE_PREFIX = 'ss:';

/** X-09: the rig's dt */
export const RIG_DT_MAX_S = 0.1;
/** core §9.7: the kernel clamps a frame to 250 ms; the driver reports the same */
export const REAL_DT_MAX_S = 0.25;
/** a frame up to this much early still runs under an FPS cap (rAF timestamp jitter) */
export const FPS_CAP_TOLERANCE_MS = 3;

/** `settings.fpsCap[deviceType]` (build §6.5) */
export type FpsCap = 'off' | 30 | 60;

/** the renderer as the driver uses it (the `Renderer` facade satisfies it) */
export interface FrameRenderer {
  update(frame: FrameInfo): void;
  render(): void;
  setAnimationLoop(step: ((timeMs: number) => void) | null): void;
}

/** where the own chain gets its frames (default: the window) */
export interface RafClock {
  requestAnimationFrame(cb: FrameRequestCallback): number;
  cancelAnimationFrame(id: number): void;
}

/** the per-step timing of test builds */
export interface StepMarks {
  now(): number;
  /** the step that started at `startMs` has just ended */
  record(step: FrameStep, frame: number, startMs: number): void;
  endFrame(frame: number): void;
}

export interface FrameDriverDeps {
  kernel: {
    advance(realDtMs: number): { ticks: number; alpha: number };
    readonly clock: { readonly running: boolean; readonly reasons: ReadonlySet<PauseReason> };
  };
  rig: { frame(dtS: number): void };
  presentation: PresentationClock;
  audio: { frame(): void };
  ui: { frame(nowMs?: number): void; coversScene(): boolean; onFirstInteractiveFrame(cb: () => void): void };
  /** the touch layer, when the device has one (it lands after the driver) */
  touch?: () => { frame(): void } | null;
  platform: { setLoadingProgress(pct: number): void; gameReady(): void };
  /** false: step 8 sends nothing to the platform (`platform.init` timed out, build §6.2); default true */
  sendGameReady?: () => boolean;
  /** read every frame; default 'off' */
  fpsCap?: () => FpsCap;
  clock?: RafClock;
  /** test builds only */
  marks?: StepMarks | null;
  /** after the steps of every frame that ran */
  onFrame?: (frame: FrameInfo) => void;
  /** the clock of the frame listeners' CPU figure; default `performance.now()` */
  cpuNow?: () => number;
  /** once, after step 8 */
  onReady?: () => void;
  /** default console.error */
  log?: (msg: string, error: unknown) => void;
}

export interface FrameDriver {
  /** the frame step; `renderer.setAnimationLoop` gets exactly this function */
  readonly step: (timeMs: number) => void;
  /** who calls the step: nobody, the own requestAnimationFrame chain, or the renderer's loop */
  readonly source: 'idle' | 'own' | 'renderer';
  readonly renderer: FrameRenderer | null;
  /** the FrameInfo of the last frame that ran */
  readonly last: FrameInfo | null;
  /** frames run */
  readonly frames: number;
  /** step 8 has happened */
  readonly ready: boolean;
  start(): void;
  /** X-08: the engine exists; its loop carries the step from now on */
  attach(renderer: FrameRenderer): void;
  /** the engine is gone: the own chain carries the step again */
  detach(): void;
  stop(): void;
  /**
   * Hears every frame that ran, after its steps: its `FrameInfo` and the main-thread ms of the whole step (render §15.2: the
   * governor's CPU figure). Returns the removal. A listener that throws is reported once per message.
   */
  addFrameListener(cb: (frame: FrameInfo, cpuMs: number) => void): () => void;
}

const windowClock = (): RafClock => ({
  requestAnimationFrame: (cb) => window.requestAnimationFrame(cb),
  cancelAnimationFrame: (id) => window.cancelAnimationFrame(id),
});

/** what `createStepMarks` needs of `performance` */
export interface MarkPerformance {
  now(): number;
  measure(name: string, options: { start: number; end: number; detail: unknown }): unknown;
  clearMeasures(name?: string): void;
}

/**
 * The marks of a test build: one `ss:<step>` measure per step and one sample in `ring` (src/testing/telemetry.ts `StepRing`).
 * Its own measures are cleared every `clearEvery` frames (default 1200), so the page's entry buffer stays bounded.
 */
export function createStepMarks(o: { perf?: MarkPerformance; ring?: { record(frame: number, step: string, ms: number, nowMs: number): void } | null; clearEvery?: number } = {}): StepMarks {
  const perf = o.perf ?? (performance as unknown as MarkPerformance);
  const ring = o.ring ?? null;
  const clearEvery = Math.max(1, o.clearEvery ?? 1200);
  return {
    now: () => perf.now(),
    record(step, frame, startMs) {
      const end = perf.now();
      perf.measure(STEP_MEASURE_PREFIX + step, { start: startMs, end, detail: { frame } });
      ring?.record(frame, step, end - startMs, end);
    },
    endFrame(frame) {
      if (frame > 0 && frame % clearEvery === 0) for (const step of FRAME_STEPS) perf.clearMeasures(STEP_MEASURE_PREFIX + step);
    },
  };
}

export function createFrameDriver(deps: FrameDriverDeps): FrameDriver {
  const raf = deps.clock ?? windowClock();
  const marks = deps.marks ?? null;
  const log = deps.log ?? ((msg: string, error: unknown): void => console.error(`[frame] ${msg}`, error));
  const reported = new Set<string>();
  const frameListeners = new Set<(frame: FrameInfo, cpuMs: number) => void>();
  const cpuNow = deps.cpuNow ?? ((): number => performance.now());

  let started = false;
  let source: 'idle' | 'own' | 'renderer' = 'idle';
  let renderer: FrameRenderer | null = null;
  let ownId: number | null = null;
  /** the last timestamp the step was called with, and the last one a frame ran at */
  let seenT = Number.NaN;
  let ranT = Number.NaN;
  let capAcc = 0;
  let frames = 0;
  let last: FrameInfo | null = null;
  let interactive = false;
  let ready = false;

  const report = (step: string, error: unknown): void => {
    const msg = `frame step ${step}: ${error instanceof Error ? error.message : String(error)}`;
    if (reported.has(msg)) return;
    if (reported.size < 64) reported.add(msg);
    log(msg, error);
  };

  const runFrame = (timeMs: number, realDt: number): void => {
    const { kernel, presentation } = deps;
    const frameIndex = frames++;
    const engine = renderer; // one engine for the whole frame, whatever attaches meanwhile
    let t0 = 0;
    const listened = frameListeners.size > 0;
    const c0 = listened ? cpuNow() : 0;

    // 1
    let alpha = 0;
    if (marks) t0 = marks.now();
    try {
      alpha = kernel.advance(realDt * 1000).alpha;
    } catch (e) {
      report('advance', e);
    }
    if (marks) marks.record('advance', frameIndex, t0);
    const paused = !kernel.clock.running;

    // 2
    if (!paused) {
      if (marks) t0 = marks.now();
      try {
        deps.rig.frame(Math.min(realDt, RIG_DT_MAX_S));
      } catch (e) {
        report('rig', e);
      }
      if (marks) marks.record('rig', frameIndex, t0);
    }

    // 3
    if (marks) t0 = marks.now();
    try {
      presentation.update(realDt, paused);
    } catch (e) {
      report('presentation', e);
    }
    const frame: FrameInfo = { now: presentation.now(), dt: presentation.dt(), realDt, alpha, frameIndex, paused };
    last = frame;
    if (marks) marks.record('presentation', frameIndex, t0);

    // 4
    if (engine !== null && !paused) {
      if (marks) t0 = marks.now();
      try {
        engine.update(frame);
      } catch (e) {
        report('update', e);
      }
      if (marks) marks.record('update', frameIndex, t0);
    }

    // 5
    if (!paused || !suspendsAudio(kernel.clock.reasons)) {
      if (marks) t0 = marks.now();
      try {
        deps.audio.frame();
      } catch (e) {
        report('audio', e);
      }
      if (marks) marks.record('audio', frameIndex, t0);
    }

    // 6
    if (engine !== null && !paused) {
      let covered = false;
      try {
        covered = deps.ui.coversScene();
      } catch (e) {
        report('render', e);
      }
      if (!covered) {
        if (marks) t0 = marks.now();
        try {
          engine.render();
        } catch (e) {
          report('render', e);
        }
        if (marks) marks.record('render', frameIndex, t0);
      }
    }

    // 7
    if (marks) t0 = marks.now();
    try {
      deps.ui.frame(timeMs);
    } catch (e) {
      report('ui', e);
    }
    try {
      deps.touch?.()?.frame();
    } catch (e) {
      report('touch', e);
    }
    if (marks) marks.record('ui', frameIndex, t0);

    // 8
    if (interactive && !ready) {
      ready = true;
      try {
        if (deps.sendGameReady?.() ?? true) {
          deps.platform.setLoadingProgress(100);
          deps.platform.gameReady();
        }
      } catch (e) {
        report('ready', e);
      }
      try {
        deps.onReady?.();
      } catch (e) {
        report('ready', e);
      }
    }

    // the frame's CPU figure ends with step 8: the test build's own `onFrame` telemetry is not the game's cost
    const cpuMs = listened ? Math.max(0, cpuNow() - c0) : 0;
    if (deps.onFrame) {
      try {
        deps.onFrame(frame);
      } catch (e) {
        report('onFrame', e);
      }
    }
    if (listened) {
      for (const cb of [...frameListeners]) {
        try {
          cb(frame, cpuMs);
        } catch (e) {
          report('frameListener', e);
        }
      }
    }
    if (marks) marks.endFrame(frameIndex);
  };

  const step = (timeMs: number): void => {
    if (source === 'idle' || !(typeof timeMs === 'number') || Number.isNaN(timeMs)) return;
    if (timeMs === seenT) return; // X-08: once per animation frame, whoever calls
    const sinceSeen = Number.isNaN(seenT) ? 0 : timeMs - seenT;
    seenT = timeMs;

    const cap = deps.fpsCap?.() ?? 'off';
    if (cap === 'off' || Number.isNaN(ranT)) capAcc = 0;
    else {
      if (sinceSeen > 0) capAcc += sinceSeen;
      const interval = 1000 / cap;
      if (capAcc + FPS_CAP_TOLERANCE_MS < interval) return;
      capAcc = Math.min(capAcc - interval, FPS_CAP_TOLERANCE_MS);
    }

    const realMs = Number.isNaN(ranT) ? 0 : Math.max(0, timeMs - ranT);
    ranT = timeMs;
    runFrame(timeMs, Math.min(realMs / 1000, REAL_DT_MAX_S));
  };

  const ownFrame = (timeMs: number): void => {
    ownId = raf.requestAnimationFrame(ownFrame); // first: a throwing step does not end the chain
    step(timeMs);
  };
  const startOwn = (): void => {
    source = 'own';
    if (ownId === null) ownId = raf.requestAnimationFrame(ownFrame);
  };
  const stopOwn = (): void => {
    if (ownId !== null) raf.cancelAnimationFrame(ownId);
    ownId = null;
  };
  const setLoop = (r: FrameRenderer, fn: ((timeMs: number) => void) | null): void => {
    try {
      r.setAnimationLoop(fn);
    } catch (e) {
      report('setAnimationLoop', e);
    }
  };

  return {
    step,
    get source() {
      return source;
    },
    get renderer() {
      return renderer;
    },
    get last() {
      return last;
    },
    get frames() {
      return frames;
    },
    get ready() {
      return ready;
    },

    start(): void {
      if (started) return;
      started = true;
      deps.ui.onFirstInteractiveFrame(() => {
        interactive = true;
      });
      if (renderer !== null) {
        source = 'renderer';
        setLoop(renderer, step);
      } else startOwn();
    },

    attach(next: FrameRenderer): void {
      if (next === renderer) return;
      const prev = renderer;
      renderer = next;
      if (!started) return;
      stopOwn();
      if (prev !== null) setLoop(prev, null);
      source = 'renderer';
      setLoop(next, step);
    },

    detach(): void {
      const prev = renderer;
      renderer = null;
      if (prev === null || !started) return;
      setLoop(prev, null);
      startOwn();
    },

    addFrameListener(cb) {
      frameListeners.add(cb);
      return () => void frameListeners.delete(cb);
    },

    stop(): void {
      const wasStarted = started;
      started = false;
      source = 'idle';
      stopOwn();
      if (wasStarted && renderer !== null) setLoop(renderer, null);
    },
  };
}

/** what `startFrameDriver` needs of the composition root (the `App` satisfies it) */
export interface FrameDriverHost {
  readonly driver: FrameDriver;
}

/** docs/architecture.md §3.1: the frame driver composed for the app starts (boot step 9) */
export function startFrameDriver(app: FrameDriverHost): FrameDriver {
  app.driver.start();
  return app.driver;
}
