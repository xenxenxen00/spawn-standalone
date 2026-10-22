// Procedural rigs (plan item K3): a scripted-geometry module's `skeleton()` export parsed into a rig of named rigid bones,
// and that rig as the motion package's `RigDef`, so the existing mixer, Pose FK, three skin adapter and bone attachments
// take it unchanged (see DESIGN.md).
//
// `skeleton()` returns `{ <bone>: { parent?: string | null, pivot: [x, y, z] } }` (engine skills/geometry.md:17). PIVOTS ARE IN
// THE MODEL'S REST FRAME, not the parent's: the generators emit every part in model coordinates and the sims' own FK carries
// a point about each pivot as given (`p' = pivot + R·(p − pivot) + (0, y, 0)`, DESIGN.md §5). As a RigDef a bone's local bind
// translation is therefore `pivot − parent.pivot`, its bind rotation the identity, its bind model matrix a pure translation
// to its pivot. Engine-free and three-free.
import { buildRigDef, type RigDef, type RigNode } from '../../compat/motion/rig.ts';

export interface SkeletonBone {
  readonly name: string;
  /** parent bone name, null = a root */
  readonly parent: string | null;
  /** model rest frame, metres */
  readonly pivot: readonly [number, number, number];
}

/** A parsed `skeleton()`: bones parents first, in declaration order otherwise. */
export interface SkeletonSpec {
  readonly bones: readonly SkeletonBone[];
}

export class SkeletonError extends Error {
  override readonly name = 'SkeletonError';
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function readPivot(name: string, v: unknown): [number, number, number] {
  if (v === undefined || v === null) return [0, 0, 0];
  let xyz: unknown[] | null = null;
  if (Array.isArray(v)) xyz = v;
  else if (isObj(v)) xyz = [v['x'] ?? 0, v['y'] ?? 0, v['z'] ?? 0];
  if (xyz === null || xyz.length < 3 || !xyz.slice(0, 3).every((c) => typeof c === 'number' && Number.isFinite(c))) {
    throw new SkeletonError(`skeleton: bone ${name} has a bad pivot ${JSON.stringify(v)}`);
  }
  return [xyz[0] as number, xyz[1] as number, xyz[2] as number];
}

/**
 * Parses what `skeleton()` returned. Throws a SkeletonError for a non-object, an empty skeleton, an unknown parent, a cycle or
 * a bad pivot. Bones are reordered parents-first (stable), which is the order of the rig's joint indices.
 */
export function parseSkeleton(raw: unknown): SkeletonSpec {
  if (!isObj(raw)) throw new SkeletonError(`skeleton() returned ${raw === null ? 'null' : typeof raw}, not an object`);
  const names = Object.keys(raw);
  if (names.length === 0) throw new SkeletonError('skeleton() returned no bones');
  const parsed = new Map<string, SkeletonBone>();
  for (const name of names) {
    const def = raw[name];
    if (!isObj(def)) throw new SkeletonError(`skeleton: bone ${name} is not an object`);
    const p = def['parent'];
    if (p !== undefined && p !== null && typeof p !== 'string') throw new SkeletonError(`skeleton: bone ${name} has a bad parent`);
    parsed.set(name, { name, parent: typeof p === 'string' && p !== '' ? p : null, pivot: readPivot(name, def['pivot']) });
  }
  for (const b of parsed.values()) {
    if (b.parent !== null && !parsed.has(b.parent)) throw new SkeletonError(`skeleton: bone ${b.name} names an unknown parent ${b.parent}`);
  }
  const out: SkeletonBone[] = [];
  const state = new Map<string, 1 | 2>();
  const place = (b: SkeletonBone): void => {
    const s = state.get(b.name);
    if (s === 2) return;
    if (s === 1) throw new SkeletonError(`skeleton: bone ${b.name} is its own ancestor`);
    state.set(b.name, 1);
    if (b.parent !== null) place(parsed.get(b.parent)!);
    out.push(b);
    state.set(b.name, 2);
  };
  for (const b of parsed.values()) place(b);
  return { bones: out };
}

/** The rig of a parsed skeleton as the motion package's RigDef (bone i = joint i = `spec.bones[i]`). */
export function rigFromSkeleton(id: string, spec: SkeletonSpec): RigDef {
  const index = new Map(spec.bones.map((b, i) => [b.name, i] as const));
  const nodes: RigNode[] = spec.bones.map((b) => {
    const p = b.parent === null ? null : spec.bones[index.get(b.parent)!]!;
    const ss = p?.pivot ?? [0, 0, 0];
    return { name: b.name, parent: p === null ? -1 : index.get(p.name)!, t: [b.pivot[0] - ss[0], b.pivot[1] - ss[1], b.pivot[2] - ss[2]] };
  });
  return buildRigDef(id, nodes, { family: 'unknown' });
}

/** The pivot of every bone, 3 per bone in rig order (model rest frame). */
export function pivotsOf(rig: Pick<RigDef, 'bones' | 'bindModel'>): Float32Array {
  const n = rig.bones.length;
  const out = new Float32Array(n * 3);
  for (let b = 0; b < n; b++) {
    out[b * 3] = rig.bindModel[b * 16 + 12]!;
    out[b * 3 + 1] = rig.bindModel[b * 16 + 13]!;
    out[b * 3 + 2] = rig.bindModel[b * 16 + 14]!;
  }
  return out;
}

/**
 * The rig of a generator module (INTEGRATION.md H4): calls its `skeleton()` export once, parses it and builds the RigDef (id =
 * the script). Null for a module without `skeleton`. Throws a SkeletonError for a bad skeleton (or what `skeleton()` throws).
 */
export function moduleRig(script: string, mod: { skeleton?: () => unknown }): { spec: SkeletonSpec; rig: RigDef } | null {
  if (typeof mod.skeleton !== 'function') return null;
  const spec = parseSkeleton(mod.skeleton());
  return { spec, rig: rigFromSkeleton(script, spec) };
}
