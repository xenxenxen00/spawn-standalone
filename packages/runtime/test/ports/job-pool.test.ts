import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createJobHost, type JobPort, type JobResult, type WorkerFactory } from '../../src/ports/index.ts';
import { createNodeWorkerFactory } from '../../src/ports/jobs/node-worker.ts';

const fixture = (rel: string): string => pathToFileURL(fileURLToPath(new URL(`./fixtures/${rel}`, import.meta.url))).href;
const moduleFor = (id: string): string | null =>
  id === 'cpu' ? fixture('jobs/cpu.js') : id.startsWith('test:') ? fixture(`jobs/${id.slice(5)}.js`) : null;

const hosts: JobPort[] = [];
/** Counts the workers the factory starts, so reuse is observable. */
function pooled(options: { poolSize?: number; defaultDeadlineMs?: number } = {}): { host: JobPort; created: () => number } {
  const inner = createNodeWorkerFactory();
  let n = 0;
  const createWorker: WorkerFactory = () => {
    n += 1;
    return inner();
  };
  const host = createJobHost({ resolveModule: moduleFor, createWorker, ...options });
  hosts.push(host);
  return { host, created: () => n };
}
afterEach(() => {
  while (hosts.length > 0) hosts.pop()!.dispose();
});
const call = (host: JobPort, id: string, args: Record<string, unknown> = {}, options = {}): Promise<JobResult> =>
  new Promise((resolve) => host.submit(id, args, options, resolve));

describe('JobPort worker pool (K7)', () => {
  it('default (no pool) starts one worker per call', async () => {
    const { host, created } = pooled();
    await call(host, 'test:echo');
    await call(host, 'test:echo');
    expect(created()).toBe(2);
  });

  it('init() warms the pool and calls reuse the warm workers', async () => {
    const { host, created } = pooled({ poolSize: 2 });
    await host.init!();
    expect(created()).toBe(2);
    for (let i = 0; i < 4; i++) expect((await call(host, 'test:echo', { i })).ok).toBe(true);
    expect(created()).toBe(2);
  });

  it('CPU jobs return results through the 2-worker pool within the deadline', async () => {
    const { host } = pooled({ poolSize: 2, defaultDeadlineMs: 10_000 });
    await host.init!();
    const state = { values: [2, 9, 4] };
    const results = await Promise.all([0, 1, 0].map((level) => call(host, 'cpu', { state, level })));
    for (const r of results) {
      expect(r.ok).toBe(true);
      expect(r.data).toEqual({ index: 1, value: 9 });
      expect(r.durationMs).toBeLessThan(10_000);
    }
  });

  it('deadline path: the busy worker is killed, the result says deadlineExceeded, and the pool recovers', async () => {
    const { host, created } = pooled({ poolSize: 2, defaultDeadlineMs: 250 });
    await host.init!();
    expect(created()).toBe(2);
    const r = await call(host, 'test:slow', { ms: 30_000 });
    expect(r.error).toMatchObject({ code: 'deadline_exceeded', deadlineExceeded: true });
    // Recovery is asserted on the pool's state, not on wall-clock speed: the follow-up calls carry a deadline of their own, so the
    // 250 ms default (the one under test) cannot fail them while a loaded machine starts a worker and imports the module.
    // Two at once need both slots: the surviving warm worker and exactly one replacement for the killed one.
    const after = await Promise.all([call(host, 'test:echo', { i: 1 }, { deadlineMs: 20_000 }), call(host, 'test:echo', { i: 2 }, { deadlineMs: 20_000 })]);
    expect(after.map((x) => x.error ?? null)).toEqual([null, null]);
    expect(after.every((x) => x.ok)).toBe(true);
    expect(created()).toBe(3);
  });

  it('negative control: a crashed worker is replaced, never handed out again', async () => {
    const { host, created } = pooled({ poolSize: 1 });
    await host.init!();
    expect(created()).toBe(1);
    const crashed = await call(host, 'test:crash', {}, { deadlineMs: 10_000 });
    expect(crashed.error).toMatchObject({ code: 'worker_crashed' });
    const after = await call(host, 'test:echo', { ok: 1 });
    expect(after).toMatchObject({ ok: true });
    expect(created()).toBe(2);
  });

  it('a job that throws leaves its worker healthy and reusable', async () => {
    const { host, created } = pooled({ poolSize: 1 });
    await host.init!();
    expect((await call(host, 'test:throws')).ok).toBe(false);
    expect((await call(host, 'test:echo')).ok).toBe(true);
    expect(created()).toBe(1);
  });

  it('caps concurrency at the pool size and queues the rest', async () => {
    const { host, created } = pooled({ poolSize: 2 });
    const rs = await Promise.all([1, 2, 3, 4, 5].map((i) => call(host, 'test:echo', { i })));
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(created()).toBeLessThanOrEqual(2);
  });
});

describe('job module init() (K7 item 6)', () => {
  it('runs once per worker, before the first call, and not again on reuse', async () => {
    const { host } = pooled({ poolSize: 1 });
    expect((await call(host, 'test:withinit')).data).toEqual({ inited: 1 });
    expect((await call(host, 'test:withinit')).data).toEqual({ inited: 1 });
  });

  it('warmJobs loads the module in idle workers at init()', async () => {
    const inner = createNodeWorkerFactory();
    const posted: string[] = [];
    const host = createJobHost({
      resolveModule: moduleFor,
      poolSize: 2,
      warmJobs: ['test:withinit'],
      createWorker: () => {
        const w = inner();
        const post = w.postMessage.bind(w);
        w.postMessage = (m) => {
          posted.push(m.type);
          post(m);
        };
        return w;
      },
    });
    hosts.push(host);
    await host.init!();
    expect(posted).toEqual(['warm', 'warm']);
    expect((await call(host, 'test:withinit')).data).toEqual({ inited: 1 });
  });
});
