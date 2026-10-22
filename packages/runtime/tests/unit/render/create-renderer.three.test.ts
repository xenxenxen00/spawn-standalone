// WP R0: renderer creation and device capabilities (render §3.1; X-46). `WebGPURenderer` with `forceWebGL: true` on our own WebGL2
// context (`powerPreference`), `outputBufferType` half float on every tier, the `?renderer=webgpu` flag (no own context, three's
// own fallback), `RendererUnsupported` without WebGL2, software detection on the unmasked renderer string, and the device-loss
// wrapper. Node: the canvas and the context are fakes and the three renderer is either a stub (creation paths) or the real
// class on a stub canvas, never initialised (the loss handler). The real thing on SwiftShader is tests/e2e/render-r0.spec.ts.
// R14b: program retention on every renderer made here (engine/program-retention.ts; its own test runs three's Pipelines).
import { HalfFloatType, UnsignedByteType, WebGPURenderer } from 'three/webgpu';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { backendOf, gpuInfoOf, readDeviceCaps, readGlFacts } from '../../../src/render/engine/capabilities.ts';
import {
  DEVICE_RESET_MESSAGE,
  RendererUnsupported,
  WEBGL2_CONTEXT_ATTRIBUTES,
  createRenderer,
  installDeviceLossHandler,
  rendererParameters,
  wantsWebGPU,
  type DeviceLostInfo,
  type RendererParameters,
} from '../../../src/render/engine/create-renderer.ts';
import { TIER_IDS, TIER_TABLE } from '../../../src/render/perf/budget.ts';

const SWIFTSHADER = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)';
const INTEL = 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)';

const ALL_EXTS = ['WEBGL_debug_renderer_info', 'EXT_color_buffer_float', 'EXT_color_buffer_half_float', 'OES_texture_float_linear'];

interface FakeGl {
  getExtension(name: string): unknown;
  getParameter(p: number): unknown;
}

function fakeGl(opts: { renderer?: string | null; exts?: string[]; maxTexture?: number } = {}): FakeGl {
  const exts = new Set(opts.exts ?? ALL_EXTS);
  return {
    getExtension: (name) => (exts.has(name) ? (name === 'WEBGL_debug_renderer_info' ? { UNMASKED_RENDERER_WEBGL: 0x9246, UNMASKED_VENDOR_WEBGL: 0x9245 } : {}) : null),
    getParameter: (p) => {
      if (p === 0x9246) return opts.renderer === undefined ? SWIFTSHADER : opts.renderer;
      if (p === 0x9245) return 'Google Inc. (Google)';
      if (p === 0x0d33) return opts.maxTexture ?? 8192;
      if (p === 0x8073) return 2048;
      if (p === 0x88ff) return 2048;
      return 'WebKit WebGL'; // the masked strings
    },
  };
}

interface FakeCanvas {
  asked: Array<[string, unknown]>;
  getContext(kind: string, attrs?: unknown): unknown;
}

function fakeCanvas(gl: FakeGl | null | 'throws'): FakeCanvas & HTMLCanvasElement {
  const c: FakeCanvas = {
    asked: [],
    getContext(kind, attrs) {
      c.asked.push([kind, attrs]);
      if (gl === 'throws') throw new Error('context creation blocked');
      return kind === 'webgl2' ? gl : null;
    },
  };
  return c as FakeCanvas & HTMLCanvasElement;
}

/** a stand-in for three's renderer: what createRenderer touches */
function fakeThree(backend: object, opts: { features?: string[]; initFails?: Error } = {}) {
  const seen: { parameters: RendererParameters | null; inits: number } = { parameters: null, inits: 0 };
  const construct = (parameters: RendererParameters): WebGPURenderer => {
    seen.parameters = parameters;
    return {
      backend,
      init: async () => {
        seen.inits++;
        if (opts.initFails) throw opts.initFails;
      },
      hasFeature: (name: string) => (opts.features ?? []).includes(name),
    } as unknown as WebGPURenderer;
  };
  return { construct, seen };
}

afterEach(() => vi.restoreAllMocks());

describe('wantsWebGPU: the ?renderer=webgpu flag', () => {
  it('is true only for renderer=webgpu', () => {
    expect(wantsWebGPU('?renderer=webgpu')).toBe(true);
    expect(wantsWebGPU('?tier=low&renderer=webgpu')).toBe(true);
    expect(wantsWebGPU('')).toBe(false);
    expect(wantsWebGPU('?renderer=webgl')).toBe(false);
    expect(wantsWebGPU('?renderer=WebGPU')).toBe(false);
    expect(wantsWebGPU('?webgpu')).toBe(false);
  });
});

describe('rendererParameters (render §3.1)', () => {
  const canvas = fakeCanvas(null);
  const gl = fakeGl() as unknown as WebGL2RenderingContext;

  it('default: forceWebGL on our own context, no MSAA, depth without stencil, half float output', () => {
    expect(rendererParameters(canvas, false, gl, true)).toEqual({ canvas, context: gl, forceWebGL: true, antialias: false, depth: true, stencil: false, outputBufferType: HalfFloatType });
  });

  it('a device that cannot render to half float gets UnsignedByteType', () => {
    expect(rendererParameters(canvas, false, gl, false).outputBufferType).toBe(UnsignedByteType);
  });

  it('the WebGPU flag: forceWebGL false, powerPreference, no context of ours, half float by default', () => {
    const p = rendererParameters(canvas, true, null, true);
    expect(p).toEqual({ canvas, forceWebGL: false, antialias: false, powerPreference: 'high-performance' });
    expect('context' in p).toBe(false);
    expect('outputBufferType' in p).toBe(false);
  });

  it('our context asks for the fast GPU and keeps alpha (the backend assumes it)', () => {
    expect(WEBGL2_CONTEXT_ATTRIBUTES).toEqual({ powerPreference: 'high-performance', antialias: false, alpha: true, depth: true, stencil: false });
  });
});

describe('createRenderer: the WebGL2 path (default)', () => {
  it('creates the context itself, hands it to three with forceWebGL, initialises, and reports the backend and caps', async () => {
    const gl = fakeGl();
    const canvas = fakeCanvas(gl);
    const backend = { isWebGLBackend: true, gl };
    const three = fakeThree(backend, { features: ['texture-compression-bc', 'texture-compression-s3tc'] });

    const engine = await createRenderer(canvas, { wantWebGPU: false, tier: TIER_TABLE.high }, { construct: three.construct });

    expect(canvas.asked).toEqual([['webgl2', WEBGL2_CONTEXT_ATTRIBUTES]]);
    expect(three.seen.parameters).toMatchObject({ canvas, context: gl, forceWebGL: true, antialias: false, outputBufferType: HalfFloatType });
    expect(three.seen.inits).toBe(1);
    expect(engine.canvas).toBe(canvas);
    expect(engine.backend).toBe('webgl2');
    expect(engine.software).toBe(true);
    expect(engine.caps).toMatchObject({
      backend: 'webgl2',
      unmaskedRenderer: SWIFTSHADER,
      unmaskedVendor: 'Google Inc. (Google)',
      software: true,
      halfFloatRenderTargets: true,
      floatRenderTargets: true,
      floatTextureLoad: true,
      floatTextureLinear: true,
      maxTextureSize: 8192,
      compressed: { astc: false, etc2: false, etc1: false, bc: true, s3tc: true, pvrtc: false },
      outputBuffer: 'half-float',
      bloom: true,
      emissiveClamp: null,
      lutShaperLog2: [-12, 4],
      eightBitDeviation: false,
    });
    expect(gpuInfoOf(engine.caps)).toEqual({ backend: 'webgl2', unmaskedRenderer: SWIFTSHADER, software: true });
  });

  it('R14b: every renderer gets program retention once init() made three’s Pipelines: a released program stays cached', async () => {
    const gl = fakeGl();
    const released: unknown[] = [];
    const pipelines = { _releaseProgram: (p: unknown): void => void released.push(p), _releasePipeline: (p: unknown): void => void released.push(p) };
    const construct = (): WebGPURenderer => {
      const r = {
        backend: { isWebGLBackend: true, gl },
        _pipelines: null as unknown,
        // three makes its Pipelines in init()
        init: async (): Promise<void> => {
          r._pipelines = pipelines;
        },
        hasFeature: () => false,
      };
      return r as unknown as WebGPURenderer;
    };
    await createRenderer(fakeCanvas(gl), { wantWebGPU: false, tier: TIER_TABLE.high }, { construct });
    pipelines._releaseProgram({ usedTimes: 0 });
    pipelines._releasePipeline({ usedTimes: 0 });
    expect(released).toEqual([]);
  });

  it('half float on every tier, `minimum` included', async () => {
    for (const tier of TIER_IDS) {
      const gl = fakeGl({ renderer: INTEL });
      const three = fakeThree({ isWebGLBackend: true, gl });
      const engine = await createRenderer(fakeCanvas(gl), { wantWebGPU: false, tier: TIER_TABLE[tier] }, { construct: three.construct });
      expect(three.seen.parameters!.outputBufferType, tier).toBe(HalfFloatType);
      expect(engine.caps.outputBuffer, tier).toBe('half-float');
      expect(engine.software, tier).toBe(false);
    }
  });

  it('either colour-buffer extension is enough for half float', async () => {
    for (const ext of ['EXT_color_buffer_float', 'EXT_color_buffer_half_float']) {
      const gl = fakeGl({ exts: ['WEBGL_debug_renderer_info', ext] });
      const three = fakeThree({ isWebGLBackend: true, gl });
      const engine = await createRenderer(fakeCanvas(gl), { wantWebGPU: false, tier: TIER_TABLE.low }, { construct: three.construct });
      expect(three.seen.parameters!.outputBufferType, ext).toBe(HalfFloatType);
      expect(engine.caps.floatRenderTargets, ext).toBe(ext === 'EXT_color_buffer_float');
    }
  });

  it('neither extension: UnsignedByteType, bloom off, emissive clamp 1, LUT shaper 2^-12..2^0, counted as a deviation', async () => {
    const gl = fakeGl({ exts: ['WEBGL_debug_renderer_info'], renderer: 'Mali-400 MP' });
    const three = fakeThree({ isWebGLBackend: true, gl });
    const engine = await createRenderer(fakeCanvas(gl), { wantWebGPU: false, tier: TIER_TABLE.minimum }, { construct: three.construct });
    expect(three.seen.parameters!.outputBufferType).toBe(UnsignedByteType);
    expect(engine.caps).toMatchObject({ halfFloatRenderTargets: false, outputBuffer: 'unsigned-byte', bloom: false, emissiveClamp: 1, lutShaperLog2: [-12, 0], eightBitDeviation: true });
  });

  it('no WebGL2 → RendererUnsupported, and three is never constructed', async () => {
    for (const gl of [null, 'throws'] as const) {
      const three = fakeThree({ isWebGLBackend: true });
      const err = await createRenderer(fakeCanvas(gl), { wantWebGPU: false, tier: TIER_TABLE.high }, { construct: three.construct }).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(RendererUnsupported);
      expect((err as Error).name).toBe('RendererUnsupported');
      expect(three.seen.parameters).toBeNull();
    }
  });

  it('an init() that fails is a RendererUnsupported with the cause kept', async () => {
    const gl = fakeGl();
    const cause = new Error('shader compiler crashed');
    const three = fakeThree({ isWebGLBackend: true, gl }, { initFails: cause });
    const err = await createRenderer(fakeCanvas(gl), { wantWebGPU: false, tier: TIER_TABLE.high }, { construct: three.construct }).then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(RendererUnsupported);
    expect((err as Error).cause).toBe(cause);
  });

  it('the masked RENDERER string is never what gpuInfo reports', async () => {
    const gl = fakeGl({ exts: ['EXT_color_buffer_float'] }); // no debug extension
    const three = fakeThree({ isWebGLBackend: true, gl });
    const engine = await createRenderer(fakeCanvas(gl), { wantWebGPU: false, tier: TIER_TABLE.high }, { construct: three.construct });
    expect(engine.caps.unmaskedRenderer).toBeNull();
    expect(engine.software).toBe(false);
  });
});

describe('createRenderer: the WebGPU flag', () => {
  it('creates no context of its own and lets three choose; a fallback to WebGL2 is reported as webgl2 with its renderer string', async () => {
    const gl = fakeGl();
    const canvas = fakeCanvas(gl);
    // what three leaves behind when WebGPU is not available: a WebGL backend on a context it created itself
    const three = fakeThree({ isWebGLBackend: true, gl });
    const engine = await createRenderer(canvas, { wantWebGPU: true, tier: TIER_TABLE.high }, { construct: three.construct });
    expect(canvas.asked).toEqual([]);
    expect(three.seen.parameters).toEqual({ canvas, forceWebGL: false, antialias: false, powerPreference: 'high-performance' });
    expect(engine.backend).toBe('webgl2');
    expect(engine.caps.unmaskedRenderer).toBe(SWIFTSHADER);
    expect(engine.software).toBe(true);
  });

  it('a real WebGPU backend is reported as webgpu: no renderer string, half float is core', async () => {
    const backend = { isWebGPUBackend: true, device: { limits: { maxTextureDimension2D: 16384, maxTextureDimension3D: 2048, maxTextureArrayLayers: 256 }, features: new Set(['float32-filterable']) } };
    const three = fakeThree(backend, { features: ['texture-compression-bc'] });
    const engine = await createRenderer(fakeCanvas(null), { wantWebGPU: true, tier: TIER_TABLE.high }, { construct: three.construct });
    expect(engine.backend).toBe('webgpu');
    expect(engine.caps).toMatchObject({ backend: 'webgpu', unmaskedRenderer: null, software: false, halfFloatRenderTargets: true, maxTextureSize: 16384, floatTextureLinear: true, outputBuffer: 'half-float', compressed: { bc: true } });
  });

  it('when even the fallback cannot initialise (no WebGL2 either) the error is RendererUnsupported', async () => {
    const three = fakeThree({ isWebGPUBackend: true }, { initFails: new TypeError("Cannot read properties of null (reading 'getExtension')") });
    await expect(createRenderer(fakeCanvas(null), { wantWebGPU: true, tier: TIER_TABLE.high }, { construct: three.construct })).rejects.toBeInstanceOf(RendererUnsupported);
  });
});

describe('capabilities', () => {
  it('readGlFacts reads the unmasked strings, the render-target extensions and the limits', () => {
    expect(readGlFacts(fakeGl({ renderer: INTEL, maxTexture: 16384 }) as unknown as WebGL2RenderingContext)).toEqual({
      unmaskedRenderer: INTEL,
      unmaskedVendor: 'Google Inc. (Google)',
      halfFloatRenderable: true,
      floatRenderable: true,
      floatLinear: true,
      maxTextureSize: 16384,
      max3dTextureSize: 2048,
      maxArrayLayers: 2048,
    });
  });

  it('backendOf follows renderer.backend.isWebGLBackend', () => {
    expect(backendOf({ backend: { isWebGLBackend: true } })).toBe('webgl2');
    expect(backendOf({ backend: { isWebGPUBackend: true } })).toBe('webgpu');
  });

  it('a hasFeature that throws (renderer not initialised) reads as unsupported', () => {
    const caps = readDeviceCaps({
      backend: { isWebGLBackend: true, gl: fakeGl() },
      hasFeature: () => {
        throw new Error('not initialised');
      },
    });
    expect(Object.values(caps.compressed)).toEqual([false, false, false, false, false, false]);
  });

  it.each(['llvmpipe (LLVM 15.0.7, 256 bits)', SWIFTSHADER, 'Software Rasterizer'])('software: %s', (renderer) => {
    expect(readDeviceCaps({ backend: { isWebGLBackend: true, gl: fakeGl({ renderer }) }, hasFeature: () => false }).software).toBe(true);
  });
});

describe('installDeviceLossHandler (render §3.1 policy step 1)', () => {
  const info: DeviceLostInfo = { api: 'WebGL', message: 'context lost', reason: null };

  it('calls the base handler with the renderer as `this`, then onLost, once each per loss', () => {
    const order: string[] = [];
    const renderer = {
      flag: false,
      onDeviceLost(this: { flag: boolean }, i: DeviceLostInfo): void {
        this.flag = true;
        order.push(`base:${i.api}`);
      },
    };
    installDeviceLossHandler(renderer, (i) => order.push(`ours:${i.message}`));
    renderer.onDeviceLost(info);
    expect(order).toEqual(['base:WebGL', 'ours:context lost']);
    expect(renderer.flag).toBe(true);
  });

  it('wraps three’s real default handler: the renderer is marked lost (render() then returns at once) and we are told', () => {
    const canvas = { width: 300, height: 150, style: {}, addEventListener() {}, removeEventListener() {} } as unknown as HTMLCanvasElement;
    const renderer = new WebGPURenderer({ forceWebGL: true, canvas });
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const lost: DeviceLostInfo[] = [];
    installDeviceLossHandler(renderer, (i) => lost.push(i));

    // what three's WebGL backend does on `webglcontextlost`
    renderer.onDeviceLost({ api: 'WebGL', message: 'Unknown reason', reason: null, originalEvent: {} } as never);

    expect((renderer as unknown as { _isDeviceLost: boolean })._isDeviceLost).toBe(true);
    expect(lost).toEqual([{ api: 'WebGL', message: 'Unknown reason', reason: null, originalEvent: {} }]);
    expect(logged.mock.calls.flat().join(' ')).toMatch(/Device Lost/);
  });

  it('the returned function puts the previous handler back', () => {
    let base = 0;
    let ours = 0;
    const renderer = { onDeviceLost: (_i: DeviceLostInfo): void => void base++ };
    const original = renderer.onDeviceLost;
    const uninstall = installDeviceLossHandler(renderer, () => ours++);
    uninstall();
    expect(renderer.onDeviceLost).toBe(original);
    renderer.onDeviceLost(info);
    expect([base, ours]).toEqual([1, 0]);
  });

  it('the message for the platform chrome', () => {
    expect(DEVICE_RESET_MESSAGE).toBe('GRAPHICS DEVICE RESET');
  });
});
