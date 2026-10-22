// Render instrumentation, WP R14a (docs/design/rendering.md §15.5; build §8.8).
//
// Measures what the tier table budgets: per-category and total draw calls / triangles from `renderer.info`,
// the program counter, and `renderer.info.memory`. The budget CI job (R0's `perf/budget.ts`) consumes these
// samples; this module does the measuring.
//
// Per-category breakdown comes from a test-build-only tag: in a test build the budget scenario tags every
// renderable object with its §15.5 category and then measures one category at a time (`isolateCategory` +
// `measureRender`), so every line of the §15.5 table is asserted from `renderer.info` itself. The tag lives
// in a module-level WeakMap and every tagging entry point is gated on `isTestBuild()`; production builds
// never tag, never isolate, and carry no per-category bookkeeping.
//
// This module imports nothing at runtime: no three.js, no engine module (the tier table it checks against
// arrives as a `TierConfig` value from the caller, which owns R0's `perf/budget.ts`). The `renderer.info`
// shapes below mirror three r186 `src/renderers/common/Info.js` (`render.calls` etc. increment on every
// backend draw of the animation frame, `Info.js:158`; `memory` carries per-texture / per-attribute byte
// estimates) but are read defensively, so a partial stub never throws.
import type { TierConfig, TierId } from './budget.ts';

/** the §15.5 draw-call budget rows, in table order */
export const RENDER_CATEGORIES = Object.freeze([
  'post',
  'shadow',
  'map',
  'characters',
  'corpses',
  'gibs',
  'primitives',
  'fx',
  'decals',
  'specials',
] as const);

export type RenderCategory = (typeof RENDER_CATEGORIES)[number];

export function isRenderCategory(x: unknown): x is RenderCategory {
  return typeof x === 'string' && (RENDER_CATEGORIES as readonly string[]).includes(x);
}

/**
 * The §15.5 per-category draw-call lines, as asserted ceilings. Sums: high 342 (budget 400),
 * medium 332 (380), low 199 (240), minimum 176 (200).
 */
export const CATEGORY_BUDGETS: Readonly<Record<TierId, Readonly<Record<RenderCategory, number>>>> = Object.freeze({
  high: Object.freeze({ post: 18, shadow: 50, map: 130, characters: 66, corpses: 2, gibs: 8, primitives: 30, fx: 15, decals: 3, specials: 20 }),
  medium: Object.freeze({ post: 18, shadow: 50, map: 120, characters: 66, corpses: 2, gibs: 8, primitives: 30, fx: 15, decals: 3, specials: 20 }),
  low: Object.freeze({ post: 14, shadow: 0, map: 80, characters: 38, corpses: 2, gibs: 6, primitives: 25, fx: 12, decals: 2, specials: 20 }),
  minimum: Object.freeze({ post: 14, shadow: 0, map: 70, characters: 38, corpses: 2, gibs: 5, primitives: 20, fx: 10, decals: 2, specials: 15 }),
});

/** the sum of the §15.5 lines for a tier; always below the tier's draw-call budget (the headroom is real) */
export function categoryBudgetSum(tier: TierId): number {
  const row = CATEGORY_BUDGETS[tier];
  if (row === undefined) throw new RangeError(`instrumentation: unknown tier ${JSON.stringify(tier)}`);
  return (Object.values(row) as number[]).reduce((a, b) => a + b, 0);
}

/**
 * The expected post-pass draw count from the tier's post chain (§15.5 "Post" row):
 * background 1 + bloom 12 + output quad 1 + distort ≤ 3 + FXAA 0-1.
 */
export function expectedPostDraws(distort: boolean, fxaaOn: boolean): number {
  return 14 + (distort ? 3 : 0) + (fxaaOn ? 1 : 0);
}

// ── test-build-only category tagging ─────────────────────────────────────────

/** Explicitly enabled by a host test harness. */
let testInstrumentation = false;
/** Hosts explicitly enable category measurements for their test harness. */
export function setTestInstrumentation(enabled: boolean): void { testInstrumentation = enabled; }
export function isTestBuild(): boolean { return testInstrumentation; }

const categoryTags = new WeakMap<object, RenderCategory>();

/**
 * Tags an object with its §15.5 category. Test builds only: a no-op elsewhere, so a
 * stray call site can never change production rendering. The category itself is
 * always validated. The tag is kept out of `userData`, so tagged objects are
 * byte-identical to untagged ones for the renderer.
 */
export function tagRenderCategory(object: object, category: RenderCategory): void {
  if (!isRenderCategory(category)) throw new RangeError(`instrumentation: unknown render category ${JSON.stringify(category)}`);
  if (!isTestBuild()) return;
  categoryTags.set(object, category);
}

/** the test-build tag of an object, or undefined (always undefined outside test builds) */
export function readRenderCategory(object: object): RenderCategory | undefined {
  if (!isTestBuild()) return undefined;
  return categoryTags.get(object);
}

/** drops one object's tag (test isolation); a no-op outside test builds */
export function untagRenderCategory(object: object): void {
  if (!isTestBuild()) return;
  categoryTags.delete(object);
}

// ── sampling `renderer.info` ─────────────────────────────────────────────────

export interface InfoRenderLike {
  calls: number;
  triangles: number;
  points?: number;
  lines?: number;
}

export interface InfoMemoryLike {
  geometries: number;
  textures: number;
  /** r186: estimated GPU bytes of textures, computed per texture (`Info.js` `memory`) */
  texturesSize?: number | null;
  /** r186: estimated total GPU bytes, computed per texture and attribute */
  total?: number | null;
}

/** the surface of three r186 `renderer.info` this module reads */
export interface RendererInfoLike {
  render: InfoRenderLike;
  /** r186 `info.programs`: one entry per compiled program */
  programs?: { readonly length: number } | null;
  memory?: InfoMemoryLike;
  reset?(): void;
}

export interface FrameSample {
  drawCalls: number;
  triangles: number;
  points: number;
  lines: number;
  /** the program counter (`info.programs.length`); null when the info object carries none */
  programs: number | null;
  memoryGeometries: number;
  memoryTextures: number;
  /** `info.memory.texturesSize`; null when three did not report it */
  memoryTextureBytes: number | null;
  /** `info.memory.total`; null when three did not report it */
  memoryTotalBytes: number | null;
}

const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
const numOrNull = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** reads one frame's counters out of `renderer.info`; never throws on a partial stub */
export function sampleRendererInfo(info: RendererInfoLike): FrameSample {
  const render = info.render ?? { calls: 0, triangles: 0 };
  const memory = info.memory;
  const programs = info.programs;
  return {
    drawCalls: num(render.calls),
    triangles: num(render.triangles),
    points: num(render.points),
    lines: num(render.lines),
    programs: programs !== undefined && programs !== null ? numOrNull(programs.length) : null,
    memoryGeometries: memory === undefined ? 0 : num(memory.geometries),
    memoryTextures: memory === undefined ? 0 : num(memory.textures),
    memoryTextureBytes: memory === undefined ? null : numOrNull(memory.texturesSize),
    memoryTotalBytes: memory === undefined ? null : numOrNull(memory.total),
  };
}

/** zeroes the per-frame counters when the info object supports it (three's `info.reset()`) */
export function resetRendererInfo(info: RendererInfoLike): void {
  if (typeof info.reset === 'function') info.reset();
}

/**
 * Measures one render: zeroes the counters, runs `render`, and returns the frame's
 * sample, i.e. the delta that render produced. (With three's default `autoReset`
 * the renderer zeroes the counters at the start of each `render()` anyway; the
 * explicit reset makes the measurement independent of that setting.)
 */
export function measureRender(info: RendererInfoLike, render: () => void): FrameSample {
  resetRendererInfo(info);
  render();
  return sampleRendererInfo(info);
}

// ── per-category measurement (test builds) ───────────────────────────────────

/** the structural surface of a scene-graph node `isolateCategory` walks */
export interface CategoryNode {
  visible: boolean;
  children?: Iterable<CategoryNode>;
  traverse?: (cb: (node: CategoryNode) => void) => void;
}

export interface IsolateOptions {
  /**
   * What happens to objects carrying no tag: `'hide'` (default) hides them, so the
   * measured category is exactly the tagged set; `'show'` keeps them visible.
   * Lights, cameras and other non-drawn nodes add no draw calls either way.
   */
  untagged?: 'show' | 'hide';
}

/**
 * Runs `fn` with only `category` visible under `root`, then restores every
 * visibility flag it touched (also when `fn` throws). Test builds only: throws
 * otherwise, because without tags there is nothing meaningful to isolate.
 *
 * The budget scenario uses this for the eight object categories (`map`,
 * `characters`, `corpses`, `gibs`, `primitives`, `fx`, `decals`, `specials`):
 * `isolateCategory(scene, 'map', () => measureRender(info, () => renderScene()))`
 * attributes that category's `renderer.info` delta. The two pass categories are
 * measured around the scenario's own pass renders instead: `post` around the
 * compositor chain on an empty scene, `shadow` around the shadow-pass render —
 * neither is a set of scene objects, so visibility isolation does not apply.
 */
export function isolateCategory<T>(root: CategoryNode, category: RenderCategory, fn: () => T, opts: IsolateOptions = {}): T {
  if (!isTestBuild()) throw new Error('instrumentation.isolateCategory is test-build-only (no category tags exist in production builds)');
  if (!isRenderCategory(category)) throw new RangeError(`instrumentation: unknown render category ${JSON.stringify(category)}`);
  const showUntagged = (opts.untagged ?? 'hide') === 'show';

  const nodes: CategoryNode[] = [];
  if (typeof root.traverse === 'function') {
    root.traverse((n) => {
      if (n !== root) nodes.push(n);
    });
  } else if (root.children !== undefined) {
    for (const c of root.children) nodes.push(c);
  }

  const prev = nodes.map((n) => n.visible);
  try {
    for (const n of nodes) {
      const tag = categoryTags.get(n);
      n.visible = tag === category || (tag === undefined && showUntagged);
    }
    return fn();
  } finally {
    for (let i = 0; i < nodes.length; i++) nodes[i]!.visible = prev[i]!;
  }
}

// ── asserting the tier budgets ────────────────────────────────────────────────

export interface CategoryMeasurement {
  category: RenderCategory;
  drawCalls: number;
  triangles: number;
}

export interface CategoryBudgetResult {
  category: RenderCategory;
  drawCalls: number;
  budget: number;
  ok: boolean;
}

export interface FrameBudgetCheck {
  tier: TierId;
  drawCalls: number;
  drawCallBudget: number;
  drawCallsOk: boolean;
  triangles: number;
  triangleBudget: number;
  trianglesOk: boolean;
  categories: CategoryBudgetResult[];
  /** the measured per-category draw calls, for the "each line" report */
  categoryDrawCalls: number;
  ok: boolean;
}

/**
 * Checks one measured frame against the tier table: the totals against
 * `TierConfig.drawCallBudget` / `triangleBudget` (§15.1) and every §15.5 category
 * line against `CATEGORY_BUDGETS`. Requires exactly one measurement per known
 * category — that is the "each line" assertion; a missing or duplicate line is a
 * hard error, not a pass.
 */
export function checkFrameBudgets(
  config: TierConfig,
  total: Pick<FrameSample, 'drawCalls' | 'triangles'>,
  categories: readonly CategoryMeasurement[],
): FrameBudgetCheck {
  const budgets = CATEGORY_BUDGETS[config.id];
  if (budgets === undefined) throw new RangeError(`instrumentation: unknown tier ${JSON.stringify(config.id)}`);
  if (categories.length !== RENDER_CATEGORIES.length) {
    throw new RangeError(
      `instrumentation: expected one measurement per category (${RENDER_CATEGORIES.length}), got ${categories.length}`,
    );
  }
  const seen = new Set<RenderCategory>();
  const results: CategoryBudgetResult[] = categories.map((m) => {
    if (!isRenderCategory(m.category)) throw new RangeError(`instrumentation: unknown render category ${JSON.stringify(m.category)}`);
    if (seen.has(m.category)) throw new RangeError(`instrumentation: duplicate measurement for category ${m.category}`);
    seen.add(m.category);
    const budget = budgets[m.category];
    const ok = m.drawCalls <= budget;
    return { category: m.category, drawCalls: m.drawCalls, budget, ok };
  });

  const drawCallsOk = total.drawCalls <= config.drawCallBudget;
  const trianglesOk = total.triangles <= config.triangleBudget;
  const categoriesOk = results.every((r) => r.ok);
  return {
    tier: config.id,
    drawCalls: total.drawCalls,
    drawCallBudget: config.drawCallBudget,
    drawCallsOk,
    triangles: total.triangles,
    triangleBudget: config.triangleBudget,
    trianglesOk,
    categories: results,
    categoryDrawCalls: results.reduce((a, r) => a + r.drawCalls, 0),
    ok: drawCallsOk && trianglesOk && categoriesOk,
  };
}
