// `spawn-standalone assets build`: the flat asset index from an export's asset-manifest.json + assets/cdn, and the Vite plugin
// serving it (virtual:ss/asset-index without the cdnDir sidecar, the files from the export's assets/cdn).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { GameModules } from '../../vite/src/index.ts';
import { buildAssetIndex, cdnName, runAssetsBuild } from '../src/assets/build.ts';

const slash = (p: string): string => p.split(String.fromCharCode(92)).join('/');
const tmp = slash(mkdtempSync(join(tmpdir(), 'ss-assets-')));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const row = (name: string, extra: Record<string, unknown> = {}) => ({ reference: `/cdn/${name}`, localPath: `assets/cdn/${name}`, status: 'downloaded', ...extra });

function exportDir(): string {
  const dir = `${tmp}/export`;
  mkdirSync(`${dir}/assets/cdn`, { recursive: true });
  mkdirSync(`${dir}/source`, { recursive: true });
  writeFileSync(`${dir}/assets/cdn/music-theme-loop.mp3`, Buffer.alloc(100));
  writeFileSync(`${dir}/assets/cdn/sfx-pop.mp3`, Buffer.alloc(10));
  writeFileSync(`${dir}/assets/cdn/hero.glb`, Buffer.alloc(30));
  writeFileSync(`${dir}/assets/cdn/logo.png`, Buffer.alloc(5));
  const manifest = [row('music-theme-loop.mp3'), row('sfx-pop.mp3'), row('hero.glb'), row('logo.png'), row('gone.png', { status: 'missing' }), row('notes.txt'), row('sfx-pop.mp3')];
  writeFileSync(`${dir}/asset-manifest.json`, JSON.stringify(manifest));
  return dir;
}

describe('buildAssetIndex', () => {
  it('maps every CDN reference flat to assets/cdn/<name>, boot vs lazy from the pattern list, silent when the file is absent', () => {
    const dir = exportDir();
    const r = buildAssetIndex(JSON.parse(readFileSync(`${dir}/asset-manifest.json`, 'utf8')), { cdnDir: `${dir}/assets/cdn`, boot: ['sfx-*', 'hero.glb', 'nothing-*'], origin: 'abc' });
    expect(Object.keys(r.index.entries)).toEqual(['gone.png', 'hero.glb', 'logo.png', 'music-theme-loop.mp3', 'sfx-pop.mp3']);
    expect(r.index.entries['sfx-pop.mp3']).toEqual({ u: 'assets/cdn/sfx-pop.mp3', b: 10, k: 'audio', x: 'mp3', g: ['boot/critical'] });
    expect(r.index.entries['hero.glb']).toMatchObject({ k: 'model', g: ['boot/critical'] });
    expect(r.index.entries['music-theme-loop.mp3']).toMatchObject({ b: 100, g: ['lazy'] });
    expect(r.index.entries['gone.png']).toEqual({ u: null, b: 0, k: 'image', x: 'png', g: ['lazy'], s: 1 });
    expect(r.index.groups).toEqual({ 'boot/critical': { n: ['hero.glb', 'sfx-pop.mp3'], b: 40 }, lazy: { n: ['logo.png', 'music-theme-loop.mp3'], b: 105 } });
    expect(r).toMatchObject({ missing: ['gone.png'], skipped: ['notes.txt'], unmatchedBoot: ['nothing-*'] });
    expect(r.index).toMatchObject({ v: 1, origin: 'abc', facts: {} });
    expect(cdnName('cdn/a.png')).toBe('a.png');
  });
});

describe('runAssetsBuild + the plugin', () => {
  it('writes <game>/asset-index.json from the config; the plugin serves it without the sidecar and maps the files', async () => {
    const dir = exportDir();
    const game = `${tmp}/game`;
    mkdirSync(game, { recursive: true });
    writeFileSync(`${game}/standalone.config.json`, JSON.stringify({ name: 'Fixture', slug: 'fixture', source: { dir: '../export/source', commit: 'c0ffee' }, assets: { boot: ['sfx-*'] } }));
    const o = await runAssetsBuild(game);
    expect(slash(o.file)).toBe(`${game}/asset-index.json`);
    const written = JSON.parse(readFileSync(`${game}/asset-index.json`, 'utf8'));
    expect(written.cdnDir).toBe('../export/assets/cdn');
    expect(written.origin).toBe('c0ffee');
    expect(written.groups['boot/critical'].n).toEqual(['sfx-pop.mp3']);

    const g = new GameModules({ gameDir: game, gameRoot: `${game}/game` });
    const { index, cdnDir } = g.assetIndex();
    expect(index['cdnDir']).toBeUndefined();
    expect(cdnDir).toBe(`${dir}/assets/cdn`);
    expect(g.cdnFiles()).toContainEqual(['assets/cdn/hero.glb', `${dir}/assets/cdn/hero.glb`]);
    expect(g.cdnFiles().map(([u]) => u)).not.toContain(null);
    expect(g.cdnFiles()).toHaveLength(4);
  });

  it('the CLI command runs from a terminal', () => {
    const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url));
    const out = execFileSync(process.execPath, [bin, 'assets', 'build', `${tmp}/game`, '--out', 'index-cli.json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    expect(out).toBe('');
    expect(JSON.parse(readFileSync(`${tmp}/game/index-cli.json`, 'utf8')).v).toBe(1);
  });
});
