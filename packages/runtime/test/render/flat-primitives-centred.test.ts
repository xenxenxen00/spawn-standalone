// `flatPrimitivesCentred`: a flat primitive without `anchor` stands by its centre (Spawn; Pip's sky plane), opt-in.
import { afterEach, describe, expect, it } from 'vitest';
import { primitiveShape, setFlatPrimitivesCentred } from '../../src/render/geometry/primitives.ts';

const yRange = (spec: Parameters<typeof primitiveShape>[0]): [number, number] => {
  const g = primitiveShape(spec).create();
  g.computeBoundingBox();
  const r: [number, number] = [g.boundingBox!.min.y, g.boundingBox!.max.y];
  g.dispose();
  return r;
};

describe('flatPrimitivesCentred', () => {
  afterEach(() => setFlatPrimitivesCentred(false));
  it('negative (PP): a plane without anchor stands on its lowest point', () => {
    expect(yRange({ kind: 'plane', width: 2, height: 3 })).toEqual([0, 1]);
    expect(primitiveShape({ kind: 'plane' }).geometryKey).toBe('plane:low');
  });
  it('on: plane and circle without anchor are centred; an explicit anchor and the solid kinds are unchanged', () => {
    setFlatPrimitivesCentred(true);
    expect(yRange({ kind: 'plane', width: 2, height: 3 })).toEqual([-0.5, 0.5]);
    expect(primitiveShape({ kind: 'plane' }).geometryKey).toBe('plane');
    expect(yRange({ kind: 'circle' })).toEqual([-1, 1]);
    expect(yRange({ kind: 'plane', anchor: 'bottom' })).toEqual([0, 1]);
    expect(yRange({ kind: 'box' })[0]).toBe(0);
  });
});
