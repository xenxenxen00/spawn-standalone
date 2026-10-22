// Inverse kinematics (docs/design/motion-physics-nav.md §3.7, §3.11; docs/architecture.md X-13; WP MA4): the `ik` handle
// property, its target frames and ramps, and the two-bone solver. Engine-free: no three, no engine IK solver (three's
// `CCDIKSolver` iterates on the render bones and is not the live two-bone rule).
//
// LIVE SURFACE. `ik.leftArm` / `ik.rightArm` = `{ target: Vec3, weight: 1, blendIn: 0.12 }` or null (bots and held items:
// authored module, authored module); `ik.feet` only in the unreachable seat branch
// (scripts/humanoid-locomotion.js:172,182). `leftLeg` / `rightLeg` solve like the arms; `head` is accepted and does nothing; a
// string target names a row.
//
// WHEN. After the mixer, per presented frame, on the presented pose only. IK is never visible to game logic: bone probes read
// the un-IK'd sim pose (`attach.ts`).
//
// TARGET FRAME. A Vec3 target is a world point. It is converted at once, inside the write, into the owner's BODY-LOCAL frame
// (position and rotation of the row's simulated transform at that moment, no scale: the frame `localToWorld` of
// authored module builds the point in), and re-projected every frame with the interpolated transform the body
// is drawn at. The gun is a child of the body and renders interpolated; a world-space target would lag the hands by up to
// 0.2 m at 6 m/s. Bots rewrite a target only when it moved more than 0.01 m, so between writes the re-projection is what keeps
// the hands on the gun.
//   The conversion uses the transform the row has when the write arrives, not the one after the tick's physics step: that is
//   the transform the script built the point from (motion §3.11 lists the re-basing under step H; done there, a body that
//   moved in step E would get its grip shifted by one tick of travel).
//
// SOLVE (`solveTwoBone`). Chain upper → lower → end (`LeftArm → LeftForeArm → LeftHand`), lengths from the current pose, the
// target distance clamped to [|a − b| + 1 mm, a + b − 1 mm], the bend plane through the animated elbow (the pole is the elbow
// the clip gives: it follows the clip and never flips), the end bone keeps its animated local rotation. The result is blended
// into the clip pose by `weight × ramp` (slerp per bone).
//
// RAMPS. A write ramps the chain's weight from its current value to `weight` over `blendIn` seconds; null ramps it to 0 over
// the chain's `blendOut` (default 0.12 s, the live blendIn). Ramps run on sim time (`advanceTick`, step H) and are presented at
// the frame's alpha, like the mixer's: a paused sim holds them. A rewrite of a chain that is already ramping to the same
// weight only moves the target (bots rewrite at up to 30 Hz with the same blendIn; restarting the ramp each time would turn
// the 0.12 s fade into a slow exponential).
//
// FEET [P2]. Off unless `ik.feet === true` (or `{ offset }`) was written: per foot a static down-ray, a two-bone leg solve and
// a pelvis drop of at most 0.25 m. The ray is injected (`IkFrame.castDown`), so nothing here knows the physics engine.
//
// THE PRESENTED POSE. `solve` changes local rotations of the pose the mixer wrote. The mixer leaves a bone alone when no clip
// names it, so before the next evaluation `restore` puts the clip's own rotations back: the solve always starts from the
// animated pose, never from last frame's solved one.
import type { Kernel, PathSegment, PropChannel, PropChannelRegistry, RowRec, Vec3 } from '../core/types.ts';
import { m4Rotation, newSimWorld, simWorldOf, type RowLookup, type SimWorld } from './attach.ts';
import { IK_DEFAULTS, SIM_HZ } from './constants.ts';
import type { Pose, PoseRig } from './pose.ts';
import { m4InvertAffine, qConjugate, qMul, qNormalize, qRotateVec3, qSlerp, type Num } from './quat.ts';

export interface IKChainWrite {
  target: Vec3 | string;
  weight?: number;
  blendIn?: number;
  blendOut?: number;
}

export interface IKState {
  leftArm?: IKChainWrite | null;
  rightArm?: IKChainWrite | null;
  leftLeg?: IKChainWrite | null;
  rightLeg?: IKChainWrite | null;
  head?: IKChainWrite | null;
  feet?: boolean | { offset?: number };
}

export type IkChainName = 'leftArm' | 'rightArm' | 'leftLeg' | 'rightLeg' | 'head';
export const IK_CHAINS: readonly IkChainName[] = ['leftArm', 'rightArm', 'leftLeg', 'rightLeg', 'head'];

/** the bones of each two-bone chain, canonical names (upper, lower, end); `head` has none */
export const IK_CHAIN_BONES: Readonly<Record<Exclude<IkChainName, 'head'>, readonly [string, string, string]>> = {
  leftArm: ['LeftArm', 'LeftForeArm', 'LeftHand'],
  rightArm: ['RightArm', 'RightForeArm', 'RightHand'],
  leftLeg: ['LeftUpLeg', 'LeftLeg', 'LeftFoot'],
  rightLeg: ['RightUpLeg', 'RightLeg', 'RightFoot'],
};

// ── the two-bone solver ───────────────────────────────────────────────────────────────────────────────────────────────────

const EPS = 1e-9;
// scratch of one solve (never held across calls)
const qA = new Float64Array(4);
const qB = new Float64Array(4);
const qC = new Float64Array(4);
const qU = new Float64Array(4);
const qL = new Float64Array(4);
const qP = new Float64Array(4);
const q1 = new Float64Array(4);
const q2 = new Float64Array(4);
const vA = new Float64Array(3);

/** shortest rotation taking unit vector a to unit vector b */
function fromTo(out: Float64Array, ax: number, ay: number, az: number, bx: number, by: number, bz: number): Float64Array {
  const d = ax * bx + ay * by + az * bz;
  if (d < -1 + 1e-9) {
    // opposite: half a turn about any axis perpendicular to a
    let px = 0, py = -az, pz = ay;
    if (py * py + pz * pz < 1e-12) {
      px = -az;
      py = 0;
      pz = ax;
    }
    const l = Math.hypot(px, py, pz) || 1;
    out[0] = px / l;
    out[1] = py / l;
    out[2] = pz / l;
    out[3] = 0;
    return out;
  }
  out[0] = ay * bz - az * by;
  out[1] = az * bx - ax * bz;
  out[2] = ax * by - ay * bx;
  out[3] = 1 + d;
  return qNormalize(out, 0, out, 0);
}

/**
 * Two-bone IK in rig model space. Turns `upper` and `lower` so that `end` reaches `targetModel` (3 numbers at `to`), and
 * blends the result into the pose's local rotations by `weight` (0 = the pose is not touched, 1 = solved). `lower` must
 * descend from `upper` and `end` from `lower`. Runs the pose's FK first; the caller runs it again after.
 */
export function solveTwoBone(pose: Pose, rig: PoseRig, upper: number, lower: number, end: number, targetModel: ArrayLike<number>, weight: number, to = 0): void {
  if (!(weight > 0) || upper < 0 || lower < 0 || end < 0) return;
  const tx = targetModel[to]!, ty = targetModel[to + 1]!, tz = targetModel[to + 2]!;
  if (!Number.isFinite(tx) || !Number.isFinite(ty) || !Number.isFinite(tz)) return;
  if (pose.rig !== rig) return;
  pose.updateModel();
  const m = pose.model;
  const ax = m[upper * 16 + 12]!, ay = m[upper * 16 + 13]!, az = m[upper * 16 + 14]!;
  const bx = m[lower * 16 + 12]!, by = m[lower * 16 + 13]!, bz = m[lower * 16 + 14]!;
  const cx = m[end * 16 + 12]!, cy = m[end * 16 + 13]!, cz = m[end * 16 + 14]!;
  // the two segments
  const ex = bx - ax, ey = by - ay, ez = bz - az;
  const fx = cx - bx, fy = cy - by, fz = cz - bz;
  const a = Math.hypot(ex, ey, ez);
  const b = Math.hypot(fx, fy, fz);
  if (!(a > EPS) || !(b > EPS)) return;

  // direction and clamped distance to the target
  let dx = tx - ax, dy = ty - ay, dz = tz - az;
  let dist = Math.hypot(dx, dy, dz);
  if (dist < EPS) {
    // the target is the shoulder itself: keep the direction the chain has (the end's, else the elbow's)
    dx = cx - ax;
    dy = cy - ay;
    dz = cz - az;
    let l = Math.hypot(dx, dy, dz);
    if (l < EPS) {
      dx = ex;
      dy = ey;
      dz = ez;
      l = a;
    }
    dx /= l;
    dy /= l;
    dz /= l;
    dist = 0;
  } else {
    dx /= dist;
    dy /= dist;
    dz /= dist;
  }
  const lo = Math.abs(a - b) + IK_DEFAULTS.reachClamp;
  const hi = a + b - IK_DEFAULTS.reachClamp;
  const d = lo <= hi ? Math.min(Math.max(dist, lo), hi) : (a + b + Math.abs(a - b)) / 2;

  // the pole: the animated elbow's side of the shoulder → target line
  let k = ex * dx + ey * dy + ez * dz;
  let px = ex - dx * k, py = ey - dy * k, pz = ez - dz * k;
  let pl = Math.hypot(px, py, pz);
  if (pl < 1e-6 * a) {
    // the elbow lies on that line: bend on the side the chain is bent to now (the elbow's offset from the shoulder → end line)
    const gx = cx - ax, gy = cy - ay, gz = cz - az;
    const gl2 = gx * gx + gy * gy + gz * gz;
    const u = gl2 > EPS ? (ex * gx + ey * gy + ez * gz) / gl2 : 0;
    const ox = ex - gx * u, oy = ey - gy * u, oz = ez - gz * u;
    k = ox * dx + oy * dy + oz * dz;
    px = ox - dx * k;
    py = oy - dy * k;
    pz = oz - dz * k;
    pl = Math.hypot(px, py, pz);
  }
  if (pl < 1e-6 * a) {
    // a straight chain aimed along the target line: any stable perpendicular (the upper bone's own axes, in a fixed order)
    for (let c = 0; c < 3 && pl < 1e-6; c++) {
      const ux = m[upper * 16 + c * 4]!, uy = m[upper * 16 + c * 4 + 1]!, uz = m[upper * 16 + c * 4 + 2]!;
      k = ux * dx + uy * dy + uz * dz;
      px = ux - dx * k;
      py = uy - dy * k;
      pz = uz - dz * k;
      pl = Math.hypot(px, py, pz);
    }
    if (pl < 1e-9) return;
  }
  px /= pl;
  py /= pl;
  pz /= pl;

  // the solved elbow: the triangle (a, b, d) in the plane of the target line and the pole
  const x = (a * a + d * d - b * b) / (2 * d);
  const y = Math.sqrt(Math.max(0, a * a - x * x));
  const nex = dx * x + px * y, ney = dy * x + py * y, nez = dz * x + pz * y; // new elbow − shoulder
  // q1 turns the upper segment onto the new elbow
  fromTo(q1, ex / a, ey / a, ez / a, nex / a, ney / a, nez / a);
  // the lower segment after q1, and q2 that turns it onto the (clamped) target
  vA[0] = fx;
  vA[1] = fy;
  vA[2] = fz;
  qRotateVec3(vA, 0, q1, 0, vA, 0);
  const hx = dx * d - nex, hy = dy * d - ney, hz = dz * d - nez; // target − new elbow, length b
  const hl = Math.hypot(hx, hy, hz) || 1;
  fromTo(q2, vA[0]! / b, vA[1]! / b, vA[2]! / b, hx / hl, hy / hl, hz / hl);

  // model rotations now, and the frames the two local rotations are relative to
  const r = pose.r;
  m4Rotation(qU, 0, m, upper * 16);
  m4Rotation(qL, 0, m, lower * 16);
  qConjugate(qA, 0, r, upper * 4);
  qMul(qP, 0, qU, 0, qA, 0); // parent frame of `upper`
  qConjugate(qA, 0, r, lower * 4);
  qMul(qB, 0, qL, 0, qA, 0); // parent frame of `lower` (before the solve)

  // upper: local' = P⁻¹ · q1 · U
  qMul(qA, 0, q1, 0, qU, 0);
  qConjugate(qC, 0, qP, 0);
  qMul(qA, 0, qC, 0, qA, 0);
  qNormalize(qA, 0, qA, 0);
  // lower: its parent frame turned by q1; local' = (q1 · PL)⁻¹ · q2 · q1 · L
  qMul(qC, 0, q1, 0, qB, 0);
  qConjugate(qC, 0, qC, 0);
  qMul(qB, 0, q1, 0, qL, 0);
  qMul(qB, 0, q2, 0, qB, 0);
  qMul(qB, 0, qC, 0, qB, 0);
  qNormalize(qB, 0, qB, 0);

  const w = weight >= 1 ? 1 : weight;
  if (w < 1) {
    qSlerp(qA, 0, r, upper * 4, qA, 0, w);
    qSlerp(qB, 0, r, lower * 4, qB, 0, w);
  }
  pose.setRotation(upper, qA[0]!, qA[1]!, qA[2]!, qA[3]!);
  pose.setRotation(lower, qB[0]!, qB[1]!, qB[2]!, qB[3]!);
}

// ── chains of a rig ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface IkRigBones {
  /** per chain of `IK_CHAINS` (head excluded): upper, lower, end bone indices; −1 when the rig lacks one */
  readonly chains: Int16Array;
  readonly hips: number;
}

const RIG_BONES = new WeakMap<PoseRig, IkRigBones>();

export function ikBonesOf(rig: PoseRig): IkRigBones {
  let b = RIG_BONES.get(rig);
  if (b === undefined) {
    const chains = new Int16Array(12).fill(-1);
    IK_CHAINS.forEach((name, i) => {
      if (name === 'head') return;
      const [u, l, e] = IK_CHAIN_BONES[name];
      const iu = rig.index(u), il = rig.index(l), ie = rig.index(e);
      if (iu >= 0 && il >= 0 && ie >= 0) chains.set([iu, il, ie], i * 3);
    });
    b = { chains, hips: rig.index('Hips') };
    RIG_BONES.set(rig, b);
  }
  return b;
}

// ── channel state ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const KIND_NONE = 0;
const KIND_POINT = 1;
const KIND_ROW = 2;

class Chain {
  kind = KIND_NONE;
  /** body-local point (KIND_POINT) */
  readonly local = new Float64Array(3);
  /** target row id (KIND_ROW) */
  id = '';
  /** the written weight */
  weight = 1;
  blendOut: number = IK_DEFAULTS.blendOut;
  /** null was written: the chain goes away when its ramp ends */
  clearing = false;
  /** effective weight at the last tick */
  w = 0;
  rampFrom = 0;
  rampTo = 0;
  rampT = 0;
  rampDur = 0;
}

/** what the presentation pass hands the solver for one row and frame */
export interface IkFrame {
  /** rig model space → world (the root's world matrix × the model normalisation), 16 numbers column-major */
  modelToWorld: ArrayLike<number>;
  /** the row's interpolated world transform as drawn this frame (16 numbers; only position and rotation are read) */
  bodyWorld: ArrayLike<number>;
  /** interpolation fraction past the last tick (ramps) */
  alpha: number;
  /** world feet of a row (string targets); absent = such chains do nothing */
  rowFeet?: ((rowId: string) => Vec3 | null) | undefined;
  /** static world: the ground height under (x, z) at or below y, within `maxDist`; null = nothing. Feet IK only. */
  castDown?: ((x: number, y: number, z: number, maxDist: number) => number | null) | undefined;
}

interface RowIk {
  readonly row: RowRec;
  /** one per IK_CHAINS entry */
  readonly chains: Chain[];
  feet: boolean;
  feetOffset: number;
  // what `solve` changed on the presented pose, to be put back before the next evaluation
  savedPose: Pose | null;
  savedN: number;
  readonly savedBone: Int16Array;
  readonly savedR: Float32Array;
  savedHips: number;
  readonly savedT: Float32Array;
}

export interface IkChannelsOptions {
  /** the rows (target rows, parent chains of the default transform) */
  rows: RowLookup;
  /** the row's simulated world transform at the moment of a write; default: its plain parent chain */
  worldOf?: (row: RowRec, out: SimWorld) => SimWorld;
  /** whether the rows of a place tick at step H; default: every place */
  isSimulated?: (place: string | null) => boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const RAMP_EPS = 1e-9;

/** feet IK: the ray starts this far above the row's feet plane and may find ground this far below it */
const FEET_RAY_UP = 0.5;
const FEET_RAISE_MAX = 0.25;

export class IkChannels {
  /** the `ik` property channel: every assignment, inside the writer's stack (X-13); reads are the store's own snapshots */
  readonly channel: PropChannel;
  readonly #rows: RowLookup;
  readonly #worldOf: (row: RowRec, out: SimWorld) => SimWorld;
  readonly #isSimulated: ((place: string | null) => boolean) | undefined;
  readonly #state = new Map<string, RowIk>();
  #dt = 1 / SIM_HZ;
  // scratch
  readonly #world = newSimWorld();
  readonly #inv = new Float64Array(16);
  readonly #v = new Float64Array(3);
  readonly #t = new Float64Array(3);
  readonly #q = new Float64Array(4);
  readonly #foot = new Float64Array(6);
  readonly #off = new Float64Array(2);

  constructor(opts: IkChannelsOptions) {
    this.#rows = opts.rows;
    this.#worldOf = opts.worldOf ?? ((row, out) => simWorldOf(this.#rows, row, out));
    this.#isSimulated = opts.isSimulated;
    this.channel = {
      field: 'ik',
      everyWrite: true,
      sync: true,
      onWrite: (row, value, prev, path) => this.#onWrite(row, value, prev, path),
    };
  }

  register(channels: PropChannelRegistry): () => void {
    return channels.register(this.channel);
  }

  /** The channel on a kernel's store, and the row notices (a spawn-time `ik` spec, disposal). Returns an uninstall. */
  install(kernel: Pick<Kernel, 'store' | 'on'>): () => void {
    const offChannel = this.register(kernel.store.channels);
    const offSpawn = kernel.on('rowSpawned', (row) => this.rowSpawned(row));
    const offDestroy = kernel.on('rowDestroyed', (row) => this.rowDestroyed(row));
    return () => {
      offChannel();
      offSpawn();
      offDestroy();
    };
  }

  rowSpawned(row: RowRec): void {
    const bag = row.props['ik'];
    if (row.phase === 'alive' && isObj(bag)) this.#writeBag(row, bag, null);
  }

  rowDestroyed(row: RowRec): void {
    const st = this.#state.get(row.id);
    if (st !== undefined && st.row === row) this.#state.delete(row.id);
  }

  /** rows with IK state */
  get size(): number {
    return this.#state.size;
  }

  /** whether a row has a chain or feet IK that `solve` would act on */
  active(rowId: string): boolean {
    return this.#state.has(rowId);
  }

  /** a chain's effective weight `alpha` of a tick past the last tick; 0 when it is not active */
  weight(rowId: string, chain: IkChainName, alpha = 0): number {
    const st = this.#state.get(rowId);
    if (st === undefined) return 0;
    const c = st.chains[IK_CHAINS.indexOf(chain)]!;
    return c.kind === KIND_NONE ? 0 : this.#weightAt(c, alpha);
  }

  /** a point chain's target in the owner's body-local frame (a copy), null otherwise */
  localTarget(rowId: string, chain: IkChainName): [number, number, number] | null {
    const c = this.#state.get(rowId)?.chains[IK_CHAINS.indexOf(chain)];
    return c !== undefined && c.kind === KIND_POINT ? [c.local[0]!, c.local[1]!, c.local[2]!] : null;
  }

  /** Tick step H: the ramps of every row of a simulated place; a cleared chain whose ramp ended goes away. */
  advanceTick(dtS: number): void {
    this.#dt = dtS;
    const sim = this.#isSimulated;
    for (const [id, st] of this.#state) {
      if (sim !== undefined && !sim(st.row.place)) continue;
      let live = st.feet;
      for (const c of st.chains) {
        if (c.kind === KIND_NONE) continue;
        if (c.rampT < c.rampDur) {
          c.rampT += dtS;
          c.w = c.rampT >= c.rampDur - RAMP_EPS ? c.rampTo : c.rampFrom + ((c.rampTo - c.rampFrom) * c.rampT) / c.rampDur;
          if (c.rampT >= c.rampDur - RAMP_EPS) c.rampT = c.rampDur;
        }
        if (c.clearing && c.rampT >= c.rampDur) c.kind = KIND_NONE;
        else live = true;
      }
      if (!live && st.savedN === 0 && st.savedHips < 0) this.#state.delete(id);
    }
  }

  /**
   * Before the mixer evaluates the presented pose: puts back the rotations (and the Hips translation) the last `solve` of this
   * row replaced, so the solve starts from the animated pose again.
   */
  restore(rowId: string, pose: Pose): void {
    const st = this.#state.get(rowId);
    if (st === undefined || st.savedPose !== pose) return;
    const r = st.savedR;
    for (let i = 0; i < st.savedN; i++) pose.setRotation(st.savedBone[i]!, r[i * 4]!, r[i * 4 + 1]!, r[i * 4 + 2]!, r[i * 4 + 3]!);
    if (st.savedHips >= 0) pose.setTranslation(st.savedHips, st.savedT[0]!, st.savedT[1]!, st.savedT[2]!);
    st.savedN = 0;
    st.savedHips = -1;
    st.savedPose = null;
  }

  /**
   * After the mixer: solves the row's chains on the presented pose. Returns whether anything was solved. The caller runs
   * `pose.updateModel()` afterwards.
   */
  solve(rowId: string, pose: Pose, frame: IkFrame): boolean {
    const st = this.#state.get(rowId);
    if (st === undefined) return false;
    const rig = pose.rig;
    const bones = ikBonesOf(rig);
    let solved = false;
    let inverse = false;
    const inv = this.#inv;
    const v = this.#v;
    const t = this.#t;
    for (let i = 0; i < st.chains.length; i++) {
      const c = st.chains[i]!;
      if (c.kind === KIND_NONE || IK_CHAINS[i] === 'head') continue;
      const up = bones.chains[i * 3]!;
      if (up < 0) continue;
      const w = this.#weightAt(c, frame.alpha);
      if (!(w > 0)) continue;
      // the target in the world as drawn this frame
      if (c.kind === KIND_POINT) {
        const bw = frame.bodyWorld;
        m4Rotation(this.#q, 0, bw as Num, 0);
        qRotateVec3(v, 0, this.#q, 0, c.local, 0);
        v[0] = v[0]! + bw[12]!;
        v[1] = v[1]! + bw[13]!;
        v[2] = v[2]! + bw[14]!;
      } else {
        const p = frame.rowFeet?.(c.id) ?? null;
        if (p === null) continue;
        v[0] = p.x;
        v[1] = p.y;
        v[2] = p.z;
      }
      if (!inverse) {
        m4InvertAffine(inv, 0, frame.modelToWorld as Num, 0);
        inverse = true;
      }
      t[0] = inv[0]! * v[0]! + inv[4]! * v[1]! + inv[8]! * v[2]! + inv[12]!;
      t[1] = inv[1]! * v[0]! + inv[5]! * v[1]! + inv[9]! * v[2]! + inv[13]!;
      t[2] = inv[2]! * v[0]! + inv[6]! * v[1]! + inv[10]! * v[2]! + inv[14]!;
      const lo = bones.chains[i * 3 + 1]!;
      this.#save(st, pose, up);
      this.#save(st, pose, lo);
      solveTwoBone(pose, rig, up, lo, bones.chains[i * 3 + 2]!, t, w);
      solved = true;
    }
    if (st.feet && frame.castDown !== undefined && this.#solveFeet(st, pose, bones, frame)) solved = true;
    return solved;
  }

  // ── internals ──────────────────────────────────────────────────────────────────────────────────────────────────────────

  #weightAt(c: Chain, alpha: number): number {
    if (c.rampT >= c.rampDur) return c.w;
    const rt = c.rampT + (alpha > 0 ? (alpha < 1 ? alpha : 1) : 0) * this.#dt;
    return rt >= c.rampDur - RAMP_EPS ? c.rampTo : c.rampFrom + ((c.rampTo - c.rampFrom) * rt) / c.rampDur;
  }

  #save(st: RowIk, pose: Pose, bone: number): void {
    if (st.savedPose !== pose) {
      st.savedPose = pose;
      st.savedN = 0;
      st.savedHips = -1;
    }
    for (let i = 0; i < st.savedN; i++) if (st.savedBone[i] === bone) return;
    const n = st.savedN++;
    st.savedBone[n] = bone;
    st.savedR.set(pose.r.subarray(bone * 4, bone * 4 + 4), n * 4);
  }

  #entry(row: RowRec): RowIk {
    let st = this.#state.get(row.id);
    if (st === undefined || st.row !== row) {
      st = {
        row,
        chains: IK_CHAINS.map(() => new Chain()),
        feet: false,
        feetOffset: 0,
        savedPose: null,
        savedN: 0,
        savedBone: new Int16Array(8),
        savedR: new Float32Array(32),
        savedHips: -1,
        savedT: new Float32Array(3),
      };
      this.#state.set(row.id, st);
    }
    return st;
  }

  #onWrite(row: RowRec, value: unknown, prev: unknown, path: readonly PathSegment[]): void {
    if (row.phase !== 'alive') return;
    if (path.length === 0) {
      this.#writeBag(row, isObj(value) ? value : {}, isObj(prev) ? prev : null);
      return;
    }
    const key = String(path[0]);
    // a write below a chain (`ik.rightArm.weight = …` through a kept reference) states the chain as the row stores it now
    const stored = path.length === 1 ? value : isObj(row.props['ik']) ? (row.props['ik'] as Record<string, unknown>)[key] : undefined;
    this.#writeKey(row, key, stored);
  }

  /**
   * A whole bag (`ik = { ...ik, feet: true }`): chains it leaves out are cleared; a chain it repeats unchanged is not a new
   * statement (its world point was converted when it was written, and the body has moved since).
   */
  #writeBag(row: RowRec, bag: Record<string, unknown>, prev: Record<string, unknown> | null): void {
    for (const name of IK_CHAINS) {
      const v = bag[name];
      if (v === undefined || v === null) this.#writeKey(row, name, null);
      else if (prev === null || JSON.stringify(prev[name]) !== JSON.stringify(v)) this.#writeKey(row, name, v);
    }
    this.#writeKey(row, 'feet', bag['feet']);
  }

  #writeKey(row: RowRec, key: string, v: unknown): void {
    if (key === 'feet') {
      const on = v === true || isObj(v);
      if (!on && !this.#state.has(row.id)) return;
      const st = this.#entry(row);
      st.feet = on;
      st.feetOffset = isObj(v) && finite(v['offset']) ? v['offset'] : 0;
      return;
    }
    const i = IK_CHAINS.indexOf(key as IkChainName);
    if (i < 0) return;
    if (v === null || v === undefined) {
      const c = this.#state.get(row.id)?.chains[i];
      if (c === undefined || c.kind === KIND_NONE || c.clearing) return;
      c.clearing = true;
      this.#ramp(c, 0, c.blendOut);
      if (c.rampT >= c.rampDur) c.kind = KIND_NONE;
      return;
    }
    if (!isObj(v)) return;
    const target = v['target'];
    let kind = KIND_NONE;
    if (typeof target === 'string' && target !== '') kind = KIND_ROW;
    else if (isObj(target) && finite(target['x']) && finite(target['y']) && finite(target['z'])) kind = KIND_POINT;
    if (kind === KIND_NONE) return;
    const c = this.#entry(row).chains[i]!;
    const was = c.kind !== KIND_NONE;
    if (kind === KIND_ROW) c.id = target as string;
    else {
      // world point → body-local, with the transform the row has now
      const p = target as { x: number; y: number; z: number };
      const w = this.#worldOf(row, this.#world);
      const l = c.local;
      l[0] = p.x - w.pos[0]!;
      l[1] = p.y - w.pos[1]!;
      l[2] = p.z - w.pos[2]!;
      qConjugate(this.#q, 0, w.rot, 0);
      qRotateVec3(l, 0, this.#q, 0, l, 0);
    }
    const weight = finite(v['weight']) ? Math.min(1, Math.max(0, v['weight'])) : 1;
    const blendIn = finite(v['blendIn']) && v['blendIn'] > 0 ? v['blendIn'] : 0;
    c.blendOut = finite(v['blendOut']) && v['blendOut'] >= 0 ? v['blendOut'] : IK_DEFAULTS.blendOut;
    if (!was) {
      c.w = 0;
      c.rampT = c.rampDur = 0;
    }
    const sameRamp = was && !c.clearing && c.weight === weight && c.rampTo === weight;
    c.kind = kind;
    c.weight = weight;
    c.clearing = false;
    if (!sameRamp) this.#ramp(c, weight, blendIn);
  }

  /** from the chain's current effective weight to `to` over `dur` seconds */
  #ramp(c: Chain, to: number, dur: number): void {
    const from = this.#weightAt(c, 0);
    c.rampFrom = from;
    c.rampTo = to;
    c.rampT = 0;
    if (dur > 0 && from !== to) {
      c.rampDur = dur;
      c.w = from;
    } else {
      c.rampDur = 0;
      c.w = to;
    }
  }

  /**
   * Feet IK: per foot the ground under it (a static down-ray from above the row's feet plane), the pelvis lowered by what the
   * lower foot needs (at most `pelvisDropMax`), each leg solved onto its ground height.
   */
  #solveFeet(st: RowIk, pose: Pose, bones: IkRigBones, frame: IkFrame): boolean {
    const li = IK_CHAINS.indexOf('leftLeg') * 3;
    const ri = IK_CHAINS.indexOf('rightLeg') * 3;
    if (bones.chains[li]! < 0 || bones.chains[ri]! < 0 || bones.hips < 0) return false;
    const m2w = frame.modelToWorld;
    const bodyY = frame.bodyWorld[13]!;
    const drop = IK_DEFAULTS.pelvisDropMax;
    pose.updateModel();
    const foot = this.#foot;
    const off = this.#off;
    let any = false;
    for (let f = 0; f < 2; f++) {
      const e = bones.chains[(f === 0 ? li : ri) + 2]!;
      const mx = pose.model[e * 16 + 12]!, my = pose.model[e * 16 + 13]!, mz = pose.model[e * 16 + 14]!;
      const wx = m2w[0]! * mx + m2w[4]! * my + m2w[8]! * mz + m2w[12]!;
      const wy = m2w[1]! * mx + m2w[5]! * my + m2w[9]! * mz + m2w[13]!;
      const wz = m2w[2]! * mx + m2w[6]! * my + m2w[10]! * mz + m2w[14]!;
      foot[f * 3] = wx;
      foot[f * 3 + 1] = wy;
      foot[f * 3 + 2] = wz;
      const g = frame.castDown!(wx, bodyY + FEET_RAY_UP, wz, FEET_RAY_UP + drop + FEET_RAISE_MAX);
      off[f] = g === null || !Number.isFinite(g) ? 0 : Math.min(FEET_RAISE_MAX, Math.max(-drop, g - bodyY)) + st.feetOffset;
      if (off[f] !== 0) any = true;
    }
    if (!any) return false;
    const pelvis = Math.max(-drop, Math.min(0, off[0]!, off[1]!));
    const inv = m4InvertAffine(this.#inv, 0, m2w as Num, 0);
    if (pelvis < 0) {
      // the world drop as a model-space vector, then in the frame the Hips translation is relative to
      const h = bones.hips;
      const v = this.#v;
      v[0] = inv[4]! * pelvis;
      v[1] = inv[5]! * pelvis;
      v[2] = inv[6]! * pelvis;
      m4Rotation(qU, 0, pose.model, h * 16);
      qConjugate(qA, 0, pose.r, h * 4);
      qMul(qP, 0, qU, 0, qA, 0);
      qConjugate(qP, 0, qP, 0);
      qRotateVec3(v, 0, qP, 0, v, 0);
      if (st.savedPose !== pose) {
        st.savedPose = pose;
        st.savedN = 0;
        st.savedHips = -1;
      }
      if (st.savedHips < 0) {
        st.savedHips = h;
        st.savedT.set(pose.t.subarray(h * 3, h * 3 + 3));
      }
      pose.setTranslation(h, pose.t[h * 3]! + v[0]!, pose.t[h * 3 + 1]! + v[1]!, pose.t[h * 3 + 2]! + v[2]!);
    }
    const t = this.#t;
    for (let f = 0; f < 2; f++) {
      const base = f === 0 ? li : ri;
      // where the animated foot belongs: its own place, raised or lowered to its ground
      const wx = foot[f * 3]!, wy = foot[f * 3 + 1]! + off[f]!, wz = foot[f * 3 + 2]!;
      t[0] = inv[0]! * wx + inv[4]! * wy + inv[8]! * wz + inv[12]!;
      t[1] = inv[1]! * wx + inv[5]! * wy + inv[9]! * wz + inv[13]!;
      t[2] = inv[2]! * wx + inv[6]! * wy + inv[10]! * wz + inv[14]!;
      this.#save(st, pose, bones.chains[base]!);
      this.#save(st, pose, bones.chains[base + 1]!);
      solveTwoBone(pose, pose.rig, bones.chains[base]!, bones.chains[base + 1]!, bones.chains[base + 2]!, t, 1);
    }
    return true;
  }
}

export function createIkChannels(opts: IkChannelsOptions): IkChannels {
  return new IkChannels(opts);
}
