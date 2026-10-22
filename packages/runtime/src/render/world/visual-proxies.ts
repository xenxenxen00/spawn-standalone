// The `hits: 'both'` visual proxies of a place (docs/architecture.md X-42; motion §6.2, §13 #4; WP X1b): the render-only
// static geometry of a place as LOD-5 hull soups with one instance transform per row, for `PhysicsPort.setVisualProxies`.
//
// Who holds what: the rows and their presented world matrices are the render bridge's (R13), the hulls are the geometry
// service's (`GeometryService.request(spec, [5])`, one LOD-5 generation per key in the workers; the chunk workers keep the
// merged keys' LOD 5 to themselves, so the keys are asked for again here), and the unit shapes of built-in primitives are
// R3's (`primitiveShape`). So the soup is built where all three meet, after the place's render build.
//
// What becomes a proxy (X-42): every scripted row without `physics`, and every built-in primitive row without `physics`.
// Left out: `visible: false`, `render: false`, rows riding a bone (the probes of an enemy body), rows tagged `bounds`,
// camera-attached rows, editor-only rows, and rows the bridge does not hold (it gives the world matrix).
import type { VisualProxySoup } from '../../compat/core/ports.ts';
import { attachmentBoneOf, isCameraAttached, isEditorOnly, physicsBodyOf, primitiveSpecOf, scriptedSpecOf } from '../bridge/row-spec.ts';
import { keyOf, type LodLevel, type ScriptedSpec } from '../geometry/generator-types.ts';
import { unpackTriangles, type PackedKey } from '../geometry/pack.ts';
import { primitiveShape, type PrimitiveSpec } from '../geometry/primitives.ts';

/** a row as `SceneSyncPort.buildPlace` hands it over (`RowRec` fits) */
export interface ProxyRow {
  readonly id: string;
  readonly tags?: readonly string[];
  readonly props: Readonly<Record<string, unknown>>;
  readonly spec?: Readonly<Record<string, unknown>>;
}

export interface VisualProxyDeps {
  ignoredTags?: readonly string[];
  /** LOD 5 of a key (`GeometryServiceImpl.request`) */
  request(spec: ScriptedSpec, lods: LodLevel[]): Promise<PackedKey>;
  /** the row's world matrix as the bridge presents it, column-major; null: the bridge does not hold the row */
  world(rowId: string): ArrayLike<number> | null;
  log?: (message: string) => void;
}

/** true for a row X-42 leaves out whatever it draws */
function excluded(row: ProxyRow, ignoredTags: readonly string[]): boolean {
  const p = row.props;
  if (p['visible'] === false || p['render'] === false) return true;
  if (physicsBodyOf(p['physics']) !== null) return true;
  if (attachmentBoneOf(p) !== null || isCameraAttached(p)) return true;
  if (row.tags?.some((tag) => ignoredTags.includes(tag)) === true) return true;
  return isEditorOnly({ props: p, spec: row.spec ?? {} });
}

/** the triangles of a built-in primitive's unit geometry, 9 floats each */
function primitiveTriangles(spec: PrimitiveSpec): { key: string; tris: Float32Array; scale: [number, number, number] } | null {
  let shape;
  try {
    shape = primitiveShape(spec);
  } catch {
    return null;
  }
  const geometry = shape.create();
  try {
    const pos = geometry.getAttribute('position');
    const index = geometry.getIndex();
    const n = index === null ? pos.count : index.count;
    const tris = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const v = index === null ? i : index.getX(i);
      tris[i * 3] = pos.getX(v);
      tris[i * 3 + 1] = pos.getY(v);
      tris[i * 3 + 2] = pos.getZ(v);
    }
    return { key: `prim:${shape.geometryKey}`, tris, scale: shape.scale };
  } finally {
    geometry.dispose();
  }
}

/** `world × scale(s)`, column-major */
function scaled(world: ArrayLike<number>, s: readonly [number, number, number]): Float32Array {
  const m = new Float32Array(16);
  for (let c = 0; c < 4; c++) {
    const k = c < 3 ? s[c]! : 1;
    for (let r = 0; r < 4; r++) m[c * 4 + r] = world[c * 4 + r]! * k;
  }
  return m;
}

/**
 * The proxy soup of one place's rows. A key whose LOD 5 cannot be generated is left out with one log line (its rows then
 * answer colliders-only, as before the soup existed); the call itself rejects only when `deps.world` throws.
 */
export async function buildVisualProxies(rows: Iterable<ProxyRow>, deps: VisualProxyDeps): Promise<VisualProxySoup> {
  const log = deps.log ?? ((m: string): void => console.warn(m));
  const specs = new Map<string, ScriptedSpec>();
  const prims = new Map<string, Float32Array>();
  const instances: Array<{ key: string; rowId: string; m: Float32Array }> = [];
  for (const row of rows) {
    if (excluded(row, deps.ignoredTags ?? [])) continue;
    const scripted = scriptedSpecOf(row.props);
    if (scripted !== null) {
      const world = deps.world(row.id);
      if (world === null) continue;
      const key = keyOf(scripted);
      if (!specs.has(key)) specs.set(key, scripted);
      instances.push({ key, rowId: row.id, m: Float32Array.from(world) });
      continue;
    }
    const primitive = primitiveSpecOf(row.props);
    if (primitive === null) continue;
    const world = deps.world(row.id);
    if (world === null) continue;
    const shape = primitiveTriangles(primitive);
    if (shape === null) continue;
    if (!prims.has(shape.key)) prims.set(shape.key, shape.tris);
    instances.push({ key: shape.key, rowId: row.id, m: scaled(world, shape.scale) });
  }

  const keys: Array<{ key: string; tris: Float32Array }> = [];
  await Promise.all(
    [...specs].map(async ([key, spec]) => {
      try {
        const packed = await deps.request(spec, [5]);
        const lod = packed.lods[0];
        if (lod !== undefined) keys.push({ key, tris: unpackTriangles(lod) });
      } catch (e) {
        log(`[proxies] no LOD 5 for ${spec.script}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
  );
  for (const [key, tris] of prims) keys.push({ key, tris });
  const have = new Set(keys.map((k) => k.key));
  return { keys, instances: instances.filter((i) => have.has(i.key)) };
}
