import type { JobWorkerEvent, WorkerFactory, WorkerLike } from './types.ts';

/** One worker plus the single listener pair the pool owns for it. */
export interface WorkerSlot {
  worker: WorkerLike;
  dead: boolean;
  /** Set by whoever holds the slot; cleared on release. */
  onEvent: ((event: JobWorkerEvent) => void) | undefined;
  onCrash: ((error: { message: string }) => void) | undefined;
}

export interface WorkerPool {
  /** A warm idle slot, or a new one. May throw if the factory does. */
  acquire(): WorkerSlot;
  /** Back to the idle list when `reuse` and the pool keeps workers; otherwise terminates it. */
  release(slot: WorkerSlot, reuse: boolean): void;
  /** Starts idle workers up to the pool size so the first call does not pay start-up. */
  warm(): void;
  dispose(): void;
  idleCount(): number;
  eachIdle(fn: (slot: WorkerSlot) => void): void;
}

/**
 * Worker slots for the job host. `size` 0 keeps today's behaviour (a fresh worker per call,
 * terminated afterwards). With `size` > 0 up to `size` workers stay warm and are reused; a worker
 * that crashed, hit its deadline or was cancelled is terminated and replaced on the next acquire.
 */
export function createWorkerPool(create: WorkerFactory, size: number): WorkerPool {
  const idle: WorkerSlot[] = [];
  const all = new Set<WorkerSlot>();

  const kill = (slot: WorkerSlot): void => {
    slot.dead = true;
    slot.onEvent = undefined;
    slot.onCrash = undefined;
    all.delete(slot);
    const at = idle.indexOf(slot);
    if (at >= 0) idle.splice(at, 1);
    try {
      void Promise.resolve(slot.worker.terminate()).catch(() => undefined);
    } catch {
      // already gone
    }
  };

  const make = (): WorkerSlot => {
    const worker = create();
    const slot: WorkerSlot = { worker, dead: false, onEvent: undefined, onCrash: undefined };
    worker.onMessage((event) => slot.onEvent?.(event));
    worker.onError((error) => {
      if (slot.dead) return;
      const crash = slot.onCrash;
      kill(slot);
      crash?.(error);
    });
    all.add(slot);
    return slot;
  };

  return {
    acquire() {
      while (idle.length > 0) {
        const slot = idle.pop()!;
        if (!slot.dead) return slot;
      }
      return make();
    },
    release(slot, reuse) {
      slot.onEvent = undefined;
      slot.onCrash = undefined;
      if (slot.dead) return;
      if (reuse && size > 0 && idle.length < size) idle.push(slot);
      else kill(slot);
    },
    warm() {
      while (size > 0 && all.size < size) idle.push(make());
    },
    dispose() {
      for (const slot of [...all]) kill(slot);
    },
    idleCount: () => idle.length,
    eachIdle(fn) {
      for (const slot of [...idle]) fn(slot);
    },
  };
}
