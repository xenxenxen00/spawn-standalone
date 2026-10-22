// WP R14a: render instrumentation (docs/design/rendering.md §15.5; build §8.8):
// the §15.5 category table, test-build-only tagging, `renderer.info` sampling,
// per-category isolation, and the tier-budget check the budget CI job calls.
import { beforeEach, describe, expect, it } from 'vitest';
import { TIER_IDS, TIER_TABLE, tierConfig } from '../../../src/render/perf/budget.ts';
import {
  CATEGORY_BUDGETS,
  RENDER_CATEGORIES,
  categoryBudgetSum,
  checkFrameBudgets,
  expectedPostDraws,
  isRenderCategory,
  isTestBuild,
  setTestInstrumentation,
  isolateCategory,
  measureRender,
  readRenderCategory,
  resetRendererInfo,
  sampleRendererInfo,
  tagRenderCategory,
  untagRenderCategory,
  type CategoryNode,
  type RendererInfoLike,
} from '../../../src/render/perf/instrumentation.ts';

const savedFlag = isTestBuild();

function asTestBuild(on: boolean): void {
  setTestInstrumentation(on);
}

describe('category table (render §15.5)', () => {
  it('has the ten categories in table order', () => {
    expect([...RENDER_CATEGORIES]).toEqual([
      'post', 'shadow', 'map', 'characters', 'corpses', 'gibs', 'primitives', 'fx', 'decals', 'specials',
    ]);
    for (const c of RENDER_CATEGORIES) expect(isRenderCategory(c)).toBe(true);
    expect(isRenderCategory('teeth')).toBe(false);
    expect(isRenderCategory(undefined)).toBe(false);
  });

  it('matches the §15.5 lines exactly', () => {
    expect(CATEGORY_BUDGETS.high).toEqual({ post: 18, shadow: 50, map: 130, characters: 66, corpses: 2, gibs: 8, primitives: 30, fx: 15, decals: 3, specials: 20 });
    expect(CATEGORY_BUDGETS.medium).toEqual({ post: 18, shadow: 50, map: 120, characters: 66, corpses: 2, gibs: 8, primitives: 30, fx: 15, decals: 3, specials: 20 });
    expect(CATEGORY_BUDGETS.low).toEqual({ post: 14, shadow: 0, map: 80, characters: 38, corpses: 2, gibs: 6, primitives: 25, fx: 12, decals: 2, specials: 20 });
    expect(CATEGORY_BUDGETS.minimum).toEqual({ post: 14, shadow: 0, map: 70, characters: 38, corpses: 2, gibs: 5, primitives: 20, fx: 10, decals: 2, specials: 15 });
  });

  it('every tier covers the four tiers and every category', () => {
    expect(Object.keys(CATEGORY_BUDGETS)).toEqual([...TIER_IDS]);
    for (const tier of TIER_IDS) expect(Object.keys(CATEGORY_BUDGETS[tier]!)).toEqual([...RENDER_CATEGORIES]);
  });

  it('the category sums sit below the tier draw-call budgets (the headroom is real)', () => {
    expect(categoryBudgetSum('high')).toBe(342);
    expect(categoryBudgetSum('medium')).toBe(332);
    expect(categoryBudgetSum('low')).toBe(199);
    expect(categoryBudgetSum('minimum')).toBe(176);
    for (const tier of TIER_IDS) expect(categoryBudgetSum(tier)).toBeLessThanOrEqual(TIER_TABLE[tier].drawCallBudget);
  });

  it('rejects an unknown tier', () => {
    expect(() => categoryBudgetSum('ultra' as never)).toThrow(RangeError);
  });
});

describe('expectedPostDraws', () => {
  it('background 1 + bloom 12 + output 1 + distort ≤ 3 + FXAA 0-1', () => {
    expect(expectedPostDraws(true, true)).toBe(18); // high/medium with FXAA on: the §15.5 line
    expect(expectedPostDraws(true, false)).toBe(17);
    expect(expectedPostDraws(false, false)).toBe(14); // low/minimum: the §15.5 line
    expect(expectedPostDraws(false, true)).toBe(15);
  });
});

describe('test-build-only tagging', () => {
  it('is off unless the test-build flag is set', () => {
    asTestBuild(false);
    expect(isTestBuild()).toBe(false);
    const o = {};
    tagRenderCategory(o, 'map'); // no-op, must not throw
    expect(readRenderCategory(o)).toBeUndefined();
    asTestBuild(savedFlag === true);
  });

  it('tags, reads and untags in a test build', () => {
    asTestBuild(true);
    expect(isTestBuild()).toBe(true);
    const a = {};
    const b = {};
    tagRenderCategory(a, 'map');
    tagRenderCategory(b, 'fx');
    expect(readRenderCategory(a)).toBe('map');
    expect(readRenderCategory(b)).toBe('fx');
    untagRenderCategory(a);
    expect(readRenderCategory(a)).toBeUndefined();
    expect(readRenderCategory(b)).toBe('fx');
    untagRenderCategory(b);
    asTestBuild(savedFlag === true);
  });

  it('retags overwrite, and an unknown category always throws', () => {
    asTestBuild(true);
    const o = {};
    tagRenderCategory(o, 'map');
    tagRenderCategory(o, 'decals');
    expect(readRenderCategory(o)).toBe('decals');
    expect(() => tagRenderCategory(o, 'teeth' as never)).toThrow(RangeError);
    asTestBuild(false);
    expect(() => tagRenderCategory(o, 'teeth' as never)).toThrow(RangeError);
    asTestBuild(savedFlag === true);
  });
});

describe('sampling renderer.info', () => {
  const full = (): RendererInfoLike & { render: { calls: number; triangles: number } } => {
    const info: RendererInfoLike = {
      render: { calls: 0, triangles: 0, points: 0, lines: 0 },
      programs: { length: 7 },
      memory: { geometries: 11, textures: 13, texturesSize: 1_000_000, total: 2_000_000 },
      reset() {
        this.render.calls = 0;
        this.render.triangles = 0;
      },
    };
    return info as RendererInfoLike & { render: { calls: number; triangles: number } };
  };

  it('reads the full frame sample', () => {
    const info = full();
    info.render.calls = 342;
    info.render.triangles = 900_000;
    const s = sampleRendererInfo(info);
    expect(s).toEqual({
      drawCalls: 342, triangles: 900_000, points: 0, lines: 0, programs: 7,
      memoryGeometries: 11, memoryTextures: 13, memoryTextureBytes: 1_000_000, memoryTotalBytes: 2_000_000,
    });
  });

  it('never throws on a partial stub: missing figures become 0 / null', () => {
    const s = sampleRendererInfo({ render: { calls: 5, triangles: 10 } });
    expect(s.drawCalls).toBe(5);
    expect(s.triangles).toBe(10);
    expect(s.programs).toBeNull();
    expect(s.memoryTextureBytes).toBeNull();
    expect(s.memoryTotalBytes).toBeNull();
    expect(s.memoryGeometries).toBe(0);
  });

  it('resetRendererInfo calls reset when present and is a no-op otherwise', () => {
    const info = full();
    info.render.calls = 42;
    resetRendererInfo(info);
    expect(info.render.calls).toBe(0);
    expect(() => resetRendererInfo({ render: { calls: 1, triangles: 2 } })).not.toThrow();
  });

  it('measureRender returns the delta of one render', () => {
    const info = full();
    const s = measureRender(info, () => {
      info.render.calls += 130;
      info.render.triangles += 250_000;
    });
    expect(s.drawCalls).toBe(130);
    expect(s.triangles).toBe(250_000);
  });
});

describe('isolateCategory', () => {
  // the flag is read at call time: set it before every test, because the
  // tagging describe above leaves it off when its tests run
  beforeEach(() => asTestBuild(true));

  interface Node extends CategoryNode {
    name: string;
    kids: Node[];
  }
  const node = (name: string, kids: Node[] = []): Node => ({
    name, kids, visible: true,
    children: kids,
    traverse(cb: (n: CategoryNode) => void): void {
      cb(this);
      for (const k of kids) k.traverse?.(cb);
    },
  });

  it('shows only the tagged category and restores visibility afterwards', () => {
    const map1 = node('map1');
    const map2 = node('map2');
    const fx1 = node('fx1');
    const root = node('root', [map1, fx1, node('mid', [map2])]);
    for (const [n, c] of [[map1, 'map'], [map2, 'map'], [fx1, 'fx']] as const) tagRenderCategory(n, c);

    fx1.visible = false; // a pre-existing hidden flag must survive the round trip
    const seen = isolateCategory(root, 'map', () => [map1.visible, map2.visible, fx1.visible, root.visible]);
    expect(seen).toEqual([true, true, false, true]);
    expect(fx1.visible).toBe(false); // restored, not forced visible
    expect(map1.visible).toBe(true);
    for (const n of [map1, map2, fx1]) untagRenderCategory(n);
  });

  it('hides untagged objects by default, shows them with untagged: show', () => {
    asTestBuild(true);
    const tagged = node('tagged');
    const plain = node('plain');
    const root = node('root', [tagged, plain]);
    tagRenderCategory(tagged, 'decals');
    const def = isolateCategory(root, 'decals', () => plain.visible);
    expect(def).toBe(false);
    const shown = isolateCategory(root, 'decals', () => plain.visible, { untagged: 'show' });
    expect(shown).toBe(true);
    untagRenderCategory(tagged);
  });

  it('restores visibility when fn throws', () => {
    asTestBuild(true);
    const a = node('a');
    const root = node('root', [a]);
    tagRenderCategory(a, 'map');
    expect(() => isolateCategory(root, 'fx', () => { throw new Error('boom'); })).toThrow('boom');
    expect(a.visible).toBe(true);
    untagRenderCategory(a);
  });

  it('throws outside test builds and on an unknown category', () => {
    asTestBuild(false);
    const root = node('root');
    expect(() => isolateCategory(root, 'map', () => 0)).toThrow(/test-build-only/);
    asTestBuild(true);
    expect(() => isolateCategory(root, 'teeth' as never, () => 0)).toThrow(RangeError);
  });
});

describe('checkFrameBudgets', () => {
  const allOk = () =>
    [...RENDER_CATEGORIES].map((category) => ({
      category,
      drawCalls: CATEGORY_BUDGETS.high[category]!,
      triangles: 10_000,
    }));

  it('passes a frame inside every budget', () => {
    const check = checkFrameBudgets(tierConfig('high'), { drawCalls: 342, triangles: 1_400_000 }, allOk());
    expect(check.ok).toBe(true);
    expect(check.drawCallsOk).toBe(true);
    expect(check.trianglesOk).toBe(true);
    expect(check.categories.every((c) => c.ok)).toBe(true);
    expect(check.categoryDrawCalls).toBe(342);
  });

  it('fails the exact category that is over its §15.5 line', () => {
    const cats = allOk();
    cats[2]!.drawCalls = CATEGORY_BUDGETS.high.map! + 1; // map: 131 > 130
    const check = checkFrameBudgets(tierConfig('high'), { drawCalls: 343, triangles: 1_400_000 }, cats);
    expect(check.ok).toBe(false);
    expect(check.categories.find((c) => c.category === 'map')!.ok).toBe(false);
    expect(check.categories.filter((c) => !c.ok)).toHaveLength(1);
    expect(check.drawCallsOk).toBe(true); // the total is still inside 400
  });

  it('fails an over-budget total even when every category is inside its line', () => {
    const check = checkFrameBudgets(tierConfig('minimum'), { drawCalls: 201, triangles: 100_000 }, allOk().map((m) => ({
      ...m,
      drawCalls: CATEGORY_BUDGETS.minimum[m.category]!,
    })));
    expect(check.drawCallsOk).toBe(false);
    expect(check.ok).toBe(false);
  });

  it('fails over-budget triangles', () => {
    const check = checkFrameBudgets(tierConfig('low'), { drawCalls: 100, triangles: 600_001 }, allOk().map((m) => ({
      ...m,
      drawCalls: 0,
    })));
    expect(check.trianglesOk).toBe(false);
    expect(check.ok).toBe(false);
  });

  it('requires exactly one measurement per category', () => {
    const config = tierConfig('high');
    const total = { drawCalls: 10, triangles: 10 };
    expect(() => checkFrameBudgets(config, total, [])).toThrow(/one measurement per category/);
    const dup = allOk();
    dup[9] = { ...dup[0]! }; // 'post' twice, 'specials' missing: still 10 lines
    expect(() => checkFrameBudgets(config, total, dup)).toThrow(/duplicate/);
    const unknown = allOk().map((m, i) => (i === 0 ? { ...m, category: 'teeth' as never } : m));
    expect(() => checkFrameBudgets(config, total, unknown)).toThrow(/unknown render category/);
  });
});
