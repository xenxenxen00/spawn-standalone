// UI2b rail: the right-side control cluster (docs/design/audio-ui-input.md §3.10).
//
// Geometry (width 50px, height 360px, top max(8px, calc(50vh - 180px))) lives in
// css/chrome.css under #port-chrome; this module owns structure and behavior:
// opacity .35 while pointer-locked, .9 otherwise; MUTE always; PAUSE always on
// touch and on desktop only when the cursor is free; FULLSCREEN only when the
// app provides the control (supported and not iOS).

import type { PageGlobals } from './types.ts';
import { globalPageGlobals } from './types.ts';

/** provided by the app only when fullscreen is supported and the device is not iOS */
export interface FullscreenControl {
  toggle(): void;
}

export interface RailDeps {
  /** PortUiState.touchActive */
  touchActive: boolean;
  /** the app's pause trigger (the lead wires the pause controller / game pause act) */
  onPause(): void;
  /** null/omitted: no fullscreen button */
  fullscreen?: FullscreenControl | null;
  globals?: PageGlobals;
}

const SPEAKER_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 9v6h4l5 5V4L7 9H3z"/>' +
  '<path d="M16.5 8.6a4.6 4.6 0 0 1 0 6.8" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const PAUSE_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h4v14H7zM13 5h4v14h-4z"/></svg>';
const FULLSCREEN_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">' +
  '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';

export class Rail {
  readonly el: HTMLDivElement;
  readonly #doc: Document;
  readonly #deps: RailDeps;
  readonly #globals: PageGlobals;
  #pauseBtn: HTMLButtonElement | null = null;
  #platformTag: HTMLSpanElement | null = null;
  #locked = false;
  #touchActive: boolean;
  #userMuted = false;
  #platformMuted = false;

  constructor(doc: Document, parent: HTMLElement, deps: RailDeps) {
    this.#doc = doc;
    this.#deps = deps;
    this.#globals = deps.globals ?? globalPageGlobals();
    this.#touchActive = deps.touchActive;
    const el = doc.createElement('div');
    el.className = 'ss-rail';
    el.setAttribute('role', 'toolbar');
    el.setAttribute('aria-label', 'Display controls');

    el.appendChild(this.#button('ss-rail-mute', 'Mute', SPEAKER_SVG, () => this.#globals.mute()));

    // PAUSE: always on touch; on desktop it is built too and shown only when the cursor is free
    const pause = this.#button('ss-rail-pause', 'Pause', PAUSE_SVG, () => this.#deps.onPause());
    this.#pauseBtn = pause;
    el.appendChild(pause);

    if (deps.fullscreen) {
      const fs = deps.fullscreen;
      el.appendChild(this.#button('ss-rail-fullscreen', 'Fullscreen', FULLSCREEN_SVG, () => fs.toggle()));
    }

    parent.appendChild(el);
    this.el = el;
    this.setLocked(false);
    this.#syncMuteButton();
  }

  /** dims the rail while pointer-locked; hides PAUSE on desktop unless the cursor is free */
  setLocked(locked: boolean): void {
    this.#locked = locked;
    this.el.style.opacity = locked ? '0.35' : '0.9';
    this.#syncPauseButton();
  }

  /** the input mode changed; recompute PAUSE visibility (locked && !touchActive) */
  setTouchActive(active: boolean): void {
    this.#touchActive = active;
    this.#syncPauseButton();
  }

  /** aria-pressed follows the player's own mute; the slashed icon (`is-muted`) shows any mute, the player's or the platform's */
  #syncMuteButton(): void {
    const mute = this.el.querySelector('.ss-rail-mute');
    if (!mute) return;
    mute.setAttribute('aria-pressed', this.#userMuted ? 'true' : 'false');
    mute.classList.toggle('is-muted', this.#userMuted || this.#platformMuted);
  }

  #syncPauseButton(): void {
    if (this.#pauseBtn) this.#pauseBtn.hidden = this.#locked && !this.#touchActive;
  }

  /** the player's own mute (prefs.muted): MUTE shows pressed and slashed */
  setUserMuted(muted: boolean): void {
    this.#userMuted = muted;
    this.#syncMuteButton();
  }

  /** shows the PLATFORM tag on MUTE (slashed) while the platform itself is muted */
  setPlatformMuted(muted: boolean): void {
    this.#platformMuted = muted;
    this.#syncMuteButton();
    if (muted && !this.#platformTag) {
      const tag = this.#doc.createElement('span');
      tag.className = 'ss-platform-tag';
      tag.textContent = 'PLATFORM';
      const mute = this.el.querySelector('.ss-rail-mute');
      if (mute) mute.appendChild(tag);
      this.#platformTag = tag;
    } else if (!muted && this.#platformTag) {
      this.#platformTag.remove();
      this.#platformTag = null;
    }
  }

  dispose(): void {
    this.el.remove();
    this.#pauseBtn = null;
    this.#platformTag = null;
  }

  #button(cls: string, label: string, svg: string, onClick: () => void): HTMLButtonElement {
    const btn = this.#doc.createElement('button');
    btn.type = 'button';
    btn.className = `ss-rail-btn ${cls}`;
    btn.setAttribute('aria-label', label);
    btn.innerHTML = svg;
    btn.addEventListener('click', onClick);
    return btn;
  }
}
