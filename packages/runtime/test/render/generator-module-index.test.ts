// Opt-in generator resolution from a module index keyed by tree path (a game whose generators are not under scripts/gen/).
import { describe, expect, it } from 'vitest';
import { createJobRunner, moduleLoaderFromModules, serveGeneratorModules, type GenJob, type ToWorker } from '../../src/render/geometry/geometry-worker.ts';

const gen = { geometry: (ctx: { tri: (...v: number[]) => void }) => ctx.tri(0, 0, 0, 1, 0, 0, 0, 1, 0) };
const index = {
  'scripts/hall/crate.js': async () => gen,
  './scripts/halloween/pumpkin.js': async () => gen,
  'scripts/behaviours/zombie.js': async () => ({ onTick() {} }),
};

describe('moduleLoaderFromModules', () => {
  it('resolves tree paths outside scripts/gen, normalising both sides', async () => {
    const load = moduleLoaderFromModules(index);
    expect(await load('scripts/hall/crate.js')).toBe(gen);
    expect(await load('/scripts/halloween/pumpkin.js')).toBe(gen);
  });
  it('rejects an unknown script and (with roots) a module outside them', async () => {
    const load = moduleLoaderFromModules(index, { roots: ['scripts/hall/', 'scripts/halloween/'] });
    await expect(load('scripts/gen/x.js')).rejects.toThrow('unknown generator script scripts/gen/x.js');
    await expect(load('scripts/behaviours/zombie.js')).rejects.toThrow(/unknown generator script/);
    expect(await load('scripts/hall/crate.js')).toBe(gen);
  });
  it('drives a job runner and serveGeneratorModules answers a job on the scope', async () => {
    const job: GenJob = { id: 1, script: 'scripts/hall/crate.js', params: {}, seed: 1, lods: [1], collider: false };
    const out = await createJobRunner(moduleLoaderFromModules(index))(job);
    expect(out.script).toBe('scripts/hall/crate.js');
    const sent: unknown[] = [];
    let handler: ((ev: { data: unknown }) => void) | undefined;
    serveGeneratorModules(index, {}, { postMessage: (m: unknown) => void sent.push(m), addEventListener: (_t: string, fn: never) => (handler = fn) } as never);
    handler!({ data: { type: 'job', job } satisfies ToWorker });
    await new Promise((r) => setTimeout(r, 20));
    expect(sent[0]).toMatchObject({ type: 'done', id: 1 });
  });
});
