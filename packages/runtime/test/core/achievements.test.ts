import { describe, expect, it } from 'vitest';
import { createAchievementsPort, createLeaderboardPort } from '../../src/ports/index.ts';
import { submitScore } from '../../src/compat/core/achievements.ts';
import { testWorld, type Module } from './world.ts';

const MODULES: Record<string, Module> = { 'templates/player.js': { player: { tags: ['player'] } } };
const defs = {
  boss: { name: 'Boss' },
  kills: { name: 'Killer', stat: 'kills', target: 2 },
  act2: { name: 'Act 2', step: 2 },
};
const settle = () => new Promise((r) => setTimeout(r, 0));
const human = (w: Awaited<ReturnType<typeof testWorld>>) => w.k.spawnHuman({ place: 'p1', at: { x: 0, y: 0, z: 0 }, userId: 'u-7', displayName: 'Op', durableState: {} });
const stateOf = (w: Awaited<ReturnType<typeof testWorld>>) => w.k.store.get('player/local')!.state['achievements'];

describe('K9: ext.achievements / ext.leaderboards', () => {
  it('forwards milestone and stat and mirrors unlockedIds into player.state.achievements', async () => {
    const port = createAchievementsPort({ defs });
    const w = await testWorld({ modules: MODULES, ext: { achievements: port } });
    human(w);
    await settle();
    expect(stateOf(w)).toEqual([]);
    const sim = w.rootSim({}).ctx as any;
    sim.emit('milestone', { name: 'boss' });
    await settle();
    expect(stateOf(w)).toEqual(['boss']);
    sim.emit('stat', { name: 'kills', value: 1 });
    sim.emit('stat', { name: 'kills' });
    await settle();
    expect(stateOf(w)).toEqual(['boss', 'kills']);
    sim.emit('milestone', { step: 2 });
    await settle();
    expect(stateOf(w)).toEqual(['boss', 'kills', 'act2']);
  });

  it('the body spawned after earlier unlocks starts with the stored ids', async () => {
    const port = createAchievementsPort({ defs });
    await port.unlock('boss');
    const w = await testWorld({ modules: MODULES, ext: { achievements: port } });
    human(w);
    await settle();
    expect(stateOf(w)).toEqual(['boss']);
  });

  it('a stat custom event still reaches game listeners', async () => {
    const port = createAchievementsPort({ defs });
    const w = await testWorld({ modules: MODULES, ext: { achievements: port } });
    human(w);
    expect(w.k.bus.pending).toBe(0);
    (w.rootSim({}).ctx as any).emit('stat', { name: 'kills' });
    expect(w.k.bus.pending).toBe(1);
  });

  it('negative control: without ext.achievements nothing is forwarded or written', async () => {
    const port = createAchievementsPort({ defs });
    const w = await testWorld({ modules: MODULES });
    human(w);
    const sim = w.rootSim({}).ctx as any;
    sim.emit('milestone', { name: 'boss' });
    sim.emit('stat', { name: 'kills' });
    await settle();
    expect(port.unlockedIds()).toEqual([]);
    expect(stateOf(w)).toBeUndefined();
  });

  it('a throwing port does not break the emit', async () => {
    const bad = { handleAct: () => Promise.reject(new Error('boom')), unlockedIds: () => [] };
    const w = await testWorld({ modules: MODULES, ext: { achievements: bad } });
    human(w);
    const orig = console.error;
    console.error = () => {};
    try {
      expect(() => (w.rootSim({}).ctx as any).emit('milestone', { name: 'x' })).not.toThrow();
      await settle();
    } finally {
      console.error = orig;
    }
  });

  it('submitScore sends the local human to the board; false without a port or a human', async () => {
    const lb = createLeaderboardPort({ defs: { hall: { name: 'Hall', direction: 'desc' } } });
    const w = await testWorld({ modules: MODULES, ext: { leaderboards: lb } });
    expect(await submitScore(w.k, 'hall', 5)).toBe(false);
    human(w);
    expect(await submitScore(w.k, 'hall', 5)).toBe(true);
    expect(await submitScore(w.k, 'hall', 3)).toBe(false);
    expect(lb.top('hall')).toMatchObject([{ playerId: 'u-7', name: 'Op', score: 5 }]);
    const none = await testWorld({ modules: MODULES });
    human(none);
    expect(await submitScore(none.k, 'hall', 5)).toBe(false);
  });
});
