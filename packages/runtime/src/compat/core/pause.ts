import { extOf } from './ext.ts';
import type { KernelPorts } from './ports.ts';
import type { SimClockImpl } from './sched/clock.ts';

/** subscribes the clock to the platform's pause events when `ext.pauseFreezesClock` is on; returns the unbind */
export function bindPlatformPause(k: { readonly ports: Pick<KernelPorts, 'platform'> }, clock: SimClockImpl): () => void {
  if (!extOf(k).pauseFreezesClock) return () => {};
  const p = k.ports.platform;
  if (typeof p?.on !== 'function') return () => {};
  const set = (reason: 'platform', on: boolean): void => (on ? clock.pause(reason) : clock.resume(reason));
  if (p.platformPaused) set('platform', true);
  const offs = [
    p.on('platformPause', (paused) => set('platform', paused === true))
  ];
  return () => {
    for (const off of offs) off();
  };
}
