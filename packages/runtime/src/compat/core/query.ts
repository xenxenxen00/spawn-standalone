// ctx.getObject and ctx.query (docs/design/core-runtime.md §6, §10.3; docs/architecture.md X-24; contract §5.1-5.2, §26).
//
// getObject(id): the alive row, or null when it is missing, in a place that is not resident, or in another place than the
// caller's [DOC sk/rooms-and-matchmaking:44], with three exceptions the live game depends on: (1) a sim (and the scene loader and
// the kernel) reads any resident row; (2) the UI realm reads any row (contract §5.1); (3) player bodies are readable from any place.
//
// query(opts):
//   place                  the place searched; omitted → the caller's (a row's place; a place sim's place; the root sim, the
//                          kernel and the UI → world.defaultPlace: "a place-less query only sees the sim's own place")
//   non-resident place     [] at once
//   tags / anyTags / excludeTags   all / at least one / none
//   radius (+ center)      3D distance from `center` (default: the calling row's world feet) to each row's world feet ≤ radius;
//                          a caller without a row (a sim) and without `center` ignores `radius`
//   ignoreSelf             default true
//   select: 'ids'          ids instead of handles
//   objectId               only the row whose `world:ss#<id>` it is
//   always excluded        the camera rig row; dead rows
//   order                  spawn serial
// Candidates come from the smallest tag set, else the union of the anyTags sets, else (radius over a large place) the 16 m
// spatial grid widened by ATTACH_SLACK_M (it buckets bone-attached rows by their parent's frame) plus the rows outside the grid
// (camera-attached), else the place's rows; the exact tests run on each candidate.
//
// X-24 (core §10.3): rows with `audience: 'local'` created on the client VM are invisible to reads made from the platform VM:
// getObject answers null and query leaves them out (handles.ts applies the same rule to `children`). Client-VM and UI reads see
// them. Handles are returned in the caller's realm (store.handle: one per row and VM, one for the UI).
import type { CoreKernel } from './kernel.ts';
import { rowIdOfObjectId } from './ids.ts';
import type { CallerRef, ObjectView, PlaceId, PlaceManager, QueryOptions, RowId, RowRec, Vec3 } from './types.ts';
import type { Realm } from './store/proxies.ts';
import { worldPose } from './store/transform.ts';

/** who reads: a kernel verb's caller, or the UI page realm */
export type Viewer = CallerRef | { readonly kind: 'ui' };

/** the kernel members query.ts reads (`places` may still be unwired: KernelNotWiredError) */
export type QueryKernel = Pick<CoreKernel, 'store' | 'worldConfig' | 'placeIndex' | 'places'>;

/** the spatial grid buckets a bone- or socket-attached row by its parent's frame: widen the grid search by this much (m) */
export const ATTACH_SLACK_M = 8;
/** below this many rows in the place a radius query just walks them */
const GRID_MIN_ROWS = 64;

interface ViewerInfo {
  readonly realm: Realm;
  /** the caller's own place (null: none) */
  readonly place: PlaceId | null;
  /** the calling row (ignoreSelf, default center) */
  readonly self: RowRec | null;
  /** getObject reads rows of any (resident) place */
  readonly anyPlace: boolean;
}

function viewerInfo(v: Viewer): ViewerInfo {
  switch (v.kind) {
    case 'row':
      return { realm: v.row.vm, place: v.row.place, self: v.row, anyPlace: v.row.place === null };
    case 'sim':
      return { realm: 'platform', place: v.sim.place, self: null, anyPlace: true };
    case 'scene':
      return { realm: 'platform', place: v.place, self: null, anyPlace: true };
    case 'kernel':
      return { realm: 'platform', place: null, self: null, anyPlace: true };
    case 'ui':
      return { realm: 'ui', place: null, self: null, anyPlace: true };
  }
}

/** the realm a viewer's handles belong to */
export function realmOf(v: Viewer): Realm {
  return viewerInfo(v).realm;
}

/** X-24: whether a read from `realm` sees `row` (a client-made `audience: 'local'` row is invisible to the platform VM) */
export function visibleTo(realm: Realm, row: RowRec): boolean {
  return !(realm === 'platform' && row.vm === 'client' && row.audience === 'local');
}

/** kernels whose `places` getter threw KernelNotWiredError (it is a class getter: it throws for the kernel's whole life unless
 *  an own property shadows it), so the hot paths do not pay for a thrown Error per call */
const UNWIRED = new WeakSet<object>();

/** the place manager, or null while it is not wired (C4) */
export function placesOf(k: Pick<QueryKernel, 'places'>): PlaceManager | null {
  if (UNWIRED.has(k) && !Object.hasOwn(k, 'places')) return null;
  try {
    return k.places;
  } catch (err) {
    if (!(err instanceof Error) || err.name !== 'KernelNotWiredError') throw err;
    UNWIRED.add(k);
    return null;
  }
}

/** whether a place stands (active, dormant or loading); before the place manager is wired (C4): a roster place */
export function isResident(k: Pick<QueryKernel, 'places' | 'placeIndex'>, place: PlaceId): boolean {
  const pm = placesOf(k);
  if (pm !== null) return pm.residency(place) !== 'absent';
  const roster = k.placeIndex.placeIndex;
  return Object.hasOwn(roster, place) || Object.keys(roster).length === 0;
}

/** ctx.getObject (contract §5.1, core §6) */
export function getObject(k: QueryKernel, viewer: Viewer, id: unknown): ObjectView | null {
  if (typeof id !== 'string') return null;
  const row = k.store.get(id);
  if (!row || row.phase !== 'alive') return null;
  const v = viewerInfo(viewer);
  if (!visibleTo(v.realm, row)) return null;
  if (row.place !== null) {
    if (!isResident(k, row.place)) return null;
    if (!v.anyPlace && row.player === null && row.place !== v.place) return null;
  }
  return k.store.handle(row, v.realm);
}

const isFiniteVec3 = (c: unknown): c is Vec3 =>
  typeof c === 'object' &&
  c !== null &&
  Number.isFinite((c as Vec3).x) &&
  Number.isFinite((c as Vec3).y) &&
  Number.isFinite((c as Vec3).z);

/** a tag option: an array of strings (a lone string counts as one tag) */
function tagList(v: unknown): readonly string[] {
  if (typeof v === 'string') return [v];
  if (!Array.isArray(v)) return [];
  return v.filter((t): t is string => typeof t === 'string');
}

const bySerial = (a: RowRec, b: RowRec): number => a.serial - b.serial;

/** ctx.query (contract §5.2, core §6) */
export function query(k: QueryKernel, viewer: Viewer, opts: QueryOptions & { select: 'ids' }): RowId[];
export function query(k: QueryKernel, viewer: Viewer, opts?: QueryOptions): ObjectView[];
export function query(k: QueryKernel, viewer: Viewer, opts?: QueryOptions): ObjectView[] | RowId[];
export function query(k: QueryKernel, viewer: Viewer, opts: QueryOptions = {}): ObjectView[] | RowId[] {
  const o: QueryOptions = opts !== null && typeof opts === 'object' ? opts : {};
  const v = viewerInfo(viewer);
  const store = k.store;
  const place = typeof o.place === 'string' ? o.place : (v.place ?? k.worldConfig.defaultPlace);
  if (!isResident(k, place)) return [];

  const tags = tagList(o.tags);
  const anyTags = tagList(o.anyTags);
  const excludeTags = tagList(o.excludeTags);
  const ignoreSelf = o.ignoreSelf !== false;
  const self = v.self;

  let radius: number | null = typeof o.radius === 'number' && !Number.isNaN(o.radius) ? o.radius : null;
  let center: Vec3 | null = null;
  if (radius !== null) {
    if (isFiniteVec3(o.center)) center = { x: o.center.x, y: o.center.y, z: o.center.z };
    else if (self !== null) center = worldPose(store, self).pos;
    if (center === null) radius = null; // a sim without center ignores radius
    else if (radius < 0) return [];
  }

  // candidates
  let candidates: Iterable<RowRec>;
  if (o.objectId !== undefined) {
    const id = typeof o.objectId === 'string' ? rowIdOfObjectId(o.objectId, k.store.worldId) : null;
    const r = id !== null ? store.get(id) : undefined;
    candidates = r ? [r] : [];
  } else if (tags.length > 0) {
    let best: ReadonlySet<RowRec> | null = null;
    for (const t of tags) {
      const s = store.byTag(place, t);
      if (best === null || s.size < best.size) best = s;
      if (s.size === 0) break;
    }
    candidates = best ?? [];
  } else if (anyTags.length > 0) {
    if (anyTags.length === 1) candidates = store.byTag(place, anyTags[0]!);
    else {
      const set = new Set<RowRec>();
      for (const t of anyTags) for (const r of store.byTag(place, t)) set.add(r);
      candidates = [...set].sort(bySerial);
    }
  } else {
    const all = store.byPlace(place);
    if (radius !== null && center !== null && Number.isFinite(radius) && all.size > GRID_MIN_ROWS) {
      const grid = store.spatial(place);
      const near = new Set(grid.near(center, radius + ATTACH_SLACK_M));
      const list: RowRec[] = [];
      for (const r of all) if (grid.has(r) ? near.has(r) : true) list.push(r);
      candidates = list;
    } else candidates = all;
  }

  const r2 = radius !== null && Number.isFinite(radius) ? radius * radius : null;
  const ids = o.select === 'ids';
  const out: Array<ObjectView | RowId> = [];
  for (const r of candidates) {
    if (r.phase !== 'alive' || r.place !== place || r.rig !== null) continue;
    if (ignoreSelf && r === self) continue;
    if (!visibleTo(v.realm, r)) continue;
    if (tags.length > 0 && !tags.every((t) => r.tags.includes(t))) continue;
    if (anyTags.length > 0 && !anyTags.some((t) => r.tags.includes(t))) continue;
    if (excludeTags.length > 0 && excludeTags.some((t) => r.tags.includes(t))) continue;
    if (r2 !== null && center !== null) {
      const p = worldPose(store, r).pos;
      const dx = p.x - center.x;
      const dy = p.y - center.y;
      const dz = p.z - center.z;
      if (!(dx * dx + dy * dy + dz * dz <= r2)) continue;
    }
    out.push(ids ? r.id : store.handle(r, v.realm));
  }
  return out as ObjectView[] | RowId[];
}
