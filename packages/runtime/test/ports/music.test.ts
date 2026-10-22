import { afterEach, describe, expect, it, vi } from 'vitest';
import * as ports from '../../src/ports/index.ts';
import type { EntityAudioHandle, EntityAudioSpec } from '../../src/runtime/audio/types.ts';
import { makeEngine } from '../../tests/unit/audio/helpers.ts';
import { FakeGain, FakeNode, settle } from '../../tests/unit/audio/fake-context.ts';

class FakeMedia extends EventTarget {
  src = '';
  preload = '';
  crossOrigin: string | null = null;
  loop = false;
  currentTime = 0;
  duration = 20;
  readyState = 1;
  paused = true;
  play(): Promise<void> { this.paused = false; return Promise.resolve(); }
  pause(): void { this.paused = true; }
  load(): void {}
  removeAttribute(name: string): void { if (name === 'src') this.src = ''; }
}

function fakeAudio() {
  const voices: Array<EntityAudioHandle & { spec: EntityAudioSpec; ended: boolean; stopped: boolean }> = [];
  return {
    voices,
    createEntityAudio(_id: string, spec: EntityAudioSpec) {
      const voice = {
        spec, ended: false, stopped: false,
        update(next: EntityAudioSpec) { this.spec = next; },
        stop() { this.stopped = true; },
      };
      voices.push(voice);
      return voice;
    },
  };
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('audio-backed MusicPort', () => {
  it('crossfades base tracks on the music bus without restarting repeated clips', () => {
    const audio = fakeAudio();
    const music = ports.createAudioMusicPort(audio);
    music.play('cdn/calm.mp3', { volume: 0.8 });
    expect(audio.voices[0]!.spec).toEqual({ clip: 'calm.mp3', bus: 'music', spatial: false, loop: true, gain: 0.8 });
    music.play('/cdn/calm.mp3', { volume: 0.8 });
    expect(audio.voices).toHaveLength(1);
    music.play('battle.mp3', { fade: 2, volume: 0.6 });
    expect(audio.voices[1]!.spec.gain).toBe(0);
    music.frame(1000);
    expect(audio.voices[0]!.spec.gain).toBeCloseTo(0.4);
    expect(audio.voices[1]!.spec.gain).toBeCloseTo(0.3);
    music.play('battle.mp3', { fade: 2, volume: 0.6 });
    music.frame(2000);
    expect(audio.voices).toHaveLength(2);
    expect(audio.voices[0]!.stopped).toBe(true);
    expect(audio.voices[1]!.spec.gain).toBe(0.6);
  });

  it('cleans finished overlays and can replay them while keeping base music', () => {
    const audio = fakeAudio();
    const music = ports.createAudioMusicPort(audio);
    music.play('calm');
    music.play('entrance', { layer: 'stinger' });
    expect(audio.voices[1]!.spec.loop).toBe(false);
    audio.voices[1]!.ended = true;
    music.frame(10);
    expect(audio.voices[1]!.stopped).toBe(true);
    expect(audio.voices[0]!.stopped).toBe(false);
    music.play('entrance', { layer: 'stinger' });
    expect(audio.voices).toHaveLength(3);
    music.play('atmosphere', { layer: 'ambience', loop: true });
    expect(audio.voices[3]!.spec.loop).toBe(true);
    music.stop({ layer: 'stinger', fade: 1 });
    music.frame(510);
    expect(audio.voices[2]!.spec.gain).toBeCloseTo(0.5);
    music.frame(1010);
    expect(audio.voices[2]!.stopped).toBe(true);
    expect(audio.voices[3]!.stopped).toBe(false);
  });

  it('ducks only the base layer and excludes frozen frame time from its duration', () => {
    const audio = fakeAudio();
    const music = ports.createAudioMusicPort(audio);
    music.play('calm', { volume: 0.8 });
    music.play('stinger', { layer: 'overlay' });
    music.duck(0.25, { duration: 2 });
    expect(audio.voices[0]!.spec.gain).toBeCloseTo(0.2);
    expect(audio.voices[1]!.spec.gain).toBe(1);
    music.frame(1000);
    music.frame(1000);
    music.frame(Number.NaN);
    music.frame(500);
    expect(audio.voices[0]!.spec.gain).toBeCloseTo(0.2);
    music.play('battle', { volume: 0.4 });
    expect(audio.voices[2]!.spec.gain).toBeCloseTo(0.1);
    music.frame(2000);
    expect(audio.voices[2]!.spec.gain).toBe(0.4);
    music.duck(0);
    music.frame(2999);
    expect(audio.voices[2]!.spec.gain).toBe(0);
    music.frame(3000);
    expect(audio.voices[2]!.spec.gain).toBe(0.4);
  });

  it('bounds replaced voices and releases every layer on disposal', () => {
    const audio = fakeAudio();
    const music = ports.createAudioMusicPort(audio);
    for (let i = 0; i < 20; i++) music.play(`track-${i}`, { fade: 100 });
    expect(audio.voices.filter(voice => !voice.stopped)).toHaveLength(2);
    music.play('overlay', { layer: 'overlay' });
    music.dispose();
    music.dispose();
    music.play('later');
    music.duck(0);
    music.stop();
    music.frame(1000000);
    expect(audio.voices).toHaveLength(21);
    expect(audio.voices.every(voice => voice.stopped)).toBe(true);
  });

  it('clamps invalid values and keeps its fire-and-forget methods nonthrowing', () => {
    const audio = fakeAudio();
    const music = ports.createAudioMusicPort(audio);
    expect(() => music.play(null as unknown as string)).not.toThrow();
    music.play('calm', { volume: 2, fade: Number.NaN });
    expect(audio.voices[0]!.spec.gain).toBe(1);
    music.duck(-5, { duration: Number.NaN });
    expect(audio.voices[0]!.spec.gain).toBe(0);
    music.frame(1000);
    expect(audio.voices[0]!.spec.gain).toBe(1);
    music.play('battle', { volume: -1, fade: -5 });
    expect(audio.voices[1]!.spec.gain).toBe(0);
    music.stop({ fade: Infinity });
    expect(audio.voices[1]!.stopped).toBe(true);
    const broken = ports.createAudioMusicPort({ createEntityAudio() { throw new Error('unavailable'); } });
    expect(() => { broken.play('missing'); broken.duck(1); broken.stop(); broken.frame(1); broken.dispose(); }).not.toThrow();
  });

  it('isolates a broken voice while still updating the other layers', () => {
    const audio = fakeAudio();
    const music = ports.createAudioMusicPort(audio);
    music.play('calm', { fade: 1 });
    music.play('overlay', { layer: 'overlay', fade: 1 });
    audio.voices[0]!.update = () => { throw new Error('closed context'); };
    audio.voices[0]!.stop = () => { throw new Error('closed context'); };
    expect(() => music.frame(500)).not.toThrow();
    expect(audio.voices[1]!.spec.gain).toBe(0.5);
    music.play('replacement');
    expect(audio.voices[2]!.spec.gain).toBe(1);
    music.dispose();
    expect(audio.voices[1]!.stopped).toBe(true);
  });

  it('uses engine unlock, missing-clip handling, and buffer completion without owning another audio engine', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const rig = makeEngine({ unlock: false });
    const music = ports.createAudioMusicPort(rig.engine);
    music.play('sfx-a.mp3', { layer: 'stinger' });
    expect(rig.contexts()).toBe(0);
    expect(rig.urls).toHaveLength(0);
    rig.engine.unlock();
    await settle();
    expect(rig.ctx.voiceSources()).toHaveLength(1);
    const source = rig.ctx.voiceSources()[0]!;
    expect(source.path()[2]).toBe(rig.engine.bus('music'));
    source.end();
    music.frame(1);
    music.play('sfx-a.mp3', { layer: 'stinger' });
    await settle();
    expect(rig.ctx.voiceSources()).toHaveLength(2);
    expect(() => music.play('missing.mp3')).not.toThrow();
    expect(rig.logs.some(log => log.includes('missing.mp3'))).toBe(true);
    music.dispose();
    rig.engine.dispose();
  });

  it('streams lazily and releases completed overlays without changing the existing stream pause or mute path', () => {
    vi.useFakeTimers();
    const rig = makeEngine({ unlock: false, manifest: {
      'stream.mp3': { url: 'https://audio.test/stream.mp3', bytes: 500, dur: 20, ch: 2, mode: 'stream' },
    } });
    const media: FakeMedia[] = [];
    const nodes: FakeNode[] = [];
    (rig.ctx as typeof rig.ctx & { createMediaElementSource: () => FakeNode }).createMediaElementSource = () => {
      const node = new FakeNode('source');
      nodes.push(node);
      return node;
    };
    vi.stubGlobal('document', { createElement: () => { const element = new FakeMedia(); media.push(element); return element; } });
    const music = ports.createAudioMusicPort(rig.engine);
    music.play('stream.mp3', { layer: 'overlay' });
    expect(media).toHaveLength(0);
    rig.engine.unlock();
    expect(media).toHaveLength(1);
    expect(media[0]!.loop).toBe(false);
    expect(media[0]!.paused).toBe(false);
    expect(rig.engine.stats().decodedBytes).toBe(0);
    expect(rig.urls).toHaveLength(0);
    const master = nodes[0]!.path()[4] as FakeGain;
    rig.engine.setUserMuted(true);
    expect(master.gain.value).toBe(0);
    rig.engine.setUserMuted(false);
    expect(master.gain.value).toBeGreaterThan(0);
    rig.engine.setPaused(true);
    expect(media[0]!.paused).toBe(true);
    music.frame(0);
    rig.engine.setPaused(false);
    expect(media[0]!.paused).toBe(false);
    media[0]!.dispatchEvent(new Event('ended'));
    music.frame(1);
    vi.advanceTimersByTime(6);
    expect(media[0]!.src).toBe('');
    expect(nodes[0]!.disconnected).toBe(true);
    rig.engine.frame();
    music.play('stream.mp3', { layer: 'overlay' });
    expect(media).toHaveLength(2);
    music.dispose();
    rig.engine.dispose();
    expect(media.every(element => element.src === '')).toBe(true);
  });
});
