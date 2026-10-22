import { createMemoryJsonStore } from '../achievements/store.ts';
import type { LeaderboardData, LeaderboardEntry, LeaderboardPort, LeaderboardPortOptions } from './types.ts';

export function createLeaderboardPort(options: LeaderboardPortOptions): LeaderboardPort {
  const defs = options.defs;
  const store = options.store ?? createMemoryJsonStore<LeaderboardData>();
  const now = options.now ?? Date.now;
  let data: LeaderboardData = { v: 1, boards: {} };
  let ready: Promise<void> | undefined;
  let writes: Promise<void> = Promise.resolve();

  function init(): Promise<void> {
    ready ??= store
      .load()
      .then((loaded) => {
        if (loaded && typeof loaded === 'object' && loaded.v === 1 && loaded.boards) data = structuredClone(loaded);
      })
      .catch(() => undefined);
    return ready;
  }

  const persist = (): void => {
    const snapshot = structuredClone(data);
    writes = writes.then(() => store.save(snapshot)).catch(() => undefined);
  };

  const sorted = (boardId: string): LeaderboardEntry[] => {
    const def = defs[boardId];
    if (!def) return [];
    const sign = def.direction === 'asc' ? 1 : -1;
    const rows = Object.entries(data.boards[boardId] ?? {})
      .map(([playerId, r]) => ({ playerId, name: r.name, score: r.score, at: r.at, rank: 0 }))
      .sort((a, b) => sign * (a.score - b.score) || a.at - b.at || (a.playerId < b.playerId ? -1 : 1));
    rows.forEach((row, i) => {
      row.rank = i > 0 && rows[i - 1]!.score === row.score ? rows[i - 1]!.rank : i + 1;
    });
    return rows;
  };

  return {
    init,
    async submit(boardId, playerId, score, name) {
      await init();
      const def = defs[boardId];
      if (!def || typeof score !== 'number' || !Number.isFinite(score) || playerId === '') return false;
      const board = (data.boards[boardId] ??= {});
      const had = board[playerId];
      const better = !had || (def.direction === 'asc' ? score < had.score : score > had.score);
      if (!better) {
        if (name && had && had.name !== name) {
          had.name = name;
          persist();
        }
        return false;
      }
      board[playerId] = { name: name ?? had?.name ?? playerId, score, at: now() };
      persist();
      return true;
    },
    top: (boardId, limit = 10) => sorted(boardId).slice(0, Math.max(0, limit)),
    rank: (boardId, playerId) => sorted(boardId).find((e) => e.playerId === playerId) ?? null,
    boards: () => Object.entries(defs).map(([id, def]) => ({ id, def })),
    flush: () => writes,
  };
}
