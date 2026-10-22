// The scene batch of a place load (docs/design/core-runtime.md §11.2 "Runtime load"; WP C4).
//
// A place chunk (`virtual:ss/place/<p>`, build §3.3.1) carries the place's rows filtered, validated and parent-sorted, each spec
// as authored. `spawnScene` spawns them through the normal spawn path with caller `{kind: 'scene'}` and `fromScene {place, cell}`:
// platform-VM rows, records first. Their onSpawn hooks are the lifecycle's deferred queue, so they run at the following phase
// boundary, after every record of the batch exists (no onSpawn sees a half-built place).
//
// - A row whose id already stands (the Director spawned into the place before it loaded: "dormant without a scene") is a no-op
//   of the lifecycle, not an error: the scene is added around the records that are there.
// - A row the kernel refuses (SpawnRefused), or whose spawn throws, is reported and skipped; the rest of the place still loads.
import type { CoreKernel } from '../kernel.ts';
import { parentScopedId } from '../ids.ts';
import type { PlaceBundle, PlaceId, RowId } from '../types.ts';

export interface SceneSpawnResult {
  /** ids of the rows this batch created, in spawn order (children of a row are not listed) */
  spawned: RowId[];
  /** scene rows whose id already stood */
  existing: RowId[];
  refused: Array<{ id: RowId; error: string }>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

function isBundle(v: unknown): v is PlaceBundle {
  return isObj(v) && typeof v['id'] === 'string' && isObj(v['config']) && Array.isArray(v['rows']);
}

/**
 * The PlaceBundle a chunk loader resolved to: the bundle itself, a module namespace `{ default: bundle }`, or the module
 * namespace `{ default: () => bundle }` resolved by an injected chunk loader; the
 * factory is called once per load, so the module map keeps no parsed rows. Throws when it is none of these, or another place's.
 */
export function asPlaceBundle(v: unknown, place: PlaceId): PlaceBundle {
  const d = isObj(v) && !isBundle(v) ? v['default'] : undefined;
  const made: unknown = typeof d === 'function' ? (d as () => unknown)() : d;
  const bundle = isBundle(v) ? v : isBundle(made) ? made : null;
  if (bundle === null) throw new Error(`places.load: the chunk of "${place}" is not a PlaceBundle`);
  if (bundle.id !== place) throw new Error(`places.load: the chunk of "${place}" holds the bundle of "${bundle.id}"`);
  return bundle;
}

export function spawnScene(k: Pick<CoreKernel, 'lifecycle' | 'store'>, bundle: PlaceBundle): SceneSpawnResult {
  const place = bundle.id;
  const out: SceneSpawnResult = { spawned: [], existing: [], refused: [] };
  for (const row of bundle.rows) {
    const parent = row.spec['parent'];
    const id = typeof parent === 'string' ? parentScopedId(parent, row.id) : row.id;
    const stood = k.store.has(id);
    try {
      const got = k.lifecycle.spawn({ kind: 'scene', place }, row.id, row.spec, { fromScene: { place, cell: row.cell } });
      (stood ? out.existing : out.spawned).push(got);
    } catch (err) {
      out.refused.push({ id: row.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return out;
}
