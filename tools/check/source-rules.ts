// Layering rules for the monorepo, run by `npm run lint`.
// packages/** never import games/**; packages/runtime/** never imports a `virtual:` module
// (only packages/vite produces those). Imports are found by a line regex over .ts files.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { publicNamespaceIssue } from './public-boundary.ts';

const ROOT = resolve(import.meta.dirname, '..', '..');
const IMPORT_RE = /\b(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)|^\s*import\s*['"]([^'"]+)['"]/gm;

function* tsFiles(dir: string): Generator<string> {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (name === 'node_modules' || name === 'dist' || name.startsWith('.')) continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) yield* tsFiles(path);
    else if (/\.(ts|css)$/.test(name)) yield path;
  }
}

const rel = (path: string): string => relative(ROOT, path).split(sep).join('/');
const problems: string[] = [];

for (const file of tsFiles(join(ROOT, 'packages'))) {
  const text = readFileSync(file, 'utf8');
  const from = rel(file);
  if (from.startsWith('packages/runtime/src/') && !from.includes('/legacy/') && publicNamespaceIssue(text)) {
    problems.push(`${from}: public runtime uses a legacy namespace`);
  }
  for (const match of text.matchAll(IMPORT_RE)) {
    const spec = match[1] ?? match[2] ?? match[3] ?? '';
    const line = text.slice(0, match.index).split('\n').length;
    const target = spec.startsWith('.') ? rel(resolve(file, '..', spec)) : spec;
    if (target.startsWith('games/')) problems.push(`${from}:${line} packages-no-games: imports ${spec}`);
    if (from.startsWith('packages/runtime/src/') && !from.includes('/legacy/') && spec.startsWith('virtual:')) {
      problems.push(`${from}:${line} runtime-no-virtual: imports ${spec}`);
    }
  }
}

if (problems.length > 0) {
  console.error(problems.join('\n'));
  console.error(`source rules: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log('source rules: ok');
