// ext.rowSession (opt-in): `ctx.self.session` / `handle.session` is a per-row scratch bag on non-player rows; undefined in PP.
import { describe, expect, it } from 'vitest';
import { storeFixture } from '../../tests/unit/core/store-fixture.ts';
import { testWorld } from './world.ts';

describe('ext.rowSession', () => {
  it('default (PP): a row handle has no session', () => {
    const f = storeFixture();
    const h = f.store.handle(f.add({ id: 'a' }), 'platform') as Record<string, unknown>;
    expect(h['session']).toBeUndefined();
    expect('session' in h).toBe(false);
  });

  it('opt-in: a stable per-row bag, shared by every handle of the row, separate between rows, not part of state', () => {
    const f = storeFixture({ rowSession: true });
    const a = f.add({ id: 'a' });
    const b = f.add({ id: 'b' });
    const ha = f.store.handle(a, 'platform') as Record<string, any>;
    ha['session'].up = true;
    ha['session'].sinkId = 7;
    expect((f.store.handle(a, 'client') as Record<string, any>)['session']).toEqual({ up: true, sinkId: 7 });
    expect((f.store.handle(b, 'platform') as Record<string, any>)['session']).toEqual({});
    expect(ha['state']).toEqual({});
    expect(Object.keys(ha)).not.toContain('session');
  });

  it('opt-in: assigning an object replaces the bag; anything else is ignored; the UI realm cannot replace it', () => {
    const f = storeFixture({ rowSession: true });
    const a = f.add({ id: 'a' });
    const h = f.store.handle(a, 'platform') as Record<string, any>;
    h['session'] = { t: 1 };
    expect(h['session']).toEqual({ t: 1 });
    h['session'] = 5;
    h['session'] = null;
    expect(h['session']).toEqual({ t: 1 });
    const ui = f.store.handle(a, 'ui') as Record<string, any>;
    ui['session'] = { x: 1 };
    expect(h['session']).toEqual({ t: 1 });
  });
});

describe('ext.rowSession through the kernel', () => {
  it('a spawned non-player row reads and writes ctx.getObject(id).session; off, it is undefined', async () => {
    for (const on of [false, true]) {
      const w = await testWorld({ ext: { rowSession: on } });
      const ctx = w.rootSim({}).ctx as any;
      const id = ctx.spawn({ tags: ['hand'], place: 'p1' });
      const obj = ctx.getObject(id);
      if (!on) {
        expect(obj.session).toBeUndefined();
        continue;
      }
      obj.session.up = true;
      expect(ctx.getObject(id).session.up).toBe(true);
    }
  });
});
