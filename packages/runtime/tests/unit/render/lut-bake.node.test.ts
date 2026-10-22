// WP R5b: the CPU bake of the low-tier 32³ LUT (render §10.6). The LUT holds the per-colour part of the chain as a function of
// the linear HDR colour after the bloom add: `gradeCore ∘ OETF ∘ toneMap` in the default `'aces-look'` order, laid out for a
// `Data3DTexture` (x = r, y = g, z = b). Two encodings: RGBA8 bytes, which are `post-ref.ts` `bakeLut` of the composed reference
// re-laid from its 1024 × 32 strip, and the unclamped half floats the pipeline uploads.
import { describe, expect, it } from 'vitest';
import {
  LUT3D_VALUES,
  LUT_CURVATURE_SHARE,
  bakeLookLut,
  bakeLut3DBytes,
  bakeLut3DHalf,
  compensateLutCurvature,
  fromHalfFloat,
  lut3dTexelIndex,
  lutNodeValue,
  lutNodeValues,
  lutShaperRange,
  lutTransform,
  sampleLut3D,
  toHalfFloat,
} from '../../../src/render/post/lut-bake.ts';
import {
  LUT_LOG2_MAX,
  LUT_LOG2_MIN,
  LUT_SIZE,
  acesFilmic,
  bakeLut,
  displayTransform,
  gradeCore,
  lutShaper,
  lutTexelIndex,
  lutUnshaper,
  sampleLut,
  srgbOETF,
  type GradeCoreOptions,
  type Linear3,
} from '../../../src/render/post/post-ref.ts';

const KF2: GradeCoreOptions = { exposure: 1.08, saturation: 1.05, contrast: 1.14, temperature: 0.06, lift: [0.012, 0.022, 0.03], gamma: 1.12, gain: [1.04, 1.0, 0.94] };
const CRADLE: GradeCoreOptions = { exposure: 1.3, saturation: 0.95, contrast: 1.18, temperature: -0.02, tint: 0 };
const TRAINING: GradeCoreOptions = { exposure: 0.9, saturation: 0.72, contrast: 1.18, temperature: -0.02, tint: 0 };
const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));

/** the 3D-layout values re-read in the 2D strip's order */
function asStrip(lut3d: Uint8Array): Uint8Array {
  const out = new Uint8Array(lut3d.length);
  for (let b = 0; b < LUT_SIZE; b++) {
    for (let g = 0; g < LUT_SIZE; g++) {
      for (let r = 0; r < LUT_SIZE; r++) {
        out.set(lut3d.subarray(lut3dTexelIndex(r, g, b) * 4, lut3dTexelIndex(r, g, b) * 4 + 4), lutTexelIndex(r, g, b) * 4);
      }
    }
  }
  return out;
}

describe('layout', () => {
  it('a Data3DTexture is indexed b·32·32 + g·32 + r; the 2D strip is g·1024 + b·32 + r', () => {
    expect(LUT3D_VALUES).toBe(32 * 32 * 32 * 4);
    expect(lut3dTexelIndex(1, 0, 0)).toBe(1);
    expect(lut3dTexelIndex(0, 1, 0)).toBe(32);
    expect(lut3dTexelIndex(0, 0, 1)).toBe(1024);
    expect(lut3dTexelIndex(31, 31, 31)).toBe(32 * 32 * 32 - 1);
    expect(lutTexelIndex(0, 1, 0)).toBe(1024);
    expect(lutTexelIndex(0, 0, 1)).toBe(32);
    // green and blue trade places between the two layouts
    expect(lut3dTexelIndex(3, 5, 7)).toBe(lutTexelIndex(3, 7, 5));
  });

  it('a channel-tagging transform lands every node where lut3D() will look for it, in both encodings', () => {
    // node (r, g, b) → (r, g, b) / 31: the texel at (x, y, z) must hold (x, y, z) / 31
    const tag = (c: Linear3): Linear3 => c.map((x) => lutShaper(x)) as Linear3;
    const bytes = bakeLut3DBytes(tag);
    const half = bakeLut3DHalf(tag);
    for (const [r, g, b] of [
      [0, 0, 0],
      [31, 0, 0],
      [0, 31, 0],
      [0, 0, 31],
      [7, 19, 28],
    ] as const) {
      const o = (b * 32 * 32 + g * 32 + r) * 4;
      expect([bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]]).toEqual([Math.round((r / 31) * 255), Math.round((g / 31) * 255), Math.round((b / 31) * 255), 255]);
      expect(fromHalfFloat(half[o]!)).toBeCloseTo(r / 31, 3);
      expect(fromHalfFloat(half[o + 1]!)).toBeCloseTo(g / 31, 3);
      expect(fromHalfFloat(half[o + 2]!)).toBeCloseTo(b / 31, 3);
      expect(fromHalfFloat(half[o + 3]!)).toBe(1);
    }
  });
});

describe('half float', () => {
  it('encodes exactly what binary16 can hold and rounds the rest to nearest', () => {
    for (const [v, bits] of [
      [0, 0x0000],
      [1, 0x3c00],
      [-1, 0xbc00],
      [0.5, 0x3800],
      [2, 0x4000],
      [1 + 2 ** -10, 0x3c01],
      [65504, 0x7bff],
      [2 ** -14, 0x0400], // smallest normal
      [2 ** -24, 0x0001], // smallest subnormal
      [2 ** -15, 0x0200],
    ] as const) {
      expect(toHalfFloat(v), String(v)).toBe(bits);
      expect(fromHalfFloat(bits), String(v)).toBe(v);
    }
    expect(toHalfFloat(1e9)).toBe(0x7bff); // clamps instead of becoming Infinity
    expect(toHalfFloat(-1e9)).toBe(0xfbff);
    expect(toHalfFloat(Number.NaN)).toBe(0);
    expect(toHalfFloat(2 ** -26)).toBe(0);
    expect(toHalfFloat(1 + 2 ** -11)).toBe(0x3c01); // a tie rounds up
    expect(toHalfFloat(2 - 2 ** -12)).toBe(0x4000); // the carry moves into the exponent
    for (const v of [0.0123, 0.18, 0.7071, 1.3, 3.7, -0.004, 2.3e-5]) expect(Math.abs(fromHalfFloat(toHalfFloat(v)) - v)).toBeLessThanOrEqual(Math.abs(v) * 2 ** -11);
  });
});

describe('bake', () => {
  it('RGBA8: post-ref bakeLut of the same transform, texel for texel, in the 3D layout', () => {
    const t = (c: Linear3): Linear3 => srgbOETF(acesFilmic(c));
    expect(asStrip(bakeLut3DBytes(t))).toEqual(bakeLut(t));
  });

  it.each([
    ['aces', KF2],
    ['aces', CRADLE],
    ['neutral', KF2],
    ['aces', null],
  ] as const)('"aces-look" (%s): gradeCore ∘ OETF ∘ toneMap, a function of the linear HDR colour', (toneMapping, core) => {
    const want = (c: Linear3): Linear3 => (core === null ? displayTransform(c, toneMapping) : gradeCore(displayTransform(c, toneMapping), core));
    const t = lutTransform({ order: 'aces-look', toneMapping, core });
    const c: Linear3 = [0.6, 0.3, 0.1];
    expect(t(c)).toEqual(want(c));
    // RGBA8 bytes: the M0 reference bake of the composed chain
    expect(asStrip(bakeLut3DBytes(t))).toEqual(bakeLut(want));
    // the same nodes as half floats, not clamped
    const half = bakeLut3DHalf(t);
    expect(half).toBeInstanceOf(Uint16Array);
    expect(half).toHaveLength(LUT3D_VALUES);
    const nodes = lutNodeValues(t);
    expect(nodes).toHaveLength(32 * 32 * 32 * 3);
    const at = (r: number, g: number, b: number): Linear3 => want([lutNodeValue(r), lutNodeValue(g), lutNodeValue(b)]);
    const SAMPLES = [
      [0, 0, 0],
      [31, 31, 31],
      [20, 22, 24],
      [27, 5, 12],
      [16, 16, 16],
      [17, 0, 31],
    ] as const;
    for (const [r, g, b] of SAMPLES) {
      const v = at(r, g, b);
      const o = lut3dTexelIndex(r, g, b);
      for (let ch = 0; ch < 3; ch++) {
        expect(nodes[o * 3 + ch]).toBe(v[ch]);
        expect(Math.abs(fromHalfFloat(half[o * 4 + ch]!) - v[ch]!)).toBeLessThanOrEqual(Math.abs(v[ch]!) * 2 ** -11 + 2 ** -24);
      }
      expect(half[o * 4 + 3]).toBe(0x3c00);
    }
    // what the pipeline uploads: every node less a sixteenth of its second differences along the axes it is inside of
    const lut = bakeLookLut({ order: 'aces-look', toneMapping, core });
    expect(lut).toBeInstanceOf(Uint16Array);
    expect(lut).toHaveLength(LUT3D_VALUES);
    for (const [r, g, b] of SAMPLES) {
      const v = at(r, g, b);
      const inside = (i: number): boolean => i > 0 && i < 31;
      const o = lut3dTexelIndex(r, g, b) * 4;
      for (let ch = 0; ch < 3; ch++) {
        let bend = 0;
        if (inside(r)) bend += at(r - 1, g, b)[ch]! - 2 * v[ch]! + at(r + 1, g, b)[ch]!;
        if (inside(g)) bend += at(r, g - 1, b)[ch]! - 2 * v[ch]! + at(r, g + 1, b)[ch]!;
        if (inside(b)) bend += at(r, g, b - 1)[ch]! - 2 * v[ch]! + at(r, g, b + 1)[ch]!;
        const expected = v[ch]! - bend / 16;
        expect(Math.abs(fromHalfFloat(lut[o + ch]!) - expected)).toBeLessThanOrEqual(Math.abs(expected) * 2 ** -11 + 2 ** -24);
      }
      expect(lut[o + 3]).toBe(0x3c00);
    }
  });

  it('curvature compensation: a multilinear function is left alone, a bent one moves by a sixteenth of its second differences', () => {
    expect(LUT_CURVATURE_SHARE).toBe(1 / 16);
    // multilinear in the node indices: trilinear interpolation is already exact, every second difference is zero
    const multilinear = new Float64Array(32 * 32 * 32 * 3);
    const quadratic = new Float64Array(32 * 32 * 32 * 3);
    for (let b = 0; b < 32; b++) {
      for (let g = 0; g < 32; g++) {
        for (let r = 0; r < 32; r++) {
          const o = lut3dTexelIndex(r, g, b) * 3;
          multilinear.set([r + 2 * g - b, r * g, r * g * b + 1], o);
          quadratic.set([r * r, g * g + b * b, r * r + g * g + b * b], o);
        }
      }
    }
    const same = compensateLutCurvature(multilinear);
    expect(same).not.toBe(multilinear);
    expect(Array.from(same)).toEqual(Array.from(multilinear));
    const bent = compensateLutCurvature(quadratic);
    // i² has second difference 2 along its axis: an inside node moves by 2/16 per bent axis, a face node only along the axes it is inside of
    const inner = lut3dTexelIndex(5, 6, 7) * 3;
    expect([bent[inner]! - quadratic[inner]!, bent[inner + 1]! - quadratic[inner + 1]!, bent[inner + 2]! - quadratic[inner + 2]!]).toEqual([-2 / 16, -4 / 16, -6 / 16]);
    const face = lut3dTexelIndex(0, 6, 31) * 3;
    expect([bent[face]! - quadratic[face]!, bent[face + 1]! - quadratic[face + 1]!, bent[face + 2]! - quadratic[face + 2]!]).toEqual([0, -2 / 16, -2 / 16]);
    const corner = lut3dTexelIndex(31, 31, 31) * 3;
    expect(bent[corner + 2]).toBe(quadratic[corner + 2]);
    expect(compensateLutCurvature(quadratic, 0)).toEqual(quadratic);
    expect(() => compensateLutCurvature(new Float64Array(12))).toThrow(/98304 node values/);
  });

  it('keeps what the grade pushes out of [0, 1]: the steps after the lookup run on the unclamped value', () => {
    const lut = bakeLookLut({ order: 'aces-look', toneMapping: 'aces', core: KF2 });
    const white = lut3dTexelIndex(31, 31, 31) * 4;
    expect(fromHalfFloat(lut[white]!)).toBeGreaterThan(1.1); // display white under kf2-mix's gain, gamma and contrast
    expect(bakeLut3DBytes(lutTransform({ order: 'aces-look', toneMapping: 'aces', core: KF2 }))[white]).toBe(255);
    // saturation > 1 takes a channel below zero
    const sat = bakeLookLut({ order: 'aces-look', toneMapping: 'aces', core: { saturation: 1.6 } });
    let negative = false;
    for (let i = 0; i < sat.length; i += 4) if (fromHalfFloat(sat[i + 2]!) < 0) negative = true;
    expect(negative).toBe(true);
  });

  it('"look-aces": the single LUT that order would need is OETF ∘ toneMap ∘ gradeCore (the pipeline runs the full graph instead)', () => {
    const want = (c: Linear3): Linear3 => displayTransform(gradeCore(c, KF2), 'aces');
    expect(asStrip(bakeLut3DBytes(lutTransform({ order: 'look-aces', toneMapping: 'aces', core: KF2 })))).toEqual(bakeLut(want));
    // the two orders are different LUTs
    expect(bakeLookLut({ order: 'look-aces', toneMapping: 'aces', core: KF2 })).not.toEqual(bakeLookLut({ order: 'aces-look', toneMapping: 'aces', core: KF2 }));
    expect(() => lutTransform({ order: 'aces' as never, toneMapping: 'aces', core: null })).toThrow(/tonemapOrder/);
    expect(() => lutTransform({ order: 'aces-look', toneMapping: 'filmic' as never, core: null })).toThrow(/toneMapping/);
  });

  it('rebakes into the same buffer (a look param write re-sends the whole texture, no new one)', () => {
    const buf = new Uint16Array(LUT3D_VALUES);
    const a = bakeLookLut({ order: 'aces-look', toneMapping: 'aces', core: KF2 }, buf);
    expect(a).toBe(buf);
    const first = buf.slice();
    bakeLookLut({ order: 'aces-look', toneMapping: 'aces', core: { ...KF2, exposure: 1.32 } }, buf);
    expect(buf).not.toEqual(first);
    expect(() => bakeLookLut({ order: 'aces-look', toneMapping: 'aces', core: KF2 }, new Uint16Array(16))).toThrow(/131072 values/);
  });
});

describe('shaper range', () => {
  it('the default range is post-ref’s 2⁻¹² .. 2⁴', () => {
    for (const c of [0, 1e-5, 2 ** -12, 0.18, 1, 4, 16, 100]) expect(lutShaperRange(c, [LUT_LOG2_MIN, LUT_LOG2_MAX])).toBe(lutShaper(c));
    for (let i = 0; i < 32; i++) expect(lutNodeValue(i, [LUT_LOG2_MIN, LUT_LOG2_MAX])).toBe(lutUnshaper(i / 31));
  });

  it('a device without half-float rendering cuts it to 2⁻¹² .. 2⁰ (render §3.1, §10.6)', () => {
    const range = [-12, 0] as const;
    expect(lutShaperRange(1, range)).toBe(1);
    expect(lutShaperRange(4, range)).toBe(1);
    expect(lutShaperRange(2 ** -12, range)).toBe(0);
    expect(lutShaperRange(2 ** -6, range)).toBeCloseTo(0.5, 12);
    expect(lutNodeValue(31, range)).toBe(1);
    expect(lutNodeValue(0, range)).toBe(2 ** -12);
    const t = (c: Linear3): Linear3 => displayTransform(c, 'aces');
    const lut = bakeLut3DBytes(t, range);
    // the last node is linear 1, not 16
    const o = lut3dTexelIndex(31, 31, 31) * 4;
    expect(lut[o]).toBe(Math.round(t([1, 1, 1])[0] * 255));
    expect(lut).not.toEqual(bakeLut3DBytes(t));
    // the look's LUT is baked over the same range: its corner node (no neighbours to bend against) is the plain one
    const look = bakeLookLut({ order: 'aces-look', toneMapping: 'aces', core: null, log2Range: range });
    expect(look.slice(o, o + 4)).toEqual(bakeLut3DHalf(t, range).slice(o, o + 4));
    expect(look).not.toEqual(bakeLookLut({ order: 'aces-look', toneMapping: 'aces', core: null }));
    // more nodes under 1: the grey ramp error shrinks
    const err = (r: readonly [number, number]): number => {
      const l = bakeLut3DHalf(t, r);
      let worst = 0;
      for (let i = 0; i <= 200; i++) {
        const x = i / 200;
        worst = Math.max(worst, Math.abs(sampleLut3D(l, [x, x, x], r)[0] - t([x, x, x])[0]));
      }
      return worst;
    };
    expect(err(range)).toBeLessThan(err([LUT_LOG2_MIN, LUT_LOG2_MAX]));
    expect(() => bakeLut3DHalf(t, [0, 0])).toThrow(/log2 range/);
  });
});

describe('CPU model of the lookup', () => {
  it('sampleLut3D over the bytes equals post-ref sampleLut on the strip layout', () => {
    const t = (c: Linear3): Linear3 => gradeCore(displayTransform(c, 'aces'), KF2);
    const lut3d = bakeLut3DBytes(t);
    const strip = bakeLut(t);
    for (const c of [
      [0.6, 0.3, 0.1],
      [0.01, 0.02, 0.5],
      [3, 2, 1],
      [0, 0, 0],
    ] as Linear3[]) {
      const a = sampleLut3D(lut3d, c);
      const b = sampleLut(strip, c);
      a.forEach((x, i) => expect(x).toBeCloseTo(b[i]!, 12));
    }
  });

  /** worst difference of the display value between the lookup and the direct chain, grey ramp from 2⁻¹² to 2⁴, in 8-bit levels */
  function rampError(core: GradeCoreOptions, lut: Uint16Array | Uint8Array): number {
    const t = lutTransform({ order: 'aces-look', toneMapping: 'aces', core });
    let worst = 0;
    for (let i = 0; i <= 4096; i++) {
      const x = 2 ** (-12 + (16 * i) / 4096);
      const a = sampleLut3D(lut, [x, x, x]);
      const b = t([x, x, x]);
      for (let ch = 0; ch < 3; ch++) worst = Math.max(worst, Math.abs(clamp01(a[ch]!) - clamp01(b[ch]!)));
    }
    return worst * 255;
  }

  const IRON: GradeCoreOptions = { ...KF2, exposure: 1.32, gamma: 1.2 }; // iron-hollow, reactor-spine
  const plainLut = (core: GradeCoreOptions): Uint16Array => bakeLut3DHalf(lutTransform({ order: 'aces-look', toneMapping: 'aces', core }));
  const lookLut = (core: GradeCoreOptions): Uint16Array => bakeLookLut({ order: 'aces-look', toneMapping: 'aces', core });

  it('grey ramp through the plain half-float bake: kf2-mix and training within 1/255 of the direct chain, cradle-biolabs 1.11/255', () => {
    expect(rampError(KF2, plainLut(KF2))).toBeLessThan(1);
    expect(rampError(IRON, plainLut(IRON))).toBeLessThan(1);
    expect(rampError(TRAINING, plainLut(TRAINING))).toBeLessThan(1);
    // render §10.6 asks for 1/255; cradle-biolabs' exposure 1.3 · contrast 1.18 bends faster than 32 half-stop nodes follow
    expect(rampError(CRADLE, plainLut(CRADLE))).toBeGreaterThan(1);
    expect(rampError(CRADLE, plainLut(CRADLE))).toBeLessThan(1.25);
  });

  it('grey ramp through the look’s LUT (curvature-compensated): every live look within 1/255, about half the plain bake’s error (render §10.6)', () => {
    const measured: Record<string, [number, number]> = {};
    for (const [name, core] of Object.entries({ KF2, IRON, CRADLE, TRAINING })) {
      const plain = rampError(core, plainLut(core));
      const look = rampError(core, lookLut(core));
      measured[name] = [Number(plain.toFixed(3)), Number(look.toFixed(3))];
      expect(look, name).toBeLessThan(0.75);
      expect(look / plain, name).toBeLessThan(0.62);
    }
    expect(measured['CRADLE']![1]).toBeLessThan(0.65);
    console.log('grey ramp, plain bake → look LUT, 8-bit levels:', measured);
  });

  it('the compensation does not trade the ramp for the rest of the cube: colours within a stop of grey and saturated ones both gain', () => {
    let seed = 1234;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
      return seed / 2 ** 32;
    };
    const nearGrey: Linear3[] = [];
    const anywhere: Linear3[] = [];
    for (let i = 0; i < 6000; i++) {
      const g = -10 + 12 * rnd();
      nearGrey.push([2 ** (g + rnd() - 0.5), 2 ** (g + rnd() - 0.5), 2 ** (g + rnd() - 0.5)]);
      anywhere.push([2 ** (-12 + 15 * rnd()), 2 ** (-12 + 15 * rnd()), 2 ** (-12 + 15 * rnd())]);
    }
    for (const core of [KF2, CRADLE]) {
      const t = lutTransform({ order: 'aces-look', toneMapping: 'aces', core });
      const stats = (lut: Uint16Array, set: Linear3[]): { worst: number; rms: number } => {
        let worst = 0;
        let sq = 0;
        for (const c of set) {
          const a = sampleLut3D(lut, c);
          const b = t(c);
          for (let ch = 0; ch < 3; ch++) {
            const e = Math.abs(clamp01(a[ch]!) - clamp01(b[ch]!)) * 255;
            worst = Math.max(worst, e);
            sq += e * e;
          }
        }
        return { worst, rms: Math.sqrt(sq / (set.length * 3)) };
      };
      const plain = plainLut(core);
      const look = lookLut(core);
      expect(stats(look, nearGrey).worst).toBeLessThan(1);
      expect(stats(look, nearGrey).worst).toBeLessThan(stats(plain, nearGrey).worst);
      expect(stats(look, nearGrey).rms).toBeLessThan(stats(plain, nearGrey).rms * 0.6);
      expect(stats(look, anywhere).rms).toBeLessThan(stats(plain, anywhere).rms);
      expect(stats(look, anywhere).worst).toBeLessThanOrEqual(stats(plain, anywhere).worst);
    }
  });

  it('the same ramp through an RGBA8 LUT misses by 4 to 11 levels at the knee where the grade passes 1 (why the LUT is half float)', () => {
    const bytes = (core: GradeCoreOptions): number => rampError(core, bakeLut3DBytes(lutTransform({ order: 'aces-look', toneMapping: 'aces', core })));
    expect(bytes(KF2)).toBeGreaterThan(4);
    expect(bytes(CRADLE)).toBeGreaterThan(10);
    expect(bytes(TRAINING)).toBeGreaterThan(4);
  });
});
