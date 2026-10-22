// @vitest-environment jsdom
// The default input part on a page: pointer lock on the canvas, the touch layer, unlocked look and the map options.
import { describe, expect, it } from 'vitest';
import { defaultParts } from '../../src/shell/compose-game.ts';

const inputs = { actions: { jump: { keys: ['space'] }, left: { keys: ['arrowleft'] }, ui_x: {} } };

function page() {
  const host = document.createElement('div');
  const canvas = document.createElement('canvas');
  host.append(canvas);
  document.body.append(host);
  return { host, canvas };
}

describe('default input part', () => {
  it('without options: keyboard and mouse only (no lock, no touch)', async () => {
    const { canvas } = page();
    const input = await defaultParts.input({ inputs, canvas, uiRoot: null, options: {}, headless: false });
    expect(input.lock ?? null).toBeNull();
    expect(input.touch ?? null).toBeNull();
    input.dispose();
  });

  it('pointerLock: a manager on the canvas that the action sink re-locks through', async () => {
    const { canvas } = page();
    const input = await defaultParts.input({ inputs, canvas, uiRoot: null, options: { pointerLock: { rawMouse: true } }, headless: false });
    expect(input.lock?.state).toBe('free');
    let requested = 0;
    (canvas as unknown as { requestPointerLock: () => void }).requestPointerLock = () => void requested++;
    (input.sink as { inject(n: string, p: unknown, o: unknown): boolean }).inject('jump', undefined, { relockPointer: true });
    expect(requested).toBe(1);
    input.dispose();
  });

  it('map options reach the input map: arrowAliases binds the arrow tokens', async () => {
    const { canvas } = page();
    const input = await defaultParts.input({ inputs, canvas, uiRoot: null, options: { map: { arrowAliases: true } }, headless: false });
    expect((input.log as { isBound(c: string): boolean }).isBound('ArrowLeft')).toBe(true);
    input.dispose();
    const plain = await defaultParts.input({ inputs, canvas, uiRoot: null, options: {}, headless: false });
    expect((plain.log as { isBound(c: string): boolean }).isBound('ArrowLeft')).toBe(false);
    plain.dispose();
  });

  it('touch: a layer in the UI container that mounts only where the device has touch points', async () => {
    const { canvas, host } = page();
    const none = await defaultParts.input({ inputs, canvas, uiRoot: host, options: { touch: { maxTouchPoints: () => 0 } }, headless: false });
    none.touch?.mount();
    expect(host.querySelector('.ss-touch-controls')).toBeNull();
    none.dispose();
    const some = await defaultParts.input({ inputs, canvas, uiRoot: host, options: { touch: { maxTouchPoints: () => 5, scheme: { controls: [], stick: false, look: false, gestures: { press: 'steer' }, plain: true } as never } }, headless: false });
    some.touch?.mount();
    expect(host.querySelector('.ss-touch-controls')).not.toBeNull();
    some.dispose();
    expect(host.querySelector('.ss-touch-controls')).toBeNull();
  });

  it('touch passThrough: the root takes no pointer events (HUD beside it stays tappable); absent keeps PP', async () => {
    const { canvas, host } = page();
    const scheme = { controls: [], stick: false, look: false, gestures: { press: 'steer' }, plain: true } as never;
    const pass = await defaultParts.input({ inputs, canvas, uiRoot: host, options: { touch: { maxTouchPoints: () => 5, scheme, passThrough: true } }, headless: false });
    pass.touch?.mount();
    expect(host.querySelector<HTMLElement>('.ss-touch-controls')!.style.pointerEvents).toBe('none');
    pass.dispose();
    const stock = await defaultParts.input({ inputs, canvas, uiRoot: host, options: { touch: { maxTouchPoints: () => 5, scheme } }, headless: false });
    stock.touch?.mount();
    expect(host.querySelector<HTMLElement>('.ss-touch-controls')!.style.pointerEvents).toBe('');
    stock.dispose();
  });

  it("touch rootClass renames the root element (and marks it for the stock styles); absent keeps PP's class", async () => {
    const { canvas, host } = page();
    const scheme = { controls: [], stick: false, look: false, gestures: { press: 'steer' }, plain: true } as never;
    const named = await defaultParts.input({ inputs, canvas, uiRoot: host, options: { touch: { maxTouchPoints: () => 5, scheme, rootClass: 'game-touch' } }, headless: false });
    named.touch?.mount();
    const root = host.querySelector('.game-touch');
    expect(root).not.toBeNull();
    expect(root!.hasAttribute('data-touch-root')).toBe(true);
    expect(host.querySelector('.ss-touch-controls')).toBeNull();
    named.dispose();
    const stock = await defaultParts.input({ inputs, canvas, uiRoot: host, options: { touch: { maxTouchPoints: () => 5, scheme } }, headless: false });
    stock.touch?.mount();
    expect(host.querySelector('.ss-touch-controls')!.hasAttribute('data-touch-root')).toBe(false);
    stock.dispose();
  });
});
