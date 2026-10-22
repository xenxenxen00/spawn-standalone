// Lexical scans of carried files for the reachability graph. Copied from purge-protocol-web ebab692
// tools/import-live/scan.ts; added: the `tail` of an interpolated template literal (template-path expansion in reach.ts).
//
// JS: one pass that skips comments, reads string and template literals and regex literals (heuristic: a `/` after an
// operator, an opening bracket or a keyword starts a regex). YAML / scene: line-wise, a `#` that starts the line or follows
// whitespace outside quotes starts a comment (so `templates/x.js#export` stays whole).

export interface JsStringLit {
  /** decoded enough for path matching: the raw text between the quotes (escapes kept) */
  value: string;
  line: number;
  /** a template literal with `${…}` parts: `value` is the text before the first `${` */
  interpolated: boolean;
  /** an interpolated template literal: the text after its last `${…}` (the `.js` of `templates/e/${a}.js`) */
  tail?: string;
  /** offset of the opening quote in the source; absent for a literal nested in a template's `${…}` */
  index?: number;
}

export interface JsScan {
  strings: JsStringLit[];
  /** import specifiers: static `import … from`, side-effect `import '…'`, `export … from`, literal `import('…')` */
  imports: { spec: string; line: number; dynamic: boolean }[];
}

const REGEX_PREV = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'throw', 'case', 'do', 'else', 'yield', 'await']);

/** results by exact source text: one import scans the same text in several graphs and in the edit kit (bounded) */
const SCAN_CACHE = new Map<string, JsScan>();
const SCAN_CACHE_MAX = 1024;

/** Scans JS source. Comments are dropped; a code skeleton (strings blanked) drives the import matcher. The result is shared and frozen. */
export function scanJs(src: string): JsScan {
  const hit = SCAN_CACHE.get(src);
  if (hit) return hit;
  const r = scanJsUncached(src);
  for (const x of r.strings) Object.freeze(x);
  for (const x of r.imports) Object.freeze(x);
  Object.freeze(r.strings);
  Object.freeze(r.imports);
  Object.freeze(r);
  if (SCAN_CACHE.size >= SCAN_CACHE_MAX) SCAN_CACHE.delete(SCAN_CACHE.keys().next().value!);
  SCAN_CACHE.set(src, r);
  return r;
}

function scanJsUncached(src: string): JsScan {
  const strings: JsStringLit[] = [];
  // skeleton: code with comments removed and every string literal replaced by a numbered placeholder `\u0001<n>\u0001`
  let skel = '';
  let line = 1;
  let i = 0;
  let lastSig = ''; // last significant (non-space) character of code
  let lastWord = '';
  const n = src.length;
  const readQuoted = (q: string): string => {
    // i at the opening quote
    let j = i + 1;
    let out = '';
    while (j < n) {
      const c = src[j]!;
      if (c === '\\') {
        out += c + (src[j + 1] ?? '');
        if (src[j + 1] === '\n') line++;
        j += 2;
        continue;
      }
      if (c === q) break;
      if (c === '\n') {
        if (q !== '`') break; // unterminated: stop at the line end
        line++;
      }
      out += c;
      j++;
    }
    i = j + 1;
    return out;
  };
  const readTemplate = (): { text: string; interpolated: boolean; tail: string } => {
    // i at the backtick; nested `${ … }` skipped with brace depth (strings inside are scanned recursively)
    let j = i + 1;
    let text = '';
    let interpolated = false;
    let tail = '';
    while (j < n) {
      const c = src[j]!;
      if (c === '\\') {
        if (!interpolated) text += c + (src[j + 1] ?? '');
        else tail += c + (src[j + 1] ?? '');
        j += 2;
        continue;
      }
      if (c === '`') break;
      if (c === '\n') line++;
      if (c === '$' && src[j + 1] === '{') {
        interpolated = true;
        tail = '';
        let depth = 1;
        j += 2;
        // the expression's own last significant character and word: they tell a regex literal (`.replace(/"/g, …)`) from a division
        let prev = '(';
        let word = '';
        while (j < n && depth > 0) {
          const d = src[j]!;
          if (d === '/' && src[j + 1] === '/') {
            while (j < n && src[j] !== '\n') j++;
            continue;
          }
          if (d === '/' && src[j + 1] === '*') {
            const end = src.indexOf('*/', j + 2);
            const stop = end < 0 ? n : end + 2;
            for (let k = j; k < stop; k++) if (src[k] === '\n') line++;
            j = stop;
            continue;
          }
          if (d === '/' && (REGEX_PREV.has(prev) || REGEX_KEYWORDS.has(word))) {
            // a regex literal: its quotes and braces are not the expression's
            let k = j + 1;
            let cls = false;
            while (k < n && src[k] !== '\n') {
              const r = src[k]!;
              if (r === '\\') {
                k += 2;
                continue;
              }
              if (r === '[') cls = true;
              else if (r === ']') cls = false;
              else if (r === '/' && !cls) break;
              k++;
            }
            k++;
            while (k < n && /[a-z]/i.test(src[k]!)) k++;
            j = k;
            prev = ')';
            word = '';
            continue;
          }
          if (!/\s/.test(d)) {
            prev = d;
            word = /[\w$]/.test(d) ? (/[\w$]/.test(src[j - 1] ?? '') ? word + d : d) : '';
          }
          if (d === '{') depth++;
          else if (d === '}') depth--;
          else if (d === '\n') line++;
          else if (d === '"' || d === "'" || d === '`') {
            // a nested literal: skip it (a nested template's own `${}` braces are balanced inside it)
            const save = i;
            i = j;
            if (d === '`') {
              const inner = readTemplate();
              strings.push({ value: inner.text, line, interpolated: inner.interpolated });
            } else strings.push({ value: readQuoted(d), line, interpolated: false });
            j = i;
            i = save;
            continue;
          }
          j++;
        }
        continue;
      }
      if (!interpolated) text += c;
      else tail += c;
      j++;
    }
    i = j + 1;
    return { text, interpolated, tail };
  };

  while (i < n) {
    const c = src[i]!;
    const d = src[i + 1];
    if (c === '\n') {
      line++;
      skel += c;
      i++;
      continue;
    }
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && d === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end < 0 ? n : end + 2;
      for (let k = i; k < stop; k++) if (src[k] === '\n') {
        line++;
        skel += '\n';
      }
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      const at = line;
      const start = i;
      const value = readQuoted(c);
      skel += `\u0001${strings.length}\u0001`;
      strings.push({ value, line: at, interpolated: false, index: start });
      lastSig = c;
      lastWord = '';
      continue;
    }
    if (c === '`') {
      const at = line;
      const start = i;
      const t = readTemplate();
      skel += `\u0001${strings.length}\u0001`;
      strings.push(t.interpolated ? { value: t.text, line: at, interpolated: true, tail: t.tail, index: start } : { value: t.text, line: at, interpolated: false, index: start });
      lastSig = c;
      lastWord = '';
      continue;
    }
    if (c === '/' && (lastSig === '' || REGEX_PREV.has(lastSig) || REGEX_KEYWORDS.has(lastWord))) {
      // regex literal: skip to the closing unescaped `/` outside a character class
      let j = i + 1;
      let cls = false;
      while (j < n && src[j] !== '\n') {
        const r = src[j]!;
        if (r === '\\') {
          j += 2;
          continue;
        }
        if (r === '[') cls = true;
        else if (r === ']') cls = false;
        else if (r === '/' && !cls) break;
        j++;
      }
      j++;
      while (j < n && /[a-z]/i.test(src[j]!)) j++;
      skel += ' ';
      i = j;
      lastSig = ')';
      lastWord = '';
      continue;
    }
    skel += c;
    if (!/\s/.test(c)) {
      lastSig = c;
      if (/[\w$]/.test(c)) {
        // track the current identifier/keyword
        lastWord = /[\w$]/.test(src[i - 1] ?? '') ? lastWord + c : c;
      } else lastWord = '';
    }
    i++;
  }

  const imports: JsScan['imports'] = [];
  const lit = (m: string): JsStringLit | undefined => strings[Number(m)];
  const lineAt = (idx: number): number => {
    let l = 1;
    for (let k = 0; k < idx; k++) if (skel.charCodeAt(k) === 10) l++;
    return l;
  };
  const patterns: [RegExp, boolean][] = [
    [/\bimport\s*\(\s*\u0001(\d+)\u0001\s*[,)]/g, true],
    [/\bfrom\s*\u0001(\d+)\u0001/g, false],
    [/(?:^|[^.\w$])import\s*\u0001(\d+)\u0001/g, false],
  ];
  for (const [re, dynamic] of patterns) {
    for (const m of skel.matchAll(re)) {
      const s = lit(m[1]!);
      if (s && !s.interpolated) imports.push({ spec: s.value, line: lineAt(m.index), dynamic });
    }
  }
  imports.sort((a, b) => a.line - b.line);
  return { strings, imports };
}

/** The key a value at `idx` belongs to (`script: 'x'` → `script`), or null (array item, argument, comment, …). */
export function keyBefore(text: string, idx: number): string | null {
  let j = idx - 1;
  if (j >= 0 && (text[j] === '"' || text[j] === "'" || text[j] === '`')) j--;
  while (j >= 0 && (text[j] === ' ' || text[j] === '\t')) j--;
  if (text[j] !== ':') return null;
  j--;
  while (j >= 0 && (text[j] === ' ' || text[j] === '\t')) j--;
  const q = text[j];
  if (q === '"' || q === "'") {
    const end = j;
    j--;
    while (j >= 0 && text[j] !== q && text[j] !== '\n') j--;
    return j >= 0 && text[j] === q ? text.slice(j + 1, end) : null;
  }
  const end = j + 1;
  while (j >= 0 && /[\w$-]/.test(text[j]!)) j--;
  return end > j + 1 ? text.slice(j + 1, end) : null;
}

/** YAML / scene text with comments blanked (same line structure). */
export function stripYamlComments(src: string): string {
  return src
    .split('\n')
    .map((ln) => {
      let q: string | null = null;
      for (let k = 0; k < ln.length; k++) {
        const c = ln[k]!;
        if (q) {
          if (c === '\\' && q === '"') k++;
          else if (c === q) q = null;
          continue;
        }
        if (c === '"' || c === "'") {
          // a quote opens a scalar only at a token start
          const prev = ln[k - 1];
          if (prev === undefined || /[\s:[{,-]/.test(prev)) q = c;
          continue;
        }
        if (c === '#' && (k === 0 || /\s/.test(ln[k - 1]!))) return ln.slice(0, k);
      }
      return ln;
    })
    .join('\n');
}

/** Tree-rooted path strings: `scripts/…`, `templates/…`, `places/…`, `anim/…`, `ui/…`, `clips/…` + a carried extension. */
export const PATH_RE = /(?<![\w./-])((?:scripts|templates|places|anim|ui|clips)\/[\w./-]+?\.(?:js|yml|yaml|scene|json))(?:#[\w$]+)?(?![\w/-])/g;

/** Every tree-rooted path named in a piece of text (template refs lose their `#export`). */
export function pathsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(PATH_RE)) out.push(m[1]!);
  return out;
}
