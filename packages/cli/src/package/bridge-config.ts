// playgama-bridge-config.json from the game config (platform-playgama.md §2.3, the recommended file of purge-protocol-web
// ebab692 with the placements, pacing and orientation made per game). Plain JSON: Bridge parses it with JSON.parse.
import type { ResolvedPackageConfig } from './config.ts';

export const BRIDGE_CONFIG_JSON = 'playgama-bridge-config.json';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Deep merge of plain objects; arrays and scalars of `over` replace. */
export function deepMerge(base: Record<string, unknown>, over: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k] as Record<string, unknown>, v) : v;
  return out;
}

export function buildBridgeConfig(cfg: ResolvedPackageConfig): Record<string, unknown> {
  const kind = (list: ResolvedPackageConfig['interstitial']): Record<string, unknown> =>
    list.length === 0 ? { disable: true } : { placementFallback: list[0]!.id, placements: list.map((p) => ({ id: p.id })) };
  const generated: Record<string, unknown> = {
    advertisement: {
      useAdvertisementErrorPopup: false,
      minimumDelayBetweenInterstitial: cfg.minimumDelayBetweenInterstitial,
      initialInterstitialDelay: cfg.initialInterstitialDelay,
      interstitial: kind(cfg.interstitial),
      rewarded: kind(cfg.rewarded),
      banner: { disable: true },
      advancedBanners: { disable: true },
    },
    device: { useBuiltInOrientationPopup: cfg.orientations.length === 1, supportedOrientations: [...cfg.orientations] },
    game: { adaptToSafeArea: cfg.adaptToSafeArea },
  };
  return deepMerge(generated, cfg.bridgeConfig);
}

export const bridgeConfigText = (cfg: ResolvedPackageConfig): string => `${JSON.stringify(buildBridgeConfig(cfg), null, 2)}\n`;
