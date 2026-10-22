// WP X3: the device-loss policy (src/render/engine/device-loss.ts; render §3.1 steps 2-3, docs/architecture.md §5.5): a loss
// starts one rebuild on the next task; success resumes; a failed rebuild, a second loss during it, a second loss within 5 s
// of the previous one, or no resume 5 s after the loss offers the reload, once per episode. A fake clock drives every timer.
import { describe, expect, it } from 'vitest';
import { createDeviceLossPolicy, DEVICE_LOSS_WINDOW_MS, type DeviceLossPolicyDeps } from '../../../src/render/engine/device-loss.ts';

interface Timer {
  at: number;
  fn: () => void;
  live: boolean;
}

function fakeClock() {
  let t = 0;
  const timers: Timer[] = [];
  return {
    now: () => t,
    setTimer: (fn: () => void, ms: number): unknown => {
      const timer: Timer = { at: t + ms, fn, live: true };
      timers.push(timer);
      return timer;
    },
    clearTimer: (id: unknown): void => {
      (id as Timer).live = false;
    },
    /** advances to `t + ms`, firing due timers in order */
    async advance(ms: number): Promise<void> {
      const end = t + ms;
      for (;;) {
        const due = timers.filter((x) => x.live && x.at <= end).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        t = due.at;
        due.live = false;
        due.fn();
        for (let i = 0; i < 5; i++) await Promise.resolve();
      }
      t = end;
    },
  };
}

function rig(rebuild: DeviceLossPolicyDeps['rebuild'] = () => Promise.resolve(true)) {
  const clock = fakeClock();
  const calls = { rebuilds: 0, resumes: 0, offers: [] as string[] };
  const policy = createDeviceLossPolicy({
    rebuild: () => {
      calls.rebuilds++;
      return rebuild();
    },
    resume: () => void calls.resumes++,
    offerReload: (reason) => void calls.offers.push(reason),
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    log: () => undefined,
  });
  return { clock, calls, policy };
}

/** a rebuild that settles when the test says so */
function deferred(): { promise: Promise<boolean>; resolve(ok: boolean): void; reject(e: unknown): void } {
  let resolve!: (ok: boolean) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<boolean>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('device-loss policy (render §3.1)', () => {
  it('the window is the 5 s of render §3.1 and architecture §5.5', () => {
    expect(DEVICE_LOSS_WINDOW_MS).toBe(5000);
  });

  it('a loss rebuilds on the next task, never inside the loss handler, and resumes once it succeeded', async () => {
    const { clock, calls, policy } = rig();
    policy.onLost();
    expect(policy.state).toBe('rebuilding');
    expect(calls.rebuilds).toBe(0); // three's handler and the other listeners finish first
    await clock.advance(0);
    await policy.settled();
    expect(calls.rebuilds).toBe(1);
    expect(calls.resumes).toBe(1);
    expect(policy.state).toBe('idle');
    expect(policy.rebuilds).toBe(1);
    expect(calls.offers).toEqual([]);
    // the 5 s timer was cancelled with the resume
    await clock.advance(10_000);
    expect(calls.offers).toEqual([]);
  });

  it('a rebuild that fails or throws offers the reload and is not retried', async () => {
    for (const rebuild of [() => Promise.resolve(false), () => Promise.reject(new Error('no webgl2'))]) {
      const { clock, calls, policy } = rig(rebuild);
      policy.onLost();
      await clock.advance(0);
      await policy.settled();
      expect(calls.resumes).toBe(0);
      expect(policy.state).toBe('failed');
      expect(calls.offers).toEqual(['the renderer could not be rebuilt']);
      policy.onLost();
      await clock.advance(10_000);
      expect(calls.rebuilds).toBe(1);
      expect(calls.offers).toHaveLength(1);
    }
  });

  it('a second loss during the rebuild offers the reload; the rebuild settling later does not resume', async () => {
    const d = deferred();
    const { clock, calls, policy } = rig(() => d.promise);
    policy.onLost();
    await clock.advance(0);
    expect(calls.rebuilds).toBe(1);
    // the new context is lost while the warm-up runs
    policy.onLost();
    expect(policy.state).toBe('failed');
    expect(calls.offers).toEqual(['the graphics device was lost again during the rebuild']);
    d.resolve(true);
    await policy.settled();
    expect(calls.resumes).toBe(0);
    expect(policy.state).toBe('failed');
  });

  it('two losses in one task: the rebuild never starts, the reload is offered', async () => {
    const { clock, calls, policy } = rig();
    policy.onLost();
    policy.onLost();
    await clock.advance(0);
    await policy.settled();
    expect(calls.rebuilds).toBe(0);
    expect(calls.offers).toHaveLength(1);
  });

  it('a second loss within 5 s of the previous one, after a successful rebuild, offers the reload', async () => {
    const { clock, calls, policy } = rig();
    policy.onLost();
    await clock.advance(0);
    await policy.settled();
    expect(calls.resumes).toBe(1);
    await clock.advance(4000);
    policy.onLost();
    expect(policy.state).toBe('failed');
    expect(calls.offers).toEqual([`a second loss within ${DEVICE_LOSS_WINDOW_MS} ms`]);
    await clock.advance(1000);
    expect(calls.rebuilds).toBe(1);
  });

  it('a loss more than 5 s after the previous one is a new episode and rebuilds again', async () => {
    const { clock, calls, policy } = rig();
    policy.onLost();
    await clock.advance(0);
    await policy.settled();
    await clock.advance(DEVICE_LOSS_WINDOW_MS + 1);
    policy.onLost();
    await clock.advance(0);
    await policy.settled();
    expect(calls.rebuilds).toBe(2);
    expect(calls.resumes).toBe(2);
    expect(policy.rebuilds).toBe(2);
    expect(calls.offers).toEqual([]);
  });

  it('no resume 5 s after the loss offers the reload, and a rebuild that still succeeds resumes the game', async () => {
    const d = deferred();
    const { clock, calls, policy } = rig(() => d.promise);
    policy.onLost();
    await clock.advance(DEVICE_LOSS_WINDOW_MS - 1);
    expect(calls.offers).toEqual([]);
    await clock.advance(1);
    expect(calls.offers).toEqual([`the game did not resume within ${DEVICE_LOSS_WINDOW_MS} ms`]);
    expect(policy.state).toBe('rebuilding');
    d.resolve(true);
    await policy.settled();
    expect(calls.resumes).toBe(1);
    expect(policy.state).toBe('idle');
    expect(calls.offers).toHaveLength(1);
  });

  it('dispose cancels a pending rebuild and every timer; settled() still settles', async () => {
    const { clock, calls, policy } = rig();
    policy.onLost();
    policy.dispose();
    await policy.settled();
    await clock.advance(10_000);
    expect(calls.rebuilds).toBe(0);
    expect(calls.offers).toEqual([]);
    policy.onLost();
    await clock.advance(10_000);
    expect(calls.rebuilds).toBe(0);
  });
});
