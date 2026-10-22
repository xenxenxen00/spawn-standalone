// `spawn-standalone import [--check]` and `spawn-standalone init`: the file-system side of the import pipeline.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { load } from 'js-yaml';
import { compareTree, syncTree } from './copy.ts';
import { loadGameConfig, type GameConfig } from './config.ts';
import { loadEdits } from './edits.ts';
import { openOrigin } from './origin.ts';
import { buildImport, readFlags, type BuildResult, type OriginJson } from './pipeline.ts';
import { scaffoldFiles } from './scaffold.ts';
import { LOCK_FILE, lockText } from './lock.ts';

export interface ImportOptions {
  /** compare instead of write: fails when `game/` is not byte-identical to a fresh import */
  check?: boolean;
  /** output folder; default `<gameDir>/game` */
  out?: string;
  now?: () => Date;
}

export interface ImportOutcome {
  ok: boolean;
  result: BuildResult;
  config: GameConfig;
  out: string;
  /** --check: `missing|changed|extra <path>` lines; write: the written and removed paths */
  diffs: string[];
  written: string[];
  removed: string[];
}

function readPrevious(out: string): OriginJson | null {
  try {
    return JSON.parse(readFileSync(join(out, '.import/origin.json'), 'utf8')) as OriginJson;
  } catch {
    return null;
  }
}

export async function runImport(gameDir: string, opts: ImportOptions = {}): Promise<ImportOutcome> {
  const dir = resolve(gameDir);
  const { config } = await loadGameConfig(dir);
  const out = opts.out ?? join(dir, 'game');
  const origin = openOrigin(config.source.dir, config.source.commit);
  const flagsFile = config.flags ?? 'flags.json';
  const flagsPath = join(dir, flagsFile);
  if (!existsSync(flagsPath) && config.flags !== undefined) throw new Error(`flags: ${flagsFile} does not exist in ${dir}`);
  const flags = readFlags(existsSync(flagsPath) ? readFileSync(flagsPath, 'utf8') : null);
  const edits = await loadEdits(dir, config.edits ?? {});
  const result = buildImport({
    origin,
    config,
    edits,
    editContext: { flags, readGameFile: (name) => readFileSync(join(dir, name), 'utf8') },
    previousOrigin: readPrevious(out),
    ...(opts.now ? { now: opts.now } : {}),
  });
  const lockFile = join(dir, LOCK_FILE);
  const locked = opts.out === undefined && (config.lock === true || existsSync(lockFile));
  const live = JSON.parse(result.tree.get('.import/live-files.json')!.toString()) as { commit: string; files: { path: string; sha256: string }[] };
  const lock = locked ? lockText({ ...config, source: { ...config.source, commit: live.commit } }, dir, live.files) : null;
  if (opts.check) {
    const diffs = compareTree(out, result.tree);
    if (lock !== null && !existsSync(lockFile)) diffs.push(`missing ${LOCK_FILE}`);
    else if (lock !== null && readFileSync(lockFile, 'utf8') !== lock) diffs.push(`changed ${LOCK_FILE}`);
    return { ok: diffs.length === 0, result, config, out, diffs, written: [], removed: [] };
  }
  mkdirSync(out, { recursive: true });
  const { written, removed } = syncTree(out, result.tree);
  if (lock !== null && (!existsSync(lockFile) || readFileSync(lockFile, 'utf8') !== lock)) {
    writeFileSync(lockFile, lock);
    written.push(`../${LOCK_FILE}`);
  }
  return { ok: true, result, config, out, diffs: [], written, removed };
}

export function summary(o: ImportOutcome): string {
  const r = o.result.report;
  const head = `import ${o.config.slug}: ${r.reachable} reachable, ${r.final} carried (${r.delta.length} excluded, ${r.added.length} added), ${r.edits.length} edits, places ${r.places.join(', ') || '(none)'}`;
  if (o.diffs.length) return `${head}\n--check: game/ differs from a fresh import:\n  ${o.diffs.slice(0, 50).join('\n  ')}`;
  return `${head}\n${o.written.length} written, ${o.removed.length} removed → ${o.out}`;
}

export interface InitOptions {
  name: string;
  /** default `games/<name>` under the current directory */
  out?: string;
}

/** `init <export-dir> --name <slug>`: a runnable workspace, tracked-edit ledger and lock over a local export. */
export function runInit(exportDir: string, opts: InitOptions): { dir: string; files: string[] } {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(opts.name)) throw new Error(`init: --name must be lowercase kebab-case, got ${opts.name}`);
  const exp = resolve(exportDir).replaceAll('\\', '/');
  const infoFile = join(exp, 'export-info.json');
  if (!existsSync(infoFile)) throw new Error(`init: ${infoFile} is missing (not a game export)`);
  const info = JSON.parse(readFileSync(infoFile, 'utf8')) as { name?: string; commit?: string; engineVersion?: string; address?: string };
  const dir = resolve(opts.out ?? join('games', opts.name));
  const exportPath = resolve(exp).replaceAll('\\', '/').toLowerCase();
  const outputPath = dir.replaceAll('\\', '/').toLowerCase();
  if (outputPath === exportPath || outputPath.startsWith(exportPath + '/')) throw new Error('init: output must be outside the read-only export');
  const origin = openOrigin(`${exp}/source`, info.commit);
  const paths = origin.list();
  if (!paths.includes('world.config.yaml')) throw new Error('init: source/world.config.yaml is missing');
  const world = load(origin.read('world.config.yaml').toString('utf8')) as { ui?: { render?: unknown } };
  const uiEntry = typeof world?.ui?.render === 'string' ? world.ui.render.replace(/#.*$/, '') : null;
  if (uiEntry !== null && !paths.includes(uiEntry)) throw new Error(`init: UI entry ${uiEntry} is missing from source`);
  const sql = paths.includes('scripts/db.js');
  const jobs = paths.some((p) => /^jobs\/[^/]+\.js$/.test(p));
  const config: GameConfig = {
    name: info.name ?? opts.name,
    slug: opts.name,
    version: '0.1.0',
    lock: true,
    source: { dir: `${exp}/source`, commit: origin.info().commit },
    ...(info.engineVersion ? { engine: { semver: info.engineVersion, docs: `${exp}/reference/engine-${info.engineVersion}` } } : {}),
    places: { roster: 'world.config', exclude: [] },
    roots: { extra: sql ? ['scripts/db.js'] : [], runtimeEdges: sql ? [{ from: 'world.config.yaml', to: ['scripts/db.js'], why: 'Run the SQL migration before the first tick' }] : [], jobs },
    exclude: { builtIn: ['platform-roots'], paths: [], knownDangling: [] },
    edits: { dir: 'edits', order: 'edits/order.yml' },
    flags: 'flags.json',
    assets: { manifest: `${exp}/asset-manifest.json`, cdn: `${exp}/assets/cdn` },
    ui: { entry: 'auto', globals: 'auto', rootId: 'ss-game', styleId: 'ss-style', spriteId: 'ss-sprites', gameCss: false, readyWhen: 'firstUiRender', utilities: true },
    save: { key: `${opts.name}_save_v1`, durableKeys: 'all' },
    platform: { target: 'web', playgama: { ads: { interstitial: [{ id: 'break', at: 'game-requested natural break' }] } } },
    covers: { readySelector: 'body[data-booted="1"]' },
  };
  const files = {
    'standalone.config.json': `${JSON.stringify(config, null, 2)}\n`,
    'edits/order.yml': '# tracked edits, applied in this order: one id per line (edits/<id>.json | .ts)\n[]\n',
    'flags.json': '{}\n',
    [LOCK_FILE]: lockText(config, dir),
    ...scaffoldFiles(dir, config, uiEntry, sql, jobs),
  };
  // Check the entire scaffold before writing: init never replaces a user's existing page or edits.
  for (const name of Object.keys(files)) if (existsSync(join(dir, name))) throw new Error(`init: ${join(dir, name)} exists already`);
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return { dir, files: Object.keys(files) };
}
