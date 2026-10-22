// The row feed (docs/design/core-runtime.md §15.2; docs/architecture.md X-14, §3.0 RowFeed / RowSnapshot): added / changed
// fields in write order / removed, drained once per frame by the renderer; the first drain after the renderer attaches
// delivers every live row as `added`; snapshots are read-only views of the record, not copies.
import { describe, expect, it, vi } from 'vitest';
import { RowFeedImpl, rowSnapshot } from '../../../src/compat/core/events/feed.ts';
import type { RowSnapshot } from '../../../src/compat/core/ports.ts';
import type { RowRec } from '../../../src/compat/core/types.ts';
import { FakeWorld, makeRow, type MiniCtx } from './fakes/tick-world.ts';

/** a sink that writes one line per call */
function sink() {
  const log: string[] = [];
  const snaps: RowSnapshot[] = [];
  return {
    log,
    snaps,
    added: (r: RowSnapshot) => {
      snaps.push(r);
      log.push(`+${r.id}`);
    },
    changed: (r: RowSnapshot, fields: readonly string[]) => log.push(`~${r.id}:${fields.join(',')}`),
    removed: (id: string) => log.push(`-${id}`),
  };
}

describe('RowFeedImpl', () => {
  it('delivers adds, then per-row changed fields in write order (each once), then removals, once', () => {
    const feed = new RowFeedImpl();
    const a = makeRow('a', 1);
    const b = makeRow('b', 2);
    feed.added(a);
    feed.added(b);
    let s = sink();
    feed.drain(s);
    expect(s.log).toEqual(['+a', '+b']);
    feed.changed(b, 'light');
    feed.changed(a, 'primitive');
    feed.changed(b, 'visible');
    feed.changed(b, 'light');
    feed.removed(a);
    s = sink();
    feed.drain(s);
    expect(s.log).toEqual(['~b:light,visible', '-a']);
    s = sink();
    feed.drain(s);
    expect(s.log).toEqual([]);
  });

  it('collapses within one drain: added+changed is added, changed+removed is removed, added+removed is nothing', () => {
    const feed = new RowFeedImpl();
    const old = makeRow('x', 1);
    feed.added(old);
    feed.drain(sink());
    const fresh = makeRow('y', 2);
    feed.added(fresh);
    feed.changed(fresh, 'model');
    const gone = makeRow('z', 3);
    feed.added(gone);
    feed.changed(gone, 'fx');
    feed.removed(gone);
    feed.changed(old, 'light');
    feed.removed(old);
    const s = sink();
    feed.drain(s);
    expect(s.log).toEqual(['+y', '-x']);
  });

  it('an id freed and reused within one drain: the old record is removed before the new one is added', () => {
    const feed = new RowFeedImpl();
    const first = makeRow('door-1', 1);
    feed.added(first);
    feed.drain(sink());
    feed.removed(first);
    const second = makeRow('door-1', 2);
    feed.added(second);
    const s = sink();
    feed.drain(s);
    expect(s.log).toEqual(['-door-1', '+door-1']);
    expect(s.snaps[0]!.spec).toBe(second.spec);
  });

  it('an id reused before the old record is disposed: the old removal still goes before the new add', () => {
    const feed = new RowFeedImpl();
    const other = makeRow('other', 3);
    const first = makeRow('door-1', 1);
    feed.added(other);
    feed.added(first);
    feed.drain(sink());
    feed.changed(other, 'light');
    const second = makeRow('door-1', 2);
    feed.added(second); // the id was freed at destroy; disposal of `first` comes at the boundary
    feed.removed(first);
    const s = sink();
    feed.drain(s);
    expect(s.log).toEqual(['-door-1', '~other:light', '+door-1']);
    expect(s.snaps.at(-1)!.spec).toBe(second.spec);
  });

  it('accumulates until the first drain (the renderer attaches after game_ready): every live row arrives as added', () => {
    const feed = new RowFeedImpl();
    const rows = Array.from({ length: 5 }, (_, i) => makeRow(`r${i}`, i + 1));
    for (const r of rows) feed.added(r);
    for (const r of rows) feed.changed(r, 'state');
    feed.removed(rows[2]!);
    expect(feed.pending).toBe(4);
    const s = sink();
    feed.drain(s);
    expect(s.log).toEqual(['+r0', '+r1', '+r3', '+r4']);
  });

  it('a change to a row the sink never saw is an add; changes to a removed row are ignored', () => {
    const feed = new RowFeedImpl();
    const r = makeRow('r', 1);
    feed.changed(r, 'light');
    let s = sink();
    feed.drain(s);
    expect(s.log).toEqual(['+r']);
    feed.removed(r);
    r.phase = 'dead';
    feed.changed(r, 'light');
    s = sink();
    feed.drain(s);
    expect(s.log).toEqual(['-r']);
  });

  it('snapshots are views of the record (no copies): reads see the current values, the same view for the same record', () => {
    const r = makeRow('lamp-3', 1, { pos: { x: 1, y: 2, z: 3 }, parentId: 'pole-3' });
    r.props['light'] = { intensity: 2 };
    const v = rowSnapshot(r);
    expect(rowSnapshot(r)).toBe(v);
    expect(v.props).toBe(r.props);
    expect(v.spec).toBe(r.spec);
    expect(v.tags).toBe(r.tags);
    expect(v.parentId).toBe('pole-3');
    expect(v.cur.pos).toEqual({ x: 1, y: 2, z: 3 });
    r.tf.prevPos = r.tf.pos;
    r.tf.pos = { x: 4, y: 5, z: 6 };
    r.place = 'p2';
    expect(v.cur.pos).toEqual({ x: 4, y: 5, z: 6 });
    expect(v.prev.pos).toEqual({ x: 1, y: 2, z: 3 });
    expect(v.place).toBe('p2');
    expect(v.cur.scale).toBe(r.tf.scale);
    expect(v.behavior).toEqual([]);
  });

  it('lists the behavior paths of the row', () => {
    const w = new FakeWorld();
    const r = w.spawn('r', { behaviors: [['scripts/a.js', {}], ['scripts/b.js', {}]] });
    expect(rowSnapshot(r).behavior).toEqual(['scripts/a.js', 'scripts/b.js']);
  });

  it('keeps draining when the sink throws on one row', () => {
    const feed = new RowFeedImpl();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const id of ['a', 'b', 'c']) feed.added(makeRow(id, id.charCodeAt(0)));
    const seen: string[] = [];
    feed.drain({
      added: (r) => {
        if (r.id === 'b') throw new Error('bad mesh');
        seen.push(r.id);
      },
      changed: () => {},
      removed: () => {},
    });
    expect(seen).toEqual(['a', 'c']);
    expect(err).toHaveBeenCalledTimes(1);
    expect(feed.pending).toBe(0);
    err.mockRestore();
  });

  it('a change made while draining goes to the next drain', () => {
    const feed = new RowFeedImpl();
    const a = makeRow('a', 1);
    feed.added(a);
    const s = sink();
    feed.drain({ ...s, added: (r) => (s.added(r), feed.changed(a, 'visible')) });
    expect(s.log).toEqual(['+a']);
    const s2 = sink();
    feed.drain(s2);
    expect(s2.log).toEqual(['~a:visible']);
  });
});

describe('kernel.feed (X-14): fed by the kernel\'s row events', () => {
  it('a spawned row is added, a disposed one removed; changes come from the store\'s writes', () => {
    const w = new FakeWorld();
    const mod = {
      update: (ctx: MiniCtx) => {
        if (w.k.clock.tick === 1) ctx.write('light', { intensity: 0 });
        if (w.k.clock.tick === 2) ctx.destroy();
      },
    };
    w.spawn('lamp-1', { behaviors: [['scripts/map/flicker.js', mod]] });
    w.spawn('lamp-2', {});
    let s = sink();
    w.k.feed.drain(s);
    expect(s.log).toEqual(['+lamp-1', '+lamp-2']);
    w.k.runTicks(1);
    s = sink();
    w.k.feed.drain(s);
    expect(s.log).toEqual(['~lamp-1:light']);
    w.k.runTicks(1);
    s = sink();
    w.k.feed.drain(s);
    expect(s.log).toEqual(['-lamp-1']);
    const r: RowRec | undefined = w.rows.get('lamp-1');
    expect(r).toBe(undefined);
  });
});
