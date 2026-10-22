// The behavior ctx (docs/design/core-runtime.md §7.2; contract §4.1, §5, §8.1): what `onSpawn(ctx)`, `update(ctx, dt)`,
// `onInput(ctx, input)`, `onDestroy(ctx)`, `onTriggerEnter(ctx, other)`, `onOutOfBounds(ctx, event)`, the declared `ears` and
// `ctx.on` handlers `(ctx, payload, meta)` and the `ctx.after` callbacks `(ctx, payload)` of one behavior instance receive.
// Created once per instance (lifecycle.ts binds it into `inst.ctx`) and reused for every call.
//
//   self      the row's handle for the row's VM
//   state     an alias of `self.state` (assigning replaces it)
//   place     the handle of the row's CURRENT place, resolved on each read (rows cross)
//   player    the human's PlayerView when the row runs on the client VM, else null (contract §4.1: "the player this code runs
//             for"; scripts/audio/music-director.js:31 falls back to `world.players.find(isLocal)`)
//   sleep     the instance sleeps from this tick (sched/sleep.ts) and the call returns at once: callers write
//             `ctx.sleep(); return` and `return ctx.sleep(30)`
// Every verb acts for `{ kind: 'row', row, behavior: inst }`: spawns are owned by the row and land on its VM, `emit` carries
// the row id as `meta.sourceId`, reads are made from the row's VM (X-24), listeners and timers belong to the instance.
import { sleepFor } from '../sched/sleep.ts';
import type { BehaviorCtx, BehaviorInstance, ObjectView, PlaceHandle, PlayerView, RowRec } from '../types.ts';
import { GameCtxBase, ignoreCtxWrites, type CtxKernel, type CtxShared } from './common.ts';

export class BehaviorCtxImpl extends GameCtxBase {
  readonly #s: CtxShared;
  readonly #row: RowRec;
  declare sleep: (seconds?: number) => void;

  constructor(shared: CtxShared, row: RowRec, inst: BehaviorInstance) {
    super(shared, { kind: 'row', row, behavior: inst }, { kind: 'row', row, inst }, inst.path, row.vm);
    this.#s = shared;
    this.#row = row;
    const clock = shared.k.clock;
    this.sleep = (seconds) => {
      sleepFor(inst, clock.tick, seconds);
    };
  }

  get kind(): 'behavior' | 'rig' {
    return 'behavior';
  }

  get self(): ObjectView {
    const row = this.#row;
    return this.#s.k.store.handle(row, row.vm);
  }

  get state(): Record<string, unknown> {
    return this.self.state;
  }
  set state(v: Record<string, unknown>) {
    this.self.state = v;
  }

  get place(): PlaceHandle {
    const row = this.#row;
    return this.#s.place(row.place ?? this.#s.k.worldConfig.defaultPlace, row.vm);
  }

  get player(): PlayerView | null {
    if (this.#row.vm !== 'client') return null;
    const store = this.#s.k.store;
    const body = store.get(this.#s.k.ids.humanBody);
    return body !== undefined && body.player !== null ? (store.handle(body, 'client') as PlayerView) : null;
  }
}

ignoreCtxWrites(BehaviorCtxImpl);

/** core §7.2 */
export function createBehaviorCtx(k: CtxKernel, row: RowRec, inst: BehaviorInstance): BehaviorCtx {
  return new BehaviorCtxImpl(k.ctx, row, inst) as unknown as BehaviorCtx;
}
