// WP R0: canvas host (render §3.3). The Playgama aspect clamp (0.5 ≤ width/height ≤ 2.0, centred with margins, never stretched),
// the device-pixel rule r = min(devicePixelRatio, tier.maxDpr, sqrt(tier.maxPixels / (cssW · cssH))), the resize debounce to one
// animation frame, and the render scale that reaches the scene pass only. Plain Node: the canvas and its environment are fakes;
// the canvas replacement against a real DOM is canvas-host.dom.test.ts.
import { describe, expect, it } from 'vitest';
import {
  RENDER_SCALE_MAX,
  RENDER_SCALE_MIN,
  backingStoreSize,
  capPixelRatio,
  clampAspect,
  createCanvasHost,
  type CanvasEnv,
  type CanvasHostControl,
  type SizeTarget,
} from '../../../src/render/engine/canvas-host.ts';
import { TIER_IDS, TIER_TABLE } from '../../../src/render/perf/budget.ts';

const ASPECT_MIN = 0.5, ASPECT_MAX = 2;

describe('clampAspect: the active field (platform-playgama §9.1)', () => {
  it('leaves an in-range area untouched', () => {
    expect(clampAspect(1920, 1080, [ASPECT_MIN, ASPECT_MAX])).toEqual({ x: 0, y: 0, width: 1920, height: 1080 });
    expect(clampAspect(640, 360, [ASPECT_MIN, ASPECT_MAX])).toEqual({ x: 0, y: 0, width: 640, height: 360 });
    expect(clampAspect(1080, 1920, [ASPECT_MIN, ASPECT_MAX])).toEqual({ x: 0, y: 0, width: 1080, height: 1920 });
    expect(clampAspect(1000, 1000, [ASPECT_MIN, ASPECT_MAX])).toEqual({ x: 0, y: 0, width: 1000, height: 1000 });
  });

  it('exactly 2:1 and exactly 1:2 are in range', () => {
    expect(clampAspect(2000, 1000, [ASPECT_MIN, ASPECT_MAX])).toEqual({ x: 0, y: 0, width: 2000, height: 1000 });
    expect(clampAspect(1000, 2000, [ASPECT_MIN, ASPECT_MAX])).toEqual({ x: 0, y: 0, width: 1000, height: 2000 });
  });

  it('wider than 2:1 → the field is 2:1, centred, with side margins', () => {
    expect(clampAspect(3000, 1000, [ASPECT_MIN, ASPECT_MAX])).toEqual({ x: 500, y: 0, width: 2000, height: 1000 });
    expect(clampAspect(3440, 1440, [ASPECT_MIN, ASPECT_MAX])).toEqual({ x: 280, y: 0, width: 2880, height: 1440 }); // a 21:9 monitor
    expect(clampAspect(5120, 1440, [ASPECT_MIN, ASPECT_MAX])).toEqual({ x: 1120, y: 0, width: 2880, height: 1440 }); // 32:9
  });

  it('narrower than 1:2 → the field is 1:2, centred, with top and bottom margins', () => {
    expect(clampAspect(400, 1000, [ASPECT_MIN, ASPECT_MAX])).toEqual({ x: 0, y: 100, width: 400, height: 800 });
    expect(clampAspect(360, 880, [ASPECT_MIN, ASPECT_MAX])).toEqual({ x: 0, y: 80, width: 360, height: 720 }); // a tall phone in portrait
  });

  it('the field never leaves the range and never exceeds the area, over a sweep', () => {
    expect([ASPECT_MIN, ASPECT_MAX]).toEqual([0.5, 2.0]);
    for (let w = 1; w <= 4001; w += 137) {
      for (let h = 1; h <= 4001; h += 149) {
        const f = clampAspect(w, h, [ASPECT_MIN, ASPECT_MAX]);
        expect(f.width).toBeLessThanOrEqual(w);
        expect(f.height).toBeLessThanOrEqual(h);
        expect(f.width).toBeGreaterThanOrEqual(1);
        expect(f.height).toBeGreaterThanOrEqual(1);
        expect(Number.isInteger(f.width) && Number.isInteger(f.height) && Number.isInteger(f.x) && Number.isInteger(f.y)).toBe(true);
        // centred: the two margins differ by at most the rounding pixel
        expect(Math.abs(w - f.width - 2 * f.x)).toBeLessThanOrEqual(1);
        expect(Math.abs(h - f.height - 2 * f.y)).toBeLessThanOrEqual(1);
        if (w >= 4 && h >= 4) {
          expect(f.width / f.height, `${w}x${h}`).toBeLessThanOrEqual(ASPECT_MAX + 1e-9);
          expect(f.width / f.height, `${w}x${h}`).toBeGreaterThanOrEqual(ASPECT_MIN - 1e-9);
        }
      }
    }
  });

  it('a collapsed or unmeasured area still gives a 1 × 1 field', () => {
    expect(clampAspect(0, 0, [ASPECT_MIN, ASPECT_MAX])).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(clampAspect(Number.NaN, 500, [ASPECT_MIN, ASPECT_MAX])).toMatchObject({ width: 1 });
  });
});

describe('capPixelRatio: r = min(dpr, tier.maxDpr, sqrt(maxPixels / (cssW · cssH)))', () => {
  const px = (w: number, h: number, dpr: number, tier: (typeof TIER_IDS)[number]) => {
    const r = capPixelRatio(w, h, dpr, TIER_TABLE[tier]);
    return { r, ...backingStoreSize(w, h, r) };
  };

  it('a 3840 × 2160 field at DPR 1 on `high` is held to ≤ 2.6 Mpx (r ≈ 0.56)', () => {
    const { r, pxW, pxH } = px(3840, 2160, 1, 'high');
    expect(r).toBeCloseTo(Math.sqrt(2_600_000 / (3840 * 2160)), 12);
    expect(r).toBeCloseTo(0.56, 2);
    expect(pxW * pxH).toBeLessThanOrEqual(2_600_000);
    expect(pxW * pxH).toBeGreaterThan(2_590_000); // capped, not thrown away
    expect(pxW / pxH).toBeCloseTo(16 / 9, 2);
  });

  it('1920 × 1080 at DPR 1 is untouched', () => {
    expect(px(1920, 1080, 1, 'high')).toEqual({ r: 1, pxW: 1920, pxH: 1080 });
    expect(px(1920, 1080, 1, 'medium')).toEqual({ r: 1, pxW: 1920, pxH: 1080 });
  });

  it('the DPR cap is 1.5 on `high` and 1.0 on the others', () => {
    expect(px(1280, 720, 2, 'high')).toEqual({ r: 1.5, pxW: 1920, pxH: 1080 });
    expect(px(1280, 720, 3, 'high').r).toBe(1.5);
    expect(px(1280, 720, 1.25, 'high').r).toBe(1.25);
    for (const tier of ['medium', 'low', 'minimum'] as const) expect(px(640, 360, 3, tier).r, tier).toBe(1);
  });

  it('the pixel cap, not the DPR cap, decides on a 1440p display at 150 %', () => {
    // css 1707 × 960 at DPR 1.5 is 2560 × 1440 = 3.69 Mpx: the DPR cap alone would allow it
    const { r, pxW, pxH } = px(1707, 960, 1.5, 'high');
    expect(r).toBeLessThan(1.5);
    expect(pxW * pxH).toBeLessThanOrEqual(2_600_000);
  });

  it('`minimum` holds 1.0 Mpx and `low` 2.1 Mpx', () => {
    const min = px(1920, 1080, 1, 'minimum');
    expect(min.pxW * min.pxH).toBeLessThanOrEqual(1_000_000);
    expect(min.pxW * min.pxH).toBeGreaterThan(990_000);
    const low = px(2560, 1440, 1, 'low');
    expect(low.pxW * low.pxH).toBeLessThanOrEqual(2_100_000);
  });

  it('the backing store never exceeds the tier cap, over a sweep of sizes, ratios and tiers', () => {
    for (const tier of TIER_IDS) {
      for (const dpr of [0.75, 1, 1.25, 1.5, 2, 2.625, 3]) {
        for (const [w, h] of [[320, 568], [640, 360], [1366, 768], [1920, 1080], [2560, 1440], [3440, 1720], [3840, 2160], [7680, 4320], [1080, 2160]] as const) {
          const { r, pxW, pxH } = px(w, h, dpr, tier);
          expect(r, `${tier} ${w}x${h}@${dpr}`).toBeLessThanOrEqual(Math.min(dpr, TIER_TABLE[tier].maxDpr));
          expect(pxW * pxH, `${tier} ${w}x${h}@${dpr}`).toBeLessThanOrEqual(TIER_TABLE[tier].maxPixels);
          expect(pxW).toBeGreaterThanOrEqual(1);
          expect(pxH).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  it('a missing or broken devicePixelRatio counts as 1', () => {
    expect(capPixelRatio(640, 360, Number.NaN, TIER_TABLE.high)).toBe(1);
    expect(capPixelRatio(640, 360, 0, TIER_TABLE.high)).toBe(1);
  });

  it('backingStoreSize floors like three’s setSize', () => {
    expect(backingStoreSize(641, 361, 1.5)).toEqual({ pxW: 961, pxH: 541 });
    expect(backingStoreSize(1, 1, 0.1)).toEqual({ pxW: 1, pxH: 1 });
  });
});

// ── the host on a fake canvas ────────────────────────────────────────────────────────────────────────────────────────────

interface Rig {
  host: CanvasHostControl;
  canvas: { style: Record<string, string> };
  area: { left: number; top: number; width: number; height: number };
  dpr: { value: number };
  /** what the environment's change observer was given; calling it is "the window was resized" */
  changed: () => void;
  observers: { started: number; stopped: number };
  calls: Array<['ratio', number] | ['size', number, number, boolean | undefined]>;
  target: SizeTarget;
}

function rig(opts: { tier?: (typeof TIER_IDS)[number]; width?: number; height?: number; dpr?: number; left?: number; top?: number; styleCanvas?: boolean } = {}): Rig {
  const canvas = { style: {} as Record<string, string> };
  const area = { left: opts.left ?? 0, top: opts.top ?? 0, width: opts.width ?? 1280, height: opts.height ?? 720 };
  const dpr = { value: opts.dpr ?? 1 };
  const calls: Rig['calls'] = [];
  const observers = { started: 0, stopped: 0 };
  let changed: () => void = () => {
    throw new Error('not observed');
  };
  const env: Partial<CanvasEnv> = {
    devicePixelRatio: () => dpr.value,
    available: () => ({ ...area }),
    observe: (_c, cb) => {
      observers.started++;
      changed = cb;
      return () => void observers.stopped++;
    },
  };
  const target: SizeTarget = {
    setPixelRatio: (r) => void calls.push(['ratio', r]),
    setSize: (w, h, updateStyle) => void calls.push(['size', w, h, updateStyle]),
  };
  const host = createCanvasHost({
    aspectRange: [ASPECT_MIN, ASPECT_MAX],
    canvas: canvas as unknown as HTMLCanvasElement,
    tier: TIER_TABLE[opts.tier ?? 'high'],
    target,
    env,
    ...(opts.styleCanvas === undefined ? {} : { styleCanvas: opts.styleCanvas }),
  });
  return { host, canvas, area, dpr, changed: () => changed(), observers, calls, target };
}

describe('createCanvasHost', () => {
  it('sizes the renderer at creation: setPixelRatio(r), then setSize(cssW, cssH, false) (the CSS size is ours)', () => {
    const r = rig({ width: 1280, height: 720, dpr: 2 });
    expect(r.calls).toEqual([['ratio', 1.5], ['size', 1280, 720, false]]);
    expect(r.host.size).toEqual({ cssW: 1280, cssH: 720, pxW: 1920, pxH: 1080, aspect: 1280 / 720, pixelRatio: 1.5 });
  });

  it('holds a 3840 × 2160 backing store to ≤ 2.6 Mpx on `high`', () => {
    const r = rig({ width: 3840, height: 2160, dpr: 1, tier: 'high' });
    const { pxW, pxH, cssW, cssH } = r.host.size;
    expect([cssW, cssH]).toEqual([3840, 2160]);
    expect(pxW * pxH).toBeLessThanOrEqual(2_600_000);
    expect(r.calls[0]![1]).toBeCloseTo(0.5599, 3);
  });

  it('cssRect is the active field after the aspect clamp, in viewport coordinates', () => {
    const wide = rig({ width: 3000, height: 1000, left: 10, top: 20 });
    expect(wide.host.cssRect).toMatchObject({ x: 510, y: 20, left: 510, top: 20, width: 2000, height: 1000, right: 2510, bottom: 1020 });
    expect(wide.host.size).toMatchObject({ cssW: 2000, cssH: 1000, aspect: 2 });
    const tall = rig({ width: 400, height: 1000 });
    expect(tall.host.cssRect).toMatchObject({ x: 0, y: 100, width: 400, height: 800 });
    expect(tall.host.size.aspect).toBe(0.5);
    const plain = rig({ width: 1280, height: 720 });
    expect(plain.host.cssRect).toMatchObject({ x: 0, y: 0, width: 1280, height: 720 });
  });

  it('centres the canvas in its area with margins and never stretches it', () => {
    const r = rig({ width: 3000, height: 1000 });
    expect(r.canvas.style).toMatchObject({ position: 'absolute', left: '500px', top: '0px', width: '2000px', height: '1000px' });
    const untouched = rig({ width: 3000, height: 1000, styleCanvas: false });
    expect(untouched.canvas.style).toEqual({});
  });

  it('a resize is debounced: nothing is applied until the frame flushes it, and then once', () => {
    const r = rig({ width: 1280, height: 720 });
    const seen: unknown[] = [];
    r.host.onResize((s) => seen.push(s));
    r.calls.length = 0;

    r.area.width = 1000;
    r.changed();
    r.area.width = 800;
    r.area.height = 600;
    r.changed();
    expect(r.calls).toEqual([]);
    expect(seen).toEqual([]);
    expect(r.host.size.cssW).toBe(1280);

    expect(r.host.flush()).toBe(true);
    expect(r.calls).toEqual([['ratio', 1], ['size', 800, 600, false]]);
    expect(seen).toEqual([{ cssW: 800, cssH: 600, pxW: 800, pxH: 600, aspect: 800 / 600 }]);

    expect(r.host.flush()).toBe(false);
    expect(seen).toHaveLength(1);
  });

  it('a change notice that changes nothing applies nothing', () => {
    const r = rig();
    r.calls.length = 0;
    let n = 0;
    r.host.onResize(() => n++);
    r.changed();
    expect(r.host.flush()).toBe(false);
    expect(r.calls).toEqual([]);
    expect(n).toBe(0);
  });

  it('a devicePixelRatio change alone resizes the backing store', () => {
    const r = rig({ width: 1280, height: 720, dpr: 1 });
    r.calls.length = 0;
    r.dpr.value = 1.25;
    r.changed();
    expect(r.host.flush()).toBe(true);
    expect(r.calls).toEqual([['ratio', 1.25], ['size', 1280, 720, false]]);
    expect(r.host.size).toMatchObject({ pxW: 1600, pxH: 900 });
  });

  it('a move of the area without a size change updates cssRect and resizes nothing', () => {
    const r = rig({ width: 1280, height: 720 });
    r.calls.length = 0;
    r.area.left = 40;
    r.changed();
    expect(r.host.flush()).toBe(false);
    expect(r.calls).toEqual([]);
    expect(r.host.cssRect.left).toBe(40);
  });

  it('onResize returns an unsubscribe', () => {
    const r = rig();
    let n = 0;
    const off = r.host.onResize(() => n++);
    r.area.width = 900;
    r.changed();
    r.host.flush();
    off();
    r.area.width = 700;
    r.changed();
    r.host.flush();
    expect(n).toBe(1);
  });

  it('setTier applies the new caps at once', () => {
    const r = rig({ width: 1920, height: 1080, dpr: 2, tier: 'high' });
    expect(r.host.size.pixelRatio).toBeCloseTo(Math.sqrt(2_600_000 / (1920 * 1080)), 12);
    r.host.setTier(TIER_TABLE.minimum);
    const { pxW, pxH } = r.host.size;
    expect(pxW * pxH).toBeLessThanOrEqual(1_000_000);
    expect(r.host.renderScale).toBe(0.65);
  });

  it('setTarget hands the current size to a rebuilt renderer', () => {
    const r = rig({ width: 1280, height: 720, dpr: 2 });
    const calls: unknown[] = [];
    r.host.setTarget({ setPixelRatio: (x) => void calls.push(['ratio', x]), setSize: (w, h, s) => void calls.push(['size', w, h, s]) });
    expect(calls).toEqual([['ratio', 1.5], ['size', 1280, 720, false]]);
    r.host.setTarget(null);
    r.area.width = 640;
    r.changed();
    expect(() => r.host.flush()).not.toThrow();
  });

  it('dispose stops observing', () => {
    const r = rig();
    expect(r.observers).toEqual({ started: 1, stopped: 0 });
    r.host.dispose();
    expect(r.observers).toEqual({ started: 1, stopped: 1 });
  });
});

describe('render scale (dynamic resolution through the scene pass only)', () => {
  it('starts at the tier’s start scale and reaches the scene pass when one is bound', () => {
    const r = rig({ tier: 'low' });
    expect(r.host.renderScale).toBe(0.8);
    const scales: number[] = [];
    r.host.bindScenePass({ setResolutionScale: (s) => void scales.push(s) });
    expect(scales).toEqual([0.8]);
    r.host.setRenderScale(0.7);
    expect(scales).toEqual([0.8, 0.7]);
    expect(r.host.renderScale).toBe(0.7);
  });

  it('is clamped to 0.5..1', () => {
    const r = rig();
    expect([RENDER_SCALE_MIN, RENDER_SCALE_MAX]).toEqual([0.5, 1]);
    r.host.setRenderScale(0.2);
    expect(r.host.renderScale).toBe(0.5);
    r.host.setRenderScale(3);
    expect(r.host.renderScale).toBe(1);
    expect(() => r.host.setRenderScale(Number.NaN)).toThrow(RangeError);
  });

  it('never touches the canvas backing store: no setSize, no setPixelRatio', () => {
    const r = rig();
    r.calls.length = 0;
    r.host.bindScenePass({ setResolutionScale: () => undefined });
    r.host.setRenderScale(0.75);
    expect(r.calls).toEqual([]);
    expect(r.host.size).toMatchObject({ pxW: 1280, pxH: 720 });
  });

  it('a pass bound later (R5b’s pipeline) gets the stored scale; unbinding stops the writes', () => {
    const r = rig();
    r.host.setRenderScale(0.6);
    const scales: number[] = [];
    r.host.bindScenePass({ setResolutionScale: (s) => void scales.push(s) });
    expect(scales).toEqual([0.6]);
    r.host.bindScenePass(null);
    r.host.setRenderScale(0.9);
    expect(scales).toEqual([0.6]);
  });
});

describe('clampAspect: a configurable range', () => {
  it('null: the whole area, nothing letterboxed', () => {
    expect(clampAspect(3000, 1000, null)).toEqual({ x: 0, y: 0, width: 3000, height: 1000 });
    expect(clampAspect(500, 2000, null)).toEqual({ x: 0, y: 0, width: 500, height: 2000 });
  });
  it('a wider range lets 3:1 through; the default still clamps it to 2:1 (PP)', () => {
    expect(clampAspect(3000, 1000, [0.5, 3])).toEqual({ x: 0, y: 0, width: 3000, height: 1000 });
    expect(clampAspect(3000, 1000, [ASPECT_MIN, ASPECT_MAX])).toEqual({ x: 500, y: 0, width: 2000, height: 1000 });
    expect(clampAspect(3000, 1000, [0.5, 2])).toEqual(clampAspect(3000, 1000, [ASPECT_MIN, ASPECT_MAX]));
  });
});
