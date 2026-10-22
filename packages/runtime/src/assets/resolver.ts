// CDN name → URL over the asset index (build §5.5, §5.9; docs/architecture.md §3 module map, WP B8).
//
// Game modules name assets as `/cdn/<name>`, `cdn/<name>` or the bare `<name>` (io §2.4); the index keys them by the bare name
// (texture files by their URL). Everything here is a pure function of the index and a base URL, so tests build resolvers with
// `createAssetResolver`; the page installs one with `installAssetIndex` (the composition root, X1) and the free functions of
// build §5.9 (`resolveCdn`, `rewriteCdnInText`, `assetFacts`) delegate to it.
//
// `assetFacts(ref)` is the stage-4 record as the index stores it (bounds as a 6-tuple). The game reads the live
// world.facts.yaml shape, `bounds: {center, min, max, size}` (`scripts/enemies/runtime.js:478-479` reads `bounds.size[1]` and
// would silently fall back to scale 1 on a tuple), so `AssetFactsPort.get` (`createAssetFactsPort`) converts with `toLiveFacts`.
import type { AssetFacts } from '../compat/core/types.ts';
import type { AssetFactsPort, PlaceBake } from '../compat/core/ports.ts';
import type { AssetEntry, AssetFact, AssetIndex } from './index-types.ts';

export type Tier = 'full' | 'low';

/** A 1×1 transparent GIF: what a `/cdn/` URL with no shipped file becomes, so the page never requests the live CDN path. */
export const EMPTY_DATA_URI = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

/** Entries the UI host's rewrite memo keeps (build §5.9 rules: a small LRU keyed by the substring). */
export const REWRITE_LRU_SIZE = 256;

const CDN_PREFIX = /^\/?cdn\//;

/** '/cdn/x', 'cdn/x', 'x' → 'x'. Anything else (page URLs, 'ss:<id>', which sfx-core handles itself) is returned unchanged. */
export function normalizeCdnRef(ref: string): string {
  return ref.replace(CDN_PREFIX, '');
}

export interface ResolverOptions {
  /** absolute base the page-relative URLs resolve against; default `document.baseURI` */
  base?: string;
  /** a `/cdn/` reference in rewritten text with no shipped file (silent or unknown); called once per name */
  onMissing?: (name: string) => void;
}

export interface AssetResolver {
  readonly index: AssetIndex;
  readonly base: string;
  /** the index entry of a ref under any spelling */
  entry(ref: string): AssetEntry | undefined;
  /** silent in live and kept silent (build §5.5) */
  isSilent(ref: string): boolean;
  /** `resolveCdn`: absolute URL, the low-tier variant when asked and present; null for a silent or unknown name */
  resolve(ref: string, tier?: Tier): string | null;
  /** `rewriteCdnInText`: `/cdn/` URLs in HTML/CSS text → shipped URLs */
  rewrite(text: string): string;
  /** `assetFacts`: the stage-4 record of the index */
  facts(ref: string): AssetFact | undefined;
  /** what `AssetFactsPort.get` returns: the live world.facts.yaml shape, memoised and frozen */
  liveFacts(ref: string): AssetFacts | undefined;
  /** entries currently in the rewrite memo */
  rewriteCacheSize(): number;
}

function defaultBase(): string {
  const doc = (globalThis as { document?: { baseURI?: string } }).document;
  if (doc?.baseURI) return doc.baseURI;
  throw new Error('asset resolver: no base URL (pass options.base outside a page)');
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Narrows the host asset-index document (typed `unknown`) to a v1 index; throws on anything else. */
export function asAssetIndex(raw: unknown): AssetIndex {
  if (!isRecord(raw) || raw['v'] !== 1 || !isRecord(raw['entries']) || !isRecord(raw['groups']) || !isRecord(raw['facts'])) {
    throw new Error('not a v1 asset index (build §5.9): expected {v: 1, entries, groups, facts}');
  }
  return raw as unknown as AssetIndex;
}

const freezeDeep = <T>(v: T): T => {
  if (typeof v === 'object' && v !== null && !Object.isFrozen(v)) {
    for (const x of Object.values(v)) freezeDeep(x);
    Object.freeze(v);
  }
  return v;
};

type Vec3 = [number, number, number];

/**
 * The live `ctx.world.assets[ref]` record (world.facts.yaml `assets.metadata`) from a stage-4 record and/or an entry: bounds as
 * {center, min, max, size}, `triangles`, `clips` (`[]` when none, as live writes it), `skinned`, `gait`, and `duration` for
 * audio. Frozen. Undefined when there is nothing to say (no record and no duration).
 */
export function toLiveFacts(fact: AssetFact | undefined, entry?: AssetEntry): AssetFacts | undefined {
  const out: { -readonly [K in keyof AssetFacts]: AssetFacts[K] } = {};
  if (fact) {
    const b = fact.bounds;
    if (b) {
      const min: Vec3 = [b[0], b[1], b[2]];
      const max: Vec3 = [b[3], b[4], b[5]];
      out.bounds = {
        center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
        min,
        max,
        size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
      };
    }
    if (fact.tris !== undefined) out.triangles = fact.tris;
    out.clips = fact.clips ? [...fact.clips] : [];
    out.skinned = fact.skinned ?? false;
    if (fact.gait && Object.keys(fact.gait).length > 0) out.gait = { ...fact.gait };
  }
  if (entry?.dur !== undefined) out.duration = entry.dur;
  return Object.keys(out).length === 0 ? undefined : freezeDeep(out as AssetFacts);
}

// One pass, left to right, three forms (names never contain quotes, whitespace, `(`, `)`, `<`, `>` or `&`):
//   1-4  `url(…)` with no, single, double or &quot; quotes; the inner whitespace is kept;
//   5-6  any quoted `cdn/…` or `/cdn/…` string: `src="…"`, `poster='…'`, `href="…"`, a quoted name in inline CSS or a data attribute;
//   7-8  unquoted `src=` / `poster=` attributes.
const NAME = String.raw`\/?cdn\/[^"'&()\s<>]+`;
const RE_CDN = new RegExp(
  String.raw`url\((\s*)(&quot;|&#0?39;|["']?)(${NAME})\2(\s*)\)` + '|' + String.raw`(["'])(${NAME})\5` + '|' + String.raw`(\b(?:src|poster)=)(${NAME})`,
  'g',
);

export function createAssetResolver(index: AssetIndex, opts: ResolverOptions = {}): AssetResolver {
  const base = opts.base ?? defaultBase();
  const entries = index.entries;
  const has = (k: string): boolean => Object.prototype.hasOwnProperty.call(entries, k);
  const entry = (ref: string): AssetEntry | undefined => {
    const k = normalizeCdnRef(ref);
    return has(k) ? entries[k] : undefined;
  };
  const absCache = new Map<string, string>();
  const abs = (u: string): string => {
    let a = absCache.get(u);
    if (a === undefined) {
      a = new URL(u, base).href;
      absCache.set(u, a);
    }
    return a;
  };
  const resolve = (ref: string, tier: Tier = 'full'): string | null => {
    const e = entry(ref);
    if (!e || e.s === 1 || e.u === null) return null;
    return abs(tier === 'low' && e.low !== undefined ? e.low : e.u);
  };

  const reported = new Set<string>();
  const shipped = (ref: string): string => {
    const url = resolve(ref);
    if (url !== null) return url;
    const name = normalizeCdnRef(ref);
    if (!reported.has(name)) {
      reported.add(name);
      opts.onMissing?.(name);
    }
    return EMPTY_DATA_URI;
  };
  const lru = new Map<string, string>();
  const rewrite = (text: string): string => {
    if (!text.includes('cdn/')) return text;
    const hit = lru.get(text);
    if (hit !== undefined) {
      lru.delete(text);
      lru.set(text, hit);
      return hit;
    }
    const out = text.replace(RE_CDN, (...m: (string | undefined)[]) => {
      if (m[3] !== undefined) return `url(${m[1]}${m[2]}${shipped(m[3])}${m[2]}${m[4]})`;
      if (m[6] !== undefined) return `${m[5]}${shipped(m[6])}${m[5]}`;
      return `${m[7]}${shipped(m[8]!)}`;
    });
    lru.set(text, out);
    if (lru.size > REWRITE_LRU_SIZE) lru.delete(lru.keys().next().value!);
    return out;
  };

  const facts = (ref: string): AssetFact | undefined => {
    const k = normalizeCdnRef(ref);
    return Object.prototype.hasOwnProperty.call(index.facts, k) ? index.facts[k] : undefined;
  };
  const live = new Map<string, AssetFacts | undefined>();
  const liveFacts = (ref: string): AssetFacts | undefined => {
    const k = normalizeCdnRef(ref);
    if (live.has(k)) return live.get(k);
    const f = toLiveFacts(facts(k), entry(k));
    live.set(k, f);
    return f;
  };

  return {
    index,
    base,
    entry,
    isSilent: (ref) => entry(ref)?.s === 1,
    resolve,
    rewrite,
    facts,
    liveFacts,
    rewriteCacheSize: () => lru.size,
  };
}

/** `AssetFactsPort` (docs/architecture.md §3.0): `get` from the resolver's live facts; `placeBake` from the bake reader (C4). */
export function createAssetFactsPort(resolver: AssetResolver, placeBake: (place: string) => Promise<PlaceBake>): AssetFactsPort {
  return { get: (ref) => resolver.liveFacts(ref), placeBake };
}

// ── the installed index (one per page) ───────────────────────────────────────────────────────────────────────────────

let installed: AssetResolver | undefined;

/** Installs the page's index (the `virtual:ss/asset-index` default export, validated) and returns its resolver. */
export function installAssetIndex(index: unknown, opts: ResolverOptions = {}): AssetResolver {
  installed = createAssetResolver(asAssetIndex(index), opts);
  return installed;
}

/** For tests: forget the installed index. */
export function resetAssetIndex(): void {
  installed = undefined;
}

/** The installed resolver; throws before `installAssetIndex`. */
export function assetResolver(): AssetResolver {
  if (!installed) throw new Error('asset index not installed: call installAssetIndex(index) first (src/assets/resolver.ts)');
  return installed;
}

/** build §5.9: absolute URL against document.baseURI; null for a silent or unknown name (the caller makes that a no-op). */
export function resolveCdn(ref: string, tier?: Tier): string | null {
  return assetResolver().resolve(ref, tier);
}

/** build §5.9: HTML/CSS text with `src="/cdn/…"`, `url(/cdn/…)`, `poster=…` and quoted `cdn/…` pointing at shipped files. */
export function rewriteCdnInText(text: string): string {
  return assetResolver().rewrite(text);
}

/** build §5.9: the stage-4 facts record of a model (the index shape; AssetFactsPort.get gives the live shape). */
export function assetFacts(ref: string): AssetFact | undefined {
  return assetResolver().facts(ref);
}
