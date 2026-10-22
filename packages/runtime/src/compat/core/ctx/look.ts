// The look, material and heightmap ctx shells (docs/design/core-runtime.md §7.6; contract §8.3, §19, §24). These realms have
// no rows, no events and no clock; the owning domain supplies what stands behind the ctx (injected) and the kernel only fixes
// the shape, so every realm's ctx is made the same way in the browser, the workers and the Node tools.
//
//   look       `look(ctx)` of a postfx look (scripts/looks/*.js): `ctx.scene` is the builder's colour token, `ctx.param(name,
//              default?)` reads the place's `atmosphere.look.params` and tells the builder which names were read
//   material   `material(ctx)` of a node material (authored module reads no param): `ctx.param(name, default?)`
//   heightmap  `heightAt(ctx)` / `materialAt(ctx)` of a terrain generator (scripts/gen/mire-island/terrain.js): `x`, `z`,
//              `noise` (`fbm2`, `simplex2` of builtin/noise), `seedOffset(i)`, and for materialAt `worldHeight`, `slope`,
//              `height01`, `normal`. The types are ctx/heightmap.ts's (MP0), whose HeightmapSamplerImpl builds the same
//              object per vertex; this shell is one point of it, with the sampler reachable as `ctx.sampler`.
import { fbm2, seedOffset, simplex2, type NoiseSeed } from '../../builtin/noise.ts';
import type { CtxKind } from '../types.ts';
import type { HeightmapNoise, HeightmapSampler, MaterialAtCtx } from './heightmap.ts';

/** what a look's builder supplies (the render domain's recorder) */
export interface LookBuilder {
  /** the colour token `ctx.scene` hands to the postfx functions */
  readonly scene: unknown;
  /** told about every `ctx.param` read: the name, the value returned and the script's default */
  onParam?(name: string, value: unknown, def: unknown): void;
}

export interface LookCtx {
  readonly kind: Extract<CtxKind, 'look'>;
  readonly scene: unknown;
  /** `params[name] ?? def` */
  param: (name: string, def?: unknown) => unknown;
}

/** what a material's builder supplies (the render domain's node builder) */
export interface MaterialBuilder {
  onParam?(name: string, value: unknown, def: unknown): void;
  /** engine-provided members a material kind adds to its ctx (none for the one live material) */
  readonly members?: Readonly<Record<string, unknown>>;
}

export interface MaterialCtx {
  readonly kind: Extract<CtxKind, 'material'>;
  param: (name: string, def?: unknown) => unknown;
  [member: string]: unknown;
}

function paramReader(params: Record<string, unknown>, onParam: ((name: string, value: unknown, def: unknown) => void) | undefined): (name: string, def?: unknown) => unknown {
  const table = params ?? {};
  return (name, def) => {
    const own = Object.prototype.hasOwnProperty.call(table, name) ? table[name] : undefined;
    const value = own ?? def;
    onParam?.(name, value, def);
    return value;
  };
}

/** core §7.6: `ctx.param(name, default?)`, `ctx.scene` */
export function createLookCtx(b: LookBuilder, params: Record<string, unknown>): LookCtx {
  return { kind: 'look', scene: b.scene, param: paramReader(params, b.onParam ? (n, v, d) => b.onParam!(n, v, d) : undefined) };
}

/** core §7.6: `ctx.param(name, default?)` */
export function createMaterialCtx(b: MaterialBuilder, params: Record<string, unknown>): MaterialCtx {
  return { ...(b.members ?? {}), kind: 'material', param: paramReader(params, b.onParam ? (n, v, d) => b.onParam!(n, v, d) : undefined) };
}

/** one sample point of a heightmap */
export interface HeightmapPoint {
  x?: number;
  z?: number;
  /** the place's `terrain.seed` (default 0) */
  seed?: NoiseSeed;
  worldHeight?: number;
  slope?: number;
  height01?: number;
  normal?: { x: number; y: number; z: number };
}

export interface HeightmapCtx extends MaterialAtCtx {
  readonly kind: Extract<CtxKind, 'heightmap'>;
  /** the sampler that runs a generator over a grid with this ctx shape */
  readonly sampler: HeightmapSampler;
}

const NOISE: HeightmapNoise = Object.freeze({ fbm2, simplex2 });

/** core §7.6: `x`, `z`, `noise.fbm2`, `seedOffset`, `worldHeight`, `slope` (a flat point at the origin unless `at` says otherwise) */
export function createHeightmapCtx(h: HeightmapSampler, at: HeightmapPoint = {}): HeightmapCtx {
  const seed = at.seed ?? 0;
  return {
    kind: 'heightmap',
    sampler: h,
    x: at.x ?? 0,
    z: at.z ?? 0,
    noise: NOISE,
    seedOffset: (i: number) => seedOffset(seed, i),
    worldHeight: at.worldHeight ?? 0,
    slope: at.slope ?? 0,
    height01: at.height01 ?? 0,
    normal: at.normal ?? { x: 0, y: 1, z: 0 },
  };
}
