// look (io §4.4; contract §11.3): the engine-integrated look and the behaviour look axes. The measured live scale is
// 100 px = 0.180 rad at the default sensitivity (scripts/camera.js:9-11): 0.0006 rad/px (engine base) × 3 (the camera def's
// sensitivity, templates/camera.js:8) × prefs.sens 1.
import { describe, expect, it } from 'vitest';
import { DEF_SENS, LOOK_BASE, Look, PITCH_LIMIT, SPIKE_PX } from '../../../src/runtime/input/look.ts';

const close = (a: number, b: number): void => expect(a).toBeCloseTo(b, 12);

describe('Look: engine-owned yaw/pitch', () => {
  it('100 px = 0.180 rad at sens 1 (mouse right turns right: yaw falls; yaw 0 faces -Z, + turns left)', () => {
    expect(LOOK_BASE).toBe(0.0006);
    expect(DEF_SENS).toBe(3);
    const look = new Look();
    look.push(100, 0);
    const v = look.integrate();
    close(v.yaw, -0.18);
    close(v.pitch, 0);
  });

  it('mouse down looks down (pitch + is up); invert Y flips it', () => {
    const look = new Look();
    look.push(0, 100);
    close(look.integrate().pitch, -0.18);
    const inv = new Look({ invertY: true });
    inv.push(0, 100);
    close(inv.integrate().pitch, 0.18);
  });

  it('sensitivity scales linearly; out-of-range or junk values are sanitised', () => {
    const look = new Look({ sens: 2 });
    look.push(100, 0);
    close(look.integrate().yaw, -0.36);
    look.setPrefs({ sens: Number.NaN });
    expect(look.sens).toBe(1);
    look.setPrefs({ sens: 99 });
    expect(look.sens).toBe(4);
    look.setPrefs({ sens: 0 });
    expect(look.sens).toBe(0.1);
  });

  it('pitch clamps at ±1.4 rad; yaw does not clamp', () => {
    expect(PITCH_LIMIT).toBe(1.4);
    const look = new Look();
    for (let i = 0; i < 20; i++) look.push(300, 300);
    const v = look.integrate();
    close(v.pitch, -1.4);
    close(v.yaw, -20 * 300 * 0.0018);
    for (let i = 0; i < 40; i++) look.push(0, -300);
    close(look.integrate().pitch, 1.4);
  });

  it('spike filter: a mouse event above 400 px on either axis is dropped (pointer-lock entry spikes)', () => {
    expect(SPIKE_PX).toBe(400);
    const look = new Look();
    expect(look.push(401, 0)).toBe(false);
    expect(look.push(0, -401)).toBe(false);
    expect(look.push(400, 0)).toBe(true);
    close(look.integrate().yaw, -0.72);
    // touch drags are not spike-filtered
    expect(look.push(500, 0, { source: 'touch', base: 0.0015 })).toBe(true);
  });

  it('pending deltas integrate once; an owned axis drops its delta for the frame and adopts the rig value', () => {
    const look = new Look();
    look.push(100, 100);
    const v = look.integrate({ yaw: true });
    close(v.yaw, 0);
    close(v.pitch, -0.18);
    look.adopt('yaw', 1.25);
    close(look.integrate().yaw, 1.25);
    // a rig value is adopted exactly (the rig clamps its own pitch at ±1.45); the engine clamp applies to the next mouse delta
    look.adopt('pitch', 1.45);
    close(look.integrate().pitch, 1.45);
    look.push(0, -10);
    close(look.integrate().pitch, 1.4);
  });

  it('view() reads the engine values without integrating', () => {
    const look = new Look();
    look.push(100, 0);
    close(look.view().yaw, 0);
    look.integrate();
    close(look.view().yaw, -0.18);
  });
});

describe('Look: behaviour axes lookX / lookY (base scale × the player sensitivity; the rig applies SENS 3 itself)', () => {
  it('100 px → lookX 0.06 rad, which the rig turns into 0.180 rad', () => {
    const d = new Look().deltasFor(100, 100);
    close(d.lookX, 0.06);
    close(d.lookY, 0.06);
    close(d.lookX * DEF_SENS, 0.18);
  });

  it('lookY follows invert Y and both follow sensitivity', () => {
    const d = new Look({ sens: 2, invertY: true }).deltasFor(100, 100);
    close(d.lookX, 0.12);
    close(d.lookY, -0.12);
  });
});
