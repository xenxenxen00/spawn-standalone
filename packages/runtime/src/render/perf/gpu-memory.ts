// GPU-memory estimation, WP R14a (docs/design/rendering.md §15.4; build §8.8).
//
// Two independent figures for the same bytes, so the budget CI job can hold them
// against each other:
//
//   estimate  texture headers from the asset index (`w`, `h`, `levels`, `fmt`, build §5.9)
//             × the bytes per texel of the device profile's transcode target, plus images
//             as RGBA8, plus the render targets as bytes-per-pixel × the capped device
//             pixels of the current tier and resize;
//   reported  `renderer.info.memory.texturesSize` / `.total`, which r186 computes per
//             texture and attribute (`three/src/renderers/common/Info.js` `memory`).
//
// `crossCheckGpuMemory` compares the two. GPU memory here is GPU bytes, not file
// bytes: a KTX2 file is UASTC + zstd with its mips inside and decodes to the
// transcode target; a WebP/PNG decodes to RGBA8.
//
// This module imports nothing at runtime: no three.js, no engine module. The tier
// table it sizes targets from arrives as a `TierConfig` value from the caller
// (R0's `perf/budget.ts`).
import type { TierConfig, TierId } from './budget.ts';

/** the device profile's transcode target, in three's target order (§11.1) with the RGBA8 fallback last */
export const TRANSCODE_TARGETS = Object.freeze(['astc', 'bc7', 'etc2', 'etc1', 'bc3', 'pvrtc', 'rgba8'] as const);

export type TranscodeTarget = (typeof TRANSCODE_TARGETS)[number];

export function isTranscodeTarget(x: unknown): x is TranscodeTarget {
  return typeof x === 'string' && (TRANSCODE_TARGETS as readonly string[]).includes(x);
}

/**
 * Bytes per texel of the transcode target (§15.4 "Bytes per texel" column): the
 * block-compressed targets are 1 B/px (ASTC 4×4 / BC7 / ETC2-RGBA / BC3 ≈ 1.4 MB
 * per 1024² with mips); the RGBA8 fallback is 4 B/px (≈ 5.6 MB per 1024²).
 */
export function bytesPerTexel(target: TranscodeTarget): 1 | 4 {
  if (!isTranscodeTarget(target)) throw new RangeError(`gpu-memory: unknown transcode target ${JSON.stringify(target)}`);
  return target === 'rgba8' ? 4 : 1;
}

/** the asset index's `gpu` header of one texture (build §5.9) */
export interface TextureHeader {
  w: number;
  h: number;
  /** mip levels in the header; absent: the ×1.33 closed form below */
  levels?: number;
  /** `'compressed'`: KTX2, decoded to the transcode target; `'image'`: WebP/PNG, decoded to RGBA8 */
  fmt: 'compressed' | 'image';
}

/** the mip chain multiplier when the header carries no explicit level count (§15.4: "with mips ×1.33") */
export const MIP_CHAIN_FACTOR = 1.33;

function checkDims(w: number, h: number, what: string): void {
  for (const [name, v] of [['w', w], ['h', h]] as const) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 1) {
      throw new RangeError(`gpu-memory: ${what} needs ${name} ≥ 1, got ${String(v)}`);
    }
  }
}

/**
 * GPU bytes of one texture. Compressed: `w × h × levels` summed per mip level
 * (each level halves, floored at 1) × the target's bytes per texel; with no level
 * count, `w × h × bytesPerTexel × 1.33`. Images (WebP/PNG): `w × h × 4 × 1.33`.
 */
export function textureBytes(header: TextureHeader, target: TranscodeTarget): number {
  checkDims(header.w, header.h, 'textureBytes');
  if (header.fmt === 'image') return Math.round(header.w * header.h * 4 * MIP_CHAIN_FACTOR);
  const bpt = bytesPerTexel(target);
  const levels = header.levels;
  if (levels === undefined) return Math.round(header.w * header.h * bpt * MIP_CHAIN_FACTOR);
  if (!Number.isInteger(levels) || levels < 1) {
    throw new RangeError(`gpu-memory: textureBytes needs levels ≥ 1, got ${String(levels)}`);
  }
  let texels = 0;
  for (let i = 0; i < levels; i++) texels += Math.max(1, header.w >> i) * Math.max(1, header.h >> i);
  return Math.round(texels * bpt);
}

/** GPU bytes of a texture set: the §15.4 "texture estimate" line */
export function estimateTextureBytes(headers: readonly TextureHeader[], target: TranscodeTarget): number {
  return headers.reduce((sum, h) => sum + textureBytes(h, target), 0);
}

// ── render targets ────────────────────────────────────────────────────────────

/**
 * What sizes the render-target estimate: the tier's start scale, whether the
 * distort pass exists, whether FXAA is on (the scenario's choice on the tiers
 * that offer it), and the tier's backing-store pixel cap (§3.3).
 */
export interface TargetSizing {
  startRenderScale: number;
  distort: boolean;
  fxaaOn: boolean;
  maxPixels: number;
}

/** the tier-table half of a `TargetSizing` (FXAA is the scenario's choice, not the tier's) */
export function sizingOfTier(config: TierConfig): Pick<TargetSizing, 'startRenderScale' | 'distort' | 'maxPixels'> {
  return { startRenderScale: config.startRenderScale, distort: config.distort, maxPixels: config.maxPixels };
}

/**
 * Render-target bytes per device pixel (§15.4), from the r186 objects the design
 * creates: the scene pass RGBA16F + 32-bit depth = 12 B × renderScale²; the
 * bloom's bright target and 5 × 2 half-float mip targets from ½ resolution ≈
 * 7.3 B (constant under the render scale, §3.3); the canvas back buffer with
 * alpha and depth plus the compositor's copy ≈ 10 B; the ½-resolution distort
 * pass ≈ 2 B on the tiers that have it; FXAA's RTTNode 8 B when on.
 *
 * Anchors: `high` ≈ 31 B/px (39 with FXAA), `minimum` ≈ 22 B/px — both fall out
 * of this formula from the tier table (12×1.0²+7.3+10+2 = 31.3;
 * 12×0.65²+7.3+10 = 22.4).
 */
export function targetBytesPerPixel(sizing: Pick<TargetSizing, 'startRenderScale' | 'distort' | 'fxaaOn'>): number {
  const { startRenderScale, distort, fxaaOn } = sizing;
  if (!(startRenderScale > 0) || startRenderScale > 1) {
    throw new RangeError(`gpu-memory: startRenderScale must be in (0, 1], got ${String(startRenderScale)}`);
  }
  return 12 * startRenderScale * startRenderScale + 7.3 + 10 + (distort ? 2 : 0) + (fxaaOn ? 8 : 0);
}

/**
 * Render-target bytes: bytes-per-pixel × the capped device pixels of the current
 * tier and resize. `devicePixels` is the canvas host's backing-store size after
 * its DPR and pixel caps; it is clamped to the tier's `maxPixels` here as well.
 * The governor's GPU lever shrinks only the scene pass, so targets are counted
 * at full size (§15.4).
 */
export function renderTargetBytes(sizing: TargetSizing, devicePixels: number): number {
  if (typeof devicePixels !== 'number' || !Number.isFinite(devicePixels) || devicePixels < 0) {
    throw new RangeError(`gpu-memory: devicePixels must be ≥ 0, got ${String(devicePixels)}`);
  }
  const capped = Math.min(devicePixels, sizing.maxPixels);
  return Math.round(capped * targetBytesPerPixel(sizing));
}

// ── the estimate ─────────────────────────────────────────────────────────────

export interface GpuMemoryEstimate {
  /** textures: headers × bytes-per-texel */
  textureBytes: number;
  /** render targets: bytes-per-pixel × capped device pixels */
  targetBytes: number;
  /** the GPU-memory figure the budget job asserts */
  totalBytes: number;
}

export interface EstimateGpuMemoryArgs {
  headers: readonly TextureHeader[];
  target: TranscodeTarget;
  sizing: TargetSizing;
  devicePixels: number;
}

/** the §15.4 estimate: texture headers × bytes-per-texel plus render targets per capped device pixel */
export function estimateGpuMemory(args: EstimateGpuMemoryArgs): GpuMemoryEstimate {
  const textureBytes = estimateTextureBytes(args.headers, args.target);
  const targetBytes = renderTargetBytes(args.sizing, args.devicePixels);
  return { textureBytes, targetBytes, totalBytes: textureBytes + targetBytes };
}

const MIB = 1024 * 1024;

/**
 * The §15.4 GPU budgets: ≤ 400 MB desktop, ≤ 150 MB mobile. `high`/`medium` are
 * the desktop tiers, `low`/`minimum` the mobile ones.
 */
export const GPU_MEMORY_BUDGET_BYTES: Readonly<Record<TierId, number>> = Object.freeze({
  high: 400 * MIB,
  medium: 400 * MIB,
  low: 150 * MIB,
  minimum: 150 * MIB,
});

export interface GpuMemoryCrossCheck {
  /** false when three reported no byte figures to check against */
  supported: boolean;
  /** `reported.texturesSize - estimate.textureBytes`, null when unsupported */
  textureBytesDelta: number | null;
  /** the delta relative to the estimate, null when unsupported or the estimate is 0 */
  textureBytesDeltaPct: number | null;
  /** `reported.total - estimate.totalBytes`, null when `total` was not reported */
  totalBytesDelta: number | null;
  withinTolerance: boolean;
}

/**
 * Cross-checks the header estimate against `renderer.info.memory` (build §8.8):
 * `texturesSize` against the texture estimate, `total` against the whole
 * estimate. `tolerance` is the relative texture delta the job accepts (default
 * 15 %); the estimate is headers-based, so a larger miss means the headers and
 * the live textures disagree and the job should fail loudly, not silently pass.
 */
export function crossCheckGpuMemory(
  estimate: Pick<GpuMemoryEstimate, 'textureBytes' | 'totalBytes'>,
  reported: { texturesSize?: number | null; total?: number | null },
  tolerance = 0.15,
): GpuMemoryCrossCheck {
  const texturesSize = reported.texturesSize ?? null;
  const total = reported.total ?? null;
  const supported = typeof texturesSize === 'number' && Number.isFinite(texturesSize);
  if (!supported) {
    return {
      supported: false,
      textureBytesDelta: null,
      textureBytesDeltaPct: null,
      totalBytesDelta: typeof total === 'number' && Number.isFinite(total) ? total - estimate.totalBytes : null,
      withinTolerance: false,
    };
  }
  const textureBytesDelta = texturesSize - estimate.textureBytes;
  const textureBytesDeltaPct = estimate.textureBytes > 0 ? textureBytesDelta / estimate.textureBytes : null;
  return {
    supported: true,
    textureBytesDelta,
    textureBytesDeltaPct,
    totalBytesDelta: typeof total === 'number' && Number.isFinite(total) ? total - estimate.totalBytes : null,
    withinTolerance: textureBytesDeltaPct !== null && Math.abs(textureBytesDeltaPct) <= tolerance,
  };
}

// ── CPU copies ───────────────────────────────────────────────────────────────

/**
 * The CPU-side ledger (§15.4 "CPU copies"): three keeps the CPU array of every
 * `BufferAttribute` and the mip data of every KTX2 texture resident (r186's
 * WebGL2 backend never releases attribute arrays; texture mip data is released
 * after `renderer.initTexture()` on `minimum` only). These bytes are typed-array
 * backing stores outside the JS heap, so the module keeps its own count and the
 * perf scenario reports both figures.
 */
export class CpuCopyLedger {
  #bytes = 0;

  /** records `bytes` of newly resident CPU copies (attribute arrays, texture mip data) */
  add(bytes: number): void {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
      throw new RangeError(`gpu-memory: CpuCopyLedger.add needs bytes ≥ 0, got ${String(bytes)}`);
    }
    this.#bytes += bytes;
  }

  /** releases `bytes` of CPU copies (the `minimum`-tier texture path); floors at 0 */
  release(bytes: number): void {
    if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) {
      throw new RangeError(`gpu-memory: CpuCopyLedger.release needs bytes ≥ 0, got ${String(bytes)}`);
    }
    this.#bytes = Math.max(0, this.#bytes - bytes);
  }

  get totalBytes(): number {
    return this.#bytes;
  }
}
