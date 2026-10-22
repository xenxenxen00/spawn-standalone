// The input log (io §4.3, §4.5; contract §12.2; core §9.8; X-15): what the devices did, delivered per consumer.
//
// Sources push raw device events (keyboard codes, mouse buttons, wheel pulses, look deltas); `sendAction` injects actions. Each
// consumer (`body`: once per sim tick, before `update`; `rig`: once per rendered frame) has its own cursor, so each sees every
// edge exactly once: `pressed` is true if any down transition of the action happened since that consumer's previous delivery,
// even if it was released again in between ("a click can begin and end between two 30 Hz ticks", scripts/player/intent.js:3-4).
// The cursors are kept as per-consumer pending state (edges, look sums, action queues), which is the log trimmed eagerly to the
// oldest cursor; it stays bounded when a consumer does not deliver (a headless run without a rig).
//
// Held levels are global: an action is held while any of its bound device controls is down or the touch layer holds it
// (`sendAction(name, undefined, {down:true})`). Data channels (a `sendAction` with a payload and no `down`) queue per consumer:
// one payload per action per delivery, further sends of the same action wait FIFO for the following deliveries (core §9.8; a lost
// `buy` or `ss_prefs` would be a bug). The rig hears the same flags on its next step (scripts/camera.js `stepSpot`).
//
// Spectating (X-15): `setBlocked('body', true)` blocks every device for the body (keyboard, mouse, wheel, look, touch levels and
// the touch stick: live, no input reaches a spectating body, scripts/ui/keys.js:5-6) while data channels still arrive (the
// spectator bar's buttons are the live path). The rig always hears.
import type { InputsDef, InputState } from '../../compat/core/types.ts';
import { cloneWire } from '../../compat/core/wire.ts';
import { InputMapIndex, buildInputMap } from './input-map.ts';
import { DEFAULT_WHEEL_NOTCH, type InputMapOptions } from './input-options.ts';
import { Look, PITCH_LIMIT, type LookView } from './look.ts';

export type Consumer = 'body' | 'rig';
export const CONSUMERS: readonly Consumer[] = Object.freeze(['body', 'rig']);

/** what the device sources push (`t` = the event's page time, ms; diagnostics only) */
export type RawInputEvent =
  /** a key (`KeyboardEvent.code`) or a mouse button (`mouse:<token>`) going down or up */
  | { type: 'button'; control: string; down: boolean; t?: number }
  /** a press and release in one (a wheel notch: `mouse:wheelUp` / `mouse:wheelDown`) */
  | { type: 'pulse'; control: string; t?: number }
  /** a look delta in px (`mouse`: locked movementX/Y, spike-filtered; `touch`: the look pad with its own `base`) */
  | { type: 'look'; dx: number; dy: number; source?: 'mouse' | 'touch'; base?: number; t?: number };

export interface PointerSample {
  x: number;
  y: number;
  ndcX: number;
  ndcY: number;
}

export interface InputLogOptions {
  /** the effective map (`buildInputMap(world.inputs, settings.binds)`); copied */
  map: InputsDef;
  /** the engine look integration fed by the same look events; one is created when omitted */
  look?: Look;
  /** data channels, arrow aliases, wheel notch (input-options.ts); default PP */
  options?: InputMapOptions;
}

/** more queued payloads of one action than this for one consumer are dropped oldest-first (a consumer that never delivers) */
export const ACTION_QUEUE_CAP = 64;

interface Pending {
  blocked: boolean;
  pressed: Set<string>;
  released: Set<string>;
  lookX: number;
  lookY: number;
  /** `mouse: wheelY` axis sums since the last delivery */
  wheel: Map<string, number>;
  queues: Map<string, unknown[]>;
}

const newPending = (): Pending => ({ blocked: false, pressed: new Set(), released: new Set(), lookX: 0, lookY: 0, wheel: new Map(), queues: new Map() });

function copyPayload(payload: unknown): unknown {
  if (payload === undefined) return undefined;
  try {
    return cloneWire(payload);
  } catch {
    return payload;
  }
}

export class InputLog {
  readonly look: Look;
  #index: InputMapIndex;
  readonly #options: InputMapOptions | undefined;
  readonly #controlsDown = new Set<string>();
  /** actions held by `sendAction(name, _, {down:true})` (the touch layer) */
  readonly #injectedDown = new Set<string>();
  /** the current level of every action (device controls OR injected levels) */
  readonly #held = new Set<string>();
  readonly #axisOverride = new Map<string, number>();
  readonly #pending: Record<Consumer, Pending> = { body: newPending(), rig: newPending() };
  #pointer: PointerSample = { x: 0, y: 0, ndcX: 0, ndcY: 0 };
  #aimView: LookView | undefined;
  #touchSeen = false;
  #touchActive = false;

  constructor(opts: InputLogOptions) {
    this.#options = opts.options;
    this.#index = new InputMapIndex(buildInputMap(opts.map, undefined, this.#options), this.#options);
    this.look = opts.look ?? new Look();
  }

  /** world.inputs as in force (InputPort.declared) */
  get declared(): InputsDef {
    return this.#index.map;
  }

  get index(): InputMapIndex {
    return this.#index;
  }

  /** a rebinding (`settings.binds` changed): actions whose level changes with the new map get their edges */
  setMap(map: InputsDef): void {
    this.#index = new InputMapIndex(buildInputMap(map, undefined, this.#options), this.#options);
    for (const p of CONSUMERS) for (const name of [...this.#pending[p].queues.keys()]) if (!this.#index.isDeclared(name)) this.#pending[p].queues.delete(name);
    for (const name of [...this.#injectedDown]) if (!this.#index.isDeclared(name)) this.#injectedDown.delete(name);
    const names = new Set<string>([...this.#held, ...Object.keys(this.#index.map.actions ?? {})]);
    for (const name of names) this.#refresh(name);
  }

  isBound(control: string): boolean {
    return this.#index.isBound(control);
  }

  isDeclared(action: string): boolean {
    return this.#index.isDeclared(action);
  }

  push(ev: RawInputEvent): void {
    switch (ev.type) {
      case 'button': {
        if (ev.down) {
          if (this.#controlsDown.has(ev.control)) return; // key auto-repeat, or a duplicate source
          this.#controlsDown.add(ev.control);
        } else if (!this.#controlsDown.delete(ev.control)) return;
        for (const name of this.#index.actionsFor(ev.control)) this.#refresh(name);
        return;
      }
      case 'pulse': {
        this.#wheelPulse(ev.control);
        for (const name of this.#index.actionsFor(ev.control)) {
          for (const p of this.#open()) {
            p.pressed.add(name);
            p.released.add(name);
          }
        }
        return;
      }
      case 'look': {
        const opts = { source: ev.source ?? 'mouse', ...(ev.base !== undefined ? { base: ev.base } : {}) } as const;
        if (!this.look.push(ev.dx, ev.dy, opts)) return;
        const d = this.look.deltasFor(ev.dx, ev.dy, ev.base);
        for (const p of this.#open()) {
          p.lookX += d.lookX;
          p.lookY += d.lookY;
        }
        return;
      }
    }
  }

  /**
   * `sendAction`: false (dropped silently) when `name` is not declared. With `down` the action's held level is set or cleared
   * as if a key (the touch layer); otherwise the payload is queued for the next delivery of each consumer (a data channel).
   */
  injectAction(name: string, payload: unknown, down?: boolean): boolean {
    if (!this.#index.isDeclared(name)) return false;
    if (down === true || down === false) {
      if (down) this.#injectedDown.add(name);
      else this.#injectedDown.delete(name);
      this.#refresh(name);
      return true;
    }
    for (const c of CONSUMERS) {
      const q = this.#pending[c].queues;
      let list = q.get(name);
      if (!list) q.set(name, (list = []));
      list.push(copyPayload(payload));
      if (list.length > ACTION_QUEUE_CAP) list.shift();
    }
    return true;
  }

  /** builds `c`'s InputState and advances its cursor; `view` = the presented view for the aim axes (else the last `setAimView`) */
  deliver(c: Consumer, view?: LookView): InputState {
    const p = this.#pending[c];
    const held: Record<string, boolean> = {};
    const pressed: Record<string, boolean> = {};
    const released: Record<string, boolean> = {};
    const actionData: Record<string, unknown> = {};
    if (!p.blocked) for (const name of this.#held) held[name] = true;
    for (const name of p.pressed) pressed[name] = true;
    for (const name of p.released) released[name] = true;
    for (const [name, list] of p.queues) {
      if (list.length === 0) continue;
      const payload = list.shift();
      pressed[name] = true;
      if (payload !== undefined) actionData[name] = payload;
      if (list.length === 0) p.queues.delete(name);
    }
    const axes: Record<string, number> = {};
    for (const axis of this.#index.axisNames()) axes[axis] = 0;
    if (!p.blocked) {
      for (const control of this.#controlsDown) for (const term of this.#index.axisTermsFor(control)) axes[term.axis] = (axes[term.axis] ?? 0) + term.sign;
      for (const axis of Object.keys(axes)) axes[axis] = Math.max(-1, Math.min(1, axes[axis]!));
      for (const [axis, v] of this.#axisOverride) axes[axis] = v;
      for (const [axis, v] of p.wheel) axes[axis] = (axes[axis] ?? 0) + v;
    }
    axes['lookX'] = p.lookX;
    axes['lookY'] = p.lookY;
    const v = view ?? this.#aimView;
    if (v) {
      axes['aimYawSin'] = Math.sin(v.yaw);
      axes['aimYawCos'] = Math.cos(v.yaw);
      axes['aimPitchN'] = v.pitch / PITCH_LIMIT;
    }
    if (this.#touchSeen) {
      axes['touchActive'] = this.#touchActive ? 1 : 0;
      axes['touchTwist'] = 0;
    }
    p.pressed.clear();
    p.released.clear();
    p.lookX = 0;
    p.lookY = 0;
    p.wheel.clear();
    return { axes, held, pressed, released, actions: { ...held }, actionData, pointer: { ...this.#pointer } };
  }

  /** spectating body: devices blocked, data channels pass; edges pending at the block are dropped */
  setBlocked(c: Consumer, blocked: boolean): void {
    const p = this.#pending[c];
    if (p.blocked === blocked) return;
    p.blocked = blocked;
    if (blocked) this.#dropDeviceEdges(p);
  }

  isBlocked(c: Consumer): boolean {
    return this.#pending[c].blocked;
  }

  /** after a pause: device edges and look deltas made meanwhile are dropped; held levels and queued sendAction payloads stay */
  discardEdges(): void {
    for (const c of CONSUMERS) this.#dropDeviceEdges(this.#pending[c]);
    this.look.discardPending();
  }

  /** window blur / page hidden: every held key, button and injected level goes up (with its edges), so nothing sticks */
  releaseDevices(): void {
    for (const control of [...this.#controlsDown]) this.push({ type: 'button', control, down: false });
    for (const name of [...this.#injectedDown]) this.injectAction(name, undefined, false);
    this.#axisOverride.clear();
  }

  /** the touch stick (io §4.8.3) overrides a key-pair axis while it is set; `null` hands the axis back to the keys */
  setAxis(axis: string, value: number | null): void {
    if (value === null) this.#axisOverride.delete(axis);
    else if (Number.isFinite(value)) this.#axisOverride.set(axis, Math.max(-1, Math.min(1, value)));
  }

  /** the cursor in canvas px and NDC; the canvas centre while locked */
  setPointer(p: PointerSample): void {
    this.#pointer = { x: p.x, y: p.y, ndcX: p.ndcX, ndcY: p.ndcY };
  }

  /** the presented view the rig host publishes each frame (io §5.1 step 7), for `aimYawSin/aimYawCos/aimPitchN` */
  setAimView(view: LookView | undefined): void {
    this.#aimView = view ? { yaw: view.yaw, pitch: view.pitch } : undefined;
  }

  get touchActive(): boolean {
    return this.#touchActive;
  }

  /** touch becomes the live input (`touchActive` 1); a key or mouse move switches back (0). Never written on desktop. */
  setTouchActive(on: boolean): void {
    if (!on && !this.#touchSeen) return;
    this.#touchSeen = true;
    this.#touchActive = on;
  }

  /** the consumers that hear devices now */
  #open(): Pending[] {
    return CONSUMERS.map((c) => this.#pending[c]).filter((p) => !p.blocked);
  }

  #dropDeviceEdges(p: Pending): void {
    p.pressed.clear();
    p.released.clear();
    p.lookX = 0;
    p.lookY = 0;
    p.wheel.clear();
  }

  /** a wheel notch moves every axis declared `mouse: wheelY` (+ is wheel up) for the consumers that hear devices */
  #wheelPulse(control: string): void {
    const dir = control === 'mouse:wheelUp' ? 1 : control === 'mouse:wheelDown' ? -1 : 0;
    if (dir === 0) return;
    const notch = (this.#options?.wheelNotch ?? DEFAULT_WHEEL_NOTCH) * dir;
    for (const axis of this.#index.wheelAxes()) for (const p of this.#open()) p.wheel.set(axis, (p.wheel.get(axis) ?? 0) + notch);
  }

  /** recomputes one action's level; a change is an edge for every consumer that hears devices */
  #refresh(name: string): void {
    let level = this.#injectedDown.has(name);
    if (!level) for (const control of this.#index.controlsOf(name)) if (this.#controlsDown.has(control)) level = true;
    if (level === this.#held.has(name)) return;
    if (level) this.#held.add(name);
    else this.#held.delete(name);
    for (const p of this.#open()) (level ? p.pressed : p.released).add(name);
  }
}
