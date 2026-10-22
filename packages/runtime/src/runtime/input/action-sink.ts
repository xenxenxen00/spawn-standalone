// sendAction routing (io §4.5, §3.6; core §9.8, §15.7; X-15) and the kernel's InputPort.
//
// `window.sendAction(name, payload, {down, relockPointer})` (the page API) and `kernel.sendAction` both end in
// `ActionSink.inject`: an undeclared name is dropped silently (contract §12.2); `relockPointer` asks the pointer-lock manager for
// the lock synchronously, inside the click that closed a modal (every caller is an inline `onclick`, a user gesture); `down`
// sets or clears a held level as if a key (the touch layer); anything else is a data channel payload for the next delivery
// (`ss_req`, `ss_ui`, `ss_prefs`, `ss_seen`: one payload per channel per delivery, the rest FIFO).
//
// `InputPortImpl` is the `InputPort` the kernel samples: `sampleTick()` is the body delivery (tick step B), `sampleRig()` the
// rig's per-frame delivery (frame step 2).
import type { InputPort } from '../../compat/core/ports.ts';
import type { InputsDef, InputState } from '../../compat/core/types.ts';
import { InputLog, type Consumer } from './input-log.ts';
import type { InputMapOptions } from './input-options.ts';
import type { Look } from './look.ts';

export interface SendActionOptions {
  down?: boolean;
  relockPointer?: boolean;
}

/** the part of the PointerLockManager the sink needs */
export interface LockRequester {
  requestLock(origin: 'ui'): void;
}

export class ActionSink {
  readonly log: InputLog;
  #pointer: LockRequester | null;

  constructor(log: InputLog, pointer: LockRequester | null = null) {
    this.log = log;
    this.#pointer = pointer;
  }

  /** the pointer-lock manager exists once the canvas does (compose order) */
  setPointer(pointer: LockRequester | null): void {
    this.#pointer = pointer;
  }

  /** true when the action was accepted; false when it is not declared (dropped silently) */
  inject(name: string, payload?: unknown, opts?: SendActionOptions): boolean {
    // the click closed a panel: re-lock inside this gesture whatever the action (the lock is the player's intent, not the data)
    if (opts?.relockPointer === true) this.#pointer?.requestLock('ui');
    return this.log.injectAction(String(name), payload, opts?.down);
  }
}

export class InputPortImpl implements InputPort {
  readonly log: InputLog;
  readonly sink: ActionSink;

  constructor(log: InputLog, sink: ActionSink) {
    this.log = log;
    this.sink = sink;
  }

  get declared(): InputsDef {
    return this.log.declared;
  }

  sampleTick(): InputState {
    return this.log.deliver('body');
  }

  sampleRig(): InputState {
    return this.log.deliver('rig');
  }

  injectAction(name: string, payload: unknown, opts?: SendActionOptions): boolean {
    return this.sink.inject(name, payload, opts);
  }

  setBlocked(consumer: Consumer, blocked: boolean): void {
    this.log.setBlocked(consumer, blocked);
  }

  discardEdges(): void {
    this.log.discardEdges();
  }
}

export interface InputStack {
  log: InputLog;
  sink: ActionSink;
  port: InputPortImpl;
}

/** the composition root's one call: log + sink + kernel port over the effective map */
export function createInputPort(opts: { map: InputsDef; look?: Look; pointer?: LockRequester | null; options?: InputMapOptions }): InputStack {
  const log = new InputLog({ map: opts.map, ...(opts.look ? { look: opts.look } : {}), ...(opts.options ? { options: opts.options } : {}) });
  const sink = new ActionSink(log, opts.pointer ?? null);
  return { log, sink, port: new InputPortImpl(log, sink) };
}
