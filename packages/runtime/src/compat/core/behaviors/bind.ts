// Behavior instances: module + ctx + ears + schedule + health (docs/design/core-runtime.md §2 behaviors/bind.ts, §4.1, §8.1,
// §9.4, §12.4).
//
// The lifecycle (C1b) binds one instance per behavior path of a spawned row, in spec order, before the row's onSpawn is
// queued. Binding compiles the module's `updateSchedule` for (row id, path) (sched/schedule.ts), reads its `ears` once (a
// computed object is fine: `authored module` builds it with Object.fromEntries) and registers them as declared
// listeners, and creates the instance's ctx once through the ctx factory (C5), so the ctx a hook gets is stable for the
// owner's life (the game keeps `k.ctx` in kits). A behavior whose module is not loaded yet binds late (core §12.4): the
// instance is created with `pendingModule` and completed by completeBind when the registry delivers the module.
import type { BehaviorCtx, BehaviorInstance, BehaviorModule, EarHandler, RigCtx, RowRec, TreePath } from '../types.ts';
import { compileSchedule, EVERY_TICK } from '../sched/schedule.ts';
import type { ListenerRegistry } from '../events/listeners.ts';

export interface BindEnv {
  readonly listeners: ListenerRegistry;
  /** C5: the instance's ctx, created once per instance (behavior ctx, or the rig ctx for the camera rig) */
  readonly ctxFor?: ((row: RowRec, inst: BehaviorInstance) => BehaviorCtx | RigCtx) | undefined;
  /** dev notes (non-function ears, hooks the engine never calls) */
  readonly report?: ((message: string) => void) | undefined;
}

/** engine hooks that no live module exports in a way the engine calls: recognised and ignored with a one-time note (core §7.2) */
export const IGNORED_HOOKS = Object.freeze([
  'onCollide',
  'onTriggerExit',
  'onCross',
  'onRefuse',
  'onLiquidEnter',
  'onLiquidExit',
  'onSay',
  'onSoundEnd',
  'onAnimationEvent',
  'onJointBreak',
  'onControlBegin',
  'onControlEnd',
  'editor',
  'visual',
] as const);

const noted = new WeakSet<object>();

/** a module's declared ears, read once: own enumerable function-valued entries, frozen; null when there are none */
export function readEars(module: BehaviorModule, path: TreePath, report?: (message: string) => void): Readonly<Record<string, EarHandler>> | null {
  const ears: unknown = module.ears;
  if (ears === undefined || ears === null) return null;
  if (typeof ears !== 'object') {
    report?.(`[${path}] export const ears is not an object; ignored`);
    return null;
  }
  const out: Record<string, EarHandler> = {};
  for (const name of Object.keys(ears)) {
    const h: unknown = (ears as Record<string, unknown>)[name];
    if (typeof h === 'function') out[name] = h as EarHandler;
    else report?.(`[${path}] ears.${name} is not a function; ignored`);
  }
  return Object.keys(out).length > 0 ? Object.freeze(out) : null;
}

function attach(row: RowRec, inst: BehaviorInstance, module: BehaviorModule, env: BindEnv): void {
  inst.module = module;
  inst.pendingModule = false;
  inst.schedule = compileSchedule(module.updateSchedule, row.id, inst.path);
  inst.ears = readEars(module, inst.path, env.report);
  if (inst.ears) {
    const owner = { kind: 'row' as const, row, inst };
    for (const [name, handler] of Object.entries(inst.ears)) env.listeners.add(owner, name, handler, { declared: true });
  }
  if (env.report && !noted.has(module)) {
    noted.add(module);
    const unused = IGNORED_HOOKS.filter((h) => typeof (module as Record<string, unknown>)[h] === 'function');
    if (unused.length > 0) env.report(`[${inst.path}] exports ${unused.join(', ')}: recognised, never called in this build`);
  }
}

/** creates the instance of `path` on `row`; `module` null binds late (completeBind) */
export function bindBehavior(row: RowRec, path: TreePath, module: BehaviorModule | null, env: BindEnv): BehaviorInstance {
  const inst: BehaviorInstance = {
    path,
    module: null,
    pendingModule: module === null,
    ctx: null,
    ears: null,
    schedule: EVERY_TICK,
    sleeping: null,
    health: new Map(),
  };
  if (module !== null) attach(row, inst, module, env);
  inst.ctx = env.ctxFor ? env.ctxFor(row, inst) : null;
  return inst;
}

/** late binding (core §12.4): the module arrived; the row's onSpawn may run once every instance is bound (C1b) */
export function completeBind(row: RowRec, inst: BehaviorInstance, module: BehaviorModule, env: BindEnv): void {
  if (!inst.pendingModule) throw new Error(`completeBind: ${row.id} ${inst.path} is already bound`);
  attach(row, inst, module, env);
}

/** the row is disposed: every listener it owns goes; returns how many */
export function unbindRow(row: RowRec, env: Pick<BindEnv, 'listeners'>): number {
  return env.listeners.removeRow(row);
}
