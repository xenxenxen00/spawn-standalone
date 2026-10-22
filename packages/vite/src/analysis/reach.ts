// The import's reachability graph. Copied from purge-protocol-web ebab692 tools/import-live/reach.ts and made game-agnostic:
// the roots, runtime edges and roster are options (defaults: world.config.yaml + sim.js, no runtime edges, the roster is the
// world config's `defaultPlace` plus `roster.extra`; no portal rule unless `roster.portalBehavior` is set), and an
// interpolated template literal whose head is a tree-rooted folder (`templates/enemies/${arch}.js`) is expanded to every
// file of that folder with the literal's tail.
//
// Edge kinds:
//   import        static `import … from`, side-effect `import '…'`, `export … from` (relative or tree-rooted specifiers;
//                 `builtin/*` is the engine and has no file)
//   dynamic       literal `import('…')`
//   path          a tree-rooted path string (`scripts/…`, `templates/…#export`, `anim/…`, `places/…`, `ui/…`) in a string
//                 literal of a reached JS file or anywhere in a reached YAML / scene file outside comments
//   runtime       a runtime-built path resolved by hand (config.ts RUNTIME_EDGES), followed when its builder is reached
//   place         a place root: its config.yaml, every cells/*.scene and an optional sim.js
// Places become roots by the roster rule (`roster.file` rows with `ready: true` when set, `roster.extra`, the world config's
// `defaultPlace`) and as the target of a reached portal row (`behavior: <roster.portalBehavior>`, `state.to: <place>`).
import { load } from 'js-yaml';
import { pathsIn, scanJs, stripYamlComments } from './scan.ts';

/** a path the game builds at run time, resolved by hand: followed when `from` is reached */
export interface RuntimeEdge {
  from: string;
  to: readonly string[];
  why?: string;
}

export interface RosterOptions {
  /** a YAML file of `<place>: { ready: true }` rows; null = none */
  file: string | null;
  extra: readonly string[];
  /** the behaviour path of a portal row (`state.to` names the target place); null = no portal rule */
  portalBehavior: string | null;
}

export const ROOT_FILES: readonly { file: string; root: string }[] = [
  { file: 'world.config.yaml', root: 'world' },
  { file: 'sim.js', root: 'sim.js' },
];
export const RUNTIME_EDGES: readonly RuntimeEdge[] = [];
export const ROSTER: RosterOptions = { file: null, extra: [], portalBehavior: null };

export interface TreeReader {
  has(path: string): boolean;
  text(path: string): string;
  list(): string[];
}

export type EdgeKind = 'import' | 'dynamic' | 'path' | 'runtime' | 'place';

export interface Edge {
  from: string;
  to: string;
  kind: EdgeKind;
}

export interface Dangling {
  from: string;
  /** a path, or `place:<id>` */
  target: string;
  kind: EdgeKind;
}

export interface ReachOptions {
  /** files treated as absent: edges to them are recorded as `excluded`, never as dangling */
  excludeFiles?: ReadonlySet<string>;
  /** place ids that are not roots (their files may still be reached through other edges) */
  excludePlaces?: readonly string[];
  runtimeEdges?: readonly RuntimeEdge[];
  rootFiles?: readonly { file: string; root: string }[];
  roster?: Partial<RosterOptions>;
}

export interface ReachedFile {
  /** the roots that reach this file (`world:<key>`, `sim.js`, `place:<id>`, …), sorted */
  roots: string[];
  /** first parent in breadth-first order (null for a root file) */
  via: string | null;
  /** the place whose root owns this file (config, cells, sim.js) */
  place?: string;
}

export interface ReachResult {
  files: Map<string, ReachedFile>;
  /** live places in roster order (roster, defaultPlace, portal targets) */
  places: string[];
  /** per place: the scripted generator modules (`scripts/gen/**`) its closure reaches */
  generators: Map<string, string[]>;
  edges: Edge[];
  dangling: Dangling[];
  /** edges whose target was excluded */
  excluded: Edge[];
}

const kindOf = (p: string): 'js' | 'yml' | 'yaml' | 'scene' | 'other' => {
  if (p.endsWith('.js')) return 'js';
  if (p.endsWith('.yml')) return 'yml';
  if (p.endsWith('.yaml')) return 'yaml';
  if (p.endsWith('.scene')) return 'scene';
  return 'other';
};

/** posix join + normalise (`a/b/../c` → `a/c`); null when it climbs above the root */
export function resolveRel(fromFile: string, spec: string): string | null {
  const parts = fromFile.split('/').slice(0, -1);
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const TREE_ROOTED = /^(?:scripts|templates|places|anim|ui|clips)\//;

interface FileEdges {
  edges: { to: string; kind: EdgeKind }[];
  portalTargets: string[];
}

/** path → the last edges computed for it, with the exact text and options they were computed from */
const SHARED_EDGES = new Map<string, { text: string; extra: string; edges: FileEdges }>();

export class Graph {
  private readonly tree: TreeReader;
  private readonly opts: Required<Omit<ReachOptions, 'excludeFiles' | 'excludePlaces' | 'roster'>> & {
    roster: RosterOptions;
    excludeFiles: ReadonlySet<string>;
    excludePlaces: readonly string[];
  };
  private readonly cache = new Map<string, FileEdges>();
  private readonly all: string[];

  constructor(tree: TreeReader, opts: ReachOptions = {}) {
    this.tree = tree;
    this.all = tree.list();
    this.opts = {
      excludeFiles: opts.excludeFiles ?? new Set(),
      excludePlaces: opts.excludePlaces ?? [],
      runtimeEdges: opts.runtimeEdges ?? RUNTIME_EDGES,
      rootFiles: opts.rootFiles ?? ROOT_FILES,
      roster: { ...ROSTER, ...(opts.roster ?? {}) } as RosterOptions,
    };
  }

  /** The outgoing edges of one file (cached; raw targets, not yet checked against the tree). */
  edgesOf(file: string): FileEdges {
    const hit = this.cache.get(file);
    if (hit) return hit;
    const k = kindOf(file);
    const text = k === 'other' ? '' : this.tree.text(file);
    // the edges are a pure function of (path, text, the runtime edges from this path, the portal behaviour): one import
    // builds several graphs over the same texts, so they are shared across Graph instances on that exact key
    const runtime = this.opts.runtimeEdges.filter((r) => r.from === file);
    const extra = JSON.stringify([runtime, this.opts.roster.portalBehavior]);
    const shared = SHARED_EDGES.get(file);
    if (shared && shared.text === text && shared.extra === extra) {
      this.cache.set(file, shared.edges);
      return shared.edges;
    }
    const out = this.computeEdges(file, k, text);
    SHARED_EDGES.set(file, { text, extra, edges: out });
    this.cache.set(file, out);
    return out;
  }

  private computeEdges(file: string, k: ReturnType<typeof kindOf>, text: string): FileEdges {
    const out: FileEdges = { edges: [], portalTargets: [] };
    if (k === 'js') {
      const scan = scanJs(text);
      for (const imp of scan.imports) {
        const kind: EdgeKind = imp.dynamic ? 'dynamic' : 'import';
        if (imp.spec.startsWith('./') || imp.spec.startsWith('../')) {
          const to = resolveRel(file, imp.spec);
          if (to) out.edges.push({ to, kind });
        } else if (TREE_ROOTED.test(imp.spec)) out.edges.push({ to: imp.spec, kind });
      }
      const importSpecs = new Set(scan.imports.map((x) => x.spec));
      for (const s of scan.strings) {
        if (s.interpolated && s.tail !== undefined) {
          for (const to of this.expandTemplate(s.value, s.tail)) out.edges.push({ to, kind: 'path' });
          continue;
        }
        if (importSpecs.has(s.value)) continue;
        for (const p of pathsIn(s.value)) out.edges.push({ to: p, kind: 'path' });
      }
    } else if (k !== 'other') {
      const bare = stripYamlComments(text);
      for (const p of pathsIn(bare)) out.edges.push({ to: p, kind: 'path' });
      if (k === 'scene') out.portalTargets = this.portalTargets(file, text);
    }
    for (const r of this.opts.runtimeEdges) {
      if (r.from === file) for (const to of r.to) out.edges.push({ to, kind: 'runtime' });
    }
    // de-duplicate, keep first kind
    const seen = new Set<string>();
    out.edges = out.edges.filter((e) => (seen.has(e.to) ? false : (seen.add(e.to), true)));
    Object.freeze(out.edges);
    Object.freeze(out.portalTargets);
    return Object.freeze(out);
  }

  /** `templates/enemies/` + `.js`: every tree file directly in that folder with that suffix (no match: no edge) */
  expandTemplate(head: string, rawTail: string): string[] {
    if (!TREE_ROOTED.test(head)) return [];
    const slash = head.lastIndexOf('/');
    const dir = head.slice(0, slash + 1);
    const stem = head.slice(slash + 1);
    const tail = rawTail.replace(/#[\w$]*$/, ''); // `templates/e/${a}.js#enemy`: the ref's export is not part of the path
    if (tail.includes('/') || !tail.includes('.')) return [];
    return this.all.filter((p) => p.startsWith(dir + stem) && p.endsWith(tail) && !p.slice(dir.length).includes('/') && p.length > dir.length + stem.length + tail.length);
  }

  private portalTargets(file: string, text: string): string[] {
    const portal = this.opts.roster.portalBehavior;
    if (portal === null || !text.includes(portal)) return [];
    let doc: unknown;
    try {
      doc = load(text);
    } catch (e) {
      throw new Error(`reach: cannot parse ${file}: ${(e as Error).message}`);
    }
    const out: string[] = [];
    if (doc && typeof doc === 'object') {
      for (const row of Object.values(doc as Record<string, unknown>)) {
        if (!row || typeof row !== 'object') continue;
        const r = row as { behavior?: unknown; state?: { to?: unknown } };
        const b = Array.isArray(r.behavior) ? r.behavior : [r.behavior];
        if (b.includes(portal) && typeof r.state?.to === 'string') out.push(r.state.to);
      }
    }
    return out;
  }

  /** the files of a place root: config.yaml, cells/*.scene, sim.js */
  placeFiles(place: string): string[] {
    const pre = `places/${place}/`;
    return this.all.filter(
      (p) => p === `${pre}config.yaml` || p === `${pre}sim.js` || (p.startsWith(`${pre}cells/`) && p.endsWith('.scene') && !p.slice(pre.length + 6).includes('/')),
    );
  }

  placeExists(place: string): boolean {
    return this.tree.has(`places/${place}/config.yaml`);
  }

  /** Roster places: maps.yml `ready: true` rows (order kept) + extras; then `defaultPlace` of the world config. */
  rosterPlaces(): string[] {
    const out: string[] = [];
    const add = (p: string): void => {
      if (!out.includes(p)) out.push(p);
    };
    const { file, extra } = this.opts.roster;
    if (file !== null && this.tree.has(file)) {
      const maps = load(this.tree.text(file)) as Record<string, { ready?: unknown }> | null;
      for (const [id, row] of Object.entries(maps ?? {})) if (row && row.ready === true) add(id);
    }
    for (const p of extra) add(p);
    if (this.tree.has('world.config.yaml')) {
      const w = load(this.tree.text('world.config.yaml')) as { defaultPlace?: unknown } | null;
      if (typeof w?.defaultPlace === 'string') add(w.defaultPlace);
    }
    return out;
  }

  private worldRoots(): { root: string; files: string[] }[] {
    const roots: { root: string; files: string[] }[] = [];
    for (const r of this.opts.rootFiles) {
      if (!this.tree.has(r.file) || this.opts.excludeFiles.has(r.file)) continue;
      if (r.file === 'world.config.yaml') {
        // each path the world config names is its own root, labelled by its key path
        roots.push({ root: 'world', files: [r.file] });
        const cfg = load(this.tree.text(r.file));
        const walk = (v: unknown, key: string): void => {
          if (typeof v === 'string') {
            for (const p of pathsIn(v)) roots.push({ root: `world:${key}`, files: [p] });
          } else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
          else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, key ? `${key}.${k}` : k);
        };
        walk(cfg, '');
      } else roots.push({ root: r.root, files: [r.file] });
    }
    return roots;
  }

  /** Breadth-first closure from the start files; returns parent links (start files map to null). */
  private bfs(start: string[], sink?: { edges: Edge[]; dangling: Dangling[]; excluded: Edge[] }, portals?: string[]): Map<string, string | null> {
    const parent = new Map<string, string | null>();
    const queue: string[] = [];
    for (const f of start) {
      if (this.opts.excludeFiles.has(f) || !this.tree.has(f) || parent.has(f)) continue;
      parent.set(f, null);
      queue.push(f);
    }
    for (let qi = 0; qi < queue.length; qi++) {
      const f = queue[qi]!;
      const fe = this.edgesOf(f);
      for (const e of fe.edges) {
        const edge = { from: f, to: e.to, kind: e.kind };
        if (this.opts.excludeFiles.has(e.to)) {
          sink?.excluded.push(edge);
          continue;
        }
        if (!this.tree.has(e.to)) {
          sink?.dangling.push({ from: f, target: e.to, kind: e.kind });
          continue;
        }
        sink?.edges.push(edge);
        if (!parent.has(e.to)) {
          parent.set(e.to, f);
          queue.push(e.to);
        }
      }
      if (portals) for (const p of fe.portalTargets) portals.push(p);
    }
    return parent;
  }

  run(): ReachResult {
    const excludedPlaces = new Set(this.opts.excludePlaces);
    const roots = this.worldRoots();
    const places: string[] = [];
    const dangling: Dangling[] = [];
    const addPlace = (p: string, from: string | null): void => {
      if (places.includes(p)) return;
      if (!this.placeExists(p)) {
        if (from) dangling.push({ from, target: `place:${p}`, kind: 'place' });
        return;
      }
      if (excludedPlaces.has(p)) {
        if (from) dangling.push({ from, target: `place:${p}`, kind: 'place' });
        return;
      }
      places.push(p);
    };
    for (const p of this.rosterPlaces()) addPlace(p, null);

    // fixpoint over portal targets: a reached portal row adds its target place as a root
    const placeRoot = (p: string): { root: string; files: string[] } => ({ root: `place:${p}`, files: this.placeFiles(p) });
    let parent = new Map<string, string | null>();
    const portalFrom = new Map<string, string>();
    for (;;) {
      const all = [...roots, ...places.map(placeRoot)];
      const portals: string[] = [];
      parent = this.bfs(all.flatMap((r) => r.files), undefined, portals);
      const before = places.length;
      // attribute each portal target to the scene that names it
      for (const f of parent.keys()) for (const t of this.edgesOf(f).portalTargets) if (!portalFrom.has(t)) portalFrom.set(t, f);
      for (const t of portals) addPlace(t, portalFrom.get(t) ?? null);
      if (places.length === before) break;
    }
    // dangling place refs are recorded once
    const uniq = new Map(dangling.map((d) => [`${d.from}→${d.target}`, d]));

    // final pass with sinks, then per-root attribution
    const sink = { edges: [] as Edge[], dangling: [] as Dangling[], excluded: [] as Edge[] };
    const allRoots = [...roots, ...places.map(placeRoot)];
    parent = this.bfs(allRoots.flatMap((r) => r.files), sink);
    const files = new Map<string, ReachedFile>();
    for (const [f, via] of parent) files.set(f, { roots: [], via });
    for (const r of allRoots) {
      const reach = this.bfs(r.files);
      for (const f of reach.keys()) files.get(f)?.roots.push(r.root);
    }
    for (const r of files.values()) r.roots = [...new Set(r.roots)].sort();
    const generators = new Map<string, string[]>();
    for (const p of places) {
      for (const f of this.placeFiles(p)) {
        const rf = files.get(f);
        if (rf) rf.place = p;
      }
      const gens = [...this.bfs(this.placeFiles(p)).keys()].filter((f) => f.startsWith('scripts/gen/')).sort();
      generators.set(p, gens);
    }
    for (const d of sink.dangling) uniq.set(`${d.from}→${d.target}`, d);
    return {
      files: new Map([...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
      places,
      generators,
      edges: sink.edges,
      dangling: [...uniq.values()],
      excluded: sink.excluded,
    };
  }
}

export function reach(tree: TreeReader, opts: ReachOptions = {}): ReachResult {
  return new Graph(tree, opts).run();
}
