// WP R0: tier detection on synthetic caps (render §15.1, §18.1; X-21, X-22). Selection order: user setting > `?tier=` dev flag >
// detection (software renderer → minimum; mobile → minimum; tablet → low; every desktop → high, whatever the GPU string and
// whether or not it is masked). The probe itself is engine-free: a throwaway WebGL2 context, read and released.
import { describe, expect, it } from 'vitest';
import {
  detectTier,
  isSoftwareRenderer,
  probeWebGL2,
  readHalfFloatRenderable,
  readUnmaskedRenderer,
  selectTier,
  tierParamFromSearch,
  type DeviceType,
  type TierProbe,
} from '../../../src/render/perf/tiers.ts';

const probe = (unmaskedRenderer: string | null, over: Partial<TierProbe> = {}): TierProbe => ({ webgl2: true, unmaskedRenderer, halfFloatRenderable: true, ...over });

const SWIFTSHADER = 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)';
const INTEL = 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)';
const NVIDIA = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 2070 Direct3D11 vs_5_0 ps_5_0, D3D11)';

describe('software renderer detection (render §3.1)', () => {
  it.each([SWIFTSHADER, 'llvmpipe (LLVM 15.0.7, 256 bits)', 'Google SwiftShader', 'Microsoft Basic Render Driver (Software)'])('%s is software', (s) => {
    expect(isSoftwareRenderer(s)).toBe(true);
  });
  it.each([INTEL, NVIDIA, 'Apple M2', 'WebKit WebGL', 'Mali-G78', null, ''])('%s is not', (s) => {
    expect(isSoftwareRenderer(s)).toBe(false);
  });
});

describe('selectTier: detection matrix', () => {
  it('a desktop with an integrated GPU → high', () => {
    for (const s of [INTEL, 'Intel(R) UHD Graphics', 'ANGLE (AMD, AMD Radeon(TM) Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Apple M1', 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)']) {
      expect(selectTier({ deviceType: 'desktop', probe: probe(s) }), s).toMatchObject({ supported: true, tier: 'high', source: 'device', software: false });
    }
  });

  it('a desktop with a masked renderer string → high', () => {
    expect(selectTier({ deviceType: 'desktop', probe: probe('WebKit WebGL') })).toMatchObject({ tier: 'high', source: 'device' });
    expect(selectTier({ deviceType: 'desktop', probe: probe(null) })).toMatchObject({ tier: 'high', source: 'device', unmaskedRenderer: null });
    expect(selectTier({ deviceType: 'desktop', probe: probe('') })).toMatchObject({ tier: 'high' });
  });

  it('a desktop with a discrete GPU → high', () => {
    expect(selectTier({ deviceType: 'desktop', probe: probe(NVIDIA) }).tier).toBe('high');
  });

  it('SwiftShader → minimum, on every device type', () => {
    for (const deviceType of ['desktop', 'mobile', 'tablet', 'tv'] as DeviceType[]) {
      expect(selectTier({ deviceType, probe: probe(SWIFTSHADER) }), deviceType).toMatchObject({ tier: 'minimum', source: 'software', software: true, unmaskedRenderer: SWIFTSHADER });
    }
    expect(selectTier({ deviceType: 'desktop', probe: probe('llvmpipe (LLVM 15.0.7, 256 bits)') }).tier).toBe('minimum');
  });

  it('mobile → minimum, tablet → low, tv → low', () => {
    expect(selectTier({ deviceType: 'mobile', probe: probe('Mali-G78') })).toMatchObject({ tier: 'minimum', source: 'device' });
    expect(selectTier({ deviceType: 'tablet', probe: probe('Apple GPU') })).toMatchObject({ tier: 'low', source: 'device' });
    expect(selectTier({ deviceType: 'tv', probe: probe('Mali-G52') })).toMatchObject({ tier: 'low', source: 'device' });
  });

  it('a device that cannot render to half float → minimum (the 8-bit path, render §3.1)', () => {
    expect(selectTier({ deviceType: 'desktop', probe: probe(INTEL, { halfFloatRenderable: false }) })).toMatchObject({ tier: 'minimum', source: 'caps', halfFloatRenderable: false });
  });

  it('no WebGL2 → unsupported (the boot sequence shows the fatal screen)', () => {
    const r = selectTier({ deviceType: 'desktop', probe: { webgl2: false, unmaskedRenderer: null, halfFloatRenderable: false } });
    expect(r).toMatchObject({ supported: false, source: 'unsupported', tier: 'minimum' });
    // the user's pick does not make a missing context supported
    expect(selectTier({ deviceType: 'desktop', probe: { webgl2: false, unmaskedRenderer: null, halfFloatRenderable: false }, userPick: 'high' }).supported).toBe(false);
  });
});

describe('selectTier: precedence (user setting > ?tier= > detection)', () => {
  it('the SETTINGS pick wins over detection: LOW → low, MEDIUM → medium, HIGH → high', () => {
    expect(selectTier({ deviceType: 'desktop', probe: probe(NVIDIA), userPick: 'low' })).toMatchObject({ tier: 'low', source: 'user' });
    expect(selectTier({ deviceType: 'desktop', probe: probe(NVIDIA), userPick: 'medium' })).toMatchObject({ tier: 'medium', source: 'user' });
    expect(selectTier({ deviceType: 'mobile', probe: probe('Mali-G78'), userPick: 'high' })).toMatchObject({ tier: 'high', source: 'user' });
  });

  it('the SETTINGS pick wins over the software rule (a test may ask for another tier)', () => {
    expect(selectTier({ deviceType: 'desktop', probe: probe(SWIFTSHADER), userPick: 'high' })).toMatchObject({ tier: 'high', source: 'user', software: true });
  });

  it('AUTO (or no setting) falls through to the flag and then to detection', () => {
    expect(selectTier({ deviceType: 'desktop', probe: probe(NVIDIA), userPick: 'auto' })).toMatchObject({ tier: 'high', source: 'device' });
    expect(selectTier({ deviceType: 'desktop', probe: probe(NVIDIA), userPick: null })).toMatchObject({ tier: 'high', source: 'device' });
    expect(selectTier({ deviceType: 'desktop', probe: probe(NVIDIA), userPick: 'auto', tierParam: 'low' })).toMatchObject({ tier: 'low', source: 'flag' });
  });

  it('the SETTINGS pick wins over ?tier=', () => {
    expect(selectTier({ deviceType: 'desktop', probe: probe(NVIDIA), userPick: 'medium', tierParam: 'minimum' })).toMatchObject({ tier: 'medium', source: 'user' });
  });

  it('?tier= wins over detection and can name `minimum`, which SETTINGS cannot (X-22)', () => {
    expect(selectTier({ deviceType: 'desktop', probe: probe(NVIDIA), tierParam: 'minimum' })).toMatchObject({ tier: 'minimum', source: 'flag' });
    expect(selectTier({ deviceType: 'desktop', probe: probe(SWIFTSHADER), tierParam: 'high' })).toMatchObject({ tier: 'high', source: 'flag' });
    expect(selectTier({ deviceType: 'desktop', probe: probe(NVIDIA), userPick: 'minimum' as never })).toMatchObject({ tier: 'high', source: 'device' });
  });

  it('an unknown ?tier= value is ignored', () => {
    for (const bad of ['ultra', '', 'HIGH ', 'auto', '0']) {
      expect(selectTier({ deviceType: 'tablet', probe: probe('Apple GPU'), tierParam: bad }), bad).toMatchObject({ tier: 'low', source: 'device' });
    }
    expect(selectTier({ deviceType: 'tablet', probe: probe('Apple GPU'), tierParam: 'HIGH' }).tier).toBe('high'); // case-insensitive
  });
});

describe('tierParamFromSearch', () => {
  it('reads ?tier= from a query string', () => {
    expect(tierParamFromSearch('?tier=low')).toBe('low');
    expect(tierParamFromSearch('?renderer=webgpu&tier=minimum&x=1')).toBe('minimum');
    expect(tierParamFromSearch('tier=high')).toBe('high');
    expect(tierParamFromSearch('?renderer=webgpu')).toBeNull();
    expect(tierParamFromSearch('')).toBeNull();
  });
});

// ── the engine-free probe on a fake WebGL2 context ───────────────────────────────────────────────────────────────────────

const UNMASKED_RENDERER_WEBGL = 0x9246;

interface FakeGl {
  getExtension(name: string): unknown;
  getParameter(p: number): unknown;
  lost: number;
  asked: string[];
}

function fakeGl(opts: { renderer?: string | null; exts?: string[] } = {}): FakeGl {
  const exts = new Set(opts.exts ?? ['WEBGL_debug_renderer_info', 'EXT_color_buffer_float', 'EXT_color_buffer_half_float', 'WEBGL_lose_context']);
  const gl: FakeGl = {
    lost: 0,
    asked: [],
    getExtension(name) {
      gl.asked.push(name);
      if (!exts.has(name)) return null;
      if (name === 'WEBGL_debug_renderer_info') return { UNMASKED_RENDERER_WEBGL, UNMASKED_VENDOR_WEBGL: 0x9245 };
      if (name === 'WEBGL_lose_context') return { loseContext: () => void gl.lost++ };
      return {};
    },
    getParameter(p) {
      return p === UNMASKED_RENDERER_WEBGL ? (opts.renderer === undefined ? SWIFTSHADER : opts.renderer) : 'WebKit WebGL';
    },
  };
  return gl;
}

function fakeCanvasFactory(gl: FakeGl | null) {
  const made: Array<{ width: number; height: number; asked: Array<[string, unknown]> }> = [];
  const create = () => {
    const c = {
      width: 300,
      height: 150,
      asked: [] as Array<[string, unknown]>,
      getContext(kind: string, attrs?: unknown) {
        c.asked.push([kind, attrs]);
        return kind === 'webgl2' ? gl : null;
      },
    };
    made.push(c);
    return c as unknown as HTMLCanvasElement;
  };
  return { create, made };
}

describe('readUnmaskedRenderer / readHalfFloatRenderable', () => {
  it('reads UNMASKED_RENDERER_WEBGL, never the masked RENDERER string', () => {
    expect(readUnmaskedRenderer(fakeGl({ renderer: INTEL }) as unknown as WebGL2RenderingContext)).toBe(INTEL);
  });
  it('is null without the debug extension or with a non-string answer', () => {
    expect(readUnmaskedRenderer(fakeGl({ exts: [] }) as unknown as WebGL2RenderingContext)).toBeNull();
    expect(readUnmaskedRenderer(fakeGl({ renderer: null }) as unknown as WebGL2RenderingContext)).toBeNull();
  });
  it('half float is renderable with either colour-buffer extension', () => {
    const gl = (exts: string[]) => fakeGl({ exts }) as unknown as WebGL2RenderingContext;
    expect(readHalfFloatRenderable(gl(['EXT_color_buffer_float']))).toBe(true);
    expect(readHalfFloatRenderable(gl(['EXT_color_buffer_half_float']))).toBe(true);
    expect(readHalfFloatRenderable(gl(['WEBGL_debug_renderer_info']))).toBe(false);
  });
});

describe('probeWebGL2: a throwaway context', () => {
  it('creates one WebGL2 context, reads it and releases it', () => {
    const gl = fakeGl({ renderer: INTEL });
    const { create, made } = fakeCanvasFactory(gl);
    expect(probeWebGL2(create)).toEqual({ webgl2: true, unmaskedRenderer: INTEL, halfFloatRenderable: true });
    expect(made).toHaveLength(1);
    expect(made[0]!.asked.map((a) => a[0])).toEqual(['webgl2']);
    expect(gl.lost).toBe(1);
    expect([made[0]!.width, made[0]!.height]).toEqual([0, 0]); // the backing store is released as well
  });

  it('reports no WebGL2 when the context cannot be created, or creating it throws', () => {
    expect(probeWebGL2(fakeCanvasFactory(null).create)).toEqual({ webgl2: false, unmaskedRenderer: null, halfFloatRenderable: false });
    expect(
      probeWebGL2(() => {
        throw new Error('no canvas');
      }),
    ).toEqual({ webgl2: false, unmaskedRenderer: null, halfFloatRenderable: false });
  });

  it('without a document and without a factory there is nothing to probe (Node)', () => {
    expect(probeWebGL2()).toEqual({ webgl2: false, unmaskedRenderer: null, halfFloatRenderable: false });
  });
});

describe('detectTier: probe + selection', () => {
  it('SwiftShader → minimum; an integrated GPU on a desktop → high', () => {
    expect(detectTier({ deviceType: 'desktop', createCanvas: fakeCanvasFactory(fakeGl()).create })).toMatchObject({ supported: true, tier: 'minimum', software: true });
    expect(detectTier({ deviceType: 'desktop', createCanvas: fakeCanvasFactory(fakeGl({ renderer: INTEL })).create })).toMatchObject({ tier: 'high', software: false });
  });

  it('takes the user pick and the ?tier= flag of the page URL', () => {
    const createCanvas = fakeCanvasFactory(fakeGl({ renderer: INTEL })).create;
    expect(detectTier({ deviceType: 'desktop', createCanvas, search: '?tier=low' })).toMatchObject({ tier: 'low', source: 'flag' });
    expect(detectTier({ deviceType: 'desktop', createCanvas, search: '?tier=low', userPick: 'medium' })).toMatchObject({ tier: 'medium', source: 'user' });
  });

  it('a given probe is used as is (no second context)', () => {
    const { create, made } = fakeCanvasFactory(fakeGl());
    expect(detectTier({ deviceType: 'tablet', createCanvas: create, probe: probe(NVIDIA) })).toMatchObject({ tier: 'low' });
    expect(made).toHaveLength(0);
  });

  it('no WebGL2 → unsupported', () => {
    expect(detectTier({ deviceType: 'desktop', createCanvas: fakeCanvasFactory(null).create })).toMatchObject({ supported: false, source: 'unsupported' });
  });
});
