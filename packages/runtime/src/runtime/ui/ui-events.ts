// `uiEvent` act → `window.spawn.on('event', fn)` subscribers (io §3.6; X-12; core §8.6, §15.8). The one live sender is the gore
// lens: `ctx.emit('uiEvent', { name: 'ssBlood', payload }, { audience: <this player> })` (scripts/gore/gore.js:278), received by
// `scripts/gore/screen.js:178`. The kernel has already applied the audience filter when the act reaches the router (X-12).
import type { ActRouter } from '../../compat/core/ports.ts';

export type UiEventListener = (name: string, payload: unknown) => void;

export class UiEventBus {
  readonly #subs = new Set<UiEventListener>();
  readonly #log: (msg: string) => void;
  readonly #reported = new Set<string>();

  constructor(opts: { log?: (msg: string) => void } = {}) {
    this.#log = opts.log ?? ((m) => console.warn(m));
  }

  /** `window.spawn.on('event', fn)`; returns the unsubscribe */
  on(fn: UiEventListener): () => void {
    // a function subscribed twice is two subscriptions (Spawn's listener list), so wrap it
    const sub: UiEventListener = (n, p) => fn(n, p);
    this.#subs.add(sub);
    return () => {
      this.#subs.delete(sub);
    };
  }

  /** calls each subscriber once; a subscriber that throws is logged (once per message) and the others still run */
  emit(name: string, payload: unknown): void {
    for (const fn of [...this.#subs]) {
      try {
        fn(name, payload);
      } catch (e) {
        const msg = `ui event "${name}": a window.spawn.on subscriber threw: ${e instanceof Error ? e.message : String(e)}`;
        if (!this.#reported.has(msg)) {
          this.#reported.add(msg);
          this.#log(msg);
        }
      }
    }
  }

  get size(): number {
    return this.#subs.size;
  }

  /** registers the `uiEvent` act handler (payload `{ name, payload }`) on the kernel's act router; returns the unregister */
  registerActs(acts: ActRouter): () => void {
    return acts.register('uiEvent', (a) => {
      const p = a.payload;
      if (typeof p !== 'object' || p === null) return;
      const name = (p as { name?: unknown }).name;
      if (typeof name !== 'string' || name === '') return;
      this.emit(name, (p as { payload?: unknown }).payload);
    });
  }
}
