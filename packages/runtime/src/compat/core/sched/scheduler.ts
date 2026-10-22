// The per-tick pipeline and the frame accumulator (docs/design/core-runtime.md §9.2-9.3, §9.7, D-CORE-09/10/16;
// docs/architecture.md §4.1).
//
// One tick, steps A-H; ◆ is a phase boundary: the lifecycle's deferred hooks (onSpawn queue, then onDestroy queue) and then
// the event queue drained FIFO, repeated until both are empty (events bounded by DRAIN_CAP per boundary):
//   A CLOCK     tick++, now advances, per-tick memos cleared (host.tickStart)
//   B INPUT     the body's onInput, in behavior order, with ports.input.sampleTick(); delivery wakes its sleepers        ◆
//   C TIMERS    ctx.after timers due at this tick, in (due tick, creation) order                                          ◆
//   D UPDATE    every alive row of a simulated place (and every place-less row), spawn serial order, from a snapshot taken
//               at the start of D; each behavior in array order unless the row's onSpawn has not run, the schedule
//               declines or the behavior sleeps; then the tween runner writes this tick's tween values               ◆
//   E PHYSICS   ports.physics.step(place, 1/30) per simulated place, then host.afterPhysics (writeback, body-less velocity
//               integration, spatial re-bucketing, onTriggerEnter, out of bounds)                                       ◆
//   F SIMS      when tick % 3 === 2: the root sim, then each simulated place's sim                                        ◆
//   G LIFETIME  expired rows destroyed (host.expireLifetimes)                                                             ◆
//   H END       ports.motion.advanceTick(1/30), host.endOfTick (change list → save, UI dirty, …), deferred pauses applied,
//               metrics, KernelEvents.tickEnd
//
// advance(realDt) runs 0..2 ticks per rendered frame: the frame time (clamped to 250 ms) feeds an accumulator, a tick runs per
// 1000/30 ms, `clock.running` is checked before every tick (a pause set in step H stops the next tick of the same frame), the
// backlog beyond two ticks is dropped (metrics.droppedTicks), and nothing accumulates while paused; the accumulator is reset
// when the clock resumes (no catch-up burst). The test-only setTicksPerFrame(n) fast-forwards: n/2 sim seconds per real
// second, up to n ticks a frame (the e2e timeScale(n/2)); dt stays 1/30 (D-CORE-16: no engine time scale).
//
// The scheduler owns the order and the gating; what the steps act on comes from its host (TickHost), which the kernel wires to
// the row store, the lifecycle and the place manager as those land (sched/runtime.ts, `kernel.time.use`).
import { perfNow } from '../perf-now.ts';
import { ENGINE } from '../rules.ts';
import type { KernelMetrics, PauseReason, PlaceId, RowRec, SimInstance } from '../types.ts';
import type { KernelPorts } from '../ports.ts';
import type { HookInvoker } from '../behaviors/invoke.ts';
import type { EventBusImpl } from '../events/bus.ts';
import type { TweenRunner } from '../../builtin/tween.ts';
import type { SimClockImpl } from './clock.ts';
import { isLocal, shouldRun } from './schedule.ts';
import { sleepingNow, wakeRow } from './sleep.ts';
import type { TimerQueue } from './timers.ts';

/** what the steps act on: the row store, the lifecycle and the place manager behind one seam (sched/runtime.ts) */
export interface TickHost {
  /** A: per-tick memos (world poses, query memos) */
  tickStart(tick: number): void;
  /** B: the human body when it takes input this tick: alive and its onSpawn has run; else null */
  inputBody(): RowRec | null;
  /** D: candidate rows in spawn serial order (the scheduler keeps the alive, local ones and never the camera rig) */
  updateRows(): Iterable<RowRec>;
  /** D, E: whether a place is simulated (holds the human) */
  isSimulated(place: PlaceId): boolean;
  /** E: the places whose physics steps this tick */
  simulatedPlaces(): readonly PlaceId[];
  /** E: after the physics steps: writeback, body-less integration, re-bucketing, onTriggerEnter, out of bounds */
  afterPhysics(tick: number): void;
  /** F: the root sim first, then the simulated places' sims in roster order */
  sims(): readonly SimInstance[];
  /** G: destroy the rows whose lifetime ended */
  expireLifetimes(tick: number): void;
  /** ◆: run the deferred onSpawn queue, then the onDestroy queue; returns how many rows were handled (0: nothing pending) */
  flushDeferred(): number;
  /** H: per-tick bookkeeping of the store's change list (durable save, UI dirty, …) */
  endOfTick(tick: number): void;
}

export interface SchedulerDeps {
  readonly clock: SimClockImpl;
  readonly bus: EventBusImpl;
  readonly timers: TimerQueue;
  readonly invoker: HookInvoker;
  readonly tweens: TweenRunner;
  readonly ports: Pick<KernelPorts, 'input' | 'physics' | 'motion'>;
  readonly metrics: KernelMetrics;
  readonly host: TickHost;
  /** opt-in (ext.slowMo): the factor the frame accumulator is fed with, from the real frame time (sched/slowmo.ts) */
  readonly timeScale?: { step(realDtMs: number): number } | undefined;
  /** KernelEvents.tickEnd */
  tickEnd(tick: number): void;
  warn(message: string): void;
}

/** the dt every tick passes to physics and motion */
export const TICK_DT_S = 1 / ENGINE.TICK_HZ;
/** float slack for the accumulator (ms) */
const ACC_EPS = 1e-6;
/** a boundary stops after this many rounds of deferred hooks (an onSpawn that spawns forever) */
const BOUNDARY_ROUNDS_MAX = 10_000;
/** tick times kept for the p95 (10 s) */
const TIMING_WINDOW = 300;
/** the p95 is recomputed every second */
const P95_EVERY = 30;
const EWMA_ALPHA = 0.1;

export class Scheduler {
  readonly #d: SchedulerDeps;
  #acc = 0;
  #ticksPerFrame: 2 | 4 | 8 = ENGINE.MAX_TICKS_PER_FRAME;
  #inTick = false;
  #deferredPauses: PauseReason[] = [];
  readonly #times: number[] = [];
  #timeIdx = 0;
  #sinceP95 = 0;
  #boundaryWarnAt = Number.NEGATIVE_INFINITY;

  constructor(deps: SchedulerDeps) {
    this.#d = deps;
  }

  /** a tick is running */
  get inTick(): boolean {
    return this.#inTick;
  }

  get ticksPerFrame(): 2 | 4 | 8 {
    return this.#ticksPerFrame;
  }

  /** the interpolation alpha: the accumulated fraction of a tick, in [0, 1) */
  get alpha(): number {
    return Math.min(1, Math.max(0, this.#acc / ENGINE.TICK_MS));
  }

  /** the clock resumed: no catch-up for the time spent paused */
  resetAccumulator(): void {
    this.#acc = 0;
  }

  /** test builds only (the e2e timeScale hook): n/2 sim seconds per real second, up to n ticks a frame */
  setTicksPerFrame(n: 2 | 4 | 8): void {
    if (n !== 2 && n !== 4 && n !== 8) throw new RangeError(`setTicksPerFrame: ${String(n)} is not 2, 4 or 8`);
    this.#ticksPerFrame = n;
  }

  /** per rendered frame (core §9.7) */
  advance(realDtMs: number): { ticks: number; alpha: number } {
    this.#guard('advance');
    const clock = this.#d.clock;
    if (!clock.running) return { ticks: 0, alpha: this.alpha };
    const dt = Number.isFinite(realDtMs) && realDtMs > 0 ? Math.min(realDtMs, ENGINE.MAX_FRAME_DT_MS) : 0;
    this.#acc += dt * (this.#ticksPerFrame / ENGINE.MAX_TICKS_PER_FRAME) * (this.#d.timeScale?.step(dt) ?? 1);
    let ticks = 0;
    while (this.#acc >= ENGINE.TICK_MS - ACC_EPS && ticks < this.#ticksPerFrame) {
      if (!clock.running) break;
      this.#acc = Math.max(0, this.#acc - ENGINE.TICK_MS);
      this.#runTick();
      ticks++;
    }
    if (ticks === this.#ticksPerFrame && this.#acc >= ENGINE.TICK_MS - ACC_EPS) {
      // a hitch: the backlog beyond the frame's ticks is dropped (a brief slow-down, never a burst)
      const drop = Math.floor(this.#acc / ENGINE.TICK_MS + ACC_EPS);
      this.#d.metrics.droppedTicks += drop;
      this.#acc = Math.max(0, this.#acc - drop * ENGINE.TICK_MS);
    }
    return { ticks, alpha: this.alpha };
  }

  /** headless: n ticks back to back; stops when the clock pauses unless forced (core §3.7); returns the ticks run */
  runTicks(n: number, opts?: { force?: boolean }): number {
    this.#guard('runTicks');
    const count = Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
    const force = opts?.force === true;
    let ran = 0;
    for (; ran < count; ran++) {
      if (!force && !this.#d.clock.running) break;
      this.#runTick();
    }
    return ran;
  }

  /** a pause that lands at the end of the running tick (core §11.5 step 2: a cross pauses with `loading`); at once outside a tick */
  pauseAtTickEnd(reason: PauseReason): void {
    if (this.#inTick) this.#deferredPauses.push(reason);
    else this.#d.clock.pause(reason);
  }

  /** a phase boundary: deferred hooks, then the queue, until both are empty or DRAIN_CAP events went this boundary */
  boundary(): void {
    const { host, bus } = this.#d;
    let budget = ENGINE.DRAIN_CAP;
    for (let round = 0; round < BOUNDARY_ROUNDS_MAX; round++) {
      const hooks = host.flushDeferred();
      const delivered = budget > 0 ? bus.drain(budget) : 0;
      budget -= delivered;
      if (bus.pending > 0 && budget <= 0) return; // the bus warned: the rest waits for the next boundary
      if (hooks === 0 && delivered === 0) return;
    }
    const now = Date.now();
    if (now - this.#boundaryWarnAt >= ENGINE.LOG_REPEAT_MS) {
      this.#boundaryWarnAt = now;
      this.#d.warn(`[scheduler] a phase boundary stopped after ${BOUNDARY_ROUNDS_MAX} rounds of deferred hooks (an onSpawn that spawns forever?)`);
    }
  }

  #guard(verb: string): void {
    if (this.#inTick) throw new Error(`kernel.${verb}: re-entrant call during a tick`);
  }

  #runTick(): void {
    this.#inTick = true;
    const t0 = perfNow();
    try {
      this.#steps();
      // H, end: the pauses asked for during the tick land before tickEnd, whose subscribers see them (still in the tick:
      // a subscriber that runs ticks is refused as re-entrant)
      this.#applyDeferredPauses();
      this.#timed(perfNow() - t0);
      this.#d.tickEnd(this.#d.clock.tick);
    } finally {
      this.#inTick = false;
      // also when a step failed, and for a pauseAtTickEnd made by a tickEnd subscriber
      this.#applyDeferredPauses();
    }
  }

  #steps(): void {
    const { clock, host, invoker, ports, timers } = this.#d;
    // A CLOCK
    const tick = clock.advance();
    host.tickStart(tick);

    // B INPUT
    const body = host.inputBody();
    if (body !== null && body.phase === 'alive') {
      const input = ports.input.sampleTick();
      wakeRow(body);
      for (const inst of body.behaviors) {
        if (body.phase !== 'alive') break;
        const f = inst.module?.onInput;
        if (typeof f === 'function') invoker.call({ kind: 'row', row: body, inst }, 'onInput', f, [inst.ctx, input], inst.module);
      }
    }
    this.boundary();

    // C TIMERS
    timers.fireDue(tick, (t) => {
      const ctx = t.owner.kind === 'row' ? t.owner.inst.ctx : t.owner.sim.ctx;
      invoker.call(t.owner, `after.${t.hook}`, t.fn, [ctx, t.payload], t.module);
    });
    this.boundary();

    // D UPDATE (a snapshot: rows spawned during D first update next tick)
    const rows = Array.from(host.updateRows());
    const simulated = (p: PlaceId): boolean => host.isSimulated(p);
    for (const row of rows) {
      // a row without behaviors does nothing below (the runtime's list holds none, sched/runtime.ts `updateRows`; another host
      // may hand them): reading the length first skips the locality lookup, which has no side effects
      if (row.behaviors.length === 0) continue;
      if (row.phase !== 'alive' || row.pendingSpawnHooks || row.rig !== null || !isLocal(row.place, simulated)) continue;
      for (const inst of row.behaviors) {
        if (row.phase !== 'alive') break; // destroyed by one of its own behaviors
        const mod = inst.module;
        if (mod === null || typeof mod.update !== 'function') continue;
        if (!shouldRun(inst.schedule, tick)) continue;
        if (sleepingNow(inst, tick)) continue;
        invoker.call({ kind: 'row', row, inst }, 'update', mod.update, [inst.ctx, inst.schedule.dtS], mod);
      }
    }
    this.#d.tweens.step(clock.now());
    this.boundary();

    // E PHYSICS
    for (const place of host.simulatedPlaces()) ports.physics.step(place, TICK_DT_S);
    host.afterPhysics(tick);
    this.boundary();

    // F SIMS
    if (tick % ENGINE.SIM_EVERY_TICKS === ENGINE.SIM_TICK_PHASE) {
      for (const sim of host.sims()) {
        if (sim.everyTicks !== undefined && tick % sim.everyTicks !== sim.everyTicks - 1) continue;
        const f = sim.module?.tick;
        if (typeof f === 'function') invoker.call({ kind: 'sim', sim }, 'tick', f, [sim.ctx], sim.module);
      }
    }
    this.boundary();

    // G LIFETIME
    host.expireLifetimes(tick);
    this.boundary();

    // H END
    ports.motion.advanceTick(TICK_DT_S);
    host.endOfTick(tick);
  }

  #applyDeferredPauses(): void {
    if (this.#deferredPauses.length === 0) return;
    const reasons = this.#deferredPauses;
    this.#deferredPauses = [];
    for (const r of reasons) this.#d.clock.pause(r);
  }

  #timed(ms: number): void {
    const m = this.#d.metrics;
    m.tickMsEwma = m.tickMsEwma === 0 ? ms : m.tickMsEwma + EWMA_ALPHA * (ms - m.tickMsEwma);
    if (this.#times.length < TIMING_WINDOW) this.#times.push(ms);
    else this.#times[this.#timeIdx] = ms;
    this.#timeIdx = (this.#timeIdx + 1) % TIMING_WINDOW;
    if (++this.#sinceP95 >= P95_EVERY) {
      this.#sinceP95 = 0;
      const sorted = [...this.#times].sort((a, b) => a - b);
      m.tickMsP95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]!;
    }
  }
}
