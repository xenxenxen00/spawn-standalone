// First-gesture unlock (io §2.12, X-33; docs/architecture.md §5.1 step 12).
//
// Browsers start Web Audio only from a user gesture. The engine exists from boot without a context; these listeners (on
// `window`, capture phase, so a handler that stops propagation cannot starve them) call `engine.unlock()` inside the first
// `pointerdown`, `keydown` or `touchend`, which creates the `AudioContext` (`latencyHint: 'interactive'`), resumes it and plays a
// 1-sample silent buffer. On iOS `navigator.audioSession.type = 'playback'` is set when the property exists, so sound plays
// through the ringer switch.
//
// Later gestures do nothing unless the context was suspended or interrupted by the browser rather than by a pause (iOS call,
// Safari backgrounding: `engine.needsUnlock()`); then the next gesture, or the page becoming visible again, resumes it. A
// context suspended for a pause reason (X-07) is resumed only by `setPaused(false)`.
import type { AudioEngine } from './types.ts';

export const UNLOCK_EVENTS = ['pointerdown', 'keydown', 'touchend'] as const;

export interface UnlockOptions {
  /** gesture source; default `window` */
  target?: EventTarget;
  /** `visibilitychange` source; default `document`, null for none */
  document?: (EventTarget & { readonly visibilityState: string }) | null;
  /** default `navigator`; its `audioSession` (WebKit) is set to 'playback' when present */
  navigator?: { audioSession?: { type: string } } | null;
  /** runs inside every unlocking gesture after the engine (media elements to prime: StreamLoop, WP AU2) */
  onUnlock?: () => void;
}

export interface Unlock {
  /** a gesture has unlocked the engine at least once */
  readonly unlocked: boolean;
  dispose(): void;
}

export function installUnlock(engine: Pick<AudioEngine, 'unlock' | 'needsUnlock'>, opts: UnlockOptions = {}): Unlock {
  const g = globalThis as { document?: UnlockOptions['document']; navigator?: UnlockOptions['navigator'] };
  const target: EventTarget = opts.target ?? globalThis;
  const doc = opts.document === undefined ? (g.document ?? null) : opts.document;
  const nav = opts.navigator === undefined ? (g.navigator ?? null) : opts.navigator;
  let unlocked = false;

  const onGesture = (): void => {
    if (!engine.needsUnlock()) return;
    const session = nav?.audioSession;
    if (session && typeof session === 'object' && 'type' in session) {
      try {
        session.type = 'playback';
      } catch {
        // a read-only or rejecting audioSession: keep the default session
      }
    }
    engine.unlock();
    unlocked = true;
    opts.onUnlock?.();
  };

  const onVisibility = (): void => {
    if (unlocked && doc?.visibilityState === 'visible' && engine.needsUnlock()) engine.unlock();
  };

  for (const type of UNLOCK_EVENTS) target.addEventListener(type, onGesture, { capture: true });
  doc?.addEventListener('visibilitychange', onVisibility);

  return {
    get unlocked() {
      return unlocked;
    },
    dispose() {
      for (const type of UNLOCK_EVENTS) target.removeEventListener(type, onGesture, { capture: true });
      doc?.removeEventListener('visibilitychange', onVisibility);
    },
  };
}
