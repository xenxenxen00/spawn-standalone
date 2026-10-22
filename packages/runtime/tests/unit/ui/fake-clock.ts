// A manual clock for deterministic timing tests (flash fade, trophy dismiss, damage expiry).
// Mirrors the UiClock seam in src/runtime/ui/chrome/types.ts without importing it.

export interface ManualClock {
  now(): number;
  after(ms: number, cb: () => void): () => void;
  advance(ms: number): void;
  pending(): number;
}

export function createManualClock(start = 0): ManualClock {
  let t = start;
  let seq = 0;
  const pending = new Map<number, { at: number; cb: () => void }>();
  return {
    now: () => t,
    after: (ms: number, cb: () => void) => {
      const id = ++seq;
      pending.set(id, { at: t + ms, cb });
      return () => void pending.delete(id);
    },
    advance(ms: number) {
      const end = t + ms;
      for (;;) {
        let nextId = -1;
        let nextAt = Infinity;
        for (const [id, p] of pending) {
          if (p.at <= end && p.at < nextAt) {
            nextAt = p.at;
            nextId = id;
          }
        }
        if (nextId === -1) break;
        t = nextAt;
        const p = pending.get(nextId);
        pending.delete(nextId);
        p!.cb();
      }
      t = end;
    },
    pending: () => pending.size,
  };
}
