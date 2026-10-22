// raycast.test (motion §6.4): every option row of motion §6.2 through `builtin/physics.raycast` on a fixture place: box room,
// a crate, a kinematic door, an instanced static terminal, characters (one spectating), a gib, a sensor, a terrain patch,
// anonymous geometry and far walls; plus a second resident place and a render-only visual-proxy layer for `hits:'both'`.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bindPhysicsQueries, getInputRay, jumpCheck, overlapPoint, overlapSegment, raycast, traverseCheck, type RaycastHit,
} from '../../../src/compat/builtin/physics.ts';
import { StaticBvh } from '../../../src/compat/physics/bvh.ts';
import { v3 } from '../../../src/compat/physics/math.ts';
import { BodyList, QueryScene, type QueryBody } from '../../../src/compat/physics/query.ts';
import { boxTriangles, capsuleFromFeet, meshShape, obbShape, sphereShape } from '../../../src/compat/physics/shapes.ts';

const quad = (ax: number[], bx: number[], cx: number[], dx: number[]): Float32Array => new Float32Array([...ax, ...bx, ...cx, ...ax, ...cx, ...dx]);
const translate = (x: number, y: number, z: number): Float64Array => new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1, x, y, z]);
const box = (cx: number, cy: number, cz: number, hx: number, hy: number, hz: number): Float32Array =>
  boxTriangles(v3(hx, hy, hz), translate(cx, cy, cz));
const meshBox = (hx: number, hy: number, hz: number, x: number, y: number, z: number): ReturnType<typeof meshShape> =>
  meshShape(StaticBvh.build(boxTriangles(v3(hx, hy, hz), null)), translate(x, y, z));
const body = (b: Omit<QueryBody, 'active' | 'sensor'> & { active?: boolean; sensor?: boolean }): QueryBody =>
  ({ active: true, sensor: false, ...b });

let arena: QueryScene;
let other: QueryScene;
let unbuilt: QueryScene;
let warnings: string[];
const ctx = { place: { id: 'arena' }, self: { id: 'player-1' } };
const eye = { x: 0, y: 1, z: 0 };
const fwd = { x: 0, y: 0, z: -1 };

function makeArena(): QueryScene {
  const s = new QueryScene('arena');
  s.addStatic('floor', ['ground'], quad([-20, 0, -20], [20, 0, -20], [20, 0, 20], [-20, 0, 20]));
  s.addStatic('wall-n', ['wall'], quad([-10, 0, -10], [10, 0, -10], [10, 4, -10], [-10, 4, -10]));
  s.addStatic('crate', ['prop'], box(0, 0.6, -5, 0.6, 0.6, 0.6));
  s.addStatic(null, [], box(-15, 1, 0, 1, 1, 1));
  s.addStatic('terrain/arena', [], quad([30, -1, -10], [50, -1, -10], [50, -1, 10], [30, -1, 10]));
  s.addStatic('far-150', ['wall'], quad([150, 0, -2], [150, 0, 2], [150, 3, 2], [150, 3, -2]));
  s.addStatic('far-250', ['wall'], quad([-250, 0, 10], [-250, 0, 20], [-250, 3, 20], [-250, 3, 10]));
  s.build();
  s.addBody(body({ rowId: 'player-1', kind: 'character', tags: ['player'], shape: capsuleFromFeet({ x: 0, y: 0, z: 0 }, 1.8, 0.35) }));
  s.addBody(body({ rowId: 'player-1/gear', kind: 'dynamic', tags: ['gear'], shape: sphereShape(v3(0, 1, -1), 0.2) }));
  s.addBody(body({ rowId: 'bot-1', kind: 'character', tags: ['bot'], active: false, shape: capsuleFromFeet({ x: 0, y: 0, z: -1.5 }, 1.8, 0.35) }));
  s.addBody(body({ rowId: 'portal-1', kind: 'static', tags: ['portal'], sensor: true, shape: obbShape(v3(0, 1, -2), v3(2, 2, 0.1), null) }));
  s.addBody(body({ rowId: 'enemy-1', kind: 'character', tags: ['enemy'], shape: capsuleFromFeet({ x: 0, y: 0, z: -3 }, 1.8, 0.35) }));
  s.addBody(body({ rowId: 'gib-1', kind: 'dynamic', tags: ['gib'], shape: sphereShape(v3(0, 1, -6.5), 0.2) }));
  s.addBody(body({ rowId: 'door-1', kind: 'kinematic', tags: ['door'], shape: meshBox(1, 1.25, 0.05, 0, 1.25, -8) }));
  s.addBody(body({ rowId: 'terminal-1', kind: 'static', tags: ['terminal'], shape: meshBox(0.3, 0.3, 0.3, 0, 1, -9) }));
  return s;
}

beforeEach(() => {
  warnings = [];
  arena = makeArena();
  other = new QueryScene('other');
  other.addStatic('other-floor', [], quad([-5, 0, -5], [5, 0, -5], [5, 0, 5], [-5, 0, 5]));
  other.build();
  unbuilt = new QueryScene('cellar');
  unbuilt.addStatic('cellar-floor', [], quad([-5, 0, -5], [5, 0, -5], [5, 0, 5], [-5, 0, 5]));
  const worlds = new Map([['arena', arena], ['other', other], ['cellar', unbuilt]]);
  bindPhysicsQueries({ world: (p) => worlds.get(p) ?? null, warn: (m) => warnings.push(m) });
});
afterEach(() => bindPhysicsQueries(null));

const one = (h: unknown): RaycastHit => {
  expect(h).not.toBeNull();
  expect(Array.isArray(h)).toBe(false);
  return h as RaycastHit;
};
const list = (h: unknown): RaycastHit[] => {
  expect(Array.isArray(h)).toBe(true);
  return h as RaycastHit[];
};
const ids = (h: unknown): Array<string | null> => list(h).map((x) => x.id);

describe('raycast: hit shape and defaults', () => {
  it('returns {id, position, normal, distance, tags, body} for the nearest hit; the caller is ignored by default', () => {
    const h = one(raycast(ctx, eye, fwd));
    expect(h.id).toBe('enemy-1');
    expect(h.distance).toBeCloseTo(2.65, 9);
    expect(h.position.x).toBeCloseTo(0, 12);
    expect(h.position.y).toBeCloseTo(1, 12);
    expect(h.position.z).toBeCloseTo(-2.65, 9);
    expect(h.normal.z).toBeCloseTo(1, 9);
    expect(h.tags).toEqual(['enemy']);
    expect(h.body).toBe('character');
  });

  it('returns fresh objects per call', () => {
    const a = one(raycast(ctx, eye, fwd));
    a.position.x = 99;
    (a.tags as string[]).push('x');
    const b = one(raycast(ctx, eye, fwd));
    expect(b.position.x).toBeCloseTo(0, 12);
    expect(b.tags).toEqual(['enemy']);
  });

  it('a number as opts is the distance', () => {
    expect(raycast(ctx, eye, fwd, 2)).toBeNull();
    expect(one(raycast(ctx, eye, fwd, 3)).id).toBe('enemy-1');
  });

  it('normalises the direction; a zero or non-finite direction or origin answers null', () => {
    expect(one(raycast(ctx, eye, { x: 0, y: 0, z: -5 })).distance).toBeCloseTo(2.65, 9);
    expect(raycast(ctx, eye, { x: 0, y: 0, z: 0 })).toBeNull();
    expect(raycast(ctx, eye, { x: Number.NaN, y: 0, z: -1 })).toBeNull();
    expect(raycast(ctx, { x: Number.NaN, y: 1, z: 0 }, fwd)).toBeNull();
  });

  it('distance defaults to 200 m', () => {
    expect(one(raycast(ctx, eye, { x: 1, y: 0, z: 0 })).id).toBe('far-150');
    expect(one(raycast(ctx, eye, { x: 1, y: 0, z: 0 })).distance).toBeCloseTo(150, 9);
    expect(raycast(ctx, { x: 0, y: 1, z: 15 }, { x: -1, y: 0, z: 0 })).toBeNull();
    expect(one(raycast(ctx, { x: 0, y: 1, z: 15 }, { x: -1, y: 0, z: 0 }, { distance: 300 })).id).toBe('far-250');
    expect(raycast(ctx, eye, fwd, { distance: 2.6 })).toBeNull();
    expect(one(raycast(ctx, eye, fwd, { distance: 2.7 })).id).toBe('enemy-1');
  });

  it('triangles are two-sided and the normal faces the ray origin', () => {
    const h = one(raycast(ctx, { x: 0, y: -1, z: 5 }, { x: 0, y: 1, z: 0 }));
    expect(h.id).toBe('floor');
    expect(h.distance).toBeCloseTo(1, 12);
    expect(h.normal.y).toBeCloseTo(-1, 12);
    const top = one(raycast(ctx, { x: 0, y: 3, z: 5 }, { x: 0, y: -1, z: 0 }));
    expect(top.normal.y).toBeCloseTo(1, 12);
  });

  it('terrain hits carry the id terrain/<place>; anonymous geometry has id null', () => {
    const t = one(raycast(ctx, { x: 40, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }));
    expect(t.id).toBe('terrain/arena');
    expect(t.body).toBe('static');
    expect(t.distance).toBeCloseTo(6, 12);
    const a = one(raycast(ctx, { x: -12, y: 1, z: 0 }, { x: -1, y: 0, z: 0 }));
    expect(a.id).toBeNull();
    expect(a.distance).toBeCloseTo(2, 12);
  });
});

describe('raycast: bodies truth table', () => {
  const opts = { multiple: true, ignoreSelf: false } as const;
  it("'all' = static + kinematic + dynamic + character capsules; never sensors or spectating bodies", () => {
    const hits = list(raycast(ctx, eye, fwd, { ...opts }));
    expect(hits.map((h) => h.id)).toEqual(['player-1', 'player-1/gear', 'enemy-1', 'crate', 'gib-1', 'door-1', 'terminal-1', 'wall-n']);
    expect(hits.map((h) => h.body)).toEqual(['character', 'dynamic', 'character', 'static', 'dynamic', 'kinematic', 'static', 'static']);
    expect(hits.map((h) => +h.distance.toFixed(6))).toEqual([0.35, 0.8, 2.65, 4.4, 6.3, 7.95, 8.7, 10]); // soups are Float32
    expect(list(raycast(ctx, eye, fwd, { ...opts, bodies: 'all' })).length).toBe(8);
  });
  it("'static' = the static soup + instanced static rows; no kinematic, dynamic or character", () => {
    expect(ids(raycast(ctx, eye, fwd, { ...opts, bodies: 'static' }))).toEqual(['crate', 'terminal-1', 'wall-n']);
    expect(one(raycast(ctx, { x: 0, y: 1, z: -7.5 }, fwd, { bodies: 'static' })).id).toBe('terminal-1');
    expect(one(raycast(ctx, { x: 0, y: 1, z: -7.5 }, fwd, { bodies: 'all' })).id).toBe('door-1');
  });
  it("'dynamic' = dynamic bodies only", () => {
    expect(ids(raycast(ctx, eye, fwd, { ...opts, bodies: 'dynamic' }))).toEqual(['player-1/gear', 'gib-1']);
    expect(one(raycast(ctx, eye, fwd, { bodies: 'dynamic' })).id).toBe('gib-1');
  });
});

describe('raycast: entity and tag filters', () => {
  it('ignoreSelf (default true) skips the caller and its /children; false hits them (from inside: the exit)', () => {
    const h = one(raycast(ctx, eye, fwd, { ignoreSelf: false }));
    expect(h.id).toBe('player-1');
    expect(h.distance).toBeCloseTo(0.35, 9);
    expect(h.normal.z).toBeCloseTo(1, 9);
    expect(one(raycast(ctx, eye, fwd, { ignoreSelf: true })).id).toBe('enemy-1');
  });
  it('a ctx without self (sim ctx) ignores nothing', () => {
    expect(one(raycast({ place: { id: 'arena' } }, eye, fwd)).id).toBe('player-1');
  });
  it('ignoreEntities skips those ids and their /children, not mere prefixes', () => {
    expect(one(raycast(ctx, eye, fwd, { ignoreEntities: ['enemy-1'] })).id).toBe('crate');
    expect(one(raycast(ctx, eye, fwd, { ignoreEntities: ['enemy'] })).id).toBe('enemy-1');
    expect(one(raycast(ctx, eye, fwd, { ignoreSelf: false, ignoreEntities: ['player-1'] })).id).toBe('enemy-1');
    expect(one(raycast(ctx, eye, fwd, { ignoreSelf: false, ignoreEntities: ['player'] })).id).toBe('player-1');
  });
  it('excludeTags returns the next qualifying hit behind; tags requires every listed tag', () => {
    expect(one(raycast(ctx, eye, fwd, { excludeTags: ['enemy'] })).id).toBe('crate');
    expect(one(raycast(ctx, eye, fwd, { excludeTags: ['enemy', 'prop'] })).id).toBe('gib-1');
    expect(one(raycast(ctx, eye, fwd, { tags: ['door'] })).id).toBe('door-1');
    expect(one(raycast(ctx, eye, fwd, { tags: ['wall'] })).id).toBe('wall-n');
    expect(raycast(ctx, eye, fwd, { tags: ['wall', 'door'] })).toBeNull();
    expect(raycast(ctx, eye, fwd, { tags: ['no-such-tag'] })).toBeNull();
    expect(one(raycast(ctx, eye, fwd, { excludeTags: ['no-such-tag'] })).id).toBe('enemy-1');
  });
  it('physicsOnly is accepted and changes nothing (no live row is a sprite)', () => {
    expect(one(raycast(ctx, eye, fwd, { physicsOnly: true })).id).toBe('enemy-1');
    expect(one(raycast(ctx, eye, fwd, { physicsOnly: false })).id).toBe('enemy-1');
  });
});

describe('raycast: multiple', () => {
  it('lists every hit sorted by distance, one per collider, filters applied', () => {
    const hits = list(raycast(ctx, eye, fwd, { multiple: true }));
    expect(hits.map((h) => h.id)).toEqual(['enemy-1', 'crate', 'gib-1', 'door-1', 'terminal-1', 'wall-n']);
    for (let i = 1; i < hits.length; i++) expect(hits[i]!.distance).toBeGreaterThan(hits[i - 1]!.distance);
    expect(ids(raycast(ctx, eye, fwd, { multiple: true, excludeTags: ['enemy', 'gib'], distance: 9 }))).toEqual(['crate', 'door-1', 'terminal-1']);
    expect(ids(raycast(ctx, eye, fwd, { multiple: true, ignoreEntities: ['crate', 'door-1'], bodies: 'static' }))).toEqual(['terminal-1', 'wall-n']);
  });
  it('an empty result is []', () => {
    expect(raycast(ctx, eye, { x: 0, y: 1, z: 0 }, { multiple: true })).toEqual([]);
  });
});

describe('raycast: radius (sphere cast)', () => {
  it('distance = TOI of the centre, position = contact point on the surface, normal = surface normal there', () => {
    const h = one(raycast(ctx, { x: -12, y: 1, z: 0 }, { x: -1, y: 0, z: 0 }, { radius: 0.5 }));
    expect(h.id).toBeNull();
    expect(h.distance).toBeCloseTo(1.5, 9);
    expect(h.position.x).toBeCloseTo(-14, 9);
    expect(h.position.z).toBeCloseTo(0, 9);
    expect(h.normal.x).toBeCloseTo(1, 9);
  });
  it('against a corner (vertical box edge)', () => {
    const h = one(raycast(ctx, { x: -12, y: 1, z: 1.3 }, { x: -1, y: 0, z: 0 }, { radius: 0.5 }));
    expect(h.distance).toBeCloseTo(1.6, 6);
    expect(h.position.x).toBeCloseTo(-14, 6);
    expect(h.position.z).toBeCloseTo(1, 6);
    expect(h.normal.x).toBeCloseTo(0.8, 6);
    expect(h.normal.z).toBeCloseTo(0.6, 6);
  });
  it('against bodies (character capsule) with the same filters', () => {
    const h = one(raycast(ctx, eye, fwd, { radius: 0.25 }));
    expect(h.id).toBe('enemy-1');
    expect(h.distance).toBeCloseTo(2.4, 9);
    expect(h.position.z).toBeCloseTo(-2.65, 9);
    expect(h.normal.z).toBeCloseTo(1, 9);
    expect(one(raycast(ctx, eye, fwd, { radius: 0.25, bodies: 'static' })).id).toBe('crate');
  });
  it('a sphere starting in contact and moving away is not stopped', () => {
    const h = raycast(ctx, { x: -13.8, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, { radius: 0.5, distance: 3 });
    expect(h).toBeNull();
  });
});

describe("raycast: hits:'both' (render-only visual proxies, X-42)", () => {
  const down = { x: 0, y: -1, z: 0 };
  const top = { x: 25, y: 400, z: 25 };
  it('answers colliders-only and logs once while no proxy layer exists', () => {
    expect(raycast(ctx, top, down, { distance: 600, hits: 'both' })).toBeNull();
    expect(raycast(ctx, top, down, { distance: 600, hits: 'both' })).toBeNull();
    expect(warnings.filter((w) => w.includes("hits:'both'")).length).toBe(1);
  });
  it('sees a render-only box that a collider ray misses', () => {
    const pine: QueryBody = body({ rowId: 'pine-1', kind: 'static', tags: ['tree'], shape: meshBox(1, 1, 1, 25, 5, 25) });
    arena.setVisualProxies(new BodyList([pine]));
    expect(raycast(ctx, top, down, { distance: 600 })).toBeNull();
    const h = one(raycast(ctx, top, down, { distance: 600, hits: 'both', excludeTags: ['enemy'] }));
    expect(h.id).toBe('pine-1');
    expect(h.distance).toBeCloseTo(394, 9);
    expect(h.body).toBe('static');
    expect(raycast(ctx, top, down, { distance: 600, hits: 'both', excludeTags: ['tree'] })).toBeNull();
    // the sphere cast of the overhead camera probe too
    expect(one(raycast(ctx, top, down, { distance: 600, hits: 'both', radius: 0.3 })).distance).toBeCloseTo(393.7, 9);
  });
});

describe('raycast: place, verdict, ignored options, unbuilt worlds', () => {
  it('place queries that place; a non-resident place answers null; no place answers null', () => {
    const h = one(raycast(ctx, { x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, { place: 'other' }));
    expect(h.id).toBe('other-floor');
    expect(raycast(ctx, { x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, { place: 'nowhere' })).toBeNull();
    expect(raycast({ place: null }, eye, fwd)).toBeNull();
    expect(one(raycast({ place: null }, { x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, { place: 'other' })).id).toBe('other-floor');
  });
  it('a place whose physics is not built answers null (X-32)', () => {
    expect(raycast(ctx, { x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, { place: 'cellar' })).toBeNull();
    unbuilt.build();
    expect(one(raycast(ctx, { x: 0, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, { place: 'cellar' })).id).toBe('cellar-floor');
  });
  it('unbound (no physics port yet) answers null', () => {
    bindPhysicsQueries(null);
    expect(raycast(ctx, eye, fwd)).toBeNull();
  });
  it('verdict wraps the result', () => {
    const v = raycast(ctx, eye, fwd, { verdict: true }) as { hit: RaycastHit | null; hits: RaycastHit[]; verdict: { queryable: boolean; terrain: boolean } };
    expect(v.hit?.id).toBe('enemy-1');
    expect(v.hits.map((h) => h.id)).toEqual(['enemy-1']);
    expect(v.verdict).toEqual({ queryable: true, terrain: false });
    const t = raycast(ctx, { x: 40, y: 5, z: 0 }, { x: 0, y: -1, z: 0 }, { verdict: true }) as typeof v;
    expect(t.verdict.terrain).toBe(true);
    const m = raycast(ctx, eye, fwd, { verdict: true, multiple: true }) as typeof v;
    expect(m.hits.length).toBe(6);
    expect(m.hit?.id).toBe('enemy-1');
    const none = raycast(ctx, eye, { x: 0, y: 1, z: 0 }, { verdict: true }) as typeof v;
    expect(none).toEqual({ hit: null, hits: [], verdict: { queryable: true, terrain: false } });
  });
  it('through and shape are ignored with one dev warning each', () => {
    expect(one(raycast(ctx, eye, fwd, { through: true, shape: 'box' })).id).toBe('enemy-1');
    expect(one(raycast(ctx, eye, fwd, { through: true, shape: 'box' })).id).toBe('enemy-1');
    expect(warnings.filter((w) => w.includes('through')).length).toBe(1);
    expect(warnings.filter((w) => w.includes('shape')).length).toBe(1);
  });
});

describe('builtin/physics loud stubs', () => {
  it('unused verbs throw "<verb> is not available in this build"', () => {
    expect(() => overlapPoint(ctx, eye)).toThrow('overlapPoint is not available in this build');
    expect(() => overlapSegment(ctx, eye, eye)).toThrow('overlapSegment is not available in this build');
    expect(() => traverseCheck(ctx, eye, eye)).toThrow('traverseCheck is not available in this build');
    expect(() => jumpCheck(ctx, eye, eye, {})).toThrow('jumpCheck is not available in this build');
  });
  it('getInputRay is exported (implemented by PH3)', () => {
    expect(typeof getInputRay).toBe('function');
  });
});
