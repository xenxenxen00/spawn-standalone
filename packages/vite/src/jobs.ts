// C-5: turns a game's `jobs:` config (or its jobs/<id>.js files) into a Worker module chunk the
// JobPort's browser worker factory can load.
//
//   virtual:ss/job-worker   the Worker program: the job-runner protocol plus one dynamic import per
//                           job id. Each job becomes its own chunk (with the job's own imports
//                           bundled), and none of it lands in the main-thread bundle.
//   virtual:ss/jobs         main thread: `jobIds`, `resolveJobModule(id)` (what `createJobHost`
//                           takes as `resolveModule`: the id itself, or null) and `createJobWorker()`
//                           (a module Worker built by Vite's worker pipeline).
//
// Host wiring: createJobHost({ resolveModule: resolveJobModule, createWorker: () => wrapDomWorker(createJobWorker()) }).
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

export const JOBS_ID = 'virtual:ss/jobs';
export const JOB_WORKER_ID = 'virtual:ss/job-worker';
const RESOLVED = '\0';

export interface JobsPluginOptions {
  /** The converted game's root (its `jobs/` folder lives here). */
  root: string;
  /** The `jobs:` config key: job id to a path relative to `root`. */
  jobs?: Record<string, string>;
  /** Also pick up `jobs/<id>.js` files not named in `jobs`. Default true. */
  discover?: boolean;
  /** The job-runner module the worker program imports. Default: this repo's runtime copy. */
  runnerPath?: string;
}

const toPosix = (p: string): string => p.replaceAll('\\', '/');
const DEFAULT_RUNNER = toPosix(fileURLToPath(import.meta.resolve('@spawn-standalone/runtime/jobs/worker')));

/** Job id -> absolute module path. Explicit config wins over discovery; a missing file is an error. */
export function resolveJobEntries(options: Pick<JobsPluginOptions, 'root' | 'jobs' | 'discover'>): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const [id, rel] of Object.entries(options.jobs ?? {})) {
    const file = toPosix(isAbsolute(rel) ? rel : resolve(options.root, rel));
    if (!existsSync(file)) throw new Error(`jobs.${id}: ${rel} does not exist under ${options.root}`);
    entries[id] = toPosix(realpathSync.native(file));
  }
  const dir = join(options.root, 'jobs');
  if (options.discover !== false && existsSync(dir)) {
    for (const name of readdirSync(dir).sort()) {
      if (!['.js', '.mjs', '.ts'].includes(extname(name))) continue;
      const id = basename(name, extname(name));
      if (!(id in entries)) entries[id] = toPosix(realpathSync.native(join(dir, name)));
    }
  }
  return entries;
}

/** Source of `virtual:ss/job-worker`. */
export function jobWorkerSource(entries: Record<string, string>, runnerPath: string = DEFAULT_RUNNER): string {
  const loaders = Object.entries(entries)
    .map(([id, file]) => `  ${JSON.stringify(id)}: () => import(${JSON.stringify(file)}),`)
    .join('\n');
  return `import { handleRunRequest, handleWarmRequest } from ${JSON.stringify(runnerPath)};
const loaders = {
${loaders}
};
const env = {
  importModule(id) {
    const load = Object.prototype.hasOwnProperty.call(loaders, id) ? loaders[id] : undefined;
    return load ? load() : Promise.reject(new Error('no job module for ' + id));
  },
  post: (message) => globalThis.postMessage(message),
};
globalThis.onmessage = (event) => {
  void (event.data.type === 'warm' ? handleWarmRequest(event.data, env) : handleRunRequest(event.data, env));
};
`;
}

/** Source of `virtual:ss/jobs`. */
export function jobsModuleSource(entries: Record<string, string>): string {
  const ids = Object.keys(entries);
  return `import JobWorker from ${JSON.stringify(`${JOB_WORKER_ID}?worker`)};
export const jobIds = ${JSON.stringify(ids)};
export function resolveJobModule(id) {
  return jobIds.includes(id) ? id : null;
}
export function createJobWorker() {
  return new JobWorker();
}
`;
}

export function ssJobs(options: JobsPluginOptions): Plugin {
  const entries = resolveJobEntries(options);
  const runner = toPosix(options.runnerPath ?? DEFAULT_RUNNER);
  // Vite's dev worker URL must be a file-shaped id; null-byte virtual ids leak into /@fs/ URLs.
  // Use filesystem identities: Windows short names otherwise become unservable Vite import URLs.
  const workerId = toPosix(resolve(realpathSync.native(options.root), '__ss_job-worker__.js'));
  let workerUrl: string | undefined;
  const bare = (id: string): string => id.split('?')[0]!;
  /** The resolve/load half. The worker bundle is a nested build with its own plugin list, so it needs this too. */
  const virtualModules = (): Plugin => ({
    name: 'ss-jobs-virtual',
    enforce: 'pre',
    configResolved(config) {
      const path = toPosix(relative(realpathSync.native(config.root), workerId));
      if (!path.startsWith('../') && !isAbsolute(path)) workerUrl = '/' + path;
    },
    resolveId(id) {
      const path = bare(id);
      if (path === JOB_WORKER_ID || path === workerUrl) return workerId + id.slice(path.length);
      if (path === JOBS_ID) return RESOLVED + id;
      // Vite re-feeds the already-resolved worker entry id to the nested build.
      if (path === workerId || path === RESOLVED + JOBS_ID) return id;
      return null;
    },
    load(id) {
      // A '?worker' import is Vite's own worker plugin's to load; we only resolve its id above.
      if (bare(id) === workerId && !/[?&]worker(?:&|$)/.test(id)) return jobWorkerSource(entries, runner);
      if (id.includes('?')) return null;
      if (!id.startsWith(RESOLVED)) return null;
      const path = id.slice(1);
      if (path === JOBS_ID) return jobsModuleSource(entries);
      return null;
    },
  });
  return {
    ...virtualModules(),
    name: 'ss-jobs',
    config: () => ({
      // Dynamic imports (one chunk per job) need an ES module worker, not Vite's default iife.
      worker: { format: 'es' as const, plugins: () => [virtualModules()] },
    }),
  };
}
