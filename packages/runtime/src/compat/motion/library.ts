// The library clip catalogue (docs/design/motion-physics-nav.md §2, §3.3.2): the compiled `cdn/clip-<name>.glb` clips by
// address, loaded lazily, plus the source rigs their absolute tracks are expressed on (for `retarget.ts`). It is the registry's
// `LibraryClipSource`: a loaded clip, 'pending' for a catalogued clip that is not loaded yet (the mixer keeps the channel write
// pending, motion §3.5.6), undefined for an address the catalogue does not know.
//
// The files come from `tools/motion/compile-library-clips.ts` (`clips/<name>.json`, `rigs/<id>.json`, `catalogue.json`). Where
// they are fetched from is not this module's business: the loaders are injected (asset groups: build §5 stage 8a, B6/B8), and
// `add` / `addRig` take data that is already in hand (tests, preloaded groups).
//
// The live library has two source rigs [M]: `library-src` (55 bones with fingers, 21 clips) and `library-src-27` (27 bones,
// body only, 18 clips); a DR-01 replacement clip may bring its own (build §5.6).
import type { LibraryClipSource } from './clip-registry.ts';
import { type CompiledClip, clipFromJson } from './clip.ts';
import { LIBRARY_CLIP_RE } from './constants.ts';
import { type RigDef, rigFromJson } from './rig.ts';

/** Id of the library's main source rig (and the default `sourceRig` of a compiled library clip). */
export const LIBRARY_SRC_RIG = 'library-src';

/** `walk-loop` → `cdn/clip-walk-loop.glb`. */
export const libraryAddress = (name: string): string => `cdn/clip-${name}.glb`;

/** `cdn/clip-walk-loop.glb` (a leading '/' is tolerated) → `walk-loop`; null for anything else. */
export function libraryClipName(address: string): string | null {
  const a = address.startsWith('/') ? address.slice(1) : address;
  return LIBRARY_CLIP_RE.test(a) ? a.slice('cdn/clip-'.length, -'.glb'.length) : null;
}

/** One clip of `catalogue.json`. */
export interface LibraryCatalogueEntry {
  /** path of the compiled clip, relative to the catalogue */
  file: string;
  sourceRig: string;
  duration: number;
  fps?: number;
}

/** `catalogue.json` as the compiler writes it: clip name → file, source rig id → file. */
export interface LibraryCatalogueJson {
  clips: Record<string, LibraryCatalogueEntry>;
  rigs: Record<string, string>;
}

export interface LibraryClipsOptions {
  /** fetches one compiled clip (its JSON form, or an already converted clip) by clip name */
  loadClip?: (name: string) => Promise<unknown>;
  /** fetches one source rig (its JSON form, or a RigDef) by rig id; with it, a clip is ready only once its source rig is */
  loadRig?: (id: string) => Promise<unknown>;
  /** told about every failed load (the failed clip then answers undefined until a later `load` retries it) */
  onError?: (name: string, error: Error) => void;
}

const isCompiled = (v: unknown): v is CompiledClip => {
  const tracks = (v as { tracks?: unknown } | null)?.tracks;
  return Array.isArray(tracks) && tracks.every((t: unknown) => (t as { times?: unknown } | null)?.times instanceof Float32Array);
};
const isRigDef = (v: unknown): v is RigDef => typeof (v as { index?: unknown } | null)?.index === 'function';
const asError = (e: unknown): Error => (e instanceof Error ? e : new Error(String(e)));

export class LibraryClips implements LibraryClipSource {
  private readonly known = new Map<string, LibraryCatalogueEntry | null>();
  private readonly loaded = new Map<string, CompiledClip>();
  private readonly loading = new Map<string, Promise<void>>();
  private readonly failed = new Set<string>();
  private readonly rigs = new Map<string, RigDef>();
  private readonly rigFiles = new Map<string, string>();
  private readonly rigLoading = new Map<string, Promise<void>>();
  private readonly opts: LibraryClipsOptions;

  constructor(opts: LibraryClipsOptions = {}) {
    this.opts = opts;
  }

  /** Declares which clips exist: clip names, or the compiler's `catalogue.json`. Additive. */
  catalogue(source: Iterable<string> | LibraryCatalogueJson): void {
    if (typeof (source as Iterable<string>)[Symbol.iterator] === 'function') {
      for (const name of source as Iterable<string>) if (!this.known.has(name)) this.known.set(name, null);
      return;
    }
    const c = source as LibraryCatalogueJson;
    for (const [name, entry] of Object.entries(c.clips)) this.known.set(name, entry);
    for (const [id, file] of Object.entries(c.rigs ?? {})) this.rigFiles.set(id, file);
  }

  /** Catalogued clip names, sorted. */
  names(): string[] {
    return [...this.known.keys()].sort();
  }

  /** The catalogue entry of a clip (null when it was declared by name only, undefined when unknown). */
  entry(name: string): LibraryCatalogueEntry | null | undefined {
    return this.known.get(name);
  }

  /** The catalogue's file of a source rig. */
  rigFile(id: string): string | undefined {
    return this.rigFiles.get(id);
  }

  /** Stores a compiled clip that is already in hand (its JSON form is converted); the clip is catalogued and ready. */
  add(clip: unknown): CompiledClip {
    const c = isCompiled(clip) ? clip : clipFromJson(clip);
    const name = libraryClipName(c.id);
    if (name === null) throw new Error(`library: ${c.id} is not a library address (cdn/clip-<name>.glb)`);
    if (!this.known.has(name)) this.known.set(name, null);
    this.failed.delete(name);
    this.loaded.set(name, c);
    return c;
  }

  /** Stores a source rig (its JSON form is rebuilt into a RigDef). */
  addRig(rig: unknown): RigDef {
    const r = isRigDef(rig) ? rig : rigFromJson(rig);
    this.rigs.set(r.id, r);
    return r;
  }

  /** A loaded source rig by id (`clip.sourceRig`); the main library rig by default. */
  rig(id: string | undefined = LIBRARY_SRC_RIG): RigDef | undefined {
    return this.rigs.get(id);
  }

  /**
   * `LibraryClipSource`: the clip, 'pending' while it is catalogued and not loaded, undefined when unknown or when its load
   * failed. With a loader, the first request for a pending clip starts its load (clips outside a preloaded group load lazily).
   */
  get(address: string): CompiledClip | 'pending' | undefined {
    const name = libraryClipName(address);
    if (name === null) return undefined;
    const c = this.loaded.get(name);
    if (c) return c;
    if (!this.known.has(name) || this.failed.has(name)) return undefined;
    if (this.opts.loadClip && !this.loading.has(name)) this.start(name).catch(() => undefined);
    return 'pending';
  }

  /**
   * Loads clips by name (every catalogued clip when omitted): one request per clip however often it is asked for. Resolves
   * when all are ready; rejects with the first failure after every request has settled. A failed clip is retried here.
   */
  async load(names?: Iterable<string>): Promise<void> {
    const list = names ? [...names] : this.names();
    const results = await Promise.allSettled(
      list.map((name) => {
        if (this.loaded.has(name)) return Promise.resolve();
        this.failed.delete(name);
        return this.loading.get(name) ?? this.start(name);
      }),
    );
    for (const r of results) if (r.status === 'rejected') throw asError(r.reason);
  }

  /** Resolves once no load is in flight (never rejects). */
  async settled(): Promise<void> {
    while (this.loading.size > 0 || this.rigLoading.size > 0) {
      await Promise.allSettled([...this.loading.values(), ...this.rigLoading.values()]);
    }
  }

  private start(name: string): Promise<void> {
    const run = async (): Promise<void> => {
      const loadClip = this.opts.loadClip;
      if (!loadClip) throw new Error('no clip loader was given');
      const raw = await loadClip(name);
      const c = isCompiled(raw) ? raw : clipFromJson(raw);
      if (c.id !== libraryAddress(name)) throw new Error(`the loaded file is ${c.id}`);
      if (c.sourceRig !== undefined && this.opts.loadRig && !this.rigs.has(c.sourceRig)) await this.startRig(c.sourceRig);
      this.loaded.set(name, c);
      if (!this.known.has(name)) this.known.set(name, null);
    };
    const p = run()
      .catch((e: unknown) => {
        const err = new Error(`library clip ${name}: ${asError(e).message}`);
        this.failed.add(name);
        this.opts.onError?.(name, asError(e));
        throw err;
      })
      .finally(() => {
        this.loading.delete(name);
      });
    this.loading.set(name, p);
    return p;
  }

  private startRig(id: string): Promise<void> {
    let p = this.rigLoading.get(id);
    if (!p) {
      p = (async (): Promise<void> => {
        const raw = await this.opts.loadRig!(id);
        const r = this.addRig(raw);
        if (r.id !== id) {
          this.rigs.delete(r.id);
          throw new Error(`source rig ${id}: the loaded file is ${r.id}`);
        }
      })().finally(() => {
        this.rigLoading.delete(id);
      });
      this.rigLoading.set(id, p);
    }
    return p;
  }
}
