// Copied from purge-protocol-web ebab692 tools/import-live/preload-sets.ts; the actor entries are an option (default none),
// and the sets are computed by the import (written to game/.import/preload-sets.json), which the Vite plugin serves.
// Preload sets and module roles (core §12.2-12.3, X-26; build §3.3.1, §3.4) → game/.import/preload-sets.json (written by the
// import) and `virtual:pp/preload-sets` (computed from game/ by the producer below, so a build never reads stale sets).
//
// Rules (WP C3; B1 wrote the skeleton):
//   edge roles     an `import`, `dynamic`, `runtime` or `place` edge names a module. A `path` edge (a tree-rooted string) names
//                  a CONTENT script when the string is the value of a `script:` / `generator:` / `lighting:` / `texture:` key
//                  (primitive, material and look scripts, the terrain generator, the world's lighting, a texture script such
//                  as scripts/tex-beam.js: the render domain's, run in the geometry workers, the look recorder, the
//                  texture-script runner or ported to GLSL), or when its target exports a content hook (`geometry`, `look`,
//                  `material`, `lighting`, `heightAt`, `texture`) and no `behavior:` key names it (a path held in a
//                  constant first: scripts/map/door.js:50-51); any other path string names a module
//   registry       every carried JS file reached from the roots (world config, sim.js, the place roots) over module edges.
//                  The rest of the JS (content scripts and what only they import) is never a registry module, whatever its
//                  folder: three scene behaviours live under scripts/gen/ and are registry modules
//   closures       follow module edges, never content edges. A literal `import()` is not a member (the game loads it
//                  itself: set `lazy`), but its static subgraph is walked: every module it names by a path string binds
//                  through the registry, so it joins the set that imports it (else a late bind, core §12.4)
//   boot           world-config modules + sim.js (minus the director set); stops at actor templates
//   director       the closure of sim.js's `import()` targets; stops at actor templates
//   actors         templates/bot.js, templates/enemies/*.js, templates/bosses/*.js and their closure, plus anim/*.yml
//   place:<p>      the closure of what the place's compiled rows (editor rows dropped) and its sim name
//                  (tools/places/compile.ts), minus boot and director; never content scripts; on Cradle Biolabs it holds the
//                  roam archetype templates (X-29)
//   lazy           `import()` targets of the sets that no set holds
import type { EdgeKind, ReachResult, TreeReader } from './reach.ts';
import { keyBefore, PATH_RE, scanJs, stripYamlComments } from './scan.ts';
import { compilePlace } from './places.ts';

export type PreloadSetId = 'boot' | 'director' | 'actors' | 'lazy' | `place:${string}`;

export interface PreloadSets {
  rules: string;
  sets: Record<PreloadSetId, string[]>;
}

export const RULES = 'C3: module edges only (no content scripts), import() targets lazy but their path-named modules preloaded, place sets from compiled rows';

/** keys whose path value is a content script, not a module */
export const CONTENT_KEYS: ReadonlySet<string> = new Set(['script', 'generator', 'lighting', 'texture']);

const ANIM = /^anim\/[^/]+\.yml$/;
const PLACE_SIM = /^places\/[^/]+\/sim\.js$/;
const sorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

// the key a value belongs to (`script: 'x'` → `script`): scan.ts, shared with the pack's display-field scan of JS data modules
export { keyBefore };

/**
 * The content-hook exports (core §12.7): `geometry` (primitive generators), `look` (look scripts), `material` (material
 * scripts), `lighting` (the world's BRDF), `heightAt` (the terrain generator), `texture` (a texture script: a `material.texture`
 * that names a script path, scripts/player/team-glow.js:18). A path string naming such a module is a content
 * edge even when it is held in a constant first (`const WRECK = "scripts/gen/kit/doorwreck.js"` … `script: WRECK`,
 * scripts/map/door.js:50; `export const LOOK = 'scripts/looks/surge.js'`, scripts/fx/surge-logic.js:14), unless a
 * `behavior:` key names it.
 */
export const CONTENT_HOOK_EXPORT = /^export\s+(?:async\s+)?(?:function\s*\*?\s*|const\s+|let\s+)(?:geometry|look|material|lighting|heightAt|texture)\b/m;

type Role = 'module' | 'content' | 'behavior';

/** per file: path string → the roles its occurrences give it */
function occurrenceRoles(tree: TreeReader, file: string): Map<string, Set<Role>> {
  const out = new Map<string, Set<Role>>();
  const add = (p: string, key: string | null): void => {
    const set = out.get(p) ?? new Set<Role>();
    set.add(key !== null && CONTENT_KEYS.has(key) ? 'content' : 'module');
    if (key === 'behavior') set.add('behavior');
    out.set(p, set);
  };
  const text = tree.text(file);
  if (file.endsWith('.js')) {
    // only quoted occurrences of paths that a string literal holds (comments mention paths without quotes)
    const literal = new Set<string>();
    for (const s of scanJs(text).strings) for (const m of s.value.matchAll(PATH_RE)) literal.add(m[0]!);
    for (const m of text.matchAll(PATH_RE)) {
      const full = m[0]!;
      const at = m.index!;
      if (!literal.has(full)) continue;
      const before = text[at - 1];
      if (before !== '"' && before !== "'" && before !== '`') continue;
      add(m[1]!, keyBefore(text, at));
    }
  } else if (/\.(?:ya?ml|scene)$/.test(file)) {
    const bare = stripYamlComments(text);
    for (const m of bare.matchAll(PATH_RE)) add(m[1]!, keyBefore(bare, m.index!));
  }
  return out;
}

interface RoledEdge {
  to: string;
  kind: EdgeKind;
  /** follows as a module edge */
  module: boolean;
  /** names a content script */
  content: boolean;
}

/** The import graph with a role on every edge. */
export class RoleGraph {
  readonly tree: TreeReader;
  readonly graph: ReachResult;
  private readonly adj = new Map<string, RoledEdge[]>();

  constructor(tree: TreeReader, graph: ReachResult) {
    this.tree = tree;
    this.graph = graph;
    const roles = new Map<string, Map<string, Set<Role>>>();
    const hooks = new Map<string, boolean>();
    const exportsContentHook = (p: string): boolean => {
      let h = hooks.get(p);
      if (h === undefined) {
        h = p.endsWith('.js') && tree.has(p) && CONTENT_HOOK_EXPORT.test(tree.text(p));
        hooks.set(p, h);
      }
      return h;
    };
    for (const e of graph.edges) {
      let module = true;
      let content = false;
      if (e.kind === 'path') {
        let r = roles.get(e.from);
        if (!r) {
          r = occurrenceRoles(tree, e.from);
          roles.set(e.from, r);
        }
        const set = r.get(e.to);
        if (set) {
          module = set.has('module');
          content = set.has('content');
        }
        if (exportsContentHook(e.to) && !set?.has('behavior')) {
          module = false;
          content = true;
        }
      }
      const list = this.adj.get(e.from) ?? [];
      list.push({ to: e.to, kind: e.kind, module, content });
      this.adj.set(e.from, list);
    }
  }

  edges(from: string): readonly RoledEdge[] {
    return this.adj.get(from) ?? [];
  }

  /**
   * The engine's root files: the data roots reach started from (world config, place configs and cells) plus sim.js and the
   * place sims. A JS file the world config names is reach's root too, but only through its key (`lighting:` is content).
   */
  roots(): string[] {
    return [...this.graph.files].filter(([p, f]) => f.via === null && (!p.endsWith('.js') || p === 'sim.js' || PLACE_SIM.test(p))).map(([p]) => p);
  }

  /** breadth-first over module edges (static and dynamic), from `start` */
  moduleReach(start: readonly string[]): Set<string> {
    const seen = new Set(start.filter((p) => this.tree.has(p)));
    const queue = [...seen];
    for (let i = 0; i < queue.length; i++) {
      for (const e of this.edges(queue[i]!)) {
        if (!e.module || seen.has(e.to) || !this.tree.has(e.to)) continue;
        seen.add(e.to);
        queue.push(e.to);
      }
    }
    return seen;
  }

  /**
   * A preload closure: members over static module edges; an `import()` target is walked in lazy mode (static imports
   * walked, not members) and any module a lazy file names by path, or by a runtime edge, becomes a member.
   */
  closure(start: readonly string[], opts: { stopAt?: ReadonlySet<string>; skipDynamicFrom?: ReadonlySet<string> } = {}): { members: Set<string>; lazy: Set<string> } {
    const stop = opts.stopAt ?? new Set<string>();
    const members = new Set<string>();
    const lazy = new Set<string>();
    const lazyRoots = new Set<string>();
    const queue: Array<{ p: string; member: boolean }> = [];
    const visit = (p: string, member: boolean): void => {
      if (!this.tree.has(p) || stop.has(p)) return;
      if (member) {
        if (members.has(p)) return;
        members.add(p);
      } else {
        if (members.has(p) || lazy.has(p)) return;
        lazy.add(p);
      }
      queue.push({ p, member });
    };
    for (const s of start) visit(s, true);
    for (let i = 0; i < queue.length; i++) {
      const { p, member } = queue[i]!;
      for (const e of this.edges(p)) {
        if (!e.module) continue;
        if (e.kind === 'dynamic') {
          if (!opts.skipDynamicFrom?.has(p)) {
            lazyRoots.add(e.to);
            visit(e.to, false);
          }
        } else if (e.kind === 'import') visit(e.to, member);
        else visit(e.to, true); // path, runtime: bound through the registry
      }
    }
    // `lazy` names the import() targets only; their static imports load with them
    return { members, lazy: new Set([...lazyRoots].filter((p) => !members.has(p) && this.tree.has(p) && !stop.has(p))) };
  }
}

export interface ModuleRoles {
  /** JS modules the kernel may resolve by path: the registry's map (virtual:pp/modules) */
  registry: string[];
  /** JS that only content-script edges reach (generators, material/look scripts, lighting): never registry modules */
  content: string[];
  /** every target a registry module or data file names by a module-role path string */
  modulePathTargets: string[];
  /** modules that lazily imported code names by path (preloaded with the set that imports them) */
  lazyNamed: string[];
}

export function moduleRoles(tree: TreeReader, graph: ReachResult, rg = new RoleGraph(tree, graph)): ModuleRoles {
  const main = rg.moduleReach(rg.roots());
  const js = (p: string): boolean => p.endsWith('.js');
  const registry = sorted([...main].filter(js));
  // a job module (root `job:<id>`) and what only it reaches run in a worker: neither is a registry module nor page content
  const jobOnly = (p: string): boolean => (graph.files.get(p)?.roots ?? []).every((r) => r.startsWith('job:'));
  const content = sorted([...graph.files.keys()].filter((p) => js(p) && !main.has(p) && !jobOnly(p)));
  const targets = new Set<string>();
  for (const f of main) for (const e of rg.edges(f)) if (e.kind === 'path' && e.module && tree.has(e.to)) targets.add(e.to);
  // lazy code: the static subgraphs of import() targets; what it names by path
  const lazyRoots = new Set<string>();
  // sim.js's import() targets are the director set, not lazy code
  for (const f of main) for (const e of rg.edges(f)) if (e.kind === 'dynamic' && e.module && f !== 'sim.js') lazyRoots.add(e.to);
  const lazyFiles = new Set<string>();
  const q = [...lazyRoots];
  for (const p of q) {
    if (lazyFiles.has(p)) continue;
    lazyFiles.add(p);
    for (const e of rg.edges(p)) if (e.kind === 'import' && e.module) q.push(e.to);
  }
  const named = new Set<string>();
  for (const f of lazyFiles) {
    for (const e of rg.edges(f)) if ((e.kind === 'path' || e.kind === 'runtime') && e.module && tree.has(e.to) && !lazyFiles.has(e.to)) named.add(e.to);
  }
  return { registry, content, modulePathTargets: sorted(targets), lazyNamed: sorted([...named].filter(js)) };
}

/** registry modules plus place sims (a set member must be a registry module or an anim entry) */
const isSetModule = (registry: ReadonlySet<string>) => (p: string): boolean => registry.has(p) || PLACE_SIM.test(p);

export interface PreloadOptions {
  /** the entry templates of the `actors` set (loaded after the boot); default none (only anim/*.yml) */
  actorEntry?: RegExp | null;
}

export function computePreloadSets(tree: TreeReader, graph: ReachResult, opts: PreloadOptions = {}): PreloadSets {
  const rg = new RoleGraph(tree, graph);
  const roles = moduleRoles(tree, graph, rg);
  const keep = isSetModule(new Set(roles.registry));
  const files = tree.list();
  const actorEntry = opts.actorEntry ?? null;
  const actorEntries = actorEntry === null ? [] : files.filter((p) => actorEntry.test(p));
  const stop = new Set(actorEntries);
  const simDynamic = rg.edges('sim.js').filter((e) => e.kind === 'dynamic' && e.module).map((e) => e.to);
  const worldRoots = rg.edges('world.config.yaml').filter((e) => e.module).map((e) => e.to);
  const skipSim = new Set(['sim.js']);
  const lazy = new Set<string>();
  const run = (start: string[], o: Parameters<RoleGraph['closure']>[1] = {}): string[] => {
    const c = rg.closure(start, o);
    for (const l of c.lazy) lazy.add(l);
    return sorted([...c.members].filter(keep));
  };

  const director = run(simDynamic, { stopAt: stop });
  const directorSet = new Set(director);
  const boot = run([...worldRoots, 'sim.js'], { stopAt: stop, skipDynamicFrom: skipSim }).filter((p) => !directorSet.has(p));
  const preloaded = new Set([...boot, ...director]);
  const actors = sorted([...run(actorEntries).filter((p) => !preloaded.has(p)), ...files.filter((p) => ANIM.test(p))]);
  const sets: Record<string, string[]> = { boot, director, actors };
  for (const place of graph.places) {
    const pc = compilePlace(tree, place);
    const entries = [...pc.modules.behaviors, ...pc.modules.templates, ...pc.modules.other, ...(pc.modules.sim ? [pc.modules.sim] : [])];
    sets[`place:${place}`] = run(entries).filter((p) => !preloaded.has(p));
  }
  const inSets = new Set(Object.values(sets).flat());
  sets['lazy'] = sorted([...lazy].filter((p) => keep(p) && !inSets.has(p) && simDynamic.indexOf(p) < 0));
  return { rules: RULES, sets: sets as Record<PreloadSetId, string[]> };
}

/**
 * The first static import cycle (`[a, b, a]`) among `files` (default: every JS file of the tree), else null. Static imports
 * only (relative or tree-rooted); `import()` is not an edge. The live engine refused a cycle ("ModuleCycleFault"), Vite does
 * not, so this re-runs the live `.spawn/tests/import-cycles.test.mjs` rule on the carried tree.
 */
export function findImportCycle(tree: TreeReader, files?: readonly string[]): string[] | null {
  const importsOf = new Map<string, string[]>();
  const edges = (f: string): string[] => {
    let out = importsOf.get(f);
    if (!out) {
      out = [];
      for (const imp of scanJs(tree.text(f)).imports) {
        if (imp.dynamic) continue;
        let to: string | null = null;
        if (imp.spec.startsWith('./') || imp.spec.startsWith('../')) {
          const parts = f.split('/').slice(0, -1);
          for (const seg of imp.spec.split('/')) {
            if (seg === '.' || seg === '') continue;
            if (seg === '..') parts.pop();
            else parts.push(seg);
          }
          to = parts.join('/');
        } else if (/^(?:scripts|templates)\//.test(imp.spec)) to = imp.spec;
        if (to && to.endsWith('.js') && tree.has(to)) out.push(to);
      }
      importsOf.set(f, out);
    }
    return out;
  };
  const state = new Map<string, 0 | 1>();
  const stack: string[] = [];
  const visit = (f: string): string[] | null => {
    const s = state.get(f);
    if (s === 1) return null;
    if (s === 0) return [...stack.slice(stack.indexOf(f)), f];
    state.set(f, 0);
    stack.push(f);
    for (const g of edges(f)) {
      const c = visit(g);
      if (c) return c;
    }
    stack.pop();
    state.set(f, 1);
    return null;
  };
  for (const f of files ?? tree.list().filter((p) => p.endsWith('.js'))) {
    const c = visit(f);
    if (c) return c;
  }
  return null;
}
