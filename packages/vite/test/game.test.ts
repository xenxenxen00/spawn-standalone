import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'vite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runImport } from '../../cli/src/import/command.ts';
import { GameModules, portFlagTable, spawnStandalone, ssName } from '../src/index.ts';

// the converter's fixture game (packages/cli/test/fixture): imported into a temp game dir, then served and built
const WS = fileURLToPath(new URL('../../cli/test/fixture/ws/', import.meta.url)).replaceAll('\\', '/');
const tmp = mkdtempSync(join(tmpdir(), 'ss-vite-')).replaceAll('\\', '/');
const gameRoot = `${tmp}/game`;
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
beforeAll(async () => {
  await runImport(WS, { out: gameRoot });
});

describe('virtual:ss ids', () => {
  it('serves virtual:ss/<x>, rejects former snapshot ids and leaves jobs to ssJobs', () => {
    expect(ssName('virtual:ss/modules')).toBe('modules');
    expect(ssName('virtual:pp/world-config')).toBeNull();
    expect(ssName('virtual:pp/place/main')).toBeNull();
    expect(ssName('virtual:ss/jobs')).toBeNull();
    expect(ssName('virtual:ss/job-worker')).toBeNull();
    expect(ssName('virtual:ss/nope')).toBeNull();
  });

  it('creates explicit world bindings and wraps only external shell consumers', () => {
    const game = new GameModules({ gameDir: WS, gameRoot });
    expect(game.load('world')).toContain('createRegistry({ modules, sets, anim })');
    expect(game.load('world')).toContain('installPortFlags(flags)');
    expect(game.load('shell')).toContain('world: options.world ?? createWorld()');
    expect(game.load('shell')).toContain("rendererOptions: { vendor, search: typeof location === 'undefined' ? '' : location.search, ...options.rendererOptions }");
    expect(game.load('shell')).toContain('options.render?.geometryWorker || options.geometry?.createWorker || options.geometry?.loadGenerator');
    expect(game.load('shell')).toContain('options.content ?? content');
    const plugin = spawnStandalone({ gameDir: WS, gameRoot })[0]!;
    const resolveId = plugin.resolveId;
    if (typeof resolveId !== 'function') throw new Error('expected callable resolveId');
    const call = resolveId as (this: unknown, id: string, importer: string) => unknown;
    expect(call.call({}, '@spawn-standalone/runtime/shell', tmp + '/host.js')).toBe('\0virtual:ss/shell');
    expect(call.call({}, '@spawn-standalone/runtime/shell', '\0virtual:ss/shell')).toBeNull();
    expect(call.call({}, './unrelated.js', tmp + '/host.js')).toBeNull();
  });

  it('updates only the three legacy runtime couplings inside host source files', () => {
    const plugin = spawnStandalone({ gameDir: WS, gameRoot })[0]!;
    const transform = plugin.transform;
    if (typeof transform !== 'function') throw new Error('expected callable transform');
    const call = transform as (this: unknown, code: string, id: string) => { code: string } | null;
    const code = 'globalThis.__ppGeometryWorkerHosted = true; const css = ".pp-touch-button:hover,.pp-touch-stick { color:red } .pp-touch-button-custom {}"; const authored = "pp-hud";';
    const changed = call.call({}, code, WS + 'src/options.ts')!;
    expect(changed.code).toContain('__ssGeometryWorkerHosted');
    expect(changed.code).toContain('.ss-touch-button:hover,.ss-touch-stick');
    expect(changed.code).toContain('.pp-touch-button-custom');
    expect(changed.code).toContain('pp-hud');
    for (const id of [gameRoot + '/scripts/options.js', WS + 'other/options.ts', WS + 'src/options.ts?raw', WS + 'src/options.css']) expect(call.call({}, code, id)).toBeNull();
  });

  it('port flags: flat keys and scalar values only', () => {
    expect(portFlagTable({ 'port.b': 1, 'fidelity.FX-01': true })).toEqual({ 'fidelity.FX-01': true, 'port.b': 1 });
    expect(() => portFlagTable({ nested: { x: 1 } })).toThrow(/not a boolean/);
    expect(() => portFlagTable({ flat: true })).toThrow(/<kind>\.<name>/);
  });

  it('generates the module sources from the import records', () => {
    const g = new GameModules({ gameDir: WS, gameRoot });
    expect(g.load('modules')).toContain('"scripts/ui.js": () => import("@game/scripts/ui.js")');
    expect(g.load('modules')).not.toContain('scripts/lighting.js'); // a content script is never a registry module
    expect(g.load('content')).toContain('"scripts/lighting.js": () => import("@game/scripts/lighting.js")');
    expect(g.load('world-files')).toContain('"scripts/added.js"');
    expect(g.load('port-flags')).toContain('"port.demo":true');
    expect(g.load('asset-index')).toContain('JSON.parse(');
    expect(() => g.load('place/nowhere')).toThrow(/not a roster place/);
  });
});

describe('vite build with spawnStandalone', () => {
  it('bundles the game and its virtual modules; the built registry loads the carried code', async () => {
    const out = `${tmp}/dist`;
    const entry = `${tmp}/entry.js`;
    writeFileSync(
      entry,
      [
        "import { modules } from 'virtual:ss/modules';",
        "import { worldConfig } from 'virtual:ss/world-config';",
        "import { worldFiles } from 'virtual:ss/world-files';",
        "import { placeIndex, places } from 'virtual:ss/places';",
        "import { sets } from 'virtual:ss/preload-sets';",
        "import { anim } from 'virtual:ss/anim';",
        "import { flags } from 'virtual:ss/port-flags';",
        "import index from 'virtual:ss/asset-index';",
        "import { vendor } from 'virtual:ss/vendor';",
        "import { createWorld } from 'virtual:ss/world';",
        "import { clamp } from 'builtin/math';",
        'export { modules, worldConfig, worldFiles, placeIndex, places, sets, anim, flags, index, vendor, clamp, createWorld };',
      ].join('\n'),
    );
    await build({
      root: tmp,
      configFile: false,
      logLevel: 'silent',
      plugins: [spawnStandalone({ gameDir: WS, gameRoot })],
      build: {
        outDir: out,
        emptyOutDir: true,
        minify: false,
        lib: { entry, formats: ['es'], fileName: () => 'main.mjs' },
        rolldownOptions: { output: { chunkFileNames: '[name]-[hash].mjs' } },
      },
    });
    const files = readdirSync(out, { recursive: true }).map(String).map((f) => f.replaceAll('\\', '/'));
    expect(files).toEqual(expect.arrayContaining(['main.mjs', 'vendor/meshopt_decoder.module.js', 'vendor/basis/basis_transcoder.wasm']));

    const m = (await import(pathToFileURL(`${out}/main.mjs`).href)) as Record<string, any>;
    expect(m.createWorld().registry).not.toBe(m.createWorld().registry);
    expect(m.createWorld().worldConfig.name).toBe('Fixture SA');
    expect(m.worldConfig.name).toBe('Fixture SA');
    expect(m.worldConfig.nametag).toBeUndefined();
    expect(m.worldFiles).toContain('scripts/lib/data.yml');
    expect(m.placeIndex.main).toMatchObject({ id: 'main', gravity: { x: 0, y: -20, z: 0 }, cells: ['x0z0'], rows: 1, modules: 'place:main' });
    const bundle = (await m.places.main()).default;
    expect(bundle.rows).toEqual([{ id: 'spinner', cell: 'x0z0', spec: { feetPosition: { x: 1, y: 0, z: 1 }, behavior: 'scripts/spin.js' } }]);
    expect(m.sets.boot).toContain('sim.js');
    expect(m.flags['port.demo']).toBe(true);
    expect(m.index).toEqual({ v: 1, entries: {}, groups: {}, facts: {} });
    expect(m.vendor.ktx2.transcoderPath).toBe('vendor/basis/');
    expect(m.clamp(5, 0, 1)).toBe(1);
    // carried code through the registry: a YAML import, a relative import added by an edit, a builtin import
    const ui = await m.modules['scripts/ui.js']();
    expect(ui.default({})).toBe('<div class="hud">Hello!</div>');
    const spawner = await m.modules['scripts/spawner.js']();
    expect(spawner.pick({})).toBe('templates/enemies/a.js#enemy');
    expect(Object.keys(m.modules)).toContain('templates/enemies/b.js');
  }, 60_000);
});
