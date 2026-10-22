// Copied from purge-protocol-web ebab692 src/platform/web.ts; added: the `storagePrefix` option.
// The web / null adapter (build §6.6, platform-playgama.md §11.4, platform-crazygames.md §9.5): `npm run dev`, self-hosting,
// headless runs. Same interface as the Playgama adapter, no host behind it:
//   - save: WebSaveStore (localStorage under `ss:`; memory only where there is none)
//   - ads: `{ shown: false, reason: 'disabled' }`, unless an AdProvider is plugged in (select.ts plugs the dev fake ads)
//   - host pause and mute: after `init()`, from visibilitychange + window blur/focus, so dev behaves like the Bridge's mock
//     platform ("switching tabs / clicking outside the window pauses and mutes"); an ad on screen holds them too
//   - lifecycle messages (game_ready, loading, gameplay, level_*, analytics) are no-ops, recorded in `lifecycle` for tests
//   - user: guest (null); device from `(pointer: coarse)`; locale 'en' (the game is English only, build §6.3 [B-5])
// Works without a DOM (Node): no events, desktop/kbm, memory save.
import { createEmitter } from '../platform/emitter.ts';
import type {
  AdHost,
  AdKind,
  AdProvider,
  AdResult,
  DeviceInfo,
  MatchEvent,
  Placement,
  Platform,
  PlatformEvents,
  PlatformPolicy,
  PlatformUser,
} from '../platform/platform.ts';
import { WebSaveStore, type StorageLike } from './web-save.ts';

export interface WebPlatformOptions {
  /** default: globalThis.window when it exists */
  window?: Window | null;
  /** default: the page's localStorage; null = memory only */
  storage?: StorageLike | null;
  /** the localStorage key prefix of the save (default `ss:`, PP); a game passes its own, e.g. `pip-skybloom:` */
  storagePrefix?: string;
  /** host pause/mute from page visibility and window focus (default true) */
  hostEvents?: boolean;
  /** an ad source (the dev fake ads); default none: every ad reports `disabled` */
  ads?: (host: AdHost) => AdProvider;
}

/** what the no-op lifecycle calls were asked to do (test hooks and unit tests read it) */
export interface WebLifecycleLog {
  progress: number;
  /** game_ready messages "sent": 0 or 1 */
  gameReady: number;
  loading: boolean;
  gameplay: boolean;
  /** coalesced gameplay_started/stopped edges */
  gameplayEdges: number;
  matchEvents: MatchEvent[];
  tracked: string[];
}

export interface WebPlatform extends Platform {
  readonly id: 'web';
  readonly save: WebSaveStore;
  readonly lifecycle: Readonly<WebLifecycleLog>;
  /** removes the page listeners and closes a fake ad on screen */
  dispose(): void;
}

function detectDevice(win: Window | null): DeviceInfo {
  let coarse = false;
  try {
    coarse = typeof win?.matchMedia === 'function' && win.matchMedia('(pointer: coarse)').matches;
  } catch {
    coarse = false;
  }
  if (!coarse) return Object.freeze({ type: 'desktop', input: 'kbm', locale: 'en' });
  const short = Math.min(win?.screen?.width ?? 0, win?.screen?.height ?? 0);
  return Object.freeze({ type: short >= 600 ? 'tablet' : 'mobile', input: 'touch', locale: 'en' });
}

export function createWebPlatform(opts: WebPlatformOptions = {}): WebPlatform {
  const win: Window | null =
    opts.window !== undefined ? opts.window : typeof window === 'undefined' ? null : (globalThis as unknown as { window: Window }).window;
  const doc: Document | null = win?.document ?? null;
  const events = createEmitter<PlatformEvents>('platform:web');
  const save = new WebSaveStore({ ...(opts.storage === undefined ? {} : { storage: opts.storage }), ...(opts.storagePrefix !== undefined ? { prefix: opts.storagePrefix } : {}) });
  const device = detectDevice(win);

  let pageHidden = false;
  let adHold = false;
  let hostPaused = false;
  const log: WebLifecycleLog = {
    progress: 0,
    gameReady: 0,
    loading: false,
    gameplay: false,
    gameplayEdges: 0,
    matchEvents: [],
    tracked: [],
  };

  /** host pause and mute move together, as on the mock platform */
  const applyHost = (emit: boolean): void => {
    const next = pageHidden || adHold;
    if (next === hostPaused) return;
    hostPaused = next;
    if (!emit) return;
    events.emit('platformPause', next);
    events.emit('platformMute', next);
  };

  const host: AdHost = {
    emit: (ev, ...args) => events.emit(ev, ...args),
    setAdHold: (on) => {
      adHold = on;
      applyHost(true);
    },
    document: doc,
  };
  const ads: AdProvider | null = opts.ads ? opts.ads(host) : null;
  const policy: PlatformPolicy = Object.freeze({
    externalLinks: true,
    rewardedEnabled: ads?.rewarded ?? false,
    interstitialPlacements: Object.freeze([...(ads?.placements ?? [])]),
  });

  let blurred = false;
  const onPage = (): void => {
    pageHidden = doc?.visibilityState === 'hidden' || blurred;
    applyHost(true);
  };
  const onBlur = (): void => {
    blurred = true;
    onPage();
  };
  const onFocus = (): void => {
    blurred = false;
    onPage();
  };
  let listening = false;
  let initialized: Promise<void> | null = null;

  const init = (): Promise<void> => {
    initialized ??= (async () => {
      await save.ready;
      if (opts.hostEvents === false || !win || !doc) return;
      // the state before events: read now, emit only later changes
      pageHidden = doc.visibilityState === 'hidden';
      applyHost(false);
      doc.addEventListener('visibilitychange', onPage);
      win.addEventListener('blur', onBlur);
      win.addEventListener('focus', onFocus);
      listening = true;
    })();
    return initialized;
  };

  return {
    id: 'web',
    hostId: 'web',
    save,
    device,
    policy,
    get platformPaused() {
      return hostPaused;
    },
    get platformMuted() {
      return hostPaused;
    },
    get lifecycle() {
      return log;
    },
    init,
    setLoadingProgress(pct: number) {
      if (Number.isFinite(pct)) log.progress = Math.max(log.progress, Math.min(100, Math.max(0, pct)));
    },
    gameReady() {
      // once (build §6.1): a repeat is a caller bug, reported and not "sent" again
      if (log.gameReady > 0) {
        console.warn('[platform:web] gameReady() called more than once; ignored');
        return;
      }
      log.gameReady = 1;
    },
    loadingStart() {
      log.loading = true;
    },
    loadingStop() {
      log.loading = false;
    },
    setGameplay(active: boolean) {
      if (active === log.gameplay) return;
      log.gameplay = active;
      log.gameplayEdges++;
    },
    matchEvent(e: MatchEvent) {
      log.matchEvents.push({ ...e });
    },
    track(name: string) {
      log.tracked.push(name);
    },
    showAd(kind: AdKind, placement: Placement): Promise<AdResult> {
      return ads ? ads.showAd(kind, placement) : Promise.resolve({ shown: false, reason: 'disabled' });
    },
    getUser(): Promise<PlatformUser | null> {
      return Promise.resolve(null);
    },
    on: events.on,
    dispose() {
      ads?.dispose();
      if (listening && win && doc) {
        doc.removeEventListener('visibilitychange', onPage);
        win.removeEventListener('blur', onBlur);
        win.removeEventListener('focus', onFocus);
        listening = false;
      }
      events.clear();
    },
  };
}
