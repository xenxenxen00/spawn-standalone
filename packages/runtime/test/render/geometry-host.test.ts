import { afterEach, describe, expect, it, vi } from 'vitest';
import { createBrowserGeometryService, type WorkerLike } from '../../src/render/geometry/geometry-service.ts';
import type { ToWorker } from '../../src/render/geometry/geometry-worker.ts';
afterEach(() => vi.unstubAllGlobals());
describe('geometry host entry', () => {
  it('fails immediately without an injected entry and never spawns the library as a worker', () => {
    const worker = vi.fn(); vi.stubGlobal('Worker', worker);
    expect(() => createBrowserGeometryService()).toThrow(/supply createWorker.*loadGenerator/);
    expect(worker).not.toHaveBeenCalled();
  });
  it('executes injected generators inline without a Worker', async () => {
    const worker = vi.fn(); vi.stubGlobal('Worker', worker);
    const service = createBrowserGeometryService({ loadGenerator: async () => ({ geometry: () => ({ vertices: [], triangles: [] }) }) });
    await service.request({ script: 'custom.js' }, [1]);
    expect(worker).not.toHaveBeenCalled(); service.dispose();
  });
  it('keeps the explicitly supplied worker factory and forwards job errors', async () => {
    let instance: WorkerLike;
    const createWorker = vi.fn(() => (instance = { onmessage: null, onerror: null, terminate: vi.fn(), postMessage(message: unknown) {
      const data = message as ToWorker;
      if (data.type === 'job') queueMicrotask(() => instance.onmessage?.({ data: { type: 'error', id: data.job.id, error: { name: 'Error', message: 'injected worker reached', script: data.job.script } } }));
    } }));
    const service = createBrowserGeometryService({ createWorker, workers: 1 });
    await expect(service.request({ script: 'custom.js' }, [1])).rejects.toThrow('injected worker reached');
    expect(createWorker).toHaveBeenCalledOnce(); service.dispose();
  });
});
