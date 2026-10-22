import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GameConfig } from './config.ts';
import { sha256, TOOL_VERSION } from './pipeline.ts';

export const LOCK_FILE = 'standalone.lock.json';

/** Lock the source, engine docs and local runtime revision along with the imported bytes. */
export function lockText(config: GameConfig, gameDir: string, files: { path: string; sha256: string }[] = []): string {
  const runtime = JSON.parse(readFileSync(new URL(import.meta.resolve('@spawn-standalone/runtime/package.json')), 'utf8'));
  const runtimeCommit: string | null = runtime.releaseRevision ?? null;
  const docs = config.engine?.docs;
  const reference = docs ? resolve(gameDir, docs, 'api-reference.md') : null;
  const referenceSha = reference && existsSync(reference) ? sha256(readFileSync(reference)) : null;
  const docsSha = config.engine?.docsSha ?? referenceSha;
  return JSON.stringify({
    version: 1,
    sourceCommit: config.source.commit ?? 'folder',
    engine: { semver: config.engine?.semver ?? null, docsSha, referenceSha },
    runtimeCommit,
    runtimeVersion: runtime.version,
    converterVersion: TOOL_VERSION,
    files: Object.fromEntries(files.map((f) => [f.path, f.sha256])),
  }, null, 2) + '\n';
}
