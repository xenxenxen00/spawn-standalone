// A millisecond clock for timing and profiling that never throws: `performance.now()` where the realm has one, `Date.now()`
// where a headless harness stubbed `window`/`performance` away. Used for metrics only, never for a game decision.
export function perfNow(): number {
  const p = (globalThis as { performance?: { now?: () => number } | null }).performance;
  return p != null && typeof p.now === 'function' ? p.now() : Date.now();
}
