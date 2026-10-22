// composeGame(options): the default composition of a converted Spawn game on this runtime (plan §2.3, "runtime/shell"): an
// always-playing lifecycle (no Director, no lobby/match gate), a web platform with local save, the kernel boot with the
// game's ports and extensions, audio, input, the camera presenter and rig host, the UI host, generic act routing, the frame
// driver and a loading gate that releases when the kernel stands and the renderer (when one is given) is attached.
//
// Pattern: purge-protocol-web ebab692 src/app/compose.ts (order) and src/boot/boot-sequence.ts (gate), written game-agnostic.
// Order (each step is recorded in `app.steps`):
//   platform     options.platform, else the web platform with local save under `<slug>:`
//   audio        the audio engine (no context: the first gesture creates it) + the gesture unlock
//   input        the input map from the world config's `inputs`, the input log + action sink + port, keyboard/mouse on the canvas
//   camera       presentation clock, camera presenter, rig host (the kernel's CameraPort)
//   scene        the deferred scene port (records until a renderer attaches)
//   ui           the UI host over the game's UI module, when there is one (UiHostConfig, globals 'auto' by default)
//   extensions   the game's KernelExtensions bag over this shell's defaults, with ctx.sql / ctx.job / ctx.music from the ports
//   kernel       bootKernel; in onKernel: rig attach, wiring.onKernel, pause controller, acts, entity audio, frame driver;
//                in beforeWarmup: the UI host mounts
//   renderer     options.renderer(app) → its scene port attaches to the deferred one, its loop takes the frame driver;
//                'default': default-renderer.ts (createRenderer + installGame, the lighting module required or neutral)
//   gate         the frame driver starts; it sends 100 % and gameReady at the first interactive frame
//
// Opt-in options (each default reproduces the plain composition): `rigs` (K3), `durable`, `profile`, `input` (map options, pointer lock,
// unlocked look, touch layer), `ext`, `platform` ('web' | 'playgama' | a Platform), `headless` (no window: no audio unlock, no page
// listeners, no requestAnimationFrame chain; the caller steps `app.driver.step(t)`).
//
// Headless stepping (test/shell/headless.test.ts runs it with `window` and `performance` removed): `composeGame({ headless: true, canvas: null })`
// touches no window, document, canvas or performance, and no timer or requestAnimationFrame runs the game. After it resolves the kernel stands
// and the clock runs; each `app.driver.step(timeMs)` advances the kernel by the time since the previous call (the first call runs a frame of no
// elapsed time; the same timestamp twice is ignored) and runs its ticks, so a test or a server loop steps with a monotonic millisecond clock of its own, e.g.
// `for (let t = 0; t <= 1000; t += 50) app.driver.step(t)`. `app.dispose()` ends it.
//
// Every heavy piece is built through `parts` (default: the runtime's own modules, imported lazily), so the composition is
// unit-tested in Node with fakes.
import type { BootEnv, BootResult, BootWorld } from '../compat/core/boot/boot.ts';
import { extOf, type KernelExtensions } from '../compat/core/ext.ts';
import type { CoreKernel } from '../compat/core/kernel.ts';
import type { KernelPorts, Platform, SceneSyncPort } from '../compat/core/ports.ts';
import { HOST_PAUSE_REASONS } from '../compat/core/rules.ts';
import type { JobPauseGate, JobPort } from '../ports/jobs/types.ts';
import type { MusicPort } from '../ports/music/types.ts';
import type { SqlPort } from '../ports/sql/types.ts';
import type { HostSqlStores } from '../ports/sql/host-stores.ts';
import type { UiHostConfig } from '../runtime/ui/ui-host-config.ts';
import type { AssetResolver } from '../assets/resolver.ts';
import type { BrowserGeometryOptions, GeometryService, PoolOptions, WorkerLike } from '../render/geometry/geometry-service.ts';
import type { DurableOptions, DurableState } from '../compat/core/save/durable.ts';
import type { InputMapOptions } from '../runtime/input/input-options.ts';
import type { TouchScheme } from '../runtime/input/touch/scheme.ts';
import type { TouchFrameState } from '../runtime/input/touch/touch-layer.ts';
import type { PointerLockOptions } from '../runtime/input/pointer-lock.ts';
import type { ScriptRigs } from '../render/rig/script-rigs.ts';
import type { ActWiring } from './act-wiring.ts';
import { adBreakUiPort, AdBreaks, installAdBreakPageApi, type AdBreakOptions, type PageApiTarget } from './ad-break.ts';
import { bindHostPaused, installViewport, type ViewportHandle, type ViewportOptions } from './host-state.ts';
import type { ContentLoader, DefaultRendererOptions, RenderFlags } from './default-renderer.ts';
import type { DefaultWiringOptions } from './default-wiring.ts';
import type { FrameDriver, FrameRenderer } from './frame.ts';

export type ShellStep = 'platform' | 'audio' | 'input' | 'camera' | 'scene' | 'ui' | 'extensions' | 'kernel' | 'onKernel' | 'beforeWarmup' | 'renderer' | 'gate';

/** the audio engine as the shell uses it (runtime/audio AudioEngineCore satisfies it) */
export interface ShellAudio {
  frame(): void;
  playSound(id: string, payload: never, meta: { sourceId: string | null; sourcePlace: string | null }): void;
  stopSound(payload: never): void;
  setListener(pose: never): void;
  /** stores the manifest and tier; the first gesture builds the graph. Without it no entity audio or clip loads */
  init?(opts: import('../runtime/audio/types.ts').AudioEngineOptions): void;
  dispose?(): void;
}

export interface ShellInput {
  /** the kernel's InputPort */
  port: KernelPorts['input'];
  /** the action sink the UI host injects into */
  sink: unknown;
  /** the input log (look, deliver, setAimView) the rig host reads */
  log: unknown;
  /** the pointer-lock manager, when `input.pointerLock` asked for one */
  lock?: { readonly state: string; requestLock(origin: 'canvas' | 'ui' | 'resume'): void; setModal?(modal: boolean): void; setGameplayActive?(on: boolean): void; dispose(): void } | null;
  /** the touch layer, when `input.touch` asked for one (mounted after the UI host, framed by the driver) */
  touch?: { mount(): void; frame(): void; dispose(): void } | null;
  dispose(): void;
}

export interface ShellCamera {
  presentation: { hitstop(seconds: number): void; now(): number; frame?(dtS: number): void };
  presenter: { readonly last: { eye: { x: number; y: number; z: number } } | null; setTarget?(target: unknown): void };
  /** the kernel's CameraPort, with the frame step and the kernel attach */
  rig: KernelPorts['camera'] & { attach(kernel: CoreKernel): void; frame(dtS: number): void };
}

export interface ShellScene extends SceneSyncPort {
  attach(real: SceneSyncPort): void;
  readonly attached: boolean;
}

export interface ShellUi {
  uiPort(): KernelPorts['ui'];
  mount(): void;
  frame(nowMs?: number): void;
  coversScene(): boolean;
  onFirstInteractiveFrame(cb: () => void): void;
  dispose(): void;
}

/** physics, nav and motion (purge-protocol-web src/app/real-ports.ts is the pattern): made before the boot, attached in onKernel */
export interface ShellWiring {
  readonly ports: Partial<Pick<KernelPorts, 'physics' | 'motion' | 'attach'>>;
  ensurePhysics?(): Promise<void>;
  onKernel(kernel: CoreKernel): void;
  /** the render joins the default renderer reads (StaticRaycaster, MixerHost, X-42 proxies, the model links) */
  readonly raycaster?: { castDown(origin: { x: number; y: number; z: number }, maxDist: number): { y: number; normal: { x: number; y: number; z: number } } | null };
  readonly mixer?: { bind(instance: unknown): void; update(frame: never): void };
  setVisualProxies?(place: string, soup: never): void;
  attachRenderer?(links: { model(rowId: string): unknown; rigFrame(rowId: string): ArrayLike<number> | null } | null): void;
  dispose(): void;
}

/** what the wiring is given */
export interface ShellWiringEnv {
  /** the eye of the last presented camera pose; null before the first */
  eye(): { x: number; y: number; z: number } | null;
  /** the asset resolver and geometry service, when the composition made them (a 'default' renderer or wiring) */
  assets?: AssetResolver;
  geometry?: GeometryService;
}

/** the engine-free objects the renderer and the wiring share (made when either is 'default') */
export interface ShellRenderEnv {
  assets: AssetResolver;
  geometry: GeometryService;
  /** K3: the rig cache, made when `rigs: true` */
  rigs?: ScriptRigs;
}

/** what a renderer hands the shell once it exists */
export interface ShellRenderer {
  /** the render side's scene port; the deferred port replays into it */
  scene: SceneSyncPort;
  /** its animation loop carries the frame step from now on */
  loop?: FrameRenderer;
  dispose?(): void;
}

/** the pointer-lock manager made for `input.pointerLock: true` / an options object (runtime/input/pointer-lock.ts) */
export type ComposePointerLock = Pick<PointerLockOptions, 'rawMouse' | 'enabled'>;

/** `input.touch`: the touch layer (runtime/input/touch); it mounts only where the device has touch points */
export interface ComposeTouchOptions {
  /** what the layer draws and drives; default PP's scheme (a game passes its own, e.g. from `inputs.touch.surfaces`) */
  scheme?: TouchScheme;
  /** the per-frame state the layer reads (modal, prompt, ...); default none */
  read?: () => TouchFrameState;
  /** where the controls go; default the UI container, else the canvas's parent */
  container?: HTMLElement;
  maxTouchPoints?: () => number;
  /** the class of the layer's root element; default `ss-touch-controls` (PP) */
  rootClass?: string;
  /**
   * Opt-in, default false (PP): the layer root takes no pointer events (only the controls do), so it never covers the HUD beside it;
   * the stick / look / tap gestures are read on the canvas instead (TouchLayerOptions.surface).
   */
  passThrough?: boolean;
}

/** `ComposeGameOptions.input`: everything opt-in, the default reproduces the current composition (keyboard and mouse on the canvas) */
export interface ComposeInputOptions {
  /** buildInputMap / InputLog options: `dataChannels`, `arrowAliases`, `wheelNotch` */
  map?: InputMapOptions;
  look?: import('../runtime/input/look.ts').LookOptions;
  /** a PointerLockManager on the canvas (click to lock, `sendAction(..., { relockPointer })`); `true` = defaults; default none */
  pointerLock?: boolean | ComposePointerLock;
  /** look deltas while the pointer is not locked: 'rightDrag' = a right-drag orbit; default none */
  unlockedLook?: 'rightDrag' | false;
  /** the touch layer; `true` = PP's scheme; default none */
  touch?: boolean | ComposeTouchOptions;
  /** the canvas rect the touch gesture pointer is measured in; default the canvas's bounding rect */
  pointerSpace?: () => { left: number; top: number; width: number; height: number };
}

/** `ComposeGameOptions.profile`: how the human body is named (the platform's player id is `<idPrefix><id>`) */
export interface ComposeProfileOptions {
  /** the display name of a player the platform names nothing for; default `Operator` (the engine's) */
  defaultName?: string;
  /** prefix of an authorised platform id in the body's `userId`; default '' (PP's own composition uses `pg-`) */
  idPrefix?: string;
}

/**
 * ComposeGameOptions.render: the opt-in render side in one object. The flags reach installGame's deps (GameDeps); vertexColors
 * and rigs also configure the geometry service. Default: none of it (PP).
 */
export interface ComposeRenderOptions extends RenderFlags {
  /** K3 procedural rigs (the same as the top-level rigs) */
  rigs?: boolean;
  /**
   * The geometry workers' entry, for a game whose generators are served by its own worker (`serveGeneratorModules`): a module URL
   * (started as `new Worker(url, { type: 'module' })`) or a factory returning the Worker. Default: the stock `geometry-worker.ts` (PP).
   * The pool, `rigs` and `vertexColors` are the same as with the stock worker.
   */
  geometryWorker?: URL | (() => WorkerLike);
  /** albedo tints for the geometry workers (`PoolOptions.albedoTints`, `measureAlbedoTints`); works with the stock worker and with `geometryWorker`. Default absent (PP) */
  albedoTints?: PoolOptions['albedoTints'];
}

/** ComposeGameOptions.boot: the opt-in kernel boot options in one object (BootEnv); seed and start win over the top-level ones */
export interface ComposeBootOptions {
  /** load the actors preload set (BootEnv.actors) */
  actors?: BootEnv['actors'];
  preloadSets?: BootEnv['preloadSets'];
  homePlace?: BootEnv['homePlace'];
  readHome?: BootEnv['readHome'];
  fallbackPlace?: BootEnv['fallbackPlace'];
  residentPlaces?: BootEnv['residentPlaces'];
  preroll?: BootEnv['preroll'];
  worldId?: BootEnv['worldId'];
  ids?: BootEnv['ids'];
  /** the runtime collider producer behind ports.assets.placeBake (BootEnv.placeBake) */
  placeBake?: BootEnv['placeBake'];
  seed?: number;
  /** default 'defaultPlace' */
  start?: BootEnv['start'];
}

/** ComposeGameOptions.camera: opt-in options of the rig host (RigHostDeps) */
export interface ComposeCameraOptions {
  /** R-1: the rig orients the camera through its row's `rotation` (`{ lookAt, include }`) instead of `state.yaw / pitch`; default false = PP */
  orientationFromRow?: boolean;
}

export interface ComposeGameOptions {
  /** the game's slug: the save prefix (`<slug>:`) and log tag */
  slug: string;
  canvas: HTMLCanvasElement | null;
  /** the UI container; null = no UI host */
  uiContainer?: HTMLElement | null;
  /** the carried UI module (world.config `ui.render`), loaded; null = no UI host */
  gameUi?: unknown;
  /** UiHostConfig; default `{ globals: 'auto' }` and the host's own defaults */
  ui?: UiHostConfig;
  /** the build's world; default the `virtual:ss/*` modules (compat/core/boot/world.ts) */
  world?: BootWorld;
  /**
   * default: the web platform with local save under `<slug>:`. A Platform object is used as is; the strings pick an adapter
   * ('web' = the default; 'playgama' = the Playgama Bridge adapter, see platform-playgama/)
   */
  platform?: Platform | 'web' | 'playgama';
  /**
   * The ad-break channel (shell/ad-break.ts): the game emits the `adBreak` uiEvent (or page code calls `window.__ssBreak`), the shell
   * runs the ad, mutes and pauses, and answers in `ctx.session.adBreak`. Default off; on with `platform: 'playgama'`; `false` turns
   * it off there. It switches `ext.pauseFreezesClock` on unless the game's bag says otherwise.
   */
  adBreaks?: boolean | AdBreakOptions;
  /**
   * Dev fake ads on the web platform (shell/fake-ads.ts): 'show', 'fail' (no fill), or 'query' = per the page's `?fakeAds=1|fail`.
   * Default none: every ad reports `disabled`. Ignored for 'playgama' (the Bridge has its own mock host).
   */
  fakeAds?: 'show' | 'fail' | 'query';
  /** P-5: `session.viewport`, the `--ss-safe-*` / `--ss-aspect` CSS variables on the UI container, viewport-fit=cover; default off, never headless */
  viewport?: boolean | ViewportOptions;
  /** DurableState options (save key, `durableKeys`, debounce); default PP's `ss_save_v1` document */
  durable?: DurableOptions;
  /** the human body's identity; default the engine's (`pg-<id>`, `Operator`) with idPrefix '' */
  profile?: ComposeProfileOptions;
  /** keyboard / mouse / pointer lock / touch; default keyboard and mouse only */
  input?: ComposeInputOptions;
  /** the rig host's opt-in options (see ComposeCameraOptions); default none = PP */
  camera?: ComposeCameraOptions;
  /** kernel extensions, merged key by key over the shell's defaults (and over `extensions`); the same bag as `extensions` */
  ext?: KernelExtensions;
  ports?: { sql?: SqlPort; jobs?: JobPort; /** the gate passed to `createJobHost({ pause })`: the shell sets it while the host holds the clock, so job deadlines count game time */ jobPause?: JobPauseGate; music?: MusicPort; sqlWorldId?: string; sqlStores?: HostSqlStores };
  /** the game-supplied kernel extensions; laid over the shell's defaults (see DEFAULT_SHELL_EXTENSIONS) */
  extensions?: KernelExtensions;
  /** physics/nav/motion; default none: the kernel's null ports */
  /** 'default': default-wiring.ts (Rapier physics, nav, motion with the anim host over the cooked anim files) */
  wiring?: ((env: ShellWiringEnv) => ShellWiring) | 'default';
  /** 'default' wiring options */
  wiringOptions?: DefaultWiringOptions;
  /**
   * The render engine; default none (headless, or a game that installs its own later through `app.attachRenderer`).
   * 'default': the runtime's renderer with the game installed on it (default-renderer.ts); needs `canvas` and `content`.
   */
  renderer?: ((app: GameApp) => Promise<ShellRenderer | null>) | 'default';
  /** 'default' renderer options (lighting module, dev, engine seam) */
  rendererOptions?: DefaultRendererOptions;
  /** the asset index (the `virtual:ss/asset-index` default export); default an empty index */
  assetIndex?: unknown;
  /** the carried content scripts (`virtual:ss/content`'s `content` map, or a loader); the default renderer loads the lighting module with it */
  content?: ContentLoader | Readonly<Record<string, () => Promise<unknown>>>;
  /**
   * K3 procedural rigs (opt-in, default false = PP): the default wiring makes RigMixers and installs the `bones` channel,
   * the geometry workers run `skeleton()`, and the default renderer hands a ScriptRigs to the render bridge.
   */
  rigs?: boolean;
  /** opt-in render flags and rigs as one object (see ComposeRenderOptions); render.rigs is the same as rigs */
  render?: ComposeRenderOptions;
  /** opt-in boot options as one object (see ComposeBootOptions) */
  boot?: ComposeBootOptions;
  /** extra options of the geometry service made for a 'default' renderer or wiring (`createBrowserGeometryService`), e.g. render flags as they appear */
  geometry?: Record<string, unknown>;
  /** the audio quality tier handed to `audio.init` (default 'high') */
  audioOptions?: Omit<import('../runtime/audio/types.ts').AudioEngineOptions, 'manifest' | 'tier'>;
  audioTier?: 'low' | 'medium' | 'high';
  seed?: number;
  /** BootEnv.start; default 'defaultPlace' (no Director pre-roll: the body stands in the world config's defaultPlace) */
  start?: BootEnv['start'];
  headless?: boolean;
  onProgress?: BootEnv['onProgress'];
  /** test seam: the pieces; default the runtime's modules */
  parts?: Partial<ShellParts>;
}

export interface ShellParts {
  platform(o: { slug: string; headless: boolean; kind: 'web' | 'playgama'; saveKeys: readonly string[]; defaultName: string; fakeAds: 'show' | 'fail' | null }): Platform | Promise<Platform>;
  /** the DurableState over the platform's save, when `durable` options are given */
  durable(o: { platform: Platform; options: DurableOptions }): DurableState | Promise<DurableState>;
  audio(o: { headless: boolean }): ShellAudio | Promise<ShellAudio>;
  input(o: { inputs: unknown; canvas: HTMLCanvasElement | null; uiRoot: HTMLElement | null; options: ComposeInputOptions; headless: boolean }): ShellInput | Promise<ShellInput>;
  camera(o: { input: ShellInput; audio: ShellAudio; options: ComposeCameraOptions }): ShellCamera | Promise<ShellCamera>;
  scene(): ShellScene | Promise<ShellScene>;
  ui(o: { container: HTMLElement; gameUi: unknown; config: UiHostConfig; input: ShellInput; kernel: () => CoreKernel | null }): ShellUi | Promise<ShellUi>;
  extensions(o: { ports: NonNullable<ComposeGameOptions['ports']>; game: KernelExtensions | undefined }): KernelExtensions | Promise<KernelExtensions>;
  boot(env: BootEnv): Promise<BootResult>;
  /** pause controller, act routing, entity audio, frame driver: everything that needs the kernel before its first tick */
  attach(o: { kernel: CoreKernel; platform: Platform; audio: ShellAudio; ui: ShellUi; camera: ShellCamera; input: ShellInput; headless: boolean; jobPause?: JobPauseGate }): FrameHost | Promise<FrameHost>;
  /** the asset resolver and geometry service a 'default' renderer or wiring shares */
  renderEnv(o: { assetIndex: unknown; rigs?: boolean; vertexColors?: boolean; albedoTints?: PoolOptions['albedoTints']; geometry?: Record<string, unknown>; geometryWorker?: URL | (() => WorkerLike) }): ShellRenderEnv | Promise<ShellRenderEnv>;
  /** `audio.init({ manifest, tier })` over the asset index (made when a 'default' renderer or wiring built the resolver) */
  audioInit(o: { audio: ShellAudio; assets: AssetResolver; tier: 'low' | 'medium' | 'high'; options?: ComposeGameOptions['audioOptions'] }): void | Promise<void>;
  /** the 'default' wiring */
  defaultWiring(env: ShellWiringEnv, options: DefaultWiringOptions): Promise<ShellWiring>;
  /** the 'default' renderer */
  defaultRenderer(o: { app: GameApp; env: ShellRenderEnv; content: ContentLoader; options: DefaultRendererOptions }): Promise<ShellRenderer>;
  /** the world config of `world` (for the input map) */
  worldConfig(world: BootWorld | undefined): Promise<unknown>;
}

export interface FrameHost {
  driver: FrameDriver;
  /** the act wiring (the renderer registers its acts on it) */
  acts?: ActWiring;
  dispose(): void;
}

export interface GameApp {
  readonly slug: string;
  readonly platform: Platform;
  readonly kernel: CoreKernel;
  readonly boot: BootResult;
  readonly audio: ShellAudio;
  readonly input: ShellInput;
  readonly camera: ShellCamera;
  readonly scene: ShellScene;
  readonly ui: ShellUi | null;
  readonly extensions: KernelExtensions;
  readonly driver: FrameDriver;
  readonly canvas: HTMLCanvasElement | null;
  readonly acts: ActWiring | null;
  readonly wiring: ShellWiring | null;
  /** made when the renderer or the wiring is 'default' */
  readonly renderEnv: ShellRenderEnv | null;
  /** the ad-break channel, when it is on (`adBreaks`, or `platform: 'playgama'`) */
  readonly adBreaks: AdBreaks | null;
  /** P-5, when `viewport` asked for it */
  readonly viewport: ViewportHandle | null;
  /** the composition steps, in the order they ran */
  readonly steps: readonly ShellStep[];
  /** the attached renderer (a 'default' one is a DefaultRenderer: `.renderer` is the facade, `.world` the game on it) */
  readonly renderer: ShellRenderer | null;
  /** hands the shell a renderer made later (the deferred scene replays into it, its loop takes the frame step) */
  attachRenderer(r: ShellRenderer): void;
  dispose(): void;
}

/**
 * The engine defaults a converted game gets (Spawn's documented behaviour); PP passes no extensions, so its own composition
 * keeps PP's. The game's bag wins key by key.
 */
export const DEFAULT_SHELL_EXTENSIONS: Readonly<KernelExtensions> = Object.freeze({
  simCadence: 'any',
  changed: true,
  gravitySetter: true,
  music: true,
  capabilities: { absentAsUndefined: true },
});

/** the shell's defaults, the game's bag, and the port-backed verbs (an explicit `sql` / `jobs` / `music` in the bag wins) */
export function mergeExtensions(game: KernelExtensions | undefined, fromPorts: Pick<KernelExtensions, 'sql' | 'jobs' | 'music'>): KernelExtensions {
  const out: KernelExtensions = { ...DEFAULT_SHELL_EXTENSIONS, ...fromPorts, ...(game ?? {}) };
  out.capabilities = { ...DEFAULT_SHELL_EXTENSIONS.capabilities, ...(game?.capabilities ?? {}) };
  for (const k of ['sql', 'jobs', 'music'] as const) if (game?.[k] === undefined && fromPorts[k] !== undefined) (out as Record<string, unknown>)[k] = fromPorts[k];
  return out;
}

/** the fake-ads mode to build the web platform with: 'query' reads the page's `?fakeAds=`; never in a headless composition */
function fakeAdsMode(mode: ComposeGameOptions['fakeAds'], headless: boolean): 'show' | 'fail' | null {
  if (mode === undefined || headless) return null;
  if (mode !== 'query') return mode;
  const search = typeof location === 'undefined' ? '' : location.search;
  const v = new URLSearchParams(search).get('fakeAds');
  return v === '1' || v === 'true' || v === 'show' ? 'show' : v === 'fail' ? 'fail' : null;
}

/** `ext` over `extensions`, key by key (the `capabilities` bag too) */
export function mergeGameExtensions(a: KernelExtensions | undefined, b: KernelExtensions | undefined): KernelExtensions | undefined {
  if (a === undefined || b === undefined) return a ?? b;
  return { ...a, ...b, capabilities: { ...(a.capabilities ?? {}), ...(b.capabilities ?? {}) } };
}

export const DEFAULT_PROFILE_NAME = 'Player';

/**
 * `profile.defaultName`: a player the platform names nothing for is called this (the engine's boot says `Operator`). A guest
 * stays a device-id player. Wraps `getUser` only; everything else is the platform itself.
 */
export function withProfile(platform: Platform, profile: ComposeProfileOptions | undefined): Platform {
  if (typeof (platform as Partial<Platform>).getUser !== 'function') return platform;
  const fallback = profile?.defaultName ?? DEFAULT_PROFILE_NAME;
  const getUser: Platform['getUser'] = async () => {
    const user = await platform.getUser();
    if (user === null) return { id: null, name: fallback, loggedIn: false };
    return typeof user.name === 'string' && user.name.trim() !== '' ? user : { ...user, name: fallback };
  };
  return new Proxy(platform, {
    get(target, key) {
      if (key === 'getUser') return getUser;
      const v = Reflect.get(target, key, target) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}

const NULL_UI: ShellUi = {
  uiPort: () => ({ markDirty() {}, uiEvent() {} }),
  mount() {},
  frame() {},
  coversScene: () => false,
  onFirstInteractiveFrame: (cb) => cb(),
  dispose() {},
};

declare const __SS_PLATFORM__: 'playgama' | 'web' | undefined;
/** true where the build defines `__SS_PLATFORM__` as playgama: the web adapter (and its localStorage) is then dead code */
const PLAYGAMA_BUILD = typeof __SS_PLATFORM__ !== 'undefined' && __SS_PLATFORM__ === 'playgama';

/** the runtime's own pieces, imported when first used (none of them is loaded by a test that passes fakes) */
export const defaultParts: ShellParts = {
  async platform({ slug, headless, kind, saveKeys, defaultName, fakeAds }) {
    if (kind === 'playgama') {
      const { createPlaygamaPlatform } = await import('../platform-playgama/index.ts');
      return createPlaygamaPlatform({ saveKeys, defaultName });
    }
    if (PLAYGAMA_BUILD) throw new Error('composeGame: the web platform is not part of a Playgama build');
    const { createWebPlatform } = await import('./web-platform.ts');
    const fake = fakeAds ? await import('./fake-ads.ts') : null;
    return createWebPlatform({
      storagePrefix: `${slug}:`,
      ...(headless ? { window: null } : {}),
      ...(fakeAds && fake ? { ads: (host) => fake.createFakeAds(host, { mode: fakeAds }) } : {}),
    });
  },
  async durable({ platform, options }) {
    const { DurableState } = await import('../compat/core/save/durable.ts');
    return new DurableState(platform.save, options);
  },
  async audio({ headless }) {
    const [{ createAudioEngine }, { installUnlock }] = await Promise.all([import('../runtime/audio/audio-engine.ts'), import('../runtime/audio/unlock.ts')]);
    const engine = createAudioEngine();
    if (!headless) {
      const unlock = installUnlock(engine);
      const dispose = engine.dispose?.bind(engine);
      (engine as { dispose?: () => void }).dispose = () => (unlock.dispose(), dispose?.());
    }
    return engine as unknown as ShellAudio;
  },
  async input({ inputs, canvas, uiRoot, options, headless }) {
    const [{ createInputPort }, { buildInputMap }, { installKeyboardMouse }, { Look }] = await Promise.all([
      import('../runtime/input/action-sink.ts'),
      import('../runtime/input/input-map.ts'),
      import('../runtime/input/keyboard-mouse.ts'),
      import('../runtime/input/look.ts'),
    ]);
    type Inputs = Parameters<typeof buildInputMap>[0];
    const mapOptions = options.map;
    const stack = createInputPort({ ...(options.look ? {look:new Look({},options.look)}:{}), map: buildInputMap((inputs ?? {}) as Inputs, undefined, mapOptions), ...(mapOptions ? { options: mapOptions } : {}) });
    const undo: Array<() => void> = [];
    // headless: no page, so no sources on it
    const page = canvas !== null && !headless ? canvas : null;
    let lock: ShellInput['lock'] = null;
    if (page !== null && options.pointerLock) {
      const { PointerLockManager } = await import('../runtime/input/pointer-lock.ts');
      const o = options.pointerLock === true ? {} : options.pointerLock;
      const manager = new PointerLockManager({ canvas: page, touchActive: () => stack.log.touchActive, ...(o.rawMouse !== undefined ? { rawMouse: o.rawMouse } : {}), ...(o.enabled !== undefined ? { enabled: o.enabled } : {}) });
      stack.sink.setPointer(manager);
      undo.push(() => manager.dispose());
      lock = manager;
    }
    const kbm = page ? installKeyboardMouse(stack.log, page, { ...(uiRoot ? { uiRoot } : {}), ...(options.unlockedLook ? { unlockedLook: options.unlockedLook } : {}), ...(lock ? { isLocked: () => lock?.state === 'locked' } : {}) }) : null;
    if (kbm) undo.push(() => kbm.dispose());
    let touch: ShellInput['touch'] = null;
    if (page !== null && options.touch) {
      const { TouchLayer } = await import('../runtime/input/touch/touch-layer.ts');
      const t = options.touch === true ? {} : options.touch;
      const container = t.container ?? uiRoot ?? page.parentElement;
      if (container) {
        const layer = new TouchLayer({
          container,
          input: stack.log as never,
          read: t.read ?? (() => ({})),
          pointerSpace: options.pointerSpace ?? (() => page.getBoundingClientRect()),
          ...(t.scheme ? { scheme: t.scheme } : {}),
          ...(t.maxTouchPoints ? { maxTouchPoints: t.maxTouchPoints } : {}),
          ...(t.rootClass ? { rootClass: t.rootClass } : {}),
          ...(t.passThrough ? { surface: page } : {}),
        });
        undo.push(() => layer.dispose());
        touch = layer;
      }
    }
    return { port: stack.port as unknown as KernelPorts['input'], sink: stack.sink, log: stack.log, lock, touch, dispose: () => undo.reverse().forEach((f) => f()) };
  },
  async camera({ input, audio, options }) {
    const [{ createPresentationClock }, { createCameraPresenter }, { createRigHost }] = await Promise.all([
      import('./presentation-clock.ts'),
      import('../runtime/camera/camera-presenter.ts'),
      import('../runtime/camera/rig-host.ts'),
    ]);
    type RigDeps = Parameters<typeof createRigHost>[0];
    const presentation = createPresentationClock();
    const presenter = createCameraPresenter();
    const log = input.log as RigDeps['input'] & { look: RigDeps['look'] };
    const rig = createRigHost({ look: log.look, input: log, presenter, audio: audio as unknown as NonNullable<RigDeps['audio']>, ...(options.orientationFromRow === true ? { orientationFromRow: true } : {}) });
    return { presentation, presenter, rig } as unknown as ShellCamera;
  },
  async scene() {
    const { DeferredScenePort } = await import('./deferred-scene-port.ts');
    return new DeferredScenePort() as unknown as ShellScene;
  },
  async ui({ container, gameUi, config, input, kernel }) {
    const { UiHost } = await import('../runtime/ui/ui-host.ts');
    type Deps = ConstructorParameters<typeof UiHost>[2];
    const host = new UiHost(container, gameUi as ConstructorParameters<typeof UiHost>[1], {
      runtime: {
        createUiCtx: () => {
          const k = kernel();
          if (k === null) throw new Error('composeGame: the UI rendered before the kernel exists');
          return k.createUiCtx();
        },
      },
      actions: input.sink as Deps['actions'],
      config,
    });
    return host as unknown as ShellUi;
  },
  async extensions({ ports, game }) {
    const bind = await import('../ports/bind/index.ts');
    return mergeExtensions(game, {
      ...(ports.sql ? { sql: bind.createSqlExtension({ port: ports.sql, ...(ports.sqlWorldId ? { worldId: ports.sqlWorldId } : {}) }) } : {}),
      ...(ports.jobs ? { jobs: bind.createJobExtension({ port: ports.jobs }) } : {}),
      ...(ports.music ? { music: ports.music as NonNullable<KernelExtensions['music']> } : {}),
    });
  },
  async boot(env) {
    const { bootKernel } = await import('../compat/core/boot/boot.ts');
    return bootKernel(env);
  },
  async attach({ kernel, platform, audio, ui, camera, input, headless, jobPause }) {
    const [{ PauseController }, { wireActs }, { installEntityAudioHost }, { createFrameDriver }] = await Promise.all([
      import('../platform/pause-controller.ts'),
      import('./act-wiring.ts'),
      import('./entity-audio-host.ts'),
      import('./frame.ts'),
    ]);
    const undo: (() => void)[] = [];
    const pause = new PauseController(kernel.clock, audio as unknown as ConstructorParameters<typeof PauseController>[1]);
    undo.push(() => pause.dispose());
    pause.bindPlatform(platform as unknown as Parameters<typeof pause.bindPlatform>[0]);
    if (!headless && typeof document !== 'undefined' && typeof window !== 'undefined') pause.bindPage({ document, window } as unknown as Parameters<typeof pause.bindPage>[0]);
    undo.push(kernel.on('paused', () => pause.refresh()));
    // job deadlines count game time: the gate is set while a host reason (platform, ad, hidden, overlay, orientation, gpu, test) holds the clock
    if (jobPause) {
      const hostHeld = (): boolean => [...pause.reasons].some((r) => (HOST_PAUSE_REASONS as readonly string[]).includes(r));
      jobPause.set(hostHeld());
      undo.push(pause.onChange(() => jobPause.set(hostHeld())));
    }
    // P-1: the game sees a platform / hidden-tab hold as `ctx.session.hostPaused`
    if (kernel.vms) undo.push(bindHostPaused(() => Object.values(kernel.vms).map((vm) => vm.session), pause, extOf(kernel).hostPausedLinger ? { linger: { afterTick: (fn) => kernel.on('tickEnd', fn) } } : {}));
    const acts = wireActs({ kernel: kernel as never, audio, ui: ui.uiPort(), presentation: camera.presentation, trophies: { unlock: () => false } });
    undo.push(() => acts.dispose());
    const entityAudio = installEntityAudioHost(kernel, audio as never);
    undo.push(() => entityAudio.dispose());
    const driver = createFrameDriver({
      kernel,
      rig: camera.rig,
      presentation: camera.presentation as never,
      audio: { frame: () => { entityAudio.frame(); audio.frame(); } },
      ui,
      platform,
      ...(input.touch ? { touch: () => input.touch ?? null } : {}),
      // headless: no page, so no requestAnimationFrame chain; the caller steps the driver (`app.driver.step(t)`)
      ...(headless ? { clock: { requestAnimationFrame: () => 0, cancelAnimationFrame: () => {} } } : {}),
    });
    undo.push(() => driver.stop());
    return { driver, acts, dispose: () => undo.reverse().forEach((f) => f()) };
  },
  async audioInit({ audio, assets, tier, options }) {
    if (!audio.init) return;
    const { manifestFromIndex } = await import('../runtime/audio/clip-registry.ts');
    audio.init({ ...options, manifest: manifestFromIndex(assets) as never, tier });
  },
  async renderEnv({ assetIndex, rigs, vertexColors, albedoTints, geometry, geometryWorker }) {
    const [{ installAssetIndex }, geometryModule] = await Promise.all([import('../assets/resolver.ts'), import('../render/geometry/geometry-service.ts')]);
    const { createBrowserGeometryService } = geometryModule;
    const assets = installAssetIndex(assetIndex ?? EMPTY_ASSET_INDEX);
    const service = { ...(geometry ?? {}), ...(vertexColors ? { vertexColors: true } : {}), ...(albedoTints ? { albedoTints } : {}) };
    const makeService = (extra: Record<string, unknown>): GeometryService => (geometryWorker ? createGeometryServiceWithWorker(geometryModule, geometryWorker, { ...service, ...extra }) : createBrowserGeometryService({ ...service, ...extra }));
    if (!rigs) return { assets, geometry: makeService({}) };
    const { ScriptRigs } = await import('../render/rig/script-rigs.ts');
    return { assets, geometry: makeService({ rigs: true }), rigs: new ScriptRigs() };
  },
  async defaultWiring(env, options) {
    const { createDefaultWiring } = await import('./default-wiring.ts');
    return createDefaultWiring(env, options);
  },
  async defaultRenderer({ app, env, content, options }) {
    if (app.canvas === null) throw new Error('composeGame: renderer "default" needs a canvas');
    const { createDefaultRenderer } = await import('./default-renderer.ts');
    return createDefaultRenderer(
      {
        canvas: app.canvas,
        kernel: app.kernel,
        acts: app.acts,
        presenter: app.camera.presenter,
        presentation: app.camera.presentation as never,
        assets: env.assets,
        geometry: env.geometry,
        content,
        wiring: app.wiring as never,
        deviceType: app.platform.device.type as never,
        sceneHidden: () => app.ui?.coversScene() ?? false,
      },
      options,
    );
  },
  async worldConfig(world) {
    if (world) return world.worldConfig;
    throw new Error('composeGame requires world; pass a BootWorld or use the Vite virtual:ss/world adapter');
  },
};

/** an asset index with nothing in it (v1) */
export const EMPTY_ASSET_INDEX = Object.freeze({ v: 1, build: '', origin: '', entries: {}, groups: {}, facts: {} });

/** a content map (`virtual:ss/content`) or loader as a ContentLoader */
export function contentLoader(content: ComposeGameOptions['content']): ContentLoader {
  if (typeof content === 'function') return content;
  const map = content ?? {};
  return async (path) => {
    const load = Object.hasOwn(map, path) ? map[path] : undefined;
    if (load === undefined) throw new Error(`no carried content script ${path}`);
    return (await load()) as Record<string, unknown>;
  };
}

/** the default renderer's options: the game's, with the rig cache of a `rigs: true` composition (an explicit `rendererOptions.rigs` wins) */
function rendererOptionsFor(options: ComposeGameOptions, env: ShellRenderEnv | null): DefaultRendererOptions {
  const given = options.rendererOptions ?? {};
  const { rigs: _rigs, geometryWorker: _worker, albedoTints: _tints, ...flags } = options.render ?? {};
  const merged: DefaultRendererOptions = Object.keys(flags).length > 0 ? { ...given, flags: { ...flags, ...(given.flags ?? {}) } } : given;
  return env?.rigs && merged.rigs === undefined ? { ...merged, rigs: env.rigs } : merged;
}

type GeometryModule = typeof import('../render/geometry/geometry-service.ts');

/** the browser geometry service (same pool sizing and options as `createBrowserGeometryService`) over a game-supplied worker entry */
function createGeometryServiceWithWorker(m: GeometryModule, worker: URL | (() => WorkerLike), opts: Record<string, unknown>): GeometryService {
  const o = opts as BrowserGeometryOptions;
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 4;
  const size = o.workers ?? m.geometryWorkerBudget(cores).geometry;
  const { workers: _w, strict, rigs, vertexColors, albedoTints, ...rest } = o;
  const spawn = typeof worker === 'function' ? worker : (): WorkerLike => new (globalThis as unknown as { Worker: new (url: URL, opts: { type: 'module'; name: string }) => WorkerLike }).Worker(worker, { type: 'module', name: 'ss-geometry' });
  return new m.GeometryServiceImpl({ ...rest, executor: new m.WorkerPoolExecutor(spawn, size, { strict: strict ?? false, ...(rigs ? { rigs: true } : {}), ...(vertexColors ? { vertexColors: true } : {}), ...(albedoTints ? { albedoTints } : {}) }) });
}

const wantsRigs = (options: ComposeGameOptions): boolean => options.rigs === true || options.render?.rigs === true;

/** the arguments of parts.renderEnv: rigs from either spelling, vertexColors for the geometry workers */
function renderEnvArgs(options: ComposeGameOptions): Parameters<ShellParts['renderEnv']>[0] {
  return {
    assetIndex: options.assetIndex,
    ...(wantsRigs(options) ? { rigs: true } : {}),
    ...(options.render?.vertexColors ? { vertexColors: true } : {}),
    ...(options.geometry ? { geometry: options.geometry } : {}),
    ...(options.render?.albedoTints ? { albedoTints: options.render.albedoTints } : {}),
    ...(options.render?.geometryWorker ? { geometryWorker: options.render.geometryWorker } : {}),
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export async function composeGame(options: ComposeGameOptions): Promise<GameApp> {
  const parts: ShellParts = { ...defaultParts, ...(options.parts ?? {}) };
  const steps: ShellStep[] = [];
  const undo: (() => void)[] = [];
  const step = (s: ShellStep): void => void steps.push(s);
  try {
    step('platform');
    const headless = options.headless === true;
    const adBreaksOn = options.adBreaks === undefined ? options.platform === 'playgama' : options.adBreaks !== false;
    let adBreaks: AdBreaks | null = null;
    let viewport: ViewportHandle | null = null;
    const platform = withProfile(
      typeof options.platform === 'object'
        ? options.platform
        : await parts.platform({
            slug: options.slug,
            headless,
            kind: options.platform ?? 'web',
            saveKeys: [
              options.durable?.key ?? 'ss_save_v1',
              options.durable?.backupKey ?? `${options.durable?.key ?? 'ss_save_v1'}_bad`,
              ...(options.ports?.sqlStores && options.ports.sqlWorldId ? options.ports.sqlStores.keysFor(options.ports.sqlWorldId) : []),
            ],
            defaultName: options.profile?.defaultName ?? DEFAULT_PROFILE_NAME,
            fakeAds: fakeAdsMode(options.fakeAds, headless),
          }),
      options.profile,
    );
    // SQL stores follow the platform: Playgama keeps the database in its save API, the web keeps the browser store
    const sqlStores = options.ports?.sqlStores;
    if (sqlStores) {
      sqlStores.bind(platform.id === 'playgama' ? platform.save : null);
      undo.push(() => void sqlStores.flush().catch(() => undefined));
    }
    step('audio');
    const audio = await parts.audio({ headless });
    undo.push(() => audio.dispose?.());
    step('input');
    const worldConfig = await parts.worldConfig(options.world);
    const input = await parts.input({ inputs: isRecord(worldConfig) ? worldConfig['inputs'] : undefined, canvas: options.canvas, uiRoot: options.uiContainer ?? null, options: options.input ?? {}, headless });
    undo.push(() => input.dispose());
    step('camera');
    const camera = await parts.camera({ input, audio, options: options.camera ?? {} });
    step('scene');
    const scene = await parts.scene();
    let kernel: CoreKernel | null = null;
    step('ui');
    const ui =
      options.uiContainer && options.gameUi
        ? await parts.ui({ container: options.uiContainer, gameUi: options.gameUi, config: { globals: 'auto', ...(options.ui ?? {}) }, input, kernel: () => kernel })
        : null;
    if (ui) undo.push(() => ui.dispose());
    step('extensions');
    const extensions = await parts.extensions({ ports: options.ports ?? {}, game: adBreaksOn ? { pauseFreezesClock: true, ...(mergeGameExtensions(options.extensions, options.ext) ?? {}) } : mergeGameExtensions(options.extensions, options.ext) });
    const renderEnv = options.renderer === 'default' || options.wiring === 'default' ? await parts.renderEnv(renderEnvArgs(options)) : null;
    if (renderEnv) await parts.audioInit({ audio, assets: renderEnv.assets, tier: options.audioTier ?? 'high', ...(options.audioOptions ? {options:options.audioOptions}:{}) });
    const wiringEnv: ShellWiringEnv = { eye: () => camera.presenter.last?.eye ?? null, ...(renderEnv ?? {}) };
    const wiring = options.wiring === 'default' ? await parts.defaultWiring(wiringEnv, { ...(options.wiringOptions ?? {}), ...(wantsRigs(options) ? { rigs: true } : {}) }) : (options.wiring?.(wiringEnv) ?? null);
    if (wiring) undo.push(() => wiring.dispose());

    step('kernel');
    const seed = options.boot?.seed ?? options.seed;
    let frame: FrameHost | null = null;
    if (!options.world && parts.boot === defaultParts.boot) throw new Error('composeGame requires world');
    const boot = await parts.boot({
      ...options.boot,
      ...(options.profile ? {profile:options.profile}:{}),
      platform,
      canvas: options.canvas,
      ...(options.headless !== undefined ? { headless: options.headless } : {}),
      ...(options.durable ? { durable: await parts.durable({ platform, options: options.durable }) } : {}),
      ...(seed !== undefined ? { seed } : {}),
      start: options.boot?.start ?? options.start ?? 'defaultPlace',
      ...(options.boot?.actors !== undefined ? { actors: options.boot.actors } : {}),
      ...(options.boot?.placeBake !== undefined ? { placeBake: options.boot.placeBake } : {}),
      // A custom boot part may supply its own world; the default boot is guarded above.
      world: options.world!,
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
      ports: { ...(wiring?.ports ?? {}), scene, input: input.port, camera: camera.rig, ui: adBreaksOn ? adBreakUiPort((ui ?? NULL_UI).uiPort(), () => adBreaks) : (ui ?? NULL_UI).uiPort() },
      ext: extensions,
      onKernel: async (k) => {
        step('onKernel');
        kernel = k;
        camera.rig.attach(k);
        wiring?.onKernel(k);
        const sessions = (): Record<string, unknown>[] => Object.values(k.vms).map((vm) => vm.session);
        if (adBreaksOn) {
          const o = typeof options.adBreaks === 'object' ? options.adBreaks : {};
          // the break holds the clock (reason `ad`) from its request to its answer, not just while the platform's ad is open
          const clock = (k as { clock?: { pause(r: 'ad'): void; resume(r: 'ad'): void } }).clock;
          const hold = clock ? (on: boolean): void => (on ? clock.pause('ad') : clock.resume('ad')) : undefined;
          const channel = new AdBreaks({ platform, sessions, ui: ui?.uiPort() ?? null, ...(hold ? { hold } : {}) }, o);
          adBreaks = channel;
          undo.push(() => channel.dispose());
          if (!headless && o.pageApi !== false && typeof window !== 'undefined') undo.push(installAdBreakPageApi(window as unknown as PageApiTarget, { breaks: channel, platform, slug: options.slug }));
        }
        if (options.viewport && !headless && typeof window !== 'undefined') {
          const o = typeof options.viewport === 'object' ? options.viewport : {};
          const handle = installViewport(sessions, { ...(options.uiContainer ? { container: options.uiContainer } : {}), ...o });
          viewport = handle;
          undo.push(() => handle.dispose());
        }
        frame = await parts.attach({ kernel: k, platform, audio, ui: ui ?? NULL_UI, camera, input, headless, ...(options.ports?.jobPause ? { jobPause: options.ports.jobPause } : {}) });
      },
      beforeWarmup: () => {
        step('beforeWarmup');
        ui?.mount();
        input.touch?.mount();
      },
    });
    undo.push(() => boot.dispose());
    if (frame === null) throw new Error('composeGame: the boot never reached onKernel');
    const host: FrameHost = frame;
    undo.push(() => host.dispose());
    const k = boot.kernel;

    let renderer: ShellRenderer | null = null;
    const attachRenderer = (r: ShellRenderer): void => {
      renderer = r;
      scene.attach(r.scene);
      if (r.loop) host.driver.attach(r.loop);
    };
    const app: GameApp = {
      slug: options.slug,
      platform,
      kernel: k,
      boot,
      audio,
      input,
      camera,
      scene,
      ui,
      extensions,
      driver: host.driver,
      canvas: options.canvas,
      acts: host.acts ?? null,
      wiring,
      renderEnv,
      adBreaks,
      viewport,
      steps,
      get renderer() {
        return renderer;
      },
      attachRenderer,
      dispose: () => {
        renderer?.dispose?.();
        for (const f of undo.splice(0).reverse()) f();
      },
    };
    if (options.renderer) {
      step('renderer');
      const r =
        options.renderer === 'default'
          ? await parts.defaultRenderer({ app, env: renderEnv ?? (await parts.renderEnv(renderEnvArgs(options))), content: contentLoader(options.content), options: rendererOptionsFor(options, renderEnv) })
          : await options.renderer(app);
      if (r) attachRenderer(r);
    }
    step('gate');
    await wiring?.ensurePhysics?.();
    host.driver.start();
    return app;
  } catch (err) {
    for (const f of undo.splice(0).reverse()) {
      try {
        f();
      } catch {
        // the first error is the one to report
      }
    }
    throw err;
  }
}
