// Clip resolution by name (docs/design/motion-physics-nav.md §3.2): a clip reference written by game code → the CompiledClip
// of its source. String refs resolve in this order: library address `cdn/clip-<name>.glb` → authored identity
// `anim/<file>.yml#<clip>` → clip-function identity `<tree path>#<export>` → the model's own clip names (fuzzy, §3.3.4).
// Non-string refs are authored clip objects (`builtin/anim.play`) or clip functions.
//
// The registry only finds clips; binding to a rig (bone indices, retargeting) is `retarget.ts` / `mixer.ts` (MA2, MA3).
// Its sources are injected: authored clips from `virtual:ss/anim` (MA1, cooked at build), the library catalogue
// (`library.ts`, MA2: lazily loaded per asset group, hence 'pending'), model-embedded clips (`model-clips.ts`, MA2: known once
// the model's container is loaded) and the clip-function baker (`clip-function.ts`, MA3).
import { type AuthoredClipObject, type ClipFunction, type ClipRef, type CompiledClip, clipFromJson } from './clip.ts';
import { AUTHORED_ID_RE, LIBRARY_CLIP_RE } from './constants.ts';
import { compiledOf, isAuthoredClipObject } from './cook-authored.ts';

export type ClipSourceKind = 'library' | 'authored' | 'function' | 'model';

export type ClipResolution =
  | { readonly status: 'ready'; readonly source: ClipSourceKind; readonly clip: CompiledClip }
  /** known to exist but not loaded yet (library group, model container): the mixer keeps the write pending (motion §3.5.6) */
  | { readonly status: 'pending'; readonly source: ClipSourceKind; readonly ref: string }
  | { readonly status: 'missing'; readonly ref: string };

/** Library clips by address: the clip, 'pending' when catalogued but its group is not loaded, undefined when unknown. */
export interface LibraryClipSource {
  get(address: string): CompiledClip | 'pending' | undefined;
}

/** A model's embedded clips (ids `<modelId>#<name>`); undefined while the model is not loaded. */
export interface ModelClipSource {
  clips(modelId: string): readonly CompiledClip[] | undefined;
}

/** Bakes a clip function once into a delta clip (motion §3.3.3); provided by `clip-function.ts`. */
export type ClipFunctionBaker = (fn: ClipFunction) => CompiledClip;

export interface ResolveContext {
  /** the model of the row whose channel is written: enables model clip names */
  modelId?: string;
}

const lower = (s: string): string => s.toLowerCase();
/** strips `Armature|`-style prefixes (everything up to the last '|') */
const strip = (s: string): string => {
  const i = s.lastIndexOf('|');
  return i >= 0 ? s.slice(i + 1) : s;
};

/**
 * Model clip name resolution (contract §9.8, `sk/uploaded-models:23`; motion §3.3.4): exact → case-insensitive → with
 * `Armature|`-style prefixes stripped → prefix match → contains match (`Walk` finds `Walking`) → the clip named `idle`
 * (case-insensitive) → the first clip. Null only for a model without clips.
 */
export function resolveModelClipName(names: readonly string[], want: string): string | null {
  if (names.length === 0) return null;
  if (names.includes(want)) return want;
  const w = lower(want);
  const ci = names.find((n) => lower(n) === w);
  if (ci !== undefined) return ci;
  const ws = lower(strip(want));
  const stripped = names.map((n) => lower(strip(n)));
  const pick = (pred: (s: string) => boolean): string | undefined => {
    const i = stripped.findIndex(pred);
    return i >= 0 ? names[i] : undefined;
  };
  return (
    pick((s) => s === ws) ??
    (ws.length > 0 ? pick((s) => s.startsWith(ws)) : undefined) ??
    (ws.length > 0 ? pick((s) => s.includes(ws)) : undefined) ??
    pick((s) => s === 'idle') ??
    names[0]!
  );
}

/** The clip name inside a model clip id `<modelId>#<name>`. */
function modelClipName(modelId: string, id: string): string {
  if (id.startsWith(`${modelId}#`)) return id.slice(modelId.length + 1);
  const i = id.indexOf('#');
  return i >= 0 ? id.slice(i + 1) : id;
}

export class ClipRegistry {
  private readonly authored = new Map<string, CompiledClip>();
  private readonly authoredByFile = new Map<string, readonly CompiledClip[]>();
  private readonly functions = new Map<string, CompiledClip>();
  private readonly baked = new WeakMap<ClipFunction, CompiledClip>();
  private library: LibraryClipSource | null = null;
  private models: ModelClipSource | null = null;
  private baker: ClipFunctionBaker | null = null;

  /** Registers the cooked clips of one anim file (CompiledClips or their JSON form from `virtual:ss/anim`). */
  addAuthored(path: string, compiled: readonly unknown[]): void {
    const clips = compiled.map((c) => (isCompiledClip(c) ? c : clipFromJson(c)));
    for (const c of clips) {
      const m = AUTHORED_ID_RE.exec(c.id);
      if (!m || m[1] !== path) throw new Error(`clip-registry: ${c.id} is not a clip of ${path}`);
      this.authored.set(c.id, c);
    }
    this.authoredByFile.set(path, clips);
  }

  /** anim files registered so far (sorted) */
  authoredFiles(): string[] {
    return [...this.authoredByFile.keys()].sort();
  }

  /** the cooked clips of one anim file, authored order */
  authoredClips(path: string): readonly CompiledClip[] | undefined {
    return this.authoredByFile.get(path);
  }

  setLibrary(source: LibraryClipSource | null): void {
    this.library = source;
  }

  setModelClips(source: ModelClipSource | null): void {
    this.models = source;
  }

  setFunctionBaker(baker: ClipFunctionBaker | null): void {
    this.baker = baker;
  }

  /** A baked clip function under its identity `<tree path>#<export>` (e.g. `scripts/humanoid-locomotion.js#sit`). */
  addFunctionClip(identity: string, clip: CompiledClip): void {
    this.functions.set(identity, clip);
  }

  /** Resolves a string clip reference (motion §3.2 order). */
  resolve(ref: string, ctx: ResolveContext = {}): ClipResolution {
    if (LIBRARY_CLIP_RE.test(ref) && this.library) {
      const c = this.library.get(ref);
      if (c === 'pending') return { status: 'pending', source: 'library', ref };
      if (c) return { status: 'ready', source: 'library', clip: c };
    }
    const authored = this.authored.get(ref);
    if (authored) return { status: 'ready', source: 'authored', clip: authored };
    const fn = this.functions.get(ref);
    if (fn) return { status: 'ready', source: 'function', clip: fn };
    if (ctx.modelId !== undefined && this.models) {
      const clips = this.models.clips(ctx.modelId);
      if (clips === undefined) return { status: 'pending', source: 'model', ref };
      const modelId = ctx.modelId;
      const names = clips.map((c) => modelClipName(modelId, c.id));
      const name = resolveModelClipName(names, ref);
      if (name !== null) return { status: 'ready', source: 'model', clip: clips[names.indexOf(name)]! };
    }
    return { status: 'missing', ref };
  }

  /** Resolves any channel clip value: strings by name, authored clip objects (cooked once), clip functions (baked once). */
  resolveRef(ref: ClipRef, ctx: ResolveContext = {}): ClipResolution {
    if (typeof ref === 'string') return this.resolve(ref, ctx);
    if (typeof ref === 'function') {
      let c = this.baked.get(ref);
      if (!c) {
        if (!this.baker) return { status: 'missing', ref: 'function' };
        c = this.baker(ref);
        this.baked.set(ref, c);
      }
      return { status: 'ready', source: 'function', clip: c };
    }
    if (isAuthoredClipObject(ref)) return { status: 'ready', source: 'authored', clip: compiledOf(ref as AuthoredClipObject) };
    return { status: 'missing', ref: String(ref) };
  }
}

function isCompiledClip(v: unknown): v is CompiledClip {
  if (typeof v !== 'object' || v === null) return false;
  const tracks = (v as { tracks?: unknown }).tracks;
  return Array.isArray(tracks) && tracks.length > 0 && tracks.every((t: unknown) => typeof t === 'object' && t !== null && (t as { times?: unknown }).times instanceof Float32Array);
}
