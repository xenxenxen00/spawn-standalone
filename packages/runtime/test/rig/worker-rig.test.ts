// H4 (INTEGRATION.md): the geometry worker builds one rig per script (`skeleton()` called once per module, behind
// `JobRunnerOptions.rigs` / `config.rigs`), its keys carry the parsed skeleton and a bone per vertex, the geometry service keeps
// the skeleton on its cached views, and the main thread builds one RigDef per script and hands it to the row's mixer once.
import { describe, expect, it } from 'vitest';
import type { RowRec } from '../../src/compat/core/types.ts';
import { createAnimChannels } from '../../src/compat/motion/anim-channel.ts';
import { ClipRegistry } from '../../src/compat/motion/clip-registry.ts';
import { GeometryServiceImpl, WorkerPoolExecutor, type WorkerLike } from '../../src/render/geometry/geometry-service.ts';
import { createInProcessExecutor, createJobRunner, GeneratorError, type GenJob, type ModuleLoader, serveJobs, type ToWorker } from '../../src/render/geometry/geometry-worker.ts';
import { adoptRowRig, createRigMixer, RigMixer, ScriptRigs } from '../../src/render/rig/index.ts';
import { BEAN } from './bean.ts';
import { RUN } from './fixtures.ts';

const SCRIPT = 'scripts/gen/bean.js';
let skeletonCalls = 0;
const counted = { ...BEAN, skeleton: () => (skeletonCalls++, BEAN.skeleton()) };
const load: ModuleLoader = async (script) => {
  if (script === SCRIPT) return counted;
  if (script === 'scripts/gen/bad.js') return { geometry: () => undefined, skeleton: () => ({ a: { parent: 'nope', pivot: [0, 0, 0] } }) };
  throw new Error(`no ${script}`);
};
const job = (id: number, params: unknown, lods: GenJob['lods'], collider = false, script = SCRIPT): GenJob => ({ id, script, params, seed: 0, lods, collider });

describe('H4 worker: one rig per script', () => {
  it('without rigs (PP): skeleton() is never called and a ctx.bone generator fails as before', async () => {
    skeletonCalls = 0;
    const run = createJobRunner(load, { strict: true });
    await expect(run(job(1, { hue: 1 }, [1]))).rejects.toThrow(GeneratorError);
    expect(skeletonCalls).toBe(0);
  });

  it('with rigs: skeleton() once per module for every params variant, LOD and the collider; keys carry it', async () => {
    skeletonCalls = 0;
    const run = createJobRunner(load, { strict: true, rigs: true });
    const a = await run(job(1, { hue: 10 }, [1, 3], true));
    const b = await run(job(2, { hue: 200 }, [5]));
    expect(skeletonCalls).toBe(1);
    expect(a.skeleton!.bones.map((x) => x.name)).toEqual(['root', 'body', 'eyes', 'legL', 'legR', 'armL', 'armR']);
    expect(b.skeleton).toBe(a.skeleton);
    for (const l of [...a.lods, ...b.lods]) expect(l.skinIndex!.length).toBe(l.vertices);
    expect(a.collider && 'tris' in a.collider).toBe(true);
  });

  it('a bad skeleton() is a GeneratorError of that script', async () => {
    const run = createJobRunner(load, { rigs: true });
    await expect(run(job(1, {}, [1], false, 'scripts/gen/bad.js'))).rejects.toThrow(/bad\.js: skeleton\(\): .*unknown parent/);
  });

  it('a pool worker gets rigs through its config message and returns skinIndex by transfer', async () => {
    const posted: ToWorker[] = [];
    class FakeWorker implements WorkerLike {
      onmessage: ((ev: { data: unknown }) => void) | null = null;
      onerror: ((ev: unknown) => void) | null = null;
      private listeners: Array<(ev: { data: unknown }) => void> = [];
      constructor() {
        serveJobs(
          {
            postMessage: (msg, transfer) => {
              const data = structuredClone(msg, { transfer });
              setTimeout(() => this.onmessage?.({ data }), 0);
            },
            addEventListener: (_t, fn) => this.listeners.push(fn),
          },
          load,
        );
      }
      postMessage(msg: unknown): void {
        posted.push(msg as ToWorker);
        const data = structuredClone(msg);
        setTimeout(() => {
          for (const l of this.listeners) l({ data });
        }, 0);
      }
      terminate(): void {}
    }
    const pool = new WorkerPoolExecutor(() => new FakeWorker(), 1, { strict: true, rigs: true });
    const key = await pool.run(job(1, { hue: 3 }, [2]), { runtime: true, cost: 1 });
    expect(posted[0]).toEqual({ type: 'config', strict: true, rigs: true });
    expect(key.skeleton!.bones).toHaveLength(7);
    expect(key.lods[0]!.skinIndex).toBeInstanceOf(Uint8Array);
    pool.dispose();
    // PP config stays { type, strict }
    posted.length = 0;
    const plain = new WorkerPoolExecutor(() => new FakeWorker(), 1, { strict: false });
    await expect(plain.run(job(2, {}, [1]), { runtime: true, cost: 1 })).rejects.toThrow();
    expect(posted[0]).toEqual({ type: 'config', strict: false });
    plain.dispose();
  });

  it('the geometry service keeps the skeleton on cached views', async () => {
    const svc = new GeometryServiceImpl({ executor: createInProcessExecutor(load, { rigs: true }) });
    const first = await svc.request({ kind: 'scripted', script: SCRIPT, params: { hue: 5 } }, [1]);
    const again = await svc.request({ kind: 'scripted', script: SCRIPT, params: { hue: 5 } }, [1]);
    expect(first.skeleton).toBeDefined();
    expect(again.skeleton).toBe(first.skeleton);
  });
});

describe('H4 main thread: one RigDef per script, set on the row once', () => {
  it('two params variants share one rig; a re-skin keeps the mixer, its rig and its clip clock', async () => {
    const run = createJobRunner(load, { rigs: true });
    const k1 = await run(job(1, { hue: 10 }, [1]));
    const k2 = await run(job(2, { hue: 300 }, [1]));
    const rigs = new ScriptRigs();
    const r1 = rigs.rigOf(k1)!;
    expect(rigs.rigOf(k2)).toBe(r1);
    expect(rigs.rigOf({ script: 'scripts/gen/plain.js' })).toBeNull();
    expect(rigs.size).toBe(1);

    const channels = createAnimChannels({ registry: new ClipRegistry(), createMixer: createRigMixer });
    const row = { id: 'p1', parentId: null, phase: 'alive', place: 'main', serial: 1, props: { mixer: { gait: { clip: RUN, loop: 'loop' } } } } as unknown as RowRec;
    channels.rowSpawned(row);
    expect(adoptRowRig(channels, row, k1, rigs)).toBe(r1);
    const mixer = channels.get('p1')!;
    expect(mixer).toBeInstanceOf(RigMixer);
    expect(mixer.rig).toBe(r1);
    channels.advanceTick(0.1);
    let setRigCalls = 0;
    const orig = mixer.setRig.bind(mixer);
    mixer.setRig = (r) => (setRigCalls++, orig(r));
    adoptRowRig(channels, row, k2, rigs); // the re-skin
    expect(setRigCalls).toBe(0);
    expect(channels.get('p1')).toBe(mixer);
  });
});
