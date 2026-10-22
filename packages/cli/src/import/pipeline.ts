// The import run, in memory: origin → reachable set → exclusions → blobs → tracked edits → post-edit checks → the
// `game/` tree with `game/.import/*` records. Writing and `--check` are copy.ts. Generalised from purge-protocol-web
// ebab692 tools/import-live/pipeline.ts: roots, roster, exclusions and edits come from the game's config; PP's count
// cross-check, staging bunker and content scans are gone; an edit may add files.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computePreloadSets, moduleRoles, reach, type ReachOptions, type ReachResult, type TreeReader } from '@spawn-standalone/vite/analysis';
import { load } from 'js-yaml';
import type { GameConfig, PathExclusion } from './config.ts';
import { unifiedDiff } from './diff.ts';
import { StagedTree, type Edit, type EditContext, type OpRecord } from './edit-kit.ts';
import type { OriginSource } from './origin.ts';

export const TOOL = 'spawn-standalone import';
export const TOOL_VERSION: string = JSON.parse(readFileSync(new URL(import.meta.resolve('@spawn-standalone/cli/package.json')), 'utf8')).version;

export const sha256 = (b: Buffer | string): string => createHash('sha256').update(b).digest('hex');
const json = (v: unknown): Buffer => Buffer.from(`${JSON.stringify(v, null, 2)}\n`, 'utf8');
const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

export interface OriginJson {
  game: string;
  commit: string;
  date: string;
  subject: string;
  tool: string;
  toolVersion: string;
  /** hash over the other records: importedAt is kept while it is unchanged (idempotent re-runs, `--check`) */
  contentHash: string;
  importedAt: string;
}

export interface LiveFile {
  path: string;
  sha256Origin: string | null;
  sha256: string;
  bytes: number;
  /** the extension ('js', 'yml', 'scene', 'json', …) */
  kind: string;
  roots: string[];
  place?: string;
  /** added by an edit */
  added?: true;
}

export interface DeltaEntry {
  path: string;
  rule: string;
  reason: string;
}

export interface EditRecord {
  id: string;
  title: string;
  rationale: string;
  cites: string[];
  files: string[];
  ops: OpRecord[];
  hashes: { path: string; before: string | null; after: string | null }[];
}

export interface BuildOptions {
  origin: OriginSource;
  config: GameConfig;
  edits: readonly Edit[];
  editContext: EditContext;
  /** the origin.json now in game/ (keeps importedAt when nothing changed) */
  previousOrigin?: OriginJson | null;
  now?: () => Date;
}

export interface BuildResult {
  /** paths relative to `game/`, including `.import/*` */
  tree: Map<string, Buffer>;
  report: { reachable: number; final: number; places: string[]; delta: DeltaEntry[]; edits: EditRecord[]; added: string[] };
}

/** Spawn platform-only roots: the nametag renderer and the room router (the runtime gives them ports or drops them) */
export const PLATFORM_ROOTS = /^(?:ui\/nametag\.js|(?:scripts\/)?routing\.js)$/;

function originReader(origin: OriginSource): TreeReader {
  const list = origin.list();
  const set = new Set(list);
  return { has: (p) => set.has(p), text: (p) => origin.read(p).toString('utf8'), list: () => list };
}

function stagedReader(files: Map<string, Buffer>): TreeReader {
  const list = [...files.keys()].sort();
  return { has: (p) => files.has(p), text: (p) => files.get(p)!.toString('utf8'), list: () => list };
}

/**
 * The job modules as reach roots (`job:<id>`), when the config says `roots: { jobs: true }` (opt-in: a game that adds its job modules by
 * an edit keeps working): the `jobs:` config key (id to a path) plus every `jobs/<id>.js` the tree has. A job
 * runs in its own worker, so its file and what it imports are carried although no registry module names them. A named file the
 * tree lacks is no root (an edit may add it: the check after the edits reports it if it is still missing).
 */
export function jobRootFiles(config: GameConfig, tree: TreeReader): { file: string; root: string }[] {
  if (config.roots?.jobs !== true) return [];
  const out = new Map<string, string>();
  for (const [id, file] of Object.entries(config.jobs ?? {})) out.set(file, `job:${id}`);
  for (const p of tree.list()) {
    const m = /^jobs\/([^/]+)\.js$/.exec(p);
    if (m && !out.has(p)) out.set(p, `job:${m[1]}`);
  }
  return [...out].sort(([a], [b]) => (a < b ? -1 : 1)).map(([file, root]) => ({ file, root }));
}

/** reach options from the config (roster, roots, runtime edges, portal rule) */
export function reachOptionsOf(config: GameConfig, tree: TreeReader): Omit<ReachOptions, 'excludeFiles' | 'excludePlaces'> {
  const roster = config.places?.roster;
  const extra = Array.isArray(roster) ? roster : [];
  const rootFiles = [
    { file: 'world.config.yaml', root: 'world' },
    { file: 'sim.js', root: 'sim.js' },
    ...(config.roots?.extra ?? []).map((f) => ({ file: f, root: `extra:${f}` })),
    ...jobRootFiles(config, tree),
  ];
  for (const r of config.roots?.extra ?? []) if (!tree.has(r)) throw new Error(`import: roots.extra names ${r}, which is not in the source`);
  return {
    rootFiles,
    runtimeEdges: config.roots?.runtimeEdges ?? [],
    roster: { file: null, extra, portalBehavior: config.places?.portalBehavior ?? null },
  };
}

// One child process compiles every edited JS file as an ES module (vm.SourceTextModule), as PP's pipeline does.
const BATCH_CHECK = `
const { readFileSync } = require('node:fs');
const vm = require('node:vm');
if (typeof vm.SourceTextModule !== 'function') { process.stdout.write('unavailable\\n'); process.exit(0); }
const files = JSON.parse(readFileSync(0, 'utf8'));
let out = '';
files.forEach((f, i) => {
  try { new vm.SourceTextModule(readFileSync(f, 'utf8'), { identifier: f }); } catch { out += i + '\\n'; }
});
process.stdout.write(out + 'done\\n');
`;

function checkSyntax(files: Map<string, Buffer>, paths: string[]): void {
  if (paths.length === 0) return;
  const dir = mkdtempSync(join(tmpdir(), 'ss-import-check-'));
  try {
    const abs = paths.map((p) => {
      const f = join(dir, p.replace(/[/\\]/g, '__').replace(/\.js$/, '.mjs'));
      writeFileSync(f, files.get(p)!);
      return f;
    });
    const r = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', '-e', BATCH_CHECK], { input: JSON.stringify(abs), encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 24 });
    const lines = r.status === 0 && typeof r.stdout === 'string' ? r.stdout.trim().split(/\r?\n/) : [];
    const ok = lines[lines.length - 1] === 'done';
    const suspect = ok ? new Set(lines.slice(0, -1).map(Number)) : null;
    paths.forEach((p, i) => {
      if (suspect && !suspect.has(i)) return;
      const c = spawnSync(process.execPath, ['--check', abs[i]!], { encoding: 'utf8', windowsHide: true });
      if (c.status !== 0) throw new Error(`import: ${p} does not parse after the edits:\n${(c.stderr || c.stdout).trim()}`);
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const minus = (a: ReachResult, b: ReachResult): string[] => sorted([...a.files.keys()].filter((p) => !b.files.has(p)));

export function buildImport(o: BuildOptions): BuildResult {
  const cfg = o.config;
  const info = o.origin.info();
  if (cfg.source.commit !== undefined && info.commit !== cfg.source.commit && info.commit !== 'folder') {
    throw new Error(`import: source HEAD ${info.commit} ≠ pinned ${cfg.source.commit} (standalone config source.commit)`);
  }
  const tree = originReader(o.origin);
  const ro = reachOptionsOf(cfg, tree);
  const excludePlaces = cfg.places?.exclude ?? [];

  // 1. the reachable set
  const full = reach(tree, { ...ro, excludePlaces });
  if (full.dangling.length) {
    throw new Error(`import: the source graph dangles:\n${full.dangling.map((d) => `  ${d.from} → ${d.target} (${d.kind})`).join('\n')}`);
  }

  // 2. exclusions: built-in rules, then the config's paths; files reached only through an excluded file go with it
  const builtIn = cfg.exclude?.builtIn ?? ['platform-roots'];
  const rules: { id: string; reason: string; files: string[] }[] = [];
  if (builtIn.includes('platform-roots')) {
    const files = [...full.files.keys()].filter((p) => PLATFORM_ROOTS.test(p));
    if (files.length) rules.push({ id: 'platform-roots', reason: 'Spawn platform-only root (nametag renderer, room routing)', files });
  }
  for (const x of cfg.exclude?.paths ?? []) {
    const e: PathExclusion = typeof x === 'string' ? { path: x, reason: 'standalone config exclude.paths' } : x;
    if (!full.files.has(e.path)) throw new Error(`import: exclude.paths names ${e.path}, which is not reachable`);
    rules.push({ id: `exclude:${e.path}`, reason: e.reason, files: [e.path] });
  }
  const excludeFiles = new Set(rules.flatMap((r) => r.files));
  const current = reach(tree, { ...ro, excludePlaces, excludeFiles });
  const delta: DeltaEntry[] = minus(full, current).map((p) => {
    const rule = rules.find((r) => r.files.includes(p));
    return { path: p, rule: rule ? rule.id : 'orphaned-by-exclusion', reason: rule ? rule.reason : 'reached only through an excluded file' };
  });
  const carried = sorted(current.files.keys());

  // 3. blobs, 4. edits in order
  const staged = new Map<string, Buffer>();
  for (const p of carried) staged.set(p, Buffer.from(o.origin.read(p)));
  const originHash = new Map(carried.map((p) => [p, sha256(staged.get(p)!)]));
  const st = new StagedTree(staged);
  const editRecords: EditRecord[] = [];
  const patches = new Map<string, string>();
  const touchedJs = new Set<string>();
  for (const edit of o.edits) {
    const snapshot = new Map(staged);
    const ops: OpRecord[] = [];
    edit.apply(st.kit(edit, ops), o.editContext);
    const touched = sorted([...edit.files, ...ops.map((x) => x.path)]);
    let patch = '';
    const hashes: EditRecord['hashes'] = [];
    for (const p of touched) {
      const b = snapshot.get(p);
      const a = staged.get(p);
      if (b === undefined && a === undefined) continue;
      if (!(b && a && b.equals(a))) {
        patch += unifiedDiff(p, b ? b.toString('utf8') : '', a ? a.toString('utf8') : '');
        if (a && p.endsWith('.js')) touchedJs.add(p);
      }
      hashes.push({ path: p, before: b ? sha256(b) : null, after: a ? sha256(a) : null });
    }
    patches.set(edit.id, patch);
    editRecords.push({ id: edit.id, title: edit.title, rationale: edit.rationale, cites: [...edit.cites], files: [...edit.files], ops, hashes });
  }
  const added = sorted([...staged.keys()].filter((p) => !originHash.has(p)));

  // 5. the edited tree: graph closed (excluded targets and known dangling only), nothing orphaned, edited JS parses
  const stagedTree0 = stagedReader(staged);
  if (cfg.roots?.jobs === true) for (const [id, file] of Object.entries(cfg.jobs ?? {})) if (!stagedTree0.has(file)) throw new Error(`import: jobs.${id} names ${file}, which is not in the tree (the source lacks it and no edit adds it)`);
  // the job roots again over the edited tree: an edit may have added a job module
  const postRo = { ...ro, rootFiles: [...(ro.rootFiles ?? []).filter((r) => !r.root.startsWith('job:')), ...jobRootFiles(cfg, stagedTree0)] };
  const post = reach(stagedTree0, { ...postRo, excludePlaces, excludeFiles });
  const known = cfg.exclude?.knownDangling ?? [];
  const bad = post.dangling.filter((d) => !known.some((k) => k.from === d.from && k.target === d.target));
  if (bad.length) throw new Error(`import: dangling after edits:\n${bad.map((d) => `  ${d.from} → ${d.target} (${d.kind})`).join('\n')}`);
  const addedSet = new Set(added);
  const orphans = sorted([...staged.keys()].filter((p) => !post.files.has(p) && !addedSet.has(p)));
  if (orphans.length) throw new Error(`import: carried files no longer reached after the edits:\n  ${orphans.join('\n  ')}`);
  if (cfg.syntaxCheck !== false) checkSyntax(staged, sorted(touchedJs));

  // 6. records
  const liveFiles: LiveFile[] = sorted(staged.keys()).map((p) => {
    const b = staged.get(p)!;
    const rf = post.files.get(p);
    const lf: LiveFile = { path: p, sha256Origin: originHash.get(p) ?? null, sha256: sha256(b), bytes: b.length, kind: p.slice(p.lastIndexOf('.') + 1), roots: rf?.roots ?? [] };
    if (rf?.place !== undefined) lf.place = rf.place;
    if (addedSet.has(p)) lf.added = true;
    return lf;
  });
  const stagedTree = stagedReader(staged);
  const actorEntry = cfg.preload?.actorEntry !== undefined ? new RegExp(cfg.preload.actorEntry) : null;
  const preload = computePreloadSets(stagedTree, post, { actorEntry });
  const roles = moduleRoles(stagedTree, post);
  const liveRecord = {
    commit: info.commit,
    toolVersion: TOOL_VERSION,
    count: liveFiles.length,
    bytes: liveFiles.reduce((n, f) => n + f.bytes, 0),
    reachable: full.files.size,
    places: post.places,
    excludedPlaces: excludePlaces,
    delta,
    files: liveFiles,
  };
  let toolVersion = TOOL_VERSION;
  let liveJson = json(liveRecord);
  const editsJson = json({ commit: info.commit, edits: editRecords });
  const preloadJson = json(preload);
  const modulesJson = json({ registry: roles.registry, content: roles.content });
  const hashRecords = (live: Buffer) => sha256(Buffer.concat([live, editsJson, preloadJson, modulesJson]));
  let contentHash = hashRecords(liveJson);
  const prev = o.previousOrigin;
  // Keep the actual generating version when an upgrade produces identical records.
  if (prev && prev.commit === info.commit && prev.toolVersion !== TOOL_VERSION) {
    const priorLive = json({ ...liveRecord, toolVersion: prev.toolVersion });
    if (hashRecords(priorLive) === prev.contentHash) {
      toolVersion = prev.toolVersion;
      liveJson = priorLive;
      contentHash = prev.contentHash;
    }
  }
  const importedAt =
    prev && prev.commit === info.commit && prev.toolVersion === toolVersion && prev.contentHash === contentHash ? prev.importedAt : (o.now ?? (() => new Date()))().toISOString();
  const originJson: OriginJson = { game: cfg.slug, commit: info.commit, date: info.date, subject: info.subject, tool: TOOL, toolVersion, contentHash, importedAt };

  const out = new Map<string, Buffer>(staged);
  out.set('.import/origin.json', json(originJson));
  out.set('.import/live-files.json', liveJson);
  out.set('.import/edits.json', editsJson);
  out.set('.import/preload-sets.json', preloadJson);
  out.set('.import/modules.json', modulesJson);
  for (const [id, patch] of patches) out.set(`.import/patches/${id}.diff`, Buffer.from(patch, 'utf8'));
  return {
    tree: new Map(sorted(out.keys()).map((k) => [k, out.get(k)!])),
    report: { reachable: full.files.size, final: liveFiles.length, places: post.places, delta, edits: editRecords, added },
  };
}

/** the flags file of a game (default `flags.json` when present) */
export function readFlags(text: string | null): Record<string, unknown> {
  if (text === null) return {};
  const v: unknown = text.trimStart().startsWith('{') ? JSON.parse(text) : load(text);
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('flags: an object of <kind>.<name> keys');
  return v as Record<string, unknown>;
}
