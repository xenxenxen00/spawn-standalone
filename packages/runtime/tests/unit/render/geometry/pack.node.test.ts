// pack.ts: packed LOD buffers (D5: indexed, 8 bytes per vertex, int16 positions over the key bbox + the paint id as w = id − 32767), paint
// records, smooth normals, UVs and collider soups (render §6.4, §18.1 "packing").
import { describe, expect, it } from 'vitest';
import type { GeneratorModule, GeometryContext, LodLevel } from '../../../../src/render/geometry/generator-types.ts';
import { runCollider, runGeometry, type RecordedMesh } from '../../../../src/render/geometry/recorder.ts';
import {
  cssAlpha,
  cssToLinear,
  decodeDisplay,
  hexToLinear,
  lodPaintIds,
  MAX_LOCAL_PAINTS,
  PAINT_ID_BIAS,
  lodVertexPositions,
  oklchToLinear,
  packCollider,
  packedLodBytes,
  packMesh,
  PAINT_FLAG_SMOOTH,
  PAINT_FLAG_TEXTURED,
  PAINT_FLAG_TRANSPARENT,
  PAINT_FLOATS,
  unpackTriangles,
  VERTEX_STRIDE,
} from '../../../../src/render/geometry/pack.ts';

const spec = { kind: 'scripted', script: 'scripts/gen/test.js', params: {} } as const;
const record = (g: (ctx: GeometryContext) => unknown, lod: LodLevel = 1): RecordedMesh => runGeometry({ geometry: g }, spec, lod);

/** `scripts/gen/poly.js:181-192` transcribed: the reference the port's colour conversion must equal. */
function polyOklchToLin(s: string): number[] | null {
  const m = /oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)/.exec(s);
  if (!m) return null;
  const L = parseFloat(m[1]!) / (m[2] ? 100 : 1);
  const C = parseFloat(m[3]!);
  const h = (parseFloat(m[4]!) * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const ss = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * ss,
    -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * ss,
    -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * ss,
  ].map((v) => Math.max(0, v));
}
function polyHexToLin(s: string): number[] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(s);
  if (!m) return null;
  return [0, 2, 4].map((i) => {
    const v = parseInt(m[1]!.slice(i, i + 2), 16) / 255;
    return v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92;
  });
}

/** an axis-aligned closed box as six outward quads */
function box(ctx: GeometryContext, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): void {
  ctx.quad(x0, y0, z0, x0, y1, z0, x1, y1, z0, x1, y0, z0);
  ctx.quad(x0, y0, z1, x1, y0, z1, x1, y1, z1, x0, y1, z1);
  ctx.quad(x1, y0, z0, x1, y1, z0, x1, y1, z1, x1, y0, z1);
  ctx.quad(x0, y0, z0, x0, y0, z1, x0, y1, z1, x0, y1, z0);
  ctx.quad(x0, y1, z0, x0, y1, z1, x1, y1, z1, x1, y1, z0);
  ctx.quad(x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1);
}

describe('colour conversion', () => {
  const samples = ['oklch(0.5 0.1 30)', 'oklch(0.96 0.02 80)', 'oklch(55% 0.2 150)', 'oklch(0.12 0 0)', 'oklch(0.8 0.37 264)', 'oklch(1 0 0)', 'oklch(0.55 0.03 220 / 0.5)'];
  it('equals poly.js oklchToLin and hexToLin to 1e-12', () => {
    for (const s of samples) {
      const got = oklchToLinear(s);
      const ref = polyOklchToLin(s);
      expect(got).not.toBeNull();
      for (let k = 0; k < 3; k++) expect(Math.abs(got![k]! - ref![k]!)).toBeLessThanOrEqual(1e-12);
      expect(cssToLinear(s)).toEqual(got);
    }
    for (const s of ['#000000', '#ffffff', '#3a7bd5', '#0A0B0C']) {
      expect(hexToLinear(s)).toEqual(polyHexToLin(s));
      expect(cssToLinear(s)).toEqual(polyHexToLin(s));
    }
    expect(cssToLinear('#fff')).toEqual(polyHexToLin('#ffffff'));
    expect(cssToLinear('not a colour')).toBeNull();
    expect(cssToLinear(42)).toBeNull();
  });

  it('reads alpha from "oklch(… / a)" and #rrggbbaa', () => {
    expect(cssAlpha('oklch(0.55 0.03 220 / 0.5)')).toBe(0.5);
    expect(cssAlpha('oklch(0.55 0.03 220 / 40%)')).toBeCloseTo(0.4, 12);
    expect(cssAlpha('oklch(0.55 0.03 220)')).toBeUndefined();
    expect(cssAlpha('#ff000080')).toBeCloseTo(128 / 255, 12);
  });

  it('decodes display emissive values with the sRGB EOTF, growing above 1 (CAL emissiveDecode default)', () => {
    expect(decodeDisplay(0)).toBe(0);
    expect(decodeDisplay(0.04)).toBeCloseTo(0.04 / 12.92, 15);
    expect(decodeDisplay(0.5)).toBeCloseTo(((0.5 + 0.055) / 1.055) ** 2.4, 15);
    expect(decodeDisplay(1.8)).toBeCloseTo(3.87, 2);
    expect(decodeDisplay(-1)).toBe(0);
    expect(decodeDisplay(2, 'linear')).toBe(2);
  });
});

describe('packMesh', () => {
  it('indexes a closed flat box as 8 vertices, 12 triangles, 8 bytes per vertex', () => {
    const lod = packMesh(record((ctx) => box(ctx, -1, 0, -2, 1, 3, 2)));
    expect(lod.tris).toBe(12);
    expect(lod.vertices).toBe(8);
    expect(lod.vtx.byteLength).toBe(64);
    expect(lod.idx).toBeInstanceOf(Uint16Array);
    expect(lod.idx.length).toBe(36);
    expect(lod.opaqueIndexCount).toBe(36);
    expect(lod.bboxMin).toEqual([-1, 0, -2]);
    expect(lod.bboxMax).toEqual([1, 3, 2]);
    expect(lod.paints.length).toBe(PAINT_FLOATS);
    expect(lod.normals).toBeUndefined();
    expect(lod.uvs).toBeUndefined();
    expect(packedLodBytes(lod)).toBe(64 + 72 + 48);
  });

  it('dequantises within half a quantisation step (0.5 mm on a 30 m piece) and keeps the triangle order', () => {
    let s = 12345;
    const rnd = (): number => {
      s = (s * 16807) % 2147483647;
      return (s - 1) / 2147483646;
    };
    const tris: number[] = [];
    const rec = record((ctx) => {
      for (let i = 0; i < 400; i++) {
        const v = Array.from({ length: 9 }, (_, k) => (k % 3 === 1 ? rnd() * 8 : rnd() * 30 - 15));
        tris.push(...v);
        ctx.tri(...v);
      }
    });
    const lod = packMesh(rec);
    const out = unpackTriangles(lod);
    expect(out.length).toBe(tris.length);
    for (let i = 0; i < tris.length; i++) {
      const step = ((lod.bboxMax[i % 3]! - lod.bboxMin[i % 3]!) / 2 / 32767) * 0.5;
      expect(Math.abs(out[i]! - tris[i]!)).toBeLessThanOrEqual(step + 1e-6);
      expect(Math.abs(out[i]! - tris[i]!)).toBeLessThanOrEqual(0.0005);
    }
  });

  it('dedupes paints by their float record in first-use order and splits opaque before transparent', () => {
    const rec = record((ctx) => {
      ctx.color('oklch(0.2 0.03 230)', 0.45); // glass
      ctx.tri(0, 0, 0, 1, 0, 0, 0, 1, 0);
      ctx.color('oklch(0.5 0 0)');
      ctx.tri(0, 0, 1, 1, 0, 1, 0, 1, 1);
      ctx.color('oklch(0.50 0.0 0)'); // same colour, other spelling
      ctx.tri(0, 0, 2, 1, 0, 2, 0, 1, 2);
      ctx.color('oklch(0.2 0.03 230)', 0.45);
      ctx.tri(0, 0, 3, 1, 0, 3, 0, 1, 3);
    });
    const lod = packMesh(rec);
    expect(lod.tris).toBe(4);
    expect(lod.opaqueIndexCount).toBe(6);
    expect(lod.paints.length / PAINT_FLOATS).toBe(2);
    // opaque paint first (local id 0), the glass second
    expect(lod.paints[3]).toBe(1);
    expect(lod.paints[PAINT_FLOATS + 3]).toBeCloseTo(0.45, 6);
    expect(lod.paints[PAINT_FLOATS + 9]).toBe(PAINT_FLAG_TRANSPARENT);
    const zs = unpackTriangles(lod).filter((_, i) => i % 3 === 2 && i % 9 === 2);
    expect(Array.from(zs, (z) => Math.round(z * 1000) / 1000)).toEqual([1, 2, 0, 3]);
    const ids = lodPaintIds(lod);
    expect(Array.from(new Set(ids))).toEqual([0, 1]);
  });

  it('writes the paint record: linear albedo, alpha, decoded emissive, roughness, metalness, flags, texId', () => {
    const lod = packMesh(
      record((ctx) => {
        ctx.color('oklch(0.6 0.1 40)');
        ctx.roughness(0.3);
        ctx.metalness(0.2);
        ctx.emissive(2.4, 1.4, 0.45);
        ctx.albedo('cdn/texture-brick.png');
        ctx.tri(0, 0, 0, 1, 0, 0, 0, 1, 0);
        ctx.albedo(null);
        ctx.emissive('oklch(0.6 0.25 25)');
        ctx.color('oklch(0.55 0.03 220 / 0.5)');
        ctx.tri(0, 0, 1, 1, 0, 1, 0, 1, 1);
        ctx.emissive([3, 1, 0.2]);
        ctx.color('oklch(0.6 0.1 40)');
        ctx.tri(0, 0, 2, 1, 0, 2, 0, 1, 2);
      }),
    );
    const p = lod.paints;
    const alb = oklchToLinear('oklch(0.6 0.1 40)')!;
    for (let k = 0; k < 3; k++) expect(p[k]).toBeCloseTo(alb[k]!, 6);
    expect(p[3]).toBe(1);
    expect(p[4]).toBeCloseTo(decodeDisplay(2.4), 5);
    expect(p[5]).toBeCloseTo(decodeDisplay(1.4), 5);
    expect(p[6]).toBeCloseTo(decodeDisplay(0.45), 5);
    expect(p[7]).toBeCloseTo(0.3, 6);
    expect(p[8]).toBeCloseTo(0.2, 6);
    expect(p[9]).toBe(PAINT_FLAG_TEXTURED);
    expect(p[10]).toBe(1);
    expect(lod.textures).toEqual(['cdn/texture-brick.png']);
    // second paint (third triangle, opaque): emissive array = the same law as three numbers
    const q = PAINT_FLOATS;
    expect(p[q + 4]).toBeCloseTo(decodeDisplay(3), 5);
    expect(p[q + 10]).toBe(0);
    // third paint: the glass, alpha from the colour string, emissive css linear
    const g = 2 * PAINT_FLOATS;
    expect(p[g + 3]).toBeCloseTo(0.5, 6);
    expect(p[g + 4]).toBeCloseTo(oklchToLinear('oklch(0.6 0.25 25)')![0], 6);
    expect(lod.opaqueIndexCount).toBe(6);
  });

  it('drops degenerate and non-finite triangles', () => {
    const lod = packMesh(
      record((ctx) => {
        ctx.tri(0, 0, 0, 1, 0, 0, 0, 1, 0);
        ctx.tri(0, 0, 0, 0, 0, 0, 1, 1, 1); // repeated corner
        ctx.tri(0, 0, Number.NaN, 1, 0, 0, 0, 1, 0);
        ctx.tri(5, 5, 5, 5, 5, 5.000000001, 6, 6, 6); // collapses under quantisation of a 6 m piece
      }),
    );
    expect(lod.tris).toBe(1);
    expect(lod.dropped).toBe(3);
    expect(lod.bboxMax).toEqual([6, 6, 6]);
  });

  it('packs an empty mesh as zero buffers', () => {
    const lod = packMesh(record(() => {}));
    expect(lod.tris).toBe(0);
    expect(lod.vertices).toBe(0);
    expect(lod.vtx.byteLength).toBe(0);
    expect(lod.idx.length).toBe(0);
    expect(lod.paints.length).toBe(0);
    expect(lod.bboxMin).toEqual([0, 0, 0]);
  });

  it('switches to 32-bit indices above 65,536 vertices', () => {
    const lod = packMesh(
      record((ctx) => {
        for (let i = 0; i < 70000; i++) {
          const x = (i % 400) * 0.5;
          const z = Math.floor(i / 400) * 0.5;
          ctx.color(`oklch(0.5 0.1 ${i % 360})`);
          ctx.tri(x, 0, z, x + 0.25, 0, z, x, 0.25, z);
        }
      }),
    );
    expect(lod.vertices).toBeGreaterThan(65536);
    expect(lod.idx).toBeInstanceOf(Uint32Array);
  });

  it('keeps returned UVs per vertex and splits vertices whose UVs differ', () => {
    const lod = packMesh(
      record((ctx) => {
        ctx.quad(0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0);
        ctx.tri(1, 0, 0, 2, 0, 0, 1, 1, 0);
        return { uvs: [0, 0, 1, 0, 1, 1, 0, 1, 9, 9, 2, 0, 1, 1] };
      }),
    );
    expect(lod.uvs).toBeInstanceOf(Float32Array);
    // quad: 4 vertices; tri: (1,0,0) has uv (9,9) ≠ (1,0) → new vertex; (1,1,0) uv (1,1) = shared; (2,0,0) new
    expect(lod.vertices).toBe(6);
    expect(lod.uvs!.length).toBe(12);
  });

  it('computes angle-weighted normals per smoothing run; flat faces carry a zero normal', () => {
    const tent = (ctx: GeometryContext, x: number): void => {
      ctx.tri(x, 0, 0, x, 1, 1, x, 0, 1); // left slope (normal -X-ish... any)
      ctx.tri(x, 1, 1, x + 1, 0, 1, x, 0, 1);
    };
    const lod = packMesh(
      record((ctx) => {
        ctx.smooth();
        ctx.tri(0, 0, 0, 1, 1, 0, 1, 0, 0);
        ctx.tri(1, 1, 0, 2, 0, 0, 1, 0, 0);
        ctx.flat();
        ctx.tri(0, 0, 5, 1, 0, 5, 0, 1, 5);
        ctx.smooth();
        tent(ctx, 10);
      }),
    );
    expect(lod.normals).toBeInstanceOf(Int8Array);
    expect(lod.normals!.length).toBe(lod.vertices * 4);
    const ids = lodPaintIds(lod);
    const n = lod.normals!;
    const flatPaint = Array.from(ids).find((_, v) => n[v * 4] === 0 && n[v * 4 + 1] === 0 && n[v * 4 + 2] === 0);
    expect(flatPaint).toBeDefined();
    const smoothFlag = lod.paints[9]!;
    expect(smoothFlag & PAINT_FLAG_SMOOTH).toBe(PAINT_FLAG_SMOOTH);
    // the shared edge of the two smooth faces of run 1 (1,1,0)-(1,0,0) gets one averaged normal: both faces are -Z facing
    const pos = lodVertexPositions(lod);
    for (let v = 0; v < lod.vertices; v++) {
      if (Math.abs(pos[v * 3 + 2]!) < 1e-9 && n[v * 4 + 2] !== 0) {
        expect(Math.abs(n[v * 4 + 2]!)).toBe(127);
      }
    }
  });

  it('is deterministic byte for byte', () => {
    const g = (ctx: GeometryContext): void => {
      for (let i = 0; i < 50; i++) {
        ctx.color(`oklch(0.${i % 9 + 1} 0.1 ${i * 7})`, i % 5 === 0 ? 0.5 : undefined);
        if (i % 3 === 0) ctx.smooth();
        else ctx.flat();
        box(ctx, i, 0, 0, i + 0.8, 1 + (i % 4), 1);
      }
    };
    const a = packMesh(record(g));
    const b = packMesh(record(g));
    expect(new Uint8Array(a.vtx)).toEqual(new Uint8Array(b.vtx));
    expect(a.idx).toEqual(b.idx);
    expect(a.paints).toEqual(b.paints);
    expect(a.normals).toEqual(b.normals);
  });
});

describe('packCollider', () => {
  const mod = (collider: (ctx: GeometryContext) => unknown): GeneratorModule => ({ geometry: () => {}, collider });
  it('passes shapes through and drops bad soup triangles', () => {
    expect(packCollider(runCollider(mod(() => ({ kind: 'box', width: 1, height: 2, depth: 3 })), spec))).toEqual({ box: [1, 2, 3] });
    expect(packCollider(runCollider(mod(() => ({ kind: 'sphere', radius: 0.5 })), spec))).toEqual({ sphere: 0.5 });
    expect(packCollider(runCollider(mod(() => null), spec))).toBeNull();
    const soup = packCollider(
      runCollider(
        mod((ctx) => {
          ctx.tri(0, 0, 0, 1, 0, 0, 0, 1, 0);
          ctx.tri(0, 0, 0, 0, 0, 0, 1, 1, 1);
          ctx.tri(0, Number.POSITIVE_INFINITY, 0, 1, 0, 0, 0, 1, 0);
        }),
        spec,
      ),
    );
    expect(soup).not.toBeNull();
    expect(soup && 'tris' in soup ? Array.from(soup.tris) : null).toEqual([0, 0, 0, 1, 0, 0, 0, 1, 0]);
  });
});

describe('D5 paint lane (render D5, §6.6): w = localPaintId − 32767 in the int16 normalised position', () => {
  /** `n` triangles, each with its own paint (distinct float32 roughness) */
  const manyPaints = (n: number): RecordedMesh =>
    record((ctx) => {
      for (let i = 0; i < n; i++) {
        const x = (i % 256) * 0.5;
        const z = Math.floor(i / 256) * 0.5;
        ctx.roughness((i + 1) / 70000);
        ctx.tri(x, 0, z, x + 0.25, 0, z, x, 0.25, z);
      }
    });

  it('round-trips paint ids 0, 1, 32,767 and 65,534 through the raw int16 and through the shader decode', () => {
    const lod = packMesh(manyPaints(MAX_LOCAL_PAINTS));
    expect(lod.paints.length / PAINT_FLOATS).toBe(65535);
    const raw = new Int16Array(lod.vtx);
    const ids = lodPaintIds(lod);
    expect(ids).toBeInstanceOf(Uint16Array);
    // triangle t uses vertices idx[3t..3t+2], all of paint t
    for (const id of [0, 1, 32767, 65534]) {
      const v = lod.idx[id * 3]!;
      const w = raw[v * 4 + 3]!;
      expect(w).toBe(id - PAINT_ID_BIAS);
      expect(ids[v]).toBe(id);
      // what the vertex stage does with the normalised attribute (§6.6): localId = round(w · 32767) + 32767
      const normalised = Math.fround(Math.max(w / 32767, -1));
      expect(Math.round(normalised * 32767) + 32767).toBe(id);
      expect(lod.paints[id * PAINT_FLOATS + 7]).toBeCloseTo((id + 1) / 70000, 6);
    }
    let lo = Infinity;
    let hi = -Infinity;
    for (let v = 0; v < lod.vertices; v++) {
      lo = Math.min(lo, raw[v * 4 + 3]!);
      hi = Math.max(hi, raw[v * 4 + 3]!);
    }
    expect([lo, hi]).toEqual([-32767, 32767]);
  });

  it('refuses a 65,536th paint: id 65,535 has no int16 code', () => {
    expect(() => packMesh(manyPaints(MAX_LOCAL_PAINTS + 1))).toThrow(/65,535 distinct paints/);
  });

  it('keeps the stride at 8 bytes and the first paint at w = −32767', () => {
    const lod = packMesh(record((ctx) => box(ctx, -1, 0, -2, 1, 3, 2)));
    expect(VERTEX_STRIDE).toBe(8);
    expect(lod.vtx.byteLength).toBe(lod.vertices * 8);
    const raw = new Int16Array(lod.vtx);
    for (let v = 0; v < lod.vertices; v++) expect(raw[v * 4 + 3]).toBe(-32767);
  });
});
