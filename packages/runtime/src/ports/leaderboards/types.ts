// LeaderboardPort: a device-local board per `leaderboards:` config entry.
//
// Documented (platform-systems.md): keep each player's number in a `player.state` row and name it
// under world.config.yaml `leaderboards` ({ name, state, direction: "asc" | "desc" }); Spawn then
// publishes the board on the game page. ABSENT here: the public page and other players' rows. A
// standalone board holds the players this device has seen (port-spec K9: the Hall of Champions).

import type { JsonStore } from '../achievements/types.ts';

export interface LeaderboardDef {
  name: string;
  /** The `player.state` key the board mirrors. */
  state?: string;
  direction?: 'asc' | 'desc';
}

export interface LeaderboardEntry {
  playerId: string;
  name: string;
  score: number;
  /** 1-based; ties share the better rank. */
  rank: number;
  at: number;
}

export interface LeaderboardData {
  v: 1;
  boards: Record<string, Record<string, { name: string; score: number; at: number }>>;
}

export interface LeaderboardPortOptions {
  defs: Record<string, LeaderboardDef>;
  store?: JsonStore<LeaderboardData>;
  now?: () => number;
}

export interface LeaderboardPort {
  init(): Promise<void>;
  /**
   * Records a player's score. The board keeps their best in its direction (desc: highest). Resolves
   * true when it changed the stored value; false for a worse score, a bad number or an unknown board.
   */
  submit(boardId: string, playerId: string, score: number, name?: string): Promise<boolean>;
  /** Best first; `limit` defaults to 10. */
  top(boardId: string, limit?: number): LeaderboardEntry[];
  /** The player's entry with its rank, or null when they have none. */
  rank(boardId: string, playerId: string): LeaderboardEntry | null;
  /** Board ids to their config, for UIs. */
  boards(): Array<{ id: string; def: LeaderboardDef }>;
  flush(): Promise<void>;
}
