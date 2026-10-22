import { afterEach, describe, expect, it } from 'vitest';
import { touchScale } from '../../../src/runtime/input/touch/touch-layer.ts';
import { aimGain, crosshairDirection } from '../../../src/runtime/input/touch/aim-friction.ts';
import { sprintHeld, stickAxes } from '../../../src/runtime/input/touch/stick.ts';
import { RotatePrompt } from '../../../src/runtime/input/touch/rotate-prompt.ts';

afterEach(() => document.body.replaceChildren());

describe('authored touch controls', () => {
  it('maps the floating stick radially and applies sprint hysteresis', () => {
    expect(stickAxes(0, -56)).toEqual({ moveX: 0, moveZ: 1, magnitude: 1 });
    expect(stickAxes(0, -56, 112).moveZ).toBeCloseTo((0.5 - 0.12) / 0.88);
    expect(stickAxes(0, -3)).toMatchObject({ moveX: 0, moveZ: 0 });
    expect(stickAxes(0, -3).magnitude).toBeCloseTo(3 / 56);
    expect(stickAxes(100, 100).magnitude).toBe(1);
    expect([sprintHeld(0.96, 0, false), sprintHeld(0.96, 250, false), sprintHeld(0.86, 300, true), sprintHeld(0.84, 301, true)])
      .toEqual([false, true, true, false]);
    expect(touchScale(844, 390, 0.8)).toBe(0.8);
    expect(touchScale(844, 390, 1.4)).toBe(1.4);
    expect(touchScale(844, 390, Number.NaN)).toBe(1);
  });

  it('uses the injected target query only for touch aim friction', () => {
    const calls: unknown[][] = [];
    const query = (...args: [string, { x: number; y: number; z: number }, { x: number; y: number; z: number }, number, number]) => {
      calls.push(args);
      return [{ id: 'enemy:near' }];
    };
    expect(crosshairDirection(0, 0).x).toBeCloseTo(0);
    expect(crosshairDirection(0, 0).z).toBe(-1);
    expect(aimGain({ enabled: true, place: 'arena', eye: { x: 1, y: 2, z: 3 }, yaw: 0, pitch: 0, query })).toBe(0.6);
    expect(aimGain({ enabled: false, place: 'arena', eye: { x: 1, y: 2, z: 3 }, yaw: 0, pitch: 0, query })).toBe(1);
    expect(calls[0]?.slice(0, 2)).toEqual(['arena', { x: 1, y: 2, z: 3 }]);
    expect((calls[0]?.[2] as { x: number }).x).toBeCloseTo(0);
    expect(calls[0]?.slice(3)).toEqual([40, 0.45]);
  });

});

describe('rotate prompt', () => {
  it('pauses in touch portrait and resumes when the device returns to landscape', () => {
    const parent = document.createElement('div');
    document.body.append(parent);
    const reasons: string[] = [];
    let portrait = true;
    const prompt = new RotatePrompt({
      doc: document, mount: parent, enabled: true, isPortrait: () => portrait,
      pause: { add: (reason) => reasons.push(`add:${reason}`), remove: (reason) => reasons.push(`remove:${reason}`) },
      window: window,
    });
    prompt.mount();
    expect(prompt.el.hidden).toBe(false);
    expect(prompt.el.textContent).toContain('Turn your device sideways');
    expect(reasons).toEqual(['add:orientation']);
    portrait = false;
    window.dispatchEvent(new Event('resize'));
    expect(prompt.el.hidden).toBe(true);
    expect(reasons).toEqual(['add:orientation', 'remove:orientation']);
    prompt.dispose();
  });
});
