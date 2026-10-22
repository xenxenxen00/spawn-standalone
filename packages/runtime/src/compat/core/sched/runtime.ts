// The time-and-events runtime of one kernel (WP C2): the clock, the scheduler, the event bus with its listener registry, the
// act router, the row feed, the timer queue, the hook invoker and the tween runner, created together and wired to each other
// and to the kernel (docs/design/core-runtime.md §8-§9, §15.2, §15.6; docs/architecture.md X-12, X-14, §4.1).
//
// `kernel.time` is this object. What the tick acts on (rows, the deferred hooks, places, lifetimes, the human) sits behind
// RuntimeHooks. Each hook has a default that uses whatever the kernel has wired (kernel.store, kernel.places; a member that
// is not wired yet throws KernelNotWiredError and the default falls back to "nothing"), and the packages that own the real
// thing install it with `kernel.time.use({...})`:
//   C1b  flushDeferred (onSpawn then onDestroy queues), expireLifetimes, afterPhysics (body-less integration, triggers)
//   C4   isSimulated, simulatedPlaces, isResident, sims (place sims), afterPhysics (out of bounds)
//   C6   setRootSim(sim.js); endOfTick or a store observer for the durable save
// With the row store (C1a) the defaults already: read the human, the update rows and world feet (store/transform.ts
// worldPose: parents, attachments) from it; point its invoker source at the
// hook invoker (the writer of a write is the running hook, 'engine' outside one); observe every effective write to wake
// sleepers (sched/sleep.ts wakeForWrite) and feed the row feed (`changed`); roll prev/cur transforms at step A (beginTick);
// drain the tick's change list at step H and mark the UI dirty when it held anything.
// The kernel feeds the row feed from KernelEvents (rowSpawned → added; rowDestroyed → removed) and cleans a disposed row's
// listeners, timers, tweens and attached fx there, by record (an id may already belong to a new row by then).
import type { CoreKernel } from '../kernel.ts';
import type { PlaceId, PlaceManager, RowId, RowRec, SimInstance, Vec3 } from '../types.ts';
import { worldPose } from '../store/transform.ts';
import { HookInvoker } from '../behaviors/invoke.ts';
import { bindPlatformPause } from '../pause.ts';
import { extOf } from '../ext.ts';
import { achievementsTap, mirrorAfterInit } from '../achievements.ts';
import { ActRouterImpl, type HumanView } from '../events/acts.ts';
import { EventBusImpl } from '../events/bus.ts';
import { RowFeedImpl } from '../events/feed.ts';
import { ListenerRegistry } from '../events/listeners.ts';
import { TweenRunner } from '../../builtin/tween.ts';
import { SimClockImpl } from './clock.ts';
import { SlowMoClock } from './slowmo.ts';
import { Scheduler, type TickHost } from './scheduler.ts';
import { wakeForWrite } from './sleep.ts';
import { TimerQueue } from './timers.ts';

/** what the tick and the bus read from the rest of the kernel (defaults: see the header) */
export interface RuntimeHooks extends TickHost {
  /** the human, for the act filter and the player audience */
  human(): HumanView | null;
  /** a row's world feet (nearby audiences) */
  feetOf(row: RowRec): Vec3 | null;
  /** whether a place stands (active, dormant or loading) */
  isResident(place: PlaceId): boolean;
  /** whether a row id is alive; null when unknown */
  rowExists(id: RowId): boolean | null;
}

export interface KernelTime {
  readonly clock: SimClockImpl;
  /** ext.slowMo: the running slow-motion effect (`scale` is what presentation clocks multiply by); null without the option */
  readonly slowMo: SlowMoClock | null;
  readonly scheduler: Scheduler;
  readonly bus: EventBusImpl;
  readonly listeners: ListenerRegistry;
  readonly acts: ActRouterImpl;
  readonly feed: RowFeedImpl;
  readonly timers: TimerQueue;
  readonly invoker: HookInvoker;
  readonly tweens: TweenRunner;
  /** the root sim (`sim.js`, core §14 step 6): ticks first in step F */
  readonly rootSim: SimInstance | null;
  setRootSim(sim: SimInstance | null): void;
  /** installs host functions over the defaults; the latest install of a hook runs; the returned undo removes this install's
   *  functions (whatever was installed since), so undoing in any order ends on the defaults; an undefined entry is skipped */
  use(hooks: RuntimeHookOverrides): () => void;
}

/** a partial set of hooks for `kernel.time.use` */
export type RuntimeHookOverrides = { readonly [K in keyof RuntimeHooks]?: RuntimeHooks[K] | undefined };

/** the kernel members the runtime reads; `store` and `places` may still throw KernelNotWiredError */
export type TimeKernel = Pick<CoreKernel, 'ids' | 'ports' | 'metrics' | 'rules' | 'worldConfig' | 'store' | 'places' | 'notify' | 'on' | 'ext'>;

/** the member, or null while its package has not wired it (KernelNotWiredError) */
function wired<T>(get: () => T): T | null {
  try {
    return get();
  } catch (err) {
    if (err instanceof Error && err.name === 'KernelNotWiredError') return null;
    throw err;
  }
}

/** the rows of a list that carry at least one behavior, in list order */
function withBehaviors(rows: Iterable<RowRec>): RowRec[] {
  const out: RowRec[] = [];
  for (const r of rows) if (r.behaviors.length > 0) out.push(r);
  return out;
}

/** two serial-ordered row lists as one (sorted if a list turns out not to be) */
function mergeBySerial(a: Iterable<RowRec>, b: Iterable<RowRec>): RowRec[] {
  const x = Array.from(a);
  const y = Array.from(b);
  const sorted = (l: RowRec[]): boolean => {
    for (let i = 1; i < l.length; i++) if (!(l[i - 1]!.serial < l[i]!.serial)) return false;
    return true;
  };
  // one side empty (the client VM holds no row before the human spawns): the other, in serial order, is the whole merge
  if (y.length === 0 && sorted(x)) return x;
  if (x.length === 0 && sorted(y)) return y;
  if (!sorted(x) || !sorted(y)) return [...x, ...y].sort((p, q) => p.serial - q.serial);
  const out: RowRec[] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (j >= y.length || (i < x.length && x[i]!.serial < y[j]!.serial)) out.push(x[i++]!);
    else out.push(y[j++]!);
  }
  return out;
}

export function createKernelTime(k: TimeKernel): KernelTime {
  const store = (): TimeKernel['store'] | null => wired(() => k.store);
  const places = (): PlaceManager | null => wired(() => k.places);
  /** world feet: the store's pose chain (parents, attachments) when the store is wired, else the row's own feet */
  const feetOf = (row: RowRec): Vec3 => {
    const s = store();
    return s ? worldPose(s, row).pos : row.tf.pos;
  };
  let rootSim: SimInstance | null = null;
  /** the rows with behaviors, in serial order, for one membership generation of one store (`updateRows`) */
  let updateCache: { store: object; gen: number; rows: readonly RowRec[] } | null = null;

  const hooks: RuntimeHooks = {
    tickStart: () => {
      store()?.beginTick();
    },
    inputBody: () => {
      const b = store()?.get(k.ids.humanBody);
      return b && b.phase === 'alive' && !b.pendingSpawnHooks ? b : null;
    },
    updateRows: () => {
      const s = store();
      if (!s) return [];
      // Only rows with behaviors can update. A row's behaviors are bound once, inside its own spawn (lifecycle.ts), so the
      // list of such rows changes only when a row is inserted or detached: it is rebuilt when the store's membership
      // generation moved, and the scheduler takes its own snapshot of it. A store without the generation (a test double)
      // gets the filtered list built every call. Most rows of a place have no behavior (~97 % on the bench maps).
      const gen = (s as { readonly membership?: unknown }).membership;
      if (typeof gen === 'number' && updateCache !== null && updateCache.store === s && updateCache.gen === gen) return updateCache.rows;
      const rows = mergeBySerial(withBehaviors(s.inVm('platform')), withBehaviors(s.inVm('client')));
      updateCache = typeof gen === 'number' ? { store: s, gen, rows } : null;
      return rows;
    },
    isSimulated: (p) => places()?.isSimulated(p) ?? true,
    simulatedPlaces: () => {
      const pm = places();
      const active = pm?.active ?? null;
      return pm && active !== null && pm.isSimulated(active) ? [active] : [];
    },
    afterPhysics: () => {},
    sims: () => {
      const out: SimInstance[] = rootSim ? [rootSim] : [];
      const pm = places();
      const active = pm?.active ?? null;
      if (pm && active !== null) {
        const sim = wired(() => pm.runtime(active).sim);
        if (sim) out.push(sim);
      }
      return out;
    },
    expireLifetimes: () => {},
    flushDeferred: () => 0,
    endOfTick: () => {
      const s = store();
      // dev builds (core §5.3): judge this tick's watched assignments (and empty the watch) at tick end
      if (s?.dev) s.checkLostWrites();
      const changes = s?.takeChanges();
      if (changes && changes.length > 0) k.ports.ui.markDirty();
    },
    human: () => {
      const b = store()?.get(k.ids.humanBody);
      if (!b) return null;
      return { playerId: b.player?.userId ?? null, bodyId: b.id, place: b.place, feet: feetOf(b) };
    },
    feetOf,
    isResident: (p) => {
      const pm = places();
      return pm ? pm.residency(p) !== 'absent' : true;
    },
    rowExists: (id) => store()?.has(id) ?? null,
  };

  // `use` layers: per hook, the installed functions in install order; the last one runs, an undo removes its own layer
  interface Layer {
    readonly fn: unknown;
  }
  const defaults: Readonly<RuntimeHooks> = { ...hooks };
  const layers = new Map<keyof RuntimeHooks, Layer[]>();
  const refresh = (key: keyof RuntimeHooks): void => {
    const stack = layers.get(key);
    (hooks as unknown as Record<string, unknown>)[key] = stack && stack.length > 0 ? stack[stack.length - 1]!.fn : defaults[key];
  };

  const warn = (m: string): void => console.warn(m);
  const clock = new SimClockImpl(['boot']); // core §14 step 3: the kernel is created paused with `boot`
  const invoker = new HookInvoker({ metrics: k.metrics, tick: () => clock.tick });
  const listeners = new ListenerRegistry();
  const tap = achievementsTap(k); // ext.achievements: `milestone` / `stat` -> the port; undefined without it
  const slow = extOf(k).slowMo ? new SlowMoClock() : undefined; // ext.slowMo: the `slowMo` act scales the frame accumulator
  const acts = new ActRouterImpl({ metrics: k.metrics, human: () => hooks.human(), defaultPlace: () => k.worldConfig.defaultPlace, warn, tap, slowMo: slow && ((p) => void slow.apply(p)), extraActs: extOf(k).extraActs });
  const bus = new EventBusImpl({
    metrics: k.metrics,
    listeners,
    acts,
    invoker,
    rules: () => k.rules,
    defaultPlace: () => k.worldConfig.defaultPlace,
    tick: () => clock.tick,
    human: () => hooks.human(),
    feetOf: (row) => hooks.feetOf(row),
    isResident: (p) => hooks.isResident(p),
    rowExists: (id) => hooks.rowExists(id),
    warn,
    tap,
  });
  const feed = new RowFeedImpl();
  const timers = new TimerQueue();
  const tweens = new TweenRunner({ warn });
  const scheduler = new Scheduler({
    clock,
    bus,
    timers,
    invoker,
    tweens,
    ports: k.ports,
    metrics: k.metrics,
    host: hooks,
    timeScale: slow,
    tickEnd: (t) => k.notify('tickEnd', t),
    warn,
  });

  clock.onChange((running, reasons) => {
    if (running) {
      // core §9.1: no catch-up burst, and edges captured while paused are not delivered
      scheduler.resetAccumulator();
      k.ports.input.discardEdges();
    }
    k.notify('paused', !running, reasons);
  });
  bindPlatformPause(k, clock); // ext.pauseFreezesClock: platform / ad pause events hold the clock
  const s = store();
  if (s) {
    s.setInvokerSource(() => invoker.current);
    s.observe((c) => {
      wakeForWrite(c.row, c.invoker);
      feed.changed(c.row, c.field);
    });
  }
  k.on('rowSpawned', (row) => {
    feed.added(row);
    acts.rowSpawned(row);
    if (tap && row.id === k.ids.humanBody) mirrorAfterInit(k);
  });
  k.on('rowDestroyed', (row) => {
    feed.removed(row);
    listeners.removeRow(row);
    timers.dropRow(row);
    tweens.stopHandles(Object.values(row.handles));
    acts.rowGone(row); // by record: a new row that already reuses the id keeps its fx
  });

  return {
    clock,
    slowMo: slow ?? null,
    scheduler,
    bus,
    listeners,
    acts,
    feed,
    timers,
    invoker,
    tweens,
    get rootSim() {
      return rootSim;
    },
    setRootSim(sim) {
      rootSim = sim;
    },
    use(partial) {
      const keys = Object.keys(partial) as Array<keyof RuntimeHooks>;
      for (const key of keys) {
        const fn = partial[key];
        if (fn !== undefined && typeof fn !== 'function') throw new TypeError(`kernel.time.use: ${key} must be a function`);
        if (!(key in defaults)) throw new TypeError(`kernel.time.use: ${key} is not a runtime hook`);
      }
      const mine: Array<[keyof RuntimeHooks, Layer]> = [];
      for (const key of keys) {
        const fn = partial[key];
        if (fn === undefined) continue;
        const layer: Layer = { fn };
        let stack = layers.get(key);
        if (!stack) {
          stack = [];
          layers.set(key, stack);
        }
        stack.push(layer);
        mine.push([key, layer]);
        refresh(key);
      }
      return () => {
        for (const [key, layer] of mine) {
          const stack = layers.get(key);
          const i = stack ? stack.indexOf(layer) : -1;
          if (i < 0) continue;
          stack!.splice(i, 1);
          refresh(key);
        }
      };
    },
  };
}
