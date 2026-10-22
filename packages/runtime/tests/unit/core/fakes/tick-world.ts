// A small row world for the time and event tests (WP C2): the real kernel (clock, scheduler, bus, acts, feed, timers, invoker,
// tweens) with the row store, the lifecycle and the ctx factories of later packages (C1a, C1b, C5) replaced by the minimum
// they do, plugged in through `kernel.time.use()`, the same seam those packages use. Rows are plain RowRec records; each
// behavior gets a "mini ctx" with the verbs these tests need (emit, on, after, sleep, spawn, destroy, write, getObject).
import { createKernel, type CoreKernel, type KernelOptions } from '../../../../src/compat/core/kernel.ts';
import { bindBehavior } from '../../../../src/compat/core/behaviors/bind.ts';
import { sleepFor, wakeForWrite } from '../../../../src/compat/core/sched/sleep.ts';
import { attachTweenRunner } from '../../../../src/compat/builtin/tween.ts';
import type { KernelPorts } from '../../../../src/compat/core/ports.ts';
import type { EngineRules } from '../../../../src/compat/core/rules.ts';
import type {
  BehaviorInstance,
  BehaviorModule,
  CompiledPlaceIndex,
  EmitOptions,
  EventMeta,
  ModuleRegistry,
  ObjectSpec,
  PlaceId,
  RowId,
  RowRec,
  SimInstance,
  SimModule,
  Vec3,
  VmId,
  WorldConfig,
} from '../../../../src/compat/core/types.ts';

export const registry: ModuleRegistry = {
  knows: () => false,
  get: () => undefined,
  template: (ref: string): Readonly<ObjectSpec> => {
    throw Object.assign(new Error(`spawn refused: template not loaded: ${ref}`), { name: 'SpawnRefused' });
  },
  ensure: async () => {},
  load: async (path: string) => {
    throw new Error(`unknown module ${path}`);
  },
  lateBinds: 0,
};

export function kernelOptions(extra: Partial<KernelOptions> = {}, defaultPlace = 'p1'): KernelOptions {
  const worldConfig: WorldConfig = { defaultPlace, player: 'templates/player.js#player', camera: 'templates/camera.js#camera', inputs: {} };
  const places: CompiledPlaceIndex = { placeIndex: {}, places: {} };
  return { seed: 7, ports: {}, worldConfig, places, registry, ...extra };
}

const v3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

/** a behavior module as these tests write it: hooks take the mini ctx (BehaviorModule types them with C5's BehaviorCtx) */
export type TestModule = Record<string, unknown>;

export interface RowOpts {
  vm?: VmId;
  place?: PlaceId | null;
  behaviors?: ReadonlyArray<readonly [path: string, module: TestModule | null]>;
  pos?: Vec3;
  parentId?: RowId | null;
  spawnerId?: RowId | null;
  player?: { userId: string };
  rig?: boolean;
  /** expire at this tick (core §4.2: expiresAtTick) */
  expiresAtTick?: number;
}

/** a RowRec with every field the store would set (C1a's record shape, core §3.2) */
export function makeRow(id: RowId, serial: number, o: RowOpts = {}): RowRec {
  const pos = o.pos ?? v3();
  return {
    id,
    serial,
    vm: o.vm ?? 'platform',
    place: o.place === undefined ? 'p1' : o.place,
    explicitPlace: false,
    parentId: o.parentId ?? null,
    spawnerId: o.spawnerId ?? null,
    name: null,
    tags: Object.freeze([]),
    template: null,
    spec: Object.freeze({}),
    state: {},
    props: {},
    tf: {
      pos,
      rot: { x: 0, y: 0, z: 0, w: 1 },
      scale: v3(1, 1, 1),
      vel: v3(),
      angVel: v3(),
      grounded: false,
      prevPos: pos,
      prevRot: { x: 0, y: 0, z: 0, w: 1 },
      worldCacheTick: -1,
    },
    behaviors: [],
    audience: 'near',
    scope: 'session',
    visibility: null,
    simulatedBy: null,
    lifetimeS: null,
    expiresAtTick: o.expiresAtTick ?? null,
    phase: 'alive',
    pendingSpawnHooks: true,
    player: o.player ? { userId: o.player.userId, displayName: 'Operator', bodyId: id, look: [] } : null,
    spectating: false,
    rig: o.rig ? ({ targetId: null, layer: null } as unknown as RowRec['rig']) : null,
    fromScene: null,
    stateVer: 0,
    propVer: 0,
    handles: {},
  };
}

/** the verbs a behavior's ctx offers in these tests (C5 builds the real one) */
export interface MiniCtx {
  readonly kind: 'behavior';
  readonly self: { readonly id: RowId };
  readonly row: RowRec;
  readonly inst: BehaviorInstance;
  readonly session: Record<string, unknown>;
  now(): number;
  emit(name: string, payload?: unknown, opts?: EmitOptions): string | undefined;
  on(name: string, handler: (ctx: unknown, payload: unknown, meta: EventMeta) => void, opts?: { place?: PlaceId; once?: boolean }): () => void;
  after(seconds: number, hook: string, payload?: unknown): string;
  cancel(id: string): void;
  sleep(seconds?: number): void;
  spawn(id: RowId, o?: RowOpts): RowId;
  destroy(id?: RowId): void;
  getObject(id: RowId): { id: RowId } | null;
  /** a script write to `target` (default: self) through the store: wakes sleepers and feeds the render feed (C1a's writeProp) */
  write(field: string, value: unknown, target?: RowId): void;
}

export interface MiniSimCtx {
  readonly kind: 'sim';
  readonly sim: SimInstance;
  now(): number;
  emit(name: string, payload?: unknown, opts?: EmitOptions): string | undefined;
  on(name: string, handler: (ctx: unknown, payload: unknown, meta: EventMeta) => void, opts?: { place?: PlaceId; once?: boolean }): () => void;
  after(seconds: number, hook: string, payload?: unknown): string;
}

export interface WorldOpts {
  defaultPlace?: string;
  active?: PlaceId | null;
  rules?: Partial<EngineRules>;
  ports?: Partial<KernelPorts>;
  /** keep the kernel's initial `boot` pause */
  keepBoot?: boolean;
}

export class FakeWorld {
  readonly k: CoreKernel;
  /** alive rows by id */
  readonly rows = new Map<RowId, RowRec>();
  /** every row ever spawned, serial order */
  readonly all: RowRec[] = [];
  readonly sims: SimInstance[] = [];
  active: PlaceId | null;
  readonly #spawnQueue: RowRec[] = [];
  readonly #destroyQueue: RowRec[] = [];
  #serial = 0;
  readonly #ctxs = new Map<BehaviorInstance, MiniCtx>();

  constructor(o: WorldOpts = {}) {
    this.k = createKernel(kernelOptions({ rules: o.rules, ports: o.ports ?? {} }, o.defaultPlace ?? 'p1'));
    this.active = o.active === undefined ? 'p1' : o.active;
    if (!o.keepBoot) this.k.clock.resume('boot');
    const self = this;
    this.k.time.use({
      inputBody() {
        const b = self.rows.get('player/local');
        return b && b.phase === 'alive' && !b.pendingSpawnHooks ? b : null;
      },
      updateRows: () => this.all.filter((r) => r.phase === 'alive'),
      isSimulated: (p) => p === this.active,
      simulatedPlaces: () => (this.active ? [this.active] : []),
      sims: () => this.sims.filter((s) => s.place === null || s.place === this.active),
      flushDeferred: () => this.#flush(),
      expireLifetimes: (tick) => {
        for (const r of this.all) if (r.phase === 'alive' && r.expiresAtTick !== null && r.expiresAtTick <= tick) this.destroy(r.id);
      },
      human: () => {
        const b = this.rows.get('player/local');
        return b ? { playerId: b.player?.userId ?? null, bodyId: b.id, place: b.place, feet: b.tf.pos } : null;
      },
      rowExists: (id) => this.rows.has(id),
      feetOf: (r) => r.tf.pos,
      isResident: () => true,
    });
  }

  get time() {
    return this.k.time;
  }

  /** core §5.2: in the store at once, onSpawn at the next phase boundary */
  spawn(id: RowId, o: RowOpts = {}): RowRec {
    if (this.rows.has(id)) throw new Error(`fake world: duplicate id ${id}`);
    const row = makeRow(id, ++this.#serial, o);
    for (const [path, module] of o.behaviors ?? []) {
      row.behaviors.push(
        bindBehavior(row, path, module as BehaviorModule | null, { listeners: this.k.time.listeners, ctxFor: (r, inst) => this.#ctxFor(r, inst) as never }),
      );
    }
    this.rows.set(id, row);
    this.all.push(row);
    this.#spawnQueue.push(row);
    this.k.notify('rowSpawned', row);
    return row;
  }

  /** core §5.2: detached at once, onDestroy at the next phase boundary */
  destroy(id: RowId): void {
    const row = this.rows.get(id);
    if (!row) return;
    this.rows.delete(id);
    row.phase = 'dead';
    if (row.pendingSpawnHooks) {
      // spawn-then-destroy before onSpawn ran: neither hook runs
      const i = this.#spawnQueue.indexOf(row);
      if (i >= 0) this.#spawnQueue.splice(i, 1);
      row.phase = 'disposed';
      this.k.notify('rowDestroyed', row);
      return;
    }
    this.#destroyQueue.push(row);
  }

  addSim(id: string, place: PlaceId | null, module: Partial<SimModule> & Record<string, unknown>): SimInstance {
    const sim: SimInstance = { id, place, path: place ? `places/${place}/sim.js` : 'sim.js', module: module as SimModule, ctx: null, health: new Map() };
    const k = this.k;
    const ctx: MiniSimCtx = {
      kind: 'sim',
      sim,
      now: () => k.clock.now(),
      emit: (name, payload, opts) => k.bus.emit({ kind: 'sim', sim }, name, payload, opts),
      on: (name, handler, opts) => k.time.listeners.on({ kind: 'sim', sim }, name, handler, opts),
      after: (seconds, hook, payload) => k.time.timers.after({ kind: 'sim', sim }, sim.module as never, k.clock.tick, seconds, hook, payload),
    };
    attachTweenRunner(ctx, k.time.tweens);
    sim.ctx = ctx as never;
    this.sims.push(sim);
    return sim;
  }

  ctxOf(row: RowRec, path?: string): MiniCtx {
    const inst = path ? row.behaviors.find((b) => b.path === path) : row.behaviors[0];
    if (!inst) throw new Error(`fake world: ${row.id} has no behavior ${path ?? '(first)'}`);
    const ctx = this.#ctxs.get(inst);
    if (!ctx) throw new Error(`fake world: no ctx for ${row.id} ${inst.path}`);
    return ctx;
  }

  #ctxFor(row: RowRec, inst: BehaviorInstance): MiniCtx {
    const k = this.k;
    const world = this;
    const caller = { kind: 'row' as const, row, behavior: inst };
    const owner = { kind: 'row' as const, row, inst };
    const ctx: MiniCtx = {
      kind: 'behavior',
      self: { id: row.id },
      row,
      inst,
      session: {},
      now: () => k.clock.now(),
      emit: (name, payload, opts) => k.bus.emit(caller, name, payload, opts),
      on: (name, handler, opts) => k.time.listeners.on(owner, name, handler, opts),
      after: (seconds, hook, payload) => k.time.timers.after(owner, inst.module, k.clock.tick, seconds, hook, payload),
      cancel: (id) => {
        k.time.timers.cancel(id);
      },
      sleep: (seconds) => sleepFor(inst, k.clock.tick, seconds),
      spawn: (id, o = {}) => world.spawn(id, { place: row.place, vm: row.vm, spawnerId: row.id, ...o }).id,
      destroy: (id) => world.destroy(id ?? row.id),
      getObject: (id) => (world.rows.has(id) ? { id } : null),
      write: (field, value, target) => {
        const r = world.rows.get(target ?? row.id);
        if (!r) return;
        (r.props as Record<string, unknown>)[field] = value;
        wakeForWrite(r, k.time.invoker.current);
        k.time.feed.changed(r, field);
      },
    };
    attachTweenRunner(ctx, k.time.tweens);
    this.#ctxs.set(inst, ctx);
    return ctx;
  }

  /** core §5.2 flushDeferred: the onSpawn queue in creation order, then the onDestroy queue; returns the rows handled */
  #flush(): number {
    let n = 0;
    const inv = this.k.time.invoker;
    while (this.#spawnQueue.length > 0) {
      const row = this.#spawnQueue.shift()!;
      n++;
      row.pendingSpawnHooks = false;
      for (const inst of row.behaviors) {
        if (row.phase !== 'alive') break;
        const f = inst.module?.onSpawn;
        if (typeof f === 'function') inv.call({ kind: 'row', row, inst }, 'onSpawn', f, [inst.ctx], inst.module);
      }
    }
    while (this.#destroyQueue.length > 0) {
      const row = this.#destroyQueue.shift()!;
      n++;
      for (const inst of row.behaviors) {
        const f = inst.module?.onDestroy;
        if (typeof f === 'function') inv.call({ kind: 'row', row, inst }, 'onDestroy', f, [inst.ctx], inst.module);
      }
      row.phase = 'disposed';
      this.k.notify('rowDestroyed', row);
    }
    return n;
  }
}

/** a recording physics/motion/input port set (the tick steps E, H and B) */
export function recordingPorts(trace: string[]): Partial<KernelPorts> {
  return {
    physics: {
      buildPlace: () => {},
      disposePlace: () => {},
      rowSpawned: () => {},
      rowDestroyed: () => {},
      onPhysicsWrite: () => {},
      setPosition: () => {},
      setRotation: () => {},
      setVelocity: () => {},
      setAngularVelocity: () => {},
      setForce: () => {},
      setSpectating: () => {},
      applyImpulse: () => {},
      step: (place, dt) => {
        trace.push(`E physics.step ${place} ${dt.toFixed(4)}`);
      },
      drainTriggerEnters: () => [],
      groundY: () => null,
      vmWorlds: { platform: null, client: null },
      setVisualProxies: () => {},
    },
    motion: {
      advanceTick: (dt) => {
        trace.push(`H motion.advanceTick ${dt.toFixed(4)}`);
      },
    },
    input: {
      sampleTick: () => {
        trace.push('B input.sampleTick');
        return { axes: {}, held: {}, pressed: {}, released: {}, actions: {} };
      },
      sampleRig: () => ({ axes: {}, held: {}, pressed: {}, released: {}, actions: {} }),
      injectAction: () => true,
      setBlocked: () => {},
      discardEdges: () => {
        trace.push('input.discardEdges');
      },
      declared: {},
    },
  };
}
