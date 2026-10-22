// `builtin/anim` for the carried game code (engine api:1406-1415; contract §16.2; docs/design/motion-physics-nav.md §3.6;
// WP MA3). three-free; imports its own domain (motion) and core types only, with explicit `.ts` extensions, so the live-suite
// harness can load it under Node type stripping in place of its stub (build §8.3 mode 2).
//
//   clips(ctx, path): Record<name, Clip>
//     The parsed clips of `anim/<arch>.yml`. Throws `Error("anim: no such file <path>")` when the build does not carry the
//     file (the four dormant archetypes) or it is not loaded: authored module catches it and retries every 4 s.
//     The objects are stable per (session, path) and are copies of the build's data; each carries its build-cooked
//     CompiledClip under the hidden `Symbol.for('ss.compiled')` (not enumerable: `plain()` and spread copies do not carry it),
//     so `play` never re-cooks. `name` is the clip's key in the file when the file gives none [INF].
//   play(ctx, target, clip, opts?): string
//     Puts the clip on a channel of the target (a handle or a row id) and returns the channel name:
//     `opts.channel ?? clip.name ?? 'main'`. It writes `target.anim[channel] = { clip: <identity string>, loop, speed, weight,
//     blendIn, blendOut, time }` (the options given, `loop: true → 'loop'`, `false → 'once'`), so the mixer's write rules apply
//     as to any channel write (§3.5.2) and the channel reads back the identity: `anim/<arch>.yml#<clip>` for a clip of
//     `clips()`, `inline#<name>` for a raw clip object (cooked once, kept apart per object), `<tree path>#<export>` or
//     `function#<name>` for a clip function. A corpse snapshot, which keeps string clips only, therefore carries them.
//     An id that names no row throws, as `builtin/tween` does.
//   stop(ctx, target, channel?): void
//     Clears the channel; without one, every channel this module started on that target handle [INF]. Never throws for a
//     channel or a row that is gone.
//   toTracks(clip)
//     The engine's cooked shape: rotation tracks as quaternions (motion/cook-authored.ts).
//
// The host (`createAnimHost`) is where `clips` finds the anim files and where raw clips and clip functions are registered so
// their identity strings resolve in the mixer. The ctx factories attach the kernel's host to every ctx (`attachAnimHost`, C5);
// a ctx without one uses the default host (`setDefaultAnimHost`: a single-kernel app, the live suite), and with none at all
// `clips` finds no file while `play` / `stop` still write the channel.
import type { ObjectView } from '../core/types.ts';
import type { AuthoredClipObject, ClipFunction, CompiledClip } from '../motion/clip.ts';
import { bakeClipFunction, identityOfClipFunction } from '../motion/clip-function.ts';
import type { ClipRegistry } from '../motion/clip-registry.ts';
import { SS_COMPILED, authoredIdentity, compiledOf, cookAuthoredFile, isAuthoredClipObject } from '../motion/cook-authored.ts';

export { toTracks } from '../motion/cook-authored.ts';
export type { AuthoredClipObject, AuthoredTrackSpec, ClipFunction, TrackKeys } from '../motion/clip.ts';

/** where a ctx carries its kernel's anim host (Symbol.for: the same key from every copy of this module) */
export const ANIM_HOST: unique symbol = Symbol.for('ss.compat.animHost') as never;

export interface PlayOpts {
  channel?: string;
  loop?: boolean | 'once' | 'loop' | 'pingpong';
  speed?: number;
  weight?: number;
  /** seconds */
  blendIn?: number;
  /** seconds */
  blendOut?: number;
  /** clip seconds to start (or, with speed 0, hold) at */
  time?: number;
}

/** the slice of a ctx this module reads (a GameCtx has it) */
export interface AnimCtx {
  readonly session?: object;
  getObject?(id: string): unknown;
}

/** one anim file as the build serves it (`virtual:ss/anim` through the module registry): the parsed YAML and its cooked clips */
export interface AnimFileEntry {
  readonly authored: unknown;
  /** CompiledClip[] or their JSON form; cooked here from `authored` when absent */
  readonly compiled?: unknown;
}

export interface AnimHostOptions {
  /** the clip registry of the kernel's mixers */
  registry: ClipRegistry;
  /** the loaded entry of `anim/<arch>.yml`, undefined when the file is not carried or not loaded (`ModuleRegistry.anim`) */
  file(path: string): AnimFileEntry | undefined;
}

type ClipTable = Record<string, AuthoredClipObject>;

interface FileData {
  readonly authored: Readonly<Record<string, unknown>>;
  /** by clip name */
  readonly compiled: ReadonlyMap<string, CompiledClip>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const noFile = (path: string): Error => new Error(`anim: no such file ${path}`);

export class AnimHost {
  readonly registry: ClipRegistry;
  readonly #file: (path: string) => AnimFileEntry | undefined;
  /** loaded files; a miss is never kept (the file may land later) */
  readonly #files = new Map<string, FileData>();
  /** per session object: path → the clip objects handed out */
  readonly #tables = new WeakMap<object, Map<string, ClipTable>>();
  /** identity string → the raw clip object or function registered under it */
  readonly #taken = new Map<string, object>();
  readonly #identities = new WeakMap<object, string>();

  constructor(opts: AnimHostOptions) {
    this.registry = opts.registry;
    this.#file = opts.file;
  }

  /** `clips(ctx, path)`: the stable clip objects of a session (a ctx without a session object shares the host's) */
  clips(session: object | null | undefined, path: string): ClipTable {
    const key: object = typeof session === 'object' && session !== null ? session : this;
    let per = this.#tables.get(key);
    const hit = per?.get(path);
    if (hit) return hit;
    const data = this.#load(path);
    const table: ClipTable = {};
    for (const [name, compiled] of data.compiled) {
      const clip = structuredClone(data.authored[name]) as AuthoredClipObject;
      if (clip.name === undefined) clip.name = name;
      Object.defineProperty(clip, SS_COMPILED, { value: compiled, enumerable: false, writable: false, configurable: false });
      table[name] = clip;
    }
    if (!per) {
      per = new Map();
      this.#tables.set(key, per);
    }
    per.set(path, table);
    return table;
  }

  /** The identity string a clip plays under; a raw clip object or an unregistered clip function is registered so it resolves. */
  identityOf(clip: AuthoredClipObject | ClipFunction): string {
    if (typeof clip !== 'function') {
      const tagged = (clip as { [SS_COMPILED]?: CompiledClip })[SS_COMPILED];
      if (tagged !== undefined) return tagged.id;
    } else {
      const known = identityOfClipFunction(clip);
      if (known !== undefined) return known;
    }
    const had = this.#identities.get(clip);
    if (had !== undefined) return had;
    const compiled = typeof clip === 'function' ? bakeClipFunction(clip) : compiledOf(clip);
    // two raw objects may share a name: each keeps its own identity
    let identity = compiled.id;
    for (let n = 2; this.#taken.has(identity); n++) identity = `${compiled.id}~${n}`;
    this.#taken.set(identity, clip);
    this.#identities.set(clip, identity);
    this.registry.addFunctionClip(identity, compiled);
    return identity;
  }

  #load(path: string): FileData {
    const known = this.#files.get(path);
    if (known) return known;
    const entry = this.#file(path);
    if (!entry || !isObj(entry.authored)) throw noFile(path);
    let cooked = this.registry.authoredClips(path);
    if (cooked === undefined) {
      this.registry.addAuthored(path, Array.isArray(entry.compiled) ? entry.compiled : cookAuthoredFile(path, entry.authored));
      cooked = this.registry.authoredClips(path) ?? [];
    }
    const byId = new Map(cooked.map((c) => [c.id, c] as const));
    const compiled = new Map<string, CompiledClip>();
    for (const [name, clip] of Object.entries(entry.authored)) {
      if (!isAuthoredClipObject(clip)) continue;
      const c = byId.get(authoredIdentity(path, name));
      if (c) compiled.set(name, c);
    }
    const data: FileData = { authored: entry.authored, compiled };
    this.#files.set(path, data);
    return data;
  }
}

export function createAnimHost(opts: AnimHostOptions): AnimHost {
  return new AnimHost(opts);
}

/** called by the ctx factories: the ctx's kernel host, for clips / play */
export function attachAnimHost(ctx: object, host: AnimHost): void {
  Object.defineProperty(ctx, ANIM_HOST, { value: host, enumerable: false, configurable: true, writable: false });
}

let defaultHost: AnimHost | null = null;

/** the host of every ctx that carries none (one kernel per page; the live suite's fake contexts) */
export function setDefaultAnimHost(host: AnimHost | null): void {
  defaultHost = host;
}

function hostOf(ctx: unknown): AnimHost | null {
  const own = isObjLike(ctx) ? (ctx as { [ANIM_HOST]?: unknown })[ANIM_HOST] : undefined;
  // duck-typed: a second copy of this module (another bundle chunk) must still find the host
  if (isObjLike(own) && typeof (own as { clips?: unknown }).clips === 'function' && typeof (own as { identityOf?: unknown }).identityOf === 'function') return own as AnimHost;
  return defaultHost;
}

const isObjLike = (v: unknown): v is object => (typeof v === 'object' && v !== null) || typeof v === 'function';

/** per target handle: the channels `play` started on it (for `stop` without a channel) */
const STARTED = new WeakMap<object, Set<string>>();

function targetOf(ctx: AnimCtx | null | undefined, target: unknown, what: string): Record<string, unknown> | null {
  if (typeof target === 'string') {
    const found = ctx?.getObject?.(target) ?? null;
    return isObjLike(found) ? (found as Record<string, unknown>) : null;
  }
  if (!isObjLike(target)) throw new TypeError(`builtin/anim: the target of ${what} must be a handle or a row id`);
  return target as Record<string, unknown>;
}

/** the target's channel bag: `handle.anim` is a live view; a plain double without one gets a plain object */
function bagOf(target: Record<string, unknown>): Record<string, unknown> {
  let bag = target['anim'];
  if (!isObjLike(bag)) {
    target['anim'] = {};
    bag = target['anim'];
  }
  return bag as Record<string, unknown>;
}

const LOOPS: readonly unknown[] = ['once', 'loop', 'pingpong'];

/** the identity a clip plays under when no host can register it (a test double's ctx) */
function standaloneIdentity(clip: AuthoredClipObject | ClipFunction): string {
  if (typeof clip === 'function') return identityOfClipFunction(clip) ?? bakeClipFunction(clip).id;
  return compiledOf(clip).id;
}

/** parsed clips of an anim file; throws Error(`anim: no such file ${path}`) when absent */
export function clips(ctx: AnimCtx, path: string): Record<string, AuthoredClipObject> {
  const p = String(path).replace(/^\.?\/+/, '');
  const host = hostOf(ctx);
  if (host === null) throw noFile(p);
  return host.clips(isObjLike(ctx) ? ctx.session : null, p);
}

/** puts the clip on a channel of the target; returns the channel name (opts.channel ?? clip.name ?? 'main') */
export function play(ctx: AnimCtx, target: string | ObjectView, clip: AuthoredClipObject | ClipFunction, opts: PlayOpts = {}): string {
  if (typeof clip !== 'function' && !isAuthoredClipObject(clip)) throw new TypeError('builtin/anim: play takes a clip object ({ duration, tracks }) or a clip function');
  const t = targetOf(ctx, target, 'play');
  if (t === null) throw new Error(`builtin/anim: no object ${JSON.stringify(target)} to play on`);
  const o: PlayOpts = isObj(opts) ? opts : {};
  const named: unknown = o.channel ?? clip.name;
  const channel = typeof named === 'string' && named !== '' ? named : 'main';
  const host = hostOf(ctx);
  const identity = host !== null ? host.identityOf(clip) : standaloneIdentity(clip);
  const write: Record<string, unknown> = { clip: identity };
  if (o.loop === true) write['loop'] = 'loop';
  else if (o.loop === false) write['loop'] = 'once';
  else if (LOOPS.includes(o.loop)) write['loop'] = o.loop;
  for (const k of ['speed', 'weight', 'blendIn', 'blendOut', 'time'] as const) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) write[k] = v;
  }
  bagOf(t)[channel] = write;
  let started = STARTED.get(t);
  if (!started) {
    started = new Set();
    STARTED.set(t, started);
  }
  started.add(channel);
  return channel;
}

/** clears one channel, or every channel this module started on the target when `channel` is omitted */
export function stop(ctx: AnimCtx, target: string | ObjectView, channel?: string): void {
  const t = targetOf(ctx, target, 'stop');
  if (t === null) return;
  const started = STARTED.get(t);
  if (typeof channel === 'string') {
    bagOf(t)[channel] = null;
    started?.delete(channel);
    return;
  }
  if (!started || started.size === 0) return;
  const bag = bagOf(t);
  for (const ch of started) bag[ch] = null;
  started.clear();
}
