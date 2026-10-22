// WP R12a (render §10.7, the old R16): the `shake` act. A decaying jitter of the target row's drawn object through the
// bridge's `setRowOffset`, 0.04 m × intensity at its start, nothing at its end, then the offset is taken off; presentation
// time only (dt 0 holds it), and the row's simulated transform is never written.
import { describe, expect, it } from 'vitest';
import type { Vec3 } from '../../../../src/compat/core/types.ts';
import { RowShaker, SHAKE_AMPLITUDE_M, SHAKE_DEFAULT_S, shakeActOf, shakeOffset } from '../../../../src/render/special/shake.ts';

describe('the act', () => {
  it('reads the live payloads and refuses one without a target', () => {
    expect(shakeActOf({ target: 'door-1', intensity: 0.5, duration: 0.2 })).toEqual({ target: 'door-1', intensity: 0.5, duration: 0.2 });
    expect(shakeActOf({ target: 'e-3' })).toEqual({ target: 'e-3', intensity: 1, duration: SHAKE_DEFAULT_S });
    expect(shakeActOf({ intensity: 1 })).toBeNull();
    expect(shakeActOf({ target: '' })).toBeNull();
  });

  it('stays within the amplitude, decays, and is zero at its end', () => {
    const act = { target: 'r', intensity: 2, duration: 0.5 };
    let peak = 0;
    for (let t = 0; t < 0.5; t += 0.005) {
      const o = shakeOffset(act, t, 0.3);
      const m = Math.max(Math.abs(o.x), Math.abs(o.y), Math.abs(o.z));
      expect(m).toBeLessThanOrEqual(SHAKE_AMPLITUDE_M * 2 + 1e-12);
      if (t < 0.1) peak = Math.max(peak, m);
    }
    expect(peak).toBeGreaterThan(SHAKE_AMPLITUDE_M);
    const late = shakeOffset(act, 0.45, 0.3);
    expect(Math.hypot(late.x, late.y, late.z)).toBeLessThan(SHAKE_AMPLITUDE_M * 2 * 0.02);
    expect(shakeOffset(act, 0.5, 0.3)).toEqual({ x: 0, y: 0, z: 0 });
  });
});

describe('RowShaker', () => {
  it('writes an offset each frame of the shake and takes it off at the end; dt 0 holds it', () => {
    const writes: Array<[string, Vec3 | null]> = [];
    const shaker = new RowShaker({ setRowOffset: (id, o) => writes.push([id, o === null ? null : { ...o }]) });
    expect(shaker.shake({ target: 'door-1', intensity: 1, duration: 0.1 })).toBe(true);
    expect(shaker.active).toBe(1);
    shaker.update(1 / 60);
    const before = writes.at(-1)![1];
    shaker.update(0);
    expect(writes.at(-1)![1]).toEqual(before);
    for (let i = 0; i < 10; i++) shaker.update(1 / 60);
    expect(writes.at(-1)).toEqual(['door-1', null]);
    expect(shaker.active).toBe(0);
    const n = writes.length;
    shaker.update(1 / 60);
    expect(writes).toHaveLength(n);
    expect(shaker.shake({})).toBe(false);
  });

  it('a second shake of a target replaces the first; dispose takes every offset off', () => {
    const offsets = new Map<string, Vec3 | null>();
    const shaker = new RowShaker({ setRowOffset: (id, o) => offsets.set(id, o === null ? null : { ...o }) });
    shaker.shake({ target: 'a', duration: 1 });
    shaker.shake({ target: 'a', duration: 0.05 });
    shaker.shake({ target: 'b', duration: 1 });
    expect(shaker.active).toBe(2);
    shaker.update(0.06);
    expect(offsets.get('a')).toBeNull();
    expect(offsets.get('b')).not.toBeNull();
    shaker.dispose();
    expect(offsets.get('b')).toBeNull();
    expect(shaker.active).toBe(0);
  });
});
