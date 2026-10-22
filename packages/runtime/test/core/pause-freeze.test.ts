import { describe, expect, it } from 'vitest';
import { createNullPlatform } from '../../src/compat/core/null-ports.ts';
import type { HostPlatform, HostPlatformEvents } from '../../src/compat/core/ports.ts';
import { testWorld } from './world.ts';

/** a platform whose pause events the test fires */
function fakeHostPlatform(): { platform: HostPlatform; fire<K extends keyof HostPlatformEvents>(ev: K, ...a: Parameters<HostPlatformEvents[K]>): void } {
  const subs: Array<[string, (...a: never[]) => void]> = [];
  const base = createNullPlatform();
  const platform: HostPlatform = {
    ...base,
    on: ((ev: string, cb: (...a: never[]) => void) => {
      subs.push([ev, cb]);
      return () => void subs.splice(subs.findIndex((s) => s[1] === cb), 1);
    }) as NonNullable<HostPlatform['on']>,
  };
  return { platform, fire: (ev, ...a) => subs.filter((s) => s[0] === ev).forEach((s) => (s[1] as (...x: unknown[]) => void)(...a)) };
}

const FRAME = 1000 / 30;

async function world(pauseFreezesClock: boolean) {
  const p = fakeHostPlatform();
  const fired: number[] = [];
  const w = await testWorld({ ext: { pauseFreezesClock }, ports: { platform: p.platform } });
  let updates = 0;
  const sim = w.rootSim({ tick: () => void updates++, fire: (ctx: any) => void fired.push(ctx.now()) });
  (sim.ctx as any).after(1, 'fire');
  const frames = (n: number, dt = FRAME) => {
    let ticks = 0;
    for (let i = 0; i < n; i++) ticks += w.k.advance(dt).ticks;
    return ticks;
  };
  return { w, p, fired, frames, now: () => w.k.clock.now(), updates: () => updates };
}

describe('R-7 / C-1: ext.pauseFreezesClock', () => {
  it('opt-in: a platform pause stops now(), updates and timers, and resumes with no jump', async () => {
    const t = await world(true);
    t.frames(10);
    const before = t.now();
    const upd = t.updates();
    t.p.fire('platformPause', true);
    expect(t.w.k.clock.running).toBe(false);
    expect(t.frames(300, 100)).toBe(0); // 30 s of host frames
    expect(t.now()).toBe(before);
    expect(t.updates()).toBe(upd);
    expect(t.fired).toEqual([]);
    t.p.fire('platformPause', false);
    expect(t.w.k.clock.running).toBe(true);
    // the first frame after the resume runs at most one tick: no catch-up burst, now() moved by one tick
    const ticks = t.frames(1, 250);
    expect(ticks).toBeLessThanOrEqual(2);
    expect(t.now() - before).toBeLessThanOrEqual(2 * FRAME + 1e-6);
    // the 1 s timer was set at tick 0, so it is not due before tick 30 whatever the pause lasted
    expect(t.fired).toEqual([]);
    t.frames(30);
    expect(t.fired.length).toBe(1);
  });

  it('negative control: an unrelated event does not pause the kernel', async () => {
    const t = await world(true);
    t.frames(3);
    const n = t.now();
    (t.p.fire as (ev: string) => void)('unrelated');
    t.frames(3);
    expect(t.now()).toBeGreaterThan(n);
  });

  it('opt-in: a platform that is already paused at creation holds the clock', async () => {
    const p = fakeHostPlatform();
    const w = await testWorld({ ext: { pauseFreezesClock: true }, ports: { platform: Object.assign(p.platform, { platformPaused: true }) } });
    expect(w.k.clock.reasons.has('platform')).toBe(true);
  });

  it('negative control (option off): the kernel ignores the platform events and keeps ticking', async () => {
    const t = await world(false);
    t.frames(10);
    const before = t.now();
    t.p.fire('platformPause', true);
    expect(t.w.k.clock.running).toBe(true);
    t.frames(30);
    expect(t.now()).toBeGreaterThan(before);
    expect(t.fired.length).toBe(1);
  });
});
