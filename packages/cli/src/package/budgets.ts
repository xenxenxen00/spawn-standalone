// Size budgets of a package: total and initial bytes, the file count and per-file caps, all from the game config with sane
// defaults (config.ts DEFAULT_BUDGETS). PP's tools/package/budgets.ts gated PP's own asset groups (its group caps stay there);
// this is the game-agnostic part: the page's initial load set is found by reading index.html and following static imports.
import { posix } from 'node:path';
import { isCss, isHtml, isJs, type Dist } from './dist.ts';
import type { ResolvedPackageConfig } from './config.ts';

export interface BudgetRow {
  id: 'total' | 'initial' | 'zip' | 'files' | 'per-file';
  limit: number;
  actual: number;
  status: 'pass' | 'fail';
  detail?: string[];
}

export interface BudgetReport {
  status: 'pass' | 'fail';
  rows: BudgetRow[];
  /** the files index.html loads before the game runs */
  initial: string[];
}

/** `*` within a segment, `**` across segments, `?` one character */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*';
      i++;
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

const relOf = (from: string, ref: string): string | null => {
  const clean = ref.replace(/[?#].*$/, '');
  if (clean === '' || /^(?:[a-z]+:)?\/\//i.test(clean) || clean.startsWith('data:') || clean.startsWith('/')) return null;
  return posix.normalize(posix.join(posix.dirname(from), clean));
};

/** The page's initial load set: index.html, its scripts, stylesheets and modulepreloads, and their static imports. */
export function initialSet(dist: Dist, readText: (path: string) => string): string[] {
  const seen = new Set<string>();
  const queue: string[] = ['index.html'];
  while (queue.length > 0) {
    const p = queue.shift()!;
    if (seen.has(p) || !dist.byPath.has(p)) continue;
    seen.add(p);
    const text = readText(p);
    const refs: string[] = [];
    if (isHtml(p)) {
      for (const m of text.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)) refs.push(m[1]!);
      for (const m of text.matchAll(/<link\b[^>]*>/gi)) {
        if (!/\brel\s*=\s*["']?(?:stylesheet|modulepreload|preload)/i.test(m[0])) continue;
        const h = /\bhref\s*=\s*["']([^"']+)["']/i.exec(m[0]);
        if (h) refs.push(h[1]!);
      }
    } else if (isJs(p)) {
      for (const m of text.matchAll(/(?:^|[;}\s])(?:import|export)\s*(?:[\w$*{},\s]+from\s*)?["']([^"']+)["']/g)) refs.push(m[1]!);
    } else if (isCss(p)) {
      for (const m of text.matchAll(/@import\s+(?:url\()?["']?([^"')\s]+)/gi)) refs.push(m[1]!);
    }
    for (const r of refs) {
      const t = relOf(p, r);
      if (t !== null && !seen.has(t)) queue.push(t);
    }
  }
  return [...seen].sort();
}

export function checkBudgets(dist: Dist, zipBytes: number, cfg: ResolvedPackageConfig, readText: (path: string) => string): BudgetReport {
  const b = cfg.budgets;
  const rows: BudgetRow[] = [];
  const row = (id: BudgetRow['id'], limit: number, actual: number, detail?: string[]): void => {
    rows.push({ id, limit, actual, status: actual <= limit ? 'pass' : 'fail', ...(detail && detail.length > 0 ? { detail } : {}) });
  };
  const total = dist.files.reduce((s, f) => s + f.size, 0);
  row('total', b.totalBytes, total);
  const initial = initialSet(dist, readText);
  row('initial', b.initialBytes, initial.reduce((s, p) => s + (dist.byPath.get(p)?.size ?? 0), 0));
  row('zip', b.zipBytes, zipBytes);
  row('files', b.maxFiles, dist.files.length);
  const caps = b.perFile.map((c) => ({ re: globToRegExp(c.match), ...c }));
  const over: string[] = [];
  for (const f of dist.files) {
    const cap = caps.find((c) => c.re.test(f.path));
    const limit = cap?.bytes ?? b.maxFileBytes;
    if (f.size > limit) over.push(`${f.path}: ${f.size} B > ${limit} B${cap ? ` (${cap.match})` : ''}`);
  }
  rows.push({ id: 'per-file', limit: 0, actual: over.length, status: over.length === 0 ? 'pass' : 'fail', ...(over.length > 0 ? { detail: over } : {}) });
  return { status: rows.every((r) => r.status === 'pass') ? 'pass' : 'fail', rows, initial };
}

export function formatBudgets(r: BudgetReport): string {
  return r.rows
    .map((x) => (x.id === 'per-file' ? `${x.status.padEnd(5)} budget per-file: ${x.actual} file(s) over their cap` : `${x.status.padEnd(5)} budget ${x.id}: ${x.actual} / ${x.limit}`) + (x.detail ? `\n        ${x.detail.slice(0, 6).join('\n        ')}` : ''))
    .join('\n');
}
