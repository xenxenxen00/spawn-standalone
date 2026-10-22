// The Playgama Bridge platform adapter (copied from purge-protocol-web ebab692 src/platform/playgama.ts, made game-agnostic).
// `composeGame({ platform: 'playgama' })` loads it on demand; a game with its own composition imports it from here.
export {
  createPlaygamaPlatform,
  PLAYGAMA_AD_WATCHDOG_MS,
  PLAYGAMA_INIT_TIMEOUT_MS,
  PLAYGAMA_INITIAL_INTERSTITIAL_DELAY_S,
  PLAYGAMA_STORAGE_LOAD_TIMEOUT_MS,
  PlaygamaPlatform,
  PlaygamaSaveStore,
  type PlaygamaPlatformOptions,
  type PlaygamaSaveStoreTiming,
} from './playgama.ts';
