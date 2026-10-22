// The SQL store over the platform save API, against the Playgama adapter and its scripted Bridge.
import { describe, expect, it, vi } from 'vitest';
import { createPlaygamaPlatform } from '../../src/platform-playgama/index.ts';
import { createHostSqlStores, createPlatformSqlStore, createSqlJsPort, platformSqlKeys } from '../../src/ports/sql/index.ts';
import { createFakeBridge } from '../platform-playgama/fake-bridge.ts';

async function boot(storage: Record<string, string> = {}) {
  const fake = createFakeBridge({ storage });
  const keys = platformSqlKeys('w1');
  const platform = createPlaygamaPlatform({ bridge: () => fake.bridge as never, document: null, initialInterstitialDelayS: 0, saveKeys: keys });
  await platform.init();
  await platform.save.ready;
  return { fake, platform };
}

describe('platform SQL store', () => {
  it('persists a database through bridge.storage as base64 and reloads it', async () => {
    const a = await boot();
    const sql = createSqlJsPort({ store: () => createPlatformSqlStore(a.platform.save, 'w1', { debounceMs: 5 }), saveDebounceMs: 1 });
    await sql.run({ worldId: 'w1', sql: 'CREATE TABLE t (n INTEGER); INSERT INTO t VALUES (7)' });
    await sql.flush();
    await sql.close();
    // the store holds the bytes; the platform write is debounced, then flushed
    await new Promise((r) => setTimeout(r, 30));
    await a.platform.save.flush();
    const got = (await a.fake.bridge.storage.get(platformSqlKeys('w1'))) as unknown as Array<string | null>;
    expect(got[0]!.length).toBeGreaterThan(100);
    const stored = Object.fromEntries(platformSqlKeys('w1').flatMap((k, i) => (got[i] ? [[k, got[i]!]] : [])));
    const b = await boot(stored);
    const sql2 = createSqlJsPort({ store: () => createPlatformSqlStore(b.platform.save, 'w1', { debounceMs: 5 }) });
    const r = await sql2.run({ worldId: 'w1', sql: 'SELECT n FROM t' });
    expect(r.rows).toEqual([{ n: 7 }]);
    await sql2.close();
  });

  it('coalesces a burst of saves into one platform write and warns on size', async () => {
    const set = vi.fn();
    const warn = vi.fn();
    let tick: (() => void) | undefined;
    const store = createPlatformSqlStore({ get: () => null, set, flush: () => Promise.resolve() }, 'w', {
      warnChars: 100,
      warn,
      setTimer: (fn) => ((tick = fn), 1),
      clearTimer: () => (tick = undefined),
    });
    await store.save(new Uint8Array(200));
    await store.save(new Uint8Array(300));
    expect(set).not.toHaveBeenCalled();
    tick!();
    expect(set).toHaveBeenCalledTimes(1);
    expect(set.mock.calls[0]![0]).toBe('spawn-sql:w:db');
    expect(warn).toHaveBeenCalledTimes(1);
    await store.save(new Uint8Array(10));
    await store.flush();
    expect(set).toHaveBeenCalledTimes(2);
  });

  it('refuses a save over maxChars and keeps newest backups within the cap', async () => {
    const mem = new Map<string, string>();
    const save = { get: (k: string) => mem.get(k) ?? null, set: (k: string, v: string) => void mem.set(k, v) };
    const store = createPlatformSqlStore(save, 'w', { maxChars: 40, maxBackups: 2 });
    await expect(store.save(new Uint8Array(100))).rejects.toThrow(/limit/);
    for (const n of [1, 2, 3]) await store.backups.put({ label: `l${n}`, bookmark: `b${n}`, ts: n }, new Uint8Array([n]));
    expect((await store.backups.list()).map((b) => b.bookmark)).toEqual(['b2', 'b3']);
    expect(await store.backups.get('b1')).toBeNull();
    expect([...(await store.backups.get('b3'))!]).toEqual([3]);
  });
});

describe('host SQL stores', () => {
  it('bind(save) routes the factory to the platform save, never the browser store', async () => {
    const { platform } = await boot();
    const stores = createHostSqlStores({ debounceMs: 1 });
    const store = stores.factory('w1');
    stores.bind(platform.save);
    await store.save(new Uint8Array([1, 2, 3]));
    await stores.flush();
    expect(platform.save.get('spawn-sql:w1:db')).toBe('AQID');
    expect([...(await store.load())!]).toEqual([1, 2, 3]);
    expect(stores.keysFor('w1')).toEqual(platformSqlKeys('w1'));
  });
});
