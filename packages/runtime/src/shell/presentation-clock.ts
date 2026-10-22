// Copied from purge-protocol-web ebab692 (src/app or src/platform, same file name; web-platform.ts is platform/web.ts).
// The presentation clock (docs/architecture.md X-11, §3.0, §4.2 step 3; render §3.4, §13.4; io §5.5; WP X1).
//
// Presentation time is what the eye sees move: fx simulation, decal fades, the mixer's presentation pass and the shader `time`
// (`builtin/tsl`'s `time`, which the renderer sets to `(now / 1000) % 3600` each frame). It differs from the sim clock in two
// ways: it advances per rendered frame, and a hitstop freezes it while the sim keeps ticking. There is no sim time scale (X-11).
//
//   update(realDtS, simPaused)   once per frame (frame step 3), also while paused
//   dt()       seconds presented this frame: min(realDt, 1/20); 0 while the sim is paused and while a hitstop holds
//   now()      ms; the sum of every dt, so it excludes paused time and hitstop time and never jumps by more than 50 ms
//   hitstop(s) freeze for `s` seconds of real time from now. Overlapping calls extend to the longest remaining, they never
//              add up. The freeze does not count down while the sim is paused. The frame in which it runs out presents the
//              rest of its real time, so the freeze lasts `s` seconds whatever the frame rate
//   hitstopActive()   true until the remaining freeze has reached 0
//
// Pure: no DOM, no timers; the frame driver is the only caller of `update`.

/** docs/architecture.md §3.0 (frozen); render declares the same shape as what it consumes */
export interface PresentationClock {
  update(realDtS: number, simPaused: boolean): void;
  /** presentation ms */
  now(): number;
  /** presentation seconds of the current frame */
  dt(): number;
  hitstop(seconds: number): void;
  hitstopActive(): boolean;
}

/** render §3.4 `FrameInfo.dt`: "clamped to 1/20" */
export const PRESENTATION_DT_MAX_S = 1 / 20;

export function createPresentationClock(): PresentationClock {
  let nowMs = 0;
  let dtS = 0;
  /** seconds of freeze left */
  let hold = 0;

  return {
    update(realDtS: number, simPaused: boolean): void {
      const real = realDtS > 0 ? realDtS : 0; // NaN and negatives are a frame of no time
      if (simPaused) {
        dtS = 0;
        return;
      }
      let free = real;
      if (hold > 0) {
        const used = Math.min(hold, real);
        hold -= used;
        free = real - used;
        if (hold < 1e-9) hold = 0;
        if (hold > 0 || free <= 1e-9) free = 0;
      }
      dtS = Math.min(free, PRESENTATION_DT_MAX_S);
      nowMs += dtS * 1000;
    },
    now: () => nowMs,
    dt: () => dtS,
    hitstop(seconds: number): void {
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return;
      if (seconds > hold) hold = seconds;
    },
    hitstopActive: () => hold > 0,
  };
}
