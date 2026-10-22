// Browser smoke: a tiny fixture game, imported with the converter, built with spawnStandalone and booted with
// composeGame({ renderer: 'default', wiring: 'default' }) in headless Chromium (SwiftShader, no GPU flags). Asserts the kernel
// booted on defaultPlace, the renderer presented a frame, and nothing reached the console as an error.
// Skipped when Playwright's Chromium is not installed (`npx playwright install chromium`).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from '@playwright/test';
import { build, preview, type PreviewServer } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runImport } from '../../cli/src/import/command.ts';
import { spawnStandalone } from '../src/index.ts';

const slash = (p: string): string => p.split(String.fromCharCode(92)).join('/');
const tmp = slash(mkdtempSync(join(tmpdir(), 'ss-smoke-')));

const write = (file: string, text: string): void => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

/** the smallest Spawn-shaped export: a world config, a root sim, the player and camera templates, one place with one row */
function fixture(): string {
  const src = `${tmp}/export/source`;
  write(`${src}/world.config.yaml`, ['name: "Smoke"', 'camera: templates/camera.js#camera', 'player: templates/player.js#player', 'defaultPlace: main', 'inputs: {}', ''].join('\n'));
  write(`${src}/sim.js`, "export const cadence = '100ms';\nexport function tick(ctx) { ctx.world.state.ticks = (ctx.world.state.ticks ?? 0) + 1; }\n");
  write(`${src}/templates/player.js`, "export const player = { tags: ['player'], state: {} };\n");
  write(`${src}/templates/camera.js`, "export const camera = { kind: 'custom', state: { pitch: 0, yaw: 0 } };\n");
  write(`${src}/places/main/config.yaml`, 'defaultSpawnPoint: { x: 0, y: 1, z: 0 }\n');
  write(`${src}/places/main/cells/x0z0.scene`, '# spawn-scene v2 yaml x0z0\nmarker:\n  feetPosition: { x: 1, y: 0, z: 1 }\n  tags: [marker]\n');
  const ws = `${tmp}/ws`;
  write(`${ws}/standalone.config.json`, JSON.stringify({ name: 'Smoke', slug: 'smoke', source: { dir: '../export/source' } }));
  return ws;
}

// the web root is a temp folder with no node_modules: the shell is imported by path (a game workspace imports @spawn-standalone/runtime/shell)
const SHELL = slash(fileURLToPath(new URL('../../runtime/src/shell/index.ts', import.meta.url)));
const MAIN = `import { composeGame } from '${SHELL}';
import { content } from 'virtual:ss/content';
import assetIndex from 'virtual:ss/asset-index';
const state = (window.__smoke = { booted: false, home: null, frame: false, lighting: null, rigs: null, gpu: null, error: null });
const rigs = new URLSearchParams(location.search).get('rigs') === '1';
composeGame({ slug: 'smoke', canvas: document.getElementById('game'), renderer: 'default', wiring: 'default', content, assetIndex, ...(rigs ? { rigs: true } : {}) })
  .then((app) => {
    state.booted = app.kernel !== null;
    state.home = app.boot.home;
    state.lighting = app.renderer?.lighting ?? null;
    state.rigs = rigs ? app.wiring?.inspect?.().motion !== undefined && app.renderEnv?.rigs !== undefined : null;
    state.gpu = app.renderer?.renderer.gpuInfo().unmaskedRenderer ?? null;
    app.renderer?.renderer.onFirstFrame(() => (state.frame = true));
  })
  .catch((e) => {
    state.error = String(e && e.stack ? e.stack : e);
    console.error(e);
  });
`;

let browser: Browser | null = null;
let server: PreviewServer | null = null;
let skip = '';

beforeAll(async () => {
  try {
    browser = await chromium.launch({ headless: true });
  } catch (e) {
    skip = `no Playwright Chromium: ${(e as Error).message.split('\n')[0]}`;
    return;
  }
  const ws = fixture();
  const gameRoot = `${ws}/game`;
  await runImport(ws, { out: gameRoot });
  const web = `${tmp}/web`;
  write(`${web}/index.html`, '<!doctype html><html><head><meta charset="utf-8"><title>smoke</title></head><body><canvas id="game" width="320" height="240"></canvas><script type="module" src="./main.js"></script></body></html>\n');
  write(`${web}/main.js`, MAIN);
  await build({ root: web, configFile: false, logLevel: 'warn', base: './', plugins: [spawnStandalone({ gameDir: ws, gameRoot })], build: { outDir: `${web}/dist`, emptyOutDir: true, target: 'esnext' } });
  server = await preview({ root: web, configFile: false, logLevel: 'warn', build: { outDir: `${web}/dist` }, preview: { port: 0, host: '127.0.0.1' } });
}, 240_000);

afterAll(async () => {
  await browser?.close();
  await new Promise<void>((r) => (server ? server.httpServer.close(() => r()) : r()));
  rmSync(tmp, { recursive: true, force: true });
}, 120_000);

async function run(query: string): Promise<{ state: Record<string, unknown>; errors: string[] }> {
  const page = await browser!.newPage();
  const errors: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', (e) => errors.push(String(e)));
  const url = server!.resolvedUrls?.local[0] ?? '';
  expect(url).not.toBe('');
  await page.goto(url + query);
  await page.waitForFunction(() => {
    const s = (window as unknown as { __smoke?: { frame: boolean; error: string | null } }).__smoke;
    return s !== undefined && (s.frame || s.error !== null);
  }, null, { timeout: 120_000 });
  const state = await page.evaluate(() => (window as unknown as { __smoke: Record<string, unknown> }).__smoke);
  await page.close();
  return { state, errors };
}

describe('browser smoke', () => {
  it('boots the kernel on defaultPlace and presents a frame, with no console errors', async (ctx) => {
    if (skip) ctx.skip(skip);
    const { state, errors } = await run('');
    expect(state).toMatchObject({ error: null, booted: true, home: 'main', frame: true, lighting: 'neutral' });
    expect(errors).toEqual([]);
    console.log(`browser smoke: GPU ${String(state['gpu'])}`);
  }, 180_000);

  it('boots the same with rigs: true (RigMixers, rigs geometry workers, the bones channel)', async (ctx) => {
    if (skip) ctx.skip(skip);
    const { state, errors } = await run('?rigs=1');
    expect(state).toMatchObject({ error: null, booted: true, home: 'main', frame: true, rigs: true });
    expect(errors).toEqual([]);
  }, 180_000);
});
