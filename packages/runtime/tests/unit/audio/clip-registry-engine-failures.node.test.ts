// Negative controls for the audio soak's fail-closed clip gate (r6
// tests/e2e/audio-soak.page.ts): missing and partial expected clips must fail
// through the REAL clip registry / engine path. The network is controlled (a 404
// for the missing URL; `fakeFetch` 404s any URL not in FILES) and the Web Audio
// surface is the repo's FakeAudioContext; the engine, the registry, the manifest
// handling and the validator are the real ones — nothing is replaced.
//
// Each case drives `createAudioEngine` → `init` → `unlock` (which attaches the
// context to the real ClipRegistry, the production path) → `engine.prefetch`
// and then applies the exact gate expression from the soak harness:
// every expected clip must read `registry.status(k) === 'ready'`.
import { describe, expect, it } from 'vitest';
import type { AudioManifest } from '../../../src/runtime/audio/types.ts';
import { settle } from './fake-context.ts';
import { MANIFEST, makeEngine } from './helpers.ts';

const withGone = (extra: AudioManifest = {}): AudioManifest => ({
  ...MANIFEST,
  'gone.mp3': { url: 'https://ss.test/404.mp3', bytes: 2, dur: 1, ch: 2, mode: 'buffer' },
  ...extra,
});

/** the exact fail-closed gate expression from the r6 soak harness */
function notReady(reg: { status(k: string): string }, keys: readonly string[]): string[] {
  return keys.filter((k) => reg.status(k) !== 'ready');
}

describe('missing/partial clips fail through the real engine path (soak gate negative controls)', () => {
  it('a 404 clip is failed, counted missing, and trips the all-ready gate', async () => {
    const { engine } = makeEngine({ manifest: withGone() });
    const reg = engine.registry!;
    await engine.prefetch(['sfx-a.mp3', 'gone.mp3'], 'now');
    await settle();
    expect(reg.status('sfx-a.mp3')).toBe('ready');
    expect(reg.status('gone.mp3')).toBe('failed');
    expect(reg.stats().missing).toBe(1);
    expect(reg.stats().held).toBe(1);
    expect(notReady(reg, ['sfx-a.mp3', 'gone.mp3'])).toEqual(['gone.mp3']);
    engine.dispose();
  });

  it('a null-URL (silent) clip trips the all-ready gate', async () => {
    const { engine } = makeEngine(); // MANIFEST's boss-401.mp3 has url: null
    const reg = engine.registry!;
    await engine.prefetch(['sfx-a.mp3', 'boss-401.mp3'], 'now');
    await settle();
    expect(reg.status('sfx-a.mp3')).toBe('ready');
    // prefetch skips null-URL clips (nothing to fetch), so the missing counter
    // stays 0 — but status() still reads 'silent', and the gate trips on it
    expect(reg.status('boss-401.mp3')).toBe('silent');
    expect(reg.stats().missing).toBe(0);
    expect(notReady(reg, ['sfx-a.mp3', 'boss-401.mp3'])).toEqual(['boss-401.mp3']);
    engine.dispose();
  });

  it('partial failure: one bad clip among good ones still fails the gate', async () => {
    const { engine } = makeEngine({ manifest: withGone() });
    const reg = engine.registry!;
    const keys = ['sfx-a.mp3', 'sfx-b.mp3', 'gone.mp3', 'boss-401.mp3'];
    await engine.prefetch(keys, 'now');
    await settle();
    expect(reg.status('sfx-a.mp3')).toBe('ready');
    expect(reg.status('sfx-b.mp3')).toBe('ready');
    expect(notReady(reg, keys)).toEqual(['gone.mp3', 'boss-401.mp3']);
    // only the 404 is counted: prefetch skips the null-URL clip, but the gate
    // still trips on its 'silent' status
    expect(reg.stats().missing).toBe(1);
    expect(reg.stats().held).toBe(2);
    engine.dispose();
  });

  it('all clips present: the gate passes', async () => {
    const { engine } = makeEngine();
    const reg = engine.registry!;
    const keys = ['sfx-a.mp3', 'sfx-b.mp3'];
    await engine.prefetch(keys, 'now');
    await settle();
    expect(notReady(reg, keys)).toEqual([]);
    expect(reg.stats().missing).toBe(0);
    expect(reg.stats().held).toBe(2);
    engine.dispose();
  });
});
