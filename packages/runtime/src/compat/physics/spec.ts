// A row's `physics` value → `NormalizedBody` (motion §4.1-§4.2, contract §9.5, D-MPN-08/09). The one place where the spec's
// forms are read and its degrees become radians; everything behind it (body-sync, the controller, PH4's dynamics) works on
// the normalised record. An unset character option gets Spawn's working value (defaults.ts), not Rapier's JS default.
//
//   physics?: "none" | "static" | "dynamic" | "kinematic" | "character" | false | null
//           | { body, collider?, trigger?, mass?, friction?, restitution?, linearDamping?, angularDamping?, gravityScale?,
//               lockedAxes?, collisionGroups?: {membership, filter}, autostep?: {maxHeight, minWidth} | false,
//               maxSlopeClimbAngle?: deg, minSlopeSlideAngle?: deg, slideEnabled?, snapToGroundDistance?: num | false,
//               characterMass?, applyImpulsesToDynamicBodies?, offset?, normalNudgeFactor?, capsule?: {height?, radius?} }
//
// Omitted / "none" / false / null: no body (`kind: null`); the row is walked through and a velocity written to it still
// integrates (core §5.4). `lockedAxes` is carried as written for PH4; `characterMass` and `applyImpulsesToDynamicBodies`
// are unused live and have no port logic (the controller is created with `null` / `false`, kcc.ts).
import type { AssetFactsPort } from '../core/ports.ts';
import type { RowRec, Vec3 } from '../core/types.ts';
import {
  BODY_DEFAULTS, CHARACTER_GROUPS, DEFAULT_CAPSULE_RADIUS, DEFAULT_GROUPS, DEG, capsuleHalfSegment, kccParams, packGroups, type CollisionGroups,
  type KccParams,
} from './defaults.ts';
import type { BodyKind } from './query.ts';

export type { KccParams } from './defaults.ts';
export type { BodyKind } from './query.ts';

export type ColliderKind = 'auto' | 'box' | 'sphere' | 'capsule' | 'mesh';

export interface NormalizedBody {
  /** null = "none" / false / omitted → no body (velocity still integrates, core §5.4) */
  kind: BodyKind | null;
  /** `trigger: true` */
  sensor: boolean;
  collider: { kind: ColliderKind; dims?: number[] };
  mass: number;
  friction: number;
  restitution: number;
  linearDamping: number;
  angularDamping: number;
  gravityScale: number;
  groups: CollisionGroups;
  /** characters: total height (feet → top) × radius, BEFORE row scale */
  capsule?: { height: number; radius: number };
  /** characters */
  kcc?: KccParams;
  /** characters: `continuous: true` sweeps the move against the other characters (rapier/kcc-ccd.ts); unset = the base runtime's behaviour */
  continuous?: boolean;
  /** as written; PH4 hands it to Rapier's `setEnabledTranslations` / `setEnabledRotations` */
  lockedAxes?: unknown;
}

/** capsule height when neither the spec nor the model's bounds give one (`sk/geometry:30`: a 1.9 × 0.7 body) */
export const DEFAULT_CAPSULE_HEIGHT = 1.9;
/** dynamic body mass when the spec gives none (Rapier would derive it from density 1; live rows always set it) */
export const DEFAULT_MASS = 1;

const KINDS: readonly BodyKind[] = ['static', 'kinematic', 'dynamic', 'character'];
const COLLIDERS: readonly ColliderKind[] = ['auto', 'box', 'sphere', 'capsule', 'mesh'];

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const pos = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : d);
const nonNeg = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : d);

/** the body kind a `physics` value names, or null (no body) */
export function bodyKindOf(spec: unknown): BodyKind | null {
  const k = typeof spec === 'string' ? spec : isObj(spec) ? spec['body'] : null;
  return typeof k === 'string' && (KINDS as readonly string[]).includes(k) ? (k as BodyKind) : null;
}

function colliderOf(v: unknown): NormalizedBody['collider'] {
  const kind = typeof v === 'string' ? v : isObj(v) ? v['kind'] : undefined;
  const out: NormalizedBody['collider'] = { kind: typeof kind === 'string' && (COLLIDERS as readonly string[]).includes(kind) ? (kind as ColliderKind) : 'auto' };
  if (isObj(v)) {
    // explicit dimensions, when a spec carries them [INF: no live row does]: box [w, h, d], sphere [r], capsule [height, radius]
    const d = v['dims'] ?? v['size'];
    if (Array.isArray(d) && d.every((x) => typeof x === 'number' && Number.isFinite(x))) out.dims = [...(d as number[])];
    else if (out.kind === 'sphere' && typeof v['radius'] === 'number') out.dims = [v['radius']];
  }
  return out;
}

function groupsOf(v: unknown, character: boolean): CollisionGroups {
  const base = character ? CHARACTER_GROUPS : DEFAULT_GROUPS;
  if (!isObj(v)) return { ...base };
  const m = v['membership'], f = v['filter'];
  return {
    membership: typeof m === 'number' && Number.isFinite(m) ? m & 0xffff : base.membership,
    filter: typeof f === 'number' && Number.isFinite(f) ? f & 0xffff : base.filter,
  };
}

/** the height of the model a row shows, from the asset facts (its bounds), or null */
function boundsHeight(row: RowRec, facts: AssetFactsPort | null): number | null {
  if (!facts) return null;
  const m = row.props['model'];
  const ref = typeof m === 'string' ? m : isObj(m) ? (m['id'] ?? m['src']) : null;
  if (typeof ref !== 'string') return null;
  const h = facts.get(ref)?.bounds?.size[1];
  return typeof h === 'number' && h > 0 ? h : null;
}

function kccOf(o: Record<string, unknown>): KccParams {
  const over: Partial<KccParams> = {};
  if (typeof o['offset'] === 'number' && o['offset'] > 0) over.offset = o['offset'];
  const a = o['autostep'];
  if (a === false || a === null) over.autostep = null;
  else if (isObj(a)) over.autostep = { maxHeight: pos(a['maxHeight'], 0.4), minWidth: pos(a['minWidth'], 0.2), includeDynamic: a['includeDynamic'] === true };
  if (typeof o['maxSlopeClimbAngle'] === 'number' && Number.isFinite(o['maxSlopeClimbAngle'])) over.maxSlopeClimb = o['maxSlopeClimbAngle'] * DEG;
  if (typeof o['minSlopeSlideAngle'] === 'number' && Number.isFinite(o['minSlopeSlideAngle'])) over.minSlopeSlide = o['minSlopeSlideAngle'] * DEG;
  if (typeof o['slideEnabled'] === 'boolean') over.slide = o['slideEnabled'];
  const s = o['snapToGroundDistance'];
  if (s === false || s === null) over.snapToGround = null;
  else if (typeof s === 'number' && s > 0) over.snapToGround = s;
  if (typeof o['normalNudgeFactor'] === 'number' && o['normalNudgeFactor'] > 0) over.normalNudge = o['normalNudgeFactor'];
  return kccParams(over);
}

/** `physics` as written (string, object, false, null, undefined) → the record every backend module reads */
export function normalizeBody(spec: unknown, row: RowRec, facts: AssetFactsPort | null): NormalizedBody {
  const o: Record<string, unknown> = isObj(spec) ? spec : {};
  const kind = bodyKindOf(spec);
  const character = kind === 'character';
  const body: NormalizedBody = {
    kind,
    sensor: o['trigger'] === true,
    collider: colliderOf(o['collider']),
    mass: pos(o['mass'], DEFAULT_MASS),
    friction: nonNeg(o['friction'], BODY_DEFAULTS.friction),
    restitution: nonNeg(o['restitution'], BODY_DEFAULTS.restitution),
    linearDamping: nonNeg(o['linearDamping'], BODY_DEFAULTS.linearDamping),
    angularDamping: nonNeg(o['angularDamping'], BODY_DEFAULTS.angularDamping),
    gravityScale: num(o['gravityScale'], BODY_DEFAULTS.gravityScale),
    groups: groupsOf(o['collisionGroups'], character),
  };
  if (o['lockedAxes'] !== undefined) body.lockedAxes = o['lockedAxes'];
  if (character) {
    const c = isObj(o['capsule']) ? o['capsule'] : {};
    body.capsule = {
      height: pos(c['height'], boundsHeight(row, facts) ?? DEFAULT_CAPSULE_HEIGHT),
      radius: pos(c['radius'], DEFAULT_CAPSULE_RADIUS),
    };
    body.kcc = kccOf(o);
    if (o['continuous'] === true) body.continuous = true;
  }
  return body;
}

/** packed `InteractionGroups` of a body: `ColliderDesc.setCollisionGroups`, the controller's and the queries' `filterGroups` */
export const packedGroups = (b: Readonly<NormalizedBody>): number => packGroups(b.groups.membership, b.groups.filter);

/**
 * The capsule in world units (motion §4.2): height `h · scale.y`, radius `r · max(scale.x, scale.z)`; the radius never
 * exceeds half the height (Rapier's capsule is then a ball: `capsuleHalfSegment` clamps at 0).
 */
export function worldCapsule(capsule: Readonly<{ height: number; radius: number }>, scale: Readonly<Vec3>): { height: number; radius: number; halfSegment: number } {
  const height = capsule.height * Math.abs(scale.y);
  const radius = Math.min(capsule.radius * Math.max(Math.abs(scale.x), Math.abs(scale.z)), height / 2);
  return { height, radius, halfSegment: capsuleHalfSegment(height, radius) };
}
