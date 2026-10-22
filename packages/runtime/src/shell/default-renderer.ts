// The default renderer of a converted game (composeGame `renderer: 'default'`): the render facade, the game on it, and the
// joins to the shell. Pattern: purge-protocol-web ebab692 src/app/engine-loader.ts `attachEngine`, written game-agnostic and
// without the test-build telemetry:
//
//   1  `import()` of the engine (render/index.ts), `createRenderer(canvas, deps)` with the shell's geometry service, asset
//      resolver, presentation clock, the wiring's static raycaster and mixer host (no-op ones without a wiring)
//   2  `installGame(renderer, deps, { lightingScript })`. The lighting module is required: the world config's `lighting:`
//      (it must load and export `lighting()`), else the carried `scripts/lighting.js`, else the neutral Lambert module
//      (neutral-lighting.ts). The wiring hears of the render side (`attachRenderer(world)`: motion reads the models' rigs)
//   3  `renderer.attachFeed(kernel.feed)`; the act wiring's renderer side (buffered fx / decal acts replay), the game's fx,
//      `shockwave` / `shake` and highlight routing
//   4  the camera presenter pushes to `renderer.camera`
//   returned: `scene` (the deferred scene port replays into it) and `loop` (the frame driver hands the step to it)
//
// A failure takes back whatever was attached, then rethrows.
import type { AssetResolver } from '../assets/resolver.ts';
import type { CoreKernel } from '../compat/core/kernel.ts';
import type { ActRouter, VisualProxySoup } from '../compat/core/ports.ts';
import type { GeometryService } from '../render/geometry/geometry-service.ts';
import type { GameDeps, GameKernel, GameWorld } from '../render/world/install.ts';
import type { DeviceType, MixerHost, PresentationClock, RenderFacade, StaticRaycaster } from '../render/index.ts';
import type { LightingScript } from '../render/surface/script-types.ts';
import type { ScriptRigs } from '../render/rig/script-rigs.ts';
import type { FxModeChoice } from '../render/fx/fx-setup.ts';
import type { ShellRenderer } from './compose-game.ts';

/** the world's lighting module when world.config.yaml names none (render/world/install.ts DEFAULT_LIGHTING_SCRIPT) */
export const CARRIED_LIGHTING_SCRIPT = 'scripts/lighting.js';

/** a carried content script by tree path (`virtual:ss/content`); rejects for a path the build does not carry */
export type ContentLoader = (path: string) => Promise<Record<string, unknown>>;

/** the engine chunk as this module uses it (render/index.ts) */
export interface DefaultEngineModule {
  createRenderer(canvas: HTMLCanvasElement, deps: never, opts?: { rebuild?: boolean; search?: string }): Promise<RenderFacade>;
  installGame(renderer: never, deps: never, seams?: { lightingScript?: (kernel: GameKernel) => Promise<LightingScript | null> }): Promise<GameWorld>;
  registerFxActs?(acts: ActRouter, target: NonNullable<GameWorld['fx']>): () => void;
}

export interface DefaultRendererEnv {
  canvas: HTMLCanvasElement;
  kernel: CoreKernel;
  acts: {
    readonly renderActs: ActRouter;
    attachRenderer(renderer: { registerActs(acts: ActRouter): void }): void;
    detachRenderer(): void;
    setHighlightSink(sink: GameWorld['highlights'] | null): void;
  } | null;
  presenter: { setTarget?(target: unknown): void };
  presentation: PresentationClock;
  assets: AssetResolver;
  geometry: GeometryService;
  content: ContentLoader;
  /** the physics/motion wiring's render joins; absent: no-op raycaster and mixer */
  wiring?: {
    raycaster?: StaticRaycaster;
    mixer?: MixerHost;
    setVisualProxies?(place: string, soup: VisualProxySoup): void;
    attachRenderer?(links: Pick<GameWorld, 'model' | 'rigFrame'> | null): void;
  } | null;
  deviceType?: DeviceType;
  sceneHidden?(): boolean;
  pause?: { add(reason: 'gpu'): void; remove(reason: 'gpu'): void };
}

/** Render options forwarded to installGame deps (render/world/install.ts GameDeps); omitted values follow current PP. */
export interface RenderFlags {
  vertexColors?: boolean;
  scriptedPrimitives?: boolean;
  scriptedPivot?: boolean;
  flatPrimitivesCentred?: boolean;
  fxBuiltinAtlas?: boolean;
  fxLightsWithoutAtlas?: boolean;
  fxAlignedCards?: boolean;
  fxHeldFollow?: boolean;
  fxAtlasUrl?: string;
  /** Current PP ranges by default; false retains the legacy unit roll. */
  fxRangeRolls?: boolean;
  /** Defaults to the worker where supported; `inline` runs FX on the main thread. */
  fxMode?: FxModeChoice;
  primitiveAngles?: boolean;
  dissolve?: boolean;
  highlightOutline?: boolean;
  highlightScriptedRows?: boolean;
  warmK8Acts?: boolean;
  /** K12: `ui` rows with `facing="player"` draw as HTML tags anchored to the row (render/special/world-tags.ts) */
  worldTags?: boolean | { container?: HTMLElement };
}

export interface DefaultRendererOptions extends Pick<GameDeps, 'vendor' | 'dynamicTags' | 'ignoredTags' | 'panelFonts' | 'search' | 'gorePlugin' | 'variantData'> {
  /** opt-in GameDeps flags handed to installGame (composeGame `render:` fills this) */
  flags?: RenderFlags;
  /** test seam: the engine chunk; default `import('../render/index.ts')` */
  load?: () => Promise<DefaultEngineModule>;
  /** the lighting module; default resolveLightingScript */
  lightingScript?: LightingScript;
  /**
   * K3: the main-thread rig cache of procedural rigs, handed to `installGame` as `deps.rigs` (it forwards it to
   * `installRenderBridge({ rigs })`; render/world/install.ts must forward it: see SNAPSHOT.md, "Hooks wanted"). Default none (PP).
   */
  rigs?: ScriptRigs;
  /**
   * Options for `createRenderer` beyond the shell's `rebuild: true`, e.g. `{ atmosphere: { fogModel: 'linear' } }` (render/index.ts
   * CreateRendererOptions). Merged over the shell's.
   */
  createOptions?: Record<string, unknown> & {
    /** the canvas width/height clamp, `[min, max]`; default 0.5..2.0 (PP, Playgama), `null` = the canvas fills its area (no letterboxing) */
    aspectRange?: readonly [min: number, max: number] | null;
    /** K14: `model: 'daylight'` (default night = PP) with `sunSlot`, `sunDistance`, `sunShadow`; `fogModel: 'linear'` (render/index.ts AtmosphereRenderOptions) */
    atmosphere?: { fogModel?: 'exp2' | 'linear'; model?: 'night' | 'daylight'; sunSlot?: 0 | 1; sunDistance?: number; sunShadow?: boolean | { slot?: 0 | 1; mapSize?: number; extent?: number } };
  };
  /** a malformed lighting module throws (render's dev rule) */
  dev?: boolean;
  log?: (message: string) => void;
}

export interface DefaultRenderer extends ShellRenderer {
  readonly renderer: RenderFacade;
  readonly world: GameWorld;
  /** where the lighting module came from */
  readonly lighting: 'world-config' | 'carried' | 'neutral' | 'given';
}

const isLighting = (m: unknown): m is LightingScript => typeof m === 'object' && m !== null && typeof (m as { lighting?: unknown }).lighting === 'function';

/**
 * The lighting module the game is drawn with: the world config's `lighting:` (required to load and export `lighting()`), else
 * the carried scripts/lighting.js when the build has it, else the neutral Lambert module.
 */
export async function resolveLightingScript(lightingPath: string | undefined, content: ContentLoader): Promise<{ script: LightingScript; from: 'world-config' | 'carried' | 'neutral' }> {
  if (typeof lightingPath === 'string' && lightingPath !== '') {
    const mod = await content(lightingPath).catch((e: unknown) => {
      throw new Error(`world.config.yaml lighting: ${lightingPath} did not load: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
    });
    if (!isLighting(mod)) throw new Error(`world.config.yaml lighting: ${lightingPath} exports no lighting() function`);
    return { script: mod, from: 'world-config' };
  }
  const carried = await content(CARRIED_LIGHTING_SCRIPT).catch(() => null);
  if (isLighting(carried)) return { script: carried, from: 'carried' };
  const { NEUTRAL_LIGHTING } = await import('./neutral-lighting.ts');
  return { script: NEUTRAL_LIGHTING, from: 'neutral' };
}

/** False opt-in flags stay absent; fxRangeRolls false explicitly selects legacy behavior. */
function definedFlags(flags: RenderFlags | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flags ?? {})) if (v !== undefined && (v !== false || k === 'fxRangeRolls')) out[k] = v;
  return out;
}

const NO_RAYCASTER: StaticRaycaster = { castDown: () => null };
const NO_MIXER: MixerHost = { bind() {}, update() {} };

async function importEngine(): Promise<DefaultEngineModule> {
  const [render, fx] = await Promise.all([import('../render/index.ts'), import('../render/fx/fx-acts.ts')]);
  return { createRenderer: render.createRenderer as never, installGame: render.installGame as never, registerFxActs: fx.registerFxActs as never };
}

export async function createDefaultRenderer(env: DefaultRendererEnv, opts: DefaultRendererOptions = {}): Promise<DefaultRenderer> {
  const log = opts.log ?? ((m: string): void => console.warn(`[renderer] ${m}`));
  const mod = await (opts.load ?? importEngine)();
  const renderer = await mod.createRenderer(
    env.canvas,
    {
      geometry: env.geometry,
      assets: env.assets,
      presentation: env.presentation,
      physics: env.wiring?.raycaster ?? NO_RAYCASTER,
      mixer: env.wiring?.mixer ?? NO_MIXER,
      hooks: {
        deviceType: () => env.deviceType ?? 'desktop',
        requestPause: (r: 'gpu') => env.pause?.add(r),
        releasePause: (r: 'gpu') => env.pause?.remove(r),
        qualitySetting: () => 'auto',
        offerReload: () => log('the GPU device was lost twice; reload the page'),
      },
    } as never,
    { rebuild: true, ...(opts.search !== undefined ? {search:opts.search}:{}), ...(opts.createOptions ?? {}) },
  );
  const undo: (() => void)[] = [() => renderer.dispose()];
  try {
    let lighting: DefaultRenderer['lighting'] = 'given';
    let script = opts.lightingScript ?? null;
    if (script === null) {
      const r = await resolveLightingScript((env.kernel.worldConfig as { lighting?: string }).lighting, env.content);
      script = r.script;
      lighting = r.from;
    }
    const chosen = script;
    const world = await mod.installGame(
      renderer as never,
      {
        ...(opts.vendor ? { vendor: opts.vendor } : {}),
        ...(opts.dynamicTags ? {dynamicTags:opts.dynamicTags}:{}),
        ...(opts.ignoredTags ? {ignoredTags:opts.ignoredTags}:{}),
        ...(opts.panelFonts ? {panelFonts:opts.panelFonts}:{}),
        ...(opts.search !== undefined ? {search:opts.search}:{}),
        ...(opts.gorePlugin ? {gorePlugin:opts.gorePlugin}:{}),
        ...(opts.variantData ? {variantData:opts.variantData}:{}),
        kernel: env.kernel as unknown as GameKernel,
        content: env.content,
        ...(env.wiring?.setVisualProxies ? { setVisualProxies: (p: string, s: VisualProxySoup) => env.wiring?.setVisualProxies?.(p, s) } : {}),
        sceneHidden: () => (env.sceneHidden?.() ?? false) || !env.kernel.clock.running,
        mobile: (env.deviceType ?? 'desktop') !== 'desktop',
        ...(opts.dev !== undefined ? { dev: opts.dev } : {}),
        ...(opts.rigs ? { rigs: opts.rigs } : {}),
        ...definedFlags(opts.flags),
        log,
      } as never,
      { lightingScript: async () => chosen },
    );
    undo.push(() => world.dispose());
    env.wiring?.attachRenderer?.(world);
    undo.push(() => env.wiring?.attachRenderer?.(null));

    renderer.attachFeed(env.kernel.feed);
    if (env.acts) {
      const acts = env.acts;
      acts.attachRenderer(renderer);
      undo.push(() => acts.detachRenderer());
      if (world.fx && mod.registerFxActs) undo.push(mod.registerFxActs(acts.renderActs, world.fx));
      const specials = world.specials;
      if (specials) {
        const offs = [acts.renderActs.register('shockwave', (a) => void specials.shockwave(a.payload as never)), acts.renderActs.register('shake', (a) => void specials.shake(a.payload as never))];
        undo.push(() => offs.forEach((off) => off()));
      }
      acts.setHighlightSink(world.highlights);
      undo.push(() => acts.setHighlightSink(null));
    }
    env.presenter.setTarget?.(renderer.camera);
    undo.push(() => env.presenter.setTarget?.(null));

    return {
      renderer,
      world,
      lighting,
      scene: renderer.scene,
      loop: renderer as never,
      dispose: () => {
        for (const f of undo.splice(0).reverse()) {
          try {
            f();
          } catch (e) {
            log(`disposing threw: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      },
    };
  } catch (e) {
    for (const f of undo.splice(0).reverse()) {
      try {
        f();
      } catch {
        // the first error is the one to report
      }
    }
    throw e;
  }
}
