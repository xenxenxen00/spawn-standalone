// ctx.sleep(seconds?) (docs/design/core-runtime.md §9.5; contract §5.8; engine api:344).
//
// The calling behavior instance sleeps: the scheduler skips its `update` (only update: its ears and timers still run). It wakes
//   - at its tick, when seconds were given (tick + ceil(seconds·30));
//   - on a script write to its row from any other invoker (another behavior of the row, another row, a sim): the store's
//     writeProp calls wakeForWrite with the current invoker (behaviors/invoke.ts HookInvoker.current);
//   - when the row's parent changes, or when onInput is delivered to the row (wakeRow; the scheduler wakes the body at step B).
// Engine writebacks (physics transforms, invoker 'engine') and the UI realm (read-only, 'ui') never wake.
import { ENGINE } from '../rules.ts';
import type { BehaviorInstance, Invoker, RowRec } from '../types.ts';

/** float slack for seconds·30 (4.1·30 is 122.99999999999999) */
const TICK_EPS = 1e-6;

/** ticks a sleep of `seconds` lasts, or null for an open sleep (no seconds, or not a finite number) */
export function sleepTicks(seconds: unknown): number | null {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return null;
  if (seconds <= 0) return 0;
  return Math.max(0, Math.ceil(seconds * ENGINE.TICK_HZ - TICK_EPS));
}

/** ctx.sleep: put the instance to sleep from `tick`; returns at once (callers write `ctx.sleep(); return`) */
export function sleepFor(inst: BehaviorInstance, tick: number, seconds?: unknown): void {
  const n = sleepTicks(seconds);
  inst.sleeping = { untilTick: n === null ? null : tick + n };
}

/** whether the instance still sleeps at `tick`; a timed sleep that is over is cleared here */
export function sleepingNow(inst: BehaviorInstance, tick: number): boolean {
  const s = inst.sleeping;
  if (s === null) return false;
  if (s.untilTick !== null && tick >= s.untilTick) {
    inst.sleeping = null;
    return false;
  }
  return true;
}

/** wakes one instance; true when it was asleep */
export function wakeInstance(inst: BehaviorInstance): boolean {
  if (inst.sleeping === null) return false;
  inst.sleeping = null;
  return true;
}

/** a parent change or an onInput delivery: every sleeper of the row wakes; returns how many */
export function wakeRow(row: RowRec): number {
  let n = 0;
  for (const inst of row.behaviors) if (wakeInstance(inst)) n++;
  return n;
}

/**
 * A script write landed on `row`: every sleeping behavior of the row wakes except the writer itself (the behavior that is
 * `invoker`). Engine and UI invokers wake nothing. Returns how many woke.
 */
export function wakeForWrite(row: RowRec, invoker: Invoker): number {
  if (invoker === 'engine' || invoker === 'ui') return 0;
  const self = 'row' in invoker && invoker.row === row.id ? invoker.behavior : null;
  let n = 0;
  for (const inst of row.behaviors) {
    if (inst.sleeping === null || inst.path === self) continue;
    inst.sleeping = null;
    n++;
  }
  return n;
}
