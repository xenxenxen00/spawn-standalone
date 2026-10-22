// The `package --target playgama` options a game declares in its standalone.config.ts, resolved to defaults. Nothing here is
// game-specific: every value a game needs (ad placements, orientation, budgets, credits, covers) is read from its config.
//
//   platform.playgama   ads (placements at natural breaks), orientation, pacing, raw bridge-config overrides, check policy
//   budgets             total / initial bytes, file count, per-file caps
//   credits             credits rows for THIRD_PARTY.txt
//   licences            extra npm packages whose licence ships (the root `dependencies` are always considered)
//   covers              the capture shots (URL query and/or a per-game capture script) and which shot makes the covers
import type { GameConfig } from '../import/config.ts';
import type { ArchiveEntry, PgCheck } from './playgama-check.ts';

export type Orientation = 'landscape' | 'portrait';

export interface AdPlacement {
  id: string;
  /** the natural break it is shown at (documentation; lands in the release manifest) */
  at?: string;
}

export interface PlaygamaGameOptions {
  /** the orientations the game supports; default both (no rotate popup) */
  orientation?: Orientation | Orientation[];
  ads?: {
    interstitial?: AdPlacement[];
    rewarded?: AdPlacement[];
    /** seconds between interstitials; default 180 (inside the 120-240 s best-practice band) */
    minimumDelayBetweenInterstitial?: number;
    /** seconds after game_ready before the first interstitial; default 120 */
    initialInterstitialDelay?: number;
  };
  /** deep-merged over the generated playgama-bridge-config.json */
  bridgeConfig?: Record<string, unknown>;
  /** `game.adaptToSafeArea` of the bridge config (default true) */
  adaptToSafeArea?: boolean;
  /** exact URL strings allowed in shipped files (never fetched: namespaces, licence banners) */
  allowUrls?: string[];
  /** extra test-hook patterns (RegExp sources) that must not ship */
  testHooks?: string[];
  /** check ids to skip, with the reason recorded in the report */
  waive?: Record<string, string>;
  /** per-game policy checks run after the generic PG set */
  extraChecks?: Array<(entries: readonly ArchiveEntry[]) => PgCheck | PgCheck[]>;
}

export interface BudgetOptions {
  /** total uncompressed bytes (default 300,000,000: the Playgama archive limit) */
  totalBytes?: number;
  /** bytes index.html loads before the game starts: the page, its scripts, styles, modulepreloads and their static imports */
  initialBytes?: number;
  /** alias of initialBytes (older configs) */
  bootBytes?: number;
  /** the zip size (default 300,000,000) */
  zipBytes?: number;
  maxFiles?: number;
  /** default cap of any single file */
  maxFileBytes?: number;
  /** caps by glob (`*` within a segment, `**` across segments) */
  perFile?: Array<{ match: string; bytes: number }>;
}

export interface CreditRow {
  name: string;
  author?: string;
  licence?: string;
  url?: string;
  note?: string;
}

export interface CoverShot {
  id: string;
  /** appended to the page URL, e.g. `?cover=title` */
  query?: string;
  /** milliseconds to wait after the page is ready (default 1500) */
  waitMs?: number;
}

export interface CoverOptions {
  shots?: CoverShot[];
  /** the shot the three covers are made from (default the first) */
  cover?: string;
  /** a selector the page sets when it is ready (default `body`) */
  readySelector?: string;
  /** a module (relative to the game dir) exporting `capture(page, shot)`; it drives the page before each screenshot */
  script?: string;
  /** page load timeout, ms (default 120000) */
  timeoutMs?: number;
}

export interface ResolvedPackageConfig {
  name: string;
  slug: string;
  version: string;
  sourceCommit: string | null;
  orientations: Orientation[];
  interstitial: AdPlacement[];
  rewarded: AdPlacement[];
  minimumDelayBetweenInterstitial: number;
  initialInterstitialDelay: number;
  adaptToSafeArea: boolean;
  bridgeConfig: Record<string, unknown>;
  allowUrls: string[];
  testHooks: string[];
  waive: Record<string, string>;
  extraChecks: NonNullable<PlaygamaGameOptions['extraChecks']>;
  budgets: Required<Omit<BudgetOptions, 'bootBytes'>>;
  credits: CreditRow[];
  licencePackages: string[];
  covers: Required<Omit<CoverOptions, 'script'>> & { script: string | null };
}

export const DEFAULT_BUDGETS: Required<Omit<BudgetOptions, 'bootBytes'>> = {
  totalBytes: 300_000_000,
  initialBytes: 50_000_000,
  zipBytes: 300_000_000,
  maxFiles: 2000,
  maxFileBytes: 50_000_000,
  perFile: [],
};

export const DEFAULT_SHOTS: CoverShot[] = [
  { id: 'title', waitMs: 2500 },
  { id: 'play', query: '?cover=play', waitMs: 4000 },
];

const obj = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function placements(v: unknown, where: string): AdPlacement[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) throw new Error(`${where} must be a list of { id, at? }`);
  return v.map((p, i) => {
    const id = typeof p === 'string' ? p : (obj(p)['id'] as unknown);
    if (typeof id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(id)) throw new Error(`${where}[${i}].id must be a word (A-Z a-z 0-9 _ -)`);
    const at = obj(p)['at'];
    return typeof at === 'string' ? { id, at } : { id };
  });
}

/** Reads the package options out of a game config, with the defaults filled in. */
export function resolvePackageConfig(config: GameConfig): ResolvedPackageConfig {
  const platform = obj(config['platform']);
  const pg = obj(platform['playgama']) as PlaygamaGameOptions;
  const ads = obj(pg.ads);
  const o = pg.orientation;
  const orientations: Orientation[] = o === undefined ? ['landscape', 'portrait'] : Array.isArray(o) ? [...o] : [o];
  for (const x of orientations) if (x !== 'landscape' && x !== 'portrait') throw new Error(`platform.playgama.orientation: "${String(x)}" is not landscape | portrait`);
  const b = obj(config['budgets']) as BudgetOptions;
  const budgets = {
    totalBytes: b.totalBytes ?? DEFAULT_BUDGETS.totalBytes,
    initialBytes: b.initialBytes ?? b.bootBytes ?? DEFAULT_BUDGETS.initialBytes,
    zipBytes: b.zipBytes ?? DEFAULT_BUDGETS.zipBytes,
    maxFiles: b.maxFiles ?? DEFAULT_BUDGETS.maxFiles,
    maxFileBytes: b.maxFileBytes ?? DEFAULT_BUDGETS.maxFileBytes,
    perFile: b.perFile ?? [],
  };
  const credits = (Array.isArray(config['credits']) ? config['credits'] : []).map((c, i) => {
    const r = obj(c);
    if (typeof r['name'] !== 'string') throw new Error(`credits[${i}].name is missing`);
    return r as unknown as CreditRow;
  });
  const lic = obj(config['licences']);
  const cv = obj(config['covers']) as CoverOptions;
  const shots = cv.shots ?? DEFAULT_SHOTS;
  if (shots.length === 0) throw new Error('covers.shots is empty');
  return {
    name: config.name,
    slug: config.slug,
    version: config.version ?? '0.0.0',
    sourceCommit: config.source.commit ?? null,
    orientations,
    interstitial: placements(ads['interstitial'], 'platform.playgama.ads.interstitial'),
    rewarded: placements(ads['rewarded'], 'platform.playgama.ads.rewarded'),
    minimumDelayBetweenInterstitial: (ads['minimumDelayBetweenInterstitial'] as number | undefined) ?? 180,
    initialInterstitialDelay: (ads['initialInterstitialDelay'] as number | undefined) ?? 120,
    adaptToSafeArea: pg.adaptToSafeArea ?? true,
    bridgeConfig: pg.bridgeConfig ?? {},
    allowUrls: pg.allowUrls ?? [],
    testHooks: pg.testHooks ?? [],
    waive: pg.waive ?? {},
    extraChecks: pg.extraChecks ?? [],
    budgets,
    credits,
    licencePackages: Array.isArray(lic['packages']) ? (lic['packages'] as string[]) : [],
    covers: {
      shots,
      cover: cv.cover ?? shots[0]!.id,
      readySelector: cv.readySelector ?? 'body',
      script: cv.script ?? null,
      timeoutMs: cv.timeoutMs ?? 120_000,
    },
  };
}
