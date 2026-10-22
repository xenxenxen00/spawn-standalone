// THIRD_PARTY.txt of a package: every third-party component the build ships with its version and licence text, then the game's
// credits. After purge-protocol-web ebab692 tools/package/licences.ts, with its rules kept (a version or licence text is never
// typed here: both come from the installed package) and PP's fixed component table replaced by: the root `dependencies`,
// the game's `licences.packages`, and the vendored files the dist itself names (Basis transcoder, meshopt decoder, sql.js).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CreditRow, ResolvedPackageConfig } from './config.ts';

export const THIRD_PARTY_TXT = 'THIRD_PARTY.txt';

export interface LicenceEntry {
  name: string;
  version: string | null;
  licence: string;
  text: string | null;
  note?: string;
}

/** a dist file name that means a package's file ships, for packages a game does not list as a dependency */
const VENDORED: ReadonlyArray<{ test: RegExp; pkg: string; note: string }> = [
  { test: /(^|\/)playgama-bridge\.js$/, pkg: '@playgama/bridge', note: 'Playgama Bridge browser runtime copied from the installed package.' },
  { test: /(^|\/)sql-wasm[^/]*\.(wasm|js)$/, pkg: 'sql.js', note: 'SQLite compiled to WebAssembly (sql-wasm.wasm).' },
];

/** the Basis Universal transcoder ships inside the three package without a licence file of its own */
const BASIS = /(^|\/)basis_transcoder[^/]*\.(js|wasm)$/;
const MESHOPT = /(^|\/)meshopt_decoder[^/]*\.js$/;

/** node_modules/<pkg> above `from`, or null */
export function findPackageDir(from: string, pkg: string): string | null {
  let dir = resolve(from);
  for (;;) {
    const cand = join(dir, 'node_modules', pkg);
    if (existsSync(join(cand, 'package.json'))) return cand;
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

/** the repo (workspace) root above the game dir: the nearest package.json with `workspaces` */
export function findWorkspaceRoot(from: string): string | null {
  let dir = resolve(from);
  for (;;) {
    const pj = join(dir, 'package.json');
    if (existsSync(pj)) {
      try {
        if ((JSON.parse(readFileSync(pj, 'utf8')) as { workspaces?: unknown }).workspaces !== undefined) return dir;
      } catch {
        /* not JSON: keep walking */
      }
    }
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

function readPackage(from: string, pkg: string, note?: string): LicenceEntry {
  const dir = findPackageDir(from, pkg);
  if (dir === null) throw new Error(`licences: ${pkg} is not installed (needed for ${THIRD_PARTY_TXT})`);
  const pj = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string; license?: string };
  const file = readdirSync(dir).find((n) => /^(licen[cs]e|copying)(\.(md|txt))?$/i.test(n));
  return {
    name: pkg,
    version: pj.version ?? null,
    licence: pj.license ?? 'UNKNOWN',
    text: file ? readFileSync(join(dir, file), 'utf8').trim() : null,
    ...(note !== undefined ? { note } : {}),
  };
}

/** The components of a build: root dependencies, the game's extra packages, and vendored files found in the dist. */
export function collectLicences(gameDir: string, cfg: ResolvedPackageConfig, distPaths: readonly string[]): LicenceEntry[] {
  const root = findWorkspaceRoot(gameDir) ?? findWorkspaceRoot(import.meta.dirname) ?? gameDir;
  const names = new Set<string>();
  const notes = new Map<string, string>();
  const runtime = dirname(fileURLToPath(import.meta.resolve('@spawn-standalone/runtime/package.json')));
  for (const pjDir of [runtime, root, gameDir]) {
    const pj = join(pjDir, 'package.json');
    if (!existsSync(pj)) continue;
    const deps = (JSON.parse(readFileSync(pj, 'utf8')) as { dependencies?: Record<string, string> }).dependencies ?? {};
    for (const d of Object.keys(deps)) if (!d.startsWith('@spawn-standalone')) names.add(d);
  }
  for (const p of cfg.licencePackages) names.add(p);
  for (const v of VENDORED) {
    if (distPaths.some((p) => v.test.test(p))) {
      names.add(v.pkg);
      notes.set(v.pkg, v.note);
    }
  }
  const out = [...names].sort().map((n) => readPackage(findPackageDir(gameDir, n) ? gameDir : root, n, notes.get(n)));
  for (const entry of out) if (notes.has(entry.name) && !entry.text) throw new Error(`licences: redistributed ${entry.name} has no license text`);
  const threeDir = findPackageDir(import.meta.dirname, 'three');
  if (distPaths.some((p) => MESHOPT.test(p))) {
    if (!threeDir) throw new Error('licences: three is not installed');
    const decoder = readFileSync(join(threeDir, 'examples/jsm/libs/meshopt_decoder.module.js'), 'utf8');
    const header = decoder.match(/^(?:\/\/[^\r\n]*\r?\n)+/)?.[0]?.trim();
    const mit = readPackage(import.meta.dirname, 'three').text;
    const start = mit?.indexOf('Permission is hereby granted') ?? -1;
    if (!header || start < 0) throw new Error('licences: meshopt decoder attribution or MIT text is missing');
    out.push({ name: 'meshoptimizer decoder', version: decoder.match(/Built from meshoptimizer ([^\r\n]+)/)?.[1]?.trim() ?? null,
      licence: 'MIT', text: header + '\n\n' + mit!.slice(start), note: 'Copied unmodified from the three.js package; version and copyright come from the decoder header.' });
  }
  if (distPaths.some((p) => BASIS.test(p))) {
    if (!threeDir) throw new Error('licences: three is not installed');
    const apache = readPackage(import.meta.dirname, 'sharp').text;
    if (!apache?.includes('TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION') || !apache.includes('END OF TERMS AND CONDITIONS')) throw new Error('licences: standard Apache-2.0 text is missing');
    const basisReadme = readFileSync(join(threeDir, 'examples/jsm/libs/basis/README.md'), 'utf8').trim();
    out.push({
      name: 'Basis Universal transcoder',
      version: null,
      licence: 'Apache-2.0',
      text: basisReadme + '\n\n' + apache,
      note: 'basis_transcoder.js / .wasm copied unmodified from three.js. The supplied files have no copyright header; their supplied README identifies Apache-2.0. Standard license text is preserved below.',
    });
  }
  const runtimeLicence = readPackage(import.meta.dirname, '@spawn-standalone/runtime');
  if (!runtimeLicence.text) throw new Error('licences: redistributed runtime has no license text');
  runtimeLicence.text += '\n\n' + ['NOTICE', 'THIRD_PARTY_NOTICES.md'].map(name => readFileSync(join(runtime, name), 'utf8').trim()).join('\n\n');
  out.unshift(runtimeLicence);
  return out;
}

export function buildThirdParty(game: { name: string; version: string }, entries: readonly LicenceEntry[], credits: readonly CreditRow[]): string {
  const lines: string[] = [`${game.name} ${game.version}: third-party components and credits`, ''];
  lines.push('Components:');
  for (const e of entries) lines.push(`  - ${e.name}${e.version ? ` ${e.version}` : ''} (${e.licence})${e.note ? `: ${e.note}` : ''}`);
  lines.push('');
  if (credits.length > 0) {
    lines.push('Credits:');
    for (const c of credits) lines.push(`  - ${c.name}${c.author ? ` by ${c.author}` : ''}${c.licence ? ` (${c.licence})` : ''}${c.url ? ` ${c.url}` : ''}${c.note ? `: ${c.note}` : ''}`);
    lines.push('');
  }
  for (const e of entries) {
    lines.push('='.repeat(78), `${e.name}${e.version ? ` ${e.version}` : ''} (${e.licence})`, '='.repeat(78));
    lines.push(e.text ?? '(no licence file in the package; see the note above)', '');
  }
  return `${lines.join('\n').trimEnd()}\n`;
}
