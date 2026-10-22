// The post pipeline (docs/design/rendering.md §10.1-§10.6, §3.3, §15.1; docs/architecture.md X-46, X-27; WP R5b).
//
// One three `RenderPipeline` whose output node is assembled here per place:
//
//   scene pass          `pass(scene, camera)`: half-float colour + depth, MSAA off. The render scale is written to it and to
//                       nothing else (`setRenderScale`, and the canvas host through the facade).
//   distort             on `high` / `medium`: the scene colour is read at `uv + offset`, the offset coming from a second pass over
//                       `distortScene` at ½ resolution (RG half float, no depth buffer). R10 and R12a put the distort sprites and
//                       the shockwave ring into that scene; while it is empty the pass updates once to clear to a zero
//                       offset and then skips its per-frame update until the scene gains children again. The branch is
//                       in the graph whenever the tier has it, so filling or emptying the scene changes no program. The offset
//                       is what a fragment of that scene writes to (r, g), in `screenUV` units (the output quad's `uv()`, origin
//                       top left): +r reads the scene from further right, +g from lower on the screen.
//   bloom               the fork of three's `BloomNode` (ss-bloom-node.ts) on the undistorted scene colour, five mips from a
//                       constant ½ of the drawing buffer, kernel by `bloomKernel`; its three uniforms are the look params
//                       `bloomStrength`, `bloomRadius`, `bloomThreshold`. Added to the scene colour before the look. Off on a
//                       device that cannot render to half float.
//   output transform    `renderOutput` (three's ACES or Neutral tone mapping at exposure 1, then sRGB), placed by `tonemapOrder`:
//                       `'aces-look'` (default) → the look grades the display frame; `'look-aces'` → the look grades linear HDR
//                       and the transform follows. `outputColorTransform` is false; nothing re-encodes after it.
//   the look            the place's look script as a TSL graph (look-runner.ts, postfx-tsl.ts), its params uniforms.
//   FXAA                `fxaa = 'on'` on a tier that offers it: before the look in `'aces-look'` (so before the grain), after
//                       everything in `'look-aces'`. Off by default; its RTT target has no depth buffer.
//   LUT                 on `low` / `minimum` in `'aces-look'`: the tone map, the OETF and the look's first grade (without its
//                       haze) come from a CPU-baked 32³ half-float `Data3DTexture` read with `lut3D()` through a log2 shaper;
//                       haze, vignette and grain stay TSL after it, in the same order as on desktop (lut-bake.ts). In
//                       `'look-aces'` the low tiers run the full graph.
//
// What rebuilds the graph: another look module, another tone mapping, a changed switch (read at a place build), a tier change
// that moves the look path, the distort pass or FXAA. A look param write does not: `build()` with the same look writes the
// uniforms and rebakes the LUT into the same texture, so no program is created.
//
// The other tier's graph (R14b). A tier switch rebuilds the graph during gameplay (a governor drop at a safe boundary, the player's
// pick), and the graph of the other shape (the LUT path without distort on `low` / `minimum`, the TSL path with it on `high`
// / `medium`) has its own output program. `warmTiers` links it behind the LOADING hold: for each graph shape the given tiers
// reach that this one is not, the graph is built for that tier and drawn once by the caller's frame render, then the graph of
// the pipeline's own tier is built again. The builds are the switch's own (`rebuild` for that tier), so the switch writes the
// same text; program retention (engine/program-retention.ts) keeps what the warm linked, and the switch itself links nothing.
// Once per look, tone mapping and switches: a place with the same graph warms nothing.
import FXAANode from 'three/addons/tsl/display/FXAANode.js';
import { lut3D } from 'three/addons/tsl/display/Lut3DNode.js';
import { convertToTexture, float, log2, max, pass, renderOutput, texture3D, uv, vec4 } from 'three/tsl';
import {
  ACESFilmicToneMapping,
  ClampToEdgeWrapping,
  Color,
  Data3DTexture,
  HalfFloatType,
  LinearFilter,
  NeutralToneMapping,
  NoColorSpace,
  RGBAFormat,
  RGFormat,
  RenderPipeline,
  Scene,
} from 'three/webgpu';
import type { Camera, Node, PassNode, RenderTarget, WebGPURenderer } from 'three/webgpu';
import type { DeviceCaps } from '../engine/capabilities.ts';
import type { PipelineFactory, ScenePipeline } from '../index.ts';
import type { TierConfig, TierId } from '../perf/budget.ts';
import type { LookParams } from './look-recorder.ts';
import { createLookParamStore, runLook, type LookParamStore, type LookParamUniform, type TslLookModule } from './look-runner.ts';
import { LUT3D_VALUES, bakeLookLut, type LutLog2Range } from './lut-bake.ts';
import { LUT_SIZE } from './post-ref.ts';
import { createPostfxEnv, gradeCoreOf, trackCalibrationEnv, withPostfxEnv, type LookDomain, type PostfxEnv } from './postfx-tsl.ts';
import { ssBloom, type BloomKernelId, type StandaloneBloomNode } from './ss-bloom-node.ts';

/** the three calibration switches of the post chain (render §17); the facade wires `calibration.ts` (WP R1a) to them */
export interface PostSwitches {
  /** where the tone map sits against the look (render §10.1) */
  tonemapOrder: 'aces-look' | 'look-aces';
  /** render §10.3 */
  bloomKernel: BloomKernelId;
  /** render §10.2; takes effect only on a tier whose `fxaa` is `'option'` */
  fxaa: 'off' | 'on';
}

/** the defaults ship (X-27) */
export const POST_SWITCH_DEFAULTS: Readonly<PostSwitches> = Object.freeze({ tonemapOrder: 'aces-look', bloomKernel: 'r186', fxaa: 'off' });

export type LookToneMapping = 'aces' | 'neutral';

/** the look before any place is built, and of a place without one: the scene, untouched */
export const IDENTITY_LOOK: TslLookModule = Object.freeze({ look: (ctx: { scene: Node }) => ctx.scene });

/** the distort pass's resolution as a fraction of the drawing buffer (render §10.2) */
export const DISTORT_RESOLUTION = 0.5;

export interface PostPipelineInit {
  renderer: WebGPURenderer;
  scene: Scene;
  camera: Camera;
  /** the 8-bit path: no bloom, the LUT shaper cut to 2⁻¹²..2⁰ (render §3.1) */
  caps: Pick<DeviceCaps, 'bloom' | 'lutShaperLog2'>;
  tier: TierConfig;
  switches?: Partial<PostSwitches>;
  /** the grain's frame seed (default: three's `frameId`); the read-back tests fix it */
  grainFrame?: Node;
  /**
   * opt-in: a linear gain on the scene colour (after the bloom add, before the look and the output transform), as three's
   * `toneMappingExposure` is for the tone map; it reaches the LUT path too. Absent: no node, the graph is unchanged.
   */
  exposure?: number;
}

/** what a built graph consists of, for tests and the dev overlay */
export interface PostPipelineInfo {
  tonemapOrder: PostSwitches['tonemapOrder'];
  bloomKernel: BloomKernelId;
  /** FXAA is in the graph */
  fxaa: boolean;
  /** `'lut'`: the per-colour part comes from the LUT */
  lookPath: 'tsl' | 'lut';
  /** the LUT holds the look's first grade (else only the output transform) */
  lutFolded: boolean;
  distort: boolean;
  bloom: boolean;
  domain: LookDomain;
  toneMapping: LookToneMapping;
  tier: TierId;
  look: TslLookModule;
  /** output graphs built since creation (the graphs `warmTiers` builds for another tier are not counted here) */
  graphBuilds: number;
  /** R14b: the graphs `warmTiers` built and drew for another tier, and the graph shapes it has linked for this graph */
  tierWarm: { builds: number; shapes: string[] };
  pipeline: RenderPipeline;
  outputNode: Node;
  bloomNode: StandaloneBloomNode | null;
  distortPass: PassNode | null;
  fxaaTarget: RenderTarget | null;
  lutTexture: Data3DTexture | null;
}

export interface PostPipeline extends ScenePipeline {
  /**
   * Per place, and on a look param write in dev. With the look module, tone mapping, switches and tier of the built graph this
   * is uniform writes (and a LUT rebake); otherwise the output node is rebuilt.
   */
  build(look: TslLookModule, params: LookParams, toneMapping: LookToneMapping): void;
  setTier(tier: TierConfig): void;
  /**
   * R14b: links the post graph of every shape `tiers` can switch this graph to (see the header). For each shape this graph is
   * not, the graph is built for that tier and `draw` is called once (the caller's frame render, behind the LOADING hold); then
   * the graph of the pipeline's own tier is built again, also when `draw` throws (the error is rethrown). Returns the shapes
   * drawn: 0 when every shape of the given tiers was drawn for this graph already (the same look, tone mapping, switches).
   */
  warmTiers(tiers: readonly TierConfig[], draw: () => void): number;
  /** `scenePass.setResolutionScale(s)` only; the bloom stays at its constant fraction of the drawing buffer (render §3.3) */
  setRenderScale(s: number): void;
  /** Read at the next `build()` ("the switch is read once per place build", render §10.1). */
  setSwitches(switches: Partial<PostSwitches>): void;
  /** The place's fog (R4's `AtmosphereState.fog`): the haze's density and default colour, linear. A uniform write. */
  setFog(density: number, linearColor: readonly number[]): void;
  /** `pipeline.render()` */
  render(): void;
  dispose(): void;
  readonly scenePass: PassNode;
  /** holds only what distorts the frame (R10's distort sprites, R12a's shockwave ring); drawn on `high` / `medium` */
  readonly distortScene: Scene;
  /** the look's param uniforms */
  readonly params: Pick<LookParamStore, 'get' | 'names' | 'values'>;
  readonly env: PostfxEnv;
  inspect(): PostPipelineInfo;
}

const ORDERS: readonly string[] = ['aces-look', 'look-aces'];
const KERNELS: readonly string[] = ['r186', 'unreal-legacy'];
const FXAA: readonly string[] = ['off', 'on'];

function checkSwitches(s: Partial<PostSwitches>): void {
  if (s.tonemapOrder !== undefined && !ORDERS.includes(s.tonemapOrder)) throw new RangeError(`post pipeline: tonemapOrder must be 'aces-look' or 'look-aces', got ${JSON.stringify(s.tonemapOrder)}`);
  if (s.bloomKernel !== undefined && !KERNELS.includes(s.bloomKernel)) throw new RangeError(`post pipeline: bloomKernel must be 'r186' or 'unreal-legacy', got ${JSON.stringify(s.bloomKernel)}`);
  if (s.fxaa !== undefined && !FXAA.includes(s.fxaa)) throw new RangeError(`post pipeline: fxaa must be 'off' or 'on', got ${JSON.stringify(s.fxaa)}`);
}

/** the LUT's input: `clamp((log2(c) − lo) / (hi − lo), 0, 1)` per channel, with `c` held above 2^lo so `log2(0)` never runs */
function lutShaperNode(color: Node<'vec4'>, range: LutLog2Range): Node<'vec4'> {
  const [lo, hi] = range;
  const s = log2(max(color.rgb, 2 ** lo))
    .sub(lo)
    .div(hi - lo)
    .clamp(0, 1);
  return vec4(s, color.a);
}

interface Lut {
  texture: Data3DTexture;
  data: Uint16Array;
}

function createLut(): Lut {
  const data = new Uint16Array(LUT3D_VALUES);
  const texture = new Data3DTexture(data, LUT_SIZE, LUT_SIZE, LUT_SIZE);
  texture.name = 'ss:look-lut';
  texture.format = RGBAFormat;
  texture.type = HalfFloatType;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.wrapR = ClampToEdgeWrapping;
  texture.generateMipmaps = false;
  texture.colorSpace = NoColorSpace; // display-referred values; no decode
  texture.unpackAlignment = 1;
  return { texture, data };
}

/**
 * While `scene` is empty the distort pass is one clear to a zero offset (render §10.2): after that clear its per-frame
 * update is pure repeated work, so the pass runs once more on becoming empty — and once when newly created — and then
 * skips its update until the scene gains children again. The pass stays in the graph (no program churn, the sampled
 * texture stays valid) and the pixels are unchanged: the target holds the clear.
 */
function armDistortSkip(distort: PassNode, scene: Scene): void {
  let cleared = false; // a fresh pass has never cleared its target
  const update = distort.updateBefore.bind(distort);
  distort.updateBefore = (frame) => {
    const empty = scene.children.length === 0;
    if (empty && cleared) return; // the target already holds the clear
    if (!empty) cleared = false;
    update(frame);
    cleared = empty;
  };
}

/** the opt-in scene gain: a finite positive number other than 1, else none */
export function postExposure(e: number | undefined): number | undefined {
  return e !== undefined && Number.isFinite(e) && e > 0 && e !== 1 ? e : undefined;
}

export function createPostPipeline(init: PostPipelineInit): PostPipeline {
  const { renderer, scene, camera, caps } = init;
  const exposure = postExposure(init.exposure);
  let tier = init.tier;
  checkSwitches(init.switches ?? {});
  /** what the next build reads */
  const pending: PostSwitches = { ...POST_SWITCH_DEFAULTS, ...init.switches };
  /** what the built graph was made with */
  let applied: PostSwitches = { ...pending };

  const pipeline = new RenderPipeline(renderer);
  pipeline.outputColorTransform = false; // renderOutput is placed here, per tonemapOrder

  const scenePass = pass(scene, camera);
  scenePass.name = 'ss:scene';
  const sceneColor = scenePass.getTextureNode('output') as unknown as Node<'vec4'>;

  const env = createPostfxEnv({ viewZ: scenePass.getViewZNode(), ...(init.grainFrame === undefined ? {} : { grainFrame: init.grainFrame }) });
  const store = createLookParamStore({});

  const distortScene = new Scene();
  distortScene.name = 'ss:distort';
  // an empty distort scene must clear to a zero offset whatever the renderer's clear colour is
  distortScene.background = new Color(0, 0, 0);

  let look: TslLookModule = IDENTITY_LOOK;
  let params: LookParams = {};
  let toneMapping: LookToneMapping = 'aces';

  let bloomNode: StandaloneBloomNode | null = null;
  let distortPass: PassNode | null = null;
  let fxaaInput: { renderTarget: RenderTarget; dispose(): void } | null = null;
  let lut: Lut | null = null;
  let lutFolded = false;
  let lookPath: 'tsl' | 'lut' = 'tsl';
  let outputNode: Node = sceneColor;
  let graphBuilds = 0;
  let disposed = false;
  /** R14b `warmTiers`: the graph whose other-tier shapes were drawn (look, tone mapping, switches), and those shapes */
  let tierWarmed: { look: TslLookModule; id: string; shapes: Set<string> } | null = null;
  let tierWarmBuilds = 0;

  const fxaaOn = (): boolean => applied.fxaa === 'on' && tier.fxaa === 'option';
  const lutWanted = (): boolean => tier.lookPath === 'lut' && applied.tonemapOrder === 'aces-look';
  /** what of a tier makes another output graph for this look (the three things `setTier` rebuilds for) */
  const shapeOf = (t: TierConfig): string =>
    [t.lookPath === 'lut' && applied.tonemapOrder === 'aces-look' ? 'lut' : 'tsl', t.distort ? 'distort' : 'flat', applied.fxaa === 'on' && t.fxaa === 'option' ? 'fxaa' : 'plain'].join('+');
  const graphId = (): string => `${applied.tonemapOrder}|${applied.bloomKernel}|${applied.fxaa}|${toneMapping}`;

  const ssFxaa = (node: Node): Node => {
    // FXAANode's own `fxaa()` builds its RTT with a depth buffer; this one has none (4 B per device pixel, render §15.4)
    const input = convertToTexture(node, null, null, { depthBuffer: false }) as unknown as { renderTarget?: RenderTarget; dispose(): void };
    if (input.renderTarget !== undefined) fxaaInput = input as { renderTarget: RenderTarget; dispose(): void };
    return new FXAANode(input as never) as unknown as Node;
  };

  /** the look over `input`; the bloom uniforms are re-armed with the engine defaults first (render §10.4) */
  const runOnce = (input: Node, fold: boolean): Node => {
    store.forgetLook(params);
    store.bloom();
    env.reset();
    if (fold) env.fold = { scene: input, core: null, conflict: false };
    return withPostfxEnv(env, () => runLook(look, input, store.param));
  };

  const bakeLut = (): void => {
    if (lut === null) return;
    const call = lutFolded ? (env.fold?.core ?? null) : null;
    const core = call === null ? null : gradeCoreOf(call, env.domain);
    if (call !== null && core === null) throw new Error('post pipeline: the folded grade no longer resolves to numbers');
    bakeLookLut({ order: 'aces-look', toneMapping, core, log2Range: caps.lutShaperLog2 }, lut.data);
    lut.texture.needsUpdate = true; // r186 has no partial 3D upload: the whole texture is re-sent
  };

  /** `warm`: a build of `warmTiers` (another tier's graph, or the own one again): the switches stay as applied, not counted */
  const rebuild = (opts: { warm?: boolean } = {}): void => {
    if (opts.warm === true) {
      tierWarmBuilds++;
    } else {
      graphBuilds++;
      applied = { ...pending };
    }
    renderer.toneMapping = toneMapping === 'neutral' ? NeutralToneMapping : ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1;
    env.setDomain(applied.tonemapOrder === 'aces-look' ? 'display' : 'linear');

    // bloom: one node, kept across graphs unless the kernel changes
    const bloomU = store.bloom();
    if (caps.bloom) {
      if (bloomNode === null || bloomNode.kernel.id !== applied.bloomKernel) {
        bloomNode?.dispose();
        bloomNode = ssBloom(sceneColor, bloomU.strength, bloomU.radius, bloomU.threshold, { kernel: applied.bloomKernel, resolutionScale: tier.bloomResolution });
      }
      bloomNode.setResolutionScale(tier.bloomResolution);
    } else if (bloomNode !== null) {
      bloomNode.dispose();
      bloomNode = null;
    }

    // distort
    if (tier.distort) {
      if (distortPass === null) {
        distortPass = pass(distortScene, camera, { format: RGFormat, depthBuffer: false });
        distortPass.name = 'ss:distort';
        distortPass.setResolutionScale(DISTORT_RESOLUTION);
        armDistortSkip(distortPass, distortScene);
      }
    } else if (distortPass !== null) {
      distortPass.dispose();
      distortPass = null;
    }
    const base: Node<'vec4'> =
      distortPass === null
        ? sceneColor
        : ((sceneColor as unknown as { sample(uv: Node): Node }).sample(uv().add((distortPass.getTextureNode('output') as unknown as Node<'vec4'>).rg)) as Node<'vec4'>);
    // the bloom only adds light: the scene's alpha stands
    const added: Node<'vec4'> = bloomNode === null ? base : vec4(base.rgb.add((bloomNode as unknown as Node<'vec4'>).rgb), base.a);
    const bloomed: Node<'vec4'> = exposure === undefined ? added : vec4(added.rgb.mul(exposure), added.a);

    fxaaInput?.dispose();
    fxaaInput = null;
    const aa = (n: Node): Node => (fxaaOn() ? ssFxaa(n) : n);

    lutFolded = false;
    if (lutWanted()) {
      lookPath = 'lut';
      lut ??= createLut();
      const lutScene = aa(lut3D(lutShaperNode(bloomed, caps.lutShaperLog2), texture3D(lut.texture), LUT_SIZE, float(1)) as unknown as Node);
      let out = runOnce(lutScene, true);
      const fold = env.fold;
      if (fold !== null && fold.core !== null && (fold.conflict || out === lutScene)) {
        // the look uses its scene again after grading it: the LUT keeps the output transform only and the grade runs in TSL
        out = runOnce(lutScene, false);
      }
      lutFolded = env.fold !== null && env.fold.core !== null;
      outputNode = out;
      bakeLut();
    } else {
      lookPath = 'tsl';
      if (lut !== null) {
        lut.texture.dispose();
        lut = null;
      }
      outputNode =
        applied.tonemapOrder === 'aces-look'
          ? runOnce(aa(renderOutput(bloomed) as unknown as Node), false) // default: the look grades the display frame, grain last
          : aa(renderOutput(runOnce(bloomed, false)) as unknown as Node); // the look on linear HDR, then the tone map and sRGB
    }

    pipeline.outputNode = outputNode;
    pipeline.needsUpdate = true;
  };

  const sameSwitches = (): boolean => pending.tonemapOrder === applied.tonemapOrder && pending.bloomKernel === applied.bloomKernel && pending.fxaa === applied.fxaa;

  rebuild();

  // render §17: registered only after the initial rebuild succeeds, so an exception in rebuild
  // can never leave the env in the sync set. Unregistered from dispose() below. The hook rebakes
  // a folded low-tier LUT after the uniform write (no graph rebuild).
  const untrackCalibrationEnv = trackCalibrationEnv(env, () => {
    if (lutFolded) bakeLut();
  });

  return {
    scenePass,
    distortScene,
    env,
    params: store,

    build(nextLook, nextParams, nextToneMapping) {
      if (disposed) return;
      if (typeof (nextLook as Partial<TslLookModule> | null | undefined)?.look !== 'function') throw new TypeError('post pipeline: build() needs a look module with a look(ctx) export');
      if (nextToneMapping !== 'aces' && nextToneMapping !== 'neutral') throw new RangeError(`post pipeline: toneMapping must be "aces" or "neutral", got ${JSON.stringify(nextToneMapping)}`);
      const sameGraph = nextLook === look && nextToneMapping === toneMapping && sameSwitches();
      look = nextLook;
      params = nextParams ?? {};
      toneMapping = nextToneMapping;
      if (!sameGraph) {
        rebuild();
        return;
      }
      // a look param write: uniforms and the LUT's contents, no new node
      store.setPlaceParams(params);
      bakeLut();
    },

    setTier(next) {
      if (disposed) return;
      const moved = next.lookPath !== tier.lookPath || next.distort !== tier.distort || next.fxaa !== tier.fxaa;
      tier = next;
      bloomNode?.setResolutionScale(tier.bloomResolution);
      if (moved) rebuild();
    },

    warmTiers(tiers, draw) {
      if (disposed) return 0;
      const id = graphId();
      if (tierWarmed === null || tierWarmed.look !== look || tierWarmed.id !== id) tierWarmed = { look, id, shapes: new Set<string>() };
      const warmed = tierWarmed;
      // the graph drawn now is linked by the frames that draw it
      warmed.shapes.add(shapeOf(tier));
      const home = tier;
      let moved = false;
      let drawn = 0;
      try {
        for (const t of tiers) {
          const shape = shapeOf(t);
          if (warmed.shapes.has(shape)) continue;
          tier = t;
          bloomNode?.setResolutionScale(t.bloomResolution);
          moved = true;
          rebuild({ warm: true });
          draw();
          warmed.shapes.add(shape);
          drawn++;
        }
      } finally {
        if (moved) {
          tier = home;
          bloomNode?.setResolutionScale(home.bloomResolution);
          rebuild({ warm: true });
        }
      }
      return drawn;
    },

    setRenderScale(s) {
      scenePass.setResolutionScale(s);
    },

    setSwitches(s) {
      checkSwitches(s);
      Object.assign(pending, s);
    },

    setFog(density, linearColor) {
      env.setFog(density, linearColor);
    },

    render() {
      if (disposed) return;
      pipeline.render();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      untrackCalibrationEnv(); // render §17: a disposed pipeline's env no longer receives panel syncs
      pipeline.dispose();
      scenePass.dispose();
      distortPass?.dispose();
      bloomNode?.dispose();
      fxaaInput?.dispose();
      lut?.texture.dispose();
      distortPass = null;
      bloomNode = null;
      fxaaInput = null;
      lut = null;
    },

    inspect() {
      return {
        tonemapOrder: applied.tonemapOrder,
        bloomKernel: applied.bloomKernel,
        fxaa: fxaaInput !== null,
        lookPath,
        lutFolded,
        distort: distortPass !== null,
        bloom: bloomNode !== null,
        domain: env.domain,
        toneMapping,
        tier: tier.id,
        look,
        graphBuilds,
        tierWarm: { builds: tierWarmBuilds, shapes: tierWarmed === null || tierWarmed.look !== look || tierWarmed.id !== graphId() ? [] : [...tierWarmed.shapes] },
        pipeline,
        outputNode,
        bloomNode,
        distortPass,
        fxaaTarget: fxaaInput?.renderTarget ?? null,
        lutTexture: lut?.texture ?? null,
      };
    },
  };
}

// ── the facade seam (src/render/index.ts `setPipeline`) ─────────────────────────────────────────────────────────────────

/** what `installPostPipeline` needs of the render facade */
export interface PostPipelineHost {
  setPipeline(factory: PipelineFactory): void;
  onTierChange(cb: (tier: TierId, config: TierConfig) => void): () => void;
}

export interface InstallPostPipelineOptions {
  switches?: Partial<PostSwitches>;
  grainFrame?: Node;
  /** opt-in scene gain before the output transform (`PostPipelineInit.exposure`); absent */
  exposure?: number;
}

export interface PostPipelineHandle {
  /** the pipeline of the current engine; null until the facade has called the factory, and replaced after a device-loss rebuild */
  readonly pipeline: PostPipeline | null;
  /** a place's look (the registry's lazily imported module), its `atmosphere.look.params` and `toneMapping`; kept for a rebuild */
  build(look: TslLookModule, params: LookParams, toneMapping: LookToneMapping): void;
  setSwitches(switches: Partial<PostSwitches>): void;
  setFog(density: number, linearColor: readonly number[]): void;
  /** the uniform of a look param of the current pipeline */
  param(name: string): LookParamUniform | undefined;
  /** stops following tier changes (the facade disposes the pipeline itself) */
  dispose(): void;
}

/**
 * Makes the post pipeline what draws the facade's frame. The factory is called by the facade now and again whenever it adopts
 * a rebuilt engine (device loss, X3); each new pipeline is built with the last look, params, tone mapping, switches and fog, so
 * the frame after a rebuild wears the same look.
 */
export function installPostPipeline(host: PostPipelineHost, opts: InstallPostPipelineOptions = {}): PostPipelineHandle {
  checkSwitches(opts.switches ?? {});
  const switches: Partial<PostSwitches> = { ...opts.switches };
  let current: PostPipeline | null = null;
  let last: { look: TslLookModule; params: LookParams; toneMapping: LookToneMapping } | null = null;
  let fog: { density: number; color: readonly number[] } | null = null;

  const factory: PipelineFactory = ({ renderer, scene, camera, caps, tier }) => {
    const p = createPostPipeline({ renderer, scene: scene as Scene, camera, caps, tier, switches, ...(opts.grainFrame === undefined ? {} : { grainFrame: opts.grainFrame }), ...(opts.exposure === undefined ? {} : { exposure: opts.exposure }) });
    if (fog !== null) p.setFog(fog.density, fog.color);
    if (last !== null) p.build(last.look, last.params, last.toneMapping);
    current = p;
    return p;
  };
  host.setPipeline(factory);
  const offTier = host.onTierChange((_tier, config) => current?.setTier(config));

  return {
    get pipeline(): PostPipeline | null {
      return current;
    },
    build(look, params, toneMapping) {
      last = { look, params, toneMapping };
      current?.build(look, params, toneMapping);
    },
    setSwitches(s) {
      checkSwitches(s);
      Object.assign(switches, s);
      current?.setSwitches(s);
    },
    setFog(density, linearColor) {
      fog = { density, color: [...linearColor] };
      current?.setFog(density, linearColor);
    },
    param: (name) => current?.params.get(name),
    dispose() {
      offTier();
    },
  };
}
