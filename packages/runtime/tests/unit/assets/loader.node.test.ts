// WP B8 acceptance (docs/architecture.md §9.3 B8; build §5.8, §5.9 rules): the loader fetches with `cache: 'force-cache'`,
// dedupes per URL (spellings, shared textures, concurrent calls), includes a model's dependencies, honours priorities with a
// per-priority concurrency limit, never re-requests an HTTP failure (no loop), and reports progress and stats in bytes.
import { describe, expect, it } from 'vitest';
import type { AssetEntry, AssetIndex } from '../../../src/assets/index-types.ts';
import { createAssetLoader, type FetchLike } from '../../../src/assets/loader.ts';
import { createAssetResolver } from '../../../src/assets/resolver.ts';

const BASE = 'https://game.example/';
const abs = (u: string): string => new URL(u, BASE).href;

/** A fetch whose responses the test settles by hand; records every call in order. */
function manualFetch() {
  const calls: { url: string; init: RequestInit | undefined; respond: (status?: number, bytes?: number) => void; fail: (e?: unknown) => void }[] = [];
  const fetch: FetchLike = (url, init) =>
    new Promise<Response>((resolve, reject) => {
      calls.push({
        url,
        init,
        respond: (status = 200, bytes = 4) => resolve(new Response(status === 200 ? new Uint8Array(bytes) : null, { status })),
        fail: (e = new TypeError('network')) => reject(e),
      });
    });
  return { fetch, calls };
}

/** A fetch that answers at once from a status table (default 200). */
function autoFetch(status: (url: string) => number = () => 200) {
  const urls: string[] = [];
  const fetch: FetchLike = (url) => {
    urls.push(url);
    const s = status(url);
    return Promise.resolve(new Response(s === 200 ? new Uint8Array(8) : null, { status: s }));
  };
  return { fetch, urls };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
};

// Small synthetic index for ordering tests: 7 single-file images a..g and two models sharing a texture.
const e = (u: string, g: string, b = 100, extra: Partial<AssetEntry> = {}): AssetEntry => ({ u, b, k: 'image', x: 'webp', g: [g as AssetEntry['g'][number]], ...extra });
const small: AssetIndex = {
  v: 1,
  build: 't',
  origin: 't',
  entries: {
    'a.png': e('assets/i/a.webp', 'match'),
    'b.png': e('assets/i/b.webp', 'match'),
    'c.png': e('assets/i/c.webp', 'match'),
    'd.png': e('assets/i/d.webp', 'match'),
    'e.png': e('assets/i/e.webp', 'match'),
    'f.png': e('assets/i/f.webp', 'match'),
    'g.png': e('assets/i/g.webp', 'match'),
    'standalone.glb': e('assets/m/standalone.glb', 'match', 1000, { k: 'model', x: 'glb' }),
    'm1.glb': e('assets/m/m1.glb', 'enemy:x', 1000, { k: 'model', x: 'glb', d: ['assets/t/shared.ktx2', 'assets/t/one.ktx2'] }),
    'm2.glb': e('assets/m/m2.glb', 'enemy:y', 2000, { k: 'model', x: 'glb', d: ['assets/t/shared.ktx2'] }),
    'assets/t/shared.ktx2': e('assets/t/shared.ktx2', 'match', 500, { k: 'texture', x: 'ktx2', low: 'assets/t/shared-low.ktx2' }),
    'assets/t/one.ktx2': e('assets/t/one.ktx2', 'enemy:x', 300, { k: 'texture', x: 'ktx2' }),
    'quiet.mp3': { u: null, b: 0, k: 'audio', x: 'mp3', g: ['boss:z'], s: 1 },
  },
  groups: {
    match: { n: ['a.png', 'b.png', 'c.png', 'd.png', 'e.png', 'f.png', 'g.png', 'assets/t/shared.ktx2'], b: 1200 },
    'enemy:x': { n: ['m1.glb', 'assets/t/one.ktx2'], b: 1300 },
    'enemy:y': { n: ['m2.glb'], b: 2000 },
    'boss:z': { n: ['quiet.mp3'], b: 0 },
  },
  facts: {},
};

describe('dedupe per URL', () => {
  it('requests /cdn/x, cdn/x and x once, also across concurrent ensure calls, with cache: force-cache', async () => {
    const name = 'standalone.glb', entry = small.entries[name]!;
    const { fetch, urls } = autoFetch();
    const calls: (RequestInit | undefined)[] = [];
    const loader = createAssetLoader({ resolver: createAssetResolver(small, { base: BASE }), fetch: (u, i) => (calls.push(i), fetch(u, i)) });
    await Promise.all([loader.ensure([`/cdn/${name}`, `cdn/${name}`], 'high'), loader.ensure([name], 'critical')]);
    await loader.ensure([name], 'idle');
    expect(urls).toEqual([abs(entry.u!)]);
    expect(calls[0]?.cache).toBe('force-cache');
    expect(loader.stats().requests).toBe(1);
  });

  it("includes a model's dependencies and fetches a texture shared by two models once", async () => {
    const { fetch, urls } = autoFetch();
    const loader = createAssetLoader({ resolver: createAssetResolver(small, { base: BASE }), fetch });
    await loader.ensure(['/cdn/m1.glb', '/cdn/m2.glb'], 'high');
    expect([...urls].sort()).toEqual([abs('assets/m/m1.glb'), abs('assets/m/m2.glb'), abs('assets/t/one.ktx2'), abs('assets/t/shared.ktx2')].sort());
  });

  it('fetches all synthetic model dependency URLs', async () => {
    const name = 'm1.glb', entry = small.entries[name]!;
    const { fetch, urls } = autoFetch();
    const loader = createAssetLoader({ resolver: createAssetResolver(small, { base: BASE }), fetch });
    await loader.ensure([`/cdn/${name}`], 'critical');
    expect([...urls].sort()).toEqual([entry.u!, ...entry.d!].map(abs).sort());
  });

  it('on the low tier fetches the low variant of a dependency when one exists', async () => {
    const { fetch, urls } = autoFetch();
    const loader = createAssetLoader({ resolver: createAssetResolver(small, { base: BASE }), fetch, tier: 'low' });
    await loader.ensure(['m2.glb'], 'high');
    expect(urls.sort()).toEqual([abs('assets/m/m2.glb'), abs('assets/t/shared-low.ktx2')].sort());
  });

  it('never requests a silent name, and an unknown name is reported, not fetched', async () => {
    const { fetch, urls } = autoFetch();
    const unknown: string[] = [];
    const loader = createAssetLoader({ resolver: createAssetResolver(small, { base: BASE }), fetch, onError: (ref) => unknown.push(ref) });
    await loader.ensure(['/cdn/quiet.mp3', '/cdn/nope.png'], 'critical');
    expect(urls).toEqual([]);
    expect(unknown).toEqual(['nope.png']);
  });
});

describe('priorities', () => {
  it('starts critical before high before idle, whatever the call order', async () => {
    const { fetch, calls } = manualFetch();
    const loader = createAssetLoader({ resolver: createAssetResolver(small, { base: BASE }), fetch, concurrency: 1 });
    const all = Promise.all([
      loader.ensure(['a.png', 'b.png', 'c.png'], 'idle'),
      loader.ensure(['d.png', 'e.png'], 'high'),
      loader.ensure(['f.png', 'g.png'], 'critical'),
    ]);
    const order: string[] = [];
    for (let i = 0; i < 7; i++) {
      await flush();
      const next = calls[i];
      expect(next, `request ${i}`).toBeDefined();
      order.push(next!.url.replace(abs('assets/i/'), ''));
      next!.respond();
    }
    await all;
    // f starts alone; g follows f; d starts in the high lane once nothing critical waits; idle waits until high has drained.
    expect(order).toEqual(['f.webp', 'g.webp', 'd.webp', 'e.webp', 'a.webp', 'b.webp', 'c.webp']);
  });

  it('keeps at most `concurrency` requests in flight per priority (default 6)', async () => {
    const { fetch, calls } = manualFetch();
    const loader = createAssetLoader({ resolver: createAssetResolver(small, { base: BASE }), fetch });
    const p = loader.ensure(['a.png', 'b.png', 'c.png', 'd.png', 'e.png', 'f.png', 'g.png'], 'high');
    await flush();
    expect(calls).toHaveLength(6);
    calls[0]!.respond();
    await flush();
    expect(calls).toHaveLength(7);
    for (const c of calls.slice(1)) c.respond();
    await p;
  });

  it('a queued idle request ensured again as critical jumps the queue', async () => {
    const { fetch, calls } = manualFetch();
    const loader = createAssetLoader({ resolver: createAssetResolver(small, { base: BASE }), fetch, concurrency: 1 });
    const idle = loader.ensure(['a.png', 'b.png', 'c.png'], 'idle');
    await flush();
    expect(calls.map((c) => c.url)).toEqual([abs('assets/i/a.webp')]);
    const crit = loader.ensure(['c.png'], 'critical');
    await flush();
    expect(calls.map((c) => c.url)).toEqual([abs('assets/i/a.webp'), abs('assets/i/c.webp')]);
    calls[1]!.respond();
    await crit;
    calls[0]!.respond();
    await flush();
    expect(calls[2]!.url).toBe(abs('assets/i/b.webp'));
    calls[2]!.respond();
    await idle;
    expect(loader.stats().requests).toBe(3);
  });
});

describe('failures', () => {
  it('never re-requests a 404: ensure resolves, the URL is listed once, later calls do not fetch again', async () => {
    const { fetch, urls } = autoFetch((u) => (u.endsWith('/b.webp') ? 404 : 200));
    const errors: string[] = [];
    const loader = createAssetLoader({ resolver: createAssetResolver(small, { base: BASE }), fetch, onError: (ref) => errors.push(ref) });
    await loader.ensure(['a.png', 'b.png'], 'critical');
    await flush();
    await loader.ensure(['b.png'], 'critical');
    await loader.prefetchGroup('match', 'idle');
    await flush();
    expect(urls.filter((u) => u.endsWith('/b.webp'))).toHaveLength(1);
    expect(loader.stats().failures).toEqual([abs('assets/i/b.webp')]);
    expect(errors).toEqual([abs('assets/i/b.webp')]);
  });

  it('a 404 on a dependency does not loop either', async () => {
    const { fetch, urls } = autoFetch((u) => (u.endsWith('shared.ktx2') ? 404 : 200));
    const loader = createAssetLoader({ resolver: createAssetResolver(small, { base: BASE }), fetch });
    await loader.ensure(['m1.glb'], 'high');
    await loader.ensure(['m2.glb'], 'high');
    await flush();
    expect(urls.filter((u) => u.endsWith('shared.ktx2'))).toHaveLength(1);
  });

  it('a network error is not retried by itself; a later ensure may retry it, a bounded number of times', async () => {
    let n = 0;
    const fetch: FetchLike = () => (n++, Promise.reject(new TypeError('offline')));
    const loader = createAssetLoader({ resolver: createAssetResolver(small, { base: BASE }), fetch, maxNetworkAttempts: 2 });
    await loader.ensure(['a.png'], 'high');
    await flush();
    expect(n).toBe(1);
    await loader.ensure(['a.png'], 'high');
    await loader.ensure(['a.png'], 'high');
    await loader.ensure(['a.png'], 'high');
    await flush();
    expect(n).toBe(2);
    expect(loader.stats().failures).toEqual([abs('assets/i/a.webp')]);
  });
});

describe('groups, progress and stats', () => {
  it('prefetchGroup loads every name of the group; progress counts bytes per group', async () => {
    const { fetch } = autoFetch();
    const loader = createAssetLoader({ resolver: createAssetResolver(small, { base: BASE }), fetch });
    expect(loader.progress(['enemy:x'])).toEqual({ loaded: 0, total: 1300 + 500 });
    await loader.prefetchGroup('enemy:x', 'high');
    expect(loader.progress(['enemy:x'])).toEqual({ loaded: 1800, total: 1800 });
    expect(loader.progress(['enemy:x', 'enemy:y'])).toEqual({ loaded: 1800, total: 1800 + 2000 });
    expect(loader.progress(['match'])).toEqual({ loaded: 500, total: 1200 });
    expect(loader.stats().bytesByGroup['enemy:x']).toBe(16); // two 8-byte responses (m1, one); `shared` is a match texture
    expect(loader.stats().bytesByGroup['match']).toBe(8);
  });

  it('a group of only silent names is complete at once', async () => {
    const loader = createAssetLoader({ resolver: createAssetResolver(small, { base: BASE }), fetch: autoFetch().fetch });
    await loader.prefetchGroup('boss:z', 'idle');
    expect(loader.progress(['boss:z'])).toEqual({ loaded: 0, total: 0 });
    await loader.prefetchGroup('unknown:group' as 'match', 'idle');
  });

  it('onProgress reports loaded/total bytes of everything requested, and unsubscribes', async () => {
    const { fetch, calls } = manualFetch();
    const loader = createAssetLoader({ resolver: createAssetResolver(small, { base: BASE }), fetch });
    const seen: { loaded: number; total: number }[] = [];
    const off = loader.onProgress((p) => seen.push(p));
    const p = loader.ensure(['a.png', 'b.png'], 'high');
    await flush();
    calls[0]!.respond();
    await flush();
    off();
    calls[1]!.respond();
    await p;
    expect(seen[0]).toEqual({ loaded: 0, total: 200 });
    expect(seen.at(-1)).toEqual({ loaded: 100, total: 200 });
  });

  it('prefetches a synthetic group by bytes', async () => {
    const { fetch } = autoFetch();
    const loader = createAssetLoader({ resolver: createAssetResolver(small, { base: BASE }), fetch });
    const key = 'enemy:x';
    await loader.prefetchGroup(key, 'idle');
    const p = loader.progress([key]);
    expect(p.loaded).toBe(p.total);
    expect(p.total).toBeGreaterThanOrEqual(small.groups[key]!.b);
  });
});
