// The camera rig ctx and `kernel.stepRig` (docs/design/core-runtime.md §7.4, §3.7; docs/architecture.md X-09; contract
// §11.2-11.3; io §5.1-5.2).
//
// The rig is a row (`camera/local`, client VM, `templates/camera.js#camera`), excluded from queries and from the 30 Hz update
// list. Its ctx is a behavior ctx whose `self` is the RigView (store/handles.ts RigHandle: `target`, `view`, the rig layer
// fields) and whose `place` is the target body's place. `world.camera` is the camera port's; `session` is the client VM's
// (the rig reads `session.ui`, `ssSpot`, writes `ssSpotName` / `ssSpotCount`); `now()` is the sim clock (30 Hz steps), the rig
// keeps its own time from `dt`.
//
// stepRig(dtS, input) is called by the camera domain's RigHost once per rendered frame (X-09): it runs the rig behavior's
// `onInput(ctx, input)` and then `update(ctx, dtS)` through the guarded hook invoker (D-CORE-15) and returns the TOP-LEVEL
// keys of the rig row's `state` that were assigned / deleted during the call. That record is how the RigHost knows which
// axes the rig owns this frame (an axis written is the rig's; stop writing, or `delete state.yaw`, to release it), so an
// assignment of an EQUAL value counts as written too: the step listens through a synchronous every-write state channel
// for its duration, not through the change list (an equal write makes no change record). A nested write (`state.a.b = 1`)
// counts `a`; assigning undefined or deleting a key counts as deleted; a whole-`state` assignment is not a key write.
// The rig does not run while the clock is paused, before its onSpawn ran, or when there is no rig row: empty sets, no hooks.
// `hideLocalPlayer` is per step: the RigHost clears it before each call, this module does not.
import { ENGINE } from '../rules.ts';
import { wakeRow } from '../sched/sleep.ts';
import type { BehaviorInstance, InputState, PlaceHandle, RigCtx, RigView, RowRec } from '../types.ts';
import { BehaviorCtxImpl } from './behavior.ts';
import { ignoreCtxWrites, type CtxKernel, type CtxShared } from './common.ts';

export class RigCtxImpl extends BehaviorCtxImpl {
  readonly #s: CtxShared;
  readonly #row: RowRec;

  constructor(shared: CtxShared, row: RowRec, inst: BehaviorInstance) {
    super(shared, row, inst);
    this.#s = shared;
    this.#row = row;
  }

  override get kind(): 'rig' {
    return 'rig';
  }

  override get self(): RigView {
    const row = this.#row;
    return this.#s.k.store.handle(row, row.vm) as RigView;
  }

  /** the target body's place; the rig row's own while it follows nothing */
  override get place(): PlaceHandle {
    const s = this.#s;
    const row = this.#row;
    const targetId = row.rig?.targetId ?? null;
    const target = targetId !== null ? s.k.store.get(targetId) : undefined;
    return s.place(target?.place ?? row.place ?? s.k.worldConfig.defaultPlace, row.vm);
  }
}

ignoreCtxWrites(RigCtxImpl);

/** core §7.4: the ctx of the camera rig row's behavior instance */
export function createRigCtx(k: CtxKernel, row: RowRec, inst: BehaviorInstance): RigCtx {
  return new RigCtxImpl(k.ctx, row, inst) as unknown as RigCtx;
}

export interface RigStepResult {
  wrote: ReadonlySet<string>;
  deleted: ReadonlySet<string>;
}

/** core §3.7 `kernel.stepRig` */
export function stepRig(k: CtxKernel, dtS: number, input: InputState): RigStepResult {
  const wrote = new Set<string>();
  const deleted = new Set<string>();
  const row = k.store.get(k.ids.cameraRig);
  if (row === undefined || row.rig === null || row.phase !== 'alive' || row.pendingSpawnHooks || !k.clock.running) return { wrote, deleted };
  // the caller clamps; a non-finite or negative dt never reaches the game
  const dt = Number.isFinite(dtS) ? Math.min(Math.max(dtS, 0), ENGINE.RIG_DT_MAX_S) : 0;
  const off = k.store.channels.register({
    field: 'state',
    everyWrite: true,
    sync: true,
    onWrite(r, value, _prev, path) {
      if (r !== row || path.length === 0) return;
      const key = String(path[0]);
      if (path.length === 1 && value === undefined) {
        wrote.delete(key);
        deleted.add(key);
      } else {
        deleted.delete(key);
        wrote.add(key);
      }
    },
  });
  try {
    const inv = k.time.invoker;
    // an input delivery wakes the row's sleepers (core §9.5)
    wakeRow(row);
    for (const inst of row.behaviors) {
      if (row.phase !== 'alive') break;
      const f = inst.module?.onInput;
      if (typeof f === 'function') inv.call({ kind: 'row', row, inst }, 'onInput', f, [inst.ctx, input], inst.module);
    }
    for (const inst of row.behaviors) {
      if (row.phase !== 'alive') break;
      const f = inst.module?.update;
      if (typeof f === 'function') inv.call({ kind: 'row', row, inst }, 'update', f, [inst.ctx, dt], inst.module);
    }
  } finally {
    off();
  }
  return { wrote, deleted };
}
