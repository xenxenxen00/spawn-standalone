// composeGame `render:` and `boot:` option objects, `ext.uiPlace`, and a headless composition (needs no window or performance).
import { describe, expect, it, vi } from 'vitest';
import type { BootEnv, BootResult } from '../../src/compat/core/boot/boot.ts';
import { composeGame, defaultParts, mergeExtensions, type ShellParts, type ShellRenderEnv } from '../../src/shell/compose-game.ts';
import { createDefaultRenderer, type DefaultEngineModule, type DefaultRendererEnv } from '../../src/shell/default-renderer.ts';

const FLAGS = { vertexColors: true, scriptedPrimitives: true, scriptedPivot: true, flatPrimitivesCentred: true, fxBuiltinAtlas: true, fxLightsWithoutAtlas: true, fxAlignedCards: true, fxHeldFollow: true, fxAtlasUrl: 'x/atlas.png', fxRangeRolls: false, fxMode: 'inline' as const, primitiveAngles: true, dissolve: true, highlightOutline: true, highlightScriptedRows: true, warmK8Acts: true, worldTags: true };

function stub(seen: Record<string, unknown>, over: Partial<ShellParts> = {}): Partial<ShellParts> {
  return {
    platform: () => ({}) as never,
    audio: () => ({ frame() {}, playSound() {}, stopSound() {}, setListener() {} }),
    worldConfig: async () => ({}),
    input: () => ({ port: {} as never, sink: {}, log: {}, dispose() {} }),
    camera: () => ({ presentation: { hitstop() {}, now: () => 0 }, presenter: { last: null }, rig: { attach() {}, frame() {} } as never }),
    scene: () => ({ attach() {}, attached: false }) as never,
    extensions: (o) => ((seen['extGame'] = o.game), {}),
    renderEnv: (o) => ((seen['renderEnv'] = o), { assets: {} as never, geometry: {} as never } as ShellRenderEnv),
    audioInit: () => {},
    defaultWiring: async (_e, o) => ((seen['wiring'] = o), { ports: {}, onKernel() {}, dispose() {} }),
    defaultRenderer: async ({ options }) => ((seen['renderer'] = options), { scene: {} as never, dispose() {} }),
    boot: async (e: BootEnv) => ((seen['boot'] = e), await e.onKernel?.({} as never), { kernel: {}, dispose() {} } as unknown as BootResult),
    attach: () => ({ driver: { start() {}, attach() {}, stop() {} } as never, dispose() {} }),
    ...over,
  };
}
const compose = (seen: Record<string, unknown>, o: object) => composeGame({ slug: 'f', canvas: {} as HTMLCanvasElement, headless: true, wiring: 'default', renderer: 'default', parts: stub(seen), ...o } as never);

describe('render options', () => {
  it('passes host audio calibration through the composition', async () => {
    const audioInit=vi.fn();
    const seen:Record<string,unknown>={};
    const options={voicePoolSize:8,defaultRefDistance:2};
    await composeGame({slug:'audio-options',canvas:null,headless:true,wiring:'default',audioOptions:options,parts:stub(seen,{audioInit})});
    expect(audioInit).toHaveBeenCalledWith(expect.objectContaining({options,tier:'high'}));
  });
  it('every flag reaches the default renderer; vertexColors and rigs reach the render env', async () => {
    const seen: Record<string, unknown> = {};
    await compose(seen, { render: { ...FLAGS, rigs: true } });
    const opts = seen["renderer"] as { flags: Record<string, unknown> };
    expect(opts.flags).toEqual(FLAGS);
    expect(seen['renderEnv']).toMatchObject({ rigs: true, vertexColors: true });
    expect(seen['wiring']).toMatchObject({ rigs: true });
  });
  it('absent: nothing of it', async () => {
    const seen: Record<string, unknown> = {};
    await compose(seen, {});
    expect(seen['renderer']).not.toHaveProperty('flags');
    expect(seen['renderEnv']).not.toHaveProperty('vertexColors');
  });
  it('rendererOptions.flags wins over render', async () => {
    const seen: Record<string, unknown> = {};
    await compose(seen, { render: { dissolve: true, warmK8Acts: true }, rendererOptions: { flags: { dissolve: false } } });
    expect((seen['renderer'] as { flags: unknown }).flags).toEqual({ dissolve: false, warmK8Acts: true });
  });
  it('the default renderer puts set flags in installGame deps and leaves false ones out', async () => {
    const deps: Array<Record<string, unknown>> = [];
    const eng: DefaultEngineModule = {
      createRenderer: vi.fn(async () => ({ scene: {}, camera: {}, attachFeed() {}, dispose() {} }) as never),
      installGame: vi.fn(async (_r: never, d: never) => (deps.push(d), { dispose() {}, model: () => null, rigFrame: () => null }) as never),
    };
    const env = { canvas: {}, kernel: { feed: {}, worldConfig: {}, clock: { running: true } }, acts: null, presenter: {}, presentation: {}, assets: {}, geometry: {}, content: async () => ({}) } as unknown as DefaultRendererEnv;
    await createDefaultRenderer(env, { search:'?tier=low', load: async () => eng, lightingScript: { lighting: () => ({}) } as never, flags: { ...FLAGS, dissolve: false } });
    expect(eng.createRenderer).toHaveBeenCalledWith(expect.anything(),expect.anything(),expect.objectContaining({search:'?tier=low'}));
    expect(deps[0]).toMatchObject({ search:'?tier=low', vertexColors: true, scriptedPrimitives: true, fxBuiltinAtlas: true, fxAtlasUrl: "x/atlas.png", primitiveAngles: true, highlightOutline: true, warmK8Acts: true, worldTags: true });
    expect(deps[0]).not.toHaveProperty('dissolve');
    expect(deps[0]).toMatchObject({ fxRangeRolls: false, fxMode: 'inline', scriptedPivot: true, flatPrimitivesCentred: true, fxLightsWithoutAtlas: true, fxAlignedCards: true, fxHeldFollow: true, highlightScriptedRows: true });
  });
});

describe('boot options', () => {
  it('actors, placeBake, seed and start reach the BootEnv', async () => {
    const seen: Record<string, unknown> = {};
    await compose(seen, { boot: { actors: 'auto', placeBake: true, seed: 9, start: 'director' } });
    expect(seen['boot']).toMatchObject({ actors: 'auto', placeBake: true, seed: 9, start: 'director' });
  });
  it('absent: no actors, no placeBake; start stays defaultPlace; the top-level seed still works and boot.seed wins', async () => {
    const seen: Record<string, unknown> = {};
    await compose(seen, { seed: 3 });
    expect(seen['boot']).not.toHaveProperty('actors');
    expect(seen['boot']).not.toHaveProperty('placeBake');
    expect(seen['boot']).toMatchObject({ seed: 3, start: 'defaultPlace' });
    await compose(seen, { seed: 3, boot: { seed: 4 } });
    expect(seen['boot']).toMatchObject({ seed: 4 });
  });
});

describe('ext.uiPlace', () => {
  it('passes through the shell merge into the kernel extensions', async () => {
    const seen: Record<string, unknown> = {};
    await composeGame({ slug: 'f', canvas: null, headless: true, ext: { uiPlace: true }, parts: stub(seen) });
    expect(seen['extGame']).toMatchObject({ uiPlace: true });
    expect(mergeExtensions({ uiPlace: true }, {})).toMatchObject({ uiPlace: true, simCadence: 'any' });
  });
});

describe('render.geometryWorker', () => {
  it('reaches the render env and is not a renderer flag', async () => {
    const seen: Record<string, unknown> = {};
    const url = new URL('file:///geo-worker.js');
    await compose(seen, { render: { geometryWorker: url, dissolve: true } });
    expect(seen['renderEnv']).toMatchObject({ geometryWorker: url });
    expect((seen['renderer'] as { flags: unknown }).flags).toEqual({ dissolve: true });
  });
  it('absent: not in the render env arguments', async () => {
    const seen: Record<string, unknown> = {};
    await compose(seen, {});
    expect(seen['renderEnv']).not.toHaveProperty('geometryWorker');
  });
  it('the default renderEnv starts the supplied worker (factory and URL) instead of the stock one', async () => {
    vi.stubGlobal('document', { baseURI: 'http://localhost/' });
    const started: unknown[] = [];
    const fake = (): never => ({ postMessage() {}, terminate() {}, addEventListener() {}, removeEventListener() {}, onmessage: null, onerror: null }) as never;
    const env1 = await defaultParts.renderEnv({ assetIndex: undefined, geometryWorker: () => (started.push('factory'), fake()) });
    void env1.geometry.request({ script: 'scripts/a.js', params: {} } as never, [0] as never).catch(() => {});
    const g = globalThis as unknown as { Worker?: unknown };
    const prev = g.Worker;
    g.Worker = class { constructor(u: unknown, o: unknown) { started.push([String(u), o]); return fake(); } };
    try {
      const url = new URL('file:///geo-worker.js');
      const env2 = await defaultParts.renderEnv({ assetIndex: undefined, geometryWorker: url });
      void env2.geometry.request({ script: 'scripts/b.js', params: {} } as never, [0] as never).catch(() => {});
    } finally { g.Worker = prev; vi.unstubAllGlobals(); }
    expect(started.length).toBeGreaterThanOrEqual(2);
    expect(started[0]).toBe('factory');
    expect(JSON.stringify(started[1])).toContain('file:///geo-worker.js');
  });
});

describe('render.albedoTints', () => {
  const tints = { 'tex/a.png': [0.5, 0.25, 0.1] } as never;
  const fake = (posted: unknown[]): never => ({ postMessage: (m: unknown) => void posted.push(m), terminate() {}, addEventListener() {}, removeEventListener() {}, onmessage: null, onerror: null }) as never;
  it('reaches the render env and is not a renderer flag', async () => {
    const seen: Record<string, unknown> = {};
    await compose(seen, { render: { albedoTints: tints, dissolve: true } });
    expect(seen['renderEnv']).toMatchObject({ albedoTints: tints });
    expect((seen['renderer'] as { flags: unknown }).flags).toEqual({ dissolve: true });
  });
  it('absent: not in the render env arguments', async () => {
    const seen: Record<string, unknown> = {};
    await compose(seen, {});
    expect(seen['renderEnv']).not.toHaveProperty('albedoTints');
  });
  it('the supplied-worker service sends them in the worker config', async () => {
    vi.stubGlobal('document', { baseURI: 'http://localhost/' });
    const posted: unknown[] = [];
    try {
      const env = await defaultParts.renderEnv({ assetIndex: undefined, albedoTints: tints, geometryWorker: () => fake(posted) });
      void env.geometry.request({ script: 'scripts/a.js', params: {} } as never, [0] as never).catch(() => {});
    } finally { vi.unstubAllGlobals(); }
    expect(posted[0]).toMatchObject({ type: 'config', albedoTints: tints });
  });
});

describe('ports.jobPause', () => {
  it('reaches parts.attach, and is absent otherwise', async () => {
    const seen: Record<string, unknown> = {};
    const gate = { paused: () => false, subscribe: () => () => {}, set() {} };
    const attach = (o: { jobPause?: unknown }) => ((seen['jobPause'] = o.jobPause), { driver: { start() {}, attach() {}, stop() {} } as never, dispose() {} });
    await compose({}, { ports: { jobPause: gate }, parts: stub(seen, { attach: attach as never }) });
    expect(seen['jobPause']).toBe(gate);
    seen['jobPause'] = 'x';
    await compose({}, { parts: stub(seen, { attach: attach as never }) });
    expect(seen['jobPause']).toBeUndefined();
  });
});

describe("Crown & Clash's switch: ui.readyWhen and camera.orientationFromRow through composeGame", () => {
  it('reach parts.ui (config) and parts.camera (options); the default ui part hands the config to the UiHost', async () => {
    const seen: Record<string, unknown> = {};
    const container = {} as HTMLElement;
    await compose(seen, {
      uiContainer: container,
      gameUi: { default: () => '' },
      ui: { rootId: 'cc', readyWhen: '[data-cc-ready]' },
      camera: { orientationFromRow: true },
      parts: stub(seen, {
        ui: (o) => ((seen['ui'] = o.config), { uiPort: () => ({}) as never, mount() {}, frame() {}, onFirstInteractiveFrame() {}, dispose() {} } as never),
        camera: (o) => ((seen['camera'] = o.options), { presentation: { hitstop() {}, now: () => 0 }, presenter: { last: null }, rig: { attach() {}, frame() {} } as never }),
      }),
    });
    expect(seen['ui']).toMatchObject({ globals: 'auto', rootId: 'cc', readyWhen: '[data-cc-ready]' });
    expect(seen['camera']).toEqual({ orientationFromRow: true });
  });
});
