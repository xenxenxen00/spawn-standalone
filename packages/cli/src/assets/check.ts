import { existsSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assetHash, assetInputs, buildAssetIndex, type AssetsBuildOptions, type FlatAssetIndex } from './build.ts';

/** Read-only verification of the manifest, original files and shipped bytes, including same-size changes. */
export async function runAssetsVerify(gameDir: string, options: AssetsBuildOptions = {}): Promise<{ ok: boolean; problems: string[] }> {
  const { cfg, manifestFile, cdnDir, file, origin } = await assetInputs(gameDir, options);
  if (!existsSync(file)) throw new Error(`assets verify: no ${file} (run assets build first)`);
  const current = JSON.parse(readFileSync(file, 'utf8')) as FlatAssetIndex & { cdnDir?: string; sourceHashes?: Record<string, string>; fileHashes?: Record<string, string> };
  const expected = buildAssetIndex(JSON.parse(readFileSync(manifestFile, 'utf8')), { cdnDir, origin, ...(cfg.boot ? { boot: cfg.boot } : {}) });
  const problems: string[] = [];
  if (current.v !== 1 || !current.entries || typeof current.cdnDir !== 'string') throw new Error(`assets verify: malformed ${file}`);
  if (current.origin !== origin) problems.push('source commit changed');
  for (const name of new Set([...Object.keys(expected.index.entries), ...Object.keys(current.entries)])) {
    const want = expected.index.entries[name];
    const have = current.entries[name];
    if (!want || !have) { problems.push(`${name}: manifest/index entry differs`); continue; }
    if (want.k !== have.k || JSON.stringify(want.g) !== JSON.stringify(have.g) || (want.u === null) !== (have.u === null)) problems.push(`${name}: kind, groups or availability changed`);
    if (want.u !== null && current.sourceHashes?.[name] !== assetHash(join(cdnDir, name))) problems.push(`${name}: source hash changed or missing`);
    if (have.u === null) continue;
    const rel = have.u.slice('assets/cdn/'.length);
    if (!have.u.startsWith('assets/cdn/') || /[\\:]/.test(rel) || rel.split('/').some((s) => !s || s === '.' || s === '..')) { problems.push(`${name}: unsafe output path`); continue; }
    const output = resolve(gameDir, current.cdnDir, rel);
    if (!existsSync(output) || statSync(output).size !== have.b || current.fileHashes?.[name] !== assetHash(output)) problems.push(`${name}: output missing or bytes changed`);
  }
  for (const p of expected.unmatchedBoot) problems.push(`boot pattern matched nothing: ${p}`);
  return { ok: problems.length === 0, problems };
}
