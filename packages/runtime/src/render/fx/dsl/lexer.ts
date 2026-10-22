// fx program lexer (render §13.2, WP R9). Engine-free and DOM-free: runs in the page, the Node tests and the bake tools.
//
// The engine's fx grammar is a line language: `fx[ follow=…]`, then `pop <name> key=value …` lines; an indented line continues
// the previous pop; `//` starts a comment (engine `skills/fx.md:35`). Values are expressions written without spaces at their top
// level, so whitespace is significant: every token records whether whitespace preceded it (`space`), and the parser ends a value
// at the first top-level token that follows whitespace. Inside parentheses whitespace is only a separator
// (`oklch(.29 .155 24)`, authored content).
//
// Number literals stop before a range operator (`1.6..4` is 1.6, `..`, 4); a `.` followed by a letter is the method dot
// (`disc(.3).c(.8)`); words may contain inner hyphens (`smoke-puff`, `flame-wisp`), never a leading or trailing one.

export type TokenKind = 'num' | 'ident' | 'attr' | 'count' | 'param' | 'punct' | 'nl' | 'eof' | 'js';

export interface Token {
  readonly kind: TokenKind;
  /** source text; for `attr`/`count`/`param` the name without its sigil; for `js` the text between the braces of `js{…}` */
  readonly text: string;
  /** numeric value of a `num` token, else NaN */
  readonly value: number;
  /** offset into the program text */
  readonly pos: number;
  /** 1-based */
  readonly line: number;
  /** 1-based */
  readonly col: number;
  /** whitespace (spaces, tabs, or a newline plus indent) directly precedes this token */
  readonly space: boolean;
}

/** A malformed program: the lexer or parser could not read it. Carries the 1-based position and the program text. */
export class FxSyntaxError extends Error {
  /** the message without position and excerpt */
  readonly reason: string;
  readonly line: number;
  readonly col: number;
  readonly program: string;
  constructor(message: string, line: number, col: number, program: string) {
    super(`fx ${line}:${col}: ${message}\n${excerpt(program, line, col)}`);
    this.name = 'FxSyntaxError';
    this.reason = message;
    this.line = line;
    this.col = col;
    this.program = program;
  }
}

/** the source line with a caret under the column, for error messages */
export function excerpt(program: string, line: number, col: number): string {
  const text = program.split('\n')[line - 1] ?? '';
  return `  ${text}\n  ${' '.repeat(Math.max(0, col - 1))}^`;
}

const PUNCT = new Set(['(', ')', '<', '>', ',', ':', ';', '=', '+', '-', '*', '/', '~', '?', '@', '|', '.']);
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
const isAlpha = (c: string | undefined): boolean => c !== undefined && ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_');
const isWordChar = (c: string | undefined): boolean => isAlpha(c) || isDigit(c);

/**
 * Tokenise a whole program. A character outside the grammar throws `FxSyntaxError`, or, with `onError`, is reported and
 * skipped (production: log and skip, render §13.2).
 */
export function lex(text: string, onError?: (e: FxSyntaxError) => void): Token[] {
  const out: Token[] = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  let space = false;
  const n = text.length;
  const push = (kind: TokenKind, start: number, tokText: string, value = Number.NaN): void => {
    out.push({ kind, text: tokText, value, pos: start, line, col: start - lineStart + 1, space });
    space = false;
  };
  /** report a lexical error; returns only in recovering mode */
  const fail = (msg: string, at: number): void => {
    const e = new FxSyntaxError(msg, line, at - lineStart + 1, text);
    if (!onError) throw e;
    onError(e);
    space = true; // the skipped text separates what surrounds it
  };
  /** end of a word; `hyphens`: inner hyphens join words (texture names), never in sigil names (`$a-$b` is a difference) */
  const word = (start: number, hyphens = true): number => {
    let j = start;
    while (j < n) {
      if (isWordChar(text[j])) j++;
      else if (hyphens && text[j] === '-' && isAlpha(text[j + 1]) && j > start) j++;
      else break;
    }
    return j;
  };

  while (i < n) {
    const c = text[i] as string;
    if (c === ' ' || c === '\t' || c === '\r') {
      space = true;
      i++;
      continue;
    }
    if (c === '\n') {
      push('nl', i, '\n');
      i++;
      line++;
      lineStart = i;
      space = false;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
      continue;
    }
    const start = i;
    if (isDigit(c) || (c === '.' && isDigit(text[i + 1]))) {
      while (isDigit(text[i])) i++;
      if (text[i] === '.' && isDigit(text[i + 1])) {
        i++;
        while (isDigit(text[i])) i++;
      }
      if ((text[i] === 'e' || text[i] === 'E') && (isDigit(text[i + 1]) || ((text[i + 1] === '-' || text[i + 1] === '+') && isDigit(text[i + 2])))) {
        i += 2;
        while (isDigit(text[i])) i++;
      }
      if (isAlpha(text[i])) {
        const end = word(i);
        fail(`malformed number '${text.slice(start, end)}'`, start);
        i = end;
        continue;
      }
      const s = text.slice(start, i);
      push('num', start, s, Number(s));
      continue;
    }
    if (isAlpha(c)) {
      i = word(i);
      if (text.slice(start, i) === 'js' && text[i] === '{') {
        // `js{ … }`: a data block (`path(js{pts})`, `sk/fx:37`), read to its balanced closing brace; newlines inside are kept
        let depth = 0;
        let j = i;
        for (; j < n; j++) {
          const ch = text[j];
          if (ch === '{') depth++;
          else if (ch === '}' && --depth === 0) break;
        }
        if (j >= n) {
          fail("unterminated 'js{' block", start);
          i = n;
          continue;
        }
        push('js', start, text.slice(i + 1, j));
        for (let k = i; k < j; k++) if (text[k] === '\n') { line++; lineStart = k + 1; }
        i = j + 1;
        continue;
      }
      push('ident', start, text.slice(start, i));
      continue;
    }
    if (c === '$' || c === '#' || c === '%') {
      const end = word(i + 1, false);
      if (end === i + 1 || !isAlpha(text[i + 1])) {
        fail(`'${c}' must be followed by a name`, start);
        i++;
        continue;
      }
      const kind: TokenKind = c === '$' ? 'attr' : c === '#' ? 'count' : 'param';
      push(kind, start, text.slice(i + 1, end));
      i = end;
      continue;
    }
    if (c === '.' && text[i + 1] === '.') {
      push('punct', start, '..');
      i += 2;
      continue;
    }
    if (PUNCT.has(c)) {
      push('punct', start, c);
      i++;
      continue;
    }
    fail(`unexpected character '${c}'`, start);
    i++;
  }
  push('eof', n, '');
  return out;
}
