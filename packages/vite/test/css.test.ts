// ui.gameCss === false: the runtime UI host's PP stylesheets resolve to empty modules; the host chrome stays.
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { build } from 'vite';
import { afterAll, describe, expect, it } from 'vitest';
import { GAME_CSS, spawnStandalone } from '../src/index.ts';

const tmp = mkdtempSync(join(tmpdir(), 'ss-css-')).split(String.fromCharCode(92)).join('/');
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** a stand-in runtime src whose ui-host imports the five stylesheets as the real one does */
function fakeRuntime(): string {
  const src = `${tmp}/runtime-src`;
  mkdirSync(`${src}/runtime/ui/css`, { recursive: true });
  for (const n of [...GAME_CSS, 'chrome']) writeFileSync(`${src}/runtime/ui/css/${n}.css`, `.marker-${n} { color: red; }\n`);
  writeFileSync(`${src}/runtime/ui/ui-host.js`, [...GAME_CSS, 'chrome'].map((n) => `import './css/${n}.css';`).join('\n') + '\nexport const host = 1;\n');
  return src;
}

async function css(gameCss: boolean | undefined): Promise<string> {
  const runtimeSrc = fakeRuntime();
  const out = `${tmp}/dist-${String(gameCss)}`;
  await build({
    root: tmp,
    configFile: false,
    logLevel: 'silent',
    plugins: [spawnStandalone({ gameDir: tmp, runtimeSrc, ...(gameCss === undefined ? {} : { ui: { gameCss } }) })],
    build: { outDir: out, emptyOutDir: true, minify: false, lib: { entry: `${runtimeSrc}/runtime/ui/ui-host.js`, formats: ['es'], fileName: () => 'main.mjs', cssFileName: 'style' } },
  });
  return readdirSync(out)
    .filter((f) => f.endsWith('.css'))
    .map((f) => readFileSync(join(out, f), 'utf8'))
    .join('\n');
}

describe('ui.gameCss', () => {
  it('false: fonts, root-vars, realm and narrow are empty; chrome.css stays', async () => {
    const text = await css(false);
    for (const n of GAME_CSS) expect(text).not.toContain(`.marker-${n}`);
    expect(text).toContain('.marker-chrome');
  }, 60_000);

  it('default: every stylesheet is bundled (PP look)', async () => {
    const text = await css(undefined);
    for (const n of [...GAME_CSS, 'chrome']) expect(text).toContain(`.marker-${n}`);
  }, 60_000);
});
