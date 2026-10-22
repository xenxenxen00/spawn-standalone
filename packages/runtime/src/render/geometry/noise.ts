// ctx.noise2d / ctx.noise3d for the live generators (render §6.2 [D], [CAL row 11]).
//
// Seedless gradient noise in [−1, 1]: Ken Perlin's improved noise (2002) with his reference permutation. The engine's own
// noise is unknown; the only live caller is `scripts/gen/the-sinkway/lib.js:152` (noise3d, faceted rock blocks), so the
// rock facets differ from live in detail but are stable inside the port. Pure arithmetic and `Math.floor`: bit-identical in
// every JavaScript engine. Not to be confused with `builtin/noise` (`fbm2`, the the terrain scene heightmap noise, WP MP0).

/** Ken Perlin's reference permutation of 0..255 ("Improving Noise", SIGGRAPH 2002). */
export const PERLIN_PERMUTATION: readonly number[] = [
  151, 160, 137, 91, 90, 15, 131, 13, 201, 95, 96, 53, 194, 233, 7, 225, 140, 36, 103, 30, 69, 142, 8, 99, 37, 240, 21, 10,
  23, 190, 6, 148, 247, 120, 234, 75, 0, 26, 197, 62, 94, 252, 219, 203, 117, 35, 11, 32, 57, 177, 33, 88, 237, 149, 56, 87,
  174, 20, 125, 136, 171, 168, 68, 175, 74, 165, 71, 134, 139, 48, 27, 166, 77, 146, 158, 231, 83, 111, 229, 122, 60, 211,
  133, 230, 220, 105, 92, 41, 55, 46, 245, 40, 244, 102, 143, 54, 65, 25, 63, 161, 1, 216, 80, 73, 209, 76, 132, 187, 208,
  89, 18, 169, 200, 196, 135, 130, 116, 188, 159, 86, 164, 100, 109, 198, 173, 186, 3, 64, 52, 217, 226, 250, 124, 123, 5,
  202, 38, 147, 118, 126, 255, 82, 85, 212, 207, 206, 59, 227, 47, 16, 58, 17, 182, 189, 28, 42, 223, 183, 170, 213, 119,
  248, 152, 2, 44, 154, 163, 70, 221, 153, 101, 155, 167, 43, 172, 9, 129, 22, 39, 253, 19, 98, 108, 110, 79, 113, 224, 232,
  178, 185, 112, 104, 218, 246, 97, 228, 251, 34, 242, 193, 238, 210, 144, 12, 191, 179, 162, 241, 81, 51, 145, 235, 249,
  14, 239, 107, 49, 192, 214, 31, 181, 199, 106, 157, 184, 84, 204, 176, 115, 121, 50, 45, 127, 4, 150, 254, 138, 236, 205,
  93, 222, 114, 67, 29, 24, 72, 243, 141, 128, 195, 78, 66, 215, 61, 156, 180,
];

const P = new Uint8Array(512);
for (let i = 0; i < 512; i++) P[i] = PERLIN_PERMUTATION[i & 255]!;

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);
const lerp = (t: number, a: number, b: number): number => a + t * (b - a);
const clamp1 = (v: number): number => (v > 1 ? 1 : v < -1 ? -1 : v);

function grad3(hash: number, x: number, y: number, z: number): number {
  const h = hash & 15;
  const u = h < 8 ? x : y;
  const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
  return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
}

/** Improved Perlin noise; 0 on the integer lattice; clamped to [−1, 1]; 0 for non-finite input. */
export function noise3d(x: number, y: number, z: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return 0;
  const fx = Math.floor(x);
  const fy = Math.floor(y);
  const fz = Math.floor(z);
  const X = fx & 255;
  const Y = fy & 255;
  const Z = fz & 255;
  x -= fx;
  y -= fy;
  z -= fz;
  const u = fade(x);
  const v = fade(y);
  const w = fade(z);
  const A = P[X]! + Y;
  const AA = P[A]! + Z;
  const AB = P[A + 1]! + Z;
  const B = P[X + 1]! + Y;
  const BA = P[B]! + Z;
  const BB = P[B + 1]! + Z;
  return clamp1(
    lerp(
      w,
      lerp(v, lerp(u, grad3(P[AA]!, x, y, z), grad3(P[BA]!, x - 1, y, z)), lerp(u, grad3(P[AB]!, x, y - 1, z), grad3(P[BB]!, x - 1, y - 1, z))),
      lerp(
        v,
        lerp(u, grad3(P[AA + 1]!, x, y, z - 1), grad3(P[BA + 1]!, x - 1, y, z - 1)),
        lerp(u, grad3(P[AB + 1]!, x, y - 1, z - 1), grad3(P[BB + 1]!, x - 1, y - 1, z - 1)),
      ),
    ),
  );
}

function grad2(hash: number, x: number, y: number): number {
  return ((hash & 1) === 0 ? x : -x) + ((hash & 2) === 0 ? y : -y);
}

/** 2D improved noise over (x, z) with the four diagonal gradients; 0 on the integer lattice; within [−1, 1]. */
export function noise2d(x: number, z: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return 0;
  const fx = Math.floor(x);
  const fz = Math.floor(z);
  const X = fx & 255;
  const Z = fz & 255;
  x -= fx;
  z -= fz;
  const u = fade(x);
  const v = fade(z);
  const A = P[X]! + Z;
  const B = P[X + 1]! + Z;
  return clamp1(lerp(v, lerp(u, grad2(P[A]!, x, z), grad2(P[B]!, x - 1, z)), lerp(u, grad2(P[A + 1]!, x, z - 1), grad2(P[B + 1]!, x - 1, z - 1))));
}
