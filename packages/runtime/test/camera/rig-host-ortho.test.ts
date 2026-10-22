// K16: the rig's `projection` / `state.orthoSize` reach the CameraPose the renderer gets; absent, the pose is PP's perspective.
import { describe, expect, it } from 'vitest';
import { createCameraPresenter, type PoseTarget } from '../../src/runtime/camera/camera-presenter.ts';
import { createRigHost } from '../../src/runtime/camera/rig-host.ts';
import type { CameraPose } from '../../src/render/index.ts';
import { CAMERA_RIG_ID } from '../../src/compat/core/ids.ts';

function host(layer: Record<string, unknown>, state: Record<string, unknown>) {
  const poses: CameraPose[] = [];
  const target: PoseTarget = { apply: (p) => void poses.push(p), setHiddenBody() {} };
  const presenter = createCameraPresenter({ target });
  const body = { id: 'b', tf: { pos: { x: 0, y: 0, z: 0 } } };
  const row = { id: CAMERA_RIG_ID, phase: 'alive', pendingSpawnHooks: false, tf: { pos: { x: 1, y: 2, z: 3 } }, state, rig: { targetId: 'b', layer: { read: () => layer, delete() {} } } };
  const kernel = { ids:{humanBody:'player/local',cameraRig:CAMERA_RIG_ID}, clock: { running: true }, store: { get: (id: string) => (id === CAMERA_RIG_ID ? row : id === 'b' ? body : undefined) }, stepRig: () => ({ wrote: new Set<string>(), deleted: new Set<string>() }) };
  const rig = createRigHost({
    look: { integrate: () => ({ yaw: 0, pitch: 0 }), adopt() {}, view: () => ({ yaw: 0, pitch: 0 }), discardPending() {} },
    input: { deliver: () => ({ axes: {} }), setAimView() {} },
    presenter,
    downedOrbit: () => 'fixed',
  } as never);
  rig.attach(kernel as never);
  rig.frame(0.016);
  return poses;
}

describe('rig host orthographic projection', () => {
  it('forwards projection and orthoSize into the pose', () => {
    const poses = host({ projection: 'orthographic', fov: 40 }, { orthoSize: 8.5 });
    expect(poses).toHaveLength(1);
    expect(poses[0]).toMatchObject({ projection: 'orthographic', orthoSize: 8.5 });
  });
  it('negative: default perspective carries neither key', () => {
    const [pose] = host({ fov: 40 }, { orthoSize: 8.5 });
    expect(pose).not.toHaveProperty('projection');
    expect(pose).not.toHaveProperty('orthoSize');
  });
  it('negative: orthographic without a usable orthoSize stays perspective (render would throw)', () => {
    for (const orthoSize of [undefined, 0, -1, Number.NaN]) {
      const [pose] = host({ projection: 'orthographic' }, { orthoSize });
      expect(pose).not.toHaveProperty('projection');
    }
  });
});
