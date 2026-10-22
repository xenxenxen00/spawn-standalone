// A small typed event emitter (build §6.6): the `Platform.on` of every adapter and the PauseController's change feed.
//
// - Listeners run in subscription order on a snapshot, so subscribing or unsubscribing inside a listener affects the next
//   emit, not the current one.
// - A listener that throws is logged with console.error and the others still run: one broken subscriber must never stop
//   a pause or an ad resume from reaching the rest.
// - `on` returns an idempotent unsubscribe that removes only its own subscription (the same function may subscribe twice).

// `any[]` (not `unknown[]`) so an event map with specific parameter lists satisfies the constraint (parameter bivariance)
type Listener = (...args: any[]) => void;

export interface Emitter<E extends { [K in keyof E]: Listener }> {
  on<K extends keyof E>(ev: K, fn: E[K]): () => void;
  emit<K extends keyof E>(ev: K, ...args: Parameters<E[K]>): void;
  /** live subscriptions for one event */
  count(ev: keyof E): number;
  clear(): void;
}

export function createEmitter<E extends { [K in keyof E]: Listener }>(label = 'emitter'): Emitter<E> {
  const subs = new Map<keyof E, Array<{ fn: Listener }>>();

  const on = <K extends keyof E>(ev: K, fn: E[K]): (() => void) => {
    const entry = { fn: fn as Listener };
    const list = subs.get(ev);
    if (list) list.push(entry);
    else subs.set(ev, [entry]);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      const cur = subs.get(ev);
      if (!cur) return;
      const i = cur.indexOf(entry);
      if (i >= 0) cur.splice(i, 1);
      if (cur.length === 0) subs.delete(ev);
    };
  };

  const emit = <K extends keyof E>(ev: K, ...args: Parameters<E[K]>): void => {
    const list = subs.get(ev);
    if (!list || list.length === 0) return;
    for (const { fn } of list.slice()) {
      try {
        fn(...args);
      } catch (err) {
        console.error(`[${label}] a "${String(ev)}" listener threw`, err);
      }
    }
  };

  return {
    on,
    emit,
    count: (ev) => subs.get(ev)?.length ?? 0,
    clear: () => subs.clear(),
  };
}
