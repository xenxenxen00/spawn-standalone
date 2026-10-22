// UI2b pause overlay: the chrome modal shown while a match is paused (§3.10).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PauseOverlay, PAUSE_REASON_LABELS, type PauseReason } from '../../../src/runtime/ui/chrome/pause-overlay.ts';

function stubGlobals() {
  const calls: string[] = [];
  return {
    calls,
    api: {
      mute: () => void calls.push('mute'),
      resume: () => void calls.push('resume'),
      nav: (panel: string) => void calls.push(`nav:${panel}`),
    },
  };
}

function mount(): HTMLElement {
  const m = document.createElement('div');
  m.id = 'port-chrome';
  document.body.appendChild(m);
  return m;
}

let g: ReturnType<typeof stubGlobals>;
let m: HTMLElement;
let overlay: PauseOverlay;

beforeEach(() => {
  g = stubGlobals();
  m = mount();
  overlay = new PauseOverlay(document, m, g.api, {panels:[{id:'settings',label:'SETTINGS'},{id:'controls',label:'CONTROLS'}],hint:'M opens the full menu'});
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('pause overlay', () => {
  it('has no assumed game panels and accepts host-specific pause labels', () => {
    const neutral = new PauseOverlay(document,m,g.api,{labels:{network:'Reconnecting'}});
    neutral.show('network');
    expect(neutral.el.querySelector('.ss-pause-reason')!.textContent).toBe('Reconnecting');
    expect([...neutral.el.querySelectorAll('button')].map(b=>b.textContent)).toEqual(['RESUME','MUTE']);
    expect(neutral.el.querySelector('.ss-pause-hint')!.hasAttribute('hidden')).toBe(true);
    neutral.dispose();
  });
  it('starts hidden and is not a modal', () => {
    expect(overlay.visible).toBe(false);
    expect(overlay.el.hidden).toBe(true);
  });

  it('show exposes a labelled modal dialog with the reason', () => {
    overlay.show('ad');
    expect(overlay.visible).toBe(true);
    expect(overlay.el.hidden).toBe(false);
    expect(overlay.el.getAttribute('data-modal')).not.toBeNull();
    const dialog = overlay.el.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.getAttribute('aria-modal')).toBe('true');
    expect(overlay.el.querySelector('.ss-pause-reason')!.textContent).toBe('AD BREAK');
  });

  it('maps every reason to its label', () => {
    const cases: Array<[PauseReason, string]> = [
      ['user', 'PAUSED'],
      ['ad', 'AD BREAK'],
      ['background', 'GAME IN BACKGROUND'],
    ];
    for (const [reason, label] of cases) {
      overlay.show(reason);
      expect(overlay.el.querySelector('.ss-pause-reason')!.textContent).toBe(label);
      expect(PAUSE_REASON_LABELS[reason]).toBe(label);
      overlay.hide();
    }
  });

  it('buttons route to the page globals', () => {
    overlay.show();
    const click = (label: string) => {
      const btns = Array.from(overlay.el.querySelectorAll('button'));
      const btn = btns.find((b) => b.textContent === label);
      expect(btn).not.toBeNull();
      btn!.click();
    };
    click('RESUME');
    click('SETTINGS');
    click('CONTROLS');
    click('MUTE');
    expect(g.calls).toEqual(['resume', 'nav:settings', 'nav:controls', 'mute']);
  });

  it('notes that M opens the full menu', () => {
    overlay.show();
    expect(overlay.el.querySelector('.ss-pause-hint')!.textContent).toContain('M opens the full menu');
  });

  it('moves focus into the dialog on show and restores it on hide', () => {
    const before = document.createElement('button');
    before.textContent = 'before';
    document.body.appendChild(before);
    before.focus();
    overlay.show();
    const dialog = overlay.el.querySelector('[role="dialog"]')!;
    expect(dialog.contains(document.activeElement)).toBe(true);
    overlay.hide();
    expect(overlay.visible).toBe(false);
    expect(overlay.el.hidden).toBe(true);
    expect(document.activeElement).toBe(before);
  });

  it('traps Tab inside the dialog', () => {
    overlay.show();
    const btns = Array.from(overlay.el.querySelectorAll('button'));
    const first = btns[0]!;
    const last = btns[btns.length - 1]!;
    last.focus();
    overlay.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(first);
    first.focus();
    const ev = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    overlay.el.dispatchEvent(ev);
    expect(document.activeElement).toBe(last);
  });

  it('dispose removes the overlay', () => {
    overlay.show();
    overlay.dispose();
    expect(m.querySelector('.ss-pause')).toBeNull();
  });
});
