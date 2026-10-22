// kcc-memo.ts: a spun-out controller call answered again from its record must be EXACTLY the call Rapier would make. A body
// stands inside a two-sided trimesh wall (the grimland-park bot of kcc.ts header 8: every tick the same 20 spun-out
// iterations) while two others walk about, so the broad phase is refitted every step; the same scene runs in a twin world
// with the memo off, and every realised number of every body must be the same float, tick for tick. Then verify mode (the
// real call made on every hit as well, every output field compared), a kinematic door beside the body (no proof: refused),
// and the negative controls: whatever input changes, by as little as one ulp, the memo must not answer.
import type { Collider } from '@dimforge/rapier3d-simd-compat';
import { afterEach, describe, expect, it } from 'vitest';
import type { CharacterBody } from '../../../src/compat/physics/rapier/kcc.ts';
import { kccMemo } from '../../../src/compat/physics/rapier/kcc-memo.ts';
import { rapier } from '../../../src/compat/physics/rapier/loader.ts';
import type { PhysicsWorld } from '../../../src/compat/physics/rapier/world.ts';
import { FLOOR, GRAVITY, TICK, enemy, player, worldOf, type Part } from './rapier-fixtures.ts';

/** a vertical two-sided wall of two triangles in the plane x = x0, `half` wide along z, `h` high */
function wallSoup(x0: number, half: number, h: number): number[] {
  return [x0, 0, -half, x0, h, half, x0, h, -half, x0, 0, -half, x0, 0, half, x0, h, half];
}

const F = new Float32Array(1), I = new Int32Array(F.buffer);
/** the next f32 above `v` (v > 0) */
function nextUp32(v: number): number {
  F[0] = v;
  I[0] = I[0]! + 1;
  return F[0]!;
}

interface Scene { world: PhysicsWorld; stuck: CharacterBody; walkers: CharacterBody[]; wall: Collider; floor: Collider }

function scene(extra: Part[] = []): Scene {
  const world = worldOf([FLOOR, { row: 'wall', tris: wallSoup(0, 2, 3) }, ...extra]);
  // spawned on the wall plane: the capsule stands in the wall, nothing it asks gets it out
  const stuck = enemy(world, { x: 0, y: 0.02, z: 0 }, 'stuck');
  const walkers = [player(world, { x: 2.5, y: 0.05, z: 1.5 }, 'walker-1'), enemy(world, { x: -2.5, y: 0.05, z: -1.5 }, 'walker-2')];
  const ownerOf = (row: string): Collider => [...world.colliders.ownersOf(row)][0]!.collider;
  return { world, stuck, walkers, wall: ownerOf('wall'), floor: ownerOf('floor') };
}

/** the game's velocities for tick i: the stuck body presses on, gravity integrated as the live scripts do; the walkers circle */
function drive(s: Scene, i: number, push: number): void {
  const c = s.stuck;
  c.desiredVelocity.x = push; c.desiredVelocity.y = c.velocity.y + GRAVITY * TICK; c.desiredVelocity.z = 0;
  s.walkers.forEach((w, k) => {
    const a = (i + 20 * k) * 0.15;
    w.desiredVelocity.x = 3 * Math.cos(a); w.desiredVelocity.y = w.velocity.y + GRAVITY * TICK; w.desiredVelocity.z = 3 * Math.sin(a);
  });
}

function state(s: Scene): number[] {
  const out: number[] = [];
  for (const c of [s.stuck, ...s.walkers]) {
    out.push(c.feet.x, c.feet.y, c.feet.z, c.velocity.x, c.velocity.y, c.velocity.z, c.grounded ? 1 : 0, c.groundBody, c.hits,
      c.groundNormal.x, c.groundNormal.y, c.groundNormal.z);
  }
  return out;
}

/** one tick of the memo world (memo on) and of its twin (memo off); every realised number must be the same float */
function stepTwins(a: Scene, b: Scene, i: number, push: number, verify = false): void {
  kccMemo.enabled = true; kccMemo.verify = verify;
  drive(a, i, push);
  a.world.step(TICK);
  kccMemo.enabled = false; kccMemo.verify = false;
  drive(b, i, push);
  b.world.step(TICK);
  kccMemo.enabled = true;
  const x = state(a), y = state(b);
  for (let k = 0; k < x.length; k++) if (!Object.is(x[k], y[k])) expect.fail(`tick ${i}, value ${k}: ${x[k]} with the memo, ${y[k]} without`);
}

afterEach(() => {
  kccMemo.enabled = true;
  kccMemo.verify = false;
  kccMemo.resetStats();
});

describe('kcc-memo: a repeated spun-out controller call', () => {
  it('is answered from its record, with exactly what Rapier answers, while the broad phase changes around it', () => {
    kccMemo.resetStats();
    const a = scene(), b = scene();
    for (let i = 0; i < 120; i++) stepTwins(a, b, i, 0);
    const st = kccMemo.stats;
    // the scene does what it is for: the stuck body spins out every tick and the memo answers most of those calls, after the
    // order proof between the two small fixed colliders it touches (wall, floor) ran
    expect(st.records).toBeGreaterThan(0);
    expect(st.hits).toBeGreaterThan(80);
    expect(st.refused).toBe(0);
    expect(a.stuck.hits).toBeGreaterThanOrEqual(20);
    // the walkers really moved (the broad phase was refitted under the record every step)
    expect(Math.hypot(a.walkers[0]!.feet.x - 2.5, a.walkers[0]!.feet.z - 1.5)).toBeGreaterThan(0.5);
    a.world.free(); b.world.free();
  });

  it('a body that presses into the wall as well: fewer asks come back, the answers are still exact', () => {
    kccMemo.resetStats();
    const a = scene(), b = scene();
    for (let i = 0; i < 120; i++) stepTwins(a, b, i, 0.3);
    expect(kccMemo.stats.hits).toBeGreaterThan(5);
    a.world.free(); b.world.free();
  });

  it('verify mode: the real call made on every hit as well gives every output field to the bit', () => {
    kccMemo.resetStats();
    const a = scene(), b = scene();
    for (let i = 0; i < 90; i++) stepTwins(a, b, i, 0, true);
    expect(kccMemo.stats.verified).toBeGreaterThan(60);
    expect(kccMemo.stats.mismatches).toBe(0);
    expect(kccMemo.stats.firstMismatch).toBeNull();
    a.world.free(); b.world.free();
  });

  it('a kinematic body within reach: no proof (its stored box depends on its history), every call is made', () => {
    kccMemo.resetStats();
    const door: Part = { row: 'door', box: [0.05, 1, 0.5], at: [0.45, 1, 0], kinematic: true };
    const a = scene([door]), b = scene([door]);
    for (let i = 0; i < 40; i++) stepTwins(a, b, i, 0.3);
    expect(kccMemo.stats.hits).toBe(0);
    expect(kccMemo.stats.refusals['small body 2/1']).toBeGreaterThan(0);
    a.world.free(); b.world.free();
  });

  describe('negative controls: the memo answers until one input changes, and not after', () => {
    /** runs the twins until the memo answers, applies `change` to both, steps once more: no hit, `why` counted, same floats */
    function control(why: string, change: (s: Scene, i: number) => void): void {
      kccMemo.resetStats();
      const a = scene(), b = scene();
      let i = 0;
      for (; i < 30; i++) stepTwins(a, b, i, 0);
      const hits = kccMemo.stats.hits, misses = kccMemo.stats.misses[why] ?? 0;
      expect(hits).toBeGreaterThan(10);
      // the tick before the change was answered by the memo too
      stepTwins(a, b, i++, 0);
      expect(kccMemo.stats.hits).toBe(hits + 1);
      change(a, i); change(b, i);
      stepTwins(a, b, i++, 0);
      expect(kccMemo.stats.hits).toBe(hits + 1);
      expect(kccMemo.stats.misses[why] ?? 0).toBeGreaterThan(misses);
      a.world.free(); b.world.free();
    }

    it('a neighbouring fixed collider moved by one ulp', () => {
      control('colliders', (s) => {
        const t = s.wall.translation();
        s.wall.setTranslation({ x: t.x, y: nextUp32(t.y), z: t.z });
      });
    });

    it('the floor moved by one ulp', () => {
      control('colliders', (s) => {
        const t = s.floor.translation();
        s.floor.setTranslation({ x: nextUp32(t.x), y: t.y, z: t.z });
      });
    });

    it('the desired translation one f32 ulp longer', () => {
      kccMemo.resetStats();
      const a = scene(), b = scene();
      let i = 0;
      for (; i < 30; i++) stepTwins(a, b, i, 0);
      const hits = kccMemo.stats.hits, misses = kccMemo.stats.misses['desired'] ?? 0;
      expect(hits).toBeGreaterThan(10);
      // the stuck body's next ask with its downward part one f32 ulp longer than gravity alone (the memo compares the f32 the wasm gets)
      const ask = (s: Scene): void => {
        drive(s, i, 0);
        const d = Math.fround(s.stuck.desiredVelocity.y * TICK);
        const longer = -nextUp32(-d);
        s.stuck.desiredVelocity.y = longer / TICK;
        expect(Math.fround(s.stuck.desiredVelocity.y * TICK)).toBe(longer);
      };
      kccMemo.enabled = true; ask(a); a.world.step(TICK);
      kccMemo.enabled = false; ask(b); b.world.step(TICK);
      kccMemo.enabled = true;
      expect(kccMemo.stats.hits).toBe(hits);
      expect(kccMemo.stats.misses['desired'] ?? 0).toBeGreaterThan(misses);
      const x = state(a), y = state(b);
      for (let k = 0; k < x.length; k++) expect(Object.is(x[k], y[k])).toBe(true);
      a.world.free(); b.world.free();
    });

    it('a controller setting changed', () => {
      control('settings', (s) => {
        const ctl = s.stuck.controller;
        ctl.setNormalNudgeFactor(nextUp32(ctl.normalNudgeFactor()));
      });
    });

    it('the wall given a new (identical) shape object', () => {
      control('colliders', (s) => {
        const R = rapier();
        s.wall.setShape(new R.TriMesh(new Float32Array(wallSoup(0, 2, 3)), new Uint32Array([0, 1, 2, 3, 4, 5])));
      });
    });

    it('the wall regrouped (still meeting the body)', () => {
      control('colliders', (s) => { s.wall.setCollisionGroups(((0xfffe << 16) | 0xffff) >>> 0); });
    });

    it('the wall disabled (still a broad-phase leaf until the next step)', () => {
      control('colliders', (s) => { s.wall.setEnabled(false); });
    });

    it('a new collider within reach, published by a refresh', () => {
      control('colliders', (s) => {
        s.world.colliders.addPack({ place: 'test', keys: [{ id: 'post', box: [0.2, 2, 0.2] }], instances: [{ rowId: 'post', key: 0, m: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0.5, 0, 0.3]), mutable: false, kinematic: false, noDecal: false }], runtimeKeys: [] });
        s.world.refresh();
      });
    });
  });
});
