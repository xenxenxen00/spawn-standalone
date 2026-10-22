// Resolver behavior over a complete synthetic asset index.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AssetEntry, AssetIndex } from '../../../src/assets/index-types.ts';
import {
  EMPTY_DATA_URI,
  asAssetIndex,
  assetFacts,
  createAssetFactsPort,
  createAssetResolver,
  installAssetIndex,
  normalizeCdnRef,
  resetAssetIndex,
  resolveCdn,
  rewriteCdnInText,
  toLiveFacts,
} from '../../../src/assets/resolver.ts';
import { emptyPlaceBake } from '../../../src/compat/core/null-ports.ts';

const BASE = 'https://game.example/sub/index.html';
const fixture: AssetIndex = {
  v: 1, build: 'synthetic', origin: 'synthetic',
  entries: {
    'figure.glb': { u: 'assets/m/figure.glb', b: 100, k: 'model', x: 'glb', g: ['example'], d: ['assets/t/color.ktx2'] },
    'assets/t/color.ktx2': { u: 'assets/t/color.ktx2', b: 20, k: 'texture', x: 'ktx2', g: ['example'] },
    'silent.mp3': { u: null, b: 0, k: 'audio', x: 'mp3', g: [], s: 1 },
    'picture.png': { u: 'assets/i/picture.webp', b: 10, k: 'image', x: 'webp', g: [] },
    'preview.mp4': { u: 'assets/v/preview.mp4', b: 30, k: 'video', x: 'mp4', g: [] },
    'tone.mp3': { u: 'assets/a/tone.wav', b: 40, k: 'audio', x: 'wav', g: [], dur: 1.5 },
  },
  groups: { example: { n: ['figure.glb', 'assets/t/color.ktx2'], b: 120 } },
  facts: { 'figure.glb': { bounds: [-1, 0, -0.5, 1, 1.8, 0.5], tris: 12, skinned: true } },
};
const entries = Object.entries(fixture.entries);
const [modelName, model] = entries.find(([, e]) => e.k === 'model' && e.d !== undefined)!;
const [silentName] = entries.find(([, e]) => e.s === 1)!;
const [textureKey, texture] = entries.find(([, e]) => e.k === 'texture')!;

const SPLAT = 'picture.png';
const VIDEO = 'preview.mp4';
const [WAV] = entries.find(([k, e]) => e.x === 'wav' && k.endsWith('.mp3'))!;
const POSTER = 'b8-test/menu-poster.png';
const LOW = 'b8-test/tex-low.png';
const inline: Record<string, AssetEntry> = {
  [POSTER]: { u: 'assets/v/3333333333333333.webp', b: 5, k: 'image', x: 'webp', g: ['boot/menu'] },
  [LOW]: { u: 'assets/t/5555555555555555.ktx2', b: 40, k: 'texture', x: 'ktx2', g: ['match'], low: 'assets/t/6666666666666666.ktx2' },
};
const index: AssetIndex = { ...fixture, entries: { ...fixture.entries, ...inline } };
const urlOf = (name: string): string => index.entries[name]!.u!;
const abs = (u: string): string => new URL(u, BASE).href;

describe('normalizeCdnRef', () => {
  it('strips /cdn/ and cdn/ and keeps a bare name', () => {
    expect(normalizeCdnRef(`/cdn/${modelName}`)).toBe(modelName);
    expect(normalizeCdnRef(`cdn/${modelName}`)).toBe(modelName);
    expect(normalizeCdnRef(modelName)).toBe(modelName);
    expect(normalizeCdnRef('sounds/example.mp3')).toBe('sounds/example.mp3');
    expect(normalizeCdnRef('/cdn/sounds/example.mp3')).toBe('sounds/example.mp3');
  });
  it('leaves ss:<id> refs (sfx-core handles them) and page URLs alone', () => {
    expect(normalizeCdnRef('ss:click')).toBe('ss:click');
    expect(normalizeCdnRef(textureKey)).toBe(textureKey);
  });
});

describe('createAssetResolver over a synthetic asset index', () => {
  const r = createAssetResolver(index, { base: BASE });

  it('resolves /cdn/x, cdn/x and the bare name to the same absolute URL', () => {
    const want = abs(model.u!);
    expect(r.resolve(`/cdn/${modelName}`)).toBe(want);
    expect(r.resolve(`cdn/${modelName}`)).toBe(want);
    expect(r.resolve(modelName)).toBe(want);
    expect(want.startsWith('https://game.example/sub/assets/m/')).toBe(true);
  });

  it('resolves every non-silent fixture entry under all three spellings', () => {
    for (const [name, e] of entries) {
      if (e.s === 1) continue;
      const want = abs(e.u!);
      expect([r.resolve(`/cdn/${name}`), r.resolve(`cdn/${name}`), r.resolve(name)]).toEqual([want, want, want]);
    }
  });

  it('returns null for synthetic silent entries and unknown names', () => {
    const silent = entries.filter(([, e]) => e.s === 1);
    expect(silent).toHaveLength(1);
    for (const [name] of silent) {
      expect(r.resolve(`/cdn/${name}`)).toBeNull();
      expect(r.isSilent(`cdn/${name}`)).toBe(true);
    }
    expect(r.resolve(silentName)).toBeNull();
    expect(r.resolve('/cdn/not-a-name.glb')).toBeNull();
    expect(r.isSilent('/cdn/not-a-name.glb')).toBe(false);
  });

  it('resolves texture entries by their URL key', () => {
    expect(r.resolve(textureKey)).toBe(abs(texture.u!));
  });

  it('serves the actual extension (.png → .webp, .mp3 → .wav) and the low-tier variant when asked', () => {
    expect(urlOf(SPLAT)).toMatch(/\.webp$/);
    expect(urlOf(WAV)).toMatch(/\.wav$/);
    expect(r.resolve(`/cdn/${SPLAT}`)).toBe(abs(urlOf(SPLAT)));
    expect(r.resolve(`/cdn/${WAV}`)).toBe(abs(urlOf(WAV)));
    expect(r.resolve(LOW, 'low')).toBe(abs('assets/t/6666666666666666.ktx2'));
    expect(r.resolve(LOW, 'full')).toBe(abs('assets/t/5555555555555555.ktx2'));
    expect(r.resolve(modelName, 'low')).toBe(abs(model.u!)); // no variant: the full URL
  });
});

describe('rewriteCdnInText', () => {
  const missing: string[] = [];
  const r = createAssetResolver(index, { base: BASE, onMissing: (n) => missing.push(n) });
  afterEach(() => {
    missing.length = 0;
  });

  it('rewrites src="/cdn/…" (img and video) and poster="…"', () => {
    const html = `<img class="w" src="/cdn/${SPLAT}" alt=""/><video id="v" src="/cdn/${VIDEO}" poster='cdn/${POSTER}' autoplay muted></video>`;
    expect(r.rewrite(html)).toBe(
      `<img class="w" src="${abs(urlOf(SPLAT))}" alt=""/><video id="v" src="${abs(urlOf(VIDEO))}" poster='${abs(urlOf(POSTER))}' autoplay muted></video>`,
    );
  });

  it('rewrites url(/cdn/…), url("cdn/…"), url(\'/cdn/…\') and url(&quot;/cdn/…&quot;)', () => {
    const u = abs(urlOf(SPLAT));
    expect(r.rewrite(`#ss .death .sp{background:url(/cdn/${SPLAT}) center/contain no-repeat}`)).toBe(
      `#ss .death .sp{background:url(${u}) center/contain no-repeat}`,
    );
    expect(r.rewrite(`a{background:url("cdn/${SPLAT}")}`)).toBe(`a{background:url("${u}")}`);
    expect(r.rewrite(`a{background:url( '/cdn/${SPLAT}' )}`)).toBe(`a{background:url( '${u}' )}`);
    expect(r.rewrite(`<div style="background:url(&quot;/cdn/${SPLAT}&quot;)"></div>`)).toBe(
      `<div style="background:url(&quot;${u}&quot;)"></div>`,
    );
  });

  it("rewrites a quoted 'cdn/…' or \"/cdn/…\" anywhere in the text, and unquoted src=/poster=", () => {
    const u = abs(model.u!);
    expect(r.rewrite(`<div data-m='cdn/${modelName}'></div>`)).toBe(`<div data-m='${u}'></div>`);
    expect(r.rewrite(`<a href="/cdn/${modelName}">x</a>`)).toBe(`<a href="${u}">x</a>`);
    expect(r.rewrite(`<img src=/cdn/${SPLAT} alt="">`)).toBe(`<img src=${abs(urlOf(SPLAT))} alt="">`);
  });

  it('replaces a silent or unknown name by an empty data URI and reports it, so no /cdn/ URL ever reaches the network', () => {
    const out = r.rewrite(`<img src="/cdn/${silentName}"><img src="/cdn/nope.png"><i style="background:url(/cdn/nope2.png)"></i>`);
    expect(out).toBe(`<img src="${EMPTY_DATA_URI}"><img src="${EMPTY_DATA_URI}"><i style="background:url(${EMPTY_DATA_URI})"></i>`);
    expect(out).not.toMatch(/cdn\//);
    expect(missing).toEqual([silentName, 'nope.png', 'nope2.png']);
  });

  it('returns the very same string when the text holds no cdn/ reference', () => {
    const s = '<div id="ss" class="x"><b>cdn is a word</b></div>';
    expect(r.rewrite(s)).toBe(s);
  });

  it('leaves unquoted prose mentioning cdn/ alone', () => {
    expect(r.rewrite('<p>see cdn/readme</p>')).toBe('<p>see cdn/readme</p>');
  });

  it('memoises per text (LRU) and gives identical results on a hit', () => {
    const html = `<img src="/cdn/${SPLAT}">`;
    const a = r.rewrite(html);
    const b = r.rewrite(html);
    expect(b).toBe(a);
    expect(r.rewriteCacheSize()).toBeGreaterThan(0);
    for (let i = 0; i < 400; i++) r.rewrite(`<img src="/cdn/${SPLAT}" data-i="${i}">`);
    expect(r.rewriteCacheSize()).toBeLessThanOrEqual(256);
  });
});

describe('assetFacts and AssetFactsPort.get', () => {
  const r = createAssetResolver(index, { base: BASE });
  const factNames = Object.keys(fixture.facts);

  it('assetFacts returns the index record under every spelling', () => {
    for (const n of factNames.slice(0, 20)) {
      expect(r.facts(n)).toEqual(fixture.facts[n]);
      expect(r.facts(`/cdn/${n}`)).toBe(r.facts(n));
      expect(r.facts(`cdn/${n}`)).toBe(r.facts(n));
    }
    expect(r.facts('/cdn/nope.glb')).toBeUndefined();
  });

  it('converts the 6-tuple to the live {center, min, max, size} shape', () => {
    const live = toLiveFacts({ bounds: [-1, 0, -0.5, 1, 1.8, 0.5], tris: 12, skinned: true, clips: ['walk'], gait: { walk: 1.4 } });
    expect(live).toEqual({
      bounds: { center: [0, 0.9, 0], min: [-1, 0, -0.5], max: [1, 1.8, 0.5], size: [2, 1.8, 1] },
      triangles: 12,
      skinned: true,
      clips: ['walk'],
      gait: { walk: 1.4 },
    });
    expect(Object.isFrozen(live)).toBe(true);
    expect(toLiveFacts({ tris: 3 })).toEqual({ triangles: 3, clips: [], skinned: false });
    expect(toLiveFacts(undefined)).toBeUndefined();
  });

  it('get(ref) returns the live shape, stable per name across spellings; audio carries its duration', () => {
    const port = createAssetFactsPort(r, (p) => Promise.resolve(emptyPlaceBake(p)));
    const a = port.get(`/cdn/${modelName}`);
    expect(a).toBe(port.get(modelName));
    expect(a).toBe(port.get(`cdn/${modelName}`));
    const t = fixture.facts[modelName]!.bounds!;
    expect(a!.bounds!.size[1]).toBeCloseTo(t[4] - t[1], 12);
    expect(a!.bounds!.min).toEqual([t[0], t[1], t[2]]);
    expect(a!.bounds!.max).toEqual([t[3], t[4], t[5]]);
    expect(a!.triangles).toBe(fixture.facts[modelName]!.tris);
    expect(port.get(`/cdn/${WAV}`)).toEqual({ duration: index.entries[WAV]!.dur });
    expect(port.get(`/cdn/${silentName}`)).toBeUndefined();
    expect(port.get('/cdn/nope.glb')).toBeUndefined();
  });

  it('placeBake goes to the injected reader', async () => {
    const seen: string[] = [];
    const port = createAssetFactsPort(r, (p) => {
      seen.push(p);
      return Promise.resolve(emptyPlaceBake(p));
    });
    await port.placeBake('outpost');
    expect(seen).toEqual(['outpost']);
  });
});

describe('the installed index (module-level functions)', () => {
  afterEach(() => resetAssetIndex());

  it('throws a clear error before installAssetIndex', () => {
    expect(() => resolveCdn(modelName)).toThrow(/installAssetIndex/);
  });

  it('delegates resolveCdn, rewriteCdnInText and assetFacts to the installed resolver', () => {
    installAssetIndex(index, { base: BASE });
    expect(resolveCdn(`/cdn/${modelName}`)).toBe(abs(model.u!));
    expect(resolveCdn(silentName)).toBeNull();
    expect(rewriteCdnInText(`<img src="/cdn/${SPLAT}">`)).toBe(`<img src="${abs(urlOf(SPLAT))}">`);
    expect(assetFacts(`cdn/${modelName}`)).toEqual(fixture.facts[modelName]);
  });

  it('defaults the base to document.baseURI', () => {
    vi.stubGlobal('document', { baseURI: 'https://host.example/game/' });
    try {
      installAssetIndex(index);
      expect(resolveCdn(modelName)).toBe(new URL(model.u!, 'https://host.example/game/').href);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('asAssetIndex', () => {
  it('accepts the fixture and rejects what is not a v1 index', () => {
    expect(asAssetIndex(fixture)).toBe(fixture);
    expect(() => asAssetIndex(null)).toThrow(/asset index/);
    expect(() => asAssetIndex({ ...fixture, v: 2 })).toThrow(/asset index/);
    expect(() => asAssetIndex({ v: 1, entries: {} })).toThrow(/asset index/);
  });
});
