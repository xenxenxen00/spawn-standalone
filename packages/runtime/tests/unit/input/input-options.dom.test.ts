// Input options (input-options.ts): data channels from the world's binding-less actions, arrow-key token aliases, a disabled pointer
// lock (`pointerLock: false`), right-drag look while unlocked, and the `wheelY` axis. Each option's default is PP's behaviour.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InputsDef } from '../../../src/compat/core/types.ts';
import { createInputPort } from '../../../src/runtime/input/action-sink.ts';
import { buildInputMap, codesForToken } from '../../../src/runtime/input/input-map.ts';
import { bindingLessActions, resolveDataChannels } from '../../../src/runtime/input/input-options.ts';
import { InputLog } from '../../../src/runtime/input/input-log.ts';
import { installKeyboardMouse } from '../../../src/runtime/input/keyboard-mouse.ts';
import { PointerLockManager } from '../../../src/runtime/input/pointer-lock.ts';

// Crown & Clash's shape: a binding-less `chess` channel, a mouse action, key actions, a wheelY axis
const WORLD: InputsDef = {
  actions: { chess: { keys: [] }, select: { mouse: 'left' }, orbitHold: { mouse: 'right' }, skip: { keys: ['space'] }, ss_req: {} },
  axes: { zoomIn: { mouse: 'wheelY' }, moveX: { keys: 'arrowleft/arrowright' } },
};

describe('data channels', () => {
  it('binding-less lists the actions with no key and no mouse', () => {
    expect(bindingLessActions(WORLD).sort()).toEqual(['chess', 'ss_req']);
    expect([...resolveDataChannels({ dataChannels: 'binding-less' }, WORLD)].sort()).toEqual(['chess', 'ss_req']);
    expect([...resolveDataChannels({ dataChannels: ['a'] }, WORLD)]).toEqual(['a']);
  });

  it('the default preserves every binding-less action as a data channel', () => {
    const m = buildInputMap(WORLD, { actions: { chess: { keys: ['x'] }, ss_req: { keys: ['y'] } } });
    expect(m.actions!['chess']!.keys).toEqual([]);
    expect(m.actions!['ss_req']!.keys).toBeUndefined();
  });

  it('with binding-less channels, an override on chess is ignored and select stays rebindable', () => {
    const m = buildInputMap(WORLD, { actions: { chess: { keys: ['x'] }, skip: { keys: ['k'] } } }, { dataChannels: 'binding-less' });
    expect(m.actions!['chess']!.keys).toEqual([]);
    expect(m.actions!['skip']!.keys).toEqual(['k']);
  });

  it('a payload sent to the channel arrives as actionData either way', () => {
    const { log, port } = createInputPort({ map: WORLD, options: { dataChannels: 'binding-less' } });
    expect(log.injectAction('chess', { from: 'e2' })).toBe(true);
    const s = port.sampleTick();
    expect(s.pressed['chess']).toBe(true);
    expect(s.actionData?.['chess']).toEqual({ from: 'e2' });
  });
});

describe('arrow key tokens', () => {
  it('are aliases of the arrow codes only with arrowAliases', () => {
    expect(codesForToken('arrowleft')).toEqual(['arrowleft']);
    expect(codesForToken('ArrowLeft', true)).toEqual(['ArrowLeft']);
    expect(codesForToken('arrowdown', true)).toEqual(['ArrowDown']);
    expect(codesForToken('left', true)).toEqual(['ArrowLeft']);
    expect(codesForToken('a', true)).toEqual(['KeyA']);
  });

  it('ev.code ArrowLeft sets the held action and the axis; A/D are unchanged', () => {
    const map: InputsDef = { actions: { left: { keys: ['arrowleft', 'a'] } }, axes: { moveX: { keys: 'arrowleft/arrowright' } } };
    const log = new InputLog({ map, options: { arrowAliases: true } });
    log.push({ type: 'button', control: 'ArrowLeft', down: true });
    let s = log.deliver('body');
    expect(s.held['left']).toBe(true);
    expect(s.axes['moveX']).toBe(-1);
    log.push({ type: 'button', control: 'ArrowLeft', down: false });
    log.push({ type: 'button', control: 'KeyA', down: true });
    s = log.deliver('body');
    expect(s.held['left']).toBe(true);
    log.push({ type: 'button', control: 'KeyA', down: false });
    // without the option the arrow code drives nothing (PP)
    const plain = new InputLog({ map });
    plain.push({ type: 'button', control: 'ArrowLeft', down: true });
    expect(plain.deliver('body').held['left']).toBeUndefined();
  });
});

describe('pointerLock: false', () => {
  class Canvas extends EventTarget {
    calls = 0;
    requestPointerLock(): void {
      this.calls++;
    }
  }
  class Doc extends EventTarget {
    pointerLockElement: unknown = null;
    exitPointerLock(): void {}
  }

  it('a canvas click does not request the lock and a RESUME still clears the overlay', () => {
    const canvas = new Canvas();
    const pause = { add: vi.fn(), remove: vi.fn() };
    const m = new PointerLockManager({ canvas, document: new Doc(), pause, enabled: false });
    canvas.dispatchEvent(new Event('click'));
    m.requestLock('ui');
    m.requestLock('resume');
    expect(canvas.calls).toBe(0);
    expect(m.state).toBe('free');
    expect(pause.remove).toHaveBeenCalledTimes(2);
    m.dispose();
  });

  it('enabled by default: the same click requests the lock', () => {
    const canvas = new Canvas();
    const m = new PointerLockManager({ canvas, document: new Doc() });
    canvas.dispatchEvent(new Event('click'));
    expect(canvas.calls).toBe(1);
    m.dispose();
  });
});

describe('right-drag look while unlocked, and the wheelY axis', () => {
  let off: (() => void) | null = null;
  afterEach(() => {
    off?.();
    off = null;
    document.body.replaceChildren();
  });

  function rig(unlockedLook: 'rightDrag' | false) {
    const canvas = document.createElement('canvas');
    document.body.append(canvas);
    const stack = createInputPort({ map: WORLD });
    const log = stack.log;
    off = installKeyboardMouse(log, canvas, { isLocked: () => false, now: () => 1, ...(unlockedLook ? { unlockedLook } : {}) }).dispose;
    return { canvas, log };
  }
  const move = (target: EventTarget, dx: number, dy: number): void => {
    const ev = new MouseEvent('mousemove', { bubbles: true, buttons: 2 });
    Object.defineProperty(ev, 'movementX', { value: dx });
    Object.defineProperty(ev, 'movementY', { value: dy });
    target.dispatchEvent(ev);
  };
  const rightDown = (canvas: HTMLElement, isDown: boolean): void => {
    const type = isDown ? 'pointerdown' : 'pointerup';
    canvas.dispatchEvent(new PointerEvent(type, { button: 2, buttons: isDown ? 2 : 0, pointerType: 'mouse', bubbles: true }));
  };

  it('moves while the right button is held feed lookX/lookY and the held orbitHold', () => {
    const { canvas, log } = rig('rightDrag');
    rightDown(canvas, true);
    move(canvas, 10, -5);
    const s = log.deliver('rig');
    expect(s.held['orbitHold']).toBe(true);
    expect(s.axes['lookX']).toBeGreaterThan(0);
    expect(s.axes['lookY']).toBeLessThan(0);
    rightDown(canvas, false);
    move(canvas, 10, 10);
    expect(log.deliver('rig').axes['lookX']).toBe(0);
  });

  it('no look while unlocked by default (PP), nor without the right button', () => {
    const a = rig('rightDrag');
    move(a.canvas, 10, 10);
    expect(a.log.deliver('rig').axes['lookX']).toBe(0);
    off?.();
    document.body.replaceChildren();
    const b = rig(false);
    rightDown(b.canvas, true);
    move(b.canvas, 10, 10);
    expect(b.log.deliver('rig').axes['lookX']).toBe(0);
  });

  it('wheel notches move a wheelY axis (+ up), once per delivery per consumer, scaled by wheelNotch', () => {
    const stack = createInputPort({ map: WORLD, options: { wheelNotch: 0.25 } });
    stack.log.push({ type: 'pulse', control: 'mouse:wheelUp' });
    stack.log.push({ type: 'pulse', control: 'mouse:wheelUp' });
    stack.log.push({ type: 'pulse', control: 'mouse:wheelDown' });
    expect(stack.log.deliver('body').axes['zoomIn']).toBeCloseTo(0.25);
    expect(stack.log.deliver('body').axes['zoomIn']).toBe(0);
    expect(stack.log.deliver('rig').axes['zoomIn']).toBeCloseTo(0.25);
  });

  it('the default notch is 0.5 and a real wheel event on the canvas reaches the axis', () => {
    const { canvas, log } = rig(false);
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, deltaMode: 0, cancelable: true }));
    expect(log.deliver('body').axes['zoomIn']).toBe(0.5);
  });

  it('a blocked (spectating) body hears no wheel', () => {
    const { log } = createInputPort({ map: WORLD });
    log.setBlocked('body', true);
    log.push({ type: 'pulse', control: 'mouse:wheelUp' });
    expect(log.deliver('body').axes['zoomIn']).toBe(0);
  });
});
