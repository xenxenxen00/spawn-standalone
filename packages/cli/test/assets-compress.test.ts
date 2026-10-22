// `assets.images`: recompressed copies in an output folder, same logical names, incremental by content hash.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { afterAll, describe, expect, it } from 'vitest';
import { runAssetsBuild } from '../src/assets/build.ts';
import { maxSizeFor } from '../src/assets/compress.ts';

const slash = (p: string): string => p.split(String.fromCharCode(92)).join('/');
const tmp = slash(mkdtempSync(join(tmpdir(), 'ss-compress-')));
sharp.cache(false);
afterAll(() => rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

/** noisy RGBA with a transparent left half, so it is big as a PNG and has real alpha */
async function png(w: number, h: number): Promise<Buffer> {
  const raw = Buffer.alloc(w * h * 4);
  let r = 12345;
  const rnd = (): number => (r = (Math.imul(r, 1103515245) + 12345) >>> 0) >>> 24;
  for (let i = 0; i < raw.length; i += 4) {
    const x = (i / 4) % w;
    raw[i] = rnd();
    raw[i + 1] = rnd();
    raw[i + 2] = rnd();
    raw[i + 3] = x < w / 2 ? 0 : 255;
  }
  return sharp(raw, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}

async function setup(name: string, images: unknown): Promise<string> {
  const root = `${tmp}/${name}`;
  mkdirSync(`${root}/export/assets/cdn`, { recursive: true });
  mkdirSync(`${root}/export/source`, { recursive: true });
  mkdirSync(`${root}/game`, { recursive: true });
  writeFileSync(`${root}/export/assets/cdn/icon.png`, await png(256, 128));
  writeFileSync(`${root}/export/assets/cdn/small.png`, await png(16, 16));
  writeFileSync(`${root}/export/assets/cdn/theme.mp3`, Buffer.alloc(50, 1));
  const row = (n: string) => ({ reference: `/cdn/${n}`, status: 'downloaded' });
  writeFileSync(`${root}/export/asset-manifest.json`, JSON.stringify([row('icon.png'), row('small.png'), row('theme.mp3')]));
  writeFileSync(`${root}/game/standalone.config.json`, JSON.stringify({ name: 'F', slug: 'f', source: { dir: '../export/source' }, assets: { images, audio: {} } }));
  return `${root}/game`;
}

describe('assets.images', () => {
  it('caps dimensions, keeps alpha and logical names, records original vs output bytes', async () => {
    const game = await setup('a', { maxSize: { 'icon.*': 64 }, format: 'webp', quality: 70 });
    const o = await runAssetsBuild(game);
    const idx = JSON.parse(readFileSync(`${game}/asset-index.json`, 'utf8'));
    expect(slash(o.compressed!.outDir)).toBe(`${game}/.cache/assets/cdn`);
    expect(idx.cdnDir).toBe('.cache/assets/cdn');
    expect(idx.sourceCdnDir).toBe('../export/assets/cdn');
    const e = idx.entries['icon.png'];
    expect(e).toMatchObject({ u: 'assets/cdn/icon.webp', k: 'image', x: 'webp' });
    expect(e.ob).toBe(statSync(`${game}/../export/assets/cdn/icon.png`).size);
    expect(e.b).toBe(statSync(`${game}/.cache/assets/cdn/icon.webp`).size);
    expect(e.b).toBeLessThan(e.ob);
    const m = await sharp(`${game}/.cache/assets/cdn/icon.webp`).metadata();
    expect([m.width, m.height, m.hasAlpha]).toEqual([64, 32, true]);
    const { data } = await sharp(`${game}/.cache/assets/cdn/icon.webp`).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(data[3]).toBe(0);
    expect(data[(63) * 4 + 3]).toBe(255);
    // no enlarging, audio passes through, group bytes follow the output sizes
    expect((await sharp(`${game}/.cache/assets/cdn/small.webp`).metadata()).width).toBe(16);
    expect(idx.entries['theme.mp3']).toMatchObject({ u: 'assets/cdn/theme.mp3', b: 50 });
    expect(statSync(`${game}/.cache/assets/cdn/theme.mp3`).size).toBe(50);
    expect(idx.groups.lazy.b).toBe(Object.values<{ b: number }>(idx.entries).reduce((n, x) => n + x.b, 0));
    expect(o.compressed!.outputBytes).toBeLessThan(o.compressed!.originalBytes);
  });

  it('skips unchanged files on re-run and redoes a changed one', async () => {
    const game = await setup('b', { maxSize: 64, format: 'png' });
    const a = await runAssetsBuild(game);
    expect(a.compressed!.cached).toBe(0);
    const out = `${game}/.cache/assets/cdn/icon.png`;
    const t = statSync(out).mtimeMs;
    await new Promise((r) => setTimeout(r, 30));
    const b = await runAssetsBuild(game);
    expect(b.compressed!.cached).toBe(a.compressed!.files);
    expect(statSync(out).mtimeMs).toBe(t);
    expect((await sharp(out).metadata()).hasAlpha).toBe(true);
    writeFileSync(`${game}/../export/assets/cdn/icon.png`, await png(200, 100));
    const c = await runAssetsBuild(game);
    expect(c.compressed!.cached).toBe(b.compressed!.cached - 1);
    expect((await sharp(out).metadata()).width).toBe(64);
  });

  it('leaves the build unchanged when assets.images is not set', async () => {
    const game = await setup('c', undefined);
    const o = await runAssetsBuild(game);
    expect(o.compressed).toBeUndefined();
    expect(JSON.parse(readFileSync(`${game}/asset-index.json`, 'utf8')).cdnDir).toBe('../export/assets/cdn');
  });

  it('resolves maxSize globs first-match', () => {
    expect(maxSizeFor('hud/a.png', { 'hud/*': 48, '*': 512 })).toBe(48);
    expect(maxSizeFor('x.png', { 'hud/*': 48 })).toBeUndefined();
    expect(maxSizeFor('x.png', 100)).toBe(100);
  });
});
