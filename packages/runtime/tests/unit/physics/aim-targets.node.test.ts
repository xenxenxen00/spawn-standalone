// aim-targets.test (motion §6.1, io §4.8.4; WP PH3): the port-only touch aim query. Candidate points are the chest (capsule
// centre) and the head (capsule top minus its radius) of character bodies tagged `enemy` within `maxDist` of the eye; a
// candidate counts when it is within `radius` of the ray and a static ray from the eye reaches it unblocked.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PhysicsPortImpl } from '../../../src/compat/physics/port.ts';
import { aimTargets } from '../../../src/compat/physics/rapier/query.ts';
import { bakeOf, fakeRow, fakeStore, setPos, type FakeStore } from './port-fixtures.ts';
import { FLOOR, TICK, packOf } from './rapier-fixtures.ts';

const EYE = { x: 0, y: 1.7, z: 0 };
const FWD = { x: 0, y: 0, z: -1 };
const R = 0.45, MAX = 40;
let port: PhysicsPortImpl;
let store: FakeStore;

beforeEach(() => {
  store = fakeStore();
  port = new PhysicsPortImpl({ host: { store } });
  // a wall across x from -1 to 9 at z = -15, 3 m high
  port.buildPlace('home', bakeOf(packOf('home', [FLOOR, { row: 'wall', box: [5, 1.5, 0.2], at: [4, 1.5, -15] }])));
});
afterEach(() => port.dispose());

function enemy(id: string, x: number, z: number, o: { tags?: string[]; height?: number; radius?: number; spectating?: boolean } = {}): ReturnType<typeof fakeRow> {
  const row = store.add(fakeRow(id, {
    physics: { body: 'character', capsule: { height: o.height ?? 1.8, radius: o.radius ?? 0.34 } }, pos: { x, y: 0.01, z }, tags: o.tags ?? ['enemy'],
    ...(o.spectating ? { spectating: true } : {}),
  }));
  port.rowSpawned(row);
  return row;
}
const ids = (list: Array<{ id: string }>): string[] => list.map((t) => t.id);

describe('aimTargets', () => {
  it('defaults to eligible characters and lets a host select any candidate tags', () => {
    enemy('friend', 0.1, -8, { tags: ['ally'] }); enemy('foe', 0.1, -12, { tags: ['enemy'] }); port.step('home', TICK);
    expect(ids(port.aimTargets('home', EYE, FWD, MAX, R))).toEqual(['friend', 'foe']);
    expect(ids(port.aimTargets('home', EYE, FWD, MAX, R, { tags: ['ally'] }))).toEqual(['friend']);
    expect(ids(aimTargets('home', EYE, FWD, MAX, R, { tags: ['ally'] }))).toEqual(['friend']);
    expect(port.aimTargets('home', EYE, FWD, MAX, R, { tags: ['missing'] })).toEqual([]);
  });
  it('the chest and the head of an enemy inside the radius count, each with its point and distance, nearest first', () => {
    enemy('en-1', 0.1, -10);
    port.step('home', TICK);
    const hits = port.aimTargets('home', EYE, FWD, MAX, R, { tags: ['enemy'] });
    // head: y = 0.01 + 1.8 - 0.34 = 1.47 (0.23 under the ray), chest: y = 0.91 (0.79 under it, outside 0.45)
    expect(hits).toHaveLength(1);
    expect(hits[0]!.id).toBe('en-1');
    expect(hits[0]!.point.x).toBeCloseTo(0.1, 5);
    expect(hits[0]!.point.y).toBeCloseTo(1.47, 5);
    expect(hits[0]!.point.z).toBeCloseTo(-10, 5);
    expect(hits[0]!.distance).toBeCloseTo(Math.hypot(0.1, 0.23, 10), 4);
    // aiming between head and chest: both
    const mid = { x: 0, y: 1.19 - 1.7, z: -10 };
    const both = port.aimTargets('home', EYE, mid, MAX, R);
    expect(both.map((t) => +t.point.y.toFixed(2))).toEqual([0.91, 1.47].sort((a, b) => Math.hypot(a - 1.7, 10) - Math.hypot(b - 1.7, 10)));
    expect(both.every((t) => t.id === 'en-1')).toBe(true);
    expect(both[0]!.distance).toBeLessThanOrEqual(both[1]!.distance);
    // the module-level entry point (the one IN3 imports) answers through the port made last
    expect(aimTargets('home', EYE, FWD, MAX, R)).toEqual(hits);
  });

  it('outside the radius does not count; the direction need not be unit; behind the eye nothing counts', () => {
    enemy('en-1', 0.8, -10);
    port.step('home', TICK);
    expect(port.aimTargets('home', EYE, FWD, MAX, R, { tags: ['enemy'] })).toEqual([]);
    expect(ids(port.aimTargets('home', EYE, FWD, MAX, 0.9))).toEqual(['en-1']);
    expect(ids(port.aimTargets('home', EYE, { x: 0, y: 0, z: -7 }, MAX, 0.9))).toEqual(['en-1']);
    expect(port.aimTargets('home', EYE, { x: 0, y: 0, z: 1 }, MAX, 0.9)).toEqual([]);
    expect(port.aimTargets('home', EYE, { x: 0, y: 0, z: 0 }, MAX, 0.9)).toEqual([]);
  });

  it('beyond maxDist does not count; several enemies come nearest first', () => {
    enemy('far', 0, -39.5);
    enemy('near', 0, -6);
    enemy('beyond', 0, -45);
    // only the wall-free lane x < -1 is used here
    for (const id of ['far', 'near', 'beyond']) { const r = store.get(id)!; port.setPosition(r, setPos(r, { x: -3, y: 0.01, z: r.tf.pos.z })); }
    port.step('home', TICK);
    const eye = { x: -3, y: 1.7, z: 0 };
    expect(ids(port.aimTargets('home', eye, FWD, MAX, R))).toEqual(['near', 'far']);
    expect(ids(port.aimTargets('home', eye, FWD, 20, R))).toEqual(['near']);
    expect(ids(port.aimTargets('home', eye, FWD, 60, R))).toEqual(['near', 'far', 'beyond']);
  });

  it('behind a wall does not count (one static ray per candidate); a body in the line of sight is no wall', () => {
    enemy('hidden', 0.1, -20);
    enemy('front', 0.1, -8);
    port.step('home', TICK);
    // the wall at z = -15 hides the far one; the near enemy standing in the line does not hide anything
    expect(ids(port.aimTargets('home', EYE, FWD, MAX, R, { tags: ['enemy'] }))).toEqual(['front']);
    port.rowDestroyed(store.get('front')!);
    port.step('home', TICK);
    expect(port.aimTargets('home', EYE, FWD, MAX, R, { tags: ['enemy'] })).toEqual([]);
    // from high above, the lines to its head and chest clear the 3 m wall (they pass z = -15 at y 4.1 and 3.7)
    const high = { x: 0.1, y: 12, z: 0 };
    expect(ids(port.aimTargets('home', high, { x: 0, y: 1.47 - 12, z: -20 }, MAX, 1))).toEqual(['hidden', 'hidden']);
    // from 6 m up the line to the head meets the wall at y 2.6
    expect(port.aimTargets('home', { x: 0.1, y: 6, z: 0 }, { x: 0, y: 1.47 - 6, z: -20 }, MAX, 1)).toEqual([]);
  });

  it('explicit tags restrict candidates; a spectating (disabled) body is no target; an unbuilt or unknown place answers []', () => {
    enemy('mate', 0.1, -6, { tags: ['teammate', 'bot'] });
    enemy('ghost', 0.1, -7, { spectating: true });
    const real = enemy('real', 0.1, -9, { tags: ['ss-match', 'enemy'] });
    port.step('home', TICK);
    expect(ids(port.aimTargets('home', EYE, FWD, MAX, R, { tags: ['enemy'] }))).toEqual(['real']);
    real.spectating = true;
    port.setSpectating(real, true);
    expect(port.aimTargets('home', EYE, FWD, MAX, R, { tags: ['enemy'] })).toEqual([]);
    expect(port.aimTargets('nowhere', EYE, FWD, MAX, R)).toEqual([]);
    port.disposePlace('home');
    expect(port.aimTargets('home', EYE, FWD, MAX, R, { tags: ['enemy'] })).toEqual([]);
    expect(aimTargets('home', EYE, FWD, MAX, R)).toEqual([]);
  });

  it('a boss capsule: the head point is the top minus ITS radius, the chest the centre', () => {
    enemy('boss', 0, -12, { height: 3.2, radius: 0.6 });
    port.step('home', TICK);
    const all = port.aimTargets('home', { x: 0, y: 2, z: 0 }, FWD, MAX, 1);
    expect(all.map((t) => +t.point.y.toFixed(2)).sort()).toEqual([1.61, 2.61]);
  });
});
