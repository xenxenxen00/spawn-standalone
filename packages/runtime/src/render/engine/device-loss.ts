// The device-loss policy (docs/design/rendering.md §3.1 steps 2-3; docs/architecture.md §5.5, X-46; WP X3).
//
// three's `WebGPURenderer` has no restore path, so a lost WebGL context (or WebGPU device) is answered by building a new
// renderer on a fresh canvas. This module is the decision part of that, free of three and the DOM, so its timing rules are
// unit-tested with a fake clock (tests/unit/render/device-loss.node.test.ts). The facade (src/render/index.ts) supplies the
// steps: `rebuild` tears the old engine down, swaps the canvas, creates and adopts the new engine and runs the warm-up behind
// the hold; `resume` releases pause reason `gpu`.
//
//   a loss            pause reason `gpu` is already held (policy step 1, the facade's loss hook). The rebuild starts on the
//                     next task, after three's own handler and every listener of this loss have run
//   rebuild settles   `resume()`: the frame steps on with the same presentation time it was frozen at
//   reload offer      `offerReload()`, once per episode, when (render §3.1 step 3, architecture §5.5)
//                       - the rebuild threw or reported failure,
//                       - a second loss arrived while the rebuild ran (the new context was lost as well),
//                       - a second loss arrived within `windowMs` (5 s) of the previous one, after a successful rebuild,
//                       - or `windowMs` passed since the loss and the rebuild has not resumed the game yet.
//                     In the last case the rebuild keeps going: if it still succeeds, the game resumes and the offer is moot.
//                     After any of the others no further rebuild is attempted; the platform layer (the app's device notice)
//                     autosaves and shows the RELOAD button.

/** render §3.1 step 3, architecture §5.5: a second loss within this window, or no resume by then, offers a reload */
export const DEVICE_LOSS_WINDOW_MS = 5000;

export type DeviceLossState = 'idle' | 'rebuilding' | 'failed';

export interface DeviceLossPolicyDeps {
  /** tear down, swap the canvas, create, adopt, warm up; resolves true when the new engine is ready to draw */
  rebuild(): Promise<boolean>;
  /** releases pause reason `gpu` (and asks for one present of the new canvas) */
  resume(): void;
  /** the platform layer's reload offer (it autosaves first) */
  offerReload(reason: string): void;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (id: unknown) => void;
  windowMs?: number;
  log?: (message: string) => void;
}

export interface DeviceLossPolicy {
  readonly state: DeviceLossState;
  /** rebuilds that resumed the game */
  readonly rebuilds: number;
  /** the reload was offered (this episode or an earlier one) */
  readonly reloadOffered: boolean;
  /** the renderer reported a loss (after pause `gpu` was requested) */
  onLost(): void;
  /** settles when the rebuild in flight has ended (at once when none runs) */
  settled(): Promise<void>;
  dispose(): void;
}

export function createDeviceLossPolicy(deps: DeviceLossPolicyDeps): DeviceLossPolicy {
  const now = deps.now ?? ((): number => performance.now());
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number): unknown => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((id: unknown): void => clearTimeout(id as ReturnType<typeof setTimeout>));
  const windowMs = deps.windowMs ?? DEVICE_LOSS_WINDOW_MS;
  const log = deps.log ?? ((m: string): void => console.warn(m));

  let state: DeviceLossState = 'idle';
  let rebuilds = 0;
  let reloadOffered = false;
  let lastLossAt: number | null = null;
  let offeredThisEpisode = false;
  let reloadTimer: unknown = null;
  let startTimer: unknown = null;
  let inFlight: Promise<void> = Promise.resolve();
  /** settles `inFlight` when its start timer is cancelled before the rebuild ran */
  let settleStart: (() => void) | null = null;
  let disposed = false;

  const stopTimers = (): void => {
    if (reloadTimer !== null) clearTimer(reloadTimer);
    if (startTimer !== null) {
      clearTimer(startTimer);
      settleStart?.();
    }
    reloadTimer = null;
    startTimer = null;
    settleStart = null;
  };

  const offer = (reason: string): void => {
    if (offeredThisEpisode || disposed) return;
    offeredThisEpisode = true;
    reloadOffered = true;
    log(`[render] device loss: ${reason}; offering a reload`);
    try {
      deps.offerReload(reason);
    } catch (e) {
      console.error('[render] the reload offer failed', e);
    }
  };

  const fail = (reason: string): void => {
    state = 'failed';
    stopTimers();
    offer(reason);
  };

  const run = async (): Promise<void> => {
    startTimer = null;
    if (disposed || state !== 'rebuilding') return;
    let ok = false;
    try {
      ok = await deps.rebuild();
    } catch (e) {
      log(`[render] the renderer rebuild threw: ${e instanceof Error ? e.message : String(e)}`);
      ok = false;
    }
    // a second loss (or a dispose) while it ran has decided already
    if (disposed || state !== 'rebuilding') return;
    if (!ok) {
      fail('the renderer could not be rebuilt');
      return;
    }
    state = 'idle';
    rebuilds++;
    stopTimers();
    try {
      deps.resume();
    } catch (e) {
      console.error('[render] resuming after the rebuild failed', e);
    }
  };

  return {
    get state(): DeviceLossState {
      return state;
    },
    get rebuilds(): number {
      return rebuilds;
    },
    get reloadOffered(): boolean {
      return reloadOffered;
    },
    onLost(): void {
      if (disposed) return;
      const t = now();
      if (state === 'failed') return; // already offered; nothing more to try
      if (state === 'rebuilding') {
        fail('the graphics device was lost again during the rebuild');
        return;
      }
      if (lastLossAt !== null && t - lastLossAt < windowMs) {
        lastLossAt = t;
        fail(`a second loss within ${windowMs} ms`);
        return;
      }
      lastLossAt = t;
      offeredThisEpisode = false;
      state = 'rebuilding';
      reloadTimer = setTimer(() => {
        reloadTimer = null;
        if (state === 'rebuilding') offer(`the game did not resume within ${windowMs} ms`);
      }, windowMs);
      inFlight = new Promise<void>((resolve) => {
        settleStart = resolve;
        startTimer = setTimer(() => {
          settleStart = null;
          void run().finally(resolve);
        }, 0);
      });
    },
    settled: () => inFlight,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      stopTimers();
    },
  };
}
