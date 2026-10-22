// `spawn-standalone package [<game-dir>] --target playgama [--out <dir>] [--no-covers] [--json]`: build the game (vite, mode
// playgama, base './', the Playgama Bridge plugin added when the game's config lacks it), write playgama-bridge-config.json and
// THIRD_PARTY.txt into the dist, zip it (deterministic, index.html at the root), check the budgets and the offline PG set,
// capture the covers, and write a release manifest. Nothing is uploaded or submitted.
//
//   <out>/dist/                         the built page (what the zip holds)
//   <out>/<slug>-<version>-playgama.zip the archive
//   <out>/playgama-check.{json,txt}     the PG report
//   <out>/covers/, <out>/screenshots/   the captures
//   <out>/release.json                  the release manifest
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync, writeSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { loadGameConfig } from '../import/config.ts';
import { runBuild } from '../build.ts';
import { BRIDGE_CONFIG_JSON, buildBridgeConfig, bridgeConfigText } from './bridge-config.ts';
import { checkBudgets, formatBudgets, type BudgetReport } from './budgets.ts';
import { resolvePackageConfig, type ResolvedPackageConfig } from './config.ts';
import { captureCovers, type CoversOutcome } from './covers.ts';
import { readBytes, readDist } from './dist.ts';
import { buildThirdParty, collectLicences, THIRD_PARTY_TXT } from './licences.ts';
import { bridgeVersionOf, BRIDGE_JS, checkPlaygamaArchive, formatPgReport, readArchive, type PgCheck, type PgReport } from './playgama-check.ts';
import { writeZip } from './zip.ts';

export type PackageTarget = 'playgama';

export interface PackageOptions {
  gameDir: string;
  target: PackageTarget;
  /** output directory (default `<gameDir>/package/playgama`) */
  out?: string;
  /** capture the covers (default true) */
  covers?: boolean;
  /** skip the vite build and package an existing `<out>/dist` (tests) */
  skipBuild?: boolean;
  logLevel?: 'info' | 'warn' | 'error' | 'silent';
}

export interface PackageOutcome {
  ok: boolean;
  out: string;
  distDir: string;
  zipPath: string;
  zipBytes: number;
  zipSha256: string;
  report: PgReport;
  budgets: BudgetReport;
  covers: CoversOutcome | null;
  manifestPath: string;
  notes: string[];
}

const fwd = (p: string): string => p.replaceAll('\\', '/');
/** `vite build --mode playgama` of the game into `outDir`, with base './' and the Bridge plugin (cdn mode) when missing. */
export async function buildGame(gameDir: string, outDir: string, logLevel: PackageOptions['logLevel'] = 'warn'): Promise<string[]> {
  await runBuild(gameDir, { target: 'playgama', out: outDir, logLevel });
  return [];
}

const sha256 = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

/** the runtime probe of the capture run as a check (only when covers ran) */
function probeCheck(c: CoversOutcome): PgCheck {
  const findings = [
    ...c.probe.blockedRequests.map((u) => ({ message: `the page requested ${u} (blocked)` })),
    ...(c.probe.bridgePresent ? [] : [{ message: 'window.bridge is absent at the cover shot' }]),
    ...(c.probe.bridgePresent && !c.probe.bridgeInitialized ? [{ message: 'bridge.isInitialized is false at the cover shot (initialise before gameplay)' }] : []),
    ...c.probe.pageErrors.map((e) => ({ message: `page error: ${e}` })),
  ];
  const evidence = [
    `bridge present ${c.probe.bridgePresent}, initialised ${c.probe.bridgeInitialized}`,
    `${c.probe.blockedRequests.length} external request(s)`,
    ...(c.probe.consoleErrors.length > 0 ? [`console errors (not failing): ${c.probe.consoleErrors.slice(0, 3).join(' | ')}`] : []),
  ];
  // only the CDN Bridge tag may try the network: it is blocked, and the local fallback loads
  const real = findings.filter((f) => !f.message.includes('bridge.playgama.com'));
  return { id: 'PG-R1', name: 'runtime-probe', status: real.length === 0 ? 'pass' : 'fail', evidence, findings: real };
}

function coverCheck(c: CoversOutcome): PgCheck {
  return {
    id: 'PG-C1',
    name: 'covers',
    status: c.findings.length === 0 ? 'pass' : 'fail',
    evidence: c.covers.map((x) => `${x.file} ${x.width}×${x.height} ${x.bytes} B`),
    findings: c.findings.map((f) => ({ file: f.file, message: f.message })),
  };
}

export async function packageGame(o: PackageOptions): Promise<PackageOutcome> {
  if (o.target !== 'playgama') throw new Error(`package: unknown target "${String(o.target)}" (only playgama)`);
  const gameDir = fwd(resolve(o.gameDir));
  const { config } = await loadGameConfig(gameDir);
  const cfg: ResolvedPackageConfig = resolvePackageConfig(config);
  const out = fwd(o.out === undefined ? `${gameDir}/package/playgama` : isAbsolute(o.out) ? o.out : resolve(o.out));
  const distDir = `${out}/dist`;
  mkdirSync(out, { recursive: true });
  const notes: string[] = [];
  if (!o.skipBuild) notes.push(...(await buildGame(gameDir, distDir, o.logLevel)));

  // the bridge config and the licences go into the dist before it is zipped
  if (existsSync(`${distDir}/${BRIDGE_CONFIG_JSON}`)) notes.push(`${BRIDGE_CONFIG_JSON} from the build replaced by the one generated from the game config`);
  writeFileSync(`${distDir}/${BRIDGE_CONFIG_JSON}`, bridgeConfigText(cfg));
  const pre = readDist(distDir);
  const licences = collectLicences(gameDir, cfg, pre.files.map((f) => f.path));
  writeFileSync(`${distDir}/${THIRD_PARTY_TXT}`, buildThirdParty(cfg, licences, cfg.credits));

  const dist = readDist(distDir);
  if (dist.excluded.length > 0) notes.push(`not shipped (build metadata): ${dist.excluded.map((f) => f.path).join(', ')}`);
  const zipPath = `${out}/${cfg.slug}-${cfg.version}-playgama.zip`;
  const fd = openSync(zipPath, 'w');
  let summary;
  try {
    summary = writeZip(
      dist.files.map((f) => ({ path: f.path, read: () => readBytes(f) })),
      (chunk) => void writeSync(fd, chunk),
    );
  } finally {
    closeSync(fd);
  }
  const textOf = (p: string): string => readFileSync(dist.byPath.get(p)!.abs, 'utf8');
  const budgets = checkBudgets(dist, summary.bytes, cfg, textOf);
  const archive = readArchive(zipPath);
  const report = checkPlaygamaArchive(archive.entries, archive.zipBytes, {
    expectedBridgeConfig: buildBridgeConfig(cfg),
    orientations: cfg.orientations,
    allowUrls: cfg.allowUrls,
    testHooks: cfg.testHooks,
    budgets,
    waive: cfg.waive,
    extraChecks: cfg.extraChecks,
  });

  let covers: CoversOutcome | null = null;
  if (o.covers !== false) {
    covers = await captureCovers({ distDir, outDir: out, gameDir, cfg });
    report.checks.push(probeCheck(covers), coverCheck(covers));
    report.status = report.checks.every((c) => c.status !== 'fail') ? 'pass' : 'fail';
  }
  writeFileSync(`${out}/playgama-check.json`, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(`${out}/playgama-check.txt`, `${formatPgReport(report)}\n${formatBudgets(budgets)}\n`);

  const bridgeFile = dist.byPath.get(BRIDGE_JS);
  const manifest = {
    game: { name: cfg.name, slug: cfg.slug, version: cfg.version, sourceCommit: cfg.sourceCommit },
    target: 'playgama',
    build: { mode: 'playgama', base: './', bridgeVersion: bridgeFile ? bridgeVersionOf(readFileSync(bridgeFile.abs, 'utf8')) : null },
    zip: { file: zipPath.slice(out.length + 1), bytes: summary.bytes, sha256: summary.sha256, entries: summary.entries.length },
    ads: { interstitial: cfg.interstitial, rewarded: cfg.rewarded, minimumDelayBetweenInterstitial: cfg.minimumDelayBetweenInterstitial, initialInterstitialDelay: cfg.initialInterstitialDelay },
    orientations: cfg.orientations,
    budgets: budgets.rows.map(({ detail: _d, ...r }) => r),
    initialFiles: budgets.initial,
    licences: licences.map((l) => ({ name: l.name, version: l.version, licence: l.licence })),
    checks: { status: report.status, results: report.checks.map((c) => ({ id: c.id, name: c.name, status: c.status })) },
    covers: covers?.covers ?? null,
    files: dist.files.map((f) => ({ path: f.path, size: f.size, sha256: sha256(readBytes(f)) })),
  };
  const manifestPath = `${out}/release.json`;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { ok: report.status === 'pass', out, distDir, zipPath, zipBytes: summary.bytes, zipSha256: summary.sha256, report, budgets, covers, manifestPath, notes };
}

const USAGE = 'usage: spawn-standalone package [<game-dir>] --target playgama [--out <dir>] [--no-covers] [--json]';

/** the `package` command: argv after the command name; resolves to the exit code */
async function packageCli(argv: readonly string[]): Promise<number> {
  let dir: string | undefined;
  let target: string | undefined;
  let out: string | undefined;
  let covers = true;
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--target' || a === '--out') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) {
        console.error(`${a} needs a value\n${USAGE}`);
        return 2;
      }
      if (a === '--target') target = v;
      else out = v;
    } else if (a === '--no-covers') covers = false;
    else if (a === '--json') json = true;
    else if (a === '--help' || a === '-h') {
      console.log(USAGE);
      return 0;
    } else if (a.startsWith('--')) {
      console.error(`unknown option: ${a}\n${USAGE}`);
      return 2;
    } else if (dir === undefined) dir = a;
    else {
      console.error(`unexpected argument: ${a}\n${USAGE}`);
      return 2;
    }
  }
  if (target !== 'playgama') {
    console.error(`${target === undefined ? '--target is required' : `unknown target: ${target}`}\n${USAGE}`);
    return 2;
  }
  try {
    const r = await packageGame({ gameDir: dir ?? process.cwd(), target, covers, ...(out !== undefined ? { out } : {}) });
    if (json) process.stdout.write(`${JSON.stringify(r.report, null, 2)}\n`);
    else console.log(`${formatPgReport(r.report)}\n${formatBudgets(r.budgets)}`);
    for (const n of r.notes) console.error(`note: ${n}`);
    console.error(`package: ${r.zipPath} (${r.zipBytes} B, sha256 ${r.zipSha256}); manifest ${r.manifestPath}`);
    return r.ok ? 0 : 1;
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }
}

/**
 * `runPackage(argv)` is the CLI command (argv after `package`; resolves to the exit code). `runPackage({ gameDir, target, out })`
 * packages a game and resolves to the outcome.
 */
export function runPackage(argv: readonly string[]): Promise<number>;
export function runPackage(options: PackageOptions): Promise<PackageOutcome>;
export function runPackage(arg: readonly string[] | PackageOptions): Promise<number | PackageOutcome> {
  return Array.isArray(arg) ? packageCli(arg) : packageGame(arg as PackageOptions);
}
