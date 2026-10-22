// The input map (io §4.1; system-ui.md §3.7a.5; contract §12.1): the live `world.config.yaml` inputs (after the import edits
// E04, which drops `lastshot`, and E-IN-01, which adds Tab to the scoreboard) overlaid with the player's `settings.binds`, the
// token grammar that turns a Spawn key token into physical `KeyboardEvent.code`s, and the index the input log uses to map a
// device control to its actions and axis terms.
//
// Device controls are named the way the sources push them: a keyboard control is its `KeyboardEvent.code` (`KeyW`, `Space`,
// `ShiftLeft`), a mouse control is `mouse:<token>` (`mouse:left`, `mouse:wheelDown`). Physical codes keep the key positions on
// any layout (an AZERTY player's W is the key where QWERTY has W); labels may come from the layout map.
import type { InputActionDef, InputAxisDef, InputsDef } from '../../compat/core/types.ts';
import { resolveDataChannels, type InputMapOptions } from './input-options.ts';

export type MouseToken = 'left' | 'right' | 'middle' | 'mouse4' | 'mouse5' | 'wheelUp' | 'wheelDown';
export const MOUSE_TOKENS: readonly MouseToken[] = Object.freeze(['left', 'right', 'middle', 'mouse4', 'mouse5', 'wheelUp', 'wheelDown']);

/** the four binding-less UI actions only `sendAction` drives (`world.config.yaml:20-23`); never rebindable */

/** `settings.binds` (system-ui.md §3.7a.2): overrides only; `{}` = the live map */
export interface BindOverrides {
  actions?: Record<string, { keys?: string[]; mouse?: MouseToken | null }>;
  /** `moveX: 'a/d'` */
  axes?: Record<string, string>;
}

export interface AxisTerm {
  axis: string;
  sign: -1 | 1;
}

const NAMED: Readonly<Record<string, readonly string[]>> = Object.freeze({
  space: ['Space'],
  enter: ['Enter', 'NumpadEnter'],
  escape: ['Escape'],
  esc: ['Escape'],
  backspace: ['Backspace'],
  delete: ['Delete'],
  tab: ['Tab'],
  shift: ['ShiftLeft', 'ShiftRight'],
  ctrl: ['ControlLeft', 'ControlRight'],
  control: ['ControlLeft', 'ControlRight'],
  alt: ['AltLeft', 'AltRight'],
  up: ['ArrowUp'],
  down: ['ArrowDown'],
  left: ['ArrowLeft'],
  right: ['ArrowRight'],
});

/** InputMapOptions.arrowAliases */
const ARROW_ALIASES: Readonly<Record<string, string>> = Object.freeze({ arrowleft: 'ArrowLeft', arrowright: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown' });

/** the physical codes a Spawn key token stands for; any other string is compared to `ev.code` verbatim */
export function codesForToken(token: string, arrowAliases = false): string[] {
  const t = String(token);
  const lower = t.toLowerCase();
  if (arrowAliases) {
    const arrow = ARROW_ALIASES[lower];
    if (arrow) return [arrow];
  }
  if (/^[a-z]$/.test(lower)) return [`Key${lower.toUpperCase()}`];
  if (/^[0-9]$/.test(t)) return [`Digit${t}`];
  const named = NAMED[lower];
  if (named) return [...named];
  if (/^f([1-9]|1[0-2])$/.test(lower)) return [`F${lower.slice(1)}`];
  return [t];
}

export function tokenMatches(token: string, ev: { readonly code: string }): boolean {
  return codesForToken(token).includes(ev.code);
}

export function mouseControl(token: MouseToken | string): string {
  return `mouse:${token}`;
}

export function isMouseToken(v: unknown): v is MouseToken {
  return typeof v === 'string' && (MOUSE_TOKENS as readonly string[]).includes(v);
}

/** `"a/d"` → `{neg: 'a', pos: 'd'}` (the first key reads -1, the second +1, contract §12.1) */
export function parseAxisKeys(keys: string): { neg: string; pos: string } | null {
  if (typeof keys !== 'string') return null;
  const parts = keys.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  return { neg: parts[0], pos: parts[1] };
}

const CODE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  Space: 'SPACE',
  Enter: 'ENTER',
  NumpadEnter: 'ENTER',
  Escape: 'ESC',
  Backspace: 'BACKSPACE',
  Delete: 'DEL',
  Tab: 'TAB',
  ShiftLeft: 'SHIFT',
  ShiftRight: 'SHIFT',
  ControlLeft: 'CTRL',
  ControlRight: 'CTRL',
  AltLeft: 'ALT',
  AltRight: 'ALT',
  ArrowUp: 'UP',
  ArrowDown: 'DOWN',
  ArrowLeft: 'LEFT',
  ArrowRight: 'RIGHT',
});

/**
 * A key token as printed on a keycap (`e` → `E`, `KeyE` → `E`, `Digit1` → `1`, `Numpad0` → `NUM 0`, `space` → `SPACE`). With
 * `layout` (from `navigator.keyboard.getLayoutMap()`), a letter or digit prints what the player's layout has on that key.
 */
export function tokenLabel(token: string, layout?: ReadonlyMap<string, string>): string {
  const code = codesForToken(token)[0] ?? String(token);
  const fromLayout = layout?.get(code);
  if (fromLayout && /^(Key[A-Z]|Digit[0-9])$/.test(code)) return fromLayout.toUpperCase();
  const word = CODE_WORDS[code];
  if (word) return word;
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1]!;
  m = /^Digit([0-9])$/.exec(code);
  if (m) return m[1]!;
  m = /^Numpad(.+)$/.exec(code);
  if (m) return `NUM ${m[1]!.toUpperCase()}`;
  return code.toUpperCase();
}

const own = (o: object, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);

function cloneAction(a: InputActionDef): InputActionDef {
  const out: InputActionDef = { ...a };
  if (Array.isArray(a.keys)) out.keys = [...a.keys];
  return out;
}

function cloneMap(live: InputsDef): InputsDef {
  const out: InputsDef = {};
  if (live.actions) {
    const actions: Record<string, InputActionDef> = {};
    for (const [id, a] of Object.entries(live.actions)) actions[id] = cloneAction(a ?? {});
    out.actions = actions;
  }
  if (live.axes) {
    const axes: Record<string, InputAxisDef> = {};
    for (const [id, a] of Object.entries(live.axes)) axes[id] = { ...(a ?? {}) };
    out.axes = axes;
  }
  if (live.touch) out.touch = { ...live.touch };
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** a bindable key token: a non-empty string that is not Escape (the browser's pointer-lock exit) */
const bindableKey = (k: unknown): k is string => typeof k === 'string' && k.length > 0 && !codesForToken(k).includes('Escape');

/**
 * The effective map: a deep copy of `live` with the player's overrides applied. Only declared, rebindable actions and declared
 * axes take overrides; Escape, malformed tokens and malformed axis pairs are ignored, so a corrupt save can never unbind
 * the game. The live object is never mutated or shared.
 */
export function buildInputMap(live: InputsDef, binds: BindOverrides | undefined, opts?: InputMapOptions): InputsDef {
  const out = cloneMap(live);
  const channels = resolveDataChannels(opts, live);
  if (!isRecord(binds)) return out;
  const actions = out.actions;
  if (actions && isRecord(binds.actions)) {
    for (const [id, o] of Object.entries(binds.actions)) {
      if (!own(actions, id) || channels.has(id) || !isRecord(o)) continue;
      const cur = actions[id]!;
      if (Array.isArray(o['keys'])) cur.keys = (o['keys'] as unknown[]).filter(bindableKey);
      if (own(o, 'mouse')) {
        const m = o['mouse'];
        if (m === null) delete cur.mouse;
        else if (isMouseToken(m)) cur.mouse = m;
      }
    }
  }
  const axes = out.axes;
  if (axes && isRecord(binds.axes)) {
    for (const [id, keys] of Object.entries(binds.axes)) {
      if (!own(axes, id) || typeof keys !== 'string') continue;
      const pair = parseAxisKeys(keys);
      if (pair && bindableKey(pair.neg) && bindableKey(pair.pos)) axes[id]!.keys = keys;
    }
  }
  return out;
}

/** device control → actions / axis terms over one effective map */
export class InputMapIndex {
  readonly map: InputsDef;
  readonly #actionsByControl = new Map<string, string[]>();
  readonly #controlsByAction = new Map<string, string[]>();
  readonly #axisTerms = new Map<string, AxisTerm[]>();
  readonly #declared = new Set<string>();
  readonly #axes: string[] = [];
  readonly #wheelAxes: string[] = [];
  readonly #arrows: boolean;

  constructor(map: InputsDef, opts?: InputMapOptions) {
    this.map = map;
    this.#arrows = opts?.arrowAliases === true;
    for (const [id, a] of Object.entries(map.actions ?? {})) {
      this.#declared.add(id);
      const controls: string[] = [];
      for (const k of Array.isArray(a?.keys) ? a.keys : []) if (typeof k === 'string') controls.push(...codesForToken(k, this.#arrows));
      if (a && isMouseToken(a.mouse)) controls.push(mouseControl(a.mouse));
      const uniq = [...new Set(controls)];
      this.#controlsByAction.set(id, uniq);
      for (const c of uniq) {
        const list = this.#actionsByControl.get(c);
        if (list) list.push(id);
        else this.#actionsByControl.set(c, [id]);
      }
    }
    for (const [axis, def] of Object.entries(map.axes ?? {})) {
      this.#axes.push(axis);
      if (def?.mouse === 'wheelY') this.#wheelAxes.push(axis);
      const pair = typeof def?.keys === 'string' ? parseAxisKeys(def.keys) : null;
      if (!pair) continue;
      for (const [token, sign] of [[pair.neg, -1], [pair.pos, 1]] as const) {
        for (const c of codesForToken(token, this.#arrows)) {
          const list = this.#axisTerms.get(c);
          const term: AxisTerm = { axis, sign };
          if (list) list.push(term);
          else this.#axisTerms.set(c, [term]);
        }
      }
    }
  }

  actionsFor(control: string): readonly string[] {
    return this.#actionsByControl.get(control) ?? [];
  }

  controlsOf(action: string): readonly string[] {
    return this.#controlsByAction.get(action) ?? [];
  }

  axisTermsFor(control: string): readonly AxisTerm[] {
    return this.#axisTerms.get(control) ?? [];
  }

  /** axes declared `mouse: wheelY` (a wheel notch moves them) */
  wheelAxes(): readonly string[] {
    return this.#wheelAxes;
  }

  axisNames(): readonly string[] {
    return this.#axes;
  }

  /** a control that drives an action or an axis (the keyboard source prevents its browser default) */
  isBound(control: string): boolean {
    return this.#actionsByControl.has(control) || this.#axisTerms.has(control);
  }

  boundControls(): string[] {
    return [...new Set([...this.#actionsByControl.keys(), ...this.#axisTerms.keys()])];
  }

  /** declared in `world.inputs.actions` (an undeclared sendAction is dropped silently, contract §12.2) */
  isDeclared(action: string): boolean {
    return this.#declared.has(action);
  }
}
