// nav/overlay.ts through builtin/nav `findPath` (motion §7.4 item 9, §7.7; WP NV2): what the baked grid does not hold.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bindNav, findPath, type NavCtx } from '../../../src/compat/builtin/nav.ts';
import { resetPortFlags } from '../../../src/compat/builtin/port.ts';
import { bakeNavGrid } from '../../../src/compat/nav/bake.ts';
import type { NavGridData } from '../../../src/compat/nav/navgrid.ts';
import { OverlayStamps, gridRowIds, ignoredId, overlayFootprints, type OverlayBody } from '../../../src/compat/nav/overlay.ts';
import { doorwayRooms, m34 } from './fixtures.ts';

const v = (x: number, y: number, z: number): { x: number; y: number; z: number } => ({ x, y, z });
const IDENTITY = { x: 0, y: 0, z: 0, w: 1 };
const yaw = (deg: number): { x: number; y: number; z: number; w: number } => ({ x: 0, y: Math.sin((deg * Math.PI) / 360), z: 0, w: Math.cos((deg * Math.PI) / 360) });
const CTX: NavCtx = { place: { id: 'doorway' }, self: { id: 'walker' } };
const FROM = v(1, 0, 4), TO = v(7, 0, 4);

/** a door leaf closing the 1.5 m doorway z ∈ [3.25, 4.75] of the wall at x ∈ [4, 4.25]; the row stands at its hinge */
const HINGE = v(4.125, 0, 3.25);
function door(o: Partial<OverlayBody> = {}): OverlayBody {
  return {
    rowId: 'door-1', kind: 'kinematic', enabled: true, sensor: false, pos: HINGE, rot: IDENTITY,
    parts: [{ shape: { box: [0.15, 2.2, 1.5] }, m: m34([4.125, 0, 4.0]) }], baked: { pos: HINGE, rot: IDENTITY }, ...o,
  };
}
/** a supply terminal standing in the doorway */
function terminal(o: Partial<OverlayBody> = {}): OverlayBody {
  return {
    rowId: 'terminal-1', kind: 'static', enabled: true, sensor: false, pos: v(4.125, 0, 4), rot: IDENTITY,
    parts: [{ shape: { box: [1, 2, 1.4] }, m: m34([4.125, 0, 4]) }], baked: { pos: v(4.125, 0, 4), rot: IDENTITY }, ...o,
  };
}

let grid: NavGridData;
let bodies: OverlayBody[];
let inGrid: Set<string>;

beforeEach(() => {
  grid = bakeNavGrid(doorwayRooms(3.25, 4.75)).grid;
  bodies = [];
  inGrid = new Set();
  resetPortFlags();
  bindNav({ grid: () => grid, bodies: () => bodies, inGrid: (_p, id) => inGrid.has(id), vm: () => 'client' });
});
afterEach(() => {
  bindNav(null);
  resetPortFlags();
});

describe('nav overlay', () => {
  it("a closed door blocks 'all' unless ignored; 'static' walks through it", () => {
    expect(findPath(CTX, FROM, TO, { radius: 0.35, height: 1.8 }).ok).toBe(true);
    bodies = [door()];
    // the trader trail's call: bodies default 'all'
    const blocked = findPath(CTX, FROM, TO, { radius: 0.35, height: 1.8 });
    expect(blocked.ok).toBe(false);
    expect(blocked.points.length).toBeGreaterThan(0);
    expect(blocked.points[blocked.points.length - 1]!.x).toBeLessThan(4);
    expect(findPath(CTX, FROM, TO, { radius: 0.35, height: 1.8, bodies: 'all' }).ok).toBe(false);
    expect(findPath(CTX, FROM, TO, { radius: 0.35, height: 1.8, ignore: ['door-1'] }).ok).toBe(true);
    // the enemy and bot mode
    expect(findPath(CTX, FROM, TO, { radius: 0.35, height: 1.8, bodies: 'static' }).ok).toBe(true);
  });

  it('a door that swung open is blocked where its leaf stands now', () => {
    // 90° about the hinge: the leaf lies along the wall's far face and leaves the doorway free
    bodies = [door({ rot: yaw(90) })];
    const r = findPath(CTX, FROM, TO, { radius: 0.35, height: 1.8 });
    expect(r.ok).toBe(true);
    // the leaf itself is in the way of a walk along the far wall face
    const prints = overlayFootprints(bodies, { bodies: 'all', ignore: [] });
    expect(prints.length).toBe(1);
    expect(prints[0]!.cx).toBeCloseTo(4.875, 5);
    expect(prints[0]!.cz).toBeCloseTo(3.25, 5);
    // a door wrecked to "none" blocks nothing
    bodies = [door({ enabled: false })];
    expect(findPath(CTX, FROM, TO, { radius: 0.35, height: 1.8 }).ok).toBe(true);
  });

  it("a supply terminal blocks 'static' while it stands and stops when it is switched to \"none\"", () => {
    bodies = [terminal()];
    expect(findPath(CTX, FROM, TO, { radius: 0.35, height: 1.8, bodies: 'static' }).ok).toBe(false);
    expect(findPath(CTX, FROM, TO, { radius: 0.35, height: 1.8 }).ok).toBe(false);
    bodies = [terminal({ enabled: false })];
    expect(findPath(CTX, FROM, TO, { radius: 0.35, height: 1.8, bodies: 'static' }).ok).toBe(true);
  });

  it('ignore names a row and its / children; no stamp outlives its query', () => {
    bodies = [door({ rowId: 'door-1/leaf' })];
    expect(findPath(CTX, FROM, TO, { ignore: ['door-1'] }).ok).toBe(true);
    expect(findPath(CTX, FROM, TO, { ignore: ['door'] }).ok).toBe(false);
    expect(findPath(CTX, FROM, TO, { ignore: ['door-1/leaf'] }).ok).toBe(true);
    // the blocked query before this one left nothing behind
    expect(findPath(CTX, FROM, TO, { bodies: 'static' }).ok).toBe(true);
    bodies = [];
    expect(findPath(CTX, FROM, TO).ok).toBe(true);
    expect(ignoredId('door-1/leaf', ['door-1'])).toBe(true);
    expect(ignoredId('door-10', ['door-1'])).toBe(false);
  });

  it('characters, dynamic bodies, sensors and rows already in the grid are never stamped', () => {
    const shape = { shape: { box: [1, 2, 1.4] as const }, m: m34([4.125, 0, 4]) };
    bodies = [
      { rowId: 'zed', kind: 'character', enabled: true, sensor: false, pos: v(4.125, 0, 4), rot: IDENTITY, parts: [shape] },
      { rowId: 'gib', kind: 'dynamic', enabled: true, sensor: false, pos: v(4.125, 0, 4), rot: IDENTITY, parts: [shape] },
      terminal({ rowId: 'portal', sensor: true }),
      terminal({ rowId: 'wall-row' }),
    ];
    inGrid.add('wall-row');
    expect(findPath(CTX, FROM, TO).ok).toBe(true);
    expect(overlayFootprints(bodies, { bodies: 'all', ignore: [], inGrid: (id) => inGrid.has(id) })).toEqual([]);
    inGrid.clear();
    expect(findPath(CTX, FROM, TO).ok).toBe(false);
    // the pack says which rows the bake took
    expect([...gridRowIds({ instances: [
      { rowId: 'a', mutable: false, kinematic: false }, { rowId: 'b', mutable: true, kinematic: false }, { rowId: 'c', mutable: true, kinematic: true },
    ] })]).toEqual(['a']);
  });

  it('a body standing against a stamped row walks away from it, and never through it', () => {
    bodies = [door()];
    // pressed to the closed door (its face is at x 4.05), overlapping it a little as bodies in contact do
    for (const radius of [0.35, 0.6]) {
      const from = v(4.05 - radius + 0.1, 0, 4);
      const away = findPath(CTX, from, v(1, 0, 1), { radius, height: 1.8 });
      expect(away.ok, `radius ${radius}`).toBe(true);
      const through = findPath(CTX, from, TO, { radius, height: 1.8 });
      expect(through.ok, `radius ${radius}`).toBe(false);
      expect(through.points[through.points.length - 1]!.x, `radius ${radius}`).toBeLessThan(4);
    }
    // the terminal is 1 m deep: a body against its near face cannot come out on the far side either
    bodies = [terminal()];
    const r = findPath(CTX, v(3.4, 0, 4), TO, { radius: 0.35, height: 1.8, bodies: 'static' });
    expect(r.ok).toBe(false);
    expect(r.points[r.points.length - 1]!.x).toBeLessThan(4);
    expect(findPath(CTX, v(3.4, 0, 4), v(1, 0, 6), { radius: 0.35, height: 1.8, bodies: 'static' }).ok).toBe(true);
  });

  it('a body blocks the spans it stands over, grown by the agent radius, and only at its own height', () => {
    const stamps = new OverlayStamps(grid);
    const prints = overlayFootprints([terminal()], { bodies: 'static', ignore: [] });
    const at = (x: number, z: number): number => grid.locate(v(x, 0, z), 0.6, 2);
    stamps.begin();
    stamps.stamp(prints, { radius: 0.35, height: 1.8, step: 0.4 });
    // the terminal covers x 3.625 … 4.625, z 3.3 … 4.7
    expect(stamps.blocked(at(4.4, 4))).toBe(true);
    expect(stamps.blocked(at(4.9, 4))).toBe(true); // 0.275 m off its face: inside a 0.35 m body's reach
    expect(stamps.blocked(at(5.15, 4))).toBe(false);
    stamps.begin();
    expect(stamps.count).toBe(0);
    expect(stamps.blocked(at(4.4, 4))).toBe(false);
    stamps.stamp(prints, { radius: 0, height: 1.8, step: 0.4 });
    expect(stamps.blocked(at(4.9, 4))).toBe(false);
    // a body the agent steps over, and one above its head, block nothing
    stamps.begin();
    stamps.stamp(overlayFootprints([terminal({ parts: [{ shape: { box: [1, 0.3, 1.4] }, m: m34([4.125, 0, 4]) }] })], { bodies: 'static', ignore: [] }), { radius: 0.35, height: 1.8, step: 0.4 });
    stamps.stamp(overlayFootprints([terminal({ parts: [{ shape: { box: [1, 0.3, 1.4] }, m: m34([4.125, 2.0, 4]) }] })], { bodies: 'static', ignore: [] }), { radius: 0.35, height: 1.8, step: 0.4 });
    expect(stamps.count).toBe(0);
  });
});
