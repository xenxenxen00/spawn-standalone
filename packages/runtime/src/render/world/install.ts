// Composes world lighting, surfaces, model libraries and the render bridge on a renderer facade.
// Hosts inject lighting/content, decoder URLs, classification tags and optional batching plugins.
// Warm-ups cover loaded model bindings, place geometry, scripted materials, effects and reachable tier states.
// Rebuilds clear the old coverage and repeat it before the scene becomes visible. Resource disposal unwinds in reverse.
import { LoadingManager, Matrix4, SRGBColorSpace, TextureLoader, Vector3 } from 'three/webgpu';
import type { Camera, InstancedMesh, Mesh, Object3D, RenderTarget, Scene, Texture, WebGPURenderer } from 'three/webgpu';
import type { VendorUrls } from '../../assets/decoders.ts';
import type { AssetResolver } from '../../assets/resolver.ts';
import type { PlaceBake, RowSnapshot, SceneSyncPort, VisualProxySoup } from '../../compat/core/ports.ts';
import type { RowRec } from '../../compat/core/types.ts';
import type { AtmosphereDef } from '../atmosphere/atmosphere.ts';
import type { DaylightOverrides } from '../atmosphere/daylight.ts';
import { installWorldLighting, type WorldLighting, type WorldLightingHost } from '../atmosphere/install.ts';
import { createScreenDisc, type ScreenDiscOptions } from '../atmosphere/screen-disc.ts';
import { postExposure } from '../post/render-pipeline.ts';
import { createModelRows, createRowTextures, type RowTextures } from '../bridge/attach.ts';
import type { ScriptRigs } from '../rig/script-rigs.ts';
import { installRenderBridge, type InstalledBridge, type RenderBridgeHost } from '../bridge/install.ts';
import type { FrameInfo } from '../engine/render-loop.ts';
import { createFxSystem, type FxRuntimeApi } from '../fx/fx-system.ts';
import { createFxWorkerSystem } from '../fx/fx-worker-runtime.ts';
import { FX_ATLAS_KEY, fxModeOf, setupFxRuntime, type FxModeChoice } from '../fx/fx-setup.ts';
import { defaultAtlasTexture, placeholderAtlasTexture } from '../fx/atlas-texture.ts';
import type { LodLevel, ScriptedSpec } from '../geometry/generator-types.ts';
import { MapBatcher, supportsMultiDraw } from '../geometry/map-batcher.ts';
import type { PackedKey } from '../geometry/pack.ts';
import { createModelLoaders, type ModelLoaders } from '../models/loaders.ts';
import { createModelLibrary, lowTierUrlModifier, type ModelLibraryControl } from '../models/model-library.ts';
import {
  bucketProgramVariants, bucketProxyFactory, enumerateVariants, templateTextureBindings, textureBindingKey, variantContentFromIndex, viewmodelPrimitiveVariants, warmUp, type ProgramVariant, type RowContent, type VariantContentInput,
  type WarmUpResult,
} from '../models/shader-variants.ts';
import { TextureCache } from '../models/texture-cache.ts';
import { TIER_IDS, tierConfig, type TierConfig, type TierId } from '../perf/budget.ts';
import type { TslLookModule } from '../post/look-runner.ts';
import { LookTable, ModelPaintTable, registerModelStages } from '../surface/look-table.ts';
import { isTextureScriptPath } from '../surface/material-spec.ts';
import { loadLightingScript } from '../surface/script-lighting-model.ts';
import type { LightingScript } from '../surface/script-types.ts';
import { SurfaceMaterials, SurfaceVariant, texSlotCount } from '../surface/surface-material.ts';
import { createTextureScripts } from '../surface/texture-script.ts';
import { HighlightRenderer, type HighlightStats } from '../special/highlight.ts';
import { RowShaker } from '../special/shake.ts';
import { ShockwaveRenderer, type ShockwaveStats } from '../special/shockwave.ts';
import { setFlatPrimitivesCentred, setPrimitiveAngleSupport } from '../geometry/primitives.ts';
import { setDissolveSupport } from '../surface/material-spec.ts';
import { RowFlasher } from '../special/row-flash.ts';
import { ScreenFlash } from '../special/screen-flash.ts';
import { SlashRenderer } from '../special/slash.ts';
import { RowSquasher } from '../special/squash.ts';
import { StringLights, type StringLightStats } from '../special/stringlight.ts';
import { createScriptedPrimitiveExtension } from '../special/scripted-primitive.ts';
import { ScriptedRowMaterials } from '../special/scripted-row-materials.ts';
import { WorldPanels, type WorldPanelStats } from '../special/world-panels.ts';
import { isFacingPlayerUi, WorldTags } from '../special/world-tags.ts';
import type { GoreRenderers, GoreRenderersOptions, GoreRenderStats } from './gore-renderers.ts';
import { buildVisualProxies } from './visual-proxies.ts';

/** how long a place build waits for the models its rows asked for before the warm-up runs without the late ones */
export const MODEL_WAIT_MS = 15_000;

/** a place's atmosphere `LayeredValue` as far as the render side reads it (core §5.5) */
export interface GameAtmosphereLayer {
  read(): Record<string, unknown>;
  onChange(fn: (composed: Record<string, unknown>, path: readonly string[]) => void): () => void;
}

/** the kernel members the render side of the game reads (`CoreKernel` fits) */
export interface GameKernel {
  readonly worldConfig: { readonly lighting?: string | undefined };
  readonly places: { readonly active: string | null; runtime(place: string): { readonly atmosphere: GameAtmosphereLayer } };
  readonly placeIndex: { readonly placeIndex: Readonly<Record<string, { readonly atmosphere?: unknown } | undefined>> };
  /** `running` false: the frame is not drawn (the LOADING hold, a host pause) */
  readonly clock: { readonly running: boolean };
}

/** the game data R6's variant enumeration reads (shader-variants.ts `VariantContentInput`); render code imports no game file */
export type GameVariantData = Pick<VariantContentInput, 'families' | 'boneCounts' | 'blendModels' | 'viewmodelDecal'> & {
  /**
   * RH1 (X-47): the tree paths of the carried texture scripts (`scripts/tex-beam.js`). Each is painted with the engine-load
   * warm-up, so a row that names one (team-glow's haze cones at PREP) draws its real texture from its first frame.
   */
  textureScripts?: readonly string[];
  /**
   * R12a (render §14.1): the tree paths of the carried material modules map rows name (`material: {kind: 'scripted',
   * script}`; live: authored content, the scripted row material). Each is loaded and built with the engine-load warm-up.
   */
  materialScripts?: readonly string[];
};

/** the bridge option for `GameDeps.rigs` (K3): present only when the game hands a rig cache */
export function rigsBridgeOption(deps: { rigs?: ScriptRigs | undefined }): { rigs?: ScriptRigs } {
  return deps.rigs === undefined ? {} : { rigs: deps.rigs };
}

export interface GameDeps {
  /** Explicit lighting module; null or omitted with no world config lighting uses unlit materials. */
  lightingScript?: string | null;
  vendor?: VendorUrls;
  dynamicTags?: readonly string[];
  ignoredTags?: readonly string[];
  panelFonts?: import('../special/world-panels.ts').PanelFonts;
  search?: string;
  /** Optional batching plugin; core rendering does not construct a gore system. */
  gorePlugin?: (options: Omit<GoreRenderersOptions, 'data'>) => GoreRenderers;
  kernel: GameKernel;
  /** K3: the main thread's rig cache; rigged map rows draw skinned and bind to the mixer. Absent: the legacy host (plain meshes). */
  rigs?: ScriptRigs;
  /**
   * A content script of the renderer by its tree path: the world's lighting module and the places' look scripts. They are
   * carried files that import `builtin/tsl`, so they are no registry modules (X-26); src/game-api/engine-content.ts loads them.
   */
  content: (path: string) => Promise<Record<string, unknown>>;
  /** X-42: `PhysicsPort.setVisualProxies` */
  setVisualProxies?: (place: string, soup: VisualProxySoup) => void;
  /** the game's data for the warm-up's model families; without it only the rows of a place are enumerated */
  variantData?: () => Promise<GameVariantData> | GameVariantData;
  /** true while nothing of the scene reaches the player (the menu covers it, the hold's backdrop): the warm-up's closing render may run */
  sceneHidden?: () => boolean;
  /** a malformed lighting module throws instead of drawing every surface unlit; default: dev builds */
  dev?: boolean;
  /** the app's device/mobile flag for the fx runtime (`FxSystemOptions.mobile`); undefined: the fx default */
  mobile?: boolean;
  /**
   * K8: also compile the stand-ins of the `flash` overlay and the `slash` ribbon with the first specials warm-up, so those acts
   * create no program after the LOADING gate. Default false (the legacy host: nothing routes at them, so the warm-up is unchanged).
   */
  warmK8Acts?: boolean;
  /** K13: honour `material.dissolve` (the DISSOLVE surface variant). Default false (the legacy host lists it as unsupported). */
  dissolve?: boolean;
  /** K13b: draw `highlightSet` style `outline` (and the default style, which is outline). Default false: the legacy host refuses it. */
  highlightOutline?: boolean;
  /** with `highlightOutline`: an `outline` mark on a scripted (map) row hulls the row's own meshes (promoting a batched row). Default false (the legacy host: model rows only) */
  highlightScriptedRows?: boolean;
  /** `pivot` on scripted (map) rows, as on primitives and models (`RenderBridgeDeps.scriptedPivot`). Default false (the legacy host: not applied) */
  scriptedPivot?: boolean;
  /** a `plane` / `circle` / `ring` / `torus` primitive without `anchor` stands by its centre (Spawn), not its lowest point. Default false */
  flatPrimitivesCentred?: boolean;
  /** K10b: draw per-vertex `{ colors }` of generated meshes (`InstallBridgeOptions.vertexColors`); needs geometry built with `vertexColors: true`. Default false. */
  vertexColors?: boolean;
  /**
   * Draw a primitive row (`plane`, `sphere`, …) whose `material` is `{ kind: 'scripted' }` with that material (a sky dome, a backdrop);
   * later writes of `material.params` move its `ctx.param` uniforms. Default false (the legacy host: logged as not drawn, the primitive draws plain).
   */
  scriptedPrimitives?: boolean;
  /**
   * K12: a row whose `ui` string is `<div facing="player" width="1.8m">…</div>` (a billboard name tag) is drawn as HTML anchored to the row
   * (render/special/world-tags.ts) instead of a canvas panel on its box. `true` makes a layer after the canvas; `{ container }` brings one.
   * Default false (the legacy host: every `ui` row is a canvas panel).
   */
  worldTags?: boolean | { container?: HTMLElement };
  /** R-4: honour the partial angles of `sphere` (`phiStart`, `phiLength`, `thetaStart`, `thetaLength`) and `ring` (`thetaStart`, `thetaLength`, `thetaSegments`). Default false (the legacy host: whole shapes) */
  primitiveAngles?: boolean;
  /** the game's fx atlas (a 4 x 4 grid, `FX_TEXTURES` order) by URL, instead of the asset index's `assets/fx/fx-atlas.png`; default: the index entry */
  fxAtlasUrl?: string;
  /** when no atlas resolves (or its file fails to load) fx run on a generated one (`fx/atlas-default.ts`) instead of staying off. Default false (the legacy host: fx off) */
  fxBuiltinAtlas?: boolean;
  /** with no atlas (and `fxBuiltinAtlas` off) fx still run for their `light()` sinks (torches, sconces), drawing no sprite. Default false (the legacy host: fx off) */
  fxLightsWithoutAtlas?: boolean;
  /** `align=axis` / `align=velocity` fx sprites as cards turned around their long axis (`FxSystemOptions.alignedCards`). Default false */
  fxAlignedCards?: boolean;
  /** `at=` fx particles (held glows and their lights) move with the row they are bound to (`FxSystemOptions.heldFollow`). Default false */
  fxHeldFollow?: boolean;
  /** `a..b` rolls inside its bounds by default (current the legacy host); explicit false keeps the legacy unit roll. */
  fxRangeRolls?: boolean;
  /**
   * DR-53: where the fx run. 'worker' (the fx Worker, fx-worker-runtime.ts) or 'inline' (the in-process runtime). Undefined:
   * `?fx=inline` of the page's query picks inline, a page without `Worker` too, anything else the worker.
   */
  fxMode?: FxModeChoice;
  log?: (message: string) => void;
}

/** what `installGame` needs of the render facade (`RenderFacade` of src/render/index.ts fits) */
export type GameHost = WorldLightingHost &
  { readonly atmosphereOptions?: { nightSky?: import('../atmosphere/sky.ts').NightSkyOptions; model?: 'night' | 'daylight'; sunSlot?: 0 | 1; sunDistance?: number; skyTint?: readonly [number, number, number]; skySaturation?: number; sunAzimuth?: number; sunElevation?: number; exposure?: number; screenDisc?: ScreenDiscOptions } } &
  RenderBridgeHost & {
    readonly loop: { setStage(stage: 'uploads' | 'fx' | 'corpses', run: ((frame: FrameInfo) => void) | null): void };
    readonly tier: TierId;
    readonly tierConfig: TierConfig;
    /** the governor's fx held-factor multiplier (render §15.2; the facade's); absent: 1 */
    readonly fxHeldScale?: number;
    readonly deps: { readonly assets: Pick<AssetResolver, 'resolve' | 'facts' | 'liveFacts' | 'index' | 'base'>; readonly geometry: unknown };
    setScenePort(port: SceneSyncPort | null): void;
    /**
     * X3: runs after a device-loss rebuild adopted the new engine and before pause `gpu` is released (the facade awaits it).
     * Absent on a host that never rebuilds.
     */
    onRebuild?(cb: () => Promise<void> | void): () => void;
  };

/** seams of the unit tests (a stand-in renderer has no KTX2 support to detect, no programs to compile) */
export interface GameSeams {
  createLoaders?: (renderer: WebGPURenderer, manager: LoadingManager) => Promise<Pick<ModelLoaders, 'gltf' | 'ktx2' | 'dispose'>>;
  lightingScript?: (kernel: GameKernel) => Promise<LightingScript | null>;
  warmUp?: typeof warmUp;
  /** R14b: the warm-up of the shadow state the tier is not in (`warmOtherShadow`); default: R6's `warmUp` */
  warmUpOther?: typeof warmUp;
  /** program creations so far (the facade's counter); default: three's `info.memory.programs` */
  programs?: () => number;
}

export interface GameWarmRun {
  /** `'engine'` or `place:<id>` */
  reason: string;
  variants: number;
  compiled: number;
  skipped: number;
  placeholders: number;
  programsCompiled: number;
  programsRendered: number;
  ms: number;
  /** the closing render ran on the hidden output or the scene-pass target */
  rendered: boolean;
}

/** R14b: what a warm-up linked for the tiers the session can switch to (the reachable tiers, see the header) */
export interface GameReachRun {
  /** the warm-up it followed (`'engine'`, `place:<id>`, `'rebuild'`, …) */
  reason: string;
  /** the shadowCaster's state the pass held: the one the tier is not in */
  shadow: 'on' | 'off';
  /** receiver and caster variants compiled in that state */
  variants: number;
  compiled: number;
  /** built places whose map's program shapes were drawn: in the tier's own state first, then in the other one */
  maps: string[];
  /** post graph shapes of other tiers drawn (`PostPipeline.warmTiers`) */
  postShapes: number;
  /** program creations during the pass (the counter of `GameSeams.programs`) */
  programs: number;
  ms: number;
}

/** plain data about what is installed, for the test hooks and the dev overlay */
export interface GameWorldInfo {
  /** the pipeline that draws the frame is R5b's post chain */
  postPipeline: boolean;
  post: {
    tonemapOrder: string;
    bloomKernel: string;
    fxaa: boolean;
    toneMapping: string;
    lookPath: string;
    identityLook: boolean;
    params: Record<string, number | number[]>;
    graphBuilds: number;
    /** R14b: the other tiers' graphs `warmTiers` built, and the shapes linked for the graph drawn now */
    tierWarm: { builds: number; shapes: string[] };
  } | null;
  /** the renderer's lighting system is the light grid */
  gridLighting: boolean;
  lights: { records: number; dynamic: number };
  atmosphere: { place: string | null; fogDensity: number; lookScript: string; ambient: number; pendingWrites: number };
  bridge: { rows: number; objects: number; lights: number; primitives: number; models: number };
  /** per built place: what the batcher split its scripted rows into */
  maps: Record<string, { chunks: number; instanced: number; singles: number }>;
  proxies: Record<string, { keys: number; instances: number }>;
  models: string[];
  warm: GameWarmRun[];
  /** R14b: the passes for the reachable tiers; `reachPending` is what waits for the next warm-up behind the hold */
  reach: GameReachRun[];
  reachPending: { maps: string[]; post: boolean };
  sceneTargetOpen: boolean;
  /** R7: corpses tracked, baking, batched; gibs batched */
  gore: GoreRenderStats | null;
  /** RH1: the teammate highlights held and drawn */
  highlights: HighlightStats;
  /** R12a: the world specials */
  specials: { panels: WorldPanelStats; stringlights: StringLightStats; shockwaves: ShockwaveStats; shakes: number; scriptedMaterials: number; warmed: boolean; scriptedWarmed: boolean; distortWarmed: boolean; fxDistortWarmed: boolean };
}

/** R12a: the render acts the app routes at the game's specials (engine-loader.ts); false: the payload was unusable */
export interface GameSpecialActs {
  shockwave(payload: unknown): boolean;
  shake(payload: unknown): boolean;
  /** K8: the `squash`, `flash` and `slash` acts (special/squash.ts, row-flash.ts, slash.ts); the kernel routes them once they are engine acts */
  squash?(payload: unknown): boolean;
  flash?(payload: unknown): boolean;
  slash?(payload: unknown): boolean;
  /** K8: the `screenFlash` act's state (special/screen-flash.ts): the UI chrome reads `screenFlash.rgba()` each frame */
  readonly screenFlash?: ScreenFlash;
}

export interface GameWorld {
  readonly lighting: WorldLighting;
  readonly installed: InstalledBridge;
  /**
   * R10: the fx runtime; null when its atlas could not be resolved or loaded (the bridge then draws no fx). The app routes game
   * `fx` / `fx-` acts at it. DR-53: the fx Worker's facade by default, the in-process runtime with `fxMode: 'inline'`.
   */
  readonly fx: FxRuntimeApi | null;
  readonly materials: SurfaceMaterials;
  readonly library: ModelLibraryControl;
  readonly viewmodelLibrary: ModelLibraryControl;
  /** the drawn model of a row (render's `ModelInstance`), for the skin adapter's rig; null while the row draws none */
  model(rowId: string): unknown | null;
  /**
   * Rig model space → the row's local frame, 16 numbers column-major: the model root's matrix under the row's object ×
   * `template.rigMatrix` (motion's `normalisation`, attach.ts). Null while the row draws no model. The array is reused.
   */
  rigFrame(rowId: string): ArrayLike<number> | null;
  /** settles when the warm-up started at install has ended (it never rejects) */
  warmed(): Promise<void>;
  /** RH1 (X-47): the `highlightSet` / `highlightClear` renderer, the act wiring's highlight sink */
  readonly highlights: HighlightRenderer;
  /** R12a: the `shockwave` and `shake` acts */
  readonly specials: GameSpecialActs;
  inspect(): GameWorldInfo;
  dispose(): void;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function getAt(root: unknown, path: readonly string[]): unknown {
  let cur = root;
  for (const s of path) {
    if (!isObj(cur) || !Object.prototype.hasOwnProperty.call(cur, s)) return undefined;
    cur = cur[s];
  }
  return cur;
}

/** the asset group that holds a row's model: the first group of its index entry, an empty group for a name the index does not hold */
function groupOf(assets: GameHost['deps']['assets'], row: RowSnapshot): string {
  const model = row.props['model'];
  const id = typeof model === 'string' ? model : isObj(model) && typeof model['id'] === 'string' ? model['id'] : '';
  const name = id.replace(/^\/?cdn\//, '');
  const entry = Object.prototype.hasOwnProperty.call(assets.index.entries, name) ? assets.index.entries[name] : undefined;
  return entry?.g?.[0] ?? '';
}

/** K12: the tag layer over the canvas and the camera maths behind it; null (logged) without a canvas to lay it over */
function createWorldTags(host: GameHost, o: { container?: HTMLElement }, log: (m: string) => void): WorldTags | null {
  const canvas = (host.engine as { canvas?: HTMLCanvasElement }).canvas;
  let container = o.container;
  if (container === undefined) {
    if (canvas === undefined || canvas.parentElement === null) {
      log('worldTags: no canvas to lay the tags over; facing="player" rows draw as canvas panels');
      return null;
    }
    container = canvas.ownerDocument.createElement('div');
    container.setAttribute('data-world-tags', '');
    Object.assign(container.style, { position: 'fixed', inset: '0', pointerEvents: 'none', overflow: 'hidden' });
    canvas.after(container);
  }
  const layer = container;
  const world = host.camera.world;
  const eye = new Vector3();
  const aim = new Vector3();
  const at = new Vector3();
  const field = (): { width: number; height: number; left: number; top: number } => {
    const r = canvas?.getBoundingClientRect();
    return r === undefined ? { width: layer.clientWidth, height: layer.clientHeight, left: 0, top: 0 } : { width: r.width, height: r.height, left: r.left, top: r.top };
  };
  const tags = new WorldTags({
    container: layer,
    camera: () => {
      world.updateMatrixWorld();
      world.getWorldPosition(eye);
      world.getWorldDirection(aim);
      return { eye, aim };
    },
    project: (p) => {
      const f = field();
      at.set(p.x, p.y, p.z).project(world);
      return { x: ((at.x + 1) / 2) * f.width, y: ((1 - at.y) / 2) * f.height };
    },
    viewport: field,
    pxPerMetre: (depth) => field().height / (2 * depth * Math.tan((world.fov * Math.PI) / 360)),
    log,
  });
  const dispose = tags.dispose.bind(tags);
  tags.dispose = (): void => {
    dispose();
    if (o.container === undefined) layer.remove();
  };
  return tags;
}

/** K14: the atmosphere options the facade was created with, as `installWorldLighting` takes them (nothing without them's night model) */
export function worldAtmosphereOption(host: { readonly atmosphereOptions?: { nightSky?: import('../atmosphere/sky.ts').NightSkyOptions; model?: 'night' | 'daylight'; sunSlot?: 0 | 1; sunDistance?: number; skyTint?: readonly [number, number, number]; skySaturation?: number; sunAzimuth?: number; sunElevation?: number } }): { atmosphere?: { nightSky?: import('../atmosphere/sky.ts').NightSkyOptions; model?: 'night' | 'daylight'; sunSlot?: 0 | 1; sunDistance?: number; daylight?: DaylightOverrides } } {
  const a = host.atmosphereOptions;
  if (a === undefined || (a.model === undefined && a.nightSky === undefined)) return {};
  // opt-in daylight overrides (sky tint / saturation, a pinned sun); none = the config decides, as before
  const daylight: DaylightOverrides = {
    ...(a.skyTint === undefined ? {} : { skyTint: a.skyTint }),
    ...(a.skySaturation === undefined ? {} : { skySaturation: a.skySaturation }),
    ...(a.sunAzimuth === undefined ? {} : { sunAzimuth: a.sunAzimuth }),
    ...(a.sunElevation === undefined ? {} : { sunElevation: a.sunElevation }),
  };
  return { atmosphere: { ...(a.model === undefined ? {} : { model: a.model }), ...(a.nightSky === undefined ? {} : { nightSky: a.nightSky }), ...(a.sunSlot === undefined ? {} : { sunSlot: a.sunSlot }), ...(a.sunDistance === undefined ? {} : { sunDistance: a.sunDistance }), ...(Object.keys(daylight).length > 0 ? { daylight } : {}) } };
}

/** opt-in: the scene gain before the output transform (`atmosphere.exposure`); nothing without it */
export function worldPostOption(host: { readonly atmosphereOptions?: { exposure?: number } }): { post?: { exposure: number } } {
  const e = postExposure(host.atmosphereOptions?.exposure);
  return e === undefined ? {} : { post: { exposure: e } };
}

/** Builds the render side of the game on the facade and wires it in. Call once, after `createRenderer`. */
export async function installGame(host: GameHost, deps: GameDeps, seams: GameSeams = {}): Promise<GameWorld> {
  const { kernel } = deps;
  const log = deps.log ?? ((m: string): void => console.warn(m));
  const assets = host.deps.assets;
  const renderer = (): WebGPURenderer => host.engine.renderer as unknown as WebGPURenderer;
  const undo: Array<() => void> = [];
  if (deps.primitiveAngles === true) {
    setPrimitiveAngleSupport(true);
    undo.push(() => setPrimitiveAngleSupport(false));
  }
  if (deps.flatPrimitivesCentred === true) {
    setFlatPrimitivesCentred(true);
    undo.push(() => setFlatPrimitivesCentred(false));
  }
  if (deps.dissolve === true) {
    setDissolveSupport(true);
    undo.push(() => setDissolveSupport(false));
  }
  const cleanup = (): void => {
    for (const off of undo.splice(0).reverse()) {
      try {
        off();
      } catch (e) {
        console.error('[game] a dispose step threw', e);
      }
    }
  };

  try {
    // ── R4: the light grid, the post chain, the atmosphere, the shadowCaster ─────────────────────────────────────────────
    const lighting = installWorldLighting(host, {
      loadLook: async (script) => (await deps.content(script)) as unknown as TslLookModule,
      warn: log,
      ...worldAtmosphereOption(host),
      ...worldPostOption(host),
    });
    undo.push(() => lighting.dispose());
    // opt-in: the camera-locked disc over a backdrop that writes no depth (atmosphere/screen-disc.ts)
    const discOpts = host.atmosphereOptions?.screenDisc;
    if (discOpts !== undefined) {
      const disc = createScreenDisc(discOpts);
      host.root.scene.add(disc.mesh);
      undo.push(() => disc.dispose());
    }

    // ── R1a: the lighting module and the variant cache every surface of the game comes from ────────────────────────────
    const script = await (seams.lightingScript
      ? seams.lightingScript(kernel)
      : (deps.lightingScript === null || (deps.lightingScript ?? kernel.worldConfig.lighting) === undefined ? null : loadLightingScript({ load: (path) => deps.content(path) }, (deps.lightingScript ?? kernel.worldConfig.lighting)!, deps.dev === undefined ? {} : { dev: deps.dev })));
    const materials = new SurfaceMaterials({ script });

    // ── R6: the model libraries ───────────────────────────────────────────────────────────────────────────────────────
    const look = new LookTable();
    const paint = new ModelPaintTable();
    registerModelStages(materials, { look, paint });
    const manager = new LoadingManager();
    // tier `minimum` loads the 512² texture variants: a glTF names its textures by URL (model-library.ts)
    if (host.tier === 'minimum') manager.setURLModifier(lowTierUrlModifier(assets));
    const loaders = await (seams.createLoaders ? seams.createLoaders(renderer(), manager) : createModelLoaders(renderer(), { ...(deps.vendor === undefined ? {} : { vendor: deps.vendor }), manager }));
    undo.push(() => loaders.dispose());
    const textures = new TextureCache({ onDispose: (key) => loaders.ktx2.forget(key) });
    const loadGltf = (url: string) => loaders.gltf.loadAsync(url);
    const library = createModelLibrary({ resolver: assets, env: { materials, paint, textures }, loadGltf, log });
    // camera-attached rows: the same files, templates with the VIEWMODEL bit (R8)
    const viewmodelLibrary = createModelLibrary({ resolver: assets, env: { materials, paint, textures, variant: SurfaceVariant.VIEWMODEL }, loadGltf, log });
    undo.push(() => library.dispose(), () => viewmodelLibrary.dispose());

    // ── the scene-pass target (see the header) ─────────────────────────────────────────────────────────────────────────
    let sceneTargetOpen = 0;
    const sceneTarget = (): RenderTarget | null => (lighting.post.pipeline?.scenePass as unknown as { renderTarget?: RenderTarget } | undefined)?.renderTarget ?? null;
    const withSceneTarget = async <T>(fn: () => Promise<T>): Promise<T> => {
      const target = sceneTarget();
      if (target === null) return fn();
      const r = renderer();
      if (sceneTargetOpen++ === 0) r.setRenderTarget(target);
      try {
        return await fn();
      } finally {
        if (--sceneTargetOpen === 0) r.setRenderTarget(null);
      }
    };

    // ── R13: rows → render ────────────────────────────────────────────────────────────────────────────────────────────
    let installed: InstalledBridge | null = null;
    const textureLoader = new TextureLoader(manager);
    // RH1 (X-47): a `material.texture` naming a texture script (`scripts/tex-beam.js`) is painted by the runner, once per path
    const textureScripts = createTextureScripts({ load: (path) => deps.content(path), log });
    undo.push(() => textureScripts.dispose());
    const rowTextures: RowTextures = createRowTextures({
      resolve: (name) => (isTextureScriptPath(name) ? name : assets.resolve(name)),
      load: async (url, name) => {
        if (isTextureScriptPath(name)) return textureScripts.texture(name);
        if (/\.ktx2(\?|$)/.test(url)) return (await loaders.ktx2.loadAsync(url)) as unknown as Texture;
        const texture = await textureLoader.loadAsync(url);
        texture.colorSpace = SRGBColorSpace;
        return texture;
      },
      onReady: (name, texture) => installed?.setTexture(name, texture),
      log,
    });
    undo.push(() => rowTextures.dispose());

    // ── R10: the fx runtime (render §13) ──────────────────────────────────────────────────────────────────────────────
    // Built here so the bridge takes it as its `fx` dependency and the loop's `fx` stage advances it below. Without the
    // atlas texture there is nothing to draw with: warn and run with null fx, which the bridge already tolerates (an
    // `fx` row keeps its transform and draws no effect). The atlas is loaded separately from the row textures, so the
    // setup owns its disposal (`FxSetup.dispose`, on the undo chain below).
    const fxSetup = await setupFxRuntime({
      resolveAtlas: () => {
        // `AssetResolver.resolve()` may return null: a missing atlas entry means fx stays off, never a throw.
        if (deps.fxAtlasUrl !== undefined) return deps.fxAtlasUrl;
        const url = assets.resolve(FX_ATLAS_KEY);
        return typeof url === 'string' ? url : null;
      },
      loadAtlas: async (url) => {
        const texture = await textureLoader.loadAsync(url);
        texture.colorSpace = SRGBColorSpace;
        return texture;
      },
      ...(deps.fxBuiltinAtlas === true ? { builtinAtlas: defaultAtlasTexture } : {}),
      ...(deps.fxLightsWithoutAtlas === true ? { lightsOnlyAtlas: placeholderAtlasTexture } : {}),
      ...(deps.fxAlignedCards === true ? { alignedCards: true } : {}),
      ...(deps.fxHeldFollow === true ? { heldFollow: true } : {}),
      ...(deps.fxRangeRolls === undefined ? {} : { rangeRolls: deps.fxRangeRolls }),
      world: host.root.world,
      // DSL `follow=camera` (weather follows the viewer in world projection); viewmodel FX stays a separate gap
      camera: host.camera.world as unknown as Object3D,
      // F3: `distort` sprites (relay-mother's haze and scream ring) draw as offsets in the pipeline's distort pass
      distortScene: () => lighting.post.pipeline?.distortScene ?? null,
      tier: () => host.tier,
      tierConfig: () => host.tierConfig,
      lighting: script,
      lights: lighting.lights,
      mobile: deps.mobile,
      heldScale: () => host.fxHeldScale ?? 1,
      // DR-53: the fx simulation in a Worker; the in-process runtime on `?fx=inline`, on a page without workers, and as the
      // facade's own fallback when the worker cannot start or fails
      create: (options) => (fxModeOf(deps.fxMode, deps.search ?? '', typeof (globalThis as { Worker?: unknown }).Worker === 'function') === 'worker' ? createFxWorkerSystem(options) : createFxSystem(options)),
      log,
    });
    const fx = fxSetup.fx;
    undo.push(() => fxSetup.dispose());

    let inner: SceneSyncPort | null = null;
    const bridgeHost: RenderBridgeHost = {
      root: host.root,
      camera: host.camera,
      loop: host.loop,
      deps: host.deps as RenderBridgeHost['deps'],
      get engine() {
        return host.engine;
      },
      get tier() {
        return host.tier;
      },
      get feed() {
        return host.feed;
      },
      // the bridge's own port: `facade.scene` forwards to the game's port below, which wraps it
      setScenePort(port) {
        inner = port;
      },
    };
    // the model rows, with the loads in flight counted: a place build warms the variants once its models are there
    const modelRows = createModelRows({ library, viewmodelLibrary, look, group: (row) => groupOf(assets, row), log });
    const modelLoads = new Set<Promise<unknown>>();
    const models: typeof modelRows = {
      ...modelRows,
      create(row, o) {
        const made = modelRows.create(row, o);
        if (made instanceof Promise) {
          const settled = made.then(
            () => undefined,
            () => undefined,
          );
          modelLoads.add(settled);
          void settled.then(() => modelLoads.delete(settled));
          // the row is exposed only after its bindings are warmed: queue the late warm-up for the resolved model's
          // real bindings, then resolve once the warm-up chain has run it (a failed load still rejects with its error)
          return made.then(
            (model) => {
              warmLateBindings();
              return warmChain.then(() => model);
            },
            (e: unknown) => {
              warmLateBindings();
              return warmChain.then(() => Promise.reject(e));
            },
          );
        }
        // The template was already loaded, but its bindings may still be new to every warm-up (it settled during another
        // place's build, after that build's warm-up read the templates, or was loaded outside `models.create`). When the
        // late check queues a warm-up for them, the row is exposed only once the chain has run it; otherwise it is placed
        // now, as before (a sync model stays sync: no frame without the row's body).
        if (made === null || !warmLateBindings()) return made;
        return warmChain.then(() => made);
      },
    };
    const modelsLoaded = async (): Promise<void> => {
      if (modelLoads.size === 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, MODEL_WAIT_MS);
      });
      await Promise.race([Promise.all([...modelLoads]), late]);
      clearTimeout(timer);
    };
    // ── R7: corpses and gibs (render §11.5, §11.6) ──────────────────────────────────────────────────────────────────
    // the game data and the warm-up's keys are read when a corpse or gib row appears (both are set up further down)
    let programWarmed: (key: string) => boolean = () => false;
    const gore = deps.gorePlugin?.({
      scene: host.root.world,
      look,
      materials,
      templates: library,
      tier: () => host.tier,
      multiDraw: () => supportsMultiDraw(renderer() as unknown as { backend?: unknown }),
      warmed: (key) => programWarmed(key),
      shadows: () => host.tierConfig.shadowCasterMapSize > 0,
      log,
    });
    // ── R12a: the specials that ride on the bridge's rows (render §14.1, §14.4, §14.5) ──────────────────────────────
    const scriptedMaterials = new ScriptedRowMaterials({ load: (path) => deps.content(path), ...(deps.dev === undefined ? {} : { dev: deps.dev }), log });
    undo.push(() => scriptedMaterials.dispose());
    // lit surfaces under the world's lighting module, the texture on the emissive (render §14.4)
    const panels = new WorldPanels({ script, log, ...(deps.panelFonts === undefined ? {} : { fonts: deps.panelFonts }) });
    undo.push(() => panels.dispose());
    const tags = deps.worldTags === undefined || deps.worldTags === false ? null : createWorldTags(host, deps.worldTags === true ? {} : deps.worldTags, log);
    if (tags !== null) undo.push(() => tags.dispose());
    const stringLights = new StringLights({ log });
    undo.push(() => stringLights.dispose());
    const bridgeInstalled = installRenderBridge(bridgeHost, {
      script,
      ...(deps.search === undefined ? {} : { search: deps.search }),
      extensions: {
        ui: tags === null ? panels.extension : (row, node) => (isFacingPlayerUi(row.props['ui']) ? tags.extension(row, node) : panels.extension(row, node)),
        spline: stringLights.extension,
        ...(deps.scriptedPrimitives === true ? { scriptedMaterial: createScriptedPrimitiveExtension({ load: (path) => deps.content(path), ...(deps.dev === undefined ? {} : { dev: deps.dev }), log }) } : {}),
      },
      ...rigsBridgeOption(deps),
      ...(deps.scriptedPivot === true ? { scriptedPivot: true } : {}),
      scriptedMaterial: (spec) => scriptedMaterials.get(spec),
      ...(deps.vertexColors === true ? { vertexColors: true } : {}),
      materials,
      lights: lighting.lights,
      directional: lighting.moons,
      models,
      fx,
      ...(gore === undefined ? {} : { handoff: gore.handoff, bones: (rowId: string, bone: string) => gore.bones(rowId, bone) }),
      ...(deps.dynamicTags === undefined ? {} : { dynamicTags: deps.dynamicTags }),
      resolveTexture: (name) => rowTextures.get(name),
      onPlaceBounds: (_place, bounds) => lighting.lighting.setBounds(bounds),
      withSceneTarget,
      log,
    });
    installed = bridgeInstalled;
    undo.push(() => bridgeInstalled.dispose());
    // before the bridge on the undo chain: the batches and the baker go first, the bridge then disposes the models it holds
    undo.push(() => gore?.dispose());
    const bridgePort = inner as SceneSyncPort | null;
    if (bridgePort === null) throw new Error('installGame: the render bridge installed no scene port');

    // ── RH1: teammate highlights (X-47), on the bridge's rows; the act wiring attaches it as its highlight sink ─────────
    const eye = new Vector3();
    const highlights = new HighlightRenderer({
      node: (rowId) => bridgeInstalled.bridge.node(rowId),
      look,
      eye: () => eye.setFromMatrixPosition((host.camera.world as Camera).matrixWorld),
      log,
      ...(deps.highlightOutline === true ? { outline: true } : {}),
      ...(deps.highlightOutline === true && deps.highlightScriptedRows === true ? { rowMeshes: (rowId: string) => bridgeInstalled.bridge.rowMeshes(rowId) } : {}),
    });
    undo.push(() => highlights.dispose());

    // ── R12a: the `shockwave` rings and the `shake` jitter (render §14.7, §10.7) ─────────────────────────────────────
    /** R14b: the reachable tiers' post warm draws a graph with the distort pass on a tier without one (`warmPostTiers`) */
    let warmingDistortGraph = false;
    const shockwaves = new ShockwaveRenderer({
      world: host.root.world,
      distortScene: () => lighting.post.pipeline?.distortScene ?? null,
      distortEnabled: () => host.tierConfig.distort || warmingDistortGraph,
    });
    undo.push(() => shockwaves.dispose());
    const shaker = new RowShaker({ setRowOffset: (rowId, offset) => bridgeInstalled.bridge.setRowOffset(rowId, offset) });
    undo.push(() => shaker.dispose());
    // K8: the `squash` / `flash` / `slash` acts and the `screenFlash` state (additive: nothing routes at them until the kernel does)
    const squasher = new RowSquasher({ setRowScale: (rowId, factor) => bridgeInstalled.bridge.setRowScale(rowId, factor) });
    undo.push(() => squasher.dispose());
    const flasher = new RowFlasher({ node: (rowId) => bridgeInstalled.bridge.node(rowId), look });
    undo.push(() => flasher.dispose());
    const slashes = new SlashRenderer({ world: host.root.world });
    undo.push(() => slashes.dispose());
    const screenFlash = new ScreenFlash();

    // ── the loop's `uploads` stage: the look and paint tables of the models, and the canvas for the draw ───────────────
    host.loop.setStage('uploads', (frame) => {
      const r = renderer();
      // R12a: presentation time (a paused or hit-stopped frame does not advance them); a shake's offset reaches the row in
      // the next frame's bridge stage
      shockwaves.update(frame.dt);
      shaker.update(frame.dt);
      squasher.update(frame.dt);
      flasher.update(frame.dt);
      slashes.update(frame.dt);
      screenFlash.update(frame.dt);
      tags?.frame();
      // RH1: after every stage that places rows and models, before the tables go up and the frame is drawn
      highlights.update(frame.dt);
      look.flush(r);
      paint.flush(r);
      if (sceneTargetOpen > 0) {
        const target = r.getRenderTarget();
        if (target !== null) {
          r.setRenderTarget(null);
          queueMicrotask(() => {
            if (sceneTargetOpen > 0) renderer().setRenderTarget(sceneTarget());
          });
        }
      }
    });
    undo.push(() => host.loop.setStage('uploads', null));

    // ── R7: the loop's `corpses` stage (after the bridge and the mixer wrote the bones): stillness, the bake slice, budgets
    host.loop.setStage('corpses', gore === undefined ? null : () => gore.update());
    undo.push(() => host.loop.setStage('corpses', null));

    // ── R10: the loop's `fx` stage (after `corpses`, before `decals`/`lights`): advances the runtime ───────────────────
    if (fx !== null) {
      host.loop.setStage('fx', (frame) => fx.update(frame));
      undo.push(() => host.loop.setStage('fx', null));
    }

    // ── the atmosphere of the place on screen ──────────────────────────────────────────────────────────────────────────
    let atmospherePlace: string | null = null;
    let offWrites: (() => void) | null = null;
    const loadAtmosphere = (place: string): void => {
      if (atmospherePlace === place) return;
      offWrites?.();
      offWrites = null;
      const layer = kernel.places.runtime(place).atmosphere;
      lighting.atmosphere.load(layer.read() as AtmosphereDef, kernel.placeIndex.placeIndex[place]?.atmosphere as AtmosphereDef | undefined);
      atmospherePlace = place;
      // `LayeredValue.onChange(composed, path)` → `onWrite(path, value)`: the composed value at the path, undefined for a delete
      offWrites = layer.onChange((composed, path) => lighting.atmosphere.onWrite(path, getAt(composed, path)));
    };
    undo.push(() => offWrites?.());

    // ── the warm-up (render §7.2) ──────────────────────────────────────────────────────────────────────────────────────
    const warm: GameWarmRun[] = [];
    /** the shadowCaster casts on the tier now */
    const shadowsNow = (): boolean => host.tierConfig.shadowCasterMapSize > 0;
    /**
     * R14b: a receiver's colour form is the one program whose text holds the shadowCaster's shadow state (three builds the
     * shadow term into a lit surface with `receiveShadow` while the light casts); a caster's depth form exists only with the
     * shadow on, every other form is the same text in both states. Its coverage record therefore names the state.
     */
    const stateBound = (v: Pick<ProgramVariant, 'receiveShadow' | 'depth'>): boolean => v.receiveShadow && !v.depth;
    /** the coverage record of a variant compiled in a shadow state */
    const cover = (v: Pick<ProgramVariant, 'key' | 'receiveShadow' | 'depth'>, shadows: boolean): string => (stateBound(v) ? `${v.key}@${shadows ? 'shadow' : 'flat'}` : v.key);
    /** the same of a bare variant key (`programVariant`: `depth:` first for a depth form, `/rs` last for a receiver's colour form) */
    const coverOfKey = (key: string, shadows: boolean): string => cover({ key, depth: key.startsWith('depth:'), receiveShadow: key.endsWith('/rs') }, shadows);
    /** variants that were compiled, by coverage record: never warmed again (textured skinned variants are covered per binding, below) */
    const warmedKeys = new Set<string>();
    /**
     * Textured skinned variants are covered per texture binding in use: the binding keys (`textureBindingKey`) already
     * warmed, by variant key; the variant key alone never marks these covered. With stable program text a new binding
     * links no program (its stand-in compile did, `standInKeys`): its warm-up builds the binding's material before its
     * bodies draw.
     */
    const warmedBindings = new Map<string, Set<string>>();
    /** every texture binding key a warm-up has seen: a late model load with a new one queues another warm-up */
    const warmedBindingKeys = new Set<string>();
    /**
     * Textured skinned variants compiled once with stand-in textures while no template of their size was loaded (an enemy's
     * model loads when its first row appears, in the wave). The shader text names neither a texture nor a node
     * (src/render/engine/stable-programs.ts), so that compile links the program the real bodies draw with; the per-binding
     * coverage above still follows once real bindings exist.
     */
    const standInKeys = new Set<string>();
    /** model bindings settling during any place build are warmed by its queued place warm-up */
    let placeBuilds = 0;
    const runWarmUp = seams.warmUp ?? warmUp;
    /**
     * Every program of a primitive bucket and of a camera-attached primitive (a script can spawn a row of any look at PREP or
     * in the wave: team-glow's haze cones, camera-attached decal): part of the engine-load set, so compiled once, by the first warm-up
     * that has the game's data (`variantData`; without it only a place's rows are enumerated)
     */
    const bucketVariants = [...bucketProgramVariants(), ...viewmodelPrimitiveVariants()];
    const bucketProxy = bucketProxyFactory(script);
    let variantData: GameVariantData | null = null;
    // the gore batches ask for the forms their batch draws with now: in the tier's own shadow state
    programWarmed = (key) => warmedKeys.has(coverOfKey(key, shadowsNow()));
    let warmChain: Promise<void> = Promise.resolve();
    /** the templates the libraries hold now (world and camera-attached) */
    const loadedTemplates = () => [...library.loaded().map((n) => library.get(n)!), ...viewmodelLibrary.loaded().map((n) => viewmodelLibrary.get(n)!)];
    type TextureSets = ReturnType<typeof templateTextureBindings>;
    /** a textured skinned variant, colour or depth, is one program per binding in use: never covered by its key alone */
    const perBinding = (v: ProgramVariant): boolean => v.kind === 'skinned' && texSlotCount(v.variant) > 0;
    /** the variants of `list` a warm-up in `shadows` still has to compile (the coverage records; per binding where it applies) */
    const selectVariants = (list: readonly ProgramVariant[], shadows: boolean, textureSets: TextureSets, bindingKeys: readonly string[]): ProgramVariant[] =>
      list.filter((v) => {
        const c = cover(v, shadows);
        if (warmedKeys.has(c)) return false;
        if (perBinding(v)) {
          const seen = warmedBindings.get(c);
          const size = texSlotCount(v.variant);
          // no binding of its size yet: once, with stand-ins (`standInKeys`)
          if (!textureSets.some((b) => b.length === size)) return !standInKeys.has(c);
          return textureSets.some((b, i) => b.length === size && !(seen?.has(bindingKeys[i]!) ?? false));
        }
        return true;
      });
    /** records what a warm-up in `shadows` compiled; its bindings are covered now, so a later settle will not re-queue for them */
    const recordCompiled = (result: WarmUpResult, variants: readonly ProgramVariant[], shadows: boolean, textureSets: TextureSets, bindingKeys: readonly string[]): void => {
      const placeholders = new Set(result.placeholders);
      const byKey = new Map(variants.map((v) => [v.key, v] as const));
      for (const key of result.compiled) {
        const v = byKey.get(key);
        const c = v === undefined ? key : cover(v, shadows);
        // a textured skinned variant compiled while no binding of its size was loaded: stand-ins only (`standInKeys`)
        if (placeholders.has(key) || (v !== undefined && perBinding(v) && !textureSets.some((b) => b.length === texSlotCount(v.variant)))) {
          standInKeys.add(c);
          continue;
        }
        if (v !== undefined && perBinding(v)) {
          const seen = warmedBindings.get(c) ?? new Set<string>();
          warmedBindings.set(c, seen);
          const size = texSlotCount(v.variant);
          textureSets.forEach((b, i) => {
            if (b.length === size) seen.add(bindingKeys[i]!);
          });
        } else {
          warmedKeys.add(c);
        }
      }
      for (const key of bindingKeys) warmedBindingKeys.add(key);
    };
    /** primitive bucket meshes compiled against the scene-pass target (a bucket that grows gets a new mesh: compiled again) */
    let warmedBucketMeshes = new WeakSet<Object3D>();
    /**
     * The primitive buckets (render §6.7) are made on a row's first add and have no variant in the enumeration: compile the
     * meshes of the buckets that exist now and no warm-up has compiled, under the warm-up rule (`MapBatcher.warm`: visible,
     * never frustum-culled, an empty bucket given one instance, layers 0 to 2), so a bucket out of the camera's view is
     * compiled too. Call it with the scene-pass target current (`withSceneTarget`): programs are keyed on it. Buckets do
     * not cast, so there are no depth programs to close. A bucket made later (a row spawned at PREP) draws with the program
     * `bucketVariants` linked for its bits: a bucket's text names no node and no capacity (engine/stable-programs.ts).
     */
    const warmBuckets = async (r: WebGPURenderer): Promise<void> => {
      const camera = host.camera.world as Camera;
      const scene = host.root.scene as Scene;
      for (const bucket of bridgeInstalled.primitives.buckets()) {
        const mesh = bucket.mesh;
        if (warmedBucketMeshes.has(mesh)) continue;
        try {
          await MapBatcher.warm([mesh], camera, () => r.compileAsync(mesh, camera, scene));
          warmedBucketMeshes.add(mesh);
        } catch (e) {
          // a bucket that fails to compile draws unwarmed (its program compiles at its first draw); the warm-up goes on
          log(`[game] a primitive bucket (${bucket.key}) did not compile in the warm-up: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    };
    /**
     * The fx runtime's bucket stand-ins (`FxRuntime.warmObjects`: every sprite and stretched bucket an effect can fill),
     * compiled once, with the engine-load set (by the first warm-up that has the game's data), under the warm-up rule and
     * against the scene-pass target: an effect first seen at PREP or in the wave then draws with a program linked behind
     * the menu.
     */
    let fxWarmed = false;
    const warmFx = async (r: WebGPURenderer): Promise<void> => {
      if (fx === null || fxWarmed || variantData === null) return;
      fxWarmed = true;
      const camera = host.camera.world as Camera;
      const scene = host.root.scene as Scene;
      for (const object of fx.warmObjects()) {
        try {
          await MapBatcher.warm([object], camera, () => r.compileAsync(object, camera, scene));
        } catch (e) {
          log(`[game] an fx bucket (${object.name}) did not compile in the warm-up: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    };
    /**
     * RH1's silhouette stand-ins (`HighlightRenderer.warmObjects`: both materials on a plain mesh and a skinned mesh per
     * bone-count class), compiled once, with the engine-load set, under the warm-up rule and against the scene-pass target:
     * a mark that arrives at PREP, or a teammate going down in the wave, draws with programs linked behind the menu. The
     * stand-ins are kept (a disposed object could take its program with it).
     */
    let highlightsWarmed = false;
    const warmHighlights = async (r: WebGPURenderer): Promise<void> => {
      if (highlightsWarmed) return;
      highlightsWarmed = true;
      const camera = host.camera.world as Camera;
      const scene = host.root.scene as Scene;
      for (const object of highlights.warmObjects()) {
        try {
          await MapBatcher.warm([object], camera, () => r.compileAsync(object, camera, scene));
        } catch (e) {
          log(`[game] a highlight stand-in (${object.name}) did not compile in the warm-up: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    };
    /**
     * R12a's stand-ins (both panel gains, the string-light cable and bulbs, the shockwave ring: with the first warm-up; the
     * scripted materials of map rows on the batcher's single-row geometry: with the first warm-up that has the game's data,
     * which names their modules), compiled once, under the warm-up rule and against the scene-pass target (the shockwave's
     * offset ring: `distortWarmed` below). A trail spawned at PREP, a panel or a string light of a place built later, and a
     * shockwave in the wave then draw with programs linked behind the menu.
     */
    let specialsWarmed = false;
    let scriptedWarmed = false;
    const warmSpecials = async (r: WebGPURenderer): Promise<void> => {
      const objects: Object3D[] = [];
      if (!scriptedWarmed && variantData !== null) {
        scriptedWarmed = true;
        objects.push(...scriptedMaterials.warmObjects());
      }
      const first = !specialsWarmed;
      if (first) {
        specialsWarmed = true;
        objects.push(...panels.warmObjects(), ...stringLights.warmObjects(), ...shockwaves.warmObjects());
        if (deps.warmK8Acts === true) objects.push(...flasher.warmObjects(), ...slashes.warmObjects());
      }
      const camera = host.camera.world as Camera;
      const scene = host.root.scene as Scene;
      for (const object of objects) {
        try {
          await MapBatcher.warm([object], camera, () => r.compileAsync(object, camera, scene));
        } catch (e) {
          log(`[game] a special's stand-in (${object.name}) did not compile in the warm-up: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    };
    /**
     * The shockwave's offset ring writes the distort pass's RG format, so its program is linked only by that pass: it is
     * drawn at zero gain in the first warm-up's closing render of the pipeline (`ShockwaveRenderer.armDistortWarm`), on a
     * tier that draws the pass.
     */
    let distortWarmed = false;
    /** F3: the fx `distort` sprites' programs, linked the same way (`FxRuntime.armDistortWarm`) */
    let fxDistortWarmed = false;
    const warmNow = async (reason: string, rows: readonly RowContent[]): Promise<void> => {
      if (variantData === null && deps.variantData !== undefined) {
        variantData = await deps.variantData();
        // RH1: the texture scripts run now, behind the menu (each once; a failure is logged and its rows draw white)
        await Promise.all((variantData.textureScripts ?? []).map((path) => textureScripts.texture(path).catch(() => undefined)));
        for (const path of variantData.textureScripts ?? []) rowTextures.get(path);
        // R12a: the material modules of map rows, built now (the map asks for them synchronously)
        await scriptedMaterials.preload(variantData.materialScripts ?? []);
      }
      const r = renderer();
      const shadows = shadowsNow();
      const multiDraw = supportsMultiDraw(r as unknown as { backend?: unknown });
      const content =
        variantData === null
          ? { families: [], viewmodelDecal: null, shadows, multiDraw, rows, extra: [] }
          : variantContentFromIndex({ index: assets.index, ...variantData, shadows, multiDraw, rows, extra: bucketVariants });
      const textureSets = templateTextureBindings(loadedTemplates());
      const bindingKeys = textureSets.map(textureBindingKey);
      const variants: ProgramVariant[] = selectVariants(enumerateVariants(content), shadows, textureSets, bindingKeys);
      if (variants.length === 0) {
        // nothing new to enumerate, but this build may have made primitive buckets no warm-up has compiled (and, with no
        // game data, the first warm-up has nothing else to compile: RH1's silhouettes still go now)
        await withSceneTarget(async () => {
          await warmBuckets(r);
          await warmHighlights(r);
          await warmSpecials(r);
        });
        for (const key of bindingKeys) warmedBindingKeys.add(key);
        return;
      }
      const hidden = deps.sceneHidden?.() ?? !kernel.clock.running;
      let closingRendered = false;
      const pipelineRender = (): void => {
        // the frame's own render: the pipeline draws the scene into its pass and the output into the canvas
        closingRendered = true;
        const current = r.getRenderTarget();
        r.setRenderTarget(null);
        try {
          lighting.post.pipeline?.render();
        } finally {
          r.setRenderTarget(current);
        }
      };
      const targetRender = (): void => {
        // A null target is the canvas, so visible warm-up proxies must never render there.
        if (r.getRenderTarget() === null) return;
        closingRendered = true;
        r.render(host.root.scene as Scene, host.camera.world as Camera);
      };
      const t0 = performance.now();
      const result: WarmUpResult = await withSceneTarget(async () => {
        // R12a: the offset ring in the closing render's distort pass (only the pipeline's render draws that pass)
        const distortArm = !distortWarmed && hidden ? shockwaves.armDistortWarm() : null;
        const fxDistortArm = !fxDistortWarmed && hidden ? (fx?.armDistortWarm() ?? null) : null;
        let res: WarmUpResult;
        try {
          res = await runWarmUp(r, host.root.scene as Scene, host.camera.world as Camera, variants, { materials, look, paint, textureSets }, {
            proxies: [bucketProxy],
            render: pipelineRender,
            ...(hidden ? {} : { render: targetRender }),
            ...(seams.programs === undefined ? {} : { programs: seams.programs }),
          });
        } finally {
          distortArm?.done();
          fxDistortArm?.done();
        }
        if (distortArm?.armed === true && closingRendered) distortWarmed = true;
        if (fxDistortArm?.armed === true && closingRendered) fxDistortWarmed = true;
        await warmBuckets(r);
        await warmFx(r);
        await warmHighlights(r);
        await warmSpecials(r);
        return res;
      });
      // the warm-up ran to completion: what it compiled is covered now (in this shadow state where the text holds one), and
      // its bindings too. A failed warm-up marks nothing, so the next settle retries it.
      recordCompiled(result, variants, shadows, textureSets, bindingKeys);
      warm.push({
        reason,
        variants: variants.length,
        compiled: result.compiled.length,
        skipped: result.skipped.length,
        placeholders: result.placeholders.length,
        programsCompiled: result.programsCompiled,
        programsRendered: result.programsRendered,
        ms: performance.now() - t0,
        rendered: closingRendered,
      });
    };
    // ── R14b: the reachable tiers (see the header) ──────────────────────────────────────────────────────────────────────
    const reach: GameReachRun[] = [];
    /** what a warm-up with the scene on screen left for the next one behind the hold: places whose maps wait, the post graphs */
    const reachPending = { maps: new Set<string>(), post: false };
    const runOtherWarmUp = seams.warmUpOther ?? warmUp;
    const programsNow = (r: WebGPURenderer): number => seams.programs?.() ?? (r.info.memory as unknown as { programs: number }).programs;
    /** the shadow states in which each built map's shapes were drawn on this renderer (`drawMapShapes`) */
    let mapShapesDrawn = new WeakMap<MapBatcher, Set<boolean>>();
    const mapDrawn = (b: MapBatcher, shadows: boolean): boolean => mapShapesDrawn.get(b)?.has(shadows) ?? false;
    const markMap = (b: MapBatcher, shadows: boolean): void => {
      const states = mapShapesDrawn.get(b) ?? new Set<boolean>();
      states.add(shadows);
      mapShapesDrawn.set(b, states);
    };
    /**
     * What decides a map mesh's program text besides the light's state: its materials, its kind, its geometry's attribute
     * set (three's `getGeometryCacheKey`, and the array type, which picks the GLSL type), its receive and cast flags, its
     * layers. Meshes of one key are one program.
     */
    const shapeKey = (o: Object3D): string => {
      const m = o as Mesh & { isInstancedMesh?: boolean; isBatchedMesh?: boolean; isSkinnedMesh?: boolean; instanceColor?: unknown; _colorsTexture?: unknown; skeleton?: { bones: unknown[] } };
      const materials = (Array.isArray(m.material) ? m.material : [m.material]) as unknown as Array<{ id: number }>;
      const g = m.geometry;
      const attrs: string[] = [];
      for (const name of Object.keys(g.attributes).sort()) {
        const a = g.attributes[name] as unknown as { itemSize?: number; normalized?: boolean; offset?: number; data?: { stride?: number }; isInstancedBufferAttribute?: boolean; array?: { constructor?: { name?: string } } };
        attrs.push(`${name}:${a.itemSize ?? ''}:${a.normalized === true ? 'n' : ''}:${a.data?.stride ?? ''}:${a.offset ?? ''}:${a.isInstancedBufferAttribute === true ? 'i' : ''}:${a.array?.constructor?.name ?? ''}`);
      }
      for (const name of Object.keys(g.morphAttributes).sort()) attrs.push(`morph:${name}`);
      if (g.index !== null) attrs.push('index');
      const kind =
        m.isInstancedMesh === true
          ? `instanced${m.instanceColor ? '+colour' : ''}`
          : m.isBatchedMesh === true
            ? `batched${m._colorsTexture ? '+colour' : ''}`
            : m.isSkinnedMesh === true
              ? `skinned${m.skeleton?.bones.length ?? 0}`
              : 'mesh';
      return `${materials.map((x) => x.id).join('+')}|${kind}|${attrs.join(',')}|${m.receiveShadow ? 'r' : ''}${m.castShadow ? 'c' : ''}|${m.layers.mask}`;
    };
    /**
     * Draws one mesh of every program shape of the maps of `places` (every LOD, never culled; the map's other meshes hidden)
     * in a real render of the scene into the scene-pass target (call it inside `withSceneTarget`), in the shadowCaster's state
     * of now (`shadows` names it); with the shadow on, its shadow pass draws one caster of every shape. R14b: a real render,
     * not `compileAsync`: three's async build yields between its stages, and an interleaved build of another object changes
     * the light node a receiver's build reads in its analyse stage, so a lit surface with the shadow on gets a text no frame
     * writes [M, R14b SwiftShader diagnostic, a `low` session picking `medium`: the packed surfaces of a scene fixture linked at
     * the switch although `MapBatcher.upload` had compiled them with the shadow on]. Returns the places drawn.
     */
    const drawMapShapes = (r: WebGPURenderer, places: readonly string[], shadows: boolean): string[] => {
      const drawn: string[] = [];
      const saved = new Map<Object3D, { visible: boolean; culled: boolean; count: number | undefined }>();
      const save = (o: Object3D): void => {
        if (!saved.has(o)) saved.set(o, { visible: o.visible, culled: o.frustumCulled, count: (o as InstancedMesh).isInstancedMesh === true ? (o as InstancedMesh).count : undefined });
      };
      for (const place of places) {
        const b = bridgeInstalled.map?.batcher(place) ?? null;
        if (b === null || mapDrawn(b, shadows)) continue;
        const shapes = new Map<string, Object3D>();
        b.root.traverse((o) => {
          if ((o as Mesh).isMesh !== true) return;
          save(o);
          o.visible = false;
          const key = shapeKey(o);
          if (!shapes.has(key)) shapes.set(key, o);
        });
        for (const o of shapes.values()) {
          o.visible = true;
          o.frustumCulled = false;
          // an empty bucket draws nothing, and three links no program for a draw it skips
          if ((o as InstancedMesh).isInstancedMesh === true && (o as InstancedMesh).count === 0) (o as InstancedMesh).count = 1;
          for (let p = o.parent; p !== null; p = p.parent) {
            save(p);
            p.visible = true;
            if (p === b.root) break;
          }
        }
        b.root.updateMatrixWorld(true);
        drawn.push(place);
      }
      // the scene-pass target only, never the canvas
      const target = r.getRenderTarget() !== null;
      try {
        if (target) r.render(host.root.scene as Scene, host.camera.world as Camera);
      } finally {
        for (const [o, s] of saved) {
          o.visible = s.visible;
          o.frustumCulled = s.culled;
          if (s.count !== undefined) (o as InstancedMesh).count = s.count;
        }
      }
      if (!target) return [];
      for (const place of drawn) markMap(bridgeInstalled.map!.batcher(place)!, shadows);
      return drawn;
    };
    /**
     * The shadow state the tier is not in (behind the hold: the caller checks). The shadowCaster's `castShadow` is held in that
     * state (`whileShadow`) while the receivers' colour forms and, with the shadow on, the casters' depth forms of the variant
     * set compile on fresh proxies, closed by one real render of the scene into the scene-pass target with the proxies and
     * one mesh of every program shape of the maps of `places` in it (`drawMapShapes`); its shadow pass links the depth
     * programs. Forms whose text holds no shadow state were linked by the tier's own warm-up. Null when there was nothing
     * left to link in that state.
     */
    const warmOtherShadow = async (r: WebGPURenderer, places: readonly string[]): Promise<{ shadow: boolean; variants: number; compiled: number; maps: string[] } | null> => {
      const shadows = !shadowsNow();
      const multiDraw = supportsMultiDraw(r as unknown as { backend?: unknown });
      const textureSets = templateTextureBindings(loadedTemplates());
      const bindingKeys = textureSets.map(textureBindingKey);
      const all =
        variantData === null
          ? []
          : enumerateVariants(variantContentFromIndex({ index: assets.index, ...variantData, shadows, multiDraw, rows: [], extra: [] }));
      const variants = selectVariants(
        all.filter((v) => v.depth || stateBound(v)),
        shadows,
        textureSets,
        bindingKeys,
      );
      const maps = places.filter((p) => {
        const b = bridgeInstalled.map?.batcher(p) ?? null;
        return b !== null && !mapDrawn(b, shadows);
      });
      if (variants.length === 0 && maps.length === 0) return null;
      const scene = host.root.scene as Scene;
      const camera = host.camera.world as Camera;
      let drawnMaps: string[] = [];
      // the scene into the scene-pass target, never the canvas, the maps' shapes in it
      const closing = (): void => {
        drawnMaps = drawMapShapes(r, maps, shadows);
        if (drawnMaps.length === 0 && r.getRenderTarget() !== null) r.render(scene, camera);
      };
      let compiled = 0;
      await lighting.shadowCaster.whileShadow(shadows, () =>
        withSceneTarget(async () => {
          if (variants.length > 0) {
            const result = await runOtherWarmUp(r, scene, camera, variants, { materials, look, paint, textureSets }, {
              proxies: [bucketProxy],
              render: closing,
              ...(seams.programs === undefined ? {} : { programs: seams.programs }),
            });
            recordCompiled(result, variants, shadows, textureSets, bindingKeys);
            compiled = result.compiled.length;
          } else {
            closing();
          }
        }),
      );
      return { shadow: shadows, variants: variants.length, compiled, maps: drawnMaps };
    };
    /**
     * The post graph of every other tier (`PostPipeline.warmTiers`), drawn once to the canvas behind the hold, then the tier's
     * own graph again. A graph with the distort pass draws the shockwave's offset ring at zero gain in it on a tier that
     * never drew the pass (`distortWarmed`). Returns the shapes drawn.
     */
    const warmPostTiers = (r: WebGPURenderer): number => {
      const pipeline = lighting.post.pipeline;
      if (pipeline === null) return 0;
      const drawCanvas = (): void => {
        const current = r.getRenderTarget();
        r.setRenderTarget(null);
        try {
          pipeline.render();
        } finally {
          r.setRenderTarget(current);
        }
      };
      const arm: { ring: { armed: boolean; done(): void } | null } = { ring: null };
      let drawn = 0;
      warmingDistortGraph = true;
      try {
        drawn = pipeline.warmTiers(
          TIER_IDS.map((id) => tierConfig(id)),
          () => {
            if (!distortWarmed && arm.ring === null && pipeline.inspect().distortPass !== null) arm.ring = shockwaves.armDistortWarm();
            drawCanvas();
            if (arm.ring?.armed === true) distortWarmed = true;
          },
        );
      } finally {
        arm.ring?.done();
        warmingDistortGraph = false;
      }
      // the tier's own graph, built again by the warm, has its node build now, behind the hold, and is what the canvas holds
      if (drawn > 0) drawCanvas();
      return drawn;
    };
    /**
     * After a warm-up: what a tier switch from here would link (see the header), behind the hold only. `places` are the built
     * places the warm-up was for: one mesh of every program shape of their maps is drawn in a real render in the tier's own
     * shadow state (`drawMapShapes`: the bridge's upload compiled them with `compileAsync`, whose text a lit surface with the
     * shadow on does not keep, and the warm-up's closing render draws what the camera sees, not the rest of the map), then in
     * the other state. With the scene on screen nothing changes the shadowCaster's state: the places and the post graphs wait
     * for the next warm-up behind the hold (`reachPending`).
     */
    const warmReachable = async (reason: string, places: readonly string[]): Promise<void> => {
      if (disposed) return;
      const hidden = deps.sceneHidden?.() ?? !kernel.clock.running;
      if (!hidden) {
        for (const p of places) reachPending.maps.add(p);
        reachPending.post = true;
        return;
      }
      const list = [...new Set([...reachPending.maps, ...places])].filter((p) => (bridgeInstalled.map?.batcher(p) ?? null) !== null);
      reachPending.maps.clear();
      reachPending.post = false;
      const r = renderer();
      const t0 = performance.now();
      const before = programsNow(r);
      const own = shadowsNow();
      let ownMaps: string[] = [];
      try {
        await withSceneTarget(async () => {
          ownMaps = drawMapShapes(r, list, own);
        });
      } catch (e) {
        log(`[game] the map warm-up (${reason}) failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      let other: Awaited<ReturnType<typeof warmOtherShadow>> = null;
      try {
        other = await warmOtherShadow(r, list);
      } catch (e) {
        log(`[game] the warm-up of the other shadow state (${reason}) failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      let postShapes = 0;
      try {
        postShapes = warmPostTiers(r);
      } catch (e) {
        log(`[game] the warm-up of the other tiers' post graphs (${reason}) failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (other === null && postShapes === 0 && ownMaps.length === 0) return;
      reach.push({
        reason,
        shadow: (other?.shadow ?? !own) ? 'on' : 'off',
        variants: other?.variants ?? 0,
        compiled: other?.compiled ?? 0,
        maps: [...ownMaps, ...(other?.maps ?? [])],
        postShapes,
        programs: programsNow(r) - before,
        ms: performance.now() - t0,
      });
    };
    /**
     * One warm-up at a time, then the reachable tiers' pass for `places`; a failed one never fails a place build: its
     * programs compile at their first draw.
     */
    const queueWarmUp = (reason: string, rows: readonly RowContent[], places: readonly string[] = []): Promise<void> => {
      warmChain = warmChain
        .then(() => warmNow(reason, rows))
        .catch((e: unknown) => log(`[game] the shader warm-up (${reason}) failed: ${e instanceof Error ? e.message : String(e)}`))
        .then(() => warmReachable(reason, places))
        .catch((e: unknown) => log(`[game] the reachable-tier warm-up (${reason}) failed: ${e instanceof Error ? e.message : String(e)}`));
      return warmChain;
    };
    /**
     * A model load settled after the warm-ups so far: when its template brought texture bindings no warm-up has seen,
     * queue another warm-up, so the resolved model's real bindings are warmed before the row is first drawn. Runs on the
     * settle microtask, ahead of the row's first frame; a delta with nothing new warms nothing. True when it queued one.
     */
    const warmLateBindings = (): boolean => {
      if (disposed || placeBuilds > 0) return false;
      try {
        let fresh = false;
        for (const key of templateTextureBindings(loadedTemplates()).map(textureBindingKey)) {
          if (!warmedBindingKeys.has(key)) {
            fresh = true;
            break;
          }
        }
        if (fresh) void queueWarmUp('late-bindings', []);
        return fresh;
      } catch (e) {
        log(`[game] the late shader warm-up check failed: ${e instanceof Error ? e.message : String(e)}`);
        return false;
      }
    };

    // ── X-42: the visual proxies of a built place ──────────────────────────────────────────────────────────────────────
    const proxies = new Map<string, { keys: number; instances: number }>();
    const geometry = host.deps.geometry as { request?(spec: ScriptedSpec, lods: LodLevel[]): Promise<PackedKey> } | null;
    const handProxies = async (place: string, rows: readonly RowRec[], stale: () => boolean): Promise<void> => {
      const setVisualProxies = deps.setVisualProxies;
      if (setVisualProxies === undefined || geometry === null || typeof geometry.request !== 'function') return;
      const soup = await buildVisualProxies(rows, {
        request: (spec, lods) => geometry.request!(spec, lods),
        world: (rowId) => bridgeInstalled.bridge.node(rowId)?.world ?? null,
        ...(deps.ignoredTags === undefined ? {} : { ignoredTags: deps.ignoredTags }),
        log,
      });
      // the hulls took worker time: the place may have been unloaded meanwhile
      if (stale()) return;
      setVisualProxies(place, soup);
      proxies.set(place, { keys: soup.keys.length, instances: soup.instances.length });
    };

    // ── the scene port the kernel builds places through ────────────────────────────────────────────────────────────────
    /** per place: counts its builds and disposals, so a build that outlived its place stops (the home place can change behind the menu) */
    const generation = new Map<string, number>();
    /** the place the player sees (its atmosphere is loaded): the rows a tier re-warm covers (R14b) */
    let shownPlace: string | null = null;
    const port: SceneSyncPort = {
      async buildPlace(place: string, rows: Iterable<RowRec>, bake: PlaceBake, onProgress: (f: number) => void): Promise<void> {
        const list = [...rows];
        const gen = (generation.get(place) ?? 0) + 1;
        generation.set(place, gen);
        const stale = (): boolean => generation.get(place) !== gen;
        // the warm-up started at install compiles against the same scene: one compile job at a time
        await warmChain;
        if (stale()) return;
        // The place being built is the one the player is about to see unless another place is on screen and drawn: then its
        // atmosphere waits for `activate` (a place switch never shows the next place's fog over this one)
        const active = kernel.places.active;
        if (active === null || active === place || !kernel.clock.running) {
          loadAtmosphere(place);
          shownPlace = place;
          await lighting.lookReady();
        }
        placeBuilds++;
        try {
          await bridgePort.buildPlace(place, list, bake, (f) => onProgress(Math.min(0.97, f * 0.97)));
          // the place was unloaded during its build: the place manager reports that itself; nothing of it is warmed or handed on
          if (stale()) return;
          await modelsLoaded();
        } finally {
          placeBuilds--;
        }
        if (stale()) return;
        await queueWarmUp(`place:${place}`, bridgeInstalled.map?.rowContent(place) ?? [], [place]);
        if (stale()) return;
        try {
          await handProxies(place, list, stale);
        } catch (e) {
          log(`[game] no visual proxies for ${place}: ${e instanceof Error ? e.message : String(e)}`);
        }
        onProgress(1);
      },
      disposePlace(place) {
        generation.set(place, (generation.get(place) ?? 0) + 1);
        proxies.delete(place);
        // R14b: the map's meshes are compiled in more than one render context and in both shadow states, and a plain mesh
        // never tells three it is gone (the batcher frees its geometry only): its render objects, with the node builds and
        // bindings they hold, would outlive the place. Its programs stay (retained, engine/program-retention.ts).
        const meshes: Object3D[] = [];
        bridgeInstalled.map?.batcher(place)?.root.traverse((o) => {
          if ((o as { isMesh?: boolean }).isMesh === true) meshes.push(o);
        });
        bridgePort.disposePlace(place);
        for (const mesh of meshes) (mesh as unknown as { dispatchEvent(e: { type: string }): void }).dispatchEvent({ type: 'dispose' });
      },
      activate(place) {
        bridgePort.activate(place);
        loadAtmosphere(place);
        shownPlace = place;
      },
      bounds: (row) => bridgePort.bounds(row),
      socket: (rowId, name) => bridgePort.socket(rowId, name),
    };
    host.setScenePort(port);
    undo.push(() => host.setScenePort(null));

    // behind the menu: the variants that need no place (render §7.2); a place build waits for it
    void queueWarmUp('engine', []);

    // X3: a device-loss rebuild gave the facade a new renderer, which has linked nothing. What the warm-ups covered was
    // covered for the lost one: forget all of it and run the engine set with the rows of every built place again, on the
    // warm-up chain (a place build in flight waits for it as it waits for the install's), behind the `gpu` hold. The reset
    // is a step of the chain itself: a warm-up still in flight (it compiled against the lost renderer, where `compileAsync`
    // returns at once) ends first, so the coverage it records is wiped with the rest instead of hiding the new renderer's
    // programs from the rebuild run.
    const resetWarmCoverage = (): void => {
      warmedKeys.clear();
      warmedBindings.clear();
      warmedBindingKeys.clear();
      standInKeys.clear();
      warmedBucketMeshes = new WeakSet<Object3D>();
      fxWarmed = false;
      highlightsWarmed = false;
      specialsWarmed = false;
      scriptedWarmed = false;
      distortWarmed = false;
      fxDistortWarmed = false;
      // R14b: no map's shapes were drawn on the new renderer, in either shadow state
      mapShapesDrawn = new WeakMap<MapBatcher, Set<boolean>>();
    };
    const builtPlaces = (): string[] => Object.keys(kernel.placeIndex.placeIndex).filter((place) => (bridgeInstalled.map?.batcher(place) ?? null) !== null);
    const builtRows = (): RowContent[] => {
      const rows: RowContent[] = [];
      for (const place of builtPlaces()) rows.push(...(bridgeInstalled.map?.rowContent(place) ?? []));
      return rows;
    };
    const rewarm = (): Promise<void> => {
      warmChain = warmChain
        .then(() => {
          resetWarmCoverage();
          return warmNow('rebuild', builtRows());
        })
        .catch((e: unknown) => log(`[game] the shader warm-up (rebuild) failed: ${e instanceof Error ? e.message : String(e)}`))
        // every built place's map in both shadow states, and the other tiers' post graphs, on the new renderer
        .then(() => warmReachable('rebuild', builtPlaces()))
        .catch((e: unknown) => log(`[game] the reachable-tier warm-up (rebuild) failed: ${e instanceof Error ? e.message : String(e)}`));
      return warmChain;
    };
    if (host.onRebuild !== undefined) undo.push(host.onRebuild(rewarm));

    // R14b: a runtime tier switch (the governor's drop at a safe boundary, or the player's pick) that turns the shadowCaster shadow
    // on or off changes the program set (render §7.2: one recompile behind the hold). The warm-ups behind the hold linked the
    // new state already (`warmReachable`), so this finds the coverage records full and compiles nothing; it stays as the net
    // for what they could not reach (a place warmed with the scene on screen): the variants of the active place are warmed
    // for the new shadow state at once, on the warm-up chain, instead of linking one by one at their first draws.
    let warmedShadows = host.tierConfig.shadowCasterMapSize > 0;
    undo.push(
      host.onTierChange((_tier, config) => {
        const shadows = config.shadowCasterMapSize > 0;
        if (shadows === warmedShadows) return;
        warmedShadows = shadows;
        void queueWarmUp(`tier:${config.id}`, shownPlace === null ? [] : (bridgeInstalled.map?.rowContent(shownPlace) ?? []));
      }),
    );

    const frame = new Matrix4();
    const modelOf = (rowId: string): { root: Object3D; template?: { rigMatrix?: Matrix4 } } | null => (bridgeInstalled.bridge.node(rowId)?.model as { root: Object3D; template?: { rigMatrix?: Matrix4 } } | null | undefined) ?? null;

    let disposed = false;
    return {
      lighting,
      installed: bridgeInstalled,
      fx,
      materials,
      library,
      viewmodelLibrary,
      model: (rowId) => modelOf(rowId),
      rigFrame(rowId) {
        const model = modelOf(rowId);
        if (model === null) return null;
        const rig = model.template?.rigMatrix;
        if (rig === undefined) return model.root.matrix.elements;
        return frame.multiplyMatrices(model.root.matrix, rig).elements;
      },
      warmed: () => warmChain,
      highlights,
      specials: {
        shockwave: (payload) => shockwaves.emit(payload),
        shake: (payload) => shaker.shake(payload),
        squash: (payload) => squasher.squash(payload),
        flash: (payload) => flasher.flash(payload),
        slash: (payload) => slashes.emit(payload),
        screenFlash,
      },
      inspect() {
        const pipeline = lighting.post.pipeline;
        const info = pipeline?.inspect() ?? null;
        const state = lighting.atmosphere.state;
        const stats = bridgeInstalled.bridge.stats();
        const maps: GameWorldInfo['maps'] = {};
        for (const place of Object.keys(kernel.placeIndex.placeIndex)) {
          const b = bridgeInstalled.map?.batcher(place) ?? null;
          if (b !== null) maps[place] = { chunks: b.chunks.length, instanced: b.instanced.length, singles: b.singles.length };
        }
        return {
          postPipeline: pipeline !== null && pipeline !== undefined,
          post:
            info === null || pipeline === null || pipeline === undefined
              ? null
              : {
                  tonemapOrder: info.tonemapOrder,
                  bloomKernel: info.bloomKernel,
                  fxaa: info.fxaa,
                  toneMapping: info.toneMapping,
                  lookPath: info.lookPath,
                  identityLook: state.look.script === '',
                  params: pipeline.params.values(),
                  graphBuilds: info.graphBuilds,
                  tierWarm: { builds: info.tierWarm.builds, shapes: [...info.tierWarm.shapes] },
                },
          gridLighting: (host.engine.renderer as { lighting: unknown }).lighting === lighting.lighting && host.root.lighting === lighting.lighting,
          lights: { records: lighting.lighting.table.size, dynamic: lighting.lighting.table.dynamicCount },
          atmosphere: { place: atmospherePlace, fogDensity: lighting.atmosphere.fog.density, lookScript: state.look.script, ambient: state.ambient.intensity, pendingWrites: lighting.atmosphere.pendingWrites },
          bridge: { rows: stats.rows, objects: stats.objects, lights: stats.lights, primitives: stats.primitives, models: stats.models },
          maps,
          proxies: Object.fromEntries(proxies),
          models: [...library.loaded(), ...viewmodelLibrary.loaded().map((n) => `viewmodel:${n}`)],
          warm: warm.map((w) => ({ ...w })),
          reach: reach.map((w) => ({ ...w, maps: [...w.maps] })),
          reachPending: { maps: [...reachPending.maps], post: reachPending.post },
          sceneTargetOpen: sceneTargetOpen > 0,
          gore: gore?.stats() ?? null,
          highlights: highlights.stats(),
          specials: {
            panels: panels.stats(),
            stringlights: stringLights.stats(),
            shockwaves: shockwaves.stats(),
            shakes: shaker.active,
            scriptedMaterials: scriptedMaterials.loaded,
            warmed: specialsWarmed,
            scriptedWarmed,
            distortWarmed,
            fxDistortWarmed,
          },
        };
      },
      dispose() {
        if (disposed) return;
        disposed = true;
        cleanup();
      },
    };
  } catch (e) {
    cleanup();
    throw e;
  }
}
