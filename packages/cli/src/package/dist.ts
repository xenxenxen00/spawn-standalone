// The dist/ model of a `vite build` output and the generic text scanners, from purge-protocol-web ebab692
// tools/package/scan.ts (readDist, LineIndex, findAll, scanPathNames, the root-absolute URL scan). PP's KF2 denylist, its
// last-shot scan and its `/cdn/` asset-name exemption are left out.
import { readdirSync, readFileSync, statSync } from 'node:fs';

export interface Finding {
  rule: string;
  file: string;
  line?: number;
  column?: number;
  excerpt?: string;
  message?: string;
}

export interface DistFile {
  /** posix path relative to the dist root; this is the zip entry name */
  path: string;
  size: number;
  /** absolute `C:/…` path */
  abs: string;
}

export interface Dist {
  root: string;
  /** shipped files, sorted by path (byte order) */
  files: DistFile[];
  /** build metadata that is not shipped: `.vite/**`, `*.map` */
  excluded: DistFile[];
  byPath: ReadonlyMap<string, DistFile>;
}

/** Source maps and `.vite/` (the chunk manifest) are never loaded by the page. */
export const isBuildMetadata = (path: string): boolean => path.startsWith('.vite/') || /\.map$/i.test(path);

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function readDist(root: string): Dist {
  const base = root.replaceAll('\\', '/').replace(/\/+$/, '');
  const files: DistFile[] = [];
  const excluded: DistFile[] = [];
  const walk = (rel: string): void => {
    for (const ent of readdirSync(rel === '' ? base : `${base}/${rel}`, { withFileTypes: true })) {
      const path = rel === '' ? ent.name : `${rel}/${ent.name}`;
      if (ent.isDirectory()) walk(path);
      else if (ent.isFile()) {
        const abs = `${base}/${path}`;
        const f: DistFile = { path, size: statSync(abs).size, abs };
        (isBuildMetadata(path) ? excluded : files).push(f);
      }
    }
  };
  walk('');
  files.sort((a, b) => cmp(a.path, b.path));
  excluded.sort((a, b) => cmp(a.path, b.path));
  return { root: base, files, excluded, byPath: new Map(files.map((f) => [f.path, f])) };
}

export const readBytes = (f: DistFile): Uint8Array => readFileSync(f.abs);

/** Files whose content the text gates read. Binary types (glb, ktx2, mp3, webp, wasm, …) are judged by name and size only. */
export const TEXT_FILE = /\.(html?|css|m?js|cjs|json|svg|txt|xml|webmanifest|ya?ml|md)$/i;
export const isJs = (path: string): boolean => /\.(m?js|cjs)$/i.test(path);
export const isHtml = (path: string): boolean => /\.html?$/i.test(path);
export const isCss = (path: string): boolean => /\.css$/i.test(path);

/** Line starts of a text, for 1-based line/column lookups of many hits. */
export class LineIndex {
  private readonly starts: number[] = [0];
  constructor(text: string) {
    for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) this.starts.push(i + 1);
  }
  at(index: number): { line: number; column: number } {
    let lo = 0;
    let hi = this.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.starts[mid]! <= index) lo = mid;
      else hi = mid - 1;
    }
    return { line: lo + 1, column: index - this.starts[lo]! + 1 };
  }
}

export function excerptAt(text: string, index: number, length: number, pad = 40): string {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  return text.slice(Math.max(lineStart, index - pad), Math.min(text.length, index + length + pad)).replace(/\s+/g, ' ');
}

/** Every match of `re` in `text` as a finding of `rule`. `skip` drops matches (allow-lists). */
export function findAll(
  path: string,
  text: string,
  rule: string,
  re: RegExp,
  opts: { skip?: (m: RegExpExecArray, text: string) => boolean; message?: (m: RegExpExecArray) => string } = {},
): Finding[] {
  const lines = new LineIndex(text);
  const out: Finding[] = [];
  for (const m of text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))) {
    if (opts.skip?.(m, text)) continue;
    const at = lines.at(m.index);
    const f: Finding = { rule, file: path, line: at.line, column: at.column, excerpt: excerptAt(text, m.index, m[0].length) };
    if (opts.message) f.message = opts.message(m);
    out.push(f);
  }
  return out;
}

/** Playgama: every path is Latin-only (platform-playgama §9.1, §11.5). */
export const SAFE_PATH = /^[A-Za-z0-9._\-/]+$/;

export function scanPathNames(paths: readonly string[]): Finding[] {
  const out: Finding[] = [];
  const seen = new Map<string, string>();
  for (const p of paths) {
    if (!SAFE_PATH.test(p)) out.push({ rule: 'path-chars', file: p, message: 'path does not match ^[A-Za-z0-9._\\-/]+$' });
    else if (p.startsWith('/') || p.split('/').some((s) => s === '' || s === '.' || s === '..')) {
      out.push({ rule: 'path-shape', file: p, message: 'path is absolute or has an empty, "." or ".." segment' });
    }
    const lower = p.toLowerCase();
    const prev = seen.get(lower);
    if (prev !== undefined && prev !== p) out.push({ rule: 'path-case', file: p, message: `differs from ${prev} only by case` });
    seen.set(lower, p);
  }
  return out;
}

/** Root-absolute page URLs in HTML (`src="/x"`) and HTML/CSS (`url(/x)`, `@import "/x"`): a page in a sub-folder cannot load them. */
export function scanRootAbsolute(path: string, text: string): Finding[] {
  const out: Finding[] = [];
  const notProtoRel = '(?!\\/)';
  if (isHtml(path)) {
    out.push(...findAll(path, text, 'root-absolute', new RegExp(`\\b(?:src|href|poster|data|action)\\s*=\\s*["']?\\/${notProtoRel}[^\\s"'>]*`, 'gi'), { message: () => 'root-absolute page URL' }));
  }
  if (isHtml(path) || isCss(path)) {
    out.push(...findAll(path, text, 'root-absolute', new RegExp(`\\burl\\(\\s*["']?\\/${notProtoRel}[^)"']*`, 'gi'), { message: () => 'root-absolute url()' }));
    out.push(...findAll(path, text, 'root-absolute', new RegExp(`@import\\s+["']\\/${notProtoRel}[^"']*`, 'gi'), { message: () => 'root-absolute @import' }));
  }
  if (isJs(path)) {
    // a static import or a dynamic import of a root-absolute module, as vite emits it with base '/'
    out.push(...findAll(path, text, 'root-absolute', /\b(?:from|import\()\s*["']\/(?!\/)[^"']+["']/g, { message: () => 'root-absolute module import' }));
  }
  return out;
}

export const formatFinding = (f: Finding): string =>
  `${f.file}${f.line !== undefined ? `:${f.line}${f.column !== undefined ? `:${f.column}` : ''}` : ''} [${f.rule}]${f.message ? ` ${f.message}` : ''}${f.excerpt ? `  «${f.excerpt}»` : ''}`;
