// UI2b trophy toast: .ss-toast, z-index 30, below the pause overlay, beside the rail.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Toast, TOAST_DURATION_MS, TOAST_Z_INDEX } from '../../../src/runtime/ui/chrome/toast.ts';
import { createManualClock, type ManualClock } from './fake-clock.ts';

function mount(): HTMLElement {
  const m = document.createElement('div');
  m.id = 'port-chrome';
  document.body.appendChild(m);
  return m;
}

let m: HTMLElement;
let clock: ManualClock;
let toast: Toast;

beforeEach(() => {
  m = mount();
  clock = createManualClock(0);
  toast = new Toast(document, m, clock);
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('trophy toast', () => {
  it('renders a polite live-region toast with the title', () => {
    toast.show({ title: 'First Blood' });
    const el = m.querySelector('.ss-toast');
    expect(el).not.toBeNull();
    expect(el!.textContent).toContain('First Blood');
    expect(el!.getAttribute('role')).toBe('status');
    expect(TOAST_Z_INDEX).toBe(30);
  });

  it('renders the subtitle when provided', () => {
    toast.show({ title: 'First Blood', subtitle: 'Wave 3 cleared' });
    expect(m.querySelector('.ss-toast-sub')!.textContent).toBe('Wave 3 cleared');
  });

  it('auto-dismisses after the duration', () => {
    toast.show({ title: 'First Blood' });
    expect(m.querySelector('.ss-toast')).not.toBeNull();
    clock.advance(TOAST_DURATION_MS);
    expect(m.querySelector('.ss-toast')).toBeNull();
  });

  it('replaces the current toast', () => {
    toast.show({ title: 'First Blood' });
    toast.show({ title: 'Sharpshooter' });
    const els = m.querySelectorAll('.ss-toast');
    expect(els).toHaveLength(1);
    expect(els[0]!.textContent).toContain('Sharpshooter');
  });

  it('dispose removes the toast and cancels the timer', () => {
    toast.show({ title: 'First Blood' });
    toast.dispose();
    expect(m.querySelector('.ss-toast')).toBeNull();
    clock.advance(TOAST_DURATION_MS * 2);
    expect(clock.pending()).toBe(0);
  });
});
