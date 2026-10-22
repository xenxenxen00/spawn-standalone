// R-4 (opt-in): partial `sphere` angles and open `ring` arcs. Off by default: PP's whole shapes (negative control).
import { afterEach, describe, expect, it } from 'vitest';
import { primitiveShape, setPrimitiveAngleSupport } from '../../../src/render/geometry/primitives.ts';

afterEach(() => setPrimitiveAngleSupport(false));

const bounds = (g: ReturnType<ReturnType<typeof primitiveShape>['create']>) => {
  g.computeBoundingBox();
  return g.boundingBox!;
};
// the bumper cap of Crown Riot: a half sphere, thetaLength = pi / 2
const cap = { kind: 'sphere', radius: 1, widthSegments: 20, heightSegments: 10, phiStart: 0, phiLength: 6.283, thetaStart: 0, thetaLength: 1.571 };
// a boostway chevron: an open arc of a ring
const chevron = { kind: 'ring', innerRadius: 0.5, outerRadius: 0.95, thetaStart: 0.785, thetaLength: 1.571, thetaSegments: 3 };

describe('primitive angles', () => {
  it('default (off): a sphere is whole and a ring is a full annulus', () => {
    const sphere = primitiveShape(cap);
    expect(sphere.geometryKey).toBe('sphere:20:10');
    const b = bounds(sphere.create());
    expect(b.max.y - b.min.y).toBeCloseTo(2, 5);
    const ring = primitiveShape(chevron);
    expect(ring.geometryKey).toBe('ring:0.5263:32:low');
    expect(bounds(ring.create()).min.x).toBeLessThan(-0.9);
  });
  it('on: the cap is a half sphere (its own geometry key), y from 1 to 2 after the foot translation', () => {
    setPrimitiveAngleSupport(true);
    const sphere = primitiveShape(cap);
    expect(sphere.geometryKey).not.toBe('sphere:20:10');
    const b = bounds(sphere.create());
    expect(b.max.y - b.min.y).toBeCloseTo(1, 2);
    expect(b.max.y).toBeCloseTo(2, 5);
    expect(b.min.y).toBeGreaterThan(0.99);
  });
  it('on: the chevron is an open arc of 3 segments between 45 and 135 degrees; a sphere without angles keeps its key', () => {
    setPrimitiveAngleSupport(true);
    const ring = primitiveShape({ ...chevron, anchor: 'center' });
    const g = ring.create();
    const b = bounds(g);
    expect(b.min.y).toBeGreaterThan(0.2); // only the upper arc: unit-ring y from sin 45 * inner to 1
    expect(b.max.y).toBeCloseTo(Math.sin((75 * Math.PI) / 180), 2); // vertices at 45, 75, 105, 135 degrees: sin 75
    expect(g.index!.count / 3).toBe(3 * 2);
    expect(primitiveShape({ kind: 'sphere', widthSegments: 20, heightSegments: 10 }).geometryKey).toBe('sphere:20:10');
  });
});
