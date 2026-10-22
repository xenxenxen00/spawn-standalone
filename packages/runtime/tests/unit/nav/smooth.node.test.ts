// nav/smooth.ts (motion §7.4 item 7, §7.7; WP NV2): string pulling over the grid path.
import { describe, expect, it } from 'vitest';
import type { ColliderPack } from '../../../src/compat/core/ports.ts';
import { bakeNavGrid } from '../../../src/compat/nav/bake.ts';
import { agentUnits, type AgentParams, type NavGridData } from '../../../src/compat/nav/navgrid.ts';
import { NavSearch } from '../../../src/compat/nav/search.ts';
import { lineWalk, smoothPath, type SmoothEnv } from '../../../src/compat/nav/smooth.ts';
import { PackBuilder, corridor, floor, lCorridor, ledge } from './fixtures.ts';

const v = (x: number, y: number, z: number): { x: number; y: number; z: number } => ({ x, y, z });
const AGENT: AgentParams = { radius: 0.35, height: 1.8, step: 0.4, slope: 50, maxDrop: 3 };
const grid = (pack: ColliderPack): NavGridData => bakeNavGrid(pack).grid;
const env = (g: NavGridData, a: AgentParams = AGENT): SmoothEnv => {
  const units = agentUnits(a);
  return { grid: g, units, pass: (s) => g.passable(s, units) };
};
const at = (g: NavGridData, x: number, z: number, y = 0): number => g.locate(v(x, y, z), 0.6, 2);

describe('nav smoothing', () => {
  it('a straight corridor is two points', () => {
    const g = grid(corridor(8));
    const r = new NavSearch(g).find({ from: v(0.6, 0, 1.1), to: v(7.4, 0, 0.9), agent: AGENT });
    expect(r.ok).toBe(true);
    expect(r.points).toEqual([v(0.6, 0, 1.1), v(7.4, 0, 0.9)]);
    // the grid path under it has every cell
    expect(r.spans.length).toBeGreaterThan(20);
  });

  it('an L-corridor is three points: the corner is the only anchor', () => {
    const g = grid(lCorridor());
    const r = new NavSearch(g).find({ from: v(0.6, 0, 1), to: v(7, 0, 7.4), agent: AGENT });
    expect(r.ok).toBe(true);
    expect(r.points.length).toBe(3);
    const corner = r.points[1]!;
    // a cell centre beside the inner corner (6, 2), a body's radius clear of it
    expect(Math.hypot(corner.x - 6, corner.z - 2)).toBeLessThan(1.0);
    expect(corner.x).toBeGreaterThanOrEqual(6 + 0.35);
    expect((corner.x / 0.25) % 1).toBeCloseTo(0.5, 6);
    expect(corner.y).toBe(0);
  });

  it('never smooths across a drop: both ends of the fall stay', () => {
    const g = grid(ledge(2.9));
    // collinear in xz: only the drop keeps the two middle points
    const r = new NavSearch(g).find({ from: v(1, 2.9, 2.1), to: v(7, 0, 2.1), agent: AGENT });
    expect(r.ok).toBe(true);
    expect(r.points.map((p) => +p.y.toFixed(2))).toEqual([2.9, 2.9, 0, 0]);
    const [, edge, landing] = r.points as [unknown, { x: number }, { x: number }, unknown];
    expect(edge.x).toBeGreaterThan(3.7);
    expect(edge.x).toBeLessThan(4);
    expect(landing.x).toBeGreaterThan(4.3);
    expect(landing.x).toBeLessThan(4.7);
  });

  it('lineWalk: every cell of the supercover is passable with walk steps', () => {
    const b = new PackBuilder('pillar');
    floor(b, 0, 0, 8, 8);
    b.box([3.5, 0, 3.5], [4.5, 3, 4.5]);
    const g = grid(b.pack);
    const e = env(g);
    expect(lineWalk(e, at(g, 1, 1), at(g, 7, 1))).toBe(true);
    // through the pillar
    expect(lineWalk(e, at(g, 1, 4), at(g, 7, 4))).toBe(false);
    // past it, but inside the clearance a 0.35 m body needs
    expect(lineWalk(e, at(g, 1, 3.3), at(g, 7, 3.3))).toBe(false);
    expect(lineWalk(e, at(g, 1, 2.9), at(g, 7, 2.9))).toBe(true);
    // a thinner body takes the closer line
    expect(lineWalk(env(g, { ...AGENT, radius: 0.1 }), at(g, 1, 3.3), at(g, 7, 3.3))).toBe(true);
    // an exact diagonal passes corners: both orthogonal cells must be free (it grazes nothing here)
    expect(lineWalk(e, at(g, 1, 1), at(g, 3, 3))).toBe(true);
    // a step too high for the walk is no line, a ledge the agent climbs is
    const l = grid(ledge(0.39));
    expect(lineWalk(env(l), at(l, 6, 2), at(l, 2, 2, 0.39))).toBe(true);
    expect(lineWalk(env(l, { ...AGENT, step: 0.3 }), at(l, 6, 2), at(l, 2, 2, 0.39))).toBe(false);
  });

  it('smoothPath keeps the first and last span and drops every span a straight walk covers', () => {
    const g = grid(corridor(8));
    const path: number[] = [];
    for (let x = 0.625; x < 7.5; x += 0.25) path.push(at(g, x, 1.1));
    const anchors = smoothPath(env(g), path, path.length);
    expect(anchors).toEqual([path[0], path[path.length - 1]]);
    expect(smoothPath(env(g), path, 1)).toEqual([path[0]]);
  });
});
