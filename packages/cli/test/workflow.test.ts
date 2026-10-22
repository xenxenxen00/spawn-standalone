import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createFixtureExport } from '../../testing/src/index.ts';
import { runInit, runImport } from '../src/import/command.ts';
import { runAssetsBuild, buildAssetIndex } from '../src/assets/build.ts';
import { runAssetsVerify } from '../src/assets/check.ts';
import { readArchive } from '../src/package/playgama-check.ts';
import { serveDir, SWIFTSHADER_ARGS } from '../src/package/covers.ts';
import { runDev, gameViteConfig } from '../src/build.ts';

// Generated configs resolve the workspace's installed packages; release:check covers a separate installation.
const cache = fileURLToPath(new URL('../../../.cache/', import.meta.url));
mkdirSync(cache, { recursive: true });
const temp = mkdtempSync(join(cache, 'ss-workflow-'));
const exp = createFixtureExport(join(temp, 'export'));
const game = join(temp, 'new-game');
const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url));
afterAll(() => rmSync(temp, { recursive: true, force: true }));
const cli = (...args: string[]) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', windowsHide: true, timeout: 180_000, maxBuffer: 4 << 20 });

describe('fresh export through the executable CLI', () => {
  it('initialises, imports, checks coverage and assets, builds and packages without hand edits', async () => {
    for (const args of [
      ['init', exp, '--name', 'new-game', '--out', game],
      ['import', game],
      ['import', game, '--check'],
      ['coverage', game, '--check', '--json'],
      ['assets', 'build', game],
      ['assets', 'verify', game],
      ['build', game, '--target', 'web'],
      ['package', game, '--target', 'playgama', '--no-covers', '--json'],
    ]) {
      const result = cli(...args);
      expect(result.status, `${args.join(' ')}\n${result.error ?? ''}\n${result.stdout}\n${result.stderr}`).toBe(0);
      if (args[0] === 'coverage') expect(JSON.parse(result.stdout).scanned.jsFiles).toBeGreaterThan(0);
      if (args[0] === 'package') expect(JSON.parse(result.stdout).status).toBe('pass');
    }
    expect(existsSync(join(game, 'game/jobs/double.js'))).toBe(true);
    expect(existsSync(join(game, 'game/scripts/db.js'))).toBe(true);
    const lock = JSON.parse(readFileSync(join(game, 'standalone.lock.json'), 'utf8'));
    expect(lock).toMatchObject({ sourceCommit: 'fixture-v1', engine: { semver: '6.0.0' }, converterVersion: '1.0.0' });
    expect(lock.files['sim.js']).toMatch(/^[a-f0-9]{64}$/);
    const archive = readArchive(join(game, 'package/playgama/new-game-0.1.0-playgama.zip'));
    expect(archive.entries.some((e) => e.name === 'assets/cdn/mark.svg')).toBe(true);
    expect(archive.entries.some((e) => e.name.endsWith('.wasm'))).toBe(true);
    expect(archive.entries.some((e) => e.name.includes('job-worker'))).toBe(true);
    expect(archive.entries.some((e) => e.name.includes('geometry-worker'))).toBe(true);
    expect(archive.entries.some((e) => e.text?.includes(exp.replaceAll('\\', '/')) || e.text?.includes(exp))).toBe(false);
  }, 240_000);

  it('boots the packaged page, shows its UI and loads its local asset offline', async (ctx) => {
    const { chromium } = await import('@playwright/test');
    let browser;
    try { browser = await chromium.launch({ headless: true, args: [...SWIFTSHADER_ARGS] }); }
    catch (error) { ctx.skip(`Chromium unavailable: ${String(error).split('\n')[0]}`); return; }
    const server = await serveDir(join(game, 'package/playgama/dist'));
    try {
      const page = await browser.newPage();
      const errors: string[] = [];
      const requests: string[] = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      page.on('request', (request) => requests.push(request.url()));
      page.on('console', (message) => { if (/unknown generator|generator failed/i.test(message.text())) errors.push(message.text()); });
      await page.route('**/*', (route) => route.request().url().startsWith(server.url) || /^(data|blob):/.test(route.request().url()) ? route.continue() : route.abort());
      await page.goto(server.url, { waitUntil: 'load' });
      await page.waitForFunction(() => document.body.dataset.booted === '1' || document.body.dataset.bootError !== undefined, null, { timeout: 90_000 });
      expect(await page.getAttribute('body', 'data-boot-error')).toBeNull();
      await page.waitForSelector('#fixture-hud h1', { timeout: 30_000 });
      expect(await page.textContent('#fixture-hud h1')).toBe('Fixture World');
      const clicks = Number(await page.textContent('#fixture-clicks'));
      await page.locator('#fixture-button').click();
      await page.waitForFunction((expected) => Number(document.querySelector('#fixture-clicks')?.textContent) === expected, clicks + 1);
      expect(await page.locator('#fixture-hud img').evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBe(16);
      expect(await page.locator('#fixture-hud h1').evaluate((node) => getComputedStyle(node).color)).toBe('rgb(255, 255, 255)');
      expect(requests.some((url) => url.includes('geometry-worker'))).toBe(true);
      expect(requests.some((url) => url.includes('triangle-'))).toBe(true);
      expect(errors).toEqual([]);
      const dev = await runDev(game, { logLevel: 'silent' });
      try {
        const live = await browser.newPage();
        await live.goto(dev.resolvedUrls!.local[0]!, { waitUntil: 'load' });
        await live.waitForFunction(() => document.body.dataset.booted === '1' || document.body.dataset.bootError !== undefined, null, { timeout: 90_000 });
        expect(await live.getAttribute('body', 'data-boot-error')).toBeNull();
        await live.waitForSelector('#fixture-hud h1', { timeout: 30_000 });
        const clicks = Number(await live.textContent('#fixture-clicks'));
        await live.locator('#fixture-button').click();
        await live.waitForFunction((expected) => Number(document.querySelector('#fixture-clicks')?.textContent) === expected, clicks + 1);
      } finally { await dev.close(); }
    } finally { await browser.close(); await server.close(); }
  }, 150_000);

  it('detects import and lock drift, then repairs it', async () => {
    writeFileSync(join(game, 'game/sim.js'), '// edited\n');
    expect(cli('import', game, '--check').status).toBe(1);
    await runImport(game);
    writeFileSync(join(game, 'standalone.lock.json'), '{}\n');
    const check = await runImport(game, { check: true });
    expect(check.diffs).toContain('changed standalone.lock.json');
    await runImport(game);
    expect((await runImport(game, { check: true })).ok).toBe(true);
    rmSync(join(game, 'standalone.lock.json'));
    expect((await runImport(game, { check: true })).diffs).toContain('missing standalone.lock.json');
    await runImport(game);
  });

  it('asset verification catches same-size output/source changes without writing', async () => {
    const mark = join(exp, 'assets/cdn/mark.svg');
    const original = readFileSync(mark);
    writeFileSync(mark, original.toString().replace('#9cf', '#fc9'));
    const index = readFileSync(join(game, 'asset-index.json'));
    await expect(runAssetsVerify(game)).rejects.toThrow(/SHA-256 mismatch/);
    expect(cli('assets', 'verify', game).status).toBe(1);
    expect(readFileSync(join(game, 'asset-index.json'))).toEqual(index);
    writeFileSync(mark, original);
    expect((await runAssetsVerify(game)).ok).toBe(true);
  });
});

describe('converter negative controls', () => {
  it('shows the dev URL by default while keeping build and explicit logging policies', async () => {
    const logging = join(temp,'logging'); mkdirSync(logging); writeFileSync(join(logging,'index.html'),'<html></html>');
    expect((await gameViteConfig(logging,{},'serve')).logLevel).toBe('info');
    expect((await gameViteConfig(logging,{},'build')).logLevel).toBe('warn');
    expect((await gameViteConfig(logging,{logLevel:'silent'},'serve')).logLevel).toBe('silent');
  });
  it('refuses unsafe manifest paths before reading outside the CDN folder', () => {
    for (const reference of ['/cdn/../outside.png', '/cdn/C:/outside.png', '/cdn/a\\b.png', '/cdn//absolute.png']) {
      expect(() => buildAssetIndex([{ reference }], { cdnDir: temp })).toThrow(/unsafe CDN reference/);
    }
  });

  it('init refuses an existing page without partially creating metadata', () => {
    const dir = join(temp, 'existing');
    mkdirSync(dir); writeFileSync(join(dir, 'index.html'), 'keep');
    expect(() => runInit(exp, { name: 'existing', out: dir })).toThrow(/exists already/);
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toBe('keep');
    expect(existsSync(join(dir, 'standalone.config.json'))).toBe(false);
  });

  it('init refuses to write inside the original export', () => {
    expect(() => runInit(exp, { name: 'bad-out', out: join(exp, 'source') })).toThrow(/outside the read-only export/);
    expect(existsSync(join(exp, 'source/index.html'))).toBe(false);
  });

  it('tracks actual engine reference bytes even with a declared docs build', async () => {
    const file = join(game, 'standalone.config.json');
    const config = JSON.parse(readFileSync(file, 'utf8'));
    config.engine.docsSha = 'declared-build';
    config.engine.docs = '../engine-docs';
    const docs = join(temp, 'engine-docs'); mkdirSync(docs);
    writeFileSync(join(docs, 'api-reference.md'), '# original\n');
    writeFileSync(file, JSON.stringify(config));
    await runImport(game);
    writeFileSync(join(docs, 'api-reference.md'), '# updated\n');
    expect((await runImport(game, { check: true })).diffs).toContain('changed standalone.lock.json');
    await runImport(game);
  });

  it('starts a local dev server with the generated page and asset middleware', async () => {
    const server = await runDev(game, { logLevel: 'silent' });
    try {
      const url = server.resolvedUrls!.local[0]!;
      expect(await (await fetch(url)).text()).toContain('Fixture World');
      expect(await (await fetch(new URL('assets/cdn/mark.svg', url))).text()).toContain('<svg');
      expect(server.config.mode).toBe('development');
    } finally { await server.close(); }
  });

  it('coverage --check fails unsupported surfaces; plain reports still work', () => {
    const source = join(temp, 'unsupported'); mkdirSync(source);
    writeFileSync(join(source, 'sim.js'), 'export function tick(ctx) { ctx.neverImplemented(); }\n');
    expect(cli('coverage', source, '--json').status).toBe(0);
    expect(cli('coverage', source, '--check', '--json').status).toBe(1);
  });

  it('rejects invalid build targets and missing option values', () => {
    expect(cli('build', game, '--target', 'unsupported').status).toBe(2);
    expect(cli('build', game, '--out', '--target', 'web').status).toBe(2);
  });

  it('refuses build outputs overlapping source folders without deleting anything', () => {
    for (const out of [game, join(game, 'game'), join(game, 'src'), join(exp, 'source')]) {
      const r = cli('build', game, '--out', out);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('overlaps');
    }
    expect(existsSync(join(game, 'game/sim.js'))).toBe(true);
    expect(existsSync(join(exp, 'source/sim.js'))).toBe(true);
  });

  it('honours explicit manifest and CDN config locations', async () => {
    const dir = join(temp, 'asset-config'); mkdirSync(dir);
    writeFileSync(join(dir, 'standalone.config.json'), JSON.stringify({ name: 'Assets', slug: 'assets', source: { dir: '../empty-source' }, assets: { manifest: '../export/asset-manifest.json', cdn: '../export/assets/cdn' } }));
    expect(Object.keys((await runAssetsBuild(dir)).index.entries)).toEqual(['mark.svg']);
    expect((await runAssetsVerify(dir)).ok).toBe(true);
  });
});
