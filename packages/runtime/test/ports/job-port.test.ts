import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  bindJobVerb,
  createJobHost,
  type JobPort,
  type JobResult,
  type JobRunRequest,
  type JobWorkerEvent,
  type WorkerLike,
} from '../../src/ports/index.ts';
import { createNodeWorkerFactory } from '../../src/ports/jobs/node-worker.ts';

const fixture = (rel: string): string => pathToFileURL(fileURLToPath(new URL(`./fixtures/${rel}`, import.meta.url))).href;
const moduleFor = (id: string): string | null => {
  if (id === 'cpu') return fixture('jobs/cpu.js');
  if (id.startsWith('test:')) return fixture(`jobs/${id.slice(5)}.js`);
  return null;
};

const hosts: JobPort[] = [];
function realHost(options: { maxConcurrent?: number; defaultDeadlineMs?: number } = {}): JobPort {
  const host = createJobHost({ resolveModule: moduleFor, createWorker: createNodeWorkerFactory(), ...options });
  hosts.push(host);
  return host;
}
afterEach(() => {
  while (hosts.length > 0) hosts.pop()!.dispose();
});

const call = (host: JobPort, id: string, args: Record<string, unknown> = {}, options = {}): Promise<JobResult> =>
  new Promise((resolve) => host.submit(id, args, options, resolve));

describe('JobPort with real worker_threads', () => {
  it('a CPU job selects the greatest value within budget', async () => {
    const host = realHost();
    const state = { values: [2, 9, 4] };
    const r = await call(host, 'cpu', { state, level: 0 }, { deadlineMs: 20_000 });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ index: 1, value: 9 });
    expect(r.durationMs).toBeLessThan(5_000);
    expect(r.error).toBeUndefined();
  });

  it('returns ok with data null for an empty input', async () => {
    const host = realHost();
    const state = { values: [] };
    const r = await call(host, 'cpu', { state, level: 0 }, { deadlineMs: 20_000 });
    expect(r).toMatchObject({ ok: true, data: null });
  });

  it('passes (job, args) to run and returns its value', async () => {
    const host = realHost();
    const r = await call(host, 'test:echo', { a: 1 });
    expect(r.ok).toBe(true);
    expect(r.data).toMatchObject({ echoed: { a: 1 }, job: { id: 'test:echo', attempt: 1 } });
  });

  it('error path: a throwing job answers { ok: false, error } and never throws', async () => {
    const host = realHost();
    const r = await call(host, 'test:throws');
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ message: 'boom from the job', code: 'job_failed', attempts: 1, retriable: false });
    expect(r.data).toBeUndefined();
  });

  it('answers job_not_found for an unknown id (the engine jobs are absent) and for a module without run()', async () => {
    const host = realHost();
    expect((await call(host, 'llm:chat', { message: 'hi' })).error).toMatchObject({ code: 'job_not_found' });
    expect((await call(host, 'test:not-a-job')).error).toMatchObject({ code: 'job_module_invalid' });
    expect((await call(host, 'test:unclonable')).ok).toBe(false);
  });

  it('timeout path: the watchdog terminates a busy worker and reports deadlineExceeded', async () => {
    const host = realHost();
    const started = Date.now();
    const r = await call(host, 'test:slow', { ms: 30_000 }, { deadlineMs: 300 });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.ok).toBe(false);
    expect(r.error).toMatchObject({ code: 'deadline_exceeded', deadlineExceeded: true, retriable: true, attempts: 1 });
  });

  it('retries a retriable failure and reports the attempt count', async () => {
    // Attempt 1 spins past its real 300 ms deadline (the watchdog ends it: a retriable deadline_exceeded). Attempt 2 runs on a
    // fresh worker whose start-up under load can take longer than any fixed deadline, so its deadline is held off by the pause
    // source (the host arms no timer while paused) and the test waits on the worker's own answer, not on a race with the clock.
    let starts = 0;
    const pause = { paused: () => starts++ > 0, subscribe: () => () => undefined };
    const host = createJobHost({ resolveModule: moduleFor, createWorker: createNodeWorkerFactory(), pause });
    hosts.push(host);
    const r = await call(host, 'test:flaky', {}, { deadlineMs: 300, retries: 1 });
    expect(starts).toBe(2);
    expect(r).toMatchObject({ ok: true, data: { attempt: 2 } });
    // no retries: the same failure is final after one attempt
    const none = await call(realHost(), 'test:flaky', {}, { deadlineMs: 300 });
    expect(none.error).toMatchObject({ deadlineExceeded: true, retriable: true, attempts: 1 });
  });

  it('a worker that dies is reported as worker_crashed', async () => {
    const host = realHost();
    const r = await call(host, 'test:crash', {}, { deadlineMs: 10_000 });
    expect(r.error).toMatchObject({ code: 'worker_crashed', retriable: true });
  });

  it('streams generator yields to onPart and answers with the return value', async () => {
    const host = realHost();
    const parts: unknown[] = [];
    const r = await call(host, 'test:parts', { n: 3 }, { onPart: (p: unknown) => parts.push(p) });
    expect(parts).toEqual([{ i: 0 }, { i: 1 }, { i: 2 }]);
    expect(r).toMatchObject({ ok: true, data: { done: 3 } });
  });

  it('cancel() ends a running job with code cancelled', async () => {
    const host = realHost();
    const result = new Promise<JobResult>((resolve) => {
      const id = host.submit('test:slow', { ms: 30_000 }, { deadlineMs: 20_000 }, resolve);
      setTimeout(() => expect(host.cancel(id)).toBe(true), 200);
    });
    expect((await result).error).toMatchObject({ code: 'cancelled' });
  });
});

/** A worker the test drives by hand. */
class FakeWorker implements WorkerLike {
  static all: FakeWorker[] = [];
  requests: JobRunRequest[] = [];
  terminated = false;
  private message: (e: JobWorkerEvent) => void = () => undefined;
  private error: (e: { message: string }) => void = () => undefined;
  constructor() {
    FakeWorker.all.push(this);
  }
  postMessage(m: JobRunRequest): void {
    this.requests.push(m);
  }
  onMessage(l: (e: JobWorkerEvent) => void): void {
    this.message = l;
  }
  onError(l: (e: { message: string }) => void): void {
    this.error = l;
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(e: JobWorkerEvent): void {
    this.message(e);
  }
  crash(message: string): void {
    this.error({ message });
  }
}

const fakeHost = (options: Partial<Parameters<typeof createJobHost>[0]> = {}): JobPort => {
  FakeWorker.all = [];
  const host = createJobHost({ resolveModule: (id) => `file:///jobs/${id}.js`, createWorker: () => new FakeWorker(), ...options });
  hosts.push(host);
  return host;
};
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('JobPort host semantics (fake workers)', () => {
  it('returns a request id synchronously and delivers the callback later, once', async () => {
    const host = fakeHost();
    const cb = vi.fn();
    const id = host.submit('cpu', { x: 1 }, {}, cb);
    expect(typeof id).toBe('string');
    expect(cb).not.toHaveBeenCalled();
    await tick();
    const w = FakeWorker.all[0]!;
    expect(w.requests[0]).toMatchObject({ type: 'run', requestId: id, args: { x: 1 }, moduleUrl: 'file:///jobs/cpu.js' });
    w.reply({ type: 'result', requestId: id, data: 7 });
    w.reply({ type: 'result', requestId: id, data: 8 }); // a duplicate is ignored
    expect(cb).not.toHaveBeenCalled();
    await tick();
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb.mock.calls[0]![0]).toMatchObject({ ok: true, data: 7 });
    expect(w.terminated).toBe(true);
  });

  it('awaitJob resolves for pending, finished and unknown requests', async () => {
    const host = fakeHost();
    const id = host.submit('cpu', {});
    const pending = host.awaitJob(id);
    await tick();
    FakeWorker.all[0]!.reply({ type: 'result', requestId: id, data: 'x' });
    expect(await pending).toMatchObject({ ok: true, data: 'x' });
    expect(await host.awaitJob(id)).toMatchObject({ ok: true, data: 'x' });
    expect((await host.awaitJob('nope')).error).toMatchObject({ code: 'unknown_request' });
  });

  it('queues beyond maxConcurrent by priority, then arrival', async () => {
    const host = fakeHost({ maxConcurrent: 1 });
    const order: string[] = [];
    const go = (name: string, priority: 'low' | 'normal' | 'high'): string =>
      host.submit(name, {}, { priority }, () => order.push(name));
    const first = go('first', 'normal');
    await tick(); // it starts alone; the rest queue behind it
    go('low', 'low');
    go('normal', 'normal');
    go('high', 'high');
    await tick();
    expect(FakeWorker.all).toHaveLength(1);
    let next = 0;
    const finishCurrent = async (id: string): Promise<void> => {
      FakeWorker.all[next]!.reply({ type: 'result', requestId: id, data: null });
      next += 1;
      await tick();
    };
    await finishCurrent(first);
    for (let i = 0; i < 3; i += 1) {
      const w = FakeWorker.all[next]!;
      await finishCurrent(w.requests[0]!.requestId);
    }
    expect(order).toEqual(['first', 'high', 'normal', 'low']);
  });

  it('coalesces in-flight requests with the same dedupeKey', async () => {
    const host = fakeHost();
    const results: JobResult[] = [];
    const a = host.submit('cpu', {}, { dedupeKey: 'k' }, (r) => results.push(r));
    const b = host.submit('cpu', {}, { dedupeKey: 'k' }, (r) => results.push(r));
    expect(a).not.toBe(b);
    await tick();
    expect(FakeWorker.all).toHaveLength(1);
    FakeWorker.all[0]!.reply({ type: 'result', requestId: a, data: 1 });
    await tick();
    expect(results).toHaveLength(2);
    expect(await host.awaitJob(b)).toMatchObject({ ok: true, data: 1 });
    host.submit('cpu', {}, { dedupeKey: 'k' }); // finished: a fresh run
    await tick();
    expect(FakeWorker.all).toHaveLength(2);
  });

  it('a throwing callback or onPart is swallowed and reported, and the queue goes on', async () => {
    const seen: unknown[] = [];
    const host = fakeHost({ onCallbackError: (e) => seen.push(e) });
    const id = host.submit(
      'cpu',
      {},
      {
        onPart: () => {
          throw new Error('part bug');
        },
      },
      () => {
        throw new Error('cb bug');
      },
    );
    await tick();
    FakeWorker.all[0]!.reply({ type: 'part', requestId: id, part: 1 });
    FakeWorker.all[0]!.reply({ type: 'result', requestId: id, data: 1 });
    await tick();
    expect(seen.map((e) => (e as Error).message)).toEqual(['part bug', 'cb bug']);
  });

  it('builtins run on the main thread and are the only way an engine job id answers', async () => {
    const host = fakeHost({ builtins: { 'text:check': (args) => ({ ok: true, echo: args }) } });
    expect(await call(host, 'text:check', { text: 'x' })).toMatchObject({ ok: true, data: { ok: true, echo: { text: 'x' } } });
    expect(FakeWorker.all).toHaveLength(0);
    const hostWithoutBuiltin = fakeHost({ resolveModule: () => null });
    expect((await call(hostWithoutBuiltin, 'image:generate', {})).error).toMatchObject({ code: 'job_not_found' });
  });

  it('a worker that cannot be created answers worker_unavailable', async () => {
    const host = createJobHost({
      resolveModule: () => 'x',
      createWorker: () => {
        throw new Error('no Worker here');
      },
    });
    hosts.push(host);
    expect((await call(host, 'cpu')).error).toMatchObject({ code: 'worker_unavailable', message: 'no Worker here' });
  });

  it('dispose() answers every pending request as cancelled', async () => {
    const host = fakeHost();
    const pending = call(host, 'cpu');
    await tick();
    host.dispose();
    expect((await pending).error).toMatchObject({ code: 'cancelled' });
    expect(FakeWorker.all[0]!.terminated).toBe(true);
  });
});

describe('bindJobVerb', () => {
  it('ctx.job(id, args, callback, options) returns the id and feeds the callback', async () => {
    const host = fakeHost();
    const { job, awaitJob } = bindJobVerb({ port: host });
    const cb = vi.fn();
    const id = job('cpu', { state: 1, level: 2 }, cb, { deadlineMs: 5000 });
    expect(typeof id).toBe('string');
    await tick();
    FakeWorker.all[0]!.reply({ type: 'result', requestId: id, data: { from: 1 } });
    expect(await awaitJob(id)).toMatchObject({ ok: true, data: { from: 1 } });
    expect(cb.mock.calls[0]![0]).toMatchObject({ ok: true, data: { from: 1 } });
  });

  it('ctx.job(id, args, hookExport, payload) dispatches to the hook', async () => {
    const host = fakeHost();
    const dispatchHook = vi.fn();
    const { job } = bindJobVerb({ port: host, dispatchHook });
    const id = job('cpu', {}, 'onThought', { slot: 3 });
    await tick();
    FakeWorker.all[0]!.reply({ type: 'result', requestId: id, data: 1 });
    await tick();
    expect(dispatchHook).toHaveBeenCalledWith('onThought', expect.objectContaining({ ok: true, data: 1 }), { slot: 3 });
  });

  it('ctx.job(id, args) with no callback still runs and can be awaited', async () => {
    const host = fakeHost();
    const { job, awaitJob } = bindJobVerb({ port: host });
    const id = job('cpu', {});
    await tick();
    FakeWorker.all[0]!.crash('gone');
    expect((await awaitJob(id)).error).toMatchObject({ code: 'worker_crashed', message: 'gone' });
  });

  it('delivers a CPU job result through the bound callback', async () => {
    const host = realHost();
    const { job } = bindJobVerb({ port: host });
    const state = { values: [2, 9, 4] };
    const r = await new Promise<JobResult>((resolve) => job('cpu', { state, level: 0 }, resolve));
    expect(r).toMatchObject({ ok: true, data: { index: 1, value: 9 } });
  });
});

describe('bindJobVerb plain arguments', () => {
  const stateProxy = (): Record<string, unknown> => new Proxy({ board: [1, 2, { k: 'x' }], turn: 3, skip: undefined, fn() {} } as Record<string, unknown>, {});
  const recordingPort = (): { port: JobPort; seen: unknown[] } => {
    const seen: unknown[] = [];
    const port = { submit: (_id: string, args: unknown) => (seen.push(args), 'r1'), awaitJob: async () => ({ ok: true }), cancel() {}, dispose() {} } as unknown as JobPort;
    return { port, seen };
  };

  it('negative control: a raw proxy fails structuredClone', () => {
    expect(() => structuredClone(stateProxy())).toThrow();
  });

  it('a state proxy is deep-copied to plain data that structuredClone accepts', () => {
    const { port, seen } = recordingPort();
    bindJobVerb({ port }).job('cpu', { state: stateProxy(), level: 1 }, () => {});
    const args = seen[0] as { state: unknown };
    expect(structuredClone(args)).toEqual({ state: { board: [1, 2, { k: 'x' }], turn: 3 }, level: 1 });
  });

  it('the hook form copies too; binary data and a cycle are left alone', () => {
    const { port, seen } = recordingPort();
    const bytes = new Uint8Array([1, 2]);
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    const { job } = bindJobVerb({ port });
    job('cpu', { p: stateProxy(), bytes }, 'hook');
    expect((seen[0] as { bytes: unknown }).bytes).toBe(bytes);
    expect(() => structuredClone(seen[0])).not.toThrow();
    job('cpu', cyclic, () => {});
    expect(seen[1]).toBe(cyclic);
  });
});
