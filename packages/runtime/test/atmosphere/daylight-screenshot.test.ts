// The daylight fixture in headless Chromium on SwiftShader: a temporary screenshot whose top rows are a sky
// that is bluish and not black at noon, against the same page at midnight (negative control: dark). Skipped when Playwright's
// Chromium is not installed.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from '@playwright/test';
import sharp from 'sharp';
import { build, preview, type PreviewServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const slash = (p: string): string => p.split(String.fromCharCode(92)).join('/');
const HERE = slash(fileURLToPath(new URL('.', import.meta.url))).replace(/\/$/, '');
const FIXTURE = `${HERE}/fixture`;
const out = slash(mkdtempSync(join(tmpdir(), 'ss-daylight-')));

let browser: Browser | null = null;
let server: PreviewServer | null = null;
let skip = '';

beforeAll(async () => {
  try {
    browser = await chromium.launch({ headless: true, args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--disable-vulkan', '--disable-gpu-compositing', '--disable-blink-features=WebGPU'] });
  } catch (e) {
    skip = `no Playwright Chromium: ${(e as Error).message.split('\n')[0]}`;
    return;
  }
  await build({
    root: FIXTURE,
    configFile: false,
    logLevel: 'error',
    base: './',
    define: { __SS_PLATFORM__: '"web"', __SS_TEST_HOOKS__: 'false', __SS_VERSION__: '"0.0.0"', __SS_ORIGIN_COMMIT__: '"fixture"' },
    build: { target: 'es2022', outDir: `${out}/dist`, emptyOutDir: true, chunkSizeWarningLimit: 6000 },
  });
  server = await preview({ root: FIXTURE, configFile: false, logLevel: 'error', build: { outDir: `${out}/dist` }, preview: { port: 0, host: '127.0.0.1' } });
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => (server ? server.httpServer.close(() => r()) : r()));
  rmSync(out, { recursive: true, force: true });
}, 60_000);

/** mean linear-ish sRGB of the top `rows` rows of a PNG */
async function topMean(png: Buffer, rows: number): Promise<[number, number, number]> {
  const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
  const sum: [number, number, number] = [0, 0, 0];
  let n = 0;
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < info.width; x++) {
      const i = (y * info.width + x) * info.channels;
      sum[0] += data[i]!;
      sum[1] += data[i + 1]!;
      sum[2] += data[i + 2]!;
      n++;
    }
  }
  return [sum[0] / n, sum[1] / n, sum[2] / n];
}

async function shoot(query: string): Promise<Buffer> {
  const page = await browser!.newPage({ viewport: { width: 640, height: 360 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${server!.resolvedUrls?.local[0] ?? ''}?${query}`);
  await page.waitForFunction(() => {
    const s = (globalThis as { __daylight?: { done: boolean; error: string | null } }).__daylight;
    return s !== undefined && (s.done || s.error !== null);
  }, null, { timeout: 120_000 });
  const state = await page.evaluate(() => (globalThis as unknown as { __daylight: { error: string | null; kind: string | null } }).__daylight);
  expect(state.error, errors.join('\n')).toBeNull();
  expect(state.kind).toBe('daylight');
  const png = await page.screenshot();
  await page.close();
  return png;
}

describe('K14 daylight fixture screenshot (SwiftShader)', () => {
  it('noon: the top rows are bluish and not black; midnight is dark (negative control)', async (ctx) => {
    if (skip) ctx.skip(skip);
    const noon = await shoot('hour=12&clouds=1');
    writeFileSync(`${out}/daylight.png`, noon);
    const [r, g, b] = await topMean(noon, 40);
    expect(b, `top mean ${[r, g, b].join(',')}`).toBeGreaterThan(90);
    expect(b).toBeGreaterThan(r + 25);
    expect(b).toBeGreaterThan(g);
    const midnight = await shoot('hour=0');
    const [mr, mg, mb] = await topMean(midnight, 40);
    expect(Math.max(mr, mg, mb)).toBeLessThan(40);
    expect(b).toBeGreaterThan(mb * 3);
  }, 240_000);
});
