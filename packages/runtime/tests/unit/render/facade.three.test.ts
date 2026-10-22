// WP R0: the `Renderer` facade skeleton (docs/architecture.md §3.0; render §2.1). `assembleRenderer` wires an engine (three's
// renderer + caps) to the scene root, the camera presenter, the canvas host, the render loop and the budget. Here the engine is
// a stand-in (what the facade touches of three's renderer), so the wiring runs in Node: the tier, `gpuInfo()`, `telemetry()`,
// the `update` / `render` entry points, the rAF hand-over, the device-loss handler → pause `gpu`, the canvas notification, and
// the members whose producers are later work packages (they exist, are typed, and never throw). The real renderer on
// SwiftShader is tests/e2e/render-r0.spec.ts.
import { WebGLCoordinateSystem } from 'three';
import type { WebGPURenderer } from 'three/webgpu';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActRouter, RowFeed } from '../../../src/compat/core/ports.ts';
import type { RowRec } from '../../../src/compat/core/types.ts';
import type { DeviceCaps } from '../../../src/render/engine/capabilities.ts';
import { DEVICE_RESET_MESSAGE, type DeviceLostInfo, type RenderEngine } from '../../../src/render/engine/create-renderer.ts';
import type { FrameInfo } from '../../../src/render/engine/render-loop.ts';
import { assembleRenderer, type PlatformRenderHooks, type RenderFacade, type RendererDeps, type ScenePipeline } from '../../../src/render/index.ts';
import { TIER_TABLE } from '../../../src/render/perf/budget.ts';
import { setShaderTime, shaderTime } from '../../../src/render/shader-time.ts';

const SWIFTSHADER = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)';
const INTEL = 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)';

const frame = (over: Partial<FrameInfo> = {}): FrameInfo => ({ now: 0, dt: 1 / 60, realDt: 1 / 60, alpha: 0, frameIndex: 0, paused: false, ...over });

function caps(unmaskedRenderer: string | null, over: Partial<DeviceCaps> = {}): DeviceCaps {
  return {
    backend: 'webgl2',
    unmaskedRenderer,
    unmaskedVendor: null,
    software: unmaskedRenderer !== null && /SwiftShader|llvmpipe|Software/i.test(unmaskedRenderer),
    halfFloatRenderTargets: true,
    floatRenderTargets: true,
    floatTextureLoad: true,
    floatTextureLinear: true,
    maxTextureSize: 8192,
    max3dTextureSize: 2048,
    maxArrayLayers: 2048,
    compressed: { astc: false, etc2: false, etc1: false, bc: true, s3tc: true, pvrtc: false },
    outputBuffer: 'half-float',
    bloom: true,
    emissiveClamp: null,
    lutShaperLog2: [-12, 4],
    eightBitDeviation: false,
    ...over,
  };
}

/** what the facade touches of three's renderer */
function fakeThree() {
  const r = {
    sized: [] as Array<[number, number, number]>,
    ratio: 1,
    loop: null as ((t: number) => void) | null,
    disposed: 0,
    lostLogged: 0,
    lighting: null as unknown,
    coordinateSystem: WebGLCoordinateSystem,
    backend: { isWebGLBackend: true },
    info: {
      render: { drawCalls: 0, triangles: 0 },
      memory: { programs: 0 },
      createProgram(_program: unknown): void {
        r.info.memory.programs++;
      },
    },
    setPixelRatio(v: number): void {
      r.ratio = v;
    },
    setSize(w: number, h: number): void {
      r.sized.push([w, h, r.ratio]);
    },
    setAnimationLoop(cb: ((t: number) => void) | null): Promise<void> {
      r.loop = cb;
      return Promise.resolve();
    },
    onDeviceLost(_info: DeviceLostInfo): void {
      r.lostLogged++;
    },
    dispose(): Promise<void> {
      r.disposed++;
      return Promise.resolve();
    },
  };
  return r;
}

function fakeCanvas() {
  const canvas = {
    style: {} as Record<string, string>,
    parentNode: null,
    attrs: { id: 'ss-canvas' } as Record<string, string>,
    getAttributeNames: () => Object.keys(canvas.attrs),
    getAttribute: (n: string) => canvas.attrs[n] ?? null,
    setAttribute: (n: string, v: string) => void (canvas.attrs[n] = v),
  };
  return canvas;
}

interface Rig {
  facade: RenderFacade;
  three: ReturnType<typeof fakeThree>;
  hooks: PlatformRenderHooks & { pauses: string[]; releases: string[]; reloads: number };
  pipeline: { renders: number; disposed: number; scales: number[] };
  area: { left: number; top: number; width: number; height: number };
  changed: () => void;
  canvas: ReturnType<typeof fakeCanvas>;
}

function rig(
  opts: { renderer?: string | null; caps?: Partial<DeviceCaps>; deviceType?: ReturnType<PlatformRenderHooks['deviceType']>; quality?: ReturnType<PlatformRenderHooks['qualitySetting']>; search?: string; width?: number; height?: number; dpr?: number; tierFlagExplicit?: boolean } = {},
): Rig {
  const three = fakeThree();
  const canvas = fakeCanvas();
  const engineCaps = caps(opts.renderer === undefined ? INTEL : opts.renderer, opts.caps);
  const engine: RenderEngine = { renderer: three as unknown as WebGPURenderer, backend: engineCaps.backend, caps: engineCaps, software: engineCaps.software, canvas: canvas as unknown as HTMLCanvasElement };
  const hooks: Rig['hooks'] = {
    pauses: [],
    releases: [],
    reloads: 0,
    deviceType: () => opts.deviceType ?? 'desktop',
    requestPause: (reason) => void hooks.pauses.push(reason),
    releasePause: (reason) => void hooks.releases.push(reason),
    qualitySetting: () => opts.quality ?? 'auto',
    offerReload: () => void hooks.reloads++,
  };
  const pipeline = { renders: 0, disposed: 0, scales: [] as number[] };
  const area = { left: 0, top: 0, width: opts.width ?? 1280, height: opts.height ?? 720 };
  let changed: () => void = () => undefined;
  const deps: RendererDeps = {
    geometry: {} as RendererDeps['geometry'],
    assets: {} as RendererDeps['assets'],
    presentation: { update: () => undefined, now: () => 0, dt: () => 0, hitstop: () => undefined, hitstopActive: () => false },
    physics: { castDown: () => null },
    mixer: { bind: () => undefined, update: () => undefined },
    hooks,
  };
  const facade = assembleRenderer(engine, deps, {
    aspectRange: [0.5, 2],
    search: opts.search ?? '',
    ...(opts.tierFlagExplicit === undefined ? {} : { tierFlagExplicit: opts.tierFlagExplicit }),
    canvasEnv: {
      devicePixelRatio: () => opts.dpr ?? 1,
      available: () => ({ ...area }),
      observe: (_c, cb) => {
        changed = cb;
        return () => undefined;
      },
      createCanvas: () => fakeCanvas() as unknown as HTMLCanvasElement,
    },
    clock: { requestAnimationFrame: () => 1, cancelAnimationFrame: () => undefined },
    pipeline: (): ScenePipeline => ({
      scenePass: { setResolutionScale: (s: number) => void pipeline.scales.push(s) },
      render: () => {
        pipeline.renders++;
        three.info.render.drawCalls += 3;
        three.info.render.triangles += 36;
      },
      dispose: () => void pipeline.disposed++,
    }),
  });
  return { facade, three, hooks, pipeline, area, changed: () => changed(), canvas };
}

beforeEach(() => setShaderTime(0));
afterEach(() => vi.restoreAllMocks());

describe('Renderer facade: shape (docs/architecture.md §3.0)', () => {
  it('has every member of the canonical interface', () => {
    const { facade } = rig();
    const members = ['setTier', 'setReducedFlash', 'registerActs', 'attachFeed', 'update', 'render', 'setAnimationLoop', 'project', 'onFirstFrame', 'telemetry', 'gpuInfo', 'onCanvasReplaced', 'dispose'] as const;
    for (const m of members) expect(typeof facade[m], m).toBe('function');
    for (const p of ['scene', 'camera', 'flashGuard'] as const) expect(typeof facade[p], p).toBe('object');
    expect(typeof facade.tier).toBe('string');
  });

  it('the members whose producers are later work packages exist, are typed and never throw', async () => {
    const { facade } = rig();
    const acts: ActRouter = { register: () => () => undefined, registerEnd: () => () => undefined };
    const feed: RowFeed = { drain: () => undefined };
    expect(() => facade.registerActs(acts)).not.toThrow();
    expect(() => facade.attachFeed(feed)).not.toThrow();
    expect(() => facade.setReducedFlash(true)).not.toThrow();
    expect(() => facade.setReducedFlash(false)).not.toThrow();

    const progress: number[] = [];
    await expect(facade.scene.buildPlace('lobby', [], { colliders: {} as never, navgrid: null, terrain: null }, (f) => progress.push(f))).resolves.toBeUndefined();
    expect(progress.at(-1)).toBe(1);
    expect(() => facade.scene.activate('lobby')).not.toThrow();
    expect(() => facade.scene.disposePlace('lobby')).not.toThrow();
    expect(facade.scene.bounds({} as RowRec)).toBeUndefined();
    expect(facade.scene.socket('row-1', 'muzzle')).toBeNull();

    // the flash guard is the identity until R1b's lands (identical output while disabled is its contract)
    const channel = facade.flashGuard.channel('lamp:1', 1);
    expect(channel.apply(0.4, 1000, 1 / 60)).toBe(0.4);
  });
});

describe('tier (render §15.1; X-22)', () => {
  it('a desktop with an integrated GPU starts on `high`; SwiftShader on `minimum`; a tablet on `low`; a phone on `minimum`', () => {
    expect(rig({ renderer: INTEL }).facade.tier).toBe('high');
    expect(rig({ renderer: null }).facade.tier).toBe('high'); // masked
    expect(rig({ renderer: SWIFTSHADER }).facade.tier).toBe('minimum');
    expect(rig({ renderer: 'Apple GPU', deviceType: 'tablet' }).facade.tier).toBe('low');
    expect(rig({ renderer: 'Mali-G78', deviceType: 'mobile' }).facade.tier).toBe('minimum');
  });

  it('a device on the 8-bit path is `minimum`', () => {
    expect(rig({ caps: { halfFloatRenderTargets: false, outputBuffer: 'unsigned-byte', bloom: false } }).facade.tier).toBe('minimum');
  });

  it('the saved SETTINGS pick and the ?tier= flag are honoured at creation, in that order', () => {
    expect(rig({ quality: 'medium' }).facade.tier).toBe('medium');
    expect(rig({ search: '?tier=low' }).facade.tier).toBe('low');
    expect(rig({ search: '?tier=low', quality: 'high' }).facade.tier).toBe('high');
    expect(rig({ renderer: SWIFTSHADER, search: '?tier=high' }).facade.tier).toBe('high'); // a test asks otherwise
  });

  it('setTier(pick) applies the pick at once: caps, start render scale, budget; `auto` returns to detection', () => {
    const r = rig({ width: 1920, height: 1080, dpr: 2 });
    expect(r.facade.tier).toBe('high');
    expect(r.three.ratio).toBeCloseTo(Math.sqrt(2_600_000 / (1920 * 1080)), 12);
    expect(r.facade.budget.cap('corpses', 64)).toBe(64);

    r.facade.setTier('low');
    expect(r.facade.tier).toBe('low');
    expect(r.facade.tierConfig).toBe(TIER_TABLE.low);
    expect(r.three.ratio).toBe(1); // DPR cap 1.0, and 1920 × 1080 is under 2.1 Mpx
    expect(r.pipeline.scales.at(-1)).toBe(0.8);
    expect(r.facade.budget.tier).toBe('low');
    expect(r.facade.budget.cap('particles', 30000)).toBe(8000);

    r.facade.setTier('medium');
    expect(r.facade.tier).toBe('medium');
    r.facade.setTier('auto');
    expect(r.facade.tier).toBe('high');
  });

  it('a tier change that resizes the drawing buffer while the step draws nothing (SETTINGS under the pause menu) is drawn once', () => {
    const r = rig({ width: 1920, height: 1080, dpr: 2 });
    let paused = false;
    r.facade.setAnimationLoop(() => {
      if (!paused) r.facade.render();
    });
    r.three.loop!(16);
    expect(r.pipeline.renders).toBe(1);
    paused = true;
    r.three.loop!(32);
    expect(r.pipeline.renders).toBe(1);

    // high → low at DPR 2: the pixel ratio drops from ≈ 1.12 to 1, setSize() clears the canvas
    const sizedBefore = r.three.sized.length;
    r.facade.setTier('low');
    expect(r.three.sized.length).toBeGreaterThan(sizedBefore);
    r.three.loop!(48);
    expect(r.pipeline.renders).toBe(2); // the resized canvas is not left blank under the pause overlay
    r.three.loop!(64);
    expect(r.pipeline.renders).toBe(2);

    // low → medium keeps the pixel ratio at 1: nothing was resized, nothing is drawn
    r.facade.setTier('medium');
    r.three.loop!(80);
    expect(r.pipeline.renders).toBe(2);
  });

  it('setTier accepts only auto / low / medium / high (`minimum` is the governor’s, X-22)', () => {
    const { facade } = rig();
    expect(() => facade.setTier('minimum' as never)).toThrow(RangeError);
    expect(() => facade.setTier('ultra' as never)).toThrow(RangeError);
    expect(facade.tier).toBe('high');
  });

  it('applyTier is the governor’s lever and can reach `minimum`; listeners hear every change once', () => {
    const { facade } = rig();
    const seen: string[] = [];
    const off = facade.onTierChange((t) => seen.push(t));
    facade.applyTier('minimum');
    facade.applyTier('minimum');
    expect(facade.tier).toBe('minimum');
    facade.setTier('high');
    off();
    facade.setTier('low');
    expect(seen).toEqual(['minimum', 'high']);
  });
});

describe('the quality governor on the facade (render §15.2; WP R14b)', () => {
  /** whole 2 s windows of one frame time (ms) and CPU time */
  const feed = (facade: RenderFacade, seconds: number, ms: number, cpu: number): void => {
    for (let t = 0; t < seconds * 1000; t += ms) facade.governor.sample(ms, cpu);
  };

  it('moves the scene-pass render scale through the canvas host, and a scheduled drop applies the tier at a break', () => {
    const r = rig();
    const g = r.facade.governor;
    g.setPhase('play');
    feed(r.facade, 2, 25, 4);
    expect(r.facade.host.renderScale).toBeCloseTo(0.9, 6);
    expect(r.pipeline.scales.at(-1)).toBeCloseTo(0.9, 6);
    feed(r.facade, 40, 25, 4);
    expect(g.inspect().pendingDrop).toBe('medium');
    expect(r.facade.tier).toBe('high');
    g.setPhase('break');
    expect(r.facade.tier).toBe('medium');
    expect(r.facade.host.renderScale).toBe(TIER_TABLE.medium.startRenderScale);
  });

  it("the player's explicit pick and a ?tier= flag disable drops; AUTO enables them again", () => {
    expect(rig({ quality: 'high' }).facade.tierExplicit).toBe(true);
    expect(rig({ search: '?tier=high' }).facade.tierExplicit).toBe(true);
    const r = rig();
    expect(r.facade.tierExplicit).toBe(false);
    r.facade.setTier('medium');
    expect(r.facade.tierExplicit).toBe(true);
    r.facade.governor.setPhase('break');
    feed(r.facade, 120, 30, 4);
    expect(r.facade.tier).toBe('medium');
    r.facade.setTier('auto');
    expect(r.facade.tierExplicit).toBe(false);
  });

  it('tierFlagExplicit: false lets a ?tier= flag stand as a detected tier the governor may drop (test builds, R14b)', () => {
    const r = rig({ search: '?tier=high', renderer: SWIFTSHADER, tierFlagExplicit: false });
    expect([r.facade.tier, r.facade.tierExplicit]).toEqual(['high', false]);
    // the player's pick still counts
    expect(rig({ search: '?tier=high', quality: 'low', tierFlagExplicit: false }).facade.tierExplicit).toBe(true);
  });

  it('the fx held lever is the facade’s own, on the mobile tiers only', () => {
    const desktop = rig();
    desktop.facade.governor.setPhase('play');
    feed(desktop.facade, 30, 25, 22); // CPU-bound on high: no fx lever there
    expect(desktop.facade.governor.inspect().pulled).not.toContain('fxHeld');
    expect(desktop.facade.fxHeldScale).toBe(1);

    const phone = rig({ renderer: 'Mali-G78', deviceType: 'mobile' });
    expect(phone.facade.tier).toBe('minimum');
    phone.facade.governor.setPhase('play');
    feed(phone.facade, 2, 45, 40); // the app's levers are absent here: the first lever that exists is the fx one
    expect(phone.facade.governor.inspect().pulled).toContain('fxHeld');
    expect(phone.facade.fxHeldScale).toBeCloseTo(0.25 / TIER_TABLE.minimum.fxHeldFactor, 6);
  });
});

describe('canvas, camera and pipeline wiring', () => {
  it('sizes the renderer from the canvas host and gives the camera the field’s aspect', () => {
    const r = rig({ width: 3000, height: 1000 });
    expect(r.three.sized.at(-1)!.slice(0, 2)).toEqual([2000, 1000]);
    expect(r.facade.camera.aspect).toBe(2);
    r.area.width = 1000;
    r.changed();
    r.three.loop!(16); // the resize rides the next animation frame
    expect(r.three.sized.at(-1)!.slice(0, 2)).toEqual([1000, 1000]);
    expect(r.facade.camera.aspect).toBe(1);
  });

  it('the scene pass gets the tier’s start render scale', () => {
    expect(rig({ renderer: SWIFTSHADER }).pipeline.scales).toEqual([0.65]);
    expect(rig().pipeline.scales).toEqual([1]);
  });

  it('project() goes through the presented camera, in css px of the active field', () => {
    const { facade } = rig({ width: 1280, height: 720 });
    facade.camera.apply({ eye: { x: 0, y: 1.6, z: 0 }, yaw: 0, pitch: 0, roll: 0, vfovDeg: 58.72 });
    const p = facade.project({ x: 0, y: 1.6, z: -5 });
    expect(p.x).toBeCloseTo(640, 9);
    expect(p.y).toBeCloseTo(360, 9);
    expect(p.onScreen).toBe(true);
    expect(facade.project({ x: 0, y: 1.6, z: 5 }).onScreen).toBe(false);
  });

  it('the five permanent lights are in the scene the pipeline draws', () => {
    const { facade } = rig();
    expect(facade.root.lights.all).toHaveLength(5);
    expect(facade.root.lights.all.every((l) => l.parent === facade.root.scene)).toBe(true);
  });

  it('setPipeline replaces the pipeline (R5b): the old one is disposed, the new scene pass gets the render scale', () => {
    const r = rig({ renderer: SWIFTSHADER });
    const scales: number[] = [];
    let renders = 0;
    r.facade.setPipeline(() => ({ scenePass: { setResolutionScale: (s) => void scales.push(s) }, render: () => void renders++, dispose: () => undefined }));
    expect(r.pipeline.disposed).toBe(1);
    expect(scales).toEqual([0.65]);
    r.facade.render();
    expect([renders, r.pipeline.renders]).toEqual([1, 0]);
  });
});

describe('update / render entry points and the loop', () => {
  it('update(frame) sets the shader time from FrameInfo.now; render() draws through the pipeline', () => {
    const { facade, pipeline } = rig();
    facade.update(frame({ now: 1500 }));
    expect(shaderTime.value).toBe(1.5);
    expect(pipeline.renders).toBe(0);
    facade.render();
    expect(pipeline.renders).toBe(1);
  });

  it('onFirstFrame fires once after the first render and returns an unsubscribe', () => {
    const { facade } = rig();
    let a = 0;
    let b = 0;
    facade.onFirstFrame(() => a++);
    facade.onFirstFrame(() => b++)();
    facade.render();
    facade.render();
    expect([a, b]).toEqual([1, 0]);
  });

  it('setAnimationLoop hands the step to three’s loop; null clears it', () => {
    const { facade, three } = rig();
    expect(typeof three.loop).toBe('function'); // attached at assembly: three's chain is the only one
    const times: number[] = [];
    facade.setAnimationLoop((t) => times.push(t));
    three.loop!(16);
    three.loop!(32);
    facade.setAnimationLoop(null);
    three.loop!(48);
    expect(times).toEqual([16, 32]);
    expect(facade.loop.source).toBe('three');
  });

  it('telemetry() reads renderer.info and counts program creations', () => {
    const { facade, three } = rig();
    expect(facade.telemetry()).toEqual({ drawCalls: 0, activeMeshes: 0, triangles: 0, shaderCompiles: 0 });
    facade.render();
    three.info.createProgram({});
    three.info.createProgram({});
    expect(facade.telemetry()).toEqual({ drawCalls: 3, activeMeshes: 3, triangles: 36, shaderCompiles: 2 });
    expect(three.info.memory.programs).toBe(2); // three's own bookkeeping still runs
  });

  it('gpuInfo() is the backend, the unmasked renderer string and the software flag', () => {
    expect(rig({ renderer: SWIFTSHADER }).facade.gpuInfo()).toEqual({ backend: 'webgl2', unmaskedRenderer: SWIFTSHADER, software: true });
    expect(rig({ renderer: INTEL }).facade.gpuInfo()).toEqual({ backend: 'webgl2', unmaskedRenderer: INTEL, software: false });
    expect(rig({ renderer: null, caps: { backend: 'webgpu' } }).facade.gpuInfo()).toEqual({ backend: 'webgpu', unmaskedRenderer: null, software: false });
  });
});

describe('device loss (render §3.1 policy step 1; X-07)', () => {
  const info: DeviceLostInfo = { api: 'WebGL', message: 'Unknown reason', reason: null };

  it('wraps the default handler: it runs first, then pause reason `gpu` is requested once', () => {
    const { facade, three, hooks } = rig();
    expect(facade.lost).toBe(false);
    three.onDeviceLost(info);
    expect(three.lostLogged).toBe(1);
    expect(hooks.pauses).toEqual(['gpu']);
    expect(facade.lost).toBe(true);
    // a second notice for the same loss asks for nothing more
    three.onDeviceLost(info);
    expect(hooks.pauses).toEqual(['gpu']);
    expect(hooks.releases).toEqual([]); // releasing is the rebuild's (X3)
    expect(hooks.reloads).toBe(0);
  });

  it('tells the loss listeners (the seam X3 extends), with the platform chrome’s message', () => {
    const { facade, three } = rig();
    const seen: unknown[] = [];
    const off = facade.onDeviceLost((n) => seen.push(n));
    three.onDeviceLost(info);
    expect(seen).toEqual([{ api: 'WebGL', message: 'Unknown reason', reason: null, title: DEVICE_RESET_MESSAGE }]);
    off();
    three.onDeviceLost(info);
    expect(seen).toHaveLength(1);
  });

  it('after a loss render() draws nothing and the step is still called (three’s loop keeps running)', () => {
    const { facade, three, pipeline } = rig();
    let steps = 0;
    facade.setAnimationLoop(() => {
      steps++;
      facade.render();
    });
    three.loop!(16);
    three.onDeviceLost(info);
    three.loop!(32);
    three.loop!(48);
    expect(steps).toBe(3);
    expect(pipeline.renders).toBe(1);
  });

  it('a throwing pause hook does not break the loss handler', () => {
    const { facade, three, hooks } = rig();
    hooks.requestPause = () => {
      throw new Error('platform');
    };
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(() => three.onDeviceLost(info)).not.toThrow();
    expect(facade.lost).toBe(true);
  });
});

describe('canvas replacement and engine adoption (the seams of the rebuild path, X3)', () => {
  it('onCanvasReplaced tells its listeners the new canvas and returns an unsubscribe', () => {
    const { facade } = rig();
    const seen: unknown[] = [];
    const off = facade.onCanvasReplaced((c) => seen.push(c));
    const next = facade.host.replaceCanvas();
    expect(seen).toEqual([next]);
    off();
    facade.host.replaceCanvas();
    expect(seen).toHaveLength(1);
  });

  it('adoptEngine wires a rebuilt engine: size, loop, loss handler, pipeline; the lost flag clears', () => {
    const r = rig({ width: 1280, height: 720 });
    r.three.onDeviceLost({ api: 'WebGL', message: 'lost', reason: null });
    expect(r.facade.lost).toBe(true);
    let steps = 0;
    r.facade.setAnimationLoop(() => steps++);

    const next = fakeThree();
    const nextCaps = caps(INTEL);
    const canvas = r.facade.host.replaceCanvas();
    r.facade.adoptEngine({ renderer: next as unknown as WebGPURenderer, backend: 'webgl2', caps: nextCaps, software: false, canvas });

    expect(r.facade.lost).toBe(false);
    expect(r.facade.engine.renderer).toBe(next);
    expect(next.sized.at(-1)!.slice(0, 2)).toEqual([1280, 720]);
    expect(r.three.loop).toBeNull(); // the old renderer's loop no longer carries the step
    next.loop!(16);
    expect(steps).toBe(1);
    expect(r.pipeline.disposed).toBe(1);
    // the new renderer's losses are ours as well; the old one's are not any more
    next.onDeviceLost({ api: 'WebGL', message: 'again', reason: null });
    expect(r.hooks.pauses).toEqual(['gpu', 'gpu']);
    expect(r.facade.telemetry().shaderCompiles).toBe(0);
  });
});

describe('dispose', () => {
  it('stops the loop, disposes the pipeline and the renderer, and puts three’s loss handler back', () => {
    const { facade, three, pipeline, hooks } = rig();
    let steps = 0;
    facade.setAnimationLoop(() => steps++);
    facade.dispose();
    expect(three.loop).toBeNull();
    expect(pipeline.disposed).toBe(1);
    expect(three.disposed).toBe(1);
    three.onDeviceLost({ api: 'WebGL', message: 'late', reason: null });
    expect(hooks.pauses).toEqual([]);
    expect(() => facade.dispose()).not.toThrow();
    expect(three.disposed).toBe(1);
  });
});
