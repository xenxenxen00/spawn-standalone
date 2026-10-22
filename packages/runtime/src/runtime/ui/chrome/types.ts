// UI2b shared seams: injectable clock, geometry, and page globals.
//
// The chrome package never touches the live `window` globals directly; buttons call
// through PageGlobals so tests can stub them and the app can pass its own wiring.

/** injectable clock; the production default is systemClock() (performance.now + setTimeout) */
export interface UiClock {
  now(): number;
  /** schedule cb in ms; returns a cancel function */
  after(ms: number, cb: () => void): () => void;
}

export function systemClock(): UiClock {
  return {
    now: () => performance.now(),
    after: (ms, cb) => {
      const id = setTimeout(cb, ms);
      return () => clearTimeout(id);
    },
  };
}

/** a world-space point, as handed to the renderer projection contract */
export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** a CSS-pixel screen point */
export interface ScreenPoint {
  x: number;
  y: number;
}

/**
 * The port page globals UI2b buttons call. In production these are installed on
 * window by installPortGlobals (src/runtime/ui/port-globals.ts): ssMute, ssResume, ssNav.
 */
export interface PageGlobals {
  mute(): void;
  resume(): void;
  nav(panel: string): void;
}

/**
 * Lazily reads the globals off globalThis at call time, so install order never
 * matters; a missing global is a no-op rather than a throw.
 */
export function globalPageGlobals(
  scope: Record<string, unknown> = globalThis as unknown as Record<string, unknown>,
): PageGlobals {
  const call = (name: 'ssMute' | 'ssResume' | 'ssNav', arg?: string): void => {
    const fn = scope[name];
    if (typeof fn === 'function') (fn as (a?: string) => void)(arg);
  };
  return {
    mute: () => call('ssMute'),
    resume: () => call('ssResume'),
    nav: (panel: string) => call('ssNav', panel),
  };
}
