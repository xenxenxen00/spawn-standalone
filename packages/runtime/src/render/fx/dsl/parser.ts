// fx program parser (render §13.2, WP R9): tokens → syntax tree. Pure; the compiler (compile.ts) resolves names, params and tiers.
//
// Program   := 'fx' attr* NL ( 'pop' NAME attr* (NL INDENT attr*)* NL )*        indented lines continue the previous pop
// attr      := KEY '=' value                                                      no whitespace around '='
// value     := '@' NAME ( '?' range )?                                            on=@flame?.3  (born where a parent dies)
//            | item ( ';' item )*                                                 inh=p;v:$v*.4  wrap=30;10;30  win=0;.2
// item      := ( NAME ':' )? expr
// expr      := range ( '>' ( range ':' )? range )*                                keyframes v0>t1:v1>…>vEnd over normalised age
// range     := sum ( '..' sum )?                                                  a..b rolled per particle
// sum       := product ( ('+'|'-') product )*
// product   := unary ( ('*'|'/') unary )*
// unary     := '-' unary | postfix
// postfix   := primary ( '.' NAME '(' args ')' | '~' )*                           .c(h) .sin() …; '~' smooths what precedes it
// primary   := NUM | '%' NAME ('|' '-'? NUM)? | '$' NAME | '#' NAME | NAME ( '(' args ')' )?
//            | '(' expr ')' | '<' range (',' range)* '>' | '?' NAME ':' range '|' range
// args      := ( (NAME '=')? expr ( ',' | WS ) )*                                 oklch(.29 .155 24) separates by space
//
// A value ends at the first top-level token preceded by whitespace (the lexer's `space` flag); inside brackets whitespace only
// separates. Vector components are ranges, so the `>` after them always closes the vector (`<a>><b>` is a keyframe).
// `<%dir|0,0,-1>`: a param as the first of exactly three components followed by two number literals is ONE vector param with a
// vector default (`scripts/effects/programs.js:4`: "Params are read as `<%name|default>`"); `<%gr|.5,%gg|.16,%gb|.04>` stays a
// vector of three scalar params (`scripts/gen/fill/grim.js` PALL).
import { FxSyntaxError, lex, type Token } from './lexer.ts';

export type BinOp = '+' | '-' | '*' | '/';

export type ExprAst =
  | { readonly t: 'num'; readonly v: number; readonly pos: number }
  | { readonly t: 'vec'; readonly items: readonly ExprAst[]; readonly pos: number }
  | { readonly t: 'param'; readonly name: string; readonly def: number | readonly number[] | null; readonly pos: number }
  | { readonly t: 'attr'; readonly name: string; readonly pos: number }
  | { readonly t: 'count'; readonly pop: string; readonly pos: number }
  | { readonly t: 'ident'; readonly name: string; readonly pos: number }
  | { readonly t: 'call'; readonly name: string; readonly args: readonly ExprAst[]; readonly named: readonly NamedArgAst[]; readonly pos: number }
  | { readonly t: 'method'; readonly name: string; readonly target: ExprAst; readonly args: readonly ExprAst[]; readonly pos: number }
  | { readonly t: 'bin'; readonly op: BinOp; readonly a: ExprAst; readonly b: ExprAst; readonly pos: number }
  | { readonly t: 'neg'; readonly a: ExprAst; readonly pos: number }
  | { readonly t: 'range'; readonly lo: ExprAst; readonly hi: ExprAst; readonly pos: number }
  | { readonly t: 'keys'; readonly frames: readonly KeyFrameAst[]; readonly pos: number }
  | { readonly t: 'smooth'; readonly a: ExprAst; readonly pos: number }
  | { readonly t: 'query'; readonly flag: string; readonly a: ExprAst; readonly b: ExprAst; readonly pos: number }
  /** `js{ … }`: a data block (the raw text between the braces), read by `path()` */
  | { readonly t: 'js'; readonly src: string; readonly pos: number };

/** one keyframe: `t` is null for the first frame, the last frame and evenly spaced bare frames (`a>b>c`) */
export interface KeyFrameAst {
  readonly t: ExprAst | null;
  readonly v: ExprAst;
}
export interface NamedArgAst {
  readonly name: string;
  readonly value: ExprAst;
  readonly pos: number;
}
export interface ListItemAst {
  readonly label: string | null;
  readonly value: ExprAst;
  readonly pos: number;
}
export type ValueAst =
  | ExprAst
  | { readonly t: 'list'; readonly items: readonly ListItemAst[]; readonly pos: number }
  | { readonly t: 'parent'; readonly pop: string; readonly p: ExprAst | null; readonly pos: number };

export interface AttrAst {
  readonly key: string;
  readonly value: ValueAst;
  /** offset of the key */
  readonly pos: number;
}
export interface PopAst {
  readonly name: string;
  readonly attrs: readonly AttrAst[];
  readonly pos: number;
}
/** K11: `.fn` methods that take no argument, which may be written without `()` */
const ZERO_ARG_METHODS: ReadonlySet<string> = new Set(['sin', 'cos', 'abs', 'floor', 'fract', 'sqrt', 'neg', 'norm', 'len', 'yaw']);

export interface ProgramAst {
  readonly header: readonly AttrAst[];
  readonly pops: readonly PopAst[];
  /** K11: bare words on a line of their own between the header and the pops (the games write `local`); absent when there are none */
  readonly flags?: readonly string[];
}

export interface ParseOptions {
  /** recover instead of throwing: the error is reported and the attribute (or line) it occurred in is skipped */
  readonly onError?: (e: FxSyntaxError) => void;
}

const END: Token = { kind: 'eof', text: '<end of value>', value: Number.NaN, pos: -1, line: 0, col: 0, space: false };

class Parser {
  private readonly toks: readonly Token[];
  private readonly text: string;
  private i = 0;
  /** bracket depth: at 0 whitespace ends a value, inside brackets it separates */
  private depth = 0;

  constructor(toks: readonly Token[], text: string) {
    this.toks = toks;
    this.text = text;
  }

  // ------------------------------------------------------------------ token access

  /** the raw token at the cursor (newlines skipped inside brackets) */
  private raw(): Token {
    if (this.depth > 0) while (this.toks[this.i]?.kind === 'nl') this.i++;
    return this.toks[this.i] ?? (this.toks[this.toks.length - 1] as Token);
  }

  /** the token at the cursor as the expression grammar sees it: END where the value stops */
  private cur(): Token {
    const t = this.raw();
    if (this.depth === 0 && (t.space || t.kind === 'nl' || t.kind === 'eof')) return END;
    return t;
  }

  private is(text: string): boolean {
    const t = this.cur();
    return t.kind === 'punct' && t.text === text;
  }

  private take(): Token {
    const t = this.raw();
    this.i++;
    return t;
  }

  private fail(msg: string, at: Token = this.raw()): never {
    throw new FxSyntaxError(msg, at.line, at.col, this.text);
  }

  private expect(text: string, what = `'${text}'`): Token {
    const t = this.cur();
    if (t.kind !== 'punct' || t.text !== text) this.fail(`expected ${what}, found ${describe(this.raw(), t)}`);
    return this.take();
  }

  private expectName(what: string): Token {
    const t = this.cur();
    if (t.kind !== 'ident') this.fail(`expected ${what}, found ${describe(this.raw(), t)}`);
    return this.take();
  }

  // ------------------------------------------------------------------ program

  program(onError: ParseOptions['onError']): ProgramAst {
    while (this.raw().kind === 'nl') this.i++;
    const head = this.raw();
    let header: AttrAst[] = [];
    if (head.kind === 'ident' && head.text === 'fx') {
      this.i++;
      header = this.attrs(onError, false);
    } else {
      const e = new FxSyntaxError(`a program starts with 'fx', found ${describe(head, head)}`, head.line, head.col, this.text);
      if (!onError) throw e;
      onError(e);
      if (head.text !== 'pop') while (this.raw().kind !== 'nl' && this.raw().kind !== 'eof') this.i++;
    }
    const pops: PopAst[] = [];
    const flags: string[] = [];
    for (;;) {
      while (this.raw().kind === 'nl') this.i++;
      const t = this.raw();
      if (t.kind === 'eof') break;
      try {
        // K11: a bare `local` on a line of its own
        const after = this.toks[this.i + 1];
        if (t.kind === 'ident' && t.text === 'local' && !t.space && (after === undefined || after.kind === 'nl' || after.kind === 'eof')) {
          flags.push(t.text);
          this.i++;
          continue;
        }
        if (t.space) this.fail('an indented line continues a pop, but no pop has started');
        if (t.kind !== 'ident' || t.text !== 'pop') this.fail(`expected 'pop', found ${describe(t, t)}`);
        this.i++;
        const name = this.raw();
        if (name.kind !== 'ident' || !name.space) this.fail(`expected a population name after 'pop', found ${describe(name, name)}`);
        this.i++;
        pops.push({ name: name.text, attrs: this.attrs(onError, true), pos: t.pos });
      } catch (e) {
        if (!onError || !(e instanceof FxSyntaxError)) throw e;
        onError(e);
        while (this.raw().kind !== 'nl' && this.raw().kind !== 'eof') this.i++;
      }
    }
    return flags.length === 0 ? { header, pops } : { header, pops, flags };
  }

  /** `key=value` tokens to the end of the line, plus indented continuation lines when `continued` */
  private attrs(onError: ParseOptions['onError'], continued: boolean): AttrAst[] {
    const out: AttrAst[] = [];
    for (;;) {
      let t = this.raw();
      if (t.kind === 'nl') {
        if (!continued) break;
        let j = this.i;
        while (this.toks[j]?.kind === 'nl') j++;
        const next = this.toks[j];
        if (!next || next.kind === 'eof' || !next.space) break;
        this.i = j;
        t = this.raw();
      }
      if (t.kind === 'eof') break;
      const start = this.i;
      try {
        out.push(this.attr());
      } catch (e) {
        if (!onError || !(e instanceof FxSyntaxError)) throw e;
        onError(e);
        this.depth = 0;
        this.i = start + 1;
        while (!(this.raw().space || this.raw().kind === 'nl' || this.raw().kind === 'eof')) this.i++;
      }
    }
    return out;
  }

  private attr(): AttrAst {
    const key = this.raw();
    if (key.kind !== 'ident' || !key.space) this.fail(`expected 'key=value', found ${describe(key, key)}`);
    this.i++;
    const eq = this.raw();
    if (eq.kind !== 'punct' || eq.text !== '=' || eq.space) this.fail(`expected '=' after '${key.text}'`, eq);
    this.i++;
    const first = this.raw();
    if (first.space || first.kind === 'nl' || first.kind === 'eof') this.fail(`'${key.text}=' needs a value (no whitespace after '=')`, first);
    return { key: key.text, value: this.valueToEnd(), pos: key.pos };
  }

  // ------------------------------------------------------------------ values

  valueToEnd(): ValueAst {
    const v = this.value();
    const t = this.cur();
    if (t !== END) this.fail(`unexpected ${describe(t, t)}`);
    return v;
  }

  /** a lone value: it must be the whole text */
  valueOnly(): ValueAst {
    const first = this.raw();
    if (first.space || first.kind === 'eof') this.fail('expected a value', first);
    const v = this.valueToEnd();
    const rest = this.raw();
    if (rest.kind !== 'eof') this.fail(`unexpected ${describe(rest, rest)} after the value`, rest);
    return v;
  }

  private value(): ValueAst {
    const start = this.cur();
    if (start.kind === 'punct' && start.text === '@') {
      this.take();
      const pop = this.expectName('a population name after @');
      let p: ExprAst | null = null;
      if (this.is('?')) {
        this.take();
        p = this.range();
      }
      return { t: 'parent', pop: pop.text, p, pos: start.pos };
    }
    const items: ListItemAst[] = [this.item()];
    while (this.is(';')) {
      this.take();
      items.push(this.item());
    }
    if (items.length === 1 && items[0]?.label === null) return items[0].value;
    return { t: 'list', items, pos: start.pos };
  }

  private item(): ListItemAst {
    const t = this.cur();
    const next = this.toks[this.i + 1];
    if (t.kind === 'ident' && next && next.kind === 'punct' && next.text === ':' && !next.space) {
      this.i += 2;
      return { label: t.text, value: this.expr(), pos: t.pos };
    }
    return { label: null, value: this.expr(), pos: t.pos };
  }

  expr(): ExprAst {
    const first = this.range();
    if (!this.is('>')) return first;
    const frames: KeyFrameAst[] = [{ t: null, v: first }];
    while (this.is('>')) {
      this.take();
      const seg = this.range();
      if (this.is(':')) {
        this.take();
        frames.push({ t: seg, v: this.range() });
      } else frames.push({ t: null, v: seg });
    }
    return { t: 'keys', frames, pos: first.pos };
  }

  private range(): ExprAst {
    const lo = this.sum();
    if (!this.is('..')) return lo;
    this.take();
    return { t: 'range', lo, hi: this.sum(), pos: lo.pos };
  }

  private sum(): ExprAst {
    let a = this.product();
    while (this.is('+') || this.is('-')) {
      const op = this.take().text as BinOp;
      a = { t: 'bin', op, a, b: this.product(), pos: a.pos };
    }
    return a;
  }

  private product(): ExprAst {
    let a = this.unary();
    while (this.is('*') || this.is('/')) {
      const op = this.take().text as BinOp;
      a = { t: 'bin', op, a, b: this.unary(), pos: a.pos };
    }
    return a;
  }

  private unary(): ExprAst {
    if (this.is('-')) {
      const m = this.take();
      const a = this.unary();
      return a.t === 'num' ? { t: 'num', v: -a.v, pos: m.pos } : { t: 'neg', a, pos: m.pos };
    }
    return this.postfix();
  }

  private postfix(): ExprAst {
    let a = this.primary();
    for (;;) {
      if (this.is('.')) {
        this.take();
        const name = this.expectName('a method name after "."');
        // K11: Pip writes `(v).norm*5`; a method that takes no argument may leave out its empty parentheses
        if (ZERO_ARG_METHODS.has(name.text) && !this.is('(')) {
          a = { t: 'method', name: name.text, target: a, args: [], pos: a.pos };
          continue;
        }
        this.expect('(', `'(' after .${name.text}`);
        const { args, named } = this.args();
        if (named.length) this.fail(`.${name.text}() takes no named arguments`, name);
        a = { t: 'method', name: name.text, target: a, args, pos: a.pos };
      } else if (this.is('~')) {
        const m = this.take();
        a = { t: 'smooth', a, pos: m.pos };
      } else return a;
    }
  }

  private primary(): ExprAst {
    const t = this.cur();
    if (t === END) this.fail(`expected a value, found ${describe(this.raw(), t)}`);
    switch (t.kind) {
      case 'num':
        this.take();
        return { t: 'num', v: t.value, pos: t.pos };
      case 'attr':
        this.take();
        return { t: 'attr', name: t.text, pos: t.pos };
      case 'count':
        this.take();
        return { t: 'count', pop: t.text, pos: t.pos };
      case 'param': {
        this.take();
        let def: number | null = null;
        if (this.is('|')) {
          this.take();
          def = this.signedNumber('a default number after |');
        }
        return { t: 'param', name: t.text, def, pos: t.pos };
      }
      case 'ident': {
        this.take();
        if (!this.is('(')) return { t: 'ident', name: t.text, pos: t.pos };
        this.take();
        const { args, named } = this.args();
        return { t: 'call', name: t.text, args, named, pos: t.pos };
      }
      case 'js':
        this.take();
        return { t: 'js', src: t.text, pos: t.pos };
      case 'punct':
        break;
      default:
        this.fail(`unexpected ${describe(t, t)}`);
    }
    if (t.text === '(') {
      this.take();
      this.depth++;
      const e = this.expr();
      this.expect(')', "')'");
      this.depth--;
      return e;
    }
    if (t.text === '<') {
      this.take();
      this.depth++;
      const items: ExprAst[] = [this.range()];
      while (this.is(',')) {
        this.take();
        items.push(this.range());
      }
      this.expect('>', "',' or '>' in a vector");
      this.depth--;
      const [p, y, z] = items;
      if (items.length === 3 && p?.t === 'param' && typeof p.def === 'number' && y?.t === 'num' && z?.t === 'num') {
        return { t: 'param', name: p.name, def: [p.def, y.v, z.v], pos: t.pos };
      }
      return { t: 'vec', items, pos: t.pos };
    }
    if (t.text === '?') {
      this.take();
      const flag = this.expectName("a flag after '?' (?low:A|B)");
      this.expect(':', `':' after ?${flag.text}`);
      const a = this.range();
      this.expect('|', `'|' between the two branches of ?${flag.text}`);
      const b = this.range();
      return { t: 'query', flag: flag.text, a, b, pos: t.pos };
    }
    return this.fail(`unexpected ${describe(t, t)}`);
  }

  private signedNumber(what: string): number {
    let sign = 1;
    if (this.is('-')) {
      this.take();
      sign = -1;
    }
    const t = this.cur();
    if (t.kind !== 'num') this.fail(`expected ${what}, found ${describe(this.raw(), t)}`);
    this.take();
    return sign * t.value;
  }

  /** after '(' up to and including ')' */
  private args(): { args: ExprAst[]; named: NamedArgAst[] } {
    this.depth++;
    const args: ExprAst[] = [];
    const named: NamedArgAst[] = [];
    if (this.is(')')) {
      this.take();
      this.depth--;
      return { args, named };
    }
    for (;;) {
      const t = this.cur();
      const next = this.toks[this.i + 1];
      if (t.kind === 'ident' && next?.kind === 'punct' && next.text === '=' && !next.space) {
        this.i += 2;
        named.push({ name: t.text, value: this.expr(), pos: t.pos });
      } else {
        if (named.length) this.fail('a positional argument cannot follow a named one');
        args.push(this.expr());
      }
      if (this.is(',')) {
        this.take();
        continue;
      }
      if (this.is(')')) {
        this.take();
        this.depth--;
        return { args, named };
      }
      const n = this.raw();
      if (n.space && n.kind !== 'eof') continue; // oklch(.29 .155 24)
      this.fail(`expected ',' or ')' in an argument list, found ${describe(n, this.cur())}`);
    }
  }
}

function describe(raw: Token, seen: Token): string {
  if (seen === END) return raw.kind === 'eof' ? 'the end of the program' : raw.kind === 'nl' ? 'the end of the line' : `whitespace before '${raw.text}'`;
  if (raw.kind === 'eof') return 'the end of the program';
  if (raw.kind === 'nl') return 'the end of the line';
  const sigil = raw.kind === 'attr' ? '$' : raw.kind === 'count' ? '#' : raw.kind === 'param' ? '%' : '';
  return `'${sigil}${raw.text}'`;
}

/** Parse a whole program. Throws `FxSyntaxError`, unless `onError` is given (then malformed attributes and lines are skipped). */
export function parseProgram(text: string, opts: ParseOptions = {}): ProgramAst {
  return new Parser(lex(text, opts.onError), text).program(opts.onError);
}

/** Parse one attribute value (the text after `key=`, no surrounding whitespace); for tests and tools. */
export function parseValue(text: string): ValueAst {
  return new Parser(lex(text), text).valueOnly();
}

// -------------------------------------------------------------------------------------------------------------------- printing

const num = (v: number): string => String(v);

/** Canonical S-expression form (positions omitted): the AST snapshot format. */
export function printAst(node: ProgramAst | ValueAst): string {
  if ('pops' in node) {
    const head = node.header.map((a) => ` (${a.key} ${printAst(a.value)})`).join('') + (node.flags ?? []).map((f) => ` ${f}`).join('');
    const pops = node.pops.map((p) => {
      const attrs = p.attrs.map((a) => `\n    (${a.key} ${printAst(a.value)})`).join('');
      return `\n  (pop ${p.name}${attrs})`;
    });
    return `(fx${head}${pops.join('')})`;
  }
  switch (node.t) {
    case 'num':
      return num(node.v);
    case 'vec':
      return `(vec ${node.items.map(printAst).join(' ')})`;
    case 'param':
      return node.def === null ? `%${node.name}` : typeof node.def === 'number' ? `%${node.name}|${num(node.def)}` : `%${node.name}|<${node.def.map(num).join(',')}>`;
    case 'attr':
      return `$${node.name}`;
    case 'count':
      return `#${node.pop}`;
    case 'ident':
      return node.name;
    case 'call': {
      const parts = [node.name, ...node.args.map(printAst), ...node.named.map((n) => `:${n.name} ${printAst(n.value)}`)];
      return `(${parts.join(' ')})`;
    }
    case 'method':
      return `(.${node.name} ${[node.target, ...node.args].map(printAst).join(' ')})`;
    case 'bin':
      return `(${node.op} ${printAst(node.a)} ${printAst(node.b)})`;
    case 'neg':
      return `(neg ${printAst(node.a)})`;
    case 'range':
      return `(.. ${printAst(node.lo)} ${printAst(node.hi)})`;
    case 'keys':
      return `(keys ${node.frames.map((f) => (f.t === null ? printAst(f.v) : `(@ ${printAst(f.t)} ${printAst(f.v)})`)).join(' ')})`;
    case 'smooth':
      return `(~ ${printAst(node.a)})`;
    case 'query':
      return `(?${node.flag} ${printAst(node.a)} ${printAst(node.b)})`;
    case 'js':
      return `(js ${JSON.stringify(node.src.trim())})`;
    case 'list':
      return `(; ${node.items.map((i) => (i.label === null ? printAst(i.value) : `(${i.label}: ${printAst(i.value)})`)).join(' ')})`;
    case 'parent':
      return node.p === null ? `(@${node.pop})` : `(@${node.pop} ${printAst(node.p)})`;
  }
}
