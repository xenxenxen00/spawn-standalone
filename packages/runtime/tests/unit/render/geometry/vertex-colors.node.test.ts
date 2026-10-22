// K10b: geometry() returning { colors } (per-vertex RGBA) through the recorder and the pack format.
import { describe, expect, it } from 'vitest';
import type { GeneratorModule, ScriptedSpec } from '../../../../src/render/geometry/generator-types.ts';
import { packMesh, packedKeyTransfers } from '../../../../src/render/geometry/pack.ts';
import { createDiagnostics, runGeometry, UnsupportedGeometryReturn } from '../../../../src/render/geometry/recorder.ts';

const spec: ScriptedSpec = { kind: 'scripted', script: 'scripts/gen/pip.js', params: {} };
const lin = (v: number) => (v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92);
// a glow disc: 1 quad (4 emitted vertices) + 1 tri (3): rim alpha 0, centre alpha 0.8
const glow: GeneratorModule = {
  geometry: (c) => {
    c.color(1, 0.5, 0.25, 0.99);
    c.quad(0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0);
    c.tri(0, 0, 1, 1, 0, 1, 0, 1, 1);
    const v = (a: number) => [1, 0.5, 0.25, a];
    return { colors: [...v(0.8), ...v(0), ...v(0), ...v(0.05), ...v(0.8), ...v(0.02), ...v(0)] };
  },
};

describe('geometry() { colors }', () => {
  it('stays an unsupported return unless vertexColors is on (PP behaviour)', () => {
    expect(() => runGeometry(glow, spec, 1, { strict: true })).toThrow(UnsupportedGeometryReturn);
    const diag = createDiagnostics();
    expect(runGeometry(glow, spec, 1, { diag }).colors).toBeUndefined();
    expect(diag.counts['invalidReturn']).toBe(1);
  });

  it('keeps colors at 4 floats per emitted vertex', () => {
    const rec = runGeometry(glow, spec, 1, { strict: true, vertexColors: true });
    expect(rec.emitted).toBe(7);
    expect(rec.colors!.length).toBe(rec.emitted * 4);
  });

  it('rejects a colors array of the wrong length', () => {
    const bad: GeneratorModule = { geometry: (c) => { c.tri(0, 0, 0, 1, 0, 0, 0, 1, 0); return { colors: [1, 1, 1, 1] }; } };
    expect(() => runGeometry(bad, spec, 1, { strict: true, vertexColors: true })).toThrow(UnsupportedGeometryReturn);
  });

  it('packs one linear RGBA per vertex with the soft alpha falloff, and transfers the buffer', () => {
    const lod = packMesh(runGeometry(glow, spec, 1, { vertexColors: true }));
    expect(lod.colors!.length).toBe(lod.vertices * 4);
    const alphas = Array.from({ length: lod.vertices }, (_, i) => lod.colors![i * 4 + 3]!);
    expect(Math.max(...alphas)).toBeCloseTo(0.8, 6);
    expect(Math.min(...alphas)).toBeLessThan(0.1);
    expect(lod.colors![1]).toBeCloseTo(lin(0.5), 5);
    expect(packedKeyTransfers({ key: 'k', script: 's', lods: [lod], ms: 0 })).toContain(lod.colors!.buffer);
  });

  it('splits vertices that share a position but differ in colour', () => {
    const m: GeneratorModule = {
      geometry: (c) => {
        c.tri(0, 0, 0, 1, 0, 0, 0, 1, 0);
        c.tri(0, 0, 0, 0, 1, 0, -1, 0, 0);
        return { colors: [1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 1, 1, 1, 0, 0, 1, 0, 0, 1, 1] };
      },
    };
    const withColors = packMesh(runGeometry(m, spec, 1, { vertexColors: true }));
    const plain = packMesh(runGeometry({ geometry: (c) => { m.geometry(c); } }, spec, 1));
    expect(plain.vertices).toBe(4);
    expect(withColors.vertices).toBe(5); // (0,1,0) is red in one triangle and blue in the other
  });

  it('leaves a level without { colors } byte-identical to PP', () => {
    const plain: GeneratorModule = { geometry: (c) => { c.tri(0, 0, 0, 1, 0, 0, 0, 1, 0); } };
    const lod = packMesh(runGeometry(plain, spec, 1, { vertexColors: true }));
    expect(lod.colors).toBeUndefined();
  });
});
