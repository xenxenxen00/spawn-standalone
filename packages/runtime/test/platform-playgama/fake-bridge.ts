// A scripted stand-in for the Playgama Bridge (the parts the adapter reads), with the Bridge's event order.
import { EVENT_NAME } from '@playgama/bridge/constants';

type Fn = (...a: never[]) => void;

class Emitter {
  readonly #subs = new Map<string, Set<Fn>>();
  on(event: string, fn: Fn): void {
    (this.#subs.get(event) ?? this.#subs.set(event, new Set()).get(event)!).add(fn);
  }
  off(event: string, fn: Fn): void {
    this.#subs.get(event)?.delete(fn);
  }
  emit(event: string, ...args: unknown[]): void {
    for (const fn of [...(this.#subs.get(event) ?? [])]) (fn as (...a: unknown[]) => void)(...args);
  }
  count(event: string): number {
    return this.#subs.get(event)?.size ?? 0;
  }
}

export interface FakeBridgeOptions {
  platformId?: string;
  paused?: boolean;
  audioEnabled?: boolean;
  storage?: Record<string, string>;
  interstitialSupported?: boolean;
  rewardedSupported?: boolean;
  minimumDelayBetweenInterstitial?: number;
  authorized?: boolean;
  playerName?: string;
  deviceType?: 'desktop' | 'mobile' | 'tablet' | 'tv';
  /** initialize() never settles */
  hang?: boolean;
  /** storage.get never settles */
  hangStorage?: boolean;
}

export function createFakeBridge(o: FakeBridgeOptions = {}) {
  const platformEvents = new Emitter();
  const adEvents = new Emitter();
  const store = new Map(Object.entries(o.storage ?? {}));
  const log: string[] = [];
  const messages: Array<{ message: string; data: unknown }> = [];
  const analytics: Array<{ name: string; data: unknown }> = [];
  const shown: Array<{ kind: 'interstitial' | 'rewarded'; placement: string }> = [];
  const platform = {
    id: o.platformId ?? 'mock',
    language: 'en',
    isAudioEnabled: o.audioEnabled ?? true,
    isPaused: o.paused ?? false,
    isExternalLinksAllowed: true,
    on: (e: string, fn: Fn) => platformEvents.on(e, fn),
    off: (e: string, fn: Fn) => platformEvents.off(e, fn),
    sendMessage: (message: string, data: unknown) => {
      messages.push({ message, data });
      return Promise.resolve();
    },
  };
  const advertisement = {
    isInterstitialSupported: o.interstitialSupported ?? true,
    isRewardedSupported: o.rewardedSupported ?? true,
    interstitialState: 'closed',
    rewardedState: 'closed',
    minimumDelayBetweenInterstitial: o.minimumDelayBetweenInterstitial ?? 0,
    on: (e: string, fn: Fn) => adEvents.on(e, fn),
    off: (e: string, fn: Fn) => adEvents.off(e, fn),
    showInterstitial: (placement: string) => {
      shown.push({ kind: 'interstitial', placement });
      advertisement.interstitialState = 'loading';
    },
    showRewarded: (placement: string) => {
      shown.push({ kind: 'rewarded', placement });
      advertisement.rewardedState = 'loading';
    },
  };
  const bridge = {
    gameVersion: '',
    initialize: () => (o.hang ? new Promise<void>(() => {}) : Promise.resolve()),
    setGameLoadingProgress: (n: number) => void log.push(`progress ${n}`),
    platform,
    advertisement,
    device: { type: o.deviceType ?? 'desktop' },
    player: { isAuthorized: o.authorized ?? false, id: o.authorized ? 'p42' : null, name: o.playerName ?? '' },
    analytics: { send: (name: string, data: unknown) => void analytics.push({ name, data }) },
    storage: {
      get: (keys: string[]) => (o.hangStorage ? new Promise(() => {}) : Promise.resolve(keys.map((k) => store.get(k) ?? null))),
      set: (keys: string[], values: string[]) => {
        keys.forEach((k, i) => store.set(k, values[i]!));
        log.push(`set ${keys.join(',')}`);
        return Promise.resolve();
      },
      delete: (keys: string[]) => {
        for (const k of keys) store.delete(k);
        log.push(`delete ${keys.join(',')}`);
        return Promise.resolve();
      },
    },
  };
  return {
    bridge,
    store,
    log,
    messages,
    analytics,
    shown,
    /** the host moves the Bridge's interstitial: loading -> opened -> closed (or failed) */
    interstitial(state: 'opened' | 'closed' | 'failed'): void {
      advertisement.interstitialState = state;
      adEvents.emit(EVENT_NAME.INTERSTITIAL_STATE_CHANGED, state);
    },
    rewarded(state: 'opened' | 'rewarded' | 'closed' | 'failed'): void {
      advertisement.rewardedState = state;
      adEvents.emit(EVENT_NAME.REWARDED_STATE_CHANGED, state);
    },
    hostPause(paused: boolean): void {
      platform.isPaused = paused;
      platformEvents.emit(EVENT_NAME.PAUSE_STATE_CHANGED, paused);
    },
    hostAudio(enabled: boolean): void {
      platform.isAudioEnabled = enabled;
      platformEvents.emit(EVENT_NAME.AUDIO_STATE_CHANGED, enabled);
    },
    listeners: () => platformEvents.count(EVENT_NAME.PAUSE_STATE_CHANGED) + platformEvents.count(EVENT_NAME.AUDIO_STATE_CHANGED) + adEvents.count(EVENT_NAME.INTERSTITIAL_STATE_CHANGED),
  };
}
