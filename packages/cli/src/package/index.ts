// `spawn-standalone package --target playgama`: build, zip, budgets, licences, the offline PG checks, covers, release manifest.
export { buildGame, packageGame, runPackage, type PackageOptions, type PackageOutcome, type PackageTarget } from './command.ts';
export { DEFAULT_BUDGETS, DEFAULT_SHOTS, resolvePackageConfig, type AdPlacement, type BudgetOptions, type CoverOptions, type CoverShot, type CreditRow, type Orientation, type PlaygamaGameOptions, type ResolvedPackageConfig } from './config.ts';
export { BRIDGE_CONFIG_JSON, buildBridgeConfig, bridgeConfigText, deepMerge } from './bridge-config.ts';
export { checkBudgets, formatBudgets, globToRegExp, initialSet, type BudgetReport, type BudgetRow } from './budgets.ts';
export { captureCovers, checkCovers, COVER_SPECS, imageSize, MAX_COVER_BYTES, serveDir, SWIFTSHADER_ARGS, type CoverImage, type CoversOutcome, type RuntimeProbe } from './covers.ts';
export { readDist, scanPathNames, scanRootAbsolute, type Dist, type DistFile, type Finding } from './dist.ts';
export { buildThirdParty, collectLicences, THIRD_PARTY_TXT, type LicenceEntry } from './licences.ts';
export { ALLOWED_URLS, BRIDGE_CDN, BRIDGE_JS, bridgeVersionOf, checkPlaygamaArchive, formatPgReport, readArchive, versionAtLeast, type ArchiveEntry, type PgCheck, type PgContext, type PgFinding, type PgReport } from './playgama-check.ts';
export { isStored, writeZip, type ZipEntry, type ZipSummary } from './zip.ts';
