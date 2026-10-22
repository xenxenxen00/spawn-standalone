// UI2b flash overlay: the opt-in screen flash (X-12, §3.10).
//
// Routed only when constructed with mode 'overlay' (port.screenFlash); the default
// is a no-op. Onset alpha = min(0.25, 0.35 * intensity), linear fade over the
// duration; events within 334 ms merge (max intensity, extend end). With reduced
// flash the rendered alpha goes through the FlashGuard 'screenFlash' channel
// (base .25): FlashGuardControl.channel(key, base).apply(target, nowMs, dtSec),
// dt in seconds. The channel is resolved lazily — a late renderer and a toggled
// preference both take effect without rebuilding the overlay — and released on
// dispose.

import type { UiClock } from './types.ts';
import { systemClock } from './types.ts';

/** the `screenFlash` sink act payload */
export interface ScreenFlashAct {
  intensity: number;
  durationMs: number;
  /** the act's `color` (a CSS colour); the latest one wins, a merged onset keeps the running colour */
  color?: string;
}

/** the FlashGuard channel UI2b expects (structural; the real one is `render/lighting/flash-guard.ts`) */
export interface FlashGuardChannel {
  apply(target: number, nowMs: number, dtSec: number): number;
}

/** structural FlashGuardControl (the real one is `createFlashGuard()` in `render/lighting/flash-guard.ts`) */
export interface FlashGuardControlLike {
  channel(key: string, base: number): FlashGuardChannel;
}

export interface FlashOverlayDeps {
  /** 'overlay' routes the act; anything else (default 'off') is a no-op */
  mode?: 'off' | 'overlay';
  reducedFlash?: boolean | (() => boolean);
  /** the guard control, or a getter (the renderer may load after construction) */
  flashGuard?: FlashGuardControlLike | (() => FlashGuardControlLike | null | undefined);
  clock?: UiClock;
}

export const FLASH_MERGE_WINDOW_MS = 334;
export const FLASH_ONSET_CAP = 0.25;
export const FLASH_GUARD_CHANNEL = 'screenFlash';
export const FLASH_GUARD_BASE = 0.25;
const TICK_MS = 16;

export class FlashOverlay {
  readonly el: HTMLDivElement;
  readonly #mode: 'off' | 'overlay';
  readonly #clock: UiClock;
  readonly #reducedFlash: boolean | (() => boolean);
  readonly #guardControl: FlashGuardControlLike | (() => FlashGuardControlLike | null | undefined) | undefined;
  /** the control the live channel belongs to (null until the first one resolves) */
  #channelControl: FlashGuardControlLike | null = null;
  #guard: FlashGuardChannel | null = null;
  #active = false;
  #start = 0;
  #end = 0;
  #intensity = 0;
  #lastTick = 0;
  #cancelTick: (() => void) | null = null;

  constructor(doc: Document, parent: HTMLElement, deps: FlashOverlayDeps = {}) {
    this.#mode = deps.mode ?? 'off';
    this.#clock = deps.clock ?? systemClock();
    this.#reducedFlash = deps.reducedFlash ?? false;
    this.#guardControl = deps.flashGuard;
    // the guard channel is resolved lazily: a late renderer and a toggled
    // preference both take effect without rebuilding the overlay
    const el = doc.createElement('div');
    el.className = 'ss-flash';
    el.setAttribute('aria-hidden', 'true');
    el.style.opacity = '0';
    el.hidden = true;
    parent.appendChild(el);
    this.el = el;
  }

  get active(): boolean {
    return this.#active;
  }

  flash(act: ScreenFlashAct): void {
    if (this.#mode !== 'overlay') return;
    const intensity = Math.max(0, act.intensity);
    const durationMs = Math.max(0, act.durationMs);
    const t = this.#clock.now();
    if (this.#active && t - this.#start < FLASH_MERGE_WINDOW_MS) {
      this.#intensity = Math.max(this.#intensity, intensity);
      this.#end = Math.max(this.#end, t + durationMs);
      this.#render(t);
      return;
    }
    this.#start = t;
    this.#end = t + durationMs;
    this.#intensity = intensity;
    // css/chrome.css draws white unless the act names a colour (an invalid value is ignored by the CSSOM)
    this.el.style.backgroundColor = act.color ?? '';
    if (!this.#active) {
      this.#active = true;
      this.el.hidden = false;
      this.#lastTick = t;
      this.#schedule();
    }
    this.#render(t);
  }

  /** the alpha currently rendered (null when inactive); for tests */
  currentAlpha(): number | null {
    if (!this.#active) return null;
    return this.#alphaAt(this.#clock.now());
  }

  dispose(): void {
    if (this.#cancelTick) {
      this.#cancelTick();
      this.#cancelTick = null;
    }
    this.#active = false;
    // release the guard channel; a recreated overlay gets a fresh one
    const control = this.#channelControl;
    (control as { release?: (key: string) => void } | null)?.release?.(FLASH_GUARD_CHANNEL);
    this.#channelControl = null;
    this.#guard = null;
    this.el.remove();
  }

  #schedule(): void {
    if (this.#cancelTick) this.#cancelTick();
    // clamp the next tick to the fade end so the stop lands exactly on it
    const t = this.#clock.now();
    const next = Math.min(t + TICK_MS, this.#end);
    this.#cancelTick = this.#clock.after(Math.max(0, next - t), () => this.#tick());
  }

  #tick(): void {
    const t = this.#clock.now();
    if (t >= this.#end) {
      this.#stop();
      return;
    }
    this.#render(t);
    this.#schedule();
  }

  #alphaAt(t: number): number {
    const span = this.#end - this.#start;
    if (span <= 0) return 0;
    const onset = Math.min(FLASH_ONSET_CAP, 0.35 * this.#intensity);
    const k = Math.min(1, Math.max(0, (t - this.#start) / span));
    return onset * (1 - k);
  }

  #render(t: number): void {
    const dtMs = t - this.#lastTick;
    this.#lastTick = t;
    let a = this.#alphaAt(t);
    const guard = this.#liveGuard();
    // the real guard expects dt in seconds, not milliseconds
    if (guard) a = guard.apply(a, t, dtMs / 1000);
    this.el.style.opacity = String(a);
  }

  /** the reduced-flash preference, live */
  #isReduced(): boolean {
    return typeof this.#reducedFlash === 'function' ? this.#reducedFlash() : this.#reducedFlash;
  }

  /**
   * The guard channel once a guard control is available. The control's enabled state is synced with the live
   * preference (the renderer only sets it once at load, so a false→true change after construction must activate
   * the channel here, and true→false must deactivate it). The channel is kept while disabled: the stateful guard
   * tracks the displayed value through apply(), so true→false→true resumes from a fresh baseline instead of
   * stale/over-bright. A changed control releases the old channel first.
   */
  #liveGuard(): FlashGuardChannel | null {
    const control = typeof this.#guardControl === 'function' ? this.#guardControl() : (this.#guardControl ?? null);
    if (control !== this.#channelControl) {
      // the control changed (a late renderer arrived, or went away): release the old channel
      const prev = this.#channelControl;
      (prev as { release?: (key: string) => void } | null)?.release?.(FLASH_GUARD_CHANNEL);
      this.#channelControl = control ?? null;
      this.#guard = control?.channel(FLASH_GUARD_CHANNEL, FLASH_GUARD_BASE) ?? null;
    }
    if (control === null || this.#guard === null) return null;
    if (typeof (control as { setEnabled?: unknown }).setEnabled === 'function') {
      (control as unknown as { setEnabled(on: boolean): void }).setEnabled(this.#isReduced());
    }
    return this.#guard;
  }

  #stop(): void {
    this.#active = false;
    if (this.#cancelTick) {
      this.#cancelTick();
      this.#cancelTick = null;
    }
    this.el.style.opacity = '0';
    this.el.hidden = true;
  }
}
