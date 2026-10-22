// Modal ↔ pointer lock ↔ resume prompt (io §3.9, §4.6; spawn-engine-contract.md §14.1-14.2; X-07; WP UI2a).
//
// The `PointerLockManager` (IN1, ../input/pointer-lock.ts) already implements most rows of io §3.9: a modal that appears
// releases the lock and stops the canvas requesting it, the closing click re-locks inside its gesture (`relockPointer`), a lock
// lost with no modal in a match adds the pause reason `overlay`, a refused request is a 1.1 s cooldown, touch never locks.
// What it does not know is that a modal went away WITHOUT a click: a phase change closes the shop at WAVE, the results time
// out, a panel is closed from the keyboard. The cursor is then free in a running match with nothing asking for it back. Live
// re-locked by itself there (the Spawn client needs no gesture); a browser does, so row 3 shows the resume prompt (chrome):
// "CLICK TO RESUME" over a 35 % dim, and the next click on it or on the canvas requests the lock. The sim keeps running (live:
// closing panels never paused; build B-6).
//
// `ModalLock` sits between the UI host and the manager: it is the host's `pointer` dep (`UiHostDeps.pointer`), forwards every
// `setModal` to the manager and watches the edges.
//
//   armed    set when the modal goes away (the falling edge of `setModal`) unless the pointer is locked at that moment;
//            cleared when a modal appears and when the lock is obtained
//   visible  armed, no modal, a match is running, touch is not active, the pause reason `overlay` is not set, and the lock
//            state is `free` or `cooldown` (or `locking`, once the prompt is already up)
//
// Why each term:
//   - The closing click (row 2) requested the lock before the panel left the DOM: the manager is `locking` or `locked` while
//     the panel is still reported for a frame or two. At the falling edge a `locked` pointer does not arm, and a `locking` one
//     arms but stays hidden until the request is answered: granted → disarmed, never shown; refused (`cooldown`) → shown, which
//     is contract §14.2's "re-lock on the next click if refused". So that click never flashes the prompt, however many frames
//     or milliseconds the panel and the browser take.
//   - Esc, alt-tab or a browser revoke in a match (row 4) is not preceded by a modal edge: not armed, so the prompt does not
//     show in the moment between the manager's state change and its `pause.add('overlay')`. The pause overlay (UI2b) owns that
//     case, and the platform pauses of row 6, hence the `overlay` term; the pause controller's change event hides the prompt
//     at once, without waiting for a UI frame.
//   - Outside a match (LOBBY, LOADING, RESULTS) menus own the cursor (row 5). `armed` survives that: a card that went away just
//     before the phase turned still leads to the prompt once the match runs.
//   - A refused request (row 7) leaves the prompt up: it stays through `locking` and `cooldown` and goes only at `locked`. During
//     the cooldown the manager ignores requests, so a click does nothing and the next click after it retries.
//   - The click on the prompt calls `requestLock('resume')` synchronously inside the click listener (a user gesture), and only
//     through the manager: no canvas is cached here, so a replaced canvas (X3: the manager's target changes) keeps working.
//   - The prompt is not a modal: it never reaches the host's scan (it lives in `#port-chrome`, carries no `data-modal`) and
//     `PortChrome.hasModal()` (UI2b) must not count it.
//
// The getters are read on every `setModal` (each UI frame, also while paused), on every lock-state change and on every pause
// change; `update()` is there for a caller that wants a phase change applied before the next UI frame.
import type { LockState } from '../input/pointer-lock.ts';
import { ResumePrompt } from './chrome/resume-prompt.ts';

export interface ModalLockDeps {
  /** the PointerLockManager (io §4.6) */
  pointer: {
    readonly state: LockState;
    setModal(modal: boolean): void;
    requestLock(origin: 'resume'): void;
    onChange(fn: (s: LockState) => void): () => void;
  };
  /** the chrome layer the prompt is built in (`#port-chrome`) */
  parent: HTMLElement;
  /** `ss.phase` not in LOBBY, LOADING, RESULTS (the lifecycle binding; `PauseController.gameplayActive`) */
  gameplayActive: () => boolean;
  /** true while touch is the live input (default: never) */
  touchActive?: () => boolean;
  /** the PauseController: the prompt never shows while `overlay` is set, and hides the moment it is added */
  pause?: { has(reason: 'overlay'): boolean; onChange(fn: () => void): () => void } | null;
}

export class ModalLock {
  readonly #pointer: ModalLockDeps['pointer'];
  readonly #gameplayActive: () => boolean;
  readonly #touchActive: () => boolean;
  readonly #pause: NonNullable<ModalLockDeps['pause']> | null;
  readonly #prompt: ResumePrompt;
  readonly #offs: Array<() => void> = [];
  #modal = false;
  #armed = false;
  #disposed = false;

  constructor(deps: ModalLockDeps) {
    this.#pointer = deps.pointer;
    this.#gameplayActive = deps.gameplayActive;
    this.#touchActive = deps.touchActive ?? (() => false);
    this.#pause = deps.pause ?? null;
    this.#prompt = new ResumePrompt(deps.parent);
    // synchronously inside the click: the request needs the user gesture
    this.#offs.push(this.#prompt.onClick(() => this.#pointer.requestLock('resume')));
    this.#offs.push(
      this.#pointer.onChange((s) => {
        if (s === 'locked') this.#armed = false;
        this.update();
      }),
    );
    if (this.#pause) this.#offs.push(this.#pause.onChange(() => this.update()));
  }

  /** true while "CLICK TO RESUME" is on screen */
  get promptVisible(): boolean {
    return this.#prompt.visible;
  }

  /** the prompt's element (for the chrome to order its layers) */
  get promptElement(): HTMLElement {
    return this.#prompt.element;
  }

  /** `UiHostDeps.pointer`: from the UI host every UI frame, a `[data-modal]` panel or a chrome modal stands */
  setModal(modal: boolean): void {
    if (this.#disposed) return;
    if (modal !== this.#modal) {
      // own state first: forwarding a modal that appears makes the manager release the lock, which calls back into update()
      this.#modal = modal;
      this.#armed = !modal && this.#pointer.state !== 'locked';
    }
    this.#pointer.setModal(modal);
    this.update();
  }

  /** re-evaluates the prompt from the current inputs */
  update(): void {
    if (this.#disposed) return;
    let show = false;
    if (this.#armed && !this.#modal) {
      const s = this.#pointer.state;
      const waiting = s === 'free' || s === 'cooldown' || (s === 'locking' && this.#prompt.visible);
      show = waiting && this.#gameplayActive() && !this.#touchActive() && !(this.#pause?.has('overlay') ?? false);
    }
    if (show) this.#prompt.show();
    else this.#prompt.hide();
  }

  /** removes the prompt's DOM and every listener; the manager and the pause controller are the caller's */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const off of this.#offs.splice(0)) off();
    this.#prompt.dispose();
  }
}
