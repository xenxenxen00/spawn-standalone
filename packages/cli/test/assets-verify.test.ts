// Fidelity checks for `assets.images`: aspect ratio, alpha, no resize under the cap, and the PSNR fallback (with negative controls).
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { compressAssets, type ImagesConfig } from '../src/assets/compress.ts';
import { audit, compareAtDisplay, similarity } from '../src/assets/verify.ts';

const slash = (p: string): string => p.split(String.fromCharCode(92)).join('/');
const tmp = slash(mkdtempSync(join(tmpdir(), 'ss-verify-')));
sharp.cache(false);
afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

/** high-frequency RGBA noise: lossy encoders damage it badly, so it is the deliberately fragile fixture */
async function noise(w: number, h: number, alphaHalf = false): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 4);
  let r = 987654;
  const rnd = (): number => (r = (Math.imul(r, 1103515245) + 12345) >>> 0) >>> 24;
  for (let i = 0; i < raw.length; i += 4) {
    raw[i] = rnd();
    raw[i + 1] = rnd();
    raw[i + 2] = rnd();
    raw[i + 3] = alphaHalf && (i / 4) % w < w / 2 ? 0 : 255;
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

/** smooth gradient with a transparent corner: the benign fixture */
async function smooth(w: number, h: number): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) raw.set([(x * 255) / w, (y * 255) / h, 128, x < w / 4 && y < h / 4 ? 0 : 255], (y * w + x) * 4);
  return sharp(raw, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

let n = 0;
async function run(files: Record<string, Buffer>, images: ImagesConfig) {
  const root = `${tmp}/c${n++}`;
  mkdirSync(`${root}/src`, { recursive: true });
  for (const [name, b] of Object.entries(files)) writeFileSync(`${root}/src/${name}`, b);
  const res = await compressAssets(Object.keys(files), { srcDir: `${root}/src`, outDir: `${root}/out`, images });
  return { res, out: (f: string): Buffer => readFileSync(`${root}/out/${f}`), src: (f: string): Buffer => readFileSync(`${root}/src/${f}`) };
}

describe('structure audit', () => {
  it('keeps the aspect ratio when capping a non-square image', async () => {
    const { res, out } = await run({ 'wide.png': await smooth(300, 100) }, { maxSize: 64, minPsnr: false });
    const row = res.rows[0]!;
    const m = await sharp(out(row.file)).metadata();
    expect([m.width, m.height]).toEqual([64, 21]);
    expect(row.structure.aspectChanged).toBe(false);
  });

  it('negative control: audit flags a stretched output', async () => {
    const src = await smooth(300, 100);
    const stretched = await sharp(src).resize({ width: 64, height: 64, fit: 'fill' }).png().toBuffer();
    expect((await audit(src, stretched)).aspectChanged).toBe(true);
  });

  it('keeps alpha, and audit flags a flattened output', async () => {
    const src = await noise(64, 64, true);
    const { res, out } = await run({ 'a.png': src }, { maxSize: 32 });
    expect(res.rows[0]!.hasAlphaTo).toBe(true);
    expect(res.rows[0]!.structure.alphaLost).toBe(false);
    expect((await sharp(out(res.rows[0]!.file)).metadata()).hasAlpha).toBe(true);
    const flat = await sharp(src).flatten({ background: '#fff' }).removeAlpha().png().toBuffer();
    expect((await audit(src, flat)).alphaLost).toBe(true);
  });

  it('does not resize an image that is not larger than maxSize', async () => {
    const { res, out } = await run({ 'small.png': await noise(48, 40), 'exact.png': await noise(64, 64) }, { maxSize: 64 });
    for (const r of res.rows) {
      expect(r.structure.resizedWithinCap).toBe(false);
      expect(r.structure.resized).toBe(false);
    }
    for (const f of ['small', 'exact']) {
      const file = res.files[`${f}.png`]?.file;
      if (file) expect((await sharp(out(file)).metadata()).width).toBe(f === 'small' ? 48 : 64);
    }
  });

  it('negative control: audit flags a shrink under the cap', async () => {
    const src = await smooth(48, 48);
    const shrunk = await sharp(src).resize(24, 24).png().toBuffer();
    expect((await audit(src, shrunk, 64)).resizedWithinCap).toBe(true);
  });
});

describe('PSNR fallback', () => {
  it('similarity: identical is infinite, a damaged copy is low', async () => {
    const src = await noise(32, 32);
    const bad = await sharp(src).webp({ quality: 5 }).toBuffer();
    expect((await compareAtDisplay(src, src)).psnr).toBe(Infinity);
    expect((await compareAtDisplay(src, bad)).psnr).toBeLessThan(35);
    expect(similarity({ data: new Uint8Array(16), width: 2, height: 2 }, { data: new Uint8Array(16), width: 2, height: 2 }).psnr).toBe(Infinity);
  });

  it('negative control: with the gate off the damaged fixture ships lossy and under 35 dB', async () => {
    const { res } = await run({ 'n.png': await noise(96, 96) }, { maxSize: 64, quality: 5, minPsnr: false });
    expect(res.rows[0]!.mode).toBe('lossy');
    expect(res.rows[0]!.psnr!).toBeLessThan(35);
  });

  it('with the gate on (default) the same fixture falls back and ends at or above 35 dB', async () => {
    const src = await noise(96, 96);
    const { res, out } = await run({ 'n.png': src }, { maxSize: 64, quality: 5 });
    const row = res.rows[0]!;
    expect(row.psnrLossy!).toBeLessThan(35);
    expect(row.mode).not.toBe('lossy');
    expect(row.psnr === null || row.psnr >= 35).toBe(true);
    // measured independently of the tool's own number
    expect((await compareAtDisplay(src, out(row.file))).psnr).toBeGreaterThanOrEqual(35);
  });

  it('a benign image stays lossy under the default floor', async () => {
    const { res } = await run({ 's.png': await smooth(200, 200) }, { maxSize: 100, quality: 90 });
    expect(res.rows[0]!.mode).toBe('lossy');
  });

  it('falls back to the display size when the cap is the problem', async () => {
    const src = await noise(256, 256);
    const { res, out } = await run({ 'd.png': src }, { maxSize: 64, display: 256 });
    const row = res.rows[0]!;
    expect(row.mode).toMatch(/@display$/);
    expect((await sharp(out(row.file)).metadata()).width).toBe(256);
    expect((await compareAtDisplay(src, out(row.file), 256)).psnr).toBeGreaterThanOrEqual(35);
  });

  it('keep globs ship the original bytes', async () => {
    const src = await noise(96, 96);
    const { res, out } = await run({ 'k.png': src }, { maxSize: 32, keep: ['k.*'] });
    expect(res.rows[0]!.mode).toBe('kept');
    expect(out('k.png').equals(src)).toBe(true);
  });
});
