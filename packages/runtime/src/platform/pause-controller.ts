// Host pause policy over the kernel clock; host and ad signals share an aggregated platform hold.
import { HOST_PAUSE_REASONS, OVERLAY_ESCALATING_REASONS, suspendsAudio } from '../compat/core/rules.ts';
import type { PauseReason, SimClock } from '../compat/core/types.ts';
import { createEmitter } from './emitter.ts';
import type { Platform } from './platform.ts';

/** the reasons this controller owns (build §6.4) */
export type HostPauseReason = Exclude<PauseReason, 'boot' | 'loading' | 'preparing'>;

/** the two calls of the audio engine (io §2.3 `AudioEngine`) the controller drives */
export interface PauseAudio {
  setPaused(paused: boolean): void;
  setPlatformAudio(enabled: boolean): void;
}

export type PauseListener = (paused: boolean, reasons: ReadonlySet<PauseReason>) => void;

/** the page signals of `bindPage`: a Document and a Window, or test doubles */
export interface PageLike {
  document: EventTarget & { readonly visibilityState: DocumentVisibilityState; hasFocus?(): boolean };
  window: EventTarget;
}

const RESERVED: ReadonlySet<string> = new Set(['boot', 'loading', 'preparing']);

function assertHost(r: unknown): asserts r is HostPauseReason {
  if (typeof r !== 'string' || r.length === 0 || RESERVED.has(r)) {
    throw new TypeError(`PauseController: "${String(r)}" is not a host pause reason (${HOST_PAUSE_REASONS.join(', ')})`);
  }
}

const key = (s: ReadonlySet<PauseReason>): string => JSON.stringify([...s].sort());

export interface PauseOptions {
  audioSuspend?: readonly PauseReason[];
  escalating?: readonly PauseReason[];
}

export class PauseController {
  readonly #audioSuspend: readonly PauseReason[] | undefined;
  readonly #escalating: ReadonlySet<PauseReason>;
  readonly #clock: SimClock;
  readonly #audio: PauseAudio;
  readonly #changes = createEmitter<{ change: PauseListener }>('pause-controller');
  readonly #unbind = new Set<() => void>();
  #match = false;
  #audioSuspended = false;
  #lastKey: string;

  constructor(clock: SimClock, audio: PauseAudio, options: PauseOptions = {}) {
    this.#audioSuspend = options.audioSuspend;
    this.#escalating = new Set(options.escalating ?? OVERLAY_ESCALATING_REASONS);
    this.#clock = clock;
    this.#audio = audio;
    this.#lastKey = key(clock.reasons);
    if (suspendsAudio(clock.reasons, this.#audioSuspend)) {
      this.#audioSuspended = true;
      audio.setPaused(true);
    }
  }

  /** the clock's reasons, including the kernel's and the LOADING gate's */
  get reasons(): ReadonlySet<PauseReason> {
    return this.#clock.reasons;
  }

  get paused(): boolean {
    return this.#clock.reasons.size > 0;
  }

  /** what the audio engine was last told */
  get audioSuspended(): boolean {
    return this.#audioSuspended;
  }

  get gameplayActive(): boolean {
    return this.#match;
  }

  has(r: PauseReason): boolean {
    return this.#clock.reasons.has(r);
  }

  /** idempotent per reason; a configured escalating pause that starts during a match also adds `overlay` */
  add(r: HostPauseReason): void {
    assertHost(r);
    const clock = this.#clock;
    if (clock.reasons.has(r)) return;
    clock.pause(r);
    if (this.#match && this.#escalating.has(r)) clock.pause('overlay');
    this.refresh();
  }

  /** idempotent per reason; removing an escalating reason leaves `overlay` for the re-lock click */
  remove(r: HostPauseReason): void {
    assertHost(r);
    if (!this.#clock.reasons.has(r)) return;
    this.#clock.resume(r);
    this.refresh();
  }

  /** Whether the host requests resume-overlay escalation for new pauses. */
  setGameplayActive(running: boolean): void {
    this.#match = running;
  }

  /** subscribe to changes of the reason set; the listener gets `(paused, snapshot)` */
  onChange(fn: PauseListener): () => void {
    return this.#changes.on('change', fn);
  }

  /** re-read the clock: tells audio on an edge and notifies listeners if the set changed since the last look */
  refresh(): void {
    const reasons = this.#clock.reasons;
    const suspend = suspendsAudio(reasons, this.#audioSuspend);
    if (suspend !== this.#audioSuspended) {
      this.#audioSuspended = suspend;
      this.#audio.setPaused(suspend);
    }
    const k = key(reasons);
    if (k === this.#lastKey) return;
    this.#lastKey = k;
    this.#changes.emit('change', reasons.size > 0, new Set(reasons));
  }

  /**
   * Host signals of an adapter: `platformPause` → `platform`, `adPause`/`adResume` → an aggregate `platform` hold, `platformMute` →
   * `setPlatformAudio(!muted)`. The current `platformPaused` / `platformMuted` are applied first. `adBusy` is UI input
   * blocking, not a pause. Returns the unbind.
   */
  bindPlatform(p: Platform): () => void {
    let hostPaused = p.platformPaused;
    let adPaused = false;
    const update = (): void => { if (hostPaused || adPaused) this.add('platform'); else this.remove('platform'); };
    update();
    this.#audio.setPlatformAudio(!p.platformMuted);
    const offs = [
      p.on('platformPause', (paused) => { hostPaused = paused; update(); }),
      p.on('adPause', () => { adPaused = true; update(); }),
      p.on('adResume', () => { adPaused = false; update(); }),
      p.on('platformMute', (muted) => this.#audio.setPlatformAudio(!muted)),
    ];
    return this.#track(() => {
      for (const off of offs) off();
    });
  }

  /** `hidden` while the page is hidden or the window has lost focus (every adapter). Returns the unbind. */
  bindPage(page: PageLike): () => void {
    const { document: doc, window: win } = page;
    let blurred = false;
    const update = (): void => {
      if (doc.visibilityState === 'hidden' || blurred) this.add('hidden');
      else this.remove('hidden');
    };
    const onVisibility = (): void => {
      // back to visible: a focused document is no longer blurred even if the focus event has not arrived yet
      if (doc.visibilityState === 'visible' && doc.hasFocus?.() === true) blurred = false;
      update();
    };
    const onBlur = (): void => {
      blurred = true;
      update();
    };
    const onFocus = (): void => {
      blurred = false;
      update();
    };
    doc.addEventListener('visibilitychange', onVisibility);
    win.addEventListener('blur', onBlur);
    win.addEventListener('focus', onFocus);
    if (doc.visibilityState === 'hidden') update();
    return this.#track(() => {
      doc.removeEventListener('visibilitychange', onVisibility);
      win.removeEventListener('blur', onBlur);
      win.removeEventListener('focus', onFocus);
    });
  }

  /** unbinds every platform and page binding and drops the listeners; the reasons stay as they are */
  dispose(): void {
    for (const off of [...this.#unbind]) off();
    this.#changes.clear();
  }

  #track(off: () => void): () => void {
    let live = true;
    const once = (): void => {
      if (!live) return;
      live = false;
      this.#unbind.delete(once);
      off();
    };
    this.#unbind.add(once);
    return once;
  }
}
