// Guarded hook calls and behaviorHealth (docs/design/core-runtime.md §2 behaviors/invoke.ts, D-CORE-15, §8.5; engine
// api:691-703 BehaviorHookHealth; contract §5.11).
//
// Every carried hook (onSpawn, update, onInput, onDestroy, onTriggerEnter, onOutOfBounds, ears, ctx.on handlers, ctx.after
// callbacks, sim ticks) is called through HookInvoker.call: a throw is counted (metrics.hookErrors), recorded in the owner's
// health map ({hook, script, error, line, tick, running: 'running', count}) and reported, rate-limited to one line per
// (script, hook, message) per 5 s with the count of the rest; the hook keeps being called and nothing else is affected.
// The invoker also knows who is running (`current`): the writer the store attributes a write to (core §5.3), which decides
// sleep wakes (sched/sleep.ts). Outside any hook the writer is the engine.
import { ENGINE } from '../rules.ts';
import type { BehaviorHookHealth, BehaviorInstance, CallerRef, Invoker, KernelMetrics, RowRec, SimInstance } from '../types.ts';

/** the owner of a hook, a listener or a timer: a behavior instance of a row, or a sim */
export type HookOwner = { readonly kind: 'row'; readonly row: RowRec; readonly inst: BehaviorInstance } | { readonly kind: 'sim'; readonly sim: SimInstance };

/** the writer identity of an owner (core §5.3 Invoker) */
export function invokerOf(owner: HookOwner): Invoker {
  return owner.kind === 'row' ? { row: owner.row.id, behavior: owner.inst.path } : { sim: owner.sim.id };
}

/** the owner a kernel verb's caller stands for, or null for the scene loader and the kernel itself */
export function ownerOfCaller(caller: CallerRef): HookOwner | null {
  if (caller.kind === 'row') return { kind: 'row', row: caller.row, inst: caller.behavior };
  if (caller.kind === 'sim') return { kind: 'sim', sim: caller.sim };
  return null;
}

/** the script path a report names */
export function scriptOf(owner: HookOwner): string {
  return owner.kind === 'row' ? owner.inst.path : owner.sim.path;
}

/** the ctx the owner's hooks receive (created once per owner by the ctx factories, core §7) */
export function ctxOf(owner: HookOwner): unknown {
  return owner.kind === 'row' ? owner.inst.ctx : owner.sim.ctx;
}

function healthMapOf(owner: HookOwner): Map<string, BehaviorHookHealth> {
  return owner.kind === 'row' ? owner.inst.health : owner.sim.health;
}

/** `ObjectView.behaviorHealth`: every broken hook of the row's behaviors, or undefined while none is */
export function behaviorHealthOf(row: RowRec): { broken: BehaviorHookHealth[] } | undefined {
  const broken: BehaviorHookHealth[] = [];
  for (const inst of row.behaviors) for (const h of inst.health.values()) broken.push({ ...h });
  return broken.length > 0 ? { broken } : undefined;
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return typeof err === 'string' ? err : String(err);
  } catch {
    return 'unprintable error';
  }
}

/** `file:line:col` of the first stack frame, when the error carries one */
export function errorLine(err: unknown): string | undefined {
  const stack = err instanceof Error ? err.stack : undefined;
  if (!stack) return undefined;
  for (const line of stack.split('\n').slice(1)) {
    const m = /\(?([^\s()]+:\d+:\d+)\)?\s*$/.exec(line.trim());
    if (m) return m[1];
  }
  return undefined;
}

export interface InvokeOptions {
  readonly metrics: Pick<KernelMetrics, 'hookErrors'>;
  /** the current tick (recorded in BehaviorHookHealth.tick) */
  tick(): number;
  /** where a (rate-limited) report goes; default console.error */
  report?: ((line: string, error: unknown) => void) | undefined;
  /** ms for the rate limit; default Date.now (log timing never touches the simulation) */
  wallClock?: (() => number) | undefined;
}

interface ReportState {
  at: number;
  suppressed: number;
}

/** report keys kept before the expired ones are swept */
const REPORT_KEYS_MAX = 1024;

export class HookInvoker {
  readonly #metrics: Pick<KernelMetrics, 'hookErrors'>;
  readonly #tick: () => number;
  readonly #report: (line: string, error: unknown) => void;
  readonly #wall: () => number;
  readonly #stack: Invoker[] = [];
  /** the hook name of each `#stack` entry (null for an `as` scope) */
  readonly #hooks: Array<string | null> = [];
  readonly #reports = new Map<string, ReportState>();

  constructor(opts: InvokeOptions) {
    this.#metrics = opts.metrics;
    this.#tick = opts.tick;
    this.#report = opts.report ?? ((line, error) => console.error(line, error));
    this.#wall = opts.wallClock ?? Date.now;
  }

  /** the writer of the hook running now; 'engine' outside any hook */
  get current(): Invoker {
    return this.#stack.length > 0 ? this.#stack[this.#stack.length - 1]! : 'engine';
  }

  /** hooks running (nested calls count) */
  get depth(): number {
    return this.#stack.length;
  }

  /** the name of the innermost hook running now (`onOutOfBounds`, `update`, …); null outside any hook or inside an `as` scope */
  get currentHook(): string | null {
    return this.#hooks.length > 0 ? this.#hooks[this.#hooks.length - 1]! : null;
  }

  /**
   * Calls `fn(...args)` (with `thisArg`, the module, as live engines call `module.update(ctx, dt)`) as `owner`'s `hook`.
   * Returns true when it returned normally, false when it threw (recorded and reported; never rethrown).
   */
  call(owner: HookOwner, hook: string, fn: (...args: never[]) => unknown, args: readonly unknown[], thisArg?: unknown): boolean {
    this.#stack.push(invokerOf(owner));
    this.#hooks.push(hook);
    try {
      Reflect.apply(fn, thisArg, args);
      return true;
    } catch (err) {
      this.#failed(owner, hook, err);
      return false;
    } finally {
      this.#stack.pop();
      this.#hooks.pop();
    }
  }

  /** runs `fn` with `who` as the current writer (the UI realm, an engine write, a test); rethrows */
  as<T>(who: Invoker, fn: () => T): T {
    this.#stack.push(who);
    this.#hooks.push(null);
    try {
      return fn();
    } finally {
      this.#stack.pop();
      this.#hooks.pop();
    }
  }

  #failed(owner: HookOwner, hook: string, err: unknown): void {
    this.#metrics.hookErrors++;
    const script = scriptOf(owner);
    const error = messageOf(err);
    const health = healthMapOf(owner);
    const prev = health.get(hook);
    const line = errorLine(err);
    health.set(hook, {
      hook,
      script,
      error,
      ...(line !== undefined ? { line } : {}),
      tick: this.#tick(),
      running: 'running',
      count: (prev?.count ?? 0) + 1,
    });
    const key = `${script}\u0000${hook}\u0000${error}`;
    const now = this.#wall();
    const st = this.#reports.get(key);
    if (st && now - st.at < ENGINE.LOG_REPEAT_MS) {
      st.suppressed++;
      return;
    }
    const more = st && st.suppressed > 0 ? ` (${st.suppressed} more since the last report)` : '';
    if (this.#reports.size >= REPORT_KEYS_MAX) {
      // messages that carry ids or numbers make new keys: forget the ones whose window is over
      for (const [k, s] of this.#reports) if (now - s.at >= ENGINE.LOG_REPEAT_MS) this.#reports.delete(k);
    }
    this.#reports.set(key, { at: now, suppressed: 0 });
    this.#report(`[${script}] ${hook} threw: ${error}${more}`, err);
  }
}
