// Opt-in image recompression for `assets build` (config `assets.images`). Resizes (never enlarges) and re-encodes the raster images
// of an export into an output folder, leaving the export untouched. Entries keep their logical names; only `u`, `b`, `x` change.
// Incremental: a content-hash + options cache (`.compress-cache.json` in the output folder) skips files whose result is current.
// Fidelity gate: every recompressed image is compared with its original at its display size (PSNR); under `minPsnr` (default 35 dB)
// it falls back to lossless, then to the original, so a lossy step can never visibly damage an image.
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import sharp, { type Sharp } from 'sharp';
import { audit, compareAtDisplay, type Structure } from './verify.ts';

export interface ImagesConfig {
  /** longest-side cap in px: one number for every image, or `{ glob: px }` (first matching glob wins; `*` does not cross `/`) */
  maxSize?: number | Record<string, number>;
  /** output format; default `webp` */
  format?: 'webp' | 'png';
  /** 1-100; default 80 */
  quality?: number;
  /**
   * Fidelity gate. Each recompressed image is compared with its original at its display size (see `display`); under this PSNR in dB it
   * falls back, in order, to near-lossless then lossless at the capped size, the same two at the display size when that is larger than the cap, then the untouched original when none is smaller. Default 35; `false`
   * (or 0) turns the gate off.
   */
  minPsnr?: number | false;
  /** longest side in device px that images are shown at (the gate compares there): one number, or `{ glob: px }`; default the output's own size */
  display?: number | Record<string, number>;
  /** globs (same rules as `maxSize`) of images that are never recompressed: they ship as the original */
  keep?: string[];
}

/** how a file left the compressor */
export type CompressMode = 'lossy' | 'near-lossless' | 'lossless' | 'lossy@display' | 'near-lossless@display' | 'lossless@display' | 'original' | 'kept' | 'animated' | 'not-smaller';

/** the audit line of one raster image */
export interface ImageRow {
  name: string;
  /** the file in the output folder */
  file: string;
  mode: CompressMode;
  ob: number;
  b: number;
  fromFormat: string;
  toFormat: string;
  hasAlphaFrom: boolean;
  hasAlphaTo: boolean;
  structure: Structure;
  /** longest side the gate compared at (undefined: the output's own size) */
  display?: number;
  /** PSNR in dB at display size of the first (lossy) attempt, and of the shipped file; null = identical or not measured */
  psnrLossy: number | null;
  psnr: number | null;
  ssim: number | null;
}

export interface CompressedFile {
  /** file name inside the output folder (the extension may differ from the logical name's) */
  file: string;
  /** original bytes, output bytes */
  ob: number;
  b: number;
  x: string;
  /** true when this run reused the cache */
  cached: boolean;
}

export interface CompressResult {
  files: Record<string, CompressedFile>;
  /** logical names copied through unchanged (everything not recompressed) */
  copied: string[];
  originalBytes: number;
  outputBytes: number;
  skippedCached: number;
  /** one audit row per raster image (recompressed or not), in input order */
  rows: ImageRow[];
}

sharp.cache(false);
const RASTER = new Set(['png', 'jpg', 'jpeg', 'webp']);
const CACHE_FILE = '.compress-cache.json';
const globRe = (g: string): RegExp => new RegExp(`^${g.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*')}$`);

export function maxSizeFor(name: string, maxSize: ImagesConfig['maxSize']): number | undefined {
  if (maxSize === undefined) return undefined;
  if (typeof maxSize === 'number') return maxSize;
  for (const [g, px] of Object.entries(maxSize)) if (globRe(g).test(name)) return px;
  return undefined;
}

export const DEFAULT_MIN_PSNR = 35;
const minPsnrOf = (c: ImagesConfig): number => (c.minPsnr === false ? 0 : (c.minPsnr ?? DEFAULT_MIN_PSNR));
const isKept = (name: string, keep: ImagesConfig['keep']): boolean => (keep ?? []).some((g) => globRe(g).test(name));
const fin = (n: number): number | null => (Number.isFinite(n) ? n : null);

const sha = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');

type CacheState = Record<string, { key: string; file: string; ob: number; b: number; x: string; row?: ImageRow }>;

/**
 * Recompress the images among `names` (logical names under `srcDir`) into `outDir`, and copy the other present names there so the folder
 * can be served whole. Files already current in the cache are not touched.
 */
export async function compressAssets(names: readonly string[], o: { srcDir: string; outDir: string; images: ImagesConfig }): Promise<CompressResult> {
  const format = o.images.format ?? 'webp';
  const quality = Math.min(100, Math.max(1, Math.round(o.images.quality ?? 80)));
  mkdirSync(o.outDir, { recursive: true });
  const cacheFile = join(o.outDir, CACHE_FILE);
  let cache: CacheState = {};
  try {
    cache = JSON.parse(readFileSync(cacheFile, 'utf8')) as CacheState;
  } catch {
    cache = {};
  }
  const next: CacheState = {};
  const res: CompressResult = { files: {}, copied: [], originalBytes: 0, outputBytes: 0, skippedCached: 0, rows: [] };
  for (const name of names) {
    const src = join(o.srcDir, name);
    if (!existsSync(src)) continue;
    const x = (/\.([A-Za-z0-9]+)$/.exec(name)?.[1] ?? '').toLowerCase();
    const bytes = readFileSync(src);
    if (!RASTER.has(x)) {
      await passthrough(name, src, bytes, 'original');
      continue;
    }
    const cap = maxSizeFor(name, o.images.maxSize);
    const floor = minPsnrOf(o.images);
    const disp = maxSizeFor(name, o.images.display);
    const kept = isKept(name, o.images.keep);
    const key = sha(`${sha(bytes)}|${format}|${quality}|${cap ?? ''}|${floor}|${disp ?? ''}|${kept}|v2`);
    const hit = cache[name];
    if (hit && hit.key === key && existsSync(join(o.outDir, hit.file))) {
      next[name] = hit;
      res.files[name] = { file: hit.file, ob: hit.ob, b: hit.b, x: hit.x, cached: true };
      res.skippedCached++;
      res.originalBytes += hit.ob;
      res.outputBytes += hit.b;
      if (hit.row) res.rows.push(hit.row);
      continue;
    }
    const meta = await sharp(bytes).metadata();
    if (kept || (meta.pages ?? 1) > 1) {
      await passthrough(name, src, bytes, kept ? 'kept' : 'animated', { cap, disp });
      continue;
    }
    // the ladder: lossy at the cap; then (gate on) near-lossless and lossless at the cap; when the display size is larger than the cap,
    // the same three at the display size. Lossless at a size at or above the display size always passes, so the walk always ends.
    const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
    const at = (px: number | undefined): Sharp => {
      const img = sharp(bytes).rotate();
      return px === undefined ? img : img.resize({ width: px, height: px, fit: 'inside', withoutEnlargement: true });
    };
    const encode = (kind: 'lossy' | 'near-lossless' | 'lossless', px: number | undefined): Promise<Buffer> => {
      const img = at(px);
      if (format === 'webp') return (kind === 'lossy' ? img.webp({ quality, effort: 5 }) : kind === 'lossless' ? img.webp({ lossless: true, effort: 5 }) : img.webp({ nearLossless: true, quality: 60, effort: 5 })).toBuffer();
      return (kind === 'lossy' ? img.png({ compressionLevel: 9, palette: quality < 100, quality, effort: 7 }) : img.png({ compressionLevel: 9 })).toBuffer();
    };
    const kinds: Array<'lossy' | 'near-lossless' | 'lossless'> = floor > 0 ? (format === 'webp' ? ['lossy', 'near-lossless', 'lossless'] : ['lossy', 'lossless']) : ['lossy'];
    const ladder: Array<[CompressMode, () => Promise<Buffer>]> = kinds.map((k) => [k, () => encode(k, cap)]);
    if (floor > 0 && disp !== undefined && disp > Math.min(cap ?? Infinity, longest)) ladder.push(...kinds.map((k): [CompressMode, () => Promise<Buffer>] => [`${k}@display`, () => encode(k, disp)]));
    let outBytes: Buffer = bytes;
    let mode: CompressMode = 'lossy';
    let psnr = Infinity;
    let ssim = 1;
    let psnrLossy = Infinity;
    for (const [m, enc] of ladder) {
      outBytes = await enc();
      mode = m;
      const sim = await compareAtDisplay(bytes, outBytes, disp);
      psnr = sim.psnr;
      ssim = sim.ssim;
      if (m === 'lossy') psnrLossy = sim.psnr;
      if (sim.psnr >= floor) break;
    }
    // keep the original when re-encoding does not help
    if (outBytes.length >= bytes.length) {
      await passthrough(name, src, bytes, 'not-smaller', { cap, disp, psnrLossy });
      continue;
    }
    const outName = name.replace(/\.[A-Za-z0-9]+$/, `.${format}`);
    mkdirSync(dirname(join(o.outDir, outName)), { recursive: true });
    writeFileSync(join(o.outDir, outName), outBytes);
    const row: ImageRow = {
      name,
      file: outName,
      mode,
      ob: bytes.length,
      b: outBytes.length,
      fromFormat: x,
      toFormat: format,
      hasAlphaFrom: Boolean(meta.hasAlpha),
      hasAlphaTo: Boolean((await sharp(outBytes).metadata()).hasAlpha),
      structure: await audit(bytes, outBytes, cap),
      ...(disp !== undefined ? { display: disp } : {}),
      psnrLossy: fin(psnrLossy),
      psnr: fin(psnr),
      ssim,
    };
    res.rows.push(row);
    next[name] = { key, file: outName, ob: bytes.length, b: outBytes.length, x: format, row };
    res.files[name] = { file: outName, ob: bytes.length, b: outBytes.length, x: format, cached: false };
    res.originalBytes += bytes.length;
    res.outputBytes += outBytes.length;
  }
  writeFileSync(cacheFile, JSON.stringify(next));
  return res;

  async function passthrough(name: string, src: string, bytes: Buffer, mode: CompressMode, info: { cap?: number | undefined; disp?: number | undefined; psnrLossy?: number } = {}): Promise<void> {
    const dst = join(o.outDir, name);
    mkdirSync(dirname(dst), { recursive: true });
    if (!existsSync(dst) || statSync(dst).size !== bytes.length || sha(readFileSync(dst)) !== sha(bytes)) copyFileSync(src, dst);
    res.copied.push(name);
    const x = (/\.([A-Za-z0-9]+)$/.exec(name)?.[1] ?? '').toLowerCase();
    if (!RASTER.has(x)) return;
    res.originalBytes += bytes.length;
    res.outputBytes += bytes.length;
    const m = await sharp(bytes).metadata();
    res.rows.push({
      name,
      file: name,
      mode,
      ob: bytes.length,
      b: bytes.length,
      fromFormat: x,
      toFormat: x,
      hasAlphaFrom: Boolean(m.hasAlpha),
      hasAlphaTo: Boolean(m.hasAlpha),
      structure: await audit(bytes, bytes, info.cap),
      ...(info.disp !== undefined ? { display: info.disp } : {}),
      psnrLossy: fin(info.psnrLossy ?? Infinity),
      psnr: null,
      ssim: 1,
    });
  }
}
