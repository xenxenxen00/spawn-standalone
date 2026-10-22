// Budgeted A* over the baked NavGrid with per-call agent parameters (motion §7.4, D-MPN-02; WP NV2).
//
//   start / goal   the span under `from` / `to` (0.6 m up, 2 m down, then the 8 neighbour columns). No start span: no points.
//   passable       clear ≥ height, wall ≥ radius, slope ≤ slope limit, not blocked by the query's overlay.
//   the way out    a body does stand where its class is not "passable": pressed against a wall (inside the clearance band its
//                  own radius defines) or against a stamped body. The start span is never tested, and from it the path may
//                  leave: across clearance-band spans as long as the wall distance grows with every move, and across stamped
//                  spans within one radius of the start (a stamped footprint is its body plus a radius on every side, so
//                  crossing one takes more than two). Neither lets a path enter or cross what the class does not fit.
//   moves          8-connected. Walk: the neighbour span with |Δy| ≤ step. Drop (one way, orthogonal moves only): the span
//                  below the edge, at most maxDrop down, with room to fall through. A diagonal needs both orthogonal
//                  neighbours as passable walk moves (no corner cutting).
//   drop landing   the cells right under a solid face lie inside every agent's wall clearance, so a literal "drop to the
//                  neighbour span" would never leave a block, a dock or a roof. The fall lands where the body does: on the
//                  first span from under the edge on, along the move, that the agent can stand on, at most
//                  ceil(radius / 0.25 m) cells out, over spans with head room and walk steps between them.
//   cost           0.25 m per cell (× √2 diagonal) + 0.5 × |Δy|; heuristic octile xz + |Δy| (motion §7.4 item 5, as written:
//                  it overweights height on purpose, so partials end on the goal's level when they can).
//   order          a binary heap on (f, insertion sequence): equal f pops the newer entry first. No Map or Set iteration, no
//                  randomness: the same query on the same grid answers the same points.
//   result         goal popped → ok. Budget spent or open set empty → the partial: the path to the expanded span closest to
//                  the goal (by heuristic, ties by lower cost; the start only if nothing else was expanded), ok false.
//   goal snapping  a goal the agent cannot stand on (no span there, inside the wall clearance, under a stamped body) is
//                  replaced by the nearest span it can stand on within 1.5 m; reaching that one is the partial (`end:
//                  'near'`, ok false). Without it every chase of a player backed against a wall would expand the whole
//                  reachable area before answering the same point.
//   horizon        X-41: spans whose cell centre lies farther than `horizon` from `from` (xz) are never expanded. When the
//                  goal itself lies beyond it, the search stops at the first popped span within 0.375 m of the best
//                  heuristic any span inside the horizon could have (open ground: a straight run to the rim instead of the
//                  whole disc); behind obstacles that bound is never met and the disc is searched out. A goal inside the
//                  horizon whose cell centre lies outside it counts as beyond: its span is never expanded either.
//   early-out      when the permissive component graph proves the goal unreachable the budget is 4,000 (motion §7.4 item 6).
//                  Only for a class at least as strict as PERMISSIVE. The graph is the bake's links plus the drop landings
//                  above, which the bake's own links (span below the edge only) do not hold; they are added here once per
//                  grid, by the same rule the search moves by, so the early-out stays conservative.
//
// State is per grid (`NavSearch`): typed arrays sized to the span count, stamped by generation, so a query allocates only
// its result.
import type { NavGrid } from '../core/ports.ts';
import type { Vec3 } from '../core/types.ts';
import {
  COMP_NONE, COMP_OVERFLOW, NAV_CELL, NAV_DX, NAV_DZ, NavGridData, PERMISSIVE, Y_UNIT, agentUnits, type AgentParams, type AgentUnits,
} from './navgrid.ts';
import { smoothPath, walkStep } from './smooth.ts';

export type { NavGrid } from '../core/ports.ts';

/** the engine else-values of the options a caller omits (motion §7.4 item 1) */
export const NAV_DEFAULTS: Readonly<AgentParams & { budget: number }> = Object.freeze({ radius: 0.35, height: 1.8, step: 0.4, slope: 45, maxDrop: 3, budget: 60_000 });
/** the budget of a search whose goal the permissive component graph proves unreachable */
export const EARLY_OUT_BUDGET = 4_000;
/** the window `from` / `to` are located in (motion §7.4 item 2) */
export const LOCATE_UP = 0.6;
export const LOCATE_DOWN = 2.0;
/** a goal the agent cannot stand on snaps to the nearest span it can, this many cells around it */
const SNAP_CELLS = 6;
/** how close to the best possible heuristic inside the horizon a span must be to end the search (metres) */
const HORIZON_SLACK = 1.5 * NAV_CELL;
const SQRT2 = Math.SQRT2;
/**
 * The heuristic's metres per cell: a cell and 1/256 more. On open ground every monotone staircase between two cells costs the
 * same, and an exact heuristic expands the whole parallelogram of them; the nudge makes the nearer-the-goal entry win every
 * such tie (a route is at most 0.4 % longer than the shortest).
 */
const H_CELL = NAV_CELL * (1 + 1 / 256);
/** floors are stored in centimetres; dividing (not multiplying by 0.01) gives the nearest double of the metre value */
const CM = 100;

export interface SearchOverlay { blocked(s: number): boolean }

export interface SearchQuery {
  from: Readonly<Vec3>;
  to: Readonly<Vec3>;
  agent: Readonly<AgentParams>;
  /** expansions; default 60,000 */
  budget?: number;
  /** metres from `from` in xz; default none */
  horizon?: number;
  overlay?: SearchOverlay | null;
}

export type SearchEnd =
  /** the goal span was reached */
  | 'goal'
  /** no span under `from` */
  | 'no-start'
  /** the agent cannot stand on the goal; the nearest span it can stand on was reached */
  | 'near'
  /** the goal lies beyond the horizon */
  | 'horizon'
  | 'budget'
  /** the open set ran empty */
  | 'open';

export interface SearchResult {
  /** feet positions: `from` on its span, the corners at cell centres, then `to` (ok) or the centre of the span the partial ends on */
  points: Vec3[];
  ok: boolean;
  end: SearchEnd;
  expansions: number;
  /** the budget was cut to EARLY_OUT_BUDGET by the component graph */
  earlyOut: boolean;
  /** the grid path under the points, span by span */
  spans: number[];
}

/** cells a fall may land out from under its edge: the agent's radius in cells, rounded up */
export function landingRun(radius: number): number {
  return Math.max(0, Math.ceil(radius / NAV_CELL - 1e-9));
}

const GRIDS = new WeakMap<object, { data: NavGridData; links: boolean }>();

/**
 * The search's view of a port `NavGrid`: the `NavGridData` itself (what `decodePlaceBake` and the baker hand out), else one
 * built over the same arrays. A grid that came without its component links never takes the early-out.
 */
export function navGridData(grid: NavGrid): { data: NavGridData; links: boolean } {
  let e = GRIDS.get(grid);
  if (e) return e;
  const g = grid as Partial<NavGridData> & NavGrid;
  if (typeof g.moveTarget === 'function' && typeof g.passable === 'function' && g.col instanceof Uint32Array && g.linkStart instanceof Uint32Array) {
    e = { data: g as NavGridData, links: true };
  } else {
    e = { data: new NavGridData(grid.h, { colStart: grid.colStart, y: grid.y, clear: grid.clear, slope: grid.slope, wall: grid.wall, comp: grid.comp }), links: false };
  }
  GRIDS.set(grid, e);
  return e;
}

const SEARCHERS = new WeakMap<object, NavSearch>();

/** the searcher of a grid (one per grid: its arrays are the size of the grid) */
export function navSearch(grid: NavGrid): NavSearch {
  let s = SEARCHERS.get(grid);
  if (!s) {
    const { data, links } = navGridData(grid);
    s = new NavSearch(data, { components: links });
    SEARCHERS.set(grid, s);
  }
  return s;
}

const stricterThanPermissive = (a: Readonly<AgentParams>): boolean =>
  a.radius >= PERMISSIVE.radius && a.height >= PERMISSIVE.height && a.step <= PERMISSIVE.step && a.slope <= PERMISSIVE.slope && a.maxDrop <= PERMISSIVE.maxDrop;

export class NavSearch {
  readonly grid: NavGridData;
  private readonly components: boolean;
  // per span: `gen << 1 | closed`; cost so far; the span the path came from
  private state: Uint32Array | null = null;
  private cost: Float32Array | null = null;
  private parent: Int32Array | null = null;
  private gen = 0;
  // the open heap: f, insertion sequence, span
  private heapF = new Float64Array(1024);
  private heapSeq = new Uint32Array(1024);
  private heapNode = new Int32Array(1024);
  private heapN = 0;
  private seq = 0;
  // cells the last drop landing ran beyond the span under the edge
  private ranCells = 0;
  // the component graph with drop landings: CSR over component ids
  private reachStart: Uint32Array | null = null;
  private reachTo: Uint16Array | null = null;
  private reachSeen: Uint32Array | null = null;
  private reachQueue: Uint32Array | null = null;
  private reachStamp = 0;

  constructor(grid: NavGridData, opts: { components?: boolean } = {}) {
    this.grid = grid;
    this.components = opts.components !== false;
  }

  // ── the component graph ────────────────────────────────────────────────────────────────────────────────────────────────

  /** builds the component graph now (a place load) instead of at the first query that needs it */
  prepare(): void {
    if (this.reachStart || !this.components) return;
    const g = this.grid, n = g.h.componentCount, u = agentUnits(PERMISSIVE), run = landingRun(PERMISSIVE.radius);
    const pairs = new Set<number>();
    for (let a = 0; a <= n; a++) for (let i = g.linkStart[a]!, e = g.linkStart[a + 1]!; i < e; i++) pairs.add(a * 0x10000 + g.linkTo[i]!);
    const comp = g.comp, y = g.y;
    for (let s = 0, S = g.h.spanCount; s < S; s++) {
      const ca = comp[s]!;
      if (ca === COMP_NONE || ca === COMP_OVERFLOW || ca > n) continue;
      for (let d = 0; d < 4; d++) {
        const t = g.moveTarget(s, d, u);
        // a walk is inside a component, and a drop onto a labelled span is a link the bake holds
        if (t < 0 || y[t]! >= y[s]! - u.stepCm || comp[t] !== COMP_NONE) continue;
        const l = this.landing(t, d, u, run, null);
        if (l < 0) continue;
        const cb = comp[l]!;
        if (cb !== ca && cb !== COMP_NONE && cb <= n) pairs.add(ca * 0x10000 + cb);
      }
    }
    const sorted = Float64Array.from(pairs).sort();
    const start = new Uint32Array(n + 2), to = new Uint16Array(sorted.length);
    for (let i = 0; i < sorted.length; i++) {
      const a = Math.floor(sorted[i]! / 0x10000);
      start[a + 1] = start[a + 1]! + 1;
      to[i] = sorted[i]! % 0x10000;
    }
    for (let a = 0; a <= n; a++) start[a + 1] = start[a + 1]! + start[a]!;
    this.reachStart = start;
    this.reachTo = to;
    this.reachSeen = new Uint32Array(n + 1);
    this.reachQueue = new Uint32Array(n + 1);
  }

  /** false only when the permissive class provably cannot get from component `from` to component `to` */
  reachable(from: number, to: number): boolean {
    const g = this.grid, n = g.h.componentCount;
    if (!this.components || from === to) return true;
    if (from === COMP_NONE || to === COMP_NONE || from === COMP_OVERFLOW || to === COMP_OVERFLOW || from > n || to > n) return true;
    if (g.reachable(from, to)) return true;
    this.prepare();
    const start = this.reachStart!, links = this.reachTo!, seen = this.reachSeen!, queue = this.reachQueue!;
    if (++this.reachStamp === 0xffffffff) { seen.fill(0); this.reachStamp = 1; }
    const st = this.reachStamp;
    let head = 0, tail = 0;
    queue[tail++] = from; seen[from] = st;
    while (head < tail) {
      const c = queue[head++]!;
      for (let i = start[c]!, e = start[c + 1]!; i < e; i++) {
        const t = links[i]!;
        if (t === to || t === COMP_OVERFLOW) return true;
        if (t <= n && seen[t] !== st) { seen[t] = st; queue[tail++] = t; }
      }
    }
    return false;
  }

  // ── moves ──────────────────────────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Where a fall onto `t` (the span under the edge, in move direction `dir`) lands: the first span from `t` on the agent
   * can stand on, at most `run` cells out, over spans with head room, an allowed slope and no stamped body; −1 if none.
   * `ranCells` holds the cells beyond `t`.
   */
  private landing(t: number, dir: number, u: AgentUnits, run: number, ov: SearchOverlay | null): number {
    const g = this.grid;
    let cur = t;
    for (let k = 0; ; k++) {
      if (g.clear[cur]! < u.clearMin || g.slope[cur]! > u.slopeMax || (ov !== null && ov.blocked(cur))) return -1;
      if (g.wall[cur]! >= u.wallMin) { this.ranCells = k; return cur; }
      if (k === run) return -1;
      const next = walkStep(g, cur, dir, u);
      if (next < 0) return -1;
      cur = next;
    }
  }

  /** the nearest span to `to` the agent can stand on, within SNAP_CELLS and the locate window around the goal's height */
  private snap(to: Readonly<Vec3>, goal: number, u: AgentUnits, ov: SearchOverlay | null): number {
    const g = this.grid, ix = g.cellIndexX(to.x), iz = g.cellIndexZ(to.z);
    const yRef = goal >= 0 ? g.y[goal]! * Y_UNIT : to.y;
    const lo = (yRef - LOCATE_DOWN) / Y_UNIT, hi = (yRef + LOCATE_UP) / Y_UNIT;
    let best = -1, bestD = Infinity;
    for (let dz = -SNAP_CELLS; dz <= SNAP_CELLS; dz++) {
      for (let dx = -SNAP_CELLS; dx <= SNAP_CELLS; dx++) {
        const c = g.columnIndex(ix + dx, iz + dz);
        if (c < 0) continue;
        const ex = g.centreX(ix + dx) - to.x, ez = g.centreZ(iz + dz) - to.z;
        for (let t = g.colStart[c]!, e = g.colStart[c + 1]!; t < e; t++) {
          const yt = g.y[t]!;
          if (yt < lo || yt > hi || !g.passable(t, u) || (ov !== null && ov.blocked(t))) continue;
          const ey = yt * Y_UNIT - yRef, d = ex * ex + ez * ez + ey * ey;
          if (d < bestD) { best = t; bestD = d; }
        }
      }
    }
    return best;
  }

  /**
   * May the move `s → t` be made: `t` passable for the query, or the way out of where the body already is. A span inside the
   * wall clearance may be entered from one deeper inside it (the wall distance only grows: out of the band, never into or
   * along it), and a span under a stamped body from another stamped one within `escape` metres of the path start.
   */
  private enters(s: number, t: number, u: AgentUnits, ov: SearchOverlay | null, costAtT: number, escape: number, side = false): boolean {
    const g = this.grid;
    if (g.clear[t]! < u.clearMin || g.slope[t]! > u.slopeMax) return false;
    const wt = g.wall[t]!;
    if (wt < u.wallMin) {
      // `side`: an orthogonal neighbour of a diagonal move out of the band only has to be floor (the corner rule is about
      // solid corners, and a span reached by a walk step is none)
      const ws = g.wall[s]!;
      if (ws >= u.wallMin || (!side && wt <= ws)) return false;
    }
    return ov === null || !ov.blocked(t) || (costAtT <= escape && ov.blocked(s));
  }

  // ── the heap ───────────────────────────────────────────────────────────────────────────────────────────────────────────

  private push(f: number, node: number): void {
    if (this.heapN === this.heapF.length) {
      const n = this.heapN * 2;
      const F = new Float64Array(n), Q = new Uint32Array(n), N = new Int32Array(n);
      F.set(this.heapF); Q.set(this.heapSeq); N.set(this.heapNode);
      this.heapF = F; this.heapSeq = Q; this.heapNode = N;
    }
    const F = this.heapF, Q = this.heapSeq, N = this.heapNode, q = this.seq++;
    let i = this.heapN++;
    while (i > 0) {
      const p = (i - 1) >> 1;
      // the parent stays when it is before the new entry: lower f, or equal f and newer
      if (F[p]! < f || (F[p] === f && Q[p]! > q)) break;
      F[i] = F[p]!; Q[i] = Q[p]!; N[i] = N[p]!;
      i = p;
    }
    F[i] = f; Q[i] = q; N[i] = node;
  }

  private pop(): number {
    const F = this.heapF, Q = this.heapSeq, N = this.heapNode;
    const top = N[0]!, n = --this.heapN;
    if (n > 0) {
      const f = F[n]!, q = Q[n]!, node = N[n]!;
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && (F[c + 1]! < F[c]! || (F[c + 1] === F[c] && Q[c + 1]! > Q[c]!))) c++;
        if (f < F[c]! || (f === F[c] && q > Q[c]!)) break;
        F[i] = F[c]!; Q[i] = Q[c]!; N[i] = N[c]!;
        i = c;
      }
      F[i] = f; Q[i] = q; N[i] = node;
    }
    return top;
  }

  // ── the search ─────────────────────────────────────────────────────────────────────────────────────────────────────────

  find(q: SearchQuery): SearchResult {
    const g = this.grid, u = agentUnits(q.agent), ov = q.overlay ?? null;
    const start = g.locate(q.from, LOCATE_UP, LOCATE_DOWN);
    if (start < 0) return { points: [], ok: false, end: 'no-start', expansions: 0, earlyOut: false, spans: [] };
    const goal = g.locate(q.to, LOCATE_UP, LOCATE_DOWN);
    const first: Vec3 = { x: q.from.x, y: g.y[start]! / CM, z: q.from.z };
    if (goal === start) return { points: [first, { x: q.to.x, y: g.y[start]! / CM, z: q.to.z }], ok: true, end: 'goal', expansions: 0, earlyOut: false, spans: [start] };

    let target = goal, exact = true;
    if (goal < 0 || !g.passable(goal, u) || (ov !== null && ov.blocked(goal))) { target = this.snap(q.to, goal, u, ov); exact = false; }

    // the heuristic's goal: the target span's cell and floor, else the goal position itself
    const gx = target >= 0 ? g.cellX(target) : g.cellIndexX(q.to.x), gz = target >= 0 ? g.cellZ(target) : g.cellIndexZ(q.to.z);
    const gy = target >= 0 ? g.y[target]! : q.to.y / Y_UNIT;
    const nx = g.h.nx, col = g.col, y = g.y;
    const heur = (s: number): number => {
      const c = col[s]!, dx = Math.abs((c % nx) - gx), dz = Math.abs(Math.floor(c / nx) - gz);
      return (dx > dz ? dx + (SQRT2 - 1) * dz : dz + (SQRT2 - 1) * dx) * H_CELL + Math.abs(y[s]! - gy) * Y_UNIT;
    };

    // horizon
    const H = typeof q.horizon === 'number' && q.horizon >= 0 ? q.horizon : Infinity;
    const limited = H !== Infinity, H2 = H * H, fx = q.from.x, fz = q.from.z;
    const ox = g.h.originX + 0.5 * NAV_CELL, oz = g.h.originZ + 0.5 * NAV_CELL;
    // the goal is out of reach when it lies beyond the horizon, and also when only the centre of its cell does (the rule
    // spans are refused by below): that span is never expanded, and without the rim bound a goal in the last 0.18 m inside
    // the horizon would cost the whole disc, on open ground too
    const tx = ox + gx * NAV_CELL, tz = oz + gz * NAV_CELL;
    const beyond = limited && (Math.hypot(q.to.x - fx, q.to.z - fz) > H || (tx - fx) * (tx - fx) + (tz - fz) * (tz - fz) > H2);
    let rimBest = -Infinity;
    if (beyond) {
      // the least octile distance to the goal from any point of the horizon's rim
      const n = Math.max(16, Math.ceil((2 * Math.PI * H) / (NAV_CELL / 2)));
      rimBest = Infinity;
      for (let i = 0; i < n; i++) {
        const a = (2 * Math.PI * i) / n, dx = Math.abs(tx - (fx + H * Math.cos(a))), dz = Math.abs(tz - (fz + H * Math.sin(a)));
        const d = dx > dz ? dx + (SQRT2 - 1) * dz : dz + (SQRT2 - 1) * dx;
        if (d < rimBest) rimBest = d;
      }
      // in the heuristic's own scale
      rimBest = rimBest * (H_CELL / NAV_CELL) + HORIZON_SLACK;
    }

    let budget = typeof q.budget === 'number' && q.budget > 0 ? Math.floor(q.budget) : NAV_DEFAULTS.budget;
    let earlyOut = false;
    if (target >= 0 && budget > EARLY_OUT_BUDGET && stricterThanPermissive(q.agent) && !this.reachable(g.comp[start]!, g.comp[target]!)) {
      budget = EARLY_OUT_BUDGET;
      earlyOut = true;
    }

    const S = g.h.spanCount;
    if (!this.state) { this.state = new Uint32Array(S); this.cost = new Float32Array(S); this.parent = new Int32Array(S); }
    const state = this.state, cost = this.cost!, parent = this.parent!;
    if (++this.gen >= 0x3fffffff) { state.fill(0); this.gen = 1; }
    const open = this.gen << 1, closed = open | 1;
    this.heapN = 0;
    this.seq = 0;
    const run = landingRun(q.agent.radius), stepCm = u.stepCm;
    // how far from the start a path may run under stamped bodies: out of the one the body stands against, not through it
    const escape = q.agent.radius;

    cost[start] = 0;
    parent[start] = -1;
    state[start] = open;
    this.push(heur(start), start);
    let expansions = 0, found = false, end: SearchEnd = 'open';
    let best = start, bestH = Infinity, bestG = Infinity;

    while (this.heapN > 0) {
      const s = this.pop();
      if (state[s] === closed) continue;
      state[s] = closed;
      if (s === target) { found = true; break; }
      const gs = cost[s]!, ys = y[s]!;
      // a span the path only crosses on its way out (clearance band, stamped body) is no place to end a partial
      if (s !== start && g.wall[s]! >= u.wallMin && !(ov !== null && ov.blocked(s))) {
        const hs = heur(s);
        if (hs < bestH || (hs === bestH && gs < bestG)) { best = s; bestH = hs; bestG = gs; }
        if (beyond && hs <= rimBest) { best = s; end = 'horizon'; break; }
      }
      if (++expansions >= budget) { end = 'budget'; break; }
      // the four orthogonal moves first: bit d of `sides` = that neighbour is a walk move a diagonal may pass beside
      const inBand = g.wall[s]! < u.wallMin;
      let sides = 0;
      for (let d = 0; d < 8; d++) {
        let t: number, cells: number;
        if (d < 4) {
          t = g.moveTarget(s, d, u);
          if (t < 0) continue;
          if (y[t]! < ys - stepCm) {
            t = this.landing(t, d, u, run, ov);
            if (t < 0) continue;
            cells = 1 + this.ranCells;
          } else {
            if (this.enters(s, t, u, ov, gs + NAV_CELL, escape)) sides |= 1 << d;
            else {
              if (inBand && this.enters(s, t, u, ov, gs + NAV_CELL, escape, true)) sides |= 1 << d;
              continue;
            }
            cells = 1;
          }
        } else {
          // both orthogonal neighbours as passable walk moves, then the diagonal itself as one
          if ((sides & (NAV_DX[d]! > 0 ? 1 : 2)) === 0 || (sides & (NAV_DZ[d]! > 0 ? 4 : 8)) === 0) continue;
          t = g.moveTarget(s, d, u);
          if (t < 0 || y[t]! < ys - stepCm || !this.enters(s, t, u, ov, gs + SQRT2 * NAV_CELL, escape)) continue;
          cells = SQRT2;
        }
        const st = state[t]!;
        if (st === closed) continue;
        if (limited) {
          const c = col[t]!, ex = ox + (c % nx) * NAV_CELL - fx, ez = oz + Math.floor(c / nx) * NAV_CELL - fz;
          if (ex * ex + ez * ez > H2) continue;
        }
        // Float32 costs: rounded here as the array stores them, so the comparison below is the stored one
        const ng = Math.fround(gs + cells * NAV_CELL + 0.5 * Math.abs(y[t]! - ys) * Y_UNIT);
        if (st === open && ng >= cost[t]!) continue;
        cost[t] = ng;
        parent[t] = s;
        state[t] = open;
        this.push(ng + heur(t), t);
      }
    }
    if (!found && end === 'open' && beyond) end = 'horizon';

    // the grid path, start first
    const last = found ? target : best;
    let n = 0;
    for (let s = last; s >= 0; s = parent[s]!) n++;
    const spans = new Array<number>(n);
    for (let s = last, i = n - 1; s >= 0; s = parent[s]!, i--) spans[i] = s;

    const ok = found && exact;
    const anchors = smoothPath({ grid: g, units: u, pass: (s) => g.passable(s, u) && !(ov !== null && ov.blocked(s)) }, spans, n);
    const points: Vec3[] = [first];
    for (let i = 1; i < anchors.length; i++) {
      const s = anchors[i]!;
      if (ok && i === anchors.length - 1) points.push({ x: q.to.x, y: y[s]! / CM, z: q.to.z });
      else points.push({ x: g.centreX(g.cellX(s)), y: y[s]! / CM, z: g.centreZ(g.cellZ(s)) });
    }
    return { points, ok, end: found ? (exact ? 'goal' : 'near') : end, expansions, earlyOut, spans };
  }
}
