// Tier detection (docs/design/rendering.md §15.1; docs/architecture.md X-21, X-22; WP R0).
//
// Engine-free: the app shell runs `detectTier()` at boot, before any game module evaluates and long before the engine chunk
// loads (the gore caps of host edit H05 depend on the tier). The probe is a throwaway WebGL2 context that is read and released;
// nothing here imports three.js or an engine module (X-26).
//
// Selection order (render §15.1): the user's SETTINGS pick > the `?tier=` dev flag > detection, and detection is
//   software renderer → `minimum`; no half-float render target → `minimum`; mobile → `minimum`; tablet → `low`;
//   every desktop → `high`, whatever the GPU string (integrated Intel/AMD/Apple included) and whether or not it is masked.
// A desktop leaves `high` only through the governor (render §15.2). The selection is a pure function of its inputs, so the
// whole matrix runs on synthetic caps in Node (tests/unit/render/tiers.node.test.ts).
import { isTierId, type TierId } from './budget.ts';

/** `bridge.device.type` (PlatformRenderHooks.deviceType, render §21) */
export type DeviceType = 'mobile' | 'tablet' | 'desktop' | 'tv';

/** the SETTINGS quality row (X-22): LOW maps to `low`; `minimum` is not offered */
export type TierPick = 'auto' | 'low' | 'medium' | 'high';

/** what the throwaway context told us */
export interface TierProbe {
  /** a WebGL2 context could be created */
  webgl2: boolean;
  /** `UNMASKED_RENDERER_WEBGL`; null without WebGL2 or without `WEBGL_debug_renderer_info` */
  unmaskedRenderer: string | null;
  /** `EXT_color_buffer_float` or `EXT_color_buffer_half_float` (the scene pass renders to half float, render §3.1) */
  halfFloatRenderable: boolean;
}

export interface TierInputs {
  deviceType: DeviceType;
  probe: TierProbe;
  /** `settings.quality[deviceType]`; absent, null or `'auto'` = no pick */
  userPick?: TierPick | null;
  /** the value of `?tier=`; anything that is not a tier id is ignored */
  tierParam?: string | null;
}

export interface TierDetection {
  /** false: no WebGL2. The boot sequence shows the styled fatal screen (docs/architecture.md §5.6); `tier` is then `minimum`. */
  supported: boolean;
  tier: TierId;
  /** which rule decided */
  source: 'user' | 'flag' | 'software' | 'caps' | 'device' | 'unsupported';
  /** the unmasked renderer string names a software rasteriser */
  software: boolean;
  unmaskedRenderer: string | null;
  halfFloatRenderable: boolean;
}

/** render §3.1: matched on the unmasked renderer string (the plain `RENDERER` string reads "WebKit WebGL") */
export const SOFTWARE_RENDERER = /SwiftShader|llvmpipe|Software/i;

export function isSoftwareRenderer(unmaskedRenderer: string | null | undefined): boolean {
  return typeof unmaskedRenderer === 'string' && SOFTWARE_RENDERER.test(unmaskedRenderer);
}

const NO_WEBGL2: TierProbe = Object.freeze({ webgl2: false, unmaskedRenderer: null, halfFloatRenderable: false });

const DEVICE_TIER: Readonly<Record<DeviceType, TierId>> = Object.freeze({
  desktop: 'high',
  tablet: 'low',
  // a TV browser is a weak SoC behind a large panel; render §15.1 names no row for it, so it shares the tablet's
  tv: 'low',
  mobile: 'minimum',
});

const USER_TIER: Readonly<Record<Exclude<TierPick, 'auto'>, TierId>> = Object.freeze({ low: 'low', medium: 'medium', high: 'high' });

/** The pure selection (render §15.1). */
export function selectTier(inputs: TierInputs): TierDetection {
  const { probe } = inputs;
  const software = isSoftwareRenderer(probe.unmaskedRenderer);
  const facts = { software, unmaskedRenderer: probe.unmaskedRenderer, halfFloatRenderable: probe.halfFloatRenderable };
  if (!probe.webgl2) return { supported: false, tier: 'minimum', source: 'unsupported', ...facts };

  const pick = inputs.userPick;
  if (pick !== undefined && pick !== null && pick !== 'auto' && Object.hasOwn(USER_TIER, pick)) {
    return { supported: true, tier: USER_TIER[pick], source: 'user', ...facts };
  }
  const flag = typeof inputs.tierParam === 'string' ? inputs.tierParam.toLowerCase() : null;
  if (isTierId(flag)) return { supported: true, tier: flag, source: 'flag', ...facts };

  if (software) return { supported: true, tier: 'minimum', source: 'software', ...facts };
  if (!probe.halfFloatRenderable) return { supported: true, tier: 'minimum', source: 'caps', ...facts };
  return { supported: true, tier: DEVICE_TIER[inputs.deviceType] ?? 'high', source: 'device', ...facts };
}

/** `?tier=` of a query string (`location.search`); null when absent */
export function tierParamFromSearch(search: string): string | null {
  return new URLSearchParams(search).get('tier');
}

/** `UNMASKED_RENDERER_WEBGL` of a context; null without `WEBGL_debug_renderer_info` */
export function readUnmaskedRenderer(gl: Pick<WebGL2RenderingContext, 'getExtension' | 'getParameter'>): string | null {
  const ext = gl.getExtension('WEBGL_debug_renderer_info') as { UNMASKED_RENDERER_WEBGL: number } | null;
  if (ext === null || ext === undefined) return null;
  const value: unknown = gl.getParameter(ext.UNMASKED_RENDERER_WEBGL);
  return typeof value === 'string' && value !== '' ? value : null;
}

/** the context can render to RGBA16F (render §3.1: either extension is enough) */
export function readHalfFloatRenderable(gl: Pick<WebGL2RenderingContext, 'getExtension'>): boolean {
  return gl.getExtension('EXT_color_buffer_float') !== null || gl.getExtension('EXT_color_buffer_half_float') !== null;
}

/** the attributes of the game's own context (render §3.1), so the probe meets the same GPU on a dual-GPU machine */
export const PROBE_CONTEXT_ATTRIBUTES: WebGLContextAttributes = Object.freeze({
  powerPreference: 'high-performance',
  antialias: false,
  alpha: true,
  depth: false,
  stencil: false,
});

/**
 * Creates a WebGL2 context on a throwaway canvas, reads the renderer string and the half-float extensions, and releases the
 * context (`WEBGL_lose_context`, and a 0 × 0 backing store). `createCanvas` defaults to `document.createElement('canvas')`;
 * without a document (Node) there is nothing to probe and the result says no WebGL2.
 */
export function probeWebGL2(createCanvas?: () => HTMLCanvasElement): TierProbe {
  const make = createCanvas ?? (typeof document !== 'undefined' ? (): HTMLCanvasElement => document.createElement('canvas') : null);
  if (make === null) return { ...NO_WEBGL2 };
  let canvas: HTMLCanvasElement;
  let gl: WebGL2RenderingContext | null;
  try {
    canvas = make();
    canvas.width = 1;
    canvas.height = 1;
    gl = canvas.getContext('webgl2', PROBE_CONTEXT_ATTRIBUTES) as WebGL2RenderingContext | null;
  } catch {
    return { ...NO_WEBGL2 };
  }
  if (gl === null || gl === undefined) return { ...NO_WEBGL2 };
  try {
    return { webgl2: true, unmaskedRenderer: readUnmaskedRenderer(gl), halfFloatRenderable: readHalfFloatRenderable(gl) };
  } finally {
    (gl.getExtension('WEBGL_lose_context') as { loseContext(): void } | null)?.loseContext();
    canvas.width = 0;
    canvas.height = 0;
  }
}

export interface DetectTierOptions {
  /** `platform.device.type` */
  deviceType: DeviceType;
  /** the saved SETTINGS pick */
  userPick?: TierPick | null;
  /** the page's query string; `?tier=` is read from it */
  search?: string;
  /** a probe already taken (the engine passes its own context's facts); otherwise a throwaway context is probed */
  probe?: TierProbe;
  /** canvas factory for the probe (tests) */
  createCanvas?: () => HTMLCanvasElement;
}

/** The boot-time tier: probe, then select (X-21: before the `boot` preload set evaluates). */
export function detectTier(opts: DetectTierOptions): TierDetection {
  const probe = opts.probe ?? probeWebGL2(opts.createCanvas);
  return selectTier({
    deviceType: opts.deviceType,
    probe,
    userPick: opts.userPick ?? null,
    tierParam: opts.search === undefined ? null : tierParamFromSearch(opts.search),
  });
}
