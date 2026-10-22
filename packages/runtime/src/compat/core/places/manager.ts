// The place manager (docs/design/core-runtime.md §11.3-11.7; docs/architecture.md §5.4, X-05, X-32; WP C4): residency, the
// sim-side load, the render build, activation, unload, `ctx.cross` and the out-of-bounds rule.
//
// Residency (core §11.3). One place is ACTIVE: it holds the human body, its rows update, its physics steps, its sim ticks and
// it is rendered. A place whose scene is loaded but that is not active, or that holds rows without a scene (the Director spawned
// into it before it loaded: "dormant without a scene"), is DORMANT: its rows answer `query({place})` and hear `to` and
// `audience: all` events, and nothing of it updates. LOADING lasts for a sim-side load; ABSENT is everything else. A kernel
// built without a roster manages no places: there every place stands and is simulated.
//
// The load has two halves (X-05):
// - sim-side, `load(p)`: the place chunk, the preload set `place:<p>` and the PlaceBake in parallel; then the place sim is bound,
//   `ports.physics.buildPlace(p, bake)` (the port stores it until Rapier is up, X-32), and the scene batch is spawned
//   (scene-loader.ts). `world.settling` is true meanwhile and `KernelEvents.placeLoading` reports 0..1. A second `load(p)` joins
//   the first; a resident place resolves at once.
// - render, in the background: `ports.scene.buildPlace(p, rows, bake, onProgress)` starts after the batch; `built(p)` is its
//   promise (rejecting with the port's error; asking again after a failure builds again) and `KernelEvents.placeBuilt` fires when
//   it resolves. The simulation never waits for it; the LOADING gate does (docs/architecture.md §5.3).
//
// Crossing (core §11.6), `cross(caller, entity, link)`; it never throws:
//   `+<place>[#gate]`, place not in the roster      { crossed: false, verdict: 'unknown-place' }, logged once per place
//   `world:<id>/room:<name>`                        { crossed: false, verdict: 'rooms-unavailable' }
//   any other link                                  { crossed: false, verdict: 'bad-link' }
//   a missing or dead row / a child row             { crossed: false, verdict: 'no-such-object' / 'child-row' }
//   the row's own place                             { crossed: true, placeId }, not moved
//   a place whose scene is loaded                   the row and its followers move now; the human's move makes it active
//   any other place, the human body                 { crossed: 'departing', link }: the clock pauses with `loading` at the end
//                                                   of the tick, the place loads, then the body and its followers move, the
//                                                   place becomes active, the place left is unloaded or demoted, `loading`
//                                                   resumes and 15 hidden ticks run; asking again meanwhile departs again
//   any other place, another row                    the row moves into that place's dormant records at once
// A moved row lands at the target's spawn point (or at the gate row of `#gate` when it stands there) with zero velocity, facing
// `defaultSpawnRotation` when the place sets one. Followers: its children (always), the camera rig that targets it, and the
// top-level rows of the place it left whose creator chain (spawner, else parent) reaches it without passing a row whose spec
// named a `place`; they keep their offset to it. Rows with an explicit `place` stay, and go with their place. Edges are not
// touched.
//
// Leaving a place: it is unloaded (every row but a player body or the rig destroyed, onDestroy run per
// ENGINE_RULES.runOnDestroyOnUnload, port resources disposed) unless the host residency hook names it.
// Retained places keep their rows and bake, disposing physics and render resources until reactivated.
//
// What the ports see beyond their own verbs' obvious use:
// - physics: after a row changes place the port hears `setPosition(row, pos)` for it and for every body in its subtree, with
//   `row.place` already the new place; when a demoted place is built again, `rowSpawned(row)` is repeated for the rows that
//   stayed in it; outside a tick an unload disposes the rows before `disposePlace`, inside a tick `rowDestroyed` of its rows
//   arrives at the next phase boundary, after `disposePlace`.
// - render: a row that changes place is reported to the row feed as a change of field `place`.
import type { CoreKernel } from '../kernel.ts';
import { asSimModule } from '../modules/registry.ts';
import { extOf, simEveryTicks } from '../ext.ts';
import type { PlaceBake } from '../ports.ts';
import { ENGINE } from '../rules.ts';
import { hasBody, type DestroyHow } from '../lifecycle.ts';
import { copyVec3, isCameraAttached, worldPose, writeAngularVelocity, writeFeetPosition, writeRotation, writeVelocity } from '../store/transform.ts';
import type {
  CallerRef,
  CrossResult,
  ObjectView,
  PlaceId,
  PlaceManager,
  PlaceRuntime,
  Residency,
  RowId,
  RowRec,
  SimCtx,
  SimInstance,
  TreeStore,
  Vec3,
} from '../types.ts';
import { WorldBounds } from './bounds.ts';
import { PlaceRegistry, type PlaceEntry, type PlaceLoad } from './registry.ts';
import { asPlaceBundle, spawnScene } from './scene-loader.ts';

/** the cause a place unload records for every row it removes (lifecycle.ts GoneRing) */
const PLACE_UNLOAD: DestroyHow = Object.freeze({ cause: 'place unload', by: 'place unload' });

/** the kernel members the place manager uses */
export type PlacesKernel = Pick<
  CoreKernel,
  'store' | 'registry' | 'time' | 'clock' | 'rules' | 'ports' | 'placeIndex' | 'worldState' | 'notify' | 'on' | 'lifecycle'
>;

export interface PlaceLog {
  warn(message: string): void;
  error(message: string): void;
}

/** the human on its way to a place that is loading */
interface Departure {
  readonly target: PlaceId;
  readonly bodyId: RowId;
  gate: string | null;
  readonly token: number;
}

type Link = { place: PlaceId; gate: string | null } | { verdict: string };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const zero = (): Vec3 => ({ x: 0, y: 0, z: 0 });
const clamp01 = (f: number): number => (Number.isFinite(f) ? Math.min(1, Math.max(0, f)) : 0);
/** share of the load's progress given to the three parallel fetches; the rest is the build and the scene batch */
const FETCH_SHARE = 0.9;
const CHAIN_MAX = 64;
const WARNED_MAX = 1024;

/** `+<place>` / `+<place>#<gate>` / `world:<id>/room:<name>` (contract §5.5) */
function parseLink(link: unknown): Link {
  if (typeof link !== 'string') return { verdict: 'bad-link' };
  if (link.startsWith('world:')) return { verdict: 'rooms-unavailable' };
  if (!link.startsWith('+')) return { verdict: 'bad-link' };
  const hash = link.indexOf('#');
  const place = hash < 0 ? link.slice(1) : link.slice(1, hash);
  if (place === '') return { verdict: 'bad-link' };
  const gate = hash < 0 ? '' : link.slice(hash + 1);
  return { place, gate: gate === '' ? null : gate };
}

export interface PlaceManagerOptions {
  residentPlaces?: ((worldState: Readonly<Record<string, unknown>>) => Iterable<PlaceId>) | undefined;
}

export class PlaceManagerImpl implements PlaceManager {
  readonly #residentPlaces: NonNullable<PlaceManagerOptions['residentPlaces']>;
  /** the roster and the per-place records */
  readonly roster: PlaceRegistry;
  /** the out-of-bounds rule (core §11.7) */
  readonly bounds: WorldBounds;
  /** core §11.3 */
  readonly runtime: (p: PlaceId) => PlaceRuntime;

  readonly #k: PlacesKernel;
  #active: PlaceId | null = null;
  /** sim-side loads in flight */
  #loads = 0;
  #log: PlaceLog = { warn: (m) => console.warn(`[places] ${m}`), error: (m) => console.error(`[places] ${m}`) };
  readonly #warned = new Set<string>();
  #departure: Departure | null = null;
  #token = 0;
  /** this manager holds the `loading` pause reason */
  #loadingPause = false;
  /** the pause was given back before it landed (see #resumeLoading) */
  #undoDeferredPause = false;
  /** places left inside a tick, retired at its end */
  #retiring: PlaceId[] = [];
  #simCtx: ((sim: SimInstance) => SimCtx | null) | null = null;
  #tree: Pick<TreeStore, 'addTexts'> | null = null;
  readonly #undo: Array<() => void> = [];

  constructor(k: PlacesKernel, opts: PlaceManagerOptions = {}) {
    this.#residentPlaces = opts.residentPlaces ?? (() => []);
    this.#k = k;
    this.roster = new PlaceRegistry(k.placeIndex, (p, x, z) => k.ports.physics.groundY(p, x, z));
    this.runtime = (p) => this.roster.runtime(p);
    this.bounds = new WorldBounds(k, this, (m) => this.#warnOnce(m, m));
    // tick step E: the lifecycle's work (body-less integration, triggers), then the out-of-bounds rule
    this.#undo.push(
      k.time.use({
        afterPhysics: (tick) => {
          k.lifecycle.afterPhysics(tick);
          this.bounds.run();
        },
      }),
    );
    this.#undo.push(k.on('tickEnd', () => this.#tickEnd()));
  }

  // ── wiring (boot, C5, tests) ───────────────────────────────────────────────────────────────────────────────────────

  /** where the manager's warnings and errors go (default: the console) */
  setLog(log: PlaceLog): void {
    this.#log = log;
  }

  /** the ctx of a place sim (ctx/sim.ts, C5); sims bound before it was installed get theirs now */
  setSimCtxFactory(f: ((sim: SimInstance) => SimCtx | null) | null): void {
    this.#simCtx = f;
    if (f === null) return;
    for (const rt of this.roster.runtimes()) if (rt.sim !== null && rt.sim.ctx === null) rt.sim.ctx = f(rt.sim);
  }

  /** the tree store that takes a power-grid place's raw cells at its load (`ctx.files.read`, core §12.5; the kernel installs its own) */
  setTreeStore(tree: Pick<TreeStore, 'addTexts'> | null): void {
    this.#tree = tree;
  }

  /** removes the manager's tick hooks and subscriptions */
  dispose(): void {
    for (const off of this.#undo.splice(0)) off();
    this.bounds.dispose();
  }

  // ── residency ──────────────────────────────────────────────────────────────────────────────────────────────────────

  get active(): PlaceId | null {
    return this.#active;
  }

  /** sim-side loads in flight (`world.settling` is true while this is not 0) */
  get loading(): number {
    return this.#loads;
  }

  residency(p: PlaceId): Residency {
    if (!this.roster.managed || p === this.#active) return 'active';
    const e = this.roster.peek(p);
    if (e?.scene === 'loading') return 'loading';
    if (e?.scene === 'loaded') return 'dormant';
    return this.#k.store.byPlace(p).size > 0 ? 'dormant' : 'absent';
  }

  isSimulated(p: PlaceId): boolean {
    return !this.roster.managed || p === this.#active;
  }

  /** the place's scene rows are spawned (a dormant place can hold rows without them) */
  sceneLoaded(p: PlaceId): boolean {
    return this.roster.peek(p)?.scene === 'loaded';
  }

  spawnPoint(p: PlaceId): Vec3 {
    return this.roster.spawnPoint(p);
  }

  bottom(p: PlaceId): number {
    return this.roster.bottom(p);
  }

  /** the scene rows of the place's last load that the kernel refused to spawn */
  refusedRows(p: PlaceId): ReadonlyArray<{ id: RowId; error: string }> {
    return this.roster.peek(p)?.refused ?? [];
  }

  // ── the sim-side load ──────────────────────────────────────────────────────────────────────────────────────────────

  load(p: PlaceId, onProgress?: (f: number) => void): Promise<void> {
    const e = this.roster.entry(p);
    if (e === null) return Promise.reject(new Error(`places.load: unknown place "${p}"`));
    if (e.scene === 'loaded') {
      onProgress?.(1);
      return Promise.resolve();
    }
    if (e.load !== null) {
      if (onProgress) {
        e.load.listeners.push(onProgress);
        if (e.load.progress >= 0) onProgress(e.load.progress);
      }
      return e.load.promise;
    }
    const load: PlaceLoad = { promise: Promise.resolve(), progress: -1, listeners: onProgress ? [onProgress] : [], cancelled: false };
    e.load = load;
    e.scene = 'loading';
    this.#loads++;
    load.promise = this.#runLoad(e, load).then(
      () => {
        e.load = null;
        this.#loads--;
      },
      (err: unknown) => {
        if (e.load === load) {
          e.load = null;
          e.scene = 'none';
        }
        this.#loads--;
        throw err;
      },
    );
    this.#progress(e, load, 0);
    return load.promise;
  }

  #progress(e: PlaceEntry, load: PlaceLoad, f: number): void {
    const v = clamp01(f);
    if (v <= load.progress) return;
    load.progress = v;
    this.#k.notify('placeLoading', e.id, v);
    for (const fn of [...load.listeners]) {
      try {
        fn(v);
      } catch (err) {
        this.#log.error(`a load progress listener of ${e.id} threw: ${msg(err)}`);
      }
    }
  }

  async #runLoad(e: PlaceEntry, load: PlaceLoad): Promise<void> {
    const k = this.#k;
    const p = e.id;
    const loader = this.roster.loader(p);
    if (loader === null) throw new Error(`places.load: no chunk loader for "${p}"`);
    const part = [0, 0, 0];
    const step = (i: number, f: number): void => {
      part[i] = Math.max(part[i]!, clamp01(f));
      this.#progress(e, load, (FETCH_SHARE * (part[0]! + part[1]! + part[2]!)) / 3);
    };
    const done = <T>(i: number, pr: Promise<T>): Promise<T> =>
      pr.then((v) => {
        step(i, 1);
        return v;
      });
    const [chunk, , bake] = await Promise.all([
      done(0, Promise.resolve(loader())),
      done(1, k.registry.ensure(e.config.modules, (f) => step(1, f))),
      done(2, k.ports.assets.placeBake(p)),
    ]);
    if (load.cancelled) throw new Error(`places.load: "${p}" was unloaded while it loaded`);
    const bundle = asPlaceBundle(chunk, p);
    if (bundle.rawCells && this.#tree) {
      // ctx.files.read of the power-grid places (core §12.5); a tree that does not carry the cells is reported, not fatal
      try {
        this.#tree.addTexts(bundle.rawCells);
      } catch (err) {
        this.#log.error(`${p}: its raw cells were not added to the tree store: ${msg(err)}`);
      }
    }
    await this.#bindSim(e, bundle.sim);
    if (load.cancelled) throw new Error(`places.load: "${p}" was unloaded while it loaded`);

    k.ports.physics.buildPlace(p, bake);
    e.bake = bake;
    e.portsBuilt = true;
    const result = spawnScene(k, bundle);
    e.refused = result.refused;
    for (const r of result.refused) this.#log.error(`${p}: scene row ${r.id} was not spawned: ${r.error}`);
    e.scene = 'loaded';
    this.#startBuild(e, bake);
    this.#progress(e, load, 1);
  }

  /** core §11.4: the place sim, from the registry (its path is in the preload set `place:<p>`) or the chunk's own loader */
  async #bindSim(e: PlaceEntry, fromChunk: (() => Promise<unknown>) | undefined): Promise<void> {
    const path = e.config.sim;
    if (path === null) return;
    const rt = this.roster.runtime(e.id);
    if (rt.sim !== null && rt.sim.module !== null) return;
    let ns: unknown = this.#k.registry.get(path);
    if (ns === undefined && fromChunk) ns = await fromChunk();
    if (!isObj(ns)) throw new Error(`places.load: the sim ${path} is not loaded (it is not in the preload set ${e.config.modules})`);
    const any = extOf(this.#k).simCadence === 'any';
    const module = asSimModule(ns, path, { anyCadence: any });
    const sim: SimInstance = rt.sim ?? { id: `sim:${e.id}`, place: e.id, path, module: null, ctx: null, health: new Map() };
    sim.module = module;
    if (any) sim.everyTicks = simEveryTicks(module);
    if (sim.ctx === null && this.#simCtx) sim.ctx = this.#simCtx(sim);
    rt.sim = sim;
  }

  // ── the render build ───────────────────────────────────────────────────────────────────────────────────────────────

  #startBuild(e: PlaceEntry, bake: PlaceBake): void {
    const k = this.#k;
    const p = e.id;
    const gen = ++e.buildGen;
    e.built = false;
    e.buildFailed = false;
    e.buildProgress = 0;
    let run: Promise<void>;
    try {
      run = Promise.resolve(
        k.ports.scene.buildPlace(p, [...k.store.byPlace(p)], bake, (f) => {
          if (e.buildGen === gen) e.buildProgress = Math.max(e.buildProgress, clamp01(f));
        }),
      );
    } catch (err) {
      run = Promise.reject(err);
    }
    const build = run.then(
      () => {
        if (e.buildGen !== gen) throw new Error(`places.built(${p}): the place was unloaded during its render build`);
        e.built = true;
        e.buildProgress = 1;
        k.notify('placeBuilt', p);
      },
      (err: unknown) => {
        if (e.buildGen === gen) e.buildFailed = true;
        throw err;
      },
    );
    // the failure is surfaced by built(); nobody may be asking yet
    build.catch(() => {});
    e.build = build;
  }

  built(p: PlaceId): Promise<void> {
    const e = this.roster.peek(p);
    if (e && e.scene === 'loading' && e.load !== null) return e.load.promise.then(() => this.built(p));
    if (!e || e.scene !== 'loaded') return Promise.reject(new Error(`places.built(${p}): the place is not loaded`));
    if (!e.portsBuilt || e.bake === null) {
      return Promise.reject(new Error(`places.built(${p}): the place is dormant, its render resources are disposed until it is active again`));
    }
    if (e.buildFailed) this.#startBuild(e, e.bake);
    return e.build ?? Promise.reject(new Error(`places.built(${p}): the place is not loaded`));
  }

  isBuilt(p: PlaceId): boolean {
    return this.roster.peek(p)?.built === true;
  }

  /** the render build's own progress, 0..1 */
  buildProgress(p: PlaceId): number {
    return this.roster.peek(p)?.buildProgress ?? 0;
  }

  // ── activate, unload, demote ───────────────────────────────────────────────────────────────────────────────────────

  activate(p: PlaceId): void {
    if (!this.roster.has(p)) throw new Error(`places.activate: unknown place "${p}"`);
    const prev = this.#active;
    if (prev === p) return;
    this.#ensurePorts(p);
    this.#active = p;
    this.#k.ports.scene.activate(p);
    this.#k.notify('placeActive', p, prev);
  }

  /** a demoted place that comes back: physics and render are built again from the kept bake */
  #ensurePorts(p: PlaceId): void {
    const e = this.roster.peek(p);
    if (!e || e.scene !== 'loaded' || e.portsBuilt || e.bake === null) return;
    const k = this.#k;
    k.ports.physics.buildPlace(p, e.bake);
    for (const row of [...k.store.byPlace(p)]) k.ports.physics.rowSpawned(row);
    e.portsBuilt = true;
    this.#startBuild(e, e.bake);
  }

  #disposePorts(e: PlaceEntry): void {
    const ports = this.#k.ports;
    if (e.portsBuilt) {
      for (const dispose of [() => ports.physics.disposePlace(e.id), () => ports.scene.disposePlace(e.id)]) {
        try {
          dispose();
        } catch (err) {
          this.#log.error(`disposing ${e.id} threw: ${msg(err)}`);
        }
      }
    }
    e.portsBuilt = false;
    e.built = false;
    e.build = null;
    e.buildFailed = false;
    e.buildProgress = 0;
    e.buildGen++;
  }

  unload(p: PlaceId): void {
    const k = this.#k;
    const e = this.roster.peek(p);
    if (e?.load) e.load.cancelled = true;
    if (this.#departure?.target === p) this.#cancelDeparture();
    if (this.#active === p) this.#active = null;

    // every row of the place but the players' bodies and the rig (they are present at all times, core §3.5)
    const doomed = [...k.store.byPlace(p)].filter((r) => r.parentId === null && r.player === null && r.rig === null);
    if (!k.rules.runOnDestroyOnUnload) {
      // a row whose onSpawn "has not run" gets neither hook when it is destroyed (lifecycle.ts)
      const mark = (r: RowRec): void => {
        r.pendingSpawnHooks = true;
        for (const c of k.store.childrenOf(r.id)) mark(c);
      };
      for (const r of doomed) mark(r);
    }
    for (const r of doomed) if (r.phase === 'alive' && k.store.get(r.id) === r) k.lifecycle.destroyOne(r.id, PLACE_UNLOAD);
    // outside a tick and outside any hook: the rows are disposed (onDestroy, physics.rowDestroyed) before the place's resources
    if (!k.time.scheduler.inTick && k.time.invoker.depth === 0) k.time.scheduler.boundary();

    if (e) {
      this.#disposePorts(e);
      if (e.load === null) e.scene = 'none';
      e.bake = null;
      e.refused = [];
    }
  }

  #keepResident(p: PlaceId): boolean {
    for (const place of this.#residentPlaces(this.#k.worldState)) if (place === p) return true;
    return false;
  }

  /** the human left `p`: unload it, or keep its rows dormant while the host names it */
  #retire(p: PlaceId): void {
    if (p === this.#active || this.#departure?.target === p) return;
    if (!this.#keepResident(p)) {
      this.unload(p);
      return;
    }
    const e = this.roster.peek(p);
    if (e) this.#disposePorts(e);
  }

  /** retire now, or at the end of the tick when hooks are running (the caller's own row may stand in `p`) */
  #retireSoon(p: PlaceId): void {
    const time = this.#k.time;
    if (time.scheduler.inTick || time.invoker.depth > 0) this.#retiring.push(p);
    else this.#retire(p);
  }

  #tickEnd(): void {
    // a departure cancelled in the tick that started it: its deferred pause has landed by now
    if (this.#undoDeferredPause) {
      this.#undoDeferredPause = false;
      if (!this.#loadingPause) this.#k.clock.resume('loading');
    }
    if (this.#retiring.length === 0) return;
    const list = this.#retiring;
    this.#retiring = [];
    for (const p of list) this.#retire(p);
  }

  // ── crossing ───────────────────────────────────────────────────────────────────────────────────────────────────────

  cross(_caller: CallerRef, entity: RowId | ObjectView, link: string): CrossResult {
    const parsed = parseLink(link);
    if ('verdict' in parsed) return { crossed: false, verdict: parsed.verdict };
    const { place: target, gate } = parsed;
    if (!this.roster.has(target)) {
      this.#warnOnce(`unknown-place:${target}`, `cross: unknown place "${target}" (${String(link)})`);
      return { crossed: false, verdict: 'unknown-place' };
    }
    const store = this.#k.store;
    const row = typeof entity === 'string' ? (store.get(entity) ?? null) : store.rowOf(entity);
    if (row === null || row.phase !== 'alive' || store.get(row.id) !== row) return { crossed: false, verdict: 'no-such-object' };
    if (row.parentId !== null) return { crossed: false, verdict: 'child-row' };
    const human = row.player !== null;

    if (row.place === target) {
      if (human) this.#cancelDeparture();
      return { crossed: true, placeId: target };
    }
    const ready = !this.roster.managed || target === this.#active || this.sceneLoaded(target);
    if (ready) {
      if (human) this.#cancelDeparture();
      // a demoted place gets its physics and render back before the body stands in it
      if (human) this.#ensurePorts(target);
      this.#move(row, target, gate);
      if (human && this.roster.managed) {
        const prev = this.#active;
        this.activate(target);
        if (prev !== null && prev !== target) this.#retireSoon(prev);
      }
      return { crossed: true, placeId: target };
    }
    if (!human) {
      // into the target's dormant records; its scene is added around them when it loads
      this.#move(row, target, gate);
      return { crossed: true, placeId: target };
    }
    return this.#depart(row, target, gate, link);
  }

  #depart(body: RowRec, target: PlaceId, gate: string | null, link: string): CrossResult {
    const d = this.#departure;
    if (d !== null && d.target === target && d.bodyId === body.id) {
      d.gate = gate;
      return { crossed: 'departing', link };
    }
    const token = ++this.#token;
    this.#departure = { target, bodyId: body.id, gate, token };
    if (!this.#loadingPause) {
      this.#loadingPause = true;
      // at the end of the running tick; at once outside a tick (core §11.5 step 2)
      this.#k.time.scheduler.pauseAtTickEnd('loading');
    }
    this.load(target).then(
      () => this.#arrive(token, target),
      (err: unknown) => this.#departFailed(token, target, err),
    );
    return { crossed: 'departing', link };
  }

  #resumeLoading(): void {
    if (!this.#loadingPause) return;
    this.#loadingPause = false;
    const clock = this.#k.clock;
    if (clock.reasons.has('loading')) clock.resume('loading');
    // asked for in this very tick (a departure cancelled by a later cross of the same tick): the pause still lands at the end
    // of the tick, and is taken back there
    else if (this.#k.time.scheduler.inTick) this.#undoDeferredPause = true;
  }

  #cancelDeparture(): void {
    if (this.#departure === null) return;
    this.#departure = null;
    this.#resumeLoading();
  }

  /** core §11.5 step 3: the load is done; runs between ticks (the clock is paused with `loading`) */
  #arrive(token: number, target: PlaceId): void {
    const d = this.#departure;
    if (d === null || d.token !== token) {
      // the body went somewhere else meanwhile: the place loaded for nothing
      if (this.sceneLoaded(target)) this.#retireSoon(target);
      return;
    }
    this.#departure = null;
    const k = this.#k;
    const body = k.store.get(d.bodyId);
    let arrived = false;
    try {
      if (body && body.phase === 'alive') {
        const prev = this.#active;
        this.#move(body, target, d.gate);
        this.activate(target);
        if (prev !== null && prev !== target) this.#retireSoon(prev);
        arrived = true;
      } else {
        this.#log.warn(`cross: ${d.bodyId} is gone, nobody arrives in ${target}`);
        this.#retireSoon(target);
      }
    } catch (err) {
      this.#log.error(`cross: the arrival in ${target} failed: ${msg(err)}`);
    } finally {
      this.#resumeLoading();
    }
    // one warm-up while the screen is still covered (core §11.5 step 3); it respects every other pause
    if (arrived && !k.time.scheduler.inTick) k.time.scheduler.runTicks(ENGINE.ACTIVATION_WARMUP_TICKS);
  }

  #departFailed(token: number, target: PlaceId, err: unknown): void {
    this.#log.error(`cross: the load of ${target} failed: ${msg(err)}`);
    if (this.#departure?.token !== token) return;
    // the body stays where it is and the clock runs again; the caller may retry
    this.#departure = null;
    this.#resumeLoading();
  }

  /** where a row arriving in `target` stands */
  #landing(target: PlaceId, gate: string | null): Vec3 {
    if (gate !== null) {
      const store = this.#k.store;
      const g = store.get(gate);
      if (g && g.phase === 'alive' && g.place === target) return copyVec3(worldPose(store, g).pos);
    }
    return this.spawnPoint(target);
  }

  /** whether `row` was made, directly or through rows it made or carries, by `by` (core §11.6) */
  #madeBy(row: RowRec, by: RowRec): boolean {
    const store = this.#k.store;
    let cur = row;
    for (let d = 0; d < CHAIN_MAX; d++) {
      const next = cur.spawnerId ?? cur.parentId;
      if (next === null) return false;
      if (next === by.id) return true;
      const n = store.get(next);
      // a row that named its place is anchored there, and so is what it makes
      if (!n || n.explicitPlace) return false;
      cur = n;
    }
    return false;
  }

  /** a teleport: the store, the physics port (always told, also when the position did not change) and no interpolation */
  #teleport(row: RowRec, p: Vec3): void {
    const k = this.#k;
    if (!writeFeetPosition(k.store, row, p, undefined)) k.ports.physics.setPosition(row, copyVec3(row.tf.pos));
    k.store.restartInterpolation(row);
  }

  /** tells the render feed and the physics port that `row` and its subtree stand in another place now */
  #placeChanged(row: RowRec, depth = 0): void {
    const k = this.#k;
    k.time.feed.changed(row, 'place');
    if (depth > 0 && hasBody(row)) k.ports.physics.setPosition(row, copyVec3(row.tf.pos));
    if (depth >= CHAIN_MAX) return;
    for (const c of k.store.childrenOf(row.id)) this.#placeChanged(c, depth + 1);
  }

  /** moves `row`, its subtree and its followers to `target` and lands it */
  #move(row: RowRec, target: PlaceId, gate: string | null): void {
    const k = this.#k;
    const store = k.store;
    const from = row.place;
    const followers: RowRec[] = [];
    if (from !== null) {
      for (const r of store.byPlace(from)) {
        if (r === row || r.parentId !== null || r.phase !== 'alive') continue;
        // the camera rig goes where the body it follows goes (it is the kernel's row, nobody's creation)
        const rig = r.rig !== null && r.rig.targetId === row.id;
        if (rig || (!r.explicitPlace && r.player === null && this.#madeBy(r, row))) followers.push(r);
      }
    }
    const landing = this.#landing(target, gate);
    const before = copyVec3(row.tf.pos);
    const attached = isCameraAttached(row);

    store.movePlace(row, target);
    if (!attached) this.#teleport(row, landing);
    if (!writeVelocity(store, row, zero(), undefined)) k.ports.physics.setVelocity(row, zero());
    if (!writeAngularVelocity(store, row, zero(), undefined)) k.ports.physics.setAngularVelocity(row, zero());
    const facing = this.roster.config(target)?.defaultSpawnRotation ?? null;
    if (facing !== null) writeRotation(store, row, facing, undefined);
    this.#placeChanged(row);

    const dx = attached ? 0 : landing.x - before.x;
    const dy = attached ? 0 : landing.y - before.y;
    const dz = attached ? 0 : landing.z - before.z;
    for (const f of followers) {
      store.movePlace(f, target);
      if (!isCameraAttached(f)) this.#teleport(f, { x: f.tf.pos.x + dx, y: f.tf.pos.y + dy, z: f.tf.pos.z + dz });
      this.#placeChanged(f);
    }
  }

  #warnOnce(key: string, message: string): void {
    if (this.#warned.has(key)) return;
    if (this.#warned.size >= WARNED_MAX) this.#warned.clear();
    this.#warned.add(key);
    this.#log.warn(message);
  }
}

export function createPlaceManager(k: PlacesKernel, opts: PlaceManagerOptions = {}): PlaceManagerImpl {
  return new PlaceManagerImpl(k, opts);
}
