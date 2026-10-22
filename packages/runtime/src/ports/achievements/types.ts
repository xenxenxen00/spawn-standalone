// AchievementsPort: device-local achievements behind the `milestone` / `stat` acts.
//
// Documented behaviour (engine 6.0.0 api-reference.md `ActMap`):
//   ctx.emit("milestone", { step?: number; name?: string }, { audience: { player } })
//   ctx.emit("stat", { name: string; value?: number })
// and world.config.yaml `achievements:` { <id>: { name, description, trophy? } }. The docs say
// nothing about how a milestone maps to an entry, so this port decides (port-spec K9):
//   - `milestone { name }` unlocks the entry whose id is `name`, once; an unknown id is ignored
//   - `milestone { step }` records the highest step reached; an entry with `step: N` unlocks at N
//   - `stat { name, value }` adds `value` (default 1) to a counter; an entry with
//     `stat: <name>, target: N` unlocks when the counter reaches N and reports progress until then
// ABSENT: the platform's own achievement UI, trophy voxel models, and cross-device sync.

export interface AchievementDef {
  name: string;
  description?: string;
  trophy?: string;
  /** Unlocks when a `milestone { step }` reaches this number. */
  step?: number;
  /** Unlocks when the `stat` counter of this name reaches `target`. */
  stat?: string;
  target?: number;
}

export interface AchievementStatus {
  id: string;
  name: string;
  description: string;
  trophy: string | undefined;
  unlocked: boolean;
  unlockedAt: number | null;
  /** Counter value for a `stat` entry (0 otherwise). */
  progress: number;
  /** Counter goal for a `stat` entry (null otherwise). */
  target: number | null;
}

export interface AchievementUnlock {
  id: string;
  def: AchievementDef;
}

/** What is persisted. */
export interface AchievementData {
  v: 1;
  unlocked: Record<string, number>;
  stats: Record<string, number>;
  step: number;
}

/** Async single-document store; each port owns one document. */
export interface JsonStore<T = unknown> {
  load(): Promise<T | null>;
  save(value: T): Promise<void>;
}

export interface AchievementsPortOptions {
  defs: Record<string, AchievementDef>;
  store?: JsonStore<AchievementData>;
  now?: () => number;
  /** Called once per new unlock (the toast). Errors are swallowed. */
  onUnlock?: (unlock: AchievementUnlock) => void;
}

export interface AchievementsPort {
  /** Loads the store; every other call awaits this. Safe to call twice. */
  init(): Promise<void>;
  /** Unlocks an entry by id. Resolves the unlock when it is new, null for repeats and unknown ids. */
  unlock(id: string): Promise<AchievementUnlock | null>;
  /** Adds to a stat counter (default 1) and unlocks entries that reached their target. */
  addStat(name: string, value?: number): Promise<AchievementUnlock[]>;
  /** Records a milestone step and unlocks entries whose `step` is reached. */
  reachStep(step: number): Promise<AchievementUnlock[]>;
  /** Feeds a `milestone` / `stat` act payload; other act types and bad payloads are ignored. */
  handleAct(type: string, payload: unknown): Promise<AchievementUnlock[]>;
  progress(id: string): AchievementStatus | null;
  list(): AchievementStatus[];
  /** Unlocked ids in unlock order: the value for `player.state.achievements`. */
  unlockedIds(): string[];
  isUnlocked(id: string): boolean;
  /** Resolves when pending saves are written. */
  flush(): Promise<void>;
}
