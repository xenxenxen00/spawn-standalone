// bridge/interpolate.ts and bridge/row-spec.ts (docs/design/rendering.md §16.1-16.2, §8.1; contract §9.1): the pure maths of
// the render bridge. No three.js.
import { describe, expect, it } from 'vitest';
import { eulerYXZToQuat, quatToEulerYXZ } from '../../../src/compat/core/store/transform.ts';
import { clampAlpha, presentRowPose, slerpQuat, stepTeleports, teleportThresholdOf, TELEPORT_THRESHOLD_M } from '../../../src/render/bridge/interpolate.ts';
import {
  attachmentBoneOf, isCameraAttached, isEditorOnly, layoutScale, physicsBodyOf, pivotOf, pivotShift, primitiveSpecOf, rowLightOf, scriptedSpecOf, standardMaterialOf, visibleRangeOf,
} from '../../../src/render/bridge/row-spec.ts';
import { cssToLinear } from '../../../src/render/color/color.ts';

const P = (x: number, y = 0, z = 0): { x: number; y: number; z: number } => ({ x, y, z });
const out = (): { pos: { x: number; y: number; z: number }; rot: { x: number; y: number; z: number; w: number } } => ({ pos: P(0), rot: { x: 0, y: 0, z: 0, w: 1 } });

describe('interpolate: presentRowPose', () => {
  const q0 = eulerYXZToQuat(0, 0, 0);
  const q90 = eulerYXZToQuat(90, 0, 0);

  it('lerps the position and slerps the rotation; 0 and 1 are prev and cur exactly', () => {
    const o = out();
    expect(presentRowPose(P(0), q0, P(1), q90, 0.25, 2, o.pos, o.rot)).toBe('mix');
    expect(o.pos).toEqual(P(0.25));
    expect(quatToEulerYXZ(o.rot).yaw).toBeCloseTo(22.5, 9);
    expect(presentRowPose(P(0), q0, P(1), q90, 0, 2, o.pos, o.rot)).toBe('prev');
    expect([o.pos, o.rot]).toEqual([P(0), q0]);
    expect(presentRowPose(P(0), q0, P(1), q90, 1, 2, o.pos, o.rot)).toBe('cur');
    expect([o.pos, o.rot]).toEqual([P(1), q90]);
  });

  it('snaps past the threshold, not at it; null disables interpolation', () => {
    const o = out();
    expect(presentRowPose(P(0), q0, P(2.5), q0, 0.5, TELEPORT_THRESHOLD_M, o.pos, o.rot)).toBe('cur');
    expect(o.pos.x).toBe(2.5);
    expect(presentRowPose(P(0), q0, P(2), q0, 0.5, TELEPORT_THRESHOLD_M, o.pos, o.rot)).toBe('mix');
    expect(o.pos.x).toBe(1);
    expect(presentRowPose(P(0), q0, P(0.1), q0, 0.5, null, o.pos, o.rot)).toBe('cur');
    expect(stepTeleports(P(0), P(0, 2, 0), 2)).toBe(false);
    expect(stepTeleports(P(0), P(0, 2.0001, 0), 2)).toBe(true);
  });

  it('clamps alpha and takes a non-number as the newest tick', () => {
    expect([clampAlpha(-1), clampAlpha(0.3), clampAlpha(4), clampAlpha(Number.NaN)]).toEqual([0, 0.3, 1, 1]);
  });

  it('turns by the short way and stays unit length, also for nearly equal and for opposite-signed quaternions', () => {
    const a = eulerYXZToQuat(170, 0, 0);
    const b = eulerYXZToQuat(-170, 0, 0);
    const o = { x: 0, y: 0, z: 0, w: 1 };
    slerpQuat(a, b, 0.5, o);
    expect(Math.abs(quatToEulerYXZ(o).yaw)).toBeCloseTo(180, 6);
    expect(Math.hypot(o.x, o.y, o.z, o.w)).toBeCloseTo(1, 12);
    // q and −q are one orientation: no turn at all
    const neg = { x: -a.x, y: -a.y, z: -a.z, w: -a.w };
    slerpQuat(a, neg, 0.5, o);
    expect(Math.abs(o.x * a.x + o.y * a.y + o.z * a.z + o.w * a.w)).toBeCloseTo(1, 12);
    const close = eulerYXZToQuat(170.001, 0, 0);
    slerpQuat(a, close, 0.5, o);
    expect(quatToEulerYXZ(o).yaw).toBeCloseTo(170.0005, 6);
    // a three-axis turn: the halfway orientation is the same angle from both ends
    const c = eulerYXZToQuat(40, -20, 10);
    slerpQuat(q0, c, 0.5, o);
    const dot = (p: typeof o, q: typeof o): number => Math.abs(p.x * q.x + p.y * q.y + p.z * q.z + p.w * q.w);
    expect(dot(o, q0)).toBeCloseTo(dot(o, c), 12);
  });

  it('reads the teleport threshold of a row', () => {
    expect(teleportThresholdOf(undefined)).toBe(2);
    expect(teleportThresholdOf(null)).toBeNull();
    expect(teleportThresholdOf({ teleportThreshold: 5 })).toBe(5);
    expect(teleportThresholdOf({ teleportThreshold: 'x' })).toBe(2);
    expect(teleportThresholdOf({}, 3)).toBe(3);
  });
});

describe('row-spec', () => {
  it('reads pivots and turns them into a shift of the shape', () => {
    expect([pivotOf('feet'), pivotOf('center'), pivotOf('top'), pivotOf([0, 0.5, 0.5]), pivotOf({ x: 1, y: 0, z: 0 }), pivotOf(undefined), pivotOf('left')]).toEqual([
      [0.5, 0, 0.5], [0.5, 0.5, 0.5], [0.5, 1, 0.5], [0, 0.5, 0.5], [1, 0, 0], null, null,
    ]);
    // a 2 × 4 × 0.2 box standing on its bottom centre
    const box = [-1, 0, -0.1, 1, 4, 0.1];
    const o: [number, number, number] = [0, 0, 0];
    expect(pivotShift([0.5, 0, 0.5], box, o)).toEqual([0, 0, 0]);
    expect(pivotShift([0.5, 0.5, 0.5], box, o)).toEqual([0, -2, 0]);
    expect(pivotShift([0, 0.5, 0.5], box, o)).toEqual([1, -2, 0]);
    expect(pivotShift([0.5, 1, 0.5], box, o)).toEqual([0, -4, 0]);
  });

  it('fits a model to its layout: maxExtents makes it exactly that tall, minExtents grows it', () => {
    const size = { x: 1, y: 2, z: 0.5 };
    expect(layoutScale({ maxExtents: { y: 1.8 } }, size)).toBeCloseTo(0.9, 12);
    expect(layoutScale({ maxExtents: { x: 0.5, y: 4 } }, size)).toBeCloseTo(0.5, 12);
    expect(layoutScale({ minExtents: { y: 3 } }, size)).toBeCloseTo(1.5, 12);
    expect(layoutScale({ minExtents: { y: 1.8 }, maxExtents: { y: 1.8 } }, size)).toBeCloseTo(0.9, 12);
    expect([layoutScale(undefined, size), layoutScale({ maxExtents: { y: 2 } }, null), layoutScale({}, size)]).toEqual([1, 1, 1]);
  });

  it('reads what a row draws', () => {
    expect(primitiveSpecOf({ primitive: { kind: 'plane', width: 1, height: 2 }, anchor: 'center' })).toEqual({ kind: 'plane', width: 1, height: 2, anchor: 'center' });
    expect(primitiveSpecOf({ primitive: 'sphere' })).toEqual({ kind: 'sphere' });
    expect(primitiveSpecOf({ primitive: { kind: 'scripted', script: 'scripts/gen/x.js' } })).toBeNull();
    expect(scriptedSpecOf({ primitive: { kind: 'scripted', script: 'scripts/gen/x.js', params: { h: 2 } } })).toMatchObject({ script: 'scripts/gen/x.js', params: { h: 2 } });
    expect(scriptedSpecOf({ primitive: { kind: 'box' } })).toBeNull();
    expect(standardMaterialOf({ material: { color: '#fff' } })).toEqual({ color: '#fff' });
    expect(standardMaterialOf({ material: { kind: 'scripted', script: 'scripts/trail/mat.js' } })).toBeNull();
    expect(isCameraAttached({ feetPosition: { attach: 'camera', x: 0, y: 0, depth: 1 } })).toBe(true);
    expect(isCameraAttached({ feetPosition: { x: 0, y: 0, z: 1 } })).toBe(false);
    expect([attachmentBoneOf({ attachment: { bone: 'Head' } }), attachmentBoneOf({ attachment: { socket: 'sock_muzzle' } }), attachmentBoneOf({})]).toEqual(['Head', 'sock_muzzle', null]);
    expect([physicsBodyOf('static'), physicsBodyOf({ body: 'dynamic' }), physicsBodyOf({ capsule: {} }), physicsBodyOf(undefined), physicsBodyOf('none')]).toEqual(['static', 'dynamic', 'static', null, null]);
    expect([visibleRangeOf({ max: 30 }), visibleRangeOf({ min: 2 }), visibleRangeOf({}), visibleRangeOf(null)]).toEqual([{ min: 0, max: 30 }, { min: 2, max: Infinity }, null, null]);
    expect(isEditorOnly({ props: { visibleTo: 'editors' }, spec: {} })).toBe(true);
    expect(isEditorOnly({ props: {}, spec: { visibleTo: 'all' } })).toBe(false);
  });

  it('reads a light as written: the angle raw, the colour through color.ts, `aim` as a point or "forward"', () => {
    const l = rowLightOf({ aim: { x: 0, y: 0, z: 0 }, angle: 38, color: 'oklch(0.92 0.03 90)', distance: 40, intensity: 60, kind: 'spot', penumbra: 0.5 })!;
    expect(l).toMatchObject({ kind: 'spot', angle: 38, distance: 40, intensity: 60, penumbra: 0.5, decay: 2, aim: { x: 0, y: 0, z: 0 }, shadow: false });
    expect(l.color).toEqual(cssToLinear('oklch(0.92 0.03 90)'));
    expect(rowLightOf({ kind: 'spot', aim: 'forward', shadow: true })).toMatchObject({ aim: 'forward', shadow: true, intensity: 1, distance: 0 });
    expect(rowLightOf({ color: '#ffffff' })).toMatchObject({ kind: 'point', aim: null });
    expect([rowLightOf(null), rowLightOf(undefined), rowLightOf({ kind: 'area' })]).toEqual([null, null, null]);
  });
});
