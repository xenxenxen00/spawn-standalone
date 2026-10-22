// Handles (docs/design/core-runtime.md §3.3, §5.3, §5.8, §7.4, §10.3, §16.1 `handles.test.ts`; contract §3.4-3.5): every field
// of the ObjectView table, snapshot reads, whole-state replace, nested writes, delete, the equal-write no-op, identity of nested
// proxies, dead-row handles, read-only UI handles, the per-VM cache, X-24 children, players, the camera rig and the change list.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LayeredValueImpl } from '../../../src/compat/core/store/layers.ts';
import { eulerYXZToQuat } from '../../../src/compat/core/store/transform.ts';
import type { BehaviorHookHealth, BehaviorInstance, ObjectView, PlayerView, RigView, RowRec } from '../../../src/compat/core/types.ts';
import { storeFixture } from './store-fixture.ts';

type Any = Record<string, any>;

afterEach(() => {
  vi.restoreAllMocks();
});

function behavior(path: string, health: BehaviorHookHealth[] = []): BehaviorInstance {
  return {
    path,
    module: null,
    pendingModule: false,
    ctx: null,
    ears: null,
    schedule: { everyTicks: 1, phase: 0, dtS: 1 / 30 },
    sleeping: null,
    health: new Map(health.map((h) => [h.hook, h])),
  };
}

describe('record fields: read from the record, writes ignored', () => {
  it('reads id, tags, template, name, audience, scope, visibility, retention, objectId, simulatedBy, lifetime, place', () => {
    const f = storeFixture();
    const row = f.add({
      id: 'hollow-3',
      tags: ['enemy', 'hollow', 'ss-match'],
      template: 'templates/enemies/hollow.js#hollow',
      audience: 'all',
      scope: 'world',
      simulatedBy: 'platform',
      lifetimeS: 30,
    });
    const h = f.store.handle(row, 'platform');
    expect(h.id).toBe('hollow-3');
    expect(h.tags).toEqual(['enemy', 'hollow', 'ss-match']);
    expect(Object.isFrozen(h.tags)).toBe(true);
    expect(h.template).toBe('templates/enemies/hollow.js#hollow');
    expect(h.name).toBe(null);
    expect(h.audience).toBe('all');
    expect(h.scope).toBe('world');
    expect(h.visibility).toBe(null);
    expect(h.retention).toBe('current');
    expect(h.objectId).toBe('world:#hollow-3');
    expect(h.simulatedBy).toBe('platform');
    expect(h.lifetime).toBe(30);
    expect(h.place).toBe('gallow-farm');
    expect(h.controller).toBe(null);
    expect(h.controlling).toBe(null);
    expect(h.userId).toBe(null);
    const plain = f.store.handle(f.add({ id: 'crate' }), 'platform');
    expect(plain.template).toBe(undefined);
    expect(plain.lifetime).toBe(undefined);
  });

  it('a child row is named by its local id segment unless the spec names it', () => {
    const f = storeFixture();
    f.add({ id: 'term-1' });
    expect(f.store.handle(f.add({ id: 'term-1/screen', parentId: 'term-1' }), 'platform').name).toBe('screen');
    expect(f.store.handle(f.add({ id: 'term-1/0', parentId: 'term-1', name: 'glass' }), 'platform').name).toBe('glass');
  });

  it('ignores writes to them without throwing in strict mode (game modules are strict)', () => {
    'use strict';
    const f = storeFixture({ dev: true });
    const row = f.add({ id: 'crate', tags: ['prop'] });
    const h = f.store.handle(row, 'platform') as Any;
    for (const [k, v] of [['id', 'x'], ['tags', []], ['place', 'other'], ['template', 't'], ['name', 'n'], ['lifetime', 3], ['objectId', 'o'], ['worldFeetPosition', { x: 1, y: 1, z: 1 }], ['grounded', true], ['bounds', null], ['children', []], ['behavior', []], ['effectiveScale', null], ['userId', 'u']] as const) {
      expect(() => (h[k] = v), k).not.toThrow();
    }
    expect(h.id).toBe('crate');
    expect(h.tags).toEqual(['prop']);
    expect(h.place).toBe('gallow-farm');
    expect(f.store.counters.ignoredWrites).toBe(14);
    expect(f.warnings.some((w) => w.includes('crate.place'))).toBe(true);
  });
});

describe('state: write-through proxy, copies, replace, delete, equal writes, identity', () => {
  it('nested writes land in the record and are read back at once', () => {
    const f = storeFixture();
    const row = f.add({ id: 'player/local', vm: 'client', state: { live: { hp: 100, inv: ['knife'] } } });
    const h = f.store.handle(row, 'client') as Any;
    h.state.live.hp = 80;
    h.state.live.inv.push('9mm');
    h.state.prog = { xp: 10 };
    h.state.prog.xp += 5;
    expect(row.state).toEqual({ live: { hp: 80, inv: ['knife', '9mm'] }, prog: { xp: 15 } });
    expect(h.state.live.inv.length).toBe(2);
    expect(JSON.parse(JSON.stringify(h.state))).toEqual(row.state);
  });

  it('a write stores a wire copy (JSON semantics): later mutation of the assigned object is not a write', () => {
    const f = storeFixture();
    const row = f.add({ id: 'p' });
    const h = f.store.handle(row, 'platform') as Any;
    const bag = { a: 1, f: () => 1, n: Number.NaN, d: new Date(0), u: undefined };
    h.state.bag = bag;
    bag.a = 2;
    expect(row.state.bag).toEqual({ a: 1, n: null, d: '1970-01-01T00:00:00.000Z' });
  });

  it('assigning state replaces it with a copy; `state = {}` wipes', () => {
    const f = storeFixture();
    const row = f.add({ id: 'p', state: { a: 1, b: { c: 2 } } });
    const h = f.store.handle(row, 'platform') as Any;
    const next = { x: [1, 2] };
    h.state = next;
    next.x.push(3);
    expect(row.state).toEqual({ x: [1, 2] });
    h.state = {};
    expect(row.state).toEqual({});
    h.state = null;
    expect(row.state).toEqual({});
  });

  it('delete clears a key; assigning undefined clears it too (JSON drops it)', () => {
    const f = storeFixture();
    const row = f.add({ id: 'p', state: { a: 1, b: { c: 2, d: 3 }, list: [1, 2] } });
    const h = f.store.handle(row, 'platform') as Any;
    delete h.state.a;
    delete h.state.b.c;
    h.state.b.d = undefined;
    h.state.list[0] = undefined;
    expect(row.state).toEqual({ b: {}, list: [null, 2] });
    expect('a' in h.state).toBe(false);
  });

  it('an equal write is free: no version bump, no change record', () => {
    const f = storeFixture();
    const row = f.add({ id: 'p', state: { hp: 3, pos: { x: 1 } } });
    const h = f.store.handle(row, 'platform') as Any;
    h.state.hp = 3;
    h.state.pos = { x: 1 };
    h.state = { hp: 3, pos: { x: 1 } };
    expect(row.stateVer).toBe(0);
    expect(f.store.takeChanges()).toEqual([]);
    h.state.hp = 4;
    expect(row.stateVer).toBe(1);
    // key order counts: a reordered object is a write (the store keeps the copy of the last assignment)
    h.state.pos = { x: 1 };
    h.state = { pos: { x: 1 }, hp: 4 };
    expect(row.stateVer).toBe(2);
  });

  it('nested proxies keep their identity per target', () => {
    const f = storeFixture();
    const row = f.add({ id: 'p', state: { live: { hp: 1 }, list: [{ a: 1 }] } });
    const h = f.store.handle(row, 'platform') as Any;
    expect(h.state).toBe(h.state);
    expect(h.state.live).toBe(h.state.live);
    expect(h.state.list[0]).toBe(h.state.list[0]);
    expect(h.state.list.indexOf(h.state.list[0])).toBe(0);
    h.state.live = { hp: 2 };
    expect(h.state.live.hp).toBe(2);
  });

  it('a stale nested reference to a replaced object writes nothing', () => {
    const f = storeFixture();
    const row = f.add({ id: 'p', state: { live: { hp: 1 } } });
    const h = f.store.handle(row, 'platform') as Any;
    const old = h.state.live;
    h.state.live = { hp: 5 };
    const before = row.stateVer;
    old.hp = 99;
    expect(row.state.live).toEqual({ hp: 5 });
    expect(row.stateVer).toBe(before);
    expect(f.store.counters.detachedWrites).toBe(1);
  });

  it('array methods through the proxy (push, splice, sort, filter) land in the record', () => {
    const f = storeFixture();
    const row = f.add({ id: 'p', state: { l: [3, 1, 2], o: [{ k: 'b' }, { k: 'a' }] } });
    const h = f.store.handle(row, 'platform') as Any;
    h.state.l.push(4);
    h.state.l.splice(0, 1);
    h.state.l.sort((x: number, y: number) => x - y);
    h.state.o.sort((x: Any, y: Any) => (x.k < y.k ? -1 : 1));
    h.state.o = h.state.o.filter((x: Any) => x.k === 'a');
    expect(row.state).toEqual({ l: [1, 2, 4], o: [{ k: 'a' }] });
  });

  it('array edits keep the state wire-clean: a write past the end and an element delete leave null, never a hole (JSON)', () => {
    const f = storeFixture();
    const row = f.add({ id: 'r9', state: { list: [1, 2] } });
    const h = f.store.handle(row, 'platform') as Record<string, any>;
    h.state.list[4] = 7;
    expect(row.state.list).toEqual([1, 2, null, null, 7]);
    expect(2 in (row.state.list as unknown[])).toBe(true);
    delete h.state.list[0];
    expect(row.state.list).toEqual([null, 2, null, null, 7]);
    expect(0 in (row.state.list as unknown[])).toBe(true);
    // array methods that delete while shifting still end with the right contents
    h.state.list.splice(1, 1);
    h.state.list.shift();
    expect(row.state.list).toEqual([null, null, 7]);
    h.state.list.unshift(9);
    expect(row.state.list).toEqual([9, null, null, 7]);
    expect(row.state).toEqual(JSON.parse(JSON.stringify(row.state)));
    for (let i = 0; i < (row.state.list as unknown[]).length; i++) expect(i in (row.state.list as unknown[])).toBe(true);
  });

  it('records each effective write in the change list with its path and invoker', () => {
    const f = storeFixture();
    const row = f.add({ id: 'player/local', vm: 'client', state: { prog: { xp: 1 } } });
    const h = f.store.handle(row, 'client') as Any;
    f.store.runAs({ row: 'player/local', behavior: 'scripts/player/state.js' }, () => {
      h.state.prog.xp = 2;
    });
    h.visible = false;
    const changes = f.store.takeChanges();
    expect(changes.map((c) => [c.row.id, c.field, c.path, c.invoker])).toEqual([
      ['player/local', 'state', ['prog', 'xp'], { row: 'player/local', behavior: 'scripts/player/state.js' }],
      ['player/local', 'visible', [], 'engine'],
    ]);
    expect(f.store.takeChanges()).toEqual([]);
  });

  it('observers hear every effective write synchronously', () => {
    const f = storeFixture();
    const row = f.add({ id: 'p' });
    const h = f.store.handle(row, 'platform') as Any;
    const seen: string[] = [];
    const off = f.store.observe((c) => seen.push(`${c.field}:${c.path.join('.')}`));
    h.state.a = 1;
    expect(seen).toEqual(['state:a']);
    off();
    h.state.a = 2;
    expect(seen).toEqual(['state:a']);
  });
});

describe('transforms: snapshot reads, whole writes, ports', () => {
  it('feetPosition reads a fresh snapshot; mutating it is not a write; assigning teleports through the physics port', () => {
    const f = storeFixture();
    const row = f.add({ id: 'player/local', vm: 'client', transform: { pos: { x: 1, y: 2, z: 3 } } });
    const h = f.store.handle(row, 'client') as Any;
    const p = h.feetPosition;
    expect(p).toEqual({ x: 1, y: 2, z: 3 });
    expect(h.feetPosition).not.toBe(p);
    p.y += 1.6;
    expect(h.feetPosition).toEqual({ x: 1, y: 2, z: 3 });
    h.feetPosition = { x: 4, y: 5, z: 6 };
    expect(row.tf.pos).toEqual({ x: 4, y: 5, z: 6 });
    expect(f.ports.physics.setPosition).toHaveBeenCalledWith(row, { x: 4, y: 5, z: 6 });
    h.feetPosition = { x: 4, y: 5, z: 6 };
    expect(f.ports.physics.setPosition).toHaveBeenCalledTimes(1);
  });

  it('a position without y stands on the ground the physics port reports', () => {
    const f = storeFixture();
    f.ports.physics.groundY = () => 1.25;
    const h = f.store.handle(f.add({ id: 'crate' }), 'platform') as Any;
    h.feetPosition = { x: 3, z: 4 };
    expect(h.feetPosition).toEqual({ x: 3, y: 1.25, z: 4 });
  });

  it('an invalid transform write is refused and counted', () => {
    const f = storeFixture();
    const row = f.add({ id: 'crate', transform: { pos: { x: 1, y: 1, z: 1 } } });
    const h = f.store.handle(row, 'platform') as Any;
    h.feetPosition = { x: Number.NaN, y: 0, z: 0 };
    h.velocity = { x: Number.POSITIVE_INFINITY, y: 0, z: 0 };
    h.rotation = 'north';
    h.scale = -Number.NaN;
    expect(row.tf.pos).toEqual({ x: 1, y: 1, z: 1 });
    expect(f.store.counters.invalidWrites).toBe(4);
  });

  it('worldFeetPosition composes the parent chain; feetPosition stays local', () => {
    const f = storeFixture();
    f.add({ id: 'cb-door-3', transform: { pos: { x: 10, y: 0, z: 0 }, rot: eulerYXZToQuat(90, 0, 0) } });
    const weld = f.add({ id: 'cb-door-3/weld-1', parentId: 'cb-door-3', transform: { pos: { x: 0, y: 1, z: -2 } } });
    const h = f.store.handle(weld, 'platform');
    expect(h.feetPosition).toEqual({ x: 0, y: 1, z: -2 });
    const w = h.worldFeetPosition;
    expect(w.x).toBeCloseTo(8, 12);
    expect(w.y).toBeCloseTo(1, 12);
    expect(w.z).toBeCloseTo(0, 12);
  });

  it('rotation reads {yaw, pitch, roll} degrees and takes every RotationSpec; yaw keeps pitch and roll', () => {
    const f = storeFixture();
    const row = f.add({ id: 'searchlight' });
    const h = f.store.handle(row, 'platform') as Any;
    expect(h.rotation).toEqual({ yaw: 0, pitch: 0, roll: 0 });
    h.rotation = { yaw: 40, pitch: -18 };
    expect(h.rotation).toEqual({ yaw: 40, pitch: -18, roll: 0 });
    h.yaw = 270;
    expect(h.rotation).toEqual({ yaw: 270, pitch: -18, roll: 0 });
    expect(h.yaw).toBe(270);
    h.rotation = 15;
    expect(h.rotation).toEqual({ yaw: 15, pitch: 0, roll: 0 });
    const q = eulerYXZToQuat(-30, 10, 0);
    h.rotation = q;
    expect(h.rotation.yaw).toBeCloseTo(-30, 9);
    expect(h.rotation.pitch).toBeCloseTo(10, 9);
    h.rotation = { lookAt: { x: -5, y: 0, z: 0 } };
    expect(h.yaw).toBe(90);
    expect(f.ports.physics.setRotation).toHaveBeenCalledTimes(5);
    const r = h.rotation;
    r.yaw = 0;
    expect(h.yaw).toBe(90);
  });

  it('scale reads a number when uniform, else a Vec3; effectiveScale is the world scale, undefined on platform-simulated rows', () => {
    const f = storeFixture();
    f.add({ id: 'boss', transform: { scale: { x: 2, y: 2, z: 2 } } });
    const row = f.add({ id: 'boss/part', parentId: 'boss' });
    const h = f.store.handle(row, 'platform') as Any;
    expect(h.scale).toBe(1);
    h.scale = 0.15;
    expect(h.scale).toBe(0.15);
    h.scale = { x: 1, y: 2, z: 3 };
    expect(h.scale).toEqual({ x: 1, y: 2, z: 3 });
    expect(h.effectiveScale).toEqual({ x: 2, y: 4, z: 6 });
    const enemy = f.store.handle(f.add({ id: 'hollow-1', simulatedBy: 'platform' }), 'platform');
    expect(enemy.effectiveScale).toBe(undefined);
  });

  it('velocity and angularVelocity are snapshots; writes go to the physics port; grounded is the writeback', () => {
    const f = storeFixture();
    const row = f.add({ id: 'gib-1' });
    const h = f.store.handle(row, 'client') as Any;
    h.velocity = { x: 1, y: 2, z: 3 };
    h.angularVelocity = { x: 0, y: 3, z: 0 };
    const v = h.velocity;
    v.x = 50;
    expect(h.velocity).toEqual({ x: 1, y: 2, z: 3 });
    expect(f.ports.physics.setVelocity).toHaveBeenCalledWith(row, { x: 1, y: 2, z: 3 });
    expect(f.ports.physics.setAngularVelocity).toHaveBeenCalledWith(row, { x: 0, y: 3, z: 0 });
    expect(h.grounded).toBe(false);
    f.store.engineWriteTransform(row, { x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 }, true);
    expect(h.grounded).toBe(true);
    expect(h.velocity).toEqual({ x: 0, y: -1, z: 0 });
    expect(h.sleeping).toBe(null);
    expect(h.awake).toBe(null);
  });

  it('bounds come from the scene port as a snapshot, undefined until measured', () => {
    const f = storeFixture();
    const row = f.add({ id: 'hollow-2' });
    const h = f.store.handle(row, 'platform');
    expect(h.bounds).toBe(undefined);
    const b = { min: { x: -1, y: 0, z: -1 }, max: { x: 1, y: 2, z: 1 } };
    f.ports.scene.bounds = () => b;
    expect(h.bounds).toEqual(b);
    expect(h.bounds!.min).not.toBe(b.min);
  });

  it('a camera-attached feetPosition is kept for the viewmodel layer and the row leaves the spatial grid', () => {
    const f = storeFixture();
    const row = f.add({ id: 'vm-gun', vm: 'client', transform: { pos: { x: 0, y: 1, z: 0 } } });
    const h = f.store.handle(row, 'client') as Any;
    expect(f.store.spatial('gallow-farm').near({ x: 0, y: 0, z: 0 }, 1)).toEqual([row]);
    h.feetPosition = { attach: 'camera', x: 0.2, y: -0.62, depth: 0.9, fov: 55 };
    expect(row.props.feetPosition).toEqual({ attach: 'camera', x: 0.2, y: -0.62, depth: 0.9, fov: 55 });
    expect(row.tf.pos).toEqual({ x: 0.2, y: -0.62, z: -0.9 });
    expect(f.store.spatial('gallow-farm').near({ x: 0, y: 0, z: 0 }, 50)).toEqual([]);
    expect(f.ports.physics.setPosition).not.toHaveBeenCalled();
    f.ports.camera.presentedCamera = () => ({ eye: { x: 10, y: 1.6, z: 0 }, aim: { x: 0, y: 0, z: -1 }, fov: 58.7 });
    const w = h.worldFeetPosition;
    expect(w.x).toBeCloseTo(10.2, 12);
    expect(w.y).toBeCloseTo(0.98, 12);
    expect(w.z).toBeCloseTo(-0.9, 12);
    h.feetPosition = { x: 1, y: 0, z: 1 };
    expect(row.props.feetPosition).toBe(undefined);
    expect(f.store.spatial('gallow-farm').near({ x: 1, y: 0, z: 1 }, 1)).toEqual([row]);
  });
});

describe('object properties: props through proxies, channels, physics port', () => {
  it('reads and writes props; nested writes land (lights.js, power.js)', () => {
    const f = storeFixture();
    const row = f.add({ id: 'gf-lamp-2', props: { light: { kind: 'point', intensity: 2, color: 'oklch(0.8 0.1 60)' } } });
    const h = f.store.handle(row, 'platform') as Any;
    expect(h.light.intensity).toBe(2);
    h.light = Object.assign({}, h.light, { intensity: 1 });
    expect(row.props.light).toEqual({ kind: 'point', intensity: 1, color: 'oklch(0.8 0.1 60)' });
    h.light.intensity = 0.5;
    expect(row.props.light).toEqual({ kind: 'point', intensity: 0.5, color: 'oklch(0.8 0.1 60)' });
    expect(h.light).toBe(h.light);
    expect(h.material).toBe(undefined);
    h.primitive = { kind: 'scripted', script: 'scripts/gen/doorwreck.js', params: { t: 1 } };
    expect(row.props.primitive).toEqual({ kind: 'scripted', script: 'scripts/gen/doorwreck.js', params: { t: 1 } });
  });

  it('visible reads true until written', () => {
    const f = storeFixture();
    const row = f.add({ id: 'fa-cloud' });
    const h = f.store.handle(row, 'platform') as Any;
    expect(h.visible).toBe(true);
    h.visible = false;
    expect(h.visible).toBe(false);
    expect(row.props.visible).toBe(false);
  });

  it('physics writes rebuild the body through the physics port (player.js capsule swap)', () => {
    const f = storeFixture();
    const row = f.add({ id: 'player/local', vm: 'client', props: { physics: { body: 'character', capsule: { height: 1.8, radius: 0.35 } } } });
    const h = f.store.handle(row, 'client') as Any;
    h.physics = { ...h.physics, capsule: { height: 1.2, radius: 0.35 } };
    expect(row.props.physics).toEqual({ body: 'character', capsule: { height: 1.2, radius: 0.35 } });
    expect(f.ports.physics.onPhysicsWrite).toHaveBeenCalledWith(row, { body: 'character', capsule: { height: 1.2, radius: 0.35 } });
    h.physics = 'kinematic';
    expect(f.ports.physics.onPhysicsWrite).toHaveBeenLastCalledWith(row, 'kinematic');
  });

  it('forces is a live map: each key write goes to the physics port (gore.js `o.forces.surge = {force} | null`)', () => {
    const f = storeFixture();
    const row = f.add({ id: 'gib-2' });
    const h = f.store.handle(row, 'client') as Any;
    expect(Object.keys(h.forces)).toEqual([]);
    h.forces.surge = { force: { x: 0, y: 5, z: 0 } };
    expect(f.ports.physics.setForce).toHaveBeenLastCalledWith(row, 'surge', { force: { x: 0, y: 5, z: 0 } });
    expect(h.forces.surge).toEqual({ force: { x: 0, y: 5, z: 0 } });
    h.forces.surge = null;
    expect(f.ports.physics.setForce).toHaveBeenLastCalledWith(row, 'surge', null);
    h.forces.wind = { force: { x: 1, y: 0, z: 0 } };
    h.forces = { drag: { force: { x: 0, y: 0, z: 1 } } };
    const calls = vi.mocked(f.ports.physics.setForce).mock.calls.slice(-3).map((c) => [c[1], c[2]]);
    expect(calls).toEqual(
      expect.arrayContaining([
        ['surge', null],
        ['wind', null],
        ['drag', { force: { x: 0, y: 0, z: 1 } }],
      ]),
    );
  });

  it('reads of unknown own fields fall back to nothing; an unknown write sets nothing in the engine', () => {
    const f = storeFixture();
    const row = f.add({ id: 'crate' });
    const h = f.store.handle(row, 'platform') as Any;
    h.foo = 1;
    expect(row.props.foo).toBe(undefined);
    expect(f.store.takeChanges()).toEqual([]);
  });

  it('dev builds report an unknown field write once per (script, field)', () => {
    const f = storeFixture({ dev: true });
    const row = f.add({ id: 'crate' });
    const h = f.store.handle(row, 'platform') as Any;
    const as = { row: 'crate', behavior: 'scripts/map/crate.js' } as const;
    f.store.runAs(as, () => {
      h.foo = 1;
      h.foo = 2;
      h.bar = 1;
    });
    expect(f.warnings.filter((w) => w.includes('unknown handle field'))).toEqual([
      'unknown handle field write crate.foo (scripts/map/crate.js)',
      'unknown handle field write crate.bar (scripts/map/crate.js)',
    ]);
    expect(f.store.counters.unknownFieldWrites).toBe(3);
    // the dev proxy still serves every engine field
    h.visible = false;
    expect(row.props.visible).toBe(false);
    expect(h.id).toBe('crate');
  });
});

describe('hierarchy: parent, children, X-24', () => {
  it('parent is a handle or null; children list direct children in serial order', () => {
    const f = storeFixture();
    const e = f.add({ id: 'enemy-7' });
    const b = f.add({ id: 'enemy-7/bp-Head', parentId: 'enemy-7' });
    const a = f.add({ id: 'enemy-7/bp-Spine', parentId: 'enemy-7' });
    const h = f.store.handle(e, 'platform');
    expect(h.parent).toBe(null);
    expect(h.children.map((c) => c.id)).toEqual(['enemy-7/bp-Head', 'enemy-7/bp-Spine']);
    expect(h.children).not.toBe(h.children);
    expect(f.store.handle(b, 'platform').parent).toBe(h);
    expect(f.store.handle(a, 'platform').parent?.id).toBe('enemy-7');
  });

  it('X-24: client-made audience:local children are invisible to platform-VM reads', () => {
    const f = storeFixture();
    const e = f.add({ id: 'enemy-8', simulatedBy: 'platform' });
    f.add({ id: 'enemy-8/bp-Head', parentId: 'enemy-8', vm: 'client', audience: 'local', scope: 'session' });
    f.add({ id: 'enemy-8/bp-Hips', parentId: 'enemy-8', vm: 'platform' });
    expect(f.store.handle(e, 'platform').children.map((c) => c.id)).toEqual(['enemy-8/bp-Hips']);
    expect(f.store.handle(e, 'client').children.map((c) => c.id)).toEqual(['enemy-8/bp-Head', 'enemy-8/bp-Hips']);
    expect(f.store.handle(e, 'ui').children.map((c) => c.id)).toEqual(['enemy-8/bp-Head', 'enemy-8/bp-Hips']);
  });

  it('re-parenting keeps the world pose and recomputes the local transform', () => {
    const f = storeFixture();
    f.add({ id: 'hull', transform: { pos: { x: 10, y: 0, z: 0 }, rot: eulerYXZToQuat(90, 0, 0) } });
    const row = f.add({ id: 'crate', transform: { pos: { x: 8, y: 1, z: 0 } } });
    const h = f.store.handle(row, 'platform') as Any;
    f.store.beginTick();
    h.parent = 'hull';
    expect(h.parent.id).toBe('hull');
    const w = h.worldFeetPosition;
    expect(w.x).toBeCloseTo(8, 12);
    expect(w.y).toBeCloseTo(1, 12);
    expect(w.z).toBeCloseTo(0, 12);
    expect(h.feetPosition.z).toBeCloseTo(-2, 12);
    expect(f.store.childrenOf('hull')).toEqual([row]);
    // the local transform changed frame: nothing to interpolate from
    expect(row.tf.prevPos).toBe(row.tf.pos);
    expect(row.tf.prevRot).toBe(row.tf.rot);
    h.parent = null;
    expect(h.feetPosition.x).toBeCloseTo(8, 12);
    expect(f.store.childrenOf('hull')).toEqual([]);
    // a cycle or a missing parent is refused
    const hull = f.store.handle(f.store.get('hull')!, 'platform') as Any;
    h.parent = hull;
    hull.parent = 'crate';
    expect(hull.parent).toBe(null);
    h.parent = 'nope';
    expect(h.parent.id).toBe('hull');
  });
});

describe('behavior, behaviorHealth', () => {
  it('behavior lists the paths in spec order; behaviorHealth is undefined until a hook breaks', () => {
    const f = storeFixture();
    const row = f.add({ id: 'player/local', vm: 'client', behaviors: [behavior('scripts/player.js'), behavior('scripts/humanoid-locomotion.js')] });
    const h = f.store.handle(row, 'client');
    expect(h.behavior).toEqual(['scripts/player.js', 'scripts/humanoid-locomotion.js']);
    expect(h.behaviorHealth).toBe(undefined);
    const broken: BehaviorHookHealth = { hook: 'update', script: 'scripts/player.js', error: 'TypeError: x', tick: 12, running: 'running', count: 3 };
    row.behaviors[0]!.health.set('update', broken);
    expect(h.behaviorHealth).toEqual({ broken: [broken] });
    expect(h.behaviorHealth!.broken[0]).not.toBe(broken);
  });
});

describe('spectating and players (§5.8)', () => {
  it('spectating writes reach the physics port and block the body’s devices', () => {
    const f = storeFixture();
    const row = f.add({ id: 'player/local', vm: 'client', player: { userId: 'u1', displayName: 'Operator', bodyId: 'player/local', look: [] } });
    // the Director writes it from the platform VM (a cross-VM write, counted)
    const fromDirector = f.store.handle(row, 'platform') as Any;
    fromDirector.spectating = true;
    expect(row.spectating).toBe(true);
    expect(f.ports.physics.setSpectating).toHaveBeenCalledWith(row, true);
    expect(f.ports.input.setBlocked).toHaveBeenCalledWith('body', true);
    expect(f.store.counters.crossVmWrites).toBe(1);
    fromDirector.spectating = true;
    expect(f.ports.physics.setSpectating).toHaveBeenCalledTimes(1);
    fromDirector.spectating = false;
    expect(f.ports.input.setBlocked).toHaveBeenLastCalledWith('body', false);
  });

  it('a player view carries userId, displayName, per-VM isLocal and the fixed fields', () => {
    const f = storeFixture();
    const row = f.add({ id: 'player/local', vm: 'client', player: { userId: 'pg-42', displayName: 'Operator', bodyId: 'player/local', look: [] } });
    const client = f.store.handle(row, 'client') as PlayerView;
    const platform = f.store.handle(row, 'platform') as PlayerView;
    expect(client.userId).toBe('pg-42');
    expect(client.displayName).toBe('Operator');
    expect(client.isLocal).toBe(true);
    expect(platform.isLocal).toBe(false);
    expect((f.store.handle(row, 'ui') as PlayerView).isLocal).toBe(true);
    expect([client.controlling, client.portraitUrl, client.isEditor, client.isGodMode, client.party, client.guild, client.latencyMs, client.inputHeld]).toEqual([
      null,
      null,
      false,
      false,
      null,
      null,
      0,
      false,
    ]);
  });

  it('the look stack: push, entry writes, whole replace; duration and fade are dropped (surge-logic.js:8-9)', () => {
    const f = storeFixture();
    const row = f.add({ id: 'player/local', vm: 'client', player: { userId: 'u', displayName: 'O', bodyId: 'player/local', look: [] } });
    const me = f.store.handle(row, 'client') as Any;
    // scripts/fx/surge-fx.js:33-43
    me.look.push({ look: 'scripts/looks/surge.js', intensity: 0.1, priority: 50, duration: 3, fade: 0.4 });
    expect(row.player!.look).toEqual([{ look: 'scripts/looks/surge.js', intensity: 0.1, priority: 50 }]);
    const looks = me.look;
    looks[0].intensity = 0.6;
    expect(row.player!.look[0]!.intensity).toBe(0.6);
    me.look = looks.filter((l: Any) => l.look !== 'scripts/looks/surge.js');
    expect(row.player!.look).toEqual([]);
    expect(f.store.takeChanges().every((c) => c.field === 'look')).toBe(true);
  });
});

describe('the camera rig (§7.4)', () => {
  it('rig fields live in the rig layer over the camera def; target and view come from the store and the camera port', () => {
    const f = storeFixture();
    const body = f.add({ id: 'player/local', vm: 'client' });
    const layer = new LayeredValueImpl(() => ({ kind: 'custom', orientation: { source: 'look' }, pointerLock: true, sensitivity: 3 }));
    const rigRow = f.add({ id: 'camera/local', vm: 'client', rig: { targetId: 'player/local', layer } });
    const rig = f.store.handle(rigRow, 'client') as RigView;
    expect(rig.target).toBe(f.store.handle(body, 'client'));
    expect(rig.view).toBe(undefined);
    f.ports.camera.view = () => ({ yaw: 0.5, pitch: -0.1 });
    expect(rig.view).toEqual({ yaw: 0.5, pitch: -0.1 });
    expect(rig.fov).toBe(undefined);
    rig.fov = 58.72;
    rig.hideLocalPlayer = true;
    expect(rig.fov).toBe(58.72);
    expect(layer.read()).toMatchObject({ fov: 58.72, hideLocalPlayer: true, pointerLock: true, sensitivity: 3 });
    expect(rig.orientation).toEqual({ source: 'look' });
    rig.orientation!.source = 'script';
    expect(rig.orientation).toEqual({ source: 'look' });
    const before = rigRow.propVer;
    rig.hideLocalPlayer = true;
    expect(rigRow.propVer).toBe(before);
  });
});

describe('the handle cache, dead rows, read-only UI handles, cross-VM writes', () => {
  it('caches one handle per (row, VM) and one for the UI realm', () => {
    const f = storeFixture();
    const row = f.add({ id: 'crate' });
    const a = f.store.handle(row, 'platform');
    expect(f.store.handle(row, 'platform')).toBe(a);
    expect(f.store.handle(row, 'client')).not.toBe(a);
    expect(f.store.handle(row, 'ui')).not.toBe(a);
    expect(f.store.handle(row, 'ui')).toBe(f.store.handle(row, 'ui'));
  });

  it('a dead row’s handle reads its last values and ignores writes with a warning', () => {
    const f = storeFixture({ dev: true });
    const row = f.add({ id: 'hollow-9', state: { hp: 3 }, transform: { pos: { x: 1, y: 0, z: 2 } } });
    const h = f.store.handle(row, 'platform') as Any;
    f.store.detach('hollow-9');
    expect(h.state.hp).toBe(3);
    expect(h.feetPosition).toEqual({ x: 1, y: 0, z: 2 });
    h.state.hp = 0;
    h.feetPosition = { x: 0, y: 0, z: 0 };
    h.visible = false;
    expect(row.state.hp).toBe(3);
    expect(row.tf.pos).toEqual({ x: 1, y: 0, z: 2 });
    expect(f.store.counters.deadWrites).toBe(3);
    expect(f.warnings).toContain('write to dead row hollow-9.state');
    // its id is free again; the old handle does not see the new row's children
    f.add({ id: 'hollow-9' });
    f.add({ id: 'hollow-9/bp-Head', parentId: 'hollow-9' });
    expect(h.children).toEqual([]);
  });

  it('UI handles are read-only: setters, state and prop writes are no-ops', () => {
    'use strict';
    const f = storeFixture();
    const row = f.add({ id: 'player/local', vm: 'client', state: { prefs: { vol: 1 } }, props: { light: { intensity: 1 } } });
    const ui = f.store.handle(row, 'ui') as Any;
    ui.visible = false;
    ui.state = {};
    ui.state.prefs.vol = 0;
    delete ui.state.prefs;
    ui.light.intensity = 0;
    ui.feetPosition = { x: 9, y: 9, z: 9 };
    ui.anim.act = { clip: 'x' };
    expect(row.state).toEqual({ prefs: { vol: 1 } });
    expect(row.props).toEqual({ light: { intensity: 1 } });
    expect(row.tf.pos).toEqual({ x: 0, y: 0, z: 0 });
    expect(f.store.counters.readonlyWrites).toBe(7);
    expect(ui.state.prefs.vol).toBe(1);
  });

  it('counts writes made through another VM’s handle and reports them to the hook', () => {
    const seen: string[] = [];
    const f = storeFixture({ onCrossVmWrite: (writer, row, field) => seen.push(`${writer}->${row.id}.${field}`) });
    const row = f.add({ id: 'player/local', vm: 'client' });
    (f.store.handle(row, 'platform') as Any).state.live = { alive: true };
    (f.store.handle(row, 'client') as Any).state.live = { alive: false };
    expect(seen).toEqual(['platform->player/local.state']);
    expect(f.store.counters.crossVmWrites).toBe(1);
    // wired late (the VMs exist after the store): the hook can be replaced
    const late: string[] = [];
    f.store.setCrossVmWriteHook((writer, r, field) => late.push(`${writer}:${r.id}.${field}`));
    (f.store.handle(row, 'platform') as Any).spectating = true;
    expect(late).toEqual(['platform:player/local.spectating']);
    expect(seen.length).toBe(1);
  });
});

describe('dev: the "state write lost" detector (§5.3)', () => {
  it('warns when an assigned object is mutated after the assignment within the tick', () => {
    const f = storeFixture({ dev: true });
    const row = f.add({ id: 'p' });
    const h = f.store.handle(row, 'platform') as Any;
    const bag = { n: 1 };
    const kept = { m: 1 };
    h.state.bag = bag;
    h.state.kept = kept;
    bag.n = 2;
    expect(f.store.checkLostWrites()).toBe(1);
    expect(f.warnings).toContain('state write lost: p.bag was mutated after assignment');
    expect(f.store.checkLostWrites()).toBe(0);
  });

  it('judges only the last assignment of a path: a scratch object reused for several writes is not a lost write', () => {
    const f = storeFixture({ dev: true });
    const row = f.add({ id: 'p' });
    const h = f.store.handle(row, 'platform') as Any;
    const scratch = { x: 0 };
    for (let i = 1; i <= 3; i++) {
      scratch.x = i;
      h.state.pos = scratch;
    }
    expect(row.state.pos).toEqual({ x: 3 });
    expect(f.store.checkLostWrites()).toBe(0);
    // the last one mutated afterwards still counts, and a dead row is not judged
    scratch.x = 4;
    h.state.pos = scratch;
    scratch.x = 5;
    const gone = f.add({ id: 'q' });
    const bag = { n: 1 };
    (f.store.handle(gone, 'platform') as Any).state.bag = bag;
    bag.n = 2;
    f.store.detach('q');
    expect(f.store.checkLostWrites()).toBe(1);
  });

  it('keeps nothing outside dev builds', () => {
    const f = storeFixture();
    const h = f.store.handle(f.add({ id: 'p' }), 'platform') as Any;
    const bag = { n: 1 };
    h.state.bag = bag;
    bag.n = 2;
    expect(f.store.checkLostWrites()).toBe(0);
  });
});

describe('types', () => {
  it('handles satisfy ObjectView', () => {
    const f = storeFixture();
    const h: ObjectView = f.store.handle(f.add({ id: 'crate' }), 'platform');
    const rec: RowRec | null = f.store.rowOf(h);
    expect(rec?.id).toBe('crate');
    expect(f.store.rowOf({} as ObjectView)).toBe(null);
    expect(storeFixture().store.rowOf(h)).toBe(null);
  });
});
