// Shared set-up for the audio engine tests: a manifest, a fake fetch over it and an unlocked engine on a FakeAudioContext.
import { createAudioEngine, type AudioEngineCore } from '../../../src/runtime/audio/audio-engine.ts';
import type { AudioManifest, AudioEngineOptions, ClipInfo } from '../../../src/runtime/audio/types.ts';
import { FakeAudioContext, fakeClipBytes, fakeFetch, settle, type FakeContextOptions } from './fake-context.ts';

const clip = (url: string | null, ch: 1 | 2, extra: Partial<ClipInfo> = {}): ClipInfo => ({
  url,
  bytes: 2,
  dur: 0.5,
  ch,
  mode: 'buffer',
  ...extra,
});

export const MANIFEST: AudioManifest = {
  'sfx-a.mp3': clip('https://ss.test/assets/a/a.mp3', 2),
  'sfx-b.mp3': clip('https://ss.test/assets/a/b.mp3', 2),
  'value.feed.mp3': clip('https://ss.test/assets/a/feed.mp3', 2, { positionalOnly: true }),
  'mono-pos.mp3': clip('https://ss.test/assets/a/mono.mp3', 1, { positionalOnly: true }),
  'loop.mp3': clip('https://ss.test/assets/a/loop.mp3', 2, { loopStart: 0.01, loopEnd: 0.49 }),
  'boss-401.mp3': clip(null, 2),
};

export const FILES: Record<string, ArrayBuffer> = {
  'https://ss.test/assets/a/a.mp3': fakeClipBytes(2),
  'https://ss.test/assets/a/b.mp3': fakeClipBytes(2),
  'https://ss.test/assets/a/feed.mp3': fakeClipBytes(2),
  'https://ss.test/assets/a/mono.mp3': fakeClipBytes(1),
  'https://ss.test/assets/a/loop.mp3': fakeClipBytes(2),
};

export interface Rig {
  engine: AudioEngineCore;
  ctx: FakeAudioContext;
  logs: string[];
  urls: string[];
  contexts: () => number;
}

export function makeEngine(
  opts: Partial<AudioEngineOptions> & { unlock?: boolean; ctx?: FakeContextOptions; lazyZeroStreams?: boolean } = {},
): Rig {
  const ctx = new FakeAudioContext(opts.ctx);
  let made = 0;
  const logs: string[] = [];
  const { fetch, urls } = fakeFetch(FILES);
  const engine = createAudioEngine({
    ...(opts.lazyZeroStreams === undefined ? {} : { lazyZeroStreams: opts.lazyZeroStreams }),
    createContext: () => {
      made++;
      return ctx;
    },
    fetch,
  });
  const { unlock: _unlock, ctx: _ctxOptions, ...audioOptions } = opts;
  engine.init({
    ...audioOptions,
    manifest: opts.manifest ?? MANIFEST,
    tier: opts.tier ?? 'high',
    ...(opts.monoPositional === undefined ? {} : { monoPositional: opts.monoPositional }),
    log: (m) => logs.push(m),
  });
  if (opts.unlock !== false) engine.unlock();
  return { engine, ctx, logs, urls, contexts: () => made };
}

/** an engine with every manifest clip decoded */
export async function readyEngine(opts: Parameters<typeof makeEngine>[0] = {}): Promise<Rig> {
  const rig = makeEngine(opts);
  await rig.engine.prefetch(Object.keys(opts.manifest ?? MANIFEST), 'now');
  await settle();
  return rig;
}

export const META = { sourceId: 'player/local', sourcePlace: 'cradle' } as const;
