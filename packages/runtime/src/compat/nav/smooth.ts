// String pulling over the grid path (motion §7.4 item 7; WP NV2): from each anchor, the farthest later span of the path that a
// straight walk reaches, where a straight walk is the supercover line between the two cell centres with every cell passable
// and every move a walk step. A drop is never part of a line: the span the agent leaves and the span it lands on both stay
// as anchors, so the caller's waypoints carry the edge and the landing.
//
// "Farthest" is found by one test of the stretch's end and then a gallop and a bisection over the path (visibility along a
// shortest path is monotonic but for discretisation): O(log n) line walks per anchor, so a 60 m route smooths in microseconds.
import { NAV_DX, NAV_DZ, type AgentUnits, type NavGridData } from './navgrid.ts';

export interface SmoothEnv {
  grid: NavGridData;
  units: AgentUnits;
  /** the query's passable test for a span (agent class and overlay) */
  pass(s: number): boolean;
}

/** the span reached from `s` by a walk step (|Δy| ≤ step) in NAV_DIRS[dir], or −1; passability is the caller's test */
export function walkStep(g: NavGridData, s: number, dir: number, u: AgentUnits): number {
  const t = g.moveTarget(s, dir, u);
  return t >= 0 && g.y[t]! >= g.y[s]! - u.stepCm ? t : -1;
}

/** NAV_DIRS index of the unit move (dx, dz) */
function dirOf(dx: number, dz: number): number {
  for (let d = 0; d < 8; d++) if (NAV_DX[d] === dx && NAV_DZ[d] === dz) return d;
  return -1;
}

/**
 * True when the supercover line from span `a` to span `b` is walkable: every cell the segment between the two cell centres
 * touches holds a span reached by a walk step from the one before, passable for the query; where the segment passes exactly
 * through a cell corner the move is a diagonal and both orthogonal cells must be passable too (no corner cutting).
 */
export function lineWalk(env: SmoothEnv, a: number, b: number): boolean {
  if (a === b) return true;
  const g = env.grid, u = env.units;
  const dx = g.cellX(b) - g.cellX(a), dz = g.cellZ(b) - g.cellZ(a);
  const nx = Math.abs(dx), nz = Math.abs(dz), sx = Math.sign(dx), sz = Math.sign(dz);
  const dirX = sx === 0 ? -1 : dirOf(sx, 0), dirZ = sz === 0 ? -1 : dirOf(0, sz), dirD = sx !== 0 && sz !== 0 ? dirOf(sx, sz) : -1;
  let cur = a, ix = 0, iz = 0;
  while (ix < nx || iz < nz) {
    // which cell boundary the segment meets next: the vertical one, the horizontal one, or both at a corner
    const d = (1 + 2 * ix) * nz - (1 + 2 * iz) * nx;
    let next: number;
    if (d === 0) {
      const p = walkStep(g, cur, dirX, u), q = walkStep(g, cur, dirZ, u);
      if (p < 0 || q < 0 || !env.pass(p) || !env.pass(q)) return false;
      next = walkStep(g, cur, dirD, u);
      ix++; iz++;
    } else if (d < 0) {
      next = walkStep(g, cur, dirX, u);
      ix++;
    } else {
      next = walkStep(g, cur, dirZ, u);
      iz++;
    }
    if (next < 0 || !env.pass(next)) return false;
    cur = next;
  }
  return cur === b;
}

/**
 * The anchors of a grid path (`path[0 … n − 1]`, consecutive spans one move apart): its first span, the corners, both ends
 * of every drop, its last span.
 */
export function smoothPath(env: SmoothEnv, path: ArrayLike<number>, n: number): number[] {
  if (n <= 0) return [];
  const g = env.grid, step = env.units.stepCm;
  const out: number[] = [path[0]!];
  const walk = (i: number): boolean => {
    const p = path[i]!, q = path[i + 1]!;
    return Math.abs(g.y[q]! - g.y[p]!) <= step && Math.abs(g.cellX(q) - g.cellX(p)) <= 1 && Math.abs(g.cellZ(q) - g.cellZ(p)) <= 1;
  };
  let a = 0;
  while (a < n - 1) {
    // the stretch of walk moves from the anchor on
    let end = a;
    while (end < n - 1 && walk(end)) end++;
    if (end === a) {
      // a drop: where it lands is the next anchor
      a++;
      out.push(path[a]!);
      continue;
    }
    let good = a + 1;
    if (good < end) {
      if (lineWalk(env, path[a]!, path[end]!)) good = end;
      else {
        let bad = end, k = 1;
        while (good + k < bad && lineWalk(env, path[a]!, path[good + k]!)) { good += k; k *= 2; }
        if (good + k < bad) bad = good + k;
        while (bad - good > 1) {
          const mid = (good + bad) >> 1;
          if (lineWalk(env, path[a]!, path[mid]!)) good = mid; else bad = mid;
        }
      }
    }
    out.push(path[good]!);
    a = good;
  }
  return out;
}
