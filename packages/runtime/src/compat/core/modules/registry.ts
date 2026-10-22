// Module registry for the carried game code (docs/design/core-runtime.md §12.2-12.4; docs/architecture.md §3.3, X-03, X-26).
//
// Path strings in specs (`behavior: "authored module"`, `template: "templates/x.js#y"`, place sims, world-config bindings)
// resolve here, synchronously: `get` answers only for loaded modules, `template` refuses an unloaded file instead of waiting.
// The inputs are injected (WP C3): the lazy loader map (`virtual:ss/modules`), the preload sets (`virtual:ss/preload-sets`)
// and the anim entries (`virtual:ss/anim`). The binding to those virtual modules is B4b's `modules/bind-virtual.ts`; tests and
// headless tools pass maps of their own. Generator modules are never in the map (X-26): they run in the geometry workers.
//
// Each module is evaluated once per page (both VMs share module-level state, mp §11.1). `load` is the late-binding path of
// §12.4: every call that finds its module not yet loaded counts in `lateBinds` and warns, so a soak with `lateBinds === 0`
// proves the preload sets complete.
import type { BehaviorModule, ModuleRegistry, ObjectSpec, RegistryInputs, SimModule, TemplateRef, TreePath } from '../types.ts';

/** Thrown for a spawn the kernel refuses (core §4.5): an Error whose `name` is 'SpawnRefused'. C1b imports it from here. */
export class SpawnRefused extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SpawnRefused';
  }
}

/** `templates/<file>.js#<identifier>` (core §4.3 step 1; the export is an identifier, never `#ceiling-leech`) */
export const TEMPLATE_REF = /^(templates\/[A-Za-z0-9_./-]+\.js)#([A-Za-z_$][A-Za-z0-9_$]*)$/;

export function parseTemplateRef(ref: string): { file: TreePath; exportName: string } | null {
  const m = TEMPLATE_REF.exec(ref);
  return m ? { file: m[1]!, exportName: m[2]! } : null;
}

/** a tree path without a leading `./` or `/` (core §4.2) */
export function normalizeTreePath(path: string): TreePath {
  if (path.startsWith('./')) return path.slice(2);
  if (path.startsWith('/')) return path.slice(1);
  return path;
}

/** the sim cadence grammar (`"100ms"`, `"1s"`, `"5m"`) in milliseconds; null when it does not parse */
export function parseCadenceMs(cadence: string): number | null {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m)$/.exec(cadence.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return m[2] === 'ms' ? n : m[2] === 's' ? n * 1000 : n * 60_000;
}

/** every live sim declares "100ms"; anything else is a boot error (core §12.2) */
export const SIM_CADENCE_MS = 100;

export interface RegistryLog {
  warn(message: string): void;
}

export interface RegistryOptions {
  /** default: console.warn */
  log?: RegistryLog;
}

export interface AnimEntry {
  readonly authored: unknown;
  readonly compiled: unknown;
}

type Namespace = Record<string, unknown>;

const isPlainObject = (v: unknown): v is Record<string, unknown> => {
  if (v === null || typeof v !== 'object') return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
};

/** A deep copy of plain objects and arrays, frozen at every level; other values (functions, class instances) are kept as is. */
function frozenCopy<T>(v: T): T {
  if (Array.isArray(v)) return Object.freeze(v.map((x: unknown) => frozenCopy(x))) as T;
  if (isPlainObject(v)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v)) {
      // a `__proto__` key stays an own data property
      Object.defineProperty(out, k, { value: frozenCopy(v[k]), enumerable: true, writable: true, configurable: true });
    }
    return Object.freeze(out) as T;
  }
  return v;
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class ModuleRegistryImpl implements ModuleRegistry {
  private readonly modules: RegistryInputs['modules'];
  private readonly sets: Readonly<Record<string, readonly TreePath[]>>;
  private readonly animLoaders: RegistryInputs['anim'];
  private readonly log: RegistryLog;
  private readonly loaded = new Map<TreePath, Namespace>();
  private readonly inflight = new Map<TreePath, Promise<Namespace>>();
  private readonly animLoaded = new Map<TreePath, AnimEntry>();
  private readonly animInflight = new Map<TreePath, Promise<AnimEntry>>();
  private readonly templates = new Map<TemplateRef, Readonly<ObjectSpec>>();
  private late = 0;

  constructor(inputs: RegistryInputs, opts: RegistryOptions = {}) {
    this.modules = inputs.modules;
    this.sets = inputs.sets;
    this.animLoaders = inputs.anim;
    this.log = opts.log ?? { warn: (m) => console.warn(m) };
  }

  get lateBinds(): number {
    return this.late;
  }

  knows(path: TreePath): boolean {
    return Object.hasOwn(this.modules, normalizeTreePath(path));
  }

  /** an anim entry (`anim/<arch>.yml`) the registry can load through `ensure` */
  knowsAnim(path: TreePath): boolean {
    return Object.hasOwn(this.animLoaders, normalizeTreePath(path));
  }

  /** every anim entry path the registry can load (`anim/<arch>.yml`) */
  animPaths(): string[] {
    return Object.keys(this.animLoaders);
  }

  /** the preload set ids (`boot`, `director`, `actors`, `place:<p>`, …) */
  setIds(): string[] {
    return Object.keys(this.sets);
  }

  get(path: TreePath): Record<string, unknown> | undefined {
    return this.loaded.get(normalizeTreePath(path));
  }

  /** the loaded anim entry of `anim/<arch>.yml` (the actors set), else undefined; read by the tree store (core §12.5) */
  anim(path: TreePath): AnimEntry | undefined {
    return this.animLoaded.get(normalizeTreePath(path));
  }

  template(ref: TemplateRef): Readonly<ObjectSpec> {
    const hit = this.templates.get(ref);
    if (hit) return hit;
    const parsed = parseTemplateRef(ref);
    if (!parsed) throw new SpawnRefused(`spawn refused: bad template ref "${ref}" (templates/<file>.js#<identifier>)`);
    if (!this.knows(parsed.file)) throw new SpawnRefused(`spawn refused: unknown template file: ${parsed.file}`);
    const ns = this.loaded.get(parsed.file);
    if (!ns) throw new SpawnRefused(`spawn refused: template not loaded: ${parsed.file}`);
    if (!Object.hasOwn(ns, parsed.exportName)) throw new SpawnRefused(`spawn refused: template export missing: ${ref}`);
    const value = ns[parsed.exportName];
    if (!isPlainObject(value)) throw new SpawnRefused(`spawn refused: template export is not an object: ${ref}`);
    const spec = frozenCopy(value) as Readonly<ObjectSpec>;
    this.templates.set(ref, spec);
    return spec;
  }

  async ensure(setOrPaths: string | TreePath[], onProgress?: (f: number) => void): Promise<void> {
    let paths: TreePath[];
    if (typeof setOrPaths === 'string') {
      if (!Object.hasOwn(this.sets, setOrPaths)) throw new Error(`registry: unknown preload set "${setOrPaths}"`);
      paths = [...this.sets[setOrPaths]!];
    } else paths = setOrPaths.map(normalizeTreePath);
    const what = typeof setOrPaths === 'string' ? `set "${setOrPaths}"` : 'ensure';
    const unknown = paths.filter((p) => !this.knows(p) && !this.knowsAnim(p));
    if (unknown.length) throw new Error(`registry: ${what} names unknown paths: ${unknown.join(', ')}`);

    const pending = paths.filter((p) => !this.loaded.has(p) && !this.animLoaded.has(p));
    if (pending.length === 0) {
      onProgress?.(1);
      return;
    }
    const total = paths.length;
    let done = total - pending.length;
    const failures: string[] = [];
    await Promise.all(
      pending.map(async (p) => {
        try {
          await (this.knows(p) ? this.evaluate(p) : this.evaluateAnim(p));
        } catch (e) {
          failures.push(`${p}: ${message(e)}`);
        }
        done++;
        if (done < total) onProgress?.(done / total);
      }),
    );
    if (failures.length) throw new Error(`registry: ${what} failed to load: ${failures.sort().join('; ')}`);
    onProgress?.(1);
  }

  async load(path: TreePath, forWhat?: string): Promise<Record<string, unknown>> {
    const p = normalizeTreePath(path);
    const hit = this.loaded.get(p);
    if (hit) return hit;
    if (!this.knows(p)) throw new Error(`registry: unknown module ${p}`);
    this.late++;
    this.log.warn(`late bind ${p}${forWhat ? ` for ${forWhat}` : ''}`);
    return this.evaluate(p);
  }

  private evaluate(p: TreePath): Promise<Namespace> {
    const hit = this.loaded.get(p);
    if (hit) return Promise.resolve(hit);
    let run = this.inflight.get(p);
    if (!run) {
      run = this.modules[p]!().then(
        (ns) => {
          this.loaded.set(p, ns);
          this.inflight.delete(p);
          return ns;
        },
        (e: unknown) => {
          this.inflight.delete(p); // a later ensure or load retries
          throw e;
        },
      );
      this.inflight.set(p, run);
    }
    return run;
  }

  private evaluateAnim(p: TreePath): Promise<AnimEntry> {
    const hit = this.animLoaded.get(p);
    if (hit) return Promise.resolve(hit);
    let run = this.animInflight.get(p);
    if (!run) {
      run = this.animLoaders[p]!().then(
        (entry) => {
          this.animLoaded.set(p, entry);
          this.animInflight.delete(p);
          return entry;
        },
        (e: unknown) => {
          this.animInflight.delete(p);
          throw e;
        },
      );
      this.animInflight.set(p, run);
    }
    return run;
  }
}

export function createRegistry(inputs: RegistryInputs, opts: RegistryOptions = {}): ModuleRegistryImpl {
  return new ModuleRegistryImpl(inputs, opts);
}

// ── module shapes (core §12.2, §12.7: validated by type guards at bind time) ─────────────────────────────────────────

const HOOKS = ['onSpawn', 'update', 'onInput', 'onDestroy', 'onTriggerEnter', 'onOutOfBounds'] as const;

/** A carried behavior module as the kernel sees it. Throws, naming the path and the field, when a hook has the wrong type. */
export function asBehaviorModule(ns: Record<string, unknown>, path: TreePath): BehaviorModule {
  for (const h of HOOKS) {
    if (ns[h] !== undefined && typeof ns[h] !== 'function') throw new TypeError(`${path}: behavior hook ${h} is ${typeof ns[h]}, not a function`);
  }
  const ears = ns['ears'];
  if (ears !== undefined) {
    if (ears === null || typeof ears !== 'object') throw new TypeError(`${path}: ears is not an object`);
    for (const [k, v] of Object.entries(ears)) {
      if (typeof v !== 'function') throw new TypeError(`${path}: ears.${k} is ${typeof v}, not a function`);
    }
  }
  const schedule = ns['updateSchedule'];
  if (schedule !== undefined && (schedule === null || typeof schedule !== 'object')) {
    throw new TypeError(`${path}: updateSchedule is ${schedule === null ? 'null' : typeof schedule}, not an object`);
  }
  return ns as BehaviorModule;
}

/** `sim.js` / `places/<p>/sim.js`: `tick` is a function and the cadence, when declared, is 100 ms (core §12.2). */
export function asSimModule(ns: Record<string, unknown>, path: TreePath, opts?: { anyCadence?: boolean }): SimModule {
  if (typeof ns['tick'] !== 'function') throw new TypeError(`${path}: a sim exports tick(ctx), found ${typeof ns['tick']}`);
  const cadence = ns['cadence'];
  if (cadence !== undefined && opts?.anyCadence !== true) {
    const ms = typeof cadence === 'string' ? parseCadenceMs(cadence) : null;
    if (ms !== SIM_CADENCE_MS) throw new TypeError(`${path}: sim cadence "${String(cadence)}" is not ${SIM_CADENCE_MS}ms (boot error)`);
  }
  return ns as unknown as SimModule;
}
