// Wiring the render bridge to its producers and to the facade (docs/architecture.md §4.2 step 4, §5.3, X-14; render §6.5,
// §7.4, §11.4, §16; WP R13). Each function here is one seam of `bridge-types.ts` over the module that produces it:
//
//   createMapHost           R3's `MapBatcher`: the build of a place (`MapBatcher.build`, the paint tables, the time-sliced
//                           upload) and what follows a promote / add / regenerate (flush the tables, compile the row's own
//                           meshes). The material of a row whose own look replaces the generator's paints is built here.
//   createRowTextures       textures a row material names (`material.texture` on a packed row or a primitive)
//   createModelRows         R6's `ModelLibrary` + `ModelInstance`: a row's `model`
//   createViewmodelContent  what a camera-attached row draws when it is not a model: VIEWMODEL-variant meshes
//   attachRenderBridge      the facade: the loop's `feed`, `bridge` and `mixer` stages and the `SceneSyncPort`
//
// WHO UPLOADS A PLACE WHILE THE GAME IS LOADING. `SceneSyncPort.buildPlace` → `bridge.loadStaticPlace` → `MapHost.build`,
// which calls `MapBatcher.upload` itself. The upload runs its `compileAsync` batches in the promise chain of the build and
// yields to animation frames between slices (`requestAnimationFrame`); it does not depend on `renderer.update` or on any loop
// stage, which the frame driver does not call while the LOADING gate holds pause reason `preparing` (docs/architecture.md
// §5.3; src/app/loading-gate.ts). tests/unit/render/render-bridge-place.three.test.ts holds that with the real driver.
//
// THE FRAME'S ORDER on the render side is fixed in `attachRenderBridge`: the feed drain, then the bridge (world matrices; the
// viewmodel layer under this frame's camera, whose pose the driver pushed in step 2), then the mixer's skin write, then the
// bridge's `afterPose` (rows on bones, `visibleRange`, the map's LODs, the bucket flush). The `lights` stage (R1b's
// `attachGridLighting`) uploads the light table after all of it.
import { Mesh } from 'three/webgpu';
import type { Camera, Material, Object3D, Scene, Texture } from 'three/webgpu';
import { rowSnapshot } from '../../compat/core/events/feed.ts';
import type { RowFeed, RowSnapshot, SceneSyncPort } from '../../compat/core/ports.ts';
import type { RowRec, Vec3 } from '../../compat/core/types.ts';
import type { FrameInfo } from '../engine/render-loop.ts';
import { MapBatcher, supportsMultiDraw, type BatchCompiler, type BatcherGeometry, type BatcherRow, type BatcherTier, type MapPass, type SingleEntry } from '../geometry/map-batcher.ts';
import { primitiveShape, whiteTexture } from '../geometry/primitives.ts';
import { ModelInstance, type PartSpec } from '../models/model-instance.ts';
import type { ObjectKind, RowContent } from '../models/shader-variants.ts';
import type { ModelLibrary } from '../models/model-library.ts';
import type { ModelTemplate } from '../models/model-template.ts';
import { slotOverrideFromSpec, type LookTable } from '../surface/look-table.ts';
import { surfaceParamsFromSpec, type StandardMaterialSpec, type SurfaceParams } from '../surface/material-spec.ts';
import { MapPaint, type MapPaintOptions, type PackedPaintSource, type PaintUploader } from '../surface/paint-table.ts';
import { SurfaceVariant, setSurfacePaint, type SurfaceMaterials, type SurfaceTextures } from '../surface/surface-material.ts';
import type { BridgeBatcherRow, BridgeMap, BridgeMapHost, BridgeMixer, BridgeModel, BridgeModels, BridgeViewmodelContent } from './bridge-types.ts';
import type { RenderBridgeControl } from './render-bridge.ts';
import { primitiveSpecOf, standardMaterialOf } from './row-spec.ts';
import type { ScriptRigs } from '../rig/script-rigs.ts';

// ── textures of row materials ───────────────────────────────────────────────────────────────────────────────────────────

export interface RowTexturesOptions {
  /** a name a row material gives (`cdn/value.<sha>.png`, a script path) → the URL to load; null: nothing to load */
  resolve: (name: string) => string | null;
  /** loads an image or a KTX2 file as a texture (the model loaders' KTX2 loader, a `TextureLoader`) */
  load: (url: string, name: string) => Promise<Texture>;
  /** the texture of `name` is there: whoever drew a placeholder for it switches (`MapHost.setTexture`, `PrimitiveBuckets.setTexture`) */
  onReady?: (name: string, texture: Texture) => void;
  log?: (message: string) => void;
}

export interface RowTextures {
  /** the texture, or undefined while it loads (the load starts on the first ask) */
  get(name: string): Texture | undefined;
  dispose(): void;
}

/** Textures by the name a row material gives, loaded once each. */
export function createRowTextures(opts: RowTexturesOptions): RowTextures {
  const ready = new Map<string, Texture>();
  const asked = new Set<string>();
  let disposed = false;
  return {
    get(name) {
      const hit = ready.get(name);
      if (hit !== undefined || asked.has(name)) return hit;
      asked.add(name);
      const url = opts.resolve(name);
      if (url === null) return undefined;
      opts.load(url, name).then(
        (texture) => {
          if (disposed) {
            texture.dispose();
            return;
          }
          ready.set(name, texture);
          opts.onReady?.(name, texture);
        },
        (e: unknown) => (opts.log ?? ((m: string) => console.warn(m)))(`[bridge] texture ${name} did not load: ${e instanceof Error ? e.message : String(e)}`),
      );
      return undefined;
    },
    dispose() {
      disposed = true;
      for (const t of ready.values()) t.dispose();
      ready.clear();
    },
  };
}

// ── the map host ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface MapHostOptions {
  search?: string;
  /** the current renderer (a device-loss rebuild replaces it) */
  renderer: () => BatchCompiler & PaintUploader & { backend?: unknown };
  geometry: BatcherGeometry;
  /** the variant cache, with the packed stage registered (`registerPackedSurface`) */
  materials: SurfaceMaterials;
  /** the packed stage's table binding: the tables of the place that draws */
  packed: PackedPaintSource;
  /** the live tier's batcher values (`TIER_TABLE[tier]`) */
  tier: () => BatcherTier;
  camera: Camera;
  scene: Scene;
  /**
   * Runs `fn` with the render target the scene pass draws into current: `compileAsync` keys what it creates on the current
   * target (render §6.5), so a map compiled against the canvas would compile again on its first frame. Default: as it is.
   */
  withSceneTarget?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** a texture by the name a row material gives; undefined: not there (yet), a white texture draws until `setTexture` */
  resolveTexture?: (name: string) => Texture | undefined;
  paint?: MapPaintOptions;
  lod1Tris?: (key: string) => number | undefined;
  /** frame budget of the upload in ms (render §6.5: 2) */
  sliceMs?: number;
  /** resolves at the next animation frame; default: the batcher's (`requestAnimationFrame`) */
  yieldFrame?: () => Promise<void>;
  far?: boolean;
  /**
   * R12a (render §14.1): the material of a scripted-geometry row whose `material` is `{kind: 'scripted', script}` (the trader
   * trail): special/scripted-row-materials.ts `ScriptedRowMaterials.get`; null while it is not built (the generator's paints draw)
   */
  scriptedMaterial?: (spec: unknown) => Material | null;
  /**
   * K3 (INTEGRATION.md H4/H5): the main thread's rig per script. Given with `rigMixer`, a single row of a rigged key draws
   * skinned (`MapBatcherOptions.rigs`) and is bound to the presenter on its skeleton (`bindRiggedSingle`), which hands the
   * script's one RigDef to the row's mixer. Absent: the legacy host's static map rows
   */
  rigs?: ScriptRigs;
  /** K3: the animation domain's presenter (`MotionPresenter`) the rigged single rows are bound to */
  rigMixer?: BridgeMixer;
  log?: (message: string) => void;
}

/**
 * K3: binds a rigged single row of the batcher to the presenter (`presenter.bind(source, { rowId, rig, mode: 'direct' })` over
 * `three-skin.ts`), which sets the script's RigDef on the row's mixer when it differs (never on a re-skin: same object). False
 * for a static row or when the presenter declines (an unknown row).
 */
export function bindRiggedSingle(mixer: BridgeMixer, entry: SingleEntry): boolean {
  const rig = entry.rig;
  if (rig === undefined) return false;
  rig.root.updateWorldMatrix(true, true, true);
  return mixer.bind(rig.source, { rowId: entry.row.id, rig: rig.rig, mode: 'direct' } as { rowId: string }) === true;
}

export interface MapHost extends BridgeMapHost {
  /** the batcher of a built place */
  batcher(place: string): MapBatcher | null;
  paint(place: string): MapPaint | null;
  /** the place that draws: the packed stage reads its tables */
  activate(place: string): void;
  /** the texture of a name that drew white so far */
  setTexture(name: string, texture: Texture): void;
  /**
   * The packed rows of a built place as R6's variant enumeration reads them (`VariantContent.rows`), from the batcher's real
   * split: how each row is drawn (a chunk or single mesh, an `InstancedMesh`, a `BatchedMesh`), whether its geometry has
   * smooth faces, and the row material where that is the look. One entry per distinct (drawn as, smooth, material).
   */
  rowContent(place: string): RowContent[];
}

interface BuiltPlace {
  batcher: MapBatcher;
  paint: MapPaint;
}

/** the surface parameters of a packed row's own look; null when the generator's paints are the look */
export function rowLook(material: StandardMaterialSpec | null | undefined): SurfaceParams | null {
  const params = surfaceParamsFromSpec(material, { source: 'packed', scripted: true });
  // K13: a row with a `dissolve` (when the game turned it on) has a mesh of its own, whose paint is the dissolve value
  return params.paintSource === 'row' || params.dissolve === true ? params : null;
}

/** The map of a place over R3's `MapBatcher`. */
export function createMapHost(opts: MapHostOptions): MapHost {
  const built = new Map<string, BuiltPlace>();
  const log = opts.log ?? ((m: string): void => console.warn(m));
  const withTarget = opts.withSceneTarget ?? (<T>(fn: () => Promise<T>): Promise<T> => fn());
  /** texture name → the meshes that draw a placeholder for it */
  const waiting = new Map<string, Set<{ mesh: Mesh; material: StandardMaterialSpec; pass: MapPass }>>();
  let active: string | null = null;

  /** the bound textures of a row look; a name that is not there yet draws white and is remembered */
  function texturesOf(params: SurfaceParams, missing: string[]): SurfaceTextures {
    const out: SurfaceTextures = {};
    const take = (name: string | null): Texture | undefined => {
      if (name === null) return undefined;
      const t = opts.resolveTexture?.(name);
      if (t === undefined) missing.push(name);
      return t ?? whiteTexture();
    };
    const albedo = take(params.textures.albedo);
    const normal = take(params.textures.normal);
    const orm = take(params.textures.orm);
    if (albedo !== undefined) out.albedo = albedo;
    if (normal !== undefined) out.normal = normal;
    if (orm !== undefined) out.orm = orm;
    return out;
  }

  /**
   * The material of a row whose own look replaces the generator's paints (render §7.4): its texture set, or its flat preset
   * (ROW_PAINT). Both passes of the key draw with it. The level's smooth faces are not known here (the batcher's callback
   * gives the row and the pass): a row look is drawn with flat faces.
   */
  function rowMaterial(material: StandardMaterialSpec, missing: string[] = []): ReturnType<SurfaceMaterials['get']> | null {
    const params = rowLook(material);
    if (params === null) return null;
    // scripted geometry is drawn with back-face culling off, whatever the row material says (render §6.2)
    const variant = (params.variant & ~SurfaceVariant.SIDE_BACK) | SurfaceVariant.SIDE_DOUBLE;
    return opts.materials.get({ variant, textures: texturesOf(params, missing), state: params.state });
  }

  /** the per-object paint of a row look, on every mesh of the single row; its placeholders are remembered */
  function dressSingle(entry: SingleEntry): void {
    const material = (entry.row as BridgeBatcherRow).material;
    if (entry.row.ownLook !== true || material === undefined || material === null) return;
    const params = rowLook(material);
    if (params === null) return;
    const missing: string[] = [];
    texturesOf(params, missing);
    for (const l of entry.levels) {
      for (const [mesh, pass] of [[l.opaque, 'opaque'], [l.transparent, 'transparent']] as const) {
        if (mesh === null) continue;
        setSurfacePaint(mesh, params.paint);
        mesh.renderOrder = params.renderOrder;
        for (const name of missing) {
          let set = waiting.get(name);
          if (set === undefined) waiting.set(name, (set = new Set()));
          set.add({ mesh, material, pass });
        }
      }
    }
  }

  function wrap(place: string, b: BuiltPlace): BridgeMap {
    const { batcher } = b;
    return {
      root: batcher.root,
      classOf: (id) => batcher.classOf(id),
      promote: (id) => batcher.promote(id),
      addRow: (row) => batcher.addRow(row),
      removeRow: (id) => batcher.removeRow(id),
      regenerate: (id, key, spec) => batcher.regenerate(id, key, spec),
      setRowMatrix: (id, m) => batcher.setRowMatrix(id, m),
      setRowVisible: (id, v) => batcher.setRowVisible(id, v),
      setRowMaterial(id, material) {
        const entry = batcher.singles.find((s) => s.row.id === id);
        if (entry === undefined || entry.row.ownLook !== true) return;
        // the paint is the only part that moves with a write; a different variant (a dissolve added to a row without one) needs a new mesh
        const params = rowLook(material as StandardMaterialSpec | null | undefined);
        if (params === null) return;
        for (const l of entry.levels) for (const mesh of [l.opaque, l.transparent]) if (mesh !== null) setSurfacePaint(mesh, params.paint);
      },
      rowMeshes(id) {
        if (batcher.classOf(id) !== 'single') return null;
        const entry = batcher.singles.find((s) => s.row.id === id);
        return entry === undefined ? null : entry.levels.flatMap((l) => (l.opaque === null ? [] : [l.opaque]));
      },
      rowBone(id, bone) {
        const rig = batcher.rowRig(id);
        const index = rig?.rig.index(bone) ?? -1;
        return index < 0 ? null : rig!.bones[index] ?? null;
      },
      rowBox(id) {
        if (batcher.classOf(id) !== 'single') return null;
        const level = batcher.singles.find((s) => s.row.id === id)?.key.levels[0];
        return level === undefined ? null : [...level.bboxMin, ...level.bboxMax];
      },
      update: (camera, force, cut) => batcher.update(camera, force, cut),
      dispose() {
        if (built.get(place) === b) built.delete(place);
        for (const set of waiting.values()) for (const w of set) if (w.mesh.parent === null || !isUnder(w.mesh, batcher.root)) set.delete(w);
        batcher.dispose();
        b.paint.dispose();
      },
    };
  }

  const isUnder = (o: Object3D, root: Object3D): boolean => {
    for (let p: Object3D | null = o; p !== null; p = p.parent) if (p === root) return true;
    return false;
  };

  return {
    async build(place, rows, progress) {
      const renderer = opts.renderer();
      const paint = new MapPaint({ name: `ss:map-paint:${place}`, ...(opts.paint ?? {}) });
      // M4 Q5 ?bench=load: the geometry-only build timing (upload excluded). Opt-in through the query string and
      // inert otherwise; the in-page startMs/endMs/tOrigin let the test correlate on one clock and one page
      // session (receipt time is diagnostic only).
      const benchLoad = new URLSearchParams(opts.search ?? '').get('bench') === 'load';
      // collision-safe unique root for this measurement session: the spec passes ?benchId=<uuid> and matches
      // log lines on it, so lines can never be attributed across tests even if page sessions collide.
      const benchId = benchLoad ? (new URLSearchParams(opts.search ?? '').get('benchId') ?? '') : '';
      const benchStartMs = benchLoad ? performance.now() : 0;
      // the build is nine tenths of the bar, the upload the rest (both report as they go)
      let batcher: MapBatcher;
      try {
        batcher = await MapBatcher.build(rows, {
          place,
          geometry: opts.geometry,
          materials: opts.materials,
          paint,
          tier: opts.tier(),
          multiDraw: supportsMultiDraw(renderer),
          rowMaterial: (row: BatcherRow, _pass: MapPass) => {
            const scripted = (row as BridgeBatcherRow).scriptedMaterial;
            if (scripted !== undefined) return opts.scriptedMaterial?.(scripted) ?? null;
            const material = (row as BridgeBatcherRow).material;
            return material === undefined || material === null ? null : rowMaterial(material);
          },
          ...(opts.lod1Tris === undefined ? {} : { lod1Tris: opts.lod1Tris }),
          ...(opts.far === undefined ? {} : { far: opts.far }),
          ...(opts.rigs === undefined ? {} : { rigs: opts.rigs }),
          log,
          onProgress: (done, total) => progress(total > 0 ? (0.9 * done) / total : 0.9),
        });
      } catch (e) {
        paint.dispose();
        throw e;
      }
      if (benchLoad) console.log(`[bench=load] id=${benchId} map=${place} startMs=${benchStartMs.toFixed(1)} endMs=${performance.now().toFixed(1)} tOrigin=${performance.timeOrigin.toFixed(1)}`);
      const b: BuiltPlace = { batcher, paint };
      built.set(place, b);
      for (const s of batcher.singles) dressSingle(s);
      if (opts.rigMixer !== undefined) for (const s of batcher.singles) bindRiggedSingle(opts.rigMixer, s);
      // the tables first, then the meshes: the stage reads the tables of the place being compiled
      paint.flush(renderer);
      if (active === null || active === place) opts.packed.setTables(paint);
      batcher.root.updateMatrixWorld(true);
      // the batcher runs its own batches and yields to animation frames: nothing here waits for `renderer.update`
      await withTarget(() =>
        batcher.upload(renderer, opts.camera, opts.scene, { sliceMs: opts.sliceMs ?? 2, ...(opts.yieldFrame === undefined ? {} : { yieldFrame: opts.yieldFrame }) }),
      );
      progress(1);
      return wrap(place, b);
    },

    async settle(map, result) {
      const entry = result as SingleEntry | null;
      let b: BuiltPlace | undefined;
      for (const candidate of built.values()) if (candidate.batcher.root === map.root) b = candidate;
      if (b === undefined || entry === null || typeof entry !== 'object' || entry.group === undefined) return;
      dressSingle(entry);
      if (opts.rigMixer !== undefined) bindRiggedSingle(opts.rigMixer, entry);
      const renderer = opts.renderer();
      // the row's key may have brought paint blocks of its own
      b.paint.flush(renderer);
      await withTarget(() => MapBatcher.warm([entry.group], opts.camera, () => renderer.compileAsync(entry.group, opts.camera, opts.scene)));
    },

    batcher: (place) => built.get(place)?.batcher ?? null,
    paint: (place) => built.get(place)?.paint ?? null,

    rowContent(place) {
      const batcher = built.get(place)?.batcher;
      if (batcher === undefined) return [];
      const out = new Map<string, RowContent>();
      const smoothOf = (levels: ReadonlyArray<{ attrs: { normal: unknown } }>): boolean => levels.some((l) => l.attrs.normal !== null);
      const add = (row: BatcherRow, kind: ObjectKind, smooth: boolean, how: string): void => {
        const material = (row as BridgeBatcherRow).material ?? null;
        const key = `${kind}|${smooth ? 1 : 0}|${material === null ? '' : JSON.stringify(material)}`;
        if (!out.has(key)) out.set(key, { spec: material, source: 'packed', kind, scripted: true, smooth, owner: `map:${place}`, why: `${how} (first: ${row.id})` });
      };
      for (const c of batcher.chunks) if (c.rows.length > 0) add(c.rows[0]!, 'mesh', smoothOf(c.levels), 'merged chunk');
      for (const k of batcher.instanced) if (k.rows.length > 0) add(k.rows[0]!, k.batch !== null ? 'batched' : 'instanced', smoothOf(k.geometry.levels), 'instanced key');
      for (const s of batcher.singles) add(s.row, 'mesh', smoothOf(s.key.levels), s.row.ownLook === true ? 'row look' : 'single row');
      return [...out.values()];
    },

    activate(place) {
      active = place;
      const b = built.get(place);
      if (b !== undefined) opts.packed.setTables(b.paint);
    },

    setTexture(name, _texture) {
      const set = waiting.get(name);
      if (set === undefined) return;
      waiting.delete(name);
      for (const w of set) {
        const missing: string[] = [];
        const material = rowMaterial(w.material, missing);
        if (material !== null) w.mesh.material = material;
        // another texture of the same look may still be on its way
        for (const other of missing) {
          let rest = waiting.get(other);
          if (rest === undefined) waiting.set(other, (rest = new Set()));
          rest.add(w);
        }
      }
    },
  };
}

// ── models ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ModelRowsOptions {
  /** templates of world rows */
  library: ModelLibrary;
  /** templates built with the VIEWMODEL variant, for camera-attached rows; without it such a row draws no model */
  viewmodelLibrary?: ModelLibrary | null;
  look: LookTable;
  /** the asset group a row's model is held by (`match`, `enemy:<set>`, `boot/menu`, …) */
  group: (row: RowSnapshot, viewmodel: boolean) => Parameters<ModelLibrary['load']>[1];
  log?: (message: string) => void;
}

interface ModelSpec {
  id: string;
  materials?: Record<string, StandardMaterialSpec | null>;
  parts?: Record<string, Record<string, unknown>>;
}

/** `model: "cdn/<name>.glb" | {id, materials?, parts?, …}` (contract §9.8) */
export function modelSpecOf(model: unknown): ModelSpec | null {
  if (typeof model === 'string' && model !== '') return { id: model };
  if (model !== null && typeof model === 'object' && typeof (model as { id?: unknown }).id === 'string') return model as ModelSpec;
  return null;
}

const instanceIds = new WeakMap<BridgeModel, string>();

function dress(instance: ModelInstance, spec: ModelSpec): void {
  if (spec.materials !== undefined) {
    for (const [slot, material] of Object.entries(spec.materials)) instance.setSlot(slot, slotOverrideFromSpec(material));
  }
  if (spec.parts !== undefined) {
    const parts: Record<string, PartSpec> = {};
    for (const [name, part] of Object.entries(spec.parts)) {
      const look = slotOverrideFromSpec(part as StandardMaterialSpec);
      parts[name] = { ...(look ?? {}), ...(typeof part['visible'] === 'boolean' ? { visible: part['visible'] } : {}) };
    }
    instance.setParts(parts);
  }
}

/** A row's `model` as a drawn instance of R6's library. */
export function createModelRows(opts: ModelRowsOptions): BridgeModels {
  const log = opts.log ?? ((m: string): void => console.warn(m));
  const make = (template: ModelTemplate, spec: ModelSpec): ModelInstance => {
    const instance = new ModelInstance(template, opts.look, { log });
    instanceIds.set(instance, spec.id);
    dress(instance, spec);
    return instance;
  };
  return {
    create(row, o) {
      const spec = modelSpecOf(row.props['model']);
      if (spec === null) return null;
      const library = o.viewmodel ? (opts.viewmodelLibrary ?? null) : opts.library;
      if (library === null) return null;
      const ready = library.get(spec.id);
      if (ready !== undefined) return make(ready, spec);
      return library.load(spec.id, opts.group(row, o.viewmodel)).then((template) => make(template, spec));
    },
    update(model, row) {
      const spec = modelSpecOf(row.props['model']);
      // another file is another body (operator skins): the row gets a new instance
      if (spec === null || instanceIds.get(model) !== spec.id || !(model instanceof ModelInstance)) return false;
      dress(model, spec);
      return true;
    },
    size(model) {
      if (!(model instanceof ModelInstance)) return null;
      const b = model.template.restBox;
      return { x: b.max.x - b.min.x, y: b.max.y - b.min.y, z: b.max.z - b.min.z };
    },
    box(model) {
      return model instanceof ModelInstance ? model.template.restBox : null;
    },
    setShadow(model, cast, receive) {
      if (!(model instanceof ModelInstance)) return;
      for (const mesh of [model.opaqueMesh, model.transparentMesh]) {
        if (cast !== undefined) mesh.castShadow = cast;
        if (receive !== undefined) mesh.receiveShadow = receive;
      }
    },
  };
}

// ── camera-attached primitives ──────────────────────────────────────────────────────────────────────────────────────────

export interface ViewmodelContentOptions {
  /** the variant cache, with the viewmodel stage registered (`registerViewmodelStage`) */
  materials: SurfaceMaterials;
  resolveTexture?: (name: string) => Texture | undefined;
}

/** variant bits a viewmodel primitive builds (the others of a material are dropped, as in a primitive bucket) */
const VM_PRIM_BITS: number =
  SurfaceVariant.SRC_PRIM | SurfaceVariant.TEX_ALBEDO | SurfaceVariant.TRANSPARENT | SurfaceVariant.UNLIT | SurfaceVariant.SIDE_BACK | SurfaceVariant.SIDE_DOUBLE | SurfaceVariant.VIEWMODEL;

/**
 * What a camera-attached row, or a row parented to one (camera-attached decal), draws from its `primitive`: one mesh of the shape with a
 * VIEWMODEL-variant material, so it is drawn through the gun's projection (render §4.3). One mesh per row: a gun carries at
 * most 14 of them.
 */
export function createViewmodelContent(opts: ViewmodelContentOptions): BridgeViewmodelContent {
  const material = (row: RowSnapshot): { params: SurfaceParams; variant: number; textures: SurfaceTextures } => {
    const params = surfaceParamsFromSpec(standardMaterialOf(row.props), { source: 'prim' });
    const textures: SurfaceTextures = {};
    let variant = (params.variant | SurfaceVariant.VIEWMODEL) & VM_PRIM_BITS;
    if (params.textures.albedo !== null) {
      const t = opts.resolveTexture?.(params.textures.albedo) ?? whiteTexture();
      textures.albedo = t;
      variant |= SurfaceVariant.TEX_ALBEDO;
    }
    return { params, variant, textures };
  };
  return {
    create(row) {
      const spec = primitiveSpecOf(row.props);
      if (spec === null) return null;
      let shape;
      try {
        shape = primitiveShape(spec);
      } catch {
        return null;
      }
      const { params, variant, textures } = material(row);
      const mesh = new Mesh(shape.create(), opts.materials.get({ variant, textures, state: params.state }));
      mesh.name = `ss:viewmodel:${row.id}`;
      mesh.scale.set(shape.scale[0], shape.scale[1], shape.scale[2]);
      setSurfacePaint(mesh, params.paint);
      return mesh;
    },
    setMaterial(object, row) {
      // colour, opacity, roughness, metalness and emissive are uniforms (camera-attached decal drying): no new material
      const { params } = material(row);
      setSurfacePaint(object, { color: params.paint.color, opacity: params.paint.opacity, emissive: params.paint.emissive, roughness: params.paint.roughness, metalness: params.paint.metalness });
    },
    dispose(object) {
      (object as Mesh).geometry?.dispose();
    },
  };
}

// ── the facade ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** what `attachRenderBridge` needs of the render facade (`RenderFacade` of src/render/index.ts fits) */
export interface BridgeHost {
  readonly loop: { setStage(stage: 'feed' | 'bridge' | 'mixer', run: ((frame: FrameInfo) => void) | null): void };
  /** the feed the app handed to `attachFeed`; null until then */
  readonly feed: RowFeed | null;
  setScenePort(port: SceneSyncPort | null): void;
}

export interface AttachBridgeOptions {
  /** the animation domain's presenter (`RendererDeps.mixer`): its skin write runs between the bridge and `afterPose` */
  mixer?: { update(frame: FrameInfo): void } | null;
  /** the map host, told which place draws */
  map?: Pick<MapHost, 'activate'> | null;
}

/**
 * Wires a bridge (created with `hostAfterPose: true`) into the render facade: the three loop stages in their order, and the
 * `SceneSyncPort` the kernel builds places through. Returns the function that undoes it.
 */
export function attachRenderBridge(host: BridgeHost, bridge: RenderBridgeControl, opts: AttachBridgeOptions = {}): () => void {
  let attached: RowFeed | null = null;
  host.loop.setStage('feed', () => {
    const feed = host.feed;
    if (feed !== attached && feed !== null) {
      attached = feed;
      bridge.attach(feed);
    }
    bridge.drain();
  });
  host.loop.setStage('bridge', (frame) => bridge.update(frame));
  host.loop.setStage('mixer', (frame) => {
    // the roots are where this frame puts them: the skin write multiplies by them
    opts.mixer?.update(frame);
    bridge.afterPose(frame);
  });
  const port: SceneSyncPort = {
    buildPlace(place, rows, _bake, onProgress) {
      const snapshots: RowSnapshot[] = [];
      for (const row of rows) snapshots.push(rowSnapshot(row));
      return bridge.loadStaticPlace(snapshots, onProgress, place);
    },
    disposePlace(place) {
      bridge.disposePlace(place);
    },
    activate(place) {
      opts.map?.activate(place);
      bridge.activate(place);
    },
    bounds: (row: RowRec): { min: Vec3; max: Vec3 } | undefined => bridge.bounds(row.id),
    socket: (rowId, name) => bridge.socket(rowId, name),
  };
  host.setScenePort(port);
  return () => {
    host.loop.setStage('feed', null);
    host.loop.setStage('bridge', null);
    host.loop.setStage('mixer', null);
    host.setScenePort(null);
  };
}

/** `BridgeMixer` over the animation domain's presenter, for the bridge's deps (`bind` answers whether it drives the model) */
export function mixerSeam(mixer: { bind(instance: unknown, opts?: { rowId?: string; body?: Object3D }): unknown; unbind?(instanceOrRowId: unknown): void; release?(rowId: string): unknown }): BridgeMixer {
  return {
    bind: (instance, o) => mixer.bind(instance, o) === true,
    ...(mixer.unbind === undefined ? {} : { unbind: (x: unknown) => mixer.unbind!(x) }),
    ...(mixer.release === undefined ? {} : { release: (rowId: string) => mixer.release!(rowId) }),
  };
}
