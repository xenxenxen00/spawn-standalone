// Late-bound vector params (src/render/fx/dsl/compile.ts `ProgramTemplate`, cpu-budget CPU1 1.5): a gore spray passes its own
// `dir`, so its exact cache key never repeats. A program whose vector params are plain leaves of the compiled tree is kept as
// a template and re-instantiated for the next value. The program must be the one a fresh compile gives, number for number.
import { describe, expect, it } from 'vitest';
import { clearFxCache, compileProgram } from '../../../../src/render/fx/dsl/compile.ts';

const DESK = { low: false, mobile: false };

/** the first difference between two compiled values (numbers by Object.is, so -0 is not 0), or null */
function difference(a: unknown, b: unknown, path = 'program'): string | null {
  if (typeof a === 'number' || typeof b === 'number') return Object.is(a, b) ? null : `${path}: ${String(a)} vs ${String(b)}`;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b ? null : `${path}: ${String(a)} vs ${String(b)}`;
  const ka = Object.keys(a), kb = Object.keys(b);
  if (ka.join() !== kb.join()) return `${path}: keys ${ka.join()} vs ${kb.join()}`;
  for (const k of ka) {
    const d = difference((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}


describe('compileProgram: late-bound vector params', () => {
  it('keeps a vector param whose numbers the compiler reads out of the template: folded, collapsed or a constant vector', () => {
    clearFxCache();
    const folded = 'fx\npop a burst=4 life=1 v=<%dir|0,0,-1>*260 r=sprite(ember,add)';
    const a = compileProgram(folded, { dir: [1, 0, 0] }, DESK);
    const b = compileProgram(folded, { dir: [0, 1, 0] }, DESK);
    expect(a.pops[0]!.v).toEqual({ k: 'v3', v: [260, 0, 0] });
    expect(b.pops[0]!.v).toEqual({ k: 'v3', v: [0, 260, 0] });
    expect(b.header).not.toBe(a.header);
    const negated = 'fx\npop a burst=4 life=1 v=-<%dir|0,0,-1>*(1..2) r=sprite(ember,add)';
    compileProgram(negated, { dir: [1, 0, 0] }, DESK);
    expect(difference(compileProgram(negated, { dir: [0, -0, 1] }, DESK), compileProgram(negated, { dir: [0, -0, 1] }, DESK, { cache: false }))).toBeNull();
    const axis = 'fx\npop a burst=1 life=1 r=sprite(soft-disc,add,axis,2,axis=%dir|0,1,0)';
    compileProgram(axis, { dir: [1, 0, 0] }, DESK, { strict: false, onDiagnostic: () => {} });
    expect(difference(compileProgram(axis, { dir: [0, 0, 1] }, DESK, { strict: false, onDiagnostic: () => {} }), compileProgram(axis, { dir: [0, 0, 1] }, DESK, { strict: false, cache: false, onDiagnostic: () => {} }))).toBeNull();
    // a range whose ends are equal constants collapses to its low end: for this value of the param only
    const collapsed = 'fx\npop a burst=4 life=1 v=<%dir|0,1,0>..<1,0,0> r=sprite(ember,add)';
    expect(compileProgram(collapsed, { dir: [1, 0, 0] }, DESK).pops[0]!.v).toEqual({ k: 'v3', v: [1, 0, 0] });
    const other = compileProgram(collapsed, { dir: [0, 0, 1] }, DESK);
    expect(other.pops[0]!.v?.k).toBe('roll');
    expect(difference(other, compileProgram(collapsed, { dir: [0, 0, 1] }, DESK, { cache: false }))).toBeNull();
  });

  it('shares the nodes a param does not reach, and rebuilds the ones it does', () => {
    clearFxCache();
    const text = 'fx\npop d burst=4 life=1 v=<%dir|0,1,0>*(2..3)+sdir() col=<1,.5,.5>>.2 r=mesh(box,1,1,1)\npop m burst=2 life=1 v=sdir() r=mesh(box,1,1,1)';
    const a = compileProgram(text, { dir: { x: 1, y: 0, z: 0 } }, DESK);
    const b = compileProgram(text, { dir: { x: 0, y: 0, z: 1 } }, DESK);
    expect(b).not.toBe(a);
    expect(b.pops[1]).toBe(a.pops[1]);
    expect(b.pops[0]!.col).toBe(a.pops[0]!.col);
    expect(b.pops[0]!.v).not.toBe(a.pops[0]!.v);
    expect(JSON.stringify(b.pops[0]!.v)).toContain('[0,0,1]');
    expect(b.diagnostics).toEqual([]);
    expect(b.diagnostics).not.toBe(a.diagnostics);
  });

  it('never takes a template for a value that is not a finite vector, nor for a name bound in another way', () => {
    clearFxCache();
    const text = 'fx\npop d burst=4 life=1 v=<%dir|0,1,0>*(2..3) r=mesh(box,1,1,1)';
    compileProgram(text, { dir: [1, 0, 0] }, DESK);
    const diags: unknown[] = [];
    const nan = compileProgram(text, { dir: [Number.NaN, 0, 0] }, DESK, { strict: false, onDiagnostic: (d) => diags.push(d) });
    expect(diags).toHaveLength(1);
    expect(JSON.stringify(nan.pops[0]!.v)).toContain('[0,1,0]');
    // a string that spells the template marker is a string, not a late-bound vector (the template of a compile where that
    // param was a vector has the same key; it binds another set of names)
    compileProgram(text, { dir: [0, 1, 0], other: [1, 2, 3] }, DESK);
    const marker = compileProgram(text, { dir: [1, 0, 0], other: '\u0000late' }, DESK);
    expect(difference(marker, compileProgram(text, { dir: [1, 0, 0], other: '\u0000late' }, DESK, { cache: false }))).toBeNull();
  });
});
