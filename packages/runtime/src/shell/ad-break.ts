// The generic ad-break channel (port-spec P-2 / C-6): a game asks for an ad at a natural break of its own, the shell runs it and
// answers. Written for this runtime (purge-protocol-web's AdDirector is the pattern for "after paint, then a delay, once per key";
// its match phases are PP's and are not carried: the game decides when a break is natural).
//
// Asking, any of:
//   - the game emits the `uiEvent` act `{ name: 'adBreak', payload: { placement, kind?, id?, delayMs? } }`
//     (`ctx.emit('uiEvent', { name: 'adBreak', payload: { placement: 'results' } })`); `adBreakCancel` withdraws a break that has
//     not started its ad yet
//   - page code (the UI module) calls `window.__ssBreak(placement)` (a Promise that always resolves) when the page API is on
//   - host code calls `app.adBreaks.request({ placement })`
// Running: after two paints and `delayMs` the platform shows the ad (`platform.showAd`: the adapter owns the cap and cooldown).
// The platform's own events do the rest in the shell: `adPause` / `platformMute` reach the PauseController (clock reason `ad`,
// audio suspended and muted) and, with `ext.pauseFreezesClock` (switched on with the channel), the kernel itself.
// Holding: with `host.hold` (composeGame wires it to the kernel clock's `ad` reason) the clock is held BEFORE `showing` is
// published and released only AFTER the answer is, so no tick ever runs while the session says `showing`: the platform's own
// hold arrives two paints + delayMs + showAd later, and without this one the game kept ticking in that gap. A platform `adResume`
// while the break is still pending (a host ad of its own closing, or ours closing before showAd resolves) re-applies the hold.
// Answering: `ctx.session.adBreak` (both VMs) goes `{ state: 'showing', placement, id }` at the request and
// `{ state: 'done' | 'skipped', placement, id, shown, rewarded?, reason? }` when it is over; the same object is sent as the
// `adBreakResult` uiEvent and resolves the request's Promise. The game proceeds on `done` / `skipped`. A break whose ad has not
// opened `timeoutMs` (default 6 s) after the platform was asked is answered `skipped` / `timeout`; one that is on screen is waited for.
import type { AdKind, AdResult, Placement, Platform } from '../platform/platform.ts';

export interface AdBreakRequest {
  /** the game's own name for the break ('results', 'match_end', ...); the platform passes it on as the ad placement */
  placement: string;
  /** default 'interstitial' */
  kind?: AdKind;
  /** a break with an id that was already asked answers `skipped` / `duplicate` (once per round, as PP's AdDirector keys matches) */
  id?: string | number;
  /** ms after the paint before the ad is requested; default the channel's `delayMs` */
  delayMs?: number;
}

export interface AdBreakResult {
  state: 'done' | 'skipped';
  placement: string;
  id: string | number | null;
  shown: boolean;
  rewarded?: boolean;
  /** why nothing was shown: an AdFailure, or 'duplicate' | 'cancelled' | 'disposed' | 'invalid' */
  reason?: string;
}

export interface AdBreakOptions {
  /** ms to wait for the ad to open before the game proceeds; default 6000 */
  timeoutMs?: number;
  /** ms between the paint and the ad request; default 0 */
  delayMs?: number;
  /** `window.__ssBreak` / `window.__ssMatch` for page code; default true (never in a headless composition) */
  pageApi?: boolean;
  /** test seams */
  afterPaint?: (cb: () => void) => () => void;
  setTimer?: (cb: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
  log?: (message: string) => void;
}

export interface AdBreakHost {
  platform: Pick<Platform, 'showAd' | 'on'>;
  /** the session bags answered into (`kernel.vms.*.session`) */
  sessions(): Iterable<Record<string, unknown>>;
  /** where `adBreakResult` is echoed (the UI host's event bus) */
  ui?: { uiEvent(name: string, payload: unknown): void } | null;
  /** holds (true) / releases (false) the game clock for the whole break; absent: only the platform's own pause events hold it */
  hold?: (on: boolean) => void;
}

const defaultAfterPaint = (cb: () => void): (() => void) => {
  const raf = (globalThis as { requestAnimationFrame?: (f: () => void) => number }).requestAnimationFrame;
  const caf = (globalThis as { cancelAnimationFrame?: (id: number) => void }).cancelAnimationFrame;
  if (typeof raf !== 'function') {
    const t = setTimeout(cb, 0);
    return () => clearTimeout(t);
  }
  let second: number | null = null;
  const first = raf(() => {
    second = raf(cb);
  });
  return () => {
    caf?.(first);
    if (second !== null) caf?.(second);
  };
};

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

interface Pending {
  req: Required<Pick<AdBreakRequest, 'placement' | 'kind'>> & { id: string | number | null };
  resolve(r: AdBreakResult): void;
  /** the ad was asked of the platform */
  asked: boolean;
  opened: boolean;
  cancelPaint: (() => void) | null;
  timer: unknown;
  watchdog: unknown;
}

export class AdBreaks {
  readonly #host: AdBreakHost;
  readonly #timeoutMs: number;
  readonly #delayMs: number;
  readonly #afterPaint: (cb: () => void) => () => void;
  readonly #setTimer: (cb: () => void, ms: number) => unknown;
  readonly #clearTimer: (timer: unknown) => void;
  readonly #log: (message: string) => void;
  readonly #seen = new Set<string>();
  readonly #offs: Array<() => void> = [];
  #pending: Pending | null = null;
  #held = false;
  #disposed = false;

  constructor(host: AdBreakHost, opts: AdBreakOptions = {}) {
    this.#host = host;
    this.#timeoutMs = opts.timeoutMs ?? 6000;
    this.#delayMs = opts.delayMs ?? 0;
    this.#afterPaint = opts.afterPaint ?? defaultAfterPaint;
    this.#setTimer = opts.setTimer ?? ((cb, ms) => setTimeout(cb, ms));
    this.#clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    this.#log = opts.log ?? ((m) => console.warn(`[ad-break] ${m}`));
    if (typeof host.platform.on === 'function') {
      this.#offs.push(
        host.platform.on('adPause', () => {
          const p = this.#pending;
          if (p?.asked) {
            p.opened = true;
            this.#clearWatchdog(p);
          }
        }),
        host.platform.on('adResume', () => {
          // the PauseController's listener drops `ad` on this event; the break still owns its hold until it is answered
          const p = this.#pending;
          if (p && this.#held) queueMicrotask(() => this.#pending === p && this.#reapply());
        }),
      );
    }
  }

  /** the break being run, if any */
  get active(): { placement: string; id: string | number | null } | null {
    return this.#pending ? { placement: this.#pending.req.placement, id: this.#pending.req.id } : null;
  }

  /** Never rejects. One break at a time: a request while one runs answers `skipped` / `busy`. */
  request(req: AdBreakRequest): Promise<AdBreakResult> {
    const placement = typeof req?.placement === 'string' ? req.placement : '';
    const id = req?.id ?? null;
    const early = (reason: string): Promise<AdBreakResult> => Promise.resolve(this.#answer({ state: 'skipped', placement, id, shown: false, reason }));
    if (this.#disposed) return early('disposed');
    if (placement === '') return early('invalid');
    if (this.#pending) return early('busy');
    const key = id === null ? null : `${placement}|${String(id)}`;
    if (key !== null) {
      if (this.#seen.has(key)) return early('duplicate');
      this.#seen.add(key);
    }
    const kind: AdKind = req.kind === 'rewarded' ? 'rewarded' : 'interstitial';
    return new Promise<AdBreakResult>((resolve) => {
      const p: Pending = { req: { placement, kind, id }, resolve, asked: false, opened: false, cancelPaint: null, timer: null, watchdog: null };
      this.#pending = p;
      this.#hold(true); // first the hold, then `showing`: the session never says showing over a running clock
      this.#setSession({ state: 'showing', placement, id });
      const delay = typeof req.delayMs === 'number' && req.delayMs >= 0 ? req.delayMs : this.#delayMs;
      p.cancelPaint = this.#afterPaint(() => {
        p.cancelPaint = null;
        p.timer = this.#setTimer(() => {
          p.timer = null;
          this.#run(p);
        }, delay);
      });
    });
  }

  /** Withdraws the break if its ad has not been asked of the platform yet; returns whether it did. */
  cancel(): boolean {
    const p = this.#pending;
    if (!p || p.asked) return false;
    this.#settle(p, { state: 'skipped', placement: p.req.placement, id: p.req.id, shown: false, reason: 'cancelled' });
    return true;
  }

  /** The game's `uiEvent` acts: `adBreak` / `adBreakCancel`. Returns whether the name was this channel's. */
  handleUiEvent(name: string, payload: unknown): boolean {
    if (name === 'adBreak') {
      void this.request(isRecord(payload) ? (payload as unknown as AdBreakRequest) : typeof payload === 'string' ? { placement: payload } : { placement: '' });
      return true;
    }
    if (name === 'adBreakCancel') {
      this.cancel();
      return true;
    }
    return false;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const off of this.#offs.splice(0)) off();
    const p = this.#pending;
    if (p) this.#settle(p, { state: 'skipped', placement: p.req.placement, id: p.req.id, shown: false, reason: 'disposed' });
  }

  #run(p: Pending): void {
    if (this.#pending !== p) return;
    p.asked = true;
    p.watchdog = this.#setTimer(() => {
      p.watchdog = null;
      if (this.#pending === p && !p.opened) this.#settle(p, { state: 'skipped', placement: p.req.placement, id: p.req.id, shown: false, reason: 'timeout' });
    }, this.#timeoutMs);
    let ad: Promise<AdResult>;
    try {
      ad = this.#host.platform.showAd(p.req.kind, p.req.placement as Placement);
    } catch (e) {
      this.#log(`showAd threw: ${e instanceof Error ? e.message : String(e)}`);
      ad = Promise.resolve({ shown: false, reason: 'other' });
    }
    void ad.then(
      (r) => {
        if (this.#pending !== p) return; // answered already (timeout, cancel, dispose)
        this.#settle(p, r.shown ? { state: 'done', placement: p.req.placement, id: p.req.id, shown: true, rewarded: r.rewarded } : { state: 'skipped', placement: p.req.placement, id: p.req.id, shown: false, reason: r.reason });
      },
      (e: unknown) => {
        this.#log(`showAd rejected: ${e instanceof Error ? e.message : String(e)}`);
        if (this.#pending === p) this.#settle(p, { state: 'skipped', placement: p.req.placement, id: p.req.id, shown: false, reason: 'other' });
      },
    );
  }

  #clearWatchdog(p: Pending): void {
    if (p.watchdog !== null) this.#clearTimer(p.watchdog);
    p.watchdog = null;
  }

  #settle(p: Pending, result: AdBreakResult): void {
    if (this.#pending !== p) return;
    this.#pending = null;
    p.cancelPaint?.();
    p.cancelPaint = null;
    if (p.timer !== null) this.#clearTimer(p.timer);
    p.timer = null;
    this.#clearWatchdog(p);
    const answer = this.#answer(result);
    this.#hold(false); // only after the answer: `showing` is gone before the clock runs again
    p.resolve(answer);
  }

  #hold(on: boolean): void {
    if (this.#host.hold === undefined || this.#held === on) return;
    this.#held = on;
    this.#call(on);
  }

  #reapply(): void {
    if (this.#held) this.#call(true);
  }

  #call(on: boolean): void {
    try {
      this.#host.hold?.(on);
    } catch (e) {
      this.#log(`hold(${String(on)}) threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  #answer(result: AdBreakResult): AdBreakResult {
    this.#setSession({ ...result });
    try {
      this.#host.ui?.uiEvent('adBreakResult', result);
    } catch (e) {
      this.#log(`adBreakResult listener threw: ${e instanceof Error ? e.message : String(e)}`);
    }
    return result;
  }

  #setSession(value: Record<string, unknown>): void {
    for (const s of this.#host.sessions()) s['adBreak'] = { ...value };
  }
}

/** a UiPort that offers the channel's events to `breaks()` first and forwards everything to `inner` */
export function adBreakUiPort<P extends { markDirty(): void; uiEvent(name: string, payload: unknown): void }>(inner: P, breaks: () => AdBreaks | null): P {
  return {
    ...inner,
    markDirty: () => inner.markDirty(),
    uiEvent: (name: string, payload: unknown) => {
      breaks()?.handleUiEvent(name, payload);
      inner.uiEvent(name, payload);
    },
  };
}

/** What page code of a Crown-style game calls (`window.__ssBreak`, `window.__ssMatch`); returns the removal. */
export interface PageApiTarget {
  __ssBreak?: (placement: string, opts?: Omit<AdBreakRequest, 'placement'>) => Promise<void>;
  __ssMatch?: (kind: 'start' | 'end') => void;
}

export function installAdBreakPageApi(
  win: PageApiTarget,
  deps: { breaks: AdBreaks; platform: Pick<Platform, 'matchEvent' | 'setGameplay'>; slug: string },
): () => void {
  win.__ssBreak = (placement, opts) => deps.breaks.request({ ...(opts ?? {}), placement }).then(() => undefined);
  win.__ssMatch = (kind) => {
    const e = { map: deps.slug, difficulty: '', waves: 0 };
    if (kind === 'start') {
      deps.platform.matchEvent({ type: 'start', ...e });
      deps.platform.setGameplay(true);
    } else if (kind === 'end') {
      deps.platform.matchEvent({ type: 'complete', ...e });
      deps.platform.setGameplay(false);
    }
  };
  return () => {
    delete win.__ssBreak;
    delete win.__ssMatch;
  };
}
