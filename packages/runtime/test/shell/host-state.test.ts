// @vitest-environment jsdom
// P-1 session.hostPaused, P-5 session.viewport, and a whole ad break on the web platform with the dev fake ads: the break pauses
// the clock and mutes audio through the PauseController, and the game is answered when the fake ad is over.
import { describe, expect, it } from 'vitest';
import { PauseController } from '../../src/platform/pause-controller.ts';
import { AdBreaks } from '../../src/shell/ad-break.ts';
import { createFakeAds } from '../../src/shell/fake-ads.ts';
import { bindHostPaused, installViewport } from '../../src/shell/host-state.ts';
import { createWebPlatform } from '../../src/shell/web-platform.ts';

/** the part of SimClock the PauseController uses */
function fakeClock() {
  const reasons = new Set<string>();
  return { reasons, pause: (r: string) => void reasons.add(r), resume: (r: string) => void reasons.delete(r) };
}
const fakeAudio = () => {
  const log: string[] = [];
  return { log, setPaused: (p: boolean) => void log.push(`paused ${p}`), setPlatformAudio: (e: boolean) => void log.push(`audio ${e}`) };
};

describe('bindHostPaused (P-1)', () => {
  it('follows the platform and hidden reasons into every session, and resets on unbind', () => {
    const clock = fakeClock();
    const pause = new PauseController(clock as never, fakeAudio());
    const sessions = [{} as Record<string, unknown>, {} as Record<string, unknown>];
    const off = bindHostPaused(() => sessions, pause);
    expect(sessions.map((s) => s['hostPaused'])).toEqual([false, false]);
    pause.add('platform');
    expect(sessions.map((s) => s['hostPaused'])).toEqual([true, true]);
    pause.remove('platform');
    pause.add('hidden');
    expect(sessions[0]!['hostPaused']).toBe(true);
    pause.remove('hidden');
    pause.add('ad');
    expect(sessions[0]!['hostPaused']).toBe(false);
    pause.add('platform');
    off();
    expect(sessions.map((s) => s['hostPaused'])).toEqual([false, false]);
  });
});

describe('installViewport (P-5)', () => {
  function viewport(w: number, h: number, dpr = 1) {
    Object.defineProperty(window, 'innerWidth', { value: w, configurable: true });
    Object.defineProperty(window, 'innerHeight', { value: h, configurable: true });
    Object.defineProperty(window, 'devicePixelRatio', { value: dpr, configurable: true });
  }

  it('publishes size, aspect, orientation and the CSS variables, updates on resize and rotation', () => {
    document.head.innerHTML = '<meta name="viewport" content="width=device-width">';
    viewport(390, 844, 3);
    const root = document.createElement('div');
    document.body.append(root);
    const sessions = [{} as Record<string, unknown>];
    const vp = installViewport(() => sessions, { container: root });
    expect(sessions[0]!['viewport']).toMatchObject({ width: 390, height: 844, dpr: 3, orientation: 'portrait', safe: { top: 0, right: 0, bottom: 0, left: 0 } });
    expect((sessions[0]!['viewport'] as { aspect: number }).aspect).toBeCloseTo(390 / 844);
    expect(root.style.getPropertyValue('--ss-aspect')).toBe(String(390 / 844));
    expect(root.style.getPropertyValue('--ss-safe-top')).toBe('0px');
    viewport(844, 390, 3);
    window.dispatchEvent(new Event('resize'));
    expect(sessions[0]!['viewport']).toMatchObject({ width: 844, height: 390, orientation: 'landscape' });
    expect(vp.read().aspect).toBeCloseTo(844 / 390);
    viewport(390, 844);
    window.dispatchEvent(new Event('orientationchange'));
    expect(vp.read().orientation).toBe('portrait');
    expect(document.querySelector('meta[name="viewport"]')?.getAttribute('content')).toBe('width=device-width, viewport-fit=cover');
    vp.dispose();
    expect(sessions[0]!['viewport']).toBeUndefined();
    expect(root.style.getPropertyValue('--ss-aspect')).toBe('');
    viewport(800, 600);
    window.dispatchEvent(new Event('resize'));
    expect(sessions[0]!['viewport']).toBeUndefined();
  });

  it('adds a viewport meta when the page has none, and leaves an existing viewport-fit alone', () => {
    document.head.innerHTML = '';
    viewport(100, 100);
    installViewport(() => []).dispose();
    expect(document.querySelector('meta[name="viewport"]')?.getAttribute('content')).toContain('viewport-fit=cover');
    document.head.innerHTML = '<meta name="viewport" content="width=device-width, viewport-fit=contain">';
    installViewport(() => [], { fitCover: true }).dispose();
    expect(document.querySelector('meta[name="viewport"]')?.getAttribute('content')).toBe('width=device-width, viewport-fit=contain');
    document.head.innerHTML = '<meta name="viewport" content="width=device-width">';
    installViewport(() => [], { fitCover: false }).dispose();
    expect(document.querySelector('meta[name="viewport"]')?.getAttribute('content')).toBe('width=device-width');
  });
});

describe('an ad break on the web platform with the dev fake ads', () => {
  it('pauses the clock and mutes audio while the ad is up, then answers the game', async () => {
    const platform = createWebPlatform({ storage: null, hostEvents: false, ads: (host) => createFakeAds(host, { mode: 'show', durationMs: 20 }) });
    await platform.init();
    const clock = fakeClock();
    const audio = fakeAudio();
    const pause = new PauseController(clock as never, audio);
    pause.bindPlatform(platform);
    const reasonsSeen: string[][] = [];
    pause.onChange((_p, reasons) => reasonsSeen.push([...reasons].sort()));
    const session: Record<string, unknown> = {};
    const breaks = new AdBreaks({ platform, sessions: () => [session] }, { afterPaint: (cb) => (cb(), () => {}) });
    const states: unknown[] = [];
    const answer = breaks.request({ placement: 'results' }).then((r) => (states.push(session['adBreak']), r));
    expect(session['adBreak']).toMatchObject({ state: 'showing' });
    await new Promise((r) => setTimeout(r, 5));
    expect(clock.reasons.has('ad')).toBe(false);
    expect(clock.reasons.has('platform')).toBe(true);
    expect(audio.log).toContain('audio false');
    expect(document.querySelector('[data-ss-fake-ad]')).not.toBeNull();
    const result = await answer;
    expect(result).toMatchObject({ state: 'done', shown: true });
    expect(states[0]).toMatchObject({ state: 'done' });
    expect(clock.reasons.size).toBe(0);
    expect(audio.log.at(-1)).toBe('audio true');
    expect(document.querySelector('[data-ss-fake-ad]')).toBeNull();
    expect(reasonsSeen.some((r) => r.includes('platform'))).toBe(true);
    platform.dispose();
  });

  it('no fill answers skipped and pauses nothing', async () => {
    const platform = createWebPlatform({ storage: null, hostEvents: false, ads: (host) => createFakeAds(host, { mode: 'fail', failAfterMs: 5 }) });
    await platform.init();
    const clock = fakeClock();
    new PauseController(clock as never, fakeAudio()).bindPlatform(platform);
    const session: Record<string, unknown> = {};
    const breaks = new AdBreaks({ platform, sessions: () => [session] }, { afterPaint: (cb) => (cb(), () => {}) });
    expect(await breaks.request({ placement: 'results' })).toMatchObject({ state: 'skipped', reason: 'other' });
    expect(clock.reasons.size).toBe(0);
    platform.dispose();
  });
});

describe('bindHostPaused linger (ext.hostPausedLinger)', () => {
  function rig(linger: boolean) {
    const clock = fakeClock();
    const pause = new PauseController(clock as never, fakeAudio());
    const sessions = [{} as Record<string, unknown>];
    const tickEnds = new Set<() => void>();
    const afterTick = (fn: () => void) => (tickEnds.add(fn), () => void tickEnds.delete(fn));
    const off = bindHostPaused(() => sessions, pause, linger ? { linger: { afterTick } } : {});
    const tick = (): boolean => {
      const seen = sessions[0]!['hostPaused'] === true; // what a hook of this tick reads
      for (const f of [...tickEnds]) f();
      return seen;
    };
    return { pause, sessions, tick, off, pending: () => tickEnds.size };
  }

  it('the first tick after the release still reads true, then it clears', () => {
    const { pause, sessions, tick, pending } = rig(true);
    pause.add('platform');
    expect(sessions[0]!['hostPaused']).toBe(true);
    pause.remove('platform');
    expect(sessions[0]!['hostPaused']).toBe(true);
    expect(tick()).toBe(true);
    expect(sessions[0]!['hostPaused']).toBe(false);
    expect(tick()).toBe(false);
    expect(pending()).toBe(0);
  });
  it('a new hold before that tick cancels the wait; unbinding clears at once', () => {
    const { pause, sessions, off, pending } = rig(true);
    pause.add('hidden');
    pause.remove('hidden');
    expect(pending()).toBe(1);
    pause.add('hidden');
    expect(pending()).toBe(0);
    pause.remove('hidden');
    off();
    expect(sessions[0]!['hostPaused']).toBe(false);
    expect(pending()).toBe(0);
  });
  it('negative: without the option the release clears at once (PP)', () => {
    const { pause, sessions, tick } = rig(false);
    pause.add('platform');
    pause.remove('platform');
    expect(sessions[0]!['hostPaused']).toBe(false);
    expect(tick()).toBe(false);
  });
});

describe('ext.hostPausedLinger', () => {
  it('is off unless asked', async () => {
    const { resolveExtensions } = await import('../../src/compat/core/ext.ts');
    expect(resolveExtensions().hostPausedLinger).toBe(false);
    expect(resolveExtensions({ hostPausedLinger: true }).hostPausedLinger).toBe(true);
  });
});
