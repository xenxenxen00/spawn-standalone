// `builtin/physics` for the carried game code (motion §6, contract §10.1): `raycast` with every live option, `getInputRay`
// and loud stubs for the verbs no live file calls. Reads `ctx` only for `place.id` and `self.id` (core §15.1); the place's
// world comes from the binding the physics port installs (`bindPhysicsQueries`, physics/port.ts). Until a binding exists, or
// for a place that is not resident or not built yet, every query answers null (X-32).
//
// The option logic below compiles a call into one PH1 `RayQuery` and is the same for every backend. What answers the query
// is the world the binding returns: a backend that answers whole queries itself (the Rapier world, physics/rapier/query.ts:
// it has `castRay` / `castRayAll`), or a PH1 `QueryWorld` (the BVH `QueryScene` of tools and tests, the query oracle) that
// PH1's own `castRay` / `castRayAll` traverse.
import { v3, type Vec3 } from '../physics/math.ts';
import {
  castRay, castRayAll, type BodiesFilter, type BodyKind, type QueryHit, type QueryLayer, type QueryWorld, type RayQuery,
} from '../physics/query.ts';

export type { Vec3 } from '../physics/math.ts';

export interface RaycastOptions {
  /** default 200 m (api:1387) */
  distance?: number;
  /** default 'all' */
  bodies?: BodiesFilter;
  /** accepted; no live row is a sprite, so colliders-only is all there is (census §11.1) */
  physicsOnly?: boolean;
  ignoreEntities?: string[];
  /** default true: the caller and its `/` children */
  ignoreSelf?: boolean;
  tags?: string[];
  excludeTags?: string[];
  /** sphere cast */
  radius?: number;
  multiple?: boolean;
  /** undocumented (camera.js:57,80): colliders plus render-only static geometry (X-42) */
  hits?: 'both';
  place?: string;
  verdict?: boolean;
  /** ignored (dev warning once) */
  through?: unknown;
  /** ignored (dev warning once) */
  shape?: unknown;
}

export interface RaycastHit {
  /** row id; terrain: 'terrain/<place>'; null for anonymous geometry */
  id: string | null;
  position: Vec3;
  normal: Vec3;
  distance: number;
  /** [INF] convenience; live code re-reads tags through getObject */
  tags: readonly string[];
  body: BodyKind;
}

export interface RaycastVerdict {
  hit: RaycastHit | null;
  hits: RaycastHit[];
  verdict: { queryable: boolean; terrain: boolean };
}

/** the slice of a game ctx this builtin reads */
export interface PhysicsCtx {
  readonly place?: { readonly id: string } | null;
  readonly self?: { readonly id: string } | null;
}

/** a world that answers compiled queries itself (physics/rapier/query.ts `RapierQueryWorld`) */
export interface PhysicsQueryBackend {
  readonly place: string;
  readonly built: boolean;
  visualProxies(): QueryLayer | null;
  castRay(q: RayQuery): QueryHit | null;
  castRayAll(q: RayQuery): QueryHit[];
}

/** the slice of the camera port `getInputRay` reads (core/ports.ts `CameraPort`) */
export interface InputRayCamera {
  /** eye, forward direction (`aim`) and vertical field of view in degrees; null before the first camera frame */
  presentedCamera(): { eye: Vec3; aim: Vec3; fov: number } | null;
  view?(): { yaw: number; pitch: number } | undefined;
  worldCamera?(): { aspect?: number; fov?: number };
}

/** installed by the physics port: place id → its world (null when not resident); dev warnings; the camera for `getInputRay` */
export interface PhysicsQueryBinding {
  world(place: string): QueryWorld | PhysicsQueryBackend | null;
  warn(message: string): void;
  camera?(): InputRayCamera | null;
}

const isBackend = (w: QueryWorld | PhysicsQueryBackend): w is PhysicsQueryBackend => typeof (w as PhysicsQueryBackend).castRay === 'function';

let binding: PhysicsQueryBinding | null = null;
const warned = new Set<string>();

/** install (or with null remove) the world resolver; also resets the once-only warnings */
export function bindPhysicsQueries(b: PhysicsQueryBinding | null): void {
  binding = b;
  warned.clear();
}

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  binding?.warn(message);
}

const DEFAULT_DISTANCE = 200;
const finite3 = (p: unknown): p is Vec3 =>
  typeof p === 'object' && p !== null && Number.isFinite((p as Vec3).x) && Number.isFinite((p as Vec3).y) && Number.isFinite((p as Vec3).z);
const strings = (a: unknown): string[] => (Array.isArray(a) ? a.filter((s): s is string => typeof s === 'string') : []);

export function raycast(ctx: PhysicsCtx, origin: Vec3, direction: Vec3, opts?: number | RaycastOptions): RaycastHit | RaycastHit[] | RaycastVerdict | null {
  const o: RaycastOptions = typeof opts === 'number' ? { distance: opts } : typeof opts === 'object' && opts !== null ? opts : {};
  if (!binding) return null;
  const placeId = typeof o.place === 'string' ? o.place : ctx.place?.id;
  if (typeof placeId !== 'string') return null;
  const world = binding.world(placeId);
  if (!world || !world.built) return null;
  if (!finite3(origin) || !finite3(direction)) return null;
  const len = Math.hypot(direction.x, direction.y, direction.z);
  if (!(len > 0)) return null;

  if (o.through !== undefined) warnOnce('through', "raycast: option 'through' is ignored in this build");
  if (o.shape !== undefined) warnOnce('shape', "raycast: option 'shape' is ignored in this build");
  let both = o.hits === 'both';
  if (both && world.visualProxies() === null) {
    warnOnce(`both:${placeId}`, `raycast: hits:'both' answers colliders only in ${placeId} until its visual proxies exist (X-42)`);
    both = false;
  }

  const ignore = strings(o.ignoreEntities);
  const self = ctx.self?.id;
  if (o.ignoreSelf !== false && typeof self === 'string') ignore.push(self);
  const distance = typeof o.distance === 'number' && o.distance >= 0 ? o.distance : DEFAULT_DISTANCE;
  const bodies: BodiesFilter = o.bodies === 'static' || o.bodies === 'dynamic' ? o.bodies : 'all';
  const radius = typeof o.radius === 'number' && o.radius > 0 ? o.radius : 0;
  const q: RayQuery = {
    origin: v3(origin.x, origin.y, origin.z),
    dir: v3(direction.x / len, direction.y / len, direction.z / len),
    distance, radius, bodies, ignore,
    tags: strings(o.tags), excludeTags: strings(o.excludeTags), both,
  };

  if (o.multiple === true) {
    const hits = (isBackend(world) ? world.castRayAll(q) : castRayAll(world, q)).map(toHit);
    return o.verdict === true ? verdict(hits[0] ?? null, hits) : hits;
  }
  const h = isBackend(world) ? world.castRay(q) : castRay(world, q);
  const hit = h ? toHit(h) : null;
  return o.verdict === true ? verdict(hit, hit ? [hit] : []) : hit;
}

const toHit = (h: QueryHit): RaycastHit => h;

function verdict(hit: RaycastHit | null, hits: RaycastHit[]): RaycastVerdict {
  return { hit, hits, verdict: { queryable: true, terrain: hit !== null && hit.id !== null && hit.id.startsWith('terrain/') } };
}

export interface InputRay { origin: Vec3; direction: Vec3; source: 'pointer' | 'camera' }

const DEG = Math.PI / 180;
/** the rig's fallback when the camera port has no aspect yet (ctx.world.camera before frame 1) */
const DEFAULT_ASPECT = 16 / 9;

/**
 * The input ray (motion §6.3, contract §10.1). Origin = the presented eye. `source: 'pointer'` when the input sample carries
 * pointer data: while the pointer is locked, and on touch (the crosshair is the screen centre), the sample's pointer sits at
 * ndc (0, 0) and the ray is the camera's centre ray; unlocked it is the ray through the free cursor (the game routes around
 * that through `bag.look`, authored module). `source: 'camera'` = the presented camera forward when no pointer
 * rode the input (or no input was passed). null before the first camera frame and while no physics port is bound.
 */
export function getInputRay(_ctx: PhysicsCtx, input?: unknown): InputRay | null {
  const port = binding?.camera?.() ?? null;
  const cam = port?.presentedCamera() ?? null;
  if (!port || !cam || !finite3(cam.eye) || !finite3(cam.aim)) return null;
  const fl = Math.hypot(cam.aim.x, cam.aim.y, cam.aim.z);
  if (!(fl > 0)) return null;
  const fx = cam.aim.x / fl, fy = cam.aim.y / fl, fz = cam.aim.z / fl;
  const origin = { x: cam.eye.x, y: cam.eye.y, z: cam.eye.z };
  const pointer = typeof input === 'object' && input !== null ? (input as { pointer?: unknown }).pointer : undefined;
  if (typeof pointer !== 'object' || pointer === null) return { origin, direction: { x: fx + 0, y: fy + 0, z: fz + 0 }, source: 'camera' };
  const ndcX = (pointer as { ndcX?: unknown }).ndcX, ndcY = (pointer as { ndcY?: unknown }).ndcY;
  const nx = typeof ndcX === 'number' && Number.isFinite(ndcX) ? ndcX : 0, ny = typeof ndcY === 'number' && Number.isFinite(ndcY) ? ndcY : 0;
  if (nx === 0 && ny === 0) return { origin, direction: { x: fx + 0, y: fy + 0, z: fz + 0 }, source: 'pointer' };
  // the camera's right and up: world up is +Y; looking straight up or down, the right axis comes from the view yaw
  let rx = -fz, rz = fx;
  let rl = Math.hypot(rx, rz);
  if (!(rl > 1e-6)) {
    // radians, the engine's camera convention (authored module `lookDir`): yaw 0 faces -Z, right is +X
    const yaw = port.view?.()?.yaw ?? 0;
    rx = Math.cos(yaw); rz = -Math.sin(yaw); rl = 1;
  }
  rx /= rl; rz /= rl;
  // up = right × forward
  const ux = -rz * fy, uy = rz * fx - rx * fz, uz = rx * fy;
  const world = port.worldCamera?.() ?? {};
  const fov = Number.isFinite(cam.fov) && cam.fov > 0 && cam.fov < 180 ? cam.fov : 60;
  const tanV = Math.tan((fov * DEG) / 2);
  const aspect = typeof world.aspect === 'number' && world.aspect > 0 ? world.aspect : DEFAULT_ASPECT;
  const sx = nx * tanV * aspect, sy = ny * tanV;
  const dx = fx + rx * sx + ux * sy, dy = fy + uy * sy, dz = fz + rz * sx + uz * sy;
  const dl = Math.hypot(dx, dy, dz);
  return { origin, direction: { x: dx / dl + 0, y: dy / dl + 0, z: dz / dl + 0 }, source: 'pointer' };
}

const stub = (verb: string): never => {
  throw new Error(`${verb} is not available in this build`);
};
// unused live (contract §10.1: only leftover authoring scripts call overlapPoint): loud stubs (core §3.4)
export function overlapPoint(..._a: unknown[]): never { return stub('overlapPoint'); }
export function overlapSegment(..._a: unknown[]): never { return stub('overlapSegment'); }
export function traverseCheck(..._a: unknown[]): never { return stub('traverseCheck'); }
export function jumpCheck(..._a: unknown[]): never { return stub('jumpCheck'); }
