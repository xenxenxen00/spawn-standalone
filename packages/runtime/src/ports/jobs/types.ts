// JobPort: the host behind the game-facing `ctx.job` / `ctx.awaitJob` verbs.
//
// Documented behaviour this port implements (engine 6.0.0 api-reference.md "Jobs" and
// platform-systems.md; the older build documents the same calls, minus `onPart`):
//   ctx.job(jobId, args, callback?, options?)   -> requestId (a string, returned synchronously)
//   ctx.job(jobId, args, hookExport, payload?)  -> requestId (the result goes to an exported hook)
//   ctx.awaitJob(requestId)                     -> Promise<JobResult>
//   callback(result): JobResult = { ok, data?, error?: JobError, durationMs }, NEVER thrown: failures
//     arrive as { ok: false, error }, always asynchronously
//   JobError = { message, code?, retriable?, attempts, deadlineExceeded?, details? }
//   options = { priority?: "low"|"normal"|"high", deadlineMs?, dedupeKey?, retries?, onPart? }
//   jobs/<id>.js exports `run(job, args)` (sync or async); an `async function* run` yields parts to
//     `onPart`, and its return value is the final `data`. This host's `job` argument is
//     { id, requestId, attempt, deadlineMs }; the docs do not describe the real one.
//
// ABSENT in this host (the platform offers them, a local standalone does not):
//   - the engine's own jobs: llm:chat, llm:generate, llm:clear, jev:decide, mail:send, chat:send,
//     chat:history, player:token, text:check, image:generate, image:segment. They answer
//     `{ ok: false, error: { code: "job_not_found" } }` unless the host registers `builtins` for them
//     (a game that guards with `if (!ctx.job)` or checks `r.ok` falls back, as Crown & Clash does)
//   - `fetch` / `WebSocket` feeds inside a job: the worker is a plain worker, so whether `fetch`
//     works is whatever the browser or node allows; there is no public-internet-only filter and no
//     private-host block, and no http/https allowlist
//   - `player:token` (a signed JWT proving the player to the creator's service)
//   - platform deduplication across machines, billing and quotas: `dedupeKey` only coalesces
//     in-flight requests inside this host

export interface JobError {
  message: string;
  code?: string;
  retriable?: boolean;
  attempts: number;
  deadlineExceeded?: boolean;
  details?: unknown;
}

export interface JobResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: JobError;
  durationMs: number;
}

export interface JobOptions {
  /** Queue order when jobs wait for a free worker. Default "normal". */
  priority?: 'low' | 'normal' | 'high';
  /** Per-call watchdog; the worker is terminated when it passes. Default: the host's `defaultDeadlineMs`. */
  deadlineMs?: number;
  /** A second request with the same key, while the first is in flight, shares its result. */
  dedupeKey?: string;
  /** Extra attempts after a retriable failure (deadline or worker crash). Default 0. */
  retries?: number;
  onPart?: (part: unknown) => void;
}

/** What the module's `run` receives as its first argument. */
export interface JobContext {
  id: string;
  requestId: string;
  attempt: number;
  deadlineMs: number;
}

export interface JobRunRequest {
  type: 'run';
  requestId: string;
  moduleUrl: string;
  args: unknown;
  job: JobContext;
}

/** Loads a job module in an idle worker and runs its optional `init()` once, ahead of the first call. */
export interface JobWarmRequest {
  type: 'warm';
  moduleUrl: string;
}

export type JobWorkerEvent =
  | { type: 'part'; requestId: string; part: unknown }
  | { type: 'result'; requestId: string; data: unknown }
  | { type: 'error'; requestId: string; message: string; code?: string };

/** The slice of a Worker the host needs, so browser and node workers and test fakes all fit. */
export interface WorkerLike {
  postMessage(message: JobRunRequest | JobWarmRequest): void;
  onMessage(listener: (event: JobWorkerEvent) => void): void;
  /** The worker crashed or exited before answering. */
  onError(listener: (error: { message: string }) => void): void;
  terminate(): void | Promise<unknown>;
}

export type WorkerFactory = () => WorkerLike;

/** a pause signal a job host follows (`createJobPauseGate` makes a settable one) */
export interface JobPauseSource {
  paused(): boolean;
  /** called on every change; returns the unsubscribe */
  subscribe(listener: (paused: boolean) => void): () => void;
}

/** a settable JobPauseSource: the game passes it to `createJobHost({ pause })` and to `composeGame({ ports: { jobPause } })`, which drives it */
export interface JobPauseGate extends JobPauseSource {
  set(paused: boolean): void;
}

export interface JobHostOptions {
  /** Maps a job id to the URL the worker can `import()` for `jobs/<id>.js`; null = no such job. */
  resolveModule(jobId: string): string | null;
  createWorker: WorkerFactory;
  /** Main-thread handlers for engine job ids the host chooses to provide (all absent by default). */
  builtins?: Record<string, (args: unknown, job: JobContext) => unknown>;
  /** Watchdog when a call passes no `deadlineMs`. Default 30000. */
  defaultDeadlineMs?: number;
  /** Workers running at once; the rest queue by priority. Default 4. */
  maxConcurrent?: number;
  /**
   * Warm worker pool size. 0 (default) starts a fresh worker per call and terminates it afterwards.
   * With N > 0 up to N workers are kept and reused (concurrency is capped at N); a worker that
   * crashed, timed out or was cancelled is terminated and replaced. Crown & Clash uses 2.
   */
  poolSize?: number;
  /** Job ids whose modules `init()` loads (and whose optional `init()` export runs) in every warm worker. */
  warmJobs?: string[];
  now?: () => number;
  /**
   * Opt-in: deadlines count game time. While `pause.paused()` is true the running jobs' deadline timers are held and re-armed with
   * the time they had left when it turns false. Default none: deadlines are wall-clock (a pause does not stop them).
   */
  pause?: JobPauseSource;
  /** A result callback or onPart threw. The host swallows it so one game bug cannot stop the queue. */
  onCallbackError?: (error: unknown, jobId: string) => void;
}

export interface JobPort {
  /** Starts a job. Returns the request id at once; the callback runs later, never in this call. */
  submit(jobId: string, args: Record<string, unknown>, options?: JobOptions, callback?: (result: JobResult) => void): string;
  /** Resolves with the result of a request (also one already finished). Unknown ids resolve ok: false. */
  awaitJob<T = unknown>(requestId: string): Promise<JobResult<T>>;
  /** Not in the docs: stops a queued or running request, which answers `code: "cancelled"`. */
  cancel(requestId: string): boolean;
  /** Starts the pool's workers ahead of the first call (no-op without a pool). */
  init?(): Promise<void>;
  /** Cancels everything and terminates every worker. */
  dispose(): void;
}
