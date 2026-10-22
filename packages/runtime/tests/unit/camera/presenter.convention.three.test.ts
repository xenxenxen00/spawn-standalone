// `presenter.convention` (io §5.3, §5.8; render §4.2): the pose the camera domain pushes, applied by render's real presenter to
// a three `PerspectiveCamera` (right-handed, +Y up, looking down −Z; `rotation.set(pitch, yaw, roll, 'YXZ')`), faces where
// the live `lookDir` says: yaw 0 looks at −Z, +90° looks at −X, pitch +0.5 looks up. The `presented` forward / up the camera
// domain publishes (audio listener, `ctx.view.camera.aim`) are three's own camera axes, juice offsets included. three is
// imported here only (rule three-confined: src/runtime/camera is in the boot chunk).
import { PerspectiveCamera, Vector3, WebGLCoordinateSystem } from 'three';
import { describe, expect, it } from 'vitest';
import { createCameraPresenter as createRenderPresenter } from '../../../src/render/scene/camera-presenter.ts';
import { ZERO_JUICE, createCameraPresenter, lookDir, resolvePose, type JuiceOffsets, type PresentedPose } from '../../../src/runtime/camera/camera-presenter.ts';

const DEG = Math.PI / 180;
const pose = (over: Partial<PresentedPose> = {}): PresentedPose => ({ mode: 'first', eye: { x: 0, y: 1.6, z: 0 }, yaw: 0, pitch: 0, vfovDeg: 58.72, hideBodyId: null, ...over });

function rigged() {
  const render = createRenderPresenter({ coordinateSystem: () => WebGLCoordinateSystem });
  render.setViewport(1280, 720);
  const io = createCameraPresenter({ target: render });
  const cam: PerspectiveCamera = render.world;
  const forward = (): Vector3 => cam.getWorldDirection(new Vector3());
  const up = (): Vector3 => new Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
  return { render, io, cam, forward, up };
}
const near = (v: { x: number; y: number; z: number }, e: { x: number; y: number; z: number }, digits = 9): void => {
  expect(v.x).toBeCloseTo(e.x, digits);
  expect(v.y).toBeCloseTo(e.y, digits);
  expect(v.z).toBeCloseTo(e.z, digits);
};

describe('presenter.convention', () => {
  it('yaw 0 looks at −Z', () => {
    const r = rigged();
    r.io.apply(pose(), ZERO_JUICE);
    near(r.forward(), { x: 0, y: 0, z: -1 });
    near(r.up(), { x: 0, y: 1, z: 0 });
    expect(r.cam.position.toArray()).toEqual([0, 1.6, 0]);
  });

  it('yaw +90° looks at −X (positive yaw turns left)', () => {
    const r = rigged();
    r.io.apply(pose({ yaw: Math.PI / 2 }), ZERO_JUICE);
    near(r.forward(), { x: -1, y: 0, z: 0 });
  });

  it('pitch +0.5 looks up; pitch 30° gives forward.y = 0.5', () => {
    const r = rigged();
    r.io.apply(pose({ pitch: 0.5 }), ZERO_JUICE);
    near(r.forward(), { x: 0, y: Math.sin(0.5), z: -Math.cos(0.5) });
    expect(r.forward().y).toBeGreaterThan(0);
    r.io.apply(pose({ pitch: 30 * DEG }), ZERO_JUICE);
    expect(r.forward().y).toBeCloseTo(0.5, 9);
  });

  it('three\'s camera axes are the published forward and up, for any look', () => {
    const r = rigged();
    for (const [yaw, pitch] of [[0.3, 0.2], [-2.1, -1.2], [3, 1.4], [1.2, -1.45], [-0.6, 0.6]] as const) {
      r.io.apply(pose({ yaw, pitch }), ZERO_JUICE);
      near(r.forward(), lookDir(yaw, pitch));
      near(r.io.presented.forward, r.forward());
      near(r.io.presented.up, r.up());
    }
  });

  it('juice offsets: yaw / pitch / roll land on the camera as given and the eye push is in the camera frame', () => {
    const r = rigged();
    const j: JuiceOffsets = { pos: { x: 0.02, y: -0.01, z: -0.03 }, yaw: 0.02, pitch: 0.03, roll: 0.25 };
    r.io.apply(pose({ yaw: 0.8, pitch: -0.4 }), j);
    expect(r.cam.rotation.order).toBe('YXZ');
    expect(r.cam.rotation.y).toBeCloseTo(0.82, 12);
    expect(r.cam.rotation.x).toBeCloseTo(-0.37, 12);
    expect(r.cam.rotation.z).toBeCloseTo(0.25, 12);
    near(r.io.presented.forward, r.forward());
    near(r.io.presented.up, r.up());
    // three's own camera-space → world mapping for the same offset at the unshaken look
    const unshaken = new PerspectiveCamera();
    unshaken.position.set(0, 1.6, 0);
    unshaken.rotation.set(-0.4, 0.8, 0, 'YXZ');
    unshaken.updateMatrixWorld();
    const eye = unshaken.localToWorld(new Vector3(0.02, -0.01, -0.03));
    near(r.cam.position, eye);
    near(r.io.presented.eye, eye);
  });

  it('the fov is three\'s vertical angle in degrees; near / far stay render\'s 0.1 / 2000', () => {
    const r = rigged();
    r.io.apply(pose({ vfovDeg: 73.74 }), ZERO_JUICE);
    expect(r.cam.fov).toBe(73.74);
    expect(r.cam.near).toBe(0.1);
    expect(r.cam.far).toBe(2000);
    expect(r.render.aspect).toBeCloseTo(16 / 9, 12);
  });

  it('the hidden body reaches render\'s layer mask: hidden in first person, drawn in the downed view', () => {
    const r = rigged();
    r.io.apply(pose({ hideBodyId: 'player/local' }), ZERO_JUICE);
    expect(r.render.hiddenBody).toBe('player/local');
    r.io.apply(pose({ hideBodyId: null }), ZERO_JUICE);
    expect(r.render.hiddenBody).toBeNull();
  });

  it('the orbit eye looks through its pivot on three\'s camera', () => {
    const r = rigged();
    const p = resolvePose(
      { feet: { x: 0, y: 30, z: 0 }, yaw: 1.1, pitch: -0.8, vfovDeg: 58.72, hideLocalPlayer: true, targetId: 'player/local', targetFeet: { x: 4, y: 2, z: -6 }, arm: { desiredDist: 15, collisionDist: 15 } },
      'orbit',
      58.72,
    );
    r.io.apply(p, ZERO_JUICE);
    const through = r.cam.position.clone().addScaledVector(r.forward(), 15);
    near(through, { x: 4, y: 3.8, z: -6 });
  });

  it('render\'s presenter never refuses what the camera domain pushes', () => {
    const r = rigged();
    r.io.apply(pose({ yaw: 0.4 }), ZERO_JUICE);
    expect(() =>
      r.io.apply(pose({ eye: { x: Number.NaN, y: 0, z: 0 }, yaw: Number.NaN, pitch: Number.POSITIVE_INFINITY, vfovDeg: 500 }), { pos: { x: Number.NaN, y: 0, z: 0 }, yaw: Number.NaN, pitch: 0, roll: Number.NaN }),
    ).not.toThrow();
    expect(r.cam.rotation.y).toBeCloseTo(0.4, 12);
    expect(r.cam.fov).toBe(58.72);
  });
});
