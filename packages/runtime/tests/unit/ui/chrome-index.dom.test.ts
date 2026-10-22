// UI2b Chrome: composition of rail / pause overlay / flash / trophy / damage numbers,
// the `chrome.hasModal()` contract for UiHostDeps, and the sink-act entry points.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Chrome, type ChromeDeps } from '../../../src/runtime/ui/chrome/index.ts';
import { createManualClock, type ManualClock } from './fake-clock.ts';

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

let g: ReturnType<typeof stubGlobals>;
let clock: ManualClock;
let mountEl: HTMLElement;

function chrome(over: Partial<ChromeDeps> = {}): Chrome {
  return new Chrome(document, mountEl, {
    touchActive: false,
    onPause: () => void g.calls.push('pause'),
    fullscreen: null,
    project: () => ({ x: 50, y: 60 }),
    globals: g.api,
    clock,
    ...over,
  });
}

beforeEach(() => {
  g = stubGlobals();
  clock = createManualClock(0);
  mountEl = document.createElement('div');
  mountEl.id = 'tome-ui-container';
  document.body.appendChild(mountEl);
});

afterEach(() => {
  document.body.innerHTML = '';
});

describe('chrome', () => {
  it('creates the #port-chrome root', () => {
    const c = chrome();
    expect(c.root.id).toBe('port-chrome');
    expect(mountEl.querySelector('#port-chrome')).toBe(c.root);
    expect(c.root.querySelector('.ss-rail')).not.toBeNull();
    expect(c.root.querySelector('.ss-pause')).not.toBeNull();
    expect(c.root.querySelector('.ss-flash')).not.toBeNull();
    expect(c.root.querySelector('.ss-damage-layer')).not.toBeNull();
    c.dispose();
  });

  it('hasModal is false until the pause overlay shows', () => {
    const c = chrome();
    expect(c.hasModal()).toBe(false);
    // paused with no match running: never shown (never LOBBY/RESULTS)
    c.setPaused(true, 'user');
    expect(c.hasModal()).toBe(false);
    expect(c.root.querySelector<HTMLElement>('.ss-pause')!.hidden).toBe(true);
    // a running match lets the modal stand
    c.setGameplayActive(true);
    expect(c.hasModal()).toBe(true);
    expect(c.root.querySelector('.ss-pause-reason')!.textContent).toBe('PAUSED');
    c.setPaused(false);
    expect(c.hasModal()).toBe(false);
    c.dispose();
  });

  it('the pause overlay reports its reason while a match runs', () => {
    const c = chrome();
    c.setGameplayActive(true);
    c.setPaused(true, 'background');
    expect(c.root.querySelector('.ss-pause-reason')!.textContent).toBe('GAME IN BACKGROUND');
    c.dispose();
  });

  it('setPointerLocked dims the rail and setPlatformMuted tags the mute button', () => {
    const c = chrome();
    c.setPointerLocked(true);
    expect(c.root.querySelector<HTMLElement>('.ss-rail')!.style.opacity).toBe('0.35');
    c.setPlatformMuted(true);
    expect(c.root.querySelector('.ss-platform-tag')!.textContent).toBe('PLATFORM');
    c.dispose();
  });

  it('flash is a no-op unless screenFlash is opted in', () => {
    const c = chrome();
    c.flash({ intensity: 1, durationMs: 500 });
    clock.advance(1000);
    expect(c.root.querySelector<HTMLElement>('.ss-flash')!.hidden).toBe(true);

    const opted = chrome({ screenFlash: 'overlay' });
    opted.flash({ intensity: 1, durationMs: 500 });
    expect(opted.root.querySelector<HTMLElement>('.ss-flash')!.hidden).toBe(false);
    clock.advance(1000);
    expect(opted.root.querySelector<HTMLElement>('.ss-flash')!.hidden).toBe(true);
    opted.dispose();
    c.dispose();
  });

  it('damage spawns a projected label (the damageNumber sink act)', () => {
    const c = chrome();
    c.damage({ position: { x: 1, y: 2, z: 3 }, text: '-12' });
    const label = c.root.querySelector('.ss-damage');
    expect(label).not.toBeNull();
    expect((label as HTMLElement).style.left).toBe('50px');
    expect((label as HTMLElement).style.top).toBe('60px');
    c.dispose();
  });

  it('trophy shows a toast', () => {
    const c = chrome();
    c.toast({ title: 'First Blood' });
    expect(c.root.querySelector('.ss-toast')!.textContent).toContain('First Blood');
    c.dispose();
  });

  it('dispose removes the chrome root', () => {
    const c = chrome();
    c.dispose();
    expect(mountEl.querySelector('#port-chrome')).toBeNull();
  });
});
