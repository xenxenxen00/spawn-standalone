// Packed geometry (render D5, §6.4, §6.6; WP R2): one recording (`recorder.ts`) → one self-contained LOD.
//
//   vtx      indexed, 8 bytes per vertex: int16 x, y, z normalised over the LOD's bbox (q / 32767 · half + centre, the WebGL
//            normalised-SHORT rule, so a mesh transform of (centre, half) dequantises on the GPU) + the local paint id in the
//            same int16 vector as w = id − 32767 (render D5: one Int16Array, itemSize 4, normalised; the vertex stage reads
//            id = round(w · 32767) + 32767). Ids run 0 to 65,534: id 65,535 would need w = 32768
//   idx      Uint16Array up to 65,536 vertices, else Uint32Array; [0, opaqueIndexCount) opaque, the rest transparent
//            (alpha < 1: the no-shadow pass); emission order inside each pass
//   paints   12 floats per local paint, in first-use order: albedo rgb (linear), alpha, emissive rgb (linear, HDR),
//            roughness, metalness, flags (PAINT_FLAG_*), texId (1-based into `textures`, 0 = none), 0
//   normals  only when a face was smooth: int8 x, y, z, 0 per vertex; angle-weighted per smoothing run; flat vertices 0
//   uvs      only when geometry() returned `{ uvs }`: float32 u, v per vertex
//
// Vertices are deduplicated on (quantised position, paint) (+ normal, + uv), so a closed flat box is 8 vertices. Triangles
// with a non-finite corner, or two corners on one quantised position, are dropped (`dropped`). Paints are per LOD (not per
// key as the render §6.4 sketch had them), so each LOD's bytes and hash do not depend on which other LODs were requested.
//
// Colour: OKLCH and #hex convert with exactly the matrices and transfer of authored content (the live game's
// own conversion); emissive display values `emissive(r, g, b)` decode with the sRGB EOTF, which grows as x^2.4 above 1
// (render §5, [CAL `emissiveDecode`] default "srgb-eotf"). R1a's `color/color.ts` must agree with these functions.
import type { LodLevel, UvProjection, Vec3Tuple } from './generator-types.ts';
import type { SkeletonSpec } from '../rig/skeleton.ts';
import { SHAPE_QUAD_B, SHAPE_TRI, type RecordedCollider, type RecordedMesh, type RecordedPaint } from './recorder.ts';

export const VERTEX_STRIDE = 8;
export const PAINT_FLOATS = 12;
export const PAINT_FLAG_SMOOTH = 1;
export const PAINT_FLAG_TRANSPARENT = 2;
export const PAINT_FLAG_TEXTURED = 4;
const QMAX = 32767;
/** render D5: the paint lane holds `id − PAINT_ID_BIAS` */
export const PAINT_ID_BIAS = 32767;
/** local paint ids are 0 to 65,534 */
export const MAX_LOCAL_PAINTS = 65535;

export type EmissiveDecode = 'srgb-eotf' | 'linear';

export interface PackOptions {
  /** [CAL `emissiveDecode`]: how `emissive(r, g, b)` display values become linear; default "srgb-eotf" */
  emissiveDecode?: EmissiveDecode;
  /**
   * K10a: how numeric `ctx.color(r, g, b)` display values become linear albedo. Default "srgb-eotf" (the same display law as
   * `emissive`); "linear" takes the numbers as linear. Channels are clamped to 0..1. Strings are unaffected.
   */
  colorDecode?: EmissiveDecode;
  /**
   * Opt-in: the mean linear rgb of each albedo texture a generator names with `ctx.albedo(name)` (`albedoTintKey(name)`). The
   * packed maps keep the texture names but nothing samples them, so a part on a dark texture (a slate marble square) drew in its
   * bare colour; with a table its colour is multiplied by the texture mean (what the sampled texture averages to). Names missing
   * from the table keep the bare colour. Default absent
   */
  albedoTints?: Readonly<Record<string, readonly [number, number, number]>>;
}

/** the table key of an albedo texture name: no leading slash (`/cdn/x.png` and `cdn/x.png` are one texture) */
export function albedoTintKey(name: string): string { return name.replace(/^\/+/, ''); }

export interface PackedLod {
  lod: LodLevel;
  /** stride 8 (D5): Int16Array, itemSize 4, normalised: x, y, z over the bbox, w = local paint id − 32767 */
  vtx: ArrayBuffer;
  idx: Uint16Array | Uint32Array;
  opaqueIndexCount: number;
  bboxMin: Vec3Tuple;
  bboxMax: Vec3Tuple;
  tris: number;
  vertices: number;
  /** PAINT_FLOATS per local paint */
  paints: Float32Array;
  /** albedo texture refs named by `texId` (1-based); empty on every poly map */
  textures: string[];
  /** int8 x, y, z, 0 per vertex; only when a face was smooth */
  normals?: Int8Array;
  /** float32 u, v per vertex; only when geometry() returned `{ uvs }` */
  uvs?: Float32Array;
  /** K10b: float32 r, g, b, a per vertex (linear rgb via `PackOptions.colorDecode`, alpha as given); only when geometry() returned `{ colors }` */
  colors?: Float32Array;
  /**
   * K3: the rig bone of every vertex (rigid skinning: one joint, weight 1); only when the recording carried `triBone`
   * (`RecorderOptions.rig`). Vertices are never shared, and normals never smoothed, across two bones
   */
  skinIndex?: Uint8Array;
  uvProjection: UvProjection;
  /** recorded triangles dropped as degenerate or non-finite */
  dropped: number;
  /** generator + pack time of this LOD, ms */
  ms: number;
}

/** What a collider run gives physics (motion §4.3 `ColliderPack.keys`): local space, box on the origin, sphere at (0, r, 0). */
export type PackedCollider = { tris: Float32Array } | { box: Vec3Tuple } | { sphere: number } | null;

export interface PackedKey {
  /** `keyOf(spec)` */
  key: string;
  script: string;
  /** in the order requested */
  lods: PackedLod[];
  /** present when the job asked for the collider */
  collider?: PackedCollider;
  colliderMs?: number;
  /** K3: the parsed `skeleton()` of a rigged module (one per script; the main thread builds its RigDef once per script) */
  skeleton?: SkeletonSpec;
  /** job time (all LODs + collider), ms */
  ms: number;
}

// ── colour ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const OKLCH_RE = /oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)/;

/** `poly.js` `oklchToLin`: OKLCH → linear sRGB, negative channels clamped to 0; null when the string is not oklch(L C H). */
export function oklchToLinear(s: string): Vec3Tuple | null {
  const m = OKLCH_RE.exec(s);
  if (!m) return null;
  const L = parseFloat(m[1]!) / (m[2] ? 100 : 1);
  const C = parseFloat(m[3]!);
  const h = (parseFloat(m[4]!) * Math.PI) / 180;
  const a = C * Math.cos(h);
  const b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const mm = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const ss = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    Math.max(0, 4.0767416621 * l - 3.3077115913 * mm + 0.2309699292 * ss),
    Math.max(0, -1.2684380046 * l + 2.6097574011 * mm - 0.3413193965 * ss),
    Math.max(0, -0.0041960863 * l - 0.7034186147 * mm + 1.707614701 * ss),
  ];
}

const srgbToLinear = (v: number): number => (v > 0.04045 ? ((v + 0.055) / 1.055) ** 2.4 : v / 12.92);

/** `poly.js` `hexToLin` for #rrggbb (sRGB EOTF per channel); also #rgb and #rrggbbaa (alpha ignored here). */
export function hexToLinear(s: string): Vec3Tuple | null {
  let m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(s.trim());
  let hex = m?.[1];
  if (!hex) {
    m = /^#([0-9a-f]{3})$/i.exec(s.trim());
    if (!m) return null;
    hex = m[1]!.replace(/./g, (c) => c + c);
  }
  const ch = (i: number): number => srgbToLinear(parseInt(hex.slice(i, i + 2), 16) / 255);
  return [ch(0), ch(2), ch(4)];
}

const RGB_RE = /^rgba?\(\s*([\d.]+)(%?)[\s,]+([\d.]+)(%?)[\s,]+([\d.]+)(%?)/i;
const NAMED: Readonly<Record<string, string>> = { white: '#ffffff', black: '#000000', red: '#ff0000', green: '#008000', blue: '#0000ff' };

/** CSS colour → linear sRGB: oklch(…) and #hex exactly as `poly.js`; rgb()/rgba() and a few names for completeness. */
export function cssToLinear(c: unknown): Vec3Tuple | null {
  if (typeof c !== 'string') return null;
  const s = c.trim();
  if (s.startsWith('oklch')) return oklchToLinear(s);
  if (s.startsWith('#')) return hexToLinear(s);
  const rgb = RGB_RE.exec(s);
  if (rgb) {
    const ch = (v: string, pct: string): number => srgbToLinear(Math.min(1, parseFloat(v) / (pct ? 100 : 255)));
    return [ch(rgb[1]!, rgb[2]!), ch(rgb[3]!, rgb[4]!), ch(rgb[5]!, rgb[6]!)];
  }
  const named = NAMED[s.toLowerCase()];
  return named ? hexToLinear(named) : null;
}

/** The alpha a CSS colour string carries (`oklch(L C H / a)`, `#rrggbbaa`, `rgba(…, a)`), else undefined. */
export function cssAlpha(c: unknown): number | undefined {
  if (typeof c !== 'string') return undefined;
  const s = c.trim();
  const slash = /\/\s*([\d.]+)(%?)\s*\)/.exec(s);
  if (slash) return Math.min(1, Math.max(0, parseFloat(slash[1]!) / (slash[2] ? 100 : 1)));
  const hex8 = /^#[0-9a-f]{6}([0-9a-f]{2})$/i.exec(s);
  if (hex8) return parseInt(hex8[1]!, 16) / 255;
  const rgba = /^rgba\(\s*[\d.]+%?[\s,]+[\d.]+%?[\s,]+[\d.]+%?[\s,]+([\d.]+)(%?)/i.exec(s);
  if (rgba) return Math.min(1, Math.max(0, parseFloat(rgba[1]!) / (rgba[2] ? 100 : 1)));
  return undefined;
}

/** An emissive display value → linear (render §5): the sRGB EOTF applied to the raw number (HDR above 1), clamped at 0. */
export function decodeDisplay(v: number, law: EmissiveDecode = 'srgb-eotf'): number {
  if (!Number.isFinite(v) || v <= 0) return 0;
  return law === 'linear' ? v : srgbToLinear(v);
}

const WHITE: Vec3Tuple = [1, 1, 1];
const BLACK: Vec3Tuple = [0, 0, 0];

/** A numeric `[r, g, b]` display colour (K10a) → linear albedo; null for anything else. */
export function numericToLinear(c: unknown, law: EmissiveDecode = 'srgb-eotf'): Vec3Tuple | null {
  if (!Array.isArray(c) || c.length < 3 || typeof c[0] !== 'number') return null;
  const ch = (v: unknown): number => {
    const x = typeof v === 'number' && Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0;
    return law === 'linear' ? x : srgbToLinear(x);
  };
  return [ch(c[0]), ch(c[1]), ch(c[2])];
}

/** Writes the 12-float record of a raw paint state; returns whether it is transparent. */
export function writePaintRecord(p: RecordedPaint, out: Float32Array, o: number, texId: number, opts: PackOptions = {}): boolean {
  let albedo = numericToLinear(p.color, opts.colorDecode ?? 'srgb-eotf') ?? cssToLinear(p.color) ?? WHITE;
  const tint = p.albedo === null || opts.albedoTints === undefined ? undefined : opts.albedoTints[albedoTintKey(p.albedo)];
  if (tint !== undefined) albedo = [albedo[0] * tint[0], albedo[1] * tint[1], albedo[2] * tint[2]];
  let alpha = p.alpha ?? cssAlpha(p.color) ?? 1;
  alpha = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  let em: Vec3Tuple = BLACK;
  if (typeof p.emissive === 'string') em = cssToLinear(p.emissive) ?? BLACK;
  else if (p.emissive !== null) {
    const law = opts.emissiveDecode ?? 'srgb-eotf';
    em = [decodeDisplay(p.emissive[0], law), decodeDisplay(p.emissive[1], law), decodeDisplay(p.emissive[2], law)];
  }
  const transparent = alpha < 1;
  out[o] = albedo[0];
  out[o + 1] = albedo[1];
  out[o + 2] = albedo[2];
  out[o + 3] = alpha;
  out[o + 4] = em[0];
  out[o + 5] = em[1];
  out[o + 6] = em[2];
  out[o + 7] = p.roughness;
  out[o + 8] = p.metalness;
  out[o + 9] = (p.smooth ? PAINT_FLAG_SMOOTH : 0) | (transparent ? PAINT_FLAG_TRANSPARENT : 0) | (texId > 0 ? PAINT_FLAG_TEXTURED : 0);
  out[o + 10] = texId;
  out[o + 11] = 0;
  return transparent;
}

// ── integer-key hash table (open addressing over fixed-width uint32 keys), reused across calls ───────────────────────

function mix(h: number): number {
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  return h ^ (h >>> 16);
}

class KeyTable {
  words = 2;
  count = 0;
  private bits = 0;
  private slots = new Int32Array(0); // entry index + 1; 0 = empty
  keys = new Uint32Array(0);

  reset(maxEntries: number, words: number): void {
    let bits = 10;
    while (1 << bits < maxEntries * 2) bits++;
    if (bits !== this.bits) {
      this.bits = bits;
      this.slots = new Int32Array(1 << bits);
    } else this.slots.fill(0);
    if (this.keys.length < maxEntries * words) this.keys = new Uint32Array(Math.max(maxEntries * words, this.keys.length * 2));
    this.words = words;
    this.count = 0;
  }

  /** The entry index of key `k` (first `words` words), inserting it when new; `isNew` tells which. */
  find(k: Uint32Array): number {
    const words = this.words;
    let h = 0x9e3779b9;
    for (let i = 0; i < words; i++) h = mix(h ^ k[i]!) + i;
    const mask = (1 << this.bits) - 1;
    let slot = mix(h) & mask;
    const slots = this.slots;
    const keys = this.keys;
    for (;;) {
      const e = slots[slot]!;
      if (e === 0) {
        const idx = this.count++;
        slots[slot] = idx + 1;
        const base = idx * words;
        for (let i = 0; i < words; i++) keys[base + i] = k[i]!;
        this.isNew = true;
        return idx;
      }
      const base = (e - 1) * words;
      let same = true;
      for (let i = 0; i < words; i++) {
        if (keys[base + i] !== k[i]) {
          same = false;
          break;
        }
      }
      if (same) {
        this.isNew = false;
        return e - 1;
      }
      slot = (slot + 1) & mask;
    }
  }

  isNew = false;
}

// ── scratch, reused across calls (packing is synchronous) ────────────────────────────────────────────────────────────

const vertexTable = new KeyTable();
const groupTable = new KeyTable();
let qScratch = new Int32Array(0); // quantised corners, 9 per triangle
let normalScratch = new Float64Array(0); // accumulated normals per smoothing group
let cornerScratch = new Int32Array(0); // smoothing group per corner, -1 = flat
const keyScratch = new Uint32Array(12); // 2 position/paint + normal + 2 uv + 4 colour + bone

/** The angle between two vectors (0 when either is zero). */
function angleBetween(ux: number, uy: number, uz: number, wx: number, wy: number, wz: number): number {
  const lu = Math.hypot(ux, uy, uz);
  const lw = Math.hypot(wx, wy, wz);
  if (lu === 0 || lw === 0) return 0;
  const cos = (ux * wx + uy * wy + uz * wz) / (lu * lw);
  return Math.acos(cos > 1 ? 1 : cos < -1 ? -1 : cos);
}
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
const f32bits = (v: number): number => {
  f32[0] = v;
  return u32[0]!;
};

function emptyLod(rec: RecordedMesh, dropped: number): PackedLod {
  return {
    lod: rec.lod,
    vtx: new ArrayBuffer(0),
    idx: new Uint16Array(0),
    opaqueIndexCount: 0,
    bboxMin: [0, 0, 0],
    bboxMax: [0, 0, 0],
    tris: 0,
    vertices: 0,
    paints: new Float32Array(0),
    textures: [],
    uvProjection: rec.uvProjection,
    dropped,
    ms: 0,
    ...(rec.triBone ? { skinIndex: new Uint8Array(0) } : {}),
  };
}

/** Packs one recorded LOD (see the header for the format). Deterministic: the same recording gives the same bytes. */
export function packMesh(rec: RecordedMesh, opts: PackOptions = {}): PackedLod {
  const n = rec.tris;
  const P = rec.positions;

  // 1. valid triangles and the bbox
  const valid = new Uint8Array(n);
  let min0 = Infinity, min1 = Infinity, min2 = Infinity;
  let max0 = -Infinity, max1 = -Infinity, max2 = -Infinity;
  let validCount = 0;
  for (let t = 0; t < n; t++) {
    const o = t * 9;
    let ok = true;
    for (let i = 0; i < 9; i++) {
      if (!Number.isFinite(P[o + i]!)) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    valid[t] = 1;
    validCount++;
    for (let c = 0; c < 9; c += 3) {
      const x = P[o + c]!, y = P[o + c + 1]!, z = P[o + c + 2]!;
      if (x < min0) min0 = x;
      if (x > max0) max0 = x;
      if (y < min1) min1 = y;
      if (y > max1) max1 = y;
      if (z < min2) min2 = z;
      if (z > max2) max2 = z;
    }
  }
  if (validCount === 0) return emptyLod(rec, n);
  const c0 = (min0 + max0) / 2, c1 = (min1 + max1) / 2, c2 = (min2 + max2) / 2;
  const h0 = (max0 - min0) / 2, h1 = (max1 - min1) / 2, h2 = (max2 - min2) / 2;
  const s0 = h0 > 0 ? QMAX / h0 : 0, s1 = h1 > 0 ? QMAX / h1 : 0, s2 = h2 > 0 ? QMAX / h2 : 0;
  const quant = (v: number, c: number, s: number): number => {
    const q = Math.round((v - c) * s);
    return q > QMAX ? QMAX : q < -QMAX ? -QMAX : q;
  };

  // 2. quantise every corner of the valid triangles
  if (qScratch.length < n * 9) qScratch = new Int32Array(Math.max(n * 9, qScratch.length * 2));
  const Q = qScratch;
  for (let t = 0; t < n; t++) {
    if (!valid[t]) continue;
    const o = t * 9;
    for (let c = 0; c < 9; c += 3) {
      Q[o + c] = quant(P[o + c]!, c0, s0);
      Q[o + c + 1] = quant(P[o + c + 1]!, c1, s1);
      Q[o + c + 2] = quant(P[o + c + 2]!, c2, s2);
    }
  }

  // 3. paint records per raw paint (deduped by their float bits later) and transparency
  const rawCount = rec.paints.length;
  const rawRecords = new Float32Array(rawCount * PAINT_FLOATS);
  const rawTransparent = new Uint8Array(rawCount);
  const textures: string[] = [];
  for (let r = 0; r < rawCount; r++) {
    const p = rec.paints[r]!;
    let texId = 0;
    if (p.albedo !== null) {
      let i = textures.indexOf(p.albedo);
      if (i < 0) i = textures.push(p.albedo) - 1;
      texId = i + 1;
    }
    rawTransparent[r] = writePaintRecord(p, rawRecords, r * PAINT_FLOATS, texId, opts) ? 1 : 0;
  }
  const rawBits = new Uint32Array(rawRecords.buffer);
  const rawToLocal = new Int32Array(rawCount).fill(-1);
  const recordToLocal = new Map<string, number>();
  const localRecords: number[] = []; // raw index per local paint

  // 4. smooth normals: angle-weighted face normals summed per (smoothing run, quantised position)
  const triRun = rec.triRun;
  const triBone = rec.triBone ?? null;
  if (triBone) for (let t = 0; t < n; t++) if (triBone[t]! > 255) throw new RangeError(`packMesh: bone ${triBone[t]} of a rigid rig (at most 256 bones)`);
  if (triRun) {
    groupTable.reset(n * 3, triBone ? 4 : 3);
    if (normalScratch.length < n * 9) normalScratch = new Float64Array(Math.max(n * 9, normalScratch.length * 2));
    if (cornerScratch.length < n * 3) cornerScratch = new Int32Array(Math.max(n * 3, cornerScratch.length * 2));
    const acc = normalScratch;
    const corner = cornerScratch;
    const gk = keyScratch;
    for (let t = 0; t < n; t++) {
      corner[t * 3] = corner[t * 3 + 1] = corner[t * 3 + 2] = -1;
      const run = triRun[t]!;
      if (run === 0 || !valid[t]) continue;
      const o = t * 9;
      const ax = P[o]!, ay = P[o + 1]!, az = P[o + 2]!;
      const bx = P[o + 3]!, by = P[o + 4]!, bz = P[o + 5]!;
      const cx = P[o + 6]!, cy = P[o + 7]!, cz = P[o + 8]!;
      let nx = (by - ay) * (cz - az) - (bz - az) * (cy - ay);
      let ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
      let nz = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
      const len = Math.hypot(nx, ny, nz);
      if (len === 0) continue;
      nx /= len;
      ny /= len;
      nz /= len;
      for (let c = 0; c < 3; c++) {
        let angle: number;
        if (c === 0) angle = angleBetween(bx - ax, by - ay, bz - az, cx - ax, cy - ay, cz - az);
        else if (c === 1) angle = angleBetween(cx - bx, cy - by, cz - bz, ax - bx, ay - by, az - bz);
        else angle = angleBetween(ax - cx, ay - cy, az - cz, bx - cx, by - cy, bz - cz);
        const qo = o + c * 3;
        gk[0] = run;
        gk[1] = (Q[qo]! & 0xffff) | (Q[qo + 1]! << 16);
        gk[2] = Q[qo + 2]! & 0xffff;
        if (triBone) gk[3] = triBone[t]!; // K3: never average a normal over two parts that move apart
        const g = groupTable.find(gk);
        if (groupTable.isNew) acc[g * 3] = acc[g * 3 + 1] = acc[g * 3 + 2] = 0;
        acc[g * 3] = acc[g * 3]! + nx * angle;
        acc[g * 3 + 1] = acc[g * 3 + 1]! + ny * angle;
        acc[g * 3 + 2] = acc[g * 3 + 2]! + nz * angle;
        corner[t * 3 + c] = g;
      }
    }
  }
  /** int8 x, y, z of a smoothing group's normal packed into the low 24 bits; 0 for flat corners */
  const normalOf = (g: number): number => {
    if (g < 0) return 0;
    const acc = normalScratch;
    const x = acc[g * 3]!, y = acc[g * 3 + 1]!, z = acc[g * 3 + 2]!;
    const l = Math.hypot(x, y, z);
    if (l === 0) return 0;
    const ix = Math.round((x / l) * 127), iy = Math.round((y / l) * 127), iz = Math.round((z / l) * 127);
    return (ix & 0xff) | ((iy & 0xff) << 8) | ((iz & 0xff) << 16);
  };

  // 5. emitted-vertex base per triangle for `{ uvs }`
  const uvsIn = rec.uvs;
  const colorsIn = rec.colors ?? null;
  let colorLin: Float32Array | null = null;
  if (colorsIn) {
    const law = opts.colorDecode ?? 'srgb-eotf';
    colorLin = new Float32Array(colorsIn.length);
    for (let i = 0; i < colorsIn.length; i += 4) {
      for (let c = 0; c < 3; c++) {
        const x = colorsIn[i + c]!;
        const cl = x < 0 ? 0 : x > 1 ? 1 : x;
        colorLin[i + c] = law === 'linear' ? cl : srgbToLinear(cl);
      }
      const a = colorsIn[i + 3]!;
      colorLin[i + 3] = a < 0 ? 0 : a > 1 ? 1 : a;
    }
  }
  let triBase: Uint32Array | null = null;
  if (uvsIn || colorsIn) {
    triBase = new Uint32Array(n);
    let e = 0;
    for (let t = 0; t < n; t++) {
      triBase[t] = e;
      const shape = rec.triShape[t]!;
      if (shape === SHAPE_TRI) e += 3;
      else if (shape === SHAPE_QUAD_B) e += 4;
    }
  }
  const cornerEmit = (t: number, k: number): number => {
    const base = triBase![t]!;
    const shape = rec.triShape[t]!;
    if (shape === SHAPE_QUAD_B) return base + (k === 0 ? 0 : k + 1); // (p0, p2, p3)
    return base + k; // tri, or (p0, p1, p2) of a quad
  };

  // 6. dedupe vertices and emit indices: opaque pass, then transparent pass, emission order in each
  const words = 2 + (triRun ? 1 : 0) + (uvsIn ? 2 : 0) + (colorLin ? 4 : 0) + (triBone ? 1 : 0);
  vertexTable.reset(validCount * 3, words);
  const k = keyScratch;
  const indices = new Uint32Array(validCount * 3);
  let ni = 0;
  let kept = 0;
  let opaqueIndexCount = 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let t = 0; t < n; t++) {
      if (!valid[t]) continue;
      const raw = rec.triPaint[t]!;
      if (rawTransparent[raw] !== pass) continue;
      const o = t * 9;
      // degenerate after quantisation: two corners on one position
      const ax = Q[o]!, ay = Q[o + 1]!, az = Q[o + 2]!;
      const bx = Q[o + 3]!, by = Q[o + 4]!, bz = Q[o + 5]!;
      const cx = Q[o + 6]!, cy = Q[o + 7]!, cz = Q[o + 8]!;
      if ((ax === bx && ay === by && az === bz) || (ax === cx && ay === cy && az === cz) || (bx === cx && by === cy && bz === cz)) continue;
      let local = rawToLocal[raw]!;
      if (local < 0) {
        const bits = rawBits.subarray(raw * PAINT_FLOATS, raw * PAINT_FLOATS + PAINT_FLOATS).join(',');
        let l = recordToLocal.get(bits);
        if (l === undefined) {
          l = localRecords.length;
          if (l >= MAX_LOCAL_PAINTS) throw new RangeError(`packMesh: more than 65,535 distinct paints in one LOD`);
          localRecords.push(raw);
          recordToLocal.set(bits, l);
        }
        local = l;
        rawToLocal[raw] = l;
      }
      for (let c = 0; c < 3; c++) {
        const qo = o + c * 3;
        k[0] = (Q[qo]! & 0xffff) | (Q[qo + 1]! << 16);
        k[1] = (Q[qo + 2]! & 0xffff) | (local << 16);
        let w = 2;
        if (triRun) k[w++] = normalOf(cornerScratch[t * 3 + c]!);
        if (uvsIn) {
          const e = cornerEmit(t, c);
          k[w++] = f32bits(uvsIn[e * 2]!);
          k[w++] = f32bits(uvsIn[e * 2 + 1]!);
        }
        if (colorLin) {
          const e = cornerEmit(t, c);
          for (let q = 0; q < 4; q++) k[w++] = f32bits(colorLin[e * 4 + q]!);
        }
        if (triBone) k[w++] = triBone[t]!;
        indices[ni++] = vertexTable.find(k);
      }
      kept++;
    }
    if (pass === 0) opaqueIndexCount = ni;
  }

  // 7. output buffers
  const vertices = vertexTable.count;
  const keyWords = vertexTable.keys;
  const vtx = new ArrayBuffer(vertices * VERTEX_STRIDE);
  const vi16 = new Int16Array(vtx);
  const normals = triRun ? new Int8Array(vertices * 4) : undefined;
  const uvsOut = uvsIn ? new Float32Array(vertices * 2) : undefined;
  const fview = uvsOut ? new Uint32Array(uvsOut.buffer) : undefined;
  const colorsOut = colorLin ? new Float32Array(vertices * 4) : undefined;
  const cview = colorsOut ? new Uint32Array(colorsOut.buffer) : undefined;
  const skinIndex = triBone ? new Uint8Array(vertices) : undefined;
  for (let v = 0; v < vertices; v++) {
    const b = v * words;
    const w0 = keyWords[b]!, w1 = keyWords[b + 1]!;
    vi16[v * 4] = (w0 << 16) >> 16;
    vi16[v * 4 + 1] = w0 >> 16;
    vi16[v * 4 + 2] = (w1 << 16) >> 16;
    vi16[v * 4 + 3] = (w1 >>> 16) - PAINT_ID_BIAS;
    let w = 2;
    if (normals) {
      const nw = keyWords[b + w++]!;
      normals[v * 4] = (nw << 24) >> 24;
      normals[v * 4 + 1] = (nw << 16) >> 24;
      normals[v * 4 + 2] = (nw << 8) >> 24;
    }
    if (fview) {
      fview[v * 2] = keyWords[b + w++]!;
      fview[v * 2 + 1] = keyWords[b + w++]!;
    }
    if (cview) for (let q = 0; q < 4; q++) cview[v * 4 + q] = keyWords[b + w++]!;
    if (skinIndex) skinIndex[v] = keyWords[b + w++]!;
  }
  const idx = vertices <= 65536 ? Uint16Array.from(indices.subarray(0, ni)) : indices.slice(0, ni);
  const paints = new Float32Array(localRecords.length * PAINT_FLOATS);
  for (let l = 0; l < localRecords.length; l++) paints.set(rawRecords.subarray(localRecords[l]! * PAINT_FLOATS, (localRecords[l]! + 1) * PAINT_FLOATS), l * PAINT_FLOATS);
  // texture ids index the full list; keep only the referenced ones in first-use order
  let usedTextures = textures;
  if (textures.length > 0) {
    const used: string[] = [];
    for (let l = 0; l < localRecords.length; l++) {
      const o = l * PAINT_FLOATS + 10;
      const id = paints[o]!;
      if (id > 0) {
        const name = textures[id - 1]!;
        let j = used.indexOf(name);
        if (j < 0) j = used.push(name) - 1;
        paints[o] = j + 1;
      }
    }
    usedTextures = used;
  }

  const out: PackedLod = {
    lod: rec.lod,
    vtx,
    idx,
    opaqueIndexCount,
    bboxMin: [min0, min1, min2],
    bboxMax: [max0, max1, max2],
    tris: kept,
    vertices,
    paints,
    textures: usedTextures,
    uvProjection: rec.uvProjection,
    dropped: n - kept,
    ms: 0,
  };
  if (normals) out.normals = normals;
  if (uvsOut) out.uvs = uvsOut;
  if (colorsOut) out.colors = colorsOut;
  if (skinIndex) out.skinIndex = skinIndex;
  return out;
}

/** Packs a collider run: soups as float32 local triangles (non-finite and zero-area ones dropped). */
export function packCollider(rec: RecordedCollider): PackedCollider {
  switch (rec.kind) {
    case 'none':
      return null;
    case 'box':
      return { box: [rec.size[0], rec.size[1], rec.size[2]] };
    case 'sphere':
      return { sphere: rec.radius };
    case 'tris': {
      const src = rec.positions;
      const n = src.length / 9;
      const tmp = new Float32Array(src.length);
      let m = 0;
      for (let t = 0; t < n; t++) {
        const o = t * 9;
        let ok = true;
        for (let i = 0; i < 9; i++) {
          const v = src[o + i]!;
          if (!Number.isFinite(v)) {
            ok = false;
            break;
          }
          tmp[m * 9 + i] = v;
        }
        if (!ok) continue;
        const p = m * 9;
        const ux = tmp[p + 3]! - tmp[p]!, uy = tmp[p + 4]! - tmp[p + 1]!, uz = tmp[p + 5]! - tmp[p + 2]!;
        const wx = tmp[p + 6]! - tmp[p]!, wy = tmp[p + 7]! - tmp[p + 1]!, wz = tmp[p + 8]! - tmp[p + 2]!;
        const cx = uy * wz - uz * wy, cy = uz * wx - ux * wz, cz = ux * wy - uy * wx;
        if (cx === 0 && cy === 0 && cz === 0) continue;
        m++;
      }
      return m > 0 ? { tris: tmp.slice(0, m * 9) } : null;
    }
  }
}

// ── readback (tests, tools, the X-42 LOD-5 hull soups) ───────────────────────────────────────────────────────────────

/** Dequantised vertex positions, 3 per vertex (float64). */
export function lodVertexPositions(lod: PackedLod): Float64Array {
  const v = new Int16Array(lod.vtx);
  const out = new Float64Array(lod.vertices * 3);
  for (let a = 0; a < 3; a++) {
    const c = (lod.bboxMin[a]! + lod.bboxMax[a]!) / 2;
    const h = (lod.bboxMax[a]! - lod.bboxMin[a]!) / 2;
    for (let i = 0; i < lod.vertices; i++) out[i * 3 + a] = c + (v[i * 4 + a]! / QMAX) * h;
  }
  return out;
}

/** Local paint id per vertex. */
export function lodPaintIds(lod: PackedLod): Uint16Array {
  const v = new Int16Array(lod.vtx);
  const out = new Uint16Array(lod.vertices);
  for (let i = 0; i < lod.vertices; i++) out[i] = v[i * 4 + 3]! + PAINT_ID_BIAS;
  return out;
}

/** Dequantised triangles in index order (opaque first), 9 floats each. */
export function unpackTriangles(lod: PackedLod): Float32Array {
  const pos = lodVertexPositions(lod);
  const out = new Float32Array(lod.idx.length * 3);
  for (let i = 0; i < lod.idx.length; i++) {
    const v = lod.idx[i]!;
    out[i * 3] = pos[v * 3]!;
    out[i * 3 + 1] = pos[v * 3 + 1]!;
    out[i * 3 + 2] = pos[v * 3 + 2]!;
  }
  return out;
}

/** Bytes a packed LOD holds (vertex + index + paint buffers, normals and UVs when present). */
export function packedLodBytes(lod: PackedLod): number {
  return lod.vtx.byteLength + lod.idx.byteLength + lod.paints.byteLength + (lod.normals?.byteLength ?? 0) + (lod.uvs?.byteLength ?? 0) + (lod.colors?.byteLength ?? 0) + (lod.skinIndex?.byteLength ?? 0);
}

/** Every buffer of a packed key, once each: the transfer list of a worker reply (zero copy). */
export function packedKeyTransfers(key: PackedKey): ArrayBuffer[] {
  const out = new Set<ArrayBuffer>();
  const add = (b: ArrayBufferLike | undefined): void => {
    if (b instanceof ArrayBuffer && b.byteLength > 0) out.add(b);
  };
  for (const l of key.lods) {
    add(l.vtx);
    add(l.idx.buffer);
    add(l.paints.buffer);
    add(l.normals?.buffer);
    add(l.uvs?.buffer);
    add(l.colors?.buffer);
    add(l.skinIndex?.buffer);
  }
  if (key.collider && 'tris' in key.collider) add(key.collider.tris.buffer);
  return [...out];
}
