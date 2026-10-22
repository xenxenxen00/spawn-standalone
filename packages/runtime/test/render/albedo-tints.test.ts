// `albedoTints`: a part on a named albedo texture packs its colour times the texture mean (opt-in); without a table the
// packed colour is the bare colour (PP). The tint of a texture is its mean in linear light.
import { describe, expect, it } from 'vitest';
import type { GeneratorModule } from '../../src/render/geometry/generator-types.ts';
import { PAINT_FLOATS, albedoTintKey, packMesh } from '../../src/render/geometry/pack.ts';
import { runGeometry } from '../../src/render/geometry/recorder.ts';
import { meanLinearRgb, measureAlbedoTints } from '../../src/render/geometry/albedo-tints.ts';

const spec = { kind: 'scripted', script: 'scripts/gen/board.js', params: {} };
/** two squares in one white paint, the first on a dark texture, the second on none */
const board: GeneratorModule = {
  geometry(c) {
    c.color('oklch(1 0 0)');
    c.albedo('cdn/texture-dark-slate.png');
    c.quad(0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1);
    c.albedo(null);
    c.quad(2, 0, 0, 3, 0, 0, 3, 0, 1, 2, 0, 1);
  },
};
const colours = (paints: Float32Array): number[][] => {
  const out: number[][] = [];
  for (let o = 0; o < paints.length; o += PAINT_FLOATS) out.push([...paints.subarray(o, o + 3)].map((v) => Math.round(v * 1000) / 1000));
  return out;
};

describe('albedoTints', () => {
  it('negative (PP): without a table a textured part packs its bare colour', () => {
    const lod = packMesh(runGeometry(board, spec, 1));
    expect(lod.textures).toEqual(['cdn/texture-dark-slate.png']);
    expect(colours(lod.paints)).toEqual([[1, 1, 1], [1, 1, 1]]);
  });
  it('on: the textured part is multiplied by its mean; the untextured one and names not in the table are unchanged', () => {
    const lod = packMesh(runGeometry(board, spec, 1), { albedoTints: { 'cdn/texture-dark-slate.png': [0.065, 0.068, 0.0675] } });
    expect(colours(lod.paints)).toEqual([[0.065, 0.068, 0.068], [1, 1, 1]]);
    const other = packMesh(runGeometry(board, spec, 1), { albedoTints: { 'cdn/other.png': [0.1, 0.1, 0.1] } });
    expect(colours(other.paints)).toEqual([[1, 1, 1], [1, 1, 1]]);
  });
  it('a leading slash names the same texture', () => {
    expect(albedoTintKey('/cdn/x.png')).toBe('cdn/x.png');
    const lead: GeneratorModule = { geometry(c) { c.albedo('/cdn/texture-dark-slate.png'); c.quad(0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0, 1); } };
    const lod = packMesh(runGeometry(lead, spec, 1), { albedoTints: { 'cdn/texture-dark-slate.png': [0.5, 0.5, 0.5] } });
    expect(colours(lod.paints)[0]).toEqual([0.5, 0.5, 0.5]);
  });
  it('the mean is taken in linear light, and measureAlbedoTints keys by name and skips misses', async () => {
    // half black, half white sRGB: linear mean 0.5 (an sRGB mean would be 127.5 -> 0.212)
    expect(meanLinearRgb([0, 0, 0, 255, 255, 255, 255, 255])).toEqual([0.5, 0.5, 0.5]);
    expect(meanLinearRgb([188, 188, 188], 3)[0]).toBeCloseTo(0.503, 3);
    const tints = await measureAlbedoTints(['/cdn/a.png', 'cdn/missing.png', 'cdn/bad.png'], (n) => (n.includes('missing') ? null : `u:${n}`), async (url) => {
      if (url.includes('bad')) throw new Error('decode');
      return [255, 0, 0, 255];
    });
    expect(tints).toEqual({ 'cdn/a.png': [1, 0, 0] });
  });
});
