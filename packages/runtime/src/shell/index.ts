// @spawn-standalone/runtime shell: the default composition of a converted game (composeGame) and the generic host pieces it
// is built from (copied from purge-protocol-web ebab692 src/app and src/platform; each file names its origin).
export {
  composeGame,
  contentLoader,
  EMPTY_ASSET_INDEX,
  defaultParts,
  DEFAULT_SHELL_EXTENSIONS,
  mergeExtensions,
  mergeGameExtensions,
  withProfile,
  DEFAULT_PROFILE_NAME,
  type ComposeBootOptions,
  type ComposeGameOptions,
  type ComposeInputOptions,
  type ComposePointerLock,
  type ComposeProfileOptions,
  type ComposeRenderOptions,
  type ComposeTouchOptions,
  type FrameHost,
  type GameApp,
  type ShellAudio,
  type ShellCamera,
  type ShellInput,
  type ShellParts,
  type ShellRenderer,
  type ShellRenderEnv,
  type ShellScene,
  type ShellStep,
  type ShellUi,
  type ShellWiring,
  type ShellWiringEnv,
} from './compose-game.ts';
export { createActWiring, wireActs, type ActWiring, type ActWiringDeps, type ActWiringHost } from './act-wiring.ts';
export { createFrameDriver, startFrameDriver, type FrameDriver, type FrameDriverDeps, type FrameInfo, type FrameRenderer } from './frame.ts';
export { createPresentationClock, type PresentationClock } from './presentation-clock.ts';
export { DeferredScenePort } from './deferred-scene-port.ts';
export { installEntityAudioHost } from './entity-audio-host.ts';
export { createAudioEngine, type AudioEngineCore, type AudioEngineDeps } from '../runtime/audio/audio-engine.ts';
export type { AudioEngine, AudioEngineOptions } from '../runtime/audio/types.ts';
export { createWebPlatform, type WebPlatform, type WebPlatformOptions } from './web-platform.ts';
export { WebSaveStore, WEB_SAVE_PREFIX, type StorageLike, type WebSaveOptions } from './web-save.ts';
export { CARRIED_LIGHTING_SCRIPT, createDefaultRenderer, resolveLightingScript, type ContentLoader, type DefaultEngineModule, type DefaultRenderer, type DefaultRendererEnv, type DefaultRendererOptions, type RenderFlags } from './default-renderer.ts';
export { createDefaultWiring, createIndexLibrary, type DefaultWiring, type DefaultWiringOptions, type RenderLinks } from './default-wiring.ts';
export { adBreakUiPort, AdBreaks, installAdBreakPageApi, type AdBreakHost, type AdBreakOptions, type AdBreakRequest, type AdBreakResult } from './ad-break.ts';
export { bindHostPaused, installViewport, type ViewportHandle, type ViewportInfo, type ViewportOptions } from './host-state.ts';
export { createFakeAds, fakeAdsModeFromQuery, type FakeAdsMode, type FakeAdsOptions } from './fake-ads.ts';
