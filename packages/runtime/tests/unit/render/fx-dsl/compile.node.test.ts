import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  clearFxCache,
  compileProgram,
  FxCompileError,
  type CompiledPop,
  type CompiledProgram,
  type Expr,
  type FxDiagnostic,
} from '../../../../src/render/fx/dsl/compile.ts';

const DESK = { low: false, mobile: false };
const LOW = { low: true, mobile: false };
const MOBILE = { low: false, mobile: true };

/** the scene hearth of ashen-boulevard (fx.md:16-24 shape with params) */
const HEARTH = [
  'fx',
  'pop flame rate=flick(.45,.2)*%rate|60 on=disc(%r|.6) life=.5..0.95 v=up(1.8)+cone(24)*(.35..0.9) size=.35..0.7 acc=curl(.5)*1.3+buoy(2.4)+drag(1.5)',
  '  sz=$size*(.5>.25:1>.7:.72>.14) col=hdr(4.8,3.6,1.5)>.3:hdr(3.4,1.5,.35)>.65:hdr(1.9,.55,.12)>hdr(.7,.14,.03) a=0>.12:1>.75:.85>0 rot=spin(.2) r=sprite(flame-wisp,add)',
  'pop embers rate=?mobile:3|6 on=disc(%r|.6) life=.8..1.6 v=up(2.6)+cone(32)*(.4..1.3) size=.02..0.05 acc=curl(.8)*1.1+grav()*.4+drag(.5) sz=$size col=hdr(5,2.8,.8)>hdr(1,.22,.04) a=(0>.08:1>.65:.9>0)*flick(11,.35) r=sprite(ember,add,velocity,.02)',
  'pop smoke on=@flame?.3 inh=p;v:$v*.4 life=2.5..4 size=.5..0.8 acc=buoy(.9)+curl(.35)*.5+drag(.8) sz=$size*(.7>4) col=<.12,.1,.09> a=0>.3:.35>.7:.25>0 rot=spin(.15) r=sprite(smoke-puff,alpha)',
  'pop glow n=1 at=disc(.3).c(.8) glo=fire()*(#flame/40)~ r=light(<1,.5,.2>,$glo*%li|30,14)',
].join('\n');

const pop = (p: CompiledProgram, name: string): CompiledPop => {
  const found = p.pops.find((x) => x.name === name);
  if (!found) throw new Error(`no pop ${name}`);
  return found;
};
const num = (v: number): Expr => ({ k: 'num', v });

afterEach(() => {
  clearFxCache();
  vi.restoreAllMocks();
});

describe('compileProgram: structure', () => {
  it('compiles the hearth: emission, births, rolls, keyframes, fields, sinks', () => {
    const p = compileProgram(HEARTH, { li: 14, r: 0.9, rate: 40 }, DESK);
    expect(p.header).toEqual({});
    expect(p.pops.map((x) => x.name)).toEqual(['flame', 'embers', 'smoke', 'glow']);
    expect(p.diagnostics).toEqual([]);

    const flame = pop(p, 'flame');
    expect(flame.emit).toEqual({ kind: 'rate', perSec: { k: 'bin', op: '*', a: { k: 'call', fn: 'flick', args: [num(0.45), num(0.2)] }, b: num(40) } });
    expect(flame.birth).toEqual({ kind: 'disc', r: 0.9, lift: 0, mode: 'on' });
    expect(flame.life).toEqual({ lo: 0.5, hi: 0.95 });
    expect(flame.size).toEqual({ lo: 0.35, hi: 0.7 });
    expect(flame.v).toEqual({
      k: 'bin',
      op: '+',
      a: { k: 'call', fn: 'up', args: [num(1.8)] },
      b: { k: 'bin', op: '*', a: { k: 'call', fn: 'cone', args: [num(24)] }, b: { k: 'roll', lo: num(0.35), hi: num(0.9), slot: 0 } },
    });
    expect(flame.rolls).toBe(1);
    expect(flame.acc).toEqual([
      { field: 'curl', args: [num(0.5)], scale: num(1.3) },
      { field: 'buoy', args: [num(2.4)], scale: num(1) },
      { field: 'drag', args: [num(1.5)], scale: num(1) },
    ]);
    expect(flame.sz).toEqual({
      k: 'bin',
      op: '*',
      a: { k: 'attr', name: 'size' },
      b: { k: 'keys', frames: [{ t: 0, v: num(0.5) }, { t: 0.25, v: num(1) }, { t: 0.7, v: num(0.72) }, { t: 1, v: num(0.14) }] },
    });
    expect(flame.col).toEqual({
      k: 'keys',
      frames: [
        { t: 0, v: { k: 'v3', v: [4.8, 3.6, 1.5] } },
        { t: 0.3, v: { k: 'v3', v: [3.4, 1.5, 0.35] } },
        { t: 0.65, v: { k: 'v3', v: [1.9, 0.55, 0.12] } },
        { t: 1, v: { k: 'v3', v: [0.7, 0.14, 0.03] } },
      ],
    });
    expect(flame.rot).toEqual({ k: 'call', fn: 'spin', args: [num(0.2)] });
    expect(flame.sink).toEqual({ kind: 'sprite', tex: 'flame-wisp', blend: 'add' });

    const embers = pop(p, 'embers');
    expect(embers.emit).toEqual({ kind: 'rate', perSec: num(6) });
    expect(embers.acc.map((t) => t.field)).toEqual(['curl', 'grav', 'drag']);
    expect(embers.sink).toEqual({ kind: 'sprite', tex: 'ember', blend: 'add', align: 'velocity', stretch: 0.02 });

    const smoke = pop(p, 'smoke');
    expect(smoke.emit).toEqual({ kind: 'child' });
    expect(smoke.birth).toEqual({
      kind: 'parent',
      parent: 'flame',
      p: 0.3,
      inherit: { position: true, attrs: { v: { k: 'bin', op: '*', a: { k: 'attr', name: 'v' }, b: num(0.4) } } },
    });
    expect(smoke.col).toEqual({ k: 'v3', v: [0.12, 0.1, 0.09] });

    const glow = pop(p, 'glow');
    expect(glow.emit).toEqual({ kind: 'held', n: { lo: 1, hi: 1 } });
    expect(glow.birth).toEqual({ kind: 'disc', r: 0.3, lift: 0.8, mode: 'at' });
    expect(glow.custom).toEqual({
      glo: { k: 'bin', op: '*', a: { k: 'call', fn: 'fire', args: [] }, b: { k: 'smooth', a: { k: 'bin', op: '/', a: { k: 'count', pop: 'flame' }, b: num(40) } } },
    });
    expect(glow.sink).toEqual({
      kind: 'light',
      color: { k: 'v3', v: [1, 0.5, 0.2] },
      intensity: { k: 'bin', op: '*', a: { k: 'attr', name: 'glo' }, b: num(14) },
      radius: num(14),
    });
  });

  it('defaults: drawn size is $size, colour white, alpha 1, birth at the anchor', () => {
    const p = compileProgram('fx\npop a burst=1 life=.1 size=.2 r=sprite(soft-disc,add)', {}, DESK);
    const a = pop(p, 'a');
    expect(a.emit).toEqual({ kind: 'burst', count: { lo: 1, hi: 1 } });
    expect(a.sz).toEqual({ k: 'attr', name: 'size' });
    expect(a.col).toEqual({ k: 'v3', v: [1, 1, 1] });
    expect(a.a).toEqual(num(1));
    expect(a.birth).toEqual({ kind: 'point', lift: 0, mode: 'on' });
    expect(a.v).toBeNull();
    expect(a.acc).toEqual([]);
  });

  it('header, windows, wraps, floors, shapes and the remaining sinks', () => {
    const text = [
      'fx follow=camera',
      'pop a n=4 on=box(30,10,30).c(8) wrap=30;10;30 life=6..10 floor=die r=sprite(chip,alpha)',
      'pop b rate=220 win=0;.2 on=sphere(.9) life=.3 floor=bounce r=mesh(box,.8,.8,1.7,velocity)',
      'pop c burst=3 on=box(<.5,1,.35>) life=1 floor=bounce(.32) r=mesh(box,1,1,1)',
      'pop d burst=1 at=point().c(1.1) life=.9 floor=stick r=sprite(soft-disc,alpha,axis,9.5,0,axis=<0,1,0>)',
      'pop e burst=1 life=.5 size=2 col=<.012,.004,0> r=sprite(soft-disc,distort)',
    ].join('\n');
    const p = compileProgram(text, {}, DESK);
    expect(p.header).toEqual({ follow: 'camera' });
    expect(pop(p, 'a')).toMatchObject({ birth: { kind: 'box', half: [30, 10, 30], lift: 8, mode: 'on' }, wrap: [30, 10, 30], floor: 'die' });
    expect(pop(p, 'b')).toMatchObject({ window: [0, 0.2], birth: { kind: 'sphere', r: 0.9 }, floor: { bounce: 0.3 }, sink: { kind: 'mesh', shape: 'box', sx: 0.8, sy: 0.8, sz: 1.7, align: 'velocity' } });
    expect(pop(p, 'c')).toMatchObject({ birth: { kind: 'box', half: [0.5, 1, 0.35] }, floor: { bounce: 0.32 }, sink: { kind: 'mesh', shape: 'box', sx: 1, sy: 1, sz: 1 } });
    expect(pop(p, 'c').sink).not.toHaveProperty('align');
    expect(pop(p, 'd')).toMatchObject({ birth: { kind: 'point', lift: 1.1, mode: 'at' }, floor: 'stick' });
    expect(pop(p, 'd').sink).toEqual({ kind: 'sprite', tex: 'soft-disc', blend: 'alpha', align: 'axis', stretch: 9.5, soft: 0, axis: [0, 1, 0] });
    expect(pop(p, 'e').sink).toEqual({ kind: 'sprite', tex: 'soft-disc', blend: 'distort' });
  });

  it('keyframe times: first 0, last 1, bare middles evenly spaced, times kept monotonic', () => {
    const k = (src: string): number[] => {
      const a = pop(compileProgram(`fx\npop a burst=1 a=${src}`, {}, DESK), 'a').a;
      if (a.k !== 'keys') throw new Error(`not a keyframe envelope: ${a.k}`);
      return a.frames.map((f) => f.t);
    };
    expect(k('1>0')).toEqual([0, 1]);
    expect(k('0>.5>1>0')).toEqual([0, 1 / 3, 2 / 3, 1]);
    expect(k('0>.4:1>.5>.9:.2>0')).toEqual([0, 0.4, 0.65, 0.9, 1]);
    // `.5>.9:1>.6:.4` (scripts/effects/programs.js muzzle flash sz): a later time earlier than its predecessor holds it
    expect(k('.5>.9:1>.6:.4')).toEqual([0, 0.9, 0.9]);
  });

  it('acc: products distribute over parenthesised sums (gore slowProg re-timing)', () => {
    const p = compileProgram('fx\npop a burst=1 life=1 acc=(grav()+drag(.32))*0.25 v=(<%dir|0,1,0>*(3..6.8)+sdir()*(.3..1))*0.5', { dir: { x: 0, y: 0, z: -1 } }, DESK);
    const a = pop(p, 'a');
    expect(a.acc).toEqual([
      { field: 'grav', args: [], scale: num(0.25) },
      { field: 'drag', args: [num(0.32)], scale: num(0.25) },
    ]);
    expect(a.rolls).toBe(2);
    expect(JSON.stringify(a.v)).toContain('"v":[0,0,-1]');
  });
});

describe('compileProgram: params and tiers', () => {
  it('substitutes scalar, vector and per-component params; falls back to defaults', () => {
    const text = 'fx\npop a burst=%n|40 life=%life|.08 v=<%dir|0,0,-1>*260 col=<%gr|.5,%gg|.16,%gb|.04> size=2.8*%k|1 r=sprite(ember,add)';
    const d = pop(compileProgram(text, {}, DESK), 'a');
    expect(d.emit).toEqual({ kind: 'burst', count: { lo: 40, hi: 40 } });
    expect(d.life).toEqual({ lo: 0.08, hi: 0.08 });
    expect(d.v).toEqual({ k: 'v3', v: [0, 0, -260] });
    expect(d.col).toEqual({ k: 'v3', v: [0.5, 0.16, 0.04] });
    expect(d.size).toEqual({ lo: 2.8, hi: 2.8 });
    const g = pop(compileProgram(text, { n: 12, life: 0.5, dir: [1, 0, 0], gr: 1, gg: 0, gb: 0, k: 0.5 }, DESK), 'a');
    expect(g.emit).toEqual({ kind: 'burst', count: { lo: 12, hi: 12 } });
    expect(g.v).toEqual({ k: 'v3', v: [260, 0, 0] });
    expect(g.col).toEqual({ k: 'v3', v: [1, 0, 0] });
    expect(g.size).toEqual({ lo: 1.4, hi: 1.4 });
    expect(pop(compileProgram(text, { dir: { x: 0, y: 1, z: 0 } }, DESK), 'a').v).toEqual({ k: 'v3', v: [0, 260, 0] });
  });

  it('refuses a NaN in a number slot and a missing param without default (sk/fx:9)', () => {
    expect(() => compileProgram('fx\npop a burst=%n|4 r=sprite(ember,add)', { n: Number.NaN }, DESK, { strict: true })).toThrow(FxCompileError);
    expect(() => compileProgram('fx\npop a burst=%n r=sprite(ember,add)', {}, DESK, { strict: true })).toThrow(/param %n/);
    const diags: FxDiagnostic[] = [];
    const p = compileProgram('fx\npop a burst=%n|4 r=sprite(ember,add)', { n: 'x' }, DESK, { strict: false, onDiagnostic: (d) => diags.push(d) });
    expect(diags.map((d) => d.code)).toEqual(['param']);
    expect(pop(p, 'a').emit).toEqual({ kind: 'burst', count: { lo: 4, hi: 4 } });
  });

  it('resolves ?low and ?mobile from the tier at compile time', () => {
    const text = 'fx\npop a n=?low:200|500 r=sprite(chip,alpha)\npop b rate=?mobile:14|26 r=sprite(ember,add)';
    expect(pop(compileProgram(text, {}, DESK), 'a').emit).toEqual({ kind: 'held', n: { lo: 500, hi: 500 } });
    expect(pop(compileProgram(text, {}, LOW), 'a').emit).toEqual({ kind: 'held', n: { lo: 200, hi: 200 } });
    expect(pop(compileProgram(text, {}, DESK), 'b').emit).toEqual({ kind: 'rate', perSec: num(26) });
    expect(pop(compileProgram(text, {}, MOBILE), 'b').emit).toEqual({ kind: 'rate', perSec: num(14) });
  });

  it('caches by (text, params, tier)', () => {
    const a = compileProgram(HEARTH, { r: 1 }, DESK);
    expect(compileProgram(HEARTH, { r: 1 }, DESK)).toBe(a);
    expect(compileProgram(HEARTH, { r: 2 }, DESK)).not.toBe(a);
    expect(compileProgram(HEARTH, { r: 1 }, MOBILE)).not.toBe(a);
    expect(compileProgram(HEARTH, { r: 1 }, DESK, { cache: false })).not.toBe(a);
  });
});

describe('compileProgram: unknown tokens', () => {
  const unknown: Array<[string, string]> = [
    ['fx\npop a burst=1 v=wobble(2) r=sprite(ember,add)', "unknown function 'wobble'"],
    ['fx\npop a burst=1 size=.2.wiggle() r=sprite(ember,add)', "unknown method '.wiggle'"],
    ['fx\npop a burst=1 lfe=1 r=sprite(ember,add)', "unknown attribute 'lfe'"],
    ['fx\npop a burst=1 r=sprite(sparkle,add)', "unknown sprite texture 'sparkle'"],
    ['fx\npop a burst=1 r=sprite(ember,glow)', "unknown blend 'glow'"],
    ['fx\npop a burst=1 r=ribbon(1)', "unknown sink 'ribbon'"],
    ['fx\npop a burst=1 sz=$heat r=sprite(ember,add)', "unknown attribute '$heat'"],
    ['fx\npop a rate=#flames r=sprite(ember,add)', "unknown population '#flames'"],
    ['fx\npop a on=@nope?.5 r=sprite(ember,add)', "unknown population '@nope'"],
    ['fx\npop a burst=1 on=hexagon(2) r=sprite(ember,add)', "unknown shape 'hexagon'"],
    ['fx\npop a burst=1 floor=splat r=sprite(ember,add)', "unknown floor mode 'splat'"],
    ['fx\npop a n=?ultra:1|2 r=sprite(ember,add)', "unknown flag '?ultra'"],
    ['fx\npop a burst=1 acc=up(2) r=sprite(ember,add)', "'up' is not an acceleration field"],
    ['fx follow=sky\npop a burst=1 r=sprite(ember,add)', "unknown follow target 'sky'"],
    ['fx\npop a burst=1 r=sprite(ember,add) colour=1', "unknown attribute 'colour'"],
  ];

  it.each(unknown)('strict mode throws with position: %s', (text, message) => {
    let err: unknown = null;
    try {
      compileProgram(text, {}, DESK, { strict: true });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FxCompileError);
    const d = (err as FxCompileError).diagnostic;
    expect(d.message).toContain(message);
    expect(d.line).toBeGreaterThan(0);
    expect(d.col).toBeGreaterThan(0);
    expect((err as FxCompileError).message).toContain('^'); // excerpt with a caret
  });

  it('lenient mode reports once and skips the token', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const text = 'fx\npop a burst=1 v=wobble(2)+up(1) acc=grav()+zap(3) life=.5 r=sprite(sparkle,add)\npop b burst=1 r=light(<1,1,1>,4,3)';
    const p = compileProgram(text, {}, DESK, { strict: false });
    expect(p.diagnostics.map((d) => d.code)).toEqual(['unknown-token', 'unknown-token', 'unknown-token']);
    const a = pop(p, 'a');
    expect(a.v).toBeNull(); // the attribute holding the unknown token falls back to its default
    expect(a.acc).toEqual([{ field: 'grav', args: [], scale: num(1) }]); // an unknown field term is dropped alone
    expect(a.life).toEqual({ lo: 0.5, hi: 0.5 });
    expect(a.sink).toEqual({ kind: 'sprite', tex: 'soft-disc', blend: 'add' });
    expect(pop(p, 'b').sink?.kind).toBe('light');
    expect(warn).toHaveBeenCalledTimes(3);
    compileProgram(text, {}, DESK, { strict: false, cache: false });
    expect(warn).toHaveBeenCalledTimes(3); // logged once per distinct diagnostic
  });

  it('a malformed program is a syntax diagnostic (strict throws, lenient skips the attribute)', () => {
    expect(() => compileProgram('fx\npop a n=(1 r=sprite(ember,add)', {}, DESK, { strict: true })).toThrow(FxCompileError);
    const diags: FxDiagnostic[] = [];
    const p = compileProgram('fx\npop a n=(1 burst=2 r=sprite(ember,add)', {}, DESK, { strict: false, onDiagnostic: (d) => diags.push(d) });
    expect(diags.map((d) => d.code)).toEqual(['syntax']);
    expect(pop(p, 'a').emit).toEqual({ kind: 'burst', count: { lo: 2, hi: 2 } });
  });

  it('more than 8 populations is refused (api:1566)', () => {
    const text = ['fx', ...Array.from({ length: 9 }, (_, i) => `pop p${i} burst=1 r=sprite(ember,add)`)].join('\n');
    expect(() => compileProgram(text, {}, DESK, { strict: true })).toThrow(/8 populations/);
  });
});
