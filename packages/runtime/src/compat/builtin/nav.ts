// `builtin/nav` for the carried game code (motion §7, contract §10.2): `findPath(ctx, from, to, opts)`.
//
// Live callers (motion §7.1): the enemies' `planRoute` and `reachableFrom` (authored module), the bots' `planRoute`
// (authored module) and the navigation preview (authored module). What they rely on:
//   - `{ points, ok }`: feet positions; `ok: false` = a partial, which still carries points (enemies and bots walk them, the
//     unstick test reads `points.length > 0` as reachable, the trail finishes a partial that ends within 7 m of the target);
//   - no path at all is `{ points: [], ok: false }`; the callers retry on their next beat;
//   - the search reaches about 11 m per call from a platform-VM caller and about 17 m from a client-VM caller (X-41,
//     `nav.horizonM`, read on every call; `'none'` is the A/B option).
// `partial` (the trail's "ground still streaming" retry) is never set: a place's grid is whole or absent here.
//
// Reads `ctx` only for `place.id`, `self.id` and, when an option is omitted, the caller's own body (`self.physics`). The
// grid, the bodies of the overlay, the caller's machine and the sim tick come from the binding (`bindNav`; nav/port.ts
// installs it from a kernel and the physics port). Until a binding exists, and for a place that is not built or ships no
// grid (X-32, X-31), every call answers no path.
//
// Per-tick guard (motion §7.4 item 11): once the calls of one sim tick have done more than NAV_TICK_BUDGET units of work,
// further calls in that tick answer no path. The work is counted, never timed (`navWork`): the 4 ms wall-clock budget it
// replaces made the same seed answer differently on a busy machine (a refused call in one run, a path in the next). `navStats()`
// counts the refused calls (the soak asserts zero at the 30 + 5 scenario, motion §10.2); its milliseconds are metrics only.
import type { Vec3, VmId } from '../core/types.ts';
import { OverlayStamps, overlayFootprints, type OverlayBody } from '../nav/overlay.ts';
import { NAV_DEFAULTS, navSearch, type NavGrid, type NavSearch } from '../nav/search.ts';
import { perfNow } from '../core/perf-now.ts';
import { portFlag } from './port.ts';

export type { Vec3 } from '../core/types.ts';

export interface FindPathOpts {
  radius?: number;
  height?: number;
  step?: number;
  slope?: number;
  maxDrop?: number;
  bodies?: 'all' | 'static';
  ignore?: string[];
  budget?: number;
}

export interface FindPathResult {
  points: Vec3[];
  ok: boolean;
  partial?: boolean;
}

/** the slice of a game ctx this builtin reads (the binding may read more of it to tell the caller's machine) */
export interface NavCtx {
  readonly place?: { readonly id: string } | null;
  readonly self?: { readonly id: string; readonly physics?: unknown } | null;
  readonly session?: unknown;
}

/** a body of the place with the capsule the physics port gives a character */
type CallerBody = OverlayBody & { readonly capsule?: { readonly height: number; readonly radius: number } };

export interface NavBinding {
  /** the place's grid; null while the place is not built or its bake ships none */
  grid(place: string): NavGrid | null;
  /** the bodies of the place now (the physics port's `bodyRecords`); omitted: nothing but the grid blocks */
  bodies?(place: string): readonly OverlayBody[];
  /** true for a row the place's grid already holds (an immutable static row of its pack) */
  inGrid?(place: string, rowId: string): boolean;
  /** the machine the calling ctx runs on; unknown → the platform horizon, with one warning */
  vm?(ctx: NavCtx): VmId | undefined;
  /** the sim tick, the key of the per-tick guard; omitted: no guard */
  tick?(): number;
  /** milliseconds for the dev metrics only, never for a decision (default `performance.now()`) */
  now?(): number;
  warn?(message: string): void;
  /** tools: the horizon in metres instead of the `nav.horizonM` flag (Infinity = none); undefined → the flag */
  horizon?(vm: VmId): number | undefined;
}

/**
 * motion §7.4 item 11: the work one sim tick may do in `findPath` before further calls in it answer no path. Checked before a
 * call, as the 4 ms it replaces was, so the call that crosses it still finishes. A work unit is about 1 µs on the reference
 * machine (Node 24, the sim bench at 30 + 5: 0.99 µs per unit on both bench maps, 2026-10-20); 8,000 units is the smallest
 * round budget that admits every call of an idle bench run with margin (its heaviest tick: 6,283 units, 3.9 ms), so the bench
 * keeps its zero guard hits.
 */
export const NAV_TICK_BUDGET = 8_000;
/** work units of a call that reached a grid, besides what `navWork` counts by size (locate, snap, smoothing, the result) */
export const NAV_CALL_WORK = 64;
/** bodies of the place one work unit pays for (the overlay and the caller's own capsule scan every one, every call) */
export const NAV_BODIES_PER_WORK = 2;

/**
 * The work units of one call that reached a grid: its A* expansions, the spans its overlay stamped, its share of the bodies it
 * scanned, and NAV_CALL_WORK. Integers from the query alone: the same query on the same state counts the same everywhere.
 */
export function navWork(expansions: number, stamped: number, bodies: number): number {
  return NAV_CALL_WORK + expansions + stamped + Math.ceil(bodies / NAV_BODIES_PER_WORK);
}

/** X-41 defaults, used when the flag holds nothing usable */
const HORIZON: Readonly<Record<VmId, number>> = { platform: 11, client: 17 };

let binding: NavBinding | null = null;
const warned = new Set<string>();
const stamps = new WeakMap<NavSearch, OverlayStamps>();
let guardTick = NaN;
let spentWork = 0;
let spentMs = 0;
const stats = { calls: 0, guardHits: 0, work: 0, worstTickWork: 0, ms: 0, worstTickMs: 0, worstCallMs: 0 };

export interface NavStats {
  calls: number;
  /** calls the per-tick guard answered with no path */
  guardHits: number;
  /** work units done (`navWork`), and the most of them in one tick: what the per-tick guard reads */
  work: number;
  worstTickWork: number;
  /** wall-clock metrics: never read by a decision */
  ms: number;
  worstTickMs: number;
  worstCallMs: number;
}

/** install (or with null remove) the binding; also resets the once-only warnings and the tick guard */
export function bindNav(b: NavBinding | null): void {
  binding = b;
  warned.clear();
  guardTick = NaN;
  spentWork = 0;
  spentMs = 0;
}

/** dev metrics: calls, calls refused by the per-tick guard, search work and time spent, the costliest tick and call */
export function navStats(): Readonly<NavStats> {
  return { ...stats };
}

export function resetNavStats(): void {
  stats.calls = 0; stats.guardHits = 0; stats.work = 0; stats.worstTickWork = 0; stats.ms = 0; stats.worstTickMs = 0; stats.worstCallMs = 0;
}

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  if (binding?.warn) binding.warn(message);
  else console.warn(`[nav] ${message}`);
}

const none = (): FindPathResult => ({ points: [], ok: false });
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const finite3 = (p: unknown): p is Vec3 => isObj(p) && Number.isFinite(p['x']) && Number.isFinite(p['y']) && Number.isFinite(p['z']);
const positive = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
const nonNegative = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** the search horizon of a caller on `vm`, metres (`nav.horizonM`: `{ platform, client }`, one number, or 'none') */
function horizonOf(vm: VmId): number {
  const f = portFlag('nav.horizonM');
  if (f === 'none') return Infinity;
  if (nonNegative(f)) return f;
  if (isObj(f)) {
    const v = f[vm];
    if (v === 'none') return Infinity;
    if (nonNegative(v)) return v;
  }
  return HORIZON[vm];
}

/** the caller's own size, step and climb angle for the options it left out (motion §7.4 item 1) */
function callerBody(ctx: NavCtx, bodies: readonly OverlayBody[] | null): { radius?: number; height?: number; step?: number; slope?: number } {
  const out: { radius?: number; height?: number; step?: number; slope?: number } = {};
  const self = ctx.self;
  if (!isObj(self)) return out;
  let physics: unknown;
  try {
    physics = self.physics;
  } catch {
    physics = undefined;
  }
  if (bodies && typeof self.id === 'string') {
    // the world capsule, with the row's scale in it
    for (const b of bodies as readonly CallerBody[]) {
      if (b.rowId !== self.id) continue;
      if (b.capsule && positive(b.capsule.radius) && positive(b.capsule.height)) { out.radius = b.capsule.radius; out.height = b.capsule.height; }
      break;
    }
  }
  if (isObj(physics)) {
    const c = physics['capsule'];
    if (isObj(c)) {
      if (out.radius === undefined && positive(c['radius'])) out.radius = c['radius'];
      if (out.height === undefined && positive(c['height'])) out.height = c['height'];
    }
    const a = physics['autostep'];
    if (isObj(a) && positive(a['maxHeight'])) out.step = a['maxHeight'];
    const s = physics['maxSlopeClimbAngle'];
    if (nonNegative(s)) out.slope = s;
  }
  return out;
}

export function findPath(ctx: NavCtx, from: Vec3, to: Vec3, opts?: FindPathOpts): FindPathResult {
  const b = binding;
  if (!b) return none();
  stats.calls++;
  if (b.tick) {
    const tick = b.tick();
    if (tick !== guardTick) { guardTick = tick; spentWork = 0; spentMs = 0; }
    else if (spentWork > NAV_TICK_BUDGET) { stats.guardHits++; return none(); }
  }
  const now = b.now ?? clock;
  const t0 = now();
  const work = { n: 0 };
  try {
    return run(b, ctx, from, to, opts, work);
  } finally {
    spentWork += work.n;
    stats.work += work.n;
    if (b.tick && spentWork > stats.worstTickWork) stats.worstTickWork = spentWork;
    const dt = Math.max(0, now() - t0);
    spentMs += dt;
    stats.ms += dt;
    if (dt > stats.worstCallMs) stats.worstCallMs = dt;
    if (b.tick && spentMs > stats.worstTickMs) stats.worstTickMs = spentMs;
  }
}

const clock = (): number => perfNow();

/**
 * `findPath` against a binding of the caller's own instead of the installed one: no per-tick guard, no stats, nothing global
 * read but the port flags (tools/nav/audit-navgraph.ts walks the authored nav graph with it).
 */
export function findPathWith(b: NavBinding, ctx: NavCtx, from: Vec3, to: Vec3, opts?: FindPathOpts): FindPathResult {
  return run(b, ctx, from, to, opts);
}

function run(b: NavBinding, ctx: NavCtx, from: Vec3, to: Vec3, opts: FindPathOpts | undefined, work?: { n: number }): FindPathResult {
  const place = isObj(ctx) && isObj(ctx.place) ? ctx.place.id : undefined;
  if (typeof place !== 'string' || !finite3(from) || !finite3(to)) return none();
  const grid = b.grid(place);
  if (!grid) return none();
  const o: FindPathOpts = isObj(opts) ? opts : {};
  const bodies = b.bodies ? b.bodies(place) : null;

  let radius = o.radius, height = o.height, step = o.step, slope = o.slope;
  if (!positive(radius) || !positive(height) || !nonNegative(step) || !nonNegative(slope)) {
    const own = callerBody(ctx, bodies);
    if (!positive(radius)) radius = own.radius ?? NAV_DEFAULTS.radius;
    if (!positive(height)) height = own.height ?? NAV_DEFAULTS.height;
    if (!nonNegative(step)) step = own.step ?? NAV_DEFAULTS.step;
    if (!nonNegative(slope)) slope = own.slope ?? NAV_DEFAULTS.slope;
  }
  const agent = { radius, height, step, slope, maxDrop: nonNegative(o.maxDrop) ? o.maxDrop : NAV_DEFAULTS.maxDrop };

  let vm = b.vm ? b.vm(ctx) : undefined;
  if (vm !== 'platform' && vm !== 'client') {
    warnOnce('vm', "findPath: the caller's machine is unknown; it gets the platform horizon (nav.horizonM)");
    vm = 'platform';
  }

  const search = navSearch(grid);
  let overlay = stamps.get(search);
  if (bodies && bodies.length > 0) {
    const mode = o.bodies === 'static' ? 'static' : 'all';
    const ignore = Array.isArray(o.ignore) ? o.ignore.filter((s): s is string => typeof s === 'string') : [];
    const inGrid = b.inGrid ? (id: string): boolean => b.inGrid!(place, id) : undefined;
    const prints = overlayFootprints(bodies, { bodies: mode, ignore, inGrid });
    if (prints.length > 0 && !overlay) stamps.set(search, overlay = new OverlayStamps(search.grid));
    overlay?.begin();
    if (prints.length > 0) overlay!.stamp(prints, agent);
  } else {
    overlay?.begin();
  }
  const r = search.find({
    from, to, agent, horizon: b.horizon?.(vm) ?? horizonOf(vm),
    budget: positive(o.budget) ? o.budget : NAV_DEFAULTS.budget,
    overlay: overlay && overlay.count > 0 ? overlay : null,
  });
  if (work) work.n = navWork(r.expansions, overlay ? overlay.count : 0, bodies ? bodies.length : 0);
  return { points: r.points, ok: r.ok };
}
