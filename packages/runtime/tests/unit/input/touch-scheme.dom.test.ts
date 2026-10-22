// Authored touch controls, hold/pulse actions and world press/tap gestures.
import { afterEach, describe, expect, it } from 'vitest';
import type { InputsDef } from '../../../src/compat/core/types.ts';
import { InputLog } from '../../../src/runtime/input/input-log.ts';
import { touchScheme } from '../../../src/runtime/input/touch/scheme.ts';
import { TouchLayer } from '../../../src/runtime/input/touch/touch-layer.ts';

function pointer(type: string, id: number, x: number, y: number): PointerEvent {
  return new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true });
}

afterEach(() => document.body.replaceChildren());

function layer(map: InputsDef, scheme?: ReturnType<typeof touchScheme>) {
  const container = document.createElement('div');
  document.body.append(container);
  const log = new InputLog({ map });
  const touch = new TouchLayer({ container, input: log, read: () => ({}), maxTouchPoints: () => 5, now: () => 0, doc: document, ...(scheme ? { scheme } : {}) });
  touch.mount();
  const root = container.querySelector<HTMLElement>('.ss-touch-controls')!;
  return { log, touch, root, container };
}

describe('Authored scheme: stick, DASH held, ITEM pulse, no look', () => {
  const MAP: InputsDef = { actions: { dash: { keys: ['space'] }, boop: {}, sprint: {} }, axes: { moveX: { keys: 'a/d' }, moveZ: { keys: 's/w' } } };
  const scheme = touchScheme({
    controls: [
      { id: 'dash', label: 'DASH', hold: true, x: 90, y: 60 },
      { id: 'boop', label: 'ITEM', action: 'boop', x: 80, y: 80, size: 70 },
    ],
    stick: { x: 'moveX', y: 'moveZ' },
  });

  it('draws only its controls, with the authored words, places and sizes, and no implicit slots', () => {
    const { root } = layer(MAP, scheme);
    const chips = [...root.querySelectorAll<HTMLButtonElement>('[data-touch]')].map((b) => b.dataset['touch']);
    expect(chips).toEqual(['dash', 'boop']);
    const dash = root.querySelector<HTMLButtonElement>('[data-touch="dash"]')!;
    expect(dash.textContent).toBe('DASH');
    expect(dash.style.getPropertyValue('--touch-x')).toBe('90%');
    expect(root.querySelector<HTMLButtonElement>('[data-touch="boop"]')!.style.getPropertyValue('--touch-size')).toContain('70px');
    expect(root.querySelector('.ss-touch-slots')).toBeNull();
  });

  it('DASH is held while pressed, ITEM pulses, the stick writes the named axes and never sprints', () => {
    const { log, root } = layer(MAP, scheme);
    const dash = root.querySelector('[data-touch="dash"]')!;
    dash.dispatchEvent(pointer('pointerdown', 1, 900, 300));
    expect(log.deliver('body').held['dash']).toBe(true);
    dash.dispatchEvent(pointer('pointerup', 1, 900, 300));
    expect(log.deliver('body').held['dash']).toBeUndefined();
    const boop = root.querySelector('[data-touch="boop"]')!;
    boop.dispatchEvent(pointer('pointerdown', 2, 800, 400));
    boop.dispatchEvent(pointer('pointerup', 2, 800, 400));
    expect(log.deliver('body').pressed['boop']).toBe(true);
    root.dispatchEvent(pointer('pointerdown', 3, 100, 300));
    root.dispatchEvent(pointer('pointermove', 3, 160, 300));
    const s = log.deliver('body');
    expect(s.axes['moveX']).toBeGreaterThan(0.5);
    expect(s.held['sprint']).toBeUndefined();
  });

  it('look: false means a drag outside the stick pocket turns nothing', () => {
    const { log, root } = layer(MAP, scheme);
    root.dispatchEvent(pointer('pointerdown', 4, 900, 200));
    root.dispatchEvent(pointer('pointermove', 4, 960, 240));
    expect(log.deliver('rig').axes['lookX']).toBe(0);
  });
});

describe('Press scheme: no chips, gesture press', () => {
  const MAP: InputsDef = { actions: { steer: {}, go: {} } };
  const scheme = touchScheme({ gestures: { press: 'steer' } });

  it('a press on the world holds the action and the input pointer follows the finger', () => {
    const { log, root, container } = layer(MAP, scheme);
    expect(container.querySelectorAll('[data-touch]').length).toBe(0);
    root.dispatchEvent(pointer('pointerdown', 1, 256, 192)); // 1024 x 768 viewport
    let s = log.deliver('body');
    expect(s.held['steer']).toBe(true);
    expect(s.pressed['steer']).toBe(true);
    expect(s.pointer?.ndcX).toBeCloseTo(-0.5);
    expect(s.pointer?.ndcY).toBeCloseTo(0.5);
    root.dispatchEvent(pointer('pointermove', 1, 768, 576));
    s = log.deliver('body');
    expect(s.pointer?.ndcX).toBeCloseTo(0.5);
    expect(s.pointer?.ndcY).toBeCloseTo(-0.5);
    root.dispatchEvent(pointer('pointerup', 1, 768, 576));
    s = log.deliver('body');
    expect(s.held['steer']).toBeUndefined();
    expect(s.released['steer']).toBe(true);
  });

  it('measures the pointer in the given canvas rect and releases on blur', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const log = new InputLog({ map: MAP });
    const touch = new TouchLayer({
      container, input: log, read: () => ({}), maxTouchPoints: () => 5, doc: document, scheme,
      pointerSpace: () => ({ left: 100, top: 0, width: 400, height: 200 }),
    });
    touch.mount();
    container.querySelector('.ss-touch-controls')!.dispatchEvent(pointer('pointerdown', 1, 300, 100));
    const s = log.deliver('body');
    expect(s.pointer).toMatchObject({ x: 200, y: 100, ndcX: 0, ndcY: 0 });
    window.dispatchEvent(new Event('blur'));
    expect(log.deliver('body').held['steer']).toBeUndefined();
  });
});

describe('Tap scheme: gesture tap', () => {
  const MAP: InputsDef = { actions: { select: {} } };
  const scheme = touchScheme({ gestures: { tap: 'select' } });

  it('a short touch pulses the action with the pointer at the tap; a long drag does not', () => {
    const { log, root } = layer(MAP, scheme);
    root.dispatchEvent(pointer('pointerdown', 1, 512, 384));
    root.dispatchEvent(pointer('pointerup', 1, 514, 384));
    const s = log.deliver('body');
    expect(s.pressed['select']).toBe(true);
    expect(s.pointer?.ndcX).toBeCloseTo(0.004, 2);
    root.dispatchEvent(pointer('pointerdown', 2, 100, 100));
    root.dispatchEvent(pointer('pointerup', 2, 300, 300));
    expect(log.deliver('body').pressed['select']).toBeUndefined();
  });
});

describe('simultaneous authored controls', () => {
  it('holds movement and an action together, then releases both when a modal opens', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const log = new InputLog({ map: { actions: { activate: {} }, axes: { horizontal: {}, vertical: {} } } });
    let modal = false;
    const touch = new TouchLayer({
      container, input: log, read: () => ({ modal }), maxTouchPoints: () => 5, doc: document,
      scheme: touchScheme({ controls: [{ id: 'activate', label: 'Activate', hold: true }], stick: { x: 'horizontal', y: 'vertical' }, look: true }),
    });
    touch.mount();
    const root = container.querySelector<HTMLElement>('.ss-touch-controls')!;
    const button = root.querySelector('[data-touch="activate"]')!;
    root.dispatchEvent(pointer('pointerdown', 1, 80, 300));
    root.dispatchEvent(pointer('pointermove', 1, 80, 244));
    button.dispatchEvent(pointer('pointerdown', 2, 800, 300));
    root.dispatchEvent(pointer('pointerdown', 3, 800, 200));
    root.dispatchEvent(pointer('pointermove', 3, 810, 190));
    const active = log.deliver('body');
    expect(active.axes['vertical']).toBeGreaterThan(0.5);
    expect(active.held['activate']).toBe(true);
    expect(log.look.integrate().yaw).toBeLessThan(0);
    modal = true;
    touch.frame();
    expect(root.hidden).toBe(true);
    const released = log.deliver('body');
    expect(released.held['activate']).toBeUndefined();
    expect(released.axes['horizontal']).toBe(0);
    expect(released.axes['vertical']).toBe(0);
    touch.dispose();
  });
});

describe('the default scheme is empty', () => {
  it('adds no game controls, stick, look or gestures implicitly', () => {
    const MAP: InputsDef = { actions: { fire: {}, sprint: {} }, axes: { moveX: {}, moveZ: {} } };
    const { root } = layer(MAP);
    expect(touchScheme({}).controls.length).toBe(0);
    expect(root.querySelectorAll('[data-touch]').length).toBe(0);
    expect(touchScheme({})).toMatchObject({ look: false, plain: true, gestures: {}, stick: false });
    expect(root.querySelector('.ss-touch-stick')).toBeNull();
  });

  it('a scheme rejects a repeated control id', () => {
    expect(() => touchScheme({ controls: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] })).toThrow(/repeated/);
  });
});

describe('passThrough layer (TouchLayerOptions.surface): the root does not cover sibling UI', () => {
  const MAP: InputsDef = { actions: { select: {}, dash: { keys: ['space'] } } };
  const scheme = touchScheme({ controls: [{ id: 'dash', label: 'DASH', hold: true, x: 90, y: 60 }], gestures: { tap: 'select' } });

  function pass(surface = true) {
    const container = document.createElement('div');
    const canvas = document.createElement('canvas');
    const hud = document.createElement('button');
    container.append(hud);
    document.body.append(canvas, container);
    const log = new InputLog({ map: MAP });
    const touch = new TouchLayer({ container, input: log, read: () => ({}), maxTouchPoints: () => 5, now: () => 0, doc: document, scheme, ...(surface ? { surface: canvas } : {}) });
    touch.mount();
    const root = container.querySelector<HTMLElement>('.ss-touch-controls')!;
    return { log, touch, root, canvas, hud };
  }

  it('the root takes no pointer events and only the controls do', () => {
    const { root } = pass();
    expect(root.style.pointerEvents).toBe('none');
    expect(root.hasAttribute('data-touch-passthrough')).toBe(true);
    expect(root.querySelector<HTMLElement>('[data-touch="dash"]')!.style.pointerEvents).toBe('auto');
  });

  it('default (no surface): the root is PP\'s, with no inline pointer-events', () => {
    const { root } = pass(false);
    expect(root.style.pointerEvents).toBe('');
    expect(root.hasAttribute('data-touch-passthrough')).toBe(false);
  });

  it('controls still work, a tap on the canvas still gestures, a tap on a sibling HUD button does not', () => {
    const { log, root, canvas, hud } = pass();
    const dash = root.querySelector('[data-touch="dash"]')!;
    dash.dispatchEvent(pointer('pointerdown', 1, 900, 300));
    expect(log.deliver('body').held['dash']).toBe(true);
    dash.dispatchEvent(pointer('pointerup', 1, 900, 300));
    canvas.dispatchEvent(pointer('pointerdown', 2, 512, 384));
    root.dispatchEvent(pointer('pointerup', 2, 513, 384)); // pointer capture retargets the release to the root
    expect(log.deliver('body').pressed['select']).toBe(true);
    hud.dispatchEvent(pointer('pointerdown', 3, 50, 50));
    root.dispatchEvent(pointer('pointerup', 3, 50, 50));
    expect(log.deliver('body').pressed['select']).toBeUndefined();
  });

  it('dispose removes the surface listener', () => {
    const { log, touch, canvas } = pass();
    touch.dispose();
    canvas.dispatchEvent(pointer('pointerdown', 4, 10, 10));
    expect(log.deliver('body').pressed['select']).toBeUndefined();
  });
});
