// Copied from purge-protocol-web ebab692 src/platform/playgama.ts (Playgama Bridge 2.3.1 adapter, build §6.3), made game-agnostic:
// the save key (`saveKey`, default `ss_save_v1`), the game version (`gameVersion`), rewarded ads (`rewarded`, was
// `VITE_PG_REWARDED`), the guest name (`defaultName`, default `Player`) and the initial interstitial delay are options. Placement
// names are the game's own strings (the Bridge takes any), so `showAd` casts them.
// Shared game code only sees Platform; the SDK is reached through the Bridge global loaded by the page (`window.bridge`).
import { EVENT_NAME, PLATFORM_MESSAGE } from '@playgama/bridge/constants';
import type { PlaygamaBridge } from '@playgama/bridge';
import type { InterstitialState, PlatformId, RewardedState } from '@playgama/bridge/constants';
import { INTERSTITIAL_PLACEMENTS, type AdKind, type AdResult, type DeviceInfo, type MatchEvent, type Placement, type Platform, type PlatformEvents, type PlatformPolicy, type PlatformUser, type SaveStore } from '../platform/platform.ts';
import { createEmitter } from '../platform/emitter.ts';

/** DurableState's default document key and its backup (compat/core/save/durable.ts); a game with `durable.key` passes its own */
const DEFAULT_SAVE_KEYS: readonly string[] = Object.freeze(['ss_save_v1', 'ss_save_v1_bad']);
const INIT_TIMEOUT_MS = 15_000;
/** the one `storage.get` at init answers within this, or the store detaches to memory (same budget as initialize) */
const STORAGE_LOAD_TIMEOUT_MS = INIT_TIMEOUT_MS;
const PRESTART_WATCHDOG_MS = 20_000;
/** must equal `advertisement.initialInterstitialDelay` in the game's playgama-bridge-config.json (default 120 s, the Bridge's) */
const INITIAL_INTERSTITIAL_DELAY_S = 120;

type Timer = ReturnType<typeof setTimeout>;
type Bridge = PlaygamaBridge;
type StorageValue = string | null;

/** Minimal injection seam for scripted Bridge tests; production uses `window.bridge`. */
export interface PlaygamaPlatformOptions {
  bridge?: () => Bridge | undefined;
  now?: () => number;
  setTimer?: (fn: () => void, delayMs: number) => Timer;
  clearTimer?: (timer: Timer) => void;
  document?: Pick<Document, 'exitPointerLock'> | null;
  initTimeoutMs?: number;
  /** bound on the single init-time `storage.get`; defaults to the init timeout */
  storageTimeoutMs?: number;
  watchdogMs?: number;
  /** the storage keys read once at init (the durable document and its backup); default DurableState's two */
  saveKeys?: readonly string[];
  /** `bridge.gameVersion`; default left to the Bridge */
  gameVersion?: string;
  /** rewarded ads: allowed in the policy when the host supports them (default false) */
  rewarded?: boolean;
  /** the display name of a player the host names nothing for (default `Player`) */
  defaultName?: string;
  /** `advertisement.initialInterstitialDelay` of the game's bridge config, seconds (default 120) */
  initialInterstitialDelayS?: number;
}

/** timers and bound for the store's one init-time read; production uses setTimeout and STORAGE_LOAD_TIMEOUT_MS */
export interface PlaygamaSaveStoreTiming {
  /** keys read by `load()` in one request */
  keys?: readonly string[];
  setTimer: (fn: () => void, delayMs: number) => Timer;
  clearTimer: (timer: Timer) => void;
  loadTimeoutMs: number;
}

const defaultBridge = (): Bridge | undefined => {
  if (typeof window === 'undefined') return undefined;
  const w = window as unknown as { bridge?: Bridge; playgamaBridge?: Bridge };
  return w.bridge ?? w.playgamaBridge;
};

function detectDevice(bridge: Bridge): DeviceInfo {
  const kind = bridge.device.type;
  const type = kind === 'tv' ? 'desktop' : kind;
  let coarse = false;
  try {
    coarse = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
  } catch {
    coarse = false;
  }
  return Object.freeze({ type, input: coarse ? 'touch' : 'kbm', locale: 'en' });
}

/**
 * One-key string store over Bridge storage. Writes are immediate and batched while an earlier call is in flight.
 * The adapter keeps this one object for its whole life: when the Bridge is unavailable, `detach()` turns it into an
 * in-memory store and settles `ready`, so a caller that took `platform.save` before `init()` answered (the boot reads it
 * as soon as its own 15 s timeout fires) is never left awaiting a `ready` that cannot come.
 */
export class PlaygamaSaveStore implements SaveStore {
  readonly ready: Promise<void>;
  readonly #bridge: () => Bridge | undefined;
  readonly #warn: (message: string, error?: unknown) => void;
  readonly #cache = new Map<string, StorageValue>();
  readonly #dirty = new Map<string, StorageValue>();
  readonly #readyResolve: () => void;
  readonly #timing: PlaygamaSaveStoreTiming & { keys: readonly string[] };
  #inFlight: Promise<void> | null = null;
  #lastBatchSucceeded = true;
  #readySettled = false;
  #detached = false;

  constructor(
    bridge: () => Bridge | undefined,
    warn = (message: string, error?: unknown): void => console.warn(message, error),
    timing: Partial<PlaygamaSaveStoreTiming> = {},
  ) {
    this.#bridge = bridge;
    this.#warn = warn;
    this.#timing = {
      setTimer: timing.setTimer ?? ((fn, ms) => setTimeout(fn, ms)),
      clearTimer: timing.clearTimer ?? ((timer) => clearTimeout(timer)),
      loadTimeoutMs: timing.loadTimeoutMs ?? STORAGE_LOAD_TIMEOUT_MS,
      keys: timing.keys ?? DEFAULT_SAVE_KEYS,
    };
    let resolve!: () => void;
    this.ready = new Promise<void>((r) => (resolve = r));
    this.#readyResolve = resolve;
  }

  get(key: string): string | null {
    return this.#cache.get(key) ?? null;
  }

  /**
   * Called exactly once during adapter init: Bridge's array form keeps the load to one request.
   * The read is bounded by `loadTimeoutMs` (the init timeout, build §6.2): a host whose `storage.get` never answers would
   * otherwise leave `ready` (and the boot's `DurableState.load()`) waiting forever. On that timeout the store detaches to
   * memory rather than starting a Bridge-backed session from defaults: the hung read may still hold a real save, and the
   * first debounced write would overwrite it. A late answer is ignored.
   */
  async load(): Promise<void> {
    const keys = this.#timing.keys;
    let timer: Timer | null = null;
    try {
      const bridge = this.#bridge();
      if (!bridge) throw new Error('Bridge disappeared before storage load');
      const timedOut = Symbol('storage-timeout');
      const values = await Promise.race([
        Promise.resolve().then(() => bridge.storage.get([...keys], false)),
        new Promise<typeof timedOut>((resolve) => {
          timer = this.#timing.setTimer(() => resolve(timedOut), this.#timing.loadTimeoutMs);
        }),
      ]);
      if (values === timedOut) {
        this.#warn(`[playgama] storage.get did not answer within ${this.#timing.loadTimeoutMs} ms; continuing with an in-memory save store (saves will not persist)`);
        this.detach();
        return;
      }
      keys.forEach((key, i) => {
        const raw = Array.isArray(values) ? values[i] : null;
        this.#cache.set(key, typeof raw === 'string' ? raw : null);
      });
    } catch (error) {
      this.#warn('[playgama] storage.get failed; starting from defaults', error);
      for (const key of keys) this.#cache.set(key, null);
    } finally {
      if (timer !== null) this.#timing.clearTimer(timer);
      this.#resolveReadyOnce();
    }
  }

  set(key: string, value: string): void {
    if (key === '') throw new TypeError('SaveStore.set: the key must be non-empty');
    if (value === '') throw new TypeError(`SaveStore.set("${key}", '') would delete the key in Bridge storage`);
    if (!this.#readySettled) throw new Error('PlaygamaSaveStore.set called before ready');
    if (value.length > 256 * 1024) this.#warn(`[playgama] save "${key}" is unusually large (${value.length} bytes)`);
    this.#cache.set(key, value);
    this.#dirty.set(key, value);
    void this.#writeNext();
  }

  remove(key: string): void {
    if (key === '') throw new TypeError('SaveStore.remove: the key must be non-empty');
    if (!this.#readySettled) throw new Error('PlaygamaSaveStore.remove called before ready');
    this.#cache.delete(key);
    this.#dirty.set(key, null);
    void this.#writeNext();
  }

  /**
   * Bridge unavailable (no script, init timeout or failure): keep working in memory only, without persistence.
   * No browser storage is used as a substitute: the Playgama chunk must not reference it (the pack scanner forbids it).
   */
  detach(): void {
    if (this.#detached) return;
    this.#detached = true;
    this.#dirty.clear();
    for (const key of this.#timing.keys) if (!this.#cache.has(key)) this.#cache.set(key, null);
    this.#resolveReadyOnce();
  }

  /** Flush pending keys once. A failed batch is retained for a later set/flush; there is no retry loop. */
  async flush(): Promise<void> {
    for (;;) {
      if (this.#inFlight) {
        await this.#inFlight;
        if (!this.#lastBatchSucceeded) return;
        continue;
      }
      if (this.#dirty.size === 0) return;
      await this.#writeNext();
      if (!this.#lastBatchSucceeded) return;
    }
  }

  #resolveReadyOnce(): void {
    if (this.#readySettled) return;
    this.#readySettled = true;
    this.#readyResolve();
  }

  #writeNext(): Promise<void> {
    if (this.#detached) {
      this.#dirty.clear();
      return Promise.resolve();
    }
    if (this.#inFlight) return this.#inFlight;
    if (this.#dirty.size === 0) return Promise.resolve();
    const pending = new Map(this.#dirty);
    this.#dirty.clear();
    const bridge = this.#bridge();
    if (!bridge) {
      for (const [key, value] of pending) if (!this.#dirty.has(key)) this.#dirty.set(key, value);
      this.#lastBatchSucceeded = false;
      this.#warn('[playgama] Bridge unavailable; save retained for a later flush');
      return Promise.resolve();
    }

    const sets = [...pending].filter((entry): entry is [string, string] => entry[1] !== null);
    const deletes = [...pending].filter((entry): entry is [string, null] => entry[1] === null).map(([key]) => key);
    const writes: Promise<void>[] = [];
    if (sets.length) writes.push(Promise.resolve().then(() => bridge.storage.set(sets.map(([key]) => key), sets.map(([, value]) => value))));
    if (deletes.length) writes.push(Promise.resolve().then(() => bridge.storage.delete(deletes)));

    let request!: Promise<void>;
    request = Promise.all(writes)
      .then(() => {
        this.#lastBatchSucceeded = true;
      })
      .catch((error: unknown) => {
        this.#lastBatchSucceeded = false;
        for (const [key, value] of pending) if (!this.#dirty.has(key)) this.#dirty.set(key, value);
        this.#warn('[playgama] save failed; values retained for the next flush', error);
      })
      .finally(() => {
        if (this.#inFlight === request) this.#inFlight = null;
        // A successful request may have overlapped newer writes. Drain them in one later batch.
        if (this.#lastBatchSucceeded && this.#dirty.size > 0) void this.#writeNext();
      });
    this.#inFlight = request;
    return request;
  }
}

interface PendingAd {
  kind: AdKind;
  opened: boolean;
  rewarded: boolean;
  resolve(result: AdResult): void;
}

export class PlaygamaPlatform implements Platform {
  readonly id = 'playgama' as const;
  readonly #events = createEmitter<PlatformEvents>('platform:playgama');
  readonly #getBridge: () => Bridge | undefined;
  readonly #now: () => number;
  readonly #setTimer: (fn: () => void, ms: number) => Timer;
  readonly #clearTimer: (timer: Timer) => void;
  readonly #document: Pick<Document, 'exitPointerLock'> | null;
  readonly #initTimeoutMs: number;
  readonly #watchdogMs: number;
  readonly #gameVersion: string | undefined;
  readonly #rewardedAllowed: boolean;
  readonly #defaultName: string;
  readonly #initialDelayS: number;
  readonly #bridgeListeners: Array<() => void> = [];
  #initPromise: Promise<void> | null = null;
  #initialized = false;
  #ok = false;
  #hostId = 'none';
  #device: DeviceInfo = Object.freeze({ type: 'desktop', input: 'kbm', locale: 'en' });
  #policy: PlatformPolicy = Object.freeze({ externalLinks: false, rewardedEnabled: false, interstitialPlacements: INTERSTITIAL_PLACEMENTS });
  readonly #save: PlaygamaSaveStore;
  #muted = false;
  #paused = false;
  #gameReadySent = false;
  /** `gameReady()` arrived before the Bridge was initialised: sent when it is */
  #gameReadyQueued = false;
  #readyAt = 0;
  #lastInterstitialClosedAt: number | null = null;
  #pending: PendingAd | null = null;
  /** an interstitial the adapter did not request (host pre-roll at boot, a Smart Ad, one that opened after the watchdog) */
  #hostAdOpen = false;
  #watchdog: Timer | null = null;
  #gameplay = false;

  constructor(options: PlaygamaPlatformOptions = {}) {
    this.#getBridge = options.bridge ?? defaultBridge;
    this.#now = options.now ?? (() => performance.now());
    this.#setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.#clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
    this.#document = options.document !== undefined ? options.document : typeof document === 'undefined' ? null : document;
    this.#initTimeoutMs = options.initTimeoutMs ?? INIT_TIMEOUT_MS;
    this.#watchdogMs = options.watchdogMs ?? PRESTART_WATCHDOG_MS;
    this.#gameVersion = options.gameVersion;
    this.#rewardedAllowed = options.rewarded === true;
    this.#defaultName = options.defaultName ?? 'Player';
    this.#initialDelayS = options.initialInterstitialDelayS ?? INITIAL_INTERSTITIAL_DELAY_S;
    const bridge = (): Bridge | undefined => this.#getBridge();
    this.#save = new PlaygamaSaveStore(bridge, undefined, {
      setTimer: this.#setTimer,
      clearTimer: this.#clearTimer,
      loadTimeoutMs: options.storageTimeoutMs ?? this.#initTimeoutMs,
      keys: options.saveKeys ?? DEFAULT_SAVE_KEYS,
    });
  }

  get hostId(): string {
    return this.#hostId;
  }
  get save(): SaveStore {
    return this.#save;
  }
  get device(): DeviceInfo {
    return this.#device;
  }
  get policy(): PlatformPolicy {
    return this.#policy;
  }
  get platformPaused(): boolean {
    return this.#paused;
  }
  get platformMuted(): boolean {
    return this.#muted;
  }

  init(): Promise<void> {
    this.#initPromise ??= this.#initialize();
    return this.#initPromise;
  }

  async #initialize(): Promise<void> {
    let bridge: Bridge | undefined;
    try {
      bridge = this.#getBridge();
    } catch {
      this.#becomeFallback('bridge-lookup-failed');
      return;
    }
    if (!bridge) {
      this.#becomeFallback('script-missing');
      return;
    }

    let timeout: Timer | null = null;
    try {
      if (this.#gameVersion !== undefined) bridge.gameVersion = this.#gameVersion;
      await Promise.race([
        bridge.initialize(),
        new Promise<never>((_, reject) => {
          timeout = this.#setTimer(() => reject(new Error('Bridge initialize timeout')), this.#initTimeoutMs);
        }),
      ]);
    } catch (error) {
      this.#becomeFallback(error instanceof Error && error.message.includes('timeout') ? 'init-timeout' : 'init-failed');
      return;
    } finally {
      if (timeout !== null) this.#clearTimer(timeout);
    }

    try {
      this.#ok = true;
      this.#hostId = bridge.platform.id as PlatformId;
      const language = bridge.platform.language || 'en';
      console.info(`[playgama] Bridge language: ${language}; game UI remains English`);
      this.#muted = !bridge.platform.isAudioEnabled;
      this.#paused = bridge.platform.isPaused;
      this.#device = detectDevice(bridge);
      this.#policy = Object.freeze({
        externalLinks: bridge.platform.isExternalLinksAllowed,
        rewardedEnabled: this.#rewardedAllowed && bridge.advertisement.isRewardedSupported,
        interstitialPlacements: INTERSTITIAL_PLACEMENTS,
      });

      const onAudio = (enabled: boolean): void => {
        const muted = !enabled;
        if (muted === this.#muted) return;
        this.#muted = muted;
        this.#events.emit('platformMute', muted);
      };
      const onPause = (paused: boolean): void => {
        if (paused === this.#paused) return;
        this.#paused = paused;
        if (paused) {
          try {
            this.#document?.exitPointerLock();
          } catch {
            // Pointer lock may already have ended while the browser was switching tabs.
          }
        }
        this.#events.emit('platformPause', paused);
      };
      const onInterstitial = (state: InterstitialState): void => this.#onInterstitial(state);
      const onRewarded = (state: RewardedState): void => this.#onRewarded(state);
      this.#bridgeListeners.push(() => bridge.platform.off(EVENT_NAME.AUDIO_STATE_CHANGED, onAudio));
      bridge.platform.on(EVENT_NAME.AUDIO_STATE_CHANGED, onAudio);
      this.#bridgeListeners.push(() => bridge.platform.off(EVENT_NAME.PAUSE_STATE_CHANGED, onPause));
      bridge.platform.on(EVENT_NAME.PAUSE_STATE_CHANGED, onPause);
      this.#bridgeListeners.push(() => bridge.advertisement.off(EVENT_NAME.INTERSTITIAL_STATE_CHANGED, onInterstitial));
      bridge.advertisement.on(EVENT_NAME.INTERSTITIAL_STATE_CHANGED, onInterstitial);
      this.#bridgeListeners.push(() => bridge.advertisement.off(EVENT_NAME.REWARDED_STATE_CHANGED, onRewarded));
      bridge.advertisement.on(EVENT_NAME.REWARDED_STATE_CHANGED, onRewarded);

      await this.#save.load();
      // The Bridge emits only changes. Publish current host state once after subscribers have had a chance to bind.
      if (this.#muted) this.#events.emit('platformMute', true);
      if (this.#paused) this.#events.emit('platformPause', true);
      if (bridge.advertisement.interstitialState === 'opened' && !this.#hostAdOpen) {
        this.#hostAdOpen = true;
        this.#events.emit('adPause');
      }
      this.#initialized = true;
      if (this.#gameReadyQueued) {
        this.#gameReadyQueued = false;
        this.gameReady();
      }
    } catch {
      for (const off of this.#bridgeListeners.splice(0)) {
        try {
          off();
        } catch {
          // A broken Bridge listener cleanup must not prevent the web fallback.
        }
      }
      this.#becomeFallback('adapter-init-failed');
    }
  }

  setLoadingProgress(percent: number): void {
    const bridge = this.#getBridge();
    if (!bridge || !Number.isFinite(percent)) return;
    try {
      bridge.setGameLoadingProgress(Math.max(0, Math.min(100, Math.round(percent))));
    } catch {
      // Loading progress must never stop boot.
    }
  }

  gameReady(): void {
    if (!this.#initialized) {
      // before the Bridge answered: remembered, sent once it is initialised (dropped if it falls back)
      this.#gameReadyQueued = true;
      return;
    }
    if (!this.#ok || this.#gameReadySent) return;
    this.#gameReadySent = true;
    this.#readyAt = this.#now();
    this.#sendMessage(PLATFORM_MESSAGE.GAME_READY);
  }

  loadingStart(): void {
    this.#sendMessage(PLATFORM_MESSAGE.IN_GAME_LOADING_STARTED);
  }

  loadingStop(): void {
    this.#sendMessage(PLATFORM_MESSAGE.IN_GAME_LOADING_STOPPED);
  }

  setGameplay(active: boolean): void {
    if (active === this.#gameplay) return;
    this.#gameplay = active;
    this.#sendMessage(active ? PLATFORM_MESSAGE.GAMEPLAY_STARTED : PLATFORM_MESSAGE.GAMEPLAY_STOPPED);
  }

  matchEvent(event: MatchEvent): void {
    const message = ({
      start: PLATFORM_MESSAGE.LEVEL_STARTED,
      complete: PLATFORM_MESSAGE.LEVEL_COMPLETED,
      fail: PLATFORM_MESSAGE.LEVEL_FAILED,
      pause: PLATFORM_MESSAGE.LEVEL_PAUSED,
      resume: PLATFORM_MESSAGE.LEVEL_RESUMED,
      achievement: PLATFORM_MESSAGE.PLAYER_GOT_ACHIEVEMENT,
    } as const)[event.type];
    const payload = event.type === 'achievement' ? null : { world: event.map, level: `${event.difficulty}-${event.waves}` };
    this.#sendMessage(message, payload);
  }

  track(name: string, data?: Readonly<Record<string, string | number | boolean>>): void {
    if (!this.#ok) return;
    try {
      this.#getBridge()?.analytics.send(name, data ? { ...data } : undefined);
    } catch {
      // Analytics is optional and must not affect the match.
    }
  }

  showAd(kind: AdKind, placement: Placement): Promise<AdResult> {
    const bridge = this.#getBridge();
    if (!this.#ok || !bridge) return Promise.resolve({ shown: false, reason: 'disabled' });
    const ads = bridge.advertisement;
    if (kind === 'interstitial' ? !ads.isInterstitialSupported : !ads.isRewardedSupported) {
      return Promise.resolve({ shown: false, reason: 'disabled' });
    }
    const bridgeBusy = ads.interstitialState === 'loading' || ads.interstitialState === 'opened'
      || ads.rewardedState === 'loading' || ads.rewardedState === 'opened' || ads.rewardedState === 'rewarded';
    if (this.#pending || bridgeBusy) return Promise.resolve({ shown: false, reason: 'busy' });
    if (kind === 'interstitial' && this.#interstitialCooldownLeft(ads.minimumDelayBetweenInterstitial) > 0) {
      return Promise.resolve({ shown: false, reason: 'cooldown' });
    }

    this.#events.emit('adBusy', true);
    try {
      this.#document?.exitPointerLock();
    } catch {
      // A Smart Ad may have already released pointer lock.
    }
    return new Promise<AdResult>((resolve) => {
      this.#pending = { kind, opened: false, rewarded: false, resolve };
      this.#watchdog = this.#setTimer(() => {
        if (this.#pending && !this.#pending.opened) this.#settle({ shown: false, reason: 'timeout' });
      }, this.#watchdogMs);
      try {
        if (kind === 'interstitial') ads.showInterstitial(placement);
        else ads.showRewarded(placement);
      } catch {
        this.#settle({ shown: false, reason: 'other' });
      }
    });
  }

  getUser(): Promise<PlatformUser | null> {
    const bridge = this.#getBridge();
    if (!this.#ok || !bridge?.player.isAuthorized) return Promise.resolve(null);
    return Promise.resolve({
      id: bridge.player.id,
      name: bridge.player.name || this.#defaultName,
      loggedIn: true,
    });
  }

  on = this.#events.on;

  dispose(): void {
    for (const off of this.#bridgeListeners.splice(0)) off();
    if (this.#watchdog !== null) this.#clearTimer(this.#watchdog);
    this.#watchdog = null;
    if (this.#pending) this.#settle({ shown: false, reason: 'other' });
    this.#events.clear();
  }

  #sendMessage(message: string, data?: { world?: string; level?: string } | null): void {
    if (!this.#ok) return;
    try {
      const result = this.#getBridge()?.platform.sendMessage(message, data ?? null);
      if (result && typeof result.then === 'function') void result.catch(() => {});
    } catch {
      // Platform lifecycle messages are best-effort and never block gameplay.
    }
  }

  #onInterstitial(state: InterstitialState): void {
    if (state === 'closed') this.#lastInterstitialClosedAt = this.#now();
    const pending = this.#pending;
    if (!pending || pending.kind !== 'interstitial') {
      // Not ours: pause on open and give the pause back when it ends, or the `ad` reason would never clear.
      if (state === 'opened' && !this.#hostAdOpen) {
        this.#hostAdOpen = true;
        this.#events.emit('adPause');
      } else if ((state === 'closed' || state === 'failed') && this.#hostAdOpen) {
        this.#hostAdOpen = false;
        this.#events.emit('adResume');
      }
      return;
    }
    if (state === 'opened') {
      pending.opened = true;
      this.#clearWatchdog();
      this.#events.emit('adPause');
    } else if (state === 'closed') {
      this.#settle({ shown: true, rewarded: false });
    } else if (state === 'failed') {
      this.#settle({ shown: false, reason: 'other' });
    }
  }

  #onRewarded(state: RewardedState): void {
    const pending = this.#pending;
    if (!pending || pending.kind !== 'rewarded') return;
    if (state === 'opened') {
      pending.opened = true;
      this.#clearWatchdog();
      this.#events.emit('adPause');
    } else if (state === 'rewarded') {
      pending.rewarded = true;
    } else if (state === 'closed') {
      this.#settle({ shown: true, rewarded: pending.rewarded });
    } else if (state === 'failed') {
      this.#settle(pending.rewarded ? { shown: true, rewarded: true } : { shown: false, reason: 'other' });
    }
  }

  #settle(result: AdResult): void {
    const pending = this.#pending;
    if (!pending) return;
    this.#pending = null;
    this.#clearWatchdog();
    if (pending.opened) this.#events.emit('adResume');
    this.#events.emit('adBusy', false);
    pending.resolve(result);
  }

  #clearWatchdog(): void {
    if (this.#watchdog === null) return;
    this.#clearTimer(this.#watchdog);
    this.#watchdog = null;
  }

  #interstitialCooldownLeft(minimumDelaySeconds: number): number {
    if (!this.#gameReadySent) return Infinity;
    const now = this.#now();
    const initialDelay = this.#initialDelayS * 1000 - (now - this.#readyAt);
    const minimumDelay = this.#lastInterstitialClosedAt === null
      ? 0
      : minimumDelaySeconds * 1000 - (now - this.#lastInterstitialClosedAt);
    return Math.max(0, initialDelay, minimumDelay);
  }

  #becomeFallback(reason: string): void {
    console.warn(`[playgama] Bridge unavailable (${reason}); continuing with an in-memory save store (saves will not persist)`);
    this.#ok = false;
    this.#save.detach();
    this.#hostId = 'none';
    this.#device = Object.freeze({ type: 'desktop', input: 'kbm', locale: 'en' });
    this.#policy = Object.freeze({ externalLinks: false, rewardedEnabled: false, interstitialPlacements: INTERSTITIAL_PLACEMENTS });
    this.#muted = false;
    this.#paused = false;
    this.#hostAdOpen = false;
    this.#gameReadyQueued = false;
    this.#initialized = true;
  }
}

export function createPlaygamaPlatform(options: PlaygamaPlatformOptions = {}): PlaygamaPlatform {
  return new PlaygamaPlatform(options);
}

export const PLAYGAMA_INIT_TIMEOUT_MS = INIT_TIMEOUT_MS;
export const PLAYGAMA_STORAGE_LOAD_TIMEOUT_MS = STORAGE_LOAD_TIMEOUT_MS;
export const PLAYGAMA_AD_WATCHDOG_MS = PRESTART_WATCHDOG_MS;
export const PLAYGAMA_INITIAL_INTERSTITIAL_DELAY_S = INITIAL_INTERSTITIAL_DELAY_S;
