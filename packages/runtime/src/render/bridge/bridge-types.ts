// What the render bridge is given and what it gives back (docs/design/rendering.md §16; docs/architecture.md §3.5, §9.3 row
// R13). The bridge maps rows to render results through these narrow seams, so each producer (the light table, the primitive
// buckets, the map batcher, the model library, the viewmodel renderer, the mixer host, the fx system) is its own module and the
// bridge is tested against the real ones where they run without a renderer and against recording stand-ins where they do not.
import type { Matrix4, Mesh, Object3D } from 'three/webgpu';
import type { RowFeed, RowSnapshot } from '../../compat/core/ports.ts';
import type { Vec3 } from '../../compat/core/types.ts';
import type { FrameInfo } from '../engine/render-loop.ts';
import type { BatcherRow } from '../geometry/map-batcher.ts';
import type { ScriptedSpec } from '../geometry/generator-types.ts';
import type { PrimitiveSpec } from '../geometry/primitives.ts';
import type { LightHandle, LightRecord } from '../lighting/light-table.ts';
import type { Linear3 } from '../color/color.ts';
import type { ScriptedMaterialSpec, StandardMaterialSpec } from '../surface/material-spec.ts';

/** render §16.1 */
export interface RenderBridge {
  /** subscribes to add / change / remove; the first drain delivers every live row as `added` (X-14) */
  attach(feed: RowFeed): void;
  /**
   * The rows of one place: scripted rows → the map batcher; lights, primitives, models, fx like any row. `place` names the
   * place when `rows` cannot (an empty place); default: the place of the first row.
   */
  loadStaticPlace(rows: readonly RowSnapshot[], progress: (f: number) => void, place?: string): Promise<void>;
  /** interpolation, world matrices, light poses, bucket matrices, `visibleRange`, LOD */
  update(frame: FrameInfo): void;
}

// ── lights (render §8.1) ────────────────────────────────────────────────────────────────────────────────────────────────

/** the part of `LightTable` the bridge writes (R1b's `LightTableControl` fits) */
export interface BridgeLights {
  add(rec: LightRecord): LightHandle;
  remove(h: LightHandle): void;
  setIntensity(h: LightHandle, v: number): void;
  setColor(h: LightHandle, c: Linear3): void;
  setPose(h: LightHandle, p: Vec3, dir?: Vec3): void;
}

/**
 * The one shadow-casting spot (render §8.4; R4's `lighting/shadow-caster.ts`): the row whose light says `shadow: true` drives the
 * scene root's permanent `SpotLight` instead of a table record. Off is intensity 0: the light is never added, removed or
 * hidden. Without a sink (before R4) such a row is an ordinary table record, lit and without a shadow.
 */
export interface ShadowSpotSink {
  /** the row's light as a record: colour, intensity, distance, decay, cone */
  set(rec: Readonly<LightRecord>): void;
  /** every frame the row or an ancestor moved: world position and the world point it aims at */
  setPose(position: Readonly<Vec3>, target: Readonly<Vec3>): void;
  setIntensity(v: number): void;
  setColor(c: Linear3): void;
  /** the row is gone or its light was set to null */
  off(): void;
}

/** the two permanent `DirectionalLight`s (render §4.1; R4's `atmosphere.ts`): the moon rows of a place */
export interface DirectionalSink {
  /** `slot` 0 or 1; `direction` is light − target, world, unit; null switches the slot off */
  set(slot: number, light: { color: Linear3; intensity: number; direction: Readonly<Vec3> } | null): void;
}

// ── primitives (render §6.7) ────────────────────────────────────────────────────────────────────────────────────────────

/** the part of `PrimitiveBuckets` the bridge uses; `H` is its instance handle */
export interface BridgePrimitives<H = unknown> {
  /** `world`: the row's world matrix, column-major, feet at the origin */
  add(spec: PrimitiveSpec, material: StandardMaterialSpec | null | undefined, world: ArrayLike<number>): H;
  setMatrix(handle: H, spec: PrimitiveSpec, world: ArrayLike<number>): void;
  /** throws when the material belongs to another bucket: the bridge then removes the instance and adds it again */
  setMaterial(handle: H, material: StandardMaterialSpec | null | undefined): void;
  remove(handle: H): void;
  /** once per frame, after the writes */
  flush(): void;
}

// ── the map (render §6.5) ───────────────────────────────────────────────────────────────────────────────────────────────

/** a scripted row as the bridge hands it to the map: the batcher's row plus the row's own material, when that is its look */
export interface BridgeBatcherRow extends BatcherRow {
  /** set with `ownLook`: the texture set or flat preset that replaces the generator's paints (render §7.4) */
  material?: StandardMaterialSpec | null;
  /** set with `ownLook`: the row's `material: {kind: 'scripted', script}` (R12a: the scripted row material, render §14.1) */
  scriptedMaterial?: ScriptedMaterialSpec;
}

/** the built map of one place, as the bridge drives it (R3's `MapBatcher` fits) */
export interface BridgeMap {
  /** parent of every map object */
  readonly root: Object3D;
  /** what draws a row now; null: the batcher does not know the row */
  classOf(rowId: string): 'chunk' | 'instanced' | 'single' | null;
  /** promote on write: a batched row becomes a single row */
  promote(rowId: string): Promise<unknown>;
  /** a row spawned during play */
  addRow(row: BatcherRow): Promise<unknown>;
  removeRow(rowId: string): void;
  /** a `primitive` write gave the row a new key */
  regenerate(rowId: string, key: string, spec: ScriptedSpec): Promise<unknown>;
  setRowMatrix(rowId: string, m: ArrayLike<number>): void;
  setRowVisible(rowId: string, visible: boolean): void;
  /** K13: a `material` write on a single row that has a look of its own: the per-object paint (a `dissolve` animating) is written again */
  setRowMaterial?(rowId: string, material: unknown): void;
  /** a single row's level meshes (opaque, every LOD; the drawn one is visible); null: not a single row */
  rowMeshes?(rowId: string): Mesh[] | null;
  /** K3: a scripted single row's posed bone; null when the row has no rig or the bone is unknown. */
  rowBone?(rowId: string, bone: string): Object3D | null;
  /** a single row's geometry box in its own frame (before the row matrix), `[minX, minY, minZ, maxX, maxY, maxZ]`; null: not a single row */
  rowBox?(rowId: string): readonly number[] | null;
  /** LOD selection for a camera position; `cut`: a camera cut */
  update(camera: Vec3, force?: boolean, cut?: boolean): boolean;
  dispose(): void;
}

/** builds and uploads the map of a place (`bridge/attach.ts` `createMapHost` over `MapBatcher`) */
export interface BridgeMapHost {
  /**
   * The static build of a place: the batcher over `rows`, its meshes sent to the GPU. It must finish without
   * `renderer.update` being called (the LOADING gate holds `preparing` while it runs, docs/architecture.md §5.3).
   */
  build(place: string, rows: BridgeBatcherRow[], progress: (f: number) => void): Promise<BridgeMap>;
  /**
   * After `promote`, `addRow` or `regenerate` gave a row meshes of its own (`result` is what the batcher returned): flush
   * the paint tables and compile the new meshes before they are first drawn.
   */
  settle?(map: BridgeMap, result: unknown, row: BridgeBatcherRow | null): void | Promise<void>;
}

// ── models (render §11.4) ───────────────────────────────────────────────────────────────────────────────────────────────

/** a drawn model, as far as the bridge handles it (R6's `ModelInstance` fits) */
export interface BridgeModel {
  readonly root: Object3D;
  readonly bones: ReadonlyMap<string, Object3D>;
  /** `'direct'`: the bones are world matrices written by the skin adapter (or `writeRestPose`), render §16.3 */
  readonly bonePath?: string;
  writeRestPose?(): void;
  socketWorld?(name: string, out: Vec3, force?: boolean): boolean;
  setLayers(mask: number): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

export interface BridgeModelOptions {
  /** a camera-attached row: the model's materials need the VIEWMODEL variant */
  viewmodel: boolean;
}

/** turns a row's `model` into a drawn instance (`bridge/attach.ts` `createModelRows` over R6's library) */
export interface BridgeModels {
  /** null: this row draws no model; a promise while the file loads (the row keeps its transform meanwhile) */
  create(row: RowSnapshot, opts: BridgeModelOptions): BridgeModel | null | Promise<BridgeModel | null>;
  /** a `model` write: true when the instance took it (parts, slot looks), false when the row needs a new instance */
  update?(model: BridgeModel, row: RowSnapshot): boolean;
  /** the size of the model's rest box in its root frame, for `layout` */
  size?(model: BridgeModel): Vec3 | null;
  /** the model's rest box in its root frame, for `pivot` (the named point of this box is put on the row's origin) */
  box?(model: BridgeModel): { min: Readonly<Vec3>; max: Readonly<Vec3> } | null;
  /** the row's `castShadow` / `receiveShadow` */
  setShadow?(model: BridgeModel, cast: boolean | undefined, receive: boolean | undefined): void;
}

/**
 * The animation domain's presenter (motion `MotionPresenter`; render §21 `MixerHost`). `bind` answers true when the presenter
 * will write the instance's bones from now on; anything else (the app's default host does nothing) leaves the bones to the
 * bridge, which writes the rest pose whenever the root moves (R6: on the direct path bones are world matrices).
 */
export interface BridgeMixer {
  bind(instance: unknown, opts?: { rowId?: string; body?: Object3D }): boolean | void;
  unbind?(instanceOrRowId: unknown): void;
  /** X-40: a baked corpse's mixer keeps its presented pose as a FrozenPose (motion `MotionPresenter.release`); before `unbind` */
  release?(rowId: string): unknown;
}

// ── rows another renderer draws (R7: baked corpses, batched gibs; render §11.5, §11.6) ─────────────────────────────────

/**
 * Rows whose drawing leaves the bridge's model path. Two forms:
 *   claim     a row the handoff draws from the start (a batched gib): the bridge creates no model for it and hands the
 *             row's world matrix to `pose` whenever it changes
 *   hand-over a row whose model the bridge placed (`placed` answered true: a corpse) and the handoff later owns
 *             (`owns`, the bake finished): the bridge releases and unbinds the mixer, forgets the model without disposing
 *             it (the baker did), and from then on hands `pose` the model root's world matrix (the row's × the root's
 *             local matrix under the row's object)
 * `release` comes before the bridge disposes a model the handoff tracks, and when a claim ends (row removed, `model`
 * rewritten), so a bake in flight is cancelled before its instance goes.
 */
export interface BridgeHandoff {
  /** before the row's model is created: true when the handoff draws the row (it then gets no model) */
  claim(row: RowSnapshot, world: Matrix4): boolean;
  /** the row's model was placed: true when the handoff tracks it and may own it later */
  placed(row: RowSnapshot, model: BridgeModel): boolean;
  /** true once the handoff owns the row's model (it is disposed or drawn elsewhere): checked each frame for tracked rows */
  owns(rowId: string): boolean;
  /** the world matrix of a claimed or handed-over row after it changed */
  pose(rowId: string, world: Matrix4): void;
  release(rowId: string): void;
}

// ── the viewmodel (render §4.3, X-36) ───────────────────────────────────────────────────────────────────────────────────

/** the part of R8's `ViewmodelRenderer` the bridge uses */
export interface BridgeViewmodel {
  add(row: RowSnapshot, content: unknown, opts?: { pose?: 'rest' | 'external' }): Object3D;
  addChild(id: string, parentId: string, object: Object3D): boolean;
  remove(id: string): void;
  has(id: string): boolean;
  update(frame: Pick<FrameInfo, 'alpha' | 'paused'>): void;
}

/** what a camera-attached row draws when it is not a model (`bridge/attach.ts` `createViewmodelContent`) */
export interface BridgeViewmodelContent {
  /** an object whose meshes use VIEWMODEL materials, sized for the row's primitive; null: nothing to draw */
  create(row: RowSnapshot): Object3D | null;
  /** a `material` write */
  setMaterial?(object: Object3D, row: RowSnapshot): void;
  dispose?(object: Object3D): void;
}

// ── fx (render §13; R10) ────────────────────────────────────────────────────────────────────────────────────────────────

/** an effect bound to a row */
export interface FxBinding {
  /** the row's `fx` was written: the effect starts again with the new spec */
  restart(spec: unknown): void;
  /** the row is gone or its `fx` was set to null */
  end(): void;
}

/**
 * The fx system as the bridge needs it (render §16.1: an `fx` row is an effect "bound to the row (plays at its feet, follows
 * it, dies with it; restarts on write)"). R10 implements it; until then the bridge runs with null and an `fx` row keeps its
 * transform and draws no effect. Act-emitted fx never pass through here.
 */
export interface FxSystem {
  /** `node` carries the row's interpolated world matrix every frame; null: the system does not take this spec */
  bind(rowId: string, spec: unknown, node: Object3D): FxBinding | null;
}

// ── later packages ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** what a row extension keeps for a row */
export interface RowExtensionBinding {
  /** the field was written */
  update?(row: RowSnapshot): void;
  dispose(): void;
}

/** a row field whose renderer is a later package (R12a: `ui`, `spline`, `scripted material`; R12b: `scatter`) */
export type RowExtension = (row: RowSnapshot, node: Object3D) => RowExtensionBinding | null;
export type RowExtensionField = 'ui' | 'spline' | 'scatter' | 'scriptedMaterial';

/** what RH1 (highlights) and tools read of a row */
export interface RowNodeView {
  readonly id: string;
  /** carries the row's interpolated world matrix; null for a row drawn as a bucket instance or a light record */
  readonly object: Object3D | null;
  readonly model: BridgeModel | null;
  /** the row's world matrix as last presented, column-major */
  readonly world: ArrayLike<number>;
  readonly visible: boolean;
}
