// raycast-rapier.test (motion §6.4, WP PH3): the PH1 `raycast` option table on the Rapier backend, with PH1's `QueryScene` as
// the oracle. The same fixture place is built both ways (arena-fixture.ts) and every option row goes through
// `builtin/physics.raycast` twice; the answers must agree: ids and bodies equal, distances within 1 mm, normals within 1e-3,
// positions within 1 mm.
//
// Known differences (Rapier casts with `solid: true`; listed here, asserted below):
//   1. a ray that starts INSIDE a convex collider (a capsule, a cuboid, a ball) answers distance 0 on it, normal facing the
//      ray; the oracle answers the exit point. It shows with `ignoreSelf: false` from inside the caller's own capsule.
//   2. a box of more than 1.5 m half extent is a hollow trimesh shell in Rapier (defaults.CUBOID_MAX_HALF_EXTENT), so a ray
//      starting inside one answers its far wall, like the oracle, and not distance 0.
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { bindPhysicsQueries, raycast, type RaycastHit, type RaycastOptions } from '../../../src/compat/builtin/physics.ts';
import type { VisualProxySoup } from '../../../src/compat/core/ports.ts';
import { v3 } from '../../../src/compat/physics/math.ts';
import type { QueryScene } from '../../../src/compat/physics/query.ts';
import type { RapierQueryWorld } from '../../../src/compat/physics/rapier/query.ts';
import type { PhysicsWorld } from '../../../src/compat/physics/rapier/world.ts';
import { boxTriangles } from '../../../src/compat/physics/shapes.ts';
import { VisualProxyLayer } from '../../../src/compat/physics/visual-proxy.ts';
import { arenaRapier, arenaScene } from './arena-fixture.ts';
import { centred } from './rapier-fixtures.ts';

type V = { x: number; y: number; z: number };
type Case = [name: string, origin: V, dir: V, opts?: number | RaycastOptions];

const ctx = { place: { id: 'arena' }, self: { id: 'player-1' } };
const eye: V = { x: 0, y: 1, z: 0 };
const fwd: V = { x: 0, y: 0, z: -1 };
const down: V = { x: 0, y: -1, z: 0 };
const top: V = { x: 25, y: 400, z: 25 };

/** a render-only pine crown over open ground: a 2 m box centred at (25, 5, 25), as an X-42 soup (one key, one 4×4 instance) */
const PROXIES: VisualProxySoup = {
  keys: [{ key: 'pine|{}|0', tris: boxTriangles(v3(1, 1, 1), null) }],
  instances: [{ key: 'pine|{}|0', rowId: 'pine-1', m: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 25, 5, 25, 1]) }],
};
const proxyTags = (id: string): readonly string[] => (id === 'pine-1' ? ['tree'] : []);

let scene: QueryScene;
let rapier: { world: PhysicsWorld; query: RapierQueryWorld };
let layer: VisualProxyLayer | null = null;
const warnings: string[] = [];

beforeAll(() => {
  scene = arenaScene();
  rapier = arenaRapier(() => layer);
});
afterAll(() => rapier.world.free());
afterEach(() => {
  bindPhysicsQueries(null);
  layer = null;
  scene.setVisualProxies(null);
  warnings.length = 0;
});

function ask(backend: 'oracle' | 'rapier', c: Case): unknown {
  bindPhysicsQueries({ world: (p) => (p !== 'arena' ? null : backend === 'oracle' ? scene : rapier.query), warn: (m) => warnings.push(m) });
  return raycast(ctx, c[1], c[2], c[3]);
}

function sameHit(a: RaycastHit, b: RaycastHit, name: string): void {
  expect(a.id, name).toBe(b.id);
  expect(a.body, name).toBe(b.body);
  expect([...a.tags].sort(), name).toEqual([...b.tags].sort());
  expect(Math.abs(a.distance - b.distance), `${name}: distance ${a.distance} vs ${b.distance}`).toBeLessThan(1e-3);
  for (const k of ['x', 'y', 'z'] as const) {
    expect(Math.abs(a.normal[k] - b.normal[k]), `${name}: normal.${k} ${a.normal[k]} vs ${b.normal[k]}`).toBeLessThan(1e-3);
    expect(Math.abs(a.position[k] - b.position[k]), `${name}: position.${k} ${a.position[k]} vs ${b.position[k]}`).toBeLessThan(1e-3);
  }
}

/** the Rapier answer equals the oracle's: null, one hit, a list or a verdict */
function agree(c: Case): unknown {
  const want = ask('oracle', c), got = ask('rapier', c);
  const name = c[0];
  const one = (w: unknown, g: unknown): void => {
    if (w === null) { expect(g, name).toBeNull(); return; }
    expect(g, name).not.toBeNull();
    sameHit(g as RaycastHit, w as RaycastHit, name);
  };
  const many = (w: RaycastHit[], g: RaycastHit[]): void => {
    expect(g.map((h) => h.id), name).toEqual(w.map((h) => h.id));
    w.forEach((h, i) => sameHit(g[i]!, h, `${name} [${i}]`));
  };
  if (Array.isArray(want)) {
    expect(Array.isArray(got), name).toBe(true);
    many(want as RaycastHit[], got as RaycastHit[]);
  } else if (want !== null && typeof want === 'object' && 'verdict' in want) {
    const w = want as { hit: RaycastHit | null; hits: RaycastHit[]; verdict: unknown };
    const g = got as typeof w;
    expect(g.verdict, name).toEqual(w.verdict);
    one(w.hit, g.hit);
    many(w.hits, g.hits);
  } else one(want, got);
  return got;
}

const TABLE: Case[] = [
  // hit shape and defaults
  ['nearest hit, caller ignored', eye, fwd],
  ['a number is the distance: short', eye, fwd, 2],
  ['a number is the distance: reaching', eye, fwd, 3],
  ['unnormalised direction', eye, { x: 0, y: 0, z: -5 }],
  ['zero direction', eye, { x: 0, y: 0, z: 0 }],
  ['default distance reaches 150 m', eye, { x: 1, y: 0, z: 0 }],
  ['default distance stops before 250 m', { x: 0, y: 1, z: 15 }, { x: -1, y: 0, z: 0 }],
  ['distance 300 reaches 250 m', { x: 0, y: 1, z: 15 }, { x: -1, y: 0, z: 0 }, { distance: 300 }],
  ['distance just short', eye, fwd, { distance: 2.6 }],
  ['distance just reaching', eye, fwd, { distance: 2.7 }],
  ['two-sided floor from below', { x: 0, y: -1, z: 5 }, { x: 0, y: 1, z: 0 }],
  ['floor from above', { x: 0, y: 3, z: 5 }, down],
  ['terrain id', { x: 40, y: 5, z: 0 }, down],
  ['anonymous geometry', { x: -12, y: 1, z: 0 }, { x: -1, y: 0, z: 0 }],
  ['oblique onto the crate', { x: 2, y: 2.5, z: -2 }, { x: -0.5, y: -0.45, z: -0.74 }],
  // bodies truth table
  ["bodies 'static' multiple", eye, fwd, { multiple: true, ignoreSelf: false, bodies: 'static' }],
  ["bodies 'static' from behind the crate", { x: 0, y: 1, z: -7.5 }, fwd, { bodies: 'static' }],
  ["bodies 'all' from behind the crate", { x: 0, y: 1, z: -7.5 }, fwd, { bodies: 'all' }],
  ["bodies 'dynamic' multiple", eye, fwd, { multiple: true, ignoreSelf: false, bodies: 'dynamic' }],
  ["bodies 'dynamic' single", eye, fwd, { bodies: 'dynamic' }],
  // entity and tag filters
  ['ignoreSelf true', eye, fwd, { ignoreSelf: true }],
  ['ignoreEntities one id', eye, fwd, { ignoreEntities: ['enemy-1'] }],
  ['ignoreEntities a mere prefix', eye, fwd, { ignoreEntities: ['enemy'] }],
  ['ignoreEntities the caller and its children', eye, fwd, { ignoreSelf: false, ignoreEntities: ['player-1'] }],
  ['excludeTags one', eye, fwd, { excludeTags: ['enemy'] }],
  ['excludeTags two', eye, fwd, { excludeTags: ['enemy', 'prop'] }],
  ['tags door', eye, fwd, { tags: ['door'] }],
  ['tags wall', eye, fwd, { tags: ['wall'] }],
  ['tags both of two', eye, fwd, { tags: ['wall', 'door'] }],
  ['tags nobody carries', eye, fwd, { tags: ['no-such-tag'] }],
  ['excludeTags nobody carries', eye, fwd, { excludeTags: ['no-such-tag'] }],
  ['physicsOnly true', eye, fwd, { physicsOnly: true }],
  ['physicsOnly false', eye, fwd, { physicsOnly: false }],
  // multiple
  ['multiple', eye, fwd, { multiple: true }],
  ['multiple with excludeTags and a distance', eye, fwd, { multiple: true, excludeTags: ['enemy', 'gib'], distance: 9 }],
  ['multiple with ignoreEntities, static', eye, fwd, { multiple: true, ignoreEntities: ['crate', 'door-1'], bodies: 'static' }],
  ['multiple, nothing there', eye, { x: 0, y: 1, z: 0 }, { multiple: true }],
  // radius
  ['sphere cast onto a face', { x: -12, y: 1, z: 0 }, { x: -1, y: 0, z: 0 }, { radius: 0.5 }],
  ['sphere cast against a corner (a vertical box edge)', { x: -12, y: 1, z: 1.3 }, { x: -1, y: 0, z: 0 }, { radius: 0.5 }],
  ['sphere cast onto a capsule', eye, fwd, { radius: 0.25 }],
  ['sphere cast, static', eye, fwd, { radius: 0.25, bodies: 'static' }],
  ['sphere in contact, moving away', { x: -13.8, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, { radius: 0.5, distance: 3 }],
  ['sphere cast onto the floor', { x: 5, y: 3, z: 5 }, down, { radius: 0.3 }],
  ['sphere cast, multiple', eye, fwd, { radius: 0.25, multiple: true }],
  // place, verdict, ignored options
  ['a place that is not resident', { x: 0, y: 5, z: 0 }, down, { place: 'nowhere' }],
  ['verdict', eye, fwd, { verdict: true }],
  ['verdict on terrain', { x: 40, y: 5, z: 0 }, down, { verdict: true }],
  ['verdict, multiple', eye, fwd, { verdict: true, multiple: true }],
  ['verdict, nothing', eye, { x: 0, y: 1, z: 0 }, { verdict: true }],
  ['through and shape are ignored', eye, fwd, { through: true, shape: 'box' }],
];

describe('raycast on the Rapier backend equals the QueryScene oracle (motion §6.4)', () => {
  it.each(TABLE)('%s', (...c) => {
    agree(c as Case);
  });

  it('the table is not vacuous: the oracle answers hits, lists and nulls in it', () => {
    const answers = TABLE.map((c) => ask('oracle', c));
    expect(answers.filter((a) => a === null).length).toBeGreaterThan(5);
    expect(answers.filter((a) => Array.isArray(a) && a.length > 2).length).toBeGreaterThan(3);
    expect(answers.filter((a) => a !== null && !Array.isArray(a) && 'id' in (a as object)).length).toBeGreaterThan(20);
  });

  it("bodies 'all': the same colliders in the same order (static + kinematic + dynamic + characters; never sensors or spectating bodies)", () => {
    const c: Case = ['all', eye, fwd, { multiple: true, ignoreSelf: false }];
    const want = ask('oracle', c) as RaycastHit[], got = ask('rapier', c) as RaycastHit[];
    expect(got.map((h) => h.id)).toEqual(['player-1', 'player-1/gear', 'enemy-1', 'crate', 'gib-1', 'door-1', 'terminal-1', 'wall-n']);
    expect(got.map((h) => h.id)).toEqual(want.map((h) => h.id));
    expect(got.map((h) => h.body)).toEqual(want.map((h) => h.body));
    // known difference 1: the caller's own capsule, cast from inside
    expect(want[0]!.distance).toBeCloseTo(0.35, 6);
    expect(got[0]!.distance).toBe(0);
    for (let i = 1; i < want.length; i++) sameHit(got[i]!, want[i]!, `all [${i}]`);
  });

  it('known difference 1: a ray starting inside a capsule or a small box answers distance 0 on it (solid: true)', () => {
    const self: Case = ['self', eye, fwd, { ignoreSelf: false }];
    expect((ask('oracle', self) as RaycastHit).distance).toBeCloseTo(0.35, 6);
    const got = ask('rapier', self) as RaycastHit;
    expect(got.id).toBe('player-1');
    expect(got.distance).toBe(0);
    expect(got.position).toEqual(eye);
    // the normal of a zero-length hit faces the ray
    expect(got.normal.z).toBeCloseTo(1, 6);
    const crate: Case = ['crate', { x: 0, y: 0.6, z: -5 }, fwd, { bodies: 'static' }];
    expect((ask('oracle', crate) as RaycastHit).distance).toBeCloseTo(0.6, 5);
    expect((ask('rapier', crate) as RaycastHit).distance).toBe(0);
    expect((ask('rapier', crate) as RaycastHit).id).toBe('crate');
  });

  it('known difference 2: a box over 1.5 m half extent is a trimesh shell, so from inside it the far wall answers, as in the oracle', () => {
    rapier.world.colliders.addInstance({ rowId: 'hall', ...centred('hall', [3, 2, 3], [60, 2, 60]) });
    rapier.world.refresh();
    bindPhysicsQueries({ world: () => rapier.query, warn: () => undefined });
    const h = raycast(ctx, { x: 60, y: 2, z: 60 }, { x: 1, y: 0, z: 0 }) as RaycastHit;
    expect(h.id).toBe('hall');
    expect(h.distance).toBeCloseTo(3, 4);
    expect(h.normal.x).toBeCloseTo(-1, 4);
    rapier.world.colliders.removeRow('hall');
    rapier.world.refresh();
  });

  it('QueryFilterFlags carry the values the port relies on (the 0.21 doc comments of two of them are swapped)', () => {
    const F = rapier.world.R.QueryFilterFlags;
    expect([F.EXCLUDE_FIXED, F.EXCLUDE_KINEMATIC, F.EXCLUDE_DYNAMIC, F.EXCLUDE_SENSORS, F.ONLY_DYNAMIC, F.ONLY_FIXED]).toEqual([1, 2, 4, 8, 3, 6]);
  });
});

describe("hits:'both' (X-42): colliders plus the visual-proxy layer, merged by distance", () => {
  const useProxies = (): void => {
    layer = new VisualProxyLayer(PROXIES, proxyTags);
    scene.setVisualProxies(new VisualProxyLayer(PROXIES, proxyTags));
  };

  it('answers colliders-only and logs once while no proxy layer exists', () => {
    const c: Case = ['both, no layer', top, down, { distance: 600, hits: 'both' }];
    expect(ask('rapier', c)).toBeNull();
    expect(raycast(ctx, top, down, { distance: 600, hits: 'both' })).toBeNull();
    expect(warnings.filter((w) => w.includes("hits:'both'")).length).toBe(1);
  });

  it("hits:'both' sees a render-only box that `hits` omitted misses", () => {
    useProxies();
    expect(layer!.built).toBe(false);
    expect(agree(['hits omitted', top, down, { distance: 600 }])).toBeNull();
    // built lazily, by the first query that asks for it
    expect(layer!.built).toBe(false);
    const h = agree(['both', top, down, { distance: 600, hits: 'both', excludeTags: ['enemy'] }]) as RaycastHit;
    expect(layer!.built).toBe(true);
    expect(h.id).toBe('pine-1');
    expect(h.distance).toBeCloseTo(394, 6);
    expect(h.body).toBe('static');
    expect(h.tags).toEqual(['tree']);
    expect(agree(['both, proxy tag excluded', top, down, { distance: 600, hits: 'both', excludeTags: ['tree'] }])).toBeNull();
    expect(agree(['both, proxy id ignored', top, down, { distance: 600, hits: 'both', ignoreEntities: ['pine-1'] }])).toBeNull();
    expect((agree(['both, sphere cast', top, down, { distance: 600, hits: 'both', radius: 0.3 }]) as RaycastHit).distance).toBeCloseTo(393.7, 6);
    expect(agree(["both, bodies 'dynamic' asks for no proxies", top, down, { distance: 600, hits: 'both', bodies: 'dynamic' }])).toBeNull();
  });

  it('the nearer of the Rapier hit and the proxy hit wins; `multiple` lists both, sorted', () => {
    // a second crown above the crate: the proxy is nearer from above, the collider from below the crown
    layer = new VisualProxyLayer({
      keys: PROXIES.keys,
      instances: [...PROXIES.instances, { key: 'pine|{}|0', rowId: 'pine-2', m: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 6, -5, 1]) }],
    }, () => ['tree']);
    scene.setVisualProxies(layer);
    const above: V = { x: 0, y: 20, z: -5 };
    expect((agree(['from above', above, down, { hits: 'both' }]) as RaycastHit).id).toBe('pine-2');
    expect((agree(['from above, colliders only', above, down]) as RaycastHit).id).toBe('crate');
    expect((agree(['from between', { x: 0, y: 3, z: -5 }, down, { hits: 'both' }]) as RaycastHit).id).toBe('crate');
    const all = agree(['multiple', above, down, { hits: 'both', multiple: true }]) as RaycastHit[];
    expect(all.map((h) => h.id)).toEqual(['pine-2', 'crate', 'floor']);
    expect(all.map((h) => +h.distance.toFixed(3))).toEqual([13, 18.8, 20]);
  });

  it('the layer drops instances of unknown or empty keys and answers nothing for an empty soup', () => {
    const l = new VisualProxyLayer({
      keys: [{ key: 'empty', tris: new Float32Array(0) }, ...PROXIES.keys],
      instances: [
        { key: 'empty', rowId: 'a', m: PROXIES.instances[0]!.m },
        { key: 'nowhere', rowId: 'b', m: PROXIES.instances[0]!.m },
        ...PROXIES.instances,
      ],
    });
    expect(l.size).toBe(3);
    const out: never[] = [];
    expect(l.candidates(v3(-1e3, -1e3, -1e3), v3(1e3, 1e3, 1e3), out)).toBe(1);
    expect(l.size).toBe(1);
    expect(l.skipped).toBe(2);
    expect(l.candidates(v3(100, 100, 100), v3(101, 101, 101), out)).toBe(0);
    expect(new VisualProxyLayer({ keys: [], instances: [] }).candidates(v3(-1, -1, -1), v3(1, 1, 1), out)).toBe(0);
  });

  it('the instance tree finds the same bodies as a brute-force scan (2,000 crowns, 300 boxes)', () => {
    let seed = 7;
    const r = (): number => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296);
    const instances: VisualProxySoup['instances'][number][] = [];
    for (let i = 0; i < 2000; i++) {
      const s = 0.5 + r() * 2;
      instances.push({ key: 'pine|{}|0', rowId: `pine-${i}`, m: new Float32Array([s, 0, 0, 0, 0, s, 0, 0, 0, 0, s, 0, (r() - 0.5) * 400, r() * 20, (r() - 0.5) * 400, 1]) });
    }
    const l = new VisualProxyLayer({ keys: PROXIES.keys, instances });
    const out: Array<{ rowId: string | null }> = [];
    for (let k = 0; k < 300; k++) {
      const cx = (r() - 0.5) * 400, cy = r() * 20, cz = (r() - 0.5) * 400, e = r() * 30;
      const min = v3(cx - e, cy - e, cz - e), max = v3(cx + e, cy + e, cz + e);
      l.candidates(min, max, out as never[]);
      const want = instances.filter((inst) => {
        const s = inst.m[0]!;
        return inst.m[12]! - s <= max[0]! && inst.m[12]! + s >= min[0]! && inst.m[13]! - s <= max[1]! && inst.m[13]! + s >= min[1]! && inst.m[14]! - s <= max[2]! && inst.m[14]! + s >= min[2]!;
      }).map((inst) => inst.rowId).sort();
      expect(out.map((b) => b.rowId).sort()).toEqual(want);
    }
  });
});
