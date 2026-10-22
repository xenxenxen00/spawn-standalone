// The geometry ctx shell (docs/design/core-runtime.md §7.6; contract §9.3; maps §3): what `geometry(ctx)` and `collider(ctx)`
// of a scripted primitive receive. This realm has no rows, no events and no clock: the kernel only defines the shape so every
// realm's ctx is made the same way; the recorder behind it is the geometry domain's (injected), and the same factory runs in
// the geometry workers, in the Node tools and in the place bake.
//
// The ctx is a plain, extensible, non-frozen object whose members are own properties and plain functions:
//   - generators keep them as values and re-bind them (`const r = ctx.random`, `ctx.tri.bind(ctx)`, `ctx.color.call(ctx, …)`:
//     scripts/gen/poly.js replaces `albedo / color / smooth / roughness / metalness` and calls the originals);
//   - game scratch fields (`ctx.__col`, `__zones`, `__poly`, `__s`, `__shifted`) are written onto it.
// `params` is a deep copy per ctx (a generator may edit it), `random()` is seeded by `seed` (the algorithm is the recorder's).
import type { CtxKind } from '../types.ts';
import { cloneWire } from '../wire.ts';

export type GeometryLod = 1 | 2 | 3 | 4 | 5;

/** what the geometry domain supplies: the paint brush, the triangle sink, the seeded random and the noise */
export interface GeometryRecorder {
  /** the next value of the stream seeded by the run's seed */
  random(): number;
  /** 9 floats, counter-clockwise from outside */
  tri(...v: number[]): void;
  /** 12 floats: (p0, p1, p2) + (p0, p2, p3) */
  quad(...v: number[]): void;
  flat(): void;
  smooth(): void;
  color(c?: unknown, a?: unknown): void;
  /** a colour, `(r, g, b)` or null */
  emissive(c?: unknown, g?: unknown, b?: unknown): void;
  roughness(v?: unknown): void;
  metalness(v?: unknown): void;
  albedo(ref?: unknown): void;
  noise2d(x: number, z: number): number;
  noise3d(x: number, y: number, z: number): number;
}

export interface GeometryCtx {
  readonly kind: Extract<CtxKind, 'geometry'>;
  params: Record<string, unknown>;
  seed: number;
  lod: GeometryLod;
  random: () => number;
  tri: (...v: number[]) => void;
  quad: (...v: number[]) => void;
  flat: () => void;
  smooth: () => void;
  color: (c?: unknown, a?: unknown) => void;
  emissive: (c?: unknown, g?: unknown, b?: unknown) => void;
  roughness: (v?: unknown) => void;
  metalness: (v?: unknown) => void;
  albedo: (ref?: unknown) => void;
  noise2d: (x: number, z: number) => number;
  noise3d: (x: number, y: number, z: number) => number;
  /** game scratch fields */
  [scratch: string]: unknown;
}

function deepCopy(params: Record<string, unknown>): Record<string, unknown> {
  try {
    return structuredClone(params);
  } catch {
    // something a structured clone refuses (a function in a hand-made spec): the wire copy drops it
    return (cloneWire(params) ?? {}) as Record<string, unknown>;
  }
}

/** core §7.6 */
export function createGeometryCtx(rec: GeometryRecorder, a: { params: Record<string, unknown>; seed: number; lod: GeometryLod }): GeometryCtx {
  return {
    kind: 'geometry',
    params: deepCopy(a.params ?? {}),
    seed: a.seed,
    lod: a.lod,
    random: () => rec.random(),
    tri: (...v) => rec.tri(...v),
    quad: (...v) => rec.quad(...v),
    flat: () => rec.flat(),
    smooth: () => rec.smooth(),
    color: (c, alpha) => rec.color(c, alpha),
    emissive: (c, g, b) => rec.emissive(c, g, b),
    roughness: (v) => rec.roughness(v),
    metalness: (v) => rec.metalness(v),
    albedo: (ref) => rec.albedo(ref),
    noise2d: (x, z) => rec.noise2d(x, z),
    noise3d: (x, y, z) => rec.noise3d(x, y, z),
  };
}
