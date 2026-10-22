// Liquid volumes and the swim rule (motion §5.9). Backend-neutral and pure: no Rapier, no rows.
//
// Only the terrain calibration fixture declares water: `terrain.marks.sea = { kind: sea, level: 0 }` in its config. The engine rule: "a character
// deeper than 0.72 × its height floats and swims". In the port a character whose feet would end deeper than `0.72·h` below
// the level is held at `level − 0.72·h`: the downward part of its move is removed and it reads a vertical velocity of 0;
// its horizontal move is untouched [CAL: the live swim speed is not measured]. Dynamic bodies sink (no buoyancy) [INF].
// `onLiquidEnter` / `onLiquidExit` are exported by no live behaviour, so nothing is dispatched; the state is readable
// (`LiquidState`, the value of `ctx.self.liquid`).

/** the share of a character's height that is under water when it floats */
export const SWIM_DEPTH_SHARE = 0.72;

export interface LiquidVolume {
  /** the mark's name in the place config */
  id: string;
  kind: 'sea';
  /** surface height (world y); the volume is everything below it, everywhere */
  level: number;
}

/** `ctx.self.liquid` */
export interface LiquidState {
  /** the feet are below the surface */
  in: boolean;
  /** the surface over the body; null when the place has no liquid */
  level: number | null;
  /** the body floats (it is held at the swim depth) */
  swimming: boolean;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** the liquid volumes of a place: the `sea` marks of its compiled `terrain` config, in config order */
export function liquidVolumes(terrain: unknown): LiquidVolume[] {
  const marks = isObj(terrain) ? terrain['marks'] : null;
  if (!isObj(marks)) return [];
  const out: LiquidVolume[] = [];
  for (const [id, m] of Object.entries(marks)) {
    if (!isObj(m) || m['kind'] !== 'sea') continue;
    const level = m['level'];
    out.push({ id, kind: 'sea', level: typeof level === 'number' && Number.isFinite(level) ? level : 0 });
  }
  return out;
}

/** the highest surface over a point (a sea covers the whole place), or null */
export function surfaceAt(volumes: readonly LiquidVolume[]): number | null {
  let level: number | null = null;
  for (const v of volumes) if (level === null || v.level > level) level = v.level;
  return level;
}

/** feet height at which a character of this height floats */
export const floatLine = (level: number, height: number): number => level - SWIM_DEPTH_SHARE * height;

/**
 * The vertical velocity a character may have this tick: `vy` unless the move would end below the float line, then the one
 * that ends exactly on it (a body that is already deeper, after a teleport, comes up to the line in that tick).
 */
export function swimVelocity(feetY: number, vy: number, dt: number, level: number, height: number): number {
  const line = floatLine(level, height);
  return feetY + vy * dt < line ? (line - feetY) / dt : vy;
}

/** the state after a step; `eps` absorbs the float32 of the body's position */
export function liquidState(feetY: number, height: number, level: number | null, eps = 1e-3): LiquidState {
  if (level === null) return { in: false, level: null, swimming: false };
  return { in: feetY < level, level, swimming: feetY <= floatLine(level, height) + eps };
}
