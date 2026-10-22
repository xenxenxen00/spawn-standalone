// What the shell tells the game about its host, through `ctx.session` of every VM (port-spec P-1 and P-5). Written for this
// runtime; the pause reasons are the PauseController's (platform/pause-controller.ts).
//
//   P-1  `session.hostPaused`   true while the platform or the page holds the game (reasons `platform`, `hidden`), so the game can
//                               raise its own pause card. The clock and audio freeze through the PauseController; nothing here
//                               touches the game's settings.
//   P-5  `session.viewport`     `{ width, height, aspect, dpr, orientation, safe: { top, right, bottom, left } }` in CSS px, kept
//                               current on resize, rotation, DPR change and visualViewport changes; the same numbers are CSS
//                               custom properties on the UI container (`--ss-safe-top` ... `--ss-aspect`) so the UI module can
//                               place chrome with `env(safe-area-inset-*)` resolved. Optionally makes sure the page's viewport
//                               meta has `viewport-fit=cover` (without it the safe-area insets are always 0).
import type { PauseReason } from '../compat/core/types.ts';

type Sessions = () => Iterable<Record<string, unknown>>;

const HOLDS: readonly PauseReason[] = ['platform', 'hidden'];

export interface HostPausedOptions {
  /**
   * Opt-in (`ext.hostPausedLinger`): the kernel runs no tick while a hold is set, so game code never reads `hostPaused === true`
   * from its own hooks. With this on, `hostPaused` stays true after the release until the end of the first tick that runs, so
   * every hook of that tick observes it once (a resume card raised from it, a latch). `afterTick` subscribes to the tick end
   * and returns the removal. A hold that starts again before that tick cancels the wait. Absent: PP's immediate write.
   */
  linger?: { afterTick(fn: () => void): () => void };
}

/** P-1: mirrors the host pause reasons into `session.hostPaused`; returns the removal */
export function bindHostPaused(
  sessions: Sessions,
  pause: { readonly reasons: ReadonlySet<PauseReason>; onChange(fn: (paused: boolean, reasons: ReadonlySet<PauseReason>) => void): () => void },
  opts: HostPausedOptions = {},
): () => void {
  let held = false;
  let offTick: (() => void) | null = null;
  const put = (v: boolean): void => {
    for (const s of sessions()) if (s['hostPaused'] !== v) s['hostPaused'] = v;
  };
  const cancel = (): void => {
    offTick?.();
    offTick = null;
  };
  const write = (reasons: ReadonlySet<PauseReason>): void => {
    const was = held;
    held = HOLDS.some((r) => reasons.has(r));
    if (held) {
      cancel();
      put(true);
    } else if (was && opts.linger !== undefined) {
      // released: the next tick sees it once more, then it clears at that tick's end
      cancel();
      offTick = opts.linger.afterTick(() => {
        cancel();
        put(false);
      });
    } else if (offTick === null) put(false);
  };
  write(pause.reasons);
  const off = pause.onChange((_paused, reasons) => write(reasons));
  return () => {
    cancel();
    off();
    for (const s of sessions()) s['hostPaused'] = false;
  };
}

export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface ViewportInfo {
  width: number;
  height: number;
  aspect: number;
  dpr: number;
  orientation: 'landscape' | 'portrait';
  safe: Insets;
}

export interface ViewportOptions {
  /** default globalThis.window */
  window?: Window;
  /** where the CSS custom properties go and the probe lives; default document.body */
  container?: HTMLElement | null;
  /** make sure `<meta name="viewport">` has `viewport-fit=cover` (default true) */
  fitCover?: boolean;
}

export interface ViewportHandle {
  read(): ViewportInfo;
  /** measure now (a test, or a layout change the events do not report) */
  update(): ViewportInfo;
  dispose(): void;
}

/** P-5: see the header. Works on a page only. */
export function installViewport(sessions: Sessions, opts: ViewportOptions = {}): ViewportHandle {
  const win = opts.window ?? (globalThis as unknown as { window: Window }).window;
  const doc = win.document;
  const host = opts.container ?? doc.body;
  if (opts.fitCover !== false) ensureFitCover(doc);

  const probe = doc.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText =
    'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;' +
    'padding:env(safe-area-inset-top,0px) env(safe-area-inset-right,0px) env(safe-area-inset-bottom,0px) env(safe-area-inset-left,0px);';
  doc.body.append(probe);

  const px = (v: string): number => {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : 0;
  };
  let last: ViewportInfo = measure();

  function measure(): ViewportInfo {
    const cs = win.getComputedStyle(probe);
    const vv = win.visualViewport;
    const width = Math.round(vv?.width ?? win.innerWidth);
    const height = Math.round(vv?.height ?? win.innerHeight);
    return {
      width,
      height,
      aspect: height > 0 ? width / height : 1,
      dpr: win.devicePixelRatio || 1,
      orientation: width >= height ? 'landscape' : 'portrait',
      safe: { top: px(cs.paddingTop), right: px(cs.paddingRight), bottom: px(cs.paddingBottom), left: px(cs.paddingLeft) },
    };
  }

  const publish = (): ViewportInfo => {
    last = measure();
    for (const s of sessions()) s['viewport'] = { ...last, safe: { ...last.safe } };
    const st = host.style;
    st.setProperty('--ss-safe-top', `${last.safe.top}px`);
    st.setProperty('--ss-safe-right', `${last.safe.right}px`);
    st.setProperty('--ss-safe-bottom', `${last.safe.bottom}px`);
    st.setProperty('--ss-safe-left', `${last.safe.left}px`);
    st.setProperty('--ss-aspect', String(last.aspect));
    return last;
  };

  const offs: Array<() => void> = [];
  const on = (t: EventTarget | null | undefined, type: string): void => {
    if (!t) return;
    t.addEventListener(type, publish);
    offs.push(() => t.removeEventListener(type, publish));
  };
  on(win, 'resize');
  on(win, 'orientationchange');
  on(win.visualViewport, 'resize');
  // a DPR change (zoom, a window moved to another screen) fires no resize: watch the resolution query, re-armed at each change
  let dprQuery: MediaQueryList | null = null;
  const watchDpr = (): void => {
    dprQuery?.removeEventListener('change', onDpr);
    dprQuery = typeof win.matchMedia === 'function' ? win.matchMedia(`(resolution: ${win.devicePixelRatio || 1}dppx)`) : null;
    dprQuery?.addEventListener('change', onDpr);
  };
  function onDpr(): void {
    publish();
    watchDpr();
  }
  watchDpr();
  publish();

  return {
    read: () => last,
    update: publish,
    dispose() {
      for (const off of offs.splice(0)) off();
      dprQuery?.removeEventListener('change', onDpr);
      dprQuery = null;
      probe.remove();
      for (const s of sessions()) delete s['viewport'];
      for (const p of ['--ss-safe-top', '--ss-safe-right', '--ss-safe-bottom', '--ss-safe-left', '--ss-aspect']) host.style.removeProperty(p);
    },
  };
}

function ensureFitCover(doc: Document): void {
  let meta = doc.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta) {
    meta = doc.createElement('meta');
    meta.name = 'viewport';
    meta.content = 'width=device-width, initial-scale=1';
    doc.head.append(meta);
  }
  if (!/viewport-fit\s*=/.test(meta.content)) meta.content = `${meta.content}, viewport-fit=cover`;
}
