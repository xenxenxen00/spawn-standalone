// The render domain's facade (docs/architecture.md §3.0, §3.5; docs/design/rendering.md §2.1; WP R0).
//
// `createRenderer(canvas, deps)` creates three's `WebGPURenderer` on its WebGL2 backend (X-46) and returns the `Renderer` the
// app drives. This module and everything it imports is the lazy `engine` chunk (X-26): the app shell loads it after
// `game_ready`. Boot code takes only types from here, and the tier table and probe from `perf/budget.ts` and `perf/tiers.ts`,
// which import no three.js.
//
// R0 is the skeleton. It has the renderer, the scene root with the five permanent lights, the camera presenter, the canvas
// host, the render loop with the rAF hand-over, the tier and `RenderBudget`, `gpuInfo()`, `telemetry()` from `renderer.info`,
// and step 1 of the device-loss policy (the wrapped handler, pause reason `gpu`). The members whose producers are later work
// packages exist with typed bodies that do nothing and never throw:
//   scene (SceneSyncPort)            R3 / R13: the map batcher and the render bridge
//   attachFeed, registerActs         R13 (RowFeed drain), R10 / R11 / R12a (fx, decal, shockwave, shake acts)
//   flashGuard, setReducedFlash      R1b's `lighting/flash-guard.ts` (R4 put the real guard here; it is the identity while off)
//   the RenderPipeline               R5b replaces the scene-pass-to-output pipeline through `setPipeline`
//   the lighting system              R1b installs `GridLighting` through `root.installLighting`
//   the rebuild after a device loss  X3: `engine/device-loss.ts` decides, `rebuild()` below runs render §3.1 step 2 on the
//                                    seams `host.replaceCanvas` and `adoptEngine`, and `onRebuild` runs the warm-up behind
//                                    the hold (src/render/world/install.ts) before pause reason `gpu` is released
// Each of them hangs its per-frame work on the loop's fixed stage list (`loop.setStage`, docs/architecture.md §4.2 step 4).
import { pass } from 'three/tsl';
import { RenderPipeline } from 'three/webgpu';
import type { Camera, Scene, WebGPURenderer } from 'three/webgpu';
import type { AssetResolver } from '../assets/resolver.ts';
import type { ActRouter, RowFeed, SceneSyncPort } from '../compat/core/ports.ts';
import type { Vec3 } from '../compat/core/types.ts';
import { createCanvasHost, type AspectRange, type CanvasEnv, type CanvasHostControl, type ResolutionScaled } from './engine/canvas-host.ts';
import { gpuInfoOf, type DeviceCaps, type GpuInfo } from './engine/capabilities.ts';
import {
  DEVICE_RESET_MESSAGE,
  createRenderer as createEngine,
  installDeviceLossHandler,
  rendererGl,
  wantsWebGPU,
  type CreateRendererSeams,
  type DeviceLostInfo,
  type RenderEngine,
} from './engine/create-renderer.ts';
import { createDeviceLossPolicy, type DeviceLossPolicy, type DeviceLossPolicyDeps, type DeviceLossState } from './engine/device-loss.ts';
import { createRenderLoop, type FrameInfo, type LoopClock, type RenderLoopControl } from './engine/render-loop.ts';
import type { GeometryService } from './geometry/geometry-service.ts';
import { createFlashGuard, type FlashGuardControl } from './lighting/flash-guard.ts';
import { createRenderBudget, tierConfig, type RenderBudget, type TierConfig, type TierId } from './perf/budget.ts';
import { createGovernor, fxHeldLeverApplies, fxHeldStepDown, type Governor } from './perf/governor.ts';
import { selectTier, tierParamFromSearch, type DeviceType, type TierPick } from './perf/tiers.ts';
import { syncPanelLiveCalibration } from './post/postfx-tsl.ts';
import { createCameraPresenter, type CameraPresenter, type CameraPresenterControl, type Projected } from './scene/camera-presenter.ts';
import { createSceneRoot, type FogModel, type SceneRoot, type SunShadowOptions } from './scene/scene-root.ts';
import type { ScreenDiscOptions } from './atmosphere/screen-disc.ts';

export type { CanvasHost, CanvasHostControl, ResizeInfo } from './engine/canvas-host.ts';
export type { DeviceCaps, GpuInfo, RenderBackend } from './engine/capabilities.ts';
export { DEVICE_RESET_MESSAGE, RendererUnsupported } from './engine/create-renderer.ts';
export type { DeviceLostInfo, RenderEngine } from './engine/create-renderer.ts';
export { DEVICE_LOSS_WINDOW_MS } from './engine/device-loss.ts';
export type { DeviceLossState } from './engine/device-loss.ts';
export type { FrameInfo, RenderLoop, RenderLoopControl } from './engine/render-loop.ts';
export type { CalibratePanelOptions } from './dev/calibrate-panel.ts'; // R15: the ?calibrate=1 panel's options (type-only)
export type { BudgetKind, RenderBudget, TierConfig, TierId } from './perf/budget.ts';
export type { DeviceType, TierPick } from './perf/tiers.ts';
export type { CpuLever, CpuLeverFn, Governor, GovernorEvent, GovernorPhase, GovernorState } from './perf/governor.ts';
export type { CameraPose, CameraPresenter, Projected } from './scene/camera-presenter.ts';
export type { FogModel, PermanentLights, SceneRoot } from './scene/scene-root.ts';
// R4: the light grid, the post chain, the atmosphere and the shadowCaster on the facade's seams, called once after `createRenderer`
export { installWorldLighting } from './atmosphere/install.ts';
export type { WorldLighting, WorldLightingHost, WorldLightingOptions } from './atmosphere/install.ts';
// R13: rows → render (the bridge, the primitive buckets, the viewmodel layer, the map) on the facade's seams, called once
// after `createRenderer` and `installWorldLighting`
export { installRenderBridge } from './bridge/install.ts';
export type { InstallBridgeOptions, InstalledBridge, RenderBridgeHost } from './bridge/install.ts';
export { createModelRows, createRowTextures } from './bridge/attach.ts';
export type { BridgeModels, FxBinding, FxSystem, RenderBridge, RowExtension, RowNodeView } from './bridge/bridge-types.ts';
// X1b: the game on the facade (world lighting, the lighting module, the model libraries, the bridge, the atmosphere feed, the
// warm-up and the visual proxies), called once by the engine loader after `createRenderer`
export { installGame } from './world/install.ts';
export type { GameDeps, GameHost, GameKernel, GameVariantData, GameWarmRun, GameWorld, GameWorldInfo } from './world/install.ts';
import type { GameHost } from './world/install.ts';

// ── what this domain needs from the others (render §21; docs/architecture.md §3.0) ───────────────────────────────────────

/** the app shell's presentation clock (X-11): no paused time, frozen by hitstop */
export interface PresentationClock {
  update(realDtS: number, simPaused: boolean): void;
  now(): number;
  dt(): number;
  hitstop(seconds: number): void;
  hitstopActive(): boolean;
}

/** physics domain: the fx floor height */
export interface StaticRaycaster {
  castDown(origin: Vec3, maxDist: number): { y: number; normal: Vec3 } | null;
}

/** animation domain: motion's three-skin.ts writes `instance.bones` before render (motion §3.10); `ModelInstance` is R6's */
export interface MixerHost {
  bind(instance: unknown): void;
  update(frame: FrameInfo): void;
  /** the governor's CPU lever (render §15.2): mixer LOD distances × 0.7 */
  setGovernorLod?(on: boolean): void;
  /** the low-tier LOD distances (a runtime tier switch) */
  setLowTier?(low: boolean): void;
}

/** platform layer */
export interface PlatformRenderHooks {
  deviceType(): DeviceType;
  requestPause(reason: 'gpu'): void;
  releasePause(reason: 'gpu'): void;
  qualitySetting(): TierPick;
  offerReload(): void;
}

/** render §8.5 (X-23). R1b's `lighting/flash-guard.ts` owns the implementation; this is its interface. */
export interface FlashChannel {
  /** identity while disabled */
  apply(target: number, nowMs: number, dt: number): number;
}
export interface FlashGuard {
  setEnabled(on: boolean): void;
  /** one per lamp, ambient, hemisphere, fx-light slot, overlay */
  channel(key: string, base: number): FlashChannel;
}

// ── the facade (docs/architecture.md §3.0) ───────────────────────────────────────────────────────────────────────────────

export interface Renderer {
  readonly scene: SceneSyncPort;
  readonly camera: CameraPresenter;
  readonly flashGuard: FlashGuard;
  readonly tier: TierId;
  setTier(pick: 'auto' | 'low' | 'medium' | 'high'): void;
  /**
   * The quality governor (render §15.2; perf/governor.ts) over this renderer's render scale and tier. The app feeds it frames
   * and phases and hands it the CPU levers it owns; the fx held-factor lever is the renderer's own.
   */
  readonly governor: Governor;
  setReducedFlash(on: boolean): void;
  /** fx, decal, shockwave, shake */
  registerActs(acts: ActRouter): void;
  attachFeed(feed: RowFeed): void;
  update(frame: FrameInfo): void;
  render(): void;
  /** X-08: the frame driver's step rides three's loop (X-46) */
  setAnimationLoop(step: ((timeMs: number) => void) | null): void;
  project(p: Vec3): { x: number; y: number; depth: number; onScreen: boolean };
  /** first presented frame (it removes the canvas veil; not `game_ready`, X-04); returns unsubscribe */
  onFirstFrame(cb: () => void): () => void;
  /**
   * From `renderer.info`, which three's loop resets before the frame step: read it inside the step. `activeMeshes` is the
   * render objects drawn this frame (every pass); `shaderCompiles` counts program creations since the renderer was created.
   */
  telemetry(): { drawCalls: number; activeMeshes: number; triangles: number; shaderCompiles: number };
  /** X1 publishes `unmaskedRenderer` to src/testing/telemetry.ts as `glRenderer` for the gpuGuard (build §8.5) */
  gpuInfo(): GpuInfo;
  /** a device-loss rebuild swapped the <canvas> (render §3.1): whatever bound the old element rebinds (X3) */
  onCanvasReplaced(cb: (canvas: HTMLCanvasElement) => void): () => void;
  dispose(): void;
}

export interface RendererDeps {
  geometry: GeometryService;
  assets: AssetResolver;
  presentation: PresentationClock;
  physics: StaticRaycaster;
  mixer: MixerHost;
  hooks: PlatformRenderHooks;
}

/** what draws the frame: R0's is the scene pass straight to the output, R5b's the full post chain */
export interface ScenePipeline {
  /** the scene `PassNode`: the render scale is written to it and to nothing else (render §3.3) */
  readonly scenePass: ResolutionScaled;
  render(): void;
  dispose(): void;
}
export type PipelineFactory = (ctx: { renderer: WebGPURenderer; scene: Scene; camera: Camera; caps: DeviceCaps; tier: TierConfig }) => ScenePipeline;

export interface DeviceLossNotice {
  api: string;
  message: string;
  reason: string | null;
  /** the text the platform chrome shows for pause reason `gpu` */
  title: string;
}

export type { ScreenDiscOptions } from './atmosphere/screen-disc.ts';
/** the facade plus what the rest of the render lane, the governor and the rebuild path (X3) build on */
/**
 * K14: the world's atmosphere options of `createRenderer`. `model: 'daylight'` (default 'night') is handed on by `installGame`
 * to the atmosphere (`sunSlot`, `sunDistance` with it) and, with it, the scene root gets the sun's shadow (`sunShadow`, default
 * the shadow defaults) because shadow state is chosen once, at creation.
 */

export interface AtmosphereRenderOptions {
  nightSky?: import('./atmosphere/sky.ts').NightSkyOptions;
  fogModel?: FogModel;
  model?: 'night' | 'daylight';
  sunSlot?: 0 | 1;
  sunDistance?: number;
  /** daylight, opt-in: linear rgb multiplier on the derived sky zenith and horizon (`DaylightOverrides.skyTint`) */
  skyTint?: readonly [number, number, number];
  /** daylight, opt-in: saturation of the derived sky, 1 = unchanged (`DaylightOverrides.skySaturation`) */
  skySaturation?: number;
  /** daylight, opt-in: the sun pinned at this azimuth (degrees from +Z toward +X) and/or elevation (degrees) */
  sunAzimuth?: number;
  sunElevation?: number;
  /** daylight only: false turns the sun's shadow off, an object tunes it; default on */
  sunShadow?: boolean | SunShadowOptions;
  /**
   * opt-in, any model: a linear gain on the scene colour before the look and the output transform (three's
   * `toneMappingExposure`, which the port holds at 1). Absent = 1.
   */
  exposure?: number;
  /** opt-in, any model: a soft disc drawn at a fixed screen spot behind every depth-writing row (`ScreenDiscOptions`) */
  screenDisc?: ScreenDiscOptions;
}

export interface RenderFacade extends Renderer {
  /** the atmosphere options `createRenderer` was given (empty) */
  readonly atmosphereOptions: Readonly<AtmosphereRenderOptions>;
  readonly camera: CameraPresenterControl;
  /** the guard of `lighting/flash-guard.ts`, which the light table and the atmosphere take their channels from */
  readonly flashGuard: FlashGuardControl;
  /** the current engine; replaced by `adoptEngine` */
  readonly engine: RenderEngine;
  readonly root: SceneRoot;
  readonly host: CanvasHostControl;
  readonly loop: RenderLoopControl;
  /** render §15.3: follows the live tier */
  readonly budget: RenderBudget;
  readonly tierConfig: TierConfig;
  readonly deps: RendererDeps;
  /** the device is lost and no rebuilt engine has been adopted yet */
  readonly lost: boolean;
  /**
   * What `scene` forwards to (R13: `bridge/attach.ts` `attachRenderBridge`); null puts back the port that builds nothing.
   * `scene` itself is one object for the facade's life, so the app's deferred port keeps its target.
   */
  setScenePort(port: SceneSyncPort | null): void;
  /** the RowFeed and the act router handed in by the app, for the packages that consume them (R13; R10, R11, R12a) */
  readonly feed: RowFeed | null;
  readonly acts: ActRouter | null;
  /** The governor's lever (render §15.2): any tier, `minimum` included. `setTier` is the player's pick. */
  applyTier(tier: TierId): void;
  /** the player's explicit SETTINGS pick or a `?tier=` flag chose the tier (X-22): the governor drops no tier */
  readonly tierExplicit: boolean;
  /**
   * The governor's fx lever (render §15.2, mobile tiers only): the multiplier on the tier's held factor for effects started
   * from now on; 1 until the lever is pulled.
   */
  readonly fxHeldScale: number;
  onTierChange(cb: (tier: TierId, config: TierConfig) => void): () => void;
  /** after three's default handler ran and pause reason `gpu` was requested */
  onDeviceLost(cb: (notice: DeviceLossNotice) => void): () => void;
  /** Replaces what draws the frame (R5b); the previous pipeline is disposed. */
  setPipeline(factory: PipelineFactory): void;
  /**
   * Wires a newly created engine in place of the current one: size, lighting, pipeline, loss handler, animation loop. The
   * rebuild path (`rebuild`) calls it after `host.replaceCanvas()` and `createRenderer`.
   */
  adoptEngine(engine: RenderEngine): void;
  /**
   * The rebuild after a device loss (render §3.1 step 2, X3), run by the loss policy (engine/device-loss.ts): the step moves
   * to the loop's own chain, the pipeline and the lost renderer are disposed, the canvas host swaps in a fresh `<canvas>`
   * (`onCanvasReplaced`), a new engine is created on it and adopted (lighting and pipeline re-installed), and every
   * `onRebuild` listener runs (the warm-up, behind the hold). Resolves true when the new engine is ready to draw and was not
   * lost meanwhile; false without a way to create one (`AssembleOptions.recreate`). Releasing pause reason `gpu` is the
   * policy's, after this resolved true.
   */
  rebuild(): Promise<boolean>;
  /** Runs after a rebuilt engine was adopted and before pause `gpu` is released (the warm-up); awaited in order. */
  onRebuild(cb: () => Promise<void> | void): () => void;
  /** rebuilds that resumed the game */
  readonly rebuilds: number;
  /** the loss policy's state; `'off'` without `recreate` (R0's harness: a loss only pauses) */
  readonly lossState: DeviceLossState | 'off';
}

export interface AssembleOptions {
  /** the page's query string (`?tier=`); default empty */
  search?: string;
  /**
   * A `?tier=` flag counts as an explicit setting (the governor drops no tier from it): default true. False lets the flag
   * stand as a detected tier, so a test build can force a starting tier the governor may still drop (R14b's browser check,
   * the app's `?ssTierDrops=on`).
   */
  tierFlagExplicit?: boolean;
  /** false: something else lays the canvas out (canvas-host.ts) */
  styleCanvas?: boolean;
  canvasEnv?: Partial<CanvasEnv>;
  /** rAF source of the loop's own chain */
  clock?: LoopClock;
  /** what draws the frame; default: the scene pass straight to the output */
  pipeline?: PipelineFactory;
  /**
   * Creates the engine of a device-loss rebuild on the fresh canvas (X3). Without it a loss only pauses with `gpu` (policy
   * step 1, R0) and nothing is rebuilt. `createRenderer` sets it when `rebuild` is true.
   */
  recreate?: (canvas: HTMLCanvasElement) => Promise<RenderEngine>;
  /**
   * K14: the world's atmosphere options. `fogModel` picks the scene's fog type once, at creation (default 'exp2'; 'linear' =
   * `near` / `far` fog). It is never swapped later: three keys programs on the fog type.
   */
  atmosphere?: AtmosphereRenderOptions;
  /** the canvas host's width/height clamp; default no clamp, `null` = no letterboxing (render/engine/canvas-host.ts) */
  aspectRange?: AspectRange;
  /** the loss policy's clock and window (unit tests) */
  lossPolicy?: Pick<DeviceLossPolicyDeps, 'now' | 'setTimer' | 'clearTimer' | 'windowMs' | 'log'>;
}

export interface CreateRendererOptions extends AssembleOptions {
  /** the WebGPU backend flag; default: `?renderer=webgpu` in `search` */
  wantWebGPU?: boolean;
  engineSeams?: CreateRendererSeams;
  /** X3: rebuild the renderer on a fresh canvas after a device loss (the page sets it; R0's harness does not) */
  rebuild?: boolean;
}

/** R0's pipeline: the scene pass, then three's output transform (tone mapping and sRGB), nothing between. */
export const scenePassPipeline: PipelineFactory = ({ renderer, scene, camera }) => {
  const scenePass = pass(scene, camera);
  const pipeline = new RenderPipeline(renderer, scenePass);
  return {
    scenePass,
    render: () => pipeline.render(),
    dispose: () => {
      pipeline.dispose();
      scenePass.dispose();
    },
  };
};

const PICKS: readonly string[] = ['auto', 'low', 'medium', 'high'];

const noScene = (): SceneSyncPort => ({
  buildPlace(_place, _rows, _bake, onProgress) {
    onProgress(1);
    return Promise.resolve();
  },
  disposePlace() {},
  activate() {},
  bounds: () => undefined,
  socket: () => null,
});

function callAll<A extends unknown[]>(listeners: Iterable<(...args: A) => void>, ...args: A): void {
  for (const cb of [...listeners]) {
    try {
      cb(...args);
    } catch (e) {
      console.error('renderer: a listener threw', e);
    }
  }
}


/** Wires an initialised engine into the facade. `createRenderer` is this after `engine/create-renderer.ts`. */
export function assembleRenderer(first: RenderEngine, deps: RendererDeps, opts: AssembleOptions = {}): RenderFacade {
  const search = opts.search ?? '';
  const tierParam = tierParamFromSearch(search);
  const { hooks } = deps;

  let engine = first;
  let pick: TierPick = hooks.qualitySetting();
  let pipelineFactory: PipelineFactory = opts.pipeline ?? scenePassPipeline;
  let pipeline: ScenePipeline | null = null;
  let lost = false;
  let disposed = false;
  let feed: RowFeed | null = null;
  let acts: ActRouter | null = null;
  let programsCreated = 0;
  let uninstallLoss: () => void = () => undefined;
  let unhookPrograms: () => void = () => undefined;

  const tierListeners = new Set<(tier: TierId, config: TierConfig) => void>();
  const lossListeners = new Set<(notice: DeviceLossNotice) => void>();
  const rebuildListeners = new Set<() => Promise<void> | void>();
  /** X3: set below once `rebuildEngine` exists; null without `opts.recreate` */
  let policy: DeviceLossPolicy | null = null;

  let tierExplicit = false;
  const detect = (): TierId => {
    const d = selectTier({
      deviceType: hooks.deviceType(),
      probe: { webgl2: true, unmaskedRenderer: engine.caps.unmaskedRenderer, halfFloatRenderable: engine.caps.halfFloatRenderTargets },
      userPick: pick,
      tierParam,
    });
    tierExplicit = d.source === 'user' || (d.source === 'flag' && (opts.tierFlagExplicit ?? true));
    return d.tier;
  };
  let tier: TierId = detect();
  /** the governor's fx held factor (absolute, from `FX_HELD_LADDER`); null until the lever is pulled */
  let fxHeldFactor: number | null = null;

  const atmosphereOptions: AtmosphereRenderOptions = opts.atmosphere ?? {};
  const daylight = atmosphereOptions.model === 'daylight';
  const sunShadow = daylight && atmosphereOptions.sunShadow !== false ? (atmosphereOptions.sunShadow === undefined || atmosphereOptions.sunShadow === true ? { slot: atmosphereOptions.sunSlot ?? 0 } : { slot: atmosphereOptions.sunSlot ?? 0, ...atmosphereOptions.sunShadow }) : undefined;
  const root = createSceneRoot({
    ...(atmosphereOptions.fogModel === undefined ? {} : { fogModel: atmosphereOptions.fogModel }),
    ...(sunShadow === undefined ? {} : { sunShadow }),
  });
  const camera = createCameraPresenter({ coordinateSystem: () => engine.renderer.coordinateSystem });
  const host = createCanvasHost({
    canvas: engine.canvas,
    tier: tierConfig(tier),
    target: engine.renderer,
    ...(opts.canvasEnv === undefined ? {} : { env: opts.canvasEnv }),
    ...(opts.styleCanvas === undefined ? {} : { styleCanvas: opts.styleCanvas }),
    ...(opts.aspectRange === undefined ? {} : { aspectRange: opts.aspectRange }),
  });
  camera.setViewport(host.size.cssW, host.size.cssH);
  host.onResize((r) => camera.setViewport(r.cssW, r.cssH));

  const loop = createRenderLoop({
    draw: () => {
      if (lost || disposed || pipeline === null) return false;
      // three updates the scene's world matrices at the start of every render of it: the scene pass, then again in each
      // shadow map pass inside it, over the same unchanged transforms (nothing in the frame's render moves an object).
      // Updated once here instead, at the start of the frame's render as before, with the per-render update off for the
      // duration (cpu-budget X-38); the same matrices, one traversal instead of one per pass.
      const scene = root.scene;
      if (!scene.matrixWorldAutoUpdate) {
        pipeline.render();
        return true;
      }
      scene.updateMatrixWorld();
      scene.matrixWorldAutoUpdate = false;
      try {
        pipeline.render();
      } finally {
        scene.matrixWorldAutoUpdate = true;
      }
      return true;
    },
    flushResize: () => host.flush(),
    ...(opts.clock === undefined ? {} : { clock: opts.clock }),
  });

  const flashGuard = createFlashGuard();
  // `scene` forwards to the port a later package installs (`setScenePort`); until then it builds nothing
  const noPort = noScene();
  let scenePort: SceneSyncPort = noPort;
  const scene: SceneSyncPort = {
    buildPlace: (place, rows, bake, onProgress) => scenePort.buildPlace(place, rows, bake, onProgress),
    disposePlace: (place) => scenePort.disposePlace(place),
    activate: (place) => scenePort.activate(place),
    bounds: (row) => scenePort.bounds(row),
    socket: (rowId, name) => scenePort.socket(rowId, name),
  };
  const budget = createRenderBudget(() => tier);

  const buildPipeline = (): void => {
    host.bindScenePass(null);
    pipeline?.dispose();
    pipeline = pipelineFactory({ renderer: engine.renderer, scene: root.scene, camera: camera.world, caps: engine.caps, tier: tierConfig(tier) });
    host.bindScenePass(pipeline.scenePass);
  };

  /** counts three's program creations (`Info#createProgram`) without disturbing its own bookkeeping */
  const hookPrograms = (renderer: WebGPURenderer): (() => void) => {
    const info = renderer.info as unknown as { createProgram: (program: unknown) => void };
    const base = info.createProgram;
    const counting = function (this: unknown, program: unknown): void {
      programsCreated++;
      base.call(this, program);
    };
    info.createProgram = counting;
    return () => {
      if (info.createProgram === counting) info.createProgram = base;
    };
  };

  /** device-loss policy step 1 (render §3.1): three's handler first, then pause reason `gpu`, once per engine */
  const hookLoss = (renderer: WebGPURenderer): (() => void) => {
    let asked = false;
    return installDeviceLossHandler(renderer, (info: DeviceLostInfo) => {
      lost = true;
      if (!asked) {
        asked = true;
        try {
          hooks.requestPause('gpu');
        } catch (e) {
          console.error('renderer: requestPause("gpu") failed', e);
        }
      }
      callAll(lossListeners, { api: info.api, message: info.message, reason: info.reason, title: DEVICE_RESET_MESSAGE });
      policy?.onLost();
    });
  };

  const bindEngine = (next: RenderEngine): void => {
    uninstallLoss();
    unhookPrograms();
    engine = next;
    lost = false;
    uninstallLoss = hookLoss(engine.renderer);
    unhookPrograms = hookPrograms(engine.renderer);
    host.setTarget(engine.renderer);
    root.installLighting(engine.renderer);
    buildPipeline();
    loop.attachRenderer(engine.renderer);
  };

  const applyTier = (next: TierId): void => {
    const config = tierConfig(next);
    if (next === tier) return;
    tier = next;
    // new caps resize the drawing buffer at once, which clears it: one render() on the next frame if the step draws none
    // (SETTINGS under the pause menu; render §3.4 "a resize while paused triggers one render()")
    if (host.setTier(config)) loop.requestPresent();
    callAll(tierListeners, tier, config);
  };

  bindEngine(first);

  /** render §3.1 step 2 (X3); the policy calls it and releases `gpu` when it resolved true */
  const rebuildEngine = async (): Promise<boolean> => {
    const recreate = opts.recreate;
    if (disposed || recreate === undefined) return false;
    const old = engine;
    // the frame step keeps running on the loop's own chain (the frozen frame, the UI) while there is no renderer
    loop.detachRenderer();
    uninstallLoss();
    uninstallLoss = () => undefined;
    unhookPrograms();
    unhookPrograms = () => undefined;
    host.bindScenePass(null);
    try {
      pipeline?.dispose();
    } catch (e) {
      console.error('renderer: disposing the lost pipeline failed', e);
    }
    pipeline = null;
    // three's dispose is async; on a lost context its GL calls do nothing. The scene's CPU copies stay for the new renderer.
    void Promise.resolve()
      .then(() => old.renderer.dispose())
      .catch((e: unknown) => console.error('renderer: disposing the lost renderer failed', e));
    const canvas = host.replaceCanvas();
    const next = await recreate(canvas);
    /** the new context was lost before (or while) the facade listened to it: three's own handler alone heard it */
    const lostUnheard = (): boolean => {
      try {
        return rendererGl(next.renderer)?.isContextLost() === true;
      } catch {
        return false;
      }
    };
    if (disposed) {
      void Promise.resolve()
        .then(() => next.renderer.dispose())
        .catch(() => undefined);
      return false;
    }
    if (lostUnheard()) {
      void Promise.resolve()
        .then(() => next.renderer.dispose())
        .catch(() => undefined);
      return false;
    }
    bindEngine(next);
    for (const cb of [...rebuildListeners]) {
      try {
        await cb();
      } catch (e) {
        console.error('renderer: an onRebuild listener threw', e);
      }
      if (disposed) return false;
    }
    // lost again during the warm-up: the policy has offered the reload already
    return !lost && !lostUnheard();
  };
  if (opts.recreate !== undefined) {
    policy = createDeviceLossPolicy({
      rebuild: rebuildEngine,
      resume: () => {
        // the new drawing buffer is blank until drawn: one render() on the next frame even while the game stays paused
        loop.requestPresent();
        try {
          hooks.releasePause('gpu');
        } catch (e) {
          console.error('renderer: releasePause("gpu") failed', e);
        }
      },
      offerReload: () => hooks.offerReload(),
      ...opts.lossPolicy,
    });
  }

  const deviceType = hooks.deviceType();
  const governor = createGovernor({
    target: {
      get tier(): TierId {
        return tier;
      },
      get renderScale(): number {
        return host.renderScale;
      },
      setRenderScale: (s) => host.setRenderScale(s),
      applyTier: (t) => applyTier(t),
      get explicitTier(): boolean {
        return tierExplicit;
      },
    },
    device: deviceType === 'desktop' ? 'desktop' : 'mobile',
    levers: {
      // render §15.2: one step down the held ladder, for effects started from now on (live effects keep their counts)
      fxHeld: () => {
        if (!fxHeldLeverApplies(tier)) return false;
        const current = fxHeldFactor ?? tierConfig(tier).fxHeldFactor;
        const next = fxHeldStepDown(current);
        if (!(next < current)) return false;
        fxHeldFactor = next;
        return true;
      },
    },
  });

  const facade: RenderFacade = {
    scene,
    camera,
    flashGuard,
    root,
    atmosphereOptions,
    host,
    loop,
    budget,
    deps,
    get engine(): RenderEngine {
      return engine;
    },
    get tier(): TierId {
      return tier;
    },
    get tierConfig(): TierConfig {
      return tierConfig(tier);
    },
    get tierExplicit(): boolean {
      return tierExplicit;
    },
    get fxHeldScale(): number {
      if (fxHeldFactor === null || !fxHeldLeverApplies(tier)) return 1;
      return Math.min(1, fxHeldFactor / tierConfig(tier).fxHeldFactor);
    },
    governor,
    get lost(): boolean {
      return lost;
    },
    get rebuilds(): number {
      return policy?.rebuilds ?? 0;
    },
    get lossState(): DeviceLossState | 'off' {
      return policy?.state ?? 'off';
    },
    get feed(): RowFeed | null {
      return feed;
    },
    get acts(): ActRouter | null {
      return acts;
    },

    setTier(next: TierPick): void {
      if (!PICKS.includes(next)) throw new RangeError(`renderer.setTier: expected auto, low, medium or high, got ${JSON.stringify(next)}`);
      pick = next;
      applyTier(detect());
      // the player's pick is a tier change from outside: the governor starts over on it (pulled levers stay)
      governor.reset();
    },
    applyTier,
    onTierChange(cb) {
      tierListeners.add(cb);
      return () => void tierListeners.delete(cb);
    },

    setReducedFlash(on: boolean): void {
      flashGuard.setEnabled(on === true);
    },
    registerActs(router: ActRouter): void {
      acts = router;
    },
    attachFeed(next: RowFeed): void {
      feed = next;
    },
    setScenePort(port: SceneSyncPort | null): void {
      scenePort = port ?? noPort;
    },

    update(frame: FrameInfo): void {
      loop.update(frame);
    },
    render(): void {
      loop.render();
    },
    setAnimationLoop(step: ((timeMs: number) => void) | null): void {
      loop.setAnimationLoop(step);
    },
    onFirstFrame(cb: () => void): () => void {
      return loop.onFirstFrame(cb);
    },

    project(p: Vec3): Projected {
      return camera.project(p);
    },

    telemetry() {
      const { render } = engine.renderer.info;
      return { drawCalls: render.drawCalls, activeMeshes: render.drawCalls, triangles: render.triangles, shaderCompiles: programsCreated };
    },
    gpuInfo(): GpuInfo {
      return gpuInfoOf(engine.caps);
    },

    onDeviceLost(cb) {
      lossListeners.add(cb);
      return () => void lossListeners.delete(cb);
    },
    onCanvasReplaced(cb: (canvas: HTMLCanvasElement) => void): () => void {
      return host.onReplace((next) => cb(next));
    },

    setPipeline(factory: PipelineFactory): void {
      pipelineFactory = factory;
      buildPipeline();
    },
    adoptEngine(next: RenderEngine): void {
      if (disposed) return;
      bindEngine(next);
    },
    rebuild: rebuildEngine,
    onRebuild(cb) {
      rebuildListeners.add(cb);
      return () => void rebuildListeners.delete(cb);
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      policy?.dispose();
      loop.dispose();
      uninstallLoss();
      unhookPrograms();
      host.bindScenePass(null);
      pipeline?.dispose();
      pipeline = null;
      host.dispose();
      root.dispose();
      tierListeners.clear();
      lossListeners.clear();
      rebuildListeners.clear();
      void Promise.resolve(engine.renderer.dispose()).catch((e: unknown) => console.error('renderer: dispose failed', e));
    },
  };

  // R15: the dev-only calibration panel (render §17, X-27). `?calibrate=1` loads it on demand (code-split, so the
  // shipped bundle never includes it); the ordinary runtime is unchanged and the shipped defaults are untouched.
  // The panel edits the runtime calibration copy and can reset it; structural changes are reported through
  // `onStructuralChange` for the app to rebuild materials/the pipeline (calibrate-panel.ts), and the live
  // `grade.contrastPivot` edit is reported through `onLiveChange`, which syncs every built look's
  // `calibrationPivot` uniform with no rebuild (postfx-tsl.ts).
  if (/(^|[?&])calibrate=1($|&)/.test(search) && typeof document !== 'undefined') {
    void import('./dev/calibrate-panel.ts').then(
      (m) => {
        m.installCalibratePanel({ onLiveChange: syncPanelLiveCalibration });
      },
      (e: unknown) => console.error('renderer: the ?calibrate=1 panel failed to load', e),
    );
  }

  return facade;
}

/**
 * Creates the renderer on `canvas` (render §3.1) and assembles the facade. Rejects with `RendererUnsupported` when there is no
 * WebGL2; the platform layer shows the styled message.
 */
export async function createRenderer(canvas: HTMLCanvasElement, deps: RendererDeps, opts: CreateRendererOptions = {}): Promise<RenderFacade> {
  const search = opts.search ?? '';
  const wantWebGPU = opts.wantWebGPU ?? wantsWebGPU(search);
  // The engine is created the same way on every tier (half float everywhere); its real tier follows from its own caps.
  const provisional = selectTier({
    deviceType: deps.hooks.deviceType(),
    probe: { webgl2: true, unmaskedRenderer: null, halfFloatRenderable: true },
    userPick: deps.hooks.qualitySetting(),
    tierParam: tierParamFromSearch(search),
  }).tier;
  const engine = await createEngine(canvas, { wantWebGPU, tier: tierConfig(provisional) }, opts.engineSeams);
  const recreate =
    opts.rebuild === true && opts.recreate === undefined
      ? (fresh: HTMLCanvasElement): Promise<RenderEngine> => createEngine(fresh, { wantWebGPU, tier: tierConfig(provisional) }, opts.engineSeams)
      : opts.recreate;
  return assembleRenderer(engine, deps, { ...opts, search, ...(recreate === undefined ? {} : { recreate }) });
}

/** compile-time: the facade is the host `installGame` takes (the engine loader hands it through as `never`, X-26) */
export type FacadeIsGameHost = RenderFacade extends GameHost ? true : { error: 'RenderFacade no longer fits GameHost of game/install.ts' };
const facadeIsGameHost: FacadeIsGameHost = true;
void facadeIsGameHost;
