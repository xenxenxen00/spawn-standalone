// `spawn-standalone coverage <source-dir>`: the library entry behind the command line.
import { readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { loadManifest, parseManifest, type CapabilityManifest } from '@spawn-standalone/runtime/capabilities';
import { buildReport, renderMarkdown, type Report } from './report.ts';
import { scanTree } from './scan-tree.ts';

export interface CoverageOptions {
  /** a manifest file to use instead of the one shipped with the runtime */
  manifestPath?: string;
  json?: boolean;
}

/** Scans `sourceDir` and returns the report plus its rendered text (markdown, or JSON with `json: true`). */
export function runCoverage(sourceDir: string, options: CoverageOptions = {}): { report: Report; text: string } {
  const dir = resolve(sourceDir);
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) throw new Error(`not a directory: ${sourceDir}`);
  const manifest: CapabilityManifest = options.manifestPath ? parseManifest(JSON.parse(readFileSync(options.manifestPath, 'utf8'))) : loadManifest();
  // an export folder is <game>/source; name the report after the game when it is
  const name = basename(dir) === 'source' ? basename(resolve(dir, '..')) : basename(dir);
  const report = buildReport(name, scanTree(dir), manifest);
  return { report, text: options.json ? JSON.stringify(report, null, 2) + '\n' : renderMarkdown(report) };
}
