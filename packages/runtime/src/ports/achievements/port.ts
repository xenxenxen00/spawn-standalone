import type {
  AchievementData,
  AchievementDef,
  AchievementStatus,
  AchievementUnlock,
  AchievementsPort,
  AchievementsPortOptions,
} from './types.ts';
import { createMemoryJsonStore } from './store.ts';

const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

export function createAchievementsPort(options: AchievementsPortOptions): AchievementsPort {
  const defs = options.defs;
  const store = options.store ?? createMemoryJsonStore<AchievementData>();
  const now = options.now ?? Date.now;
  let data: AchievementData = { v: 1, unlocked: {}, stats: {}, step: 0 };
  let ready: Promise<void> | undefined;
  let writes: Promise<void> = Promise.resolve();

  function init(): Promise<void> {
    ready ??= store
      .load()
      .then((loaded) => {
        if (loaded && typeof loaded === 'object' && loaded.v === 1) {
          data = {
            v: 1,
            unlocked: { ...(loaded.unlocked ?? {}) },
            stats: { ...(loaded.stats ?? {}) },
            step: num(loaded.step) ? loaded.step : 0,
          };
        }
      })
      .catch(() => undefined);
    return ready;
  }

  function persist(): void {
    const snapshot = structuredClone(data);
    writes = writes.then(() => store.save(snapshot)).catch(() => undefined);
  }

  function grant(id: string, out: AchievementUnlock[]): void {
    const def = defs[id];
    if (!def || id in data.unlocked) return;
    data.unlocked[id] = now();
    const unlock = { id, def };
    out.push(unlock);
    try {
      options.onUnlock?.(unlock);
    } catch {
      // a toast bug must not lose the unlock
    }
  }

  const status = (id: string): AchievementStatus => {
    const def: AchievementDef = defs[id]!;
    const counted = def.stat !== undefined ? (data.stats[def.stat] ?? 0) : 0;
    return {
      id,
      name: def.name,
      description: def.description ?? '',
      trophy: def.trophy,
      unlocked: id in data.unlocked,
      unlockedAt: data.unlocked[id] ?? null,
      progress: counted,
      target: def.stat !== undefined && num(def.target) ? def.target : null,
    };
  };

  const port: AchievementsPort = {
    init,
    async unlock(id) {
      await init();
      const out: AchievementUnlock[] = [];
      grant(id, out);
      if (out.length > 0) persist();
      return out[0] ?? null;
    },
    async addStat(name, value = 1) {
      await init();
      if (!num(value)) return [];
      data.stats[name] = (data.stats[name] ?? 0) + value;
      const out: AchievementUnlock[] = [];
      for (const [id, def] of Object.entries(defs)) {
        if (def.stat === name && num(def.target) && data.stats[name]! >= def.target) grant(id, out);
      }
      persist();
      return out;
    },
    async reachStep(step) {
      await init();
      if (!num(step)) return [];
      const out: AchievementUnlock[] = [];
      if (step > data.step) data.step = step;
      for (const [id, def] of Object.entries(defs)) {
        if (num(def.step) && data.step >= def.step) grant(id, out);
      }
      persist();
      return out;
    },
    async handleAct(type, payload) {
      const p = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<string, unknown>;
      if (type === 'milestone') {
        const out: AchievementUnlock[] = [];
        if (typeof p.name === 'string') {
          const one = await port.unlock(p.name);
          if (one) out.push(one);
        }
        if (num(p.step)) out.push(...(await port.reachStep(p.step)));
        return out;
      }
      if (type === 'stat' && typeof p.name === 'string') {
        return port.addStat(p.name, num(p.value) ? p.value : 1);
      }
      return [];
    },
    progress: (id) => (defs[id] ? status(id) : null),
    list: () => Object.keys(defs).map(status),
    unlockedIds: () =>
      Object.entries(data.unlocked)
        .sort((a, b) => a[1] - b[1])
        .map(([id]) => id),
    isUnlocked: (id) => id in data.unlocked,
    flush: () => writes,
  };
  return port;
}
