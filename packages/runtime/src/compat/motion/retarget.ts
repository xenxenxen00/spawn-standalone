// Binding clips to rigs and retargeting library clips (docs/design/motion-physics-nav.md §3.4.2, D-MPN-05): a clip resolved
// against one RigDef is a `BoundClip` (bone indices per track, per-bone ownership). Authored delta clips and a model's own
// clips bind by bone name; an absolute clip expressed on another rig (`sourceRig`, the library clips) is retargeted: computed
// once per (clipId, rigId) on first use and cached. three-free, Node-free.
//
// The retarget is a swing-aligned transfer of model-space rotations. With F the yaw that turns the source's facing onto the
// target's, `Rest` a bone's model-space bind rotation and `G` its animated model-space rotation:
//
//   G_t(b) = F · G_s(b') · Rest_s(b')⁻¹ · F⁻¹ · A(b) · Rest_t(b)        b' = the source bone mapped to target bone b
//
// so a source at rest leaves the target at `A(b) · Rest_t(b)`, and any source motion is replayed in the body's own frame.
// Local rotations follow as `L_t(b) = G_t(parent)⁻¹ · G_t(b)`. Bone-local axes never enter (they differ per family, AGENTS.md:131).
//
// Measured facts this file is built on (they refine motion §3.4.2, which was written before the files were read):
//   - Facing. The library skeleton and the mixamo operators face +Z (left side at +X), the platform bodies face −Z, so a
//     plain copy of model-space rotations would mirror every sideways lean: F is that half turn, derived from the hip joints.
//   - Rest rotations. The source's body bones rest at the identity but its finger roots do not, hence `Rest_s⁻¹` above
//     (it is the identity for the body, giving the document's `G_s · A · Rest_t`).
//   - Key times. Library tracks do not share key times (the files thin keys per bone), so each output track is sampled on the
//     union of the key times of exactly the source bones that drive it: its own track's times for a limb bone.
//   - Rest alignment A(b) (the shortest arc from the target's rest bone direction to the source's) is applied to the limb
//     segments only: upper arm, forearm, hand, fingers, thigh, shin. That is what "absorbs A-pose versus T-pose and different
//     limb splay". Hips, spine, neck, head, clavicles, feet and toes rest in the same anatomical attitude in every rig
//     (upright, shoulders relaxed, soles flat) while their joints sit at arbitrary places inside the body: aligning their
//     joint-to-joint directions would tilt the operators' pelvis 8° sideways and shrug their shoulders 30° [M], so they take
//     the pure transfer (A = identity). A hand is aligned by its own tip in each rig (the middle finger root, else the end
//     marker), so both library rigs give the same wrist; a hand without one and a finger tip inherit their parent's alignment.
//   - Hips height. Scaling the Hips translation by the ratio of bind hips heights only suits a target that stands like the
//     source. The four nonstandard humanoid rigs stand at bind with splayed, bent legs (straightened onto the source's
//     vertical legs the same bones reach 8 cm further down), their shins are 60 % of the leg (source 52 %) and their feet
//     40 % longer in proportion [M]: with the plain scaling their toes sink up to 22 cm into the ground in walk-loop. So the
//     scale is the ratio of *standing* heights (bind height plus what the straightened legs gain), and the Hips height is
//     then set per key so the lowest foot bone is as far from the ground as the source's lowest foot bone, at that scale.
//     That moves the Hips off the plain scaling by at most 1.9 % of its height on the 16 upright enemies (1.8 cm) and 0.6 %
//     on the operators in walk and run, and by up to 6.0 % on those bosses [M].
import { type BoundClip, type CompiledClip, type Track, makeTrack, sampleTrack } from './clip.ts';
import { m4ComposeTRS, m4InvertAffine, m4Mul, m4TransformPoint, qConjugate, qDot, qFromAxisAngle, qMul, qNormalize, qRotateVec3, type Num } from './quat.ts';
import { type RigBones, type RigDef, rigParentMatrix } from './rig.ts';

/**
 * A rig as binding and retargeting read it: the bone data of a `RigDef`. The mixer's `PoseRig` (pose.ts) has this shape, so
 * its rigs pass as they are; `family` is only used to word errors.
 */
export type Rig = RigBones;
const familyOf = (rig: Rig): string => (rig as Partial<RigDef>).family ?? 'rig';

// ── humanoid structure ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** The bones a retarget needs to find in a rig. */
export interface HumanoidShape {
  hips: number;
  /** the spine: the bones from below Hips up to the one that carries the neck and both shoulders, root → top */
  chain: number[];
  head: number;
  /** left and right arm roots (the clavicle, or the upper arm of a rig without one) */
  arms: [number, number];
}

/** A bone and its ancestors, the bone first. */
const ancestors = (rig: Rig, bone: number): number[] => {
  const out: number[] = [];
  for (let b = bone; b >= 0; b = rig.parent[b]!) out.push(b);
  return out;
};

/**
 * Finds the humanoid structure by topology: the spine is the path from Hips to the deepest common ancestor of the head and
 * both arm roots, whatever its bones are called. Throws when the rig has no Hips, head, arms or spine.
 */
export function humanoidShape(rig: Rig): HumanoidShape {
  const need = (names: readonly string[], what: string): number => {
    for (const n of names) {
      const i = rig.index(n);
      if (i >= 0) return i;
    }
    throw new Error(`rig ${rig.id} (${familyOf(rig)}) has no ${what}`);
  };
  const hips = need(['Hips'], 'Hips bone');
  const head = need(['Head'], 'Head bone');
  const left = need(['LeftShoulder', 'LeftArm'], 'left arm');
  const right = need(['RightShoulder', 'RightArm'], 'right arm');
  const up = [head, left, right].map((b) => ancestors(rig, b));
  const top = up[0]!.find((b) => b !== head && up[1]!.includes(b) && up[2]!.includes(b));
  const below = top === undefined ? [] : ancestors(rig, top);
  const at = below.indexOf(hips);
  if (top === undefined || at <= 0) throw new Error(`rig ${rig.id} (${familyOf(rig)}) has no spine between Hips and the shoulders`);
  return { hips, chain: below.slice(0, at).reverse(), head, arms: [left, right] };
}

/** Source spine bone of target spine bone `i` of `n`, for a source spine of `m`: by chain position, the top always on the top. */
export function spineChainIndex(i: number, n: number, m: number): number {
  if (i >= n - 1 || n <= 1) return m - 1;
  return Math.min(m - 1, Math.round((i * (m - 1)) / (n - 1)));
}

interface Shapes {
  source: HumanoidShape;
  target: HumanoidShape;
}

/**
 * Maps each target bone to a source bone (−1 = unmapped, the bone follows its parent): Hips to Hips, the spine by chain
 * position, everything else by canonical name (exact, then case-insensitive: `neck` ↔ `Neck`).
 */
export function mapBones(source: Rig, target: Rig, shapes?: Shapes): Int16Array {
  const s = shapes?.source ?? humanoidShape(source);
  const t = shapes?.target ?? humanoidShape(target);
  const lower = new Map<string, number>();
  source.bones.forEach((b, i) => {
    const k = b.toLowerCase();
    if (!lower.has(k)) lower.set(k, i);
  });
  const spine = new Set(s.chain);
  const map = new Int16Array(target.bones.length).fill(-1);
  target.bones.forEach((name, b) => {
    if (b === t.hips) map[b] = s.hips;
    else {
      const i = t.chain.indexOf(b);
      if (i >= 0) map[b] = s.chain[spineChainIndex(i, t.chain.length, s.chain.length)]!;
      else {
        const exact = source.index(name);
        const hit = exact >= 0 ? exact : (lower.get(name.toLowerCase()) ?? -1);
        // a spine or hips bone of the source is only ever reached through the chain rule
        map[b] = hit >= 0 && hit !== s.hips && !spine.has(hit) ? hit : -1;
      }
    }
  });
  return map;
}

// ── rotation helpers (doubles) ──────────────────────────────────────────────────────────────────────────────────────────────

type Quat = [number, number, number, number];

/** Rotation of the linear part of a column-major 4×4 (axes normalised; scale dropped). */
function qFromM4(m: Num, o: number): Quat {
  const c = [0, 1, 2].map((k) => {
    const x = m[o + k * 4]!, y = m[o + k * 4 + 1]!, z = m[o + k * 4 + 2]!;
    const l = Math.hypot(x, y, z) || 1;
    return [x / l, y / l, z / l] as const;
  });
  const m00 = c[0]![0], m10 = c[0]![1], m20 = c[0]![2];
  const m01 = c[1]![0], m11 = c[1]![1], m21 = c[1]![2];
  const m02 = c[2]![0], m12 = c[2]![1], m22 = c[2]![2];
  const tr = m00 + m11 + m22;
  let q: Quat;
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2;
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, s / 4];
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    q = [s / 4, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s];
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    q = [(m01 + m10) / s, s / 4, (m12 + m21) / s, (m02 - m20) / s];
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    q = [(m02 + m20) / s, (m12 + m21) / s, s / 4, (m10 - m01) / s];
  }
  return qNormalize(q, 0, q, 0);
}

/** The shortest rotation taking unit vector a onto unit vector b. */
function shortestArc(a: readonly number[], b: readonly number[]): Quat {
  const d = a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
  if (d > 1 - 1e-12) return [0, 0, 0, 1];
  if (d < -1 + 1e-9) {
    // opposite: half a turn about any axis perpendicular to a
    const ax = Math.abs(a[0]!) < 0.9 ? [1, 0, 0] : [0, 1, 0];
    const x = a[1]! * ax[2]! - a[2]! * ax[1]!, y = a[2]! * ax[0]! - a[0]! * ax[2]!, z = a[0]! * ax[1]! - a[1]! * ax[0]!;
    const l = Math.hypot(x, y, z);
    return [x / l, y / l, z / l, 0];
  }
  const q: Quat = [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!, 1 + d];
  return qNormalize(q, 0, q, 0);
}

const mul = (a: Readonly<Quat>, b: Readonly<Quat>): Quat => qMul([0, 0, 0, 1], 0, a as Quat, 0, b as Quat, 0);
const inv = (a: Readonly<Quat>): Quat => qConjugate([0, 0, 0, 1], 0, a as Quat, 0);
const bonePos = (rig: Rig, b: number): [number, number, number] => [rig.bindModel[b * 16 + 12]!, rig.bindModel[b * 16 + 13]!, rig.bindModel[b * 16 + 14]!];

/** Model-space bind rotation of every bone (`rest`), and of what each bone's local rotation is relative to (`above`). */
function restRotations(rig: Rig): { rest: Quat[]; above: (b: number) => Readonly<Quat> } {
  const n = rig.bones.length;
  const rest = new Array<Quat | undefined>(n).fill(undefined);
  const aboveRoot = new Map<number, Quat>();
  const m = new Float64Array(16);
  const rootAbove = (b: number): Quat => {
    let q = aboveRoot.get(b);
    if (!q) aboveRoot.set(b, (q = qFromM4(rigParentMatrix(rig, b, m), 0)));
    return q;
  };
  const get = (b: number): Quat => {
    const have = rest[b];
    if (have) return have;
    const local: Quat = [rig.bindR[b * 4]!, rig.bindR[b * 4 + 1]!, rig.bindR[b * 4 + 2]!, rig.bindR[b * 4 + 3]!];
    const p = rig.parent[b]!;
    const q = mul(p >= 0 ? get(p) : rootAbove(b), qNormalize(local, 0, local, 0));
    rest[b] = q;
    return q;
  };
  for (let b = 0; b < n; b++) get(b);
  return { rest: rest as Quat[], above: (b) => (rig.parent[b]! >= 0 ? rest[rig.parent[b]!]! : rootAbove(b)) };
}

/** Heading of a rig's left side on the ground plane (radians about +Y from +Z), from the hip joints or else the arm roots. */
function leftHeading(rig: Rig, shape: HumanoidShape): number | null {
  const pairs: Array<[number, number]> = [[rig.index('LeftUpLeg'), rig.index('RightUpLeg')], shape.arms];
  for (const [l, r] of pairs) {
    if (l < 0 || r < 0) continue;
    const a = bonePos(rig, l), b = bonePos(rig, r);
    const x = a[0] - b[0], z = a[2] - b[2];
    if (Math.hypot(x, z) > 1e-6) return Math.atan2(x, z);
  }
  return null;
}

/** A heading difference this close to a quarter turn is one: hip joints are not placed symmetrically to the millimetre. */
const FACING_SNAP_RAD = (3 * Math.PI) / 180;

/**
 * The yaw that turns the source's facing onto the target's (the identity when either has no measurable left side). The
 * hollow's hip joints put it 0.8° off a half turn [M]; a difference within 3° of a quarter turn is taken as that quarter turn.
 */
export function facingYaw(source: Rig, target: Rig, shapes?: Shapes): [number, number, number, number] {
  const hs = leftHeading(source, shapes?.source ?? humanoidShape(source));
  const ht = leftHeading(target, shapes?.target ?? humanoidShape(target));
  if (hs === null || ht === null) return [0, 0, 0, 1];
  const quarter = Math.PI / 2;
  const yaw = ht - hs;
  const snapped = Math.round(yaw / quarter) * quarter;
  return qFromAxisAngle([0, 0, 0, 1], 0, 0, 1, 0, Math.abs(yaw - snapped) < FACING_SNAP_RAD ? snapped : yaw);
}

/** Limb segments whose rest direction is aligned to the source's (see the header). */
const ALIGNED = /^(Left|Right)(Arm|ForeArm|UpLeg|Leg|Hand.*)$/;
const HAND = /^(Left|Right)Hand$/;
/**
 * The child a hand's rest direction runs to: its middle finger root, else its end marker (`LeftHandMiddle1`, `LeftHandEnd`);
 * −1 for a hand without either (the platform bodies), which then takes the alignment of its forearm.
 */
function handTip(rig: Rig, hand: number): number {
  for (const suffix of ['Middle1', 'End']) {
    const tip = rig.index(`${rig.bones[hand]!}${suffix}`);
    if (tip >= 0 && rig.parent[tip] === hand) return tip;
  }
  return -1;
}
/** The bones the ground contact is measured on. */
const FOOT_BONES: readonly string[] = ['LeftFoot', 'RightFoot', 'LeftToeBase', 'RightToeBase'];

// ── binding by name ─────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Binds a clip to a rig by bone name, tracks untouched: authored delta clips, clip functions and a model's own clips. A track
 * on a bone the rig lacks keeps index −1 (the mixer skips it).
 */
export function bindByName(clip: CompiledClip, rig: Rig): BoundClip {
  const boneIdx = new Int16Array(clip.tracks.length);
  const names = new Uint8Array(rig.bones.length);
  clip.tracks.forEach((t, i) => {
    const b = rig.index(t.bone);
    boneIdx[i] = b;
    if (b >= 0) names[b] = 1;
  });
  return { clip, rigId: rig.id, boneIdx, names, kind: clip.kind };
}

// ── retarget plan (per rig pair) ────────────────────────────────────────────────────────────────────────────────────────────

/** How one target bone is driven: `L_t = pre · (∏ up)⁻¹ · (∏ down) · post` over the source's animated local rotations. */
interface BonePlan {
  bone: number;
  /** source bones from the common ancestor (exclusive) down to the bone mapped to the target's mapped parent */
  up: number[];
  /** source bones from the common ancestor (exclusive; from the root for the topmost mapped bone) down to the mapped bone */
  down: number[];
  pre: Quat;
  post: Quat;
}

/** One side of the ground-contact measurement: the leg bones below Hips (parents first) and the foot bones among them. */
interface LegPlan {
  /** bones on the paths Hips → foot bones, Hips excluded, every parent before its children */
  order: number[];
  feet: number[];
  /** bind height of each foot bone */
  bindY: number[];
  /** the matrix Hips is local to */
  above: Float64Array;
}

/** Everything about a (source rig, target rig) pair that does not depend on the clip. */
export interface RetargetPlan {
  readonly source: Rig;
  readonly target: Rig;
  /** per target bone: the source bone, −1 when unmapped */
  readonly map: Int16Array;
  /** the yaw from the source's facing to the target's (x, y, z, w) */
  readonly facing: readonly number[];
  /** per target bone: the rest alignment A(b) (x, y, z, w); the identity where none applies */
  readonly align: ReadonlyArray<readonly number[]>;
  /** metres the target's ankles drop when its legs are straightened onto the source's rest directions (mean of both) */
  readonly footDrop: number;
  /** `(hipsRest_t + footDrop) / hipsRest_s`: what source Hips offsets and heights are multiplied by */
  readonly hipsScale: number;
  /** @internal */
  readonly bones: readonly BonePlan[];
  /** @internal */
  readonly shapes: Shapes;
  /** @internal null when no foot bone is mapped (no ground contact to keep) */
  readonly legs: { source: LegPlan; target: LegPlan } | null;
}

const plans = new WeakMap<Rig, WeakMap<Rig, RetargetPlan>>();

/**
 * The clip-independent part of a retarget, computed once per rig pair. Throws when either rig is not a humanoid the mapping
 * can use (no Hips, head, arms or spine).
 */
export function retargetPlan(source: Rig, target: Rig): RetargetPlan {
  let forSource = plans.get(source);
  if (!forSource) plans.set(source, (forSource = new WeakMap()));
  const cached = forSource.get(target);
  if (cached) return cached;

  const shapes: Shapes = { source: humanoidShape(source), target: humanoidShape(target) };
  const map = mapBones(source, target, shapes);
  const F = facingYaw(source, target, shapes);
  const Fi = inv(F);
  const S = restRotations(source);
  const T = restRotations(target);
  const nT = target.bones.length;

  // nearest mapped ancestor and children of every target bone
  const mappedParent = new Int16Array(nT).fill(-1);
  const kids: number[][] = Array.from({ length: nT }, () => []);
  for (let b = 0; b < nT; b++) {
    if (target.parent[b]! >= 0) kids[target.parent[b]!]!.push(b);
    let p = target.parent[b]!;
    while (p >= 0 && map[p]! < 0) p = target.parent[p]!;
    mappedParent[b] = p;
  }

  const align = new Array<Quat | undefined>(nT).fill(undefined);
  const alignOf = (b: number): Quat => {
    const have = align[b];
    if (have) return have;
    let a: Quat | undefined;
    const name = target.bones[b]!;
    if (map[b]! >= 0 && ALIGNED.test(name)) {
      // the bones the rest direction runs to, on either side: a hand's own tip in each rig (they need not be the same bone:
      // the body-only library rig ends its hands in HandEnd where the finger rig and the operators have Middle1), else the
      // first mapped child and the source bone it maps to
      let childT = -1, childS = -1;
      if (HAND.test(name)) {
        childT = handTip(target, b);
        childS = handTip(source, map[b]!);
      } else {
        childT = kids[b]!.find((c) => map[c]! >= 0) ?? -1;
        childS = childT >= 0 ? map[childT]! : -1;
      }
      if (childT >= 0 && childS >= 0) {
        const pt = bonePos(target, b), ct = bonePos(target, childT);
        const ps = bonePos(source, map[b]!), cs = bonePos(source, childS);
        const dt = [ct[0] - pt[0], ct[1] - pt[1], ct[2] - pt[2]];
        const ds = qRotateVec3([0, 0, 0], 0, F, 0, [cs[0] - ps[0], cs[1] - ps[1], cs[2] - ps[2]], 0);
        const lt = Math.hypot(dt[0]!, dt[1]!, dt[2]!), ls = Math.hypot(ds[0]!, ds[1]!, ds[2]!);
        if (lt > 1e-6 && ls > 1e-6) a = shortestArc(dt.map((v) => v / lt), ds.map((v) => v / ls));
      }
      // a hand without fingers, a finger tip: keep the attitude its parent segment was given
      if (!a && mappedParent[b]! >= 0 && ALIGNED.test(target.bones[mappedParent[b]!]!)) a = alignOf(mappedParent[b]!);
    }
    return (align[b] = a ?? [0, 0, 0, 1]);
  };

  const bones: BonePlan[] = [];
  for (let b = 0; b < nT; b++) {
    const sb = map[b]!;
    if (sb < 0) continue;
    const pa = mappedParent[b]!;
    const post = mul(mul(inv(S.rest[sb]!), Fi), mul(alignOf(b), T.rest[b]!));
    const parentRestInv = inv(T.above(b));
    const mine = ancestors(source, sb);
    if (pa >= 0) {
      const sp = map[pa]!;
      const theirs = ancestors(source, sp);
      const common = mine.find((x) => theirs.includes(x));
      if (common === undefined) throw new Error(`source bones ${source.bones[sb]} and ${source.bones[sp]} of rig ${source.id} share no ancestor`);
      bones.push({
        bone: b,
        up: theirs.slice(0, theirs.indexOf(common)).reverse(),
        down: mine.slice(0, mine.indexOf(common)).reverse(),
        pre: mul(mul(parentRestInv, inv(alignOf(pa))), mul(F, S.rest[sp]!)),
        post,
      });
    } else {
      const down = mine.reverse();
      bones.push({ bone: b, up: [], down, pre: mul(mul(parentRestInv, F), S.above(down[0]!) as Quat), post });
    }
  }

  // ground contact: the foot bones both rigs have, and the legs that carry them
  const pairs = FOOT_BONES.map((n) => target.index(n)).filter((b) => b >= 0 && map[b]! >= 0);
  const legPlan = (rig: Rig, hips: number, feet: number[]): LegPlan | null => {
    const order: number[] = [];
    for (const f of feet) {
      const path = ancestors(rig, f);
      const top = path.indexOf(hips);
      if (top < 0) return null;
      for (let k = top - 1; k >= 0; k--) if (!order.includes(path[k]!)) order.push(path[k]!);
    }
    return { order, feet, bindY: feet.map((f) => bonePos(rig, f)[1]), above: rigParentMatrix(rig, hips, new Float64Array(16)) };
  };
  const tLegs = pairs.length > 0 ? legPlan(target, shapes.target.hips, pairs) : null;
  const sLegs = pairs.length > 0 ? legPlan(source, shapes.source.hips, pairs.map((b) => map[b]!)) : null;

  // what the ankles gain when the rest alignment straightens the legs: walk Hips → ankle, turning each bone offset by the
  // alignment of the mapped bone it hangs from
  let drop = 0;
  let ankles = 0;
  for (const name of ['LeftFoot', 'RightFoot']) {
    const foot = target.index(name);
    if (foot < 0 || map[foot]! < 0) continue;
    const path = ancestors(target, foot);
    const top = path.indexOf(shapes.target.hips);
    if (top < 0) continue;
    let y = 0;
    for (let k = top - 1; k >= 0; k--) {
      const from = bonePos(target, path[k + 1]!), to = bonePos(target, path[k]!);
      const owner = map[path[k + 1]!]! >= 0 ? path[k + 1]! : mappedParent[path[k + 1]!]!;
      y += qRotateVec3([0, 0, 0], 0, owner >= 0 ? alignOf(owner) : [0, 0, 0, 1], 0, [to[0] - from[0], to[1] - from[1], to[2] - from[2]], 0)[1]!;
    }
    drop += bonePos(target, foot)[1] - (bonePos(target, shapes.target.hips)[1] + y);
    ankles++;
  }
  const footDrop = ankles > 0 ? drop / ankles : 0;
  const hipsScale = source.hipsRestHeight > 1e-6 && target.hipsRestHeight > 1e-6 ? (target.hipsRestHeight + footDrop) / source.hipsRestHeight : 1;

  for (let b = 0; b < nT; b++) alignOf(b);
  const plan: RetargetPlan = { source, target, map, facing: F, align: align as Quat[], footDrop, hipsScale, bones, shapes, legs: sLegs && tLegs ? { source: sLegs, target: tLegs } : null };
  forSource.set(target, plan);
  return plan;
}

// ── retarget ────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const failure = (clip: CompiledClip, target: Rig, why: string): Error => new Error(`retarget ${clip.id} → ${target.id}: ${why}`);

/** Sorted union of key times (exact equality). */
function unionTimes(tracks: readonly Track[]): Float64Array {
  if (tracks.length === 1) return Float64Array.from(tracks[0]!.times);
  const set = new Set<number>();
  for (const t of tracks) for (const v of t.times) set.add(v);
  return Float64Array.from(set).sort();
}

/**
 * Height of the lowest foot bone above its bind height at one instant: FK of the legs below a Hips placed at local position
 * `hipsPos` with local rotation `rotOf(hips)`.
 */
function lowestFoot(rig: Rig, hips: number, legs: LegPlan, hipsPos: Num, rotOf: (bone: number, out: Quat) => Quat, model: Float64Array, local: Float64Array, q: Quat): number {
  m4ComposeTRS(local, 0, hipsPos, 0, rotOf(hips, q), 0, rig.bindS, hips * 3);
  m4Mul(model, hips * 16, legs.above, 0, local, 0);
  for (const b of legs.order) {
    m4ComposeTRS(local, 0, rig.bindT, b * 3, rotOf(b, q), 0, rig.bindS, b * 3);
    m4Mul(model, b * 16, model, rig.parent[b]! * 16, local, 0);
  }
  let low = Infinity;
  for (let k = 0; k < legs.feet.length; k++) low = Math.min(low, model[legs.feet[k]! * 16 + 13]! - legs.bindY[k]!);
  return low;
}

/**
 * Retargets an absolute clip expressed on `source` onto `target` (motion §3.4.2): a rotation track per driven target bone,
 * sampled on the driving source keys, and the Hips translation at the target's scale with the ground contact of the source
 * (see the header). Target bones no source track drives get no track and are not owned (`names` 0): they follow their parent.
 * Throws, naming the clip and the rig, when either rig is not a humanoid the mapping can use; never returns an empty clip.
 */
export function retargetClip(clip: CompiledClip, source: Rig, target: Rig): BoundClip {
  if (clip.kind !== 'absolute') throw failure(clip, target, 'only absolute clips are retargeted (delta clips bind by bone name)');
  let plan: RetargetPlan;
  try {
    plan = retargetPlan(source, target);
  } catch (e) {
    throw failure(clip, target, (e as Error).message);
  }
  const nT = target.bones.length;
  const sHips = plan.shapes.source.hips, tHips = plan.shapes.target.hips;

  const rotation = new Map<number, Track>();
  let hipsPosition: Track | undefined;
  for (const t of clip.tracks) {
    const b = source.index(t.bone);
    if (b < 0) continue;
    if (t.prop === 'rotation' && !rotation.has(b)) rotation.set(b, t);
    else if (t.prop === 'position' && b === sHips && !hipsPosition) hipsPosition = t;
  }

  const tracks: Track[] = [];
  const boneIdx: number[] = [];
  const names = new Uint8Array(nT);
  const byBone = new Map<number, Track>();
  const q: Quat = [0, 0, 0, 1];
  const a: Quat = [0, 0, 0, 1];
  const u: Quat = [0, 0, 0, 1];
  const sourceLocal = (bone: number, time: number, out: Quat): Quat => {
    const tr = rotation.get(bone);
    if (tr) sampleTrack(tr, time, out, 0);
    else for (let k = 0; k < 4; k++) out[k] = source.bindR[bone * 4 + k]!;
    return out;
  };
  /** product of the animated local rotations along `path` (ancestor side first) */
  const chainAt = (path: readonly number[], time: number, out: Quat): Quat => {
    out[0] = out[1] = out[2] = 0;
    out[3] = 1;
    for (const bone of path) qMul(out, 0, out, 0, sourceLocal(bone, time, q), 0);
    return out;
  };

  for (const bp of plan.bones) {
    const driving: Track[] = [];
    for (const x of bp.up) if (rotation.has(x)) driving.push(rotation.get(x)!);
    for (const x of bp.down) if (rotation.has(x)) driving.push(rotation.get(x)!);
    if (driving.length === 0) continue;
    const times = unionTimes(driving);
    const values = new Float64Array(times.length * 4);
    for (let k = 0; k < times.length; k++) {
      const time = times[k]!;
      chainAt(bp.down, time, a);
      if (bp.up.length > 0) {
        qConjugate(u, 0, chainAt(bp.up, time, u), 0);
        qMul(a, 0, u, 0, a, 0);
      }
      qMul(a, 0, bp.pre, 0, a, 0);
      qMul(a, 0, a, 0, bp.post, 0);
      qNormalize(a, 0, a, 0);
      // same hemisphere as the previous key, so interpolation never takes the long way round
      const flip = k > 0 && qDot(a, 0, values, (k - 1) * 4) < 0 ? -1 : 1;
      for (let c = 0; c < 4; c++) values[k * 4 + c] = a[c]! * flip;
    }
    const track = makeTrack(target.bones[bp.bone]!, 'rotation', driving.every((t) => t.interp === 'step') ? 'step' : 'linear', times, values);
    tracks.push(track);
    boneIdx.push(bp.bone);
    byBone.set(bp.bone, track);
    names[bp.bone] = 1;
  }

  if (hipsPosition && plan.map[tHips]! >= 0) {
    // the Hips translation: bind_t + F · (t_src − bind_s) · hipsScale in model space, then its height set per key so the
    // lowest foot bone stands where the source's does (at the same scale)
    const legs = plan.legs;
    const drivers: Track[] = [hipsPosition];
    if (legs) {
      for (const b of [sHips, ...legs.source.order]) if (rotation.has(b)) drivers.push(rotation.get(b)!);
    }
    const times = unionTimes(drivers);
    const values = new Float64Array(times.length * 3);
    const unit = clip.units === 'hips' ? source.hipsRestHeight : 1;
    const fromSource = rigParentMatrix(source, sHips, new Float64Array(16));
    const toTarget = m4InvertAffine(new Float64Array(16), 0, rigParentMatrix(target, tHips, new Float64Array(16)), 0);
    const bs = bonePos(source, sHips), bt = bonePos(target, tHips);
    const F = plan.facing as Quat;
    const sModel = new Float64Array(source.bones.length * 16);
    const tModel = new Float64Array(nT * 16);
    const local = new Float64Array(16);
    const ps = [0, 0, 0];
    const p = [0, 0, 0];
    const pl = [0, 0, 0];
    let time = 0;
    const sourceRot = (bone: number, out: Quat): Quat => sourceLocal(bone, time, out);
    const targetRot = (bone: number, out: Quat): Quat => {
      const tr = byBone.get(bone);
      if (tr) sampleTrack(tr, time, out, 0);
      else for (let k = 0; k < 4; k++) out[k] = target.bindR[bone * 4 + k]!;
      return out;
    };
    for (let k = 0; k < times.length; k++) {
      time = times[k]!;
      sampleTrack(hipsPosition, time, ps, 0);
      ps[0] = ps[0]! * unit;
      ps[1] = ps[1]! * unit;
      ps[2] = ps[2]! * unit;
      m4TransformPoint(p, 0, fromSource, 0, ps, 0);
      p[0] = (p[0]! - bs[0]) * plan.hipsScale;
      p[1] = (p[1]! - bs[1]) * plan.hipsScale;
      p[2] = (p[2]! - bs[2]) * plan.hipsScale;
      qRotateVec3(p, 0, F, 0, p, 0);
      p[0] = p[0]! + bt[0];
      p[1] = p[1]! + bt[1] + plan.footDrop;
      p[2] = p[2]! + bt[2];
      m4TransformPoint(pl, 0, toTarget, 0, p, 0);
      if (legs) {
        const want = lowestFoot(source, sHips, legs.source, ps, sourceRot, sModel, local, q) * plan.hipsScale;
        const have = lowestFoot(target, tHips, legs.target, pl, targetRot, tModel, local, q);
        p[1] = p[1]! + (want - have);
        m4TransformPoint(pl, 0, toTarget, 0, p, 0);
      }
      values[k * 3] = pl[0]!;
      values[k * 3 + 1] = pl[1]!;
      values[k * 3 + 2] = pl[2]!;
    }
    tracks.push(makeTrack(target.bones[tHips]!, 'position', hipsPosition.interp, times, values));
    boneIdx.push(tHips);
    names[tHips] = 1;
  }

  if (tracks.length === 0) throw failure(clip, target, `no track of the clip drives a bone of the rig (source rig ${source.id})`);
  const out: { -readonly [K in keyof CompiledClip]: CompiledClip[K] } = { id: clip.id, kind: 'absolute', duration: clip.duration, units: 'm', tracks, sourceRig: target.id };
  if (clip.fps !== undefined) out.fps = clip.fps;
  return { clip: out, rigId: target.id, boneIdx: Int16Array.from(boneIdx), names, kind: 'absolute' };
}

// ── cache ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Finds a source rig by id (`clip.sourceRig`): `LibraryClips.rig` in the running game. */
export type SourceRigResolver = (id: string) => Rig | undefined;

interface Entry {
  clip: CompiledClip;
  bound?: BoundClip;
  error?: Error;
}

/**
 * Binds clips to rigs with a cache keyed (clipId, rigId), for every clip kind:
 * - a delta clip, a clip without `sourceRig` (a model's own clips) or one already on this rig binds by bone name;
 * - an absolute clip on another rig is retargeted, once; a pair that cannot be retargeted fails the same way every time.
 * `bind` throws on failure; `tryBind` answers null instead and is the mixer's bind seam (`MixerOptions.bind`, MA3).
 */
export class RetargetBinder {
  private readonly byRig = new Map<string, Map<string, Entry>>();
  private resolver: SourceRigResolver;
  private readonly onError: ((error: Error) => void) | undefined;

  /** `onError` hears of each pair that cannot be retargeted, once (not of a source rig that is merely not loaded yet). */
  constructor(sourceRig: SourceRigResolver = () => undefined, onError?: (error: Error) => void) {
    this.resolver = sourceRig;
    this.onError = onError;
  }

  setSourceRigs(resolver: SourceRigResolver): void {
    this.resolver = resolver;
  }

  /** The bound clip, an Error for a pair that cannot be bound, or null while the clip's source rig is not loaded. */
  private lookup(clip: CompiledClip, rig: Rig): BoundClip | Error | null {
    let clips = this.byRig.get(rig.id);
    if (!clips) this.byRig.set(rig.id, (clips = new Map()));
    const hit = clips.get(clip.id);
    // the same id on another clip object (a re-cooked file, an edited inline clip) is a different clip
    if (hit && hit.clip === clip) return hit.bound ?? hit.error!;
    const entry: Entry = { clip };
    if (clip.kind === 'delta' || clip.sourceRig === undefined || clip.sourceRig === rig.id) entry.bound = bindByName(clip, rig);
    else {
      const source = this.resolver(clip.sourceRig);
      if (!source) return null; // not cached: the rig may simply not be loaded yet
      try {
        entry.bound = retargetClip(clip, source, rig);
      } catch (e) {
        entry.error = e as Error;
        this.onError?.(entry.error);
      }
    }
    clips.set(clip.id, entry);
    return entry.bound ?? entry.error!;
  }

  /** Binds a clip to a rig; throws, naming the clip and the rig, when it cannot be (yet). */
  bind(clip: CompiledClip, rig: Rig): BoundClip {
    const r = this.lookup(clip, rig);
    if (r === null) throw failure(clip, rig, `its source rig ${clip.sourceRig} is not loaded`);
    if (r instanceof Error) throw r;
    return r;
  }

  /** Binds a clip to a rig; null when it cannot be bound, or not yet (the channel waits). Bound as a property: pass it as is. */
  readonly tryBind = (clip: CompiledClip, rig: Rig): BoundClip | null => {
    const r = this.lookup(clip, rig);
    return r === null || r instanceof Error ? null : r;
  };

  /** Forgets every clip bound to a rig (a model swap rebinds its clips to the new rig, motion §3.5.6). */
  dropRig(rigId: string): void {
    this.byRig.delete(rigId);
  }

  /** Forgets a clip on every rig (its file was reloaded). */
  dropClip(clipId: string): void {
    for (const clips of this.byRig.values()) clips.delete(clipId);
  }

  clear(): void {
    this.byRig.clear();
  }

  /** Number of cached (clip, rig) pairs. */
  get size(): number {
    let n = 0;
    for (const clips of this.byRig.values()) n += clips.size;
    return n;
  }
}

/** The binder of the running game. */
export const retargetBinder = new RetargetBinder();

/** Binds a clip to a rig through the game's binder (retargeting when the clip is expressed on another rig); throws on failure. */
export const bindClip = (clip: CompiledClip, rig: Rig): BoundClip => retargetBinder.bind(clip, rig);

/** Clears the game binder's cache for one rig. */
export const dropRig = (rigId: string): void => retargetBinder.dropRig(rigId);

/** Tells the game's binder where source rigs come from (`(id) => library.rig(id)`). */
export const setSourceRigs = (resolver: SourceRigResolver): void => retargetBinder.setSourceRigs(resolver);
