// Transforms (docs/design/core-runtime.md §5.4, §16.1 `transform.test.ts`; contract §1.1-1.3): yaw 90 faces −X, pitch 30 gives
// forward y +0.5, the YXZ round trip, parent chains (incl. the attachment resolver), re-parenting keeps the world pose, and the
// PositionSpec / RotationSpec / scale forms rows are written with.
import { describe, expect, it } from 'vitest';
import {
  composePose,
  eulerYXZToQuat,
  forwardOf,
  localPoseIn,
  quatMul,
  quatToEulerYXZ,
  resolvePositionSpec,
  resolveRotationSpec,
  resolveScaleSpec,
  rotateVec3,
  transformFromSpec,
  worldPose,
  type Pose,
} from '../../../src/compat/core/store/transform.ts';
import type { Quat, Vec3 } from '../../../src/compat/core/types.ts';
import { storeFixture } from './store-fixture.ts';

const close = (a: Vec3, b: Vec3, eps = 1e-9): void => {
  expect(Math.abs(a.x - b.x), `x ${a.x} vs ${b.x}`).toBeLessThan(eps);
  expect(Math.abs(a.y - b.y), `y ${a.y} vs ${b.y}`).toBeLessThan(eps);
  expect(Math.abs(a.z - b.z), `z ${a.z} vs ${b.z}`).toBeLessThan(eps);
};
const sameRotation = (a: Quat, b: Quat, eps = 1e-9): void => {
  // q and -q are the same rotation
  const dot = a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  expect(1 - Math.abs(dot)).toBeLessThan(eps);
};

describe('conventions (contract §1.1): +Y up, −Z forward, YXZ degrees', () => {
  it('yaw 0 faces −Z; yaw 90 faces −X (positive yaw turns left)', () => {
    close(forwardOf(eulerYXZToQuat(0, 0, 0)), { x: 0, y: 0, z: -1 });
    close(forwardOf(eulerYXZToQuat(90, 0, 0)), { x: -1, y: 0, z: 0 });
    close(forwardOf(eulerYXZToQuat(-90, 0, 0)), { x: 1, y: 0, z: 0 });
    close(forwardOf(eulerYXZToQuat(180, 0, 0)), { x: 0, y: 0, z: 1 });
  });

  it('pitch 30 raises the forward vector to y +0.5 (positive pitch tips the nose up)', () => {
    const f = forwardOf(eulerYXZToQuat(0, 30, 0));
    close(f, { x: 0, y: 0.5, z: -Math.cos(Math.PI / 6) });
  });

  it('yaw then pitch gives the look direction (−sin yaw·cos pitch, sin pitch, −cos yaw·cos pitch) of scripts/player/aim.js', () => {
    for (const [yaw, pitch] of [[30, 20], [-135, -45], [170, 80], [0, -10]] as const) {
      const y = (yaw * Math.PI) / 180;
      const p = (pitch * Math.PI) / 180;
      close(forwardOf(eulerYXZToQuat(yaw, pitch, 0)), { x: -Math.sin(y) * Math.cos(p), y: Math.sin(p), z: -Math.cos(y) * Math.cos(p) });
    }
  });

  it('roll turns about the forward axis: roll 90 tips +Y to −X', () => {
    close(rotateVec3(eulerYXZToQuat(0, 0, 90), { x: 0, y: 1, z: 0 }), { x: -1, y: 0, z: 0 });
    // roll leaves the forward axis alone
    close(forwardOf(eulerYXZToQuat(0, 0, 37)), { x: 0, y: 0, z: -1 });
  });

  it('composes Y, then X, then Z (three.js YXZ = Ry·Rx·Rz)', () => {
    const q = eulerYXZToQuat(40, -25, 60);
    const composed = quatMul(quatMul(eulerYXZToQuat(40, 0, 0), eulerYXZToQuat(0, -25, 0)), eulerYXZToQuat(0, 0, 60));
    sameRotation(q, composed);
  });
});

describe('YXZ Euler ↔ quaternion round trip', () => {
  it('returns the angles it was given (|pitch| < 90, yaw and roll in (−180, 180])', () => {
    let s = 12345;
    const rnd = (): number => {
      s = (s * 1103515245 + 12345) % 2147483648;
      return s / 2147483648;
    };
    for (let i = 0; i < 2000; i++) {
      const yaw = rnd() * 359.98 - 179.99;
      const pitch = rnd() * 179.8 - 89.9;
      const roll = rnd() * 359.98 - 179.99;
      const e = quatToEulerYXZ(eulerYXZToQuat(yaw, pitch, roll));
      expect(Math.abs(e.yaw - yaw), `yaw ${yaw}`).toBeLessThan(1e-7);
      expect(Math.abs(e.pitch - pitch), `pitch ${pitch}`).toBeLessThan(1e-7);
      expect(Math.abs(e.roll - roll), `roll ${roll}`).toBeLessThan(1e-7);
    }
  });

  it('reads clean degrees back for whole-degree writes (no 89.99999999999999)', () => {
    expect(quatToEulerYXZ(eulerYXZToQuat(90, 0, 0))).toEqual({ yaw: 90, pitch: 0, roll: 0 });
    expect(quatToEulerYXZ(eulerYXZToQuat(-45, 30, 10))).toEqual({ yaw: -45, pitch: 30, roll: 10 });
    expect(Object.is(quatToEulerYXZ(eulerYXZToQuat(0, 0, 0)).yaw, 0)).toBe(true);
  });

  it('settles the gimbal lock at pitch ±90 on yaw with roll 0', () => {
    const e = quatToEulerYXZ(eulerYXZToQuat(30, 90, 0));
    expect(e.pitch).toBeCloseTo(90, 6);
    sameRotation(eulerYXZToQuat(e.yaw, e.pitch, e.roll), eulerYXZToQuat(30, 90, 0), 1e-12);
  });

  it('normalises a non-unit quaternion before reading angles', () => {
    const q = eulerYXZToQuat(20, 10, 5);
    const e = quatToEulerYXZ({ x: q.x * 3, y: q.y * 3, z: q.z * 3, w: q.w * 3 });
    expect(e.yaw).toBeCloseTo(20, 9);
    expect(e.pitch).toBeCloseTo(10, 9);
    expect(e.roll).toBeCloseTo(5, 9);
  });
});

describe('poses: parent chains and re-parenting', () => {
  const pose = (pos: Vec3, yaw = 0, scale: Vec3 = { x: 1, y: 1, z: 1 }): Pose => ({ pos, rot: eulerYXZToQuat(yaw, 0, 0), scale });

  it('a child local position is rotated and scaled by its parent', () => {
    const parent = pose({ x: 10, y: 0, z: 0 }, 90);
    close(composePose(parent, pose({ x: 0, y: 0, z: -1 })).pos, { x: 9, y: 0, z: 0 });
    const scaled = pose({ x: 10, y: 0, z: 0 }, 90, { x: 2, y: 2, z: 2 });
    const w = composePose(scaled, pose({ x: 0, y: 1, z: -1 }, 0, { x: 0.5, y: 0.5, z: 0.5 }));
    close(w.pos, { x: 8, y: 2, z: 0 });
    close(w.scale, { x: 1, y: 1, z: 1 });
    sameRotation(w.rot, eulerYXZToQuat(90, 0, 0));
  });

  it('localPoseIn inverts composePose (re-parenting keeps the world pose)', () => {
    const parent: Pose = { pos: { x: 3, y: -2, z: 7 }, rot: eulerYXZToQuat(33, -12, 5), scale: { x: 2, y: 2, z: 2 } };
    const world: Pose = { pos: { x: -4, y: 1.5, z: 2 }, rot: eulerYXZToQuat(-70, 20, 0), scale: { x: 3, y: 3, z: 3 } };
    const local = localPoseIn(parent, world);
    const back = composePose(parent, local);
    close(back.pos, world.pos, 1e-9);
    sameRotation(back.rot, world.rot);
    close(back.scale, world.scale, 1e-12);
  });

  it('worldPose walks the parent chain of the store', () => {
    const f = storeFixture();
    const a = f.add({ id: 'a', transform: { pos: { x: 10, y: 0, z: 0 }, rot: eulerYXZToQuat(90, 0, 0) } });
    const b = f.add({ id: 'a/b', parentId: 'a', transform: { pos: { x: 0, y: 0, z: -2 } } });
    const c = f.add({ id: 'a/b/c', parentId: 'a/b', transform: { pos: { x: 0, y: 1, z: -1 }, scale: { x: 2, y: 2, z: 2 } } });
    close(worldPose(f.store, a).pos, { x: 10, y: 0, z: 0 });
    close(worldPose(f.store, b).pos, { x: 8, y: 0, z: 0 });
    const wc = worldPose(f.store, c);
    close(wc.pos, { x: 7, y: 1, z: 0 });
    close(wc.scale, { x: 2, y: 2, z: 2 });
    sameRotation(wc.rot, eulerYXZToQuat(90, 0, 0));
  });

  it('a bone-attached row asks the attachment resolver; null falls back to the parent chain', () => {
    const f = storeFixture();
    f.add({ id: 'e', transform: { pos: { x: 5, y: 0, z: 5 } } });
    const probe = f.add({ id: 'e/bp-Head', parentId: 'e', props: { attachment: { bone: 'Head' } } });
    close(worldPose(f.store, probe).pos, { x: 5, y: 0, z: 5 });
    f.ports.attach.worldPose = (row) => (row.id === 'e/bp-Head' ? { pos: { x: 5, y: 1.7, z: 5.1 }, rot: { x: 0, y: 0, z: 0, w: 1 } } : null);
    close(worldPose(f.store, probe).pos, { x: 5, y: 1.7, z: 5.1 });
  });
});

describe('spec forms (contract §1.2-1.3)', () => {
  it('PositionSpec: {x,y,z}; {x,z} and {terrain: n} and "surface" take the ground (fallback 0)', () => {
    expect(resolvePositionSpec({ x: 1, y: 2, z: 3 })).toEqual({ x: 1, y: 2, z: 3 });
    expect(resolvePositionSpec({ x: 1, z: 3 })).toEqual({ x: 1, y: 0, z: 3 });
    const ground = (x: number, z: number): number => x + z;
    expect(resolvePositionSpec({ x: 1, z: 3 }, ground)).toEqual({ x: 1, y: 4, z: 3 });
    expect(resolvePositionSpec({ x: 1, z: 3, y: { terrain: 0.5 } }, ground)).toEqual({ x: 1, y: 4.5, z: 3 });
    expect(resolvePositionSpec({ x: 1, z: 3, y: 'surface' }, () => null)).toEqual({ x: 1, y: 0, z: 3 });
    for (const bad of [null, 3, 'x', {}, { x: 1 }, { x: Number.NaN, y: 0, z: 0 }, { x: 0, y: Number.POSITIVE_INFINITY, z: 0 }, { x: 0, z: 0, y: 'up' }]) {
      expect(resolvePositionSpec(bad), JSON.stringify(bad)).toBe(null);
    }
  });

  it('RotationSpec: a number is yaw, {yaw,pitch,roll} defaults missing axes to 0, a quaternion is normalised', () => {
    expect(resolveRotationSpec(90)?.euler).toEqual({ yaw: 90, pitch: 0, roll: 0 });
    expect(resolveRotationSpec({ pitch: 30 })?.euler).toEqual({ yaw: 0, pitch: 30, roll: 0 });
    const q = eulerYXZToQuat(10, 20, 30);
    const r = resolveRotationSpec({ x: q.x * 2, y: q.y * 2, z: q.z * 2, w: q.w * 2 });
    expect(r).not.toBe(null);
    sameRotation(r!.rot, q);
    expect(Math.hypot(r!.rot.x, r!.rot.y, r!.rot.z, r!.rot.w)).toBeCloseTo(1, 12);
    for (const bad of [Number.NaN, 'north', null, { yaw: '90' }, { yaw: Number.NaN }, { x: 0, y: 0, z: 0, w: 0 }]) {
      expect(resolveRotationSpec(bad), JSON.stringify(bad)).toBe(null);
    }
  });

  it('RotationSpec lookAt turns yaw only unless include names pitch', () => {
    const from = { x: 0, y: 0, z: 0 };
    const yawOnly = resolveRotationSpec({ lookAt: { x: -1, y: 5, z: 0 } }, { from: () => from });
    expect(yawOnly?.euler).toEqual({ yaw: 90, pitch: 0, roll: 0 });
    const both = resolveRotationSpec({ lookAt: { x: 0, y: 1, z: -1 }, include: ['yaw', 'pitch'] }, { from: () => from });
    expect(both?.euler?.yaw).toBe(0);
    expect(both?.euler?.pitch).toBeCloseTo(45, 9);
    // a parented row's lookAt is expressed in the parent's frame
    const local = resolveRotationSpec({ lookAt: { x: -1, y: 0, z: 0 } }, { from: () => from, parentRot: () => eulerYXZToQuat(90, 0, 0) });
    sameRotation(local!.rot, { x: 0, y: 0, z: 0, w: 1 });
  });

  it('transformFromSpec: the spawn-time transform of a spec (core §4.2)', () => {
    const t = transformFromSpec({ feetPosition: { x: 1, z: 2 }, yaw: 45, scale: 2 }, { ground: () => 0.5 });
    expect(t.invalid).toEqual([]);
    expect(t.camera).toBe(null);
    expect(t.init.pos).toEqual({ x: 1, y: 0.5, z: 2 });
    expect(t.init.euler).toEqual({ yaw: 45, pitch: 0, roll: 0 });
    expect(t.init.scale).toEqual({ x: 2, y: 2, z: 2 });
    // a rotation object wins for the axes it names; `yaw` fills the yaw it leaves out
    expect(transformFromSpec({ yaw: 45, rotation: { pitch: 10 } }).init.euler).toEqual({ yaw: 45, pitch: 10, roll: 0 });
    expect(transformFromSpec({ yaw: 45, rotation: { yaw: 90, roll: 5 } }).init.euler).toEqual({ yaw: 90, pitch: 0, roll: 5 });
    expect(transformFromSpec({ yaw: 45, rotation: 120 }).init.euler).toEqual({ yaw: 120, pitch: 0, roll: 0 });
    // a lookAt faces the target from the row's world feet (its parent's frame for a child)
    const look = transformFromSpec(
      { feetPosition: { x: 0, y: 0, z: -1 }, rotation: { lookAt: { x: -10, y: 0, z: 0 } } },
      { parentPose: { pos: { x: 10, y: 0, z: 0 }, rot: eulerYXZToQuat(90, 0, 0), scale: { x: 1, y: 1, z: 1 } } },
    );
    // world feet (9, 0, 0); the target is due −X: world yaw 90, local yaw 0 under the parent's yaw 90
    sameRotation(look.init.rot!, { x: 0, y: 0, z: 0, w: 1 });
    // the camera form (viewmodels, contract §9.13)
    const vm = transformFromSpec({ feetPosition: { attach: 'camera', x: 0.2, y: -0.62, depth: 0.9, fov: 55 } });
    expect(vm.camera).toEqual({ attach: 'camera', x: 0.2, y: -0.62, depth: 0.9, fov: 55 });
    expect(vm.init.pos).toEqual({ x: 0.2, y: -0.62, z: -0.9 });
    // invalid fields are named and left at their defaults
    const bad = transformFromSpec({ feetPosition: { x: Number.NaN, y: 0, z: 0 }, rotation: 'north', scale: 'big' });
    expect(bad.invalid).toEqual(['feetPosition', 'rotation', 'scale']);
    expect(bad.init).toEqual({});
  });

  it('scale: a number is uniform, a Vec3 per axis', () => {
    expect(resolveScaleSpec(2)).toEqual({ x: 2, y: 2, z: 2 });
    expect(resolveScaleSpec({ x: 1, y: 2, z: 3 })).toEqual({ x: 1, y: 2, z: 3 });
    for (const bad of [Number.NaN, '2', null, { x: 1, y: 'a', z: 1 }]) expect(resolveScaleSpec(bad), String(bad)).toBe(null);
  });
});
