// Deterministic 2D simplex noise, normalized octave sums, and seed helpers.
// Retains scalar salt/gain calibration; defaults contain no authored terrain anchors.
// Hosts may supply compact-support conditioning through createNoise for their own data.
// Permutations use seeded sfc32/Fisher-Yates; conditioning uses a Wendland C2 correction.

export type NoiseSeed = number | string;

export interface Simplex2Options {
  x: number;
  z: number;
  /** cycles per metre (default 1) */
  frequency?: number;
  /** output scale (default 1) */
  amplitude?: number;
  seed?: NoiseSeed;
}

export interface Fbm2Options extends Simplex2Options {
  /** default 4 (an integer 1..16) */
  octaves?: number;
  /** amplitude ratio between octaves (default 0.5) */
  gain?: number;
  /** frequency ratio between octaves (default 2) */
  lacunarity?: number;
}

/** One pinned value of a conditioned fbm2 call: the field passes through `n` at (x, z). */
export interface Fbm2Anchor {
  readonly x: number;
  readonly z: number;
  readonly n: number;
  /** the scene row whose authored height pins it (provenance) */
  readonly row: string;
}

/** The fbm2 call a set of anchors constrains, identified by its arguments. */
export interface Fbm2Conditioning {
  /** the call's seed (its uint32 key) */
  readonly seed: number;
  readonly frequency: number;
  readonly octaves: number;
  /** support radius of each anchor's correction, metres */
  readonly radius: number;
  readonly anchors: readonly Fbm2Anchor[];
}

export interface NoiseCalibration {
  /** seed-mixing salt of `seedOffset` */
  readonly salt: number;
  /** stretch applied to the normalised fbm before the clamp to [−1, 1] */
  readonly gain: number;
  readonly conditioning: readonly Fbm2Conditioning[];
}

export interface NoiseApi {
  simplex2(o: Simplex2Options): number;
  fbm2(o: Fbm2Options): number;
  seedOffset(seed: NoiseSeed, i: number): number;
}

/** Supremum of 70·(n0 + n1 + n2) for the 12-gradient 2D simplex (measured: pattern search over six permutations). */
export const SIMPLEX_SUP = 0.9978893541549096;

/** Scalar compatibility calibration. Authored field conditioning must be supplied explicitly by a host. */
export const NOISE_CALIBRATION: NoiseCalibration = {
  salt: 2713,
  gain: 1 / 0.8838306056779549,
  conditioning: [],
};

// ── seeds ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** FNV-1a over UTF-16 code units. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** murmur3's 32-bit finaliser over a combination of two words. */
function mix32(a: number, b: number): number {
  let h = (a ^ Math.imul(b ^ 0x5bd1e995, 0x9e3779b9)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

/** The uint32 key of a seed: an integer is taken modulo 2^32, anything else (fractions, strings) is hashed as text. */
export function seedKey(seed: NoiseSeed | undefined): number {
  if (seed === undefined) return 0;
  if (typeof seed === 'number' && Number.isInteger(seed) && Math.abs(seed) <= Number.MAX_SAFE_INTEGER) {
    return ((seed % 4294967296) + 4294967296) % 4294967296;
  }
  return fnv1a(String(seed));
}

// ── simplex ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const F2 = 0.5 * (Math.sqrt(3) - 1);
const G2 = (3 - Math.sqrt(3)) / 6;
const GX = [1, -1, 1, -1, 1, -1, 1, -1, 0, 0, 0, 0];
const GY = [1, 1, -1, -1, 0, 0, 0, 0, 1, -1, 1, -1];
const SCALE = 70 / SIMPLEX_SUP;

/** sfc32 (Chris Doty-Humphrey) floats in [0, 1). */
function sfc32(a: number, b: number, c: number, d: number): () => number {
  return () => {
    a >>>= 0;
    b >>>= 0;
    c >>>= 0;
    d >>>= 0;
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

/** The 512-entry permutation (gradient index premultiplied mod 12) of a uint32 key. */
function buildPerm(key: number): Uint8Array {
  const rand = sfc32(mix32(key, 1), mix32(key, 2), mix32(key, 3), mix32(key, 4));
  for (let i = 0; i < 12; i++) rand(); // warm-up, as sfc32's author recommends
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const t = p[i]!;
    p[i] = p[j]!;
    p[j] = t;
  }
  const perm = new Uint8Array(512);
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255]!;
  return perm;
}

const PERM_CACHE_MAX = 256;
const permCache = new Map<number, Uint8Array>();
function permFor(key: number): Uint8Array {
  let p = permCache.get(key);
  if (!p) {
    if (permCache.size >= PERM_CACHE_MAX) permCache.clear();
    p = buildPerm(key);
    permCache.set(key, p);
  }
  return p;
}

/** Raw 2D simplex noise in [−1, 1] over a permutation. */
function simplexRaw(perm: Uint8Array, xin: number, yin: number): number {
  const s = (xin + yin) * F2;
  const i = Math.floor(xin + s);
  const j = Math.floor(yin + s);
  const t = (i + j) * G2;
  const x0 = xin - (i - t);
  const y0 = yin - (j - t);
  const i1 = x0 > y0 ? 1 : 0;
  const j1 = 1 - i1;
  const x1 = x0 - i1 + G2;
  const y1 = y0 - j1 + G2;
  const x2 = x0 - 1 + 2 * G2;
  const y2 = y0 - 1 + 2 * G2;
  const ii = i & 255;
  const jj = j & 255;
  let n = 0;
  let t0 = 0.5 - x0 * x0 - y0 * y0;
  if (t0 > 0) {
    const g = perm[ii + perm[jj]!]! % 12;
    t0 *= t0;
    n += t0 * t0 * (GX[g]! * x0 + GY[g]! * y0);
  }
  let t1 = 0.5 - x1 * x1 - y1 * y1;
  if (t1 > 0) {
    const g = perm[ii + i1 + perm[jj + j1]!]! % 12;
    t1 *= t1;
    n += t1 * t1 * (GX[g]! * x1 + GY[g]! * y1);
  }
  let t2 = 0.5 - x2 * x2 - y2 * y2;
  if (t2 > 0) {
    const g = perm[ii + 1 + perm[jj + 1]!]! % 12;
    t2 *= t2;
    n += t2 * t2 * (GX[g]! * x2 + GY[g]! * y2);
  }
  const v = SCALE * n;
  return v > 1 ? 1 : v < -1 ? -1 : v;
}

// ── conditioning ────────────────────────────────────────────────────────────────────────────────────────────────────

/** Wendland's C2 kernel (positive definite in 2D), 1 at r = 0, 0 from r = radius. */
function wendland(r: number, radius: number): number {
  const q = r / radius;
  if (q >= 1) return 0;
  const a = 1 - q;
  return a * a * a * a * (4 * q + 1);
}

/** Solve A·w = b (small, symmetric positive definite) by Gaussian elimination with partial pivoting. */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(m[r]![c]!) > Math.abs(m[p]![c]!)) p = r;
    [m[c], m[p]] = [m[p]!, m[c]!];
    const piv = m[c]![c]!;
    if (Math.abs(piv) < 1e-12) throw new Error('builtin/noise: singular conditioning system (two anchors coincide)');
    for (let r = c + 1; r < n; r++) {
      const f = m[r]![c]! / piv;
      for (let k = c; k <= n; k++) m[r]![k]! -= f * m[c]![k]!;
    }
  }
  const w = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = m[r]![n]!;
    for (let k = r + 1; k < n; k++) s -= m[r]![k]! * w[k]!;
    w[r] = s / m[r]![r]!;
  }
  return w;
}

interface Correction {
  readonly c: Fbm2Conditioning;
  /** anchor weights, solved lazily from the plain field */
  w: number[] | null;
}

// ── the API ─────────────────────────────────────────────────────────────────────────────────────────────────────────

const finite = (v: number): boolean => Number.isFinite(v);

/** A `builtin/noise` instance over a calibration (the module exports the one over NOISE_CALIBRATION). */
export function createNoise(cal: NoiseCalibration): NoiseApi {
  const corrections: Correction[] = cal.conditioning.map((c) => ({ c, w: null }));

  function seedOffset(seed: NoiseSeed, i: number): number {
    return mix32(mix32(seedKey(seed), cal.salt), i | 0);
  }

  function simplex2(o: Simplex2Options): number {
    const f = o.frequency ?? 1;
    const x = o.x * f;
    const z = o.z * f;
    if (!finite(x) || !finite(z)) return 0;
    return (o.amplitude ?? 1) * simplexRaw(permFor(seedKey(o.seed)), x, z);
  }

  /** The stretched, normalised fbm before conditioning and the clamp. */
  function plain(key: number, x: number, z: number, frequency: number, octaves: number, gain: number, lacunarity: number): number {
    let sum = 0;
    let amp = 1;
    let total = 0;
    let fx = x * frequency;
    let fz = z * frequency;
    for (let o = 0; o < octaves; o++) {
      sum += amp * simplexRaw(permFor(o === 0 ? key : mix32(key, o)), fx, fz);
      total += amp;
      amp *= gain;
      fx *= lacunarity;
      fz *= lacunarity;
    }
    return total > 0 ? (cal.gain * sum) / total : 0;
  }

  function correction(k: Correction, x: number, z: number): number {
    const { c } = k;
    if (!k.w) {
      const n = c.anchors.length;
      const a = c.anchors.map((p) => c.anchors.map((q) => wendland(Math.hypot(p.x - q.x, p.z - q.z), c.radius)));
      const b = c.anchors.map((p) => p.n - plain(c.seed, p.x, p.z, c.frequency, c.octaves, 0.5, 2));
      k.w = n > 0 ? solve(a, b) : [];
    }
    let s = 0;
    for (let i = 0; i < c.anchors.length; i++) {
      const p = c.anchors[i]!;
      s += k.w[i]! * wendland(Math.hypot(x - p.x, z - p.z), c.radius);
    }
    return s;
  }

  function fbm2(o: Fbm2Options): number {
    const frequency = o.frequency ?? 1;
    const oct = o.octaves ?? 4;
    const octaves = Number.isFinite(oct) ? Math.max(1, Math.min(16, Math.floor(oct))) : 4;
    const gain = o.gain ?? 0.5;
    const lacunarity = o.lacunarity ?? 2;
    if (!finite(o.x) || !finite(o.z) || !finite(o.x * frequency) || !finite(o.z * frequency)) return 0;
    const key = seedKey(o.seed);
    let v = plain(key, o.x, o.z, frequency, octaves, gain, lacunarity);
    if (gain === 0.5 && lacunarity === 2) {
      for (const k of corrections) {
        if (k.c.seed === key && k.c.frequency === frequency && k.c.octaves === octaves) v += correction(k, o.x, o.z);
      }
    }
    v = v > 1 ? 1 : v < -1 ? -1 : v;
    return (o.amplitude ?? 1) * v;
  }

  return { simplex2, fbm2, seedOffset };
}

const api = createNoise(NOISE_CALIBRATION);

/** Simplex 2D noise in [−1, 1] (× amplitude). */
export const simplex2: (o: Simplex2Options) => number = api.simplex2;
/** Fractal simplex noise, normalised, stretched and clamped to [−1, 1] (× amplitude); deterministic per seed. */
export const fbm2: (o: Fbm2Options) => number = api.fbm2;
/** The seed of a place's i-th noise layer (the heightmap ctx binds `ctx.seedOffset(i)` to the place's terrain seed). */
export const seedOffset: (seed: NoiseSeed, i: number) => number = api.seedOffset;

// ── the documented rest of `builtin/noise` (engine api reference: simplex3, ridged, billowed2, gradient2, domainWarp2, ───────
// voronoi2, white2, makeSeededRng). Standard algorithms, deterministic per seed, pure arithmetic like the above. They are NOT
// bit-exact with Spawn's (its noise cannot be sampled) and take no part in the the terrain calibration fixture calibration: they use the plain fields.
// Conventions chosen where the docs give only a signature: every scalar field returns [-1, 1] (x amplitude), voronoi distances
// are in cells (a feature point's cell is one unit wide), `white2` is [0, 1), and `makeSeededRng().next()` is a float in [0, 1)
// like Math.random.

/** The 12 edge-midpoint gradients of 3D simplex noise (Gustavson). */
const G3 = [1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0, 1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1, 0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1];
const F3 = 1 / 3;
const G3C = 1 / 6;

/** Raw 3D simplex noise over a permutation, scaled to about [-1, 1] and clamped. */
function simplexRaw3(perm: Uint8Array, xin: number, yin: number, zin: number): number {
  const s = (xin + yin + zin) * F3;
  const i = Math.floor(xin + s);
  const j = Math.floor(yin + s);
  const k = Math.floor(zin + s);
  const t = (i + j + k) * G3C;
  const x0 = xin - (i - t);
  const y0 = yin - (j - t);
  const z0 = zin - (k - t);
  let i1: number, j1: number, k1: number, i2: number, j2: number, k2: number;
  if (x0 >= y0) {
    if (y0 >= z0) [i1, j1, k1, i2, j2, k2] = [1, 0, 0, 1, 1, 0];
    else if (x0 >= z0) [i1, j1, k1, i2, j2, k2] = [1, 0, 0, 1, 0, 1];
    else [i1, j1, k1, i2, j2, k2] = [0, 0, 1, 1, 0, 1];
  } else if (y0 < z0) [i1, j1, k1, i2, j2, k2] = [0, 0, 1, 0, 1, 1];
  else if (x0 < z0) [i1, j1, k1, i2, j2, k2] = [0, 1, 0, 0, 1, 1];
  else [i1, j1, k1, i2, j2, k2] = [0, 1, 0, 1, 1, 0];
  const xs = [x0, x0 - i1 + G3C, x0 - i2 + 2 * G3C, x0 - 1 + 3 * G3C];
  const ys = [y0, y0 - j1 + G3C, y0 - j2 + 2 * G3C, y0 - 1 + 3 * G3C];
  const zs = [z0, z0 - k1 + G3C, z0 - k2 + 2 * G3C, z0 - 1 + 3 * G3C];
  const ii = i & 255;
  const jj = j & 255;
  const kk = k & 255;
  const di = [0, i1, i2, 1];
  const dj = [0, j1, j2, 1];
  const dk = [0, k1, k2, 1];
  let n = 0;
  for (let c = 0; c < 4; c++) {
    let tc = 0.6 - xs[c]! * xs[c]! - ys[c]! * ys[c]! - zs[c]! * zs[c]!;
    if (tc <= 0) continue;
    const g = (perm[ii + di[c]! + perm[jj + dj[c]! + perm[kk + dk[c]!]!]!]! % 12) * 3;
    tc *= tc;
    n += tc * tc * (G3[g]! * xs[c]! + G3[g + 1]! * ys[c]! + G3[g + 2]! * zs[c]!);
  }
  const v = 32 * n;
  return v > 1 ? 1 : v < -1 ? -1 : v;
}

export interface Simplex3Options {
  x: number;
  y: number;
  z: number;
  /** cycles per metre (default 1) */
  frequency?: number;
  /** output scale (default 1) */
  amplitude?: number;
  seed?: NoiseSeed;
}

/** 3D simplex noise in [-1, 1] (x amplitude). */
export function simplex3(o: Simplex3Options): number {
  const f = o.frequency ?? 1;
  const x = o.x * f;
  const y = o.y * f;
  const z = o.z * f;
  if (!finite(x) || !finite(y) || !finite(z)) return 0;
  return (o.amplitude ?? 1) * simplexRaw3(permFor(seedKey(o.seed)), x, y, z);
}

function octaveCount(o: number | undefined): number {
  return o === undefined || !Number.isFinite(o) ? 4 : Math.max(1, Math.min(16, Math.floor(o)));
}

/** the normalised sum of a per-octave transform of raw simplex, each octave over its own permutation; `weight` threads through */
function octaveSum(o: Fbm2Options, f: (s: number, weight: number) => { value: number; weight: number }): number {
  const frequency = o.frequency ?? 1;
  const gain = o.gain ?? 0.5;
  const lacunarity = o.lacunarity ?? 2;
  const octaves = octaveCount(o.octaves);
  let fx = o.x * frequency;
  let fz = o.z * frequency;
  if (!finite(fx) || !finite(fz)) return 0;
  const key = seedKey(o.seed);
  let amp = 1;
  let total = 0;
  let sum = 0;
  let weight = 1;
  for (let i = 0; i < octaves; i++) {
    const r = f(simplexRaw(permFor(i === 0 ? key : mix32(key, i)), fx, fz), weight);
    sum += amp * r.value;
    weight = r.weight;
    total += amp;
    amp *= gain;
    fx *= lacunarity;
    fz *= lacunarity;
  }
  return total > 0 ? sum / total : 0;
}

export interface RidgedOptions extends Fbm2Options {
  /** how strongly a ridge in one octave weights the next (default 2) */
  ridgeGain?: number;
}

/** Ridged multifractal noise (Musgrave): sharp crests where the simplex field crosses zero; in [-1, 1] (x amplitude), crests at +1. */
export function ridged(o: RidgedOptions): number {
  const ridgeGain = o.ridgeGain ?? 2;
  const r = octaveSum(o, (s, weight) => {
    let signal = 1 - Math.abs(s);
    signal *= signal;
    return { value: signal * weight, weight: Math.min(1, Math.max(0, signal * ridgeGain)) };
  });
  return (o.amplitude ?? 1) * Math.max(-1, Math.min(1, 2 * r - 1));
}

/** Billowed (turbulence) noise: rounded humps from |simplex| per octave; in [-1, 1] (x amplitude), humps at +1. */
export function billowed2(o: Fbm2Options): number {
  const r = octaveSum(o, (s) => ({ value: Math.abs(s), weight: 1 }));
  return (o.amplitude ?? 1) * Math.max(-1, Math.min(1, 2 * r - 1));
}

export interface Gradient2Options {
  x: number;
  z: number;
  frequency?: number;
  seed?: NoiseSeed;
  /** central-difference step in world units (default 0.01) */
  delta?: number;
}

/** The gradient of `simplex2` with respect to world x and z (central differences) and its length. */
export function gradient2(o: Gradient2Options): { x: number; z: number; magnitude: number } {
  const d = o.delta !== undefined && Number.isFinite(o.delta) && o.delta > 0 ? o.delta : 0.01;
  const base = { ...(o.frequency === undefined ? {} : { frequency: o.frequency }), ...(o.seed === undefined ? {} : { seed: o.seed }) };
  const gx = (simplex2({ ...base, x: o.x + d, z: o.z }) - simplex2({ ...base, x: o.x - d, z: o.z })) / (2 * d);
  const gz = (simplex2({ ...base, x: o.x, z: o.z + d }) - simplex2({ ...base, x: o.x, z: o.z - d })) / (2 * d);
  if (!finite(gx) || !finite(gz)) return { x: 0, z: 0, magnitude: 0 };
  return { x: gx, z: gz, magnitude: Math.hypot(gx, gz) };
}

export interface DomainWarp2Options extends Fbm2Options {
  /** displacement of the sample point in metres at full noise (default 1) */
  warpAmp?: number;
  /** cycles per metre of the displacement field (default: `frequency`) */
  warpFrequency?: number;
}

/** `fbm2` sampled at a point displaced by two further fbm fields (domain warping). */
export function domainWarp2(o: DomainWarp2Options): number {
  const { warpAmp = 1, warpFrequency, ...rest } = o;
  const key = seedKey(o.seed);
  const w = { frequency: warpFrequency ?? o.frequency ?? 1, octaves: 2 };
  const dx = fbm2({ ...w, x: o.x, z: o.z, seed: mix32(key, 0x57a1) });
  const dz = fbm2({ ...w, x: o.x, z: o.z, seed: mix32(key, 0x57a2) });
  return fbm2({ ...rest, x: o.x + warpAmp * dx, z: o.z + warpAmp * dz });
}

export type VoronoiMetric = 'euclidean' | 'manhattan' | 'chebyshev';

export interface Voronoi2Options {
  x: number;
  z: number;
  /** cells per metre (default 1) */
  frequency?: number;
  seed?: NoiseSeed;
  /** default 'euclidean' */
  metric?: VoronoiMetric;
}

/** A uint32 hash of an integer cell and a salt. */
function cellHash(ix: number, iz: number, key: number, salt: number): number {
  return mix32(mix32(key ^ salt, ix | 0), iz | 0);
}

/**
 * Worley (cellular) noise: the distances `f1`, `f2` (nearest and second nearest feature point, in cells) and the `cell` id of the
 * nearest one (a uint32 stable per cell and seed; use it to pick a per-cell colour or height).
 */
export function voronoi2(o: Voronoi2Options): { f1: number; f2: number; cell: number } {
  const f = o.frequency ?? 1;
  const x = o.x * f;
  const z = o.z * f;
  if (!finite(x) || !finite(z)) return { f1: 0, f2: 0, cell: 0 };
  const key = seedKey(o.seed);
  const metric = o.metric ?? 'euclidean';
  const cx = Math.floor(x);
  const cz = Math.floor(z);
  let f1 = Infinity;
  let f2 = Infinity;
  let cell = 0;
  for (let dz = -2; dz <= 2; dz++) {
    for (let dx = -2; dx <= 2; dx++) {
      const ix = cx + dx;
      const iz = cz + dz;
      const ax = Math.abs(ix + cellHash(ix, iz, key, 0x1) / 4294967296 - x);
      const az = Math.abs(iz + cellHash(ix, iz, key, 0x2) / 4294967296 - z);
      const d = metric === 'manhattan' ? ax + az : metric === 'chebyshev' ? Math.max(ax, az) : Math.hypot(ax, az);
      if (d < f1) {
        f2 = f1;
        f1 = d;
        cell = cellHash(ix, iz, key, 0x3);
      } else if (d < f2) f2 = d;
    }
  }
  return { f1, f2, cell };
}

export interface White2Options {
  x: number;
  z: number;
  seed?: NoiseSeed;
}

const F64 = new Float64Array(1);
const U32 = new Uint32Array(F64.buffer);

/** Hash noise in [0, 1): uncorrelated between distinct (x, z) (the exact doubles are hashed), stable per seed. */
export function white2(o: White2Options): number {
  if (!finite(o.x) || !finite(o.z)) return 0;
  let h = seedKey(o.seed);
  F64[0] = o.x;
  h = mix32(mix32(h, U32[0]!), U32[1]!);
  F64[0] = o.z;
  h = mix32(mix32(h, U32[0]! ^ 0x2545f491), U32[1]!);
  return h / 4294967296;
}

export interface SeededRng {
  /** a float in [0, 1) (32 bits of resolution), like Math.random */
  next(): number;
  /** a float in [0, 1) with 53 bits of resolution */
  double(): number;
  /** a signed 32-bit integer */
  int32(): number;
  /** an unsigned 32-bit integer */
  uint32(): number;
  /** a float in [min, max) */
  range(min: number, max: number): number;
}

/** A deterministic generator (sfc32) of a number or string seed: the same seed gives the same sequence in every engine. */
export function makeSeededRng(seed: NoiseSeed): SeededRng {
  const key = seedKey(seed);
  let a = mix32(key, 11);
  let b = mix32(key, 12);
  let c = mix32(key, 13);
  let d = mix32(key, 14);
  const u32 = (): number => {
    let t = (a + b) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    d = (d + 1) | 0;
    t = (t + d) | 0;
    c = (c + t) | 0;
    return t >>> 0;
  };
  for (let i = 0; i < 12; i++) u32();
  return {
    next: () => u32() / 4294967296,
    double: () => (u32() * 2097152 + (u32() >>> 11)) / 9007199254740992,
    int32: () => u32() | 0,
    uint32: u32,
    range: (min, max) => min + (u32() / 4294967296) * (max - min),
  };
}
