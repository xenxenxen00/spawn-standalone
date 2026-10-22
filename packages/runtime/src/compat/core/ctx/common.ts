// What every ctx of a kernel shares (docs/design/core-runtime.md §3.4, §7, §7.1; contract §4.1, §5.9-5.13):
//
//   CtxLog          `ctx.log / warn / error`: the console with the owner's script path as prefix, a ring buffer of the last
//                   2,000 lines for the debug overlay, identical lines limited to one per 5 s with a count
//   CtxShared       per kernel: the members that do not depend on the owner (`now`, `random`, `files`, `view`, `cancel`,
//                   `getObjectSocket`, the unavailable verbs), the world handle of each realm, the place handles, the row-less
//                   state stores (world.state, place.state) and the per-script log functions
//   GameCtxBase     the behavior / sim / rig ctx: verbs are own function properties and closures, never methods that need
//                   `this` (the game keeps them as values: `const fn = level === "error" && ctx.error ? ctx.error : ctx.log`,
//                   authored module), wired to the kernel verbs with the owner as the caller
//
// A ctx is created once per owner and reused for every hook call (the game stores `k.ctx` in kits, and a `ctx.on` handler gets
// the registering owner's ctx); the UI ctx is the exception, one per render (ctx/ui.ts). Unsupported Spawn verbs exist and
// throw `<verb> is not available in this build`; `ctx.wallNow` is deliberately absent (`authored module` probes
// for it and falls back to Date.now()).
import type { CoreKernel } from '../kernel.ts';
import { ENGINE } from '../rules.ts';
import { destroyRows, spawnRow } from '../lifecycle.ts';
import { getObject, placesOf, query, type Viewer } from '../query.ts';
import type { HookOwner } from '../behaviors/invoke.ts';
import type { Realm } from '../store/proxies.ts';
import { LayeredValueImpl } from '../store/layers.ts';
import { attachTweenRunner } from '../../builtin/tween.ts';
import { installExtVerbs } from './ext-verbs.ts';
import type {
  CallerRef,
  CrossResult,
  EarHandler,
  EmitOptions,
  GameCtx,
  LayeredValue,
  ObjectSpec,
  ObjectView,
  PlaceHandle,
  PlaceId,
  QueryOptions,
  RowId,
  TimerInfo,
  UnavailableVerbs,
  VmId,
  WorldHandle,
} from '../types.ts';
import { PlaceHandleImpl } from './place-handle.ts';
import { StateBag } from './state-bag.ts';
import { ignoreWrites, WorldHandleImpl } from './world-handle.ts';

// ── logging ──────────────────────────────────────────────────────────────────────────────────────────────────────────

export type LogLevel = 'log' | 'warn' | 'error';

export interface LogLine {
  readonly level: LogLevel;
  /** the owner's script path (`authored module`, `sim.js`, `ui`) */
  readonly script: string;
  readonly message: string;
  readonly data?: unknown;
  /** the tick of the first line of the run */
  readonly tick: number;
  /** identical lines folded into this one (1 = printed once) */
  count: number;
}

export interface CtxLogOptions {
  /** the current tick, recorded per line */
  tick?: (() => number) | undefined;
  /** ms for the rate limit; default Date.now (log timing never touches the simulation) */
  wallClock?: (() => number) | undefined;
  /** where lines are printed; default the console */
  sink?: Pick<Console, 'log' | 'warn' | 'error'> | undefined;
  /** ring buffer size (default ENGINE.LOG_RING_LINES) */
  ring?: number | undefined;
  /** identical lines are printed once per this many ms (default ENGINE.LOG_REPEAT_MS) */
  repeatMs?: number | undefined;
}

interface Repeat {
  at: number;
  suppressed: number;
  line: LogLine;
}

/** repeat keys kept before the expired ones are swept */
const REPEAT_KEYS_MAX = 1024;

function signature(data: unknown): string {
  if (data === undefined) return '';
  if (data === null || typeof data !== 'object') return String(data);
  try {
    return JSON.stringify(data) ?? '';
  } catch {
    return '[unserialisable]';
  }
}

export class CtxLog {
  readonly #tick: () => number;
  readonly #wall: () => number;
  readonly #sink: Pick<Console, 'log' | 'warn' | 'error'>;
  readonly #ringMax: number;
  readonly #repeatMs: number;
  readonly #ring: LogLine[] = [];
  #start = 0;
  readonly #repeats = new Map<string, Repeat>();
  /** lines folded into an earlier identical one */
  suppressed = 0;

  constructor(opts: CtxLogOptions = {}) {
    this.#tick = opts.tick ?? (() => 0);
    this.#wall = opts.wallClock ?? Date.now;
    this.#sink = opts.sink ?? console;
    this.#ringMax = Math.max(1, opts.ring ?? ENGINE.LOG_RING_LINES);
    this.#repeatMs = opts.repeatMs ?? ENGINE.LOG_REPEAT_MS;
  }

  /** the ring buffer, oldest first (a copy) */
  get lines(): LogLine[] {
    return [...this.#ring.slice(this.#start), ...this.#ring.slice(0, this.#start)];
  }

  write(level: LogLevel, script: string, message: unknown, data?: unknown): void {
    const text = typeof message === 'string' ? message : signature(message);
    const key = `${level}\u0000${script}\u0000${text}\u0000${signature(data)}`;
    const now = this.#wall();
    const rep = this.#repeats.get(key);
    if (rep !== undefined && now - rep.at < this.#repeatMs) {
      rep.suppressed++;
      rep.line.count++;
      this.suppressed++;
      return;
    }
    const more = rep !== undefined && rep.suppressed > 0 ? ` (${rep.suppressed} more since the last report)` : '';
    if (this.#repeats.size >= REPEAT_KEYS_MAX) {
      for (const [k, r] of this.#repeats) if (now - r.at >= this.#repeatMs) this.#repeats.delete(k);
      if (this.#repeats.size >= REPEAT_KEYS_MAX) this.#repeats.clear();
    }
    const line: LogLine = { level, script, message: text, ...(data !== undefined ? { data } : {}), tick: this.#tick(), count: 1 };
    this.#repeats.set(key, { at: now, suppressed: 0, line });
    if (this.#ring.length < this.#ringMax) this.#ring.push(line);
    else {
      this.#ring[this.#start] = line;
      this.#start = (this.#start + 1) % this.#ringMax;
    }
    const out = `[${script}] ${text}${more}`;
    if (data !== undefined) this.#sink[level](out, data);
    else this.#sink[level](out);
  }
}

// ── unavailable verbs (core §3.4) ────────────────────────────────────────────────────────────────────────────────────

export const UNAVAILABLE_VERBS = Object.freeze([
  'sql',
  'job',
  'awaitJob',
  'commit',
  'enterPlace',
  'attach',
  'changed',
  'transfer',
  'trade',
  'proposePurchase',
  'notifyDm',
  'getVibeAudio',
  'worldToScreen',
  'resolveControls',
] as const satisfies ReadonlyArray<keyof UnavailableVerbs>);

/** `<verb> is not available in this build`: an ordinary Error the game can catch (the trophy judge does, sync §5) */
export function unavailable(verb: string): (...args: unknown[]) => never {
  return () => {
    throw new Error(`${verb} is not available in this build`);
  };
}

// ── per kernel ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** the kernel as the ctx factories see it */
export type CtxKernel = CoreKernel;

export interface ScriptLog {
  log(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

const NO_PLACES = 'unknown-place';

export class CtxShared {
  readonly k: CtxKernel;
  readonly now: () => number;
  readonly random: () => number;
  readonly files: GameCtx['files'];
  readonly view: GameCtx['view'];
  readonly cancel: (timerId: string) => void;
  readonly getObjectSocket: GameCtx['getObjectSocket'];
  readonly unavailable: Readonly<UnavailableVerbs>;
  /** `ctx.world.state` over kernel.worldState */
  readonly worldBag: StateBag;
  readonly #worlds: Partial<Record<Realm, WorldHandleImpl>> = {};
  readonly #places: Record<Realm, Map<PlaceId, PlaceHandleImpl>> = { platform: new Map(), client: new Map(), ui: new Map() };
  /** per state object (a place runtime's, or the fallback's): its store */
  readonly #placeBags = new WeakMap<object, StateBag>();
  /** place state and atmosphere while the place manager is not wired (C4) */
  readonly #fallbackState = new Map<PlaceId, Record<string, unknown>>();
  readonly #fallbackAtmosphere = new Map<PlaceId, LayeredValueImpl>();
  readonly #logs = new Map<string, ScriptLog>();
  readonly #bags = new Set<StateBag>();
  #dirty = false;

  constructor(k: CtxKernel) {
    this.k = k;
    this.now = () => k.clock.now();
    this.random = () => k.rng();
    this.files = Object.freeze({
      read: (path: string): string | null => (typeof path === 'string' ? k.tree.readText(path) : null),
      write: unavailable('files.write'),
      delete: unavailable('files.delete'),
    });
    this.view = Object.freeze({
      get camera() {
        return k.ports.camera.presentedCamera();
      },
    });
    this.cancel = (timerId) => {
      k.time.timers.cancel(timerId);
    };
    this.getObjectSocket = (id, name) => k.ports.scene.socket(id, name);
    const verbs: Record<string, (...args: unknown[]) => never> = {};
    for (const v of UNAVAILABLE_VERBS) verbs[v] = unavailable(v);
    this.unavailable = Object.freeze(verbs) as unknown as Readonly<UnavailableVerbs>;
    this.worldBag = this.#bag(k.worldState, 'world.state');
  }

  /** dev warnings of the state stores and the handles (each distinct message once) */
  readonly warn = (message: string): void => {
    if (this.k.dev) this.k.lifecycle.warnOnce(message);
  };

  #bag(data: Record<string, unknown>, name: string): StateBag {
    const bag = new StateBag(data, {
      name,
      onWrite: () => {
        this.#dirty = true;
      },
      warn: this.warn,
    });
    this.#bags.add(bag);
    return bag;
  }

  /** the one world handle of a realm: `players` and every handle below it belong to that realm; the UI's is read-only */
  world(realm: Realm): WorldHandle {
    return (this.#worlds[realm] ??= new WorldHandleImpl(this, realm));
  }

  /** the handle of a place for a realm (cached; any id, also one that is not on the roster) */
  place(id: PlaceId, realm: Realm): PlaceHandle {
    const per = this.#places[realm];
    let h = per.get(id);
    if (h === undefined) per.set(id, (h = new PlaceHandleImpl(this, id, realm)));
    return h;
  }

  /** a roster place */
  onRoster(place: PlaceId): boolean {
    return Object.hasOwn(this.k.placeIndex.placeIndex, place);
  }

  /** `ctx.place.state`: the place runtime's store (kept when the place unloads), a kernel-side one while C4 is not wired */
  placeBag(place: PlaceId): StateBag {
    let data: Record<string, unknown> | undefined;
    const pm = placesOf(this.k);
    if (pm !== null && this.onRoster(place)) {
      try {
        data = pm.runtime(place).state;
      } catch {
        data = undefined;
      }
    }
    if (data === undefined) {
      data = this.#fallbackState.get(place);
      if (data === undefined) this.#fallbackState.set(place, (data = {}));
    }
    let bag = this.#placeBags.get(data);
    if (bag === undefined) this.#placeBags.set(data, (bag = this.#bag(data, `place.state of ${place}`)));
    return bag;
  }

  /** `ctx.place.atmosphere`: the place runtime's LayeredValue over the config, a kernel-side one while C4 is not wired */
  atmosphere(place: PlaceId): LayeredValue {
    const pm = placesOf(this.k);
    if (pm !== null && this.onRoster(place)) {
      try {
        return pm.runtime(place).atmosphere;
      } catch {
        // fall through to the config layer
      }
    }
    let lv = this.#fallbackAtmosphere.get(place);
    if (lv === undefined) {
      const k = this.k;
      lv = new LayeredValueImpl(() => k.placeIndex.placeIndex[place]?.atmosphere ?? {});
      this.#fallbackAtmosphere.set(place, lv);
    }
    return lv;
  }

  /** the log functions of one script path (shared by every ctx of that script) */
  logger(script: string): ScriptLog {
    let l = this.#logs.get(script);
    if (l === undefined) {
      const log = this.k.log;
      l = {
        log: (message, data) => log.write('log', script, message, data),
        warn: (message, data) => log.write('warn', script, message, data),
        error: (message, data) => log.write('error', script, message, data),
      };
      this.#logs.set(script, l);
    }
    return l;
  }

  /** tick end: a row-less store changed during the tick → the UI re-renders; dev builds also run the size watchdog */
  tickEnd(): void {
    if (this.#dirty) {
      this.#dirty = false;
      this.k.ports.ui.markDirty();
    }
    if (this.k.dev) {
      const now = Date.now();
      for (const bag of this.#bags) bag.checkSize(now);
    }
  }

  /** `ctx.cross`: the place manager's verdict; while it is not wired every place is unknown */
  cross(caller: CallerRef, entity: RowId | ObjectView, link: string): CrossResult {
    const pm = placesOf(this.k);
    if (pm === null) return { crossed: false, verdict: NO_PLACES };
    return pm.cross(caller, entity, link);
  }
}

// ── the behavior / sim / rig ctx ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The members of GameCtx every game realm has. Verbs are own properties (closures over the owner); `world`, `session`,
 * `files` and `view` are prototype getters. No `self`, no `wallNow`.
 */
export abstract class GameCtxBase implements UnavailableVerbs {
  readonly #shared: CtxShared;
  readonly #vm: VmId;

  declare now: () => number;
  declare random: () => number;
  declare log: ScriptLog['log'];
  declare warn: ScriptLog['warn'];
  declare error: ScriptLog['error'];
  declare getObject: (id: RowId) => ObjectView | null;
  declare query: GameCtx['query'];
  declare spawn: GameCtx['spawn'];
  declare destroy: GameCtx['destroy'];
  declare emit: GameCtx['emit'];
  declare on: GameCtx['on'];
  declare after: GameCtx['after'];
  declare cancel: GameCtx['cancel'];
  declare getTimers: GameCtx['getTimers'];
  declare cross: GameCtx['cross'];
  declare getObjectSocket: GameCtx['getObjectSocket'];
  declare sql: UnavailableVerbs['sql'];
  declare job: UnavailableVerbs['job'];
  declare awaitJob: UnavailableVerbs['awaitJob'];
  declare commit: UnavailableVerbs['commit'];
  declare enterPlace: UnavailableVerbs['enterPlace'];
  declare attach: UnavailableVerbs['attach'];
  declare changed: UnavailableVerbs['changed'];
  declare transfer: UnavailableVerbs['transfer'];
  declare trade: UnavailableVerbs['trade'];
  declare proposePurchase: UnavailableVerbs['proposePurchase'];
  declare notifyDm: UnavailableVerbs['notifyDm'];
  declare getVibeAudio: UnavailableVerbs['getVibeAudio'];
  declare worldToScreen: UnavailableVerbs['worldToScreen'];
  declare resolveControls: UnavailableVerbs['resolveControls'];

  /** `caller` is who the kernel verbs act for, `owner` who owns the listeners and timers made here (the same row or sim) */
  constructor(shared: CtxShared, caller: CallerRef & Viewer, owner: HookOwner, script: string, vmId: VmId) {
    this.#shared = shared;
    this.#vm = vmId;
    const k = shared.k;
    const vm = k.vms[vmId];
    const store = k.store;
    const timers = k.time.timers;
    const listeners = k.time.listeners;
    const logs = shared.logger(script);
    this.now = shared.now;
    this.random = shared.random;
    this.log = logs.log;
    this.warn = logs.warn;
    this.error = logs.error;
    this.getObject = (id) => {
      const h = getObject(k, caller, id);
      // a handle of a row of the other VM (core §10.4): counted on the reader's VM
      if (h !== null && store.get(id)?.vm !== vmId) vm.noteCrossVmRead();
      return h;
    };
    this.query = ((opts?: QueryOptions) => {
      const out = query(k, caller, opts);
      if (k.dev && out.length > 0 && typeof out[0] !== 'string') {
        let n = 0;
        for (const h of out) if (store.rowOf(h)?.vm !== vmId) n++;
        if (n > 0) vm.noteCrossVmRead(n);
      }
      return out;
    }) as GameCtx['query'];
    this.spawn = (a: string | ObjectSpec, b?: ObjectSpec) => spawnRow(k, caller, a, b);
    this.destroy = (id, opts) => destroyRows(k, caller, id, opts);
    this.emit = (name, payload, opts?: EmitOptions) => k.bus.emit(caller, name, payload, opts);
    this.on = (name, handler: EarHandler, opts) => listeners.on(owner, name, handler, opts ?? {});
    this.after = (seconds, hookExport, payload) =>
      timers.after(owner, owner.kind === 'row' ? owner.inst.module : owner.sim.module, k.clock.tick, seconds, hookExport, payload);
    this.cancel = shared.cancel;
    this.getTimers = (ownerId?: RowId): TimerInfo[] => timers.list(k.clock.tick, ownerId);
    this.cross = (entity, link) => shared.cross(caller, entity, link);
    this.getObjectSocket = shared.getObjectSocket;
    const u = shared.unavailable;
    this.sql = u.sql;
    this.job = u.job;
    this.awaitJob = u.awaitJob;
    this.commit = u.commit;
    this.enterPlace = u.enterPlace;
    this.attach = u.attach;
    this.changed = u.changed;
    this.transfer = u.transfer;
    this.trade = u.trade;
    this.proposePurchase = u.proposePurchase;
    this.notifyDm = u.notifyDm;
    this.getVibeAudio = u.getVibeAudio;
    this.worldToScreen = u.worldToScreen;
    this.resolveControls = u.resolveControls;
    installExtVerbs(this, k, owner, (m) => logs.error(m)); // opt-in sql / job verbs (ext.ts); a no-op by default
    // builtin/tween `animate(ctx, …)` finds the kernel's tween runner on the ctx (a symbol key: no game-visible member)
    attachTweenRunner(this, k.time.tweens);
  }

  /** the world handle of this ctx's VM */
  get world(): WorldHandle {
    return this.#shared.world(this.#vm);
  }

  /** the VM's session bag (core §10.3) */
  get session(): Record<string, any> {
    return this.#shared.k.vms[this.#vm].session;
  }

  get files(): GameCtx['files'] {
    return this.#shared.files;
  }

  get view(): GameCtx['view'] {
    return this.#shared.view;
  }
}

/** game modules are strict-mode code: a stray `ctx.session = …` on a getter-only member is ignored instead of throwing */
export function ignoreCtxWrites(...classes: Array<{ prototype: object }>): void {
  for (const c of classes) ignoreWrites(c.prototype, () => {});
}
ignoreCtxWrites(GameCtxBase);
