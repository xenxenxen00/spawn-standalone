// WP R8 (docs/architecture.md §9.3 R8, X-36; render §4.3, §16.2): "the camera-space offset is interpolated by `alpha` between
// ticks and steps with `viewmodelInterp = 'step'`". The pure maths (`presentViewmodelOffset`, `viewmodelOffsetSnaps`), the
// explicit tick track, and the track fed from a real core row: a camera-attached row of `RowStoreImpl` written once per tick
// by its handle, as `scripts/player/viewmodel.js:554-555` writes it, read through the feed's `RowSnapshot`.
import { describe, expect, it } from 'vitest';
import { rowSnapshot } from '../../../../src/compat/core/events/feed.ts';
import { eulerYXZToQuat } from '../../../../src/compat/core/store/transform.ts';
import type { Quat } from '../../../../src/compat/core/types.ts';
import {
  VIEWMODEL_SNAP_ANGLE_DEG,
  VIEWMODEL_SNAP_DISTANCE_M,
  ViewmodelTrack,
  presentViewmodelOffset,
  viewmodelOffsetSnaps,
  type ViewmodelOffset,
} from '../../../../src/render/models/viewmodel-renderer.ts';
import { storeFixture } from '../../core/store-fixture.ts';

const off = (x: number, y: number, depth: number, yaw = 0, pitch = 0, roll = 0, fov = 55): ViewmodelOffset => ({ x, y, depth, fov, rot: eulerYXZToQuat(yaw, pitch, roll) });

/** angle between two unit quaternions, degrees */
const angle = (a: Quat, b: Quat): number => (2 * Math.acos(Math.min(1, Math.abs(a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w))) * 180) / Math.PI;

function expectOffset(got: ViewmodelOffset, want: ViewmodelOffset, digits = 12): void {
  expect(got.x).toBeCloseTo(want.x, digits);
  expect(got.y).toBeCloseTo(want.y, digits);
  expect(got.depth).toBeCloseTo(want.depth, digits);
  expect(got.fov).toBeCloseTo(want.fov, digits);
  expect(angle(got.rot, want.rot)).toBeLessThan(1e-5);
}

describe('presentViewmodelOffset: lerp / slerp of the camera-space offset (X-36)', () => {
  const prev = off(0.22, -0.3915, 0.5, 4, -8, 0, 55);
  const cur = off(0.2, -0.38, 0.46, 6, -14, 2, 50);

  it('the snap thresholds are the documented 0.25 m and 30°', () => {
    expect([VIEWMODEL_SNAP_DISTANCE_M, VIEWMODEL_SNAP_ANGLE_DEG]).toEqual([0.25, 30]);
  });

  it('alpha 0 is the previous tick, alpha 1 the current one, exactly', () => {
    expect(presentViewmodelOffset(prev, cur, 0, 'alpha')).toEqual(prev);
    expect(presentViewmodelOffset(prev, cur, 1, 'alpha')).toEqual(cur);
  });

  it('alpha 0.5 is the midpoint of x, y, depth and fov', () => {
    const mid = presentViewmodelOffset(prev, cur, 0.5, 'alpha');
    expect(mid.x).toBeCloseTo(0.21, 12);
    expect(mid.y).toBeCloseTo(-0.38575, 12);
    expect(mid.depth).toBeCloseTo(0.48, 12);
    expect(mid.fov).toBeCloseTo(52.5, 12);
  });

  it('is linear in alpha between the two ticks', () => {
    for (const a of [0.1, 0.25, 0.6, 0.9]) {
      const o = presentViewmodelOffset(prev, cur, a, 'alpha');
      expect(o.x).toBeCloseTo(prev.x + (cur.x - prev.x) * a, 12);
      expect(o.depth).toBeCloseTo(prev.depth + (cur.depth - prev.depth) * a, 12);
    }
  });

  it('the rotation is a slerp of quaternions: yaw 0 → 20 is yaw 10 at the midpoint', () => {
    const o = presentViewmodelOffset(off(0, 0, 0.5, 0), off(0, 0, 0.5, 20), 0.5, 'alpha');
    expect(angle(o.rot, eulerYXZToQuat(10, 0, 0))).toBeLessThan(1e-5);
    const q = presentViewmodelOffset(off(0, 0, 0.5, 0), off(0, 0, 0.5, 20), 0.25, 'alpha');
    expect(angle(q.rot, eulerYXZToQuat(5, 0, 0))).toBeLessThan(1e-5);
  });

  it('never takes the long way round: −q is the same rotation', () => {
    const a = off(0, 0, 0.5, 10);
    const b = off(0, 0, 0.5, 20);
    b.rot = { x: -b.rot.x, y: -b.rot.y, z: -b.rot.z, w: -b.rot.w };
    const o = presentViewmodelOffset(a, b, 0.5, 'alpha');
    expect(angle(o.rot, eulerYXZToQuat(15, 0, 0))).toBeLessThan(1e-5);
    // the result is a unit quaternion
    expect(Math.hypot(o.rot.x, o.rot.y, o.rot.z, o.rot.w)).toBeCloseTo(1, 12);
  });

  it('alpha outside [0, 1] is clamped (a late frame never extrapolates the gun)', () => {
    expect(presentViewmodelOffset(prev, cur, 1.4, 'alpha')).toEqual(cur);
    expect(presentViewmodelOffset(prev, cur, -0.2, 'alpha')).toEqual(prev);
    expect(presentViewmodelOffset(prev, cur, Number.NaN, 'alpha')).toEqual(cur);
  });

  it("'step' presents the current tick at every alpha", () => {
    for (const a of [0, 0.01, 0.5, 0.99, 1]) expect(presentViewmodelOffset(prev, cur, a, 'step')).toEqual(cur);
  });

  it('writes into the object it is given and allocates nothing else', () => {
    const out = off(0, 0, 0);
    const rot = out.rot;
    expect(presentViewmodelOffset(prev, cur, 0.3, 'alpha', out)).toBe(out);
    expect(out.rot).toBe(rot);
    expect(out.x).toBeCloseTo(prev.x + (cur.x - prev.x) * 0.3, 12);
  });

  it('a jump larger than 0.25 m snaps; 0.24 m does not', () => {
    const a = off(0, 0, 0.5);
    expect(viewmodelOffsetSnaps(a, off(0.24, 0, 0.5))).toBe(false);
    expect(viewmodelOffsetSnaps(a, off(0.26, 0, 0.5))).toBe(true);
    // the distance is that of the 3D offset (x, y, depth), not of one axis
    expect(viewmodelOffsetSnaps(a, off(0.15, 0.15, 0.65))).toBe(true); // 0.2598 m
    expect(viewmodelOffsetSnaps(a, off(0.14, 0.14, 0.64))).toBe(false); // 0.2425 m
    expect(presentViewmodelOffset(a, off(0.26, 0, 0.5), 0.5, 'alpha').x).toBe(0.26);
    expect(presentViewmodelOffset(a, off(0.24, 0, 0.5), 0.5, 'alpha').x).toBeCloseTo(0.12, 12);
  });

  it('a turn larger than 30° snaps; 29° does not', () => {
    const a = off(0, 0, 0.5);
    expect(viewmodelOffsetSnaps(a, off(0, 0, 0.5, 29))).toBe(false);
    expect(viewmodelOffsetSnaps(a, off(0, 0, 0.5, 31))).toBe(true);
    expect(viewmodelOffsetSnaps(a, off(0, 0, 0.5, 0, -31))).toBe(true);
    expect(viewmodelOffsetSnaps(a, off(0, 0, 0.5, 0, 0, 29.5))).toBe(false);
    // the angle is that between the two orientations, whatever the sign of the quaternion
    const b = off(0, 0, 0.5, 29);
    b.rot = { x: -b.rot.x, y: -b.rot.y, z: -b.rot.z, w: -b.rot.w };
    expect(viewmodelOffsetSnaps(a, b)).toBe(false);
    expect(angle(presentViewmodelOffset(a, off(0, 0, 0.5, 31), 0.5, 'alpha').rot, eulerYXZToQuat(31, 0, 0))).toBeLessThan(1e-5);
    expect(angle(presentViewmodelOffset(a, off(0, 0, 0.5, 29), 0.5, 'alpha').rot, eulerYXZToQuat(14.5, 0, 0))).toBeLessThan(1e-5);
  });

  it('a change of fov alone does not snap (it is interpolated)', () => {
    expect(viewmodelOffsetSnaps(off(0, 0, 0.5, 0, 0, 0, 55), off(0, 0, 0.5, 0, 0, 0, 40))).toBe(false);
  });
});

describe('ViewmodelTrack: one sample per 30 Hz tick', () => {
  it('a new row snaps: its first sample is both ends', () => {
    const t = new ViewmodelTrack();
    t.push(off(0.22, -0.39, 0.5, 4, -8));
    for (const a of [0, 0.5, 1]) expectOffset(t.present(a, 'alpha'), off(0.22, -0.39, 0.5, 4, -8));
  });

  it('interpolates from the previous sample to the current one, tick after tick', () => {
    const t = new ViewmodelTrack();
    t.push(off(0, 0, 0.5));
    t.push(off(0.1, 0, 0.5));
    expect(t.present(0.5, 'alpha').x).toBeCloseTo(0.05, 12);
    t.push(off(0.2, 0, 0.5));
    expect(t.present(0, 'alpha').x).toBeCloseTo(0.1, 12);
    expect(t.present(0.5, 'alpha').x).toBeCloseTo(0.15, 12);
    expect(t.present(1, 'alpha').x).toBeCloseTo(0.2, 12);
  });

  it('snap() restarts the interpolation (a change of weapon)', () => {
    const t = new ViewmodelTrack();
    t.push(off(0, 0, 0.5));
    t.push(off(0.1, 0, 0.5));
    t.snap();
    expect(t.present(0, 'alpha').x).toBe(0.1);
  });

  it("flipping the mode mid-run takes effect on the next call and leaves no state behind", () => {
    const t = new ViewmodelTrack();
    t.push(off(0, 0, 0.5));
    t.push(off(0.1, 0, 0.5));
    expect(t.present(0.25, 'alpha').x).toBeCloseTo(0.025, 12);
    expect(t.present(0.25, 'step').x).toBe(0.1);
    expect(t.present(0.25, 'alpha').x).toBeCloseTo(0.025, 12);
  });

  it('presenting twice with the same alpha gives the same value (a paused frame)', () => {
    const t = new ViewmodelTrack();
    t.push(off(0, 0.01, 0.5, 2, -3));
    t.push(off(0.1, 0.03, 0.47, 5, -9));
    const a = { ...t.present(0.37, 'alpha') };
    const rot = { ...a.rot };
    const b = t.present(0.37, 'alpha');
    expect(b.x).toBe(a.x);
    expect(b.y).toBe(a.y);
    expect(b.depth).toBe(a.depth);
    expect(b.rot).toEqual(rot);
  });
});

describe('ViewmodelTrack.readRow: a camera-attached row of the core store, written once per tick', () => {
  type Handle = { feetPosition: unknown; rotation: unknown; visible: boolean };

  function gun() {
    const f = storeFixture();
    const row = f.add({ id: 'vm-ak', vm: 'client', props: { visible: false } });
    const h = f.store.handle(row, 'client') as unknown as Handle;
    const snap = rowSnapshot(row);
    const track = new ViewmodelTrack();
    /** one body tick: the store rolls prev ← cur, then the game writes the pose */
    const tick = (x: number, y: number, depth: number, yaw: number, pitch: number, fov = 55): void => {
      f.store.beginTick();
      h.feetPosition = { attach: 'camera', x, y, depth, fov };
      h.rotation = { yaw, pitch, roll: 0 };
    };
    return { f, row, h, snap, track, tick };
  }

  it('reads x, y, depth and fov from the camera spec and the rotation the row holds', () => {
    const g = gun();
    g.h.visible = true;
    g.tick(0.22, -0.3915, 0.5, 4, -8);
    g.track.readRow(g.snap);
    expectOffset(g.track.present(1, 'alpha'), off(0.22, -0.3915, 0.5, 4, -8));
    // the store keeps the camera-space point (x, y, −depth) as the row position
    expect(g.row.tf.pos).toEqual({ x: 0.22, y: -0.3915, z: -0.5 });
  });

  it('presents lerp(prev, cur, alpha) between two ticks, at any frame rate', () => {
    const g = gun();
    g.h.visible = true;
    g.tick(0.2, -0.39, 0.5, 4, -8);
    g.track.readRow(g.snap);
    g.tick(0.21, -0.38, 0.48, 6, -10);
    // three frames inside the tick
    for (const a of [0.1, 0.5, 0.9]) {
      g.track.readRow(g.snap);
      const o = g.track.present(a, 'alpha');
      expect(o.x).toBeCloseTo(0.2 + 0.01 * a, 12);
      expect(o.y).toBeCloseTo(-0.39 + 0.01 * a, 12);
      expect(o.depth).toBeCloseTo(0.5 - 0.02 * a, 12);
    }
    g.track.readRow(g.snap);
    expect(angle(g.track.present(0.5, 'alpha').rot, eulerYXZToQuat(5, -9, 0))).toBeLessThan(0.01);
    // the next tick starts where this one ended
    g.tick(0.23, -0.38, 0.48, 6, -10);
    g.track.readRow(g.snap);
    expect(g.track.present(0, 'alpha').x).toBeCloseTo(0.21, 12);
    expect(g.track.present(1, 'alpha').x).toBeCloseTo(0.23, 12);
  });

  it("'step' presents the row's current value only", () => {
    const g = gun();
    g.h.visible = true;
    g.tick(0.2, -0.39, 0.5, 4, -8);
    g.track.readRow(g.snap);
    g.tick(0.21, -0.38, 0.48, 6, -10);
    g.track.readRow(g.snap);
    for (const a of [0, 0.3, 1]) expectOffset(g.track.present(a, 'step'), off(0.21, -0.38, 0.48, 6, -10));
  });

  it('a tick that does not write the row leaves it at rest (no replay of the last step)', () => {
    const g = gun();
    g.h.visible = true;
    g.tick(0.2, -0.39, 0.5, 4, -8);
    g.track.readRow(g.snap);
    g.tick(0.21, -0.39, 0.5, 4, -8);
    g.track.readRow(g.snap);
    expect(g.track.present(0.5, 'alpha').x).toBeCloseTo(0.205, 12);
    g.f.store.beginTick(); // nothing written this tick
    g.track.readRow(g.snap);
    for (const a of [0, 0.5, 1]) expect(g.track.present(a, 'alpha').x).toBe(0.21);
  });

  it('a weapon that is shown again snaps to its new pose, then interpolates from it', () => {
    const g = gun();
    // spawned hidden at its hip pose (viewmodel.js:157-168), then parked for a while
    g.tick(0.22, -0.3915, 0.5, 0, 0);
    g.track.readRow(g.snap);
    g.f.store.beginTick();
    g.track.readRow(g.snap);
    // drawn: the same tick shows it and writes a pose 10 cm away (under the 0.25 m threshold)
    g.f.store.beginTick();
    g.h.visible = true;
    g.h.feetPosition = { attach: 'camera', x: 0.12, y: -0.3915, depth: 0.5, fov: 55 };
    for (const a of [0, 0.4, 1]) {
      g.track.readRow(g.snap);
      expect(g.track.present(a, 'alpha').x).toBe(0.12);
    }
    // the next tick interpolates from the pose it was shown at
    g.tick(0.14, -0.3915, 0.5, 0, 0);
    g.track.readRow(g.snap);
    expect(g.track.present(0.5, 'alpha').x).toBeCloseTo(0.13, 12);
  });

  it('a jump of the pose above the threshold snaps for that tick only', () => {
    const g = gun();
    g.h.visible = true;
    g.tick(0.2, -0.39, 0.5, 0, 0);
    g.track.readRow(g.snap);
    g.tick(0.2, -0.39, 0.9, 0, 0); // 0.4 m
    g.track.readRow(g.snap);
    expect(g.track.present(0.5, 'alpha').depth).toBe(0.9);
    g.tick(0.2, -0.39, 0.8, 0, 0);
    g.track.readRow(g.snap);
    expect(g.track.present(0.5, 'alpha').depth).toBeCloseTo(0.85, 12);
  });

  it('interpolates a changed fov with the pose, and a missing fov is the live 55°', () => {
    const g = gun();
    g.h.visible = true;
    g.tick(0.2, -0.39, 0.5, 0, 0, 55);
    g.track.readRow(g.snap);
    g.tick(0.2, -0.39, 0.5, 0, 0, 45);
    g.track.readRow(g.snap);
    expect(g.track.present(0.5, 'alpha').fov).toBeCloseTo(50, 12);
    expect(g.track.present(1, 'alpha').fov).toBe(45);
    g.tick(0.21, -0.39, 0.5, 0, 0, 45);
    g.track.readRow(g.snap);
    expect(g.track.present(0.5, 'alpha').fov).toBe(45);
    g.f.store.beginTick();
    g.h.feetPosition = { attach: 'camera', x: 0.22, y: -0.39, depth: 0.5 };
    g.track.readRow(g.snap);
    expect(g.track.present(1, 'alpha').fov).toBe(55);
  });
});
