// The sim ctx (docs/design/core-runtime.md §7.3; contract §7.3; mp §11.2): what `tick(ctx)` of the root sim (`sim.js`, the
// Director) and of a place sim (`places/<p>/sim.js`) receives, every third tick. Created once per sim and reused.
//
// Everything of GameCtx and NO `self`. It runs on the platform VM: `session` is the platform session, reads are platform
// reads (X-24: the body's local rows are invisible; `isLocal` is false), `getObject` answers for any resident row of any
// place, a place-less `query` searches the sim's own place.
//   place    the root sim: `world.places[world.defaultPlace]` [INF authored module]; a place sim: its own place
//   gapMs    never set (no always-on sleep in a page)
//   spawn    unowned (`spawnerId = null`), on the platform VM
//   emit     `meta.sourceId` is null: the Director's validation treats a missing source as trusted
//            (authored module)
//   on/after the sim owns its listeners and timers (`getTimers('sim')`)
import type { PlaceHandle, SimCtx, SimInstance } from '../types.ts';
import { GameCtxBase, ignoreCtxWrites, type CtxKernel, type CtxShared } from './common.ts';

export class SimCtxImpl extends GameCtxBase {
  readonly #s: CtxShared;
  readonly #sim: SimInstance;

  constructor(shared: CtxShared, sim: SimInstance) {
    super(shared, { kind: 'sim', sim }, { kind: 'sim', sim }, sim.path, 'platform');
    this.#s = shared;
    this.#sim = sim;
  }

  get kind(): 'sim' {
    return 'sim';
  }

  get place(): PlaceHandle {
    return this.#s.place(this.#sim.place ?? this.#s.k.worldConfig.defaultPlace, 'platform');
  }
}

ignoreCtxWrites(SimCtxImpl);

/** core §7.3: `sim.place` is null for the root sim, the place id for a place sim; the caller stores the result in `sim.ctx` */
export function createSimCtx(k: CtxKernel, sim: SimInstance): SimCtx {
  return new SimCtxImpl(k.ctx, sim) as unknown as SimCtx;
}
