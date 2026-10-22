// The tier table and RenderBudget (docs/design/rendering.md §15.1, §15.3; docs/architecture.md X-21, X-22; WP R0).
//
// Boot code: the app shell reads this before the engine chunk loads (host edit H05, `src/game-api/gore-caps.ts`, writes
// `min(profile cap, tier cap)` into the gore profiles before authored content evaluates), so this module imports
// nothing: no three.js, no engine module (X-26; the chunk-graph test holds it to that).
//
// `TierConfig` is one column of the §15.1 table as data. The render lane reads its rows where they apply (canvas host: DPR and
// pixel caps, render scale; geometry: LODs; lighting: per-cell counts, the shadowCaster shadow; post: FXAA, the look path; fx,
// decals, gore: the ceilings behind `RenderBudget.cap()`).

/** X-22: the four render tiers. SETTINGS offers AUTO / LOW / MEDIUM / HIGH; `minimum` is reached through AUTO or the governor. */
export type TierId = 'high' | 'medium' | 'low' | 'minimum';

/** best first */
export const TIER_IDS = Object.freeze(['high', 'medium', 'low', 'minimum'] as const);

/** what `RenderBudget.cap()` clamps (render §15.3) */
export type BudgetKind = 'gibs' | 'corpses' | 'decals' | 'particles' | 'fxLights';

export const BUDGET_KINDS = Object.freeze(['gibs', 'corpses', 'decals', 'particles', 'fxLights'] as const);

/** one column of the tier table (render §15.1) */
export interface TierConfig {
  readonly id: TierId;

  // canvas (render §3.3)
  /** device-pixel-ratio cap */
  readonly maxDpr: number;
  /** backing-store pixel cap: `r ≤ sqrt(maxPixels / (cssW · cssH))` */
  readonly maxPixels: number;
  /** scene-pass resolution scale at start */
  readonly startRenderScale: number;
  /** dynamic-resolution range of the governor, `[min, max]` of the scene-pass `setResolutionScale` */
  readonly renderScaleRange: readonly [number, number];

  // geometry (render §6.5)
  /** geometry LOD levels built on this tier */
  readonly lods: readonly (1 | 3 | 5)[];
  readonly lodPolicy: 'hybrid' | 'mergeAll';
  /** switch distances in metres, one per LOD step */
  readonly lodDistances: readonly number[];

  // lights (render §8)
  readonly lightsPerCell: number;
  readonly dynamicLights: number;
  /** shadowCaster shadow map edge in texels (`PCFShadowMap`); 0 = no shadow */
  readonly shadowCasterMapSize: number;

  // post (render §10)
  /** bloom resolution as a fraction of the drawing buffer; never scaled with the render scale (render §3.3) */
  readonly bloomResolution: number;
  /** `'option'`: off by default, the player may turn it on; `'off'`: not offered */
  readonly fxaa: 'option' | 'off';
  /** `'tsl'`: the live look as a TSL graph; `'lut'`: the per-colour part through the 3D LUT (render §10.6) */
  readonly lookPath: 'tsl' | 'lut';
  /**
   * The renderer's `outputBufferType`, which the scene pass follows (render §3.1). Half float on every tier; a device that
   * cannot render to half float gets 8-bit from its caps, not from its tier (`DeviceCaps.outputBuffer`).
   */
  readonly outputBuffer: 'half-float';
  /** the distort pass and shockwave offsets */
  readonly distort: boolean;

  // fx (render §13.6)
  /** live particle ceiling */
  readonly particles: number;
  /** multiplier on held (continuous) emitters */
  readonly fxHeldFactor: number;
  /** programs run their `?low` variants */
  readonly fxLowVariants: boolean;
  /** fx lights that reach the light grid: the brightest n; `Infinity` = all */
  readonly fxLights: number;

  // decals and gore (render §12.1, §15.3)
  /** decal ring size (`'uncapped'`; `'live'` is `min(calibration.decalWindow.max, ring)`, the decal system's own rule, X-37) */
  readonly decalRing: number;
  readonly gibs: number;
  readonly corpses: number;

  // assets
  readonly textureSet: 'full' | 'full-1024' | 'mobile-512';

  // budgets asserted in CI (render §15.5)
  /** `renderer.info.render.drawCalls`, every pass */
  readonly drawCallBudget: number;
  /** `renderer.info.render.triangles` per frame */
  readonly triangleBudget: number;
}

const row = (c: TierConfig): TierConfig =>
  Object.freeze({ ...c, renderScaleRange: Object.freeze([...c.renderScaleRange] as [number, number]), lods: Object.freeze([...c.lods]), lodDistances: Object.freeze([...c.lodDistances]) });

/** render §15.1 [D] */
export const TIER_TABLE: Readonly<Record<TierId, TierConfig>> = Object.freeze({
  high: row({
    id: 'high',
    maxDpr: 1.5,
    maxPixels: 2_600_000,
    startRenderScale: 1.0,
    renderScaleRange: [0.75, 1.0],
    lods: [1, 3, 5],
    lodPolicy: 'hybrid',
    lodDistances: [30, 80],
    lightsPerCell: 24,
    dynamicLights: 16,
    shadowCasterMapSize: 1024,
    bloomResolution: 0.5,
    fxaa: 'option',
    lookPath: 'tsl',
    outputBuffer: 'half-float',
    distort: true,
    particles: 30_000,
    fxHeldFactor: 1,
    fxLowVariants: false,
    fxLights: Number.POSITIVE_INFINITY,
    decalRing: 2048,
    gibs: Infinity,
    corpses: Infinity,
    textureSet: 'full',
    drawCallBudget: 400,
    triangleBudget: 1_500_000,
  }),
  medium: row({
    id: 'medium',
    maxDpr: 1.0,
    maxPixels: 2_600_000,
    startRenderScale: 1.0,
    renderScaleRange: [0.7, 1.0],
    lods: [1, 3, 5],
    lodPolicy: 'hybrid',
    lodDistances: [20, 60],
    lightsPerCell: 16,
    dynamicLights: 8,
    shadowCasterMapSize: 512,
    bloomResolution: 0.5,
    fxaa: 'option',
    lookPath: 'tsl',
    outputBuffer: 'half-float',
    distort: true,
    particles: 15_000,
    fxHeldFactor: 1,
    fxLowVariants: false,
    fxLights: Number.POSITIVE_INFINITY,
    decalRing: 1536,
    gibs: Infinity,
    corpses: Infinity,
    textureSet: 'full',
    drawCallBudget: 380,
    triangleBudget: 1_000_000,
  }),
  low: row({
    id: 'low',
    maxDpr: 1.0,
    maxPixels: 2_100_000,
    startRenderScale: 0.8,
    renderScaleRange: [0.6, 0.9],
    lods: [3, 5],
    lodPolicy: 'mergeAll',
    lodDistances: [50],
    lightsPerCell: 8,
    dynamicLights: 4,
    shadowCasterMapSize: 0,
    bloomResolution: 0.5,
    fxaa: 'off',
    lookPath: 'lut',
    outputBuffer: 'half-float',
    distort: false,
    particles: 8_000,
    fxHeldFactor: 0.5,
    fxLowVariants: true,
    fxLights: 8,
    decalRing: 1024,
    gibs: Infinity,
    corpses: Infinity,
    textureSet: 'full-1024',
    drawCallBudget: 240,
    triangleBudget: 600_000,
  }),
  minimum: row({
    id: 'minimum',
    maxDpr: 1.0,
    maxPixels: 1_000_000,
    startRenderScale: 0.65,
    renderScaleRange: [0.5, 0.75],
    lods: [3, 5],
    lodPolicy: 'mergeAll',
    // DR-35 lever 5 (WP R3): 40 m before. With the other levers applied the map alone still passed 350,000 triangles on 6 maps
    // at 40 m (a dense scene 489k); 26 m is the longest distance at which all 19 fit, 25 m leaves a margin
    lodDistances: [25],
    lightsPerCell: 6,
    dynamicLights: 2,
    shadowCasterMapSize: 0,
    bloomResolution: 0.5,
    fxaa: 'off',
    lookPath: 'lut',
    outputBuffer: 'half-float',
    distort: false,
    particles: 4_000,
    fxHeldFactor: 0.35,
    fxLowVariants: true,
    fxLights: 4,
    decalRing: 512,
    gibs: Infinity,
    corpses: Infinity,
    textureSet: 'mobile-512',
    drawCallBudget: 200,
    triangleBudget: 350_000,
  }),
});

export function isTierId(x: unknown): x is TierId {
  return typeof x === 'string' && (TIER_IDS as readonly string[]).includes(x);
}

export function tierConfig(tier: TierId): TierConfig {
  const c = TIER_TABLE[tier];
  if (c === undefined) throw new RangeError(`render tier: unknown tier ${JSON.stringify(tier)}`);
  return c;
}

/** the table row behind each `RenderBudget` kind */
const CAP_ROW: Readonly<Record<BudgetKind, 'gibs' | 'corpses' | 'decalRing' | 'particles' | 'fxLights'>> = Object.freeze({
  gibs: 'gibs',
  corpses: 'corpses',
  decals: 'decalRing',
  particles: 'particles',
  fxLights: 'fxLights',
});

/** The tier's own ceiling for `kind`; `Infinity` where the tier sets none (fx lights on `high` and `medium`). */
export function tierCap(tier: TierId, kind: BudgetKind): number {
  const field = CAP_ROW[kind];
  if (field === undefined) throw new RangeError(`RenderBudget: unknown kind ${JSON.stringify(kind)}`);
  return tierConfig(tier)[field];
}

/** render §15.3: the gore and fx interface */
export interface RenderBudget {
  /** `min(profile, tier)` */
  cap(kind: BudgetKind, profileCap: number): number;
  readonly tier: TierId;
}

/**
 * A budget for a fixed tier (the boot clamp, H05) or for a live tier source (the render ceilings: the gib renderer, corpse
 * pool, decal rings and particle buckets ask on every allocation, so a mid-session tier drop takes effect at once).
 */
export type BudgetCeilings = Partial<Record<TierId, Partial<Record<BudgetKind, number>>>>;
export function createRenderBudget(tier: TierId | (() => TierId), ceilings: BudgetCeilings = {}): RenderBudget {
  const current = typeof tier === 'function' ? tier : (): TierId => tier;
  tierConfig(current()); // an unknown tier fails here, not at the first cap()
  return {
    get tier(): TierId {
      return current();
    },
    cap(kind: BudgetKind, profileCap: number): number {
      if (typeof profileCap !== 'number' || Number.isNaN(profileCap) || profileCap < 0) {
        throw new RangeError(`RenderBudget.cap(${JSON.stringify(kind)}): the profile cap must be a count ≥ 0, got ${String(profileCap)}`);
      }
      const defaultLimit = tierCap(current(), kind);
      const limit = ceilings[current()]?.[kind] ?? defaultLimit;
      if (typeof limit !== 'number' || Number.isNaN(limit) || limit < 0) throw new RangeError('RenderBudget: a ceiling must be a count ≥ 0');
      return Math.min(profileCap, limit);
    },
  };
}
