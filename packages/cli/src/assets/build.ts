// `spawn-standalone assets build`: the runtime's asset index (v1, packages/runtime/src/assets/index-types.ts) from a Spawn export's
// asset-manifest.json and its assets/cdn folder. Generic and flat: no transcoding, every CDN file ships as it is.
//
//   key       the reference without its `/cdn/` (or `cdn/`) prefix, as the runtime resolves it (`normalizeCdnRef`)
//   u         `assets/cdn/<name>` (page-relative; the Vite plugin serves and emits the files from the export's assets/cdn)
//   b, k, x   the file's bytes, its kind by extension (model, texture, image, audio, video) and extension
//   g         'boot/critical' for a name matched by the config's `assets.boot` list (names or `*` globs), else 'lazy'
//   silent    a manifest row whose file is not in assets/cdn (not downloaded, or deleted): `u: null, s: 1`
//
// The written file also carries `cdnDir` (the export's assets/cdn, relative to the game dir), which the plugin reads to find the
// files and strips from the index it serves.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { loadGameConfig } from '../import/config.ts';
import { compressAssets, type ImagesConfig } from './compress.ts';

export type FlatAssetKind = 'model' | 'texture' | 'image' | 'audio' | 'video';

export const KIND_BY_EXT: Readonly<Record<string, FlatAssetKind>> = Object.freeze({
  glb: 'model',
  gltf: 'model',
  ktx2: 'texture',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  svg: 'image',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  m4a: 'audio',
  mp4: 'video',
  webm: 'video',
});

export const BOOT_GROUP = 'boot/critical';
export const LAZY_GROUP = 'lazy';

export interface FlatEntry {
  u: string | null;
  b: number;
  k: FlatAssetKind;
  x: string;
  g: string[];
  s?: 1;
  /** original bytes, when the file was recompressed (`b` is then the output size) */
  ob?: number;
}

export interface FlatAssetIndex {
  v: 1;
  build: string;
  origin: string;
  entries: Record<string, FlatEntry>;
  groups: Record<string, { n: string[]; b: number }>;
  facts: Record<string, never>;
}

export interface AssetIndexBuild {
  index: FlatAssetIndex;
  /** manifest rows whose file is not in assets/cdn (silent entries) */
  missing: string[];
  /** manifest rows with an extension of no known kind (left out) */
  skipped: string[];
  /** `assets.boot` patterns that matched no entry */
  unmatchedBoot: string[];
}

/** `/cdn/x.png` | `cdn/x.png` → `x.png` */
export const cdnName = (ref: string): string => ref.replace(/^\/?cdn\//, '');
export const assetHash = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');

const globRe = (pattern: string): RegExp => new RegExp(`^${cdnName(pattern).replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('*', '[^/]*')}$`);

/** The flat index of one export's manifest over the files in `cdnDir`. Pure apart from reading the file sizes. */
export function buildAssetIndex(manifest: unknown, o: { cdnDir: string; boot?: readonly string[]; origin?: string; replace?: Readonly<Record<string, { file: string; b: number; ob: number; x: string }>> }): AssetIndexBuild {
  if (!Array.isArray(manifest)) throw new Error('asset-manifest.json: expected an array of rows');
  const boot = (o.boot ?? []).map((p) => ({ p, re: globRe(p), hit: false }));
  const entries: Record<string, FlatEntry> = {};
  const missing: string[] = [];
  const skipped: string[] = [];
  for (const row of manifest) {
    const ref = (row as { reference?: unknown } | null)?.reference;
    if (typeof ref !== 'string' || !/^\/?cdn\//.test(ref)) continue;
    const name = cdnName(ref);
    if (/[\\:\x00-\x1f?#]/.test(name) || name.split('/').some((s) => s === '' || s === '.' || s === '..')) throw new Error(`asset-manifest.json: unsafe CDN reference ${ref}`);
    if (Object.hasOwn(entries, name)) continue;
    const x = (/\.([A-Za-z0-9]+)$/.exec(name)?.[1] ?? '').toLowerCase();
    const k = KIND_BY_EXT[x];
    if (k === undefined) {
      skipped.push(name);
      continue;
    }
    const file = join(o.cdnDir, name);
    const present = existsSync(file);
    const checksum = (row as { sha256?: unknown }).sha256;
    if (present && typeof checksum === 'string' && /^[a-f0-9]{64}$/i.test(checksum) && assetHash(file) !== checksum.toLowerCase()) throw new Error(`asset-manifest.json: SHA-256 mismatch for ${name}`);
    const inBoot = boot.filter((b) => b.re.test(name));
    for (const b of inBoot) b.hit = true;
    const g = [inBoot.length > 0 ? BOOT_GROUP : LAZY_GROUP];
    const rp = o.replace?.[name];
    if (rp) entries[name] = { u: `assets/cdn/${rp.file}`, b: rp.b, k, x: rp.x, g, ob: rp.ob };
    else if (present) entries[name] = { u: `assets/cdn/${name}`, b: statSync(file).size, k, x, g };
    else {
      missing.push(name);
      entries[name] = { u: null, b: 0, k, x, g, s: 1 };
    }
  }
  const sorted: Record<string, FlatEntry> = {};
  const groups: FlatAssetIndex['groups'] = {};
  for (const name of Object.keys(entries).sort()) {
    const e = entries[name]!;
    sorted[name] = e;
    if (e.u === null) continue;
    for (const key of e.g) {
      const grp = (groups[key] ??= { n: [], b: 0 });
      grp.n.push(name);
      grp.b += e.b;
    }
  }
  return {
    index: { v: 1, build: 'flat-1', origin: o.origin ?? '', entries: sorted, groups, facts: {} },
    missing,
    skipped,
    unmatchedBoot: boot.filter((b) => !b.hit).map((b) => b.p),
  };
}

export interface AssetsBuildOptions {
  /** the export root (holds asset-manifest.json and assets/cdn); default config `assets.export`, else the parent of `source.dir` */
  exportDir?: string;
  /** default `<gameDir>/asset-index.json` */
  out?: string;
  /** with `assets.images`: where the recompressed and passed-through files go; default `<gameDir>/.cache/assets/cdn` */
  outDir?: string;
}

export interface AssetsBuildOutcome extends AssetIndexBuild {
  file: string;
  /** the folder the plugin serves: the export's assets/cdn, or the compress output folder */
  cdnDir: string;
  /** with `assets.images`: byte totals of the recompressed raster images (all raster images, recompressed or kept) */
  compressed?: { outDir: string; files: number; cached: number; originalBytes: number; outputBytes: number };
}

/** The game's `assets` config (standalone.config): `{ export?: string; boot?: string[] }` */
export interface AssetsConfig {
  export?: string;
  manifest?: string;
  cdn?: string;
  boot?: string[];
  images?: ImagesConfig;
  /** where `images` output goes; default `.cache/assets/cdn` under the game dir */
  outDir?: string;
  /** passthrough: audio ships as it is (no transcode yet) */
  audio?: Record<string, unknown>;
}

export async function assetInputs(gameDir: string, opts: AssetsBuildOptions = {}): Promise<{ cfg: AssetsConfig; manifestFile: string; cdnDir: string; origin: string; file: string }> {
  const { config } = await loadGameConfig(gameDir);
  const cfg = (typeof config['assets'] === 'object' && config['assets'] !== null ? config['assets'] : {}) as AssetsConfig;
  const exportDir = resolve(gameDir, opts.exportDir ?? cfg.export ?? dirname(config.source.dir));
  const manifestFile = opts.exportDir ? join(exportDir, 'asset-manifest.json') : resolve(gameDir, cfg.manifest ?? join(exportDir, 'asset-manifest.json'));
  if (!existsSync(manifestFile)) throw new Error(`assets: no asset-manifest.json at ${manifestFile}`);
  const cdnDir = opts.exportDir ? join(exportDir, 'assets/cdn') : resolve(gameDir, cfg.cdn ?? join(exportDir, 'assets/cdn'));
  const file = resolve(gameDir, opts.out ?? 'asset-index.json');
  return { cfg, manifestFile, cdnDir, file, origin: config.source.commit ?? '' };
}

export async function runAssetsBuild(gameDir: string, opts: AssetsBuildOptions = {}): Promise<AssetsBuildOutcome> {
  const { cfg, manifestFile, cdnDir, file, origin } = await assetInputs(gameDir, opts);
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8')) as unknown;
  const base = { ...(cfg.boot ? { boot: cfg.boot } : {}), origin };
  let built = buildAssetIndex(manifest, { cdnDir, ...base });
  const sourceHashes = Object.fromEntries(Object.entries(built.index.entries).filter(([, e]) => e.u !== null).map(([n]) => [n, assetHash(join(cdnDir, n))]));
  let servedDir = cdnDir;
  let compressed: AssetsBuildOutcome['compressed'];
  if (cfg.images) {
    const outDir = resolve(gameDir, opts.outDir ?? cfg.outDir ?? join('.cache', 'assets', 'cdn'));
    const present = Object.entries(built.index.entries).filter(([, e]) => e.u !== null).map(([n]) => n);
    const r = await compressAssets(present, { srcDir: cdnDir, outDir, images: cfg.images });
    built = buildAssetIndex(manifest, { cdnDir, ...base, replace: r.files });
    servedDir = outDir;
    compressed = { outDir, files: Object.keys(r.files).length, cached: r.skippedCached, originalBytes: r.originalBytes, outputBytes: r.outputBytes };
  }
  const toRel = (d: string): string => relative(resolve(gameDir), d).split(sep).join('/');
  const fileHashes = Object.fromEntries(Object.entries(built.index.entries).filter(([, e]) => e.u !== null).map(([n, e]) => [n, assetHash(join(servedDir, e.u!.slice('assets/cdn/'.length)))]));
  const sidecar = { ...built.index, cdnDir: toRel(servedDir), sourceHashes, fileHashes, ...(compressed ? { sourceCdnDir: toRel(cdnDir) } : {}) };
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(sidecar, null, 1)}
`);
  return { ...built, file, cdnDir: servedDir, ...(compressed ? { compressed } : {}) };
}

export function assetsSummary(o: AssetsBuildOutcome): string {
  const n = Object.keys(o.index.entries).length;
  const boot = o.index.groups[BOOT_GROUP]?.n.length ?? 0;
  const parts = [`assets build: ${o.file}: ${n} entries (${boot} boot, ${n - boot - o.missing.length} lazy, ${o.missing.length} silent)`];
  if (o.compressed) parts.push(`  images: ${o.compressed.originalBytes} -> ${o.compressed.outputBytes} bytes (${o.compressed.files} recompressed, ${o.compressed.cached} cached) in ${o.compressed.outDir}`);
  if (o.skipped.length) parts.push(`  skipped (unknown kind): ${o.skipped.join(', ')}`);
  if (o.unmatchedBoot.length) parts.push(`  boot patterns that matched nothing: ${o.unmatchedBoot.join(', ')}`);
  return parts.join('\n');
}
