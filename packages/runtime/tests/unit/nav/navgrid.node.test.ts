// nav/navgrid.ts (motion §7.2): the runtime NavGrid (CSR spans + lookups), its binary form, the shared move rule and the
// component reachability the search's early-out reads.
import { describe, expect, it } from 'vitest';
import { bakeNavGrid } from '../../../src/compat/nav/bake.ts';
import {
  NAV_DIRS,
  PERMISSIVE,
  agentUnits,
  decodeNavGrid,
  encodeNavGrid,
  type NavGridData,
} from '../../../src/compat/nav/navgrid.ts';
import { boxRoom, catwalk } from './fixtures.ts';

const dir = (dx: number, dz: number): number => NAV_DIRS.findIndex((d) => d[0] === dx && d[1] === dz);

function sameGrid(a: NavGridData, b: NavGridData): void {
  expect(b.h).toEqual(a.h);
  for (const k of ['colStart', 'y', 'clear', 'slope', 'wall', 'comp', 'linkStart', 'linkTo'] as const) {
    expect(Array.from(b[k]), k).toEqual(Array.from(a[k]));
  }
}

describe('NavGridData', () => {
  const g = bakeNavGrid(catwalk()).grid;

  it('spansAt gives the CSR range of a column, spans sorted by y; cellOf inverts it', () => {
    const [a, b] = g.spansAt(12, 15);
    expect(b - a).toBe(2);
    expect(g.y[a]! < g.y[a + 1]!).toBe(true);
    expect(g.spansAt(-1, 0)).toEqual([0, 0]);
    expect(g.spansAt(0, 32)).toEqual([0, 0]);
    expect(g.cellX(a + 1)).toBe(12);
    expect(g.cellZ(a + 1)).toBe(15);
    expect(g.floorY(a + 1)).toBeCloseTo(3, 9);
    expect(g.clearM(a)).toBeCloseTo(2.8, 9);
  });

  it('locate picks the span nearest the point within [y − maxDown, y + maxUp], then the 8 neighbours', () => {
    const [a] = g.spansAt(12, 15);
    expect(g.locate({ x: 3.1, y: 0.05, z: 3.9 }, 0.6, 2)).toBe(a);
    expect(g.locate({ x: 3.1, y: 3.02, z: 3.9 }, 0.6, 2)).toBe(a + 1);
    expect(g.locate({ x: 3.1, y: 1.5, z: 3.9 }, 0.6, 2)).toBe(a); // 1.5 down to the floor, the deck is 1.5 up
    expect(g.locate({ x: 3.1, y: 1.5, z: 3.9 }, 0.6, 1)).toBe(-1);
    expect(g.locate({ x: -3, y: 0, z: 1 }, 0.6, 2)).toBe(-1);
    // a point just outside the grid edge snaps to the neighbouring column
    const s = g.locate({ x: -0.1, y: 0, z: 1.1 }, 0.6, 2);
    expect([g.cellX(s), g.cellZ(s)]).toEqual([0, 4]);
  });

  it('moveTarget: walk within step, drop one way within maxDrop with headroom over the edge', () => {
    const P = agentUnits(PERMISSIVE);
    const deck = g.spansAt(12, 14)[0] + 1;
    const below = g.spansAt(12, 12)[0];
    expect(g.moveTarget(deck, dir(0, 1), P)).toBe(g.spansAt(12, 15)[0] + 1); // along the deck
    expect(g.moveTarget(deck, dir(0, -1), P)).toBe(g.spansAt(12, 13)[0] + 1); // (12, 13) is the deck's edge row; from it…
    const edge = g.spansAt(12, 13)[0] + 1;
    expect(g.moveTarget(edge, dir(0, -1), P)).toBe(below); // …a 3 m drop to the ground
    expect(g.moveTarget(edge, dir(0, -1), agentUnits({ ...PERMISSIVE, maxDrop: 2.9 }))).toBe(-1);
    expect(g.moveTarget(below, dir(0, 1), P)).toBe(g.spansAt(12, 13)[0]); // ground → the floor under the deck
  });

  it('agentUnits converts metres to the stored units, conservatively', () => {
    expect(agentUnits({ radius: 0.35, height: 1.8, step: 0.4, slope: 50, maxDrop: 3 })).toEqual({
      wallMin: 18, clearMin: 36, slopeMax: 50, stepCm: 40, dropCm: 300, heightCm: 180,
    });
    expect(agentUnits({ radius: 0.4, height: 1, step: 0.45, slope: 45.5, maxDrop: 2 })).toMatchObject({ wallMin: 20, clearMin: 20, slopeMax: 45 });
  });

  it('passable tests clear, wall and slope against an agent class', () => {
    const P = agentUnits(PERMISSIVE);
    const [floorUnder] = g.spansAt(15, 15);
    expect(g.passable(floorUnder, P)).toBe(true);
    expect(g.passable(floorUnder, agentUnits({ ...PERMISSIVE, height: 2.85 }))).toBe(false);
    expect(g.passable(g.spansAt(0, 0)[0], P)).toBe(false); // 0.125 m from the grid edge
  });

  it('reachable follows drop links one way; comp 0 and overflow never refuse', () => {
    const deck = g.comp[g.spansAt(15, 15)[0] + 1]!;
    const ground = g.comp[g.spansAt(15, 15)[0]]!;
    expect(g.reachable(deck, deck)).toBe(true);
    expect(g.reachable(deck, ground)).toBe(true);
    expect(g.reachable(ground, deck)).toBe(false);
    expect(g.reachable(0, deck)).toBe(true);
    expect(g.reachable(ground, 0)).toBe(true);
    expect(g.reachable(0xffff, deck)).toBe(true);
  });
});

describe('binary form', () => {
  it('round-trips header, spans and component links', () => {
    for (const pack of [boxRoom(), catwalk()]) {
      const g = bakeNavGrid(pack).grid;
      const bytes = encodeNavGrid(g);
      expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe('PPNV');
      sameGrid(g, decodeNavGrid(bytes));
      // a copy at an odd byte offset decodes too (typed-array views never assume alignment)
      const shifted = new Uint8Array(bytes.length + 3);
      shifted.set(bytes, 3);
      sameGrid(g, decodeNavGrid(shifted.subarray(3)));
    }
  });

  it('rejects a foreign or truncated buffer', () => {
    const bytes = encodeNavGrid(bakeNavGrid(boxRoom()).grid);
    const bad = bytes.slice();
    bad[0] = 0x58;
    expect(() => decodeNavGrid(bad)).toThrow(/magic/);
    expect(() => decodeNavGrid(bytes.subarray(0, bytes.length - 7))).toThrow(/truncated/);
  });
});
