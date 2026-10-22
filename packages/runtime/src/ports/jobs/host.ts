import type {
  JobContext,
  JobError,
  JobHostOptions,
  JobOptions,
  JobPauseGate,
  JobPort,
  JobResult,
  JobWorkerEvent,
  WorkerLike,
} from './types.ts';
import { createWorkerPool, type WorkerSlot } from './pool.ts';

type State = 'queued' | 'running' | 'done';
const PRIORITY = { high: 0, normal: 1, low: 2 } as const;
const KEEP_FINISHED = 256;

interface Request {
  requestId: string;
  jobId: string;
  args: unknown;
  options: JobOptions;
  callback: ((result: JobResult) => void) | undefined;
  state: State;
  attempt: number;
  startedAt: number;
  seq: number;
  slot: WorkerSlot | undefined;
  /** The attempt ended through the worker's own answer, so the worker is healthy and reusable. */
  clean: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  /** pausable deadlines: the budget left, when the timer was armed, and what it does on expiry */
  remainingMs: number;
  armedAt: number;
  expire: (() => void) | undefined;
  /** Set when this attempt already ended (a late worker event must not end it twice). */
  settled: boolean;
  awaiters: Array<(result: JobResult) => void>;
  followers: Request[];
}

/** a settable pause signal (see JobHostOptions.pause) */
export function createJobPauseGate(initial = false): JobPauseGate {
  let paused = initial;
  const listeners = new Set<(paused: boolean) => void>();
  return {
    paused: () => paused,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    set(next) {
      if (next === paused) return;
      paused = next;
      for (const l of [...listeners]) l(next);
    },
  };
}

export function createJobHost(host: JobHostOptions): JobPort {
  const now = host.now ?? Date.now;
  const defaultDeadline = host.defaultDeadlineMs ?? 30_000;
  const poolSize = Math.max(0, Math.floor(host.poolSize ?? 0));
  const maxConcurrent = Math.max(1, poolSize > 0 ? Math.min(poolSize, host.maxConcurrent ?? poolSize) : (host.maxConcurrent ?? 4));
  const pool = createWorkerPool(host.createWorker, poolSize);
  const active = new Map<string, Request>();
  const byDedupe = new Map<string, Request>();
  const finished = new Map<string, JobResult>();
  const queue: Request[] = [];
  let running = 0;
  let nextId = 1;
  let seq = 0;
  const pauseSource = host.pause;

  const guard = (fn: () => void, jobId: string): void => {
    try {
      fn();
    } catch (error) {
      host.onCallbackError?.(error, jobId);
    }
  };

  function fail(req: Request, code: string, message: string, extra: Partial<JobError> = {}): JobResult {
    return {
      ok: false,
      error: { message, code, attempts: req.attempt, retriable: false, ...extra },
      durationMs: now() - req.startedAt,
    };
  }

  function releaseSlot(req: Request): void {
    const slot = req.slot;
    req.slot = undefined;
    if (slot) pool.release(slot, req.clean);
  }

  function finish(req: Request, result: JobResult): void {
    if (req.state === 'done') return;
    const wasRunning = req.state === 'running';
    req.state = 'done';
    req.settled = true;
    if (req.timer !== undefined) clearTimeout(req.timer);
    req.timer = undefined;
    releaseSlot(req);
    if (wasRunning) running -= 1;
    const at = queue.indexOf(req);
    if (at >= 0) queue.splice(at, 1);
    if (req.options.dedupeKey !== undefined && byDedupe.get(req.options.dedupeKey) === req) {
      byDedupe.delete(req.options.dedupeKey);
    }
    for (const r of [req, ...req.followers]) {
      active.delete(r.requestId);
      r.state = 'done';
      finished.set(r.requestId, result);
      const callback = r.callback;
      // Results always arrive on a later turn, whatever the path that produced them.
      queueMicrotask(() => {
        if (callback) guard(() => callback(result), r.jobId);
        for (const wake of r.awaiters) wake(result);
        r.awaiters = [];
      });
    }
    while (finished.size > KEEP_FINISHED) finished.delete(finished.keys().next().value as string);
    pump();
  }

  function retryOrFinish(req: Request, result: JobResult): void {
    const retries = req.options.retries ?? 0;
    if (result.error?.retriable && req.attempt <= retries && req.state !== 'done') {
      if (req.timer !== undefined) clearTimeout(req.timer);
      req.timer = undefined;
      releaseSlot(req);
      running -= 1;
      req.state = 'queued';
      req.attempt += 1;
      enqueue(req);
      pump();
      return;
    }
    finish(req, result);
  }

  function enqueue(req: Request): void {
    queue.push(req);
    queue.sort(
      (a, b) =>
        PRIORITY[a.options.priority ?? 'normal'] - PRIORITY[b.options.priority ?? 'normal'] || a.seq - b.seq,
    );
  }

  function pump(): void {
    while (running < maxConcurrent) {
      const next = queue.shift();
      if (!next) return;
      start(next);
    }
  }

  function arm(req: Request): void {
    if (req.expire === undefined) return;
    req.armedAt = now();
    req.timer = setTimeout(req.expire, Math.max(0, req.remainingMs));
    (req.timer as { unref?: () => void }).unref?.();
  }

  function onPauseChange(paused: boolean): void {
    for (const req of active.values()) {
      if (req.state !== 'running' || req.expire === undefined) continue;
      if (paused && req.timer !== undefined) {
        clearTimeout(req.timer);
        req.timer = undefined;
        req.remainingMs -= now() - req.armedAt;
      } else if (!paused && req.timer === undefined) {
        arm(req);
      }
    }
  }
  const unsubscribePause = pauseSource?.subscribe(onPauseChange);

  function start(req: Request): void {
    req.state = 'running';
    req.settled = false;
    req.clean = false;
    running += 1;
    const deadlineMs = req.options.deadlineMs ?? defaultDeadline;
    const job: JobContext = { id: req.jobId, requestId: req.requestId, attempt: req.attempt, deadlineMs };

    const attemptAt = req.attempt;
    const settle = (result: JobResult): void => {
      if (req.settled || req.attempt !== attemptAt || req.state !== 'running') return;
      req.settled = true;
      retryOrFinish(req, result);
    };
    req.remainingMs = deadlineMs;
    req.expire = () => {
      settle(
        fail(req, 'deadline_exceeded', `job ${req.jobId} passed its ${deadlineMs} ms deadline`, {
          deadlineExceeded: true,
          retriable: true,
        }),
      );
    };
    if (!pauseSource?.paused()) arm(req);

    const builtin = host.builtins?.[req.jobId];
    if (builtin) {
      void (async () => {
        try {
          const data = await builtin(req.args, job);
          settle({ ok: true, data, durationMs: now() - req.startedAt });
        } catch (error) {
          settle(fail(req, 'job_failed', error instanceof Error ? error.message : String(error)));
        }
      })();
      return;
    }

    const moduleUrl = host.resolveModule(req.jobId);
    if (moduleUrl === null) {
      settle(fail(req, 'job_not_found', `no job named ${req.jobId}`));
      return;
    }
    let slot: WorkerSlot;
    try {
      slot = pool.acquire();
    } catch (error) {
      settle(fail(req, 'worker_unavailable', error instanceof Error ? error.message : String(error), { retriable: true }));
      return;
    }
    req.slot = slot;
    slot.onEvent = (event: JobWorkerEvent) => {
      if (event.requestId !== req.requestId || req.state !== 'running' || req.attempt !== attemptAt) return;
      if (event.type === 'part') {
        const onPart = req.options.onPart;
        if (onPart) guard(() => onPart(event.part), req.jobId);
      } else if (event.type === 'result') {
        req.clean = true;
        settle({ ok: true, data: event.data, durationMs: now() - req.startedAt });
      } else {
        req.clean = true;
        settle(fail(req, event.code ?? 'job_failed', event.message));
      }
    };
    slot.onCrash = (error) => {
      settle(fail(req, 'worker_crashed', error.message, { retriable: true }));
    };
    try {
      slot.worker.postMessage({ type: 'run', requestId: req.requestId, moduleUrl, args: req.args, job });
    } catch (error) {
      req.clean = true;
      settle(fail(req, 'bad_arguments', error instanceof Error ? error.message : String(error)));
    }
  }

  return {
    submit(jobId, args, options = {}, callback) {
      const requestId = `job-${nextId++}`;
      const req: Request = {
        requestId,
        jobId,
        args,
        options,
        callback,
        state: 'queued',
        attempt: 1,
        startedAt: now(),
        seq: seq++,
        slot: undefined,
        clean: false,
        timer: undefined,
        remainingMs: 0,
        armedAt: 0,
        expire: undefined,
        settled: false,
        awaiters: [],
        followers: [],
      };
      active.set(requestId, req);
      const key = options.dedupeKey;
      const primary = key === undefined ? undefined : byDedupe.get(key);
      if (primary && primary.state !== 'done') {
        primary.followers.push(req);
        return requestId;
      }
      if (key !== undefined) byDedupe.set(key, req);
      enqueue(req);
      // Start on a later turn so a synchronous failure still reaches the callback asynchronously.
      queueMicrotask(pump);
      return requestId;
    },

    awaitJob<T>(requestId: string): Promise<JobResult<T>> {
      const done = finished.get(requestId);
      if (done) return Promise.resolve(done as JobResult<T>);
      const req = active.get(requestId);
      if (!req) {
        return Promise.resolve({
          ok: false,
          error: { message: `unknown job request ${requestId}`, code: 'unknown_request', attempts: 0, retriable: false },
          durationMs: 0,
        });
      }
      return new Promise((resolve) => req.awaiters.push(resolve as (r: JobResult) => void));
    },

    cancel(requestId) {
      const req = active.get(requestId);
      if (!req) return false;
      if (req.state === 'done') return false;
      // A follower only detaches itself; the shared run goes on for the others.
      for (const other of active.values()) {
        const at = other.followers.indexOf(req);
        if (at >= 0) {
          other.followers.splice(at, 1);
          const result = fail(req, 'cancelled', 'cancelled');
          active.delete(requestId);
          req.state = 'done';
          finished.set(requestId, result);
          queueMicrotask(() => {
            if (req.callback) guard(() => req.callback!(result), req.jobId);
            for (const wake of req.awaiters) wake(result);
          });
          return true;
        }
      }
      finish(req, fail(req, 'cancelled', 'cancelled'));
      return true;
    },

    init() {
      try {
        pool.warm();
        for (const jobId of host.warmJobs ?? []) {
          const moduleUrl = host.resolveModule(jobId);
          if (moduleUrl !== null) pool.eachIdle((slot) => slot.worker.postMessage({ type: 'warm', moduleUrl }));
        }
      } catch (error) {
        host.onCallbackError?.(error, 'init');
      }
      return Promise.resolve();
    },

    dispose() {
      for (const req of [...active.values()]) {
        if (req.state !== 'done') finish(req, fail(req, 'cancelled', 'the job host was disposed'));
      }
      unsubscribePause?.();
      pool.dispose();
    },
  };
}
