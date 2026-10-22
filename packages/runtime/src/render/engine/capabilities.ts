// Device capabilities (docs/design/rendering.md §3.1; WP R0): half-float render targets, float texture sampling, the maximum
// texture size, the compressed formats (through `renderer.hasFeature`) and the unmasked renderer string behind `gpuInfo()`.
//
// Required caps [D]: rendering to half float (`EXT_color_buffer_float` or `EXT_color_buffer_half_float`) for the scene pass, and
// RGBA32F / RG32F / R32F textures read with `textureLoad` (`NearestFilter`; WebGL2 core, no float filtering needed) for the
// light, cell, paint and look tables. Integer textures are not used: every table holds exact integers in float channels (≤ 2²⁴).
//
// A device with neither colour-buffer extension renders to 8-bit: `outputBufferType: UnsignedByteType`, tier `minimum`, bloom
// off (it could not contribute), emissive pre-clamped to 1 and the LUT shaper range cut to 2⁻¹²..2⁰ (render §10.6). That path
// is an accepted deviation and is carried here as flags for the packages that act on them (R1a, R5b); telemetry counts it.
//
// No three.js value import: the renderer is read through `hasFeature` and its backend, the context through the WebGL2 API.
import { isSoftwareRenderer, readHalfFloatRenderable, readUnmaskedRenderer } from '../perf/tiers.ts';

export type RenderBackend = 'webgl2' | 'webgpu';

/** what a WebGL2 context says about the device, read before or after the renderer exists */
export interface GlFacts {
  unmaskedRenderer: string | null;
  unmaskedVendor: string | null;
  /** `EXT_color_buffer_float` or `EXT_color_buffer_half_float` */
  halfFloatRenderable: boolean;
  /** `EXT_color_buffer_float` (RGBA32F render targets) */
  floatRenderable: boolean;
  /** `OES_texture_float_linear` */
  floatLinear: boolean;
  maxTextureSize: number;
  max3dTextureSize: number;
  maxArrayLayers: number;
}

export interface CompressedFormats {
  astc: boolean;
  etc2: boolean;
  etc1: boolean;
  /** BC7 / BC6H (`EXT_texture_compression_bptc`, WebGPU `texture-compression-bc`) */
  bc: boolean;
  /** BC1-BC3 (`WEBGL_compressed_texture_s3tc`) */
  s3tc: boolean;
  pvrtc: boolean;
}

export interface DeviceCaps {
  backend: RenderBackend;
  /** `UNMASKED_RENDERER_WEBGL` of the renderer's own context; null on a real WebGPU backend or without the debug extension */
  unmaskedRenderer: string | null;
  unmaskedVendor: string | null;
  /** the unmasked renderer string names a software rasteriser (`/SwiftShader|llvmpipe|Software/i`) */
  software: boolean;
  /** the scene pass can render to RGBA16F */
  halfFloatRenderTargets: boolean;
  floatRenderTargets: boolean;
  /** RGBA32F / RG32F / R32F textures read with `textureLoad` and `NearestFilter`: core in WebGL2 and in WebGPU */
  floatTextureLoad: boolean;
  /** linear filtering of float textures (not needed by the tables) */
  floatTextureLinear: boolean;
  maxTextureSize: number;
  max3dTextureSize: number;
  maxArrayLayers: number;
  compressed: CompressedFormats;

  // the 8-bit path (render §3.1): flags for later work packages
  /** `renderer.getOutputBufferType()`: half float unless the device cannot render to it */
  outputBuffer: 'half-float' | 'unsigned-byte';
  /** false on the 8-bit path: a clipped scene gives the high-pass nothing to pass */
  bloom: boolean;
  /** emissive is pre-clamped to this on the 8-bit path; null = unclamped HDR */
  emissiveClamp: number | null;
  /** log2 range of the LUT shaper: [−12, 4], or [−12, 0] on the 8-bit path (render §10.6) */
  lutShaperLog2: readonly [number, number];
  /** true when the 8-bit path is active (counted in telemetry as an accepted deviation) */
  eightBitDeviation: boolean;
}

type Gl = Pick<WebGL2RenderingContext, 'getExtension' | 'getParameter'>;

// WebGL2 enums, spelled out so the module needs no context to read them from
const GL_MAX_TEXTURE_SIZE = 0x0d33;
const GL_MAX_3D_TEXTURE_SIZE = 0x8073;
const GL_MAX_ARRAY_TEXTURE_LAYERS = 0x88ff;

const int = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function readGlFacts(gl: Gl): GlFacts {
  const debug = gl.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_VENDOR_WEBGL: number } | null;
  const vendor: unknown = debug === null || debug === undefined ? null : gl.getParameter(debug.UNMASKED_VENDOR_WEBGL);
  return {
    unmaskedRenderer: readUnmaskedRenderer(gl),
    unmaskedVendor: typeof vendor === 'string' && vendor !== '' ? vendor : null,
    halfFloatRenderable: readHalfFloatRenderable(gl),
    floatRenderable: gl.getExtension('EXT_color_buffer_float') !== null,
    floatLinear: gl.getExtension('OES_texture_float_linear') !== null,
    maxTextureSize: int(gl.getParameter(GL_MAX_TEXTURE_SIZE)),
    max3dTextureSize: int(gl.getParameter(GL_MAX_3D_TEXTURE_SIZE)),
    maxArrayLayers: int(gl.getParameter(GL_MAX_ARRAY_TEXTURE_LAYERS)),
  };
}

/** the renderer as far as the caps need it (after `init()`) */
export interface CapsRenderer {
  hasFeature(name: string): boolean;
  backend: unknown;
}

interface BackendLike {
  isWebGLBackend?: boolean;
  gl?: Gl | null;
  device?: { limits?: { maxTextureDimension2D?: number; maxTextureDimension3D?: number; maxTextureArrayLayers?: number }; features?: { has(name: string): boolean } } | null;
}

/** `renderer.backend.isWebGLBackend ? 'webgl2' : 'webgpu'` (render §3.1) */
export function backendOf(renderer: Pick<CapsRenderer, 'backend'>): RenderBackend {
  return (renderer.backend as BackendLike | null)?.isWebGLBackend === true ? 'webgl2' : 'webgpu';
}

/** The WebGL2 context the WebGL backend draws with (ours, or the one three made on the `?renderer=webgpu` fallback); null on WebGPU. */
export function backendGl(renderer: Pick<CapsRenderer, 'backend'>): Gl | null {
  const b = renderer.backend as BackendLike | null;
  return b?.isWebGLBackend === true ? (b.gl ?? null) : null;
}

/** the feature names of three's backends (`GLFeatureName`, `GPUFeatureName`); KTX2Loader.detectSupport asks the same ones */
function compressedFormats(renderer: CapsRenderer): CompressedFormats {
  const has = (name: string): boolean => {
    try {
      return renderer.hasFeature(name) === true;
    } catch {
      return false;
    }
  };
  return {
    astc: has('texture-compression-astc'),
    etc2: has('texture-compression-etc2'),
    etc1: has('texture-compression-etc1'),
    bc: has('texture-compression-bc'),
    s3tc: has('texture-compression-s3tc'),
    pvrtc: has('texture-compression-pvrtc'),
  };
}

/**
 * The caps of an initialised renderer. `facts` are the facts of our own context when we created one (the default path);
 * otherwise they are read from the backend's context (the WebGL2 fallback of `?renderer=webgpu`), or there are none (a real
 * WebGPU device: half float is core there, and the renderer string stays null).
 */
export function readDeviceCaps(renderer: CapsRenderer, facts?: GlFacts | null): DeviceCaps {
  const backend = backendOf(renderer);
  const gl = backendGl(renderer);
  const f = facts ?? (gl !== null ? readGlFacts(gl) : null);
  const limits = (renderer.backend as BackendLike | null)?.device?.limits;
  const halfFloat = f === null ? true : f.halfFloatRenderable;
  return {
    backend,
    unmaskedRenderer: f?.unmaskedRenderer ?? null,
    unmaskedVendor: f?.unmaskedVendor ?? null,
    software: isSoftwareRenderer(f?.unmaskedRenderer),
    halfFloatRenderTargets: halfFloat,
    floatRenderTargets: f === null ? true : f.floatRenderable,
    floatTextureLoad: true,
    floatTextureLinear: f === null ? ((renderer.backend as BackendLike | null)?.device?.features?.has('float32-filterable') ?? false) : f.floatLinear,
    maxTextureSize: f?.maxTextureSize ?? int(limits?.maxTextureDimension2D),
    max3dTextureSize: f?.max3dTextureSize ?? int(limits?.maxTextureDimension3D),
    maxArrayLayers: f?.maxArrayLayers ?? int(limits?.maxTextureArrayLayers),
    compressed: compressedFormats(renderer),
    outputBuffer: halfFloat ? 'half-float' : 'unsigned-byte',
    bloom: halfFloat,
    emissiveClamp: halfFloat ? null : 1,
    lutShaperLog2: halfFloat ? [-12, 4] : [-12, 0],
    eightBitDeviation: !halfFloat,
  };
}

/** `Renderer.gpuInfo()` (docs/architecture.md §3.0): X1 publishes `unmaskedRenderer` as `glRenderer` for the gpuGuard */
export interface GpuInfo {
  backend: RenderBackend;
  unmaskedRenderer: string | null;
  software: boolean;
}

export function gpuInfoOf(caps: Pick<DeviceCaps, 'backend' | 'unmaskedRenderer' | 'software'>): GpuInfo {
  return { backend: caps.backend, unmaskedRenderer: caps.unmaskedRenderer, software: caps.software };
}
