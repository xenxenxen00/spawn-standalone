// composeGame options added for converted games: durable, profile, ext, input (pointer lock / touch / map options) and a headless
// composition that never reaches for `window`.
import { describe, expect, it, vi } from 'vitest';
import type { BootEnv, BootResult } from '../../src/compat/core/boot/boot.ts';
import type { Platform } from '../../src/compat/core/ports.ts';
import { createKernel } from '../../src/compat/core/kernel.ts';
import { createRegistry } from '../../src/compat/core/modules/registry.ts';
import type { CompiledPlaceIndex, WorldConfig } from '../../src/compat/core/types.ts';
import { composeGame, defaultParts, mergeGameExtensions, withProfile, type ShellParts } from '../../src/shell/compose-game.ts';

function parts(over: Partial<ShellParts> = {}, seen: { env?: BootEnv; extGame?: unknown } = {}): Partial<ShellParts> {
  return {
    platform: () => ({}) as never,
    audio: () => ({ frame() {}, playSound() {}, stopSound() {}, setListener() {} }),
    worldConfig: async () => ({}),
    input: () => ({ port: {} as never, sink: {}, log: {}, dispose() {} }),
    camera: () => ({ presentation: { hitstop() {}, now: () => 0 }, presenter: { last: null }, rig: { attach() {}, frame() {} } as never }),
    scene: () => ({ attach() {}, attached: false }) as never,
    extensions: (o) => ((seen.extGame = o.game), {}),
    boot: async (e) => ((seen.env = e), await e.onKernel?.({ spawnHuman() {} } as never), await e.beforeWarmup?.({} as never), { kernel: {}, dispose() {} } as unknown as BootResult),
    attach: () => ({ driver: { start() {}, attach() {}, stop() {} } as never, dispose() {} }),
    ...over,
  };
}
const base = { slug: 'fixture', canvas: null, headless: true } as const;

describe('durable', () => {
  it('builds the DurableState over the platform save and hands it to the boot', async () => {
    const seen: { env?: BootEnv } = {};
    const durable = vi.fn(() => ({ id: 'durable' }) as never);
    await composeGame({ ...base, durable: { key: 'g_save', durableKeys: ['prog'] }, parts: parts({ durable }, seen) });
    expect(durable).toHaveBeenCalledWith({ platform: expect.anything(), options: { key: 'g_save', durableKeys: ['prog'] } });
    expect(seen.env?.durable).toEqual({ id: 'durable' });
  });
  it('absent: the boot makes its own', async () => {
    const seen: { env?: BootEnv } = {};
    await composeGame({ ...base, parts: parts({}, seen) });
    expect(seen.env).not.toHaveProperty('durable');
  });
  it('the real part makes a DurableState with the options', async () => {
    const store = { ready: Promise.resolve(), get: () => null, set() {}, remove() {}, flush: async () => {} };
    const d = await defaultParts.durable({ platform: { save: store } as never, options: { key: 'g_save' } });
    expect(d.constructor.name).toBe('DurableState');
  });
});

describe('ext', () => {
  it('merges key by key over extensions, capabilities included', () => {
    expect(mergeGameExtensions({ simCadence: 'any', capabilities: { a: true } } as never, { changed: true, capabilities: { b: true } } as never)).toEqual({
      simCadence: 'any',
      changed: true,
      capabilities: { a: true, b: true },
    });
    expect(mergeGameExtensions(undefined, { changed: true })).toEqual({ changed: true });
    expect(mergeGameExtensions(undefined, undefined)).toBeUndefined();
  });
  it('composeGame hands the merged bag to the extensions part', async () => {
    const seen: { extGame?: unknown } = {};
    await composeGame({ ...base, extensions: { simCadence: 'any' }, ext: { changed: true }, parts: parts({}, seen) });
    expect(seen.extGame).toEqual({ simCadence: 'any', changed: true, capabilities: {} });
  });
});

describe('profile', () => {
  const platform = (user: { id: string | null; name: string; loggedIn: boolean } | null): Platform => ({ id: 'web', getUser: async () => user, marker: 7 }) as never;
  it('a guest or an unnamed user is called defaultName (default Player)', async () => {
    expect(await withProfile(platform(null), undefined).getUser()).toEqual({ id: null, name: 'Player', loggedIn: false });
    expect(await withProfile(platform(null), { defaultName: 'Pilot' }).getUser()).toMatchObject({ name: 'Pilot' });
    expect(await withProfile(platform({ id: 'a', name: ' ', loggedIn: true }), { defaultName: 'Pilot' }).getUser()).toEqual({ id: 'a', name: 'Pilot', loggedIn: true });
    expect(await withProfile(platform({ id: 'a', name: 'Ann', loggedIn: true }), undefined).getUser()).toMatchObject({ name: 'Ann' });
  });
  it('the rest of the platform passes through; a platform without getUser is returned as is', () => {
    const wrapped = withProfile(platform(null), undefined);
    expect((wrapped as unknown as { marker: number }).marker).toBe(7);
    const bare = {} as Platform;
    expect(withProfile(bare, undefined)).toBe(bare);
  });
  it('passes identity policy to boot without rewriting legitimate account IDs', async () => {
    const kernel = { spawnHuman: () => 'row' };
    const app = await composeGame({
      ...base,
      profile: {idPrefix:'custom:'},
      parts: parts({ boot: async (e) => (expect(e.profile).toEqual({idPrefix:'custom:'}), await e.onKernel?.(kernel as never), { kernel, profile: { userId: 'pg-1', displayName: 'x', authorised: true }, dispose() {} } as unknown as BootResult) }),
    });
    expect(app.boot.profile.userId).toBe('pg-1');
  });
});

describe('input option plumbing', () => {
  it('reaches the input and attach parts with headless', async () => {
    const input = vi.fn(() => ({ port: {} as never, sink: {}, log: {}, dispose() {} }));
    const attach = vi.fn(() => ({ driver: { start() {}, attach() {}, stop() {} } as never, dispose() {} }));
    const opts = { map: { arrowAliases: true }, pointerLock: true, touch: true } as const;
    await composeGame({ ...base, input: opts, parts: parts({ input, attach }) });
    expect(input).toHaveBeenCalledWith(expect.objectContaining({ options: opts, headless: true }));
    expect(attach).toHaveBeenCalledWith(expect.objectContaining({ headless: true }));
  });
  it('the touch layer mounts after the UI host', async () => {
    const order: string[] = [];
    const touch = { mount: () => void order.push('touch.mount'), frame() {}, dispose: () => void order.push('touch.dispose') };
    await composeGame({
      ...base,
      uiContainer: {} as HTMLElement,
      gameUi: {},
      parts: parts({
        input: () => ({ port: {} as never, sink: {}, log: {}, touch, dispose() {} }),
        ui: () => ({ uiPort: () => ({ uiEvent() {} }) as never, mount: () => void order.push('ui.mount'), frame() {}, coversScene: () => false, onFirstInteractiveFrame: (cb) => cb(), dispose() {} }),
      }),
    });
    expect(order).toEqual(['ui.mount', 'touch.mount']);
  });
});

describe('headless never touches window', () => {
  it('the real platform, audio, input and attach parts run with window and document throwing', async () => {
    const saved = ['window', 'document', 'navigator'].map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
    for (const [k] of saved) {
      Object.defineProperty(globalThis, k, {
        configurable: true,
        get() {
          throw new Error(`headless touched ${k}`);
        },
      });
    }
    try {
      const registry = createRegistry({ modules: {}, sets: { boot: [], director: [], actors: [] } as never, anim: {} }, { log: { warn: () => {} } });
      const worldConfig: WorldConfig = { defaultPlace: 'p1', player: 'templates/player.js#player', camera: 'templates/camera.js#camera', inputs: {} };
      const places: CompiledPlaceIndex = { placeIndex: {}, places: {} };
      const kernel = createKernel({ seed: 1, ports: {}, worldConfig, places, registry, log: { sink: { log() {}, warn() {}, error() {} } } });
      const app = await composeGame({
        ...base,
        canvas: { addEventListener() {}, removeEventListener() {} } as never,
        input: { pointerLock: true, touch: true },
        parts: {
          worldConfig: async () => ({ inputs: {} }),
          extensions: () => ({}),
          boot: async (e) => (await e.onKernel?.(kernel as never), { kernel, dispose() {} } as unknown as BootResult),
        },
      });
      expect(app.platform.id).toBe('web');
      expect(app.input.lock ?? null).toBeNull();
      expect(app.input.touch ?? null).toBeNull();
      expect(() => app.driver.step(16)).not.toThrow();
      app.dispose();
    } finally {
      for (const [k, d] of saved) {
        if (d) Object.defineProperty(globalThis, k, d);
        else delete (globalThis as Record<string, unknown>)[k];
      }
    }
  });
});
