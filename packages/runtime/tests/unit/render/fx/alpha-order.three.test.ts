// The alpha sprite bucket's back-to-front order (src/render/fx/render/buckets.ts `backToFront`, cpu-budget CPU1 1.2): a key
// sort that must give exactly the order of the stable comparator sort it replaced, `(a, b) => depths[b] - depths[a]`.
import { describe, expect, it } from 'vitest';
import { backToFront } from '../../../../src/render/fx/render/buckets.ts';

function reference(depths: Float32Array, count: number): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  return order.sort((a, b) => depths[b]! - depths[a]!);
}

function run(values: readonly number[]): { ok: boolean; order: number[] } {
  const depths = new Float32Array(values);
  const order: number[] = [];
  const ok = backToFront(depths, new Uint32Array(depths.buffer), new Float64Array(4096), order, values.length);
  return { ok, order };
}

describe('fx alpha bucket order', () => {
  it('matches the stable comparator sort on ties, signed zeros, infinities and subnormals', () => {
    let seed = 7;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1103515245) + 12345) | 0;
      return ((seed >>> 8) & 0xffffff) / 0x1000000;
    };
    const pool = [0, -0, 1, -1, 2.5, -2.5, Infinity, -Infinity, 1e-45, -1e-45, 3.4e38, -3.4e38, 0.1, 0.1000001];
    for (let trial = 0; trial < 400; trial++) {
      const n = 1 + Math.floor(rnd() * (trial < 200 ? 40 : 4095));
      const values = Array.from({ length: n }, () => (rnd() < 0.5 ? pool[Math.floor(rnd() * pool.length)]! : (rnd() - 0.5) * 200));
      const { ok, order } = run(values);
      expect(ok).toBe(true);
      expect(order).toEqual(reference(new Float32Array(values), n));
    }
  });

  it('declines (and leaves the order alone) when a depth is NaN or the bucket is past the sort limit', () => {
    const order = [9, 9];
    const depths = new Float32Array([1, Number.NaN, 2]);
    expect(backToFront(depths, new Uint32Array(depths.buffer), new Float64Array(4096), order, 3)).toBe(false);
    expect(order).toEqual([9, 9]);
    const big = new Float32Array(4097);
    expect(backToFront(big, new Uint32Array(big.buffer), new Float64Array(4097), [], 4097)).toBe(false);
  });
});
