// Optional adapter capabilities above the minimal kernel HostPlatform boundary.
import type { HostPlatform, PlatformUser, SaveStore } from '../compat/core/ports.ts';
export type { HostPlatform, PlatformUser, SaveStore } from '../compat/core/ports.ts';

export type AdKind = 'interstitial' | 'rewarded';
export type Placement = string;
export type AdFailure = 'disabled' | 'busy' | 'cooldown' | 'timeout' | 'other';
export type AdResult = { shown: true; rewarded: boolean } | { shown: false; reason: AdFailure };
export type MatchEventType = 'start' | 'complete' | 'fail' | 'pause' | 'resume' | 'achievement';
export interface MatchEvent {
  type: MatchEventType;
  map: string;
  difficulty: string;
  waves: number;
}
export interface DeviceInfo {
  type: 'desktop' | 'mobile' | 'tablet';
  input: 'kbm' | 'touch';
  locale: string;
}
export interface PlatformPolicy {
  externalLinks: boolean;
  rewardedEnabled: boolean;
  interstitialPlacements: readonly Placement[];
}
export interface PlatformEvents {
  /** PG PAUSE_STATE_CHANGED (ad, tab hidden, window blur, host) */
  platformPause: (paused: boolean) => void;
  /** PG AUDIO_STATE_CHANGED (inverted) */
  platformMute: (muted: boolean) => void;
  /** from request to settle: block UI input */
  adBusy: (busy: boolean) => void;
  /** an ad is actually on screen / gone */
  adPause: () => void;
  adResume: () => void;
}
export interface Platform extends HostPlatform {
  readonly id: string;
  /** bridge.platform.id ('playgama' | 'playgama_sandbox' | 'qa_tool' | 'mock' | …) or 'web' */
  readonly hostId: string;
  readonly save: SaveStore;
  readonly device: DeviceInfo;
  readonly policy: PlatformPolicy;
  readonly platformPaused: boolean;
  readonly platformMuted: boolean;
  /** never rejects; falls back to the web store on failure */
  init(): Promise<void>;
  /** 0..100, must reach 100 */
  setLoadingProgress(pct: number): void;
  /** once */
  gameReady(): void;
  /** in_game_loading_* */
  loadingStart(): void;
  loadingStop(): void;
  /** gameplay_started/stopped, coalesced */
  setGameplay(active: boolean): void;
  /** level_* / player_got_achievement */
  matchEvent(e: MatchEvent): void;
  track(name: string, data?: Readonly<Record<string, string | number | boolean>>): void;
  showAd(kind: AdKind, placement: Placement): Promise<AdResult>;
  getUser(): Promise<PlatformUser | null>;
  on<K extends keyof PlatformEvents>(ev: K, cb: PlatformEvents[K]): () => void;
}



/** `Platform.id`: which adapter runs ('playgama' | 'web'), chosen at build time by `__SS_PLATFORM__` (select.ts) */
export type PlatformId = Platform['id'];

/** creates one adapter; select.ts picks one by `__SS_PLATFORM__` */
export type PlatformFactory = () => Platform;

/** the interstitial placements of build §6.7 (`double_xp` is the rewarded one) */
export const INTERSTITIAL_PLACEMENTS = Object.freeze(['match_end', 'to_lobby', 'wave_break'] as const satisfies readonly Placement[]);

/**
 * What an ad provider may do to the adapter that hosts it (fake-ads.ts drives this on the web adapter): emit the platform
 * events and hold the host pause/mute while an ad is on screen, as the Bridge's PAUSE_STATE_CHANGED / AUDIO_STATE_CHANGED do.
 */
export interface AdHost {
  emit<K extends keyof PlatformEvents>(ev: K, ...args: Parameters<PlatformEvents[K]>): void;
  /** true while an ad holds the host pause and mute; the adapter combines it with its page state */
  setAdHold(on: boolean): void;
  readonly document: Document | null;
}

/** an ad source plugged into an adapter (`showAd` delegates to it) */
export interface AdProvider {
  showAd(kind: AdKind, placement: Placement): Promise<AdResult>;
  /** interstitial placements it can serve (→ `PlatformPolicy.interstitialPlacements`) */
  readonly placements: readonly Placement[];
  /** it can serve rewarded ads (→ `PlatformPolicy.rewardedEnabled`) */
  readonly rewarded: boolean;
  dispose(): void;
}
