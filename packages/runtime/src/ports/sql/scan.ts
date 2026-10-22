// A small SQL lexer: splits text into code and literal/comment segments so parameter rewriting and
// `@caller` detection never look inside strings, quoted identifiers or comments.

export interface SqlSegment {
  text: string;
  code: boolean;
}

export function scanSql(sql: string): SqlSegment[] {
  const out: SqlSegment[] = [];
  let i = 0;
  let codeStart = 0;
  const flushCode = (end: number): void => {
    if (end > codeStart) out.push({ text: sql.slice(codeStart, end), code: true });
  };
  const literal = (start: number, end: number): void => {
    flushCode(start);
    out.push({ text: sql.slice(start, end), code: false });
    codeStart = end;
    i = end;
  };
  while (i < sql.length) {
    const c = sql[i]!;
    if (c === "'" || c === '"' || c === '`') {
      let j = i + 1;
      for (;;) {
        if (j >= sql.length) break;
        if (sql[j] === c) {
          if (sql[j + 1] === c) j += 2;
          else {
            j += 1;
            break;
          }
        } else j += 1;
      }
      literal(i, j);
    } else if (c === '[') {
      const close = sql.indexOf(']', i + 1);
      literal(i, close < 0 ? sql.length : close + 1);
    } else if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      literal(i, nl < 0 ? sql.length : nl);
    } else if (c === '/' && sql[i + 1] === '*') {
      const close = sql.indexOf('*/', i + 2);
      literal(i, close < 0 ? sql.length : close + 2);
    } else i += 1;
  }
  flushCode(sql.length);
  return out;
}

const PARAM_NAME = /[@:$][A-Za-z_][A-Za-z0-9_]*/g;

/** Rewrites bare `?` placeholders to `@__pN` named ones; returns the new text and the count. */
export function rewritePositional(sql: string): { sql: string; count: number } {
  let count = 0;
  const text = scanSql(sql)
    .map((seg) => (seg.code ? seg.text.replace(/\?(?![0-9])/g, () => `@__p${count++}`) : seg.text))
    .join('');
  return { sql: text, count };
}

export function usesCaller(sql: string): boolean {
  return scanSql(sql).some((seg) => seg.code && /@caller(?![A-Za-z0-9_])/.test(seg.text));
}

/** Distinct parameters one statement mentions (named ones plus `?NNN`). */
export function countParams(statementSql: string): number {
  const names = new Set<string>();
  for (const seg of scanSql(statementSql)) {
    if (!seg.code) continue;
    for (const m of seg.text.matchAll(PARAM_NAME)) names.add(m[0]);
    for (const m of seg.text.matchAll(/\?[0-9]+/g)) names.add(m[0]);
  }
  return names.size;
}

/** UNION / INTERSECT / EXCEPT operators in a statement (selects joined = operators + 1). */
export function countCompoundOperators(statementSql: string): number {
  let n = 0;
  for (const seg of scanSql(statementSql)) {
    if (seg.code) n += (seg.text.match(/\b(?:UNION|INTERSECT|EXCEPT)\b/gi) ?? []).length;
  }
  return n;
}
