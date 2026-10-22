// A runtime producer of `PlaceBake` colliders (X-06), for a game that ships no baked place data: the collider pack of a place
// is built at boot from the place's own scene rows, so a static arena has a floor without `tools/maps/bake-place.ts`.
//
// Every row (children included, at their summed feet positions) with `physics: { body: 'static'|'kinematic', collider: 'mesh' }`
// and a scripted primitive runs its generator's `collider()` through the render recorder (`runCollider`) and becomes one
// instance of the pack, keyed by (script, params, seed) so identical rows share one soup. Rows are only translated: a row with a
// `rotation` or `scale` is refused (`PlaceBakeError`), because a silently missing collider is worse than a loud boot.
// `mutable` follows the pack's documented meaning (the row has a behavior, so scripts may move it or switch its physics off), plus
// any row carrying one of `mutableTags`. The navgrid stays null: the place bakes it at load in a worker (X-31).
//
// Opt-in through `BootEnv.placeBake`; `withRuntimePlaceBake` only fills in a place whose supplied bake holds no colliders.
import { emptyPlaceBake } from '../core/null-ports.ts';
import type { AssetFactsPort, PlaceBake } from '../core/ports.ts';
import type { PlaceId } from '../core/types.ts';
import type { GeneratorModule } from '../../render/geometry/generator-types.ts';
import { runCollider } from '../../render/geometry/recorder.ts';

/** what a collider run answers (structurally `RecordedCollider` of render/geometry/recorder.ts) */
export type BakedCollider =
  | { readonly kind: 'tris'; readonly positions: ArrayLike<number> }
  | { readonly kind: 'box'; readonly size: readonly [number, number, number] }
  | { readonly kind: 'sphere'; readonly radius: number }
  | { readonly kind: 'none' };

export interface ScriptedPrimitive {
  readonly script: string;
  readonly params?: unknown;
  readonly seed?: unknown;
}

export interface BakeRow {
  readonly id: string;
  readonly spec: Readonly<Record<string, any>>;
}

export class PlaceBakeError extends Error {
  override readonly name = 'PlaceBakeError';
}

export interface PlaceBakeOptions {
  /** rows carrying one of these tags are `mutable` instances (in addition to rows with a behavior) */
  mutableTags?: readonly string[] | undefined;
}

const isCollidable = (p: unknown): boolean => {
  if (typeof p !== 'object' || p === null) return false;
  const o = p as { body?: unknown; collider?: unknown };
  return (o.body === 'static' || o.body === 'kinematic') && o.collider === 'mesh';
};
const hasBehavior = (spec: Readonly<Record<string, any>>): boolean => {
  const b = spec['behavior'];
  return typeof b === 'string' ? b !== '' : Array.isArray(b) && b.length > 0;
};

/** the collider pack of `place` from its scene rows; `colliderOf` runs one scripted primitive's collider */
export async function bakePlaceColliders(
  place: PlaceId,
  rows: readonly BakeRow[],
  colliderOf: (prim: ScriptedPrimitive) => Promise<BakedCollider>,
  opts: PlaceBakeOptions = {},
): Promise<PlaceBake> {
  const bake = emptyPlaceBake(place);
  const keyOf = new Map<string, number>();
  const pending: { id: string; at: [number, number, number]; spec: Readonly<Record<string, any>> }[] = [];
  const walk = (spec: Readonly<Record<string, any>>, id: string, at: [number, number, number]): void => {
    const f = (spec['feetPosition'] ?? {}) as { x?: number; y?: number; z?: number };
    const here: [number, number, number] = [at[0] + (f.x ?? 0), at[1] + (f.y ?? 0), at[2] + (f.z ?? 0)];
    const prim = spec['primitive'] as { kind?: unknown; script?: unknown } | undefined;
    if (isCollidable(spec['physics']) && prim?.kind === 'scripted' && typeof prim.script === 'string') {
      if (spec['rotation'] !== undefined || spec['scale'] !== undefined) throw new PlaceBakeError(`place-bake: ${place}/${id} is rotated or scaled; the runtime baker only translates`);
      pending.push({ id, at: here, spec });
    }
    const kids = spec['children'];
    if (Array.isArray(kids)) for (const c of kids as Array<Readonly<Record<string, any>>>) walk(c, `${id}/${String(c['id'] ?? 'child')}`, here);
  };
  for (const r of rows) walk(r.spec, r.id, [0, 0, 0]);
  const mutableTags = new Set(opts.mutableTags ?? []);
  for (const { id, at, spec } of pending) {
    const prim = spec['primitive'] as ScriptedPrimitive;
    const sig = `${prim.script}|${JSON.stringify(prim.params ?? null)}|${JSON.stringify(prim.seed ?? null)}`;
    let key = keyOf.get(sig);
    if (key === undefined) {
      const rec = await colliderOf(prim);
      if (rec.kind === 'none') continue;
      key = bake.colliders.keys.length;
      keyOf.set(sig, key);
      bake.colliders.keys.push(
        rec.kind === 'tris' ? { id: sig, tris: Float32Array.from(rec.positions) } : rec.kind === 'box' ? { id: sig, box: [rec.size[0], rec.size[1], rec.size[2]] } : { id: sig, sphere: rec.radius },
      );
    }
    const tags = Array.isArray(spec['tags']) ? (spec['tags'] as unknown[]) : [];
    bake.colliders.instances.push({
      rowId: id,
      key,
      m: Float32Array.of(1, 0, 0, 0, 1, 0, 0, 0, 1, at[0], at[1], at[2]),
      mutable: hasBehavior(spec) || tags.some((t) => typeof t === 'string' && mutableTags.has(t)),
      kinematic: false,
      noDecal: false,
    });
  }
  return bake;
}

/** the scene rows of a place module: the base runtime's `{ rows }` namespace, or `{ default: { rows } }` (what a bundler plugin serves) */
export function rowsOfPlaceModule(m: unknown): readonly BakeRow[] {
  if (typeof m !== 'object' || m === null) return [];
  const d = (m as { default?: unknown }).default;
  const ns = typeof d === 'object' && d !== null ? d : m;
  const rows = (ns as { rows?: unknown }).rows;
  return Array.isArray(rows) ? (rows as readonly BakeRow[]) : [];
}

const treePath = (p: string): string => p.replace(/^(\.?\/)+/, '');

/**
 * `primary` (the registry), then the game's module index (tree path -> import) for a generator script the registry does not
 * know (a script the game keeps outside its preload sets). A script in neither fails with the primary's error.
 */
export function generatorWithModuleIndex(
  primary: (script: string) => Promise<GeneratorModule>,
  modules: Readonly<Record<string, () => Promise<unknown>>>,
): (script: string) => Promise<GeneratorModule> {
  const byPath = new Map<string, () => Promise<unknown>>();
  for (const [k, v] of Object.entries(modules)) byPath.set(treePath(k), v);
  return async (script) => {
    try {
      return await primary(script);
    } catch (e) {
      const imp = byPath.get(treePath(script));
      if (imp === undefined) throw e;
      return (await imp()) as GeneratorModule;
    }
  };
}

/** `colliderOf` over loaded generator modules (`load(script)`: one import per script, cached) */
export function generatorColliders(load: (script: string) => Promise<GeneratorModule>): (prim: ScriptedPrimitive) => Promise<BakedCollider> {
  const modules = new Map<string, Promise<GeneratorModule>>();
  return async (prim) => {
    if (!modules.has(prim.script)) modules.set(prim.script, load(prim.script));
    const mod = await modules.get(prim.script)!;
    return runCollider(mod, { kind: 'scripted', script: prim.script, params: prim.params, seed: prim.seed }, { strict: true });
  };
}

export interface RuntimePlaceBakeDeps extends PlaceBakeOptions {
  /** the scene rows of a place */
  rows(place: PlaceId): Promise<readonly BakeRow[]>;
  colliderOf(prim: ScriptedPrimitive): Promise<BakedCollider>;
}

/**
 * The assets port with a producer behind it: a place whose supplied bake has colliders is returned as is; one without gets the
 * collider pack built from its rows (once per place). Everything else, `get` included, is the inner port's.
 */
export function withRuntimePlaceBake(inner: AssetFactsPort, deps: RuntimePlaceBakeDeps): AssetFactsPort {
  const made = new Map<PlaceId, Promise<PlaceBake>>();
  return {
    get: (ref) => inner.get(ref),
    async placeBake(place) {
      const supplied = await inner.placeBake(place);
      if (supplied.colliders.instances.length > 0 || supplied.colliders.keys.length > 0) return supplied;
      let built = made.get(place);
      if (built === undefined) {
        built = deps.rows(place).then((rows) => bakePlaceColliders(place, rows, deps.colliderOf, deps));
        made.set(place, built);
        built.catch(() => made.delete(place));
      }
      const colliders = (await built).colliders;
      return { ...supplied, colliders };
    },
  };
}
