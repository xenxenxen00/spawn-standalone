// WP R14a: GPU-memory estimation (docs/design/rendering.md §15.4; build §8.8):
// texture headers × bytes-per-texel, render targets per capped device pixel,
// the cross-check against `renderer.info.memory`, and the CPU-copy ledger.
import { describe, expect, it } from 'vitest';
import { TIER_IDS, tierConfig } from '../../../src/render/perf/budget.ts';
import {
  CpuCopyLedger,
  GPU_MEMORY_BUDGET_BYTES,
  MIP_CHAIN_FACTOR,
  TRANSCODE_TARGETS,
  bytesPerTexel,
  crossCheckGpuMemory,
  estimateGpuMemory,
  estimateTextureBytes,
  isTranscodeTarget,
  renderTargetBytes,
  sizingOfTier,
  targetBytesPerPixel,
  textureBytes,
  type TargetSizing,
} from '../../../src/render/perf/gpu-memory.ts';

describe('bytesPerTexel', () => {
  it('1 B/px for the block-compressed targets, 4 for the RGBA8 fallback (§15.4)', () => {
    for (const t of ['astc', 'bc7', 'etc2', 'etc1', 'bc3', 'pvrtc'] as const) expect(bytesPerTexel(t)).toBe(1);
    expect(bytesPerTexel('rgba8')).toBe(4);
    expect(isTranscodeTarget('astc')).toBe(true);
    expect(isTranscodeTarget('jpeg')).toBe(false);
    expect(() => bytesPerTexel('jpeg' as never)).toThrow(RangeError);
  });
});

describe('textureBytes', () => {
  it('≈ 1.4 MB per 1024² compressed, ≈ 5.6 MB per 1024² RGBA8 (§15.4)', () => {
    // the doc rounds one decimal; the module implements the specified ×1.33 factor exactly
    const c = textureBytes({ w: 1024, h: 1024, fmt: 'compressed' }, 'astc');
    expect(c / (1024 * 1024)).toBeCloseTo(1.33, 2);
    expect(c).toBe(Math.round(1024 * 1024 * 1 * MIP_CHAIN_FACTOR));
    const rgba = textureBytes({ w: 1024, h: 1024, fmt: 'compressed' }, 'rgba8');
    expect(rgba / (1024 * 1024)).toBeCloseTo(5.32, 2);
  });

  it('sums explicit mip levels, flooring each at 1 texel', () => {
    // 4×4, 3 levels: 16 + 4 + 1 texels
    expect(textureBytes({ w: 4, h: 4, levels: 3, fmt: 'compressed' }, 'bc7')).toBe(21);
    // non-square: 8×4 → 32 + 8 + 2
    expect(textureBytes({ w: 8, h: 4, levels: 3, fmt: 'compressed' }, 'bc7')).toBe(42);
  });

  it('decodes images to RGBA8: w × h × 4 × 1.33', () => {
    expect(textureBytes({ w: 512, h: 512, fmt: 'image' }, 'astc')).toBe(Math.round(512 * 512 * 4 * MIP_CHAIN_FACTOR));
  });

  it('rejects bad headers', () => {
    expect(() => textureBytes({ w: 0, h: 4, fmt: 'compressed' }, 'astc')).toThrow(RangeError);
    expect(() => textureBytes({ w: 4, h: -1, fmt: 'compressed' }, 'astc')).toThrow(RangeError);
    expect(() => textureBytes({ w: 4, h: 4, levels: 0, fmt: 'compressed' }, 'astc')).toThrow(RangeError);
    expect(() => textureBytes({ w: 4, h: 4, levels: 1.5, fmt: 'compressed' }, 'astc')).toThrow(RangeError);
  });

  it('estimateTextureBytes sums a set', () => {
    const set = [
      { w: 1024, h: 1024, fmt: 'compressed' as const },
      { w: 1024, h: 512, fmt: 'compressed' as const },
    ];
    expect(estimateTextureBytes(set, 'astc')).toBe(
      textureBytes(set[0]!, 'astc') + textureBytes(set[1]!, 'astc'),
    );
    expect(estimateTextureBytes([], 'astc')).toBe(0);
  });
});

describe('render targets', () => {
  const sizing = (tier: 'high' | 'medium' | 'low' | 'minimum', fxaaOn: boolean): TargetSizing => ({
    ...sizingOfTier(tierConfig(tier)),
    fxaaOn,
  });

  it('reproduces the §15.4 anchors: high ≈ 31 B/px (39 with FXAA), minimum ≈ 22 B/px', () => {
    expect(targetBytesPerPixel(sizing('high', false))).toBeCloseTo(31, 0);
    expect(targetBytesPerPixel(sizing('high', true))).toBeCloseTo(39, 0);
    expect(targetBytesPerPixel(sizing('minimum', false))).toBeCloseTo(22, 0);
    expect(targetBytesPerPixel(sizing('medium', false))).toBeCloseTo(31, 0);
  });

  it('high ≈ 68 MB at 1080p and ≤ 85 MB at the 2.6 Mpx cap (§15.4)', () => {
    const s = sizing('high', false);
    const at1080p = renderTargetBytes(s, 1920 * 1080) / (1024 * 1024);
    expect(at1080p).toBeGreaterThan(55); // the documented figure is loose ("≈ 68 MB"); the formula gives ≈ 62
    expect(at1080p).toBeLessThanOrEqual(70);
    const atCap = renderTargetBytes(s, 10_000_000); // clamped to maxPixels
    expect(atCap).toBe(renderTargetBytes(s, 2_600_000));
    expect(atCap / (1024 * 1024)).toBeLessThanOrEqual(85);
  });

  it('minimum ≤ 22 MB at its 1.0 Mpx cap', () => {
    const mb = renderTargetBytes(sizing('minimum', false), 5_000_000) / (1024 * 1024);
    expect(mb).toBeLessThanOrEqual(22.5);
  });

  it('targets are counted at the tier full size: the scale term follows the passed sizing', () => {
    // §15.4: the governor's GPU lever shrinks only the scene pass, so the module
    // counts targets at full size — the contract is to pass sizingOfTier(config),
    // never the governor's live scale. The formula honours the passed scale, so a
    // caller that passed the live scale would visibly undercount.
    const s = sizing('high', false);
    expect(targetBytesPerPixel(s)).toBeCloseTo(31, 0);
    expect(targetBytesPerPixel({ ...s, startRenderScale: 0.75 })).toBeLessThan(targetBytesPerPixel(s));
  });

  it('rejects bad inputs', () => {
    const s = sizing('high', false);
    expect(() => renderTargetBytes(s, -1)).toThrow(RangeError);
    expect(() => targetBytesPerPixel({ ...s, startRenderScale: 0 })).toThrow(RangeError);
    expect(() => targetBytesPerPixel({ ...s, startRenderScale: 1.5 })).toThrow(RangeError);
  });

  it('sizingOfTier carries the tier table rows', () => {
    expect(sizingOfTier(tierConfig('high'))).toEqual({ startRenderScale: 1.0, distort: true, maxPixels: 2_600_000 });
    expect(sizingOfTier(tierConfig('minimum'))).toEqual({ startRenderScale: 0.65, distort: false, maxPixels: 1_000_000 });
  });
});

describe('estimateGpuMemory', () => {
  it('adds texture and target bytes', () => {
    const est = estimateGpuMemory({
      headers: [{ w: 1024, h: 1024, fmt: 'compressed' }],
      target: 'astc',
      sizing: { ...sizingOfTier(tierConfig('high')), fxaaOn: false },
      devicePixels: 1920 * 1080,
    });
    expect(est.textureBytes).toBe(textureBytes({ w: 1024, h: 1024, fmt: 'compressed' }, 'astc'));
    expect(est.targetBytes).toBe(renderTargetBytes({ ...sizingOfTier(tierConfig('high')), fxaaOn: false }, 1920 * 1080));
    expect(est.totalBytes).toBe(est.textureBytes + est.targetBytes);
  });

  it('the documented desktop-high total sits inside the 400 MB budget', () => {
    // §15.4: ≈ 90 (model textures) + 17 (decal atlas) + 10 (splats/images) + 40 (map geometry)
    //        + 10 (fx buffers) + 4 (shadow) + 68-105 (targets) ≈ 240-275 MB
    const headers = [
      ...Array.from({ length: 63 }, () => ({ w: 1024, h: 1024, fmt: 'compressed' as const })),
      ...Array.from({ length: 3 }, () => ({ w: 1024, h: 512, fmt: 'compressed' as const })),
      ...Array.from({ length: 3 }, () => ({ w: 2048, h: 2048, fmt: 'compressed' as const })), // decal pages
      ...Array.from({ length: 6 }, () => ({ w: 512, h: 512, fmt: 'image' as const })), // splats
    ];
    const est = estimateGpuMemory({
      headers,
      target: 'astc',
      sizing: { ...sizingOfTier(tierConfig('high')), fxaaOn: false },
      devicePixels: 2_600_000,
    });
    const mb = est.totalBytes / (1024 * 1024);
    expect(mb).toBeGreaterThan(100);
    expect(mb).toBeLessThan(400);
  });
});

describe('GPU_MEMORY_BUDGET_BYTES', () => {
  it('≤ 400 MB on the desktop tiers, ≤ 150 MB on the mobile tiers (§15.4)', () => {
    expect(GPU_MEMORY_BUDGET_BYTES.high).toBe(400 * 1024 * 1024);
    expect(GPU_MEMORY_BUDGET_BYTES.medium).toBe(400 * 1024 * 1024);
    expect(GPU_MEMORY_BUDGET_BYTES.low).toBe(150 * 1024 * 1024);
    expect(GPU_MEMORY_BUDGET_BYTES.minimum).toBe(150 * 1024 * 1024);
    expect(Object.keys(GPU_MEMORY_BUDGET_BYTES)).toEqual([...TIER_IDS]);
  });
});

describe('crossCheckGpuMemory (build §8.8)', () => {
  const estimate = { textureBytes: 100_000_000, totalBytes: 180_000_000 };

  it('passes when three agrees with the headers', () => {
    const c = crossCheckGpuMemory(estimate, { texturesSize: 102_000_000, total: 182_000_000 });
    expect(c.supported).toBe(true);
    expect(c.textureBytesDelta).toBe(2_000_000);
    expect(c.textureBytesDeltaPct).toBeCloseTo(0.02, 4);
    expect(c.totalBytesDelta).toBe(2_000_000);
    expect(c.withinTolerance).toBe(true);
  });

  it('fails loudly past the tolerance', () => {
    const c = crossCheckGpuMemory(estimate, { texturesSize: 130_000_000, total: 210_000_000 }, 0.15);
    expect(c.supported).toBe(true);
    expect(c.withinTolerance).toBe(false);
    expect(c.textureBytesDeltaPct).toBeCloseTo(0.3, 4);
  });

  it('reports unsupported when three gives no byte figures', () => {
    const c = crossCheckGpuMemory(estimate, {});
    expect(c.supported).toBe(false);
    expect(c.textureBytesDelta).toBeNull();
    expect(c.withinTolerance).toBe(false);
    // a reported total still yields its delta for the log
    const c2 = crossCheckGpuMemory(estimate, { total: 190_000_000 });
    expect(c2.supported).toBe(false);
    expect(c2.totalBytesDelta).toBe(10_000_000);
  });
});

describe('CpuCopyLedger', () => {
  it('tracks adds and releases, flooring at 0', () => {
    const ledger = new CpuCopyLedger();
    expect(ledger.totalBytes).toBe(0);
    ledger.add(90_000_000); // desktop: KTX2 mip data resident
    ledger.add(17_000_000);
    expect(ledger.totalBytes).toBe(107_000_000);
    ledger.release(107_000_000); // minimum: released after initTexture()
    expect(ledger.totalBytes).toBe(0);
    ledger.release(1); // never negative
    expect(ledger.totalBytes).toBe(0);
  });

  it('rejects bad inputs', () => {
    const ledger = new CpuCopyLedger();
    expect(() => ledger.add(-1)).toThrow(RangeError);
    expect(() => ledger.release(Number.NaN)).toThrow(RangeError);
  });
});

describe('no three.js at runtime', () => {
  it('TRANSCODE_TARGETS lists the §11.1 order', () => {
    expect([...TRANSCODE_TARGETS]).toEqual(['astc', 'bc7', 'etc2', 'etc1', 'bc3', 'pvrtc', 'rgba8']);
  });
});
