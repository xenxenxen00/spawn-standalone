// Proxy read-path optimizations (src/compat/core/store/proxies.ts): regression coverage for the semantics the
// fast paths rely on and preserve.
// - NodeHandler keeps its (store, realm) node cache instead of looking it up per nested read: proxy identity per
//   target object and realm, and the parent/key refresh that lets a re-read array element write to its current index.
// - NodeHandler.get reads first and only checks own-ness for object values: the store only ever proxies wire data
//   (plain objects and arrays, never accessors), so leaf reads, nested reads, array indices and symbol keys behave
//   exactly as before.
import { describe, expect, it } from 'vitest';
import { fieldView, stateProxy } from '../../../src/compat/core/store/proxies.ts';
import type { RowRec } from '../../../src/compat/core/types.ts';
import { storeFixture } from '../core/store-fixture.ts';

const stateOf = (store: any, row: RowRec): Record<string, any> => stateProxy(store, row, 'platform') as any;

describe('proxy read fast paths', () => {
  it('leaf and nested reads return stored values with proxy identity per target', () => {
    const f = storeFixture();
    const row = f.add({
      id: 'r1',
      state: { hp: 10, live: { target: { x: 1, y: 2, z: 3 }, mode: 'seek' }, items: [{ v: 1 }, { v: 2 }] },
    });
    const s = stateOf(f.store, row);
    expect(s.hp).toBe(10);
    expect(s.missing).toBe(undefined);
    expect(s.live).toBe(s.live);
    expect(s.live.target).toBe(s.live.target);
    expect(s.live.target.x).toBe(1);
    expect(s.items[0]).toBe(s.items[0]);
    expect(s.items[1].v).toBe(2);
    expect(s.items.length).toBe(2);
    // symbol keys still fall through to Reflect.get
    expect((s as Record<PropertyKey, unknown>)[Symbol('nope')]).toBe(undefined);
  });

  it('a stale nested reference writes nothing; a re-read element writes to its current index', () => {
    const f = storeFixture();
    const row = f.add({ id: 'r2', state: { items: [{ v: 1 }, { v: 2 }] } });
    const s = stateOf(f.store, row);
    const el = s.items[1];
    s.items.reverse();
    const d0 = f.store.counters.detachedWrites;
    el.v = 7; // stale: el still addresses index 1, which now holds { v: 1 }
    expect(f.store.counters.detachedWrites).toBe(d0 + 1);
    expect(s.items[1].v).toBe(1);
    s.items[0].v = 7; // re-read through the parent: the node was refreshed to index 0
    expect(s.items[0].v).toBe(7);
    const changes = f.store.takeChanges();
    const last = changes[changes.length - 1]!;
    expect(last.field).toBe('state');
    expect([...last.path]).toEqual(['items', 0, 'v']);
  });

  it('equal writes stay free and change records stay frozen with (field, path, invoker)', () => {
    const f = storeFixture();
    const row = f.add({ id: 'r3', state: { hp: 10, live: { mode: 'seek' } } });
    const s = stateOf(f.store, row);
    const w0 = f.store.counters.writes;
    s.hp = 10;
    expect(f.store.counters.writes).toBe(w0);
    expect(f.store.counters.equalWrites).toBe(1);
    s.hp = 11;
    const [c] = f.store.takeChanges();
    expect(c).toBeDefined();
    expect(c!.field).toBe('state');
    expect([...c!.path]).toEqual(['hp']);
    expect(Object.isFrozen(c)).toBe(true);
    expect(Object.isFrozen(c!.path)).toBe(true);
    expect(c!.invoker).toBe('engine');
  });

  it('nested writes still record the full path', () => {
    const f = storeFixture();
    const row = f.add({ id: 'r4', state: { live: { target: { x: 1 } } } });
    const s = stateOf(f.store, row);
    s.live.target.x = 2;
    const [c] = f.store.takeChanges();
    expect([...c!.path]).toEqual(['live', 'target', 'x']);
    expect(s.live.target.x).toBe(2);
  });

  it('field views still read and write through the store', () => {
    const f = storeFixture();
    const row = f.add({ id: 'r5', props: { forces: { surge: 1 } } });
    const fv = fieldView(f.store, row, 'forces', 'platform') as Record<string, any>;
    expect(fv.surge).toBe(1);
    fv.sway = 2;
    expect(fv.sway).toBe(2);
    const [c] = f.store.takeChanges();
    expect(c!.field).toBe('forces');
    expect([...c!.path]).toEqual(['sway']);
  });
});
