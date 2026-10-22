import { describe, expect, it, vi } from 'vitest';
import type { BootEnv, BootResult } from '../../src/compat/core/boot/boot.ts';
import type { KernelExtensions } from '../../src/compat/core/ext.ts';
import { composeGame, defaultParts, DEFAULT_SHELL_EXTENSIONS, mergeExtensions, type ShellParts, type ShellRenderer } from '../../src/shell/compose-game.ts';
import { createWebPlatform } from '../../src/shell/web-platform.ts';

/** fakes for every part; `log` records what was built and called, in order */
function fakes(log: string[], over: Partial<ShellParts> = {}) {
  let env: BootEnv | null = null;
  const driver = { start: vi.fn(() => log.push('driver.start')), attach: vi.fn(), stop: vi.fn() };
  const scene = { attach: vi.fn(), attached: false };
  const kernel = { id: 'kernel' };
  const parts: Partial<ShellParts> = {
    platform: () => ({ id: 'fake-platform' }) as never,
    audio: () => ({ frame() {}, playSound() {}, stopSound() {}, setListener() {}, dispose: () => void log.push('audio.dispose') }),
    worldConfig: async () => ({ inputs: { actions: { go: { keys: ['space'] } } } }),
    input: (o) => {
      log.push(`input ${JSON.stringify(o.inputs)}`);
      return { port: { id: 'input-port' } as never, sink: {}, log: {}, dispose: () => void log.push('input.dispose') };
    },
    camera: () => ({ presentation: { hitstop() {}, now: () => 0 }, presenter: { last: null }, rig: { id: 'rig', attach: () => void log.push('rig.attach'), frame() {} } as never }),
    scene: () => scene as never,
    ui: (o) => {
      log.push(`ui globals=${String(o.config.globals)}`);
      return { uiPort: () => ({ uiEvent() {} }) as never, mount: () => void log.push('ui.mount'), frame() {}, coversScene: () => false, onFirstInteractiveFrame: (cb) => cb(), dispose: () => void log.push('ui.dispose') };
    },
    boot: async (e) => {
      env = e;
      await e.onKernel?.(kernel as never);
      await e.beforeWarmup?.(kernel as never);
      return { kernel, dispose: () => void log.push('boot.dispose') } as unknown as BootResult;
    },
    attach: () => ({ driver: driver as never, dispose: () => void log.push('frame.dispose') }),
    ...over,
  };
  return { parts, driver, scene, kernel, env: () => env! };
}

const base = { slug: 'fixture', canvas: null, headless: true } as const;

describe('composeGame', () => {
  it('composes in order and hands the kernel the ports it made', async () => {
    const log: string[] = [];
    const f = fakes(log);
    const app = await composeGame({ ...base, uiContainer: {} as HTMLElement, gameUi: { default: () => '' }, parts: f.parts });
    expect(app.steps).toEqual(['platform', 'audio', 'input', 'camera', 'scene', 'ui', 'extensions', 'kernel', 'onKernel', 'beforeWarmup', 'gate']);
    expect(log).toEqual(['input {"actions":{"go":{"keys":["space"]}}}', 'ui globals=auto', 'rig.attach', 'ui.mount', 'driver.start']);
    const env = f.env();
    expect(env.ports?.scene).toBe(f.scene);
    expect(env.ports?.input).toEqual({ id: 'input-port' });
    expect((env.ports?.camera as unknown as { id: string }).id).toBe('rig');
    expect(env.headless).toBe(true);
    expect(env.start).toBe('defaultPlace');
    expect(app.kernel).toBe(f.kernel);
    expect(f.driver.start).toHaveBeenCalledTimes(1);
    app.dispose();
    expect(log.slice(-5)).toEqual(['frame.dispose', 'boot.dispose', 'ui.dispose', 'input.dispose', 'audio.dispose']);
  });

  it('without a UI container or module: no UI host, a no-op UiPort, the boot still mounts nothing', async () => {
    const log: string[] = [];
    const f = fakes(log);
    const app = await composeGame({ ...base, parts: f.parts });
    expect(app.ui).toBeNull();
    expect(log).not.toContain('ui.mount');
    expect(() => (f.env().ports?.ui as { uiEvent(n: string, p: unknown): void }).uiEvent('x', 1)).not.toThrow();
  });

  it('a renderer attaches to the deferred scene port and takes the frame loop before the gate opens', async () => {
    const log: string[] = [];
    const f = fakes(log);
    const r: ShellRenderer = { scene: { id: 'render-scene' } as never, loop: { update() {}, render() {}, setAnimationLoop() {} }, dispose: vi.fn() };
    const app = await composeGame({ ...base, parts: f.parts, renderer: async (a) => (log.push(`renderer kernel=${(a.kernel as unknown as { id: string }).id}`), r) });
    expect(app.steps.slice(-2)).toEqual(['renderer', 'gate']);
    expect(f.scene.attach).toHaveBeenCalledWith(r.scene);
    expect(f.driver.attach).toHaveBeenCalledWith(r.loop);
    expect(log.indexOf('renderer kernel=kernel')).toBeLessThan(log.indexOf('driver.start'));
    app.dispose();
    expect(r.dispose).toHaveBeenCalled();
  });

  it('the physics wiring goes into the ports, attaches in onKernel and is awaited before the gate', async () => {
    const log: string[] = [];
    const f = fakes(log);
    const app = await composeGame({
      ...base,
      parts: f.parts,
      wiring: () => ({ ports: { physics: { id: 'physics' } as never }, onKernel: () => void log.push('wiring.onKernel'), ensurePhysics: async () => void log.push('physics.ready'), dispose: () => void log.push('wiring.dispose') }),
    });
    expect((f.env().ports?.physics as unknown as { id: string }).id).toBe('physics');
    expect(log.indexOf('wiring.onKernel')).toBe(log.indexOf('rig.attach') + 1);
    expect(log.indexOf('physics.ready')).toBeLessThan(log.indexOf('driver.start'));
    app.dispose();
    expect(log).toContain('wiring.dispose');
  });

  it('a failed boot disposes what was made, then rethrows', async () => {
    const log: string[] = [];
    const f = fakes(log, { boot: async () => Promise.reject(new Error('no world')) });
    await expect(composeGame({ ...base, parts: f.parts })).rejects.toThrow('no world');
    expect(log).toEqual(expect.arrayContaining(['input.dispose', 'audio.dispose']));
  });
});

describe('extensions', () => {
  const run = async (ports: Parameters<typeof composeGame>[0]['ports'], game?: KernelExtensions): Promise<KernelExtensions> => {
    const f = fakes([]);
    // the real extensions part (ports/bind), everything else faked
    await composeGame({ ...base, parts: { ...f.parts, extensions: defaultParts.extensions }, ...(ports ? { ports } : {}), ...(game ? { extensions: game } : {}) });
    return f.env().ext!;
  };

  it('absent ports: no ctx.sql / ctx.job (undefined, so feature tests work), a no-op ctx.music, Spawn cadence and ctx.changed', async () => {
    const ext = await run(undefined);
    expect(ext.sql).toBeUndefined();
    expect(ext.jobs).toBeUndefined();
    expect(ext).toMatchObject({ simCadence: 'any', changed: true, gravitySetter: true, music: true, capabilities: { absentAsUndefined: true } });
  });

  it('ports become the verbs; the game bag wins key by key', async () => {
    const music = { play() {}, stop() {}, duck() {} };
    const sql = { exec: vi.fn() } as never;
    const jobs = { run: vi.fn() } as never;
    const ext = await run({ sql, jobs, music }, { simCadence: 'strict', capabilities: { absentAsUndefined: false } });
    expect(typeof ext.sql?.verb).toBe('function');
    expect(typeof ext.jobs?.bind).toBe('function');
    expect(ext.music).toBe(music);
    expect(ext.simCadence).toBe('strict');
    expect(ext.capabilities?.absentAsUndefined).toBe(false);
    expect(ext.changed).toBe(true);
  });

  it('mergeExtensions keeps an explicit game verb over the port-built one', () => {
    const mine = { play() {}, stop() {}, duck() {} };
    expect(mergeExtensions({ music: mine }, { music: true }).music).toBe(mine);
    expect(mergeExtensions(undefined, {})).toMatchObject(DEFAULT_SHELL_EXTENSIONS);
  });
});

describe('web platform', () => {
  it('saves under the game’s prefix', () => {
    const data = new Map<string, string>();
    const storage = {
      get length() {
        return data.size;
      },
      key: (i: number) => [...data.keys()][i] ?? null,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    };
    const p = createWebPlatform({ window: null, storage, storagePrefix: 'fixture:' });
    p.save.set('slot', '{"a":1}');
    expect([...data.keys()]).toEqual(['fixture:slot']);
    p.dispose();
  });
});
