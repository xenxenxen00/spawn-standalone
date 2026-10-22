// ctx.after / ctx.cancel / ctx.getTimers (docs/design/core-runtime.md §9.6; contract §5.7; engine api:157-167).
//
// A timer is due at tick + max(1, ceil(seconds·30)) and fires in tick step C (the scheduler calls fireDue), in (due tick,
// creation) order, as `<calling module>[hookExport](ctx, payload)` with the owner's ctx; the payload is a wire clone taken at
// `after` time. A missing export is reported at `after` time, never at fire time. Timers of a destroyed owner are dropped: at
// once in effect (a detached row's timers never fire) and from memory when the kernel disposes the row (dropOwner). Timers
// do not survive the page. Live use: one site, `authored module` → `kickShard`.
import { ENGINE } from '../rules.ts';
import { cloneWire } from '../wire.ts';
import type { RowId, RowRec, TimerInfo } from '../types.ts';
import type { HookOwner } from '../behaviors/invoke.ts';

export type TimerOwner = HookOwner;

export interface TimerEntry {
  readonly id: string;
  readonly owner: TimerOwner;
  readonly hook: string;
  /** the export, resolved at `after` time */
  readonly fn: (...args: never[]) => unknown;
  /** the module the export belongs to (the hook's `this`) */
  readonly module: object;
  readonly payload: unknown;
  readonly dueTick: number;
  readonly seq: number;
}

interface Slot {
  readonly entry: TimerEntry;
  cancelled: boolean;
}

export const TIMER_ID_PREFIX = 'timer-';

/** float slack for seconds·30 */
const TICK_EPS = 1e-6;

/** the tick a timer set at `tick` for `seconds` is due (at least the next tick) */
export function dueTickAfter(tick: number, seconds: number): number {
  const s = typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : 0;
  return tick + Math.max(1, Math.ceil(s * ENGINE.TICK_HZ - TICK_EPS));
}

const ownerIdOf = (o: TimerOwner): RowId | 'sim' => (o.kind === 'row' ? o.row.id : 'sim');
const scriptOf = (o: TimerOwner): string => (o.kind === 'row' ? o.inst.path : o.sim.path);
const ownerAlive = (o: TimerOwner): boolean => o.kind === 'sim' || o.row.phase === 'alive';
const before = (a: TimerEntry, b: TimerEntry): boolean => a.dueTick < b.dueTick || (a.dueTick === b.dueTick && a.seq < b.seq);

export class TimerQueue {
  readonly #report: (message: string) => void;
  /** binary min-heap on (dueTick, seq) */
  readonly #heap: Slot[] = [];
  readonly #byId = new Map<string, Slot>();
  #seq = 0;
  #ids = 0;

  constructor(opts: { report?: (message: string) => void } = {}) {
    this.#report = opts.report ?? ((m) => console.error(m));
  }

  /** pending (not cancelled, not fired) timers */
  get size(): number {
    return this.#byId.size;
  }

  /**
   * ctx.after: `module[hookExport](ctx, payload)` at dueTickAfter(nowTick, seconds). Returns the timer id; a missing or
   * non-function export is reported now and the id is never scheduled.
   */
  after(owner: TimerOwner, module: object | null, nowTick: number, seconds: number, hookExport: string, payload?: unknown): string {
    const id = `${TIMER_ID_PREFIX}${++this.#ids}`;
    const fn: unknown = module !== null && typeof hookExport === 'string' ? (module as Record<string, unknown>)[hookExport] : undefined;
    if (typeof fn !== 'function') {
      this.#report(`[${scriptOf(owner)}] ctx.after(${String(seconds)}, ${JSON.stringify(hookExport)}): the module exports no function of that name`);
      return id;
    }
    const entry: TimerEntry = {
      id,
      owner,
      hook: hookExport,
      fn: fn as (...args: never[]) => unknown,
      module: module!,
      payload: cloneWire(payload),
      dueTick: dueTickAfter(nowTick, seconds),
      seq: ++this.#seq,
    };
    const slot: Slot = { entry, cancelled: false };
    this.#byId.set(id, slot);
    this.#push(slot);
    return id;
  }

  /** ctx.cancel; true when a pending timer was cancelled */
  cancel(id: string): boolean {
    const slot = this.#byId.get(id);
    if (!slot) return false;
    slot.cancelled = true;
    this.#byId.delete(id);
    return true;
  }

  /** ctx.getTimers: pending timers in due order, all or one owner's (`'sim'` for sim timers) */
  list(nowTick: number, ownerId?: RowId | 'sim'): TimerInfo[] {
    const out = [...this.#byId.values()]
      .map((s) => s.entry)
      .filter((e) => ownerId === undefined || ownerIdOf(e.owner) === ownerId)
      .sort((a, b) => (before(a, b) ? -1 : before(b, a) ? 1 : 0));
    return out.map((e) => ({
      id: e.id,
      ownerId: ownerIdOf(e.owner),
      dueInTicks: e.dueTick - nowTick,
      dueInSeconds: (e.dueTick - nowTick) / ENGINE.TICK_HZ,
      engineOwned: false,
      hook: e.hook,
    }));
  }

  /** forget every timer of the rows with this id; returns how many */
  dropOwner(rowId: RowId): number {
    return this.#dropWhere((owner) => owner.row.id === rowId);
  }

  /** forget every timer of this row record (its disposal; a new row that reuses the id keeps its own); returns how many */
  dropRow(row: RowRec): number {
    return this.#dropWhere((owner) => owner.row === row);
  }

  #dropWhere(pred: (owner: Extract<TimerOwner, { kind: 'row' }>) => boolean): number {
    let n = 0;
    for (const [id, slot] of this.#byId) {
      const owner = slot.entry.owner;
      if (owner.kind === 'row' && pred(owner)) {
        slot.cancelled = true;
        this.#byId.delete(id);
        n++;
      }
    }
    return n;
  }

  /**
   * Step C: hands every timer due at `tick` to `fire`, in (due tick, creation) order, removing each before it fires; skips
   * cancelled ones (also those cancelled by an earlier callback of the same batch) and those whose owner row is gone.
   * Returns how many fired.
   */
  fireDue(tick: number, fire: (t: TimerEntry) => void): number {
    let n = 0;
    while (this.#heap.length > 0 && this.#heap[0]!.entry.dueTick <= tick) {
      const slot = this.#pop()!;
      if (slot.cancelled) continue;
      this.#byId.delete(slot.entry.id);
      if (!ownerAlive(slot.entry.owner)) continue;
      n++;
      fire(slot.entry);
    }
    return n;
  }

  #push(slot: Slot): void {
    const h = this.#heap;
    h.push(slot);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!before(h[i]!.entry, h[p]!.entry)) break;
      [h[i], h[p]] = [h[p]!, h[i]!];
      i = p;
    }
  }

  #pop(): Slot | undefined {
    const h = this.#heap;
    const top = h[0];
    const last = h.pop();
    if (h.length > 0 && last) {
      h[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < h.length && before(h[l]!.entry, h[m]!.entry)) m = l;
        if (r < h.length && before(h[r]!.entry, h[m]!.entry)) m = r;
        if (m === i) break;
        [h[i], h[m]] = [h[m]!, h[i]!];
        i = m;
      }
    }
    return top;
  }
}
