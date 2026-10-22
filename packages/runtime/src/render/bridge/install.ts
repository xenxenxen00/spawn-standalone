// The render bridge on the render facade (docs/architecture.md §4.2 step 4, X-14, X-36; render §16; WP R13): one call builds
// what the bridge draws rows with and wires it into the facade's seams.
//
//   built here      the surface variant cache over the lighting module, the packed stage and its table binding, R3's primitive
//                   buckets under `root.world`, R8's viewmodel renderer (its anchor in the scene) with the content factory for
//                   camera-attached primitives, the map host over R3's `MapBatcher`, and the bridge itself
//   handed in       the lights (R4's `installWorldLighting(...).lights` and `.moons`, or a `GridLighting`'s table), the model
//                   rows (`createModelRows` over R6's library, which needs the page's loaders), the fx system (R10), the
//                   texture resolver
//   wired           `attachRenderBridge`: the loop's `feed`, `bridge` and `mixer` stages in that order, and `scene`, the
//                   `SceneSyncPort` the kernel builds places through
//
// `createRenderer` of src/render/index.ts does not call this (the lighting module comes from the kernel's module registry,
// which is not one of `RendererDeps`): the engine loader does, once, after `createRenderer` and `installWorldLighting`.
// tests/e2e/render-r13.spec.ts runs exactly that sequence on the real facade.
//
// `port.viewmodelInterp` (X-36) is read from `builtin/port` every frame, so the A/B switch works at run time.
import type { Camera, CoordinateSystem, Material, Object3D, Scene, Texture } from 'three/webgpu';
import { portFlag } from '../../compat/builtin/port.ts';
import type { Vec3 } from '../../compat/core/types.ts';
import type { FrameInfo } from '../engine/render-loop.ts';
import type { BatchCompiler, BatcherGeometry } from '../geometry/map-batcher.ts';
import { PrimitiveBuckets } from '../geometry/primitives.ts';
import { createViewmodelProjection, createViewmodelRenderer, registerViewmodelStage, type ViewmodelInterpMode, type ViewmodelProjection, type ViewmodelRenderer } from '../models/viewmodel-renderer.ts';
import { TIER_TABLE, type TierId } from '../perf/budget.ts';
import type { CameraPresenterControl } from '../scene/camera-presenter.ts';
import type { SceneRoot } from '../scene/scene-root.ts';
import { MapPaint, registerPackedSurface, type MapPaintOptions, type PaintUploader } from '../surface/paint-table.ts';
import type { LightingScript } from '../surface/script-types.ts';
import { SurfaceMaterials } from '../surface/surface-material.ts';
import { attachRenderBridge, createMapHost, createViewmodelContent, mixerSeam, type BridgeHost, type MapHost } from './attach.ts';
import type { BridgeHandoff, BridgeLights, BridgeModels, DirectionalSink, FxSystem, RowExtension, RowExtensionField, ShadowSpotSink } from './bridge-types.ts';
import { createRenderBridge, type RenderBridgeControl } from './render-bridge.ts';
import type { ScriptRigs } from '../rig/script-rigs.ts';

/** what `installRenderBridge` needs of the render facade (`RenderFacade` of src/render/index.ts fits) */
export interface RenderBridgeHost extends BridgeHost {
  readonly root: SceneRoot;
  readonly camera: CameraPresenterControl;
  /** the current engine: read again whenever it is needed, a device-loss rebuild replaces it */
  readonly engine: { readonly renderer: BatchCompiler & PaintUploader & { backend?: unknown; coordinateSystem: CoordinateSystem } };
  readonly tier: TierId;
  readonly deps: {
    /** the batcher needs `buildChunks` of it (`GeometryServiceImpl` has it); without it places build no map */
    geometry: unknown;
    /** the animation domain's presenter (`MixerHost`): `bind` answers true when it will write the model's bones */
    mixer: { bind(instance: unknown, opts?: { rowId?: string; body?: Object3D }): unknown; update(frame: FrameInfo): void; unbind?(instanceOrRowId: unknown): void; release?(rowId: string): unknown };
  };
}

export interface InstallBridgeOptions {
  dynamicTags?: readonly string[];
  search?: string;
  /**
   * K10b: the packed map stage multiplies each row's colour and opacity by the vertex attribute `ssColor` (the `{ colors }` a
   * generator returns). Pair it with geometry workers that pack them (`createBrowserGeometryService({ vertexColors: true })`).
   * Absent/false: the legacy host, the attribute is never read
   */
  vertexColors?: boolean;
  /**
   * K3: procedural rigs on map rows: rigged single rows draw skinned and are bound to `deps.mixer` on their skeleton. Pair it
   * with geometry workers that run `skeleton()` (`createBrowserGeometryService({ rigs: true })`). Absent: the legacy host
   */
  rigs?: ScriptRigs;
  /** `pivot` on scripted (map) rows (`RenderBridgeDeps.scriptedPivot`). Absent: the legacy host */
  scriptedPivot?: boolean;
  /** the world's lighting module (`loadLightingScript`); null (it failed to load in production): every surface is unlit */
  script: LightingScript | null;
  /** default: a new variant cache over `script`. Give the one the model library was built with, so models and rows share it */
  materials?: SurfaceMaterials;
  /** where light rows go: R4's routed table (`installWorldLighting(...).lights`), or a `GridLighting`'s `table` */
  lights: BridgeLights;
  /** the two permanent DirectionalLights (R4's `moons`) */
  directional?: DirectionalSink | null;
  /** only when `lights` does not route the owner's beam itself (R4's `routeLights` does) */
  shadowSpot?: ShadowSpotSink | null;
  models?: BridgeModels | null;
  fx?: FxSystem | null;
  /** textures of row materials by name; undefined while one loads (`createRowTextures`) */
  resolveTexture?: (name: string) => Texture | undefined;
  /** the light grid's extent of a place (`GridLighting.setBounds`) */
  onPlaceBounds?: (place: string, bounds: { min: Vec3; max: Vec3 } | null) => void;
  /** runs `fn` with the scene pass's render target current (the post pipeline's): map uploads compile against it */
  withSceneTarget?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** default: `port.viewmodelInterp` */
  interp?: () => ViewmodelInterpMode;
  paint?: MapPaintOptions;
  bones?: Parameters<typeof createRenderBridge>[0]['bones'];
  /** R7: rows a corpse or gib renderer draws (render §11.5, §11.6) */
  handoff?: BridgeHandoff | null;
  extensions?: Partial<Record<RowExtensionField, RowExtension>>;
  /** R12a: the scripted materials of map rows (bridge/attach.ts `MapHostOptions.scriptedMaterial`) */
  scriptedMaterial?: (spec: unknown) => Material | null;
  log?: (message: string) => void;
}

export interface InstalledBridge {
  readonly bridge: RenderBridgeControl;
  readonly materials: SurfaceMaterials;
  readonly primitives: PrimitiveBuckets;
  readonly viewmodel: ViewmodelRenderer;
  readonly projection: ViewmodelProjection;
  /** null when the geometry service cannot build chunks */
  readonly map: MapHost | null;
  /** the texture of a name that drew white so far: packed rows and primitive buckets switch */
  setTexture(name: string, texture: Texture): void;
  dispose(): void;
}

const flagInterp = (): ViewmodelInterpMode => (portFlag('viewmodelInterp') === 'step' ? 'step' : 'alpha');

const isBatcherGeometry = (g: unknown): g is BatcherGeometry =>
  typeof g === 'object' && g !== null && typeof (g as BatcherGeometry).request === 'function' && typeof (g as BatcherGeometry).buildChunks === 'function';

/** Builds the bridge and its producers on the facade and wires them in. Call once, after `createRenderer`. */
export function installRenderBridge(host: RenderBridgeHost, opts: InstallBridgeOptions): InstalledBridge {
  const log = opts.log;
  const materials = opts.materials ?? new SurfaceMaterials({ script: opts.script });
  const renderer = (): RenderBridgeHost['engine']['renderer'] => host.engine.renderer;
  const camera = host.camera;

  // packed map geometry: the stage is registered once; each place binds its own tables when it draws
  const packed = registerPackedSurface(materials, new MapPaint({ paints: 1, entries: 1, name: 'ss:map-paint:none' }), opts.vertexColors === true ? { vertexColors: true } : {});

  const primitives = new PrimitiveBuckets({
    script: opts.script,
    parent: host.root.world,
    ...(opts.resolveTexture === undefined ? {} : { resolveTexture: opts.resolveTexture }),
    ...(log === undefined ? {} : { log }),
  });

  // the viewmodel layer: the same scene and pass, its own projection in the material (render §4.3)
  const projection = createViewmodelProjection();
  projection.sync(camera.aspect, renderer().coordinateSystem);
  registerViewmodelStage(materials, projection);
  const viewmodel = createViewmodelRenderer({ camera, projection, coordinateSystem: () => renderer().coordinateSystem, interp: opts.interp ?? flagInterp, materials });
  host.root.scene.add(viewmodel.anchor);

  const geometry = host.deps.geometry;
  // K14: a scene with a sun shadow (the scene root made it, opt-in) builds the shadow proxies on every tier
  const sunShadow = host.root.lights.directionals.some((l) => l.castShadow);
  const map = isBatcherGeometry(geometry)
    ? createMapHost({
        renderer,
        ...(opts.search === undefined ? {} : { search: opts.search }),
        geometry,
        materials,
        packed,
        tier: sunShadow ? () => ({ ...TIER_TABLE[host.tier], sunShadow: true }) : () => TIER_TABLE[host.tier],
        camera: camera.world as Camera,
        scene: host.root.scene as Scene,
        ...(opts.withSceneTarget === undefined ? {} : { withSceneTarget: opts.withSceneTarget }),
        ...(opts.resolveTexture === undefined ? {} : { resolveTexture: opts.resolveTexture }),
        ...(opts.paint === undefined ? {} : { paint: opts.paint }),
        ...(opts.scriptedMaterial === undefined ? {} : { scriptedMaterial: opts.scriptedMaterial }),
        ...(opts.rigs === undefined ? {} : { rigs: opts.rigs, rigMixer: { bind: (instance: unknown, o?: { rowId?: string }) => host.deps.mixer.bind(instance, o) === true } }),
        ...(log === undefined ? {} : { log }),
      })
    : null;
  if (map === null) (log ?? ((m: string): void => console.warn(m)))('[bridge] the geometry service has no buildChunks: places build no map');

  const bridge = createRenderBridge({
    world: host.root.world,
    ...(opts.dynamicTags === undefined ? {} : { dynamicTags: opts.dynamicTags }),
    camera,
    lights: opts.lights,
    primitives,
    map,
    ...(opts.rigs === undefined ? {} : { rigs: true }),
    ...(opts.scriptedPivot === true ? { scriptedPivot: true } : {}),
    models: opts.models ?? null,
    mixer: mixerSeam(host.deps.mixer),
    viewmodel,
    viewmodelContent: createViewmodelContent({ materials, ...(opts.resolveTexture === undefined ? {} : { resolveTexture: opts.resolveTexture }) }),
    fx: opts.fx ?? null,
    shadowSpot: opts.shadowSpot ?? null,
    directional: opts.directional ?? null,
    bones: opts.bones ?? null,
    handoff: opts.handoff ?? null,
    ...(opts.extensions === undefined ? {} : { extensions: opts.extensions }),
    ...(opts.onPlaceBounds === undefined ? {} : { onPlaceBounds: opts.onPlaceBounds }),
    // the facade's `mixer` stage calls `afterPose`, after the skin write
    hostAfterPose: true,
    ...(log === undefined ? {} : { log }),
  });
  const detach = attachRenderBridge(host, bridge, { mixer: host.deps.mixer, map });

  return {
    bridge,
    materials,
    primitives,
    viewmodel,
    projection,
    map,
    setTexture(name, texture) {
      primitives.setTexture(name, texture);
      map?.setTexture(name, texture);
    },
    dispose() {
      detach();
      bridge.dispose();
      viewmodel.dispose();
      primitives.dispose();
    },
  };
}
