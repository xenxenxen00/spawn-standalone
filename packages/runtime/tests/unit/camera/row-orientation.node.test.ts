// R-1: a rig that orients through `ctx.self.rotation = { lookAt, include: ["yaw","pitch"] }` (Crown Riot's overhead camera).
import { describe, expect, it } from 'vitest';
import type { RigCtx } from '../../../src/compat/core/types.ts';
import { lookDir } from '../../../src/runtime/camera/camera-presenter.ts';
import { rigWorld } from './rig-world-lite.ts';

const EYE = { x: 0, y: 40, z: 16 };
const PIVOT = { x: 0, y: 20, z: 0 };
const overhead = {
  update(ctx: RigCtx) {
    ctx.self.feetPosition = EYE;
    ctx.self.rotation = { lookAt: PIVOT, include: ['yaw', 'pitch'] };
  },
};

describe('R-1: rig orientation from rotation.lookAt', () => {
  it('opt-in: the eye looks at the pivot (yaw 0 faces -Z, pitch down)', async () => {
    const rw = await rigWorld({ module: overhead, orientationFromRow: true });
    rw.frames(2);
    const p = rw.pose();
    const f = lookDir(p.yaw, p.pitch);
    const d = { x: PIVOT.x - EYE.x, y: PIVOT.y - EYE.y, z: PIVOT.z - EYE.z };
    const len = Math.hypot(d.x, d.y, d.z);
    expect(f.x).toBeCloseTo(d.x / len, 6);
    expect(f.y).toBeCloseTo(d.y / len, 6);
    expect(f.z).toBeCloseTo(d.z / len, 6);
    expect(p.eye).toEqual(EYE);
    expect(rw.host.owned).toEqual({ yaw: true, pitch: true });
  });

  it('a pivot off to the right-front turns the yaw to it; mouse deltas do not move the fixed view', async () => {
    const rw = await rigWorld({
      module: {
        update(ctx: RigCtx) {
          ctx.self.feetPosition = EYE;
          ctx.self.rotation = { lookAt: { x: 10, y: 20, z: 0 }, include: ['yaw', 'pitch'] };
        },
      },
      orientationFromRow: true,
    });
    rw.frames(2);
    const before = rw.pose();
    rw.mouse(300, 300);
    rw.frames(2);
    const after = rw.pose();
    expect(after.yaw).toBe(before.yaw);
    expect(after.pitch).toBe(before.pitch);
    expect(lookDir(after.yaw, after.pitch).x).toBeGreaterThan(0); // pivot is +x of the eye
  });

  it('default (PP): the row rotation is ignored and the camera stays on the state / mouse look', async () => {
    const rw = await rigWorld({ module: overhead });
    rw.frames(2);
    expect(rw.pose().yaw).toBe(0);
    expect(rw.pose().pitch).toBe(0);
    expect(rw.host.owned).toEqual({ yaw: false, pitch: false });
  });
});
