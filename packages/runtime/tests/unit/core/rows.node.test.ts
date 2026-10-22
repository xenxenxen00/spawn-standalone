// The row store (docs/design/core-runtime.md §3.2, §5.1, §5.4): records and their indexes (id, place, tag, VM, children,
// spawner edges), deterministic serial order, the 16 m spatial grid over feet xz, the physics writeback and the per-tick roll of
// the previous transforms used by render interpolation.
import { describe, expect, it, vi } from 'vitest';
import { createRowRec, RowStoreImpl } from '../../../src/compat/core/store/rows.ts';
import { SpatialGridImpl } from '../../../src/compat/core/store/spatial.ts';
import { eulerYXZToQuat } from '../../../src/compat/core/store/transform.ts';
import type { RowRec } from '../../../src/compat/core/types.ts';
import { storeFixture } from './store-fixture.ts';

// Counts localPose constructions through the real implementation (hoisted above the imports by vitest): the per-writeback
// bucket walk must not build an intermediate pose for a childless top-level row. Delegating keeps behavior identical,
// so every other test in this file is unaffected.
vi.mock('../../../src/compat/core/store/transform.ts', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../../src/compat/core/store/transform.ts')>();
  const calls = { count: 0 };
  (globalThis as Record<string, unknown>).__ssLocalPoseCalls = calls;
  return {
    ...mod,
    localPose: (row: RowRec) => {
      calls.count++;
      return mod.localPose(row);
    },
  };
});

const localPoseCalls = (): { count: number } =>
  (globalThis as Record<string, unknown>).__ssLocalPoseCalls as { count: number };

const ids = (rows: Iterable<RowRec>): string[] => [...rows].map((r) => r.id);

describe('records', () => {
  it('createRowRec fills the defaults of a fresh alive row', () => {
    const rec = createRowRec({ id: 'crate', serial: 7, vm: 'platform', place: 'gallow-farm' });
    expect(rec).toMatchObject({
      id: 'crate',
      serial: 7,
      vm: 'platform',
      place: 'gallow-farm',
      explicitPlace: false,
      parentId: null,
      spawnerId: null,
      name: null,
      tags: [],
      template: null,
      state: {},
      props: {},
      behaviors: [],
      audience: 'near',
      scope: 'world',
      visibility: null,
      simulatedBy: null,
      lifetimeS: null,
      expiresAtTick: null,
      phase: 'alive',
      pendingSpawnHooks: true,
      player: null,
      spectating: false,
      rig: null,
      fromScene: null,
      stateVer: 0,
      propVer: 0,
      handles: {},
    });
    expect(rec.tf.pos).toEqual({ x: 0, y: 0, z: 0 });
    expect(rec.tf.rot).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    expect(rec.tf.scale).toEqual({ x: 1, y: 1, z: 1 });
    expect(rec.tf.prevPos).toBe(rec.tf.pos);
    expect(Object.isFrozen(rec.tags)).toBe(true);
    expect(createRowRec({ id: 'a/b', serial: 8, vm: 'client', place: null, parentId: 'a' }).name).toBe('b');
  });

  it('serials are allocated monotonically', () => {
    const store = new RowStoreImpl();
    const a = store.allocSerial();
    const b = store.allocSerial();
    expect(b).toBeGreaterThan(a);
  });

  it('insert indexes a row; a second alive row with the same id is refused', () => {
    const f = storeFixture();
    const row = f.add({ id: 'crate' });
    expect(f.store.get('crate')).toBe(row);
    expect(f.store.has('crate')).toBe(true);
    expect(f.store.count).toBe(1);
    expect(() => f.add({ id: 'crate' })).toThrow(/duplicate id crate/);
    expect(f.store.count).toBe(1);
  });

  it('detach removes a row from every index, marks it dead and frees its id', () => {
    const f = storeFixture();
    const spawner = f.add({ id: 'boss', tags: ['boss'] });
    const part = f.add({ id: 'boss-part-1', tags: ['boss-part'], spawnerId: 'boss' });
    const child = f.add({ id: 'boss/core', parentId: 'boss', tags: ['boss-part'] });
    expect(f.store.ownedBy('boss')).toEqual(new Set(['boss-part-1']));
    expect(f.store.detach('boss-part-1')).toBe(part);
    expect(part.phase).toBe('dead');
    expect(f.store.get('boss-part-1')).toBe(undefined);
    expect(f.store.ownedBy('boss')).toEqual(new Set());
    expect(ids(f.store.byTag('gallow-farm', 'boss-part'))).toEqual(['boss/core']);
    f.store.detach('boss/core');
    expect(f.store.childrenOf('boss')).toEqual([]);
    f.store.detach('boss');
    expect(spawner.phase).toBe('dead');
    expect(f.store.count).toBe(0);
    expect(ids(f.store.byPlace('gallow-farm'))).toEqual([]);
    expect(ids(f.store.inVm('platform'))).toEqual([]);
    expect(f.store.spatial('gallow-farm').near({ x: 0, y: 0, z: 0 }, 100)).toEqual([]);
    expect(f.store.detach('boss')).toBe(undefined);
    // the id is free and the new row starts with no children and no owned rows
    f.add({ id: 'boss' });
    expect(f.store.childrenOf('boss')).toEqual([]);
    expect(f.store.ownedBy('boss').size).toBe(0);
    expect(child.phase).toBe('dead');
  });
});

describe('indexes iterate in spawn serial order', () => {
  it('byPlace, byTag, inVm and childrenOf', () => {
    const f = storeFixture();
    f.add({ id: 'player/local', vm: 'client', tags: ['player'] });
    f.add({ id: 'bot-1', tags: ['bot', 'teammate'] });
    f.add({ id: 'hollow-1', tags: ['enemy'], place: 'cradle-biolabs' });
    f.add({ id: 'bot-2', tags: ['bot', 'teammate'] });
    f.add({ id: 'bot-2/gun', parentId: 'bot-2', tags: ['held'] });
    f.add({ id: 'bot-2/arm', parentId: 'bot-2' });
    expect(ids(f.store.byPlace('gallow-farm'))).toEqual(['player/local', 'bot-1', 'bot-2', 'bot-2/gun', 'bot-2/arm']);
    expect(ids(f.store.byPlace('cradle-biolabs'))).toEqual(['hollow-1']);
    expect(ids(f.store.byPlace('nowhere'))).toEqual([]);
    expect(ids(f.store.byTag('gallow-farm', 'teammate'))).toEqual(['bot-1', 'bot-2']);
    expect(ids(f.store.byTag('cradle-biolabs', 'teammate'))).toEqual([]);
    expect(ids(f.store.inVm('client'))).toEqual(['player/local']);
    expect(ids(f.store.inVm('platform'))).toEqual(['bot-1', 'hollow-1', 'bot-2', 'bot-2/gun', 'bot-2/arm']);
    expect(ids(f.store.childrenOf('bot-2'))).toEqual(['bot-2/gun', 'bot-2/arm']);
  });

  it('movePlace keeps serial order in the new place and moves the subtree (children share their parent’s place)', () => {
    const f = storeFixture();
    const body = f.add({ id: 'player/local', vm: 'client', place: 'training' });
    f.add({ id: 'player/local/torch', vm: 'client', parentId: 'player/local', place: 'training', tags: ['torch'] });
    f.add({ id: 'gf-door-1', tags: ['door'] });
    f.add({ id: 'gf-door-2', tags: ['door', 'torch'] });
    f.store.movePlace(body, 'gallow-farm');
    expect(ids(f.store.byPlace('gallow-farm'))).toEqual(['player/local', 'player/local/torch', 'gf-door-1', 'gf-door-2']);
    expect(ids(f.store.byTag('gallow-farm', 'torch'))).toEqual(['player/local/torch', 'gf-door-2']);
    expect(ids(f.store.byPlace('training'))).toEqual([]);
    expect(f.store.get('player/local/torch')!.place).toBe('gallow-farm');
    expect(f.store.spatial('gallow-farm').near({ x: 0, y: 0, z: 0 }, 1).map((r) => r.id)).toContain('player/local');
    expect(f.store.spatial('training').near({ x: 0, y: 0, z: 0 }, 1)).toEqual([]);
  });

  it('an iteration in flight is not disturbed by the lazy re-sort or by detaching while walking children', () => {
    const f = storeFixture();
    const body = f.add({ id: 'player/local', vm: 'client', place: 'training' });
    f.add({ id: 'gf-door-1' });
    f.add({ id: 'gf-door-2' });
    const seen: string[] = [];
    let crossed = false;
    for (const r of f.store.byPlace('gallow-farm')) {
      seen.push(r.id);
      if (crossed) continue;
      crossed = true;
      // the body crosses in mid-loop (out of serial order), then a query inside the loop asks for the same set
      f.store.movePlace(body, 'gallow-farm');
      f.store.byPlace('gallow-farm');
    }
    expect(seen.length).toBe(new Set(seen).size);
    expect(ids(f.store.byPlace('gallow-farm'))).toEqual(['player/local', 'gf-door-1', 'gf-door-2']);
    // a cascade that detaches children while walking childrenOf() visits every child
    const boss = f.add({ id: 'boss' });
    for (const k of ['a', 'b', 'c', 'd']) f.add({ id: `boss/${k}`, parentId: 'boss' });
    const detached: string[] = [];
    for (const child of f.store.childrenOf(boss.id)) detached.push(f.store.detach(child.id)!.id);
    expect(detached).toEqual(['boss/a', 'boss/b', 'boss/c', 'boss/d']);
    expect(f.store.childrenOf('boss')).toEqual([]);
  });

  it('rows() lists every alive row', () => {
    const f = storeFixture();
    f.add({ id: 'a' });
    f.add({ id: 'b', place: null });
    expect(ids(f.store.rows())).toEqual(['a', 'b']);
  });
});

describe('the spatial grid (16 m cells over feet xz)', () => {
  it('returns the rows of every cell the disc touches, in serial order; the caller applies the exact test', () => {
    const grid = new SpatialGridImpl(16);
    const rows = [0, 1, 2, 3].map((i) => createRowRec({ id: `r${i}`, serial: 10 - i, vm: 'platform', place: 'p' }));
    grid.set(rows[0]!, 1, 1);
    grid.set(rows[1]!, 15, 1);
    grid.set(rows[2]!, 17, 1);
    grid.set(rows[3]!, -40, -40);
    expect(grid.near({ x: 0, y: 0, z: 0 }, 2).map((r) => r.id)).toEqual(['r1', 'r0']);
    expect(grid.near({ x: 15.5, y: 0, z: 1 }, 1).map((r) => r.id)).toEqual(['r2', 'r1', 'r0']);
    expect(grid.near({ x: 0, y: 0, z: 0 }, 1000).length).toBe(4);
    expect(grid.near({ x: 0, y: 0, z: 0 }, -1)).toEqual([]);
    expect(grid.near({ x: Number.NaN, y: 0, z: 0 }, 5)).toEqual([]);
    expect(grid.cellSize).toBe(16);
    grid.set(rows[3]!, 2, 2);
    expect(grid.near({ x: 0, y: 0, z: 0 }, 2).map((r) => r.id)).toEqual(['r3', 'r1', 'r0']);
    grid.remove(rows[3]!);
    expect(grid.size).toBe(3);
  });

  it('a script move, an engine writeback and a parent move re-bucket the row and its subtree', () => {
    const f = storeFixture();
    const enemy = f.add({ id: 'hollow-1', transform: { pos: { x: 0, y: 0, z: 0 } } });
    f.add({ id: 'hollow-1/bp-Head', parentId: 'hollow-1', props: { attachment: { bone: 'Head' } }, transform: { pos: { x: 0, y: 1.7, z: 0 } } });
    const grid = f.store.spatial('gallow-farm');
    expect(grid.near({ x: 100, y: 0, z: 100 }, 5)).toEqual([]);
    f.store.engineWriteTransform(enemy, { x: 100, y: 0, z: 100 }, { x: 0, y: 0, z: 0 }, true);
    expect(ids(grid.near({ x: 100, y: 0, z: 100 }, 5))).toEqual(['hollow-1', 'hollow-1/bp-Head']);
    expect(grid.near({ x: 0, y: 0, z: 0 }, 5)).toEqual([]);
    const h = f.store.handle(enemy, 'platform') as Record<string, unknown>;
    h.feetPosition = { x: -50, y: 0, z: 20 };
    expect(ids(grid.near({ x: -50, y: 0, z: 20 }, 5))).toEqual(['hollow-1', 'hollow-1/bp-Head']);
  });

  it('a physics writeback builds no intermediate pose for a childless top-level row', () => {
    const f = storeFixture();
    const rows: RowRec[] = [];
    for (let i = 0; i < 25; i++) rows.push(f.add({ id: `wb-${i}` }));
    f.store.beginTick();
    localPoseCalls().count = 0;
    for (const r of rows) f.store.engineWriteTransform(r, { x: 1, y: 0, z: 1 }, { x: 0, y: 0, z: 0 }, true);
    expect(localPoseCalls().count).toBe(0);
    // …but a parented row still composes its world feet through a pose
    f.add({ id: 'wb-parent', transform: { pos: { x: 10, y: 0, z: 0 } } });
    const kid = f.add({ id: 'wb-parent/kid', parentId: 'wb-parent', transform: { pos: { x: 5, y: 0, z: 0 } } });
    localPoseCalls().count = 0;
    f.store.engineWriteTransform(kid, { x: 5, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }, true);
    expect(localPoseCalls().count).toBeGreaterThan(0);
    expect(ids(f.store.spatial('gallow-farm').near({ x: 15, y: 0, z: 0 }, 1))).toContain('wb-parent/kid');
  });

  it('a place-less row is in no grid', () => {
    const f = storeFixture();
    f.add({ id: 'engine-row', place: null });
    expect(f.store.spatial('gallow-farm').near({ x: 0, y: 0, z: 0 }, 1000)).toEqual([]);
  });
});

describe('engine writeback and interpolation state (core §5.4)', () => {
  it('engineWriteTransform writes pos, vel, grounded (and rot, angVel) without a change record or a version bump', () => {
    const f = storeFixture();
    const row = f.add({ id: 'gib-1' });
    const pos = { x: 1, y: 2, z: 3 };
    f.store.runAs({ row: 'x', behavior: 'scripts/x.js' }, () => {
      f.store.engineWriteTransform(row, pos, { x: 0, y: -9, z: 0 }, false, eulerYXZToQuat(45, 0, 0), { x: 1, y: 0, z: 0 });
    });
    pos.x = 99;
    expect(row.tf.pos).toEqual({ x: 1, y: 2, z: 3 });
    expect(row.tf.vel).toEqual({ x: 0, y: -9, z: 0 });
    expect(row.tf.angVel).toEqual({ x: 1, y: 0, z: 0 });
    expect(f.store.handle(row, 'client').rotation.yaw).toBe(45);
    expect(row.propVer).toBe(0);
    expect(f.store.takeChanges()).toEqual([]);
    f.store.detach('gib-1');
    f.store.engineWriteTransform(row, { x: 5, y: 5, z: 5 }, { x: 0, y: 0, z: 0 }, true);
    expect(row.tf.pos).toEqual({ x: 1, y: 2, z: 3 });
  });

  it('beginTick rolls prev ← cur for the rows that moved, so a still row has prev = cur', () => {
    const f = storeFixture();
    const row = f.add({ id: 'hollow-2', transform: { pos: { x: 0, y: 0, z: 0 } } });
    const still = f.add({ id: 'crate', transform: { pos: { x: 5, y: 0, z: 5 } } });
    f.store.beginTick();
    f.store.engineWriteTransform(row, { x: 1, y: 0, z: 0 }, { x: 30, y: 0, z: 0 }, true);
    expect(row.tf.prevPos).toEqual({ x: 0, y: 0, z: 0 });
    expect(row.tf.pos).toEqual({ x: 1, y: 0, z: 0 });
    expect([...f.store.movedRows()]).toEqual([row]);
    f.store.beginTick();
    expect(row.tf.prevPos).toEqual({ x: 1, y: 0, z: 0 });
    f.store.engineWriteTransform(row, { x: 2, y: 0, z: 0 }, { x: 30, y: 0, z: 0 }, true);
    expect(row.tf.prevPos).toEqual({ x: 1, y: 0, z: 0 });
    f.store.beginTick();
    f.store.beginTick();
    expect(row.tf.prevPos).toEqual(row.tf.pos);
    expect(still.tf.prevPos).toEqual(still.tf.pos);
    // a script rotation write rolls the same way
    (f.store.handle(row, 'platform') as Record<string, unknown>).yaw = 90;
    expect(row.tf.prevRot).toEqual({ x: 0, y: 0, z: 0, w: 1 });
    f.store.beginTick();
    expect(row.tf.prevRot).toBe(row.tf.rot);
  });

  it('a row moved in the tick it was spawned has no previous pose to slide from', () => {
    const f = storeFixture();
    f.store.beginTick();
    const row = f.add({ id: 'gore-1', transform: { pos: { x: 0, y: 0, z: 0 } } });
    const h = f.store.handle(row, 'client') as Record<string, unknown>;
    h.feetPosition = { x: 1, y: 0.5, z: 1 };
    h.yaw = 30;
    expect(row.tf.prevPos).toBe(row.tf.pos);
    expect(row.tf.prevRot).toBe(row.tf.rot);
    f.store.beginTick();
    h.feetPosition = { x: 2, y: 0.5, z: 1 };
    expect(row.tf.prevPos).toEqual({ x: 1, y: 0.5, z: 1 });
  });

  it('switching between world and camera space does not interpolate across the two', () => {
    const f = storeFixture();
    const row = f.add({ id: 'vm-gun', vm: 'client', transform: { pos: { x: 5, y: 1, z: 5 } } });
    f.store.beginTick();
    const h = f.store.handle(row, 'client') as Record<string, unknown>;
    h.feetPosition = { attach: 'camera', x: 0.2, y: -0.6, depth: 0.9, fov: 55 };
    expect(row.tf.prevPos).toBe(row.tf.pos);
    f.store.beginTick();
    h.feetPosition = { attach: 'camera', x: 0.25, y: -0.6, depth: 0.9, fov: 55 };
    expect(row.tf.prevPos).toEqual({ x: 0.2, y: -0.6, z: -0.9 });
    f.store.beginTick();
    h.feetPosition = { x: 5, y: 1, z: 5 };
    expect(row.tf.prevPos).toBe(row.tf.pos);
  });
});

describe('the invoker', () => {
  it('runAs sets the invoker for the duration of the call, nests, and restores it after a throw', () => {
    const store = new RowStoreImpl();
    expect(store.invoker).toBe('engine');
    const outer = { sim: 'sim' } as const;
    const inner = { row: 'a', behavior: 'scripts/a.js' } as const;
    const got = store.runAs(outer, () => {
      expect(store.invoker).toBe(outer);
      store.runAs(inner, () => expect(store.invoker).toBe(inner));
      return 5;
    });
    expect(got).toBe(5);
    expect(() =>
      store.runAs(inner, () => {
        throw new Error('hook threw');
      }),
    ).toThrow('hook threw');
    expect(store.invoker).toBe('engine');
  });

  it('reads the writer from an invoker source (the kernel’s hook invoker) unless runAs overrides it', () => {
    const f = storeFixture();
    const stack: Array<{ row: string; behavior: string }> = [];
    f.store.setInvokerSource(() => stack[stack.length - 1] ?? 'engine');
    const row = f.add({ id: 'door-1' });
    const h = f.store.handle(row, 'platform') as Record<string, any>;
    stack.push({ row: 'door-1', behavior: 'scripts/map/door.js' });
    h.state.open = true;
    f.store.runAs({ sim: 'sim' }, () => {
      h.state.open = false;
    });
    stack.pop();
    h.state.open = true;
    f.store.setInvokerSource(null);
    h.state.open = false;
    expect(f.store.takeChanges().map((c) => c.invoker)).toEqual([{ row: 'door-1', behavior: 'scripts/map/door.js' }, { sim: 'sim' }, 'engine', 'engine']);
  });
});
