// The one pausable simulation clock (docs/design/core-runtime.md §9.1, D-CORE-09; docs/architecture.md §3.0, X-07).
//
// `tick` counts the ticks run since boot; `now()` is the sim time in ms, `NOW_EPOCH_MS + tick·1000/30`, constant within a tick
// and exact on every third tick (the Director's 100 ms cadence). The clock runs only while its reason set is empty; while it is
// paused nothing simulated advances, because only the scheduler (sched/scheduler.ts) moves `tick`, and it runs no tick while
// paused. Who sets which reason is X-07 (rules.ts PAUSE_REASON_OWNER): the kernel `boot` and `loading`, the LOADING gate
// `preparing`, the platform domain's PauseController the rest.
import { ENGINE, isPauseReason } from '../rules.ts';
import type { PauseReason, SimClock } from '../types.ts';

/** ctx.now() at a tick: exact ms on every third tick (tick·1000/30, not tick·TICK_MS, whose rounding drifts) */
export function nowAtTick(tick: number): number {
  return ENGINE.NOW_EPOCH_MS + (tick * 1000) / ENGINE.TICK_HZ;
}

export interface ClockChange {
  readonly reason: PauseReason;
  /** true: the reason was set; false: it was cleared */
  readonly added: boolean;
}

/** after every effective change of the reason set: whether the clock now runs, the reasons now set, and the change */
export type ClockListener = (running: boolean, reasons: ReadonlySet<PauseReason>, change: ClockChange) => void;

function checkReason(r: unknown, verb: string): asserts r is PauseReason {
  if (!isPauseReason(r)) throw new TypeError(`clock.${verb}: ${String(r)} is not a pause reason (X-07)`);
}

export class SimClockImpl implements SimClock {
  #tick = 0;
  readonly #reasons = new Set<PauseReason>();
  #listeners: ClockListener[] = [];

  constructor(initialReasons: Iterable<PauseReason> = []) {
    for (const r of initialReasons) {
      checkReason(r, 'constructor');
      this.#reasons.add(r);
    }
  }

  /** ticks run since boot */
  get tick(): number {
    return this.#tick;
  }

  /** ms on the sim clock, constant within a tick */
  now(): number {
    return nowAtTick(this.#tick);
  }

  get running(): boolean {
    return this.#reasons.size === 0;
  }

  /** a copy per read: a reader that casts and mutates it changes nothing (reads are rare: the pause chrome, tests) */
  get reasons(): ReadonlySet<PauseReason> {
    return new Set(this.#reasons);
  }

  pause(r: PauseReason): void {
    checkReason(r, 'pause');
    if (this.#reasons.has(r)) return;
    this.#reasons.add(r);
    this.#changed(r, true);
  }

  resume(r: PauseReason): void {
    checkReason(r, 'resume');
    if (!this.#reasons.delete(r)) return;
    this.#changed(r, false);
  }

  /** subscribe to reason-set changes; the returned function unsubscribes (idempotent) */
  onChange(fn: ClockListener): () => void {
    this.#listeners = [...this.#listeners, fn];
    return () => {
      this.#listeners = this.#listeners.filter((l) => l !== fn);
    };
  }

  /** step A of the tick (the scheduler only): tick++, which moves now() */
  advance(): number {
    return ++this.#tick;
  }

  #changed(reason: PauseReason, added: boolean): void {
    const running = this.running;
    const reasons: ReadonlySet<PauseReason> = new Set(this.#reasons);
    const change: ClockChange = { reason, added };
    // the list present when the change happened; a listener that throws is the subscriber's bug and propagates
    for (const fn of this.#listeners) fn(running, reasons, change);
  }
}
