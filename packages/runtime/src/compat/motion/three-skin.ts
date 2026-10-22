// The three.js skin adapter (docs/design/motion-physics-nav.md §3.10; docs/design/rendering.md §11.4, §16.3;
// docs/architecture.md X-46, §4.2 step 4; WP MA4): writes a Pose onto the bones of one drawn model. It replaces the Babylon
// plan's `babylon-skin.ts` and is the one file of `motion/` that touches three objects. It needs none of three's code, only
// its object shapes, so every three import here is type-only and the file loads without the engine.
//
// TWO PATHS, one switch (`SkinTarget.mode`; render's `BONE_MATRIX_PATH` picked 'direct' from the R6 scene-graph bench):
//   'direct'     bone.matrixWorld = root.matrixWorld × rigMatrix × pose.model[bone]
//                The bones have `matrixAutoUpdate` and `matrixWorldAutoUpdate` off (render's ModelInstance sets that), three's
//                hierarchy update does no bone math and `skeleton.update()` only multiplies by the inverse bind matrices.
//                `rigMatrix` is render's model normalisation (`ModelTemplate.rigMatrix`: glTF scene space → root space); the
//                bones carry nothing else, so `skeleton.boneMatrices` are the pose's model matrices under the root.
//   'hierarchy'  bone.position / quaternion / scale = the pose's local TRS; three's own update composes the world matrices.
//
// PRECONDITION OF THE DIRECT PATH: THE ROOT'S WORLD MATRIX IS CURRENT. three recomputes world matrices only inside
// `renderer.render()`, after the skin write. The render bridge therefore calls `root.updateWorldMatrix(true, false)` on every
// root it moved this frame (and on the viewmodel root after the camera pose) BEFORE `applyPose` runs. `applyPose` never calls
// it itself: without the bridge's call the body is skinned at last frame's root pose (the gun trails the camera by a frame,
// wounds separate from the body). tests/unit/motion/three-skin.three.test.ts shows both outcomes.
//
// WHAT IS WRITTEN. Bones whose `dirty` flag is set (pass `pose.modelDirty`: a bone under a moved bone has a new model matrix
// too). On the direct path the bones are in WORLD space, so a root that moved since the last write gets every bone written
// again, whatever the flags say: a body that walks while its pose holds still (a far row the mixer LOD skips, a body before
// its first clip) must still follow its root. `applyPose` detects that itself by comparing the root's world matrix with the
// one of its last write. A call with nothing dirty under an unmoved root writes nothing.
import type { Bone, Matrix4, Object3D } from 'three/webgpu';
import type { Pose } from './pose.ts';
import { m4ComposeTRS, m4Identity, m4Mul } from './quat.ts';
import { buildRigDef, type RigDef, type RigNode } from './rig.ts';

export type SkinMode = 'direct' | 'hierarchy';

/** wraps render's ModelInstance (render §11.4) */
export interface SkinTarget {
  readonly rig: RigDef;
  /** the instance root (its matrixWorld places the model) */
  readonly root: Object3D;
  /** per rig bone, from the instance's bones (source names); null for a rig bone the skin has no Bone for */
  readonly bones: readonly (Bone | null)[];
  /** rig model space → root space (`ModelTemplate.rigMatrix`); absent or null = identity */
  readonly rigMatrix?: Matrix4 | null;
  /** default 'direct' */
  readonly mode?: SkinMode;
}

/** what the adapter reads of a drawn model: render's ModelInstance has this shape */
export interface SkinSource {
  readonly root: Object3D;
  /** real bones by glTF node name */
  readonly bones: ReadonlyMap<string, Bone>;
  /** real bones in skeleton order (= `template.boneNames`) */
  readonly boneList?: readonly Bone[];
  readonly bonePath?: SkinMode;
  readonly template?: { readonly name?: string; readonly rigMatrix?: Matrix4; readonly boneNames?: readonly string[] };
}

interface TargetState {
  /** root world × rig matrix of the last direct write */
  readonly last: Float64Array;
  written: boolean;
}

const STATE = new WeakMap<SkinTarget, TargetState>();
const rw = new Float64Array(16);

/** root.matrixWorld × rigMatrix into `out` (16, column-major). The root's world matrix must be current. */
export function rigWorldOf(target: Pick<SkinTarget, 'root' | 'rigMatrix'>, out: Float64Array): Float64Array {
  const w = target.root.matrixWorld.elements;
  const n = target.rigMatrix;
  if (n === undefined || n === null) {
    for (let i = 0; i < 16; i++) out[i] = w[i]!;
    return out;
  }
  return m4Mul(out, 0, w as number[], 0, n.elements as number[], 0);
}

/**
 * Writes a pose onto a skin: the bones whose `dirty` flag is set, and on the direct path every bone when the root's world
 * matrix differs from the one of the last write (see the header). Null bones are skipped. Returns the number of bones written.
 * A pose of another rig writes nothing.
 */
export function applyPose(target: SkinTarget, pose: Pose, dirty: Uint8Array): number {
  if (pose.rig !== target.rig) return 0;
  const bones = target.bones;
  const n = Math.min(bones.length, pose.count);
  let written = 0;
  if (target.mode === 'hierarchy') {
    const t = pose.t, r = pose.r, s = pose.s;
    // the local flags count too: the model flags are set only once the pose's FK has run, which this path does not need
    const localDirty = pose.dirty;
    for (let b = 0; b < n; b++) {
      if (dirty[b] === 0 && localDirty[b] === 0) continue;
      const bone = bones[b];
      if (bone === null || bone === undefined) continue;
      bone.position.set(t[b * 3]!, t[b * 3 + 1]!, t[b * 3 + 2]!);
      bone.quaternion.set(r[b * 4]!, r[b * 4 + 1]!, r[b * 4 + 2]!, r[b * 4 + 3]!);
      bone.scale.set(s[b * 3]!, s[b * 3 + 1]!, s[b * 3 + 2]!);
      written++;
    }
    return written;
  }
  pose.updateModel();
  rigWorldOf(target, rw);
  let st = STATE.get(target);
  if (st === undefined) {
    st = { last: new Float64Array(16), written: false };
    STATE.set(target, st);
  }
  let all = !st.written;
  if (!all) {
    const last = st.last;
    for (let i = 0; i < 16; i++) {
      if (last[i] !== rw[i]) {
        all = true;
        break;
      }
    }
  }
  const r0 = rw[0]!, r1 = rw[1]!, r2 = rw[2]!, r4 = rw[4]!, r5 = rw[5]!, r6 = rw[6]!, r8 = rw[8]!, r9 = rw[9]!, r10 = rw[10]!, r12 = rw[12]!, r13 = rw[13]!, r14 = rw[14]!;
  const model = pose.model;
  for (let b = 0; b < n; b++) {
    if (!all && dirty[b] === 0) continue;
    const bone = bones[b];
    if (bone === null || bone === undefined) continue;
    const e = bone.matrixWorld.elements;
    const o = b * 16;
    // affine × affine: the last row of both is 0 0 0 1
    for (let c = 0; c < 3; c++) {
      const x = model[o + c * 4]!, y = model[o + c * 4 + 1]!, z = model[o + c * 4 + 2]!;
      e[c * 4] = r0 * x + r4 * y + r8 * z;
      e[c * 4 + 1] = r1 * x + r5 * y + r9 * z;
      e[c * 4 + 2] = r2 * x + r6 * y + r10 * z;
      e[c * 4 + 3] = 0;
    }
    const x = model[o + 12]!, y = model[o + 13]!, z = model[o + 14]!;
    e[12] = r0 * x + r4 * y + r8 * z + r12;
    e[13] = r1 * x + r5 * y + r9 * z + r13;
    e[14] = r2 * x + r6 * y + r10 * z + r14;
    e[15] = 1;
    written++;
  }
  if (all) st.last.set(rw);
  st.written = true;
  return written;
}

/** Forgets the root a target was last written under: the next `applyPose` writes every bone (after a bone-path switch). */
export function invalidateSkin(target: SkinTarget): void {
  STATE.delete(target);
}

/**
 * The bones of a drawn model per rig bone: by skeleton index where the instance lists its bones in the rig's order (render's
 * ModelInstance does: `template.boneNames` is the skin's joint order, and so is `rig.sourceNames`), else by source name, else
 * by canonical name; null where the skin has no such Bone (a non-joint node the rig carries between two joints).
 */
export function createSkinTarget(source: SkinSource, rig: RigDef, opts: { mode?: SkinMode } = {}): SkinTarget {
  const list = source.boneList;
  const names = source.template?.boneNames;
  const bones: (Bone | null)[] = rig.sourceNames.map((name, i) => {
    if (list !== undefined && i < list.length && (names === undefined || names[i] === name)) return list[i]!;
    return source.bones.get(name) ?? source.bones.get(rig.bones[i]!) ?? null;
  });
  return { rig, root: source.root, bones, rigMatrix: source.template?.rigMatrix ?? null, mode: opts.mode ?? source.bonePath ?? 'direct' };
}

const RIGS = new WeakMap<object, RigDef>();
const local = new Float64Array(16);

/**
 * The RigDef of a drawn model, built once per model (per template) from the instance's bones at their bind TRS: skeleton
 * order, parents by the nearest bone above, the non-bone nodes over a root bone folded into its bind matrix (motion §3.2,
 * `rig.ts`). Call it on an instance nothing has posed yet (the first bind). The rig id is the template's model name.
 */
export function rigOfSkin(source: SkinSource, id?: string): RigDef | null {
  const key: object = source.template ?? source;
  const known = RIGS.get(key);
  if (known !== undefined) return known;
  const list = source.boneList ?? [...source.bones.values()];
  if (list.length === 0) return null;
  const names = source.template?.boneNames;
  const indexOf = new Map<Object3D, number>();
  list.forEach((b, i) => indexOf.set(b, i));
  // with a template, the node directly under the root is render's rig container: its transform is `rigMatrix`, not the rig's
  const hasContainer = source.template?.rigMatrix !== undefined;
  const nodes: RigNode[] = list.map((bone, i) => {
    const node = { name: names?.[i] ?? bone.name, t: bone.position.toArray(), r: bone.quaternion.toArray(), s: bone.scale.toArray() };
    let above: Float64Array | null = null;
    for (let p = bone.parent; p !== null && p !== source.root; p = p.parent) {
      const pi = indexOf.get(p);
      if (pi !== undefined) return { ...node, parent: pi };
      if (hasContainer && p.parent === source.root) break;
      m4ComposeTRS(local, 0, p.position.toArray(), 0, p.quaternion.toArray(), 0, p.scale.toArray(), 0);
      above = above === null ? Float64Array.from(local) : m4Mul(above, 0, local, 0, above, 0);
    }
    return above === null || isIdentity(above) ? { ...node, parent: -1 } : { ...node, parent: -1, above };
  });
  const rig = buildRigDef(id ?? source.template?.name ?? 'skin', nodes);
  RIGS.set(key, rig);
  return rig;
}

const ident = m4Identity(new Float64Array(16), 0);
function isIdentity(m: Float64Array): boolean {
  for (let i = 0; i < 16; i++) if (Math.abs(m[i]! - ident[i]!) > 1e-9) return false;
  return true;
}

// ── the adapter the presentation pass binds through (scheduler-hooks.ts `SkinAdapter`) ────────────────────────────────────

/** the handle of one bound model: structurally the `SkinHandle` of scheduler-hooks.ts */
export interface ThreeSkinHandle {
  readonly rig: RigDef;
  readonly target: SkinTarget;
  rigWorld(out: Float64Array): Float64Array;
  bodyWorld(out: Float64Array): Float64Array;
  apply(pose: Pose, dirty: Uint8Array): number;
}

export interface ThreeSkinBindOptions {
  /** the object that carries the row's interpolated transform (IK re-projects body-local targets with it); default: the root */
  body?: Object3D;
  mode?: SkinMode;
  /** the model's rig when the caller has it already (e.g. from the build's rig JSON); default: `rigOfSkin(instance)` */
  rig?: RigDef;
}

/** `root.userData` key of the object that carries the row's transform, when it is not the model root itself */
export const SKIN_BODY_KEY = 'ssBody';

/**
 * Binds a drawn model (render's ModelInstance): its rig, its bones per rig bone, the two matrices IK needs. Null for a model
 * without bones.
 */
export function bindThreeSkin(instance: unknown, opts: ThreeSkinBindOptions = {}): ThreeSkinHandle | null {
  const source = instance as SkinSource;
  if (source === null || typeof source !== 'object' || source.root === undefined || source.bones === undefined) return null;
  const rig = opts.rig ?? rigOfSkin(source);
  if (rig === null) return null;
  const target = createSkinTarget(source, rig, opts.mode !== undefined ? { mode: opts.mode } : {});
  const body = opts.body ?? (source.root.userData[SKIN_BODY_KEY] as Object3D | undefined) ?? source.root;
  return {
    rig,
    target,
    rigWorld: (out) => rigWorldOf(target, out),
    bodyWorld: (out) => {
      const e = body.matrixWorld.elements;
      for (let i = 0; i < 16; i++) out[i] = e[i]!;
      return out;
    },
    apply: (pose, dirty) => applyPose(target, pose, dirty),
  };
}

/** the `SkinAdapter` of the presentation pass: `createMotion(…).mixerHost({ skin: threeSkin })` */
export const threeSkin = { bind: bindThreeSkin };
