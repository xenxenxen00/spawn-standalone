// Renderer creation (docs/design/rendering.md §3.1; docs/architecture.md X-46, D-15; WP R0).
//
//   default       three's `WebGPURenderer` on its WebGL2 backend (`forceWebGL: true`) on a context we create ourselves, because
//                 three's WebGL backend creates its context with only `{antialias, alpha, depth, stencil}` and passes no
//                 `powerPreference`. `alpha` stays true, as the backend assumes. The classic `WebGLRenderer` is never used.
//   output        `outputBufferType` is `HalfFloatType` on every tier, `minimum` included; the scene pass follows it and nothing
//                 else (`PassNode.setup()` overwrites its target type with `renderer.getOutputBufferType()`, so a
//                 `pass(scene, camera, { type })` option has no effect). `UnsignedByteType` only on a device that cannot render to
//                 half float (capabilities.ts carries the flags of that path).
//   WebGPU flag   `?renderer=webgpu` (and the dev SETTINGS option) → `forceWebGL: false`, no own context. `init()` falls back to
//                 the WebGL2 backend by itself when there is no `navigator.gpu`, no adapter, or `requestAdapter()` fails.
//   no WebGL2     `RendererUnsupported`; the platform layer shows a styled message (no `alert`). The boot probe has normally
//                 caught this already (X-21).
//   device loss   three's backends forward a lost context / device to `renderer.onDeviceLost`; the default handler logs and
//                 sets a flag after which `render()` and `compileAsync()` return at once. `WebGPURenderer` has no restore path.
//                 `installDeviceLossHandler` wraps the default handler; what follows a loss (pause reason `gpu`, the message, and
//                 in X3 the rebuild) is the facade's (src/render/index.ts).
//   program text  every renderer gets `installStablePrograms` (stable-programs.ts) once `init()` has picked the backend: the
//                 shader text of a skinned or an instanced object names no node id and no instance capacity, so equal
//                 structure is one program and the warm-up's proxies stand for the real objects (render §7.2). It also gets
//                 `installProgramRetention` (program-retention.ts): a program whose last user went stays cached, so what the
//                 warm-up linked behind the LOADING hold is never linked again (a runtime tier switch, a rebuilt post graph,
//                 the shadowCaster's shadow off and on; R14b). A renderer rebuilt after a device loss is made here too.
import { HalfFloatType, UnsignedByteType, WebGPURenderer } from 'three/webgpu';
import type { TierConfig } from '../perf/budget.ts';
import { backendGl, backendOf, readDeviceCaps, readGlFacts, type DeviceCaps, type GlFacts, type RenderBackend } from './capabilities.ts';
import { installProgramRetention } from './program-retention.ts';
import { installStablePrograms } from './stable-programs.ts';

/** render §3.1 */
export interface RenderEngine {
  renderer: WebGPURenderer;
  backend: RenderBackend;
  caps: DeviceCaps;
  software: boolean;
  canvas: HTMLCanvasElement;
}

export interface CreateRendererOptions {
  /** `?renderer=webgpu` or the dev SETTINGS option; default builds never set it */
  wantWebGPU: boolean;
  tier: TierConfig;
}

/** There is no WebGL2 (and, with the WebGPU flag, no WebGPU either), or the renderer could not initialise on it. */
export class RendererUnsupported extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RendererUnsupported';
  }
}

/** the attributes of our own context (render §3.1) */
export const WEBGL2_CONTEXT_ATTRIBUTES: WebGLContextAttributes = Object.freeze({
  powerPreference: 'high-performance',
  antialias: false,
  alpha: true,
  depth: true,
  stencil: false,
});

/** the platform chrome's text for pause reason `gpu` (render §3.1 device-loss step 1) */
export const DEVICE_RESET_MESSAGE = 'GRAPHICS DEVICE RESET';

/** `true` when the page URL asks for the WebGPU backend: `?renderer=webgpu` */
export function wantsWebGPU(search: string): boolean {
  return new URLSearchParams(search).get('renderer') === 'webgpu';
}

export type RendererParameters = NonNullable<ConstructorParameters<typeof WebGPURenderer>[0]>;

/**
 * The constructor parameters of each path. `context` is our own WebGL2 context (three types the option for the WebGPU
 * backend only; the WebGL backend takes `parameters.context` as its GL context).
 */
export function rendererParameters(canvas: HTMLCanvasElement, wantWebGPU: boolean, context: WebGL2RenderingContext | null, halfFloat: boolean): RendererParameters {
  if (wantWebGPU) {
    return { canvas, forceWebGL: false, antialias: false, powerPreference: 'high-performance' };
  }
  return {
    canvas,
    context: context as unknown as GPUCanvasContext,
    forceWebGL: true,
    antialias: false,
    depth: true,
    stencil: false,
    outputBufferType: halfFloat ? HalfFloatType : UnsignedByteType,
  };
}

export interface CreateRendererSeams {
  /** builds the three renderer from its parameters (tests replace it; the default is `new WebGPURenderer(parameters)`) */
  construct?: (parameters: RendererParameters) => WebGPURenderer;
}

/**
 * Creates and initialises the renderer on `canvas`. The tier does not change how the renderer is created (half float on every
 * tier); it is part of the signature of render §3.1 and is what the canvas host sizes the canvas with.
 */
export async function createRenderer(canvas: HTMLCanvasElement, opts: CreateRendererOptions, seams: CreateRendererSeams = {}): Promise<RenderEngine> {
  const construct = seams.construct ?? ((parameters: RendererParameters): WebGPURenderer => new WebGPURenderer(parameters));
  let facts: GlFacts | null = null;
  let parameters: RendererParameters;

  if (opts.wantWebGPU) {
    // no context of our own: a canvas that already holds a webgl2 context cannot give three a webgpu one
    parameters = rendererParameters(canvas, true, null, true);
  } else {
    let gl: WebGL2RenderingContext | null;
    try {
      gl = canvas.getContext('webgl2', WEBGL2_CONTEXT_ATTRIBUTES) as WebGL2RenderingContext | null;
    } catch (e) {
      throw new RendererUnsupported('WebGL2 is not available on this device', { cause: e });
    }
    if (gl === null || gl === undefined) throw new RendererUnsupported('WebGL2 is not available on this device');
    facts = readGlFacts(gl);
    parameters = rendererParameters(canvas, false, gl, facts.halfFloatRenderable);
  }

  let renderer: WebGPURenderer;
  try {
    renderer = construct(parameters);
    await renderer.init();
  } catch (e) {
    throw new RendererUnsupported('the renderer could not be initialised', { cause: e });
  }
  installStablePrograms(renderer);
  installProgramRetention(renderer);

  // on the WebGPU path the facts come from the backend's own context when three fell back to WebGL2, else there are none
  const caps = readDeviceCaps(renderer, facts);
  return { renderer, backend: backendOf(renderer), caps, software: caps.software, canvas };
}

/** what three's backends report on a lost WebGL context or WebGPU device */
export interface DeviceLostInfo {
  api: string;
  message: string;
  reason: string | null;
  originalEvent?: unknown;
}

/**
 * Wraps the renderer's device-loss handler (render §3.1 policy step 1): the previous handler runs first (three's default logs
 * and sets the flag that makes `render()` and `compileAsync()` return at once), then `onLost`. Returns a function that puts
 * the previous handler back.
 */
export function installDeviceLossHandler<I extends DeviceLostInfo>(renderer: { onDeviceLost: (info: I) => void }, onLost: (info: I) => void): () => void {
  const base = renderer.onDeviceLost;
  const wrapped = (info: I): void => {
    base.call(renderer, info);
    onLost(info);
  };
  renderer.onDeviceLost = wrapped;
  return () => {
    if (renderer.onDeviceLost === wrapped) renderer.onDeviceLost = base;
  };
}

/** The WebGL2 context of a WebGL-backend renderer (ours on the default path); null on a real WebGPU backend. */
export function rendererGl(renderer: Pick<WebGPURenderer, 'backend'>): WebGL2RenderingContext | null {
  return backendGl(renderer) as WebGL2RenderingContext | null;
}
