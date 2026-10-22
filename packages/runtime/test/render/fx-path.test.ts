// Synthetic polylines exercise FX path parsing and length-weighted particle placement.
import { describe, expect, it } from 'vitest';
import { compileProgram } from '../../src/render/fx/dsl/compile.ts';
import { lex } from '../../src/render/fx/dsl/lexer.ts';
import { parseValue, printAst } from '../../src/render/fx/dsl/parser.ts';
import { createFxSimulation } from '../../src/render/fx/sim/simulator.ts';

const POINTS = [[0, 0, 0], [1, 1, 0], [-1, 0, 1]];
const PATH_PROGRAM = 'fx\npop sample n=48 on=path(js{ [' + POINTS.map(([x, y, z]) => JSON.stringify([[x, y, z], [x, y! + 0.5, z]])).join(',') + '] }) life=1 v=up(0) size=.1 r=sprite(mote,add)\npop lamp n=1 at=point() r=light(<1,1,1>,1,2)';
const TIER = { low: false, mobile: false };

describe('fx path(js{…})', () => {
  it('lexes js{…} as one data token, braces balanced, and prints it', () => {
    const toks = lex('path(js{ [[0,1,2],{"a":[3]}] })');
    expect(toks.map((t) => t.kind)).toEqual(['ident', 'punct', 'js', 'punct', 'eof']);
    expect(toks[2]!.text.trim()).toBe('[[0,1,2],{"a":[3]}]');
    expect(printAst(parseValue('path(js{[[0,0,0],[0,1,0]]})'))).toBe('(path (js "[[0,0,0],[0,1,0]]"))');
  });
  it('compiles a synthetic program strictly and births on all supplied segments', () => {
    const program = compileProgram(PATH_PROGRAM, {}, TIER, { strict: true });
    const shape = program.pops[0]!.birth;
    expect(shape).toMatchObject({ kind: 'path' });
    const sim = createFxSimulation(program, { seed: 3, capacity: 64, origin: [10, 1, -4] });
    sim.step(0, 0, [10, 1, -4], 64);
    const samples = sim.populations[0]!;
    expect(samples.count).toBe(48);
    const near = new Set<number>();
    for (let s = 0; s < samples.count; s++) {
      const i = samples.indices[s]!;
      const p = [sim.positions[i * 3]! - 10, sim.positions[i * 3 + 1]! - 1, sim.positions[i * 3 + 2]! + 4];
      const k = POINTS.findIndex((w) => Math.hypot(p[0]! - w[0]!, p[2]! - w[2]!) < 1e-4 && p[1]! >= w[1]! - 1e-4 && p[1]! <= w[1]! + 0.5001);
      expect(k, `particle at ${p.join(',')}`).toBeGreaterThanOrEqual(0);
      near.add(k);
    }
    expect(near.size).toBe(3);
    sim.dispose();
  });
  it('one flat polyline is accepted; points are picked by length', () => {
    const program = compileProgram('fx\npop p n=400 on=path(js{[[0,0,0],[3,0,0],[3,1,0]]}) r=sprite(mote,add)', {}, TIER, { strict: true });
    const sim = createFxSimulation(program, { seed: 1, capacity: 512 });
    sim.step(0, 0, [0, 0, 0], 512);
    const pop = sim.populations[0]!;
    let onLong = 0;
    for (let s = 0; s < pop.count; s++) if (Math.abs(sim.positions[pop.indices[s]! * 3 + 1]!) < 1e-6) onLong++;
    expect(onLong / pop.count).toBeGreaterThan(0.65);
    expect(onLong / pop.count).toBeLessThan(0.85);
    sim.dispose();
  });
  it('negative: malformed data is a diagnostic (strict throws), not a crash', () => {
    expect(() => compileProgram('fx\npop p n=1 on=path(js{ not json }) r=sprite(mote,add)', {}, TIER, { strict: true })).toThrow(/path\(\) data/);
    expect(() => compileProgram('fx\npop p n=1 on=path(disc(1)) r=sprite(mote,add)', {}, TIER, { strict: true })).toThrow(/js\{/);
  });
});
