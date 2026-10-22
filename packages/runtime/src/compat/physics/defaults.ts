// Engine body defaults (motion §4.2, D-MPN-08), collision groups packed as Rapier `InteractionGroups` (D-MPN-09) and the
// constants that decide how the port drives Rapier's character controller (motion §5.4). No Rapier value import: enum values
// are named here and read from the loaded namespace (D-MPN-10).
//
// D-MPN-08: an unset character option gets Spawn's working value, NOT Rapier's JS default (autostep and snap are off there,
// so engine movement retains its configured kerb stepping).

export const DEG = Math.PI / 180;

/** Rapier 0.21 `ColliderDesc` / `RigidBodyDesc` defaults; friction and restitution combine by average */
export const BODY_DEFAULTS = {
  friction: 0.5,
  restitution: 0,
  linearDamping: 0,
  angularDamping: 0,
  gravityScale: 1,
} as const;

/** Standard gravity; place configuration overrides it. */
export const DEFAULT_GRAVITY = { x: 0, y: -9.81, z: 0 } as const;
/** the world steps twice per 30 Hz tick (motion §5.3) */
export const SUBSTEP_DT = 1 / 60;
export const SUBSTEPS = 2;
/**
 * Timestep (s) of the refresh step that publishes new and moved colliders to the queries (world.ts `refresh`). Motion §4.3
 * prescribes exactly 0, and on a fresh world that works. Measured on 0.21: once a collider was removed and the world
 * stepped, a step of exactly 0 after adding one leaves the query structure empty until the next real step (every ray
 * misses, the floor included; 108 of 168 remove / step / add histories on stock Rapier). A nanosecond does not (0 of 168),
 * moves nothing (a body at 100 m/s goes 0.1 µm) and changed the velocity of resting and falling dynamic balls by under
 * 0.5 mm/s.
 */
export const REFRESH_DT = 1e-9;

// ── collision groups ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface CollisionGroups { membership: number; filter: number }

export const GROUP_ALL = 0xffff;
/** characters are members of this group only (D-MPN-09), so `{0x0008, 0xfffb}` gibs never touch them (`scripts/gore/gore.js:499`) */
export const GROUP_CHARACTER = 0x0004;
export const DEFAULT_GROUPS: Readonly<CollisionGroups> = { membership: GROUP_ALL, filter: GROUP_ALL };
export const CHARACTER_GROUPS: Readonly<CollisionGroups> = { membership: GROUP_CHARACTER, filter: GROUP_ALL };

/** `(membership << 16) | filter`, both 16-bit: the value of `ColliderDesc.setCollisionGroups` and of every `filterGroups` */
export function packGroups(membership: number, filter: number): number {
  return (((membership & 0xffff) << 16) | (filter & 0xffff)) >>> 0;
}
export const packCollisionGroups = (g: Readonly<CollisionGroups>): number => packGroups(g.membership, g.filter);
export function unpackGroups(packed: number): CollisionGroups {
  return { membership: (packed >>> 16) & 0xffff, filter: packed & 0xffff };
}
/** Rapier's rule: two colliders interact when each one's membership meets the other's filter */
export function groupsInteract(a: number, b: number): boolean {
  return (((a >>> 16) & b) & 0xffff) !== 0 && (((b >>> 16) & a) & 0xffff) !== 0;
}
export const PACKED_DEFAULT_GROUPS = packCollisionGroups(DEFAULT_GROUPS);
export const PACKED_CHARACTER_GROUPS = packCollisionGroups(CHARACTER_GROUPS);

// ── character controller ─────────────────────────────────────────────────────────────────────────────────────────────────

/** one controller parameter set (motion §4.2); lengths are absolute metres, angles radians */
export interface KccParams {
  offset: number;
  autostep: { maxHeight: number; minWidth: number; includeDynamic: boolean } | null;
  maxSlopeClimb: number;
  minSlopeSlide: number;
  slide: boolean;
  snapToGround: number | null;
  normalNudge: number;
}

/** D-MPN-08: what a character gets when its `physics` sets nothing (enemies, bosses) */
export const KCC_DEFAULTS: Readonly<KccParams> = Object.freeze({
  offset: 0.01,
  autostep: Object.freeze({ maxHeight: 0.4, minWidth: 0.2, includeDynamic: false }),
  maxSlopeClimb: 45 * DEG,
  minSlopeSlide: 45 * DEG,
  slide: true,
  snapToGround: 0.3,
  normalNudge: 1e-4,
});

/** the defaults with a spec's own values on top (degrees are converted by the caller, `spec.ts`) */
export function kccParams(over: Partial<KccParams> = {}): KccParams {
  const autostep = over.autostep === undefined ? KCC_DEFAULTS.autostep : over.autostep;
  return {
    ...KCC_DEFAULTS,
    ...over,
    autostep: autostep ? { ...autostep } : null,
  };
}

/** stable identity of a parameter set: characters with equal keys share one Rapier controller */
export function kccKey(p: Readonly<KccParams>): string {
  const a = p.autostep;
  return [
    p.offset, a ? `${a.maxHeight}/${a.minWidth}/${a.includeDynamic ? 1 : 0}` : '-', p.maxSlopeClimb, p.minSlopeSlide,
    p.slide ? 1 : 0, p.snapToGround ?? '-', p.normalNudge,
  ].join('|');
}

/** capsule radius when a character names none (`sk/geometry:30`: a 1.9 × 0.7 body) */
export const DEFAULT_CAPSULE_RADIUS = 0.35;

/** total height (feet → top) and radius → Rapier's capsule half segment, clamped at a sphere (motion §4.2) */
export function capsuleHalfSegment(height: number, radius: number): number {
  return Math.max(0, height / 2 - radius);
}

export type QueryFlagName =
  | 'EXCLUDE_FIXED' | 'EXCLUDE_KINEMATIC' | 'EXCLUDE_DYNAMIC' | 'EXCLUDE_SENSORS' | 'EXCLUDE_SOLIDS'
  | 'ONLY_DYNAMIC' | 'ONLY_KINEMATIC' | 'ONLY_FIXED';

/**
 * What the controller ignores (motion §5.4): triggers, and dynamic bodies (debris must not snag walking; characters shove
 * them through the solver instead). "Dynamic bodies are obstacles" is this one constant without EXCLUDE_DYNAMIC.
 */
export const KCC_QUERY_FLAGS: readonly QueryFlagName[] = ['EXCLUDE_SENSORS', 'EXCLUDE_DYNAMIC'];

/** names → the loaded namespace's `QueryFilterFlags` bits */
export function queryFlags(flags: Readonly<Record<QueryFlagName, number>>, names: readonly QueryFlagName[]): number {
  let bits = 0;
  for (const n of names) bits |= flags[n];
  return bits;
}

/**
 * Lay a grounded character's horizontal move along the walkable ground it stands on (kcc.ts, header 4), so slopes up to
 * `maxSlopeClimb` are walked at the pace asked. false = Rapier's raw slide (cos²θ of the pace, less with the game's gravity).
 * [CAL M1: the live read-back / slope pace is not measured; this and KCC_REPORT_GROUND_RISE are the two wrapping choices.]
 */
export const KCC_GROUND_FOLLOW = true;
/** a ground normal with y above this (1.8°) is level ground: no ground follow, the controller is called as the game asked */
export const KCC_LEVEL_GROUND_NY = 0.9995;
/**
 * false: a character that ends the step on the ground reads back no more upward speed than its script asked for; the rise
 * of an autostep or of a climbed slope is the controller's doing. Every live script integrates `vy = v.y + g·dt` from the
 * read: with the literal movement / dt (true) a 0.39 m step-up read +11.7 m/s and threw the player 2.3 m into the air, and
 * every ramp ended in a hop.
 */
export const KCC_REPORT_GROUND_RISE = false;

/**
 * Characters whose capsules overlap horizontally by more than this (m) do not block each other at all (kcc.ts, header 5).
 * It must stay above the overlap two bodies reach by meeting within one tick, which is the slower body's move of that
 * tick less the offset (each moves against the other's place of the tick before). Measured head-on over 400 tick phases
 * with 3 s of pressing: 0.156 m at 5 + 5 m/s, 0.210 m at 6.6 + 6.6 (two sprinters) and at 12 + 6.6 (a charge into a
 * sprinter), 0.240 m at 7.5 + 7.5, and it does not grow while they press. Two bodies BOTH faster than 7.8 m/s can
 * therefore pass through each other (8 + 8 m/s: 10 of 400 phases, 9 + 9: 59, 12 + 12: 137).
 */
export const KCC_OVERLAP_IGNORE_DEPTH = 0.25;
/**
 * Two characters side by side are in contact when the gap between their capsules is under this (m), standing inside each
 * other included: from here on the port blocks them against each other itself and the controller does not see the other
 * one (kcc.ts, header 5). The controller stops a body one offset (1 cm) short of another, so a pair that met rests inside
 * this gap.
 */
export const KCC_TOUCH_GAP = 0.02;
/**
 * Two characters side by side with less than this gap (m) are beside each other (kcc.ts, header 5). Measured on stock
 * 0.21: a character cannot walk straight away from a kinematic body up to 5 cm beside it (0.01 m in 0.5 s where 2.5 m
 * were asked), from 8 cm on it is free.
 */
export const KCC_NEAR_RANGE = 0.08;
/**
 * A move leads away from a character beside the body when its horizontal part is within acos(this) = 75° of the line
 * straight away from it; only then is that character kept out of the controller's sight.
 */
export const KCC_LEAVE_COS = 0.25;
/** a finished move that advances more than this (m) on a character the body is in contact with is taken back (kcc.ts `moveCharacter`) */
export const KCC_OVERLAP_ADVANCE_EPS = 1e-4;
/**
 * Character push-out (kcc.ts, header 7; motion §5.4 step 3, risk §11): the most (m) one character is moved per tick out of
 * the characters it stands inside. 0 switches the push-out off.
 */
export const KCC_PUSH_OUT_MAX = 0.2;
/**
 * The share of a pair's overlap each of the two takes per tick. Both bodies of a pair push themselves, each from the other's
 * place of the last step (frozen snapshot, order-independent), so 0.5 closes the whole overlap in one tick when neither is
 * held by a wall or the cap.
 */
export const KCC_PUSH_OUT_SHARE = 0.5;
/** overlaps up to this (m) are left alone: a pair that met rests at contact, and float noise costs no controller call */
export const KCC_PUSH_OUT_SLOP = 0.001;

/** Rapier's `move_shape` gives up after this many cast-and-slide iterations and returns what it had */
export const KCC_MAX_ITERATIONS = 20;
/**
 * How often one move may be resumed after the controller dropped it (kcc.ts): 0 switches the recovery off and leaves
 * Rapier's raw answer.
 */
export const KCC_MAX_RESUMES = 2;
/**
 * A move counts as dropped after a ground hit when the controller then moved less than this share of its own slide of the
 * remainder (kcc.ts, header 2). 0.9 is where the first implementation stood; it is kept.
 */
export const KCC_DROPPED_SLIDE_SHARE = 0.9;
/** a resumed move starts from the pose the dropped call reached when that is further than this (m) from the start pose */
export const KCC_RESUME_MIN_SHIFT = 1e-4;
/**
 * An exhausted loop whose first and last hit normals differ by more than 1.8° (sin² above this) spun between two surfaces,
 * and is resumed along their common line (kcc.ts, header 6); below it the hits are one surface (a kinematic body, header 3).
 */
export const KCC_CREASE_MIN_SIN2 = 1e-3;
/** a remainder shorter than this (m) along that line is not worth a call: the body is blocked (an inside corner) */
export const KCC_CREASE_MIN_MOVE = 1e-3;

// ── static colliders ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type TriMeshFlagName =
  | 'DELETE_BAD_TOPOLOGY_TRIANGLES' | 'ORIENTED' | 'MERGE_DUPLICATE_VERTICES' | 'DELETE_DEGENERATE_TRIANGLES'
  | 'DELETE_DUPLICATE_TRIANGLES' | 'FIX_INTERNAL_EDGES' | 'FIX_INTERNAL_EDGES_TWO_SIDED';

/**
 * Flags of every trimesh collider. They only change the contact manifolds of dynamic bodies (not rays, not the controller);
 * PH3's gib-on-seam test picks the value (candidate: FIX_INTERNAL_EDGES_TWO_SIDED).
 */
export const TRIMESH_FLAGS: readonly TriMeshFlagName[] = [];

/**
 * A `box` key is a Rapier cuboid up to this half extent (props, crates, posts); a larger box becomes a trimesh of its six
 * faces. Measured on 0.21 (single precision) with the player capsule: on cuboids of half extent ≤ 1.5 m it rests at the
 * offset; at 2-4 m it dips millimetres into the top face; at 12 m it sank 0.3 m while walking and fell through when it stood
 * on the box's centre line; beyond 100 m the feet wander ±10-20 cm. A body inside a solid cuboid is ignored by every later
 * cast, so a dip can end below the map. The controller costs about 20 µs on a cuboid floor against 28 µs on the trimesh.
 */
export const CUBOID_MAX_HALF_EXTENT = 1.5;
/**
 * No triangle of a trimesh collider keeps an edge longer than this (colliders.ts bisects them). Measured walking circles at
 * 5 m/s on box floors of 4-100 m half extent: as 12 triangles the feet hopped up to 14 cm and lost the ground for single
 * ticks (which restarts the game's landing cooldown); with edges ≤ 4 m still up to 8 cm and 3 ungrounded ticks in 6,000 on
 * a 16 × 8 × 16 m box; with edges ≤ 2 m they stayed within [offset, offset + 3 cm] and grounded on every tick (≤ 1 m:
 * + 2 cm, at 1.4× the controller cost).
 */
export const MAX_TRIANGLE_EDGE = 2;
/**
 * The edge limit of triangles nobody stands on (walls, overhangs, undersides). Characters pressing against walls pay for
 * every wall triangle near them: 36 characters grinding into 400 boxes cost 11.4 ms per tick with every face cut to 2 m,
 * 8.0 ms at 4 m and 5.9 ms uncut (5.2 ms on cuboids).
 */
export const MAX_STEEP_TRIANGLE_EDGE = 8;
/** a triangle whose unit normal has |y| above this is ground a character may stand on (66° from level; the player slides from 62°) */
export const WALKABLE_NORMAL_Y = 0.4;
