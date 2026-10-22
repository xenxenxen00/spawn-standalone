/**
 * Vendored fork of three.js r186.1 `examples/jsm/tsl/display/BloomNode.js`
 * (docs/design/rendering.md §10.3; docs/architecture.md X-46; WP R5b).
 *
 * The MIT License
 *
 * Copyright © 2010-2026 three.js authors
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 * THE SOFTWARE.
 */
// What the fork changes against r186 (everything else is the upstream node, typed):
//
//   kernel        the blur kernel is a constructor parameter (`bloomKernel`, render §17 [CAL]). `'r186'` (default) is upstream:
//                 radii [6, 10, 14, 18, 22], σ = r/3, adjacent taps merged into bilinear fetches, no normalisation, mip sizes
//                 by `Math.floor`. `'unreal-legacy'` is the older UnrealBloomPass / BloomNode chain that post-ref.ts was built
//                 from at M0: radii [3, 5, 7, 9, 11], σ = r, one fetch per integer tap, the sum divided by the summed weights,
//                 mip sizes by `Math.round`. Which one Spawn ran depends on its three revision, which is unknown.
//   texelStep     a uniform that multiplies the blur tap offsets (1 by default, which multiplies by exactly 1.0)
//   mips          the mip count, 1..5 (5 by default); fewer mips drop the widest terms of the composite
//   resolution    still `setResolutionScale` (0.5 by default); the targets follow the renderer's drawing-buffer size and nothing
//                 else, so the scene pass's render scale never changes the halo (render §3.3)
//   re-setup      upstream pushes five more blur materials on every `setup()`; here a rebuilt output graph reuses the five
//
// At the defaults the passes, their order, their targets and their arithmetic are upstream's: the R5b read-back holds the fork
// with the r186 kernel equal to an unmodified r186 `BloomNode`, and each kernel equal to its CPU reference in post-ref.ts.
import { labelStableBuffer } from '../engine/stable-programs.ts';
import { Fn, Loop, add, array, context, float, int, luminance, mix, nodeObject, passTexture, smoothstep, texture, uniform, uniformArray, uv, vec4 } from 'three/tsl';
import { HalfFloatType, NodeMaterial, NodeUpdateType, QuadMesh, RenderTarget, RendererUtils, TempNode, Vector2, Vector3 } from 'three/webgpu';
import type { Node, NodeBuilder, NodeFrame, Texture, TextureNode, UniformNode } from 'three/webgpu';

/** render §17 [CAL `bloomKernel`] */
export type BloomKernelId = 'r186' | 'unreal-legacy';

export interface BloomKernel {
  readonly id: BloomKernelId | 'custom';
  /** separable Gaussian kernel radius per mip, widest last; at least as many as the node has mips */
  readonly radii: readonly number[];
  /** the σ rule: σ of a kernel of radius `r` */
  readonly sigma: (radius: number) => number;
  /** adjacent taps merged into one bilinear fetch (r186) or one fetch per integer tap (legacy) */
  readonly mergeTaps: boolean;
  /** divide the sum by the summed weights (legacy) */
  readonly normalize: boolean;
  /** how `setSize` rounds a mip's size */
  readonly mipRounding: 'floor' | 'round';
}

export const BLOOM_KERNELS: Readonly<Record<BloomKernelId, BloomKernel>> = Object.freeze({
  // These sizes have been changed to account for the altered coefficients-calculation to avoid blockiness,
  // while retaining the same blur-strength. For details see https://github.com/mrdoob/three.js/pull/31528
  r186: Object.freeze({ id: 'r186', radii: Object.freeze([6, 10, 14, 18, 22]), sigma: (r: number) => r / 3, mergeTaps: true, normalize: false, mipRounding: 'floor' }),
  'unreal-legacy': Object.freeze({ id: 'unreal-legacy', radii: Object.freeze([3, 5, 7, 9, 11]), sigma: (r: number) => r, mergeTaps: false, normalize: true, mipRounding: 'round' }),
} as const);

/** the composite's factor per mip */
export const BLOOM_FACTORS: readonly number[] = Object.freeze([1.0, 0.8, 0.6, 0.4, 0.2]);
export const BLOOM_MAX_MIPS = 5;

export interface StandaloneBloomOptions {
  kernel?: BloomKernelId | BloomKernel;
  /** 1..5 (default 5) */
  mips?: number;
  /** mip 0 as a fraction of the drawing buffer (default 0.5) */
  resolutionScale?: number;
  /** multiplies the blur tap offsets (default 1) */
  texelStep?: number;
}

type FloatInput = number | UniformNode<'float', number>;

interface BlurMaterial {
  material: NodeMaterial;
  colorTexture: TextureNode;
  direction: UniformNode<'vec2', Vector2>;
  invSize: UniformNode<'vec2', Vector2>;
}

type HighPassFn = (inputs: { input: Node; threshold: Node; smoothWidth: Node }) => Node;

/**
 * A TSL node as the upstream JavaScript uses it. The typings of @types/three 0.186.0 do not cover what this node's shader code
 * does (`array()` of numbers, elements of a uniform array, `Loop` with an index, `builder.getSharedContext()`), so the three
 * shader-building functions below are written against this alias, as upstream wrote them, and nothing else in the file is.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Dyn = any;

const _quadMesh = /*@__PURE__*/ new (QuadMesh as unknown as new () => QuadMesh)();
const _size = /*@__PURE__*/ new Vector2();

const _BlurDirectionX = /*@__PURE__*/ new Vector2(1.0, 0.0);
const _BlurDirectionY = /*@__PURE__*/ new Vector2(0.0, 1.0);

let _rendererState: ReturnType<typeof RendererUtils.resetRendererState> | undefined;

const luminosityHighPass = /*@__PURE__*/ Fn(({ input, threshold, smoothWidth }: { input: Node<'vec4'>; threshold: Node<'float'>; smoothWidth: Node<'float'> }) => {
  const v = luminance(input.rgb);
  const alpha = smoothstep(threshold, threshold.add(smoothWidth), v);

  return mix(vec4(0), input, alpha);
}) as unknown as HighPassFn;

const lerpBloomFactor = /*@__PURE__*/ Fn(
  ({ factor, radius }: { factor: Node<'float'>; radius: Node<'float'> }) => {
    const mirrorFactor = float(1.2).sub(factor);
    return mix(factor, mirrorFactor, radius);
  },
  { factor: 'float', radius: 'float', return: 'float' },
) as unknown as (factor: Node, radius: Node) => Node<'float'>;

const isUniformNode = (v: unknown): v is UniformNode<'float', number> => typeof v === 'object' && v !== null && (v as { isNode?: unknown }).isNode === true;

function resolveKernel(kernel: BloomKernelId | BloomKernel | undefined): BloomKernel {
  if (kernel === undefined) return BLOOM_KERNELS.r186;
  if (typeof kernel === 'string') {
    const k = BLOOM_KERNELS[kernel];
    if (k === undefined) throw new RangeError(`StandaloneBloomNode: unknown bloomKernel ${JSON.stringify(kernel)}`);
    return k;
  }
  return kernel;
}

/** The blur's fetches for a kernel radius: the centre weight, then (offset in texels, weight) pairs taken at ±offset. */
export function bloomBlurTaps(kernel: BloomKernel, kernelRadius: number): { centerWeight: number; offsets: number[]; weights: number[]; weightSum: number } {
  const coefficients: number[] = [];
  const sigma = kernel.sigma(kernelRadius);

  for (let i = 0; i < kernelRadius; i++) {
    coefficients.push((0.39894 * Math.exp((-0.5 * i * i) / (sigma * sigma))) / sigma);
  }

  const centerWeight = coefficients[0]!;
  const offsets: number[] = [];
  const weights: number[] = [];

  if (kernel.mergeTaps) {
    // Merge adjacent taps into single bilinear fetches (linear sampling).
    for (let i = 1; i < kernelRadius; i += 2) {
      const wa = coefficients[i]!;
      const wb = i + 1 < kernelRadius ? coefficients[i + 1]! : 0;
      const w = wa + wb;

      offsets.push((i * wa + (i + 1) * wb) / w);
      weights.push(w);
    }
  } else {
    for (let i = 1; i < kernelRadius; i++) {
      offsets.push(i);
      weights.push(coefficients[i]!);
    }
  }

  let weightSum = centerWeight;
  for (const w of weights) weightSum += 2 * w;

  return { centerWeight, offsets, weights, weightSum };
}

/**
 * Post processing node for creating a bloom effect (the port's fork of three's `BloomNode`).
 * ```js
 * const scenePass = pass( scene, camera );
 * const scenePassColor = scenePass.getTextureNode( 'output' );
 * const bloomPass = ssBloom( scenePassColor, strength, radius, threshold, { kernel: 'r186' } );
 * renderPipeline.outputNode = scenePassColor.add( bloomPass );
 * ```
 */
export class StandaloneBloomNode extends TempNode {
  static get type(): string {
    return 'StandaloneBloomNode';
  }

  /** The node that represents the input of the effect. */
  inputNode: Node;
  /** The strength of the bloom. */
  strength: UniformNode<'float', number>;
  /** The radius of the bloom. Must be in the range `[0,1]`. */
  radius: UniformNode<'float', number>;
  /** The luminance threshold limits which bright areas contribute to the bloom effect. */
  threshold: UniformNode<'float', number>;
  /** Can be used to tweak the extracted luminance from the scene. */
  smoothWidth: UniformNode<'float', number>;
  /** A per-mip tint color for the bloom, applied during the composite pass. Defaults to white (no tint) for each of the mips. */
  bloomTintColors: Vector3[];
  /** Can be used to inject a custom high pass filter (e.g., for anamorphic effects). */
  highPassFn: HighPassFn;

  /** fork: the blur kernel */
  readonly kernel: BloomKernel;
  /** fork: the number of blur mips */
  readonly mips: number;
  /** fork: multiplies the blur tap offsets */
  readonly texelStep: UniformNode<'float', number>;

  private _resolutionScale: number;
  private readonly _renderTargetsHorizontal: RenderTarget[] = [];
  private readonly _renderTargetsVertical: RenderTarget[] = [];
  private readonly _renderTargetBright: RenderTarget;
  private _compositeMaterial: NodeMaterial | null = null;
  private _highPassFilterMaterial: NodeMaterial | null = null;
  private _separableBlurMaterials: BlurMaterial[] = [];
  private readonly _textureNodeBright: TextureNode;
  private readonly _textureNodeBlur: TextureNode[] = [];
  private readonly _textureOutput: TextureNode;

  /**
   * @param inputNode - The node that represents the input of the effect.
   * @param strength - The strength of the bloom.
   * @param radius - The radius of the bloom.
   * @param threshold - The luminance threshold limits which bright areas contribute to the bloom effect.
   * @param options - fork: kernel, mip count, resolution scale, texel step
   */
  constructor(inputNode: Node, strength: FloatInput = 1, radius: FloatInput = 0, threshold: FloatInput = 0, options: StandaloneBloomOptions = {}) {
    super('vec4');

    this.inputNode = inputNode;
    this.strength = isUniformNode(strength) ? strength : uniform(strength);
    this.radius = isUniformNode(radius) ? radius : uniform(radius);
    this.threshold = isUniformNode(threshold) ? threshold : uniform(threshold);
    this.smoothWidth = uniform(0.01);

    this.kernel = resolveKernel(options.kernel);
    const mips = options.mips ?? BLOOM_MAX_MIPS;
    if (!Number.isInteger(mips) || mips < 1 || mips > BLOOM_MAX_MIPS) throw new RangeError(`StandaloneBloomNode: mips must be an integer 1..${BLOOM_MAX_MIPS}, got ${String(mips)}`);
    if (this.kernel.radii.length < mips) throw new RangeError(`StandaloneBloomNode: the kernel has ${this.kernel.radii.length} radii for ${mips} mips`);
    this.mips = mips;
    const texelStep = options.texelStep ?? 1;
    if (!(texelStep > 0) || !Number.isFinite(texelStep)) throw new RangeError(`StandaloneBloomNode: texelStep must be > 0, got ${String(texelStep)}`);
    this.texelStep = uniform(texelStep);
    const resolutionScale = options.resolutionScale ?? 0.5;
    if (!(resolutionScale > 0) || !Number.isFinite(resolutionScale)) throw new RangeError(`StandaloneBloomNode: resolutionScale must be > 0, got ${String(resolutionScale)}`);
    this._resolutionScale = resolutionScale;

    this.bloomTintColors = [];
    for (let i = 0; i < this.mips; i++) this.bloomTintColors.push(new Vector3(1, 1, 1));

    this.highPassFn = luminosityHighPass;

    this._renderTargetBright = new RenderTarget(1, 1, { depthBuffer: false, type: HalfFloatType });
    this._renderTargetBright.texture.name = 'UnrealBloomPass.bright';
    this._renderTargetBright.texture.generateMipmaps = false;

    //

    for (let i = 0; i < this.mips; i++) {
      const renderTargetHorizontal = new RenderTarget(1, 1, { depthBuffer: false, type: HalfFloatType });

      renderTargetHorizontal.texture.name = 'UnrealBloomPass.h' + i;
      renderTargetHorizontal.texture.generateMipmaps = false;

      this._renderTargetsHorizontal.push(renderTargetHorizontal);

      const renderTargetVertical = new RenderTarget(1, 1, { depthBuffer: false, type: HalfFloatType });

      renderTargetVertical.texture.name = 'UnrealBloomPass.v' + i;
      renderTargetVertical.texture.generateMipmaps = false;

      this._renderTargetsVertical.push(renderTargetVertical);
    }

    /** The result of the luminance pass as a texture node for further processing. */
    this._textureNodeBright = texture(this._renderTargetBright.texture);

    /** The results of the blur passes as texture nodes for further processing. */
    for (let i = 0; i < this.mips; i++) this._textureNodeBlur.push(texture(this._renderTargetsVertical[i]!.texture));

    /** The result of the effect is represented as a separate texture node. */
    this._textureOutput = passTexture(this as unknown as Parameters<typeof passTexture>[0], this._renderTargetsHorizontal[0]!.texture);

    /**
     * The `updateBeforeType` is set to `NodeUpdateType.FRAME` since the node renders
     * its effect once per frame in `updateBefore()`.
     */
    this.updateBeforeType = NodeUpdateType.FRAME;
  }

  /** Returns the result of the effect as a texture node. */
  getTextureNode(): TextureNode {
    return this._textureOutput;
  }

  /**
   * Sets the resolution scale for the pass.
   * The resolution scale is a factor that is multiplied with the renderer's width and height.
   */
  setResolutionScale(resolutionScale: number): this {
    this._resolutionScale = resolutionScale;

    return this;
  }

  /** Gets the current resolution scale of the pass. A value of `1` means full resolution. */
  getResolutionScale(): number {
    return this._resolutionScale;
  }

  /** The mip target sizes for a drawing buffer of `width × height` (what `setSize` allocates). */
  mipSizes(width: number, height: number): Array<[number, number]> {
    const round = this.kernel.mipRounding === 'round' ? Math.round : Math.floor;
    const out: Array<[number, number]> = [];
    let resx = round(width * this._resolutionScale);
    let resy = round(height * this._resolutionScale);

    for (let i = 0; i < this.mips; i++) {
      out.push([resx, resy]);

      resx = round(resx / 2);
      resy = round(resy / 2);
    }

    return out;
  }

  /** Sets the size of the effect. */
  setSize(width: number, height: number): void {
    const sizes = this.mipSizes(width, height);
    const [resx0, resy0] = sizes[0]!;

    this._renderTargetBright.setSize(resx0, resy0);

    for (let i = 0; i < this.mips; i++) {
      const [resx, resy] = sizes[i]!;

      this._renderTargetsHorizontal[i]!.setSize(resx, resy);
      this._renderTargetsVertical[i]!.setSize(resx, resy);

      this._separableBlurMaterials[i]!.invSize.value.set(1 / resx, 1 / resy);
    }
  }

  /** This method is used to render the effect once per frame. */
  override updateBefore(frame: NodeFrame): undefined {
    const renderer = frame.renderer!;

    _rendererState = RendererUtils.resetRendererState(renderer, _rendererState as never);

    //

    const size = renderer.getDrawingBufferSize(_size);
    this.setSize(size.width, size.height);

    // 1. Extract bright areas

    renderer.setRenderTarget(this._renderTargetBright);
    _quadMesh.material = this._highPassFilterMaterial!;
    _quadMesh.name = 'Bloom [ High Pass ]';
    _quadMesh.render(renderer);

    // 2. Blur all the mips progressively

    let inputRenderTarget = this._renderTargetBright;

    for (let i = 0; i < this.mips; i++) {
      const blur = this._separableBlurMaterials[i]!;

      _quadMesh.material = blur.material;

      blur.colorTexture.value = inputRenderTarget.texture;
      blur.direction.value = _BlurDirectionX;
      renderer.setRenderTarget(this._renderTargetsHorizontal[i]!);
      _quadMesh.name = `Bloom [ Blur Horizontal - ${i} ]`;
      _quadMesh.render(renderer);

      blur.colorTexture.value = this._renderTargetsHorizontal[i]!.texture;
      blur.direction.value = _BlurDirectionY;
      renderer.setRenderTarget(this._renderTargetsVertical[i]!);
      _quadMesh.name = `Bloom [ Blur Vertical - ${i} ]`;
      _quadMesh.render(renderer);

      inputRenderTarget = this._renderTargetsVertical[i]!;
    }

    // 3. Composite all the mips

    renderer.setRenderTarget(this._renderTargetsHorizontal[0]!);
    _quadMesh.material = this._compositeMaterial!;
    _quadMesh.name = 'Bloom [ Composite ]';
    _quadMesh.render(renderer);

    // restore

    RendererUtils.restoreRendererState(renderer, _rendererState as never);

    return undefined;
  }

  /** This method is used to setup the effect's TSL code. */
  override setup(builder: NodeBuilder): TextureNode {
    const sharedContext = context((builder as Dyn).getSharedContext());

    // luminosity high pass material

    this._highPassFilterMaterial = this._highPassFilterMaterial || new NodeMaterial();
    this._highPassFilterMaterial.contextNode = sharedContext;
    this._highPassFilterMaterial.fragmentNode = this.highPassFn({ input: this.inputNode, threshold: this.threshold, smoothWidth: this.smoothWidth });
    this._highPassFilterMaterial.name = 'Bloom_highPass';
    this._highPassFilterMaterial.needsUpdate = true;

    // gaussian blur materials (fork: built once, their context refreshed on a later setup)

    if (this._separableBlurMaterials.length === 0) {
      for (let i = 0; i < this.mips; i++) {
        this._separableBlurMaterials.push(this._getSeparableBlurMaterial(sharedContext, this.kernel.radii[i]!));
      }
    } else {
      for (const blur of this._separableBlurMaterials) {
        blur.material.contextNode = sharedContext;
        blur.material.needsUpdate = true;
      }
    }

    // composite material

    const bloomFactors: Dyn = (array as Dyn)(BLOOM_FACTORS.slice(0, this.mips));
    // R14b: labelled, so the composite's text (and program) survives the node being made again by a post-graph rebuild
    const bloomTintColors: Dyn = labelStableBuffer(uniformArray(this.bloomTintColors), 'bloomTint');

    const compositePass = Fn(() => {
      let sum: Dyn = null;

      for (let i = 0; i < this.mips; i++) {
        const color: Dyn = (lerpBloomFactor(bloomFactors.element(i), this.radius) as Dyn).mul(vec4(bloomTintColors.element(i), 1.0)).mul(this._textureNodeBlur[i]);

        sum = sum === null ? color : sum.add(color);
      }

      return sum.mul(this.strength);
    });

    this._compositeMaterial = this._compositeMaterial || new NodeMaterial();
    this._compositeMaterial.contextNode = sharedContext;
    this._compositeMaterial.fragmentNode = compositePass();
    this._compositeMaterial.name = 'Bloom_comp';
    this._compositeMaterial.needsUpdate = true;

    //

    return this._textureOutput;
  }

  /**
   * Frees internal resources. This method should be called
   * when the effect is no longer required.
   */
  override dispose(): void {
    super.dispose();

    for (let i = 0; i < this._renderTargetsHorizontal.length; i++) {
      this._renderTargetsHorizontal[i]!.dispose();
    }

    for (let i = 0; i < this._renderTargetsVertical.length; i++) {
      this._renderTargetsVertical[i]!.dispose();
    }

    this._renderTargetBright.dispose();

    if (this._highPassFilterMaterial !== null) this._highPassFilterMaterial.dispose();
    if (this._compositeMaterial !== null) this._compositeMaterial.dispose();

    for (let i = 0; i < this._separableBlurMaterials.length; i++) {
      this._separableBlurMaterials[i]!.material.dispose();
    }
  }

  /** Create a separable blur material for the given kernel radius. */
  private _getSeparableBlurMaterial(sharedContext: ReturnType<typeof context>, kernelRadius: number): BlurMaterial {
    const { centerWeight, offsets, weights, weightSum } = bloomBlurTaps(this.kernel, kernelRadius);

    //

    const colorTexture = texture(null as unknown as Texture);
    const gaussianOffsets: Dyn = (array as Dyn)(offsets);
    const gaussianWeights: Dyn = (array as Dyn)(weights);
    const invSize = uniform(new Vector2());
    const direction = uniform(new Vector2(0.5, 0.5));
    const texelStep = this.texelStep;
    const normalize = this.kernel.normalize;

    const uvNode: Dyn = uv();
    const sampleTexel = (at: Dyn): Dyn => colorTexture.sample(at);

    const separableBlurPass = Fn(() => {
      const diffuseSum: Dyn = sampleTexel(uvNode).rgb.mul(centerWeight).toVar();

      (Loop as Dyn)({ start: int(0), end: int(offsets.length), type: 'int', condition: '<' }, ({ i }: { i: Dyn }) => {
        const w = gaussianWeights.element(i);
        const uvOffset = (direction as Dyn).mul(invSize).mul(gaussianOffsets.element(i)).mul(texelStep);
        const sample1 = sampleTexel(uvNode.add(uvOffset)).rgb;
        const sample2 = sampleTexel(uvNode.sub(uvOffset)).rgb;
        diffuseSum.addAssign((add as Dyn)(sample1, sample2).mul(w));
      });

      return vec4(normalize ? diffuseSum.div(weightSum) : diffuseSum, 1.0);
    });

    const separableBlurMaterial = new NodeMaterial();
    separableBlurMaterial.contextNode = sharedContext;
    separableBlurMaterial.fragmentNode = separableBlurPass();
    separableBlurMaterial.name = 'Bloom_separable';
    separableBlurMaterial.needsUpdate = true;

    return { material: separableBlurMaterial, colorTexture, direction, invSize };
  }
}

/**
 * TSL function for creating the port's bloom effect: the bloom only, to be added to the scene colour before the look.
 *
 * @param node - The node that represents the input of the effect.
 * @param strength - The strength of the bloom.
 * @param radius - The radius of the bloom.
 * @param threshold - The luminance threshold limits which bright areas contribute to the bloom effect.
 * @param options - kernel, mip count, resolution scale, texel step
 */
export const ssBloom = (node: Node, strength?: FloatInput, radius?: FloatInput, threshold?: FloatInput, options?: StandaloneBloomOptions): StandaloneBloomNode =>
  new StandaloneBloomNode(nodeObject(node) as Node, strength, radius, threshold, options);

export default StandaloneBloomNode;
