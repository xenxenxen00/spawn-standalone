// Rig definitions (docs/design/motion-physics-nav.md §3.2, §3.4.1, §3.10): the bones of one model file as plain data (names,
// parents, bind local TRS, model-space bind matrices), the rig family, and canonical bone aliasing. three-free: the render
// domain builds a RigDef from its ModelTemplate (render §11.3 step 5) through `buildRigDef`, tools and tests feed the same
// builder from the glTF JSON chunk (`rigNodesFromGltf`).
//
// Model space is the glTF scene space of the model file, before any per-row normalisation (scale, recentre, forward: render
// domain, motion §9 M16). Nodes above a root bone (the `Armature` node of every live body, an identity transform [M]) are not
// bones: their matrix is folded into `bindModel` of the root bone, so `bindModel` is always model space while `bindT/R/S` stay
// the node's own local TRS. `rigParentMatrix` gives that matrix back to FK code.
import { m4ComposeTRS, m4Identity, m4InvertAffine, m4Mul, type Num } from './quat.ts';

export type RigFamily = 'platform-v3' | 'mixamo' | 'library-src' | 'viewmodel' | 'creature' | 'unknown';
export interface RigFamilyRule { family: RigFamily; bonePrefixes: readonly string[] }

export interface RigDef {
  /** model cdn name (one rig per model file; LOD files share the LOD0 id) */
  readonly id: string;
  readonly family: RigFamily;
  /** canonical names (prefix "mixamorig:" and "Armature|" stripped) */
  readonly bones: readonly string[];
  /** glTF node names as loaded (for the three adapter) */
  readonly sourceNames: readonly string[];
  /** −1 = root */
  readonly parent: Int16Array;
  /** 3 per bone, local */
  readonly bindT: Float32Array;
  /** 4 per bone (x, y, z, w), local */
  readonly bindR: Float32Array;
  /** 3 per bone */
  readonly bindS: Float32Array;
  /** 16 per bone, model-space bind matrices (FK of the above) */
  readonly bindModel: Float32Array;
  /** model-space y of Hips at bind (for 'hips' units and translation scaling); 0 for a rig without Hips */
  readonly hipsRestHeight: number;
  /** canonical or source name → index, −1 when absent */
  index(name: string): number;
}

/**
 * The bone data of a rig, which is all that FK, binding and retargeting read (no family, no source names). The mixer's
 * `PoseRig` (pose.ts) has exactly this shape, so either type can be passed where this one is asked for.
 */
export type RigBones = Pick<RigDef, 'id' | 'bones' | 'parent' | 'bindT' | 'bindR' | 'bindS' | 'bindModel' | 'hipsRestHeight' | 'index'>;

/** One bone as the builder takes it. */
export interface RigNode {
  /** the node name as loaded */
  readonly name: string;
  /** index into the same list, −1 for a root */
  readonly parent: number;
  readonly t?: ArrayLike<number> | undefined;
  readonly r?: ArrayLike<number> | undefined;
  readonly s?: ArrayLike<number> | undefined;
  /** roots only: the model-space matrix of the non-bone nodes above this bone (16, column-major); identity when omitted */
  readonly above?: ArrayLike<number> | undefined;
}

/** Strips `Armature|`-style prefixes (everything up to the last '|') and the `mixamorig:` / `mixamorig1:` namespace. */
export function canonicalBoneName(name: string): string {
  const bar = name.lastIndexOf('|');
  const s = bar >= 0 ? name.slice(bar + 1) : name;
  return s.replace(/^mixamorig\d*:/, '');
}

const isIdentity16 = (m: ArrayLike<number>, eps = 1e-9): boolean => {
  for (let i = 0; i < 16; i++) if (Math.abs(m[i]! - (i % 5 === 0 ? 1 : 0)) > eps) return false;
  return true;
};

/** A spine more than this far from vertical at bind is not an upright humanoid (quadruped bodies on the platform skeleton). */
const UPRIGHT_MAX_TILT_DEG = 45;

/**
 * Rig family from the bone-name set and the bind pose, never from the file name (motion §3.4.1):
 * - host family rules are checked before the built-in skeletal conventions;
 * - `mixamo`: the `mixamorig:` namespace with a Hips bone;
 * - `library-src`: bare names with the Hips → Spine → Spine1 → Spine2 → Spine3 chain of the clip library;
 * - `platform-v3`: the platform's 24-bone names (Hips → Spine02 → Spine01 → Spine, `neck`), upright at bind;
 * - `creature`: the platform names on a body that is not upright at bind (quadruped or otherwise tilted);
 * - `unknown`: anything else.
 */
export function classifyRig(sourceNames: readonly string[], parent: ArrayLike<number>, bindModel: ArrayLike<number>, rules: readonly RigFamilyRule[] = []): RigFamily {
  const canon = sourceNames.map(canonicalBoneName);
  const at = (n: string): number => canon.indexOf(n);
  const childOf = (child: string, par: string): boolean => {
    const c = at(child);
    return c >= 0 && parent[c] === at(par) && at(par) >= 0;
  };
  for (const rule of rules) if (sourceNames.some(name => rule.bonePrefixes.some(prefix => name.startsWith(prefix)))) return rule.family;
  const hips = at('Hips');
  if (hips < 0) return 'unknown';
  if (sourceNames.some((n) => /^mixamorig\d*:/.test(n))) return 'mixamo';
  if (childOf('Spine', 'Hips') && childOf('Spine1', 'Spine') && childOf('Spine2', 'Spine1') && childOf('Spine3', 'Spine2')) return 'library-src';
  if (childOf('Spine02', 'Hips') && childOf('Spine01', 'Spine02') && childOf('Spine', 'Spine01')) {
    const top = at('Spine');
    const dx = bindModel[top * 16 + 12]! - bindModel[hips * 16 + 12]!;
    const dy = bindModel[top * 16 + 13]! - bindModel[hips * 16 + 13]!;
    const dz = bindModel[top * 16 + 14]! - bindModel[hips * 16 + 14]!;
    const tilt = (Math.atan2(Math.hypot(dx, dz), dy) * 180) / Math.PI;
    return tilt <= UPRIGHT_MAX_TILT_DEG ? 'platform-v3' : 'creature';
  }
  return 'unknown';
}

/**
 * Builds a RigDef from plain bone data. `nodes` is the skeleton in the order the skin lists its joints (the order of three's
 * `Skeleton.bones`), so a bone index is a joint index.
 */
export function buildRigDef(id: string, nodes: readonly RigNode[], opts: { family?: RigFamily; familyRules?: readonly RigFamilyRule[] } = {}): RigDef {
  const n = nodes.length;
  if (n === 0) throw new Error(`rig ${id}: no bones`);
  if (n > 32767) throw new Error(`rig ${id}: ${n} bones do not fit an Int16 index`);
  const sourceNames = nodes.map((b) => b.name);
  const bones = sourceNames.map(canonicalBoneName);
  const parent = new Int16Array(n);
  const bindT = new Float32Array(n * 3);
  const bindR = new Float32Array(n * 4);
  const bindS = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const b = nodes[i]!;
    if (!Number.isInteger(b.parent) || b.parent < -1 || b.parent >= n || b.parent === i) throw new Error(`rig ${id}: bone ${b.name} has a bad parent index ${b.parent}`);
    parent[i] = b.parent;
    for (let k = 0; k < 3; k++) {
      bindT[i * 3 + k] = b.t?.[k] ?? 0;
      bindS[i * 3 + k] = b.s?.[k] ?? 1;
    }
    for (let k = 0; k < 4; k++) bindR[i * 4 + k] = b.r?.[k] ?? (k === 3 ? 1 : 0);
  }
  // FK in doubles; parents are resolved on demand because the joint order need not be topological
  const model = new Float64Array(n * 16);
  const state = new Uint8Array(n); // 0 = todo, 1 = on the stack, 2 = done
  const local = new Float64Array(16);
  const resolve = (i: number): void => {
    if (state[i] === 2) return;
    if (state[i] === 1) throw new Error(`rig ${id}: bone ${sourceNames[i]} is its own ancestor`);
    state[i] = 1;
    const p = parent[i]!;
    if (p >= 0) resolve(p);
    m4ComposeTRS(local, 0, bindT, i * 3, bindR, i * 4, bindS, i * 3);
    if (p >= 0) m4Mul(model, i * 16, model, p * 16, local, 0);
    else if (nodes[i]!.above) m4Mul(model, i * 16, nodes[i]!.above as Num, 0, local, 0);
    else model.set(local, i * 16);
    state[i] = 2;
  };
  for (let i = 0; i < n; i++) resolve(i);
  const bindModel = Float32Array.from(model);

  const lookup = new Map<string, number>();
  for (let i = 0; i < n; i++) if (!lookup.has(bones[i]!)) lookup.set(bones[i]!, i);
  for (let i = 0; i < n; i++) if (!lookup.has(sourceNames[i]!)) lookup.set(sourceNames[i]!, i);
  const hips = lookup.get('Hips') ?? -1;
  return {
    id,
    family: opts.family ?? classifyRig(sourceNames, parent, bindModel, opts.familyRules),
    bones,
    sourceNames,
    parent,
    bindT,
    bindR,
    bindS,
    bindModel,
    hipsRestHeight: hips >= 0 ? model[hips * 16 + 13]! : 0,
    index: (name) => lookup.get(name) ?? -1,
  };
}

/**
 * The model-space matrix a bone's local TRS is relative to: its parent's bind matrix, or for a root bone the matrix of the
 * non-bone nodes above it (`bindModel(root) · local(root)⁻¹`; the identity for every live body).
 */
export function rigParentMatrix<T extends Num>(rig: RigBones, bone: number, out: T, oo = 0): T {
  const p = rig.parent[bone]!;
  if (p >= 0) {
    for (let k = 0; k < 16; k++) out[oo + k] = rig.bindModel[p * 16 + k]!;
    return out;
  }
  const local = new Float64Array(16);
  m4ComposeTRS(local, 0, rig.bindT, bone * 3, rig.bindR, bone * 4, rig.bindS, bone * 3);
  m4InvertAffine(local, 0, local, 0);
  return m4Mul(out, oo, rig.bindModel, bone * 16, local, 0);
}

// ── JSON form (assets/motion/rigs/<id>.json) ────────────────────────────────────────────────────────────────────────────────

export interface RigDefJson {
  id: string;
  family: RigFamily;
  /** node names as loaded; canonical names are derived */
  sourceNames: string[];
  parent: number[];
  bindT: number[];
  bindR: number[];
  bindS: number[];
  /** root bone index → the matrix above it (16, column-major); absent when every root sits under the identity */
  above?: Record<string, number[]>;
}

const round = (v: number, digits: number): number => {
  const f = 10 ** digits;
  const r = Math.round(v * f) / f;
  return r === 0 ? 0 : r;
};

/** The stored form: bind TRS only, `bindModel` and `hipsRestHeight` are derived on load. Values rounded to `digits` decimals. */
export function rigToJson(rig: RigDef, digits = 6): RigDefJson {
  const j: RigDefJson = {
    id: rig.id,
    family: rig.family,
    sourceNames: [...rig.sourceNames],
    parent: Array.from(rig.parent),
    bindT: Array.from(rig.bindT, (v) => round(v, digits)),
    bindR: Array.from(rig.bindR, (v) => round(v, digits)),
    bindS: Array.from(rig.bindS, (v) => round(v, digits)),
  };
  const above: Record<string, number[]> = {};
  const m = new Float64Array(16);
  for (let i = 0; i < rig.parent.length; i++) {
    if (rig.parent[i]! >= 0) continue;
    rigParentMatrix(rig, i, m);
    if (!isIdentity16(m, 0.5 * 10 ** -digits)) above[String(i)] = Array.from(m, (v) => round(v, digits));
  }
  if (Object.keys(above).length > 0) j.above = above;
  return j;
}

const isNums = (v: unknown, len: number): v is number[] => Array.isArray(v) && v.length === len && v.every((x) => typeof x === 'number' && Number.isFinite(x));
const FAMILIES: readonly string[] = ['platform-v3', 'mixamo', 'library-src', 'viewmodel', 'creature', 'unknown'];

/** Validates the stored form and rebuilds the RigDef (bind matrices by FK). Throws with the rig id on malformed input. */
export function rigFromJson(v: unknown): RigDef {
  if (typeof v !== 'object' || v === null || typeof (v as { id?: unknown }).id !== 'string') throw new Error('rig json: expected an object with an id');
  const j = v as Partial<RigDefJson> & { id: string };
  const names = j.sourceNames;
  if (!Array.isArray(names) || names.length === 0 || !names.every((s) => typeof s === 'string')) throw new Error(`rig json ${j.id}: sourceNames must be a list of names`);
  const n = names.length;
  if (!isNums(j.parent, n) || !isNums(j.bindT, n * 3) || !isNums(j.bindR, n * 4) || !isNums(j.bindS, n * 3)) {
    throw new Error(`rig json ${j.id}: parent / bindT / bindR / bindS do not match ${n} bones`);
  }
  if (typeof j.family !== 'string' || !FAMILIES.includes(j.family)) throw new Error(`rig json ${j.id}: bad family ${String(j.family)}`);
  const { parent, bindT, bindR, bindS } = j;
  const nodes: RigNode[] = names.map((name, i) => {
    const above = j.above?.[String(i)];
    if (above !== undefined && !isNums(above, 16)) throw new Error(`rig json ${j.id}: above[${i}] must be 16 numbers`);
    return { name, parent: parent[i]!, t: bindT.slice(i * 3, i * 3 + 3), r: bindR.slice(i * 4, i * 4 + 4), s: bindS.slice(i * 3, i * 3 + 3), above };
  });
  return buildRigDef(j.id, nodes, { family: j.family });
}

// ── glTF ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The part of a glTF document the skeleton reader touches. */
export interface GltfSkeletonJson {
  nodes?: ReadonlyArray<{
    name?: string;
    children?: readonly number[];
    translation?: readonly number[];
    rotation?: readonly number[];
    scale?: readonly number[];
    matrix?: readonly number[];
  }>;
  skins?: ReadonlyArray<{ joints: readonly number[] }>;
}

/**
 * The bones of a glTF document as builder input: the joints of its skins in skin order (duplicates dropped), or every node
 * when the file has no skin (the library clip files: 27 to 55 bare nodes under Hips [M]). A non-joint node between two joints
 * becomes a bone too (appended), so local transforms always chain; non-joint nodes above the top joints are folded into `above`.
 */
export function rigNodesFromGltf(json: GltfSkeletonJson): RigNode[] {
  const nodes = json.nodes ?? [];
  const parentOf = new Int32Array(nodes.length).fill(-1);
  nodes.forEach((nd, i) => {
    for (const c of nd.children ?? []) {
      if (c < 0 || c >= nodes.length) throw new Error(`gltf: node ${i} lists a missing child ${c}`);
      parentOf[c] = i;
    }
  });
  const order: number[] = [];
  const boneOf = new Int32Array(nodes.length).fill(-1);
  const add = (i: number): void => {
    if (i < 0 || i >= nodes.length) throw new Error(`gltf: a skin lists a missing joint ${i}`);
    if (boneOf[i]! >= 0) return;
    boneOf[i] = order.length;
    order.push(i);
  };
  if (json.skins && json.skins.length > 0) for (const s of json.skins) for (const jn of s.joints) add(jn);
  else nodes.forEach((_, i) => add(i));
  // a non-joint node with a joint above and a joint below it joins the skeleton
  for (let k = 0; k < order.length; k++) {
    const between: number[] = [];
    for (let p = parentOf[order[k]!]!; p >= 0; p = parentOf[p]!) {
      if (boneOf[p]! >= 0) {
        for (const b of between) add(b);
        break;
      }
      between.push(p);
    }
  }
  const localOf = (i: number, out: Float64Array): Float64Array => {
    const nd = nodes[i]!;
    if (nd.matrix) {
      for (let k = 0; k < 16; k++) out[k] = nd.matrix[k] ?? (k % 5 === 0 ? 1 : 0);
      return out;
    }
    return m4ComposeTRS(out, 0, (nd.translation ?? [0, 0, 0]) as number[], 0, (nd.rotation ?? [0, 0, 0, 1]) as number[], 0, (nd.scale ?? [1, 1, 1]) as number[], 0);
  };
  const tmp = new Float64Array(16);
  return order.map((i): RigNode => {
    const nd = nodes[i]!;
    const name = nd.name ?? `node${i}`;
    if (nd.matrix) throw new Error(`gltf: bone ${name} carries a matrix instead of TRS`);
    const p = parentOf[i]!;
    const base = { name, t: nd.translation, r: nd.rotation, s: nd.scale };
    if (p >= 0 && boneOf[p]! >= 0) return { ...base, parent: boneOf[p]! };
    if (p < 0) return { ...base, parent: -1 };
    const above = m4Identity(new Float64Array(16), 0);
    for (let a = p; a >= 0; a = parentOf[a]!) m4Mul(above, 0, localOf(a, tmp), 0, above, 0);
    return isIdentity16(above) ? { ...base, parent: -1 } : { ...base, parent: -1, above };
  });
}

/** RigDef of a glTF document (see `rigNodesFromGltf`). */
export function rigFromGltf(id: string, json: GltfSkeletonJson, opts: { family?: RigFamily; familyRules?: readonly RigFamilyRule[] } = {}): RigDef {
  return buildRigDef(id, rigNodesFromGltf(json), opts);
}
