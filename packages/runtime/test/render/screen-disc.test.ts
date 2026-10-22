// The opt-in screen disc: a camera-locked, depth-tested card drawn after the opaque pass (atmosphere/screen-disc.ts).
import { describe, expect, it } from 'vitest';
import { OrthographicCamera, PerspectiveCamera, Vector3 } from 'three/webgpu';
import { createScreenDisc, placeScreenDisc, resolveScreenDisc } from '../../src/render/atmosphere/screen-disc.ts';

const persp = (): PerspectiveCamera => {
  const c = new PerspectiveCamera(40, 16 / 9, 0.1, 1000);
  c.position.set(3, 12, 26);
  c.lookAt(3, 12, 0);
  c.updateMatrixWorld(true);
  return c;
};
const ortho = (): OrthographicCamera => {
  const c = new OrthographicCamera(-20, 20, 11, -11, 0.1, 500);
  c.position.set(0, 40, 26);
  c.updateMatrixWorld(true);
  return c;
};

describe('resolveScreenDisc', () => {
  it('fills the defaults', () => {
    expect(resolveScreenDisc({})).toEqual({ ndc: [0.5, 0.5], radius: 0.045, softness: 0.5, color: [1, 1, 1], opacity: 1, depth: 0.999 });
  });
  it('negative: bad numbers fall back or are clamped', () => {
    const d = resolveScreenDisc({ ndc: [4, Number.NaN], radius: -1, softness: 3, color: [1, 2] as unknown as [number, number, number], opacity: 7 });
    expect(d.ndc).toEqual([1, 0.5]);
    expect(d.radius).toBe(0.001);
    expect(d.softness).toBe(1);
    expect(d.color).toEqual([1, 1, 1]);
    expect(d.opacity).toBe(1);
  });
});

describe('placeScreenDisc', () => {
  for (const [name, make] of [['perspective', persp], ['orthographic', ortho]] as const) {
    it(`${name}: the centre projects to the NDC spot and the radius spans 2 * radius of NDC height`, () => {
      const cam = make();
      const d = resolveScreenDisc({ ndc: [0.5, 0.5], radius: 0.045 });
      const p = placeScreenDisc(cam, d);
      const back = p.centre.clone().project(cam);
      expect(back.x).toBeCloseTo(0.5, 4);
      expect(back.y).toBeCloseTo(0.5, 4);
      const up = new Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
      const top = p.centre.clone().addScaledVector(up, p.radius).project(cam);
      expect(top.y - back.y).toBeCloseTo(0.09, 3);
      // behind everything nearer than the far end of the view
      expect(p.centre.distanceTo(cam.position)).toBeGreaterThan(100);
    });
  }
});

describe('createScreenDisc', () => {
  it('is a transparent, depth-tested card that writes no depth, casts no shadow and is never culled', () => {
    const disc = createScreenDisc({ color: [0.77, 0.62, 0.75] });
    const m = disc.mesh.material as unknown as { transparent: boolean; depthWrite: boolean; depthTest: boolean; fog: boolean };
    expect(m.transparent).toBe(true);
    expect(m.depthWrite).toBe(false);
    expect(m.depthTest).toBe(true);
    expect(m.fog).toBe(false);
    expect(disc.mesh.castShadow).toBe(false);
    expect(disc.mesh.frustumCulled).toBe(false);
    disc.dispose();
  });
  it('follows the camera it is drawn with', () => {
    const disc = createScreenDisc({ ndc: [-0.25, 0.4], radius: 0.05 });
    const cam = persp();
    (disc.mesh.onBeforeRender as unknown as (r: unknown, s: unknown, c: unknown) => void)(null, null, cam);
    const at = new Vector3().setFromMatrixPosition(disc.mesh.matrixWorld).project(cam);
    expect(at.x).toBeCloseTo(-0.25, 4);
    expect(at.y).toBeCloseTo(0.4, 4);
    disc.dispose();
  });
});
