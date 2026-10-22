// The default renderer (composeGame `renderer: 'default'`): the lighting module rule, the attach order over a fake engine,
// the take-back on a failure, and composeGame's wiring of it.
import { describe, expect, it, vi } from 'vitest';
import type { BootResult } from '../../src/compat/core/boot/boot.ts';
import { composeGame, contentLoader, type ShellParts } from '../../src/shell/compose-game.ts';
import { createDefaultRenderer, resolveLightingScript, type DefaultEngineModule, type DefaultRendererEnv } from '../../src/shell/default-renderer.ts';
import { NEUTRAL_LIGHTING } from '../../src/shell/neutral-lighting.ts';

const lightingModule = { lighting: () => ({}) };

describe('resolveLightingScript', () => {
  it("the world config's lighting module, required to load and export lighting()", async () => {
    const content = vi.fn(async (p: string) => (p === 'scripts/sun.js' ? lightingModule : {}));
    expect(await resolveLightingScript('scripts/sun.js', content)).toEqual({ script: lightingModule, from: 'world-config' });
    await expect(resolveLightingScript('scripts/none.js', async () => ({ other: 1 }))).rejects.toThrow(/exports no lighting\(\) function/);
    await expect(resolveLightingScript('scripts/gone.js', async () => Promise.reject(new Error('404')))).rejects.toThrow(/did not load: 404/);
  });

  it('without one: the carried scripts/lighting.js, else the neutral module', async () => {
    expect((await resolveLightingScript(undefined, async (p) => (p === 'scripts/lighting.js' ? lightingModule : {}))).from).toBe('carried');
    const neutral = await resolveLightingScript(undefined, async () => Promise.reject(new Error('not carried')));
    expect(neutral).toEqual({ script: NEUTRAL_LIGHTING, from: 'neutral' });
  });

  it('the neutral module builds a TSL graph', async () => {
    const { vec3, float } = await import('three/tsl');
    const node = NEUTRAL_LIGHTING.lighting(
      { albedo: vec3(1, 1, 1), normal: vec3(0, 1, 0), view: vec3(0, 0, 1), roughness: float(1), metalness: float(0), occlusion: float(1) } as never,
      { each: (cb: (l: never) => unknown) => cb({ direction: vec3(0, 1, 0), radiance: vec3(1, 1, 1) } as never), ambient: vec3(0.1, 0.1, 0.1), environment: vec3(0, 0, 0) } as never,
    );
    expect((node as { isNode?: boolean }).isNode).toBe(true);
  });
});

function fakeEngine(log: string[], over: Partial<DefaultEngineModule> = {}) {
  const renderer = {
    scene: { id: 'render-scene' },
    camera: { id: 'render-camera' },
    attachFeed: (f: unknown) => void log.push(`attachFeed ${(f as { id: string }).id}`),
    registerActs: () => void log.push('registerActs'),
    dispose: () => void log.push('renderer.dispose'),
  };
  const world = {
    fx: { id: 'fx' },
    specials: { shockwave: () => true, shake: () => true },
    highlights: { id: 'highlights' },
    model: () => null,
    rigFrame: () => null,
    dispose: () => void log.push('world.dispose'),
  };
  const mod: DefaultEngineModule = {
    createRenderer: vi.fn(async () => {
      log.push('createRenderer');
      return renderer as never;
    }),
    installGame: vi.fn(async (_r: never, _d: never, seams?: { lightingScript?: (k: never) => Promise<unknown> }) => {
      log.push(`installGame lighting=${(await seams?.lightingScript?.({} as never)) === lightingModule}`);
      return world as never;
    }),
    registerFxActs: () => {
      log.push('registerFxActs');
      return () => void log.push('fx.off');
    },
    ...over,
  };
  return { mod, renderer, world };
}

function env(log: string[]): DefaultRendererEnv {
  const registered: string[] = [];
  return {
    canvas: {} as HTMLCanvasElement,
    kernel: { feed: { id: 'feed' }, worldConfig: { lighting: 'scripts/sun.js' }, clock: { running: true } } as never,
    acts: {
      renderActs: { register: (n: string) => (registered.push(n), () => void log.push(`off ${n}`)) } as never,
      attachRenderer: (r) => (log.push('acts.attachRenderer'), r.registerActs({} as never)),
      detachRenderer: () => void log.push('acts.detachRenderer'),
      setHighlightSink: (s) => void log.push(`highlightSink ${s === null ? 'null' : (s as unknown as { id: string }).id}`),
    },
    presenter: { setTarget: (t) => void log.push(`setTarget ${t === null ? 'null' : (t as { id: string }).id}`) },
    presentation: {} as never,
    assets: {} as never,
    geometry: {} as never,
    content: async (p) => (p === 'scripts/sun.js' ? lightingModule : {}),
    wiring: { attachRenderer: (l) => void log.push(`wiring.attachRenderer ${l === null ? 'null' : 'world'}`) },
  };
}

describe('createDefaultRenderer', () => {
  it('creates, installs the game with the lighting module, then attaches feed, acts, highlights and camera', async () => {
    const log: string[] = [];
    const f = fakeEngine(log);
    const r = await createDefaultRenderer(env(log), { load: async () => f.mod });
    expect(r.lighting).toBe('world-config');
    expect(r.scene).toBe(f.renderer.scene);
    expect(r.loop).toBe(f.renderer);
    expect(log).toEqual([
      'createRenderer',
      'installGame lighting=true',
      'wiring.attachRenderer world',
      'attachFeed feed',
      'acts.attachRenderer',
      'registerActs',
      'registerFxActs',
      'highlightSink highlights',
      'setTarget render-camera',
    ]);
    log.length = 0;
    r.dispose?.();
    expect(log).toEqual(['setTarget null', 'highlightSink null', 'off shockwave', 'off shake', 'fx.off', 'acts.detachRenderer', 'wiring.attachRenderer null', 'world.dispose', 'renderer.dispose']);
  });

  it('a failed install takes the renderer back and rethrows', async () => {
    const log: string[] = [];
    const f = fakeEngine(log, { installGame: async () => Promise.reject(new Error('no WebGL2')) });
    await expect(createDefaultRenderer(env(log), { load: async () => f.mod })).rejects.toThrow('no WebGL2');
    expect(log).toEqual(['createRenderer', 'renderer.dispose']);
  });
});

describe("composeGame renderer: 'default'", () => {
  it('makes the shared render env, hands the default renderer the app and the content loader, attaches its scene and loop', async () => {
    const driver = { start: vi.fn(), attach: vi.fn(), stop: vi.fn() };
    const scene = { attach: vi.fn(), attached: false };
    const kernel = { id: 'kernel' };
    const renderEnv = { assets: { id: 'assets' }, geometry: { id: 'geometry' } } as never;
    const seen: { content?: (p: string) => Promise<unknown>; env?: unknown; wiringEnv?: unknown } = {};
    const parts: Partial<ShellParts> = {
      platform: () => ({ device: { type: 'desktop' } }) as never,
      audio: () => ({ frame() {}, playSound() {}, stopSound() {}, setListener() {} }),
      worldConfig: async () => ({}),
      input: () => ({ port: {} as never, sink: {}, log: {}, dispose() {} }),
      camera: () => ({ presentation: { hitstop() {}, now: () => 0 }, presenter: { last: null }, rig: { attach() {}, frame() {} } as never }),
      scene: () => scene as never,
      extensions: () => ({}),
      boot: async (e) => {
        await e.onKernel?.(kernel as never);
        return { kernel, dispose() {} } as unknown as BootResult;
      },
      attach: () => ({ driver: driver as never, acts: { id: 'acts' } as never, dispose() {} }),
      renderEnv: () => renderEnv,
      defaultRenderer: async ({ app, env: e, content }) => {
        seen.content = content;
        seen.env = e;
        expect(app.acts).toEqual({ id: 'acts' });
        return { scene: { id: 'real-scene' } as never, loop: { id: 'loop' } as never };
      },
    };
    const app = await composeGame({
      slug: 'fixture',
      canvas: {} as HTMLCanvasElement,
      headless: true,
      renderer: 'default',
      wiring: (we) => ((seen.wiringEnv = we), { ports: {}, onKernel() {}, dispose() {} }),
      content: { 'scripts/lighting.js': async () => lightingModule },
      parts,
    });
    expect(app.steps).toContain('renderer');
    expect(app.renderEnv).toBe(renderEnv);
    expect(seen.env).toBe(renderEnv);
    expect(seen.wiringEnv).toMatchObject({ assets: { id: 'assets' }, geometry: { id: 'geometry' } });
    expect(scene.attach).toHaveBeenCalledWith({ id: 'real-scene' });
    expect(driver.attach).toHaveBeenCalledWith({ id: 'loop' });
    expect(await seen.content!('scripts/lighting.js')).toBe(lightingModule);
    await expect(seen.content!('scripts/nope.js')).rejects.toThrow(/no carried content script/);
  });

  it('contentLoader passes a loader through', async () => {
    const load = async () => lightingModule;
    expect(contentLoader(load)).toBe(load);
  });
});
