// wheel (io §4.2; contract §12.2: one notch = one wheelUp/wheelDown pulse): deltaY normalised to pixels (line ×40, page ×800),
// one pulse per 40 px crossed, at most one pulse per 30 ms (the excess of a burst is dropped).
import { afterEach, describe, expect, it } from 'vitest';
import { WHEEL_LINE_PX, WHEEL_PAGE_PX, WHEEL_PULSE_PX, WheelPulser, installKeyboardMouse, normalizeWheelDelta, type InputSink } from '../../../src/runtime/input/keyboard-mouse.ts';
import type { RawInputEvent } from '../../../src/runtime/input/input-log.ts';

const PIXEL = 0;
const LINE = 1;
const PAGE = 2;

describe('normalizeWheelDelta', () => {
  it('pixel, line and page modes', () => {
    expect(WHEEL_LINE_PX).toBe(40);
    expect(WHEEL_PAGE_PX).toBe(800);
    expect(WHEEL_PULSE_PX).toBe(40);
    expect(normalizeWheelDelta(100, PIXEL)).toBe(100);
    expect(normalizeWheelDelta(3, LINE)).toBe(120);
    expect(normalizeWheelDelta(-1, PAGE)).toBe(-800);
  });
});

describe('WheelPulser', () => {
  let t = 0;
  const clock = (): number => t;
  const pulser = (): WheelPulser => {
    t = 1000;
    return new WheelPulser({ now: clock });
  };

  it('one notch is one pulse in every delta mode (Chrome 100 px, Firefox 3 lines, a page)', () => {
    for (const [d, mode] of [[100, PIXEL], [3, LINE], [1, PAGE], [53, PIXEL]] as const) {
      const w = pulser();
      expect(w.feed(d, mode), `${d}@${mode}`).toBe('wheelDown');
      t += 200;
      expect(w.feed(-d, mode), `-${d}@${mode}`).toBe('wheelUp');
    }
  });

  it('small pixel deltas (touchpads) add up: one pulse per 40 px crossed', () => {
    const w = pulser();
    const out: Array<string | null> = [];
    for (let i = 0; i < 8; i++) {
      t += 16;
      out.push(w.feed(10, PIXEL));
    }
    expect(out).toEqual([null, null, null, 'wheelDown', null, null, null, 'wheelDown']);
  });

  it('at most one pulse per 30 ms; the excess of a burst is dropped', () => {
    const w = pulser();
    expect(w.feed(100, PIXEL)).toBe('wheelDown');
    t += 10;
    expect(w.feed(100, PIXEL)).toBeNull();
    t += 10;
    expect(w.feed(10, PIXEL)).toBeNull();
    t += 50;
    expect(w.feed(100, PIXEL)).toBe('wheelDown');
  });

  it('two notches 50 ms apart are two pulses; a direction change starts a fresh count', () => {
    const w = pulser();
    expect(w.feed(100, PIXEL)).toBe('wheelDown');
    t += 50;
    expect(w.feed(100, PIXEL)).toBe('wheelDown');
    t += 50;
    expect(w.feed(30, PIXEL)).toBeNull();
    t += 16;
    expect(w.feed(-30, PIXEL)).toBeNull();
    t += 16;
    expect(w.feed(-10, PIXEL)).toBe('wheelUp');
  });

  it('a zero delta does nothing', () => {
    expect(pulser().feed(0, PIXEL)).toBeNull();
  });
});

describe('wheel events on the canvas', () => {
  let dispose: (() => void) | null = null;
  afterEach(() => {
    dispose?.();
    dispose = null;
    document.body.replaceChildren();
  });

  function setup(): { canvas: HTMLCanvasElement; events: RawInputEvent[]; tick(ms: number): void } {
    let t = 5000;
    const canvas = document.createElement('canvas');
    document.body.append(canvas);
    const events: RawInputEvent[] = [];
    const sink: InputSink = {
      push: (e) => void events.push(e),
      releaseDevices: () => {},
      setPointer: () => {},
      isBound: () => true,
      touchActive: false,
      setTouchActive: () => {},
    };
    dispose = installKeyboardMouse(sink, canvas, { now: () => t, isLocked: () => true }).dispose;
    return { canvas, events, tick: (ms) => void (t += ms) };
  }

  it('pixel, line and page deltas → pulse counts, and the page does not scroll', () => {
    const { canvas, events, tick } = setup();
    const cases: Array<[number, number]> = [[100, PIXEL], [-3, LINE], [1, PAGE], [-120, PIXEL]];
    for (const [deltaY, deltaMode] of cases) {
      tick(100);
      const ev = new WheelEvent('wheel', { deltaY, deltaMode, bubbles: true, cancelable: true });
      canvas.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
    }
    expect(events).toEqual([
      { type: 'pulse', control: 'mouse:wheelDown', t: 5100 },
      { type: 'pulse', control: 'mouse:wheelUp', t: 5200 },
      { type: 'pulse', control: 'mouse:wheelDown', t: 5300 },
      { type: 'pulse', control: 'mouse:wheelUp', t: 5400 },
    ]);
  });

  it('a fast burst inside 30 ms is one pulse', () => {
    const { canvas, events, tick } = setup();
    for (let i = 0; i < 3; i++) {
      tick(5);
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, deltaMode: PIXEL, bubbles: true, cancelable: true }));
    }
    expect(events.filter((e) => e.type === 'pulse')).toHaveLength(1);
  });
});
