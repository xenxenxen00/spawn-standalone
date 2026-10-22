// keyboard-mouse (io §4.2): the DOM sources. Keys by physical code (no repeats, editable targets skipped), mouse buttons 0-4
// (chorded presses included), locked mouse look with the raw movement, blur/hidden release, preventDefault rules.
import { afterEach, describe, expect, it } from 'vitest';
import { installKeyboardMouse, type InputSink } from '../../../src/runtime/input/keyboard-mouse.ts';
import { InputLog, type RawInputEvent } from '../../../src/runtime/input/input-log.ts';
import type { InputsDef } from '../../../src/compat/core/types.ts';

const MAP: InputsDef = {
  actions: { jump: { keys: ['space'] }, fire: { mouse: 'left' }, ads: { mouse: 'right' }, reload: { keys: ['r'] } },
  axes: { moveX: { keys: 'a/d' } },
};

interface Rig {
  canvas: HTMLCanvasElement;
  ui: HTMLDivElement;
  events: RawInputEvent[];
  sink: InputSink & { released: number; pointer: unknown; touch: boolean };
  setLocked(on: boolean): void;
}

let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
  document.body.replaceChildren();
});

function setup(opts: { log?: InputLog } = {}): Rig {
  const canvas = document.createElement('canvas');
  const ui = document.createElement('div');
  ui.id = 'tome-ui-container';
  document.body.append(canvas, ui);
  const events: RawInputEvent[] = [];
  let locked = false;
  const log = opts.log;
  const sink = {
    released: 0,
    pointer: null as unknown,
    touch: false,
    push: (e: RawInputEvent) => {
      events.push(e);
      log?.push(e);
    },
    releaseDevices() {
      sink.released++;
      log?.releaseDevices();
    },
    setPointer(p: unknown) {
      sink.pointer = p;
    },
    isBound: (c: string) => (log ? log.isBound(c) : c === 'Space' || c === 'KeyR'),
    get touchActive() {
      return sink.touch;
    },
    setTouchActive(on: boolean) {
      sink.touch = on;
    },
  };
  dispose = installKeyboardMouse(sink, canvas, { uiRoot: ui, isLocked: () => locked, now: () => 7 }).dispose;
  return { canvas, ui, events, sink, setLocked: (on) => void (locked = on) };
}

const key = (type: 'keydown' | 'keyup', code: string, init: KeyboardEventInit = {}): KeyboardEvent =>
  new KeyboardEvent(type, { code, bubbles: true, cancelable: true, ...init });
const ptr = (type: string, button: number, buttons: number, init: PointerEventInit = {}): PointerEvent =>
  new PointerEvent(type, { button, buttons, pointerType: 'mouse', bubbles: true, cancelable: true, ...init });

describe('keyboard', () => {
  it('keydown / keyup push the physical code; auto-repeat is ignored', () => {
    const { events } = setup();
    window.dispatchEvent(key('keydown', 'KeyW'));
    window.dispatchEvent(key('keydown', 'KeyW', { repeat: true }));
    window.dispatchEvent(key('keyup', 'KeyW'));
    expect(events).toEqual([
      { type: 'button', control: 'KeyW', down: true, t: 7 },
      { type: 'button', control: 'KeyW', down: false, t: 7 },
    ]);
  });

  it('keys typed into an editable element are left to it (the lobby bot <select>, text inputs)', () => {
    const { events } = setup();
    for (const el of [document.createElement('input'), document.createElement('select'), document.createElement('textarea')]) {
      document.body.append(el);
      const ev = key('keydown', 'KeyR');
      el.dispatchEvent(ev);
      expect(ev.defaultPrevented, el.tagName).toBe(false);
    }
    const edit = document.createElement('div');
    edit.setAttribute('contenteditable', 'true');
    document.body.append(edit);
    edit.dispatchEvent(key('keydown', 'KeyR'));
    expect(events).toEqual([]);
  });

  it('a key that went down in the game is released even when the keyup lands in an editable element', () => {
    const { events } = setup();
    window.dispatchEvent(key('keydown', 'KeyR'));
    const input = document.createElement('input');
    document.body.append(input);
    input.dispatchEvent(key('keyup', 'KeyR'));
    expect(events.map((e) => e.type === 'button' && e.down)).toEqual([true, false]);
  });

  it('preventDefault for bound codes and for Tab, Space, F1, Alt; not for other keys', () => {
    setup();
    const prevented = (code: string): boolean => {
      const ev = key('keydown', code);
      window.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    expect(prevented('KeyR')).toBe(true);
    expect(prevented('Tab')).toBe(true);
    expect(prevented('Space')).toBe(true);
    expect(prevented('F1')).toBe(true);
    expect(prevented('AltLeft')).toBe(true);
    expect(prevented('KeyQ')).toBe(false);
    expect(prevented('F5')).toBe(false);
  });

  it('a key press switches the live input back from touch', () => {
    const { sink } = setup();
    sink.touch = true;
    window.dispatchEvent(key('keydown', 'KeyW'));
    expect(sink.touch).toBe(false);
  });
});

describe('mouse buttons', () => {
  it('buttons 0-4 map to left, middle, right, mouse4, mouse5; back/forward are prevented', () => {
    const { canvas, events } = setup();
    const masks = [1, 4, 2, 8, 16];
    const prevented: boolean[] = [];
    for (let b = 0; b < 5; b++) {
      const ev = ptr('pointerdown', b, masks[b]!);
      canvas.dispatchEvent(ev);
      prevented.push(ev.defaultPrevented);
      canvas.dispatchEvent(ptr('pointerup', b, 0));
    }
    expect(events.filter((e) => e.type === 'button' && e.down).map((e) => (e as { control: string }).control)).toEqual([
      'mouse:left',
      'mouse:middle',
      'mouse:right',
      'mouse:mouse4',
      'mouse:mouse5',
    ]);
    expect(prevented).toEqual([false, false, false, true, true]);
    expect(events.filter((e) => e.type === 'button' && !e.down)).toHaveLength(5);
  });

  it('a chorded press (right while left is held) arrives as a pointermove with the new button', () => {
    const log = new InputLog({ map: MAP });
    const { canvas } = setup({ log });
    canvas.dispatchEvent(ptr('pointerdown', 0, 1));
    canvas.dispatchEvent(ptr('pointermove', 2, 3));
    let s = log.deliver('body');
    expect(s.held).toEqual({ fire: true, ads: true });
    canvas.dispatchEvent(ptr('pointermove', 0, 2));
    s = log.deliver('body');
    expect(s.released['fire']).toBe(true);
    expect(s.held).toEqual({ ads: true });
    canvas.dispatchEvent(ptr('pointerup', 2, 0));
    expect(log.deliver('body').held).toEqual({});
  });

  it('a release outside the canvas still releases (nothing sticks)', () => {
    const log = new InputLog({ map: MAP });
    const { canvas } = setup({ log });
    canvas.dispatchEvent(ptr('pointerdown', 0, 1));
    document.body.dispatchEvent(ptr('pointerup', 0, 0));
    const s = log.deliver('body');
    expect(s.pressed['fire']).toBe(true);
    expect(s.released['fire']).toBe(true);
    expect(s.held).toEqual({});
  });

  it('touch pointers are left to the touch layer', () => {
    const { canvas, events } = setup();
    canvas.dispatchEvent(ptr('pointerdown', 0, 1, { pointerType: 'touch' }));
    expect(events).toEqual([]);
  });

  it('on the UI container only presses no UI element consumed reach the game', () => {
    const { ui, events } = setup();
    ui.style.pointerEvents = 'none';
    const button = document.createElement('button');
    button.style.pointerEvents = 'auto';
    const label = document.createElement('span');
    button.append(label);
    const deco = document.createElement('div');
    ui.append(button, deco);
    label.dispatchEvent(ptr('pointerdown', 0, 1));
    expect(events).toEqual([]);
    deco.dispatchEvent(ptr('pointerdown', 0, 1));
    expect(events).toEqual([{ type: 'button', control: 'mouse:left', down: true, t: 7 }]);
  });

  it('presses elsewhere on the page are not game input; the context menu is prevented everywhere', () => {
    const { events } = setup();
    const other = document.createElement('div');
    document.body.append(other);
    other.dispatchEvent(ptr('pointerdown', 0, 1));
    expect(events).toEqual([]);
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    other.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });
});

describe('mouse look and pointer', () => {
  it('mousemove deltas only while locked; the pointer reads the canvas centre while locked', () => {
    const { canvas, events, setLocked, sink } = setup();
    canvas.dispatchEvent(new MouseEvent('mousemove', { movementX: 5, movementY: 3, bubbles: true }));
    expect(events).toEqual([]);
    setLocked(true);
    canvas.dispatchEvent(new MouseEvent('mousemove', { movementX: 5, movementY: -3, bubbles: true }));
    expect(events).toEqual([{ type: 'look', dx: 5, dy: -3, source: 'mouse', t: 7 }]);
    expect(sink.pointer).toMatchObject({ ndcX: 0, ndcY: 0 });
  });

  it('a free cursor over the canvas is reported in canvas pixels and NDC', () => {
    const { canvas, sink } = setup();
    canvas.getBoundingClientRect = () => ({ left: 10, top: 20, width: 200, height: 100, right: 210, bottom: 120, x: 10, y: 20, toJSON: () => ({}) });
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 60, clientY: 45, bubbles: true }));
    expect(sink.pointer).toEqual({ x: 50, y: 25, ndcX: -0.5, ndcY: 0.5 });
  });

  it('zero movement is not an event', () => {
    const { canvas, events, setLocked } = setup();
    setLocked(true);
    canvas.dispatchEvent(new MouseEvent('mousemove', { movementX: 0, movementY: 0, bubbles: true }));
    expect(events).toEqual([]);
  });
});

describe('focus loss', () => {
  it('blur and visibilitychange → hidden release every held key and button', () => {
    const log = new InputLog({ map: MAP });
    const { canvas, sink } = setup({ log });
    window.dispatchEvent(key('keydown', 'KeyR'));
    canvas.dispatchEvent(ptr('pointerdown', 0, 1));
    window.dispatchEvent(new Event('blur'));
    expect(sink.released).toBe(1);
    const s = log.deliver('body');
    expect(s.held).toEqual({});
    expect(s.released).toMatchObject({ reload: true, fire: true });
    // the mouse button state was reset too: a fresh press is a press again
    canvas.dispatchEvent(ptr('pointerdown', 0, 1));
    expect(log.deliver('body').pressed['fire']).toBe(true);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sink.released).toBe(2);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    expect(sink.released).toBe(2);
  });

  it('dispose removes every listener', () => {
    const { events } = setup();
    dispose!();
    dispose = null;
    window.dispatchEvent(key('keydown', 'KeyR'));
    expect(events).toEqual([]);
  });
});
