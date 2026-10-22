import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Resolve dependencies using the same ESM import condition as the installed runtime. */
export function dependencyPaths(metadataPath: string, dependencies: string[]): { name: string; path: string }[] {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    'console.log(JSON.stringify(JSON.parse(process.argv[1]).map(name => ({ name, url: import.meta.resolve(name) }))))',
    JSON.stringify(dependencies)], { cwd: dirname(metadataPath), encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  const entries = JSON.parse(result.stdout) as { name: string; url: string }[];
  return entries.map(({ name, url }) => ({ name, path: realpathSync(fileURLToPath(url)) }));
}
