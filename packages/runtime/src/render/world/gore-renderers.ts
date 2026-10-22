// Optional corpse and debris batching behind the bridge handoff and frozen-bone seams.
// Hosts supply recognition tags, profile ceilings and geometry slot sizes. Nothing is installed by default.
// A batch takes a row only after its template and programs are ready; otherwise the row keeps the ordinary model path.
import { BufferAttribute, BufferGeometry, Matrix3, Matrix4, Vector3 } from 'three/webgpu';
import type { Object3D } from 'three/webgpu';
import type { RowSnapshot } from '../../compat/core/ports.ts';
import { modelSpecOf } from '../bridge/attach.ts';
import type { BridgeHandoff, BridgeModel } from '../bridge/bridge-types.ts';
import { CorpseSystem } from '../models/corpse-system.ts';
import type { GibPass } from '../models/gib-renderer.ts';
import { GibSystem } from '../models/gib-system.ts';
import { ModelInstance } from '../models/model-instance.ts';
import { modelBlendMaterial, type ModelTemplate } from '../models/model-template.ts';
import { programVariant, textureBindingKey, type ObjectKind } from '../models/shader-variants.ts';
import { createRenderBudget, type BudgetCeilings, type RenderBudget, type TierId } from '../perf/budget.ts';
import { CORPSE_BATCH_MAX_INSTANCES, type LookTable } from '../surface/look-table.ts';
import { SurfaceVariant, type AnySurfaceMaterial, type SurfaceMaterials, type SurfaceSlotTextures } from '../surface/surface-material.ts';

const V = SurfaceVariant;

/** Limits and recognition tags for the optional batching plugin. */
export interface GoreRenderData {
  /** the largest `corpseMax` of the gore profiles (at most 64) */
  corpses: number;
  /** Maximum live corpses for this plugin, bounded by the batch texture width. */
  maxCorpses: number;
  slotVertices: number;
  slotIndices: number;
  tierCaps?: BudgetCeilings;
  /** the largest `maxGibs` of the gore profiles */
  gibs: number;
  /** the tag of a corpse row */
  corpseTag: string;
  /** the tag of a gib row */
  gibTag: string;
}

export interface GoreRenderersOptions {
  /** the batches and the corpse roots are added here (`SceneRoot.world`) */
  scene: Object3D;
  look: LookTable;
  materials: SurfaceMaterials;
  /** the world rows' model library: a gib piece is built from its loaded template */
  templates: { get(name: string): ModelTemplate | undefined };
  /** the live tier: the ceilings follow it at once (render §15.3 layer 2) */
  tier: () => TierId;
  /** null until the game data is loaded */
  data: () => GoreRenderData | null;
  /** `WEBGL_multi_draw` (or WebGPU): batches; without it one mesh per corpse and an `InstancedMesh` per gib piece */
  multiDraw: () => boolean;
  /** true when a warm-up linked the program of this variant key */
  warmed: (key: string) => boolean;
  /** the tier draws the shadowCaster's shadow (a casting corpse batch needs its depth program) */
  shadows: () => boolean;
  /** the bake slice's clock; default `performance.now` */
  now?: () => number;
  log?: (message: string) => void;
}

export interface GoreRenderStats {
  corpses: {
    tracked: number;
    pendingBakes: number;
    batched: number;
    batches: number;
    batchPath: boolean;
    phases: { watching: number; baking: number; baked: number; dropped: number; minWatchedDelta: number | null } | null;
  };
  gibs: { tracked: number; live: number; batchPath: boolean };
}

export interface GoreRenderers {
  readonly handoff: BridgeHandoff;
  /** the bridge's `bones` seam: a baked corpse's frozen anchor */
  bones(rowId: string, bone: string): Object3D | null;
  /** the loop's `corpses` stage: after the bridge and the mixer wrote this frame's bones */
  update(): void;
  readonly corpses: CorpseSystem | null;
  readonly gibs: GibSystem | null;
  stats(): GoreRenderStats;
  dispose(): void;
}

/** the gib surface (render §11.6, models/shader-variants.ts): the model paint path, no look row, both sides */
export const gibVariantBits = (textureSets: number): number => V.SRC_GLTF | V.SIDE_DOUBLE | (textureSets << 9);

const keyOf = (variant: number, kind: ObjectKind, depth = false): string =>
  programVariant({ variant, kind, receiveShadow: true, depth, owner: 'R7', why: '' }).key;

/**
 * A static template's merged geometry as a gib piece: the opaque mesh's vertices taken through its matrix relative to the
 * template root (a row's model root stands at the row's origin unscaled: gib rows have no `layout`, `pivot` or `forward`),
 * with the template's paint ids (table-wide, the model paint path).
 */
export function gibPieceGeometry(template: ModelTemplate): BufferGeometry {
  const a = template.arrays;
  template.root.updateWorldMatrix(true, true);
  const m = new Matrix4().copy(template.root.matrixWorld).invert().multiply(template.opaqueMesh.matrixWorld);
  const nm = new Matrix3().getNormalMatrix(m);
  const n = a.vertexCount;
  const pos = new Float32Array(n * 3);
  const nrm = new Float32Array(n * 3);
  const v = new Vector3();
  for (let i = 0; i < n; i++) {
    v.fromArray(a.position, i * 3).applyMatrix4(m).toArray(pos, i * 3);
    v.fromArray(a.normal, i * 3).applyMatrix3(nm).normalize().toArray(nrm, i * 3);
  }
  const g = new BufferGeometry();
  g.name = `ss:gib-piece:${template.name}`;
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.setAttribute('normal', new BufferAttribute(nrm, 3));
  g.setAttribute('uv', new BufferAttribute(a.uv !== null ? new Float32Array(a.uv) : new Float32Array(n * 2), 2));
  g.setAttribute('partPaint', new BufferAttribute(new Uint8Array(a.partPaint), 4, true));
  g.setIndex(new BufferAttribute(a.index.slice(), 1));
  return g;
}

export function validateGoreData(data: GoreRenderData): void {
  for (const key of ['corpses', 'gibs', 'maxCorpses', 'slotVertices', 'slotIndices'] as const) {
    if (!Number.isSafeInteger(data[key]) || data[key] <= 0) throw new RangeError('gore: ' + key + ' must be a positive integer');
  }
  if (data.maxCorpses > CORPSE_BATCH_MAX_INSTANCES) throw new RangeError('gore: maxCorpses exceeds the batch texture width (64)');
  if (typeof data.corpseTag !== 'string' || data.corpseTag.trim() === '' || typeof data.gibTag !== 'string' || data.gibTag.trim() === '' || data.corpseTag === data.gibTag) throw new RangeError('gore: distinct nonempty corpse and debris tags are required');
}

export function createGoreRenderers(opts: GoreRenderersOptions): GoreRenderers {
  const log = opts.log ?? ((m: string): void => console.warn(m));
  let corpses: CorpseSystem | null = null;
  let gibs: GibSystem | null = null;
  let disposed = false;
  /** gib sets by key: the binding and whether it has a blend pass */
  const sets = new Map<string, { textures: readonly SurfaceSlotTextures[]; blend: boolean }>();
  /** models that keep the model path, logged once each */
  const passed = new Set<string>();
  const once = (key: string, message: string): void => {
    if (passed.has(key)) return;
    passed.add(key);
    log(message);
  };

  const materialFor = (set: string, pass: GibPass): AnySurfaceMaterial | null => {
    const s = sets.get(set);
    if (s === undefined) return null;
    const textures = s.textures.length > 0 ? { slots: s.textures } : {};
    const bits = gibVariantBits(s.textures.length);
    if (pass === 'opaque') return opts.materials.get({ variant: bits, textures });
    return s.blend ? modelBlendMaterial(opts.materials.get({ variant: bits | V.TRANSPARENT, textures })) : null;
  };

  const ensure = (): boolean => {
    if (disposed) return false;
    if (corpses !== null && gibs !== null) return true;
    const data = opts.data();
    if (data === null) return false;
    validateGoreData(data);
    const budget: RenderBudget = createRenderBudget(opts.tier, data.tierCaps);
    const multiDraw = opts.multiDraw();
    const profileCorpses = Math.min(data.maxCorpses, data.corpses);
    corpses = new CorpseSystem({
      baker: { ...(opts.now === undefined ? {} : { now: opts.now }), log },
      batcher: {
        scene: opts.scene,
        table: opts.look,
        budget,
        profileCap: profileCorpses,
        maxVerticesPerCorpse: data.slotVertices,
        maxIndicesPerCorpse: data.slotIndices,
        multiDraw,
        log,
      },
      isCorpseRow: (row) => row.tags.includes(data.corpseTag),
      log,
    });
    gibs = new GibSystem({
      renderer: { scene: opts.scene, budget, profileCap: data.gibs, pieces: [], materialFor, multiDraw, log },
      isGibRow: (row) => row.tags.includes(data.gibTag),
      pieceIdOf: (row) => plainModelId(row),
      log,
    });
    return true;
  };

  /** the gib piece of a row's model, built from its loaded template on first sight; false: the row keeps the model path */
  const ensurePiece = (system: GibSystem, id: string): boolean => {
    if (system.renderer.hasPiece(id)) return true;
    if (passed.has(id)) return false;
    const template = opts.templates.get(id);
    if (template === undefined) return false; // not loaded yet: this row loads it, a later one is batched
    if (template.skinned) {
      once(id, `[gore] gib model ${id} is skinned: its rows keep their model`);
      return false;
    }
    const sets0 = template.textureSets.length;
    const blend = template.hasBlendPaints;
    const kind: ObjectKind = system.renderer.batched ? 'batched' : 'instanced';
    const bits = gibVariantBits(sets0);
    if (!opts.warmed(keyOf(bits, kind)) || (blend && !opts.warmed(keyOf(bits | V.TRANSPARENT, kind)))) {
      once(id, `[gore] no warm-up linked the gib program of ${id} (${keyOf(bits, kind)}): its rows keep their model`);
      return false;
    }
    const set = `${sets0 > 0 ? textureBindingKey(template.textureSets) : ''}${blend ? '|blend' : ''}`;
    if (!sets.has(set)) sets.set(set, { textures: [...template.textureSets], blend });
    const geometry = gibPieceGeometry(template);
    try {
      system.renderer.addPiece({ id, set, geometry });
    } finally {
      geometry.dispose();
    }
    return true;
  };

  /** a corpse batch links only warmed programs: the template's surface batched (or meshed) in both passes, and its depth form */
  const corpseWarmed = (instance: ModelInstance, batched: boolean): boolean => {
    const t = instance.template;
    const kind: ObjectKind = batched ? 'batched' : 'mesh';
    if (!opts.warmed(keyOf(t.variant, kind)) || !opts.warmed(keyOf(t.variant | V.TRANSPARENT, kind))) return false;
    return !(opts.shadows() && instance.opaqueMesh.castShadow) || opts.warmed(keyOf(t.variant, kind, true));
  };

  const handoff: BridgeHandoff = {
    claim(row: RowSnapshot, world: Matrix4): boolean {
      if (!ensure()) return false;
      const system = gibs!;
      if (!system.isGib(row)) return false;
      const id = plainModelId(row);
      if (id === null || !ensurePiece(system, id)) return false;
      return system.track(row.id, row, world);
    },
    placed(row: RowSnapshot, model: BridgeModel): boolean {
      if (!ensure()) return false;
      const system = corpses!;
      if (!system.isCorpse(row) || !(model instanceof ModelInstance) || !model.template.skinned) return false;
      if (!corpseWarmed(model, system.batcher.batched)) {
        once(`corpse:${model.template.name}`, `[gore] no warm-up linked the baked-corpse programs of ${model.template.name}: its corpses stay skinned`);
        return false;
      }
      return system.track(row.id, row, model);
    },
    owns: (rowId) => corpses?.handedOver(rowId) ?? false,
    pose(rowId: string, world: Matrix4): void {
      if (gibs?.setPose(rowId, world) === true) return;
      corpses?.setPose(rowId, world);
    },
    release(rowId: string): void {
      gibs?.untrack(rowId);
      corpses?.untrack(rowId);
    },
  };

  return {
    handoff,
    bones: (rowId, bone) => corpses?.frozenBone(rowId, bone) ?? null,
    update(): void {
      if (disposed) return;
      corpses?.update();
      gibs?.update();
    },
    get corpses() {
      return corpses;
    },
    get gibs() {
      return gibs;
    },
    stats(): GoreRenderStats {
      return {
        corpses: {
          tracked: corpses?.size ?? 0,
          pendingBakes: corpses?.pendingBakes ?? 0,
          batched: corpses?.batcher.size ?? 0,
          batches: corpses?.batcher.batchCount ?? 0,
          batchPath: corpses?.batcher.batched ?? opts.multiDraw(),
          phases: corpses?.phases() ?? null,
        },
        gibs: { tracked: gibs?.size ?? 0, live: gibs?.renderer.live ?? 0, batchPath: gibs?.renderer.batched ?? opts.multiDraw() },
      };
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      corpses?.dispose();
      gibs?.dispose();
      corpses = null;
      gibs = null;
      sets.clear();
    },
  };
}

/** a row's model when it is a plain file (no dress, no parts): only those are gib pieces */
function plainModelId(row: RowSnapshot): string | null {
  const spec = modelSpecOf(row.props['model']);
  if (spec === null || spec.materials !== undefined || spec.parts !== undefined) return null;
  return spec.id;
}
