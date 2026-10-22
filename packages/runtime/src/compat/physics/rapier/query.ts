// The Rapier backend of the query contract (motion §6.1-§6.2): `builtin/physics.raycast` compiles its options into a PH1
// `RayQuery` and this module turns that into ONE Rapier call per query:
//
//   single ray        `castRayAndGetNormal(ray, distance, solid = true, flags, groups, excludeCollider?, -, predicate?)`
//   `multiple`        `intersectionsWithRay(...)`: one hit per collider, sorted here (Rapier gives no order)
//   `radius`          `castShape(origin, identity, dir, Ball(radius), 0, distance, stopAtPenetration = false, ...)`;
//                     `witness1` / `normal1` lie on the hit collider in world space (0.21 typings, geometry/toi.d.ts)
//   `groundY`, render's `StaticRaycaster.castDown`   a ray down with ONLY_FIXED | EXCLUDE_SENSORS
//   `aimTargets`      candidates from the character registry, one ONLY_FIXED ray per candidate for the line of sight
//
// Filters: `bodies` → `QueryFilterFlags` (`'static'` ONLY_FIXED, `'dynamic'` ONLY_DYNAMIC, sensors never: EXCLUDE_SENSORS
// always; the values are read from the loaded namespace, D-MPN-10). Ignore ids (with their `/` children) and tag filters
// run inside the traversal, so the nearest QUALIFYING hit comes back. A `filterPredicate` is a JS callback per candidate
// across the wasm boundary, so one is passed only when it can matter: an ignore id that owns no collider the body filter
// lets through (an enemy's line-of-sight ray is `bodies: 'static'`, its own capsule is never a candidate) is dropped, a
// single id with a single collider goes to `filterExcludeCollider`, and only what is left needs the predicate.
// Every query goes to the world's `BroadPhase` itself, with handles: the `World` methods wrap EVERY call's predicate in a
// closure (`ColliderSet.castClosure`, even when none is given, and with a `Collider` lookup per candidate when one is), which
// the wasm calls once per candidate only to be told "keep". Given no closure the wasm keeps every candidate itself: the
// same answers (tests/unit/physics/query-direct.node.test.ts), 8-13 % less time per ray on the sim bench maps.
//
// `stopAtPenetration` is false, not the `true` of motion §6.1's call table: PH1's option table (the oracle) says "a sphere
// starting in contact and moving away is not stopped", which is what `false` means in Rapier.
//
// Disabled colliders (spectating bodies, rows switched to "none") are out of Rapier's queries by themselves. Queries read
// the broad phase as of the last `world.step()` (world.ts `refresh`).
//
// `hits:'both'` (X-42): the Rapier hit and the hit of the visual-proxy layer (physics/visual-proxy.ts, PH1's BVH code over
// LOD-5 hulls that never enter the Rapier world) are merged by distance: the nearer one for a single query, the union
// sorted for `multiple`. Proxy hits get the same ignore and tag filters; `bodies: 'dynamic'` asks for no proxies.
import type { Ball, Collider, Ray } from '@dimforge/rapier3d-simd-compat';
import { v3, type Vec3 } from '../math.ts';
import { castRay as castProxyRay, castRayAll as castProxyRayAll, type BodyKind, type QueryHit, type QueryLayer, type RayQuery } from '../query.ts';
import { proxyWorld } from '../visual-proxy.ts';
import type { OwnerRecord } from './colliders.ts';
import type { PhysicsWorld } from './world.ts';

/** what `builtin/physics` dispatches a compiled query to (the Rapier world, or anything else that answers whole queries) */
export interface QueryBackend {
  readonly place: string;
  /** false until the place's physics is built: queries answer null (X-32) */
  readonly built: boolean;
  /** the `hits:'both'` layer; null until `setVisualProxies` gave one */
  visualProxies(): QueryLayer | null;
  castRay(q: RayQuery): QueryHit | null;
  castRayAll(q: RayQuery): QueryHit[];
}

export interface AimTarget { id: string; point: Vec3; distance: number }

const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const MAX_SPHERE_HITS = 64;
const GROUND_PROBE_Y = 400;
const GROUND_PROBE_RANGE = 2000;
/** `groundY`: where its second ray stands beside the first (not along an axis or a diagonal of a face grid), and how much higher its ground must be to count */
const GROUND_PROBE_SHIFT_X = 1e-3;
const GROUND_PROBE_SHIFT_Z = 7e-4;
const GROUND_PROBE_STEP = 0.01;
export interface AimTargetOptions { tags?: readonly string[] }

function ignored(id: string | null, ignore: readonly string[]): boolean {
  if (id === null) return false;
  for (const ig of ignore) {
    if (id === ig) return true;
    if (id.length > ig.length && id.charCodeAt(ig.length) === 47 /* '/' */ && id.startsWith(ig)) return true;
  }
  return false;
}

/**
 * Which ids have `/` children that own colliders: `a/b/c` counts for `a` and `a/b`. Kept by whoever adds and removes
 * colliders (body-sync, the pack build), so "this id has no child collider" is one map read.
 */
export class ChildIndex {
  private readonly counts = new Map<string, number>();

  private each(rowId: string, d: number): void {
    for (let i = rowId.indexOf('/'); i >= 0; i = rowId.indexOf('/', i + 1)) {
      const p = rowId.slice(0, i);
      const n = (this.counts.get(p) ?? 0) + d;
      if (n > 0) this.counts.set(p, n); else this.counts.delete(p);
    }
  }
  add(rowId: string | null): void { if (rowId !== null && rowId.includes('/')) this.each(rowId, 1); }
  remove(rowId: string | null): void { if (rowId !== null && rowId.includes('/')) this.each(rowId, -1); }
  has(prefix: string): boolean { return this.counts.has(prefix); }
  clear(): void { this.counts.clear(); }
}

interface Compiled {
  flags: number;
  exclude: Collider | undefined;
  predicate: ((handle: number) => boolean) | undefined;
  /** no collider can qualify (a required tag nobody carries) */
  empty: boolean;
}

export class RapierQueryWorld implements QueryBackend {
  readonly world: PhysicsWorld;
  /** ids with collider-owning `/` children */
  readonly children = new ChildIndex();
  private readonly proxies: () => QueryLayer | null;
  private readonly ray: Ray;
  private ball: Ball | null = null;
  private readonly fSensors: number;
  private readonly fFixed: number;
  private readonly fDynamic: number;
  // the running query's filter (queries are not re-entrant: the predicate never calls back into a query)
  private pIgnore: readonly string[] = [];
  private pNeed = 0;
  private pBan = 0;
  private pTags: readonly string[] = [];
  private pExclude: readonly string[] = [];
  private pMasks = true;
  private pSkip: Set<number> | null = null;
  /** collider handle of the hit made last */
  private lastCollider = -1;
  private readonly predicate = (handle: number): boolean => this.passes(handle);
  private readonly from = { x: 0, y: 0, z: 0 };
  private readonly dir = { x: 0, y: 0, z: 0 };

  constructor(world: PhysicsWorld, proxies: () => QueryLayer | null = () => null) {
    this.world = world;
    this.proxies = proxies;
    const R = world.R;
    this.ray = new R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 });
    const F = R.QueryFilterFlags;
    this.fSensors = F.EXCLUDE_SENSORS;
    this.fFixed = F.ONLY_FIXED | F.EXCLUDE_SENSORS;
    this.fDynamic = F.ONLY_DYNAMIC | F.EXCLUDE_SENSORS;
  }

  get place(): string { return this.world.place; }
  get built(): boolean { return this.world.built; }
  visualProxies(): QueryLayer | null { return this.proxies(); }

  // ── filters ────────────────────────────────────────────────────────────────────────────────────────────────────────────

  private passes(handle: number): boolean {
    if (this.pSkip?.has(handle)) return false;
    const rec = this.world.colliders.owner(handle);
    if (!rec) return this.pTags.length === 0;
    if (this.pIgnore.length > 0 && ignored(rec.rowId, this.pIgnore)) return false;
    if (this.pMasks) return (rec.tagMask & this.pNeed) === this.pNeed && (rec.tagMask & this.pBan) === 0;
    for (const t of this.pTags) if (!rec.tags.includes(t)) return false;
    for (const t of this.pExclude) if (rec.tags.includes(t)) return false;
    return true;
  }

  /** can a ray with this body filter hit this record at all */
  private kindPasses(rec: OwnerRecord, bodies: RayQuery['bodies']): boolean {
    if (rec.sensor) return false;
    return bodies === 'all' || (bodies === 'static' ? rec.kind === 'static' : rec.kind === 'dynamic');
  }

  private compile(q: RayQuery): Compiled {
    const flags = q.bodies === 'static' ? this.fFixed : q.bodies === 'dynamic' ? this.fDynamic : this.fSensors;
    const colliders = this.world.colliders;
    const out: Compiled = { flags, exclude: undefined, predicate: undefined, empty: false };
    for (const t of q.tags) if (colliders.tags.unknown(t)) { out.empty = true; return out; }
    // ids that can actually stand in the ray's way
    let ignore: string[] | null = null;
    let single: Collider | undefined;
    let singles = 0;
    for (const id of q.ignore) {
      let own = 0;
      let last: Collider | undefined;
      for (const rec of colliders.ownersOf(id)) if (this.kindPasses(rec, q.bodies)) { own++; last = rec.collider; }
      const kids = this.children.has(id);
      if (own === 0 && !kids) continue;
      (ignore ??= []).push(id);
      if (own === 1 && !kids) { single = last; singles++; } else singles = 2;
    }
    const tagged = q.tags.length > 0 || q.excludeTags.length > 0;
    if (!tagged && ignore === null) return out;
    if (!tagged && ignore !== null && ignore.length === 1 && singles === 1) {
      out.exclude = single;
      return out;
    }
    this.pIgnore = ignore ?? [];
    this.pTags = q.tags;
    this.pExclude = q.excludeTags;
    const need = colliders.tags.filterMask(q.tags), ban = colliders.tags.filterMask(q.excludeTags);
    this.pMasks = need !== null && ban !== null;
    this.pNeed = need ?? 0;
    this.pBan = ban ?? 0;
    this.pSkip = null;
    out.predicate = this.predicate;
    return out;
  }

  private aim(q: RayQuery): Ray {
    const ray = this.ray;
    ray.origin.x = q.origin[0]!; ray.origin.y = q.origin[1]!; ray.origin.z = q.origin[2]!;
    ray.dir.x = q.dir[0]!; ray.dir.y = q.dir[1]!; ray.dir.z = q.dir[2]!;
    return ray;
  }

  private hit(collider: Collider, distance: number, px: number, py: number, pz: number, nx: number, ny: number, nz: number): QueryHit {
    this.lastCollider = collider.handle;
    const rec = this.world.colliders.owner(collider.handle);
    let body: BodyKind = 'static';
    if (rec) body = rec.kind;
    else {
      const parent = collider.parent();
      if (parent) body = parent.isDynamic() ? 'dynamic' : parent.isKinematic() ? 'kinematic' : 'static';
    }
    return {
      id: rec ? rec.rowId : null, distance, body, tags: rec ? [...rec.tags] : [],
      position: { x: px, y: py, z: pz }, normal: { x: nx, y: ny, z: nz },
    };
  }

  /** a ray hit: the point on the ray, the normal turned to face the ray's origin (trimeshes are two-sided) */
  private rayHit(q: RayQuery, collider: Collider, toi: number, n: Readonly<Vec3>): QueryHit {
    const dx = q.dir[0]!, dy = q.dir[1]!, dz = q.dir[2]!;
    let nx = n.x, ny = n.y, nz = n.z;
    const l = Math.hypot(nx, ny, nz);
    if (!(l > 1e-9)) { nx = -dx; ny = -dy; nz = -dz; } else {
      const s = nx * dx + ny * dy + nz * dz > 0 ? -1 / l : 1 / l;
      nx *= s; ny *= s; nz *= s;
    }
    return this.hit(collider, toi, q.origin[0]! + dx * toi, q.origin[1]! + dy * toi, q.origin[2]! + dz * toi, nx + 0, ny + 0, nz + 0);
  }

  private sphereCast(q: RayQuery, flags: number, exclude: Collider | undefined, predicate: ((handle: number) => boolean) | undefined): QueryHit | null {
    const R = this.world.R;
    if (!this.ball) this.ball = new R.Ball(q.radius); else this.ball.radius = q.radius;
    const from = this.from, dir = this.dir;
    from.x = q.origin[0]!; from.y = q.origin[1]!; from.z = q.origin[2]!;
    dir.x = q.dir[0]!; dir.y = q.dir[1]!; dir.z = q.dir[2]!;
    const raw = this.world.raw;
    const h = raw.broadPhase.castShape(raw.narrowPhase, raw.bodies, raw.colliders, from, IDENTITY, dir, this.ball, 0, q.distance, false, flags, undefined,
      exclude?.handle, undefined, predicate);
    if (!h) return null;
    const t = h.time_of_impact;
    const w = h.witness1;
    // Measured on 0.21: the time of impact and `normal1` are good to 1e-4, the witness points wander by millimetres along
    // the surface (a ball dropped on a floor: 5 mm beside its foot). So the surface normal is `normal1`, turned to the
    // sphere's side (trimeshes are two-sided), and the contact point is the sphere's own point under it: centre - n·r.
    const ox = from.x + dir.x * t, oy = from.y + dir.y * t, oz = from.z + dir.z * t;
    const cx = ox - w.x, cy = oy - w.y, cz = oz - w.z;
    let nx = h.normal1.x, ny = h.normal1.y, nz = h.normal1.z;
    const k = Math.hypot(nx, ny, nz);
    if (k > 1e-9) {
      const side = nx * cx + ny * cy + nz * cz;
      const sgn = (Math.abs(side) > 1e-6 ? side < 0 : nx * dir.x + ny * dir.y + nz * dir.z > 0) ? -1 / k : 1 / k;
      nx *= sgn; ny *= sgn; nz *= sgn;
    } else {
      const l = Math.hypot(cx, cy, cz);
      if (l > 1e-6) { nx = cx / l; ny = cy / l; nz = cz / l; } else { nx = -dir.x; ny = -dir.y; nz = -dir.z; }
    }
    return this.hit(h.collider, t, ox - nx * q.radius, oy - ny * q.radius, oz - nz * q.radius, nx + 0, ny + 0, nz + 0);
  }

  // ── the query contract ─────────────────────────────────────────────────────────────────────────────────────────────────

  castRay(q: RayQuery): QueryHit | null {
    if (!this.world.built) return null;
    const c = this.compile(q);
    let hit: QueryHit | null = null;
    if (!c.empty) {
      if (q.radius > 0) hit = this.sphereCast(q, c.flags, c.exclude, c.predicate);
      else {
        const w = this.world.raw;
        const h = w.broadPhase.castRayAndGetNormal(w.narrowPhase, w.bodies, w.colliders, this.aim(q), q.distance, true, c.flags, undefined, c.exclude?.handle,
          undefined, c.predicate);
        if (h) hit = this.rayHit(q, h.collider, h.timeOfImpact, h.normal);
      }
    }
    if (q.both && q.bodies !== 'dynamic') {
      const layer = this.proxies();
      if (layer) {
        const p = castProxyRay(proxyWorld(this.place, layer), hit ? { ...q, distance: Math.min(q.distance, hit.distance) } : q);
        if (p && (hit === null || p.distance < hit.distance)) hit = p;
      }
    }
    return hit;
  }

  castRayAll(q: RayQuery): QueryHit[] {
    if (!this.world.built) return [];
    const c = this.compile(q);
    const out: QueryHit[] = [];
    if (!c.empty) {
      if (q.radius > 0) {
        // Rapier has no "every shape-cast hit": cast again without the colliders found so far
        const skip = new Set<number>();
        if (!c.predicate) {
          this.pIgnore = []; this.pTags = []; this.pExclude = []; this.pMasks = true; this.pNeed = 0; this.pBan = 0;
        }
        if (c.exclude) skip.add(c.exclude.handle);
        this.pSkip = skip;
        for (let i = 0; i < MAX_SPHERE_HITS; i++) {
          const h = this.sphereCast(q, c.flags, undefined, this.predicate);
          if (!h) break;
          skip.add(this.lastCollider);
          out.push(h);
        }
        this.pSkip = null;
      } else {
        const w = this.world.raw;
        w.broadPhase.intersectionsWithRay(w.narrowPhase, w.bodies, w.colliders, this.aim(q), q.distance, true, (h) => {
          out.push(this.rayHit(q, h.collider, h.timeOfImpact, h.normal));
          return true;
        }, c.flags, undefined, c.exclude?.handle, undefined, c.predicate);
      }
    }
    if (q.both && q.bodies !== 'dynamic') {
      const layer = this.proxies();
      if (layer) for (const p of castProxyRayAll(proxyWorld(this.place, layer), q)) out.push(p);
    }
    return out.sort((a, b) => a.distance - b.distance);
  }

  // ── static probes ──────────────────────────────────────────────────────────────────────────────────────────────────────

  /** the nearest fixed collider under `origin` within `maxDist` (ONLY_FIXED | EXCLUDE_SENSORS), or null */
  castDown(origin: Readonly<Vec3>, maxDist: number): { y: number; normal: Vec3 } | null {
    if (!this.world.built || !(maxDist > 0)) return null;
    const ray = this.ray;
    ray.origin.x = origin.x; ray.origin.y = origin.y; ray.origin.z = origin.z;
    ray.dir.x = 0; ray.dir.y = -1; ray.dir.z = 0;
    const w = this.world.raw;
    const h = w.broadPhase.castRayAndGetNormal(w.narrowPhase, w.bodies, w.colliders, ray, maxDist, true, this.fFixed);
    if (!h) return null;
    const n = h.normal;
    const l = Math.hypot(n.x, n.y, n.z);
    // the floor's normal faces up, whichever way its triangle was wound
    const s = l > 1e-9 ? (n.y < 0 ? -1 / l : 1 / l) : 0;
    return { y: origin.y - h.timeOfImpact, normal: l > 1e-9 ? { x: n.x * s + 0, y: n.y * s + 0, z: n.z * s + 0 } : { x: 0, y: 1, z: 0 } };
  }

  /**
   * `PositionSpec` without y: the static ground under (x, z), seen from y = +400; null when there is none (motion §6.1).
   *
   * Two rays, a millimetre apart. Measured on 0.21: a ray that meets a trimesh exactly on a vertex its triangles share can
   * pass between them, and a box over 1.5 m half extent is a trimesh cut along the halvings of its faces, so authored
   * coordinates land on such vertices (a quarter turn of a 15 × 26.2 × 12 m block: 32 of 11,300 probes on a 12.5 cm grid
   * answered the floor inside the block, 26.2 m under its roof). The second ray cannot sit on the same vertex. The first
   * one's answer stands unless the second finds ground more than a centimetre higher (a leak, or a ledge within the
   * millimetre) or the first found none.
   */
  groundY(x: number, z: number): number | null {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
    const o = this.from;
    o.x = x; o.y = GROUND_PROBE_Y; o.z = z;
    const a = this.castDown(o, GROUND_PROBE_RANGE);
    o.x = x + GROUND_PROBE_SHIFT_X; o.z = z + GROUND_PROBE_SHIFT_Z;
    const b = this.castDown(o, GROUND_PROBE_RANGE);
    if (!a) return b ? b.y : null;
    return b && b.y - a.y > GROUND_PROBE_STEP ? b.y : a.y;
  }

  /** true when no fixed collider stands between `from` and `to` */
  clearLine(from: Readonly<Vec3>, to: Readonly<Vec3>): boolean {
    if (!this.world.built) return false;
    const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
    const d = Math.hypot(dx, dy, dz);
    if (!(d > 1e-9)) return true;
    const ray = this.ray;
    ray.origin.x = from.x; ray.origin.y = from.y; ray.origin.z = from.z;
    ray.dir.x = dx / d; ray.dir.y = dy / d; ray.dir.z = dz / d;
    const w = this.world.raw;
    return w.broadPhase.castRay(w.narrowPhase, w.bodies, w.colliders, ray, d, true, this.fFixed) === null;
  }

  /**
   * Touch aim friction (io §4.8.4): the chest (capsule centre) and head (capsule top minus its radius) points of character
   * bodies matching the supplied tags that are within `maxDist` of `eye`, within `radius` of the ray from `eye` along `dir`, and that a
   * static ray from `eye` reaches unblocked. Sorted by distance. Spectating (disabled) bodies are no targets.
   */
  aimTargets(eye: Readonly<Vec3>, dir: Readonly<Vec3>, maxDist: number, radius: number, options: AimTargetOptions = {}): AimTarget[] {
    const out: AimTarget[] = [];
    if (!this.world.built) return out;
    const dl = Math.hypot(dir.x, dir.y, dir.z);
    if (!(dl > 0) || !(maxDist > 0) || !(radius >= 0)) return out;
    const ux = dir.x / dl, uy = dir.y / dl, uz = dir.z / dl;
    const colliders = this.world.colliders;
    const P = { x: 0, y: 0, z: 0 };
    for (const c of this.world.characters) {
      if (!c.enabled || c.rowId === null) continue;
      const rec = colliders.owner(c.collider.handle);
      if (!rec || (options.tags?.length && !options.tags.some(tag => rec.tags.includes(tag)))) continue;
      // quick reject on the capsule's centre line
      const hx = c.feet.x - eye.x, hz = c.feet.z - eye.z;
      if (hx * hx + hz * hz > (maxDist + c.radius) * (maxDist + c.radius)) continue;
      for (let k = 0; k < 2; k++) {
        P.x = c.feet.x; P.z = c.feet.z;
        P.y = c.feet.y + (k === 0 ? c.height / 2 : Math.max(c.height - c.radius, c.height / 2));
        const px = P.x - eye.x, py = P.y - eye.y, pz = P.z - eye.z;
        const dist = Math.hypot(px, py, pz);
        if (dist > maxDist) continue;
        // distance of the point to the ray (a half line: behind the eye the nearest point is the eye)
        const t = Math.max(0, px * ux + py * uy + pz * uz);
        const off = Math.hypot(px - ux * t, py - uy * t, pz - uz * t);
        if (off > radius) continue;
        if (!this.clearLine(eye, P)) continue;
        out.push({ id: c.rowId, point: { x: P.x, y: P.y, z: P.z }, distance: dist });
      }
    }
    return out.sort((a, b) => a.distance - b.distance || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }
}

// ── port-level entry points ──────────────────────────────────────────────────────────────────────────────────────────────

let resolver: ((place: string) => RapierQueryWorld | null) | null = null;

/** installed by the physics port: place id → its query world (null when the place is not resident or has no world yet) */
export function bindQueryWorlds(r: ((place: string) => RapierQueryWorld | null) | null): void {
  resolver = r;
}

/**
 * Port-only (not a builtin): touch aim friction (io §4.8.4). Candidate points are the capsule centre (chest) and the capsule
 * top minus its radius (head) of character bodies matching the supplied tags, within `maxDist` of `eye`; a candidate
 * counts when its distance to the ray is <= `radius` and a static ray from `eye` reaches it unblocked. An unbuilt or
 * non-resident place answers [].
 */
export function aimTargets(place: string, eye: Vec3, dir: Vec3, maxDist: number, radius: number, options: AimTargetOptions = {}): AimTarget[] {
  return resolver?.(place)?.aimTargets(eye, dir, maxDist, radius, options) ?? [];
}

/** scratch for callers that hold a query as plain vectors */
export const rayQuery = (origin: Readonly<Vec3>, dir: Readonly<Vec3>, distance: number, over: Partial<RayQuery> = {}): RayQuery => ({
  origin: v3(origin.x, origin.y, origin.z), dir: v3(dir.x, dir.y, dir.z), distance, radius: 0, bodies: 'all', ignore: [], tags: [], excludeTags: [], both: false, ...over,
});
