// The typed boundary between the port and the live generator modules (render §2.2, §6.2; WP R2).
//
// Live generators (`scripts/gen/**`, `scripts/weapons/gen/**`, authored content) stay unedited JavaScript. They are
// pure functions of `(ctx, params, seed)` called through the `GeometryContext` below; `recorder.ts` builds that context and
// validates what the generators return. This module is dependency-free and engine-free: the boot chunk
// (`geometry-service.ts`), the geometry worker, the Node tools and the place bake (`tools/maps/bake-place.ts`) all import it.

export type LodLevel = 1 | 2 | 3 | 4 | 5;
export const LOD_LEVELS: readonly LodLevel[] = [1, 2, 3, 4, 5];

export function isLodLevel(v: unknown): v is LodLevel {
  return v === 1 || v === 2 || v === 3 || v === 4 || v === 5;
}

/** `[x, y, z]` in metres, the key's local frame (−Z forward, +Y up, origin where it attaches). */
export type Vec3Tuple = [number, number, number];

/**
 * A row's `primitive: { kind: "scripted", script, params, seed }` (`spawn-engine-contract.md` §9.3). `kind` is accepted so a
 * row's primitive object can be passed as is. `params` are copied for every generator run; `seed` defaults to 0.
 */
export interface ScriptedSpec {
  readonly kind?: string | undefined;
  readonly script: string;
  readonly params?: unknown;
  readonly seed?: unknown;
}

export type UvProjection = 'triplanar' | 'planar' | 'cylindrical' | 'spherical';
export const UV_PROJECTIONS: readonly UvProjection[] = ['triplanar', 'planar', 'cylindrical', 'spherical'];

/**
 * What a generator sees (`engine/skills/geometry.md`, render §6.2). A plain, extensible, non-frozen object whose methods are
 * own properties: `polyfy` (authored content) replaces `albedo/color/smooth/roughness/metalness` and calls the
 * originals with `.call(ctx, …)`, generators destructure and `.bind` them, and game scratch fields (`__poly`, `__col`,
 * `__zones`, `__s`, `__shifted`) are written onto it.
 */
export interface GeometryContext {
  params: Record<string, unknown>;
  seed: unknown;
  lod: LodLevel;
  tri: (...v: number[]) => void;
  quad: (...v: number[]) => void;
  flat: () => void;
  smooth: () => void;
  /** `color(css[, alpha])`, or numeric display RGB(A): `color(r, g, b[, alpha])` / `color([r, g, b[, a]])` (K10a) */
  color: (c?: unknown, a?: unknown, b?: unknown, alpha?: unknown) => void;
  emissive: (c?: unknown, g?: unknown, b?: unknown) => void;
  roughness: (v?: unknown) => void;
  metalness: (v?: unknown) => void;
  albedo: (ref?: unknown) => void;
  random: () => number;
  noise2d: (x: number, z: number) => number;
  noise3d: (x: number, y: number, z: number) => number;
  /** K3: `bone(name)` binds the triangles emitted after it to a bone of the module's `skeleton()`; only on runs given a rig (`RecorderOptions.rig`) */
  bone?: (name: string) => void;
  [scratch: string]: unknown;
}

/** `geometry(ctx)` may return nothing, `{ uvs }` (2 floats per emitted vertex), `{ uvProjection }` or, with `RecorderOptions.vertexColors`, `{ colors }` (K10b: r, g, b, a per emitted vertex). */
export type GeometryReturn = void | undefined | null | { uvs?: ArrayLike<number>; uvProjection?: UvProjection; colors?: ArrayLike<number> };

/**
 * `collider(ctx)`: emit a triangle soup and return nothing, return a box (standing on the origin) or a sphere (centred at
 * `(0, r, 0)`), or `null` for none. No `collider` export means the LOD 1 visual triangles.
 */
export type ColliderReturn =
  | void
  | undefined
  | null
  | { kind: 'box'; width: number; height: number; depth: number }
  | { kind: 'sphere'; radius: number };

/** A live generator module as the worker sees it; the return shapes are validated at runtime by `recorder.ts`. */
export interface GeneratorModule {
  geometry(ctx: GeometryContext): unknown;
  collider?(ctx: GeometryContext): unknown;
  /** K3: the module's rigid-bone rig, `{ <bone>: { parent?, pivot } }` (`render/rig/skeleton.ts` parses it) */
  skeleton?(): unknown;
}

export function isGeneratorModule(m: unknown): m is GeneratorModule {
  if (m === null || (typeof m !== 'object' && typeof m !== 'function')) return false;
  const r = m as Record<string, unknown>;
  return (
    typeof r['geometry'] === 'function' &&
    (r['collider'] === undefined || typeof r['collider'] === 'function') &&
    (r['skeleton'] === undefined || typeof r['skeleton'] === 'function')
  );
}

/** A generator's chunk family relative to its host-supplied content root. */
export function generatorChunkFamily(id: string, root: string): string | null {
  const prefix = root.replaceAll('\\', '/').replace(/\/$/, '') + '/';
  const path = id.replaceAll('\\', '/');
  if (!path.startsWith(prefix)) return null;
  const relative = path.slice(prefix.length);
  const slash = relative.indexOf('/');
  return slash < 0 ? 'generators' : 'gen-' + relative.slice(0, slash);
}

/** Tree-rooted script path without a leading `/` or `./` (authored content). */
export function normalizeScript(script: string): string {
  let s = script.trim();
  while (s.startsWith('/') || s.startsWith('./')) s = s.startsWith('/') ? s.slice(1) : s.slice(2);
  return s;
}

/**
 * `JSON.stringify` with object keys sorted at every depth, so two params objects that differ only in key order give one key.
 * Same value rules as JSON: `undefined` members and functions are dropped, `undefined` in arrays and non-finite numbers
 * become `null`.
 */
export function stableJson(v: unknown): string {
  if (v === null || v === undefined) return 'null';
  switch (typeof v) {
    case 'number':
      return Number.isFinite(v) ? JSON.stringify(v) : 'null';
    case 'string':
    case 'boolean':
      return JSON.stringify(v);
    case 'bigint':
      return JSON.stringify(v.toString());
    case 'function':
    case 'symbol':
      return 'null';
    default:
      break;
  }
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined || typeof x === 'function' ? 'null' : stableJson(x))).join(',')}]`;
  if (ArrayBuffer.isView(v)) return stableJson(Array.from(v as unknown as ArrayLike<number>));
  const o = v as Record<string, unknown>;
  const parts: string[] = [];
  for (const k of Object.keys(o).sort()) {
    const x = o[k];
    if (x === undefined || typeof x === 'function' || typeof x === 'symbol') continue;
    parts.push(`${JSON.stringify(k)}:${stableJson(x)}`);
  }
  return `{${parts.join(',')}}`;
}

/**
 * The instancing identity of a scripted primitive: `script + params + seed = ONE mesh` (`engine/skills/geometry.md:36`).
 * `${script}|${stableJson(params ?? {})}|${seed ?? 0}`. The place bake's `ColliderPack.runtimeKeys` (X-43), the geometry
 * service's cache and `gen-hashes.json` all use this one function.
 */
export function keyOf(spec: ScriptedSpec): string {
  const seed = spec.seed === undefined || spec.seed === null ? 0 : spec.seed;
  return `${normalizeScript(spec.script)}|${stableJson(spec.params ?? {})}|${stableJson(seed)}`;
}
