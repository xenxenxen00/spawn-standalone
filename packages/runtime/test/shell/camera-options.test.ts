// composeGame `camera: { orientationFromRow }` reaches the rig host (R-1); absent, the host is PP's.
import { describe, expect, it, vi } from 'vitest';

const made: Array<Record<string, unknown>> = [];
vi.mock('../../src/runtime/camera/rig-host.ts', async (orig) => {
  const mod = await orig<typeof import('../../src/runtime/camera/rig-host.ts')>();
  return { ...mod, createRigHost: (deps: Record<string, unknown>) => (made.push(deps), mod.createRigHost(deps as never)) };
});
import type { BootEnv, BootResult } from '../../src/compat/core/boot/boot.ts';
import { composeGame, defaultParts, type ShellParts } from '../../src/shell/compose-game.ts';

const input = { log: { look: { yaw: 0, pitch: 0 } } } as never;

describe('camera options', () => {
  it('the default camera part hands orientationFromRow to the rig host', async () => {
    made.length = 0;
    await defaultParts.camera({ input, audio: {} as never, options: { orientationFromRow: true } });
    expect(made[0]).toMatchObject({ orientationFromRow: true });
  });
  it('negative: absent or false leaves it out (PP)', async () => {
    made.length = 0;
    await defaultParts.camera({ input, audio: {} as never, options: {} });
    await defaultParts.camera({ input, audio: {} as never, options: { orientationFromRow: false } });
    expect(made).toHaveLength(2);
    for (const d of made) expect(d).not.toHaveProperty('orientationFromRow');
  });
  it('composeGame passes its camera option to the part, {} without', async () => {
    const seen: unknown[] = [];
    const parts = (): Partial<ShellParts> => ({
      platform: () => ({}) as never,
      audio: () => ({ frame() {}, playSound() {}, stopSound() {}, setListener() {} }),
      worldConfig: async () => ({}),
      input: () => ({ port: {} as never, sink: {}, log: {}, dispose() {} }),
      camera: (o) => (seen.push(o.options), { presentation: { hitstop() {}, now: () => 0 }, presenter: { last: null }, rig: { attach() {}, frame() {} } as never }),
      scene: () => ({ attach() {}, attached: false }) as never,
      extensions: () => ({}),
      boot: async (e: BootEnv) => (await e.onKernel?.({ spawnHuman() {} } as never), await e.beforeWarmup?.({} as never), { kernel: {}, dispose() {} } as unknown as BootResult),
      attach: () => ({ driver: { start() {}, attach() {}, stop() {} } as never, dispose() {} }),
    });
    await composeGame({ slug: 'f', canvas: null, headless: true, camera: { orientationFromRow: true }, parts: parts() });
    await composeGame({ slug: 'f', canvas: null, headless: true, parts: parts() });
    expect(seen).toEqual([{ orientationFromRow: true }, {}]);
  });
});

describe('renderer createOptions', () => {
  it('aspectRange (null included) and the atmosphere model reach createRenderer; absent adds nothing', async () => {
    const { createDefaultRenderer } = await import('../../src/shell/default-renderer.ts');
    const seen: unknown[] = [];
    const eng = {
      createRenderer: vi.fn(async (_c: HTMLCanvasElement, _d: never, o?: unknown) => (seen.push(o), { scene: {}, camera: {}, attachFeed() {}, dispose() {} }) as never),
      installGame: vi.fn(async () => ({ dispose() {}, model: () => null, rigFrame: () => null }) as never),
    };
    const env = { canvas: {} as HTMLCanvasElement, kernel: { feed: {}, worldConfig: {}, clock: { running: true } } as never, acts: null, presenter: {}, presentation: {} as never, assets: {} as never, geometry: {} as never, content: async () => ({}) };
    const lightingScript = { lighting: () => ({}) } as never;
    await createDefaultRenderer(env as never, { load: async () => eng as never, lightingScript, createOptions: { aspectRange: null, atmosphere: { model: 'daylight' } } });
    await createDefaultRenderer(env as never, { load: async () => eng as never, lightingScript });
    expect(seen).toEqual([{ rebuild: true, aspectRange: null, atmosphere: { model: 'daylight' } }, { rebuild: true }]);
  });
});
