// UI2b flash overlay: opt-in screen flash (X-12), routed only when port.screenFlash = 'overlay'.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  FlashOverlay,
  FLASH_GUARD_BASE,
  FLASH_GUARD_CHANNEL,
  FLASH_MERGE_WINDOW_MS,
  FLASH_ONSET_CAP,
} from '../../../src/runtime/ui/chrome/flash-overlay.ts';
import { createManualClock, type ManualClock } from './fake-clock.ts';

function mount(): HTMLElement {
  const m = document.createElement('div');
  m.id = 'port-chrome';
  document.body.appendChild(m);
  return m;
}

let m: HTMLElement;
let clock: ManualClock;

beforeEach(() => {
  m = mount();
  clock = createManualClock(1000);
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('flash overlay', () => {
  it('is a no-op unless opted in', () => {
    const flash = new FlashOverlay(document, m, { clock });
    flash.flash({ intensity: 1, durationMs: 500 });
    clock.advance(1000);
    expect(flash.active).toBe(false);
    expect(flash.el.hidden).toBe(true);
    expect(clock.pending()).toBe(0);
  });

  it("draws in the act's colour, the stylesheet's white otherwise", () => {
    const flash = new FlashOverlay(document, m, { clock, mode: 'overlay' });
    flash.flash({ intensity: 1, durationMs: 100, color: '#ff0000' });
    expect(flash.el.style.backgroundColor).toBe('rgb(255, 0, 0)');
    clock.advance(1000); // the flash ends
    flash.flash({ intensity: 1, durationMs: 100 });
    expect(flash.el.style.backgroundColor).toBe('');
  });

  it('onset alpha is min(0.25, 0.35 * intensity)', () => {
    const flash = new FlashOverlay(document, m, { clock, mode: 'overlay' });
    flash.flash({ intensity: 1, durationMs: 1000 });
    expect(flash.active).toBe(true);
    expect(flash.el.hidden).toBe(false);
    expect(flash.currentAlpha()).toBeCloseTo(0.25, 6);
    expect(FLASH_ONSET_CAP).toBe(0.25);

    const soft = new FlashOverlay(document, m, { clock, mode: 'overlay' });
    soft.flash({ intensity: 0.5, durationMs: 1000 });
    expect(soft.currentAlpha()).toBeCloseTo(0.175, 6);
  });

  it('caps the onset at 0.25 for large intensities', () => {
    const flash = new FlashOverlay(document, m, { clock, mode: 'overlay' });
    flash.flash({ intensity: 10, durationMs: 1000 });
    expect(flash.currentAlpha()).toBeCloseTo(0.25, 6);
  });

  it('fades linearly over the duration, then hides', () => {
    const flash = new FlashOverlay(document, m, { clock, mode: 'overlay' });
    flash.flash({ intensity: 1, durationMs: 1000 });
    clock.advance(500);
    expect(flash.currentAlpha()).toBeCloseTo(0.125, 6);
    clock.advance(500);
    expect(flash.active).toBe(false);
    expect(flash.el.hidden).toBe(true);
    expect(flash.el.style.opacity).toBe('0');
  });

  it('merges events within 334 ms: max intensity, extended end', () => {
    const flash = new FlashOverlay(document, m, { clock, mode: 'overlay' });
    flash.flash({ intensity: 0.5, durationMs: 1000 }); // t=1000, onset 0.175, end 2000
    clock.advance(200); // t=1200
    flash.flash({ intensity: 1, durationMs: 1000 }); // merged: onset 0.25, end 2200
    expect(FLASH_MERGE_WINDOW_MS).toBe(334);
    // onset recomputed from the max intensity, fading from the original start
    expect(flash.currentAlpha()).toBeCloseTo(0.25 * (1 - 200 / 1200), 6);
    clock.advance(900); // t=2100: past the original end, still active via the extension
    expect(flash.active).toBe(true);
    clock.advance(200); // t=2300: past the extended end
    expect(flash.active).toBe(false);
  });

  it('starts a new event past the merge window', () => {
    const flash = new FlashOverlay(document, m, { clock, mode: 'overlay' });
    flash.flash({ intensity: 1, durationMs: 1000 }); // t=1000
    clock.advance(400); // t=1400, outside the 334 ms window
    flash.flash({ intensity: 0.2, durationMs: 100 });
    expect(flash.currentAlpha()).toBeCloseTo(0.35 * 0.2, 6);
  });

  it('routes through the FlashGuard channel when flash is reduced', () => {
    const applied: Array<{ target: number; nowMs: number; dt: number }> = [];
    const guard = {
      channel: (key: string, base: number) => {
        expect(key).toBe(FLASH_GUARD_CHANNEL);
        expect(base).toBe(FLASH_GUARD_BASE);
        return {
          apply: (target: number, nowMs: number, dt: number) => {
            applied.push({ target, nowMs, dt });
            return 0.99;
          },
        };
      },
    };
    const flash = new FlashOverlay(document, m, { clock, mode: 'overlay', reducedFlash: true, flashGuard: guard });
    flash.flash({ intensity: 1, durationMs: 1000 });
    expect(applied.length).toBeGreaterThan(0);
    expect(applied[0]!.target).toBeCloseTo(0.25, 6);
    expect(applied[0]!.nowMs).toBe(1000);
    expect(flash.el.style.opacity).toBe('0.99');
  });

  it('reducedFlash as a function is honoured', () => {
    let reduced = false;
    // faithful to the real createFlashGuard contract: the overlay syncs setEnabled with the live pref and the
    // channel keeps being applied while disabled (identity), so the double models both states
    const faithfulGuard = () => {
      let enabled = false;
      return {
        setEnabled: (on: boolean): void => {
          enabled = on;
        },
        channel: () => ({ apply: (t: number) => (enabled ? t / 2 : t) }),
      };
    };
    const flash = new FlashOverlay(document, m, {
      clock,
      mode: 'overlay',
      reducedFlash: () => reduced,
      flashGuard: faithfulGuard(),
    });
    flash.flash({ intensity: 1, durationMs: 1000 });
    // not reduced: the guard is disabled, apply is identity
    expect(flash.el.style.opacity).toBe('0.25');
    reduced = true;
    const flash2 = new FlashOverlay(document, m, {
      clock,
      mode: 'overlay',
      reducedFlash: () => reduced,
      flashGuard: faithfulGuard(),
    });
    flash2.flash({ intensity: 1, durationMs: 1000 });
    expect(flash2.el.style.opacity).toBe('0.125');
  });

  it('dispose stops the fade and removes the element', () => {
    const flash = new FlashOverlay(document, m, { clock, mode: 'overlay' });
    flash.flash({ intensity: 1, durationMs: 10000 });
    flash.dispose();
    expect(m.querySelector('.ss-flash')).toBeNull();
    clock.advance(20000);
    expect(clock.pending()).toBe(0);
  });
});
