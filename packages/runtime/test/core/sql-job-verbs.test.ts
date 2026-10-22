import { afterEach, describe, expect, it } from 'vitest';
import { createJobExtension, createSqlExtension, createSqlJsPort, type JobPort, type JobResult, type SqlPort } from '../../src/ports/index.ts';
import { extOf, prepareExtensions } from '../../src/compat/core/ext.ts';
import { testWorld, type Module } from './world.ts';

const open: SqlPort[] = [];
afterEach(async () => {
  while (open.length) await open.pop()!.close();
});
const sqlPort = (): SqlPort => {
  const p = createSqlJsPort({ saveDebounceMs: 5 });
  open.push(p);
  return p;
};

const calls: string[] = [];
const MODULES: Record<string, Module> = {
  'scripts/db.js': {
    async migrate(sql: (s: TemplateStringsArray, ...v: unknown[]) => Promise<unknown>) {
      calls.push('migrate');
      await sql`CREATE TABLE IF NOT EXISTS champions (uid TEXT PRIMARY KEY, xp INTEGER)`;
    },
  },
  'scripts/player.js': {
    onDone(_ctx: unknown, result: JobResult, payload: unknown) {
      calls.push(`hook:${JSON.stringify(payload)}:${result.ok}`);
    },
  },
  'templates/player.js': { player: { behavior: ['scripts/player.js'], tags: ['player'] } },
};

const fakeJobs = (): JobPort & { submitted: string[] } => {
  const submitted: string[] = [];
  return {
    submitted,
    submit(id, args, _o, cb) {
      submitted.push(id);
      queueMicrotask(() => cb?.({ ok: true, data: { echo: args }, durationMs: 1 }));
      return `req-${submitted.length}`;
    },
    awaitJob: async () => ({ ok: true, durationMs: 1 }),
    cancel: () => false,
    dispose() {},
  };
};

const human = (w: Awaited<ReturnType<typeof testWorld>>) =>
  w.k.spawnHuman({ place: 'p1', at: { x: 0, y: 0, z: 0 }, userId: 'u-7', displayName: 'Op', durableState: {} });

describe('K5/K7: ctx.sql, ctx.job, ctx.awaitJob from ports', () => {
  it('default (no ext): sql and job are the throwing stubs, as in PP', async () => {
    const w = await testWorld({ modules: MODULES });
    const ctx = w.ctx(human(w));
    expect(typeof ctx.job).toBe('function');
    expect(() => (ctx as any).sql`SELECT 1`).toThrow(/not available/);
    expect(() => ctx.job('x', {})).toThrow(/not available/);
  });

  it('absentAsUndefined: no ports -> undefined, so feature detection works', async () => {
    const w = await testWorld({ modules: MODULES, ext: { capabilities: { absentAsUndefined: true } } });
    const ctx = w.ctx(human(w));
    expect(ctx.job).toBeUndefined();
    expect((ctx as any).awaitJob).toBeUndefined();
    expect((ctx as any).sql).toBeUndefined();
    expect(!ctx.job).toBe(true);
  });

  it('sql: migrate runs from scripts/db.js (twice is idempotent), @caller is the local user id, size/backup exist', async () => {
    const port = sqlPort();
    const ext = { sql: createSqlExtension({ port }), capabilities: { absentAsUndefined: true } };
    const w = await testWorld({ modules: MODULES, ext });
    await extOf(w.k).sql!.prepare!(w.k.registry);
    await extOf(w.k).sql!.prepare!(w.k.registry);
    expect(calls.filter((c) => c === 'migrate')).toHaveLength(2);
    const ctx = w.ctx(human(w)) as any;
    await ctx.sql`INSERT INTO champions (uid, xp) VALUES (@caller, ${5}) ON CONFLICT(uid) DO UPDATE SET xp = MAX(champions.xp, excluded.xp)`;
    await ctx.sql`INSERT INTO champions (uid, xp) VALUES (@caller, ${3}) ON CONFLICT(uid) DO UPDATE SET xp = MAX(champions.xp, excluded.xp)`;
    const r = await ctx.sql`SELECT uid, xp FROM champions`;
    expect(r.rows).toEqual([{ uid: 'u-7', xp: 5 }]);
    expect(typeof ctx.sql.size).toBe('function');
    expect(await ctx.sql.size()).toBeGreaterThan(0);
    // a sim has no @caller
    const sim = w.rootSim({});
    await expect((sim.ctx as any).sql`SELECT @caller`).rejects.toMatchObject({ code: 'statement_not_player_invocable' });
  });

  it('sql persists in the port across kernels (same port, same world id)', async () => {
    const port = sqlPort();
    const mk = async () => testWorld({ modules: MODULES, ext: { sql: createSqlExtension({ port }) } });
    const a = await mk();
    await extOf(a.k).sql!.prepare!(a.k.registry);
    await (a.ctx(human(a)) as any).sql`INSERT INTO champions (uid, xp) VALUES ('z', 1)`;
    const b = await mk();
    const r = await (b.ctx(human(b)) as any).sql`SELECT COUNT(*) AS n FROM champions`;
    expect(r.rows[0].n).toBe(1);
  });

  it('job: callback form, hook form (module export gets ctx, result, payload) and awaitJob', async () => {
    const jobs = fakeJobs();
    const w = await testWorld({ modules: MODULES, ext: { jobs: createJobExtension({ port: jobs }) } });
    const ctx = w.ctx(human(w));
    const results: JobResult[] = [];
    const id = ctx.job('cpu', { a: 1 }, (r: JobResult) => results.push(r));
    expect(id).toBe('req-1');
    ctx.job('cpu', { a: 2 }, 'onDone', { tag: 't' });
    await new Promise((r) => setTimeout(r, 5));
    expect(results[0]).toMatchObject({ ok: true, data: { echo: { a: 1 } } });
    expect(calls).toContain('hook:{"tag":"t"}:true');
    expect(await (ctx as any).awaitJob(id)).toMatchObject({ ok: true });
    expect(jobs.submitted).toEqual(['cpu', 'cpu']);
  });
});

describe('K7: ext.jobs warm-up at boot', () => {
  const reg = { get: () => undefined, knows: () => false, load: async () => ({}) } as any;
  it('awaits the port init before prepareExtensions resolves (createJobExtension passes it through)', async () => {
    const order: string[] = [];
    const port = Object.assign(fakeJobs(), {
      init: async () => {
        await new Promise((r) => setTimeout(r, 5));
        order.push('init');
      },
    });
    const ext = createJobExtension({ port });
    expect(typeof ext.init).toBe('function');
    const w = await testWorld({ ext: { jobs: ext } });
    await prepareExtensions(w.k, reg);
    order.push('after');
    expect(order).toEqual(['init', 'after']);
  });

  it('a port without init gives an extension without init; a failing init is reported, not fatal', async () => {
    expect(createJobExtension({ port: fakeJobs() }).init).toBeUndefined();
    const failing = createJobExtension({ port: Object.assign(fakeJobs(), { init: () => Promise.reject(new Error('cold')) }) });
    const w = await testWorld({ ext: { jobs: failing } });
    const seen: string[] = [];
    await expect(prepareExtensions(w.k, reg, (m) => seen.push(m))).resolves.toBeUndefined();
    expect(seen).toEqual(['[jobs] pool warm-up failed']);
  });

  it('negative control: no ext.jobs, nothing runs', async () => {
    const w = await testWorld({});
    await expect(prepareExtensions(w.k, reg)).resolves.toBeUndefined();
  });
});
