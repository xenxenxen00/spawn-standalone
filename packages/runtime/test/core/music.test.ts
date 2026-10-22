import { describe, expect, it } from 'vitest';
import { createNullMusicPort, type MusicPort } from '../../src/ports/index.ts';
import { testWorld } from './world.ts';

const PLAYER = { 'scripts/player.js': {}, 'templates/player.js': { player: { behavior: ['scripts/player.js'], tags: ['player'] } } };
const human = (w: Awaited<ReturnType<typeof testWorld>>) => w.k.spawnHuman({ place: 'p1', at: { x: 0, y: 0, z: 0 }, userId: 'u', displayName: 'Op', durableState: {} });

describe('K6: ctx.music routed to a MusicPort', () => {
  it('default (PP): ctx.music is undefined', async () => {
    const w = await testWorld({ modules: PLAYER });
    expect((w.ctx(human(w)) as any).music).toBeUndefined();
    expect((w.rootSim({}).ctx as any).music).toBeUndefined();
  });

  it('play, stop and duck reach the port in every game realm', async () => {
    const log: unknown[][] = [];
    const port: MusicPort = {
      play: (...a) => void log.push(['play', ...a]),
      stop: (...a) => void log.push(['stop', ...a]),
      duck: (...a) => void log.push(['duck', ...a]),
    };
    const w = await testWorld({ modules: PLAYER, ext: { music: port } });
    const sim = w.rootSim({}).ctx as any;
    sim.music.play('calm', { fade: 1.5, layer: 'entrance', loop: false });
    sim.music.stop({ fade: 1.5 });
    (w.ctx(human(w)) as any).music.duck(0.3, { duration: 2 });
    expect(log).toEqual([
      ['play', 'calm', { fade: 1.5, layer: 'entrance', loop: false }],
      ['stop', { fade: 1.5 }],
      ['duck', 0.3, { duration: 2 }],
    ]);
  });

  it('a bad argument or a throwing port never throws into the game (reported once)', async () => {
    const port: MusicPort = { play: () => { throw new Error('boom'); }, stop: () => { throw new Error('boom'); }, duck() {} };
    const w = await testWorld({ modules: PLAYER, ext: { music: port } });
    const m = (w.rootSim({}).ctx as any).music;
    expect(() => { m.play('x'); m.play('y'); m.stop(); m.play(undefined); m.duck('loud'); m.duck(NaN); }).not.toThrow();
    expect(w.logged.filter((l) => /music port threw/.test(l.text))).toHaveLength(1);
  });

  it('music: true installs a no-op (an unguarded ctx.music.duck is safe); the null port is a no-op too', async () => {
    const w = await testWorld({ modules: PLAYER, ext: { music: true } });
    const m = (w.rootSim({}).ctx as any).music;
    expect(() => { m.play('a'); m.stop(); m.duck(0.5, { duration: 1 }); }).not.toThrow();
    const p = createNullMusicPort();
    expect(() => { p.play('a'); p.stop(); p.duck(1); }).not.toThrow();
  });
});
