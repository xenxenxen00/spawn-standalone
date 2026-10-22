// The ad-break race (Crown Riot e2e, "showing" with a running clock): the channel publishes `session.adBreak = showing` at the
// request, but the clock was only held when the platform opened the ad (two paints + delayMs + showAd later). In that gap the
// kernel kept ticking: the game advanced a whole phase during its own "ad break". The real pieces are used here (SimClockImpl,
// PauseController, the web platform with the dev fake ads); only the paints and timers are driven by hand.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SimClockImpl } from '../../src/compat/core/sched/clock.ts';
import { createEmitter } from '../../src/platform/emitter.ts';
import { PauseController } from '../../src/platform/pause-controller.ts';
import type { AdKind, AdResult, PlatformEvents } from '../../src/platform/platform.ts';
import { AdBreaks, type AdBreakHost } from '../../src/shell/ad-break.ts';
import { createFakeAds } from '../../src/shell/fake-ads.ts';
import { createWebPlatform } from '../../src/shell/web-platform.ts';

const audio = { setPaused() {}, setPlatformAudio() {} };

function rig(platform: AdBreakHost['platform']) {
  const clock = new SimClockImpl();
  const pause = new PauseController(clock, audio);
  const sessions = [{} as Record<string, unknown>, {} as Record<string, unknown>];
  const paints: Array<() => void> = [];
  const breaks = new AdBreaks(
    { platform, sessions: () => sessions, hold: (on) => (on ? clock.pause('ad') : clock.resume('ad')) },
    { afterPaint: (cb) => (paints.push(cb), () => void paints.splice(paints.indexOf(cb), 1)), log: () => {} },
  );
  /** what a probe or a game hook can read at any macrotask boundary */
  const look = () => ({ state: (sessions[0]!['adBreak'] as { state?: string } | undefined)?.state ?? null, running: clock.running, reasons: [...clock.reasons].sort() });
  /** the invariant: a session that says `showing` never sees a running clock */
  const held = () => {
    const l = look();
    return l.state !== 'showing' || l.running === false;
  };
  return { clock, pause, sessions, breaks, look, held, paint: () => paints.splice(0).forEach((f) => f()) };
}

describe('ad break: the clock is held whenever the session says showing', () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  it('web platform + fake ads: held from the request to the answer, released after done', async () => {
    const platform = createWebPlatform({ window: null, storage: null, hostEvents: false, ads: (host) => createFakeAds(host, { mode: 'show', durationMs: 3000 }) });
    const r = rig(platform);
    r.pause.bindPlatform(platform);
    const done = r.breaks.request({ placement: 'round_break', id: 2 });
    // the request is answered `showing` at once; before the fix the clock was still running here (reasons [])
    expect(r.look()).toMatchObject({ state: 'showing' });
    expect(r.held()).toBe(true);
    // a tick source that runs while the clock runs (the frame driver, the probe's runTicks) does not advance the game
    expect(r.clock.running).toBe(false);
    r.paint();
    expect(r.held()).toBe(true);
    await vi.advanceTimersByTimeAsync(0); // delayMs 0 → showAd → host hold + adPause
    expect(r.look()).toEqual({ state: 'showing', running: false, reasons: ['ad', 'platform'] });
    await vi.advanceTimersByTimeAsync(2999);
    expect(r.held()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(await done).toMatchObject({ state: 'done', shown: true });
    expect(r.look()).toEqual({ state: 'done', running: true, reasons: [] });
  });

  it('a no-fill and a timeout release the hold with the answer', async () => {
    const fail = createWebPlatform({ window: null, storage: null, hostEvents: false, ads: (host) => createFakeAds(host, { mode: 'fail', failAfterMs: 300 }) });
    const a = rig(fail);
    a.pause.bindPlatform(fail);
    const p = a.breaks.request({ placement: 'x' });
    expect(a.held()).toBe(true);
    a.paint();
    await vi.advanceTimersByTimeAsync(300);
    expect(await p).toMatchObject({ state: 'skipped', reason: 'other' });
    expect(a.look()).toEqual({ state: 'skipped', running: true, reasons: [] });

    const never = rig({ on: createEmitter<PlatformEvents>('t').on, showAd: () => new Promise<AdResult>(() => {}) });
    const q = never.breaks.request({ placement: 'y' });
    never.paint();
    await vi.advanceTimersByTimeAsync(5999);
    expect(never.held()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(await q).toMatchObject({ state: 'skipped', reason: 'timeout' });
    expect(never.clock.running).toBe(true);
  });

  it('only the break releases its hold: a foreign adResume (a host ad closing) does not let the clock run under showing', async () => {
    const events = createEmitter<PlatformEvents>('t');
    const asks: Array<(r: AdResult) => void> = [];
    const r = rig({ on: events.on, showAd: (_k: AdKind) => new Promise<AdResult>((res) => asks.push(res)) });
    r.pause.bindPlatform({ on: events.on, platformPaused: false, platformMuted: false } as never);
    const done = r.breaks.request({ placement: 'z' });
    events.emit('adResume'); // not ours: the break has not asked its ad yet
    await vi.advanceTimersByTimeAsync(0);
    expect(r.held()).toBe(true);
    r.paint();
    await vi.advanceTimersByTimeAsync(0);
    events.emit('adPause');
    events.emit('adResume');
    asks[0]!({ shown: true, rewarded: false });
    expect(await done).toMatchObject({ state: 'done' });
    expect(r.look()).toEqual({ state: 'done', running: true, reasons: [] });
  });

  it('cancel and dispose release the hold; a refused request never takes one', async () => {
    const events = createEmitter<PlatformEvents>('t');
    const r = rig({ on: events.on, showAd: () => new Promise<AdResult>(() => {}) });
    const a = r.breaks.request({ placement: 'a', id: 1 });
    expect(await r.breaks.request({ placement: 'b' })).toMatchObject({ state: 'skipped', reason: 'busy' });
    expect(r.held()).toBe(true);
    expect(r.breaks.cancel()).toBe(true);
    expect(await a).toMatchObject({ reason: 'cancelled' });
    expect(r.clock.running).toBe(true);
    expect(await r.breaks.request({ placement: 'a', id: 1 })).toMatchObject({ reason: 'duplicate' });
    expect(r.clock.running).toBe(true);
    void r.breaks.request({ placement: 'c' });
    expect(r.clock.running).toBe(false);
    r.breaks.dispose();
    expect(r.look()).toMatchObject({ state: 'skipped', running: true });
  });
});
