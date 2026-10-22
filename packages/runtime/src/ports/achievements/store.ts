import type { JsonStore } from './types.ts';

export interface MemoryJsonStore<T> extends JsonStore<T> {
  readonly saves: number;
  readonly value: T | null;
}

/** In-memory store (tests, and the default). Values are cloned so callers cannot alias it. */
export function createMemoryJsonStore<T>(initial: T | null = null): MemoryJsonStore<T> {
  let held: T | null = initial === null ? null : (structuredClone(initial) as T);
  let saves = 0;
  return {
    get saves() {
      return saves;
    },
    get value() {
      return held === null ? null : (structuredClone(held) as T);
    },
    load: () => Promise.resolve(held === null ? null : (structuredClone(held) as T)),
    save(value) {
      held = structuredClone(value) as T;
      saves += 1;
      return Promise.resolve();
    },
  };
}

/** The slice of Storage the browser store needs. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** localStorage-backed store under one key. A corrupt or missing entry loads as null. */
export function createStorageJsonStore<T>(storage: StorageLike, key: string): JsonStore<T> {
  return {
    load() {
      try {
        const text = storage.getItem(key);
        return Promise.resolve(text === null ? null : (JSON.parse(text) as T));
      } catch {
        return Promise.resolve(null);
      }
    },
    save(value) {
      try {
        storage.setItem(key, JSON.stringify(value));
        return Promise.resolve();
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  };
}
