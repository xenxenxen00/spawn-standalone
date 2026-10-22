import { describe, expect, it } from 'vitest';
import { FxSyntaxError } from '../../../../src/render/fx/dsl/lexer.ts';
import { parseProgram, parseValue, printAst, type ExprAst } from '../../../../src/render/fx/dsl/parser.ts';

/** print one value as the parser reads it */
const v = (src: string): string => printAst(parseValue(src));

describe('fx parser: values', () => {
  it('keyframe envelopes over ranges over sums over products', () => {
    expect(v('0>.12:1>.75:.85>0')).toBe('(keys 0 (@ 0.12 1) (@ 0.75 0.85) 0)');
    expect(v('$size*(.5>.25:1>.7:.72>.14)')).toBe('(* $size (keys 0.5 (@ 0.25 1) (@ 0.7 0.72) 0.14))');
    expect(v('.7>4')).toBe('(keys 0.7 4)');
    expect(v('sdir()*(1.6..4*%k|1)')).toBe('(* (sdir) (.. 1.6 (* 4 %k|1)))');
    expect(v('up(4..7)+cone(25)*(1..2)')).toBe('(+ (up (.. 4 7)) (* (cone 25) (.. 1 2)))');
    expect(v('<%r|1,0,0>*(-.4..0.1)')).toBe('(* %r|<1,0,0> (.. -0.4 0.1))');
    expect(v('$a-$b/2')).toBe('(- $a (/ $b 2))');
    expect(v('$age*$spin')).toBe('(* $age $spin)');
  });

  it('vectors close before a keyframe arrow, and vector ranges', () => {
    expect(v('<.12,.06,.03>><.05,.04,.035>><.03,.025,.025>')).toBe('(keys (vec 0.12 0.06 0.03) (vec 0.05 0.04 0.035) (vec 0.03 0.025 0.025))');
    expect(v('<.46,.33,.2>..<.32,.22,.13>')).toBe('(.. (vec 0.46 0.33 0.2) (vec 0.32 0.22 0.13))');
    expect(v('hdr(3,3,3.4)>.4:<.55,.55,.6>')).toBe('(keys (hdr 3 3 3.4) (@ 0.4 (vec 0.55 0.55 0.6)))');
  });

  it('param defaults: scalar, whole-vector and per-component', () => {
    expect(v('<%dir|0,0,-1>*260')).toBe('(* %dir|<0,0,-1> 260)');
    const p = parseValue('<%dir|0,0,-1>') as ExprAst;
    expect(p).toMatchObject({ t: 'param', name: 'dir', def: [0, 0, -1] });
    expect(v('<%gr|.5,%gg|.16,%gb|.04>')).toBe('(vec %gr|0.5 %gg|0.16 %gb|0.04)');
    expect(v('light(<1,.5,.2>,$glo*%li|30,14)')).toBe('(light (vec 1 0.5 0.2) (* $glo %li|30) 14)');
    expect(v('light(<1,.45,.15>,$g*%li|400,%ld|90)')).toBe('(light (vec 1 0.45 0.15) (* $g %li|400) %ld|90)');
    expect(v('%life')).toBe('%life');
    expect(v('%x|-2')).toBe('%x|-2');
  });

  it('calls with space-separated, keyframed and named arguments; methods; smoothing; queries', () => {
    expect(v('oklch(.29 .155 24)>.5:oklch(.32 .02 250)')).toBe('(keys (oklch 0.29 0.155 24) (@ 0.5 (oklch 0.32 0.02 250)))');
    expect(v('light(<.35,.9,1>,(1>0)*6,7)')).toBe('(light (vec 0.35 0.9 1) (* (keys 1 0) 6) 7)');
    expect(v('sprite(soft-disc,add,axis,9,axis=<0,1,0>)')).toBe('(sprite soft-disc add axis 9 :axis (vec 0 1 0))');
    expect(v('disc(%r|6).c(4)')).toBe('(.c (disc %r|6) 4)');
    expect(v('fire()*(#flame/40)~')).toBe('(* (fire) (~ (/ #flame 40)))');
    expect(v('?low:200|500')).toBe('(?low 200 500)');
    expect(v('?mobile:.5|1.2')).toBe('(?mobile 0.5 1.2)');
    expect(v('flick(.45,.2)*%rate|60')).toBe('(* (flick 0.45 0.2) %rate|60)');
    expect(v('(grav()+drag(.32))*0.25')).toBe('(* (+ (grav) (drag 0.32)) 0.25)');
  });

  it('lists and parent births', () => {
    expect(v('p;v:$v*.4')).toBe('(; p (v: (* $v 0.4)))');
    expect(v('30;10;30')).toBe('(; 30 10 30)');
    expect(v('0;.2')).toBe('(; 0 0.2)');
    expect(v('@flame?.3')).toBe('(@flame 0.3)');
    expect(v('@spark')).toBe('(@spark)');
  });

  it('a value ends at the first top-level whitespace', () => {
    expect(() => parseValue('1 + 2')).toThrow(FxSyntaxError);
    expect(v('oklch(.86 .10 88)..oklch(.70 .11 75)')).toBe('(.. (oklch 0.86 0.1 88) (oklch 0.7 0.11 75))');
  });
});

describe('fx parser: programs', () => {
  it('header, pops, continuation lines and comments', () => {
    const text = [
      'fx follow=camera',
      '// weather slab',
      'pop ash n=?low:200|500 on=box(30,10,30).c(8) wrap=30;10;30 life=6..10',
      '  sz=$size r=sprite(chip,alpha)',
      'pop glow n=1 at=disc(.3).c(.8) glo=fire()*(#ash/40)~ r=light(<1,.5,.2>,$glo*%li|30,14)',
    ].join('\n');
    const ast = parseProgram(text);
    expect(ast.header.map((a) => a.key)).toEqual(['follow']);
    expect(ast.pops.map((p) => p.name)).toEqual(['ash', 'glow']);
    expect(ast.pops[0]?.attrs.map((a) => a.key)).toEqual(['n', 'on', 'wrap', 'life', 'sz', 'r']);
    expect(printAst(ast)).toBe(
      [
        '(fx (follow camera)',
        '  (pop ash',
        '    (n (?low 200 500))',
        '    (on (.c (box 30 10 30) 8))',
        '    (wrap (; 30 10 30))',
        '    (life (.. 6 10))',
        '    (sz $size)',
        '    (r (sprite chip alpha)))',
        '  (pop glow',
        '    (n 1)',
        '    (at (.c (disc 0.3) 0.8))',
        '    (glo (* (fire) (~ (/ #ash 40))))',
        '    (r (light (vec 1 0.5 0.2) (* $glo %li|30) 14))))',
      ].join('\n'),
    );
  });

  it('accepts a template-literal program with a trailing newline and CRLF line ends', () => {
    expect(parseProgram('fx\r\npop a burst=1 life=.1 r=light(<1,1,1>,4,3)\r\n').pops).toHaveLength(1);
  });

  it('reports malformed programs with line and column', () => {
    const cases: Array<[string, number, number]> = [
      ['pop a n=1', 1, 1], // no fx header
      ['fx\npop', 2, 4], // pop without a name
      ['fx\npop a n', 2, 8], // key without '='
      ['fx\npop a n=(1', 2, 11], // unclosed paren
      ['fx\npop a n= 1', 2, 10], // value after whitespace
      ['fx\n  n=1', 2, 3], // continuation before any pop
      ['fx\npop a col=<1,2', 2, 15], // unclosed vector
      ['fx\npop a n=?low:1', 2, 15], // query without '|'
    ];
    for (const [src, line, col] of cases) {
      let err: unknown = null;
      try {
        parseProgram(src);
      } catch (e) {
        err = e;
      }
      expect(err, src).toBeInstanceOf(FxSyntaxError);
      expect([(err as FxSyntaxError).line, (err as FxSyntaxError).col], src).toEqual([line, col]);
    }
  });

  it('recovers per attribute when asked to (production: log and skip)', () => {
    const errors: FxSyntaxError[] = [];
    const ast = parseProgram('fx\npop a n=(1 life=1 & r=light(<1,1,1>,4,3)\npop b burst=1', { onError: (e) => errors.push(e) });
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(ast.pops.map((p) => p.name)).toEqual(['a', 'b']);
    expect(ast.pops[0]?.attrs.map((a) => a.key)).toEqual(['life', 'r']);
  });
});
