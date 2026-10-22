// ModelInstance (docs/design/rendering.md §11.4, §7.6, §16.3; WP R6): one drawn copy of a `ModelTemplate`.
//
// `SkeletonUtils.clone(template.root)` gives the instance its own `Skeleton` on its own cloned `Bone`s; the geometry and the
// materials stay the template's. The two pass meshes share one skeleton here (the clone makes one per mesh), so three updates
// the bone matrices once per frame. Everything per instance that the surface reads (slot overrides, part looks, the part mask)
// is its row of the look table, which both meshes select through `userData.ssLookRow`.
//
// Draws: 1 (the opaque mesh). The transparent mesh draws only while the template has paints with alpha < 1 or an override
// with alpha < 1 is active (a veilskin cloak): a mesh shown or hidden, never a new program.
//
// Bone matrices (render §16.3; motion §3.10). Two paths, both kept:
//   'direct'     motion's three-skin adapter writes each bone's `matrixWorld` itself (root world × rig matrix × the mixer's
//                model-space matrix). Bones have `matrixAutoUpdate` and `matrixWorldAutoUpdate` off, and the rig container
//                stops three's `updateMatrixWorld` walk at itself, so a character costs the scene-graph update four objects
//                instead of its bone count + 4; `skeleton.update()` only multiplies by the inverse bind matrices.
//                The root's world matrix must be current before the write: the bridge calls
//                `root.updateWorldMatrix(true, false)` on a root it moved, then the adapter writes (`writeBonesFromModel`).
//   'hierarchy'  the fallback: the adapter writes `position` / `quaternion` / `scale` and three's own hierarchy update composes
//                the world matrices.
// The default is the bench's choice [M, tests/unit/render/models/scene-graph-bench.three.test.ts, 35 characters + 400 statics
// + 220 gib instances, Node 24]:
// see `BONE_MATRIX_PATH` below.
import { Matrix4, Vector3 } from 'three/webgpu';
import type { Bone, Mesh, Object3D, Skeleton, SkinnedMesh } from 'three/webgpu';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { Vec3 } from '../../compat/core/types.ts';
import { LOOK_MAX_SLOTS, LOOK_PART_LOOKS, overrideIsTransparent, setLookRow, type LookRowKind, type LookTable, type SlotOverride } from '../surface/look-table.ts';
import { RigContainer, type ModelTemplate } from './model-template.ts';

export type BoneMatrixPath = 'direct' | 'hierarchy';

/**
 * The bone-matrix path instances start on, chosen from the scene-graph bench (render §16.3). [M] 35 characters of the live
 * rigs (30 × 24 bones padded to 32, 5 × 52 padded to 64) + 400 static objects + one 220-instance bucket, per frame, median of
 * 300 frames in Node 24 (no renderer):
 *
 *                                    pose write   updateMatrixWorld   frustum pass   skeleton.update   total
 *   hierarchy                        0.101        0.191               0.016          0.057             0.365 ms
 *   direct, three walks the bones    0.043        0.116               0.016          0.057             0.233 ms
 *   direct (rig container ends it)   0.044        0.049               0.016          0.058             0.167 ms
 *
 * (tests/unit/render/models/scene-graph-bench.three.test.ts; the class padding costs `skeleton.update()` 0.008 ms: 1280
 * entries against 980 real bones.) Drawn in Chromium + SwiftShader, `renderer.render()` JS for the 35 characters alone was
 * 0.7 to 0.9 ms on the direct path and 0.9 to 1.1 ms on the hierarchy path; with the 400 statics as 400 separate draws,
 * 2.9 to 3.7 ms on either (tests/e2e/render-models-bench.spec.ts: the draw count dominates, not the bones).
 * Budget: bridge + mixer + skeletons ≤ 1.5 ms at 1× (docs/architecture.md §4.2): the direct path leaves the mixer 1.3 ms.
 * MA4's `three-skin.ts` writes bones the way this constant says; `ModelInstance.setBonePath` switches one instance.
 */
export const BONE_MATRIX_PATH: BoneMatrixPath = 'direct';

export interface PartSpec extends Partial<SlotOverride> {
  visible?: boolean;
}

export interface ModelInstanceOptions {
  bonePath?: BoneMatrixPath;
  /** the look row's kind; a corpse's row can be evicted when the table is full */
  kind?: LookRowKind;
  /** called when a corpse row is evicted */
  onEvict?: () => void;
  /** one line per unknown slot or part name and per look that does not fit; default `console.warn` */
  log?: (message: string) => void;
}

const hasLook = (p: PartSpec): boolean =>
  p.albedo !== undefined || p.alpha !== undefined || p.emissive !== undefined || p.emissiveScale !== undefined || p.roughness !== undefined || p.metalness !== undefined;

const lookOf = (p: PartSpec): SlotOverride => {
  const look: SlotOverride = { mode: p.mode ?? 'replace' };
  if (p.albedo !== undefined) look.albedo = p.albedo;
  if (p.alpha !== undefined) look.alpha = p.alpha;
  if (p.emissive !== undefined) look.emissive = p.emissive;
  if (p.emissiveScale !== undefined) look.emissiveScale = p.emissiveScale;
  if (p.roughness !== undefined) look.roughness = p.roughness;
  if (p.metalness !== undefined) look.metalness = p.metalness;
  return look;
};

const warned = new WeakMap<ModelTemplate, Set<string>>();

const m4 = new Matrix4();
const v3 = new Vector3();

export class ModelInstance {
  readonly template: ModelTemplate;
  readonly root: Object3D;
  /** real bones by glTF node name; the skin adapter writes them before the frame's render */
  readonly bones: ReadonlyMap<string, Bone>;
  /** real bones in skeleton order (index = `skinIndex` values, and the template's `boneNames`) */
  readonly boneList: readonly Bone[];
  readonly opaqueMesh: Mesh | SkinnedMesh;
  readonly transparentMesh: Mesh | SkinnedMesh;
  readonly skeleton: Skeleton | null;
  readonly #table: LookTable;
  readonly #log: (message: string) => void;
  readonly #rig: RigContainer | null;
  readonly #sockets = new Map<string, Object3D>();
  readonly #boneSet = new Set<Object3D>();
  /** slots whose override blends */
  readonly #blendSlots = new Set<number>();
  /** parts whose look blends */
  readonly #blendParts = new Set<number>();
  /** parts hidden / dressed by the last `setParts` */
  #hidden = new Set<number>();
  #dressed = new Set<number>();
  #row: number;
  #bonePath: BoneMatrixPath = 'hierarchy';
  #disposed = false;

  constructor(template: ModelTemplate, table: LookTable, opts: ModelInstanceOptions = {}) {
    if (template.disposed) throw new Error(`model ${template.name}: instantiating a disposed template`);
    this.template = template;
    this.#table = table;
    this.#log = opts.log ?? ((m) => console.warn(m));

    const root = cloneSkinned(template.root);
    this.root = root;
    const [opaque, transparent, rig] = root.children as [Mesh | SkinnedMesh, Mesh | SkinnedMesh, Object3D | undefined];
    this.opaqueMesh = opaque;
    this.transparentMesh = transparent;
    this.#rig = rig instanceof RigContainer ? rig : null;

    // one skeleton for both passes
    const skinned = opaque as SkinnedMesh;
    if (skinned.isSkinnedMesh === true) {
      (transparent as SkinnedMesh).bind(skinned.skeleton, skinned.bindMatrix);
      this.skeleton = skinned.skeleton;
    } else this.skeleton = null;

    // the name maps, on the clone: bones by skeleton index, sockets by a walk in step with the template
    const bones = new Map<string, Bone>();
    const list: Bone[] = [];
    if (this.skeleton !== null) {
      const cloned = this.skeleton.bones;
      template.boneNames.forEach((name, i) => {
        const bone = cloned[i]!;
        if (!bones.has(name)) bones.set(name, bone);
        list.push(bone);
        this.#boneSet.add(bone);
      });
    }
    this.bones = bones;
    this.boneList = list;
    if (template.socketNodes.size > 0) {
      const byTemplateNode = new Map<Object3D, string>();
      for (const [name, node] of template.socketNodes) byTemplateNode.set(node, name);
      const walk = (a: Object3D, b: Object3D): void => {
        const name = byTemplateNode.get(a);
        if (name !== undefined) this.#sockets.set(name, b);
        for (let i = 0; i < a.children.length; i++) walk(a.children[i]!, b.children[i]!);
      };
      walk(template.root, root);
    }

    this.#row = table.allocate(opts.kind ?? 'instance', opts.onEvict);
    setLookRow(opaque, this.#row);
    setLookRow(transparent, this.#row);
    this.setBonePath(opts.bonePath ?? BONE_MATRIX_PATH);
  }

  /** the instance's row of the look table (0 = the shared neutral row: the table was full) */
  get lookRow(): number {
    return this.#row;
  }

  get bonePath(): BoneMatrixPath {
    return this.#bonePath;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  // ── looks ────────────────────────────────────────────────────────────────────────────────────────────────────────────

  /** Spec `model.materials[material]`: an override of one slot, or null to clear it. False for a name the model lacks. */
  setSlot(material: string, look: SlotOverride | null): boolean {
    const slot = this.template.slotIds.get(material);
    if (slot === undefined) {
      this.#warnOnce(`slot:${material}`, `model ${this.template.name}: no material slot "${material}" (model-part-material-unknown)`);
      return false;
    }
    if (slot >= LOOK_MAX_SLOTS) {
      this.#warnOnce(`slot-range:${material}`, `model ${this.template.name}: slot "${material}" is past the look row's ${LOOK_MAX_SLOTS} slots and cannot be overridden`);
      return false;
    }
    this.#table.setSlot(this.#row, slot, look);
    if (overrideIsTransparent(look)) this.#blendSlots.add(slot);
    else this.#blendSlots.delete(slot);
    this.#syncBlend();
    return true;
  }

  /**
   * Spec `model.parts`, the whole map: `{visible: false}` hides a node, `{visible: true, ...look}` shows and dresses it; a
   * node the map does not list is visible and wears its slot's look.
   */
  setParts(parts: Readonly<Record<string, PartSpec>>): void {
    const { partBits } = this.template;
    const hidden = new Set<number>();
    const dressed = new Map<number, SlotOverride>();
    for (const name of Object.keys(parts)) {
      const spec = parts[name]!;
      const bit = partBits.get(name);
      if (bit === undefined) {
        const why = this.template.unmaskable.includes(name) ? 'is past the part mask and cannot be hidden or dressed' : 'is not a mesh node of the model (model-part-material-unknown)';
        this.#warnOnce(`part:${name}`, `model ${this.template.name}: part "${name}" ${why}`);
        continue;
      }
      if (spec.visible === false) hidden.add(bit);
      else if (hasLook(spec)) dressed.set(bit, lookOf(spec));
    }
    for (const bit of this.#hidden) if (!hidden.has(bit)) this.#table.setPartHidden(this.#row, bit, false);
    for (const bit of hidden) if (!this.#hidden.has(bit)) this.#table.setPartHidden(this.#row, bit, true);
    this.#hidden = hidden;
    // looks no longer listed go first, so their entries are free for the new ones
    for (const bit of this.#dressed) if (!dressed.has(bit)) this.#table.setPartLook(this.#row, bit, null);
    this.#blendParts.clear();
    const now = new Set<number>();
    for (const [bit, look] of dressed) {
      if (this.#row !== 0 && !this.#table.setPartLook(this.#row, bit, look)) {
        this.#warnOnce('part-looks', `model ${this.template.name}: more than ${LOOK_PART_LOOKS} dressed parts at once; the rest keep their slot's look`);
        continue;
      }
      now.add(bit);
      if (overrideIsTransparent(look)) this.#blendParts.add(bit);
    }
    this.#dressed = now;
    this.#syncBlend();
  }

  /** whether a part is hidden by the last `setParts` */
  partHidden(name: string): boolean {
    const bit = this.template.partBits.get(name);
    return bit !== undefined && this.#hidden.has(bit);
  }

  #syncBlend(): void {
    this.transparentMesh.visible = this.template.hasBlendPaints || this.#blendSlots.size > 0 || this.#blendParts.size > 0;
  }

  /**
   * Gives the look row away (a baked corpse keeps the overrides and the part mask, render §11.5): the row id, which this
   * instance stops owning and `dispose` will not release. The new owner retags it (`LookTable.retag`).
   */
  detachLookRow(): number {
    const row = this.#row;
    this.#row = 0;
    setLookRow(this.opaqueMesh, 0);
    setLookRow(this.transparentMesh, 0);
    return row;
  }

  // ── bones and sockets ────────────────────────────────────────────────────────────────────────────────────────────────

  /** Switches how this instance's bone world matrices are produced (see the header). */
  setBonePath(path: BoneMatrixPath): void {
    this.#bonePath = path;
    const direct = path === 'direct';
    for (const bone of this.boneList) {
      bone.matrixAutoUpdate = !direct;
      bone.matrixWorldAutoUpdate = !direct;
    }
    if (this.#rig !== null) this.#rig.skipChildren = direct;
    if (direct) this.writeRestPose();
  }

  /** `root.matrixWorld × rigMatrix`: what takes a glTF model-space bone matrix to the world. The root's world matrix must be current. */
  rigWorld(out: Matrix4): Matrix4 {
    return out.multiplyMatrices(this.root.matrixWorld, this.template.rigMatrix);
  }

  /**
   * Direct path: writes bone `i`'s world matrix as rig world × `model[i]` for the first `count` bones in skeleton order.
   * `model` holds column-major 4×4 model-space matrices (glTF scene space, what the mixer's FK produces), 16 per bone.
   */
  writeBonesFromModel(model: ArrayLike<number>, count: number = this.boneList.length): void {
    const rig = this.rigWorld(m4).elements;
    const r0 = rig[0]!, r1 = rig[1]!, r2 = rig[2]!, r4 = rig[4]!, r5 = rig[5]!, r6 = rig[6]!, r8 = rig[8]!, r9 = rig[9]!, r10 = rig[10]!, r12 = rig[12]!, r13 = rig[13]!, r14 = rig[14]!;
    const bones = this.boneList;
    const n = Math.min(count, bones.length);
    for (let i = 0; i < n; i++) {
      const e = bones[i]!.matrixWorld.elements;
      const o = i * 16;
      for (let c = 0; c < 4; c++) {
        const x = model[o + c * 4]!;
        const y = model[o + c * 4 + 1]!;
        const z = model[o + c * 4 + 2]!;
        const w = c === 3 ? 1 : 0;
        e[c * 4] = r0 * x + r4 * y + r8 * z + r12 * w;
        e[c * 4 + 1] = r1 * x + r5 * y + r9 * z + r13 * w;
        e[c * 4 + 2] = r2 * x + r6 * y + r10 * z + r14 * w;
        e[c * 4 + 3] = w;
      }
    }
  }

  /** Direct path: the template's rest pose under the root's current world matrix. */
  writeRestPose(): void {
    const rest = this.template.restBoneMatrices;
    const root = this.root.matrixWorld;
    const bones = this.boneList;
    for (let i = 0; i < bones.length; i++) bones[i]!.matrixWorld.fromArray(rest, i * 16).premultiply(root);
  }

  /** World position of a bone. False when the model has no such bone. */
  boneWorld(name: string, out: Vec3): boolean {
    const bone = this.bones.get(name);
    if (bone === undefined) return false;
    const e = bone.matrixWorld.elements;
    out.x = e[12]!;
    out.y = e[13]!;
    out.z = e[14]!;
    return true;
  }

  /**
   * World position of a `sock_*` node. False on an uploaded model (`value.<sha>.glb`), as the live engine: its
   * `getObjectSocket` does not resolve on them and the game computes its muzzle points itself. `force` reads it anyway
   * (debug overlays).
   */
  socketWorld(name: string, out: Vec3, force = false): boolean {
    if (this.template.uploaded && !force) return false;
    const socket = this.#sockets.get(name);
    if (socket === undefined) return false;
    if (this.#bonePath !== 'direct' || this.#boneSet.has(socket)) v3.setFromMatrixPosition(socket.matrixWorld);
    else {
      // under the direct path only skeleton bones carry a current world matrix: compose the locals up to the nearest one
      m4.copy(socket.matrix);
      let p = socket.parent;
      while (p !== null && !this.#boneSet.has(p) && p !== this.#rig) {
        m4.premultiply(p.matrix);
        p = p.parent;
      }
      if (p !== null) m4.premultiply(p.matrixWorld);
      v3.setFromMatrixPosition(m4);
    }
    out.x = v3.x;
    out.y = v3.y;
    out.z = v3.z;
    return true;
  }

  // ── object state ─────────────────────────────────────────────────────────────────────────────────────────────────────

  setLayers(mask: number): void {
    this.root.layers.mask = mask;
    this.opaqueMesh.layers.mask = mask;
    this.transparentMesh.layers.mask = mask;
  }

  setVisible(visible: boolean): void {
    this.root.visible = visible;
  }

  /** Leaves the scene and releases the look row. The geometry, materials and textures are the template's. */
  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.root.removeFromParent();
    this.skeleton?.dispose();
    if (this.#row !== 0) this.#table.release(this.#row);
    this.#row = 0;
  }

  #warnOnce(key: string, message: string): void {
    let seen = warned.get(this.template);
    if (seen === undefined) warned.set(this.template, (seen = new Set()));
    if (seen.has(key)) return;
    seen.add(key);
    this.#log(message);
  }
}
