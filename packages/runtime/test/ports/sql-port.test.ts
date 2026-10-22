import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SqlError,
  base64ToBytes,
  bindSqlVerb,
  bytesToBase64,
  createMemorySqlStore,
  createSqlJsLoader,
  createSqlJsPort,
  kvSqlStore,
  localStorageKv,
  type SqlJsPortOptions,
  type SqlPort,
  type SqlTag,
} from '../../src/ports/index.ts';

const open: SqlPort[] = [];
function makePort(options: SqlJsPortOptions = {}): SqlPort {
  const port = createSqlJsPort({ saveDebounceMs: 5, ...options });
  open.push(port);
  return port;
}
afterEach(async () => {
  while (open.length > 0) await open.pop()!.close();
});

/** A ctx-shaped object for the fixtures: `ctx.sql` bound to a world and caller, `ctx.now` fixed. */
function ctxFor(port: SqlPort, caller: string | null, now = 1000, worldId = 'w1') {
  return { sql: bindSqlVerb({ port, worldId, caller }), now: () => now };
}

const raw = (text: string): TemplateStringsArray => Object.assign([text], { raw: [text] }) as unknown as TemplateStringsArray;
// Synthetic measurements exercise upserts and ordering without carrying authored game logic.
async function migrate(sql: SqlTag) {
  await sql`CREATE TABLE IF NOT EXISTS readings (user_id TEXT PRIMARY KEY, name TEXT, value INTEGER DEFAULT 0, recorded_at INTEGER DEFAULT 0)`;
}
const run = (name: string, value: number) => ({ name, value });
async function submit(ctx: ReturnType<typeof ctxFor>, reading: ReturnType<typeof run>) {
  await ctx.sql`INSERT INTO readings (user_id, name, value, recorded_at) VALUES (@caller, ${reading.name}, ${reading.value}, ${ctx.now()})
    ON CONFLICT(user_id) DO UPDATE SET name = excluded.name,
    recorded_at = CASE WHEN excluded.value > readings.value THEN excluded.recorded_at ELSE readings.recorded_at END,
    value = MAX(readings.value, excluded.value)`;
}
async function read(ctx: ReturnType<typeof ctxFor>) {
  return (await ctx.sql`SELECT name, value FROM readings ORDER BY value DESC, recorded_at ASC LIMIT 5`).rows;
}

describe('SqlPort with synthetic measurements', () => {
  it('upsert keeps the maximum value and the earlier timestamp on a tie', async () => {
    const port = makePort({ migrate });
    const a = ctxFor(port, 'u-a', 100);
    await submit(a, run('Ada', 40));
    await submit({ ...a, now: () => 200 }, run('Ada', 40));
    expect((await a.sql`SELECT value, recorded_at FROM readings`).rows).toEqual([{ value: 40, recorded_at: 100 }]);
    await submit({ ...a, now: () => 300 }, run('Ada', 50));
    await submit({ ...a, now: () => 400 }, run('Ada', 20));
    expect((await a.sql`SELECT name, value, recorded_at FROM readings WHERE user_id = @caller`).rows).toEqual([{ name: 'Ada', value: 50, recorded_at: 300 }]);
  });

  it('orders the top-N results and ranks a caller with a correlated COUNT', async () => {
    const port = makePort({ migrate });
    const measurements: Array<[string, number]> = [['Ada', 10], ['Bo', 30], ['Cy', 30], ['Di', 5], ['Ed', 20], ['Fa', 1]];
    for (const [i, [name, value]] of measurements.entries()) {
      await submit(ctxFor(port, 'u-' + name, 1000 + i), run(name, value));
    }
    expect((await read(ctxFor(port, 'u-Ed'))).map(r => r['name'])).toEqual(['Bo', 'Cy', 'Ed', 'Ada', 'Di']);
    const { sql } = ctxFor(port, 'u-Ed');
    expect((await sql`SELECT 1 + (SELECT COUNT(*) FROM readings b WHERE b.value > a.value OR (b.value = a.value AND b.recorded_at < a.recorded_at)) AS rank FROM readings a WHERE a.user_id = @caller`).rows).toEqual([{ rank: 3 }]);
  });

  it('returns the documented result shape', async () => {
    const port = makePort({ migrate });
    const { sql } = ctxFor(port, 'u1');
    expect(await sql`SELECT * FROM readings`).toEqual({ rows: [], changes: 0, lastInsertRowid: 0 });
    const inserted = await sql`INSERT INTO readings (user_id, name) VALUES (@caller, ${'x'})`;
    expect(inserted.rows).toEqual([]);
    expect(inserted.changes).toBe(1);
    expect(inserted.lastInsertRowid).toBeGreaterThan(0);
    expect((await sql`UPDATE readings SET value = 1 WHERE user_id = ${'nobody'}`).changes).toBe(0);
  });

  it('does not return a changes count for a read after a write', async () => {
    const port = makePort({ migrate });
    const { sql } = ctxFor(port, 'u1');
    await sql`INSERT INTO readings (user_id, name) VALUES (@caller, ${'x'})`;
    expect((await sql`SELECT * FROM readings`).changes).toBe(0);
  });
});

describe('parameters, @caller, limits, errors', () => {
  const setup = async () => {
    const port = makePort();
    const world = (caller: string | null) => bindSqlVerb({ port, worldId: 'w', caller });
    await world('u')`CREATE TABLE t (id INTEGER PRIMARY KEY, a, b, c)`;
    return { port, world };
  };

  it('binds strings, numbers, booleans and null; undefined becomes null', async () => {
    const { world } = await setup();
    const sql = world('u');
    await sql`INSERT INTO t (a, b, c) VALUES (${'s'}, ${2.5}, ${true})`;
    await sql`INSERT INTO t (a, b, c) VALUES (${null}, ${false}, ${undefined})`;
    expect((await sql`SELECT a, b, c FROM t ORDER BY id`).rows).toEqual([
      { a: 's', b: 2.5, c: 1 },
      { a: null, b: 0, c: null },
    ]);
  });

  it('refuses objects and keeps SQL text out of the value channel', async () => {
    const { world } = await setup();
    const sql = world('u');
    await expect(sql`INSERT INTO t (a) VALUES (${{ x: 1 } as never})`).rejects.toMatchObject({ code: 'bad_param' });
    const evil = "x'); DROP TABLE t; --";
    await sql`INSERT INTO t (a) VALUES (${evil})`;
    expect((await sql`SELECT a FROM t`).rows).toEqual([{ a: evil }]);
  });

  it('binds @caller to the calling player and refuses it where there is none', async () => {
    const { world } = await setup();
    await world('alice')`INSERT INTO t (a) VALUES (@caller)`;
    await world('bob')`INSERT INTO t (a) VALUES (@caller)`;
    expect((await world('bob')`SELECT a FROM t WHERE a = @caller`).rows).toEqual([{ a: 'bob' }]);
    const err: unknown = await world(null)`INSERT INTO t (a) VALUES (@caller)`.catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SqlError);
    expect(err).toMatchObject({ code: 'statement_not_player_invocable' });
    // inside a string literal or comment @caller is only text
    await world(null)`INSERT INTO t (a) VALUES ('@caller') -- @caller`;
  });

  it('resolves the caller per call when given a function', async () => {
    const port = makePort();
    let who: string | null = 'p1';
    const sql = bindSqlVerb({ port, worldId: 'w', caller: () => who });
    await sql`CREATE TABLE t (a)`;
    await sql`INSERT INTO t VALUES (@caller)`;
    who = 'p2';
    await sql`INSERT INTO t VALUES (@caller)`;
    expect((await sql`SELECT a FROM t ORDER BY rowid`).rows).toEqual([{ a: 'p1' }, { a: 'p2' }]);
  });

  it('runs semicolon-separated statements as one transaction and returns the last result', async () => {
    const { world } = await setup();
    const sql = world('u');
    const ok = await sql`INSERT INTO t (a) VALUES (${1}); INSERT INTO t (a) VALUES (${2}); SELECT COUNT(*) AS n FROM t`;
    expect(ok.rows).toEqual([{ n: 2 }]);
    await expect(sql`INSERT INTO t (a) VALUES (${3}); INSERT INTO nope VALUES (1)`).rejects.toMatchObject({ code: 'sql_error' });
    expect((await sql`SELECT COUNT(*) AS n FROM t`).rows).toEqual([{ n: 2 }]); // the first insert rolled back
  });

  it('enforces the statement, parameter and compound-select budgets', async () => {
    const { world } = await setup();
    const sql = world('u');
    const many = Array.from({ length: 65 }, () => 'SELECT 1').join(';');
    await expect(sql(raw(many))).rejects.toMatchObject({ code: 'too_many_statements' });
    const sixtyFour = Array.from({ length: 64 }, () => 'SELECT 1').join(';');
    await expect(sql(raw(sixtyFour))).resolves.toBeDefined();

    const values = Array.from({ length: 101 }, (_, i) => i);
    const strings = ['INSERT INTO t (a) VALUES (', ...values.slice(1).map(() => '),('), ')'];
    // 101 parameters in one multi-row VALUES
    const tpl = Object.assign([...strings], { raw: strings }) as unknown as TemplateStringsArray;
    await expect(sql(tpl, ...values)).rejects.toMatchObject({ code: 'too_many_params' });

    const six = Array.from({ length: 6 }, () => 'SELECT 1').join(' UNION ALL ');
    await expect(sql(raw(six))).rejects.toMatchObject({ code: 'too_many_compound_selects' });
    const five = Array.from({ length: 5 }, () => 'SELECT 1').join(' UNION ALL ');
    await expect(sql(raw(five))).resolves.toBeDefined();
  });

  it('rejects a plain function call; ctx.sql is a template tag', async () => {
    const { world } = await setup();
    await expect((world('u') as unknown as (s: string) => Promise<unknown>)('SELECT 1')).rejects.toBeInstanceOf(SqlError);
  });

  it('accepts positional and named parameters on the port itself', async () => {
    const { port } = await setup();
    await port.run({ worldId: 'w', sql: 'INSERT INTO t (a, b) VALUES (?, ?)', params: ['p', 7] });
    await port.run({ worldId: 'w', sql: 'INSERT INTO t (a, b) VALUES (:a, $b)', params: { a: 'n', b: 8 } });
    expect((await port.run({ worldId: 'w', sql: 'SELECT a, b FROM t ORDER BY id' })).rows).toEqual([
      { a: 'p', b: 7 },
      { a: 'n', b: 8 },
    ]);
    await expect(port.run({ worldId: 'w', sql: 'SELECT ?', params: [] })).rejects.toMatchObject({ code: 'bad_param' });
  });

  it('keeps worlds apart', async () => {
    const port = makePort();
    await bindSqlVerb({ port, worldId: 'one' })`CREATE TABLE t (a)`;
    await expect(bindSqlVerb({ port, worldId: 'two' })`SELECT * FROM t`).rejects.toMatchObject({ code: 'sql_error' });
  });

  it('rejects calls after close', async () => {
    const port = makePort();
    await port.close();
    await expect(port.run({ worldId: 'w', sql: 'SELECT 1' })).rejects.toMatchObject({ code: 'port_closed' });
  });
});

describe('persistence', () => {
  it('round-trips through the memory store after a debounced save', async () => {
    const store = createMemorySqlStore();
    const port = makePort({ store: () => store, migrate: migrate, saveDebounceMs: 20 });
    await submit(ctxFor(port, 'u1'), run('Ada', 500));
    expect(store.saves).toBe(0); // still debouncing
    await vi.waitFor(() => expect(store.saves).toBeGreaterThan(0));
    const savedAfterWrite = store.saves;
    await ctxFor(port, 'u1').sql`SELECT * FROM readings`;
    await new Promise((r) => setTimeout(r, 40));
    expect(store.saves).toBe(savedAfterWrite); // reads never save
    await port.close();

    const reopened = makePort({ store: () => store, migrate: migrate });
    const board = await read(ctxFor(reopened, 'u1'));
    expect(board).toEqual([{ name: 'Ada', value: 500 }]);
  });

  it('coalesces a burst of writes into few saves and flush() writes at once', async () => {
    const store = createMemorySqlStore();
    const port = makePort({ store: () => store, saveDebounceMs: 10_000 });
    const sql = bindSqlVerb({ port, worldId: 'w' });
    await sql`CREATE TABLE t (a)`;
    for (let i = 0; i < 20; i += 1) await sql`INSERT INTO t VALUES (${i})`;
    expect(store.saves).toBe(0);
    await port.flush('w');
    expect(store.saves).toBe(1);
    await port.flush('w');
    expect(store.saves).toBe(1); // nothing dirty
  });

  it('reports a failing store to onSaveError and rethrows from flush', async () => {
    const errors: unknown[] = [];
    const port = makePort({
      store: () => ({ load: () => Promise.resolve(null), save: () => Promise.reject(new Error('disk full')) }),
      onSaveError: (_w, e) => errors.push(e),
      saveDebounceMs: 1,
    });
    const sql = bindSqlVerb({ port, worldId: 'w' });
    await sql`CREATE TABLE t (a)`;
    await vi.waitFor(() => expect(errors).toHaveLength(1));
    await expect(port.flush('w')).rejects.toThrow('disk full');
    open.pop(); // its close() would rethrow; drop it
  });

  it('size() reports bytes and grows with data', async () => {
    const port = makePort();
    const sql = bindSqlVerb({ port, worldId: 'w' });
    await sql`CREATE TABLE t (a)`;
    const small = await sql.size();
    expect(small).toBeGreaterThan(0);
    await sql`INSERT INTO t SELECT randomblob(4000) FROM (WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 50) SELECT x FROM c)`;
    expect(await sql.size()).toBeGreaterThan(small);
  });

  it('backup() and restore() by label, bookmark and timestamp', async () => {
    let clock = 1000;
    const port = makePort({ now: () => clock });
    const sql = bindSqlVerb({ port, worldId: 'w' });
    await sql`CREATE TABLE t (a)`;
    await sql`INSERT INTO t VALUES (1)`;
    const b1 = await sql.backup('one');
    expect(b1).toMatchObject({ label: 'one', ts: 1000 });
    expect(typeof b1.bookmark).toBe('string');
    clock = 2000;
    await sql`INSERT INTO t VALUES (2)`;
    const b2 = await sql.backup('two');
    await sql`INSERT INTO t VALUES (3)`;

    const count = async () => (await sql`SELECT COUNT(*) AS n FROM t`).rows[0]!['n'];
    expect(await sql.restore('two')).toEqual({ restoredTo: b2.bookmark });
    expect(await count()).toBe(2);
    expect(await sql.restore(b1.bookmark)).toEqual({ restoredTo: b1.bookmark });
    expect(await count()).toBe(1);
    expect(await sql.restore(1500)).toEqual({ restoredTo: b1.bookmark }); // latest at or before ts
    expect(await sql.restore({ label: 'two', ts: 3000 })).toEqual({ restoredTo: b2.bookmark });
    await expect(sql.restore('missing')).rejects.toMatchObject({ code: 'restore_target_not_found' });
    await expect(sql.restore(5)).rejects.toMatchObject({ code: 'restore_target_not_found' });
  });

  it('stores backups through a store that supports them, and reads them back after reopening', async () => {
    const store = createMemorySqlStore();
    const first = makePort({ store: () => store });
    const sql1 = bindSqlVerb({ port: first, worldId: 'w' });
    await sql1`CREATE TABLE t (a)`;
    await sql1`INSERT INTO t VALUES (1)`;
    await sql1.backup('keep');
    await sql1`INSERT INTO t VALUES (2)`;
    await first.close();
    const second = makePort({ store: () => store });
    const sql2 = bindSqlVerb({ port: second, worldId: 'w' });
    await sql2.restore('keep');
    expect((await sql2`SELECT COUNT(*) AS n FROM t`).rows).toEqual([{ n: 1 }]);
  });

  it('loads the wasm once, however many ports and worlds ask', async () => {
    const real = createSqlJsLoader();
    const loader = vi.fn(real);
    const port = makePort({ loadSqlJs: loader });
    await bindSqlVerb({ port, worldId: 'a' })`SELECT 1`;
    await bindSqlVerb({ port, worldId: 'b' })`SELECT 1`;
    expect(loader.mock.calls.length).toBeGreaterThan(0);
    const wasm = vi.fn((f: string) => f);
    const located = createSqlJsLoader({ locateFile: wasm });
    const [x, y] = await Promise.all([located(), located()]);
    expect(x).toBe(y);
    expect(wasm.mock.calls.length).toBeLessThanOrEqual(1);
  });
});

describe('migrate (scripts/db.js)', () => {
  it('is idempotent across reopen and spec versions, and keeps data', async () => {
    const store = createMemorySqlStore();
    const calls = vi.fn(migrate);
    const options = { store: () => store, migrate: calls, specVersion: 'v1' };
    const a = makePort(options);
    await submit(ctxFor(a, 'u1'), run('Ada', 500));
    await a.close();
    const b = makePort(options);
    expect(await read(ctxFor(b, 'u1'))).toHaveLength(1);
    await b.close();
    expect(calls).toHaveBeenCalledTimes(1); // same spec version: not re-run
    const c = makePort({ ...options, specVersion: 'v2' });
    expect(await read(ctxFor(c, 'u1'))).toHaveLength(1);
    expect(calls).toHaveBeenCalledTimes(2); // new version re-runs, harmlessly
  });

  it('runs before the first statement and runs again on an unversioned reopen', async () => {
    const store = createMemorySqlStore();
    const calls = vi.fn(migrate);
    for (let i = 0; i < 2; i += 1) {
      const port = makePort({ store: () => store, migrate: calls });
      await port.run({ worldId: 'w', sql: 'SELECT COUNT(*) FROM readings' });
      await port.close();
    }
    expect(calls).toHaveBeenCalledTimes(2);
  });

  it('has no @caller; a throwing migrate rolls back, reports, and never blocks play', async () => {
    const errors: unknown[] = [];
    const port = makePort({
      migrate: async (sql) => {
        await sql`CREATE TABLE half (a)`;
        await sql`INSERT INTO half VALUES (@caller)`;
      },
      onMigrateError: (_w, e) => errors.push(e),
    });
    await bindSqlVerb({ port, worldId: 'w' })`CREATE TABLE other (a)`; // play goes on
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ code: 'statement_not_player_invocable' });
    await expect(bindSqlVerb({ port, worldId: 'w' })`SELECT * FROM half`).rejects.toMatchObject({ code: 'sql_error' });
  });

  it('caps migrate at 1000 calls', async () => {
    const errors: unknown[] = [];
    const port = makePort({
      migrate: async (sql) => {
        for (let i = 0; i < 1001; i += 1) await sql`SELECT 1`;
      },
      onMigrateError: (_w, e) => errors.push(e),
    });
    await port.run({ worldId: 'w', sql: 'SELECT 1' });
    expect(errors[0]).toMatchObject({ code: 'migrate_budget_exceeded' });
  });
});

describe('synthetic transaction ledger', () => {
  async function setup() {
    const port = makePort();
    const sql = ctxFor(port, null).sql;
    await sql`CREATE TABLE ledger (id TEXT PRIMARY KEY); CREATE TABLE totals (value INTEGER); INSERT INTO totals VALUES (0); CREATE TABLE events (id TEXT PRIMARY KEY)`;
    return sql;
  }

  it('creates each table before use', async () => {
    const sql = await setup();
    expect((await sql`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).rows.map(r => r['name'])).toEqual(['events', 'ledger', 'totals']);
  });

  it('rolls back preceding writes when a later ledger insert duplicates a key', async () => {
    const sql = await setup();
    const apply = (id: string) => sql`UPDATE totals SET value = value + 7; INSERT INTO ledger VALUES (${id})`;
    expect((await apply('one')).changes).toBe(1);
    await expect(apply('one')).rejects.toMatchObject({ code: 'sql_error' });
    await apply('two');
    expect((await sql`SELECT value FROM totals`).rows).toEqual([{ value: 14 }]);
    expect((await sql`SELECT COUNT(*) AS n FROM ledger`).rows).toEqual([{ n: 2 }]);
  });

  it('INSERT OR IGNORE is idempotent and its promise supports catch', async () => {
    const sql = await setup();
    const onError = vi.fn();
    const insert = () => sql`INSERT OR IGNORE INTO events VALUES (${'one'})`.catch(onError);
    await insert();
    await insert();
    expect((await sql`SELECT COUNT(*) AS n FROM events`).rows).toEqual([{ n: 1 }]);
    expect(onError).not.toHaveBeenCalled();
    await sql`INSERT INTO missing VALUES (1)`.catch(onError);
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe('browser store plumbing', () => {
  it('base64 round-trips bytes of every value, including large buffers', () => {
    const bytes = new Uint8Array(70_000).map((_, i) => i % 256);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it('stores the database and backups under world-scoped keys in a Storage-like', async () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      key: (i: number) => [...data.keys()][i] ?? null,
      get length() {
        return data.size;
      },
    };
    const store = kvSqlStore(localStorageKv(storage), 'world-1');
    expect(await store.load()).toBeNull();
    await store.save(new Uint8Array([1, 2, 3]));
    expect(await store.load()).toEqual(new Uint8Array([1, 2, 3]));
    await store.backups!.put({ label: 'x', bookmark: 'b1', ts: 5 }, new Uint8Array([9]));
    expect(await store.backups!.list()).toEqual([{ label: 'x', bookmark: 'b1', ts: 5 }]);
    expect(await store.backups!.get('b1')).toEqual(new Uint8Array([9]));
    expect(await kvSqlStore(localStorageKv(storage), 'world-2').load()).toBeNull();
    const port = makePort({ store: (id) => kvSqlStore(localStorageKv(storage), id), saveDebounceMs: 1 });
    const sql = bindSqlVerb({ port, worldId: 'world-3' });
    await sql`CREATE TABLE t (a)`;
    await port.flush();
    expect(data.has('spawn-sql:world-3:db')).toBe(true);
  });
});
