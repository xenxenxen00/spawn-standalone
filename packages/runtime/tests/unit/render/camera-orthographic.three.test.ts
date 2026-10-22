// K16: orthographic world camera. Projection mode of the one world camera, half-height orthoSize, half-width orthoSize x aspect.
import { WebGLCoordinateSystem, WebGPUCoordinateSystem, type CoordinateSystem } from 'three';
import { describe, expect, it } from 'vitest';
import { createCameraPresenter, type CameraPose } from '../../../src/render/scene/camera-presenter.ts';
import { orthoExtents } from '../../../src/render/scene/ortho-projection.ts';

const camY = 4.5;
const ortho = (H: number, over: Partial<CameraPose> = {}): CameraPose => ({
  eye: { x: 0, y: camY, z: 26 }, yaw: 0, pitch: 0, roll: 0, vfovDeg: 40, projection: 'orthographic', orthoSize: H, ...over,
});
function make(w: number, h: number, cs: CoordinateSystem = WebGLCoordinateSystem) {
  const p = createCameraPresenter({ coordinateSystem: () => cs });
  p.setViewport(w, h);
  return p;
}

describe('orthographic projection (K16)', () => {
  for (const [w, h] of [[1600, 1000], [560, 1000]] as const) {
    it(`aspect ${w / h}: (0, camY, 0) is the screen centre and (vis, camY + H, 0) the top-right corner within 1 px`, () => {
      const p = make(w, h);
      const H = 6;
      p.apply(ortho(H));
      const vis = H * (w / h);
      const c = p.project({ x: 0, y: camY, z: 0 });
      expect(Math.abs(c.x - w / 2)).toBeLessThan(1);
      expect(Math.abs(c.y - h / 2)).toBeLessThan(1);
      expect(c.onScreen).toBe(true);
      const k = p.project({ x: vis, y: camY + H, z: 0 });
      expect(Math.abs(k.x - w)).toBeLessThan(1);
      expect(Math.abs(k.y - 0)).toBeLessThan(1);
    });
  }

  it('has no parallax: points at z = 0 and z = 1.8 on one ray keep their on-screen offset', () => {
    const p = make(1600, 1000);
    p.apply(ortho(6));
    const a = p.project({ x: 2, y: camY + 1, z: 0 });
    const b = p.project({ x: 2, y: camY + 1, z: 1.8 });
    expect(b.x).toBeCloseTo(a.x, 6);
    expect(b.y).toBeCloseTo(a.y, 6);
  });

  it('follows a per-frame orthoSize and a viewport resize, and keeps the same camera object', () => {
    const p = make(1600, 1000);
    const cam = p.world;
    p.apply(ortho(6));
    const x1 = p.project({ x: 3, y: camY, z: 0 }).x;
    p.apply(ortho(12));
    expect(p.project({ x: 3, y: camY, z: 0 }).x).toBeLessThan(x1);
    p.setViewport(800, 1000);
    p.apply(ortho(6));
    const corner = p.project({ x: 6 * 0.8, y: camY + 6, z: 0 });
    expect(Math.abs(corner.x - 800)).toBeLessThan(1);
    expect(p.world).toBe(cam);
    expect(p.projection).toBe('orthographic');
  });

  it('switches back to PP\'s perspective matrix exactly', () => {
    const base = make(1280, 720);
    base.apply({ eye: { x: 0, y: 1.6, z: 0 }, yaw: 0, pitch: 0, roll: 0, vfovDeg: 58.72 });
    const want = base.world.projectionMatrix.toArray();
    const p = make(1280, 720);
    p.apply(ortho(6));
    expect(p.world.projectionMatrix.toArray()).not.toEqual(want);
    p.apply({ eye: { x: 0, y: 1.6, z: 0 }, yaw: 0, pitch: 0, roll: 0, vfovDeg: 58.72 });
    expect(p.projection).toBe('perspective');
    expect(p.world.projectionMatrix.toArray()).toEqual(want);
  });

  it('builds the matrix for either coordinate system (depth 0 at near on WebGPU)', () => {
    const gpu = make(1000, 1000, WebGPUCoordinateSystem);
    gpu.apply(ortho(5, { eye: { x: 0, y: 0, z: 0 }, near: 1, far: 11 }));
    expect(gpu.project({ x: 0, y: 0, z: -1 }).depth).toBeCloseTo(0, 6);
    const gl = make(1000, 1000);
    gl.apply(ortho(5, { eye: { x: 0, y: 0, z: 0 }, near: 1, far: 11 }));
    expect(gl.project({ x: 0, y: 0, z: -1 }).depth).toBeCloseTo(-1, 6);
  });

  it('rejects a missing or non-positive orthoSize and exposes the extents', () => {
    const p = make(1600, 1000);
    expect(() => p.apply(ortho(0))).toThrow(RangeError);
    expect(() => p.apply(ortho(Number.NaN))).toThrow(RangeError);
    expect(() => p.apply({ eye: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, roll: 0, vfovDeg: 40, projection: 'orthographic' })).toThrow(RangeError);
    expect(orthoExtents(6, 1.6)).toEqual({ left: -9.600000000000001, right: 9.600000000000001, top: 6, bottom: -6 });
  });
});
