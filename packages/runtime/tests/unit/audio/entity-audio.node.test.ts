// WP AU2 (docs/architecture.md §9.3; docs/design/audio-ui-input.md §2.9): entity audio rows play, follow their entity,
// react to gain writes and stop when destroyed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FakeGain, FakeNode, FakeSource, settle, type ParamEvent } from './fake-context.ts';
import { makeEngine, readyEngine } from './helpers.ts';

class FakeMediaElement extends EventTarget {
  src = '';
  preload = '';
  crossOrigin: string | null = null;
  loop = false;
  currentTime = 0;
  duration = 20;
  readyState = 1;
  paused = true;
  plays = 0;
  pauses = 0;

  play(): Promise<void> {
    this.paused = false;
    this.plays++;
    return Promise.resolve();
  }

  pause(): void {
    this.paused = true;
    this.pauses++;
  }

  load(): void {}

  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('entity audio', () => {
  it.each([undefined, false, true])('defers zero-gain streams only with lazyZeroStreams=%s and starts each stream once', (lazyZeroStreams) => {
    vi.useFakeTimers();
    const media: FakeMediaElement[] = [];
    const rig = makeEngine({ ...(lazyZeroStreams === undefined ? {} : { lazyZeroStreams }), manifest: {
      'music-layer.mp3': { url: 'https://audio.test/music-layer.mp3', bytes: 100, dur: 0, ch: 2, mode: 'stream' },
    } });
    (rig.ctx as typeof rig.ctx & { createMediaElementSource: () => FakeNode }).createMediaElementSource = () => new FakeNode('source');
    vi.stubGlobal('document', { createElement: () => { const element = new FakeMediaElement(); media.push(element); return element; } });
    const spec = { clip: 'music-layer.mp3', loop: true, gain: 0, bus: 'music' };
    const handle = rig.engine.createEntityAudio('music:layer', spec);
    rig.engine.frame();
    expect(media).toHaveLength(lazyZeroStreams ? 0 : 1);
    handle.update({ ...spec, gain: 0.05 }, null);
    expect(media).toHaveLength(1);
    expect(media[0]!.src).toBe('https://audio.test/music-layer.mp3');
    expect(media[0]!.plays).toBe(1);
    handle.update(spec, null);
    rig.engine.frame();
    handle.update({ ...spec, gain: 0.2 }, null);
    expect(media).toHaveLength(1);
    expect(media[0]!.plays).toBe(1);
    expect(rig.urls).toHaveLength(0);
    expect(rig.engine.stats().decodedBytes).toBe(0);
    rig.engine.setPaused(true);
    expect(media[0]!.paused).toBe(true);
    rig.engine.setPaused(false);
    expect(media[0]!.paused).toBe(false);
    rig.engine.dispose();
    expect(media[0]!.src).toBe('');
    expect(media[0]!.paused).toBe(true);
  });

  it('waits for the gesture-created context, then starts the manifest loop at its measured points', async () => {
    const rig = makeEngine({ unlock: false });
    const handle = rig.engine.createEntityAudio('scene:wind', {
      clip: 'cdn/loop.mp3',
      loop: true,
      spatial: true,
      maxDistance: 18,
      bus: 'Ambience',
      gain: 0.4,
    });

    expect(rig.engine.context()).toBeNull();
    expect(rig.ctx.voiceSources()).toHaveLength(0);
    rig.engine.unlock();
    await settle();

    const source = rig.ctx.voiceSources()[0]!;
    expect(source.started).toEqual({ when: 0, offset: 0 });
    expect([source.loop, source.loopStart, source.loopEnd]).toEqual([true, 0.01, 0.49]);
    expect(rig.ctx.panners()).toHaveLength(1);
    expect(rig.engine.stats().decodedBytes).toBeGreaterThan(0);
    handle.stop();
    rig.engine.dispose();
  });

  it('updates a spatial row in place and applies its gain ramp without restarting the clip', async () => {
    const rig = await readyEngine();
    const handle = rig.engine.createEntityAudio('enemy:1', {
      clip: 'cdn/loop.mp3',
      loop: true,
      spatial: true,
      maxDistance: 9,
      bus: 'Ambience',
      gain: 0.25,
    });
    handle.update(
      { clip: 'cdn/loop.mp3', loop: true, spatial: true, maxDistance: 9, bus: 'Ambience', gain: 0.7 },
      { x: 4, y: 5, z: 6 },
    );
    await settle();

    const source = rig.ctx.voiceSources()[0]!;
    const panner = rig.ctx.panners()[0]!;
    const entityGain = source.outputs[0] as FakeGain;
    expect(rig.ctx.voiceSources()).toHaveLength(1);
    expect([panner.refDistance, panner.maxDistance]).toEqual([1, 9]);
    expect([panner.positionX.value, panner.positionY.value, panner.positionZ.value]).toEqual([4, 5, 6]);
    expect(entityGain.gain.last()).toEqual({ type: 'target', value: 0.7, time: 0, tc: 0.03 });
    expect(source.path().map((node) => node.kind)).toEqual(['source', 'gain', 'panner', 'gain', 'gain', 'compressor', 'destination']);
    expect(source.path()[3]).toBe(rig.engine.bus('ambience'));
    handle.stop();
    expect(entityGain.gain.last()).toEqual({ type: 'ramp', value: 0, time: 0.005 });
    expect(source.stopped).toBe(0.005);
    rig.engine.dispose();
  });

  it('streams music through two media sources and crossfades at the manifest loop end', () => {
    vi.useFakeTimers();
    const media: FakeMediaElement[] = [];
    const rig = makeEngine({
      manifest: {
        'music-bed.mp3': { url: 'https://ss.test/assets/a/music.mp3', bytes: 50, dur: 20, ch: 2, mode: 'stream', loopStart: 2, loopEnd: 18 },
      },
    });
    (rig.ctx as typeof rig.ctx & { createMediaElementSource: (element: FakeMediaElement) => FakeNode }).createMediaElementSource = () => new FakeNode('source');
    vi.stubGlobal('document', {
      createElement: (tag: string) => {
        expect(tag).toBe('audio');
        const element = new FakeMediaElement();
        media.push(element);
        return element;
      },
    });

    const handle = rig.engine.createEntityAudio('music:menu', { clip: 'cdn/music-bed.mp3', loop: true, spatial: false, gain: 0.5, bus: 'Music' });
    expect(media).toHaveLength(2);
    expect(media[0]!.src).toBe('https://ss.test/assets/a/music.mp3');
    expect([media[0]!.preload, media[0]!.crossOrigin, media[0]!.loop]).toEqual(['auto', 'anonymous', false]);
    expect(media[0]!.currentTime).toBe(2);
    expect(media[0]!.plays).toBe(1);
    expect(media[1]!.plays).toBe(0);

    media[0]!.currentTime = 16.6;
    vi.advanceTimersByTime(50);
    expect(media[1]!.currentTime).toBe(2);
    expect(media[1]!.plays).toBe(1);
    const fadeGains = rig.ctx.nodes.filter((node): node is FakeGain => node instanceof FakeGain).slice(-2);
    const isMidRamp = (event: ParamEvent): event is Extract<ParamEvent, { type: 'ramp' }> => event.type === 'ramp' && Math.abs(event.time - 0.75) < 0.001;
    const leftMid = fadeGains[0]!.gain.events.find(isMidRamp);
    const rightMid = fadeGains[1]!.gain.events.find(isMidRamp);
    expect(leftMid?.value).toBeCloseTo(Math.SQRT1_2, 2);
    expect(rightMid?.value).toBeCloseTo(Math.SQRT1_2, 2);

    vi.advanceTimersByTime(1500);
    expect(media[0]!.paused).toBe(true);
    rig.engine.setPaused(true);
    expect(media[1]!.paused).toBe(true);
    rig.engine.setPaused(false);
    expect(media[1]!.paused).toBe(false);
    handle.stop();
    rig.engine.dispose();
    expect(media.every((element) => element.paused)).toBe(true);
  });
});
