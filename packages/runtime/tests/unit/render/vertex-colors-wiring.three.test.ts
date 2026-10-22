// K10b end to end: the `vertexColors` flag reaches the geometry workers (config message) and the packed map stage
// (`installRenderBridge`), and both default to PP's behaviour. Own file: the PP tests stay unchanged.
import { WebGLCoordinateSystem, type Node } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { installRenderBridge, type RenderBridgeHost } from '../../../src/render/bridge/install.ts';
import { WorkerPoolExecutor } from '../../../src/render/geometry/geometry-service.ts';
import type { ToWorker } from '../../../src/render/geometry/geometry-worker.ts';
import { createRenderLoop } from '../../../src/render/engine/render-loop.ts';
import { createLightTable } from '../../../src/render/lighting/light-table.ts';
import { createCameraPresenter } from '../../../src/render/scene/camera-presenter.ts';
import { createSceneRoot } from '../../../src/render/scene/scene-root.ts';
import { SurfaceVariant as V } from '../../../src/render/surface/surface-material.ts';

const attrs = (n: Node | null): string[] => {
  const out: string[] = [];
  n?.traverse((x) => {
    const a = (x as unknown as { _attributeName?: string })._attributeName;
    if (a) out.push(a);
  });
  return out;
};

function install(vertexColors?: boolean) {
  const camera = createCameraPresenter({ coordinateSystem: () => WebGLCoordinateSystem });
  camera.setViewport(640, 360);
  const host: RenderBridgeHost = {
    root: createSceneRoot(),
    camera,
    loop: createRenderLoop({ draw: () => false, clock: { requestAnimationFrame: () => 0, cancelAnimationFrame: () => undefined } }),
    tier: 'high',
    engine: { renderer: { compileAsync: async () => undefined, copyTextureToTexture: () => undefined, backend: {}, coordinateSystem: WebGLCoordinateSystem } },
    deps: { geometry: {}, mixer: { bind: () => true, update: () => undefined } },
    get feed() {
      return null;
    },
    setScenePort: () => undefined,
  };
  return installRenderBridge(host, {
    script: { lighting: (_s, l) => l.ambient },
    lights: createLightTable(),
    log: () => undefined,
    ...(vertexColors === undefined ? {} : { vertexColors }),
  });
}

describe('vertexColors through installRenderBridge', () => {
  const v = V.SRC_PACKED | V.SIDE_DOUBLE | V.TRANSPARENT;
  it('on: the packed material reads the ssColor attribute', () => {
    const b = install(true);
    expect(attrs(b.materials.get({ variant: v }).colorNode)).toContain('ssColor');
    expect(attrs(b.materials.get({ variant: v }).opacityNode)).toContain('ssColor');
    b.dispose();
  });
  it('off (default and explicit false): it does not (negative control)', () => {
    for (const flag of [undefined, false]) {
      const b = install(flag);
      expect(attrs(b.materials.get({ variant: v }).colorNode)).not.toContain('ssColor');
      b.dispose();
    }
  });
});

describe('vertexColors in the worker pool config', () => {
  const posted = (opts: ConstructorParameters<typeof WorkerPoolExecutor>[2]): ToWorker => {
    const sent: unknown[] = [];
    const pool = new WorkerPoolExecutor(
      () => ({ postMessage: (m: unknown) => void sent.push(m), terminate: () => undefined, onmessage: null, onerror: null }),
      1,
      opts,
    );
    void pool.run({ id: 1, script: 's.js', params: {}, seed: undefined, lods: [1], collider: false }, { runtime: false, cost: 1 }).catch(() => undefined);
    pool.dispose();
    return sent[0] as ToWorker;
  };
  it('is sent only when on', () => {
    expect(posted({ strict: false })).toEqual({ type: 'config', strict: false });
    expect(posted({ strict: true, vertexColors: true })).toEqual({ type: 'config', strict: true, vertexColors: true });
    expect(posted({ rigs: true, vertexColors: true })).toEqual({ type: 'config', strict: false, rigs: true, vertexColors: true });
  });
});

describe('vertexColors in serveJobs', () => {
  it('a config message with vertexColors makes the worker pack { colors }; without it the job is not coloured', async () => {
    const { serveJobs } = await import('../../../src/render/geometry/geometry-worker.ts');
    const load = async () => ({ geometry: (c: { tri: (...n: number[]) => void }) => { c.tri(0, 0, 0, 1, 0, 0, 0, 1, 0); return { colors: Array.from({ length: 12 }, () => 0.5) }; } });
    const run = async (config: ToWorker): Promise<{ colors?: unknown }> => {
      const listeners: Array<(ev: { data: unknown }) => void> = [];
      let reply: (m: unknown) => void = () => undefined;
      const answer = new Promise<unknown>((r) => (reply = r));
      serveJobs({ postMessage: (m: unknown) => reply(m), addEventListener: (_t: 'message', fn: (ev: { data: unknown }) => void) => listeners.push(fn) }, load);
      for (const l of listeners) l({ data: config });
      for (const l of listeners) l({ data: { type: 'job', job: { id: 1, script: 'scripts/gen/c.js', params: {}, seed: undefined, lods: [1], collider: false } } });
      const msg = (await answer) as { type: string; key?: { lods: Array<{ colors?: unknown }> } };
      return msg.key!.lods[0]!;
    };
    expect((await run({ type: 'config', strict: false, vertexColors: true })).colors).toBeInstanceOf(Float32Array);
    expect((await run({ type: 'config', strict: false })).colors).toBeUndefined();
  });
});
