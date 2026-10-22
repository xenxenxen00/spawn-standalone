// UI2b rail: the right-side control cluster (docs/design/audio-ui-input.md §3.10).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Rail, type RailDeps } from '../../../src/runtime/ui/chrome/rail.ts';

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

function deps(over: Partial<RailDeps> = {}): RailDeps {
  return { touchActive: false, onPause: () => {}, fullscreen: null, ...over };
}

let g: ReturnType<typeof stubGlobals>;
let m: HTMLElement;

beforeEach(() => {
  g = stubGlobals();
  m = mount();
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('chrome rail', () => {
  it('builds a labelled toolbar inside #port-chrome', () => {
    const rail = new Rail(document, m, deps({ globals: g.api }));
    const el = m.querySelector('.ss-rail');
    expect(el).not.toBeNull();
    expect(el!.getAttribute('role')).toBe('toolbar');
    expect(rail.el).toBe(el);
  });

  it('dims to .35 while pointer-locked, .9 otherwise', () => {
    const rail = new Rail(document, m, deps({ globals: g.api }));
    rail.setLocked(true);
    expect(rail.el.style.opacity).toBe('0.35');
    rail.setLocked(false);
    expect(rail.el.style.opacity).toBe('0.9');
  });

  it('MUTE has an accessible name and calls the mute global', () => {
    const rail = new Rail(document, m, deps({ globals: g.api }));
    const btn = rail.el.querySelector<HTMLButtonElement>('.ss-rail-mute');
    expect(btn).not.toBeNull();
    expect(btn!.getAttribute('aria-label')).toBe('Mute');
    expect(btn!.tabIndex).not.toBe(-1);
    btn!.click();
    expect(g.calls).toEqual(['mute']);
  });

  it('shows the PLATFORM tag only while the platform is muted', () => {
    const rail = new Rail(document, m, deps({ globals: g.api }));
    expect(rail.el.querySelector('.ss-platform-tag')).toBeNull();
    rail.setPlatformMuted(true);
    const tag = rail.el.querySelector('.ss-platform-tag');
    expect(tag).not.toBeNull();
    expect(tag!.textContent).toBe('PLATFORM');
    rail.setPlatformMuted(false);
    expect(rail.el.querySelector('.ss-platform-tag')).toBeNull();
  });

  it("MUTE shows the player's mute (aria-pressed) and is slashed for either mute", () => {
    const rail = new Rail(document, m, deps({ globals: g.api }));
    const btn = rail.el.querySelector<HTMLButtonElement>('.ss-rail-mute')!;
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.classList.contains('is-muted')).toBe(false);
    rail.setUserMuted(true);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(btn.classList.contains('is-muted')).toBe(true);
    rail.setUserMuted(false);
    rail.setPlatformMuted(true);
    // the platform's mute is not the player's: not pressed, but slashed and tagged
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(btn.classList.contains('is-muted')).toBe(true);
    rail.setPlatformMuted(false);
    expect(btn.classList.contains('is-muted')).toBe(false);
  });

  it('PAUSE is always present on touch, even while locked', () => {
    const rail = new Rail(document, m, deps({ touchActive: true, globals: g.api }));
    rail.setLocked(true);
    const btn = rail.el.querySelector<HTMLButtonElement>('.ss-rail-pause');
    expect(btn).not.toBeNull();
    expect(btn!.hidden).toBe(false);
  });

  it('PAUSE shows on desktop only when the cursor is free', () => {
    let paused = 0;
    const rail = new Rail(document, m, deps({ globals: g.api, onPause: () => void paused++ }));
    const btn = rail.el.querySelector<HTMLButtonElement>('.ss-rail-pause');
    expect(btn).not.toBeNull();
    expect(btn!.getAttribute('aria-label')).toBe('Pause');
    btn!.click();
    expect(paused).toBe(1);
    rail.setLocked(true);
    expect(btn!.hidden).toBe(true);
    rail.setLocked(false);
    expect(btn!.hidden).toBe(false);
  });

  it('FULLSCREEN appears only when the control is provided', () => {
    const plain = new Rail(document, m, deps({ globals: g.api }));
    expect(plain.el.querySelector('.ss-rail-fullscreen')).toBeNull();
    plain.dispose();

    let toggled = 0;
    const rail = new Rail(document, m, deps({ globals: g.api, fullscreen: { toggle: () => void toggled++ } }));
    const btn = rail.el.querySelector<HTMLButtonElement>('.ss-rail-fullscreen');
    expect(btn).not.toBeNull();
    expect(btn!.getAttribute('aria-label')).toBe('Fullscreen');
    btn!.click();
    expect(toggled).toBe(1);
  });

  it('dispose removes the rail', () => {
    const rail = new Rail(document, m, deps({ globals: g.api }));
    rail.dispose();
    expect(m.querySelector('.ss-rail')).toBeNull();
  });
});
