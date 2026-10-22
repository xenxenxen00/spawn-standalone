// The asset index (build §5.9, docs/architecture.md §3 module map, WP B8): the JSON the asset pipeline writes to
// `.cache/assets/out/public/asset-index.json` for the host to pass to the runtime. Type-only.
// tools/assets/index-types.ts is the pipeline's copy of the same contract (tools/ does not depend on src/); the two must stay
// structurally equal, which tests/unit/assets/index-types.node.test.ts checks at compile time.

export type AssetKind = 'model' | 'texture' | 'image' | 'audio' | 'video' | 'clip' | 'atlas' | 'bake';

export type GroupKey = string;

export interface AssetEntry {
  /** page-relative URL ('assets/m/9f3c….glb'); null = silent (build §5.5) */
  readonly u: string | null;
  /** bytes of u (file bytes; never used as GPU memory, build §8.8) */
  readonly b: number;
  readonly k: AssetKind;
  /** actual extension of u ('glb'|'ktx2'|'webp'|'png'|'mp3'|'wav'|'mp4'|'jsonz'|'bin'); 'jsonz' = a raw-deflate stream of JSON (kind clip), 'bin' = a PlaceBake (kind bake); the key's extension may differ (.png→.webp, .mp3→.wav) */
  readonly x: string;
  readonly g: readonly GroupKey[];
  /** dependency URLs (a model's textures); each is also an entry key */
  readonly d?: readonly string[];
  /**
   * low-tier dependency URLs (stage 8c): on the low tier the loader fetches these instead of `d`. The decal atlas
   * manifest lists its low pages here; the high/low page sets pack independently so their counts differ, which the
   * per-entry `low` URL contract cannot express.
   */
  readonly dLow?: readonly string[];
  /** low-tier 512² variant URL (build §5.2 stage 8) */
  readonly low?: string;
  /** texture/image header (stage 3/5) */
  readonly gpu?: { readonly w: number; readonly h: number; readonly levels: number; readonly fmt: 'uastc' | 'etc1s' | 'rgba8' };
  /** audio seconds */
  readonly dur?: number;
  /** audio: decoded channel count (stage 6b) */
  readonly ch?: 1 | 2;
  /** audio: io §2.8 */
  readonly mode?: 'buffer' | 'stream';
  /** audio: sample-exact loop start / end in seconds, loops only (stage 6b) */
  readonly ls?: number;
  readonly le?: number;
  /** audio: positional-only, down-mixed to mono after decode (io §2.8) */
  readonly pos?: 1;
  /** silent in live, kept silent */
  readonly s?: 1;
}

/** `[minX, minY, minZ, maxX, maxY, maxZ]`: x/z as authored, y rebased so the model stands on y = 0 (stage 4). */
export type FactBounds = readonly [number, number, number, number, number, number];

/** One stage-4 record (build §5.2 stage 4 + 8b). `clips` and `skinned` are additive to build §5.9 (world.facts.yaml carries them). */
export interface AssetFact {
  readonly bounds?: FactBounds;
  readonly tris?: number;
  readonly gait?: Readonly<Record<string, number>>;
  /** animation clip names of the GLB */
  readonly clips?: readonly string[];
  /** true when the model has a skin */
  readonly skinned?: boolean;
}

export interface AssetGroup {
  /** entry keys (CDN names, texture URLs) */
  readonly n: readonly string[];
  /** sum of the entries' `b` */
  readonly b: number;
}

export interface AssetIndex {
  readonly v: 1;
  /** pipeline hash */
  readonly build: string;
  /** commit of the live tree */
  readonly origin: string;
  /** keyed by CDN name without the 'cdn/' prefix; texture files (not CDN names) are keyed by their URL */
  readonly entries: Readonly<Record<string, AssetEntry>>;
  readonly groups: Readonly<Record<string, AssetGroup>>;
  readonly facts: Readonly<Record<string, AssetFact>>;
}
