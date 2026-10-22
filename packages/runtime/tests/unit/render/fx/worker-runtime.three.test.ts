// DR-53/DR-54 S6: the fx Worker's facade (src/render/fx/fx-worker-runtime.ts) with the worker code in-process (fx-workers.ts
// ManualFxWorker, delivering only when told): handles and their semantics, refusals reported a frame later, a paused loop
// posting nothing, a tier change mid-run, dispose, the fallback's replay of the live effects with their lights, and the camera
// correction of camera-space buckets (DESIGN §11), whose drawn world positions equal the in-process run's.
import { describe, expect, it } from 'vitest';
import { InstancedMesh, Matrix4, Object3D, Scene, Sprite, Vector3 } from 'three/webgpu';
import type { BridgeLights } from '../../../../src/render/bridge/bridge-types.ts';
import { createFxSystem, type FxEffectId, type FxSystemOptions } from '../../../../src/render/fx/fx-system.ts';
import { FX_WORKER_STALL_MS, createFxWorkerSystem, type FxWorkerRuntime } from '../../../../src/render/fx/fx-worker-runtime.ts';
import { FxBufferPool, type FxSpawnCmd, type ToFxWorker } from '../../../../src/render/fx/fx-protocol.ts';
import { tierConfig, type RenderBudget, type TierId } from '../../../../src/render/perf/budget.ts';
import { ManualFxWorker } from './fx-workers.ts';
import { ATLAS, recordingLights, spritePositions } from './oracle.ts';

function liveBudget(tier: { now: TierId }): RenderBudget {
  return {
    get tier() {
      return tier.now;
    },
    cap: (kind, fallback) => {
      const v = (tierConfig(tier.now) as unknown as Record<string, unknown>)[kind];
      return typeof v === 'number' && Number.isFinite(v) ? Math.min(fallback, v) : fallback;
    },
  };
}

interface Setup {
  readonly world: Scene;
  readonly camera: Object3D;
  readonly manual: ManualFxWorker;
  readonly fx: FxWorkerRuntime;
  readonly log: string[];
  readonly warnings: string[];
  readonly tier: { now: TierId };
  /** an fx stage, then every message both ways */
  frame(dt?: number): void;
}

let clock = 0;
/** the facade's watchdog clock, ms */
const wall = { now: 0 };
function setup(over: Partial<FxSystemOptions> = {}): Setup {
  const world = new Scene();
  const camera = new Object3D();
  world.add(camera);
  const manual = new ManualFxWorker();
  const log: string[] = [];
  const warnings: string[] = [];
  const tier = { now: 'high' as TierId };
  const fx = createFxWorkerSystem(
    { world, camera, atlas: ATLAS, budget: liveBudget(tier), lights: recordingLights(log), log: (m) => warnings.push(m), ...over },
    { spawn: () => manual, now: () => wall.now },
  );
  return {
    world, camera, manual, fx, log, warnings, tier,
    frame(dt = 1 / 60) {
      clock += dt * 1000;
      fx.update({ dt, now: clock });
      manual.drain();
    },
  };
}

const frames = (m: ManualFxWorker): Array<Extract<ToFxWorker, { t: 'frame' }>> => (m.received as ToFxWorker[]).filter((x): x is Extract<ToFxWorker, { t: 'frame' }> => x.t === 'frame');
const spawns = (m: ManualFxWorker): FxSpawnCmd[] => frames(m).flatMap((f) => f.frame.cmds.filter((c): c is FxSpawnCmd => c.k === 's'));

const EMBERS = 'fx\npop e burst=4 life=5 r=sprite(ember,add)';
const HELD = 'fx\npop glow n=1 r=sprite(soft-disc,add)\npop lamp burst=1 life=5 r=light(<1,.5,.2>,8,6)';

describe('the fx Worker facade', () => {
  it('hands out tickets at once: has, effectCount, end, bind with restart and end', () => {
    const s = setup();
    const node = new Object3D();
    node.position.set(1, 2, 3);
    s.world.add(node);
    const a = s.fx.emit({ script: EMBERS }, [0, 1, 0])!;
    const b = s.fx.emit({ script: EMBERS }, [2, 1, 0])!;
    expect(a).not.toBeNull();
    expect(s.fx.has(a) && s.fx.has(b)).toBe(true);
    expect(s.fx.effectCount).toBe(2);
    s.fx.end(a);
    expect(s.fx.has(a)).toBe(false);
    expect(s.fx.effectCount).toBe(1);
    const binding = s.fx.bind('row-1', { script: EMBERS }, node)!;
    expect(s.fx.effectCount).toBe(2);
    s.frame();
    s.frame();
    // the end went with the spawns of the same frame, in call order: one effect fewer in the world
    expect(s.fx.stats().effects).toBe(2);
    expect(s.fx.sprites.get('add')?.count).toBe(8);
    binding.restart({ script: 'fx\npop e burst=2 life=5 r=sprite(ember,add)' });
    s.frame();
    s.frame();
    expect(s.fx.sprites.get('add')?.count).toBe(6);
    binding.end();
    s.fx.end(b);
    s.frame();
    s.frame();
    expect(s.fx.stats().effects).toBe(0);
    expect(s.fx.sprites.get('add')?.visible).toBe(false);
    // a bound effect's spawn carries the row's world position and the row as owner
    const bound = spawns(s.manual).find((c) => c.owner === 'row-1')!;
    expect(bound.target).toBe(1);
    expect(bound.origin).toEqual([1, 2, 3]);
    s.fx.dispose();
  });

  it('a spawn the worker refuses is reported with the next result: has() turns false then', () => {
    const s = setup({ maxEffects: 2 });
    const held = { script: 'fx\npop glow n=1 r=sprite(soft-disc,add)' };
    const a = s.fx.emit(held)!;
    const b = s.fx.emit(held)!;
    const c = s.fx.emit(held)!;
    expect([s.fx.has(a), s.fx.has(b), s.fx.has(c)]).toEqual([true, true, true]);
    s.frame();
    // the result arrived; it is presented at the next fx stage
    expect(s.fx.has(c)).toBe(true);
    s.frame();
    expect([s.fx.has(a), s.fx.has(b), s.fx.has(c)]).toEqual([true, true, false]);
    expect(s.warnings.filter((w) => w.includes('effect limit'))).toEqual(['[fx] fx effect limit (2) reached; further refusals are counted until an effect starts again']);
    // an invalid spec is refused on the main thread at once, as in-process
    expect(s.fx.emit({ script: '' })).toBeNull();
    expect(s.fx.emit({ script: 'fx\npop p burst=1', params: 3 })).toBeNull();
    s.fx.dispose();
  });

  it('a paused loop posts nothing; the result in flight is drawn at the next fx stage', () => {
    const s = setup();
    s.fx.emit({ script: EMBERS }, [0, 1, 0]);
    s.fx.update({ dt: 1 / 60, now: (clock += 16) });
    const postedFrames = (): number => s.manual.posted.filter((m) => m.t === 'frame').length;
    expect(postedFrames()).toBe(1);
    // the loop is paused: no fx stage runs, so nothing is posted, whatever arrives
    s.manual.drain();
    s.manual.drain();
    expect(postedFrames()).toBe(1);
    expect(s.fx.sprites.get('add')).toBeUndefined();
    s.frame();
    expect(s.fx.sprites.get('add')?.count).toBe(4);
    expect(s.fx.stats().presented).toBe(1);
    s.fx.dispose();
  });

  it('frames that arrive while a step is in flight merge (dt summed) and are counted', () => {
    const s = setup();
    s.fx.emit({ script: EMBERS }, [0, 1, 0]);
    s.fx.update({ dt: 1 / 60, now: (clock += 16) });
    s.fx.update({ dt: 1 / 60, now: (clock += 16) });
    s.fx.update({ dt: 1 / 30, now: (clock += 33) });
    s.manual.drain();
    const posted = frames(s.manual);
    expect(posted).toHaveLength(2);
    expect(posted[1]!.frame.dt).toBeCloseTo(1 / 60 + 1 / 30, 12);
    expect(s.fx.stats().merged).toBe(1);
    expect(s.fx.stats().late).toBe(2);
    s.fx.dispose();
  });

  it('a tier change mid-run: later spawns carry the new tier flags, held factor and cap; frames carry the new caps', () => {
    const s = setup();
    s.fx.emit({ script: EMBERS });
    s.frame();
    s.tier.now = 'low';
    s.fx.emit({ script: EMBERS });
    s.frame();
    const [high, low] = spawns(s.manual);
    expect(high!.tier).toEqual({ low: false, mobile: false });
    expect(low!.tier).toEqual({ low: true, mobile: false });
    expect([high!.cap, low!.cap]).toEqual([30_000, 8_000]);
    expect([high!.heldFactor, low!.heldFactor]).toEqual([1, 0.5]);
    const f = frames(s.manual);
    expect([f[0]!.frame.cap, f[1]!.frame.cap]).toEqual([30_000, 8_000]);
    expect([f[0]!.frame.lightsCap, f[1]!.frame.lightsCap]).toEqual([Number.POSITIVE_INFINITY, 8]);
    s.fx.dispose();
  });

  it('dispose: the worker is told and terminated, late messages are ignored, the buckets and light handles go', () => {
    const s = setup();
    s.fx.emit({ script: HELD }, [0, 1, 0]);
    s.frame();
    s.frame();
    expect(s.log.filter((l) => l.startsWith('add|'))).toHaveLength(1);
    expect(s.world.children.some((o) => o.name.startsWith('ss:fx:'))).toBe(true);
    s.fx.update({ dt: 1 / 60, now: (clock += 16) });
    s.fx.dispose();
    expect(s.manual.terminated).toBe(true);
    expect(s.manual.posted.at(-1)?.t).toBe('dispose');
    expect(s.log.filter((l) => l.startsWith('rm|'))).toHaveLength(1);
    expect(s.world.children.some((o) => o.name.startsWith('ss:fx:'))).toBe(false);
    s.manual.drain();
    s.fx.update({ dt: 1 / 60, now: (clock += 16) });
    expect(s.fx.emit({ script: EMBERS })).toBeNull();
    expect(s.fx.warmObjects()).toEqual([]);
  });

  it('a worker that stops answering (a step in flight too long while fx stages run) is replaced by the in-process world', () => {
    const s = setup();
    const id = s.fx.emit({ script: EMBERS }, [0, 1, 0])!;
    s.frame();
    s.frame();
    expect(s.fx.sprites.get('add')?.count).toBe(4);
    // a frame is posted and never answered
    s.fx.update({ dt: 1 / 60, now: (clock += 16) });
    wall.now += FX_WORKER_STALL_MS - 1;
    s.fx.update({ dt: 1 / 60, now: (clock += 16) });
    expect(s.fx.stats().mode).toBe('worker');
    wall.now += 2;
    s.fx.update({ dt: 1 / 60, now: (clock += 16) });
    expect(s.fx.stats().mode).toBe('inline-fallback');
    expect(s.fx.stats().fallback).toContain('has not answered');
    expect(s.manual.terminated).toBe(true);
    expect(s.fx.has(id)).toBe(true);
    // the effect started again in-process and is drawn in this very frame
    expect(s.fx.sprites.get('add')?.count).toBe(4);
    s.fx.dispose();
  });

  it('the fallback starts every live effect again in-process and keeps its lights coherent', () => {
    const s = setup();
    const lamp = s.fx.emit({ script: HELD }, [0, 1, 0])!;
    const gone = s.fx.emit({ script: EMBERS }, [0, 1, 0])!;
    s.frame();
    s.frame();
    s.fx.end(gone);
    s.manual.fail('lost');
    expect(s.fx.stats().mode).toBe('inline-fallback');
    expect(s.fx.has(lamp)).toBe(true);
    expect(s.fx.has(gone)).toBe(false);
    const before = s.log.length;
    s.frame();
    // the lamp's handle is set again (its particle key is the same), not added twice
    const calls = s.log.slice(before);
    expect(calls.filter((l) => l.startsWith('add|'))).toHaveLength(0);
    expect(calls.some((l) => l.startsWith('int|'))).toBe(true);
    expect(s.fx.sprites.get('add')?.count).toBe(1);
    s.fx.end(lamp as FxEffectId);
    expect(s.log.filter((l) => l.startsWith('rm|'))).toHaveLength(1);
    s.fx.dispose();
  });
});

describe('camera-space buckets under the fx Worker (DESIGN §11)', () => {
  const FOLLOW = 'fx follow=camera\npop dots burst=24 on=box(3,1,3) life=10 size=.1 col=<1,1,1> a=1 r=sprite(soft-disc,add)\npop drops burst=12 on=box(2,1,2) life=10 size=.05 col=<.5,0,0> a=1 r=mesh(box,1,1,1)';

  function drawnSprites(root: Object3D, camera: Object3D): number[] {
    root.updateMatrixWorld(true);
    const sprite = camera.children.find((o) => o.name === 'ss:fx:camera:add') as Sprite;
    const p = spritePositions(sprite);
    const out: number[] = [];
    const v = new Vector3();
    for (let i = 0; i < sprite.count; i++) out.push(...v.set(p[i * 3]!, p[i * 3 + 1]!, p[i * 3 + 2]!).applyMatrix4(sprite.matrixWorld).toArray());
    return out;
  }
  function drawnMeshes(camera: Object3D): number[] {
    const mesh = camera.children.find((o) => o.name.startsWith('ss:primitives:')) as InstancedMesh;
    const m = new Matrix4();
    const out: number[] = [];
    for (let i = 0; i < mesh.count; i++) {
      mesh.getMatrixAt(i, m);
      out.push(...new Vector3().setFromMatrixPosition(m.premultiply(mesh.matrixWorld)).toArray());
    }
    return out;
  }

  it('are drawn where the in-process runtime draws them, though the camera moved since the worker simulated them', () => {
    const inline = (() => {
      const world = new Scene();
      const camera = new Object3D();
      world.add(camera);
      const fx = createFxSystem({ world, camera, atlas: ATLAS, budget: liveBudget({ now: 'high' }), lights: recordingLights([]) as BridgeLights });
      return { world, camera, fx };
    })();
    const s = setup();
    const at = (camera: Object3D, f: number): void => {
      camera.position.set(Math.sin(f) * 4, 1.7, f * 0.5);
      camera.rotation.set(0.1 * Math.cos(f), f * 0.7, 0, 'YXZ');
    };
    at(inline.camera, 0);
    at(s.camera, 0);
    inline.fx.emit({ script: FOLLOW, seed: 5 });
    s.fx.emit({ script: FOLLOW, seed: 5 });
    let worst = 0;
    for (let f = 0; f < 12; f++) {
      at(inline.camera, f);
      inline.fx.update({ dt: 1 / 60, now: 1000 + f * 16 });
      const wantSprites = drawnSprites(inline.world, inline.camera);
      const wantMeshes = drawnMeshes(inline.camera);
      // the worker's frame f is drawn at its fx stage f + 1, with the camera already somewhere else
      at(s.camera, f);
      s.fx.update({ dt: 1 / 60, now: 1000 + f * 16 });
      s.manual.drain();
      at(s.camera, f + 1);
      s.fx.update({ dt: 0, now: 1000 + f * 16 });
      s.manual.drain();
      const gotSprites = drawnSprites(s.world, s.camera);
      const gotMeshes = drawnMeshes(s.camera);
      expect(gotSprites.length).toBe(wantSprites.length);
      expect(gotMeshes.length).toBe(wantMeshes.length);
      for (let i = 0; i < wantSprites.length; i++) worst = Math.max(worst, Math.abs(gotSprites[i]! - wantSprites[i]!));
      for (let i = 0; i < wantMeshes.length; i++) worst = Math.max(worst, Math.abs(gotMeshes[i]! - wantMeshes[i]!));
      // a dt-0 frame posted above: let it finish so frame f + 1 starts clean
      s.fx.update({ dt: 0, now: 1000 + f * 16 });
      s.manual.drain();
    }
    expect(wantCount(inline.camera)).toBeGreaterThan(0);
    expect(worst).toBeLessThan(1e-4);
    inline.fx.dispose();
    s.fx.dispose();
  });
});

const wantCount = (camera: Object3D): number => (camera.children.find((o) => o.name === 'ss:fx:camera:add') as Sprite | undefined)?.count ?? 0;

describe('a camera-space distort bucket under the fx Worker', () => {
  it('takes the world matrix of the camera the worker simulated with, in the distort scene', () => {
    const distort = new Scene();
    const s = setup({ distortScene: () => distort });
    const HAZE = 'fx follow=camera\npop haze burst=4 life=5 v=up(.3) size=.5 col=<.006,.004,0> a=1 r=sprite(soft-disc,distort)';
    s.camera.position.set(1, 2, 3);
    s.fx.emit({ script: HAZE });
    s.fx.update({ dt: 1 / 60, now: (clock += 16) });
    s.camera.updateMatrixWorld(true);
    const simulated = s.camera.matrixWorld.clone();
    s.manual.drain();
    // the camera moves before the result is drawn
    s.camera.position.set(-4, 2, 9);
    s.camera.rotation.set(0, 1.2, 0);
    s.fx.update({ dt: 1 / 60, now: (clock += 16) });
    const sprite = distort.children.find((o) => o.name === 'ss:fx:camera:distort')!;
    expect(sprite).toBeDefined();
    expect(sprite.matrixAutoUpdate).toBe(false);
    expect(sprite.matrix.equals(simulated)).toBe(true);
    expect(sprite.matrix.equals(s.camera.matrixWorld)).toBe(false);
    s.fx.dispose();
  });
});


describe('portable worker transport safeguards', () => {
  it('never reuses a detached buffer and reuses a whole returned buffer only once', () => {
    const pool = new FxBufferPool();
    const first = pool.take('s:x', 100).buffer as ArrayBuffer;
    structuredClone(first, { transfer: [first] });
    expect(first.byteLength).toBe(0);
    pool.give('s:x', first);
    expect(pool.take('s:x', 100).buffer.byteLength).toBeGreaterThanOrEqual(400);
    const returned = new ArrayBuffer(4000);
    pool.give('s:x', returned);
    expect(pool.take('s:x', 900).buffer).toBe(returned);
    expect(pool.take('s:x', 900).buffer).not.toBe(returned);
  });

  it('an uncloneable params payload drops its effect alone and the good frame still completes', () => {
    const s = setup();
    try {
      const good = s.fx.emit({ script: 'fx\npop p burst=3 life=1 r=sprite(ember,add)' }, [0, 1, 0])!;
      const bad = s.fx.emit({ script: 'fx\npop q burst=3 life=1 r=sprite(ember,add)', params: { f: () => 1 } })!;
      expect(s.fx.has(bad)).toBe(true);
      s.frame();
      expect(s.fx.has(bad)).toBe(false);
      expect(s.fx.has(good)).toBe(true);
      expect(s.warnings.some((line) => line.includes('not plain data'))).toBe(true);
      s.frame();
      expect(s.fx.stats().mode).toBe('worker');
      expect(s.fx.stats().effects).toBe(1);
      expect(s.fx.sprites.get('add')?.count).toBe(3);
      expect(s.manual.returnedDetached).toBe(0);
    } finally { s.fx.dispose(); }
  });
});
