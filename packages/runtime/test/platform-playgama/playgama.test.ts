// The Playgama adapter against a scripted Bridge: init, host pause and mute, save through Bridge storage, ads and fallback.
import { PLATFORM_MESSAGE } from '@playgama/bridge/constants';
import { describe, expect, it, vi } from 'vitest';
import { createPlaygamaPlatform, type PlaygamaPlatformOptions } from '../../src/platform-playgama/index.ts';
import { createFakeBridge, type FakeBridgeOptions } from './fake-bridge.ts';

const quiet = () => vi.spyOn(console, 'warn').mockImplementation(() => {});

function make(bo: FakeBridgeOptions = {}, po: PlaygamaPlatformOptions = {}) {
  const fake = createFakeBridge(bo);
  const platform = createPlaygamaPlatform({ bridge: () => fake.bridge as never, document: null, initialInterstitialDelayS: 0, ...po });
  return { fake, platform };
}

describe('init', () => {
  it('reads host state, device and the save keys in one request', async () => {
    const { fake, platform } = make({ platformId: 'playgama', paused: true, audioEnabled: false, deviceType: 'tv', storage: { ss_save_v1: '{"v":1}' } }, { gameVersion: '1.2.3' });
    const paused: boolean[] = [];
    const muted: boolean[] = [];
    platform.on('platformPause', (p) => paused.push(p));
    platform.on('platformMute', (m) => muted.push(m));
    await platform.init();
    expect(platform.hostId).toBe('playgama');
    expect(platform.platformPaused).toBe(true);
    expect(platform.platformMuted).toBe(true);
    expect(paused).toEqual([true]);
    expect(muted).toEqual([true]);
    expect(platform.device.type).toBe('desktop');
    expect(fake.bridge.gameVersion).toBe('1.2.3');
    await platform.save.ready;
    expect(platform.save.get('ss_save_v1')).toBe('{"v":1}');
    expect(platform.save.get('ss_save_v1_bad')).toBeNull();
  });

  it('host pause and audio events reach the platform events', async () => {
    const { fake, platform } = make();
    await platform.init();
    const seen: string[] = [];
    platform.on('platformPause', (p) => seen.push(`pause ${p}`));
    platform.on('platformMute', (m) => seen.push(`mute ${m}`));
    fake.hostPause(true);
    fake.hostAudio(false);
    fake.hostPause(true);
    fake.hostPause(false);
    fake.hostAudio(true);
    expect(seen).toEqual(['pause true', 'mute true', 'pause false', 'mute false']);
    expect(platform.platformPaused).toBe(false);
    platform.dispose();
    expect(fake.listeners()).toBe(0);
  });

  it('a missing script, a hung or failing initialize: a web-like fallback with an in-memory save, nothing thrown', async () => {
    const warn = quiet();
    const missing = createPlaygamaPlatform({ bridge: () => undefined });
    await missing.init();
    expect(missing.hostId).toBe('none');
    await missing.save.ready;
    missing.save.set('k', 'v');
    expect(missing.save.get('k')).toBe('v');
    expect(await missing.showAd('interstitial', 'x' as never)).toEqual({ shown: false, reason: 'disabled' });

    const hang = make({ hang: true }, { initTimeoutMs: 5 });
    await hang.platform.init();
    expect(hang.platform.hostId).toBe('none');
    warn.mockRestore();
  });

  it('a storage.get that never answers detaches the store to memory', async () => {
    const warn = quiet();
    const { platform } = make({ hangStorage: true }, { storageTimeoutMs: 5 });
    await platform.init();
    await platform.save.ready;
    expect(platform.save.get('ss_save_v1')).toBeNull();
    warn.mockRestore();
  });
});

describe('save through platform storage', () => {
  it('the game\'s own keys: loaded at init, written in batches, deleted, flushed', async () => {
    const { fake, platform } = make({ storage: { g_save: 'old' } }, { saveKeys: ['g_save', 'g_save_bad'] });
    await platform.init();
    expect(platform.save.get('g_save')).toBe('old');
    platform.save.set('g_save', 'new');
    platform.save.set('other', 'x');
    await platform.save.flush();
    expect(fake.store.get('g_save')).toBe('new');
    expect(fake.store.get('other')).toBe('x');
    platform.save.remove('other');
    await platform.save.flush();
    expect(fake.store.has('other')).toBe(false);
    expect(() => platform.save.set('g_save', '')).toThrow(TypeError);
  });

  it('a failing write keeps the value for the next flush', async () => {
    const warn = quiet();
    const { fake, platform } = make();
    await platform.init();
    const set = fake.bridge.storage.set;
    fake.bridge.storage.set = () => Promise.reject(new Error('offline'));
    platform.save.set('ss_save_v1', 'a');
    await platform.save.flush();
    expect(fake.store.has('ss_save_v1')).toBe(false);
    fake.bridge.storage.set = set;
    await platform.save.flush();
    expect(fake.store.get('ss_save_v1')).toBe('a');
    warn.mockRestore();
  });
});

describe('ads', () => {
  it('an interstitial: busy, pause on open, resume on close, shown', async () => {
    const { fake, platform } = make();
    await platform.init();
    platform.gameReady();
    const events: string[] = [];
    platform.on('adBusy', (b) => events.push(`busy ${b}`));
    platform.on('adPause', () => events.push('pause'));
    platform.on('adResume', () => events.push('resume'));
    const result = platform.showAd('interstitial', 'level_end' as never);
    expect(fake.shown).toEqual([{ kind: 'interstitial', placement: 'level_end' }]);
    expect(await Promise.race([platform.showAd('interstitial', 'x' as never), Promise.resolve('pending')])).toEqual({ shown: false, reason: 'busy' });
    fake.interstitial('opened');
    fake.interstitial('closed');
    expect(await result).toEqual({ shown: true, rewarded: false });
    expect(events).toEqual(['busy true', 'pause', 'resume', 'busy false']);
  });

  it('a failed interstitial resolves not shown; the pre-start watchdog resolves timeout', async () => {
    const { fake, platform } = make({}, { watchdogMs: 5 });
    await platform.init();
    platform.gameReady();
    const failed = platform.showAd('interstitial', 'a' as never);
    fake.interstitial('failed');
    expect(await failed).toEqual({ shown: false, reason: 'other' });
    fake.bridge.advertisement.interstitialState = 'closed';
    expect(await platform.showAd('interstitial', 'b' as never)).toEqual({ shown: false, reason: 'timeout' });
  });

  it('cooldown: not before game_ready, not before the initial delay, not within the minimum gap', async () => {
    let now = 1000;
    const { fake, platform } = make({ minimumDelayBetweenInterstitial: 60 }, { now: () => now, initialInterstitialDelayS: 10 });
    await platform.init();
    expect(await platform.showAd('interstitial', 'a' as never)).toEqual({ shown: false, reason: 'cooldown' });
    platform.gameReady();
    now += 5000;
    expect(await platform.showAd('interstitial', 'a' as never)).toEqual({ shown: false, reason: 'cooldown' });
    now += 6000;
    const first = platform.showAd('interstitial', 'a' as never);
    fake.interstitial('opened');
    fake.interstitial('closed');
    expect((await first).shown).toBe(true);
    now += 30_000;
    expect(await platform.showAd('interstitial', 'a' as never)).toEqual({ shown: false, reason: 'cooldown' });
    now += 31_000;
    const again = platform.showAd('interstitial', 'a' as never);
    fake.interstitial('failed');
    await again;
  });

  it('rewarded ads are off unless the game allows them; a host ad the adapter did not ask for still pauses', async () => {
    const off = make();
    await off.platform.init();
    expect(off.platform.policy.rewardedEnabled).toBe(false);
    const on = make({}, { rewarded: true });
    await on.platform.init();
    expect(on.platform.policy.rewardedEnabled).toBe(true);
    const seen: string[] = [];
    on.platform.on('adPause', () => seen.push('pause'));
    on.platform.on('adResume', () => seen.push('resume'));
    on.fake.interstitial('opened');
    on.fake.interstitial('closed');
    expect(seen).toEqual(['pause', 'resume']);
  });
});

describe('lifecycle, user, analytics', () => {
  it('game_ready once, gameplay edges, level events and analytics go to the Bridge', async () => {
    const { fake, platform } = make();
    await platform.init();
    platform.gameReady();
    platform.gameReady();
    platform.setGameplay(true);
    platform.setGameplay(true);
    platform.setGameplay(false);
    platform.matchEvent({ type: 'start', map: 'm', difficulty: 'd', waves: 3 });
    platform.track('thing', { n: 1 });
    expect(fake.messages.map((m) => m.message)).toEqual([PLATFORM_MESSAGE.GAME_READY, PLATFORM_MESSAGE.GAMEPLAY_STARTED, PLATFORM_MESSAGE.GAMEPLAY_STOPPED, PLATFORM_MESSAGE.LEVEL_STARTED]);
    expect(fake.analytics).toEqual([{ name: 'thing', data: { n: 1 } }]);
  });

  it('getUser: null for a guest, the account for an authorised player; the guest name option', async () => {
    const guest = make();
    await guest.platform.init();
    expect(await guest.platform.getUser()).toBeNull();
    const user = make({ authorized: true, playerName: '' }, { defaultName: 'Pilot' });
    await user.platform.init();
    expect(await user.platform.getUser()).toEqual({ id: 'p42', name: 'Pilot', loggedIn: true });
  });

  it('loading progress is clamped and sent', async () => {
    const { fake, platform } = make();
    await platform.init();
    platform.setLoadingProgress(250);
    platform.setLoadingProgress(Number.NaN);
    expect(fake.log).toContain('progress 100');
    expect(fake.log.filter((l) => l.startsWith('progress'))).toHaveLength(1);
  });
});

describe('gameReady before init', () => {
  it('is queued and sent once, after the Bridge is initialised', async () => {
    const { fake, platform } = make();
    const init = platform.init();
    platform.gameReady();
    platform.gameReady();
    expect(fake.messages).toEqual([]);
    await init;
    expect(fake.messages.map((m) => m.message)).toEqual([PLATFORM_MESSAGE.GAME_READY]);
    platform.gameReady();
    expect(fake.messages).toHaveLength(1);
  });

  it('is queued even before init() is called', async () => {
    const { fake, platform } = make();
    platform.gameReady();
    expect(fake.messages).toEqual([]);
    await platform.init();
    expect(fake.messages.map((m) => m.message)).toEqual([PLATFORM_MESSAGE.GAME_READY]);
  });

  it('negative: nothing is sent when the Bridge is missing (fallback)', async () => {
    const warn = quiet();
    const platform = createPlaygamaPlatform({ bridge: () => undefined, document: null });
    const init = platform.init();
    platform.gameReady();
    await init;
    platform.gameReady();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
