// K10a: numeric ctx.color(r, g, b[, a]) records that colour (it used to draw white, with g read as alpha).
import { describe, expect, it } from 'vitest';
import type { GeneratorModule, GeometryContext, ScriptedSpec } from '../../../../src/render/geometry/generator-types.ts';
import { packMesh, PAINT_FLOATS } from '../../../../src/render/geometry/pack.ts';
import { runGeometry } from '../../../../src/render/geometry/recorder.ts';

const spec: ScriptedSpec = { kind: 'scripted', script: 'scripts/gen/flower.js', params: {} };
const run = (g: (ctx: GeometryContext) => unknown, opts = {}) => {
  const mod: GeneratorModule = { geometry: g };
  return packMesh(runGeometry(mod, spec, 1), opts);
};
const tri = (ctx: GeometryContext, z = 0) => ctx.tri(0, 0, z, 1, 0, z, 0, 1, z);
const lin = (v: number) => (v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92);

describe('numeric ctx.color', () => {
  it('records color(1, 0.5, 0.25) as that RGB, not white', () => {
    const rec = runGeometry({ geometry: (c) => { c.color(1, 0.5, 0.25); tri(c); } }, spec, 1);
    expect(rec.paints[0]!.color).toEqual([1, 0.5, 0.25]);
    expect(rec.paints[0]!.alpha).toBeUndefined();
    const p = run((c) => { c.color(1, 0.5, 0.25); tri(c); }).paints;
    expect(p.length).toBe(PAINT_FLOATS);
    expect(p[0]).toBeCloseTo(1, 5);
    expect(p[1]).toBeCloseTo(lin(0.5), 5);
    expect(p[2]).toBeCloseTo(lin(0.25), 5);
    expect(p[3]).toBe(1);
  });

  it('records color(1, 0.5, 0.25, 0.5) with alpha 0.5 and puts the face in the transparent pass', () => {
    const lod = run((c) => { c.color(1, 0.5, 0.25, 0.5); tri(c); });
    expect(lod.paints[3]).toBeCloseTo(0.5, 6);
    expect(lod.opaqueIndexCount).toBe(0);
    expect(lod.idx.length).toBe(3);
  });

  it('accepts an array, clamps channels, and decodes as linear on request', () => {
    const lod = run((c) => { c.color([2, -1, 0.5, 0.25]); tri(c); }, { colorDecode: 'linear' });
    expect(Array.from(lod.paints.subarray(0, 4))).toEqual([1, 0, 0.5, 0.25]);
  });

  it('keeps colour strings and the legacy (css, alpha) form unchanged', () => {
    const lod = run((c) => { c.color('#ff0000', 0.4); tri(c); });
    expect(lod.paints[0]).toBeCloseTo(1, 5);
    expect(lod.paints[1]).toBeCloseTo(0, 5);
    expect(lod.paints[3]).toBeCloseTo(0.4, 6);
  });

  it('gives distinct paints to distinct numeric colours and shares equal ones', () => {
    const rec = runGeometry({ geometry: (c) => { c.color(1, 0, 0); tri(c); c.color(0, 1, 0); tri(c, 1); c.color(1, 0, 0); tri(c, 2); } }, spec, 1);
    expect(rec.paints.length).toBe(2);
  });
});
