// K8 `squash` (engine api-reference.md:676): payload defaults, the depth curve, the scale reaching the bridge's drawn object (and
// only that: the simulated scale is untouched), and a negative control (a row with no squash keeps its scale).
import { Group, Object3D, Vector3 } from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import type { BridgeModel, BridgeModels } from '../../../../src/render/bridge/bridge-types.ts';
import { RowSquasher, SQUASH_DEFAULTS, SQUASH_PEAK, squashActOf, squashDepth, squashFactor } from '../../../../src/render/special/squash.ts';
import { rig, TestRow } from '../bridge-fakes.ts';

describe('squash payload', () => {
  it('takes the docs defaults: axis y, intensity 0.3, duration 0.15', () => {
    expect(squashActOf({ target: 'p1' })).toEqual({ target: 'p1', axis: 'y', intensity: 0.3, duration: 0.15 });
    expect(SQUASH_DEFAULTS).toMatchObject({ axis: 'y', intensity: 0.3, duration: 0.15 });
    expect(squashActOf({ target: 'p1', axis: 'x', intensity: 0.5, duration: 0.4 })).toEqual({ target: 'p1', axis: 'x', intensity: 0.5, duration: 0.4 });
    expect(squashActOf({ target: 'p1', axis: 'w', intensity: 'a', duration: -1 })).toEqual({ target: 'p1', axis: 'y', intensity: 0.3, duration: 0.15 });
  });
  it('refuses a payload without a target', () => {
    expect(squashActOf({})).toBeNull();
    expect(squashActOf({ target: '' })).toBeNull();
    expect(squashActOf(null)).toBeNull();
  });
});

describe('squash curve', () => {
  const act = squashActOf({ target: 'p', intensity: 0.4, duration: 1 })!;
  it('shortens the axis by intensity at the deepest point and recovers to 1', () => {
    expect(squashFactor(act, 0).y).toBe(1);
    expect(squashFactor(act, SQUASH_PEAK).y).toBeCloseTo(0.6, 12);
    expect(squashFactor(act, 0.6).y).toBeGreaterThan(0.6);
    expect(squashFactor(act, 0.6).y).toBeLessThan(1);
    expect(squashFactor(act, 1)).toEqual({ x: 1, y: 1, z: 1 });
    expect(squashDepth(act, 2)).toBe(0);
  });
  it('keeps the volume: the other axes bulge by 1/sqrt', () => {
    const f = squashFactor(act, SQUASH_PEAK);
    expect(f.x * f.y * f.z).toBeCloseTo(1, 12);
    expect(f.x).toBeGreaterThan(1);
  });
  it('squashes the named axis only', () => {
    const f = squashFactor(squashActOf({ target: 'p', axis: 'z', intensity: 0.5, duration: 1 })!, SQUASH_PEAK);
    expect(f.z).toBeCloseTo(0.5, 12);
    expect(f.x).toBe(f.y);
  });
  it('never inverts on a huge intensity', () => {
    expect(squashFactor(squashActOf({ target: 'p', intensity: 9, duration: 1 })!, SQUASH_PEAK).y).toBeGreaterThan(0);
  });
});

describe('RowSquasher', () => {
  it('writes a factor each frame, takes it off at the end, and replaces a running squash of the same target', () => {
    const writes: Array<[string, { x: number; y: number; z: number } | null]> = [];
    const s = new RowSquasher({ setRowScale: (id, f) => writes.push([id, f === null ? null : { ...f }]) });
    expect(s.squash({ target: 'a', intensity: 0.5, duration: 0.2 })).toBe(true);
    expect(s.squash({ nope: 1 })).toBe(false);
    expect(s.active).toBe(1);
    s.update(0.05);
    expect(writes.at(-1)![1]!.y).toBeCloseTo(0.5, 9);
    s.squash({ target: 'a', intensity: 0.1, duration: 0.2 });
    expect(s.active).toBe(1);
    s.update(0.25);
    expect(writes.at(-1)).toEqual(['a', null]);
    expect(s.active).toBe(0);
  });
});

function fakeModel(): BridgeModel {
  const root = new Group();
  return { root, bones: new Map<string, Object3D>(), setLayers: () => undefined, setVisible: () => undefined, dispose: () => root.removeFromParent() };
}

const scaleOf = (o: Object3D): number[] => new Vector3().setFromMatrixScale(o.matrix).toArray();

describe('the bridge draws the squash', () => {
  const models: BridgeModels = { create: (row) => (row.props['model'] === undefined ? null : fakeModel()) };
  it('scales the drawn object by the factor and puts it back; a second row is untouched (negative control)', () => {
    const r = rig({ models });
    r.spawn(new TestRow('a', { pos: [0, 0, 0], scale: 2, props: { model: 'x.glb' } }), new TestRow('b', { pos: [3, 0, 0], scale: 2, props: { model: 'x.glb' } }));
    const a = r.bridge.node('a')!.object!;
    const b = r.bridge.node('b')!.object!;
    expect(scaleOf(a)).toEqual([2, 2, 2]);
    r.bridge.setRowScale('a', { x: 1.25, y: 0.64, z: 1.25 });
    r.frame(1);
    expect(scaleOf(a)[0]).toBeCloseTo(2.5, 9);
    expect(scaleOf(a)[1]).toBeCloseTo(1.28, 9);
    expect(scaleOf(b)).toEqual([2, 2, 2]);
    r.bridge.setRowScale('a', null);
    r.frame(1);
    expect(scaleOf(a)).toEqual([2, 2, 2]);
  });
  it('a resting row is re-presented when the factor changes', () => {
    const r = rig({ models });
    r.spawn(new TestRow('a', { pos: [0, 0, 0], props: { model: 'x.glb' } }));
    for (let i = 0; i < 5; i++) r.frame(1);
    const a = r.bridge.node('a')!.object!;
    r.bridge.setRowScale('a', { x: 1, y: 0.5, z: 1 });
    r.frame(1);
    expect(scaleOf(a)[1]).toBeCloseTo(0.5, 9);
  });
});
