// R10: the fx runtime setup — atlas resolve/load, the live-tier budget, and disposal of the separately loaded atlas.
import { describe, expect, it } from 'vitest';
import type { Texture } from 'three/webgpu';
import type { TierConfig, TierId } from '../../../../src/render/perf/budget.ts';
import type { FxRuntime, FxSystemOptions } from '../../../../src/render/fx/fx-system.ts';
import { FX_ATLAS_KEY, setupFxRuntime, type FxSetupHost } from '../../../../src/render/fx/fx-setup.ts';

function fakeTexture(calls: string[]) {
  const t = {
    disposed: false,
    dispose() {
      calls.push('atlas');
      t.disposed = true;
    },
  };
  return t;
}

function fakeRuntime(calls: string[]) {
  const r = {
    options: null as FxSystemOptions | null,
    dispose() {
      calls.push('fx');
      r.disposed = true;
    },
    disposed: false,
  };
  return r;
}

function setup() {
  const logs: string[] = [];
  const calls: string[] = [];
  const loaded: string[] = [];
  const created: FxSystemOptions[] = [];
  let tier: TierId = 'high';
  const caps = new Map<TierId, Record<string, unknown>>([['high', {}]]);
  let resolveResult: string | null = 'https://cdn.example/fx-atlas.png';
  let loadError: unknown = null;
  let createError: unknown = null;
  let mobile: boolean | undefined;
  const host: FxSetupHost = {
    resolveAtlas: () => resolveResult,
    loadAtlas: async (url: string) => {
      loaded.push(url);
      if (loadError !== null) throw loadError;
      return fakeTexture(calls) as unknown as Texture;
    },
    world: { name: 'world' } as never,
    camera: { name: 'camera' } as never,
    tier: () => tier,
    tierConfig: () => caps.get(tier) as unknown as TierConfig,
    lighting: null,
    lights: null,
    create: (options: FxSystemOptions) => {
      created.push(options);
      if (createError !== null) throw createError;
      const r = fakeRuntime(calls);
      r.options = options;
      return r as unknown as FxRuntime;
    },
    log: (m: string) => {
      logs.push(m);
    },
  };
  return {
    host,
    logs,
    calls,
    loaded,
    created,
    setResolve: (v: string | null) => {
      resolveResult = v;
    },
    setLoadError: (e: unknown) => {
      loadError = e;
    },
    setCreateError: (e: unknown) => {
      createError = e;
    },
    setTier: (t: TierId, c: Record<string, unknown> = {}) => {
      tier = t;
      caps.set(t, c);
    },
    setMobile: (v: boolean | undefined) => {
      mobile = v;
      (host as { mobile?: boolean | undefined }).mobile = v;
    },
  };
}

describe('setupFxRuntime', () => {
  it('registers the atlas under the assets/fx key', () => {
    expect(FX_ATLAS_KEY).toBe('assets/fx/fx-atlas.png');
  });

  it('a null resolve means no atlas: fx stays null, nothing loads', async () => {
    const s = setup();
    s.setResolve(null);
    const setupResult = await setupFxRuntime(s.host);
    expect(setupResult.fx).toBe(null);
    expect(s.loaded).toEqual([]);
    expect(s.created).toEqual([]);
    expect(s.logs.length).toBe(1);
    expect(s.logs[0]).toContain(FX_ATLAS_KEY);
    setupResult.dispose();
  });

  it('an empty resolve is treated as missing too', async () => {
    const s = setup();
    s.setResolve('');
    const setupResult = await setupFxRuntime(s.host);
    expect(setupResult.fx).toBe(null);
    expect(s.created).toEqual([]);
  });

  it('builds the runtime with the atlas, budget, lighting and lights', async () => {
    const s = setup();
    const setupResult = await setupFxRuntime(s.host);
    expect(setupResult.fx).not.toBe(null);
    expect(s.loaded).toEqual(['https://cdn.example/fx-atlas.png']);
    expect(s.created.length).toBe(1);
    const options = s.created[0]!;
    expect(options.world).toBe(s.host.world);
    expect(options.camera).toBe(s.host.camera);
    expect(options.lighting).toBe(null);
    expect(options.lights).toBe(null);
    expect('mobile' in options).toBe(false);
    setupResult.dispose();
  });

  it('passes the app mobile flag through when defined', async () => {
    const s = setup();
    s.setMobile(true);
    const setupResult = await setupFxRuntime(s.host);
    expect(s.created[0]!.mobile).toBe(true);
    setupResult.dispose();
  });

  it('the budget reads the tier live and falls back per tier config', async () => {
    const s = setup();
    const setupResult = await setupFxRuntime(s.host);
    const budget = s.created[0]!.budget;
    expect(budget.tier).toBe('high');
    s.setTier('low', { particles: 500 });
    expect(budget.tier).toBe('low');
    expect(budget.cap('particles', 4000)).toBe(500);
    expect(budget.cap('fxLights', Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY);
    setupResult.dispose();
  });

  it('a load failure warns and builds nothing', async () => {
    const s = setup();
    s.setLoadError(new Error('404'));
    const setupResult = await setupFxRuntime(s.host);
    expect(setupResult.fx).toBe(null);
    expect(s.created).toEqual([]);
    expect(s.logs.length).toBe(1);
    setupResult.dispose();
  });

  it('a creation failure disposes the loaded atlas and leaves fx null', async () => {
    const s = setup();
    s.setCreateError(new Error('no webgpu'));
    const setupResult = await setupFxRuntime(s.host);
    expect(setupResult.fx).toBe(null);
    expect(s.logs.length).toBe(1);
    expect(s.calls).toEqual(['atlas']);
    setupResult.dispose();
  });

  it('dispose runs the runtime first, then the atlas, and is idempotent', async () => {
    const s = setup();
    const setupResult = await setupFxRuntime(s.host);
    setupResult.dispose();
    expect(s.calls).toEqual(['fx', 'atlas']);
    setupResult.dispose();
    expect(s.calls).toEqual(['fx', 'atlas']);
  });
});
