// The live findPath horizon (X-41; motion §7.4 item 10, §7.7; contract §10.2 LIVE A1): 11 m for a platform-VM caller, 17 m
// for a client-VM caller, `nav.horizonM = 'none'` as the A/B option. Driven through builtin/nav, as the game calls it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bindNav, findPath, type NavCtx } from '../../../src/compat/builtin/nav.ts';
import { resetPortFlags, setPortFlag } from '../../../src/compat/builtin/port.ts';
import type { VmId } from '../../../src/compat/core/types.ts';
import { bakeNavGrid } from '../../../src/compat/nav/bake.ts';
import type { NavGridData } from '../../../src/compat/nav/navgrid.ts';
import { corridor } from './fixtures.ts';

const v = (x: number, y: number, z: number): { x: number; y: number; z: number } => ({ x, y, z });
type Ctx = NavCtx & { vm: VmId };
const PLATFORM: Ctx = { place: { id: 'corridor' }, self: { id: 'zed-1' }, vm: 'platform' };
const CLIENT: Ctx = { place: { id: 'corridor' }, self: { id: 'player/local' }, vm: 'client' };
const FROM = v(1, 0, 1), FAR = v(31, 0, 1), NEAR = v(10, 0, 1);
// the enemy call (scripts/enemies/runtime.js planRoute) and the trader trail's (scripts/player/trader-trail.js)
const ENEMY = { radius: 0.35, height: 1.8, step: 0.4, slope: 50, maxDrop: 3, bodies: 'static' as const, ignore: ['zed-1'], budget: 60000 };
const TRAIL = { radius: 0.35, height: 1.8, ignore: [] as string[] };

let grid: NavGridData;
const reach = (r: { points: Array<{ x: number; z: number }> }): number => {
  const p = r.points[r.points.length - 1]!;
  return Math.hypot(p.x - FROM.x, p.z - FROM.z);
};

beforeEach(() => {
  grid = bakeNavGrid(corridor(40)).grid;
  resetPortFlags();
  bindNav({ grid: () => grid, vm: (ctx) => (ctx as Ctx).vm });
});
afterEach(() => {
  bindNav(null);
  resetPortFlags();
});

describe('findPath horizon (X-41)', () => {
  it('a goal 30 m down a straight corridor is a partial ending within 11 m for a platform-VM caller', () => {
    const r = findPath(PLATFORM, FROM, FAR, ENEMY);
    expect(r.ok).toBe(false);
    expect(r.points.length).toBeGreaterThanOrEqual(2);
    expect(r.points[0]).toEqual(FROM);
    expect(reach(r)).toBeLessThanOrEqual(11);
    // … and at the span closest to the goal: the last cell inside the horizon, straight down the corridor
    expect(reach(r)).toBeGreaterThan(10.4);
    expect(r.points[r.points.length - 1]!.z).toBeCloseTo(1, 0);
    expect(r.partial).toBeUndefined();
  });

  it('… and within 17 m for a client-VM caller', () => {
    const r = findPath(CLIENT, FROM, FAR, TRAIL);
    expect(r.ok).toBe(false);
    expect(reach(r)).toBeLessThanOrEqual(17);
    expect(reach(r)).toBeGreaterThan(16.4);
    // the trail's finish rule needs partials that end toward the trader, not at the start (trader-trail.js:47)
    expect(Math.hypot(r.points[r.points.length - 1]!.x - FAR.x, 0)).toBeLessThan(14.6);
  });

  it("nav.horizonM = 'none' reaches it; the flag is read at call time", () => {
    setPortFlag('nav.horizonM', 'none');
    for (const [ctx, opts] of [[PLATFORM, ENEMY], [CLIENT, TRAIL]] as const) {
      const r = findPath(ctx, FROM, FAR, opts);
      expect(r.ok).toBe(true);
      expect(r.points[r.points.length - 1]).toEqual(FAR);
    }
    setPortFlag('nav.horizonM', undefined);
    expect(findPath(PLATFORM, FROM, FAR, ENEMY).ok).toBe(false);
    // other values of the flag: per-VM numbers, one number for both
    setPortFlag('nav.horizonM', { platform: 5, client: 40 });
    expect(reach(findPath(PLATFORM, FROM, FAR, ENEMY))).toBeLessThanOrEqual(5);
    expect(findPath(CLIENT, FROM, FAR, TRAIL).ok).toBe(true);
    setPortFlag('nav.horizonM', 8);
    expect(reach(findPath(CLIENT, FROM, FAR, TRAIL))).toBeLessThanOrEqual(8);
    expect(reach(findPath(CLIENT, FROM, FAR, TRAIL))).toBeGreaterThan(7.4);
  });

  it('a 9 m goal succeeds either way', () => {
    for (const flag of [undefined, 'none'] as const) {
      setPortFlag('nav.horizonM', flag);
      for (const [ctx, opts] of [[PLATFORM, ENEMY], [CLIENT, TRAIL]] as const) {
        const r = findPath(ctx, FROM, NEAR, opts);
        expect(r.ok).toBe(true);
        expect(r.points).toEqual([FROM, NEAR]);
      }
    }
  });

  it('a caller whose machine is unknown gets the platform horizon, with one warning', () => {
    const warnings: string[] = [];
    bindNav({ grid: () => grid, warn: (m) => void warnings.push(m) });
    expect(reach(findPath(CLIENT, FROM, FAR, TRAIL))).toBeLessThanOrEqual(11);
    findPath(CLIENT, FROM, FAR, TRAIL);
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toMatch(/platform/);
  });
});
