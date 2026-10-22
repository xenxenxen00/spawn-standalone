// Pointer lock (io §4.4, §4.6, §3.9; X-07).
//
// The lock is requested with the plain call, `canvas.requestPointerLock()`, as under Spawn: the measured live look scale
// (100 px = 0.180 rad) was taken from movementX/Y under Spawn's ordinary pointer lock, so the operating system's pointer
// acceleration shaped the live feel, and nothing in the engine indicates raw input. `{ unadjustedMovement: true }` is passed
// only when the RAW MOUSE INPUT setting is on (`port.rawMouse`, default off, io §3.12); if the browser rejects the option the
// plain call is made instead and `rawSupported` turns false (SETTINGS then shows "not supported"). Toggling the setting while
// locked re-requests the lock with or without the option (allowed without a gesture while locked).
//
// States: free → locking → locked; a `pointerlockerror` (or the browser's ~1 s re-lock refusal after Esc) → cooldown for 1.1 s,
// then free (the overlay's RESUME retries on the next click). Rules (io §3.9): a `data-modal` panel releases the lock and the
// canvas stops requesting it on click (a UI click that closes the modal still may: `relockPointer`); with touch active the lock
// is never requested; a lock lost with no modal while a match runs adds the pause reason `overlay` (X-07: the sim pauses and the
// pause overlay shows; resume needs a click). Resume clears it: a lock granted for an explicit gesture request (the canvas
// click, a UI relock, the overlay's RESUME) removes `overlay`; a refused request keeps it, and a settings-driven re-request
// (the RAW MOUSE toggle) or an unrequested lock change never removes it. An explicit gesture arriving while already locked
// is still a valid resume and removes `overlay` idempotently, requesting nothing.

export type LockState = 'free' | 'locking' | 'locked' | 'cooldown';
export type LockOrigin = 'canvas' | 'ui' | 'resume';

export const RELOCK_COOLDOWN_MS = 1100;

/** the canvas side of the Pointer Lock API (an HTMLCanvasElement) */
export interface LockTarget extends EventTarget {
  requestPointerLock(options?: { unadjustedMovement?: boolean }): Promise<void> | void;
}

/** the document side of the Pointer Lock API */
export interface LockDocument extends EventTarget {
  readonly pointerLockElement: unknown;
  exitPointerLock(): void;
}

export interface PointerLockOptions {
  canvas: LockTarget;
  document?: LockDocument;
  /**
   * the PauseController: a lock lost with no modal while a match runs adds `overlay`; a lock granted for an explicit
   * gesture request removes it again (idempotent: an explicit gesture while already locked removes it too)
   */
  pause?: { add(reason: 'overlay'): void; remove(reason: 'overlay'): void } | null;
  /** RAW MOUSE INPUT (`port.rawMouse`), default off */
  rawMouse?: boolean;
  /** true while touch is the live input (the lock is then never requested) */
  touchActive?: () => boolean;
  /** false = the camera def says `pointerLock: false`: the cursor stays free, no lock is ever requested (a RESUME still clears `overlay`); default true */
  enabled?: boolean;
}

const isPromise = (v: unknown): v is Promise<void> => typeof (v as { then?: unknown } | null)?.then === 'function';
interface Attempt {
  /** requested with `{ unadjustedMovement: true }` */
  raw: boolean;
  /** answered (locked, or failed into the cooldown), or abandoned */
  settled: boolean;
  /** the call returned a promise (its rejection carries the reason) */
  promise: boolean;
  /** started by an explicit gesture (`requestLock`): only its grant may remove the `overlay` pause reason */
  explicit: boolean;
}

const errorName = (e: unknown): string => (typeof (e as { name?: unknown } | null)?.name === 'string' ? (e as { name: string }).name : '');

export class PointerLockManager {
  readonly #canvas: LockTarget;
  readonly #doc: LockDocument;
  readonly #pause: { add(reason: 'overlay'): void; remove(reason: 'overlay'): void } | null;
  readonly #touchActive: () => boolean;
  readonly #enabled: boolean;
  readonly #subs = new Set<(s: LockState) => void>();
  readonly #offs: Array<() => void> = [];
  #state: LockState = 'free';
  #modal = false;
  #gameplayActive = false;
  #raw: boolean;
  #rawSupported: boolean | null = null;
  /** the current request; answers to an older one are ignored */
  #attempt: Attempt = { raw: false, settled: true, promise: false, explicit: false };
  #cooldownTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: PointerLockOptions) {
    this.#canvas = opts.canvas;
    this.#doc = opts.document ?? (globalThis.document as unknown as LockDocument);
    this.#pause = opts.pause ?? null;
    this.#raw = opts.rawMouse === true;
    this.#enabled = opts.enabled !== false;
    this.#touchActive = opts.touchActive ?? (() => false);
    const on = (t: EventTarget, type: string, fn: () => void): void => {
      t.addEventListener(type, fn);
      this.#offs.push(() => t.removeEventListener(type, fn));
    };
    on(this.#canvas, 'click', () => this.requestLock('canvas'));
    on(this.#doc, 'pointerlockchange', () => this.#onChange());
    on(this.#doc, 'pointerlockerror', () => this.#onErrorEvent());
  }

  get state(): LockState {
    return this.#state;
  }

  get rawMouse(): boolean {
    return this.#raw;
  }

  /** null until a raw request was answered; false once the browser refused `unadjustedMovement` */
  get rawSupported(): boolean | null {
    return this.#rawSupported;
  }

  /**
   * From the UI host every frame: a `[data-modal]` panel or a chrome modal is up. Only a modal that appears releases the lock:
   * the click that closes a panel re-locks at once (`relockPointer`) while the panel is still reported for the frame or two
   * until the body has closed it, and that lock must stand.
   */
  setModal(modal: boolean): void {
    const appeared = modal && !this.#modal;
    this.#modal = modal;
    if (appeared && (this.#state === 'locked' || this.#state === 'locking')) {
      this.#attempt.settled = true;
      if (this.#doc.pointerLockElement === this.#canvas) this.#doc.exitPointerLock();
      if (this.#state === 'locking') this.#set('free');
    }
  }

  /** `ss.phase` not in LOBBY, LOADING, RESULTS */
  setGameplayActive(running: boolean): void {
    this.#gameplayActive = running;
  }

  /** RAW MOUSE INPUT changed (`ssPortSetting('rawMouse', …)`): while locked, re-request with or without the option */
  setRawMouse(on: boolean): void {
    if (on === this.#raw) return;
    this.#raw = on;
    if (this.#state === 'locked') this.#request();
  }

  /** must be called inside a user gesture (a click) */
  requestLock(origin: LockOrigin): void {
    if (!this.#enabled) {
      if (origin !== 'canvas') this.#pause?.remove('overlay');
      return;
    }
    if (this.#touchActive()) return;
    if (origin === 'canvas' && this.#modal) return;
    if (this.#state === 'locked') {
      // an explicit gesture while already locked is a valid resume: remove `overlay` (idempotent), request nothing
      this.#pause?.remove('overlay');
      return;
    }
    if (this.#state !== 'free') return;
    this.#request(this.#raw && this.#rawSupported !== false, true);
  }

  onChange(fn: (s: LockState) => void): () => void {
    this.#subs.add(fn);
    return () => void this.#subs.delete(fn);
  }

  dispose(): void {
    for (const off of this.#offs.splice(0)) off();
    if (this.#cooldownTimer !== null) clearTimeout(this.#cooldownTimer);
    this.#cooldownTimer = null;
    this.#subs.clear();
    this.#attempt.settled = true;
  }

  #request(raw: boolean = this.#raw && this.#rawSupported !== false, explicit = false): void {
    const attempt: Attempt = { raw, settled: false, promise: false, explicit };
    this.#attempt = attempt;
    if (this.#state !== 'locked') this.#set('locking');
    let result: unknown;
    try {
      result = raw ? this.#canvas.requestPointerLock({ unadjustedMovement: true }) : this.#canvas.requestPointerLock();
    } catch (e) {
      this.#fail(attempt, e);
      return;
    }
    if (isPromise(result)) {
      attempt.promise = true;
      result.then(
        () => {
          if (attempt.raw && attempt === this.#attempt) this.#rawSupported = true;
        },
        (e: unknown) => this.#fail(attempt, e),
      );
    }
  }

  /** `pointerlockerror`: when the request returned a promise, its rejection decides (it carries the reason) */
  #onErrorEvent(): void {
    const cur = this.#attempt;
    if (cur.settled || cur.promise) return;
    this.#fail(cur, null);
  }

  /** a request failed: a refused raw option falls back to the plain call; anything else is the re-lock cooldown */
  #fail(attempt: Attempt, e: unknown): void {
    if (attempt !== this.#attempt || attempt.settled) return;
    if (attempt.raw && (!attempt.promise || errorName(e) === 'NotSupportedError')) {
      this.#rawSupported = false;
      this.#request(false, attempt.explicit);
      return;
    }
    attempt.settled = true;
    if (this.#state === 'locked') return; // a failed option change keeps the existing lock
    this.#set('cooldown');
    if (this.#cooldownTimer !== null) clearTimeout(this.#cooldownTimer);
    this.#cooldownTimer = setTimeout(() => {
      this.#cooldownTimer = null;
      if (this.#state === 'cooldown') this.#set('free');
    }, RELOCK_COOLDOWN_MS);
  }

  #onChange(): void {
    const locked = this.#doc.pointerLockElement === this.#canvas;
    if (locked) {
      const answered = this.#attempt;
      // only a grant that answers a still-pending explicit gesture request clears `overlay`: a settings-driven
      // re-request (setRawMouse) or an unrequested lock change must not resume the sim, and a refused or abandoned
      // request is settled, so it can never clear it either
      const resume = answered.explicit && !answered.settled;
      answered.settled = true;
      if (answered.raw && this.#rawSupported === null) this.#rawSupported = true;
      this.#set('locked');
      if (resume) this.#pause?.remove('overlay');
      return;
    }
    const was = this.#state;
    if (was === 'cooldown') return;
    this.#set('free');
    if (was === 'locked' && !this.#modal && this.#gameplayActive) this.#pause?.add('overlay');
  }

  #set(s: LockState): void {
    if (s === this.#state) return;
    this.#state = s;
    for (const fn of [...this.#subs]) {
      try {
        fn(s);
      } catch (err) {
        console.error('[pointer-lock] onChange subscriber threw', err);
      }
    }
  }
}
