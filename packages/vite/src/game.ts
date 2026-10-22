// spawnStandalone({ gameDir }): serves one converted game (the `game/` tree the `import` command wrote, with its
// `game/.import/*` records) as `virtual:ss/*` modules, modelled on purge-protocol-web ebab692 tools/vite/{virtual-table,
// registry-virtual,plugin-registry}.ts:
//
//   virtual:ss/modules        export const modules = { '<tree path>': () => import('@game/<tree path>'), … }   (.import/modules.json registry)
//   virtual:ss/world-config   export const worldConfig = <world.config.yaml>
//   virtual:ss/world-files    export const worldFiles = [<every carried file, sorted>]
//   virtual:ss/places         export const placeIndex, places = { '<id>': () => import('virtual:ss/place/<id>') }
//   virtual:ss/place/<id>     export default { id, config, rows, rawCells?, sim? }
//   virtual:ss/preload-sets   export const sets = <.import/preload-sets.json sets>
//   virtual:ss/anim           export const anim = { 'anim/<a>.yml': () => … { authored, compiled: <cooked clips JSON | null> } }
//   virtual:ss/port-flags     export const flags = <flags.json, flat keys>
//   virtual:ss/asset-index    export default <asset index v1> (an empty index when the game has none)
//   virtual:ss/content        export const content = { '<tree path>': () => import('@game/<tree path>'), … }   (.import/modules.json content scripts)
//   virtual:ss/vendor         export const vendor = { meshoptDecoder, ktx2 } (files emitted under vendor/)
//
// The Vite adapter supplies explicit world and decoder inputs to a game-agnostic runtime.
// Aliases: `builtin/*` → the runtime's compat/builtin, `@game/*` and the tree roots (`scripts/*`, `templates/*`, `places/*`,
// `anim/*`, `ui/*`, `clips/*`) → the game tree. `.yml`/`.yaml` and `.scene` files of the game tree load as data modules.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { ssSqlJs } from './sqljs.ts';
import { compilePlaces, gameTreeReader, type PlaceCompile } from './analysis/places.ts';
import { sceneModuleSource } from './analysis/scene.ts';
import { jsLiteral, parseYaml, yamlModuleSource } from './analysis/yaml.ts';
import { clipToJson } from '@spawn-standalone/runtime/motion/clip';
import { cookAuthoredFile } from '@spawn-standalone/runtime/motion/cook-authored';

export const SS_PREFIX = 'virtual:ss/';
/** ids another plugin of this package serves (jobs.ts) */
const SERVED_ELSEWHERE = new Set(['virtual:ss/jobs', 'virtual:ss/job-worker']);
export const SS_IDS = ['modules', 'world-config', 'world-files', 'places', 'preload-sets', 'anim', 'port-flags', 'asset-index', 'vendor', 'content', 'world', 'shell'] as const;

const fwd = (p: string): string => p.replaceAll('\\', '/').replace(/\/$/, '');
const RUNTIME_SRC = fwd(dirname(fileURLToPath(import.meta.resolve('@spawn-standalone/runtime'))));
const THREE_LIBS = 'three/examples/jsm/libs';

export interface SpawnStandaloneOptions {
  /** the game workspace (holds `game/`, `standalone.config.*`, `flags.json`) */
  gameDir: string;
  /** the carried tree; default `<gameDir>/game` */
  gameRoot?: string;
  /** flat port flags file, relative to gameDir; default `flags.json` when present */
  flags?: string;
  /** the asset index (v1) file, relative to gameDir; default `asset-index.json` when present, else an empty index */
  assetIndex?: string;
  /** where the index's `assets/cdn/<name>` files are (relative to gameDir); default the index's `cdnDir` sidecar */
  cdnDir?: string;
  /** compile-time constants of the runtime snapshot; defaults: web platform (playgama under `--mode playgama`), no test hooks */
  defines?: { platform?: string; testHooks?: boolean; version?: string; originCommit?: string };
  /** Runtime module folder; defaults to the installed runtime entry's folder. */
  runtimeSrc?: string;
  /**
   * `gameCss: false`: the runtime UI host's PP stylesheets (GAME_CSS: runtime/ui/css/{fonts,root-vars,realm,narrow}.css) load
   * as empty modules, so the game's own CSS is the page style besides the host chrome. Default true (PP's look).
   */
  ui?: { gameCss?: boolean };
  /** `sqlJs: false` keeps sql.js's stdin `prompt(` fallback in the bundle; default rewrites it to a no-op (see sqljs.ts) */
  sqlJs?: boolean;
}

/** the runtime UI host's game stylesheets that `ui.gameCss: false` drops (runtime/ui/ui-host.ts imports them) */
export const GAME_CSS: readonly string[] = Object.freeze(['fonts', 'root-vars', 'realm', 'narrow']);
const EMPTY_CSS = '\0ss-empty-css:';

/** the page-relative folder of the flat asset index's files (`spawn-standalone assets build`) */
export const CDN_URL_PREFIX = 'assets/cdn/';

export const EMPTY_ASSET_INDEX = Object.freeze({ v: 1, entries: {}, groups: {}, facts: {} });

interface Records {
  files: string[];
  registry: string[];
  /** content scripts (lighting, looks, texture and material scripts): never registry modules */
  content: string[];
  sets: Record<string, string[]>;
}

function readJson(file: string): unknown {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}${existsSync(file) ? '' : ' (run `spawn-standalone import` first)'}`, { cause: e });
  }
}

function readRecords(gameRoot: string): Records {
  const live = readJson(join(gameRoot, '.import/live-files.json')) as { files?: { path: string }[] };
  const modules = readJson(join(gameRoot, '.import/modules.json')) as { registry?: string[]; content?: string[] };
  const preload = readJson(join(gameRoot, '.import/preload-sets.json')) as { sets?: Record<string, string[]> };
  if (!Array.isArray(live.files) || !Array.isArray(modules.registry) || typeof preload.sets !== 'object') throw new Error(`${gameRoot}/.import: malformed records`);
  const files = [...new Set(live.files.map((f) => f.path))].sort();
  const carried = new Set(files);
  return {
    files,
    registry: modules.registry.filter((p) => p.endsWith('.js') && carried.has(p)).sort(),
    content: (Array.isArray(modules.content) ? modules.content : []).filter((p) => p.endsWith('.js') && carried.has(p)).sort(),
    sets: preload.sets,
  };
}

/** a flat `<kind>.<name>` → boolean | string | number table, keys sorted */
export function portFlagTable(raw: unknown, file = 'flags.json'): Record<string, boolean | string | number> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new Error(`${file}: the flag table is an object`);
  const out: Record<string, boolean | string | number> = {};
  for (const key of Object.keys(raw).sort()) {
    const v = (raw as Record<string, unknown>)[key];
    if (typeof v !== 'boolean' && typeof v !== 'string' && !(typeof v === 'number' && Number.isFinite(v))) throw new Error(`${file}: "${key}" is not a boolean, string or finite number`);
    if (!/^[a-z][A-Za-z0-9]*\.[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(key)) throw new Error(`${file}: "${key}" is not a flat <kind>.<name> flag key`);
    out[key] = v;
  }
  return out;
}

const singleQuoted = (text: string): string => `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;

/** The `virtual:ss/*` producers over one game, as pure functions of the files on disk (cached per instance). */
export class GameModules {
  readonly gameDir: string;
  readonly gameRoot: string;
  private readonly opts: SpawnStandaloneOptions;
  private records: Records | null = null;
  private placesCache: PlaceCompile[] | null = null;

  constructor(opts: SpawnStandaloneOptions) {
    this.opts = opts;
    this.gameDir = fwd(resolve(opts.gameDir));
    this.gameRoot = fwd(opts.gameRoot ? (isAbsolute(opts.gameRoot) ? opts.gameRoot : resolve(this.gameDir, opts.gameRoot)) : join(this.gameDir, 'game'));
  }

  clear(): void {
    this.records = null;
    this.placesCache = null;
  }

  private rec(): Records {
    return (this.records ??= readRecords(this.gameRoot));
  }

  places(): PlaceCompile[] {
    if (this.placesCache) return this.placesCache;
    const tree = gameTreeReader(this.gameRoot);
    const { places, issues } = compilePlaces(tree, tree.places);
    const errors = issues.filter((i) => i.level === 'error');
    if (errors.length) throw new Error(`place compiler: ${errors.length} error(s):\n${errors.map((i) => `  ${i.place} ${i.file ?? ''} ${i.row ?? ''}: ${i.message}`).join('\n')}`);
    return (this.placesCache = places);
  }

  /**
   * The cooked clips of one anim file as a JS literal (CompiledClipJson[]; the runtime's cook rule, motion/cook-authored.ts),
   * or `null` when the file does not cook (the runtime's anim host then cooks on use and reports the error there).
   */
  cookedAnim(path: string): string {
    try {
      const parsed = parseYaml(readFileSync(join(this.gameRoot, path), 'utf8'), path);
      return JSON.stringify(cookAuthoredFile(path, parsed).map((c) => clipToJson(c)));
    } catch {
      return 'null';
    }
  }

  /**
   * The game's asset index (`assetIndex` option or asset-index.json; empty without one), without the `cdnDir` sidecar that
   * `spawn-standalone assets build` writes, and the folder the shipped `assets/cdn/<name>` files are read from (the option
   * `cdnDir`, else the sidecar, both relative to the game dir; null without either).
   */
  assetIndex(): { index: Record<string, unknown>; cdnDir: string | null } {
    const file = join(this.gameDir, this.opts.assetIndex ?? 'asset-index.json');
    const raw = existsSync(file) ? (readJson(file) as Record<string, unknown>) : { ...EMPTY_ASSET_INDEX };
    const { cdnDir: side, sourceCdnDir: _source, sourceHashes: _sourceHashes, fileHashes: _fileHashes, ...index } = raw;
    const dir = this.opts.cdnDir ?? (typeof side === 'string' ? side : null);
    return { index, cdnDir: dir === null ? null : fwd(isAbsolute(dir) ? dir : resolve(this.gameDir, dir)) };
  }

  /** the shipped files of the asset index: [page-relative URL, file on disk] for every entry under `assets/cdn/` */
  cdnFiles(): [string, string][] {
    const { index, cdnDir } = this.assetIndex();
    if (cdnDir === null) return [];
    const out: [string, string][] = [];
    for (const e of Object.values((index['entries'] ?? {}) as Record<string, { u?: unknown }>)) {
      if (typeof e.u !== 'string' || !e.u.startsWith(CDN_URL_PREFIX)) continue;
      const name = e.u.slice(CDN_URL_PREFIX.length);
      if (name.includes('..')) continue;
      out.push([e.u, `${cdnDir}/${name}`]);
    }
    return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }

  /** ES module source of `virtual:ss/<name>` (or `virtual:ss/place/<id>`); throws for an id no producer serves */
  load(name: string): string {
    const head = '// generated by @spawn-standalone/vite from the game tree and its .import records\n';
    const r = this.rec();
    switch (name) {
      case 'world':
        return `${head}import { createRegistry } from '@spawn-standalone/runtime/registry';
import { installPortFlags } from '@spawn-standalone/runtime/builtin/port';
import { modules } from 'virtual:ss/modules';
import { sets } from 'virtual:ss/preload-sets';
import { anim } from 'virtual:ss/anim';
import { flags } from 'virtual:ss/port-flags';
import { worldConfig } from 'virtual:ss/world-config';
import { worldFiles } from 'virtual:ss/world-files';
import { placeIndex, places } from 'virtual:ss/places';
export const preloadSets = ['boot'];
export function createWorld() {
  installPortFlags(flags);
  return { registry: createRegistry({ modules, sets, anim }), worldConfig, places: { placeIndex, places }, files: worldFiles };
}
`;
      case 'shell': {
        const root = fwd(this.opts.runtimeSrc ?? RUNTIME_SRC);
        const ext = existsSync(`${root}/shell/compose-game.js`) ? '.js' : '.ts';
        return `${head}export * from ${JSON.stringify(root + '/shell/index' + ext)};
import { composeGame as compose } from ${JSON.stringify(root + '/shell/compose-game' + ext)};
import { createWorld, preloadSets } from 'virtual:ss/world';
import { vendor } from 'virtual:ss/vendor';
import { content } from 'virtual:ss/content';
export function composeGame(options) {
  const loadGenerator = async (path) => {
    const source = options.content ?? content;
    if (typeof source === 'function') return source(path);
    const load = Object.hasOwn(source, path) ? source[path] : undefined;
    if (!load) throw new Error('no carried generator ' + path);
    return load();
  };
  const geometry = options.render?.geometryWorker || options.geometry?.createWorker || options.geometry?.loadGenerator ? options.geometry : { ...options.geometry, loadGenerator };
  return compose({ ...options, world: options.world ?? createWorld(), boot: { preloadSets, ...options.boot }, rendererOptions: { vendor, search: typeof location === 'undefined' ? '' : location.search, ...options.rendererOptions }, geometry });
}
`;
      }
      case 'modules': {
        const rows = r.registry.map((p) => `  ${JSON.stringify(p)}: () => import(${JSON.stringify(`@game/${p}`)}),`);
        return `${head}export const modules = {\n${rows.join('\n')}\n};\n`;
      }
      case 'content': {
        const rows = r.content.map((p) => `  ${JSON.stringify(p)}: () => import(${JSON.stringify(`@game/${p}`)}),`);
        return `${head}export const content = {\n${rows.join('\n')}\n};\n`;
      }
      case 'world-config': {
        const parsed = parseYaml(readFileSync(join(this.gameRoot, 'world.config.yaml'), 'utf8'), 'world.config.yaml');
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('world.config.yaml: the world config is a mapping');
        return `${head}export const worldConfig = ${jsLiteral(parsed)};\n`;
      }
      case 'world-files':
        return `${head}export const worldFiles = ${JSON.stringify(r.files)};\n`;
      case 'preload-sets':
        return `${head}export const sets = ${JSON.stringify(r.sets)};\n`;
      case 'places': {
        const compiled = this.places();
        const index: Record<string, unknown> = {};
        for (const pc of compiled) index[pc.id] = pc.config;
        const loaders = compiled.map((pc) => `  ${JSON.stringify(pc.id)}: () => import(${JSON.stringify(`${SS_PREFIX}place/${pc.id}`)}),`).join('\n');
        return `${head}export const placeIndex = ${jsLiteral(index)};\nexport const places = {\n${loaders}\n};\n`;
      }
      case 'anim': {
        const rows = r.files
          .filter((p) => /^anim\/[^/]+\.ya?ml$/.test(p))
          .map((p) => `  ${JSON.stringify(p)}: () => import(${JSON.stringify(`@game/${p}`)}).then((m) => ({ authored: m.default, compiled: ${this.cookedAnim(p)} })),`);
        return `${head}export const anim = {\n${rows.join('\n')}\n};\n`;
      }
      case 'port-flags': {
        const file = join(this.gameDir, this.opts.flags ?? 'flags.json');
        const table = existsSync(file) ? portFlagTable(readJson(file), file) : {};
        return `${head}export const flags = ${JSON.stringify(table)};\n`;
      }
      case 'asset-index': {
        const json = JSON.stringify(this.assetIndex().index);
        return `${head}export default JSON.parse(${singleQuoted(json)});\n`;
      }
      case 'vendor':
        return `${head}export const vendor = ${JSON.stringify(VENDOR_URLS)};\n`;
      default: {
        if (name.startsWith('place/')) {
          const id = name.slice('place/'.length);
          const pc = this.places().find((p) => p.id === id);
          if (!pc) throw new Error(`virtual:ss/${name}: ${id} is not a roster place`);
          const parts = [`id: ${jsLiteral(pc.id)}`, `config: ${jsLiteral(pc.config)}`, `rows: ${jsLiteral(pc.rows)}`];
          if (pc.rawCells !== null) parts.push(`rawCells: ${jsLiteral(pc.rawCells)}`);
          if (pc.config.sim !== null) parts.push(`sim: () => import(${JSON.stringify(`@game/${pc.config.sim}`)})`);
          return `${head}const bundle = {\n  ${parts.join(',\n  ')}\n};\nexport default bundle;\n`;
        }
        throw new Error(`virtual:ss/${name}: no producer serves this id`);
      }
    }
  }
}

/** page-relative URLs of the vendored decoders (emitted by the plugin in a build, served in dev) */
export const VENDOR_URLS = Object.freeze({
  meshoptDecoder: 'vendor/meshopt_decoder.module.js',
  ktx2: Object.freeze({ transcoderPath: 'vendor/basis/', jsTranscoder: 'vendor/basis/basis_transcoder.js', wasmTranscoder: 'vendor/basis/basis_transcoder.wasm' }),
});
const VENDOR_FILES: readonly [string, string][] = [
  ['vendor/meshopt_decoder.module.js', 'meshopt_decoder.module.js'],
  ['vendor/basis/basis_transcoder.js', 'basis/basis_transcoder.js'],
  ['vendor/basis/basis_transcoder.wasm', 'basis/basis_transcoder.wasm'],
];

/** The name behind `virtual:ss/<name>`; null for other ids and for ids the jobs plugin serves. */
export function ssName(id: string): string | null {
  const name = id.startsWith(SS_PREFIX) ? id.slice(SS_PREFIX.length) : null;
  if (name === null || SERVED_ELSEWHERE.has(SS_PREFIX + name)) return null;
  return (SS_IDS as readonly string[]).includes(name) || (name.startsWith('place/') && name.length > 6) ? name : null;
}

const TREE_ROOT = /^(scripts|templates|places|anim|ui|clips)\/(.*)$/;

export function spawnStandalone(opts: SpawnStandaloneOptions): Plugin[] {
  const game = new GameModules(opts);
  const runtimeSrc = fwd(opts.runtimeSrc ?? RUNTIME_SRC);
  const d = opts.defines ?? {};
  const inGame = (id: string): boolean => fwd(id.replace(/^\0/, '').split('?')[0]!).toLowerCase().startsWith(`${game.gameRoot.toLowerCase()}/`);
  let isBuild = false;
  const runtimePackage = dirname(fileURLToPath(import.meta.resolve('@spawn-standalone/runtime/package.json')));
  const runtimeRoots = [runtimeSrc, fwd(join(runtimePackage, 'src'))];

  const main: Plugin = {
    name: 'ss:game',
    enforce: 'pre',
    config(_config, env) {
      return {
        resolve: {
          alias: [
            { find: /^builtin\/(.*)$/, replacement: `${runtimeSrc}/compat/builtin/$1${existsSync(`${runtimeSrc}/compat/builtin/math.js`) ? '.js' : '.ts'}` },
            { find: /^@game\/(.*)$/, replacement: `${game.gameRoot}/$1` },
            { find: TREE_ROOT, replacement: `${game.gameRoot}/$1/$2` },
          ],
        },
        define: {
          __SS_PLATFORM__: JSON.stringify(d.platform ?? (env.mode === 'playgama' ? 'playgama' : 'web')),
          __SS_TEST_HOOKS__: d.testHooks === true ? 'true' : 'false',
          __SS_VERSION__: JSON.stringify(d.version ?? '0.0.0'),
          __SS_ORIGIN_COMMIT__: JSON.stringify(d.originCommit ?? 'standalone'),
        },
      };
    },
    configResolved(c) {
      isBuild = c.command === 'build';
    },
    buildStart() {
      game.clear();
      if (isBuild) {
        for (const [out, src] of VENDOR_FILES) this.emitFile({ type: 'asset', fileName: out, source: readFileSync(vendorFile(src)) });
        for (const [out, src] of game.cdnFiles()) if (existsSync(src)) this.emitFile({ type: 'asset', fileName: out, source: readFileSync(src) });
      }
    },
    resolveId(id, importer) {
      if (importer !== undefined && !importer.startsWith('\0' + SS_PREFIX) && !runtimeRoots.some((root) => fwd(importer).startsWith(root + '/'))) {
        const path = fwd(id.startsWith('.') ? resolve(dirname(importer.split('?')[0]!), id) : id);
        const shell = id === '@spawn-standalone/runtime/shell' || runtimeRoots.some((root) => ['index', 'compose-game'].some((name) => ['.ts', '.js'].some((ext) => path === `${root}/shell/${name}${ext}`)));
        if (shell) return '\0' + SS_PREFIX + 'shell';
      }
      if (opts.ui?.gameCss === false && id.endsWith('.css') && importer !== undefined) {
        const abs = fwd(id.startsWith('.') ? resolve(dirname(importer.split('?')[0]!), id) : id).toLowerCase();
        const hit = GAME_CSS.find((n) => abs === `${runtimeSrc}/runtime/ui/css/${n}.css`.toLowerCase());
        if (hit !== undefined) return `${EMPTY_CSS}${hit}`;
      }
      const name = ssName(id);
      return name === null ? null : `\0${SS_PREFIX}${name}`;
    },
    load(id) {
      if (id.startsWith(EMPTY_CSS)) return { code: '// ui.gameCss: false\nexport {};\n', moduleType: 'js' };
      if (!id.startsWith(`\0${SS_PREFIX}`)) return null;
      // a query (`?worker`, `?url`) belongs to Vite's own plugins: the module name is what is left of it
      const name = id.slice(1 + SS_PREFIX.length).split('?')[0]!;
      if (SERVED_ELSEWHERE.has(SS_PREFIX + name)) return null;
      this.addWatchFile(`${game.gameRoot}/.import/live-files.json`);
      return { code: game.load(name), moduleType: 'js' };
    },
    transform(code, id) {
      const path = fwd(id.replace(/^\0/, '').split('?')[0]!);
      if (!id.includes('?') && path.toLowerCase().startsWith(game.gameDir.toLowerCase() + '/src/') && !inGame(id) && /\.(?:[cm]?js|ts)$/.test(path)) {
        const host = code.replace(/\b__ppGeometryWorkerHosted\b/g, '__ssGeometryWorkerHosted').replace(/\.pp-touch-(button|stick)(?=[^A-Za-z0-9_-]|$)/g, '.ss-touch-$1');
        if (host !== code) return { code: host, map: { mappings: '' } };
      }
      if (!inGame(id)) return null;
      if (id.includes('?')) return null;
      if (/\.ya?ml$/.test(path)) return { code: yamlModuleSource(code, path), map: { mappings: '' }, moduleType: 'js' };
      if (path.endsWith('.scene')) return { code: sceneModuleSource(code, path), map: { mappings: '' }, moduleType: 'js' };
      return null;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0]!.replace(/^\//, '');
        const hit = VENDOR_FILES.find(([out]) => url.endsWith(out));
        if (!hit) {
          const at = url.indexOf(CDN_URL_PREFIX);
          const cdn = at < 0 ? undefined : game.cdnFiles().find(([u]) => u === decodeURIComponent(url.slice(at)));
          if (cdn === undefined || !existsSync(cdn[1])) return next();
          res.setHeader('Content-Type', mimeOf(cdn[1]));
          res.end(readFileSync(cdn[1]));
          return;
        }
        res.setHeader('Content-Type', hit[0].endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        res.end(readFileSync(vendorFile(hit[1])));
      });
      const onChange = (file: string): void => {
        if (!inGame(file)) return;
        game.clear();
        for (const env of Object.values(server.environments)) {
          for (const [id, mod] of env.moduleGraph.idToModuleMap) if (id.startsWith(`\0${SS_PREFIX}`)) env.moduleGraph.invalidateModule(mod);
          env.hot.send({ type: 'full-reload', path: '*' });
        }
      };
      server.watcher.on('change', onChange);
      server.watcher.on('add', onChange);
      server.watcher.on('unlink', onChange);
    },
  };
  return opts.sqlJs === false ? [main] : [main, ssSqlJs()];
}

const MIME: Readonly<Record<string, string>> = Object.freeze({
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  ktx2: 'image/ktx2',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
});
const mimeOf = (file: string): string => MIME[(/\.([A-Za-z0-9]+)$/.exec(file)?.[1] ?? '').toLowerCase()] ?? 'application/octet-stream';

function vendorFile(rel: string): string {
  const candidates = [fileURLToPath(import.meta.resolve(`${THREE_LIBS}/${rel}`))];
  const hit = candidates.find((f) => existsSync(f));
  if (!hit) throw new Error(`vendor: ${THREE_LIBS}/${rel} not found (is three installed?)`);
  return hit;
}
