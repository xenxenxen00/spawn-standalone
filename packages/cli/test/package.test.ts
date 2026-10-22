// `spawn-standalone package --target playgama` on a tiny fixture game (test/fixture/pg-game): vite build → zip → budgets →
// offline PG checks → covers (headless Chromium on SwiftShader, sharp), plus a negative control (an external font URL fails
// PG-11) and the pure parts on synthetic inputs.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync } from 'fflate';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildBridgeConfig } from '../src/package/bridge-config.ts';
import { globToRegExp } from '../src/package/budgets.ts';
import { runPackage, type PackageOutcome } from '../src/package/command.ts';
import { resolvePackageConfig } from '../src/package/config.ts';
import { imageSize } from '../src/package/covers.ts';
import { checkPlaygamaArchive, type ArchiveEntry, type PgReport } from '../src/package/playgama-check.ts';
import { writeZip } from '../src/package/zip.ts';

const slash = (p: string): string => p.split(String.fromCharCode(92)).join('/');
const FIXTURE = slash(fileURLToPath(new URL('./fixture/pg-game', import.meta.url)));
const tmp = slash(mkdtempSync(join(tmpdir(), 'ss-package-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const status = (r: PgReport, id: string): string | undefined => r.checks.find((c) => c.id === id)?.status;
const failing = (r: PgReport): string[] => r.checks.filter((c) => c.status === 'fail').map((c) => c.id);

/** the mean colour of a screenshot region */
async function mean(file: string, region: { left: number; top: number; width: number; height: number }): Promise<[number, number, number]> {
  const { data, info } = await sharp(file).extract(region).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const s = [0, 0, 0];
  const n = info.width * info.height;
  for (let i = 0; i < n; i++) for (let c = 0; c < 3; c++) s[c]! += data[i * 3 + c]!;
  return s.map((v) => v / n) as [number, number, number];
}

describe('package --target playgama on the fixture game', () => {
  let r: PackageOutcome;
  beforeAll(async () => {
    r = await runPackage({ gameDir: FIXTURE, target: 'playgama', out: `${tmp}/ok`, logLevel: 'silent' });
  }, 120_000);

  it('passes every offline check, the runtime probe and the covers', () => {
    expect(failing(r.report)).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.report.checks.map((c) => c.id)).toEqual([...Array.from({ length: 19 }, (_, i) => `PG-${String(i + 1).padStart(2, '0')}`), 'PG-R1', 'PG-C1']);
    for (const c of r.report.checks) expect(c.status, c.id).toBe('pass');
  });

  it('zips the page with index.html at the root, the Bridge, its config and the licences', () => {
    const files = unzipSync(readFileSync(r.zipPath));
    const names = Object.keys(files).sort();
    expect(names).toContain('index.html');
    expect(names).toContain('playgama-bridge.js');
    expect(names).toContain('playgama-bridge-config.json');
    expect(names).toContain('THIRD_PARTY.txt');
    expect(names.every((n) => !n.startsWith('/') && !n.endsWith('.map'))).toBe(true);
    const html = new TextDecoder().decode(files['index.html']);
    expect(html).toMatch(/<script src="https:\/\/bridge\.playgama\.com\/v2\/stable\/playgama-bridge\.js"><\/script>/);
    expect(html).toMatch(/src="\.\/assets\/index-[\w-]+\.js"/);
    const cfg = JSON.parse(new TextDecoder().decode(files['playgama-bridge-config.json'])) as Record<string, any>;
    expect(cfg['advertisement'].interstitial).toEqual({ placementFallback: 'run_end', placements: [{ id: 'run_end' }] });
    expect(cfg['advertisement'].rewarded.placements).toEqual([{ id: 'extra_life' }]);
    expect(cfg['advertisement'].minimumDelayBetweenInterstitial).toBe(150);
    expect(cfg['advertisement'].banner).toEqual({ disable: true });
    expect(cfg['device']).toEqual({ useBuiltInOrientationPopup: true, supportedOrientations: ['landscape'] });
    const third = new TextDecoder().decode(files['THIRD_PARTY.txt']);
    expect(third).toMatch(/@playgama\/bridge 2\.3\.1 \(LGPL-3\.0/);
    expect(third).toMatch(/three \d+\.\d+\.\d+ \(MIT\)/);
    expect(third).toContain('Copyright (c) Tailwind Labs, Inc.');
    expect(third).toContain('Copyright (c) 2026 xenxenxen00 and contributors');
    expect(third).toMatch(/Hop sound by Fixture Author \(CC0-1\.0\)/);
  });

  it('is deterministic: the same dist zips to the same bytes', async () => {
    const again = await runPackage({ gameDir: FIXTURE, target: 'playgama', out: `${tmp}/ok`, covers: false, skipBuild: true });
    expect(again.zipSha256).toBe(r.zipSha256);
  });

  it('writes the budgets and a release manifest', () => {
    const m = JSON.parse(readFileSync(r.manifestPath, 'utf8')) as Record<string, any>;
    expect(m['game']).toEqual({ name: 'Tiny Sky Hop', slug: 'tiny-sky-hop', version: '1.2.3', sourceCommit: '0'.repeat(40) });
    expect(m['zip'].file).toBe('tiny-sky-hop-1.2.3-playgama.zip');
    expect(m['zip'].sha256).toBe(r.zipSha256);
    expect(m['build'].bridgeVersion).toBe('2.3.1');
    expect(m['ads'].interstitial).toEqual([{ id: 'run_end', at: 'the results screen after a run' }]);
    expect(m['checks'].status).toBe('pass');
    expect(m['files'].map((f: { path: string }) => f.path)).toContain('index.html');
    const ids = r.budgets.rows.map((x) => `${x.id}:${x.limit}`);
    expect(ids).toEqual(['total:300000000', 'initial:2000000', 'zip:300000000', 'files:50', 'per-file:0']);
    expect(r.budgets.initial).toContain('index.html');
    expect(r.budgets.initial.some((p) => /^assets\/index-.*\.js$/.test(p))).toBe(true);
  });

  it('captures the title and mid-play shots and makes the three cover sizes', async () => {
    expect(r.covers).not.toBeNull();
    const c = r.covers!;
    expect(c.covers.map((x) => `${x.file} ${x.width}x${x.height}`)).toEqual([
      'landscape-1920x1080.png 1920x1080',
      'portrait-1080x1920.png 1080x1920',
      'square-800x800.png 800x800',
    ]);
    for (const x of c.covers) expect(imageSize(readFileSync(`${r.out}/covers/${x.file}`))).toEqual({ format: 'png', width: x.width, height: x.height });
    expect(c.probe.bridgeInitialized).toBe(true);
    // the title shot is the blue title frame; the play shot (URL query) is green, with the red results band the hook's tap drew
    const [title, play] = c.screenshots;
    const tb = await mean(title!, { left: 0, top: 200, width: 200, height: 100 });
    expect(tb[2]).toBeGreaterThan(tb[1]);
    const pg = await mean(play!, { left: 0, top: 200, width: 200, height: 100 });
    expect(pg[1]).toBeGreaterThan(pg[2]);
    const band = await mean(play!, { left: 0, top: 0, width: 200, height: 50 });
    expect(band[0]).toBeGreaterThan(150);
    expect(band[1]).toBeLessThan(100);
  });
});

describe('negative control', () => {
  it('an external font URL fails PG-11 and nothing else', async () => {
    const dir = `${tmp}/font-game`;
    cpSync(FIXTURE, dir, { recursive: true });
    const html = readFileSync(`${dir}/index.html`, 'utf8');
    writeFileSync(`${dir}/index.html`, html.replace('</title>', '</title>\n    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Roboto&display=swap" />'));
    const r = await runPackage({ gameDir: dir, target: 'playgama', out: `${tmp}/font-out`, covers: false, logLevel: 'silent' });
    expect(r.ok).toBe(false);
    expect(failing(r.report)).toEqual(['PG-11']);
    const f = r.report.checks.find((c) => c.id === 'PG-11')!.findings;
    expect(f.some((x) => x.file === 'index.html' && x.message.startsWith('external font https://fonts.googleapis.com/'))).toBe(true);
  }, 120_000);
});

describe('the PG checks on synthetic archives', () => {
  const html = (head: string, body = ''): string =>
    `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width"><title>Two Words</title><style>html,body{overflow:hidden}canvas{touch-action:none}</style>${head}</head><body>${body}</body></html>`;
  const cfg = resolvePackageConfig({ name: 'T', slug: 't', source: { dir: '.' }, platform: { playgama: { ads: { interstitial: [{ id: 'brk' }] } } } } as never);
  const bridgeCfg = JSON.stringify(buildBridgeConfig(cfg));
  const game =
    'b.initialize();b.platform.sendMessage("game_ready");b.platform.on(E.PAUSE_STATE_CHANGED,f);b.platform.on(E.AUDIO_STATE_CHANGED,g);' +
    'b.advertisement.showInterstitial("brk");b.storage.get(["k"]);b.storage.set(["k"],["v"]);new ResizeObserver(f);';
  const good = (): ArchiveEntry[] => [
    { name: 'index.html', size: 10, text: html('<script src="https://bridge.playgama.com/v2/stable/playgama-bridge.js"></script><script>window.bridge||document.write(\'<script src="./playgama-bridge.js"><\\/script>\')</script><script type="module" src="./a.js"></script>') },
    { name: 'playgama-bridge.js', size: 10, text: 'class X{get version(){return"2.3.1"}}' },
    { name: 'playgama-bridge-config.json', size: 10, text: bridgeCfg },
    { name: 'a.js', size: 10, text: game },
  ];
  const run = (entries: ArchiveEntry[]): PgReport => checkPlaygamaArchive(entries, 100, { expectedBridgeConfig: buildBridgeConfig(cfg), orientations: cfg.orientations, budgets: { status: 'pass', rows: [], initial: [] } });

  it('passes a well-formed archive', () => {
    expect(failing(run(good()))).toEqual([]);
  });

  it('fails each requirement it can see', () => {
    const with_ = (js: string): ArchiveEntry[] => good().map((e) => (e.name === 'a.js' ? { ...e, text: game + js } : e));
    expect(failing(run(with_('localStorage.setItem("x","y")')))).toEqual(['PG-10']);
    expect(failing(run(with_('alert("x")')))).toEqual(['PG-13']);
    expect(failing(run(with_('if(location.hostname!=="x")throw 1')))).toEqual(['PG-12']);
    expect(failing(run(with_('import("/abs/x.js")')))).toEqual(['PG-17']);
    expect(failing(run(with_('fetch("https://example.com/score")')))).toEqual(['PG-11']);
    expect(failing(run(with_('window.__ppTest=1')))).toEqual(['PG-16']);
    expect(failing(run(good().filter((e) => e.name !== 'playgama-bridge.js')))).toEqual(['PG-04', 'PG-05']);
    expect(failing(run(good().map((e) => (e.name === 'a.js' ? { ...e, text: 'b.initialize()' } : e))))).toEqual(['PG-07', 'PG-08', 'PG-09', 'PG-10', 'PG-19']);
    const noAds = JSON.stringify(buildBridgeConfig(resolvePackageConfig({ name: 'T', slug: 't', source: { dir: '.' } } as never)));
    expect(failing(run(good().map((e) => (e.name === 'playgama-bridge-config.json' ? { ...e, text: noAds } : e))))).toEqual(['PG-06']);
    expect(status(checkPlaygamaArchive(good(), 100, { waive: { 'PG-18': 'no budgets in this test' } }), 'PG-18')).toBe('waived');
  });

  it('runs per-game policy checks', () => {
    const r = checkPlaygamaArchive(good(), 100, { budgets: { status: 'pass', rows: [], initial: [] }, extraChecks: [() => ({ id: 'X-01', name: 'policy', status: 'fail', evidence: [], findings: [{ message: 'no' }] })] });
    expect(failing(r)).toEqual(['X-01']);
  });
});

describe('helpers', () => {
  it('globs', () => {
    expect(globToRegExp('**/*.js').test('assets/a/b.js')).toBe(true);
    expect(globToRegExp('**/*.js').test('b.js')).toBe(true);
    expect(globToRegExp('assets/*.glb').test('assets/x/y.glb')).toBe(false);
  });

  it('zips deterministically', () => {
    const e = [
      { path: 'b.txt', read: () => new TextEncoder().encode('b') },
      { path: 'a.png', read: () => new Uint8Array([1, 2, 3]) },
    ];
    const a = writeZip(e);
    expect(writeZip([...e].reverse()).sha256).toBe(a.sha256);
    expect(a.entries.map((x) => `${x.path}:${x.method}`)).toEqual(['a.png:store', 'b.txt:deflate']);
  });
});
