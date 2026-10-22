// rapier/query.ts asks the world's BroadPhase itself, with handles, instead of the public `World` methods, which wrap every
// call's predicate in a closure (`ColliderSet.castClosure`, called by the wasm once per candidate collider even when no
// predicate was given). The answers must be the ones the public methods give: the arena place (trimeshes, cuboids,
// characters, one of them spectating, dynamic balls with a `/` child row, a sensor, a kinematic door) is built twice, the
// twin's broad phase is handed exactly what a `World` method hands it (the closure of a `Collider` predicate, or of none), and
// thousands of random rays and sphere casts (single and `multiple`, every body filter, ignore ids, tags), ground probes and
// line-of-sight tests must answer the same floats in both. The direct path makes no closure at all.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { QueryHit, RayQuery } from '../../../src/compat/physics/query.ts';
import { rapier } from '../../../src/compat/physics/rapier/loader.ts';
import { rayQuery, type RapierQueryWorld } from '../../../src/compat/physics/rapier/query.ts';
import type { PhysicsWorld } from '../../../src/compat/physics/rapier/world.ts';
import { arenaRapier } from './arena-fixture.ts';

type Pred = ((handle: number) => boolean) | undefined;

/** the twin: every broad-phase query of this world gets the closure a `World` method would have made of its predicate */
function throughPublicPath(world: PhysicsWorld): void {
  const raw = world.raw, bp = raw.broadPhase as unknown as Record<string, (...a: unknown[]) => unknown>;
  const proto = Object.getPrototypeOf(bp) as Record<string, (...a: unknown[]) => unknown>;
  const closure = (p: Pred): unknown => raw.colliders.castClosure(p ? (c) => p(c.handle) : undefined);
  // the predicate's place in each method's arguments
  for (const [m, at] of [['castRay', 10], ['castRayAndGetNormal', 10], ['intersectionsWithRay', 11], ['castShape', 14]] as const) {
    bp[m] = function (this: unknown, ...a: unknown[]): unknown {
      a[at] = closure(a[at] as Pred);
      return proto[m]!.apply(this, a);
    };
  }
}

/** a small seeded generator (mulberry32) */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const IDS = ['player-1', 'enemy-1', 'crate', 'door-1', 'gib-1', 'player-1/gear', 'wall-n', 'floor', 'terminal-1', 'nobody'];
const TAGS = ['wall', 'prop', 'enemy', 'ground', 'gib', 'door', 'player'];

function pick<T>(r: () => number, from: readonly T[], p: number): T[] {
  return from.filter(() => r() < p);
}

function randomQuery(r: () => number): RayQuery {
  const o = { x: -12 + 24 * r(), y: 0.1 + 3.5 * r(), z: -12 + 24 * r() };
  const a = 2 * Math.PI * r(), down = -0.95 + 1.3 * r();
  const h = Math.sqrt(1 - down * down);
  const d = { x: Math.cos(a) * h, y: down, z: Math.sin(a) * h };
  const bodies = (['all', 'static', 'dynamic'] as const)[Math.floor(3 * r())]!;
  return rayQuery(o, d, 1 + 59 * r(), {
    radius: r() < 0.35 ? 0.05 + 0.55 * r() : 0, bodies, ignore: pick(r, IDS, 0.15), tags: r() < 0.2 ? pick(r, TAGS, 0.2) : [],
    excludeTags: r() < 0.2 ? pick(r, TAGS, 0.2) : [],
  });
}

function sameHit(a: QueryHit | null, b: QueryHit | null, what: string): void {
  if (a === null || b === null) { expect(a, what).toBe(b); return; }
  const fa = [a.distance, a.position.x, a.position.y, a.position.z, a.normal.x, a.normal.y, a.normal.z];
  const fb = [b.distance, b.position.x, b.position.y, b.position.z, b.normal.x, b.normal.y, b.normal.z];
  for (let i = 0; i < fa.length; i++) if (!Object.is(fa[i], fb[i])) expect.fail(`${what}: value ${i} ${fa[i]} directly, ${fb[i]} through the public path`);
  expect(a.id, what).toBe(b.id);
  expect(a.body, what).toBe(b.body);
  expect(a.tags, what).toEqual(b.tags);
}

let direct: { world: PhysicsWorld; query: RapierQueryWorld };
let twin: { world: PhysicsWorld; query: RapierQueryWorld };
beforeAll(() => {
  direct = arenaRapier();
  twin = arenaRapier();
  throughPublicPath(twin.world);
});
afterAll(() => { direct.world.free(); twin.world.free(); });

/** runs `f` counting the closures the ColliderSet makes for queries */
function closuresMadeBy(f: () => void): number {
  const cs = rapier().ColliderSet.prototype as unknown as { castClosure: (f?: unknown) => unknown };
  const castClosure = cs.castClosure;
  let n = 0;
  cs.castClosure = function (this: unknown, g?: unknown) { n++; return castClosure.call(this, g); };
  try { f(); } finally { cs.castClosure = castClosure; }
  return n;
}

describe('rapier/query.ts: the broad phase asked directly', () => {
  it('answers every ray and sphere cast, single and multiple, as the public World methods do', () => {
    const r = rng(7);
    let hits = 0, withPredicate = 0, many = 0;
    const q0: RapierQueryWorld = direct.query, q1: RapierQueryWorld = twin.query;
    for (let i = 0; i < 3000; i++) {
      const q = randomQuery(r);
      if (q.tags.length + q.excludeTags.length > 0 || q.ignore.length > 1) withPredicate++;
      let a: QueryHit | null = null;
      const made = closuresMadeBy(() => { a = q0.castRay(q); });
      expect(made, `query ${i}: closures on the direct path`).toBe(0);
      const b = q1.castRay(q);
      sameHit(a, b, `query ${i} (${JSON.stringify(q)})`);
      if (a) hits++;
      const all0 = q0.castRayAll(q), all1 = q1.castRayAll(q);
      expect(all0.length, `query ${i} multiple`).toBe(all1.length);
      all0.forEach((h, k) => sameHit(h, all1[k]!, `query ${i} multiple #${k}`));
      if (all0.length > 1) many++;
    }
    // the sample covers what it is for
    expect(hits).toBeGreaterThan(800);
    expect(withPredicate).toBeGreaterThan(300);
    expect(many).toBeGreaterThan(50);
  });

  it('answers ground probes and line-of-sight tests as the public World methods do, with no closure', () => {
    const r = rng(11);
    for (let i = 0; i < 1500; i++) {
      const x = -25 + 80 * r(), z = -25 + 50 * r();
      let g0: number | null = null;
      expect(closuresMadeBy(() => { g0 = direct.query.groundY(x, z); })).toBe(0);
      expect(g0).toBe(twin.query.groundY(x, z));
      const from = { x: -12 + 24 * r(), y: 0.2 + 3 * r(), z: -12 + 24 * r() }, to = { x: -12 + 24 * r(), y: 0.2 + 3 * r(), z: -12 + 24 * r() };
      let c0 = false;
      expect(closuresMadeBy(() => { c0 = direct.query.clearLine(from, to); })).toBe(0);
      expect(c0).toBe(twin.query.clearLine(from, to));
      const d0 = direct.query.castDown(from, 10), d1 = twin.query.castDown(from, 10);
      expect(d0 === null ? null : [d0.y, d0.normal.x, d0.normal.y, d0.normal.z]).toEqual(d1 === null ? null : [d1.y, d1.normal.x, d1.normal.y, d1.normal.z]);
    }
  });

  it('the twin really goes through the closures (the comparison above is not the direct path twice)', () => {
    const q = rayQuery({ x: 0, y: 1, z: 2 }, { x: 0, y: 0, z: -1 }, 30, { tags: ['prop'] });
    expect(closuresMadeBy(() => twin.query.castRay(q))).toBeGreaterThan(0);
    expect(closuresMadeBy(() => direct.query.castRay(q))).toBe(0);
    expect(direct.query.castRay(q)?.id).toBe('crate');
  });
});
