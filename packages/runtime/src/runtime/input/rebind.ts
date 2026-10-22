// Binding capture (io §4.7; system-ui.md §3.7a.5): the runtime side of the CONTROLS
// rebind buttons installed by E-UI-04.
//
// The game calls the page globals `ssBind(actionId, slot)` / `ssBindReset()`. This
// module owns the capture state machine: the next keydown (not Escape/Delete),
// pointer button 0-4 or wheel pulse becomes the new token; Escape cancels; Delete
// clears the slot. A token already used by another action is swapped onto it and
// both rows flash (FLASH_MS). The result is written to `settings.binds` (overrides
// only) through the binds store, and the effective input map is rebuilt with
// buildInputMap over the live world inputs.
//
// Slots are positional over an action's flat binding list [...keys, mouse?]; an
// 'axis:<id>' target exposes its two key halves as slots 0/1 (key tokens only: an
// axis pair cannot have an empty half, so Delete is refused while capturing one).
//
// While capturing, keyDown/pointerDown/wheel return 'consumed' so the DOM wiring
// can stopImmediatePropagation the event and no game action fires (§4.7).

import {
  buildInputMap,
  codesForToken,
  isMouseToken,
  tokenLabel,
  type BindOverrides,
  type MouseToken,
} from './input-map.ts';
import { bindingLessActions } from './input-options.ts';
import type { InputActionDef, InputAxisDef, InputsDef } from '../../compat/core/types.ts';

/** the capture prompt the CONTROLS row shows while a keycap waits for its new token */
export const CAPTURE_PROMPT = 'PRESS A KEY · ESC CANCELS · DEL CLEARS';
/** both swapped rows flash this long (§4.7) */
export const FLASH_MS = 450;

/** where the overrides live: `settings.binds` through the profile store */
export interface BindsStore {
  binds: BindOverrides;
  /** persist the overrides (the profile store's write-through) */
  save(): void;
}

export interface RebindDeps {
  /** the live world inputs (world.config.yaml); never mutated */
  live: InputsDef;
  store: BindsStore;
  /** replace the effective inputs (ctx.world.inputs) with the rebuilt map */
  setInputs(inputs: InputsDef): void;
  /** flash the two swapped rows for FLASH_MS; the UI owns the timing */
  flash?(a: string, b: string): void;
  /** observe capture open/close; installRebind publishes it as window.ssCapture */
  onCapture?(target: CaptureTarget | null): void;
}

/** what ssBind(actionId, slot) targets */
export interface CaptureTarget {
  action: string;
  slot: number;
}

/** pointer button index → mouse token (io §4.2: 0 left, 1 middle, 2 right, 3 mouse4, 4 mouse5) */
const BUTTON_TOKENS: readonly MouseToken[] = ['left', 'middle', 'right', 'mouse4', 'mouse5'];

const MOUSE_LABELS: Readonly<Record<MouseToken, string>> = {
  left: 'LEFT CLICK',
  right: 'RIGHT CLICK',
  middle: 'MIDDLE CLICK',
  mouse4: 'MOUSE 4',
  mouse5: 'MOUSE 5',
  wheelUp: 'WHEEL UP',
  wheelDown: 'WHEEL DOWN',
};

/** a captured token as printed on a keycap: codes (KeyE → E), mouse and wheel words */
export function labelForToken(token: string, layout?: ReadonlyMap<string, string>): string {
  if (isMouseToken(token)) return MOUSE_LABELS[token];
  return tokenLabel(token, layout);
}

const has = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const isAxisTarget = (t: string): boolean => t.startsWith('axis:');

/** an action's flat binding list over one map: [...keys, mouse?] */
function flatAction(a: InputActionDef | undefined): string[] {
  if (!a) return [];
  const out = Array.isArray(a.keys) ? [...a.keys] : [];
  if (typeof a.mouse === 'string' && isMouseToken(a.mouse)) out.push(a.mouse);
  return out;
}

/** an axis's flat binding list: [neg, pos] */
function flatAxis(a: InputAxisDef | undefined): string[] {
  if (!a || typeof a.keys !== 'string') return [];
  const parts = a.keys.split('/');
  return parts.length === 2 && parts[0] && parts[1] ? [parts[0], parts[1]] : [];
}

/** the flat binding list of a rebindable target over one map, or null when not rebindable */
function flatOf(map: InputsDef, target: string, dataChannels = bindingLessActions(map)): string[] | null {
  if (isAxisTarget(target)) {
    const id = target.slice(5);
    if (!map.axes || !has(map.axes, id)) return null;
    return flatAxis(map.axes[id]);
  }
  if (dataChannels.includes(target)) return null;
  if (!map.actions || !has(map.actions, target)) return null;
  return flatAction(map.actions[target]);
}

const eqStr = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * The physical codes a token stands for: key tokens by the token grammar (so the
 * live Spawn token 'q' and the captured code 'KeyQ' are the same physical key;
 * AZERTY players keep their positions), mouse tokens only themselves.
 */
function tokenCodes(token: string): string[] {
  return isMouseToken(token) ? [token] : codesForToken(token);
}

const samePhysical = (a: string, b: string): boolean => {
  const ac = tokenCodes(a);
  return tokenCodes(b).some((c) => ac.includes(c));
};

/** whoever else holds the token, by physical key (actions first, then axis halves for key tokens) */
function findHolder(
  eff: InputsDef,
  token: string,
  exceptAction: string,
  exceptSlot: number,
  dataChannels: readonly string[],
): { target: string; index: number } | null {
  const actions = eff.actions ?? {};
  for (const id of Object.keys(actions)) {
    if (dataChannels.includes(id)) continue;
    const i = flatAction(actions[id]).findIndex((c) => samePhysical(c, token));
    if (i >= 0 && !(id === exceptAction && i === exceptSlot)) return { target: id, index: i };
  }
  if (!isMouseToken(token)) {
    const axes = eff.axes ?? {};
    for (const id of Object.keys(axes)) {
      const i = flatAxis(axes[id]).findIndex((c) => samePhysical(c, token));
      if (i >= 0 && !(`axis:${id}` === exceptAction && i === exceptSlot)) return { target: `axis:${id}`, index: i };
    }
  }
  return null;
}

export class BindingCapture {
  readonly #deps: RebindDeps;
  readonly #dataChannels: string[];
  #capturing: CaptureTarget | null = null;

  constructor(deps: RebindDeps) {
    this.#deps = deps;
    this.#dataChannels = bindingLessActions(deps.live);
  }

  get capturing(): CaptureTarget | null {
    return this.#capturing;
  }

  /** ssBind(actionId, slot): open capture; false when the target is not rebindable */
  begin(action: string, slot: number): boolean {
    if (typeof action !== 'string' || !Number.isInteger(slot) || slot < 0) return false;
    if (flatOf(this.#deps.live, action) === null) return false;
    const eff = buildInputMap(this.#deps.live, this.#deps.store.binds);
    const flat = flatOf(eff, action, this.#dataChannels);
    if (!flat || slot >= flat.length) return false;
    this.#capturing = { action, slot };
    this.#deps.onCapture?.({ action, slot });
    return true;
  }

  /** Escape abandons the capture without touching the bindings */
  cancel(): void {
    this.#end();
  }

  /** ssBindReset(): empty the overrides, back to the live map */
  reset(): void {
    this.#end();
    const binds = this.#deps.store.binds;
    for (const k of Object.keys(binds)) delete (binds as Record<string, unknown>)[k];
    this.#commit();
  }

  /** a keydown while capturing: Escape cancels, Delete clears, any other code is the token */
  keyDown(code: string): 'consumed' | 'ignored' {
    if (!this.#capturing) return 'ignored';
    if (code === 'Escape') {
      this.#end();
      return 'consumed';
    }
    if (code === 'Delete') {
      this.#clearSlot();
      return 'consumed';
    }
    this.#accept(code);
    return 'consumed';
  }

  /** a pointerdown while capturing: buttons 0-4 are the token */
  pointerDown(button: number): 'consumed' | 'ignored' {
    if (!this.#capturing) return 'ignored';
    const token = BUTTON_TOKENS[button];
    if (!token) return 'ignored';
    this.#accept(token);
    return 'consumed';
  }

  /** a wheel pulse while capturing */
  wheel(dir: 'wheelUp' | 'wheelDown'): 'consumed' | 'ignored' {
    if (!this.#capturing) return 'ignored';
    if (dir !== 'wheelUp' && dir !== 'wheelDown') return 'ignored';
    this.#accept(dir);
    return 'consumed';
  }

  #end(): void {
    if (!this.#capturing) return;
    this.#capturing = null;
    this.#deps.onCapture?.(null);
  }

  #commit(): void {
    this.#deps.store.save();
    this.#deps.setInputs(buildInputMap(this.#deps.live, this.#deps.store.binds));
  }

  /** Delete clears the slot; an axis pair cannot have an empty half, so it is refused there */
  #clearSlot(): void {
    const cap = this.#capturing;
    if (!cap || isAxisTarget(cap.action)) return;
    const eff = buildInputMap(this.#deps.live, this.#deps.store.binds);
    const flat = flatOf(eff, cap.action, this.#dataChannels);
    if (!flat) {
      this.#end();
      return;
    }
    flat.splice(cap.slot, 1);
    this.#writeBack(cap.action, flat);
    this.#commit();
    this.#end();
  }

  #accept(token: string): void {
    const cap = this.#capturing;
    if (!cap) return;
    // axes bind key tokens only; anything else is ignored and the capture stays open
    if (isAxisTarget(cap.action) && isMouseToken(token)) return;
    const eff = buildInputMap(this.#deps.live, this.#deps.store.binds);
    const flats = new Map<string, string[]>();
    const working = (target: string): string[] => {
      let f = flats.get(target);
      if (!f) {
        f = flatOf(eff, target, this.#dataChannels) ?? [];
        flats.set(target, f);
      }
      return f;
    };
    const flat = working(cap.action);
    const displaced = flat[cap.slot];
    // the same physical key: nothing changes, so no override is written
    if (displaced !== undefined && samePhysical(displaced, token)) {
      this.#end();
      return;
    }
    flat[cap.slot] = token;
    // a token already used by another action is swapped onto it (§4.7)
    const holder = findHolder(eff, token, cap.action, cap.slot, this.#dataChannels);
    if (holder) {
      const hflat = working(holder.target);
      if (displaced === undefined) hflat.splice(holder.index, 1);
      else hflat[holder.index] = displaced;
      this.#deps.flash?.(cap.action, holder.target);
    }
    for (const [target, f] of flats) this.#writeBack(target, f);
    this.#commit();
    this.#end();
  }

  /**
   * Write one target's flat list back as overrides-only: entries identical to the
   * live map are removed, so the overrides never restate the defaults. A second
   * mouse token in one flat list cannot be represented; the first wins.
   */
  #writeBack(target: string, flat: string[]): void {
    const live = this.#deps.live;
    const binds = this.#deps.store.binds;
    if (isAxisTarget(target)) {
      const id = target.slice(5);
      const keys = `${flat[0]}/${flat[1]}`;
      binds.axes ??= {};
      if (keys === live.axes?.[id]?.keys) delete binds.axes[id];
      else binds.axes[id] = keys;
      if (Object.keys(binds.axes).length === 0) delete binds.axes;
      return;
    }
    const liveA = live.actions?.[target];
    const liveKeys: string[] = Array.isArray(liveA?.keys) ? [...liveA.keys] : [];
    const liveMouse: MouseToken | null =
      typeof liveA?.mouse === 'string' && isMouseToken(liveA.mouse) ? liveA.mouse : null;
    const keys = flat.filter((t) => !isMouseToken(t));
    const foundMouse = flat.find((t) => isMouseToken(t));
    const mouse: MouseToken | null = foundMouse === undefined ? null : (foundMouse as MouseToken);
    binds.actions ??= {};
    if (eqStr(liveKeys, keys) && liveMouse === mouse) delete binds.actions[target];
    else {
      const o: NonNullable<BindOverrides['actions']>[string] = {};
      if (!eqStr(liveKeys, keys)) o.keys = keys;
      if (liveMouse !== mouse) o.mouse = mouse;
      binds.actions[target] = o;
    }
    if (Object.keys(binds.actions).length === 0) delete binds.actions;
  }
}

/**
 * Publish the page globals the generated CONTROLS panel calls: `ssBind(actionId, slot)`,
 * `ssBindReset()`, the live capture target as `ssCapture`, and the controller itself as
 * `ssBindingCapture` for the DOM wiring to route capture events through.
 */
export function installRebind(target: Record<string, unknown>, deps: RebindDeps): BindingCapture {
  const cap = new BindingCapture({
    ...deps,
    onCapture: (t) => {
      target['ssCapture'] = t;
      deps.onCapture?.(t);
    },
  });
  target['ssBind'] = (actionId: unknown, slot: unknown) => cap.begin(String(actionId), Number(slot));
  target['ssBindReset'] = () => cap.reset();
  target['ssBindingCapture'] = cap;
  return cap;
}
