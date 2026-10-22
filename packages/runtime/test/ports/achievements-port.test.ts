import { describe, expect, it } from 'vitest';
import {
  createAchievementsPort,
  createMemoryJsonStore,
  createStorageJsonStore,
  type AchievementData,
} from '../../src/ports/achievements/index.ts';
import { createLeaderboardPort, type LeaderboardData } from '../../src/ports/leaderboards/index.ts';

// Synthetic milestone, stat, and step definitions.
const defs = {
  'first-action': { name: 'First Action', description: 'Complete the first action.', trophy: 'trophies/first-action.json' },
  'complete-task': { name: 'Task Complete', description: 'Complete a sample task.' },
  veteran: { name: 'Veteran', stat: 'games', target: 3 },
  deep: { name: 'Deep', step: 5 },
};

describe('AchievementsPort (K9)', () => {
  it('milestone first-action twice -> one unlock; unknown id ignored', async () => {
    const seen: string[] = [];
    const port = createAchievementsPort({ defs, onUnlock: (u) => seen.push(u.id) });
    expect((await port.handleAct('milestone', { name: 'first-action' })).map((u) => u.id)).toEqual(['first-action']);
    expect(await port.handleAct('milestone', { name: 'first-action' })).toEqual([]);
    expect(await port.handleAct('milestone', { name: 'no-such-feat' })).toEqual([]);
    expect(seen).toEqual(['first-action']);
    expect(port.unlockedIds()).toEqual(['first-action']);
    expect(port.list().find((a) => a.id === 'first-action')).toMatchObject({ unlocked: true, name: 'First Action' });
  });

  it('reload keeps the unlock (persisted through the injected store)', async () => {
    const store = createMemoryJsonStore<AchievementData>();
    const a = createAchievementsPort({ defs, store, now: () => 1234 });
    await a.unlock('complete-task');
    await a.flush();
    expect(store.saves).toBe(1);
    const b = createAchievementsPort({ defs, store });
    await b.init();
    expect(b.isUnlocked('complete-task')).toBe(true);
    expect(b.progress('complete-task')?.unlockedAt).toBe(1234);
    expect(await b.unlock('complete-task')).toBeNull();
  });

  it('stat acts count toward a target and report progress', async () => {
    const port = createAchievementsPort({ defs });
    await port.handleAct('stat', { name: 'games' });
    await port.handleAct('stat', { name: 'games', value: 1 });
    expect(port.progress('veteran')).toMatchObject({ unlocked: false, progress: 2, target: 3 });
    expect((await port.handleAct('stat', { name: 'games' })).map((u) => u.id)).toEqual(['veteran']);
    expect(port.progress('veteran')).toMatchObject({ unlocked: true, progress: 3 });
  });

  it('milestone step unlocks entries at or below it; other acts and junk payloads are ignored', async () => {
    const port = createAchievementsPort({ defs });
    expect(await port.handleAct('milestone', { step: 4 })).toEqual([]);
    expect((await port.handleAct('milestone', { step: 6 })).map((u) => u.id)).toEqual(['deep']);
    expect(await port.handleAct('flash', { name: 'first-action' })).toEqual([]);
    expect(await port.handleAct('milestone', null)).toEqual([]);
    expect(await port.handleAct('stat', { name: 'games', value: Number.NaN })).toHaveLength(0);
  });

  it('a throwing toast does not lose the unlock, and a failing store does not throw', async () => {
    const port = createAchievementsPort({
      defs,
      onUnlock: () => {
        throw new Error('toast bug');
      },
      store: { load: () => Promise.reject(new Error('no disk')), save: () => Promise.reject(new Error('no disk')) },
    });
    expect(await port.unlock('first-action')).not.toBeNull();
    await expect(port.flush()).resolves.toBeUndefined();
    expect(port.isUnlocked('first-action')).toBe(true);
  });

  it('localStorage-shaped store round-trips and tolerates corrupt data', async () => {
    const mem = new Map<string, string>();
    const storage = { getItem: (k: string) => mem.get(k) ?? null, setItem: (k: string, v: string) => void mem.set(k, v) };
    const a = createAchievementsPort({ defs, store: createStorageJsonStore<AchievementData>(storage, 'ach') });
    await a.unlock('first-action');
    await a.flush();
    const b = createAchievementsPort({ defs, store: createStorageJsonStore<AchievementData>(storage, 'ach') });
    await b.init();
    expect(b.unlockedIds()).toEqual(['first-action']);
    mem.set('ach', '{not json');
    const c = createAchievementsPort({ defs, store: createStorageJsonStore<AchievementData>(storage, 'ach') });
    await c.init();
    expect(c.unlockedIds()).toEqual([]);
  });
});

describe('LeaderboardPort (K9)', () => {
  const boards = {
    glory: { name: 'Hall of Champions: Glory', state: 'glory', direction: 'desc' as const },
    time: { name: 'Fastest', direction: 'asc' as const },
  };

  it('keeps each player best and ranks desc (Clash glory)', async () => {
    const lb = createLeaderboardPort({ defs: boards, now: () => 1 });
    expect(await lb.submit('glory', 'p1', 100, 'Ada')).toBe(true);
    expect(await lb.submit('glory', 'p1', 80)).toBe(false);
    expect(await lb.submit('glory', 'p1', 150)).toBe(true);
    await lb.submit('glory', 'p2', 120, 'Bo');
    await lb.submit('glory', 'p3', 120, 'Cy');
    expect(lb.top('glory').map((e) => [e.playerId, e.score, e.rank])).toEqual([
      ['p1', 150, 1],
      ['p2', 120, 2],
      ['p3', 120, 2],
    ]);
    expect(lb.rank('glory', 'p3')).toMatchObject({ rank: 2, name: 'Cy' });
    expect(lb.rank('glory', 'ghost')).toBeNull();
    expect(lb.top('glory', 1)).toHaveLength(1);
  });

  it('asc boards keep the lowest; unknown boards and bad scores are refused', async () => {
    const lb = createLeaderboardPort({ defs: boards });
    await lb.submit('time', 'a', 30);
    expect(await lb.submit('time', 'a', 20)).toBe(true);
    expect(await lb.submit('time', 'a', 25)).toBe(false);
    expect(lb.top('time')[0]).toMatchObject({ score: 20 });
    expect(await lb.submit('nope', 'a', 1)).toBe(false);
    expect(await lb.submit('time', 'a', Number.NaN)).toBe(false);
    expect(lb.top('nope')).toEqual([]);
  });

  it('persists through the injected store', async () => {
    const store = createMemoryJsonStore<LeaderboardData>();
    const a = createLeaderboardPort({ defs: boards, store });
    await a.submit('glory', 'p1', 42, 'Ada');
    await a.flush();
    const b = createLeaderboardPort({ defs: boards, store });
    await b.init();
    expect(b.rank('glory', 'p1')).toMatchObject({ score: 42, rank: 1, name: 'Ada' });
  });
});
