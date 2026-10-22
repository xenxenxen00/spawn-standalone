// The geometry worker (render §6.4; WP R2): runs live generators through the recorder and returns packed keys.
//
// Three hosts share one code path (`createJobRunner`):
//   browser   this file is the module-worker entry of the pool in `geometry-service.ts`
//             (`new Worker(new URL('./geometry-worker.ts', import.meta.url), { type: 'module' })`); generators load through
//             the lazy `import.meta.glob` index below, so each map parses only the modules its rows name. Generator modules
//             exist only in this bundle and in Node tools, never on the main thread (X-26, chunk-graph test).
//   Node      `tools/render/geometry-check.ts` wires `serveJobs` to a `worker_threads` port (the Node-vs-worker hash
//             check), and `createInProcessExecutor` runs jobs in-process for tools, tests and headless runs.
// Never import this module from main-thread browser code: it would pull the generator index into that chunk.
//
// Protocol: the pool posts `{ type: 'config', strict }` once, then one `{ type: 'job', job }` at a time; the worker answers
// `{ type: 'done', id, key }` with every buffer of the key in the transfer list, or `{ type: 'error', id, error }`.
// A `{ type: 'chunk', id, job }` message (render §6.5, WP R3) asks for the merged chunks of a `ChunkJob`: the worker generates
// the keys the chunk's rows name, cuts the cell into parts (`map-plan.ts` `partitionChunk`), merges each part per LOD
// (`chunk-merge.ts`) and answers `{ type: 'chunks', id, chunks }` by transfer. A `{ type: 'far', id, job }` message (DR-35
// lever 4) asks for the merge of already packed chunks into one far mesh; the answer is a `chunks` message with that one chunk.
import { type GeneratorModule, type LodLevel, isGeneratorModule, isLodLevel, keyOf, normalizeScript } from './generator-types.ts';
import { mergeChunkParts, mergePackedChunks, packedChunkTransfers, type ChunkJob, type FarJob, type MergeRow, type PackedChunk } from './chunk-merge.ts';
import { partitionChunk, transformedAabb } from './map-plan.ts';
import { packCollider, packedKeyTransfers, packMesh, type PackedKey, type PackedLod, type PackOptions } from './pack.ts';
import { type Diagnostics, type RecorderOptions, runCollider, runGeometry } from './recorder.ts';
import type { JobExecutor, JobPriority } from './geometry-service.ts';
import type { RigDef } from '../../compat/motion/rig.ts';
import { moduleRig, type SkeletonSpec } from '../rig/skeleton.ts';

export interface GenJob {
  id: number;
  script: string;
  params: unknown;
  seed: unknown;
  /** generated in this order; may be empty for a collider-only job */
  lods: LodLevel[];
  collider: boolean;
}

export interface SerializedError {
  name: string;
  message: string;
  stack?: string | undefined;
  script: string;
}

export type ToWorker = { type: 'config'; strict: boolean; rigs?: boolean; vertexColors?: boolean; albedoTints?: PackOptions['albedoTints'] } | { type: 'job'; job: GenJob } | { type: 'chunk'; id: number; job: ChunkJob } | { type: 'far'; id: number; job: FarJob };
export type FromWorker =
  | { type: 'done'; id: number; key: PackedKey }
  | { type: 'chunks'; id: number; chunks: PackedChunk[] }
  | { type: 'error'; id: number; error: SerializedError };

/** Loads a generator module by its tree-rooted script path (authored content). */
export type ModuleLoader = (script: string) => Promise<unknown>;

export interface JobRunnerOptions extends PackOptions {
  /** throw on unsupported generator returns (dev builds and tools); production logs through `diag` and ignores them */
  strict?: boolean;
  /** K10b: accept a returned `{ colors }` (per-vertex RGBA); default false */
  vertexColors?: boolean;
  /**
   * K3: run a module's `skeleton()` (once per script), give its runs `ctx.bone` and pack a bone per vertex; the key carries
   * the parsed skeleton (`PackedKey.skeleton`). Default false: `skeleton()` is never called, as in the legacy host
   */
  rigs?: boolean;
  diag?: Diagnostics;
}

export class GeneratorError extends Error {
  override name = 'GeneratorError';
  readonly script: string;
  constructor(script: string, message: string, cause?: unknown) {
    super(`${script}: ${message}`, cause === undefined ? undefined : { cause });
    this.script = script;
  }
}

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/** Runs one job: imports the module (cached by the loader), runs each LOD and the collider, packs them. */
export function createJobRunner(load: ModuleLoader, opts: JobRunnerOptions = {}): (job: GenJob) => Promise<PackedKey> {
  const modules = new Map<string, Promise<GeneratorModule>>();
  /** K3: one rig per script, built when its module loads (`opts.rigs`) */
  const rigs = new Map<string, { spec: SkeletonSpec; rig: RigDef }>();
  const moduleFor = (script: string): Promise<GeneratorModule> => {
    let m = modules.get(script);
    if (!m) {
      m = load(script).then(
        (mod) => {
          if (!isGeneratorModule(mod)) throw new GeneratorError(script, 'module does not export geometry(ctx)');
          if (opts.rigs && typeof mod.skeleton === 'function') {
            let r;
            try {
              r = moduleRig(script, mod);
            } catch (e) {
              throw new GeneratorError(script, `skeleton(): ${e instanceof Error ? e.message : String(e)}`, e);
            }
            if (r) rigs.set(script, r);
          }
          return mod;
        },
        (e: unknown) => {
          throw new GeneratorError(script, `cannot load: ${e instanceof Error ? e.message : String(e)}`, e);
        },
      );
      modules.set(script, m);
    }
    return m;
  };
  const recOpts: RecorderOptions = {};
  if (opts.strict !== undefined) recOpts.strict = opts.strict;
  if (opts.diag) recOpts.diag = opts.diag;
  if (opts.vertexColors) recOpts.vertexColors = true;
  return async (job) => {
    const script = normalizeScript(job.script);
    const spec = { kind: 'scripted', script, params: job.params, seed: job.seed };
    const mod = await moduleFor(script);
    const t0 = now();
    const key: PackedKey = { key: keyOf(spec), script, lods: [], ms: 0 };
    const rigged = rigs.get(script);
    const runOpts: RecorderOptions = rigged ? { ...recOpts, rig: rigged.rig } : recOpts;
    if (rigged) key.skeleton = rigged.spec;
    for (const lod of job.lods) {
      if (!isLodLevel(lod)) throw new GeneratorError(script, `invalid lod ${String(lod)}`);
      const l0 = now();
      let packed;
      try {
        packed = packMesh(runGeometry(mod, spec, lod, runOpts), opts);
      } catch (e) {
        throw new GeneratorError(script, `geometry(lod ${lod}): ${e instanceof Error ? e.message : String(e)}`, e);
      }
      packed.ms = now() - l0;
      key.lods.push(packed);
    }
    if (job.collider) {
      const c0 = now();
      try {
        key.collider = packCollider(runCollider(mod, spec, runOpts));
      } catch (e) {
        throw new GeneratorError(script, `collider: ${e instanceof Error ? e.message : String(e)}`, e);
      }
      key.colliderMs = now() - c0;
    }
    key.ms = now() - t0;
    return key;
  };
}

/** generated keys a chunk runner keeps for the next chunk job */
const RECENT_KEYS = 48;

/**
 * Builds the merged chunks of a job (render §6.5): each distinct key of the job's rows is generated once at the job's LODs,
 * the cell is cut into parts on the rows' world boxes and their triangles at the finest LOD (`partitionChunk`; one part
 * without `job.split`), then the merge runs per part and LOD, in the order of `job.lods`, with one paint list for the job
 * (`mergeChunkParts`). Runs where `run` runs: in a worker, or in-process under Node.
 */
export function createChunkRunner(run: (job: GenJob) => Promise<PackedKey>): (job: ChunkJob) => Promise<PackedChunk[]> {
  // A key whose rows fall into several chunks is generated once per chunk job (measured: 11 to 175 extra generations per map
  // on `high`, up to half of the merged keys on `low`, where the instanced keys merge too). The keys this runner generated
  // last stay here, so a worker that gets two chunks sharing a key generates it once. Their buffers are never transferred
  // (a chunk reply carries only merged buffers).
  const recent = new Map<string, Promise<PackedKey>>();
  return async (job) => {
    const lodsId = job.lods.join(',');
    const perRow: Array<Promise<PackedKey>> = [];
    for (const row of job.rows) {
      const id = `${keyOf(row.spec)}|${lodsId}`;
      let p = recent.get(id);
      if (p) recent.delete(id);
      else {
        p = run({ id: 0, script: row.spec.script, params: row.spec.params, seed: row.spec.seed, lods: job.lods, collider: false });
        p.catch(() => recent.delete(id));
      }
      recent.set(id, p);
      perRow.push(p);
    }
    while (recent.size > RECENT_KEYS) recent.delete(recent.keys().next().value as string);
    const packed = await Promise.all(perRow);
    const lodOf = (i: number, lod: LodLevel): PackedLod => {
      const l: PackedLod | undefined = packed[i]!.lods.find((x) => x.lod === lod);
      if (!l) throw new GeneratorError(job.rows[i]!.spec.script, `chunk ${job.chunk}: lod ${lod} was not generated`);
      return l;
    };
    // the partition reads each row's box and triangles at the finest LOD of the job
    const finest = job.lods.reduce((a, b) => (b < a ? b : a), job.lods[0] ?? 5);
    const parts = partitionChunk(
      job.chunk,
      job.rows.map((row, i) => {
        const l = lodOf(i, finest);
        const box = transformedAabb(l.bboxMin, l.bboxMax, row.m);
        return { min: box.min, max: box.max, tris: l.tris };
      }),
      job.split,
    );
    // one paint list for the job's parts and LODs: its meshes share one block of the map paint table
    return mergeChunkParts(
      job.chunk,
      parts.map((part) => ({
        label: part.label,
        rows: part.rows,
        levels: job.lods.map((lod) => ({ lod, rows: part.rows.map((i): MergeRow => ({ lod: lodOf(i, lod), m: job.rows[i]!.m, castShadow: job.rows[i]!.castShadow !== false })) })),
      })),
    );
  };
}

export function serializeError(e: unknown, script: string): SerializedError {
  if (e instanceof Error) return { name: e.name, message: e.message, stack: e.stack, script };
  return { name: 'Error', message: String(e), script };
}

/** A worker global scope or a Node `worker_threads` port adapted to it. */
export interface WorkerScopeLike {
  postMessage(msg: unknown, transfer: ArrayBuffer[]): void;
  addEventListener(type: 'message', fn: (ev: { data: unknown }) => void): void;
}

/** Answers pool messages on `scope`, one job at a time in arrival order. */
export function serveJobs(scope: WorkerScopeLike, load: ModuleLoader, opts: JobRunnerOptions = {}): void {
  let run = createJobRunner(load, opts);
  let runChunks = createChunkRunner(run);
  let chain: Promise<void> = Promise.resolve();
  scope.addEventListener('message', (ev) => {
    const msg = ev.data as ToWorker;
    if (msg.type === 'config') {
      run = createJobRunner(load, { ...opts, strict: msg.strict, ...(msg.rigs ? { rigs: true } : {}), ...(msg.vertexColors ? { vertexColors: true } : {}), ...(msg.albedoTints ? { albedoTints: msg.albedoTints } : {}) });
      runChunks = createChunkRunner(run);
      return;
    }
    if (msg.type === 'chunk') {
      const { id, job } = msg;
      const chunker = runChunks;
      chain = chain.then(async () => {
        try {
          const chunks = await chunker(job);
          const reply: FromWorker = { type: 'chunks', id, chunks };
          scope.postMessage(reply, packedChunkTransfers(chunks));
        } catch (e) {
          const reply: FromWorker = { type: 'error', id, error: serializeError(e, `chunk ${job.chunk} of ${job.place}`) };
          scope.postMessage(reply, []);
        }
      });
      return;
    }
    if (msg.type === 'far') {
      const { id, job } = msg;
      chain = chain.then(() => {
        try {
          const merged = mergePackedChunks(job.far, job.members);
          const reply: FromWorker = { type: 'chunks', id, chunks: [merged] };
          scope.postMessage(reply, packedChunkTransfers([merged]));
        } catch (e) {
          const reply: FromWorker = { type: 'error', id, error: serializeError(e, `far group ${job.far} of ${job.place}`) };
          scope.postMessage(reply, []);
        }
      });
      return;
    }
    if (msg.type !== 'job') return;
    const job = msg.job;
    const runner = run;
    chain = chain.then(async () => {
      try {
        const key = await runner(job);
        const reply: FromWorker = { type: 'done', id: job.id, key };
        scope.postMessage(reply, packedKeyTransfers(key));
      } catch (e) {
        const reply: FromWorker = { type: 'error', id: job.id, error: serializeError(e, job.script) };
        scope.postMessage(reply, []);
      }
    });
  });
}

/** Runs jobs on the calling thread (Node tools, tests, headless soak, `tools/maps/bake-place.ts`). */
export function createInProcessExecutor(load: ModuleLoader, opts: JobRunnerOptions = {}): JobExecutor {
  const run = createJobRunner(load, opts);
  const chunks = createChunkRunner(run);
  let chain: Promise<unknown> = Promise.resolve();
  return {
    size: 1,
    run(job: GenJob, _priority: JobPriority): Promise<PackedKey> {
      const p = chain.then(() => run(job));
      chain = p.catch(() => undefined);
      return p;
    },
    runChunks(job: ChunkJob, _priority: JobPriority): Promise<PackedChunk[]> {
      const p = chain.then(() => chunks(job));
      chain = p.catch(() => undefined);
      return p;
    },
    runFar(job: FarJob, _priority: JobPriority): Promise<PackedChunk> {
      const p = chain.then(() => mergePackedChunks(job.far, job.members));
      chain = p.catch(() => undefined);
      return p;
    },
    dispose(): void {},
  };
}

/** A loader over a lazy glob index keyed by root-relative paths (`/content/shapes/x.js` for prefix `/content/`). */
export function moduleLoaderFromIndex(index: Record<string, () => Promise<unknown>>, prefix: string): ModuleLoader {
  return (script) => {
    const imp = index[`${prefix}${normalizeScript(script)}`];
    if (!imp) return Promise.reject(new Error(`unknown generator script ${normalizeScript(script)}`));
    return imp();
  };
}

/** Optional generator root restrictions (see `moduleLoaderFromModules`). */
export interface ModuleIndexOptions {
  /** tree-path prefixes a generator may live under (`['scripts/hall/', 'scripts/halloween/']`); absent: any module of the index */
  roots?: readonly string[];
}

/** A loader over host-provided tree-path modules, optionally restricted to generator roots. */
export function moduleLoaderFromModules(modules: Record<string, () => Promise<unknown>>, opts: ModuleIndexOptions = {}): ModuleLoader {
  const byPath = new Map<string, () => Promise<unknown>>();
  for (const [k, v] of Object.entries(modules)) byPath.set(normalizeScript(k), v);
  const roots = opts.roots?.map((r) => normalizeScript(r));
  return (script) => {
    const name = normalizeScript(script);
    const imp = roots !== undefined && !roots.some((r) => name.startsWith(r)) ? undefined : byPath.get(name);
    if (!imp) return Promise.reject(new Error(`unknown generator script ${name}`));
    return imp();
  };
}

/** `serveJobs` on the worker's own scope over a module index (`moduleLoaderFromModules`): the body of a game's worker entry. */
export function serveGeneratorModules(modules: Record<string, () => Promise<unknown>>, opts: ModuleIndexOptions & JobRunnerOptions = {}, scope: WorkerScopeLike = globalThis as unknown as WorkerScopeLike): void {
  const { roots, ...runner } = opts;
  serveJobs(scope, moduleLoaderFromModules(modules, roots === undefined ? {} : { roots }), runner);
}
