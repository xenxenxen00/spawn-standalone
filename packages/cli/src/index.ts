// @spawn-standalone/cli: the converter CLI (coverage, import, assets, build, package for a Spawn game export).
// Node 24 executes the commands directly; library entries are available below.
export { scanJs } from './coverage/js-scan.ts';
export type { BuiltinImport, ChainUse, EmitUse, ExportFact, JsFacts, JsScanOptions, SpecKey } from './coverage/js-scan.ts';
export { keyLines, scanConfig } from './coverage/yaml-scan.ts';
export type { ConfigKey } from './coverage/yaml-scan.ts';
export { ManifestIndex } from './coverage/match.ts';
export { DEFAULT_SKIP_DIRS, scanTree } from './coverage/scan-tree.ts';
export type { ScanOptions, TreeScan, Usage } from './coverage/scan-tree.ts';
export { buildReport, normalizeUnknown, renderMarkdown, summaryLine } from './coverage/report.ts';
export type { Bucket, MatchedSurface, Report, Sample, Surface } from './coverage/report.ts';
export { runCoverage } from './coverage/command.ts';
export type { CoverageOptions } from './coverage/command.ts';
export * from './import/index.ts';
export { assetsSummary, BOOT_GROUP, buildAssetIndex, cdnName, KIND_BY_EXT, LAZY_GROUP, runAssetsBuild, type AssetIndexBuild, type AssetsBuildOptions, type AssetsBuildOutcome, type FlatAssetIndex, type FlatEntry } from './assets/build.ts';
export { compressAssets, maxSizeFor, type CompressResult, type ImagesConfig } from './assets/compress.ts';
export { runAssetsVerify } from './assets/check.ts';
export { gameViteConfig, runBuild, runDev, type BuildOptions, type BuildTarget } from './build.ts';
export { buildGame, packageGame, runPackage, type PackageOptions, type PackageOutcome, type PackageTarget } from './package/command.ts';
