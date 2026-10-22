// The kernel: composition root of the compat runtime (docs/design/core-runtime.md §3.7; docs/architecture.md §3.0, §3.3).
//
// Skeleton (WP C0). createKernel() composes what exists today: the ports (missing ones get null implementations), the
// injected module registry, the options, the world state, the metrics, the KernelEvents subscriptions, sendAction forwarding
// (X-15), the room RNG and the engine rules. Every other member came with a later package, all of them wired now (a test
// kernel that hides one, e.g. `places`, still throws KernelNotWiredError naming its module); boot (boot/boot.ts, WP C6)
// drives the result:
//   clock               sched/clock.ts         C2 (wired)  store       store/rows.ts       C1a (wired)
//   bus, feed, acts     events/*.ts            C2 (wired)  places      places/manager.ts   C4 (wired)
//   advance, runTicks   sched/scheduler.ts     C2 (wired)  vms         vm/machine.ts       C5 (wired)
//   spawnHuman          lifecycle.ts           C1b (wired) stepRig     ctx/rig.ts          C5 (wired)
//   createUiCtx         ctx/ui.ts              C5 (wired)  setTicksPerFrame (test builds)  sched/scheduler.ts  C2 (wired)
// C5's pieces: the two VMs (`vms`), the ctx factories (`ctx`: the per-kernel shared half; lifecycle.ts gets the behavior /
// rig ctx factory here), the tree store behind `ctx.world.files` and `ctx.files.read` (`tree`), the ctx log (`log`) and the
// `world.settling` flag (`settling` = `booting`, which boot sets and clears, or a place load in flight).
// C2's pieces (clock, scheduler, bus, listeners, acts, feed, timers, hook invoker, tween runner) are `kernel.time`
// (sched/runtime.ts); later packages plug the tick into their modules with `kernel.time.use({...})`.
// Core modules take a `CoreKernel` (the public `Kernel` plus what core shares internally); other domains see `Kernel`.
import { DEFAULT_IDS, validateId, type KernelIds } from './ids.ts';
import type { KernelPorts } from './ports.ts';
import { withNullPorts } from './null-ports.ts';
import { resolveRules, type EngineRules } from './rules.ts';
import { resolveExtensions, type KernelExtensions, type ResolvedExtensions } from './ext.ts';
import { RowStoreImpl } from './store/rows.ts';
import { createKernelTime, type KernelTime } from './sched/runtime.ts';
import { createLifecycle, type Lifecycle } from './lifecycle.ts';
import { createPlaceManager, type PlaceManagerImpl } from './places/manager.ts';
import type { SimClockImpl } from './sched/clock.ts';
import type { EventBusImpl } from './events/bus.ts';
import type { ActRouterImpl } from './events/acts.ts';
import type { RowFeedImpl } from './events/feed.ts';
import { createVms, type VirtualMachineImpl } from './vm/machine.ts';
import { createTreeStore, type TreeStoreImpl } from './modules/tree.ts';
import type { AnimEntry } from './modules/registry.ts';
import { CtxLog, CtxShared, type CtxLogOptions } from './ctx/common.ts';
import { createBehaviorCtx } from './ctx/behavior.ts';
import { createRigCtx, stepRig } from './ctx/rig.ts';
import { createSimCtx } from './ctx/sim.ts';
import { createUiCtx } from './ctx/ui.ts';
import { placesOf } from './query.ts';
import type {
  CompiledPlaceIndex,
  InputState,
  Kernel,
  KernelEvents,
  KernelMetrics,
  ModuleRegistry,
  PlaceId,
  RowId,
  TreePath,
  UiCtx,
  Vec3,
  VmId,
  WorldConfig,
} from './types.ts';

/** core §3.7 */
export interface KernelOptions {
  worldId?: string | null | undefined;
  ids?: Partial<KernelIds> | undefined;
  residentPlaces?: ((worldState: Readonly<Record<string, unknown>>) => Iterable<PlaceId>) | undefined;
  /** the ctx.random() stream (one per room, contract §5.12): an integer in [0, 2^32); boot passes `env.seed ?? Date.now() >>> 0` */
  seed: number;
  /** core §15; missing ports get null implementations */
  ports: Partial<KernelPorts>;
  /** compiled world configuration */
  worldConfig: WorldConfig;
  /** compiled place roster (index + per-place chunk loaders) */
  places: CompiledPlaceIndex;
  registry: ModuleRegistry;
  /** carried file list: every carried file (`ctx.world.files`, the tree store behind `ctx.files.read`); default none */
  files?: readonly TreePath[] | undefined;
  /** where `ctx.log / warn / error` lines go and how they are rate-limited (default: the console, 1 per 5 s) */
  log?: CtxLogOptions | undefined;
  /** invariants, logging handle proxies, frozen specs */
  dev?: boolean | undefined;
  /** overrides of ENGINE_RULES for this kernel (tests of the inferred engine rules, core §17) */
  rules?: Partial<EngineRules> | undefined;
  /** optional engine extensions (core/ext.ts) */
  ext?: KernelExtensions | undefined;
}

/** what the core modules share beyond the public Kernel (other domains never see these) */
export interface CoreKernel extends Kernel {
  readonly worldId: string | null;
  readonly ids: Readonly<KernelIds>;
  readonly seed: number;
  readonly worldConfig: WorldConfig;
  readonly placeIndex: CompiledPlaceIndex;
  readonly rules: Readonly<EngineRules>;
  readonly ext?: Readonly<ResolvedExtensions>;
  readonly dev: boolean;
  /** the row store with its kernel-internal API: handles, channels, change list, invoker (WP C1a) */
  readonly store: RowStoreImpl;
  /** WP C2 (sched/runtime.ts): clock, scheduler, bus, listener registry, acts, feed, timers, hook invoker, tween runner */
  readonly time: KernelTime;
  readonly clock: SimClockImpl;
  readonly bus: EventBusImpl;
  readonly acts: ActRouterImpl;
  readonly feed: RowFeedImpl;
  /** WP C1b (lifecycle.ts): spawn, destroy, cascade, lifetimes, deferred hooks, body-less integration, triggers */
  readonly lifecycle: Lifecycle;
  /** WP C4 (places/manager.ts): the place manager with its kernel-internal API (scene state, sim ctx factory, log) */
  readonly places: PlaceManagerImpl;
  /** WP C5 (vm/machine.ts): the platform and the client VM with their session bags and cross-VM counters */
  readonly vms: Readonly<Record<VmId, VirtualMachineImpl>>;
  /** WP C5: the carried tree (`ctx.world.files`, `ctx.files.read`; the place loader adds raw cell texts, core §12.5) */
  readonly tree: TreeStoreImpl;
  /** WP C5 (ctx/common.ts): what every ctx of this kernel shares (world and place handles, the row-less state stores) */
  readonly ctx: CtxShared;
  /** WP C5: the `ctx.log / warn / error` ring buffer (the debug overlay reads `log.lines`) */
  readonly log: CtxLog;
  /** boot is in progress (core §14: boot sets it at its start and clears it at step 14); starts false */
  booting: boolean;
  /** `ctx.world.settling`: true while the kernel boots (`booting`) or a sim-side place load is in flight (core §11.5) */
  readonly settling: boolean;
  /** the room's ctx.random() stream: sfc32 seeded from KernelOptions.seed (core §7.1) */
  rng(): number;
  /** delivers a KernelEvents notification to the subscribers present when it starts, in subscription order; a subscriber that
   *  throws is reported and counted (metrics.listenerErrors) and the rest still run */
  notify<K extends keyof KernelEvents>(event: K, ...args: Parameters<KernelEvents[K]>): void;
}

/** a kernel member whose package has not landed yet */
export class KernelNotWiredError extends Error {
  override readonly name = 'KernelNotWiredError';
  readonly member: string;
  readonly module: string;
  readonly wp: string;
  constructor(member: string, module: string, wp: string) {
    super(`kernel.${member} is not wired yet: src/compat/core/${module} (WP ${wp})`);
    this.member = member;
    this.module = module;
    this.wp = wp;
  }
}

export function createKernelMetrics(): KernelMetrics {
  return {
    droppedTicks: 0,
    eventsDelivered: 0,
    eventsUndelivered: 0,
    drainCapHits: 0,
    actsFiltered: 0,
    actsUnhandled: 0,
    actsDoubleRegistered: 0,
    slowMoIgnored: 0,
    hookErrors: 0,
    spawnRefused: 0,
    duplicateSpawns: 0,
    listenerErrors: 0,
    tickMsEwma: 0,
    tickMsP95: 0,
  };
}

/**
 * The room RNG (contract §5.12: one seeded PRNG per room): sfc32 whose 128-bit state is expanded from the 32-bit seed with
 * splitmix32, then advanced 12 steps. Returns floats in [0, 1).
 */
export function createRoomRng(seed: number): () => number {
  let s = seed >>> 0;
  const splitmix32 = (): number => {
    s = (s + 0x9e3779b9) | 0;
    let t = s ^ (s >>> 16);
    t = Math.imul(t, 0x21f0aaad);
    t ^= t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    return (t ^ (t >>> 15)) >>> 0;
  };
  let a = splitmix32();
  let b = splitmix32();
  let c = splitmix32();
  let d = splitmix32();
  const sfc32 = (): number => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
  for (let i = 0; i < 12; i++) sfc32();
  return sfc32;
}

type Listener = (...args: never[]) => void;

/** test builds (vite `define`, build §3.1): the e2e timeScale hook kernel.setTicksPerFrame exists only there (D-CORE-16) */
const TEST_HOOKS = typeof __SS_TEST_HOOKS__ !== 'undefined' && __SS_TEST_HOOKS__ === true;

class KernelShell implements CoreKernel {
  readonly worldId: string | null;
  readonly ids: Readonly<KernelIds>;
  readonly seed: number;
  readonly worldConfig: WorldConfig;
  readonly placeIndex: CompiledPlaceIndex;
  readonly rules: Readonly<EngineRules>;
  readonly ext: Readonly<ResolvedExtensions>;
  readonly dev: boolean;
  readonly ports: KernelPorts;
  readonly registry: ModuleRegistry;
  /** ctx.world.state: room life = page life (core §5.7) */
  readonly worldState: Record<string, unknown> = {};
  readonly metrics: KernelMetrics = createKernelMetrics();
  /** the row store (WP C1a, store/rows.ts); it reads the port table at call time */
  readonly store: RowStoreImpl;
  /** WP C2: the clock (created paused with `boot`, core §14 step 3), the scheduler, the bus, … (sched/runtime.ts) */
  readonly time: KernelTime;
  /** WP C1b: spawn/destroy and the deferred hooks, installed on `time` (lifecycle.ts) */
  readonly lifecycle: Lifecycle;
  /** WP C4: residency, the sim-side load, cross, out of bounds; its step-E hook is installed on `time` (places/manager.ts) */
  readonly #places: PlaceManagerImpl;
  /** WP C5: the two VMs, the tree store, the ctx log and the shared half of every ctx */
  readonly vms: Readonly<Record<VmId, VirtualMachineImpl>>;
  readonly tree: TreeStoreImpl;
  readonly log: CtxLog;
  readonly ctx: CtxShared;
  booting = false;
  /** test builds only (D-CORE-16): set in the constructor when the build has its test hooks */
  declare setTicksPerFrame?: (n: 2 | 4 | 8) => void;
  /** per event: listener → its subscription token, in subscription order */
  readonly #listeners = new Map<keyof KernelEvents, Map<Listener, { readonly fn: Listener }>>();
  readonly #rng: () => number;

  constructor(opts: KernelOptions) {
    // the room RNG reads 32 bits, so any other value would silently collide with one of them
    if (!Number.isInteger(opts.seed) || opts.seed < 0 || opts.seed > 0xffffffff) {
      throw new TypeError(`createKernel: seed must be an integer in [0, 2^32), got ${String(opts.seed)}`);
    }
    this.worldId = opts.worldId ?? null;
    if (this.worldId !== null && typeof this.worldId !== 'string') throw new TypeError('createKernel: worldId must be a string or null');
    this.ids = Object.freeze({ ...DEFAULT_IDS, ...opts.ids });
    if (!validateId(this.ids.humanBody) || !validateId(this.ids.cameraRig) || this.ids.humanBody === this.ids.cameraRig) throw new TypeError('createKernel: body and camera ids must be distinct valid row ids');
    this.seed = opts.seed;
    this.worldConfig = opts.worldConfig;
    this.placeIndex = opts.places;
    this.registry = opts.registry;
    this.dev = opts.dev === true;
    this.rules = resolveRules(opts.rules);
    this.ext = resolveExtensions(opts.ext);
    this.ports = withNullPorts(opts.ports ?? {});
    this.store = new RowStoreImpl({ ports: this.ports, worldId: this.worldId, dev: this.dev, ...(this.ext.rowSession ? { rowSession: true } : {}) });
    this.#rng = createRoomRng(opts.seed);
    this.time = createKernelTime(this);
    this.lifecycle = createLifecycle(this);
    this.#places = createPlaceManager(this, { residentPlaces: opts.residentPlaces });
    // WP C5: VMs, tree, log, ctx factories. Cross-VM writes are counted on the writer's VM (core §10.4); the row-less state
    // stores mark the UI dirty at tick end.
    this.vms = createVms(this.ports);
    // the registry implementation also holds the loaded anim entries (`anim/<arch>.yml`, core §12.5)
    const reg = opts.registry as ModuleRegistry & { anim?: (path: TreePath) => AnimEntry | undefined };
    this.tree = createTreeStore({ files: opts.files ?? [], ...(typeof reg.anim === 'function' ? { anim: (path: TreePath) => reg.anim!(path) } : {}) });
    this.log = new CtxLog({ tick: () => this.time.clock.tick, ...(opts.log ?? {}) });
    this.ctx = new CtxShared(this);
    this.store.setCrossVmWriteHook((writer, _row, field) => this.vms[writer].noteCrossVmWrite(field));
    this.lifecycle.setCtxFactory((row, inst) => (row.rig !== null ? createRigCtx(this, row, inst) : createBehaviorCtx(this, row, inst)));
    this.on('tickEnd', () => this.ctx.tickEnd());
    // the place manager's C5 seams: place sims get their ctx, a power-grid place's raw cells land in the tree store
    this.#places.setSimCtxFactory((sim) => createSimCtx(this, sim));
    this.#places.setTreeStore(this.tree);
    if (TEST_HOOKS) this.setTicksPerFrame = (n) => this.time.scheduler.setTicksPerFrame(n);
  }

  /** a getter on the class, so a test kernel can shadow it with an own property (query.ts `placesOf`) */
  get places(): PlaceManagerImpl {
    return this.#places;
  }

  // ── wired here ─────────────────────────────────────────────────────────────────────────────────────────────────────
  /** X-09: the rig's onInput + update, once per rendered frame (ctx/rig.ts) */
  stepRig(dtS: number, input: InputState): { wrote: ReadonlySet<string>; deleted: ReadonlySet<string> } {
    return stepRig(this, dtS, input);
  }
  /** the UI realm ctx for one render call (ctx/ui.ts) */
  createUiCtx(): UiCtx {
    return createUiCtx(this);
  }
  /** `ctx.world.settling` (through `places`, so a test kernel that shadows it without a manager only reads `booting`) */
  get settling(): boolean {
    return this.booting || ((placesOf(this) as Partial<Pick<PlaceManagerImpl, 'loading'>> | null)?.loading ?? 0) > 0;
  }
  /** core §14 step 10: `player/local` on the client VM (lifecycle.ts) */
  spawnHuman(a: { place: PlaceId; at?: Vec3; yaw?: number; userId: string; displayName: string; durableState: object }): RowId {
    return this.lifecycle.spawnHuman(a);
  }
  get clock(): SimClockImpl {
    return this.time.clock;
  }
  get bus(): EventBusImpl {
    return this.time.bus;
  }
  get feed(): RowFeedImpl {
    return this.time.feed;
  }
  get acts(): ActRouterImpl {
    return this.time.acts;
  }
  /** per rendered frame: 0..2 ticks (core §9.7) */
  advance(realDtMs: number): { ticks: number; alpha: number } {
    return this.time.scheduler.advance(realDtMs);
  }
  /** headless: n ticks back to back; respects pause unless forced */
  runTicks(n: number, opts?: { force?: boolean }): void {
    this.time.scheduler.runTicks(n, opts);
  }

  /** X-15: the input port owns queueing and the declared-action filter; the kernel only forwards */
  sendAction(name: string, payload?: unknown, opts?: { down?: boolean; relockPointer?: boolean }): void {
    this.ports.input.injectAction(name, payload, opts);
  }

  rng(): number {
    return this.#rng();
  }

  /** subscribing the same function twice keeps one subscription; the returned unsubscribe is idempotent and ends only the
   *  subscription it was returned for (after an unsubscribe, a later `on` of the same function is a new subscription that the
   *  old unsubscribe leaves alone) */
  on<K extends keyof KernelEvents>(event: K, fn: KernelEvents[K]): () => void {
    let subs = this.#listeners.get(event);
    if (!subs) {
      subs = new Map();
      this.#listeners.set(event, subs);
    }
    const listener = fn as unknown as Listener;
    let sub = subs.get(listener);
    if (!sub) {
      sub = { fn: listener };
      subs.set(listener, sub);
    }
    const mine = sub;
    return () => {
      const current = this.#listeners.get(event);
      if (current?.get(listener) === mine) current.delete(listener);
    };
  }

  notify<K extends keyof KernelEvents>(event: K, ...args: Parameters<KernelEvents[K]>): void {
    const subs = this.#listeners.get(event);
    if (!subs || subs.size === 0) return;
    for (const fn of [...subs.keys()]) {
      try {
        (fn as unknown as (...a: Parameters<KernelEvents[K]>) => void)(...args);
      } catch (err) {
        this.metrics.listenerErrors++;
        console.error(`[kernel] a ${event} subscriber threw`, err);
      }
    }
  }
}

/** a kernel with no rows and no places; boot (core §14, WP C6) drives it */
export function createKernel(opts: KernelOptions): CoreKernel {
  return new KernelShell(opts);
}
