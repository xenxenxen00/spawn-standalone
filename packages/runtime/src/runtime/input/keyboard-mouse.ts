// Keyboard and mouse sources (io §4.2; contract §12.2): DOM events → raw input events for the input log.
//
// - Keys: `keydown`/`keyup` on window (capture), by physical `KeyboardEvent.code`; auto-repeat is not an edge; a keydown aimed at
//   an editable element (text input, select, textarea, contenteditable) is left to it (the lobby bot <select>). The browser
//   default is prevented for every bound code and for Tab, Space, F1 and Alt (no page scroll, no help, no menu-bar focus).
// - Mouse buttons: 0 left, 1 middle, 2 right, 3 mouse4, 4 mouse5 (back/forward prevented), from the canvas and from the UI
//   container when no UI element consumed the press (its target is not inside an element with `pointer-events:auto`). A chorded
//   press (a second button while one is held) arrives as a pointermove with the new `buttons` mask, so the mask is followed too.
//   A release is honoured wherever it lands. Touch pointers belong to the touch layer. The context menu is prevented.
// - Wheel on the canvas: deltaY normalised to px (line ×40, page ×800), one pulse per 40 px crossed, at most one per 30 ms (the
//   excess of a burst is dropped), so one notch of a mouse wheel is one `wheelUp`/`wheelDown` pulse.
// - Look: `movementX/Y` of mousemove only while the pointer is locked (the spike filter is the look's, look.ts).
// - Window blur and a hidden page release every held key and button.
import { mouseControl, type MouseToken } from './input-map.ts';
import type { PointerSample, RawInputEvent } from './input-log.ts';

/** what the sources need from the input log (InputLog implements it) */
export interface InputSink {
  push(ev: RawInputEvent): void;
  releaseDevices(): void;
  setPointer(p: PointerSample): void;
  isBound(control: string): boolean;
  readonly touchActive: boolean;
  setTouchActive(on: boolean): void;
}

export interface KeyboardMouseOptions {
  window?: Window;
  /** `#tome-ui-container`: presses no UI element consumed reach the game */
  uiRoot?: HTMLElement | null;
  /** default: `document.pointerLockElement === canvas` */
  isLocked?: () => boolean;
  /** ms; default `performance.now()` */
  now?: () => number;
  /**
   * Look deltas while the pointer is NOT locked (a camera def with `pointerLock: false`): 'rightDrag' = `movementX/Y` of a mousemove
   * while the right button is held (a right-drag orbit); default false (none). The look's spike filter applies as usual.
   */
  unlockedLook?: 'rightDrag' | false;
}

export const WHEEL_LINE_PX = 40;
export const WHEEL_PAGE_PX = 800;
export const WHEEL_PULSE_PX = 40;
export const WHEEL_MIN_INTERVAL_MS = 30;

/** codes whose browser default is always prevented outside editable elements */
const ALWAYS_PREVENT: ReadonlySet<string> = new Set(['Tab', 'Space', 'F1', 'AltLeft', 'AltRight']);

/** MouseEvent.button → token; bit of MouseEvent.buttons per token */
const BUTTONS: readonly MouseToken[] = ['left', 'middle', 'right', 'mouse4', 'mouse5'];
const MASK_BITS: Readonly<Record<number, number>> = { 0: 1, 1: 4, 2: 2, 3: 8, 4: 16 };

export function normalizeWheelDelta(deltaY: number, deltaMode: number): number {
  if (deltaMode === 1) return deltaY * WHEEL_LINE_PX;
  if (deltaMode === 2) return deltaY * WHEEL_PAGE_PX;
  return deltaY;
}

/** wheel deltas → pulses (`wheelDown` for positive deltaY, scrolling towards the user) */
export class WheelPulser {
  readonly #now: () => number;
  #acc = 0;
  #last = Number.NEGATIVE_INFINITY;

  constructor(opts: { now?: () => number } = {}) {
    this.#now = opts.now ?? (() => performance.now());
  }

  feed(deltaY: number, deltaMode: number): 'wheelUp' | 'wheelDown' | null {
    const d = normalizeWheelDelta(deltaY, deltaMode);
    if (!Number.isFinite(d) || d === 0) return null;
    if (Math.sign(d) !== Math.sign(this.#acc)) this.#acc = 0;
    this.#acc += d;
    if (Math.abs(this.#acc) < WHEEL_PULSE_PX) return null;
    const dir = this.#acc > 0 ? 'wheelDown' : 'wheelUp';
    this.#acc = 0;
    const t = this.#now();
    if (t - this.#last < WHEEL_MIN_INTERVAL_MS) return null;
    this.#last = t;
    return dir;
  }

  reset(): void {
    this.#acc = 0;
  }
}

// duck-typed (no instanceof: the page, jsdom and iframes are different realms)
const isNode = (t: EventTarget | null): t is Node => !!t && typeof (t as Partial<Node>).nodeType === 'number';
const isElement = (t: Node): t is Element => t.nodeType === 1;

/** an element that takes typed keys itself */
export function isEditable(target: EventTarget | null): boolean {
  const el = target as (Element & { isContentEditable?: boolean }) | null;
  if (!el || typeof el.tagName !== 'string') return false;
  const tag = el.tagName.toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag === 'input') {
    const type = (el.getAttribute('type') ?? 'text').toLowerCase();
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'image', 'color', 'file'].includes(type);
  }
  if (el.isContentEditable === true) return true;
  const ce = el.closest?.('[contenteditable]');
  return !!ce && ce.getAttribute('contenteditable') !== 'false';
}

export interface KeyboardMouseHandle {
  dispose(): void;
}

export function installKeyboardMouse(sink: InputSink, canvas: HTMLElement, opts: KeyboardMouseOptions = {}): KeyboardMouseHandle {
  const win = opts.window ?? canvas.ownerDocument.defaultView ?? window;
  const doc = canvas.ownerDocument;
  const uiRoot = opts.uiRoot ?? null;
  const now = opts.now ?? (() => performance.now());
  const isLocked = opts.isLocked ?? (() => doc.pointerLockElement === canvas);
  const wheel = new WheelPulser({ now });
  /** mouse buttons down, by index 0-4 */
  const down = new Set<number>();
  const offs: Array<() => void> = [];
  const on = <E extends Event>(target: EventTarget, type: string, fn: (e: E) => void, o: AddEventListenerOptions = {}): void => {
    const h = fn as EventListener;
    target.addEventListener(type, h, o);
    offs.push(() => target.removeEventListener(type, h, o));
  };

  const backToKbm = (): void => {
    if (sink.touchActive) sink.setTouchActive(false);
  };

  const button = (b: number, isDown: boolean): void => {
    const token = BUTTONS[b];
    if (!token) return;
    if (isDown === down.has(b)) return;
    if (isDown) down.add(b);
    else down.delete(b);
    sink.push({ type: 'button', control: mouseControl(token), down: isDown, t: now() });
  };

  /** a press on the canvas, or on the UI container that no pointer-events:auto element took */
  const gameTarget = (target: EventTarget | null): boolean => {
    if (!isNode(target)) return false;
    if (target === canvas || canvas.contains(target)) return true;
    if (!uiRoot || !uiRoot.contains(target)) return false;
    for (let el: Element | null = isElement(target) ? target : target.parentElement; el && el !== uiRoot; el = el.parentElement) {
      if (win.getComputedStyle(el).pointerEvents === 'auto') return false;
    }
    return true;
  };

  const followMask = (ev: MouseEvent, mayPress: boolean): void => {
    if (typeof ev.buttons !== 'number') return;
    for (let b = 0; b < BUTTONS.length; b++) {
      const isDown = (ev.buttons & MASK_BITS[b]!) !== 0;
      if (isDown && !mayPress) continue;
      button(b, isDown);
    }
  };

  // ---- keyboard
  on<KeyboardEvent>(win, 'keydown', (ev) => {
    if (isEditable(ev.target)) return;
    if (sink.isBound(ev.code) || ALWAYS_PREVENT.has(ev.code)) ev.preventDefault();
    if (ev.repeat) return;
    backToKbm();
    sink.push({ type: 'button', control: ev.code, down: true, t: now() });
  }, { capture: true });
  on<KeyboardEvent>(win, 'keyup', (ev) => {
    if (!isEditable(ev.target) && (sink.isBound(ev.code) || ALWAYS_PREVENT.has(ev.code))) ev.preventDefault();
    // pushed wherever it lands: a key that went down in the game must come up (an unknown release is a no-op in the log)
    sink.push({ type: 'button', control: ev.code, down: false, t: now() });
  }, { capture: true });

  // ---- mouse buttons
  const press = (ev: PointerEvent): void => {
    if (ev.pointerType === 'touch' || !gameTarget(ev.target)) return;
    if (ev.button === 3 || ev.button === 4) ev.preventDefault();
    backToKbm();
    button(ev.button, true);
  };
  on<PointerEvent>(canvas, 'pointerdown', press);
  if (uiRoot) on<PointerEvent>(uiRoot, 'pointerdown', press);
  on<PointerEvent>(win, 'pointerup', (ev) => {
    if (ev.pointerType === 'touch') return;
    if (ev.button === 3 || ev.button === 4) ev.preventDefault();
    button(ev.button, false);
    followMask(ev, false);
  }, { capture: true });
  on<PointerEvent>(win, 'pointermove', (ev) => {
    if (ev.pointerType === 'touch') return;
    // a plain move has button -1; a chorded press or release names the button that changed. A button carried in from a UI
    // element (pressed there, dragged over the canvas) is not a press.
    followMask(ev, ev.button >= 0 && (gameTarget(ev.target) || isLocked()));
  }, { capture: true });
  on<MouseEvent>(doc, 'contextmenu', (ev) => ev.preventDefault());

  // ---- wheel
  on<WheelEvent>(canvas, 'wheel', (ev) => {
    ev.preventDefault();
    const pulse = wheel.feed(ev.deltaY, ev.deltaMode);
    if (pulse) sink.push({ type: 'pulse', control: mouseControl(pulse), t: now() });
  }, { passive: false });

  // ---- look and pointer
  on<MouseEvent>(doc, 'mousemove', (ev) => {
    if (isLocked()) {
      const r = canvas.getBoundingClientRect();
      sink.setPointer({ x: r.width / 2, y: r.height / 2, ndcX: 0, ndcY: 0 });
      const dx = ev.movementX || 0;
      const dy = ev.movementY || 0;
      if (dx === 0 && dy === 0) return;
      backToKbm();
      sink.push({ type: 'look', dx, dy, source: 'mouse', t: now() });
      return;
    }
    if (opts.unlockedLook === 'rightDrag' && down.has(2)) {
      const dx = ev.movementX || 0;
      const dy = ev.movementY || 0;
      if (dx !== 0 || dy !== 0) sink.push({ type: 'look', dx, dy, source: 'mouse', t: now() });
    }
    if (ev.target !== canvas) return;
    const r = canvas.getBoundingClientRect();
    if (!(r.width > 0 && r.height > 0)) return;
    const x = ev.clientX - r.left;
    const y = ev.clientY - r.top;
    sink.setPointer({ x, y, ndcX: (x / r.width) * 2 - 1, ndcY: 1 - (y / r.height) * 2 });
  });

  // ---- focus loss
  const releaseAll = (): void => {
    down.clear();
    wheel.reset();
    sink.releaseDevices();
  };
  on(win, 'blur', releaseAll);
  on(doc, 'visibilitychange', () => {
    if (doc.visibilityState === 'hidden') releaseAll();
  });

  return {
    dispose(): void {
      for (const off of offs.splice(0)) off();
      down.clear();
    },
  };
}
