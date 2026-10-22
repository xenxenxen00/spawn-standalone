// geometry-worker.ts (job protocol) and geometry-service.ts (pool, longest-first queue, key cache, colliderFor, eviction)
// (render §6.3, §6.4; docs/architecture.md §3.0 GeometryService).
import { describe, expect, it } from 'vitest';
import type { GeometryContext, ScriptedSpec } from '../../../../src/render/geometry/generator-types.ts';
import { keyOf } from '../../../../src/render/geometry/generator-types.ts';
import {
  createInProcessExecutor,
  createJobRunner,
  moduleLoaderFromIndex,
  serveJobs,
  type FromWorker,
  type GenJob,
  type ModuleLoader,
  type ToWorker,
} from '../../../../src/render/geometry/geometry-worker.ts';
import {
  costLookup,
  GeometryServiceImpl,
  geometryWorkerBudget,
  WorkerPoolExecutor,
  type JobExecutor,
  type WorkerLike,
} from '../../../../src/render/geometry/geometry-service.ts';
import { packedKeyTransfers, type PackedKey } from '../../../../src/render/geometry/pack.ts';

// ── fixture generators ─────────────────────────────────────────────────────────────────────────────────────────────

const runs: string[] = [];
const MODULES: Record<string, unknown> = {
  'scripts/gen/box.js': {
    geometry(ctx: GeometryContext) {
      runs.push(`box:${ctx.lod}`);
      const s = Number(ctx.params['s'] ?? 1);
      ctx.color('oklch(0.5 0.1 30)');
      ctx.quad(0, 0, 0, s, 0, 0, s, s, 0, 0, s, 0);
      if (ctx.lod === 1) ctx.tri(0, 0, 1, s, 0, 1, 0, s, 1);
    },
    collider(ctx: GeometryContext) {
      runs.push('box:collider');
      return { kind: 'box', width: Number(ctx.params['s'] ?? 1), height: 1, depth: 1 };
    },
  },
  'scripts/gen/soup.js': {
    geometry(ctx: GeometryContext) {
      ctx.smooth();
      ctx.tri(0, 0, 0, 1, 0, 0, 0, 1, 0);
      return { uvs: [0, 0, 1, 0, 0, 1] };
    },
  },
  'scripts/gen/throws.js': {
    geometry() {
      throw new Error('generator exploded');
    },
  },
  'scripts/gen/not-a-generator.js': { onSpawn() {} },
};
const load: ModuleLoader = async (script) => {
  const m = MODULES[script];
  if (!m) throw new Error(`unknown generator script ${script}`);
  return m;
};
const spec = (script: string, params: Record<string, unknown> = {}, seed?: number): ScriptedSpec =>
  seed === undefined ? { kind: 'scripted', script, params } : { kind: 'scripted', script, params, seed };
const job = (id: number, s: ScriptedSpec, lods: GenJob['lods'], collider = false): GenJob => ({
  id,
  script: s.script,
  params: s.params,
  seed: s.seed,
  lods,
  collider,
});

/** An in-memory worker: structured-clones every message with its transfer list, like postMessage does. */
class FakeWorker implements WorkerLike {
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  terminated = false;
  posted: ToWorker[] = [];
  private listeners: Array<(ev: { data: unknown }) => void> = [];
  constructor(loader: ModuleLoader = load) {
    const scope = {
      postMessage: (msg: unknown, transfer: ArrayBuffer[]) => {
        const data = structuredClone(msg, { transfer });
        setTimeout(() => this.onmessage?.({ data }), 0);
      },
      addEventListener: (_type: 'message', fn: (ev: { data: unknown }) => void) => this.listeners.push(fn),
    };
    serveJobs(scope, loader);
  }
  postMessage(msg: unknown, transfer: ArrayBuffer[] = []): void {
    this.posted.push(msg as ToWorker);
    const data = structuredClone(msg, { transfer });
    setTimeout(() => {
      for (const l of this.listeners) l({ data });
    }, 0);
  }
  terminate(): void {
    this.terminated = true;
  }
}

describe('geometry-worker job runner', () => {
  it('runs the requested LODs (in order) and the collider, keyed by keyOf', async () => {
    runs.length = 0;
    const run = createJobRunner(load, { strict: true });
    const s = spec('/scripts/gen/box.js', { s: 2 }, 3);
    const key = await run(job(1, s, [5, 1, 3], true));
    expect(key.key).toBe(keyOf(s));
    expect(key.script).toBe('scripts/gen/box.js');
    expect(key.lods.map((l) => l.lod)).toEqual([5, 1, 3]);
    expect(key.lods.map((l) => l.tris)).toEqual([2, 3, 2]);
    expect(key.collider).toEqual({ box: [2, 1, 1] });
    expect(runs).toEqual(['box:5', 'box:1', 'box:3', 'box:collider']);
    expect(key.ms).toBeGreaterThanOrEqual(0);
    const noCollider = await run(job(2, s, [1]));
    expect('collider' in noCollider).toBe(false);
    const colliderOnly = await run(job(3, spec('scripts/gen/soup.js'), [], true));
    expect(colliderOnly.lods).toEqual([]);
    expect(colliderOnly.collider && 'tris' in colliderOnly.collider ? colliderOnly.collider.tris.length : 0).toBe(9);
  });

  it('rejects unknown scripts, non-generator modules and generator errors with the script named', async () => {
    const run = createJobRunner(load, { strict: true });
    await expect(run(job(1, spec('scripts/gen/missing.js'), [1]))).rejects.toThrow(/missing\.js/);
    await expect(run(job(2, spec('scripts/gen/not-a-generator.js'), [1]))).rejects.toThrow(/not-a-generator\.js.*geometry/);
    await expect(run(job(3, spec('scripts/gen/throws.js'), [1]))).rejects.toThrow(/throws\.js.*generator exploded/);
  });

  it('lists every buffer once in the transfer list', async () => {
    const key = await createJobRunner(load)(job(1, spec('scripts/gen/soup.js'), [1, 3], true));
    const buffers = packedKeyTransfers(key);
    // per LOD: vtx, idx, paints, normals, uvs; plus the collider soup
    expect(buffers).toHaveLength(2 * 5 + 1);
    expect(new Set(buffers).size).toBe(buffers.length);
  });

  it('serves jobs over a message scope and transfers the buffers', async () => {
    const replies: Array<{ msg: FromWorker; transfer: ArrayBuffer[] }> = [];
    let listener: ((ev: { data: unknown }) => void) | undefined;
    serveJobs(
      {
        postMessage: (msg, transfer) => replies.push({ msg: msg as FromWorker, transfer }),
        addEventListener: (_t, fn) => {
          listener = fn;
        },
      },
      load,
    );
    listener!({ data: { type: 'config', strict: true } satisfies ToWorker });
    listener!({ data: { type: 'job', job: job(7, spec('scripts/gen/box.js'), [1], true) } satisfies ToWorker });
    listener!({ data: { type: 'job', job: job(8, spec('scripts/gen/throws.js'), [1]) } satisfies ToWorker });
    await new Promise((r) => setTimeout(r, 10));
    expect(replies.map((r) => r.msg.type)).toEqual(['done', 'error']);
    const done = replies[0]!.msg;
    expect(done.type === 'done' && done.id).toBe(7);
    expect(replies[0]!.transfer.length).toBe(3);
    const err = replies[1]!.msg;
    expect(err.type === 'error' && err.id).toBe(8);
    expect(err.type === 'error' && err.error.message).toMatch(/generator exploded/);
  });

  it('resolves tree-rooted scripts through a glob index', async () => {
    const loader = moduleLoaderFromIndex({ '/game/scripts/gen/box.js': async () => MODULES['scripts/gen/box.js'] }, '/game/');
    expect(await loader('scripts/gen/box.js')).toBe(MODULES['scripts/gen/box.js']);
    await expect(loader('scripts/gen/none.js')).rejects.toThrow(/unknown generator script scripts\/gen\/none\.js/);
  });
});

describe('worker budget', () => {
  it('splits max(2, cores - 1) between KTX2 and the geometry pool (render §6.3)', () => {
    expect(geometryWorkerBudget(4)).toEqual({ total: 3, ktx2: 1, geometry: 2 });
    expect(geometryWorkerBudget(16)).toEqual({ total: 15, ktx2: 2, geometry: 4 });
    expect(geometryWorkerBudget(8)).toEqual({ total: 7, ktx2: 2, geometry: 4 });
    expect(geometryWorkerBudget(2)).toEqual({ total: 2, ktx2: 1, geometry: 1 });
    expect(geometryWorkerBudget(1)).toEqual({ total: 2, ktx2: 1, geometry: 1 });
  });
});

/** An executor that records the job order and runs jobs one at a time, in-process. */
class RecordingExecutor implements JobExecutor {
  readonly size = 1;
  order: Array<{ script: string; lods: number[]; collider: boolean; runtime: boolean }> = [];
  private inner = createInProcessExecutor(load, { strict: true });
  async run(j: GenJob, p: { runtime: boolean; cost: number }): Promise<PackedKey> {
    const r = this.inner.run(j, p);
    this.order.push({ script: j.script, lods: [...j.lods], collider: j.collider, runtime: p.runtime });
    return r;
  }
  dispose(): void {}
}

describe('WorkerPoolExecutor', () => {
  it('runs the longest queued job first, runtime requests before prefetch', async () => {
    const workers: FakeWorker[] = [];
    const pool = new WorkerPoolExecutor(() => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    }, 1);
    const order: number[] = [];
    const run = (id: number, cost: number, runtime = false): Promise<void> =>
      pool.run(job(id, spec('scripts/gen/box.js', { s: id }), [1]), { runtime, cost }).then(() => {
        order.push(id);
      });
    await Promise.all([run(1, 5), run(2, 1), run(3, 50), run(4, 10), run(5, 0, true), run(6, 30)]);
    // job 1 starts at once (idle pool); then runtime 5, then 3 (50), 6 (30), 4 (10), 2 (1)
    expect(order).toEqual([1, 5, 3, 6, 4, 2]);
    expect(workers).toHaveLength(1);
    expect(workers[0]!.posted[0]).toEqual({ type: 'config', strict: false });
    pool.dispose();
    expect(workers[0]!.terminated).toBe(true);
  });

  it('fails a job that cannot be posted and keeps serving the queue', async () => {
    const pool = new WorkerPoolExecutor(() => new FakeWorker(), 1);
    const bad = { ...job(2, spec('scripts/gen/box.js'), [1]), params: { f: () => 1 } };
    const first = pool.run(job(1, spec('scripts/gen/box.js'), [1]), { runtime: false, cost: 0 });
    const failed = pool.run(bad, { runtime: false, cost: 0 });
    const after = pool.run(job(3, spec('scripts/gen/box.js', { s: 2 }), [1]), { runtime: false, cost: 0 });
    await expect(failed).rejects.toThrow(/cannot post the job/);
    expect((await first).lods[0]!.tris).toBe(3);
    expect((await after).lods[0]!.tris).toBe(3);
    pool.dispose();
  });

  it('rejects the in-flight job of a crashed worker and replaces the worker', async () => {
    let n = 0;
    const pool = new WorkerPoolExecutor(() => {
      const w = new FakeWorker();
      if (n++ === 0) {
        w.postMessage = () => setTimeout(() => w.onerror?.({ message: 'script error' }), 0);
      }
      return w;
    }, 1);
    await expect(pool.run(job(1, spec('scripts/gen/box.js'), [1]), { runtime: false, cost: 0 })).rejects.toThrow(/worker failed/);
    const ok = await pool.run(job(2, spec('scripts/gen/box.js'), [1]), { runtime: false, cost: 0 });
    expect(ok.lods[0]!.tris).toBe(3);
    pool.dispose();
  });

  it('counts a worker that cannot be constructed as a failed start, retries, and rejects the queue once every slot gave up', async () => {
    let n = 0;
    const flaky = new WorkerPoolExecutor(() => {
      if (n++ === 0) throw new Error('SecurityError: worker blocked');
      return new FakeWorker();
    }, 1);
    // the first construction throws: the job stays queued and runs on the next worker
    expect((await flaky.run(job(1, spec('scripts/gen/box.js'), [1]), { runtime: false, cost: 0 })).lods[0]!.tris).toBe(3);
    expect(n).toBe(2);
    flaky.dispose();

    let attempts = 0;
    const dead = new WorkerPoolExecutor(() => {
      attempts++;
      throw new Error('SecurityError: worker blocked');
    }, 2, { maxFailures: 2 });
    const a = dead.run(job(1, spec('scripts/gen/box.js'), [1]), { runtime: false, cost: 0 });
    const b = dead.run(job(2, spec('scripts/gen/box.js'), [1]), { runtime: false, cost: 0 });
    await expect(a).rejects.toThrow(/every worker failed to start/);
    await expect(b).rejects.toThrow(/every worker failed to start/);
    expect(attempts).toBe(4);
    expect(dead.pending).toBe(0);
    dead.dispose();
  });
});

describe('GeometryServiceImpl', () => {
  it('requests packed keys, reuses cached LODs and generates only the missing ones', async () => {
    const ex = new RecordingExecutor();
    const svc = new GeometryServiceImpl({ executor: ex });
    const s = spec('scripts/gen/box.js', { s: 1 });
    const a = await svc.request(s, [3, 5]);
    expect(a.lods.map((l) => l.lod)).toEqual([3, 5]);
    const b = await svc.request(s, [1, 3, 5]);
    expect(b.lods.map((l) => l.lod)).toEqual([1, 3, 5]);
    expect(b.lods[1]).toBe(a.lods[0]);
    await svc.request(s, [5]);
    expect(ex.order.map((o) => o.lods)).toEqual([[3, 5], [1]]);
    expect(ex.order.every((o) => o.runtime)).toBe(true);
    // concurrent identical requests share one job
    const s2 = spec('scripts/gen/box.js', { s: 2 });
    const [c, d] = await Promise.all([svc.request(s2, [1]), svc.request(s2, [1])]);
    expect(c.lods[0]).toBe(d.lods[0]);
    expect(ex.order).toHaveLength(3);
  });

  it('answers colliderFor once per key and colliderForSync from memory', async () => {
    const ex = new RecordingExecutor();
    const svc = new GeometryServiceImpl({ executor: ex });
    const s = spec('scripts/gen/box.js', { s: 4 });
    expect(svc.colliderForSync(s)).toBeUndefined();
    const [c1, c2] = await Promise.all([svc.colliderFor(s), svc.colliderFor(s)]);
    expect(c1).toEqual({ box: [4, 1, 1] });
    expect(c2).toBe(c1);
    expect(svc.colliderForSync(s)).toBe(c1);
    expect(ex.order.filter((o) => o.collider)).toHaveLength(1);
    // X-43: baked runtime keys answer synchronously without a job
    const shard = spec('scripts/gen/kit/doorwreck.js', { part: 'shard', seed: 3 });
    svc.registerColliders([{ key: keyOf(shard), collider: { box: [0.3, 0.6, 0.1] } }]);
    expect(svc.colliderForSync(shard)).toEqual({ box: [0.3, 0.6, 0.1] });
    expect(await svc.colliderFor(shard)).toEqual({ box: [0.3, 0.6, 0.1] });
    expect(ex.order.filter((o) => o.collider)).toHaveLength(1);
  });

  it('prefetches a place longest first, reports progress and survives a failing key', async () => {
    const ex = new RecordingExecutor();
    const errors: string[] = [];
    const svc = new GeometryServiceImpl({
      executor: ex,
      cost: costLookup({ keys: { [keyOf(spec('scripts/gen/box.js', { s: 9 }))]: 900 }, scripts: { 'scripts/gen/soup.js': 50 } }),
      onError: (e) => errors.push(e.message),
    });
    const keys = [spec('scripts/gen/box.js', { s: 1 }), spec('scripts/gen/soup.js'), spec('scripts/gen/box.js', { s: 9 }), spec('scripts/gen/throws.js'), spec('scripts/gen/box.js', { s: 1 })];
    const progress: Array<[number, number]> = [];
    await svc.prefetchPlace(keys, [3, 5], (d, t) => progress.push([d, t]), 'gallow-farm');
    expect(progress.at(-1)).toEqual([4, 4]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/throws\.js/);
    // unknown cost first (FIFO among them), then 900 ms, then 50 ms
    expect(ex.order.map((o) => o.script)).toEqual(['scripts/gen/box.js', 'scripts/gen/throws.js', 'scripts/gen/box.js', 'scripts/gen/soup.js']);
    expect(ex.order.every((o) => !o.runtime)).toBe(true);
    await expect(svc.request(spec('scripts/gen/throws.js'), [3])).rejects.toThrow(/generator exploded/);
    // cached: no new job
    await svc.request(spec('scripts/gen/box.js', { s: 9 }), [3, 5]);
    expect(ex.order).toHaveLength(4);
  });

  it('evicts a place, keeps keys another place still uses, and keeps at most maxPlaces places', async () => {
    const ex = new RecordingExecutor();
    const svc = new GeometryServiceImpl({ executor: ex, maxPlaces: 2 });
    const shared = spec('scripts/gen/box.js', { s: 1 });
    const onlyA = spec('scripts/gen/box.js', { s: 2 });
    await svc.prefetchPlace([shared, onlyA], [5], () => {}, 'a');
    await svc.prefetchPlace([shared], [5], () => {}, 'b');
    expect(ex.order).toHaveLength(2);
    svc.evictPlace('a');
    await svc.request(shared, [5]);
    expect(ex.order).toHaveLength(2);
    await svc.request(onlyA, [5]);
    expect(ex.order).toHaveLength(3);
    // b, c, d: b is the least recently used place and leaves when d arrives
    const onlyB = spec('scripts/gen/box.js', { s: 3 });
    await svc.prefetchPlace([onlyB], [5], () => {}, 'b');
    await svc.prefetchPlace([spec('scripts/gen/box.js', { s: 4 })], [5], () => {}, 'c');
    await svc.prefetchPlace([spec('scripts/gen/box.js', { s: 5 })], [5], () => {}, 'd');
    expect(svc.places()).toEqual(['c', 'd']);
    const before = ex.order.length;
    await svc.request(onlyB, [5]);
    expect(ex.order.length).toBe(before + 1);
    svc.dispose();
  });

  it('runs end to end over the fake worker pool with real structured-clone transfers', async () => {
    const pool = new WorkerPoolExecutor(() => new FakeWorker(), 2);
    const svc = new GeometryServiceImpl({ executor: pool });
    const keys = Array.from({ length: 12 }, (_, i) => spec('scripts/gen/box.js', { s: i + 1 }));
    let last: [number, number] = [0, 0];
    await svc.prefetchPlace(keys, [1, 3, 5], (d, t) => {
      last = [d, t];
    });
    expect(last).toEqual([12, 12]);
    const k = await svc.request(keys[5]!, [1, 3, 5]);
    expect(k.lods.map((l) => l.tris)).toEqual([3, 2, 2]);
    expect(k.lods[0]!.vtx.byteLength).toBeGreaterThan(0);
    svc.dispose();
  });
});
