// The built-in fx atlas (opt-in fallback for a game that ships no `assets/fx/fx-atlas.png`): the 14 white sprite shapes of the
// DSL (`FX_TEXTURES`, `sk/fx:27`) generated procedurally, so fx run with plain shapes instead of staying off. The layout is the
// renderer's: a 4 x 4 grid, texture `i` at column `i % 4`, row `floor(i / 4)` counted from the BOTTOM of the image (v = 0), so
// the generated rows are written bottom-up and "up" in a shape is +y. Colour is white and the shape is in alpha: the sprite is
// tinted by the population's `col` (`sample.mul(rgba)`). Pure data, no three: `installGame` wraps it in a `DataTexture`.
import { FX_TEXTURES } from './dsl/compile.ts';

export interface DefaultAtlasPixels {
  readonly width: number;
  readonly height: number;
  /** RGBA8, row 0 = the bottom of the image (v = 0) */
  readonly data: Uint8Array;
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const hash2 = (x: number, y: number): number => {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
};
const valueNoise = (x: number, y: number): number => {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const a = hash2(ix, iy), b = hash2(ix + 1, iy), c = hash2(ix, iy + 1), d = hash2(ix + 1, iy + 1);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
};
/** a soft edge: 1 inside `d <= 0`, falling to 0 over `w` */
const edge = (d: number, w: number): number => 1 - smooth(0, w, d);

type Shape = (x: number, y: number) => number;

// x, y in [-1, 1], y up; every shape stays inside radius ~0.92 so linear filtering never bleeds into a neighbouring cell
const SHAPES: Record<(typeof FX_TEXTURES)[number], Shape> = {
  'soft-disc': (x, y) => (1 - smooth(0, 0.92, Math.hypot(x, y))) ** 1.4,
  'smoke-puff': (x, y) => {
    const r = Math.hypot(x, y);
    const n = valueNoise(x * 3.2 + 7, y * 3.2 + 3) * 0.55 + valueNoise(x * 7 + 1, y * 7 + 9) * 0.25;
    return smooth(0.95, 0.15, r + (n - 0.4) * 0.5) * 0.9 * (1 - smooth(0.7, 0.92, r));
  },
  ember: (x, y) => {
    const r = Math.hypot(x, y);
    return Math.min(1, edge(r - 0.22, 0.12) + (1 - smooth(0, 0.9, r)) * 0.35);
  },
  mote: (x, y) => edge(Math.hypot(x, y) - 0.3, 0.3),
  'flame-wisp': (x, y) => {
    // a tongue: wide at the bottom, pointed at the top, leaning a little
    const t = (y + 0.9) / 1.8;
    if (t < 0 || t > 1) return 0;
    const half = Math.sin(Math.min(1, t * 1.15) * Math.PI * 0.5) * (1 - t) ** 0.8 * 0.55;
    return edge(Math.abs(x - Math.sin(t * 3) * 0.08) - half, 0.25) * (0.5 + 0.5 * (1 - t));
  },
  leaf: (x, y) => {
    const d = (Math.hypot(x / 0.5, y / 0.75) - 1) * 0.5;
    const vein = 1 - 0.25 * (1 - smooth(0, 0.06, Math.abs(x)));
    return edge(d, 0.12) * vein;
  },
  droplet: (x, y) => {
    // round at the bottom, pointed at the top
    const t = (y + 0.7) / 1.6;
    if (t < 0 || t > 1) return 0;
    const half = t < 0.4 ? Math.sqrt(Math.max(0, 1 - ((0.4 - t) / 0.4) ** 2)) * 0.5 : ((1 - t) / 0.6) * 0.5;
    return edge(Math.abs(x) - half, 0.18);
  },
  snowflake: (x, y) => {
    const r = Math.hypot(x, y);
    const a = Math.atan2(y, x);
    // six arms: the distance to the nearest arm axis is |sin(3a)| * r
    const spoke = edge(Math.abs(Math.sin(a * 3)) * r - 0.07, 0.07) * (1 - smooth(0.6, 0.9, r));
    return Math.min(1, spoke + edge(r - 0.1, 0.1));
  },
  petal: (x, y) => {
    const d = (Math.hypot(x / 0.55, y / 0.72) - 1) * 0.5 + (y > 0 ? y * y * 0.12 : 0);
    return edge(d, 0.12);
  },
  stalk: (x, y) => edge(Math.abs(x) - 0.09, 0.08) * edge(Math.abs(y) - 0.78, 0.12),
  chip: (x, y) => edge(Math.max(Math.abs(x), Math.abs(y * 1.15)) - 0.5, 0.14),
  grain: (x, y) => edge(Math.hypot(x * 1.3, y * 0.8) - 0.22, 0.18),
  splinter: (x, y) => {
    // thin, slanted
    const u = x * 0.8 + y * 0.6;
    const v = -x * 0.6 + y * 0.8;
    return edge(Math.abs(v) - 0.07 * (1 - Math.abs(u) / 1.1), 0.06) * edge(Math.abs(u) - 0.8, 0.1);
  },
  shard: (x, y) => {
    // a triangle with a sharp tip
    const t = (y + 0.8) / 1.6;
    if (t < 0 || t > 1) return 0;
    return edge(Math.abs(x) - (1 - t) * 0.62, 0.1) * edge(Math.abs(y) - 0.8, 0.08);
  },
};

/** Generates the atlas: `cell` px per tile (default 64), `4 * cell` square. Deterministic. */
export function generateDefaultAtlas(cell = 64): DefaultAtlasPixels {
  const size = cell * 4;
  const data = new Uint8Array(size * size * 4);
  FX_TEXTURES.forEach((name, i) => {
    const shape = SHAPES[name];
    const cx = (i % 4) * cell;
    const cy = Math.floor(i / 4) * cell;
    for (let py = 0; py < cell; py++) {
      for (let px = 0; px < cell; px++) {
        const x = ((px + 0.5) / cell) * 2 - 1;
        const y = ((py + 0.5) / cell) * 2 - 1;
        const a = Math.min(1, Math.max(0, shape(x, y)));
        const o = ((cy + py) * size + cx + px) * 4;
        data[o] = 255;
        data[o + 1] = 255;
        data[o + 2] = 255;
        data[o + 3] = Math.round(a * 255);
      }
    }
  });
  return { width: size, height: size, data };
}
