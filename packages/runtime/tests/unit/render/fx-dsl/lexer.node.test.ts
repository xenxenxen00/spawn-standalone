import { describe, expect, it } from 'vitest';
import { FxSyntaxError, lex, type Token } from '../../../../src/render/fx/dsl/lexer.ts';

const kinds = (ts: Token[]): string[] =>
  ts.map((t) => (t.kind === 'punct' ? t.text : t.kind === 'num' ? `#${t.value}` : t.kind === 'eof' ? 'eof' : `${t.kind}:${t.text}`));

describe('fx lexer', () => {
  it('splits ranges from fractional numbers', () => {
    expect(kinds(lex('.5..0.95'))).toEqual(['#0.5', '..', '#0.95', 'eof']);
    expect(kinds(lex('1.6..4*%k|1'))).toEqual(['#1.6', '..', '#4', '*', 'param:k', '|', '#1', 'eof']);
    expect(kinds(lex('-.4..0.1'))).toEqual(['-', '#0.4', '..', '#0.1', 'eof']);
    expect(kinds(lex('0..6.28'))).toEqual(['#0', '..', '#6.28', 'eof']);
  });

  it('reads exponents, method dots and hyphenated words', () => {
    expect(kinds(lex('1e-7 2.5E+3'))).toEqual(['#1e-7', '#2500', 'eof']);
    expect(kinds(lex('disc(.3).c(.8)'))).toEqual(['ident:disc', '(', '#0.3', ')', '.', 'ident:c', '(', '#0.8', ')', 'eof']);
    expect(kinds(lex('sprite(smoke-puff,alpha)'))).toEqual(['ident:sprite', '(', 'ident:smoke-puff', ',', 'ident:alpha', ')', 'eof']);
  });

  it('reads sigils and punctuation', () => {
    expect(kinds(lex('$size*(#flame/40)~'))).toEqual(['attr:size', '*', '(', 'count:flame', '/', '#40', ')', '~', 'eof']);
    expect(kinds(lex('@flame?.3'))).toEqual(['@', 'ident:flame', '?', '#0.3', 'eof']);
    expect(kinds(lex('?low:8|18'))).toEqual(['?', 'ident:low', ':', '#8', '|', '#18', 'eof']);
    expect(kinds(lex('<.12,.1,.09>><.08,.08,.08>'))).toEqual(['<', '#0.12', ',', '#0.1', ',', '#0.09', '>', '>', '<', '#0.08', ',', '#0.08', ',', '#0.08', '>', 'eof']);
  });

  it('marks whitespace, newlines and continuation indents', () => {
    const ts = lex('fx\npop a n=1\n  r=x\n// note\npop b');
    const pop = ts.filter((t) => t.text === 'pop');
    expect(pop.map((t) => [t.line, t.col, t.space])).toEqual([[2, 1, false], [5, 1, false]]);
    const r = ts.find((t) => t.text === 'r') as Token;
    expect([r.line, r.col, r.space]).toEqual([3, 3, true]);
    expect(ts.filter((t) => t.kind === 'nl')).toHaveLength(4);
    expect(ts.some((t) => t.text === 'note')).toBe(false); // comment dropped
  });

  it('rejects stray characters with a position', () => {
    expect(() => lex('fx\npop a n=1 col=#')).toThrow(FxSyntaxError);
    try {
      lex('fx\npop a size=1 & 2');
    } catch (e) {
      expect(e).toBeInstanceOf(FxSyntaxError);
      expect((e as FxSyntaxError).line).toBe(2);
      expect((e as FxSyntaxError).col).toBe(14);
    }
  });
});
