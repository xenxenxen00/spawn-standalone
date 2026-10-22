// nav/search.ts (motion §7.4, §7.7; WP NV2): the per-call agent class against hand-built places.
import { describe, expect, it } from 'vitest';
import type { ColliderPack } from '../../../src/compat/core/ports.ts';
import { bakeNavGrid } from '../../../src/compat/nav/bake.ts';
import { PERMISSIVE, type AgentParams } from '../../../src/compat/nav/navgrid.ts';
import { EARLY_OUT_BUDGET, NAV_DEFAULTS, NavSearch, type SearchResult } from '../../../src/compat/nav/search.ts';
import { PackBuilder, corridor, doorwayRooms, floor, ledge, ramp } from './fixtures.ts';

const v = (x: number, y: number, z: number): { x: number; y: number; z: number } => ({ x, y, z });
const agent = (o: Partial<AgentParams> = {}): AgentParams => ({ radius: 0.35, height: 1.8, step: 0.4, slope: 50, maxDrop: 3, ...o });
const search = (pack: ColliderPack): NavSearch => new NavSearch(bakeNavGrid(pack).grid);
const last = (r: SearchResult): { x: number; y: number; z: number } => r.points[r.points.length - 1]!;

describe('nav search: the agent class', () => {
  it('radius 0.35 passes a 0.8 m gap; 0.4 does not pass 0.75 m', () => {
    // the 0.8 m doorway holds three whole cells (z 3.75 … 4.5): their wall distances are 0.12, 0.36, 0.12 m
    const wide = search(doorwayRooms(3.725, 4.525));
    const a = wide.find({ from: v(1, 0, 4.1), to: v(7, 0, 4.1), agent: agent({ radius: 0.35 }) });
    expect(a.ok).toBe(true);
    expect(last(a)).toEqual(v(7, 0, 4.1));
    expect(a.points[0]).toEqual(v(1, 0, 4.1));

    const narrow = search(doorwayRooms(3.75, 4.5));
    const b = narrow.find({ from: v(1, 0, 4.1), to: v(7, 0, 4.1), agent: agent({ radius: 0.4 }) });
    expect(b.ok).toBe(false);
    expect(b.points.length).toBeGreaterThan(0);
    // the partial stays on the near side of the wall
    expect(last(b).x).toBeLessThan(4);
    // the same doorway lets the thinner agent through
    expect(narrow.find({ from: v(1, 0, 4.1), to: v(7, 0, 4.1), agent: agent({ radius: 0.35 }) }).ok).toBe(true);
  });

  it('height 1.0 passes under a 1.5 m beam; 1.8 does not', () => {
    const b = new PackBuilder('beam');
    floor(b, 0, 0, 8, 2);
    b.box([4, 1.5, 0], [4.5, 1.8, 2]);
    const s = search(b.pack);
    expect(s.find({ from: v(1, 0, 1), to: v(7, 0, 1), agent: agent({ height: 1.0 }) }).ok).toBe(true);
    const tall = s.find({ from: v(1, 0, 1), to: v(7, 0, 1), agent: agent({ height: 1.8 }) });
    expect(tall.ok).toBe(false);
    expect(last(tall).x).toBeLessThan(4);
  });

  it('step 0.4 climbs a 0.39 m ledge; step 0.3 does not, and walks down it as a drop', () => {
    const s = search(ledge(0.39));
    // the ledge is the block over x < 4; the low floor is x > 4
    const up = s.find({ from: v(6, 0, 2), to: v(2, 0.39, 2), agent: agent({ step: 0.4 }) });
    expect(up.ok).toBe(true);
    expect(last(up)).toEqual(v(2, 0.39, 2));
    expect(s.find({ from: v(6, 0, 2), to: v(2, 0.39, 2), agent: agent({ step: 0.3 }) }).ok).toBe(false);
    expect(s.find({ from: v(2, 0.39, 2), to: v(6, 0, 2), agent: agent({ step: 0.3 }) }).ok).toBe(true);
  });

  it('a 2.9 m drop is allowed one way; 3.1 m is refused', () => {
    const s = search(ledge(2.9));
    const down = s.find({ from: v(2, 2.9, 2), to: v(6, 0, 2), agent: agent() });
    expect(down.ok).toBe(true);
    expect(down.points[0]!.y).toBeCloseTo(2.9, 6);
    expect(last(down)).toEqual(v(6, 0, 2));
    // one way: the reverse query cannot climb it and stays on the low floor
    const up = s.find({ from: v(6, 0, 2), to: v(2, 2.9, 2), agent: agent() });
    expect(up.ok).toBe(false);
    expect(up.points.length).toBeGreaterThan(0);
    expect(last(up).y).toBeCloseTo(0, 6);

    const high = search(ledge(3.1));
    const refused = high.find({ from: v(2, 3.1, 2), to: v(6, 0, 2), agent: agent() });
    expect(refused.ok).toBe(false);
    expect(last(refused).y).toBeCloseTo(3.1, 6);
    // a caller that allows it gets down
    expect(high.find({ from: v(2, 3.1, 2), to: v(6, 0, 2), agent: agent({ maxDrop: 3.2 }) }).ok).toBe(true);
  });

  it('a drop lands clear of the face it fell along: the first cell an agent of that radius fits', () => {
    const s = search(ledge(2.9));
    for (const radius of [0.35, 0.6]) {
      const r = s.find({ from: v(2, 2.9, 2), to: v(7, 0, 2), agent: agent({ radius }) });
      expect(r.ok, `radius ${radius}`).toBe(true);
      const landing = r.points.find((p) => p.y < 0.01)!;
      expect(landing.x - 4, `radius ${radius}`).toBeGreaterThanOrEqual(radius);
      expect(landing.x - 4, `radius ${radius}`).toBeLessThan(radius + 0.5);
    }
  });

  it('slope 50 refuses a 55° ramp; a caller that allows 56° climbs it', () => {
    const { pack, topX } = ramp(55);
    const s = search(pack);
    const from = v(1, 0, 1), to = v(topX + 2, 2, 1);
    const refused = s.find({ from, to, agent: agent({ slope: 50 }) });
    expect(refused.ok).toBe(false);
    expect(last(refused).y).toBeCloseTo(0, 6);
    const climbed = s.find({ from, to, agent: agent({ slope: 56 }) });
    expect(climbed.ok).toBe(true);
    expect(last(climbed)).toEqual(to);
  });

  it('the defaults are the engine else-values: slope 45, where the live callers pass 50', () => {
    expect(NAV_DEFAULTS).toEqual({ radius: 0.35, height: 1.8, step: 0.4, slope: 45, maxDrop: 3, budget: 60_000 });
    const { pack, topX } = ramp(48);
    const s = search(pack);
    const from = v(1, 0, 1), to = v(topX + 2, 2, 1);
    const { budget: _budget, ...defaults } = NAV_DEFAULTS;
    expect(s.find({ from, to, agent: defaults }).ok).toBe(false);
    expect(s.find({ from, to, agent: { ...defaults, slope: 50 } }).ok).toBe(true);
  });
});

describe('nav search: start, goal and the result', () => {
  it('no span under `from` answers no points', () => {
    const s = search(corridor(8));
    expect(s.find({ from: v(-5, 0, 1), to: v(7, 0, 1), agent: agent() })).toMatchObject({ points: [], ok: false, end: 'no-start' });
    // more than 2 m above the floor is no span either
    expect(s.find({ from: v(2, 2.5, 1), to: v(7, 0, 1), agent: agent() }).points).toEqual([]);
    // within the locate window (0.6 m up, 2 m down) it is
    expect(s.find({ from: v(2, 1.9, 1), to: v(7, 0, 1), agent: agent() }).ok).toBe(true);
    expect(s.find({ from: v(2, -0.5, 1), to: v(7, 0, 1), agent: agent() }).ok).toBe(true);
  });

  it('no span under `to` searches toward it and answers the partial', () => {
    const s = search(corridor(8));
    const r = s.find({ from: v(1, 0, 1), to: v(12, 0, 1), agent: agent() });
    expect(r.ok).toBe(false);
    expect(r.points.length).toBeGreaterThanOrEqual(2);
    expect(r.points[0]).toEqual(v(1, 0, 1));
    // the far end of the corridor, as near the goal as an agent of this radius stands
    expect(last(r).x).toBeGreaterThan(7.2);
    expect(last(r).z).toBeCloseTo(1, 0);
  });

  it('a goal the agent cannot stand on ends beside it, without paying for the whole floor', () => {
    const b = new PackBuilder('hall');
    floor(b, 0, 0, 20, 20);
    b.box([10, 0, 9], [10.25, 3, 11]);
    const s = search(b.pack);
    // 0.1 m from the wall's face: no room for a 0.35 m body
    const r = s.find({ from: v(2, 0, 10), to: v(9.9, 0, 10), agent: agent() });
    expect(r.ok).toBe(false);
    expect(r.end).toBe('near');
    expect(Math.hypot(last(r).x - 9.9, last(r).z - 10)).toBeLessThan(0.6);
    expect(r.expansions).toBeLessThan(600);
  });

  it('a body pressed against a wall plans its way out of its own clearance band, and never into or through one', () => {
    const b = new PackBuilder('hall');
    floor(b, 0, 0, 20, 20);
    const s = search(b.pack);
    // 0.1 m from the edge wall: two cells deep inside what a 0.6 m body keeps clear of
    for (const radius of [0.35, 0.4, 0.6]) {
      const r = s.find({ from: v(0.1, 0, 10), to: v(10, 0, 5), agent: agent({ radius }) });
      expect(r.ok, `radius ${radius}`).toBe(true);
      expect(r.points[0]).toEqual(v(0.1, 0, 10));
      expect(last(r)).toEqual(v(10, 0, 5));
    }
    // … from a corner too
    expect(s.find({ from: v(0.1, 0, 0.1), to: v(10, 0, 5), agent: agent({ radius: 0.6 }) }).ok).toBe(true);
    // the 0.75 m doorway stays shut for a 0.4 m body standing right in it: the wall distance does not grow through a gap
    const narrow = search(doorwayRooms(3.75, 4.5));
    const stuck = narrow.find({ from: v(3.9, 0, 4.1), to: v(7, 0, 4.1), agent: agent({ radius: 0.4 }) });
    expect(stuck.ok).toBe(false);
    expect(last(stuck).x).toBeLessThan(4);
    // and it walks back out into its own room
    expect(narrow.find({ from: v(3.9, 0, 4.1), to: v(1, 0, 1), agent: agent({ radius: 0.4 }) }).ok).toBe(true);
  });

  it('budget exhaustion returns a partial with ok:false and non-empty points', () => {
    const s = search(corridor(30));
    const r = s.find({ from: v(1, 0, 1), to: v(29, 0, 1), agent: agent(), budget: 40 });
    expect(r.ok).toBe(false);
    expect(r.end).toBe('budget');
    expect(r.expansions).toBe(40);
    expect(r.points.length).toBeGreaterThanOrEqual(2);
    // the expanded span closest to the goal
    expect(last(r).x).toBeGreaterThan(3);
    expect(last(r).x).toBeLessThan(29);
    expect(s.find({ from: v(1, 0, 1), to: v(29, 0, 1), agent: agent() }).ok).toBe(true);
  });

  it('a goal in a component the permissive class cannot reach costs 4,000 expansions, not the budget', () => {
    const b = new PackBuilder('islands');
    floor(b, 0, 0, 20, 20);
    floor(b, 23, 0, 26, 20);
    const s = search(b.pack);
    const r = s.find({ from: v(10, 0, 10), to: v(24.5, 0, 10), agent: agent({ height: 1 }), budget: 60_000 });
    expect(r.ok).toBe(false);
    expect(r.earlyOut).toBe(true);
    expect(r.expansions).toBe(EARLY_OUT_BUDGET);
    expect(r.points.length).toBeGreaterThan(0);
    // a class looser than the permissive one is never cut short by its labels: the whole island is searched
    const loose = s.find({ from: v(10, 0, 10), to: v(24.5, 0, 10), agent: agent({ radius: 0.2, height: 1 }), budget: 60_000 });
    expect(loose.earlyOut).toBe(false);
    expect(loose.expansions).toBeGreaterThan(EARLY_OUT_BUDGET);
    expect(PERMISSIVE.radius).toBe(0.35);
  });

  it('a block that can only be left by dropping off it is not cut short', () => {
    // far enough that a 4,000-expansion search would not arrive: 38 m of floor after the drop
    const b = new PackBuilder('long-ledge');
    floor(b, 0, 0, 44, 6);
    b.box([0, 0, 0], [4, 2.9, 6]);
    const s = search(b.pack);
    const r = s.find({ from: v(1, 2.9, 3), to: v(43, 0, 3), agent: agent() });
    expect(r.earlyOut).toBe(false);
    expect(r.ok).toBe(true);
  });

  it('a diagonal needs both orthogonal neighbours: no corner cutting', () => {
    // two floors that touch only at the corner (2, 2); radius 0.1 fits every cell, so only the corner rule decides
    const b = new PackBuilder('corner');
    floor(b, 0, 0, 2, 2);
    floor(b, 2, 2, 4, 4);
    const thin = agent({ radius: 0.1 });
    expect(search(b.pack).find({ from: v(1, 0, 1), to: v(3, 0, 3), agent: thin }).ok).toBe(false);
    floor(b, 2, 0, 4, 2);
    const joined = search(b.pack).find({ from: v(1, 0, 1), to: v(3, 0, 3), agent: thin });
    expect(joined.ok).toBe(true);
  });

  it('points are feet positions: `from`, corners at cell centres, `to`', () => {
    const s = search(doorwayRooms(3.25, 4.75));
    const r = s.find({ from: v(1.03, 0.4, 1.02), to: v(7.01, 0, 7.02), agent: agent() });
    expect(r.ok).toBe(true);
    // the first point is `from` at the floor under it, the last is `to`
    expect(r.points[0]).toEqual(v(1.03, 0, 1.02));
    expect(last(r)).toEqual(v(7.01, 0, 7.02));
    expect(r.points.length).toBeGreaterThanOrEqual(3);
    for (const p of r.points.slice(1, -1)) {
      expect((p.x / 0.25) % 1).toBeCloseTo(0.5, 6);
      expect((p.z / 0.25) % 1).toBeCloseTo(0.5, 6);
      expect(p.y).toBe(0);
    }
    // through the doorway
    const crossings = r.points.slice(1).flatMap((q, i) => {
      const p = r.points[i]!;
      return (p.x - 4.125) * (q.x - 4.125) < 0 ? [p.z + ((4.125 - p.x) / (q.x - p.x)) * (q.z - p.z)] : [];
    });
    expect(crossings.length).toBe(1);
    expect(crossings[0]).toBeGreaterThan(3.25 + 0.35);
    expect(crossings[0]).toBeLessThan(4.75 - 0.35);
  });

  it('start and goal on the same span answer the two points', () => {
    const r = search(corridor(8)).find({ from: v(2.01, 0, 1.01), to: v(2.1, 0, 1.1), agent: agent() });
    expect(r).toMatchObject({ ok: true, points: [v(2.01, 0, 1.01), v(2.1, 0, 1.1)] });
  });
});

describe('nav search: the horizon', () => {
  it('spans beyond the horizon are not expanded and the partial ends at the one closest to the goal', () => {
    const s = search(corridor(40));
    const r = s.find({ from: v(1, 0, 1), to: v(31, 0, 1), agent: agent(), horizon: 11 });
    expect(r.ok).toBe(false);
    expect(r.end).toBe('horizon');
    const d = Math.hypot(last(r).x - 1, last(r).z - 1);
    expect(d).toBeLessThanOrEqual(11);
    expect(d).toBeGreaterThan(10.4);
    // an open floor costs a search toward the goal, not the whole disc
    expect(r.expansions).toBeLessThan(400);
  });

  it('a goal just inside the horizon whose cell centre lies just outside it does not cost the whole disc', () => {
    const b = new PackBuilder('hall');
    floor(b, 0, 0, 30, 30);
    const s = search(b.pack);
    // 10.99 m away; the goal's cell (x 26 … 26.25, centre 26.125) is 11.1 m from `from`, so its span is never expanded
    const from = v(15.02, 0, 15.1), to = v(26.01, 0, 15.1);
    const r = s.find({ from, to, agent: agent(), horizon: 11 });
    expect(r.ok).toBe(false);
    expect(r.end).toBe('horizon');
    expect(Math.hypot(last(r).x - to.x, last(r).z - to.z)).toBeLessThan(0.5);
    expect(r.expansions).toBeLessThan(400);
    // the cell before it is inside: reached
    expect(s.find({ from, to: v(25.9, 0, 15.1), agent: agent(), horizon: 11 }).ok).toBe(true);
  });

  it('a horizon that hides the goal behind a wall still answers the closest span it could expand', () => {
    const s = search(doorwayRooms(0.25, 1.0));
    const r = s.find({ from: v(1, 0, 7), to: v(7, 0, 7), agent: agent(), horizon: 5 });
    expect(r.ok).toBe(false);
    expect(last(r).x).toBeLessThan(4);
    expect(Math.hypot(last(r).x - 1, last(r).z - 7)).toBeLessThanOrEqual(5);
  });
});
