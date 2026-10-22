// Walks a Spawn game source tree and lists every engine-surface usage it finds.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { CapabilityKind } from '@spawn-standalone/runtime/capabilities';
import { scanJs } from './js-scan.ts';
import { scanConfig } from './yaml-scan.ts';

export interface Usage {
  kind: CapabilityKind;
  /** the manifest-style id: `ctx.self.state.hp`, `builtin/math.lerp`, `act:squash`, `hook:update`, `config:gravity`, `spec:physics` */
  id: string;
  /** a literal value that can refine the match (`linear` for `config:atmosphere.fog.kind`) */
  value?: string;
  /** how to name the usage when no manifest entry matches */
  label?: string;
  /** an emit whose topic is not a literal */
  dynamic?: boolean;
  /** path relative to the scanned directory, with `/` separators */
  file: string;
  line: number;
}

export interface TreeScan {
  usages: Usage[];
  jsFiles: number;
  yamlFiles: number;
  warnings: string[];
}

export const DEFAULT_SKIP_DIRS: readonly string[] = ['.spawn', '.git', 'docs', 'node_modules'];

export interface ScanOptions {
  skipDirs?: readonly string[];
}

function listFiles(root: string, skip: ReadonlySet<string>): string[] {
  const out: string[] = [];
  const walkDir = (dir: string): void => {
    const names = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of names) {
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        if (!skip.has(e.name)) walkDir(path);
      } else if (e.isFile()) out.push(path);
    }
  };
  walkDir(root);
  return out;
}

const isConfig = (rel: string): boolean => rel === 'world.config.yaml' || rel === 'world.config.yml' || /^places\/[^/]+\/config\.ya?ml$/.test(rel);

export function scanTree(dir: string, options: ScanOptions = {}): TreeScan {
  const skip = new Set(options.skipDirs ?? DEFAULT_SKIP_DIRS);
  const scan: TreeScan = { usages: [], jsFiles: 0, yamlFiles: 0, warnings: [] };
  for (const path of listFiles(dir, skip)) {
    const rel = relative(dir, path).split(sep).join('/');
    if (rel.endsWith('.js')) {
      scan.jsFiles++;
      let facts;
      try {
        facts = scanJs(readFileSync(path, 'utf8'), { isTemplate: rel.startsWith('templates/') });
      } catch (err) {
        scan.warnings.push(`${rel}: not parsed (${err instanceof Error ? err.message : String(err)})`);
        continue;
      }
      const push = (u: Omit<Usage, 'file'>): void => void scan.usages.push({ ...u, file: rel });
      // a custom job module: the engine runs it when a behavior calls ctx.job('<id>', ...)
      if (/^jobs\/[^/]+\.js$/.test(rel)) push({ kind: 'hook', id: 'hook:job-module', line: 1 });
      for (const c of facts.chains) {
        if (c.viaResult) push({ kind: 'ctx', id: `ctx.self.${c.path.join('.')}`, label: `ctx.getObject().${c.path.join('.')}`, line: c.line });
        else push({ kind: 'ctx', id: `ctx.${c.path.join('.')}`, line: c.line });
      }
      for (const e of facts.emits) {
        if (e.topic === null) push({ kind: 'act', id: 'act:(dynamic topic)', dynamic: true, line: e.line });
        else push({ kind: 'act', id: `act:${e.topic}`, line: e.line });
      }
      for (const i of facts.imports) push({ kind: 'builtin', id: i.name === null ? i.module : `${i.module}.${i.name}`, line: i.line });
      for (const x of facts.exports) {
        if (x.name === 'default') continue;
        push({ kind: 'hook', id: `hook:${x.name}`, ...(x.value !== undefined ? { value: x.value } : {}), line: x.line });
      }
      for (const s of facts.specs) push({ kind: 'spec', id: `spec:${s.path}`, ...(s.value !== undefined ? { value: s.value } : {}), line: s.line });
    } else if (rel.endsWith('.yaml') || rel.endsWith('.yml')) {
      if (!isConfig(rel)) continue;
      scan.yamlFiles++;
      try {
        for (const k of scanConfig(readFileSync(path, 'utf8'))) {
          scan.usages.push({ kind: 'config', id: `config:${k.path}`, ...(k.value !== undefined ? { value: k.value } : {}), file: rel, line: k.line });
        }
      } catch (err) {
        scan.warnings.push(`${rel}: not parsed (${err instanceof Error ? err.message : String(err)})`);
      }
    }
  }
  return scan;
}
