// Offline Playgama build check, from purge-protocol-web ebab692 tools/package/playgama-check.ts (PP's B7 PG-01..16), made
// game-agnostic: the orientation, placements and allowed URLs come from the game config; PP's PG-17 (last-shot) and its
// landscape-only / rewarded-required rules are per-game policy (`platform.playgama.extraChecks`), not here. Added: PG-17
// relative paths, PG-18 size budgets, PG-19 orientation and aspect handling. Playgama's real build check runs only on an
// uploaded archive; nothing here uploads or submits. Every check reports pass/fail with evidence (where a requirement was met)
// and findings (where it was not). Pure over the archive inventory.
//
//   PG-01 archive-size        zip and uncompressed content ≤ 300,000,000 B (§9.1, §13)
//   PG-02 root-index          index.html at the archive root
//   PG-03 latin-names         every entry name Latin-only and relative
//   PG-04 bridge-sdk          index.html loads the Bridge (CDN tag in <head> before any game script, local fallback shipped)
//   PG-05 bridge-version      the shipped Bridge runtime reports a version ≥ 2.2.0
//   PG-06 bridge-config       playgama-bridge-config.json at the root, plain JSON, error popup and banners off, interstitial
//                             placements named (interstitials are required, §4.1), pacing set, and equal to the game config
//   PG-07 sdk-init            the game initialises the Bridge and sends game_ready
//   PG-08 pause-audio         the game follows the platform pause and audio events (Bridge folds tab visibility into them)
//   PG-09 ads                 ads only through the Bridge; no other ad SDK
//   PG-10 saves               saves through bridge.storage; no localStorage / sessionStorage / indexedDB / cookie in game code
//   PG-11 external-hosts      no URL to any host except the Bridge CDN in index.html; no external fonts
//   PG-12 no-sitelock         no host / referrer checks in game code
//   PG-13 forbidden-apis      no alert / confirm / prompt, window.open or sendBeacon in game code
//   PG-14 page-shell          <html lang>, a viewport meta, no page scrollbar, touch-action none on the canvas (or html/body)
//   PG-15 title               the page title is 2-4 words
//   PG-16 no-dev-files        no source maps, .vite/, test hooks or fake ads
//   PG-17 relative-paths      no root-absolute URL in HTML, CSS or module imports (games live under a build-id sub-folder)
//   PG-18 size-budgets        the game's budgets (total, initial, zip, file count, per-file caps)
//   PG-19 orientation-aspect  the declared orientation is the bridge config's, and the game handles resizes
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { unzipSync } from 'fflate';
import { BRIDGE_CONFIG_JSON } from './bridge-config.ts';
import type { BudgetReport } from './budgets.ts';
import { scanRootAbsolute } from './dist.ts';

export const BRIDGE_JS = 'playgama-bridge.js';
export const BRIDGE_CDN = 'https://bridge.playgama.com/v2/stable/playgama-bridge.js';
export const MAX_ARCHIVE_BYTES = 300_000_000;
export const MIN_BRIDGE_VERSION = '2.2.0';

/**
 * URLs allowed in shipped game files by exact string: the never-fetched strings of the runtime's three.js r186 bundle (XML
 * namespaces, a GitHub issue link and a shadertoy link). Games add theirs with `platform.playgama.allowUrls`.
 */
export const ALLOWED_URLS: readonly string[] = [
  'http://www.w3.org/2000/svg',
  'http://www.w3.org/1999/xhtml',
  'http://www.w3.org/1998/Math/MathML',
  'http://www.w3.org/XML/1998/namespace',
  'http://www.w3.org/1999/xlink',
  'http://www.w3.org/2000/xmlns/',
  'https://github.com/mrdoob/three.js/issues/32012',
  'https://www.shadertoy.com/view/WtyXRy',
];

/** ad SDK hosts and loader names other than the Bridge (platform-playgama.md §13 "No other ad SDKs") */
const FOREIGN_AD_SDK = /googlesyndication|adsbygoogle|imasdk\.googleapis|doubleclick\.net|sdk\.crazygames\.com|game-cdn\.poki\.com|gamedistribution\.com\/main\.min\.js|yandex\.ru\/games\/sdk|applovin|ironsrc|unityads/i;

/** web-font hosts: a font must ship inside the build */
const FONT_HOSTS = /fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net|fonts\.bunny\.net|fast\.fonts\.net|cdnjs\.cloudflare\.com\/ajax\/libs\/font-awesome/i;

export const DEFAULT_TEST_HOOKS: readonly string[] = ['__ppTest', '__PP_TEST_HOOKS__', 'fake-ads', '__ssTest'];

export interface ArchiveEntry {
  name: string;
  /** uncompressed size */
  size: number;
  /** decoded text for text entries (html/js/css/json/txt/svg), null for binaries */
  text: string | null;
}

export interface PgFinding {
  file?: string;
  message: string;
}

export interface PgCheck {
  id: string;
  name: string;
  status: 'pass' | 'fail' | 'waived';
  /** what was found that meets the requirement */
  evidence: string[];
  /** what fails it */
  findings: PgFinding[];
  waiver?: string;
}

export interface PgReport {
  status: 'pass' | 'fail';
  zipBytes: number;
  entries: number;
  uncompressedBytes: number;
  checks: PgCheck[];
}

export interface PgContext {
  /** the bridge config the game config asks for (PG-06 compares the shipped file to it) */
  expectedBridgeConfig?: Record<string, unknown>;
  /** declared orientations (PG-19) */
  orientations?: readonly string[];
  allowUrls?: readonly string[];
  /** extra test-hook strings (PG-16) */
  testHooks?: readonly string[];
  budgets?: BudgetReport;
  waive?: Readonly<Record<string, string>>;
  extraChecks?: ReadonlyArray<(entries: readonly ArchiveEntry[]) => PgCheck | PgCheck[]>;
}

const TEXT_ENTRY = /\.(html?|css|m?js|json|txt|svg)$/i;
const isGameCode = (name: string): boolean => /\.(m?js|html?)$/i.test(name) && name !== BRIDGE_JS;

/** a nested property of parsed JSON, or undefined */
function at(o: unknown, ...keys: string[]): unknown {
  let cur = o;
  for (const k of keys) {
    if (typeof cur !== 'object' || cur === null || Array.isArray(cur)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** semver-ish compare of dotted numeric versions */
export function versionAtLeast(v: string, min: string): boolean {
  const a = v.split('.').map(Number);
  const b = min.split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (!Number.isFinite(x)) return false;
    if (x !== y) return x > y;
  }
  return true;
}

/** the version the pinned Bridge runtime reports (`get version(){return"2.3.1"}`), or null */
export function bridgeVersionOf(text: string): string | null {
  const m = /get version\(\)\s*\{\s*return\s*["'`](\d+\.\d+\.\d+)["'`]/.exec(text);
  return m ? m[1]! : null;
}

/** Reads a zip: every entry's name and size from the central directory, the text of text entries only. */
export function readArchive(zipPath: string): { zipBytes: number; entries: ArchiveEntry[] } {
  const fd = openSync(zipPath, 'r');
  let buf: Buffer;
  try {
    const size = fstatSync(fd).size;
    if (size > MAX_ARCHIVE_BYTES) return { zipBytes: size, entries: [] };
    buf = Buffer.alloc(size);
    let off = 0;
    while (off < size) {
      const n = readSync(fd, buf, off, size - off, off);
      if (n <= 0) throw new Error(`short read of ${zipPath}`);
      off += n;
    }
  } finally {
    closeSync(fd);
  }
  const sizes = new Map<string, number>();
  const texts = unzipSync(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), {
    filter: (f) => {
      sizes.set(f.name, f.originalSize);
      return TEXT_ENTRY.test(f.name) && f.originalSize <= 64 * 1024 * 1024;
    },
  });
  const dec = new TextDecoder();
  const entries = [...sizes].map(([name, size]) => ({ name, size, text: texts[name] ? dec.decode(texts[name]) : null }));
  return { zipBytes: buf.length, entries };
}

/** canonical JSON (sorted keys) for comparing two configs */
const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x: unknown) => (typeof x === 'object' && x !== null && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

/** Runs PG-01..PG-19 (and the game's policy checks) over an archive inventory. */
export function checkPlaygamaArchive(entries: readonly ArchiveEntry[], zipBytes: number, ctx: PgContext = {}): PgReport {
  const byName = new Map(entries.map((e) => [e.name, e]));
  const checks: PgCheck[] = [];
  const add = (id: string, name: string, findings: PgFinding[], evidence: string[] = []): void => {
    const waiver = ctx.waive?.[id];
    checks.push({ id, name, status: waiver !== undefined ? 'waived' : findings.length === 0 ? 'pass' : 'fail', evidence, findings, ...(waiver !== undefined ? { waiver } : {}) });
  };
  const gameTexts = entries.filter((e) => e.text !== null && isGameCode(e.name)) as Array<ArchiveEntry & { text: string }>;
  const grep = (re: RegExp): Array<{ file: string; match: string }> => {
    const out: Array<{ file: string; match: string }> = [];
    for (const e of gameTexts) for (const m of e.text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))) out.push({ file: e.name, match: m[0] });
    return out;
  };
  /** the first file whose game code matches, as evidence, or null */
  const where = (re: RegExp): string | null => {
    for (const e of gameTexts) {
      const m = re.exec(e.text);
      if (m) return `${e.name}: ${m[0].slice(0, 80)}`;
    }
    return null;
  };
  const need = (re: RegExp, missing: string, f: PgFinding[], ev: string[]): void => {
    const w = where(re);
    if (w === null) f.push({ message: missing });
    else ev.push(w);
  };
  const uncompressed = entries.reduce((s, e) => s + e.size, 0);
  const html = byName.get('index.html')?.text ?? null;

  // PG-01
  const f01: PgFinding[] = [];
  if (zipBytes > MAX_ARCHIVE_BYTES) f01.push({ message: `the zip is ${zipBytes} B, over the ${MAX_ARCHIVE_BYTES} B limit` });
  if (uncompressed > MAX_ARCHIVE_BYTES) f01.push({ message: `the content is ${uncompressed} B uncompressed, over the ${MAX_ARCHIVE_BYTES} B limit` });
  if (entries.length === 0) f01.push({ message: 'the archive has no entries (or was too large to read)' });
  add('PG-01', 'archive-size', f01, [`zip ${zipBytes} B, ${uncompressed} B uncompressed, ${entries.length} entries`]);

  // PG-02
  const f02: PgFinding[] = [];
  if (!byName.has('index.html')) {
    const nested = entries.find((e) => e.name.endsWith('/index.html'));
    f02.push({ file: nested?.name ?? 'index.html', message: 'index.html must be at the archive root' });
  }
  add('PG-02', 'root-index', f02, f02.length === 0 ? ['index.html'] : []);

  // PG-03
  add(
    'PG-03',
    'latin-names',
    entries
      .filter((e) => !/^[A-Za-z0-9._\-/]+$/.test(e.name) || e.name.startsWith('/') || e.name.split('/').includes('..'))
      .map((e) => ({ file: e.name, message: 'not a Latin-only relative path' })),
  );

  // PG-04
  const f04: PgFinding[] = [];
  const ev04: string[] = [];
  if (html === null) f04.push({ file: 'index.html', message: 'no index.html to read' });
  else {
    const head = /<head[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? '';
    const scripts = [...head.matchAll(/<script\b[^>]*>/gi)].map((m) => m[0]);
    const cdnAt = scripts.findIndex((s) => s.includes(`src="${BRIDGE_CDN}"`) || s.includes(`src='${BRIDGE_CDN}'`));
    const localAt = scripts.findIndex((s) => /src=["']\.?\/?playgama-bridge\.js["']/.test(s));
    const firstGame = scripts.findIndex((s) => /type=["']module["']/i.test(s));
    const bridgeAt = cdnAt >= 0 ? cdnAt : localAt;
    if (bridgeAt < 0) f04.push({ file: 'index.html', message: `no <script src="${BRIDGE_CDN}"> (or ./playgama-bridge.js) in <head>` });
    else {
      ev04.push(`index.html <head> script #${bridgeAt + 1}: ${scripts[bridgeAt]}`);
      if (/\b(async|defer)\b|type=["']module["']/i.test(scripts[bridgeAt]!)) f04.push({ file: 'index.html', message: 'the Bridge script must be a plain blocking script (no async/defer/module), so window.bridge exists before the game' });
      if (firstGame >= 0 && firstGame < bridgeAt) f04.push({ file: 'index.html', message: 'a game module script comes before the Bridge script' });
    }
    if (cdnAt >= 0 && !/\.\/playgama-bridge\.js|["']playgama-bridge\.js/.test(head)) f04.push({ file: 'index.html', message: 'no local fallback to ./playgama-bridge.js in <head>' });
  }
  const bridge = byName.get(BRIDGE_JS);
  if (!bridge || bridge.size === 0) f04.push({ file: BRIDGE_JS, message: 'the local Bridge runtime is missing or empty' });
  else ev04.push(`${BRIDGE_JS} ${bridge.size} B`);
  add('PG-04', 'bridge-sdk', f04, ev04);

  // PG-05
  const f05: PgFinding[] = [];
  const version = bridge?.text ? bridgeVersionOf(bridge.text) : null;
  if (version === null) f05.push({ file: BRIDGE_JS, message: 'the Bridge runtime does not report its version' });
  else if (!versionAtLeast(version, MIN_BRIDGE_VERSION)) f05.push({ file: BRIDGE_JS, message: `Bridge ${version} is older than ${MIN_BRIDGE_VERSION}` });
  add('PG-05', 'bridge-version', f05, version !== null ? [`Bridge ${version}`] : []);

  // PG-06
  const f06: PgFinding[] = [];
  const ev06: string[] = [];
  const cfgEntry = byName.get(BRIDGE_CONFIG_JSON);
  let cfg: unknown;
  if (!cfgEntry?.text) f06.push({ file: BRIDGE_CONFIG_JSON, message: 'missing at the archive root' });
  else {
    try {
      cfg = JSON.parse(cfgEntry.text);
    } catch (e) {
      f06.push({ file: BRIDGE_CONFIG_JSON, message: `not plain JSON: ${(e as Error).message}` });
    }
    if (cfg !== undefined) {
      if (typeof cfg !== 'object' || cfg === null || Array.isArray(cfg)) f06.push({ file: BRIDGE_CONFIG_JSON, message: 'must be a JSON object' });
      else {
        const ad = at(cfg, 'advertisement');
        if (typeof ad !== 'object' || ad === null) f06.push({ file: BRIDGE_CONFIG_JSON, message: 'no advertisement section' });
        else {
          if (at(ad, 'useAdvertisementErrorPopup') !== false) f06.push({ file: BRIDGE_CONFIG_JSON, message: 'advertisement.useAdvertisementErrorPopup must be false' });
          if (at(ad, 'banner', 'disable') !== true) f06.push({ file: BRIDGE_CONFIG_JSON, message: 'advertisement.banner.disable must be true (no banners, §13)' });
          if (at(ad, 'advancedBanners') !== undefined && at(ad, 'advancedBanners', 'disable') !== true) f06.push({ file: BRIDGE_CONFIG_JSON, message: 'advertisement.advancedBanners must be disabled' });
          const ip = at(ad, 'interstitial', 'placements');
          if (at(ad, 'interstitial', 'disable') === true || !Array.isArray(ip) || ip.length === 0 || !ip.every((x: unknown) => typeof at(x, 'id') === 'string')) {
            f06.push({ file: BRIDGE_CONFIG_JSON, message: 'advertisement.interstitial.placements must name at least one placement (interstitials at natural breaks are required, §4.1): set platform.playgama.ads.interstitial' });
          } else ev06.push(`interstitial placements: ${ip.map((x: unknown) => at(x, 'id')).join(', ')}`);
          const rp = at(ad, 'rewarded', 'placements');
          if (at(ad, 'rewarded', 'disable') !== true && (!Array.isArray(rp) || rp.length === 0)) f06.push({ file: BRIDGE_CONFIG_JSON, message: 'advertisement.rewarded is enabled but names no placement' });
          if (typeof at(ad, 'minimumDelayBetweenInterstitial') !== 'number') f06.push({ file: BRIDGE_CONFIG_JSON, message: 'advertisement.minimumDelayBetweenInterstitial (pacing) must be set' });
          else ev06.push(`pacing ${String(at(ad, 'minimumDelayBetweenInterstitial'))} s`);
        }
        if (ctx.expectedBridgeConfig !== undefined && canon(cfg) !== canon(ctx.expectedBridgeConfig)) f06.push({ file: BRIDGE_CONFIG_JSON, message: 'differs from the config the game config declares (platform.playgama)' });
      }
    }
  }
  add('PG-06', 'bridge-config', f06, ev06);

  // PG-07
  const f07: PgFinding[] = [];
  const ev07: string[] = [];
  need(/\.initialize\(/, 'no game chunk calls bridge.initialize()', f07, ev07);
  need(/game_ready|GAME_READY/, 'no game chunk sends the game_ready message', f07, ev07);
  need(/\.platform\.sendMessage\(/, 'no game chunk calls bridge.platform.sendMessage', f07, ev07);
  add('PG-07', 'sdk-init', f07, ev07);

  // PG-08
  const f08: PgFinding[] = [];
  const ev08: string[] = [];
  need(/\.platform\.on\(\s*(?:[\w$.]*PAUSE_STATE_CHANGED|["'`]pause_state_changed["'`])/, 'no subscription to the platform pause state (PAUSE_STATE_CHANGED)', f08, ev08);
  need(/\.platform\.on\(\s*(?:[\w$.]*AUDIO_STATE_CHANGED|["'`]audio_state_changed["'`])/, 'no subscription to the platform audio state (AUDIO_STATE_CHANGED)', f08, ev08);
  const vis = where(/visibilitychange/);
  if (vis !== null) ev08.push(`also listens to ${vis}`);
  add('PG-08', 'pause-audio', f08, ev08);

  // PG-09
  const f09: PgFinding[] = [];
  const ev09: string[] = [];
  need(/\.showInterstitial\(/, 'no interstitial through the Bridge (advertisement.showInterstitial)', f09, ev09);
  for (const h of grep(FOREIGN_AD_SDK)) f09.push({ file: h.file, message: `another ad SDK is referenced: ${h.match}` });
  const rw = where(/\.showRewarded\(/);
  if (rw !== null) ev09.push(rw);
  add('PG-09', 'ads', f09, ev09);

  // PG-10
  const f10: PgFinding[] = [];
  const ev10: string[] = [];
  need(/\.storage\.get\(/, 'no save read through bridge.storage.get', f10, ev10);
  need(/\.storage\.set\(/, 'no save write through bridge.storage.set', f10, ev10);
  const storeHits = new Map<string, Set<string>>();
  for (const h of grep(/\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|document\.cookie/)) (storeHits.get(h.file) ?? storeHits.set(h.file, new Set()).get(h.file)!).add(h.match);
  for (const [file, m] of storeHits) f10.push({ file, message: `${[...m].join(', ')} in a game chunk: saves go through bridge.storage only` });
  add('PG-10', 'saves', f10, ev10);

  // PG-11
  const f11: PgFinding[] = [];
  const allowed = new Set([...ALLOWED_URLS, ...(ctx.allowUrls ?? [])]);
  for (const e of entries) {
    if (e.text === null || e.name === BRIDGE_JS || !/\.(m?js|html?|css|json|svg)$/i.test(e.name)) continue;
    for (const m of e.text.matchAll(/\b(?:https?|wss?):\/\/[^\s"'`)<>\\]+/gi)) {
      const url = m[0].replace(/[.,;]+$/, '');
      if (e.name === 'index.html' && url === BRIDGE_CDN) continue;
      if (allowed.has(url)) continue;
      f11.push({ file: e.name, message: `${FONT_HOSTS.test(url) ? 'external font' : 'external URL'} ${url}` });
    }
    for (const m of e.text.matchAll(/\b(?:src|href)\s*=\s*["']\/\/[^"']+/gi)) f11.push({ file: e.name, message: `protocol-relative URL ${m[0]}` });
    for (const m of e.text.matchAll(/url\(\s*["']?\/\/[^)"']+/gi)) f11.push({ file: e.name, message: `protocol-relative url() ${m[0]}` });
  }
  add('PG-11', 'external-hosts', f11);

  // PG-12
  add(
    'PG-12',
    'no-sitelock',
    grep(/\blocation\.(?:hostname|host|origin)\b|document\.referrer|ancestorOrigins|\btop\.location\b/).map((h) => ({ file: h.file, message: `host check primitive ${h.match} in a game chunk (no sitelock, §9.1)` })),
  );

  // PG-13
  add('PG-13', 'forbidden-apis', [
    ...grep(/(?<![\w$.])(?:alert|confirm|prompt)\(|\bwindow\.(?:alert|confirm|prompt)\(/).map((h) => ({ file: h.file, message: `${h.match} in a game chunk: errors show as styled in-game messages` })),
    ...grep(/\bwindow\.open\(|\bnavigator\.sendBeacon\(/).map((h) => ({ file: h.file, message: `${h.match} in a game chunk: no external pages or analytics` })),
  ]);

  // PG-14
  const f14: PgFinding[] = [];
  const ev14: string[] = [];
  const css = entries.filter((e) => e.text !== null && /\.css$/i.test(e.name)).map((e) => e.text!).join('\n') + (html ?? '');
  if (html !== null) {
    if (!/<html[^>]*\blang=["'][a-z]{2}/i.test(html)) f14.push({ file: 'index.html', message: '<html lang="…"> is missing' });
    if (!/<meta[^>]*name=["']viewport["']/i.test(html)) f14.push({ file: 'index.html', message: 'no viewport meta' });
  }
  if (!/(?:^|[}\s,>])(?:html|body)(?:\s*,\s*(?:html|body))?\s*\{[^}]*overflow\s*:\s*hidden/i.test(css)) f14.push({ message: 'no overflow:hidden on html/body (no page scrollbar)' });
  else ev14.push('overflow:hidden on html/body');
  if (/canvas[^{]*\{[^}]*touch-action\s*:\s*none/i.test(css)) ev14.push('touch-action:none on the canvas');
  else if (/(?:^|[}\s,>])(?:html|body)(?:\s*,\s*(?:html|body))?\s*\{[^}]*touch-action\s*:\s*none/i.test(css)) ev14.push('touch-action:none on html/body (the canvas inherits the restriction)');
  else f14.push({ message: 'no touch-action:none on the canvas (or html/body)' });
  add('PG-14', 'page-shell', f14, ev14);

  // PG-15
  const f15: PgFinding[] = [];
  const title = html === null ? null : /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim() ?? null;
  const words = title === null ? 0 : title.split(/\s+/).filter((w) => w !== '').length;
  if (title === null) f15.push({ file: 'index.html', message: 'no <title>' });
  else if (words < 2 || words > 4) f15.push({ file: 'index.html', message: `the title "${title}" has ${words} word(s); the Playgama title is 2-4 words and must match the game` });
  add('PG-15', 'title', f15, title !== null ? [`"${title}"`] : []);

  // PG-16
  const f16: PgFinding[] = [];
  const hooks = [...DEFAULT_TEST_HOOKS, ...(ctx.testHooks ?? [])];
  for (const e of entries) {
    if (/\.map$/i.test(e.name) || /(^|\/)\.vite\//.test(e.name)) f16.push({ file: e.name, message: 'build metadata in the archive' });
    for (const h of hooks) {
      if (e.name.includes(h)) f16.push({ file: e.name, message: `file name contains ${h}` });
      else if (e.name !== BRIDGE_JS && e.text?.includes(h)) f16.push({ file: e.name, message: `${h} in a production build` });
    }
  }
  add('PG-16', 'no-dev-files', f16);

  // PG-17
  const f17: PgFinding[] = [];
  for (const e of entries) {
    if (e.text === null || e.name === BRIDGE_JS) continue;
    for (const h of scanRootAbsolute(e.name, e.text)) f17.push({ file: `${h.file}:${h.line}`, message: `${h.message}: ${h.excerpt ?? ''}`.trim() });
  }
  add('PG-17', 'relative-paths', f17);

  // PG-18
  const f18: PgFinding[] = [];
  const ev18: string[] = [];
  if (ctx.budgets === undefined) f18.push({ message: 'no budget report (run through runPackage)' });
  else {
    for (const r of ctx.budgets.rows) {
      const line = r.id === 'per-file' ? `per-file: ${r.actual} over` : `${r.id} ${r.actual} / ${r.limit}`;
      if (r.status === 'pass') ev18.push(line);
      else f18.push({ message: `budget ${line}${r.detail ? `: ${r.detail.slice(0, 3).join('; ')}` : ''}` });
    }
  }
  add('PG-18', 'size-budgets', f18, ev18);

  // PG-19
  const f19: PgFinding[] = [];
  const ev19: string[] = [];
  const shipped = at(cfg, 'device', 'supportedOrientations');
  if (!Array.isArray(shipped) || shipped.length === 0 || !shipped.every((o) => o === 'landscape' || o === 'portrait')) {
    f19.push({ file: BRIDGE_CONFIG_JSON, message: 'device.supportedOrientations must list landscape and/or portrait' });
  } else {
    ev19.push(`supportedOrientations ${JSON.stringify(shipped)}`);
    if (ctx.orientations !== undefined && canon([...shipped].sort()) !== canon([...ctx.orientations].sort())) {
      f19.push({ file: BRIDGE_CONFIG_JSON, message: `declares ${JSON.stringify(shipped)}, the game config ${JSON.stringify(ctx.orientations)}` });
    }
    if (shipped.length === 1 && at(cfg, 'device', 'useBuiltInOrientationPopup') !== true) f19.push({ file: BRIDGE_CONFIG_JSON, message: 'a single orientation needs device.useBuiltInOrientationPopup (the rotate placeholder, §9.1)' });
  }
  need(/\bResizeObserver\b|addEventListener\(\s*["'`]resize["'`]|\bonresize\b/, 'no resize handling (ResizeObserver or a resize listener): the field must follow the frame without deformation', f19, ev19);
  add('PG-19', 'orientation-aspect', f19, ev19);

  for (const extra of ctx.extraChecks ?? []) {
    const r = extra(entries);
    for (const c of Array.isArray(r) ? r : [r]) {
      const waiver = ctx.waive?.[c.id];
      checks.push(waiver !== undefined ? { ...c, status: 'waived', waiver } : c);
    }
  }

  return { status: checks.every((c) => c.status !== 'fail') ? 'pass' : 'fail', zipBytes, entries: entries.length, uncompressedBytes: uncompressed, checks };
}

export function formatPgReport(r: PgReport, per = 6): string {
  const lines = [`playgama offline build check: ${r.entries} entries, ${r.uncompressedBytes} B uncompressed, zip ${r.zipBytes} B`];
  for (const c of r.checks) {
    lines.push(`${c.status.padEnd(6)} ${c.id} ${c.name}${c.waiver ? ` (waived: ${c.waiver})` : ''}`);
    for (const e of c.evidence.slice(0, 3)) lines.push(`         + ${e}`);
    for (const f of c.findings.slice(0, per)) lines.push(`         - ${f.file ? `${f.file}: ` : ''}${f.message}`);
    if (c.findings.length > per) lines.push(`         ... ${c.findings.length - per} more`);
  }
  lines.push(`offline build check ${r.status.toUpperCase()}: ${r.checks.filter((c) => c.status === 'pass').length}/${r.checks.length} checks pass`);
  return lines.join('\n');
}
