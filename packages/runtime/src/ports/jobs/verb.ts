import type { JobOptions, JobPort, JobResult } from './types.ts';

/** `ctx.job` in both documented shapes. Returns the request id synchronously. */
export interface JobVerb {
  (jobId: string, args: Record<string, unknown>, callback?: (result: JobResult) => void, options?: JobOptions): string;
  (jobId: string, args: Record<string, unknown>, hookExport: string, payload?: unknown): string;
}

export interface BindJobVerbOptions {
  port: JobPort;
  /**
   * Delivers a result to the exported hook named by `ctx.job(id, args, hookExport, payload)`. The
   * docs name the call shape but not the hook's signature, so the runtime decides: this adapter
   * hands over (hookExport, result, payload). Without it the hook form still runs the job and the
   * result is available through awaitJob only.
   */
  dispatchHook?: (hookExport: string, result: JobResult, payload: unknown) => void;
}

export interface BoundJobVerbs {
  job: JobVerb;
  awaitJob<T = unknown>(requestId: string): Promise<JobResult<T>>;
}

/**
 * Deep-copies job arguments to plain, structured-clone-safe data. A sim VM hands the verb state proxies (sandbox views over
 * the world), which `postMessage` refuses, so the job would fail as `bad_arguments`. JSON semantics: own enumerable string keys,
 * `toJSON` honoured, functions / symbols / undefined dropped from objects (null in arrays). Binary data (typed arrays,
 * ArrayBuffer) and Dates pass through. A cycle or an exotic value that cannot be copied returns the argument as it came, so
 * the worker post reports it.
 */
export function toPlainArgs<T>(value: T): T {
  try {
    return copy(value, new Set()) as T;
  } catch {
    return value;
  }
}

function copy(v: unknown, path: Set<unknown>): unknown {
  if (v === null || typeof v !== 'object') return typeof v === 'function' || typeof v === 'symbol' ? undefined : v;
  if (v instanceof Date || v instanceof ArrayBuffer || ArrayBuffer.isView(v)) return v;
  if (path.has(v)) throw new TypeError('cyclic job arguments');
  path.add(v);
  try {
    const toJSON = (v as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === 'function') return copy((toJSON as () => unknown).call(v), path);
    if (Array.isArray(v)) return Array.from({ length: v.length }, (_, i) => copy(v[i], path) ?? null);
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) {
      const c = copy((v as Record<string, unknown>)[k], path);
      if (c !== undefined) out[k] = c;
    }
    return out;
  } finally {
    path.delete(v);
  }
}

export function bindJobVerb(options: BindJobVerbOptions): BoundJobVerbs {
  const { port, dispatchHook } = options;
  const job = ((jobId: string, args: Record<string, unknown>, third?: unknown, fourth?: unknown): string => {
    const input = typeof args === 'object' && args !== null ? toPlainArgs(args) : {};
    if (typeof third === 'string') {
      const hook = third;
      return port.submit(jobId, input, {}, (result) => dispatchHook?.(hook, result, fourth));
    }
    const callback = typeof third === 'function' ? (third as (result: JobResult) => void) : undefined;
    const opts = (callback ? fourth : (third ?? fourth)) as JobOptions | undefined;
    return port.submit(jobId, input, typeof opts === 'object' && opts !== null ? opts : {}, callback);
  }) as JobVerb;
  return { job, awaitJob: (requestId) => port.awaitJob(requestId) };
}
