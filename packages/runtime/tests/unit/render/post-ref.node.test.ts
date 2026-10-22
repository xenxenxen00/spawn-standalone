// WP R5a: TS references for the post chain (render §10.3, §10.5, §10.6, Appendix B.5-B.6; system-rendering-look.md §4.7-§4.8).
// They are the CPU side of the R5b post conformance (GLSL under SwiftShader vs these functions) and of the LUT check.
import { describe, expect, it } from 'vitest';
import {
  ACES_INPUT_MAT,
  ACES_OUTPUT_MAT,
  BLOOM_FACTORS,
  BLOOM_KERNEL_RADII,
  LUT_HEIGHT,
  LUT_LOG2_MAX,
  LUT_LOG2_MIN,
  LUT_SIZE,
  LUT_WIDTH,
  acesFilmic,
  bakeLut,
  blurPass,
  bloomLerpFactor,
  bloomMipSizes,
  bloomReference,
  gaussianCoefficients,
  highPass,
  luminance,
  lutShaper,
  lutTexelIndex,
  lutUnshaper,
  neutralToneMap,
  rgbImage,
  rrtAndOdtFit,
  sampleBilinear,
  sampleLut,
  srgbEOTF,
  srgbOETF,
  type Linear3,
  type RgbImage,
} from '../../../src/render/post/post-ref.ts';

const close3 = (a: Linear3, b: readonly number[], digits = 12): void => a.forEach((x, i) => expect(x).toBeCloseTo(b[i]!, digits));

describe('sRGB transfer (render B.5)', () => {
  it('OETF anchors and the linear segment', () => {
    const [zero, one, knee] = srgbOETF([0, 1, 0.0031308]);
    expect(zero).toBe(0);
    expect(one).toBeCloseTo(1, 15);
    expect(knee).toBe(0.0031308 * 12.92);
    expect(srgbOETF([0.18, 0.18, 0.18])[0]).toBeCloseTo(1.055 * 0.18 ** (1 / 2.4) - 0.055, 15);
    expect(srgbOETF([0.18, 0, 0])[0]).toBeCloseTo(0.461356, 6);
  });
  it('is continuous at the knee and inverted by the EOTF', () => {
    const k = 0.0031308;
    expect(srgbOETF([k + 1e-9, 0, 0])[0] - srgbOETF([k, 0, 0])[0]).toBeLessThan(1e-6);
    for (let x = 0; x <= 1; x += 1 / 64) close3(srgbEOTF(srgbOETF([x, x / 2, x / 3])), [x, x / 2, x / 3], 9);
  });
});

describe('three.js ACES filmic (render B.5, system-rendering-look.md §4.8)', () => {
  // §4.8 states the matrices row-major; an independent row-major evaluation must agree with the reference.
  const IN_ROWS = [
    [0.59719, 0.35458, 0.04823],
    [0.076, 0.90834, 0.01566],
    [0.0284, 0.13383, 0.83777],
  ];
  const OUT_ROWS = [
    [1.60475, -0.53108, -0.07367],
    [-0.10208, 1.10813, -0.00605],
    [-0.00327, -0.07276, 1.07602],
  ];
  const mul = (m: number[][], v: number[]): number[] => m.map((r) => r[0]! * v[0]! + r[1]! * v[1]! + r[2]! * v[2]!);
  const fit = (v: number): number => (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.432951) + 0.238081);
  const independent = (c: number[], exposure: number): number[] =>
    mul(OUT_ROWS, mul(IN_ROWS, c.map((x) => (x * exposure) / 0.6)).map(fit)).map((x) => Math.min(1, Math.max(0, x)));

  it('matrices are the row-major tables of §4.8', () => {
    expect(ACES_INPUT_MAT).toEqual(IN_ROWS);
    expect(ACES_OUTPUT_MAT).toEqual(OUT_ROWS);
  });
  it('RRT+ODT fit', () => {
    expect(rrtAndOdtFit(0)).toBeCloseTo(-0.000090537 / 0.238081, 15);
    expect(rrtAndOdtFit(1)).toBeCloseTo(fit(1), 15);
  });
  it('matches an independent evaluation incl. the /0.6 pre-scale and the clamp', () => {
    const samples = [
      [0, 0, 0],
      [0.18, 0.18, 0.18],
      [1, 1, 1],
      [4, 2, 0.5],
      [0.02, 0.5, 9],
      [100, 100, 100],
    ];
    for (const s of samples) for (const e of [1, 0.5, 2]) close3(acesFilmic(s as unknown as Linear3, e), independent(s, e), 12);
    expect(acesFilmic([0, 0, 0])).toEqual([0, 0, 0]);
    expect(acesFilmic([1000, 1000, 1000]).every((x) => x <= 1)).toBe(true);
  });
  it('is monotonic on the grey axis', () => {
    let prev = -1;
    for (let e = -12; e <= 6; e += 0.25) {
      const y = acesFilmic([2 ** e, 2 ** e, 2 ** e])[1];
      expect(y).toBeGreaterThanOrEqual(prev);
      prev = y;
    }
  });
});

describe('Khronos PBR Neutral (look.toneMapping = "neutral")', () => {
  it('leaves values under the compression start alone apart from the toe offset', () => {
    close3(neutralToneMap([0.5, 0.5, 0.5]), [0.46, 0.46, 0.46]);
    const x = 0.05;
    close3(neutralToneMap([x, x, x]), [6.25 * x * x, 6.25 * x * x, 6.25 * x * x]);
  });
  it('compresses highlights below 1 and desaturates toward the new peak', () => {
    const out = neutralToneMap([10, 2, 1]);
    expect(Math.max(...out)).toBeLessThan(1);
    expect(out[0]).toBeGreaterThan(out[1]);
    expect(out[1]).toBeGreaterThan(out[2]);
  });
});

describe('LUT shaper and layout (render §10.6)', () => {
  it('log2 shaper covers 2^-12 .. 2^4', () => {
    expect([LUT_LOG2_MIN, LUT_LOG2_MAX, LUT_SIZE, LUT_WIDTH, LUT_HEIGHT]).toEqual([-12, 4, 32, 1024, 32]);
    expect(lutShaper(2 ** -12)).toBe(0);
    expect(lutShaper(1)).toBe(0.75);
    expect(lutShaper(16)).toBe(1);
    expect(lutShaper(0)).toBe(0);
    expect(lutShaper(-1)).toBe(0);
    expect(lutShaper(1e6)).toBe(1);
    for (let s = 0; s <= 1; s += 1 / 31) expect(lutShaper(lutUnshaper(s))).toBeCloseTo(s, 12);
  });
  it('texel layout: blue picks the 32-texel slice, red the column inside it, green the row', () => {
    expect(lutTexelIndex(0, 0, 0)).toBe(0);
    expect(lutTexelIndex(1, 0, 0)).toBe(1);
    expect(lutTexelIndex(0, 0, 1)).toBe(32);
    expect(lutTexelIndex(0, 1, 0)).toBe(1024);
    expect(lutTexelIndex(31, 31, 31)).toBe(1024 * 32 - 1);
  });
  it('bake stores the 8-bit transform at every node; sampling reproduces it exactly there', () => {
    const transform = (c: Linear3): Linear3 => srgbOETF(acesFilmic(c));
    const lut = bakeLut(transform);
    expect(lut).toHaveLength(LUT_WIDTH * LUT_HEIGHT * 4);
    for (const [r, g, b] of [
      [0, 0, 0],
      [31, 31, 31],
      [5, 17, 29],
      [24, 3, 11],
    ] as const) {
      const c: Linear3 = [lutUnshaper(r / 31), lutUnshaper(g / 31), lutUnshaper(b / 31)];
      const want = transform(c).map((x) => Math.round(Math.min(1, Math.max(0, x)) * 255));
      const i = lutTexelIndex(r, g, b) * 4;
      expect([lut[i], lut[i + 1], lut[i + 2], lut[i + 3]]).toEqual([...want, 255]);
      close3(sampleLut(lut, c), want.map((x) => x / 255), 9);
    }
  });
  it('ACES + sRGB through the LUT stays within 1/255 of the direct evaluation on the grey ramp (render §10.6)', () => {
    const transform = (c: Linear3): Linear3 => srgbOETF(acesFilmic(c));
    const lut = bakeLut(transform);
    let worst = 0;
    for (let e = LUT_LOG2_MIN; e <= LUT_LOG2_MAX; e += 1 / 64) {
      const x = 2 ** e;
      const got = sampleLut(lut, [x, x, x]);
      const want = transform([x, x, x]);
      worst = Math.max(worst, ...got.map((v, i) => Math.abs(v - want[i]!)));
    }
    expect(worst).toBeLessThan(1 / 255);
  });
  it('trilinear sampling interpolates between nodes', () => {
    const lut = bakeLut((c) => c.map((x) => lutShaper(x)) as unknown as Linear3); // linear in shaped space
    const c: Linear3 = [lutUnshaper(0.3), lutUnshaper(0.61), lutUnshaper(0.07)];
    close3(sampleLut(lut, c), [0.3, 0.61, 0.07], 2);
  });
});

describe('three.js UnrealBloom / BloomNode (render §10.3, B.6; system-rendering-look.md §4.7)', () => {
  it('constants', () => {
    expect(BLOOM_KERNEL_RADII).toEqual([3, 5, 7, 9, 11]);
    expect(BLOOM_FACTORS).toEqual([1.0, 0.8, 0.6, 0.4, 0.2]);
  });
  it('mip sizes halve with rounding from the previous mip (three.js setSize)', () => {
    expect(bloomMipSizes(640, 360)).toEqual([
      [320, 180],
      [160, 90],
      [80, 45],
      [40, 23],
      [20, 12],
    ]);
    expect(bloomMipSizes(1920, 1080, 3)).toEqual([
      [960, 540],
      [480, 270],
      [240, 135],
    ]);
  });
  it('gaussian coefficients: 0.39894·exp(−x²/2σ²)/σ with σ = radius, x < radius', () => {
    for (const r of BLOOM_KERNEL_RADII) {
      const w = gaussianCoefficients(r);
      expect(w).toHaveLength(r);
      w.forEach((v, x) => expect(v).toBeCloseTo((0.39894 * Math.exp((-0.5 * x * x) / (r * r))) / r, 15));
    }
  });
  it('lerped factors sum to 3 whatever the radius', () => {
    for (const radius of [0, 0.3, 0.8, 1]) {
      expect(BLOOM_FACTORS.reduce((s, f) => s + bloomLerpFactor(f, radius), 0)).toBeCloseTo(3, 12);
    }
    expect(bloomLerpFactor(0.2, 1)).toBeCloseTo(1.0, 15);
  });
  it('high-pass: Rec.709 luminance, smoothstep(t, t + 0.01)', () => {
    expect(luminance([1, 0, 0])).toBe(0.2126);
    expect(highPass([0.5, 0.5, 0.5], 1)).toEqual([0, 0, 0]);
    expect(highPass([2, 2, 2], 1)).toEqual([2, 2, 2]);
    const mid = highPass([1.005, 1.005, 1.005], 1)[0] / 1.005;
    expect(mid).toBeCloseTo(0.5, 6);
  });
  it('bilinear sampling uses texel centres and clamps to the edge', () => {
    const img = rgbImage(2, 1, new Float32Array([0, 0, 0, 1, 2, 4]));
    expect(sampleBilinear(img, 0.25, 0.5)).toEqual([0, 0, 0]);
    expect(sampleBilinear(img, 0.75, 0.5)).toEqual([1, 2, 4]);
    expect(sampleBilinear(img, 0.5, 0.5)).toEqual([0.5, 1, 2]);
    expect(sampleBilinear(img, -3, 9)).toEqual([0, 0, 0]);
  });
  it('a blur pass preserves a constant image and spreads an impulse symmetrically', () => {
    const flat = rgbImage(8, 8, new Float32Array(8 * 8 * 3).fill(0.7));
    for (const v of blurPass(flat, 8, 8, 'h', 5).data) expect(v).toBeCloseTo(0.7, 6);
    const imp = rgbImage(9, 1, new Float32Array(27));
    imp.data.set([1, 1, 1], 4 * 3);
    const out = blurPass(imp, 9, 1, 'h', 3);
    const px = (x: number): number => out.data[x * 3]!;
    expect(px(3)).toBeCloseTo(px(5), 12);
    expect(px(2)).toBeCloseTo(px(6), 12);
    expect(px(4)).toBeGreaterThan(px(3));
    const w = gaussianCoefficients(3);
    const norm = w[0]! + 2 * (w[1]! + w[2]!);
    expect(px(4)).toBeCloseTo(w[0]! / norm, 6);
    expect(px(0)).toBe(0);
  });
  it('bloom of a constant above threshold adds strength·3·c; below threshold adds nothing', () => {
    const c = 2.5;
    const bright = rgbImage(64, 36, new Float32Array(64 * 36 * 3).fill(c));
    const res = bloomReference(bright, { strength: 0.6, radius: 0.8, threshold: 1 });
    expect([res.bloom.width, res.bloom.height]).toEqual([32, 18]);
    for (const v of res.output.data) expect(v).toBeCloseTo(c + 0.6 * 3 * c, 4);
    const dim: RgbImage = rgbImage(64, 36, new Float32Array(64 * 36 * 3).fill(0.4));
    const res2 = bloomReference(dim, { strength: 0.6, radius: 0.8, threshold: 1 });
    for (const v of res2.output.data) expect(v).toBeCloseTo(0.4, 6);
  });
  it('fewer mips drop the widest terms', () => {
    const c = 2;
    const img = rgbImage(64, 64, new Float32Array(64 * 64 * 3).fill(c));
    const res = bloomReference(img, { strength: 1, radius: 0, threshold: 1 }, 3);
    // radius 0: factors 1.0 + 0.8 + 0.6
    for (const v of res.output.data) expect(v).toBeCloseTo(c + 2.4 * c, 4);
  });
});
