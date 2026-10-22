// The quality governor (docs/design/rendering.md §15.2; docs/architecture.md X-22, X-38; WP R14b).
//
// Engine-free (no three.js): a pure state machine over per-frame samples, so the unit tests drive it with simulated frame
// series and the app shell can wire it without loading the engine chunk.
//
//   samples      `sample(frameMs, cpuMs)` once per frame that ran, unpaused, while the phase is not `idle` (menus, LOADING
//                and the results screen are never judged: their hitches are loads, not the scene). `frameMs` is the frame's
//                wall time (`FrameInfo.realDt`), `cpuMs` the main-thread time of the frame step (frame.ts). The governor's
//                clock is the sum of the sampled frame times, so every hold below counts judged play time only.
//   windows      tumbling 2 s windows; each closed window is judged once by its medians and at most one lever moves per
//                window. After any move the next window holds only frames drawn after it.
//   miss         median frame time above 18.5 ms (desktop, 60 fps target) or 36 ms (mobile, 30 fps target)
//   good         median below 13 ms / 26 ms. Between the two the window is neutral: it ends every streak and moves nothing
//                (the hysteresis band). Under an FPS cap both thresholds follow the cap's interval (`setFrameFloor`)
//   CPU-bound    median CPU ≥ 80 % of the median frame time, or above the tier's CPU total (`GOVERNOR_CPU_TOTAL_MS`, the
//                per-tier budgets of the X-38 CPU row). A CPU-bound miss pulls the next CPU lever, in this order: UI cadence
//                30 Hz → mixer LOD distance × 0.7 → (low/minimum tiers only) fx held factor one step down → `simCaps = 'low'`
//                (the wiring applies it at the next safe boundary). With every CPU lever pulled it falls through to resolution.
//                A GPU-bound miss lowers the render scale by 0.1 (floor: the tier's range minimum); at the floor it pulls
//                the CPU levers that are left, so "every lever pulled" is reachable from either side
//   recovery     4 s of good windows → render scale + 0.05, up to the tier's range maximum. CPU levers stay pulled (they
//                cost little and releasing them is what makes a governor oscillate)
//   no flapping  a miss within 4 s of an upward step caps the scale below that step for the rest of the tier: the scale
//                that missed is never tried again, so a scene that sits on the edge settles instead of see-sawing
//   tier drop    at the floor with every lever pulled and the miss holding for 10 s (30 s for a desktop's first drop),
//                drop one tier: scheduled at once, applied at the next break (never in a protected phase, never during gameplay), with
//                a `drop` event the wiring toasts. Each drop is one step down and the governor never raises the tier
//                again; the next drop needs its own 10 s at the new tier's floor. `minimum` has nothing below it
//   explicit     the player's explicit SETTINGS pick (or a `?tier=` flag) disables tier drops; resolution and CPU levers
//                still adapt. A tier change from outside (`reset()`: the player's pick) clears the streaks, the ceiling and
//                a pending drop; levers already pulled stay pulled
import { TIER_IDS, tierConfig, type TierId } from './budget.ts';

/** what the governor judges in: `idle` judges nothing; a drop waits for `break`; `protected` never drops */
export type GovernorPhase = 'idle' | 'play' | 'protected' | 'break';

export const GOVERNOR_PHASES = Object.freeze(['idle', 'play', 'protected', 'break'] as const);

/** the CPU levers of render §15.2, in the order they are pulled */
export type CpuLever = 'uiCadence' | 'mixerLod' | 'fxHeld' | 'simCaps';

export const CPU_LEVER_ORDER = Object.freeze(['uiCadence', 'mixerLod', 'fxHeld', 'simCaps'] as const);

/** which frame-rate target the device is judged against */
export type GovernorDevice = 'desktop' | 'mobile';

/** render §15.2 */
export const GOVERNOR_WINDOW_MS = 2000;
export const GOVERNOR_MISS_MS: Readonly<Record<GovernorDevice, number>> = Object.freeze({ desktop: 18.5, mobile: 36 });
export const GOVERNOR_GOOD_MS: Readonly<Record<GovernorDevice, number>> = Object.freeze({ desktop: 13, mobile: 26 });
export const GOVERNOR_RECOVER_MS = 4000;
export const GOVERNOR_SCALE_DOWN = 0.1;
export const GOVERNOR_SCALE_UP = 0.05;
export const GOVERNOR_CPU_FRACTION = 0.8;
export const GOVERNOR_FLOOR_HOLD_MS = 10_000;
export const GOVERNOR_DESKTOP_FIRST_DROP_MS = 30_000;
/** under an FPS cap: a window misses above the cap interval × this, and is good below the interval × the other */
export const GOVERNOR_CAP_MISS = 1.1;
export const GOVERNOR_CAP_GOOD = 1.05;
/** a window with fewer frames than this is not judged (a 2 s window holds at least 8 frames at the 0.25 s clamp) */
export const GOVERNOR_MIN_SAMPLES = 4;

/**
 * The tier's main-thread CPU total per frame (X-38 / build §8.8 CPU row: 10 ms on the desktop tiers, 28 ms on `low`, 30 ms on
 * `minimum`). `medium` is a desktop tier with the desktop frame target, so it shares `high`'s figure.
 */
export const GOVERNOR_CPU_TOTAL_MS: Readonly<Record<TierId, number>> = Object.freeze({ high: 10, medium: 10, low: 28, minimum: 30 });

/** The fx held-factor ladder (the tier table's 1 / 0.5 / 0.35, then one more step): the lever moves one rung down. */
export const FX_HELD_LADDER = Object.freeze([1, 0.5, 0.35, 0.25] as const);

/** the tiers whose fx held factor the governor may lower (X-22: the factor stays 1 on both desktop tiers) */
export function fxHeldLeverApplies(tier: TierId): boolean {
  return tier === 'low' || tier === 'minimum';
}

/** The held factor one rung below `factor` on `FX_HELD_LADDER` (the last rung stays). */
export function fxHeldStepDown(factor: number): number {
  for (const rung of FX_HELD_LADDER) if (rung < factor - 1e-9) return rung;
  return FX_HELD_LADDER[FX_HELD_LADDER.length - 1]!;
}

/** what the governor moves: the render facade (src/render/index.ts) satisfies it */
export interface GovernorTarget {
  readonly tier: TierId;
  readonly renderScale: number;
  setRenderScale(scale: number): void;
  /** the governor's tier lever (any tier) */
  applyTier(tier: TierId): void;
  /** the player's explicit pick or a `?tier=` flag stands: no tier drops */
  readonly explicitTier: boolean;
}

/**
 * One CPU lever. Returns true when pulling it changed something; false when it was already in effect or cannot act here (the
 * governor then moves on to the next lever in the same window). A lever left out of the map does not exist on this page.
 */
export type CpuLeverFn = () => boolean;

export type GovernorEvent =
  | { kind: 'lever'; lever: CpuLever }
  | { kind: 'scale'; from: number; to: number }
  | { kind: 'drop-scheduled'; from: TierId; to: TierId }
  | { kind: 'drop'; from: TierId; to: TierId };

export interface GovernorOptions {
  target: GovernorTarget;
  device: GovernorDevice;
  levers?: Partial<Record<CpuLever, CpuLeverFn>>;
  /** false: nothing is sampled or moved; default true */
  enabled?: boolean;

  /** called for every move; a listener that throws is reported and the others still run */
  log?: (message: string, error: unknown) => void;
}

/** what a window was judged as */
export type WindowVerdict = 'miss-cpu' | 'miss-gpu' | 'good' | 'neutral';

export interface GovernorState {
  readonly enabled: boolean;
  readonly phase: GovernorPhase;
  readonly device: GovernorDevice;
  readonly tier: TierId;
  readonly renderScale: number;
  /** the highest scale the governor will step up to on this tier */
  readonly ceiling: number;
  readonly pulled: readonly CpuLever[];
  readonly pendingDrop: TierId | null;
  readonly drops: number;
  /** governor clock (judged play time, ms) */
  readonly clockMs: number;
  readonly windows: number;
  readonly lastVerdict: WindowVerdict | null;
  readonly lastMedianMs: number | null;
  readonly lastCpuMedianMs: number | null;
  /** clock when the current miss streak started; null outside one */
  readonly missSinceMs: number | null;
  /** clock when the governor ran out of levers in the current miss streak; null otherwise */
  readonly exhaustedSinceMs: number | null;
}

export interface Governor {
  /** one frame that ran: its wall time and the main-thread time of its step, both in ms */
  sample(frameMs: number, cpuMs: number): void;
  setPhase(phase: GovernorPhase): void;
  readonly phase: GovernorPhase;
  /** adds or replaces levers (the renderer brings its own fx lever, the app the rest); pulled levers stay pulled */
  setLevers(levers: Partial<Record<CpuLever, CpuLeverFn>>): void;
  setEnabled(on: boolean): void;
  /**
   * The shortest frame the page itself imposes, in ms (the FPS cap's interval; 0 without one). Under a cap a frame at the
   * cap's interval is keeping up, so the thresholds become `miss > max(target, floor × 1.1)` and `good < max(good, floor ×
   * 1.05)`: a player's 30 fps cap is never judged as a 30 fps miss.
   */
  setFrameFloor(ms: number): void;
  /** the tier changed from outside (the player's pick): streaks, ceiling and a pending drop are cleared */
  reset(): void;
  onEvent(cb: (event: GovernorEvent) => void): () => void;
  inspect(): GovernorState;
}

const EPS = 1e-6;
/** a 2 s window at up to 240 fps, with room */
const RING = 1024;

function median(values: Float64Array, n: number, scratch: Float64Array): number {
  for (let i = 0; i < n; i++) scratch[i] = values[i]!;
  const view = scratch.subarray(0, n);
  view.sort();
  const mid = n >> 1;
  return n % 2 === 1 ? view[mid]! : (view[mid - 1]! + view[mid]!) / 2;
}

const round = (x: number): number => Math.round(x * 1000) / 1000;

export function createGovernor(o: GovernorOptions): Governor {
  const target = o.target;
  const device = o.device;
  const log = o.log ?? ((message: string, error: unknown): void => console.error(`[governor] ${message}`, error));
  let levers: Partial<Record<CpuLever, CpuLeverFn>> = { ...o.levers };
  let enabled = o.enabled ?? true;
  let floorMs = 0;
  let phase: GovernorPhase = 'idle';
  const listeners = new Set<(event: GovernorEvent) => void>();

  const frames = new Float64Array(RING);
  const cpus = new Float64Array(RING);
  const scratch = new Float64Array(RING);
  let count = 0;
  let windowMs = 0;
  let windowStart = 0;
  let clock = 0;
  let windows = 0;

  const pulled = new Set<CpuLever>();
  let ceiling = Number.POSITIVE_INFINITY;
  let missSince: number | null = null;
  let exhaustedSince: number | null = null;
  let goodSince: number | null = null;
  /** clock and scale of the last upward step, for the no-flapping ceiling */
  let lastUp: { at: number; from: number } | null = null;
  let pendingDrop: TierId | null = null;
  let drops = 0;
  let lastVerdict: WindowVerdict | null = null;
  let lastMedian: number | null = null;
  let lastCpuMedian: number | null = null;

  const emit = (event: GovernorEvent): void => {
    for (const cb of [...listeners]) {
      try {
        cb(event);
      } catch (e) {
        log(`a listener threw on ${event.kind}`, e);
      }
    }
  };

  const clearWindow = (): void => {
    count = 0;
    windowMs = 0;
    windowStart = clock;
  };

  const clearStreaks = (): void => {
    missSince = null;
    exhaustedSince = null;
    goodSince = null;
  };

  const range = (): readonly [number, number] => tierConfig(target.tier).renderScaleRange;

  const setScale = (to: number): void => {
    const from = target.renderScale;
    target.setRenderScale(to);
    emit({ kind: 'scale', from: round(from), to: round(to) });
  };

  /** the CPU levers that exist here and are not pulled, in order */
  const pullNextLever = (): boolean => {
    for (const lever of CPU_LEVER_ORDER) {
      if (pulled.has(lever)) continue;
      if (lever === 'fxHeld' && !fxHeldLeverApplies(target.tier)) continue;
      const fn = levers[lever];
      if (fn === undefined) continue;
      pulled.add(lever);
      let changed = false;
      try {
        changed = fn() === true;
      } catch (e) {
        log(`lever ${lever} threw`, e);
      }
      if (changed) {
        emit({ kind: 'lever', lever });
        return true;
      }
    }
    return false;
  };

  const scaleDown = (): boolean => {
    const [floor] = range();
    const s = target.renderScale;
    if (s <= floor + EPS) return false;
    setScale(Math.max(floor, round(s - GOVERNOR_SCALE_DOWN)));
    return true;
  };

  const nextTier = (): TierId | null => {
    const i = TIER_IDS.indexOf(target.tier);
    return i >= 0 && i < TIER_IDS.length - 1 ? TIER_IDS[i + 1]! : null;
  };

  const applyPendingDrop = (): void => {
    if (pendingDrop === null || phase !== 'break' || !enabled) return;
    const to = pendingDrop;
    const from = target.tier;
    pendingDrop = null;
    if (target.explicitTier || TIER_IDS.indexOf(to) <= TIER_IDS.indexOf(from)) return;
    drops++;
    target.applyTier(to);
    // the new tier starts at its own start scale (the canvas host resets it) with its own range
    ceiling = Number.POSITIVE_INFINITY;
    lastUp = null;
    clearStreaks();
    clearWindow();
    emit({ kind: 'drop', from, to });
  };

  const judge = (): void => {
    windows++;
    const med = median(frames, count, scratch);
    const cpu = median(cpus, count, scratch);
    lastMedian = round(med);
    lastCpuMedian = round(cpu);
    const start = windowStart;
    const miss = med > Math.max(GOVERNOR_MISS_MS[device], floorMs * GOVERNOR_CAP_MISS);
    const good = med < Math.max(GOVERNOR_GOOD_MS[device], floorMs * GOVERNOR_CAP_GOOD);

    if (miss) {
      const cpuBound = cpu >= GOVERNOR_CPU_FRACTION * med || cpu > GOVERNOR_CPU_TOTAL_MS[target.tier];
      lastVerdict = cpuBound ? 'miss-cpu' : 'miss-gpu';
      goodSince = null;
      if (missSince === null) missSince = start;
      // no flapping: the scale this miss followed up to is not tried again on this tier
      if (lastUp !== null && clock - lastUp.at <= GOVERNOR_RECOVER_MS + GOVERNOR_WINDOW_MS) ceiling = Math.min(ceiling, lastUp.from);
      lastUp = null;
      const moved = cpuBound ? pullNextLever() || scaleDown() : scaleDown() || pullNextLever();
      if (moved) {
        exhaustedSince = null;
        return;
      }
      if (exhaustedSince === null) exhaustedSince = start;
      const to = nextTier();
      if (pendingDrop !== null || to === null || target.explicitTier) return;
      const firstDesktop = device === 'desktop' && drops === 0;
      if (clock - exhaustedSince < GOVERNOR_FLOOR_HOLD_MS) return;
      if (firstDesktop && clock - missSince < GOVERNOR_DESKTOP_FIRST_DROP_MS) return;
      pendingDrop = to;
      emit({ kind: 'drop-scheduled', from: target.tier, to });
      applyPendingDrop();
      return;
    }

    missSince = null;
    exhaustedSince = null;
    if (!good) {
      lastVerdict = 'neutral';
      goodSince = null;
      return;
    }
    lastVerdict = 'good';
    if (goodSince === null) goodSince = start;
    if (clock - goodSince < GOVERNOR_RECOVER_MS) return;
    goodSince = null;
    const max = Math.min(range()[1], ceiling);
    const s = target.renderScale;
    if (s >= max - EPS) return;
    lastUp = { at: clock, from: s };
    setScale(Math.min(max, round(s + GOVERNOR_SCALE_UP)));
  };

  return {
    sample(frameMs: number, cpuMs: number): void {
      if (!enabled || phase === 'idle') return;
      if (!(frameMs > 0) || !Number.isFinite(frameMs)) return; // the first frame (realDt 0) says nothing
      const c = Number.isFinite(cpuMs) && cpuMs > 0 ? cpuMs : 0;
      if (count < RING) {
        frames[count] = frameMs;
        cpus[count] = c;
        count++;
      }
      windowMs += frameMs;
      clock += frameMs;
      if (windowMs < GOVERNOR_WINDOW_MS) return;
      if (count >= GOVERNOR_MIN_SAMPLES) judge();
      clearWindow();
    },

    setPhase(next: GovernorPhase): void {
      if (!(GOVERNOR_PHASES as readonly string[]).includes(next)) throw new RangeError(`governor: unknown phase ${JSON.stringify(next)}`);
      if (next === phase) return;
      phase = next;
      // a window never spans two phases: a load or a menu between them must not be judged as the scene
      clearWindow();
      if (next === 'idle') clearStreaks();
      applyPendingDrop();
    },

    get phase(): GovernorPhase {
      return phase;
    },

    setLevers(next) {
      levers = { ...levers, ...next };
    },

    setFrameFloor(ms: number): void {
      floorMs = Number.isFinite(ms) && ms > 0 ? ms : 0;
    },

    setEnabled(on: boolean): void {
      if ((on === true) === enabled) return;
      enabled = on === true;
      clearWindow();
      clearStreaks();
    },

    reset(): void {
      ceiling = Number.POSITIVE_INFINITY;
      lastUp = null;
      pendingDrop = null;
      clearStreaks();
      clearWindow();
    },

    onEvent(cb) {
      listeners.add(cb);
      return () => void listeners.delete(cb);
    },

    inspect(): GovernorState {
      return {
        enabled,
        phase,
        device,
        tier: target.tier,
        renderScale: target.renderScale,
        ceiling,
        pulled: CPU_LEVER_ORDER.filter((l) => pulled.has(l)),
        pendingDrop,
        drops,
        clockMs: round(clock),
        windows,
        lastVerdict,
        lastMedianMs: lastMedian,
        lastCpuMedianMs: lastCpuMedian,
        missSinceMs: missSince,
        exhaustedSinceMs: exhaustedSince,
      };
    },
  };
}
