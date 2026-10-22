// Ray and sphere-cast queries over a place's physics (motion §6.1-§6.2): the static soup BVH (owners → row ids and tags) plus
// bodies (instanced static / kinematic meshes, dynamic bodies, character capsules) and, for `hits:'both'`, a render-only
// visual-proxy layer (X-42). Option semantics: `bodies` truth table, sensors and inactive (spectating) bodies never hit,
// ignore ids with their `/` children, tag filters applied inside the traversal (the nearest QUALIFYING hit), `multiple` =
// one hit per collider sorted by distance.
//
// `QueryWorld` is the seam: PH3's PhysicsWorld (world.ts, broadphase grid, visual-proxy BVH) implements it; `QueryScene` is the
// plain implementation used by tools, tests and fixture places (static soup + a body list).
// `aimTargets` (touch aim, io §4.8.4) is PH3 scope and lands with world.ts.
import { RayHit, StaticBvh, SweepHit } from './bvh.ts';
import { closestPtSegmentTriangle, sweepCapsuleTriangle, triNormalFacing, v3, type Num3, type V3, type Vec3 } from './math.ts';
import { ShapeHit, rayShape, shapeAabb, sweepCapsuleShape, type Shape } from './shapes.ts';

export type BodyKind = 'static' | 'kinematic' | 'dynamic' | 'character';
export type BodiesFilter = 'static' | 'dynamic' | 'all';

/** what a query needs to know about one body; world.ts keeps its own records and exposes them through this shape */
export interface QueryBody {
  readonly rowId: string | null;
  readonly kind: BodyKind;
  /** triggers: never hit by queries */
  readonly sensor: boolean;
  /** false while spectating / disabled: leaves all queries (core §5.8) */
  readonly active: boolean;
  readonly shape: Shape;
  readonly tags: readonly string[];
}

/** bodies whose bounds may overlap [min, max] → out (cleared first); returns the count. Over-reporting is allowed. */
export interface QueryLayer {
  candidates(min: V3, max: V3, out: QueryBody[]): number;
}

export interface QueryWorld extends QueryLayer {
  readonly place: string;
  /** false until the place's physics is built: queries answer null (X-32) */
  readonly built: boolean;
  /** immutable static colliders (incl. terrain), owner-indexed */
  readonly soup: StaticBvh | null;
  /** row id of a soup owner (`terrain/<place>` for the heightmap, null for anonymous geometry) */
  ownerId(owner: number): string | null;
  ownerTags(owner: number): readonly string[];
  /** render-only static geometry for `hits:'both'`; null until it exists (X-42) */
  visualProxies(): QueryLayer | null;
}

export interface RayQuery {
  readonly origin: V3;
  /** unit */
  readonly dir: V3;
  readonly distance: number;
  /** 0 = ray; > 0 = sphere cast */
  readonly radius: number;
  readonly bodies: BodiesFilter;
  /** ids skipped together with their `/` children */
  readonly ignore: readonly string[];
  /** the hit row must carry every one */
  readonly tags: readonly string[];
  /** the hit row must carry none */
  readonly excludeTags: readonly string[];
  /** include the visual-proxy layer (`hits:'both'`) */
  readonly both: boolean;
}

export interface QueryHit {
  id: string | null;
  /** ray: the hit point; sphere cast: the contact point on the surface */
  position: Vec3;
  /** ray: facing the ray origin; sphere cast: the surface normal at the contact, towards the sphere */
  normal: Vec3;
  /** ray: distance to the hit; sphere cast: distance the centre travelled */
  distance: number;
  tags: string[];
  body: BodyKind;
}

// ── QueryScene: the plain QueryWorld ─────────────────────────────────────────────────────────────────────────────────────

const L_MIN = v3(), L_MAX = v3();

/** a brute-force body layer (fine for a handful of bodies; world.ts uses its broadphase grid) */
export class BodyList implements QueryLayer {
  readonly bodies: QueryBody[] = [];
  constructor(bodies?: Iterable<QueryBody>) {
    if (bodies) for (const b of bodies) this.bodies.push(b);
  }
  add(b: QueryBody): QueryBody { this.bodies.push(b); return b; }
  remove(b: QueryBody): boolean {
    const i = this.bodies.indexOf(b);
    if (i < 0) return false;
    this.bodies.splice(i, 1);
    return true;
  }
  candidates(min: V3, max: V3, out: QueryBody[]): number {
    out.length = 0;
    for (const b of this.bodies) {
      shapeAabb(b.shape, L_MIN, L_MAX);
      if (L_MIN[0]! > max[0]! || L_MIN[1]! > max[1]! || L_MIN[2]! > max[2]!) continue;
      if (L_MAX[0]! < min[0]! || L_MAX[1]! < min[1]! || L_MAX[2]! < min[2]!) continue;
      out.push(b);
    }
    return out.length;
  }
}

/** static soup (added owner by owner, then built once) + a body list + an optional visual-proxy layer */
export class QueryScene implements QueryWorld {
  readonly place: string;
  soup: StaticBvh | null = null;
  private readonly ids: Array<string | null> = [];
  private readonly tagSets: Array<readonly string[]> = [];
  private readonly parts: Float32Array[] = [];
  private readonly layer = new BodyList();
  private visual: QueryLayer | null = null;

  constructor(place: string) { this.place = place; }

  get built(): boolean { return this.soup !== null; }

  /** add an owner's world-space triangles (9 floats each) before build(); returns the owner index */
  addStatic(rowId: string | null, tags: readonly string[], tris: Float32Array): number {
    if (this.soup) throw new Error(`QueryScene ${this.place}: addStatic after build`);
    this.ids.push(rowId);
    this.tagSets.push([...tags]);
    this.parts.push(tris);
    return this.ids.length - 1;
  }

  build(): StaticBvh {
    let total = 0;
    for (const p of this.parts) total += p.length;
    const soup = new Float32Array(total);
    const owners = new Uint32Array(total / 9);
    let w = 0;
    this.parts.forEach((p, owner) => {
      soup.set(p, w);
      owners.fill(owner, w / 9, (w + p.length) / 9);
      w += p.length;
    });
    this.soup = StaticBvh.build(soup, owners);
    this.parts.length = 0;
    return this.soup;
  }

  addBody(b: QueryBody): QueryBody { return this.layer.add(b); }
  removeBody(b: QueryBody): boolean { return this.layer.remove(b); }
  get bodies(): readonly QueryBody[] { return this.layer.bodies; }
  setVisualProxies(layer: QueryLayer | null): void { this.visual = layer; }

  ownerId(owner: number): string | null { return this.ids[owner] ?? null; }
  ownerTags(owner: number): readonly string[] { return this.tagSets[owner] ?? []; }
  candidates(min: V3, max: V3, out: QueryBody[]): number { return this.layer.candidates(min, max, out); }
  visualProxies(): QueryLayer | null { return this.visual; }
}

// ── filters ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

function ignored(id: string | null, ignore: readonly string[]): boolean {
  if (id === null) return false;
  for (const ig of ignore) {
    if (id === ig) return true;
    if (id.length > ig.length && id.charCodeAt(ig.length) === 47 /* '/' */ && id.startsWith(ig)) return true;
  }
  return false;
}

function tagsPass(rowTags: readonly string[], q: RayQuery): boolean {
  for (const t of q.tags) if (!rowTags.includes(t)) return false;
  for (const t of q.excludeTags) if (rowTags.includes(t)) return false;
  return true;
}

const hasRowFilter = (q: RayQuery): boolean => q.ignore.length > 0 || q.tags.length > 0 || q.excludeTags.length > 0;

function rowPasses(id: string | null, tags: readonly string[], q: RayQuery): boolean {
  return !ignored(id, q.ignore) && tagsPass(tags, q);
}

// owner filter for the soup traversal, memoised per query (owners are few, triangles many); one reused memo and closure, so
// a query adds no garbage beyond its results (queries are not re-entrant: the filter never calls back into a query)
const OWNER_MEMO = new Map<number, boolean>();
let F_WORLD: QueryWorld | null = null;
let F_QUERY: RayQuery | null = null;
const OWNER_FILTER = (owner: number): boolean => {
  let v = OWNER_MEMO.get(owner);
  if (v === undefined) {
    v = rowPasses(F_WORLD!.ownerId(owner), F_WORLD!.ownerTags(owner), F_QUERY!);
    OWNER_MEMO.set(owner, v);
  }
  return v;
};

function ownerFilter(world: QueryWorld, q: RayQuery): ((owner: number) => boolean) | null {
  if (!hasRowFilter(q)) return null;
  OWNER_MEMO.clear();
  F_WORLD = world;
  F_QUERY = q;
  return OWNER_FILTER;
}

function kindPasses(b: QueryBody, bodies: BodiesFilter): boolean {
  if (!b.active || b.sensor) return false;
  if (bodies === 'all') return true;
  return bodies === 'static' ? b.kind === 'static' : b.kind === 'dynamic';
}

// ── queries ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

const Q_RAY = new RayHit();
const Q_SWEEP = new SweepHit();
const Q_SHAPE = new ShapeHit();
const Q_BODIES: QueryBody[] = [];
const Q_MIN = v3(), Q_MAX = v3();

function sweptBounds(q: RayQuery, dist: number): void {
  for (let i = 0; i < 3; i++) {
    const a = q.origin[i]!, b = a + q.dir[i]! * dist;
    Q_MIN[i] = Math.min(a, b) - q.radius;
    Q_MAX[i] = Math.max(a, b) + q.radius;
  }
}

function makeHit(id: string | null, tags: readonly string[], body: BodyKind, t: number, p: Num3, n: Num3): QueryHit {
  return {
    id, distance: t, body, tags: [...tags],
    position: { x: p[0]!, y: p[1]!, z: p[2]! },
    normal: { x: n[0]!, y: n[1]!, z: n[2]! },
  };
}

const P_RAY = v3();
function rayPoint(q: RayQuery, t: number): V3 {
  P_RAY[0] = q.origin[0]! + q.dir[0]! * t; P_RAY[1] = q.origin[1]! + q.dir[1]! * t; P_RAY[2] = q.origin[2]! + q.dir[2]! * t;
  return P_RAY;
}

/** hit one body (ray or sphere cast) within tMax → Q_SHAPE */
function hitBody(b: QueryBody, q: RayQuery, tMax: number): boolean {
  return q.radius > 0
    ? sweepCapsuleShape(b.shape, q.origin, q.origin, q.radius, q.dir, tMax, Q_SHAPE)
    : rayShape(b.shape, q.origin, q.dir, tMax, Q_SHAPE);
}

/** the nearest qualifying hit within q.distance, or null */
export function castRay(world: QueryWorld, q: RayQuery): QueryHit | null {
  if (!world.built) return null;
  let best = q.distance;
  let hit: QueryHit | null = null;
  const soup = world.soup;
  if (soup && q.bodies !== 'dynamic') {
    const filter = ownerFilter(world, q);
    if (q.radius > 0) {
      if (soup.sweepSphere(q.origin, q.radius, q.dir, best, filter, Q_SWEEP)) {
        best = Q_SWEEP.t;
        hit = makeHit(world.ownerId(Q_SWEEP.owner), world.ownerTags(Q_SWEEP.owner), 'static', best, Q_SWEEP.point, Q_SWEEP.normal);
      }
    } else if (soup.raycast(q.origin, q.dir, best, filter, Q_RAY)) {
      best = Q_RAY.t;
      hit = makeHit(world.ownerId(Q_RAY.owner), world.ownerTags(Q_RAY.owner), 'static', best, rayPoint(q, best), Q_RAY.normal);
    }
  }
  hit = nearestBody(world, q.bodies, q, hit, best);
  if (q.both && q.bodies !== 'dynamic') {
    const v = world.visualProxies();
    if (v) hit = nearestBody(v, 'static', q, hit, hit ? hit.distance : q.distance);
  }
  Q_BODIES.length = 0;
  return hit;
}

/** the nearest qualifying body of a layer closer than `best` (or `hit` unchanged) */
function nearestBody(layer: QueryLayer, kinds: BodiesFilter, q: RayQuery, hit: QueryHit | null, best: number): QueryHit | null {
  sweptBounds(q, best);
  layer.candidates(Q_MIN, Q_MAX, Q_BODIES);
  for (const b of Q_BODIES) {
    if (!kindPasses(b, kinds)) continue;
    if (!rowPasses(b.rowId, b.tags, q)) continue;
    if (hitBody(b, q, best) && (Q_SHAPE.t < best || hit === null)) {
      best = Q_SHAPE.t;
      hit = makeHit(b.rowId, b.tags, b.kind, best, Q_SHAPE.point, Q_SHAPE.normal);
    }
  }
  return hit;
}

const A_SEG = v3(), A_TRI = v3(), A_N = v3(), A_P = v3();
const A_LIST: number[] = [];

/** every qualifying hit within q.distance, one per collider (the nearest), sorted by distance */
export function castRayAll(world: QueryWorld, q: RayQuery): QueryHit[] {
  if (!world.built) return [];
  const out: QueryHit[] = [];
  const soup = world.soup;
  if (soup && q.bodies !== 'dynamic') {
    const filter = ownerFilter(world, q);
    const nearest = new Map<number, { t: number; tri: number }>();
    if (q.radius > 0) {
      sweptBounds(q, q.distance);
      soup.queryAabb(Q_MIN, Q_MAX, A_LIST);
      for (const tri of A_LIST) {
        const owner = soup.owners[tri]!;
        const t = sweepCapsuleTriangle(q.origin, q.origin, q.radius, q.dir, q.distance, soup.tris, tri * 9, true);
        if (t < 0) continue;
        const cur = nearest.get(owner);
        if ((cur === undefined || t < cur.t) && (filter === null || filter(owner))) nearest.set(owner, { t, tri });
      }
    } else {
      soup.raycastEach(q.origin, q.dir, q.distance, (tri, t, owner) => {
        const cur = nearest.get(owner);
        if ((cur === undefined || t < cur.t) && (filter === null || filter(owner))) nearest.set(owner, { t, tri });
      });
    }
    for (const [owner, { t, tri }] of nearest) {
      let p: V3, n: V3;
      if (q.radius > 0) {
        for (let i = 0; i < 3; i++) A_SEG[i] = q.origin[i]! + q.dir[i]! * t;
        const d2 = closestPtSegmentTriangle(A_SEG, A_SEG, soup.tris, tri * 9, A_P, A_TRI);
        if (d2 > 1e-18) { const l = Math.sqrt(d2); for (let i = 0; i < 3; i++) A_N[i] = (A_SEG[i]! - A_TRI[i]!) / l; } else triNormalFacing(soup.tris, tri * 9, q.dir[0]!, q.dir[1]!, q.dir[2]!, A_N);
        p = A_TRI; n = A_N;
      } else {
        p = rayPoint(q, t);
        n = triNormalFacing(soup.tris, tri * 9, q.dir[0]!, q.dir[1]!, q.dir[2]!, A_N);
      }
      out.push(makeHit(world.ownerId(owner), world.ownerTags(owner), 'static', t, p, n));
    }
  }
  const layers: QueryLayer[] = [world];
  if (q.both) {
    const v = world.visualProxies();
    if (v && q.bodies !== 'dynamic') layers.push(v);
  }
  sweptBounds(q, q.distance);
  for (const layer of layers) {
    layer.candidates(Q_MIN, Q_MAX, Q_BODIES);
    for (const b of Q_BODIES) {
      if (!kindPasses(b, layer === world ? q.bodies : 'static')) continue;
      if (!rowPasses(b.rowId, b.tags, q)) continue;
      if (hitBody(b, q, q.distance)) out.push(makeHit(b.rowId, b.tags, b.kind, Q_SHAPE.t, Q_SHAPE.point, Q_SHAPE.normal));
    }
  }
  Q_BODIES.length = 0;
  return out.sort((a, b) => a.distance - b.distance);
}
