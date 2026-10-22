// The controller call of kcc.ts, and an exact memo of it for a character that makes the same call tick after tick (kcc.ts
// header, 8). A body that is stuck (on a slope it may not climb with gravity alone asked, standing inside a two-sided trimesh
// wall after a spawn) asks Rapier for the same move every tick, and Rapier answers with the same 20 spun-out iterations: 1-3 ms
// per call on the grimland-park bench. When EVERY input of such a call is provably the input of the call it answered before,
// that answer is reused instead of asked again.
//
// What the Rapier 0.21 call reads (rapier js-v0.21.0 = Rust rapier 0.36.0 with parry3d 0.31.1; the wasm names its sources):
//   bindings/typescript/src/control/character_controller.rs `computeColliderMovement`: the character collider's
//     `position()`, `shared_shape()` and `parent()` (the excluded body); dt (`IntegrationParameters.dt`: 0 during world.ts's
//     controller pass); the desired translation (a RawVector: f32); filter flags, packed groups (memberships << 16 | filter,
//     test mode AND), the predicate; apply-impulses and the character mass (no impulses here, the mass is then unused).
//     Queries go through `broad_phase.as_query_pipeline_mut(narrow_phase.query_dispatcher(), ...)`: of the narrow phase only
//     its stateless dispatcher. Kept for the read-back: the last `result` and `events`, nothing else.
//   src/control/character_controller.rs `move_shape` (`&self`: no state between calls): settings up, offset, slide,
//     autostep (max height, min width, dynamic bodies), max climb, min slide, snap distance, normal nudge; at most 20 casts
//     (`max_iters`) from the pose reached along the remaining translation (target distance = offset, max = the remaining
//     length); per wall hit `handle_stairs` (casts up by the max height and forward by the min width: only whether they hit;
//     down from there by the max height, twice: the hit's normal, and its time of impact); `handle_slopes` (pure math); at the
//     start and after every iteration `detect_grounded_status_and_apply_friction` (`intersect_aabb_conservative` over the
//     character AABB loosened by offset + 0.05; contact manifolds; for a KINEMATIC parent `velocity_at_point` × dt laid on the
//     remaining translation, contact by contact); `snap_to_ground` (one cast down by the snap distance: its time of impact);
//     `check_and_fix_penetrations` only for a desired translation of at most 1e-5 (never memoised).
//   src/pipeline/query_pipeline.rs: a candidate is a BVH leaf with its STORED AABB (as of the last broad-phase update);
//     the filter reads the excluded collider and body, groups, flags (sensor, parent body type), predicate, and NOT
//     `is_enabled` (a disabled collider stays a candidate until the next step drops its leaf); then `co.position()`, `co.shape()`.
//   parry3d partitioning/bvh: `intersect_aabb` is `leaves`, depth first, left child first (the tree's left-to-right order).
//     `cast_shape` is `find_best`: at every node the two children sorted by score (a ray against the child AABB inflated by
//     the query AABB and the target distance: 0 once they touch), ties kept left first; a LEAF child is evaluated at once, a
//     subtree descended (the left one) or stacked (the right one); a leaf takes the best only when strictly better; the leaf's
//     own cast ignores the best so far (query/shape_cast/shape_cast_composite_shape_shape.rs). So a cast's visiting order is
//     not the left-to-right order: a leaf near the root comes before a deeper one on its left.
//   So the answer also depends on the ORDER in which leaves are visited: an exact tie in a cast keeps the first one visited,
//   and the kinematic-friction sum runs in visit order. The broad phase is refitted and partly rebuilt every step (the
//   subtree optimiser), by anybody's move: node boxes, and so cast scores, change while nothing near the body moved.
//
// The proof `matches` makes, every value compared with Object.is:
//   1 the same controller, its settings read back, dt, impulses and mass, flags, groups; the desired translation as the f32
//     the wasm receives; the character collider's handle, pose, capsule and parent;
//   2 R, a box that holds every query of the recorded call (`region`: from its reported hits, the stair probes and the
//     snap, with margins). Of the broad-phase leaves that reach R, the RELEVANT ones are those the call's filter lets
//     through (the filter rebuilt here, the predicate asked as Rapier asks it) less any primitive whose own bounds lie
//     outside R (no query of the call can touch it). They must be the same leaves in the same left-to-right order (that of
//     the box query over R) and in the same cast order (`probe`: a cast of a cuboid covering R that notes the leaves it
//     evaluates and takes none, so every leaf reaching R and every node above one scores 0 and the order noted is that of
//     the tree's shape), with the same handle, pose, shape (primitive parameters, otherwise the JS `Shape` object that only
//     `setShape` replaces), contact skin, sensor, groups, enabled, parent, body type and, for a kinematic parent, its
//     velocities and centre of mass;
//   3 every relevant leaf is BIG (its stored AABB holds R: corner point queries) or a parentless collider. A big one is
//     visited by every query and scores 0 at every level of every cast. A parentless one is never moved in place by the
//     port (they are enabled, disabled, regrouped, removed, added), and Rapier stores for it the shape AABB at its pose
//     loosened by contact skin + half the prediction distance, fattened by `change_detection_skin` (length_unit and the
//     box's extents only, rapier geometry/broad_phase_bvh): the same leaf box in both calls, so the same visits. A parented
//     leaf that is not big is a doubt (its stored box lags its pose and depends on its history);
//   4 the order (`tieFree`, once per record): the ground queries (`leaves`) visit in the left-to-right order (compared in 2).
//     A cast only depends on its order through an exact tie at its best time of impact, and only where the winner's identity
//     is used: a main-loop cast (the reported hit) and the stair ramp probe (its normal: subtract_hit and the slope test read
//     nothing else); presence or time of impact alone (the stair clearances, the step height, the snap) do not care. Two
//     leaves that both touch a cast's start box (grown by the target distance) have every ancestor at score 0, so that cast
//     visits them as the probe does: the order of the tree's shape at their lowest common ancestor (compared in 2). A best
//     time of impact of 0 is such a tie: what is touched at 0 touches the start box. For every other such cast of the
//     recorded call the relevant leaves whose stored box reaches the cast's sweep all reach its start box (then all are
//     visited in the probe's order) or are at most one. A ramp probe that fails this is made
//     again (`stairsSafe`: handle_stairs's casts replayed bit for bit through the same query pipeline): it is order-free
//     when a clearance cast before it hits (handle_stairs returns there; checked against the call: no step followed), or
//     when at most one collider, or only colliders with one normal, reach its best time of impact, collider by collider.
//     With the same relevant leaves (2) whose boxes did not change (3) all of this holds again.
//   Given the same inputs the call takes the same path, so its queries are the recorded ones and stay in R (by induction
//   over its casts). A doubt is a miss: a non-capsule character, `up` not +Y, an impulse-applying controller, a desired
//   translation of 2e-5 or less, a body type this file does not know, a shape it cannot identify, a non-finite number.
// Calls are recorded only when they spun out (KCC_MAX_ITERATIONS hits: the dear ones) and their inputs came back (a first
// one leaves only a fingerprint: desired, pose); the order proof (4) is worked out at a record's first match. One slot per
// character and per call of its `moveCharacter` (the n-th call of a tick is compared with the n-th one of the tick before),
// holding the last MEMO_RECORDS recorded calls. `kccMemo.verify` makes the real call on every hit as well and compares
// every output field (the bench's verify mode, the tests).
// The proof leans on one invariant of the port: a parentless collider is never moved or reshaped in place (no code in src/
// calls `Collider.setTranslation`, `setRotation`, `setShape` or the shape setters on one); moving one and moving it back
// across a step would leave a stored box the poses compared in 2 do not show.
import type { CharacterCollision, Collider, KinematicCharacterController } from '@dimforge/rapier3d-simd-compat';
import { perfNow } from '../../core/perf-now.ts';
import { KCC_MAX_ITERATIONS, groupsInteract } from '../defaults.ts';
import type { CharacterBody, Vec3 } from './kcc.ts';
import type { Rapier } from './loader.ts';

/** a controller call's filter predicate, on the collider handle the wasm hands over and on the `Collider` the public API makes of it */
export interface MoveFilter { readonly byHandle: (handle: number) => boolean; readonly byCollider: (other: Collider) => boolean }

/** what one controller call answered: the controller's own read-back, or the memo's copy of it */
export interface MoveView {
  /** `computedMovement(out)` */
  movement(out: Vec3): void;
  /** `computedGrounded()` */
  grounded(): boolean;
  /** `numComputedCollisions()` */
  count(): number;
  /** `computedCollision(i, out)`: null past the last one */
  collision(i: number, out: CharacterCollision): CharacterCollision | null;
}

export interface KccMemoStats {
  /** calls that had recorded calls to compare with */
  checks: number;
  /** of those, every input the same (in verify mode answered by the real call all the same) */
  hits: number;
  /** spun-out calls recorded */
  records: number;
  /** spun-out calls not recordable (a doubt, header), and why */
  refused: number;
  refusals: Record<string, number>;
  /** checks that failed, by the first input found different from the latest record */
  misses: Record<string, number>;
  /** verify mode: hits answered by the real call too, and how many of those differed in any output field */
  verified: number;
  mismatches: number;
  firstMismatch: string | null;
  /** `kccMemo.timing`: milliseconds in the checks, in recording (or refusing), and (verify mode) in the real calls of hits */
  checkMs: number;
  recordMs: number;
  hitCallMs: number;
}

const emptyStats = (): KccMemoStats => ({
  checks: 0, hits: 0, records: 0, refused: 0, refusals: {}, misses: {}, verified: 0, mismatches: 0, firstMismatch: null, checkMs: 0, recordMs: 0, hitCallMs: 0,
});

/** on by default; `verify` makes the real call on every hit too and compares (diagnostics, tests); `timing` fills the *Ms counters */
export const kccMemo = {
  enabled: true,
  verify: false,
  timing: false,
  stats: emptyStats(),
  resetStats(): void { kccMemo.stats = emptyStats(); },
};

/** recorded calls kept per slot (a body that alternates between two stuck asks, tick by tick) */
const MEMO_RECORDS = 3;

/** why the last `record` gave no proof */
let doubt = '';
function refuse(why: string): null {
  doubt = why;
  return null;
}

/**
 * The Rapier 0.21 controller's own members that `computeColliderMovement` passes to the wasm (TypeScript-private there, plain
 * properties at run time), and the raw sets the memo reads. The public method wraps EVERY call's filter in a JS closure
 * (`ColliderSet.castClosure`, even with no predicate given), and the wasm calls it once per candidate collider of every cast
 * of the loop, only to be told "keep" when there is no predicate. Given no closure, the wasm keeps every candidate itself: the
 * same movement, collisions and grounded flag to the bit (tests/unit/physics/kcc-rawcall.node.test.ts; per-tick row hashes of
 * the gridlock-arena and grimland-park benches), 4-6 % less time per character move there.
 */
interface RawVector { free(): void }
interface RawColliders {
  coTranslation(h: number, out: Float32Array): void;
  coRotation(h: number, out: Float32Array): void;
  coParent(h: number): number | undefined;
  coShapeType(h: number): number;
  coRadius(h: number): number | undefined;
  coHalfHeight(h: number): number | undefined;
  coHalfExtents(h: number, out: Float32Array): boolean;
  coRoundRadius(h: number): number | undefined;
  coContactSkin(h: number): number;
  coIsSensor(h: number): boolean;
  coIsEnabled(h: number): boolean;
  coCollisionGroups(h: number): number;
}
interface RawBodies {
  rbBodyType(h: number): number;
  rbLinvel(h: number, out: Float32Array): void;
  rbAngvel(h: number, out: Float32Array): void;
  rbWorldCom(h: number, out: Float32Array): void;
}
interface RawBroadPhase {
  collidersWithAabbIntersectingAabb(narrowPhase: unknown, bodies: unknown, colliders: unknown, center: RawVector, halfExtents: RawVector, cb: (h: number) => boolean): void;
}
interface ControllerInternals {
  readonly raw: {
    computeColliderMovement(dt: number, broadPhase: unknown, narrowPhase: unknown, bodies: unknown, colliders: unknown, collider: number,
      desired: RawVector, applyImpulses: boolean, characterMass: number | null, flags: number | undefined, groups: number | undefined,
      predicate: ((handle: number) => boolean) | undefined): void;
  };
  readonly params: { readonly dt: number };
  readonly broadPhase: { readonly raw: RawBroadPhase };
  readonly narrowPhase: { readonly raw: unknown };
  readonly bodies: { readonly raw: RawBodies };
  readonly colliders: { readonly raw: RawColliders; get(handle: number): Collider | null };
  readonly _applyImpulsesToDynamicBodies: boolean;
  readonly _characterMass: number | null;
}

// ── the views ────────────────────────────────────────────────────────────────────────────────────────────────────────────

class LiveView implements MoveView {
  ctl: KinematicCharacterController | null = null;
  movement(out: Vec3): void { this.ctl!.computedMovement(out); }
  grounded(): boolean { return this.ctl!.computedGrounded(); }
  count(): number { return this.ctl!.numComputedCollisions(); }
  collision(i: number, out: CharacterCollision): CharacterCollision | null { return this.ctl!.computedCollision(i, out); }
}

/** a record's answer, read back the way `KinematicCharacterController.computedCollision` fills its `out` */
class ReplayView implements MoveView {
  rec: MemoRecord | null = null;
  colliders: ControllerInternals['colliders'] | null = null;
  R: Rapier | null = null;
  movement(out: Vec3): void { const m = this.rec!.mv; out.x = m[0]!; out.y = m[1]!; out.z = m[2]!; }
  grounded(): boolean { return this.rec!.grounded; }
  count(): number { return this.rec!.n; }
  collision(i: number, out: CharacterCollision): CharacterCollision | null {
    const rec = this.rec!;
    if (!(i >= 0 && i < rec.n)) return null;
    const c = rec.col, o = i * COL_STRIDE;
    const V = this.R!.VectorOps;
    const set = (v: Vec3 | undefined, k: number): Vec3 => {
      const t = v ?? V.zeros();
      t.x = c[k]!; t.y = c[k + 1]!; t.z = c[k + 2]!;
      return t;
    };
    out.translationDeltaApplied = set(out.translationDeltaApplied, o);
    out.translationDeltaRemaining = set(out.translationDeltaRemaining, o + 3);
    out.toi = c[o + 6]!;
    out.witness1 = set(out.witness1, o + 7);
    out.witness2 = set(out.witness2, o + 10);
    out.normal1 = set(out.normal1, o + 13);
    out.normal2 = set(out.normal2, o + 16);
    out.collider = this.colliders!.get(rec.colHandle[i]!);
    return out;
  }
}

const LIVE = new LiveView();
const REPLAY = new ReplayView();

function live(ctl: KinematicCharacterController): MoveView {
  LIVE.ctl = ctl;
  return LIVE;
}

// ── records ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** a collision as read back: translation applied (3), remaining (3), toi, witness1 (3), witness2 (3), normal1 (3), normal2 (3) */
const COL_STRIDE = 19;
/** a relevant collider: handle, parent (-1), body type (-1), sensor, groups, enabled, shape type, translation (3), rotation (4),
 *  shape parameters (5: half extents / radius, half height; round radius), contact skin, linvel (3), angvel (3), world centre
 *  of mass (3) */
const REL_STRIDE = 29;
/** controller settings read back: offset, nudge, slide, autostep (on, max height, min width, dynamic), max climb, min slide,
 *  snap (on, distance), up (3) */
const CFG_LEN = 14;

interface MemoRecord {
  readonly ctl: KinematicCharacterController;
  readonly cfg: number[];
  readonly dt: number;
  readonly mass: number | null;
  readonly flags: number;
  readonly groups: number;
  readonly handle: number;
  /** character collider: translation (3), rotation (4), radius, half height, parent (-1) */
  readonly pose: number[];
  /** the desired translation as the f32 the wasm got */
  readonly d: readonly [number, number, number];
  /** R, the box that holds every query of the call */
  readonly lo: number[];
  readonly hi: number[];
  readonly rel: number[];
  readonly relShape: unknown[];
  /** the relevant colliders' handles in `find_best`'s visiting order (probe) */
  readonly order: number[];
  readonly mv: number[];
  readonly grounded: boolean;
  readonly n: number;
  readonly col: number[];
  readonly colHandle: number[];
  readonly g: Geometry;
  /** `tieFree` of this record: worked out at its first match (null until then), the doubt when it failed */
  proof: boolean | null;
  why: string;
}

/**
 * Per character, per call of its tick: the recorded calls, the latest first, and the inputs (desired, pose) of the last
 * spun-out calls that were not recorded. A spun-out call is recorded when its inputs come back (a body that is stuck), so a
 * one-off one pays nothing but its fingerprint.
 */
interface Slot { readonly recs: MemoRecord[]; readonly prints: number[][] }
const SLOTS = new WeakMap<CharacterBody, Slot[]>();
/** a fingerprint: desired (3), collider handle, its translation (3), rotation (4), radius, half height */
const PRINT_LEN = 13;
const PRINT: number[] = new Array<number>(PRINT_LEN).fill(0);
let seqOf: CharacterBody | null = null;
let seq = 0;

/** kcc.ts `moveCharacter`: the calls that follow are this body's calls of this tick, numbered from 0 */
export function beginMoves(c: CharacterBody): void {
  seqOf = c;
  seq = 0;
}

/** forget every record of a body */
export function forgetMoves(c: CharacterBody): void {
  SLOTS.delete(c);
}

// ── the call ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * `ctl.computeColliderMovement(collider, d, flags, groups, filter)` with the same arguments the public method hands the wasm,
 * minus its closure when there is no filter, and with the handle predicate as the closure when there is one; or a recorded
 * answer when every input is that record's (header). A controller whose method was replaced on the instance (a test counting
 * calls) goes through that method, every time.
 */
export function controllerMove(R: Rapier, c: CharacterBody, d: Readonly<Vec3>, flags: number, groups: number, filter: MoveFilter | undefined): MoveView {
  const ctl = c.controller;
  if (Object.hasOwn(ctl, 'computeColliderMovement')) {
    ctl.computeColliderMovement(c.collider, d, flags, groups, filter?.byCollider);
    return live(ctl);
  }
  const k = ctl as unknown as ControllerInternals;
  const pred = filter?.byHandle;
  const idx = seqOf === c ? seq++ : -1;
  const memo = kccMemo.enabled && idx >= 0;
  const slot = memo ? SLOTS.get(c)?.[idx] : undefined;
  const dx = Math.fround(d.x), dy = Math.fround(d.y), dz = Math.fround(d.z);
  const timing = kccMemo.timing;
  const st = kccMemo.stats;
  if (slot && slot.recs.length > 0) {
    const t0 = timing ? perfNow() : 0;
    st.checks++;
    let why: string | null = null;
    let rec: MemoRecord | undefined;
    for (const r of slot.recs) {
      const w = matches(r, R, k, c, dx, dy, dz, flags, groups, pred);
      if (w === null) { rec = r; break; }
      // counted by the latest record's reason
      why ??= w;
    }
    if (timing) st.checkMs += perfNow() - t0;
    if (rec) {
      st.hits++;
      if (!kccMemo.verify) {
        REPLAY.rec = rec; REPLAY.colliders = k.colliders; REPLAY.R = R;
        return REPLAY;
      }
      const t1 = timing ? perfNow() : 0;
      rawMove(R, k, c.collider, d, flags, groups, pred);
      if (timing) st.hitCallMs += perfNow() - t1;
      st.verified++;
      const bad = differs(rec, R, ctl);
      if (bad !== null) { st.mismatches++; st.firstMismatch ??= `${c.rowId ?? c.serial} call ${idx}: ${bad}`; }
      return live(ctl);
    }
    if (why !== null) st.misses[why] = (st.misses[why] ?? 0) + 1;
  }
  rawMove(R, k, c.collider, d, flags, groups, pred);
  if (memo && ctl.numComputedCollisions() >= KCC_MAX_ITERATIONS) {
    const t2 = timing ? perfNow() : 0;
    let s = slot;
    if (!s) {
      let slots = SLOTS.get(c);
      if (!slots) SLOTS.set(c, slots = []);
      s = slots[idx] = { recs: [], prints: [] };
    }
    // recorded when the same ask came back (a body that is stuck); a first one leaves its fingerprint
    PRINT[0] = dx; PRINT[1] = dy; PRINT[2] = dz; PRINT[3] = c.collider.handle;
    const co = k.colliders.raw;
    if (readPose(co, c.collider.handle, POSE)) {
      for (let i = 0; i < 9; i++) PRINT[4 + i] = POSE[i]!;
      let again = false;
      for (const p of s.prints) if (same(p, PRINT, PRINT_LEN)) { again = true; break; }
      if (!again) {
        s.prints.unshift(PRINT.slice());
        if (s.prints.length > MEMO_RECORDS) s.prints.length = MEMO_RECORDS;
      } else {
        const r = record(R, k, ctl, c, dx, dy, dz, flags, groups, pred);
        if (r) {
          s.recs.unshift(r);
          if (s.recs.length > MEMO_RECORDS) s.recs.length = MEMO_RECORDS;
          st.records++;
        } else {
          st.refused++;
          st.refusals[doubt] = (st.refusals[doubt] ?? 0) + 1;
        }
      }
    }
    if (timing) st.recordMs += perfNow() - t2;
  }
  return live(ctl);
}

function rawMove(R: Rapier, k: ControllerInternals, collider: Collider, d: Readonly<Vec3>, flags: number, groups: number, pred: ((h: number) => boolean) | undefined): void {
  const rawDelta = R.VectorOps.intoRaw(d) as unknown as RawVector;
  k.raw.computeColliderMovement(k.params.dt, k.broadPhase.raw, k.narrowPhase.raw, k.bodies.raw, k.colliders.raw, collider.handle, rawDelta,
    k._applyImpulsesToDynamicBodies, k._characterMass, flags, groups, pred);
  rawDelta.free();
}

// ── reading inputs ───────────────────────────────────────────────────────────────────────────────────────────────────────

const F4 = new Float32Array(4);
const CFG: number[] = new Array<number>(CFG_LEN).fill(0);
const POSE: number[] = new Array<number>(10).fill(0);
/** RawShapeType */
const BALL = 0, CUBOID = 1, CAPSULE = 2, CYLINDER = 10, CONE = 11, ROUND_CUBOID = 12, ROUND_CYLINDER = 14, ROUND_CONE = 15;

const num = (v: number | null | undefined): number => (v === null || v === undefined ? Number.NaN : v);
const flag = (v: boolean | null | undefined): number => (v === null || v === undefined ? Number.NaN : v ? 1 : 0);

function readConfig(ctl: KinematicCharacterController, out: number[]): void {
  out[0] = ctl.offset(); out[1] = ctl.normalNudgeFactor(); out[2] = flag(ctl.slideEnabled());
  out[3] = flag(ctl.autostepEnabled()); out[4] = num(ctl.autostepMaxHeight()); out[5] = num(ctl.autostepMinWidth());
  out[6] = flag(ctl.autostepIncludesDynamicBodies());
  out[7] = ctl.maxSlopeClimbAngle(); out[8] = ctl.minSlopeSlideAngle();
  out[9] = flag(ctl.snapToGroundEnabled()); out[10] = num(ctl.snapToGroundDistance());
  // `up()` hands out the RawVector itself
  const up = ctl.up() as unknown as { x: number; y: number; z: number; free?: () => void };
  out[11] = up.x; out[12] = up.y; out[13] = up.z;
  up.free?.();
}

/** the character collider: translation, rotation, radius, half height, parent; false when it is not a capsule */
function readPose(co: RawColliders, h: number, out: number[]): boolean {
  if (co.coShapeType(h) !== CAPSULE) return false;
  co.coTranslation(h, F4); out[0] = F4[0]!; out[1] = F4[1]!; out[2] = F4[2]!;
  co.coRotation(h, F4); out[3] = F4[0]!; out[4] = F4[1]!; out[5] = F4[2]!; out[6] = F4[3]!;
  out[7] = num(co.coRadius(h)); out[8] = num(co.coHalfHeight(h));
  out[9] = co.coParent(h) ?? -1;
  return true;
}

function same(a: readonly number[], b: readonly number[], n: number): boolean {
  for (let i = 0; i < n; i++) if (!Object.is(a[i], b[i])) return false;
  return true;
}

function allFinite(a: readonly number[], n: number): boolean {
  for (let i = 0; i < n; i++) if (!Number.isFinite(a[i])) return false;
  return true;
}

/** null when every input is the record's, else the first that is not */
function matches(rec: MemoRecord, R: Rapier, k: ControllerInternals, c: CharacterBody, dx: number, dy: number, dz: number, flags: number, groups: number,
  pred: ((h: number) => boolean) | undefined): string | null {
  if (rec.ctl !== c.controller) return 'controller';
  if (!Object.is(rec.d[0], dx) || !Object.is(rec.d[1], dy) || !Object.is(rec.d[2], dz)) return 'desired';
  if (rec.flags !== flags || rec.groups !== groups || rec.handle !== c.collider.handle) return 'filter';
  if (!Object.is(rec.dt, k.params.dt) || k._applyImpulsesToDynamicBodies || !Object.is(rec.mass, k._characterMass)) return 'call';
  const co = k.colliders.raw;
  if (!readPose(co, rec.handle, POSE) || !same(POSE, rec.pose, 10)) return 'pose';
  if (rec.proof === false) return `unprovable: ${rec.why}`;
  readConfig(c.controller, CFG);
  if (!same(CFG, rec.cfg, CFG_LEN)) return 'settings';
  const s = scan(R, k, rec.handle, rec.pose[9]!, flags, groups, pred, rec.lo, rec.hi);
  if (s === null) return `unprovable: ${doubt}`;
  if (s.rel.length !== rec.rel.length || !same(s.rel, rec.rel, s.rel.length)) return 'colliders';
  for (let i = 0; i < s.shape.length; i++) if (s.shape[i] !== rec.relShape[i]) return 'colliders';
  if (s.order.length !== rec.order.length || !same(s.order, rec.order, s.order.length)) return 'cast order';
  // the order (header, 4), once per record: the relevant colliders are the recorded ones and their stored boxes did not
  // change, so what the order tests find now is what they would have found when the call was made
  if (rec.proof === null) {
    rec.proof = tieFree(R, k, rec.g, rec.pose, rec.cfg, rec, rec.rel, rec.handle, flags, groups, pred);
    if (!rec.proof) { rec.why = doubt; return `unprovable: ${doubt}`; }
  }
  return null;
}

// ── recording ────────────────────────────────────────────────────────────────────────────────────────────────────────────

let SCRATCH: CharacterCollision | null = null;
let SCRATCH_OF: Rapier | null = null;

function scratchOf(R: Rapier): CharacterCollision {
  if (SCRATCH_OF !== R || !SCRATCH) { SCRATCH = new R.CharacterCollision(); SCRATCH_OF = R; }
  return SCRATCH;
}

const MV: Vec3 = { x: 0, y: 0, z: 0 };

interface Outputs { mv: number[]; grounded: boolean; n: number; col: number[]; colHandle: number[] }

/** the outputs of the call just made: movement, grounded, collisions; null when a number is not finite */
function readOutputs(R: Rapier, ctl: KinematicCharacterController): Outputs | null {
  ctl.computedMovement(MV);
  const mv = [MV.x, MV.y, MV.z];
  const n = ctl.numComputedCollisions();
  const col: number[] = new Array<number>(n * COL_STRIDE);
  const colHandle: number[] = new Array<number>(n);
  const sc = scratchOf(R);
  for (let i = 0; i < n; i++) {
    const h = ctl.computedCollision(i, sc);
    if (!h || !h.collider) return null;
    const o = i * COL_STRIDE;
    const a = h.translationDeltaApplied, r = h.translationDeltaRemaining, w1 = h.witness1, w2 = h.witness2, n1 = h.normal1, n2 = h.normal2;
    col[o] = a.x; col[o + 1] = a.y; col[o + 2] = a.z;
    col[o + 3] = r.x; col[o + 4] = r.y; col[o + 5] = r.z;
    col[o + 6] = h.toi;
    col[o + 7] = w1.x; col[o + 8] = w1.y; col[o + 9] = w1.z;
    col[o + 10] = w2.x; col[o + 11] = w2.y; col[o + 12] = w2.z;
    col[o + 13] = n1.x; col[o + 14] = n1.y; col[o + 15] = n1.z;
    col[o + 16] = n2.x; col[o + 17] = n2.y; col[o + 18] = n2.z;
    colHandle[i] = h.collider.handle;
  }
  if (!allFinite(mv, 3) || !allFinite(col, col.length)) return null;
  return { mv, grounded: ctl.computedGrounded(), n, col, colHandle };
}

/** verify mode: the real call's outputs against the record's; null when every field is the same */
function differs(rec: MemoRecord, R: Rapier, ctl: KinematicCharacterController): string | null {
  const o = readOutputs(R, ctl);
  if (!o) return 'outputs not finite';
  if (!same(o.mv, rec.mv, 3)) return `movement ${o.mv.join(',')} vs ${rec.mv.join(',')}`;
  if (o.grounded !== rec.grounded) return 'grounded';
  if (o.n !== rec.n) return `collisions ${o.n} vs ${rec.n}`;
  for (let i = 0; i < o.n; i++) if (o.colHandle[i] !== rec.colHandle[i]) return `collision ${i} collider`;
  for (let i = 0; i < o.col.length; i++) if (!Object.is(o.col[i], rec.col[i])) return `collision ${Math.floor(i / COL_STRIDE)} field ${i % COL_STRIDE}`;
  return null;
}

/** a record of the call just made, or null when it cannot be proven again (header) */
function record(R: Rapier, k: ControllerInternals, ctl: KinematicCharacterController, c: CharacterBody, dx: number, dy: number, dz: number, flags: number,
  groups: number, pred: ((h: number) => boolean) | undefined): MemoRecord | null {
  // no push-out pass (it runs at 1e-5 and less), no impulses (a hit would skip them)
  if (!(Math.hypot(dx, dy, dz) > 2e-5)) return refuse('desired');
  if (k._applyImpulsesToDynamicBodies) return refuse('impulses');
  const co = k.colliders.raw;
  const h = c.collider.handle;
  const pose = new Array<number>(10);
  if (!readPose(co, h, pose) || !allFinite(pose, 9)) return refuse('pose');
  const cfg = new Array<number>(CFG_LEN);
  readConfig(ctl, cfg);
  // the boxes below are worked out for up = +Y
  if (cfg[11] !== 0 || cfg[12] !== 1 || cfg[13] !== 0) return refuse('up');
  const out = readOutputs(R, ctl);
  if (!out) return refuse('outputs');
  const g = geometry(pose, cfg);
  const lo = [0, 0, 0], hi = [0, 0, 0];
  region(g, out, lo, hi);
  if (!allFinite(lo, 3) || !allFinite(hi, 3)) return refuse('region');
  const s = scan(R, k, h, pose[9]!, flags, groups, pred, lo, hi);
  if (s === null) return null;
  return {
    ctl, cfg, dt: k.params.dt, mass: k._characterMass, flags, groups, handle: h, pose, d: [dx, dy, dz], lo, hi,
    rel: s.rel.slice(), relShape: s.shape.slice(), order: s.order.slice(), mv: out.mv, grounded: out.grounded, n: out.n, col: out.col,
    colHandle: out.colHandle, g, proof: null, why: '',
  };
}

// ── boxes of the call ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Rapier's `predict_ground`: offset + this */
const GROUND_PREDICTION = 0.05;
/** slack on every box (f32 rounding of the poses and of the query boxes) */
const SLACK = 1e-3;

/** the character collider at the call's start: its AABB centre and half extents, and the settings that size the boxes */
interface Geometry { cx: number; cy: number; cz: number; ex: number; ey: number; ez: number; offset: number; pred: number; stepH: number; stepW: number; snap: number; maxClimb: number }

function geometry(pose: readonly number[], cfg: readonly number[]): Geometry {
  const qx = pose[3]!, qy = pose[4]!, qz = pose[5]!, qw = pose[6]!, r = pose[7]!, hh = pose[8]!;
  // the capsule's axis turned, its AABB half extents
  const ax = 2 * (qx * qy - qw * qz), ay = 1 - 2 * (qx * qx + qz * qz), az = 2 * (qy * qz + qw * qx);
  const step = cfg[3] === 1;
  return {
    cx: pose[0]!, cy: pose[1]!, cz: pose[2]!, ex: Math.abs(ax) * hh + r, ey: Math.abs(ay) * hh + r, ez: Math.abs(az) * hh + r,
    offset: cfg[0]!, pred: cfg[0]! + GROUND_PREDICTION, stepH: step ? num(cfg[4]) : 0, stepW: step ? num(cfg[5]) : 0,
    snap: cfg[9] === 1 ? num(cfg[10]) : 0, maxClimb: cfg[7]!,
  };
}

/** a box [lo, hi] made of character AABBs: `add` the AABB at a translation, grown by margins (sideways, down, up) */
class Box {
  readonly lo = [0, 0, 0];
  readonly hi = [0, 0, 0];
  g: Geometry | null = null;
  clear(g: Geometry): this {
    this.g = g;
    this.lo[0] = this.lo[1] = this.lo[2] = Number.POSITIVE_INFINITY;
    this.hi[0] = this.hi[1] = this.hi[2] = Number.NEGATIVE_INFINITY;
    return this;
  }
  add(px: number, py: number, pz: number, side: number, down: number, up: number): this {
    const g = this.g!, lo = this.lo, hi = this.hi;
    lo[0] = Math.min(lo[0]!, g.cx + px - g.ex - side); hi[0] = Math.max(hi[0]!, g.cx + px + g.ex + side);
    lo[1] = Math.min(lo[1]!, g.cy + py - g.ey - down); hi[1] = Math.max(hi[1]!, g.cy + py + g.ey + up);
    lo[2] = Math.min(lo[2]!, g.cz + pz - g.ez - side); hi[2] = Math.max(hi[2]!, g.cz + pz + g.ez + side);
    return this;
  }
  /** empty (an inner box shrunk past nothing) */
  get empty(): boolean { return !(this.lo[0]! <= this.hi[0]! && this.lo[1]! <= this.hi[1]! && this.lo[2]! <= this.hi[2]!); }
}

/**
 * The sweep of main-loop cast i (it ended at the hit's pose `a`, with `r` remaining): from a - toi·r/|r| to a + r, the
 * character AABB along it grown by the target distance. Its start box (`inner`) shrunk by the slack: what reaches it reaches
 * the true start box loosened by the target distance.
 */
function castBoxes(g: Geometry, col: readonly number[], i: number, sweep: Box, inner: Box | null): void {
  const o = i * COL_STRIDE;
  const ax = col[o]!, ay = col[o + 1]!, az = col[o + 2]!, rx = col[o + 3]!, ry = col[o + 4]!, rz = col[o + 5]!, toi = col[o + 6]!;
  const rl = Math.hypot(rx, ry, rz);
  const m = g.offset + SLACK;
  sweep.clear(g);
  if (rl > 1e-6) {
    const k = toi / rl;
    const sx = ax - rx * k, sy = ay - ry * k, sz = az - rz * k;
    sweep.add(sx, sy, sz, m, m, m).add(ax + rx, ay + ry, az + rz, m, m, m);
    inner?.clear(g).add(sx, sy, sz, g.offset - SLACK, g.offset - SLACK, g.offset - SLACK);
  } else {
    // no direction to go by: every pose within the cast's length
    const w = toi + rl + m;
    sweep.add(ax, ay, az, w, w, w);
    const v = g.offset - toi - rl - SLACK;
    inner?.clear(g).add(ax, ay, az, v, v, v);
  }
}

/**
 * handle_stairs for a wall hit at `a` with `r` remaining. It adds the offset to both lengths (H' = max height + offset,
 * W' = min width + offset) and goes `forward` along the horizontal part of r, normalised: up by H' from a, forward by W' from
 * there, down by H' from there (the ramp probe, then the step height), each cast grown by the target distance; after a step
 * (at most H' up and W' forward) the ground query (the prediction). `all`: every one of those boxes, for R. `sweep` and
 * `inner`: the ramp probe's sweep and its start box. A horizontal part under a micrometre is taken in every direction (the
 * f32 normalisation of a vector that small is not followed here), so the start box is then the one raised by H' and shrunk
 * sideways by W'.
 */
function stairBoxes(g: Geometry, col: readonly number[], i: number, all: Box | null, sweep: Box | null, inner: Box | null): void {
  const o = i * COL_STRIDE;
  const ax = col[o]!, ay = col[o + 1]!, az = col[o + 2]!, rx = col[o + 3]!, rz = col[o + 5]!;
  const h = g.stepH + g.offset, w = g.stepW + g.offset;
  const hl = Math.hypot(rx, rz);
  const m = Math.max(g.offset, g.pred) + SLACK, t = g.offset + SLACK;
  if (hl >= 1e-6) {
    const fx = (rx / hl) * w, fz = (rz / hl) * w;
    all?.clear(g).add(ax, ay, az, m, m, m).add(ax + fx, ay + h, az + fz, m, m, m);
    sweep?.clear(g).add(ax + fx, ay, az + fz, t, t, h + t);
    inner?.clear(g).add(ax + fx, ay + h, az + fz, g.offset - SLACK, g.offset - SLACK, g.offset - SLACK);
  } else {
    all?.clear(g).add(ax, ay, az, w + m, m, h + m);
    sweep?.clear(g).add(ax, ay, az, w + t, t, h + t);
    inner?.clear(g).add(ax, ay + h, az, -g.stepW - SLACK, g.offset - SLACK, g.offset - SLACK);
  }
}

/** can hit i be a wall (stairs ran for it): not clearly walkable for `up` = +Y */
function maybeWall(g: Geometry, col: readonly number[], i: number): boolean {
  if (!(g.stepH > 0)) return false;
  const o = i * COL_STRIDE;
  const nx = col[o + 13]!, ny = col[o + 14]!, nz = col[o + 15]!;
  const l = Math.hypot(nx, ny, nz);
  if (!(l > 0)) return true;
  return !(Math.acos(Math.min(1, Math.max(-1, ny / l))) < g.maxClimb - 1e-4);
}

const BOX_A = new Box(), BOX_B = new Box();

/**
 * R for the recorded call: the character AABB at the start loosened by the ground prediction; every main-loop cast's sweep
 * (castBoxes) and the ground query at its hit; the stair probes of every hit that may be a wall (stairBoxes; a step taken
 * starts the next cast, which the next sweep covers); the final pose with the snap cast (down by the snap distance from at
 * most that far above it) and its ground query. Every pose a query of the call started from is in one of these, and so is
 * every cast's sweep.
 */
function region(g: Geometry, out: Outputs, lo: number[], hi: number[]): void {
  const r = BOX_A.clear(g);
  const p = g.pred + SLACK;
  r.add(0, 0, 0, p, p, p);
  const col = out.col;
  for (let i = 0; i < out.n; i++) {
    castBoxes(g, col, i, BOX_B, null);
    merge(r, BOX_B);
    const o = i * COL_STRIDE;
    r.add(col[o]!, col[o + 1]!, col[o + 2]!, p, p, p);
    if (maybeWall(g, col, i)) { stairBoxes(g, col, i, BOX_B, null, null); merge(r, BOX_B); }
  }
  const mv = out.mv;
  r.add(mv[0]!, mv[1]!, mv[2]!, g.offset + p, g.snap + g.offset + p, g.snap + p);
  for (let i = 0; i < 3; i++) { lo[i] = r.lo[i]!; hi[i] = r.hi[i]!; }
}

function merge(a: Box, b: Box): void {
  for (let i = 0; i < 3; i++) { a.lo[i] = Math.min(a.lo[i]!, b.lo[i]!); a.hi[i] = Math.max(a.hi[i]!, b.hi[i]!); }
}

// ── the colliders over R ─────────────────────────────────────────────────────────────────────────────────────────────────

/** RawRigidBodyType */
const DYNAMIC = 0, FIXED = 1, KINEMATIC_POSITION = 2, KINEMATIC_VELOCITY = 3;
/** QueryFilterFlags */
const EXCLUDE_FIXED = 1, EXCLUDE_KINEMATIC = 2, EXCLUDE_DYNAMIC_FLAG = 4, EXCLUDE_SENSORS = 8, EXCLUDE_SOLIDS = 16;

interface ScanOut { rel: number[]; shape: unknown[]; order: number[] }
const SCAN: ScanOut = { rel: [], shape: [], order: [] };
const LEAVES: number[] = [];
const PROBED: number[] = [];
const AT_LO: number[] = [];
const AT_HI: number[] = [];
const REL: number[] = new Array<number>(REL_STRIDE).fill(0);
const f32 = new Float32Array(1);

/** an f32 at or below / at or above `v` (a query corner must not round into R) */
function f32Below(v: number): number { f32[0] = v - Math.abs(v) * 1e-6 - 1e-6; return f32[0]!; }
function f32Above(v: number): number { f32[0] = v + Math.abs(v) * 1e-6 + 1e-6; return f32[0]!; }

/** the leaves whose stored AABB reaches [lo, hi], depth first; `outward` pads the box against f32 rounding (else it is shrunk) */
function query(R: Rapier, k: ControllerInternals, lo: readonly number[], hi: readonly number[], outward: boolean, out: number[]): void {
  out.length = 0;
  const pad = (outward ? 1 : -1) * (1e-4 + 1e-6 * Math.max(Math.abs(lo[0]!), Math.abs(lo[1]!), Math.abs(lo[2]!), Math.abs(hi[0]!), Math.abs(hi[1]!), Math.abs(hi[2]!)));
  const hx = (hi[0]! - lo[0]!) / 2 + pad, hy = (hi[1]! - lo[1]!) / 2 + pad, hz = (hi[2]! - lo[2]!) / 2 + pad;
  if (!(hx >= 0 && hy >= 0 && hz >= 0)) return;
  const c = R.VectorOps.intoRaw({ x: (lo[0]! + hi[0]!) / 2, y: (lo[1]! + hi[1]!) / 2, z: (lo[2]! + hi[2]!) / 2 }) as unknown as RawVector;
  const e = R.VectorOps.intoRaw({ x: hx, y: hy, z: hz }) as unknown as RawVector;
  k.broadPhase.raw.collidersWithAabbIntersectingAabb(k.narrowPhase.raw, k.bodies.raw, k.colliders.raw, c, e, (h) => { out.push(h); return true; });
  c.free();
  e.free();
}

function pointQuery(R: Rapier, k: ControllerInternals, x: number, y: number, z: number, out: number[]): void {
  out.length = 0;
  const c = R.VectorOps.intoRaw({ x, y, z }) as unknown as RawVector;
  const e = R.VectorOps.intoRaw({ x: 0, y: 0, z: 0 }) as unknown as RawVector;
  k.broadPhase.raw.collidersWithAabbIntersectingAabb(k.narrowPhase.raw, k.bodies.raw, k.colliders.raw, c, e, (h) => { out.push(h); return true; });
  c.free();
  e.free();
}

/**
 * The colliders that matter to a call whose queries all lie in [lo, hi] (header, 2-3), in the order the broad phase visits
 * them, REL_STRIDE numbers each, plus their shape objects; null when one of them gives no proof.
 */
function scan(R: Rapier, k: ControllerInternals, own: number, ownParent: number, flags: number, groups: number, pred: ((h: number) => boolean) | undefined,
  lo: readonly number[], hi: readonly number[]): ScanOut | null {
  const co = k.colliders.raw, bo = k.bodies.raw;
  // BIG: the stored AABB holds both corners of R, so all of R
  pointQuery(R, k, f32Below(lo[0]!), f32Below(lo[1]!), f32Below(lo[2]!), AT_LO);
  pointQuery(R, k, f32Above(hi[0]!), f32Above(hi[1]!), f32Above(hi[2]!), AT_HI);
  query(R, k, lo, hi, true, LEAVES);
  const rel = SCAN.rel, shapes = SCAN.shape;
  rel.length = 0; shapes.length = 0;
  for (const h of LEAVES) {
    // QueryFilter::test of the call: own collider, own body, groups, flags, predicate (the predicate last, as Rapier asks it)
    if (h === own) continue;
    const parent = co.coParent(h);
    if (parent !== undefined && parent === ownParent) continue;
    const g = co.coCollisionGroups(h);
    if (!groupsInteract(g, groups)) continue;
    const sensor = co.coIsSensor(h);
    if ((flags & EXCLUDE_SENSORS) !== 0 && sensor) continue;
    if ((flags & EXCLUDE_SOLIDS) !== 0 && !sensor) continue;
    let type = -1;
    if (parent === undefined) {
      if ((flags & EXCLUDE_FIXED) !== 0) continue;
    } else {
      type = bo.rbBodyType(parent);
      if (type === FIXED) { if ((flags & EXCLUDE_FIXED) !== 0) continue; }
      else if (type === DYNAMIC) { if ((flags & EXCLUDE_DYNAMIC_FLAG) !== 0) continue; }
      else if (type === KINEMATIC_POSITION || type === KINEMATIC_VELOCITY) { if ((flags & EXCLUDE_KINEMATIC) !== 0) continue; }
      // a body type this file does not know: no proof
      else return refuse('body type');
    }
    if (pred && !pred(h)) continue;
    // it passes the filter: out of every query's reach, or relevant
    const shape = co.coShapeType(h);
    co.coTranslation(h, F4);
    const tx = F4[0]!, ty = F4[1]!, tz = F4[2]!;
    co.coRotation(h, F4);
    const qx = F4[0]!, qy = F4[1]!, qz = F4[2]!, qw = F4[3]!;
    shapeParams(co, h, shape, REL);
    if (outOfReach(shape, tx, ty, tz, qx, qy, qz, qw, REL, lo, hi)) continue;
    // a parented collider that is not big: its stored box depends on how it moved, not on where it is
    if (parent !== undefined && (!AT_LO.includes(h) || !AT_HI.includes(h))) return refuse(`small body ${type}/${shape}`);
    REL[0] = h; REL[1] = parent ?? -1; REL[2] = type; REL[3] = sensor ? 1 : 0; REL[4] = g; REL[5] = co.coIsEnabled(h) ? 1 : 0; REL[6] = shape;
    REL[7] = tx; REL[8] = ty; REL[9] = tz; REL[10] = qx; REL[11] = qy; REL[12] = qz; REL[13] = qw;
    // REL[14..18]: shape parameters (shapeParams); REL[19]: contact skin
    REL[19] = co.coContactSkin(h);
    for (let i = 20; i < REL_STRIDE; i++) REL[i] = 0;
    if (parent !== undefined && (type === KINEMATIC_POSITION || type === KINEMATIC_VELOCITY)) {
      // the kinematic-friction term of the ground query: velocity_at_point × dt
      bo.rbLinvel(parent, F4); REL[20] = F4[0]!; REL[21] = F4[1]!; REL[22] = F4[2]!;
      bo.rbAngvel(parent, F4); REL[23] = F4[0]!; REL[24] = F4[1]!; REL[25] = F4[2]!;
      bo.rbWorldCom(parent, F4); REL[26] = F4[0]!; REL[27] = F4[1]!; REL[28] = F4[2]!;
    }
    // a pose, skin or velocity that is not finite: no proof (absent shape parameters are NaN on purpose, compared with Object.is)
    for (let i = 7; i < REL_STRIDE; i++) if ((i < 14 || i > 18) && !Number.isFinite(REL[i])) return refuse('collider not finite');
    for (let i = 0; i < REL_STRIDE; i++) rel.push(REL[i]!);
    if (isPrimitive(shape)) shapes.push(null);
    else {
      // a mesh, hull, height field, compound: replaced only through `setShape` (a new JS Shape) or a voxel edit (none)
      const s = (k.colliders.get(h) as unknown as { _shape?: unknown } | null)?._shape;
      if (s === undefined || s === null) return refuse('shape unknown');
      shapes.push(s);
    }
  }
  // the order in which a cast visits the relevant leaves when all of them score 0 (header, 4)
  const order = SCAN.order;
  order.length = 0;
  if (rel.length > REL_STRIDE) {
    probe(R, k, lo, hi);
    for (const h of PROBED) if (!order.includes(h)) for (let j = 0; j < rel.length; j += REL_STRIDE) if (rel[j] === h) { order.push(h); break; }
    if (order.length * REL_STRIDE !== rel.length) return refuse('probe');
  }
  return SCAN;
}

let PROBE_BOX: { hx: number; hy: number; hz: number; of: Rapier; shape: InstanceType<Rapier['Cuboid']> } | null = null;
const PROBE_AT: Vec3 = { x: 0, y: 0, z: 0 };
const PROBE_ROT = { x: 0, y: 0, z: 0, w: 1 };
const PROBE_VEL: Vec3 = { x: 0, y: 1, z: 0 };
const probeVisit = (h: number): boolean => { PROBED.push(h); return false; };

/**
 * `find_best`'s visiting order, observed: a cast of a cuboid that covers R (padded), unfiltered, whose predicate notes every
 * leaf the traversal evaluates and takes none (so the best stays at the cast's 1 mm and nothing is pruned). Every leaf that
 * reaches R, and every node above one, scores 0 in it, so the order it notes is the order of the tree's shape: at every
 * node a leaf child before a subtree, two subtrees left first. In any of the call's casts a relevant leaf that touches the
 * start box has all its ancestors at 0 as well, so two such leaves are visited in this order there too.
 */
function probe(R: Rapier, k: ControllerInternals, lo: readonly number[], hi: readonly number[]): void {
  PROBED.length = 0;
  const pad = 1e-4 + 1e-6 * Math.max(Math.abs(lo[0]!), Math.abs(lo[1]!), Math.abs(lo[2]!), Math.abs(hi[0]!), Math.abs(hi[1]!), Math.abs(hi[2]!));
  const hx = (hi[0]! - lo[0]!) / 2 + pad, hy = (hi[1]! - lo[1]!) / 2 + pad, hz = (hi[2]! - lo[2]!) / 2 + pad;
  if (!PROBE_BOX || PROBE_BOX.of !== R || PROBE_BOX.hx !== hx || PROBE_BOX.hy !== hy || PROBE_BOX.hz !== hz) {
    PROBE_BOX = { hx, hy, hz, of: R, shape: new R.Cuboid(hx, hy, hz) };
  }
  PROBE_AT.x = (lo[0]! + hi[0]!) / 2; PROBE_AT.y = (lo[1]! + hi[1]!) / 2; PROBE_AT.z = (lo[2]! + hi[2]!) / 2;
  const cast = (k.broadPhase as unknown as { castShape: CastShape }).castShape.bind(k.broadPhase);
  cast(k.narrowPhase, k.bodies, k.colliders, PROBE_AT, PROBE_ROT, PROBE_VEL, PROBE_BOX.shape, 0, 1e-3, false, 0, undefined, undefined, undefined, probeVisit);
}

const S_SET: number[] = [];
const T_SET: number[] = [];
const HITS: number[] = [];

/**
 * Header, 4: for every order-sensitive cast of the recorded call (a main-loop hit at a positive time of impact; the ramp probe
 * of every hit that may be a wall, unless its upward clearance cast is blocked, which ends handle_stairs before it), the
 * relevant leaves that reach its sweep all reach its start box, or are at most one.
 */
function tieFree(R: Rapier, k: ControllerInternals, g: Geometry, pose: readonly number[], cfg: readonly number[], out: Outputs, rel: readonly number[],
  own: number, flags: number, groups: number, pred: ((h: number) => boolean) | undefined): boolean {
  if (rel.length <= REL_STRIDE) return true;
  const col = out.col;
  let lastX = Number.NaN, lastY = Number.NaN, lastZ = Number.NaN, lastRx = Number.NaN, lastRz = Number.NaN, lastSafe = SAFE;
  for (let i = 0; i < out.n; i++) {
    const o = i * COL_STRIDE;
    if (col[o + 6] !== 0) {
      castBoxes(g, col, i, BOX_A, BOX_B);
      if (!orderedOrSingle(R, k, rel, BOX_A, BOX_B)) { doubt = 'tie: cast'; return false; }
    }
    if (!maybeWall(g, col, i)) continue;
    const ax = col[o]!, ay = col[o + 1]!, az = col[o + 2]!, rx = col[o + 3]!, rz = col[o + 5]!;
    if (!(Object.is(ax, lastX) && Object.is(ay, lastY) && Object.is(az, lastZ) && Object.is(rx, lastRx) && Object.is(rz, lastRz))) {
      lastX = ax; lastY = ay; lastZ = az; lastRx = rx; lastRz = rz;
      stairBoxes(g, col, i, null, BOX_A, BOX_B);
      lastSafe = orderedOrSingle(R, k, rel, BOX_A, BOX_B) ? SAFE : stairsSafe(R, k, pose, cfg, ax, ay, az, rx, rz, own, flags, groups, pred, rel);
    }
    if (lastSafe === UNSAFE) return false;
    // the replay of handle_stairs checks itself against what the call did: a blocked stair is no step
    if (lastSafe === BLOCKED && stepped(out, i) === true) { doubt = 'stairs replay'; return false; }
  }
  return true;
}

/**
 * Did the controller take a step after hit i? A step moves the body sideways by the nudge (handle_slopes moves nothing), so
 * the next cast starts elsewhere: at the next hit's pose when that one is at time of impact 0, or (after the last hit) the
 * final pose differs sideways (the snap moves along up only). Null when the next start is not known exactly.
 */
function stepped(out: Outputs, i: number): boolean | null {
  const col = out.col, o = i * COL_STRIDE;
  if (i === out.n - 1) return !(Object.is(out.mv[0], col[o]) && Object.is(out.mv[2], col[o + 2]));
  const q = o + COL_STRIDE;
  if (col[q + 6] !== 0) return null;
  return !(Object.is(col[q], col[o]) && Object.is(col[q + 1], col[o + 1]) && Object.is(col[q + 2], col[o + 2]));
}

const UP: Vec3 = { x: 0, y: 1, z: 0 };
const DOWN: Vec3 = { x: -0, y: -1, z: -0 };
const DIR: Vec3 = { x: 0, y: 0, z: 0 };
const AT: Vec3 = { x: 0, y: 0, z: 0 };
const ROT = { x: 0, y: 0, z: 0, w: 1 };
let CAPSULE_SHAPE: { r: number; hh: number; of: Rapier; shape: InstanceType<Rapier['Capsule']> } | null = null;
let ONLY = -1;
let ONLY_PRED: ((h: number) => boolean) | undefined;
const onlyOne = (h: number): boolean => h === ONLY && (ONLY_PRED === undefined || ONLY_PRED(h));

interface CastHit { readonly time_of_impact: number; readonly normal1: Vec3 }
type CastShape = (np: unknown, bodies: unknown, colliders: unknown, pos: Vec3, rot: typeof ROT, vel: Vec3, shape: unknown, targetDistance: number, maxToi: number,
  stopAtPenetration: boolean, flags: number, groups: number | undefined, excludeCollider: number | undefined, excludeBody: number | undefined,
  pred: ((h: number) => boolean) | undefined) => CastHit | null;

/**
 * A cast of handle_stairs made again as the controller made it, through the same query pipeline: the character capsule from
 * AT (with the character's rotation) along `dir` up to `max`, target distance offset, not stopping at a penetration it
 * leaves, with the call's filter (EXCLUDE_DYNAMIC added unless the autostep includes dynamic bodies), restricted to one
 * collider when `only` is not -1.
 */
function stairCast(R: Rapier, k: ControllerInternals, pose: readonly number[], cfg: readonly number[], dir: Vec3, max: number, own: number, flags: number,
  groups: number, pred: ((h: number) => boolean) | undefined, only: number): CastHit | null {
  const r = pose[7]!, hh = pose[8]!;
  if (!CAPSULE_SHAPE || CAPSULE_SHAPE.of !== R || !Object.is(CAPSULE_SHAPE.r, r) || !Object.is(CAPSULE_SHAPE.hh, hh)) {
    CAPSULE_SHAPE = { r, hh, of: R, shape: new R.Capsule(hh, r) };
  }
  ROT.x = pose[3]!; ROT.y = pose[4]!; ROT.z = pose[5]!; ROT.w = pose[6]!;
  const f = cfg[6] === 1 ? flags : flags | EXCLUDE_DYNAMIC_FLAG;
  const parent = pose[9]!;
  ONLY = only; ONLY_PRED = pred;
  const cast = (k.broadPhase as unknown as { castShape: CastShape }).castShape.bind(k.broadPhase);
  const hit = cast(k.narrowPhase, k.bodies, k.colliders, AT, ROT, dir, CAPSULE_SHAPE.shape, cfg[0]!, max, false, f, groups, own,
    parent >= 0 ? parent : undefined, only >= 0 ? onlyOne : pred);
  ONLY = -1; ONLY_PRED = undefined;
  return hit ?? null;
}

/** an f32 product / sum as the wasm computes it (both operands are f32: the f64 result rounds once, correctly) */
const mul32 = (a: number, b: number): number => Math.fround(a * b);
const add32 = (a: number, b: number): number => Math.fround(a + b);

/**
 * handle_stairs for a wall hit at `a` (remaining `r`) whose ramp probe could not be shown order-free by its boxes: its casts
 * made again bit for bit (the pose at the hit is the f32 sum pose + a; `max_height` and `min_width` are the f32 sums of the
 * setting and the offset; the forward direction is glam's `try_normalize` of r's horizontal part: dot, sqrt, reciprocal,
 * product, each rounded to f32; the casts start from `pose + up·max_height` and from there `+ dir·min_width`). It returns
 * before the ramp probe when the upward or the forward clearance cast hits (neither depends on the candidates' order). The
 * ramp probe itself is made once per relevant collider: the order cannot matter when at most one collider reaches its best
 * time of impact, or all that do have the same normal (handle_stairs reads nothing else of it).
 */
function stairsSafe(R: Rapier, k: ControllerInternals, pose: readonly number[], cfg: readonly number[], ax: number, ay: number, az: number, rx: number,
  rz: number, own: number, flags: number, groups: number, pred: ((h: number) => boolean) | undefined, rel: readonly number[]): StairVerdict {
  // the horizontal direction (handle_stairs gives up without a cast when it cannot be normalised)
  const len = Math.fround(Math.sqrt(add32(mul32(rx, rx), mul32(rz, rz))));
  const rcp = Math.fround(1 / len);
  if (!(Number.isFinite(rcp) && rcp > 0)) return SAFE;
  const dx = mul32(rx, rcp), dz = mul32(rz, rcp);
  const maxH = add32(cfg[4]!, cfg[0]!), minW = add32(cfg[5]!, cfg[0]!);
  const px = add32(pose[0]!, ax), py = add32(pose[1]!, ay), pz = add32(pose[2]!, az);
  AT.x = px; AT.y = py; AT.z = pz;
  if (stairCast(R, k, pose, cfg, UP, maxH, own, flags, groups, pred, -1)) return BLOCKED;
  const sy = add32(py, maxH);
  AT.x = px; AT.y = sy; AT.z = pz;
  DIR.x = dx; DIR.y = 0; DIR.z = dz;
  if (stairCast(R, k, pose, cfg, DIR, minW, own, flags, groups, pred, -1)) return BLOCKED;
  // the ramp probe, collider by collider
  let best = Number.POSITIVE_INFINITY, nx = 0, ny = 0, nz = 0, tied = false;
  for (let j = 0; j < rel.length; j += REL_STRIDE) {
    AT.x = add32(px, mul32(dx, minW)); AT.y = sy; AT.z = add32(pz, mul32(dz, minW));
    const hit = stairCast(R, k, pose, cfg, DOWN, maxH, own, flags, groups, pred, rel[j]!);
    if (!hit) continue;
    const t = hit.time_of_impact, n = hit.normal1;
    if (t < best) { best = t; nx = n.x; ny = n.y; nz = n.z; tied = false; }
    else if (t === best && !(Object.is(n.x, nx) && Object.is(n.y, ny) && Object.is(n.z, nz))) tied = true;
  }
  if (tied) { doubt = 'tie: stair probe'; return UNSAFE; }
  return SAFE;
}

/** what tieFree learns of a wall hit's handle_stairs: nothing order-dependent, returned before its ramp probe, or no proof */
type StairVerdict = 0 | 1 | 2;
const SAFE: StairVerdict = 0, BLOCKED: StairVerdict = 1, UNSAFE: StairVerdict = 2;

function relevantIn(rel: readonly number[], leaves: readonly number[], out: number[]): void {
  out.length = 0;
  for (let j = 0; j < rel.length; j += REL_STRIDE) if (leaves.includes(rel[j]!)) out.push(rel[j]!);
}

function orderedOrSingle(R: Rapier, k: ControllerInternals, rel: readonly number[], sweep: Box, inner: Box): boolean {
  query(R, k, sweep.lo, sweep.hi, true, HITS);
  relevantIn(rel, HITS, S_SET);
  if (S_SET.length <= 1) return true;
  if (inner.empty) return false;
  query(R, k, inner.lo, inner.hi, false, HITS);
  relevantIn(rel, HITS, T_SET);
  for (const h of S_SET) if (!T_SET.includes(h)) return false;
  return true;
}

function isPrimitive(shape: number): boolean {
  return shape === BALL || shape === CUBOID || shape === CAPSULE || shape === CYLINDER || shape === CONE || shape === ROUND_CUBOID || shape === ROUND_CYLINDER || shape === ROUND_CONE;
}

/** REL[14..18]: half extents (cuboids) or radius and half height; the round radius; NaN where the shape has none */
function shapeParams(co: RawColliders, h: number, shape: number, out: number[]): void {
  out[14] = out[15] = out[16] = out[17] = out[18] = Number.NaN;
  if (shape === CUBOID || shape === ROUND_CUBOID) {
    if (co.coHalfExtents(h, F4)) { out[14] = F4[0]!; out[15] = F4[1]!; out[16] = F4[2]!; }
  } else if (shape === BALL) {
    out[14] = num(co.coRadius(h));
  } else if (shape === CAPSULE || shape === CYLINDER || shape === CONE || shape === ROUND_CYLINDER || shape === ROUND_CONE) {
    out[14] = num(co.coRadius(h)); out[15] = num(co.coHalfHeight(h));
  }
  if (shape === ROUND_CUBOID || shape === ROUND_CYLINDER || shape === ROUND_CONE) out[17] = num(co.coRoundRadius(h));
}

/**
 * True when a primitive collider lies wholly outside R (by a margin): no query of the call can touch it, so it neither hits
 * nor counts in a contact, wherever and whenever the broad phase visits it. Its bounds: the box (half extents, or radius and
 * half height, a capsule's with its caps), turned by its rotation, plus the round radius.
 */
function outOfReach(shape: number, tx: number, ty: number, tz: number, qx: number, qy: number, qz: number, qw: number, p: readonly number[],
  lo: readonly number[], hi: readonly number[]): boolean {
  let bx: number, by: number, bz: number;
  if (shape === CUBOID || shape === ROUND_CUBOID) { bx = p[14]!; by = p[15]!; bz = p[16]!; }
  else if (shape === BALL) { bx = by = bz = p[14]!; }
  else if (shape === CAPSULE) { bx = bz = p[14]!; by = p[15]! + p[14]!; }
  else if (shape === CYLINDER || shape === CONE || shape === ROUND_CYLINDER || shape === ROUND_CONE) { bx = bz = p[14]!; by = p[15]!; }
  else return false;
  const round = shape === ROUND_CUBOID || shape === ROUND_CYLINDER || shape === ROUND_CONE ? p[17]! : 0;
  if (!(bx >= 0 && by >= 0 && bz >= 0 && round >= 0)) return false;
  // |rotation matrix| · half extents
  const xx = qx * qx, yy = qy * qy, zz = qz * qz, xy = qx * qy, xz = qx * qz, yz = qy * qz, wx = qw * qx, wy = qw * qy, wz = qw * qz;
  const m00 = 1 - 2 * (yy + zz), m01 = 2 * (xy - wz), m02 = 2 * (xz + wy);
  const m10 = 2 * (xy + wz), m11 = 1 - 2 * (xx + zz), m12 = 2 * (yz - wx);
  const m20 = 2 * (xz - wy), m21 = 2 * (yz + wx), m22 = 1 - 2 * (xx + yy);
  const grow = 1 + 1e-5;
  const ex = (Math.abs(m00) * bx + Math.abs(m01) * by + Math.abs(m02) * bz) * grow + round + SLACK;
  const ey = (Math.abs(m10) * bx + Math.abs(m11) * by + Math.abs(m12) * bz) * grow + round + SLACK;
  const ez = (Math.abs(m20) * bx + Math.abs(m21) * by + Math.abs(m22) * bz) * grow + round + SLACK;
  return tx + ex < lo[0]! || tx - ex > hi[0]! || ty + ey < lo[1]! || ty - ey > hi[1]! || tz + ez < lo[2]! || tz - ez > hi[2]!;
}
