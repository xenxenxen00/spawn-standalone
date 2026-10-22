// Engine constants, engine rule switches and the X-07 pause-reason tables (docs/design/core-runtime.md §3.6;
// docs/architecture.md X-07, X-12). Every number cites the section that fixes it.
import type { ActName, ExtraActName, PauseReason, Vec3 } from './types.ts';

export const ENGINE = Object.freeze({
  TICK_HZ: 30,
  TICK_MS: 1000 / 30,
  /** ctx.now() at tick 0 (core §17.5: every `now - 0 > threshold` gate is open at boot, as on a long-lived room) */
  NOW_EPOCH_MS: 1_000_000,
  /** sim.js and place sims run every 3rd tick (the "100ms" cadence, core §9.2) ... */
  SIM_EVERY_TICKS: 3,
  /** ... at ticks where tick % 3 === 2, so the first sim tick sees a world that has run two ticks (core §9.2) */
  SIM_TICK_PHASE: 2,
  /** the only cadence a live sim declares (core §12.2) */
  SIM_CADENCE_MS: 100,
  /** the rig runs once per rendered frame with dt clamped (X-09; live ran it at 120 Hz) */
  RIG_DT_MAX_S: 0.1,
  /** kernel.advance runs at most this many ticks per frame and drops the rest (core §9.7) */
  MAX_TICKS_PER_FRAME: 2,
  /** kernel.advance clamps the frame dt (core §9.7) */
  MAX_FRAME_DT_MS: 250,
  /** events delivered per phase-boundary drain before the rest waits (core §8.3) */
  DRAIN_CAP: 10_000,
  /** update() locality radius (api:465; every live map fits inside it, core §9.4) */
  LOCALITY_RADIUS_M: 500,
  /** worldBounds.bottom default: 64 m under the spawn point (engine reference) */
  OOB_DEFAULT_DEPTH_M: 64,
  /** an out-of-bounds row is latched until it is back above bottom + this (core §11.7) */
  OOB_RELATCH_M: 1,
  GRAVITY_DEFAULT: Object.freeze({ x: 0, y: -9.81, z: 0 }) as Readonly<Vec3>,
  /** a world/state row over 32 KB is warned (engine reference) */
  STATE_WARN_BYTES: 32 * 1024,
  /** scene cell size: cellKeyOf rounds x/128, z/128 (contract §3.7) */
  CELL_SIZE_M: 128,
  /** spatial index cell over feet xz (core §5.1) */
  SPATIAL_CELL_M: 16,
  /** hidden ticks after a place activation while the screen is still covered (core §11.5) */
  ACTIVATION_WARMUP_TICKS: 15,
  /** boot warm-up after the UI mounts (core §14 step 13) */
  BOOT_WARMUP_TICKS: 30,
  /** identical log lines are rate-limited to one per 5 s with a count (core §7.1) */
  LOG_REPEAT_MS: 5000,
  /** debug-overlay ring buffer (core §2 dev/log.ts) */
  LOG_RING_LINES: 2000,
} as const);

/** Engine behaviour switches whose live answer is inferred (core §3.6, §17); a kernel takes overrides in KernelOptions.rules. */
export interface EngineRules {
  /** contract §3.6.1 D1 (M21): a row dies with the row whose behaviour spawned it, parent or not */
  spawnerOwnership: 'cascade' | 'off';
  /** core §8.4: the sims a default emit (no `to`, no `audience`) reaches */
  defaultEmitReachesSims: 'samePlace' | 'all' | 'none';
  /** contract §3.6: "the port should always run it", also on a place unload */
  runOnDestroyOnUnload: boolean;
}

export const ENGINE_RULES: Readonly<EngineRules> = Object.freeze({
  spawnerOwnership: 'cascade',
  defaultEmitReachesSims: 'samePlace',
  runOnDestroyOnUnload: true,
});

/** contract §3.6.1 D2: read through the port-only spec flag `__portUnowned` (tracked edit E-GP-01, reserved) */


/** ENGINE_RULES with a kernel's overrides applied (undefined entries keep the default) */
export function resolveRules(overrides?: Partial<EngineRules>): Readonly<EngineRules> {
  const out: EngineRules = { ...ENGINE_RULES };
  if (overrides) {
    for (const k of Object.keys(out) as Array<keyof EngineRules>) {
      const v = overrides[k];
      if (v !== undefined) (out as unknown as Record<string, unknown>)[k] = v;
    }
  }
  return Object.freeze(out);
}

// ── X-07: the one pause-reason union, at run time ────────────────────────────────────────────────────────────────────

/** Built-in reasons; hosts may add any other nonempty name. */
export const PAUSE_REASONS = Object.freeze([
  'boot',
  'loading',
  'preparing',
  'platform',
  'hidden',
  'overlay',
  'orientation',
  'gpu',
  'test',
] as const satisfies readonly PauseReason[]);

/** who sets each reason (X-07): the kernel (`boot` until boot finishes, `loading` during a sim-side place load), the app's
 *  LOADING gate (`preparing`), the platform domain's PauseController (the rest, build §6.4) */
export const PAUSE_REASON_OWNER: Readonly<Partial<Record<PauseReason, 'kernel' | 'loading-gate' | 'pause-controller'>>> = Object.freeze({
  boot: 'kernel',
  loading: 'kernel',
  preparing: 'loading-gate',
  platform: 'pause-controller',
  hidden: 'pause-controller',
  overlay: 'pause-controller',
  orientation: 'pause-controller',
  gpu: 'pause-controller',
  test: 'pause-controller',
});

/** the reasons the PauseController adds and removes (build §6.4 `HostPauseReason`) */
export const HOST_PAUSE_REASONS = Object.freeze([
  'platform',
  'hidden',
  'overlay',
  'orientation',
  'gpu',
  'test',
] as const satisfies ReadonlyArray<Exclude<PauseReason, 'boot' | 'loading' | 'preparing'>>);

/** audio is suspended while any of these is set; not for boot, loading, preparing or test (X-07, core §9.1) */
export const AUDIO_SUSPEND_REASONS = Object.freeze([
  'platform',
  'hidden',
  'overlay',
  'orientation',
  'gpu',
] as const satisfies readonly PauseReason[]);

/** A platform or hidden pause that starts during a match also adds `overlay` (resume needs the re-lock click) */
export const OVERLAY_ESCALATING_REASONS = Object.freeze(['platform', 'hidden'] as const satisfies readonly PauseReason[]);

const AUDIO_SUSPEND_SET: ReadonlySet<PauseReason> = new Set(AUDIO_SUSPEND_REASONS);

export function isPauseReason(x: unknown): x is PauseReason {
  return typeof x === 'string' && x.length > 0;
}

/** true when a set of active reasons must silence audio (X-07) */
export function suspendsAudio(reasons: Iterable<PauseReason>, audioSuspend: readonly PauseReason[] = AUDIO_SUSPEND_REASONS): boolean {
  const set = audioSuspend === AUDIO_SUSPEND_REASONS ? AUDIO_SUSPEND_SET : new Set(audioSuspend);
  for (const r of reasons) if (set.has(r)) return true;
  return false;
}

// ── engine acts (core §8.6, contract §6.4) ───────────────────────────────────────────────────────────────────────────

/** the engine act names; any other emit name is a custom event */
export const ACT_NAMES = Object.freeze([
  'playSound',
  'stopSound',
  'fx',
  'decal',
  'screenShake',
  'cameraPunch',
  'screenFlash',
  'hitstop',
  'shake',
  'impulse',
  'shockwave',
  'damageNumber',
  'uiEvent',
  'slowMo',
  'milestone',
  'highlightSet',
  'highlightClear',
] as const satisfies readonly ActName[]);

/** optional extended acts; they route as engine acts only under `ext.extraActs`, else they stay custom events */
export const EXTRA_ACT_NAMES = Object.freeze(['squash', 'flash', 'slash'] as const satisfies readonly ExtraActName[]);

const EXTRA_ACT_NAME_SET: ReadonlySet<string> = new Set(EXTRA_ACT_NAMES);

export function isExtraActName(x: unknown): x is ExtraActName {
  return typeof x === 'string' && EXTRA_ACT_NAME_SET.has(x);
}

const ACT_NAME_SET: ReadonlySet<string> = new Set(ACT_NAMES);

export function isActName(x: unknown): x is ActName {
  return typeof x === 'string' && ACT_NAME_SET.has(x);
}

// The run-time lists above must name every member of their unions: a missing member fails `tsc -b` here.
type Missing<Union, Listed> = Exclude<Union, Listed>;
type AssertNever<T extends never> = T;
export type _ActNamesComplete = AssertNever<Missing<Exclude<ActName, ExtraActName>, (typeof ACT_NAMES)[number]>>;
