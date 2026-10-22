// Character movement on Rapier's `KinematicCharacterController` (motion §5.4, D-14). Rapier does the whole algorithm (cast
// loop with offset, wall / slope classification, autostep, slide with the climbing-intent rule, snap to ground, ground
// detection); this module adds the bookkeeping the controller leaves to its caller:
//
//   controllers    one per DISTINCT parameter set, configured once; a controller holds options, not per-body state
//   carry          a rider is moved by the rigid displacement of its kinematic ground body before its own move (step 0)
//   ground follow  on walkable ground the horizontal move is laid along the ground plane (defaults.KCC_GROUND_FOLLOW)
//   read back      movement, grounded, ground body and ground normal of this move
//   resume         a move the controller DROPPED is continued (below); a move it blocked is left alone
//   contact        characters in contact side by side block each other here, not in the controller (5)
//   push-out       a character standing inside others is moved out of them, a bounded share per tick, through the controller (7)
//
// The controller adds no gravity and this module integrates none: `desired` is the game's velocity × dt (contract §9.5).
// No `filterPredicate` for a body with nobody beside it (a JS callback per candidate crosses the wasm boundary; spectating
// bodies are disabled colliders), and no closure in its place: kcc-memo.ts `controllerMove` makes the controller call itself,
// because the public method hands the wasm a closure for every call, predicate or not. A body with a character within
// defaults.KCC_NEAR_RANGE passes one, on collider handles (5). No push-out from
// fixed or kinematic geometry: the controller has its own (7), the port adds one for character pairs only.
//
// Behaviours of the 0.21 controller measured while building this (tests/unit/physics/kcc-*.node.test.ts hold them):
//
// 1. It has a rider carry of its own ("kinematic friction": after a hit, the velocity of every touching kinematic body ×
//    `IntegrationParameters.dt` is added to the remaining translation). Characters are kinematic bodies too, so the same
//    code drags a character along with any character it touches. world.ts sets `world.timestep = 0` around the controller
//    pass, which makes that term zero: kinematic bodies are plain obstacles for the controller, and the carry is the exact
//    rigid displacement of the feet, moved here as a controller call of its own before the game's move (translation only,
//    no drift off a turning disc). Left to Rapier, a rider on a disc turning once in 40 s was carried in about half of the
//    ticks and ended half a turn behind.
// 2. After a ground hit (every ask with the game's gravity in it begins with one) the controller can drop the walk without
//    reporting what stopped it. Two causes were measured. On level ground a move with a downward part can lose its whole
//    horizontal part (`decompose_hit` has no horizontal tangent direction there; 17 of 600 walking ticks on a flat grid).
//    And the kinematic-friction code of 1 GLUES: it sets the part of the remaining move along the contact normal of every
//    kinematic collider within about 5 cm to that collider's own movement, in BOTH directions, so a body cannot walk
//    away from a door or a character beside it (stock, 1 m grid floor: 0.01 m in 0.5 s where 2.5 m were asked, at any
//    `timestep`; a fixed or parentless neighbour does not do it). So when every hit of a call was walkable ground and less
//    than defaults.KCC_DROPPED_SLIDE_SHARE of the walk was delivered, the missing part is asked again, a nudge above the
//    ground so that no ground hit precedes it. It is a trial: if it starts ON a kinematic body, going into that body is
//    what the controller had refused, and the first answer stands. On sloped ground this needs the walk to be known,
//    which it is for a ground-followed move (4). defaults.KCC_MAX_RESUMES = 0 switches every resume off.
// 3. Touching a kinematic body (a platform underfoot, a door, a character it is not in contact with yet: 5), the same
//    friction code removes the normal nudge that lets the next cast leave the surface, and the loop spins through its 20
//    iterations in place. The move is then asked again from where the first hit happened, for the remaining translation
//    slid along that hit plus the nudge, which is what the controller's own slide step computes for every other normal.
// 4. Its slide projects a horizontal move onto a slope, so the horizontal pace on a θ ramp is cos²θ of the pace asked, and
//    the game's `vy = v.y + g·dt` takes a further g·sinθ·cosθ: with player.js's acceleration limit the kit stair ramp
//    (32.7°) was walked at 2.15 m/s instead of 5. Ground follow asks for the move ALONG the ground the body stood on at the
//    end of the last tick (same horizontal part, the rise or drop of the slope added, the vertical part of the script kept
//    only as pressure onto the ground), so walkable slopes are walked at the pace asked; when that carries the body over the
//    top edge of a ramp it is set back down within the snap distance. Level ground is untouched by it.
// 5. Characters are kinematic bodies, and against a character in CONTACT the controller is the wrong tool three times
//    over. Two capsules inside each other (spawned on one spot, or met within one tick: each moved against the other's
//    last place, so they stand centimetres inside each other) lock, because the hit normals of an overlap are poor and
//    both casts count as approaching; yet a cast that starts inside a capsule does not block reliably either (of two
//    walkers that met head-on, one was let through after 11 pressed ticks in 1 start phase of 200). A body that presses
//    on another spins the loop out as in 3, every tick (35 bodies pressing on one: 6-10 ms per tick on stock Rapier,
//    19-40 % of the calls spun out). And the glue of 2 holds a body that wants to leave.
//    So the controller never sees a character the moved one is in contact with (world.ts lists them as `touching`: side
//    by side, the gap under defaults.KCC_TOUCH_GAP, inside each other included). Such a character blocks the ADVANCE on it
//    and nothing else, and the port does that itself on the circle of the two radii: the part of the asked move toward
//    its axis is taken out, the rest (along it, away from it) stays; a body wedged between two holds still. If the
//    controller's own slide off something else still carried the body onto it, the move is asked again without its
//    horizontal part. Deeper inside than defaults.KCC_OVERLAP_IGNORE_DEPTH a character does not block at all. Nobody is
//    pushed by another body's move; an overlap shrinks by the bodies' own moves and by the push-out of 7.
//    A character that is merely beside the body (`near`: up to defaults.KCC_NEAR_RANGE) is the controller's to stop, with
//    one exception: when the move leads away from it (defaults.KCC_LEAVE_COS) it is kept out of sight too, or the glue
//    would hold the body; if the move ends on it after all, it is asked again with that character in sight.
//    A body that came down on another one's head or shoulder is not in contact from the side (world.ts): that is the
//    controller's, and it rests there or slides off.
// 6. Between two STATIC surfaces the loop can spin out with the path open: along a wall on ground that also falls toward
//    the wall, the slide along the ground leans into the wall, the wall's "no climb without intent" rule takes the rise
//    away again, and the pair repeats until the 20 iterations are used up with the body where it was (measured raw: 64-75
//    of 77 ticks at such a wall stalled, 0.2-0.6 m/s instead of the 3.54 m/s of a plain wall; on the bench city 9 % of the
//    character-ticks). The first and the last hit normal of such a call are the two surfaces, so the move is asked ONCE
//    more along the line they share (their cross product, the remainder projected on it). Repeating the same slide
//    instead, as for 2 and 3, spins the same way: it cost 2.7 ms of a 7.2 ms pass and moved the bodies 8 mm. Two cases are
//    left alone: a remainder under a millimetre along the line (an inside corner the body is pressed into) and opposite
//    normals (a capsule standing IN a two-sided trimesh wall after a spawn or teleport: nothing asked gets it out).
// 7. Depenetration. The 0.21 controller HAS a push-out of its own, from whatever its queries see: measured
//    (tests/unit/physics/kcc-pushout.node.test.ts, tests/unit/tools/soak-penetration), a capsule standing inside a fixed
//    cuboid or a kinematic capsule is taken out in one call (the whole depth plus the offset, 2-30 cm pinned; 0.6 m took two
//    calls, 0.475 m and the rest) when the call asks for NO translation; asked for the game's grounded move (velocity × dt
//    with gravity in it, every tick of every live script), it is not moved out at all, standing still or walking along.
//    Characters in contact are out of the controller's sight here (5), so that path never sees them anyway. The port adds
//    the push-out the design prepared for character pairs
//    (motion §5.4 step 3, risk §11), and for them alone: `pushOut` takes defaults.KCC_PUSH_OUT_SHARE (half) of the overlap
//    of each character the body stands inside, side by side, along the line between the two axes (the contact normal of
//    two upright capsules whose straight parts share a height; Rapier's `contactCollider` answers distance 0 with no
//    usable normal for two capsules on one spot), capped at defaults.KCC_PUSH_OUT_MAX per tick, from the places of the
//    last step (both of a pair push themselves, so it does not matter which moves first). It goes through the controller,
//    so walls, doors and the characters beside the body stop it and nobody is pushed into geometry: laid on the game's
//    move once that move's advance on the characters it touches is taken out (5), one call for both; or, when a character
//    in contact but not inside lies in its way (out of that call's sight, 5), as a move of its own first (step 0b) with
//    only the characters the body stands inside and those it leads away from out of sight. A separate call for every push
//    cost about 1.3 ms more controller time per tick on the 36-character grimland-park bench; the shared call about 0.5-0.8
//    (a busy host: noisy). Counted there, the push-out itself is almost free (per tick 0.04 of the 36 moves carry a push,
//    0.002 make a call of their own for it): that difference is the bench's changed trajectory, two bodies that then stand where
//    the controller spins out its 20 iterations every tick (2.3 exhausted calls per tick instead of 0.4). A body spawned or
//    teleported this tick is not in the broad phase the queries read yet (world.ts), so in that one tick a third character
//    beside it does not stop its push; the next tick's push-out takes the two apart again. Overlaps up to
//    defaults.KCC_PUSH_OUT_SLOP are left alone. The push is part of the realised movement (and so of the velocity read
//    back), as a platform carry is.
// 8. A body that is stuck asks the same thing every tick, and the controller answers with the same spun-out 20 iterations
//    every tick (two bots on the grimland-park bench, one on a 31° slope with gravity alone asked and one standing in a
//    two-sided wall: 1.8-2.8 ms per call, most of that map's controller time). kcc-memo.ts answers a spun-out call again from
//    its record when every input of the new call is provably the recorded one, the broad phase's visiting order included;
//    any doubt is a real call. Every answer is read back through the `MoveView` that `controllerMove` returns, never from
//    the controller itself (controllers are shared by parameter set, and a memo hit does not touch it).
import type { CharacterCollision, Collider, KinematicCharacterController, RigidBody, World } from '@dimforge/rapier3d-simd-compat';
import {
  KCC_CREASE_MIN_MOVE, KCC_CREASE_MIN_SIN2, KCC_DROPPED_SLIDE_SHARE, KCC_GROUND_FOLLOW, KCC_LEAVE_COS, KCC_LEVEL_GROUND_NY, KCC_MAX_ITERATIONS,
  KCC_OVERLAP_ADVANCE_EPS, KCC_OVERLAP_IGNORE_DEPTH, KCC_MAX_RESUMES, KCC_PUSH_OUT_MAX, KCC_PUSH_OUT_SHARE, KCC_PUSH_OUT_SLOP,
  KCC_RESUME_MIN_SHIFT, kccKey, type KccParams,
} from '../defaults.ts';
import { beginMoves, controllerMove, type MoveFilter } from './kcc-memo.ts';
import type { Rapier } from './loader.ts';
import type { PhysicsWorld } from './world.ts';

export type { KccParams } from '../defaults.ts';

export interface Vec3 { x: number; y: number; z: number }
export interface Quat { x: number; y: number; z: number; w: number }

/** a character in a PhysicsWorld: Rapier body (origin = feet) + capsule collider + the port's per-body state */
export interface CharacterBody {
  /** spawn order inside its world: characters move in this order (determinism, motion §5.3) */
  readonly serial: number;
  readonly rowId: string | null;
  readonly body: RigidBody;
  readonly collider: Collider;
  params: KccParams;
  controller: KinematicCharacterController;
  /** packed `InteractionGroups`: the collider's and the controller's `filterGroups` (D-MPN-09) */
  groups: number;
  /** capsule: total height feet → top, radius (world units) */
  height: number;
  radius: number;
  /** false while spectating: the collider is disabled and the body is not moved */
  enabled: boolean;
  /** feet position after the last step (the Rapier body translation) */
  readonly feet: Vec3;
  /** written by the game: the velocity it wants for the next step */
  readonly desiredVelocity: Vec3;
  /** what the body did in the last step (world.ts `step`): carry included, teleports excluded */
  readonly velocity: Vec3;
  /** `computedGrounded()` of the last move */
  grounded: boolean;
  /** rigid-body handle of the kinematic body it stood on in the last move, or -1 */
  groundBody: number;
  /** normal of the walkable ground under it after the last move; (0, 1, 0) when airborne or unknown */
  readonly groundNormal: Vec3;
  /** collisions reported by the last move */
  hits: number;
  /** the characters in contact with it, side by side: closer than defaults.KCC_TOUCH_GAP, inside it included (world.ts finds them before the pass; header, 5) */
  readonly touching: CharacterBody[];
  /** the characters beside it that are not in contact: the gap from KCC_TOUCH_GAP up to defaults.KCC_NEAR_RANGE (header, 5) */
  readonly near: CharacterBody[];
  /** feet target of the running step (world.ts commits it over the substeps) */
  readonly target: Vec3;
  /** opt-in: this character's move is swept against the other characters (kcc-ccd.ts); unset = false */
  continuous?: boolean;
}

export interface KccInput {
  body: CharacterBody;
  /** velocity × dt; the game integrates gravity itself */
  desired: Vec3;
  dt: number;
}

export interface KccResult {
  translation: Vec3;
  grounded: boolean;
  /** kinematic ground body handle for the next tick's carry, or -1 */
  groundBody: number;
  /** walkable ground normal of this move, (0, 1, 0) when there is none */
  groundNormal: Vec3;
  hits: number;
}

export const kccResult = (): KccResult => ({
  translation: { x: 0, y: 0, z: 0 }, grounded: false, groundBody: -1, groundNormal: { x: 0, y: 1, z: 0 }, hits: 0,
});

/** a controller for one parameter set (motion §4.2 table), up +Y */
export function createController(raw: World, p: Readonly<KccParams>): KinematicCharacterController {
  const c = raw.createCharacterController(p.offset);
  c.setUp({ x: 0, y: 1, z: 0 });
  if (p.autostep) c.enableAutostep(p.autostep.maxHeight, p.autostep.minWidth, p.autostep.includeDynamic); else c.disableAutostep();
  c.setMaxSlopeClimbAngle(p.maxSlopeClimb);
  c.setMinSlopeSlideAngle(p.minSlopeSlide);
  if (p.snapToGround !== null) c.enableSnapToGround(p.snapToGround); else c.disableSnapToGround();
  c.setSlideEnabled(p.slide);
  c.setNormalNudgeFactor(p.normalNudge);
  // unused live: the character's mass is its body's and it pushes nothing through the controller (motion §4.2)
  c.setCharacterMass(null);
  c.setApplyImpulsesToDynamicBodies(false);
  return c;
}

/** the controllers of one world, one per distinct parameter set */
export class ControllerCache {
  private readonly byKey = new Map<string, KinematicCharacterController>();
  private readonly raw: World;
  constructor(raw: World) { this.raw = raw; }

  get size(): number { return this.byKey.size; }

  for(p: Readonly<KccParams>): KinematicCharacterController {
    const key = kccKey(p);
    let c = this.byKey.get(key);
    if (!c) {
      c = createController(this.raw, p);
      this.byKey.set(key, c);
    }
    return c;
  }

  free(): void {
    for (const c of this.byKey.values()) this.raw.removeCharacterController(c);
    this.byKey.clear();
  }
}

// ── the move ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

const D: Vec3 = { x: 0, y: 0, z: 0 };
const M: Vec3 = { x: 0, y: 0, z: 0 };
const CARRY: Vec3 = { x: 0, y: 0, z: 0 };
/** the horizontal part of the last `moveOnce` that was the platform's carry, not the body's own move */
const CARRIED = { x: 0, z: 0 };
/** the push-out of the running `moveCharacter` (header, 7): asked, and what the controller let of it in the last `moveOnce` */
const PUSH = { x: 0, z: 0 };
const PUSHED = { x: 0, z: 0 };
/** the golden angle (rad): two characters on one spot part along a direction of their serials, every pair its own (header, 7) */
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
/** the last collision of a controller call: normal, translation applied before it, translation remaining at it */
const LN: Vec3 = { x: 0, y: 1, z: 0 };
const LA: Vec3 = { x: 0, y: 0, z: 0 };
const LR: Vec3 = { x: 0, y: 0, z: 0 };
/** normal of the last collision of an exhausted call (LN is then the first one's) */
const L2: Vec3 = { x: 0, y: 1, z: 0 };
/** collider handles the running move passes through */
const THROUGH: number[] = [];
/** the overlapping characters the running move may not advance on */
const BLOCKERS: CharacterBody[] = [];
const passThrough: MoveFilter = { byHandle: (h) => !THROUGH.includes(h), byCollider: (other) => !THROUGH.includes(other.handle) };
/** collider handles the push-out of the running move passes through (header, 7) */
const PUSH_THROUGH: number[] = [];
const pushThrough: MoveFilter = { byHandle: (h) => !PUSH_THROUGH.includes(h), byCollider: (other) => !PUSH_THROUGH.includes(other.handle) };

let COLLISION: CharacterCollision | null = null;
let COLLISION_OF: Rapier | null = null;

function collisionScratch(R: Rapier): CharacterCollision {
  if (COLLISION_OF !== R || !COLLISION) {
    COLLISION = new R.CharacterCollision();
    COLLISION_OF = R;
  }
  return COLLISION;
}

/**
 * One character, one tick: `out.translation` is how far the feet may go for `inp.desired` (+ the platform carry).
 * Nothing is written to the body; world.ts commits the move. An unbuilt world or a disabled body holds still (X-32).
 */
export function moveCharacter(world: PhysicsWorld, inp: KccInput, out: KccResult): void {
  const c = inp.body;
  beginMoves(c);
  pushOut(c, PUSH);
  moveOnce(world, inp, out, true);
  if (c.touching.length === 0 && c.near.length === 0) return;
  // The controller's own slide (off a wall, off a third body it touches) can turn a move into a character its cast did
  // not see (header, 5). What counts is the body's own move: the carry of a platform takes its riders along together, and
  // the push-out (7) is the pair's, not an advance of the body.
  const tx = out.translation.x - CARRIED.x - PUSHED.x, tz = out.translation.z - CARRIED.z - PUSHED.z;
  // one the body is in contact with: it holds its ground this tick (the move is asked again without its horizontal part)
  for (const o of c.touching) {
    const ox = c.feet.x - o.feet.x, oz = c.feet.z - o.feet.z;
    const d2 = ox * ox + oz * oz;
    const deep = c.radius + o.radius - KCC_OVERLAP_IGNORE_DEPTH;
    if (!(d2 > 1e-12) || (deep > 0 && d2 < deep * deep)) continue;
    if (tx * ox + tz * oz < -KCC_OVERLAP_ADVANCE_EPS * Math.sqrt(d2)) {
      const x = inp.desired.x, z = inp.desired.z;
      inp.desired.x = 0; inp.desired.z = 0;
      moveOnce(world, inp, out, true);
      inp.desired.x = x; inp.desired.z = z;
      return;
    }
  }
  // one beside it that the move was to lead away from: asked again with every character beside it in the controller's sight
  for (const o of c.near) {
    const ox = c.feet.x - o.feet.x, oz = c.feet.z - o.feet.z;
    const ex = ox + tx, ez = oz + tz;
    const reach = c.radius + o.radius + c.params.offset / 2;
    const e2 = ex * ex + ez * ez;
    // it ended closer to it than it was, and closer than the controller would have let it
    if (e2 < reach * reach && Math.sqrt(e2) < Math.sqrt(ox * ox + oz * oz) - KCC_OVERLAP_ADVANCE_EPS) {
      moveOnce(world, inp, out, false);
      return;
    }
  }
}

/**
 * The push-out of character `c` for this tick (header, 7), horizontal, into `out`: for every character it stands inside
 * (`touching`, side by side, so the straight parts of the two upright capsules share a height and the contact normal is the
 * horizontal line between their axes), `KCC_PUSH_OUT_SHARE` of the overlap beyond `KCC_PUSH_OUT_SLOP`, away from it. The
 * sum is capped at `KCC_PUSH_OUT_MAX`. Read from the places of the last step only, so it does not depend on which body of
 * a pair moves first.
 */
export function pushOut(c: Readonly<CharacterBody>, out: { x: number; z: number }): void {
  out.x = 0; out.z = 0;
  if (!(KCC_PUSH_OUT_MAX > 0) || !c.enabled) return;
  for (const o of c.touching) {
    const ox = c.feet.x - o.feet.x, oz = c.feet.z - o.feet.z;
    const reach = c.radius + o.radius;
    const d2 = ox * ox + oz * oz;
    if (!(d2 < reach * reach)) continue;
    const d = Math.sqrt(d2);
    const depth = reach - d;
    if (depth <= KCC_PUSH_OUT_SLOP) continue;
    const k = KCC_PUSH_OUT_SHARE * depth;
    if (d > 1e-6) {
      out.x += (ox / d) * k; out.z += (oz / d) * k;
    } else {
      // on one spot the pair has no line between them: one direction per pair from the two serials, the lower serial
      // along it and the higher against it
      const a = (Math.min(c.serial, o.serial) + 2 * Math.max(c.serial, o.serial)) * GOLDEN_ANGLE;
      const s = c.serial < o.serial ? k : -k;
      out.x += Math.cos(a) * s; out.z += Math.sin(a) * s;
    }
  }
  const m2 = out.x * out.x + out.z * out.z;
  if (m2 > KCC_PUSH_OUT_MAX * KCC_PUSH_OUT_MAX) {
    const f = KCC_PUSH_OUT_MAX / Math.sqrt(m2);
    out.x *= f; out.z *= f;
  }
}

/** `leave`: a character beside the body that the move leads away from is kept out of the controller's sight (header, 5) */
function moveOnce(world: PhysicsWorld, inp: KccInput, out: KccResult, leave: boolean): void {
  const c = inp.body;
  const t = out.translation;
  const gn = out.groundNormal;
  t.x = 0; t.y = 0; t.z = 0;
  gn.x = 0; gn.y = 1; gn.z = 0;
  out.grounded = false;
  out.groundBody = -1;
  out.hits = 0;
  CARRIED.x = 0; CARRIED.z = 0;
  PUSHED.x = 0; PUSHED.z = 0;
  if (!world.built || !c.enabled) return;

  let dx = inp.desired.x, dy = inp.desired.y, dz = inp.desired.z;
  const cosClimb = Math.cos(c.params.maxSlopeClimb);
  // ground follow (header, 4): only for a body on walkable, sloped ground whose script asks for no rise
  let followed = false;
  if (KCC_GROUND_FOLLOW && c.grounded && dy <= 0) {
    const n = c.groundNormal;
    if (n.y >= cosClimb && n.y < KCC_LEVEL_GROUND_NY) {
      // the vector on the ground plane with the horizontal part asked for, plus the script's vertical part as pressure
      const rise = -(dx * n.x + dz * n.z) / n.y;
      const press = dy * n.y;
      dx += press * n.x; dz += press * n.z; dy = rise + press * n.y;
      followed = true;
    }
  }
  const flags = world.kccFlags;
  const R = world.R;
  // the cases with a filter predicate (header, 5): a body in contact with another character, or leaving one beside it. A body
  // with nobody within reach passes none.
  let through: MoveFilter | undefined;
  let ownPush = false;
  if (c.touching.length > 0 || (leave && c.near.length > 0)) {
    THROUGH.length = 0;
    let blockers = 0;
    for (const o of c.touching) {
      const ox = c.feet.x - o.feet.x, oz = c.feet.z - o.feet.z;
      const d2 = ox * ox + oz * oz;
      const deep = c.radius + o.radius - KCC_OVERLAP_IGNORE_DEPTH;
      // deep inside: never blocking. Otherwise it blocks the advance on it and nothing else, and it does so HERE (header, 5)
      if (d2 > 1e-12 && !(deep > 0 && d2 < deep * deep)) BLOCKERS[blockers++] = o;
      THROUGH.push(o.collider.handle);
    }
    // The asked move may advance on none of them. If it does, it keeps what one of them leaves of it (the part along that
    // one), provided the others let that through: the longest such part. Wedged between two, nothing is left.
    let free = true;
    for (let i = 0; i < blockers && free; i++) {
      const o = BLOCKERS[i]!;
      free = dx * (c.feet.x - o.feet.x) + dz * (c.feet.z - o.feet.z) >= 0;
    }
    if (!free) {
      let bx = 0, bz = 0, best = 0;
      for (let i = 0; i < blockers; i++) {
        const o = BLOCKERS[i]!;
        const ox = c.feet.x - o.feet.x, oz = c.feet.z - o.feet.z;
        const toward = dx * ox + dz * oz;
        if (toward >= 0) continue;
        const k = toward / (ox * ox + oz * oz);
        const px = dx - k * ox, pz = dz - k * oz;
        const p2 = px * px + pz * pz;
        if (p2 <= best) continue;
        let ok = true;
        for (let j = 0; j < blockers && ok; j++) {
          if (j === i) continue;
          const q = BLOCKERS[j]!;
          const qx = c.feet.x - q.feet.x, qz = c.feet.z - q.feet.z;
          ok = px * qx + pz * qz >= -1e-9 * Math.sqrt(p2 * (qx * qx + qz * qz));
        }
        if (ok) { bx = px; bz = pz; best = p2; }
      }
      dx = bx; dz = bz;
    }
    BLOCKERS.length = 0;
    // the push-out (header, 7), laid on the move that is left: one controller call for both, which sees what the move
    // sees (walls, doors, characters beside the body). Only a character in contact but not inside, in the way of the
    // push, is out of that call's sight: then the push is a call of its own (step 0b) that sees it.
    if (PUSH.x !== 0 || PUSH.z !== 0) {
      let clear = true;
      for (const o of c.touching) {
        const ox = c.feet.x - o.feet.x, oz = c.feet.z - o.feet.z, reach = c.radius + o.radius;
        if (ox * ox + oz * oz >= reach * reach && PUSH.x * ox + PUSH.z * oz < 0) { clear = false; break; }
      }
      // (a nudge up with it, as for every call of the port that starts on the ground: from a pose touching the floor with
      // no gap, a level ask with no vertical part was measured to sink the capsule 2 cm into a box floor)
      if (clear) { dx += PUSH.x; dz += PUSH.z; dy += Math.max(c.params.normalNudge, 1e-4); PUSHED.x = PUSH.x; PUSHED.z = PUSH.z; } else ownPush = true;
    }
    // a character it merely touches blocks the advance on it, which is the controller's to do; a move that leads away
    // from it is none of its business (one that runs along it stays in sight: the controller may turn it either way)
    if (leave) {
      const lead = KCC_LEAVE_COS * Math.sqrt(dx * dx + dz * dz);
      for (const o of c.near) {
        const ox = c.feet.x - o.feet.x, oz = c.feet.z - o.feet.z;
        if (lead > 0 && dx * ox + dz * oz > lead * Math.sqrt(ox * ox + oz * oz)) THROUGH.push(o.collider.handle);
      }
    }
    if (THROUGH.length > 0) through = passThrough;
  }
  let ground = -1;
  let sawGround = false;
  let grounded = false;
  let hits = 0;
  let shifted = false;
  // 0. platform carry: the rigid displacement of the feet under the ground body's move of this tick. It is a move of its
  // own, asked a nudge above the platform so that the cast leaves the surface it rides on (header, 3) and only a real
  // obstacle stops it; the game's own move then starts from the carried pose.
  const platforms = world.kinematicCount > 0;
  if (c.groundBody >= 0) {
    const kb = world.kinematicByHandle(c.groundBody);
    if (kb && world.carryOf(kb, c.feet, CARRY)) {
      D.x = CARRY.x; D.y = CARRY.y + Math.max(c.params.normalNudge, 1e-4); D.z = CARRY.z;
      const res = controllerMove(R, c, D, flags, c.groups, through);
      res.movement(M);
      const n = res.count();
      hits += n;
      // a loop that spun out on the platform itself (header, 3) says nothing about obstacles: the rider goes with its ground.
      // The same holds when every hit of the carry was the platform (PH3: a collider seated off its body's origin, which
      // every box-key platform is, puts a float32 of noise between the two poses, and one carry in about a thousand grazed
      // the surface it rides on and was cut to 40 %): the ground cannot stop the rider it carries.
      let own = n >= KCC_MAX_ITERATIONS;
      if (!own && n > 0) {
        own = true;
        const scratch = collisionScratch(R);
        for (let i = 0; i < n && own; i++) own = res.collision(i, scratch)?.collider?.parent()?.handle === c.groundBody;
      }
      if (own) { M.x = CARRY.x; M.y = CARRY.y; M.z = CARRY.z; }
      t.x += M.x; t.y += M.y; t.z += M.z;
      CARRIED.x = M.x; CARRIED.z = M.z;
      world.shiftCharacterCollider(c, t);
      shifted = true;
    }
  }
  // 0b. push-out (header, 7) when a character in contact (not inside) is in its way, so the push cannot ride on the move
  // (above): a move of its own through the controller, a nudge up so that the cast leaves the ground, with the characters
  // the body stands inside out of sight, and those the push leads away from (the glue of 2), and everything else in it: a
  // wall, a door or a third character in contact or beside the body stops the push as it stops a walk. The game's move
  // then starts from the pushed pose.
  if (ownPush) {
    PUSH_THROUGH.length = 0;
    const lead = KCC_LEAVE_COS * Math.sqrt(PUSH.x * PUSH.x + PUSH.z * PUSH.z);
    for (let k = 0; k < 2; k++) {
      for (const o of k === 0 ? c.touching : c.near) {
        const ox = c.feet.x - o.feet.x, oz = c.feet.z - o.feet.z;
        const d2 = ox * ox + oz * oz, reach = c.radius + o.radius;
        if (d2 < reach * reach || PUSH.x * ox + PUSH.z * oz > lead * Math.sqrt(d2)) PUSH_THROUGH.push(o.collider.handle);
      }
    }
    D.x = PUSH.x; D.y = Math.max(c.params.normalNudge, 1e-4); D.z = PUSH.z;
    const res = controllerMove(R, c, D, flags, c.groups, PUSH_THROUGH.length > 0 ? pushThrough : undefined);
    res.movement(M);
    hits += res.count();
    t.x += M.x; t.y += M.y; t.z += M.z;
    PUSHED.x = M.x; PUSHED.z = M.z;
    world.shiftCharacterCollider(c, t);
    shifted = true;
  }
  let creased = false;
  let rescue = false, groundedBefore = false;
  for (let attempt = 0; ; attempt++) {
    D.x = dx; D.y = dy; D.z = dz;
    // 1. move
    const res = controllerMove(R, c, D, flags, c.groups, through);
    // 2. read back
    res.movement(M);
    const n = res.count();
    hits += n;
    const scratch = collisionScratch(R);
    if (rescue) {
      rescue = false;
      // The rest of a dropped walk was asked again. If it starts ON a kinematic body beside the character (a door, a
      // character not yet in contact), going into it is what the controller had refused: its first answer stands.
      // Otherwise the way was open and the controller had dropped it for nothing (header, 2). A platform underfoot is
      // ground, not an obstacle.
      let refused = false;
      for (let i = 0; i < n && !refused; i++) {
        const col = res.collision(i, scratch);
        if (!col) continue;
        const a = col.translationDeltaApplied;
        if (a.x * a.x + a.y * a.y + a.z * a.z > KCC_RESUME_MIN_SHIFT * KCC_RESUME_MIN_SHIFT) break;
        refused = col.normal1.y < cosClimb && col.collider?.parent()?.isKinematic() === true;
      }
      if (refused) { grounded = groundedBefore; break; }
    }
    grounded = res.grounded();
    t.x += M.x; t.y += M.y; t.z += M.z;
    if (n === 0) break;
    const exhausted = n >= KCC_MAX_ITERATIONS;
    L2.x = 0; L2.y = 0; L2.z = 0;
    let fixedPair = true;
    let onlyGround = true;
    // an exhausted loop repeats one hit, and what it kept of the move after the first one is noise: the first and the last
    // hit say everything, and the resume starts from the first
    for (let i = 0; i < n; i = exhausted && i === 0 ? n - 1 : i + 1) {
      const col = res.collision(i, scratch);
      if (!col) continue;
      const nrm = col.normal1;
      if (i === (exhausted ? 0 : n - 1)) {
        const r = col.translationDeltaRemaining, a = col.translationDeltaApplied;
        LN.x = nrm.x; LN.y = nrm.y; LN.z = nrm.z;
        LA.x = a.x; LA.y = a.y; LA.z = a.z;
        LR.x = r.x; LR.y = r.y; LR.z = r.z;
      }
      if (exhausted) {
        // the static colliders of a place have no rigid body; a platform or another character has one
        if (col.collider?.parent()) fixedPair = false;
        if (i === n - 1) { L2.x = nrm.x; L2.y = nrm.y; L2.z = nrm.z; }
      }
      if (nrm.y < cosClimb) { onlyGround = false; continue; }
      // walkable ground: the latest such hit is where the body ends up standing
      sawGround = true;
      gn.x = nrm.x; gn.y = nrm.y; gn.z = nrm.z;
      if (platforms && ground < 0 && col.collider) {
        const parent = col.collider.parent();
        if (parent && world.kinematicByHandle(parent.handle)) ground = parent.handle;
      }
    }
    if (attempt >= KCC_MAX_RESUMES) break;
    // resume a dropped move (header, 2 and 3)
    const nudge = Math.max(c.params.normalNudge, 1e-4);
    let crease = false;
    if (exhausted) {
      // back to where the first hit happened
      t.x += LA.x - M.x; t.y += LA.y - M.y; t.z += LA.z - M.z;
      if (fixedPair) {
        // spun out between two static surfaces (header, 6): the only way on is along the line they share, asked once
        if (creased) break;
        const cx = LN.y * L2.z - LN.z * L2.y, cy = LN.z * L2.x - LN.x * L2.z, cz = LN.x * L2.y - LN.y * L2.x;
        const c2 = cx * cx + cy * cy + cz * cz;
        if (c2 > KCC_CREASE_MIN_SIN2) {
          const m = (LR.x * cx + LR.y * cy + LR.z * cz) / c2;
          // nothing to gain along it (an inside corner the body is pressed into): blocked, and no further call
          if (m * m * c2 < KCC_CREASE_MIN_MOVE * KCC_CREASE_MIN_MOVE) break;
          dx = cx * m + nudge * (LN.x + L2.x);
          dy = cy * m + nudge * (LN.y + L2.y);
          dz = cz * m + nudge * (LN.z + L2.z);
          crease = true;
          creased = true;
        } else if (LN.x * L2.x + LN.y * L2.y + LN.z * L2.z < 0) {
          // opposite normals: the capsule stands IN a two-sided surface (spawned or teleported into a trimesh wall).
          // Whatever is asked spins the same way; it is paid once per tick, not three times.
          break;
        }
      }
    } else {
      // Every hit of the call was walkable ground, and yet the controller delivered less than the walk asked: nothing it
      // reported stood in the way (header, 2). The missing part is asked again, as a trial (see the top of the loop). On
      // sloped ground only for a move that was laid along the ground (4): there the walk is known, with no downhill part
      // of gravity in it.
      if (!onlyGround) break;
      let rx: number, ry: number, rz: number;
      if (gn.y >= KCC_LEVEL_GROUND_NY) {
        // level ground (to 1.8°: cast normals carry noise near triangle edges): the walk is the horizontal part
        const w2 = D.x * D.x + D.z * D.z;
        if (!(w2 > 1e-10) || M.x * D.x + M.z * D.z >= KCC_DROPPED_SLIDE_SHARE * w2) break;
        rx = D.x - M.x; ry = 0; rz = D.z - M.z;
      } else if (followed) {
        // the walk in the ground plane (the pressure onto it taken out), and what was moved of it
        const dn = D.x * gn.x + D.y * gn.y + D.z * gn.z, mn = M.x * gn.x + M.y * gn.y + M.z * gn.z;
        const wx = D.x - dn * gn.x, wy = D.y - dn * gn.y, wz = D.z - dn * gn.z;
        const mx = M.x - mn * gn.x, my = M.y - mn * gn.y, mz = M.z - mn * gn.z;
        const w2 = wx * wx + wz * wz;
        // from a millimetre on: the pressure of a standing body leaves micrometres of walk on a noisy normal
        if (!(w2 > 1e-6) || mx * wx + mz * wz >= KCC_DROPPED_SLIDE_SHARE * w2) break;
        rx = wx - mx; ry = wy - my; rz = wz - mz;
      } else break;
      // The advance on a character the body touches is what the controller refused, rightly and without saying so: that
      // part is not asked again (a crowd pressing on one body would pay a second, spun-out call per body and tick).
      for (const o of c.near) {
        const ox = c.feet.x - o.feet.x, oz = c.feet.z - o.feet.z;
        const adv = rx * ox + rz * oz;
        if (adv < 0) { const k = adv / (ox * ox + oz * oz); rx -= k * ox; rz -= k * oz; }
      }
      if (rx * rx + rz * rz < KCC_CREASE_MIN_MOVE * KCC_CREASE_MIN_MOVE) break;
      dx = rx + nudge * gn.x; dy = ry + nudge * gn.y; dz = rz + nudge * gn.z;
      crease = true;
      rescue = true;
      groundedBefore = grounded;
    }
    if (!crease) {
      // the controller's own slide: drop the part going into the surface, keep the rest, nudge off the surface
      const into = Math.min(0, LR.x * LN.x + LR.y * LN.y + LR.z * LN.z);
      dx = LR.x - into * LN.x + nudge * LN.x;
      dy = LR.y - into * LN.y + nudge * LN.y;
      dz = LR.z - into * LN.z + nudge * LN.z;
    }
    if (dx * dx + dy * dy + dz * dz < 4 * nudge * nudge) break;
    // the next call starts where this one stopped
    if (t.x * t.x + t.y * t.y + t.z * t.z > KCC_RESUME_MIN_SHIFT * KCC_RESUME_MIN_SHIFT) {
      world.shiftCharacterCollider(c, t);
      shifted = true;
    }
  }

  // ground follow carried the body up past the end of its slope: set it down again if ground is within the snap distance
  if (followed && !grounded && t.y > 0 && c.params.snapToGround !== null) {
    world.shiftCharacterCollider(c, t);
    shifted = true;
    D.x = 0; D.y = -(t.y + c.params.snapToGround); D.z = 0;
    const res = controllerMove(R, c, D, flags, c.groups, through);
    if (res.grounded() && res.count() > 0) {
      res.movement(M);
      t.x += M.x; t.y += M.y; t.z += M.z;
      grounded = true;
      const col = res.collision(0, collisionScratch(R));
      if (col && col.normal1.y >= cosClimb) {
        sawGround = true;
        gn.x = col.normal1.x; gn.y = col.normal1.y; gn.z = col.normal1.z;
        const parent = platforms && col.collider ? col.collider.parent() : null;
        if (parent && world.kinematicByHandle(parent.handle)) ground = parent.handle;
      }
    }
  }
  if (shifted) world.shiftCharacterCollider(c, null);

  if (grounded && !sawGround) {
    // a grounded move without a ground hit (no downward part in `desired`): keep the normal, find the platform by a ray
    gn.x = c.groundNormal.x; gn.y = c.groundNormal.y; gn.z = c.groundNormal.z;
    if (platforms) ground = world.probeGround(c);
  } else if (!grounded) {
    gn.x = 0; gn.y = 1; gn.z = 0;
  }
  out.grounded = grounded;
  out.groundBody = grounded ? ground : -1;
  out.hits = hits;
}
