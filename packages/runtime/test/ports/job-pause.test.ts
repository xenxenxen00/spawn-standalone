// Pausable job deadlines: JobHostOptions.pause holds the running jobs' deadline timers while the game is paused.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createJobHost, createJobPauseGate, type JobPauseGate, type JobPort, type JobResult, type JobWorkerEvent, type WorkerLike } from '../../src/ports/index.ts';

/** a worker that never answers until the test says so */
function fakeWorker(): { create: () => WorkerLike; answer: (data: unknown) => void } {
  let listener: ((e: JobWorkerEvent) => void) | undefined;
  let requestId = '';
  return {
    create: () => ({
      postMessage: (m) => void (m.type === 'run' && (requestId = m.requestId)),
      onMessage: (l) => void (listener = l),
      onError: () => {},
      terminate: () => {},
    }),
    answer: (data) => listener?.({ type: 'result', requestId, data }),
  };
}

const hosts: JobPort[] = [];
function setup(pause?: JobPauseGate) {
  const w = fakeWorker();
  const host = createJobHost({ resolveModule: () => 'file:///job.js', createWorker: w.create, ...(pause ? { pause } : {}) });
  hosts.push(host);
  const out: { result?: JobResult } = {};
  const start = (deadlineMs: number): void => void host.submit('j', {}, { deadlineMs }, (r) => (out.result = r));
  return { w, host, out, start };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  while (hosts.length > 0) hosts.pop()!.dispose();
  vi.useRealTimers();
});

describe('pausable job deadline', () => {
  it('a job running through a pause is not timed out early; it expires on game time', async () => {
    const gate = createJobPauseGate();
    const { out, start } = setup(gate);
    start(1000);
    await vi.advanceTimersByTimeAsync(600); // 600 ms of game time used
    gate.set(true);
    await vi.advanceTimersByTimeAsync(60_000); // a long pause: wall time passes, game time does not
    expect(out.result).toBeUndefined();
    gate.set(false);
    await vi.advanceTimersByTimeAsync(300); // 900 of 1000
    expect(out.result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(150);
    expect(out.result?.error).toMatchObject({ code: 'deadline_exceeded', deadlineExceeded: true });
  });

  it('a job that starts while paused begins counting at resume, and can finish while paused', async () => {
    const gate = createJobPauseGate(true);
    const a = setup(gate);
    a.start(500);
    await vi.advanceTimersByTimeAsync(5000);
    expect(a.out.result).toBeUndefined();
    a.w.answer('done');
    await vi.advanceTimersByTimeAsync(0);
    expect(a.out.result).toMatchObject({ ok: true, data: 'done' });
    const b = setup(gate);
    b.start(500);
    await vi.advanceTimersByTimeAsync(5000);
    gate.set(false);
    await vi.advanceTimersByTimeAsync(499);
    expect(b.out.result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(2);
    expect(b.out.result?.error?.code).toBe('deadline_exceeded');
  });

  it('negative: without a pause source the deadline is wall-clock and the same pause times the job out', async () => {
    const { out, start } = setup();
    start(1000);
    await vi.advanceTimersByTimeAsync(600);
    await vi.advanceTimersByTimeAsync(60_000); // the pause that a gate would have held
    expect(out.result?.error).toMatchObject({ code: 'deadline_exceeded' });
  });

  it('dispose unsubscribes from the gate', () => {
    const gate = createJobPauseGate();
    const sub = vi.spyOn(gate, 'subscribe');
    const { host } = setup(gate);
    expect(sub).toHaveBeenCalledOnce();
    host.dispose();
    expect(() => gate.set(true)).not.toThrow();
  });
});
