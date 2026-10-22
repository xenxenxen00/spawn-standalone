// Copied from purge-protocol-web ebab692 tools/places/compile.ts: the id helpers and types are restated here (the runtime
// exports none of them), the virtual-module producers live in ../virtual.ts, the CLI is dropped.
// Place compiler (docs/design/core-runtime.md §11.1-11.2; build §3.3.1-3.3.2; docs/architecture.md §6.5, X-03, X-26, X-29).
//
//   node tools/places/compile.ts [--root C:/…/repo] [--verbose]     compile game/'s roster, print the summary, exit 1 on errors
//
// Per place, from `places/<p>/config.yaml` and every `places/<p>/cells/*.scene` (js-yaml 5.4.3, YAML 1.2 core schema, so a
// quoted "off" stays a string; the scene parser is plugin-scene's, the one the Vite build and the Node hook use):
//   1. parse each cell (header checked against the file name; rows in file order);
//   2. drop `visibleTo: editors` rows, then apply the content-profile row filter (DR-06 seam; default keeps every row);
//   3. validate: id grammar, duplicate ids, template refs (grammar + file in the tree), behaviour paths in the tree, parents
//      that resolve inside the place, parent cycles; a plain-xz row whose cell key differs from cellKeyOf(feetPosition) is a
//      warning, never an error (objects.scene and non-standard cells such as frostline-relay's `dress` are not checked);
//   4. order: cells in sorted key order with `objects` last, file order inside a cell, a child after its parent;
//   5. rows `{ id, cell, spec }` with the spec as authored (the template merge runs at spawn, core §4.3);
//   6. `rawCells` (tree path → raw text) for a place whose sim runs `powerTick`, for ctx.files.read (core §12.5, B-7);
//   7. the module entries of the place's preload set (behaviours, templates, sim; tools/import-live/preload-sets.ts closes
//      them) and the content scripts it names (generators, look script: the render domain's, never preloaded), and the
//      template refs for the M19 report (override-report.ts).
// `virtual:pp/places` (index + one lazy loader per place) and `virtual:pp/place/<p>` (the place chunk) are produced here and
// registered in tools/vite/virtual-table.ts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TreeReader } from './reach.ts';
import { pathsIn } from './scan.ts';
import { parseScene, type SceneRow } from './scene.ts';
import { parseYaml } from './yaml.ts';

// restated from packages/runtime/src/compat/core/{ids,rules,modules/registry,types}.ts
const ROW_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9][A-Za-z0-9_.-]*)*$/;
const CELL_KEY = /^x(0|-?[1-9][0-9]*)z(0|-?[1-9][0-9]*)$/;
const CELL_SIZE_M = 128;
const TEMPLATE_REF = /^(templates\/[A-Za-z0-9_./-]+\.js)#([A-Za-z_$][A-Za-z0-9_$]*)$/;
const validateId = (id: unknown): id is string => typeof id === 'string' && ROW_ID.test(id);
const parseCellKey = (key: string): { cx: number; cz: number } | null => {
  const m = CELL_KEY.exec(key);
  return m ? { cx: Number(m[1]), cz: Number(m[2]) } : null;
};
const cellKeyOf = (p: { x: number; z: number }): string => `x${Math.round(p.x / CELL_SIZE_M) + 0}z${Math.round(p.z / CELL_SIZE_M) + 0}`;

/** the runtime's CompiledPlace (compat/core/types.ts), structurally */
export interface CompiledPlace {
  readonly id: string;
  readonly mode: '3d';
  readonly gravity: { readonly x: number; readonly y: number; readonly z: number };
  readonly defaultSpawnPoint: Readonly<Record<string, unknown>>;
  readonly defaultSpawnRotation: Readonly<Record<string, unknown>> | null;
  readonly worldBounds: { readonly bottom: number | null };
  readonly atmosphere: Readonly<Record<string, unknown>>;
  readonly terrain: Readonly<Record<string, unknown>>;
  readonly persistence: 'session';
  readonly sim: string | null;
  readonly cells: readonly string[];
  readonly rows: number;
  readonly modules: string;
}

export type { TreeReader };

/** keys whose path value is a content script (render domain: generator, material or look script; terrain generator) */
export const CONTENT_SCRIPT_KEYS: ReadonlySet<string> = new Set(['script', 'generator']);
const POWER_TICK = /\bpowerTick\b/;
const DEFAULT_GRAVITY = { x: 0, y: -9.81, z: 0 } as const;

export interface CompileIssue {
  level: 'error' | 'warning';
  place: string;
  /** the tree file the issue is about */
  file?: string;
  row?: string;
  message: string;
}

export interface CompiledRow {
  id: string;
  cell: string;
  spec: Record<string, unknown>;
}

export interface PlaceModules {
  /** behaviour paths named by the kept rows (normalised, sorted) */
  behaviors: string[];
  /** template files named by the kept rows (sorted) */
  templates: string[];
  /** places/<p>/sim.js when present */
  sim: string | null;
  /** other JS paths the kept rows or the config name outside a content key (none live) */
  other: string[];
}

export interface PlaceCompile {
  id: string;
  config: CompiledPlace;
  rows: CompiledRow[];
  /** tree path → raw text, only for a place whose sim runs powerTick */
  rawCells: Record<string, string> | null;
  modules: PlaceModules;
  /** every distinct template ref of the kept rows (sorted) */
  templateRefs: string[];
  /** content scripts named by the kept rows and the config (sorted) */
  content: string[];
  dropped: { editors: number; filtered: number };
  issues: CompileIssue[];
}

export type SceneRowFilter = (row: Readonly<CompiledRow>, place: string) => boolean;

export interface CompileOptions {
  /** DR-06 content-profile filter (`content.sceneRowFilter`); default keeps every row */
  rowFilter?: SceneRowFilter;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const normalizePath = (p: string): string => (p.startsWith('./') ? p.slice(2) : p.startsWith('/') ? p.slice(1) : p);
const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

/** cell files of a place, direct children of `cells/` (the reach rule) */
export function cellFiles(tree: TreeReader, place: string): string[] {
  const pre = `places/${place}/cells/`;
  return tree.list().filter((p) => p.startsWith(pre) && p.endsWith('.scene') && !p.slice(pre.length).includes('/'));
}

const cellKeyOfFile = (file: string): string => file.slice(file.lastIndexOf('/') + 1, -'.scene'.length);

/** cell keys in load order: sorted, `objects` last (core §11.2 step 4) */
export function orderCells(keys: readonly string[]): string[] {
  const s = [...keys].sort();
  return [...s.filter((k) => k !== 'objects'), ...s.filter((k) => k === 'objects')];
}

interface PathUse {
  behaviors: Set<string>;
  templates: Set<string>;
  refs: Set<string>;
  other: Set<string>;
  content: Set<string>;
  badRefs: string[];
}

const newUse = (): PathUse => ({ behaviors: new Set(), templates: new Set(), refs: new Set(), other: new Set(), content: new Set(), badRefs: [] });

/** Walks a spec or config value and sorts every tree path it names by the key that holds it. */
function collectPaths(v: unknown, key: string | null, use: PathUse): void {
  if (typeof v === 'string') {
    if (key === 'template') {
      const m = TEMPLATE_REF.exec(v);
      if (m) {
        use.refs.add(v);
        use.templates.add(m[1]!);
      } else use.badRefs.push(v);
      return;
    }
    for (const p of pathsIn(v)) {
      if (!p.endsWith('.js')) continue;
      const path = normalizePath(p);
      if (key !== null && CONTENT_SCRIPT_KEYS.has(key)) use.content.add(path);
      else if (key === 'behavior') use.behaviors.add(path);
      else use.other.add(path);
    }
    return;
  }
  if (Array.isArray(v)) {
    for (const x of v) collectPaths(x, key, use);
    return;
  }
  if (isObject(v)) for (const [k, x] of Object.entries(v)) collectPaths(x, k, use);
}

/** the config keys whose values do not reach the runtime (contract §25.1) */
const DROPPED_CONFIG_KEYS = new Set(['arrivalBudget', 'instance', 'policy', 'returnDoor', 'pregenerate', 'fields', 'acoustics']);

function compileConfig(tree: TreeReader, place: string, issues: CompileIssue[], use: PathUse): Omit<CompiledPlace, 'cells' | 'rows'> {
  const file = `places/${place}/config.yaml`;
  const err = (message: string): void => void issues.push({ level: 'error', place, file, message });
  let raw: Record<string, unknown> = {};
  if (!tree.has(file)) err('missing config.yaml');
  else {
    try {
      const doc = parseYaml(tree.text(file), file);
      if (doc === null) raw = {};
      else if (isObject(doc)) raw = doc;
      else err('config.yaml is not a mapping');
    } catch (e) {
      err((e as Error).message);
    }
  }
  for (const k of Object.keys(raw)) {
    if (!DROPPED_CONFIG_KEYS.has(k)) collectPaths(raw[k], k, use);
  }
  const mode = raw['mode'] ?? '3d';
  if (mode !== '3d') err(`mode ${JSON.stringify(mode)} is not "3d"`);
  let gravity: CompiledPlace['gravity'] = { ...DEFAULT_GRAVITY };
  const g = raw['gravity'];
  if (g !== undefined) {
    if (isObject(g) && isNum(g['x']) && isNum(g['y']) && isNum(g['z'])) gravity = { x: g['x'], y: g['y'], z: g['z'] };
    else err('gravity is not {x, y, z}');
  }
  const sp = raw['defaultSpawnPoint'];
  let spawn: CompiledPlace['defaultSpawnPoint'] = { x: 0, y: 0, z: 0 };
  if (isObject(sp) && isNum(sp['x']) && isNum(sp['z']) && (sp['y'] === undefined || isNum(sp['y']) || sp['y'] === 'surface' || isObject(sp['y']))) {
    spawn = sp as CompiledPlace['defaultSpawnPoint'];
  } else err('defaultSpawnPoint is missing or not a position {x, y?, z}');
  let bottom: number | null = null;
  const wb = raw['worldBounds'];
  if (wb !== undefined) {
    if (isObject(wb) && (wb['bottom'] === undefined || isNum(wb['bottom']))) bottom = (wb['bottom'] as number | undefined) ?? null;
    else err('worldBounds.bottom is not a number');
  }
  const persistence = raw['persistence'];
  if (persistence !== undefined && persistence !== 'session') {
    issues.push({ level: 'warning', place, file, message: `persistence ${JSON.stringify(persistence)} recorded as "session" (no effect)` });
  }
  const atmosphere = raw['atmosphere'];
  if (atmosphere !== undefined && !isObject(atmosphere)) err('atmosphere is not a mapping');
  const terrain = raw['terrain'];
  if (terrain !== undefined && !isObject(terrain)) err('terrain is not a mapping');
  const simPath = `places/${place}/sim.js`;
  return {
    id: place,
    mode: '3d',
    gravity,
    defaultSpawnPoint: spawn,
    defaultSpawnRotation: (raw['defaultSpawnRotation'] ?? null) as CompiledPlace['defaultSpawnRotation'],
    worldBounds: { bottom },
    atmosphere: isObject(atmosphere) ? atmosphere : {},
    terrain: isObject(terrain) ? terrain : { kind: 'off' },
    persistence: 'session',
    sim: tree.has(simPath) ? simPath : null,
    modules: `place:${place}`,
  };
}

/** the row's authored feet position when it is a plain world xz (no parent, no camera attach) */
function plainXz(spec: Record<string, unknown>): { x: number; z: number } | null {
  if (spec['parent'] !== undefined) return null;
  const over = spec['overrides'];
  const fp = spec['feetPosition'] ?? (isObject(over) ? over['feetPosition'] : undefined);
  if (!isObject(fp) || fp['attach'] !== undefined) return null;
  return isNum(fp['x']) && isNum(fp['z']) ? { x: fp['x'], z: fp['z'] } : null;
}

function validateChildren(children: unknown, place: string, file: string, row: string, issues: CompileIssue[]): void {
  if (children === undefined) return;
  if (!Array.isArray(children)) {
    issues.push({ level: 'error', place, file, row, message: 'children is not a list' });
    return;
  }
  children.forEach((c, i) => {
    if (!isObject(c)) {
      issues.push({ level: 'error', place, file, row, message: `children[${i}] is not a mapping` });
      return;
    }
    if (c['id'] !== undefined && (typeof c['id'] !== 'string' || !validateId(c['id']) || c['id'].includes('/'))) {
      issues.push({ level: 'error', place, file, row, message: `children[${i}] has an invalid id ${JSON.stringify(c['id'])}` });
    }
    validateChildren(c['children'], place, file, row, issues);
  });
}

/** Steps 1-7 for one place. Never throws on bad data: every problem is an issue. */
export function compilePlace(tree: TreeReader, place: string, opts: CompileOptions = {}): PlaceCompile {
  const issues: CompileIssue[] = [];
  const configUse = newUse();
  const base = compileConfig(tree, place, issues, configUse);

  // 1. parse every cell, cells in load order
  const files = cellFiles(tree, place);
  const byKey = new Map(files.map((f) => [cellKeyOfFile(f), f]));
  const cells = orderCells([...byKey.keys()]);
  const parsed: { cell: string; file: string; row: SceneRow }[] = [];
  for (const cell of cells) {
    const file = byKey.get(cell)!;
    try {
      for (const row of parseScene(tree.text(file), file).rows) parsed.push({ cell, file, row });
    } catch (e) {
      issues.push({ level: 'error', place, file, message: (e as Error).message });
      // keep what the rows name (module entries, later checks) even when the cell itself is refused
      try {
        const doc = parseYaml(tree.text(file), file);
        if (isObject(doc)) for (const [id, spec] of Object.entries(doc)) if (isObject(spec)) parsed.push({ cell, file, row: { id, spec } });
      } catch {
        // the YAML itself does not parse: the error above stands alone
      }
    }
  }

  // 2. filter
  const dropped = { editors: 0, filtered: 0 };
  const kept: { cell: string; file: string; row: CompiledRow }[] = [];
  for (const { cell, file, row } of parsed) {
    if (row.spec['visibleTo'] === 'editors') {
      dropped.editors++;
      continue;
    }
    const r: CompiledRow = { id: row.id, cell, spec: row.spec };
    if (opts.rowFilter && !opts.rowFilter(r, place)) {
      dropped.filtered++;
      continue;
    }
    kept.push({ cell, file, row: r });
  }

  // 3. validate
  const use = newUse();
  const firstCell = new Map<string, string>();
  const unique: typeof kept = [];
  for (const k of kept) {
    const { row, file, cell } = k;
    const err = (message: string): void => void issues.push({ level: 'error', place, file, row: row.id, message });
    if (!validateId(row.id)) err(`invalid row id ${JSON.stringify(row.id)}`);
    const prev = firstCell.get(row.id);
    if (prev !== undefined) {
      err(`duplicate row id (first in cell ${prev}); the later row would be a no-op spawn`);
      continue;
    }
    firstCell.set(row.id, cell);
    unique.push(k);
    const rowUse = newUse();
    collectPaths(row.spec, null, rowUse);
    for (const bad of rowUse.badRefs) err(`bad template ref ${JSON.stringify(bad)} (templates/<file>.js#<identifier>)`);
    for (const t of rowUse.templates) if (!tree.has(t)) err(`template file ${t} is not in the tree`);
    for (const b of rowUse.behaviors) if (!tree.has(b)) err(`behavior ${b} is not in the tree`);
    for (const c of rowUse.content) {
      if (!tree.has(c)) issues.push({ level: 'warning', place, file, row: row.id, message: `content script ${c} is not in the tree` });
    }
    for (const s of ['behaviors', 'templates', 'refs', 'other', 'content'] as const) for (const p of rowUse[s]) use[s].add(p);
    validateChildren(row.spec['children'], place, file, row.id, issues);
    const parent = row.spec['parent'];
    if (parent !== undefined && typeof parent !== 'string') err('parent is not a row id');
    const xz = plainXz(row.spec);
    if (xz && parseCellKey(cell) !== null && cellKeyOf(xz) !== cell) {
      issues.push({ level: 'warning', place, file, row: row.id, message: `feet xz (${xz.x}, ${xz.z}) is in cell ${cellKeyOf(xz)}, not ${cell}` });
    }
  }
  for (const { row, file } of unique) {
    const parent = row.spec['parent'];
    if (typeof parent === 'string' && !firstCell.has(parent)) {
      issues.push({ level: 'error', place, file, row: row.id, message: `parent "${parent}" does not resolve to a row of ${place}` });
    }
  }

  // 4. order: a child waits for its parent, everything else keeps its place
  const ordered: CompiledRow[] = [];
  const emitted = new Set<string>();
  const waiting = new Map<string, CompiledRow[]>();
  const emit = (r: CompiledRow): void => {
    ordered.push(r);
    emitted.add(r.id);
    const kids = waiting.get(r.id);
    if (kids) {
      waiting.delete(r.id);
      for (const k of kids) emit(k);
    }
  };
  for (const { row } of unique) {
    const parent = row.spec['parent'];
    if (typeof parent === 'string' && firstCell.has(parent) && !emitted.has(parent)) {
      const list = waiting.get(parent) ?? [];
      list.push(row);
      waiting.set(parent, list);
    } else emit(row);
  }
  for (const list of waiting.values()) {
    for (const r of list) {
      const file = byKey.get(r.cell)!;
      issues.push({ level: 'error', place, file, row: r.id, message: `parent cycle through "${String(r.spec['parent'])}"` });
      ordered.push(r);
    }
  }

  // 6. raw cells for ctx.files.read
  let rawCells: Record<string, string> | null = null;
  if (base.sim !== null && POWER_TICK.test(tree.text(base.sim))) {
    rawCells = {};
    for (const f of [...files].sort()) rawCells[f] = tree.text(f);
  }

  // 7. module entries and content scripts
  for (const p of configUse.content) {
    if (!tree.has(p)) issues.push({ level: 'warning', place, file: `places/${place}/config.yaml`, message: `content script ${p} is not in the tree` });
  }
  const config: CompiledPlace = { ...base, cells, rows: ordered.length };
  return {
    id: place,
    config,
    rows: ordered,
    rawCells,
    modules: {
      behaviors: sorted(use.behaviors),
      templates: sorted(use.templates),
      sim: base.sim,
      other: sorted([...use.other, ...configUse.other].filter((p) => tree.has(p))),
    },
    templateRefs: sorted(use.refs),
    content: sorted([...use.content, ...configUse.content]),
    dropped,
    issues,
  };
}

export function compilePlaces(tree: TreeReader, places: readonly string[], opts: CompileOptions = {}): { places: PlaceCompile[]; issues: CompileIssue[] } {
  const out = places.map((p) => compilePlace(tree, p, opts));
  return { places: out, issues: out.flatMap((p) => p.issues) };
}

// ── the carried tree on disk ─────────────────────────────────────────────────────────────────────────────────────────

export interface GameTree extends TreeReader {
  /** the roster (game/.import/live-files.json `places`, roster order) */
  places: string[];
  excludedPlaces: string[];
}

interface LiveFilesJson {
  places: string[];
  excludedPlaces: string[];
  files: { path: string }[];
}

/** A TreeReader over `game/` that lists exactly the carried files of game/.import/live-files.json (texts cached). */
export function gameTreeReader(gameRoot: string): GameTree {
  const live = JSON.parse(readFileSync(join(gameRoot, '.import/live-files.json'), 'utf8')) as LiveFilesJson;
  const list = live.files.map((f) => f.path).sort();
  const set = new Set(list);
  const cache = new Map<string, string>();
  return {
    places: [...live.places],
    excludedPlaces: [...(live.excludedPlaces ?? [])],
    has: (p) => set.has(p),
    list: () => list,
    text: (p) => {
      let t = cache.get(p);
      if (t === undefined) {
        if (!set.has(p)) throw new Error(`game tree: ${p} is not a carried file`);
        t = readFileSync(join(gameRoot, p), 'utf8');
        cache.set(p, t);
      }
      return t;
    },
  };
}
