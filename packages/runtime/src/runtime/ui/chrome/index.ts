// UI2b chrome: rail, pause overlay, opt-in flash overlay, trophy toast, damage numbers.
//
// Owns the `#port-chrome` root (all styles scoped under it in css/chrome.css) and
// implements the `chrome.hasModal()` contract for UiHostDeps: the UI scan combines
// [data-modal] with chrome.hasModal(), then informs pointer lock.
//
// The lead wires this in compose.ts (see the integration note):
//   const chrome = new Chrome(document, uiContainer, { touchActive, onPause, fullscreen, screenFlash, ... });
//   host deps get `chrome: { hasModal: () => chrome.hasModal() }`
//   setSink('damageNumber', (act) => chrome.damage(act))
//   setSink('screenFlash', (act) => chrome.flash(act))

import { DamageNumbers, type DamageNumberAct, type DamageNumbersDeps } from '../damage-numbers.ts';
import {
  FlashOverlay,
  type FlashGuardControlLike,
  type FlashOverlayDeps,
  type ScreenFlashAct,
} from './flash-overlay.ts';
import { PauseOverlay, type PauseReason, type PauseOverlayOptions } from './pause-overlay.ts';
import { Rail, type FullscreenControl } from './rail.ts';
import { Toast, type ToastInfo } from './toast.ts';
import type { PageGlobals, ScreenPoint, UiClock, Vec3Like } from './types.ts';
import { globalPageGlobals } from './types.ts';

export { DamageNumbers, type DamageNumberAct } from '../damage-numbers.ts';
export { FlashOverlay, type FlashGuardControlLike, type ScreenFlashAct } from './flash-overlay.ts';
export { PauseOverlay, type PauseReason } from './pause-overlay.ts';
export { Rail, type FullscreenControl } from './rail.ts';
export { Toast, type ToastInfo } from './toast.ts';
export type { PageGlobals, ScreenPoint, UiClock, Vec3Like } from './types.ts';
export { globalPageGlobals } from './types.ts';

export interface ChromeDeps {
  /** PortUiState.touchActive */
  touchActive: boolean;
  /** whether the pointer is currently locked (initial rail state) */
  locked?: boolean;
  /** the app's pause trigger (the lead wires the pause controller / game pause act) */
  onPause(): void;
  /** present only when fullscreen is supported and the device is not iOS */
  fullscreen?: FullscreenControl | null;
  /** port.screenFlash: 'overlay' routes the screenFlash act; default 'off' is a no-op (X-12) */
  screenFlash?: 'off' | 'overlay';
  reducedFlash?: boolean | (() => boolean);
  /** the FlashGuard control, or a getter (the renderer may load after construction) */
  flashGuard?: FlashGuardControlLike | (() => FlashGuardControlLike | null | undefined);
  /** the renderer projection contract for damage numbers (world → CSS px) */
  project(point: Vec3Like): ScreenPoint | null;
  globals?: PageGlobals;
  pause?: PauseOverlayOptions;
  clock?: UiClock;
}

export class Chrome {
  readonly root: HTMLDivElement;
  readonly #rail: Rail;
  readonly #pause: PauseOverlay;
  readonly #flash: FlashOverlay;
  readonly #toast: Toast;
  readonly #damage: DamageNumbers;
  #gameplayActive = false;
  #paused = false;
  #reason: PauseReason = 'user';

  constructor(doc: Document, mount: HTMLElement, deps: ChromeDeps) {
    const globals = deps.globals ?? globalPageGlobals();
    const root = doc.createElement('div');
    root.id = 'port-chrome';
    mount.appendChild(root);
    this.root = root;
    // exception safety: if a child constructor throws, the appended partial
    // root is removed so no orphaned #port-chrome leaks
    try {
      const clock = deps.clock;
      this.#rail = new Rail(doc, root, {
        touchActive: deps.touchActive,
        onPause: deps.onPause,
        fullscreen: deps.fullscreen ?? null,
        globals,
      });
      // initialize from the current pointer-lock state (a canvas locked before
      // composition stays visually locked)
      if (deps.locked === true) this.#rail.setLocked(true);
      this.#pause = new PauseOverlay(doc, root, globals, deps.pause);
      // exactOptionalPropertyTypes: only set the optional deps that are present
      const flashDeps: FlashOverlayDeps = { mode: deps.screenFlash ?? 'off' };
      if (deps.reducedFlash !== undefined) flashDeps.reducedFlash = deps.reducedFlash;
      if (deps.flashGuard !== undefined) flashDeps.flashGuard = deps.flashGuard;
      if (clock !== undefined) flashDeps.clock = clock;
      this.#flash = new FlashOverlay(doc, root, flashDeps);
      this.#toast = new Toast(doc, root, clock);
      const damageDeps: DamageNumbersDeps = { project: deps.project };
      if (clock !== undefined) damageDeps.clock = clock;
      this.#damage = new DamageNumbers(doc, root, damageDeps);
    } catch (err) {
      root.remove();
      throw err;
    }
  }

  /** the UiHostDeps.chrome contract: true while the pause modal stands */
  hasModal(): boolean {
    return this.#pause.visible;
  }

  setPointerLocked(locked: boolean): void {
    this.#rail.setLocked(locked);
  }

  /** the input mode changed; the rail recomputes PAUSE visibility (locked && !touchActive) */
  setTouchActive(active: boolean): void {
    this.#rail.setTouchActive(active);
  }

  /** the player's own mute (prefs.muted): the rail's MUTE shows it */
  setUserMuted(muted: boolean): void {
    this.#rail.setUserMuted(muted);
  }

  setPlatformMuted(muted: boolean): void {
    this.#rail.setPlatformMuted(muted);
  }

  /** the pause overlay shows only while a match runs — never LOBBY/RESULTS */
  setGameplayActive(running: boolean): void {
    this.#gameplayActive = running;
    this.#syncPause();
  }

  setPaused(paused: boolean, reason: PauseReason = 'user'): void {
    this.#paused = paused;
    this.#reason = reason;
    this.#syncPause();
  }

  /** the `screenFlash` sink act: no-op unless constructed with screenFlash 'overlay' */
  flash(act: ScreenFlashAct): void {
    this.#flash.flash(act);
  }

  /** the `damageNumber` sink act */
  damage(act: DamageNumberAct): void {
    this.#damage.spawn(act);
  }

  toast(info: ToastInfo): void {
    this.#toast.show(info);
  }

  dispose(): void {
    this.#rail.dispose();
    this.#pause.dispose();
    this.#flash.dispose();
    this.#toast.dispose();
    this.#damage.dispose();
    this.root.remove();
  }

  #syncPause(): void {
    if (this.#paused && this.#gameplayActive) this.#pause.show(this.#reason);
    else this.#pause.hide();
  }
}
