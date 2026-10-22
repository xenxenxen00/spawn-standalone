// ctx.random() for the live generators (render §6.2 [D]).
//
// The engine's RNG is unknowable, so random-driven details differ from live, consistently inside the port
// (`system-maps.md` §14). The port uses mulberry32 seeded with `seed ^ 0x9E3779B9`, restarted for every LOD run and for the
// collider run, so all LODs and the collider see the same sequence. kit2 never calls it (its own params-seeded rng).

export const RNG_SEED_MIX = 0x9e3779b9;

/** mulberry32 (Tommy Ettinger): a 32-bit state, uniform floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The int32 a primitive seed contributes to `seed ^ 0x9E3779B9` (JavaScript's ToInt32: truncation, wrap, NaN → 0). */
export function seedOf(seed: unknown): number {
  if (seed === undefined || seed === null) return 0;
  const n = typeof seed === 'number' ? seed : Number(seed);
  return Number.isFinite(n) ? n | 0 : 0;
}

/** A fresh `ctx.random` for one generator run of a primitive with this seed. */
export function generatorRandom(seed: unknown): () => number {
  return mulberry32(seedOf(seed) ^ RNG_SEED_MIX);
}
