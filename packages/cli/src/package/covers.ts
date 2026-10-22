// The Playgama covers from real captures of the built game. The cover specs, the image-header reader and checkCovers are copied
// from purge-protocol-web ebab692 tools/package/covers.ts (platform-playgama.md §9.4: square 800×800, portrait 1080×1920,
// landscape 1920×1080, PNG/JPEG, ≤ 10 MB, exact sizes). The capture is new: the dist is served on 127.0.0.1, headless
// Chromium on SwiftShader (PP's playwright.config.ts SWIFTSHADER_ARGS, no GPU switch) loads it with every other host blocked,
// each shot is taken (a URL query and/or the game's capture script drives the page), and sharp writes the exact cover sizes.
import { createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { extname, isAbsolute, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { LaunchOptions } from '@playwright/test';
import type { CoverShot, ResolvedPackageConfig } from './config.ts';

export interface CoverSpec {
  id: 'square' | 'portrait' | 'landscape';
  width: number;
  height: number;
}

/** the three Playgama covers, exact sizes (platform-playgama.md §9.4) */
export const COVER_SPECS: readonly CoverSpec[] = [
  { id: 'square', width: 800, height: 800 },
  { id: 'portrait', width: 1080, height: 1920 },
  { id: 'landscape', width: 1920, height: 1080 },
];

/** "≤ 10 MB" read as decimal bytes */
export const MAX_COVER_BYTES = 10_000_000;

/** headless Chromium on SwiftShader: software GL through ANGLE, WebGPU hidden, no GPU switch; audio silent */
export const SWIFTSHADER_ARGS: readonly string[] = [
  '--use-angle=swiftshader',
  '--use-gl=angle',
  '--enable-unsafe-swiftshader',
  '--disable-vulkan',
  '--disable-gpu-compositing',
  '--disable-blink-features=WebGPU',
];
const AUDIO_ARGS: readonly string[] = ['--autoplay-policy=no-user-gesture-required', '--mute-audio'];

/** Capture defaults stay software-rendered; native rendering and installed browsers require explicit environment flags. */
export function coverLaunchOptions(env: Readonly<Record<string, string | undefined>>): LaunchOptions {
  const channel = env['SS_BROWSER_CHANNEL'];
  return {
    headless: true,
    ...(channel === 'chrome' || channel === 'msedge' ? { channel } : {}),
    args: [...(env['SS_BROWSER_NATIVE'] === '1' ? [] : SWIFTSHADER_ARGS), ...AUDIO_ARGS],
  };
}

export interface CoverFinding {
  rule: 'covers';
  file: string;
  message: string;
}

export interface CoverImage {
  file: string;
  format: 'png' | 'jpeg';
  width: number;
  height: number;
  bytes: number;
}

/** PNG: signature + IHDR (width, height big-endian at bytes 16-23). */
function pngSize(b: Uint8Array): { width: number; height: number } | null {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (b.length < 24 || sig.some((v, i) => b[i] !== v)) return null;
  if (String.fromCharCode(b[12]!, b[13]!, b[14]!, b[15]!) !== 'IHDR') return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return { width: dv.getUint32(16), height: dv.getUint32(20) };
}

/** JPEG: walk the markers to the first SOFn frame header (height, width big-endian after the precision byte). */
function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    if (len < 2) return null;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > b.length) return null;
      return { height: (b[i + 5]! << 8) | b[i + 6]!, width: (b[i + 7]! << 8) | b[i + 8]! };
    }
    if (marker === 0xda || marker === 0xd9) return null;
    i += 2 + len;
  }
  return null;
}

/** Reads an image header: PNG or JPEG with its pixel size, or null when the bytes are neither. */
export function imageSize(bytes: Uint8Array): { format: 'png' | 'jpeg'; width: number; height: number } | null {
  const png = pngSize(bytes);
  if (png) return { format: 'png', ...png };
  const jpg = jpegSize(bytes);
  if (jpg) return { format: 'jpeg', ...jpg };
  return null;
}

/**
 * Checks a covers directory: every regular file must be a PNG or JPEG ≤ 10 MB whose pixel size is one of the three specs, and
 * each spec must be present.
 */
export function checkCovers(dir: string | null | undefined): { findings: CoverFinding[]; covers: CoverImage[] } {
  const findings: CoverFinding[] = [];
  const covers: CoverImage[] = [];
  if (dir === null || dir === undefined || !existsSync(dir) || !statSync(dir).isDirectory()) {
    findings.push({ rule: 'covers', file: dir ?? '<none>', message: 'no covers directory: the three Playgama covers (800×800, 1080×1920, 1920×1080 PNG/JPEG) are required' });
    return { findings, covers };
  }
  for (const name of readdirSync(dir).sort()) {
    const path = `${dir}/${name}`;
    const st = statSync(path);
    if (!st.isFile()) continue;
    if (st.size > MAX_COVER_BYTES) findings.push({ rule: 'covers', file: name, message: `${st.size} B, over the ${MAX_COVER_BYTES} B cover limit` });
    const info = imageSize(readFileSync(path));
    if (info === null) {
      findings.push({ rule: 'covers', file: name, message: 'not a PNG or JPEG image' });
      continue;
    }
    covers.push({ file: name, format: info.format, width: info.width, height: info.height, bytes: st.size });
    if (!COVER_SPECS.some((c) => c.width === info.width && c.height === info.height)) {
      findings.push({ rule: 'covers', file: name, message: `${info.width}×${info.height} is not a Playgama cover size (${COVER_SPECS.map((c) => `${c.width}×${c.height}`).join(', ')})` });
    }
  }
  for (const spec of COVER_SPECS) {
    if (!covers.some((c) => c.width === spec.width && c.height === spec.height)) {
      findings.push({ rule: 'covers', file: dir, message: `the ${spec.id} cover ${spec.width}×${spec.height} is missing` });
    }
  }
  return { findings, covers };
}

// ---------------------------------------------------------------------------------------------------------------- capture

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.ktx2': 'image/ktx2',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** A static server of one directory on 127.0.0.1 (an ephemeral port). Nothing outside the directory is served. */
export async function serveDir(dir: string): Promise<{ url: string; close: () => Promise<void> }> {
  const root = resolve(dir);
  const server: Server = createServer((req, res) => {
    let rel: string;
    try {
      rel = decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (rel.endsWith('/')) rel += 'index.html';
    const file = resolve(root, `.${rel}`);
    if ((file !== root && !file.startsWith(root + sep)) || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream', 'Cache-Control': 'no-store' });
    createReadStream(file).pipe(res);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('serveDir: no port');
  return { url: `http://127.0.0.1:${addr.port}/`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

/** what the page showed while it was captured */
export interface RuntimeProbe {
  /** requests to any host but the local server (blocked) */
  blockedRequests: string[];
  /** `window.bridge` existed at the cover shot */
  bridgePresent: boolean;
  /** `bridge.isInitialized` at the cover shot */
  bridgeInitialized: boolean;
  consoleErrors: string[];
  pageErrors: string[];
}

export interface CoversOutcome {
  covers: CoverImage[];
  screenshots: string[];
  findings: CoverFinding[];
  probe: RuntimeProbe;
}

/** a page-driving hook: `export async function capture(page, shot, { viewport })` in the game's covers.script */
type CaptureHook = (page: unknown, shot: CoverShot, ctx: { viewport: { width: number; height: number } }) => Promise<void> | void;

export interface CaptureOptions {
  distDir: string;
  outDir: string;
  gameDir: string;
  cfg: ResolvedPackageConfig;
  /** screenshot viewport of the non-cover shots (default 1280×720) */
  screenshotViewport?: { width: number; height: number };
}

/**
 * Captures every shot (screenshots/<shot>.png at 1280×720) and the cover shot at the three cover sizes (covers/<spec>-WxH.png),
 * then checks the covers directory.
 */
export async function captureCovers(o: CaptureOptions): Promise<CoversOutcome> {
  const { chromium } = await import('@playwright/test');
  const sharp = (await import('sharp')).default;
  const cv = o.cfg.covers;
  let hook: CaptureHook | null = null;
  if (cv.script !== null) {
    const file = isAbsolute(cv.script) ? cv.script : resolve(o.gameDir, cv.script);
    const mod = (await import(pathToFileURL(file).href)) as { capture?: CaptureHook; default?: CaptureHook };
    hook = mod.capture ?? mod.default ?? null;
    if (hook === null) throw new Error(`covers.script ${cv.script} exports no capture(page, shot)`);
  }
  const coverShot = cv.shots.find((s) => s.id === cv.cover);
  if (coverShot === undefined) throw new Error(`covers.cover "${cv.cover}" is not one of the shots (${cv.shots.map((s) => s.id).join(', ')})`);
  const coversDir = `${o.outDir}/covers`;
  const shotsDir = `${o.outDir}/screenshots`;
  mkdirSync(coversDir, { recursive: true });
  mkdirSync(shotsDir, { recursive: true });
  const server = await serveDir(o.distDir);
  const origin = new URL(server.url).origin;
  const probe: RuntimeProbe = { blockedRequests: [], bridgePresent: false, bridgeInitialized: false, consoleErrors: [], pageErrors: [] };
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const screenshots: string[] = [];
  try {
    browser = await chromium.launch(coverLaunchOptions(process.env));
    const shoot = async (shot: CoverShot, viewport: { width: number; height: number }, probeBridge: boolean): Promise<Buffer> => {
      const ctx = await browser!.newContext({ viewport, deviceScaleFactor: 1 });
      try {
        await ctx.route('**/*', (route) => {
          const u = route.request().url();
          if (u.startsWith(origin) || u.startsWith('data:') || u.startsWith('blob:')) return route.continue();
          if (!probe.blockedRequests.includes(u)) probe.blockedRequests.push(u);
          return route.abort('blockedbyclient');
        });
        const page = await ctx.newPage();
        page.on('console', (m) => {
          if (m.type() === 'error' && probe.consoleErrors.length < 20) probe.consoleErrors.push(m.text().slice(0, 300));
        });
        page.on('pageerror', (e) => {
          if (probe.pageErrors.length < 20) probe.pageErrors.push(String(e.message).slice(0, 300));
        });
        await page.goto(`${server.url}index.html${shot.query ?? ''}`, { waitUntil: 'load', timeout: cv.timeoutMs });
        await page.waitForSelector(cv.readySelector, { state: 'attached', timeout: cv.timeoutMs });
        if (hook !== null) await hook(page, shot, { viewport });
        await page.waitForTimeout(shot.waitMs ?? 1500);
        if (probeBridge) {
          const b = await page.evaluate(() => {
            const br = (globalThis as { bridge?: { isInitialized?: boolean } }).bridge;
            return { present: typeof br === 'object' && br !== null, initialized: br?.isInitialized === true };
          });
          probe.bridgePresent = b.present;
          probe.bridgeInitialized = b.initialized;
        }
        return await page.screenshot({ type: 'png', animations: 'allow' });
      } finally {
        await ctx.close();
      }
    };
    const view = o.screenshotViewport ?? { width: 1280, height: 720 };
    for (const shot of o.cfg.covers.shots) {
      const png = await shoot(shot, view, false);
      const file = `${shotsDir}/${shot.id}.png`;
      writeFileSync(file, await sharp(png).png({ compressionLevel: 9 }).toBuffer());
      screenshots.push(file);
    }
    for (const spec of COVER_SPECS) {
      const png = await shoot(coverShot, { width: spec.width, height: spec.height }, spec.id === 'landscape');
      let out = await sharp(png).resize(spec.width, spec.height, { fit: 'cover', position: 'centre' }).png({ compressionLevel: 9 }).toBuffer();
      let name = `${spec.id}-${spec.width}x${spec.height}.png`;
      if (out.length > MAX_COVER_BYTES) {
        out = await sharp(png).resize(spec.width, spec.height, { fit: 'cover' }).jpeg({ quality: 90 }).toBuffer();
        name = `${spec.id}-${spec.width}x${spec.height}.jpg`;
      }
      writeFileSync(`${coversDir}/${name}`, out);
    }
  } finally {
    try { await browser?.close(); } finally { await server.close(); }
  }
  const { findings, covers } = checkCovers(coversDir);
  return { covers, screenshots, findings, probe };
}
