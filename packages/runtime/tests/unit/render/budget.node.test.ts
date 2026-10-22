// WP R0: the tier table (render §15.1) and `RenderBudget.cap()` (render §15.3; X-21): `min(profile, tier)` for every kind and
// tier. The module is boot code (H05 `src/game-api/gore-caps.ts` reads it before the engine chunk loads), so it must stay free
// of three.js: the import graph is checked at the end.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  BUDGET_KINDS,
  TIER_IDS,
  TIER_TABLE,
  createRenderBudget,
  tierCap,
  tierConfig,
  type BudgetKind,
  type TierId,
} from '../../../src/render/perf/budget.ts';

/** render §15.1, the rows `cap()` reads, typed out again so a table edit has to be made twice */
const EXPECTED: Record<TierId, Record<BudgetKind, number>> = {
  high: { gibs: Infinity, corpses: Infinity, decals: 2048, particles: 30_000, fxLights: Infinity },
  medium: { gibs: Infinity, corpses: Infinity, decals: 1536, particles: 15_000, fxLights: Infinity },
  low: { gibs: Infinity, corpses: Infinity, decals: 1024, particles: 8_000, fxLights: 8 },
  minimum: { gibs: Infinity, corpses: Infinity, decals: 512, particles: 4_000, fxLights: 4 },
};

describe('tier table (render §15.1)', () => {
  it('has the four tiers in order, each row naming itself', () => {
    expect(TIER_IDS).toEqual(['high', 'medium', 'low', 'minimum']);
    expect(Object.keys(TIER_TABLE)).toEqual([...TIER_IDS]);
    for (const id of TIER_IDS) expect(tierConfig(id).id).toBe(id);
  });

  it('DPR cap / pixel cap / start render scale / dynamic-resolution range', () => {
    const row = (id: TierId) => {
      const t = TIER_TABLE[id];
      return [t.maxDpr, t.maxPixels, t.startRenderScale, t.renderScaleRange];
    };
    expect(row('high')).toEqual([1.5, 2_600_000, 1.0, [0.75, 1.0]]);
    expect(row('medium')).toEqual([1.0, 2_600_000, 1.0, [0.7, 1.0]]);
    expect(row('low')).toEqual([1.0, 2_100_000, 0.8, [0.6, 0.9]]);
    expect(row('minimum')).toEqual([1.0, 1_000_000, 0.65, [0.5, 0.75]]);
    for (const id of TIER_IDS) {
      const t = TIER_TABLE[id];
      expect(t.startRenderScale).toBeGreaterThanOrEqual(t.renderScaleRange[0]);
      expect(t.startRenderScale).toBeLessThanOrEqual(t.renderScaleRange[1]);
    }
  });

  it('geometry, lights, shadow, post and fx rows', () => {
    expect(TIER_TABLE.high).toMatchObject({ lods: [1, 3, 5], lodPolicy: 'hybrid', lodDistances: [30, 80], lightsPerCell: 24, dynamicLights: 16 });
    expect(TIER_TABLE.medium).toMatchObject({ lods: [1, 3, 5], lodPolicy: 'hybrid', lodDistances: [20, 60], lightsPerCell: 16, dynamicLights: 8 });
    expect(TIER_TABLE.low).toMatchObject({ lods: [3, 5], lodPolicy: 'mergeAll', lodDistances: [50], lightsPerCell: 8, dynamicLights: 4 });
    // DR-35 lever 5 (WP R3): the 3 → 5 switch of `minimum` came in from 40 m to 25 m so that the map fits 350,000 triangles
    expect(TIER_TABLE.minimum).toMatchObject({ lods: [3, 5], lodPolicy: 'mergeAll', lodDistances: [25], lightsPerCell: 6, dynamicLights: 2 });
    expect(TIER_IDS.map((id) => TIER_TABLE[id].shadowCasterMapSize)).toEqual([1024, 512, 0, 0]);
    expect(TIER_IDS.map((id) => TIER_TABLE[id].fxaa)).toEqual(['option', 'option', 'off', 'off']);
    expect(TIER_IDS.map((id) => TIER_TABLE[id].distort)).toEqual([true, true, false, false]);
    expect(TIER_IDS.map((id) => TIER_TABLE[id].lookPath)).toEqual(['tsl', 'tsl', 'lut', 'lut']);
    expect(TIER_IDS.map((id) => TIER_TABLE[id].fxHeldFactor)).toEqual([1, 1, 0.5, 0.35]);
    expect(TIER_IDS.map((id) => TIER_TABLE[id].fxLowVariants)).toEqual([false, false, true, true]);
    expect(TIER_IDS.map((id) => TIER_TABLE[id].drawCallBudget)).toEqual([400, 380, 240, 200]);
    expect(TIER_IDS.map((id) => TIER_TABLE[id].triangleBudget)).toEqual([1_500_000, 1_000_000, 600_000, 350_000]);
  });

  it('half float output and a half-resolution bloom on every tier, `minimum` included (render §3.1, §3.3)', () => {
    for (const id of TIER_IDS) {
      expect(TIER_TABLE[id].outputBuffer, id).toBe('half-float');
      expect(TIER_TABLE[id].bloomResolution, id).toBe(0.5);
    }
  });

  it('is frozen: a tier row cannot be edited at run time', () => {
    expect(Object.isFrozen(TIER_TABLE)).toBe(true);
    for (const id of TIER_IDS) {
      expect(Object.isFrozen(TIER_TABLE[id]), id).toBe(true);
      expect(Object.isFrozen(TIER_TABLE[id].renderScaleRange), id).toBe(true);
    }
  });

  it('core tiers leave optional plugin caps to the host', () => {
    expect([TIER_TABLE.high.gibs, TIER_TABLE.high.corpses]).toEqual([Infinity, Infinity]);
  });
});

describe('RenderBudget.cap() = min(profile, tier) (render §15.3)', () => {
  it('every kind on every tier matches the table', () => {
    expect(BUDGET_KINDS).toEqual(['gibs', 'corpses', 'decals', 'particles', 'fxLights']);
    for (const tier of TIER_IDS) for (const kind of BUDGET_KINDS) expect(tierCap(tier, kind), `${tier}.${kind}`).toBe(EXPECTED[tier][kind]);
  });

  it('profile below, equal to and above the tier cap, for 5 kinds × 4 tiers', () => {
    let checked = 0;
    for (const tier of TIER_IDS) {
      const budget = createRenderBudget(tier);
      expect(budget.tier).toBe(tier);
      for (const kind of BUDGET_KINDS) {
        const cap = EXPECTED[tier][kind];
        if (Number.isFinite(cap)) {
          expect(budget.cap(kind, cap - 1), `${tier}.${kind} below`).toBe(cap - 1);
          expect(budget.cap(kind, cap), `${tier}.${kind} equal`).toBe(cap);
          expect(budget.cap(kind, cap + 1), `${tier}.${kind} above`).toBe(cap);
          expect(budget.cap(kind, cap * 10), `${tier}.${kind} far above`).toBe(cap);
        } else {
          // "all": the tier sets no limit, the profile cap passes through
          expect(budget.cap(kind, 3), `${tier}.${kind} no tier limit`).toBe(3);
          expect(budget.cap(kind, 1e9), `${tier}.${kind} no tier limit`).toBe(1e9);
        }
        expect(budget.cap(kind, 0), `${tier}.${kind} zero`).toBe(0);
        checked++;
      }
    }
    expect(checked).toBe(20);
  });

  it('an unlimited profile gets the tier cap', () => {
    expect(createRenderBudget('low').cap('gibs', Infinity)).toBe(Infinity);
    expect(createRenderBudget('high').cap('fxLights', Infinity)).toBe(Infinity);
  });

  it('injected plugin ceilings clamp a profile on every tier below high', () => {
    const caps = TIER_IDS.map((t) => [createRenderBudget(t, { high: { gibs: 220, corpses: 64 }, medium: { gibs: 160, corpses: 48 }, low: { gibs: 80, corpses: 24 }, minimum: { gibs: 40, corpses: 12 } }).cap('gibs', 220), createRenderBudget(t, { high: { gibs: 220, corpses: 64 }, medium: { gibs: 160, corpses: 48 }, low: { gibs: 80, corpses: 24 }, minimum: { gibs: 40, corpses: 12 } }).cap('corpses', 64)]);
    expect(caps).toEqual([[220, 64], [160, 48], [80, 24], [40, 12]]);
  });

  it('follows a live tier source, so a mid-session tier drop takes effect at once', () => {
    let tier: TierId = 'high';
    const budget = createRenderBudget(() => tier, { high: { gibs: 220, corpses: 64 }, medium: { gibs: 160, corpses: 48 }, low: { gibs: 80, corpses: 24 }, minimum: { gibs: 40, corpses: 12 } });
    expect(budget.cap('corpses', 64)).toBe(64);
    tier = 'minimum';
    expect(budget.tier).toBe('minimum');
    expect(budget.cap('corpses', 64)).toBe(12);
  });

  it('rejects a profile cap that is not a count', () => {
    const budget = createRenderBudget('high');
    expect(() => budget.cap('gibs', Number.NaN)).toThrow(RangeError);
    expect(() => budget.cap('gibs', -1)).toThrow(RangeError);
    expect(() => budget.cap('teeth' as BudgetKind, 1)).toThrow(RangeError);
  });
});

describe('boot code', () => {
  it('budget.ts and tiers.ts import no three.js and nothing from the engine modules', () => {
    for (const file of ['budget.ts', 'tiers.ts']) {
      const src = readFileSync(new URL(`../../../src/render/perf/${file}`, import.meta.url), 'utf8');
      const specs = [...src.matchAll(/^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]!);
      for (const s of specs) {
        expect(s, `${file} imports ${s}`).not.toMatch(/^three(\/|$)/);
        expect(s, `${file} imports ${s}`).toMatch(/^\.\/(budget|tiers)\.ts$/);
      }
    }
  });
});
