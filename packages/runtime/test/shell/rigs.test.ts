// composeGame `rigs: true` (K3 H3): RigMixers + the `bones` channel in the default wiring, rigs-enabled geometry and a
// ScriptRigs handed to the default renderer's installGame. Everything is opt-in: without it nothing changes.
import { describe, expect, it, vi } from 'vitest';
import type { BootResult } from '../../src/compat/core/boot/boot.ts';
import { createKernel } from '../../src/compat/core/kernel.ts';
import { createRegistry } from '../../src/compat/core/modules/registry.ts';
import type { CompiledPlaceIndex, WorldConfig } from '../../src/compat/core/types.ts';
import { composeGame, type ShellParts, type ShellRenderEnv } from '../../src/shell/compose-game.ts';
import { createDefaultRenderer, type DefaultEngineModule, type DefaultRendererEnv } from '../../src/shell/default-renderer.ts';
import { createDefaultWiring } from '../../src/shell/default-wiring.ts';
import { RigMixer } from '../../src/render/rig/rig-mixer.ts';
import { ScriptRigs } from '../../src/render/rig/script-rigs.ts';

function kernel() {
  const registry = createRegistry({ modules: {}, sets: { boot: [], director: [], actors: [] } as never, anim: {} }, { log: { warn: () => {} } });
  const worldConfig: WorldConfig = { defaultPlace: 'p1', player: 'templates/player.js#player', camera: 'templates/camera.js#camera', inputs: {} };
  const places: CompiledPlaceIndex = { placeIndex: {}, places: {} };
  return createKernel({ seed: 1, ports: {}, worldConfig, places, registry, log: { sink: { log() {}, warn() {}, error() {} } } });
}

describe('default wiring rigs', () => {
  it('rigs: motion makes RigMixers and onKernel registers the bones channel; dispose takes it back', () => {
    const k = kernel();
    const w = createDefaultWiring({ eye: () => null }, { warn: () => {}, rigs: true });
    w.onKernel(k);
    const row = { id: 'r1', phase: 'alive', props: { bones: { body: { pitch: 0.5 } } } } as never;
    expect(w.motion.anim.ensure(row)).toBeInstanceOf(RigMixer);
    expect(k.store.channels.channels('bones')).toHaveLength(1);
    w.dispose();
    expect(k.store.channels.channels('bones')).toHaveLength(0);
  });

  it('default: plain Mixers and no bones channel (PP unchanged)', () => {
    const k = kernel();
    const w = createDefaultWiring({ eye: () => null }, { warn: () => {} });
    w.onKernel(k);
    expect(w.motion.anim.ensure({ id: 'r1', phase: 'alive', props: {} } as never)).not.toBeInstanceOf(RigMixer);
    expect(k.store.channels.channels('bones')).toHaveLength(0);
    w.dispose();
  });
});

describe('default renderer rigs', () => {
  const rendererEnv = (): DefaultRendererEnv => ({
    canvas: {} as HTMLCanvasElement,
    kernel: { feed: {}, worldConfig: {}, clock: { running: true } } as never,
    acts: null,
    presenter: {},
    presentation: {} as never,
    assets: {} as never,
    geometry: {} as never,
    content: async () => ({}),
  });
  const engine = (deps: unknown[]): DefaultEngineModule => ({
    createRenderer: vi.fn(async () => ({ scene: {}, camera: {}, attachFeed() {}, dispose() {} }) as never),
    installGame: vi.fn(async (_r: never, d: never) => (deps.push(d), { dispose() {}, model: () => null, rigFrame: () => null }) as never),
  });

  it('hands installGame deps.rigs only when given', async () => {
    const deps: Array<Record<string, unknown>> = [];
    const rigs = new ScriptRigs();
    await createDefaultRenderer(rendererEnv(), { load: async () => engine(deps as never), rigs, lightingScript: { lighting: () => ({}) } as never });
    await createDefaultRenderer(rendererEnv(), { load: async () => engine(deps as never), lightingScript: { lighting: () => ({}) } as never });
    expect(deps[0]!['rigs']).toBe(rigs);
    expect('rigs' in deps[1]!).toBe(false);
  });
});

describe('composeGame rigs', () => {
  async function compose(rigs: boolean | undefined) {
    const seen: { renderEnv?: unknown; wiring?: unknown; renderer?: unknown } = {};
    const scriptRigs = new ScriptRigs();
    const renderEnv: ShellRenderEnv = { assets: {} as never, geometry: {} as never, ...(rigs ? { rigs: scriptRigs } : {}) };
    const parts: Partial<ShellParts> = {
      platform: () => ({}) as never,
      audio: () => ({ frame() {}, playSound() {}, stopSound() {}, setListener() {} }),
      worldConfig: async () => ({}),
      input: () => ({ port: {} as never, sink: {}, log: {}, dispose() {} }),
      camera: () => ({ presentation: { hitstop() {}, now: () => 0 }, presenter: { last: null }, rig: { attach() {}, frame() {} } as never }),
      scene: () => ({ attach() {}, attached: false }) as never,
      extensions: () => ({}),
      renderEnv: (o) => ((seen.renderEnv = o), renderEnv),
      defaultWiring: async (_e, o) => ((seen.wiring = o), { ports: {}, onKernel() {}, dispose() {} }),
      defaultRenderer: async ({ options }) => ((seen.renderer = options), { scene: {} as never, dispose() {} }),
      boot: async (e) => (await e.onKernel?.({} as never), { kernel: {}, dispose() {} } as unknown as BootResult),
      attach: () => ({ driver: { start() {}, attach() {}, stop() {} } as never, dispose() {} }),
    };
    const app = await composeGame({ slug: 'fixture', canvas: {} as HTMLCanvasElement, headless: true, wiring: 'default', renderer: 'default', ...(rigs === undefined ? {} : { rigs }), parts });
    app.dispose();
    return { seen, scriptRigs };
  }

  it('rigs: true reaches the render env, the wiring and the renderer', async () => {
    const { seen, scriptRigs } = await compose(true);
    expect(seen.renderEnv).toMatchObject({ rigs: true });
    expect(seen.wiring).toMatchObject({ rigs: true });
    expect((seen.renderer as { rigs: unknown }).rigs).toBe(scriptRigs);
  });

  it('absent: none of it', async () => {
    const { seen } = await compose(undefined);
    expect(seen.renderEnv).not.toHaveProperty('rigs');
    expect(seen.wiring).not.toHaveProperty('rigs');
    expect(seen.renderer).not.toHaveProperty('rigs');
  });
});

describe('audio init, renderer create options, geometry options', () => {
  const stub = (over: Partial<ShellParts>): Partial<ShellParts> => ({
    platform: () => ({}) as never,
    audio: () => ({ frame() {}, playSound() {}, stopSound() {}, setListener() {} }),
    worldConfig: async () => ({}),
    input: () => ({ port: {} as never, sink: {}, log: {}, dispose() {} }),
    camera: () => ({ presentation: { hitstop() {}, now: () => 0 }, presenter: { last: null }, rig: { attach() {}, frame() {} } as never }),
    scene: () => ({ attach() {}, attached: false }) as never,
    extensions: () => ({}),
    renderEnv: () => ({ assets: { id: 'assets' } as never, geometry: {} as never }),
    defaultRenderer: async () => ({ scene: {} as never }),
    boot: async (e) => (await e.onKernel?.({} as never), { kernel: {}, dispose() {} } as unknown as BootResult),
    attach: () => ({ driver: { start() {}, attach() {}, stop() {} } as never, dispose() {} }),
    ...over,
  });
  it('audio.init gets the asset index manifest and tier once the render env exists', async () => {
    const calls: unknown[] = [];
    await composeGame({ slug: 'f', canvas: {} as HTMLCanvasElement, headless: true, renderer: 'default', audioTier: 'medium', parts: stub({ audioInit: (o) => void calls.push([o.assets, o.tier]) }) });
    expect(calls).toEqual([[{ id: 'assets' }, 'medium']]);
  });
  it('the real audioInit calls engine.init with a manifest', async () => {
    const init = vi.fn();
    const { createAssetResolver } = await import('../../src/assets/resolver.ts');
    const { EMPTY_ASSET_INDEX, defaultParts } = await import('../../src/shell/compose-game.ts');
    await defaultParts.audioInit({ audio: { init } as never, assets: createAssetResolver(EMPTY_ASSET_INDEX as never, { base: 'http://x/' }) as never, tier: 'high' });
    expect(init).toHaveBeenCalledWith({ manifest: {}, tier: 'high' });
  });
  it('createOptions merge over rebuild, and geometry options reach the render env', async () => {
    const seen: unknown[] = [];
    const eng: DefaultEngineModule = {
      createRenderer: vi.fn(async (_c: HTMLCanvasElement, _d: never, o?: unknown) => (seen.push(o), { scene: {}, camera: {}, attachFeed() {}, dispose() {} }) as never),
      installGame: vi.fn(async () => ({ dispose() {}, model: () => null, rigFrame: () => null }) as never),
    };
    const env: DefaultRendererEnv = { canvas: {} as HTMLCanvasElement, kernel: { feed: {}, worldConfig: {}, clock: { running: true } } as never, acts: null, presenter: {}, presentation: {} as never, assets: {} as never, geometry: {} as never, content: async () => ({}) };
    await createDefaultRenderer(env, { load: async () => eng, createOptions: { atmosphere: { fogModel: 'linear' } }, lightingScript: { lighting: () => ({}) } as never });
    expect(seen).toEqual([{ rebuild: true, atmosphere: { fogModel: 'linear' } }]);
    const got: unknown[] = [];
    await composeGame({ slug: 'f', canvas: {} as HTMLCanvasElement, headless: true, renderer: 'default', geometry: { vertexColors: true }, parts: stub({ renderEnv: (o) => (got.push(o), { assets: {} as never, geometry: {} as never }) }) });
    expect(got[0]).toMatchObject({ geometry: { vertexColors: true } });
  });
});
