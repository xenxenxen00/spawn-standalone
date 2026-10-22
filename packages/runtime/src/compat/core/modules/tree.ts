// Tree data of the carried game (docs/design/core-runtime.md §12.5; build §3.3.2; contract §5.10).
//
//   files        ctx.world.files: every carried file, sorted (virtual:ss/world-files). It must list templates/bot.js,
//                templates/terminal.js, templates/enemies/*.js, templates/bosses/*.js and every places/<p>/cells/*.scene
//                (authored module filters it; authored module and authored module test
//                membership, so a dormant archetype answers false because it is not carried)
//   readText     ctx.files.read: raw text when shipped (the place chunk's rawCells of the 11 power-grid places, added at the
//                place load), null for a path outside the tree, null and one dev warning for a tree path whose text never shipped
//   readParsed   anim/<arch>.yml from the registry's anim entries (the actors set; builtin/anim.clips reads them synchronously)
//                and any other YAML a loader added with addParsed
import type { TreePath, TreeStore } from '../types.ts';
import type { AnimEntry } from './registry.ts';
import { normalizeTreePath } from './registry.ts';

export interface TreeStoreOptions {
  /** the carried file list (any order) */
  files: readonly TreePath[];
  /** the registry's loaded anim entries (`ModuleRegistryImpl.anim`) */
  anim?: (path: TreePath) => AnimEntry | undefined;
  /** default: console.warn */
  log?: { warn(message: string): void };
}

export class TreeStoreImpl implements TreeStore {
  readonly files: readonly TreePath[];
  private readonly known: ReadonlySet<TreePath>;
  private readonly texts = new Map<TreePath, string>();
  private readonly parsed = new Map<TreePath, unknown>();
  private readonly anim: ((path: TreePath) => AnimEntry | undefined) | undefined;
  private readonly log: { warn(message: string): void };
  private readonly warned = new Set<string>();

  constructor(opts: TreeStoreOptions) {
    this.files = Object.freeze([...new Set(opts.files)].sort());
    this.known = new Set(this.files);
    this.anim = opts.anim;
    this.log = opts.log ?? { warn: (m) => console.warn(m) };
  }

  /** whether `path` is a carried file */
  has(path: TreePath): boolean {
    return this.known.has(normalizeTreePath(path));
  }

  readText(path: TreePath): string | null {
    const p = normalizeTreePath(path);
    const text = this.texts.get(p);
    if (text !== undefined) return text;
    if (this.known.has(p)) this.warnOnce(`files.read: ${p} is carried but its text was not shipped (only the power-grid places' raw cells are)`);
    return null;
  }

  readParsed(path: TreePath): unknown {
    const p = normalizeTreePath(path);
    if (this.parsed.has(p)) return this.parsed.get(p);
    const entry = this.anim?.(p);
    if (entry) return entry.authored;
    if (this.known.has(p)) this.warnOnce(`readParsed: ${p} is not preloaded (anim/*.yml loads with the actors set)`);
    return undefined;
  }

  addTexts(texts: Readonly<Record<TreePath, string>>): void {
    for (const [path, text] of Object.entries(texts)) {
      const p = normalizeTreePath(path);
      if (!this.known.has(p)) throw new Error(`tree: ${p} is not a carried file; a place chunk ships raw text only for its own cells`);
      this.texts.set(p, text);
    }
  }

  /** preloaded YAML other than the anim entries */
  addParsed(path: TreePath, value: unknown): void {
    const p = normalizeTreePath(path);
    if (!this.known.has(p)) throw new Error(`tree: ${p} is not a carried file`);
    this.parsed.set(p, value);
  }

  private warnOnce(m: string): void {
    if (this.warned.has(m)) return;
    this.warned.add(m);
    this.log.warn(m);
  }
}

export function createTreeStore(opts: TreeStoreOptions): TreeStoreImpl {
  return new TreeStoreImpl(opts);
}
