// CPU references for the post chain (render §10.3, §10.5, §10.6, Appendix B.5-B.6; system-rendering-look.md §4.7-§4.8).
// Engine-free, written from the three.js sources the live engine runs (UnrealBloomPass / BloomNode, ACESFilmicToneMapping,
// NeutralToneMapping, the sRGB OETF), not from the port's GLSL. WP R5b's post conformance renders its shaders under SwiftShader
// and compares them with these functions; the LUT helpers fix the 32³ layout and the log2 shaper both sides use.
// R5b added the r186 `BloomNode` kernel beside the legacy one, the look math (grade, haze, vignette, grain, tint) and the output
// transform as three r186's TSL nodes compute it (`displayTransform`), which is not quite the GLSL fit of `acesFilmic`.
import { calibration } from '../calibration.ts';
import type { LookOp } from './look-recorder.ts';

export type Linear3 = [number, number, number];
type Vec3In = readonly [number, number, number];

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
const map3 = (c: Vec3In, f: (x: number) => number): Linear3 => [f(c[0]), f(c[1]), f(c[2])];

/** GLSL `smoothstep` (e0 < e1). */
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

// ── sRGB ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Linear → sRGB-encoded (render B.5 `srgbOETF`; three `sRGBTransferOETF`). */
export function srgbOETF1(x: number): number {
  return x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055;
}
export const srgbOETF = (c: Vec3In): Linear3 => map3(c, srgbOETF1);

/** sRGB-encoded → linear (three `SRGBToLinear`; colour.ts uses the same law for `#rrggbb`). */
export function srgbEOTF1(x: number): number {
  return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
}
export const srgbEOTF = (c: Vec3In): Linear3 => map3(c, srgbEOTF1);

// ── tone mapping ──────────────────────────────────────────────────────────────────────────────────────────────────

/** three.js ACES input matrix, row-major (system-rendering-look.md §4.8; GLSL B.5 holds its columns). */
export const ACES_INPUT_MAT: readonly (readonly [number, number, number])[] = [
  [0.59719, 0.35458, 0.04823],
  [0.076, 0.90834, 0.01566],
  [0.0284, 0.13383, 0.83777],
];
/** three.js ACES output matrix, row-major. */
export const ACES_OUTPUT_MAT: readonly (readonly [number, number, number])[] = [
  [1.60475, -0.53108, -0.07367],
  [-0.10208, 1.10813, -0.00605],
  [-0.00327, -0.07276, 1.07602],
];

const mulRows = (m: readonly (readonly [number, number, number])[], v: Vec3In): Linear3 => {
  const r = (i: number): number => {
    const row = m[i]!;
    return row[0] * v[0] + row[1] * v[1] + row[2] * v[2];
  };
  return [r(0), r(1), r(2)];
};

/** three.js `RRTAndODTFit`. */
export function rrtAndOdtFit(v: number): number {
  const a = v * (v + 0.0245786) - 0.000090537;
  const b = v * (0.983729 * v + 0.432951) + 0.238081;
  return a / b;
}

/**
 * three.js `ACESFilmicToneMapping` incl. the `/0.6` pre-scale (render B.5). `exposure` is the renderer's tone-mapping exposure
 * (1 in the port); the look's own exposure is applied inside `grade`.
 */
export function acesFilmic(c: Vec3In, exposure = 1): Linear3 {
  const k = exposure / 0.6;
  const v = mulRows(ACES_INPUT_MAT, [c[0] * k, c[1] * k, c[2] * k]);
  return map3(mulRows(ACES_OUTPUT_MAT, map3(v, rrtAndOdtFit)), clamp01);
}

/** three.js `NeutralToneMapping` (Khronos PBR Neutral), for `look.toneMapping = "neutral"`. */
export function neutralToneMap(c: Vec3In, exposure = 1): Linear3 {
  const START = 0.8 - 0.04;
  const DESAT = 0.15;
  let col: Linear3 = [c[0] * exposure, c[1] * exposure, c[2] * exposure];
  const x = Math.min(col[0], col[1], col[2]);
  const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
  col = [col[0] - offset, col[1] - offset, col[2] - offset];
  const peak = Math.max(col[0], col[1], col[2]);
  if (peak < START) return col;
  const d = 1 - START;
  const newPeak = 1 - (d * d) / (peak + d - START);
  const s = newPeak / peak;
  col = [col[0] * s, col[1] * s, col[2] * s];
  const g = 1 - 1 / (DESAT * (peak - newPeak) + 1);
  return map3(col, (v) => v + (newPeak - v) * g);
}

// ── low-tier LUT (render §10.6) ───────────────────────────────────────────────────────────────────────────────────

/** 32³ LUT stored as a 1024 × 32 RGBA8 texture. */
export const LUT_SIZE = 32;
export const LUT_WIDTH = LUT_SIZE * LUT_SIZE;
export const LUT_HEIGHT = LUT_SIZE;
/** log2 shaper range: 2⁻¹² .. 2⁴ linear. */
export const LUT_LOG2_MIN = -12;
export const LUT_LOG2_MAX = 4;
const LUT_SPAN = LUT_LOG2_MAX - LUT_LOG2_MIN;

/** `s = clamp((log2(c) + 12) / 16, 0, 1)`; 0 for c ≤ 0. */
export function lutShaper(c: number): number {
  if (!(c > 0)) return 0;
  return clamp01((Math.log2(c) - LUT_LOG2_MIN) / LUT_SPAN);
}

/** Inverse shaper: the linear value at shaped coordinate `s`. */
export function lutUnshaper(s: number): number {
  return 2 ** (s * LUT_SPAN + LUT_LOG2_MIN);
}

/**
 * Texel index of LUT node (r, g, b) in the 1024 × 32 texture, row-major from texel (0, 0): blue picks the 32-texel-wide
 * slice, red the column inside it, green the row (x = b·32 + r, y = g).
 */
export function lutTexelIndex(r: number, g: number, b: number): number {
  return g * LUT_WIDTH + b * LUT_SIZE + r;
}

/**
 * Bakes `transform` (scene-linear in, display-referred [0, 1] out: grade + tone map + OETF) at every node, node i of a channel
 * standing for `lutUnshaper(i / 31)`. Returns the RGBA8 texels (alpha 255), rounded to nearest.
 */
export function bakeLut(transform: (c: Linear3) => Vec3In): Uint8Array {
  const out = new Uint8Array(LUT_WIDTH * LUT_HEIGHT * 4);
  const node = (i: number): number => lutUnshaper(i / (LUT_SIZE - 1));
  for (let b = 0; b < LUT_SIZE; b++) {
    for (let g = 0; g < LUT_SIZE; g++) {
      for (let r = 0; r < LUT_SIZE; r++) {
        const v = transform([node(r), node(g), node(b)]);
        const o = lutTexelIndex(r, g, b) * 4;
        out[o] = Math.round(clamp01(v[0]) * 255);
        out[o + 1] = Math.round(clamp01(v[1]) * 255);
        out[o + 2] = Math.round(clamp01(v[2]) * 255);
        out[o + 3] = 255;
      }
    }
  }
  return out;
}

/** Shaper → trilinear lookup (what bilinear within a slice plus a manual blend between two blue slices computes). */
export function sampleLut(lut: Uint8Array, c: Vec3In): Linear3 {
  if (lut.length !== LUT_WIDTH * LUT_HEIGHT * 4) throw new Error(`sampleLut: expected ${LUT_WIDTH}×${LUT_HEIGHT} RGBA8`);
  const axis = (x: number): [number, number, number] => {
    const f = lutShaper(x) * (LUT_SIZE - 1);
    const i0 = Math.min(LUT_SIZE - 1, Math.floor(f));
    return [i0, Math.min(LUT_SIZE - 1, i0 + 1), f - i0];
  };
  const [r0, r1, tr] = axis(c[0]);
  const [g0, g1, tg] = axis(c[1]);
  const [b0, b1, tb] = axis(c[2]);
  const out: Linear3 = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    const at = (r: number, g: number, b: number): number => lut[lutTexelIndex(r, g, b) * 4 + ch]! / 255;
    const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
    const c00 = lerp(at(r0, g0, b0), at(r1, g0, b0), tr);
    const c10 = lerp(at(r0, g1, b0), at(r1, g1, b0), tr);
    const c01 = lerp(at(r0, g0, b1), at(r1, g0, b1), tr);
    const c11 = lerp(at(r0, g1, b1), at(r1, g1, b1), tr);
    out[ch] = lerp(lerp(c00, c10, tg), lerp(c01, c11, tg), tb);
  }
  return out;
}

// ── bloom: three.js UnrealBloomPass / BloomNode (render §10.3, B.6) ──────────────────────────────────────────────

export const BLOOM_MIPS = 5;
/** separable Gaussian kernel radius per mip; σ = radius */
export const BLOOM_KERNEL_RADII: readonly number[] = [3, 5, 7, 9, 11];
/** composite factors per mip */
export const BLOOM_FACTORS: readonly number[] = [1.0, 0.8, 0.6, 0.4, 0.2];
/** high-pass smoothstep width above the threshold */
export const BLOOM_SMOOTH_WIDTH = 0.01;
/** Rec.709 luma weights (three `luminance` for linear sRGB) */
export const REC709_LUMA: Vec3In = [0.2126, 0.7152, 0.0722];

export function luminance(c: Vec3In): number {
  return REC709_LUMA[0] * c[0] + REC709_LUMA[1] * c[1] + REC709_LUMA[2] * c[2];
}

/** Luminosity high-pass: `mix(vec4(0), c, smoothstep(t, t + 0.01, luminance(c)))`. */
export function highPass(c: Vec3In, threshold: number): Linear3 {
  const a = smoothstep(threshold, threshold + BLOOM_SMOOTH_WIDTH, luminance(c));
  return [c[0] * a, c[1] * a, c[2] * a];
}

/**
 * Mip target sizes. three.js halves from the previous mip with rounding (`resx = Math.round(resx / 2)`, starting at
 * `Math.round(width / 2)`), so odd sizes can differ by one from `round(w / 2^(i+1))`.
 */
export function bloomMipSizes(width: number, height: number, mips = BLOOM_MIPS, resolutionScale = 0.5): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let w = Math.round(width * resolutionScale);
  let h = Math.round(height * resolutionScale);
  for (let i = 0; i < mips; i++) {
    out.push([w, h]);
    w = Math.round(w / 2);
    h = Math.round(h / 2);
  }
  return out;
}

/** `0.39894·exp(−0.5·x²/σ²)/σ` for x = 0 .. radius − 1, σ = radius. */
export function gaussianCoefficients(radius: number): number[] {
  const out: number[] = [];
  for (let x = 0; x < radius; x++) out.push((0.39894 * Math.exp((-0.5 * x * x) / (radius * radius))) / radius);
  return out;
}

/** Composite weight of a mip: `mix(f, 1.2 − f, bloomRadius)`. */
export function bloomLerpFactor(f: number, radius: number): number {
  return f + (1.2 - f - f) * radius;
}

/** Linear RGB image, rows from v = 0, three floats per texel. */
export interface RgbImage {
  readonly width: number;
  readonly height: number;
  readonly data: Float32Array;
}

export function rgbImage(width: number, height: number, data: Float32Array = new Float32Array(width * height * 3)): RgbImage {
  if (data.length !== width * height * 3) throw new Error(`rgbImage: ${width}×${height} needs ${width * height * 3} floats`);
  return { width, height, data };
}

/** GL `texture()` with LINEAR filtering and CLAMP_TO_EDGE: texel centres at (i + 0.5) / size. */
export function sampleBilinear(img: RgbImage, u: number, v: number): Linear3 {
  const x = u * img.width - 0.5;
  const y = v * img.height - 0.5;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const cx = (i: number): number => Math.min(img.width - 1, Math.max(0, i));
  const cy = (j: number): number => Math.min(img.height - 1, Math.max(0, j));
  const xa = cx(x0);
  const xb = cx(x0 + 1);
  const ya = cy(y0);
  const yb = cy(y0 + 1);
  const d = img.data;
  const out: Linear3 = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    const t = (i: number, j: number): number => d[(j * img.width + i) * 3 + ch]!;
    const top = t(xa, ya) + (t(xb, ya) - t(xa, ya)) * fx;
    const bot = t(xa, yb) + (t(xb, yb) - t(xa, yb)) * fx;
    out[ch] = top + (bot - top) * fy;
  }
  return out;
}

/** A full-screen pass into an `outW × outH` target: `f(u, v)` at every texel centre. */
function pass(outW: number, outH: number, f: (u: number, v: number) => Vec3In): RgbImage {
  const img = rgbImage(outW, outH);
  for (let j = 0; j < outH; j++) {
    for (let i = 0; i < outW; i++) {
      const c = f((i + 0.5) / outW, (j + 0.5) / outH);
      const o = (j * outW + i) * 3;
      img.data[o] = c[0];
      img.data[o + 1] = c[1];
      img.data[o + 2] = c[2];
    }
  }
  return img;
}

/**
 * three's `SeparableBlurMaterial` drawn into an `outW × outH` target: taps at `vUv ± direction · invSize · x` with
 * `invSize = 1 / (outW, outH)` (the target's own texel size, also when the input is the larger previous mip), normalised by
 * the summed weights.
 */
export function blurPass(input: RgbImage, outW: number, outH: number, dir: 'h' | 'v', radius: number, texelStep = 1): RgbImage {
  const w = gaussianCoefficients(radius);
  const du = dir === 'h' ? texelStep / outW : 0;
  const dv = dir === 'v' ? texelStep / outH : 0;
  return pass(outW, outH, (u, v) => {
    let wsum = w[0]!;
    const c = sampleBilinear(input, u, v);
    const sum: Linear3 = [c[0] * wsum, c[1] * wsum, c[2] * wsum];
    for (let x = 1; x < radius; x++) {
      const wx = w[x]!;
      const a = sampleBilinear(input, u + du * x, v + dv * x);
      const b = sampleBilinear(input, u - du * x, v - dv * x);
      sum[0] += (a[0] + b[0]) * wx;
      sum[1] += (a[1] + b[1]) * wx;
      sum[2] += (a[2] + b[2]) * wx;
      wsum += 2 * wx;
    }
    return [sum[0] / wsum, sum[1] / wsum, sum[2] / wsum];
  });
}

export interface BloomReference {
  /** high-pass at mip 0 size */
  bright: RgbImage;
  /** blurred mips (H then V), mip i input = mip i − 1 output, mip 0 input = `bright` */
  mips: RgbImage[];
  /** composite at mip 0 size: strength · Σ mix(fᵢ, 1.2 − fᵢ, radius) · mipᵢ */
  bloom: RgbImage;
  /** the scene with the bloom added (bilinear upsample), before the look */
  output: RgbImage;
}

// ── the r186 BloomNode kernel (render §10.3; three PR #31528) ────────────────────────────────────────────────────
// Written from node_modules/three/examples/jsm/tsl/display/BloomNode.js (r186.1): `kernelSizeArray = [6, 10, 14, 18, 22]`,
// `sigma = kernelRadius / 3`, adjacent taps merged into one bilinear fetch, `setSize` with `Math.floor`, and no division by the
// summed weights. The legacy chain above (UnrealBloomPass: radii 3..11, σ = r, integer taps, normalised, rounded sizes) stays as
// built; `bloomKernel` (render §17) picks one of the two.

/** render §17 [CAL `bloomKernel`] */
export type BloomKernelId = 'r186' | 'unreal-legacy';

/** r186 separable Gaussian kernel radius per mip; σ = radius / 3 */
export const BLOOM_KERNEL_RADII_R186: readonly number[] = [6, 10, 14, 18, 22];

/** `0.39894·exp(−0.5·x²/σ²)/σ` for x = 0 .. radius − 1, σ = radius / 3. */
export function gaussianCoefficientsR186(radius: number): number[] {
  const sigma = radius / 3;
  const out: number[] = [];
  for (let x = 0; x < radius; x++) out.push((0.39894 * Math.exp((-0.5 * x * x) / (sigma * sigma))) / sigma);
  return out;
}

export interface MergedTaps {
  /** weight of the centre fetch */
  center: number;
  /** offsets in texels of the merged fetches, taken at ±offset */
  offsets: number[];
  weights: number[];
}

/** Taps (1, 2), (3, 4), … merged into single bilinear fetches at the weighted offset; an odd last tap stands alone. */
export function mergedBlurTaps(coefficients: readonly number[]): MergedTaps {
  const offsets: number[] = [];
  const weights: number[] = [];
  for (let i = 1; i < coefficients.length; i += 2) {
    const wa = coefficients[i]!;
    const wb = i + 1 < coefficients.length ? coefficients[i + 1]! : 0;
    const w = wa + wb;
    offsets.push((i * wa + (i + 1) * wb) / w);
    weights.push(w);
  }
  return { center: coefficients[0]!, offsets, weights };
}

/** r186 `BloomNode#setSize`: `floor(size · scale)`, then `floor(previous / 2)` per mip. */
export function bloomMipSizesR186(width: number, height: number, mips = BLOOM_MIPS, resolutionScale = 0.5): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let w = Math.floor(width * resolutionScale);
  let h = Math.floor(height * resolutionScale);
  for (let i = 0; i < mips; i++) {
    out.push([w, h]);
    w = Math.floor(w / 2);
    h = Math.floor(h / 2);
  }
  return out;
}

/**
 * r186's separable blur drawn into an `outW × outH` target: the centre fetch plus the merged fetches at
 * `vUv ± direction · invSize · offset · texelStep`, `invSize = 1 / (outW, outH)`, summed without normalisation.
 */
export function blurPassR186(input: RgbImage, outW: number, outH: number, dir: 'h' | 'v', radius: number, texelStep = 1): RgbImage {
  const taps = mergedBlurTaps(gaussianCoefficientsR186(radius));
  const du = dir === 'h' ? texelStep / outW : 0;
  const dv = dir === 'v' ? texelStep / outH : 0;
  return pass(outW, outH, (u, v) => {
    const c = sampleBilinear(input, u, v);
    const sum: Linear3 = [c[0] * taps.center, c[1] * taps.center, c[2] * taps.center];
    for (let k = 0; k < taps.offsets.length; k++) {
      const o = taps.offsets[k]!;
      const w = taps.weights[k]!;
      const a = sampleBilinear(input, u + du * o, v + dv * o);
      const b = sampleBilinear(input, u - du * o, v - dv * o);
      sum[0] += (a[0] + b[0]) * w;
      sum[1] += (a[1] + b[1]) * w;
      sum[2] += (a[2] + b[2]) * w;
    }
    return sum;
  });
}

export interface BloomReferenceOptions {
  /** default `'unreal-legacy'`, the chain this reference was built with at M0 */
  kernel?: BloomKernelId;
  /** multiplies the blur tap offsets (render §10.3: 0.5 with ¼ resolution keeps the halo's screen-space spread) */
  texelStep?: number;
  /** mip 0 as a fraction of the input size (0.5 on every tier) */
  resolutionScale?: number;
}

/**
 * The whole bloom on a small image (render §10.3 pass list 1-12 + the additive blend). `mips` < 5 drops the widest terms.
 * `opts` picks the kernel: `'unreal-legacy'` (default: radii 3..11, σ = r, integer taps, normalised, rounded mip sizes) or
 * `'r186'` (radii 6..22, σ = r/3, merged taps, unnormalised, floored mip sizes).
 */
export function bloomReference(
  scene: RgbImage,
  p: { strength: number; radius: number; threshold: number },
  mips = BLOOM_MIPS,
  opts: BloomKernelId | BloomReferenceOptions = 'unreal-legacy',
): BloomReference {
  if (mips < 1 || mips > BLOOM_MIPS) throw new Error(`bloomReference: mips must be 1..${BLOOM_MIPS}`);
  const o: BloomReferenceOptions = typeof opts === 'string' ? { kernel: opts } : opts;
  const kernel = o.kernel ?? 'unreal-legacy';
  if (kernel !== 'r186' && kernel !== 'unreal-legacy') throw new Error(`bloomReference: unknown kernel ${JSON.stringify(kernel)}`);
  const texelStep = o.texelStep ?? 1;
  const scale = o.resolutionScale ?? 0.5;
  const r186 = kernel === 'r186';
  const sizes = (r186 ? bloomMipSizesR186 : bloomMipSizes)(scene.width, scene.height, mips, scale);
  const [w0, h0] = sizes[0]!;
  const bright = pass(w0, h0, (u, v) => highPass(sampleBilinear(scene, u, v), p.threshold));
  const blurred: RgbImage[] = [];
  let input = bright;
  sizes.forEach(([w, h], i) => {
    const r = (r186 ? BLOOM_KERNEL_RADII_R186 : BLOOM_KERNEL_RADII)[i]!;
    const blur = r186 ? blurPassR186 : blurPass;
    const v = blur(blur(input, w, h, 'h', r, texelStep), w, h, 'v', r, texelStep);
    blurred.push(v);
    input = v;
  });
  const factors = blurred.map((_, i) => p.strength * bloomLerpFactor(BLOOM_FACTORS[i]!, p.radius));
  const bloom = pass(w0, h0, (u, v) => {
    const s: Linear3 = [0, 0, 0];
    blurred.forEach((img, i) => {
      const c = sampleBilinear(img, u, v);
      s[0] += factors[i]! * c[0];
      s[1] += factors[i]! * c[1];
      s[2] += factors[i]! * c[2];
    });
    return s;
  });
  const output = pass(scene.width, scene.height, (u, v) => {
    const a = sampleBilinear(scene, u, v);
    const b = sampleBilinear(bloom, u, v);
    return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  });
  return { bright, mips: blurred, bloom, output };
}

// ── the look: grade, haze, vignette, grain, tint (render §10.5, Appendix B.4) ─────────────────────────────────────
// Written from the operator math of render §10.5, independently of the TSL graph in postfx-tsl.ts (WP R5b); the read-back
// tests hold the two equal. No tone mapping here: the same formulas run on the display frame (`tonemapOrder = 'aces-look'`)
// and on linear HDR (`'look-aces'`), and every colour constant is taken in the domain the look runs in (render §10.1).

/** render §17 [CAL `tonemapOrder`] */
export type TonemapOrder = 'aces-look' | 'look-aces';

/** [CAL `contrastPivot`] */
export const CONTRAST_PIVOT = 0.18;
/** the vignette's distance scale: a corner (p = (1, 1), roundness 2) lands on d ≈ 1 */
export const VIGNETTE_SCALE = 0.7071;
/** the grain seed's multipliers for the pixel row and the frame (uint32 arithmetic, see `grainSeed`) */
export const GRAIN_ROW_PRIME = 0x9e3779b1;
export const GRAIN_FRAME_PRIME = 0x85ebca6b;

/** the per-colour part of `grade` (everything but haze): what the low-tier LUT folds in (render §10.6) */
export interface GradeCoreOptions {
  exposure?: number | undefined;
  temperature?: number | undefined;
  tint?: number | undefined;
  lift?: number | Vec3In | undefined;
  gain?: number | Vec3In | undefined;
  gamma?: number | undefined;
  contrast?: number | undefined;
  /**
   * explicit pivot override (the calibrate tool's candidate evaluations); when absent the live
   * `calibration.grade.contrastPivot` is used — the same source as the TSL `calibrationPivot` uniform
   * (postfx-tsl.ts), so the LUT bake and the live graph agree on every tier
   */
  contrastPivot?: number | undefined;
  saturation?: number | undefined;
}

const spread = (v: number | Vec3In): Vec3In => (typeof v === 'number' ? [v, v, v] : v);

/**
 * exposure (linear multiplier) → white balance `(1 + T, 1 − tint/2, 1 − T)` → lift/gain `max(c·gain + lift·(1 − c), 0)` →
 * gamma `pow(c, 1/gamma)` → contrast around the live calibration pivot → saturation around Rec.709 luma. An absent
 * field is neutral and does nothing.
 */
export function gradeCore(c: Vec3In, o: GradeCoreOptions): Linear3 {
  let out: Linear3 = [c[0], c[1], c[2]];
  if (o.exposure !== undefined) {
    const e = o.exposure;
    out = map3(out, (x) => x * e);
  }
  if (o.temperature !== undefined || o.tint !== undefined) {
    const t = o.temperature ?? 0;
    const g = o.tint ?? 0;
    out = [out[0] * (1 + t), out[1] * (1 - 0.5 * g), out[2] * (1 - t)];
  }
  if (o.gain !== undefined || o.lift !== undefined) {
    const gain = spread(o.gain ?? 1);
    const lift = spread(o.lift ?? 0);
    out = [0, 1, 2].map((i) => Math.max(out[i]! * gain[i]! + lift[i]! * (1 - out[i]!), 0)) as Linear3;
  }
  if (o.gamma !== undefined) {
    const inv = 1 / o.gamma;
    out = map3(out, (x) => Math.max(x, 0) ** inv);
  }
  if (o.contrast !== undefined) {
    const k = o.contrast;
    // the live calibration pivot (render §17), not the shipped constant: the low-tier LUT bake and the
    // TSL `calibrationPivot` uniform read the same value, so a panel edit moves both tiers together
    const pivot = o.contrastPivot ?? calibration.grade.contrastPivot;
    out = map3(out, (x) => (Math.max(x, 0) / pivot) ** k * pivot);
  }
  if (o.saturation !== undefined) {
    const y = luminance(out);
    const s = o.saturation;
    out = map3(out, (x) => y + (x - y) * s);
  }
  return out;
}

/** three's `FogExp2` factor (render B.5): `1 − exp(−(density · viewZ)²)`. */
export function fogFactor(density: number, viewZ: number): number {
  const d = density * viewZ;
  return 1 - Math.exp(-(d * d));
}

/** `mix(c, hazeColor, haze · fogFactor)` */
export function hazeMix(c: Vec3In, hazeColor: Vec3In, haze: number, fogDensity: number, viewZ: number): Linear3 {
  const t = haze * fogFactor(fogDensity, viewZ);
  return [c[0] + (hazeColor[0] - c[0]) * t, c[1] + (hazeColor[1] - c[1]) * t, c[2] + (hazeColor[2] - c[2]) * t];
}

/**
 * `p = |uv − 0.5|·2; d = (pₓ^r + p_y^r)^(1/r) · 0.7071; mix(c, color, intensity · smoothstep(1 − feather, 1, d))` at `screenUV`
 * (u, v). Defaults: black, roundness 2, feather 0.45 (engine/api-reference.md:1671).
 */
export function vignetteMix(c: Vec3In, u: number, v: number, intensity: number, color: Vec3In = [0, 0, 0], roundness = 2, feather = 0.45): Linear3 {
  const px = Math.abs(u - 0.5) * 2;
  const py = Math.abs(v - 0.5) * 2;
  const d = (px ** roundness + py ** roundness) ** (1 / roundness) * VIGNETTE_SCALE;
  const t = intensity * smoothstep(1 - feather, 1, d);
  return [c[0] + (color[0] - c[0]) * t, c[1] + (color[1] - c[1]) * t, c[2] + (color[2] - c[2]) * t];
}

/**
 * three's `hash` (PCG, `three/src/nodes/math/Hash.js`) of a uint32 seed, in [0, 1]: `state = seed·747796405 + 2891336453;
 * word = ((state >> ((state >> 28) + 4)) ^ state)·277803737; result = ((word >> 22) ^ word) / 2³²`, with the shader's
 * uint → float32 conversion.
 */
export function pcgHash(seed: number): number {
  const state = (Math.imul(seed >>> 0, 747796405) + 2891336453) >>> 0;
  const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0;
  const result = ((word >>> 22) ^ word) >>> 0;
  return Math.fround(result) * 2 ** -32;
}

/**
 * The grain's seed for pixel (x, y) of frame `frame` (integers): `x + y·0x9E3779B1 + frame·0x85EBCA6B` in uint32 arithmetic.
 * render §10.5 writes `hash(screenCoordinate + frameId)`, which names no scalar seed; this one gives every pixel of every
 * frame its own seed, so a new frame is a new pattern (adding the frame to both coordinates would slide one pattern
 * diagonally by a pixel per frame).
 */
export function grainSeed(x: number, y: number, frame: number): number {
  return ((x >>> 0) + Math.imul(y >>> 0, GRAIN_ROW_PRIME) + Math.imul(frame >>> 0, GRAIN_FRAME_PRIME)) >>> 0;
}

/** the grain's hash value in [0, 1] at pixel (x, y) of frame `frame` */
export function grainValue(x: number, y: number, frame: number): number {
  return pcgHash(grainSeed(x, y, frame));
}

/** `c += (hash − 0.5) · intensity`, the same on every channel (additive, luminance-independent; [CAL `grainMode`]) */
export function grainAdd(c: Vec3In, x: number, y: number, frame: number, intensity: number): Linear3 {
  const d = (grainValue(x, y, frame) - 0.5) * intensity;
  return [c[0] + d, c[1] + d, c[2] + d];
}

/** `mix(c, c · tintColor, amount)` */
export function tintMix(c: Vec3In, tintColor: Vec3In, amount: number): Linear3 {
  return [c[0] + (c[0] * tintColor[0] - c[0]) * amount, c[1] + (c[1] * tintColor[1] - c[1]) * amount, c[2] + (c[2] * tintColor[2] - c[2]) * amount];
}

// ── three r186's output transform as its TSL nodes compute it ──────────────────────────────────────────────────────
// `renderOutput` runs three's TSL tone mapping and colour-space nodes, and two of them are not the textbook functions above:
//   - `RRTAndODTFit` (three/src/nodes/display/ToneMappingFunctions.js) has `b = v·((v + 0.432951)·0.983729) + 0.238081`: the
//     0.432951 term sits inside the 0.983729 factor, where the GLSL chunk of the WebGLRenderer (and `rrtAndOdtFit` above) has
//     `v·(0.983729·v + 0.432951) + 0.238081`. The TSL fit is up to 0.47 % brighter (0.42/255 at mid grey).
//   - `sRGBTransferOETF` (ColorSpaceFunctions.js) raises to 0.41666, not 1/2.4 (a difference under 2e-5).
// The pipeline draws with these nodes (render §10.2), so the read-back reference and the low-tier LUT bake use them too:
// a LUT baked from the textbook fit would sit 0.4/255 under the desktop path before any interpolation error.

/** three r186's TSL `RRTAndODTFit` */
export function rrtAndOdtFitTsl(v: number): number {
  const a = v * (v + 0.0245786) - 0.000090537;
  const b = v * ((v + 0.432951) * 0.983729) + 0.238081;
  return a / b;
}

/** three r186's TSL `acesFilmicToneMapping` (the `/0.6` pre-scale, the two matrices, the TSL fit, clamped to [0, 1]) */
export function acesFilmicTsl(c: Vec3In, exposure = 1): Linear3 {
  const k = exposure / 0.6;
  const v = mulRows(ACES_INPUT_MAT, [c[0] * k, c[1] * k, c[2] * k]);
  return map3(mulRows(ACES_OUTPUT_MAT, map3(v, rrtAndOdtFitTsl)), clamp01);
}

/** three r186's TSL `sRGBTransferOETF`: `mix(1.055·x^0.41666 − 0.055, 12.92·x, x ≤ 0.0031308)` */
export function srgbOETFTsl1(x: number): number {
  return x <= 0.0031308 ? x * 12.92 : 1.055 * x ** 0.41666 - 0.055;
}

/** three's `renderOutput` as r186 computes it: the TSL tone map, then the TSL sRGB OETF (the renderer's exposure is 1). */
export function displayTransform(c: Vec3In, toneMapping: 'aces' | 'neutral'): Linear3 {
  return map3(toneMapping === 'neutral' ? neutralToneMap(c) : acesFilmicTsl(c), srgbOETFTsl1);
}

/** where a fragment is: `screenUV`, its integer pixel (`floor(screenCoordinate)`), the frame id and the scene's view depth */
export interface LookPixel {
  u: number;
  v: number;
  x: number;
  y: number;
  frame: number;
  viewZ: number;
}

/** the look's environment; `fogColor` is in the look's domain (sRGB-encoded under `'aces-look'`, linear under `'look-aces'`) */
export interface LookEnvRef {
  fogDensity: number;
  fogColor: Vec3In;
}

/**
 * Runs recorded look ops (look-recorder.ts `LookOp`, colours already in the look's domain) on one colour: `grade` is its core,
 * then haze toward `hazeColor ?? fogColor`; `brightness` has no formula (render §10.5) and is neutral.
 */
export function applyLookOps(ops: readonly LookOp[], c: Vec3In, px: LookPixel, env: LookEnvRef): Linear3 {
  let out: Linear3 = [c[0], c[1], c[2]];
  for (const op of ops) {
    switch (op.op) {
      case 'grade':
        out = gradeCore(out, op);
        if (op.haze !== undefined) out = hazeMix(out, op.hazeColor ?? env.fogColor, op.haze, env.fogDensity, px.viewZ);
        break;
      case 'vignette':
        out = vignetteMix(out, px.u, px.v, op.intensity, op.color, op.roundness, op.feather);
        break;
      case 'grain':
        out = grainAdd(out, px.x, px.y, px.frame, op.intensity);
        break;
      case 'tint':
        out = tintMix(out, op.color, op.amount);
        break;
    }
  }
  return out;
}

/**
 * The frame after the bloom add, through the look and the output transform in `order` (render §10.1): `'aces-look'` grades
 * the display frame, `'look-aces'` grades linear HDR and tone-maps after.
 */
export function fullPathReference(order: TonemapOrder, toneMapping: 'aces' | 'neutral', ops: readonly LookOp[], scene: Vec3In, px: LookPixel, env: LookEnvRef): Linear3 {
  return order === 'aces-look' ? applyLookOps(ops, displayTransform(scene, toneMapping), px, env) : displayTransform(applyLookOps(ops, scene, px, env), toneMapping);
}
