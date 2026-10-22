// WP R0: canvas replacement for the device-loss rebuild path (render §3.1 step 2, §3.3), against a real DOM (jsdom): the host
// swaps in a fresh <canvas> with the same id and CSS and tells its listeners, because DOM listeners and the pointer-lock target
// do not carry over to a new element with the same id (surfaced as `Renderer.onCanvasReplaced`; the rebinding itself is X3's).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCanvasHost, type CanvasHostControl, type SizeTarget } from '../../../src/render/engine/canvas-host.ts';
import { TIER_TABLE } from '../../../src/render/perf/budget.ts';

let stage: HTMLDivElement;
let canvas: HTMLCanvasElement;
let host: CanvasHostControl;
let sized: Array<[number, number]>;

const target = (): SizeTarget => ({ setPixelRatio: () => undefined, setSize: (w, h) => void sized.push([w, h]) });

beforeEach(() => {
  document.body.innerHTML = '<div id="stage"><canvas id="ss-canvas" class="scene fade" data-veil="on" tabindex="-1" style="touch-action: none; opacity: 0.5;" width="300" height="150"></canvas><div id="hud"></div></div>';
  stage = document.getElementById('stage') as HTMLDivElement;
  canvas = document.getElementById('ss-canvas') as HTMLCanvasElement;
  sized = [];
  host = createCanvasHost({ aspectRange: [0.5, 2],
    canvas,
    tier: TIER_TABLE.high,
    target: target(),
    env: { devicePixelRatio: () => 1, available: () => ({ left: 0, top: 0, width: 1280, height: 720 }) },
  });
});

afterEach(() => {
  host.dispose();
  document.body.innerHTML = '';
});

describe('replaceCanvas (jsdom)', () => {
  it('swaps a fresh canvas in at the same place, with the same id and CSS', () => {
    const before = canvas.getAttribute('style');
    const next = host.replaceCanvas();

    expect(next).not.toBe(canvas);
    expect(next).toBeInstanceOf(HTMLCanvasElement);
    expect(host.canvas).toBe(next);

    expect(next.id).toBe('ss-canvas');
    expect(next.className).toBe('scene fade');
    expect(next.getAttribute('style')).toBe(before);
    expect(next.style.touchAction).toBe('none');
    expect(next.style.opacity).toBe('0.5');
    expect(next.getAttribute('data-veil')).toBe('on');
    expect(next.getAttribute('tabindex')).toBe('-1');
    // the layout the host gave the old element is on the new one as well
    expect(next.style.width).toBe('1280px');
    expect(next.style.height).toBe('720px');

    expect(document.getElementById('ss-canvas')).toBe(next);
    expect(canvas.isConnected).toBe(false);
    expect([...stage.children]).toEqual([next, document.getElementById('hud')]);
    expect(document.querySelectorAll('canvas')).toHaveLength(1);
  });

  it('does not carry the old backing-store size over: the rebuilt renderer sets it', () => {
    const next = host.replaceCanvas();
    expect(next.hasAttribute('width')).toBe(false);
    expect(next.hasAttribute('height')).toBe(false);
  });

  it('fires onReplace(next, prev) once per listener, after the swap', () => {
    const seen: Array<{ next: HTMLCanvasElement; prev: HTMLCanvasElement; connected: boolean; current: boolean }> = [];
    host.onReplace((n, p) => seen.push({ next: n, prev: p, connected: n.isConnected, current: host.canvas === n }));
    host.onReplace((n, p) => seen.push({ next: n, prev: p, connected: n.isConnected, current: host.canvas === n }));
    const next = host.replaceCanvas();
    expect(seen).toEqual([
      { next, prev: canvas, connected: true, current: true },
      { next, prev: canvas, connected: true, current: true },
    ]);
  });

  it('onReplace returns an unsubscribe', () => {
    let n = 0;
    const off = host.onReplace(() => n++);
    host.replaceCanvas();
    off();
    host.replaceCanvas();
    expect(n).toBe(1);
  });

  it('a listener that throws does not stop the others or the swap', () => {
    let reached = false;
    host.onReplace(() => {
      throw new Error('listener');
    });
    host.onReplace(() => void (reached = true));
    expect(() => host.replaceCanvas()).not.toThrow();
    expect(reached).toBe(true);
  });

  it('the old renderer is no longer a size target: the rebuild attaches the new one', () => {
    sized.length = 0;
    host.replaceCanvas();
    host.invalidate();
    host.flush();
    expect(sized).toEqual([]);
    host.setTarget(target());
    expect(sized).toEqual([[1280, 720]]);
  });

  it('works twice in a row and on a detached canvas', () => {
    const a = host.replaceCanvas();
    const b = host.replaceCanvas();
    expect(document.getElementById('ss-canvas')).toBe(b);
    expect(a.isConnected).toBe(false);

    const loose = document.createElement('canvas');
    loose.id = 'loose';
    const other = createCanvasHost({ aspectRange: [0.5, 2], canvas: loose, tier: TIER_TABLE.low, env: { devicePixelRatio: () => 1, available: () => ({ left: 0, top: 0, width: 640, height: 360 }) } });
    const fresh = other.replaceCanvas();
    expect(fresh.id).toBe('loose');
    expect(fresh.isConnected).toBe(false);
    other.dispose();
  });
});

describe('the default environment (jsdom)', () => {
  it('measures the parent box, falls back to the window, and observes without a ResizeObserver', () => {
    Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 800 });
    Object.defineProperty(stage, 'clientHeight', { configurable: true, value: 300 });
    const h = createCanvasHost({ aspectRange: [0.5, 2], canvas, tier: TIER_TABLE.high });
    expect(h.size).toMatchObject({ cssW: 600, cssH: 300 }); // 800 × 300 is wider than 2:1
    expect(canvas.style.left).toBe('100px');

    // the window is resized: nothing happens until the frame flushes
    Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 500 });
    window.dispatchEvent(new Event('resize'));
    expect(h.size.cssW).toBe(600);
    expect(h.flush()).toBe(true);
    expect(h.size).toMatchObject({ cssW: 500, cssH: 300 });
    h.dispose();

    // after dispose the window listener is gone
    Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 400 });
    window.dispatchEvent(new Event('resize'));
    expect(h.flush()).toBe(false);
  });
});

describe('aspectRange option', () => {
  const make = (aspectRange?: readonly [number, number] | null) =>
    createCanvasHost({ canvas, tier: TIER_TABLE.high, target: target(), env: { devicePixelRatio: () => 1, available: () => ({ left: 0, top: 0, width: 2400, height: 600 }) }, ...(aspectRange === undefined ? {} : { aspectRange }) });
  it('an explicit range letterboxes 4:1 to 2:1; null fills the area', () => {
    const ss = make([0.5, 2]);
    expect(ss.size).toMatchObject({ cssW: 1200, cssH: 600 });
    ss.dispose();
    const free = make(null);
    expect(free.size).toMatchObject({ cssW: 2400, cssH: 600 });
    expect(canvas.style.left).toBe('0px');
    free.dispose();
  });
  it('an invalid range fills the area', () => {
    const bad = make([2, 1]);
    expect(bad.size).toMatchObject({ cssW: 2400, cssH: 600 });
    bad.dispose();
  });
});
