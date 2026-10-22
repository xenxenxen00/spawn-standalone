// Copied from purge-protocol-web ebab692 tools/import-live/copy.ts.
// Syncing the staged tree into game/ and the byte comparison of --check (build §4.1 steps 4 and 6).
import { mkdirSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** every file under `root`, repo-style relative paths (forward slashes), sorted */
export function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const abs = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      if (statSync(abs).isDirectory()) walk(abs, r);
      else out.push(r);
    }
  };
  walk(root, '');
  return out.sort();
}

const removeEmptyDirs = (root: string, rel: string): void => {
  let dir = dirname(join(root, rel));
  while (dir.length > root.length) {
    try {
      if (readdirSync(dir).length > 0) return;
      rmdirSync(dir);
    } catch {
      return;
    }
    dir = dirname(dir);
  }
};

/** Writes changed files, deletes files that are not in `tree`. Returns what changed (relative paths). */
export function syncTree(outDir: string, tree: ReadonlyMap<string, Buffer>): { written: string[]; removed: string[] } {
  const written: string[] = [];
  const removed: string[] = [];
  for (const rel of listFiles(outDir)) {
    if (!tree.has(rel)) {
      unlinkSync(join(outDir, rel));
      removeEmptyDirs(outDir, rel);
      removed.push(rel);
    }
  }
  for (const [rel, bytes] of [...tree].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const abs = join(outDir, rel);
    let same = false;
    try {
      same = readFileSync(abs).equals(bytes);
    } catch {
      same = false;
    }
    if (same) continue;
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, bytes);
    written.push(rel);
  }
  return { written, removed };
}

/** Byte comparison of `outDir` with `tree`: `missing <p>`, `changed <p>`, `extra <p>` lines (empty = identical). */
export function compareTree(outDir: string, tree: ReadonlyMap<string, Buffer>): string[] {
  const diffs: string[] = [];
  const have = new Set(listFiles(outDir));
  for (const [rel, bytes] of tree) {
    if (!have.has(rel)) diffs.push(`missing ${rel}`);
    else if (!readFileSync(join(outDir, rel)).equals(bytes)) diffs.push(`changed ${rel}`);
  }
  for (const rel of have) if (!tree.has(rel)) diffs.push(`extra ${rel}`);
  return diffs.sort();
}
