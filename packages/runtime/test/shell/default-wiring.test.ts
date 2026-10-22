// composeGame `wiring: 'default'` (default-wiring.ts, PP's real-ports.ts pattern): the ports it hands the kernel, the anim host
// over the registry's (build-cooked) anim entries, the library catalogue of an asset index, and composeGame's wiring of it.
import { describe, expect, it } from 'vitest';
import { clips } from '../../src/compat/builtin/anim.ts';
import { createKernel } from '../../src/compat/core/kernel.ts';
import { createRegistry } from '../../src/compat/core/modules/registry.ts';
import type { CompiledPlaceIndex, RegistryInputs, WorldConfig } from '../../src/compat/core/types.ts';
import { clipToJson } from '../../src/compat/motion/clip.ts';
import { cookAuthoredFile } from '../../src/compat/motion/cook-authored.ts';
import { createAssetResolver } from '../../src/assets/resolver.ts';
import type { BootResult } from '../../src/compat/core/boot/boot.ts';
import { composeGame, type ShellParts } from '../../src/shell/compose-game.ts';
import { createDefaultWiring, createIndexLibrary } from '../../src/shell/default-wiring.ts';

const authored = { wave: { duration: 1, tracks: { Arm: { pitch: [0, 45, 0] } } } };

async function kernelWithAnim(compiled: unknown) {
  const inputs: RegistryInputs = {
    modules: {},
    sets: { boot: [], director: [], actors: ['anim/hop.yml'] } as unknown as RegistryInputs['sets'],
    anim: { 'anim/hop.yml': async () => ({ authored, compiled }) },
  };
  const registry = createRegistry(inputs, { log: { warn: () => {} } });
  const worldConfig: WorldConfig = { defaultPlace: 'p1', player: 'templates/player.js#player', camera: 'templates/camera.js#camera', inputs: {} };
  const places: CompiledPlaceIndex = { placeIndex: {}, places: {} };
  const k = createKernel({ seed: 1, ports: {}, worldConfig, places, registry, log: { sink: { log() {}, warn() {}, error() {} } } });
  await registry.ensure('actors');
  return k;
}

describe('createDefaultWiring', () => {
  it('hands the kernel physics, motion and attach ports, and the renderer a raycaster and a mixer', () => {
    const w = createDefaultWiring({ eye: () => null }, { warn: () => {} });
    expect(w.ports.physics).toBe(w.physics);
    expect(w.ports.motion).toBe(w.motion.port);
    expect(w.ports.attach).toBe(w.motion.attach);
    expect(typeof w.raycaster?.castDown).toBe('function');
    expect(w.mixer).toBe(w.presenter);
    expect(w.inspect()).toMatchObject({ clips: { catalogued: 0, authoredFiles: 0 }, renderer: false });
    w.dispose();
  });

  it('onKernel installs the anim host over the registry: builtin/anim clips() reads the build-cooked clips', async () => {
    const compiled = cookAuthoredFile('anim/hop.yml', authored).map((c) => clipToJson(c));
    const k = await kernelWithAnim(compiled);
    const w = createDefaultWiring({ eye: () => null }, { warn: () => {} });
    expect(() => clips({ session: null } as never, 'anim/hop.yml')).toThrow(/no such file/);
    w.onKernel(k);
    const table = clips({ session: null } as never, 'anim/hop.yml');
    expect(Object.keys(table)).toEqual(['wave']);
    expect(w.clips.authoredFiles()).toEqual(['anim/hop.yml']);
    expect(w.clips.authoredClips('anim/hop.yml')?.map((c) => c.id)).toEqual(['anim/hop.yml#wave']);
    w.attachRenderer?.({ model: () => null, rigFrame: () => null });
    expect(w.inspect()['renderer']).toBe(true);
    w.dispose();
    expect(() => clips({ session: null } as never, 'anim/hop.yml')).toThrow(/no such file/);
  });

  it('the library catalogue lists the clip entries of the asset index', () => {
    const index = {
      v: 1 as const,
      build: '',
      origin: '',
      entries: { 'clip-run.glb': { u: 'assets/c/run.jsonz', b: 1, k: 'clip' as const, x: 'jsonz', g: [] }, 'a.png': { u: 'assets/a.png', b: 1, k: 'image' as const, x: 'png', g: [] } },
      groups: {},
      facts: {},
    };
    const lib = createIndexLibrary(createAssetResolver(index, { base: 'http://localhost/' }));
    expect(lib.names()).toEqual(['run']);
    expect(createIndexLibrary(null).names()).toEqual([]);
  });
});

describe("composeGame wiring: 'default'", () => {
  it('builds it through parts.defaultWiring with the shared render env, and hands its ports to the boot', async () => {
    const renderEnv = { assets: { id: 'assets' }, geometry: { id: 'geometry' } } as never;
    const ports = { physics: { id: 'physics' } } as never;
    let bootPorts: unknown = null;
    let wiringEnv: unknown = null;
    const order: string[] = [];
    const parts: Partial<ShellParts> = {
      platform: () => ({}) as never,
      audio: () => ({ frame() {}, playSound() {}, stopSound() {}, setListener() {} }),
      worldConfig: async () => ({}),
      input: () => ({ port: {} as never, sink: {}, log: {}, dispose() {} }),
      camera: () => ({ presentation: { hitstop() {}, now: () => 0 }, presenter: { last: null }, rig: { attach() {}, frame() {} } as never }),
      scene: () => ({ attach() {}, attached: false }) as never,
      extensions: () => ({}),
      renderEnv: () => renderEnv,
      defaultWiring: async (env) => {
        wiringEnv = env;
        return { ports, onKernel: () => void order.push('wiring.onKernel'), ensurePhysics: async () => void order.push('ensurePhysics'), dispose: () => void order.push('wiring.dispose') };
      },
      boot: async (e) => {
        bootPorts = e.ports;
        await e.onKernel?.({} as never);
        return { kernel: {}, dispose() {} } as unknown as BootResult;
      },
      attach: () => ({ driver: { start: () => void order.push('driver.start'), attach() {}, stop() {} } as never, dispose() {} }),
    };
    const app = await composeGame({ slug: 'fixture', canvas: null, headless: true, wiring: 'default', parts });
    expect(wiringEnv).toMatchObject({ assets: { id: 'assets' }, geometry: { id: 'geometry' } });
    expect((bootPorts as { physics: unknown }).physics).toEqual({ id: 'physics' });
    expect(order).toEqual(['wiring.onKernel', 'ensurePhysics', 'driver.start']);
    expect(app.wiring?.ports).toBe(ports);
    app.dispose();
    expect(order).toContain('wiring.dispose');
  });
});
