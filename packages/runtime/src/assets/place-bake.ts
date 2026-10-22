// The PlaceBake file and its reader (docs/architecture.md §3.2, §6.4 step 5, X-06; core §15.9; motion §4.3, §7.2; WP C4).
//
// One file per place, group `map:<p>`, kind `bake` in the asset index: the place's collider pack, its nav grid (null for a place
// baked at load, X-31) and, on mire-island, its terrain bake. `encodePlaceBake` / `decodePlaceBake` are pure and isomorphic: the
// build-time baker (tools/maps/bake-place.ts, MP1) writes with the first, the page and the headless tools read with the second.
// The same input always encodes to the same bytes (fixed deflate level, no timestamps), so a re-run of the bake is byte-identical.
//
// The file is one raw deflate stream (fflate) over this container, little-endian:
//
//   0    'PPBK'
//   4    u32  PLACE_BAKE_FORMAT
//   8    u32  headerBytes
//   12   the header: UTF-8 JSON, padded with spaces to a multiple of 4
//   …    the data: sections back to back, each padded with zeros to a multiple of 4
//
//   header = {
//     v: PLACE_BAKE_FORMAT, place,
//     sections: [{ type: 'f32' | 'u32' | 'u8', offset, length }],   // offset in bytes from the data start, length in elements
//     colliders: {
//       keys: [{ id, tris?: <section f32, 9 per triangle>, box?: [w, h, d] (full size, standing on the origin), sphere?: r (centred at (0, r, 0)) }],
//       rows: [rowId, …],                                           // one per instance, N in all
//       key: <section u32 × N>, m: <section f32 × 12N>,             // the instance's key index and its 3×4 world transform
//       flags: <section u8 × N>,                                    // bit 0 mutable, bit 1 kinematic, bit 2 noDecal (X-45)
//       runtimeKeys: [{ spec, key }],                               // X-43
//       terrain?: { id, tris: <section f32> }                       // mire-island
//               | { id, grid: [originX, originZ] }                  // the soup is `heightGridTriangles` of `terrain` below (MP1)
//     },
//     navgrid: <section u8> | null,                                 // the PPNV block of src/compat/nav/navgrid.ts
//     terrain: { size, cell, materials, heights: <section f32>, weights: <section u8, 6 per vertex> } | null
//   }
// A `<section …>` is an index into `sections`. Decoded arrays are copies with buffers of their own (the inflated file is not
// kept alive; a Float32Array over it would need 4-byte alignment anyway); the instance transforms share one such copy.
//
// The terrain soup (WP MP1). A heightmap place's collision triangles are those of its height grid: 294,912 of them on
// mire-island, 10.6 MB that deflate to 1.8 MB, more than group `map:mire-island` has room for. When `colliders.terrain.tris` is
// bit for bit `heightGridTriangles` of the bake's own `terrain` (the encoder checks), the file carries the grid origin instead
// and the decoder builds the same Float32Array again; any other soup is stored as a section.
//
// `createPlaceBakeReader` is `AssetFactsPort.placeBake`: fetch (or an injected byte loader under Node) + decode, one request per
// place however many callers ask. A resolved bake is held weakly, so it can be collected once the place that used it is unloaded.
// Failures: an HTTP error status, a missing index entry and a file that does not decode are final for the session (asked again,
// the same rejection comes back without a request: no 404 loop, docs/architecture.md §5.6); a network error is not cached, so a
// RETRY fetches again, at most `maxNetworkAttempts` times in all.
import { deflateSync, inflateSync } from 'fflate';
import { emptyPlaceBake } from '../compat/core/null-ports.ts';
import type { ColliderPack, NavGrid, PlaceBake, TerrainBake, TerrainMaterialDef } from '../compat/core/ports.ts';
import { NavGridData, decodeNavGrid, encodeNavGrid } from '../compat/nav/navgrid.ts';
import type { AssetResolver } from './resolver.ts';

export const PLACE_BAKE_FORMAT = 1;

const MAGIC = [0x50, 0x50, 0x42, 0x4b]; // PPBK
const PREFIX_BYTES = 12;
const FLAG_MUTABLE = 1;
const FLAG_KINEMATIC = 2;
const FLAG_NO_DECAL = 4;
/** fixed, so the same bake always deflates to the same bytes */
const DEFLATE_LEVEL = 9;

type SectionType = 'f32' | 'u32' | 'u8';
const ELEMENT_BYTES: Readonly<Record<SectionType, number>> = { f32: 4, u32: 4, u8: 1 };

interface SectionEntry {
  type: SectionType;
  /** bytes from the data start; a multiple of 4 */
  offset: number;
  /** elements */
  length: number;
}

const pad4 = (n: number): number => (n + 3) & ~3;
const LITTLE = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isIndex = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

function fail(place: string, why: string, cause?: unknown): never {
  throw new Error(`PlaceBake ${place}: ${why}`, cause !== undefined ? { cause } : undefined);
}

// ── the terrain soup of a height grid ────────────────────────────────────────────────────────────────────────────────

/**
 * The collision triangles of a height grid (vertex (ix, iz) at (originX + ix·cell, originZ + iz·cell), stored at iz·nx + ix):
 * two per cell, split along the (ix, iz)–(ix+1, iz+1) diagonal exactly as `surfaceAt` (src/compat/core/ctx/heightmap.ts) reads
 * the grid, wound so their normals point up (+Y), cells in row order (z outer, x inner).
 */
export function heightGridTriangles(heights: ArrayLike<number>, nx: number, nz: number, cell: number, originX: number, originZ: number): Float32Array {
  if (!(Number.isInteger(nx) && Number.isInteger(nz) && nx >= 2 && nz >= 2) || heights.length !== nx * nz) {
    throw new Error(`terrain: ${heights.length} heights for a ${nx} × ${nz} grid`);
  }
  const out = new Float32Array((nx - 1) * (nz - 1) * 18);
  let w = 0;
  const put = (ix: number, iz: number): void => {
    out[w++] = originX + ix * cell;
    out[w++] = heights[iz * nx + ix]!;
    out[w++] = originZ + iz * cell;
  };
  for (let iz = 0; iz < nz - 1; iz++) {
    for (let ix = 0; ix < nx - 1; ix++) {
      // fx >= fz: (0,0) (1,1) (1,0); fx < fz: (0,0) (0,1) (1,1)
      put(ix, iz); put(ix + 1, iz + 1); put(ix + 1, iz);
      put(ix, iz); put(ix, iz + 1); put(ix + 1, iz + 1);
    }
  }
  return out;
}

/** the grid origin when `tris` is bit for bit the soup of the terrain bake's height grid, else null */
function derivedTerrainOrigin(tris: Float32Array, t: TerrainBake): [number, number] | null {
  const nx = t.size[0], nz = t.size[1];
  if (!(Number.isInteger(nx) && Number.isInteger(nz) && nx >= 2 && nz >= 2) || t.heights.length !== nx * nz) return null;
  if (tris.length !== (nx - 1) * (nz - 1) * 18 || tris.byteOffset % 4 !== 0) return null;
  const originX = tris[0]!, originZ = tris[2]!;
  if (!isNum(originX) || !isNum(originZ)) return null;
  const want = heightGridTriangles(t.heights, nx, nz, t.cell, originX, originZ);
  const a = new Uint32Array(tris.buffer, tris.byteOffset, tris.length), b = new Uint32Array(want.buffer);
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return null;
  return [originX, originZ];
}

// ── encode ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The file bytes of a bake (the deflated container). Throws, naming the place, on values the format cannot carry. */
export function encodePlaceBake(bake: PlaceBake): Uint8Array {
  const pack = bake.colliders;
  const place = pack.place;
  if (typeof place !== 'string' || place === '') throw new Error('PlaceBake: the collider pack names no place');
  if (!LITTLE) fail(place, 'big-endian hosts are not supported');

  const sections: SectionEntry[] = [];
  const blobs: Uint8Array[] = [];
  let cursor = 0;
  const add = (type: SectionType, data: Float32Array | Uint32Array | Uint8Array): number => {
    sections.push({ type, offset: cursor, length: data.length });
    blobs.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    cursor += pad4(data.byteLength);
    return sections.length - 1;
  };

  const keys = pack.keys.map((k, i) => {
    if (typeof k.id !== 'string') fail(place, `collider key ${i} has no id`);
    const out: Record<string, unknown> = { id: k.id };
    if (k.tris !== undefined) {
      if (!(k.tris instanceof Float32Array) || k.tris.length % 9 !== 0) fail(place, `collider key ${k.id}: tris is not a Float32Array of whole triangles`);
      out['tris'] = add('f32', k.tris);
    }
    if (k.box !== undefined) {
      if (!Array.isArray(k.box) || k.box.length !== 3 || !k.box.every(isNum)) fail(place, `collider key ${k.id}: box is not three finite numbers`);
      out['box'] = [k.box[0], k.box[1], k.box[2]];
    }
    if (k.sphere !== undefined) {
      if (!isNum(k.sphere)) fail(place, `collider key ${k.id}: sphere is not a finite number`);
      out['sphere'] = k.sphere;
    }
    return out;
  });

  const n = pack.instances.length;
  const keyIdx = new Uint32Array(n);
  const m = new Float32Array(n * 12);
  const flags = new Uint8Array(n);
  const rows: string[] = [];
  pack.instances.forEach((inst, i) => {
    if (typeof inst.rowId !== 'string') fail(place, `instance ${i} has no row id`);
    if (!(inst.m instanceof Float32Array) || inst.m.length !== 12) fail(place, `instance ${inst.rowId}: the transform is not a 3×4 Float32Array`);
    if (!isIndex(inst.key) || inst.key >= keys.length) fail(place, `instance ${inst.rowId} names key ${String(inst.key)} of ${keys.length}`);
    rows.push(inst.rowId);
    keyIdx[i] = inst.key;
    m.set(inst.m, i * 12);
    flags[i] = (inst.mutable ? FLAG_MUTABLE : 0) | (inst.kinematic ? FLAG_KINEMATIC : 0) | (inst.noDecal ? FLAG_NO_DECAL : 0);
  });
  const runtimeKeys = pack.runtimeKeys.map((r) => {
    if (typeof r.spec !== 'string' || !isIndex(r.key) || r.key >= keys.length) fail(place, `runtime key ${String(r.spec)} names key ${String(r.key)} of ${keys.length}`);
    return { spec: r.spec, key: r.key };
  });
  const colliders: Record<string, unknown> = { keys, rows, key: add('u32', keyIdx), m: add('f32', m), flags: add('u8', flags), runtimeKeys };
  if (pack.terrain !== undefined) {
    if (!(pack.terrain.tris instanceof Float32Array) || pack.terrain.tris.length % 9 !== 0) fail(place, 'the terrain soup is not a Float32Array of whole triangles');
    const grid = bake.terrain !== null && bake.terrain.heights instanceof Float32Array && Array.isArray(bake.terrain.size) && isNum(bake.terrain.cell)
      ? derivedTerrainOrigin(pack.terrain.tris, bake.terrain)
      : null;
    colliders['terrain'] = grid ? { id: pack.terrain.id, grid } : { id: pack.terrain.id, tris: add('f32', pack.terrain.tris) };
  }

  let navgrid: number | null = null;
  if (bake.navgrid !== null) {
    if (bake.navgrid.h.place !== place) fail(place, `the nav grid is the grid of "${bake.navgrid.h.place}"`);
    navgrid = add('u8', encodeNavGrid(navData(bake.navgrid)));
  }

  let terrain: Record<string, unknown> | null = null;
  if (bake.terrain !== null) {
    const t = bake.terrain;
    if (!(t.heights instanceof Float32Array)) fail(place, 'terrain heights is not a Float32Array');
    if (!(t.weights instanceof Uint8Array) || t.weights.length !== t.heights.length * 6) {
      fail(place, `terrain weights holds ${t.weights?.length} bytes, expected 6 per vertex (${t.heights.length * 6})`);
    }
    if (!Array.isArray(t.size) || t.size.length !== 2 || !t.size.every(isNum) || !isNum(t.cell)) fail(place, 'terrain size or cell is not finite');
    terrain = { size: [t.size[0], t.size[1]], cell: t.cell, materials: t.materials, heights: add('f32', t.heights), weights: add('u8', t.weights) };
  }

  const header = { v: PLACE_BAKE_FORMAT, place, sections, colliders, navgrid, terrain };
  const json = new TextEncoder().encode(JSON.stringify(header));
  const dataStart = PREFIX_BYTES + pad4(json.length);
  const out = new Uint8Array(dataStart + cursor);
  out.set(MAGIC, 0);
  const dv = new DataView(out.buffer);
  dv.setUint32(4, PLACE_BAKE_FORMAT, true);
  dv.setUint32(8, json.length, true);
  out.set(json, PREFIX_BYTES);
  out.fill(0x20, PREFIX_BYTES + json.length, dataStart);
  sections.forEach((s, i) => out.set(blobs[i]!, dataStart + s.offset));
  return deflateSync(out, { level: DEFLATE_LEVEL });
}

/** a NavGrid as the NV1 binary form takes it (a grid that is not NavGridData carries no component links) */
function navData(g: NavGrid): NavGridData {
  return g instanceof NavGridData ? g : new NavGridData(g.h, { colStart: g.colStart, y: g.y, clear: g.clear, slope: g.slope, wall: g.wall, comp: g.comp });
}

// ── decode ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The bake in a file's bytes. `place`, when given, must be the place the file was baked for. Throws an Error starting
 * `PlaceBake <place>: ` on anything that is not a whole, well-formed bake of this format version.
 */
export function decodePlaceBake(bytes: Uint8Array, place?: string): PlaceBake {
  let name = place ?? '(unknown place)';
  if (!LITTLE) fail(name, 'big-endian hosts are not supported');
  let raw: Uint8Array;
  try {
    raw = inflateSync(bytes);
  } catch (e) {
    return fail(name, `not a deflate stream, or a truncated one (${msg(e)})`, e);
  }
  if (raw.length < PREFIX_BYTES) fail(name, `truncated: ${raw.length} bytes`);
  if (MAGIC.some((b, i) => raw[i] !== b)) fail(name, 'bad magic (not a PPBK container)');
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const format = dv.getUint32(4, true);
  if (format !== PLACE_BAKE_FORMAT) fail(name, `format ${format}, expected ${PLACE_BAKE_FORMAT}`);
  const headerBytes = dv.getUint32(8, true);
  const dataStart = PREFIX_BYTES + pad4(headerBytes);
  if (dataStart > raw.length) fail(name, `truncated header (${raw.length} of ${dataStart} bytes)`);
  let header: unknown;
  try {
    header = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.subarray(PREFIX_BYTES, PREFIX_BYTES + headerBytes)));
  } catch (e) {
    return fail(name, `malformed header (${msg(e)})`, e);
  }
  if (!isObj(header)) fail(name, 'malformed header (not an object)');
  if (header['v'] !== PLACE_BAKE_FORMAT) fail(name, `header version ${String(header['v'])}, expected ${PLACE_BAKE_FORMAT}`);
  const filePlace = header['place'];
  if (typeof filePlace !== 'string' || filePlace === '') fail(name, 'the header names no place');
  if (place !== undefined && filePlace !== place) fail(place, `the file is the bake of "${filePlace}"`);
  name = filePlace;

  // the section table
  const table = header['sections'];
  if (!Array.isArray(table)) fail(name, 'the header has no section table');
  const sections: SectionEntry[] = table.map((s: unknown, i: number) => {
    if (!isObj(s) || (s['type'] !== 'f32' && s['type'] !== 'u32' && s['type'] !== 'u8') || !isIndex(s['offset']) || !isIndex(s['length'])) {
      return fail(name, `section ${i} is malformed`);
    }
    const e: SectionEntry = { type: s['type'], offset: s['offset'], length: s['length'] };
    if (e.offset % 4 !== 0) fail(name, `section ${i} is not 4-byte aligned (offset ${e.offset})`);
    const end = dataStart + e.offset + e.length * ELEMENT_BYTES[e.type];
    if (end > raw.length) fail(name, `section ${i} is short: it ends at byte ${end} of ${raw.length}`);
    return e;
  });
  /** a copy of section `ref` as bytes with a buffer of its own */
  const take = (ref: unknown, type: SectionType, what: string): Uint8Array => {
    if (!isIndex(ref) || ref >= sections.length) return fail(name, `${what}: no such section ${String(ref)}`);
    const s = sections[ref]!;
    if (s.type !== type) fail(name, `${what}: section ${ref} is ${s.type}, expected ${type}`);
    const start = dataStart + s.offset;
    return raw.slice(start, start + s.length * ELEMENT_BYTES[type]);
  };
  const f32 = (ref: unknown, what: string): Float32Array => new Float32Array(take(ref, 'f32', what).buffer);
  const u32 = (ref: unknown, what: string): Uint32Array => new Uint32Array(take(ref, 'u32', what).buffer);
  const u8 = (ref: unknown, what: string): Uint8Array => take(ref, 'u8', what);

  // colliders
  const c = header['colliders'];
  if (!isObj(c) || !Array.isArray(c['keys']) || !Array.isArray(c['rows']) || !Array.isArray(c['runtimeKeys'])) fail(name, 'the header has no collider pack');
  const keys: ColliderPack['keys'] = (c['keys'] as unknown[]).map((k, i) => {
    if (!isObj(k) || typeof k['id'] !== 'string') return fail(name, `collider key ${i} is malformed`);
    const out: ColliderPack['keys'][number] = { id: k['id'] };
    if (k['tris'] !== undefined) {
      out.tris = f32(k['tris'], `collider key ${k['id']}`);
      if (out.tris.length % 9 !== 0) fail(name, `collider key ${k['id']}: ${out.tris.length} floats are not whole triangles`);
    }
    if (k['box'] !== undefined) {
      const b = k['box'];
      if (!Array.isArray(b) || b.length !== 3 || !b.every(isNum)) return fail(name, `collider key ${k['id']}: box is not three finite numbers`);
      out.box = [b[0] as number, b[1] as number, b[2] as number];
    }
    if (k['sphere'] !== undefined) {
      if (!isNum(k['sphere'])) return fail(name, `collider key ${k['id']}: sphere is not a finite number`);
      out.sphere = k['sphere'];
    }
    return out;
  });
  const rows = c['rows'] as unknown[];
  const n = rows.length;
  const keyIdx = u32(c['key'], 'instance keys');
  const m = f32(c['m'], 'instance transforms');
  const flags = u8(c['flags'], 'instance flags');
  if (keyIdx.length !== n || m.length !== n * 12 || flags.length !== n) fail(name, `the instance sections do not hold ${n} instances`);
  const instances: ColliderPack['instances'] = rows.map((rowId, i) => {
    if (typeof rowId !== 'string') return fail(name, `instance ${i} has no row id`);
    const key = keyIdx[i]!;
    if (key >= keys.length) fail(name, `instance ${rowId} names key ${key} of ${keys.length}`);
    const f = flags[i]!;
    return {
      rowId,
      key,
      m: m.subarray(i * 12, i * 12 + 12),
      mutable: (f & FLAG_MUTABLE) !== 0,
      kinematic: (f & FLAG_KINEMATIC) !== 0,
      noDecal: (f & FLAG_NO_DECAL) !== 0,
    };
  });
  const runtimeKeys: ColliderPack['runtimeKeys'] = (c['runtimeKeys'] as unknown[]).map((r, i) => {
    if (!isObj(r) || typeof r['spec'] !== 'string' || !isIndex(r['key'])) return fail(name, `runtime key ${i} is malformed`);
    if (r['key'] >= keys.length) fail(name, `runtime key ${r['spec']} names key ${r['key']} of ${keys.length}`);
    return { spec: r['spec'], key: r['key'] };
  });
  const colliders: ColliderPack = { place: name, keys, instances, runtimeKeys };
  /** a terrain soup the file leaves to be built from the terrain bake's height grid */
  let derivedSoup: { id: string; originX: number; originZ: number } | null = null;
  if (c['terrain'] !== undefined) {
    const t = c['terrain'];
    if (!isObj(t) || typeof t['id'] !== 'string') fail(name, 'the terrain soup is malformed');
    if (t['grid'] !== undefined) {
      const g = t['grid'];
      if (!Array.isArray(g) || g.length !== 2 || !g.every(isNum)) return fail(name, 'the terrain soup: grid is not two finite numbers');
      derivedSoup = { id: t['id'], originX: g[0] as number, originZ: g[1] as number };
    } else {
      const tris = f32(t['tris'], 'terrain soup');
      if (tris.length % 9 !== 0) fail(name, `the terrain soup: ${tris.length} floats are not whole triangles`);
      colliders.terrain = { tris, id: t['id'] };
    }
  }

  // nav grid
  let navgrid: NavGrid | null = null;
  if (header['navgrid'] !== null) {
    let grid: NavGridData;
    try {
      grid = decodeNavGrid(u8(header['navgrid'], 'nav grid'));
    } catch (e) {
      return fail(name, `nav grid: ${msg(e).replace(/^PlaceBake [^:]*: /, '')}`, e);
    }
    if (grid.h.place !== name) fail(name, `the nav grid is the grid of "${grid.h.place}"`);
    navgrid = grid;
  }

  // terrain
  let terrain: TerrainBake | null = null;
  if (header['terrain'] !== null) {
    const t = header['terrain'];
    if (!isObj(t) || !Array.isArray(t['size']) || t['size'].length !== 2 || !t['size'].every(isNum) || !isNum(t['cell']) || !Array.isArray(t['materials'])) {
      return fail(name, 'the terrain bake is malformed');
    }
    const heights = f32(t['heights'], 'terrain heights');
    const weights = u8(t['weights'], 'terrain weights');
    if (weights.length !== heights.length * 6) fail(name, `terrain weights holds ${weights.length} bytes, expected 6 per vertex (${heights.length * 6})`);
    terrain = {
      heights,
      size: [t['size'][0] as number, t['size'][1] as number],
      cell: t['cell'],
      weights,
      materials: t['materials'] as TerrainMaterialDef[],
    };
  }
  if (derivedSoup !== null) {
    const nx = terrain?.size[0] ?? 0, nz = terrain?.size[1] ?? 0;
    if (terrain === null || !(Number.isInteger(nx) && Number.isInteger(nz) && nx >= 2 && nz >= 2) || terrain.heights.length !== nx * nz) {
      return fail(name, 'the terrain soup is derived from a height grid, but the file holds no terrain bake of that size');
    }
    colliders.terrain = { tris: heightGridTriangles(terrain.heights, nx, nz, terrain.cell, derivedSoup.originX, derivedSoup.originZ), id: derivedSoup.id };
  }
  return { colliders, navgrid, terrain };
}

// ── the reader (AssetFactsPort.placeBake) ────────────────────────────────────────────────────────────────────────────

export type BakeFetch = (url: string, init?: RequestInit) => Promise<Response>;
export type PlaceBakeReader = (place: string) => Promise<PlaceBake>;

export interface PlaceBakeReaderOptions {
  /** the URL of a place's bake file; null when the build ships none for it */
  url(place: string): string | null;
  /** default: globalThis.fetch */
  fetch?: BakeFetch;
  /** the file's bytes from somewhere else than the network (Node tools read `.cache/assets/out`); used instead of `fetch` */
  load?: (url: string, place: string) => Promise<Uint8Array>;
  /** total attempts for a place whose fetch (or loader) threw, across separate calls; default 3 */
  maxNetworkAttempts?: number;
  /** a place with no bake answers an empty bake (no colliders, no nav grid, no terrain) instead of rejecting; default false */
  allowMissing?: boolean;
  /** a place with no bake, once per place */
  onMissing?: (place: string) => void;
}

interface ReadState {
  inflight: Promise<PlaceBake> | null;
  /** the resolved bake, weakly: the place manager holds it while the place is loaded */
  done: WeakRef<PlaceBake> | null;
  /** a failure that is not retried */
  final: Error | null;
  attempts: number;
}

/** a failure the reader must not retry (an HTTP status, a file that does not decode) */
class FinalBakeError extends Error {}

export function createPlaceBakeReader(o: PlaceBakeReaderOptions): PlaceBakeReader {
  const maxAttempts = Math.max(1, o.maxNetworkAttempts ?? 3);
  const states = new Map<string, ReadState>();
  const reported = new Set<string>();

  const bytesOf = async (url: string, place: string): Promise<Uint8Array> => {
    if (o.load) return o.load(url, place);
    const doFetch: BakeFetch = o.fetch ?? ((u, init) => globalThis.fetch(u, init));
    const res = await doFetch(url, { cache: 'force-cache' });
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined);
      throw new FinalBakeError(`PlaceBake ${place}: HTTP ${res.status} (${url})`);
    }
    return new Uint8Array(await res.arrayBuffer());
  };

  const read = async (place: string, s: ReadState): Promise<PlaceBake> => {
    const url = o.url(place);
    if (url === null) {
      if (!reported.has(place)) {
        reported.add(place);
        o.onMissing?.(place);
      }
      if (o.allowMissing === true) return emptyPlaceBake(place);
      throw new FinalBakeError(`PlaceBake ${place}: no bake in the asset index (group map:${place}, kind bake)`);
    }
    let bytes: Uint8Array;
    try {
      bytes = await bytesOf(url, place);
    } catch (e) {
      if (e instanceof FinalBakeError) throw e;
      s.attempts++;
      const err = new Error(`PlaceBake ${place}: fetch failed: ${msg(e)} (${url})`, { cause: e });
      if (s.attempts >= maxAttempts) throw new FinalBakeError(err.message, { cause: e });
      throw err;
    }
    try {
      return decodePlaceBake(bytes, place);
    } catch (e) {
      throw new FinalBakeError(msg(e), { cause: e });
    }
  };

  return (place) => {
    let s = states.get(place);
    if (!s) {
      s = { inflight: null, done: null, final: null, attempts: 0 };
      states.set(place, s);
    }
    if (s.final !== null) return Promise.reject(s.final);
    if (s.inflight !== null) return s.inflight;
    const hit = s.done?.deref();
    if (hit !== undefined) return Promise.resolve(hit);
    const st = s;
    const run = read(place, st).then(
      (bake) => {
        st.inflight = null;
        st.done = new WeakRef(bake);
        return bake;
      },
      (e: unknown) => {
        st.inflight = null;
        if (e instanceof FinalBakeError) st.final = e;
        throw e;
      },
    );
    st.inflight = run;
    return run;
  };
}

/** The absolute URL of a place's bake: the entry of kind `bake` in group `map:<place>` of the index; null when there is none. */
export function placeBakeUrl(resolver: AssetResolver, place: string): string | null {
  const key = `map:${place}`;
  const groups = resolver.index.groups;
  const group = Object.prototype.hasOwnProperty.call(groups, key) ? groups[key] : undefined;
  if (!group) return null;
  for (const name of group.n) if (resolver.entry(name)?.k === 'bake') return resolver.resolve(name);
  return null;
}

/** `AssetFactsPort.placeBake` over the asset index: `createAssetFactsPort(resolver, createIndexPlaceBakeReader(resolver))`. */
export function createIndexPlaceBakeReader(resolver: AssetResolver, opts: Omit<PlaceBakeReaderOptions, 'url'> = {}): PlaceBakeReader {
  return createPlaceBakeReader({ ...opts, url: (place) => placeBakeUrl(resolver, place) });
}
