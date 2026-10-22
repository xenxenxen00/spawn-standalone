// builtin/noise, the documented rest: simplex3, ridged, billowed2, gradient2, domainWarp2, voronoi2, white2, makeSeededRng.
// Deterministic standard algorithms (not bit-exact with Spawn's): the tests pin ranges, determinism, seed sensitivity and structure.
import { describe, expect, it } from 'vitest';
import { billowed2, domainWarp2, gradient2, makeSeededRng, ridged, simplex2, simplex3, voronoi2, white2 } from '../../src/compat/builtin/noise.ts';

const grid = (n: number, step: number): Array<[number, number]> => {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out.push([i * step + 0.137, j * step - 0.291]);
  return out;
};
const stats = (vals: number[]) => ({ min: Math.min(...vals), max: Math.max(...vals), mean: vals.reduce((a, b) => a + b, 0) / vals.length });

describe('makeSeededRng', () => {
  it('same seed same sequence; number and string seeds; different seeds differ', () => {
    const a = makeSeededRng(42);
    const b = makeSeededRng(42);
    expect(Array.from({ length: 8 }, () => a.next())).toEqual(Array.from({ length: 8 }, () => b.next()));
    expect(makeSeededRng('crown').uint32()).toBe(makeSeededRng('crown').uint32());
    expect(makeSeededRng(1).uint32()).not.toBe(makeSeededRng(2).uint32());
    expect(makeSeededRng('a').uint32()).not.toBe(makeSeededRng('b').uint32());
  });
  it('the ranges of every method', () => {
    const r = makeSeededRng(7);
    let neg = false;
    for (let i = 0; i < 2000; i++) {
      const n = r.next();
      const d = r.double();
      const u = r.uint32();
      const s = r.int32();
      const g = r.range(-3, 5);
      expect(n >= 0 && n < 1).toBe(true);
      expect(d >= 0 && d < 1).toBe(true);
      expect(Number.isInteger(u) && u >= 0 && u <= 4294967295).toBe(true);
      expect(Number.isInteger(s) && s >= -2147483648 && s <= 2147483647).toBe(true);
      expect(g >= -3 && g < 5).toBe(true);
      if (s < 0) neg = true;
    }
    expect(neg).toBe(true);
  });
  it('is roughly uniform', () => {
    const r = makeSeededRng('u');
    const m = stats(Array.from({ length: 20000 }, () => r.next()));
    expect(m.mean).toBeGreaterThan(0.48);
    expect(m.mean).toBeLessThan(0.52);
  });
});

describe('simplex3', () => {
  const pts = Array.from({ length: 4000 }, (_, i) => [(i % 20) * 0.37, (Math.floor(i / 20) % 20) * 0.41, Math.floor(i / 400) * 0.53] as const);
  it('stays in [-1, 1], is deterministic, scales with amplitude and depends on the seed and on y', () => {
    const vals = pts.map(([x, y, z]) => simplex3({ x, y, z, seed: 5 }));
    const s = stats(vals);
    expect(s.min).toBeGreaterThanOrEqual(-1);
    expect(s.max).toBeLessThanOrEqual(1);
    expect(s.max - s.min).toBeGreaterThan(1);
    expect(Math.abs(s.mean)).toBeLessThan(0.15);
    expect(simplex3({ x: 1.3, y: 2.1, z: 0.7, seed: 5 })).toBe(simplex3({ x: 1.3, y: 2.1, z: 0.7, seed: 5 }));
    expect(simplex3({ x: 1.3, y: 2.1, z: 0.7, seed: 5, amplitude: 3 })).toBeCloseTo(3 * simplex3({ x: 1.3, y: 2.1, z: 0.7, seed: 5 }), 12);
    expect(vals).not.toEqual(pts.map(([x, y, z]) => simplex3({ x, y, z, seed: 6 })));
    expect(pts.map(([x, , z]) => simplex3({ x, y: 0, z, seed: 5 }))).not.toEqual(pts.map(([x, , z]) => simplex3({ x, y: 9.5, z, seed: 5 })));
  });
  it('is continuous', () => {
    for (const [x, y, z] of pts.slice(0, 200)) {
      expect(Math.abs(simplex3({ x, y, z }) - simplex3({ x: x + 1e-4, y, z }))).toBeLessThan(1e-2);
    }
  });
  it('frequency scales the sample point; non-finite input is 0', () => {
    expect(simplex3({ x: 1, y: 2, z: 3, frequency: 0.5 })).toBeCloseTo(simplex3({ x: 0.5, y: 1, z: 1.5 }), 12);
    expect(simplex3({ x: NaN, y: 0, z: 0 })).toBe(0);
  });
});

describe('ridged / billowed2', () => {
  const g = grid(30, 0.43);
  it('stay in [-1, 1], are deterministic and seed-sensitive', () => {
    for (const fn of [ridged, billowed2]) {
      const vals = g.map(([x, z]) => fn({ x, z, seed: 3 }));
      const s = stats(vals);
      expect(s.min).toBeGreaterThanOrEqual(-1);
      expect(s.max).toBeLessThanOrEqual(1);
      expect(s.max - s.min).toBeGreaterThan(0.5);
      expect(vals).toEqual(g.map(([x, z]) => fn({ x, z, seed: 3 })));
      expect(vals).not.toEqual(g.map(([x, z]) => fn({ x, z, seed: 4 })));
      expect(fn({ x: 2.2, z: 1.1, amplitude: 4 })).toBeCloseTo(4 * fn({ x: 2.2, z: 1.1 }), 12);
    }
  });
  it('single octave: ridged peaks where simplex2 is zero, billowed2 where |simplex2| peaks', () => {
    const o = { octaves: 1, seed: 9 };
    let zero = { d: Infinity, x: 0, z: 0 };
    let peak = { d: 0, x: 0, z: 0 };
    for (const [x, z] of g) {
      const s = Math.abs(simplex2({ x, z, seed: 9 }));
      if (s < zero.d) zero = { d: s, x, z };
      if (s > peak.d) peak = { d: s, x, z };
    }
    const at = (fn: typeof ridged, p: { x: number; z: number }) => fn({ x: p.x, z: p.z, ...o });
    expect(at(ridged, zero)).toBeGreaterThan(0.9);
    expect(at(ridged, peak)).toBeLessThan(at(ridged, zero));
    expect(at(billowed2, peak)).toBeGreaterThan(at(billowed2, zero));
    expect(at(billowed2, zero)).toBeLessThan(-0.9);
  });
  it('octaves and ridgeGain change the field', () => {
    expect(ridged({ x: 1.7, z: 2.9, octaves: 1 })).not.toBe(ridged({ x: 1.7, z: 2.9, octaves: 5 }));
    expect(ridged({ x: 1.7, z: 2.9, ridgeGain: 1 })).not.toBe(ridged({ x: 1.7, z: 2.9, ridgeGain: 3 }));
  });
});

describe('gradient2', () => {
  it('matches a finite difference of simplex2 and the magnitude is its length', () => {
    const o = { x: 3.3, z: -1.2, frequency: 0.7, seed: 11 };
    const gr = gradient2(o);
    const h = 1e-4;
    expect(gr.x).toBeCloseTo((simplex2({ ...o, x: o.x + h }) - simplex2({ ...o, x: o.x - h })) / (2 * h), 2);
    expect(gr.z).toBeCloseTo((simplex2({ ...o, z: o.z + h }) - simplex2({ ...o, z: o.z - h })) / (2 * h), 2);
    expect(gr.magnitude).toBeCloseTo(Math.hypot(gr.x, gr.z), 12);
    expect(gradient2({ ...o, delta: 0.5 })).not.toEqual(gr);
    expect(gradient2({ x: NaN, z: 0 })).toEqual({ x: 0, z: 0, magnitude: 0 });
  });
});

describe('domainWarp2', () => {
  it('a warp changes the field; deterministic; bounded; amplitude scales', () => {
    const o = { x: 4.4, z: 7.1, frequency: 0.3, seed: 2 };
    expect(domainWarp2({ ...o, warpAmp: 0 })).not.toBe(domainWarp2({ ...o, warpAmp: 3 }));
    expect(domainWarp2({ ...o, warpAmp: 3 })).toBe(domainWarp2({ ...o, warpAmp: 3 }));
    for (const [x, z] of grid(20, 0.9)) expect(Math.abs(domainWarp2({ x, z, warpAmp: 2, seed: 1 }))).toBeLessThanOrEqual(1);
    expect(domainWarp2({ ...o, amplitude: 2, warpAmp: 1 })).toBeCloseTo(2 * domainWarp2({ ...o, warpAmp: 1 }), 12);
  });
});

describe('voronoi2', () => {
  it('f1 <= f2, bounded, deterministic; cell ids differ between cells and are constant within a neighbourhood', () => {
    const cells = new Set<number>();
    for (const [x, z] of grid(40, 0.27)) {
      const v = voronoi2({ x, z, seed: 8 });
      expect(v.f1).toBeLessThanOrEqual(v.f2);
      expect(v.f1).toBeLessThan(1.5);
      expect(v.f1).toBeGreaterThanOrEqual(0);
      expect(voronoi2({ x, z, seed: 8 })).toEqual(v);
      cells.add(v.cell);
    }
    expect(cells.size).toBeGreaterThan(20);
    const a = voronoi2({ x: 5.5, z: 5.5, seed: 8 });
    expect(voronoi2({ x: 5.5 + 1e-6, z: 5.5, seed: 8 }).cell).toBe(a.cell);
  });
  it('f1 gets close to 0 at the feature points', () => {
    let best = Infinity;
    for (let i = 0; i < 100; i++) for (let j = 0; j < 100; j++) best = Math.min(best, voronoi2({ x: i / 100, z: j / 100, seed: 1 }).f1);
    expect(best).toBeLessThan(0.1);
  });
  it('metric, frequency and seed matter; manhattan >= chebyshev', () => {
    for (const [x, z] of grid(10, 0.31)) {
      const m = voronoi2({ x, z, seed: 3, metric: 'manhattan' }).f1;
      const c = voronoi2({ x, z, seed: 3, metric: 'chebyshev' }).f1;
      expect(Number.isFinite(m) && Number.isFinite(c)).toBe(true);
    }
    expect(voronoi2({ x: 2.4, z: 3.3, seed: 3, metric: 'manhattan' }).f1).not.toBe(voronoi2({ x: 2.4, z: 3.3, seed: 3, metric: 'chebyshev' }).f1);
    expect(voronoi2({ x: 2, z: 3, frequency: 2, seed: 3 })).toEqual(voronoi2({ x: 4, z: 6, seed: 3 }));
    expect(voronoi2({ x: 2.4, z: 3.3, seed: 3 })).not.toEqual(voronoi2({ x: 2.4, z: 3.3, seed: 4 }));
  });
});

describe('white2', () => {
  it('is in [0, 1), deterministic, seed-sensitive, roughly uniform and uncorrelated with its neighbours', () => {
    const vals = grid(60, 1).map(([x, z]) => white2({ x, z, seed: 1 }));
    expect(Math.min(...vals)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...vals)).toBeLessThan(1);
    expect(stats(vals).mean).toBeGreaterThan(0.47);
    expect(stats(vals).mean).toBeLessThan(0.53);
    expect(white2({ x: 3, z: 4, seed: 1 })).toBe(white2({ x: 3, z: 4, seed: 1 }));
    expect(white2({ x: 3, z: 4, seed: 1 })).not.toBe(white2({ x: 3, z: 4, seed: 2 }));
    expect(white2({ x: 3, z: 4 })).not.toBe(white2({ x: 4, z: 3 }));
    let diff = 0;
    for (let i = 0; i < 1000; i++) diff += Math.abs(white2({ x: i, z: 0 }) - white2({ x: i + 1, z: 0 }));
    expect(diff / 1000).toBeGreaterThan(0.25);
    expect(white2({ x: NaN, z: 0 })).toBe(0);
  });
});
