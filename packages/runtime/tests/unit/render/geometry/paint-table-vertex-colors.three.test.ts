// K10b: the SRC_PACKED stage's vertexColors option (own file: paint-table.three.test.ts is PP's).
import type { Node } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { MapPaint, registerPackedSurface } from '../../../../src/render/surface/paint-table.ts';
import type { LightingScript } from '../../../../src/render/surface/script-types.ts';
import { SurfaceMaterials, SurfaceVariant as V } from '../../../../src/render/surface/surface-material.ts';

describe('SRC_PACKED stage with vertexColors (K10b)', () => {
  const script: LightingScript = { lighting: () => { throw new Error('unused'); } };
  const attrs = (n: Node | null): string[] => {
    const out: string[] = [];
    n?.traverse((x) => {
      const a = (x as unknown as { _attributeName?: string })._attributeName;
      if (a) out.push(a);
    });
    return out;
  };
  it('reads ssColor only when asked; the default program is PP\'s', () => {
    const off = new SurfaceMaterials({ script });
    registerPackedSurface(off, new MapPaint({ paints: 4, entries: 4 }));
    const on = new SurfaceMaterials({ script });
    registerPackedSurface(on, new MapPaint({ paints: 4, entries: 4 }), { vertexColors: true });
    const v = V.SRC_PACKED | V.SIDE_DOUBLE | V.TRANSPARENT;
    expect(attrs(off.get({ variant: v }).opacityNode)).not.toContain('ssColor');
    expect(attrs(on.get({ variant: v }).opacityNode)).toContain('ssColor');
    expect(attrs(on.get({ variant: v }).colorNode)).toContain('ssColor');
  });
});
