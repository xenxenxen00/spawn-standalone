// get-input-ray.test (motion §6.3, contract §10.1; WP PH3): `builtin/physics.getInputRay(ctx, input?)` over a fake camera
// port and hand-built input samples. Origin = the presented eye. `source: 'pointer'` when the sample carries pointer data:
// locked (and on touch) that is the screen centre, so the ray is the camera's centre ray; unlocked it is the free cursor.
// `source: 'camera'` with no pointer. null before the first camera frame.
import { afterEach, describe, expect, it } from 'vitest';
import { bindPhysicsQueries, getInputRay, type InputRayCamera } from '../../../src/compat/builtin/physics.ts';
import { emptyInputState } from '../../../src/compat/core/null-ports.ts';
import type { CameraPort } from '../../../src/compat/core/ports.ts';
import type { InputState } from '../../../src/compat/core/types.ts';
import { PhysicsPortImpl } from '../../../src/compat/physics/port.ts';
import { fakeStore } from './port-fixtures.ts';

type V = { x: number; y: number; z: number };
const ctx = { place: { id: 'home' }, self: { id: 'player/local' } };
/** scripts/player/aim.js `lookDir`: yaw 0 faces -Z, positive yaw turns left, +pitch looks up (radians) */
const lookDir = (yaw: number, pitch: number): V => ({ x: -Math.sin(yaw) * Math.cos(pitch), y: Math.sin(pitch), z: -Math.cos(yaw) * Math.cos(pitch) });
const DEG = Math.PI / 180;

interface Cam { eye: V; yaw: number; pitch: number; fov: number; aspect?: number }
/** a camera port as io's RigHost presents it: `aim` is the forward direction, `fov` the vertical field of view in degrees */
function camera(c: Cam | null): CameraPort {
  return {
    presentedCamera: () => (c ? { eye: { ...c.eye }, aim: lookDir(c.yaw, c.pitch), fov: c.fov } : null),
    view: () => (c ? { yaw: c.yaw, pitch: c.pitch } : undefined),
    worldCamera: () => (c ? { fov: c.fov, ...(c.aspect !== undefined ? { aspect: c.aspect } : {}) } : {}),
  };
}
const bind = (cam: InputRayCamera | null): void => bindPhysicsQueries({ world: () => null, warn: () => undefined, camera: () => cam });
const sample = (pointer?: InputState['pointer']): InputState => ({ ...emptyInputState(), ...(pointer ? { pointer } : {}) });
const near = (a: V, b: V, digits = 9): void => {
  expect(a.x).toBeCloseTo(b.x, digits);
  expect(a.y).toBeCloseTo(b.y, digits);
  expect(a.z).toBeCloseTo(b.z, digits);
};
const angle = (a: V, b: V): number => Math.acos(Math.min(1, a.x * b.x + a.y * b.y + a.z * b.z)) / DEG;

afterEach(() => bindPhysicsQueries(null));

const CAM: Cam = { eye: { x: 3, y: 1.7, z: -2 }, yaw: 30 * DEG, pitch: -10 * DEG, fov: 70, aspect: 16 / 9 };

describe('getInputRay', () => {
  it('null before the first camera frame, and while no physics port is bound', () => {
    expect(getInputRay(ctx, sample({ x: 640, y: 360, ndcX: 0, ndcY: 0 }))).toBeNull();
    bind(camera(null));
    expect(getInputRay(ctx, sample({ x: 640, y: 360, ndcX: 0, ndcY: 0 }))).toBeNull();
    expect(getInputRay(ctx)).toBeNull();
    bind(null);
    expect(getInputRay(ctx)).toBeNull();
  });

  it('locked pointer: the sample\'s pointer is the screen centre, the ray is the camera\'s centre ray, source pointer', () => {
    bind(camera(CAM));
    const ray = getInputRay(ctx, sample({ x: 640, y: 360, ndcX: 0, ndcY: 0 }))!;
    expect(ray.source).toBe('pointer');
    expect(ray.origin).toEqual(CAM.eye);
    near(ray.direction, lookDir(CAM.yaw, CAM.pitch));
    expect(Math.hypot(ray.direction.x, ray.direction.y, ray.direction.z)).toBeCloseTo(1, 12);
    // fresh objects: the game may keep or change them
    ray.origin.x = 99;
    expect(getInputRay(ctx, sample({ x: 640, y: 360, ndcX: 0, ndcY: 0 }))!.origin).toEqual(CAM.eye);
  });

  it('touch: the crosshair is the screen centre whatever finger is down (the sample carries the centre), source pointer', () => {
    bind(camera({ ...CAM, aspect: 19.5 / 9 }));
    const ray = getInputRay(ctx, sample({ x: 422, y: 195, ndcX: 0, ndcY: 0 }))!;
    expect(ray.source).toBe('pointer');
    near(ray.direction, lookDir(CAM.yaw, CAM.pitch));
  });

  it('unlocked pointer: the ray through the free cursor, off the centre by the angle its ndc and the field of view imply', () => {
    const level: Cam = { eye: { x: 0, y: 1.7, z: 0 }, yaw: 0, pitch: 0, fov: 60, aspect: 2 };
    bind(camera(level));
    const tan = Math.tan(30 * DEG);
    // the top edge of the view: half the vertical field of view above the centre
    const up = getInputRay(ctx, sample({ x: 640, y: 0, ndcX: 0, ndcY: 1 }))!;
    expect(up.source).toBe('pointer');
    expect(up.origin).toEqual(level.eye);
    near(up.direction, lookDir(0, 30 * DEG));
    // the right edge: atan(tan(vfov / 2) · aspect) to the right, which is +X when facing -Z
    const right = getInputRay(ctx, sample({ x: 1280, y: 360, ndcX: 1, ndcY: 0 }))!;
    expect(right.direction.x).toBeGreaterThan(0);
    expect(angle(right.direction, lookDir(0, 0))).toBeCloseTo(Math.atan(tan * 2) / DEG, 9);
    expect(right.direction.y).toBeCloseTo(0, 12);
    // a cursor low and left of the centre (the measured trap: aim 19-26° down with the camera level)
    const low = getInputRay(ctx, sample({ x: 400, y: 600, ndcX: -0.375, ndcY: -2 / 3 }))!;
    const want = { x: -0.375 * tan * 2, y: (-2 / 3) * tan, z: -1 };
    const l = Math.hypot(want.x, want.y, want.z);
    near(low.direction, { x: want.x / l, y: want.y / l, z: want.z / l });
    expect(Math.asin(-low.direction.y) / DEG).toBeGreaterThan(19);

    // with the camera turned and pitched the offsets are in the camera's frame
    bind(camera(CAM));
    const f = lookDir(CAM.yaw, CAM.pitch);
    const off = getInputRay(ctx, sample({ x: 900, y: 200, ndcX: 0.4, ndcY: 0.45 }))!;
    const rx = Math.cos(CAM.yaw), rz = -Math.sin(CAM.yaw);
    const u = { x: -rz * f.y, y: rz * f.x - rx * f.z, z: rx * f.y };
    const t = Math.tan(35 * DEG);
    const d = { x: f.x + rx * 0.4 * t * (16 / 9) + u.x * 0.45 * t, y: f.y + u.y * 0.45 * t, z: f.z + rz * 0.4 * t * (16 / 9) + u.z * 0.45 * t };
    const dl = Math.hypot(d.x, d.y, d.z);
    near(off.direction, { x: d.x / dl, y: d.y / dl, z: d.z / dl });
    expect(off.origin).toEqual(CAM.eye);
  });

  it('no pointer in the sample, or no sample at all: the presented camera forward, source camera', () => {
    bind(camera(CAM));
    for (const ray of [getInputRay(ctx, sample()), getInputRay(ctx), getInputRay(ctx, null), getInputRay(ctx, { pointer: null })]) {
      expect(ray!.source).toBe('camera');
      expect(ray!.origin).toEqual(CAM.eye);
      near(ray!.direction, lookDir(CAM.yaw, CAM.pitch));
    }
  });

  it('before the camera port knows its aspect the rig\'s 16:9 fallback is used; looking straight down, right comes from the view yaw', () => {
    const { aspect: _a, ...noAspect } = { ...CAM, yaw: 0, pitch: 0, fov: 60 };
    void _a;
    bind(camera(noAspect));
    const right = getInputRay(ctx, sample({ x: 1280, y: 360, ndcX: 1, ndcY: 0 }))!;
    expect(angle(right.direction, lookDir(0, 0))).toBeCloseTo(Math.atan(Math.tan(30 * DEG) * (16 / 9)) / DEG, 9);
    bind(camera({ eye: { x: 0, y: 5, z: 0 }, yaw: 90 * DEG, pitch: -90 * DEG, fov: 60, aspect: 1 }));
    const down = getInputRay(ctx, sample({ x: 0, y: 0, ndcX: 1, ndcY: 0 }))!;
    // yaw 90° faces -X, so the screen's right is -Z
    expect(down.direction.z).toBeLessThan(-0.4);
    expect(down.direction.y).toBeLessThan(-0.8);
    expect(Math.abs(down.direction.x)).toBeLessThan(1e-9);
  });

  it('the physics port binds the camera of its host: the kernel\'s camera port is what the builtin reads', () => {
    const port = new PhysicsPortImpl({ host: { store: fakeStore(), camera: camera(CAM) } });
    const ray = getInputRay(ctx, sample({ x: 1, y: 1, ndcX: 0, ndcY: 0 }))!;
    expect(ray.source).toBe('pointer');
    near(ray.direction, lookDir(CAM.yaw, CAM.pitch));
    port.dispose();
    expect(getInputRay(ctx)).toBeNull();
  });
});
