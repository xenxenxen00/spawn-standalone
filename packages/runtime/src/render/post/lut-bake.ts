// CPU bake of the low-tier 32³ LUT (docs/design/rendering.md §10.6; WP R5b). Engine-free: the values are computed from the TS
// references of post-ref.ts, which the read-back tests hold equal to the TSL graph, and render-pipeline.ts uploads them as a
// `Data3DTexture` sampled with three's `lut3D()`.
//
// The LUT replaces only the per-colour part of the chain. In the default order (`tonemapOrder = 'aces-look'`) the full path is
// bloom add → tone map → OETF → grade core → haze → vignette → grain, so the LUT holds `gradeCore ∘ OETF ∘ toneMap`, a pure
// function of the linear HDR colour, indexed through the log2 shaper `s = clamp((log2(c) − lo) / (hi − lo), 0, 1)`; haze,
// vignette and grain stay TSL and follow the lookup. In `'look-aces'` haze, vignette and grain sit between the grade core and the
// tone map, so no single LUT holds that chain without reordering it and the low tiers run the full graph; `lutTransform` still
// gives that order's composition (`OETF ∘ toneMap ∘ gradeCore`) for the calibration tools and the reference tests.
//
// Encoding: half float (RGBA16F), unclamped. render §10.6 names RGBA8, but the grade core is not confined to [0, 1]: kf2-mix
// lifts a mid grey of linear 0.41 past 1 and saturation > 1 pushes a channel below 0, and the steps that follow the lookup
// (haze, vignette, grain) run on that unclamped value on the full path. An 8-bit LUT clamps it first, which measured up to
// 5.4/255 (kf2-mix) and 11.4/255 (a dense scene) off the full path on the grey ramp, at the knee where a channel reaches 1, and
// far more under the vignette for over-range colours. Half float keeps the value, and RGBA16F is filterable in core WebGL2.
// `bakeLut3DBytes` is the RGBA8 form: the same bytes as post-ref.ts `bakeLut`, re-laid for a 3D texture.
//
// Node values: `bakeLut3DBytes` and `bakeLut3DHalf` sample the transform at the nodes. `bakeLookLut`, which is what the pipeline
// uploads, also takes the interpolation's one-sided bias off the nodes (see "curvature compensation" below); without that
// a dense scene' grey ramp sits 1.11/255 from the full path, outside the 1/255 render §10.6 asks for.
//
// Layout: a `Data3DTexture` is indexed `b·32·32 + g·32 + r` (x = r, y = g, z = b). post-ref.ts `bakeLut` writes a 1024 × 32
// strip (`g·1024 + b·32 + r`), the layout of the 2D fallback of render §10.6. `lut3D()` reads node i of a channel at
// `uvw = 0.5/32 + s·(1 − 1/32)` with `s = i/31`, so node i stands for the linear value `2^(lo + (hi − lo)·i/31)`.
import {
  LUT_LOG2_MAX,
  LUT_LOG2_MIN,
  LUT_SIZE,
  displayTransform,
  gradeCore,
  type GradeCoreOptions,
  type Linear3,
  type TonemapOrder,
} from './post-ref.ts';

type Vec3In = readonly [number, number, number];

/** channel values of the 32³ RGBA texture (bytes for RGBA8, uint16 half-float bits for RGBA16F) */
export const LUT3D_VALUES = LUT_SIZE * LUT_SIZE * LUT_SIZE * 4;

/** log2 range of the shaper: [−12, 4], or [−12, 0] on a device without half-float rendering (`DeviceCaps.lutShaperLog2`) */
export type LutLog2Range = readonly [number, number];
export const LUT_LOG2_RANGE: LutLog2Range = Object.freeze([LUT_LOG2_MIN, LUT_LOG2_MAX] as const);

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** Texel index of LUT node (r, g, b) in a `Data3DTexture`'s data: x = r, y = g, z = b. */
export function lut3dTexelIndex(r: number, g: number, b: number): number {
  return (b * LUT_SIZE + g) * LUT_SIZE + r;
}

/** `clamp((log2(c) − lo) / (hi − lo), 0, 1)`; 0 for c ≤ 0 */
export function lutShaperRange(c: number, range: LutLog2Range = LUT_LOG2_RANGE): number {
  if (!(c > 0)) return 0;
  return clamp01((Math.log2(c) - range[0]) / (range[1] - range[0]));
}

/** the linear value node `i` (0..31) of a channel stands for */
export function lutNodeValue(i: number, range: LutLog2Range = LUT_LOG2_RANGE): number {
  return 2 ** ((i / (LUT_SIZE - 1)) * (range[1] - range[0]) + range[0]);
}

// ── half float ────────────────────────────────────────────────────────────────────────────────────────────────────

const F32 = new Float32Array(1);
const U32 = new Uint32Array(F32.buffer);
const HALF_MAX = 65504;

/** IEEE 754 binary16 bits of `v`, rounded to nearest; out-of-range values clamp to ±65504, NaN becomes 0. */
export function toHalfFloat(v: number): number {
  if (Number.isNaN(v)) return 0;
  F32[0] = Math.max(-HALF_MAX, Math.min(HALF_MAX, v));
  const x = U32[0]!;
  const sign = (x >>> 16) & 0x8000;
  const exp = (x >>> 23) & 0xff;
  const mant = x & 0x7fffff;
  if (exp < 102) return sign; // below half the smallest subnormal
  if (exp < 113) {
    // subnormal half: shift the 24-bit significand down, rounding to nearest
    const m = mant | 0x800000;
    const shift = 126 - exp;
    return sign | ((m >>> shift) + ((m >>> (shift - 1)) & 1));
  }
  // normal: a carry out of the 10-bit mantissa moves into the exponent, which is the right result
  return (sign | ((exp - 112) << 10) | (mant >>> 13)) + ((mant >>> 12) & 1);
}

/** the number a binary16 bit pattern stands for */
export function fromHalfFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exp = (h >>> 10) & 0x1f;
  const mant = h & 0x3ff;
  if (exp === 0) return sign * mant * 2 ** -24;
  if (exp === 31) return mant === 0 ? sign * Number.POSITIVE_INFINITY : Number.NaN;
  return sign * (1 + mant / 1024) * 2 ** (exp - 15);
}

// ── bake ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function checkRange(range: LutLog2Range): void {
  if (!(Number.isFinite(range[0]) && Number.isFinite(range[1]) && range[0] < range[1])) throw new RangeError(`LUT bake: bad log2 range ${JSON.stringify(range)}`);
}

function bakeInto(transform: (c: Linear3) => Vec3In, range: LutLog2Range, out: Uint8Array | Uint16Array, encode: (v: number) => number, alpha: number): void {
  checkRange(range);
  if (out.length !== LUT3D_VALUES) throw new RangeError(`LUT bake: the buffer must hold ${LUT3D_VALUES} values (32³ RGBA), got ${out.length}`);
  const node: number[] = [];
  for (let i = 0; i < LUT_SIZE; i++) node.push(lutNodeValue(i, range));
  let o = 0;
  for (let b = 0; b < LUT_SIZE; b++) {
    for (let g = 0; g < LUT_SIZE; g++) {
      for (let r = 0; r < LUT_SIZE; r++) {
        const v = transform([node[r]!, node[g]!, node[b]!]);
        out[o] = encode(v[0]);
        out[o + 1] = encode(v[1]);
        out[o + 2] = encode(v[2]);
        out[o + 3] = alpha;
        o += 4;
      }
    }
  }
}

/**
 * Bakes `transform` (scene-linear in, display-referred out) at every node as half floats in the `Data3DTexture` layout, without
 * clamping (alpha 1). `out` is reused when given: a rebake writes into the texture's own buffer.
 */
export function bakeLut3DHalf(transform: (c: Linear3) => Vec3In, range: LutLog2Range = LUT_LOG2_RANGE, out: Uint16Array = new Uint16Array(LUT3D_VALUES)): Uint16Array {
  bakeInto(transform, range, out, toHalfFloat, 0x3c00);
  return out;
}

/** The RGBA8 form: clamped to [0, 1] and rounded to nearest, alpha 255 (post-ref.ts `bakeLut` in the 3D layout). */
export function bakeLut3DBytes(transform: (c: Linear3) => Vec3In, range: LutLog2Range = LUT_LOG2_RANGE, out: Uint8Array = new Uint8Array(LUT3D_VALUES)): Uint8Array {
  bakeInto(transform, range, out, (v) => Math.round(clamp01(v) * 255), 255);
  return out;
}

export interface LookLutSpec {
  order: TonemapOrder;
  toneMapping: 'aces' | 'neutral';
  /** the look's first grade without its haze, as numbers in the look's domain; null = no grade folded (the output transform alone) */
  core: GradeCoreOptions | null;
  log2Range?: LutLog2Range;
}

/** The per-colour chain of `spec`: linear HDR in, display-referred out (unclamped after a grade). */
export function lutTransform(spec: Pick<LookLutSpec, 'order' | 'toneMapping' | 'core'>): (c: Linear3) => Linear3 {
  const { order, toneMapping, core } = spec;
  if (order !== 'aces-look' && order !== 'look-aces') throw new RangeError(`LUT bake: unknown tonemapOrder ${JSON.stringify(order)}`);
  if (toneMapping !== 'aces' && toneMapping !== 'neutral') throw new RangeError(`LUT bake: unknown toneMapping ${JSON.stringify(toneMapping)}`);
  if (core === null) return (c) => displayTransform(c, toneMapping);
  return order === 'aces-look' ? (c) => gradeCore(displayTransform(c, toneMapping), core) : (c) => displayTransform(gradeCore(c, core), toneMapping);
}

// ── curvature compensation ────────────────────────────────────────────────────────────────────────────────────────
// Trilinear interpolation reproduces every multilinear function exactly; on a smooth function its error inside a cell is
// `−Σ_axis ½·t·(1 − t)·h²·f_aa`, one-signed wherever the function bends one way along the axes and largest at the cell centre
// (`h²·f_aa / 8` per axis). `h²·f_aa` at a node is the second difference of the node values along that axis, so subtracting a
// sixteenth of each axis's second difference from every node shifts the interpolant by half of that centre error: the error
// then swings about zero and its maximum halves. Measured on the grey ramp through the half-float LUT, plain → compensated, in
// 8-bit levels: kf2-mix 0.63 → 0.33, a scene fixture 0.72 → 0.37, a dense scene 1.11 → 0.58, training 0.70 → 0.36. The plain bake
// misses the 1/255 of render §10.6 on a dense scene (exposure 1.3 · contrast 1.18 bends faster than half-stop nodes follow).

/** the share of each axis's second difference taken off a node */
export const LUT_CURVATURE_SHARE = 1 / 16;

/** `transform` at every node: 32³ RGB triples in the `Data3DTexture` order */
export function lutNodeValues(transform: (c: Linear3) => Vec3In, range: LutLog2Range = LUT_LOG2_RANGE): Float64Array {
  checkRange(range);
  const out = new Float64Array(LUT_SIZE * LUT_SIZE * LUT_SIZE * 3);
  const node: number[] = [];
  for (let i = 0; i < LUT_SIZE; i++) node.push(lutNodeValue(i, range));
  let o = 0;
  for (let b = 0; b < LUT_SIZE; b++) {
    for (let g = 0; g < LUT_SIZE; g++) {
      for (let r = 0; r < LUT_SIZE; r++) {
        const v = transform([node[r]!, node[g]!, node[b]!]);
        out[o] = v[0];
        out[o + 1] = v[1];
        out[o + 2] = v[2];
        o += 3;
      }
    }
  }
  return out;
}

/**
 * Node values whose trilinear interpolant sits around the function instead of on one side of it: every node less
 * `share` × the sum of its second differences along the three axes (an axis on which the node is the first or the last has
 * none). Returns a new array; `nodes` is `lutNodeValues`' layout.
 */
export function compensateLutCurvature(nodes: Float64Array, share: number = LUT_CURVATURE_SHARE): Float64Array {
  const n = LUT_SIZE;
  if (nodes.length !== n * n * n * 3) throw new RangeError(`LUT bake: expected ${n * n * n * 3} node values (32³ RGB), got ${nodes.length}`);
  const out = new Float64Array(nodes.length);
  const steps = [3, n * 3, n * n * 3]; // one node along r, g, b
  for (let b = 0; b < n; b++) {
    for (let g = 0; g < n; g++) {
      for (let r = 0; r < n; r++) {
        const at = ((b * n + g) * n + r) * 3;
        const coord = [r, g, b];
        for (let ch = 0; ch < 3; ch++) {
          const c = nodes[at + ch]!;
          let bend = 0;
          for (let axis = 0; axis < 3; axis++) {
            if (coord[axis]! === 0 || coord[axis]! === n - 1) continue;
            bend += nodes[at + ch - steps[axis]!]! - 2 * c + nodes[at + ch + steps[axis]!]!;
          }
          out[at + ch] = c - share * bend;
        }
      }
    }
  }
  return out;
}

/**
 * The LUT of a look as the pipeline uploads it: the nodes of `lutTransform(spec)`, curvature-compensated, as unclamped half
 * floats in the `Data3DTexture` layout (alpha 1). `out` is reused when given.
 */
export function bakeLookLut(spec: LookLutSpec, out: Uint16Array = new Uint16Array(LUT3D_VALUES)): Uint16Array {
  if (out.length !== LUT3D_VALUES) throw new RangeError(`LUT bake: the buffer must hold ${LUT3D_VALUES} values (32³ RGBA), got ${out.length}`);
  const nodes = compensateLutCurvature(lutNodeValues(lutTransform(spec), spec.log2Range ?? LUT_LOG2_RANGE));
  for (let i = 0, o = 0; i < nodes.length; i += 3, o += 4) {
    out[o] = toHalfFloat(nodes[i]!);
    out[o + 1] = toHalfFloat(nodes[i + 1]!);
    out[o + 2] = toHalfFloat(nodes[i + 2]!);
    out[o + 3] = 0x3c00;
  }
  return out;
}

/**
 * CPU model of `lut3D()` over a baked texture (half-float bits or RGBA8 bytes): the shaper, then a trilinear lookup between the
 * eight nodes around the colour.
 */
export function sampleLut3D(lut: Uint16Array | Uint8Array, c: Vec3In, range: LutLog2Range = LUT_LOG2_RANGE): Linear3 {
  if (lut.length !== LUT3D_VALUES) throw new RangeError(`sampleLut3D: expected ${LUT3D_VALUES} values (32³ RGBA)`);
  const decode = lut instanceof Uint8Array ? (v: number): number => v / 255 : fromHalfFloat;
  const axis = (x: number): [number, number, number] => {
    const f = lutShaperRange(x, range) * (LUT_SIZE - 1);
    const i0 = Math.min(LUT_SIZE - 1, Math.floor(f));
    return [i0, Math.min(LUT_SIZE - 1, i0 + 1), f - i0];
  };
  const [r0, r1, tr] = axis(c[0]);
  const [g0, g1, tg] = axis(c[1]);
  const [b0, b1, tb] = axis(c[2]);
  const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
  const out: Linear3 = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    const at = (r: number, g: number, b: number): number => decode(lut[lut3dTexelIndex(r, g, b) * 4 + ch]!);
    const c00 = lerp(at(r0, g0, b0), at(r1, g0, b0), tr);
    const c10 = lerp(at(r0, g1, b0), at(r1, g1, b0), tr);
    const c01 = lerp(at(r0, g0, b1), at(r1, g0, b1), tr);
    const c11 = lerp(at(r0, g1, b1), at(r1, g1, b1), tr);
    out[ch] = lerp(lerp(c00, c10, tg), lerp(c01, c11, tg), tb);
  }
  return out;
}
