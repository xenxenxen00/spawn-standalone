// K16 follow-up: the dynamic-light selection under an orthographic world camera. `perspectiveFrom` used to read the two focal
// terms as if they were perspective; an orthographic matrix has 1 / half-extent there and a different last row.
import { OrthographicCamera, PerspectiveCamera } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { DynamicLightSelector, isOrthographic, perspectiveFrom } from '../../../src/render/lighting/dynamic-lights.ts';
import { createProjectionSwitch } from '../../../src/render/scene/ortho-projection.ts';

function orthoCamera(): OrthographicCamera {
  const cam = new OrthographicCamera(-16, 16, 10, -10, 0.1, 2000); // half-height 10, aspect 1.6
  cam.position.set(0, 0, 50);
  cam.updateMatrixWorld(true);
  return cam;
}
function perspCamera(): PerspectiveCamera {
  const cam = new PerspectiveCamera(70, 1.6, 0.1, 2000);
  cam.position.set(0, 0, 50);
  cam.updateMatrixWorld(true);
  return cam;
}
const kept = (cam: OrthographicCamera | PerspectiveCamera, elements: ArrayLike<number>, x: number, y: number, z: number, r: number): boolean => {
  const s = new DynamicLightSelector();
  s.setView(cam.matrixWorldInverse.elements, elements, cam.near, cam.far);
  s.begin(4);
  s.offer(1, 1, x, y, z, 10, r);
  return s.end() === 1;
};

describe('dynamic lights under an orthographic camera (K16)', () => {
  it('isOrthographic / perspectiveFrom tell the two apart and give the half extents', () => {
    const o = orthoCamera();
    const p = perspCamera();
    expect(isOrthographic(o.projectionMatrix.elements)).toBe(true);
    expect(isOrthographic(p.projectionMatrix.elements)).toBe(false);
    expect(perspectiveFrom(o.projectionMatrix.elements)).toMatchObject({ ortho: true, halfWidth: 16, halfHeight: 10, tanHalfX: 0, tanHalfY: 0 });
    const f = perspectiveFrom(p.projectionMatrix.elements);
    expect(f.ortho).toBe(false);
    expect(f.tanHalfY).toBeCloseTo(Math.tan((35 * Math.PI) / 180), 12);
    expect(f.tanHalfX).toBeCloseTo(f.tanHalfY * 1.6, 12);
  });

  it('culls by the box: a light beside it is dropped at any depth, one whose sphere reaches in is kept', () => {
    const cam = orthoCamera();
    const e = cam.projectionMatrix.elements;
    expect(kept(cam, e, 0, 0, 0, 5)).toBe(true);
    expect(kept(cam, e, 30, 0, 0, 5)).toBe(false); // 14 m clear of the right side
    expect(kept(cam, e, 30, 0, 0, 20)).toBe(true); // radius reaches in
    expect(kept(cam, e, 0, 25, 0, 5)).toBe(false); // above
    expect(kept(cam, e, -30, 0, -900, 5)).toBe(false); // deep and to the side: a perspective cone would have opened by now
    expect(kept(cam, e, 15, 9, -900, 1)).toBe(true); // deep, inside the box
  });

  it('negative control: the same matrix read as a perspective one keeps the deep side light the box drops', () => {
    const cam = orthoCamera();
    const asPerspective = Array.from(cam.projectionMatrix.elements);
    asPerspective[11] = -1;
    asPerspective[15] = 0;
    expect(kept(cam, asPerspective, -30, 0, -900, 5)).toBe(true);
    expect(kept(cam, cam.projectionMatrix.elements, -30, 0, -900, 5)).toBe(false);
  });

  it('perspective is unchanged', () => {
    const cam = perspCamera();
    const e = cam.projectionMatrix.elements;
    expect(kept(cam, e, 0, 0, 0, 5)).toBe(true);
    expect(kept(cam, e, 200, 0, 0, 5)).toBe(false);
    expect(kept(cam, e, 200, 0, -900, 5)).toBe(true); // the cone is wide that deep
  });

  it('the world camera in its ortho mode (a PerspectiveCamera object) is recognised too', () => {
    const cam = perspCamera();
    const sw = createProjectionSwitch(cam, () => 2000 as never);
    expect(sw.set('orthographic', 10)).toBe(true);
    cam.updateProjectionMatrix();
    expect(isOrthographic(cam.projectionMatrix.elements)).toBe(true);
    expect(perspectiveFrom(cam.projectionMatrix.elements).halfHeight).toBeCloseTo(10, 9);
    expect(kept(cam, cam.projectionMatrix.elements, 30, 0, 0, 5)).toBe(false);
  });
});
