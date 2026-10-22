// The isomorphic GeometryContext emulation (render §6.2; WP R2). It runs the live generators unchanged in the geometry
// workers (browser), in the Node tools (`tools/render/geometry-check.ts`) and in the place bake (`tools/maps/bake-place.ts`,
// X-06), so the render meshes, the physics colliders and the nav grid come from one recording. No engine, no DOM, no Node.
//
// A run records raw triangles (float64, emission order) and the raw paint state each face was emitted with; `pack.ts`
// turns a recording into the packed LOD buffers and paint records. Semantics (each cites its source):
//   ctx           a plain, extensible, non-frozen object per run; methods are own properties and closures, so
//                 `const { tri } = ctx`, `tri.bind`, `quad.call` and polyfy's `.call(ctx, …)` all work (`poly.js:205-219`)
//   paint         a stateful brush (`geometry.md:32`): every face captures (colour, alpha, emissive, roughness, metalness,
//                 albedo, flat/smooth). Defaults [I]: `oklch(1 0 0)`, alpha 1, no emissive, roughness 0.85, metalness 0, flat
//   tri / quad    9 / 12 floats, CCW from outside; a quad is (p0, p1, p2) + (p0, p2, p3). Faces draw on both sides
//   smooth runs   `smooth()` after `flat()` (or at the start) opens a new smoothing run; further `smooth()` calls continue it.
//                 kit2 (authored content) does not call polyfy, so its lathes and rounded boxes are smooth live
//   random        mulberry32(seed ^ 0x9E3779B9), restarted for every LOD run and the collider run (`rng.ts`)
//   noise         seedless improved Perlin noise (`noise.ts`)
//   params        a structured clone of `primitive.params` for every run (copied, never shared: `geometry.md:36`)
//   returns       `{ uvs }` (2 floats per emitted vertex: 3 per tri, 4 per quad, authored content T/Q) or
//                 `{ uvProjection }`; `{ normals }`, `{ colors }`, `{ joints, weights }` and anything else are unsupported:
//                 strict runs throw `UnsupportedGeometryReturn`, lenient runs count it and ignore the return value
//   collider      soup (void return) | box standing on the origin | sphere | null | nothing emitted = none; no `collider`
//                 export = the LOD 1 visual triangles (`geometry.md:70`)
import {
  type GeneratorModule,
  type GeometryContext,
  type LodLevel,
  type ScriptedSpec,
  type UvProjection,
  type Vec3Tuple,
  UV_PROJECTIONS,
} from './generator-types.ts';
import { noise2d, noise3d } from './noise.ts';
import type { PoseRig } from '../../compat/motion/pose.ts';
import { attachBoneCursor } from '../rig/bone-recorder.ts';
import { generatorRandom } from './rng.ts';

/** `null` = none; a CSS colour string; or display-value RGB (`emissive(r, g, b)`, decoded by `pack.ts`). */
export type EmissiveValue = null | string | readonly [number, number, number];

export interface RecordedPaint {
  /** the raw `ctx.color` argument (`oklch(…)` in every live call) */
  readonly color: unknown;
  /** the explicit `ctx.color(c, a)` alpha; `undefined` = from the colour string (`oklch(… / a)`) or 1 */
  readonly alpha: number | undefined;
  readonly emissive: EmissiveValue;
  readonly roughness: number;
  readonly metalness: number;
  readonly albedo: string | null;
  readonly smooth: boolean;
}

export const DEFAULT_PAINT: RecordedPaint = Object.freeze({
  color: 'oklch(1 0 0)',
  alpha: undefined,
  emissive: null,
  roughness: 0.85,
  metalness: 0,
  albedo: null,
  smooth: false,
});

/** Triangle origin, needed to map `{ uvs }` (per emitted vertex) onto triangle corners. */
export const SHAPE_TRI = 0;
export const SHAPE_QUAD_A = 1; // (p0, p1, p2)
export const SHAPE_QUAD_B = 2; // (p0, p2, p3)

export interface RecordedMesh {
  readonly lod: LodLevel;
  readonly tris: number;
  /** 9 floats per triangle, emission order */
  readonly positions: Float64Array;
  /** index into `paints` per triangle */
  readonly triPaint: Uint32Array;
  /** SHAPE_* per triangle */
  readonly triShape: Uint8Array;
  /** smoothing run per triangle (0 = flat); null when no face was smooth */
  readonly triRun: Uint32Array | null;
  /** distinct raw paint states, in order of first use */
  readonly paints: readonly RecordedPaint[];
  /** emitted vertices: 3 per tri, 4 per quad (the length unit of a returned `{ uvs }`) */
  readonly emitted: number;
  /** the returned `{ uvs }`, validated: 2 per emitted vertex */
  readonly uvs: Float64Array | null;
  readonly uvProjection: UvProjection;
  /** K10b: the returned `{ colors }`, 4 floats (r, g, b, a; display values like `ctx.color`) per emitted vertex; only with `RecorderOptions.vertexColors` */
  readonly colors?: Float64Array | null;
  /** K3: the rig bone (index into `RecorderOptions.rig`) of every triangle; only on runs given a rig */
  readonly triBone?: Uint16Array | null;
}

export type RecordedCollider =
  | { readonly kind: 'tris'; readonly positions: Float64Array; readonly source: 'collider' | 'visual' }
  | { readonly kind: 'box'; readonly size: Vec3Tuple }
  | { readonly kind: 'sphere'; readonly radius: number }
  | { readonly kind: 'none' };

/** Counters and a few samples of everything unusual a run met (malformed arguments, invalid returns, …). */
export interface Diagnostics {
  counts: Record<string, number>;
  samples: Record<string, string[]>;
}

export function createDiagnostics(): Diagnostics {
  return { counts: {}, samples: {} };
}

const MAX_SAMPLES = 5;

export function noteDiagnostic(diag: Diagnostics | undefined, kind: string, sample?: string): void {
  if (!diag) return;
  diag.counts[kind] = (diag.counts[kind] ?? 0) + 1;
  if (sample === undefined) return;
  const list = (diag.samples[kind] ??= []);
  if (list.length < MAX_SAMPLES && !list.includes(sample)) list.push(sample);
}

export function mergeDiagnostics(into: Diagnostics, from: Diagnostics): void {
  for (const [k, n] of Object.entries(from.counts)) into.counts[k] = (into.counts[k] ?? 0) + n;
  for (const [k, list] of Object.entries(from.samples)) {
    const dst = (into.samples[k] ??= []);
    for (const s of list) if (dst.length < MAX_SAMPLES && !dst.includes(s)) dst.push(s);
  }
}

export interface RecorderOptions {
  /** throw on unsupported returns (dev builds, tools); lenient runs log through `diag` and ignore the return */
  strict?: boolean;
  diag?: Diagnostics;
  /** K10b: accept a returned `{ colors }` (per-vertex RGBA). Default false: `{ colors }` stays an unsupported return, as in the legacy host */
  vertexColors?: boolean;
  /**
   * K3: the rig of the module's `skeleton()` (`render/rig/skeleton.ts` `rigFromSkeleton`). When set, the run's ctx gets
   * `ctx.bone(name)` and the mesh carries `triBone`. Default none: no `ctx.bone`, as in the legacy host
   */
  rig?: PoseRig | null;
}

export class UnsupportedGeometryReturn extends Error {
  override name = 'UnsupportedGeometryReturn';
}

export class InvalidColliderReturn extends Error {
  override name = 'InvalidColliderReturn';
}

function cloneParams(params: unknown, diag: Diagnostics | undefined): Record<string, unknown> {
  if (params === undefined || params === null) return {};
  try {
    return structuredClone(params) as Record<string, unknown>;
  } catch {
    noteDiagnostic(diag, 'paramsClone');
    return JSON.parse(JSON.stringify(params)) as Record<string, unknown>;
  }
}

const describeValue = (v: unknown): string => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array(${v.length})`;
  if (typeof v === 'object') return `{${Object.keys(v as object).join(',')}}`;
  return typeof v;
};

/** One generator run in progress: the ctx handed to the generator and the buffers it fills. */
export interface Recording {
  readonly ctx: GeometryContext;
  /** stop recording; the returned mesh shares the recording's buffers (no copy) */
  take(ret: { uvs: Float64Array | null; uvProjection: UvProjection; colors?: Float64Array | null }): RecordedMesh;
  readonly emitted: () => number;
  readonly tris: () => number;
}

/** Creates the ctx for one run of a generator (one LOD, or the collider run at LOD 1). */
export function createRecording(spec: ScriptedSpec, lod: LodLevel, opts: RecorderOptions = {}): Recording {
  const diag = opts.diag;
  let cap = 1024;
  let positions = new Float64Array(cap * 9);
  let triPaint = new Uint32Array(cap);
  let triShape = new Uint8Array(cap);
  let triRun: Uint32Array | null = null;
  let n = 0;
  let emitted = 0;

  // paint state
  let color: unknown = DEFAULT_PAINT.color;
  let alpha: number | undefined = undefined;
  let emissive: EmissiveValue = null;
  let roughness = DEFAULT_PAINT.roughness;
  let metalness = DEFAULT_PAINT.metalness;
  let albedo: string | null = null;
  let smooth = false;
  let run = 0;
  let runCounter = 0;

  const paints: RecordedPaint[] = [];
  const paintIndex = new Map<string, number>();
  let currentPaint = -1; // -1 = dirty

  const resolvePaint = (): number => {
    const colorKey = typeof color === 'string' ? color : describeValue(color) + JSON.stringify(color ?? null);
    const emKey = emissive === null ? '' : typeof emissive === 'string' ? `s${emissive}` : `n${emissive[0]},${emissive[1]},${emissive[2]}`;
    const key = `${colorKey}\u0001${alpha ?? ''}\u0001${emKey}\u0001${roughness}\u0001${metalness}\u0001${albedo ?? ''}\u0001${smooth ? 1 : 0}`;
    let idx = paintIndex.get(key);
    if (idx === undefined) {
      idx = paints.length;
      paints.push({ color, alpha, emissive, roughness, metalness, albedo, smooth });
      paintIndex.set(key, idx);
    }
    currentPaint = idx;
    return idx;
  };

  const grow = (): void => {
    cap *= 2;
    const p = new Float64Array(cap * 9);
    p.set(positions);
    positions = p;
    const tp = new Uint32Array(cap);
    tp.set(triPaint);
    triPaint = tp;
    const ts = new Uint8Array(cap);
    ts.set(triShape);
    triShape = ts;
    if (triRun) {
      const tr = new Uint32Array(cap);
      tr.set(triRun);
      triRun = tr;
    }
  };

  const push = (
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    shape: number,
  ): void => {
    if (n === cap) grow();
    const o = n * 9;
    positions[o] = x0;
    positions[o + 1] = y0;
    positions[o + 2] = z0;
    positions[o + 3] = x1;
    positions[o + 4] = y1;
    positions[o + 5] = z1;
    positions[o + 6] = x2;
    positions[o + 7] = y2;
    positions[o + 8] = z2;
    triPaint[n] = currentPaint >= 0 ? currentPaint : resolvePaint();
    triShape[n] = shape;
    if (smooth) {
      if (!triRun) triRun = new Uint32Array(cap);
      triRun[n] = run;
    }
    n++;
  };

  /** Slow path for anything but `count` numbers: flatten nested arrays, coerce, pad with NaN (dropped by pack). */
  const coerce = (args: ArrayLike<unknown>, count: number, what: string): number[] => {
    const flat: unknown[] = [];
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (Array.isArray(a)) flat.push(...(a as unknown[]));
      else flat.push(a);
    }
    noteDiagnostic(diag, 'emitArgs', `${spec.script} ${what}(${Array.from(args, describeValue).join(',')})`);
    const out: number[] = [];
    for (let i = 0; i < count; i++) out.push(i < flat.length ? Number(flat[i]) : Number.NaN);
    return out;
  };

  const tri = function (
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
  ): void {
    emitted += 3;
    if (arguments.length !== 9 || typeof x0 !== 'number' || typeof z2 !== 'number') {
      const v = coerce(arguments, 9, 'tri');
      push(v[0]!, v[1]!, v[2]!, v[3]!, v[4]!, v[5]!, v[6]!, v[7]!, v[8]!, SHAPE_TRI);
      return;
    }
    push(x0, y0, z0, x1, y1, z1, x2, y2, z2, SHAPE_TRI);
  };

  const quad = function (
    x0: number, y0: number, z0: number,
    x1: number, y1: number, z1: number,
    x2: number, y2: number, z2: number,
    x3: number, y3: number, z3: number,
  ): void {
    emitted += 4;
    if (arguments.length !== 12 || typeof x0 !== 'number' || typeof z3 !== 'number') {
      const v = coerce(arguments, 12, 'quad');
      push(v[0]!, v[1]!, v[2]!, v[3]!, v[4]!, v[5]!, v[6]!, v[7]!, v[8]!, SHAPE_QUAD_A);
      push(v[0]!, v[1]!, v[2]!, v[6]!, v[7]!, v[8]!, v[9]!, v[10]!, v[11]!, SHAPE_QUAD_B);
      return;
    }
    push(x0, y0, z0, x1, y1, z1, x2, y2, z2, SHAPE_QUAD_A);
    push(x0, y0, z0, x2, y2, z2, x3, y3, z3, SHAPE_QUAD_B);
  };

  const finiteOr = (v: unknown, fallback: number, what: string): number => {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    noteDiagnostic(diag, 'paintArgs', `${spec.script} ${what}(${describeValue(v)})`);
    return fallback;
  };

  const ctx: GeometryContext = {
    params: cloneParams(spec.params, diag),
    seed: spec.seed === undefined || spec.seed === null ? 0 : spec.seed,
    lod,
    tri: tri as GeometryContext['tri'],
    quad: quad as GeometryContext['quad'],
    flat: () => {
      if (smooth) {
        smooth = false;
        currentPaint = -1;
      }
    },
    smooth: () => {
      if (!smooth) {
        smooth = true;
        run = ++runCounter;
        currentPaint = -1;
      }
    },
    color: (c?: unknown, a?: unknown, b?: unknown, al?: unknown) => {
      const num = numericColor(c, a, b, al);
      if (num) {
        // K10a: numeric display RGB(A), kept as a [r, g, b] tuple; `pack.ts` decodes it (PackOptions.colorDecode)
        color = num.rgb;
        alpha = num.alpha === undefined ? undefined : finiteOr(num.alpha, 1, 'color.alpha');
        currentPaint = -1;
        return;
      }
      color = c === undefined ? DEFAULT_PAINT.color : c;
      if (a === undefined || a === null) alpha = undefined;
      else alpha = finiteOr(a, 1, 'color.alpha');
      currentPaint = -1;
    },
    emissive: (c?: unknown, g?: unknown, b?: unknown) => {
      if (c === null || c === undefined) emissive = null;
      else if (typeof c === 'string') emissive = c;
      else if (typeof c === 'number') {
        if (typeof g !== 'number' || typeof b !== 'number') noteDiagnostic(diag, 'emissiveArgs', `${spec.script} emissive(${describeValue(c)},${describeValue(g)},${describeValue(b)})`);
        emissive = [c, typeof g === 'number' ? g : c, typeof b === 'number' ? b : c];
      } else if (Array.isArray(c) && c.length >= 3 && typeof c[0] === 'number') {
        // `ctx.emissive([r, g, b])` (a scene fixture `lib.js:86` passes its `emit` array): display RGB as intended [I]
        emissive = [Number(c[0]), Number(c[1]), Number(c[2])];
      } else {
        noteDiagnostic(diag, 'emissiveArgs', `${spec.script} emissive(${describeValue(c)})`);
        emissive = null;
      }
      currentPaint = -1;
    },
    roughness: (v?: unknown) => {
      roughness = finiteOr(v, DEFAULT_PAINT.roughness, 'roughness');
      currentPaint = -1;
    },
    metalness: (v?: unknown) => {
      metalness = finiteOr(v, DEFAULT_PAINT.metalness, 'metalness');
      currentPaint = -1;
    },
    albedo: (ref?: unknown) => {
      if (ref === null || ref === undefined) albedo = null;
      else if (typeof ref === 'string') albedo = ref;
      else {
        noteDiagnostic(diag, 'albedoArgs', `${spec.script} albedo(${describeValue(ref)})`);
        albedo = null;
      }
      currentPaint = -1;
    },
    random: generatorRandom(spec.seed),
    noise2d: (x: number, z: number) => noise2d(x, z),
    noise3d: (x: number, y: number, z: number) => noise3d(x, y, z),
  };

  return {
    ctx,
    emitted: () => emitted,
    tris: () => n,
    take: (ret) => ({
      lod,
      tris: n,
      positions: positions.subarray(0, n * 9),
      triPaint: triPaint.subarray(0, n),
      triShape: triShape.subarray(0, n),
      triRun: triRun ? triRun.subarray(0, n) : null,
      paints,
      emitted,
      uvs: ret.uvs,
      uvProjection: ret.uvProjection,
      ...(ret.colors ? { colors: ret.colors } : {}),
    }),
  };
}

/**
 * The numeric forms of `ctx.color` (K10a, `geometry.md`; Pip's `ctx.color(r, g, b, a)`): `(r, g, b[, a])` or one
 * array `[r, g, b[, a]]`. Anything else (a CSS string, `(number, alpha)`) stays on the legacy path. Channels are display
 * values; a non-finite channel is 0.
 */
function numericColor(c: unknown, g: unknown, b: unknown, a: unknown): { rgb: [number, number, number]; alpha: unknown } | null {
  const ch = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  if (typeof c === 'number' && typeof g === 'number' && typeof b === 'number') return { rgb: [ch(c), ch(g), ch(b)], alpha: a === null ? undefined : a };
  if (Array.isArray(c) && c.length >= 3 && c.slice(0, 3).every((v) => typeof v === 'number')) {
    return { rgb: [ch(c[0]), ch(c[1]), ch(c[2])], alpha: c.length >= 4 && typeof c[3] === 'number' ? c[3] : g === null ? undefined : g };
  }
  return null;
}

function invalid(strict: boolean | undefined, diag: Diagnostics | undefined, kind: string, err: Error, sample: string): void {
  if (strict) throw err;
  noteDiagnostic(diag, kind, sample);
}

const isThenable = (v: unknown): boolean => v !== null && typeof v === 'object' && typeof (v as { then?: unknown }).then === 'function';

/** Validates a `geometry()` return value: `{ uvs, uvProjection }` or nothing. */
function readGeometryReturn(
  ret: unknown,
  emitted: number,
  spec: ScriptedSpec,
  opts: RecorderOptions,
): { uvs: Float64Array | null; uvProjection: UvProjection; colors?: Float64Array | null } {
  const none = { uvs: null, uvProjection: 'triplanar' as UvProjection };
  if (ret === undefined || ret === null) return none;
  const fail = (why: string): typeof none => {
    invalid(opts.strict, opts.diag, 'invalidReturn', new UnsupportedGeometryReturn(`${spec.script}: ${why}`), `${spec.script}: ${why}`);
    return none;
  };
  if (typeof ret !== 'object' || Array.isArray(ret) || isThenable(ret)) return fail(`geometry() returned ${isThenable(ret) ? 'a promise' : describeValue(ret)}`);
  const r = ret as Record<string, unknown>;
  const extra = Object.keys(r).filter((k) => k !== 'uvs' && k !== 'uvProjection' && !(k === 'colors' && opts.vertexColors) && r[k] !== undefined);
  if (extra.length > 0) return fail(`unsupported return member(s) ${extra.join(', ')}`);
  let uvProjection: UvProjection = 'triplanar';
  if (r['uvProjection'] !== undefined) {
    if (!UV_PROJECTIONS.includes(r['uvProjection'] as UvProjection)) return fail(`unknown uvProjection ${String(r['uvProjection'])}`);
    uvProjection = r['uvProjection'] as UvProjection;
  }
  let uvs: Float64Array | null = null;
  const raw = r['uvs'];
  if (raw !== undefined && raw !== null) {
    const list = raw as ArrayLike<unknown>;
    if (typeof list !== 'object' || typeof list.length !== 'number') return fail(`uvs is ${describeValue(raw)}`);
    if (list.length !== emitted * 2) return fail(`uvs has ${list.length} floats for ${emitted} emitted vertices`);
    uvs = new Float64Array(list.length);
    for (let i = 0; i < list.length; i++) uvs[i] = Number(list[i]);
  }
  let colors: Float64Array | null = null;
  const rawColors = opts.vertexColors ? r['colors'] : undefined;
  if (rawColors !== undefined && rawColors !== null) {
    const list = rawColors as ArrayLike<unknown>;
    if (typeof list !== 'object' || typeof list.length !== 'number') return fail(`colors is ${describeValue(rawColors)}`);
    if (list.length !== emitted * 4) return fail(`colors has ${list.length} floats for ${emitted} emitted vertices (4 each)`);
    colors = new Float64Array(list.length);
    for (let i = 0; i < list.length; i++) {
      const v = Number(list[i]);
      colors[i] = Number.isFinite(v) ? v : 0;
    }
  }
  return colors ? { uvs, uvProjection, colors } : { uvs, uvProjection };
}

/** Runs `geometry(ctx)` once at `lod` and returns the recording. Generator exceptions propagate. */
export function runGeometry(mod: GeneratorModule, spec: ScriptedSpec, lod: LodLevel, opts: RecorderOptions = {}): RecordedMesh {
  const rec = createRecording(spec, lod, opts);
  const cursor = opts.rig ? attachBoneCursor(rec, opts.rig, opts.strict ? { strict: true, script: spec.script } : { script: spec.script }) : null;
  const ret = mod.geometry(rec.ctx);
  const mesh = rec.take(readGeometryReturn(ret, rec.emitted(), spec, opts));
  if (!cursor) return mesh;
  if (cursor.unknown > 0) noteDiagnostic(opts.diag, 'unknownBone', spec.script);
  return { ...mesh, triBone: cursor.triBone(mesh.tris) };
}

const positiveFinite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/** Runs `collider(ctx)` at LOD 1 (or the LOD 1 visual mesh when the module has no `collider` export). */
export function runCollider(mod: GeneratorModule, spec: ScriptedSpec, opts: RecorderOptions = {}): RecordedCollider {
  if (typeof mod.collider !== 'function') {
    const vis = runGeometry(mod, spec, 1, opts);
    return vis.tris > 0 ? { kind: 'tris', positions: vis.positions, source: 'visual' } : { kind: 'none' };
  }
  const rec = createRecording(spec, 1, opts);
  // a rigged generator calls ctx.bone in its collider too; the binding itself is not used (colliders are not skinned)
  if (opts.rig) attachBoneCursor(rec, opts.rig, { script: spec.script });
  const ret = mod.collider(rec.ctx);
  const mesh = rec.take({ uvs: null, uvProjection: 'triplanar' });
  const soup = (): RecordedCollider => (mesh.tris > 0 ? { kind: 'tris', positions: mesh.positions, source: 'collider' } : { kind: 'none' });
  if (ret === undefined) return soup();
  if (ret === null) {
    if (mesh.tris > 0) noteDiagnostic(opts.diag, 'colliderNullWithSoup', spec.script);
    return { kind: 'none' };
  }
  const fail = (why: string): RecordedCollider => {
    invalid(opts.strict, opts.diag, 'invalidCollider', new InvalidColliderReturn(`${spec.script}: ${why}`), `${spec.script}: ${why}`);
    return soup();
  };
  if (typeof ret !== 'object' || isThenable(ret)) return fail(`collider() returned ${describeValue(ret)}`);
  const r = ret as Record<string, unknown>;
  if (mesh.tris > 0) noteDiagnostic(opts.diag, 'colliderShapeWithSoup', spec.script);
  if (r['kind'] === 'box') {
    const w = r['width'];
    const h = r['height'];
    const d = r['depth'];
    if (positiveFinite(w) && positiveFinite(h) && positiveFinite(d)) return { kind: 'box', size: [w, h, d] };
    return fail(`box ${JSON.stringify(r)}`);
  }
  if (r['kind'] === 'sphere') {
    const radius = r['radius'];
    if (positiveFinite(radius)) return { kind: 'sphere', radius };
    return fail(`sphere ${JSON.stringify(r)}`);
  }
  return fail(`collider kind ${String(r['kind'])}`);
}
