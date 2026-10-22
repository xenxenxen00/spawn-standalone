// GeometryService (docs/architecture.md §3.0; render §6.3, §6.4; WP R2): the worker pool, a longest-first job queue, the
// packed-key cache per place and `colliderFor`. Engine-free and generator-free: it is created by the app shell at boot
// (boot chunk, build §3.4) and handed to the renderer and the physics port. Generators run only in the worker bundle
// (`geometry-worker.ts`) or, under Node, in-process through `createInProcessExecutor` (tools, tests, headless runs).
//
// This module imports only types from `geometry-worker.ts`: a value import would pull the generator index into the boot
// chunk (X-26).
import { type LodLevel, type ScriptedSpec, keyOf, normalizeScript } from './generator-types.ts';
import type { ChunkJob, FarJob, PackedChunk } from './chunk-merge.ts';
import type { FromWorker, GenJob, SerializedError, ToWorker, ModuleLoader, JobRunnerOptions } from './geometry-worker.ts';
import type { PackedCollider, PackedKey, PackedLod, PackOptions } from './pack.ts';

/** The frozen cross-domain interface (docs/architecture.md §3.0). `GeometryServiceImpl` adds `buildChunks` (render §6.4). */
export interface GeometryService {
  prefetchPlace(keys: ScriptedSpec[], lods: LodLevel[], onProgress: (d: number, t: number) => void): Promise<void>;
  request(spec: ScriptedSpec, lods: LodLevel[]): Promise<PackedKey>;
  colliderFor(spec: ScriptedSpec): Promise<PackedKey['collider']>;
  evictPlace(place: string): void;
}

/** Runtime requests (params writes, door wrecks, the scripted row material) go before prefetch; then the longest job first. */
export interface JobPriority {
  runtime: boolean;
  /** expected ms (gen-cost.json); Infinity when unknown, so an unknown long key never starts last */
  cost: number;
}

export interface JobExecutor {
  readonly size: number;
  run(job: GenJob, priority: JobPriority): Promise<PackedKey>;
  /** merged chunks of a job, built where the generators run (render §6.5); an executor without it cannot serve `buildChunks` */
  runChunks?(job: ChunkJob, priority: JobPriority): Promise<PackedChunk[]>;
  /** the far mesh of a group of packed chunks (DR-35 lever 4), merged where the generators run; optional like `runChunks` */
  runFar?(job: FarJob, priority: JobPriority): Promise<PackedChunk>;
  dispose(): void;
}

/** The part of a web `Worker` (or an adapted Node `worker_threads` Worker) the pool uses. */
export interface WorkerLike {
  postMessage(msg: unknown, transfer?: ArrayBuffer[]): void;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  terminate(): void;
}

/**
 * The one page-wide worker budget (render §6.3): `max(2, cores − 1)` threads; the KTX2 transcoder gets 2 of them from 6 up
 * (else 1; build §3.4 reads this value), the geometry pool `min(4, budget − KTX2)`.
 */
export function geometryWorkerBudget(hardwareConcurrency: number): { total: number; ktx2: number; geometry: number } {
  const cores = Number.isFinite(hardwareConcurrency) && hardwareConcurrency > 0 ? Math.floor(hardwareConcurrency) : 4;
  const total = Math.max(2, cores - 1);
  const ktx2 = total >= 6 ? 2 : 1;
  return { total, ktx2, geometry: Math.max(1, Math.min(4, total - ktx2)) };
}

export class GeometryJobError extends Error {
  override name = 'GeometryJobError';
  readonly script: string;
  constructor(script: string, message: string) {
    super(message);
    this.script = script;
  }
}

function fromSerialized(e: SerializedError): GeometryJobError {
  const err = new GeometryJobError(e.script, e.message);
  if (e.stack) err.stack = e.stack;
  return err;
}

interface Queued {
  /** the id the worker's reply carries */
  id: number;
  /** what an error names: the generator script, or the chunk */
  script: string;
  msg: ToWorker;
  priority: JobPriority;
  seq: number;
  resolve: (reply: FromWorker) => void;
  reject: (e: Error) => void;
}

interface Slot {
  worker: WorkerLike | null;
  current: Queued | null;
  failures: number;
}

/** before(a, b): runtime first, then the higher cost, then FIFO */
const before = (a: Queued, b: Queued): boolean => {
  if (a.priority.runtime !== b.priority.runtime) return a.priority.runtime;
  if (a.priority.cost !== b.priority.cost) return a.priority.cost > b.priority.cost;
  return a.seq < b.seq;
};

export interface PoolOptions {
  /** sent to every worker as `{ type: 'config', strict }` (dev builds: true) */
  strict?: boolean;
  /** K3: sent as `config.rigs`: workers run `skeleton()` and pack a bone per vertex (`JobRunnerOptions.rigs`); default false */
  rigs?: boolean;
  /** K10b: sent as `config.vertexColors`: workers accept a returned `{ colors }` and pack a RGBA per vertex (`JobRunnerOptions.vertexColors`); default false */
  vertexColors?: boolean;
  /** sent as `config.albedoTints`: the packed colour of a part on a named albedo texture is multiplied by the texture mean (`PackOptions.albedoTints`, `measureAlbedoTints`); default absent */
  albedoTints?: PackOptions['albedoTints'];
  /** consecutive worker failures per slot before the slot stops respawning (default 3) */
  maxFailures?: number;
}

/** A fixed-size pool of geometry workers, one job in flight per worker, spawned lazily. */
export class WorkerPoolExecutor implements JobExecutor {
  readonly size: number;
  private readonly spawn: () => WorkerLike;
  private readonly strict: boolean;
  private readonly rigs: boolean;
  private readonly vertexColors: boolean;
  private readonly albedoTints: PackOptions['albedoTints'];
  private readonly maxFailures: number;
  private readonly slots: Slot[];
  private queue: Queued[] = [];
  private seq = 0;
  private disposed = false;

  constructor(spawn: () => WorkerLike, size: number, opts: PoolOptions = {}) {
    this.spawn = spawn;
    this.size = Math.max(1, Math.floor(size));
    this.strict = opts.strict ?? false;
    this.rigs = opts.rigs ?? false;
    this.vertexColors = opts.vertexColors ?? false;
    this.albedoTints = opts.albedoTints;
    this.maxFailures = opts.maxFailures ?? 3;
    this.slots = Array.from({ length: this.size }, () => ({ worker: null, current: null, failures: 0 }));
  }

  private post(id: number, script: string, msg: ToWorker, priority: JobPriority): Promise<FromWorker> {
    if (this.disposed) return Promise.reject(new Error('geometry pool disposed'));
    return new Promise<FromWorker>((resolve, reject) => {
      this.queue.push({ id, script, msg, priority, seq: this.seq++, resolve, reject });
      this.pump();
    });
  }

  run(job: GenJob, priority: JobPriority): Promise<PackedKey> {
    return this.post(job.id, job.script, { type: 'job', job }, priority).then((reply) => {
      if (reply.type !== 'done') throw new GeometryJobError(job.script, `geometry worker answered a key job with "${reply.type}"`);
      return reply.key;
    });
  }

  /** A whole chunk in one worker: generation of its keys, the merge and the requantisation (render §6.5). */
  runChunks(job: ChunkJob, priority: JobPriority): Promise<PackedChunk[]> {
    const id = nextJobId++;
    const what = `chunk ${job.chunk} of ${job.place}`;
    return this.post(id, what, { type: 'chunk', id, job }, priority).then((reply) => {
      if (reply.type !== 'chunks') throw new GeometryJobError(what, `geometry worker answered a chunk job with "${reply.type}"`);
      return reply.chunks;
    });
  }

  /**
   * The far mesh of a group: the members are structured-cloned to the worker (no transfer: the caller keeps drawing from
   * them), the merge and the requantisation run there, the result comes back by transfer.
   */
  runFar(job: FarJob, priority: JobPriority): Promise<PackedChunk> {
    const id = nextJobId++;
    const what = `far group ${job.far} of ${job.place}`;
    return this.post(id, what, { type: 'far', id, job }, priority).then((reply) => {
      if (reply.type !== 'chunks' || reply.chunks.length !== 1) throw new GeometryJobError(what, `geometry worker answered a far job with "${reply.type}"`);
      return reply.chunks[0]!;
    });
  }

  /** queued plus in-flight jobs */
  get pending(): number {
    return this.queue.length + this.slots.filter((s) => s.current).length;
  }

  private pump(): void {
    for (const slot of this.slots) {
      while (this.queue.length > 0 && !slot.current) {
        if (!slot.worker) {
          if (slot.failures >= this.maxFailures) break;
          try {
            slot.worker = this.start(slot);
          } catch {
            // the Worker constructor threw (blocked by CSP, unsupported module workers): a failed start, like onerror
            slot.failures++;
            continue;
          }
        }
        let best = 0;
        for (let i = 1; i < this.queue.length; i++) if (before(this.queue[i]!, this.queue[best]!)) best = i;
        const next = this.queue.splice(best, 1)[0]!;
        try {
          slot.worker.postMessage(next.msg);
          slot.current = next;
        } catch (e) {
          // an un-cloneable job (DataCloneError): fail this job, keep the worker and try the next one
          next.reject(new GeometryJobError(next.script, `cannot post the job: ${e instanceof Error ? e.message : String(e)}`));
        }
      }
      if (this.queue.length === 0) return;
    }
    if (this.queue.length > 0 && this.slots.every((s) => !s.worker && s.failures >= this.maxFailures)) {
      const err = new Error('geometry workers unavailable: every worker failed to start');
      for (const q of this.queue.splice(0)) q.reject(err);
    }
  }

  private start(slot: Slot): WorkerLike {
    const w = this.spawn();
    w.onmessage = (ev) => {
      if (slot.worker !== w) return;
      const msg = ev.data as FromWorker;
      const cur = slot.current;
      if (!cur || cur.id !== msg.id) return;
      slot.current = null;
      slot.failures = 0;
      if (msg.type === 'error') cur.reject(fromSerialized(msg.error));
      else cur.resolve(msg);
      this.pump();
    };
    w.onerror = (ev) => {
      if (slot.worker !== w) return;
      const why = typeof ev === 'object' && ev !== null && 'message' in ev ? String((ev as { message: unknown }).message) : String(ev);
      slot.worker = null;
      slot.failures++;
      try {
        w.terminate();
      } catch {
        // already gone
      }
      const cur = slot.current;
      slot.current = null;
      cur?.reject(new GeometryJobError(cur.script, `geometry worker failed: ${why}`));
      this.pump();
    };
    const config: ToWorker = { type: 'config', strict: this.strict, ...(this.rigs ? { rigs: true } : {}), ...(this.vertexColors ? { vertexColors: true } : {}), ...(this.albedoTints ? { albedoTints: this.albedoTints } : {}) };
    w.postMessage(config);
    return w;
  }

  dispose(): void {
    this.disposed = true;
    const err = new Error('geometry pool disposed');
    for (const q of this.queue.splice(0)) q.reject(err);
    for (const slot of this.slots) {
      slot.current?.reject(err);
      slot.current = null;
      slot.worker?.terminate();
      slot.worker = null;
    }
  }
}

/** Expected job cost (ms) of a key, from `gen-cost.json`; undefined when unknown. */
export type CostLookup = (key: string, script: string) => number | undefined;

/** The ordering part of `gen-cost.json` (`tools/render/geometry-check.ts`): ms per key and the mean per script. */
export interface GenCostTable {
  keys?: Readonly<Record<string, number>>;
  scripts?: Readonly<Record<string, number>>;
}

export function costLookup(table: GenCostTable): CostLookup {
  return (key, script) => table.keys?.[key] ?? table.scripts?.[script];
}

export interface GeometryServiceOptions {
  executor: JobExecutor;
  cost?: CostLookup;
  /** places whose packed keys stay cached (LRU): 2 on high/medium, 1 on low/minimum (render §6.4) */
  maxPlaces?: number;
  /** keys requested outside any place (runtime spawns, params writes) kept in an LRU of this size */
  maxRuntimeKeys?: number;
  /** a key that failed during a prefetch (the prefetch itself resolves; requests for the key reject) */
  onError?: (error: Error, key: string) => void;
}

interface Entry {
  readonly key: string;
  readonly script: string;
  readonly params: unknown;
  readonly seed: unknown;
  readonly lods: Map<LodLevel, PackedLod>;
  readonly pending: Map<LodLevel, Promise<void>>;
  collider: PackedCollider | undefined;
  colliderPending: Promise<PackedCollider> | undefined;
  failed: Error | undefined;
  colliderFailed: Error | undefined;
  readonly places: Set<string>;
  /** K3: the module's parsed skeleton, from the first job that carried one */
  skeleton?: PackedKey['skeleton'];
}

let nextJobId = 1;

function snapshot(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  try {
    return structuredClone(v);
  } catch {
    return v;
  }
}

export class GeometryServiceImpl implements GeometryService {
  private readonly executor: JobExecutor;
  private readonly cost: CostLookup | undefined;
  private readonly maxPlaces: number;
  private readonly maxRuntimeKeys: number;
  private readonly onError: ((error: Error, key: string) => void) | undefined;
  private readonly entries = new Map<string, Entry>();
  /** place → its keys; Map order is the LRU order (least recently prefetched first) */
  private readonly placeKeys = new Map<string, Set<string>>();
  private readonly runtimeKeys = new Map<string, true>();
  /** X-43: colliders baked into the place's `ColliderPack.runtimeKeys` */
  private readonly registered = new Map<string, PackedCollider>();

  constructor(opts: GeometryServiceOptions) {
    this.executor = opts.executor;
    this.cost = opts.cost;
    this.maxPlaces = Math.max(1, opts.maxPlaces ?? 2);
    this.maxRuntimeKeys = Math.max(1, opts.maxRuntimeKeys ?? 256);
    this.onError = opts.onError;
  }

  private entry(spec: ScriptedSpec): Entry {
    const key = keyOf(spec);
    let e = this.entries.get(key);
    if (!e) {
      e = {
        key,
        script: normalizeScript(spec.script),
        // a snapshot: the caller may rewrite its primitive.params later (door damage stages), the key must not drift
        params: snapshot(spec.params),
        seed: spec.seed,
        lods: new Map(),
        pending: new Map(),
        collider: undefined,
        colliderPending: undefined,
        failed: undefined,
        colliderFailed: undefined,
        places: new Set(),
      };
      this.entries.set(key, e);
    }
    return e;
  }

  private priority(e: Entry, runtime: boolean): JobPriority {
    const c = this.cost?.(e.key, e.script);
    return { runtime, cost: c === undefined || !Number.isFinite(c) ? Infinity : c };
  }

  private job(e: Entry, lods: LodLevel[], collider: boolean): GenJob {
    return { id: nextJobId++, script: e.script, params: e.params, seed: e.seed, lods, collider };
  }

  /** Resolves when every LOD of `lods` is cached on `e`; one job generates the missing ones. */
  private ensure(e: Entry, lods: LodLevel[], runtime: boolean): Promise<void> {
    if (e.failed) return Promise.reject(e.failed);
    const waits: Promise<void>[] = [];
    const missing: LodLevel[] = [];
    for (const l of lods) {
      if (e.lods.has(l)) continue;
      const p = e.pending.get(l);
      if (p) waits.push(p);
      else if (!missing.includes(l)) missing.push(l);
    }
    if (missing.length > 0) {
      const p = this.executor.run(this.job(e, missing, false), this.priority(e, runtime)).then(
        (key) => {
          for (const l of key.lods) e.lods.set(l.lod, l);
          if (key.skeleton) e.skeleton = key.skeleton;
          for (const l of missing) e.pending.delete(l);
        },
        (err: unknown) => {
          for (const l of missing) e.pending.delete(l);
          e.failed = err instanceof Error ? err : new Error(String(err));
          throw e.failed;
        },
      );
      for (const l of missing) e.pending.set(l, p);
      waits.push(p);
    }
    return waits.length === 0 ? Promise.resolve() : Promise.all(waits).then(() => undefined);
  }

  private view(e: Entry, lods: LodLevel[]): PackedKey {
    const out: PackedKey = { key: e.key, script: e.script, lods: [], ms: 0 };
    for (const l of lods) {
      const lod = e.lods.get(l);
      if (!lod) throw new Error(`geometry service: ${e.key} has no lod ${l}`);
      out.lods.push(lod);
      out.ms += lod.ms;
    }
    if (e.collider !== undefined) out.collider = e.collider;
    if (e.skeleton) out.skeleton = e.skeleton;
    return out;
  }

  private touchRuntime(e: Entry): void {
    this.runtimeKeys.delete(e.key);
    this.runtimeKeys.set(e.key, true);
    while (this.runtimeKeys.size > this.maxRuntimeKeys) {
      const oldest = this.runtimeKeys.keys().next().value as string;
      this.runtimeKeys.delete(oldest);
      const victim = this.entries.get(oldest);
      if (victim && victim.places.size === 0) this.entries.delete(oldest);
    }
  }

  /** Packed LODs of one key; generated on demand (runtime priority), cached by key and LOD. */
  request(spec: ScriptedSpec, lods: LodLevel[]): Promise<PackedKey> {
    const e = this.entry(spec);
    if (e.places.size === 0) this.touchRuntime(e);
    return this.ensure(e, lods, true).then(() => this.view(e, lods));
  }

  /**
   * Generates every key of a place at `lods`, longest first; `onProgress(done, total)` counts settled unique keys. A key
   * that fails is reported through `onError` and does not reject the prefetch. `place` names the cache group that
   * `evictPlace` drops (an extension of the frozen interface; the default group is `'default'`).
   */
  prefetchPlace(keys: ScriptedSpec[], lods: LodLevel[], onProgress: (d: number, t: number) => void, place = 'default'): Promise<void> {
    const set = this.placeKeys.get(place) ?? new Set<string>();
    this.placeKeys.delete(place);
    this.placeKeys.set(place, set);
    const unique: Entry[] = [];
    const seen = new Set<string>();
    for (const spec of keys) {
      const e = this.entry(spec);
      if (seen.has(e.key)) continue;
      seen.add(e.key);
      e.places.add(place);
      set.add(e.key);
      unique.push(e);
    }
    this.enforcePlaceLimit(place);
    const total = unique.length;
    let done = 0;
    const order = unique
      .map((e, i) => ({ e, i, cost: this.priority(e, false).cost }))
      .sort((a, b) => (a.cost !== b.cost ? (a.cost > b.cost ? -1 : 1) : a.i - b.i));
    onProgress(0, total);
    const settle = (): void => {
      done++;
      onProgress(done, total);
    };
    return Promise.all(
      order.map(({ e }) =>
        this.ensure(e, lods, false).then(settle, (err: unknown) => {
          this.onError?.(err instanceof Error ? err : new Error(String(err)), e.key);
          settle();
        }),
      ),
    ).then(() => undefined);
  }

  private enforcePlaceLimit(keep: string): void {
    while (this.placeKeys.size > this.maxPlaces) {
      const oldest = [...this.placeKeys.keys()].find((p) => p !== keep);
      if (oldest === undefined) return;
      this.evictPlace(oldest);
    }
  }

  /** Drops a place's cached keys (keys another place or the runtime LRU still holds stay). */
  evictPlace(place: string): void {
    const set = this.placeKeys.get(place);
    if (!set) return;
    this.placeKeys.delete(place);
    for (const k of set) {
      const e = this.entries.get(k);
      if (!e) continue;
      e.places.delete(place);
      if (e.places.size === 0 && !this.runtimeKeys.has(k)) this.entries.delete(k);
    }
  }

  /**
   * The merged chunks of a `ChunkJob`, one per LOD of `job.lods` (render §6.4, §6.5; an addition to the frozen interface of
   * docs/architecture.md §3.0, which lists it in render §6.4 only). The whole job runs in one worker: generation of the keys
   * the rows name, the merge, the requantisation and the index build; the buffers come back by transfer. Queued longest first
   * by the summed key costs, behind runtime requests.
   */
  buildChunks(job: ChunkJob): Promise<PackedChunk[]> {
    const run = this.executor.runChunks;
    if (run === undefined) return Promise.reject(new Error('geometry service: this executor cannot build chunks'));
    let cost = 0;
    const seen = new Set<string>();
    for (const row of job.rows) {
      const key = keyOf(row.spec);
      if (seen.has(key)) continue;
      seen.add(key);
      const c = this.cost?.(key, normalizeScript(row.spec.script));
      cost += c === undefined || !Number.isFinite(c) ? 0 : c;
    }
    // unknown costs count as 0 here: a chunk of unknown keys must not jump ahead of every measured one
    return run.call(this.executor, job, { runtime: false, cost });
  }

  /**
   * The far mesh of a far group (DR-35 lever 4; `chunk-merge.ts` `mergePackedChunks`): the coarsest level of the group's
   * chunk parts joined into one `PackedChunk` inside a worker. It costs no generation, so it is queued behind the chunk
   * jobs (cost 0) and behind runtime requests.
   */
  buildFar(job: FarJob): Promise<PackedChunk> {
    const run = this.executor.runFar;
    if (run === undefined) return Promise.reject(new Error('geometry service: this executor cannot build far meshes'));
    return run.call(this.executor, job, { runtime: false, cost: 0 });
  }

  /** The key's collider (render §6.4, X-06): runtime-spawned or regenerated rows with `physics`. */
  colliderFor(spec: ScriptedSpec): Promise<PackedCollider> {
    const key = keyOf(spec);
    const reg = this.registered.get(key);
    if (reg !== undefined) return Promise.resolve(reg);
    const e = this.entry(spec);
    if (e.places.size === 0) this.touchRuntime(e);
    if (e.collider !== undefined) return Promise.resolve(e.collider);
    if (e.colliderFailed) return Promise.reject(e.colliderFailed);
    if (e.colliderPending) return e.colliderPending;
    const p = this.executor.run(this.job(e, [], true), this.priority(e, true)).then(
      (k) => {
        e.collider = k.collider ?? null;
        e.colliderPending = undefined;
        return e.collider;
      },
      (err: unknown) => {
        e.colliderPending = undefined;
        e.colliderFailed = err instanceof Error ? err : new Error(String(err));
        throw e.colliderFailed;
      },
    );
    e.colliderPending = p;
    return p;
  }

  /** X-43: the collider from memory (baked runtime keys or an earlier `colliderFor`), else undefined. */
  colliderForSync(spec: ScriptedSpec): PackedCollider | undefined {
    const key = keyOf(spec);
    return this.registered.get(key) ?? this.entries.get(key)?.collider;
  }

  /** X-43: registers the colliders of a place's `ColliderPack.runtimeKeys` (keys are `keyOf` strings). */
  registerColliders(list: Iterable<{ key: string; collider: PackedCollider }>): void {
    for (const { key, collider } of list) this.registered.set(key, collider);
  }

  /** The bbox of a cached LOD (LOD 5 preferred): the provisional box of an unforeseen runtime key (X-43). */
  boundsFor(spec: ScriptedSpec): { min: [number, number, number]; max: [number, number, number] } | undefined {
    const e = this.entries.get(keyOf(spec));
    if (!e) return undefined;
    const lod = e.lods.get(5) ?? [...e.lods.values()].at(-1);
    return lod ? { min: [...lod.bboxMin], max: [...lod.bboxMax] } : undefined;
  }

  /** Cached places, least recently prefetched first. */
  places(): string[] {
    return [...this.placeKeys.keys()];
  }

  stats(): { keys: number; places: number; runtimeKeys: number; bytes: number } {
    let bytes = 0;
    for (const e of this.entries.values()) {
      for (const l of e.lods.values()) bytes += l.vtx.byteLength + l.idx.byteLength + l.paints.byteLength + (l.normals?.byteLength ?? 0) + (l.uvs?.byteLength ?? 0) + (l.colors?.byteLength ?? 0) + (l.skinIndex?.byteLength ?? 0);
      if (e.collider && 'tris' in e.collider) bytes += e.collider.tris.byteLength;
    }
    return { keys: this.entries.size, places: this.placeKeys.size, runtimeKeys: this.runtimeKeys.size, bytes };
  }

  dispose(): void {
    this.executor.dispose();
    this.entries.clear();
    this.placeKeys.clear();
    this.runtimeKeys.clear();
    this.registered.clear();
  }
}

export function createGeometryService(opts: GeometryServiceOptions): GeometryServiceImpl {
  return new GeometryServiceImpl(opts);
}

export interface BrowserGeometryOptions extends Omit<GeometryServiceOptions, 'executor'> {
  /** A host worker entry that installs serveJobs or serveGeneratorModules. */
  createWorker?: () => WorkerLike;
  /** Without a worker entry, run injected generators on the calling thread. */
  loadGenerator?: ModuleLoader;
  /** pool size; default `geometryWorkerBudget(navigator.hardwareConcurrency).geometry` */
  workers?: number;
  /** dev builds: throw on unsupported generator returns (the app passes `import.meta.env.DEV`) */
  strict?: boolean;
  /** K3: procedural rigs in the workers (`PoolOptions.rigs`); default false */
  rigs?: boolean;
  /** K10b: per-vertex colours from `geometry()` in the workers (`PoolOptions.vertexColors`); pair with `InstallBridgeOptions.vertexColors`. Default false */
  vertexColors?: boolean;
  /** `PoolOptions.albedoTints`; default absent */
  albedoTints?: PackOptions['albedoTints'];
}

/** Keep generator execution code out of the worker-host boot chunk. */
function lazyInlineExecutor(load: ModuleLoader, options: JobRunnerOptions): JobExecutor {
  let pending: Promise<JobExecutor> | undefined;
  let disposed = false;
  const get = (): Promise<JobExecutor> => disposed
    ? Promise.reject(new Error('geometry executor disposed'))
    : pending ??= import('./geometry-worker.ts').then((module) => module.createInProcessExecutor(load, options));
  return {
    size: 1,
    run: (job, priority) => get().then((executor) => executor.run(job, priority)),
    runChunks: (job, priority) => get().then((executor) => executor.runChunks!(job, priority)),
    runFar: (job, priority) => get().then((executor) => executor.runFar!(job, priority)),
    dispose() { disposed = true; void pending?.then((executor) => executor.dispose(), () => undefined); },
  };
}

/** A host-provided worker pool, or an inline service over explicitly injected generators. */
export function createBrowserGeometryService(opts: BrowserGeometryOptions = {}): GeometryServiceImpl {
  const { workers, createWorker, loadGenerator, strict, rigs, vertexColors, albedoTints, ...rest } = opts;
  if (createWorker === undefined && loadGenerator === undefined) throw new Error('geometry: supply createWorker with a host worker entry, or loadGenerator for inline execution');
  const options = { strict: strict ?? false, ...(rigs ? { rigs: true } : {}), ...(vertexColors ? { vertexColors: true } : {}), ...(albedoTints ? { albedoTints } : {}) };
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 4;
  const executor = createWorker === undefined
    ? lazyInlineExecutor(loadGenerator!, options)
    : new WorkerPoolExecutor(createWorker, workers ?? geometryWorkerBudget(cores).geometry, options);
  return new GeometryServiceImpl({ ...rest, executor });
}
