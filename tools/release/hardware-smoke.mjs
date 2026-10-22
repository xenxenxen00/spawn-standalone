import assert from 'node:assert/strict';
import { createReadStream, existsSync, mkdtempSync, mkdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';
import sharp from 'sharp';

// Local hardware QA; never adds flags selecting or enabling a software GPU.
// node tools/release/hardware-smoke.mjs <built-dir|loopback-url> --out report.json
const { values, positionals } = parseArgs({ allowPositionals: true, options: {
  probe: { type: 'boolean' }, 'self-test': { type: 'boolean' }, out: { type: 'string' }, chromium: { type: 'string' },
  button: { type: 'string', default: '#fixture-button' }, 'button-result': { type: 'string', default: '#fixture-clicks' },
} });
function requireHardware(gpu) {
  assert.ok(gpu.webgl2, 'WebGL2 is unavailable');
  assert.ok(gpu.renderer && gpu.vendor, 'Unmasked GPU vendor/renderer unavailable; cannot prove hardware rendering');
  assert.doesNotMatch(`${gpu.vendor} ${gpu.renderer}`, /swiftshader|llvmpipe|softpipe|software|basic render|\bwarp\b/i, 'Software rendering is forbidden');
  assert.match(gpu.renderer, /nvidia|geforce|quadro|radeon|\bamd\b|\bintel\b|apple|adreno|mali|powervr|qualcomm|vivante/i, 'GPU renderer does not identify recognized hardware');
}
function pixelStats(pixels, channels, width) {
  let min = 255; let max = 0; let changed = 0; let horizontalContrast = 0;
  for (let i = 0; i < pixels.length; i += channels) {
    let different = false; let rowDifferent = false;
    const rowStart = Math.floor(i / (channels * width)) * channels * width;
    for (let c = 0; c < 3; c++) {
      min = Math.min(min, pixels[i + c]); max = Math.max(max, pixels[i + c]);
      if (Math.abs(pixels[i + c] - pixels[c]) > 8) different = true;
      if (Math.abs(pixels[i + c] - pixels[rowStart + c]) > 16) rowDifferent = true;
    }
    if (different) changed++;
    if (rowDifferent) horizontalContrast++;
  }
  return { min, max, changedPixels: changed, horizontalContrastPixels: horizontalContrast, pixels: pixels.length / channels };
}
function hasVisibleGeometry(stats) {
  return stats.max - stats.min > 8 && stats.changedPixels >= 32 && stats.horizontalContrastPixels >= 32;
}
function requireNonblank(stats) {
  assert.ok(hasVisibleGeometry(stats), `Canvas has no visible geometry (blank, uniform, or gradient-only): ${JSON.stringify(stats)}`);
}
// The local antivirus injects this script into loopback HTML; never fetch or execute it during offline QA.
function isEnvironmentScript(url) {
  return url.hostname === 'gc.kis.v2.scr.kaspersky-labs.com' && /^\/[a-f0-9-]{36}\/main\.js$/i.test(url.pathname);
}
function selfTest() {
  requireHardware({ webgl2: true, vendor: 'NVIDIA', renderer: 'ANGLE (NVIDIA GeForce RTX 2070)' });
  for (const renderer of ['SwiftShader Device', 'llvmpipe (LLVM)', 'Microsoft Basic Render Driver', 'ANGLE (Microsoft WARP)', 'software rasterizer', 'unknown']) {
    assert.throws(() => requireHardware({ webgl2: true, vendor: 'Test', renderer }));
  }
  assert.throws(() => requireHardware({ webgl2: false }));
  assert.throws(() => requireNonblank(pixelStats(Buffer.alloc(300), 3, 10)));
  const red = Buffer.alloc(300); for (let i = 0; i < 300; i += 3) red[i] = 255;
  assert.throws(() => requireNonblank(pixelStats(red, 3, 10)));
  const gradient = Buffer.alloc(16 * 16 * 3);
  for (let y = 0; y < 16; y++) gradient.fill(y * 8, y * 16 * 3, (y + 1) * 16 * 3);
  const sky = pixelStats(gradient, 3, 16);
  assert.ok(sky.max - sky.min > 8 && sky.changedPixels >= 32, 'Control must pass the old nonblank check');
  assert.throws(() => requireNonblank(sky));
  const noisyGradient = Buffer.from(gradient);
  for (let i = 0; i < noisyGradient.length; i++) noisyGradient[i] += Math.floor(i / 3) % 10;
  assert.throws(() => requireNonblank(pixelStats(noisyGradient, 3, 16)));
  const triangle = Buffer.from(gradient);
  for (let y = 3; y < 14; y++) for (let x = 8 - Math.floor(y / 2); x <= 8 + Math.floor(y / 2); x++) triangle.fill(240, (y * 16 + x) * 3, (y * 16 + x + 1) * 3);
  requireNonblank(pixelStats(triangle, 3, 16));
  assert.equal(isEnvironmentScript(new URL('http://gc.kis.v2.scr.kaspersky-labs.com/FD126C42-EBFA-4E12-B309-BB3FDD723AC1/main.js?attr=redacted')), true);
  for (const url of ['https://example.com/main.js', 'http://gc.kis.v2.scr.kaspersky-labs.com/game.js', 'http://localhost/main.js']) assert.equal(isEnvironmentScript(new URL(url)), false);
}
selfTest();
if (values['self-test']) {
  console.log(JSON.stringify({ status: 'passed', checks: ['hardware classification', 'software rejection', 'uniform canvas rejection', 'gradient-only rejection', 'visible triangle'] }, null, 2));
} else {
  const report = { status: 'failed', mode: values.probe ? 'gpu-probe' : 'fixture', startedAt: new Date().toISOString(), launchArgs: [], browserErrors: [], consoleErrors: [], failedRequests: [], failedResponses: [], neutralizedEnvironmentScripts: [] };
  let browser; let server;
  const previousEnv = Object.fromEntries(['TEMP', 'TMP', 'PLAYWRIGHT_BROWSERS_PATH'].map(k => [k, process.env[k]]));
  try {
    const executablePath = values.chromium ?? chromium.executablePath();
    assert.ok(existsSync(executablePath), `Installed Chromium missing: ${executablePath}; pass --chromium <path>`);
    const taskTemp = mkdtempSync(join(tmpdir(), 'standalone-hardware-'));
    process.env.TEMP = taskTemp; process.env.TMP = taskTemp; process.env.PLAYWRIGHT_BROWSERS_PATH = join(taskTemp, 'browsers');
    report.taskTemp = taskTemp; report.executablePath = executablePath;
    browser = await chromium.launch({ headless: true, executablePath, args: [] }); report.browserVersion = browser.version();
    const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
    page.on('pageerror', error => report.browserErrors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push(message.text()); });
    page.on('requestfailed', request => report.failedRequests.push({ url: request.url(), error: request.failure()?.errorText }));
    page.on('response', response => { if (response.status() >= 400) report.failedResponses.push({ url: response.url(), status: response.status() }); });
    const inspectGpu = selector => page.evaluate(selector => {
      const canvas = selector ? document.querySelector(selector) : document.createElement('canvas');
      const gl = canvas?.getContext('webgl2'); if (!gl) return { webgl2: false };
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return { webgl2: true, vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null, renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null, version: gl.getParameter(gl.VERSION) };
    }, selector);
    report.gpu = await inspectGpu(null); requireHardware(report.gpu);
    if (!values.probe) {
      assert.equal(positionals.length, 1, 'Provide a built game directory or local URL (or use --probe)');
      let url;
      if (/^https?:\/\//i.test(positionals[0])) {
        const parsed = new URL(positionals[0]); assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname), 'Only loopback URLs are supported'); url = parsed.href;
      } else {
        const root = realpathSync(resolve(positionals[0]));
        assert.ok(statSync(root).isDirectory() && existsSync(join(root, 'index.html')), 'Built directory must contain index.html');
        const mime = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.woff2': 'font/woff2' };
        server = createServer((request, response) => {
          try {
            const pathname = decodeURIComponent(new URL(request.url ?? '/', 'http://localhost').pathname);
            const candidate = resolve(root, '.' + pathname.replace(/\/$/, '/index.html'));
            if (!candidate.startsWith(root + sep) || !existsSync(candidate)) { response.writeHead(404).end(); return; }
            const file = realpathSync(candidate);
            if (!file.startsWith(root + sep) || !statSync(file).isFile()) { response.writeHead(403).end(); return; }
            response.setHeader('Content-Type', mime[extname(file)] ?? 'application/octet-stream'); createReadStream(file).on('error', () => response.destroy()).pipe(response);
          } catch { response.writeHead(400).end(); }
        });
        await new Promise((yes, no) => { server.once('error', no); server.listen(0, '127.0.0.1', yes); });
        url = `http://127.0.0.1:${server.address().port}/`; report.builtDirectory = root;
      }
      report.url = url;
      await page.route('**/*', route => {
        const target = new URL(route.request().url());
        if (isEnvironmentScript(target)) {
          report.neutralizedEnvironmentScripts.push(target.origin + target.pathname);
          return route.fulfill({ status: 200, contentType: 'text/javascript', body: '' });
        }
        if (target.pathname === '/favicon.ico') return route.fulfill({ status: 204 });
        return target.origin === new URL(url).origin || ['data:', 'blob:'].includes(target.protocol) ? route.continue() : route.abort('blockedbyclient');
      });
      await page.goto(url, { waitUntil: 'load', timeout: 90_000 });
      await page.waitForFunction(() => document.body.dataset.booted === '1' || document.body.dataset.bootError !== undefined, null, { timeout: 90_000 });
      report.bootError = await page.getAttribute('body', 'data-boot-error'); assert.equal(report.bootError, null, 'Game boot failed'); report.bootReady = true;
      await page.waitForFunction(() => document.querySelector('#fixture-job')?.textContent === 'Job: 42' && /^SQL: \d+$/.test(document.querySelector('#fixture-sql')?.textContent ?? ''), null, { timeout: 30_000 });
      assert.equal(await page.textContent('#fixture-error'), '', 'Fixture reported an error');
      const canvas = page.locator('canvas').first(); await canvas.waitFor({ state: 'visible' });
      await canvas.evaluate(node => node.setAttribute('data-hardware-smoke', '1'));
      report.canvasGpu = await inspectGpu('canvas[data-hardware-smoke="1"]'); requireHardware(report.canvasGpu);
      const before = await page.locator(values['button-result']).textContent(); await page.locator(values.button).click({ timeout: 15_000 });
      await page.waitForFunction(({ selector, before }) => { const node = document.querySelector(selector); return node !== null && node.textContent !== before; }, { selector: values['button-result'], before }, { timeout: 15_000 });
      report.interaction = { button: values.button, result: values['button-result'], before, after: await page.locator(values['button-result']).textContent() };
      // Hide all DOM overlays so HUD text cannot make a blank WebGL canvas pass.
      const overlayStyle = await page.addStyleTag({ content: 'body * { visibility: hidden !important; } canvas[data-hardware-smoke] { visibility: visible !important; }' });
      try {
        const started = Date.now(); const deadline = started + 30_000; let png; let attempts = 0;
        // Boot and SQL/job completion precede asynchronous chunk presentation. Retry until the triangle is visible.
        for (;;) {
          const remaining = deadline - Date.now();
          if (remaining <= 0) { requireNonblank(report.canvas); break; }
          png = await canvas.screenshot({ timeout: Math.min(15_000, remaining) });
          const raw = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
          report.canvas = { width: raw.info.width, height: raw.info.height, overlaysHidden: true, ...pixelStats(raw.data, raw.info.channels, raw.info.width), captureAttempts: ++attempts, waitedMs: Date.now() - started };
          if (hasVisibleGeometry(report.canvas)) break;
          await page.waitForTimeout(Math.min(250, Math.max(0, deadline - Date.now())));
        }
        requireNonblank(report.canvas);
        if (values.out) { const screenshot = resolve(values.out).replace(/\.json$/i, '') + '.canvas.png'; mkdirSync(dirname(screenshot), { recursive: true }); writeFileSync(screenshot, png); report.screenshot = screenshot; }
      } finally { await overlayStyle.evaluate(node => node.remove()); }
      assert.deepEqual(report.browserErrors, [], 'Browser exceptions'); assert.deepEqual(report.consoleErrors, [], 'Browser console errors');
      assert.deepEqual(report.failedRequests, [], 'Failed browser requests'); assert.deepEqual(report.failedResponses, [], 'HTTP error responses');
    }
    report.status = 'passed';
  } catch (error) { report.error = error.stack ?? String(error); process.exitCode = 1; }
  finally {
    await browser?.close(); if (server) await new Promise(resolve => server.close(resolve));
    for (const [key, value] of Object.entries(previousEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    report.finishedAt = new Date().toISOString();
    if (values.out) { const output = resolve(values.out); mkdirSync(dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); }
    console.log(JSON.stringify(report, null, 2));
  }
}
