// Image-fidelity measures for `assets build`: alpha-weighted PSNR, SSIM and a structural audit (dimensions, aspect ratio, alpha) of a
// recompressed image against its original. Both are compared at one common size (the size the player sees), never at the output's own.
import sharp from 'sharp';

export interface Rgba {
  data: Uint8Array;
  width: number;
  height: number;
}

export interface Similarity {
  /** dB over the pixels either image covers (alpha > 0): the gating figure; Infinity when identical */
  psnr: number;
  /** dB over every pixel, transparent padding included (flatters sparse sprites) */
  psnrAll: number;
  /** mean SSIM of the luma over white, 0..1 */
  ssim: number;
}

export interface Structure {
  /** [width, height] of the original and of the output */
  from: [number, number];
  to: [number, number];
  resized: boolean;
  /** the output is not the original's size although the original is not larger than the cap */
  resizedWithinCap: boolean;
  /** the output's aspect ratio differs from the original's by more than the rounding of one pixel */
  aspectChanged: boolean;
  alphaLost: boolean;
}

sharp.cache(false);

export async function decodeRgba(input: Buffer | string, resizeTo?: { width: number; height: number }): Promise<Rgba> {
  let img = sharp(input).rotate();
  if (resizeTo) img = img.resize({ width: resizeTo.width, height: resizeTo.height, fit: 'fill', kernel: 'lanczos3' });
  const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8Array(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height };
}

/** `fit: inside` size of w x h when the longest side is `px` (rounded like sharp does) */
export function fitInside(w: number, h: number, px: number): { width: number; height: number } {
  if (w >= h) return { width: px, height: Math.max(1, Math.round((h * px) / w)) };
  return { width: Math.max(1, Math.round((w * px) / h)), height: px };
}

/** PSNR and SSIM of two same-size RGBA images; the colour is compared premultiplied, so a pixel counts as much as it is visible */
export function similarity(a: Rgba, b: Rgba): Similarity {
  if (a.width !== b.width || a.height !== b.height) throw new Error(`similarity: size mismatch ${a.width}x${a.height} vs ${b.width}x${b.height}`);
  const n = a.width * a.height;
  let sseAll = 0;
  let sseCov = 0;
  let cov = 0;
  const la = new Float64Array(n);
  const lb = new Float64Array(n);
  for (let p = 0; p < n; p++) {
    const i = p * 4;
    const aa = a.data[i + 3]! / 255;
    const ab = b.data[i + 3]! / 255;
    const da = a.data[i + 3]! - b.data[i + 3]!;
    let e = da * da;
    let ya = 0;
    let yb = 0;
    for (let c = 0; c < 3; c++) {
      const pa = a.data[i + c]! * aa;
      const pb = b.data[i + c]! * ab;
      e += (pa - pb) * (pa - pb);
      const w = c === 0 ? 0.299 : c === 1 ? 0.587 : 0.114;
      ya += w * (pa + 255 * (1 - aa));
      yb += w * (pb + 255 * (1 - ab));
    }
    la[p] = ya;
    lb[p] = yb;
    sseAll += e;
    if (a.data[i + 3]! > 0 || b.data[i + 3]! > 0) {
      sseCov += e;
      cov++;
    }
  }
  const db = (sse: number, count: number): number => (sse === 0 ? Infinity : 10 * Math.log10((255 * 255) / (sse / (count * 4))));
  return { psnr: cov === 0 ? Infinity : db(sseCov, cov), psnrAll: db(sseAll, n), ssim: ssim(la, lb, a.width, a.height) };
}

/** mean SSIM over uniform 8x8 windows at stride 4 (the whole image when it is smaller) */
function ssim(x: Float64Array, y: Float64Array, w: number, h: number): number {
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  const win = Math.min(8, w, h);
  const step = Math.max(1, Math.floor(win / 2));
  let sum = 0;
  let count = 0;
  const N = win * win;
  for (let y0 = 0; y0 + win <= h; y0 += step) {
    for (let x0 = 0; x0 + win <= w; x0 += step) {
      let mx = 0, my = 0, sxx = 0, syy = 0, sxy = 0;
      for (let j = 0; j < win; j++) {
        for (let i = 0; i < win; i++) {
          const k = (y0 + j) * w + x0 + i;
          const vx = x[k]!, vy = y[k]!;
          mx += vx; my += vy; sxx += vx * vx; syy += vy * vy; sxy += vx * vy;
        }
      }
      mx /= N; my /= N;
      const vx = sxx / N - mx * mx, vy = syy / N - my * my, cxy = sxy / N - mx * my;
      sum += ((2 * mx * my + C1) * (2 * cxy + C2)) / ((mx * mx + my * my + C1) * (vx + vy + C2));
      count++;
    }
  }
  return count === 0 ? 1 : sum / count;
}

/**
 * PSNR/SSIM of `output` against `original` at `displayPx` on the longest side (default: the output's own size). Both are resampled
 * with the same kernel, so what is measured is what the player sees at that size.
 */
export async function compareAtDisplay(original: Buffer, output: Buffer, displayPx?: number): Promise<Similarity> {
  const om = await sharp(original).metadata();
  const swap = (om.orientation ?? 1) >= 5;
  const ow = swap ? om.height! : om.width!;
  const oh = swap ? om.width! : om.height!;
  const tm = await sharp(output).metadata();
  const target = displayPx !== undefined ? fitInside(ow, oh, displayPx) : { width: tm.width!, height: tm.height! };
  const [a, b] = await Promise.all([decodeRgba(original, target), decodeRgba(output, target)]);
  return similarity(a, b);
}

/** the structural audit of a recompressed image: size, aspect ratio, alpha, and whether it was shrunk although it fit under the cap */
export async function audit(original: Buffer, output: Buffer, cap?: number): Promise<Structure> {
  const o = await sharp(original).rotate().toBuffer({ resolveWithObject: true });
  const t = await sharp(output).metadata();
  const om = await sharp(o.data).metadata();
  const [w, h] = [o.info.width, o.info.height];
  const [tw, th] = [t.width!, t.height!];
  const expectH = (h * tw) / w;
  const expectW = (w * th) / h;
  // one pixel of rounding on the shorter-scaled side is allowed
  const aspectChanged = Math.abs(expectH - th) > 1 && Math.abs(expectW - tw) > 1;
  const fits = cap === undefined || Math.max(w, h) <= cap;
  const alphaLost = Boolean(om.hasAlpha) && !t.hasAlpha;
  return { from: [w, h], to: [tw, th], resized: tw !== w || th !== h, resizedWithinCap: fits && (tw !== w || th !== h), aspectChanged, alphaLost };
}
